//! 文件系统安全原语与树指纹工具
//!
//! 为项目级 Skills & Rules 工作区提供：
//! - 无损平台文件/目录身份捕获（Unix `dev`/`ino`、Windows 卷序列号 + File ID）
//! - 不跨越 symlink 的父链句柄校验（`openat(..., O_NOFOLLOW)` / Windows Reparse Point 检查）
//! - 原子且不覆盖目标的 `rename_noreplace`（`renameatx_np` / `renameat2` / Win32 `FileRenameInfo`）
//! - 严格的技能目录名与树内容校验（含隐藏文件、空目录、权限位、禁止内含 symlink/特殊文件）
//! - 完整的技能树指纹计算 `compute_skill_tree_fingerprint`

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::app_config::AppType;
use crate::config::get_app_config_dir;
use crate::services::skill::SkillService;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FsIdentity {
    Unix {
        dev: String,
        ino: String,
    },
    Windows {
        volume_serial: String,
        file_index: String,
    },
}

impl FsIdentity {
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(self).map_err(|e| anyhow!("序列化 FsIdentity 失败: {e}"))
    }

    pub fn from_json(raw: &str) -> Result<Self> {
        serde_json::from_str(raw).map_err(|e| anyhow!("反序列化 FsIdentity 失败: {e}"))
    }
}

/// 校验单个路径段是否可跨平台安全作为目录名或文件名使用。
pub fn validate_safe_segment(segment: &str) -> Result<()> {
    if segment.is_empty() || segment == "." || segment == ".." {
        bail!("非法路径段: {segment:?}");
    }
    if segment.contains('/') || segment.contains('\\') || segment.contains('\0') {
        bail!("路径段包含目录分隔符或 NUL 字符: {segment:?}");
    }
    if segment.chars().any(|c| c.is_control()) {
        bail!("路径段包含控制字符: {segment:?}");
    }
    if segment
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
    {
        bail!("路径段包含跨平台保留字符: {segment:?}");
    }
    if segment.ends_with(' ') || segment.ends_with('.') {
        bail!("路径段不能以空格或点结尾: {segment:?}");
    }
    let stem = segment.split('.').next().unwrap_or(segment);
    let upper = stem.to_ascii_uppercase();
    let is_reserved = matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    if is_reserved {
        bail!("路径段命中 Windows 保留设备名: {segment:?}");
    }
    Ok(())
}

/// 校验 Skill 目录名（复用 `require_valid_directory` 并叠加跨平台命名约束）。
pub fn validate_skill_directory_name(directory: &str) -> Result<String> {
    let valid = SkillService::require_valid_directory(directory)?;
    validate_safe_segment(&valid)?;
    Ok(valid)
}

/// 检查路径是否存在且自身是符号链接（不跟随链接目标）。
pub fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// 捕获路径自身的文件系统身份（不跟随最后一段 symlink；若是 symlink 则返回错误）。
pub fn capture_fs_identity_nofollow(path: &Path) -> Result<FsIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::symlink_metadata(path)
            .with_context(|| format!("读取文件系统元数据失败: {}", path.display()))?;
        if meta.file_type().is_symlink() {
            bail!(
                "目标路径是符号链接，拒绝按实目录捕获身份: {}",
                path.display()
            );
        }
        Ok(FsIdentity::Unix {
            dev: meta.dev().to_string(),
            ino: meta.ino().to_string(),
        })
    }
    #[cfg(windows)]
    {
        windows_impl::capture_identity(path, true)
    }
}

/// 捕获路径的文件系统身份（跟随 symlink，用于记录真实项目根目录身份）。
pub fn capture_fs_identity_follow(path: &Path) -> Result<FsIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::metadata(path)
            .with_context(|| format!("读取目录元数据失败: {}", path.display()))?;
        Ok(FsIdentity::Unix {
            dev: meta.dev().to_string(),
            ino: meta.ino().to_string(),
        })
    }
    #[cfg(windows)]
    {
        windows_impl::capture_identity(path, false)
    }
}

