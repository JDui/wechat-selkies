//! AXIVER portable Windows client — local-shell rebuild (v0.2).
//!
//! Module map (spec section 11):
//! - `protocol`        DTO + shared domain types / event names
//! - `config`          validation + backward-compatible SQLite persistence
//! - `discovery`       mDNS / HTTP identity / subnet-scan protocol
//! - `connection`      the single Connection Manager (state machine)
//! - `webview`         remote session window, popups, navigation policy
//! - `platform_windows` ShellExecuteW, certificate policy, download dir
//! - `commands`        typed IPC for the trusted local Shell only
//! - `app_state`       managed shared state + trust guards

pub mod app_state;
pub mod commands;
pub mod config;
pub mod connection;
pub mod discovery;
pub mod platform_windows;
pub mod protocol;
pub mod ui_layout;
pub mod webview;

pub use protocol::{ConnectionPhase, ConnectionSnapshotV1};

pub mod backdrop;
pub mod downloads;
