# 代码审查待办（codex/tauri-migration）

来源：2026-07-30 对 v0.6.0-beta.1 Tauri 迁移的审查。已处理的项见文末，以下为推迟处理项，按优先级排列。

## 优先处理

### 1. `update_settings` 每次重新编译正则（lib.rs:984）
```rust
if regex::Regex::new(r"^([01]\d|2[0-3]):[0-5]\d$").unwrap().is_match(time) == false
```
每次保存设置都重新编译 `dailyTaskReminderTime` 校验正则。改用 `std::sync::LazyLock`（Rust 1.85 已可用，符合 `rust-version`）预编译一次。低成本，纯效率优化。

### 2. `bangumi_search` 用 POST 请求搜索接口（lib.rs:1446-1452）
```rust
let endpoint = format!("{}/search/subjects?limit=12&offset=0", ...);
.post(endpoint).json(&json!({"keyword": keyword, "sort": "match", "filter": {"type": [2]}}))
```
Bangumi v0 官方 `search/subjects` 规范是 GET，参数走 query。当前发的是带 JSON body 的 POST。默认走自建反代 `https://sh1n.cc.cd/v0` 时大概率工作（反代兼容），但当用户清空地址、回退到 `OFFICIAL_BANGUMI_API` 时（lib.rs:1516-1518 的 `vec![OFFICIAL_BANGUMI_API]` 分支），官方 API 可能不接受这种 POST，导致搜索静默失败回退到 `unmatched`。

**需确认**：官方 `https://api.bgm.tv/v0/search/subjects` 是否接受 POST + JSON body。若不接受，"清空地址用官方 API"场景下中文标题匹配会失效。建议改成 GET + query 参数，或确认反代与官方行为一致。

### 3. Android `versionCode` 配置完整性（tauri.conf.json / tauri.android-original.conf.json）
`tauri.conf.json` 有 `"versionCode": 5`，但 `src-tauri/tauri.android.original.conf.json` **没有 versionCode 字段**（只有 `debugApplicationIdSuffix`），可能继承标准版的 5。

AGENTS.md 强约束："Original 每次 beta/rc/正式发布都必须递增 `bundle.android.versionCode`，否则无法覆盖升级。" 发布 Original Android 前需确认 versionCode 来源与递增情况，与 `docs/RELEASING.md` 核对。属发布流程校验项，非代码 bug。

### 4. CSP 关闭（tauri.conf.json:29）
```json
"security": { "csp": null }
```
renderer 全本地资源，但封面图来自远程 origin。建议设白名单 CSP（`default-src 'self'; img-src https: data:; ...`），避免将来渲染层引入第三方脚本时无防线。低风险改动。

## 已处理

- **#7 清理散落的 preview 日志**：删除根目录 `preview-*.log` / `preview-*.err.log`（均为 0–212B 的小占位文件，未被 git 跟踪，`.gitignore` 含 `*.log`）。
- **#8 移除未用依赖 `unicode-normalization`**：`Cargo.toml` 声明但 `lib.rs` 中 `normalize_title_key` 用 `char::to_lowercase()` + `is_alphanumeric()`，grep 确认无引用。已移除以精简依赖。