/// 校验项目根目录（或任意目录）不与 SSOT 及所有已支持的全局 App Skills 目录重叠或形成软链别名。
pub fn ensure_path_not_overlapping_global_roots(candidate: &Path) -> Result<()> {
    let ssot = SkillService::resolve_ssot_dir_no_create();
    if SkillService::paths_overlap(candidate, &ssot) {
        bail!(
            "路径与全球 Skill 存储目录（SSOT）重叠或包含软链别名: {} vs {}",
            candidate.display(),
            ssot.display()
        );
    }
    for app in AppType::all() {
        if let Ok(app_dir) = SkillService::get_app_skills_dir(&app) {
            if SkillService::paths_overlap(candidate, &app_dir) {
                bail!(
                    "路径与 {:?} 的全局 Skills 目录重叠: {} vs {}",
                    app,
                    candidate.display(),
                    app_dir.display()
                );
            }
        }
    }
    Ok(())
}

/// 校验以 `anchor` 为起点的一串相对路径组件全程不经过预置 symlink，必要时逐级创建目录。
pub fn verify_relative_chain_no_symlinks(
    anchor: &Path,
    relative_dirs: &[&str],
    create_missing: bool,
) -> Result<()> {
    for seg in relative_dirs {
        validate_safe_segment(seg)?;
    }

    #[cfg(unix)]
    {
        unix_impl::verify_relative_chain_no_symlinks(anchor, relative_dirs, create_missing)
    }
    #[cfg(windows)]
    {
        windows_impl::verify_relative_chain_no_symlinks(anchor, relative_dirs, create_missing)
    }
}

/// 原子且不覆盖目标的同文件系统重命名。
/// 若目标路径已存在（无论普通文件、目录还是 symlink），必须返回错误而不可覆盖。
pub fn rename_noreplace(src: &Path, dst: &Path) -> Result<()> {
    if src == dst {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        unix_impl::macos_rename_noreplace(src, dst)
    }
    #[cfg(target_os = "linux")]
    {
        unix_impl::linux_rename_noreplace(src, dst)
    }
    #[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
    {
        // Fallback for other Unix: POSIX link/rename doesn't have dir noreplace; verify no dest
        if fs::symlink_metadata(dst).is_ok() {
            bail!("目标路径已存在: {}", dst.display());
        }
        fs::rename(src, dst)
            .with_context(|| format!("重命名失败: {} -> {}", src.display(), dst.display()))
    }
    #[cfg(windows)]
    {
        windows_impl::rename_noreplace(src, dst)
    }
}

/// 返回用于全局 SSOT 操作的私有暂存根目录（同挂载点且位于 Client 发现目录之外）。
pub fn get_ssot_staging_root() -> Result<PathBuf> {
    let ssot = SkillService::resolve_ssot_dir_no_create();
    let parent = ssot
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(get_app_config_dir);
    let root = parent.join(".mskills-staging");
    fs::create_dir_all(&root)?;
    Ok(root)
}

/// 返回项目目标下的私有暂存根目录（同挂载点且位于 `.agents/skills/`、`.claude/skills/` 之外）。
pub fn get_project_staging_root(project_root: &Path, target: &str) -> Result<PathBuf> {
    let target_parent = match target {
        "agents" => ".agents",
        "claude" => ".claude",
        other => bail!("未知的部署目标: {other}"),
    };
    verify_relative_chain_no_symlinks(project_root, &[target_parent], true)?;
    let root = project_root.join(target_parent).join(".mskills-stage");
    verify_relative_chain_no_symlinks(project_root, &[target_parent, ".mskills-stage"], true)?;
    Ok(root)
}

#[derive(Debug, Clone)]
enum CollectedEntry {
    Dir,
    File {
        len: u64,
        mode: u32,
        abs_path: PathBuf,
    },
}

