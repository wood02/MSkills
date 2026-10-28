use std::fs;
use std::path::PathBuf;

use crate::error::AppError;

const CLAUDE_DIR: &str = ".claude";
const CLAUDE_CONFIG_FILE: &str = "config.json";

fn claude_dir() -> Result<PathBuf, AppError> {
    // 优先使用设置中的覆盖目录
    if let Some(dir) = crate::settings::get_claude_override_dir() {
        return Ok(dir);
    }
    let home = dirs::home_dir().ok_or_else(|| AppError::Config("无法获取用户主目录".into()))?;
    Ok(home.join(CLAUDE_DIR))
}

pub fn claude_config_path() -> Result<PathBuf, AppError> {
    Ok(claude_dir()?.join(CLAUDE_CONFIG_FILE))
}

pub fn ensure_claude_dir_exists() -> Result<PathBuf, AppError> {
    let dir = claude_dir()?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| AppError::io(&dir, e))?;
    }
    Ok(dir)
}

pub fn read_claude_config() -> Result<Option<String>, AppError> {
    let path = claude_config_path()?;
    if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| AppError::io(&path, e))?;
        Ok(Some(content))
    } else {
        Ok(None)
    }
}

fn is_managed_config(content: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(value) => value
            .get("primaryApiKey")
            .and_then(|v| v.as_str())
            .map(|val| val == "any")
            .unwrap_or(false),
        Err(_) => false,
    }
}

