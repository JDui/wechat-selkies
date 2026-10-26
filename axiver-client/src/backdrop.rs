//! Frost the actual remote child surface. CapturePreview never includes local
//! controls or other applications; frames stay in memory and are not persisted.
use crate::protocol::{MAIN_LABEL, REMOTE_LABEL, SHELL_LABEL, TOOL_LABEL};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::Manager;

pub fn start(app: tauri::AppHandle) {
    let busy = Arc::new(AtomicBool::new(false));
    std::thread::spawn(move || {
        loop {
            let Some(ui) = app.try_state::<Arc<crate::ui_layout::UiController>>() else {
                std::thread::sleep(std::time::Duration::from_millis(300));
                continue;
            };
            let expanded = ui.is_expanded();
            std::thread::sleep(std::time::Duration::from_millis(if expanded {
                250
            } else {
                850
            }));
            let Some(host) = app.get_window(MAIN_LABEL) else {
                break;
            };
            if !host.is_visible().unwrap_or(false) || host.is_minimized().unwrap_or(true) {
                continue;
            }
            if busy.swap(true, Ordering::SeqCst) {
                continue;
            }
            let label = if ui.tool_active() {
                TOOL_LABEL
            } else {
                REMOTE_LABEL
            };
            let Some(view) = app.get_webview(label) else {
                busy.store(false, Ordering::SeqCst);
                continue;
            };
            let done = busy.clone();
            let target = app.clone();
            let logical = host
                .inner_size()
                .ok()
                .zip(host.scale_factor().ok())
                .map(|(size, scale)| size.to_logical::<f64>(scale));
            if let Err(_) = view.with_webview(move |platform| {
            #[cfg(windows)]
            unsafe {
                use base64::Engine;
                use windows::Win32::{Foundation::HGLOBAL, System::Com::{
                    StructuredStorage::CreateStreamOnHGlobal, STATSTG, STATFLAG_NONAME, STREAM_SEEK_SET,
                }};
                use webview2_com::{CapturePreviewCompletedHandler, Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG};
                let capture = || -> windows::core::Result<()> {
                    let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
                    let output = stream.clone();
                    let finished = done.clone();
                    platform.controller().CoreWebView2()?.CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG, &stream,
                        &CapturePreviewCompletedHandler::create(Box::new(move |status| {
                            // Read the COM stream on its owning UI apartment, but
                            // keep encoding and cross-webview calls out of this callback.
                            let result = (|| -> windows::core::Result<Option<Vec<u8>>> {
                                status?;
                                let mut stat = STATSTG::default();
                                output.Stat(&mut stat, STATFLAG_NONAME)?;
                                if stat.cbSize == 0 || stat.cbSize > 16 * 1024 * 1024 {
                                    return Ok(None);
                                }
                                let mut bytes = vec![0u8; stat.cbSize as usize];
                                output.Seek(0, STREAM_SEEK_SET, None)?;
                                let mut count = 0;
                                output.Read(bytes.as_mut_ptr().cast(), bytes.len() as u32, Some(&mut count)).ok()?;
                                bytes.truncate(count as usize);
                                Ok(Some(bytes))
                            })();
                            if let Ok(Some(bytes)) = result {
                                let finished = finished.clone();
                                let target = target.clone();
                                let logical = logical.clone();
                                std::thread::spawn(move || {
                                    if let (Some(shell), Some(size)) = (target.get_webview(SHELL_LABEL), logical) {
                                        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                                        let json = serde_json::json!({"src":format!("data:image/jpeg;base64,{data}"),"width":size.width,"height":size.height});
                                        let _ = shell.eval(format!("window.__AXIVER_SHELL__&&window.__AXIVER_SHELL__.onBackdrop({json});"));
                                    }
                                    finished.store(false, Ordering::SeqCst);
                                });
                            } else {
                                finished.store(false, Ordering::SeqCst);
                            }
                            Ok(())
                        })),
                    )?;
                    Ok(())
                };
                if capture().is_err() { done.store(false, Ordering::SeqCst); }
            }
            #[cfg(not(windows))]
            done.store(false, Ordering::SeqCst);
        }) { busy.store(false, Ordering::SeqCst); }
        }
    });
}
