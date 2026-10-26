//! Remote content, integrated session tool and trusted controls in one native host.
//!
//! Trust boundary (spec section 7): the remote window is *untrusted* web
//! content. It receives no IPC capabilities (see `capabilities/default.json`)
//! and the navigation policy below limits it to the current session origin
//! (plus same-host scheme/port switches needed by PIN redirects). Cross-site
//! navigations and non-uploader popups are routed to the system browser.

use crate::app_state::CoreState;
use crate::platform_windows::open_in_default_browser;
use crate::protocol::{REMOTE_LABEL, SHELL_LABEL, TOOL_LABEL};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{
    App, Manager, Webview, WebviewUrl, Window,
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
};
use url::Url;

pub const APP_TITLE: &str = "AXIVER Client";
pub const UPLOADER_PATH_SUFFIX: &str = "/uploader/";

pub fn http_origin(url: &Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

pub fn is_internal_uploader_url(url: &Url, current_origin: Option<&str>) -> bool {
    current_origin.is_some_and(|origin| http_origin(url).as_deref() == Some(origin))
        && format!("{}/", url.path().trim_end_matches('/')).ends_with(UPLOADER_PATH_SUFFIX)
}

/// Navigation policy for the remote window (spec section 7 "导航策略").
///
/// Allowed:
/// - local asset pages (`tauri:` scheme or `*.tauri.localhost` hosts);
/// - `about:` (blank popups);
/// - the current session origin;
/// - the same host with a different scheme/port (legacy http→https and PIN
///   redirect flows).
/// Anything else is denied; HTTP(S) denials are handed to the default
/// browser by the caller.
pub fn navigation_allowed(url: &Url, session_origin: Option<&str>) -> bool {
    match url.scheme() {
        "about" => true,
        "tauri" => true,
        "http" | "https" => {
            if url
                .host_str()
                .is_some_and(|host| host == "tauri.localhost" || host.ends_with(".tauri.localhost"))
            {
                return true;
            }
            let Some(expected) = session_origin else {
                return false;
            };
            let Some(origin) = http_origin(url) else {
                return false;
            };
            if origin == expected {
                return true;
            }
            let expected_url = Url::parse(expected).ok();
            let same_host = expected_url
                .as_ref()
                .and_then(|expected| expected.host_str())
                .is_some_and(|host| Some(host) == url.host_str());
            same_host
        }
        _ => false,
    }
}

#[allow(clippy::too_many_arguments)]
pub fn build_remote(
    app: &App,
    host: &Window,
    data_directory: PathBuf,
    ime_guard_script: String,
    session_origin: Arc<Mutex<Option<String>>>,
) -> tauri::Result<Webview> {
    let navigation_origin = session_origin.clone();
    let popup_app = app.handle().clone();
    let popup_origin = session_origin.clone();

    let builder = WebviewBuilder::new(REMOTE_LABEL, WebviewUrl::App("waiting.html".into()))
        .data_directory(data_directory)
        .initialization_script(ime_guard_script)
        .enable_clipboard_access()
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(true)
        .on_document_title_changed(|window, document_title| {
            let title = if document_title.trim().is_empty() {
                APP_TITLE
            } else {
                document_title.trim()
            };
            let _ = window.window().set_title(title);
        })
        .on_navigation(move |url| {
            let current = session_origin_snapshot(&navigation_origin);
            if navigation_allowed(url, current.as_deref()) {
                return true;
            }
            // Cross-site navigation from the untrusted remote page goes to
            // the system default browser instead of hijacking the session.
            if matches!(url.scheme(), "http" | "https") {
                open_in_default_browser(url);
            }
            false
        })
        .on_new_window(move |url, _features| {
            let current = session_origin_snapshot(&popup_origin);
            if is_internal_uploader_url(&url, current.as_deref()) {
                // Let NewWindowRequested return before navigating another WebView.
                let app = popup_app.clone();
                std::thread::spawn(move || {
                    if let Some(ui) = app.try_state::<Arc<crate::ui_layout::UiController>>() {
                        let _ = ui.open_tool(url);
                    }
                });
                return NewWindowResponse::Deny;
            }

            open_in_default_browser(&url);
            NewWindowResponse::Deny
        })
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            if !matches!(payload.url().scheme(), "http" | "https") {
                return;
            }
            if let Some(state) = window.app_handle().try_state::<Arc<CoreState>>() {
                state.manager.on_page_finished(payload.url());
            }
        });
    let remote = host.add_child(
        builder,
        tauri::LogicalPosition::new(0, 0),
        host.inner_size()?,
    )?;
    crate::platform_windows::configure_session_download_permission(&remote, session_origin)?;
    Ok(remote)
}

