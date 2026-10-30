# MSkills

MSkills is a local desktop application for managing AI coding tools: providers, MCP servers, prompts, Skills, sessions and usage. Built with React, TypeScript and Tauri 2.

[中文](README_ZH.md) · [日本語](README_JA.md) · [Deutsch](README_DE.md)

## Features

- Manage configurations for Claude Code, Claude Desktop, Codex, Gemini CLI, Grok Build, OpenCode, OpenClaw, Hermes, MiniMax Code, Pi and [DeepSeek Harness (dsh)](docs/dsh-integration.md). Available operations differ by tool.
- Install, group, enable and update Skills across selected tools.
- Manage MCP servers and prompts; browse local sessions and usage.
- Optionally use the local proxy, model mapping and failover.
- Export SQL backups, or sync configuration and Skills over WebDAV / S3.

Provider presets do not imply a partnership. Check each provider’s services, pricing and terms independently.

## Development

Requirements: Node.js 20+, pnpm 10.12.3, Rust 1.85+ and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/wood02/MSkills.git
cd MSkills
pnpm install --frozen-lockfile
pnpm dev
```

```sh
pnpm typecheck
pnpm test:unit
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build
```

Get published installers from [MSkills Releases](https://github.com/wood02/MSkills/releases). Upstream package-manager entries install a different project. Signing, notarization and automated updates require separate release configuration; check each release’s notes.

## Data and upgrades

The default data directory is `~/.mskills/`; the database is `mskills.db` and the application log is `logs/mskills.log`. A configured directory override takes precedence. Configuration and backups may contain credentials: do not publish them.

Quit MSkills and back up the complete data directory before upgrading. Existing sync locations remain unchanged.

## Documentation

- [User manual](docs/user-manual/en/README.md)
- [Release configuration](docs/releasing.md)
- [Contributing](CONTRIBUTING.md)
- [Issues](https://github.com/wood02/MSkills/issues)
- [Security](SECURITY.md)

## License

MSkills is released under the [MIT License](LICENSE).
