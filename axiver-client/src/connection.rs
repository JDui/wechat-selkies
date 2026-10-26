//! The single owner of connection state (spec sections 4.2 / 5.3).
//!
//! One worker thread performs the whole pipeline
//! `discover LAN -> scan subnets -> fall back to WAN -> navigate -> monitor`
//! and is the only place that writes the connection snapshot. Every attempt
//! carries a generation number: results of superseded tasks are dropped
//! before they can navigate the webview or publish state, which fixes the
//! old race where a stale task could overwrite a newer connection result.

use crate::discovery::{
    CancelToken, DISCOVERY_TIMEOUT, Endpoint, PROBE_INTERVAL, TargetKind, WanError,
    endpoint_is_alive,
    mdns::{DiscoveryProgress, LanOutcome, discover_lan},
    resolve_wan,
    subnet::scan_lan_subnets,
};
use crate::protocol::{
    ConnectionPhase, ConnectionSnapshotV1, EVENT_CONNECTION_STATUS, LinkKind, SHELL_LABEL,
    error_code, now_iso8601, retry_backoff,
};
use mdns_sd::ServiceDaemon;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, Webview};
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ManagerCommand {
    Reconnect,
    /// Skip LAN discovery on the next attempt and go straight to the WAN
    /// fallback (Shell "外网" chip). Ignored when no wide URL is configured.
    ForceWan,
    Shutdown,
}

struct ManagerInner {
    app: AppHandle,
    remote: Webview,
    waiting_url: Url,
    snapshot: Mutex<ConnectionSnapshotV1>,
    generation: Arc<AtomicU64>,
    failed_attempts: AtomicU32,
    config: Arc<Mutex<crate::protocol::ClientConfigV1>>,
    session_origin: Arc<Mutex<Option<String>>>,
    page_loaded: AtomicBool,
}

pub struct ConnectionManager {
    inner: Arc<ManagerInner>,
    commands: Sender<ManagerCommand>,
    receiver: Mutex<Option<Receiver<ManagerCommand>>>,
}

