# MSkills changelog

## Unreleased

## v1.0.3 - 2026-10-30

- 支持 DeepSeek Harness (dsh)：管理 MCP、全局指令和 Skills，并可浏览本地会话（含 zstd 日志）。
- 写入 dsh 配置时遵循其原生文件锁，自动清理已退出进程留下的锁；关闭 MCP 时保留原有配置并标记 `disabled`，删除时才移除；切换 profile 后立即同步已启用的 MCP。
- macOS 安装包改为仅支持 Apple Silicon，不再提供 Intel Mac 版本；Intel Mac 用户请继续使用 v1.0.2，应用内也不会收到本版及后续更新。

## v1.0.2 - 2026-10-30

- 接通 GitHub Releases 应用内更新：启动检查新版本，展示更新说明，用户确认后下载、验证签名并安装重启。
- 配置独立更新签名公钥和更新地址；发布时校验全部更新包并生成完整的 `latest.json`，缺少更新包或签名不匹配时阻止发布。
- Windows 绿色版和 Linux deb/rpm 保留手动下载安装流程。
- 从 v1.0.0 / v1.0.1 升级时，请先手动下载安装 v1.0.2；后续版本可使用本次接通的应用内更新。

## v1.0.1 - 2026-10-30

- 修复导入的 Skill 删除后仍残留在共享目录或 Agent 目录中，导致再次扫描时重新出现的问题（[#9](https://github.com/wood02/MSkills/issues/9)，[#10](https://github.com/wood02/MSkills/pull/10)）。
- 目录清理失败时明确提示错误，并保留管理记录和源文件，方便重试。
- 共享原件内容与托管副本不一致时，先单独备份再清理，并提示备份位置；共享软链接仅删除链接本身，保留其目标文件。

## v1.0.0 - 2026-10-28

- Establish the independent MSkills project and its own documentation.
- Use MSkills names for packages, installers, links and generated files.
- Preserve read compatibility with legacy data, backups, sync manifests, preferences, deep links and conversation markers.
