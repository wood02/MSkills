use indexmap::IndexMap;
use std::path::Path;

use crate::app_config::AppType;
use crate::config::write_text_file;
use crate::error::AppError;
use crate::prompt::Prompt;
use crate::prompt_files::{
    compose_prompt_document, ensure_no_segment_markers, parse_live_prompt_file, prompt_file_path,
    split_rtk_lines, strip_segment_marker_lines, validate_prompt_content,
};
use crate::services::pi_prompt_files::PiAgentsFileGuard;
use crate::store::AppState;

static PROMPT_FILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 安全地获取当前 Unix 时间戳
fn get_unix_timestamp() -> Result<i64, AppError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .map_err(|e| AppError::Message(format!("Failed to get system time: {e}")))
}

pub struct PromptService;

fn sorted_prompt_refs(prompts: &IndexMap<String, Prompt>) -> Vec<&Prompt> {
    let mut list: Vec<&Prompt> = prompts.values().collect();
    list.sort_by(|a, b| {
        a.sort_order
            .unwrap_or(0)
            .cmp(&b.sort_order.unwrap_or(0))
            .then_with(|| a.created_at.unwrap_or(0).cmp(&b.created_at.unwrap_or(0)))
            .then_with(|| a.id.cmp(&b.id))
    });
    list
}

fn read_optional_live_file(path: &Path) -> Result<Option<String>, AppError> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::io(path, error)),
    }
}

fn prompt_content_matches_live(stored: &str, live_content: &str, stripped_body: &str) -> bool {
    let norm = stored.replace("\r\n", "\n");
    let (_, stored_body, _) = split_rtk_lines(&norm);
    norm.trim() == live_content.trim()
        || (!stripped_body.trim().is_empty()
            && (norm.trim() == stripped_body.trim()
                || (!stored_body.trim().is_empty() && stored_body.trim() == stripped_body.trim())))
}

/// 根据磁盘文件内容同步修改回对应提示词，并提取应原样保留在托管区之外的前/后缀内容
fn prepare_live_backfill_and_externals(
    prompts: &mut IndexMap<String, Prompt>,
    live_content: &str,
    now: i64,
    allow_single_legacy_backfill: bool,
) -> Result<(String, String, Vec<String>), AppError> {
    prepare_live_backfill_and_externals_with_legacy(
        prompts,
        live_content,
        now,
        allow_single_legacy_backfill,
        &[],
    )
}

fn prepare_live_backfill_and_externals_with_legacy(
    prompts: &mut IndexMap<String, Prompt>,
    live_content: &str,
    now: i64,
    allow_single_legacy_backfill: bool,
    legacy_contents: &[String],
) -> Result<(String, String, Vec<String>), AppError> {
    if live_content.trim().is_empty() {
        return Ok((String::new(), String::new(), Vec::new()));
    }

    let parsed = parse_live_prompt_file(live_content)?;
    if parsed.has_markers {
        let mut changed_ids = Vec::new();
        for seg in parsed.segments {
            if let Some(prompt) = prompts.get_mut(&seg.id) {
                let normalized_existing = prompt.content.replace("\r\n", "\n");
                if prompt.enabled && normalized_existing != seg.content {
                    prompt.content = seg.content;
                    prompt.updated_at = Some(now);
                    changed_ids.push(seg.id);
                }
            }
        }
        return Ok((parsed.external_prefix, parsed.external_suffix, changed_ids));
    }

    // 兼容无分段标记的历史文件或仅含外部内容（如 @RTK.md）的文件
    let enabled_ids: Vec<String> = prompts
        .iter()
        .filter(|(_, prompt)| prompt.enabled)
        .map(|(id, _)| id.clone())
        .collect();
    let (rtk_prefix, stripped_body, rtk_suffix) = split_rtk_lines(live_content);

    if allow_single_legacy_backfill && enabled_ids.len() == 1 {
        let active_id = &enabled_ids[0];
        if !stripped_body.trim().is_empty() {
            if let Some(prompt) = prompts.get_mut(active_id) {
                let normalized_existing = prompt.content.replace("\r\n", "\n");
                let mut changed_ids = Vec::new();
                if normalized_existing.trim() != stripped_body.trim() {
                    prompt.content = stripped_body;
                    prompt.updated_at = Some(now);
                    changed_ids.push(active_id.clone());
                }
                return Ok((rtk_prefix, rtk_suffix, changed_ids));
            }
        }
        // 文件只包含 @RTK.md 引用等而正文为空时，保留外部行不清空 DB 正文
        return Ok((parsed.external_prefix, String::new(), Vec::new()));
    }

    // 若未标记内容等于新库或被替换旧库中的托管提示词，避免与恢复后的配置叠加冲突
    let matches_stored = prompts
        .values()
        .any(|prompt| prompt_content_matches_live(&prompt.content, live_content, &stripped_body))
        || legacy_contents
            .iter()
            .any(|content| prompt_content_matches_live(content, live_content, &stripped_body));
    if matches_stored {
        return Ok((rtk_prefix, rtk_suffix, Vec::new()));
    }

    Ok((parsed.external_prefix, String::new(), Vec::new()))
}

#[cfg(test)]
fn project_prompt_set_to_path(
    prompts: &IndexMap<String, Prompt>,
    target_path: &Path,
) -> Result<Option<String>, AppError> {
    let ordered = sorted_prompt_refs(prompts);
    let enabled: Vec<&Prompt> = ordered
        .into_iter()
        .filter(|prompt| prompt.enabled)
        .collect();

    if enabled.is_empty() {
        // 保持备份恢复时原有本地未托管文件内容不被清空
        return Ok(None);
    }

    let existing_live = read_optional_live_file(target_path)?;
    let (ext_prefix, ext_suffix) = match existing_live.as_deref() {
        Some(raw) if !raw.trim().is_empty() => {
            let mut snapshot = prompts.clone();
            let (prefix, suffix, _) =
                prepare_live_backfill_and_externals(&mut snapshot, raw, 0, false)?;
            (prefix, suffix)
        }
        _ => (String::new(), String::new()),
    };

    let composed = compose_prompt_document(&ext_prefix, &enabled, &ext_suffix);
    write_text_file(target_path, &composed)?;
    Ok(None)
}

