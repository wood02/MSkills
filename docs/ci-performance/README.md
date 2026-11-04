# GitHub Actions 提速记录（2026-11-04）

保留全部检查后，第三轮实测 PR CI 从最近一次的 **6 分 38 秒降到 3 分 41 秒（缩短 44.5%）**。同期未优化的 main CI 为 7 分钟；50 次样本中 14 次成功 CI 的中位数为 10 分 26.5 秒。

## 数据与计时口径

先通过 `gh run list --limit 50 --json ...` 固定最近 50 次 workflow 运行，再用 `gh api repos/wood02/MSkills/actions/runs/RUN_ID/jobs?per_page=100` 拉取全部 **154 个 job**，下载 CI、WSL2、Release 的运行日志核对编译和测试耗时。

- [优化前逐 job 明细](2026-11-04-before-jobs.csv)：原始 50 次运行，含失败、取消、跳过的记录。
- [三轮优化逐 job 明细](2026-11-04-iterations-jobs.csv)：每轮完整运行的排队、准备、执行时间。
- 排队：job 的 `created_at` 到 `started_at`；不把等待 `needs` 的时间误算成 runner 排队。
- 准备：job 总时间减执行时间，包含 checkout、工具和依赖安装、缓存、Rust 编译、Cargo 调度及收尾。
- 执行：Rust 使用各测试二进制 `test result ... finished in` 的耗时之和，另加格式、Clippy、类型检查、前端构建等实际校验 step。Clippy 内部的编译仍计入其 step；Vitest 的并行 jsdom/setup 无法从日志拆出独立墙钟时间，保留在测试执行阶段。
- 单个 job 的准备与执行之和等于其运行时间；矩阵比较采用最长 job，流水线时间采用 workflow 创建到 `CI Passed` 完成，不能相加并行 job 的时间。
- 跳过记录按 0 秒处理；取消、失败的运行保留在明细中，不混入成功运行中位数。测试数量对比也单独计算，没有把编译当成测试执行。

## 实测对比

