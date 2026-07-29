#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use if_addrs::IfAddr;
use mdns_sd::{ServiceDaemon, ServiceEvent};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    Manager, WebviewUrl, WebviewWindow,
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewWindowBuilder},
};
use url::Url;

const DEFAULT_BROADCAST_NAME: &str = "AXISNSBOX-000";
const SERVICE_TYPE: &str = "_axisnsbox._tcp.local.";
const SERVICE_ID: &str = "wechat-selkies";
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(4);
const PROBE_INTERVAL: Duration = Duration::from_secs(8);
const PROBE_TIMEOUT: Duration = Duration::from_millis(1800);
const SUBNET_PROBE_TIMEOUT: Duration = Duration::from_millis(280);
const SUBNET_SCAN_WORKERS: usize = 32;
const IGNORE_CERTIFICATE_ERRORS_FLAG: &str = "--ignore-certificate-errors";
const NATIVE_HOST: &str = "axiver-client.invalid";
const APP_TITLE: &str = "AXIVER Client";
const UPLOADER_PATH_SUFFIX: &str = "/uploader/";
static POPUP_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    broadcast_name: String,
    wide_url: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
struct OverlayPosition {
    left: f64,
    top: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TargetKind {
    None,
    Lan,
    Wan,
}

#[derive(Clone, Debug)]
struct Endpoint {
    url: Url,
    socket: SocketAddr,
    kind: TargetKind,
}

#[derive(Clone, Debug, Deserialize)]
struct LanIdentity {
    service: String,
    name: String,
    #[serde(default = "default_lan_scheme")]
    scheme: String,
    #[serde(default = "default_lan_path")]
    path: String,
    #[serde(default = "default_http_port")]
    http_port: u16,
    #[serde(default = "default_https_port")]
    https_port: u16,
}

fn default_lan_scheme() -> String {
    "https".to_string()
}

fn default_lan_path() -> String {
    "/".to_string()
}

fn default_http_port() -> u16 {
    3000
}

fn default_https_port() -> u16 {
    3001
}

fn webview_browser_arguments(existing: &str) -> String {
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
fn configure_webview_certificate_policy() {
    let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    let arguments = webview_browser_arguments(&existing);
    // SAFETY: This runs before Tauri or WebView2 creates any threads. The
    // environment change is process-local and inherited only by WebView2.
    unsafe {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", arguments);
    }
}

#[cfg(not(target_os = "windows"))]
fn configure_webview_certificate_policy() {}

#[derive(Clone, Debug)]
enum ControlMessage {
    Reconnect,
}

fn portable_root() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn initialize_database(path: &Path) -> Result<Settings, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );
            ",
        )
        .map_err(|error| error.to_string())?;

    connection
        .execute(
            "INSERT OR IGNORE INTO settings(key, value) VALUES (?1, ?2)",
            params!["broadcast_name", DEFAULT_BROADCAST_NAME],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT OR IGNORE INTO settings(key, value) VALUES (?1, ?2)",
            params!["wide_url", ""],
        )
        .map_err(|error| error.to_string())?;

    let broadcast_name = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'broadcast_name'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .and_then(|value| normalize_broadcast_name(&value).ok())
        .unwrap_or_else(|| DEFAULT_BROADCAST_NAME.to_string());

    let wide_url = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'wide_url'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .and_then(|value| normalize_wide_url(&value).ok())
        .unwrap_or_default();

    Ok(Settings {
        broadcast_name,
        wide_url,
    })
}

fn save_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO settings(key, value) VALUES ('broadcast_name', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![settings.broadcast_name],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO settings(key, value) VALUES ('wide_url', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![settings.wide_url],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn normalize_broadcast_name(value: &str) -> Result<String, String> {
    let candidate = value.trim().to_ascii_uppercase();
    if candidate.is_empty() || candidate.len() > 32 {
        return Err("广播名长度必须为 1–32 位".to_string());
    }
    let mut characters = candidate.chars();
    if !characters
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric())
    {
        return Err("广播名必须以字母或数字开头".to_string());
    }
    if !candidate
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err("广播名只能包含字母、数字、下划线和连字符".to_string());
    }
    Ok(candidate)
}

