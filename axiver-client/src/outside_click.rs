//! Observe actual mouse presses across native WebViews without consuming them.
//! Focus changes alone are deliberately irrelevant to popup dismissal.
#[cfg(windows)]
pub fn start(ui: std::sync::Arc<crate::ui_layout::UiController>) {
    use std::sync::{OnceLock, Weak};
    use windows_sys::Win32::{
        Foundation::{LPARAM, LRESULT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::*,
    };

    static CONTROLLER: OnceLock<Weak<crate::ui_layout::UiController>> = OnceLock::new();

    unsafe extern "system" fn pressed(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
        if code >= 0
            && matches!(
                message as u32,
                WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
            )
        {
            if let Some(ui) = CONTROLLER.get().and_then(Weak::upgrade) {
                if ui.is_expanded() {
                    // SAFETY: WH_MOUSE_LL provides MSLLHOOKSTRUCT for this call.
                    let point = unsafe { (*(data as *const MSLLHOOKSTRUCT)).pt };
                    ui.on_pointer_down(point.x, point.y);
                }
            }
        }
        // Never suppress or replay the user's click.
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, message, data) }
    }

    if CONTROLLER.set(std::sync::Arc::downgrade(&ui)).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("axiver-outside-click".into())
        .spawn(|| unsafe {
            // A dedicated message pump keeps the low-level callback independent of
            // WebView rendering. Hit testing is queued to the owning UI thread.
            let hook = SetWindowsHookExW(
                WH_MOUSE_LL,
                Some(pressed),
                GetModuleHandleW(std::ptr::null()),
                0,
            );
            if hook.is_null() {
                crate::connection_log::record(
                    "outside_click_error",
                    0,
                    &std::io::Error::last_os_error().to_string(),
                );
                return;
            }
            let mut message = MSG::default();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            UnhookWindowsHookEx(hook);
        })
        .expect("spawn outside click observer");
}

#[cfg(not(windows))]
pub fn start(_: std::sync::Arc<crate::ui_layout::UiController>) {}
