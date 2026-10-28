//! Local Skill usage evidence. These cursors never share Token accounting state.
use crate::database::Database;
use chrono::DateTime;
use regex::Regex;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub scanning: bool,
    pub completed: bool,
    pub files_scanned: usize,
    pub files_total: usize,
    pub error: Option<String>,
}

#[derive(Default)]
struct ScanState {
    status: ScanStatus,
    started: Option<Instant>,
}

fn scan_state() -> &'static Arc<Mutex<ScanState>> {
    static STATE: OnceLock<Arc<Mutex<ScanState>>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}

pub fn request_scan(db: Arc<Database>) -> Result<(), String> {
    let mut state = scan_state().lock().map_err(|e| e.to_string())?;
    if state.status.scanning
        || state
            .started
            .is_some_and(|at| at.elapsed() < Duration::from_secs(30))
    {
        return Ok(());
    }
    state.started = Some(Instant::now());
    state.status.scanning = true;
    state.status.completed = false;
    state.status.error = None;
    state.status.files_scanned = 0;
    drop(state);
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let mut roots = vec![(
                "claude",
                crate::config::get_claude_config_dir().join("projects"),
            )];
            roots.extend(
                crate::session_manager::providers::codex::session_roots()
                    .into_iter()
                    .map(|path| ("codex", path)),
            );
            let mut files = Vec::new();
            let mut failed = 0;
            for (app, root) in roots {
                match root.try_exists() {
                    Ok(true) => collect_files(app, &root, &mut files, &mut failed),
                    Ok(false) => {}
                    Err(_) => failed += 1,
                }
            }
            if let Ok(mut state) = scan_state().lock() {
                state.status.files_total = files.len();
            }
            for (index, (app, path)) in files.iter().enumerate() {
                if let Err(error) = sync_file(&db, app, path) {
                    log::warn!("[SKILL-USAGE] {}: {error}", path.display());
                    failed += 1;
                }
                if let Ok(mut state) = scan_state().lock() {
                    state.status.files_scanned = index + 1;
                }
            }
            if failed == 0 {
                Ok(())
            } else {
                Err(format!("{failed} files could not be fully scanned"))
            }
        })
        .await;
        if let Ok(mut state) = scan_state().lock() {
            state.status.scanning = false;
            let error = result
                .map_err(|e| e.to_string())
                .and_then(|result| result)
                .err();
            state.status.completed = error.is_none();
            state.status.error = error;
        }
    });
    Ok(())
}

fn collect_files(
    app: &'static str,
    root: &Path,
    files: &mut Vec<(&'static str, PathBuf)>,
    failed: &mut usize,
) {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => {
            *failed += 1;
            return;
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            *failed += 1;
            continue;
        };
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => collect_files(app, &entry.path(), files, failed),
            Ok(kind)
                if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "jsonl") =>
            {
                files.push((app, entry.path()))
            }
            Err(_) => *failed += 1,
            _ => {}
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Context {
    session: String,
    turn: String,
    fork_at: Option<i64>,
}

#[derive(Debug)]
struct Event {
    id: String,
    dedup: String,
    skill: String,
    app: String,
    session: String,
    turn: String,
    at: i64,
    source: &'static str,
    evidence: &'static str,
}

fn timestamp(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|at| at.timestamp())
}

/// Keeps the `plugin:` namespace so plugin Skills stay apart from same-named managed Skills.
fn name(value: &str) -> Option<String> {
    let value = value.trim().trim_start_matches('/');
    (value.split(':').all(|part| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_alphanumeric() || "-_.".contains(c))
    }))
    .then(|| value.to_string())
}

fn skill_path(path: &str) -> Option<String> {
    let path = Path::new(path);
    (path.file_name()?.to_str()? == "SKILL.md").then_some(())?;
    let parts: Vec<_> = path.iter().filter_map(|part| part.to_str()).collect();
    // .../plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>/SKILL.md
    if let Some(at) = parts
        .windows(2)
        .rposition(|pair| pair == ["plugins", "cache"])
    {
        if parts.len() == at + 8 && parts[at + 5] == "skills" {
            return name(&format!("{}:{}", parts[at + 3], parts[at + 6]));
        }
    }
    name(path.parent()?.file_name()?.to_str()?)
}

/// Plugins and the Skills they ship, keyed by `plugin` and `plugin:skill`, with descriptions.
#[derive(Default)]
struct PluginCatalog {
    plugins: BTreeMap<String, String>,
    skills: BTreeMap<String, String>,
    sources: BTreeMap<String, BTreeSet<PluginSource>>,
}

/// Where a plugin is installed: the agent, the marketplace it came from, and what it ships.
#[derive(Serialize, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "camelCase")]
struct PluginSource {
    app: String,
    marketplace: String,
    version: String,
    commands: usize,
}

