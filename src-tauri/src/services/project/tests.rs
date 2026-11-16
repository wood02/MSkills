use super::*;
use crate::app_config::{InstalledSkill, SkillApps};
use crate::services::project::deploy::{
    adopt_project_skill, deploy_skills_to_project, diff_project_skill, promote_claude_deployment,
    push_skill_to_global, rebind_project_deployment, undeploy_project_skill,
    update_project_deployments, TargetSkillRef,
};
use crate::services::project::fs_safety::{
    compute_skill_tree_fingerprint, is_symlink, rename_noreplace, FsIdentity,
};
use crate::services::project::journal::{
    recover_pending_operations, ExtraSwapPaths, JournalBeginSpec, JournalGuard, JournalPayload,
};
use crate::services::project::rules::{
    apply_prompt_to_project_rule, has_effective_agents_reference,
    insert_agents_reference_in_claude_md, list_project_rules, list_rule_snapshots,
    restore_rule_snapshot, save_project_rule_file, validate_rule_relative_path,
};
use crate::services::project::scan::{scan_project, ProjectSkillStatus};
use crate::services::webdav_sync::archive::{
    restore_skills_zip_verified, zip_skills_ssot_with_manifest,
};
use crate::{AppError, Prompt};
use serial_test::serial;
use std::fs;
use std::process::Command;
use tempfile::TempDir;

struct TestEnvGuard {
    _temp: TempDir,
    prev_test_home: Option<String>,
    prev_home: Option<String>,
    prev_userprofile: Option<String>,
}

impl TestEnvGuard {
    fn new() -> Self {
        let temp = TempDir::new().expect("create temp home");
        let prev_test_home = std::env::var("MSKILLS_TEST_HOME").ok();
        let prev_home = std::env::var("HOME").ok();
        let prev_userprofile = std::env::var("USERPROFILE").ok();
        std::env::set_var("MSKILLS_TEST_HOME", temp.path());
        std::env::set_var("HOME", temp.path());
        std::env::set_var("USERPROFILE", temp.path());
        let _ = crate::settings::reload_settings();
        Self {
            _temp: temp,
            prev_test_home,
            prev_home,
            prev_userprofile,
        }
    }

    fn root(&self) -> &Path {
        self._temp.path()
    }
}

