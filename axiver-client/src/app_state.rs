//! Shared application state managed by Tauri and consulted by every
//! privileged command.

use crate::config::SettingsRepository;
use crate::connection::ConnectionManager;
use crate::protocol::ClientConfigV1;
use std::sync::{Arc, Mutex};
use tauri::Webview;

pub struct CoreState {
    pub manager: Arc<ConnectionManager>,
    pub config: Arc<Mutex<ClientConfigV1>>,
    pub repository: Arc<SettingsRepository>,
    /// `Some(...)` when the settings database is unavailable; surfaced in
    /// the Shell instead of pretending defaults are persisted.
    pub db_error: Arc<Mutex<Option<String>>>,
    pub remote: Webview,
    pub shell: Webview,
    pub ui: Arc<crate::ui_layout::UiController>,
    pub downloads: Arc<crate::downloads::DownloadManager>,
}

/// Both label and bundled asset origin are checked: window identity alone
/// cannot distinguish trusted and remote child webviews in a shared host.
pub fn ensure_trusted_caller(webview: &Webview) -> Result<(), String> {
    let local = webview.url().ok().is_some_and(|url| {
        url.scheme() == "tauri" || matches!(url.host_str(), Some("tauri.localhost"))
    });
    if webview.label() == crate::protocol::SHELL_LABEL && local {
        Ok(())
    } else {
        Err(format!(
            "{}: command requires the local shell webview",
            crate::protocol::error_code::IPC_FORBIDDEN
        ))
    }
}
