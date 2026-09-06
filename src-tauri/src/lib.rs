#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};
use anyhow::{Context, anyhow};
#[cfg(target_os = "windows")]
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use chrono::{Datelike, Local};
use log::{info, warn};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
#[cfg(not(target_os = "android"))]
use reqwest::header::{ETAG, IF_MATCH, IF_NONE_MATCH, USER_AGENT};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(desktop)]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt as AutostartExt;
#[cfg(all(desktop, not(target_os = "windows")))]
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

#[cfg(all(feature = "standard", feature = "original"))]
compile_error!("Cargo features `standard` and `original` are mutually exclusive");
#[cfg(not(any(feature = "standard", feature = "original")))]
compile_error!("either Cargo feature `standard` or `original` must be enabled");

// Bangumi 标准版核心模块（契约 C2）：仅 standard edition 编译，
// Original 产物中不存在任何 Bangumi 代码。
#[cfg(feature = "standard")]
pub mod bangumi;

#[cfg(target_os = "android")]
mod mobile;

const ANILIST_API: &str = "https://graphql.anilist.co";
const OFFICIAL_BANGUMI_API: &str = "https://api.bgm.tv/v0";
const DEFAULT_BANGUMI_PROXY: &str = "https://sh1n.cc.cd/v0";
const LEGACY_BANGUMI_PROXY: &str = "https://bgmapi.anibt.net/v0";
const STATE_VERSION: i64 = 2;
const SYNC_VERSION: i64 = 1;
const CACHE_VERSION: i64 = 1;
const BANGUMI_RESOLVER_VERSION: i64 = 5;
static DAILY_TASK_REMINDER_TIME_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^([01]\d|2[0-3]):[0-5]\d$").unwrap());
#[cfg(desktop)]
static PENDING_WINDOW_ACTIVATION: AtomicBool = AtomicBool::new(false);
#[cfg(not(target_os = "android"))]
const MAX_SYNC_BYTES: usize = 5 * 1024 * 1024;
#[cfg(not(target_os = "android"))]
const WEBDAV_COLLECTION: &str = "AniLog";
#[cfg(not(target_os = "android"))]
const WEBDAV_DOCUMENT: &str = "anilog-sync.json";
#[cfg(not(target_os = "android"))]
const WEBDAV_CREDENTIAL_SERVICE: &str = "io.anilog.webdav";

#[derive(Clone)]
pub struct AppContext {
    state: Arc<Mutex<Value>>,
    runtime: Arc<Mutex<Value>>,
    data_dir: PathBuf,
    cache_dir: PathBuf,
    client: reqwest::Client,
    original: bool,
    sync_wakeup: Arc<tokio::sync::Notify>,
    webdav_wakeup: Arc<tokio::sync::Notify>,
    webdav_sync_lock: Arc<tokio::sync::Mutex<()>>,
    #[cfg(desktop)]
    main_window_opening: Arc<AtomicBool>,
    bangumi_lookup_lock: Arc<tokio::sync::Mutex<()>>,
    bangumi_unavailable_until: Arc<AtomicI64>,
    offline_bangumi: Arc<Value>,
    /// Bangumi Token 存储契约（schema §8）：Windows → KeyringTokenStore；
    /// Android → mobile 桥（Keystore）；其他平台 → UnsupportedTokenStore。
    /// AppContext derive Clone，Arc 克隆零成本。
    #[cfg(feature = "standard")]
    bangumi_tokens: Arc<dyn bangumi::BangumiTokenStore + Send + Sync>,
    /// /v0/me → username 的进程内缓存（bangumi_get_user_collections 使用；
    /// disconnect 时清空）。
    #[cfg(feature = "standard")]
    bangumi_username_cache: Arc<Mutex<Option<String>>>,
}

fn now_seconds() -> i64 {
    chrono::Utc::now().timestamp()
}
fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn value_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
fn value_i64(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or_default()
}
fn value_bool(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
}

fn default_state(original: bool) -> Value {
    let state = json!({
        "version": STATE_VERSION,
        "following": [],
        "tasks": [],
        "seenAiringEvents": [],
        "bangumiTitles": {},
        "settings": {
            "uiLanguage": if original { "en-US" } else { "zh-CN" },
            "pollIntervalMinutes": 5,
            "launchAtLogin": false,
            "minimizeToTray": true,
            "showTrayIcon": true,
            "notifyWhenAired": true,
            "createWatchTasks": true,
            "dailyTaskReminderEnabled": false,
            "dailyTaskReminderTime": "20:00",
            "bangumiApiBaseUrl": if original { "" } else { DEFAULT_BANGUMI_PROXY },
            "titlePreference": "auto"
        },
        "lastSyncAt": now_seconds(),
        "lastTaskReminderDate": "",
        "syncMetadata": { "followingDeletedAt": {} }
    });
    // Bangumi 设置块挂在顶层、与 settings 并列（schema 冻结决定）：
    // 仅 standard 版写入；merge_defaults 依赖 default_state 的键集合自动补齐
    // 旧 v2 状态缺失的 bangumi 块，Original 因此永不补该键。
    #[cfg(feature = "standard")]
    let state = {
        let mut state = state;
        if !original {
            if let Some(object) = state.as_object_mut() {
                object.insert(
                    "bangumi".into(),
                    serde_json::to_value(bangumi::BangumiSyncSettings::default())
                        .unwrap_or_else(|_| json!({})),
                );
            }
        }
        state
    };
    state
}

fn merge_defaults(mut loaded: Value, original: bool) -> Value {
    let defaults = default_state(original);
    let Some(target) = loaded.as_object_mut() else {
        return defaults;
    };
    let Some(default_object) = defaults.as_object() else {
        return loaded;
    };
    for (key, default_value) in default_object {
        if !target.contains_key(key) {
            target.insert(key.clone(), default_value.clone());
        }
    }
    if let Some(settings) = target.get_mut("settings").and_then(Value::as_object_mut) {
        if let Some(default_settings) = defaults.get("settings").and_then(Value::as_object) {
            for (key, value) in default_settings {
                if !settings.contains_key(key) {
                    settings.insert(key.clone(), value.clone());
                }
            }
        }
    }
    target.insert("version".into(), json!(STATE_VERSION));
    ensure_sync_metadata(&mut loaded);
    loaded
}

fn ensure_sync_metadata(state: &mut Value) {
    let object = state.as_object_mut().expect("state must be an object");
    if !object.get("following").is_some_and(Value::is_array) {
        object.insert("following".into(), json!([]));
    }
    if !object.get("tasks").is_some_and(Value::is_array) {
        object.insert("tasks".into(), json!([]));
    }
    if !object.get("seenAiringEvents").is_some_and(Value::is_array) {
        object.insert("seenAiringEvents".into(), json!([]));
    }
    if !object.get("syncMetadata").is_some_and(Value::is_object) {
        object.insert("syncMetadata".into(), json!({}));
    }
    let metadata = object
        .get_mut("syncMetadata")
        .and_then(Value::as_object_mut)
        .unwrap();
    if !metadata
        .get("followingDeletedAt")
        .is_some_and(Value::is_object)
    {
        metadata.insert("followingDeletedAt".into(), json!({}));
    }
    if let Some(following) = object.get_mut("following").and_then(Value::as_array_mut) {
        for item in following {
            if !item.get("syncUpdatedAt").is_some_and(Value::is_number) {
                let followed = value_i64(item.get("followedAt"));
                item["syncUpdatedAt"] = json!(if followed > 0 {
                    followed * 1000
                } else {
                    now_millis()
                });
            }
        }
    }
    if let Some(tasks) = object.get_mut("tasks").and_then(Value::as_array_mut) {
        for item in tasks {
            if !item.get("syncUpdatedAt").is_some_and(Value::is_number) {
                item["syncUpdatedAt"] = json!(now_millis());
            }
        }
    }
    let task_ids = object
        .get("tasks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|task| task.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if let Some(events) = object
        .get_mut("seenAiringEvents")
        .and_then(Value::as_array_mut)
    {
        let mut known = events
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<HashSet<_>>();
        for id in task_ids {
            if known.insert(id.clone()) {
                events.push(json!(id));
            }
        }
        const MAX_SEEN_AIRING_EVENTS: usize = 2_000;
        if events.len() > MAX_SEEN_AIRING_EVENTS {
            events.drain(0..events.len() - MAX_SEEN_AIRING_EVENTS);
        }
    }
}

fn data_directory(app: &AppHandle) -> anyhow::Result<PathBuf> {
    #[cfg(target_os = "android")]
    {
        return app
            .path()
            .app_data_dir()
            .context("cannot resolve Android app data directory");
    }
    #[cfg(not(target_os = "android"))]
    {
        if cfg!(debug_assertions) {
            return app
                .path()
                .app_data_dir()
                .context("cannot resolve app data directory");
        }
        let executable = std::env::current_exe().context("cannot resolve executable path")?;
        return Ok(executable
            .parent()
            .context("executable directory is unavailable")?
            .join("data"));
    }
}

fn load_context(app: &AppHandle, original: bool) -> anyhow::Result<AppContext> {
    let data_dir = data_directory(app)?;
    fs::create_dir_all(&data_dir)?;
    let state_path = data_dir.join("anilog-state.json");
    let legacy_path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("anilog-state.json"));
    if !state_path.exists() {
        if let Some(legacy) = legacy_path.filter(|path| path.exists() && path != &state_path) {
            fs::copy(legacy, &state_path).context("migrate existing AniLog state")?;
        }
    }
    let loaded = fs::read_to_string(&state_path)
        .ok()
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .unwrap_or_else(|| default_state(original));
    let mut state = merge_defaults(loaded, original);
    if let Some(settings) = state.get_mut("settings").and_then(Value::as_object_mut) {
        if original {
            settings.insert("bangumiApiBaseUrl".into(), json!(""));
        } else if value_string(settings.get("bangumiApiBaseUrl")) == LEGACY_BANGUMI_PROXY {
            settings.insert("bangumiApiBaseUrl".into(), json!(DEFAULT_BANGUMI_PROXY));
        }
    }
    let cache_dir = data_dir.join("season-cache");
    fs::create_dir_all(&cache_dir)?;
    let context = AppContext {
        state: Arc::new(Mutex::new(state)),
        runtime: Arc::new(Mutex::new(json!({
            "isDesktop": cfg!(desktop),
            "notificationsSupported": true,
            "platform": if cfg!(target_os = "android") { "android" } else { std::env::consts::OS },
            "edition": if original { "original" } else { "standard" }
        }))),
        data_dir,
        cache_dir,
        client: reqwest::Client::builder()
            .user_agent(concat!("AniLog Tauri/", env!("CARGO_PKG_VERSION")))
            .build()?,
        original,
        sync_wakeup: Arc::new(tokio::sync::Notify::new()),
        webdav_wakeup: Arc::new(tokio::sync::Notify::new()),
        webdav_sync_lock: Arc::new(tokio::sync::Mutex::new(())),
        #[cfg(desktop)]
        main_window_opening: Arc::new(AtomicBool::new(false)),
        bangumi_lookup_lock: Arc::new(tokio::sync::Mutex::new(())),
        bangumi_unavailable_until: Arc::new(AtomicI64::new(0)),
        offline_bangumi: Arc::new(
            serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/bangumi-map.json")))
                .unwrap_or_else(|_| json!({})),
        ),
        #[cfg(feature = "standard")]
        bangumi_tokens: bangumi_token_store(app),
        #[cfg(feature = "standard")]
        bangumi_username_cache: Arc::new(Mutex::new(None)),
    };
    #[cfg(not(target_os = "android"))]
    if let Err(error) = migrate_legacy_webdav_config(&context) {
        warn!("failed to migrate legacy WebDAV configuration: {error}");
    }
    context.save_state()?;
    Ok(context)
}

/// 按平台选择 Bangumi Token 存储实现（schema §8）：
/// Windows → Credential Manager（KeyringTokenStore）；Android → mobile 桥
/// （Keystore，决策 12：桥只做凭据存取，不发起任何 Bangumi 请求）；
/// 其他平台 → UnsupportedTokenStore。
#[cfg(feature = "standard")]
fn bangumi_token_store(app: &AppHandle) -> Arc<dyn bangumi::BangumiTokenStore + Send + Sync> {
    let _ = app;
    #[cfg(target_os = "android")]
    {
        let bridge = app.state::<mobile::MobileBridge>().inner().clone();
        return Arc::new(mobile::MobileBangumiTokenStore::new(bridge));
    }
    #[cfg(target_os = "windows")]
    {
        return Arc::new(bangumi::KeyringTokenStore::default());
    }
    #[cfg(not(any(target_os = "android", target_os = "windows")))]
    {
        Arc::new(bangumi::UnsupportedTokenStore)
    }
}

/// 主客户端基址解析（决策 11）：读顶层 `bangumi.apiBaseUrl`，为空回落
/// `settings.bangumiApiBaseUrl`，再为空用官方 `https://api.bgm.tv`。
#[cfg(feature = "standard")]
fn bangumi_base_urls(state: &Value) -> bangumi::BangumiBaseUrls {
    let from_block = value_string(state.get("bangumi").and_then(|block| block.get("apiBaseUrl")));
    let configured = if from_block.trim().is_empty() {
        value_string(state["settings"].get("bangumiApiBaseUrl"))
    } else {
        from_block
    };
    bangumi::resolve_base_urls(&configured)
}

/// 决策 11 的正向同步：把 `settings.bangumiApiBaseUrl` 的当前值镜像到顶层
/// `bangumi.apiBaseUrl`（update_settings 编辑旧字段时调用；
/// `bangumi_set_api_base_url` 命令则负责反向入口，两处同写）。
#[cfg(feature = "standard")]
fn sync_bangumi_api_base_url_into_block(state: &mut Value) {
    let url = value_string(state["settings"].get("bangumiApiBaseUrl"));
    if let Some(block) = state.get_mut("bangumi").and_then(Value::as_object_mut) {
        block.insert("apiBaseUrl".into(), json!(url));
    }
}

/// Original 版 `bangumi_auth_status` 的统一拒绝返回（双 edition 编译，
/// original 下 6 个 bangumi 命令运行即走拒绝路径；永不回传 Token 本体）。
fn bangumi_auth_status_rejected() -> Value {
    json!({"supported": false, "hasToken": false, "apiBaseUrl": ""})
}

/// Original 版其余 bangumi 命令的统一拒绝返回（固定文案，前端 i18n 按此映射）。
fn bangumi_command_rejected() -> Value {
    json!({"ok": false, "message": "Original 版不支持 Bangumi"})
}

impl AppContext {
    fn state_path(&self) -> PathBuf {
        self.data_dir.join("anilog-state.json")
    }
    fn save_state(&self) -> anyhow::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("state lock poisoned"))?
            .clone();
        if let Some(object) = state.as_object_mut() {
            object.remove("runtime");
        }
        ensure_sync_metadata(&mut state);
        let target = self.state_path();
        let temporary = target.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(&state)?)?;
        fs::rename(temporary, target)?;
        Ok(())
    }
    fn public_state(&self) -> Value {
        let mut state = self.state.lock().expect("state lock poisoned").clone();
        state["runtime"] = self.runtime.lock().expect("runtime lock poisoned").clone();
        state
    }
}

fn emit_state(app: &AppHandle, context: &AppContext) {
    let _ = app.emit("state-changed", context.public_state());
}

