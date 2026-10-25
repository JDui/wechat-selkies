//! IME regression contract carried over verbatim from the legacy client's
//! `webview_guard_preserves_chinese_ime_composition_until_commit` test
//! (spec section 10 T11 and P1 exit criteria).

use std::{fs, path::PathBuf};

fn script() -> String {
    fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("ui/remote-compat/ime-guard.js"))
        .expect("IME guard script must exist")
}

#[test]
fn webview_guard_preserves_chinese_ime_composition_until_commit() {
    let script = script();
    assert!(script.contains("__selkiesCompositionGuardInstalled"));
    assert!(script.contains(r#""compositionstart""#));
    assert!(script.contains("event.isComposing"));
    assert!(script.contains("event.stopImmediatePropagation()"));
    assert!(script.contains(r#""compositionend""#));
    assert!(script.contains(r#"String(event.data || "")"#));
    assert!(script.contains("if (finalInputSeen) return"));
    assert!(script.contains("input._typeString(value)"));
    // Legacy visible-UI hooks must be gone from the remote script.
    assert!(!script.contains("axiver-client-host"));
    assert!(!script.contains("attachShadow"));
    assert!(!script.contains("axiver-client.invalid"));
}

#[test]
fn ime_guard_is_frame_and_scheme_scoped() {
    let script = script();
    assert!(script.contains("window.top !== window.self"));
    assert!(script.contains("location.protocol"));
    assert!(script.contains("__AXIVER_IME_GUARD__"));
    assert!(script.contains("keyboard-input-assist"));
}