fn upsert_prompt_to_path(
    state: &AppState,
    app: &AppType,
    id: &str,
    mut prompt: Prompt,
    target_path: &Path,
) -> Result<(), AppError> {
    if prompt.id != id {
        return Err(AppError::InvalidInput(
            "Prompt id does not match the requested id".to_string(),
        ));
    }
    ensure_no_segment_markers(&prompt.content)?;
    validate_prompt_content(app, &prompt.content)?;

    let _guard = PROMPT_FILE_LOCK
        .lock()
        .map_err(|error| AppError::Message(error.to_string()))?;

    let mut prompts = state.db.get_prompts(app.as_str())?;
    let was_enabled = prompts.get(id).is_some_and(|prev| prev.enabled);

    if prompt.sort_order.is_none() {
        prompt.sort_order = if let Some(prev) = prompts.get(id) {
            prev.sort_order
        } else {
            let next = prompts
                .values()
                .map(|p| p.sort_order.unwrap_or(0))
                .max()
                .map(|m| m + 1)
                .unwrap_or(0);
            Some(next)
        };
    }

    let affects_live = prompt.enabled || was_enabled;
    if !affects_live {
        return state.db.save_prompt(app.as_str(), &prompt);
    }

    let now = get_unix_timestamp()?;
    let existing_live = read_optional_live_file(target_path)?;
    let (ext_prefix, ext_suffix) = match existing_live.as_deref() {
        Some(raw) => {
            let (prefix, suffix, _) =
                prepare_live_backfill_and_externals(&mut prompts, raw, now, true)?;
            (prefix, suffix)
        }
        None => (String::new(), String::new()),
    };

    prompts.insert(id.to_string(), prompt);

    let ordered_enabled: Vec<&Prompt> = sorted_prompt_refs(&prompts)
        .into_iter()
        .filter(|p| p.enabled)
        .collect();
    let composed = compose_prompt_document(&ext_prefix, &ordered_enabled, &ext_suffix);
    if !composed.is_empty() {
        validate_prompt_content(app, &composed)?;
    }

    if composed.is_empty() && !target_path.exists() {
        return state.db.save_native_prompts(app.as_str(), &prompts);
    }

    crate::mcode_config::write_and_commit(
        target_path,
        || write_text_file(target_path, &composed),
        || state.db.save_native_prompts(app.as_str(), &prompts),
    )
}

fn update_prompt_enabled_at_path(
    state: &AppState,
    app: &AppType,
    id: &str,
    enabled: bool,
    exclusive: bool,
    target_path: &Path,
) -> Result<(), AppError> {
    let _guard = PROMPT_FILE_LOCK
        .lock()
        .map_err(|error| AppError::Message(error.to_string()))?;

    let mut prompts = state.db.get_prompts(app.as_str())?;
    {
        let target = prompts
            .get(id)
            .ok_or_else(|| AppError::InvalidInput(format!("提示词 {id} 不存在")))?;
        ensure_no_segment_markers(&target.content)?;
        validate_prompt_content(app, &target.content)?;
    }

    let now = get_unix_timestamp()?;
    let existing_live = read_optional_live_file(target_path)?;
    let (ext_prefix, ext_suffix) = match existing_live.as_deref() {
        Some(raw) => {
            let (prefix, suffix, _) =
                prepare_live_backfill_and_externals(&mut prompts, raw, now, true)?;
            (prefix, suffix)
        }
        None => (String::new(), String::new()),
    };

    if exclusive && enabled {
        for (key, prompt) in prompts.iter_mut() {
            let should_enable = key == id;
            if prompt.enabled != should_enable {
                prompt.enabled = should_enable;
                prompt.updated_at = Some(now);
            }
        }
    } else if let Some(target) = prompts.get_mut(id) {
        target.enabled = enabled;
        target.updated_at = Some(now);
    }

    let ordered_enabled: Vec<&Prompt> = sorted_prompt_refs(&prompts)
        .into_iter()
        .filter(|p| p.enabled)
        .collect();
    let composed = compose_prompt_document(&ext_prefix, &ordered_enabled, &ext_suffix);
    if !composed.is_empty() {
        validate_prompt_content(app, &composed)?;
    }

    if composed.is_empty() && !target_path.exists() {
        return state.db.save_native_prompts(app.as_str(), &prompts);
    }

    crate::mcode_config::write_and_commit(
        target_path,
        || write_text_file(target_path, &composed),
        || state.db.save_native_prompts(app.as_str(), &prompts),
    )
}

#[cfg_attr(not(test), allow(dead_code))]
fn set_prompt_enabled_at_path(
    state: &AppState,
    app: &AppType,
    id: &str,
    enabled: bool,
    target_path: &Path,
) -> Result<(), AppError> {
    update_prompt_enabled_at_path(state, app, id, enabled, false, target_path)
}

fn reorder_prompts_at_path(
    state: &AppState,
    app: &AppType,
    ids: &[String],
    target_path: &Path,
) -> Result<(), AppError> {
    let _guard = PROMPT_FILE_LOCK
        .lock()
        .map_err(|error| AppError::Message(error.to_string()))?;

    let mut prompts = state.db.get_prompts(app.as_str())?;
    let now = get_unix_timestamp()?;
    let existing_live = read_optional_live_file(target_path)?;
    let (ext_prefix, ext_suffix) = match existing_live.as_deref() {
        Some(raw) => {
            let (prefix, suffix, _) =
                prepare_live_backfill_and_externals(&mut prompts, raw, now, true)?;
            (prefix, suffix)
        }
        None => (String::new(), String::new()),
    };

    let existing_order: Vec<String> = sorted_prompt_refs(&prompts)
        .into_iter()
        .map(|p| p.id.clone())
        .collect();
    let mut next_order: i64 = 0;
    let mut seen = std::collections::HashSet::new();
    for id in ids.iter().chain(existing_order.iter()) {
        if !prompts.contains_key(id) || !seen.insert(id.clone()) {
            continue;
        }
        if let Some(prompt) = prompts.get_mut(id) {
            prompt.sort_order = Some(next_order);
            next_order += 1;
        }
    }

    let ordered_enabled: Vec<&Prompt> = sorted_prompt_refs(&prompts)
        .into_iter()
        .filter(|p| p.enabled)
        .collect();
    if ordered_enabled.is_empty() {
        return state.db.save_native_prompts(app.as_str(), &prompts);
    }

    let composed = compose_prompt_document(&ext_prefix, &ordered_enabled, &ext_suffix);
    validate_prompt_content(app, &composed)?;

    crate::mcode_config::write_and_commit(
        target_path,
        || write_text_file(target_path, &composed),
        || state.db.save_native_prompts(app.as_str(), &prompts),
    )
}

fn save_current_file_content_at_path(
    state: &AppState,
    app: &AppType,
    content: &str,
    target_path: &Path,
) -> Result<(), AppError> {
    let _guard = PROMPT_FILE_LOCK
        .lock()
        .map_err(|error| AppError::Message(error.to_string()))?;

    let normalized = content.replace("\r\n", "\n");
    let parsed = parse_live_prompt_file(&normalized)?;
    if !normalized.trim().is_empty() {
        validate_prompt_content(app, &normalized)?;
    }

    let mut prompts = state.db.get_prompts(app.as_str())?;
    let now = get_unix_timestamp()?;

    if parsed.has_markers {
        let mut present_ids = std::collections::HashSet::new();
        let mut ordered_present_ids = Vec::new();
        for seg in &parsed.segments {
            if prompts.contains_key(&seg.id) {
                present_ids.insert(seg.id.clone());
                ordered_present_ids.push(seg.id.clone());
            }
        }

        for seg in parsed.segments {
            if let Some(prompt) = prompts.get_mut(&seg.id) {
                if prompt.content.replace("\r\n", "\n") != seg.content {
                    prompt.content = seg.content;
                }
                prompt.enabled = true;
                prompt.updated_at = Some(now);
            }
        }

        for (id, prompt) in prompts.iter_mut() {
            if !present_ids.contains(id) && prompt.enabled {
                prompt.enabled = false;
                prompt.updated_at = Some(now);
            }
        }

        if ordered_present_ids.len() > 1 {
            let remaining_order: Vec<String> = sorted_prompt_refs(&prompts)
                .into_iter()
                .map(|p| p.id.clone())
                .filter(|id| !present_ids.contains(id))
                .collect();
            let mut next_order: i64 = 0;
            for id in ordered_present_ids.into_iter().chain(remaining_order) {
                if let Some(prompt) = prompts.get_mut(&id) {
                    prompt.sort_order = Some(next_order);
                    next_order += 1;
                }
            }
        }
    } else {
        let enabled_ids: Vec<String> = prompts
            .iter()
            .filter(|(_, prompt)| prompt.enabled)
            .map(|(id, _)| id.clone())
            .collect();
        let (_, stripped_body, _) = split_rtk_lines(&normalized);

        if enabled_ids.len() == 1 && !stripped_body.trim().is_empty() {
            if let Some(prompt) = prompts.get_mut(&enabled_ids[0]) {
                if prompt.content.replace("\r\n", "\n").trim() != stripped_body.trim() {
                    prompt.content = stripped_body;
                    prompt.updated_at = Some(now);
                }
            }
        } else {
            for (_, prompt) in prompts.iter_mut() {
                if prompt.enabled {
                    prompt.enabled = false;
                    prompt.updated_at = Some(now);
                }
            }
        }
    }

    if normalized.is_empty() && !target_path.exists() {
        return state.db.save_native_prompts(app.as_str(), &prompts);
    }

    crate::mcode_config::write_and_commit(
        target_path,
        || write_text_file(target_path, &normalized),
        || state.db.save_native_prompts(app.as_str(), &prompts),
    )
}