impl Drop for TestEnvGuard {
    fn drop(&mut self) {
        if let Some(t) = &self.prev_test_home {
            std::env::set_var("MSKILLS_TEST_HOME", t);
        } else {
            std::env::remove_var("MSKILLS_TEST_HOME");
        }
        if let Some(h) = &self.prev_home {
            std::env::set_var("HOME", h);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(u) = &self.prev_userprofile {
            std::env::set_var("USERPROFILE", u);
        } else {
            std::env::remove_var("USERPROFILE");
        }
        let _ = crate::settings::reload_settings();
    }
}

fn seed_global_skill(
    db: &Arc<Database>,
    home: &Path,
    id: &str,
    dir: &str,
    skill_md: &str,
) -> (InstalledSkill, PathBuf) {
    let ssot = home.join(".mskills").join("skills");
    fs::create_dir_all(&ssot).unwrap();
    let skill_dir = ssot.join(dir);
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(skill_dir.join("SKILL.md"), skill_md).unwrap();

    let inst_id = uuid::Uuid::new_v4().to_string();
    let skill = InstalledSkill {
        id: id.to_string(),
        name: dir.to_string(),
        description: Some("test skill".to_string()),
        directory: dir.to_string(),
        repo_owner: None,
        repo_name: None,
        repo_branch: None,
        readme_url: None,
        apps: SkillApps {
            claude: true,
            ..Default::default()
        },
        installed_at: 100,
        content_hash: None,
        updated_at: 100,
        installation_id: inst_id,
    };
    db.save_skill(&skill).unwrap();
    (skill, skill_dir)
}

#[test]
fn fs_safety_rename_noreplace_and_identity_roundtrip() {
    let dir = TempDir::new().unwrap();
    let src = dir.path().join("src");
    let dst = dir.path().join("dst");
    fs::create_dir_all(&src).unwrap();
    fs::write(src.join("a.txt"), "hello").unwrap();

    // 目标尚不存在 -> 成功
    rename_noreplace(&src, &dst).unwrap();
    assert!(!src.exists());
    assert!(dst.join("a.txt").exists());

    // 目标已存在 -> 必须拒绝覆盖
    fs::create_dir_all(&src).unwrap();
    fs::write(src.join("a.txt"), "new").unwrap();
    let err = rename_noreplace(&src, &dst).expect_err("rename_noreplace must refuse existing dst");
    assert!(!err.to_string().is_empty());
    assert_eq!(fs::read_to_string(dst.join("a.txt")).unwrap(), "hello");

    let id = FsIdentity::Unix {
        dev: (u64::MAX - 1).to_string(),
        ino: u64::MAX.to_string(),
    };
    let json = id.to_json().unwrap();
    let parsed = FsIdentity::from_json(&json).unwrap();
    assert_eq!(id, parsed);
}

#[test]
fn fingerprint_includes_hidden_empty_dirs_and_rejects_symlinks() {
    let tmp = TempDir::new().unwrap();
    let d1 = tmp.path().join("skill");
    fs::create_dir_all(&d1).unwrap();
    fs::write(d1.join("SKILL.md"), "---\nname: demo\n---\nbody\n").unwrap();
    let fp1 = compute_skill_tree_fingerprint(&d1).unwrap();

    // 加入隐藏文件 -> 指纹变化
    fs::write(d1.join(".envrc"), "export FOO=1").unwrap();
    let fp2 = compute_skill_tree_fingerprint(&d1).unwrap();
    assert_ne!(fp1, fp2);

    // 加入空子目录 -> 指纹变化
    fs::create_dir_all(d1.join("empty-sub")).unwrap();
    let fp3 = compute_skill_tree_fingerprint(&d1).unwrap();
    assert_ne!(fp2, fp3);

    // 包含内部软链 -> 拒绝计算并报错
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(d1.join("SKILL.md"), d1.join("bad-link")).unwrap();
        assert!(compute_skill_tree_fingerprint(&d1).is_err());
    }
}

