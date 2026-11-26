use std::{
    collections::HashMap,
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::FromRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use fs2::available_space;
use serde::Serialize;
use tokio::sync::Semaphore;
use tracing::{info, warn};
use uuid::Uuid;

const O_RDONLY: i32 = 0;
const O_NONBLOCK: i32 = 0x800;
const O_DIRECTORY: i32 = 0x10000;
const O_NOFOLLOW: i32 = 0x20000;
const CACHE_MARKER: &str = ".selkies-drop-cache-v1";

unsafe extern "C" {
    fn open(path: *const std::ffi::c_char, flags: i32, ...) -> i32;
    fn openat(dirfd: i32, path: *const std::ffi::c_char, flags: i32, ...) -> i32;
    fn close(fd: i32) -> i32;
}

#[derive(Clone, Debug)]
pub struct DownloadConfig {
    pub cache_root: PathBuf,
    pub download_root: PathBuf,
    pub state_path: PathBuf,
    pub source_roots: Vec<PathBuf>,
    pub use_default_roots: bool,
    pub max_file_bytes: u64,
    pub max_cache_bytes: u64,
    pub min_free_bytes: u64,
    pub max_jobs: usize,
    pub max_concurrency: usize,
    pub ready_ttl_seconds: u64,
    pub prepare_timeout_seconds: u64,
}

impl DownloadConfig {
    pub fn from_env(state_path: PathBuf) -> Self {
        let number = |name: &str, default: u64| {
            std::env::var(name).ok().and_then(|value| value.parse::<u64>().ok()).unwrap_or(default)
        };
        let configured = std::env::var("SELKIES_DROP_SOURCE_ROOTS").ok();
        let use_default_roots = configured.is_none();
        let source_roots = configured
            .unwrap_or_default()
            .split(':')
            .filter(|item| !item.is_empty())
            .map(PathBuf::from)
            .collect();
        Self {
            cache_root: PathBuf::from(std::env::var("SELKIES_DROP_CACHE").unwrap_or_else(|_| "/run/selkies-drop-cache".into())),
            download_root: PathBuf::from(std::env::var("SELKIES_DOWNLOAD_ROOT").unwrap_or_else(|_| "/config".into())),
            state_path,
            source_roots,
            use_default_roots,
            max_file_bytes: number("SELKIES_DROP_MAX_FILE_BYTES", 2 * 1024 * 1024 * 1024),
            max_cache_bytes: number("SELKIES_DROP_MAX_CACHE_BYTES", 4 * 1024 * 1024 * 1024),
            min_free_bytes: number("SELKIES_DROP_MIN_FREE_BYTES", 256 * 1024 * 1024),
            max_jobs: number("SELKIES_DROP_MAX_JOBS", 4).clamp(1, 16) as usize,
            max_concurrency: number("SELKIES_DROP_MAX_CONCURRENCY", 2).clamp(1, 8) as usize,
            ready_ttl_seconds: number("SELKIES_DROP_TTL_SECONDS", 300).clamp(15, 3600),
            prepare_timeout_seconds: number("SELKIES_DROP_PREPARE_TIMEOUT_SECONDS", 3600).clamp(60, 24 * 3600),
        }
    }
}

#[derive(Clone, Debug)]
struct DownloadJob {
    id: String,
    token: String,
    session_id: String,
    session_epoch: u64,
    client: String,
    expires_at: u64,
    state: String,
    size: u64,
    active: bool,
    name: String,
    error: String,
    used: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct DownloadJobStatus {
    pub id: String,
    pub state: String,
    pub name: String,
    pub size: u64,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DownloadStatus {
    pub ok: bool,
    pub jobs: Vec<DownloadJobStatus>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DownloadFileInfo {
    pub id: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug)]
struct SessionIdentity {
    session_id: String,
    session_epoch: u64,
}

pub struct DownloadManager {
    config: DownloadConfig,
    jobs: Mutex<HashMap<String, DownloadJob>>,
    permits: Arc<Semaphore>,
}

impl DownloadManager {
    pub fn new(config: DownloadConfig) -> Result<Self, String> {
        if config.max_file_bytes == 0 || config.max_cache_bytes == 0 || config.max_jobs == 0 {
            return Err("invalid download limits".into());
        }
        if config.cache_root.is_symlink() {
            return Err("download cache must not be a symlink".into());
        }
        fs::create_dir_all(&config.cache_root).map_err(|error| format!("create download cache: {error}"))?;
        let cache_root = fs::canonicalize(&config.cache_root).map_err(|error| format!("canonicalize download cache: {error}"))?;
        let download_root = fs::canonicalize(&config.download_root).map_err(|error| format!("canonicalize download root: {error}"))?;
        if cache_root.starts_with(&download_root) || cache_root == Path::new("/var/tmp") || cache_root.components().count() < 3 {
            return Err("download cache must be a dedicated directory outside download root".into());
        }
        let marker = cache_root.join(CACHE_MARKER);
        for entry in fs::read_dir(&cache_root).map_err(|error| format!("read download cache: {error}"))? {
            let entry = entry.map_err(|error| format!("read download cache entry: {error}"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            let metadata = fs::symlink_metadata(entry.path()).map_err(|error| format!("stat download cache entry: {error}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() ||
                (name != CACHE_MARKER && !is_cache_data_name(&name)) {
                return Err("download cache contains foreign entries".into());
            }
        }
        if marker.exists() {
            if marker.is_symlink() || fs::read_to_string(&marker).ok().as_deref() != Some("selkies native download cache v1\n") {
                return Err("download cache ownership marker mismatch".into());
            }
        } else {
            fs::write(&marker, "selkies native download cache v1\n").map_err(|error| format!("write download cache marker: {error}"))?;
        }
        fs::set_permissions(&cache_root, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure download cache: {error}"))?;
        for entry in fs::read_dir(&cache_root).map_err(|error| format!("read download cache: {error}"))? {
            let entry = entry.map_err(|error| format!("read download cache entry: {error}"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            if is_cache_data_name(&name) {
                let _ = fs::remove_file(entry.path());
            }
        }
        let mut config = config;
        config.cache_root = cache_root;
        config.download_root = download_root;
        Ok(Self {
            permits: Arc::new(Semaphore::new(config.max_concurrency)),
            config,
            jobs: Mutex::new(HashMap::new()),
        })
    }

    pub fn start_cleanup(self: &Arc<Self>) {
        let manager = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let manager = manager.clone();
                let _ = tokio::task::spawn_blocking(move || manager.cleanup()).await;
            }
        });
    }

    pub async fn create_job(
        self: &Arc<Self>,
        source: String,
        session_id: String,
        session_epoch: u64,
        client: String,
    ) -> Result<DownloadJobStatus, String> {
        if !(16..=80).contains(&client.len()) || !client.chars().all(|ch| ch.is_ascii_alphanumeric()) {
            return Err("invalid-client".into());
        }
        if source.is_empty() || source.len() > 4096 || source.contains('\0') {
            return Err("source-missing".into());
        }
        self.validate_session(&session_id, session_epoch)?;
        let id = format!("axi-drop-{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple().to_string()[..16].to_string());
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let now = unix_seconds();
        let job = DownloadJob {
            id: id.clone(),
            token,
            session_id,
            session_epoch,
            client,
            expires_at: now.saturating_add(self.config.prepare_timeout_seconds),
            state: "preparing".into(),
            size: 0,
            active: false,
            name: String::new(),
            error: String::new(),
            used: false,
        };
        {
            let mut jobs = self.jobs.lock().unwrap_or_else(|error| error.into_inner());
            if jobs.values().any(|job| job.state == "preparing") {
                return Err("already-preparing".into());
            }
            if jobs.len() >= self.config.max_jobs {
                return Err("queue-full".into());
            }
            jobs.insert(id.clone(), job);
        }
        let manager = self.clone();
        let task_id = id.clone();
        tokio::spawn(async move {
            let permit = match manager.permits.clone().acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => {
                    manager.fail_job(&task_id, "io-error", "下载服务暂不可用");
                    return;
                }
            };
            let copy_manager = manager.clone();
            let copy_id = task_id.clone();
            let result = tokio::task::spawn_blocking(move || copy_manager.copy_job(&copy_id, &source)).await;
            drop(permit);
            if let Err(error) = result {
                manager.fail_job(&task_id, "io-error", &format!("下载任务失败: {error}"));
            }
        });
        self.get_job_status(&id, true).ok_or_else(|| "job creation failed".into())
    }

    fn get_job_status(&self, id: &str, include_token: bool) -> Option<DownloadJobStatus> {
        let jobs = self.jobs.lock().unwrap_or_else(|error| error.into_inner());
        let job = jobs.get(id)?;
        Some(DownloadJobStatus {
            id: job.id.clone(),
            state: job.state.clone(),
            name: job.name.clone(),
            size: job.size,
            error: job.error.clone(),
            token: if include_token && job.state == "ready" && !job.used {
                Some(job.token.clone())
            } else {
                None
            },
        })
    }

    pub fn status(&self, session_id: &str, session_epoch: u64, client: &str) -> DownloadStatus {
        let jobs = self.jobs.lock().unwrap_or_else(|error| error.into_inner());
        let mut selected = jobs.values()
            .filter(|job| job.session_id == session_id && job.session_epoch == session_epoch && job.client == client)
            .map(|job| DownloadJobStatus {
                id: job.id.clone(),
                state: job.state.clone(),
                name: job.name.clone(),
                size: job.size,
                error: job.error.clone(),
                token: if job.state == "ready" && !job.used { Some(job.token.clone()) } else { None },
            })
            .collect::<Vec<_>>();
        selected.sort_by_key(|job| job.id.clone());
        DownloadStatus { ok: true, jobs: selected }
    }

    pub fn verify_file(
        &self,
        id: &str,
        token: &str,
        session_id: &str,
        session_epoch: u64,
    ) -> Result<DownloadFileInfo, String> {
        self.validate_session(session_id, session_epoch)?;
        let mut jobs = self.jobs.lock().unwrap_or_else(|error| error.into_inner());
        let job = jobs.get_mut(id).ok_or_else(|| "session-or-job-expired".to_string())?;
        if job.session_id != session_id || job.session_epoch != session_epoch || job.used ||
            job.state != "ready" || job.expires_at < unix_seconds() ||
            !constant_time_eq(job.token.as_bytes(), token.as_bytes()) {
            return Err("session-or-job-expired".into());
        }
        job.active = true;
        Ok(DownloadFileInfo { id: job.id.clone(), name: job.name.clone(), size: job.size })
    }

    pub fn finish_file(&self, id: &str, token: &str, session_id: &str, session_epoch: u64, success: bool) {
        if self.validate_session(session_id, session_epoch).is_err() {
            return;
        }
        let mut jobs = self.jobs.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(job) = jobs.get_mut(id) {
            if job.session_id != session_id || job.session_epoch != session_epoch ||
                !constant_time_eq(job.token.as_bytes(), token.as_bytes()) {
                return;
            }
            job.active = false;
            job.state = if success { "sent" } else { "ready" }.into();
            job.used = success;
            job.expires_at = job.expires_at.min(unix_seconds().saturating_add(if success { 15 } else { 60 }));
        }
    }

    pub fn cache_file(&self, id: &str) -> Result<PathBuf, String> {
        if !is_job_id(id) {
            return Err("session-or-job-expired".into());
        }
        Ok(self.config.cache_root.join(format!("{id}.data")))
    }

    pub fn cleanup(&self) {
        let identity = self.read_identity().ok();
        let mut jobs = self.jobs.lock().unwrap_or_else(|error| error.into_inner());
        let now = unix_seconds();
        let expired = jobs.iter()
            .filter(|(_, job)| !job.active && job.state != "preparing" && (
                job.expires_at < now ||
                identity.as_ref().map(|value| value.session_id != job.session_id || value.session_epoch != job.session_epoch).unwrap_or(true)
            ))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            jobs.remove(&id);
            for suffix in ["part", "data"] {
                let _ = fs::remove_file(self.config.cache_root.join(format!("{id}.{suffix}")));
            }
        }
    }

    fn copy_job(&self, id: &str, source: &str) {
        let part = self.config.cache_root.join(format!("{id}.part"));
        let data = self.config.cache_root.join(format!("{id}.data"));
        let result = self.copy_source(id, source, &part, &data);
        match result {
            Ok((name, size)) => {
                let mut jobs = self.jobs.lock().unwrap_or_else(|error| error.into_inner());
                if let Some(job) = jobs.get_mut(id) {
                    job.state = "ready".into();
                    job.name = name;
                    job.size = size;
                    job.expires_at = unix_seconds().saturating_add(self.config.ready_ttl_seconds);
                }
                info!(job_id = id, bytes = size, "native download prepared");
            }
            Err(error) => {
                let _ = fs::remove_file(&part);
                let _ = fs::remove_file(&data);
                let (code, message) = download_error_details(&error);
                self.fail_job(id, code, message);
            }
        }
    }

    fn copy_source(&self, id: &str, source: &str, part: &Path, data: &Path) -> Result<(String, u64), String> {
        let (mut input, before, name) = self.open_source(source)?;
        let size = before.len();
        if size > self.config.max_file_bytes {
            return Err("size-limit".into());
        }
        let total = {
            let jobs = self.jobs.lock().unwrap_or_else(|error| error.into_inner());
            jobs.values().map(|job| job.size).sum::<u64>()
        };
        if total.saturating_add(size) > self.config.max_cache_bytes {
            return Err("size-limit".into());
        }
        let free = available_space(&self.config.cache_root).map_err(|_| "insufficient-space".to_string())?;
        if free < size.saturating_add(self.config.min_free_bytes) {
            return Err("insufficient-space".into());
        }
        let mut output = OpenOptions::new().write(true).create_new(true).open(part)
            .map_err(|error| if error.kind() == std::io::ErrorKind::PermissionDenied { "permission-denied".into() } else { "io-error".into() })?;
        let mut copied = 0_u64;
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            let job = {
                let jobs = self.jobs.lock().unwrap_or_else(|error| error.into_inner());
                jobs.get(id).cloned()
            }.ok_or_else(|| "session-or-job-expired".to_string())?;
            if job.expires_at < unix_seconds() {
                return Err("session-or-job-expired".into());
            }
            self.validate_session(&job.session_id, job.session_epoch)?;
            let count = input.read(&mut buffer).map_err(|_| "io-error".to_string())?;
            if count == 0 {
                break;
            }
            copied = copied.saturating_add(count as u64);
            if copied > size {
                return Err("source-changed".into());
            }
            output.write_all(&buffer[..count]).map_err(|_| "io-error".to_string())?;
        }
        output.flush().map_err(|_| "io-error".to_string())?;
        output.sync_all().map_err(|_| "io-error".to_string())?;
        let after = input.metadata().map_err(|_| "source-missing".to_string())?;
        if copied != size || before.len() != after.len() || before.mtime() != after.mtime() || before.mtime_nsec() != after.mtime_nsec() {
            return Err("source-changed".into());
        }
        fs::rename(part, data).map_err(|_| "io-error".to_string())?;
        Ok((name, size))
    }

    fn open_source(&self, source: &str) -> Result<(File, fs::Metadata, String), String> {
        let original = PathBuf::from(source);
        let resolved = original.canonicalize().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound { "source-missing".to_string() }
            else if error.kind() == std::io::ErrorKind::PermissionDenied { "permission-denied".to_string() }
            else { "io-error".to_string() }
        })?;
        let allowed = self.allowed_roots();
        let root = allowed.iter().find(|root| resolved.starts_with(root))
            .ok_or_else(|| "source-outside-allowed-roots".to_string())?;
        let relative = resolved.strip_prefix(root).map_err(|_| "source-outside-allowed-roots".to_string())?;
        let components = relative.components().collect::<Vec<_>>();
        if components.is_empty() {
            return Err("regular-file-required".into());
        }
        let root_c = CString::new(root.as_os_str().as_encoded_bytes()).map_err(|_| "source-missing".to_string())?;
        let mut fd = unsafe { open(root_c.as_ptr(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW) };
        if fd < 0 {
            return Err("permission-denied".into());
        }
        for (index, component) in components.iter().enumerate() {
            let Component::Normal(name) = component else {
                unsafe { close(fd); }
                return Err("source-outside-allowed-roots".into());
            };
            let name = CString::new(name.as_encoded_bytes()).map_err(|_| "source-missing".to_string())?;
            let flags = if index + 1 == components.len() {
                O_RDONLY | O_NONBLOCK | O_NOFOLLOW
            } else {
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW
            };
            let next = unsafe { openat(fd, name.as_ptr(), flags) };
            unsafe { close(fd); }
            if next < 0 {
                return Err("source-missing".into());
            }
            fd = next;
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata().map_err(|_| "source-missing".to_string())?;
        if !metadata.is_file() {
            return Err("regular-file-required".into());
        }
        let name = resolved.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_else(|| "download".into());
        Ok((file, metadata, name))
    }

    fn allowed_roots(&self) -> Vec<PathBuf> {
        let roots = if self.config.use_default_roots {
            default_source_roots()
        } else {
            self.config.source_roots.clone()
        };
        roots.into_iter().filter_map(|root| fs::canonicalize(root).ok()).collect()
    }

    fn validate_session(&self, session_id: &str, session_epoch: u64) -> Result<(), String> {
        let identity = self.read_identity()?;
        if identity.session_id != session_id || identity.session_epoch != session_epoch {
            return Err("session-expired".into());
        }
        Ok(())
    }

    fn read_identity(&self) -> Result<SessionIdentity, String> {
        let payload: serde_json::Value = serde_json::from_slice(&fs::read(&self.config.state_path).map_err(|_| "session-expired".to_string())?)
            .map_err(|_| "session-expired".to_string())?;
        let session_id = payload.get("session_id").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
        let session_epoch = payload.get("session_epoch").and_then(serde_json::Value::as_u64).or_else(|| {
            payload.get("session_epoch").and_then(serde_json::Value::as_str).and_then(|value| value.parse().ok())
        }).unwrap_or(0);
        if session_id.is_empty() || session_epoch == 0 {
            return Err("session-expired".into());
        }
        Ok(SessionIdentity { session_id, session_epoch })
    }

    fn fail_job(&self, id: &str, code: &str, message: &str) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(job) = jobs.get_mut(id) {
            job.state = "error".into();
            job.error = message.into();
            job.expires_at = unix_seconds().saturating_add(20);
        }
        warn!(job_id = id, error_code = code, "native download preparation failed");
    }

}

fn default_source_roots() -> Vec<PathBuf> {
    let home = PathBuf::from("/config");
    let mut roots = ["Desktop", "Downloads", "Documents", "uploads", "xwechat_files"]
        .iter()
        .map(|name| home.join(name))
        .collect::<Vec<_>>();
    let qq = home.join(".config/QQ");
    if let Ok(entries) = fs::read_dir(&qq) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.starts_with("nt_qq_") || name == "nt_qq") {
                continue;
            }
            let profile = entry.path();
            let direct_nt_data = profile.join("nt_data");
            add_qq_attachment_roots(&direct_nt_data, &mut roots);
            if name == "nt_qq" {
                if let Ok(accounts) = fs::read_dir(&profile) {
                    for account in accounts.flatten() {
                        add_qq_attachment_roots(&account.path().join("nt_data"), &mut roots);
                    }
                }
            }
        }
    }
    roots
}

fn add_qq_attachment_roots(nt_data: &Path, roots: &mut Vec<PathBuf>) {
    const LEAVES: [&str; 7] = ["File", "Pic", "Video", "Ptt", "Emoji", "file_recv", "FileRecv"];
    if !nt_data.is_dir() {
        return;
    }
    for leaf in LEAVES {
        roots.push(nt_data.join(leaf));
    }
    if let Ok(accounts) = fs::read_dir(nt_data) {
        for account in accounts.flatten() {
            let account_path = account.path();
            if !account_path.is_dir() {
                continue;
            }
            for leaf in LEAVES {
                roots.push(account_path.join(leaf));
            }
        }
    }
}

fn is_cache_data_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".part").or_else(|| name.strip_suffix(".data")) else {
        return false;
    };
    let Some(id) = stem.strip_prefix("axi-drop-") else {
        return false;
    };
    id.len() == 48 && id.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn is_job_id(id: &str) -> bool {
    id.strip_prefix("axi-drop-").is_some_and(|value| value.len() == 48 && value.chars().all(|ch| ch.is_ascii_hexdigit()))
}

