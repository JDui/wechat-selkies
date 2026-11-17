//! Small bounded timing log; never records cookies, page contents or WAN URLs.
use std::{fs::OpenOptions, io::Write, sync::Mutex};
static LOG_LOCK: Mutex<()> = Mutex::new(());

pub fn record(event: &str, elapsed_ms: u128, detail: &str) {
    let Ok(_guard) = LOG_LOCK.lock() else {
        return;
    };
    let path = crate::config::portable_root().join("axiver-client-data/connection-timing.jsonl");
    let truncate = path
        .metadata()
        .is_ok_and(|metadata| metadata.len() > 1024 * 1024);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .write(true)
        .append(!truncate)
        .truncate(truncate)
        .open(path)
    {
        let entry = serde_json::json!({"at": crate::protocol::now_iso8601(), "event": event, "elapsedMs": elapsed_ms, "detail": detail});
        let _ = writeln!(file, "{entry}");
    }
}
