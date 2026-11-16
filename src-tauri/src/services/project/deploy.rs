//! 项目级 Skills 部署、更新、Promote、Push/Import、冲突解决与卸载清理

use anyhow::{anyhow, bail, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

use crate::app_config::InstalledSkill;
use crate::database::dao::projects::{ProjectRecord, ProjectSkillDeploymentRecord};
use crate::database::Database;
use crate::services::project::fs_safety::{
    capture_fs_identity_follow, compute_skill_tree_fingerprint, copy_validated_skill_tree,
    create_dir_symlink, get_project_staging_root, is_symlink, remove_path_any,
    swap_staged_with_verified_backup, validate_skill_directory_name, validate_skill_tree,
    verify_relative_chain_no_symlinks, FsIdentity,
};
use crate::services::project::git_exclude::{
    prepare_git_exclude_for_symlink, release_git_exclude_ref,
};
use crate::services::project::journal::{
    acquire_journal_op_lock, recover_pending_operations_locked, ExtraSwapPaths, JournalBeginSpec,
    JournalGuard, JournalPayload,
};
use crate::services::project::project_op_lock;
use crate::services::skill::{skill_state_read_guard, SkillService};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSkillRef {
    pub target: String,
    pub directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployToProjectResult {
    pub deployed: Vec<ProjectSkillDeploymentRecord>,
    pub skipped: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployGroupToProjectResult {
    pub deployed: Vec<ProjectSkillDeploymentRecord>,
    pub skipped: Vec<String>,
    pub warnings: Vec<String>,
    pub missing_from_library: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProjectSkillRequest {
    pub target: String,
    pub directory: String,
    pub overwrite_existing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOrImportResult {
    pub skill: InstalledSkill,
    pub deployment: ProjectSkillDeploymentRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileDiff {
    pub relative_path: String,
    /// "added" | "removed" | "modified" | "unchanged"
    pub change_type: String,
    pub is_binary: bool,
    pub project_content: Option<String>,
    pub global_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillDiffResult {
    pub target: String,
    pub directory: String,
    pub project_path: String,
    pub global_path: Option<String>,
    pub files: Vec<SkillFileDiff>,
}

fn target_segments(target: &str) -> Result<[&'static str; 2]> {
    match target {
        "agents" => Ok([".agents", "skills"]),
        "claude" => Ok([".claude", "skills"]),
        other => bail!("不支持的部署目标: {other}（仅支持 agents / claude）"),
    }
}

pub(crate) fn verify_project_usable_and_identity(project: &ProjectRecord) -> Result<PathBuf> {
    if project.archived_at.is_some() {
        bail!("项目已归档，请先恢复归档后再修改其 Skills 或 Rules");
    }
    let root = Path::new(&project.root_path);
    if !root.is_dir() {
        bail!("项目根目录不存在或不可访问: {}", root.display());
    }
    if let Some(ref expected_raw) = project.fs_identity {
        let expected = FsIdentity::from_json(expected_raw)?;
        let actual = capture_fs_identity_follow(root)?;
        if expected != actual {
            bail!(
                "项目目录已被移动或替换（文件系统身份不匹配），请先在项目设置中执行「迁移路径」: {}",
                root.display()
            );
        }
    }
    Ok(root.to_path_buf())
}

fn validate_targets_list(targets: &[String]) -> Result<Vec<String>> {
    if targets.is_empty() {
        bail!("请至少选择一个部署目标（agents 或 claude）");
    }
    let mut normalized = Vec::new();
    // 保证 agents 排在 claude 之前，便于双目标 Copy 自动建相对软链
    for pref in ["agents", "claude"] {
        if targets.iter().any(|t| t == pref) {
            normalized.push(pref.to_string());
        }
    }
    for t in targets {
        if t != "agents" && t != "claude" {
            bail!("不支持的部署目标: {t}");
        }
    }
    Ok(normalized)
}

pub fn deploy_skills_to_project(
    db: &Arc<Database>,
    project_id: &str,
    skill_ids: &[String],
    targets: &[String],
    mode_override: Option<&str>,
    overwrite_conflicts: bool,
) -> Result<DeployToProjectResult> {
    let lock = project_op_lock(project_id);
    let _project_guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let _skill_read = skill_state_read_guard();
    let _journal_lock = acquire_journal_op_lock();
    let _ = recover_pending_operations_locked(db, &_journal_lock)?;

    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let root = verify_project_usable_and_identity(&project)?;
    let ordered_targets = validate_targets_list(targets)?;
    let mode = mode_override.unwrap_or(&project.default_mode);
    if mode != "copy" && mode != "symlink" {
        bail!("不支持的部署模式: {mode}（仅支持 copy / symlink）");
    }

    let ssot_dir = SkillService::resolve_ssot_dir_no_create();
    let global_skills = db.get_all_installed_skills()?;
    let now = Utc::now().timestamp();

    let mut deployed = Vec::new();
    let mut skipped = Vec::new();
    let mut warnings = Vec::new();

    for skill_id in skill_ids {
        let skill = global_skills
            .get(skill_id)
            .ok_or_else(|| anyhow!("全局库中不存在 Skill: {skill_id}"))?;
        let directory = validate_skill_directory_name(&skill.directory)?;
        let source_dir = ssot_dir.join(&directory);
        if !source_dir.is_dir() || is_symlink(&source_dir) {
            bail!(
                "全局 SSOT 中缺少合法的 Skill 目录: {}",
                source_dir.display()
            );
        }
        validate_skill_tree(&source_dir)?;
        let ssot_fp = compute_skill_tree_fingerprint(&source_dir)?;

        let mut agents_deployed_for_alias = false;

        for target in &ordered_targets {
            let segs = target_segments(target)?;
            verify_relative_chain_no_symlinks(&root, &segs, true)?;
            let dest_dir = root.join(segs[0]).join(segs[1]).join(&directory);

            let existing_dep = db.get_project_deployment(project_id, target, &directory)?;
            let existing_disk = fs::symlink_metadata(&dest_dir).ok();
            let existing_disk_fp = if existing_disk
                .as_ref()
                .is_some_and(|m| !m.file_type().is_symlink() && m.is_dir())
            {
                compute_skill_tree_fingerprint(&dest_dir).ok()
            } else {
                None
            };

            if existing_disk.is_some() && !overwrite_conflicts {
                let already_same = if mode == "symlink" && is_symlink(&dest_dir) {
                    crate::services::project::fs_safety::resolve_symlink_target_canonical(&dest_dir)
                        .ok()
                        .zip(source_dir.canonicalize().ok())
                        .is_some_and(|(a, b)| a == b)
                } else {
                    existing_disk_fp.as_deref() == Some(ssot_fp.as_str())
                };

                if already_same
                    && existing_dep
                        .as_ref()
                        .is_some_and(|d| d.detached_at.is_none())
                {
                    skipped.push(format!("{target}/{directory} (已同步)"));
                    if target == "agents" {
                        agents_deployed_for_alias = true;
                    }
                    continue;
                }
                skipped.push(format!("{target}/{directory} (目标已存在，未覆盖)"));
                continue;
            }

            if mode == "symlink" {
                let git_exclude_ref =
                    prepare_git_exclude_for_symlink(&project, target, &directory)?;

                let op_nonce = Uuid::new_v4().to_string();
                let stage_root =
                    get_project_staging_root(&root, target)?.join(format!("op-{op_nonce}"));
                fs::create_dir_all(&stage_root)?;
                let staged_link = stage_root.join("new_link");
                let backup_old = stage_root.join("bak");
                create_dir_symlink(&source_dir, &staged_link)?;

                let staged_s = staged_link.to_string_lossy();
                let backup_s = backup_old.to_string_lossy();
                let dest_s = dest_dir.to_string_lossy();
                let guard = JournalGuard::begin(
                    db,
                    JournalBeginSpec {
                        op_type: "deploy_project_skill",
                        skill_id: Some(&skill.id),
                        project_id: Some(project_id),
                        target: Some(target),
                        directory: Some(&directory),
                        staging_path: Some(&staged_s),
                        backup_path: Some(&backup_s),
                        dest_path: Some(&dest_s),
                    },
                    &JournalPayload {
                        remove_paths_on_commit: vec![stage_root.to_string_lossy().to_string()],
                        ..Default::default()
                    },
                )?;

                if existing_disk.is_some() {
                    if let Err(err) = swap_staged_with_verified_backup(
                        &staged_link,
                        &dest_dir,
                        Some(&backup_old),
                        None,
                    ) {
                        let _ = remove_path_any(&stage_root);
                        let _ = guard.finish();
                        return Err(err);
                    }
                } else {
                    if let Err(err) =
                        swap_staged_with_verified_backup(&staged_link, &dest_dir, None, None)
                    {
                        let _ = remove_path_any(&stage_root);
                        let _ = guard.finish();
                        return Err(err);
                    }
                }

                let rec = ProjectSkillDeploymentRecord {
                    id: existing_dep
                        .as_ref()
                        .map(|d| d.id.clone())
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    project_id: project_id.to_string(),
                    target: target.clone(),
                    directory: directory.clone(),
                    skill_id: Some(skill.id.clone()),
                    skill_installation_id: Some(skill.installation_id.clone()),
                    mode: "symlink".to_string(),
                    managed_link_target: Some(source_dir.to_string_lossy().to_string()),
                    deployed_hash: Some(ssot_fp.clone()),
                    last_materialized_hash: None,
                    baseline_source: Some("deploy".to_string()),
                    git_exclude_ref,
                    deployed_at: existing_dep.as_ref().map(|d| d.deployed_at).unwrap_or(now),
                    updated_at: now,
                    detached_at: None,
                };
                db.save_project_deployment(&rec)?;
                guard.mark_committed(None)?;
                let _ = remove_path_any(&stage_root);
                guard.finish()?;
                deployed.push(rec);
                continue;
            }

            // Copy mode: if target == "claude" and agents was deployed or verified synced in this pass,
            // attempt relative_alias (../../.agents/skills/<dir>) first, fallback to independent copy!
            let use_relative_alias = target == "claude"
                && ordered_targets.iter().any(|t| t == "agents")
                && agents_deployed_for_alias;

            let op_nonce = Uuid::new_v4().to_string();
            let stage_root =
                get_project_staging_root(&root, target)?.join(format!("op-{op_nonce}"));
            fs::create_dir_all(&stage_root)?;
            let staged_entry = stage_root.join("new");
            let backup_entry = stage_root.join("bak");

            let mut actual_mode = "copy".to_string();
            let mut managed_link_target: Option<String> = None;
            let mut actual_mat_hash: Option<String> = None;

            if use_relative_alias {
                let rel_target = PathBuf::from("..")
                    .join("..")
                    .join(".agents")
                    .join("skills")
                    .join(&directory);
                match create_dir_symlink(&rel_target, &staged_entry) {
                    Ok(()) => {
                        actual_mode = "relative_alias".to_string();
                        managed_link_target = Some(rel_target.to_string_lossy().to_string());
                    }
                    Err(err) => {
                        warnings.push(format!(
                            "Claude 目标无法创建相对软链 ({err})，已自动降级为独立拷贝: {directory}"
                        ));
                        let fp = copy_validated_skill_tree(&source_dir, &staged_entry)?;
                        actual_mat_hash = Some(fp);
                    }
                }
            } else {
                let fp = copy_validated_skill_tree(&source_dir, &staged_entry)?;
                actual_mat_hash = Some(fp);
            }

            let staged_s = staged_entry.to_string_lossy();
            let backup_s = backup_entry.to_string_lossy();
            let dest_s = dest_dir.to_string_lossy();
            let guard = JournalGuard::begin(
                db,
                JournalBeginSpec {
                    op_type: "deploy_project_skill",
                    skill_id: Some(&skill.id),
                    project_id: Some(project_id),
                    target: Some(target),
                    directory: Some(&directory),
                    staging_path: Some(&staged_s),
                    backup_path: Some(&backup_s),
                    dest_path: Some(&dest_s),
                },
                &JournalPayload {
                    remove_paths_on_commit: vec![stage_root.to_string_lossy().to_string()],
                    ..Default::default()
                },
            )?;

            if existing_disk.is_some() {
                if let Err(err) = swap_staged_with_verified_backup(
                    &staged_entry,
                    &dest_dir,
                    Some(&backup_entry),
                    None,
                ) {
                    let _ = remove_path_any(&stage_root);
                    let _ = guard.finish();
                    return Err(err);
                }
            } else {
                if let Err(err) =
                    swap_staged_with_verified_backup(&staged_entry, &dest_dir, None, None)
                {
                    let _ = remove_path_any(&stage_root);
                    let _ = guard.finish();
                    return Err(err);
                }
            }

            // If replacing an older symlink deployment with copy, release old git exclude ref
            if let Some(ref prev) = existing_dep {
                if let Some(ref prev_ref) = prev.git_exclude_ref {
                    let _ = release_git_exclude_ref(db, &project, target, &directory, prev_ref);
                }
            }

            let rec = ProjectSkillDeploymentRecord {
                id: existing_dep
                    .as_ref()
                    .map(|d| d.id.clone())
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
                project_id: project_id.to_string(),
                target: target.clone(),
                directory: directory.clone(),
                skill_id: Some(skill.id.clone()),
                skill_installation_id: Some(skill.installation_id.clone()),
                mode: actual_mode,
                managed_link_target,
                deployed_hash: Some(ssot_fp.clone()),
                last_materialized_hash: actual_mat_hash,
                baseline_source: Some("deploy".to_string()),
                git_exclude_ref: None,
                deployed_at: existing_dep.as_ref().map(|d| d.deployed_at).unwrap_or(now),
                updated_at: now,
                detached_at: None,
            };
            db.save_project_deployment(&rec)?;
            guard.mark_committed(None)?;
            let _ = remove_path_any(&stage_root);
            guard.finish()?;

            if target == "agents" {
                agents_deployed_for_alias = true;
            }
            deployed.push(rec);
        }
    }

    Ok(DeployToProjectResult {
        deployed,
        skipped,
        warnings,
    })
}

pub fn deploy_skill_group_to_project(
    db: &Arc<Database>,
    project_id: &str,
    group_id: &str,
    targets: &[String],
    mode_override: Option<&str>,
    overwrite_conflicts: bool,
) -> Result<DeployGroupToProjectResult> {
    let group = db
        .get_skill_group(group_id)?
        .ok_or_else(|| anyhow!("技能组不存在: {group_id}"))?;
    let group_skill_ids: Vec<String> =
        serde_json::from_str(&group.skills).map_err(|e| anyhow!("解析技能组条目失败: {e}"))?;

    let installed = db.get_all_installed_skills()?;
    let mut existing_ids = Vec::new();
    let mut missing_from_library = Vec::new();
    for id in &group_skill_ids {
        if installed.contains_key(id) {
            existing_ids.push(id.clone());
        } else {
            missing_from_library.push(id.clone());
        }
    }

    if existing_ids.is_empty() {
        return Ok(DeployGroupToProjectResult {
            deployed: Vec::new(),
            skipped: Vec::new(),
            warnings: vec!["该技能组中的所有技能均未在全局库中安装".to_string()],
            missing_from_library,
        });
    }

    let res = deploy_skills_to_project(
        db,
        project_id,
        &existing_ids,
        targets,
        mode_override,
        overwrite_conflicts,
    )?;

    Ok(DeployGroupToProjectResult {
        deployed: res.deployed,
        skipped: res.skipped,
        warnings: res.warnings,
        missing_from_library,
    })
}

/// 将全局最新版本更新（覆盖）同步到项目中已部署的 Copy 条目（包括 `Outdated` 与用户确认后以全局为准覆盖的 `Conflict`）。
pub fn update_project_deployments(
    db: &Arc<Database>,
    project_id: &str,
    items: &[TargetSkillRef],
    allow_overwrite_modified: bool,
) -> Result<Vec<ProjectSkillDeploymentRecord>> {
    let lock = project_op_lock(project_id);
    let _project_guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let _skill_read = skill_state_read_guard();
    let _journal_lock = acquire_journal_op_lock();
    let _ = recover_pending_operations_locked(db, &_journal_lock)?;

    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let root = verify_project_usable_and_identity(&project)?;
    let ssot_dir = SkillService::resolve_ssot_dir_no_create();
    let global_skills = db.get_all_installed_skills()?;
    let now = Utc::now().timestamp();

    let mut updated = Vec::new();
    for item in items {
        let directory = validate_skill_directory_name(&item.directory)?;
        let dep = db
            .get_project_deployment(project_id, &item.target, &directory)?
            .ok_or_else(|| anyhow!("未找到项目部署记录: {}/{}", item.target, directory))?;
        if dep.detached_at.is_some() {
            bail!("该部署记录已脱离托管，请先重新关联或移除后再更新");
        }
        if dep.mode == "symlink" || dep.mode == "relative_alias" {
            bail!(
                "目标 {}/{} 为软链模式，自动跟随源目录，无需拷贝更新",
                item.target,
                directory
            );
        }

        let skill = dep
            .skill_installation_id
            .as_deref()
            .and_then(|iid| global_skills.values().find(|s| s.installation_id == iid))
            .or_else(|| {
                if dep.skill_installation_id.is_none() {
                    dep.skill_id.as_deref().and_then(|id| global_skills.get(id))
                } else {
                    None
                }
            })
            .ok_or_else(|| {
                anyhow!("全局库中找不到匹配的 Skill 代数（SourceMissing），请先 Rebind 或 Push")
            })?;

        let source_dir = ssot_dir.join(&skill.directory);
        validate_skill_tree(&source_dir)?;
        let ssot_fp = compute_skill_tree_fingerprint(&source_dir)?;

        let segs = target_segments(&item.target)?;
        verify_relative_chain_no_symlinks(&root, &segs, false)?;
        let dest_dir = root.join(segs[0]).join(segs[1]).join(&directory);

        let disk_fp = if dest_dir.is_dir() && !is_symlink(&dest_dir) {
            Some(compute_skill_tree_fingerprint(&dest_dir)?)
        } else {
            None
        };

        if !allow_overwrite_modified {
            if let (Some(dfp), Some(base)) = (&disk_fp, &dep.deployed_hash) {
                if dfp != base {
                    bail!(
                        "项目内 {}/{} 存在本地修改或冲突，未确认强制以全局版本覆盖",
                        item.target,
                        directory
                    );
                }
            } else if dep.deployed_hash.is_none() && disk_fp.as_deref() != Some(ssot_fp.as_str()) {
                bail!(
                    "项目内 {}/{} 处于未知基线冲突状态，请先查看 Diff 或确认强制覆盖",
                    item.target,
                    directory
                );
            }
        }

        let op_nonce = Uuid::new_v4().to_string();
        let stage_root =
            get_project_staging_root(&root, &item.target)?.join(format!("op-{op_nonce}"));
        fs::create_dir_all(&stage_root)?;
        let staged_new = stage_root.join("new");
        let backup_old = stage_root.join("bak");
        let materialized_fp = copy_validated_skill_tree(&source_dir, &staged_new)?;

        let staged_s = staged_new.to_string_lossy();
        let backup_s = backup_old.to_string_lossy();
        let dest_s = dest_dir.to_string_lossy();
        let guard = JournalGuard::begin(
            db,
            JournalBeginSpec {
                op_type: "update_project_skill",
                skill_id: Some(&skill.id),
                project_id: Some(project_id),
                target: Some(&item.target),
                directory: Some(&directory),
                staging_path: Some(&staged_s),
                backup_path: Some(&backup_s),
                dest_path: Some(&dest_s),
            },
            &JournalPayload {
                remove_paths_on_commit: vec![stage_root.to_string_lossy().to_string()],
                ..Default::default()
            },
        )?;

        if let Err(err) = swap_staged_with_verified_backup(
            &staged_new,
            &dest_dir,
            Some(&backup_old),
            disk_fp.as_deref(),
        ) {
            let _ = remove_path_any(&stage_root);
            let _ = guard.finish();
            return Err(err);
        }

        let mut next_dep = dep.clone();
        next_dep.skill_id = Some(skill.id.clone());
        next_dep.skill_installation_id = Some(skill.installation_id.clone());
        next_dep.deployed_hash = Some(ssot_fp);
        next_dep.last_materialized_hash = Some(materialized_fp);
        next_dep.baseline_source = Some("update".to_string());
        next_dep.updated_at = now;
        db.save_project_deployment(&next_dep)?;

        guard.mark_committed(None)?;
        let _ = remove_path_any(&stage_root);
        guard.finish()?;
        updated.push(next_dep);
    }

    Ok(updated)
}

/// 将 `.claude/skills/<dir>` 的独立副本提升（Promote）为 `.agents/skills/<dir>` 实目录 + `.claude/skills/<dir>` 相对软链。
pub fn promote_claude_deployment(
    db: &Arc<Database>,
    project_id: &str,
    directory: &str,
    overwrite_agents: bool,
) -> Result<(ProjectSkillDeploymentRecord, ProjectSkillDeploymentRecord)> {
    let lock = project_op_lock(project_id);
    let _project_guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let _skill_read = skill_state_read_guard();
    let _journal_lock = acquire_journal_op_lock();
    let _ = recover_pending_operations_locked(db, &_journal_lock)?;

    let directory = validate_skill_directory_name(directory)?;
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let root = verify_project_usable_and_identity(&project)?;

    verify_relative_chain_no_symlinks(&root, &[".claude", "skills"], false)?;
    verify_relative_chain_no_symlinks(&root, &[".agents", "skills"], true)?;

    let claude_dir = root.join(".claude").join("skills").join(&directory);
    let agents_dir = root.join(".agents").join("skills").join(&directory);

    if is_symlink(&claude_dir) || !claude_dir.is_dir() {
        bail!(
            "Claude 目标必须是独立实目录才可执行 Promote: {}",
            claude_dir.display()
        );
    }
    validate_skill_tree(&claude_dir)?;
    let claude_fp = compute_skill_tree_fingerprint(&claude_dir)?;

    let claude_dep = db.get_project_deployment(project_id, "claude", &directory)?;
    let agents_dep = db.get_project_deployment(project_id, "agents", &directory)?;

    let agents_exists = fs::symlink_metadata(&agents_dir).is_ok();
    let agents_fp = if agents_dir.is_dir() && !is_symlink(&agents_dir) {
        compute_skill_tree_fingerprint(&agents_dir).ok()
    } else {
        None
    };

    if agents_exists && !overwrite_agents && agents_fp.as_deref() != Some(claude_fp.as_str()) {
        bail!(
            ".agents/skills/{} 已存在且内容不一致，请先对比差异或确认覆盖后再 Promote",
            directory
        );
    }

    let op_nonce = Uuid::new_v4().to_string();
    let stage_agents_root =
        get_project_staging_root(&root, "agents")?.join(format!("op-{op_nonce}"));
    let stage_claude_root =
        get_project_staging_root(&root, "claude")?.join(format!("op-{op_nonce}"));
    fs::create_dir_all(&stage_agents_root)?;
    fs::create_dir_all(&stage_claude_root)?;

    let staged_agents_new = stage_agents_root.join("new");
    let backup_agents_old = stage_agents_root.join("bak");
    let staged_claude_link = stage_claude_root.join("new_link");
    let backup_claude_old = stage_claude_root.join("bak");

    let agents_mat_fp = copy_validated_skill_tree(&claude_dir, &staged_agents_new)?;
    let rel_target = PathBuf::from("..")
        .join("..")
        .join(".agents")
        .join("skills")
        .join(&directory);
    if let Err(err) = create_dir_symlink(&rel_target, &staged_claude_link) {
        let _ = remove_path_any(&stage_agents_root);
        let _ = remove_path_any(&stage_claude_root);
        bail!("当前系统环境不支持创建相对软链，无法执行 Promote: {err}");
    }

    let payload = JournalPayload {
        extra_swaps: vec![ExtraSwapPaths {
            staging_path: Some(staged_claude_link.to_string_lossy().to_string()),
            backup_path: Some(backup_claude_old.to_string_lossy().to_string()),
            dest_path: Some(claude_dir.to_string_lossy().to_string()),
        }],
        refresh_app_directories: Vec::new(),
        remove_paths_on_commit: vec![
            stage_agents_root.to_string_lossy().to_string(),
            stage_claude_root.to_string_lossy().to_string(),
        ],
    };

    let staged_agents_s = staged_agents_new.to_string_lossy();
    let backup_agents_s = backup_agents_old.to_string_lossy();
    let agents_dir_s = agents_dir.to_string_lossy();
    let guard = JournalGuard::begin(
        db,
        JournalBeginSpec {
            op_type: "promote_claude_skill",
            skill_id: claude_dep.as_ref().and_then(|d| d.skill_id.as_deref()),
            project_id: Some(project_id),
            target: Some("agents"),
            directory: Some(&directory),
            staging_path: Some(&staged_agents_s),
            backup_path: Some(&backup_agents_s),
            dest_path: Some(&agents_dir_s),
        },
        &payload,
    )?;

    // Swap 1: .agents/skills/<dir>
    if let Err(err) = swap_staged_with_verified_backup(
        &staged_agents_new,
        &agents_dir,
        agents_exists.then_some(backup_agents_old.as_path()),
        agents_fp.as_deref(),
    ) {
        let _ = remove_path_any(&stage_agents_root);
        let _ = remove_path_any(&stage_claude_root);
        let _ = guard.finish();
        return Err(err);
    }

    // Swap 2: .claude/skills/<dir> -> ../../.agents/skills/<dir>
    if let Err(err) = swap_staged_with_verified_backup(
        &staged_claude_link,
        &claude_dir,
        Some(&backup_claude_old),
        Some(&claude_fp),
    ) {
        // 回滚 Swap 1
        let _ = remove_path_any(&agents_dir);
        if backup_agents_old.exists() {
            let _ = crate::services::project::fs_safety::rename_noreplace(
                &backup_agents_old,
                &agents_dir,
            );
        }
        let _ = remove_path_any(&stage_agents_root);
        let _ = remove_path_any(&stage_claude_root);
        let _ = guard.finish();
        return Err(err);
    }

    let now = Utc::now().timestamp();
    let shared_skill_id = claude_dep
        .as_ref()
        .and_then(|d| d.skill_id.clone())
        .or_else(|| agents_dep.as_ref().and_then(|d| d.skill_id.clone()));
    let shared_inst_id = claude_dep
        .as_ref()
        .and_then(|d| d.skill_installation_id.clone())
        .or_else(|| {
            agents_dep
                .as_ref()
                .and_then(|d| d.skill_installation_id.clone())
        });
    let preserved_deployed_hash = claude_dep
        .as_ref()
        .and_then(|d| d.deployed_hash.clone())
        .or_else(|| agents_dep.as_ref().and_then(|d| d.deployed_hash.clone()));

    let next_agents = ProjectSkillDeploymentRecord {
        id: agents_dep
            .as_ref()
            .map(|d| d.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        project_id: project_id.to_string(),
        target: "agents".to_string(),
        directory: directory.clone(),
        skill_id: shared_skill_id.clone(),
        skill_installation_id: shared_inst_id.clone(),
        mode: "copy".to_string(),
        managed_link_target: None,
        deployed_hash: preserved_deployed_hash.clone(),
        last_materialized_hash: Some(agents_mat_fp),
        baseline_source: Some("promote".to_string()),
        git_exclude_ref: None,
        deployed_at: agents_dep.as_ref().map(|d| d.deployed_at).unwrap_or(now),
        updated_at: now,
        detached_at: None,
    };

    let next_claude = ProjectSkillDeploymentRecord {
        id: claude_dep
            .as_ref()
            .map(|d| d.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        project_id: project_id.to_string(),
        target: "claude".to_string(),
        directory: directory.clone(),
        skill_id: shared_skill_id,
        skill_installation_id: shared_inst_id,
        mode: "relative_alias".to_string(),
        managed_link_target: Some(rel_target.to_string_lossy().to_string()),
        deployed_hash: preserved_deployed_hash,
        last_materialized_hash: None,
        baseline_source: Some("promote".to_string()),
        git_exclude_ref: None,
        deployed_at: claude_dep.as_ref().map(|d| d.deployed_at).unwrap_or(now),
        updated_at: now,
        detached_at: None,
    };

    db.save_project_deployment(&next_agents)?;
    db.save_project_deployment(&next_claude)?;

    guard.mark_committed(None)?;
    let _ = remove_path_any(&stage_agents_root);
    let _ = remove_path_any(&stage_claude_root);
    guard.finish()?;

    Ok((next_agents, next_claude))
}

/// 从项目移除部署（strict cleanup 边界）：
/// - `action = "remove_if_clean"`：移除软链或「确认未修改的 MSkills 物化拷贝」；若拷贝已修改或来自接管，拒绝静默删除
/// - `action = "force_delete"`：显式确认删除磁盘实目录或软链
/// - `action = "detach_only"`：仅解除数据库托管关系与 `git_exclude_ref`，保留磁盘实目录
pub fn undeploy_project_skill(
    db: &Arc<Database>,
    project_id: &str,
    target: &str,
    directory: &str,
    action: &str,
) -> Result<()> {
    let lock = project_op_lock(project_id);
    let _project_guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let _skill_read = skill_state_read_guard();
    let _journal_lock = acquire_journal_op_lock();
    let _ = recover_pending_operations_locked(db, &_journal_lock)?;

    let directory = validate_skill_directory_name(directory)?;
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let root = verify_project_usable_and_identity(&project)?;
    let segs = target_segments(target)?;
    let dest_path = root.join(segs[0]).join(segs[1]).join(&directory);

    let dep = db.get_project_deployment(project_id, target, &directory)?;

    if action == "detach_only" {
        if let Some(d) = dep {
            if let Some(ref ref_val) = d.git_exclude_ref {
                let _ = release_git_exclude_ref(db, &project, target, &directory, ref_val);
            }
            db.delete_project_deployment(&d.id)?;
        }
        return Ok(());
    }

    verify_relative_chain_no_symlinks(&root, &segs, false)?;
    let disk_exists = fs::symlink_metadata(&dest_path).is_ok();
    if disk_exists {
        if is_symlink(&dest_path) {
            remove_path_any(&dest_path)?;
        } else if dest_path.is_dir() {
            if action != "force_delete" {
                let Some(ref d) = dep else {
                    bail!("该目录未受 MSkills 托管，拒绝自动删除（请使用确认删除或保留目录）");
                };
                if d.mode != "copy"
                    || d.last_materialized_hash.is_none()
                    || !matches!(
                        d.baseline_source.as_deref(),
                        Some("deploy" | "update" | "promote")
                    )
                {
                    bail!("该拷贝来自外部目录接管或重新关联，未授予自动删除权限；请选择「仅解除托管」或「确认强制删除」。");
                }
                let disk_fp = compute_skill_tree_fingerprint(&dest_path)?;
                if Some(disk_fp.as_str()) != d.last_materialized_hash.as_deref() {
                    bail!("项目内副本已被本地修改，拒绝自动删除；请选择「推送到全局」、「仅解除托管」或「确认强制删除」。");
                }
            }
            remove_path_any(&dest_path)?;
        } else if action == "force_delete" {
            remove_path_any(&dest_path)?;
        } else {
            bail!(
                "目标位置不是标准 Skill 目录或软链，拒绝删除: {}",
                dest_path.display()
            );
        }
    }

    if let Some(d) = dep {
        if let Some(ref ref_val) = d.git_exclude_ref {
            let _ = release_git_exclude_ref(db, &project, target, &directory, ref_val);
        }
        db.delete_project_deployment(&d.id)?;
    }
    Ok(())
}

/// 接管项目内已有但未托管（`Unmanaged` / `SameContentUnmanaged`）目录到指定或同名全局 Skill。
pub fn adopt_project_skill(
    db: &Arc<Database>,
    project_id: &str,
    target: &str,
    directory: &str,
    skill_id: Option<&str>,
) -> Result<ProjectSkillDeploymentRecord> {
    let lock = project_op_lock(project_id);
    let _project_guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let _skill_read = skill_state_read_guard();

    let directory = validate_skill_directory_name(directory)?;
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let root = verify_project_usable_and_identity(&project)?;
    let segs = target_segments(target)?;
    verify_relative_chain_no_symlinks(&root, &segs, false)?;
    let dest_dir = root.join(segs[0]).join(segs[1]).join(&directory);

    if is_symlink(&dest_dir) || !dest_dir.is_dir() {
        bail!(
            "只能接管项目内真实存在的 Skill 目录: {}",
            dest_dir.display()
        );
    }
    let disk_fp = compute_skill_tree_fingerprint(&dest_dir)?;

    let global_skills = db.get_all_installed_skills()?;
    let global = match skill_id {
        Some(id) => global_skills
            .get(id)
            .ok_or_else(|| anyhow!("全局库中不存在 Skill: {id}"))?,
        None => global_skills
            .values()
            .find(|s| s.directory.eq_ignore_ascii_case(&directory))
            .ok_or_else(|| anyhow!("全局库中未找到与目录 {directory} 匹配的 Skill，请指定要关联的全局 Skill 或执行 Import"))?,
    };

    let ssot_dir = SkillService::resolve_ssot_dir_no_create();
    let ssot_skill_dir = ssot_dir.join(&global.directory);
    let ssot_fp = if ssot_skill_dir.is_dir() {
        compute_skill_tree_fingerprint(&ssot_skill_dir).ok()
    } else {
        None
    };

    let common_baseline = if ssot_fp.as_deref() == Some(disk_fp.as_str()) {
        Some(disk_fp)
    } else {
        None
    };

    let now = Utc::now().timestamp();
    let rec = ProjectSkillDeploymentRecord {
        id: Uuid::new_v4().to_string(),
        project_id: project_id.to_string(),
        target: target.to_string(),
        directory,
        skill_id: Some(global.id.clone()),
        skill_installation_id: Some(global.installation_id.clone()),
        mode: "copy".to_string(),
        managed_link_target: None,
        deployed_hash: common_baseline,
        // 关键原则：接管操作绝不授予“可自动删除真实目录”的资格
        last_materialized_hash: None,
        baseline_source: Some("adopt".to_string()),
        git_exclude_ref: None,
        deployed_at: now,
        updated_at: now,
        detached_at: None,
    };
    db.save_project_deployment(&rec)?;
    Ok(rec)
}

/// 重新关联失去全局源或代数失配的部署记录（`SourceMissing` / generation mismatch）到新的全局 Skill 实例。
pub fn rebind_project_deployment(
    db: &Arc<Database>,
    project_id: &str,
    target: &str,
    directory: &str,
    skill_id: &str,
) -> Result<ProjectSkillDeploymentRecord> {
    let lock = project_op_lock(project_id);
    let _project_guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let _skill_read = skill_state_read_guard();

    let directory = validate_skill_directory_name(directory)?;
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let root = verify_project_usable_and_identity(&project)?;
    let segs = target_segments(target)?;
    let dest_dir = root.join(segs[0]).join(segs[1]).join(&directory);

    let mut dep = db
        .get_project_deployment(project_id, target, &directory)?
        .ok_or_else(|| anyhow!("部署记录不存在: {target}/{directory}"))?;

    let global = db
        .get_installed_skill(skill_id)?
        .ok_or_else(|| anyhow!("全局库中不存在目标 Skill: {skill_id}"))?;
    let ssot_dir = SkillService::resolve_ssot_dir_no_create();
    let ssot_skill_dir = ssot_dir.join(&global.directory);
    let ssot_fp = if ssot_skill_dir.is_dir() {
        compute_skill_tree_fingerprint(&ssot_skill_dir).ok()
    } else {
        None
    };

    let disk_fp = if dest_dir.is_dir() && !is_symlink(&dest_dir) {
        compute_skill_tree_fingerprint(&dest_dir).ok()
    } else {
        None
    };

    let common_baseline = match (disk_fp, ssot_fp) {
        (Some(d), Some(s)) if d == s => Some(d),
        _ => None,
    };

    let now = Utc::now().timestamp();
    dep.skill_id = Some(global.id);
    dep.skill_installation_id = Some(global.installation_id);
    dep.deployed_hash = common_baseline;
    // Rebind 绝不授予自动删除真实目录资格
    dep.last_materialized_hash = None;
    dep.baseline_source = Some("rebind".to_string());
    dep.detached_at = None;
    dep.updated_at = now;
    db.save_project_deployment(&dep)?;
    Ok(dep)
}

/// 清理磁盘已不存在的失效链接/丢失记录，并按共享引用计安全清除托管的 `git_exclude_ref`。
pub fn settle_missing_project_link(
    db: &Arc<Database>,
    project_id: &str,
    target: &str,
    directory: &str,
) -> Result<()> {
    undeploy_project_skill(db, project_id, target, directory, "detach_only")
}

/// 将项目内 Skill 推送回全局 SSOT（Modified / SourceMissing）或首次导入全局库（Unmanaged）。
pub fn push_skill_to_global(
    db: &Arc<Database>,
    project_id: &str,
    target: &str,
    directory: &str,
    overwrite_existing: bool,
) -> Result<PushOrImportResult> {
    let lock = project_op_lock(project_id);
    let _project_guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let directory = validate_skill_directory_name(directory)?;
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let root = verify_project_usable_and_identity(&project)?;
    let segs = target_segments(target)?;
    verify_relative_chain_no_symlinks(&root, &segs, false)?;

    let project_skill_dir = root.join(segs[0]).join(segs[1]).join(&directory);
    if is_symlink(&project_skill_dir) || !project_skill_dir.is_dir() {
        bail!("软链或缺失的目录无法 Push 回全局库，请直接在实目录上操作");
    }
    validate_skill_tree(&project_skill_dir)?;

    let existing_dep = db.get_project_deployment(project_id, target, &directory)?;
    let bound_inst_id = existing_dep
        .as_ref()
        .and_then(|d| d.skill_installation_id.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let target_skill_id = if let Some(iid) = bound_inst_id {
        db.get_all_installed_skills().ok().and_then(|m| {
            m.into_values()
                .find(|s| s.installation_id == iid)
                .map(|s| s.id)
        })
    } else {
        existing_dep.as_ref().and_then(|d| d.skill_id.clone())
    };

    if bound_inst_id.is_some() && target_skill_id.is_none() && !overwrite_existing {
        let old_sid = existing_dep.as_ref().and_then(|d| d.skill_id.as_deref());
        let reinstalled = match old_sid {
            Some(sid) => db.get_installed_skill(sid)?.is_some(),
            None => false,
        };
        if reinstalled {
            bail!("关联的全局 Skill 已卸载重装（代际变更），请先重新绑定或确认覆盖后再推送");
        }
    }

    // Note: if target_skill_id still exists in DB, allow overwrite when requested;
    // if SourceMissing (skill was uninstalled), target_skill_id might be None or absent in DB -> import fresh
    let resolved_existing_id = match target_skill_id {
        Some(ref id) if db.get_installed_skill(id)?.is_some() => Some(id.clone()),
        _ => None,
    };

    let effective_directory = if let Some(ref sid) = resolved_existing_id {
        db.get_installed_skill(sid)?
            .map(|s| s.directory)
            .unwrap_or_else(|| directory.clone())
    } else {
        directory.clone()
    };

    let (saved_skill, new_fp) = SkillService::commit_skill_to_global_ssot(
        db,
        &project_skill_dir,
        resolved_existing_id.as_deref(),
        &effective_directory,
        overwrite_existing || resolved_existing_id.is_some(),
    )?;

    let now = Utc::now().timestamp();
    let next_dep = ProjectSkillDeploymentRecord {
        id: existing_dep
            .as_ref()
            .map(|d| d.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        project_id: project_id.to_string(),
        target: target.to_string(),
        directory: directory.clone(),
        skill_id: Some(saved_skill.id.clone()),
        skill_installation_id: Some(saved_skill.installation_id.clone()),
        mode: existing_dep
            .as_ref()
            .map(|d| d.mode.clone())
            .unwrap_or_else(|| "copy".to_string()),
        managed_link_target: None,
        deployed_hash: Some(new_fp.clone()),
        // Push 本身不赋予原本未托管/已修改目录“可自动删除”资格；仅保留原本已持有的等值清理标记
        last_materialized_hash: existing_dep
            .as_ref()
            .and_then(|d| d.last_materialized_hash.clone())
            .filter(|h| h == &new_fp),
        baseline_source: Some("push".to_string()),
        git_exclude_ref: None,
        deployed_at: existing_dep.as_ref().map(|d| d.deployed_at).unwrap_or(now),
        updated_at: now,
        detached_at: None,
    };
    db.save_project_deployment(&next_dep)?;

    // 若同项目另一 target（例如 claude 的 relative_alias）指向同一个 .agents/skills/<dir>，同步刷新其基准指纹
    if target == "agents" {
        if let Some(mut alias_dep) = db.get_project_deployment(project_id, "claude", &directory)? {
            if alias_dep.mode == "relative_alias" {
                alias_dep.skill_id = Some(saved_skill.id.clone());
                alias_dep.skill_installation_id = Some(saved_skill.installation_id.clone());
                alias_dep.deployed_hash = Some(new_fp);
                alias_dep.updated_at = now;
                let _ = db.save_project_deployment(&alias_dep);
            }
        }
    }

    Ok(PushOrImportResult {
        skill: saved_skill,
        deployment: next_dep,
    })
}

pub fn import_project_skills(
    db: &Arc<Database>,
    project_id: &str,
    items: &[ImportProjectSkillRequest],
) -> Result<Vec<PushOrImportResult>> {
    let mut results = Vec::with_capacity(items.len());
    for item in items {
        let res = push_skill_to_global(
            db,
            project_id,
            &item.target,
            &item.directory,
            item.overwrite_existing,
        )?;
        results.push(res);
    }
    Ok(results)
}

pub fn diff_project_skill(
    db: &Arc<Database>,
    project_id: &str,
    target: &str,
    directory: &str,
) -> Result<ProjectSkillDiffResult> {
    let _skill_read = skill_state_read_guard();
    let directory = validate_skill_directory_name(directory)?;
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let root = verify_project_usable_and_identity(&project)?;
    let segs = target_segments(target)?;
    let project_skill_dir = root.join(segs[0]).join(segs[1]).join(&directory);

    let dep = db.get_project_deployment(project_id, target, &directory)?;
    let global_skills = db.get_all_installed_skills()?;
    let matched_global = dep
        .as_ref()
        .and_then(|d| d.skill_installation_id.as_deref())
        .and_then(|iid| global_skills.values().find(|s| s.installation_id == iid))
        .or_else(|| {
            dep.as_ref()
                .and_then(|d| d.skill_id.as_deref())
                .and_then(|sid| global_skills.get(sid))
        })
        .or_else(|| {
            global_skills
                .values()
                .find(|s| s.directory.eq_ignore_ascii_case(&directory))
        });

    let ssot_dir = SkillService::resolve_ssot_dir_no_create();
    let global_skill_dir = matched_global
        .map(|s| ssot_dir.join(&s.directory))
        .filter(|p| p.is_dir());

    let proj_files = collect_diff_files(&project_skill_dir)?;
    let glob_files = match &global_skill_dir {
        Some(dir) => collect_diff_files(dir)?,
        None => BTreeMap::new(),
    };

    let mut all_keys: BTreeSet<String> = proj_files.keys().cloned().collect();
    all_keys.extend(glob_files.keys().cloned());

    let mut files = Vec::new();
    for key in all_keys {
        match (proj_files.get(&key), glob_files.get(&key)) {
            (Some(p), Some(g)) => {
                let change_type = if p.raw == g.raw {
                    "unchanged"
                } else {
                    "modified"
                };
                files.push(SkillFileDiff {
                    relative_path: key,
                    change_type: change_type.to_string(),
                    is_binary: p.is_binary || g.is_binary,
                    project_content: p.text.clone(),
                    global_content: g.text.clone(),
                });
            }
            (Some(p), None) => {
                files.push(SkillFileDiff {
                    relative_path: key,
                    change_type: "added".to_string(),
                    is_binary: p.is_binary,
                    project_content: p.text.clone(),
                    global_content: None,
                });
            }
            (None, Some(g)) => {
                files.push(SkillFileDiff {
                    relative_path: key,
                    change_type: "removed".to_string(),
                    is_binary: g.is_binary,
                    project_content: None,
                    global_content: g.text.clone(),
                });
            }
            (None, None) => {}
        }
    }

    Ok(ProjectSkillDiffResult {
        target: target.to_string(),
        directory,
        project_path: project_skill_dir.to_string_lossy().to_string(),
        global_path: global_skill_dir.map(|p| p.to_string_lossy().to_string()),
        files,
    })
}

struct DiffFileBlob {
    raw: Vec<u8>,
    is_binary: bool,
    text: Option<String>,
}

const MAX_DIFF_TEXT_BYTES: usize = 512 * 1024;

fn collect_diff_files(root: &Path) -> Result<BTreeMap<String, DiffFileBlob>> {
    let mut out = BTreeMap::new();
    let real_root = if is_symlink(root) {
        crate::services::project::fs_safety::resolve_symlink_target_canonical(root)?
    } else if root.is_dir() {
        root.to_path_buf()
    } else {
        return Ok(out);
    };

    let mut stack = vec![(real_root, String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                continue;
            };
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            let rel = if prefix.is_empty() {
                name_str.to_string()
            } else {
                format!("{prefix}/{name_str}")
            };
            if meta.is_dir() {
                stack.push((path, rel));
            } else if meta.is_file() {
                let raw = fs::read(&path)?;
                let (is_binary, text) = if raw.len() > MAX_DIFF_TEXT_BYTES || raw.contains(&0) {
                    (true, None)
                } else {
                    match String::from_utf8(raw.clone()) {
                        Ok(t) => (false, Some(t)),
                        Err(_) => (true, None),
                    }
                };
                out.insert(
                    rel,
                    DiffFileBlob {
                        raw,
                        is_binary,
                        text,
                    },
                );
            }
        }
    }
    Ok(out)
}
