//! Typed IPC exposed exclusively to the local Shell child webview
//! (spec section 5.2). No pseudo-navigation URLs are involved anymore.
//!
//! Every command:
//! 1. verifies the calling child webview is the trusted local Shell,
//! 2. validates input server-side (never trusting the UI),
//! 3. returns the real error — "saved" is only reported after the SQLite
//!    transaction actually committed.

use crate::app_state::CoreState;
use crate::config::{SettingsRepository, normalize_broadcast_name, normalize_wide_url};
use crate::protocol::{
    AcceptAck, ClientConfigV1, ClientVersion, CommandResult, ConnectionSnapshotV1,
    EVENT_CONFIG_CHANGED, EVENT_OPERATION_RESULT, error_code,
};
use serde::Deserialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State, Webview};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateConfigInput {
    pub broadcast_name: String,
    pub wide_url: String,
}

fn forbidden<T: serde::Serialize>() -> CommandResult<T> {
    CommandResult::err(
        error_code::IPC_FORBIDDEN,
        "命令仅允许本地 Shell 调用",
        false,
    )
}

fn current_config(state: &CoreState) -> ClientConfigV1 {
    state
        .config
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

pub fn save_config(
    app: &AppHandle,
    state: &CoreState,
    repository: &SettingsRepository,
    input: &UpdateConfigInput,
) -> CommandResult<ClientConfigV1> {
    let broadcast_name = match normalize_broadcast_name(&input.broadcast_name) {
        Ok(value) => value,
        Err(message) => {
            return CommandResult::err(error_code::INVALID_BROADCAST_NAME, message, false);
        }
    };
    let wide_url = match normalize_wide_url(&input.wide_url) {
        Ok(value) => value,
        Err(message) => {
            return CommandResult::err(error_code::INVALID_WIDE_URL, message, false);
        }
    };
    let candidate = ClientConfigV1::new(broadcast_name, wide_url);
    let previous = current_config(state);

    if let Err(storage_error) = repository.save(&candidate) {
        let result = CommandResult::err(error_code::STORAGE_FAILURE, storage_error, true);
        let _ = app.emit(EVENT_OPERATION_RESULT, &result);
        return result;
    }
    if let Ok(mut guard) = state.db_error.lock() {
        *guard = None;
    }
    {
        let Ok(mut guard) = state.config.lock() else {
            return CommandResult::err(error_code::STORAGE_FAILURE, "内部状态锁定失败", true);
        };
        *guard = candidate.clone();
    }
    // Only a real change triggers a reconnect (spec 5.2).
    if previous != candidate {
        state.manager.reconnect();
    }
    let result = CommandResult::ok(candidate.clone());
    let _ = app.emit(EVENT_CONFIG_CHANGED, &candidate);
    let _ = app.emit(EVENT_OPERATION_RESULT, &result);
    if let Ok(json) = serde_json::to_string(&candidate) {
        let _ = state.shell.eval(format!(
            "window.__AXIVER_SHELL__&&window.__AXIVER_SHELL__.onConfig({json});"
        ));
    }
    result
}

#[tauri::command]
pub fn client_get_config(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
) -> CommandResult<ClientConfigV1> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    CommandResult::ok(current_config(&state))
}

#[tauri::command]
pub fn client_update_config(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<CoreState>>,
    input: UpdateConfigInput,
) -> CommandResult<ClientConfigV1> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    save_config(&app, &state, &state.repository, &input)
}

#[tauri::command]
pub fn client_get_connection(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
) -> CommandResult<ConnectionSnapshotV1> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    CommandResult::ok(state.manager.snapshot())
}

#[tauri::command]
pub fn client_reconnect(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
) -> CommandResult<AcceptAck> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    // forceRediscover is always true: reconnect runs the full pipeline and
    // must never degrade into a page reload (spec 5.2 / T19).
    state.manager.reconnect();
    CommandResult::ok(AcceptAck {
        revision: state.manager.snapshot().revision,
    })
}

#[tauri::command]
pub fn client_refresh_remote(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
) -> CommandResult<AcceptAck> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    // Reload only — never re-runs discovery and never switches LAN/WAN.
    state.manager.note_manual_refresh();
    CommandResult::ok(AcceptAck {
        revision: state.manager.snapshot().revision,
    })
}

#[tauri::command]
pub fn client_open_settings(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
) -> CommandResult<u64> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    let _ = state.ui.set_expanded(true);
    CommandResult::ok(state.manager.snapshot().revision)
}

#[tauri::command]
pub fn client_hide_settings(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
) -> CommandResult<u64> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    let _ = state.ui.set_expanded(false);
    CommandResult::ok(state.manager.snapshot().revision)
}

#[tauri::command]
pub fn client_set_always_on_top(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
    enabled: bool,
) -> CommandResult<bool> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    match state.shell.window().set_always_on_top(enabled) {
        Ok(()) => CommandResult::ok(enabled),
        Err(error) => CommandResult::err(error_code::OPERATION_FAILED, error.to_string(), true),
    }
}

