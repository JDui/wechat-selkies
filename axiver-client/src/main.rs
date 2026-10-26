#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use axiver_client::{
    app_state::CoreState,
    commands,
    config::{self, SettingsRepository},
    connection::ConnectionManager,
    platform_windows,
    protocol::{self, ConnectionSnapshotV1, EVENT_CONNECTION_STATUS},
    ui_layout::UiController,
    webview,
};
use std::{
    fs,
    sync::{Arc, Mutex},
};
use tauri::{
    Listener, Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
const TRAY_ID: &str = "axiver-tray";

fn main() {
    platform_windows::configure_webview_certificate_policy();
    let root = config::portable_root();
    let data_directory = root.join("axiver-client-data");
    let _ = fs::create_dir_all(&data_directory);
    let loaded = config::load(&root.join("axiver-client.db"));
    let config_state = Arc::new(Mutex::new(loaded.config));
    let db_error_state = Arc::new(Mutex::new(loaded.db_error));
    let session_origin = Arc::new(Mutex::new(None));
    let repository = Arc::new(SettingsRepository::new(root.join("axiver-client.db")));

    tauri::Builder::default()
        .on_window_event(|window, event| {
            if window.label() != protocol::MAIN_LABEL {
                return;
            }
            match event {
                tauri::WindowEvent::CloseRequested { .. } => window.app_handle().exit(0),
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    if let Some(ui) = window.app_handle().try_state::<Arc<UiController>>() {
                        ui.resize();
                    }
                }
                _ => {}
            }
        })
        .setup(move |app| {
            let host = tauri::window::WindowBuilder::new(app, protocol::MAIN_LABEL)
                .title(webview::APP_TITLE)
                .icon(tauri::include_image!("icons/128x128.png"))?
                .inner_size(1280.0, 820.0)
                .min_inner_size(820.0, 560.0)
                .theme(Some(tauri::Theme::Dark))
                .center()
                .visible(false)
                .build()?;
            let remote = webview::build_remote(
                app,
                &host,
                data_directory.clone(),
                include_str!("../ui/remote-compat/ime-guard.js").to_string(),
                session_origin.clone(),
            )?;
            let tool = webview::build_tool(&host, data_directory.clone(), session_origin.clone())?;
            let shell = webview::build_shell(&host, data_directory.clone())?;
            let ui = Arc::new(UiController::new(app.handle().clone()));
            app.manage(ui.clone());
            let downloads = Arc::new(axiver_client::downloads::DownloadManager::new(
                app.handle().clone(),
            ));
            downloads.start_progress_clock();
            axiver_client::downloads::install(&remote, downloads.clone())?;
            axiver_client::downloads::install(&tool, downloads.clone())?;
            let manager = Arc::new(ConnectionManager::new(
                app.handle().clone(),
                remote.clone(),
                remote.url()?,
                config_state.clone(),
                session_origin.clone(),
            ));
            app.manage(Arc::new(CoreState {
                manager: manager.clone(),
                config: config_state.clone(),
                repository,
                db_error: db_error_state.clone(),
                remote: remote.clone(),
                shell,
                ui: ui.clone(),
                downloads,
            }));
            ui.apply()?;
            build_tray(
                app.handle(),
                manager.clone(),
                host.clone(),
                db_error_state.clone(),
            )?;
            host.show()?;
            let _ = host.set_focus();
            let _ = remote.set_focus();
            manager.start();
            axiver_client::backdrop::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::client_get_config,
            commands::client_update_config,
            commands::client_get_connection,
            commands::client_get_diagnostics,
            commands::client_reconnect,
            commands::client_connect_wan,
            commands::client_refresh_remote,
            commands::client_open_settings,
            commands::client_hide_settings,
            commands::client_toggle_settings,
            commands::client_set_always_on_top,
            commands::client_get_version,
            commands::client_ui_layout,
            commands::client_get_downloads,
            commands::client_confirm_download,
            commands::client_get_download_settings,
            commands::client_set_download_mode,
            commands::client_choose_download_directory,
            commands::client_cancel_download,
            commands::client_reveal_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running AXIVER Client");
}

fn build_tray(
    handle: &tauri::AppHandle,
    manager: Arc<ConnectionManager>,
    shell: tauri::Window,
    db_error: Arc<Mutex<Option<String>>>,
) -> tauri::Result<()> {
    let status_item = MenuItem::with_id(
        handle,
        "tray-status",
        "AXIVER：正在准备",
        false,
        None::<&str>,
    )?;
    let show_item = MenuItem::with_id(handle, "tray-show", "显示主窗口", true, None::<&str>)?;
    let reconnect_item =
        MenuItem::with_id(handle, "tray-reconnect", "重新连接", true, None::<&str>)?;
    let refresh_item =
        MenuItem::with_id(handle, "tray-refresh", "刷新远程页面", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(handle, "tray-quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        handle,
        &[
            &status_item,
            &PredefinedMenuItem::separator(handle)?,
            &show_item,
            &reconnect_item,
            &refresh_item,
            &PredefinedMenuItem::separator(handle)?,
            &quit_item,
        ],
    )?;

    let shell_for_click = shell.clone();
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("AXIVER Client")
        .icon(tauri::include_image!("icons/32x32.png"))
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "tray-show" => {
                let _ = shell.unminimize();
                let _ = shell.show();
                let _ = shell.set_focus();
            }
            "tray-reconnect" => manager.reconnect(),
            "tray-refresh" => manager.note_manual_refresh(),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = shell_for_click.unminimize();
                let _ = shell_for_click.show();
                let _ = shell_for_click.set_focus();
            }
        })
        .build(handle)?;

    // Reflect connection state in the tray tooltip and status line.
    let tooltip_tray = tray.clone();
    let status_for_event = status_item.clone();
    let db_error_for_event = db_error;
    handle.listen(EVENT_CONNECTION_STATUS, move |event| {
        let Ok(snapshot) = serde_json::from_str::<ConnectionSnapshotV1>(event.payload()) else {
            return;
        };
        let suffix = db_error_for_event
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .map(|_| "（设置数据库不可用）")
            .unwrap_or_default();
        let text = format!(
            "AXIVER：{}{}{}",
            snapshot.detail,
            suffix,
            snapshot
                .target_url
                .as_deref()
                .map(|url| format!(" — {url}"))
                .unwrap_or_default()
        );
        let _ = status_for_event.set_text(&text);
        let _ = tooltip_tray.set_tooltip(Some(&text));
    });
    Ok(())
}