pub fn write_claude_config() -> Result<bool, AppError> {
    // 增量写入：仅设置 primaryApiKey = "any"，保留其它字段
    let path = claude_config_path()?;
    ensure_claude_dir_exists()?;

    // 尝试读取并解析为对象
    let mut obj = match read_claude_config()? {
        Some(existing) => match serde_json::from_str::<serde_json::Value>(&existing) {
            Ok(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
            _ => serde_json::json!({}),
        },
        None => serde_json::json!({}),
    };

    let mut changed = false;
    if let Some(map) = obj.as_object_mut() {
        let cur = map
            .get("primaryApiKey")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if cur != "any" {
            map.insert(
                "primaryApiKey".to_string(),
                serde_json::Value::String("any".to_string()),
            );
            changed = true;
        }
    }

    if changed || !path.exists() {
        let serialized = serde_json::to_string_pretty(&obj)
            .map_err(|e| AppError::JsonSerialize { source: e })?;
        fs::write(&path, format!("{serialized}\n")).map_err(|e| AppError::io(&path, e))?;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn clear_claude_config() -> Result<bool, AppError> {
    let path = claude_config_path()?;
    if !path.exists() {
        return Ok(false);
    }

    let content = match read_claude_config()? {
        Some(content) => content,
        None => return Ok(false),
    };

    let mut value = match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };

    let obj = match value.as_object_mut() {
        Some(obj) => obj,
        None => return Ok(false),
    };

    if obj.remove("primaryApiKey").is_none() {
        return Ok(false);
    }

    let serialized =
        serde_json::to_string_pretty(&value).map_err(|e| AppError::JsonSerialize { source: e })?;
    fs::write(&path, format!("{serialized}\n")).map_err(|e| AppError::io(&path, e))?;
    Ok(true)
}

pub fn claude_config_status() -> Result<(bool, PathBuf), AppError> {
    let path = claude_config_path()?;
    Ok((path.exists(), path))
}

pub fn is_claude_config_applied() -> Result<bool, AppError> {
    match read_claude_config()? {
        Some(content) => Ok(is_managed_config(&content)),
        None => Ok(false),
    }
}

// ===== Claude Code 插件（~/.claude/plugins + settings.json 的 enabledPlugins） =====

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodePlugin {
    /// `name@marketplace`，与 enabledPlugins 的键一致
    pub id: String,
    pub name: String,
    pub marketplace: String,
    pub version: Option<String>,
    pub scope: Option<String>,
    pub description: Option<String>,
    pub installed: bool,
    pub enabled: bool,
}

fn read_json_or_default(path: &std::path::Path) -> Result<serde_json::Value, AppError> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(path).map_err(|e| AppError::io(path, e))?;
    serde_json::from_str(&content).map_err(|e| AppError::json(path, e))
}

/// 合并已安装清单与 enabledPlugins：只出现在 enabledPlugins 里的视为未安装
pub fn list_claude_code_plugins_in(
    claude_dir: &std::path::Path,
    settings_path: &std::path::Path,
) -> Result<Vec<ClaudeCodePlugin>, AppError> {
    let installed = read_json_or_default(&claude_dir.join("plugins/installed_plugins.json"))?;
    let settings = read_json_or_default(settings_path)?;
    let enabled_map = settings.get("enabledPlugins").and_then(|v| v.as_object());

    let mut plugins = std::collections::BTreeMap::new();
    if let Some(map) = installed.get("plugins").and_then(|v| v.as_object()) {
        for (id, entries) in map {
            // 同一插件可能有多条安装记录，取最近更新的那条
            let entry = entries.as_array().and_then(|list| {
                list.iter().max_by_key(|e| {
                    e.get("lastUpdated")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string()
                })
            });
            let str_field = |key: &str| {
                entry
                    .and_then(|e| e.get(key))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            };
            let description = str_field("installPath").and_then(|p| {
                let manifest = PathBuf::from(p).join(".claude-plugin/plugin.json");
                let value = read_json_or_default(&manifest).ok()?;
                value.get("description")?.as_str().map(str::to_string)
            });
            plugins.insert(
                id.clone(),
                (str_field("version"), str_field("scope"), description, true),
            );
        }
    }
    if let Some(map) = enabled_map {
        for id in map.keys() {
            plugins
                .entry(id.clone())
                .or_insert((None, None, None, false));
        }
    }

    Ok(plugins
        .into_iter()
        .map(|(id, (version, scope, description, installed))| {
            let (name, marketplace) = id
                .split_once('@')
                .map(|(n, m)| (n.to_string(), m.to_string()))
                .unwrap_or_else(|| (id.clone(), String::new()));
            let enabled = enabled_map
                .and_then(|m| m.get(&id))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            ClaudeCodePlugin {
                id,
                name,
                marketplace,
                version,
                scope,
                description,
                installed,
                enabled,
            }
        })
        .collect())
}

/// 只改 enabledPlugins 的一个键；settings.json 解析失败时报错而不是覆盖
pub fn set_claude_code_plugin_enabled_in(
    settings_path: &std::path::Path,
    id: &str,
    enabled: bool,
) -> Result<(), AppError> {
    let mut settings = read_json_or_default(settings_path)?;
    let obj = settings
        .as_object_mut()
        .ok_or_else(|| AppError::Config("settings.json 顶层必须是 JSON 对象".into()))?;
    let plugins = obj
        .entry("enabledPlugins")
        .or_insert_with(|| serde_json::json!({}));
    let plugins = plugins
        .as_object_mut()
        .ok_or_else(|| AppError::Config("enabledPlugins 必须是 JSON 对象".into()))?;
    plugins.insert(id.to_string(), serde_json::Value::Bool(enabled));
    crate::config::write_json_file(settings_path, &settings)
}

pub fn list_claude_code_plugins() -> Result<Vec<ClaudeCodePlugin>, AppError> {
    list_claude_code_plugins_in(
        &crate::config::get_claude_config_dir(),
        &crate::config::get_claude_settings_path(),
    )
}

pub fn set_claude_code_plugin_enabled(id: &str, enabled: bool) -> Result<(), AppError> {
    set_claude_code_plugin_enabled_in(&crate::config::get_claude_settings_path(), id, enabled)
}

#[cfg(test)]
mod claude_code_plugin_tests {
    use super::*;

    #[test]
    fn lists_installed_and_enabled_plugins_and_toggles_one_key() {
        let dir = tempfile::tempdir().unwrap();
        let install_path = dir.path().join("cache/review");
        fs::create_dir_all(install_path.join(".claude-plugin")).unwrap();
        fs::write(
            install_path.join(".claude-plugin/plugin.json"),
            r#"{"name":"review","description":"Code review"}"#,
        )
        .unwrap();
        fs::create_dir_all(dir.path().join("plugins")).unwrap();
        fs::write(
            dir.path().join("plugins/installed_plugins.json"),
            serde_json::json!({"version":2,"plugins":{"review@official":[
                {"scope":"user","version":"old","lastUpdated":"2026-01-01T00:00:00Z","installPath":"/nope"},
                {"scope":"user","version":"new","lastUpdated":"2026-10-01T00:00:00Z","installPath":install_path}
            ]}})
            .to_string(),
        )
        .unwrap();
        let settings = dir.path().join("settings.json");
        fs::write(
            &settings,
            r#"{"model":"x","enabledPlugins":{"review@official":true,"gone@other":false}}"#,
        )
        .unwrap();

        let list = list_claude_code_plugins_in(dir.path(), &settings).unwrap();
        assert_eq!(list.len(), 2);
        let gone = &list[0];
        assert_eq!(
            (gone.id.as_str(), gone.installed, gone.enabled),
            ("gone@other", false, false)
        );
        let review = &list[1];
        assert_eq!(review.name, "review");
        assert_eq!(review.marketplace, "official");
        assert_eq!(review.version.as_deref(), Some("new"));
        assert_eq!(review.description.as_deref(), Some("Code review"));
        assert!(review.installed && review.enabled);

        set_claude_code_plugin_enabled_in(&settings, "review@official", false).unwrap();
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(saved["model"], "x");
        assert_eq!(saved["enabledPlugins"]["review@official"], false);
        assert_eq!(saved["enabledPlugins"]["gone@other"], false);
    }

    #[test]
    fn toggle_refuses_to_overwrite_invalid_settings() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        fs::write(&settings, "{broken").unwrap();
        assert!(set_claude_code_plugin_enabled_in(&settings, "a@b", true).is_err());
        assert_eq!(fs::read_to_string(&settings).unwrap(), "{broken");
    }
}