impl PromptService {
    pub fn get_prompts(
        state: &AppState,
        app: AppType,
    ) -> Result<IndexMap<String, Prompt>, AppError> {
        if matches!(app, AppType::Pi) {
            return get_pi_prompts(state);
        }
        // A restore replaces the DB before projecting it to live files. Keep
        // backfill outside that window, including calls outside the UI command.
        let Ok(_sync_guard) = super::sync_protocol::sync_mutex().try_lock() else {
            return state.db.get_prompts(app.as_str());
        };
        let mut prompts = state.db.get_prompts(app.as_str())?;
        match Self::get_current_file_content(app.clone()) {
            Ok(Some(content)) if !content.trim().is_empty() => {
                let now = get_unix_timestamp()?;
                match prepare_live_backfill_and_externals(&mut prompts, &content, now, true) {
                    Ok((_, _, changed_ids)) => {
                        for changed_id in changed_ids {
                            if let Some(updated) = prompts.get(&changed_id) {
                                state.db.save_prompt(app.as_str(), updated)?;
                            }
                        }
                    }
                    Err(error) => log::warn!(
                        "Skip {} prompt backfill due to malformed markers: {error}",
                        app.as_str()
                    ),
                }
            }
            Ok(_) => {}
            Err(error) => log::warn!(
                "Failed to refresh {} prompt from live file; keeping saved prompts: {error}",
                app.as_str()
            ),
        }
        Ok(prompts)
    }

    pub fn upsert_prompt(
        state: &AppState,
        app: AppType,
        id: &str,
        prompt: Prompt,
    ) -> Result<(), AppError> {
        if matches!(app, AppType::Pi) {
            return upsert_pi_prompt(state, id, prompt);
        }

        upsert_prompt_to_path(state, &app, id, prompt, &prompt_file_path(&app)?)
    }

    pub fn delete_prompt(state: &AppState, app: AppType, id: &str) -> Result<(), AppError> {
        if matches!(app, AppType::Pi) {
            return delete_pi_prompt(state, id);
        }
        let _guard = PROMPT_FILE_LOCK
            .lock()
            .map_err(|error| AppError::Message(error.to_string()))?;
        let prompts = state.db.get_prompts(app.as_str())?;

        if let Some(prompt) = prompts.get(id) {
            if prompt.enabled {
                return Err(AppError::InvalidInput("无法删除已启用的提示词".to_string()));
            }
        }

        state.db.delete_prompt(app.as_str(), id)?;
        Ok(())
    }

    pub fn set_prompt_enabled(
        state: &AppState,
        app: AppType,
        id: &str,
        enabled: bool,
    ) -> Result<(), AppError> {
        if matches!(app, AppType::Pi) {
            return if enabled {
                enable_pi_prompt(state, id)
            } else {
                let prompts = get_pi_prompts(state)?;
                let mut prompt = prompts
                    .get(id)
                    .cloned()
                    .ok_or_else(|| AppError::InvalidInput(format!("提示词 {id} 不存在")))?;
                prompt.enabled = false;
                upsert_pi_prompt(state, id, prompt)
            };
        }

        set_prompt_enabled_at_path(state, &app, id, enabled, &prompt_file_path(&app)?)
    }

    pub fn enable_prompt(state: &AppState, app: AppType, id: &str) -> Result<(), AppError> {
        if matches!(app, AppType::Pi) {
            return enable_pi_prompt(state, id);
        }

        update_prompt_enabled_at_path(state, &app, id, true, true, &prompt_file_path(&app)?)
    }

    pub fn reorder_prompts(state: &AppState, app: AppType, ids: &[String]) -> Result<(), AppError> {
        if matches!(app, AppType::Pi) {
            return state.db.reorder_prompts(app.as_str(), ids);
        }

        reorder_prompts_at_path(state, &app, ids, &prompt_file_path(&app)?)
    }

    pub fn import_from_file(state: &AppState, app: AppType) -> Result<String, AppError> {
        let raw_content = if matches!(app, AppType::Pi) {
            PiAgentsFileGuard::acquire()?
                .read()?
                .content
                .ok_or_else(|| AppError::Message("提示词文件不存在".to_string()))?
        } else {
            let file_path = prompt_file_path(&app)?;
            if !file_path.exists() {
                return Err(AppError::Message("提示词文件不存在".to_string()));
            }
            std::fs::read_to_string(&file_path).map_err(|e| AppError::io(&file_path, e))?
        };
        let content = if matches!(app, AppType::Pi) {
            raw_content
        } else {
            strip_segment_marker_lines(&raw_content)
        };
        let timestamp = get_unix_timestamp()?;

        let id = format!("imported-{timestamp}");
        let prompt = Prompt {
            id: id.clone(),
            name: format!(
                "导入的提示词 {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M")
            ),
            content,
            description: Some("从现有配置文件导入".to_string()),
            enabled: false,
            sort_order: None,
            created_at: Some(timestamp),
            updated_at: Some(timestamp),
        };

