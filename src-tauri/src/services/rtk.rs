use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RtkStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub binary_path: Option<String>,
    pub db_path: Option<String>,
    pub has_data: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RtkDailyStat {
    pub date: String,
    pub saved_tokens: i64,
    pub output_tokens: i64,
    pub input_tokens: i64,
    pub command_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RtkGainSummary {
    pub total_commands: i64,
    pub total_saved_tokens: i64,
    pub total_output_tokens: i64,
    pub total_input_tokens: i64,
    pub savings_pct: f64,
    pub filtered_commands: i64,
    pub filtered_saved_tokens: i64,
    pub filtered_savings_pct: f64,
    pub daily_stats: Vec<RtkDailyStat>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RtkAgentItem {
    pub id: String,
    pub name: String,
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    pub installed: bool,
    pub enabled: bool,
}

pub struct RtkService;

impl RtkService {
    /// 查找系统中是否存在 rtk 二进制
    pub fn find_rtk_binary() -> Option<PathBuf> {
        let common_paths = [
            "/opt/homebrew/bin/rtk",
            "/usr/local/bin/rtk",
            "/usr/bin/rtk",
        ];

        for p in &common_paths {
            let path = PathBuf::from(p);
            if path.exists() && path.is_file() {
                return Some(path);
            }
        }

        if let Ok(home) = std::env::var("HOME") {
            let cargo_bin = PathBuf::from(&home).join(".cargo/bin/rtk");
            if cargo_bin.exists() && cargo_bin.is_file() {
                return Some(cargo_bin);
            }
        }

        if let Ok(output) = Command::new("which").arg("rtk").output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !stdout.is_empty() {
                    let path = PathBuf::from(stdout);
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
        }

        None
    }

    /// 获取 RTK 版本
    pub fn get_rtk_version(bin: &Path) -> Option<String> {
        let output = Command::new(bin).arg("--version").output().ok()?;
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            let first_line = text.lines().next().unwrap_or("").trim();
            // 提取诸如 "rtk 1.2.0" -> "v1.2.0"
            for part in first_line.split_whitespace() {
                if part.starts_with(char::is_numeric) {
                    return Some(format!("v{}", part));
                } else if part.starts_with('v') && part.len() > 1 {
                    return Some(part.to_string());
                }
            }
            if !first_line.is_empty() {
                return Some(first_line.to_string());
            }
        }
        None
    }

    /// 获取 RTK 数据库路径
    pub fn get_db_path() -> Option<PathBuf> {
        #[cfg(target_os = "macos")]
        {
            if let Ok(home) = std::env::var("HOME") {
                let db = PathBuf::from(home).join("Library/Application Support/rtk/history.db");
                if db.exists() {
                    return Some(db);
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            if let Ok(home) = std::env::var("HOME") {
                let db = PathBuf::from(home).join(".local/share/rtk/history.db");
                if db.exists() {
                    return Some(db);
                }
            }
        }

        #[cfg(target_os = "windows")]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                let db = PathBuf::from(appdata).join("rtk/history.db");
                if db.exists() {
                    return Some(db);
                }
            }
        }

        None
    }

    /// 获取当前 RTK 安装与就绪状态
    pub fn get_status() -> RtkStatus {
        let binary_path = Self::find_rtk_binary();
        let installed = binary_path.is_some();
        let version = binary_path.as_ref().and_then(|p| Self::get_rtk_version(p));
        let db_path = Self::get_db_path();
        let has_data = db_path.as_ref().is_some_and(|p| p.exists());

        RtkStatus {
            installed,
            version,
            binary_path: binary_path.map(|p| p.to_string_lossy().to_string()),
            db_path: db_path.map(|p| p.to_string_lossy().to_string()),
            has_data,
        }
    }

    /// 优先通过官方 `rtk gain --all --format json --text` 获取经过内置规则过滤后的准确统计
    fn get_stats_from_cli(days_filter: Option<u32>) -> Option<RtkGainSummary> {
        #[derive(Deserialize)]
        struct CliSummary {
            total_commands: i64,
            total_input: i64,
            total_output: i64,
            total_saved: i64,
            avg_savings_pct: f64,
        }
        #[derive(Deserialize)]
        struct CliDaily {
            date: String,
            commands: i64,
            input_tokens: i64,
            output_tokens: i64,
            saved_tokens: i64,
        }
        #[derive(Deserialize)]
        struct CliOutput {
            summary: CliSummary,
            daily: Vec<CliDaily>,
        }

        let bin = Self::find_rtk_binary()?;
        let output = Command::new(&bin)
            .args(["gain", "--all", "--format", "json", "--text"])
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let parsed: CliOutput = serde_json::from_slice(&output.stdout).ok()?;
        let cutoff_date = days_filter.filter(|&d| d > 0).map(|d| {
            (chrono::Local::now() - chrono::Duration::days(d as i64))
                .format("%Y-%m-%d")
                .to_string()
        });

        let mut daily_stats = Vec::new();
        let mut filtered_commands = 0i64;
        let mut filtered_saved_tokens = 0i64;
        let mut filtered_input_tokens = 0i64;

        for item in parsed.daily {
            if let Some(ref cutoff) = cutoff_date {
                if item.date < *cutoff {
                    continue;
                }
            }
            filtered_commands += item.commands;
            filtered_saved_tokens += item.saved_tokens;
            filtered_input_tokens += item.input_tokens;
            daily_stats.push(RtkDailyStat {
                date: item.date,
                saved_tokens: item.saved_tokens,
                output_tokens: item.output_tokens,
                input_tokens: item.input_tokens,
                command_count: item.commands,
            });
        }

        let filtered_savings_pct = if filtered_input_tokens > 0 {
            (filtered_saved_tokens as f64 / filtered_input_tokens as f64) * 100.0
        } else {
            0.0
        };

        Some(RtkGainSummary {
            total_commands: parsed.summary.total_commands,
            total_saved_tokens: parsed.summary.total_saved,
            total_output_tokens: parsed.summary.total_output,
            total_input_tokens: parsed.summary.total_input,
            savings_pct: parsed.summary.avg_savings_pct,
            filtered_commands,
            filtered_saved_tokens,
            filtered_savings_pct,
            daily_stats,
        })
    }

    /// 查询 RTK 统计数据
    pub fn get_stats(days_filter: Option<u32>) -> Result<RtkGainSummary, String> {
        if let Some(summary) = Self::get_stats_from_cli(days_filter) {
            return Ok(summary);
        }

        let db_path = match Self::get_db_path() {
            Some(p) => p,
            None => {
                return Ok(RtkGainSummary {
                    total_commands: 0,
                    total_saved_tokens: 0,
                    total_output_tokens: 0,
                    total_input_tokens: 0,
                    savings_pct: 0.0,
                    filtered_commands: 0,
                    filtered_saved_tokens: 0,
                    filtered_savings_pct: 0.0,
                    daily_stats: vec![],
                });
            }
        };

        let conn = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| format!("打开 RTK 数据库失败: {}", e))?;

        // 1. 全局汇总
        let mut stmt = conn
            .prepare(
                "SELECT COUNT(*), 
                        COALESCE(SUM(saved_tokens), 0), 
                        COALESCE(SUM(output_tokens), 0), 
                        COALESCE(SUM(input_tokens), 0) 
                 FROM commands",
            )
            .map_err(|e| e.to_string())?;

        let (total_commands, total_saved_tokens, total_output_tokens, total_input_tokens): (
            i64,
            i64,
            i64,
            i64,
        ) = stmt
            .query_row([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap_or((0, 0, 0, 0));

        let savings_pct = if total_input_tokens > 0 {
            (total_saved_tokens as f64 / total_input_tokens as f64) * 100.0
        } else {
            0.0
        };

        // 2. 每日分组数据
        let filter_clause = match days_filter {
            Some(days) if days > 0 => {
                format!("WHERE timestamp >= datetime('now', '-{} days')", days)
            }
            _ => String::new(),
        };

        let query = format!(
            "SELECT substr(timestamp, 1, 10) as d,
                    COALESCE(SUM(saved_tokens), 0),
                    COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(input_tokens), 0),
                    COUNT(*)
             FROM commands
             {}
             GROUP BY d
             ORDER BY d ASC",
            filter_clause
        );

        let mut daily_stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
        let rows = daily_stmt
            .query_map([], |row| {
                Ok(RtkDailyStat {
                    date: row.get(0)?,
                    saved_tokens: row.get(1)?,
                    output_tokens: row.get(2)?,
                    input_tokens: row.get(3)?,
                    command_count: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut daily_stats = Vec::new();
        let mut filtered_commands = 0i64;
        let mut filtered_saved_tokens = 0i64;
        let mut filtered_input_tokens = 0i64;

        for r in rows.flatten() {
            filtered_commands += r.command_count;
            filtered_saved_tokens += r.saved_tokens;
            filtered_input_tokens += r.input_tokens;
            daily_stats.push(r);
        }

        let filtered_savings_pct = if filtered_input_tokens > 0 {
            (filtered_saved_tokens as f64 / filtered_input_tokens as f64) * 100.0
        } else {
            0.0
        };

        Ok(RtkGainSummary {
            total_commands,
            total_saved_tokens,
            total_output_tokens,
            total_input_tokens,
            savings_pct,
            filtered_commands,
            filtered_saved_tokens,
            filtered_savings_pct,
            daily_stats,
        })
    }

    /// 获取各个 Agent 的 RTK 支持和开启状态
    pub fn get_agents() -> Vec<RtkAgentItem> {
        let home = std::env::var("HOME").unwrap_or_default();
        let home_path = Path::new(&home);

        let items = vec![
            // 1. Claude Code
            {
                let claude_dir = home_path.join(".claude");
                let installed = claude_dir.exists();
                let enabled = installed && {
                    let settings_path = claude_dir.join("settings.json");
                    let has_hook = fs::read_to_string(&settings_path)
                        .map(|s| s.contains("rtk hook claude"))
                        .unwrap_or(false);
                    let claude_md_path = claude_dir.join("CLAUDE.md");
                    let has_ref = fs::read_to_string(&claude_md_path)
                        .map(|s| s.contains("RTK.md"))
                        .unwrap_or(false);
                    has_hook || has_ref
                };
                RtkAgentItem {
                    id: "claude".to_string(),
                    name: "Claude Code".to_string(),
                    supported: true,
                    unsupported_reason: None,
                    installed,
                    enabled,
                }
            },
            // 2. Codex
            {
                let codex_dir = home_path.join(".codex");
                let installed = codex_dir.exists();
                let enabled = installed && {
                    let hooks_path = codex_dir.join("hooks.json");
                    let has_hook = fs::read_to_string(&hooks_path)
                        .map(|s| s.contains("rtk hook codex"))
                        .unwrap_or(false);
                    let agents_md_path = codex_dir.join("AGENTS.md");
                    let has_ref = fs::read_to_string(&agents_md_path)
                        .map(|s| s.contains("RTK.md"))
                        .unwrap_or(false);
                    has_hook || has_ref
                };
                RtkAgentItem {
                    id: "codex".to_string(),
                    name: "Codex".to_string(),
                    supported: true,
                    unsupported_reason: None,
                    installed,
                    enabled,
                }
            },
            // 3. Antigravity
            {
                let agy_dir = home_path.join(".gemini/config");
                let installed = agy_dir.exists() || home_path.join(".gemini/antigravity").exists();
                let enabled = installed && {
                    let hooks_path = agy_dir.join("plugins/rtk/hooks.json");
                    fs::read_to_string(&hooks_path)
                        .map(|s| s.contains("rtk hook antigravity"))
                        .unwrap_or(false)
                };
                RtkAgentItem {
                    id: "antigravity".to_string(),
                    name: "Antigravity".to_string(),
                    supported: true,
                    unsupported_reason: None,
                    installed,
                    enabled,
                }
            },
            // 4. Cursor CLI
            {
                let cursor_dir = home_path.join(".cursor");
                let installed = cursor_dir.exists();
                let enabled = installed && {
                    let hooks_path = cursor_dir.join("hooks.json");
                    fs::read_to_string(&hooks_path)
                        .map(|s| s.contains("rtk hook cursor"))
                        .unwrap_or(false)
                };
                RtkAgentItem {
                    id: "cursor".to_string(),
                    name: "Cursor CLI".to_string(),
                    supported: true,
                    unsupported_reason: None,
                    installed,
                    enabled,
                }
            },
            // 5. Gemini CLI
            {
                let gemini_dir = home_path.join(".gemini");
                let installed = gemini_dir.join("settings.json").exists()
                    || gemini_dir.join("oauth_creds.json").exists();
                let enabled = installed && {
                    let settings_path = gemini_dir.join("settings.json");
                    fs::read_to_string(&settings_path)
                        .map(|s| s.contains("rtk-hook-gemini"))
                        .unwrap_or(false)
                };
                RtkAgentItem {
                    id: "gemini".to_string(),
                    name: "Gemini CLI".to_string(),
                    supported: true,
                    unsupported_reason: None,
                    installed,
                    enabled,
                }
            },
            // 6. OpenCode
            {
                let opencode_dir = home_path.join(".config/opencode");
                let installed = opencode_dir.exists();
                let enabled = installed && opencode_dir.join("plugins/rtk.ts").exists();
                RtkAgentItem {
                    id: "opencode".to_string(),
                    name: "OpenCode".to_string(),
                    supported: true,
                    unsupported_reason: None,
                    installed,
                    enabled,
                }
            },
            // 7. Pi
            {
                let pi_dir = home_path.join(".pi");
                let installed = pi_dir.exists();
                let enabled = installed && pi_dir.join("agent/extensions/rtk.ts").exists();
                RtkAgentItem {
                    id: "pi".to_string(),
                    name: "Pi".to_string(),
                    supported: true,
                    unsupported_reason: None,
                    installed,
                    enabled,
                }
            },
            // 8. Hermes Agent
            {
                let hermes_dir = home_path.join(".hermes");
                let installed = hermes_dir.exists();
                let enabled = installed && hermes_dir.join("plugins/rtk-rewrite").exists();
                RtkAgentItem {
                    id: "hermes".to_string(),
                    name: "Hermes Agent".to_string(),
                    supported: true,
                    unsupported_reason: None,
                    installed,
                    enabled,
                }
            },
            // 9. Droid
            {
                let factory_dir = home_path.join(".factory");
                let installed = factory_dir.exists();
                let enabled = installed && {
                    let hooks_path = factory_dir.join("hooks.json");
                    fs::read_to_string(&hooks_path)
                        .map(|s| s.contains("rtk hook droid"))
                        .unwrap_or(false)
                };
                RtkAgentItem {
                    id: "droid".to_string(),
                    name: "Droid".to_string(),
                    supported: true,
                    unsupported_reason: None,
                    installed,
                    enabled,
                }
            },
            // 10. DeepSeek Harness (暂不支持改写)
            {
                let installed =
                    home_path.join(".dsh").exists() || home_path.join(".deepseek-harness").exists();
                RtkAgentItem {
                    id: "dsh".to_string(),
                    name: "DeepSeek Harness".to_string(),
                    supported: false,
                    unsupported_reason: Some("RTK 暂不支持".to_string()),
                    installed,
                    enabled: false,
                }
            },
            // 11. Cline (暂不支持改写)
            {
                let installed = home_path.join(".cline").exists();
                RtkAgentItem {
                    id: "cline".to_string(),
                    name: "Cline".to_string(),
                    supported: false,
                    unsupported_reason: Some("RTK 暂不支持".to_string()),
                    installed,
                    enabled: false,
                }
            },
            // 12. Grok Build (暂不支持改写)
            {
                let installed = home_path.join(".grok").exists();
                RtkAgentItem {
                    id: "grokbuild".to_string(),
                    name: "Grok Build".to_string(),
                    supported: false,
                    unsupported_reason: Some("RTK 暂不支持".to_string()),
                    installed,
                    enabled: false,
                }
            },
            // 13. Kimi (暂不支持改写)
            {
                let installed = home_path.join(".kimi").exists();
                RtkAgentItem {
                    id: "kimi".to_string(),
                    name: "Kimi".to_string(),
                    supported: false,
                    unsupported_reason: Some("RTK 暂不支持".to_string()),
                    installed,
                    enabled: false,
                }
            },
        ];

        items
            .into_iter()
            .filter(|item| item.installed || item.enabled)
            .collect()
    }

    /// 切换某个 Agent 的 RTK 挂载状态
    pub fn toggle_agent(agent_id: &str, enable: bool) -> Result<(), String> {
        let rtk_bin = Self::find_rtk_binary().ok_or("未检测到 RTK 可执行程序，请先安装 RTK")?;
        let home = std::env::var("HOME").unwrap_or_default();
        let home_path = Path::new(&home);

        if enable {
            // 调用 RTK 原生安装器
            let mut cmd = Command::new(&rtk_bin);
            cmd.arg("init").arg("-g");

            let mut temp_claude_dir: Option<PathBuf> = None;

            match agent_id {
                "claude" => {
                    cmd.arg("--auto-patch");
                }
                "codex" => {
                    cmd.arg("--codex");
                }
                "antigravity" => {
                    cmd.arg("--agent").arg("antigravity");
                }
                "gemini" => {
                    cmd.arg("--gemini").arg("--hook-only").arg("--auto-patch");
                }
                "cursor" => {
                    cmd.arg("--agent").arg("cursor").arg("--auto-patch");
                    let tmp =
                        std::env::temp_dir().join(format!("mskills-rtk-{}", std::process::id()));
                    let _ = fs::create_dir_all(&tmp);
                    cmd.env("CLAUDE_CONFIG_DIR", &tmp);
                    temp_claude_dir = Some(tmp);
                }
                "opencode" => {
                    cmd.arg("--opencode").arg("--auto-patch");
                    let tmp =
                        std::env::temp_dir().join(format!("mskills-rtk-{}", std::process::id()));
                    let _ = fs::create_dir_all(&tmp);
                    cmd.env("CLAUDE_CONFIG_DIR", &tmp);
                    temp_claude_dir = Some(tmp);
                }
                "pi" => {
                    cmd.arg("--agent").arg("pi").arg("--auto-patch");
                }
                "hermes" => {
                    cmd.arg("--agent").arg("hermes").arg("--auto-patch");
                }
                "droid" => {
                    cmd.arg("--agent").arg("droid");
                }
                _ => return Err(format!("不支持的 Agent: {}", agent_id)),
            };

            let output = cmd
                .output()
                .map_err(|e| format!("执行 rtk init 失败: {}", e))?;
            if let Some(tmp) = temp_claude_dir {
                let _ = fs::remove_dir_all(tmp);
            }
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                return Err(format!("RTK 初始化错误: {} {}", stderr, stdout));
            }
        } else {
            // 安全移除（不使用 rtk 粗暴的全局 uninstall，而是精准清洗特定 Agent 目录）
            match agent_id {
                "claude" => {
                    let dir = home_path.join(".claude");
                    Self::clean_file_containing(&dir.join("settings.json"), "rtk hook claude")?;
                    Self::remove_line_with_keyword(&dir.join("CLAUDE.md"), "RTK.md")?;
                    let _ = fs::remove_file(dir.join("RTK.md"));
                }
                "codex" => {
                    let dir = home_path.join(".codex");
                    Self::clean_file_containing(&dir.join("hooks.json"), "rtk hook codex")?;
                    Self::remove_line_with_keyword(&dir.join("AGENTS.md"), "RTK.md")?;
                    let _ = fs::remove_file(dir.join("RTK.md"));
                }
                "antigravity" => {
                    let plugin_dir = home_path.join(".gemini/config/plugins/rtk");
                    let _ = fs::remove_dir_all(plugin_dir);
                }
                "cursor" => {
                    let dir = home_path.join(".cursor");
                    Self::clean_file_containing(&dir.join("hooks.json"), "rtk hook cursor")?;
                }
                "gemini" => {
                    let dir = home_path.join(".gemini");
                    Self::clean_file_containing(&dir.join("settings.json"), "rtk-hook-gemini")?;
                    let _ = fs::remove_file(dir.join("hooks/rtk-hook-gemini.sh"));
                    let _ = fs::remove_file(dir.join("hooks/.rtk-hook.sha256"));
                }
                "opencode" => {
                    let plugin_file = home_path.join(".config/opencode/plugins/rtk.ts");
                    let _ = fs::remove_file(plugin_file);
                }
                "pi" => {
                    let ext_file = home_path.join(".pi/agent/extensions/rtk.ts");
                    let _ = fs::remove_file(ext_file);
                }
                "hermes" => {
                    let dir = home_path.join(".hermes");
                    let _ = fs::remove_dir_all(dir.join("plugins/rtk-rewrite"));
                }
                "droid" => {
                    let dir = home_path.join(".factory");
                    Self::clean_file_containing(&dir.join("hooks.json"), "rtk hook droid")?;
                }
                _ => return Err(format!("不支持的 Agent: {}", agent_id)),
            }
        }

        Ok(())
    }

    /// 辅助函数：从文件中安全剔除含有关键字的行
    fn remove_line_with_keyword(path: &Path, keyword: &str) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let new_lines: Vec<&str> = content
            .lines()
            .filter(|line| !line.contains(keyword))
            .collect();
        fs::write(path, new_lines.join("\n")).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 辅助函数：清洗 JSON 配置中涉及 hook 的字段
    fn clean_file_containing(path: &Path, keyword: &str) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        if !content.contains(keyword) {
            return Ok(());
        }

        if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&content) {
            Self::clean_json_hooks(&mut val, keyword);
            if let Ok(new_content) = serde_json::to_string_pretty(&val) {
                let _ = fs::write(path, new_content);
                return Ok(());
            }
        }

        // 如果 JSON 解析失败，则做逐行过滤保底
        Self::remove_line_with_keyword(path, keyword)
    }

    fn clean_json_hooks(val: &mut serde_json::Value, keyword: &str) {
        if let serde_json::Value::Object(map) = val {
            for (_, v) in map.iter_mut() {
                Self::clean_json_hooks(v, keyword);
            }
        } else if let serde_json::Value::Array(arr) = val {
            arr.retain(|item| {
                if let serde_json::Value::Object(obj) = item {
                    if let Some(cmd) = obj.get("command").and_then(|c| c.as_str()) {
                        if cmd.contains(keyword) {
                            return false;
                        }
                    }
                }
                true
            });
            for item in arr.iter_mut() {
                Self::clean_json_hooks(item, keyword);
            }
        }
    }
}
