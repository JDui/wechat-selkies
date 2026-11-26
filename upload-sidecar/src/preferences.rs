use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::Mutex,
};

use serde_json::{Map, Value, json};

const MAX_PREFERENCES_BYTES: usize = 262_144;
const VIDEO_ENCODERS: [&str; 5] = ["x264enc", "x264enc-striped", "jpeg", "h265enc", "av1enc"];
const VIDEO_TOGGLES: [&str; 4] = ["use_paint_over_quality", "h264_streaming_mode", "h264_fullcolor", "use_cpu"];
const TOOL_TOGGLES: [&str; 7] = [
    "notification_center_enabled",
    "dock_network_monitor_enabled",
    "legacy_upload_fallback_enabled",
    "bottom_action_clipboard_buttons_enabled",
    "bottom_action_dock_collapsed",
    "dynamic_low_latency_enabled",
    "dynamic_low_latency_disable_paint_over",
];
const DYNAMIC_RANGES: [(&str, i64, i64); 5] = [
    ("dynamic_low_latency_hold_ms", 300, 30_000),
    ("dynamic_low_latency_fps", 1, 120),
    ("dynamic_throttle_strength", 0, 100),
    ("dynamic_low_latency_h264_crf", 5, 60),
    ("dynamic_low_latency_sample_percent", 10, 100),
];
const VIDEO_RANGES: [(&str, i64, i64); 3] = [
    ("framerate", 1, 240),
    ("h264_crf", 5, 50),
    ("h264_paintover_crf", 5, 50),
];

#[derive(Debug)]
pub enum PreferencesError {
    Invalid(&'static str),
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl std::fmt::Display for PreferencesError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => formatter.write_str(message),
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Json(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for PreferencesError {}

impl From<serde_json::Error> for PreferencesError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub struct PreferencesStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl PreferencesStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    pub fn from_env() -> Self {
        Self::new(PathBuf::from(
            std::env::var("SELKIES_UI_PREFERENCES_PATH")
                .unwrap_or_else(|_| "/config/state/ui-preferences.json".into()),
        ))
    }

    pub fn read(&self) -> Result<Value, PreferencesError> {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        self.read_unlocked()
    }

    pub fn update(&self, patch: Value) -> Result<Value, PreferencesError> {
        let patch = patch.as_object().ok_or(PreferencesError::Invalid("Invalid preference patch"))?;
        let mut clean = Map::new();
        for (key, value) in patch {
            clean.insert(key.clone(), validate_preference(key, value)?);
        }

        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let mut state = self.read_unlocked()?
            .as_object()
            .cloned()
            .unwrap_or_default();
        state.extend(clean);
        let updated = Value::Object(state);
        let body = serde_json::to_vec(&updated)?;
        if body.len() > MAX_PREFERENCES_BYTES {
            return Err(PreferencesError::Invalid("Preferences are too large"));
        }

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(PreferencesError::Io)?;
        }
        let temporary = self.path.with_extension("tmp");
        fs::write(&temporary, body).map_err(PreferencesError::Io)?;
        fs::rename(&temporary, &self.path).map_err(PreferencesError::Io)?;
        Ok(updated)
    }

    fn read_unlocked(&self) -> Result<Value, PreferencesError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Value::Object(Map::new()));
            }
            Err(error) => return Err(PreferencesError::Io(error)),
        };
        let payload: Value = serde_json::from_slice(&bytes)?;
        if payload.is_object() {
            Ok(payload)
        } else {
            Ok(Value::Object(Map::new()))
        }
    }
}