fn normalize_wide_url(value: &str) -> Result<String, String> {
    let candidate = value.trim();
    if candidate.is_empty() {
        return Ok(String::new());
    }
    let parsed = Url::parse(candidate).map_err(|_| "广域地址格式无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("广域地址必须是完整的 HTTP 或 HTTPS 地址".to_string());
    }
    Ok(parsed.to_string())
}

fn http_origin(url: &Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

fn is_internal_uploader_url(url: &Url, current_origin: Option<&str>) -> bool {
    current_origin.is_some_and(|origin| http_origin(url).as_deref() == Some(origin))
        && format!("{}/", url.path().trim_end_matches('/')).ends_with(UPLOADER_PATH_SUFFIX)
}

fn fallback_download_name(url: &Url) -> String {
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

fn ensure_download_destination(download_dir: Option<&Path>, url: &Url, destination: &mut PathBuf) {
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

#[cfg(target_os = "windows")]
fn open_in_default_browser(url: &Url) -> bool {
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
fn open_in_default_browser(_url: &Url) -> bool {
    false
}

fn is_external_browser_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

fn script_for(settings: &Settings) -> String {
    let bootstrap = serde_json::to_string(settings)
        .unwrap_or_else(|_| r#"{"broadcastName":"AXISNSBOX-000","wideUrl":""}"#.to_string());
    let script = include_str!("../ui/injected.js")
        .replace(
            "__AXIVER_ICON_REFRESH__",
            &format!(
                "data:image/svg+xml;base64,{}",
                BASE64.encode(include_bytes!("../ui/icons/refresh.svg"))
            ),
        )
        .replace(
            "__AXIVER_ICON_ROUTER__",
            &format!(
                "data:image/svg+xml;base64,{}",
                BASE64.encode(include_bytes!("../ui/icons/router.svg"))
            ),
        )
        .replace(
            "__AXIVER_ICON_GLOBE__",
            &format!(
                "data:image/svg+xml;base64,{}",
                BASE64.encode(include_bytes!("../ui/icons/globe.svg"))
            ),
        );
    format!("window.__AXIVER_BOOTSTRAP__ = {bootstrap};\n{}", script)
}

fn set_status(window: &WebviewWindow, state: &str, detail: &str, url: Option<&Url>) {
    let payload = serde_json::json!({
        "state": state,
        "detail": detail,
        "url": url.map(Url::as_str).unwrap_or_default(),
    });
    let _ = window.eval(format!(
        "window.__AXIVER_CLIENT__ && window.__AXIVER_CLIENT__.setStatus({});",
        payload
    ));
}

fn sync_settings(window: &WebviewWindow, settings: &Settings) {
    if let Ok(payload) = serde_json::to_string(settings) {
        let _ = window.eval(format!(
            "window.__AXIVER_CLIENT__ && window.__AXIVER_CLIENT__.syncSettings({payload});"
        ));
    }
}

fn sync_overlay_position(window: &WebviewWindow, position: Option<OverlayPosition>) {
    let Some(position) = position else {
        return;
    };
    if let Ok(payload) = serde_json::to_string(&position) {
        let _ = window.eval(format!(
            "window.__AXIVER_CLIENT__ && window.__AXIVER_CLIENT__.setPosition({payload});"
        ));
    }
}

fn is_native_action(url: &Url) -> bool {
    url.host_str() == Some(NATIVE_HOST) && url.path().starts_with("/__native/")
}

fn handle_native_action(
    url: &Url,
    settings: &Arc<Mutex<Settings>>,
    overlay_position: &Arc<Mutex<Option<OverlayPosition>>>,
    database_path: &Path,
    control_tx: &Sender<ControlMessage>,
) {
    if url.path() == "/__native/reconnect" {
        let _ = control_tx.send(ControlMessage::Reconnect);
        return;
    }
    if url.path() == "/__native/position" {
        let mut left = None;
        let mut top = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "left" => left = value.parse::<f64>().ok(),
                "top" => top = value.parse::<f64>().ok(),
                _ => {}
            }
        }
        if let (Some(left), Some(top)) = (left, top) {
            if left.is_finite() && top.is_finite() {
                if let Ok(mut guard) = overlay_position.lock() {
                    *guard = Some(OverlayPosition { left, top });
                }
            }
        }
        return;
    }
    if url.path() != "/__native/settings" {
        return;
    }

    let mut broadcast_name = None;
    let mut wide_url = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "broadcast" => broadcast_name = Some(value.into_owned()),
            "wide" => wide_url = Some(value.into_owned()),
            _ => {}
        }
    }

    let current = settings
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or(Settings {
            broadcast_name: DEFAULT_BROADCAST_NAME.to_string(),
            wide_url: String::new(),
        });
    let next = Settings {
        broadcast_name: broadcast_name
            .as_deref()
            .and_then(|value| normalize_broadcast_name(value).ok())
            .unwrap_or_else(|| current.broadcast_name.clone()),
        wide_url: wide_url
            .as_deref()
            .and_then(|value| normalize_wide_url(value).ok())
            .unwrap_or_else(|| current.wide_url.clone()),
    };
    let reconnect = next != current;

    if save_settings(database_path, &next).is_ok() {
        if let Ok(mut guard) = settings.lock() {
            *guard = next;
        }
        if reconnect {
            let _ = control_tx.send(ControlMessage::Reconnect);
        }
    }
}

fn identity_path(path: &str) -> String {
    let normalized = if path.is_empty() { "/" } else { path };
    format!(
        "{}.well-known/axisnsbox",
        if normalized.ends_with('/') {
            normalized.to_string()
        } else {
            format!("{normalized}/")
        }
    )
}

fn decode_chunked_body(body: &str) -> Option<String> {
    let mut remaining = body;
    let mut decoded = String::new();
    loop {
        let (size_line, after_size) = remaining.split_once("\r\n")?;
        let size = usize::from_str_radix(size_line.split(';').next()?.trim(), 16).ok()?;
        if size == 0 {
            return Some(decoded);
        }
        if after_size.len() < size + 2 {
            return None;
        }
        decoded.push_str(after_size.get(..size)?);
        remaining = after_size.get(size + 2..)?;
    }
}

fn parse_identity_response(response: &str, expected_name: &str) -> Option<LanIdentity> {
    let (headers, raw_body) = response.split_once("\r\n\r\n")?;
    if !headers
        .lines()
        .next()
        .is_some_and(|line| line.contains(" 200 "))
    {
        return None;
    }
    let body = if headers.lines().any(|line| {
        line.eq_ignore_ascii_case("transfer-encoding: chunked")
            || line
                .to_ascii_lowercase()
                .starts_with("transfer-encoding: chunked")
    }) {
        decode_chunked_body(raw_body)?
    } else {
        raw_body.to_string()
    };
    let identity = serde_json::from_str::<LanIdentity>(body.trim()).ok()?;
    if identity.service == SERVICE_ID && identity.name.eq_ignore_ascii_case(expected_name) {
        Some(identity)
    } else {
        None
    }
}

fn fetch_lan_identity(
    address: Ipv4Addr,
    port: u16,
    path: &str,
    expected_name: &str,
    timeout: Duration,
) -> Option<LanIdentity> {
    let socket = SocketAddr::new(IpAddr::V4(address), port);
    let mut stream = TcpStream::connect_timeout(&socket, timeout).ok()?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request_path = identity_path(path);
    let request = format!(
        "GET {request_path} HTTP/1.1\r\nHost: {address}:{port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return None;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return None;
    }
    parse_identity_response(&response, expected_name)
}

fn advertised_lan_target(
    scheme: Option<&str>,
    http_port: u16,
    https_port: Option<u16>,
    service_port: u16,
) -> (&'static str, u16) {
    if scheme == Some("http") {
        ("http", http_port)
    } else {
        ("https", https_port.unwrap_or(service_port))
    }
}

fn discover_lan(
    daemon: &ServiceDaemon,
    window: &WebviewWindow,
    expected_name: &str,
    timeout: Duration,
) -> Result<Option<Endpoint>, String> {
    let receiver = daemon
        .browse(SERVICE_TYPE)
        .map_err(|error| format!("mDNS 嗅探启动失败：{error}"))?;
    let deadline = Instant::now() + timeout;
    let mut result = None;
    let mut matched_broadcast = false;
    let mut rejection_reason = None;

    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let wait = remaining.min(Duration::from_millis(300));
        match receiver.recv_timeout(wait) {
            Ok(ServiceEvent::ServiceFound(_, fullname)) => {
                let instance_name = fullname.split('.').next().unwrap_or_default();
                if instance_name.eq_ignore_ascii_case(expected_name) {
                    matched_broadcast = true;
                    set_status(
                        window,
                        "connecting_lan",
                        &format!("已发现 {expected_name}，正在解析地址"),
                        None,
                    );
                }
            }
            Ok(ServiceEvent::ServiceResolved(service)) => {
                let advertised_name = service.get_property_val_str("name").unwrap_or_else(|| {
                    service.get_fullname().split('.').next().unwrap_or_default()
                });
                if !advertised_name.eq_ignore_ascii_case(expected_name) {
                    continue;
                }
                matched_broadcast = true;
                set_status(
                    window,
                    "connecting_lan",
                    &format!("已发现 {advertised_name}，正在验证连接"),
                    None,
                );

                if service.get_property_val_str("service") != Some(SERVICE_ID) {
                    rejection_reason = Some("广播身份字段不匹配".to_string());
                    continue;
                }
                let http_port = service
                    .get_property_val_str("http_port")
                    .and_then(|value| value.parse::<u16>().ok())
                    .unwrap_or(3000);
                let https_port = service
                    .get_property_val_str("https_port")
                    .and_then(|value| value.parse::<u16>().ok());
                let path = service.get_property_val_str("path").unwrap_or("/");
                for address in service.get_addresses_v4() {
                    if address.is_unspecified() || address.is_loopback() || address.is_link_local()
                    {
                        continue;
                    }
                    let (scheme, target_port) = advertised_lan_target(
                        service.get_property_val_str("scheme"),
                        http_port,
                        https_port,
                        service.get_port(),
                    );
                    let target_socket = SocketAddr::new(IpAddr::V4(address), target_port);
                    if TcpStream::connect_timeout(&target_socket, PROBE_TIMEOUT).is_err() {
                        rejection_reason =
                            Some(format!("已发现广播，但 {address}:{target_port} 不可达"));
                        continue;
                    }

                    // The HTTP identity endpoint is preferred when exposed. Some
                    // deployments publish only the advertised HTTPS port; in
                    // that case the service/name TXT identity plus a successful
                    // target-port probe is sufficient to continue.
                    let _identity =
                        fetch_lan_identity(address, http_port, path, expected_name, PROBE_TIMEOUT);
                    let normalized_path = if path.starts_with('/') {
                        path.to_string()
                    } else {
                        format!("/{path}")
                    };
                    let url = Url::parse(&format!(
                        "{scheme}://{address}:{target_port}{normalized_path}"
                    ))
                    .map_err(|error| format!("局域网地址无效：{error}"))?;
                    result = Some(Endpoint {
                        url,
                        socket: target_socket,
                        kind: TargetKind::Lan,
                    });
                    break;
                }
                if result.is_some() {
                    break;
                }
            }
            Ok(_) => {}
            Err(_) => {}
        }
    }

    let _ = daemon.stop_browse(SERVICE_TYPE);
    if result.is_some() {
        Ok(result)
    } else if matched_broadcast {
        Err(rejection_reason.unwrap_or_else(|| "已发现广播，但没有可用的 IPv4 地址".to_string()))
    } else {
        Ok(None)
    }
}

