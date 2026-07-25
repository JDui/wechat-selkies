use std::{
    collections::{BTreeSet, HashMap},
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::to_bytes,
    extract::{Path as AxumPath, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use fs2::available_space;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::{
    fs::{self, OpenOptions},
    io::{AsyncSeekExt, AsyncWriteExt, SeekFrom},
    sync::{Mutex, RwLock, Semaphore},
};
use tracing::{error, info, warn};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug)]
pub struct Config {
    pub listen: String,
    pub upload_root: PathBuf,
    pub state_path: PathBuf,
    pub chunk_size: usize,
    pub max_concurrency: usize,
    pub max_file_size: u64,
    pub min_free_bytes: u64,
    pub resume_enabled: bool,
    pub checksum_enabled: bool,
    pub allowed_subdirs: Vec<PathBuf>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let parse = |name: &str, default: &str| -> Result<u64, String> {
            std::env::var(name)
                .unwrap_or_else(|_| default.to_string())
                .parse::<u64>()
                .map_err(|_| format!("{name} must be an unsigned integer"))
        };
        let enabled = |name: &str, default: bool| {
            std::env::var(name)
                .ok()
                .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
                .unwrap_or(default)
        };
        let chunk_size = parse("SELKIES_UPLOAD_CHUNK_SIZE", "8388608")? as usize;
        if !(64 * 1024..=64 * 1024 * 1024).contains(&chunk_size) {
            return Err("SELKIES_UPLOAD_CHUNK_SIZE must be between 64 KiB and 64 MiB".into());
        }
        let max_concurrency = parse("SELKIES_UPLOAD_MAX_CONCURRENCY", "3")? as usize;
        if !(1..=32).contains(&max_concurrency) {
            return Err("SELKIES_UPLOAD_MAX_CONCURRENCY must be between 1 and 32".into());
        }
        let allowed_subdirs = std::env::var("SELKIES_UPLOAD_ALLOWED_SUBDIRS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|item| {
                let trimmed = item.trim();
                (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
            })
            .collect();
        Ok(Self {
            listen: std::env::var("SELKIES_UPLOAD_LISTEN")
                .unwrap_or_else(|_| "127.0.0.1:38084".into()),
            upload_root: PathBuf::from(
                std::env::var("SELKIES_UPLOAD_DIR")
                    .or_else(|_| std::env::var("FILE_MANAGER_PATH"))
                    .unwrap_or_else(|_| "/config/uploads".into()),
            ),
            state_path: PathBuf::from(
                std::env::var("SELKIES_SESSION_STATE_PATH")
                    .unwrap_or_else(|_| "/run/selkies-active-session.json".into()),
            ),
            chunk_size,
            max_concurrency,
            max_file_size: parse("SELKIES_UPLOAD_MAX_FILE_SIZE", "2147483648")?,
            min_free_bytes: parse("SELKIES_UPLOAD_MIN_FREE_BYTES", "268435456")?,
            resume_enabled: enabled("SELKIES_UPLOAD_RESUME_ENABLED", true),
            checksum_enabled: enabled("SELKIES_UPLOAD_CHECKSUM_ENABLED", true),
            allowed_subdirs,
        })
    }
}

