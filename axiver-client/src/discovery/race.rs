//! Concurrent discovery. Only the connection owner selects/navigates a result.
use super::{
    CancelToken, DISCOVERY_TIMEOUT, Endpoint, TargetKind, WanError,
    mdns::{LanOutcome, discover_lan},
    resolve_wan,
    subnet::{probe_identity_address, scan_lan_subnets},
};
use mdns_sd::ServiceDaemon;
use serde::{Deserialize, Serialize};
use std::{
    net::Ipv4Addr,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use url::Url;

const LAN_HEAD_START: Duration = Duration::from_millis(250);

#[derive(Serialize, Deserialize)]
struct CachedLan {
    name: String,
    url: String,
    http_port: u16,
}

pub fn remember_lan(path: &Path, name: &str, endpoint: &Endpoint) {
    if endpoint.kind != TargetKind::Lan {
        return;
    }
    let Some(http_port) = endpoint.identity_port else {
        return;
    };
    let cached = CachedLan {
        name: name.to_string(),
        url: endpoint.url.to_string(),
        http_port,
    };
    if let Ok(json) = serde_json::to_vec(&cached) {
        let _ = std::fs::write(path, json);
    }
}

fn fast_candidates(cache_path: &Path, name: &str, wide_url: &str) -> Vec<(Ipv4Addr, u16, String)> {
    let mut candidates = Vec::new();
    if let Some(cached) = std::fs::read(cache_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CachedLan>(&bytes).ok())
    {
        if cached.name.eq_ignore_ascii_case(name) {
            if let Ok(url) = Url::parse(&cached.url) {
                if let Some(ip) = url
                    .host_str()
                    .and_then(|host| host.parse::<Ipv4Addr>().ok())
                    .filter(Ipv4Addr::is_private)
                {
                    // A cache is only a hint: always recheck service/name and ports.
                    candidates.push((ip, cached.http_port, url.path().to_string()));
                }
            }
        }
    }
    if let Ok(url) = Url::parse(wide_url) {
        if let Some(ip) = url
            .host_str()
            .and_then(|host| host.parse::<Ipv4Addr>().ok())
            .filter(Ipv4Addr::is_private)
        {
            let port = if url.scheme() == "http" {
                url.port_or_known_default().unwrap_or(3000)
            } else {
                3000
            };
            let hint = (ip, port, url.path().to_string());
            if !candidates.contains(&hint) {
                candidates.push(hint);
            }
        }
    }
    candidates
}

pub struct ProbeResult {
    pub source: &'static str,
    pub elapsed_ms: u128,
    pub endpoint: Result<Option<Endpoint>, String>,
}

pub struct DiscoveryRace {
    receiver: mpsc::Receiver<ProbeResult>,
    stop: Arc<AtomicBool>,
    remaining: usize,
    wan_ready: Option<(Instant, Endpoint)>,
}

impl Drop for DiscoveryRace {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl DiscoveryRace {
    pub fn start(
        mdns: Option<Arc<Mutex<ServiceDaemon>>>,
        name: &str,
        wide_url: &str,
        cache_path: &Path,
        cancel: &CancelToken,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let mut token = cancel.clone();
        token.stopped = Some(stop.clone());
        let (sender, receiver) = mpsc::channel();
        let mut remaining = 0;
        let mut spawn = |source,
                         job: Box<
            dyn FnOnce(CancelToken) -> Result<Option<Endpoint>, String> + Send,
        >| {
            remaining += 1;
            let tx = sender.clone();
            let token = token.clone();
            thread::spawn(move || {
                let started = Instant::now();
                let endpoint = job(token);
                let _ = tx.send(ProbeResult {
                    source,
                    elapsed_ms: started.elapsed().as_millis(),
                    endpoint,
                });
            });
        };
        // Start WAN first, without waiting for mDNS or a subnet timeout.
        if !wide_url.trim().is_empty() {
            let value = wide_url.to_string();
            spawn(
                "wan",
                Box::new(move |_| {
                    resolve_wan(&value).map(Some).map_err(|error| {
                        match error {
                            WanError::InvalidUrl => "广域地址格式无效",
                            WanError::DnsFailed => "广域地址 DNS 解析失败",
                            WanError::TcpUnreachable => "广域地址 TCP 不可达",
                        }
                        .to_string()
                    })
                }),
            );
        }
        for (ip, port, path) in fast_candidates(cache_path, name, wide_url) {
            let name = name.to_string();
            spawn(
                "lan_hint",
                Box::new(move |token| {
                    if token.is_stale(token.my_generation) {
                        return Ok(None);
                    }
                    Ok(probe_identity_address(ip, port, &path, &name))
                }),
            );
        }
        if let Some(daemon) = mdns {
            let name = name.to_string();
            spawn(
                "mdns",
                Box::new(move |token| {
                    // A retiring browser must stop before the next attempt starts
                    // browsing the same daemon/service. Other lanes never wait.
                    let daemon = loop {
                        if token.is_stale(token.my_generation) {
                            return Ok(None);
                        }
                        if let Ok(daemon) = daemon.try_lock() {
                            break daemon;
                        }
                        thread::sleep(Duration::from_millis(25));
                    };
                    match discover_lan(
                        &daemon,
                        &name,
                        DISCOVERY_TIMEOUT,
                        &token,
                        token.my_generation,
                        |_| {},
                    )? {
                        LanOutcome::Found(endpoint) => Ok(Some(endpoint)),
                        LanOutcome::MatchedButFailed(reason) => Err(reason),
                        _ => Ok(None),
                    }
                }),
            );
        }
        let name = name.to_string();
        spawn(
            "subnet",
            Box::new(move |token| Ok(scan_lan_subnets(&name, &token, token.my_generation).0)),
        );
        Self {
            receiver,
            stop,
            remaining,
            wan_ready: None,
        }
    }

    pub fn next(&mut self) -> Option<ProbeResult> {
        let result = self.receiver.recv_timeout(Duration::from_millis(25)).ok()?;
        self.remaining = self.remaining.saturating_sub(1);
        Some(result)
    }

    pub fn consider(&mut self, endpoint: Endpoint, now: Instant) -> Option<Endpoint> {
        if endpoint.kind == TargetKind::Lan {
            return Some(endpoint);
        }
        self.wan_ready = Some((now, endpoint));
        self.ready(now)
    }

    pub fn ready(&mut self, now: Instant) -> Option<Endpoint> {
        if self.wan_ready.as_ref().is_some_and(|(since, _)| {
            self.remaining == 0 || now.saturating_duration_since(*since) >= LAN_HEAD_START
        }) {
            return self.wan_ready.take().map(|(_, endpoint)| endpoint);
        }
        None
    }

    pub fn finished(&self) -> bool {
        self.remaining == 0 && self.wan_ready.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn endpoint(kind: TargetKind) -> Endpoint {
        Endpoint {
            url: Url::parse("http://127.0.0.1/").unwrap(),
            socket: "127.0.0.1:80".parse().unwrap(),
            kind,
            identity_port: None,
        }
    }
    #[test]
    fn lan_wins_and_wan_only_waits_a_bounded_grace() {
        let (_, receiver) = mpsc::channel();
        let mut race = DiscoveryRace {
            receiver,
            stop: Arc::new(AtomicBool::new(false)),
            remaining: 2,
            wan_ready: None,
        };
        let now = Instant::now();
        assert!(race.consider(endpoint(TargetKind::Wan), now).is_none());
        assert!(race.ready(now + Duration::from_millis(249)).is_none());
        assert_eq!(
            race.consider(endpoint(TargetKind::Lan), now).unwrap().kind,
            TargetKind::Lan
        );
        assert_eq!(
            race.ready(now + LAN_HEAD_START).unwrap().kind,
            TargetKind::Wan
        );
        race.remaining = 0;
        assert_eq!(
            race.consider(endpoint(TargetKind::Wan), now).unwrap().kind,
            TargetKind::Wan
        );
    }
}