fn title_for(title: &Value, preference: &str, language: &str) -> String {
    let keys: &[&str] = match preference {
        "romaji" => &["romaji", "english", "native"],
        "native" => &["native", "romaji", "english"],
        _ => &["english", "romaji", "native"],
    };
    keys.iter()
        .find_map(|key| {
            title
                .get(*key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| {
            if language == "en-US" {
                "Untitled anime".into()
            } else {
                "未命名番剧".into()
            }
        })
}

fn followed_title_fields(
    state: &Value,
    anime: &Value,
    original: bool,
) -> (String, &'static str, Value) {
    if !original {
        let anime_id = value_i64(anime.get("id")).to_string();
        if let Some(matched) = state["bangumiTitles"].get(&anime_id) {
            if value_string(matched.get("status")) == "matched" {
                let chinese = value_string(matched.get("nameCn"));
                if !chinese.is_empty() {
                    return (
                        chinese,
                        "bangumi",
                        matched.get("subjectId").cloned().unwrap_or(Value::Null),
                    );
                }
            }
        }
    }
    let settings = &state["settings"];
    (
        title_for(
            anime.get("title").unwrap_or(&Value::Null),
            &value_string(settings.get("titlePreference")),
            &value_string(settings.get("uiLanguage")),
        ),
        "anilist",
        Value::Null,
    )
}

fn refresh_original_followed_titles(state: &mut Value) {
    let preference = value_string(state["settings"].get("titlePreference"));
    let language = value_string(state["settings"].get("uiLanguage"));
    if let Some(following) = state["following"].as_array_mut() {
        for item in following
            .iter_mut()
            .filter(|item| value_string(item.get("titleSource")) != "custom")
        {
            item["displayTitle"] = json!(title_for(&item["title"], &preference, &language));
        }
    }
    let followed_titles = state["following"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            (
                value_i64(item.get("id")),
                value_string(item.get("displayTitle")),
            )
        })
        .collect::<HashMap<_, _>>();
    if let Some(tasks) = state["tasks"].as_array_mut() {
        for task in tasks {
            if let Some(title) = followed_titles.get(&value_i64(task.get("animeId"))) {
                task["animeTitle"] = json!(title);
            }
        }
    }
}

fn normalize_url(input: &str, suffix: Option<&str>) -> anyhow::Result<String> {
    let value = input.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    let mut url = url::Url::parse(value).context("请输入有效的 HTTPS 地址")?;
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(anyhow!("地址必须是无账号、参数或片段的 HTTPS 地址"));
    }
    let path = url.path().trim_end_matches('/').to_string();
    if let Some(required_suffix) = suffix {
        let next_path = if path.ends_with(required_suffix) {
            path
        } else {
            format!("{path}{required_suffix}")
        };
        url.set_path(&next_path);
    } else {
        url.set_path(&format!("{path}/"));
    }
    Ok(url.to_string().trim_end_matches('/').to_string() + if suffix.is_some() { "" } else { "/" })
}

fn validate_webdav_config(
    enabled: bool,
    base_url: &str,
    username: &str,
    has_password: bool,
) -> anyhow::Result<()> {
    if enabled && (base_url.is_empty() || username.trim().is_empty() || !has_password) {
        return Err(anyhow!("启用同步前请完整填写地址、用户名和密码"));
    }
    Ok(())
}

fn mark_following_changed(state: &mut Value, anime_id: i64) {
    ensure_sync_metadata(state);
    if let Some(item) = state["following"].as_array_mut().and_then(|items| {
        items
            .iter_mut()
            .find(|item| value_i64(item.get("id")) == anime_id)
    }) {
        item["syncUpdatedAt"] = json!(now_millis());
    }
    if let Some(tombstones) = state["syncMetadata"]["followingDeletedAt"].as_object_mut() {
        tombstones.remove(&anime_id.to_string());
    }
}

fn mark_following_deleted(state: &mut Value, anime_id: i64) {
    ensure_sync_metadata(state);
    state["syncMetadata"]["followingDeletedAt"][anime_id.to_string()] = json!(now_millis());
}

fn remove_following(state: &mut Value, anime_id: i64) -> bool {
    let Some(index) = state["following"].as_array().and_then(|items| {
        items
            .iter()
            .position(|item| value_i64(item.get("id")) == anime_id)
    }) else {
        return false;
    };
    state["following"].as_array_mut().unwrap().remove(index);
    state["tasks"].as_array_mut().unwrap().retain(|task| {
        !(value_i64(task.get("animeId")) == anime_id
            && value_string(task.get("status")) == "pending")
    });
    mark_following_deleted(state, anime_id);
    true
}

fn record_timestamp(record: &Value, fallback: &str) -> i64 {
    let explicit = value_i64(record.get("syncUpdatedAt"));
    if explicit > 0 {
        explicit
    } else {
        value_i64(record.get(fallback)) * 1000
    }
}

fn stable_record(record: &Value) -> String {
    let Some(object) = record.as_object() else {
        return String::new();
    };
    let ordered: BTreeMap<&String, &Value> = object.iter().collect();
    serde_json::to_string(&ordered).unwrap_or_default()
}

fn choose_record(left: Option<&Value>, right: Option<&Value>, fallback: &str) -> Option<Value> {
    match (left, right) {
        (None, None) => None,
        (Some(value), None) | (None, Some(value)) => Some(value.clone()),
        (Some(left), Some(right)) => {
            let left_time = record_timestamp(left, fallback);
            let right_time = record_timestamp(right, fallback);
            if left_time != right_time {
                Some(if left_time > right_time { left } else { right }.clone())
            } else {
                Some(
                    if stable_record(left) >= stable_record(right) {
                        left
                    } else {
                        right
                    }
                    .clone(),
                )
            }
        }
    }
}

fn tombstones(value: Option<&Value>) -> BTreeMap<String, i64> {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|object| object.iter())
        .filter_map(|(id, timestamp)| {
            let id_number = id.parse::<i64>().ok()?;
            let timestamp = timestamp.as_i64()?;
            (id_number > 0 && timestamp > 0).then_some((id_number.to_string(), timestamp))
        })
        .collect()
}

fn document_from_state(state: &mut Value) -> Value {
    ensure_sync_metadata(state);
    let mut following = state["following"].as_array().cloned().unwrap_or_default();
    following.retain(|item| {
        value_i64(item.get("id")) > 0 && item.get("title").is_some_and(Value::is_object)
    });
    following.sort_by_key(|item| value_i64(item.get("id")));
    let mut tasks = state["tasks"].as_array().cloned().unwrap_or_default();
    tasks.retain(|task| {
        !value_string(task.get("id")).is_empty()
            && value_i64(task.get("animeId")) > 0
            && value_i64(task.get("episode")) > 0
            && matches!(
                value_string(task.get("status")).as_str(),
                "pending" | "completed"
            )
    });
    tasks.sort_by_key(|task| value_string(task.get("id")));
    let deleted = tombstones(state["syncMetadata"].get("followingDeletedAt"));
    let updated_at = following
        .iter()
        .map(|item| record_timestamp(item, "followedAt"))
        .chain(tasks.iter().map(|task| record_timestamp(task, "createdAt")))
        .chain(deleted.values().copied())
        .max()
        .unwrap_or(0);
    json!({"version": SYNC_VERSION, "updatedAt": updated_at, "following": following, "tasks": tasks, "followingDeletedAt": deleted})
}

fn normalize_document(document: &Value) -> anyhow::Result<Value> {
    if value_i64(document.get("version")) != SYNC_VERSION {
        return Err(anyhow!("WebDAV 同步文件版本不受支持"));
    }
    let mut state = json!({
        "following": document.get("following").and_then(Value::as_array).cloned().unwrap_or_default(),
        "tasks": document.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default(),
        "syncMetadata": {"followingDeletedAt": tombstones(document.get("followingDeletedAt"))}
    });
    Ok(document_from_state(&mut state))
}

fn comparable_document(document: &Value) -> anyhow::Result<String> {
    let normalized = normalize_document(document)?;
    Ok(serde_json::to_string(
        &json!({"following": normalized["following"], "tasks": normalized["tasks"], "followingDeletedAt": normalized["followingDeletedAt"]}),
    )?)
}

fn merge_document_into_state(
    state: &mut Value,
    remote: &Value,
) -> anyhow::Result<(bool, Value, bool)> {
    let before = comparable_document(&document_from_state(state))?;
    let local = document_from_state(state);
    let remote = normalize_document(remote)?;
    let mut deleted = tombstones(local.get("followingDeletedAt"));
    for (id, timestamp) in tombstones(remote.get("followingDeletedAt")) {
        deleted
            .entry(id)
            .and_modify(|value| *value = (*value).max(timestamp))
            .or_insert(timestamp);
    }
    let local_following: HashMap<i64, Value> = local["following"]
        .as_array()
        .unwrap()
        .iter()
        .cloned()
        .map(|item| (value_i64(item.get("id")), item))
        .collect();
    let remote_following: HashMap<i64, Value> = remote["following"]
        .as_array()
        .unwrap()
        .iter()
        .cloned()
        .map(|item| (value_i64(item.get("id")), item))
        .collect();
    let ids: HashSet<i64> = local_following
        .keys()
        .chain(remote_following.keys())
        .copied()
        .chain(deleted.keys().filter_map(|id| id.parse().ok()))
        .collect();
    let mut following = Vec::new();
    for id in ids {
        if let Some(winner) = choose_record(
            local_following.get(&id),
            remote_following.get(&id),
            "followedAt",
        ) {
            if record_timestamp(&winner, "followedAt") > *deleted.get(&id.to_string()).unwrap_or(&0)
            {
                following.push(winner);
            }
        }
    }
    following.sort_by_key(|item| value_i64(item.get("id")));
    let local_tasks: HashMap<String, Value> = local["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .cloned()
        .map(|item| (value_string(item.get("id")), item))
        .collect();
    let remote_tasks: HashMap<String, Value> = remote["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .cloned()
        .map(|item| (value_string(item.get("id")), item))
        .collect();
    let task_ids: HashSet<String> = local_tasks
        .keys()
        .chain(remote_tasks.keys())
        .cloned()
        .collect();
    let followed: HashMap<i64, String> = following
        .iter()
        .map(|item| {
            (
                value_i64(item.get("id")),
                value_string(item.get("displayTitle")),
            )
        })
        .collect();
    let mut tasks = Vec::new();
    for id in task_ids {
        if let Some(mut winner) =
            choose_record(local_tasks.get(&id), remote_tasks.get(&id), "createdAt")
        {
            let anime_id = value_i64(winner.get("animeId"));
            if !followed.contains_key(&anime_id) && value_string(winner.get("status")) == "pending"
            {
                continue;
            }
            if let Some(title) = followed.get(&anime_id) {
                winner["animeTitle"] = json!(title);
            }
            tasks.push(winner);
        }
    }
    tasks.sort_by(|left, right| {
        value_i64(right.get("airingAt"))
            .cmp(&value_i64(left.get("airingAt")))
            .then_with(|| value_string(left.get("id")).cmp(&value_string(right.get("id"))))
    });
    state["following"] = json!(following);
    state["tasks"] = json!(tasks);
    state["syncMetadata"]["followingDeletedAt"] = json!(deleted);
    let merged = document_from_state(state);
    Ok((
        before != comparable_document(&merged)?,
        merged.clone(),
        comparable_document(&remote)? != comparable_document(&merged)?,
    ))
}

const SEASON_QUERY: &str = r#"query SeasonAnime($season: MediaSeason, $year: Int, $page: Int) {
  Page(page: $page, perPage: 50) { pageInfo { lastPage }
    media(type: ANIME, season: $season, seasonYear: $year, status_not: CANCELLED, isAdult: false, sort: [POPULARITY_DESC]) {
      id title { native romaji english } coverImage { extraLarge medium color } bannerImage description(asHtml: false)
      format episodes duration status season seasonYear startDate { year month day } studios(isMain: true) { nodes { name } }
      genres averageScore popularity nextAiringEpisode { episode airingAt timeUntilAiring }
      airingSchedule(notYetAired: true, perPage: 50) { nodes { episode airingAt } } siteUrl
    }
  }
}"#;

#[cfg(not(target_os = "android"))]
const AIRING_QUERY: &str = r#"query AiredEpisodes($ids: [Int], $from: Int, $to: Int, $page: Int) {
  Page(page: $page, perPage: 50) { pageInfo { hasNextPage }
    airingSchedules(mediaId_in: $ids, airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      id mediaId episode airingAt media { id title { native romaji english } coverImage { medium }
      episodes nextAiringEpisode { episode airingAt timeUntilAiring } }
    }
  }
}"#;

fn season_cache_ttl_millis(season: &str, year: i64, current_year: i64, current_month: u32) -> i64 {
    let season_end_month = match season {
        "WINTER" => 3,
        "SPRING" => 6,
        "SUMMER" => 9,
        "FALL" => 12,
        _ => return 0,
    };
    let historical =
        year < current_year || (year == current_year && current_month > season_end_month);
    if historical {
        30 * 86_400_000
    } else {
        6 * 3_600_000
    }
}

async fn anilist_request(
    context: &AppContext,
    query: &str,
    variables: Value,
) -> anyhow::Result<Value> {
    let response = context
        .client
        .post(ANILIST_API)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json")
        .json(&json!({"query": query, "variables": variables}))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(anyhow!("AniList 请求失败（HTTP {}）", response.status()));
    }
    let payload: Value = response.json().await?;
    if let Some(error) = payload["errors"]
        .as_array()
        .and_then(|errors| errors.first())
    {
        return Err(anyhow!("{}", value_string(error.get("message"))));
    }
    Ok(payload["data"].clone())
}

fn season_cache_path(context: &AppContext, season: &str, year: i64) -> PathBuf {
    context.cache_dir.join(format!("{year}-{season}.json"))
}

async fn fetch_season_network(
    context: &AppContext,
    season: &str,
    year: i64,
) -> anyhow::Result<Vec<Value>> {
    let first = anilist_request(
        context,
        SEASON_QUERY,
        json!({"season": season, "year": year, "page": 1}),
    )
    .await?;
    let page = &first["Page"];
    let last_page = value_i64(page["pageInfo"].get("lastPage")).clamp(1, 5);
    let mut all = page["media"].as_array().cloned().unwrap_or_default();
    for page_number in 2..=last_page {
        let next = anilist_request(
            context,
            SEASON_QUERY,
            json!({"season": season, "year": year, "page": page_number}),
        )
        .await?;
        all.extend(
            next["Page"]["media"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
        );
    }
    Ok(all)
}

#[tauri::command]
async fn fetch_season(
    app: AppHandle,
    context: State<'_, AppContext>,
    params: Value,
) -> Result<Vec<Value>, String> {
    let season = value_string(params.get("season"));
    let year = value_i64(params.get("year"));
    if !["WINTER", "SPRING", "SUMMER", "FALL"].contains(&season.as_str()) || year < 1900 {
        return Err("无效的季度参数".into());
    }
    let cache_path = season_cache_path(&context, &season, year);
    if let Ok(body) = fs::read_to_string(&cache_path) {
        if let Ok(entry) = serde_json::from_str::<Value>(&body) {
            let age = now_millis() - value_i64(entry.get("fetchedAt"));
            let today = Local::now();
            let ttl =
                season_cache_ttl_millis(&season, year, i64::from(today.year()), today.month());
            if entry.get("version") == Some(&json!(CACHE_VERSION))
                && entry["anime"].is_array()
                && age < ttl
            {
                return Ok(entry["anime"].as_array().cloned().unwrap_or_default());
            }
        }
    }
    let anime = fetch_season_network(&context, &season, year)
        .await
        .map_err(|error| error.to_string())?;
    let entry = json!({"version": CACHE_VERSION, "season": season, "year": year, "fetchedAt": now_millis(), "anime": anime});
    let temporary = cache_path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec(&entry).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, &cache_path).map_err(|error| error.to_string())?;
    let _ = app.emit("season-updated", json!({"season": season, "year": year, "anime": entry["anime"], "fetchedAt": entry["fetchedAt"]}));
    Ok(entry["anime"].as_array().cloned().unwrap_or_default())
}

#[tauri::command]
fn get_state(_app: AppHandle, context: State<'_, AppContext>) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    mobile::consume_events(&_app, &context).map_err(|error| error.to_string())?;
    Ok(context.public_state())
}

fn refresh_mobile_configuration(app: &AppHandle, context: &AppContext) -> Result<(), String> {
    #[cfg(target_os = "android")]
    mobile::configure(app, context).map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "android"))]
    let _ = (app, context);
    Ok(())
}

#[tauri::command]
fn toggle_follow(
    app: AppHandle,
    context: State<'_, AppContext>,
    anime: Value,
) -> Result<Value, String> {
    let id = value_i64(anime.get("id"));
    let mut state = context.state.lock().map_err(|_| "状态锁不可用")?;
    if !remove_following(&mut state, id) {
        let title = anime.get("title").cloned().unwrap_or_default();
        let (title_value, title_source, bangumi_id) =
            followed_title_fields(&state, &anime, context.original);
        state["following"].as_array_mut().unwrap().push(json!({
            "id": id, "title": title, "displayTitle": title_value, "titleSource": title_source, "bangumiId": bangumi_id,
            "coverImage": anime["coverImage"]["medium"].as_str().or(anime["coverImage"]["extraLarge"].as_str()).unwrap_or_default(),
            "format": anime.get("format"), "episodes": anime.get("episodes"), "seasonYear": anime.get("seasonYear"),
            "startDate": anime.get("startDate"), "nextAiringEpisode": anime.get("nextAiringEpisode"), "siteUrl": anime.get("siteUrl"),
            "followedAt": now_seconds(), "syncUpdatedAt": now_millis()
        }));
        mark_following_changed(&mut state, id);
    }
    drop(state);
    context.save_state().map_err(|error| error.to_string())?;
    context.webdav_wakeup.notify_one();
    refresh_mobile_configuration(&app, &context)?;
    emit_state(&app, &context);
    Ok(context.public_state())
}

