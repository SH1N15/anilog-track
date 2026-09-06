use anyhow::{Context, anyhow};
use serde_json::{Value, json};
use std::collections::HashSet;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Wry};

use super::{
    AppContext, comparable_document, document_from_state, emit_state, merge_document_into_state,
    normalize_document, now_millis, now_seconds, value_bool, value_i64, value_string,
};

const PLUGIN_IDENTIFIER: &str = "io.anilog.android";

#[derive(Clone)]
pub struct MobileBridge(PluginHandle<Wry>);

impl MobileBridge {
    fn run(&self, command: &str, payload: Value) -> anyhow::Result<Value> {
        self.0
            .run_mobile_plugin(command, payload)
            .map_err(|error| anyhow!(error.to_string()))
    }
}

pub fn init() -> TauriPlugin<Wry, ()> {
    Builder::<Wry, ()>::new("anilog-mobile")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "AniLogPlugin")?;
            app.manage(MobileBridge(handle));
            Ok(())
        })
        .build()
}

fn configuration_payload(context: &AppContext) -> anyhow::Result<Value> {
    let state = context.state.lock().map_err(|_| anyhow!("状态锁不可用"))?;
    let following = state["following"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            // Phase 2 主键迁移 additive 字段（source/subjectId/anilistId）：
            // MobileStore.java 按需 opt* 取键，未知键无害（schema §10）。
            // 缺省 source 视为 anilist；bangumi 条目 id 即 subjectId，
            // anilistId 为 AniList 关联；anilist 条目反之。
            let source = {
                let value = value_string(item.get("source"));
                if value.is_empty() { "anilist".to_string() } else { value }
            };
            let id = value_i64(item.get("id"));
            let bangumi = source == "bangumi";
            let subject_id = if bangumi { id } else { value_i64(item.get("subjectId")) };
            let anilist_id = if bangumi {
                value_i64(item.get("anilistId"))
            } else {
                id
            };
            json!({
                "id": id,
                "displayTitle": value_string(item.get("displayTitle")),
                "coverImage": value_string(item.get("coverImage")),
                "nextEpisode": value_i64(item["nextAiringEpisode"].get("episode")),
                "nextAiringAt": value_i64(item["nextAiringEpisode"].get("airingAt")),
                "source": source,
                "subjectId": if subject_id > 0 { json!(subject_id) } else { Value::Null },
                "anilistId": if anilist_id > 0 { json!(anilist_id) } else { Value::Null }
            })
        })
        .collect::<Vec<_>>();
    let pending_tasks = state["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|task| value_string(task.get("status")) == "pending")
        .map(|task| {
            json!({
                "id": value_string(task.get("id")),
                "animeTitle": value_string(task.get("animeTitle")),
                "episode": value_i64(task.get("episode")),
                "airingAt": value_i64(task.get("airingAt"))
            })
        })
        .collect::<Vec<_>>();
    let settings = &state["settings"];
    Ok(json!({
        "following": following,
        "pendingTasks": pending_tasks,
        "notificationsEnabled": value_bool(settings.get("notifyWhenAired")),
        "createTasksEnabled": value_bool(settings.get("createWatchTasks")),
        "dailyTaskReminderEnabled": value_bool(settings.get("dailyTaskReminderEnabled")),
        "dailyTaskReminderTime": value_string(settings.get("dailyTaskReminderTime")),
        "uiLanguage": value_string(settings.get("uiLanguage"))
    }))
}

pub fn configure(app: &AppHandle, context: &AppContext) -> anyhow::Result<Value> {
    let bridge = app.state::<MobileBridge>();
    bridge.run("configure", configuration_payload(context)?)
}

