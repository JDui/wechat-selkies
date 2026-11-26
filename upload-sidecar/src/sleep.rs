use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value, json};
use tracing::{info, warn};

unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

const SIGCONT: i32 = 18;
const SIGSTOP: i32 = 19;
const ADAPTIVE_IDLE_OPTIONS: [u64; 5] = [60, 900, 1800, 2700, 3600];
const PROTECTED_CMD_PATTERNS: [&str; 11] = [
    "session_auth_bridge.py",
    "lan_discovery_service.py",
    "selkies-upload-sidecar",
    "selkies_upload_sidecar",
    "nginx",
    "s6-",
    "/init",
    "s6-svscan",
    "s6-supervise",
    "s6-linux-init",
    "s6-rc",
];
const PROTECTED_COMM_NAMES: [&str; 7] = [
    "init",
    "nginx",
    "s6-svscan",
    "s6-supervise",
    "s6-rc",
    "s6-ipcserverd",
    "selkies-upload-sidecar",
];

#[derive(Clone, Debug)]
pub struct SleepConfig {
    pub enabled: bool,
    pub require_pin: bool,
    pub password_present: bool,
    pub awake_state_path: PathBuf,
    pub frontend_activity_state_path: PathBuf,
    pub mode_state_path: PathBuf,
    pub state_path: PathBuf,
    pub check_seconds: u64,
    pub startup_grace_seconds: u64,
    pub wake_verify_seconds: u64,
    pub warning_seconds: u64,
    pub activity_future_skew_seconds: u64,
    pub adaptive_sleep_idle_seconds: u64,
}

impl SleepConfig {
    pub fn from_env() -> Self {
        let bool_value = |name: &str, default: bool| {
            std::env::var(name)
                .ok()
                .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
                .unwrap_or(default)
        };
        let number = |name: &str, default: u64, minimum: u64, maximum: u64| {
            let parsed = std::env::var(name).ok().and_then(|value| value.parse::<u64>().ok()).unwrap_or(default);
            parsed.clamp(minimum, maximum)
        };
        Self {
            enabled: bool_value("SELKIES_CONTAINER_SLEEP", true),
            require_pin: bool_value("SELKIES_CONTAINER_SLEEP_REQUIRE_PIN", true),
            password_present: std::env::var("PASSWORD").map(|value| !value.is_empty()).unwrap_or(false),
            awake_state_path: PathBuf::from(std::env::var("SELKIES_AWAKE_STATE_PATH").unwrap_or_else(|_| "/tmp/selkies-client-awake.json".into())),
            frontend_activity_state_path: PathBuf::from(std::env::var("SELKIES_FRONTEND_ACTIVITY_STATE_PATH").unwrap_or_else(|_| "/tmp/selkies-frontend-activity.json".into())),
            mode_state_path: PathBuf::from(std::env::var("NOTIFICATION_BRIDGE_MODE_PATH").unwrap_or_else(|_| "/config/state/notification-bridge.json".into())),
            state_path: PathBuf::from(std::env::var("SELKIES_CONTAINER_SLEEP_STATE_PATH").unwrap_or_else(|_| "/run/selkies-container-sleep.json".into())),
            check_seconds: number("SELKIES_CONTAINER_SLEEP_CHECK_SECONDS", 5, 2, 60),
            startup_grace_seconds: number("SELKIES_CONTAINER_SLEEP_STARTUP_GRACE_SECONDS", 180, 15, 3600),
            wake_verify_seconds: number("SELKIES_CONTAINER_SLEEP_WAKE_VERIFY_SECONDS", 8, 1, 60),
            warning_seconds: number("SELKIES_CONTAINER_SLEEP_WARNING_SECONDS", 60, 15, 300),
            activity_future_skew_seconds: number("SELKIES_CONTAINER_SLEEP_ACTIVITY_FUTURE_SKEW_SECONDS", 30, 0, 300),
            adaptive_sleep_idle_seconds: sanitize_idle_seconds(number("SELKIES_ADAPTIVE_SLEEP_IDLE_SECONDS", 3600, 60, 3600)),
        }
    }
}

