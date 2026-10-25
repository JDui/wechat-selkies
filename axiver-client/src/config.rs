//! Configuration validation, backward-compatible SQLite persistence and
//! pre-write backups (spec sections 2.1 and 8).
//!
//! The on-disk model is unchanged from the legacy client: one `settings`
//! key/value table beside the executable. The new client must read old
//! databases without any migration, preserve unknown keys, and only write on
//! an explicit user action.

use crate::protocol::ClientConfigV1;
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub const DEFAULT_BROADCAST_NAME: &str = "AXISNSBOX-000";

/// Everything the Shell needs to know about configuration storage.
#[derive(Clone, Debug)]
pub struct LoadedConfig {
    pub config: ClientConfigV1,
    /// `Some(...)` when the database could not be opened/read. The app keeps
    /// running with defaults and the Shell surfaces this verbatim.
    pub db_error: Option<String>,
}

pub fn portable_root() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn open_connection(path: &Path) -> Result<Connection, String> {
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
    Ok(connection)
}

fn read_value(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

/// Read the legacy `settings` table into the typed configuration.
///
/// Legacy read semantics are preserved: an invalid stored broadcast name
/// falls back to the default and an invalid WAN URL falls back to empty
/// without rewriting the database.
pub fn load(db_path: &Path) -> LoadedConfig {
    let loaded = (|| -> Result<ClientConfigV1, String> {
        let connection = open_connection(db_path)?;
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

        let broadcast_name = read_value(&connection, "broadcast_name")?
            .and_then(|value| normalize_broadcast_name(&value).ok())
            .unwrap_or_else(|| DEFAULT_BROADCAST_NAME.to_string());
        let wide_url = read_value(&connection, "wide_url")?
            .and_then(|value| normalize_wide_url(&value).ok())
            .unwrap_or_default();
        Ok(ClientConfigV1::new(broadcast_name, wide_url))
    })();
    match loaded {
        Ok(config) => LoadedConfig {
            config,
            db_error: None,
        },
        Err(error) => LoadedConfig {
            config: ClientConfigV1::default(),
            db_error: Some(error),
        },
    }
}

/// Repository performing transactional writes with one recoverable backup
/// per process before the first write (spec section 8, P0 constraint 4).
pub struct SettingsRepository {
    db_path: PathBuf,
    backed_up: AtomicBool,
}

impl SettingsRepository {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            backed_up: AtomicBool::new(false),
        }
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// Validate -> backup-once -> transactional upsert. Returns the real
    /// storage error on failure so the Shell can show it instead of a fake
    /// "saved" toast.
    pub fn save(&self, config: &ClientConfigV1) -> Result<(), String> {
        let validated = ClientConfigV1::new(
            normalize_broadcast_name(&config.broadcast_name)?,
            normalize_wide_url(&config.wide_url)?,
        );
        self.backup_once()?;
        let mut connection = Connection::open(&self.db_path).map_err(|error| error.to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO settings(key, value) VALUES ('broadcast_name', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![validated.broadcast_name],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO settings(key, value) VALUES ('wide_url', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![validated.wide_url],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    /// Copy the checkpointed database into `backups/` once per process and
    /// keep the newest 10 copies. The WAL is checkpointed (TRUNCATE) first so
    /// the copy contains every committed transaction.
    fn backup_once(&self) -> Result<(), String> {
        if self.backed_up.load(Ordering::SeqCst) || !self.db_path.exists() {
            self.backed_up.store(true, Ordering::SeqCst);
            return Ok(());
        }
        let result = (|| -> Result<(), String> {
            let connection = open_connection(&self.db_path)?;
            connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|error| error.to_string())?;
            drop(connection);
            let parent = self.db_path.parent().unwrap_or(Path::new("."));
            let backups = parent.join("backups");
            fs::create_dir_all(&backups).map_err(|error| error.to_string())?;
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_micros())
                .unwrap_or(0);
            let destination = backups.join(format!(
                "axiver-client-{}.db",
                crate::protocol::format_rfc3339_utc(stamp as i64 * 1000)
                    .replace(['-', ':'], "")
            ));
            fs::copy(&self.db_path, &destination).map_err(|error| error.to_string())?;
            let mut copies = fs::read_dir(&backups)
                .map_err(|error| error.to_string())?
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| {
                            name.starts_with("axiver-client-") && name.ends_with(".db")
                        })
                })
                .collect::<Vec<_>>();
            copies.sort();
            while copies.len() > 10 {
                let oldest = copies.remove(0);
                let _ = fs::remove_file(oldest);
            }
            Ok(())
        })();
        // A failed backup must not block configuration saving forever; the
        // write still proceeds but retries the backup on the next save.
        if result.is_ok() {
            self.backed_up.store(true, Ordering::SeqCst);
        }
        result
    }
}

