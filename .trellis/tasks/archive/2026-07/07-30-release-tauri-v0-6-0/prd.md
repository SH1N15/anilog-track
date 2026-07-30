# 发布 AniLog v0.6.0 Tauri 正式版

## Goal

将已经过两轮公开 beta 验证的 React + Tauri 2 + Rust 版本发布为 `v0.6.0` 正式版，并解决 Android universal APK 体积过大的问题。正式版成为 GitHub Latest，不再继续发布 beta 测试版。

## Background

- 当前公开测试版为 `v0.6.0-beta.2`，GitHub Pre-release；当前稳定版和 Latest 为 `v0.5.0`。
- PR #3 从 `codex/tauri-migration` 合并到 `main`，当前可合并且 CI 通过。
- beta.2 Android universal APK 包含 `arm64-v8a`、`armeabi-v7a`、`x86`、`x86_64` 四套 Rust 原生库，Standard 为 67.8 MB；beta.1 仅包含 `arm64-v8a`，约 20.7 MB。
- Tauri CLI 支持 `android build --target aarch64`，可把正式 APK 固定为仅 `arm64-v8a`。

## Requirements

1. 正式版本号和标签必须为 `0.6.0` / `v0.6.0`，Android `versionCode` 必须由 `6` 递增为 `7`。
2. Standard 与 Original Android 发布 APK 均只包含 `arm64-v8a`，不得包含 `armeabi-v7a`、`x86` 或 `x86_64`。
3. Android APK 必须沿用既有发布证书，包名分别为 `io.anilog.android` 和 `io.anilog.android.original`，支持从已发布版本覆盖升级。
4. Windows 功能代码和行为不作修改；只允许正式版本元数据、构建产物名称和发布文档发生必要变化。Windows Standard/Original 必须重新构建为内部版本 `0.6.0`。
5. 保留 `electron/` 与 `android/` 回退实现，不在本任务清理旧架构。
6. PR #3 在最终发布前合并到 `main`；正式版标签必须指向经过完整验证的 `main` 提交。
7. GitHub Release 必须是正式 Release、非 Pre-release，并设置为 Latest。已有 beta.1/beta.2 Release 保留，不删除或覆盖。
8. 发布四个附件：Windows Standard/Original NSIS 与 Android Standard/Original arm64 APK；附件名称必须带 `v0.6.0`。
9. 更新 README、AGENTS、维护/迁移/发布文档和 `release-notes/v0.6.0.md`，明确 Tauri 已成为正式版且 Android 正式包仅支持 arm64-v8a。
10. 不修改业务功能，不引入新的 UI、同步、通知、任务、Bangumi 或 WebDAV 行为。

## Acceptance Criteria

- [ ] `package.json`、lockfile、Cargo、Tauri、Gradle fallback 与 User-Agent 版本均为 `0.6.0`，Android `versionCode=7`。
- [ ] Android 构建脚本显式传递 `--target aarch64`，两个最终 APK 内部仅存在 `lib/arm64-v8a/libanilog_lib.so`。
- [ ] Android 两包通过包名、版本名/code、minSdk/targetSdk、16 KiB 对齐、v2/v3 签名和证书 SHA-256 校验。
- [ ] Android 正式 APK 的体积回落到与 beta.1 arm64 构建同一量级，不再是约 66-68 MB 的 universal 包。
- [ ] Windows 两个 NSIS 安装包的 ProductName/edition 正确，内部版本均为 `0.6.0`；没有 Windows 功能代码变化。
- [ ] Standard/Original Rust 测试、全部回归脚本、六套 renderer build、类型检查、生产依赖审计及 PR CI 通过。
- [ ] PR #3 合并，`v0.6.0` 标签指向验证后的 `main` 提交。
- [ ] GitHub `v0.6.0` Release 包含四个附件，`prerelease=false`、`draft=false`，并成为 Latest。
- [ ] 从 GitHub 重新下载四个附件后，大小和 SHA-256 与发布说明一致。
- [ ] 工作区和提交中不存在签名凭据、WebDAV 凭据、本机路径或构建产物。

## Out of Scope

- Windows 功能或界面修改。
- Android 业务功能修改。
- 发布 32 位 ARM、x86 或 x86_64 APK/AAB。
- 删除旧 beta Release、Electron 或 Capacitor 回退实现。
- 修复与正式发布无关的警告、重构或新 issues。