        Self::upsert_prompt(state, app, &id, prompt)?;
        Ok(id)
    }

    pub fn get_current_file_content(app: AppType) -> Result<Option<String>, AppError> {
        if matches!(app, AppType::Pi) {
            return Ok(PiAgentsFileGuard::acquire()?.read()?.content);
        }
        let file_path = prompt_file_path(&app)?;
        if !file_path.exists() {
            return Ok(None);
        }
        let content =
            std::fs::read_to_string(&file_path).map_err(|e| AppError::io(&file_path, e))?;
        Ok(Some(content))
    }

    pub fn save_current_file_content(
        state: &AppState,
        app: AppType,
        content: &str,
    ) -> Result<(), AppError> {
        if matches!(app, AppType::ClaudeDesktop | AppType::Pi) {
            return Err(AppError::InvalidInput(format!(
                "{} 不支持通过通用编辑器直接保存提示词文件",
                app.as_str()
            )));
        }

        save_current_file_content_at_path(state, &app, content, &prompt_file_path(&app)?)
    }

    /// Project the database SSOT to one application's managed prompt file.
    ///
    /// This deliberately does not call `enable_prompt`: restore paths must not
    /// read stale live content and write it back into the freshly imported DB.
    pub fn sync_to_live(state: &AppState, app: AppType) -> Result<(), AppError> {
        // Pi derives activation from its native AGENTS.md; its persisted prompt
        // rows are intentionally disabled and must not drive generic projection.
        if matches!(app, AppType::ClaudeDesktop | AppType::Pi) {
            return Ok(());
        }

        let target_path = prompt_file_path(&app)?;
        sync_to_live_at_path(state, &app, &target_path)
    }

    /// Best-effort projection for every Prompt-capable application.
    pub fn sync_all_to_live(state: &AppState) -> Result<(), AppError> {
        let mut failures = Vec::new();
        for app in AppType::all() {
            if matches!(app, AppType::ClaudeDesktop) {
                continue;
            }
            if let Err(error) = Self::sync_to_live(state, app.clone()) {
                log::warn!("同步 Prompt 到 {app:?} 失败: {error}");
                failures.push(format!("{}: {error}", app.as_str()));
            }
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Message(format!(
                "部分应用 Prompt 同步失败: {}",
                failures.join("; ")
            )))
        }
    }

    /// 首次启动时从现有提示词文件自动导入（如果存在）
    /// 返回导入的数量
    pub fn import_from_file_on_first_launch(
        state: &AppState,
        app: AppType,
    ) -> Result<usize, AppError> {
        // 幂等性保护：该应用已有提示词则跳过
        let existing = state.db.get_prompts(app.as_str())?;
        if !existing.is_empty() {
            return Ok(0);
        }

        let file_path = prompt_file_path(&app)?;

        // 读取文件内容。Pi 与交互式管理路径共用限长读取和协调锁。
        let content = if matches!(app, AppType::Pi) {
            match PiAgentsFileGuard::acquire().and_then(|guard| guard.read()) {
                Ok(snapshot) => match snapshot.content {
                    Some(content) => content,
                    None => return Ok(0),
                },
                Err(error) => {
                    log::warn!("读取提示词文件失败: {file_path:?}, 错误: {error}");
                    return Ok(0);
                }
            }
        } else {
            if !file_path.exists() {
                return Ok(0);
            }
            match std::fs::read_to_string(&file_path) {
                Ok(content) => content,
                Err(error) => {
                    log::warn!("读取提示词文件失败: {file_path:?}, 错误: {error}");
                    return Ok(0);
                }
            }
        };

        validate_prompt_content(&app, &content)?;
        // 检查内容是否为空
        if content.trim().is_empty() {
            return Ok(0);
        }

        log::info!("发现提示词文件，自动导入: {file_path:?}");

        // 创建提示词对象
        let timestamp = get_unix_timestamp()?;
        let id = format!("auto-imported-{timestamp}");
        let prompt = Prompt {
            id: id.clone(),
            name: format!(
                "Auto-imported Prompt {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M")
            ),
            content,
            description: Some("Automatically imported on first launch".to_string()),
            // Pi derives active state from AGENTS.md. Other apps retain their
            // established persisted prompt selection.
            enabled: !matches!(app, AppType::Pi),
            sort_order: Some(0),
            created_at: Some(timestamp),
            updated_at: Some(timestamp),
        };

        // 保存到数据库
        state.db.save_prompt(app.as_str(), &prompt)?;

        log::info!("自动导入完成: {}", app.as_str());
        Ok(1)
    }
}

#[cfg(test)]
fn upsert_mcode_prompt(
    state: &AppState,
    id: &str,
    prompt: Prompt,
    target_path: &Path,
) -> Result<(), AppError> {
    upsert_prompt_to_path(state, &AppType::Mcode, id, prompt, target_path)
}
#[cfg(test)]
fn enable_mcode_prompt(state: &AppState, id: &str, target_path: &Path) -> Result<(), AppError> {
    set_prompt_enabled_at_path(state, &AppType::Mcode, id, true, target_path)
}

fn pi_active_prompt_id(
    prompts: &IndexMap<String, Prompt>,
    live_content: Option<&str>,
) -> Option<String> {
    let live_content = live_content?;
    prompts
        .iter()
        .find(|(_, prompt)| prompt.content == live_content)
        .map(|(id, _)| id.clone())
}

fn unique_pi_backup_id(prompts: &IndexMap<String, Prompt>, timestamp: i64) -> String {
    let base = format!("backup-{timestamp}");
    if !prompts.contains_key(&base) {
        return base;
    }
    for suffix in 2_u64.. {
        let candidate = format!("{base}-{suffix}");
        if !prompts.contains_key(&candidate) {
            return candidate;
        }
    }
    unreachable!("the backup suffix space is finite only after u64 exhaustion")
}

fn get_pi_prompts(state: &AppState) -> Result<IndexMap<String, Prompt>, AppError> {
    let guard = PiAgentsFileGuard::acquire()?;
    let mut prompts = state.db.get_prompts(AppType::Pi.as_str())?;
    let snapshot = guard.read()?;
    let active_id = pi_active_prompt_id(&prompts, snapshot.content.as_deref());

    for (id, prompt) in &mut prompts {
        prompt.enabled = active_id.as_ref() == Some(id);
    }
    Ok(prompts)
}

fn upsert_pi_prompt(state: &AppState, id: &str, prompt: Prompt) -> Result<(), AppError> {
    if prompt.id != id {
        return Err(AppError::InvalidInput(
            "Pi prompt id does not match the requested id".to_string(),
        ));
    }

    let guard = PiAgentsFileGuard::acquire()?;
    let prompts = state.db.get_prompts(AppType::Pi.as_str())?;
    let snapshot = guard.read()?;
    let was_active =
        pi_active_prompt_id(&prompts, snapshot.content.as_deref()).as_deref() == Some(id);
    let previous = prompts.get(id).cloned();
    let requested_active = prompt.enabled;
    let mut stored = prompt;
    stored.enabled = false;

    if requested_active && !was_active {
        return Err(AppError::Conflict(
            "Pi AGENTS.md changed outside MSkills; reload before editing it".to_string(),
        ));
    }

    persist_pi_prompt_with_native_update(state, id, &stored, previous.as_ref(), || {
        if requested_active {
            guard.replace(&snapshot.revision, &stored.content)
        } else if was_active {
            guard.delete(&snapshot.revision)
        } else {
            Ok(())
        }
    })
}

fn persist_pi_prompt_with_native_update(
    state: &AppState,
    id: &str,
    stored: &Prompt,
    previous: Option<&Prompt>,
    update_native: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    state.db.save_prompt(AppType::Pi.as_str(), stored)?;
    if let Err(native_error) = update_native() {
        let rollback = match previous {
            Some(previous) => state.db.save_prompt(AppType::Pi.as_str(), previous),
            None => state.db.delete_prompt(AppType::Pi.as_str(), id),
        };
        if let Err(rollback_error) = rollback {
            return Err(AppError::Message(format!(
                "Pi prompt update failed ({native_error}); database rollback also failed: {rollback_error}"
            )));
        }
        return Err(native_error);
    }
    Ok(())
}

