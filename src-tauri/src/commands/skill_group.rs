//! 技能组管理命令（Skills 页「技能组」）

use std::str::FromStr;

use serde::Serialize;
use tauri::State;

use crate::app_config::AppType;
use crate::database::SkillGroup;
use crate::services::skill_group::{decode_ids, SkillGroupService};
use crate::store::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillGroupDto {
    pub id: String,
    pub name: String,
    pub skills: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
}

impl From<SkillGroup> for SkillGroupDto {
    fn from(group: SkillGroup) -> Self {
        // 单条损坏不拖垮整个列表：降级为空组并记日志
        let skills = decode_ids(&group.skills).unwrap_or_else(|e| {
            log::warn!("解析技能组 '{}' 失败，按空组处理: {e}", group.id);
            Vec::new()
        });
        Self {
            id: group.id,
            name: group.name,
            skills,
            created_at: group.created_at,
        }
    }
}

fn parse_app(app: &str) -> Result<AppType, String> {
    AppType::from_str(app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_skill_groups(state: State<'_, AppState>) -> Result<Vec<SkillGroupDto>, String> {
    SkillGroupService::list(&state)
        .map(|groups| groups.into_iter().map(SkillGroupDto::from).collect())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_current_skill_group(
    state: State<'_, AppState>,
    app: String,
) -> Result<Option<String>, String> {
    let app = parse_app(&app)?;
    state
        .db
        .get_current_skill_group_id(app.as_str())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_skill_group(
    state: State<'_, AppState>,
    name: String,
    app: String,
) -> Result<SkillGroupDto, String> {
    let app = parse_app(&app)?;
    SkillGroupService::create(&state, &name, &app)
        .map(SkillGroupDto::from)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_skill_group(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<SkillGroupDto, String> {
    SkillGroupService::rename(&state, &id, &name)
        .map(SkillGroupDto::from)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_skill_group(state: State<'_, AppState>, id: String) -> Result<(), String> {
    SkillGroupService::delete(&state, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn apply_skill_group(
    state: State<'_, AppState>,
    id: String,
    app: String,
) -> Result<Vec<String>, String> {
    let app = parse_app(&app)?;
    SkillGroupService::apply(&state, &id, &app).map_err(|e| e.to_string())
}
