//! 技能组服务（Skills 页「技能组」）
//!
//! 技能组只是一组 Skill id，不绑定应用：切换时把当前查看的应用的 Skill
//! 启用状态改成与组内一致（组里有的开、没有的关），不动供应商 / MCP / Prompt，
//! 也与项目 Profile 互不相关。

use crate::app_config::AppType;
use crate::database::SkillGroup;
use crate::error::AppError;
use crate::services::profile::ProfileService;
use crate::services::skill::{skill_state_write_guard, SkillService};
use crate::store::AppState;

pub struct SkillGroupService;

impl SkillGroupService {
    pub fn list(state: &AppState) -> Result<Vec<SkillGroup>, AppError> {
        state.db.get_all_skill_groups()
    }

    /// 用 app 当前启用的 Skill 新建技能组
    pub fn create(state: &AppState, name: &str, app: &AppType) -> Result<SkillGroup, AppError> {
        let _guard = skill_state_write_guard();
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput(
                "Skill group name is empty".to_string(),
            ));
        }
        let mut ids: Vec<String> = SkillService::get_all_installed(&state.db)
            .map_err(|e| AppError::Config(e.to_string()))?
            .iter()
            .filter(|s| s.apps.is_enabled_for(app))
            .map(|s| s.id.clone())
            .collect();
        ids.sort();
        let now = chrono::Utc::now().timestamp();
        let group = SkillGroup {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            skills: encode_ids(&ids)?,
            sort_order: None,
            created_at: Some(now),
            updated_at: Some(now),
        };
        state.db.save_skill_group(&group)?;
        state
            .db
            .set_current_skill_group_id(app.as_str(), Some(&group.id))?;
        Ok(group)
    }

    pub fn rename(state: &AppState, id: &str, name: &str) -> Result<SkillGroup, AppError> {
        let _guard = skill_state_write_guard();
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput(
                "Skill group name is empty".to_string(),
            ));
        }
        let mut group = Self::get(state, id)?;
        group.name = name.to_string();
        group.updated_at = Some(chrono::Utc::now().timestamp());
        state.db.save_skill_group(&group)?;
        Ok(group)
    }

    pub fn delete(state: &AppState, id: &str) -> Result<(), AppError> {
        let _guard = skill_state_write_guard();
        if !state.db.delete_skill_group(id)? {
            return Err(AppError::InvalidInput(format!(
                "Skill group not found: {id}"
            )));
        }
        Ok(())
    }

    /// 把 app 的 Skill 启用状态改成与技能组一致，返回 best-effort 的 warning
    pub fn apply(state: &AppState, id: &str, app: &AppType) -> Result<Vec<String>, AppError> {
        let _guard = skill_state_write_guard();
        let group = Self::get(state, id)?;
        let ids = decode_ids(&group.skills)?;
        let mut warnings = Vec::new();
        ProfileService::apply_skill_slot_locked(state, app, &ids, &mut warnings, Some(id))?;
        Ok(warnings)
    }

    fn get(state: &AppState, id: &str) -> Result<SkillGroup, AppError> {
        state
            .db
            .get_skill_group(id)?
            .ok_or_else(|| AppError::InvalidInput(format!("Skill group not found: {id}")))
    }
}

pub fn decode_ids(raw: &str) -> Result<Vec<String>, AppError> {
    serde_json::from_str(raw).map_err(|e| AppError::Config(format!("解析技能组失败: {e}")))
}

fn encode_ids(ids: &[String]) -> Result<String, AppError> {
    serde_json::to_string(ids).map_err(|e| AppError::Config(format!("序列化技能组失败: {e}")))
}