fn validate_preference(key: &str, value: &Value) -> Result<Value, PreferencesError> {
    let video_key = key.strip_suffix("_display2").unwrap_or(key);

    if video_key == "encoder" {
        return validate_string_enum(value, &VIDEO_ENCODERS, "Invalid video encoder");
    }

    if video_key == "frame_feedback_mode" {
        return validate_string_enum(value, &["false", "observe", "true"], "Invalid live video mode");
    }

    if video_key == "live_paint_mode" {
        return validate_string_enum(value, &["inherit", "false", "true"], "Invalid live video mode");
    }

    if VIDEO_TOGGLES.contains(&video_key) {
        return normalize_toggle(value, "Invalid video toggle");
    }

    if let Some((_, minimum, maximum)) = VIDEO_RANGES.iter().find(|(name, _, _)| *name == video_key) {
        return normalize_integer(value, *minimum, *maximum, "Invalid video number", "Video value out of range");
    }

    if let Some((_, minimum, maximum)) = DYNAMIC_RANGES.iter().find(|(name, _, _)| *name == key) {
        return normalize_integer(
            value,
            *minimum,
            *maximum,
            "Invalid dynamic throttle number",
            "Dynamic throttle value out of range",
        );
    }

    if key == "dynamic_throttle_mode" {
        return validate_string_enum(
            value,
            &["idle-low-bandwidth", "idle-low-framerate", "idle-low-occupancy"],
            "Invalid dynamic throttle mode",
        );
    }

    if key == "bottom_action_dock_position" {
        return validate_string_enum(value, &["top", "bottom"], "Invalid dock position");
    }

    if key == "input_sampling_multiplier" {
        let multiplier = match value {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => text.parse::<f64>().ok(),
            _ => None,
        }
        .filter(|number| number.is_finite() && (0.5..=2.0).contains(number))
        .ok_or(PreferencesError::Invalid("Invalid input sampling multiplier"))?;
        return Ok(json!((multiplier * 100.0).round() / 100.0));
    }

    if TOOL_TOGGLES.contains(&key) {
        return normalize_toggle(value, "Invalid toggle");
    }

    if key.starts_with("download_favorites:") && key.chars().count() <= 2048 {
        return normalize_favorites(value);
    }

    Err(PreferencesError::Invalid("Unknown preference"))
}

fn validate_string_enum(
    value: &Value,
    allowed: &[&str],
    error: &'static str,
) -> Result<Value, PreferencesError> {
    let text = value.as_str().ok_or(PreferencesError::Invalid(error))?;
    if allowed.contains(&text) {
        Ok(Value::String(text.to_string()))
    } else {
        Err(PreferencesError::Invalid(error))
    }
}

fn normalize_toggle(value: &Value, error: &'static str) -> Result<Value, PreferencesError> {
    match value {
        Value::Bool(value) => Ok(Value::Bool(*value)),
        Value::String(value) if value == "true" => Ok(Value::Bool(true)),
        Value::String(value) if value == "false" => Ok(Value::Bool(false)),
        _ => Err(PreferencesError::Invalid(error)),
    }
}

fn normalize_integer(
    value: &Value,
    minimum: i64,
    maximum: i64,
    invalid: &'static str,
    out_of_range: &'static str,
) -> Result<Value, PreferencesError> {
    let number = match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.parse::<i64>().ok(),
        _ => None,
    }
    .ok_or(PreferencesError::Invalid(invalid))?;
    if !(minimum..=maximum).contains(&number) {
        return Err(PreferencesError::Invalid(out_of_range));
    }
    Ok(json!(number))
}

