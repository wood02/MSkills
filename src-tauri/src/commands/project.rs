//! 项目级 Skills Workspace 与 Rules 管理 Tauri 命令层。

use std::path::Path;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::database::dao::projects::{
    ProjectRecord, ProjectRuleSnapshotRecord, ProjectSkillDeploymentRecord,
};
use crate::services::project::deploy::{
    self, DeployGroupToProjectResult, DeployToProjectResult, ImportProjectSkillRequest,
    ProjectSkillDiffResult, PushOrImportResult, TargetSkillRef,
};
use crate::services::project::rules::{
    self, InsertAgentsReferenceResult, ProjectRuleFile, RestoreRuleSnapshotResult,
};
use crate::services::project::scan::{self, ProjectScanResult};
use crate::services::project::{
    self, AddProjectInput, ProjectListItem, RemoveProjectOptions, RemoveProjectPreview,
    RemoveProjectResult, SuggestedProject, UpdateProjectInput,
};
use crate::services::skill::{SkillService, SkillUninstallResult};
use crate::store::AppState;

// ========== 项目生命周期 ==========

#[tauri::command]
pub async fn pick_project_directory(
    app: AppHandle,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let initial = default_path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());

    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        if let Some(dir) = initial {
            let path = Path::new(&dir);
            if path.is_dir() {
                builder = builder.set_directory(path);
            }
        }
        builder.blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("打开项目目录选择器失败: {e}"))?;

    match picked {
        Some(file_path) => {
            let resolved = file_path
                .simplified()
                .into_path()
                .map_err(|e| format!("解析所选目录失败: {e}"))?;
            Ok(Some(resolved.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn list_projects(
    include_archived: Option<bool>,
    app_state: State<'_, AppState>,
) -> Result<Vec<ProjectListItem>, String> {
    let db = app_state.db.clone();
    let include = include_archived.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || project::list_projects_with_stats(&db, include))
        .await
        .map_err(|e| format!("读取项目列表失败: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn suggest_projects_from_sessions(
    app_state: State<'_, AppState>,
) -> Result<Vec<SuggestedProject>, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || project::suggest_projects_from_sessions(&db))
        .await
        .map_err(|e| format!("扫描会话建议项目失败: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_project(
    input: AddProjectInput,
    app_state: State<'_, AppState>,
) -> Result<ProjectRecord, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || project::add_project(&db, input))
        .await
        .map_err(|e| format!("添加项目失败: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_project(
    input: UpdateProjectInput,
    app_state: State<'_, AppState>,
) -> Result<ProjectRecord, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || project::update_project(&db, input))
        .await
        .map_err(|e| format!("更新项目设置失败: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn relocate_project(
    project_id: String,
    new_root_path: String,
    app_state: State<'_, AppState>,
) -> Result<ProjectRecord, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        project::relocate_project(&db, &project_id, &new_root_path)
    })
    .await
    .map_err(|e| format!("重定位项目失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn preview_remove_project(
    project_id: String,
    app_state: State<'_, AppState>,
) -> Result<RemoveProjectPreview, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || project::preview_remove_project(&db, &project_id))
        .await
        .map_err(|e| format!("预览移除项目失败: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_project(
    project_id: String,
    options: RemoveProjectOptions,
    app_state: State<'_, AppState>,
) -> Result<RemoveProjectResult, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || project::remove_project(&db, &project_id, options))
        .await
        .map_err(|e| format!("移除项目失败: {e}"))?
        .map_err(|e| e.to_string())
}

// ========== 项目 Skills 扫描、部署、同步、导入与 Diff ==========

#[tauri::command]
pub async fn scan_project_skills(
    project_id: String,
    app_state: State<'_, AppState>,
) -> Result<ProjectScanResult, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || scan::scan_project(&db, &project_id))
        .await
        .map_err(|e| format!("扫描项目 Skills 失败: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn deploy_skills_to_project(
    project_id: String,
    skill_ids: Vec<String>,
    targets: Vec<String>,
    mode_override: Option<String>,
    overwrite_conflicts: Option<bool>,
    app_state: State<'_, AppState>,
) -> Result<DeployToProjectResult, String> {
    let db = app_state.db.clone();
    let overwrite = overwrite_conflicts.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        deploy::deploy_skills_to_project(
            &db,
            &project_id,
            &skill_ids,
            &targets,
            mode_override.as_deref(),
            overwrite,
        )
    })
    .await
    .map_err(|e| format!("部署 Skill 到项目失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn deploy_skill_group_to_project(
    project_id: String,
    group_id: String,
    targets: Vec<String>,
    mode_override: Option<String>,
    overwrite_conflicts: Option<bool>,
    app_state: State<'_, AppState>,
) -> Result<DeployGroupToProjectResult, String> {
    let db = app_state.db.clone();
    let overwrite = overwrite_conflicts.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        deploy::deploy_skill_group_to_project(
            &db,
            &project_id,
            &group_id,
            &targets,
            mode_override.as_deref(),
            overwrite,
        )
    })
    .await
    .map_err(|e| format!("按技能组部署到项目失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_project_deployments(
    project_id: String,
    items: Vec<TargetSkillRef>,
    allow_overwrite_modified: Option<bool>,
    app_state: State<'_, AppState>,
) -> Result<Vec<ProjectSkillDeploymentRecord>, String> {
    let db = app_state.db.clone();
    let allow = allow_overwrite_modified.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        deploy::update_project_deployments(&db, &project_id, &items, allow)
    })
    .await
    .map_err(|e| format!("同步更新项目 Skill 失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn promote_claude_deployment(
    project_id: String,
    directory: String,
    overwrite_agents: Option<bool>,
    app_state: State<'_, AppState>,
) -> Result<(ProjectSkillDeploymentRecord, ProjectSkillDeploymentRecord), String> {
    let db = app_state.db.clone();
    let overwrite = overwrite_agents.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        deploy::promote_claude_deployment(&db, &project_id, &directory, overwrite)
    })
    .await
    .map_err(|e| format!("Promote Claude 部署失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn undeploy_project_skill(
    project_id: String,
    target: String,
    directory: String,
    action: String,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        deploy::undeploy_project_skill(&db, &project_id, &target, &directory, &action)
    })
    .await
    .map_err(|e| format!("取消项目部署失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn adopt_project_skill(
    project_id: String,
    target: String,
    directory: String,
    skill_id: Option<String>,
    app_state: State<'_, AppState>,
) -> Result<ProjectSkillDeploymentRecord, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        deploy::adopt_project_skill(&db, &project_id, &target, &directory, skill_id.as_deref())
    })
    .await
    .map_err(|e| format!("纳管项目 Skill 失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rebind_project_deployment(
    project_id: String,
    target: String,
    directory: String,
    skill_id: String,
    app_state: State<'_, AppState>,
) -> Result<ProjectSkillDeploymentRecord, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        deploy::rebind_project_deployment(&db, &project_id, &target, &directory, &skill_id)
    })
    .await
    .map_err(|e| format!("重新关联项目 Skill 失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn settle_missing_project_link(
    project_id: String,
    target: String,
    directory: String,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        deploy::settle_missing_project_link(&db, &project_id, &target, &directory)
    })
    .await
    .map_err(|e| format!("清理失效链接记录失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn push_skill_to_global(
    project_id: String,
    target: String,
    directory: String,
    overwrite_existing: Option<bool>,
    app_state: State<'_, AppState>,
) -> Result<PushOrImportResult, String> {
    let db = app_state.db.clone();
    let overwrite = overwrite_existing.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        deploy::push_skill_to_global(&db, &project_id, &target, &directory, overwrite)
    })
    .await
    .map_err(|e| format!("推送项目 Skill 到全局失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_project_skills(
    project_id: String,
    items: Vec<ImportProjectSkillRequest>,
    app_state: State<'_, AppState>,
) -> Result<Vec<PushOrImportResult>, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        deploy::import_project_skills(&db, &project_id, &items)
    })
    .await
    .map_err(|e| format!("导入项目 Skill 到全局失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn diff_project_skill(
    project_id: String,
    target: String,
    directory: String,
    app_state: State<'_, AppState>,
) -> Result<ProjectSkillDiffResult, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        deploy::diff_project_skill(&db, &project_id, &target, &directory)
    })
    .await
    .map_err(|e| format!("读取项目 Skill 差异失败: {e}"))?
    .map_err(|e| e.to_string())
}