fn subnet_scan_candidates() -> Vec<Ipv4Addr> {
    let mut networks = HashSet::new();
    for interface in if_addrs::get_if_addrs().unwrap_or_default() {
        if !interface.is_oper_up() || interface.is_p2p() {
            continue;
        }
        let IfAddr::V4(address) = interface.addr else {
            continue;
        };
        if !address.ip.is_private()
            || address.ip.is_loopback()
            || address.ip.is_link_local()
            || address.prefixlen > 30
        {
            continue;
        }
        let scan_prefix = address.prefixlen.max(24);
        let mask = u32::MAX
            .checked_shl(u32::from(32 - scan_prefix))
            .unwrap_or(0);
        let ip = u32::from(address.ip);
        networks.insert((ip & mask, scan_prefix, ip));
    }

    let mut networks = networks.into_iter().collect::<Vec<_>>();
    networks.sort_unstable();
    networks.truncate(4);
    let mut candidates = Vec::new();
    for (network, prefix, local_ip) in networks {
        let host_count = 1_u32 << u32::from(32 - prefix);
        let broadcast = network + host_count - 1;
        for candidate in (network + 1)..broadcast {
            if candidate != local_ip {
                candidates.push(Ipv4Addr::from(candidate));
            }
        }
    }
    candidates
}