#[test]
#[serial]
fn deploy_dual_target_copy_relative_alias_update_push_and_diff() {
    let env = TestEnvGuard::new();
    let db = Arc::new(Database::memory().unwrap());
    let (skill, ssot_skill_dir) = seed_global_skill(
        &db,
        env.root(),
        "local:alpha",
        "alpha",
        "---\nname: alpha\n---\nv1\n",
    );

    let proj_dir = env.root().join("repo-alpha");
    fs::create_dir_all(&proj_dir).unwrap();
    let project = add_project(
        &db,
        AddProjectInput {
            root_path: proj_dir.to_string_lossy().to_string(),
            name: Some("Alpha Repo".to_string()),
            default_mode: Some("copy".to_string()),
            enabled_targets: Some(vec!["agents".to_string(), "claude".to_string()]),
            auto_git_exclude: Some(false),
            reactivate_if_archived: false,
        },
    )
    .unwrap();

    let res = deploy_skills_to_project(
        &db,
        &project.id,
        &[skill.id.clone()],
        &["agents".to_string(), "claude".to_string()],
        Some("copy"),
        false,
    )
    .unwrap();
    assert_eq!(res.deployed.len(), 2);

    let agents_path = proj_dir.join(".agents/skills/alpha");
    let claude_path = proj_dir.join(".claude/skills/alpha");
    assert!(agents_path.is_dir() && !is_symlink(&agents_path));
    assert!(
        is_symlink(&claude_path),
        "Claude 同轮双目标必须生成相对别名"
    );
    assert_eq!(
        fs::read_link(&claude_path).unwrap(),
        PathBuf::from("../../.agents/skills/alpha")
    );

    // Scan 应均处于 Synced，且触发 Claude 同名折叠提示而不触发冲突告警
    let scan1 = scan_project(&db, &project.id).unwrap();
    assert_eq!(scan1.entries.len(), 2);
    assert!(scan1
        .entries
        .iter()
        .all(|s| s.status == ProjectSkillStatus::Synced));

    // 1) 更新全局 -> Outdated
    fs::write(
        ssot_skill_dir.join("SKILL.md"),
        "---\nname: alpha\n---\nv2\n",
    )
    .unwrap();
    let scan2 = scan_project(&db, &project.id).unwrap();
    let agents_entry = scan2.entries.iter().find(|s| s.target == "agents").unwrap();
    assert_eq!(agents_entry.status, ProjectSkillStatus::Outdated);

    // 2) 同时修改项目副本 -> Conflict，且 Diff 可见差异
    fs::write(
        agents_path.join("SKILL.md"),
        "---\nname: alpha\n---\nlocal-edit\n",
    )
    .unwrap();
    let scan3 = scan_project(&db, &project.id).unwrap();
    assert_eq!(
        scan3
            .entries
            .iter()
            .find(|s| s.target == "agents")
            .unwrap()
            .status,
        ProjectSkillStatus::Conflict
    );
    let diff = diff_project_skill(&db, &project.id, "agents", "alpha").unwrap();
    assert!(diff
        .files
        .iter()
        .any(|f| f.relative_path == "SKILL.md" && f.change_type == "modified"));

    // 3) 以项目版本 Push 覆盖回全局库 -> Conflict 消解为 Synced
    push_skill_to_global(&db, &project.id, "agents", "alpha", true).unwrap();
    assert_eq!(
        fs::read_to_string(ssot_skill_dir.join("SKILL.md")).unwrap(),
        "---\nname: alpha\n---\nlocal-edit\n"
    );
    let scan4 = scan_project(&db, &project.id).unwrap();
    assert_eq!(
        scan4
            .entries
            .iter()
            .find(|s| s.target == "agents")
            .unwrap()
            .status,
        ProjectSkillStatus::Synced
    );

    // 4) 再改全局并从全局更新回项目（禁止无确认覆盖本地脏改 -> 校验安全守卫）
    fs::write(
        agents_path.join("SKILL.md"),
        "---\nname: alpha\n---\nlocal-edit-2\n",
    )
    .unwrap();
    assert!(update_project_deployments(
        &db,
        &project.id,
        &[TargetSkillRef {
            target: "agents".into(),
            directory: "alpha".into(),
        }],
        false
    )
    .is_err());

    fs::write(
        ssot_skill_dir.join("SKILL.md"),
        "---\nname: alpha\n---\nv3\n",
    )
    .unwrap();
    update_project_deployments(
        &db,
        &project.id,
        &[TargetSkillRef {
            target: "agents".into(),
            directory: "alpha".into(),
        }],
        true,
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(agents_path.join("SKILL.md")).unwrap(),
        "---\nname: alpha\n---\nv3\n"
    );
}