#[tauri::command]
fn update_follow_title(
    app: AppHandle,
    context: State<'_, AppContext>,
    anime_id: i64,
    display_title: String,
) -> Result<Value, String> {
    let title = display_title.trim();
    if title.is_empty() {
        return Ok(context.public_state());
    }
    let mut state = context.state.lock().map_err(|_| "状态锁不可用")?;
    if let Some(followed) = state["following"].as_array_mut().and_then(|items| {
        items
            .iter_mut()
            .find(|item| value_i64(item.get("id")) == anime_id)
    }) {
        followed["displayTitle"] = json!(title);
        followed["titleSource"] = json!("custom");
        if let Some(tasks) = state["tasks"].as_array_mut() {
            for task in tasks
                .iter_mut()
                .filter(|task| value_i64(task.get("animeId")) == anime_id)
            {
                task["animeTitle"] = json!(title);
            }
        }
        mark_following_changed(&mut state, anime_id);
    }
    drop(state);
    context.save_state().map_err(|error| error.to_string())?;
    context.webdav_wakeup.notify_one();
    refresh_mobile_configuration(&app, &context)?;
    emit_state(&app, &context);
    Ok(context.public_state())
}

#[tauri::command]
fn toggle_task(
    app: AppHandle,
    context: State<'_, AppContext>,
    task_id: String,
) -> Result<Value, String> {
    let mut state = context.state.lock().map_err(|_| "状态锁不可用")?;
    if let Some(task) = state["tasks"].as_array_mut().and_then(|items| {
        items
            .iter_mut()
            .find(|task| value_string(task.get("id")) == task_id)
    }) {
        let completed = value_string(task.get("status")) == "completed";
        task["status"] = json!(if completed { "pending" } else { "completed" });
        task["completedAt"] = if completed {
            Value::Null
        } else {
            json!(now_seconds())
        };
        task["syncUpdatedAt"] = json!(now_millis());
    }
    drop(state);
    context.save_state().map_err(|error| error.to_string())?;
    context.webdav_wakeup.notify_one();
    refresh_mobile_configuration(&app, &context)?;
    emit_state(&app, &context);
    Ok(context.public_state())
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    context: State<'_, AppContext>,
    settings: Value,
) -> Result<Value, String> {
    let interval_changed = settings
        .as_object()
        .is_some_and(|patch| patch.contains_key("pollIntervalMinutes"));
    #[cfg(desktop)]
    let tray_language_changed = settings
        .as_object()
        .is_some_and(|patch| patch.contains_key("uiLanguage"));
    #[cfg(desktop)]
    let tray_visibility_changed = settings
        .as_object()
        .is_some_and(|patch| patch.contains_key("showTrayIcon"));
    let mut state = context.state.lock().map_err(|_| "状态锁不可用")?;
    if let Some(patch) = settings.as_object() {
        if !context.original && patch.contains_key("bangumiApiBaseUrl") {
            context
                .bangumi_unavailable_until
                .store(0, Ordering::Relaxed);
        }
        let target = state["settings"].as_object_mut().unwrap();
        for (key, value) in patch {
            if key == "showTrayIcon" && !value.is_boolean() {
                continue;
            }
            if key != "bangumiApiBaseUrl" || !context.original {
                target.insert(key.clone(), value.clone());
            }
        }
        if let Some(url) = target.get("bangumiApiBaseUrl").and_then(Value::as_str) {
            target.insert(
                "bangumiApiBaseUrl".into(),
                json!(normalize_url(url, Some("/v0")).unwrap_or_default()),
            );
        }
        if context.original {
            target.insert("bangumiApiBaseUrl".into(), json!(""));
        }
        if let Some(time) = target.get("dailyTaskReminderTime").and_then(Value::as_str) {
            if !is_valid_reminder_time(time) {
                target.insert("dailyTaskReminderTime".into(), json!("20:00"));
            }
        }
        // 决策 11：standard 版用户编辑 settings.bangumiApiBaseUrl 时，同步写入
        // 顶层 bangumi.apiBaseUrl，保持两处一致（original 不写 bangumi 块，
        // 行为不变：仍然拒绝 bangumiApiBaseUrl 写入并强制为空）。
        #[cfg(feature = "standard")]
        if !context.original && patch.contains_key("bangumiApiBaseUrl") {
            sync_bangumi_api_base_url_into_block(&mut state);
        }
        if context.original && patch.contains_key("titlePreference") {
            refresh_original_followed_titles(&mut state);
        }
    }
    #[cfg(desktop)]
    let launch_at_login = value_bool(state["settings"].get("launchAtLogin"));
    #[cfg(desktop)]
    let tray_visible = show_tray_icon(&state["settings"]);
    drop(state);
    #[cfg(desktop)]
    {
        reconcile_autostart(&app, launch_at_login).map_err(|error| error.to_string())?;
    }
    context.save_state().map_err(|error| error.to_string())?;
    if settings
        .as_object()
        .is_some_and(|patch| patch.contains_key("titlePreference"))
    {
        context.webdav_wakeup.notify_one();
    }
    if interval_changed {
        context.sync_wakeup.notify_one();
    }
    #[cfg(desktop)]
    if tray_language_changed {
        setup_tray(&app, &context).map_err(|error| error.to_string())?;
    } else if tray_visibility_changed {
        if let Some(tray) = app.tray_by_id("main") {
            tray.set_visible(tray_visible)
                .map_err(|error| error.to_string())?;
        } else {
            setup_tray(&app, &context).map_err(|error| error.to_string())?;
        }
    }
    refresh_mobile_configuration(&app, &context)?;
    emit_state(&app, &context);
    Ok(context.public_state())
}

fn is_valid_reminder_time(time: &str) -> bool {
    DAILY_TASK_REMINDER_TIME_RE.is_match(time)
}

#[tauri::command]
async fn sync_now(app: AppHandle, context: State<'_, AppContext>) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let status = mobile::sync_native(&app, &context).map_err(|error| error.to_string())?;
        let created = value_i64(status.get("created"));
        return Ok(json!({"created": created, "syncedAt": value_i64(status.get("syncedAt"))}));
    }
    #[cfg(not(target_os = "android"))]
    sync_now_inner(&app, &context).await
}

#[cfg(not(target_os = "android"))]
#[derive(Debug, Default, PartialEq, Eq)]
struct AiringOutcome {
    aired: usize,
    created: usize,
}

