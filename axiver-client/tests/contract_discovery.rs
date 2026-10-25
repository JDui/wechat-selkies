//! Protocol-constant and discovery contracts preserved from the legacy
//! client tests (spec sections 3 and 10 T01–T04).

use axiver_client::discovery::{
    DISCOVERY_TIMEOUT, PROBE_INTERVAL, PROBE_TIMEOUT, SERVICE_ID, SERVICE_TYPE,
    SUBNET_PROBE_TIMEOUT, SUBNET_SCAN_WORKERS,
};
use axiver_client::discovery::identity::{
    decode_chunked_body, identity_path, parse_identity_response,
};
use axiver_client::discovery::mdns::advertised_lan_target;
use std::time::Duration;

#[test]
fn discovery_protocol_constants_match_the_server_contract() {
    // Reference: root/scripts/lan_discovery_common.py published by the
    // container. These values may only change together with the server.
    assert_eq!(SERVICE_TYPE, "_axisnsbox._tcp.local.");
    assert_eq!(SERVICE_ID, "wechat-selkies");
    assert_eq!(DISCOVERY_TIMEOUT, Duration::from_secs(4));
    assert_eq!(PROBE_INTERVAL, Duration::from_secs(8));
    assert_eq!(PROBE_TIMEOUT, Duration::from_millis(1800));
    assert_eq!(SUBNET_PROBE_TIMEOUT, Duration::from_millis(280));
    assert_eq!(SUBNET_SCAN_WORKERS, 32);
}

#[test]
fn identity_endpoint_respects_subfolder() {
    assert_eq!(identity_path("/"), "/.well-known/axisnsbox");
    assert_eq!(identity_path("/wechat/"), "/wechat/.well-known/axisnsbox");
    assert_eq!(identity_path(""), "/.well-known/axisnsbox");
}

#[test]
fn identity_response_matches_axiver_payload() {
    let response = concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: application/json\r\n",
        "Connection: close\r\n\r\n",
        r#"{"ok":true,"service":"wechat-selkies","name":"AXISNSBOX-000","#,
        r#""scheme":"https","path":"/wechat","http_port":3000,"https_port":3001}"#
    );
    let identity = parse_identity_response(response, "AXISNSBOX-000").unwrap();
    assert_eq!(identity.service, SERVICE_ID);
    assert_eq!(identity.name, "AXISNSBOX-000");
    assert_eq!(identity.scheme, "https");
    assert_eq!(identity.path, "/wechat");
    assert_eq!(identity.http_port, 3000);
    assert_eq!(identity.https_port, 3001);
    // Case-insensitive broadcast matching, legacy semantics.
    assert!(parse_identity_response(response, "axisnsbox-000").is_some());
    assert!(parse_identity_response(response, "AXISNSBOX-001").is_none());
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
fn chunked_identity_body_is_decoded() {
    let json = r#"{"service":"wechat-selkies","name":"AXISNSBOX-000"}"#;
    let body = format!("{:x}\r\n{}\r\n0\r\n\r\n", json.len(), json);
    assert_eq!(decode_chunked_body(&body).as_deref(), Some(json));
    assert!(decode_chunked_body("zz\r\nbroken").is_none());
}
