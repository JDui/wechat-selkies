//! Contract tests for the packaged app manifest: the trust boundary is part
//! of the shipped configuration, not just the Rust code (spec sections 4.3
//! route B / 7).

use std::{fs, path::PathBuf};

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn tauri_conf_declares_no_predefined_windows_and_local_frontend() {
    let root = project_root();
    let text = fs::read_to_string(root.join("tauri.conf.json")).unwrap();
    let config: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(config["build"]["frontendDist"], "ui");
    assert_eq!(config["app"]["windows"], serde_json::json!([]));
    assert_eq!(config["productName"], "AXIVER Client");
    assert_eq!(config["identifier"], "com.axiver.portable-client");

    // The local frontend assets referenced by the builders must exist.
    for file in [
        "waiting.html",
        "waiting.css",
        "brand-mark.svg",
        "shell.html",
        "shell.css",
        "shell.js",
    ] {
        assert!(root.join("ui").join(file).exists(), "missing ui/{file}");
    }
    assert!(
        root.join("ui/remote-compat/ime-guard.js").exists(),
        "remote-compat script must exist"
    );
    // The removed overlay must stay removed.
    assert!(
        !root.join("ui/injected.js").exists(),
        "the legacy Shadow DOM overlay script must not come back"
    );
}

#[test]
fn capabilities_grant_ipc_only_to_the_local_child_webview() {
    let capability: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(project_root().join("capabilities/default.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(capability["webviews"], serde_json::json!(["shell"]));
    assert!(
        capability.get("windows").is_none(),
        "do not grant all children of the host"
    );
    assert!(
        capability.get("remote").is_none(),
        "remote URLs must not receive capabilities"
    );
}

#[test]
fn shell_uses_the_injected_global_tauri_bridge() {
    // Regression guard for the field bug this test reproduces: without
    // `app.withGlobalTauri` the Shell never receives `window.__TAURI__` and
    // every button silently dies ("本地 IPC 不可用" / "保存失败：未知错误").
    let root = project_root();
    let config: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(root.join("tauri.conf.json")).unwrap()).unwrap();
    assert_eq!(
        config["app"]["withGlobalTauri"],
        serde_json::Value::Bool(true),
        "the bundler-free Shell depends on the injected __TAURI__ global"
    );
    let shell_js = fs::read_to_string(root.join("ui/shell.js")).unwrap();
    assert!(shell_js.contains("window.__TAURI__"));
    assert!(shell_js.contains("client_ui_layout"));
}

#[test]
fn controls_share_one_native_host_without_remote_injection() {
    let root = project_root();
    let shell = fs::read_to_string(root.join("ui/shell.js")).unwrap();
    for forbidden in ["attachShadow", "axiver-client.invalid", "location.replace"] {
        assert!(!shell.contains(forbidden));
    }
    assert!(
        !root.join("ui/dot.html").exists(),
        "the separate status window was removed"
    );
    let webview = fs::read_to_string(root.join("src/webview.rs")).unwrap();
    assert!(
        !webview.contains("WebviewWindowBuilder"),
        "tools and local controls must remain child views"
    );
    let main = fs::read_to_string(root.join("src/main.rs")).unwrap();
    assert_eq!(main.matches("WindowBuilder::new").count(), 1);
}

#[test]
fn remote_window_has_no_ipc_entry_points_in_frontend_files() {
    // The waiting page must stay scriptless so a failed remote load can
    // never execute local IPC.
    let root = project_root();
    let waiting = fs::read_to_string(root.join("ui/waiting.html")).unwrap();
    assert!(
        !waiting.contains("<script"),
        "waiting page must not contain scripts"
    );
    let ime = fs::read_to_string(root.join("ui/remote-compat/ime-guard.js")).unwrap();
    for forbidden in ["__TAURI__", "invoke(", "axiver-client.invalid"] {
        assert!(
            !ime.contains(forbidden),
            "remote-compat script must never touch {forbidden}"
        );
    }
}
