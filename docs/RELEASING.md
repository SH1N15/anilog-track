# 版本发布

本文档供 AniLog 维护者发布 Windows 和 Android 正式版本时使用。

## 1. 更新版本号

发布新版本前，至少检查以下位置：

- `package.json` 与 `package-lock.json` 中的桌面版本号
- `android/app/build.gradle` 中的 `versionCode` 和 `versionName`
- Tauri 版本还需要检查 `src-tauri/tauri.conf.json` 中的 `version` 和 `bundle.android.versionCode`
- Android 网络请求使用的 AniLog User-Agent 版本
- README 中指向最新版 Android APK 的链接
- `release-notes/vX.Y.Z.md` 发布说明

Android 每次发布必须增加 `versionCode`。覆盖升级还要求使用与旧版本相同的发布密钥。
Tauri 的预发布标识不会自动产生不同的 Android `versionCode`，因此 beta、rc 和正式版也必须逐次手动增加 `bundle.android.versionCode`。

只发布原名版时，标准版可以继续指向上一版本；发布说明必须明确每个附件所属版本，避免用户误认为标准版也已更新。

## 2. 验证代码

先安装锁定版本的依赖，再执行完整构建和测试：

```powershell
npm ci
npm run build:all
npm run build:android
npm run build:android-original
npm run test:daily-task-reminder
npm run test:editions
npm run test:state-refresh
npm run test:task-retention
npm run test:window-lifecycle
npm run test:webdav-sync
npm run test:webdav-service
npm run test:cache-storage
npm run test:season-cache
npm run test:data
npm run test:bangumi
npm audit --omit=dev --audit-level=high
```

涉及 WebDAV 时，除自动测试外，建议使用测试账户完成一次 Windows 与 Android 双向同步验证。测试账户不得写入仓库。

## 3. 构建 Windows 安装包

```powershell
npm run dist:all
```

预期生成：

- `release/AniLog-Setup-X.Y.Z.exe`
- `release/AniLog-Original-Setup-X.Y.Z.exe`

两个 Electron 打包任务会使用相同的临时输出目录，必须串行运行。Windows 安装包没有商业代码签名时，发布说明中应保留“未知发布者”提示。

原名版安装器还应验证语言选择页包含 English 与简体中文，首次启动继承安装语言，升级安装不会覆盖用户已保存的界面语言。

## 4. 构建并签名 Android APK

同步网页资源并构建 Release APK：

```powershell
npm run android:sync
.\android\gradlew.bat -p android assembleStandardRelease
```

未签名 APK 通常位于 `android/app/build/outputs/apk/standard/release/app-standard-release-unsigned.apk`。使用 Android Studio 的 **Build → Generate Signed App Bundle or APK**，选择 APK，并使用项目发布密钥完成签名。

Android Original 先同步对应网页资源，再构建 `originalRelease` 变体：

```powershell
npm run android:sync:original
.\android\gradlew.bat -p android assembleOriginalRelease
```

未签名文件位于 `android/app/build/outputs/apk/original/release/app-original-release-unsigned.apk`。发布文件名使用 `AniLog-Original-Android-vX.Y.Z.apk`。它的包名是 `io.anilog.android.original`，签名要求与标准版相同。

签名密钥和密码只能保存在维护者的安全备份中，不得提交到 Git、发布附件或问题讨论。后续 Android 更新必须继续使用同一密钥。

使用 Android SDK Build Tools 验证签名、版本号和对齐状态：

```powershell
apksigner verify --verbose --print-certs AniLog-Android-vX.Y.Z.apk
aapt dump badging AniLog-Android-vX.Y.Z.apk
zipalign -c -P 16 -v 4 AniLog-Android-vX.Y.Z.apk
```

确认签名证书指纹与上一个正式版本一致，并确认 `versionCode`、`versionName` 正确。

## 5. 生成校验值

```powershell
Get-FileHash -Algorithm SHA256 `
  'release\AniLog-Setup-X.Y.Z.exe', `
  'release\AniLog-Original-Setup-X.Y.Z.exe', `
  'release\AniLog-Android-vX.Y.Z.apk', `
  'release\AniLog-Original-Android-vX.Y.Z.apk'
```

把三个 SHA-256 值写入对应发布说明。

仅发布原名版时，校验 `AniLog-Original-Setup-X.Y.Z.exe` 与 `AniLog-Original-Android-vX.Y.Z.apk` 两个文件即可。

## 6. 提交并发布

1. 确认 `git status` 不包含签名密钥、密码、缓存、本地数据或构建目录。
2. 提交版本号、代码、文档和发布说明并推送到 `main`。
3. 在 GitHub Releases 创建 `vX.Y.Z` 标签，目标指向已验证的提交。
4. 标题使用 `AniLog vX.Y.Z`，正文使用对应的发布说明。
5. 上传本次版本对应的 Windows 安装包和已签名 Android APK；仅更新原名版时只上传两个 Original 附件。
6. 标记为 Latest 并发布。
7. 发布后逐一检查所有下载链接、文件大小和 SHA-256。

不要覆盖旧版本附件；每个版本使用独立标签和文件名，以便用户回退与校验。
