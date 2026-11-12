use std::path::PathBuf;

use crate::app_config::AppType;
use crate::codex_config::get_codex_auth_path;
use crate::config::get_claude_settings_path;
use crate::error::AppError;
use crate::gemini_config::get_gemini_dir;
use crate::openclaw_config::get_openclaw_dir;
use crate::opencode_config::get_opencode_dir;
use crate::prompt::Prompt;

const SEGMENT_START_PREFIX: &str = "<!-- mskills:start id=\"";
const SEGMENT_END_PREFIX: &str = "<!-- mskills:end id=\"";
const SEGMENT_MARKER_SUFFIX: &str = "\" -->";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LivePromptSegment {
    pub id: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct ParsedLivePromptFile {
    pub has_markers: bool,
    pub external_prefix: String,
    pub external_suffix: String,
    pub segments: Vec<LivePromptSegment>,
}

fn encode_marker_id(id: &str) -> String {
    id.replace('%', "%25")
        .replace('"', "%22")
        .replace(['\r', '\n'], "")
}

fn decode_marker_id(encoded: &str) -> String {
    let mut out = String::with_capacity(encoded.len());
    let bytes = encoded.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if &bytes[i..i + 3] == b"%22" {
                out.push('"');
                i += 3;
                continue;
            }
            if &bytes[i..i + 3] == b"%25" {
                out.push('%');
                i += 3;
                continue;
            }
        }
        let ch = encoded[i..].chars().next().expect("valid utf8 boundary");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn parse_marker_line(line: &str, prefix: &str) -> Option<String> {
    let trimmed = line.trim_end_matches('\r').trim();
    let inner = trimmed
        .strip_prefix(prefix)?
        .strip_suffix(SEGMENT_MARKER_SUFFIX)?;
    Some(decode_marker_id(inner))
}

fn normalize_external_lines(lines: &[&str]) -> String {
    let start = lines.iter().position(|line| !line.trim().is_empty());
    let Some(start) = start else {
        return String::new();
    };
    let end = lines
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .unwrap_or(start);
    lines[start..=end]
        .iter()
        .map(|line| line.trim_end_matches('\r'))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn ensure_no_segment_markers(content: &str) -> Result<(), AppError> {
    if content.contains("<!-- mskills:start") || content.contains("<!-- mskills:end") {
        return Err(AppError::localized(
            "prompt.reserved_markers",
            "提示词内容不能包含系统保留标记（<!-- mskills:start / end -->）",
            "Prompt content cannot contain reserved MSkills segment markers (<!-- mskills:start / end -->)",
        ));
    }
    Ok(())
}

pub(crate) fn is_rtk_reference_line(line: &str) -> bool {
    let trimmed = line.trim_end_matches('\r').trim();
    trimmed == "@RTK.md" || (trimmed.starts_with('@') && trimmed.ends_with("/RTK.md"))
}

/// 从带或不带 RTK `@RTK.md` 引用的旧单选文件中拆分出外置 `@RTK.md` 与正文
pub(crate) fn split_rtk_lines(raw: &str) -> (String, String, String) {
    let lines: Vec<&str> = raw.split('\n').collect();
    let mut start = 0;
    let mut end = lines.len();
    let mut prefix_lines: Vec<&str> = Vec::new();
    let mut suffix_lines: Vec<&str> = Vec::new();

    while start < end {
        let line = lines[start].trim_end_matches('\r');
        if line.trim().is_empty() {
            start += 1;
            continue;
        }
        if is_rtk_reference_line(line) {
            prefix_lines.push(line.trim());
            start += 1;
            continue;
        }
        break;
    }

    while end > start {
        let line = lines[end - 1].trim_end_matches('\r');
        if line.trim().is_empty() {
            end -= 1;
            continue;
        }
        if is_rtk_reference_line(line) {
            suffix_lines.push(line.trim());
            end -= 1;
            continue;
        }
        break;
    }
    suffix_lines.reverse();

    let body = normalize_external_lines(&lines[start..end]);
    (prefix_lines.join("\n"), body, suffix_lines.join("\n"))
}

/// 解析目标提示词文件：识别 `<!-- mskills:start/end id="..." -->` 分段与外部保留内容
pub(crate) fn parse_live_prompt_file(raw: &str) -> Result<ParsedLivePromptFile, AppError> {
    if raw.trim().is_empty() {
        return Ok(ParsedLivePromptFile::default());
    }

    let mut has_markers = false;
    let mut seen_segment = false;
    let mut prefix_lines: Vec<&str> = Vec::new();
    let mut suffix_chunks: Vec<String> = Vec::new();
    let mut current_gap_lines: Vec<&str> = Vec::new();
    let mut segments: Vec<LivePromptSegment> = Vec::new();
    let mut open_segment: Option<(String, Vec<&str>)> = None;

    for raw_line in raw.split('\n') {
        let line = raw_line.trim_end_matches('\r');
        let start_id = parse_marker_line(line, SEGMENT_START_PREFIX);
        let end_id = parse_marker_line(line, SEGMENT_END_PREFIX);

        if let Some((ref current_id, ref mut body_lines)) = open_segment {
            if let Some(found_end_id) = end_id {
                if &found_end_id != current_id {
                    return Err(AppError::localized(
                        "prompt.mismatched_end_marker",
                        format!(
                            "提示词文件中的结束标记（{found_end_id}）与开始标记（{current_id}）不匹配，已中止写入以免损坏外部内容"
                        ),
                        format!(
                            "Mismatched prompt end marker '{found_end_id}' for '{current_id}'; aborted write to protect file content"
                        ),
                    ));
                }
                let content = body_lines.join("\n");
                let finished_id = current_id.clone();
                open_segment = None;
                segments.push(LivePromptSegment {
                    id: finished_id,
                    content,
                });
                continue;
            }
            if start_id.is_some()
                || line.trim().starts_with("<!-- mskills:start")
                || line.trim().starts_with("<!-- mskills:end")
            {
                return Err(AppError::localized(
                    "prompt.nested_markers",
                    format!(
                        "提示词片段（{current_id}）内部存在未闭合的标记，已中止写入以免损坏文件内容"
                    ),
                    format!(
                        "Nested or malformed MSkills marker inside segment '{current_id}'; aborted write to protect file content"
                    ),
                ));
            }
            body_lines.push(line);
            continue;
        }

        if let Some(id) = start_id {
            has_markers = true;
            if !seen_segment {
                seen_segment = true;
            } else {
                let normalized = normalize_external_lines(&current_gap_lines);
                if !normalized.is_empty() {
                    suffix_chunks.push(normalized);
                }
                current_gap_lines.clear();
            }
            open_segment = Some((id, Vec::new()));
            continue;
        }

        if end_id.is_some()
            || line.trim().starts_with("<!-- mskills:start")
            || line.trim().starts_with("<!-- mskills:end")
        {
            return Err(AppError::localized(
                "prompt.orphan_marker",
                "目标提示词文件存在残缺的 MSkills 分段标记，已中止写入以免损坏外部内容",
                "Found malformed or unmatched MSkills prompt marker; aborted write to protect file content",
            ));
        }

        if seen_segment {
            current_gap_lines.push(line);
        } else {
            prefix_lines.push(line);
        }
    }

    if let Some((unclosed_id, _)) = open_segment {
        return Err(AppError::localized(
            "prompt.unclosed_marker",
            format!(
                "提示词片段（{unclosed_id}）缺少结束标记 <!-- mskills:end id=\"{unclosed_id}\" -->，已中止写入以免丢失内容"
            ),
            format!(
                "Prompt segment '{unclosed_id}' is missing closing marker; aborted write to protect file content"
            ),
        ));
    }

    if !current_gap_lines.is_empty() {
        let normalized = normalize_external_lines(&current_gap_lines);
        if !normalized.is_empty() {
            suffix_chunks.push(normalized);
        }
    }

    Ok(ParsedLivePromptFile {
        has_markers,
        external_prefix: normalize_external_lines(&prefix_lines),
        external_suffix: suffix_chunks.join("\n\n"),
        segments,
    })
}

/// 去除文本中的所有 MSkills 分段标记行，保留可读正文（用于导入已有文件）
pub(crate) fn strip_segment_marker_lines(raw: &str) -> String {
    let lines: Vec<&str> = raw
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| {
            parse_marker_line(line, SEGMENT_START_PREFIX).is_none()
                && parse_marker_line(line, SEGMENT_END_PREFIX).is_none()
        })
        .collect();
    normalize_external_lines(&lines)
}

fn render_prompt_segment(id: &str, content: &str) -> String {
    let encoded_id = encode_marker_id(id);
    let start = format!("{SEGMENT_START_PREFIX}{encoded_id}{SEGMENT_MARKER_SUFFIX}");
    let end = format!("{SEGMENT_END_PREFIX}{encoded_id}{SEGMENT_MARKER_SUFFIX}");
    let normalized = content.replace("\r\n", "\n");
    let body = normalized.trim_end_matches('\n');
    if body.is_empty() {
        format!("{start}\n{end}")
    } else {
        format!("{start}\n{body}\n{end}")
    }
}

/// 将外部前/后缀与按顺序启用的提示词列表组合写入目标格式
pub(crate) fn compose_prompt_document(
    external_prefix: &str,
    enabled_prompts: &[&Prompt],
    external_suffix: &str,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !external_prefix.trim().is_empty() {
        parts.push(external_prefix.trim_matches('\n').to_string());
    }
    for prompt in enabled_prompts {
        parts.push(render_prompt_segment(&prompt.id, &prompt.content));
    }
    if !external_suffix.trim().is_empty() {
        parts.push(external_suffix.trim_matches('\n').to_string());
    }
    parts.join("\n\n")
}

pub(crate) fn validate_prompt_content(app: &AppType, content: &str) -> Result<(), AppError> {
    if matches!(app, AppType::Mcode) && content.len() > 32 * 1024 {
        return Err(AppError::InvalidInput(
            "MCode global instructions must not exceed 32 KiB".into(),
        ));
    }
    if matches!(app, AppType::Antigravity) && content.len() > 24_000 {
        return Err(AppError::InvalidInput(
            "Antigravity global GEMINI.md must not exceed 24000 bytes".into(),
        ));
    }
    Ok(())
}

/// 返回指定应用所使用的提示词文件路径。
pub fn prompt_file_path(app: &AppType) -> Result<PathBuf, AppError> {
    if matches!(app, AppType::ClaudeDesktop) {
        return Err(AppError::localized(
            "app.prompts_unsupported",
            "当前应用暂不支持 Prompts",
            "This app does not support Prompts",
        ));
    }

    let base_dir: PathBuf = match app {
        AppType::Claude => get_base_dir_with_fallback(get_claude_settings_path(), ".claude")?,
        AppType::Codex => get_base_dir_with_fallback(get_codex_auth_path(), ".codex")?,
        AppType::Gemini => get_gemini_dir(),
        AppType::Antigravity => crate::antigravity_config::config_dir(),
        AppType::GrokBuild => crate::grok_config::get_grok_config_dir(),
        AppType::OpenCode => get_opencode_dir(),
        AppType::OpenClaw => get_openclaw_dir(),
        AppType::Hermes => crate::hermes_config::get_hermes_dir(),
        AppType::Pi => crate::pi_config::get_pi_agent_dir()?,
        AppType::Mcode => crate::mcode_config::data_dir(),
        AppType::Dsh => crate::dsh_config::home_dir(),
        AppType::ClaudeDesktop => unreachable!("handled above"),
    };

    let filename = match app {
        AppType::Claude => "CLAUDE.md",
        AppType::Codex => "AGENTS.md",
        AppType::Gemini | AppType::Antigravity => "GEMINI.md",
        AppType::GrokBuild | AppType::OpenCode | AppType::OpenClaw => "AGENTS.md",
        AppType::Hermes => "SOUL.md",
        AppType::Pi | AppType::Mcode | AppType::Dsh => "AGENTS.md",
        AppType::ClaudeDesktop => unreachable!("handled above"),
    };

    Ok(base_dir.join(filename))
}

fn get_base_dir_with_fallback(
    primary_path: PathBuf,
    fallback_dir: &str,
) -> Result<PathBuf, AppError> {
    primary_path
        .parent()
        .map(|p| p.to_path_buf())
        .or_else(|| dirs::home_dir().map(|h| h.join(fallback_dir)))
        .ok_or_else(|| {
            AppError::localized(
                "home_dir_not_found",
                format!("无法确定 {fallback_dir} 配置目录：用户主目录不存在"),
                format!("Cannot determine {fallback_dir} config directory: user home not found"),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcode_instructions_limit_counts_utf8_bytes() {
        assert!(validate_prompt_content(&AppType::Mcode, &"a".repeat(32768)).is_ok());
        assert!(validate_prompt_content(&AppType::Mcode, &"a".repeat(32769)).is_err());
        assert!(validate_prompt_content(&AppType::Mcode, &"中".repeat(10923)).is_err());
        assert!(validate_prompt_content(&AppType::OpenCode, &"中".repeat(10923)).is_ok());
    }

    #[test]
    fn hermes_prompt_file_uses_soul_md() {
        let path = prompt_file_path(&AppType::Hermes).expect("Hermes prompt path");

        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("SOUL.md")
        );
    }

    #[test]
    fn pi_prompt_file_uses_agents_md() {
        let path = prompt_file_path(&AppType::Pi).expect("Pi prompt path");

        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("AGENTS.md")
        );
    }
}
