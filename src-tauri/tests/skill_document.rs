use mskills_lib::{InstalledSkill, SkillApps, SkillService};
use std::fs;

#[path = "support.rs"]
mod support;
use support::{create_test_state, ensure_test_home, reset_test_fs, test_mutex};

const ORIGINAL: &str =
    "---\nname: Original\ndescription: Original description\n---\n# Instructions\n";

fn fixture() -> (mskills_lib::AppState, InstalledSkill, std::path::PathBuf) {
    reset_test_fs();
    // Pi has a separate override and is not cleared by the legacy fixture reset.
    let pi_root = ensure_test_home().join("skill-document-pi");
    if pi_root.exists() {
        fs::remove_dir_all(&pi_root).unwrap();
    }
    std::env::set_var("PI_CODING_AGENT_DIR", &pi_root);
    let path = ensure_test_home().join(".mskills/skills/example");
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("SKILL.md"), ORIGINAL).unwrap();
    fs::write(path.join("script.py"), "original script").unwrap();
    let state = create_test_state().unwrap();
    let skill = InstalledSkill {
        id: "local:example".into(),
        name: "Original".into(),
        description: Some("Original description".into()),
        directory: "example".into(),
        repo_owner: None,
        repo_name: None,
        repo_branch: None,
        readme_url: None,
        apps: SkillApps {
            codex: true,
            ..Default::default()
        },
        installed_at: 1,
        content_hash: None,
        updated_at: 0,
    };
    state.db.save_skill(&skill).unwrap();
    (state, skill, path)
}

#[test]
fn save_backs_up_original_updates_metadata_and_syncs_enabled_copies() {
    let _guard = test_mutex().lock().unwrap();
    let (state, skill, path) = fixture();
    let deployed = ensure_test_home().join(".codex/skills/example");
    fs::create_dir_all(&deployed).unwrap();
    fs::write(deployed.join("SKILL.md"), ORIGINAL).unwrap();
    let document = SkillService::read_skill_document(&state.db, &skill.id).unwrap();
    let content = "---\nname: Updated\ndescription: New description\n---\n# New instructions\n";
    let result =
        SkillService::save_skill_document(&state.db, &skill.id, content, &document.revision)
            .unwrap();
    assert_eq!(fs::read_to_string(path.join("SKILL.md")).unwrap(), content);
    assert_eq!(
        fs::read_to_string(deployed.join("SKILL.md")).unwrap(),
        content
    );
    assert_eq!(
        fs::read_to_string(path.join("script.py")).unwrap(),
        "original script"
    );
    assert_eq!(
        fs::read_to_string(std::path::Path::new(&result.backup_path).join("skill/SKILL.md"))
            .unwrap(),
        ORIGINAL
    );
    assert_eq!(result.skill.name, "Updated");
    assert_eq!(result.skill.description.as_deref(), Some("New description"));
    assert!(result.skill.apps.codex);
    assert!(!result.skill.apps.claude);
    assert!(result.sync_errors.is_empty());
    assert_ne!(result.document.revision, document.revision);
}

#[test]
fn stale_revision_and_invalid_yaml_do_not_overwrite_content() {
    let _guard = test_mutex().lock().unwrap();
    let (state, skill, path) = fixture();
    let document = SkillService::read_skill_document(&state.db, &skill.id).unwrap();
    fs::write(path.join("SKILL.md"), "# External edit").unwrap();
    assert!(SkillService::save_skill_document(
        &state.db,
        &skill.id,
        "# My edit",
        &document.revision
    )
    .is_err());
    let document = SkillService::read_skill_document(&state.db, &skill.id).unwrap();
    for invalid in [
        "---\nname: missing terminator",
        "---\nname: [invalid\n---\ntext",
        "",
    ] {
        assert!(SkillService::save_skill_document(
            &state.db,
            &skill.id,
            invalid,
            &document.revision
        )
        .is_err());
    }
    assert_eq!(
        fs::read_to_string(path.join("SKILL.md")).unwrap(),
        "# External edit"
    );
    assert_eq!(
        state
            .db
            .get_installed_skill(&skill.id)
            .unwrap()
            .unwrap()
            .name,
        "Original"
    );
}

#[test]
fn saved_document_reports_sync_failure_without_losing_the_edit() {
    let _guard = test_mutex().lock().unwrap();
    let (state, skill, path) = fixture();
    let codex = ensure_test_home().join(".codex");
    fs::create_dir_all(&codex).unwrap();
    fs::write(codex.join("skills"), "blocked").unwrap();
    let document = SkillService::read_skill_document(&state.db, &skill.id).unwrap();
    let result =
        SkillService::save_skill_document(&state.db, &skill.id, "# Saved edit", &document.revision)
            .unwrap();
    assert_eq!(result.document.content, "# Saved edit");
    assert_eq!(
        fs::read_to_string(path.join("SKILL.md")).unwrap(),
        "# Saved edit"
    );
    assert_eq!(result.sync_errors.len(), 1);
    assert!(result.sync_errors[0].starts_with("codex:"));
}

