use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct AuthConfig {
    pub state_path: PathBuf,
    pub password: String,
    pub session_mode: String,
    pub cookie_name: String,
    pub cookie_path: String,
    pub upload_enabled: bool,
    pub upload_max_file_size: u64,
    pub upload_token_ttl_seconds: u64,
    pub upload_chunk_size: usize,
    pub upload_max_concurrency: usize,
    pub upload_allow_overwrite: bool,
    pub upload_root: String,
}

impl AuthConfig {
    pub fn from_env(state_path: PathBuf, upload_root: PathBuf, max_file_size: u64, chunk_size: usize, max_concurrency: usize) -> Self {
        let enabled = |name: &str, default: bool| {
            std::env::var(name).ok()
                .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
                .unwrap_or(default)
        };
        let number = |name: &str, default: u64, minimum: u64, maximum: u64| {
            std::env::var(name).ok()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(default)
                .clamp(minimum, maximum)
        };
        let mut cookie_path = std::env::var("SELKIES_SESSION_COOKIE_PATH")
            .or_else(|_| std::env::var("SUBFOLDER"))
            .unwrap_or_else(|_| "/".into());
        if !cookie_path.starts_with('/') {
            cookie_path.insert(0, '/');
        }
        if !cookie_path.ends_with('/') {
            cookie_path.push('/');
        }
        Self {
            state_path,
            password: std::env::var("PASSWORD").unwrap_or_default(),
            session_mode: std::env::var("SELKIES_SESSION_MODE").unwrap_or_else(|_| "pin-takeover".into()),
            cookie_name: std::env::var("SELKIES_SESSION_COOKIE_NAME").unwrap_or_else(|_| "selkies_session".into()),
            cookie_path,
            upload_enabled: enabled("SELKIES_UPLOAD_ENABLED", true),
            upload_max_file_size: number("SELKIES_UPLOAD_MAX_FILE_SIZE", max_file_size, 1, u64::MAX),
            upload_token_ttl_seconds: number("SELKIES_UPLOAD_TOKEN_TTL_SECONDS", 300, 30, 86_400),
            upload_chunk_size,
            upload_max_concurrency,
            upload_allow_overwrite: enabled("SELKIES_UPLOAD_ALLOW_OVERWRITE", false),
            upload_root: upload_root.to_string_lossy().to_string(),
        }
    }
}

pub struct AuthManager {
    config: AuthConfig,
    lock: Mutex<()>,
}

impl AuthManager {
    pub fn new(config: AuthConfig) -> Self {
        Self { config, lock: Mutex::new(()) }
    }