#[derive(Clone)]
pub struct AppState {
    config: Arc<Config>,
    root: Arc<PathBuf>,
    sessions: Arc<RwLock<HashMap<Uuid, Arc<Mutex<SessionRecord>>>>>,
    permits: Arc<Semaphore>,
    started_at: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionRecord {
    id: Uuid,
    file_name: String,
    size: u64,
    chunk_size: usize,
    uploaded_chunks: BTreeSet<u64>,
    uploaded_bytes: u64,
    checksum: Option<ChecksumRequest>,
    allow_overwrite: bool,
    session_id: String,
    session_epoch: u64,
    created_at: u64,
    completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChecksumAlgorithm {
    Blake3,
    Sha256,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChecksumRequest {
    pub algorithm: ChecksumAlgorithm,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub file_name: String,
    pub size: u64,
    pub checksum: Option<ChecksumRequest>,
}

#[derive(Debug, Serialize)]
struct SessionResponse {
    id: Uuid,
    file_name: String,
    size: u64,
    chunk_size: usize,
    uploaded_bytes: u64,
    uploaded_chunks: Vec<u64>,
    completed: bool,
}

impl From<&SessionRecord> for SessionResponse {
    fn from(value: &SessionRecord) -> Self {
        Self {
            id: value.id,
            file_name: value.file_name.clone(),
            size: value.size,
            chunk_size: value.chunk_size,
            uploaded_bytes: value.uploaded_bytes,
            uploaded_chunks: value.uploaded_chunks.iter().copied().collect(),
            completed: value.completed,
        }
    }
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: &'static str,
    message: String,
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into() }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        warn!(error_code = self.code, reason = %self.message, "upload request failed");
        (
            self.status,
            Json(ErrorBody { error: self.code, message: self.message }),
        )
            .into_response()
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct TokenClaims {
    v: u8,
    sid: String,
    epoch: u64,
    iat: u64,
    exp: u64,
    root: String,
    max_file_size: u64,
    overwrite: bool,
}

#[derive(Debug, Deserialize)]
struct AuthState {
    session_id: String,
    session_epoch: u64,
    upload_signing_key: String,
}

pub async fn build_state(config: Config) -> Result<AppState, String> {
    fs::create_dir_all(&config.upload_root)
        .await
        .map_err(|error| format!("create upload root: {error}"))?;
    let canonical_root = fs::canonicalize(&config.upload_root)
        .await
        .map_err(|error| format!("canonicalize upload root: {error}"))?;
    fs::create_dir_all(canonical_root.join(".staging"))
        .await
        .map_err(|error| format!("create staging directory: {error}"))?;
    reject_symlink(&canonical_root.join(".staging")).await?;
    Ok(AppState {
        permits: Arc::new(Semaphore::new(config.max_concurrency)),
        config: Arc::new(config),
        root: Arc::new(canonical_root),
        sessions: Arc::new(RwLock::new(HashMap::new())),
        started_at: Instant::now(),
    })
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/upload-api/v1/sessions", post(create_session))
        .route(
            "/upload-api/v1/sessions/{id}",
            get(get_session).delete(delete_session),
        )
        .route(
            "/upload-api/v1/sessions/{id}/chunks/{index}",
            put(put_chunk),
        )
        .route(
            "/upload-api/v1/sessions/{id}/complete",
            post(complete_session),
        )
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "uptime_seconds": state.started_at.elapsed().as_secs(),
        "chunk_size": state.config.chunk_size,
        "max_concurrency": state.config.max_concurrency,
    }))
}

async fn create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateSessionRequest>,
) -> Result<(StatusCode, Json<SessionResponse>), ApiError> {
    let claims = authenticate(&state, &headers).await?;
    let relative = validate_relative_path(&request.file_name, &state.config.allowed_subdirs)?;
    if request.size == 0 || request.size > state.config.max_file_size || request.size > claims.max_file_size {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            "file size exceeds the configured or token limit",
        ));
    }
    if request.checksum.is_some() && !state.config.checksum_enabled {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "checksum_disabled",
            "checksum verification is disabled",
        ));
    }
    ensure_target_safe(&state, &relative, false).await?;
    let free = available_space(state.root.as_path()).map_err(internal_error)?;
    if free < request.size.saturating_add(state.config.min_free_bytes) {
        return Err(ApiError::new(
            StatusCode::INSUFFICIENT_STORAGE,
            "insufficient_storage",
            format!("not enough free space for {} bytes", request.size),
        ));
    }
    let record = SessionRecord {
        id: Uuid::new_v4(),
        file_name: relative.to_string_lossy().replace('\\', "/"),
        size: request.size,
        chunk_size: state.config.chunk_size,
        uploaded_chunks: BTreeSet::new(),
        uploaded_bytes: 0,
        checksum: request.checksum,
        allow_overwrite: claims.overwrite,
        session_id: claims.sid,
        session_epoch: claims.epoch,
        created_at: now_seconds(),
        completed: false,
    };
    persist_record(&state, &record).await?;
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(part_path(&state, record.id))
        .await
        .map_err(internal_error)?;
    let response = SessionResponse::from(&record);
    state
        .sessions
        .write()
        .await
        .insert(record.id, Arc::new(Mutex::new(record.clone())));
    info!(
        task_id = %record.id,
        file_name = %record.file_name,
        file_size = record.size,
        "upload session created"
    );
    Ok((StatusCode::CREATED, Json(response)))
}