fn merge_status(app: &AppHandle, context: &AppContext, status: &Value) -> anyhow::Result<usize> {
    {
        let mut runtime = context
            .runtime
            .lock()
            .map_err(|_| anyhow!("运行状态锁不可用"))?;
        runtime["notificationPermissionGranted"] = json!(value_bool(status.get("granted")));
        runtime["exactSchedulingGranted"] = json!(value_bool(status.get("exactSchedulingGranted")));
    }
    let mut state = context.state.lock().map_err(|_| anyhow!("状态锁不可用"))?;
    let before = serde_json::to_string(&*state)?;

    if let Some(schedules) = status.get("following").and_then(Value::as_array) {
        for schedule in schedules {
            let anime_id = value_i64(schedule.get("id"));
            if let Some(followed) = state["following"].as_array_mut().and_then(|items| {
                items
                    .iter_mut()
                    .find(|item| value_i64(item.get("id")) == anime_id)
            }) {
                let episode = value_i64(schedule.get("nextEpisode"));
                let airing_at = value_i64(schedule.get("nextAiringAt"));
                followed["nextAiringEpisode"] = if episode > 0 && airing_at > 0 {
                    json!({"episode": episode, "airingAt": airing_at})
                } else {
                    Value::Null
                };
                let cover = value_string(schedule.get("coverImage"));
                if !cover.is_empty() {
                    followed["coverImage"] = json!(cover);
                }
            }
        }
    }

    let create_tasks = value_bool(state["settings"].get("createWatchTasks"));
    let mut created = 0;
    if create_tasks {
        let mut known: HashSet<String> = state["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|task| value_string(task.get("id")))
            .collect();
        let followed_ids: HashSet<i64> = state["following"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|item| value_i64(item.get("id")))
            .collect();
        for event in status
            .get("events")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = value_string(event.get("id"));
            let anime_id = value_i64(event.get("animeId"));
            let episode = value_i64(event.get("episode"));
            if id.is_empty()
                || anime_id <= 0
                || episode <= 0
                || known.contains(&id)
                || !followed_ids.contains(&anime_id)
            {
                continue;
            }
            let title = state["following"]
                .as_array()
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| value_i64(item.get("id")) == anime_id)
                })
                .map(|item| value_string(item.get("displayTitle")))
                .unwrap_or_else(|| value_string(event.get("animeTitle")));
            let event_created_at = value_i64(event.get("createdAt"));
            let created_at = if event_created_at > 0 {
                event_created_at
            } else {
                now_seconds()
            };
            #[cfg_attr(not(feature = "standard"), expect(unused_mut))]
            let mut new_task = json!({
                "id": id,
                "animeId": anime_id,
                "animeTitle": title,
                "coverImage": value_string(event.get("coverImage")),
                "episode": episode,
                "airingAt": value_i64(event.get("airingAt")),
                "status": "pending",
                "createdAt": created_at,
                "completedAt": null,
                "syncUpdatedAt": now_millis()
            });
            // Phase 2 additive 任务字段（standard 写入，original 行为不变）；
            // animeId 已与 following 载荷 id 一致（bangumi 条目即 subjectId）。
            #[cfg(feature = "standard")]
            {
                let subject_sourced = state["following"].as_array().is_some_and(|items| {
                    items.iter().any(|item| {
                        value_i64(item.get("id")) == anime_id
                            && value_string(item.get("source")) == "bangumi"
                    })
                });
                new_task["subjectId"] = if subject_sourced { json!(anime_id) } else { Value::Null };
                new_task["episodeId"] = Value::Null;
                new_task["episodeSortKey"] = json!(episode.to_string());
                new_task["episodeType"] = json!("regular");
            }
            state["tasks"].as_array_mut().unwrap().push(new_task);
            known.insert(id);
            created += 1;
        }
    }

    let synced_at = value_i64(status.get("syncedAt"));
    if synced_at > value_i64(state.get("lastSyncAt")) {
        state["lastSyncAt"] = json!(synced_at);
    }
    state["tasks"]
        .as_array_mut()
        .unwrap()
        .sort_by(|left, right| {
            value_i64(right.get("airingAt")).cmp(&value_i64(left.get("airingAt")))
        });
    let changed = before != serde_json::to_string(&*state)?;
    drop(state);

    if changed {
        context.save_state()?;
        emit_state(app, context);
        context.webdav_wakeup.notify_one();
    }
    if value_bool(status.get("openTasks")) {
        let _ = app.emit("open-tasks", ());
    }
    Ok(created)
}

pub fn consume_events(app: &AppHandle, context: &AppContext) -> anyhow::Result<Value> {
    let status = app
        .state::<MobileBridge>()
        .run("consumeEvents", json!({}))?;
    merge_status(app, context, &status)?;
    Ok(status)
}