impl ConnectionManager {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        app: AppHandle,
        remote: Webview,
        waiting_url: Url,
        config: Arc<Mutex<crate::protocol::ClientConfigV1>>,
        session_origin: Arc<Mutex<Option<String>>>,
    ) -> Self {
        let (commands, receiver) = mpsc::channel();
        Self {
            inner: Arc::new(ManagerInner {
                app,
                remote,
                waiting_url,
                snapshot: Mutex::new(ConnectionSnapshotV1::default()),
                generation: Arc::new(AtomicU64::new(0)),
                failed_attempts: AtomicU32::new(0),
                config,
                session_origin,
                page_loaded: AtomicBool::new(false),
            }),
            commands,
            receiver: Mutex::new(Some(receiver)),
        }
    }

    /// Spawn the single connection worker. Must be called exactly once.
    pub fn start(&self) {
        let Some(receiver) = self.receiver.lock().ok().and_then(|mut slot| slot.take()) else {
            return;
        };
        let inner = self.inner.clone();
        thread::Builder::new()
            .name("axiver-connection".to_string())
            .spawn(move || connection_worker(inner, receiver))
            .expect("spawn connection worker");
    }

    /// Queue a full re-discovery (never equivalent to a plain page reload).
    /// The generation bump also aborts an in-flight attempt early.
    pub fn reconnect(&self) {
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        let _ = self.commands.send(ManagerCommand::Reconnect);
    }

    /// Queue an immediate switch to the configured wide (WAN) address,
    /// skipping mDNS and subnet scanning on the next attempt. The generation
    /// bump aborts an in-flight LAN attempt early so the switch feels
    /// immediate instead of waiting out the discovery timeouts.
    pub fn force_wan(&self) {
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        let _ = self.commands.send(ManagerCommand::ForceWan);
    }

    pub fn snapshot(&self) -> ConnectionSnapshotV1 {
        self.inner
            .snapshot
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// Store a saved configuration; trigger reconnect only on real change
    /// (spec section 5.2: 有变更才触发重连).
    pub fn apply_saved_config(&self, next: crate::protocol::ClientConfigV1) {
        let changed = {
            let Ok(mut current) = self.inner.config.lock() else {
                return;
            };
            let changed = *current != next;
            *current = next;
            changed
        };
        if changed {
            self.reconnect();
        }
    }

    /// `client_refresh_remote`: reload the current page only. Does not
    /// re-run discovery and never switches LAN/WAN targets.
    pub fn note_manual_refresh(&self) {
        {
            let Ok(mut snapshot) = self.inner.snapshot.lock() else {
                return;
            };
            if snapshot.target_url.is_none() {
                return;
            }
            snapshot.page_loaded = Some(false);
        }
        let _ = self.inner.remote.reload();
        self.update(|snapshot| {
            if matches!(
                snapshot.phase,
                ConnectionPhase::Connected | ConnectionPhase::LoadingPage
            ) {
                snapshot.phase = ConnectionPhase::LoadingPage;
                snapshot.detail = "正在刷新远程页面".to_string();
                snapshot.page_loaded = Some(false);
                snapshot.last_checked_at = Some(now_iso8601());
            }
        });
    }

    /// Called from the remote window's page-load handler. A load only counts
    /// as "connected" for the current session origin; it never claims more
    /// than "page loaded" (spec section 5.1).
    pub fn on_page_finished(&self, url: &Url) {
        let session_origin = self
            .inner
            .session_origin
            .lock()
            .ok()
            .and_then(|guard| guard.clone());
        let Some(expected) = session_origin else {
            return;
        };
        let Some(origin) = crate::webview::http_origin(url) else {
            return;
        };
        if origin != expected {
            return;
        }
        self.inner.page_loaded.store(true, Ordering::SeqCst);
        self.update(|snapshot| {
            if snapshot.phase == ConnectionPhase::LoadingPage || snapshot.page_loaded == Some(false)
            {
                snapshot.phase = match snapshot.kind {
                    LinkKind::None => snapshot.phase,
                    _ => ConnectionPhase::Connected,
                };
                snapshot.detail = match snapshot.kind {
                    LinkKind::Lan => "当前连接：局域网".to_string(),
                    LinkKind::Wan => "当前连接：广域地址".to_string(),
                    LinkKind::None => snapshot.detail.clone(),
                };
                snapshot.page_loaded = Some(true);
                snapshot.transport_reachable = Some(true);
                snapshot.error_code = None;
                snapshot.last_checked_at = Some(now_iso8601());
            }
        });
    }

    fn update<F>(&self, mutate: F)
    where
        F: FnOnce(&mut ConnectionSnapshotV1),
    {
        self.inner.update(mutate);
    }
}

impl ManagerInner {
    /// Apply a mutation to the snapshot, bump the monotonic revision, emit
    /// the Tauri event and push the same payload to the Shell window.
    fn update<F>(&self, mutate: F)
    where
        F: FnOnce(&mut ConnectionSnapshotV1),
    {
        let payload = {
            let Ok(mut snapshot) = self.snapshot.lock() else {
                return;
            };
            mutate(&mut snapshot);
            snapshot.revision += 1;
            match serde_json::to_string(&*snapshot) {
                Ok(json) => json,
                Err(_) => return,
            }
        };
        // Listeners may read the manager again; emit after releasing its lock.
        let snapshot = self.snapshot.lock().ok().map(|guard| guard.clone());
        if let Some(snapshot) = snapshot {
            let _ = self.app.emit(EVENT_CONNECTION_STATUS, &snapshot);
        }
        if let Some(shell) = self.app.get_webview(SHELL_LABEL) {
            let _ = shell.eval(format!(
                "window.__AXIVER_SHELL__&&window.__AXIVER_SHELL__.onStatus({payload});"
            ));
        }
    }

    fn reset_target_fields(&self) {
        if let Some(ui) = self.app.try_state::<Arc<crate::ui_layout::UiController>>() {
            ui.close_tool();
        }
        self.page_loaded.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.session_origin.lock() {
            *guard = None;
        }
    }
}