fn enable_pi_prompt(state: &AppState, id: &str) -> Result<(), AppError> {
    let guard = PiAgentsFileGuard::acquire()?;
    let prompts = state.db.get_prompts(AppType::Pi.as_str())?;
    let target = prompts
        .get(id)
        .cloned()
        .ok_or_else(|| AppError::InvalidInput(format!("提示词 {id} 不存在")))?;
    let snapshot = guard.read()?;

    if let Some(content) = snapshot.content.as_ref() {
        let already_saved = prompts.values().any(|prompt| prompt.content == *content);
        if !content.trim().is_empty() && !already_saved {
            let timestamp = get_unix_timestamp()?;
            let backup = Prompt {
                id: unique_pi_backup_id(&prompts, timestamp),
                name: format!(
                    "原始提示词 {}",
                    chrono::Local::now().format("%Y-%m-%d %H:%M")
                ),
                content: content.clone(),
                description: Some("自动备份的原始提示词".to_string()),
                enabled: false,
                sort_order: None,
                created_at: Some(timestamp),
                updated_at: Some(timestamp),
            };
            state.db.save_prompt(AppType::Pi.as_str(), &backup)?;
        }
    }

    guard.replace(&snapshot.revision, &target.content)
}

fn delete_pi_prompt(state: &AppState, id: &str) -> Result<(), AppError> {
    let guard = PiAgentsFileGuard::acquire()?;
    let prompts = state.db.get_prompts(AppType::Pi.as_str())?;
    let snapshot = guard.read()?;
    if pi_active_prompt_id(&prompts, snapshot.content.as_deref()).as_deref() == Some(id) {
        return Err(AppError::InvalidInput("无法删除已启用的提示词".to_string()));
    }
    state.db.delete_prompt(AppType::Pi.as_str(), id)?;
    Ok(())
}

