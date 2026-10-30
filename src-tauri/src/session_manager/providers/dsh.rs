//! Read-only DSH generation logs, including the default concatenated Zstandard frames.
use crate::session_manager::{SessionMessage, SessionMeta};
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

fn reader(path: &Path) -> Result<Box<dyn BufRead>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    if path.extension().is_some_and(|e| e == "zstd") {
        let decoder = zstd::stream::read::Decoder::new(file).map_err(|e| e.to_string())?;
        Ok(Box::new(BufReader::new(decoder)))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

fn generation(path: &Path) -> Option<u32> {
    let name = path.file_name()?.to_str()?;
    let name = name
        .strip_suffix(".zstd")
        .unwrap_or(name)
        .strip_suffix(".jsonl")?;
    if name == "session" {
        Some(0)
    } else {
        let version = name.strip_prefix("session.v")?;
        let value: u32 = version.parse().ok()?;
        (value > 0 && value.to_string() == version).then_some(value)
    }
}

fn selected_generation(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter_map(|p| generation(&p).map(|v| (v, p)))
        .max_by_key(|(v, _)| *v)
        .map(|(_, p)| p)
}

fn header(reader: &mut dyn BufRead) -> Result<Value, String> {
    let mut line = String::new();
    reader
        .take(1024 * 1024)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let value: Value =
        serde_json::from_str(&line).map_err(|_| "Invalid DSH session header".to_string())?;
    if value["type"] != "session"
        || value["id"].as_str().is_none()
        || value["version"].as_u64().is_none_or(|v| v > 4)
    {
        return Err("Unsupported DSH session format; update MSkills to read this log".into());
    }
    Ok(value)
}

pub fn scan_sessions() -> Vec<SessionMeta> {
    scan_root(&crate::dsh_config::home_dir().join("sessions"))
}

fn scan_root(root: &Path) -> Vec<SessionMeta> {
    let Ok(projects) = fs::read_dir(root) else {
        return vec![];
    };
    let mut sessions = vec![];
    for project in projects.flatten() {
        if !project.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(dirs) = fs::read_dir(project.path()) else {
            continue;
        };
        for dir in dirs.flatten() {
            if !dir.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let Some(path) = selected_generation(&dir.path()) else {
                continue;
            };
            let Ok(mut input) = reader(&path) else {
                continue;
            };
            let Ok(meta) = header(input.as_mut()) else {
                continue;
            };
            if meta["origin"] == "subagent"
                || meta["delegationDepth"].as_u64().is_some_and(|d| d > 0)
            {
                continue;
            }
            // Bound list-time work; full history is decoded only when the user opens it.
            let mut title = None;
            for line in input
                .take(1024 * 1024)
                .lines()
                .take(200)
                .map_while(Result::ok)
            {
                let Ok(event) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if event["type"] == "session/title" {
                    title = event["data"]["title"].as_str().map(str::to_owned);
                } else if title.is_none()
                    && event["type"] == "user/message"
                    && event["data"]["source"]["kind"] == "user"
                {
                    let text = super::utils::extract_text(&event["data"]["content"]);
                    if !text.trim().is_empty() {
                        title = Some(super::utils::truncate_summary(&text, 80));
                    }
                }
            }
            sessions.push(SessionMeta {
                provider_id: "dsh".into(),
                session_id: meta["id"].as_str().unwrap().into(),
                title,
                summary: None,
                project_dir: meta["cwd"].as_str().map(str::to_owned),
                created_at: meta["createdAt"].as_i64(),
                last_active_at: fs::metadata(&path)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64),
                source_path: Some(path.to_string_lossy().into_owned()),
                resume_command: None,
            });
        }
    }
    sessions
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let root = crate::dsh_config::home_dir()
        .join("sessions")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(root) || generation(&path).is_none() {
        return Err("DSH session is outside its session root".into());
    }
    read_messages(&path)
}