    pub fn initialize(&self) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let mut state = self.read_state_unlocked();
        let mut changed = false;
        if state.get("upload_signing_key").and_then(Value::as_str).unwrap_or("").is_empty() {
            state["upload_signing_key"] = json!(random_secret());
            changed = true;
        }
        if self.config.password.is_empty() && state.get("session_id").and_then(Value::as_str).unwrap_or("").is_empty() {
            let now_ms = now_millis();
            state["session_id"] = json!("anonymous");
            state["session_epoch"] = json!(now_ms);
            state["issued_at"] = json!(now_ms);
            state["mode"] = json!(self.config.session_mode);
            changed = true;
        }
        if changed || !self.config.state_path.exists() {
            self.write_state_unlocked(&state)?;
        }
        Ok(())
    }

    pub fn password_enabled(&self) -> bool {
        !self.config.password.is_empty()
    }

    pub fn verify_pin(&self, pin: &str) -> bool {
        self.password_enabled() && constant_time_eq(pin.as_bytes(), self.config.password.as_bytes())
    }

    pub fn is_valid_request(&self, cookie_header: Option<&str>, query: Option<&str>, original_uri: Option<&str>) -> bool {
        if !self.password_enabled() {
            return true;
        }
        if let Some(token) = cookie_header.and_then(|header| self.parse_cookie(header)) {
            if self.is_valid_token(&token) {
                return true;
            }
        }
        if let Some(query) = query {
            let (session_id, epoch) = parse_session_identity(query);
            if self.is_valid_session_identity(&session_id, &epoch) {
                return true;
            }
        }
        if let Some(uri) = original_uri {
            if let Some((_, query)) = uri.split_once('?') {
                let (session_id, epoch) = parse_session_identity(query);
                if self.is_valid_session_identity(&session_id, &epoch) {
                    return true;
                }
            }
        }
        false
    }

    pub fn is_valid_cookie(&self, cookie_header: Option<&str>) -> bool {
        if !self.password_enabled() {
            return true;
        }
        cookie_header
            .and_then(|header| self.parse_cookie(header))
            .map(|token| self.is_valid_token(&token))
            .unwrap_or(false)
    }

    pub fn new_session(&self) -> Result<(String, Value), String> {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let now_ms = now_millis();
        let session_id = format!("sid_{}", Uuid::new_v4().simple());
        let token = format!("st_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let state = json!({
            "session_id": session_id,
            "session_epoch": now_ms,
            "token_hash": token_digest(&token),
            "issued_at": now_ms,
            "mode": self.config.session_mode,
            "upload_signing_key": random_secret(),
        });
        self.write_state_unlocked(&state)?;
        Ok((token, state))
    }

    pub fn logout(&self, cookie_header: Option<&str>) -> Result<(), String> {
        let token = cookie_header.and_then(|header| self.parse_cookie(header));
        if let Some(token) = token {
            let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
            let state = self.read_state_unlocked();
            let expected = state.get("token_hash").and_then(Value::as_str).unwrap_or("");
            if !expected.is_empty() && constant_time_eq(token_digest(&token).as_bytes(), expected.as_bytes()) {
                self.write_state_unlocked(&json!({}))?;
            }
        }
        Ok(())
    }

    pub fn cookie_header(&self, token: &str, clear: bool) -> String {
        if clear {
            format!("{}=; Path={}; HttpOnly; SameSite=Lax; Max-Age=0", self.config.cookie_name, self.config.cookie_path)
        } else {
            format!("{}={}; Path={}; HttpOnly; SameSite=Lax", self.config.cookie_name, token, self.config.cookie_path)
        }
    }

    pub fn session_payload(&self) -> Value {
        let state = self.read_state_unlocked();
        json!({
            "ok": true,
            "enabled": self.password_enabled(),
            "session_id": state.get("session_id").cloned().unwrap_or(Value::Null),
            "session_epoch": state.get("session_epoch").cloned().unwrap_or(Value::Null),
            "mode": state.get("mode").cloned().unwrap_or(json!(self.config.session_mode)),
        })
    }

    pub fn upload_token(&self) -> Result<Value, String> {
        if !self.config.upload_enabled {
            return Err("disabled".into());
        }
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let mut state = self.read_state_unlocked();
        if state.get("session_id").and_then(Value::as_str).unwrap_or("").is_empty() {
            if !self.config.password.is_empty() {
                return Err("session-expired".into());
            }
            let now_ms = now_millis();
            state["session_id"] = json!("anonymous");
            state["session_epoch"] = json!(now_ms);
            state["issued_at"] = json!(now_ms);
            state["mode"] = json!(self.config.session_mode);
        }
        if state.get("upload_signing_key").and_then(Value::as_str).unwrap_or("").is_empty() {
            state["upload_signing_key"] = json!(random_secret());
        }
        let signing_key = state.get("upload_signing_key").and_then(Value::as_str).unwrap_or("").to_string();
        let sid = state.get("session_id").and_then(Value::as_str).unwrap_or("").to_string();
        let epoch = state.get("session_epoch").and_then(value_u64).unwrap_or(0);
        if sid.is_empty() || epoch == 0 {
            return Err("session-expired".into());
        }
        let now = unix_seconds();
        let claims = json!({
            "v": 1,
            "sid": sid,
            "epoch": epoch,
            "iat": now,
            "exp": now.saturating_add(self.config.upload_token_ttl_seconds),
            "root": self.config.upload_root,
            "max_file_size": self.config.upload_max_file_size,
            "overwrite": self.config.upload_allow_overwrite,
        });
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|error| error.to_string())?);
        let mut mac = HmacSha256::new_from_slice(signing_key.as_bytes()).map_err(|error| error.to_string())?;
        mac.update(encoded.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        self.write_state_unlocked(&state)?;
        Ok(json!({
            "ok": true,
            "token": format!("{encoded}.{signature}"),
            "expires_at": claims["exp"],
            "session_id": claims["sid"],
            "session_epoch": claims["epoch"],
            "max_file_size": claims["max_file_size"],
            "overwrite": claims["overwrite"],
            "chunk_size": self.config.upload_chunk_size,
            "max_concurrency": self.config.upload_max_concurrency,
        }))
    }

    pub fn current_identity(&self) -> Option<(String, u64)> {
        let state = self.read_state_unlocked();
        let sid = state.get("session_id")?.as_str()?.to_string();
        let epoch = state.get("session_epoch").and_then(value_u64)?;
        (!sid.is_empty() && epoch > 0).then_some((sid, epoch))
    }

    fn is_valid_token(&self, token: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        let state = self.read_state_unlocked();
        let expected = state.get("token_hash").and_then(Value::as_str).unwrap_or("");
        !expected.is_empty() && constant_time_eq(token_digest(token).as_bytes(), expected.as_bytes())
    }

    fn is_valid_session_identity(&self, session_id: &str, epoch: &str) -> bool {
        if session_id.is_empty() || epoch.is_empty() {
            return false;
        }
        let Ok(epoch) = epoch.parse::<u64>() else { return false; };
        let state = self.read_state_unlocked();
        let expected_id = state.get("session_id").and_then(Value::as_str).unwrap_or("");
        let expected_epoch = state.get("session_epoch").and_then(value_u64).unwrap_or(0);
        !expected_id.is_empty()
            && constant_time_eq(session_id.as_bytes(), expected_id.as_bytes())
            && epoch == expected_epoch
    }

    fn parse_cookie(&self, header: &str) -> Option<String> {
        header.split(';').filter_map(|part| part.trim().split_once('='))
            .find_map(|(name, value)| (name.trim() == self.config.cookie_name).then(|| value.trim().to_string()))
    }

    fn read_state_unlocked(&self) -> Value {
        fs::read(&self.config.state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}))
    }

    fn write_state_unlocked(&self, state: &Value) -> Result<(), String> {
        if let Some(parent) = self.config.state_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let temporary = self.config.state_path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(state).map_err(|error| error.to_string())?;
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        fs::rename(&temporary, &self.config.state_path).map_err(|error| error.to_string())
    }
}

