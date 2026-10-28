//! 技能组数据访问对象
//!
//! skill_groups 表存放 Skills 页的「技能组」：一组 Skill id（JSON 数组文本），
//! 不绑定应用、与项目 Profile 互不相关，应用到哪个应用由调用方决定。

use crate::app_config::{AppType, SkillApps};
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use rusqlite::{params, OptionalExtension};

const CURRENT_GROUP_PREFIX: &str = "current_skill_group_id_";

#[derive(Debug, Clone)]
pub struct SkillGroup {
    pub id: String,
    pub name: String,
    /// 原始 JSON 数组文本（Skill id 列表），解析在 service 层
    pub skills: String,
    pub sort_order: Option<i64>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SkillGroup> {
    Ok(SkillGroup {
        id: row.get(0)?,
        name: row.get(1)?,
        skills: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

impl Database {
    /// 获取所有技能组（sort_order 优先、created_at 兜底）
    pub fn get_all_skill_groups(&self) -> Result<Vec<SkillGroup>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT id, name, skills, sort_order, created_at, updated_at
                 FROM skill_groups
                 ORDER BY sort_order IS NULL, sort_order, created_at, id",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], map_row)
            .map_err(|e| AppError::Database(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::Database(e.to_string()))
    }

    pub fn get_skill_group(&self, id: &str) -> Result<Option<SkillGroup>, AppError> {
        let conn = lock_conn!(self.conn);
        match conn.query_row(
            "SELECT id, name, skills, sort_order, created_at, updated_at
             FROM skill_groups WHERE id = ?1",
            params![id],
            map_row,
        ) {
            Ok(group) => Ok(Some(group)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(AppError::Database(e.to_string())),
        }
    }

    /// 保存技能组（插入或整行替换）
    pub fn save_skill_group(&self, group: &SkillGroup) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT OR REPLACE INTO skill_groups
             (id, name, skills, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                group.id,
                group.name,
                group.skills,
                group.sort_order,
                group.created_at,
                group.updated_at,
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 删除技能组，返回是否实际删除了记录
    pub fn delete_skill_group(&self, id: &str) -> Result<bool, AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let affected = tx
            .execute("DELETE FROM skill_groups WHERE id = ?1", params![id])
            .map_err(|e| AppError::Database(e.to_string()))?;
        tx.execute(
            "DELETE FROM settings WHERE key GLOB ?1 AND value = ?2",
            params![format!("{CURRENT_GROUP_PREFIX}*"), id],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(affected > 0)
    }

    pub fn get_current_skill_group_id(&self, app: &str) -> Result<Option<String>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT g.id FROM skill_groups g JOIN settings s ON s.value = g.id WHERE s.key = ?1",
            [format!("{CURRENT_GROUP_PREFIX}{app}")],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| AppError::Database(e.to_string()))
    }

    pub fn set_current_skill_group_id(&self, app: &str, id: Option<&str>) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let key = format!("{CURRENT_GROUP_PREFIX}{app}");
        if let Some(id) = id {
            let changed = conn.execute(
                "INSERT OR REPLACE INTO settings(key,value) SELECT ?1,id FROM skill_groups WHERE id = ?2",
                params![key, id],
            ).map_err(|e| AppError::Database(e.to_string()))?;
            if changed == 0 {
                return Err(AppError::InvalidInput(format!(
                    "Skill group not found: {id}"
                )));
            }
        } else {
            conn.execute("DELETE FROM settings WHERE key = ?1", [key])
                .map_err(|e| AppError::Database(e.to_string()))?;
        }
        Ok(())
    }

    /// Commit desired state and the selected group's membership together.
    pub fn update_skill_selection(
        &self,
        id: &str,
        app: &AppType,
        apps: &SkillApps,
    ) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        if !matches!(app, AppType::Pi) && !Self::update_skill_apps_on_conn(&tx, id, apps)? {
            return Err(AppError::InvalidInput(format!("Skill not found: {id}")));
        }
        let current: Option<(String, String)> = tx.query_row(
            "SELECT g.id,g.skills FROM skill_groups g JOIN settings s ON s.value = g.id WHERE s.key = ?1",
            [format!("{CURRENT_GROUP_PREFIX}{}", app.as_str())],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|e| AppError::Database(e.to_string()))?;
        if let Some((group_id, raw)) = current {
            let mut ids: Vec<String> = serde_json::from_str(&raw)
                .map_err(|e| AppError::Config(format!("Invalid skill group: {e}")))?;
            ids.retain(|member| member != id);
            if apps.is_enabled_for(app) {
                ids.push(id.to_string());
            }
            ids.sort();
            ids.dedup();
            let json = serde_json::to_string(&ids).map_err(|e| AppError::Config(e.to_string()))?;
            tx.execute(
                "UPDATE skill_groups SET skills = ?1,updated_at = ?2 WHERE id = ?3",
                params![json, chrono::Utc::now().timestamp(), group_id],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        tx.commit().map_err(|e| AppError::Database(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, name: &str, sort_order: Option<i64>) -> SkillGroup {
        SkillGroup {
            id: id.to_string(),
            name: name.to_string(),
            skills: r#"["local:a"]"#.to_string(),
            sort_order,
            created_at: Some(1_000),
            updated_at: Some(1_000),
        }
    }

    #[test]
    fn test_skill_group_crud_roundtrip() -> Result<(), AppError> {
        let db = Database::memory()?;

        db.save_skill_group(&sample("a", "Frontend", Some(2)))?;
        db.save_skill_group(&sample("b", "Docs", Some(1)))?;
        db.save_skill_group(&sample("c", "Misc", None))?;

        let all = db.get_all_skill_groups()?;
        assert_eq!(
            all.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(),
            vec!["b", "a", "c"]
        );

        db.save_skill_group(&sample("a", "Frontend 2", Some(2)))?;
        let got = db.get_skill_group("a")?.expect("group a exists");
        assert_eq!(got.name, "Frontend 2");
        assert_eq!(got.skills, r#"["local:a"]"#);

        assert!(db.delete_skill_group("a")?);
        assert!(!db.delete_skill_group("a")?);
        assert!(db.get_skill_group("a")?.is_none());
        // 与项目表互不相干
        assert!(db.get_all_profiles()?.is_empty());
        Ok(())
    }

    #[test]
    fn current_group_is_scoped_and_deletion_clears_only_its_markers() -> Result<(), AppError> {
        let db = Database::memory()?;
        db.save_skill_group(&sample("a", "A", None))?;
        db.save_skill_group(&sample("b", "B", None))?;
        assert_eq!(db.get_current_skill_group_id("codex")?, None);
        db.set_current_skill_group_id("claude", Some("a"))?;
        db.set_current_skill_group_id("pi", Some("a"))?;
        db.set_current_skill_group_id("codex", Some("b"))?;
        assert!(db
            .set_current_skill_group_id("codex", Some("missing"))
            .is_err());
        assert_eq!(
            db.get_current_skill_group_id("codex")?.as_deref(),
            Some("b")
        );
        db.delete_skill_group("a")?;
        assert_eq!(db.get_current_skill_group_id("claude")?, None);
        assert_eq!(db.get_current_skill_group_id("pi")?, None);
        assert_eq!(db.get_setting("current_skill_group_id_claude")?, None);
        assert_eq!(
            db.get_current_skill_group_id("codex")?.as_deref(),
            Some("b")
        );
        Ok(())
    }
}
