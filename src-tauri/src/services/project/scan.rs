//! 项目 Skills 扫描、状态机判定、基线漂移与客户端加载/命名冲突诊断

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::app_config::InstalledSkill;
use crate::database::dao::projects::{ProjectRecord, ProjectSkillDeploymentRecord};
use crate::database::Database;
use crate::services::project::fs_safety::{
    capture_fs_identity_follow, compute_skill_tree_fingerprint, is_symlink,
    resolve_symlink_target_canonical, validate_skill_directory_name,
    verify_relative_chain_no_symlinks, FsIdentity,
};
use crate::services::skill::{skill_state_read_guard, SkillService};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectSkillStatus {
    Synced,
    Outdated,
    Modified,
    Conflict,
    Broken,
    InvalidStructure,
    SourceMissing,
    Unmanaged,
    SameContentUnmanaged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientDiagnostics {
    pub frontmatter_name: Option<String>,
    pub frontmatter_description: Option<String>,
    /// 磁盘是否已物化文件（提示 "已写入目录，需在对应客户端确认激活"，绝不等价于 "已生效"）
    pub written_to_disk: bool,
    pub duplicate_name_conflicts: Vec<String>,
    pub precedence_warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedProjectSkill {
    pub project_id: String,
    pub target: String,
    pub directory: String,
    pub display_name: String,
    pub description: Option<String>,
    pub status: ProjectSkillStatus,
    pub unknown_baseline: bool,
    pub missing_on_disk: bool,
    pub generation_mismatch: bool,
    pub can_rebind_skill_id: Option<String>,
    pub can_auto_delete_clean_copy: bool,
    pub mode: Option<String>,
    pub managed_link_target: Option<String>,
    pub actual_link_target: Option<String>,
    pub disk_path: String,
    pub disk_exists: bool,
    pub is_symlink: bool,
    pub skill_id: Option<String>,
    pub skill_installation_id: Option<String>,
    pub deployed_hash: Option<String>,
    pub last_materialized_hash: Option<String>,
    pub disk_hash: Option<String>,
    pub ssot_hash: Option<String>,
    pub baseline_source: Option<String>,
    pub detached_at: Option<i64>,
    pub structure_error: Option<String>,
    pub diagnostics: ClientDiagnostics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScanResult {
    pub project: ProjectRecord,
    pub root_exists: bool,
    pub identity_matched: bool,
    pub current_fs_identity: Option<FsIdentity>,
    pub entries: Vec<ScannedProjectSkill>,
}

fn read_skill_frontmatter(
    skill_dir: &Path,
    fallback_dir: &str,
) -> (Option<String>, Option<String>) {
    let md_path = skill_dir.join("SKILL.md");
    let Ok(raw) = fs::read_to_string(&md_path) else {
        return (None, None);
    };
    let text = raw.trim_start_matches('\u{feff}');
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let mut yaml_lines = Vec::new();
    let mut closed = false;
    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        yaml_lines.push(line);
    }
    if !closed {
        return (None, None);
    }
    #[derive(Deserialize)]
    struct Front {
        name: Option<String>,
        description: Option<String>,
    }
    match serde_yaml::from_str::<Front>(&yaml_lines.join("\n")) {
        Ok(f) => (
            f.name
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .or_else(|| Some(fallback_dir.to_string())),
            f.description
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        ),
        Err(_) => (None, None),
    }
}

fn target_segments(target: &str) -> Result<[&'static str; 2]> {
    match target {
        "agents" => Ok([".agents", "skills"]),
        "claude" => Ok([".claude", "skills"]),
        other => Err(anyhow!("未知的项目部署目标: {other}")),
    }
}

fn relative_alias_target_canonical(project_root: &Path, directory: &str) -> Option<PathBuf> {
    let expected = project_root.join(".agents").join("skills").join(directory);
    expected.canonicalize().ok()
}

struct GlobalSkillIndex<'a> {
    by_id: HashMap<String, &'a InstalledSkill>,
    by_inst_id: HashMap<String, &'a InstalledSkill>,
    by_dir_ci: HashMap<String, &'a InstalledSkill>,
}

#[derive(Default)]
pub(crate) struct FingerprintCache {
    by_canon_path: HashMap<PathBuf, std::result::Result<String, String>>,
}

impl FingerprintCache {
    fn fingerprint_dir(&mut self, dir: &Path) -> std::result::Result<String, String> {
        let key = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        if let Some(cached) = self.by_canon_path.get(&key) {
            return cached.clone();
        }
        let computed = compute_skill_tree_fingerprint(&key).map_err(|e| e.to_string());
        self.by_canon_path.insert(key, computed.clone());
        computed
    }

    fn ssot_fingerprint(&mut self, ssot_dir: &Path, directory: &str) -> Option<String> {
        let ssot_skill_dir = ssot_dir.join(directory);
        if ssot_skill_dir.is_dir() && !is_symlink(&ssot_skill_dir) {
            self.fingerprint_dir(&ssot_skill_dir).ok()
        } else {
            None
        }
    }

    fn matches_any_global(
        &mut self,
        global_skills: &indexmap::IndexMap<String, InstalledSkill>,
        ssot_dir: &Path,
        target_fp: &str,
    ) -> bool {
        global_skills.values().any(|skill| {
            self.ssot_fingerprint(ssot_dir, &skill.directory).as_deref() == Some(target_fp)
        })
    }
}

fn index_global_skills(
    skills: &indexmap::IndexMap<String, InstalledSkill>,
) -> GlobalSkillIndex<'_> {
    let mut by_id = HashMap::new();
    let mut by_inst_id = HashMap::new();
    let mut by_dir_ci = HashMap::new();

    for skill in skills.values() {
        by_id.insert(skill.id.clone(), skill);
        if !skill.installation_id.trim().is_empty() {
            by_inst_id.insert(skill.installation_id.clone(), skill);
        }
        by_dir_ci.insert(skill.directory.to_ascii_lowercase(), skill);
    }

    GlobalSkillIndex {
        by_id,
        by_inst_id,
        by_dir_ci,
    }
}

