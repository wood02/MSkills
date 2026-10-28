#![allow(non_snake_case)]

use crate::config::ConfigStatus;

/// Claude 插件：获取 ~/.claude/config.json 状态
#[tauri::command]
pub async fn get_claude_plugin_status() -> Result<ConfigStatus, String> {
    crate::claude_plugin::claude_config_status()
        .map(|(exists, path)| ConfigStatus {
            exists,
            path: path.to_string_lossy().to_string(),
        })
        .map_err(|e| e.to_string())
}

/// Claude 插件：读取配置内容（若不存在返回 Ok(None)）
#[tauri::command]
pub async fn read_claude_plugin_config() -> Result<Option<String>, String> {
    crate::claude_plugin::read_claude_config().map_err(|e| e.to_string())
}

/// Claude 插件：写入/清除固定配置
#[tauri::command]
pub async fn apply_claude_plugin_config(official: bool) -> Result<bool, String> {
    if official {
        crate::claude_plugin::clear_claude_config().map_err(|e| e.to_string())
    } else {
        crate::claude_plugin::write_claude_config().map_err(|e| e.to_string())
    }
}

/// Claude 插件：检测是否已写入目标配置
#[tauri::command]
pub async fn is_claude_plugin_applied() -> Result<bool, String> {
    crate::claude_plugin::is_claude_config_applied().map_err(|e| e.to_string())
}

/// Claude Code：跳过初次安装确认（写入 ~/.claude.json 的 hasCompletedOnboarding=true）
#[tauri::command]
pub async fn apply_claude_onboarding_skip() -> Result<bool, String> {
    crate::claude_mcp::set_has_completed_onboarding().map_err(|e| e.to_string())
}

/// Claude Code：恢复初次安装确认（删除 ~/.claude.json 的 hasCompletedOnboarding 字段）
#[tauri::command]
pub async fn clear_claude_onboarding_skip() -> Result<bool, String> {
    crate::claude_mcp::clear_has_completed_onboarding().map_err(|e| e.to_string())
}

/// Claude Code 插件：列出已安装/已登记的插件
#[tauri::command]
pub async fn list_claude_code_plugins(
) -> Result<Vec<crate::claude_plugin::ClaudeCodePlugin>, String> {
    crate::claude_plugin::list_claude_code_plugins().map_err(|e| e.to_string())
}

/// Claude Code 插件：在 settings.json 的 enabledPlugins 中启用/禁用
#[tauri::command]
pub async fn set_claude_code_plugin_enabled(id: String, enabled: bool) -> Result<(), String> {
    crate::claude_plugin::set_claude_code_plugin_enabled(&id, enabled).map_err(|e| e.to_string())
}

/// Codex 插件：config.toml 中各插件的启用状态
#[tauri::command]
pub async fn list_codex_plugin_states() -> Result<std::collections::BTreeMap<String, bool>, String>
{
    crate::codex_config::list_codex_plugin_states().map_err(|e| e.to_string())
}

/// Codex 插件：在 config.toml 中启用/禁用
#[tauri::command]
pub async fn set_codex_plugin_enabled(id: String, enabled: bool) -> Result<(), String> {
    crate::codex_config::set_codex_plugin_enabled(&id, enabled).map_err(|e| e.to_string())
}