最近一次优化前 PR：[41765242110](https://github.com/wood02/MSkills/actions/runs/41765242110)。同期原 workflow 的 main 对照：[41785078948](https://github.com/wood02/MSkills/actions/runs/41785078948)，与后两轮同为 v1.0.4 应用代码。

| 项目                 | 优化前最近 PR |  第三轮 |  缩短 |
| -------------------- | ------------: | ------: | ----: |
| PR 完整流水线        |        398 秒 |  221 秒 | 44.5% |
| 前端最长 job         |        147 秒 |   65 秒 | 55.8% |
| Windows 后端最长 job |        377 秒 |  197 秒 | 47.7% |
| macOS 后端最长 job   |        263 秒 |  119 秒 | 54.8% |
| Ubuntu 后端全套检查  |        192 秒 |  163 秒 | 15.1% |
| 仓库缓存占用         |       9.63 GB | 3.16 GB | 67.2% |

每轮在线样本较少，runner、缓存传输和软件包镜像会波动，上表是可追溯的实测，不是固定耗时承诺。并行运行把这次 PR 的累计 job 时间从 988 秒提高到 1290 秒（约 +31%），换取更短的等待时间。

| 轮次                                                                 | CI 时间 | 结果与调整                                                                                                |
| -------------------------------------------------------------------- | ------: | --------------------------------------------------------------------------------------------------------- |
| [第一轮](https://github.com/wood02/MSkills/actions/runs/41784833665) |  626 秒 | 全部通过，但缓存路径变化导致全部未命中，且 `--no-run` 后再次调用 Cargo 重新编译；未采用该版本。           |
| [第二轮](https://github.com/wood02/MSkills/actions/runs/41786153741) |  291 秒 | 恢复兼容的缓存路径、每 job 仅调用一次 Cargo；前端校验与三个测试分片并行。                                 |
| [第三轮](https://github.com/wood02/MSkills/actions/runs/41786837875) |  221 秒 | 单元测试只构建测试库，二进制测试移到已有普通库的集成测试组；macOS 单元/集成测试并行，Linux 依赖合并安装。 |

## 保留的校验

三轮日志逐项相加核对，结果均与优化前一致：

| 测试         |                    通过 | 原有 ignored |
| ------------ | ----------------------: | -----------: |
| 前端         | 152 个文件、1287 个测试 |            0 |
| Ubuntu Rust  |                    3106 |            9 |
| macOS Rust   |                    3123 |            9 |
| Windows Rust |                    3094 |           10 |

TypeScript、Prettier、Ubuntu Rust fmt/Clippy、前端生产构建、发布脚本与签名/版本校验测试全部保留。Windows 的所有集成测试目标从 Cargo metadata 自动发现，按历史耗时分配到三片，新增目标也会自动进入分片；另有单元测试片。分片自检断言每个目标恰好出现一次，二进制测试也恰好运行一次。

## 调度、缓存和文档变更

- PR 使用 PR 编号作为 concurrency group，仅 PR 更新会取消旧运行。
- main 使用每次运行独有的 `run_id`，避免 `cancel-in-progress: false` 仍只保留一个 pending run 的问题；每个 main 提交继续完整执行。
- 文档/README-only PR 通过现有 `paths-filter` 跳过昂贵 job，仍运行 `CI Passed`。已核对分支 ruleset 只要求这个汇总检查，且 gate 测试覆盖两类 job 全部跳过的情况。不能在整个必需 workflow 上使用 `paths-ignore`，否则检查会停留在 Expected/Pending。
- 混合代码与文档的 PR 按整个 PR 的 diff 校验，不能只看最后一次文档提交，否则可能漏掉尚未成功校验的代码。main 保持用户要求的逐提交完整校验。
- 前端使用 `setup-node` 自带 pnpm cache，固定 `pnpm-lock.yaml`。最后交付提交使用官方 pnpm setup action，避免依赖 runner 恰好预装 Corepack；发布 workflow 同步使用原生缓存，保留 Windows ARM64 原有缓存例外。
- Rust 继续使用 Swatinem/rust-cache。仅 main 写缓存，每个平台一个 writer，保留原归档路径以复用热缓存；前端 job 不恢复 Rust 缓存。
- 删除三个不再被 workflow 引用的旧 `*-cargo-*` 缓存，释放约 6.54 GB；未添加大型系统依赖或发布 target 缓存挤占空间。
- 格式与 Clippy 继续在 Ubuntu；单次 CI 使用两个 macOS job，发版仍使用一个，账户的五台 macOS 共享额度仍适用。
- 现有 `needs` 都传递路径判断或汇总检查结果；保留这些真实依赖。工具无 `cargo install`/`go install`；本次 actionlint 也使用预编译二进制。

## 本地增量构建与 WSL2

本地同一份源码连续执行两次 `cargo test --locked --manifest-path src-tauri/Cargo.toml --no-run -vv`：**37.82 秒、0.97 秒**，第二次没有重新编译应用。仓库没有 Dockerfile，无需修改依赖复制顺序。

最近五次 WSL2 Nightly 都在设置 UNC TEMP 后再次调用 Cargo，因重新链接时 `mt.exe` 失败而停止。现改为原生临时目录编译一次，保存 Cargo 返回的全部测试二进制，再在原工作目录、WSL2 TEMP 下直接执行；保持串行线程参数、ignored 原子写入契约和全部测试目标，保留失败退出行为及原执行顺序。

[第一次验证](https://github.com/wood02/MSkills/actions/runs/41784926678)和[第二次验证](https://github.com/wood02/MSkills/actions/runs/41786240002)的 Windows Clippy、WSL2 原子写入契约均通过，完整测试推进到执行阶段后暴露 SQLite 在 UNC 目录下的 `database is locked`。这个夜测目前仍失败，没有删除测试、忽略错误或更改应用数据库逻辑来制造全绿。它原本就不属于 PR 的 `CI Passed` 汇总范围。

发布 workflow 的 pnpm 缓存调整经过 actionlint 和发布脚本测试；没有为性能测试创建或发布新版本。全部受改动的 workflow 均通过 actionlint。
