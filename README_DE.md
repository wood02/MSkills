# MSkills

MSkills ist eine lokale Desktop-Anwendung zur Verwaltung von Anbietern, MCP-Servern, Prompts, Skills, Sitzungen und Nutzungsdaten für KI-Programmierwerkzeuge. Sie verwendet React, TypeScript und Tauri 2.

[English](README.md) · [中文](README_ZH.md) · [日本語](README_JA.md)

## Entwicklung

Voraussetzungen: Node.js 20+, pnpm 10.12.3, Rust 1.85+ und die [Tauri-2-Systemabhängigkeiten](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/wood02/MSkills.git
cd MSkills
pnpm install --frozen-lockfile
pnpm dev
```

Prüfung: `pnpm typecheck`, `pnpm test:unit` und `cargo test --manifest-path src-tauri/Cargo.toml`. `pnpm build` erstellt das Paket für die aktuelle Plattform.

## Daten und Updates

Standardverzeichnis: `~/.mskills/`; Datenbank: `mskills.db`; Protokoll: `logs/mskills.log`. Vor dem Upgrade MSkills beenden und das vollständige Datenverzeichnis sichern.

Veröffentlichte Pakete stehen unter [Releases](https://github.com/wood02/MSkills/releases). Signierung, Beglaubigung und automatische Updates müssen separat eingerichtet werden. Anbieter-Vorlagen bedeuten keine Partnerschaft.

[Handbuch auf Englisch](docs/user-manual/en/README.md) · [Probleme melden](https://github.com/wood02/MSkills/issues)

MSkills steht unter der [MIT-Lizenz](LICENSE).