fn probe_subnet_address(address: Ipv4Addr, expected_name: &str) -> Option<Endpoint> {
    let identity = fetch_lan_identity(
        address,
        default_http_port(),
        "/",
        expected_name,
        SUBNET_PROBE_TIMEOUT,
    )?;
    let scheme = if identity.scheme.eq_ignore_ascii_case("http") {
        "http"
    } else {
        "https"
    };
    let target_port = if scheme == "http" {
        identity.http_port
    } else {
        identity.https_port
    };
    let socket = SocketAddr::new(IpAddr::V4(address), target_port);
    if TcpStream::connect_timeout(&socket, SUBNET_PROBE_TIMEOUT).is_err() {
        return None;
    }
    let path = if identity.path.starts_with('/') {
        identity.path
    } else {
        format!("/{}", identity.path)
    };
    let url = Url::parse(&format!("{scheme}://{address}:{target_port}{path}")).ok()?;
    Some(Endpoint {
        url,
        socket,
        kind: TargetKind::Lan,
    })
}

fn scan_lan_subnets(expected_name: &str) -> Option<Endpoint> {
    let candidates = subnet_scan_candidates();
    if candidates.is_empty() {
        return None;
    }
    let worker_count = SUBNET_SCAN_WORKERS.min(candidates.len());
    let queue = Arc::new(Mutex::new(VecDeque::from(candidates)));
    let stop = Arc::new(AtomicBool::new(false));
    let (result_tx, result_rx) = mpsc::channel();
    let mut workers = Vec::with_capacity(worker_count);

    for _ in 0..worker_count {
        let queue = queue.clone();
        let stop = stop.clone();
        let result_tx = result_tx.clone();
        let expected_name = expected_name.to_string();
        workers.push(thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let address = queue.lock().ok().and_then(|mut queue| queue.pop_front());
                let Some(address) = address else {
                    break;
                };
                if let Some(endpoint) = probe_subnet_address(address, &expected_name) {
                    if !stop.swap(true, Ordering::Relaxed) {
                        let _ = result_tx.send(endpoint);
                    }
                    break;
                }
            }
        }));
    }
    drop(result_tx);
    let result = result_rx.recv().ok();
    stop.store(true, Ordering::Relaxed);
    for worker in workers {
        let _ = worker.join();
    }
    result
}