fn collect_validated_skill_entries(root: &Path) -> Result<BTreeMap<String, CollectedEntry>> {
    let root_meta = fs::symlink_metadata(root)
        .with_context(|| format!("读取 Skill 根目录失败: {}", root.display()))?;
    if root_meta.file_type().is_symlink() || !root_meta.is_dir() {
        bail!(
            "Skill 根目录必须是真实目录（不能是符号链接）: {}",
            root.display()
        );
    }

    let mut entries = BTreeMap::new();
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];

    while let Some((current_dir, rel_prefix)) = stack.pop() {
        let read_dir = fs::read_dir(&current_dir)
            .with_context(|| format!("遍历目录失败: {}", current_dir.display()))?;
        for entry_res in read_dir {
            let entry =
                entry_res.with_context(|| format!("读取目录项失败: {}", current_dir.display()))?;
            let os_name = entry.file_name();
            let name = os_name
                .to_str()
                .ok_or_else(|| anyhow!("Skill 内存在非 UTF-8 文件名: {}", current_dir.display()))?;
            validate_safe_segment(name)?;

            let child_path = entry.path();
            let meta = fs::symlink_metadata(&child_path)
                .with_context(|| format!("读取元数据失败: {}", child_path.display()))?;
            let ft = meta.file_type();
            if ft.is_symlink() {
                bail!("Skill 目录内禁止存在符号链接: {}", child_path.display());
            }

            let rel_path = if rel_prefix.is_empty() {
                name.to_string()
            } else {
                format!("{rel_prefix}/{name}")
            };

            if ft.is_dir() {
                entries.insert(rel_path.clone(), CollectedEntry::Dir);
                stack.push((child_path, rel_path));
            } else if ft.is_file() {
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::PermissionsExt;
                    meta.permissions().mode() & 0o777
                };
                #[cfg(not(unix))]
                let mode = 0o644;
                entries.insert(
                    rel_path,
                    CollectedEntry::File {
                        len: meta.len(),
                        mode,
                        abs_path: child_path,
                    },
                );
            } else {
                bail!(
                    "Skill 目录内包含不支持的特殊文件类型: {}",
                    child_path.display()
                );
            }
        }
    }

    if !matches!(entries.get("SKILL.md"), Some(CollectedEntry::File { .. })) {
        bail!("Skill 目录缺少合法的 SKILL.md 文件: {}", root.display());
    }

    Ok(entries)
}

/// 校验 Skill 目录结构合法（实目录、有 `SKILL.md`、无 symlink/特殊文件/非法路径段）。
pub fn validate_skill_tree(root: &Path) -> Result<()> {
    let _ = collect_validated_skill_entries(root)?;
    Ok(())
}

/// 计算 Skill 完整目录树的内容指纹（`v1:<platform>:<sha256>`）。
///
/// 包含完整相对路径、隐藏文件、空目录、文件内容及平台权限位，
/// 并拒绝内部 symlink、特殊文件与非法文件名。
pub fn compute_skill_tree_fingerprint(dir: &Path) -> Result<String> {
    let entries = collect_validated_skill_entries(dir)?;
    let profile = if cfg!(unix) { "unix-mode" } else { "win-basic" };

    let mut hasher = Sha256::new();
    hasher.update(b"mskills-tree-v1\0");
    hasher.update(profile.as_bytes());
    hasher.update(b"\0");

    let mut buf = [0u8; 64 * 1024];
    for (rel_path, entry) in entries {
        match entry {
            CollectedEntry::Dir => {
                hasher.update(b"D");
                hasher.update((rel_path.len() as u64).to_le_bytes());
                hasher.update(rel_path.as_bytes());
            }
            CollectedEntry::File {
                len,
                mode,
                abs_path,
            } => {
                hasher.update(b"F");
                hasher.update((rel_path.len() as u64).to_le_bytes());
                hasher.update(rel_path.as_bytes());
                hasher.update(mode.to_le_bytes());
                hasher.update(len.to_le_bytes());
                let mut file = fs::File::open(&abs_path)
                    .with_context(|| format!("打开文件计算指纹失败: {}", abs_path.display()))?;
                loop {
                    let read = file
                        .read(&mut buf)
                        .with_context(|| format!("读取文件失败: {}", abs_path.display()))?;
                    if read == 0 {
                        break;
                    }
                    hasher.update(&buf[..read]);
                }
            }
        }
    }

    Ok(format!("v1:{profile}:{:x}", hasher.finalize()))
}

/// 将已校验的 Skill 树完整复制到 `dst_dir`（保留隐藏文件、空目录和 Unix 权限位），并返回复制后指纹。
pub fn copy_validated_skill_tree(src_dir: &Path, dst_dir: &Path) -> Result<String> {
    let entries = collect_validated_skill_entries(src_dir)?;
    if fs::symlink_metadata(dst_dir).is_ok() {
        bail!("暂存或复制目标已存在: {}", dst_dir.display());
    }
    fs::create_dir_all(dst_dir)
        .with_context(|| format!("创建目标目录失败: {}", dst_dir.display()))?;

    let result = (|| -> Result<String> {
        for (rel_path, entry) in &entries {
            let mut target = dst_dir.to_path_buf();
            for comp in rel_path.split('/') {
                target.push(comp);
            }
            match entry {
                CollectedEntry::Dir => {
                    fs::create_dir_all(&target)?;
                }
                CollectedEntry::File {
                    #[cfg(unix)]
                    mode,
                    abs_path,
                    ..
                } => {
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::copy(abs_path, &target).with_context(|| {
                        format!(
                            "复制文件失败: {} -> {}",
                            abs_path.display(),
                            target.display()
                        )
                    })?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(&target, fs::Permissions::from_mode(*mode))?;
                    }
                }
            }
        }
        compute_skill_tree_fingerprint(dst_dir)
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(dst_dir);
    }
    result
}

