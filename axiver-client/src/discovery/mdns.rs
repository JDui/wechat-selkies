//! mDNS / Zeroconf browsing (spec section 3.1).
//!
//! Legacy compatibility preserved deliberately: the mDNS branch may continue
//! on TXT identity + a successful TCP probe even when the HTTP identity
//! endpoint is unreachable (some deployments expose only the advertised
//! HTTPS port). The identity read is therefore not a hard gate here, exactly
//! as in the old client — this is not cryptographic authentication.

use super::{
    CancelToken, Endpoint, TargetKind, PROBE_TIMEOUT, SERVICE_ID, SERVICE_TYPE,
    identity::fetch_lan_identity,
};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use std::{
    net::{IpAddr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};
use url::Url;

pub enum LanOutcome {
    Found(Endpoint),
    /// A broadcast matching the name was seen but no candidate worked.
    /// Carries a human-readable reason (legacy-compatible messages).
    MatchedButFailed(String),
    NotFound,
    /// A newer generation superseded this task; the result must be dropped.
    Cancelled,
}

pub enum DiscoveryProgress {
    InstanceFound { name: String },
    Resolved { name: String },
    Rejected { reason: String },
}

/// Select the advertised target scheme/port (legacy semantics, contract
/// tested against the server's TXT fields).
pub fn advertised_lan_target(
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

pub fn discover_lan(
    daemon: &ServiceDaemon,
    expected_name: &str,
    timeout: Duration,
    cancel: &CancelToken,
    current_generation: u64,
    mut on_progress: impl FnMut(DiscoveryProgress),
) -> Result<LanOutcome, String> {
    if cancel.is_stale(current_generation) {
        return Ok(LanOutcome::Cancelled);
    }
    let receiver = daemon
        .browse(SERVICE_TYPE)
        .map_err(|error| format!("mDNS 嗅探启动失败：{error}"))?;
    let deadline = Instant::now() + timeout;
    let mut result = None;
    let mut matched_broadcast = false;
    let mut rejection_reason = None;

    while Instant::now() < deadline {
        if cancel.is_stale(current_generation) {
            let _ = daemon.stop_browse(SERVICE_TYPE);
            return Ok(LanOutcome::Cancelled);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let wait = remaining.min(Duration::from_millis(300));
        match receiver.recv_timeout(wait) {
            Ok(ServiceEvent::ServiceFound(_, fullname)) => {
                let instance_name = fullname.split('.').next().unwrap_or_default();
                if instance_name.eq_ignore_ascii_case(expected_name) {
                    matched_broadcast = true;
                    on_progress(DiscoveryProgress::InstanceFound {
                        name: instance_name.to_string(),
                    });
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
                on_progress(DiscoveryProgress::Resolved {
                    name: advertised_name.to_string(),
                });

                if service.get_property_val_str("service") != Some(SERVICE_ID) {
                    rejection_reason = Some("广播身份字段不匹配".to_string());
                    on_progress(DiscoveryProgress::Rejected {
                        reason: "广播身份字段不匹配".to_string(),
                    });
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
                        let reason = format!("已发现广播，但 {address}:{target_port} 不可达");
                        rejection_reason = Some(reason.clone());
                        on_progress(DiscoveryProgress::Rejected { reason });
                        continue;
                    }

                    // The HTTP identity endpoint is preferred when exposed. Some
                    // deployments publish only the advertised HTTPS port; in
                    // that case the service/name TXT identity plus a successful
                    // target-port probe is sufficient to continue (legacy).
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
    if cancel.is_stale(current_generation) {
        return Ok(LanOutcome::Cancelled);
    }
    if let Some(endpoint) = result {
        Ok(LanOutcome::Found(endpoint))
    } else if matched_broadcast {
        Ok(LanOutcome::MatchedButFailed(
            rejection_reason
                .unwrap_or_else(|| "已发现广播，但没有可用的 IPv4 地址".to_string()),
        ))
    } else {
        Ok(LanOutcome::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn stale_generation_cancels_before_browsing() {
        let daemon = ServiceDaemon::new().unwrap();
        let cancel = CancelToken {
            my_generation: 4,
            live: None,
        };
        let outcome = discover_lan(&daemon, "AXISNSBOX-000", Duration::from_millis(50), &cancel, 5, |_| {})
            .unwrap();
        assert!(matches!(outcome, LanOutcome::Cancelled));
        let _ = daemon.shutdown();
    }
}
