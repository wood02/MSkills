//! Google Antigravity configuration directory helpers.
//!
//! Antigravity stores its global user customizations (MCP servers, skills, rules, plugins)
//! under `~/.gemini/config/`, while runtime conversation transcripts and artifacts live
//! under `~/.gemini/antigravity/brain/<conversation-id>/`.

use std::path::PathBuf;

/// Default global configuration directory for Antigravity (`~/.gemini/config`).
pub fn default_config_dir() -> PathBuf {
    crate::config::get_home_dir().join(".gemini").join("config")
}

/// Active global configuration directory for Antigravity, respecting user override.
pub fn config_dir() -> PathBuf {
    crate::settings::get_antigravity_override_dir().unwrap_or_else(default_config_dir)
}

/// Default application data directory for Antigravity (`~/.gemini/antigravity`).
pub fn default_data_dir() -> PathBuf {
    crate::config::get_home_dir()
        .join(".gemini")
        .join("antigravity")
}

/// Active application data directory for Antigravity (used for `brain/` session transcripts).
///
/// When `antigravity_config_dir` is overridden:
/// - If `<override>/brain` exists, uses `<override>`.
/// - If `<override>/antigravity/brain` exists, uses `<override>/antigravity`.
/// - If `<override>` ends with `config` (matching `~/.gemini/config` layout), uses `<parent>/antigravity`.
/// - Otherwise falls back to `<override>`.
pub fn data_dir() -> PathBuf {
    if let Some(override_dir) = crate::settings::get_antigravity_override_dir() {
        if override_dir.join("brain").is_dir() {
            return override_dir;
        }
        let nested = override_dir.join("antigravity");
        if nested.join("brain").is_dir() {
            return nested;
        }
        if override_dir.file_name().and_then(|s| s.to_str()) == Some("config") {
            if let Some(parent) = override_dir.parent() {
                return parent.join("antigravity");
            }
        }
        return override_dir;
    }
    default_data_dir()
}

/// Path to Antigravity's global MCP configuration file (`~/.gemini/config/mcp_config.json`).
pub fn mcp_config_path() -> PathBuf {
    config_dir().join("mcp_config.json")
}