pub fn scan_project(db: &Arc<Database>, project_id: &str) -> Result<ProjectScanResult> {
    let _skill_guard = skill_state_read_guard();
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let deployments = db.list_project_deployments(project_id)?;
    let global_skills = db.get_all_installed_skills()?;
    let ssot_dir = SkillService::resolve_ssot_dir_no_create();

    scan_project_internal(&project, &deployments, &global_skills, &ssot_dir)
}

pub(crate) fn scan_project_internal(
    project: &ProjectRecord,
    deployments: &[ProjectSkillDeploymentRecord],
    global_skills: &indexmap::IndexMap<String, InstalledSkill>,
    ssot_dir: &Path,
) -> Result<ProjectScanResult> {
    let mut cache = FingerprintCache::default();
    scan_project_internal_with_cache(project, deployments, global_skills, ssot_dir, &mut cache)
}

pub(crate) fn scan_project_internal_with_cache(
    project: &ProjectRecord,
    deployments: &[ProjectSkillDeploymentRecord],
    global_skills: &indexmap::IndexMap<String, InstalledSkill>,
    ssot_dir: &Path,
    fp_cache: &mut FingerprintCache,
) -> Result<ProjectScanResult> {
    let root = Path::new(&project.root_path);
    let root_exists = root.is_dir();
    let current_fs_identity = if root_exists {
        capture_fs_identity_follow(root).ok()
    } else {
        None
    };

    let identity_matched = match (&project.fs_identity, &current_fs_identity) {
        (Some(expected_raw), Some(actual)) => {
            FsIdentity::from_json(expected_raw).ok().as_ref() == Some(actual)
        }
        (None, Some(_)) => true,
        _ => false,
    };

    let GlobalSkillIndex {
        by_id,
        by_inst_id,
        by_dir_ci,
    } = index_global_skills(global_skills);

    let mut dep_map: BTreeMap<(String, String), &ProjectSkillDeploymentRecord> = BTreeMap::new();
    for dep in deployments {
        dep_map.insert((dep.target.clone(), dep.directory.clone()), dep);
    }

    let mut target_dirs: BTreeMap<(String, String), ()> = BTreeMap::new();
    for (t, d) in dep_map.keys() {
        target_dirs.insert((t.clone(), d.clone()), ());
    }

    if root_exists {
        for target in ["agents", "claude"] {
            let segs = target_segments(target)?;
            if verify_relative_chain_no_symlinks(root, &segs, false).is_err() {
                continue;
            }
            let skills_root = root.join(segs[0]).join(segs[1]);
            if skills_root.is_dir() && !is_symlink(&skills_root) {
                if let Ok(read_dir) = fs::read_dir(&skills_root) {
                    for entry in read_dir.flatten() {
                        let name = entry.file_name();
                        let name_str = name.to_string_lossy();
                        if name_str.starts_with('.') {
                            continue;
                        }
                        target_dirs.insert((target.to_string(), name_str.to_string()), ());
                    }
                }
            }
        }
    }

    let mut entries = Vec::new();

    for (target, directory) in target_dirs.keys() {
        let dep = dep_map
            .get(&(target.clone(), directory.clone()))
            .copied()
            .filter(|d| d.detached_at.is_none());
        let detached_dep = dep_map
            .get(&(target.clone(), directory.clone()))
            .copied()
            .filter(|d| d.detached_at.is_some());

        let segs = target_segments(target)?;
        let disk_path = root.join(segs[0]).join(segs[1]).join(directory);
        let disk_path_str = disk_path.to_string_lossy().to_string();

        // Find matching global skill for this deployment or directory name
        let matched_by_inst = dep
            .and_then(|d| d.skill_installation_id.as_deref())
            .and_then(|iid| by_inst_id.get(iid).copied());
        let matched_by_id = dep
            .and_then(|d| d.skill_id.as_deref())
            .and_then(|sid| by_id.get(sid).copied());
        let matched_by_dir = by_dir_ci.get(&directory.to_ascii_lowercase()).copied();

        let generation_mismatch =
            dep.is_some_and(|d| d.skill_installation_id.is_some() && matched_by_inst.is_none());
        let can_rebind_skill_id = if generation_mismatch {
            matched_by_id.or(matched_by_dir).map(|s| s.id.clone())
        } else {
            None
        };

        let active_global: Option<&InstalledSkill> = if dep.is_some() {
            if let Some(d) = dep {
                if d.skill_installation_id.is_some() {
                    matched_by_inst
                } else {
                    matched_by_id.or(matched_by_dir)
                }
            } else {
                None
            }
        } else {
            matched_by_dir
        };

        let ssot_hash =
            active_global.and_then(|g| fp_cache.ssot_fingerprint(ssot_dir, &g.directory));

        let meta_opt = fs::symlink_metadata(&disk_path).ok();
        let disk_exists = meta_opt.is_some();
        let entry_is_symlink = meta_opt
            .as_ref()
            .is_some_and(|m| m.file_type().is_symlink());

        // Fast reject invalid directory names (unless only removing DB missing link)
        if validate_skill_directory_name(directory).is_err() && disk_exists {
            entries.push(ScannedProjectSkill {
                project_id: project.id.clone(),
                target: target.clone(),
                directory: directory.clone(),
                display_name: directory.clone(),
                description: None,
                status: ProjectSkillStatus::InvalidStructure,
                unknown_baseline: false,
                missing_on_disk: false,
                generation_mismatch,
                can_rebind_skill_id,
                can_auto_delete_clean_copy: false,
                mode: dep.map(|d| d.mode.clone()),
                managed_link_target: dep.and_then(|d| d.managed_link_target.clone()),
                actual_link_target: None,
                disk_path: disk_path_str,
                disk_exists,
                is_symlink: entry_is_symlink,
                skill_id: dep.and_then(|d| d.skill_id.clone()),
                skill_installation_id: dep.and_then(|d| d.skill_installation_id.clone()),
                deployed_hash: dep.and_then(|d| d.deployed_hash.clone()),
                last_materialized_hash: dep.and_then(|d| d.last_materialized_hash.clone()),
                disk_hash: None,
                ssot_hash,
                baseline_source: dep.and_then(|d| d.baseline_source.clone()),
                detached_at: detached_dep.and_then(|d| d.detached_at),
                structure_error: Some("目录名包含跨平台非法字符或保留名".to_string()),
                diagnostics: ClientDiagnostics {
                    frontmatter_name: None,
                    frontmatter_description: None,
                    written_to_disk: false,
                    duplicate_name_conflicts: Vec::new(),
                    precedence_warnings: Vec::new(),
                },
            });
            continue;
        }

        if !disk_exists {
            if let Some(d) = dep {
                entries.push(ScannedProjectSkill {
                    project_id: project.id.clone(),
                    target: target.clone(),
                    directory: directory.clone(),
                    display_name: matched_by_id
                        .map(|s| s.name.clone())
                        .unwrap_or_else(|| directory.clone()),
                    description: None,
                    status: ProjectSkillStatus::Broken,
                    unknown_baseline: false,
                    missing_on_disk: true,
                    generation_mismatch,
                    can_rebind_skill_id,
                    can_auto_delete_clean_copy: false,
                    mode: Some(d.mode.clone()),
                    managed_link_target: d.managed_link_target.clone(),
                    actual_link_target: None,
                    disk_path: disk_path_str,
                    disk_exists: false,
                    is_symlink: false,
                    skill_id: d.skill_id.clone(),
                    skill_installation_id: d.skill_installation_id.clone(),
                    deployed_hash: d.deployed_hash.clone(),
                    last_materialized_hash: d.last_materialized_hash.clone(),
                    disk_hash: None,
                    ssot_hash,
                    baseline_source: d.baseline_source.clone(),
                    detached_at: None,
                    structure_error: Some("磁盘目标不存在（可能已被外部删除或移动）".to_string()),
                    diagnostics: ClientDiagnostics {
                        frontmatter_name: None,
                        frontmatter_description: None,
                        written_to_disk: false,
                        duplicate_name_conflicts: Vec::new(),
                        precedence_warnings: Vec::new(),
                    },
                });
            }
            continue;
        }

        if entry_is_symlink {
            let raw_link = fs::read_link(&disk_path)
                .ok()
                .map(|p| p.to_string_lossy().to_string());
            match resolve_symlink_target_canonical(&disk_path) {
                Err(err) => {
                    entries.push(ScannedProjectSkill {
                        project_id: project.id.clone(),
                        target: target.clone(),
                        directory: directory.clone(),
                        display_name: matched_by_id
                            .map(|s| s.name.clone())
                            .unwrap_or_else(|| directory.clone()),
                        description: None,
                        status: ProjectSkillStatus::Broken,
                        unknown_baseline: false,
                        missing_on_disk: false,
                        generation_mismatch,
                        can_rebind_skill_id,
                        can_auto_delete_clean_copy: false,
                        mode: dep.map(|d| d.mode.clone()),
                        managed_link_target: dep.and_then(|d| d.managed_link_target.clone()),
                        actual_link_target: raw_link,
                        disk_path: disk_path_str,
                        disk_exists: true,
                        is_symlink: true,
                        skill_id: dep.and_then(|d| d.skill_id.clone()),
                        skill_installation_id: dep.and_then(|d| d.skill_installation_id.clone()),
                        deployed_hash: dep.and_then(|d| d.deployed_hash.clone()),
                        last_materialized_hash: dep.and_then(|d| d.last_materialized_hash.clone()),
                        disk_hash: None,
                        ssot_hash,
                        baseline_source: dep.and_then(|d| d.baseline_source.clone()),
                        detached_at: detached_dep.and_then(|d| d.detached_at),
                        structure_error: Some(format!("符号链接已失效: {err}")),
                        diagnostics: ClientDiagnostics {
                            frontmatter_name: None,
                            frontmatter_description: None,
                            written_to_disk: false,
                            duplicate_name_conflicts: Vec::new(),
                            precedence_warnings: Vec::new(),
                        },
                    });
                }
                Ok(resolved_canon) => {
                    let (fm_name, fm_desc) = read_skill_frontmatter(&resolved_canon, directory);
                    let disk_hash_res = fp_cache.fingerprint_dir(&resolved_canon);
                    let disk_hash = disk_hash_res.as_ref().ok().cloned();
                    let structure_error = disk_hash_res.as_ref().err().cloned();

                    let (status, unknown_baseline) = match dep {
                        Some(d) => {
                            if structure_error.is_some() {
                                (ProjectSkillStatus::InvalidStructure, false)
                            } else if d.mode == "relative_alias" {
                                let expected_agents =
                                    relative_alias_target_canonical(root, directory);
                                let alias_matches =
                                    expected_agents.as_ref() == Some(&resolved_canon);
                                if !alias_matches {
                                    (ProjectSkillStatus::Conflict, true)
                                } else if active_global.is_none() || ssot_hash.is_none() {
                                    (ProjectSkillStatus::SourceMissing, false)
                                } else {
                                    compare_three_way(
                                        d.deployed_hash.as_deref(),
                                        disk_hash.as_deref(),
                                        ssot_hash.as_deref(),
                                    )
                                }
                            } else if d.mode == "symlink" {
                                let expected_target_canon = d
                                    .managed_link_target
                                    .as_deref()
                                    .and_then(|p| Path::new(p).canonicalize().ok())
                                    .or_else(|| {
                                        active_global.and_then(|g| {
                                            ssot_dir.join(&g.directory).canonicalize().ok()
                                        })
                                    });
                                let target_matches = expected_target_canon
                                    .as_ref()
                                    .is_some_and(|exp| exp == &resolved_canon);
                                if !target_matches {
                                    (ProjectSkillStatus::Conflict, true)
                                } else if active_global.is_none() || ssot_hash.is_none() {
                                    (ProjectSkillStatus::SourceMissing, false)
                                } else {
                                    (ProjectSkillStatus::Synced, false)
                                }
                            } else {
                                // 记录为 copy，磁盘却变成了 symlink -> 冲突
                                (ProjectSkillStatus::Conflict, true)
                            }
                        }
                        None => {
                            if structure_error.is_some() {
                                (ProjectSkillStatus::InvalidStructure, false)
                            } else if disk_hash.is_some() && disk_hash == ssot_hash {
                                (ProjectSkillStatus::SameContentUnmanaged, false)
                            } else {
                                (ProjectSkillStatus::Unmanaged, false)
                            }
                        }
                    };

                    entries.push(ScannedProjectSkill {
                        project_id: project.id.clone(),
                        target: target.clone(),
                        directory: directory.clone(),
                        display_name: fm_name.clone().unwrap_or_else(|| directory.clone()),
                        description: fm_desc.clone(),
                        status,
                        unknown_baseline,
                        missing_on_disk: false,
                        generation_mismatch,
                        can_rebind_skill_id,
                        can_auto_delete_clean_copy: false,
                        mode: dep.map(|d| d.mode.clone()),
                        managed_link_target: dep.and_then(|d| d.managed_link_target.clone()),
                        actual_link_target: raw_link,
                        disk_path: disk_path_str,
                        disk_exists: true,
                        is_symlink: true,
                        skill_id: dep.and_then(|d| d.skill_id.clone()),
                        skill_installation_id: dep.and_then(|d| d.skill_installation_id.clone()),
                        deployed_hash: dep.and_then(|d| d.deployed_hash.clone()),
                        last_materialized_hash: dep.and_then(|d| d.last_materialized_hash.clone()),
                        disk_hash,
                        ssot_hash,
                        baseline_source: dep.and_then(|d| d.baseline_source.clone()),
                        detached_at: detached_dep.and_then(|d| d.detached_at),
                        structure_error,
                        diagnostics: ClientDiagnostics {
                            frontmatter_name: fm_name,
                            frontmatter_description: fm_desc,
                            written_to_disk: disk_hash_res.is_ok(),
                            duplicate_name_conflicts: Vec::new(),
                            precedence_warnings: Vec::new(),
                        },
                    });
                }
            }
            continue;
        }

        // Real directory (or non-dir file)
        let meta = meta_opt.unwrap();
        if !meta.is_dir() {
            entries.push(ScannedProjectSkill {
                project_id: project.id.clone(),
                target: target.clone(),
                directory: directory.clone(),
                display_name: directory.clone(),
                description: None,
                status: ProjectSkillStatus::InvalidStructure,
                unknown_baseline: false,
                missing_on_disk: false,
                generation_mismatch,
                can_rebind_skill_id,
                can_auto_delete_clean_copy: false,
                mode: dep.map(|d| d.mode.clone()),
                managed_link_target: dep.and_then(|d| d.managed_link_target.clone()),
                actual_link_target: None,
                disk_path: disk_path_str,
                disk_exists: true,
                is_symlink: false,
                skill_id: dep.and_then(|d| d.skill_id.clone()),
                skill_installation_id: dep.and_then(|d| d.skill_installation_id.clone()),
                deployed_hash: dep.and_then(|d| d.deployed_hash.clone()),
                last_materialized_hash: dep.and_then(|d| d.last_materialized_hash.clone()),
                disk_hash: None,
                ssot_hash,
                baseline_source: dep.and_then(|d| d.baseline_source.clone()),
                detached_at: detached_dep.and_then(|d| d.detached_at),
                structure_error: Some("目标位置是普通文件而非目录".to_string()),
                diagnostics: ClientDiagnostics {
                    frontmatter_name: None,
                    frontmatter_description: None,
                    written_to_disk: false,
                    duplicate_name_conflicts: Vec::new(),
                    precedence_warnings: Vec::new(),
                },
            });
            continue;
        }

        let (fm_name, fm_desc) = read_skill_frontmatter(&disk_path, directory);
        let fp_res = fp_cache.fingerprint_dir(&disk_path);
        let (disk_hash, structure_error) = match &fp_res {
            Ok(fp) => (Some(fp.clone()), None),
            Err(err) => (None, Some(err.clone())),
        };

        let can_auto_delete_clean_copy = match (dep, &disk_hash) {
            (Some(d), Some(dfp)) if d.mode == "copy" => {
                d.last_materialized_hash.as_deref() == Some(dfp.as_str())
                    && matches!(
                        d.baseline_source.as_deref(),
                        Some("deploy" | "update" | "promote")
                    )
            }
            _ => false,
        };

        let (status, unknown_baseline) = match dep {
            Some(d) => {
                if structure_error.is_some() {
                    (ProjectSkillStatus::InvalidStructure, false)
                } else if d.mode == "symlink" || d.mode == "relative_alias" {
                    // 记录为 symlink/alias，磁盘却是独立实目录 -> 视为外部替换冲突
                    (ProjectSkillStatus::Conflict, true)
                } else if active_global.is_none() || ssot_hash.is_none() {
                    (ProjectSkillStatus::SourceMissing, false)
                } else {
                    compare_three_way(
                        d.deployed_hash.as_deref(),
                        disk_hash.as_deref(),
                        ssot_hash.as_deref(),
                    )
                }
            }
            None => {
                let matches_any_global = structure_error.is_none()
                    && disk_hash.as_ref().is_some_and(|dfp| {
                        ssot_hash.as_ref() == Some(dfp)
                            || fp_cache.matches_any_global(global_skills, ssot_dir, dfp)
                    });
                if structure_error.is_some() {
                    (ProjectSkillStatus::InvalidStructure, false)
                } else if matches_any_global {
                    (ProjectSkillStatus::SameContentUnmanaged, false)
                } else {
                    (ProjectSkillStatus::Unmanaged, false)
                }
            }
        };

        entries.push(ScannedProjectSkill {
            project_id: project.id.clone(),
            target: target.clone(),
            directory: directory.clone(),
            display_name: fm_name
                .clone()
                .or_else(|| active_global.map(|g| g.name.clone()))
                .unwrap_or_else(|| directory.clone()),
            description: fm_desc
                .clone()
                .or_else(|| active_global.and_then(|g| g.description.clone())),
            status,
            unknown_baseline,
            missing_on_disk: false,
            generation_mismatch,
            can_rebind_skill_id,
            can_auto_delete_clean_copy,
            mode: dep.map(|d| d.mode.clone()),
            managed_link_target: dep.and_then(|d| d.managed_link_target.clone()),
            actual_link_target: None,
            disk_path: disk_path_str,
            disk_exists: true,
            is_symlink: false,
            skill_id: dep.and_then(|d| d.skill_id.clone()),
            skill_installation_id: dep.and_then(|d| d.skill_installation_id.clone()),
            deployed_hash: dep.and_then(|d| d.deployed_hash.clone()),
            last_materialized_hash: dep.and_then(|d| d.last_materialized_hash.clone()),
            disk_hash,
            ssot_hash,
            baseline_source: dep.and_then(|d| d.baseline_source.clone()),
            detached_at: detached_dep.and_then(|d| d.detached_at),
            structure_error,
            diagnostics: ClientDiagnostics {
                frontmatter_name: fm_name,
                frontmatter_description: fm_desc,
                written_to_disk: fp_res.is_ok(),
                duplicate_name_conflicts: Vec::new(),
                precedence_warnings: Vec::new(),
            },
        });
    }

    // 诊断 1：项目内跨 target 的 frontmatter name 冲突与同名偏离
    let mut name_locs: HashMap<String, Vec<(String, String, Option<String>)>> = HashMap::new();
    for e in &entries {
        if e.disk_exists && e.diagnostics.written_to_disk {
            if let Some(ref fm) = e.diagnostics.frontmatter_name {
                name_locs.entry(fm.to_ascii_lowercase()).or_default().push((
                    e.target.clone(),
                    e.directory.clone(),
                    e.disk_hash.clone(),
                ));
            }
        }
    }

    // 诊断 2：全局 Claude personal skills 与项目 Claude / Agents skills 优先级提示
    let claude_global_dirs: BTreeSet<String> = global_skills
        .values()
        .filter(|s| s.apps.claude)
        .map(|s| s.directory.to_ascii_lowercase())
        .collect();

    for e in &mut entries {
        if let Some(ref fm) = e.diagnostics.frontmatter_name {
            if let Some(locs) = name_locs.get(&fm.to_ascii_lowercase()) {
                let others: Vec<String> = locs
                    .iter()
                    .filter(|(t, d, _)| !(t == &e.target && d == &e.directory))
                    .map(|(t, d, _)| format!("{t}/{d}"))
                    .collect();
                if !others.is_empty() && e.mode.as_deref() != Some("relative_alias") {
                    e.diagnostics.duplicate_name_conflicts = others;
                }
            }
        }
        if e.target == "claude" && claude_global_dirs.contains(&e.directory.to_ascii_lowercase()) {
            e.diagnostics.precedence_warnings.push(
                "全局 Claude (~/.claude/skills/) 也启用了同名 Skill；按 Claude Code 加载规则，项目级 .claude/skills/ 将优先覆盖用户级同名技能。".to_string(),
            );
        }
    }

    Ok(ProjectScanResult {
        project: project.clone(),
        root_exists,
        identity_matched,
        current_fs_identity,
        entries,
    })
}

fn compare_three_way(
    deployed: Option<&str>,
    disk: Option<&str>,
    ssot: Option<&str>,
) -> (ProjectSkillStatus, bool) {
    match (deployed, disk, ssot) {
        (Some(b), Some(d), Some(s)) => {
            if d == s {
                (ProjectSkillStatus::Synced, false)
            } else if d == b && s != b {
                (ProjectSkillStatus::Outdated, false)
            } else if s == b && d != b {
                (ProjectSkillStatus::Modified, false)
            } else {
                (ProjectSkillStatus::Conflict, false)
            }
        }
        (None, Some(d), Some(s)) => {
            if d == s {
                (ProjectSkillStatus::Synced, false)
            } else {
                (ProjectSkillStatus::Conflict, true)
            }
        }
        (_, None, _) => (ProjectSkillStatus::Broken, false),
        (_, Some(_), None) => (ProjectSkillStatus::SourceMissing, false),
    }
}