fn sync_to_live_at_path(
    state: &AppState,
    app: &AppType,
    target_path: &Path,
) -> Result<(), AppError> {
    let _guard = PROMPT_FILE_LOCK
        .lock()
        .map_err(|error| AppError::Message(error.to_string()))?;
    let prompts = state.db.get_prompts(app.as_str())?;
    let legacy_contents = state.db.get_pre_restore_prompts(app.as_str())?;
    let enabled: Vec<&Prompt> = sorted_prompt_refs(&prompts)
        .into_iter()
        .filter(|prompt| prompt.enabled)
        .collect();
    if !enabled.is_empty() {
        let existing_live = read_optional_live_file(target_path)?;
        let (ext_prefix, ext_suffix) = match existing_live.as_deref() {
            Some(raw) if !raw.trim().is_empty() => {
                let mut snapshot = prompts.clone();
                let (prefix, suffix, _) = prepare_live_backfill_and_externals_with_legacy(
                    &mut snapshot,
                    raw,
                    0,
                    false,
                    &legacy_contents,
                )?;
                (prefix, suffix)
            }
            _ => (String::new(), String::new()),
        };
        let composed = compose_prompt_document(&ext_prefix, &enabled, &ext_suffix);
        validate_prompt_content(app, &composed)?;
        write_text_file(target_path, &composed)?;
    } else if !legacy_contents.is_empty() {
        if let Some(raw) = read_optional_live_file(target_path)? {
            if !raw.trim().is_empty() {
                let parsed = parse_live_prompt_file(&raw)?;
                if !parsed.has_markers {
                    let (rtk_prefix, stripped_body, rtk_suffix) = split_rtk_lines(&raw);
                    if legacy_contents
                        .iter()
                        .any(|c| prompt_content_matches_live(c, &raw, &stripped_body))
                    {
                        let composed = compose_prompt_document(&rtk_prefix, &[], &rtk_suffix);
                        write_text_file(target_path, &composed)?;
                    }
                }
            }
        }
    }
    state.db.clear_pre_restore_prompts(app.as_str())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        enable_mcode_prompt, prepare_live_backfill_and_externals, project_prompt_set_to_path,
        reorder_prompts_at_path, save_current_file_content_at_path, set_prompt_enabled_at_path,
        sync_to_live_at_path, upsert_mcode_prompt, upsert_prompt_to_path,
    };
    use crate::app_config::AppType;
    use crate::prompt::Prompt;
    use crate::prompt_files::{parse_live_prompt_file, strip_segment_marker_lines};
    use indexmap::IndexMap;
    use tempfile::tempdir;

    fn prompt(id: &str, content: &str, enabled: bool) -> Prompt {
        Prompt {
            id: id.to_string(),
            name: id.to_string(),
            content: content.to_string(),
            description: None,
            enabled,
            sort_order: None,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn mcode_prompt_database_failure_restores_edits_disables_and_new_files() {
        use crate::{database::Database, store::AppState};
        use std::sync::Arc;

        let temp = tempdir().unwrap();
        let path = temp.path().join("AGENTS.md");
        let state = AppState::new(Arc::new(Database::memory().unwrap()));
        state
            .db
            .save_prompt("mcode", &prompt("active", "original", true))
            .unwrap();
        std::fs::write(&path, "native original").unwrap();
        state
            .db
            .conn
            .lock()
            .unwrap()
            .execute_batch("PRAGMA query_only = ON")
            .unwrap();
        for changed in [
            prompt("active", "edited", true),
            prompt("active", "original", false),
        ] {
            assert!(upsert_mcode_prompt(&state, "active", changed, &path).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "native original");
            let saved = state.db.get_prompts("mcode").unwrap();
            assert!(saved["active"].enabled);
            assert_eq!(saved["active"].content, "original");
        }
        std::fs::remove_file(&path).unwrap();
        assert!(
            upsert_mcode_prompt(&state, "new", prompt("new", "new content", true), &path).is_err()
        );
        assert!(!path.exists());
        assert!(!state.db.get_prompts("mcode").unwrap().contains_key("new"));
        state
            .db
            .conn
            .lock()
            .unwrap()
            .execute_batch("PRAGMA query_only = OFF")
            .unwrap();
        upsert_mcode_prompt(&state, "active", prompt("active", "edited", true), &path).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "<!-- mskills:start id=\"active\" -->\nedited\n<!-- mskills:end id=\"active\" -->"
        );
        upsert_mcode_prompt(&state, "active", prompt("active", "edited", false), &path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
        assert!(!state.db.get_prompts("mcode").unwrap()["active"].enabled);
    }

    #[test]
    fn mcode_prompt_activation_rolls_back_partial_database_writes_and_retries() {
        use crate::{database::Database, store::AppState};
        use std::sync::Arc;

        let temp = tempdir().unwrap();
        let path = temp.path().join("AGENTS.md");
        let state = AppState::new(Arc::new(Database::memory().unwrap()));
        state
            .db
            .save_prompt("mcode", &prompt("a-current", "stored", true))
            .unwrap();
        state
            .db
            .save_prompt("mcode", &prompt("z-target", "target", false))
            .unwrap();
        std::fs::write(&path, "native edit").unwrap();
        state
            .db
            .conn
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_target BEFORE INSERT ON prompts
             WHEN NEW.app_type = 'mcode' AND NEW.id = 'z-target'
             BEGIN SELECT RAISE(ABORT, 'test write failure'); END;",
            )
            .unwrap();
        assert!(enable_mcode_prompt(&state, "z-target", &path).is_err());
        let saved = state.db.get_prompts("mcode").unwrap();
        assert_eq!(saved["a-current"].content, "stored");
        assert!(saved["a-current"].enabled);
        assert!(!saved["z-target"].enabled);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "native edit");
        state
            .db
            .conn
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_target;")
            .unwrap();
        enable_mcode_prompt(&state, "z-target", &path).unwrap();
        let saved = state.db.get_prompts("mcode").unwrap();
        assert_eq!(saved["a-current"].content, "native edit");
        assert!(saved["a-current"].enabled);
        assert!(saved["z-target"].enabled);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "<!-- mskills:start id=\"a-current\" -->\nnative edit\n<!-- mskills:end id=\"a-current\" -->\n\n<!-- mskills:start id=\"z-target\" -->\ntarget\n<!-- mskills:end id=\"z-target\" -->"
        );
    }

    #[test]
    fn mcode_prompt_activation_preserves_unmanaged_file_when_database_is_read_only() {
        use crate::{database::Database, store::AppState};
        use std::sync::Arc;

        let temp = tempdir().unwrap();
        let path = temp.path().join("AGENTS.md");
        let state = AppState::new(Arc::new(Database::memory().unwrap()));
        state
            .db
            .save_prompt("mcode", &prompt("target", "managed", false))
            .unwrap();
        std::fs::write(&path, "unmanaged").unwrap();
        state
            .db
            .conn
            .lock()
            .unwrap()
            .execute_batch("PRAGMA query_only = ON")
            .unwrap();
        assert!(enable_mcode_prompt(&state, "target", &path).is_err());
        assert_eq!(state.db.get_prompts("mcode").unwrap().len(), 1);
        assert!(!state.db.get_prompts("mcode").unwrap()["target"].enabled);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "unmanaged");
        state
            .db
            .conn
            .lock()
            .unwrap()
            .execute_batch("PRAGMA query_only = OFF")
            .unwrap();
        enable_mcode_prompt(&state, "target", &path).unwrap();
        let saved = state.db.get_prompts("mcode").unwrap();
        assert_eq!(saved.len(), 1);
        assert!(saved["target"].enabled);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "unmanaged\n\n<!-- mskills:start id=\"target\" -->\nmanaged\n<!-- mskills:end id=\"target\" -->"
        );
    }

    #[test]
    fn restored_prompt_projection_writes_the_enabled_content() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("AGENTS.md");
        let mut prompts = IndexMap::new();
        prompts.insert("off".to_string(), prompt("off", "old", false));
        prompts.insert("on".to_string(), prompt("on", "restored", true));

        let warning = project_prompt_set_to_path(&prompts, &path).expect("project prompt");
        assert!(warning.is_none());
        assert_eq!(
            std::fs::read_to_string(path).expect("read prompt"),
            "<!-- mskills:start id=\"on\" -->\nrestored\n<!-- mskills:end id=\"on\" -->"
        );
    }

    #[test]
    fn restored_prompt_projection_preserves_the_live_file_when_none_are_enabled() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("AGENTS.md");
        std::fs::write(&path, "local content").expect("seed live prompt file");
        let mut prompts = IndexMap::new();
        prompts.insert("off".to_string(), prompt("off", "managed", false));

        let warning = project_prompt_set_to_path(&prompts, &path).expect("project prompt");
        assert!(warning.is_none());
        // The live file is not part of the sync payload, so a restore with no
        // enabled prompt must not wipe local content it never contained.
        assert_eq!(
            std::fs::read_to_string(path).expect("read prompt"),
            "local content"
        );
    }

    #[test]
    fn restored_prompt_projection_concatenates_multiple_enabled_prompts_in_order() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("AGENTS.md");
        let mut prompts = IndexMap::new();
        let mut first = prompt("first", "first body", true);
        first.sort_order = Some(2);
        let mut second = prompt("second", "second body", true);
        second.sort_order = Some(1);
        prompts.insert("first".to_string(), first);
        prompts.insert("second".to_string(), second);

        let warning = project_prompt_set_to_path(&prompts, &path).expect("project prompt");
        assert!(warning.is_none());
        assert_eq!(
            std::fs::read_to_string(path).expect("read prompt"),
            "<!-- mskills:start id=\"second\" -->\nsecond body\n<!-- mskills:end id=\"second\" -->\n\n<!-- mskills:start id=\"first\" -->\nfirst body\n<!-- mskills:end id=\"first\" -->"
        );
    }

    #[test]
    fn multi_prompt_preserves_rtk_and_external_sections_and_supports_reorder() {
        use crate::{database::Database, store::AppState};
        use std::sync::Arc;

        let temp = tempdir().unwrap();
        let path = temp.path().join("CLAUDE.md");
        let state = AppState::new(Arc::new(Database::memory().unwrap()));

        // 原文件已含 RTK 引用
        std::fs::write(&path, "@RTK.md\n").unwrap();

        upsert_prompt_to_path(
            &state,
            &AppType::Claude,
            "p1",
            prompt("p1", "Rule One", false),
            &path,
        )
        .unwrap();
        upsert_prompt_to_path(
            &state,
            &AppType::Claude,
            "p2",
            prompt("p2", "Rule Two", false),
            &path,
        )
        .unwrap();

        set_prompt_enabled_at_path(&state, &AppType::Claude, "p1", true, &path).unwrap();
        set_prompt_enabled_at_path(&state, &AppType::Claude, "p2", true, &path).unwrap();

        let disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            disk,
            "@RTK.md\n\n<!-- mskills:start id=\"p1\" -->\nRule One\n<!-- mskills:end id=\"p1\" -->\n\n<!-- mskills:start id=\"p2\" -->\nRule Two\n<!-- mskills:end id=\"p2\" -->"
        );

        // 在末尾追加外部备注，同时修改 p2 片段，验证双向精确回写与外部保留
        let edited_disk =
            format!("{disk}\n\n# Hand-written note").replace("Rule Two", "Rule Two Edited");
        std::fs::write(&path, edited_disk).unwrap();

        // 调整顺序 p2 在前、p1 在后
        reorder_prompts_at_path(
            &state,
            &AppType::Claude,
            &["p2".to_string(), "p1".to_string()],
            &path,
        )
        .unwrap();

        let db_prompts = state.db.get_prompts("claude").unwrap();
        assert_eq!(db_prompts["p1"].content, "Rule One");
        assert_eq!(db_prompts["p2"].content, "Rule Two Edited");
        let ordered_ids: Vec<&String> = db_prompts.keys().collect();
        assert_eq!(ordered_ids, vec!["p2", "p1"]);

        let reordered_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            reordered_disk,
            "@RTK.md\n\n<!-- mskills:start id=\"p2\" -->\nRule Two Edited\n<!-- mskills:end id=\"p2\" -->\n\n<!-- mskills:start id=\"p1\" -->\nRule One\n<!-- mskills:end id=\"p1\" -->\n\n# Hand-written note"
        );

        // 关闭全部 MSkills 提示词后，@RTK.md 与外部手写内容必须完整保留
        set_prompt_enabled_at_path(&state, &AppType::Claude, "p1", false, &path).unwrap();
        set_prompt_enabled_at_path(&state, &AppType::Claude, "p2", false, &path).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "@RTK.md\n\n# Hand-written note"
        );
    }

    #[test]
    fn malformed_markers_abort_write_safely_and_markers_cannot_be_saved_in_content() {
        use crate::{database::Database, store::AppState};
        use std::sync::Arc;

        let temp = tempdir().unwrap();
        let path = temp.path().join("GEMINI.md");
        let state = AppState::new(Arc::new(Database::memory().unwrap()));

        assert!(upsert_prompt_to_path(
            &state,
            &AppType::Antigravity,
            "bad",
            prompt("bad", "<!-- mskills:start id=\"x\" -->", false),
            &path,
        )
        .is_err());

        upsert_prompt_to_path(
            &state,
            &AppType::Antigravity,
            "ok",
            prompt("ok", "Good body", false),
            &path,
        )
        .unwrap();

        let broken =
            "<!-- mskills:start id=\"ok\" -->\nGood body\n# accidentally deleted end marker";
        std::fs::write(&path, broken).unwrap();
        assert!(
            set_prompt_enabled_at_path(&state, &AppType::Antigravity, "ok", true, &path).is_err()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), broken);
    }

    #[test]
    fn antigravity_combined_prompt_enforces_24000_byte_limit() {
        use crate::{database::Database, store::AppState};
        use std::sync::Arc;

        let temp = tempdir().unwrap();
        let path = temp.path().join("GEMINI.md");
        let state = AppState::new(Arc::new(Database::memory().unwrap()));

        let body = "a".repeat(15_000);
        upsert_prompt_to_path(
            &state,
            &AppType::Antigravity,
            "p1",
            prompt("p1", &body, true),
            &path,
        )
        .unwrap();
        upsert_prompt_to_path(
            &state,
            &AppType::Antigravity,
            "p2",
            prompt("p2", &body, false),
            &path,
        )
        .unwrap();

        // 单条 15000 字节合法，但两条合并超过 24000 字节应被拒绝且回滚
        assert!(
            set_prompt_enabled_at_path(&state, &AppType::Antigravity, "p2", true, &path).is_err()
        );
        let parsed = parse_live_prompt_file(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed.segments.len(), 1);
        assert_eq!(parsed.segments[0].id, "p1");
        assert_eq!(
            strip_segment_marker_lines(&std::fs::read_to_string(&path).unwrap()),
            body
        );
    }

    #[test]
    fn direct_file_edit_syncs_segments_order_external_text_and_validates_markers() {
        use crate::{database::Database, store::AppState};
        use std::sync::Arc;

        let temp = tempdir().unwrap();
        let path = temp.path().join("GEMINI.md");
        let state = AppState::new(Arc::new(Database::memory().unwrap()));

        upsert_prompt_to_path(
            &state,
            &AppType::Antigravity,
            "p1",
            prompt("p1", "Body 1", true),
            &path,
        )
        .unwrap();
        upsert_prompt_to_path(
            &state,
            &AppType::Antigravity,
            "p2",
            prompt("p2", "Body 2", true),
            &path,
        )
        .unwrap();

        // 直接编辑实时文件：保留外部 @RTK.md、修改 p1 正文、调整 p2 在 p1 前
        let edited = "@RTK.md\n\n<!-- mskills:start id=\"p2\" -->\nBody 2\n<!-- mskills:end id=\"p2\" -->\n\n<!-- mskills:start id=\"p1\" -->\nBody 1 Updated\n<!-- mskills:end id=\"p1\" -->";
        save_current_file_content_at_path(&state, &AppType::Antigravity, edited, &path).unwrap();

        let db_prompts = state.db.get_prompts("antigravity").unwrap();
        assert_eq!(db_prompts["p1"].content, "Body 1 Updated");
        assert!(db_prompts["p1"].enabled);
        assert!(db_prompts["p2"].enabled);
        let ordered_ids: Vec<&String> = db_prompts.keys().collect();
        assert_eq!(ordered_ids, vec!["p2", "p1"]);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), edited);

        // 从文件中移除 p1 分段并保存，p1 在库中应同步变为未启用且保留 @RTK.md
        let only_p2 =
            "@RTK.md\n\n<!-- mskills:start id=\"p2\" -->\nBody 2\n<!-- mskills:end id=\"p2\" -->";
        save_current_file_content_at_path(&state, &AppType::Antigravity, only_p2, &path).unwrap();
        let refreshed = state.db.get_prompts("antigravity").unwrap();
        assert!(!refreshed["p1"].enabled);
        assert!(refreshed["p2"].enabled);

        // 破坏闭合标记或超出字节上限必须拒绝保存且保持磁盘原样
        let broken = "<!-- mskills:start id=\"p2\" -->\nUnclosed";
        assert!(
            save_current_file_content_at_path(&state, &AppType::Antigravity, broken, &path)
                .is_err()
        );
        let oversized = "x".repeat(25_000);
        assert!(save_current_file_content_at_path(
            &state,
            &AppType::Antigravity,
            &oversized,
            &path
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), only_p2);
    }

    #[test]
    fn empty_body_inside_valid_segment_markers_syncs_back_to_database() {
        use crate::{database::Database, store::AppState};
        use std::sync::Arc;

        let temp = tempdir().unwrap();
        let path = temp.path().join("CLAUDE.md");
        let state = AppState::new(Arc::new(Database::memory().unwrap()));

        upsert_prompt_to_path(
            &state,
            &AppType::Claude,
            "p1",
            prompt("p1", "Rule One", true),
            &path,
        )
        .unwrap();

        // 外部编辑器清空片段正文但保留完整起止标记
        std::fs::write(
            &path,
            "<!-- mskills:start id=\"p1\" -->\n<!-- mskills:end id=\"p1\" -->",
        )
        .unwrap();

        let mut prompts = state.db.get_prompts("claude").unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        let (_, _, changed_ids) =
            prepare_live_backfill_and_externals(&mut prompts, &raw, 99, true).unwrap();
        assert_eq!(changed_ids, vec!["p1".to_string()]);
        assert_eq!(prompts["p1"].content, "");
        state.db.save_prompt("claude", &prompts["p1"]).unwrap();

        // 后续再次切换或保存不会把旧正文写回
        upsert_prompt_to_path(
            &state,
            &AppType::Claude,
            "p2",
            prompt("p2", "Rule Two", true),
            &path,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "<!-- mskills:start id=\"p1\" -->\n<!-- mskills:end id=\"p1\" -->\n\n<!-- mskills:start id=\"p2\" -->\nRule Two\n<!-- mskills:end id=\"p2\" -->"
        );
    }

    #[test]
    fn restore_excludes_stale_legacy_unmarked_prompt_while_preserving_rtk_and_unmanaged_notes() {
        use crate::{database::Database, store::AppState};
        use std::sync::Arc;

        let temp = tempdir().unwrap();
        let state = AppState::new(Arc::new(Database::memory().unwrap()));

        // 目标快照导出：只启用 restored 提示词
        state
            .db
            .save_prompt("claude", &prompt("restored", "Restored rules", true))
            .unwrap();
        let sql_file = temp.path().join("snapshot.sql");
        state.db.export_sql(&sql_file).unwrap();

        // 切换回恢复前的当前数据库：旧版无标记 legacy 提示词处于启用状态，磁盘同时保留 @RTK.md
        state.db.delete_prompt("claude", "restored").unwrap();
        state
            .db
            .save_prompt("claude", &prompt("legacy", "Legacy rules", true))
            .unwrap();

        let claude_path = temp.path().join("CLAUDE.md");
        std::fs::write(&claude_path, "@RTK.md\n\nLegacy rules").unwrap();

        state.db.import_sql(&sql_file).unwrap();
        sync_to_live_at_path(&state, &AppType::Claude, &claude_path).unwrap();

        assert_eq!(
            std::fs::read_to_string(&claude_path).unwrap(),
            "@RTK.md\n\n<!-- mskills:start id=\"restored\" -->\nRestored rules\n<!-- mskills:end id=\"restored\" -->"
        );

        // 若磁盘内容从未出现在恢复前后数据库中（真正未托管手写内容），恢复后仍予以保留
        let codex_path = temp.path().join("AGENTS.md");
        std::fs::write(&codex_path, "# Local manual rules").unwrap();
        state
            .db
            .save_prompt("codex", &prompt("c1", "Snapshot codex rules", true))
            .unwrap();
        sync_to_live_at_path(&state, &AppType::Codex, &codex_path).unwrap();
        assert_eq!(
            std::fs::read_to_string(&codex_path).unwrap(),
            "# Local manual rules\n\n<!-- mskills:start id=\"c1\" -->\nSnapshot codex rules\n<!-- mskills:end id=\"c1\" -->"
        );
    }
}

