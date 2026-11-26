use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct LocalLinkEvent {
    pub id: u64,
    pub url: String,
    pub source: String,
    pub ts: u128,
}

#[derive(Debug)]
pub struct LocalLinkQueue {
    capacity: usize,
    next_id: Mutex<u64>,
    events: Mutex<VecDeque<LocalLinkEvent>>,
}

impl LocalLinkQueue {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.clamp(16, 4096),
            next_id: Mutex::new(1),
            events: Mutex::new(VecDeque::new()),
        }
    }

    pub fn push(&self, url: String, source: String) -> u64 {
        let mut next_id = self.next_id.lock().unwrap_or_else(|e| e.into_inner());
        let id = *next_id;
        *next_id = next_id.saturating_add(1).max(1);
        let event = LocalLinkEvent {
            id,
            url,
            source,
            ts: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        };
        let mut events = self.events.lock().unwrap_or_else(|e| e.into_inner());
        if events.len() >= self.capacity {
            events.pop_front();
        }
        events.push_back(event);
        id
    }

    pub fn pull(&self, since_id: u64) -> (Vec<LocalLinkEvent>, u64) {
        let events = self.events.lock().unwrap_or_else(|e| e.into_inner());
        let latest_id = events.back().map(|event| event.id).unwrap_or(0);
        let selected = events.iter().filter(|event| event.id > since_id).cloned().collect();
        (selected, latest_id)
    }
}

pub fn validate_url(raw: &str, allowed_schemes: &[String]) -> Result<String, &'static str> {
    let url = raw.trim();
    if url.is_empty() || url.len() > 4096 || url.chars().any(char::is_control) {
        return Err("invalid url");
    }
    let (scheme, rest) = url.split_once(':').ok_or("invalid url")?;
    let scheme = scheme.to_ascii_lowercase();
    if !allowed_schemes.iter().any(|allowed| allowed == &scheme) {
        return Err("invalid url");
    }
    if scheme == "http" || scheme == "https" {
        let authority = rest.strip_prefix("//").ok_or("invalid url")?;
        let host = authority.split(['/', '?', '#']).next().unwrap_or("");
        if host.is_empty() {
            return Err("invalid url");
        }
    } else if scheme == "mailto" && rest.trim().is_empty() {
        return Err("invalid url");
    }
    Ok(url.to_string())
}

pub type SharedLocalLinkQueue = Arc<LocalLinkQueue>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_is_bounded_and_preserves_monotonic_ids() {
        let queue = LocalLinkQueue::new(16);
        for index in 0..20 {
            queue.push(format!("https://example.com/{index}"), "test".into());
        }
        let (events, latest) = queue.pull(0);
        assert_eq!(events.len(), 16);
        assert_eq!(events.first().unwrap().id, 5);
        assert_eq!(latest, 20);
    }

    #[test]
    fn validates_allowed_schemes_and_rejects_control_characters() {
        let allowed = vec!["http".into(), "https".into(), "mailto".into()];
        assert!(validate_url("https://example.com/path", &allowed).is_ok());
        assert!(validate_url("mailto:user@example.com", &allowed).is_ok());
        assert!(validate_url("file:///etc/passwd", &allowed).is_err());
        assert!(validate_url("https://example.com/\r\nHeader: x", &allowed).is_err());
        assert!(validate_url("https:///missing-host", &allowed).is_err());
    }
}
