//! LAN subnet scan fallback (spec section 3.3).
//!
//! Known legacy limitation kept intact: the scan only probes the HTTP 3000
//! identity endpoint, so "supports custom advertised ports via mDNS" must
//! not be confused with "the fallback scan finds arbitrary HTTP ports".

use super::{
    CancelToken, Endpoint, SUBNET_MAX_NETWORKS, SUBNET_PROBE_TIMEOUT, SUBNET_SCAN_WORKERS,
    TargetKind, identity::fetch_lan_identity,
};
use if_addrs::IfAddr;
use std::{
    collections::{HashSet, VecDeque},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
};
use url::Url;

pub fn subnet_scan_candidates() -> Vec<Ipv4Addr> {
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
        let mask = u32::MAX.checked_shl(u32::from(32 - scan_prefix)).unwrap_or(0);
        let ip = u32::from(address.ip);
        networks.insert((ip & mask, scan_prefix, ip));
    }

    let mut networks = networks.into_iter().collect::<Vec<_>>();
    networks.sort_unstable();
    networks.truncate(SUBNET_MAX_NETWORKS);
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

pub fn probe_subnet_address(address: Ipv4Addr, expected_name: &str) -> Option<Endpoint> {
    let identity = fetch_lan_identity(
        address,
        super::identity::default_http_port(),
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

/// Concurrent scan with early stop. Returns `None` when nothing matched and
/// `Some(None)`... semantics: `(found, cancelled)`.
pub fn scan_lan_subnets(
    expected_name: &str,
    cancel: &CancelToken,
    current_generation: u64,
) -> (Option<Endpoint>, bool) {
    if cancel.is_stale(current_generation) {
        return (None, true);
    }
    let candidates = subnet_scan_candidates();
    if candidates.is_empty() {
        return (None, false);
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
    (result, cancel.is_stale(current_generation))
}