#[cfg(not(target_os = "android"))]
fn apply_airing_schedules(state: &mut Value, schedules: &[Value], now: i64) -> AiringOutcome {
    let create_tasks = value_bool(state["settings"].get("createWatchTasks"));
    let mut known: HashSet<String> = state["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|task| task.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut seen: HashSet<String> = state["seenAiringEvents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let mut outcome = AiringOutcome::default();
    for airing in schedules {
        let anime_id = value_i64(airing.get("mediaId"));
        let episode = value_i64(airing.get("episode"));
        let airing_at = value_i64(airing.get("airingAt"));
        if anime_id <= 0 || episode <= 0 || airing_at <= 0 {
            continue;
        }
        let followed_index = state["following"].as_array().and_then(|items| {
            items
                .iter()
                .position(|item| value_i64(item.get("id")) == anime_id)
        });
        let Some(followed_index) = followed_index else {
            continue;
        };
        let followed_at = value_i64(state["following"][followed_index].get("followedAt"));
        if airing_at < followed_at {
            continue;
        }
        state["following"][followed_index]["nextAiringEpisode"] = airing
            .get("media")
            .and_then(|media| media.get("nextAiringEpisode"))
            .cloned()
            .unwrap_or(Value::Null);
        let id = format!("{anime_id}-{episode}");
        if seen.insert(id.clone()) {
            state["seenAiringEvents"]
                .as_array_mut()
                .unwrap()
                .push(json!(id));
            outcome.aired += 1;
        }
        if !create_tasks {
            continue;
        }
        if known.contains(&id) {
            continue;
        }
        let title = value_string(state["following"][followed_index].get("displayTitle"));
        let cover = airing["media"]["coverImage"]["medium"]
            .as_str()
            .or(state["following"][followed_index]["coverImage"].as_str())
            .unwrap_or_default()
            .to_string();
        state["tasks"].as_array_mut().unwrap().push(json!({"id": id, "animeId": anime_id, "animeTitle": title, "coverImage": cover, "episode": episode, "airingAt": airing_at, "status": "pending", "createdAt": now, "completedAt": null, "syncUpdatedAt": now_millis()}));
        known.insert(id);
        outcome.created += 1;
    }
    if let Some(events) = state["seenAiringEvents"].as_array_mut() {
        const MAX_SEEN_AIRING_EVENTS: usize = 2_000;
        if events.len() > MAX_SEEN_AIRING_EVENTS {
            events.drain(0..events.len() - MAX_SEEN_AIRING_EVENTS);
        }
    }
    outcome
}

#[cfg(not(target_os = "android"))]
async fn sync_now_inner(app: &AppHandle, context: &AppContext) -> Result<Value, String> {
    let (ids, from) = {
        let state = context.state.lock().map_err(|_| "状态锁不可用")?;
        (
            state["following"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .map(|item| value_i64(item.get("id")))
                .collect::<Vec<_>>(),
            value_i64(state.get("lastSyncAt")),
        )
    };
    let now = now_seconds();
    if ids.is_empty() {
        let mut state = context.state.lock().map_err(|_| "状态锁不可用")?;
        state["lastSyncAt"] = json!(now);
        drop(state);
        context.save_state().map_err(|error| error.to_string())?;
        emit_state(app, context);
        return Ok(json!({"created": 0, "syncedAt": now}));
    }
    let mut schedules = Vec::new();
    for page in 1..=10 {
        let response = anilist_request(
            &context,
            AIRING_QUERY,
            json!({"ids": ids, "from": from.min(now - 60), "to": now + 1, "page": page}),
        )
        .await
        .map_err(|error| error.to_string())?;
        schedules.extend(
            response["Page"]["airingSchedules"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
        );
        if !value_bool(response["Page"]["pageInfo"].get("hasNextPage")) {
            break;
        }
    }
    let mut state = context.state.lock().map_err(|_| "状态锁不可用")?;
    let outcome = apply_airing_schedules(&mut state, &schedules, now);
    state["lastSyncAt"] = json!(now);
    state["tasks"]
        .as_array_mut()
        .unwrap()
        .sort_by(|left, right| {
            value_i64(right.get("airingAt")).cmp(&value_i64(left.get("airingAt")))
        });
    drop(state);
    context.save_state().map_err(|error| error.to_string())?;
    emit_state(app, context);
    if outcome.created > 0 {
        context.webdav_wakeup.notify_one();
    }
    #[cfg(desktop)]
    if outcome.aired > 0 {
        let (language, notifications_enabled) = {
            let state = context.state.lock().map_err(|_| "状态锁不可用")?;
            (
                value_string(state["settings"].get("uiLanguage")),
                value_bool(state["settings"].get("notifyWhenAired")),
            )
        };
        if notifications_enabled {
            let (title, body) = if language == "en-US" {
                (
                    "Anime updates are available".to_string(),
                    format!("{} followed episode(s) have aired.", outcome.aired),
                )
            } else {
                (
                    "追番已更新".to_string(),
                    format!("你追的番剧有 {} 集新内容已播出。", outcome.aired),
                )
            };
            show_desktop_notification(app, title, body);
        }
    }
    Ok(json!({"created": outcome.created, "syncedAt": now}))
}

#[tauri::command]
fn get_cache_info(context: State<'_, AppContext>) -> Value {
    let bytes =
        directory_size(&context.cache_dir) + directory_size(&context.data_dir.join("webview-data"));
    json!({"bytes": bytes, "sessionBytes": 0, "legacyBytes": 0, "supported": true})
}

#[tauri::command]
fn clear_cache(app: AppHandle, context: State<'_, AppContext>) -> Value {
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.clear_all_browsing_data();
    }
    #[cfg(not(desktop))]
    let _ = &app;
    if context.cache_dir.exists() {
        let _ = fs::remove_dir_all(&context.cache_dir);
        let _ = fs::create_dir_all(&context.cache_dir);
    }
    get_cache_info(context)
}

fn directory_size(path: &Path) -> u64 {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .map(|path| {
            if path.is_dir() {
                directory_size(&path)
            } else {
                fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
            }
        })
        .sum()
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if url.starts_with("https://") {
        app.opener()
            .open_url(url, None::<String>)
            .map_err(|error| error.to_string())
    } else {
        Err("只允许打开 HTTPS 地址".into())
    }
}

fn normalize_title_key(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| character.to_lowercase())
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn anime_premiere_seconds(anime: &Value) -> i64 {
    let year = value_i64(anime["startDate"].get("year"));
    if year <= 0 {
        return 0;
    }
    let month = value_i64(anime["startDate"].get("month")).clamp(1, 12) as u32;
    let day = value_i64(anime["startDate"].get("day")).clamp(1, 28) as u32;
    chrono::NaiveDate::from_ymd_opt(year as i32, month, day)
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|date| date.and_utc().timestamp())
        .unwrap_or(0)
}

fn cached_bangumi_title(state: &Value, anime: &Value, now: i64) -> Option<Value> {
    let anime_id = value_i64(anime.get("id")).to_string();
    let cached = state["bangumiTitles"].get(&anime_id)?;
    let status = value_string(cached.get("status"));
    if status != "matched" && value_i64(cached.get("resolverVersion")) != BANGUMI_RESOLVER_VERSION {
        return None;
    }
    let checked_at = value_i64(cached.get("checkedAt"));
    if checked_at <= 0 {
        return None;
    }
    let max_age = if status == "matched" {
        180 * 86_400
    } else if anime_premiere_seconds(anime) > now {
        86_400
    } else {
        7 * 86_400
    };
    (now - checked_at < max_age).then(|| cached.clone())
}

fn anime_start_date(anime: &Value) -> String {
    let year = value_i64(anime["startDate"].get("year"));
    let month = value_i64(anime["startDate"].get("month"));
    let day = value_i64(anime["startDate"].get("day"));
    if year > 0 && month > 0 && day > 0 {
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        String::new()
    }
}

fn offline_format_matches(anime_format: &str, candidate_format: &str) -> bool {
    matches!(
        (anime_format, candidate_format),
        ("TV", "tv") | ("MOVIE", "movie") | ("OVA", "ova") | ("ONA", "web") | ("TV_SHORT", "web")
    )
}

// Look up a single subject entry directly by its Bangumi subject id in the
// offline map (v2 `bySubject`). Returns a copy of the stored entry, which
// carries `b/a/c/t/d/f/begin/broadcast/sites`. Consumed by the online-rebind
// path in Phase 2; exposed now so the mapping contract is unit tested.
#[allow(dead_code)]
pub(crate) fn offline_bangumi_subject(map: &Value, subject_id: i64) -> Option<Value> {
    map.get("bySubject")?
        .get(&subject_id.to_string())
        .cloned()
}

// Collect the bySubject candidates associated with an AniList id. The v2 map
// keys candidates by subject id and only records one representative per
// anilist id in `anilistIndex`, so recover every subject entry whose `a`
// (associated anilist id) matches to preserve the previous multi-candidate
// ranking behaviour. Falls back to the representative index entry when the
// scan finds no direct `a` match.
fn offline_anilist_candidates(map: &Value, anilist_id: i64) -> Vec<Value> {
    let Some(by_subject) = map.get("bySubject").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut candidates: Vec<Value> = by_subject
        .values()
        .filter(|entry| value_i64(entry.get("a")) == anilist_id)
        .cloned()
        .collect();
    if candidates.is_empty() {
        if let Some(subject_id) = map
            .get("anilistIndex")
            .and_then(|index| index.get(anilist_id.to_string()))
            .and_then(Value::as_i64)
        {
            if let Some(entry) = by_subject.get(&subject_id.to_string()) {
                candidates.push(entry.clone());
            }
        }
    }
    candidates
}

fn offline_bangumi_match(map: &Value, anime: &Value, checked_at: i64) -> Option<Value> {
    let candidates = offline_anilist_candidates(map, value_i64(anime.get("id")));
    if candidates.is_empty() {
        return None;
    }
    let anime_keys = ["native", "romaji", "english"]
        .iter()
        .filter_map(|key| anime["title"].get(*key).and_then(Value::as_str))
        .map(normalize_title_key)
        .filter(|key| !key.is_empty())
        .collect::<Vec<_>>();
    let start_date = anime_start_date(anime);
    let start_year = start_date.get(0..4).unwrap_or_default();
    let anime_format = value_string(anime.get("format"));
    let mut ranked = candidates
        .into_iter()
        .map(|candidate| {
            let candidate_key = normalize_title_key(&value_string(candidate.get("t")));
            let candidate_date = value_string(candidate.get("d"));
            let mut score = 0;
            if anime_keys.iter().any(|key| key == &candidate_key) {
                score += 100;
            } else if !candidate_key.is_empty()
                && anime_keys
                    .iter()
                    .any(|key| key.contains(&candidate_key) || candidate_key.contains(key))
            {
                score += 55;
            }
            if !start_date.is_empty() && candidate_date == start_date {
                score += 120;
            } else if !start_year.is_empty() && candidate_date.starts_with(start_year) {
                score += 30;
            }
            if offline_format_matches(&anime_format, &value_string(candidate.get("f"))) {
                score += 10;
            }
            (candidate, score)
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then_with(|| value_i64(left.0.get("b")).cmp(&value_i64(right.0.get("b"))))
    });
    if ranked.len() > 1 && ranked[0].1 - ranked[1].1 < 8 {
        return None;
    }
    let (candidate, score) = &ranked[0];
    let chinese = value_string(candidate.get("c"));
    if chinese.is_empty() {
        return None;
    }
    let original_title = value_string(candidate.get("t"));
    let original_title = if original_title.is_empty() {
        value_string(anime["title"].get("native"))
    } else {
        original_title
    };
    Some(json!({
        "animeId": anime["id"],
        "status": "matched",
        "subjectId": candidate["b"],
        "name": original_title,
        "nameCn": chinese,
        "confidence": if ranked.len() == 1 { 100 } else { (*score).clamp(68, 100) },
        "source": "bangumi-data-anilist-id",
        "checkedAt": checked_at,
        "resolverVersion": BANGUMI_RESOLVER_VERSION
    }))
}

fn persist_bangumi_result(
    app: &AppHandle,
    context: &AppContext,
    anime_id: i64,
    result: &Value,
) -> Result<(), String> {
    let mut followed_changed = false;
    let mut state = context.state.lock().map_err(|_| "状态锁不可用")?;
    state["bangumiTitles"][anime_id.to_string()] = result.clone();
    if result["status"] == "matched" {
        let chinese = value_string(result.get("nameCn"));
        if !chinese.is_empty() {
            if let Some(followed) = state["following"].as_array_mut().and_then(|items| {
                items
                    .iter_mut()
                    .find(|item| value_i64(item.get("id")) == anime_id)
            }) {
                if value_string(followed.get("titleSource")) != "custom" {
                    followed["displayTitle"] = json!(chinese);
                    followed["titleSource"] = json!("bangumi");
                    followed["bangumiId"] = result["subjectId"].clone();
                    followed_changed = true;
                }
            }
            if let Some(tasks) = state["tasks"].as_array_mut() {
                for task in tasks
                    .iter_mut()
                    .filter(|task| value_i64(task.get("animeId")) == anime_id)
                {
                    task["animeTitle"] = json!(chinese);
                    task["syncUpdatedAt"] = json!(now_millis());
                }
            }
        }
    }
    if followed_changed {
        mark_following_changed(&mut state, anime_id);
    }
    drop(state);
    context.save_state().map_err(|error| error.to_string())?;
    emit_state(app, context);
    if followed_changed {
        context.webdav_wakeup.notify_one();
    }
    Ok(())
}

fn can_use_bangumi(original: bool, _base_url: &str) -> bool {
    !original
}

async fn bangumi_search(
    context: &AppContext,
    base_url: &str,
    keyword: &str,
) -> anyhow::Result<Vec<Value>> {
    let endpoint = format!(
        "{}/search/subjects?limit=12&offset=0",
        base_url.trim_end_matches('/')
    );
    let response = context
        .client
        .post(endpoint)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json")
        .json(&json!({"keyword": keyword, "sort": "match", "filter": {"type": [2]}}))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(anyhow!("Bangumi 请求失败（HTTP {}）", response.status()));
    }
    Ok(response.json::<Value>().await?["data"]
        .as_array()
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
async fn resolve_bangumi_title(
    app: AppHandle,
    context: State<'_, AppContext>,
    anime: Value,
) -> Result<Value, String> {
    let base = {
        let state = context.state.lock().map_err(|_| "状态锁不可用")?;
        value_string(state["settings"].get("bangumiApiBaseUrl"))
    };
    if !can_use_bangumi(context.original, &base) {
        return Ok(
            json!({"animeId": anime["id"], "status": "unavailable", "checkedAt": now_seconds(), "resolverVersion": BANGUMI_RESOLVER_VERSION}),
        );
    }
    let checked = now_seconds();
    let cached = {
        let state = context.state.lock().map_err(|_| "状态锁不可用")?;
        cached_bangumi_title(&state, &anime, checked)
    };
    if let Some(cached) = cached {
        return Ok(cached);
    }
    if let Some(offline) = offline_bangumi_match(&context.offline_bangumi, &anime, checked) {
        persist_bangumi_result(&app, &context, value_i64(anime.get("id")), &offline)?;
        return Ok(offline);
    }
    if context.bangumi_unavailable_until.load(Ordering::Relaxed) > checked {
        return Ok(
            json!({"animeId": anime["id"], "status": "unavailable", "checkedAt": checked, "resolverVersion": BANGUMI_RESOLVER_VERSION}),
        );
    }
    let _lookup_guard = context.bangumi_lookup_lock.lock().await;
    let cached = {
        let state = context.state.lock().map_err(|_| "状态锁不可用")?;
        cached_bangumi_title(&state, &anime, checked)
    };
    if let Some(cached) = cached {
        return Ok(cached);
    }
    let title = anime.get("title").cloned().unwrap_or_default();
    let keywords: Vec<String> = ["native", "romaji", "english"]
        .iter()
        .filter_map(|key| title.get(*key).and_then(Value::as_str).map(str::to_string))
        .filter(|value| !value.is_empty())
        .collect();
    let mut candidates = BTreeMap::new();
    let mut received = false;
    for (index, keyword) in keywords.iter().take(3).enumerate() {
        if index > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(450)).await;
        }
        let endpoints = if base.trim().is_empty() {
            vec![OFFICIAL_BANGUMI_API]
        } else {
            vec![base.as_str(), OFFICIAL_BANGUMI_API]
        };
        for endpoint in endpoints {
            match bangumi_search(&context, endpoint, keyword).await {
                Ok(items) => {
                    received = true;
                    for item in items {
                        if let Some(id) = item.get("id").and_then(Value::as_i64) {
                            candidates.insert(id, item);
                        }
                    }
                    break;
                }
                Err(error) => {
                    warn!("Bangumi endpoint failed: {error}");
                }
            }
        }
    }
    let anime_keys: Vec<String> = keywords
        .iter()
        .map(|value| normalize_title_key(value))
        .collect();
    let mut ranked: Vec<(i64, Value, i64)> = candidates
        .into_iter()
        .filter_map(|(id, candidate)| {
            if value_string(candidate.get("name_cn")).trim().is_empty() {
                return None;
            }
            let names = [candidate.get("name"), candidate.get("name_cn")]
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            let keys = names
                .iter()
                .map(|name| normalize_title_key(name))
                .collect::<Vec<_>>();
            let score = keys
                .iter()
                .map(|key| {
                    anime_keys
                        .iter()
                        .map(|anime_key| {
                            if key == anime_key {
                                100
                            } else if key.contains(anime_key) || anime_key.contains(key) {
                                72
                            } else {
                                0
                            }
                        })
                        .max()
                        .unwrap_or(0)
                })
                .max()
                .unwrap_or(0);
            Some((id, candidate, score))
        })
        .collect();
    ranked.sort_by(|left, right| right.2.cmp(&left.2));
    let result = if let Some((id, candidate, score)) = ranked.first() {
        if *score >= 68 {
            json!({"animeId": anime["id"], "status": "matched", "subjectId": id, "name": candidate["name"], "nameCn": candidate["name_cn"], "confidence": score, "source": "tauri-title", "checkedAt": checked, "resolverVersion": BANGUMI_RESOLVER_VERSION})
        } else {
            json!({"animeId": anime["id"], "status": "unmatched", "confidence": score, "checkedAt": checked, "resolverVersion": BANGUMI_RESOLVER_VERSION})
        }
    } else {
        json!({"animeId": anime["id"], "status": if received { "unmatched" } else { "unavailable" }, "checkedAt": checked, "resolverVersion": BANGUMI_RESOLVER_VERSION})
    };
    if !received {
        context
            .bangumi_unavailable_until
            .store(checked + 10 * 60, Ordering::Relaxed);
    } else {
        context
            .bangumi_unavailable_until
            .store(0, Ordering::Relaxed);
        persist_bangumi_result(&app, &context, value_i64(anime.get("id")), &result)?;
    }
    tokio::time::sleep(std::time::Duration::from_millis(450)).await;
    Ok(result)
}

#[tauri::command]
async fn test_bangumi_connection(
    context: State<'_, AppContext>,
    base_url: String,
) -> Result<Value, String> {
    if context.original {
        return Ok(
            json!({"ok": false, "message": "AniLog Original 不使用 Bangumi API", "baseUrl": ""}),
        );
    }
    let normalized = normalize_url(&base_url, Some("/v0")).map_err(|error| error.to_string())?;
    let endpoint = if normalized.is_empty() {
        OFFICIAL_BANGUMI_API.to_string()
    } else {
        normalized
    };
    match bangumi_search(&context, &endpoint, "CLANNAD").await {
        Ok(_) => Ok(json!({"ok": true, "message": "Bangumi 连接成功", "baseUrl": endpoint})),
        Err(error) => Ok(json!({"ok": false, "message": error.to_string(), "baseUrl": endpoint})),
    }
}

// ---------------------------------------------------------------------------
// Phase 1 Bangumi 命令（Token + 连接 + 只读）。命令契约（前端按此对接）：
// - bangumi_auth_status() -> { supported, hasToken, apiBaseUrl }（永不回传 Token 本体）
// - bangumi_save_token({ token }) -> { ok, message }
// - bangumi_disconnect() -> { ok, message }
// - bangumi_test_connection({ baseUrl? }) -> { ok, message, username, nickname }
// - bangumi_get_user_profile() -> 用户 camelCase JSON | null
// - bangumi_get_user_collections({ offset?, limit? }) -> { total, items }
// - bangumi_set_api_base_url({ baseUrl }) -> public_state（决策 11 双向同步的另一入口）
// Original edition 下全部编译且运行即拒绝（固定文案 "Original 版不支持 Bangumi"）。
// 命令逻辑抽在 bangumi_commands 模块的内部函数中，测试以 MemoryTokenStore +
// mock server 直接调用，不依赖真实 keyring。
// ---------------------------------------------------------------------------

#[cfg(feature = "standard")]
mod bangumi_commands {
    use super::{AppContext, value_string};
    use crate::bangumi::{
        BangumiApiError, BangumiTokenStore, HttpBangumiClient, TokenStoreError,
        SUBJECT_TYPE_ANIME, bangumi_collection_json, bangumi_profile_json,
    };
    use serde_json::{Value, json};
    use std::sync::Mutex;

    /// 当前平台是否接入了安全凭据存储（Windows keyring / Android 桥）。
    pub(super) fn token_store_supported() -> bool {
        cfg!(any(target_os = "windows", target_os = "android"))
    }

    /// TokenStore 错误 → 用户文案。Android 桥失败与不支持平台使用固定文案
    /// （前端 i18n 按此映射）；Windows Credential Manager 的平台错误不含
    /// Token，可透传排障。
    pub(super) fn store_error_message(error: &TokenStoreError) -> String {
        if cfg!(target_os = "android") {
            "Bangumi 安全存储不可用".into()
        } else if !token_store_supported() {
            "当前平台不支持 Bangumi Token 存储".into()
        } else {
            format!("Bangumi Token 存储失败：{error}")
        }
    }

    /// BangumiApiError → 用户文案：401 与网络层失败使用固定文案，
    /// 其余错误直接使用 Display（不含任何 Token 材料，由 bangumi.rs 测试锁定）。
    pub(super) fn request_error_message(error: BangumiApiError) -> String {
        match error {
            BangumiApiError::Unauthorized { .. } => "Bangumi 授权失败，Token 可能已失效".into(),
            BangumiApiError::Network(_) | BangumiApiError::Timeout => {
                "无法连接 Bangumi 服务".into()
            }
            other => other.to_string(),
        }
    }

    fn profile_error_payload(message: &str) -> Value {
        json!({"ok": false, "message": message, "username": Value::Null, "nickname": Value::Null})
    }

    fn collections_error_payload(message: &str) -> Value {
        json!({"ok": false, "message": message, "total": 0, "items": []})
    }

    /// `bangumi_auth_status`：supported / hasToken / apiBaseUrl。
    pub(super) fn auth_status(state: &Value, tokens: &dyn BangumiTokenStore) -> Value {
        let supported = token_store_supported();
        let has_token = supported
            && tokens
                .load()
                .ok()
                .flatten()
                .is_some_and(|token| !token.trim().is_empty());
        // apiBaseUrl 展示值与 bangumi_base_urls 的读取顺序一致（决策 11）。
        let from_block = value_string(state.get("bangumi").and_then(|block| block.get("apiBaseUrl")));
        let api_base_url = if from_block.trim().is_empty() {
            value_string(state["settings"].get("bangumiApiBaseUrl"))
        } else {
            from_block
        };
        json!({"supported": supported, "hasToken": has_token, "apiBaseUrl": api_base_url})
    }