/// 安全移除一个路径（若为 symlink 仅移除链接本身；若为目录移除整棵目录树）。
pub fn remove_path_any(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                #[cfg(windows)]
                {
                    fs::remove_dir(path)
                        .or_else(|_| fs::remove_file(path))
                        .with_context(|| format!("移除符号链接失败: {}", path.display()))?;
                }
                #[cfg(not(windows))]
                {
                    fs::remove_file(path)
                        .with_context(|| format!("移除符号链接失败: {}", path.display()))?;
                }
            } else if meta.is_dir() {
                fs::remove_dir_all(path)
                    .with_context(|| format!("移除目录失败: {}", path.display()))?;
            } else {
                fs::remove_file(path)
                    .with_context(|| format!("移除文件失败: {}", path.display()))?;
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// 原子切换已暂存的新目录树（或 symlink）到目标路径，并把原有目标备份到 `backup_path`。
///
/// 在移动前会重新核验 `expected_existing_hash`（针对现有实目录）或目标缺失状态，
/// 避免 TOCTOU 竞态静默覆盖用户/外部刚写入的内容。
pub fn swap_staged_with_verified_backup(
    staged_path: &Path,
    dest_path: &Path,
    backup_path: Option<&Path>,
    expected_existing_hash: Option<&str>,
) -> Result<bool> {
    let dest_exists = match fs::symlink_metadata(dest_path) {
        Ok(meta) => {
            if expected_existing_hash.is_some() {
                if meta.file_type().is_symlink() || !meta.is_dir() {
                    bail!(
                        "目标位置状态已变化（非实目录），取消覆盖: {}",
                        dest_path.display()
                    );
                }
                let actual_hash = compute_skill_tree_fingerprint(dest_path)?;
                if Some(actual_hash.as_str()) != expected_existing_hash {
                    bail!(
                        "目标目录在操作期间发生外部修改，已中止覆盖以防数据丢失: {}",
                        dest_path.display()
                    );
                }
            }
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if expected_existing_hash.is_some() {
                bail!("期望替换的目标目录已消失: {}", dest_path.display());
            }
            false
        }
        Err(e) => return Err(e.into()),
    };

    if dest_exists {
        let backup = backup_path.ok_or_else(|| {
            anyhow!(
                "目标已存在但未提供备份路径，拒绝直接覆盖: {}",
                dest_path.display()
            )
        })?;
        if let Some(parent) = backup.parent() {
            fs::create_dir_all(parent)?;
        }
        rename_noreplace(dest_path, backup)?;
        if let Err(err) = rename_noreplace(staged_path, dest_path) {
            let _ = rename_noreplace(backup, dest_path);
            return Err(err);
        }
        Ok(true)
    } else {
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)?;
        }
        rename_noreplace(staged_path, dest_path)?;
        Ok(false)
    }
}

/// 原子写入文本文件：同目录写临时文件 + `sync_all` + 核对当前身份后替换。
pub fn atomic_write_file_verified(
    path: &Path,
    bytes: &[u8],
    expected_identity: Option<&FsIdentity>,
    must_not_exist: bool,
) -> Result<FsIdentity> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                bail!("拒绝写入符号链接文件: {}", path.display());
            }
            if must_not_exist {
                bail!("文件已由外部并发创建，请刷新后重试: {}", path.display());
            }
            if let Some(expected) = expected_identity {
                let current = capture_fs_identity_nofollow(path)?;
                if &current != expected {
                    bail!("文件在保存前被外部替换，请重新加载: {}", path.display());
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if expected_identity.is_some() {
                bail!("文件在保存前已被外部删除，请重新加载: {}", path.display());
            }
        }
        Err(e) => return Err(e.into()),
    }

    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("文件路径缺少父目录: {}", path.display()))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    std::io::Write::write_all(&mut temp, bytes)?;
    temp.as_file().sync_all()?;

    if must_not_exist {
        let temp_path = temp.into_temp_path();
        rename_noreplace(&temp_path, path)?;
    } else {
        temp.persist(path)
            .map_err(|e| anyhow!("原子替换文件失败 ({}): {}", path.display(), e.error))?;
    }

    capture_fs_identity_nofollow(path)
}