fn resolve_wan(value: &str) -> Option<Endpoint> {
    let url = Url::parse(value).ok()?;
    let host = url.host_str()?;
    let port = url.port_or_known_default()?;
    let socket = (host, port)
        .to_socket_addrs()
        .ok()?
        .find(|address| TcpStream::connect_timeout(address, PROBE_TIMEOUT).is_ok())?;
    Some(Endpoint {
        url,
        socket,
        kind: TargetKind::Wan,
    })
}

fn endpoint_is_alive(endpoint: &Endpoint) -> bool {
    TcpStream::connect_timeout(&endpoint.socket, PROBE_TIMEOUT).is_ok()
}

fn navigate_to(window: &WebviewWindow, endpoint: &Endpoint) -> bool {
    window.navigate(endpoint.url.clone()).is_ok()
}

fn connection_worker(
    window: WebviewWindow,
    settings: Arc<Mutex<Settings>>,
    active_target: Arc<Mutex<TargetKind>>,
    control_rx: Receiver<ControlMessage>,
) {
    thread::spawn(move || {
        let (mdns, mdns_error) = match ServiceDaemon::new() {
            Ok(daemon) => (Some(daemon), None),
            Err(error) => (None, Some(format!("mDNS 初始化失败：{error}"))),
        };
        loop {
            let current = settings
                .lock()
                .map(|guard| guard.clone())
                .unwrap_or(Settings {
                    broadcast_name: DEFAULT_BROADCAST_NAME.to_string(),
                    wide_url: String::new(),
                });
            if let Ok(mut guard) = active_target.lock() {
                *guard = TargetKind::None;
            }

            set_status(
                &window,
                "discovering_lan",
                &format!("正在嗅探 {}", current.broadcast_name),
                None,
            );
            let discovery = match mdns.as_ref() {
                Some(daemon) => {
                    discover_lan(daemon, &window, &current.broadcast_name, DISCOVERY_TIMEOUT)
                }
                None => Err(mdns_error
                    .clone()
                    .unwrap_or_else(|| "mDNS 初始化失败".to_string())),
            };
            let mut discovery_error = None;
            let mut endpoint = match discovery {
                Ok(endpoint) => endpoint,
                Err(error) => {
                    discovery_error = Some(error);
                    None
                }
            };

            if endpoint.is_none() {
                set_status(
                    &window,
                    "discovering_lan",
                    &format!("mDNS 未响应，正在扫描同网段 {}", current.broadcast_name),
                    None,
                );
                endpoint = scan_lan_subnets(&current.broadcast_name);
                if endpoint.is_some() {
                    discovery_error = None;
                }
            }

            if endpoint.is_none() && !current.wide_url.is_empty() {
                set_status(&window, "connecting_wan", "正在连接广域地址", None);
                endpoint = resolve_wan(&current.wide_url);
            }

            let Some(endpoint) = endpoint else {
                let detail = discovery_error
                    .as_deref()
                    .unwrap_or("mDNS 与同网段扫描均未找到匹配项目");
                set_status(&window, "disconnected", detail, None);
                match control_rx.recv_timeout(Duration::from_secs(5)) {
                    Ok(ControlMessage::Reconnect) | Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            };

            let connecting_state = if endpoint.kind == TargetKind::Lan {
                "connecting_lan"
            } else {
                "connecting_wan"
            };
            let connecting_detail = if endpoint.kind == TargetKind::Lan {
                "正在连接局域网容器"
            } else {
                "正在连接广域地址"
            };
            set_status(
                &window,
                connecting_state,
                connecting_detail,
                Some(&endpoint.url),
            );
            if let Ok(mut guard) = active_target.lock() {
                *guard = endpoint.kind;
            }
            if !navigate_to(&window, &endpoint) {
                set_status(&window, "disconnected", "页面打开失败", None);
                thread::sleep(Duration::from_secs(2));
                continue;
            }

            loop {
                match control_rx.recv_timeout(PROBE_INTERVAL) {
                    Ok(ControlMessage::Reconnect) => break,
                    Err(RecvTimeoutError::Timeout) => {
                        if !endpoint_is_alive(&endpoint) {
                            set_status(&window, "disconnected", "连接已断开", None);
                            thread::sleep(Duration::from_secs(1));
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        }
    });
}

fn main() {
    configure_webview_certificate_policy();
    let root = portable_root();
    let database_path = root.join("axiver-client.db");
    let webview_data_path = root.join("axiver-client-data");
    let _ = fs::create_dir_all(&webview_data_path);

    let initial_settings = initialize_database(&database_path).unwrap_or(Settings {
        broadcast_name: DEFAULT_BROADCAST_NAME.to_string(),
        wide_url: String::new(),
    });
    let settings = Arc::new(Mutex::new(initial_settings.clone()));
    let overlay_position = Arc::new(Mutex::new(None::<OverlayPosition>));
    let active_target = Arc::new(Mutex::new(TargetKind::None));
    let current_page_origin = Arc::new(Mutex::new(None::<String>));
    let (control_tx, control_rx) = mpsc::channel::<ControlMessage>();

    let setup_settings = settings.clone();
    let setup_overlay_position = overlay_position.clone();
    let setup_active_target = active_target.clone();
    let setup_current_page_origin = current_page_origin.clone();
    let setup_database_path = Arc::new(database_path);
    let setup_control_tx = control_tx.clone();
    let init_script = script_for(&initial_settings);

    tauri::Builder::default()
        .setup(move |app| {
            let navigation_settings = setup_settings.clone();
            let navigation_overlay_position = setup_overlay_position.clone();
            let navigation_database_path = setup_database_path.clone();
            let navigation_control_tx = setup_control_tx.clone();
            let navigation_page_origin = setup_current_page_origin.clone();
            let page_settings = setup_settings.clone();
            let page_overlay_position = setup_overlay_position.clone();
            let page_active_target = setup_active_target.clone();
            let popup_app = app.handle().clone();
            let popup_page_origin = setup_current_page_origin.clone();

            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title(APP_TITLE)
                    .inner_size(1280.0, 820.0)
                    .min_inner_size(820.0, 560.0)
                    .center()
                    .data_directory(webview_data_path.clone())
                    .initialization_script(init_script.clone())
                    .enable_clipboard_access()
                    .disable_drag_drop_handler()
                    .zoom_hotkeys_enabled(true)
                    .on_document_title_changed(|window, document_title| {
                        let title = if document_title.trim().is_empty() {
                            APP_TITLE
                        } else {
                            document_title.trim()
                        };
                        let _ = window.set_title(title);
                    })
                    .on_navigation(move |url| {
                        if is_native_action(url) {
                            handle_native_action(
                                url,
                                &navigation_settings,
                                &navigation_overlay_position,
                                navigation_database_path.as_ref(),
                                &navigation_control_tx,
                            );
                            return false;
                        }
                        let allowed = matches!(url.scheme(), "http" | "https" | "tauri" | "about");
                        if allowed
                            && let Some(origin) = http_origin(url)
                            && let Ok(mut guard) = navigation_page_origin.lock()
                        {
                            *guard = Some(origin);
                        }
                        allowed
                    })
                    .on_new_window(move |url, features| {
                        let current_origin = popup_page_origin
                            .lock()
                            .ok()
                            .and_then(|guard| guard.clone());
                        if is_internal_uploader_url(&url, current_origin.as_deref()) {
                            let uploader_origin = http_origin(&url).unwrap_or_default();
                            let popup_label = format!(
                                "selkies-uploader-{}",
                                POPUP_COUNTER.fetch_add(1, Ordering::Relaxed)
                            );
                            let builder = WebviewWindowBuilder::new(
                                &popup_app,
                                popup_label,
                                WebviewUrl::External(
                                    "about:blank".parse().expect("about:blank is a valid URL"),
                                ),
                            )
                            .title("AXIVER 文件上传")
                            .window_features(features)
                            .enable_clipboard_access()
                            .disable_drag_drop_handler()
                            .on_navigation(move |candidate| {
                                candidate.scheme() == "about"
                                    || http_origin(candidate).as_deref()
                                        == Some(uploader_origin.as_str())
                            });
                            return match builder.build() {
                                Ok(window) => NewWindowResponse::Create { window },
                                Err(_) => NewWindowResponse::Allow,
                            };
                        }

                        if open_in_default_browser(&url) {
                            NewWindowResponse::Deny
                        } else {
                            NewWindowResponse::Allow
                        }
                    })
                    .on_download(|webview, event| {
                        if let DownloadEvent::Requested { url, destination } = event {
                            let download_dir = webview.app_handle().path().download_dir().ok();
                            ensure_download_destination(download_dir.as_deref(), &url, destination);
                        }
                        true
                    })
                    .on_page_load(move |window, payload| {
                        if payload.event() != PageLoadEvent::Finished {
                            return;
                        }
                        if let Ok(guard) = page_settings.lock() {
                            sync_settings(&window, &guard);
                        }
                        if let Ok(guard) = page_overlay_position.lock() {
                            sync_overlay_position(&window, *guard);
                        }
                        let target = page_active_target
                            .lock()
                            .map(|guard| *guard)
                            .unwrap_or(TargetKind::None);
                        match target {
                            TargetKind::Lan => {
                                set_status(&window, "lan", "当前连接：局域网", Some(payload.url()))
                            }
                            TargetKind::Wan => set_status(
                                &window,
                                "wan",
                                "当前连接：广域地址",
                                Some(payload.url()),
                            ),
                            TargetKind::None => {}
                        }
                    })
                    .build()?;

            connection_worker(
                window,
                setup_settings.clone(),
                setup_active_target.clone(),
                control_rx,
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("AXIVER Client failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broadcast_name_is_uppercased_and_constrained() {
        assert_eq!(
            normalize_broadcast_name(" axisnsbox-123 ").unwrap(),
            "AXISNSBOX-123"
        );
        assert!(normalize_broadcast_name("bad name").is_err());
        assert!(normalize_broadcast_name("_bad").is_err());
    }

    #[test]
    fn wide_url_requires_http_or_https() {
        assert_eq!(normalize_wide_url("").unwrap(), "");
        assert!(normalize_wide_url("https://example.com/path").is_ok());
        assert!(normalize_wide_url("file:///c:/secret").is_err());
    }

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

    #[test]
    fn identity_endpoint_respects_subfolder() {
        assert_eq!(identity_path("/"), "/.well-known/axisnsbox");
        assert_eq!(identity_path("/wechat/"), "/wechat/.well-known/axisnsbox");
    }

    #[test]
    fn lan_target_follows_advertised_https_port() {
        assert_eq!(
            advertised_lan_target(Some("https"), 3000, Some(9443), 3001),
            ("https", 9443)
        );
        assert_eq!(
            advertised_lan_target(None, 3000, None, 3001),
            ("https", 3001)
        );
        assert_eq!(
            advertised_lan_target(Some("http"), 8080, Some(9443), 3001),
            ("http", 8080)
        );
    }

    #[test]
    fn identity_response_matches_axiver_payload() {
        let response = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: application/json\r\n",
            "Connection: close\r\n\r\n",
            r#"{"ok":true,"service":"wechat-selkies","name":"AXISNSBOX-000","#,
            r#""scheme":"https","path":"/","http_port":3000,"https_port":3001}"#
        );
        let identity = parse_identity_response(response, "AXISNSBOX-000").unwrap();
        assert_eq!(identity.scheme, "https");
        assert_eq!(identity.https_port, 3001);
        assert!(parse_identity_response(response, "AXISNSBOX-999").is_none());
    }

    #[test]
    fn wide_url_round_trips_through_sqlite() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("axiver-client-settings-{unique}.db"));
        let mut settings = initialize_database(&path).unwrap();
        settings.wide_url = normalize_wide_url("https://wide.example.test/path").unwrap();
        save_settings(&path, &settings).unwrap();
        let reloaded = initialize_database(&path).unwrap();
        assert_eq!(reloaded.wide_url, "https://wide.example.test/path");
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", path.display()));
        }
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
    fn drawer_inputs_stay_visible_to_page_input_guards() {
        let script = include_str!("../ui/injected.js");
        assert!(script.contains(r#"<slot name="broadcast-input"></slot>"#));
        assert!(script.contains(r#"<slot name="wide-input"></slot>"#));
        assert!(script.contains("host.append(broadcastInput, wideInput)"));
        assert!(script.contains(r#"className = "allow-native-input""#));
        assert!(script.contains("document.activeElement === wideInput"));
        assert!(!script.contains(r##"shell.querySelector("#axiver-wide")"##));
    }

    #[test]
    fn webview_guard_preserves_chinese_ime_composition_until_commit() {
        let script = include_str!("../ui/injected.js");
        assert!(script.contains("__selkiesCompositionGuardInstalled"));
        assert!(script.contains(r#""compositionstart""#));
        assert!(script.contains("event.isComposing"));
        assert!(script.contains("event.stopImmediatePropagation()"));
        assert!(script.contains(r#""compositionend""#));
        assert!(script.contains(r#"String(event.data || "")"#));
        assert!(script.contains("if (finalInputSeen) return"));
        assert!(script.contains("input._typeString(value)"));
    }
}
