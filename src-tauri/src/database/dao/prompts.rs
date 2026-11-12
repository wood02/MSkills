//! 提示词数据访问对象
//!
//! 提供提示词（Prompt）的 CRUD 操作。

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::prompt::Prompt;
use indexmap::IndexMap;
use rusqlite::{params, Connection};
use std::collections::HashMap;

impl Database {
    /// 获取指定应用类型的所有提示词
    pub fn get_prompts(&self, app_type: &str) -> Result<IndexMap<String, Prompt>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT id, name, content, description, enabled, sort_order, created_at, updated_at
             FROM prompts WHERE app_type = ?1
             ORDER BY sort_order ASC, created_at ASC, id ASC",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

        let prompt_iter = stmt
            .query_map(params![app_type], |row| {
                let id: String = row.get(0)?;
                let name: String = row.get(1)?;
                let content: String = row.get(2)?;
                let description: Option<String> = row.get(3)?;
                let enabled: bool = row.get(4)?;
                let sort_order: Option<i64> = row.get(5)?;
                let created_at: Option<i64> = row.get(6)?;
                let updated_at: Option<i64> = row.get(7)?;

                Ok((
                    id.clone(),
                    Prompt {
                        id,
                        name,
                        content,
                        description,
                        enabled,
                        sort_order,
                        created_at,
                        updated_at,
                    },
                ))
            })
            .map_err(|e| AppError::Database(e.to_string()))?;

        let mut prompts = IndexMap::new();
        for prompt_res in prompt_iter {
            let (id, prompt) = prompt_res.map_err(|e| AppError::Database(e.to_string()))?;
            prompts.insert(id, prompt);
        }
        Ok(prompts)
    }

    /// 保存提示词
    pub fn save_prompt(&self, app_type: &str, prompt: &Prompt) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT OR REPLACE INTO prompts (
                id, app_type, name, content, description, enabled, sort_order, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                prompt.id,
                app_type,
                prompt.name,
                prompt.content,
                prompt.description,
                prompt.enabled,
                prompt.sort_order.unwrap_or(0),
                prompt.created_at,
                prompt.updated_at,
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    // Backfill and activation commit together with the native instructions file.
    pub(crate) fn save_native_prompts(
        &self,
        app: &str,
        prompts: &IndexMap<String, Prompt>,
    ) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let transaction = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        for prompt in prompts.values() {
            transaction
                .execute(
                    "INSERT OR REPLACE INTO prompts (
                    id, app_type, name, content, description, enabled, sort_order, created_at, updated_at
                ) VALUES (?1, ?9, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        prompt.id,
                        prompt.name,
                        prompt.content,
                        prompt.description,
                        prompt.enabled,
                        prompt.sort_order.unwrap_or(0),
                        prompt.created_at,
                        prompt.updated_at,
                        app
                    ],
                )
                .map_err(|e| AppError::Database(e.to_string()))?;
        }
        transaction
            .commit()
            .map_err(|e| AppError::Database(e.to_string()))
    }

    /// 按指定 ID 列表更新同一应用下提示词的排序权重
    pub fn reorder_prompts(&self, app_type: &str, ids: &[String]) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let transaction = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;

        let existing_ids: Vec<String> = {
            let mut stmt = transaction
                .prepare(
                    "SELECT id FROM prompts WHERE app_type = ?1 ORDER BY sort_order ASC, created_at ASC, id ASC",
                )
                .map_err(|e| AppError::Database(e.to_string()))?;
            let rows = stmt
                .query_map(params![app_type], |row| row.get::<_, String>(0))
                .map_err(|e| AppError::Database(e.to_string()))?;
            let mut list = Vec::new();
            for row in rows {
                list.push(row.map_err(|e| AppError::Database(e.to_string()))?);
            }
            list
        };

        let mut next_order: i64 = 0;
        let mut seen = std::collections::HashSet::new();
        for id in ids.iter().chain(existing_ids.iter()) {
            if !existing_ids.iter().any(|existing| existing == id) || !seen.insert(id.clone()) {
                continue;
            }
            transaction
                .execute(
                    "UPDATE prompts SET sort_order = ?1 WHERE id = ?2 AND app_type = ?3",
                    params![next_order, id, app_type],
                )
                .map_err(|e| AppError::Database(e.to_string()))?;
            next_order += 1;
        }

        transaction
            .commit()
            .map_err(|e| AppError::Database(e.to_string()))
    }

    /// 删除提示词
    pub fn delete_prompt(&self, app_type: &str, id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM prompts WHERE id = ?1 AND app_type = ?2",
            params![id, app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub(crate) fn read_enabled_prompt_contents_by_app(
        conn: &Connection,
    ) -> Result<HashMap<String, Vec<String>>, AppError> {
        if !Self::table_exists(conn, "prompts")? {
            return Ok(HashMap::new());
        }
        let mut stmt = conn
            .prepare("SELECT app_type, content FROM prompts WHERE enabled = 1")
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut by_app: HashMap<String, Vec<String>> = HashMap::new();
        for row in rows {
            let (app, content) = row.map_err(|e| AppError::Database(e.to_string()))?;
            by_app.entry(app).or_default().push(content);
        }
        Ok(by_app)
    }

    pub(crate) fn set_pre_restore_prompts(
        &self,
        prompts_by_app: HashMap<String, Vec<String>>,
    ) -> Result<(), AppError> {
        let mut guard = lock_conn!(self.pre_restore_prompts);
        *guard = prompts_by_app;
        Ok(())
    }

    pub(crate) fn get_pre_restore_prompts(&self, app_type: &str) -> Result<Vec<String>, AppError> {
        let guard = lock_conn!(self.pre_restore_prompts);
        Ok(guard.get(app_type).cloned().unwrap_or_default())
    }

    pub(crate) fn clear_pre_restore_prompts(&self, app_type: &str) -> Result<(), AppError> {
        let mut guard = lock_conn!(self.pre_restore_prompts);
        guard.remove(app_type);
        Ok(())
    }
}
