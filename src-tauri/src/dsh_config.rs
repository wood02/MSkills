//! DeepSeek Harness profile patches. Model selection and account login stay native.
use crate::{
    config::{atomic_write_private, get_home_dir},
    error::AppError,
};
use indexmap::IndexMap;
use serde_json::{json, Value};
use serde_yaml::Value as Yaml;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) fn home_dir() -> PathBuf {
    let home = get_home_dir();
    let value = std::env::var("DSH_HOME").unwrap_or_default();
    let value = value.trim();
    if value.is_empty() {
        home.join(".dsh")
    } else if value == "~" {
        home
    } else if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        home.join(rest)
    } else {
        PathBuf::from(value)
    }
}

pub(crate) fn profile_name(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or("web")
        .into()
}

pub(crate) fn profile_dir() -> Result<PathBuf, AppError> {
    let profile = profile_name(crate::settings::get_settings().dsh_profile.as_deref());
    if !profile
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(AppError::InvalidInput("Invalid DSH profile name".into()));
    }
    Ok(home_dir().join("profiles").join(profile))
}

pub(crate) fn config_path() -> Result<PathBuf, AppError> {
    Ok(profile_dir()?.join("cordis.patch.yml"))
}

// Use DSH's exclusive <file>.lock protocol. A lock is stale only when it names a process that has exited.
struct FileLock(PathBuf);

fn clear_stale_lock(lock: &Path) -> bool {
    let Ok(text) = fs::read_to_string(lock) else {
        return false;
    };
    let Ok(pid) = text.trim().parse::<u32>() else {
        return false;
    };
    if pid == 0 || process_alive(pid) {
        return false;
    }
    // shortcut: re-reading narrows but does not close the race with another cleaner; fine while MSkills is single-instance.
    fs::read_to_string(lock).is_ok_and(|now| now == text) && fs::remove_file(lock).is_ok()
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return true;
    };
    // SAFETY: signal 0 performs only the existence and permission check.
    let alive = unsafe { libc::kill(pid, 0) == 0 };
    alive || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: the handle is checked for null and closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() != ERROR_INVALID_PARAMETER;
        }
        let mut code = 0u32;
        let queried = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        !queried || code == STILL_ACTIVE as u32
    }
}

impl FileLock {
    fn acquire(path: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(
            path.parent()
                .ok_or_else(|| AppError::Config("Invalid DSH path".into()))?,
        )
        .map_err(|e| AppError::io(path, e))?;
        let lock = PathBuf::from(format!("{}.lock", path.display()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let busy = |e: std::io::Error| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                AppError::Conflict(
                    "DSH configuration is busy; retry after its current save finishes".into(),
                )
            } else {
                AppError::io(&lock, e)
            }
        };
        let mut file = match options.open(&lock) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && clear_stale_lock(&lock) => {
                options.open(&lock).map_err(busy)?
            }
            Err(e) => return Err(busy(e)),
        };
        let guard = Self(lock.clone());
        writeln!(file, "{}", std::process::id()).map_err(|e| AppError::io(&lock, e))?;
        Ok(guard)
    }
}
impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn read_yaml(path: &Path, empty: Yaml) -> Result<Yaml, AppError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty),
        Err(e) => return Err(AppError::io(path, e)),
    };
    // serde_yaml discards global !!js tags. Refuse before parsing rather than turn code into literal strings.
    if text.contains("!!js") || text.contains("tag:yaml.org,2002:js") {
        return Err(AppError::Config(format!("DSH YAML contains JavaScript expressions; edit it in DSH to preserve its dynamic configuration: {}",path.display())));
    }
    let value: Yaml = serde_yaml::from_str(&text)
        .map_err(|_| AppError::Config(format!("Invalid DSH YAML: {}", path.display())))?;
    Ok(if value.is_null() { empty } else { value })
}

