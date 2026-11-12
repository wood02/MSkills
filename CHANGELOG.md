# MSkills changelog

## Unreleased

## v1.0.8 - 2026-11-12

- 多提示词分段拼接、拖拽排序与双向同步：
  - 支持在同一目标文件（`CLAUDE.md`、`AGENTS.md`、`GEMINI.md`、`SOUL.md` 等）中通过 `<!-- mskills:start/end id="..." -->` 分段标记同时启用并拼接多条提示词，兼容保留手动外部内容（如 `@RTK.md`）。
  - 支持通过 `@dnd-kit` 拖拽调整多条提示词顺序，并支持在“查看拼接结果”中直接在线编辑后同步回写对应提示词；恢复备份或导入 SQL 时自动排除旧库无标记提示词残留。
- RTK Token 优化看板与品牌图标补全：
  - 新增 RTK CLI 检测、历史节省 Token 统计与多端 Agent 一键接入状态管理（`RtkDashboard` / `RtkService`）。
  - 补充 Cursor CLI（`cursor.svg`）、Droid（`factory.svg`）、Cline（`cline.svg`）品牌矢量图标，并优化 Skills 仓库头像展示与本地缓存。

## v1.0.7 - 2026-11-11

- Skill 使用统计支持 Token 维度消耗与趋势展示：
  - 后端数据库升级至 Schema v26，在 Skill 使用事件中引入 `input_tokens`、`output_tokens` 与 `cache_read_tokens`，自动重置同步游标以重新解析带 Token 的历史会话记录。
  - 支持解析各客户端（Claude、Codex、Hermes、Gemini、Antigravity 等）的 Token 使用数据，并自动估算 Skill 文档基准 Token 消耗。
  - 前端使用统计支持“频次”与“Token”双模式切换，趋势图柱状分段按比例精细展示 Output 与 Input Token 消耗，并支持列表项 Token 消耗排序与快捷徽章展示。

## v1.0.6 - 2026-11-10

- 支持 Skill 目录文件树浏览与多文件预览/编辑：
  - 后端支持递归安全扫描 Skill 托管目录内的文件结构（忽略 `.git`、`node_modules`、`__pycache__` 等缓存并限制最大深度），支持任意合法文本附属文件的读取与保存。
  - 前端详情抽屉新增可折叠的文件目录树侧边栏，按层级展示文件大小与类型，并适配 Markdown 预览与代码高亮编辑。
  - 保存与切换时提供未保存草稿保护（丢弃确认），编辑附属文件时保留原元数据并执行多端应用同步。

## v1.0.5 - 2026-11-09

- 支持 Google Antigravity (AGY)：
  - 支持 Antigravity 配置目录（`~/.gemini/config`）与数据运行目录（`~/.gemini/antigravity`）的自动检测、自定义设置与路径重置。
  - 支持 MCP 配置双向读写同步（`~/.gemini/config/mcp_config.json`），适配 stdio、http、sse 协议及环境变量规范转换。
  - 支持会话管理器（Session Manager）浏览 Antigravity 会话历史与日志。
  - 技能统计（Skill Usage）支持解析 Antigravity 会话 transcript 日志，统计 Slash 技能指令及工具调用，支持基于游标的增量扫描与会话粒度调用去重。
  - 引入 Antigravity 官方品牌矢量图标与四色渐变高光样式（按官方比例蓝 45%、绿 20%、黄 17%、红 18% 定制）。
- 缩短 GitHub Actions CI 关键路径耗时，分片慢速测试用例，优化构建缓存复用。

## v1.0.4 - 2026-11-04

- 新增 DSH 配置目录设置，支持查看、选择和恢复默认；手动目录优先于 `DSH_HOME`，未设置时使用 `~/.dsh`，切换目录不搬迁现有文件。
- Claude 插件使用统计纳入成功的 SessionStart hook 加载，同次加载去重，恢复或压缩会话后的加载计入对应日期；升级后自动重扫本地会话日志并保留已有统计事件。
- 修正搜索筛选后的插件汇总和趋势提示，统一日、周趋势的柱宽，并正确汇总同一 Agent 的多条统计记录。
- Skills 批量启停增加确认，仅操作当前筛选结果，执行期间锁定操作并保留失败反馈。
- 顶部导航调整为 Skills、MCP、提示词、会话，统计栏中的 DeepSeek Harness 名称简化为 DSH。
- 优化 PR 检查耗时，按改动范围运行前后端检查，Rust 缓存由 main CI 统一维护。

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
