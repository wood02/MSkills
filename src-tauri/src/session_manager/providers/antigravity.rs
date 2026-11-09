use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::session_manager::{SessionMessage, SessionMeta};

use super::utils::{parse_timestamp_to_ms, truncate_summary};

const PROVIDER_ID: &str = "antigravity";
const MAX_SUMMARY_CHARS: usize = 160;

pub fn scan_sessions() -> Vec<SessionMeta> {
    let brain_dir = crate::antigravity_config::data_dir().join("brain");
    let Ok(entries) = fs::read_dir(&brain_dir) else {
        return Vec::new();
    };

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let conv_dir = entry.path();
        if !conv_dir.is_dir() {
            continue;
        }
        let Some(conv_id) = conv_dir
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|s| !s.starts_with('.'))
            .map(str::to_string)
        else {
            continue;
        };

        let transcript_path = conv_dir
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        if !transcript_path.is_file() {
            continue;
        }

        if let Some(meta) = parse_session_meta(&transcript_path, conv_id) {
            sessions.push(meta);
        }
    }

    sessions
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open transcript: {e}"))?;
    let reader = BufReader::new(file);

    // Lazily load untruncated steps from transcript_full.jsonl only when needed.
    let mut full_steps: Option<HashMap<u64, Value>> = None;
    let mut messages = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(mut value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        if has_truncated_fields(&value) {
            if full_steps.is_none() {
                full_steps = Some(load_full_steps_map(path));
            }
            if let Some(step_idx) = value.get("step_index").and_then(Value::as_u64) {
                if let Some(full_val) = full_steps.as_ref().and_then(|m| m.get(&step_idx)) {
                    value = full_val.clone();
                }
            }
        }

        if let Some(msg) = parse_step_message(&value) {
            messages.push(msg);
        }
    }

    Ok(messages)
}

fn has_truncated_fields(value: &Value) -> bool {
    value
        .get("truncated_fields")
        .and_then(Value::as_array)
        .is_some_and(|arr| !arr.is_empty())
}

fn load_full_steps_map(compact_path: &Path) -> HashMap<u64, Value> {
    let mut map = HashMap::new();
    let Some(parent) = compact_path.parent() else {
        return map;
    };
    let full_path: PathBuf = parent.join("transcript_full.jsonl");
    let Ok(file) = File::open(&full_path) else {
        return map;
    };
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(idx) = val.get("step_index").and_then(Value::as_u64) {
            map.insert(idx, val);
        }
    }
    map
}

fn parse_session_meta(path: &Path, session_id: String) -> Option<SessionMeta> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut created_at: Option<i64> = None;
    let mut last_active_at: Option<i64> = None;
    let mut title: Option<String> = None;
    let mut summary: Option<String> = None;

    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        let ts = value.get("created_at").and_then(parse_timestamp_to_ms);
        if created_at.is_none() {
            created_at = ts;
        }
        if ts.is_some() {
            last_active_at = ts;
        }

        let step_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if step_type == "USER_INPUT" {
            if let Some(raw_content) = value.get("content").and_then(Value::as_str) {
                let cleaned = clean_user_input(raw_content);
                if !cleaned.is_empty() {
                    if title.is_none() {
                        title = Some(truncate_summary(&cleaned, MAX_SUMMARY_CHARS));
                    }
                    summary = Some(truncate_summary(&cleaned, MAX_SUMMARY_CHARS));
                }
            }
        } else if step_type == "PLANNER_RESPONSE" && summary.is_none() {
            if let Some(raw_content) = value.get("content").and_then(Value::as_str) {
                let trimmed = raw_content.trim();
                if !trimmed.is_empty() {
                    summary = Some(truncate_summary(trimmed, MAX_SUMMARY_CHARS));
                }
            }
        }
    }

    Some(SessionMeta {
        provider_id: PROVIDER_ID.to_string(),
        session_id,
        title,
        summary,
        project_dir: None,
        created_at,
        last_active_at,
        source_path: Some(path.to_string_lossy().to_string()),
        resume_command: None,
    })
}

