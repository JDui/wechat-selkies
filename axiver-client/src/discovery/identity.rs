//! Anonymous HTTP identity endpoint `/.well-known/axisnsbox` (spec 3.2).
//!
//! IMPORTANT (spec section 7): matching the broadcast name in this JSON is
//! NOT credential authentication and must not be advertised as such. The
//! legacy fields (`LanIdentity`) are preserved exactly; `ok`, `service_type`
//! and `enabled` are deliberately not read, as in the old client.

use super::SERVICE_ID;
use serde::Deserialize;
use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    time::Duration,
};

#[derive(Clone, Debug, Deserialize)]
pub struct LanIdentity {
    pub service: String,
    pub name: String,
    #[serde(default = "default_lan_scheme")]
    pub scheme: String,
    #[serde(default = "default_lan_path")]
    pub path: String,
    #[serde(default = "default_http_port")]
    pub http_port: u16,
    #[serde(default = "default_https_port")]
    pub https_port: u16,
}

pub fn default_lan_scheme() -> String {
    "https".to_string()
}

pub fn default_lan_path() -> String {
    "/".to_string()
}

pub fn default_http_port() -> u16 {
    3000
}

pub fn default_https_port() -> u16 {
    3001
}

pub fn identity_path(path: &str) -> String {
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

pub fn decode_chunked_body(body: &str) -> Option<String> {
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

pub fn parse_identity_response(response: &str, expected_name: &str) -> Option<LanIdentity> {
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

pub fn fetch_lan_identity(
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

#[cfg(test)]
mod tests {
    use super::*;

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
            r#""scheme":"https","path":"/","http_port":3000,"https_port":3001}"#
        );
        let identity = parse_identity_response(response, "AXISNSBOX-000").unwrap();
        assert_eq!(identity.scheme, "https");
        assert_eq!(identity.https_port, 3001);
        assert!(parse_identity_response(response, "AXISNSBOX-999").is_none());
    }

    #[test]
    fn identity_response_rejects_wrong_service() {
        let response = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: application/json\r\n\r\n",
            r#"{"service":"someone-else","name":"AXISNSBOX-000"}"#
        );
        assert!(parse_identity_response(response, "AXISNSBOX-000").is_none());
    }

    #[test]
    fn identity_response_rejects_non_200() {
        let response = "HTTP/1.1 404 Not Found\r\n\r\n{}";
        assert!(parse_identity_response(response, "AXISNSBOX-000").is_none());
    }

    #[test]
    fn chunked_body_is_decoded() {
        let body = "1b\r\n{\"service\":\"wechat-selkies\"\r\n0\r\n\r\n";
        assert_eq!(
            decode_chunked_body(body).as_deref(),
            Some("{\"service\":\"wechat-selkies\"")
        );
        assert!(decode_chunked_body("zz\r\nbroken").is_none());
    }
}