async fn get_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<SessionResponse>, ApiError> {
    let claims = authenticate(&state, &headers).await?;
    let session = load_session(&state, id).await?;
    let record = session.lock().await;
    authorize_record(&record, &claims)?;
    Ok(Json(SessionResponse::from(&*record)))
}

async fn put_chunk(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((id, index)): AxumPath<(Uuid, u64)>,
    request: Request,
) -> Result<Json<SessionResponse>, ApiError> {
    let claims = authenticate(&state, &headers).await?;
    let permit = state
        .permits
        .clone()
        .acquire_owned()
        .await
        .map_err(internal_error)?;
    let body = to_bytes(request.into_body(), state.config.chunk_size)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "chunk_too_large",
                "chunk exceeds configured chunk size",
            )
        })?;
    let session = load_session(&state, id).await?;
    let mut record = session.lock().await;
    authorize_record(&record, &claims)?;
    if record.completed {
        return Err(ApiError::new(StatusCode::CONFLICT, "already_completed", "session is complete"));
    }
    let offset = index
        .checked_mul(record.chunk_size as u64)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "invalid_chunk", "chunk offset overflow"))?;
    if offset >= record.size {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_chunk", "chunk index is out of range"));
    }
    let expected = usize::try_from((record.size - offset).min(record.chunk_size as u64))
        .map_err(internal_error)?;
    if body.len() != expected {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_chunk_size",
            format!("expected {expected} bytes, received {}", body.len()),
        ));
    }
    if record.uploaded_chunks.contains(&index) {
        drop(permit);
        return Ok(Json(SessionResponse::from(&*record)));
    }
    let started = Instant::now();
    let mut file = OpenOptions::new()
        .write(true)
        .open(part_path(&state, id))
        .await
        .map_err(internal_error)?;
    file.seek(SeekFrom::Start(offset)).await.map_err(internal_error)?;
    file.write_all(&body).await.map_err(internal_error)?;
    file.flush().await.map_err(internal_error)?;
    let write_ms = started.elapsed().as_secs_f64() * 1000.0;
    record.uploaded_chunks.insert(index);
    record.uploaded_bytes = record.uploaded_bytes.saturating_add(body.len() as u64);
    persist_record(&state, &record).await?;
    if write_ms >= 50.0 {
        warn!(
            task_id = %record.id,
            file_name = %record.file_name,
            chunk_index = index,
            chunk_bytes = body.len(),
            write_ms,
            "slow upload chunk write"
        );
    }
    drop(permit);
    Ok(Json(SessionResponse::from(&*record)))
}

