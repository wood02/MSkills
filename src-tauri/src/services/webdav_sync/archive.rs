use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tempfile::{tempdir, TempDir};
use zip::write::SimpleFileOptions;
use zip::DateTime;

use crate::app_config::InstalledSkill;
use crate::error::AppError;
use crate::services::project::fs_safety::compute_skill_tree_fingerprint;
use crate::services::skill::SkillService;

use crate::services::sync_protocol::{
    io_context_localized, localized, MAX_SYNC_ARTIFACT_BYTES, REMOTE_SKILLS_ZIP,
};

/// Maximum number of entries allowed in a zip archive.
///
/// skills.zip 打包的是用户已安装的全部技能，单个大型技能（如 ppt-master，13k+ 文件）
/// 就能超过原来的 10_000；与 `services/skill.rs` 的 `MAX_ARCHIVE_ENTRIES` 保持一致，
/// 否则技能装得上、同步却恢复不了。字节上限 `MAX_SYNC_ARTIFACT_BYTES` 仍然兜底。
const MAX_EXTRACT_ENTRIES: usize = 30_000;
pub(crate) const SKILLS_ARCHIVE_MANIFEST_NAME: &str = ".mskills-skills-manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillsArchiveManifest {
    pub format_version: u32,
    pub skills: Vec<SkillsArchiveEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillsArchiveEntry {
    pub directory: String,
    pub installation_id: String,
    pub fingerprint: String,
}

pub(crate) struct SkillsBackup {
    _tmp: TempDir,
    backup_dir: PathBuf,
    ssot_path: PathBuf,
    existed: bool,
}

fn is_root_scratch_entry(name: &str) -> bool {
    name == ".DS_Store"
        || name == SKILLS_ARCHIVE_MANIFEST_NAME
        || name.starts_with(".mskills-staging")
        || name.starts_with(".mskills-stage")
}

pub(crate) fn zip_skills_ssot_with_manifest(
    dest_path: &Path,
    installed_skills: &[InstalledSkill],
) -> Result<(), AppError> {
    let source = SkillService::get_ssot_dir().map_err(|e| {
        localized(
            "webdav.sync.skills_ssot_dir_failed",
            format!("获取 Skills SSOT 目录失败: {e}"),
            format!("Failed to resolve Skills SSOT directory: {e}"),
        )
    })?;
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    }

    let id_by_dir: BTreeMap<&str, &str> = installed_skills
        .iter()
        .map(|s| (s.directory.as_str(), s.installation_id.as_str()))
        .collect();

    let file = fs::File::create(dest_path).map_err(|e| AppError::io(dest_path, e))?;
    let mut writer = zip::ZipWriter::new(file);
    let base_options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(DateTime::default());

    let mut manifest_entries = Vec::new();
    if source.exists() {
        let canonical_root = fs::canonicalize(&source).unwrap_or_else(|_| source.clone());
        let mut visited = HashSet::new();
        mark_visited_dir(&canonical_root, &mut visited)?;

        let mut top_entries: Vec<_> = fs::read_dir(&canonical_root)
            .map_err(|e| AppError::io(&canonical_root, e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::io(&canonical_root, e))?;
        top_entries.sort_by_key(|e| e.file_name());

        for entry in top_entries {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if is_root_scratch_entry(&name_str) {
                continue;
            }
            let entry_path = entry.path();
            let meta =
                fs::symlink_metadata(&entry_path).map_err(|e| AppError::io(&entry_path, e))?;
            if meta.file_type().is_symlink() {
                return Err(localized(
                    "webdav.sync.symlink_in_ssot",
                    format!("Skills 存储目录顶层包含不允许的符号链接: {name_str}"),
                    format!("Skills SSOT root contains disallowed symlink: {name_str}"),
                ));
            }
            if !meta.is_dir() {
                continue;
            }
            if let Some(&inst_id) = id_by_dir.get(name_str.as_ref()) {
                let fp = compute_skill_tree_fingerprint(&entry_path).map_err(|e| {
                    localized(
                        "webdav.sync.skill_tree_invalid",
                        format!("Skill {name_str} 内容校验失败，无法打包同步: {e}"),
                        format!("Skill {name_str} validation failed, cannot pack: {e}"),
                    )
                })?;
                manifest_entries.push(SkillsArchiveEntry {
                    directory: name_str.to_string(),
                    installation_id: inst_id.to_string(),
                    fingerprint: fp,
                });
            }

            let rel_str = name_str.to_string();
            writer
                .add_directory(format!("{rel_str}/"), base_options)
                .map_err(|e| {
                    localized(
                        "webdav.sync.zip_add_directory_failed",
                        format!("写入 ZIP 目录失败: {e}"),
                        format!("Failed to write ZIP directory entry: {e}"),
                    )
                })?;
            let real_dir =
                fs::canonicalize(&entry_path).map_err(|e| AppError::io(&entry_path, e))?;
            let _ = mark_visited_dir(&real_dir, &mut visited)?;
            zip_dir_recursive(
                &canonical_root,
                &real_dir,
                &mut writer,
                base_options,
                &mut visited,
            )?;
        }
    }

    if !manifest_entries.is_empty() {
        let manifest = SkillsArchiveManifest {
            format_version: 1,
            skills: manifest_entries,
        };
        let bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| AppError::JsonSerialize { source: e })?;
        writer
            .start_file(SKILLS_ARCHIVE_MANIFEST_NAME, base_options)
            .map_err(|e| {
                localized(
                    "webdav.sync.zip_start_file_failed",
                    format!("写入 ZIP manifest 失败: {e}"),
                    format!("Failed to start ZIP manifest entry: {e}"),
                )
            })?;
        writer.write_all(&bytes).map_err(|e| {
            localized(
                "webdav.sync.zip_write_file_failed",
                format!("写入 ZIP manifest 内容失败: {e}"),
                format!("Failed to write ZIP manifest content: {e}"),
            )
        })?;
    }

    writer.finish().map_err(|e| {
        localized(
            "webdav.sync.skills_zip_write_failed",
            format!("写入 skills.zip 失败: {e}"),
            format!("Failed to write skills.zip: {e}"),
        )
    })?;
    Ok(())
}

