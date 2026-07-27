# 参与开发

感谢你改进 AniLog。提交修改前，请先在本地完成对应平台的构建和测试。

## 环境要求

- Node.js 22
- npm
- Windows 10/11（运行和打包桌面版）
- JDK 21、Android SDK 36.1 和对应 Build Tools（构建 Android 版）

## 安装依赖

```powershell
npm ci
```

如果 Electron 下载受网络限制，可在 PowerShell 中临时使用镜像后重新安装：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
node node_modules\electron\install.js
```

## 开发运行

Windows 标准版：

```powershell
npm run dev
```

Windows 原名版：

```powershell
npm run dev:original
```

浏览器预览地址通常为 `http://127.0.0.1:5173/`。浏览器模式仅用于界面预览；系统托盘、开机自启和 Windows 通知只在 Electron 中生效。

## 构建 Windows 版

构建标准版、原名版或两版安装包：

```powershell
npm run dist
npm run dist:original
npm run dist:all
```

安装包生成在 `release` 目录。若 Electron 解压阶段报告 `EPERM`，可使用项目中已安装的 Electron 运行时：

```powershell
npx electron-builder --win nsis --config.electronDist=node_modules/electron/dist
```

## 构建 Android 版

首次构建前，请使用 Android Studio 安装所需 SDK，并确保 `android/local.properties` 指向本机 Android SDK。

```powershell
npm run android:sync
.\android\gradlew.bat -p android assembleDebug
```

Debug APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。

`android/local.properties`、APK、Gradle 缓存、构建目录和签名密钥均被 Git 忽略。不要把密码、应用专用密码、签名密钥或其他凭据提交到仓库。

## 测试

```powershell
npm run build:all
npm run build:android
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

修改共享状态、同步逻辑或跨平台接口时，应同时验证 Windows 与 Android 构建。只修改文档时无需重新打包安装程序，但应检查 Markdown 链接和命令是否正确。

## 提交修改

- 保持改动聚焦，避免夹带无关的格式化或生成文件。
- 为行为变化补充或更新测试。
- 提交前确认 `git status` 中没有缓存、密钥、APK 或本地数据。
- 在提交说明中简要描述用户可见的变化。

维护者的完整版本发布流程见 [docs/RELEASING.md](docs/RELEASING.md)。
