//! P2.2 项目 Rules（`CLAUDE.md` / `.claude/CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md`）管理
//!
//! 保障：
//! - 严格路径白名单 + 不跟随 symlink 的父链校验
//! - SHA-256 `revision_hash`（None 表示文件不存在，区分空文件）与文件身份校验防止外部覆写丢失
//! - Prompt 模板托管块 `<!-- mskills:begin id="<prompt_id>" -->...<!-- mskills:end -->`、追加、覆盖三模式
//! - 围栏代码块与行内代码感知的 `@AGENTS.md` 幂等插入
//! - `project_rule_snapshots` 每次写入前保存（单文件上限 20 条），支持 `file_existed = false` 删除恢复语义

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

use crate::app_config::AppType;
use crate::database::dao::projects::{ProjectRecord, ProjectRuleSnapshotRecord};
use crate::database::Database;
use crate::prompt::Prompt;
use crate::services::project::fs_safety::{
    atomic_write_file_verified, capture_fs_identity_follow, capture_fs_identity_nofollow,
    remove_path_any, verify_relative_chain_no_symlinks, FsIdentity,
};

pub const RULE_WHITELIST: &[&str] = &[
    "CLAUDE.md",
    ".claude/CLAUDE.md",
    "CLAUDE.local.md",
    "AGENTS.md",
];
pub const MAX_SNAPSHOTS_PER_FILE: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRuleFile {
    pub project_id: String,
    pub relative_path: String,
    pub exists: bool,
    pub content: String,
    /// `None` = 文件不存在；`Some(sha256)` = 文件存在（包含空文件）
    pub revision_hash: Option<String>,
    pub size_bytes: u64,
    pub has_agents_reference: bool,
    pub is_symlink_blocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertAgentsReferenceResult {
    pub already_present: bool,
    pub file: ProjectRuleFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRuleSnapshotResult {
    pub deleted_file: bool,
    pub file: ProjectRuleFile,
}

pub fn validate_rule_relative_path(relative_path: &str) -> Result<&'static str> {
    let trimmed = relative_path.trim();
    RULE_WHITELIST
        .iter()
        .copied()
        .find(|allowed| *allowed == trimmed)
        .ok_or_else(|| anyhow!("不允许的 Rules 文件路径（不在白名单内）: {relative_path:?}"))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn ensure_project_root_usable(project: &ProjectRecord) -> Result<PathBuf> {
    let root = Path::new(&project.root_path);
    if !root.is_dir() {
        bail!("项目根目录不存在或不可访问: {}", root.display());
    }
    if let Some(ref expected_raw) = project.fs_identity {
        let expected = FsIdentity::from_json(expected_raw)?;
        let actual = capture_fs_identity_follow(root)?;
        if expected != actual {
            bail!(
                "项目目录已被移动或替换（文件系统身份不一致），请先使用「迁移路径」重新绑定：{}",
                root.display()
            );
        }
    }
    Ok(root.to_path_buf())
}

fn check_rule_parent_chain(root: &Path, rel: &str, create_missing: bool) -> Result<PathBuf> {
    if rel == ".claude/CLAUDE.md" {
        verify_relative_chain_no_symlinks(root, &[".claude"], create_missing)?;
        Ok(root.join(".claude").join("CLAUDE.md"))
    } else {
        Ok(root.join(rel))
    }
}

/// 检测 Markdown 文本在**非围栏代码块、非行内反引号代码**之外是否已包含 `@AGENTS.md` 引用。
pub fn has_effective_agents_reference(markdown: &str) -> bool {
    let mut in_fence = false;
    let mut fence_char = '`';
    let mut fence_len = 0usize;

    for raw_line in markdown.lines() {
        let line = raw_line.trim_end_matches('\r');
        let trimmed = line.trim_start();

        if !in_fence {
            if let Some((ch, count)) = parse_fence_opener(trimmed) {
                in_fence = true;
                fence_char = ch;
                fence_len = count;
                continue;
            }
        } else {
            if is_fence_closer(trimmed, fence_char, fence_len) {
                in_fence = false;
            }
            continue;
        }

        if line_has_token_outside_inline_code(line, "@AGENTS.md") {
            return true;
        }
    }

    false
}

fn parse_fence_opener(trimmed: &str) -> Option<(char, usize)> {
    let first = trimmed.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let count = trimmed.chars().take_while(|&c| c == first).count();
    if count >= 3 {
        // CommonMark: backtick info string cannot contain backticks
        if first == '`' && trimmed[count..].contains('`') {
            return None;
        }
        Some((first, count))
    } else {
        None
    }
}

fn is_fence_closer(trimmed: &str, fence_char: char, min_len: usize) -> bool {
    let count = trimmed.chars().take_while(|&c| c == fence_char).count();
    count >= min_len && trimmed[count..].trim().is_empty()
}

fn line_has_token_outside_inline_code(line: &str, token: &str) -> bool {
    let bytes = line.as_bytes();
    let mut i = 0usize;
    let mut active_backticks: Option<usize> = None;
    let mut outside_chunks = Vec::new();
    let mut chunk_start = 0usize;

    while i < bytes.len() {
        if bytes[i] == b'`' {
            let run_start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                i += 1;
            }
            let run_len = i - run_start;
            match active_backticks {
                None => {
                    if run_start > chunk_start {
                        outside_chunks.push(&line[chunk_start..run_start]);
                    }
                    active_backticks = Some(run_len);
                }
                Some(open_len) if open_len == run_len => {
                    active_backticks = None;
                    chunk_start = i;
                }
                Some(_) => {}
            }
        } else {
            i += 1;
        }
    }
    if active_backticks.is_none() && chunk_start < line.len() {
        outside_chunks.push(&line[chunk_start..]);
    } else if active_backticks.is_some() {
        // Unclosed backtick run in markdown is literal text per CommonMark
        outside_chunks.push(&line[chunk_start..]);
    }

    for chunk in outside_chunks {
        let mut search_from = 0usize;
        while let Some(pos) = chunk[search_from..].find(token) {
            let start = search_from + pos;
            let end = start + token.len();
            let prev_ok = start == 0
                || chunk[..start]
                    .chars()
                    .next_back()
                    .is_some_and(|c| !c.is_alphanumeric() && c != '_');
            let next_ok = end == chunk.len()
                || chunk[end..]
                    .chars()
                    .next()
                    .is_some_and(|c| !c.is_alphanumeric() && c != '_' && c != '.' && c != '/');
            if prev_ok && next_ok {
                return true;
            }
            search_from = start + 1;
        }
    }

    false
}

fn read_single_rule_file(
    project: &ProjectRecord,
    root: &Path,
    rel: &'static str,
) -> Result<(ProjectRuleFile, Option<FsIdentity>)> {
    if rel == ".claude/CLAUDE.md" && root.join(".claude").exists() {
        if let Err(_e) = verify_relative_chain_no_symlinks(root, &[".claude"], false) {
            return Ok((
                ProjectRuleFile {
                    project_id: project.id.clone(),
                    relative_path: rel.to_string(),
                    exists: false,
                    content: String::new(),
                    revision_hash: None,
                    size_bytes: 0,
                    has_agents_reference: false,
                    is_symlink_blocked: true,
                },
                None,
            ));
        }
    }

    let abs = root.join(rel);
    match fs::symlink_metadata(&abs) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_file() {
                return Ok((
                    ProjectRuleFile {
                        project_id: project.id.clone(),
                        relative_path: rel.to_string(),
                        exists: true,
                        content: String::new(),
                        revision_hash: None,
                        size_bytes: 0,
                        has_agents_reference: false,
                        is_symlink_blocked: true,
                    },
                    None,
                ));
            }
            let identity = capture_fs_identity_nofollow(&abs)?;
            let bytes = fs::read(&abs)
                .with_context(|| format!("读取项目规则文件失败: {}", abs.display()))?;
            let content = String::from_utf8(bytes.clone())
                .with_context(|| format!("项目规则文件非有效 UTF-8 编码: {}", abs.display()))?;
            let hash = sha256_bytes(&bytes);
            let has_ref = if rel == "CLAUDE.md" {
                has_effective_agents_reference(&content)
            } else {
                false
            };
            Ok((
                ProjectRuleFile {
                    project_id: project.id.clone(),
                    relative_path: rel.to_string(),
                    exists: true,
                    content,
                    revision_hash: Some(hash),
                    size_bytes: bytes.len() as u64,
                    has_agents_reference: has_ref,
                    is_symlink_blocked: false,
                },
                Some(identity),
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((
            ProjectRuleFile {
                project_id: project.id.clone(),
                relative_path: rel.to_string(),
                exists: false,
                content: String::new(),
                revision_hash: None,
                size_bytes: 0,
                has_agents_reference: false,
                is_symlink_blocked: false,
            },
            None,
        )),
        Err(e) => Err(e.into()),
    }
}

pub fn list_project_rules(db: &Arc<Database>, project_id: &str) -> Result<Vec<ProjectRuleFile>> {
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let root = ensure_project_root_usable(&project)?;

    let mut files = Vec::with_capacity(RULE_WHITELIST.len());
    for &rel in RULE_WHITELIST {
        let (file, _) = read_single_rule_file(&project, &root, rel)?;
        files.push(file);
    }
    Ok(files)
}

fn find_prompt_by_id(db: &Arc<Database>, prompt_id: &str) -> Result<Prompt> {
    for app in AppType::all() {
        let map = db.get_prompts(app.as_str())?;
        if let Some(p) = map.get(prompt_id) {
            return Ok(p.clone());
        }
    }
    bail!("未找到提示词模板: {prompt_id}")
}

struct SaveRuleParams<'a> {
    rel: &'static str,
    new_content: &'a str,
    expected_revision: Option<&'a str>,
    action: &'a str,
    prompt_id: Option<&'a str>,
}

fn save_rule_with_snapshot(
    db: &Arc<Database>,
    project: &ProjectRecord,
    root: &Path,
    params: SaveRuleParams<'_>,
) -> Result<ProjectRuleFile> {
    let SaveRuleParams {
        rel,
        new_content,
        expected_revision,
        action,
        prompt_id,
    } = params;
    let (current, expected_identity) = read_single_rule_file(project, root, rel)?;
    if current.is_symlink_blocked {
        bail!("目标规则路径是符号链接或父链含符号链接，出于安全原因拒绝写入: {rel}");
    }

    match (expected_revision, current.revision_hash.as_deref()) {
        (Some(exp), Some(actual)) if exp == actual => {}
        (None, None) => {}
        _ => {
            bail!("文件 {rel} 在编辑期间已被外部修改或状态已变化，请刷新后再保存");
        }
    }

    let snapshot = ProjectRuleSnapshotRecord {
        id: Uuid::new_v4().to_string(),
        project_id: project.id.clone(),
        relative_path: rel.to_string(),
        file_existed: current.exists,
        content: current.content.clone(),
        content_hash: current.revision_hash.clone(),
        prompt_id: prompt_id.map(str::to_string),
        action: action.to_string(),
        created_at: Utc::now().timestamp(),
    };
    db.insert_rule_snapshot_capped(&snapshot, MAX_SNAPSHOTS_PER_FILE)?;

    let abs = check_rule_parent_chain(root, rel, true)?;
    let _ = atomic_write_file_verified(
        &abs,
        new_content.as_bytes(),
        expected_identity.as_ref(),
        !current.exists,
    )?;

    let (updated, _) = read_single_rule_file(project, root, rel)?;
    Ok(updated)
}

pub fn save_project_rule_file(
    db: &Arc<Database>,
    project_id: &str,
    relative_path: &str,
    content: &str,
    expected_revision: Option<&str>,
) -> Result<ProjectRuleFile> {
    let rel = validate_rule_relative_path(relative_path)?;
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let root = ensure_project_root_usable(&project)?;

    save_rule_with_snapshot(
        db,
        &project,
        &root,
        SaveRuleParams {
            rel,
            new_content: content,
            expected_revision,
            action: "edit",
            prompt_id: None,
        },
    )
}

pub fn apply_prompt_to_project_rule(
    db: &Arc<Database>,
    project_id: &str,
    relative_path: &str,
    prompt_id: &str,
    apply_mode: &str,
    expected_revision: Option<&str>,
) -> Result<ProjectRuleFile> {
    let rel = validate_rule_relative_path(relative_path)?;
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let root = ensure_project_root_usable(&project)?;
    let prompt = find_prompt_by_id(db, prompt_id)?;

    let (current, _) = read_single_rule_file(&project, &root, rel)?;
    if current.is_symlink_blocked {
        bail!("目标规则路径含符号链接，拒绝应用模板: {rel}");
    }

    let next_content = match apply_mode {
        "managed_block" => {
            render_managed_prompt_block(&current.content, &prompt.id, &prompt.content)?
        }
        "append" => {
            if current.content.trim().is_empty() {
                format!("{}\n", prompt.content.trim_end())
            } else {
                let base = current.content.trim_end_matches('\n');
                format!("{base}\n\n{}\n", prompt.content.trim_end())
            }
        }
        "overwrite" => {
            let trimmed = prompt.content.trim_end();
            if trimmed.is_empty() {
                String::new()
            } else {
                format!("{trimmed}\n")
            }
        }
        other => bail!("不支持的应用模式: {other}"),
    };

    save_rule_with_snapshot(
        db,
        &project,
        &root,
        SaveRuleParams {
            rel,
            new_content: &next_content,
            expected_revision,
            action: "apply_prompt",
            prompt_id: Some(prompt_id),
        },
    )
}

pub fn render_managed_prompt_block(
    existing: &str,
    prompt_id: &str,
    prompt_content: &str,
) -> Result<String> {
    if prompt_content.contains("<!-- mskills:begin")
        || prompt_content.contains("<!-- mskills:end -->")
    {
        bail!("提示词内容自身包含托管块标记，请改用追加或覆盖模式，或移除标记后重试");
    }

    let begin_marker = format!("<!-- mskills:begin id=\"{prompt_id}\" -->");
    let end_marker = "<!-- mskills:end -->";
    let body = prompt_content.trim_end();
    let new_block = format!("{begin_marker}\n{body}\n{end_marker}");

    if let Some(start_idx) = existing.find(&begin_marker) {
        let search_after = &existing[start_idx + begin_marker.len()..];
        let Some(end_rel_idx) = search_after.find(end_marker) else {
            bail!("现有文件中找到起始标记 {begin_marker} 但缺少结束标记 {end_marker}，请先手动修复标记配对");
        };
        let end_idx = start_idx + begin_marker.len() + end_rel_idx + end_marker.len();
        let mut out = String::new();
        out.push_str(&existing[..start_idx]);
        out.push_str(&new_block);
        out.push_str(&existing[end_idx..]);
        if !out.ends_with('\n') {
            out.push('\n');
        }
        Ok(out)
    } else if existing.trim().is_empty() {
        Ok(format!("{new_block}\n"))
    } else {
        let base = existing.trim_end_matches('\n');
        Ok(format!("{base}\n\n{new_block}\n"))
    }
}

pub fn insert_agents_reference_in_claude_md(
    db: &Arc<Database>,
    project_id: &str,
    expected_revision: Option<&str>,
) -> Result<InsertAgentsReferenceResult> {
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let root = ensure_project_root_usable(&project)?;

    let (current, _) = read_single_rule_file(&project, &root, "CLAUDE.md")?;
    if current.is_symlink_blocked {
        bail!("CLAUDE.md 路径是符号链接，拒绝写入");
    }
    if has_effective_agents_reference(&current.content) {
        return Ok(InsertAgentsReferenceResult {
            already_present: true,
            file: current,
        });
    }

    let next_content = if current.content.trim().is_empty() {
        "@AGENTS.md\n".to_string()
    } else {
        let trimmed_start = current.content.trim_start_matches('\n');
        format!("@AGENTS.md\n\n{trimmed_start}")
    };

    let updated = save_rule_with_snapshot(
        db,
        &project,
        &root,
        SaveRuleParams {
            rel: "CLAUDE.md",
            new_content: &next_content,
            expected_revision,
            action: "insert_agents_ref",
            prompt_id: None,
        },
    )?;

    Ok(InsertAgentsReferenceResult {
        already_present: false,
        file: updated,
    })
}

pub fn list_rule_snapshots(
    db: &Arc<Database>,
    project_id: &str,
    relative_path: Option<&str>,
) -> Result<Vec<ProjectRuleSnapshotRecord>> {
    if let Some(rel) = relative_path {
        let _ = validate_rule_relative_path(rel)?;
    }
    Ok(db.list_rule_snapshots(project_id, relative_path)?)
}

pub fn restore_rule_snapshot(
    db: &Arc<Database>,
    project_id: &str,
    snapshot_id: &str,
    expected_current_revision: Option<&str>,
    confirm_delete: bool,
) -> Result<RestoreRuleSnapshotResult> {
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("项目不存在: {project_id}"))?;
    let root = ensure_project_root_usable(&project)?;

    let snapshot = db
        .get_rule_snapshot(snapshot_id)?
        .ok_or_else(|| anyhow!("规则快照不存在: {snapshot_id}"))?;
    if snapshot.project_id != project_id {
        bail!("快照不属于当前项目");
    }
    let rel = validate_rule_relative_path(&snapshot.relative_path)?;

    if !snapshot.file_existed {
        if !confirm_delete {
            bail!("该历史快照记录的改动前状态为“文件不存在”，恢复此版本将删除当前磁盘上的 {rel}，请确认删除。");
        }
        let (current, expected_identity) = read_single_rule_file(&project, &root, rel)?;
        if current.is_symlink_blocked {
            bail!("目标路径含符号链接，拒绝删除: {rel}");
        }
        match (expected_current_revision, current.revision_hash.as_deref()) {
            (Some(exp), Some(actual)) if exp == actual => {}
            (None, None) => {}
            _ => bail!("文件 {rel} 在恢复前已发生变化，请刷新后再试"),
        }
        if current.exists {
            let safety_snap = ProjectRuleSnapshotRecord {
                id: Uuid::new_v4().to_string(),
                project_id: project.id.clone(),
                relative_path: rel.to_string(),
                file_existed: true,
                content: current.content.clone(),
                content_hash: current.revision_hash.clone(),
                prompt_id: None,
                action: "restore".to_string(),
                created_at: Utc::now().timestamp(),
            };
            db.insert_rule_snapshot_capped(&safety_snap, MAX_SNAPSHOTS_PER_FILE)?;
            if let Some(exp_id) = expected_identity {
                let abs = root.join(rel);
                let actual_id = capture_fs_identity_nofollow(&abs)?;
                if actual_id != exp_id {
                    bail!("文件在删除前被外部替换，取消操作");
                }
                remove_path_any(&abs)?;
            }
        }
        let (after, _) = read_single_rule_file(&project, &root, rel)?;
        return Ok(RestoreRuleSnapshotResult {
            deleted_file: true,
            file: after,
        });
    }

    let updated = save_rule_with_snapshot(
        db,
        &project,
        &root,
        SaveRuleParams {
            rel,
            new_content: &snapshot.content,
            expected_revision: expected_current_revision,
            action: "restore",
            prompt_id: snapshot.prompt_id.as_deref(),
        },
    )?;

    Ok(RestoreRuleSnapshotResult {
        deleted_file: false,
        file: updated,
    })
}
