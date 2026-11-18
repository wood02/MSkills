# MSkills changelog

## Unreleased

## v1.0.10 - 2026-11-18

- Skills 统计口径与交互优化（`#32`）：
  - 新增 Skills 周统计口径设置 `SkillUsageWeekMode`，支持在「近 7 天（滚动）」与「本周（周一至周日）」之间切换，覆盖趋势图、关联 Token 计算、Skills 顶栏快捷切换及设置页配置项。
  - 抽取 `SkillDescription` 组件并支持 `SkillMarkdownPreview` 紧凑模式，优化超长描述的截断悬浮提示与完整内容预览。
  - 优化 Skills 列表批量启用/关闭操作与多语言文案。

## v1.0.9 - 2026-11-16

- 新增项目工作区（Project Workspace）：
  - 支持本地代码仓库纳管、路径重定位与归档管理，支持 `.agents/skills` 与 `.claude/skills` 双目标扫描，以及软链、副本、相对别名部署、技能组一键套用/撤回、`.git/info/exclude` 自动维护与差异对比。
  - 支持项目级规则指令文件（`CLAUDE.md` / `AGENTS.md` / `.claude/CLAUDE.md`）编辑、应用全局提示词、历史快照回滚与 `@AGENTS.md` 引用检测，并完善操作日志崩溃恢复（`JournalGuard`）、全局 `installation_id` 代际校验、卸载影响预览与数据库备份范围提示。
- Skills 精选榜、统计与工作区交互升级：
  - 定制精选榜新增专属排名与荣誉齿边勋章展示；重构项目工作区语义微彩层次及 `.agents` / `Claude` 可视化目标胶囊开关。
  - 升级使用趋势图结构化 Tooltip 与 Token I/O 拆分展示，修复 `Antigravity` 统计识别与重复悬浮提示，优化 Agent 2×2 指标卡及顶栏单行 `启用 / 调用` 概览胶囊。
- 修复已启用提示词的删除保护并透传删除失败原因（`#29`）。

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