fn read_patch(path: &Path) -> Result<Vec<Yaml>, AppError> {
    read_yaml(path, Yaml::Sequence(vec![]))?
        .as_sequence()
        .cloned()
        .ok_or_else(|| AppError::Config("DSH patch must be a YAML sequence".into()))
}

fn write_yaml(path: &Path, value: &Yaml) -> Result<(), AppError> {
    let text = serde_yaml::to_string(value)
        .map_err(|_| AppError::Config("Cannot encode DSH configuration".into()))?;
    atomic_write_private(path, text.as_bytes())
}

fn provider_row(rows: &[Yaml]) -> Result<Option<usize>, AppError> {
    let found: Vec<_> = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| r["id"].as_str() == Some("llm-pi-ai") && r["insert"].is_null())
        .map(|(i, _)| i)
        .collect();
    if found.len() > 1 {
        return Err(AppError::Config(
            "Multiple DSH llm-pi-ai overrides; consolidate them in DSH before editing".into(),
        ));
    }
    Ok(found.first().copied())
}

fn providers_from_rows(rows: &[Yaml]) -> Result<IndexMap<String, Value>, AppError> {
    let Some(index) = provider_row(rows)? else {
        return Ok(IndexMap::new());
    };
    let config = &rows[index]["config"];
    if !config.is_null() && !config.is_mapping() {
        return Err(AppError::Config(
            "DSH provider config must be a mapping".into(),
        ));
    }
    let providers = &config["providers"];
    if providers.is_null() {
        return Ok(IndexMap::new());
    }
    serde_yaml::from_value(providers.clone()).map_err(|_| {
        AppError::Config("DSH providers contain dynamic expressions; edit them in DSH".into())
    })
}

pub(crate) fn get_providers() -> Result<IndexMap<String, Value>, AppError> {
    guard_home_override(&home_dir())?;
    let rows = read_patch(&config_path()?)?;
    let mut providers = providers_from_rows(&rows)?;
    // Import references, never OAuth/account records or stored secrets.
    for config in providers.values_mut() {
        if let Some(object) = config.as_object_mut() {
            object.remove("apiKey");
        }
    }
    Ok(providers)
}

pub(crate) fn validate_provider(id: &str, config: &Value) -> Result<(), AppError> {
    if id.is_empty()
        || !id.starts_with(|c: char| c.is_ascii_lowercase())
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || id == "deepseek"
    {
        return Err(AppError::InvalidInput("DSH provider ID must be lowercase letters, digits or hyphens; use a custom ID instead of the reserved deepseek route".into()));
    }
    if !config.is_object() {
        return Err(AppError::InvalidInput(
            "DSH provider must be an object".into(),
        ));
    }
    if let Some(reference) = config.get("apiKeyEnv") {
        let reference = reference.as_str().unwrap_or("");
        if reference.is_empty()
            || !reference.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            || !reference
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err(AppError::InvalidInput(
                "Invalid DSH credential reference".into(),
            ));
        }
    }
    if let Some(api) = config.get("api") {
        if !matches!(
            api.as_str(),
            Some("openai-completions" | "openai-responses" | "anthropic-messages")
        ) {
            return Err(AppError::InvalidInput(
                "Unsupported DSH custom API protocol".into(),
            ));
        }
    }
    if let Some(url) = config.get("baseURL") {
        let url = url
            .as_str()
            .and_then(|s| url::Url::parse(s).ok())
            .filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some());
        if url.is_none() {
            return Err(AppError::InvalidInput(
                "DSH baseURL must be an HTTP(S) URL".into(),
            ));
        }
    }
    if let Some(models) = config.get("models") {
        let models = models
            .as_array()
            .filter(|a| !a.is_empty())
            .ok_or_else(|| AppError::InvalidInput("DSH models must be a nonempty array".into()))?;
        let mut ids = std::collections::HashSet::new();
        for model in models {
            let id = model["id"]
                .as_str()
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| AppError::InvalidInput("Every DSH model needs an ID".into()))?;
            if !ids.insert(id) {
                return Err(AppError::InvalidInput("Duplicate DSH model ID".into()));
            }
        }
    }
    if config.get("api").is_some()
        && (config.get("baseURL").is_none() || config.get("models").is_none())
    {
        return Err(AppError::InvalidInput(
            "Custom DSH routes need a base URL and at least one model".into(),
        ));
    }
    if config.get("models").is_some() && config.get("modelOverrides").is_some() {
        return Err(AppError::InvalidInput(
            "DSH models and modelOverrides are mutually exclusive".into(),
        ));
    }
    Ok(())
}