pub fn import_legacy_state(app: &AppHandle, context: &AppContext) -> anyhow::Result<bool> {
    let should_import = {
        let state = context.state.lock().map_err(|_| anyhow!("状态锁不可用"))?;
        state["following"].as_array().is_none_or(Vec::is_empty)
            && state["tasks"].as_array().is_none_or(Vec::is_empty)
    };
    if !should_import {
        return Ok(false);
    }
    let legacy = app
        .state::<MobileBridge>()
        .run("getLegacyState", json!({}))?;
    let legacy_following = legacy["following"].as_array().cloned().unwrap_or_default();
    let legacy_tasks = legacy["pendingTasks"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if legacy_following.is_empty() && legacy_tasks.is_empty() {
        return Ok(false);
    }

    let timestamp = now_millis();
    let mut state = context.state.lock().map_err(|_| anyhow!("状态锁不可用"))?;
    state["following"] = Value::Array(
        legacy_following
            .into_iter()
            .filter_map(|item| {
                let id = value_i64(item.get("id"));
                let display_title = value_string(item.get("displayTitle"));
                if id <= 0 || display_title.is_empty() {
                    return None;
                }
                let episode = value_i64(item.get("nextEpisode"));
                let airing_at = value_i64(item.get("nextAiringAt"));
                Some(json!({
                    "id": id,
                    "title": { "english": display_title, "romaji": display_title, "native": null },
                    "displayTitle": display_title,
                    "titleSource": "custom",
                    "bangumiId": null,
                    "coverImage": value_string(item.get("coverImage")),
                    "nextAiringEpisode": if episode > 0 && airing_at > 0 { json!({"episode": episode, "airingAt": airing_at}) } else { Value::Null },
                    "followedAt": now_seconds(),
                    "syncUpdatedAt": timestamp
                }))
            })
            .collect(),
    );
    let followed_ids: HashSet<i64> = state["following"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| value_i64(item.get("id")))
        .collect();
    state["tasks"] = Value::Array(
        legacy_tasks
            .into_iter()
            .filter_map(|task| {
                let id = value_string(task.get("id"));
                let anime_id = value_i64(task.get("animeId"));
                let episode = value_i64(task.get("episode"));
                if id.is_empty() || episode <= 0 || !followed_ids.contains(&anime_id) {
                    return None;
                }
                Some(json!({
                    "id": id,
                    "animeId": anime_id,
                    "animeTitle": value_string(task.get("animeTitle")),
                    "coverImage": value_string(task.get("coverImage")),
                    "episode": episode,
                    "airingAt": value_i64(task.get("airingAt")),
                    "status": "pending",
                    "createdAt": value_i64(task.get("createdAt")).max(1),
                    "completedAt": null,
                    "syncUpdatedAt": timestamp
                }))
            })
            .collect(),
    );
    if let Some(settings) = legacy.get("settings").and_then(Value::as_object) {
        for key in [
            "notifyWhenAired",
            "createWatchTasks",
            "dailyTaskReminderEnabled",
            "dailyTaskReminderTime",
            "uiLanguage",
        ] {
            if let Some(value) = settings.get(key) {
                state["settings"][key] = value.clone();
            }
        }
    }
    drop(state);
    context.save_state()?;
    Ok(true)
}

pub fn sync_native(app: &AppHandle, context: &AppContext) -> anyhow::Result<Value> {
    let mut status = app.state::<MobileBridge>().run("syncNow", json!({}))?;
    let created = merge_status(app, context, &status)?;
    status["created"] = json!(created);
    configure(app, context)?;
    Ok(status)
}

pub fn request_exact_scheduling(app: &AppHandle) -> anyhow::Result<()> {
    app.state::<MobileBridge>()
        .run("requestExactScheduling", json!({}))?;
    Ok(())
}

pub fn get_webdav_config(app: &AppHandle) -> anyhow::Result<Value> {
    app.state::<MobileBridge>()
        .run("getWebDavConfig", json!({}))
}

pub fn save_webdav_config(app: &AppHandle, config: &Value) -> anyhow::Result<Value> {
    app.state::<MobileBridge>()
        .run("saveWebDavConfig", config.clone())
}

pub fn test_webdav_connection(app: &AppHandle) -> anyhow::Result<Value> {
    app.state::<MobileBridge>()
        .run("testWebDavConnection", json!({}))
}

// ---------------------------------------------------------------------------
// Bangumi Token 桥（Phase 1，仅 standard edition）。
//
// Kotlin 侧方法名固定：bangumiGetToken / bangumiSaveToken / bangumiClearToken，
// 返回 JSON 约定：getToken → {token: string|null}；save → {ok: bool}；clear → {ok: bool}。
// 决策 12：Java 层 BangumiTokenStore 只做 Keystore 凭据存取，绝不发起任何
// Bangumi 网络请求；HTTP 全部由 Rust 层发起且 original 的 Rust 永不调用。
//
// Rust 侧唯一桥接入口是下方 MobileBangumiTokenStore（实现 BangumiTokenStore
// trait，经 AppContext.bangumi_tokens 被 bangumi_commands 各命令使用）。
// Phase 1 曾另留 bangumi_get/save/clear_token 三个独立桥封装函数，与本结构
// 完全重复且无调用方（dead_code），Phase 2 任务 4 已删除；若未来需要非 trait
// 的直连封装，从这里恢复（方法名/返回 JSON 约定不变）。
// ---------------------------------------------------------------------------

/// 桥实现 [`BangumiTokenStore`]：Rust 命令层经此在 Android Keystore 中读写
/// Bangumi Token（仿 WebDAV 桥的现有写法）。桥失败统一映射为固定文案
/// “Bangumi 安全存储不可用”，不透传底层细节。
#[cfg(feature = "standard")]
pub struct MobileBangumiTokenStore {
    bridge: MobileBridge,
}

#[cfg(feature = "standard")]
impl MobileBangumiTokenStore {
    pub fn new(bridge: MobileBridge) -> Self {
        Self { bridge }
    }

    fn bridge_error() -> crate::bangumi::TokenStoreError {
        crate::bangumi::TokenStoreError::Platform("Bangumi 安全存储不可用".into())
    }
}

#[cfg(feature = "standard")]
impl crate::bangumi::BangumiTokenStore for MobileBangumiTokenStore {
    fn load(&self) -> Result<Option<String>, crate::bangumi::TokenStoreError> {
        let value = self
            .bridge
            .run("bangumiGetToken", json!({}))
            .map_err(|_| Self::bridge_error())?;
        Ok(value
            .get("token")
            .and_then(Value::as_str)
            .map(str::to_string))
    }

    fn store(&self, token: &str) -> Result<(), crate::bangumi::TokenStoreError> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return Err(crate::bangumi::TokenStoreError::Other(
                "Bangumi Token 不能为空".into(),
            ));
        }
        let value = self
            .bridge
            .run("bangumiSaveToken", json!({ "token": trimmed }))
            .map_err(|_| Self::bridge_error())?;
        if value_bool(value.get("ok")) {
            Ok(())
        } else {
            Err(Self::bridge_error())
        }
    }

    fn clear(&self) -> Result<(), crate::bangumi::TokenStoreError> {
        let value = self
            .bridge
            .run("bangumiClearToken", json!({}))
            .map_err(|_| Self::bridge_error())?;
        if value_bool(value.get("ok")) {
            Ok(())
        } else {
            Err(Self::bridge_error())
        }
    }
}