    /// `bangumi_save_token`：trim 后为空 → "Token 不能为空"；成功不回显 Token。
    pub(super) fn save_token(tokens: &dyn BangumiTokenStore, token: &str) -> Value {
        if !token_store_supported() {
            return json!({"ok": false, "message": "当前平台不支持 Bangumi Token 存储"});
        }
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return json!({"ok": false, "message": "Token 不能为空"});
        }
        match tokens.store(trimmed) {
            Ok(()) => json!({"ok": true, "message": "Bangumi Token 已保存"}),
            Err(error) => json!({"ok": false, "message": store_error_message(&error)}),
        }
    }

    /// `bangumi_disconnect`：清除 Token 并清空 username 缓存。
    pub(super) fn disconnect(tokens: &dyn BangumiTokenStore, username_cache: &Mutex<Option<String>>) -> Value {
        if !token_store_supported() {
            return json!({"ok": false, "message": "当前平台不支持 Bangumi Token 存储"});
        }
        if let Ok(mut cache) = username_cache.lock() {
            *cache = None;
        }
        match tokens.clear() {
            Ok(()) => json!({"ok": true, "message": "已断开 Bangumi 连接"}),
            Err(error) => json!({"ok": false, "message": store_error_message(&error)}),
        }
    }

    /// 读取 Token；错误时返回固定文案载荷。
    fn load_token(tokens: &dyn BangumiTokenStore) -> Result<String, Value> {
        match tokens.load() {
            Ok(Some(token)) if !token.trim().is_empty() => Ok(token),
            Ok(_) => Err(json!({"ok": false, "message": "尚未保存 Bangumi Token"})),
            Err(error) => Err(json!({"ok": false, "message": store_error_message(&error)})),
        }
    }

    /// `bangumi_test_connection`：有 Token 时 `GET /v0/me`。
    pub(super) async fn test_connection(
        tokens: &dyn BangumiTokenStore,
        client: &HttpBangumiClient,
        username_cache: &Mutex<Option<String>>,
    ) -> Value {
        let token = match load_token(tokens) {
            Ok(token) => token,
            Err(payload) => return profile_error_payload(payload["message"].as_str().unwrap_or_default()),
        };
        match client.test_connection(&token).await {
            Ok(profile) => {
                if let Ok(mut cache) = username_cache.lock() {
                    if !profile.username.trim().is_empty() {
                        *cache = Some(profile.username.clone());
                    }
                }
                json!({
                    "ok": true,
                    "message": "Bangumi 连接成功",
                    "username": profile.username,
                    "nickname": profile.nickname,
                })
            }
            Err(error) => profile_error_payload(&request_error_message(error)),
        }
    }

    /// `bangumi_get_user_profile`：无 Token / 失败 → `Value::Null`（Option 语义）。
    pub(super) async fn user_profile(
        tokens: &dyn BangumiTokenStore,
        client: &HttpBangumiClient,
    ) -> Value {
        let token = match load_token(tokens) {
            Ok(token) => token,
            Err(_) => return Value::Null,
        };
        match client.get_user_profile(&token).await {
            Ok(profile) => bangumi_profile_json(&profile),
            Err(_) => Value::Null,
        }
    }

    /// /v0/me → username 的进程内缓存读取（bangumi_get_user_collections 用）。
    async fn ensure_username(
        tokens: &dyn BangumiTokenStore,
        client: &HttpBangumiClient,
        username_cache: &Mutex<Option<String>>,
    ) -> Result<String, String> {
        if let Ok(cache) = username_cache.lock() {
            if let Some(username) = cache.as_ref().filter(|name| !name.trim().is_empty()) {
                return Ok(username.clone());
            }
        }
        let token = load_token(tokens).map_err(|payload| {
            payload["message"].as_str().unwrap_or_default().to_string()
        })?;
        let profile = client
            .get_user_profile(&token)
            .await
            .map_err(request_error_message)?;
        let username = profile.username.trim().to_string();
        if username.is_empty() {
            return Err("Bangumi 授权失败，Token 可能已失效".into());
        }
        if let Ok(mut cache) = username_cache.lock() {
            *cache = Some(username.clone());
        }
        Ok(username)
    }

    /// `bangumi_get_user_collections`：固定 subject_type=2（动画），
    /// 读端点 `/v0/users/{username}/collections`（username 先经 /v0/me 取得）。
    pub(super) async fn user_collections(
        tokens: &dyn BangumiTokenStore,
        client: &HttpBangumiClient,
        username_cache: &Mutex<Option<String>>,
        offset: Option<u32>,
        limit: Option<u32>,
    ) -> Value {
        if let Err(payload) = load_token(tokens) {
            return collections_error_payload(payload["message"].as_str().unwrap_or_default());
        }
        let username = match ensure_username(tokens, client, username_cache).await {
            Ok(username) => username,
            Err(message) => return collections_error_payload(&message),
        };
        let token = match load_token(tokens) {
            Ok(token) => token,
            Err(payload) => return collections_error_payload(payload["message"].as_str().unwrap_or_default()),
        };
        match client
            .get_user_collections(
                &token,
                &username,
                SUBJECT_TYPE_ANIME,
                limit.unwrap_or(30),
                offset.unwrap_or(0),
            )
            .await
        {
            Ok(page) => json!({
                "total": page.total,
                "items": page
                    .data
                    .iter()
                    .map(bangumi_collection_json)
                    .collect::<Vec<_>>(),
            }),
            Err(error) => collections_error_payload(&request_error_message(error)),
        }
    }

    /// `bangumi_set_api_base_url`（决策 11 的反向入口）：规范化后同时写入
    /// settings.bangumiApiBaseUrl 与顶层 bangumi.apiBaseUrl。
    pub(super) fn set_api_base_url(context: &AppContext, base_url: &str) -> Result<(), String> {
        let normalized = if base_url.trim().is_empty() {
            String::new()
        } else {
            super::normalize_url(base_url, Some("/v0")).map_err(|error| error.to_string())?
        };
        {
            let mut state = context.state.lock().map_err(|_| "状态锁不可用")?;
            state["settings"]["bangumiApiBaseUrl"] = json!(normalized);
            if let Some(block) = state.get_mut("bangumi").and_then(Value::as_object_mut) {
                block.insert("apiBaseUrl".into(), json!(normalized));
            }
        }
        context.save_state().map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[tauri::command]
fn bangumi_auth_status(context: State<'_, AppContext>) -> Result<Value, String> {
    if context.original {
        return Ok(bangumi_auth_status_rejected());
    }
    #[cfg(feature = "standard")]
    {
        let state = context.state.lock().map_err(|_| "状态锁不可用")?;
        return Ok(bangumi_commands::auth_status(
            &state,
            context.bangumi_tokens.as_ref(),
        ));
    }
    #[cfg(not(feature = "standard"))]
    Ok(bangumi_auth_status_rejected())
}

#[tauri::command]
fn bangumi_save_token(context: State<'_, AppContext>, token: String) -> Result<Value, String> {
    if context.original {
        return Ok(bangumi_command_rejected());
    }
    #[cfg(feature = "standard")]
    {
        return Ok(bangumi_commands::save_token(
            context.bangumi_tokens.as_ref(),
            &token,
        ));
    }
    #[cfg(not(feature = "standard"))]
    {
        let _ = token;
        Ok(bangumi_command_rejected())
    }
}

#[tauri::command]
fn bangumi_disconnect(context: State<'_, AppContext>) -> Result<Value, String> {
    if context.original {
        return Ok(bangumi_command_rejected());
    }
    #[cfg(feature = "standard")]
    {
        return Ok(bangumi_commands::disconnect(
            context.bangumi_tokens.as_ref(),
            &context.bangumi_username_cache,
        ));
    }
    #[cfg(not(feature = "standard"))]
    Ok(bangumi_command_rejected())
}

#[tauri::command]
async fn bangumi_test_connection(
    context: State<'_, AppContext>,
    base_url: Option<String>,
) -> Result<Value, String> {
    if context.original {
        return Ok(bangumi_command_rejected());
    }
    #[cfg(feature = "standard")]
    {
        // baseUrl 参数优先（测试连接按钮可先验证未保存的地址），否则按状态解析。
        let base = match base_url.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            Some(configured) => bangumi::resolve_base_urls(configured),
            None => {
                let state = context.state.lock().map_err(|_| "状态锁不可用")?;
                bangumi_base_urls(&state)
            }
        };
        let client = bangumi::HttpBangumiClient::new(context.client.clone(), base);
        return Ok(bangumi_commands::test_connection(
            context.bangumi_tokens.as_ref(),
            &client,
            &context.bangumi_username_cache,
        )
        .await);
    }
    #[cfg(not(feature = "standard"))]
    {
        let _ = base_url;
        Ok(bangumi_command_rejected())
    }
}

#[tauri::command]
async fn bangumi_get_user_profile(context: State<'_, AppContext>) -> Result<Value, String> {
    if context.original {
        return Ok(Value::Null);
    }
    #[cfg(feature = "standard")]
    {
        let base = {
            let state = context.state.lock().map_err(|_| "状态锁不可用")?;
            bangumi_base_urls(&state)
        };
        let client = bangumi::HttpBangumiClient::new(context.client.clone(), base);
        return Ok(bangumi_commands::user_profile(
            context.bangumi_tokens.as_ref(),
            &client,
        )
        .await);
    }
    #[cfg(not(feature = "standard"))]
    Ok(Value::Null)
}

#[tauri::command]
async fn bangumi_get_user_collections(
    context: State<'_, AppContext>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<Value, String> {
    if context.original {
        return Ok(json!({
            "ok": false,
            "message": "Original 版不支持 Bangumi",
            "total": 0,
            "items": []
        }));
    }
    #[cfg(feature = "standard")]
    {
        let base = {
            let state = context.state.lock().map_err(|_| "状态锁不可用")?;
            bangumi_base_urls(&state)
        };
        let client = bangumi::HttpBangumiClient::new(context.client.clone(), base);
        return Ok(bangumi_commands::user_collections(
            context.bangumi_tokens.as_ref(),
            &client,
            &context.bangumi_username_cache,
            offset,
            limit,
        )
        .await);
    }
    #[cfg(not(feature = "standard"))]
    {
        let _ = (offset, limit);
        Ok(json!({"total": 0, "items": []}))
    }
}

#[tauri::command]
fn bangumi_set_api_base_url(
    app: AppHandle,
    context: State<'_, AppContext>,
    base_url: String,
) -> Result<Value, String> {
    if context.original {
        return Ok(bangumi_command_rejected());
    }
    #[cfg(feature = "standard")]
    {
        bangumi_commands::set_api_base_url(&context, &base_url)?;
        refresh_mobile_configuration(&app, &context)?;
        emit_state(&app, &context);
        Ok(context.public_state())
    }
    #[cfg(not(feature = "standard"))]
    {
        let _ = (&app, base_url);
        Ok(bangumi_command_rejected())
    }
}

#[cfg(not(target_os = "android"))]
fn default_webdav_config() -> Value {
    json!({"supported": true, "enabled": false, "baseUrl": "", "username": "", "hasPassword": false, "lastSyncAt": 0, "lastError": ""})
}

#[cfg(not(target_os = "android"))]
fn webdav_config_path(context: &AppContext) -> PathBuf {
    context.data_dir.join("webdav-tauri.json")
}

#[cfg(not(target_os = "android"))]
fn webdav_config(context: &AppContext) -> Value {
    let mut config = fs::read_to_string(webdav_config_path(context))
        .ok()
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .unwrap_or_else(default_webdav_config);
    config["supported"] = json!(cfg!(target_os = "windows"));
    config["hasPassword"] = json!(load_webdav_password().is_ok());
    config
}

#[cfg(not(target_os = "android"))]
fn persist_webdav_config(context: &AppContext, config: &Value) -> anyhow::Result<()> {
    let mut private = config.clone();
    private
        .as_object_mut()
        .map(|object| object.remove("hasPassword"));
    let temporary = webdav_config_path(context).with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(&private)?)?;
    fs::rename(temporary, webdav_config_path(context))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn dpapi_unprotect(mut encrypted: Vec<u8>) -> anyhow::Result<Vec<u8>> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptUnprotectData};

    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted
            .len()
            .try_into()
            .context("DPAPI input is too large")?,
        pbData: encrypted.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, 0, &mut output)
            .context("Windows DPAPI could not decrypt the legacy value")?;
        let decrypted = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(decrypted)
    }
}

#[cfg(target_os = "windows")]
fn legacy_electron_encryption_key(data_dir: &Path) -> anyhow::Result<Vec<u8>> {
    let local_state_paths = [
        data_dir.join("Local State"),
        data_dir.join("Session Data").join("Local State"),
    ];
    for path in local_state_paths {
        let Some(encoded) = fs::read_to_string(&path)
            .ok()
            .and_then(|body| serde_json::from_str::<Value>(&body).ok())
            .and_then(|value| {
                value
                    .pointer("/os_crypt/encrypted_key")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        else {
            continue;
        };
        let encrypted = BASE64_STANDARD
            .decode(encoded)
            .context("legacy Electron encryption key is not valid Base64")?;
        let protected = encrypted
            .strip_prefix(b"DPAPI")
            .context("legacy Electron encryption key has an unsupported format")?;
        return dpapi_unprotect(protected.to_vec());
    }
    Err(anyhow!("legacy Electron Local State was not found"))
}

#[cfg(target_os = "windows")]
fn decrypt_legacy_webdav_password(data_dir: &Path, encoded: &str) -> anyhow::Result<String> {
    let encrypted = BASE64_STANDARD
        .decode(encoded)
        .context("legacy WebDAV password is not valid Base64")?;
    let decrypted = if let Some(payload) = encrypted.strip_prefix(b"v10") {
        if payload.len() < 12 + 16 {
            return Err(anyhow!("legacy WebDAV password is truncated"));
        }
        let key = legacy_electron_encryption_key(data_dir)?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| anyhow!("legacy Electron encryption key has an invalid length"))?;
        cipher
            .decrypt(aes_gcm::Nonce::from_slice(&payload[..12]), &payload[12..])
            .map_err(|_| anyhow!("legacy WebDAV password authentication failed"))?
    } else {
        dpapi_unprotect(encrypted)?
    };
    String::from_utf8(decrypted).context("legacy WebDAV password is not valid UTF-8")
}

#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
fn decrypt_legacy_webdav_password(_data_dir: &Path, _encoded: &str) -> anyhow::Result<String> {
    Err(anyhow!(
        "legacy WebDAV password migration is only available on Windows"
    ))
}

#[cfg(not(target_os = "android"))]
fn migrate_legacy_webdav_config(context: &AppContext) -> anyhow::Result<bool> {
    if let Some(current) = fs::read_to_string(webdav_config_path(context))
        .ok()
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
    {
        let migration_completed = value_bool(current.get("legacyMigrationCompleted"));
        let already_configured = !value_string(current.get("baseUrl")).is_empty()
            || !value_string(current.get("username")).is_empty();
        if migration_completed || already_configured {
            return Ok(false);
        }
    }
    let legacy_path = context.data_dir.join("webdav-config.json");
    if !legacy_path.exists() {
        return Ok(false);
    }
    let legacy: Value = serde_json::from_slice(
        &fs::read(&legacy_path).context("read legacy WebDAV configuration")?,
    )
    .context("parse legacy WebDAV configuration")?;
    let raw_base = value_string(legacy.get("baseUrl"));
    let base_url = if raw_base.is_empty() {
        String::new()
    } else {
        normalize_url(&raw_base, None).context("normalize legacy WebDAV address")?
    };
    let username = value_string(legacy.get("username")).trim().to_string();
    let encrypted_password = value_string(legacy.get("encryptedPassword"));
    let mut migration_error = String::new();
    let has_password = if encrypted_password.is_empty() {
        false
    } else {
        match decrypt_legacy_webdav_password(&context.data_dir, &encrypted_password)
            .and_then(|password| store_webdav_password(&password))
        {
            Ok(()) => true,
            Err(error) => {
                migration_error = format!("旧版 WebDAV 密码未能迁移，请重新输入密码：{error}");
                false
            }
        }
    };
    let enabled = value_bool(legacy.get("enabled"))
        && !base_url.is_empty()
        && !username.is_empty()
        && has_password;
    let config = json!({
        "supported": true,
        "enabled": enabled,
        "baseUrl": base_url,
        "username": username,
        "hasPassword": has_password,
        "lastSyncAt": value_i64(legacy.get("lastSyncAt")),
        "lastError": if migration_error.is_empty() { value_string(legacy.get("lastError")) } else { migration_error },
        "legacyMigrationCompleted": true,
    });
    persist_webdav_config(context, &config)?;
    info!("migrated legacy Electron WebDAV configuration");
    Ok(true)
}

#[cfg(all(not(target_os = "android"), target_os = "windows"))]
fn credential_entry() -> anyhow::Result<keyring::Entry> {
    Ok(keyring::Entry::new(WEBDAV_CREDENTIAL_SERVICE, "default")?)
}
#[cfg(all(not(target_os = "android"), target_os = "windows"))]
fn load_webdav_password() -> anyhow::Result<String> {
    Ok(credential_entry()?.get_password()?)
}
#[cfg(all(not(target_os = "android"), target_os = "windows"))]
fn store_webdav_password(password: &str) -> anyhow::Result<()> {
    credential_entry()?.set_password(password)?;
    Ok(())
}
#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
fn load_webdav_password() -> anyhow::Result<String> {
    Err(anyhow!("当前平台的安全凭据存储尚未接入"))
}
#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
fn store_webdav_password(_password: &str) -> anyhow::Result<()> {
    Err(anyhow!("当前平台的安全凭据存储尚未接入"))
}

#[cfg(not(target_os = "android"))]
fn webdav_endpoint(config: &Value, name: &str) -> anyhow::Result<String> {
    let base = url::Url::parse(&value_string(config.get("baseUrl")))?;
    Ok(base
        .join(&format!("{WEBDAV_COLLECTION}/{name}"))?
        .to_string())
}

#[cfg(not(target_os = "android"))]
async fn webdav_request(
    context: &AppContext,
    config: &Value,
    method: reqwest::Method,
    url: String,
    body: Option<String>,
    etag: Option<&str>,
    new_file: bool,
) -> anyhow::Result<reqwest::Response> {
    let password = load_webdav_password().context("WebDAV 密码无法读取，请重新输入密码")?;
    let mut request = context
        .client
        .request(method, url)
        .basic_auth(value_string(config.get("username")), Some(password))
        .header(USER_AGENT, "AniLog Tauri WebDAV sync");
    if let Some(body) = body {
        request = request
            .header(CONTENT_TYPE, "application/json; charset=utf-8")
            .body(body);
    }
    if let Some(etag) = etag.filter(|value| !value.is_empty()) {
        request = request.header(IF_MATCH, etag);
    } else if new_file {
        request = request.header(IF_NONE_MATCH, "*");
    }
    Ok(request
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await?)
}

#[cfg(not(target_os = "android"))]
async fn ensure_webdav_collection(context: &AppContext, config: &Value) -> anyhow::Result<()> {
    let response = webdav_request(
        context,
        config,
        reqwest::Method::from_bytes(b"MKCOL")?,
        webdav_endpoint(config, "")?,
        None,
        None,
        false,
    )
    .await?;
    if response.status().is_success() || response.status().as_u16() == 405 {
        Ok(())
    } else if matches!(response.status().as_u16(), 401 | 403) {
        Err(anyhow!("WebDAV 认证失败，请检查账号和应用密码"))
    } else {
        Err(anyhow!(
            "无法创建 AniLog 同步目录（HTTP {}）",
            response.status()
        ))
    }
}

#[cfg(not(target_os = "android"))]
async fn download_webdav_document(
    context: &AppContext,
    config: &Value,
) -> anyhow::Result<(bool, String, Option<Value>)> {
    let response = webdav_request(
        context,
        config,
        reqwest::Method::GET,
        webdav_endpoint(config, WEBDAV_DOCUMENT)?,
        None,
        None,
        false,
    )
    .await?;
    if response.status().as_u16() == 404 {
        return Ok((false, String::new(), None));
    }
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(anyhow!("WebDAV 认证失败，请检查账号和应用密码"));
    }
    if !response.status().is_success() {
        return Err(anyhow!(
            "读取 WebDAV 同步文件失败（HTTP {}）",
            response.status()
        ));
    }
    if response.content_length().unwrap_or_default() as usize > MAX_SYNC_BYTES {
        return Err(anyhow!("WebDAV 同步文件超过 5 MB，已停止读取"));
    }
    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_SYNC_BYTES {
        return Err(anyhow!("WebDAV 同步文件超过 5 MB，已停止读取"));
    }
    let document =
        serde_json::from_slice::<Value>(&bytes).context("WebDAV 同步文件不是有效的 JSON")?;
    Ok((true, etag, Some(normalize_document(&document)?)))
}