fn parse_session_identity(query: &str) -> (String, String) {
    let mut session_id = String::new();
    let mut epoch = String::new();
    for pair in query.trim_start_matches('?').split('&') {
        let Some((raw_key, raw_value)) = pair.split_once('=') else { continue; };
        let key = decode_query_component(raw_key);
        let value = decode_query_component(raw_value);
        match key.as_str() {
            "selkies_session_id" => session_id = value,
            "selkies_session_epoch" => epoch = value,
            _ => {}
        }
    }
    (session_id, epoch)
}

fn decode_query_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let high = (bytes[index + 1] as char).to_digit(16);
                let low = (bytes[index + 2] as char).to_digit(16);
                if let (Some(high), Some(low)) = (high, low) {
                    decoded.push(((high << 4) | low) as u8);
                    index += 3;
                } else {
                    decoded.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn token_digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter().zip(right).fold(0_u8, |difference, (a, b)| difference | (a ^ b)) == 0
}

fn random_secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn unix_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn value_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager(temp: &std::path::Path, password: &str) -> AuthManager {
        AuthManager::new(AuthConfig {
            state_path: temp.join("runtime/active-session.json"),
            password: password.into(),
            session_mode: "pin-takeover".into(),
            cookie_name: "selkies_session".into(),
            cookie_path: "/".into(),
            upload_enabled: true,
            upload_max_file_size: 1024,
            upload_token_ttl_seconds: 300,
            upload_chunk_size: 524288,
            upload_max_concurrency: 3,
            upload_allow_overwrite: false,
            upload_root: "/config/uploads".into(),
        })
    }

    #[test]
    fn initialize_creates_anonymous_session_and_signing_key_when_pin_is_disabled() {
        let temp = tempfile::tempdir().unwrap();
        let manager = manager(temp.path(), "");
        manager.initialize().unwrap();
        let identity = manager.current_identity().unwrap();
        assert_eq!(identity.0, "anonymous");
        assert!(identity.1 > 0);
        let token = manager.upload_token().unwrap();
        assert!(token["token"].as_str().unwrap().contains('.'));
    }

    #[test]
    fn cookie_authentication_and_session_takeover_invalidate_old_token() {
        let temp = tempfile::tempdir().unwrap();
        let manager = manager(temp.path(), "1234");
        manager.initialize().unwrap();
        let (first, first_state) = manager.new_session().unwrap();
        let first_cookie = format!("selkies_session={first}");
        assert!(manager.is_valid_request(Some(&first_cookie), None, None));
        let (second, second_state) = manager.new_session().unwrap();
        assert_ne!(first_state["session_id"], second_state["session_id"]);
        assert!(!manager.is_valid_request(Some(&first_cookie), None, None));
        assert!(manager.is_valid_request(Some(&format!("selkies_session={second}")), None, None));
    }

    #[test]
    fn nginx_original_uri_session_identity_is_supported() {
        let temp = tempfile::tempdir().unwrap();
        let manager = manager(temp.path(), "1234");
        manager.initialize().unwrap();
        let (_, state) = manager.new_session().unwrap();
        let uri = format!("/api/video?selkies_session_id={}&selkies_session_epoch={}", state["session_id"].as_str().unwrap(), state["session_epoch"].as_u64().unwrap());
        assert!(manager.is_valid_request(None, None, Some(&uri)));
    }

    #[test]
    fn upload_token_matches_active_session_and_is_signed() {
        let temp = tempfile::tempdir().unwrap();
        let manager = manager(temp.path(), "");
        manager.initialize().unwrap();
        let token = manager.upload_token().unwrap();
        let token = token["token"].as_str().unwrap();
        assert_eq!(token.split('.').count(), 2);
    }
}