pub fn build_shell(host: &Window, data_directory: PathBuf) -> tauri::Result<Webview> {
    host.add_child(
        WebviewBuilder::new(SHELL_LABEL, WebviewUrl::App("shell.html".into()))
            .data_directory(data_directory)
            .enable_clipboard_access()
            .disable_drag_drop_handler()
            .transparent(true)
            .focused(false)
            .on_navigation(|url| {
                url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
            }),
        tauri::LogicalPosition::new(12, 12),
        tauri::LogicalSize::new(128, 26),
    )
}

/// Legacy uploader window.open requests stay inside the host. The current
/// server already uses an iframe; both paths share the existing WebView profile.
pub fn build_tool(
    host: &Window,
    data_directory: PathBuf,
    session_origin: Arc<Mutex<Option<String>>>,
) -> tauri::Result<Webview> {
    let builder = WebviewBuilder::new(
        TOOL_LABEL,
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .data_directory(data_directory)
    .enable_clipboard_access()
    .disable_drag_drop_handler()
    .focused(false)
    .on_navigation(move |url| {
        url.as_str() == "about:blank"
            || http_origin(url)
                .is_some_and(|origin| Some(origin) == session_origin_snapshot(&session_origin))
    })
    .on_new_window(move |url, _| {
        open_in_default_browser(&url);
        NewWindowResponse::Deny
    });
    let tool = host.add_child(
        builder,
        tauri::LogicalPosition::new(0, 0),
        host.inner_size()?,
    )?;
    tool.hide()?;
    Ok(tool)
}

fn session_origin_snapshot(session_origin: &Arc<Mutex<Option<String>>>) -> Option<String> {
    session_origin.lock().ok().and_then(|guard| guard.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uploader_popup_requires_the_current_origin_and_uploader_path() {
        let current = "https://192.168.31.221:3001";
        assert!(is_internal_uploader_url(
            &Url::parse("https://192.168.31.221:3001/uploader/").unwrap(),
            Some(current)
        ));
        assert!(is_internal_uploader_url(
            &Url::parse("https://192.168.31.221:3001/subfolder/uploader/?from=client").unwrap(),
            Some(current)
        ));
        assert!(!is_internal_uploader_url(
            &Url::parse("https://example.com/uploader/").unwrap(),
            Some(current)
        ));
        assert!(!is_internal_uploader_url(
            &Url::parse("https://192.168.31.221:3001/help/").unwrap(),
            Some(current)
        ));
        assert!(!is_internal_uploader_url(
            &Url::parse("https://192.168.31.221:3001/uploader/").unwrap(),
            None
        ));
    }

    #[test]
    fn remote_navigation_is_bound_to_the_session_origin() {
        let session = "https://192.168.31.221:3001";
        assert!(navigation_allowed(
            &Url::parse("https://192.168.31.221:3001/pin/").unwrap(),
            Some(session)
        ));
        // Same host, different scheme/port: PIN & legacy redirect flows.
        assert!(navigation_allowed(
            &Url::parse("http://192.168.31.221:3000/").unwrap(),
            Some(session)
        ));
        assert!(navigation_allowed(
            &Url::parse("https://192.168.31.221:8443/selkies").unwrap(),
            Some(session)
        ));
        // Cross-site is denied.
        assert!(!navigation_allowed(
            &Url::parse("https://example.com/").unwrap(),
            Some(session)
        ));
        // Without a session origin no remote http target is allowed.
        assert!(!navigation_allowed(
            &Url::parse("https://192.168.31.221:3001/").unwrap(),
            None
        ));
        // Local assets and about pages are allowed.
        assert!(navigation_allowed(
            &Url::parse("http://tauri.localhost/waiting.html").unwrap(),
            Some(session)
        ));
        assert!(navigation_allowed(
            &Url::parse("tauri://localhost/shell.html").unwrap(),
            None
        ));
        assert!(navigation_allowed(
            &Url::parse("about:blank").unwrap(),
            None
        ));
        // Dangerous schemes never pass.
        assert!(!navigation_allowed(
            &Url::parse("file:///C:/secret").unwrap(),
            Some(session)
        ));
        assert!(!navigation_allowed(
            &Url::parse("javascript:alert(1)").unwrap(),
            Some(session)
        ));
    }
}
