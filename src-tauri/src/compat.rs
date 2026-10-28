//! Read-only compatibility with identifiers written before the MSkills rename.

use crate::error::AppError;
use rusqlite::{backup::Backup, Connection, OpenFlags};
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};

pub(crate) const LEGACY_DATABASE: &str = "cc-switch.db";
pub(crate) const LEGACY_SQL_HEADER: &str = "-- CC Switch SQLite 导出";
pub(crate) const LEGACY_SYNC_FORMAT: &str = "cc-switch-webdav-sync";
pub(crate) const LEGACY_SYNC_ROOT: &str = "cc-switch-sync";
pub(crate) const LEGACY_CODEX_PROVIDER: &str = "ccswitch";
pub(crate) const LEGACY_OFFICIAL_ROUTE: &str = "cc-switch-official";
pub(crate) const LEGACY_MODEL_CATALOG: &str = "cc-switch-model-catalog.json";
pub(crate) const LEGACY_APP_NAME: &str = "CC Switch";

pub(crate) fn env_var(name: &str) -> Result<String, env::VarError> {
    env::var(name).or_else(|error| {
        name.strip_prefix("MSKILLS_")
            .map(|suffix| env::var(format!("CC_SWITCH_{suffix}")))
            .unwrap_or(Err(error))
    })
}

pub(crate) fn is_deeplink(url: &str) -> bool {
    url.starts_with("mskills://") || url.starts_with("ccswitch://")
}

/// SQLite backup includes committed WAL pages; copying just the file would lose them.
pub(crate) fn database_path(dir: &Path) -> Result<PathBuf, AppError> {
    let target = dir.join("mskills.db");
    let legacy = dir.join(LEGACY_DATABASE);
    if target.exists() || !legacy.exists() {
        return Ok(target);
    }
    copy_database(&legacy, &target)?;
    Ok(target)
}

