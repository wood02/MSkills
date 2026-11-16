//! Git 工作区与 `.git/info/exclude` 托管块管理
//!
//! 为全局 `symlink` 模式提供安全约束：
//! - 使用 `git --literal-pathspecs` + `-z` 严格检测路径是否已被 Git 跟踪或暂存
//! - 使用 `git rev-parse --git-path info/exclude`（自动兼容 worktree / submodule 共享 common git dir）
//! - 通过 `git check-ignore -q --no-index` 验证最终忽略生效结果（绝不绕过 `.gitignore` 否定规则或自定义配置）
//! - 通过按 `project_id` 隔离的 `# mskills:begin/end project=<id>` 块与进程级文件锁支持多 worktree 安全共存与清理

use anyhow::{anyhow, bail, Context, Result};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use crate::database::dao::projects::ProjectRecord;
use crate::database::Database;
use crate::services::project::fs_safety::atomic_write_file_verified;

#[derive(Debug, Clone)]
pub struct GitRepoInfo {
    pub toplevel: PathBuf,
    pub is_worktree: bool,
    pub exclude_path: PathBuf,
    pub exclude_ref: String,
    pub project_rel_prefix: PathBuf,
}

fn exclude_file_lock(canonical_exclude: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let map_mutex = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = map_mutex.lock().unwrap_or_else(|e| e.into_inner());
    Arc::clone(
        map.entry(canonical_exclude.to_path_buf())
            .or_insert_with(|| Arc::new(Mutex::new(()))),
    )
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<std::process::Output> {
    let mut cmd = Command::new("git");
    cmd.arg("--literal-pathspecs").arg("-C").arg(cwd).args(args);
    cmd.output()
        .with_context(|| format!("执行 git {:?} 失败（工作目录: {}）", args, cwd.display()))
}

fn resolve_git_path(project_root: &Path, raw: &str) -> PathBuf {
    let trimmed = raw.trim_end_matches(['\r', '\n']);
    let p = Path::new(trimmed);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        project_root.join(p)
    }
}

