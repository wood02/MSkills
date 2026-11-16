//! 项目级 Skills & Rules 工作区服务（P2.1 + P2.2）

pub mod deploy;
pub mod fs_safety;
pub mod git_exclude;
pub mod journal;
pub mod rules;
pub mod scan;
#[cfg(test)]
mod tests;

use anyhow::{anyhow, bail, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use uuid::Uuid;

use crate::database::dao::projects::{ProjectRecord, ProjectSkillDeploymentRecord};
use crate::database::Database;
use crate::services::project::fs_safety::{
    capture_fs_identity_follow, compute_skill_tree_fingerprint,
    ensure_path_not_overlapping_global_roots, is_symlink, remove_path_any, FsIdentity,
};
use crate::services::project::git_exclude::{
    inspect_git_repo, purge_project_git_exclude_block, release_git_exclude_ref,
};
use crate::services::project::scan::{
    scan_project_internal_with_cache, FingerprintCache, ProjectSkillStatus,
};
use crate::services::skill::{skill_state_read_guard, SkillService};

pub(crate) fn project_op_lock(project_id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let map_mutex = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = map_mutex.lock().unwrap_or_else(|e| e.into_inner());
    Arc::clone(
        map.entry(project_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(()))),
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListItem {
    pub project: ProjectRecord,
    pub root_exists: bool,
    pub identity_matched: bool,
    pub is_git_repo: bool,
    pub is_worktree: bool,
    pub deployed_count: usize,
    pub synced_count: usize,
    pub outdated_count: usize,
    pub modified_count: usize,
    pub conflict_count: usize,
    pub unmanaged_count: usize,
    pub broken_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedProject {
    pub root_path: String,
    pub name: String,
    pub session_count: usize,
    pub last_active_at: Option<i64>,
    pub providers: Vec<String>,
    pub has_existing_skills: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddProjectInput {
    pub root_path: String,
    pub name: Option<String>,
    pub default_mode: Option<String>,
    pub enabled_targets: Option<Vec<String>>,
    pub auto_git_exclude: Option<bool>,
    #[serde(default)]
    pub reactivate_if_archived: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectInput {
    pub id: String,
    pub name: Option<String>,
    pub default_mode: Option<String>,
    pub enabled_targets: Option<Vec<String>>,
    pub auto_git_exclude: Option<bool>,
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoveProjectOptions {
    #[serde(default)]
    pub cleanup_links: bool,
    #[serde(default)]
    pub delete_unmodified_copies: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveProjectPreview {
    pub project_id: String,
    pub managed_links_count: usize,
    pub clean_copies_count: usize,
    pub modified_or_adopted_copies_count: usize,
    pub rule_snapshots_count: usize,
    pub has_git_exclude_entries: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveProjectResult {
    pub removed_project_id: String,
    pub removed_links_count: usize,
    pub deleted_clean_copies_count: usize,
    pub preserved_copies_count: usize,
}

fn normalize_project_root(raw: &str) -> Result<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        bail!("项目路径不能为空");
    }
    let candidate = PathBuf::from(trimmed);
    if !candidate.exists() {
        bail!("项目目录不存在: {}", candidate.display());
    }
    if !candidate.is_dir() {
        bail!("所选路径不是目录: {}", candidate.display());
    }
    ensure_path_not_overlapping_global_roots(&candidate)?;
    candidate
        .canonicalize()
        .map_err(|e| anyhow!("无法规范化项目路径 {}: {e}", candidate.display()))
}

fn validate_project_config(mode: &str, targets: &[String]) -> Result<()> {
    if mode != "copy" && mode != "symlink" {
        bail!("不支持的默认部署模式: {mode}（仅支持 copy / symlink）");
    }
    if targets.is_empty() {
        bail!("请至少启用一个目标目录（agents 或 claude）");
    }
    for t in targets {
        if t != "agents" && t != "claude" {
            bail!("不支持的目标目录: {t}");
        }
    }
    Ok(())
}

pub fn list_projects_with_stats(
    db: &Arc<Database>,
    include_archived: bool,
) -> Result<Vec<ProjectListItem>> {
    let _skill_guard = skill_state_read_guard();
    let projects = db.list_projects(include_archived)?;
    let global_skills = db.get_all_installed_skills()?;
    let ssot_dir = SkillService::resolve_ssot_dir_no_create();

    let mut fp_cache = FingerprintCache::default();
    let mut out = Vec::with_capacity(projects.len());
    for project in projects {
        let deps = db.list_project_deployments(&project.id)?;
        let scan = scan_project_internal_with_cache(
            &project,
            &deps,
            &global_skills,
            &ssot_dir,
            &mut fp_cache,
        )?;
        let repo_info = if scan.root_exists {
            inspect_git_repo(Path::new(&project.root_path))
                .ok()
                .flatten()
        } else {
            None
        };

        let mut synced_count = 0usize;
        let mut outdated_count = 0usize;
        let mut modified_count = 0usize;
        let mut conflict_count = 0usize;
        let mut unmanaged_count = 0usize;
        let mut broken_count = 0usize;
        let mut deployed_count = 0usize;

        for e in &scan.entries {
            if e.mode.is_some() {
                deployed_count += 1;
            }
            match e.status {
                ProjectSkillStatus::Synced => synced_count += 1,
                ProjectSkillStatus::Outdated => outdated_count += 1,
                ProjectSkillStatus::Modified => modified_count += 1,
                ProjectSkillStatus::Conflict => conflict_count += 1,
                ProjectSkillStatus::Unmanaged | ProjectSkillStatus::SameContentUnmanaged => {
                    unmanaged_count += 1
                }
                ProjectSkillStatus::Broken
                | ProjectSkillStatus::InvalidStructure
                | ProjectSkillStatus::SourceMissing => broken_count += 1,
            }
        }

        out.push(ProjectListItem {
            project,
            root_exists: scan.root_exists,
            identity_matched: scan.identity_matched,
            is_git_repo: repo_info.is_some(),
            is_worktree: repo_info.as_ref().is_some_and(|r| r.is_worktree),
            deployed_count,
            synced_count,
            outdated_count,
            modified_count,
            conflict_count,
            unmanaged_count,
            broken_count,
        });
    }
    Ok(out)
}

pub fn suggest_projects_from_sessions(db: &Arc<Database>) -> Result<Vec<SuggestedProject>> {
    let existing = db.list_projects(true)?;
    let mut existing_roots: BTreeSet<String> = BTreeSet::new();
    let mut existing_ids: Vec<FsIdentity> = Vec::new();
    for p in existing {
        existing_roots.insert(p.root_path.clone());
        if let Ok(canon) = Path::new(&p.root_path).canonicalize() {
            existing_roots.insert(canon.to_string_lossy().to_string());
        }
        if let Some(ref raw_id) = p.fs_identity {
            if let Ok(id) = FsIdentity::from_json(raw_id) {
                existing_ids.push(id);
            }
        }
    }

    let sessions = crate::session_manager::scan_sessions();
    struct Agg {
        root_path: PathBuf,
        session_count: usize,
        last_active_at: Option<i64>,
        providers: BTreeSet<String>,
    }

    let mut grouped: BTreeMap<String, Agg> = BTreeMap::new();
    for s in sessions {
        let Some(ref raw_dir) = s.project_dir else {
            continue;
        };
        let candidate = Path::new(raw_dir);
        if !candidate.is_dir() {
            continue;
        }
        if ensure_path_not_overlapping_global_roots(candidate).is_err() {
            continue;
        }
        let Ok(canon) = candidate.canonicalize() else {
            continue;
        };
        let key = canon.to_string_lossy().to_string();
        if existing_roots.contains(&key) {
            continue;
        }
        if let Ok(id) = capture_fs_identity_follow(&canon) {
            if existing_ids.contains(&id) {
                continue;
            }
        }

        let entry = grouped.entry(key).or_insert_with(|| Agg {
            root_path: canon,
            session_count: 0,
            last_active_at: None,
            providers: BTreeSet::new(),
        });
        entry.session_count += 1;
        entry.providers.insert(s.provider_id);
        if let Some(ts) = s.last_active_at.or(s.created_at) {
            entry.last_active_at = Some(entry.last_active_at.map_or(ts, |prev| prev.max(ts)));
        }
    }

    let mut out: Vec<SuggestedProject> = grouped
        .into_values()
        .map(|agg| {
            let name = agg
                .root_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| agg.root_path.to_string_lossy().to_string());
            let has_existing_skills = agg.root_path.join(".agents").join("skills").is_dir()
                || agg.root_path.join(".claude").join("skills").is_dir();
            SuggestedProject {
                root_path: agg.root_path.to_string_lossy().to_string(),
                name,
                session_count: agg.session_count,
                last_active_at: agg.last_active_at,
                providers: agg.providers.into_iter().collect(),
                has_existing_skills,
            }
        })
        .collect();

    out.sort_by(|a, b| {
        b.last_active_at
            .cmp(&a.last_active_at)
            .then_with(|| b.session_count.cmp(&a.session_count))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

pub fn add_project(db: &Arc<Database>, input: AddProjectInput) -> Result<ProjectRecord> {
    let canon_root = normalize_project_root(&input.root_path)?;
    let root_str = canon_root.to_string_lossy().to_string();
    let fs_identity = capture_fs_identity_follow(&canon_root)?;
    let fs_identity_json = fs_identity.to_json()?;

    let default_mode = input.default_mode.unwrap_or_else(|| "copy".to_string());
    let enabled_targets = input
        .enabled_targets
        .unwrap_or_else(|| vec!["agents".to_string()]);
    validate_project_config(&default_mode, &enabled_targets)?;

    // Check duplicates by root_path or fs_identity (including archived)
    let all = db.list_projects(true)?;
    if let Some(mut existing) = all.into_iter().find(|p| {
        p.root_path == root_str
            || Path::new(&p.root_path)
                .canonicalize()
                .ok()
                .is_some_and(|c| c == canon_root)
            || p.fs_identity
                .as_deref()
                .and_then(|raw| FsIdentity::from_json(raw).ok())
                .is_some_and(|id| id == fs_identity)
    }) {
        if existing.archived_at.is_some() {
            if !input.reactivate_if_archived {
                bail!(
                    "该项目此前已归档（{}），可选择恢复归档或先清理旧记录。",
                    existing.name
                );
            }
            let now = Utc::now().timestamp();
            if let Some(name) = input.name.filter(|s| !s.trim().is_empty()) {
                existing.name = name.trim().to_string();
            }
            existing.root_path = root_str;
            existing.fs_identity = Some(fs_identity_json);
            existing.default_mode = default_mode;
            existing.enabled_targets = enabled_targets;
            if let Some(auto_git) = input.auto_git_exclude {
                existing.auto_git_exclude = auto_git;
            }
            existing.archived_at = None;
            existing.updated_at = now;
            db.save_project(&existing)?;
            return Ok(existing);
        }
        bail!("该项目已添加过（{}），无需重复登记", existing.name);
    }

    let name = input
        .name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            canon_root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| root_str.clone())
        });

    let now = Utc::now().timestamp();
    let rec = ProjectRecord {
        id: Uuid::new_v4().to_string(),
        name,
        root_path: root_str,
        fs_identity: Some(fs_identity_json),
        default_mode,
        enabled_targets,
        auto_git_exclude: input.auto_git_exclude.unwrap_or(false),
        archived_at: None,
        created_at: now,
        updated_at: now,
    };
    db.save_project(&rec)?;
    Ok(rec)
}

pub fn update_project(db: &Arc<Database>, input: UpdateProjectInput) -> Result<ProjectRecord> {
    let lock = project_op_lock(&input.id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let mut project = db
        .get_project(&input.id)?
        .ok_or_else(|| anyhow!("项目不存在: {}", input.id))?;

    if let Some(name) = input.name {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            bail!("项目名称不能为空");
        }
        project.name = trimmed.to_string();
    }
    let next_mode = input
        .default_mode
        .unwrap_or_else(|| project.default_mode.clone());
    let next_targets = input
        .enabled_targets
        .unwrap_or_else(|| project.enabled_targets.clone());
    validate_project_config(&next_mode, &next_targets)?;
    project.default_mode = next_mode;
    project.enabled_targets = next_targets;

    if let Some(auto_git) = input.auto_git_exclude {
        project.auto_git_exclude = auto_git;
    }
    let now = Utc::now().timestamp();
    if let Some(archived) = input.archived {
        project.archived_at = archived.then_some(now);
    }
    project.updated_at = now;
    db.save_project(&project)?;
    Ok(project)
}

pub fn relocate_project(
    db: &Arc<Database>,
    project_id: &str,
    new_root_path: &str,
) -> Result<ProjectRecord> {
    let lock = project_op_lock(project_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let mut project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let canon_root = normalize_project_root(new_root_path)?;
    let root_str = canon_root.to_string_lossy().to_string();
    let fs_identity = capture_fs_identity_follow(&canon_root)?.to_json()?;

    if let Some(conflict) = db
        .get_project_by_root_path(&root_str)?
        .filter(|p| p.id != project_id)
    {
        bail!("目标路径已被另一个项目占用: {}", conflict.name);
    }

    project.root_path = root_str;
    project.fs_identity = Some(fs_identity);
    project.updated_at = Utc::now().timestamp();
    db.save_project(&project)?;
    Ok(project)
}

fn is_clean_materialized_copy(project_root: &Path, dep: &ProjectSkillDeploymentRecord) -> bool {
    if dep.detached_at.is_some()
        || dep.mode != "copy"
        || dep.last_materialized_hash.is_none()
        || !matches!(
            dep.baseline_source.as_deref(),
            Some("deploy" | "update" | "promote")
        )
    {
        return false;
    }
    let segs = if dep.target == "claude" {
        [".claude", "skills"]
    } else {
        [".agents", "skills"]
    };
    let dir = project_root
        .join(segs[0])
        .join(segs[1])
        .join(&dep.directory);
    if is_symlink(&dir) || !dir.is_dir() {
        return false;
    }
    compute_skill_tree_fingerprint(&dir).ok().as_deref() == dep.last_materialized_hash.as_deref()
}

pub fn preview_remove_project(
    db: &Arc<Database>,
    project_id: &str,
) -> Result<RemoveProjectPreview> {
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let deps = db.list_project_deployments(project_id)?;
    let snapshots = db.list_rule_snapshots(project_id, None)?;
    let root = Path::new(&project.root_path);

    let mut managed_links_count = 0usize;
    let mut clean_copies_count = 0usize;
    let mut modified_or_adopted_copies_count = 0usize;
    let mut has_git_exclude_entries = false;

    for dep in deps {
        if dep.git_exclude_ref.is_some() {
            has_git_exclude_entries = true;
        }
        if dep.detached_at.is_some() {
            continue;
        }
        if dep.mode == "symlink" || dep.mode == "relative_alias" {
            managed_links_count += 1;
        } else if dep.mode == "copy" {
            if root.is_dir() && is_clean_materialized_copy(root, &dep) {
                clean_copies_count += 1;
            } else {
                modified_or_adopted_copies_count += 1;
            }
        }
    }

    Ok(RemoveProjectPreview {
        project_id: project.id,
        managed_links_count,
        clean_copies_count,
        modified_or_adopted_copies_count,
        rule_snapshots_count: snapshots.len(),
        has_git_exclude_entries,
    })
}

pub fn remove_project(
    db: &Arc<Database>,
    project_id: &str,
    options: RemoveProjectOptions,
) -> Result<RemoveProjectResult> {
    let lock = project_op_lock(project_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let _skill_read = skill_state_read_guard();

    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let deps = db.list_project_deployments(project_id)?;
    let root = Path::new(&project.root_path);

    let mut removed_links_count = 0usize;
    let mut deleted_clean_copies_count = 0usize;
    let mut preserved_copies_count = 0usize;

    for dep in &deps {
        if let Some(ref exclude_ref) = dep.git_exclude_ref {
            let _ = release_git_exclude_ref(db, &project, &dep.target, &dep.directory, exclude_ref);
        }

        if dep.detached_at.is_some() || !root.is_dir() {
            continue;
        }

        let segs = if dep.target == "claude" {
            [".claude", "skills"]
        } else {
            [".agents", "skills"]
        };
        let disk_path = root.join(segs[0]).join(segs[1]).join(&dep.directory);

        if dep.mode == "symlink" || dep.mode == "relative_alias" {
            if options.cleanup_links
                && is_symlink(&disk_path)
                && remove_path_any(&disk_path).is_ok()
            {
                removed_links_count += 1;
            }
        } else if dep.mode == "copy" {
            if options.delete_unmodified_copies && is_clean_materialized_copy(root, dep) {
                if remove_path_any(&disk_path).is_ok() {
                    deleted_clean_copies_count += 1;
                }
            } else if disk_path.exists() {
                preserved_copies_count += 1;
            }
        }
    }

    if project.auto_git_exclude {
        let _ = purge_project_git_exclude_block(&project);
    }

    db.delete_project_and_records(project_id)?;

    Ok(RemoveProjectResult {
        removed_project_id: project_id.to_string(),
        removed_links_count,
        deleted_clean_copies_count,
        preserved_copies_count,
    })
}