#[test]
#[serial]
fn promote_claude_skill_to_agents_and_alias() {
    let env = TestEnvGuard::new();
    let db = Arc::new(Database::memory().unwrap());
    let (skill, _) = seed_global_skill(
        &db,
        env.root(),
        "local:beta",
        "beta",
        "---\nname: beta\n---\npromote me\n",
    );

    let proj_dir = env.root().join("repo-beta");
    fs::create_dir_all(&proj_dir).unwrap();
    let project = add_project(
        &db,
        AddProjectInput {
            root_path: proj_dir.to_string_lossy().to_string(),
            name: None,
            default_mode: Some("copy".to_string()),
            enabled_targets: Some(vec!["claude".to_string()]),
            auto_git_exclude: Some(false),
            reactivate_if_archived: false,
        },
    )
    .unwrap();

    deploy_skills_to_project(
        &db,
        &project.id,
        &[skill.id],
        &["claude".to_string()],
        Some("copy"),
        false,
    )
    .unwrap();

    let (agents_dep, claude_dep) =
        promote_claude_deployment(&db, &project.id, "beta", false).unwrap();
    assert_eq!(agents_dep.target, "agents");
    assert_eq!(agents_dep.mode, "copy");
    assert_eq!(claude_dep.target, "claude");
    assert_eq!(claude_dep.mode, "relative_alias");
    assert!(proj_dir.join(".agents/skills/beta/SKILL.md").exists());
    assert_eq!(
        fs::read_link(proj_dir.join(".claude/skills/beta")).unwrap(),
        PathBuf::from("../../.agents/skills/beta")
    );
}

#[test]
#[serial]
fn journal_prepared_rollback_and_committed_resume() {
    let env = TestEnvGuard::new();
    let db = Arc::new(Database::memory().unwrap());
    let work = env.root().join("journal-work");
    fs::create_dir_all(&work).unwrap();

    // Case A: prepared 阶段崩溃 -> 回滚 backup -> dest，并删除 staging
    let staging = work.join("staging-a");
    let backup = work.join("backup-a");
    let dest = work.join("dest-a");
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("f.txt"), "new").unwrap();
    fs::create_dir_all(&backup).unwrap();
    fs::write(backup.join("f.txt"), "old").unwrap();

    let staging_s = staging.to_string_lossy();
    let backup_s = backup.to_string_lossy();
    let dest_s = dest.to_string_lossy();
    let guard = JournalGuard::begin(
        &db,
        JournalBeginSpec {
            op_type: "swap_test",
            directory: Some("a"),
            staging_path: Some(&staging_s),
            backup_path: Some(&backup_s),
            dest_path: Some(&dest_s),
            ..Default::default()
        },
        &JournalPayload::default(),
    )
    .unwrap();
    // 模拟崩溃未调用 finish/mark_committed
    std::mem::forget(guard);

    let recovered = recover_pending_operations(&db).unwrap();
    assert_eq!(recovered, 1);
    assert!(!staging.exists());
    assert!(!backup.exists());
    assert_eq!(fs::read_to_string(dest.join("f.txt")).unwrap(), "old");

    // Case B: committed 阶段崩溃 -> 清理多余 backup 与 remove_paths_on_commit
    let backup2 = work.join("backup-b");
    let obsolete = work.join("obsolete-b");
    fs::create_dir_all(&backup2).unwrap();
    fs::create_dir_all(&obsolete).unwrap();
    let backup2_s = backup2.to_string_lossy();
    let guard2 = JournalGuard::begin(
        &db,
        JournalBeginSpec {
            op_type: "promote_test",
            directory: Some("b"),
            backup_path: Some(&backup2_s),
            ..Default::default()
        },
        &JournalPayload {
            extra_swaps: vec![ExtraSwapPaths {
                staging_path: None,
                backup_path: Some(work.join("backup-b2").to_string_lossy().to_string()),
                dest_path: None,
            }],
            refresh_app_directories: vec![],
            remove_paths_on_commit: vec![obsolete.to_string_lossy().to_string()],
        },
    )
    .unwrap();
    guard2.mark_committed(None).unwrap();
    std::mem::forget(guard2);

    let recovered2 = recover_pending_operations(&db).unwrap();
    assert_eq!(recovered2, 1);
    assert!(!backup2.exists());
    assert!(!obsolete.exists());
}

