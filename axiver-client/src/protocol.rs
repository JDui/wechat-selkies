//! DTO + shared domain types for the typed Local Shell <-> Rust IPC contract.
//!
//! These types mirror the contract defined in `REBUILD-SPEC.md` section 5.
//! Remote (untrusted) web content is never granted access to these commands;
//! the JSON shapes below are the stable wire contract for the local Shell.

use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const SCHEMA_VERSION: u8 = 1;

/// Tauri event names (spec section 5.2).
pub const EVENT_CONNECTION_STATUS: &str = "axiver:connection-status";
pub const EVENT_CONFIG_CHANGED: &str = "axiver:config-changed";
pub const EVENT_OPERATION_RESULT: &str = "axiver:operation-result";

/// One native host window; only the local shell webview has IPC.
pub const MAIN_LABEL: &str = "main";
pub const REMOTE_LABEL: &str = "remote";
pub const SHELL_LABEL: &str = "shell";
pub const TOOL_LABEL: &str = "session-tool";

/// Stable error codes returned in `CommandResult.error.code` and
/// `ConnectionSnapshotV1.errorCode`.
pub mod error_code {
    pub const IPC_FORBIDDEN: &str = "IPC_FORBIDDEN";
    pub const INVALID_BROADCAST_NAME: &str = "INVALID_BROADCAST_NAME";
    pub const INVALID_WIDE_URL: &str = "INVALID_WIDE_URL";
    pub const STORAGE_FAILURE: &str = "STORAGE_FAILURE";
    pub const DB_UNAVAILABLE: &str = "DB_UNAVAILABLE";
    pub const OPERATION_FAILED: &str = "OPERATION_FAILED";
    pub const MDNS_UNAVAILABLE: &str = "MDNS_UNAVAILABLE";
    pub const MDNS_BROWSE_FAILED: &str = "MDNS_BROWSE_FAILED";
    pub const LAN_IDENTITY_MISMATCH: &str = "LAN_IDENTITY_MISMATCH";
    pub const TARGET_UNREACHABLE: &str = "TARGET_UNREACHABLE";
    pub const LAN_NOT_FOUND: &str = "LAN_NOT_FOUND";
    pub const WAN_DNS_FAILED: &str = "WAN_DNS_FAILED";
    pub const WAN_TCP_UNREACHABLE: &str = "WAN_TCP_UNREACHABLE";
    pub const PAGE_LOAD_FAILED: &str = "PAGE_LOAD_FAILED";
    pub const DISCONNECTED: &str = "DISCONNECTED";
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionPhase {
    Idle,
    DiscoveringLan,
    ScanningSubnet,
    ConnectingLan,
    ConnectingWan,
    LoadingPage,
    AwaitingAuth,
    Connected,
    Reconnecting,
    Disconnected,
    Error,
}

impl ConnectionPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::DiscoveringLan => "discovering_lan",
            Self::ScanningSubnet => "scanning_subnet",
            Self::ConnectingLan => "connecting_lan",
            Self::ConnectingWan => "connecting_wan",
            Self::LoadingPage => "loading_page",
            Self::AwaitingAuth => "awaiting_auth",
            Self::Connected => "connected",
            Self::Reconnecting => "reconnecting",
            Self::Disconnected => "disconnected",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    None,
    Lan,
    Wan,
}

/// Persisted client configuration (spec section 5.1).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfigV1 {
    pub schema_version: u8,
    pub broadcast_name: String,
    pub wide_url: String,
}

impl ClientConfigV1 {
    pub fn new(broadcast_name: String, wide_url: String) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            broadcast_name,
            wide_url,
        }
    }
}

impl Default for ClientConfigV1 {
    fn default() -> Self {
        Self::new(
            crate::config::DEFAULT_BROADCAST_NAME.to_string(),
            String::new(),
        )
    }
}

/// Connection snapshot published by the single Connection Manager.
///
/// Field semantics are fixed by the spec (section 5.1):
/// - `pageLoaded` only means a load-finished callback fired for the current
///   navigation. It never implies login or a healthy WebRTC stream.
/// - `sessionVerified` stays `null` unless a reliable, explicitly authorized
///   session/media check exists. It must never be inferred from TCP success.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSnapshotV1 {
    pub schema_version: u8,
    pub revision: u64,
    pub phase: ConnectionPhase,
    pub kind: LinkKind,
    pub target_url: Option<String>,
    pub detail: String,
    pub error_code: Option<String>,
    pub last_checked_at: Option<String>,
    pub transport_reachable: Option<bool>,
    pub page_loaded: Option<bool>,
    pub session_verified: Option<bool>,
}

impl Default for ConnectionSnapshotV1 {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            revision: 0,
            phase: ConnectionPhase::Idle,
            kind: LinkKind::None,
            target_url: None,
            detail: "正在准备".to_string(),
            error_code: None,
            last_checked_at: None,
            transport_reachable: None,
            page_loaded: None,
            session_verified: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct CommandResult<T: Serialize> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CommandError>,
}