async fn complete_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<SessionResponse>, ApiError> {
    let claims = authenticate(&state, &headers).await?;
    let session = load_session(&state, id).await?;
    let mut record = session.lock().await;
    authorize_record(&record, &claims)?;
    if record.completed {
        return Ok(Json(SessionResponse::from(&*record)));
    }
    let expected_chunks = record.size.div_ceil(record.chunk_size as u64);
    if record.uploaded_chunks.len() as u64 != expected_chunks || record.uploaded_bytes != record.size {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "upload_incomplete",
            format!("received {} of {} bytes", record.uploaded_bytes, record.size),
        ));
    }
    let source = part_path(&state, id);
    let metadata = fs::metadata(&source).await.map_err(internal_error)?;
    if metadata.len() != record.size {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "size_mismatch",
            format!("expected {} bytes, staged file has {}", record.size, metadata.len()),
        ));
    }
    if let Some(checksum) = &record.checksum {
        verify_checksum(source.clone(), checksum.clone()).await?;
    }
    let relative = validate_relative_path(&record.file_name, &state.config.allowed_subdirs)?;
    let destination = ensure_target_safe(&state, &relative, true).await?;
    if fs::try_exists(&destination).await.map_err(internal_error)? && !record.allow_overwrite {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "target_exists",
            "target already exists and overwrite is not allowed",
        ));
    }
    let mut staged = OpenOptions::new()
        .write(true)
        .open(&source)
        .await
        .map_err(internal_error)?;
    staged.flush().await.map_err(internal_error)?;
    staged.sync_all().await.map_err(internal_error)?;
    drop(staged);
    atomic_move(source.clone(), destination.clone(), record.allow_overwrite).await?;
    record.completed = true;
    persist_record(&state, &record).await?;
    let elapsed = now_seconds().saturating_sub(record.created_at).max(1);
    info!(
        task_id = %record.id,
        file_name = %record.file_name,
        elapsed_ms = elapsed * 1000,
        average_bytes_per_second = record.size / elapsed,
        "upload completed"
    );
    Ok(Json(SessionResponse::from(&*record)))
}

async fn delete_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<StatusCode, ApiError> {
    let claims = authenticate(&state, &headers).await?;
    let session = load_session(&state, id).await?;
    let record = session.lock().await;
    authorize_record(&record, &claims)?;
    let file_name = record.file_name.clone();
    drop(record);
    if let Err(error) = fs::remove_file(part_path(&state, id)).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        return Err(internal_error(error));
    }
    if let Err(error) = fs::remove_file(metadata_path(&state, id)).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        return Err(internal_error(error));
    }
    state.sessions.write().await.remove(&id);
    info!(task_id = %id, file_name = %file_name, "upload cancelled");
    Ok(StatusCode::NO_CONTENT)
}

async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<TokenClaims, ApiError> {
    let value = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "missing_token", "missing bearer token"))?;
    let (encoded, signature) = value
        .split_once('.')
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "invalid_token", "invalid token format"))?;
    let raw_state = fs::read(&state.config.state_path).await.map_err(|_| {
        ApiError::new(StatusCode::UNAUTHORIZED, "invalid_session", "session state is unavailable")
    })?;
    let auth: AuthState = serde_json::from_slice(&raw_state).map_err(|_| {
        ApiError::new(StatusCode::UNAUTHORIZED, "invalid_session", "session state is invalid")
    })?;
    let mut mac = HmacSha256::new_from_slice(auth.upload_signing_key.as_bytes())
        .map_err(|_| ApiError::new(StatusCode::UNAUTHORIZED, "invalid_token", "invalid signing key"))?;
    mac.update(encoded.as_bytes());
    let supplied = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| ApiError::new(StatusCode::UNAUTHORIZED, "invalid_token", "invalid signature encoding"))?;
    mac.verify_slice(&supplied)
        .map_err(|_| ApiError::new(StatusCode::UNAUTHORIZED, "invalid_token", "token signature mismatch"))?;
    let claims: TokenClaims = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| ApiError::new(StatusCode::UNAUTHORIZED, "invalid_token", "invalid claims encoding"))?,
    )
    .map_err(|_| ApiError::new(StatusCode::UNAUTHORIZED, "invalid_token", "invalid token claims"))?;
    if claims.v != 1
        || claims.exp < now_seconds()
        || claims.sid != auth.session_id
        || claims.epoch != auth.session_epoch
        || Path::new(&claims.root) != state.config.upload_root
    {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "stale_token",
            "token is expired or belongs to a stale session",
        ));
    }
    Ok(claims)
}