#[test]
#[serial]
fn scan_matrix_rebind_source_missing_unmanaged_and_warnings() {
    let env = TestEnvGuard::new();
    let db = Arc::new(Database::memory().unwrap());
    let (s1, _) = seed_global_skill(
        &db,
        env.root(),
        "local:s1",
        "s1",
        "---\nname: shared-name\n---\nv1\n",
    );
    let (s2, _) = seed_global_skill(
        &db,
        env.root(),
        "local:s2",
        "s2",
        "---\nname: shared-name\n---\nv2\n",
    );

    let proj_dir = env.root().join("repo-scan");
    fs::create_dir_all(proj_dir.join(".agents/skills/s1")).unwrap();
    fs::write(
        proj_dir.join(".agents/skills/s1/SKILL.md"),
        "---\nname: shared-name\n---\nv1\n",
    )
    .unwrap();
    // 同内容未纳管（目录名不同但 fingerprint 相同）
    fs::create_dir_all(proj_dir.join(".agents/skills/same-content")).unwrap();
    fs::write(
        proj_dir.join(".agents/skills/same-content/SKILL.md"),
        "---\nname: shared-name\n---\nv1\n",
    )
    .unwrap();
    // 缺 SKILL.md -> InvalidStructure
    fs::create_dir_all(proj_dir.join(".claude/skills/invalid-dir")).unwrap();
    fs::write(proj_dir.join(".claude/skills/invalid-dir/README.md"), "hi").unwrap();
    // 悬空软链 -> Broken
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        "/nonexistent/ssot/ghost",
        proj_dir.join(".claude/skills/ghost"),
    )
    .unwrap();

    let project = add_project(
        &db,
        AddProjectInput {
            root_path: proj_dir.to_string_lossy().to_string(),
            name: None,
            default_mode: Some("copy".to_string()),
            enabled_targets: Some(vec!["agents".to_string(), "claude".to_string()]),
            auto_git_exclude: Some(false),
            reactivate_if_archived: false,
        },
    )
    .unwrap();

    // 纳管 s1（内容与全局 s1 一致 -> Synced）
    adopt_project_skill(&db, &project.id, "agents", "s1", Some(&s1.id)).unwrap();
    // Rebind 到内容不同的 s2 -> 必须报 Conflict + unknown_baseline = true
    let rebound = rebind_project_deployment(&db, &project.id, "agents", "s1", &s2.id).unwrap();
    assert_eq!(rebound.deployed_hash, None);
    assert_eq!(rebound.last_materialized_hash, None);

    let scan = scan_project(&db, &project.id).unwrap();
    let s1_item = scan
        .entries
        .iter()
        .find(|x| x.target == "agents" && x.directory == "s1")
        .unwrap();
    assert_eq!(s1_item.status, ProjectSkillStatus::Conflict);
    assert!(s1_item.unknown_baseline);

    let same_item = scan
        .entries
        .iter()
        .find(|x| x.target == "agents" && x.directory == "same-content")
        .unwrap();
    assert_eq!(same_item.status, ProjectSkillStatus::SameContentUnmanaged);

    let invalid_item = scan
        .entries
        .iter()
        .find(|x| x.target == "claude" && x.directory == "invalid-dir")
        .unwrap();
    assert_eq!(invalid_item.status, ProjectSkillStatus::InvalidStructure);

    #[cfg(unix)]
    {
        let broken_item = scan
            .entries
            .iter()
            .find(|x| x.target == "claude" && x.directory == "ghost")
            .unwrap();
        assert_eq!(broken_item.status, ProjectSkillStatus::Broken);
    }

    // 删除 s2 -> SourceMissing
    db.delete_skill(&s2.id).unwrap();
    let scan_missing = scan_project(&db, &project.id).unwrap();
    assert_eq!(
        scan_missing
            .entries
            .iter()
            .find(|x| x.target == "agents" && x.directory == "s1")
            .unwrap()
            .status,
        ProjectSkillStatus::SourceMissing
    );
}

