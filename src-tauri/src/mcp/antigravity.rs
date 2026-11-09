//! Antigravity MCP synchronization and import module.
//!
//! Antigravity reads user-level MCP servers from `~/.gemini/config/mcp_config.json`
//! under the top-level `mcpServers` object. It supports `stdio` (`command`, `args`, `env`)
//! and Streamable HTTP (`url`, or legacy `serverUrl` on import), and does not support
//! legacy HTTP+SSE (`sse`).

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::app_config::{AppType, McpApps, McpServer};
use crate::config::atomic_write_private;
use crate::error::AppError;
use crate::store::AppState;

use super::validation::validate_server_spec;

fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn read_mcp_config() -> Result<Value, AppError> {
    let path = crate::antigravity_config::mcp_config_path();
    if !path.exists() {
        return Ok(json!({}));
    }
    let content = std::fs::read_to_string(&path).map_err(|e| AppError::io(&path, e))?;
    if content.trim().is_empty() {
        return Ok(json!({}));
    }
    let value: Value = serde_json::from_str(&content).map_err(|e| AppError::json(&path, e))?;
    if !value.is_object() {
        return Err(AppError::McpValidation(format!(
            "{} root must be a JSON object",
            path.display()
        )));
    }
    Ok(value)
}

fn ensure_mcp_servers_map(root: &mut Value) -> Result<&mut Map<String, Value>, AppError> {
    let path = crate::antigravity_config::mcp_config_path();
    let root_obj = root.as_object_mut().ok_or_else(|| {
        AppError::McpValidation(format!("{} root must be a JSON object", path.display()))
    })?;
    if !root_obj.contains_key("mcpServers") {
        root_obj.insert("mcpServers".to_string(), Value::Object(Map::new()));
    }
    root_obj
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            AppError::McpValidation(format!(
                "{} mcpServers must be a JSON object",
                path.display()
            ))
        })
}

fn build_antigravity_entry(existing: Option<&Value>, spec: &Value) -> Result<Value, AppError> {
    validate_server_spec(spec)?;
    let obj = spec
        .as_object()
        .ok_or_else(|| AppError::McpValidation("MCP server spec must be a JSON object".into()))?;
    let mut out = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let typ = obj.get("type").and_then(Value::as_str).unwrap_or("stdio");
    match typ {
        "stdio" => {
            for key in ["type", "url", "serverUrl", "headers"] {
                out.remove(key);
            }
            let command = obj.get("command").and_then(Value::as_str).unwrap_or("");
            out.insert("command".to_string(), Value::String(command.to_string()));
            match obj.get("args").and_then(Value::as_array) {
                Some(args) if !args.is_empty() => {
                    out.insert("args".to_string(), Value::Array(args.clone()));
                }
                _ => {
                    out.remove("args");
                }
            }
            match obj.get("env").and_then(Value::as_object) {
                Some(env) if !env.is_empty() => {
                    out.insert("env".to_string(), Value::Object(env.clone()));
                }
                _ => {
                    out.remove("env");
                }
            }
        }
        "http" => {
            for key in ["type", "command", "args", "env", "cwd", "serverUrl"] {
                out.remove(key);
            }
            let url = obj.get("url").and_then(Value::as_str).unwrap_or("");
            out.insert("url".to_string(), Value::String(url.to_string()));
            match obj.get("headers").and_then(Value::as_object) {
                Some(headers) if !headers.is_empty() => {
                    out.insert("headers".to_string(), Value::Object(headers.clone()));
                }
                _ => {
                    out.remove("headers");
                }
            }
        }
        "sse" => {
            return Err(AppError::McpValidation(
                "Antigravity does not support legacy HTTP+SSE MCP servers; use stdio or Streamable HTTP (url) instead"
                    .into(),
            ));
        }
        other => {
            return Err(AppError::McpValidation(format!(
                "Unsupported Antigravity MCP server type '{other}'"
            )));
        }
    }

    Ok(Value::Object(out))
}

fn write_mcp_config(root: &Value) -> Result<(), AppError> {
    let path = crate::antigravity_config::mcp_config_path();
    let mut text = serde_json::to_string_pretty(root)
        .map_err(|e| AppError::Message(format!("Failed to serialize Antigravity MCP JSON: {e}")))?;
    text.push('\n');
    atomic_write_private(&path, text.as_bytes())
}

/// Sync a single MCP server to Antigravity's `mcp_config.json`.
pub fn sync_server(id: &str, spec: &Value) -> Result<(), AppError> {
    let _guard = write_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut root = read_mcp_config()?;
    let servers = ensure_mcp_servers_map(&mut root)?;
    let entry = build_antigravity_entry(servers.get(id), spec)?;
    servers.insert(id.to_string(), entry);
    write_mcp_config(&root)
}

/// Remove a single MCP server from Antigravity's `mcp_config.json`.
pub fn remove_server(id: &str) -> Result<(), AppError> {
    let _guard = write_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = crate::antigravity_config::mcp_config_path();
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_mcp_config()?;
    let Some(servers) = root.get_mut("mcpServers").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    if servers.remove(id).is_none() {
        return Ok(());
    }
    write_mcp_config(&root)
}