#[cfg(test)]
mod pi_prompt_tests {
    use super::*;
    use crate::database::Database;
    use crate::pi_config::test_support::TestAgentDir;
    use serial_test::serial;
    use std::sync::Arc;

    fn prompt(enabled: bool) -> Prompt {
        Prompt {
            id: "test-prompt".to_string(),
            name: "Test prompt".to_string(),
            content: "managed content".to_string(),
            description: None,
            enabled,
            sort_order: None,
            created_at: Some(1),
            updated_at: Some(1),
        }
    }

    #[test]
    #[serial]
    fn pi_active_prompt_is_derived_from_agents_file() {
        let _agent = TestAgentDir::new();
        let state = AppState::new(Arc::new(
            Database::memory().expect("create in-memory database"),
        ));
        state
            .db
            .save_prompt(AppType::Pi.as_str(), &prompt(true))
            .expect("save prompt");

        let saved = PromptService::get_prompts(&state, AppType::Pi).expect("load prompts");
        assert!(!saved["test-prompt"].enabled);

        let path = prompt_file_path(&AppType::Pi).expect("prompt path");
        write_text_file(&path, "managed content").expect("write AGENTS.md");
        let active = PromptService::get_prompts(&state, AppType::Pi).expect("load prompts");
        assert!(active["test-prompt"].enabled);

        write_text_file(&path, "external edit").expect("edit AGENTS.md externally");
        let drifted = PromptService::get_prompts(&state, AppType::Pi).expect("load prompts");
        assert!(!drifted["test-prompt"].enabled);
        assert!(
            PromptService::upsert_prompt(&state, AppType::Pi, "test-prompt", prompt(true),)
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(&path).expect("read AGENTS.md"),
            "external edit"
        );

        write_text_file(&path, "managed content").expect("restore AGENTS.md");
        PromptService::upsert_prompt(&state, AppType::Pi, "test-prompt", prompt(false))
            .expect("disable prompt");
        assert!(!path.exists());
    }