/// Skills shipped by installed Claude/Codex plugins, as `plugin:skill`.
fn plugin_catalog(cache_roots: &[(&str, PathBuf)]) -> PluginCatalog {
    let children = |dir: &Path| -> Vec<PathBuf> {
        let mut paths: Vec<_> = fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        // shortcut: the last version by name wins for descriptions; 5.10 sorts before 5.9.
        paths.sort();
        paths
    };
    let mut catalog = PluginCatalog::default();
    for (app, root) in cache_roots {
        for marketplace in children(root) {
            let Some(marketplace_name) = marketplace.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            // OpenAI's own marketplaces ship Codex built-ins; temp_git_* are leftovers of installs.
            if marketplace_name.starts_with("openai-") || marketplace_name.starts_with("temp_git_")
            {
                continue;
            }
            for plugin in children(&marketplace) {
                let Some(plugin_name) = plugin.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                for version in children(&plugin) {
                    let mut has_skills = false;
                    for skill in children(&version.join("skills")) {
                        let skill_md = skill.join("SKILL.md");
                        if !skill_md.is_file() {
                            continue;
                        }
                        let Some(key) = skill
                            .file_name()
                            .and_then(|n| n.to_str())
                            .and_then(|n| name(&format!("{plugin_name}:{n}")))
                        else {
                            continue;
                        };
                        let description =
                            crate::services::skill::SkillService::parse_skill_metadata_static(
                                &skill_md,
                            )
                            .ok()
                            .and_then(|meta| meta.description)
                            .unwrap_or_default();
                        catalog.skills.insert(key, description.trim().to_string());
                        has_skills = true;
                    }
                    if has_skills {
                        let description = [".claude-plugin", ".codex-plugin"]
                            .iter()
                            .find_map(|dir| {
                                let text =
                                    fs::read_to_string(version.join(dir).join("plugin.json"))
                                        .ok()?;
                                serde_json::from_str::<Value>(&text).ok()?["description"]
                                    .as_str()
                                    .map(str::to_string)
                            })
                            .unwrap_or_default();
                        catalog.plugins.insert(plugin_name.to_string(), description);
                        let commands = fs::read_dir(version.join("commands"))
                            .into_iter()
                            .flatten()
                            .flatten()
                            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
                            .count();
                        let sources = catalog.sources.entry(plugin_name.to_string()).or_default();
                        // Versions are visited in order, so the later one replaces older caches.
                        sources.retain(|source| {
                            source.app != *app || source.marketplace != marketplace_name
                        });
                        sources.insert(PluginSource {
                            app: app.to_string(),
                            marketplace: marketplace_name.to_string(),
                            version: version
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or_default()
                                .to_string(),
                            commands,
                        });
                    }
                }
            }
        }
    }
    catalog
}

/// Plugin Skills match by `plugin:skill`; any other namespaced call falls back to a managed Skill.
fn resolve_skill(
    skill: &str,
    managed: &HashSet<String>,
    plugins: &BTreeMap<String, String>,
) -> Option<String> {
    if managed.contains(skill) || plugins.contains_key(skill) {
        return Some(skill.to_string());
    }
    let base = skill.rsplit(':').next()?;
    managed.contains(base).then(|| base.to_string())
}

fn content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn event(
    context: &Context,
    app: &str,
    id: &str,
    skill: String,
    at: i64,
    manual: bool,
    evidence: &'static str,
) -> Event {
    let id = format!("{app}:{id}:{skill}");
    // One use per skill per user turn: repeated loads within a turn are chunked reads or reloads.
    let dedup = if !context.turn.is_empty() {
        format!("{app}:{}:{}:{skill}", context.session, context.turn)
    } else {
        id.clone()
    };
    Event {
        id,
        dedup,
        skill,
        app: app.to_string(),
        session: context.session.clone(),
        turn: context.turn.clone(),
        at,
        source: if manual { "manual" } else { "agent" },
        evidence,
    }
}