fn finish_webdav_sync(app: &AppHandle, error: Option<&str>) {
    let payload = error.map_or_else(|| json!({}), |message| json!({"error": message}));
    let _ = app.state::<MobileBridge>().run("finishWebDavSync", payload);
}

pub fn sync_webdav(app: &AppHandle, context: &AppContext) -> anyhow::Result<Value> {
    let result = (|| {
        let config = get_webdav_config(app)?;
        if !value_bool(config.get("enabled")) {
            return Err(anyhow!("请先启用 WebDAV 同步"));
        }
        let mut local_changed = false;
        for attempt in 0..3 {
            let download = app
                .state::<MobileBridge>()
                .run("webDavDownload", json!({}))?;
            let found = value_bool(download.get("found"));
            let remote = if found {
                let body = value_string(download.get("body"));
                Some(normalize_document(
                    &serde_json::from_str::<Value>(&body)
                        .context("WebDAV 同步文件不是有效的 JSON")?,
                )?)
            } else {
                None
            };
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
                configure(app, context)?;
            }
            if !remote_changed
                || remote.as_ref().is_some_and(|document| {
                    comparable_document(document).ok() == comparable_document(&merged).ok()
                })
            {
                break;
            }
            let uploaded = app.state::<MobileBridge>().run(
                "webDavUpload",
                json!({
                    "body": serde_json::to_string_pretty(&merged)?,
                    "remoteFound": found,
                    "etag": value_string(download.get("etag"))
                }),
            )?;
            if value_bool(uploaded.get("ok")) {
                break;
            }
            if !value_bool(uploaded.get("conflict")) || attempt == 2 {
                return Err(anyhow!("WebDAV 文件在同步期间反复变化，请稍后重试"));
            }
        }
        let synced_at = now_seconds();
        Ok(json!({
            "ok": true,
            "changed": local_changed,
            "syncedAt": synced_at,
            "message": if local_changed { "已合并另一台设备的更新" } else { "两端数据已同步" }
        }))
    })();

    match result {
        Ok(value) => {
            finish_webdav_sync(app, None);
            Ok(value)
        }
        Err(error) => {
            finish_webdav_sync(app, Some(&error.to_string()));
            Err(error)
        }
    }
}