    #[test]
    #[serial]
    fn generic_prompt_projection_does_not_rewrite_pi_agents_file() {
        let _agent = TestAgentDir::new();
        let state = AppState::new(Arc::new(
            Database::memory().expect("create in-memory database"),
        ));
        state
            .db
            .save_prompt(AppType::Pi.as_str(), &prompt(false))
            .expect("save Pi prompt");

        let path = prompt_file_path(&AppType::Pi).expect("prompt path");
        write_text_file(&path, "native instructions").expect("write AGENTS.md");

        PromptService::sync_to_live(&state, AppType::Pi).expect("sync prompts");

        assert_eq!(
            std::fs::read_to_string(path).expect("read AGENTS.md"),
            "native instructions"
        );
    }

    #[test]
    #[serial]
    fn editing_an_inactive_duplicate_pi_prompt_preserves_agents_file() {
        let _agent = TestAgentDir::new();
        let state = AppState::new(Arc::new(
            Database::memory().expect("create in-memory database"),
        ));
        let first = prompt(false);
        let mut duplicate = first.clone();
        duplicate.id = "duplicate-prompt".to_string();
        duplicate.name = "Duplicate prompt".to_string();
        duplicate.created_at = Some(2);
        state
            .db
            .save_prompt(AppType::Pi.as_str(), &first)
            .expect("save first prompt");
        state
            .db
            .save_prompt(AppType::Pi.as_str(), &duplicate)
            .expect("save duplicate prompt");
        let path = prompt_file_path(&AppType::Pi).expect("prompt path");
        write_text_file(&path, "managed content").expect("write AGENTS.md");

        let hydrated = PromptService::get_prompts(&state, AppType::Pi).expect("load prompts");
        assert!(hydrated["test-prompt"].enabled);
        assert!(!hydrated["duplicate-prompt"].enabled);

        duplicate.content = "edited duplicate".to_string();
        PromptService::upsert_prompt(&state, AppType::Pi, "duplicate-prompt", duplicate)
            .expect("edit inactive duplicate");

        assert_eq!(
            std::fs::read_to_string(&path).expect("read AGENTS.md"),
            "managed content"
        );
        let refreshed = PromptService::get_prompts(&state, AppType::Pi).expect("reload prompts");
        assert!(refreshed["test-prompt"].enabled);
        assert!(!refreshed["duplicate-prompt"].enabled);
    }

    #[test]
    #[serial]
    fn failed_pi_native_update_restores_the_previous_database_prompt() {
        let _agent = TestAgentDir::new();
        let state = AppState::new(Arc::new(
            Database::memory().expect("create in-memory database"),
        ));
        let previous = prompt(false);
        state
            .db
            .save_prompt(AppType::Pi.as_str(), &previous)
            .expect("save previous prompt");
        let mut edited = previous.clone();
        edited.content = "edited content".to_string();

        let result = persist_pi_prompt_with_native_update(
            &state,
            &edited.id,
            &edited,
            Some(&previous),
            || Err(AppError::Message("native write failed".to_string())),
        );

        assert!(result.is_err());
        let saved = state
            .db
            .get_prompts(AppType::Pi.as_str())
            .expect("reload prompts");
        assert_eq!(saved["test-prompt"].content, "managed content");
    }

    #[test]
    fn pi_backup_ids_do_not_replace_an_existing_same_second_backup() {
        let mut prompts = IndexMap::new();
        let mut first = prompt(false);
        first.id = "backup-42".to_string();
        prompts.insert(first.id.clone(), first);
        let mut second = prompt(false);
        second.id = "backup-42-2".to_string();
        prompts.insert(second.id.clone(), second);

        assert_eq!(unique_pi_backup_id(&prompts, 42), "backup-42-3");
    }
}