fn authorize_record(record: &SessionRecord, claims: &TokenClaims) -> Result<(), ApiError> {
    if record.session_id != claims.sid || record.session_epoch != claims.epoch {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "stale_session",
            "upload belongs to another session epoch",
        ));
    }
    Ok(())
}

async fn load_session(state: &AppState, id: Uuid) -> Result<Arc<Mutex<SessionRecord>>, ApiError> {
    if let Some(session) = state.sessions.read().await.get(&id).cloned() {
        return Ok(session);
    }
    if !state.config.resume_enabled {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found", "upload session not found"));
    }
    let data = fs::read(metadata_path(state, id))
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "not_found", "upload session not found"))?;
    let record: SessionRecord = serde_json::from_slice(&data).map_err(internal_error)?;
    if record.id != id {
        return Err(ApiError::new(StatusCode::CONFLICT, "invalid_metadata", "session metadata id mismatch"));
    }
    let session = Arc::new(Mutex::new(record));
    state.sessions.write().await.insert(id, session.clone());
    Ok(session)
}

async fn persist_record(state: &AppState, record: &SessionRecord) -> Result<(), ApiError> {
    let path = metadata_path(state, record.id);
    let temporary = path.with_extension("json.tmp");
    let data = serde_json::to_vec(record).map_err(internal_error)?;
    fs::write(&temporary, data).await.map_err(internal_error)?;
    fs::rename(&temporary, &path).await.map_err(internal_error)
}

fn part_path(state: &AppState, id: Uuid) -> PathBuf {
    state.root.join(".staging").join(format!("{id}.part"))
}

fn metadata_path(state: &AppState, id: Uuid) -> PathBuf {
    state.root.join(".staging").join(format!("{id}.json"))
}

fn validate_relative_path(value: &str, allowed_subdirs: &[PathBuf]) -> Result<PathBuf, ApiError> {
    let path = Path::new(value);
    if value.trim().is_empty()
        || value.contains('\0')
        || value.contains('\\')
        || value.contains(':')
        || path.is_absolute()
        || value.starts_with('\\')
        || value.starts_with('/')
    {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_path", "path must be relative"));
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            _ => {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_path",
                    "path traversal and prefixes are not allowed",
                ));
            }
        }
    }
    if clean.as_os_str().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_path", "file name is empty"));
    }
    if !allowed_subdirs.is_empty()
        && !allowed_subdirs.iter().any(|prefix| clean.starts_with(prefix))
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "directory_not_allowed",
            "target directory is outside the allowed upload directories",
        ));
    }
    Ok(clean)
}

async fn ensure_target_safe(
    state: &AppState,
    relative: &Path,
    create_parent: bool,
) -> Result<PathBuf, ApiError> {
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let mut current = state.root.as_path().to_path_buf();
    for component in parent.components() {
        let Component::Normal(part) = component else {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_path", "invalid path component"));
        };
        current.push(part);
        match fs::symlink_metadata(&current).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ApiError::new(StatusCode::FORBIDDEN, "symlink_rejected", "symlinks are not allowed"));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(ApiError::new(StatusCode::CONFLICT, "invalid_directory", "path parent is not a directory"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_parent => {
                fs::create_dir(&current).await.map_err(internal_error)?;
                reject_symlink(&current).await.map_err(|message| {
                    ApiError::new(StatusCode::FORBIDDEN, "symlink_rejected", message)
                })?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(internal_error(error)),
        }
    }
    let destination = state.root.join(relative);
    if let Ok(metadata) = fs::symlink_metadata(&destination).await
        && metadata.file_type().is_symlink()
    {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "symlink_rejected", "target symlink is not allowed"));
    }
    if create_parent {
        let canonical_parent = fs::canonicalize(destination.parent().unwrap_or(state.root.as_path()))
            .await
            .map_err(internal_error)?;
        if !canonical_parent.starts_with(state.root.as_path()) {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "path_escape",
                "target parent escaped the upload root",
            ));
        }
    }
    Ok(destination)
}