fn patch_provider(rows: &mut Vec<Yaml>, id: &str, config: Option<Value>) -> Result<(), AppError> {
    let mut providers = providers_from_rows(rows)?;
    if let Some(config) = config {
        providers.insert(id.into(), config);
    } else {
        providers.shift_remove(id);
    }
    let index = if let Some(index) = provider_row(rows)? {
        index
    } else {
        rows.push(serde_yaml::from_str("id: llm-pi-ai\nconfig: {}\n").unwrap());
        rows.len() - 1
    };
    if rows[index]["config"].is_null() {
        rows[index]["config"] = Yaml::Mapping(Default::default());
    }
    rows[index]["config"]["providers"] = serde_yaml::to_value(providers)
        .map_err(|_| AppError::Config("Invalid DSH provider".into()))?;
    Ok(())
}

fn guard_home_override(home: &Path) -> Result<(), AppError> {
    if read_patch(&home.join("cordis.patch.yml"))?
        .iter()
        .any(|r| r["id"].as_str() == Some("llm-pi-ai") && !r["config"].is_null())
    {
        return Err(AppError::Conflict("DSH home patch overrides llm-pi-ai; edit that configuration in DSH before managing profile providers".into()));
    }
    Ok(())
}

pub(crate) fn set_provider(id: &str, config: Value) -> Result<(), AppError> {
    validate_provider(id, &config)?;
    update_provider(&home_dir(), &profile_dir()?, id, Some(config))
}
pub(crate) fn remove_provider_and_commit<T>(
    id: &str,
    commit: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    update_provider_and_commit(&home_dir(), &profile_dir()?, id, None, commit)
}
pub(crate) fn remove_provider(id: &str) -> Result<(), AppError> {
    update_provider(&home_dir(), &profile_dir()?, id, None)
}

fn update_provider(
    home: &Path,
    profile: &Path,
    id: &str,
    config: Option<Value>,
) -> Result<(), AppError> {
    update_provider_and_commit(home, profile, id, config, || Ok(()))
}

pub(crate) fn save_provider_and_commit<T>(
    id: &str,
    config: Value,
    commit: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    validate_provider(id, &config)?;
    update_provider_and_commit(&home_dir(), &profile_dir()?, id, Some(config), commit)
}

fn snapshot(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::io(path, e)),
    }
}