impl Drop for ConnectionManager {
    fn drop(&mut self) {
        let _ = self.commands.send(ManagerCommand::Shutdown);
    }
}

fn wan_error_detail(error: &WanError) -> (&'static str, &'static str) {
    match error {
        WanError::InvalidUrl => (error_code::INVALID_WIDE_URL, "广域地址格式无效"),
        WanError::DnsFailed => (error_code::WAN_DNS_FAILED, "广域地址 DNS 解析失败"),
        WanError::TcpUnreachable => (error_code::WAN_TCP_UNREACHABLE, "广域地址 TCP 不可达"),
    }
}

fn connection_worker(inner: Arc<ManagerInner>, receiver: Receiver<ManagerCommand>) {
    let (mdns, mdns_error) = match ServiceDaemon::new() {
        Ok(daemon) => (Some(daemon), None),
        Err(error) => (None, Some(format!("mDNS 初始化失败：{error}"))),
    };
    // None = start discovery immediately; Some(delay) = wait before retrying.
    let mut wait_before_retry: Option<Duration> = None;
    // Set by the Shell "外网" chip: the next attempt skips LAN stages entirely.
    let mut pending_force_wan = false;

    loop {
        // ---- command gate -------------------------------------------------
        if let Some(delay) = wait_before_retry.take() {
            match receiver.recv_timeout(delay) {
                Ok(ManagerCommand::Shutdown) => return,
                Ok(ManagerCommand::ForceWan) => pending_force_wan = true,
                Ok(ManagerCommand::Reconnect) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        // Coalesce queued reconnect requests into one task.
        while let Ok(command) = receiver.try_recv() {
            match command {
                ManagerCommand::Shutdown => return,
                ManagerCommand::ForceWan => pending_force_wan = true,
                ManagerCommand::Reconnect => {}
            }
        }

        let current = inner
            .config
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let generation = inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let cancel = CancelToken {
            my_generation: generation,
            live: Some(inner.generation.clone()),
        };
        let is_stale = || inner.generation.load(Ordering::SeqCst) != generation;
        inner.reset_target_fields();
        // A forced WAN switch is only meaningful with a configured wide URL.
        let force_wan = pending_force_wan && !current.wide_url.trim().is_empty();
        pending_force_wan = false;

        let mut discovery_error: Option<(String, String)> = None; // (code, detail)
        let mut endpoint: Option<Endpoint> = None;
        if force_wan {
            inner.update(|snapshot| {
                snapshot.phase = ConnectionPhase::ConnectingWan;
                snapshot.kind = LinkKind::None;
                snapshot.target_url = None;
                snapshot.detail = "正在切换到广域地址".to_string();
                snapshot.error_code = None;
                snapshot.transport_reachable = None;
                snapshot.page_loaded = None;
                snapshot.last_checked_at = Some(now_iso8601());
            });
        }
        if !force_wan {
            // ---- stage 1: mDNS ---------------------------------------------
            inner.update(|snapshot| {
                snapshot.phase = ConnectionPhase::DiscoveringLan;
                snapshot.kind = LinkKind::None;
                snapshot.target_url = None;
                snapshot.detail = format!("正在嗅探 {}", current.broadcast_name);
                snapshot.error_code = None;
                snapshot.transport_reachable = None;
                snapshot.page_loaded = None;
                snapshot.last_checked_at = Some(now_iso8601());
            });
            endpoint = match mdns.as_ref() {
                Some(daemon) => {
                    match discover_lan(
                        daemon,
                        &current.broadcast_name,
                        DISCOVERY_TIMEOUT,
                        &cancel,
                        generation,
                        |progress| match progress {
                            DiscoveryProgress::InstanceFound { name } => {
                                let name2 = name.clone();
                                inner.update(move |snapshot| {
                                    snapshot.phase = ConnectionPhase::DiscoveringLan;
                                    snapshot.detail = format!("已发现 {name2}，正在解析地址");
                                });
                            }
                            DiscoveryProgress::Resolved { name } => {
                                let name2 = name.clone();
                                inner.update(move |snapshot| {
                                    snapshot.phase = ConnectionPhase::ConnectingLan;
                                    snapshot.kind = LinkKind::Lan;
                                    snapshot.detail = format!("已发现 {name2}，正在验证连接");
                                });
                            }
                            DiscoveryProgress::Rejected { reason } => {
                                let reason2 = reason.clone();
                                inner.update(move |snapshot| {
                                    snapshot.detail = reason2;
                                });
                            }
                        },
                    ) {
                        Ok(LanOutcome::Found(endpoint)) => Some(endpoint),
                        Ok(LanOutcome::MatchedButFailed(reason)) => {
                            let code = if reason.contains("身份") {
                                error_code::LAN_IDENTITY_MISMATCH.to_string()
                            } else {
                                error_code::TARGET_UNREACHABLE.to_string()
                            };
                            discovery_error = Some((code, reason));
                            None
                        }
                        Ok(LanOutcome::Cancelled) => continue,
                        Ok(LanOutcome::NotFound) => None,
                        Err(error) => {
                            discovery_error =
                                Some((error_code::MDNS_BROWSE_FAILED.to_string(), error));
                            None
                        }
                    }
                }
                None => {
                    discovery_error = Some((
                        error_code::MDNS_UNAVAILABLE.to_string(),
                        mdns_error
                            .clone()
                            .unwrap_or_else(|| "mDNS 初始化失败".to_string()),
                    ));
                    None
                }
            };
            if is_stale() {
                continue;
            }

            // ---- stage 2: subnet scan --------------------------------------
            if endpoint.is_none() {
                inner.update(|snapshot| {
                    snapshot.phase = ConnectionPhase::ScanningSubnet;
                    snapshot.kind = LinkKind::None;
                    snapshot.detail =
                        format!("mDNS 未响应，正在扫描同网段 {}", current.broadcast_name);
                });
                let (found, cancelled) =
                    scan_lan_subnets(&current.broadcast_name, &cancel, generation);
                if cancelled || is_stale() {
                    continue;
                }
                if let Some(found) = found {
                    endpoint = Some(found);
                    discovery_error = None;
                }
            }
        }

        // ---- stage 3: WAN fallback ------------------------------------------
        if endpoint.is_none() && !current.wide_url.is_empty() {
            inner.update(|snapshot| {
                snapshot.phase = ConnectionPhase::ConnectingWan;
                snapshot.detail = "正在连接广域地址".to_string();
            });
            match resolve_wan(&current.wide_url) {
                Ok(resolved) => {
                    endpoint = Some(resolved);
                    discovery_error = None;
                }
                Err(error) => {
                    let (code, detail) = wan_error_detail(&error);
                    discovery_error = Some((code.to_string(), detail.to_string()));
                }
            }
        }
        if is_stale() {
            continue;
        }

        // ---- no target: backoff and retry -----------------------------------
        let Some(endpoint) = endpoint else {
            inner.failed_attempts.fetch_add(1, Ordering::SeqCst);
            let attempts = inner.failed_attempts.load(Ordering::SeqCst);
            let (code, detail) = match &discovery_error {
                Some((code, detail)) => (Some(code.clone()), detail.clone()),
                None => (
                    Some(error_code::LAN_NOT_FOUND.to_string()),
                    "mDNS 与同网段扫描均未找到匹配项目".to_string(),
                ),
            };
            inner.update(|snapshot| {
                snapshot.phase = ConnectionPhase::Disconnected;
                snapshot.kind = LinkKind::None;
                snapshot.target_url = None;
                snapshot.detail = detail;
                snapshot.error_code = code;
                snapshot.transport_reachable = Some(false);
                snapshot.page_loaded = Some(false);
                snapshot.last_checked_at = Some(now_iso8601());
            });
            wait_before_retry = Some(retry_backoff(attempts.saturating_sub(1)));
            continue;
        };

        // ---- navigate -------------------------------------------------------
        if let Ok(mut guard) = inner.session_origin.lock() {
            *guard = crate::webview::http_origin(&endpoint.url);
        }
        inner.page_loaded.store(false, Ordering::SeqCst);
        let kind = match endpoint.kind {
            TargetKind::Lan => LinkKind::Lan,
            TargetKind::Wan => LinkKind::Wan,
            TargetKind::None => LinkKind::None,
        };
        inner.update(|snapshot| {
            snapshot.phase = match endpoint.kind {
                TargetKind::Wan => ConnectionPhase::ConnectingWan,
                _ => ConnectionPhase::ConnectingLan,
            };
            snapshot.kind = kind;
            snapshot.target_url = Some(endpoint.url.as_str().to_string());
            snapshot.detail = match endpoint.kind {
                TargetKind::Wan => "正在连接广域地址".to_string(),
                _ => "正在连接局域网容器".to_string(),
            };
            snapshot.error_code = None;
            snapshot.transport_reachable = Some(true);
            snapshot.page_loaded = Some(false);
            snapshot.last_checked_at = Some(now_iso8601());
        });
        if inner.remote.navigate(endpoint.url.clone()).is_err() || is_stale() {
            if !is_stale() {
                inner.update(|snapshot| {
                    snapshot.phase = ConnectionPhase::Disconnected;
                    snapshot.detail = "页面打开失败".to_string();
                    snapshot.error_code = Some(error_code::PAGE_LOAD_FAILED.to_string());
                    snapshot.page_loaded = Some(false);
                });
                inner.failed_attempts.fetch_add(1, Ordering::SeqCst);
                wait_before_retry = Some(retry_backoff(
                    inner
                        .failed_attempts
                        .load(Ordering::SeqCst)
                        .saturating_sub(1),
                ));
            }
            continue;
        }
        inner.failed_attempts.store(0, Ordering::SeqCst);
        inner.update(|snapshot| {
            snapshot.phase = ConnectionPhase::LoadingPage;
            snapshot.detail = "正在加载远程页面".to_string();
        });

        // ---- monitor loop ----------------------------------------------------
        loop {
            match receiver.recv_timeout(PROBE_INTERVAL) {
                Ok(ManagerCommand::Shutdown) => return,
                Ok(ManagerCommand::ForceWan) => {
                    pending_force_wan = true;
                    inner.update(|snapshot| {
                        snapshot.phase = ConnectionPhase::Reconnecting;
                        snapshot.detail = "正在切换到广域地址".to_string();
                    });
                    break;
                }
                Ok(ManagerCommand::Reconnect) => {
                    inner.update(|snapshot| {
                        snapshot.phase = ConnectionPhase::Reconnecting;
                        snapshot.detail = "正在重新连接".to_string();
                    });
                    break;
                }
                Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => {
                    let alive = endpoint_is_alive(&endpoint);
                    let page_loaded = inner.page_loaded.load(Ordering::SeqCst);
                    inner.update(|snapshot| {
                        snapshot.transport_reachable = Some(alive);
                        snapshot.last_checked_at = Some(now_iso8601());
                        snapshot.page_loaded = Some(page_loaded);
                        if alive && !page_loaded && snapshot.phase == ConnectionPhase::LoadingPage {
                            snapshot.detail = "等待远程页面加载".to_string();
                        }
                    });
                    if !alive {
                        inner.update(|snapshot| {
                            snapshot.phase = ConnectionPhase::Disconnected;
                            snapshot.detail = "连接已断开".to_string();
                            snapshot.error_code = Some(error_code::DISCONNECTED.to_string());
                            snapshot.page_loaded = Some(false);
                        });
                        // Avoid leaving a stale error page on screen.
                        let _ = inner.remote.navigate(inner.waiting_url.clone());
                        inner.failed_attempts.fetch_add(1, Ordering::SeqCst);
                        wait_before_retry = Some(retry_backoff(
                            inner
                                .failed_attempts
                                .load(Ordering::SeqCst)
                                .saturating_sub(1),
                        ));
                        break;
                    }
                }
            }
        }
    }
}