/// Diagnostics for the Shell: the real settings-database error (if any)
/// instead of silently pretending defaults are persisted.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub db_error: Option<String>,
}

#[tauri::command]
pub fn client_get_diagnostics(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
) -> CommandResult<Diagnostics> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    CommandResult::ok(Diagnostics {
        db_error: state.db_error.lock().ok().and_then(|guard| guard.clone()),
    })
}

/// Open the Shell panel from the status dot; clicking again hides it.
/// Returns the new visibility so the dot can stay consistent.
#[tauri::command]
pub fn client_toggle_settings(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
) -> CommandResult<bool> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    match state.ui.toggle() {
        Ok(layout) => CommandResult::ok(layout.expanded),
        Err(error) => CommandResult::err(error_code::OPERATION_FAILED, error.to_string(), true),
    }
}

#[tauri::command]
pub fn client_get_version(
    webview: Webview,
    _state: State<'_, Arc<CoreState>>,
) -> CommandResult<ClientVersion> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    CommandResult::ok(ClientVersion {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_profile: if cfg!(debug_assertions) {
            "debug".to_string()
        } else {
            "release".to_string()
        },
        target: std::env::consts::ARCH.to_string(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiLayoutInput {
    pub action: String,
    #[serde(default)]
    pub dx: f64,
    #[serde(default)]
    pub dy: f64,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub reduced_motion: Option<bool>,
}

#[tauri::command]
pub fn client_ui_layout(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
    input: UiLayoutInput,
) -> CommandResult<crate::ui_layout::Placement> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    if !input.dx.is_finite()
        || !input.dy.is_finite()
        || input.height.is_some_and(|h| !h.is_finite())
        || input.width.is_some_and(|w| !w.is_finite())
    {
        return CommandResult::err(error_code::OPERATION_FAILED, "Invalid position", false);
    }
    let result = match input.action.as_str() {
        "get" => {
            if let Some(value) = input.reduced_motion {
                state.ui.set_reduced_motion(value);
            }
            state.ui.apply()
        }
        "open" => state.ui.set_expanded(true),
        "close" => state.ui.set_expanded(false),
        "toggle" => state.ui.toggle(),
        "height" => state.ui.set_panel_height(input.height.unwrap_or(390.0)),
        "pill_width" => state.ui.set_pill_width(input.width.unwrap_or(128.0)),
        "drag_start" => {
            state.ui.drag_start();
            state.ui.apply()
        }
        "drag_move" => state.ui.drag_move(input.dx, input.dy),
        "drag_end" => state.ui.drag_end(),
        "reset" => state.ui.reset(),
        "close_tool" => {
            state.ui.close_tool();
            state.ui.apply()
        }
        _ => return CommandResult::err(error_code::OPERATION_FAILED, "Unknown UI action", false),
    };
    match result {
        Ok(layout) => CommandResult::ok(layout),
        Err(error) => CommandResult::err(error_code::OPERATION_FAILED, error.to_string(), true),
    }
}

#[tauri::command]
pub fn client_get_downloads(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
) -> CommandResult<Vec<crate::downloads::DownloadRecord>> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    CommandResult::ok(state.downloads.snapshot())
}
#[tauri::command]
pub async fn client_confirm_download(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
    id: u64,
) -> Result<CommandResult<()>, String> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return Ok(forbidden());
    }
    Ok(match state.downloads.confirm(id).await {
        Ok(()) => CommandResult::ok(()),
        Err(e) => CommandResult::err(error_code::OPERATION_FAILED, e, true),
    })
}
#[tauri::command]
pub fn client_cancel_download(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
    id: u64,
) -> CommandResult<()> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    match state.downloads.cancel(id) {
        Ok(()) => CommandResult::ok(()),
        Err(e) => CommandResult::err(error_code::OPERATION_FAILED, e, true),
    }
}
#[tauri::command]
pub fn client_reveal_download(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
    id: u64,
) -> CommandResult<()> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    match state.downloads.reveal(id) {
        Ok(()) => CommandResult::ok(()),
        Err(e) => CommandResult::err(error_code::OPERATION_FAILED, e, true),
    }
}

#[tauri::command]
pub fn client_get_download_settings(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
) -> CommandResult<crate::downloads::DownloadSettings> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    CommandResult::ok(state.downloads.settings())
}
#[tauri::command]
pub fn client_set_download_mode(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
    mode: crate::downloads::DownloadMode,
) -> CommandResult<crate::downloads::DownloadSettings> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return forbidden();
    }
    match state.downloads.set_mode(mode) {
        Ok(settings) => CommandResult::ok(settings),
        Err(e) => CommandResult::err(error_code::OPERATION_FAILED, e, true),
    }
}
#[tauri::command]
pub async fn client_choose_download_directory(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
) -> Result<CommandResult<crate::downloads::DownloadSettings>, String> {
    if crate::app_state::ensure_trusted_caller(&webview).is_err() {
        return Ok(forbidden());
    }
    Ok(match state.downloads.choose_directory().await {
        Ok(settings) => CommandResult::ok(settings),
        Err(e) => CommandResult::err(error_code::OPERATION_FAILED, e, true),
    })
}