/// 创建目录软链（或相对软链）。
#[cfg(unix)]
pub fn create_dir_symlink(target: &Path, link_path: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, link_path).with_context(|| {
        format!(
            "创建符号链接失败: {} -> {}",
            link_path.display(),
            target.display()
        )
    })
}

#[cfg(windows)]
pub fn create_dir_symlink(target: &Path, link_path: &Path) -> Result<()> {
    std::os::windows::fs::symlink_dir(target, link_path).with_context(|| {
        format!(
            "创建符号链接失败: {} -> {}",
            link_path.display(),
            target.display()
        )
    })
}

/// 解析符号链接（若为相对路径则相对 `link_path` 父目录解析规范化路径）。
pub fn resolve_symlink_target_canonical(link_path: &Path) -> Result<PathBuf> {
    let raw_target = fs::read_link(link_path)
        .with_context(|| format!("读取符号链接目标失败: {}", link_path.display()))?;
    let joined = if raw_target.is_absolute() {
        raw_target
    } else {
        link_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(raw_target)
    };
    joined
        .canonicalize()
        .with_context(|| format!("符号链接目标不可达（断链）: {}", link_path.display()))
}

#[cfg(unix)]
mod unix_impl {
    use super::*;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::{FromRawFd, OwnedFd};

    fn to_cstring(path: &Path) -> Result<CString> {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| anyhow!("路径包含 NUL 字节: {}", path.display()))
    }

    fn open_dir_nofollow_at(dirfd: libc::c_int, seg: &str) -> std::io::Result<OwnedFd> {
        let c_seg = CString::new(seg.as_bytes())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in name"))?;
        let fd = unsafe {
            libc::openat(
                dirfd,
                c_seg.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(unsafe { OwnedFd::from_raw_fd(fd) })
        }
    }

    pub fn verify_relative_chain_no_symlinks(
        anchor: &Path,
        relative_dirs: &[&str],
        create_missing: bool,
    ) -> Result<()> {
        let c_anchor = to_cstring(anchor)?;
        let root_fd = unsafe {
            libc::open(
                c_anchor.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if root_fd < 0 {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("无法打开根锚点目录: {}", anchor.display()));
        }
        let mut current = unsafe { OwnedFd::from_raw_fd(root_fd) };

        for seg in relative_dirs {
            use std::os::unix::io::AsRawFd;
            match open_dir_nofollow_at(current.as_raw_fd(), seg) {
                Ok(next) => {
                    current = next;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && create_missing => {
                    let c_seg = CString::new(seg.as_bytes()).map_err(|_| anyhow!("非法目录段"))?;
                    let rc = unsafe { libc::mkdirat(current.as_raw_fd(), c_seg.as_ptr(), 0o755) };
                    if rc != 0 {
                        let mkdir_err = std::io::Error::last_os_error();
                        if mkdir_err.kind() != std::io::ErrorKind::AlreadyExists {
                            return Err(mkdir_err)
                                .with_context(|| format!("创建子目录失败: {seg}"));
                        }
                    }
                    current =
                        open_dir_nofollow_at(current.as_raw_fd(), seg).with_context(|| {
                            format!(
                                "校验新创建子目录失败（可能是并发符号链接攻击）: {}/{}",
                                anchor.display(),
                                seg
                            )
                        })?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(());
                }
                Err(e) => {
                    bail!(
                        "路径链校验失败（禁止跨越符号链接或非目录节点） {}/{}: {}",
                        anchor.display(),
                        seg,
                        e
                    );
                }
            }
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub fn macos_rename_noreplace(src: &Path, dst: &Path) -> Result<()> {
        let c_src = to_cstring(src)?;
        let c_dst = to_cstring(dst)?;
        // RENAME_EXCL = 0x00000004 on macOS
        const RENAME_EXCL_FLAG: libc::c_uint = 0x00000004;
        let rc = unsafe {
            libc::renameatx_np(
                libc::AT_FDCWD,
                c_src.as_ptr(),
                libc::AT_FDCWD,
                c_dst.as_ptr(),
                RENAME_EXCL_FLAG,
            )
        };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            return Err(err).with_context(|| {
                format!(
                    "renameatx_np(RENAME_EXCL) 失败: {} -> {}",
                    src.display(),
                    dst.display()
                )
            });
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub fn linux_rename_noreplace(src: &Path, dst: &Path) -> Result<()> {
        let c_src = to_cstring(src)?;
        let c_dst = to_cstring(dst)?;
        const RENAME_NOREPLACE_FLAG: libc::c_uint = 1;
        let rc = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                c_src.as_ptr(),
                libc::AT_FDCWD,
                c_dst.as_ptr(),
                RENAME_NOREPLACE_FLAG,
            )
        };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            return Err(err).with_context(|| {
                format!(
                    "renameat2(RENAME_NOREPLACE) 失败: {} -> {}",
                    src.display(),
                    dst.display()
                )
            });
        }
        Ok(())
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileRenameInfo, GetFileInformationByHandle, SetFileInformationByHandle,
        BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_RENAME_INFO,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    struct HandleGuard(HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            if self.0 != INVALID_HANDLE_VALUE && !self.0.is_null() {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    fn to_wide_null(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn open_handle(
        path: &Path,
        desired_access: u32,
        open_reparse_point: bool,
    ) -> Result<HandleGuard> {
        let wide = to_wide_null(path.as_os_str());
        let mut flags = FILE_FLAG_BACKUP_SEMANTICS;
        if open_reparse_point {
            flags |= FILE_FLAG_OPEN_REPARSE_POINT;
        }
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                desired_access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                flags,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("打开文件句柄失败: {}", path.display()));
        }
        Ok(HandleGuard(handle))
    }

    pub fn capture_identity(path: &Path, nofollow: bool) -> Result<FsIdentity> {
        let guard = open_handle(path, 0, nofollow)?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe { GetFileInformationByHandle(guard.0, &mut info) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("读取文件句柄信息失败: {}", path.display()));
        }
        if nofollow && (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0) {
            bail!("目标路径是符号链接/重解析点: {}", path.display());
        }
        let file_index = ((info.nFileIndexHigh as u64) << 32) | (info.nFileIndexLow as u64);
        Ok(FsIdentity::Windows {
            volume_serial: info.dwVolumeSerialNumber.to_string(),
            file_index: file_index.to_string(),
        })
    }

    pub fn verify_relative_chain_no_symlinks(
        anchor: &Path,
        relative_dirs: &[&str],
        create_missing: bool,
    ) -> Result<()> {
        let mut cur = anchor.to_path_buf();
        for seg in relative_dirs {
            cur.push(seg);
            match fs::symlink_metadata(&cur) {
                Ok(meta) => {
                    if meta.file_type().is_symlink() || !meta.is_dir() {
                        bail!("路径链中包含符号链接或非目录节点: {}", cur.display());
                    }
                    let _ = capture_identity(&cur, true)?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if create_missing {
                        fs::create_dir(&cur)
                            .or_else(|e2| {
                                if e2.kind() == std::io::ErrorKind::AlreadyExists {
                                    Ok(())
                                } else {
                                    Err(e2)
                                }
                            })
                            .with_context(|| format!("创建子目录失败: {}", cur.display()))?;
                        let _ = capture_identity(&cur, true)?;
                    } else {
                        return Ok(());
                    }
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }

    pub fn rename_noreplace(src: &Path, dst: &Path) -> Result<()> {
        let guard = open_handle(src, DELETE, true)?;
        let dst_wide = to_wide_null(dst.as_os_str());
        let name_bytes = (dst_wide.len() - 1) * std::mem::size_of::<u16>();
        let header_size = std::mem::size_of::<FILE_RENAME_INFO>();
        let total_size = header_size + name_bytes;
        let mut buf = vec![0u8; total_size];

        unsafe {
            let info_ptr = buf.as_mut_ptr() as *mut FILE_RENAME_INFO;
            (*info_ptr).Anonymous.ReplaceIfExists = false;
            (*info_ptr).RootDirectory = std::ptr::null_mut();
            (*info_ptr).FileNameLength = name_bytes as u32;
            std::ptr::copy_nonoverlapping(
                dst_wide.as_ptr(),
                (*info_ptr).FileName.as_mut_ptr(),
                dst_wide.len(),
            );
            let ok = SetFileInformationByHandle(
                guard.0,
                FileRenameInfo,
                buf.as_ptr() as *const _,
                total_size as u32,
            );
            if ok == 0 {
                return Err(std::io::Error::last_os_error()).with_context(|| {
                    format!(
                        "SetFileInformationByHandle(FileRenameInfo) 失败: {} -> {}",
                        src.display(),
                        dst.display()
                    )
                });
            }
        }
        Ok(())
    }
}