fn update_provider_and_commit<T>(
    home: &Path,
    profile: &Path,
    id: &str,
    config: Option<Value>,
    commit: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let _lock = FileLock::acquire(&profile.join("package.json"))?;
    guard_home_override(home)?;
    let path = profile.join("cordis.patch.yml");
    let before = snapshot(&path)?;
    let mut rows = read_patch(&path)?;
    let mut config = config;
    let secret = config
        .as_mut()
        .and_then(|c| c.as_object_mut())
        .and_then(|c| c.remove("apiKey"));
    let credentials_path = home.join(".credentials.yaml");
    let _credentials_lock = if secret.is_some() {
        Some(FileLock::acquire(&credentials_path)?)
    } else {
        None
    };
    let credentials_before = if secret.is_some() {
        Some(snapshot(&credentials_path)?)
    } else {
        None
    };
    let mut credentials = None;
    if let Some(secret) = secret {
        let secret = secret.as_str().filter(|s| !s.is_empty()).ok_or_else(|| {
            AppError::InvalidInput("DSH API key must be a nonempty string".into())
        })?;
        use sha2::{Digest, Sha256};
        let reference = format!("MSKILLS_DSH_{:x}", Sha256::digest(id.as_bytes()));
        let mut document = read_yaml(
            &credentials_path,
            serde_yaml::from_str("version: 1\nrefs: {}\n").unwrap(),
        )?;
        if document["version"].as_u64() != Some(1)
            || (!document["refs"].is_null() && !document["refs"].is_mapping())
        {
            return Err(AppError::Config(
                "Unsupported DSH credentials layout; update it in DSH first".into(),
            ));
        }
        if document["refs"].is_null() {
            document["refs"] = Yaml::Mapping(Default::default());
        }
        document["refs"][reference.as_str()] = Yaml::String(secret.into());
        config.as_mut().unwrap()["apiKeyEnv"] = json!(reference);
        credentials = Some(document);
    }
    patch_provider(&mut rows, id, config)?;
    let result = (|| {
        if let Some(credentials) = credentials {
            write_yaml(&credentials_path, &credentials)?;
        }
        write_yaml(&path, &Yaml::Sequence(rows))?;
        commit()
    })();
    if result.is_err() {
        restore(&path, before)?;
        if let Some(previous) = credentials_before {
            restore(&credentials_path, previous)?;
        }
    }
    result
}

fn restore(path: &Path, before: Option<Vec<u8>>) -> Result<(), AppError> {
    match before {
        Some(bytes) => atomic_write_private(path, &bytes),
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::io(path, e)),
        },
    }
}

pub(crate) fn sync_mcp(id: &str, spec: Option<&Value>) -> Result<(), AppError> {
    sync_mcp_and_commit(id, spec, || Ok(()))
}

pub(crate) fn sync_mcp_and_commit<T>(
    id: &str,
    spec: Option<&Value>,
    commit: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    mutate_mcp(&profile_dir()?, id, spec, false, commit)
}

pub(crate) fn delete_mcp_and_commit<T>(
    id: &str,
    commit: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    mutate_mcp(&profile_dir()?, id, None, true, commit)
}

/// Whether the selected profile still holds a (possibly disabled) row for this server.
pub(crate) fn has_mcp(id: &str) -> bool {
    let name = mcp_name(id);
    let row_id = format!("mskills-mcp-{name}");
    config_path()
        .and_then(|path| read_patch(&path))
        .is_ok_and(|rows| {
            rows.iter()
                .filter_map(|r| r["insert"].as_sequence())
                .flatten()
                .any(|r| is_mcp_entry(r, &row_id, &name))
        })
}

fn is_mcp_entry(entry: &Yaml, row_id: &str, name: &str) -> bool {
    entry["id"].as_str() == Some(row_id)
        || (entry["name"].as_str() == Some("@deepseek-ai/dsh-mcp-client")
            && entry["config"]["serverName"].as_str() == Some(name))
}

fn mutate_mcp<T>(
    profile: &Path,
    id: &str,
    spec: Option<&Value>,
    delete: bool,
    commit: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let _lock = FileLock::acquire(&profile.join("package.json"))?;
    let path = profile.join("cordis.patch.yml");
    let before = match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(AppError::io(&path, e)),
    };
    let mut rows = read_patch(&path)?;
    patch_mcp(&mut rows, id, spec, delete)?;
    write_yaml(&path, &Yaml::Sequence(rows))?;
    match commit() {
        Ok(value) => Ok(value),
        Err(error) => {
            restore(&path, before)?;
            Err(error)
        }
    }
}

fn mcp_name(id: &str) -> String {
    if !id.is_empty()
        && id.len() <= 32
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
    {
        return id.into();
    }
    use sha2::{Digest, Sha256};
    format!("mskills-{:x}", Sha256::digest(id.as_bytes()))[..32].into()
}