// ========== 全局 Skill 卸载影响预览与安全拆除 ==========

#[tauri::command]
pub async fn preview_skill_uninstall_impact(
    id: String,
    app_state: State<'_, AppState>,
) -> Result<Vec<ProjectSkillDeploymentRecord>, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        SkillService::preview_skill_uninstall_impact(&db, &id)
    })
    .await
    .map_err(|e| format!("预览全局卸载影响失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn uninstall_skill_with_options(
    id: String,
    unlink_project_symlinks: Option<bool>,
    app_state: State<'_, AppState>,
) -> Result<SkillUninstallResult, String> {
    let db = app_state.db.clone();
    let unlink = unlink_project_symlinks.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        SkillService::uninstall_with_options(&db, &id, unlink)
    })
    .await
    .map_err(|e| format!("卸载全局 Skill 失败: {e}"))?
    .map_err(|e| e.to_string())
}

// ========== 项目 Rules（CLAUDE.md / AGENTS.md）与快照 ==========

#[tauri::command]
pub async fn list_project_rules(
    project_id: String,
    app_state: State<'_, AppState>,
) -> Result<Vec<ProjectRuleFile>, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || rules::list_project_rules(&db, &project_id))
        .await
        .map_err(|e| format!("读取项目 Rules 文件失败: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_project_rule_file(
    project_id: String,
    relative_path: String,
    content: String,
    expected_revision: Option<String>,
    app_state: State<'_, AppState>,
) -> Result<ProjectRuleFile, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        rules::save_project_rule_file(
            &db,
            &project_id,
            &relative_path,
            &content,
            expected_revision.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("保存项目 Rules 文件失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn apply_prompt_to_project_rule(
    project_id: String,
    relative_path: String,
    prompt_id: String,
    apply_mode: String,
    expected_revision: Option<String>,
    app_state: State<'_, AppState>,
) -> Result<ProjectRuleFile, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        rules::apply_prompt_to_project_rule(
            &db,
            &project_id,
            &relative_path,
            &prompt_id,
            &apply_mode,
            expected_revision.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("应用提示词模板到项目 Rules 失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn insert_agents_reference_in_claude_md(
    project_id: String,
    expected_revision: Option<String>,
    app_state: State<'_, AppState>,
) -> Result<InsertAgentsReferenceResult, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        rules::insert_agents_reference_in_claude_md(&db, &project_id, expected_revision.as_deref())
    })
    .await
    .map_err(|e| format!("插入 @AGENTS.md 引用失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_rule_snapshots(
    project_id: String,
    relative_path: Option<String>,
    app_state: State<'_, AppState>,
) -> Result<Vec<ProjectRuleSnapshotRecord>, String> {
    let db = app_state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        rules::list_rule_snapshots(&db, &project_id, relative_path.as_deref())
    })
    .await
    .map_err(|e| format!("读取规则快照失败: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_rule_snapshot(
    project_id: String,
    snapshot_id: String,
    expected_current_revision: Option<String>,
    confirm_delete: Option<bool>,
    app_state: State<'_, AppState>,
) -> Result<RestoreRuleSnapshotResult, String> {
    let db = app_state.db.clone();
    let confirm = confirm_delete.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        rules::restore_rule_snapshot(
            &db,
            &project_id,
            &snapshot_id,
            expected_current_revision.as_deref(),
            confirm,
        )
    })
    .await
    .map_err(|e| format!("恢复规则快照失败: {e}"))?
    .map_err(|e| e.to_string())
}
