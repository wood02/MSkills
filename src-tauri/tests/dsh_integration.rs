use mskills_lib::{
    AppType, McpApps, McpServer, McpService, Prompt, PromptService, Provider, ProviderService,
    SkillGroupService, SkillService,
};
use serde_json::json;
use std::fs;
#[path = "support.rs"]
mod support;
use support::{create_test_state, ensure_test_home, reset_test_fs, test_mutex};

#[test]
fn dsh_provider_mcp_prompt_and_skill_group_lifecycle() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();
    let state = create_test_state().unwrap();
    let home = ensure_test_home().join(".dsh");
    let profile = home.join("profiles/web");
    fs::create_dir_all(&profile).unwrap();
    let path = profile.join("cordis.patch.yml");
    fs::write(&path, "- id: untouched\n  config: {enabled: true}\n").unwrap();
    let provider = Provider::with_id(
        "gateway".into(),
        "Gateway".into(),
        json!({"api":"openai-completions","baseURL":"https://example.com/v1","apiKey":"local-test-key","models":[{"id":"model"}]}),
        None,
    );
    ProviderService::add(&state, AppType::Dsh, provider.clone(), false).unwrap();
    assert!(!fs::read_to_string(&path).unwrap().contains("llm-pi-ai"));
    ProviderService::switch(&state, AppType::Dsh, &provider.id).unwrap();
    assert!(ProviderService::current(&state, AppType::Dsh)
        .unwrap()
        .is_empty());
    let listed = ProviderService::list(&state, AppType::Dsh).unwrap();
    assert_eq!(
        listed["gateway"].meta.as_ref().unwrap().live_config_managed,
        Some(true)
    );
    assert!(listed["gateway"].settings_config.get("apiKey").is_none());
    assert!(fs::read_to_string(home.join(".credentials.yaml"))
        .unwrap()
        .contains("local-test-key"));
    assert!(!fs::read_to_string(&path)
        .unwrap()
        .contains("local-test-key"));
    let mut edited = listed["gateway"].clone();
    edited.name = "Renamed".into();
    edited.settings_config["displayName"] = json!("Renamed");
    ProviderService::update(&state, AppType::Dsh, None, edited).unwrap();
    assert_eq!(
        ProviderService::list(&state, AppType::Dsh).unwrap()["gateway"].name,
        "Renamed"
    );
    ProviderService::remove_from_live_config(&state, AppType::Dsh, "gateway").unwrap();
    assert_eq!(
        ProviderService::list(&state, AppType::Dsh).unwrap()["gateway"]
            .meta
            .as_ref()
            .unwrap()
            .live_config_managed,
        Some(false)
    );
    ProviderService::switch(&state, AppType::Dsh, "gateway").unwrap();
    ProviderService::delete(&state, AppType::Dsh, "gateway").unwrap();
    assert!(state.db.get_all_providers("dsh").unwrap().is_empty());
    let server = McpServer {
        id: "echo".into(),
        name: "Echo".into(),
        server: json!({"command":"node","args":["server.js"]}),
        apps: McpApps {
            dsh: true,
            ..Default::default()
        },
        description: None,
        homepage: None,
        docs: None,
        tags: vec![],
    };
    fs::write(
        profile.join("package.json.lock"),
        format!("{}\n", std::process::id()),
    )
    .unwrap();
    assert!(McpService::upsert_server(&state, server.clone()).is_err());
    assert!(state.db.get_all_mcp_servers().unwrap().is_empty());
    fs::remove_file(profile.join("package.json.lock")).unwrap();
    McpService::upsert_server(&state, server.clone()).unwrap();
    assert!(state.db.get_all_mcp_servers().unwrap()["echo"].apps.dsh);
    McpService::toggle_app(&state, "echo", AppType::Dsh, false).unwrap();
    let patch = fs::read_to_string(&path).unwrap();
    assert!(patch.contains("serverName: echo") && patch.contains("disabled: true"));
    // Simulate a row left enabled by another profile's state, then reproject.
    fs::write(&path, patch.replace("disabled: true", "disabled: false")).unwrap();
    McpService::sync_enabled_for_app(&state, &AppType::Dsh).unwrap();
    assert!(fs::read_to_string(&path)
        .unwrap()
        .contains("disabled: true"));
    McpService::delete_server(&state, "echo").unwrap();
    assert!(!fs::read_to_string(&path)
        .unwrap()
        .contains("serverName: echo"));
    McpService::upsert_server(&state, server).unwrap();
    McpService::toggle_app(&state, "echo", AppType::Dsh, true).unwrap();
    McpService::delete_server(&state, "echo").unwrap();
    assert!(!fs::read_to_string(&path)
        .unwrap()
        .contains("serverName: echo"));
    let instructions = home.join("AGENTS.md");
    fs::write(&instructions, "Original instructions").unwrap();
    let draft: Prompt = serde_json::from_value(
        json!({"id":"draft","name":"Draft","content":"Managed instructions","enabled":false}),
    )
    .unwrap();
    PromptService::upsert_prompt(&state, AppType::Dsh, "draft", draft).unwrap();
    assert_eq!(
        fs::read_to_string(&instructions).unwrap(),
        "Original instructions"
    );
    PromptService::enable_prompt(&state, AppType::Dsh, "draft").unwrap();
    assert_eq!(
        fs::read_to_string(&instructions).unwrap(),
        "Managed instructions"
    );
    assert!(state
        .db
        .get_prompts("dsh")
        .unwrap()
        .values()
        .any(|p| p.content == "Original instructions"));
    let skill = SkillService::create_local_skill(&state.db, "dsh-example", "Test DSH").unwrap();
    SkillService::toggle_app(&state.db, &skill.id, &AppType::Dsh, true).unwrap();
    assert!(home.join("skills/dsh-example/SKILL.md").exists());
    assert!(
        state
            .db
            .get_installed_skill(&skill.id)
            .unwrap()
            .unwrap()
            .apps
            .dsh
    );
    let group = SkillGroupService::create(&state, "DSH group", &AppType::Dsh).unwrap();
    state.db.set_current_skill_group_id("dsh", None).unwrap();
    SkillService::toggle_app(&state.db, &skill.id, &AppType::Dsh, false).unwrap();
    assert!(!home.join("skills/dsh-example").exists());
    assert!(SkillGroupService::apply(&state, &group.id, &AppType::Dsh)
        .unwrap()
        .is_empty());
    assert!(home.join("skills/dsh-example/SKILL.md").exists());
}