#[test]
#[serial]
fn git_exclude_symlink_enforces_ignore_and_cleans_block() {
    if Command::new("git").arg("--version").output().is_err() {
        return;
    }
    let env = TestEnvGuard::new();
    let db = Arc::new(Database::memory().unwrap());
    let (skill, _) = seed_global_skill(
        &db,
        env.root(),
        "local:gskill",
        "gskill",
        "---\nname: gskill\n---\nhi\n",
    );

    let repo = env.root().join("git-repo");
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .current_dir(&repo)
        .status()
        .unwrap()
        .success());

    // 先以 auto_git_exclude = false 添加项目，且不写 .gitignore -> 必须拒绝建 symlink
    let proj_no_auto = add_project(
        &db,
        AddProjectInput {
            root_path: repo.to_string_lossy().to_string(),
            name: None,
            default_mode: Some("symlink".to_string()),
            enabled_targets: Some(vec!["agents".to_string()]),
            auto_git_exclude: Some(false),
            reactivate_if_archived: false,
        },
    )
    .unwrap();

    let denied = deploy_skills_to_project(
        &db,
        &proj_no_auto.id,
        &[skill.id.clone()],
        &["agents".to_string()],
        Some("symlink"),
        false,
    );
    assert!(
        denied.is_err(),
        "auto_git_exclude=false 且未 ignore 时必须拒绝建 symlink"
    );

    // 开启 auto_git_exclude -> 成功写入 info/exclude managed block 并建软链
    let proj = update_project(
        &db,
        UpdateProjectInput {
            id: proj_no_auto.id,
            name: None,
            default_mode: None,
            enabled_targets: None,
            auto_git_exclude: Some(true),
            archived: None,
        },
    )
    .unwrap();

    deploy_skills_to_project(
        &db,
        &proj.id,
        &[skill.id],
        &["agents".to_string()],
        Some("symlink"),
        false,
    )
    .unwrap();

    let exclude_path = repo.join(".git/info/exclude");
    let exclude_txt = fs::read_to_string(&exclude_path).unwrap();
    assert!(exclude_txt.contains(".agents/skills/gskill"));
    assert!(exclude_txt.contains(&format!("# mskills:begin project={}", proj.id)));

    // Undeploy 应拆除软链并清理 managed block
    undeploy_project_skill(&db, &proj.id, "agents", "gskill", "delete_link").unwrap();
    let exclude_after = fs::read_to_string(&exclude_path).unwrap();
    assert!(!exclude_after.contains(".agents/skills/gskill"));
}

#[test]
#[serial]
fn db_only_sql_restore_preserves_skills_and_projects() {
    let env = TestEnvGuard::new();
    let target = Arc::new(Database::memory().unwrap());
    let (local_skill, _) = seed_global_skill(
        &target,
        env.root(),
        "local:keep-me",
        "keep-me",
        "---\nname: keep-me\n---\nlocal\n",
    );
    let proj_dir = env.root().join("proj-preserve");
    fs::create_dir_all(&proj_dir).unwrap();
    let proj = add_project(
        &target,
        AddProjectInput {
            root_path: proj_dir.to_string_lossy().to_string(),
            name: Some("KeepProj".to_string()),
            default_mode: Some("copy".to_string()),
            enabled_targets: Some(vec!["agents".to_string()]),
            auto_git_exclude: Some(false),
            reactivate_if_archived: false,
        },
    )
    .unwrap();
    target
        .save_skill_group(&crate::database::SkillGroup {
            id: "local-group-1".into(),
            name: "LocalGroup".into(),
            skills: serde_json::to_string(&vec![local_skill.id.clone()]).unwrap(),
            sort_order: None,
            created_at: Some(100),
            updated_at: Some(100),
        })
        .unwrap();
    target
        .set_current_skill_group_id("claude", Some("local-group-1"))
        .unwrap();

    // 从另一台机器导出含不同 skill 与不同 provider 的 SQL
    let source = Database::memory().unwrap();
    {
        let conn = source.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO providers (id, app_type, name, settings_config, meta)
             VALUES ('restored-p', 'claude', 'Restored Provider', '{}', '{}')",
            [],
        )
        .unwrap();
    }
    source
        .save_skill(&InstalledSkill {
            id: "remote:should-not-overwrite".into(),
            name: "Remote".into(),
            description: None,
            directory: "remote-only".into(),
            repo_owner: None,
            repo_name: None,
            repo_branch: None,
            readme_url: None,
            apps: SkillApps::default(),
            installed_at: 1,
            content_hash: None,
            updated_at: 1,
            installation_id: "remote-inst".into(),
        })
        .unwrap();
    let sql = source.export_sql_string().unwrap();

    target.import_sql_string(&sql).unwrap();

    // Provider 已恢复，但本机 skill/project/group state 保留
    assert!(target
        .get_installed_skill(&local_skill.id)
        .unwrap()
        .is_some());
    assert!(target
        .get_installed_skill("remote:should-not-overwrite")
        .unwrap()
        .is_none());
    assert!(target.get_project(&proj.id).unwrap().is_some());
    assert_eq!(
        target
            .get_current_skill_group_id("claude")
            .unwrap()
            .as_deref(),
        Some("local-group-1")
    );
    let providers = target.get_all_providers("claude").unwrap();
    assert!(providers.contains_key("restored-p"));
}