fn parse_line(row: &Value, app: &str, context: &mut Context, fallback_id: &str) -> Vec<Event> {
    let payload = &row["payload"];
    if app == "codex" {
        if row["type"] == "session_meta" && context.session.is_empty() {
            context.session = payload["id"].as_str().unwrap_or(fallback_id).to_string();
            if payload.get("forked_from_id").is_some_and(|v| v.is_string())
                || payload
                    .pointer("/source/subagent/thread_spawn/parent_thread_id")
                    .is_some()
            {
                context.fork_at = timestamp(&row["timestamp"]);
            }
        }
        if row["type"] == "turn_context"
            || (row["type"] == "event_msg" && payload["type"] == "task_started")
        {
            if let Some(turn) = payload["turn_id"].as_str() {
                context.turn = turn.to_string();
            }
        }
    } else if let Some(session) = row["sessionId"].as_str() {
        context.session = session.to_string();
    }
    let Some(at) = timestamp(&row["timestamp"]) else {
        return vec![];
    };
    if context.fork_at.is_some_and(|fork| at < fork) {
        return vec![];
    }
    if context.session.is_empty() {
        return vec![];
    }
    let mut events = Vec::new();
    if app == "claude" {
        let message = &row["message"];
        let content = &message["content"];
        let role = message["role"].as_str().or_else(|| row["type"].as_str());
        if role == Some("user") {
            let text = content_text(content);
            if let Some(prompt) = row["promptId"].as_str() {
                context.turn = prompt.to_string();
            } else if !text.is_empty() {
                // Older logs lack promptId; tool results carry no text and do not start a turn.
                context.turn = row["uuid"].as_str().unwrap_or(fallback_id).to_string();
            }
            if text.trim_start().starts_with("<command-") {
                static COMMAND: OnceLock<Regex> = OnceLock::new();
                let re = COMMAND.get_or_init(|| {
                    Regex::new(r"<command-name>/([^<\s]+)</command-name>").unwrap()
                });
                if let Some(skill) = re.captures(&text).and_then(|c| name(&c[1])) {
                    events.push(event(
                        context,
                        app,
                        row["uuid"].as_str().unwrap_or(fallback_id),
                        skill,
                        at,
                        true,
                        "slash_command",
                    ));
                }
            }
        } else if role == Some("assistant") {
            for item in content.as_array().into_iter().flatten() {
                if item["type"] == "tool_use" && item["name"] == "Skill" {
                    if let Some(skill) = item["input"]["skill"].as_str().and_then(name) {
                        events.push(event(
                            context,
                            app,
                            item["id"].as_str().unwrap_or(fallback_id),
                            skill,
                            at,
                            false,
                            "skill_tool",
                        ));
                    }
                }
            }
        }
    } else if row["type"] == "event_msg" && payload["type"] == "item_completed" {
        let item = &payload["item"];
        if item["type"] == "CommandExecution"
            && item["exit_code"].as_i64() == Some(0)
            && item["status"] == "completed"
        {
            let mut skills: HashSet<String> = item["parsed_cmd"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|part| part["type"] == "read")
                .filter_map(|part| part["path"].as_str().and_then(skill_path))
                .collect();
            skills.extend(read_command_skills(&item["command"]));
            if let Some(turn) = payload["turn_id"].as_str() {
                context.turn = turn.to_string();
            }
            for skill in skills {
                events.push(event(
                    context,
                    app,
                    item["id"].as_str().unwrap_or(fallback_id),
                    skill,
                    at,
                    false,
                    "skill_file_read",
                ));
            }
        }
    } else if row["type"] == "response_item"
        && payload["type"] == "message"
        && payload["role"] == "user"
    {
        let text = content_text(&payload["content"]);
        if text.trim_start().starts_with("<skill>") {
            static SKILL: OnceLock<Regex> = OnceLock::new();
            let re = SKILL.get_or_init(|| {
                Regex::new(r"(?s)<skill>\s*<name>([^<]+)</name>\s*<path>([^<]+)</path>").unwrap()
            });
            for capture in re.captures_iter(&text) {
                if let Some(skill) =
                    skill_path(capture[2].trim()).or_else(|| name(capture[1].trim()))
                {
                    events.push(event(
                        context,
                        app,
                        payload["id"].as_str().unwrap_or(fallback_id),
                        skill,
                        at,
                        true,
                        "skill_injection",
                    ));
                }
            }
        }
    }
    events
}

