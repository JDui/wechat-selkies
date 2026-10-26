//! LAN discovery: mDNS browsing, HTTP identity endpoint and the subnet scan
//! fallback. Protocol constants and timings are preserved from the legacy
//! client (spec section 3) — see `contract_discovery` integration tests.

pub mod identity;
pub mod mdns;
pub mod subnet;

use serde::{Deserialize, Serialize};
use std::{
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use url::Url;

pub const SERVICE_TYPE: &str = "_axisnsbox._tcp.local.";
pub const SERVICE_ID: &str = "wechat-selkies";
pub const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(4);
pub const PROBE_INTERVAL: Duration = Duration::from_secs(8);
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(1800);
pub const SUBNET_PROBE_TIMEOUT: Duration = Duration::from_millis(280);
pub const SUBNET_SCAN_WORKERS: usize = 32;
pub const SUBNET_MAX_NETWORKS: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    None,
    Lan,
    Wan,
}

#[derive(Clone, Debug)]
pub struct Endpoint {
    pub url: Url,
    pub socket: SocketAddr,
    pub kind: TargetKind,
}

/// Token used by every discovery stage to drop stale work when a newer
/// generation has started (spec section 5.3: single owner + cancellation).
/// With `live` wired to the connection worker's counter, a queued user
/// command (reconnect / force WAN) aborts long probes *mid-scan* instead of
/// only at stage boundaries; `current_generation` stays as the fallback
/// source for unit tests.
#[derive(Clone, Debug)]
pub struct CancelToken {
    pub my_generation: u64,
    pub live: Option<Arc<AtomicU64>>,
}

impl CancelToken {
    pub fn is_stale(&self, current_generation: u64) -> bool {
        match &self.live {
            Some(live) => live.load(Ordering::SeqCst) != self.my_generation,
            None => current_generation != self.my_generation,
        }
    }
}

pub enum WanError {
    InvalidUrl,
    DnsFailed,
    TcpUnreachable,
}

/// Resolve and TCP-probe the configured WAN URL (DNS + connect within
/// PROBE_TIMEOUT, legacy semantics).
pub fn resolve_wan(value: &str) -> Result<Endpoint, WanError> {
    let url = Url::parse(value).map_err(|_| WanError::InvalidUrl)?;
    let host = url.host_str().ok_or(WanError::InvalidUrl)?;
    let port = url.port_or_known_default().ok_or(WanError::InvalidUrl)?;
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|_| WanError::DnsFailed)?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(WanError::DnsFailed);
    }
    addresses
        .into_iter()
        .find(|address| TcpStream::connect_timeout(address, PROBE_TIMEOUT).is_ok())
        .map(|socket| Endpoint {
            url,
            socket,
            kind: TargetKind::Wan,
        })
        .ok_or(WanError::TcpUnreachable)
}

pub fn endpoint_is_alive(endpoint: &Endpoint) -> bool {
    TcpStream::connect_timeout(&endpoint.socket, PROBE_TIMEOUT).is_ok()
}
