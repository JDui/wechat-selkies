//! Windows platform integration: default-browser hand-off, process-scoped
//! WebView2 certificate policy and download destination handling.
//!
//! The legacy process-wide `--ignore-certificate-errors` behaviour is kept
//! unchanged on purpose (spec section 0 / 7): switching to strict validation
//! silently would break existing self-signed deployments. The security risk
//! is documented in README instead of being changed here.

use std::path::{Path, PathBuf};
use url::Url;

const IGNORE_CERTIFICATE_ERRORS_FLAG: &str = "--ignore-certificate-errors";

pub fn webview_browser_arguments(existing: &str) -> String {
    if existing
        .split_ascii_whitespace()
        .any(|argument| argument == IGNORE_CERTIFICATE_ERRORS_FLAG)
    {
        existing.to_string()
    } else if existing.trim().is_empty() {
        IGNORE_CERTIFICATE_ERRORS_FLAG.to_string()
    } else {
        format!("{} {IGNORE_CERTIFICATE_ERRORS_FLAG}", existing.trim())
    }
}

#[cfg(target_os = "windows")]
pub fn configure_webview_certificate_policy() {
    let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    let arguments = webview_browser_arguments(&existing);
    // SAFETY: This runs before Tauri or WebView2 creates any threads. The
    // environment change is process-local and inherited only by WebView2.
    unsafe {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", arguments);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn configure_webview_certificate_policy() {}

/// Automatic download permission belongs only to the active session origin.
/// Do not inherit navigation's same-host scheme/port redirect allowance here.
pub fn automatic_download_origin_allowed(uri: &str, session_origin: Option<&str>) -> bool {
    let Ok(url) = Url::parse(uri) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && session_origin.is_some_and(|origin| url.origin().ascii_serialization() == origin)
}

/// Selkies starts downloads asynchronously after its polling response. WebView2
/// otherwise accepts the first file and blocks subsequent files before even
/// issuing HTTP requests. Handle only that permission, for the current session,
/// rather than relaxing browser flags or persisting a profile-wide allowance.
#[cfg(target_os = "windows")]
pub fn configure_session_download_permission(
    window: &tauri::Webview,
    session_origin: std::sync::Arc<std::sync::Mutex<Option<String>>>,
) -> tauri::Result<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND,
            COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS,
            COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
            ICoreWebView2PermissionRequestedEventArgs3,
        },
        PermissionRequestedEventHandler, take_pwstr,
    };
    use windows::core::{Interface, PWSTR};

    window.with_webview(move |platform| unsafe {
        // SAFETY: with_webview runs on WebView2's owning UI thread. The COM
        // event owns the callback; Uri's allocated string is freed by take_pwstr.
        let install = || -> windows::core::Result<()> {
            let webview = platform.controller().CoreWebView2()?;
            webview.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    if kind != COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS {
                        return Ok(());
                    }
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    let uri = take_pwstr(uri);
                    let current = session_origin.lock().ok().and_then(|guard| guard.clone());
                    let allowed = automatic_download_origin_allowed(&uri, current.as_deref());
                    // Never leave an allowance behind when switching servers.
                    if let Ok(args3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                        args3.SetSavesInProfile(false)?;
                    }
                    args.SetState(if allowed {
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW
                    } else {
                        COREWEBVIEW2_PERMISSION_STATE_DENY
                    })?;
                    Ok(())
                })),
                &mut 0,
            )?;
            Ok(())
        };
        if let Err(error) = install() {
            eprintln!("could not install session download permission handler: {error}");
        }
    })
}

#[cfg(not(target_os = "windows"))]
pub fn configure_session_download_permission(
    _window: &tauri::Webview,
    _session_origin: std::sync::Arc<std::sync::Mutex<Option<String>>>,
) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn open_in_default_browser(url: &Url) -> bool {
    use std::{ffi::OsStr, iter::once, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::HWND,
        UI::{
            Shell::ShellExecuteW,
            WindowsAndMessaging::{SHOW_WINDOW_CMD, SW_SHOWNORMAL},
        },
    };

    if !is_external_browser_url(url) {
        return false;
    }
    let operation = OsStr::new("open")
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let target = OsStr::new(url.as_str())
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    // SAFETY: Both strings are valid, null-terminated UTF-16 buffers that
    // remain alive for the duration of this synchronous ShellExecuteW call.
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut::<std::ffi::c_void>() as HWND,
            operation.as_ptr(),
            target.as_ptr(),
            ptr::null(),
            ptr::null(),
            SW_SHOWNORMAL as SHOW_WINDOW_CMD,
        )
    };
    result as isize > 32
}