pub(crate) fn restore_skills_zip_verified(
    raw: &[u8],
    expected_skills: Option<&[InstalledSkill]>,
) -> Result<(), AppError> {
    let tmp = tempdir().map_err(|e| {
        io_context_localized(
            "webdav.sync.skills_extract_tmpdir_failed",
            "创建 skills 解压临时目录失败",
            "Failed to create temporary directory for skills extraction",
            e,
        )
    })?;
    let zip_path = tmp.path().join(REMOTE_SKILLS_ZIP);
    fs::write(&zip_path, raw).map_err(|e| AppError::io(&zip_path, e))?;

    let file = fs::File::open(&zip_path).map_err(|e| AppError::io(&zip_path, e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        localized(
            "webdav.sync.skills_zip_parse_failed",
            format!("解析 skills.zip 失败: {e}"),
            format!("Failed to parse skills.zip: {e}"),
        )
    })?;

    let extracted = tmp.path().join("skills-extracted");
    fs::create_dir_all(&extracted).map_err(|e| AppError::io(&extracted, e))?;

    if archive.len() > MAX_EXTRACT_ENTRIES {
        return Err(localized(
            "webdav.sync.skills_zip_too_many_entries",
            format!(
                "skills.zip 条目数过多（{}），上限 {MAX_EXTRACT_ENTRIES}",
                archive.len()
            ),
            format!(
                "skills.zip has too many entries ({}), limit is {MAX_EXTRACT_ENTRIES}",
                archive.len()
            ),
        ));
    }

    let mut total_bytes: u64 = 0;
    let mut embedded_manifest: Option<SkillsArchiveManifest> = None;

    for idx in 0..archive.len() {
        let mut entry = archive.by_index(idx).map_err(|e| {
            localized(
                "webdav.sync.skills_zip_entry_read_failed",
                format!("读取 ZIP 项失败: {e}"),
                format!("Failed to read ZIP entry: {e}"),
            )
        })?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            // S_IFMT = 0o170000, S_IFLNK = 0o120000
            if (mode & 0o170000) == 0o120000 {
                return Err(localized(
                    "webdav.sync.symlink_in_zip",
                    format!("skills.zip 包含禁止的符号链接条目: {}", entry.name()),
                    format!(
                        "skills.zip contains disallowed symlink entry: {}",
                        entry.name()
                    ),
                ));
            }
        }
        let Some(safe_name) = entry.enclosed_name() else {
            continue;
        };

        if safe_name == Path::new(SKILLS_ARCHIVE_MANIFEST_NAME) && !entry.is_dir() {
            let mut buf = Vec::new();
            let mut limited = (&mut entry).take(1024 * 1024);
            limited.read_to_end(&mut buf).map_err(|e| {
                localized(
                    "webdav.sync.skills_zip_entry_read_failed",
                    format!("读取 ZIP manifest 失败: {e}"),
                    format!("Failed to read ZIP manifest: {e}"),
                )
            })?;
            let parsed: SkillsArchiveManifest = serde_json::from_slice(&buf).map_err(|e| {
                localized(
                    "webdav.sync.skills_manifest_invalid",
                    format!("skills.zip 内置校验清单无效: {e}"),
                    format!("Invalid skills.zip manifest: {e}"),
                )
            })?;
            embedded_manifest = Some(parsed);
            continue;
        }

        let out_path = extracted.join(&safe_name);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| AppError::io(&out_path, e))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
        }
        let mut out = fs::File::create(&out_path).map_err(|e| AppError::io(&out_path, e))?;
        let _written = copy_entry_with_total_limit(
            &mut entry,
            &mut out,
            &mut total_bytes,
            MAX_SYNC_ARTIFACT_BYTES,
            &out_path,
        )?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let clean_mode = mode & 0o777;
            if clean_mode != 0 {
                let _ = fs::set_permissions(&out_path, fs::Permissions::from_mode(clean_mode));
            }
        }
    }

    // Reject unmanaged top-level entries or manifest/installation_id mismatches when DB skills provided
    if let Some(expected) = expected_skills {
        let expected_by_dir: BTreeMap<&str, &InstalledSkill> =
            expected.iter().map(|s| (s.directory.as_str(), s)).collect();

        for entry in fs::read_dir(&extracted).map_err(|e| AppError::io(&extracted, e))? {
            let entry = entry.map_err(|e| AppError::io(&extracted, e))?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if is_root_scratch_entry(&name_str) {
                let _ = crate::services::project::fs_safety::remove_path_any(&entry.path());
                continue;
            }
            if !entry.path().is_dir() || !expected_by_dir.contains_key(name_str.as_ref()) {
                return Err(localized(
                    "webdav.sync.unmanaged_root_entry",
                    format!("skills.zip 顶层存在未登记在数据库中的项: {name_str}"),
                    format!("skills.zip contains unmanaged top-level entry: {name_str}"),
                ));
            }
        }

        if let Some(manifest) = embedded_manifest.as_ref() {
            let mut manifest_map: BTreeMap<&str, &SkillsArchiveEntry> = BTreeMap::new();
            for item in &manifest.skills {
                manifest_map.insert(item.directory.as_str(), item);
            }
            for (dir, skill) in &expected_by_dir {
                let skill_dir = extracted.join(dir);
                if skill_dir.exists() {
                    if let Some(m) = manifest_map.get(dir) {
                        if !skill.installation_id.is_empty()
                            && !m.installation_id.is_empty()
                            && m.installation_id != skill.installation_id
                        {
                            return Err(localized(
                                "webdav.sync.installation_id_mismatch",
                                format!("Skill {dir} 的 installation_id 与数据库快照不匹配"),
                                format!("Skill {dir} installation_id mismatch against DB snapshot"),
                            ));
                        }
                        let actual_fp =
                            compute_skill_tree_fingerprint(&skill_dir).map_err(|e| {
                                localized(
                                    "webdav.sync.skill_tree_invalid",
                                    format!("解压后的 Skill {dir} 校验失败: {e}"),
                                    format!("Extracted Skill {dir} validation failed: {e}"),
                                )
                            })?;
                        if actual_fp != m.fingerprint {
                            return Err(localized(
                                "webdav.sync.skill_fingerprint_mismatch",
                                format!("Skill {dir} 的目录树指纹与包体清单不匹配"),
                                format!("Skill {dir} tree fingerprint mismatch against manifest"),
                            ));
                        }
                    }
                }
            }
        }
    }

    let ssot = SkillService::get_ssot_dir().map_err(|e| {
        localized(
            "webdav.sync.skills_ssot_dir_failed",
            format!("获取 Skills SSOT 目录失败: {e}"),
            format!("Failed to resolve Skills SSOT directory: {e}"),
        )
    })?;
    let bak = ssot.with_extension("bak");

    if ssot.exists() {
        if bak.exists() {
            let _ = fs::remove_dir_all(&bak);
        }
        fs::rename(&ssot, &bak).map_err(|e| AppError::io(&ssot, e))?;
    }

    if let Err(e) = copy_dir_recursive(&extracted, &ssot) {
        if bak.exists() {
            let _ = fs::remove_dir_all(&ssot);
            let _ = fs::rename(&bak, &ssot);
        }
        return Err(e);
    }

    let _ = fs::remove_dir_all(&bak);
    Ok(())
}

