# MSkills 发布配置

仓库默认分支为 `mskills`。CI 监听该分支，发布工作流由 `v*` 标签触发；创建标签前先完成类型检查、单元测试、Rust 测试及目标平台构建。

## 平台与产物

产物统一以 `MSkills-` 命名；Rust 二进制为 `mskills`，库为 `mskills_lib`，应用标识为 `com.mskills.desktop`。Flatpak 使用同名应用标识。

发布前核对包内可执行文件、安装路径、深链接协议和升级行为。macOS、Windows、Linux 的签名和安装检查需要分别执行。

## Secrets 与更新

GitHub 新仓库不会继承旧仓库的 Secrets、环境保护、发行记录和分支保护。发布流程所需的 Apple 签名、公证和 Tauri 更新密钥必须由维护者配置。

Tauri 自动更新端点当前为空，默认不生成 updater 产物。启用自动更新前配置 MSkills 自己的公钥、私钥和端点，并验证签名；不要沿用无法控制的上游发布源。

R2 镜像默认关闭。需要时设置变量 `R2_MIRROR_ENABLED=true`、`R2_BUCKET`、`R2_PUBLIC_BASE_URL`，并配置 `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` Secrets。未配置时不自动向任何镜像发布。

仓库首页和发行说明只链接本项目 GitHub 地址。没有单独配置域名、包管理器条目或应用商店条目前，不声明这些分发渠道已可用。