fn patch_mcp(
    rows: &mut Vec<Yaml>,
    id: &str,
    spec: Option<&Value>,
    delete: bool,
) -> Result<(), AppError> {
    let name = mcp_name(id);
    let row_id = format!("mskills-mcp-{name}");
    if spec.is_none() && !delete {
        // Disable in place so fields tuned in DSH survive re-enabling.
        for entry in rows
            .iter_mut()
            .filter_map(|r| r["insert"].as_sequence_mut())
            .flatten()
            .filter(|r| is_mcp_entry(r, &row_id, &name))
        {
            entry["disabled"] = Yaml::Bool(true);
        }
        return Ok(());
    }
    let mut previous = None;
    for row in rows.iter_mut() {
        if let Some(inserts) = row["insert"].as_sequence_mut() {
            inserts.retain(|r| {
                let matches = is_mcp_entry(r, &row_id, &name);
                if matches {
                    previous = Some(r.clone());
                }
                !matches
            });
        }
    }
    rows.retain(|r| r["insert"].as_sequence().is_none_or(|a| !a.is_empty()));
    if let Some(spec) = spec {
        crate::mcp::validation::validate_server_spec(spec)?;
        let transport = match spec["type"]
            .as_str()
            .unwrap_or(if spec.get("command").is_some() {
                "stdio"
            } else {
                "http"
            }) {
            "stdio" => "stdio",
            "http" | "streamable-http" => "streamable-http",
            _ => {
                return Err(AppError::InvalidInput(
                    "DSH supports stdio and Streamable HTTP MCP transports".into(),
                ))
            }
        };
        let mut config = previous
            .as_ref()
            .map(|r| r["config"].clone())
            .unwrap_or_else(|| Yaml::Mapping(Default::default()));
        if !config.is_mapping() {
            return Err(AppError::Config(
                "Invalid native DSH MCP configuration".into(),
            ));
        }
        let object = config.as_mapping_mut().unwrap();
        for field in [
            "transport",
            "command",
            "args",
            "env",
            "cwd",
            "url",
            "headers",
        ] {
            object.remove(Yaml::String(field.into()));
        }
        for field in ["command", "args", "env", "cwd", "url", "headers"] {
            if let Some(value) = spec.get(field) {
                object.insert(
                    Yaml::String(field.into()),
                    serde_yaml::to_value(value)
                        .map_err(|_| AppError::InvalidInput("Invalid DSH MCP field".into()))?,
                );
            }
        }
        object.insert("transport".into(), Yaml::String(transport.into()));
        object.insert("serverName".into(), Yaml::String(name));
        let mut entry = previous.unwrap_or_else(|| {
            serde_yaml::to_value(json!({"id":row_id,"name":"@deepseek-ai/dsh-mcp-client"})).unwrap()
        });
        entry["config"] = config;
        entry
            .as_mapping_mut()
            .unwrap()
            .remove(Yaml::String("disabled".into()));
        let mut insert = serde_yaml::Mapping::new();
        insert.insert("insert".into(), Yaml::Sequence(vec![entry]));
        rows.push(Yaml::Mapping(insert));
    }
    Ok(())
}