pub(crate) fn backup_current_skills() -> Result<SkillsBackup, AppError> {
    let ssot = SkillService::get_ssot_dir().map_err(|e| {
        localized(
            "webdav.sync.skills_ssot_dir_failed",
            format!("获取 Skills SSOT 目录失败: {e}"),
            format!("Failed to resolve Skills SSOT directory: {e}"),
        )
    })?;
    let tmp = tempdir().map_err(|e| {
        io_context_localized(
            "webdav.sync.skills_backup_tmpdir_failed",
            "创建 skills 备份临时目录失败",
            "Failed to create temporary directory for skills backup",
            e,
        )
    })?;
    let backup_dir = tmp.path().join("skills-backup");

    let existed = ssot.exists();
    if existed {
        copy_dir_recursive(&ssot, &backup_dir)?;
    }

    Ok(SkillsBackup {
        _tmp: tmp,
        backup_dir,
        ssot_path: ssot,
        existed,
    })
}

pub(crate) fn restore_skills_from_backup(backup: &SkillsBackup) -> Result<(), AppError> {
    if backup.ssot_path.exists() {
        fs::remove_dir_all(&backup.ssot_path).map_err(|e| AppError::io(&backup.ssot_path, e))?;
    }

    if backup.existed {
        copy_dir_recursive(&backup.backup_dir, &backup.ssot_path)?;
    }

    Ok(())
}

