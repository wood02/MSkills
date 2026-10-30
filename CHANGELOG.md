# MSkills changelog

## Unreleased

## v1.0.1 - 2026-10-30

- 修复导入的 Skill 删除后仍残留在共享目录或 Agent 目录中，导致再次扫描时重新出现的问题（[#9](https://github.com/wood02/MSkills/issues/9)，[#10](https://github.com/wood02/MSkills/pull/10)）。
- 目录清理失败时明确提示错误，并保留管理记录和源文件，方便重试。
- 共享原件内容与托管副本不一致时，先单独备份再清理，并提示备份位置；共享软链接仅删除链接本身，保留其目标文件。

## v1.0.0 - 2026-10-28

- Establish the independent MSkills project and its own documentation.
- Use MSkills names for packages, installers, links and generated files.
- Preserve read compatibility with legacy data, backups, sync manifests, preferences, deep links and conversation markers.
