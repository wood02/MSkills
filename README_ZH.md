# MSkills

MSkills 是一个本地桌面工具，用于集中管理 AI 编程工具的供应商配置、MCP、提示词、技能和会话。使用 React、TypeScript 和 Tauri 2 构建。

[English](README.md) · [中文](README_ZH.md) · [日本語](README_JA.md) · [Deutsch](README_DE.md)

## 功能

- 管理 Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build、OpenCode、OpenClaw、Hermes、MiniMax Code、Pi 和 [DeepSeek Harness（dsh）](docs/dsh-integration.md) 的配置；各工具支持的操作有所不同。
- 安装、分组、启用和更新 Skills，并同步到选中的工具。
- 管理 MCP 服务和提示词，查看本地会话及用量。
- 按需开启本地代理、模型映射和故障转移。
- 导出和恢复 SQL 备份，或使用 WebDAV / S3 同步配置和 Skills。

供应商的价格、服务条款及可用性由供应商决定。预设不表示 MSkills 与该供应商存在合作关系。

## 获取与运行

项目地址：[wood02/MSkills](https://github.com/wood02/MSkills)。安装包发布后从 [Releases](https://github.com/wood02/MSkills/releases) 获取，并核对对应版本的说明。包管理器中的原项目安装命令不适用于本项目。

本地开发需要 Node.js 20 或更新版本、pnpm 10.12.3、Rust 1.85 或更新版本，以及 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
git clone https://github.com/wood02/MSkills.git
cd MSkills
pnpm install --frozen-lockfile
pnpm dev
```

检查和构建：

```sh
pnpm typecheck
pnpm test:unit
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build
```

`pnpm build` 生成当前平台的安装产物。跨平台签名、公证和发布需要维护者单独配置，不能据此认为所有安装包已签名。

## 数据与兼容

默认数据目录为 `~/.mskills/`，数据库为 `mskills.db`，日志为 `logs/mskills.log`。自定义数据目录以设置中的路径为准。数据中可能包含供应商密钥和账号凭据，不要上传到 Git 仓库或公开问题附件。

升级前先退出 MSkills 并备份整个数据目录。已有自定义同步路径保留。

## 文档与反馈

- [使用指南](docs/user-manual/zh/README.md)
- [发布配置](docs/releasing.md)
- [参与开发](CONTRIBUTING.md)
- [问题反馈](https://github.com/wood02/MSkills/issues)
- [安全问题](SECURITY.md)

## 许可证

MSkills 采用 [MIT 许可证](LICENSE)。