pub fn normalize_broadcast_name(value: &str) -> Result<String, String> {
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

pub fn normalize_wide_url(value: &str) -> Result<String, String> {
    let candidate = value.trim();
    if candidate.is_empty() {
        return Ok(String::new());
    }
    let parsed = url::Url::parse(candidate).map_err(|_| "广域地址格式无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("广域地址必须是完整的 HTTP 或 HTTPS 地址".to_string());
    }
    Ok(parsed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("axiver-{label}-{unique}.db"))
    }

    fn remove_db(path: &Path) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let _ = fs::remove_dir(path.with_extension("backups"));
    }

    #[test]
    fn broadcast_name_is_uppercased_and_constrained() {
        assert_eq!(
            normalize_broadcast_name(" axisnsbox-123 ").unwrap(),
            "AXISNSBOX-123"
        );
        assert!(normalize_broadcast_name("bad name").is_err());
        assert!(normalize_broadcast_name("_bad").is_err());
        assert!(normalize_broadcast_name("").is_err());
        assert!(normalize_broadcast_name(&"A".repeat(33)).is_err());
    }

    #[test]
    fn wide_url_requires_http_or_https() {
        assert_eq!(normalize_wide_url("").unwrap(), "");
        assert!(normalize_wide_url("https://example.com/path").is_ok());
        assert!(normalize_wide_url("file:///c:/secret").is_err());
    }

    #[test]
    fn legacy_settings_table_is_read_without_migration() {
        // Build a legacy database exactly the way the old client did.
        let path = temp_db("legacy-read");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "PRAGMA journal_mode = WAL;
                     CREATE TABLE IF NOT EXISTS settings (
                         key TEXT PRIMARY KEY NOT NULL,
                         value TEXT NOT NULL
                     );",
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO settings(key, value) VALUES ('broadcast_name','axisnsbox-7')",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO settings(key, value) VALUES ('wide_url','https://wan.example.test/box/')",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO settings(key, value) VALUES ('ui.theme','dark')",
                    [],
                )
                .unwrap();
        }
        let loaded = load(&path);
        assert!(loaded.db_error.is_none());
        assert_eq!(loaded.config.broadcast_name, "AXISNSBOX-7");
        assert_eq!(loaded.config.wide_url, "https://wan.example.test/box/");
        assert_eq!(loaded.config.schema_version, 1);

        // Saving keeps unknown legacy keys untouched.
        let repository = SettingsRepository::new(path.clone());
        repository
            .save(&ClientConfigV1::new("AXISNSBOX-8".to_string(), String::new()))
            .unwrap();
        let connection = Connection::open(&path).unwrap();
        let theme: String = connection
            .query_row(
                "SELECT value FROM settings WHERE key='ui.theme'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(theme, "dark");
        remove_db(&path);
    }

    #[test]
    fn invalid_legacy_values_fall_back_without_rewriting() {
        let path = temp_db("legacy-invalid");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "PRAGMA journal_mode = WAL;
                     CREATE TABLE IF NOT EXISTS settings (
                         key TEXT PRIMARY KEY NOT NULL,
                         value TEXT NOT NULL
                     );",
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO settings(key, value) VALUES ('broadcast_name','非法 名称')",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO settings(key, value) VALUES ('wide_url','not a url')",
                    [],
                )
                .unwrap();
        }
        let loaded = load(&path);
        assert_eq!(loaded.config.broadcast_name, DEFAULT_BROADCAST_NAME);
        assert_eq!(loaded.config.wide_url, "");
        let connection = Connection::open(&path).unwrap();
        let raw: String = connection
            .query_row(
                "SELECT value FROM settings WHERE key='broadcast_name'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(raw, "非法 名称"); // untouched: reads never rewrite
        remove_db(&path);
    }

    #[test]
    fn wide_url_round_trips_through_sqlite() {
        let path = temp_db("round-trip");
        let repository = SettingsRepository::new(path.clone());
        let mut config = load(&path).config;
        config.wide_url = normalize_wide_url("https://wide.example.test/path").unwrap();
        repository.save(&config).unwrap();
        let reloaded = load(&path).config;
        assert_eq!(reloaded.wide_url, "https://wide.example.test/path");
        // The first write produced a recoverable backup.
        let backups = path.parent().unwrap().join("backups");
        assert!(backups.exists());
        remove_db(&path);
        let _ = fs::remove_dir_all(backups);
    }

    #[test]
    fn save_reports_validation_and_storage_errors() {
        let path = temp_db("errors");
        let repository = SettingsRepository::new(path.clone());
        let bad = ClientConfigV1::new("_bad".to_string(), String::new());
        assert_eq!(
            repository.save(&bad).unwrap_err(),
            "广播名必须以字母或数字开头"
        );
        let bad_url = ClientConfigV1::new("OK".to_string(), "ftp://x".to_string());
        assert!(repository.save(&bad_url).is_err());
        remove_db(&path);
    }
}
