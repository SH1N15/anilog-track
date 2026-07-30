# Design

## Release Boundary

本任务是版本固化和发布，不改业务逻辑。源代码变化只覆盖版本源、Android 构建 target、发布说明和当前状态文档。Windows 仍使用现有 Tauri Standard/Original 构建链，但必须重建以写入正式版本元数据。

## Branch and Tag Flow

1. 在 `codex/tauri-migration` 完成版本与构建脚本修改并跑完整验证。
2. 推送分支，等待 PR #3 CI 通过。
3. 合并 PR #3 到 `main`，更新本地 `main`。
4. 从合并后的准确 `main` HEAD 串行重建四个附件并复核。
5. 标签 `v0.6.0` 指向该验证提交，创建正式 Latest Release。

若 `main` 在合并或构建期间移动，重新同步并重复受影响验证，不能把旧提交产物附到新标签。

## Android Build

把两个 Tauri Android npm scripts 固定为 `tauri android build --target aarch64 ... --apk`。Standard 与 Original 仍写入同一 generated APK 路径，因此每次构建后立即复制并以 edition 命名。签名前先 zipalign，签名凭据仅在进程局部读取，随后验证 APK ZIP 中只有 `lib/arm64-v8a/`。

版本流为 `tauri.conf.json` 的 `0.6.0` / code 7，经 generated `tauri.properties` 进入 Gradle；Gradle fallback 同步更新，防止直接构建回退到 beta.2/code 6。

## Windows Build

不改 Windows 功能代码。版本源更新后串行运行现有 Standard 与 Original NSIS 命令，并立即暂存独立文件名。用 PE VersionInfo 验证 ProductName 与 ProductVersion。

## Publication and Rollback

- 发布前保留所有产物在新的忽略目录 `release/tauri-v0.6.0/`。
- Release 创建失败时保留标签和本地附件，修复发布操作后重试；不覆盖旧附件。
- 资产验证失败时删除未完成的 `v0.6.0` Release/标签或保持 draft，不标记 Latest，修正并重建。
- beta.1/beta.2 保留为回退证据；正式 Release 成功后 Latest 从 v0.5.0 切换至 v0.6.0。

## Constraints

- Original 三层不得访问 Bangumi。
- WebDAV 同步字段与凭据处理不变。
- Standard/Original Cargo feature 互斥。
- 签名密钥、alias、密码和本机签名路径不得进入提交、日志、Issue 或 Release 文本。