fn normalize_favorites(value: &Value) -> Result<Value, PreferencesError> {
    let items = value.as_array().ok_or(PreferencesError::Invalid("Invalid favorites"))?;
    if items.len() > 20 {
        return Err(PreferencesError::Invalid("Invalid favorites"));
    }
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for item in items {
        let object = item.as_object().ok_or(PreferencesError::Invalid("Invalid favorite"))?;
        let path = object.get("path").and_then(Value::as_str)
            .ok_or(PreferencesError::Invalid("Invalid favorite path or name"))?;
        let name = object.get("name").and_then(Value::as_str)
            .ok_or(PreferencesError::Invalid("Invalid favorite path or name"))?;
        let invalid_path = path.chars().count() > 4096
            || path.starts_with('/')
            || path.contains('\\')
            || path.contains('\0')
            || (!path.is_empty() && path.split('/').any(|part| part.is_empty() || part == "." || part == ".."));
        let trimmed_name = name.trim();
        if invalid_path || trimmed_name.is_empty() || name.chars().count() > 80 {
            return Err(PreferencesError::Invalid("Invalid favorite path or name"));
        }
        if seen.insert(path.to_string()) {
            entries.push(json!({
                "path": path,
                "name": trimmed_name,
            }));
        }
    }
    Ok(Value::Array(entries))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::Arc, thread};

    #[test]
    fn validates_video_and_display_two_preferences() {
        let encoder = validate_preference("encoder", &json!("av1enc")).unwrap();
        let second_encoder = validate_preference("encoder_display2", &json!("h265enc")).unwrap();
        let framerate = validate_preference("framerate_display2", &json!("45")).unwrap();
        assert_eq!(encoder, json!("av1enc"));
        assert_eq!(second_encoder, json!("h265enc"));
        assert_eq!(framerate, json!(45));
        assert!(validate_preference("encoder", &json!("unknown")).is_err());
        assert!(validate_preference("framerate", &json!(241)).is_err());
        assert!(validate_preference("h264_crf", &json!(45.0)).is_err());
    }

    #[test]
    fn normalizes_toggles_and_bounded_dynamic_settings() {
        assert_eq!(validate_preference("use_cpu", &json!("true")).unwrap(), json!(true));
        assert_eq!(validate_preference("notification_center_enabled", &json!(false)).unwrap(), json!(false));
        assert_eq!(validate_preference("input_sampling_multiplier", &json!("1.237")).unwrap(), json!(1.24));
        assert_eq!(validate_preference("dynamic_low_latency_fps", &json!("60")).unwrap(), json!(60));
        assert!(validate_preference("use_cpu", &json!(1)).is_err());
        assert!(validate_preference("dynamic_low_latency_hold_ms", &json!(30_001)).is_err());
        assert!(validate_preference("dynamic_throttle_mode", &json!("unknown")).is_err());
    }

    #[test]
    fn sanitizes_and_deduplicates_download_favorites() {
        let key = "download_favorites:/files/:/config";
        let value = json!([
            {"path": "工作/文档", "name": "  工作文件  "},
            {"path": "工作/文档", "name": "重复项"},
            {"path": "共享/视频", "name": "视频"}
        ]);
        let cleaned = validate_preference(key, &value).unwrap();
        assert_eq!(cleaned.as_array().unwrap().len(), 2);
        assert_eq!(cleaned[0]["name"], json!("工作文件"));
        assert!(validate_preference(key, &json!([{"path":"../secret","name":"bad"}])).is_err());
        assert!(validate_preference(key, &json!([{"path":"safe","name":" "}])).is_err());
    }

    #[test]
    fn persists_updates_atomically_and_preserves_unmodified_keys() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state/ui-preferences.json");
        let store = PreferencesStore::new(path.clone());
        let first = store.update(json!({
            "encoder": "h265enc",
            "notification_center_enabled": true,
            "bottom_action_dock_position": "top"
        })).unwrap();
        assert_eq!(first["encoder"], json!("h265enc"));
        let second = store.update(json!({"framerate": 45})).unwrap();
        assert_eq!(second["encoder"], json!("h265enc"));
        assert_eq!(second["framerate"], json!(45));
        assert_eq!(PreferencesStore::new(path).read().unwrap(), second);
    }

    #[test]
    fn concurrent_partial_updates_do_not_overwrite_each_other() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(PreferencesStore::new(temp.path().join("preferences.json")));
        let workers = [
            ("notification_center_enabled", json!(true)),
            ("dock_network_monitor_enabled", json!(false)),
            ("legacy_upload_fallback_enabled", json!(true)),
            ("bottom_action_dock_collapsed", json!(true)),
        ];
        let handles = workers.into_iter().map(|(key, value)| {
            let store = store.clone();
            thread::spawn(move || {
                store.update(json!({key: value})).unwrap();
            })
        }).collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }
        let saved = store.read().unwrap();
        assert_eq!(saved.as_object().unwrap().len(), 4);
    }
}
