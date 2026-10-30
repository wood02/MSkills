# MSkills 发布

默认分支为 `main`。普通提交和 PR 合并只运行 CI；只有推送 `v*` 标签才会自动构建并发布 GitHub Release。

## main 保护

GitHub Ruleset 要求所有 main 改动通过 PR，且 `CI Passed` 检查通过、分支包含最新 main、评审讨论已解决。禁止强制推送和删除 main；个人维护阶段不强制他人审批，也不配置绕过人员。

`CI Passed` 汇总前端和三个平台的后端检查（fmt/clippy 只在 Ubuntu 跑，Windows/macOS 只跑测试）。Windows/WSL2 完整检查移到 `wsl2-nightly.yml` 每晚运行，不阻塞 PR。PR 中未涉及的区域可以跳过；main 提交必须全部通过。失败、取消及意外跳过都会阻止合并。

## 正式发布操作

1. 从最新 main 创建发版分支，将以下版本号保持一致，通过 PR 合入 main：
   - `package.json` 的 `version`
   - `src-tauri/tauri.conf.json` 的 `version`
   - `src-tauri/Cargo.toml` 的 `[package].version`
   - `src-tauri/Cargo.lock` 中 `mskills` 包的版本（不要修改其他依赖版本）
2. 等待合并后 main 上对应提交的 CI 成功。
3. 在该提交上创建并推送版本标签。将以下示例中的版本号替换为本次已准备的版本：

   ```bash
   git fetch origin
   git switch main
   git pull --ff-only origin main
   git log -1 --oneline
   # 确认 HEAD 就是待发布且 CI 已通过的提交，再执行：
   git tag -a v1.0.0 -m "MSkills v1.0.0"
   git push origin v1.0.0
   ```

4. 到仓库 Actions 查看 `Release`。它会校验标签格式、四处版本号、提交属于 main 历史及该提交的 main CI；然后构建 Windows x64/ARM64、Linux x64/ARM64 和 macOS Apple Silicon（arm64）包；不再提供 Intel Mac 包。
5. 所有平台构建成功后创建 Release 草稿并上传附件，更新清单处理成功后才公开。`v1.0.0` 是正式版；`v1.1.0-beta.1`、`v1.1.0-rc.1` 等带预发布标识的标签标为 Pre-release。

标签指向的提交决定构建内容。已公开版本不移动或覆盖标签；源码修复应准备新版本。若只是 CI 未结束或临时环境故障，可等待后在 Actions 重跑失败任务。发布中途失败时可能留下草稿，修复后重跑同一工作流即可继续。

## macOS 签名与公证

新仓库不会继承旧仓库的 Secrets。未配置 Apple 凭据时，生成临时签名、未经 Apple 公证的包；Release 正文明确标注此状态。首次打开可能被 macOS Gatekeeper 拦截，不能将其描述为已通过 Apple 公证。

需要正式 Developer ID 签名和公证时，在 GitHub 的 `release` Environment 中配置以下 Secrets：

- `APPLE_CERTIFICATE`：Developer ID Application 的 `.p12` 证书，整体 Base64 编码。
- `APPLE_CERTIFICATE_PASSWORD`：证书导出密码。
- `KEYCHAIN_PASSWORD`：CI 临时钥匙串密码。
- `APPLE_ID`：Apple 开发者账号。
- `APPLE_PASSWORD`：Apple 应用专用密码。
- `APPLE_TEAM_ID`：开发者团队 ID。

全部配置后，工作流自动签名、公证并验证 `.app` 和 `.dmg`。部分配置缺失或签名、公证失败会阻止发布，不会降级成临时签名。

## 应用内更新与镜像

客户端使用 Tauri updater，更新地址为 `https://github.com/wood02/MSkills/releases/latest/download/latest.json`。启动时检查最新正式版；发现更新后，点击顶部更新图标进入「设置 → 关于」，查看更新说明并确认下载安装。检查失败会显示错误，不会当作「已是最新」。

- macOS `.app`、Windows MSI 安装版、Linux AppImage：下载后校验签名，再安装并重启。
- Windows 绿色版、Linux deb/rpm 及无法确认安装方式的客户端：可检查新版本，点击下载按钮打开 Release 页面手动安装。deb/rpm 也可通过软件包管理器升级。
- `v1.0.0` 和 `v1.0.1` 尚未启用更新，用户需手动安装一次包含本功能的新版本。只有该版本正式发布后，公开更新地址才会首次提供 `latest.json`；本地完成配置不代表线上已可更新。

在 GitHub 的 `release` Environment 中设置以下 Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`：Tauri signer 生成的私钥文件内容（Base64 文本）。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥的加密密码。

仓库只保存对应公钥（`src-tauri/tauri.conf.json`）。密钥可通过 `pnpm tauri signer generate --write-keys <仓库外路径>` 生成；私钥和密码应在仓库外限制文件权限并备份，不得提交到 Git。此更新签名与 Apple 签名、公证分别配置。保留原密钥，避免已安装客户端无法验证后续更新；轮换密钥需要单独设计过渡版本。

日常 `pnpm dev` 不需要私钥；本地执行正式打包时，需要在进程环境中设置上述两个变量，不能将私钥写入配置文件或提交到仓库。

发布工作流要求签名私钥，生成 macOS `.tar.gz`、Windows MSI 和 Linux AppImage 的签名。所有平台构建成功后，`scripts/generate-updater-manifest.mjs` 使用客户端内置公钥验证每个更新包及签名，生成包含六个架构入口的 `latest.json`（macOS 两个架构共用 Universal 包），全部上传后才公开 Release。清单更新说明读取 CHANGELOG 中对应 `## vX.Y.Z - 日期` 条目；发版时应将 Unreleased 内容归入该条目。缺少包、签名错误或签名密钥不匹配均阻止发布。

R2 镜像默认关闭；首次发布不依赖镜像服务。需要时再配置 `R2_MIRROR_ENABLED`、桶、公开地址和相关 Secrets，并单独验证同步触发及清单。

首个独立版本从继承的 `3.20.4` 重置为 `1.0.0`；曾安装旧开发包的机器需要验证安装器的降级处理。日常依赖升级由维护者手动决定，不再通过 Dependabot 自动创建升级 PR。
