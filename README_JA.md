# MSkills

MSkills は AI コーディングツールのプロバイダー、MCP、プロンプト、Skills、セッションと使用量を管理するローカルデスクトップアプリです。React、TypeScript、Tauri 2 を使用しています。

[English](README.md) · [中文](README_ZH.md) · [Deutsch](README_DE.md)

## 開発

Node.js 20 以降、pnpm 10.12.3、Rust 1.85 以降、および [Tauri 2 のシステム依存関係](https://v2.tauri.app/start/prerequisites/) が必要です。

```sh
git clone https://github.com/wood02/MSkills.git
cd MSkills
pnpm install --frozen-lockfile
pnpm dev
```

検証には `pnpm typecheck`、`pnpm test:unit`、`cargo test --manifest-path src-tauri/Cargo.toml` を使用し、`pnpm build` で現在のプラットフォーム向けにビルドします。

## データとアップグレード

標準データディレクトリは `~/.mskills/`、データベースは `mskills.db`、ログは `logs/mskills.log` です。アップグレード前に MSkills を終了し、データディレクトリ全体をバックアップしてください。

公開されたインストーラーは [Releases](https://github.com/wood02/MSkills/releases) から取得してください。署名、公証、自動更新は別途設定が必要です。プロバイダーのプリセットは提携関係を示すものではありません。

[ユーザーマニュアル](docs/user-manual/ja/README.md) · [問題の報告](https://github.com/wood02/MSkills/issues)

MSkills は [MIT ライセンス](LICENSE) で公開されています。