fn parse_step_message(value: &Value) -> Option<SessionMessage> {
    let step_type = value.get("type").and_then(Value::as_str)?;
    let ts = value.get("created_at").and_then(parse_timestamp_to_ms);

    match step_type {
        "USER_INPUT" => {
            let raw = value.get("content").and_then(Value::as_str).unwrap_or("");
            let content = clean_user_input(raw);
            if content.is_empty() {
                return None;
            }
            Some(SessionMessage {
                role: "user".to_string(),
                content,
                ts,
            })
        }
        "PLANNER_RESPONSE" => {
            let mut parts: Vec<String> = Vec::new();
            if let Some(text) = value
                .get("content")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                parts.push(text.to_string());
            }
            if let Some(tool_calls) = value.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    if let Some(name) = call.get("name").and_then(Value::as_str) {
                        parts.push(format!("[Tool: {name}]"));
                    }
                }
            }
            if parts.is_empty() {
                return None;
            }
            Some(SessionMessage {
                role: "assistant".to_string(),
                content: parts.join("\n"),
                ts,
            })
        }
        "ERROR_MESSAGE" => {
            let text = value
                .get("content")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())?;
            Some(SessionMessage {
                role: "system".to_string(),
                content: text.to_string(),
                ts,
            })
        }
        _ => None,
    }
}

/// Extracts user-authored text from Antigravity's `USER_INPUT` step content,
/// stripping system-injected `<USER_REQUEST>`, `<ADDITIONAL_METADATA>`,
/// `<USER_SETTINGS_CHANGE>`, and `<CONTEXT_SUMMARY>` wrappers.
pub(crate) fn clean_user_input(raw: &str) -> String {
    let mut extracted = Vec::new();
    let mut search_from = 0;
    const OPEN_TAG: &str = "<USER_REQUEST>";
    const CLOSE_TAG: &str = "</USER_REQUEST>";

    while let Some(open_rel) = raw[search_from..].find(OPEN_TAG) {
        let content_start = search_from + open_rel + OPEN_TAG.len();
        if let Some(close_rel) = raw[content_start..].find(CLOSE_TAG) {
            let inner = raw[content_start..content_start + close_rel].trim();
            if !inner.is_empty() {
                extracted.push(inner.to_string());
            }
            search_from = content_start + close_rel + CLOSE_TAG.len();
        } else {
            break;
        }
    }

    if !extracted.is_empty() {
        return extracted.join("\n\n");
    }

    let mut cleaned = raw.to_string();
    for (open, close) in [
        ("<ADDITIONAL_METADATA>", "</ADDITIONAL_METADATA>"),
        ("<USER_SETTINGS_CHANGE>", "</USER_SETTINGS_CHANGE>"),
        ("<CONTEXT_SUMMARY>", "</CONTEXT_SUMMARY>"),
        ("<EPHEMERAL_MESSAGE>", "</EPHEMERAL_MESSAGE>"),
    ] {
        while let Some(start) = cleaned.find(open) {
            if let Some(end_rel) = cleaned[start + open.len()..].find(close) {
                let end = start + open.len() + end_rel + close.len();
                cleaned.replace_range(start..end, "");
            } else {
                break;
            }
        }
    }

    cleaned.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clean_user_input_extracts_user_request_tags_and_strips_metadata() {
        let wrapped = "<ADDITIONAL_METADATA>\nfoo\n</ADDITIONAL_METADATA>\n<USER_REQUEST>\nHello Antigravity\n</USER_REQUEST>";
        assert_eq!(clean_user_input(wrapped), "Hello Antigravity");

        let fallback = "<CONTEXT_SUMMARY>\nold\n</CONTEXT_SUMMARY>\nDirect question";
        assert_eq!(clean_user_input(fallback), "Direct question");
    }

    #[test]
    fn parse_step_message_formats_planner_response_with_tool_calls() {
        let step = json!({
            "step_index": 2,
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-05T01:50:03Z",
            "content": "Checking files.",
            "tool_calls": [
                { "name": "default_api:read_file" }
            ]
        });
        let msg = parse_step_message(&step).unwrap();
        assert_eq!(msg.role, "assistant");
        assert_eq!(
            msg.content,
            "Checking files.\n[Tool: default_api:read_file]"
        );
        assert!(msg.ts.is_some());
    }
}