impl<T: Serialize> CommandResult<T> {
    pub fn ok(data: T) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(CommandError {
                code: code.to_string(),
                message: message.into(),
                retryable,
            }),
        }
    }

    pub fn forbidden() -> Self {
        Self::err(
            error_code::IPC_FORBIDDEN,
            "命令仅允许本地 Shell 调用",
            false,
        )
    }
}

/// Ack for `client_reconnect` / `client_refresh_remote`.
#[derive(Clone, Debug, Serialize)]
pub struct AcceptAck {
    pub revision: u64,
}

/// Result of `client_get_version`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientVersion {
    pub version: String,
    pub build_profile: String,
    pub target: String,
}

/// Current UTC time as RFC 3339 (second precision). Implemented without extra
/// dependencies using Howard Hinnant's civil-from-days algorithm.
pub fn now_iso8601() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_millis() as i64;
    format_rfc3339_utc(millis)
}

/// Milliseconds since the Unix epoch -> `YYYY-MM-DDTHH:MM:SSZ`.
pub fn format_rfc3339_utc(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let time = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month,
        day,
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

/// Exponential retry backoff for the disconnected retry loop:
/// 5s, 10s, 20s, 40s, then capped at 60s.
pub fn retry_backoff(failed_attempts: u32) -> Duration {
    match failed_attempts {
        0 => Duration::from_secs(5),
        1 => Duration::from_secs(10),
        2 => Duration::from_secs(20),
        3 => Duration::from_secs(40),
        _ => Duration::from_secs(60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_serializes_with_the_specified_camel_case_shape() {
        let snapshot = ConnectionSnapshotV1 {
            schema_version: SCHEMA_VERSION,
            revision: 7,
            phase: ConnectionPhase::ConnectingWan,
            kind: LinkKind::Wan,
            target_url: Some("https://wan.example.test/".to_string()),
            detail: "正在连接广域地址".to_string(),
            error_code: None,
            last_checked_at: Some("2026-10-25T04:00:00Z".to_string()),
            transport_reachable: Some(true),
            page_loaded: Some(false),
            session_verified: None,
        };
        let value = serde_json::to_value(&snapshot).unwrap();
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys.join(","),
            "detail,errorCode,kind,lastCheckedAt,pageLoaded,phase,revision,schemaVersion,sessionVerified,targetUrl,transportReachable"
        );
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["phase"], "connecting_wan");
        assert_eq!(value["kind"], "wan");
        assert_eq!(value["sessionVerified"], serde_json::Value::Null);
    }

    #[test]
    fn phases_cover_the_documented_state_machine() {
        let phases = [
            "idle",
            "discovering_lan",
            "scanning_subnet",
            "connecting_lan",
            "connecting_wan",
            "loading_page",
            "awaiting_auth",
            "connected",
            "reconnecting",
            "disconnected",
            "error",
        ];
        for phase in phases {
            let parsed: ConnectionPhase = serde_json::from_str(&format!("\"{phase}\"")).unwrap();
            assert_eq!(parsed.as_str(), phase);
        }
    }

    #[test]
    fn config_serializes_with_schema_version() {
        let config = ClientConfigV1::new("AXISNSBOX-000".to_string(), String::new());
        assert_eq!(
            serde_json::to_value(&config).unwrap(),
            serde_json::json!({
                "schemaVersion": 1,
                "broadcastName": "AXISNSBOX-000",
                "wideUrl": ""
            })
        );
    }

    #[test]
    fn command_result_shape_omits_absent_fields() {
        let ok: CommandResult<AcceptAck> = CommandResult::ok(AcceptAck { revision: 3 });
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            serde_json::json!({ "ok": true, "data": { "revision": 3 } })
        );
        let err: CommandResult<AcceptAck> =
            CommandResult::err(error_code::STORAGE_FAILURE, "磁盘写入失败", true);
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            serde_json::json!({
                "ok": false,
                "error": { "code": "STORAGE_FAILURE", "message": "磁盘写入失败", "retryable": true }
            })
        );
    }

    #[test]
    fn rfc3339_converts_known_epochs() {
        assert_eq!(format_rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            format_rfc3339_utc(1_790_000_000_000),
            "2026-09-21T14:13:20Z"
        );
        // Leap-day and leap-year boundary sanity.
        assert_eq!(
            format_rfc3339_utc(1_709_200_800_000),
            "2024-02-29T10:00:00Z"
        );
    }

    #[test]
    fn retry_backoff_grows_and_caps() {
        assert_eq!(retry_backoff(0), Duration::from_secs(5));
        assert_eq!(retry_backoff(1), Duration::from_secs(10));
        assert_eq!(retry_backoff(4), Duration::from_secs(60));
        assert_eq!(retry_backoff(50), Duration::from_secs(60));
    }
}
