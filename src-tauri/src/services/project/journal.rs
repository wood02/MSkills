//! 操作日志与启动/写前崩溃恢复（`skill_operation_journal`）
//!
//! 实现两阶段意图日志：
//! - `prepared`：尚未提交最终 DB 事实，恢复时回滚局部 FS 交换并清理暂存目录
//! - `committed`：DB 事实已提交，恢复时补全幂等外部清理并清除残留 backup/staging

use anyhow::{anyhow, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use uuid::Uuid;

use crate::database::dao::projects::SkillOperationJournalRecord;
use crate::database::Database;
use crate::services::project::fs_safety::{remove_path_any, rename_noreplace};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtraSwapPaths {
    pub staging_path: Option<String>,
    pub backup_path: Option<String>,
    pub dest_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JournalPayload {
    #[serde(default)]
    pub extra_swaps: Vec<ExtraSwapPaths>,
    #[serde(default)]
    pub refresh_app_directories: Vec<String>,
    #[serde(default)]
    pub remove_paths_on_commit: Vec<String>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct JournalBeginSpec<'a> {
    pub op_type: &'a str,
    pub skill_id: Option<&'a str>,
    pub project_id: Option<&'a str>,
    pub target: Option<&'a str>,
    pub directory: Option<&'a str>,
    pub staging_path: Option<&'a str>,
    pub backup_path: Option<&'a str>,
    pub dest_path: Option<&'a str>,
}

pub struct JournalGuard {
    db: Arc<Database>,
    op_id: String,
    active: bool,
}

impl JournalGuard {
    pub fn begin(
        db: &Arc<Database>,
        spec: JournalBeginSpec<'_>,
        payload: &JournalPayload,
    ) -> Result<Self> {
        let now = Utc::now().timestamp();
        let op_id = Uuid::new_v4().to_string();
        let rec = SkillOperationJournalRecord {
            op_id: op_id.clone(),
            op_type: spec.op_type.to_string(),
            phase: "prepared".to_string(),
            skill_id: spec.skill_id.map(str::to_string),
            project_id: spec.project_id.map(str::to_string),
            target: spec.target.map(str::to_string),
            directory: spec.directory.map(str::to_string),
            staging_path: spec.staging_path.map(str::to_string),
            backup_path: spec.backup_path.map(str::to_string),
            dest_path: spec.dest_path.map(str::to_string),
            payload_json: serde_json::to_string(payload)?,
            created_at: now,
            updated_at: now,
        };
        db.insert_operation_journal(&rec)?;
        Ok(Self {
            db: Arc::clone(db),
            op_id,
            active: true,
        })
    }

    pub fn mark_committed(&self, updated_payload: Option<&JournalPayload>) -> Result<()> {
        let payload_json = updated_payload.map(serde_json::to_string).transpose()?;
        self.db.update_operation_journal_phase(
            &self.op_id,
            "committed",
            payload_json.as_deref(),
            Utc::now().timestamp(),
        )?;
        Ok(())
    }

    pub fn finish(mut self) -> Result<()> {
        self.active = false;
        self.db.delete_operation_journal(&self.op_id)?;
        Ok(())
    }
}

fn rollback_single_swap(staging: Option<&str>, backup: Option<&str>, dest: Option<&str>) {
    if let (Some(backup_str), Some(dest_str)) = (backup, dest) {
        let backup_p = PathBuf::from(backup_str);
        let dest_p = PathBuf::from(dest_str);
        if std::fs::symlink_metadata(&backup_p).is_ok() {
            if std::fs::symlink_metadata(&dest_p).is_ok() {
                // 若新 dest 已切换上去，先移回 staging 或移除，然后恢复 backup
                let _ = remove_path_any(&dest_p);
            }
            if let Err(err) = rename_noreplace(&backup_p, &dest_p) {
                log::warn!(
                    "操作日志回滚恢复 backup 失败 ({} -> {}): {err}",
                    backup_p.display(),
                    dest_p.display()
                );
            }
        }
    }
    if let Some(staging_str) = staging {
        let _ = remove_path_any(&PathBuf::from(staging_str));
    }
}

fn finalize_committed_swap(staging: Option<&str>, backup: Option<&str>) {
    if let Some(backup_str) = backup {
        let _ = remove_path_any(&PathBuf::from(backup_str));
    }
    if let Some(staging_str) = staging {
        let _ = remove_path_any(&PathBuf::from(staging_str));
    }
}

fn journal_op_mutex() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 获取全局操作日志互斥锁，确保崩溃恢复与各项目/全局 `JournalGuard` 写操作串行执行。
pub fn acquire_journal_op_lock() -> MutexGuard<'static, ()> {
    journal_op_mutex().lock().unwrap_or_else(|e| e.into_inner())
}

/// 恢复所有未清理的 `skill_operation_journal` 记录（调用方已持有 [`acquire_journal_op_lock`]）。
pub fn recover_pending_operations_locked(
    db: &Arc<Database>,
    _journal_guard: &MutexGuard<'static, ()>,
) -> Result<usize> {
    let entries = db.list_operation_journals()?;
    let mut recovered = 0usize;

    for entry in entries {
        let payload =
            serde_json::from_str::<JournalPayload>(&entry.payload_json).unwrap_or_default();
        match entry.phase.as_str() {
            "prepared" => {
                log::warn!(
                    "恢复未完成操作 op_id={} type={} phase=prepared，执行回滚",
                    entry.op_id,
                    entry.op_type
                );
                for extra in payload.extra_swaps.iter().rev() {
                    rollback_single_swap(
                        extra.staging_path.as_deref(),
                        extra.backup_path.as_deref(),
                        extra.dest_path.as_deref(),
                    );
                }
                rollback_single_swap(
                    entry.staging_path.as_deref(),
                    entry.backup_path.as_deref(),
                    entry.dest_path.as_deref(),
                );
            }
            "committed" => {
                log::info!(
                    "完成已提交操作后续清理 op_id={} type={} phase=committed",
                    entry.op_id,
                    entry.op_type
                );
                for dir in &payload.refresh_app_directories {
                    if let Err(err) = crate::services::skill::SkillService::refresh_enabled_app_directories_for_dir(db, dir) {
                        log::warn!("日志恢复刷新应用目录 {dir} 失败: {err}");
                    }
                }
                for p in &payload.remove_paths_on_commit {
                    let _ = remove_path_any(&PathBuf::from(p));
                }
                for extra in &payload.extra_swaps {
                    finalize_committed_swap(
                        extra.staging_path.as_deref(),
                        extra.backup_path.as_deref(),
                    );
                }
                finalize_committed_swap(
                    entry.staging_path.as_deref(),
                    entry.backup_path.as_deref(),
                );
            }
            other => {
                log::error!("未知操作日志阶段 phase={other} op_id={}", entry.op_id);
                return Err(anyhow!("未知操作日志阶段: {other}"));
            }
        }
        db.delete_operation_journal(&entry.op_id)?;
        recovered += 1;
    }

    Ok(recovered)
}

/// 恢复所有未清理的 `skill_operation_journal` 记录。
///
/// 应在应用启动时及任何独立崩溃恢复调用处使用。
pub fn recover_pending_operations(db: &Arc<Database>) -> Result<usize> {
    let guard = acquire_journal_op_lock();
    recover_pending_operations_locked(db, &guard)
}