#[test]
fn edit_refreshes_a_matching_native_pi_copy() {
    let _guard = test_mutex().lock().unwrap();
    let (state, skill, _) = fixture();
    let pi = SkillService::get_app_skills_dir(&mskills_lib::AppType::Pi)
        .unwrap()
        .join(&skill.directory);
    fs::create_dir_all(&pi).unwrap();
    fs::write(pi.join("SKILL.md"), ORIGINAL).unwrap();
    fs::write(pi.join("script.py"), "original script").unwrap();
    let document = SkillService::read_skill_document(&state.db, &skill.id).unwrap();
    let result =
        SkillService::save_skill_document(&state.db, &skill.id, "# Updated Pi", &document.revision)
            .unwrap();
    assert!(result.skill.apps.pi);
    assert!(result.sync_errors.is_empty());
    assert_eq!(
        fs::read_to_string(pi.join("SKILL.md")).unwrap(),
        "# Updated Pi"
    );
    assert_eq!(
        fs::read_to_string(pi.join("script.py")).unwrap(),
        "original script"
    );
}

#[test]
fn failed_backup_keeps_the_original_file() {
    let _guard = test_mutex().lock().unwrap();
    let (state, skill, path) = fixture();
    let document = SkillService::read_skill_document(&state.db, &skill.id).unwrap();
    fs::write(ensure_test_home().join(".mskills/skill-backups"), "blocked").unwrap();
    assert!(SkillService::save_skill_document(
        &state.db,
        &skill.id,
        "# My edit",
        &document.revision
    )
    .is_err());
    assert_eq!(fs::read_to_string(path.join("SKILL.md")).unwrap(), ORIGINAL);
}

#[test]
fn traversal_and_oversized_documents_are_rejected() {
    let _guard = test_mutex().lock().unwrap();
    let (state, mut skill, path) = fixture();
    fs::write(path.join("SKILL.md"), "x".repeat(1024 * 1024 + 1)).unwrap();
    assert!(SkillService::read_skill_document(&state.db, &skill.id).is_err());
    skill.directory = "../outside".into();
    state.db.save_skill(&skill).unwrap();
    assert!(SkillService::read_skill_document(&state.db, &skill.id).is_err());
    assert!(
        SkillService::save_skill_document(&state.db, &skill.id, "# Unsafe", "revision").is_err()
    );
}

#[cfg(unix)]
#[test]
fn symlinked_manifest_cannot_read_or_edit_a_file_outside_the_skill() {
    let _guard = test_mutex().lock().unwrap();
    let (state, skill, path) = fixture();
    let outside = ensure_test_home().join("outside.md");
    fs::write(&outside, "private content").unwrap();
    fs::remove_file(path.join("SKILL.md")).unwrap();
    std::os::unix::fs::symlink(&outside, path.join("SKILL.md")).unwrap();
    assert!(SkillService::read_skill_document(&state.db, &skill.id).is_err());
    assert!(
        SkillService::save_skill_document(&state.db, &skill.id, "# Unsafe", "revision").is_err()
    );
    assert_eq!(fs::read_to_string(outside).unwrap(), "private content");
}

#[test]
fn create_local_skill_writes_editable_template_and_rejects_duplicates() {
    let _guard = test_mutex().lock().unwrap();
    let (state, _, _) = fixture();
    let skill =
        SkillService::create_local_skill(&state.db, "fresh", "Does: \"things\"\nwell").unwrap();
    assert_eq!(skill.id, "local:fresh");
    assert!(!skill.apps.claude && !skill.apps.codex);
    let document = SkillService::read_skill_document(&state.db, &skill.id).unwrap();
    assert!(document.content.starts_with("---\nname: fresh\n"));
    // 模板必须能原样通过保存时的 front matter 校验。
    let saved = SkillService::save_skill_document(
        &state.db,
        &skill.id,
        &document.content,
        &document.revision,
    )
    .unwrap();
    assert_eq!(
        saved.skill.description.as_deref(),
        Some("Does: \"things\"\nwell")
    );

    for bad in ["fresh", "example", "../escape", "", "Has Space", "a: b"] {
        assert!(
            SkillService::create_local_skill(&state.db, bad, "").is_err(),
            "must reject: {bad:?}"
        );
    }
}