#[cfg(not(target_os = "android"))]
async fn perform_webdav_sync(app: &AppHandle, context: &AppContext) -> anyhow::Result<Value> {
    let mut config = webdav_config(context);
    if !value_bool(config.get("enabled")) {
        return Err(anyhow!("请先启用 WebDAV 同步"));
    }
    if load_webdav_password().is_err() {
        return Err(anyhow!("请重新输入 WebDAV 应用密码"));
    }
    ensure_webdav_collection(context, &config).await?;
    let mut local_changed = false;
    for attempt in 0..3 {
        let (found, etag, remote) = download_webdav_document(context, &config).await?;
        let (merged, remote_changed) = {
            let mut state = context.state.lock().map_err(|_| anyhow!("状态锁不可用"))?;
            if let Some(remote) = &remote {
                let (changed, merged, remote_changed) =
                    merge_document_into_state(&mut state, remote)?;
                local_changed |= changed;
                (merged, remote_changed)
            } else {
                (document_from_state(&mut state), true)
            }
        };
        if local_changed {
            context.save_state()?;
            emit_state(app, context);
        }
        if !remote_changed
            || remote.as_ref().is_some_and(|remote| {
                comparable_document(remote).ok() == comparable_document(&merged).ok()
            })
        {
            break;
        }
        let response = webdav_request(
            context,
            &config,
            reqwest::Method::PUT,
            webdav_endpoint(&config, WEBDAV_DOCUMENT)?,
            Some(serde_json::to_string_pretty(&merged)?),
            found.then_some(etag.as_str()),
            !found,
        )
        .await?;
        if response.status().is_success() {
            break;
        }
        if matches!(response.status().as_u16(), 409 | 412) {
            if attempt == 2 {
                return Err(anyhow!("WebDAV 文件在同步期间反复变化，请稍后重试"));
            }
            continue;
        }
        return Err(anyhow!(
            "写入 WebDAV 同步文件失败（HTTP {}）",
            response.status()
        ));
    }
    config["lastSyncAt"] = json!(now_seconds());
    config["lastError"] = json!("");
    persist_webdav_config(context, &config)?;
    Ok(
        json!({"ok": true, "changed": local_changed, "syncedAt": config["lastSyncAt"], "message": if local_changed { "已合并另一台设备的更新" } else { "两端数据已同步" }}),
    )
}

#[tauri::command]
fn get_webdav_config(_app: AppHandle, context: State<'_, AppContext>) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let _ = &context;
        return mobile::get_webdav_config(&_app).map_err(|error| error.to_string());
    }
    #[cfg(not(target_os = "android"))]
    Ok(webdav_config(&context))
}

#[tauri::command]
fn save_webdav_config(
    _app: AppHandle,
    context: State<'_, AppContext>,
    config: Value,
) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let mut config = config;
        config["baseUrl"] = json!(
            normalize_url(&value_string(config.get("baseUrl")), None)
                .map_err(|error| error.to_string())?
        );
        let current = mobile::get_webdav_config(&_app).map_err(|error| error.to_string())?;
        let has_password = !value_string(config.get("password")).is_empty()
            || value_bool(current.get("hasPassword"));
        validate_webdav_config(
            value_bool(config.get("enabled")),
            &value_string(config.get("baseUrl")),
            &value_string(config.get("username")),
            has_password,
        )
        .map_err(|error| error.to_string())?;
        let saved =
            mobile::save_webdav_config(&_app, &config).map_err(|error| error.to_string())?;
        if value_bool(saved.get("enabled")) {
            context.webdav_wakeup.notify_one();
        }
        return Ok(saved);
    }
    #[cfg(not(target_os = "android"))]
    {
        let base = normalize_url(&value_string(config.get("baseUrl")), None)
            .map_err(|error| error.to_string())?;
        let username = value_string(config.get("username"));
        let enabled = value_bool(config.get("enabled"));
        let old = webdav_config(&context);
        let password = value_string(config.get("password"));
        let has_password = !password.is_empty() || value_bool(old.get("hasPassword"));
        validate_webdav_config(enabled, &base, &username, has_password)
            .map_err(|error| error.to_string())?;
        let next = json!({"supported": true, "enabled": enabled, "baseUrl": base, "username": username, "hasPassword": has_password, "lastSyncAt": value_i64(old.get("lastSyncAt")), "lastError": "", "legacyMigrationCompleted": value_bool(old.get("legacyMigrationCompleted"))});
        if !password.is_empty() {
            store_webdav_password(&password).map_err(|error| error.to_string())?;
        }
        persist_webdav_config(&context, &next).map_err(|error| error.to_string())?;
        if enabled {
            context.webdav_wakeup.notify_one();
        }
        Ok(webdav_config(&context))
    }
}

#[tauri::command]
async fn test_webdav_connection(
    _app: AppHandle,
    context: State<'_, AppContext>,
) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let _ = &context;
        return mobile::test_webdav_connection(&_app).map_err(|error| error.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        let config = webdav_config(&context);
        let mut response = webdav_request(&context, &config, reqwest::Method::from_bytes(b"PROPFIND").map_err(|error| error.to_string())?, value_string(config.get("baseUrl")), Some("<?xml version=\"1.0\"?><propfind xmlns=\"DAV:\"><prop><resourcetype/></prop></propfind>".into()), None, false).await.map_err(|error| error.to_string())?;
        if matches!(response.status().as_u16(), 405 | 501) {
            response = webdav_request(
                &context,
                &config,
                reqwest::Method::GET,
                value_string(config.get("baseUrl")),
                None,
                None,
                false,
            )
            .await
            .map_err(|error| error.to_string())?;
        }
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err("WebDAV 认证失败，请检查账号和应用密码".into());
        }
        if !response.status().is_success() && response.status().as_u16() != 207 {
            return Err(format!("WebDAV 连接失败（HTTP {}）", response.status()));
        }
        Ok(json!({"ok": true, "message": "WebDAV 连接成功"}))
    }
}

#[tauri::command]
async fn sync_webdav(app: AppHandle, context: State<'_, AppContext>) -> Result<Value, String> {
    match perform_platform_webdav_sync(&app, &context).await {
        Ok(value) => Ok(value),
        Err(error) => {
            #[cfg(not(target_os = "android"))]
            {
                let mut config = webdav_config(&context);
                config["lastError"] = json!(error.to_string());
                let _ = persist_webdav_config(&context, &config);
            }
            Err(error.to_string())
        }
    }
}

async fn perform_platform_webdav_sync(
    app: &AppHandle,
    context: &AppContext,
) -> anyhow::Result<Value> {
    let _guard = context.webdav_sync_lock.lock().await;
    #[cfg(target_os = "android")]
    return mobile::sync_webdav(app, context);
    #[cfg(not(target_os = "android"))]
    perform_webdav_sync(app, context).await
}

fn webdav_is_enabled(app: &AppHandle, context: &AppContext) -> bool {
    #[cfg(target_os = "android")]
    {
        let _ = context;
        return mobile::get_webdav_config(app)
            .ok()
            .is_some_and(|config| value_bool(config.get("enabled")));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        value_bool(webdav_config(context).get("enabled"))
    }
}

fn start_webdav_background(app: AppHandle, context: AppContext) {
    tauri::async_runtime::spawn(async move {
        let mut startup = true;
        loop {
            let delay = if startup {
                std::time::Duration::from_secs(8)
            } else {
                std::time::Duration::from_secs(15 * 60)
            };
            let changed = tokio::time::timeout(delay, context.webdav_wakeup.notified())
                .await
                .is_ok();
            if changed {
                while tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    context.webdav_wakeup.notified(),
                )
                .await
                .is_ok()
                {}
            }
            if webdav_is_enabled(&app, &context) {
                if let Err(error) = perform_platform_webdav_sync(&app, &context).await {
                    warn!("background WebDAV sync failed: {error}");
                }
            }
            startup = false;
        }
    });
}

#[tauri::command]
fn request_exact_scheduling(_app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    mobile::request_exact_scheduling(&_app).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(desktop)]
fn show_main_window(app: &AppHandle) -> anyhow::Result<()> {
    let window = if let Some(window) = app.get_webview_window("main") {
        window
    } else {
        let config = app
            .config()
            .app
            .windows
            .iter()
            .find(|config| config.label == "main")
            .context("main window configuration is unavailable")?;
        let builder = tauri::WebviewWindowBuilder::from_config(app, config)?;
        #[cfg(target_os = "windows")]
        let builder =
            builder.data_directory(app.state::<AppContext>().data_dir.join("webview-data"));
        builder.build()?
    };
    if window.is_minimized()? {
        window.unminimize()?;
    }
    window.show()?;
    window.set_focus()?;
    Ok(())
}

#[cfg(desktop)]
fn request_show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let Some(context) = app.try_state::<AppContext>() else {
        return;
    };
    let opening = context.main_window_opening.clone();
    if opening
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = show_main_window(&app) {
            warn!("failed to recreate AniLog window: {error}");
        }
        opening.store(false, Ordering::Release);
    });
}

#[cfg(target_os = "windows")]
fn windows_notification_app_id(identifier: &str, exe_dir: &Path) -> String {
    let target_debug = Path::new("target").join("debug");
    let target_release = Path::new("target").join("release");
    if exe_dir.ends_with(target_debug) || exe_dir.ends_with(target_release) {
        tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string()
    } else {
        identifier.to_string()
    }
}

#[cfg(target_os = "windows")]
fn show_desktop_notification(app: &AppHandle, title: String, body: String) {
    use tauri_winrt_notification::{Duration, Toast};

    let identifier = app.config().identifier.clone();
    let app_id = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .map(|dir| windows_notification_app_id(&identifier, &dir))
        .unwrap_or(identifier);
    let activation_app = app.clone();
    std::thread::spawn(move || {
        let toast = Toast::new(&app_id)
            .title(&title)
            .text2(&body)
            .duration(Duration::Short)
            .sound(None)
            .on_activated(move |_| {
                let app = activation_app.clone();
                let callback_app = app.clone();
                let _ = app.run_on_main_thread(move || request_show_main_window(&callback_app));
                Ok(())
            });
        if let Err(error) = toast.show() {
            warn!("failed to show Windows notification: {error}");
        }
    });
}

#[cfg(all(desktop, not(target_os = "windows")))]
fn show_desktop_notification(app: &AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg(desktop)]
#[derive(Debug, PartialEq)]
struct TrayLabels {
    open: String,
    sync: String,
    quit: String,
    tooltip: String,
}

#[cfg(desktop)]
fn tray_labels(original: bool, language: &str) -> TrayLabels {
    let english = language == "en-US";
    let product_name = if original {
        "AniLog Original"
    } else {
        "AniLog"
    };
    TrayLabels {
        open: if english {
            format!("Open {product_name}")
        } else {
            format!("打开 {product_name}")
        },
        sync: if english { "Sync now" } else { "立即同步" }.into(),
        quit: if english { "Quit" } else { "退出" }.into(),
        tooltip: if english {
            format!("{product_name} - Anime tracker")
        } else {
            format!("{product_name} - 追番任务")
        },
    }
}

#[cfg(desktop)]
fn setup_tray(app: &AppHandle, context: &AppContext) -> anyhow::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;
    let (language, visible) = context
        .state
        .lock()
        .ok()
        .map(|state| {
            (
                value_string(state["settings"].get("uiLanguage")),
                show_tray_icon(&state["settings"]),
            )
        })
        .unwrap_or_else(|| ("zh-CN".into(), true));
    let labels = tray_labels(context.original, &language);
    let open = MenuItemBuilder::with_id("open", labels.open.clone()).build(app)?;
    let sync = MenuItemBuilder::with_id("sync", labels.sync.clone()).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", labels.quit.clone()).build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&open, &sync, &separator, &quit])
        .build()?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../../assets/tray.png"))?;
    let _ = app.remove_tray_by_id("main");
    let tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(labels.tooltip)
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                request_show_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                request_show_main_window(app);
            }
            "sync" => {
                let app = app.clone();
                let context = app.state::<AppContext>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = sync_now_inner(&app, &context).await {
                        warn!("tray AniList sync failed: {error}");
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    tray.set_visible(visible)?;
    Ok(())
}

#[cfg(desktop)]
fn show_tray_icon(settings: &Value) -> bool {
    settings
        .get("showTrayIcon")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

#[cfg(desktop)]
fn reconcile_autostart(app: &AppHandle, enabled: bool) -> anyhow::Result<()> {
    let autostart = app.autolaunch();
    if autostart.is_enabled()? == enabled {
        return Ok(());
    }
    if enabled {
        autostart.enable()?;
    } else {
        autostart.disable()?;
    }
    Ok(())
}

#[cfg(desktop)]
fn start_desktop_background(app: AppHandle, context: AppContext) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = sync_now_inner(&app, &context).await {
                warn!("background AniList sync failed: {error}");
            }
            loop {
                let minutes = {
                    let state = context.state.lock().ok();
                    state
                        .as_ref()
                        .map(|state| {
                            value_i64(state["settings"].get("pollIntervalMinutes")).clamp(1, 1440)
                        })
                        .unwrap_or(5)
                };
                if tokio::time::timeout(
                    std::time::Duration::from_secs((minutes * 60) as u64),
                    context.sync_wakeup.notified(),
                )
                .await
                .is_err()
                {
                    break;
                }
            }
        }
    });
}

