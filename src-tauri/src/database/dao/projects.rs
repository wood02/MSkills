//! 项目工作区、Skill 部署、Rules 快照与操作日志 DAO

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub fs_identity: Option<String>,
    pub default_mode: String,
    pub enabled_targets: Vec<String>,
    pub auto_git_exclude: bool,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillDeploymentRecord {
    pub id: String,
    pub project_id: String,
    pub target: String,
    pub directory: String,
    pub skill_id: Option<String>,
    pub skill_installation_id: Option<String>,
    pub mode: String,
    pub managed_link_target: Option<String>,
    pub deployed_hash: Option<String>,
    pub last_materialized_hash: Option<String>,
    pub baseline_source: Option<String>,
    pub git_exclude_ref: Option<String>,
    pub deployed_at: i64,
    pub updated_at: i64,
    pub detached_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRuleSnapshotRecord {
    pub id: String,
    pub project_id: String,
    pub relative_path: String,
    pub file_existed: bool,
    pub content: String,
    pub content_hash: Option<String>,
    pub prompt_id: Option<String>,
    pub action: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillOperationJournalRecord {
    pub op_id: String,
    pub op_type: String,
    pub phase: String,
    pub skill_id: Option<String>,
    pub project_id: Option<String>,
    pub target: Option<String>,
    pub directory: Option<String>,
    pub staging_path: Option<String>,
    pub backup_path: Option<String>,
    pub dest_path: Option<String>,
    pub payload_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn parse_targets_json(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_else(|_| vec!["agents".to_string()])
}

fn row_to_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRecord> {
    let targets_raw: String = row.get(5)?;
    let auto_exclude_int: i64 = row.get(6)?;
    Ok(ProjectRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        root_path: row.get(2)?,
        fs_identity: row.get(3)?,
        default_mode: row.get(4)?,
        enabled_targets: parse_targets_json(&targets_raw),
        auto_git_exclude: auto_exclude_int != 0,
        archived_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn row_to_deployment(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectSkillDeploymentRecord> {
    Ok(ProjectSkillDeploymentRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        target: row.get(2)?,
        directory: row.get(3)?,
        skill_id: row.get(4)?,
        skill_installation_id: row.get(5)?,
        mode: row.get(6)?,
        managed_link_target: row.get(7)?,
        deployed_hash: row.get(8)?,
        last_materialized_hash: row.get(9)?,
        baseline_source: row.get(10)?,
        git_exclude_ref: row.get(11)?,
        deployed_at: row.get(12)?,
        updated_at: row.get(13)?,
        detached_at: row.get(14)?,
    })
}

fn row_to_rule_snapshot(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRuleSnapshotRecord> {
    let file_existed_int: i64 = row.get(3)?;
    Ok(ProjectRuleSnapshotRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        relative_path: row.get(2)?,
        file_existed: file_existed_int != 0,
        content: row.get(4)?,
        content_hash: row.get(5)?,
        prompt_id: row.get(6)?,
        action: row.get(7)?,
        created_at: row.get(8)?,
    })
}

fn row_to_journal(row: &rusqlite::Row<'_>) -> rusqlite::Result<SkillOperationJournalRecord> {
    Ok(SkillOperationJournalRecord {
        op_id: row.get(0)?,
        op_type: row.get(1)?,
        phase: row.get(2)?,
        skill_id: row.get(3)?,
        project_id: row.get(4)?,
        target: row.get(5)?,
        directory: row.get(6)?,
        staging_path: row.get(7)?,
        backup_path: row.get(8)?,
        dest_path: row.get(9)?,
        payload_json: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

impl Database {
    // ========== Projects ==========

    pub fn list_projects(&self, include_archived: bool) -> Result<Vec<ProjectRecord>, AppError> {
        let conn = lock_conn!(self.conn);
        let sql = if include_archived {
            "SELECT id, name, root_path, fs_identity, default_mode, enabled_targets,
                    auto_git_exclude, archived_at, created_at, updated_at
             FROM projects
             ORDER BY archived_at IS NOT NULL ASC, updated_at DESC, name ASC"
        } else {
            "SELECT id, name, root_path, fs_identity, default_mode, enabled_targets,
                    auto_git_exclude, archived_at, created_at, updated_at
             FROM projects
             WHERE archived_at IS NULL
             ORDER BY updated_at DESC, name ASC"
        };
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| AppError::Database(e.to_string()))?;
        let iter = stmt
            .query_map([], row_to_project)
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn get_project(&self, id: &str) -> Result<Option<ProjectRecord>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT id, name, root_path, fs_identity, default_mode, enabled_targets,
                    auto_git_exclude, archived_at, created_at, updated_at
             FROM projects WHERE id = ?1",
            [id],
            row_to_project,
        )
        .optional()
        .map_err(|e| AppError::Database(e.to_string()))
    }

    pub fn get_project_by_root_path(
        &self,
        root_path: &str,
    ) -> Result<Option<ProjectRecord>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT id, name, root_path, fs_identity, default_mode, enabled_targets,
                    auto_git_exclude, archived_at, created_at, updated_at
             FROM projects WHERE root_path = ?1",
            [root_path],
            row_to_project,
        )
        .optional()
        .map_err(|e| AppError::Database(e.to_string()))
    }

    pub fn save_project(&self, project: &ProjectRecord) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let targets_json = serde_json::to_string(&project.enabled_targets)
            .map_err(|e| AppError::Database(e.to_string()))?;
        conn.execute(
            "INSERT INTO projects (
                id, name, root_path, fs_identity, default_mode, enabled_targets,
                auto_git_exclude, archived_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                root_path = excluded.root_path,
                fs_identity = excluded.fs_identity,
                default_mode = excluded.default_mode,
                enabled_targets = excluded.enabled_targets,
                auto_git_exclude = excluded.auto_git_exclude,
                archived_at = excluded.archived_at,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at",
            params![
                project.id,
                project.name,
                project.root_path,
                project.fs_identity,
                project.default_mode,
                targets_json,
                i64::from(project.auto_git_exclude),
                project.archived_at,
                project.created_at,
                project.updated_at,
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn delete_project_and_records(&self, id: &str) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        tx.execute(
            "DELETE FROM project_skill_deployments WHERE project_id = ?1",
            [id],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        tx.execute(
            "DELETE FROM project_rule_snapshots WHERE project_id = ?1",
            [id],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        tx.execute("DELETE FROM projects WHERE id = ?1", [id])
            .map_err(|e| AppError::Database(e.to_string()))?;
        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    // ========== Project Skill Deployments ==========

    pub fn list_project_deployments(
        &self,
        project_id: &str,
    ) -> Result<Vec<ProjectSkillDeploymentRecord>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, target, directory, skill_id, skill_installation_id,
                        mode, managed_link_target, deployed_hash, last_materialized_hash,
                        baseline_source, git_exclude_ref, deployed_at, updated_at, detached_at
                 FROM project_skill_deployments
                 WHERE project_id = ?1
                 ORDER BY directory ASC, target ASC",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let iter = stmt
            .query_map([project_id], row_to_deployment)
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn list_all_project_deployments(
        &self,
    ) -> Result<Vec<ProjectSkillDeploymentRecord>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, target, directory, skill_id, skill_installation_id,
                        mode, managed_link_target, deployed_hash, last_materialized_hash,
                        baseline_source, git_exclude_ref, deployed_at, updated_at, detached_at
                 FROM project_skill_deployments
                 ORDER BY project_id ASC, directory ASC, target ASC",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let iter = stmt
            .query_map([], row_to_deployment)
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn get_project_deployment(
        &self,
        project_id: &str,
        target: &str,
        directory: &str,
    ) -> Result<Option<ProjectSkillDeploymentRecord>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT id, project_id, target, directory, skill_id, skill_installation_id,
                    mode, managed_link_target, deployed_hash, last_materialized_hash,
                    baseline_source, git_exclude_ref, deployed_at, updated_at, detached_at
             FROM project_skill_deployments
             WHERE project_id = ?1 AND target = ?2 AND directory = ?3",
            params![project_id, target, directory],
            row_to_deployment,
        )
        .optional()
        .map_err(|e| AppError::Database(e.to_string()))
    }

    pub fn save_project_deployment(
        &self,
        dep: &ProjectSkillDeploymentRecord,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO project_skill_deployments (
                id, project_id, target, directory, skill_id, skill_installation_id,
                mode, managed_link_target, deployed_hash, last_materialized_hash,
                baseline_source, git_exclude_ref, deployed_at, updated_at, detached_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(project_id, target, directory) DO UPDATE SET
                id = excluded.id,
                skill_id = excluded.skill_id,
                skill_installation_id = excluded.skill_installation_id,
                mode = excluded.mode,
                managed_link_target = excluded.managed_link_target,
                deployed_hash = excluded.deployed_hash,
                last_materialized_hash = excluded.last_materialized_hash,
                baseline_source = excluded.baseline_source,
                git_exclude_ref = excluded.git_exclude_ref,
                deployed_at = excluded.deployed_at,
                updated_at = excluded.updated_at,
                detached_at = excluded.detached_at",
            params![
                dep.id,
                dep.project_id,
                dep.target,
                dep.directory,
                dep.skill_id,
                dep.skill_installation_id,
                dep.mode,
                dep.managed_link_target,
                dep.deployed_hash,
                dep.last_materialized_hash,
                dep.baseline_source,
                dep.git_exclude_ref,
                dep.deployed_at,
                dep.updated_at,
                dep.detached_at,
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn delete_project_deployment(&self, id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute("DELETE FROM project_skill_deployments WHERE id = ?1", [id])
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn find_deployments_by_skill(
        &self,
        skill_id: Option<&str>,
        installation_id: Option<&str>,
    ) -> Result<Vec<ProjectSkillDeploymentRecord>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, target, directory, skill_id, skill_installation_id,
                        mode, managed_link_target, deployed_hash, last_materialized_hash,
                        baseline_source, git_exclude_ref, deployed_at, updated_at, detached_at
                 FROM project_skill_deployments
                 WHERE (?1 IS NOT NULL AND skill_id = ?1)
                    OR (?2 IS NOT NULL AND skill_installation_id = ?2)
                 ORDER BY project_id ASC, target ASC, directory ASC",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let iter = stmt
            .query_map(params![skill_id, installation_id], row_to_deployment)
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn find_deployments_sharing_git_exclude_ref(
        &self,
        git_exclude_ref: &str,
    ) -> Result<Vec<ProjectSkillDeploymentRecord>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, target, directory, skill_id, skill_installation_id,
                        mode, managed_link_target, deployed_hash, last_materialized_hash,
                        baseline_source, git_exclude_ref, deployed_at, updated_at, detached_at
                 FROM project_skill_deployments
                 WHERE git_exclude_ref = ?1",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let iter = stmt
            .query_map([git_exclude_ref], row_to_deployment)
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn clear_git_exclude_ref_for_project_and_ref(
        &self,
        project_id: &str,
        git_exclude_ref: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "UPDATE project_skill_deployments
             SET git_exclude_ref = NULL
             WHERE project_id = ?1 AND git_exclude_ref = ?2",
            params![project_id, git_exclude_ref],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    // ========== Project Rule Snapshots ==========

    pub fn list_rule_snapshots(
        &self,
        project_id: &str,
        relative_path: Option<&str>,
    ) -> Result<Vec<ProjectRuleSnapshotRecord>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut out = Vec::new();
        if let Some(rel) = relative_path {
            let mut stmt = conn
                .prepare(
                    "SELECT id, project_id, relative_path, file_existed, content, content_hash,
                            prompt_id, action, created_at
                     FROM project_rule_snapshots
                     WHERE project_id = ?1 AND relative_path = ?2
                     ORDER BY created_at DESC, rowid DESC",
                )
                .map_err(|e| AppError::Database(e.to_string()))?;
            let iter = stmt
                .query_map(params![project_id, rel], row_to_rule_snapshot)
                .map_err(|e| AppError::Database(e.to_string()))?;
            for item in iter {
                out.push(item.map_err(|e| AppError::Database(e.to_string()))?);
            }
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, project_id, relative_path, file_existed, content, content_hash,
                            prompt_id, action, created_at
                     FROM project_rule_snapshots
                     WHERE project_id = ?1
                     ORDER BY created_at DESC, rowid DESC",
                )
                .map_err(|e| AppError::Database(e.to_string()))?;
            let iter = stmt
                .query_map([project_id], row_to_rule_snapshot)
                .map_err(|e| AppError::Database(e.to_string()))?;
            for item in iter {
                out.push(item.map_err(|e| AppError::Database(e.to_string()))?);
            }
        }
        Ok(out)
    }

    pub fn get_rule_snapshot(
        &self,
        id: &str,
    ) -> Result<Option<ProjectRuleSnapshotRecord>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT id, project_id, relative_path, file_existed, content, content_hash,
                    prompt_id, action, created_at
             FROM project_rule_snapshots WHERE id = ?1",
            [id],
            row_to_rule_snapshot,
        )
        .optional()
        .map_err(|e| AppError::Database(e.to_string()))
    }

    pub fn insert_rule_snapshot_capped(
        &self,
        snapshot: &ProjectRuleSnapshotRecord,
        max_per_file: usize,
    ) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        tx.execute(
            "INSERT INTO project_rule_snapshots (
                id, project_id, relative_path, file_existed, content,
                content_hash, prompt_id, action, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                snapshot.id,
                snapshot.project_id,
                snapshot.relative_path,
                i64::from(snapshot.file_existed),
                snapshot.content,
                snapshot.content_hash,
                snapshot.prompt_id,
                snapshot.action,
                snapshot.created_at,
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        if max_per_file > 0 {
            tx.execute(
                "DELETE FROM project_rule_snapshots
                 WHERE project_id = ?1 AND relative_path = ?2
                   AND id NOT IN (
                     SELECT id FROM project_rule_snapshots
                     WHERE project_id = ?1 AND relative_path = ?2
                     ORDER BY created_at DESC, rowid DESC
                     LIMIT ?3
                   )",
                params![
                    snapshot.project_id,
                    snapshot.relative_path,
                    max_per_file as i64
                ],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    // ========== Skill Operation Journal ==========

    pub fn insert_operation_journal(
        &self,
        rec: &SkillOperationJournalRecord,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT OR REPLACE INTO skill_operation_journal (
                op_id, op_type, phase, skill_id, project_id, target, directory,
                staging_path, backup_path, dest_path, payload_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                rec.op_id,
                rec.op_type,
                rec.phase,
                rec.skill_id,
                rec.project_id,
                rec.target,
                rec.directory,
                rec.staging_path,
                rec.backup_path,
                rec.dest_path,
                rec.payload_json,
                rec.created_at,
                rec.updated_at,
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn update_operation_journal_phase(
        &self,
        op_id: &str,
        phase: &str,
        payload_json: Option<&str>,
        updated_at: i64,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        if let Some(payload) = payload_json {
            conn.execute(
                "UPDATE skill_operation_journal
                 SET phase = ?2, payload_json = ?3, updated_at = ?4
                 WHERE op_id = ?1",
                params![op_id, phase, payload, updated_at],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        } else {
            conn.execute(
                "UPDATE skill_operation_journal
                 SET phase = ?2, updated_at = ?3
                 WHERE op_id = ?1",
                params![op_id, phase, updated_at],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        Ok(())
    }

    pub fn list_operation_journals(&self) -> Result<Vec<SkillOperationJournalRecord>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT op_id, op_type, phase, skill_id, project_id, target, directory,
                        staging_path, backup_path, dest_path, payload_json, created_at, updated_at
                 FROM skill_operation_journal
                 ORDER BY created_at ASC, rowid ASC",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let iter = stmt
            .query_map([], row_to_journal)
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn delete_operation_journal(&self, op_id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM skill_operation_journal WHERE op_id = ?1",
            [op_id],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }
}