// Tokenize simple shell commands split at `;`, `|`, `&` and newlines; never inspect output or execute log content.
fn shell_words(command: &str) -> Vec<Vec<String>> {
    let mut commands = vec![Vec::new()];
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    // A redirection target is written, not read.
    let mut redirect = false;
    fn finish(word: &mut String, commands: &mut [Vec<String>], redirect: &mut bool) {
        if !word.is_empty() {
            let word = std::mem::take(word);
            if !std::mem::take(redirect) {
                commands.last_mut().unwrap().push(word);
            }
        }
    }
    for c in command.chars() {
        if escaped {
            word.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if quote == Some(c) {
            quote = None;
            continue;
        }
        if quote.is_none() && (c == '\'' || c == '"') {
            quote = Some(c);
            continue;
        }
        if quote.is_none() && ";|&\n".contains(c) {
            finish(&mut word, &mut commands, &mut redirect);
            redirect = false;
            commands.push(Vec::new());
        } else if quote.is_none() && "<>".contains(c) {
            finish(&mut word, &mut commands, &mut redirect);
            redirect = true;
        } else if quote.is_none() && c.is_whitespace() {
            finish(&mut word, &mut commands, &mut redirect);
        } else {
            word.push(c);
        }
    }
    if quote.is_some() || escaped {
        return Vec::new();
    }
    finish(&mut word, &mut commands, &mut redirect);
    commands.retain(|words| !words.is_empty());
    commands
}

fn read_command_skills(command: &Value) -> HashSet<String> {
    let commands = if let Some(command) = command.as_str() {
        shell_words(command)
    } else {
        let words = command.as_array().into_iter().flatten();
        vec![words
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()]
    };
    commands
        .into_iter()
        .flat_map(|words| command_skills(words, 4))
        .collect()
}

fn command_skills(mut words: Vec<String>, depth: u8) -> Vec<String> {
    let program =
        |words: &[String]| Some(Path::new(words.first()?).file_name()?.to_str()?.to_string());
    loop {
        match program(&words).as_deref() {
            Some("rtk") => {
                words.remove(0);
                if words.first().is_some_and(|word| word == "proxy") {
                    words.remove(0);
                }
            }
            Some("sh" | "bash" | "zsh")
                if depth > 0 && words.get(1).is_some_and(|w| w == "-c" || w == "-lc") =>
            {
                let Some(script) = words.get(2) else {
                    return Vec::new();
                };
                return shell_words(script)
                    .into_iter()
                    .flat_map(|words| command_skills(words, depth - 1))
                    .collect();
            }
            _ => break,
        }
    }
    let Some(program) = program(&words) else {
        return Vec::new();
    };
    if !matches!(
        program.as_str(),
        "cat" | "sed" | "head" | "tail" | "bat" | "rg" | "grep"
    ) {
        return Vec::new();
    }
    if matches!(program.as_str(), "rg" | "grep")
        && words.iter().any(|w| {
            matches!(
                w.as_str(),
                "-l" | "--files" | "--files-with-matches" | "-q" | "--quiet" | "-c" | "--count"
            )
        })
    {
        return Vec::new();
    }
    // Readers take every file operand; only operands that are themselves SKILL.md count.
    words
        .iter()
        .skip(1)
        .filter(|word| !word.starts_with('-'))
        .filter_map(|path| skill_path(path))
        .collect()
}

fn fingerprint(file: &mut File, offset: u64) -> Result<String, String> {
    let start = offset.saturating_sub(4096);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut tail = vec![0; (offset - start) as usize];
    file.read_exact(&mut tail).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(tail)))
}