#[test]
#[serial]
fn archive_preserves_hidden_empty_dirs_and_verifies_manifest() {
    let env = TestEnvGuard::new();
    let db = Database::memory().unwrap();
    let ssot = env.root().join(".mskills/skills");
    let skill_dir = ssot.join("hidden-skill");
    fs::create_dir_all(skill_dir.join(".claude-plugin")).unwrap();
    fs::create_dir_all(skill_dir.join("empty-sub")).unwrap();
    fs::write(skill_dir.join("SKILL.md"), "---\nname: hidden\n---\nhi\n").unwrap();
    fs::write(skill_dir.join(".claude-plugin/plugin.json"), "{}").unwrap();
    // 根目录 scratch 临时目录应被排除
    fs::create_dir_all(ssot.join(".mskills-staging/tmp")).unwrap();
    fs::write(ssot.join(".mskills-staging/tmp/junk"), "x").unwrap();

    let inst = InstalledSkill {
        id: "local:hidden-skill".into(),
        name: "hidden".into(),
        description: None,
        directory: "hidden-skill".into(),
        repo_owner: None,
        repo_name: None,
        repo_branch: None,
        readme_url: None,
        apps: SkillApps::default(),
        installed_at: 1,
        content_hash: None,
        updated_at: 1,
        installation_id: "inst-hidden-1".into(),
    };
    db.save_skill(&inst).unwrap();

    let zip_path = env.root().join("skills.zip");
    zip_skills_ssot_with_manifest(&zip_path, std::slice::from_ref(&inst)).unwrap();
    let bytes = fs::read(&zip_path).unwrap();

    // 破坏本地目录后完整恢复并校验 manifest
    fs::remove_dir_all(&ssot).unwrap();
    restore_skills_zip_verified(&bytes, Some(std::slice::from_ref(&inst))).unwrap();
    assert!(ssot
        .join("hidden-skill/.claude-plugin/plugin.json")
        .exists());
    assert!(ssot.join("hidden-skill/empty-sub").is_dir());
    assert!(!ssot.join(".mskills-staging").exists());

    // 伪造 installation_id 不一致时必须拒绝恢复
    let mut mismatch_skill = inst.clone();
    mismatch_skill.installation_id = "different-inst-2".into();
    db.save_skill(&mismatch_skill).unwrap();
    assert!(restore_skills_zip_verified(&bytes, Some(&[mismatch_skill])).is_err());
}