fn unix_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter().zip(right).fold(0_u8, |difference, (a, b)| difference | (a ^ b)) == 0
}

fn download_error_details(code: &str) -> (&'static str, &'static str) {
    match code {
        "source-outside-allowed-roots" => ("source-outside-allowed-roots", "此文件暂不支持直接下载，请先另存到下载目录"),
        "source-missing" => ("source-missing", "源文件不存在，请先在聊天应用中下载完整附件后重试"),
        "permission-denied" => ("permission-denied", "容器没有读取该文件的权限"),
        "size-limit" => ("size-limit", "文件大小或临时缓存总量超出限制"),
        "insufficient-space" => ("insufficient-space", "临时缓存空间不足"),
        "source-changed" => ("source-changed", "源文件仍在写入或已变化，请下载完成后重试"),
        "session-expired" | "session-or-job-expired" => ("session-expired", "会话已失效，请重新登录后重试"),
        "regular-file-required" => ("regular-file-required", "仅支持普通文件，不支持目录或设备"),
        "already-preparing" => ("already-preparing", "已有文件正在准备，请稍后重试"),
        "queue-full" => ("queue-full", "下载任务已满，请稍后重试"),
        _ => ("io-error", "文件读取失败，请检查附件是否已下载完成"),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_config(root: &Path) -> DownloadConfig {
        let download_root = root.join("downloads");
        let cache_root = root.join("cache");
        let source_root = root.join("source");
        fs::create_dir_all(&download_root).unwrap();
        fs::create_dir_all(&source_root).unwrap();
        DownloadConfig {
            cache_root,
            download_root,
            state_path: root.join("session.json"),
            source_roots: vec![source_root],
            use_default_roots: false,
            max_file_bytes: 1024 * 1024,
            max_cache_bytes: 2 * 1024 * 1024,
            min_free_bytes: 0,
            max_jobs: 4,
            max_concurrency: 2,
            ready_ttl_seconds: 60,
            prepare_timeout_seconds: 60,
        }
    }

    #[tokio::test]
    async fn native_download_copies_under_session_and_consumes_one_time_token() {
        let temp = tempfile::tempdir().unwrap();
        let config = test_config(temp.path());
        fs::write(&config.state_path, serde_json::to_vec(&json!({
            "session_id": "sid_test",
            "session_epoch": 42
        })).unwrap()).unwrap();
        let source = config.source_roots[0].join("sample.bin");
        fs::write(&source, b"rust-transfer-payload").unwrap();

        let manager = Arc::new(DownloadManager::new(config).unwrap());
        let job = manager.create_job(
            source.to_string_lossy().to_string(),
            "sid_test".into(),
            42,
            "a".repeat(32),
        ).await.unwrap();
        assert_eq!(job.state, "preparing");

        let mut ready = None;
        for _ in 0..100 {
            let status = manager.status("sid_test", 42, &"a".repeat(32));
            ready = status.jobs.into_iter().find(|item| item.id == job.id && item.state == "ready");
            if ready.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let ready = ready.expect("download should become ready");
        let token = ready.token.expect("ready job exposes a one-time token");
        let info = manager.verify_file(&job.id, &token, "sid_test", 42).unwrap();
        assert_eq!(info.name, "sample.bin");
        assert_eq!(fs::read(manager.cache_file(&job.id).unwrap()).unwrap(), b"rust-transfer-payload");

        manager.finish_file(&job.id, &token, "sid_test", 42, true);
        let status = manager.status("sid_test", 42, &"a".repeat(32));
        assert_eq!(status.jobs[0].state, "sent");
        assert!(status.jobs[0].token.is_none());
        assert!(manager.verify_file(&job.id, &token, "sid_test", 42).is_err());
    }

    #[test]
    fn source_symlinks_cannot_escape_allowed_roots() {
        let temp = tempfile::tempdir().unwrap();
        let config = test_config(temp.path());
        let outside = temp.path().join("outside.bin");
        fs::write(&outside, b"outside").unwrap();
        let link = config.source_roots[0].join("escape.bin");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let manager = DownloadManager::new(config).unwrap();
        let error = manager.open_source(link.to_str().unwrap()).unwrap_err();
        assert_eq!(error, "source-outside-allowed-roots");
    }

    #[test]
    fn cache_job_names_are_fixed_length_hex_and_never_paths() {
        let id = format!("axi-drop-{}", "a".repeat(48));
        assert!(is_job_id(&id));
        assert!(!is_job_id("../axi-drop-".to_string().as_str()));
        assert!(!is_cache_data_name("axi-drop-xyz.data"));
        assert!(is_cache_data_name(&format!("{id}.part")));
    }
}