#[derive(Clone)]
pub struct SleepManager {
    config: SleepConfig,
    started_at: Instant,
    started_at_wall: f64,
    state_lock: Arc<Mutex<()>>,
}

#[derive(Clone, Copy, Debug, Default)]
struct SleepMode {
    settings_updated_at: f64,
    adaptive_enabled: bool,
    idle_seconds: u64,
}

#[derive(Clone, Copy, Debug, Default)]
struct AwakeSnapshot {
    awake_clients: u64,
    recent_clients: u64,
    any_awake: bool,
    state_age_seconds: Option<f64>,
    last_awake_at: f64,
}

impl SleepManager {
    pub fn new(config: SleepConfig) -> Self {
        Self {
            config,
            started_at: Instant::now(),
            started_at_wall: now_seconds(),
            state_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn from_env() -> Self {
        Self::new(SleepConfig::from_env())
    }

    pub fn start_monitor(self: &Arc<Self>) {
        let manager = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(manager.config.check_seconds));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let manager = manager.clone();
                if let Err(error) = tokio::task::spawn_blocking(move || manager.monitor_tick()).await {
                    warn!(%error, "container sleep monitor task failed");
                }
            }
        });
    }

    pub fn feature_enabled(&self) -> bool {
        self.config.enabled && (!self.config.require_pin || self.config.password_present)
    }

    pub fn is_sleeping(&self) -> bool {
        self.read_state().get("sleeping").and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn status_payload(&self) -> Value {
        let now = now_seconds();
        let state = self.read_state();
        let mode = self.read_sleep_mode();
        let last_interaction_at = self.latest_frontend_interaction_at();
        let idle_seconds = mode.idle_seconds;
        let reference_at = last_interaction_at.max(self.started_at_wall).max(mode.settings_updated_at.min(now));
        let idle_for = (now - reference_at).max(0.0);
        let awake = self.awake_clients_snapshot(now);
        let warning_deadline = normalize_timestamp(state.get("warning_deadline_at"), 0.0);
        let pending = state.get("pending_sleep").and_then(Value::as_bool).unwrap_or(false)
            && !state.get("sleeping").and_then(Value::as_bool).unwrap_or(false);
        let warning_remaining = if pending { (warning_deadline - now).max(0.0) } else { 0.0 };
        let sleeping = state.get("sleeping").and_then(Value::as_bool).unwrap_or(false);
        let feature_enabled = self.feature_enabled();
        let block_reason = if !feature_enabled {
            "feature-disabled"
        } else if sleeping {
            "sleeping"
        } else if !mode.adaptive_enabled {
            "adaptive-sleep-disabled"
        } else if self.started_at.elapsed().as_secs() < self.config.startup_grace_seconds {
            "startup-grace"
        } else if idle_for < idle_seconds as f64 {
            "idle-window"
        } else if pending && awake.any_awake {
            "warning-countdown"
        } else {
            "ready"
        };
        let mut payload = state.as_object().cloned().unwrap_or_else(Map::new);
        payload.insert("ok".into(), json!(true));
        payload.insert("feature_enabled".into(), json!(feature_enabled));
        payload.insert("disabled_reason".into(), json!(
            if !self.config.enabled { "environment-disabled" }
            else if self.config.require_pin && !self.config.password_present { "pin-required" }
            else { "" }
        ));
        payload.insert("adaptive_sleep_enabled".into(), json!(mode.adaptive_enabled));
        payload.insert("adaptive_sleep_idle_seconds".into(), json!(idle_seconds));
        payload.insert("idle_seconds".into(), json!(idle_seconds));
        payload.insert("warning_seconds".into(), json!(self.config.warning_seconds));
        payload.insert("last_interaction_at".into(), json!(last_interaction_at));
        payload.insert("idle_reference_at".into(), json!(reference_at));
        payload.insert("idle_reference_reason".into(), json!("server-activity-or-settings"));
        payload.insert("idle_for_seconds".into(), json!(idle_for));
        payload.insert("idle_remaining_seconds".into(), json!((idle_seconds as f64 - idle_for).max(0.0)));
        payload.insert("awake_clients".into(), json!(awake.awake_clients));
        payload.insert("recent_clients".into(), json!(awake.recent_clients));
        payload.insert("any_awake".into(), json!(awake.any_awake));
        payload.insert("awake_state_age_seconds".into(), json!(awake.state_age_seconds));
        payload.insert("last_awake_at".into(), json!(awake.last_awake_at));
        payload.insert("pending_sleep".into(), json!(pending));
        payload.insert("warning_remaining_seconds".into(), json!(warning_remaining));
        payload.insert("sleep_block_reason".into(), json!(block_reason));
        payload.insert("updated_at".into(), json!(now));
        Value::Object(payload)
    }

    pub fn record_activity(&self) -> Value {
        let _guard = self.state_lock.lock().unwrap_or_else(|e| e.into_inner());
        let recorded_at = now_seconds();
        let payload = json!({
            "updated_at": recorded_at,
            "last_interaction_at": recorded_at,
        });
        if let Err(error) = write_json_atomic(&self.config.frontend_activity_state_path, &payload) {
            warn!(%error, "failed to persist frontend activity");
        }
        self.clear_pending_sleep_locked("client interaction");
        let mut status = self.status_payload();
        if let Some(object) = status.as_object_mut() {
            object.insert("recorded_interaction_at".into(), json!(recorded_at));
        }
        status
    }

    pub fn enter_sleep(&self, reason: &str) -> bool {
        let _guard = self.state_lock.lock().unwrap_or_else(|e| e.into_inner());
        self.enter_sleep_locked(reason)
    }

    fn enter_sleep_locked(&self, reason: &str) -> bool {
        if !self.feature_enabled() {
            return false;
        }
        let state = self.read_state();
        if state.get("sleeping").and_then(Value::as_bool).unwrap_or(false) {
            return true;
        }
        let pids = self.list_freezable_pids();
        let mut frozen = Vec::new();
        for pid in pids {
            if send_signal(pid, SIGSTOP) {
                frozen.push(pid);
            }
        }
        let now = now_seconds();
        let payload = json!({
            "enabled": true,
            "sleeping": true,
            "mode": "full",
            "pending_sleep": false,
            "reason": reason,
            "entered_at": now,
            "updated_at": now,
            "frozen_pids": frozen,
            "frozen_count": frozen.len(),
        });
        if let Err(error) = self.write_state(&payload) {
            warn!(%error, "failed to persist sleep state after freezing processes");
            for pid in frozen {
                send_signal(pid, SIGCONT);
            }
            return false;
        }
        info!(reason, frozen = frozen.len(), "entered internal sleep");
        true
    }

    pub fn leave_sleep(&self, reason: &str) -> bool {
        let _guard = self.state_lock.lock().unwrap_or_else(|e| e.into_inner());
        self.leave_sleep_locked(reason)
    }

    fn leave_sleep_locked(&self, reason: &str) -> bool {
        let state = self.read_state();
        let pids = state.get("frozen_pids").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut resumed = 0_u64;
        for value in &pids {
            if let Some(pid) = value.as_u64().and_then(|pid| i32::try_from(pid).ok()) {
                if send_signal(pid, SIGCONT) {
                    resumed += 1;
                }
            }
        }
        let now = now_seconds();
        let payload = json!({
            "enabled": self.feature_enabled(),
            "sleeping": false,
            "pending_sleep": false,
            "reason": reason,
            "left_at": now,
            "updated_at": now,
            "frozen_pids": [],
            "resumed_count": resumed,
        });
        if let Err(error) = self.write_state(&payload) {
            warn!(%error, "failed to persist awake state");
            return false;
        }
        let activity = json!({"updated_at": now, "last_interaction_at": now});
        if let Err(error) = write_json_atomic(&self.config.frontend_activity_state_path, &activity) {
            warn!(%error, "failed to persist wake activity");
        }
        if !pids.is_empty() {
            info!(reason, resumed, total = pids.len(), "left internal sleep");
        }
        true
    }

    pub fn monitor_tick(&self) {
        let _guard = self.state_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mode = self.read_sleep_mode();
        let state = self.read_state();
        if !self.feature_enabled() || !mode.adaptive_enabled {
            if state.get("sleeping").and_then(Value::as_bool).unwrap_or(false)
                && (!self.feature_enabled() || state.get("reason").and_then(Value::as_str) != Some("manual"))
            {
                self.leave_sleep_locked("disabled");
            }
            self.clear_pending_sleep_locked("disabled");
            return;
        }
        if state.get("sleeping").and_then(Value::as_bool).unwrap_or(false) {
            return;
        }
        let now = now_seconds();
        if self.started_at.elapsed().as_secs() < self.config.startup_grace_seconds {
            self.clear_pending_sleep_locked("startup grace");
            return;
        }

        let last_interaction = self.latest_frontend_interaction_at();
        let reference = last_interaction.max(self.started_at_wall).max(mode.settings_updated_at.min(now));
        let awake = self.awake_clients_snapshot(now);
        let pending_started = normalize_timestamp(state.get("warning_started_at"), 0.0);
        let pending = state.get("pending_sleep").and_then(Value::as_bool).unwrap_or(false);
        if pending && last_interaction > pending_started {
            self.clear_pending_sleep_locked("client interaction");
            return;
        }
        let idle_for = now - reference;
        if idle_for < mode.idle_seconds as f64 {
            self.clear_pending_sleep_locked("client interaction");
            return;
        }
        if pending && !awake.any_awake {
            info!(idle_for, "sleep warning skipped because no awake clients remain");
            self.enter_sleep_locked("idle timeout no awake clients");
            return;
        }
        if !pending {
            if !awake.any_awake {
                info!(idle_for, "idle timeout reached with no awake clients");
                self.enter_sleep_locked("idle timeout no awake clients");
                return;
            }
            self.begin_pending_sleep_locked(mode.idle_seconds, last_interaction);
            return;
        }
        let deadline = normalize_timestamp(state.get("warning_deadline_at"), 0.0);
        if deadline > 0.0 && now >= deadline {
            self.enter_sleep_locked("idle interaction timeout");
        }
    }

    fn clear_pending_sleep_locked(&self, reason: &str) {
        let mut state = self.read_state();
        if !state.get("pending_sleep").and_then(Value::as_bool).unwrap_or(false) {
            return;
        }
        if let Some(object) = state.as_object_mut() {
            object.insert("pending_sleep".into(), json!(false));
            object.insert("pending_cleared_reason".into(), json!(reason));
            object.insert("pending_cleared_at".into(), json!(now_seconds()));
            object.insert("warning_started_at".into(), json!(0.0));
            object.insert("warning_deadline_at".into(), json!(0.0));
            object.insert("updated_at".into(), json!(now_seconds()));
        }
        if let Err(error) = self.write_state(&state) {
            warn!(%error, "failed to clear pending sleep");
        }
    }

    fn begin_pending_sleep_locked(&self, idle_seconds: u64, last_interaction_at: f64) {
        let now = now_seconds();
        let mut state = self.read_state();
        if let Some(object) = state.as_object_mut() {
            object.insert("enabled".into(), json!(self.feature_enabled()));
            object.insert("sleeping".into(), json!(false));
            object.insert("pending_sleep".into(), json!(true));
            object.insert("warning_started_at".into(), json!(now));
            object.insert("warning_deadline_at".into(), json!(now + self.config.warning_seconds as f64));
            object.insert("warning_seconds".into(), json!(self.config.warning_seconds));
            object.insert("idle_seconds".into(), json!(idle_seconds));
            object.insert("last_interaction_at".into(), json!(last_interaction_at));
            object.insert("updated_at".into(), json!(now));
        }
        if let Err(error) = self.write_state(&state) {
            warn!(%error, "failed to begin sleep warning");
        } else {
            info!(idle_seconds, warning_seconds = self.config.warning_seconds, "started sleep warning");
        }
    }

    fn read_sleep_mode(&self) -> SleepMode {
        let payload = read_json(&self.config.mode_state_path);
        let mut idle_seconds = sanitize_idle_seconds(
            payload.get("adaptive_sleep_idle_seconds")
                .and_then(value_u64)
                .unwrap_or(self.config.adaptive_sleep_idle_seconds),
        );
        let user_set = payload.get("adaptive_sleep_idle_seconds_user_set").and_then(Value::as_bool).unwrap_or(false);
        if !user_set && idle_seconds == 60 && self.config.adaptive_sleep_idle_seconds == 3600 {
            idle_seconds = 3600;
        }
        SleepMode {
            settings_updated_at: normalize_timestamp(payload.get("sleep_settings_updated_at"), 0.0),
            adaptive_enabled: payload.get("adaptive_sleep_enabled").and_then(Value::as_bool).unwrap_or(false),
            idle_seconds,
        }
    }

    fn latest_frontend_interaction_at(&self) -> f64 {
        let payload = read_json(&self.config.frontend_activity_state_path);
        let now = now_seconds();
        let received_at = normalize_timestamp(payload.get("updated_at"), 0.0);
        let mut latest = 0.0_f64;
        for key in ["last_interaction_at", "interaction_at"] {
            let timestamp = normalize_timestamp(payload.get(key), 0.0);
            if timestamp <= 0.0 {
                continue;
            }
            if timestamp > now + self.config.activity_future_skew_seconds as f64 {
                latest = latest.max(received_at);
                continue;
            }
            latest = latest.max(timestamp.min(now));
        }
        latest
    }

    fn awake_clients_snapshot(&self, now: f64) -> AwakeSnapshot {
        let payload = read_json(&self.config.awake_state_path);
        let clients = payload.get("clients").and_then(Value::as_array);
        let mut snapshot = AwakeSnapshot::default();
        let mut state_updated_at = normalize_timestamp(payload.get("updated_at"), 0.0);
        if state_updated_at > now + self.config.activity_future_skew_seconds as f64 {
            state_updated_at = now;
        }
        snapshot.state_age_seconds = if state_updated_at > 0.0 { Some((now - state_updated_at).max(0.0)) } else { None };
        if let Some(clients) = clients {
            for item in clients {
                let mut updated = normalize_timestamp(item.get("updated_at"), 0.0);
                if updated <= 0.0 {
                    continue;
                }
                if updated > now + self.config.activity_future_skew_seconds as f64 {
                    updated = now;
                }
                let recent = now - updated <= 45.0;
                if recent {
                    snapshot.recent_clients += 1;
                    if item.get("awake").and_then(Value::as_bool).unwrap_or(false) {
                        snapshot.awake_clients += 1;
                        snapshot.any_awake = true;
                        snapshot.last_awake_at = snapshot.last_awake_at.max(updated);
                    }
                }
            }
        }
        snapshot
    }

    fn read_state(&self) -> Value {
        let mut state = read_json(&self.config.state_path);
        if !state.is_object() {
            state = json!({});
        }
        if state.as_object().is_some_and(|object| object.is_empty()) {
            return json!({
                "sleeping": false,
                "enabled": self.feature_enabled(),
                "updated_at": now_seconds(),
                "frozen_pids": [],
                "pending_sleep": false,
            });
        }
        if let Some(object) = state.as_object_mut() {
            object.insert("enabled".into(), json!(self.feature_enabled()));
            object.entry("sleeping".into()).or_insert(json!(false));
            object.entry("frozen_pids".into()).or_insert(json!([]));
            object.entry("updated_at".into()).or_insert(json!(now_seconds()));
            object.entry("pending_sleep".into()).or_insert(json!(false));
        }
        state
    }

    fn write_state(&self, state: &Value) -> std::io::Result<()> {
        write_json_atomic(&self.config.state_path, state)
    }

    fn list_freezable_pids(&self) -> Vec<i32> {
        let protected = current_ancestor_pids();
        let mut pids = Vec::new();
        let Ok(entries) = fs::read_dir("/proc") else { return pids; };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue; };
            let Ok(pid) = name.parse::<i32>() else { continue; };
            if pid <= 1 || protected.contains(&pid) {
                continue;
            }
            let comm = proc_comm(pid);
            let cmdline = proc_cmdline(pid);
            if is_protected_process(pid, &comm, &cmdline) {
                continue;
            }
            let state = proc_state(pid);
            if state.is_empty() || state == "Z" || state == "X" || state == "T" || state == "t" {
                continue;
            }
            if cmdline.is_empty() {
                continue;
            }
            pids.push(pid);
        }
        pids.sort_unstable_by(|a, b| b.cmp(a));
        pids
    }
}