#[test]
#[serial]
fn rules_whitelist_managed_block_agents_ref_and_deletion_snapshot() {
    let env = TestEnvGuard::new();
    let db = Arc::new(Database::memory().unwrap());
    let proj_dir = env.root().join("repo-rules");
    fs::create_dir_all(&proj_dir).unwrap();
    let proj = add_project(
        &db,
        AddProjectInput {
            root_path: proj_dir.to_string_lossy().to_string(),
            name: None,
            default_mode: Some("copy".to_string()),
            enabled_targets: Some(vec!["agents".to_string()]),
            auto_git_exclude: Some(false),
            reactivate_if_archived: false,
        },
    )
    .unwrap();

    // 白名单校验
    assert!(validate_rule_relative_path(".claude/settings.json").is_err());
    assert!(validate_rule_relative_path("AGENTS.md").is_ok());

    // 代码块和行内代码中的 @AGENTS.md 不算有效引用
    let fenced_only = "```md\n@AGENTS.md\n```\nAlso `@AGENTS.md` inline.\n";
    assert!(!has_effective_agents_reference(fenced_only));
    assert!(has_effective_agents_reference("@AGENTS.md\n"));

    // 创建 CLAUDE.md 并验证“修改前文件不存在”快照恢复需 confirm_delete
    save_project_rule_file(&db, &proj.id, "CLAUDE.md", "# Project\n", None).unwrap();
    let snaps = list_rule_snapshots(&db, &proj.id, Some("CLAUDE.md")).unwrap();
    assert_eq!(snaps.len(), 1);
    assert!(!snaps[0].file_existed);

    let files = list_project_rules(&db, &proj.id).unwrap();
    let claude_rev = files
        .iter()
        .find(|f| f.relative_path == "CLAUDE.md")
        .unwrap()
        .revision_hash
        .clone();

    // 插入 @AGENTS.md 引用
    let inserted =
        insert_agents_reference_in_claude_md(&db, &proj.id, claude_rev.as_deref()).unwrap();
    assert!(!inserted.already_present);
    assert!(inserted.file.has_agents_reference);

    // 应用 Prompt managed_block（重复应用应幂等替换块而不是叠两份）
    db.save_prompt(
        "claude",
        &Prompt {
            id: "p1".into(),
            name: "Style".into(),
            content: "Always write tests.".into(),
            description: None,
            enabled: false,
            sort_order: None,
            created_at: None,
            updated_at: None,
        },
    )
    .unwrap();
    let after_prompt1 = apply_prompt_to_project_rule(
        &db,
        &proj.id,
        "CLAUDE.md",
        "p1",
        "managed_block",
        inserted.file.revision_hash.as_deref(),
    )
    .unwrap();
    let after_prompt2 = apply_prompt_to_project_rule(
        &db,
        &proj.id,
        "CLAUDE.md",
        "p1",
        "managed_block",
        after_prompt1.revision_hash.as_deref(),
    )
    .unwrap();
    assert_eq!(
        after_prompt2
            .content
            .matches("mskills:begin id=\"p1\"")
            .count(),
        1
    );

    // 超过 20 次保存 -> 快照数量 capped 到 20
    let mut cur_rev: Option<String> = None;
    for i in 0..22 {
        let saved = save_project_rule_file(
            &db,
            &proj.id,
            "AGENTS.md",
            &format!("rule version {i}\n"),
            cur_rev.as_deref(),
        )
        .unwrap();
        cur_rev = saved.revision_hash;
    }
    let agents_snaps = list_rule_snapshots(&db, &proj.id, Some("AGENTS.md")).unwrap();
    assert_eq!(agents_snaps.len(), 20);

    // 恢复 CLAUDE.md 最早那个“当时不存在”的快照 -> 无确认必须报错，确认后删除文件
    assert!(restore_rule_snapshot(
        &db,
        &proj.id,
        &snaps[0].id,
        after_prompt2.revision_hash.as_deref(),
        false
    )
    .is_err());
    let restored = restore_rule_snapshot(
        &db,
        &proj.id,
        &snaps[0].id,
        after_prompt2.revision_hash.as_deref(),
        true,
    )
    .unwrap();
    assert!(restored.deleted_file);
    assert!(!proj_dir.join("CLAUDE.md").exists());
}