#[cfg(desktop)]
fn claim_daily_task_reminder(
    state: &mut Value,
    today: &str,
    current_time: &str,
) -> Option<(usize, String)> {
    let reminder_time = value_string(state["settings"].get("dailyTaskReminderTime"));
    if !value_bool(state["settings"].get("dailyTaskReminderEnabled"))
        || value_string(state.get("lastTaskReminderDate")) == today
        || current_time < reminder_time.as_str()
    {
        return None;
    }
    let pending = state["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|task| value_string(task.get("status")) == "pending")
        .count();
    if pending == 0 {
        return None;
    }
    state["lastTaskReminderDate"] = json!(today);
    Some((pending, value_string(state["settings"].get("uiLanguage"))))
}

#[cfg(desktop)]
fn send_daily_task_reminder_if_due(app: &AppHandle, context: &AppContext) -> anyhow::Result<bool> {
    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let current_time = now.format("%H:%M").to_string();
    let Some((pending, language)) = ({
        let mut state = context.state.lock().map_err(|_| anyhow!("状态锁不可用"))?;
        claim_daily_task_reminder(&mut state, &today, &current_time)
    }) else {
        return Ok(false);
    };
    context.save_state()?;
    emit_state(app, context);
    let (title, body) = if language == "en-US" {
        (
            "Watch tasks reminder".to_string(),
            format!("You still have {pending} episode(s) to watch."),
        )
    } else {
        (
            "待看任务提醒".to_string(),
            format!("你还有 {pending} 个待看任务尚未完成。"),
        )
    };
    show_desktop_notification(app, title, body);
    Ok(true)
}

#[cfg(desktop)]
fn start_desktop_task_reminders(app: AppHandle, context: AppContext) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = send_daily_task_reminder_if_due(&app, &context) {
                warn!("daily task reminder failed: {error}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let original = cfg!(feature = "original");
    #[cfg(desktop)]
    let start_hidden = std::env::args().any(|argument| argument == "--hidden");
    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        PENDING_WINDOW_ACTIVATION.store(true, Ordering::Release);
        request_show_main_window(app);
    }));
    let builder = builder
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--hidden"]),
    ));
    #[cfg(target_os = "android")]
    let builder = builder.plugin(mobile::init());
    builder
        .setup(move |app| {
            let context = load_context(app.handle(), original)?;
            app.manage(context.clone());
            #[cfg(target_os = "android")]
            {
                mobile::import_legacy_state(app.handle(), &context)?;
                mobile::configure(app.handle(), &context)?;
                mobile::consume_events(app.handle(), &context)?;
            }
            #[cfg(desktop)]
            {
                tauri::window::WindowBuilder::new(app, "background")
                    .visible(false)
                    .skip_taskbar(true)
                    .build()?;
                setup_tray(app.handle(), &context)?;
                let launch_at_login = context
                    .state
                    .lock()
                    .ok()
                    .map(|state| value_bool(state["settings"].get("launchAtLogin")))
                    .unwrap_or(false);
                if let Err(error) = reconcile_autostart(app.handle(), launch_at_login) {
                    warn!("failed to reconcile autostart setting: {error}");
                }
                start_desktop_background(app.handle().clone(), context.clone());
                start_desktop_task_reminders(app.handle().clone(), context.clone());
                if !start_hidden {
                    show_main_window(app.handle())?;
                } else if let Some(window) = app.get_webview_window("main") {
                    window.destroy()?;
                }
                if PENDING_WINDOW_ACTIVATION.swap(false, Ordering::AcqRel) {
                    request_show_main_window(app.handle());
                }
            }
            start_webdav_background(app.handle().clone(), context.clone());
            info!(
                "AniLog Tauri started ({})",
                if original { "original" } else { "standard" }
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            fetch_season,
            toggle_follow,
            update_follow_title,
            resolve_bangumi_title,
            test_bangumi_connection,
            bangumi_auth_status,
            bangumi_save_token,
            bangumi_disconnect,
            bangumi_test_connection,
            bangumi_get_user_profile,
            bangumi_get_user_collections,
            bangumi_set_api_base_url,
            toggle_task,
            update_settings,
            sync_now,
            get_cache_info,
            clear_cache,
            get_webdav_config,
            save_webdav_config,
            test_webdav_connection,
            sync_webdav,
            request_exact_scheduling,
            open_external
        ])
        .on_window_event(|window, event| {
            #[cfg(not(desktop))]
            let _ = (&window, &event);
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let keep_in_tray = window
                    .app_handle()
                    .state::<AppContext>()
                    .state
                    .lock()
                    .ok()
                    .map(|state| value_bool(state["settings"].get("minimizeToTray")))
                    .unwrap_or(true);
                if keep_in_tray {
                    api.prevent_close();
                    let _ = window.destroy();
                } else {
                    api.prevent_close();
                    window.app_handle().exit(0);
                }
            }
            #[cfg(desktop)]
            if matches!(event, tauri::WindowEvent::Resized(_))
                && window.is_minimized().unwrap_or(false)
            {
                let keep_in_tray = window
                    .app_handle()
                    .state::<AppContext>()
                    .state
                    .lock()
                    .ok()
                    .map(|state| value_bool(state["settings"].get("minimizeToTray")))
                    .unwrap_or(true);
                if keep_in_tray {
                    let _ = window.destroy();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running AniLog Tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn followed(id: i64, updated_at: i64) -> Value {
        json!({
            "id": id,
            "title": {"romaji": format!("Anime {id}"), "english": null, "native": null},
            "displayTitle": format!("Anime {id}"),
            "followedAt": 1,
            "syncUpdatedAt": updated_at
        })
    }

    fn task(id: &str, anime_id: i64, status: &str, updated_at: i64) -> Value {
        json!({
            "id": id,
            "animeId": anime_id,
            "animeTitle": format!("Anime {anime_id}"),
            "episode": 1,
            "airingAt": 10,
            "status": status,
            "createdAt": 10,
            "completedAt": if status == "completed" { json!(20) } else { Value::Null },
            "syncUpdatedAt": updated_at
        })
    }

    #[test]
    fn newer_tombstone_removes_following_and_pending_tasks() {
        let mut state = default_state(false);
        state["following"] = json!([followed(1, 1_000)]);
        state["tasks"] = json!([task("1-1", 1, "pending", 1_000)]);
        let remote = json!({
            "version": SYNC_VERSION,
            "following": [],
            "tasks": [],
            "followingDeletedAt": {"1": 2_000}
        });

        let (changed, merged, _) = merge_document_into_state(&mut state, &remote).unwrap();

        assert!(changed);
        assert!(state["following"].as_array().unwrap().is_empty());
        assert!(state["tasks"].as_array().unwrap().is_empty());
        assert_eq!(merged["followingDeletedAt"]["1"], 2_000);
    }

    #[test]
    fn newest_task_record_wins_conflict() {
        let mut state = default_state(false);
        state["following"] = json!([followed(1, 3_000)]);
        state["tasks"] = json!([task("1-1", 1, "completed", 2_000)]);
        let remote = json!({
            "version": SYNC_VERSION,
            "following": [followed(1, 3_000)],
            "tasks": [task("1-1", 1, "pending", 1_000)],
            "followingDeletedAt": {}
        });

        merge_document_into_state(&mut state, &remote).unwrap();

        assert_eq!(state["tasks"][0]["status"], "completed");
        assert_eq!(state["tasks"][0]["syncUpdatedAt"], 2_000);
    }

    #[test]
    fn removing_following_cleans_only_its_pending_tasks() {
        let mut state = default_state(false);
        state["following"] = json!([followed(1, 1_000), followed(2, 1_000)]);
        state["tasks"] = json!([
            task("1-1", 1, "pending", 1_000),
            task("1-2", 1, "completed", 1_000),
            task("2-1", 2, "pending", 1_000)
        ]);

        assert!(remove_following(&mut state, 1));

        assert_eq!(state["following"].as_array().unwrap().len(), 1);
        assert_eq!(state["tasks"].as_array().unwrap().len(), 2);
        assert!(
            state["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["id"] == "1-2")
        );
        assert!(
            state["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["id"] == "2-1")
        );
        assert!(value_i64(state["syncMetadata"]["followingDeletedAt"].get("1")) > 0);
    }

    #[test]
    fn migration_repairs_shapes_and_adds_setting_defaults() {
        let loaded =
            json!({"version": 0, "following": "invalid", "settings": {"pollIntervalMinutes": 15}});

        let migrated = merge_defaults(loaded, false);

        assert_eq!(migrated["version"], STATE_VERSION);
        assert!(migrated["following"].is_array());
        assert!(migrated["tasks"].is_array());
        assert!(migrated["seenAiringEvents"].is_array());
        assert_eq!(migrated["settings"]["pollIntervalMinutes"], 15);
        assert_eq!(migrated["settings"]["createWatchTasks"], true);
        assert_eq!(migrated["settings"]["showTrayIcon"], true);
        assert!(migrated["syncMetadata"]["followingDeletedAt"].is_object());
    }

    #[test]
    fn reminder_time_validation_accepts_only_padded_twenty_four_hour_values() {
        assert!(is_valid_reminder_time("00:00"));
        assert!(is_valid_reminder_time("20:00"));
        assert!(is_valid_reminder_time("23:59"));
        assert!(!is_valid_reminder_time("8:05"));
        assert!(!is_valid_reminder_time("24:00"));
        assert!(!is_valid_reminder_time("20:60"));
        assert!(!is_valid_reminder_time(""));
    }

    #[test]
    fn url_normalization_accepts_only_plain_https_urls() {
        assert_eq!(
            normalize_url("https://dav.example.com/root", None).unwrap(),
            "https://dav.example.com/root/"
        );
        assert_eq!(
            normalize_url("https://proxy.example.com", Some("/v0")).unwrap(),
            "https://proxy.example.com/v0"
        );
        assert!(normalize_url("http://dav.example.com", None).is_err());
        assert!(normalize_url("https://user@dav.example.com", None).is_err());
        assert!(normalize_url("https://dav.example.com?a=1", None).is_err());
    }

    #[test]
    fn enabled_webdav_requires_complete_credentials() {
        assert!(validate_webdav_config(false, "", "", false).is_ok());
        assert!(validate_webdav_config(true, "https://dav.example.com/", "user", true).is_ok());
        assert!(validate_webdav_config(true, "", "user", true).is_err());
        assert!(validate_webdav_config(true, "https://dav.example.com/", " ", true).is_err());
        assert!(validate_webdav_config(true, "https://dav.example.com/", "user", false).is_err());
    }

    #[test]
    fn original_edition_cannot_enable_bangumi() {
        assert!(!can_use_bangumi(true, DEFAULT_BANGUMI_PROXY));
        assert!(can_use_bangumi(false, ""));
        assert!(can_use_bangumi(false, DEFAULT_BANGUMI_PROXY));
        assert_eq!(default_state(true)["settings"]["bangumiApiBaseUrl"], "");
    }

    // 回归锁定（schema §9）：Bangumi 设置块等 additive 字段绝不进坚果云文档，
    // document_from_state 输出恰好 {version, updatedAt, following, tasks,
    // followingDeletedAt} 五键。
    #[cfg(feature = "standard")]
    #[test]
    fn document_from_state_excludes_bangumi_block_and_device_fields() {
        let mut state = default_state(false);
        state["bangumi"] = json!({"syncEnabled": true, "apiBaseUrl": "https://proxy.example.com/v0"});
        state["bangumiTitles"]["1"] = json!({"status": "matched", "nameCn": "中文"});
        state["seenAiringEvents"] = json!(["1-1"]);
        state["lastSyncAt"] = json!(123);
        state["settings"]["pollIntervalMinutes"] = json!(15);

        let document = document_from_state(&mut state);

        let mut keys: Vec<&str> = document
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "following",
                "followingDeletedAt",
                "tasks",
                "updatedAt",
                "version"
            ]
        );
        assert_eq!(document["version"], SYNC_VERSION);
    }

    #[cfg(feature = "standard")]
    #[test]
    fn default_state_writes_bangumi_block_only_for_standard() {
        let standard = default_state(false);
        let keys: Vec<String> = standard["bangumi"]
            .as_object()
            .expect("standard default state must carry a bangumi block")
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys.len(), 8);
        assert_eq!(standard["bangumi"]["conflictPolicy"], "latest");

        let original = default_state(true);
        assert!(original.get("bangumi").is_none());
    }

    #[cfg(feature = "standard")]
    fn embedded_bangumi_map() -> Value {
        serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/bangumi-map.json")))
            .expect("parse embedded bangumi map")
    }

    #[cfg(feature = "standard")]
    #[test]
    fn embedded_bangumi_map_is_version_2() {
        let map = embedded_bangumi_map();
        assert_eq!(map["version"], 2);
        assert!(map["bySubject"].is_object());
        assert!(map["anilistIndex"].is_object());
        assert!(!map["bySubject"].as_object().unwrap().is_empty());
        assert!(!map["anilistIndex"].as_object().unwrap().is_empty());
    }

    #[cfg(feature = "standard")]
    #[test]
    fn embedded_bangumi_map_carries_schedule_metadata() {
        let map = embedded_bangumi_map();
        let by_subject = map["bySubject"].as_object().unwrap();
        let mut iso_parsed = 0;
        let mut recurrence = 0;
        for entry in by_subject.values() {
            // Item-level begin must be a parseable ISO8601 timestamp.
            if let Some(begin) = entry["begin"].as_str() {
                let normalized = begin.replace('Z', "+00:00");
                assert!(
                    chrono::DateTime::parse_from_rfc3339(&normalized).is_ok(),
                    "begin not ISO8601: {begin}"
                );
                iso_parsed += 1;
            }
            // A broadcast (item-level or any site) is a "R/..." recurrence.
            let site_bc = entry["sites"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|site| site["broadcast"].as_str());
            let has_recurrence = entry["broadcast"]
                .as_str()
                .into_iter()
                .chain(site_bc)
                .any(|value| value.starts_with("R/"));
            if has_recurrence {
                recurrence += 1;
            }
            // Every site begin/broadcast that is present is ISO8601 / "R/" form.
            if let Some(sites) = entry["sites"].as_array() {
                for site in sites {
                    if let Some(begin) = site["begin"].as_str() {
                        let normalized = begin.replace('Z', "+00:00");
                        assert!(
                            chrono::DateTime::parse_from_rfc3339(&normalized).is_ok(),
                            "site begin not ISO8601: {begin}"
                        );
                    }
                    if let Some(broadcast) = site["broadcast"].as_str() {
                        assert!(
                            broadcast.starts_with("R/"),
                            "site broadcast not a recurrence: {broadcast}"
                        );
                    }
                }
            }
        }
        assert!(
            iso_parsed > by_subject.len() / 2,
            "majority of entries should carry begin; got {iso_parsed} of {}",
            by_subject.len()
        );
        assert!(recurrence > 0, "expected some broadcast recurrences");
    }

    #[cfg(feature = "standard")]
    #[test]
    fn offline_bangumi_subject_resolves_by_subject_id() {
        let map = embedded_bangumi_map();
        // Re:Zero's Bangumi subject id is 140001; direct lookup must return the
        // entry and it must agree with the anilistIndex mapping.
        let subject_id = value_i64(map["anilistIndex"].get("21355"));
        assert!(subject_id > 0);
        let entry = offline_bangumi_subject(&map, subject_id).expect("subject entry");
        assert_eq!(value_i64(entry.get("b")), subject_id);
        assert_eq!(value_i64(entry.get("a")), 21355);
        assert_eq!(value_string(entry.get("c")), "Re：从零开始的异世界生活");
        assert!(offline_bangumi_subject(&map, -1).is_none());
    }

    #[cfg(feature = "standard")]
    #[test]
    fn embedded_bangumi_data_resolves_anilist_ids_without_network() {
        let map = embedded_bangumi_map();
        let anime = json!({
            "id": 21355,
            "title": {
                "native": "Re:ゼロから始める異世界生活",
                "romaji": "Re:Zero kara Hajimeru Isekai Seikatsu",
                "english": "Re:ZERO -Starting Life in Another World-"
            },
            "format": "TV",
            "startDate": {"year": 2016, "month": 4, "day": 4}
        });

        let matched = offline_bangumi_match(&map, &anime, 2_000_000_000).unwrap();

        assert_eq!(matched["status"], "matched");
        assert_eq!(matched["nameCn"], "Re：从零开始的异世界生活");
        assert_eq!(matched["source"], "bangumi-data-anilist-id");
    }

    #[cfg(feature = "original")]
    #[test]
    fn original_embedded_bangumi_map_is_empty_version_2() {
        let map: Value =
            serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/bangumi-map.json")))
                .expect("parse embedded bangumi map");
        assert_eq!(map["version"], 2);
        assert_eq!(map["bySubject"].as_object().map_or(0, |m| m.len()), 0);
        assert_eq!(map["anilistIndex"].as_object().map_or(0, |m| m.len()), 0);
        assert!(offline_bangumi_subject(&map, 1).is_none());
    }

    #[test]
    fn following_uses_an_existing_bangumi_title_match() {
        let mut state = default_state(false);
        state["bangumiTitles"]["42"] = json!({
            "animeId": 42,
            "status": "matched",
            "subjectId": 9001,
            "nameCn": "中文标题"
        });
        let anime = json!({
            "id": 42,
            "title": {"english": "English title", "romaji": "Romaji title", "native": "日本語"}
        });

        let (title, source, subject_id) = followed_title_fields(&state, &anime, false);

        assert_eq!(title, "中文标题");
        assert_eq!(source, "bangumi");
        assert_eq!(subject_id, 9001);
    }

    #[test]
    fn bangumi_cache_uses_status_and_premiere_aware_ttls() {
        let now = 2_000_000_000;
        let future = json!({
            "id": 42,
            "startDate": {"year": 2035, "month": 1, "day": 1}
        });
        let past = json!({
            "id": 42,
            "startDate": {"year": 2020, "month": 1, "day": 1}
        });
        let mut state = default_state(false);
        state["bangumiTitles"]["42"] = json!({
            "status": "unmatched",
            "checkedAt": now - 12 * 3_600,
            "resolverVersion": BANGUMI_RESOLVER_VERSION
        });
        assert!(cached_bangumi_title(&state, &future, now).is_some());

        state["bangumiTitles"]["42"]["checkedAt"] = json!(now - 2 * 86_400);
        assert!(cached_bangumi_title(&state, &future, now).is_none());
        assert!(cached_bangumi_title(&state, &past, now).is_some());

        state["bangumiTitles"]["42"]["checkedAt"] = json!(now - 8 * 86_400);
        assert!(cached_bangumi_title(&state, &past, now).is_none());
        state["bangumiTitles"]["42"] = json!({
            "status": "matched",
            "nameCn": "中文标题",
            "checkedAt": now - 30 * 86_400
        });
        assert!(cached_bangumi_title(&state, &past, now).is_some());
    }

    #[test]
    fn original_title_preference_updates_related_tasks_but_keeps_custom_titles() {
        let mut state = default_state(true);
        state["settings"]["titlePreference"] = json!("native");
        state["following"] = json!([
            {
                "id": 1,
                "title": {"english": "English 1", "romaji": "Romaji 1", "native": "日本語 1"},
                "displayTitle": "English 1",
                "titleSource": "anilist"
            },
            {
                "id": 2,
                "title": {"english": "English 2", "romaji": "Romaji 2", "native": "日本語 2"},
                "displayTitle": "My title",
                "titleSource": "custom"
            }
        ]);
        state["tasks"] = json!([
            task("1-1", 1, "pending", 1_000),
            task("2-1", 2, "pending", 1_000)
        ]);

        refresh_original_followed_titles(&mut state);

        assert_eq!(state["following"][0]["displayTitle"], "日本語 1");
        assert_eq!(state["tasks"][0]["animeTitle"], "日本語 1");
        assert_eq!(state["following"][1]["displayTitle"], "My title");
        assert_eq!(state["tasks"][1]["animeTitle"], "My title");
    }

    #[test]
    fn historical_seasons_have_longer_cache_ttl() {
        assert_eq!(
            season_cache_ttl_millis("WINTER", 2026, 2026, 7),
            30 * 86_400_000
        );
        assert_eq!(
            season_cache_ttl_millis("SUMMER", 2026, 2026, 7),
            6 * 3_600_000
        );
        assert_eq!(
            season_cache_ttl_millis("FALL", 2025, 2026, 1),
            30 * 86_400_000
        );
        assert_eq!(
            season_cache_ttl_millis("FALL", 2027, 2026, 7),
            6 * 3_600_000
        );
    }

    #[test]
    fn airing_sync_respects_watch_task_setting() {
        let schedule = json!({
            "mediaId": 1,
            "episode": 2,
            "airingAt": 20,
            "media": {
                "coverImage": {"medium": "https://example.com/cover.jpg"},
                "nextAiringEpisode": {"episode": 3, "airingAt": 30}
            }
        });
        let mut state = default_state(false);
        state["following"] = json!([followed(1, 1_000)]);
        state["settings"]["createWatchTasks"] = json!(false);

        assert_eq!(
            apply_airing_schedules(&mut state, &[schedule.clone()], 20),
            AiringOutcome {
                aired: 1,
                created: 0
            }
        );
        assert!(state["tasks"].as_array().unwrap().is_empty());
        assert_eq!(state["following"][0]["nextAiringEpisode"]["episode"], 3);

        state["settings"]["createWatchTasks"] = json!(true);
        assert_eq!(
            apply_airing_schedules(&mut state, &[schedule.clone()], 20),
            AiringOutcome {
                aired: 0,
                created: 1
            }
        );
        assert_eq!(
            apply_airing_schedules(&mut state, &[schedule], 20),
            AiringOutcome {
                aired: 0,
                created: 0
            }
        );
        assert_eq!(state["tasks"].as_array().unwrap().len(), 1);
    }

    #[cfg(desktop)]
    #[test]
    fn tray_labels_follow_edition_and_interface_language() {
        assert_eq!(
            tray_labels(false, "zh-CN"),
            TrayLabels {
                open: "打开 AniLog".into(),
                sync: "立即同步".into(),
                quit: "退出".into(),
                tooltip: "AniLog - 追番任务".into(),
            }
        );
        assert_eq!(
            tray_labels(true, "en-US"),
            TrayLabels {
                open: "Open AniLog Original".into(),
                sync: "Sync now".into(),
                quit: "Quit".into(),
                tooltip: "AniLog Original - Anime tracker".into(),
            }
        );
    }

    #[cfg(desktop)]
    #[test]
    fn tray_visibility_defaults_visible_and_preserves_explicit_false() {
        assert!(show_tray_icon(&json!({})));
        assert!(show_tray_icon(&json!({"showTrayIcon": true})));
        assert!(!show_tray_icon(&json!({"showTrayIcon": false})));
        assert!(show_tray_icon(&json!({"showTrayIcon": "false"})));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_notifications_use_registered_id_only_for_installed_app() {
        let identifier = "io.anilog.app";
        assert_eq!(
            windows_notification_app_id(identifier, Path::new(r"D:\AniList\target\debug")),
            tauri_winrt_notification::Toast::POWERSHELL_APP_ID
        );
        assert_eq!(
            windows_notification_app_id(identifier, Path::new(r"D:\AniList\target\release")),
            tauri_winrt_notification::Toast::POWERSHELL_APP_ID
        );
        assert_eq!(
            windows_notification_app_id(identifier, Path::new(r"D:\Apps\AniLog")),
            identifier
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn decrypts_legacy_electron_safe_storage_password() {
        use windows::Win32::Foundation::{HLOCAL, LocalFree};
        use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptProtectData};

        let directory = std::env::temp_dir().join(format!(
            "anilog-electron-credential-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();

        let key = [0x2a_u8; 32];
        let mut key_input = key.to_vec();
        let input = CRYPT_INTEGER_BLOB {
            cbData: key_input.len() as u32,
            pbData: key_input.as_mut_ptr(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(&input, None, None, None, None, 0, &mut output).unwrap();
        }
        let protected =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        }
        let mut encoded_key = b"DPAPI".to_vec();
        encoded_key.extend(protected);
        fs::write(
            directory.join("Local State"),
            serde_json::to_vec(&json!({
                "os_crypt": {"encrypted_key": BASE64_STANDARD.encode(encoded_key)}
            }))
            .unwrap(),
        )
        .unwrap();

        let nonce = [0x19_u8; 12];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let mut encrypted = b"v10".to_vec();
        encrypted.extend(nonce);
        encrypted.extend(
            cipher
                .encrypt(
                    aes_gcm::Nonce::from_slice(&nonce),
                    b"AniLog migration password".as_slice(),
                )
                .unwrap(),
        );
        assert_eq!(
            decrypt_legacy_webdav_password(&directory, &BASE64_STANDARD.encode(encrypted)).unwrap(),
            "AniLog migration password"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(desktop)]
    #[test]
    fn daily_reminder_is_claimed_once_when_due() {
        let mut state = default_state(false);
        state["settings"]["dailyTaskReminderEnabled"] = json!(true);
        state["settings"]["dailyTaskReminderTime"] = json!("20:00");
        state["tasks"] = json!([task("1-1", 1, "pending", 1_000)]);

        assert_eq!(
            claim_daily_task_reminder(&mut state, "2026-07-29", "19:59"),
            None
        );
        assert_eq!(
            claim_daily_task_reminder(&mut state, "2026-07-29", "20:00"),
            Some((1, "zh-CN".into()))
        );
        assert_eq!(
            claim_daily_task_reminder(&mut state, "2026-07-29", "21:00"),
            None
        );
    }

    // -- Phase 1 Bangumi 命令 ---------------------------------------------------

    #[cfg(feature = "standard")]
    fn bangumi_test_base(url: &str) -> bangumi::BangumiBaseUrls {
        bangumi::BangumiBaseUrls {
            root: url.to_string(),
            v0: format!("{url}/v0"),
        }
    }

    #[cfg(feature = "standard")]
    #[test]
    fn bangumi_base_urls_prefers_block_then_settings_then_official() {
        // 决策 11：顶层 bangumi.apiBaseUrl 优先。
        assert_eq!(
            bangumi_base_urls(&json!({
                "bangumi": {"apiBaseUrl": "https://a.example.com/v0"},
                "settings": {"bangumiApiBaseUrl": "https://b.example.com/v0"}
            }))
            .v0,
            "https://a.example.com/v0"
        );
        // 顶层为空回落 settings.bangumiApiBaseUrl。
        assert_eq!(
            bangumi_base_urls(&json!({
                "bangumi": {"apiBaseUrl": ""},
                "settings": {"bangumiApiBaseUrl": "https://b.example.com/v0"}
            }))
            .v0,
            "https://b.example.com/v0"
        );
        // 再为空用官方。
        assert_eq!(
            bangumi_base_urls(&json!({"bangumi": {}, "settings": {}})).root,
            "https://api.bgm.tv"
        );
    }

    #[cfg(feature = "standard")]
    #[test]
    fn bangumi_api_base_url_mirror_writes_block_from_settings() {
        let mut state = default_state(false);
        state["settings"]["bangumiApiBaseUrl"] = json!("https://proxy.example.com/v0");
        state["bangumi"]["apiBaseUrl"] = json!("");

        sync_bangumi_api_base_url_into_block(&mut state);

        assert_eq!(state["bangumi"]["apiBaseUrl"], "https://proxy.example.com/v0");
        assert_eq!(
            state["settings"]["bangumiApiBaseUrl"],
            "https://proxy.example.com/v0"
        );
    }

    #[cfg(feature = "standard")]
    #[test]
    fn bangumi_commands_round_trip_with_memory_store() {
        use crate::bangumi::test_support::MockBangumiServer;
        use std::sync::Arc;

        let profile = include_str!("../fixtures/bangumi/user-profile.json").to_string();
        let collections = include_str!("../fixtures/bangumi/user-collections-page.json").to_string();
        let server = MockBangumiServer::spawn(Arc::new(
            move |_method, target, headers, _request_body| {
                if target == "/v0/me" {
                    assert!(
                        headers
                            .get("authorization")
                            .map(String::as_str)
                            .unwrap_or_default()
                            .starts_with("Bearer ")
                    );
                    (200, vec![], profile.clone())
                } else if target.starts_with("/v0/users/anilog_dev/collections?") {
                    assert!(target.contains("subject_type=2"));
                    (200, vec![], collections.clone())
                } else {
                    (404, vec![], "{}".into())
                }
            },
        ));
        let client =
            bangumi::HttpBangumiClient::with_base(bangumi_test_base(&server.url())).unwrap();
        let tokens = bangumi::MemoryTokenStore::new();
        let username_cache = std::sync::Mutex::new(None);
        let supported = bangumi_commands::token_store_supported();
        let empty_state = json!({"bangumi": {}, "settings": {}});

        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio test runtime")
            .block_on(async {
                // 初始 status：无 Token，apiBaseUrl 展示值回落 settings。
                let status = bangumi_commands::auth_status(
                    &json!({
                        "bangumi": {"apiBaseUrl": ""},
                        "settings": {"bangumiApiBaseUrl": "https://proxy.example.com/v0"}
                    }),
                    &tokens,
                );
                assert_eq!(status["supported"], supported);
                assert_eq!(status["hasToken"], false);
                assert_eq!(status["apiBaseUrl"], "https://proxy.example.com/v0");

                // 空 Token 拒绝（固定文案）。
                let empty = bangumi_commands::save_token(&tokens, "   ");
                assert_eq!(empty["ok"], false);
                assert_eq!(empty["message"], "Token 不能为空");

                // 保存（trim）→ hasToken=true；成功响应不回显 Token。
                let saved = bangumi_commands::save_token(&tokens, "  roundtrip-token  ");
                assert_eq!(saved["ok"], true);
                assert!(!saved.to_string().contains("roundtrip-token"));
                let status = bangumi_commands::auth_status(&empty_state, &tokens);
                assert_eq!(status["hasToken"], supported);

                // profile 走 /v0/me fixture，camelCase 投影。
                let profile = bangumi_commands::user_profile(&tokens, &client).await;
                assert_eq!(profile["username"], "anilog_dev");
                assert_eq!(profile["nickname"], "阿罗");
                assert_eq!(profile["userGroup"], 10);

                // collections 分页信封 + camelCase 投影（username 缓存自 /v0/me）。
                let collections = bangumi_commands::user_collections(
                    &tokens,
                    &client,
                    &username_cache,
                    Some(0),
                    Some(30),
                )
                .await;
                assert_eq!(collections["total"], 2);
                assert_eq!(collections["items"][0]["subjectId"], 45678);
                assert_eq!(collections["items"][0]["type"], 3);
                assert_eq!(collections["items"][0]["epStatus"], 3);
                assert_eq!(collections["items"][1]["subjectId"], 99999);

                // test_connection 成功回 username/nickname。
                let connection =
                    bangumi_commands::test_connection(&tokens, &client, &username_cache).await;
                assert_eq!(connection["ok"], true);
                assert_eq!(connection["username"], "anilog_dev");
                assert_eq!(connection["nickname"], "阿罗");

                // disconnect → hasToken=false，username 缓存清空。
                let disconnected = bangumi_commands::disconnect(&tokens, &username_cache);
                assert_eq!(disconnected["ok"], true);
                let status = bangumi_commands::auth_status(&empty_state, &tokens);
                assert_eq!(status["hasToken"], false);
                assert!(username_cache.lock().unwrap().is_none());
            });
        // Authorization 头始终形如 "Bearer <token>"（形制回归，不落盘不回显）。
        for request in server.requests() {
            let authorization = request
                .headers
                .get("authorization")
                .map(String::as_str)
                .unwrap_or_default();
            assert!(authorization.starts_with("Bearer "), "bad auth header: {authorization:?}");
        }
    }

    #[cfg(all(feature = "standard", target_os = "windows"))]
    #[test]
    fn bangumi_original_rejection_messages_are_stable() {
        // original edition 的拒绝语义由固定文案函数承载（original 下单独测试，
        // 这里锁定 standard 构建中的同一实现）。
        assert_eq!(
            bangumi_command_rejected(),
            json!({"ok": false, "message": "Original 版不支持 Bangumi"})
        );
        assert_eq!(
            bangumi_auth_status_rejected(),
            json!({"supported": false, "hasToken": false, "apiBaseUrl": ""})
        );
    }

    #[cfg(feature = "original")]
    #[test]
    fn original_bangumi_commands_reject_with_fixed_messages() {
        // status 命令的 supported=false 语义核心函数。
        assert_eq!(
            bangumi_auth_status_rejected(),
            json!({"supported": false, "hasToken": false, "apiBaseUrl": ""})
        );
        // 其余命令统一 ok=false + 固定文案。
        assert_eq!(
            bangumi_command_rejected(),
            json!({"ok": false, "message": "Original 版不支持 Bangumi"})
        );
        // original 仍拒绝 bangumiApiBaseUrl 写入（默认状态强制为空、无 bangumi 块）。
        assert_eq!(default_state(true)["settings"]["bangumiApiBaseUrl"], "");
        assert!(default_state(true).get("bangumi").is_none());
    }
}