async fn reject_symlink(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .await
        .map_err(|error| format!("inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("{} must not be a symlink", path.display()));
    }
    Ok(())
}

async fn atomic_move(source: PathBuf, destination: PathBuf, overwrite: bool) -> Result<(), ApiError> {
    let result = tokio::task::spawn_blocking(move || atomic_move_blocking(&source, &destination, overwrite))
        .await
        .map_err(internal_error)?;
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(ApiError::new(
            StatusCode::CONFLICT,
            "target_exists",
            "target already exists and overwrite is not allowed",
        )),
        Err(error) => Err(internal_error(error)),
    }
}

#[cfg(target_os = "linux")]
fn atomic_move_blocking(source: &Path, destination: &Path, overwrite: bool) -> std::io::Result<()> {
    if overwrite {
        return std::fs::rename(source, destination);
    }
    use std::{ffi::CString, os::unix::ffi::OsStrExt, os::raw::c_char};
    unsafe extern "C" {
        fn renameat2(
            old_dir_fd: i32,
            old_path: *const c_char,
            new_dir_fd: i32,
            new_path: *const c_char,
            flags: u32,
        ) -> i32;
    }
    const AT_FDCWD: i32 = -100;
    const RENAME_NOREPLACE: u32 = 1;
    let old_path = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "source path contains NUL"))?;
    let new_path = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "target path contains NUL"))?;
    let result = unsafe {
        renameat2(
            AT_FDCWD,
            old_path.as_ptr(),
            AT_FDCWD,
            new_path.as_ptr(),
            RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(22 | 38 | 95)) {
            atomic_link_move(source, destination)
        } else {
            Err(error)
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn atomic_move_blocking(source: &Path, destination: &Path, overwrite: bool) -> std::io::Result<()> {
    if overwrite {
        return std::fs::rename(source, destination);
    }
    atomic_link_move(source, destination)
}

fn atomic_link_move(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::hard_link(source, destination)?;
    std::fs::remove_file(source)
}

async fn verify_checksum(path: PathBuf, checksum: ChecksumRequest) -> Result<(), ApiError> {
    let actual = tokio::task::spawn_blocking(move || -> Result<String, std::io::Error> {
        use std::io::Read;
        let mut file = std::fs::File::open(path)?;
        let mut buffer = vec![0_u8; 1024 * 1024];
        match checksum.algorithm {
            ChecksumAlgorithm::Blake3 => {
                let mut hasher = blake3::Hasher::new();
                loop {
                    let count = file.read(&mut buffer)?;
                    if count == 0 { break; }
                    hasher.update(&buffer[..count]);
                }
                Ok(hasher.finalize().to_hex().to_string())
            }
            ChecksumAlgorithm::Sha256 => {
                let mut hasher = Sha256::new();
                loop {
                    let count = file.read(&mut buffer)?;
                    if count == 0 { break; }
                    hasher.update(&buffer[..count]);
                }
                Ok(format!("{:x}", hasher.finalize()))
            }
        }
    })
    .await
    .map_err(internal_error)?
    .map_err(internal_error)?;
    if !actual.eq_ignore_ascii_case(checksum.value.trim()) {
        return Err(ApiError::new(StatusCode::CONFLICT, "checksum_mismatch", "checksum verification failed"));
    }
    Ok(())
}

fn internal_error(error: impl std::fmt::Display) -> ApiError {
    error!(error = %error, "upload sidecar internal error");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", error.to_string())
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use http::Request;
    use tower::ServiceExt;

    #[test]
    fn rejects_unsafe_paths() {
        for value in ["", "../escape", "/absolute", r"C:\absolute", r"..\escape"] {
            assert!(validate_relative_path(value, &[]).is_err(), "{value} was accepted");
        }
        assert_eq!(
            validate_relative_path("folder/video.mp4", &[]).unwrap(),
            PathBuf::from("folder/video.mp4")
        );
    }

    #[test]
    fn enforces_allowed_subdirectories() {
        let allowed = vec![PathBuf::from("incoming")];
        assert!(validate_relative_path("incoming/a.bin", &allowed).is_ok());
        assert!(validate_relative_path("other/a.bin", &allowed).is_err());
    }

    #[tokio::test]
    async fn creates_bounded_state() {
        let temp = tempfile::tempdir().unwrap();
        let config = Config {
            listen: "127.0.0.1:0".into(),
            upload_root: temp.path().join("uploads"),
            state_path: temp.path().join("state.json"),
            chunk_size: 1024 * 1024,
            max_concurrency: 2,
            max_file_size: 1024 * 1024 * 1024,
            min_free_bytes: 0,
            resume_enabled: true,
            checksum_enabled: true,
            allowed_subdirs: vec![],
        };
        let state = build_state(config).await.unwrap();
        assert_eq!(state.permits.available_permits(), 2);
        assert!(state.root.join(".staging").is_dir());
    }

    #[tokio::test]
    async fn atomic_move_never_overwrites_without_permission() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.part");
        let destination = temp.path().join("existing.bin");
        fs::write(&source, b"new").await.unwrap();
        fs::write(&destination, b"original").await.unwrap();
        let error = atomic_move(source.clone(), destination.clone(), false)
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(fs::read(&destination).await.unwrap(), b"original");
        assert_eq!(fs::read(&source).await.unwrap(), b"new");
    }

    fn test_token(root: &Path, session_id: &str, epoch: u64, key: &str) -> String {
        let claims = TokenClaims {
            v: 1,
            sid: session_id.into(),
            epoch,
            iat: now_seconds(),
            exp: now_seconds() + 300,
            root: root.to_string_lossy().into_owned(),
            max_file_size: 1024,
            overwrite: false,
        };
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let mut mac = HmacSha256::new_from_slice(key.as_bytes()).unwrap();
        mac.update(encoded.as_bytes());
        format!("{encoded}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
    }

    #[tokio::test]
    async fn uploads_chunks_and_atomically_completes() {
        let temp = tempfile::tempdir().unwrap();
        let upload_root = temp.path().join("uploads");
        let state_path = temp.path().join("state.json");
        let session_id = "sid_test";
        let epoch = 42;
        let key = "unit-test-signing-key";
        fs::write(
            &state_path,
            serde_json::to_vec(&serde_json::json!({
                "session_id": session_id,
                "session_epoch": epoch,
                "upload_signing_key": key
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        let state = build_state(Config {
            listen: "127.0.0.1:0".into(),
            upload_root: upload_root.clone(),
            state_path,
            chunk_size: 4,
            max_concurrency: 2,
            max_file_size: 1024,
            min_free_bytes: 0,
            resume_enabled: true,
            checksum_enabled: true,
            allowed_subdirs: vec![],
        })
        .await
        .unwrap();
        let app = router(state);
        let token = test_token(&upload_root, session_id, epoch, key);
        let create = app
            .clone()
            .oneshot(
                Request::post("/upload-api/v1/sessions")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"file_name":"nested/hello.txt","size":5}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create.status(), StatusCode::CREATED);
        let created: serde_json::Value =
            serde_json::from_slice(&to_bytes(create.into_body(), 4096).await.unwrap()).unwrap();
        let id = created["id"].as_str().unwrap();

        for (index, body) in [(0, "hell"), (1, "o")] {
            let response = app
                .clone()
                .oneshot(
                    Request::put(format!("/upload-api/v1/sessions/{id}/chunks/{index}"))
                        .header("authorization", format!("Bearer {token}"))
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
        let complete = app
            .oneshot(
                Request::post(format!("/upload-api/v1/sessions/{id}/complete"))
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(complete.status(), StatusCode::OK);
        assert_eq!(
            fs::read(upload_root.join("nested/hello.txt")).await.unwrap(),
            b"hello"
        );
    }
}