fn sanitize_idle_seconds(value: u64) -> u64 {
    if ADAPTIVE_IDLE_OPTIONS.contains(&value) { value } else { 3600 }
}

fn value_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

fn now_seconds() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64()
}

fn normalize_timestamp(value: Option<&Value>, default: f64) -> f64 {
    let mut timestamp = match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(default),
        Some(Value::String(text)) => text.parse::<f64>().unwrap_or(default),
        _ => default,
    };
    if timestamp > 10_000_000_000.0 {
        timestamp /= 1000.0;
    }
    if !timestamp.is_finite() || timestamp < 0.0 { default } else { timestamp }
}

fn read_json(path: &Path) -> Value {
    fs::read(path).ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn write_json_atomic(path: &Path, payload: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|extension| extension.to_str()).unwrap_or("json")
    ));
    let bytes = serde_json::to_vec(payload).map_err(std::io::Error::other)?;
    fs::write(&temporary, bytes)?;
    fs::rename(temporary, path)
}

fn proc_cmdline(pid: i32) -> String {
    fs::read(format!("/proc/{pid}/cmdline"))
        .map(|bytes| String::from_utf8_lossy(&bytes).replace('\0', " ").trim().to_string())
        .unwrap_or_default()
}

fn proc_comm(pid: i32) -> String {
    fs::read_to_string(format!("/proc/{pid}/comm"))
        .map(|text| text.trim().to_string())
        .unwrap_or_default()
}