pub fn inspect_git_repo(project_root: &Path) -> Result<Option<GitRepoInfo>> {
    if !project_root.is_dir() {
        return Ok(None);
    }
    let out = match run_git(
        project_root,
        &[
            "rev-parse",
            "--show-toplevel",
            "--git-dir",
            "--git-common-dir",
            "--git-path",
            "info/exclude",
        ],
    ) {
        Ok(o) => o,
        Err(_) => return Ok(None),
    };
    if !out.status.success() {
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let lines: Vec<&str> = stdout.lines().collect();
    if lines.len() < 4 {
        return Ok(None);
    }
    let toplevel_raw = PathBuf::from(lines[0].trim());
    let toplevel = toplevel_raw.canonicalize().unwrap_or(toplevel_raw);
    let git_dir_raw = resolve_git_path(project_root, lines[1]);
    let git_dir = git_dir_raw.canonicalize().unwrap_or(git_dir_raw);
    let common_raw = resolve_git_path(project_root, lines[2]);
    let git_common_dir = common_raw.canonicalize().unwrap_or(common_raw);
    let exclude_raw = resolve_git_path(project_root, lines[3]);
    let exclude_path = exclude_raw
        .canonicalize()
        .or_else(|_| {
            exclude_raw
                .parent()
                .and_then(|p| p.canonicalize().ok())
                .and_then(|cp| exclude_raw.file_name().map(|f| cp.join(f)))
                .ok_or_else(|| anyhow!("no canonical"))
        })
        .unwrap_or(exclude_raw);

    let root_canon = project_root
        .canonicalize()
        .unwrap_or_else(|_| project_root.to_path_buf());
    let project_rel_prefix = root_canon
        .strip_prefix(&toplevel)
        .unwrap_or_else(|_| Path::new(""))
        .to_path_buf();

    let is_worktree = git_dir != git_common_dir;
    let exclude_ref = exclude_path.to_string_lossy().to_string();

    Ok(Some(GitRepoInfo {
        toplevel,
        is_worktree,
        exclude_path,
        exclude_ref,
        project_rel_prefix,
    }))
}

pub fn target_rel_entry(target: &str, directory: &str) -> Result<String> {
    let base = match target {
        "agents" => ".agents/skills",
        "claude" => ".claude/skills",
        other => bail!("未知的部署目标: {other}"),
    };
    Ok(format!("{base}/{directory}"))
}

fn repo_relative_entry(repo: &GitRepoInfo, target: &str, directory: &str) -> Result<String> {
    let sub = target_rel_entry(target, directory)?;
    let full = if repo.project_rel_prefix.as_os_str().is_empty() {
        sub
    } else {
        let prefix = repo.project_rel_prefix.to_string_lossy().replace('\\', "/");
        format!("{}/{}", prefix.trim_end_matches('/'), sub)
    };
    Ok(full)
}

/// 检查路径（或其下任何文件）是否已被 Git 跟踪或暂存。
pub fn is_path_tracked_in_git(repo: &GitRepoInfo, target: &str, directory: &str) -> Result<bool> {
    let repo_rel = repo_relative_entry(repo, target, directory)?;
    let out = run_git(&repo.toplevel, &["ls-files", "-z", "--", &repo_rel])?;
    if !out.status.success() {
        bail!(
            "git ls-files 执行失败: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    if !out.stdout.is_empty() {
        return Ok(true);
    }

    let status_out = run_git(
        &repo.toplevel,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=no",
            "--",
            &repo_rel,
        ],
    )?;
    if !status_out.status.success() {
        bail!(
            "git status 执行失败: {}",
            String::from_utf8_lossy(&status_out.stderr)
        );
    }
    Ok(!status_out.stdout.is_empty())
}

/// 使用 `git check-ignore -q --no-index --stdin -z` 验证给定相对路径当前是否受 Git 忽略。
pub fn is_path_ignored_by_git(repo: &GitRepoInfo, target: &str, directory: &str) -> Result<bool> {
    use std::io::Write;
    use std::process::Stdio;

    let repo_rel = repo_relative_entry(repo, target, directory)?;
    let mut child = Command::new("git")
        .arg("-C")
        .arg(&repo.toplevel)
        .args(["check-ignore", "-q", "--no-index", "--stdin", "-z"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!(
                "启动 git check-ignore 失败（工作目录: {}）",
                repo.toplevel.display()
            )
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(repo_rel.as_bytes())?;
        stdin.write_all(&[0u8])?;
    }

    let out = child.wait_with_output()?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        other => bail!(
            "git check-ignore 执行异常 (exit {:?}): {}",
            other,
            String::from_utf8_lossy(&out.stderr)
        ),
    }
}

fn block_markers(project_id: &str) -> (String, String) {
    (
        format!("# mskills:begin project={project_id}"),
        format!("# mskills:end project={project_id}"),
    )
}

fn update_exclude_content(existing: &str, project_id: &str, rule_line: &str, add: bool) -> String {
    let line_ending = if existing.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let (begin_marker, end_marker) = block_markers(project_id);

    let mut before = Vec::new();
    let mut block_entries: Vec<String> = Vec::new();
    let mut after = Vec::new();

    #[derive(PartialEq, Eq)]
    enum State {
        Before,
        Inside,
        After,
    }
    let mut state = State::Before;

    for raw_line in existing.lines() {
        let trimmed = raw_line.trim_end_matches('\r');
        match state {
            State::Before => {
                if trimmed == begin_marker {
                    state = State::Inside;
                } else {
                    before.push(trimmed.to_string());
                }
            }
            State::Inside => {
                if trimmed == end_marker {
                    state = State::After;
                } else if !trimmed.trim().is_empty() {
                    block_entries.push(trimmed.to_string());
                }
            }
            State::After => {
                after.push(trimmed.to_string());
            }
        }
    }

    if add {
        if !block_entries.iter().any(|l| l == rule_line) {
            block_entries.push(rule_line.to_string());
        }
    } else {
        block_entries.retain(|l| l != rule_line);
    }

    let mut final_lines = before;
    if !block_entries.is_empty() {
        if !final_lines.is_empty() && !final_lines.last().is_some_and(|l| l.is_empty()) {
            // keep tight or cleanly separated
        }
        final_lines.push(begin_marker);
        final_lines.extend(block_entries);
        final_lines.push(end_marker);
    }
    final_lines.extend(after);

    if final_lines.is_empty() {
        String::new()
    } else {
        let mut out = final_lines.join(line_ending);
        out.push_str(line_ending);
        out
    }
}

/// 在部署全局 Symlink 前校验 Git 跟踪与忽略状态，必要时按 `auto_git_exclude` 安全写入 `info/exclude`。
///
/// 返回 `Some(git_exclude_ref)` 表示由本系统写入并需托管清理的 exclude 文件引用；
/// 返回 `None` 表示非 Git 仓库或已被仓库既有规则忽略、无需接管。
pub fn prepare_git_exclude_for_symlink(
    project: &ProjectRecord,
    target: &str,
    directory: &str,
) -> Result<Option<String>> {
    let project_root = Path::new(&project.root_path);
    let Some(repo) = inspect_git_repo(project_root)? else {
        return Ok(None);
    };

    if is_path_tracked_in_git(&repo, target, directory)? {
        bail!(
            "路径 {}/{} 已被 Git 跟踪或暂存，禁止部署为全局软链",
            target,
            directory
        );
    }

    if is_path_ignored_by_git(&repo, target, directory)? {
        // 如果已在我们自己托管的 block 里，则返回引用；否则尊重用户现有忽略规则
        let existing = fs::read_to_string(&repo.exclude_path).unwrap_or_default();
        let (begin_marker, end_marker) = block_markers(&project.id);
        let rule_line = format!("/{}", repo_relative_entry(&repo, target, directory)?);
        let in_our_block = existing
            .lines()
            .skip_while(|l| l.trim_end_matches('\r') != begin_marker)
            .skip(1)
            .take_while(|l| l.trim_end_matches('\r') != end_marker)
            .any(|l| l.trim_end_matches('\r') == rule_line);
        return Ok(if in_our_block {
            Some(repo.exclude_ref)
        } else {
            None
        });
    }

    if !project.auto_git_exclude {
        bail!(
            "Git 仓库中该路径未被忽略，且项目未开启「自动管理 Git Exclude」：请先将该路径加入 .gitignore / .git/info/exclude，或在项目设置中开启自动管理后重试（{}）",
            repo_relative_entry(&repo, target, directory)?
        );
    }

    let lock = exclude_file_lock(&repo.exclude_path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let previous_content = fs::read_to_string(&repo.exclude_path).unwrap_or_default();
    let rule_line = format!("/{}", repo_relative_entry(&repo, target, directory)?);
    let next_content = update_exclude_content(&previous_content, &project.id, &rule_line, true);

    if let Some(parent) = repo.exclude_path.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic_write_file_verified(&repo.exclude_path, next_content.as_bytes(), None, false)?;

    // 验证写入后 git check-ignore 真实返回忽略（防止被否定规则或非标准 excludes 配置覆盖）
    match is_path_ignored_by_git(&repo, target, directory) {
        Ok(true) => Ok(Some(repo.exclude_ref)),
        Ok(false) => {
            let _ = atomic_write_file_verified(
                &repo.exclude_path,
                previous_content.as_bytes(),
                None,
                false,
            );
            bail!(
                "已写入 {}，但 git check-ignore 仍未将该路径判为忽略（可能存在否定规则 ! 或自定义 core.excludesFile），已回滚并取消全局软链部署",
                repo.exclude_path.display()
            );
        }
        Err(err) => {
            let _ = atomic_write_file_verified(
                &repo.exclude_path,
                previous_content.as_bytes(),
                None,
                false,
            );
            Err(err)
        }
    }
}

/// 清理某条部署对应的 `git_exclude_ref` 条目（按 `project_id` 独立块移除，绝不影响共享 common `info/exclude` 的其他 worktree/项目）。
pub fn release_git_exclude_ref(
    db: &Arc<Database>,
    project: &ProjectRecord,
    target: &str,
    directory: &str,
    exclude_ref: &str,
) -> Result<()> {
    let project_root = Path::new(&project.root_path);
    let repo_opt = inspect_git_repo(project_root)?;
    let exclude_path = repo_opt
        .as_ref()
        .map(|r| r.exclude_path.clone())
        .unwrap_or_else(|| PathBuf::from(exclude_ref));

    if !exclude_path.exists() {
        return Ok(());
    }

    let lock = exclude_file_lock(&exclude_path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let rule_line = match repo_opt.as_ref() {
        Some(repo) => format!("/{}", repo_relative_entry(repo, target, directory)?),
        None => format!("/{}", target_rel_entry(target, directory)?),
    };

    // 检查同一项目内是否还有另一条有效记录引用同一规则（正常情况 (project_id, target, directory) 唯一）
    let same_project_still_uses_rule =
        db.list_project_deployments(&project.id)?
            .into_iter()
            .any(|d| {
                d.detached_at.is_none()
                    && d.git_exclude_ref.as_deref() == Some(exclude_ref)
                    && !(d.target == target && d.directory == directory)
            });

    if same_project_still_uses_rule {
        // 只保留其他路径；当前 (target, directory) 对应规则行仍可安全移除
    }

    let existing = fs::read_to_string(&exclude_path).unwrap_or_default();
    let updated = update_exclude_content(&existing, &project.id, &rule_line, false);
    if updated != existing {
        atomic_write_file_verified(&exclude_path, updated.as_bytes(), None, false)?;
    }
    Ok(())
}

/// 在彻底移除项目时移除该项目在对应 `info/exclude` 中的整个 `# mskills:begin/end project=<id>` 托管块。
pub fn purge_project_git_exclude_block(project: &ProjectRecord) -> Result<()> {
    let project_root = Path::new(&project.root_path);
    let Some(repo) = inspect_git_repo(project_root)? else {
        return Ok(());
    };
    if !repo.exclude_path.exists() {
        return Ok(());
    }
    let lock = exclude_file_lock(&repo.exclude_path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let existing = fs::read_to_string(&repo.exclude_path).unwrap_or_default();
    let (begin_marker, end_marker) = block_markers(&project.id);
    if !existing.contains(&begin_marker) {
        return Ok(());
    }
    let line_ending = if existing.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut kept = Vec::new();
    let mut inside = false;
    for raw in existing.lines() {
        let trimmed = raw.trim_end_matches('\r');
        if !inside && trimmed == begin_marker {
            inside = true;
            continue;
        }
        if inside {
            if trimmed == end_marker {
                inside = false;
            }
            continue;
        }
        kept.push(trimmed.to_string());
    }
    let updated = if kept.is_empty() {
        String::new()
    } else {
        let mut s = kept.join(line_ending);
        s.push_str(line_ending);
        s
    };
    if updated != existing {
        atomic_write_file_verified(&repo.exclude_path, updated.as_bytes(), None, false)?;
    }
    Ok(())
}