fn sync_file(db: &Database, app: &str, path: &Path) -> Result<(), String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let modified = crate::services::session_usage::metadata_modified_nanos(&metadata);
    let file_path = path.to_string_lossy().to_string();
    let cursor = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        use rusqlite::OptionalExtension;
        conn.query_row("SELECT last_modified, file_size, last_byte_offset, last_tail_fingerprint, context FROM skill_usage_sync WHERE file_path=?1", [&file_path], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, u64>(1)?, row.get::<_, u64>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?))
        }).optional().map_err(|e| e.to_string())?
    };
    let mut offset = 0;
    let mut context = Context::default();
    if let Some((last_modified, size, position, tail, stored_context)) = cursor {
        if position <= metadata.len() && fingerprint(&mut file, position)? == tail {
            if modified == last_modified && size == metadata.len() {
                return Ok(());
            }
            offset = position;
            context = serde_json::from_str(&stored_context).map_err(|e| e.to_string())?;
        }
        // Rewritten files can be replayed safely: event IDs and activation keys are durable.
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut events = Vec::new();
    loop {
        let mut bytes = Vec::new();
        let read = reader
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        // An unterminated tail may still be written; the cursor stays before it until the file grows.
        if bytes.last() != Some(&b'\n') {
            break;
        }
        let id = format!("{:x}", Sha256::digest(&bytes));
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(row) => events.extend(parse_line(&row, app, &mut context, &id)),
            Err(_) if bytes.iter().all(u8::is_ascii_whitespace) => {}
            // A corrupt line costs only itself; it must not keep the whole scan from completing.
            Err(error) => log::warn!(
                "[SKILL-USAGE] {}: skipped malformed line at byte {offset}: {error}",
                path.display()
            ),
        }
        offset += read as u64;
    }
    let tail = fingerprint(reader.get_mut(), offset)?;
    let serialized = serde_json::to_string(&context).map_err(|e| e.to_string())?;
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for event in events {
        tx.execute("INSERT INTO skill_usage_events(event_id,dedup_key,skill_name,app,session_id,turn_id,used_at,source,evidence)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
            ON CONFLICT DO UPDATE SET
                used_at=MIN(used_at,excluded.used_at),
                source=CASE WHEN excluded.source='manual' THEN 'manual' ELSE source END,
                evidence=CASE WHEN excluded.source='manual' THEN excluded.evidence ELSE evidence END",
            params![event.id,event.dedup,event.skill,event.app,event.session,event.turn,event.at,event.source,event.evidence])
            .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO skill_usage_sync VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            file_path,
            modified,
            metadata.len(),
            offset,
            tail,
            serialized
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUsageSummary {
    skill_name: String,
    app: String,
    count: u32,
    sessions: usize,
    last_used: i64,
    manual_count: u32,
    agent_count: u32,
    buckets: Vec<u32>,
    #[serde(skip)]
    session_ids: BTreeSet<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUsageSnapshot {
    #[serde(flatten)]
    status: ScanStatus,
    records: Vec<SkillUsageSummary>,
    /// Installed plugin Skills and their descriptions, so unused ones can still show 0.
    plugin_skills: BTreeMap<String, String>,
    plugin_descriptions: BTreeMap<String, String>,
    plugin_sources: BTreeMap<String, BTreeSet<PluginSource>>,
}

pub fn get_usage(db: &Database, boundaries: &[i64]) -> Result<SkillUsageSnapshot, String> {
    // A skipped local hour at daylight-saving time has an empty bucket.
    if !(2..=25).contains(&boundaries.len())
        || boundaries.windows(2).any(|p| p[0] > p[1])
        || boundaries
            .last()
            .unwrap()
            .checked_sub(boundaries[0])
            .is_none_or(|span| span <= 0 || span > 8 * 86400)
    {
        return Err("Invalid usage time range".to_string());
    }
    let installed = db.get_all_installed_skills().map_err(|e| e.to_string())?;
    let managed: HashSet<_> = installed
        .values()
        .filter_map(|skill| {
            Path::new(&skill.directory)
                .file_name()?
                .to_str()
                .and_then(name)
        })
        .collect();
    let catalog = plugin_catalog(&[
        (
            "claude",
            crate::config::get_claude_config_dir().join("plugins/cache"),
        ),
        (
            "codex",
            crate::codex_config::get_codex_config_dir().join("plugins/cache"),
        ),
    ]);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut statement = conn.prepare("SELECT skill_name, app, session_id, used_at, source FROM skill_usage_events WHERE used_at>=?1 AND used_at<?2").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![boundaries[0], boundaries.last().unwrap()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut summaries = HashMap::new();
    for row in rows {
        let (skill, app, session, at, source) = row.map_err(|e| e.to_string())?;
        let Some(skill) = resolve_skill(&skill, &managed, &catalog.skills) else {
            continue;
        };
        let summary = summaries
            .entry((skill.clone(), app.clone()))
            .or_insert_with(|| SkillUsageSummary {
                skill_name: skill,
                app,
                count: 0,
                sessions: 0,
                last_used: at,
                manual_count: 0,
                agent_count: 0,
                buckets: vec![0; boundaries.len() - 1],
                session_ids: BTreeSet::new(),
            });
        summary.count += 1;
        summary.last_used = summary.last_used.max(at);
        summary.session_ids.insert(session);
        summary.sessions = summary.session_ids.len();
        if source == "manual" {
            summary.manual_count += 1;
        } else {
            summary.agent_count += 1;
        }
        if let Some(bucket) = boundaries.windows(2).position(|p| at >= p[0] && at < p[1]) {
            summary.buckets[bucket] += 1;
        }
    }
    Ok(SkillUsageSnapshot {
        status: scan_state()
            .lock()
            .map_err(|e| e.to_string())?
            .status
            .clone(),
        records: summaries.into_values().collect(),
        plugin_skills: catalog.skills,
        plugin_descriptions: catalog.plugins,
        plugin_sources: catalog.sources,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn migration_adds_independent_tables_without_changing_token_cursors() {
        let db = Database::memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("DROP TABLE skill_usage_events; DROP TABLE skill_usage_sync;
            INSERT INTO session_log_sync(file_path,last_modified,last_synced_at,last_byte_offset,last_tail_fingerprint)
                VALUES ('token-log',123,456,789,42);
            PRAGMA user_version=19;").unwrap();
        Database::apply_schema_migrations_on_conn(&conn).unwrap();
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0))
                .unwrap(),
            crate::database::SCHEMA_VERSION
        );
        assert_eq!(
            conn.query_row(
                "SELECT last_byte_offset FROM session_log_sync WHERE file_path='token-log'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            789
        );
        for table in ["skill_usage_sync", "skill_usage_events"] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn time_ranges_reject_overflow_and_accept_a_skipped_local_hour() {
        let db = Database::memory().unwrap();
        assert!(get_usage(&db, &[i64::MIN, i64::MAX]).is_err());
        assert!(get_usage(&db, &[]).is_err());
        assert!(get_usage(&db, &[10, 10]).is_err());
        assert!(get_usage(&db, &[10, 11, 11, 12]).is_ok());
    }

    fn command(id: &str, turn: &str, cmd: &str, exit: i32) -> Value {
        json!({"type":"event_msg","timestamp":"2026-10-16T01:00:00Z","payload":{
            "type":"item_completed","turn_id":turn,"item":{"type":"CommandExecution","id":id,
            "status":"completed","exit_code":exit,"command":["/bin/zsh","-lc",cmd],"parsed_cmd":[{"type":"unknown"}]}}})
    }

    #[test]
    fn rtk_fallback_recognizes_readers_and_rejects_path_mentions() {
        for command in [
            "rtk proxy cat '/some skills/archify/SKILL.md'",
            "rtk proxy sed -n '1,120p' /skills/archify/SKILL.md",
            "rtk proxy sh -c 'cat /skills/archify/SKILL.md'",
            "rtk rg -n diagrams /skills/archify/SKILL.md",
            "rtk proxy cat /home/RTK.md /skills/archify/SKILL.md",
            "cat /tmp/example.md; cat /skills/archify/SKILL.md",
            "sed -n 1p /home/RTK.md && sed -n '1,260p' /skills/archify/SKILL.md 2>&1 | head",
        ] {
            assert_eq!(
                read_command_skills(&json!(["/bin/zsh", "-lc", command])),
                HashSet::from(["archify".to_string()]),
                "{command}"
            );
        }
        assert_eq!(
            read_command_skills(&json!("cat /s/grill-me/SKILL.md /s/grilling/SKILL.md")).len(),
            2
        );
        for command in [
            "echo /skills/archify/SKILL.md",
            "ls /skills/archify/SKILL.md",
            "rg -l foo /skills/archify/SKILL.md",
            "cat /tmp/example.md > /skills/archify/SKILL.md",
            "cat /tmp/example.md >/skills/archify/SKILL.md",
            "echo '/skills/archify/SKILL.md; cat x'",
        ] {
            assert!(
                read_command_skills(&json!(["/bin/zsh", "-lc", command])).is_empty(),
                "{command}"
            );
        }
    }

    #[test]
    fn codex_requires_success_and_ignores_catalogues_and_failed_commands() {
        let mut context = Context {
            session: "session".into(),
            ..Default::default()
        };
        assert!(parse_line(
            &command("failed", "turn", "cat /skills/archify/SKILL.md", 1),
            "codex",
            &mut context,
            "fallback"
        )
        .is_empty());
        let catalogue = json!({"type":"response_item","timestamp":"2026-10-16T01:00:00Z","payload":{"type":"message","role":"developer","content":[{"text":"<skill><name>archify</name><path>/skills/archify/SKILL.md</path></skill>"}]}});
        assert!(parse_line(&catalogue, "codex", &mut context, "fallback").is_empty());
        let mut read = command("structured", "turn", "unrecognized-reader", 0);
        read["payload"]["item"]["parsed_cmd"] =
            json!([{"type":"read","path":"/skills/archify/SKILL.md"}]);
        assert_eq!(
            parse_line(&read, "codex", &mut context, "fallback")[0].skill,
            "archify"
        );
    }

    #[test]
    fn claude_namespaces_stream_replays_and_manual_source() {
        let mut context = Context::default();
        let manual = json!({"type":"user","sessionId":"session","uuid":"user-1","timestamp":"2026-10-16T01:00:00Z","message":{"role":"user","content":"<command-name>/plugin:archify</command-name>"}});
        let manual = parse_line(&manual, "claude", &mut context, "fallback")
            .pop()
            .unwrap();
        let tool = json!({"type":"assistant","sessionId":"session","timestamp":"2026-10-16T01:01:00Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-1","name":"Skill","input":{"skill":"plugin:archify"}}]}});
        let automatic = parse_line(&tool, "claude", &mut context, "fallback")
            .pop()
            .unwrap();
        assert_eq!(manual.skill, "plugin:archify");
        assert_eq!(manual.dedup, automatic.dedup);
        let mut again = tool.clone();
        again["message"]["content"][0]["id"] = json!("tool-2");
        assert_eq!(
            parse_line(&again, "claude", &mut context, "fallback")[0].dedup,
            automatic.dedup
        );
        let prompt = json!({"type":"user","sessionId":"session","uuid":"user-2","promptId":"prompt-2","timestamp":"2026-10-16T01:02:00Z","message":{"role":"user","content":"again"}});
        parse_line(&prompt, "claude", &mut context, "fallback");
        let next = parse_line(&again, "claude", &mut context, "fallback")
            .pop()
            .unwrap();
        assert_ne!(next.dedup, automatic.dedup);
        let result = json!({"type":"user","sessionId":"session","uuid":"user-3","promptId":"prompt-2","timestamp":"2026-10-16T01:03:00Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-2","content":"ok"}]}});
        parse_line(&result, "claude", &mut context, "fallback");
        assert_eq!(context.turn, "prompt-2");
    }

    #[test]
    fn plugin_skills_keep_their_namespace_and_skip_openai_builtins() {
        assert_eq!(
            skill_path("/h/.codex/plugins/cache/ponytail/ponytail/5.3.2/skills/ponytail/SKILL.md")
                .as_deref(),
            Some("ponytail:ponytail")
        );
        assert_eq!(
            skill_path("/h/.codex/skills/.system/imagegen/SKILL.md").as_deref(),
            Some("imagegen")
        );
        assert_eq!(
            name("/frontend-design:frontend-design").as_deref(),
            Some("frontend-design:frontend-design")
        );
        assert_eq!(name("a::b"), None);

        let dir = tempfile::tempdir().unwrap();
        for skill in [
            "official/frontend-design/v1/skills/frontend-design",
            "official/frontend-design/v2/skills/frontend-design",
            "openai-bundled/visualize/1.0/skills/visualize",
            "temp_git_1/half/1.0/skills/half",
        ] {
            let path = dir.path().join(skill);
            fs::create_dir_all(&path).unwrap();
            fs::write(
                path.join("SKILL.md"),
                "---\nname: x\ndescription: >\n  Build\n  pages.\n---\n",
            )
            .unwrap();
        }
        let manifest = dir
            .path()
            .join("official/frontend-design/v2/.claude-plugin");
        fs::create_dir_all(&manifest).unwrap();
        fs::write(manifest.join("plugin.json"), r#"{"description":"UI"}"#).unwrap();
        let commands = dir.path().join("official/frontend-design/v2/commands");
        fs::create_dir_all(&commands).unwrap();
        fs::write(commands.join("polish.md"), "").unwrap();
        fs::write(commands.join("notes.txt"), "").unwrap();
        let catalog = plugin_catalog(&[
            ("claude", dir.path().to_path_buf()),
            ("codex", dir.path().join("missing")),
        ]);
        assert_eq!(
            catalog.skills,
            BTreeMap::from([(
                "frontend-design:frontend-design".to_string(),
                "Build pages.".to_string()
            )])
        );
        assert_eq!(
            catalog.plugins,
            BTreeMap::from([("frontend-design".to_string(), "UI".to_string())])
        );
        assert_eq!(
            catalog.sources["frontend-design"],
            BTreeSet::from([PluginSource {
                app: "claude".to_string(),
                marketplace: "official".to_string(),
                version: "v2".to_string(),
                commands: 1,
            }])
        );
        let plugins = catalog.skills;

        let managed = HashSet::from(["frontend-design".to_string(), "archify".to_string()]);
        let resolve = |skill| resolve_skill(skill, &managed, &plugins);
        assert_eq!(
            resolve("frontend-design:frontend-design").as_deref(),
            Some("frontend-design:frontend-design")
        );
        assert_eq!(
            resolve("frontend-design").as_deref(),
            Some("frontend-design")
        );
        assert_eq!(
            resolve("anthropic-skills:archify").as_deref(),
            Some("archify")
        );
        assert_eq!(resolve("visualize:visualize"), None);
        assert_eq!(resolve("compact"), None);
    }

    #[test]
    fn migration_rescans_usage_for_plugin_namespaces() {
        let db = Database::memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("INSERT INTO skill_usage_events VALUES
                ('codex:x:ponytail','codex:s:t:ponytail','ponytail','codex','s','t',30,'agent','skill_file_read');
            INSERT INTO skill_usage_sync VALUES ('f',1,1,1,'x','{}');
            PRAGMA user_version=20;").unwrap();
        Database::apply_schema_migrations_on_conn(&conn).unwrap();
        for table in ["skill_usage_sync", "skill_usage_events"] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0);
        }
    }

    fn append(path: &Path, rows: &[Value]) {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for row in rows {
            writeln!(file, "{row}").unwrap();
        }
    }

    fn setup() -> (Database, tempfile::TempDir, PathBuf) {
        let db = Database::memory().unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO skills(id,name,directory) VALUES ('archify','archify','archify')",
                [],
            )
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        append(
            &path,
            &[
                json!({"type":"session_meta","timestamp":"2026-10-16T00:00:00Z","payload":{"id":"session"}}),
            ],
        );
        (db, dir, path)
    }

    #[test]
    fn incremental_scan_merges_reads_per_turn_not_per_session_and_preserves_manual_source() {
        let (db, _dir, path) = setup();
        append(
            &path,
            &[
                json!({"type":"event_msg","timestamp":"2026-10-16T00:59:00Z","payload":{"type":"task_started","turn_id":"turn-1"}}),
                json!({"type":"response_item","timestamp":"2026-10-16T00:59:30Z","payload":{"type":"message","role":"user","id":"user-1","content":[{"text":"<skill><name>archify</name><path>/skills/archify/SKILL.md</path></skill>"}]}}),
                command(
                    "read-1",
                    "turn-1",
                    "rtk proxy cat /skills/archify/SKILL.md",
                    0,
                ),
                command("read-2", "turn-1", "cat /skills/archify/SKILL.md", 0),
            ],
        );
        sync_file(&db, "codex", &path).unwrap();
        sync_file(&db, "codex", &path).unwrap();
        let mut next = command("read-3", "turn-2", "cat /skills/archify/SKILL.md", 0);
        next["timestamp"] = json!("2026-10-16T02:00:00Z");
        append(&path, &[next]);
        sync_file(&db, "codex", &path).unwrap();
        let snapshot = get_usage(&db, &[1792108800, 1792116000, 1792123200]).unwrap();
        assert_eq!(snapshot.records.len(), 1);
        let row = &snapshot.records[0];
        assert_eq!(
            (row.count, row.sessions, row.manual_count, row.agent_count),
            (2, 1, 1, 1)
        );
        assert_eq!(row.buckets, vec![1, 1]);
        assert_eq!(
            db.conn
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM session_log_sync", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn partial_tail_archiving_rewrites_and_fork_replays_do_not_double_count() {
        let (db, dir, path) = setup();
        let row = command("read-1", "turn-1", "cat /skills/archify/SKILL.md", 0);
        let text = row.to_string();
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{}", &text[..text.len() / 2]).unwrap();
        sync_file(&db, "codex", &path).unwrap();
        sync_file(&db, "codex", &path).unwrap();
        let count = |db: &Database| {
            db.conn
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM skill_usage_events", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap()
        };
        assert_eq!(count(&db), 0);
        writeln!(file, "{}", &text[text.len() / 2..]).unwrap();
        sync_file(&db, "codex", &path).unwrap();
        let archived = dir.path().join("archived.jsonl");
        fs::copy(&path, &archived).unwrap();
        sync_file(&db, "codex", &archived).unwrap();
        fs::write(&path, fs::read(&archived).unwrap()).unwrap();
        sync_file(&db, "codex", &path).unwrap();
        let fork = dir.path().join("fork.jsonl");
        append(
            &fork,
            &[
                json!({"type":"session_meta","timestamp":"2026-10-16T01:30:00Z","payload":{"id":"child","forked_from_id":"session"}}),
                row,
            ],
        );
        sync_file(&db, "codex", &fork).unwrap();
        assert_eq!(
            db.conn
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM skill_usage_events", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn malformed_lines_are_skipped_without_failing_the_file() {
        let (db, _dir, path) = setup();
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{{not json").unwrap();
        append(
            &path,
            &[command(
                "read-1",
                "turn-1",
                "cat /skills/archify/SKILL.md",
                0,
            )],
        );
        sync_file(&db, "codex", &path).unwrap();
        sync_file(&db, "codex", &path).unwrap();
        let snapshot = get_usage(&db, &[1792108800, 1792195200]).unwrap();
        assert_eq!(snapshot.records[0].count, 1);
    }

    #[test]
    fn builtin_slash_commands_are_not_returned_and_disabled_skills_are_counted() {
        let (db, _dir, path) = setup();
        append(
            &path,
            &[
                json!({"type":"user","sessionId":"session","uuid":"u1","timestamp":"2026-10-16T01:00:00Z","message":{"role":"user","content":"<command-name>/compact</command-name>"}}),
                json!({"type":"user","sessionId":"session","uuid":"u2","timestamp":"2026-10-16T01:00:00Z","message":{"role":"user","content":"<command-name>/plugin:archify</command-name>"}}),
            ],
        );
        sync_file(&db, "claude", &path).unwrap();
        let snapshot = get_usage(&db, &[1792108800, 1792195200]).unwrap();
        assert_eq!(snapshot.records.len(), 1);
        assert_eq!(snapshot.records[0].skill_name, "archify");
        assert_eq!(snapshot.records[0].count, 1);
    }
}