/// Replace all Antigravity MCP servers in `mcp_config.json` with the given set.
#[allow(dead_code)]
pub fn replace_servers(servers: &HashMap<String, Value>) -> Result<(), AppError> {
    let _guard = write_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = crate::antigravity_config::mcp_config_path();
    if servers.is_empty() && !path.exists() {
        return Ok(());
    }
    let mut root = read_mcp_config()?;
    let existing = root
        .get("mcpServers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let target = ensure_mcp_servers_map(&mut root)?;
    let mut next = Map::new();
    let mut ids: Vec<&String> = servers.keys().collect();
    ids.sort();
    for id in ids {
        let spec = &servers[id];
        next.insert(id.clone(), build_antigravity_entry(existing.get(id), spec)?);
    }
    *target = next;
    write_mcp_config(&root)
}

fn normalize_imported_spec(raw: &Value) -> Option<Value> {
    let obj = raw.as_object()?;
    let mut out = Map::new();

    if let Some(cmd) = obj
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        out.insert("type".to_string(), Value::String("stdio".to_string()));
        out.insert("command".to_string(), Value::String(cmd.to_string()));
        if let Some(args) = obj.get("args").and_then(Value::as_array) {
            if !args.is_empty() {
                out.insert("args".to_string(), Value::Array(args.clone()));
            }
        }
        if let Some(env) = obj.get("env").and_then(Value::as_object) {
            if !env.is_empty() {
                out.insert("env".to_string(), Value::Object(env.clone()));
            }
        }
        return Some(Value::Object(out));
    }

    let url = obj
        .get("url")
        .or_else(|| obj.get("serverUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    out.insert("type".to_string(), Value::String("http".to_string()));
    out.insert("url".to_string(), Value::String(url.to_string()));
    if let Some(headers) = obj.get("headers").and_then(Value::as_object) {
        if !headers.is_empty() {
            out.insert("headers".to_string(), Value::Object(headers.clone()));
        }
    }
    Some(Value::Object(out))
}

/// Import MCP servers from Antigravity's `mcp_config.json` into unified storage.
pub fn import(state: &AppState) -> Result<usize, AppError> {
    let path = crate::antigravity_config::mcp_config_path();
    if !path.exists() {
        return Ok(0);
    }
    let root = read_mcp_config()?;
    let Some(map) = root.get("mcpServers").and_then(Value::as_object) else {
        return Ok(0);
    };

    let mut existing = state.db.get_all_mcp_servers()?;
    let mut changed = 0usize;

    for (id, raw_entry) in map {
        let Some(spec) = normalize_imported_spec(raw_entry) else {
            log::warn!("Skipping Antigravity MCP server '{id}': missing command or url");
            continue;
        };
        if let Err(err) = validate_server_spec(&spec) {
            log::warn!("Skipping invalid Antigravity MCP server '{id}': {err}");
            continue;
        }

        if let Some(mut server) = existing.shift_remove(id) {
            if !server.apps.antigravity {
                server.apps.antigravity = true;
                state.db.save_mcp_server(&server)?;
                changed += 1;
            }
        } else {
            let mut apps = McpApps::default();
            apps.set_enabled_for(&AppType::Antigravity, true);
            let server = McpServer {
                id: id.clone(),
                name: id.clone(),
                server: spec,
                apps,
                description: None,
                homepage: None,
                docs: None,
                tags: Vec::new(),
            };
            state.db.save_mcp_server(&server)?;
            changed += 1;
        }
    }

    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antigravity_mcp_builds_stdio_and_http_and_rejects_sse() {
        let stdio = build_antigravity_entry(
            Some(&json!({"customField": 42, "url": "https://old.example.com"})),
            &json!({"type": "stdio", "command": "npx", "args": ["-y", "mcp-test"]}),
        )
        .unwrap();
        assert_eq!(stdio["command"], "npx");
        assert_eq!(stdio["args"], json!(["-y", "mcp-test"]));
        assert_eq!(stdio["customField"], 42);
        assert!(stdio.get("type").is_none());
        assert!(stdio.get("url").is_none());

        let http = build_antigravity_entry(
            None,
            &json!({"type": "http", "url": "https://example.com/mcp", "headers": {"Authorization": "Bearer tok"}}),
        )
        .unwrap();
        assert_eq!(http["url"], "https://example.com/mcp");
        assert_eq!(http["headers"]["Authorization"], "Bearer tok");
        assert!(http.get("type").is_none());

        let sse = build_antigravity_entry(
            None,
            &json!({"type": "sse", "url": "https://example.com/sse"}),
        );
        assert!(sse.is_err());

        let imported =
            normalize_imported_spec(&json!({"serverUrl": "https://legacy.example.com/mcp"}))
                .unwrap();
        assert_eq!(imported["type"], "http");
        assert_eq!(imported["url"], "https://legacy.example.com/mcp");
    }
}