fn read_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let mut input = reader(path)?;
    let meta = header(input.as_mut())?;
    if meta["version"].as_u64().is_some_and(|v| v < 2) {
        return Err(
            "Open this historical session in DSH once to upgrade its packed log format".into(),
        );
    }
    const LIMIT: u64 = 128 * 1024 * 1024;
    let mut bytes = Vec::new();
    if let Err(e) = input.take(LIMIT + 1).read_to_end(&mut bytes) {
        // A live zstd log can end mid-frame; keep the committed lines decoded before it.
        if bytes.is_empty() {
            return Err(e.to_string());
        }
    }
    if bytes.len() as u64 > LIMIT {
        return Err("DSH session exceeds the 128 MiB history preview limit".into());
    }
    let mut messages = vec![];
    for line in bytes.split_inclusive(|b| *b == b'\n') {
        // An unfinished raw final line is not a committed DSH event.
        if line.last() != Some(&b'\n') {
            break;
        }
        let event: Value =
            serde_json::from_slice(line).map_err(|_| "Invalid DSH session event".to_string())?;
        let (role, content) = match event["type"].as_str() {
            Some("user/message") if event["data"]["source"]["kind"] == "user" => {
                ("user", &event["data"]["content"])
            }
            Some("assistant/message") => ("assistant", &event["data"]["message"]["content"]),
            _ => continue,
        };
        let content = super::utils::extract_text(content);
        if !content.trim().is_empty() {
            messages.push(SessionMessage {
                role: role.into(),
                content,
                ts: event["time"].as_i64(),
            });
        }
    }
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    const HEADER:&str="{\"type\":\"session\",\"version\":4,\"id\":\"s1\",\"createdAt\":1000,\"cwd\":\"/work\",\"isSeeded\":false,\"delegationDepth\":0}\n";
    const EVENTS:&str=concat!(
        "{\"type\":\"user/message\",\"seq\":0,\"time\":1001,\"data\":{\"source\":{\"kind\":\"user\"},\"content\":[{\"type\":\"text\",\"text\":\"Fix this\"}]}}\n",
        "{\"type\":\"user/message\",\"seq\":1,\"time\":1002,\"data\":{\"source\":{\"kind\":\"plugin\"},\"content\":\"Hidden instructions\"}}\n",
        "{\"type\":\"assistant/message\",\"seq\":2,\"time\":1003,\"data\":{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Fixed\"}]}}}\n",
        "{\"type\":\"session/title\",\"seq\":3,\"time\":1004,\"data\":{\"title\":\"Native title\"}}\n");
    #[test]
    fn dsh_reads_raw_and_concatenated_zstd_and_selects_highest_generation() {
        let dir = tempfile::tempdir().unwrap();
        let session = dir.path().join("project/s1");
        fs::create_dir_all(&session).unwrap();
        let raw = session.join("session.v3.jsonl");
        fs::write(&raw, format!("{HEADER}{EVENTS}")).unwrap();
        let compressed = session.join("session.v4.jsonl.zstd");
        let mut bytes = zstd::stream::encode_all(HEADER.as_bytes(), 0).unwrap();
        bytes.extend(zstd::stream::encode_all(EVENTS.as_bytes(), 0).unwrap());
        fs::write(&compressed, &bytes).unwrap();
        assert_eq!(selected_generation(&session), Some(compressed.clone()));
        let sessions = scan_root(dir.path());
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title.as_deref(), Some("Native title"));
        for path in [&raw, &compressed] {
            let messages = read_messages(path).unwrap();
            assert_eq!(messages.len(), 2);
            assert_eq!(messages[1].content, "Fixed");
            assert_eq!(messages[0].ts, Some(1001));
        }
        assert_eq!(fs::read(&compressed).unwrap(), bytes);
        fs::write(
            session.join("session.v5.jsonl"),
            HEADER.replace("\"version\":4", "\"version\":5"),
        )
        .unwrap();
        assert!(scan_root(dir.path()).is_empty());
    }
    #[test]
    fn dsh_refuses_corrupt_compression_and_ignores_uncommitted_raw_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.v4.jsonl");
        fs::write(&path, format!("{HEADER}{EVENTS}{{unfinished")).unwrap();
        assert_eq!(read_messages(&path).unwrap().len(), 2);
        let path = dir.path().join("session.v4.jsonl.zstd");
        fs::write(&path, b"corrupt").unwrap();
        assert!(read_messages(&path).is_err());
    }
    #[test]
    fn dsh_keeps_events_before_a_truncated_zstd_frame() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.v4.jsonl.zstd");
        let mut bytes = zstd::stream::encode_all(HEADER.as_bytes(), 0).unwrap();
        bytes.extend(zstd::stream::encode_all(EVENTS.as_bytes(), 0).unwrap());
        let tail = zstd::stream::encode_all(EVENTS.as_bytes(), 0).unwrap();
        bytes.extend(&tail[..tail.len() / 2]);
        fs::write(&path, bytes).unwrap();
        assert_eq!(read_messages(&path).unwrap().len(), 2);
    }
}