fn zip_dir_recursive(
    root: &Path,
    current: &Path,
    writer: &mut zip::ZipWriter<fs::File>,
    base_options: SimpleFileOptions,
    visited: &mut HashSet<PathBuf>,
) -> Result<(), AppError> {
    let mut entries: Vec<_> = fs::read_dir(current)
        .map_err(|e| AppError::io(current, e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::io(current, e))?;
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| AppError::io(&path, e))?;
        if meta.file_type().is_symlink() {
            return Err(localized(
                "webdav.sync.symlink_in_skill",
                format!("Skill 内包含不允许的符号链接: {}", path.display()),
                format!("Skill contains disallowed symlink: {}", path.display()),
            ));
        }

        let real_path = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !real_path.starts_with(root) {
            return Err(localized(
                "webdav.sync.path_outside_ssot",
                format!("Skill 项超出 SSOT 根目录: {}", path.display()),
                format!("Skill entry escapes SSOT root: {}", path.display()),
            ));
        }

        let rel = real_path
            .strip_prefix(root)
            .or_else(|_| path.strip_prefix(root))
            .map_err(|e| {
                localized(
                    "webdav.sync.zip_relative_path_failed",
                    format!("生成 ZIP 相对路径失败: {e}"),
                    format!("Failed to build relative ZIP path: {e}"),
                )
            })?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");

        if meta.is_dir() {
            if !mark_visited_dir(&real_path, visited)? {
                continue;
            }
            writer
                .add_directory(format!("{rel_str}/"), base_options)
                .map_err(|e| {
                    localized(
                        "webdav.sync.zip_add_directory_failed",
                        format!("写入 ZIP 目录失败: {e}"),
                        format!("Failed to write ZIP directory entry: {e}"),
                    )
                })?;
            zip_dir_recursive(root, &real_path, writer, base_options, visited)?;
        } else if meta.is_file() {
            #[cfg(unix)]
            let file_options = {
                use std::os::unix::fs::PermissionsExt;
                base_options.unix_permissions(meta.permissions().mode() & 0o777)
            };
            #[cfg(not(unix))]
            let file_options = base_options;

            writer.start_file(&rel_str, file_options).map_err(|e| {
                localized(
                    "webdav.sync.zip_start_file_failed",
                    format!("写入 ZIP 文件头失败: {e}"),
                    format!("Failed to start ZIP file entry: {e}"),
                )
            })?;
            let mut file = fs::File::open(&real_path).map_err(|e| AppError::io(&real_path, e))?;
            let mut buf = Vec::new();
            file.read_to_end(&mut buf)
                .map_err(|e| AppError::io(&real_path, e))?;
            writer.write_all(&buf).map_err(|e| {
                localized(
                    "webdav.sync.zip_write_file_failed",
                    format!("写入 ZIP 文件内容失败: {e}"),
                    format!("Failed to write ZIP file content: {e}"),
                )
            })?;
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), AppError> {
    let mut visited = HashSet::new();
    copy_dir_recursive_inner(src, dest, &mut visited)
}

fn copy_dir_recursive_inner(
    src: &Path,
    dest: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Result<(), AppError> {
    if !src.exists() {
        return Ok(());
    }
    if !mark_visited_dir(src, visited)? {
        return Ok(());
    }
    fs::create_dir_all(dest).map_err(|e| AppError::io(dest, e))?;
    for entry in fs::read_dir(src).map_err(|e| AppError::io(src, e))? {
        let entry = entry.map_err(|e| AppError::io(src, e))?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| AppError::io(&path, e))?;
        if meta.file_type().is_symlink() {
            continue;
        }
        let dest_path = dest.join(entry.file_name());
        if meta.is_dir() {
            copy_dir_recursive_inner(&path, &dest_path, visited)?;
        } else if meta.is_file() {
            fs::copy(&path, &dest_path).map_err(|e| AppError::io(&dest_path, e))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(
                    &dest_path,
                    fs::Permissions::from_mode(meta.permissions().mode() & 0o777),
                );
            }
        }
    }
    Ok(())
}

fn mark_visited_dir(path: &Path, visited: &mut HashSet<PathBuf>) -> Result<bool, AppError> {
    let canonical = fs::canonicalize(path).map_err(|e| AppError::io(path, e))?;
    Ok(visited.insert(canonical))
}

fn copy_entry_with_total_limit<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    total_bytes: &mut u64,
    max_total_bytes: u64,
    out_path: &Path,
) -> Result<u64, AppError> {
    let mut buffer = [0u8; 16 * 1024];
    let mut written = 0u64;
    loop {
        let n = reader
            .read(&mut buffer)
            .map_err(|e| AppError::io(out_path, e))?;
        if n == 0 {
            break;
        }

        if total_bytes.saturating_add(n as u64) > max_total_bytes {
            let max_mb = max_total_bytes / 1024 / 1024;
            return Err(localized(
                "webdav.sync.skills_zip_too_large",
                format!("skills.zip 解压后体积超过上限（{max_mb} MB）"),
                format!("skills.zip extracted size exceeds limit ({max_mb} MB)"),
            ));
        }

        writer
            .write_all(&buffer[..n])
            .map_err(|e| AppError::io(out_path, e))?;
        *total_bytes += n as u64;
        written += n as u64;
    }
    Ok(written)
}
