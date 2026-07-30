# Implementation Plan

1. 读取 Trellis 项目规范与发布文档，确认用户未提交文件保持不变。
2. 更新正式版本源：npm、Cargo、Tauri、Gradle fallback、README/AGENTS/维护迁移发布文档，并新增 `release-notes/v0.6.0.md`。
3. 仅修改两个 Tauri Android build scripts，显式加入 `--target aarch64`；不改 Windows 功能代码或业务代码。
4. 运行类型检查、六套 renderer build、所有 `test:*`、Standard/Original Rust、组合 feature 拒绝检查、生产 audit 和 `git diff --check`。
5. 串行构建 Windows Standard/Original，验证 ProductName、ProductVersion 和文件名。
6. 使用 JDK 17 串行构建 Android Standard/Original，每次立即暂存；确认未签名 APK 仅含 arm64-v8a。
7. 使用既有外部证书 zipalign、签名并验证两个 APK 的包名、版本、SDK、ABI、v2/v3 签名和证书指纹。
8. 计算四个附件 SHA-256 并写入发布说明；复查 staged diff 不含凭据、路径或二进制。
9. 提交并推送迁移分支，等待 PR #3 CI 通过；合并 PR #3 到 main。
10. 确认 main HEAD 与验证源码一致；若合并提交改变树内容，重跑完整测试和四个构建。
11. 在最终 main 提交创建并推送 `v0.6.0`，创建非 Pre-release、Latest GitHub Release并上传四个附件。
12. 通过 Release API 和重新下载复核四个远端附件的名称、大小和 SHA-256；确认 Latest 为 v0.6.0。
13. 更新任务记录、执行 Trellis quality/finish 流程并归档任务。

## Validation Commands

```powershell
npx tsc -b
cargo test --manifest-path src-tauri/Cargo.toml --features standard
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features original
npm run tauri:build
npm run tauri:build:original
npm run tauri:android:build
npm run tauri:android:build:original
npm audit --omit=dev --audit-level=high
git diff --check
```

全部 `test:*` 与 renderer build 从 `package.json` 枚举执行。APK 额外使用 `aapt`、`apksigner`、`zipalign` 和 ZIP entry 检查。

## Rollback Points

- 版本提交前：放弃本任务文件，不影响 beta.2。
- PR 合并前：保持迁移分支，不改变 main/Latest。
- Release 创建前：不推送正式标签或不创建 Release。
- 发布验证失败：不标记 Latest，移除未完成正式 Release 后从验证步骤重做。
