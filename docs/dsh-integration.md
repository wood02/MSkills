# DeepSeek Harness（dsh）

MSkills 可管理 dsh 的模型供应商、MCP、全局指令和 Skills，并浏览本地会话。适配依据为 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 在 2026-10-30 的公开配置格式；dsh 当前仍为开发预览版。

## 开始使用

1. 按官方说明运行 `npx @deepseek-ai/dsh web`，完成 dsh 初始化。
2. 在 MSkills 应用选择器选择 **DeepSeek Harness**。
3. 在设置的应用区域选择 **DSH 配置档案**：默认 `web`，桌面版使用 `desktop`，其他配置填写启动 dsh 时指定的 profile 名。留空按 `web` 处理。

所有路径以 `DSH_HOME` 为根，未设置时为 `~/.dsh`。环境变量需要在启动 MSkills 时传入；在终端中临时设置不会改变已运行的桌面进程。

| 功能 | 原生位置 |
| --- | --- |
| 供应商、MCP | `profiles/<profile>/cordis.patch.yml` |
| API 密钥 | `.credentials.yaml` 的 `refs`，配置只写 `apiKeyEnv` 引用 |
| Prompts | `AGENTS.md` |
| Skills | `skills/<name>/SKILL.md` |
| 会话 | `sessions/<project>/<session>/session[.vN].jsonl[.zstd]` |

## 模型供应商

供应商采用累加模式，可分别添加到配置、编辑、移出配置或删除。默认模型仍由 dsh 的模型选择器决定。

使用小写字母开头、由小写字母、数字和连字符组成的供应商 ID。`deepseek` 是官方适配器的保留路由；官方账号登录仍在 dsh 中操作。通过兼容网关接入 DeepSeek 时使用自己的 ID，例如 `my-deepseek`。

配置编辑器使用 dsh 原生路由格式。自定义接口需要协议、地址和至少一个模型：

```json
{
  "api": "openai-completions",
  "baseURL": "https://gateway.example/v1",
  "apiKeyEnv": "GATEWAY_API_KEY",
  "models": [
    {
      "id": "your-model-id",
      "name": "My model",
      "contextWindow": 200000,
      "maxTokens": 8192
    }
  ]
}
```

协议可选 `openai-completions`、`openai-responses` 和 `anthropic-messages`。已有 dsh 内置供应商可仅配置 `apiKeyEnv` 等覆盖项，沿用原生目录。`compat`、模型输入类型和 `reasoningEfforts` 等原生字段会保留。

API Key 输入框留空时保留现有凭据引用；填写新密钥时写入 dsh 的私有凭据文件。移出供应商不会删除凭据，避免影响其他引用。MSkills 不导入 OAuth 或官方账号令牌。

同一 profile 的其他供应商和插件字段会保留；YAML 会重新排版，注释不保留。包含 `!!js` 等 JavaScript 表达式的 YAML 文件会在解析前拒绝编辑，原文件保持不变。存在覆盖 `llm-pi-ai` 的 home patch 时也会拒绝供应商写入，避免显示保存成功却未生效。自定义 bundle 的继承配置、命令行 `--patch`、自定义凭据文件位置需要在 dsh 中管理。

## MCP、Prompts 和 Skills

MCP 支持 stdio 和 Streamable HTTP。配置写成 `@deepseek-ai/dsh-mcp-client` 的 Cordis `insert` 行；SSE 会明确拒绝。可从所选 profile 导入静态 MCP 行；含动态表达式的配置文件保留给 dsh 原生界面管理。名称不符合 dsh 命名限制的托管服务使用稳定哈希名称。在 MSkills 中关闭 dsh 只会给该行加 `disabled: true`，保留 dsh 侧手动添加的字段；删除服务才移除该行。切换 profile 后，已启用的 MCP 会立即同步到新档案。

Prompts 写入全局 `AGENTS.md`。保存未启用的模板不会清空现有指令，切换时备份或回填原指令；文件或数据库写入失败会回滚。

Skills 复用现有安装、导入、同步、开关和技能组功能。dsh 还会自行发现项目的 `.dsh/skills`、`.agents/skills` 和全局共享 `.agents/skills`；这些额外来源遵循 dsh 的原生优先级。在 MSkills 中关闭 dsh 开关只移除其 `DSH_HOME/skills` 投影，不能屏蔽其他目录中的同名技能；特别是共享目录存储模式下，原生发现仍可能看到技能。

## 会话

支持默认目录下的原始 JSONL 与拼接 Zstandard 帧，按数字选择最高格式代次，避免重复显示保留的旧文件。列表使用有界预览提取标题，大日志可能显示首条用户消息而非后期改名；详情读取限制为解压后 128 MiB。

会话读取保持文件不变，过滤插件注入的指令和失败请求重试记录。v2–v4 可预览对话；v0/v1 需要先在 dsh 中打开以升级格式。更高版本明确拒绝，不回退到旧代次。

继续对话和删除会话在 dsh 原生界面完成，避免只删除某一代日志而遗留其 sidecar 或旧文件。自定义会话存储根目录不在本次默认目录扫描范围内。

## 验证范围

自动测试覆盖配置增删改、私有凭据引用、原生锁、失败回滚、未知字段保留与 YAML 表达式拒绝保护、MCP 传输、指令切换、Skills/技能组和两种会话编码。真实模型请求和 dsh 原生界面热加载需在安装 dsh 后使用实际服务验证。