fn copy_database(legacy: &Path, target: &Path) -> Result<(), AppError> {
    let dir = target.parent().expect("database has a parent directory");
    let temp = tempfile::NamedTempFile::new_in(dir).map_err(|e| AppError::io(dir, e))?;
    {
        let source = Connection::open_with_flags(legacy, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut destination =
            Connection::open(temp.path()).map_err(|e| AppError::Database(e.to_string()))?;
        Backup::new(&source, &mut destination)
            .and_then(|backup| backup.run_to_completion(128, Duration::from_millis(10), None))
            .map_err(|e| AppError::Database(e.to_string()))?;
        let check: String = destination
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(|e| AppError::Database(e.to_string()))?;
        if check != "ok" {
            return Err(AppError::Database(format!(
                "Legacy database integrity check failed: {check}"
            )));
        }
    }
    temp.persist_noclobber(target)
        .map_err(|e| AppError::io(target, e.error))?;
    Ok(())
}

/// Publish a complete copy atomically. Keep the original directory as the rollback copy.
pub(crate) fn migrate_default_directory(home: &Path) -> Result<bool, AppError> {
    let legacy = home.join(".cc-switch");
    let target = home.join(".mskills");
    if target.exists() || !legacy.is_dir() {
        return Ok(false);
    }
    let stage = tempfile::tempdir_in(home).map_err(|e| AppError::io(home, e))?;
    copy_tree(&legacy, stage.path(), true)?;
    if legacy.join(LEGACY_DATABASE).exists() {
        copy_database(
            &legacy.join(LEGACY_DATABASE),
            &stage.path().join("mskills.db"),
        )?;
    }
    fs::write(stage.path().join(".legacy-skill-links-pending"), b"")
        .map_err(|e| AppError::io(stage.path(), e))?;
    fs::rename(stage.path(), &target).map_err(|e| AppError::io(&target, e))?;
    Ok(true)
}

fn copy_tree(source: &Path, target: &Path, root: bool) -> Result<(), AppError> {
    for entry in fs::read_dir(source).map_err(|e| AppError::io(source, e))? {
        let entry = entry.map_err(|e| AppError::io(source, e))?;
        if root
            && entry.file_name().to_str().is_some_and(|name| {
                name == LEGACY_DATABASE || name == "cc-switch.db-wal" || name == "cc-switch.db-shm"
            })
        {
            continue;
        }
        let from = entry.path();
        let to = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&from).map_err(|e| AppError::io(&from, e))?;
        if metadata.is_symlink() {
            let link = fs::read_link(&from).map_err(|e| AppError::io(&from, e))?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(link, &to).map_err(|e| AppError::io(&to, e))?;
            #[cfg(windows)]
            if from.is_dir() {
                std::os::windows::fs::symlink_dir(link, &to).map_err(|e| AppError::io(&to, e))?;
            } else {
                std::os::windows::fs::symlink_file(link, &to).map_err(|e| AppError::io(&to, e))?;
            }
        } else if metadata.is_dir() {
            fs::create_dir(&to).map_err(|e| AppError::io(&to, e))?;
            copy_tree(&from, &to, false)?;
            fs::set_permissions(&to, metadata.permissions()).map_err(|e| AppError::io(&to, e))?;
        } else {
            fs::copy(&from, &to).map_err(|e| AppError::io(&to, e))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_migration_preserves_wal_and_original_and_does_not_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join(LEGACY_DATABASE);
        let connection = Connection::open(&old).unwrap();
        connection.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE saved(value TEXT); INSERT INTO saved VALUES ('kept');").unwrap();
        let path = database_path(dir.path()).unwrap();
        let migrated = Connection::open(&path).unwrap();
        let value: String = migrated
            .query_row("SELECT value FROM saved", [], |r| r.get(0))
            .unwrap();
        assert_eq!(value, "kept");
        assert!(old.exists());
        migrated
            .execute("UPDATE saved SET value='new'", [])
            .unwrap();
        assert_eq!(database_path(dir.path()).unwrap(), path);
        assert_eq!(
            migrated
                .query_row::<String, _, _>("SELECT value FROM saved", [], |r| r.get(0))
                .unwrap(),
            "new"
        );
    }

    #[test]
    fn corrupt_database_does_not_create_an_empty_replacement() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(LEGACY_DATABASE), b"invalid database").unwrap();
        assert!(database_path(dir.path()).is_err());
        assert!(!dir.path().join("mskills.db").exists());
    }

    #[test]
    fn directory_migration_preserves_settings_skills_and_original() {
        let home = tempfile::tempdir().unwrap();
        let old = home.path().join(".cc-switch");
        fs::create_dir_all(old.join("skills/example")).unwrap();
        fs::write(old.join("skills/example/SKILL.md"), "# Example").unwrap();
        fs::write(old.join("settings.json"), "{}").unwrap();
        assert!(migrate_default_directory(home.path()).unwrap());
        assert!(home
            .path()
            .join(".mskills/skills/example/SKILL.md")
            .exists());
        assert!(old.join("settings.json").exists());
        assert!(!migrate_default_directory(home.path()).unwrap());
    }

    #[test]
    #[serial_test::serial]
    fn legacy_environment_is_used_only_when_new_name_is_absent() {
        let old = env::var_os("CC_SWITCH_COMPAT_TEST");
        let new = env::var_os("MSKILLS_COMPAT_TEST");
        env::remove_var("MSKILLS_COMPAT_TEST");
        env::set_var("CC_SWITCH_COMPAT_TEST", "legacy");
        assert_eq!(env_var("MSKILLS_COMPAT_TEST").unwrap(), "legacy");
        env::set_var("MSKILLS_COMPAT_TEST", "current");
        assert_eq!(env_var("MSKILLS_COMPAT_TEST").unwrap(), "current");
        for (key, value) in [("CC_SWITCH_COMPAT_TEST", old), ("MSKILLS_COMPAT_TEST", new)] {
            match value {
                Some(value) => env::set_var(key, value),
                None => env::remove_var(key),
            }
        }
    }

    #[test]
    fn legacy_directory_snapshot_includes_committed_wal_pages() {
        let home = tempfile::tempdir().unwrap();
        let old = home.path().join(".cc-switch");
        fs::create_dir(&old).unwrap();
        let connection = Connection::open(old.join(LEGACY_DATABASE)).unwrap();
        connection.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE saved(value TEXT); INSERT INTO saved VALUES ('kept');").unwrap();
        migrate_default_directory(home.path()).unwrap();
        let migrated = Connection::open(home.path().join(".mskills/mskills.db")).unwrap();
        assert_eq!(
            migrated
                .query_row::<String, _, _>("SELECT value FROM saved", [], |r| r.get(0))
                .unwrap(),
            "kept"
        );
        assert!(!home.path().join(".mskills/cc-switch.db-wal").exists());
        assert!(old.join(LEGACY_DATABASE).exists());
    }

    #[test]
    fn accepts_both_deeplink_schemes_only() {
        assert!(is_deeplink("mskills://v1/import"));
        assert!(is_deeplink("ccswitch://v1/import"));
        assert!(!is_deeplink("https://example.com/mskills://v1/import"));
    }
}