pub(crate) fn import_mcp(state: &crate::store::AppState) -> Result<usize, AppError> {
    let rows = read_patch(&config_path()?)?;
    let existing = state.db.get_all_mcp_servers()?;
    let mut count = 0;
    for row in rows
        .iter()
        .filter_map(|r| r["insert"].as_sequence())
        .flatten()
    {
        if row["name"].as_str() != Some("@deepseek-ai/dsh-mcp-client") {
            continue;
        }
        let Ok(mut spec) = serde_yaml::from_value::<Value>(row["config"].clone()) else {
            continue;
        };
        let Some(id) = spec["serverName"].as_str().map(str::to_owned) else {
            continue;
        };
        let id = if row["id"].as_str() == Some(&format!("mskills-mcp-{id}")) {
            existing
                .keys()
                .find(|key| mcp_name(key) == id)
                .cloned()
                .unwrap_or(id)
        } else {
            id
        };
        spec["type"] = json!(match spec["transport"].as_str() {
            Some("stdio") => "stdio",
            Some("streamable-http") => "http",
            _ => continue,
        });
        spec.as_object_mut().unwrap().remove("transport");
        spec.as_object_mut().unwrap().remove("serverName");
        if crate::mcp::validation::validate_server_spec(&spec).is_err() {
            continue;
        }
        let enabled = row["disabled"].as_bool() != Some(true);
        if let Some(server) = existing.get(&id) {
            if server.server == spec {
                let mut server = server.clone();
                server.apps.dsh = enabled;
                state.db.save_mcp_server(&server)?;
            }
            continue;
        }
        state.db.save_mcp_server(&crate::app_config::McpServer {
            id: id.clone(),
            name: id,
            server: spec,
            apps: crate::app_config::McpApps {
                dsh: enabled,
                ..Default::default()
            },
            description: None,
            homepage: None,
            docs: None,
            tags: vec![],
        })?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dsh_rolls_back_patch_credentials_and_mcp_when_commit_fails() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("profiles/web");
        fs::create_dir_all(&profile).unwrap();
        let path = profile.join("cordis.patch.yml");
        let credentials = dir.path().join(".credentials.yaml");
        let before = "- id: untouched\n  config: {keep: true}\n";
        fs::write(&path, before).unwrap();
        let config = json!({"api":"openai-completions","baseURL":"https://example.com/v1","apiKey":"test-key","models":[{"id":"model"}]});
        assert!(update_provider_and_commit(
            dir.path(),
            &profile,
            "gateway",
            Some(config),
            || Err::<(), _>(AppError::Database("read only".into()))
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        assert!(!credentials.exists());
        assert!(mutate_mcp(
            &profile,
            "echo",
            Some(&json!({"command":"node"})),
            false,
            || Err::<(), _>(AppError::Database("read only".into()))
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
    }
    #[test]
    fn dsh_refuses_expression_documents_without_changing_their_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("profiles/web");
        fs::create_dir_all(&profile).unwrap();
        let path = profile.join("cordis.patch.yml");
        for before in ["- id: unrelated\n  config:\n    value: !!js process.cwd()\n", "- id: llm-pi-ai\n  config:\n    providers: !<tag:yaml.org,2002:js> process.env.PROVIDERS\n"] {
            fs::write(&path,before).unwrap();assert!(update_provider(dir.path(),&profile,"gateway",Some(json!({"apiKeyEnv":"KEY"}))).is_err());assert_eq!(fs::read_to_string(&path).unwrap(),before);
        }
    }
    #[test]
    fn dsh_provider_patch_preserves_neighbors_and_uses_credential_reference() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("profiles/web");
        fs::create_dir_all(&profile).unwrap();
        let path = profile.join("cordis.patch.yml");
        fs::write(&path,"- id: other\n  config: {keep: true}\n- id: llm-pi-ai\n  config:\n    unknown: keep\n    providers:\n      native: {apiKeyEnv: NATIVE_KEY}\n").unwrap();
        let config = json!({"api":"openai-completions","baseURL":"https://example.com/v1","apiKey":"test-key","models":[{"id":"test"}]});
        validate_provider("gateway", &config).unwrap();
        update_provider(dir.path(), &profile, "gateway", Some(config)).unwrap();
        let rows = read_patch(&path).unwrap();
        assert_eq!(rows[0]["config"]["keep"].as_bool(), Some(true));
        assert_eq!(rows[1]["config"]["unknown"].as_str(), Some("keep"));
        let providers = providers_from_rows(&rows).unwrap();
        assert!(providers.contains_key("native"));
        assert!(providers["gateway"].get("apiKey").is_none());
        let credentials = read_yaml(&dir.path().join(".credentials.yaml"), Yaml::Null).unwrap();
        let reference = providers["gateway"]["apiKeyEnv"].as_str().unwrap();
        assert_eq!(credentials["refs"][reference].as_str(), Some("test-key"));
        update_provider(dir.path(), &profile, "gateway", None).unwrap();
        assert!(providers_from_rows(&read_patch(&path).unwrap())
            .unwrap()
            .contains_key("native"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.path().join(".credentials.yaml"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn dsh_mcp_transports_and_removal_preserve_other_plugins() {
        let mut rows = vec![serde_yaml::from_str("id: unrelated\nconfig: {keep: true}").unwrap()];
        patch_mcp(&mut rows,"echo",Some(&json!({"type":"stdio","command":"node","args":["server.js"],"env":{"KEY":"value"}})),false).unwrap();
        assert_eq!(
            rows[1]["insert"][0]["config"]["transport"].as_str(),
            Some("stdio")
        );
        patch_mcp(
            &mut rows,
            "remote",
            Some(&json!({"type":"http","url":"https://example.com/mcp"})),
            false,
        )
        .unwrap();
        assert_eq!(
            rows[2]["insert"][0]["config"]["transport"].as_str(),
            Some("streamable-http")
        );
        assert!(patch_mcp(
            &mut rows,
            "bad",
            Some(&json!({"type":"sse","url":"https://example.com/sse"})),
            false,
        )
        .is_err());
        // Disabling keeps DSH-side tuning; re-enabling clears the flag without losing it.
        rows[1]["insert"][0]["config"]["timeout"] = Yaml::Number(30.into());
        patch_mcp(&mut rows, "echo", None, false).unwrap();
        assert_eq!(rows[1]["insert"][0]["disabled"].as_bool(), Some(true));
        patch_mcp(&mut rows, "echo", Some(&json!({"command":"node"})), false).unwrap();
        let echo = &rows[2]["insert"][0];
        assert!(echo["disabled"].is_null());
        assert_eq!(echo["config"]["timeout"].as_u64(), Some(30));
        patch_mcp(&mut rows, "echo", None, true).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"].as_str(), Some("unrelated"));
    }
    #[test]
    fn dsh_clears_only_locks_of_exited_processes() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("package.json");
        let lock = dir.path().join("package.json.lock");
        let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" })
            .args(if cfg!(windows) {
                &["/C", "exit"][..]
            } else {
                &[][..]
            })
            .spawn()
            .unwrap();
        child.wait().unwrap();
        fs::write(&lock, format!("{}\n", child.id())).unwrap();
        drop(FileLock::acquire(&target).unwrap());
        assert!(!lock.exists());
        for held in [format!("{}\n", std::process::id()), "not-a-pid\n".into()] {
            fs::write(&lock, &held).unwrap();
            assert!(FileLock::acquire(&target).is_err());
            assert_eq!(fs::read_to_string(&lock).unwrap(), held);
        }
    }
    #[test]
    fn dsh_profile_name_falls_back_to_web() {
        assert_eq!(profile_name(None), "web");
        assert_eq!(profile_name(Some("  ")), "web");
        assert_eq!(profile_name(Some(" desktop ")), "desktop");
    }
    #[test]
    fn dsh_refuses_busy_malformed_and_shadowed_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("profiles/web");
        fs::create_dir_all(&profile).unwrap();
        let path = profile.join("cordis.patch.yml");
        fs::write(&path, "invalid: document").unwrap();
        assert!(update_provider(dir.path(), &profile, "test", None).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "invalid: document");
        fs::write(&path, "[]").unwrap();
        let lock = FileLock::acquire(&profile.join("package.json")).unwrap();
        assert!(update_provider(dir.path(), &profile, "test", None).is_err());
        drop(lock);
        fs::write(
            dir.path().join("cordis.patch.yml"),
            "- id: llm-pi-ai\n  config: {providers: {}}\n",
        )
        .unwrap();
        assert!(update_provider(dir.path(), &profile, "test", None).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "[]");
    }
}
