use crate::error::AppError;
use auto_launch::{AutoLaunch, AutoLaunchBuilder};

/// 获取 macOS 上的 .app bundle 路径
/// 将 `/path/to/MSkills.app/Contents/MacOS/MSkills` 转换为 `/path/to/MSkills.app`
#[cfg(target_os = "macos")]
fn get_macos_app_bundle_path(exe_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let path_str = exe_path.to_string_lossy();
    // 查找 .app/Contents/MacOS/ 模式
    if let Some(app_pos) = path_str.find(".app/Contents/MacOS/") {
        let app_bundle_end = app_pos + 4; // ".app" 的结束位置
        Some(std::path::PathBuf::from(&path_str[..app_bundle_end]))
    } else {
        None
    }
}

/// 初始化 AutoLaunch 实例
fn get_auto_launch() -> Result<AutoLaunch, AppError> {
    get_named_auto_launch("MSkills")
}

fn get_named_auto_launch(app_name: &str) -> Result<AutoLaunch, AppError> {
    let exe_path =
        std::env::current_exe().map_err(|e| AppError::Message(format!("无法获取应用路径: {e}")))?;

    // macOS 需要使用 .app bundle 路径，否则 AppleScript login item 会打开终端
    #[cfg(target_os = "macos")]
    let app_path = get_macos_app_bundle_path(&exe_path).unwrap_or(exe_path);

    #[cfg(not(target_os = "macos"))]
    let app_path = exe_path;

    // 使用 AutoLaunchBuilder 消除平台差异
    // macOS: 使用 AppleScript 方式（默认），需要 .app bundle 路径
    // Windows/Linux: 使用注册表/XDG autostart
    let auto_launch = AutoLaunchBuilder::new()
        .set_app_name(app_name)
        .set_app_path(&app_path.to_string_lossy())
        .build()
        .map_err(|e| AppError::Message(format!("创建 AutoLaunch 失败: {e}")))?;

    Ok(auto_launch)
}

// An independently installed upstream app must keep its own startup registration.
fn legacy_startup_targets_this_app() -> bool {
    let current = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => return false,
    };
    #[cfg(target_os = "macos")]
    let current = get_macos_app_bundle_path(&current).unwrap_or(current);
    #[cfg(target_os = "macos")]
    let target = std::process::Command::new("osascript")
        .args([
            "-e",
            "tell application \"System Events\" to get the path of login item \"CC Switch\"",
        ])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string());
    #[cfg(target_os = "linux")]
    let target = dirs::home_dir()
        .and_then(|home| {
            std::fs::read_to_string(home.join(".config/autostart/CC Switch.desktop")).ok()
        })
        .and_then(|text| {
            text.lines()
                .find_map(|line| line.strip_prefix("Exec=").map(str::to_string))
        });
    #[cfg(target_os = "windows")]
    let target = {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
            .ok()
            .and_then(|key| {
                key.get_value::<String, _>(crate::compat::LEGACY_APP_NAME)
                    .ok()
            })
    };
    target.is_some_and(|target| startup_target_matches(&target, &current))
}

fn startup_target_matches(target: &str, current: &std::path::Path) -> bool {
    let target = std::path::Path::new(target.trim().trim_matches('"'));
    if target == current {
        return true;
    }
    // Old executable names are accepted only after the old executable is gone.
    !target.exists()
        && target.parent() == current.parent()
        && matches!(
            target.file_name().and_then(|name| name.to_str()),
            Some("cc-switch" | "cc-switch.exe")
        )
}

fn disable_owned_legacy_startup() -> Result<(), AppError> {
    if legacy_startup_targets_this_app() {
        get_named_auto_launch(crate::compat::LEGACY_APP_NAME)?
            .disable()
            .map_err(|e| AppError::Message(format!("迁移旧启动项失败: {e}")))?;
    }
    Ok(())
}

fn legacy_startup_is_enabled() -> Result<bool, AppError> {
    if !legacy_startup_targets_this_app() {
        return Ok(false);
    }
    get_named_auto_launch(crate::compat::LEGACY_APP_NAME)?
        .is_enabled()
        .map_err(|e| AppError::Message(format!("检查旧启动项失败: {e}")))
}

pub(crate) fn migrate_legacy_auto_launch() -> Result<(), AppError> {
    if legacy_startup_is_enabled()? {
        enable_auto_launch()?;
    }
    Ok(())
}

/// 启用开机自启
pub fn enable_auto_launch() -> Result<(), AppError> {
    let auto_launch = get_auto_launch()?;
    auto_launch
        .enable()
        .map_err(|e| AppError::Message(format!("启用开机自启失败: {e}")))?;
    disable_owned_legacy_startup()?;
    log::info!("已启用开机自启");
    Ok(())
}

/// 禁用开机自启
pub fn disable_auto_launch() -> Result<(), AppError> {
    let auto_launch = get_auto_launch()?;
    if auto_launch
        .is_enabled()
        .map_err(|e| AppError::Message(format!("检查开机自启状态失败: {e}")))?
    {
        auto_launch
            .disable()
            .map_err(|e| AppError::Message(format!("禁用开机自启失败: {e}")))?;
    }
    disable_owned_legacy_startup()?;
    log::info!("已禁用开机自启");
    Ok(())
}

/// 检查是否已启用开机自启
pub fn is_auto_launch_enabled() -> Result<bool, AppError> {
    let auto_launch = get_auto_launch()?;
    if legacy_startup_is_enabled()? {
        return Ok(true);
    }
    auto_launch
        .is_enabled()
        .map_err(|e| AppError::Message(format!("检查开机自启状态失败: {e}")))
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    fn legacy_startup_does_not_take_over_another_installed_app() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join("mskills");
        let old = dir.path().join("cc-switch");
        assert!(startup_target_matches(old.to_str().unwrap(), &current));
        std::fs::write(&old, "existing installation").unwrap();
        assert!(!startup_target_matches(old.to_str().unwrap(), &current));
        assert!(startup_target_matches(current.to_str().unwrap(), &current));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_valid() {
        let exe_path = std::path::Path::new("/Applications/MSkills.app/Contents/MacOS/mskills");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(
            result,
            Some(std::path::PathBuf::from("/Applications/MSkills.app"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_with_spaces() {
        let exe_path =
            std::path::Path::new("/Users/test/My Apps/MSkills.app/Contents/MacOS/MSkills");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(
            result,
            Some(std::path::PathBuf::from("/Users/test/My Apps/MSkills.app"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_not_in_bundle() {
        let exe_path = std::path::Path::new("/usr/local/bin/mskills");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(result, None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_dev_build() {
        // 开发环境下的路径通常不在 .app bundle 内
        let exe_path = std::path::Path::new("/Users/dev/project/target/debug/mskills");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(result, None);
    }
}