fn proc_state(pid: i32) -> String {
    let Ok(text) = fs::read_to_string(format!("/proc/{pid}/stat")) else { return String::new(); };
    let Some(right) = text.rfind(')') else { return String::new(); };
    text[right + 2..].split_whitespace().next().unwrap_or("").to_string()
}

fn current_ancestor_pids() -> HashSet<i32> {
    let mut pids = HashSet::new();
    let mut pid = std::process::id() as i32;
    while pid > 0 && pids.insert(pid) {
        let Ok(text) = fs::read_to_string(format!("/proc/{pid}/stat")) else { break; };
        let Some(right) = text.rfind(')') else { break; };
        let fields = text[right + 2..].split_whitespace().collect::<Vec<_>>();
        pid = fields.get(1).and_then(|value| value.parse::<i32>().ok()).unwrap_or(0);
    }
    pids.insert(1);
    pids
}

fn is_protected_process(pid: i32, comm: &str, cmdline: &str) -> bool {
    if pid <= 1 || PROTECTED_COMM_NAMES.contains(&comm) {
        return true;
    }
    let haystack = format!("{comm} {cmdline}");
    PROTECTED_CMD_PATTERNS.iter().any(|pattern| haystack.contains(pattern))
}

fn send_signal(pid: i32, signal: i32) -> bool {
    let result = unsafe { kill(pid, signal) };
    result == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adaptive_idle_values_are_restricted_to_supported_options() {
        for value in ADAPTIVE_IDLE_OPTIONS {
            assert_eq!(sanitize_idle_seconds(value), value);
        }
        assert_eq!(sanitize_idle_seconds(61), 3600);
    }

    #[test]
    fn browser_timestamp_milliseconds_and_future_skew_are_normalized() {
        assert_eq!(normalize_timestamp(Some(&json!(1_700_000_000_000_u64)), 0.0), 1_700_000_000.0);
        assert_eq!(normalize_timestamp(Some(&json!(-1)), 7.0), 7.0);
    }

    #[test]
    fn process_protection_includes_control_plane_and_self_hosted_sidecar() {
        assert!(is_protected_process(123, "python3", "python3 /scripts/session_auth_bridge.py"));
        assert!(is_protected_process(124, "selkies-upload-sidecar", "selkies-upload-sidecar"));
        assert!(!is_protected_process(125, "wechat", "/opt/wechat/wechat"));
    }
}
