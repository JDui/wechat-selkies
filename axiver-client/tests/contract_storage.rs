//! End-to-end data compatibility contract against a database produced by
//! the *legacy* client layout (spec section 10 T01–T03 and P0 exit criteria).
//! Exercises the real files including WAL sidecars.

use axiver_client::config::{LoadedConfig, SettingsRepository, load};
use axiver_client::protocol::ClientConfigV1;
use rusqlite::Connection;
use std::{fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

fn temp_db(label: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("axiver-contract-{label}-{unique}.db"))
}

#[test]
fn legacy_database_with_wal_sidecars_opens_and_saves() {
    let path = temp_db("wal");
    {
        // Legacy client layout: main DB + WAL + SHM files, legacy keys only.
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
        for (key, value) in [
            ("broadcast_name", "axisnsbox-42"),
            ("wide_url", "https://wan.example.test/box"),
            ("legacy.custom.key", "keep me"),
        ] {
            connection
                .execute(
                    "INSERT INTO settings(key, value) VALUES (?1, ?2)",
                    rusqlite::params![key, value],
                )
                .unwrap();
        }
        // Force WAL sidecars to exist on disk.
        connection
            .pragma_update(None, "wal_autocheckpoint", "0")
            .unwrap();
        connection
            .execute(
                "INSERT OR REPLACE INTO settings(key, value) VALUES ('transient','1')",
                [],
            )
            .unwrap();
        assert!(PathBuf::from(format!("{}-wal", path.display())).exists());
    }

    let LoadedConfig {
        config, db_error, ..
    } = load(&path);
    assert!(db_error.is_none());
    assert_eq!(config.broadcast_name, "AXISNSBOX-42");
    assert_eq!(config.wide_url, "https://wan.example.test/box");
    assert_eq!(config.schema_version, 1);

    let repository = SettingsRepository::new(path.clone());
    repository
        .save(&ClientConfigV1::new(
            "axisnsbox-43 ".to_string(),
            "https://backup.example.test/".to_string(),
        ))
        .unwrap();

    // A recoverable backup was produced before the first write.
    let backups = path.parent().unwrap().join("backups");
    let copies = fs::read_dir(&backups)
        .unwrap()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".db")))
        .count();
    assert!(copies >= 1, "expected a pre-write backup");

    // New read sees updated values; unknown legacy keys survived.
    let reloaded = load(&path);
    assert_eq!(reloaded.config.broadcast_name, "AXISNSBOX-43");
    assert_eq!(reloaded.config.wide_url, "https://backup.example.test/");
    let connection = Connection::open(&path).unwrap();
    let kept: String = connection
        .query_row(
            "SELECT value FROM settings WHERE key='legacy.custom.key'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(kept, "keep me");

    for suffix in ["", "-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let _ = fs::remove_dir_all(backups);
}