#[cfg(not(target_os = "windows"))]
pub fn open_in_default_browser(_url: &Url) -> bool {
    false
}

/// Only plain HTTP(S) may be handed to the system browser; arbitrary
/// schemes must never be treated as a "safe external link" (spec 3.7).
pub fn is_external_browser_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

pub fn fallback_download_name(url: &Url) -> String {
    let candidate = url
        .path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.is_empty()).next_back())
        .unwrap_or("AXIVER-download");
    let mut sanitized = candidate
        .chars()
        .map(|character| {
            if character.is_control() || r#"<>:"/\|?*"#.contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    while sanitized.ends_with(' ') || sanitized.ends_with('.') {
        sanitized.pop();
    }
    if sanitized.is_empty() {
        "AXIVER-download".to_string()
    } else {
        sanitized
    }
}

/// Relative destinations are completed against the Windows Downloads
/// directory; absolute destinations chosen by the browser are kept as-is
/// (respects redirected Download folders, legacy behaviour).
pub fn ensure_download_destination(
    download_dir: Option<&Path>,
    url: &Url,
    destination: &mut PathBuf,
) {
    if destination.is_absolute() {
        return;
    }
    if let Some(download_dir) = download_dir {
        let file_name = destination
            .file_name()
            .filter(|name| !name.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(fallback_download_name(url)));
        *destination = download_dir.join(file_name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_download_permission_is_scoped_to_the_current_session() {
        let session = Some("https://192.168.31.221:3001");
        assert!(automatic_download_origin_allowed(
            "https://192.168.31.221:3001/",
            session
        ));
        assert!(automatic_download_origin_allowed(
            "https://192.168.31.221:3001/files/",
            session
        ));
        for uri in [
            "https://192.168.31.221:8443/",
            "http://192.168.31.221:3001/",
            "https://example.com/",
            "http://tauri.localhost/shell.html",
            "file:///C:/secret",
            "blob:https://192.168.31.221:3001/id",
            "invalid",
        ] {
            assert!(!automatic_download_origin_allowed(uri, session), "{uri}");
        }
        assert!(!automatic_download_origin_allowed(
            "https://192.168.31.221:3001/",
            None
        ));
    }

    #[test]
    fn webview_certificate_flag_is_process_scoped_and_not_duplicated() {
        assert_eq!(
            webview_browser_arguments(""),
            IGNORE_CERTIFICATE_ERRORS_FLAG
        );
        assert_eq!(
            webview_browser_arguments("--disable-gpu"),
            "--disable-gpu --ignore-certificate-errors"
        );
        assert_eq!(
            webview_browser_arguments("--ignore-certificate-errors"),
            "--ignore-certificate-errors"
        );
    }

    #[test]
    fn ordinary_web_popups_are_external_browser_urls() {
        assert!(is_external_browser_url(
            &Url::parse("https://example.com/path").unwrap()
        ));
        assert!(is_external_browser_url(
            &Url::parse("http://127.0.0.1/test").unwrap()
        ));
        assert!(!is_external_browser_url(
            &Url::parse("file:///C:/secret.txt").unwrap()
        ));
        assert!(!is_external_browser_url(
            &Url::parse("javascript:alert(1)").unwrap()
        ));
    }

    #[test]
    fn download_destination_falls_back_to_downloads_with_a_safe_name() {
        let downloads = std::env::temp_dir().join("AXIVER-download-test");
        let url = Url::parse("https://example.com/files/report%202026.pdf").unwrap();
        let mut destination = PathBuf::new();
        ensure_download_destination(Some(&downloads), &url, &mut destination);
        assert_eq!(destination.parent(), Some(downloads.as_path()));
        assert_eq!(
            destination.file_name().and_then(|name| name.to_str()),
            Some("report%202026.pdf")
        );

        let existing = downloads.join("already-selected.zip");
        let mut selected = existing.clone();
        ensure_download_destination(Some(&downloads), &url, &mut selected);
        assert_eq!(selected, existing);

        let mut relative = PathBuf::from("server-name.zip");
        ensure_download_destination(Some(&downloads), &url, &mut relative);
        assert_eq!(relative, downloads.join("server-name.zip"));

        assert_eq!(
            fallback_download_name(&Url::parse("https://example.com/").unwrap()),
            "AXIVER-download"
        );
    }
}
