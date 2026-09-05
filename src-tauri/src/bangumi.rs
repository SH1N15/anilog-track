//! AniLog 标准版（Cargo feature `standard`）Bangumi 核心模块 — Phase 0。
//!
//! 本模块是 `docs/BANGUMI_STANDARD_MIGRATION_SCHEMA.md`（Phase 0 冻结契约）的 Rust 侧
//! 单一来源：serde 数据模型、Bangumi v0 API 响应类型、端点/枚举常量、Token 存储契约、
//! 双基址解析、API 错误模型、broadcast（RFC5545 `R/<start>/P<nD|nW>`）解析与选站纯函数、
//! 以及 `BangumiClient` trait 与 fixture 实现。
//!
//! 边界约束（见 `AGENTS.md` / schema 冻结文档）：
//! - 本模块只在 `standard` feature 下编译；Original 产物中不得出现任何 Bangumi 代码。
//! - 业务时间戳单位冻结为**秒**，`syncUpdatedAt` 一律为**毫秒**（与旧状态字段一致）。
//! - Token 只进系统凭据存储，绝不进入状态 JSON、日志、WebDAV 文档或错误信息。

use chrono::{DateTime, Duration, TimeZone, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::future::Future;
use std::time::Duration as StdDuration;

// ---------------------------------------------------------------------------
// A. serde 数据模型（camelCase 对齐前端 src/types.ts，Phase 0 冻结）
// ---------------------------------------------------------------------------

/// 冲突解决策略（`bangumi.conflictPolicy`）。
///
/// 注意 Bangumi 官方注明收藏 `updated_at` 在评分/评价/章节观看状态修改时可能不更新，
/// 因此冲突解决禁用 `updated_at` LWW，仅参考 `payload hash` 与 `lastChangedBy`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictPolicy {
    /// 以时间戳较新者为准（默认）。
    #[default]
    Latest,
    /// 本地记录优先。
    LocalFirst,
    /// Bangumi 远端记录优先。
    BangumiFirst,
}

/// 主键映射方式（`BangumiSubjectRecord.mapping.method`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MappingMethod {
    /// 离线映射表（build.rs 内置 bangumi-map.json）。
    #[default]
    Local,
    /// Bangumi API 外部关联 ID（含 AniList id）。
    External,
    /// 标题 + 年份 + 季节 + 集数综合匹配。
    TitleYear,
    /// 用户手动确认/指定。
    Manual,
}

/// 映射置信度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MappingConfidence {
    #[default]
    High,
    Medium,
    Low,
}

/// 集数类型（Bangumi `type` 0-6 归一化后的五值枚举）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EpisodeType {
    #[default]
    Regular,
    Special,
    Movie,
    Ova,
    Unknown,
}

/// 记录最后被哪一方修改（防循环写回：hash 相同则跳过推送）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LastChangedBy {
    #[default]
    Local,
    Bangumi,
    WebDav,
}

/// 播出选站默认优先级（`preferredBroadcastSites` 默认值，schema §6）。
pub fn default_preferred_broadcast_sites() -> Vec<String> {
    vec![
        "bangumi".into(),
        "ani_one".into(),
        "ani_one_asia".into(),
        "gamer".into(),
        "unext".into(),
    ]
}

/// `bangumi` 设置块（挂在状态顶层，与 `settings` 并列；只进本地状态，
/// 绝不进坚果云文档）。Original 版不写该块。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BangumiSyncSettings {
    /// 反代/自定义 API 基址；空 = 官方 `https://api.bgm.tv`。非敏感，可进普通设置。
    pub api_base_url: String,
    /// Bangumi 同步总开关。
    pub sync_enabled: bool,
    /// 从 Bangumi 读取收藏。
    pub pull_collections: bool,
    /// 本地追番变化写回 Bangumi（默认关闭）。
    pub push_local_changes: bool,
    /// 完成任务自动上传单集进度（默认关闭）。
    pub push_completed_episodes: bool,
    /// Bangumi 外部状态拉取。
    pub pull_external_status: bool,
    /// 三方冲突策略。
    pub conflict_policy: ConflictPolicy,
    /// 播出选站优先级（schema §6）。
    pub preferred_broadcast_sites: Vec<String>,
}

impl Default for BangumiSyncSettings {
    fn default() -> Self {
        Self {
            api_base_url: String::new(),
            sync_enabled: false,
            pull_collections: true,
            push_local_changes: false,
            push_completed_episodes: false,
            pull_external_status: true,
            conflict_policy: ConflictPolicy::Latest,
            preferred_broadcast_sites: default_preferred_broadcast_sites(),
        }
    }
}

/// 播出信息（`BangumiSubjectRecord.airing`）；`nextAiringAt` 单位为**秒**。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BangumiAiring {
    pub next_episode: Option<i64>,
    pub next_airing_at: Option<i64>,
}

/// 主键映射元数据；`updatedAt` 为**秒**级时间戳（0 表示未知）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BangumiMapping {
    pub method: MappingMethod,
    pub confidence: MappingConfidence,
    pub updated_at: i64,
}

impl Default for BangumiMapping {
    fn default() -> Self {
        Self {
            method: MappingMethod::Local,
            confidence: MappingConfidence::High,
            updated_at: 0,
        }
    }
}

/// subject 记录（Phase 2 起 `subjectId` 成为标准版主键；Phase 0 只冻结结构）。
///
/// 时间单位：`lastPulledFromBangumiAt` / `lastPushedToBangumiAt` 为**秒**；
/// `syncUpdatedAt` 为**毫秒**（沿用旧状态 LWW 约定）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BangumiSubjectRecord {
    pub subject_id: i64,
    pub source: String,
    pub title: String,
    pub title_original: Option<String>,
    pub title_romaji: Option<String>,
    pub cover_image: String,
    pub format: Option<String>,
    pub episodes: Option<i64>,
    pub airing: Option<BangumiAiring>,
    pub bangumi_status: Option<String>,
    pub rating: Option<f64>,
    pub watched_episode: Option<i64>,
    /// 兼容字段：旧 AniList id，仅迁移/回退查询用，可为空。
    pub anilist_id: Option<i64>,
    pub mapping: Option<BangumiMapping>,
    /// 迁移中间态标记：尚未建立映射时为 `true`（`{anilistId, subjectId: null, mappingPending: true}`）。
    pub mapping_pending: bool,
    pub last_pulled_from_bangumi_at: Option<i64>,
    pub last_pushed_to_bangumi_at: Option<i64>,
    /// 上次拉取 payload 哈希（冲突解决禁用 `updated_at` LWW，改用 hash）。
    pub last_pulled_payload_hash: Option<String>,
    pub last_pushed_payload_hash: Option<String>,
    pub last_changed_by: Option<LastChangedBy>,
    pub sync_updated_at: Option<i64>,
}

impl Default for BangumiSubjectRecord {
    fn default() -> Self {
        Self {
            subject_id: 0,
            source: "bangumi".into(),
            title: String::new(),
            title_original: None,
            title_romaji: None,
            cover_image: String::new(),
            format: None,
            episodes: None,
            airing: None,
            bangumi_status: None,
            rating: None,
            watched_episode: None,
            anilist_id: None,
            mapping: None,
            // 新记录默认处于迁移中间态（未映射）。
            mapping_pending: true,
            last_pulled_from_bangumi_at: None,
            last_pushed_to_bangumi_at: None,
            last_pulled_payload_hash: None,
            last_pushed_payload_hash: None,
            last_changed_by: None,
            sync_updated_at: None,
        }
    }
}

/// 集数/观看任务记录。旧任务 id 格式 `{animeId}-{episode}` Phase 0 保留可读；
/// 迁移中间态为 `{anilistId: <旧id>, subjectId: null, mappingPending: true}`，不覆盖旧数据。
///
/// 时间单位：`completedAt` / `createdAt` / `airingAt` 为**秒**，`syncUpdatedAt` 为**毫秒**。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BangumiEpisodeRecord {
    pub id: String,
    pub subject_id: Option<i64>,
    pub episode_id: Option<i64>,
    /// 集数不假设一定是简单整数。
    pub episode_number: Option<f64>,
    /// 稳定排序键。
    pub episode_sort_key: String,
    pub episode_type: EpisodeType,
    pub title: Option<String>,
    /// `"pending" | "completed"`（对齐旧任务状态）。
    pub status: String,
    pub completed_at: Option<i64>,
    pub created_at: Option<i64>,
    /// 旧任务兼容（AniList id）。
    pub anime_id: Option<i64>,
    pub airing_at: Option<i64>,
    pub sync_updated_at: Option<i64>,
    pub last_changed_by: Option<LastChangedBy>,
}

impl Default for BangumiEpisodeRecord {
    fn default() -> Self {
        Self {
            id: String::new(),
            subject_id: None,
            episode_id: None,
            episode_number: None,
            episode_sort_key: String::new(),
            episode_type: EpisodeType::Unknown,
            title: None,
            status: "pending".into(),
            completed_at: None,
            created_at: None,
            anime_id: None,
            airing_at: None,
            sync_updated_at: None,
            last_changed_by: None,
        }
    }
}

/// 本地-only 同步状态五字段：绝不进坚果云文档、不参与业务同步，仅本机展示与
/// 前台过期补偿（15 分钟）使用。时间单位为**秒**。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BangumiSyncStatus {
    pub last_full_sync_at: Option<i64>,
    pub last_web_dav_sync_at: Option<i64>,
    pub last_bangumi_sync_at: Option<i64>,
    pub last_schedule_sync_at: Option<i64>,
    /// 最近一次同步错误摘要（不含 Token）。
    pub last_sync_error: Option<String>,
}

/// Bangumi 用户摘要（前端展示用）。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BangumiUserSummary {
    pub id: i64,
    pub username: String,
    pub nickname: String,
    pub avatar_url: Option<String>,
}

// ---------------------------------------------------------------------------
// B. API 响应类型（按官方 v0.yaml 已核实的形状；字段宁可少而准，全部带
//    serde default 以前向兼容。注意 v0 Subject 没有 air_weekday。）
// ---------------------------------------------------------------------------

/// v0 分页信封（`total`/`limit`/`offset`/`data`）。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Paged<T> {
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub data: Vec<T>,
}

/// Subject 图片字段（`small` 等未声明字段被 serde 忽略）。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiSubjectImages {
    pub common: Option<String>,
    pub large: Option<String>,
    pub medium: Option<String>,
    pub grid: Option<String>,
}

/// Subject 评分（v0 rating）。
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiSubjectRating {
    pub rank: Option<u32>,
    pub total: Option<u32>,
    pub score: Option<f64>,
}

/// Subject 收藏人数统计（v0 collection）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiSubjectCollectionStats {
    pub wish: Option<u32>,
    pub collect: Option<u32>,
    pub doing: Option<u32>,
    pub on_hold: Option<u32>,
    pub dropped: Option<u32>,
}

/// Subject 标签。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiTag {
    pub name: String,
    pub count: u32,
}

/// Subject infobox 条目（`value` 可为字符串或数组）。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiInfobox {
    pub key: String,
    pub value: Value,
}

/// v0 Subject（`GET {v0}/subjects/{id}` 与季度列表条目共用；列表条目可能缺字段，
/// 全部带 default）。**v0 Subject 没有 air_weekday 字段**。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiSubject {
    pub id: i64,
    pub name: String,
    pub name_cn: Option<String>,
    /// 放送日期 `"YYYY-MM-DD"`。
    pub date: Option<String>,
    pub images: Option<BangumiSubjectImages>,
    pub eps: Option<u32>,
    pub rating: Option<BangumiSubjectRating>,
    pub collection: Option<BangumiSubjectCollectionStats>,
    pub tags: Vec<BangumiTag>,
    pub summary: Option<String>,
    pub platform: Option<String>,
    #[serde(default)]
    pub nsfw: bool,
    pub infobox: Vec<BangumiInfobox>,
}

/// v0 Episode（`GET {v0}/episodes?subject_id=...` / `{v0}/subjects/{id}/episodes`）。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiEpisode {
    pub id: i64,
    /// v0 字段名是 `type`（0 本篇 / 1 SP / 2 OP / 3 ED / 4 预告 / 5 MAD / 6 其他）。
    #[serde(rename = "type")]
    pub ep_type: u32,
    pub name: String,
    pub name_cn: Option<String>,
    pub sort: Option<f64>,
    pub ep: Option<f64>,
    pub airdate: Option<String>,
    pub duration: Option<String>,
    pub desc: Option<String>,
    pub subject_id: Option<i64>,
    /// 讨论数（v0 为整数）。
    pub comment: Option<i64>,
}

/// v0 角色（`GET {v0}/subjects/{id}/characters` 条目；actors 等未声明字段忽略）。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiCharacter {
    pub id: i64,
    pub name: String,
    pub name_cn: Option<String>,
    pub images: Option<BangumiSubjectImages>,
    pub relation: String,
}

/// v0 关联条目（`GET {v0}/subjects/{id}/subjects` 条目）。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiRelatedSubject {
    pub id: i64,
    pub name: String,
    pub name_cn: Option<String>,
    pub relation: String,
    pub images: Option<BangumiSubjectImages>,
}

/// v0 用户头像。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiUserProfileAvatar {
    pub large: Option<String>,
    pub medium: Option<String>,
    pub small: Option<String>,
}

/// v0 用户（`GET {v0}/me`）。注意 v0 分组字段是 `user_group`。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiUserProfile {
    pub id: i64,
    pub username: String,
    pub nickname: String,
    pub avatar: Option<BangumiUserProfileAvatar>,
    pub sign: Option<String>,
    pub user_group: Option<u32>,
}

/// v0 用户收藏条目（读取与写入共用形状；`type` 即 [`SubjectCollectionType`]）。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiCollection {
    pub subject_id: i64,
    pub subject_type: u32,
    pub rate: Option<u8>,
    /// v0 字段名是 `type`（1 wish / 2 done / 3 doing / 4 on_hold / 5 dropped）。
    #[serde(rename = "type")]
    pub collection_type: u32,
    pub tags: Vec<String>,
    pub ep_status: Option<u32>,
    pub vol_status: Option<u32>,
    /// 注意：官方注明评分/评价/章节观看状态修改可能不更新 `updated_at`，
    /// 不得作为冲突 LWW 依据（schema §3.2）。
    pub updated_at: Option<String>,
    pub private: Option<bool>,
    pub comment: Option<String>,
}

/// v0 错误响应体（`{"title", "description", "details"}`）。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiErrorBody {
    pub title: String,
    pub description: String,
    pub details: Option<Value>,
}

/// `/calendar`（根路径）星期分组。该端点是旧版非 v0 形状，字段宽松处理。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiCalendarDay {
    pub weekday: BangumiCalendarWeekday,
    pub items: Vec<BangumiCalendarItem>,
}

/// `/calendar` 星期信息。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiCalendarWeekday {
    pub id: Option<u32>,
    pub en: Option<String>,
    pub cn: Option<String>,
    pub ja: Option<String>,
}

/// `/calendar` 条目（旧版形状：与 v0 Subject 不同，含 `air_date`/`air_weekday` 等；
/// 未声明字段忽略）。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiCalendarItem {
    pub id: i64,
    pub name: String,
    pub name_cn: Option<String>,
    pub air_date: Option<String>,
    pub images: Option<BangumiSubjectImages>,
    pub eps: Option<u32>,
    pub rating: Option<BangumiSubjectRating>,
    pub url: Option<String>,
    pub summary: Option<String>,
}

// ---------------------------------------------------------------------------
// 枚举常量（端点/写路径使用；文档注释即单一来源）
// ---------------------------------------------------------------------------

/// Bangumi **条目**收藏状态（`GET/PUT/PATCH {v0}/users/.../collections` 的 `type`）。
///
/// 官方 v0 枚举：**2 是 Done（看过），不是 Doing；3 才是 Doing（在看）**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum SubjectCollectionType {
    /// 1 = 想看。
    Wish = 1,
    /// 2 = 看过（Done）。
    Done = 2,
    /// 3 = 在看（Doing）。
    Doing = 3,
    /// 4 = 搁置。
    OnHold = 4,
    /// 5 = 弃番。
    Dropped = 5,
}

impl SubjectCollectionType {
    pub fn as_u32(self) -> u32 {
        self as u32
    }
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            1 => Some(Self::Wish),
            2 => Some(Self::Done),
            3 => Some(Self::Doing),
            4 => Some(Self::OnHold),
            5 => Some(Self::Dropped),
            _ => None,
        }
    }
}

/// Bangumi **单集**收藏/进度状态（写进度端点的 body `{"type": N}`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum EpisodeCollectionType {
    /// 0 = 未收藏。
    NotCollected = 0,
    /// 1 = 想看。
    Wish = 1,
    /// 2 = 看过。
    Watched = 2,
    /// 3 = 抛弃。
    Dropped = 3,
}

impl EpisodeCollectionType {
    pub fn as_u32(self) -> u32 {
        self as u32
    }
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::NotCollected),
            1 => Some(Self::Wish),
            2 => Some(Self::Watched),
            3 => Some(Self::Dropped),
            _ => None,
        }
    }
}

/// Bangumi 集数类型（v0 Episode `type` 字段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum EpType {
    /// 0 = 本篇。
    Main = 0,
    /// 1 = SP（特别篇）。
    Sp = 1,
    /// 2 = OP。
    Op = 2,
    /// 3 = ED。
    Ed = 3,
    /// 4 = 预告。
    Preview = 4,
    /// 5 = MAD。
    Mad = 5,
    /// 6 = 其他。
    Other = 6,
}

impl EpType {
    pub fn as_u32(self) -> u32 {
        self as u32
    }
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::Main),
            1 => Some(Self::Sp),
            2 => Some(Self::Op),
            3 => Some(Self::Ed),
            4 => Some(Self::Preview),
            5 => Some(Self::Mad),
            6 => Some(Self::Other),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// C. Token 存储
// ---------------------------------------------------------------------------

/// Token 存取错误。`Display` 输出绝不包含 Token 本身。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenStoreError {
    /// 平台凭据存储错误（携带平台侧消息）。
    Platform(String),
    /// 凭据内容编码/序列化问题。
    Serialization,
    /// 其他错误（参数校验、未接入的平台等）。
    Other(String),
}

impl fmt::Display for TokenStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TokenStoreError::Platform(message) => write!(f, "凭据存储平台错误：{message}"),
            TokenStoreError::Serialization => write!(f, "凭据内容编码无效"),
            TokenStoreError::Other(message) => write!(f, "凭据存储错误：{message}"),
        }
    }
}

impl std::error::Error for TokenStoreError {}

/// Bangumi Access Token 存储契约：Token 只进系统凭据存储
/// （Windows Credential Manager / Android Keystore），绝不进入
/// 状态 JSON、日志、WebDAV 文档或提交。
pub trait BangumiTokenStore: Send + Sync {
    fn load(&self) -> Result<Option<String>, TokenStoreError>;
    /// 存储前应 trim 并拒绝空值。
    fn store(&self, token: &str) -> Result<(), TokenStoreError>;
    fn clear(&self) -> Result<(), TokenStoreError>;
}

/// Windows Credential Manager 服务名（与 WebDAV 的 `io.anilog.webdav` 区分）。
pub const BANGUMI_CREDENTIAL_SERVICE: &str = "io.anilog.bangumi";
/// 单用户应用使用固定 account。
pub const BANGUMI_CREDENTIAL_ACCOUNT: &str = "default";

/// Windows 实现：Credential Manager（keyring v3，`windows-native` feature）。
#[cfg(target_os = "windows")]
pub struct KeyringTokenStore;

#[cfg(target_os = "windows")]
impl Default for KeyringTokenStore {
    fn default() -> Self {
        Self
    }
}

#[cfg(target_os = "windows")]
impl KeyringTokenStore {
    pub fn new() -> Self {
        Self
    }
    fn entry() -> Result<keyring::Entry, TokenStoreError> {
        keyring::Entry::new(BANGUMI_CREDENTIAL_SERVICE, BANGUMI_CREDENTIAL_ACCOUNT)
            .map_err(TokenStoreError::from)
    }
}

#[cfg(target_os = "windows")]
impl From<keyring::Error> for TokenStoreError {
    fn from(error: keyring::Error) -> Self {
        match error {
            keyring::Error::BadEncoding(_) => TokenStoreError::Serialization,
            // keyring v3 的平台错误载荷是 Box<dyn Error>，取其 Display 消息。
            keyring::Error::PlatformFailure(source) => {
                TokenStoreError::Platform(source.to_string())
            }
            other => TokenStoreError::Other(other.to_string()),
        }
    }
}

#[cfg(target_os = "windows")]
impl BangumiTokenStore for KeyringTokenStore {
    fn load(&self) -> Result<Option<String>, TokenStoreError> {
        match Self::entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            // 从未存储过密码时 keyring 返回 NoEntry，语义上是"无 Token"。
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn store(&self, token: &str) -> Result<(), TokenStoreError> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return Err(TokenStoreError::Other("Bangumi Token 不能为空".into()));
        }
        Self::entry()?.set_password(trimmed)?;
        Ok(())
    }

    fn clear(&self) -> Result<(), TokenStoreError> {
        match Self::entry()?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

/// 非 Windows 桌面平台的占位实现（与 lib.rs WebDAV 非 Windows 平台写法一致）。
/// Android 在 Phase 1 通过 Keystore 桥（`BangumiTokenStore.java`）接入。
pub struct UnsupportedTokenStore;

impl Default for UnsupportedTokenStore {
    fn default() -> Self {
        Self
    }
}

impl BangumiTokenStore for UnsupportedTokenStore {
    fn load(&self) -> Result<Option<String>, TokenStoreError> {
        Err(TokenStoreError::Platform(
            "当前平台的安全凭据存储尚未接入".into(),
        ))
    }
    fn store(&self, _token: &str) -> Result<(), TokenStoreError> {
        Err(TokenStoreError::Platform(
            "当前平台的安全凭据存储尚未接入".into(),
        ))
    }
    fn clear(&self) -> Result<(), TokenStoreError> {
        Err(TokenStoreError::Platform(
            "当前平台的安全凭据存储尚未接入".into(),
        ))
    }
}

/// 测试用内存实现（进程内，绝不落盘）。仅测试构建存在，绝不进产物。
#[cfg(test)]
pub(crate) struct MemoryTokenStore {
    value: std::sync::Mutex<Option<String>>,
}

#[cfg(test)]
impl Default for MemoryTokenStore {
    fn default() -> Self {
        Self {
            value: std::sync::Mutex::new(None),
        }
    }
}

#[cfg(test)]
impl MemoryTokenStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
impl BangumiTokenStore for MemoryTokenStore {
    fn load(&self) -> Result<Option<String>, TokenStoreError> {
        Ok(self
            .value
            .lock()
            .map(|guard| guard.clone())
            .map_err(|_| TokenStoreError::Other("token store lock poisoned".into()))?)
    }
    fn store(&self, token: &str) -> Result<(), TokenStoreError> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return Err(TokenStoreError::Other("Bangumi Token 不能为空".into()));
        }
        let mut guard = self
            .value
            .lock()
            .map_err(|_| TokenStoreError::Other("token store lock poisoned".into()))?;
        *guard = Some(trimmed.to_string());
        Ok(())
    }
    fn clear(&self) -> Result<(), TokenStoreError> {
        let mut guard = self
            .value
            .lock()
            .map_err(|_| TokenStoreError::Other("token store lock poisoned".into()))?;
        *guard = None;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// D. 双基址与端点 URL
// ---------------------------------------------------------------------------

/// 官方根地址（`/calendar` 在根路径，v0 接口在 `/v0` 前缀下；**无 /seasons**）。
pub const OFFICIAL_BANGUMI_ROOT: &str = "https://api.bgm.tv";

/// 双基址：`root`（`/calendar` 等）与 `v0`（v0 接口前缀）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BangumiBaseUrls {
    pub root: String,
    pub v0: String,
}

/// 解析双基址（纯函数）：
/// - 配置为空/空白 → 官方 `root = https://api.bgm.tv`、`v0 = https://api.bgm.tv/v0`；
/// - 非 `https://` 前缀的配置视为无效，**回退官方基址**（明确可测语义：绝不降级为 http）；
/// - 以 `/v0` 结尾（忽略末尾斜杠）→ `root` 为剥离 `/v0` 后的串、`v0` 为原串；
/// - 否则 → `root` 为原串、`v0` 为原串 + `/v0`。
pub fn resolve_base_urls(configured: &str) -> BangumiBaseUrls {
    let trimmed = configured.trim();
    if trimmed.is_empty() || !trimmed.starts_with("https://") {
        return official_base_urls();
    }
    let normalized = trimmed.trim_end_matches('/');
    if let Some(root) = normalized.strip_suffix("/v0") {
        BangumiBaseUrls {
            root: root.to_string(),
            v0: normalized.to_string(),
        }
    } else {
        BangumiBaseUrls {
            root: normalized.to_string(),
            v0: format!("{normalized}/v0"),
        }
    }
}

fn official_base_urls() -> BangumiBaseUrls {
    BangumiBaseUrls {
        root: OFFICIAL_BANGUMI_ROOT.to_string(),
        v0: format!("{OFFICIAL_BANGUMI_ROOT}/v0"),
    }
}

/// 季度列表分页 limit 上限。
pub const SEASON_SUBJECTS_LIMIT_MAX: u32 = 50;
/// 集数列表分页 limit 上限（注意：集数是 `/v0/episodes`）。
pub const SUBJECT_EPISODES_LIMIT_MAX: u32 = 200;

/// `GET {root}/calendar`（根路径，非 /v0 下）。
pub fn calendar_url(base: &BangumiBaseUrls) -> String {
    format!("{}/calendar", base.root)
}

/// `GET {v0}/subjects?type=2&year=&month=&limit=&offset=`（季度列表；无 /seasons 端点）。
pub fn season_subjects_url(
    base: &BangumiBaseUrls,
    year: u32,
    month: u32,
    limit: u32,
    offset: u32,
) -> String {
    format!(
        "{}/subjects?type=2&year={year}&month={month}&limit={}&offset={offset}",
        base.v0,
        limit.min(SEASON_SUBJECTS_LIMIT_MAX)
    )
}

/// `GET {v0}/subjects/{id}`。
pub fn subject_detail_url(base: &BangumiBaseUrls, subject_id: i64) -> String {
    format!("{}/subjects/{subject_id}", base.v0)
}

/// `GET {v0}/episodes?subject_id=&type=&limit=&offset=`（集数是 /v0/episodes）。
pub fn subject_episodes_url(
    base: &BangumiBaseUrls,
    subject_id: i64,
    limit: u32,
    offset: u32,
) -> String {
    format!(
        "{}/episodes?subject_id={subject_id}&limit={}&offset={offset}",
        base.v0,
        limit.min(SUBJECT_EPISODES_LIMIT_MAX)
    )
}

/// `GET {v0}/subjects/{id}/characters`。
pub fn subject_characters_url(base: &BangumiBaseUrls, subject_id: i64) -> String {
    format!("{}/subjects/{subject_id}/characters", base.v0)
}

/// `GET {v0}/subjects/{id}/subjects`（关联条目）。
pub fn subject_related_url(base: &BangumiBaseUrls, subject_id: i64) -> String {
    format!("{}/subjects/{subject_id}/subjects", base.v0)
}

/// `GET {v0}/me`（testConnection 用）。
pub fn me_url(base: &BangumiBaseUrls) -> String {
    format!("{}/me", base.v0)
}

/// `GET {v0}/users/{username}/collections?subject_type=&type=&limit=&offset=`。
/// username 来自 `GET {v0}/me`。
#[allow(clippy::too_many_arguments)]
pub fn user_collections_url(
    base: &BangumiBaseUrls,
    username: &str,
    subject_type: u32,
    limit: u32,
    offset: u32,
) -> String {
    format!(
        "{}/users/{username}/collections?subject_type={subject_type}&limit={}&offset={offset}",
        base.v0,
        limit.min(SUBJECT_EPISODES_LIMIT_MAX)
    )
}

/// `GET {v0}/users/{username}/collections/{subject_id}`（注意路径段是复数 collections）。
pub fn user_collection_url(base: &BangumiBaseUrls, username: &str, subject_id: i64) -> String {
    format!("{}/users/{username}/collections/{subject_id}", base.v0)
}

/// `POST|PATCH {v0}/users/-/collections/{subject_id}`。
/// 官方 spec 用 `-` 占位 = 当前 token 用户。
pub fn update_collection_url(base: &BangumiBaseUrls, subject_id: i64) -> String {
    format!("{}/users/-/collections/{subject_id}", base.v0)
}

/// `PUT {v0}/users/-/collections/-/episodes/{episode_id}`，body `{"type": N}`。
/// `-` 占位 = 当前 token 用户（官方 spec）。
pub fn episode_progress_url(base: &BangumiBaseUrls, episode_id: i64) -> String {
    format!(
        "{}/users/-/collections/-/episodes/{episode_id}",
        base.v0
    )
}

/// `PATCH {v0}/users/-/collections/{subject_id}/episodes`，
/// body `{"episode_id": [...], "type": N}`。`-` 占位 = 当前 token 用户（官方 spec）。
pub fn episode_progress_batch_url(base: &BangumiBaseUrls, subject_id: i64) -> String {
    format!("{}/users/-/collections/{subject_id}/episodes", base.v0)
}

/// 季度 → 起始月份三元组（与 lib.rs 的季节字符串风格一致：大写英文）。
/// 未知季节返回 `[0, 0, 0]`，调用方应视为无效输入。
pub fn season_months(season: &str) -> [u32; 3] {
    match season.trim().to_ascii_uppercase().as_str() {
        "WINTER" => [1, 2, 3],
        "SPRING" => [4, 5, 6],
        "SUMMER" => [7, 8, 9],
        "FALL" => [10, 11, 12],
        _ => [0, 0, 0],
    }
}

// ---------------------------------------------------------------------------
// E. 错误模型
// ---------------------------------------------------------------------------

/// Bangumi API 错误。`Display` 输出绝不包含 Authorization 头或 Token。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BangumiApiError {
    /// 401。
    Unauthorized { message: String },
    /// 403。
    Forbidden { message: String },
    /// 404。
    NotFound { message: String },
    /// 409。
    Conflict { message: String },
    /// 429；`retry_after` 来自 `Retry-After` 头。
    RateLimited {
        retry_after: Option<StdDuration>,
        message: String,
    },
    /// 5xx 及其他未分类 HTTP 状态。
    ServerError(u16),
    /// 网络层错误（DNS/连接/中断等）。
    Network(String),
    /// 请求超时。
    Timeout,
    /// 响应解析失败。
    Parse(String),
}

impl fmt::Display for BangumiApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BangumiApiError::Unauthorized { message } => write!(f, "Bangumi 认证失败（401）：{message}"),
            BangumiApiError::Forbidden { message } => write!(f, "Bangumi 拒绝访问（403）：{message}"),
            BangumiApiError::NotFound { message } => write!(f, "Bangumi 资源不存在（404）：{message}"),
            BangumiApiError::Conflict { message } => write!(f, "Bangumi 状态冲突（409）：{message}"),
            BangumiApiError::RateLimited { retry_after, message } => match retry_after {
                Some(duration) => write!(
                    f,
                    "Bangumi 请求过于频繁（429），{} 秒后重试：{message}",
                    duration.as_secs()
                ),
                None => write!(f, "Bangumi 请求过于频繁（429）：{message}"),
            },
            BangumiApiError::ServerError(status) => {
                write!(f, "Bangumi 服务端错误（HTTP {status}）")
            }
            BangumiApiError::Network(message) => write!(f, "Bangumi 网络错误：{message}"),
            BangumiApiError::Timeout => write!(f, "Bangumi 请求超时"),
            BangumiApiError::Parse(message) => write!(f, "Bangumi 响应解析失败：{message}"),
        }
    }
}

impl std::error::Error for BangumiApiError {}

/// 由 HTTP 状态 + 响应体 + `Retry-After` 头构造错误。
/// 解析 [`BangumiErrorBody`] 的 `title`/`description` 进 `Display`；
/// **绝不**把 Authorization 头或 Token 拼进错误信息。
pub fn from_status(status: u16, body: &str, retry_after_header: Option<&str>) -> BangumiApiError {
    let parsed: BangumiErrorBody = serde_json::from_str(body).unwrap_or_default();
    let message = compose_error_message(&parsed, body);
    match status {
        401 => BangumiApiError::Unauthorized { message },
        403 => BangumiApiError::Forbidden { message },
        404 => BangumiApiError::NotFound { message },
        409 => BangumiApiError::Conflict { message },
        429 => BangumiApiError::RateLimited {
            retry_after: parse_retry_after(retry_after_header),
            message,
        },
        // 其余状态（含 4xx 如 400、5xx）一律按服务端/未分类错误处理。
        other => BangumiApiError::ServerError(other),
    }
}

fn compose_error_message(parsed: &BangumiErrorBody, raw_body: &str) -> String {
    match (parsed.title.trim(), parsed.description.trim()) {
        ("", "") => {
            // 非 JSON 响应体（如网关 HTML）截断后原样携带，便于排障。
            let truncated: String = raw_body.trim().chars().take(160).collect();
            if truncated.is_empty() {
                "未知错误".into()
            } else {
                truncated
            }
        }
        ("", description) => description.to_string(),
        (title, "") => title.to_string(),
        (title, description) => format!("{title}：{description}"),
    }
}

/// 解析 `Retry-After` 头。支持 delta-seconds（整数秒）形式；
/// HTTP-date 形式（如 `Wed, 21 Oct 2026 07:28:00 GMT`）Phase 0 简化为返回
/// `None`（调用方按无提示退避处理），避免引入额外的日期解析分支。
pub fn parse_retry_after(header: Option<&str>) -> Option<StdDuration> {
    let raw = header?.trim();
    // HTTP-date 含字母与逗号，直接解析 u64 会失败并返回 None。
    raw.parse::<u64>().ok().map(StdDuration::from_secs)
}

// ---------------------------------------------------------------------------
// F. broadcast 解析与选站（纯函数；Phase 4 将在 Java 复刻同逻辑，
//    golden 向量共享：src-tauri/fixtures/bangumi/broadcast-vectors.json）
// ---------------------------------------------------------------------------

/// 选站与 recurrence 步进的安全上限，防止异常输入导致无限循环。
const MAX_RECURRENCE_STEPS: usize = 100_000;

/// 站点级播出时间源（与 JSON 表示解耦：v2 离线映射里键名是 `s`/`i`，
/// golden 向量 fixture 里是 `site`/`id`，本结构只关心站点名与时间字段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BroadcastSite<'a> {
    pub site: &'a str,
    pub begin: Option<&'a str>,
    pub broadcast: Option<&'a str>,
}

/// 计算下一次播出时刻（严格晚于 `after`），返回 UTC 时刻。
///
/// 1. 选时间源：按 `preferred` 顺序找第一个有 begin/broadcast 的站点；
///    否则使用条目级 begin/broadcast；
/// 2. 有 broadcast `R/<start>/P<nD|nW>`：从 start 起按周期步进找第一个
///    `> after` 的时刻（周期支持 D/W，够 bangumi-data 的周播场景；其他
///    RFC5545 周期形式不支持，返回 None）；
/// 3. 只有 begin：begin > after 时返回 begin，否则 None（电影等一次性播出）；
/// 4. 全无 → None。
pub fn next_broadcast_after(
    begin: Option<&str>,
    broadcast: Option<&str>,
    sites: &[BroadcastSite<'_>],
    preferred: &[String],
    after: DateTime<impl TimeZone>,
) -> Option<DateTime<Utc>> {
    let mut selected_begin = begin;
    let mut selected_broadcast = broadcast;
    for name in preferred {
        if let Some(site) = sites
            .iter()
            .find(|site| site.site == name.as_str() && (site.begin.is_some() || site.broadcast.is_some()))
        {
            selected_begin = site.begin;
            selected_broadcast = site.broadcast;
            break;
        }
    }
    if let Some(rule) = selected_broadcast {
        if let Some(occurrence) = next_recurrence(rule, &after) {
            return Some(occurrence);
        }
    }
    // broadcast 缺失或无法解析时，回落为一次性 begin（电影/OVA 场景）。
    let start = parse_instant(selected_begin?)?;
    (start > after).then_some(start)
}

/// 解析 `R/<start>/P<nD|nW>` 并步进到第一个严格晚于 `after` 的时刻。
fn next_recurrence(rule: &str, after: &DateTime<impl TimeZone>) -> Option<DateTime<Utc>> {
    let rest = rule.trim().strip_prefix('R')?.strip_prefix('/')?;
    let (start_raw, period_raw) = rest.split_once('/')?;
    let start = parse_instant(start_raw)?;
    let step = parse_period(period_raw)?;
    let mut occurrence = start;
    for _ in 0..MAX_RECURRENCE_STEPS {
        if occurrence > *after {
            return Some(occurrence);
        }
        occurrence = occurrence.checked_add_signed(step)?;
    }
    None
}

/// 解析周期段：仅支持 `P<nD>` / `P<nW>`（周播覆盖 bangumi-data 现有数据；
/// 更复杂的 RFC5545 周期形式如 `PT`/复合周期不支持，返回 None）。
fn parse_period(period: &str) -> Option<Duration> {
    let body = period.trim().strip_prefix('P')?;
    if body.len() < 2 {
        return None;
    }
    let (digits, unit) = body.split_at(body.len() - 1);
    let count: i64 = digits.parse().ok()?;
    match unit {
        "D" => Some(Duration::days(count)),
        "W" => Some(Duration::days(count * 7)),
        _ => None,
    }
}

/// 解析 ISO8601 时间戳（含毫秒 / `Z` / 数字偏移），统一转 UTC。
pub(crate) fn parse_instant(value: &str) -> Option<DateTime<Utc>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = match trimmed.strip_suffix(['Z', 'z']) {
        Some(rest) => format!("{rest}+00:00"),
        None => trimmed.to_string(),
    };
    DateTime::parse_from_rfc3339(&normalized)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

// ---------------------------------------------------------------------------
// G. BangumiClient trait + FixtureBangumiClient
// ---------------------------------------------------------------------------

/// Bangumi 数据客户端抽象（async fn in trait；Phase 1 提供基于 reqwest 双基址的
/// `HttpBangumiClient`，测试用 [`FixtureBangumiClient`]）。不追求 dyn 兼容。
pub trait BangumiClient {
    /// `GET {root}/calendar`（根路径）。
    fn get_calendar(&self) -> impl Future<Output = Result<Vec<BangumiCalendarDay>, BangumiApiError>>;
    /// `GET {v0}/subjects?type=2&year=&month=&limit=&offset=`（季度列表分页）。
    fn get_season_subjects(
        &self,
        year: u32,
        month: u32,
        limit: u32,
        offset: u32,
    ) -> impl Future<Output = Result<Paged<BangumiSubject>, BangumiApiError>>;
    /// `GET {v0}/subjects/{id}`。
    fn get_subject_detail(
        &self,
        subject_id: i64,
    ) -> impl Future<Output = Result<BangumiSubject, BangumiApiError>>;
    /// `GET {v0}/episodes?subject_id=&limit=&offset=`（集数是 /v0/episodes）。
    fn get_subject_episodes(
        &self,
        subject_id: i64,
        limit: u32,
        offset: u32,
    ) -> impl Future<Output = Result<Paged<BangumiEpisode>, BangumiApiError>>;
    /// `GET {v0}/subjects/{id}/characters`。
    fn get_subject_characters(
        &self,
        subject_id: i64,
    ) -> impl Future<Output = Result<Vec<BangumiCharacter>, BangumiApiError>>;
    /// `GET {v0}/subjects/{id}/subjects`。
    fn get_subject_related(
        &self,
        subject_id: i64,
    ) -> impl Future<Output = Result<Vec<BangumiRelatedSubject>, BangumiApiError>>;
    /// `GET {v0}/me`。
    fn get_user_profile(&self) -> impl Future<Output = Result<BangumiUserProfile, BangumiApiError>>;
    /// `GET {v0}/users/{username}/collections?subject_type=&limit=&offset=`。
    fn get_user_collections(
        &self,
        username: &str,
        subject_type: u32,
        limit: u32,
        offset: u32,
    ) -> impl Future<Output = Result<Paged<BangumiCollection>, BangumiApiError>>;
    /// `GET {v0}/users/{username}/collections/{subject_id}`。
    fn get_user_collection(
        &self,
        username: &str,
        subject_id: i64,
    ) -> impl Future<Output = Result<BangumiCollection, BangumiApiError>>;
    /// `POST|PATCH {v0}/users/-/collections/{subject_id}`（204 无响应体）。
    fn update_collection(
        &self,
        subject_id: i64,
        payload: &Value,
    ) -> impl Future<Output = Result<(), BangumiApiError>>;
    /// `PUT {v0}/users/-/collections/-/episodes/{episode_id}`，body `{"type": N}`（204）。
    fn update_episode_progress(
        &self,
        episode_id: i64,
        collection_type: EpisodeCollectionType,
    ) -> impl Future<Output = Result<(), BangumiApiError>>;
    /// `PATCH {v0}/users/-/collections/{subject_id}/episodes`，
    /// body `{"episode_id": [...], "type": N}`（204）。
    fn update_episode_progress_batch(
        &self,
        subject_id: i64,
        episode_ids: &[i64],
        collection_type: EpisodeCollectionType,
    ) -> impl Future<Output = Result<(), BangumiApiError>>;
    /// 连通性测试（等价 `GET {v0}/me`）。
    fn test_connection(&self) -> impl Future<Output = Result<BangumiUserProfile, BangumiApiError>>;
}

/// fixture 客户端：所有方法返回 `src-tauri/fixtures/bangumi/` 内置样本的解析结果。
/// 写方法按官方 204 无响应体返回 `Ok(())`；错误场景用 [`stub_error`](Self::stub_error)。
pub struct FixtureBangumiClient;

impl Default for FixtureBangumiClient {
    fn default() -> Self {
        Self
    }
}

impl FixtureBangumiClient {
    pub fn new() -> Self {
        Self
    }

    /// 测试辅助：构造与真实 HTTP 状态对应的错误（429 附带 `Retry-After: 120`）。
    pub fn stub_error(status: u16) -> BangumiApiError {
        let body = match status {
            401 => include_str!("../fixtures/bangumi/error-401.json"),
            429 => include_str!("../fixtures/bangumi/error-429.json"),
            _ => "",
        };
        let retry_after = (status == 429).then_some("120");
        from_status(status, body, retry_after)
    }

    fn parse<T: DeserializeOwned>(raw: &'static str) -> T {
        serde_json::from_str(raw).expect("bangumi fixture must parse")
    }
}

impl BangumiClient for FixtureBangumiClient {
    async fn get_calendar(&self) -> Result<Vec<BangumiCalendarDay>, BangumiApiError> {
        Ok(Self::parse(include_str!(
            "../fixtures/bangumi/calendar.json"
        )))
    }

    async fn get_season_subjects(
        &self,
        _year: u32,
        _month: u32,
        _limit: u32,
        _offset: u32,
    ) -> Result<Paged<BangumiSubject>, BangumiApiError> {
        Ok(Self::parse(include_str!(
            "../fixtures/bangumi/subjects-page.json"
        )))
    }

    async fn get_subject_detail(&self, _subject_id: i64) -> Result<BangumiSubject, BangumiApiError> {
        Ok(Self::parse(include_str!(
            "../fixtures/bangumi/subject-detail.json"
        )))
    }

    async fn get_subject_episodes(
        &self,
        _subject_id: i64,
        _limit: u32,
        _offset: u32,
    ) -> Result<Paged<BangumiEpisode>, BangumiApiError> {
        Ok(Self::parse(include_str!(
            "../fixtures/bangumi/subject-episodes.json"
        )))
    }

    async fn get_subject_characters(
        &self,
        _subject_id: i64,
    ) -> Result<Vec<BangumiCharacter>, BangumiApiError> {
        Ok(Self::parse(include_str!(
            "../fixtures/bangumi/subject-characters.json"
        )))
    }

    async fn get_subject_related(
        &self,
        _subject_id: i64,
    ) -> Result<Vec<BangumiRelatedSubject>, BangumiApiError> {
        Ok(Self::parse(include_str!(
            "../fixtures/bangumi/subject-related.json"
        )))
    }

    async fn get_user_profile(&self) -> Result<BangumiUserProfile, BangumiApiError> {
        Ok(Self::parse(include_str!(
            "../fixtures/bangumi/user-profile.json"
        )))
    }

    async fn get_user_collections(
        &self,
        _username: &str,
        _subject_type: u32,
        _limit: u32,
        _offset: u32,
    ) -> Result<Paged<BangumiCollection>, BangumiApiError> {
        Ok(Self::parse(include_str!(
            "../fixtures/bangumi/user-collections-page.json"
        )))
    }

    async fn get_user_collection(
        &self,
        _username: &str,
        _subject_id: i64,
    ) -> Result<BangumiCollection, BangumiApiError> {
        Ok(Self::parse(include_str!(
            "../fixtures/bangumi/user-collection.json"
        )))
    }

    async fn update_collection(&self, _subject_id: i64, _payload: &Value) -> Result<(), BangumiApiError> {
        Ok(())
    }

    async fn update_episode_progress(
        &self,
        _episode_id: i64,
        _collection_type: EpisodeCollectionType,
    ) -> Result<(), BangumiApiError> {
        Ok(())
    }

    async fn update_episode_progress_batch(
        &self,
        _subject_id: i64,
        _episode_ids: &[i64],
        _collection_type: EpisodeCollectionType,
    ) -> Result<(), BangumiApiError> {
        Ok(())
    }

    async fn test_connection(&self) -> Result<BangumiUserProfile, BangumiApiError> {
        self.get_user_profile().await
    }
}

// ---------------------------------------------------------------------------
// 测试（cfg(test)）；整个模块仅在 standard feature 下编译，
// 因此这些测试只进 standard 门禁。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 无 tokio rt/macros 依赖的极简 block_on：本模块的 future 均为立即就绪，
    /// 用 noop waker 自旋即可。
    fn block_on<F: Future>(future: F) -> F::Output {
        let waker = std::task::Waker::noop();
        let mut cx = std::task::Context::from_waker(waker);
        let mut future = std::pin::pin!(future);
        loop {
            match future.as_mut().poll(&mut cx) {
                std::task::Poll::Ready(value) => return value,
                std::task::Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    fn fixture_value(name: &str) -> Value {
        let raw = match name {
            "old-state-v2" => include_str!("../fixtures/bangumi/old-state-v2.json"),
            "state-with-bangumi" => include_str!("../fixtures/bangumi/state-with-bangumi.json"),
            _ => panic!("unknown fixture {name}"),
        };
        serde_json::from_str(raw).expect("state fixture must parse")
    }

    // -- 1. serde round-trip -------------------------------------------------

    #[test]
    fn bangumi_sync_settings_round_trip_with_defaults() {
        let settings = BangumiSyncSettings::default();
        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["syncEnabled"], false);
        assert_eq!(value["conflictPolicy"], "latest");
        let restored: BangumiSyncSettings = serde_json::from_value(value).unwrap();
        assert_eq!(restored, settings);
        // 缺字段也应通过 serde default 重建默认值（前向兼容）。
        let partial: BangumiSyncSettings =
            serde_json::from_value(json!({"syncEnabled": true})).unwrap();
        assert!(partial.sync_enabled);
        assert_eq!(partial.conflict_policy, ConflictPolicy::Latest);
        assert_eq!(
            partial.preferred_broadcast_sites,
            default_preferred_broadcast_sites()
        );
    }

    #[test]
    fn bangumi_subject_record_round_trip() {
        let record = BangumiSubjectRecord {
            subject_id: 45678,
            title: "Re:从零开始的异世界生活 第3章".into(),
            title_original: Some("リ:ゼロから始める異世界生活 第3章".into()),
            title_romaji: Some("Re:Zero 3rd Season".into()),
            cover_image: "https://lain.bgm.tv/pic/cover/c/00/00/45678_pL3cR.jpg".into(),
            format: Some("TV".into()),
            episodes: Some(16),
            airing: Some(BangumiAiring {
                next_episode: Some(4),
                next_airing_at: Some(1_785_357_622),
            }),
            bangumi_status: Some("doing".into()),
            rating: Some(8.2),
            watched_episode: Some(3),
            anilist_id: Some(21355),
            mapping: Some(BangumiMapping {
                method: MappingMethod::External,
                confidence: MappingConfidence::High,
                updated_at: 1_785_300_000,
            }),
            mapping_pending: false,
            last_pulled_from_bangumi_at: Some(1_785_300_000),
            last_pushed_to_bangumi_at: None,
            last_pulled_payload_hash: Some("abc123".into()),
            last_pushed_payload_hash: None,
            last_changed_by: Some(LastChangedBy::Bangumi),
            sync_updated_at: Some(1_785_300_000_000),
            ..Default::default()
        };
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["subjectId"], 45678);
        assert_eq!(value["mapping"]["method"], "external");
        assert_eq!(value["mapping"]["confidence"], "high");
        assert_eq!(value["lastChangedBy"], "bangumi");
        assert_eq!(value["source"], "bangumi");
        assert!(value["mappingPending"] == false);
        let restored: BangumiSubjectRecord = serde_json::from_value(value).unwrap();
        assert_eq!(restored, record);
    }

    #[test]
    fn bangumi_episode_record_round_trip() {
        let record = BangumiEpisodeRecord {
            id: "bgm-episode-98765".into(),
            subject_id: Some(45678),
            episode_id: Some(98765),
            episode_number: Some(4.0),
            episode_sort_key: "0004".into(),
            episode_type: EpisodeType::Regular,
            title: Some("第4话".into()),
            status: "completed".into(),
            completed_at: Some(1_785_300_000),
            created_at: Some(1_785_200_000),
            anime_id: Some(21355),
            airing_at: Some(1_785_357_622),
            sync_updated_at: Some(1_785_300_000_000),
            last_changed_by: Some(LastChangedBy::Local),
        };
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["episodeType"], "regular");
        assert_eq!(value["episodeSortKey"], "0004");
        let restored: BangumiEpisodeRecord = serde_json::from_value(value).unwrap();
        assert_eq!(restored, record);
        // 迁移中间态：subjectId 为 null 仍可解析。
        let intermediate: BangumiEpisodeRecord =
            serde_json::from_value(json!({"id": "21355-4", "episodeSortKey": "0004"})).unwrap();
        assert_eq!(intermediate.subject_id, None);
        assert_eq!(intermediate.episode_type, EpisodeType::Unknown);
        assert_eq!(intermediate.status, "pending");
    }

    #[test]
    fn bangumi_sync_status_and_user_summary_round_trip() {
        let status = BangumiSyncStatus {
            last_full_sync_at: Some(1_785_300_000),
            last_web_dav_sync_at: None,
            last_bangumi_sync_at: Some(1_785_300_000),
            last_schedule_sync_at: None,
            last_sync_error: Some("429 rate limited".into()),
        };
        let value = serde_json::to_value(&status).unwrap();
        let restored: BangumiSyncStatus = serde_json::from_value(value).unwrap();
        assert_eq!(restored, status);

        let user = BangumiUserSummary {
            id: 876543,
            username: "anilog_dev".into(),
            nickname: "阿罗".into(),
            avatar_url: Some("https://lain.bgm.tv/pic/user/m/000/87/65/876543.jpg".into()),
        };
        let value = serde_json::to_value(&user).unwrap();
        assert_eq!(value["avatarUrl"], "https://lain.bgm.tv/pic/user/m/000/87/65/876543.jpg");
        let restored: BangumiUserSummary = serde_json::from_value(value).unwrap();
        assert_eq!(restored, user);
    }

    // -- 2. 旧 v2 状态 merge_defaults 补 bangumi 块 ---------------------------

    #[test]
    fn merge_defaults_fills_default_bangumi_block_for_legacy_v2_state() {
        let loaded = fixture_value("old-state-v2");
        assert!(loaded.get("bangumi").is_none());

        let following_before = loaded["following"].clone();
        let tasks_before = loaded["tasks"].clone();

        let merged = crate::merge_defaults(loaded, false);

        let expected = serde_json::to_value(BangumiSyncSettings::default()).unwrap();
        assert_eq!(merged["bangumi"], expected);
        // 原字段不动。
        assert_eq!(merged["following"], following_before);
        assert_eq!(merged["tasks"], tasks_before);
        assert_eq!(merged["version"], crate::STATE_VERSION);
        assert_eq!(merged["settings"]["uiLanguage"], "zh-CN");
    }

    #[test]
    fn merge_defaults_never_fills_bangumi_block_for_original() {
        let loaded = fixture_value("old-state-v2");
        let merged = crate::merge_defaults(loaded, true);
        assert!(merged.get("bangumi").is_none());
    }

    #[test]
    fn merge_defaults_keeps_existing_bangumi_block() {
        let mut loaded = fixture_value("state-with-bangumi");
        loaded["bangumi"]["apiBaseUrl"] = json!("https://proxy.example.com/v0");
        loaded["bangumi"]["conflictPolicy"] = json!("local-first");
        let merged = crate::merge_defaults(loaded, false);
        assert_eq!(merged["bangumi"]["apiBaseUrl"], "https://proxy.example.com/v0");
        assert_eq!(merged["bangumi"]["conflictPolicy"], "local-first");
    }

    // -- 3. 双基址 ------------------------------------------------------------

    #[test]
    fn resolve_base_urls_official_and_proxy() {
        // 空/空白 → 官方。
        for configured in ["", "   "] {
            let base = resolve_base_urls(configured);
            assert_eq!(base.root, "https://api.bgm.tv");
            assert_eq!(base.v0, "https://api.bgm.tv/v0");
        }
        // 带 /v0 后缀（含末尾斜杠）→ root 剥离，v0 原串。
        let base = resolve_base_urls("https://sh1n.cc.cd/v0");
        assert_eq!(base.root, "https://sh1n.cc.cd");
        assert_eq!(base.v0, "https://sh1n.cc.cd/v0");
        let base = resolve_base_urls("https://sh1n.cc.cd/v0/");
        assert_eq!(base.root, "https://sh1n.cc.cd");
        assert_eq!(base.v0, "https://sh1n.cc.cd/v0");
        // 无 /v0 后缀 → root 原串，v0 追加。
        let base = resolve_base_urls("https://proxy.example.com/bgm");
        assert_eq!(base.root, "https://proxy.example.com/bgm");
        assert_eq!(base.v0, "https://proxy.example.com/bgm/v0");
        // 非 https 配置回退官方（绝不降级为 http）。
        let base = resolve_base_urls("http://insecure.example.com/v0");
        assert_eq!(base.root, "https://api.bgm.tv");
        assert_eq!(base.v0, "https://api.bgm.tv/v0");
    }

    // -- 4. 错误模型 -----------------------------------------------------------

    #[test]
    fn from_status_429_parses_retry_after() {
        let error = from_status(429, include_str!("../fixtures/bangumi/error-429.json"), Some("120"));
        match error {
            BangumiApiError::RateLimited { retry_after, message } => {
                assert_eq!(retry_after, Some(StdDuration::from_secs(120)));
                assert!(message.contains("Too Many Requests"));
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }

    #[test]
    fn from_status_maps_statuses_and_error_body() {
        let error = from_status(401, include_str!("../fixtures/bangumi/error-401.json"), None);
        assert!(matches!(error, BangumiApiError::Unauthorized { .. }));
        assert!(error.to_string().contains("Unauthorized"));

        assert!(matches!(
            from_status(403, "{}", None),
            BangumiApiError::Forbidden { .. }
        ));
        assert!(matches!(
            from_status(404, "", None),
            BangumiApiError::NotFound { .. }
        ));
        assert!(matches!(
            from_status(409, "", None),
            BangumiApiError::Conflict { .. }
        ));
        assert_eq!(
            from_status(503, "", None),
            BangumiApiError::ServerError(503)
        );
        assert_eq!(
            from_status(400, "", None),
            BangumiApiError::ServerError(400)
        );
    }

    #[test]
    fn error_display_never_contains_token_material() {
        for status in [401u16, 403, 404, 409, 429, 500] {
            let error = from_status(
                status,
                r#"{"title":"Error","description":"请求被拒绝"}"#,
                (status == 429).then_some("30"),
            );
            let display = error.to_string();
            assert!(!display.contains("Bearer"), "display leaks Bearer: {display}");
            assert!(!display.contains("token"), "display leaks token: {display}");
            assert!(!display.contains("Authorization"));
        }
        // 非 JSON 错误体走截断回退，也绝不附加任何凭据材料。
        let error = from_status(502, "<html>Bad Gateway</html>", None);
        assert!(matches!(error, BangumiApiError::ServerError(502)));
    }

    #[test]
    fn parse_retry_after_supports_seconds_only() {
        assert_eq!(parse_retry_after(Some(" 120 ")), Some(StdDuration::from_secs(120)));
        assert_eq!(parse_retry_after(Some("0")), Some(StdDuration::from_secs(0)));
        // HTTP-date 形式 Phase 0 简化为 None（见函数注释）。
        assert_eq!(
            parse_retry_after(Some("Wed, 21 Oct 2026 07:28:00 GMT")),
            None
        );
        assert_eq!(parse_retry_after(Some("soon")), None);
        assert_eq!(parse_retry_after(None), None);
    }

    // -- 5. broadcast golden 向量 ----------------------------------------------

    #[test]
    fn broadcast_golden_vectors_pass() {
        let raw = include_str!("../fixtures/bangumi/broadcast-vectors.json");
        let vectors: Value = serde_json::from_str(raw).expect("broadcast vectors fixture");
        for vector in vectors["vectors"].as_array().expect("vectors array") {
            let name = vector["name"].as_str().unwrap_or_default();
            let after_raw = vector["nowLocalISO"].as_str().expect("nowLocalISO");
            let after = DateTime::parse_from_rfc3339(after_raw).expect("parse nowLocalISO");
            let preferred: Vec<String> = vector["preferredSites"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let sites: Vec<BroadcastSite<'_>> = vector["sites"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .map(|site| BroadcastSite {
                            site: site["site"].as_str().unwrap_or_default(),
                            begin: site["begin"].as_str(),
                            broadcast: site["broadcast"].as_str(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let expected = vector["expectedNextLocal"].as_str().expect("expectedNextLocal");

            let next = next_broadcast_after(
                vector["begin"].as_str(),
                vector["broadcast"].as_str(),
                &sites,
                &preferred,
                after,
            )
            .unwrap_or_else(|| panic!("vector {name}: expected a next broadcast"));

            // 结果须以 nowLocalISO 同样的墙钟时区偏移表达。
            let rendered = next.with_timezone(after.offset());
            let actual = rendered.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true);
            assert_eq!(
                actual, expected,
                "vector {name}: broadcast mismatch"
            );
        }
    }

    #[test]
    fn next_broadcast_falls_back_between_sites_and_begin() {
        let preferred = vec!["bangumi".to_string(), "ani_one".to_string()];
        let sites = [
            BroadcastSite {
                site: "bangumi",
                begin: None,
                broadcast: None,
            },
            BroadcastSite {
                site: "ani_one",
                begin: Some("2026-07-08T21:00:00+08:00"),
                broadcast: Some("R/2026-07-08T21:00:00.000+08:00/P7D"),
            },
        ];
        let after = DateTime::parse_from_rfc3339("2026-07-19T00:00:00+08:00").unwrap();
        let next = next_broadcast_after(None, None, &sites, &preferred, after).unwrap();
        assert_eq!(next.to_rfc3339(), "2026-07-22T13:00:00+00:00");

        // 全无时间源 → None。
        let empty: &[BroadcastSite<'_>] = &[];
        assert!(next_broadcast_after(None, None, empty, &preferred, after).is_none());

        // begin-only：未来的一次性播出。
        let next = next_broadcast_after(
            Some("2026-09-12T10:30:00Z"),
            None,
            empty,
            &[],
            DateTime::parse_from_rfc3339("2026-09-01T00:00:00+08:00").unwrap(),
        );
        assert_eq!(next.unwrap().to_rfc3339(), "2026-09-12T10:30:00+00:00");
        // begin-only：已过期 → None。
        assert!(next_broadcast_after(
            Some("2026-09-12T10:30:00Z"),
            None,
            empty,
            &[],
            DateTime::parse_from_rfc3339("2026-09-13T00:00:00+08:00").unwrap(),
        )
        .is_none());

        // 周期支持 W（两周）。
        let next = next_broadcast_after(
            Some("2026-07-01T00:00:00Z"),
            Some("R/2026-07-01T00:00:00Z/P2W"),
            empty,
            &[],
            DateTime::parse_from_rfc3339("2026-07-02T00:00:00Z").unwrap(),
        );
        assert_eq!(next.unwrap().to_rfc3339(), "2026-07-15T00:00:00+00:00");
    }

    // -- 6. season_months -------------------------------------------------------

    #[test]
    fn season_to_month_mapping() {
        assert_eq!(season_months("WINTER"), [1, 2, 3]);
        assert_eq!(season_months("SPRING"), [4, 5, 6]);
        assert_eq!(season_months("SUMMER"), [7, 8, 9]);
        assert_eq!(season_months("FALL"), [10, 11, 12]);
        // 大小写/空白宽容；未知季节返回 0 占位。
        assert_eq!(season_months("winter"), [1, 2, 3]);
        assert_eq!(season_months(" FALL "), [10, 11, 12]);
        assert_eq!(season_months("unknown"), [0, 0, 0]);
    }

    // -- 7. FixtureBangumiClient 形状断言 ---------------------------------------

    #[test]
    fn fixture_client_shapes_match_contract() {
        let client = FixtureBangumiClient::new();

        // calendar：2 个星期分组。
        let calendar = block_on(client.get_calendar()).unwrap();
        assert_eq!(calendar.len(), 2);
        assert_eq!(calendar[0].weekday.en.as_deref(), Some("Mon"));
        assert_eq!(calendar[0].items.len(), 2);
        assert_eq!(calendar[0].items[0].id, 45678);

        // 季度分页：2 条。
        let season = block_on(client.get_season_subjects(2026, 7, 50, 0)).unwrap();
        assert_eq!(season.total, 2);
        assert_eq!(season.data.len(), 2);
        assert_eq!(season.data[0].id, 45678);
        assert_eq!(season.data[0].eps, Some(16));
        assert_eq!(season.data[0].rating.as_ref().and_then(|r| r.score), Some(8.2));

        // 集数：3 条，type 0/1/0。
        let episodes = block_on(client.get_subject_episodes(45678, 100, 0)).unwrap();
        assert_eq!(episodes.data.len(), 3);
        assert_eq!(episodes.data[0].ep_type, EpType::Main.as_u32());
        assert_eq!(episodes.data[1].ep_type, EpType::Sp.as_u32());
        assert_eq!(episodes.data[0].sort, Some(4.0));

        // 收藏：2 条；type 语义 3=Doing / 5=Dropped。
        let collections =
            block_on(client.get_user_collections("anilog_dev", 2, 30, 0)).unwrap();
        assert_eq!(collections.data.len(), 2);
        assert_eq!(
            collections.data[0].collection_type,
            SubjectCollectionType::Doing.as_u32()
        );
        assert_eq!(
            SubjectCollectionType::from_u32(collections.data[0].collection_type),
            Some(SubjectCollectionType::Doing)
        );
        assert_eq!(
            SubjectCollectionType::from_u32(collections.data[1].collection_type),
            Some(SubjectCollectionType::Dropped)
        );

        // 单条收藏 / 详情 / 角色 / 关联 / 用户。
        let collection =
            block_on(client.get_user_collection("anilog_dev", 45678)).unwrap();
        assert_eq!(collection.subject_id, 45678);
        assert_eq!(collection.ep_status, Some(3));
        let detail = block_on(client.get_subject_detail(45678)).unwrap();
        assert_eq!(detail.infobox.len(), 7);
        let characters = block_on(client.get_subject_characters(45678)).unwrap();
        assert_eq!(characters.len(), 2);
        assert_eq!(characters[0].relation, "主角");
        let related = block_on(client.get_subject_related(45678)).unwrap();
        assert_eq!(related.len(), 2);
        let profile = block_on(client.get_user_profile()).unwrap();
        assert_eq!(profile.username, "anilog_dev");
        assert_eq!(profile.user_group, Some(10));
        let connected = block_on(client.test_connection()).unwrap();
        assert_eq!(connected.id, profile.id);

        // 写方法 204 无响应体 → Ok(())。
        let payload = json!({"type": SubjectCollectionType::Doing.as_u32()});
        assert!(block_on(client.update_collection(45678, &payload)).is_ok());
        assert!(
            block_on(client.update_episode_progress(98765, EpisodeCollectionType::Watched))
                .is_ok()
        );
        assert!(
            block_on(client.update_episode_progress_batch(
                45678,
                &[98765, 98766],
                EpisodeCollectionType::Watched
            ))
            .is_ok()
        );
    }

    #[test]
    fn fixture_client_stub_error_matches_http_status() {
        let unauthorized = FixtureBangumiClient::stub_error(401);
        assert!(matches!(unauthorized, BangumiApiError::Unauthorized { .. }));
        let limited = FixtureBangumiClient::stub_error(429);
        match limited {
            BangumiApiError::RateLimited { retry_after, .. } => {
                assert_eq!(retry_after, Some(StdDuration::from_secs(120)));
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }

    // -- 8. BangumiSyncSettings 序列化键集合 ------------------------------------

    #[test]
    fn bangumi_sync_settings_serializes_exactly_eight_keys() {
        let value = serde_json::to_value(BangumiSyncSettings::default()).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("settings must serialize to an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "apiBaseUrl",
                "conflictPolicy",
                "preferredBroadcastSites",
                "pullCollections",
                "pullExternalStatus",
                "pushCompletedEpisodes",
                "pushLocalChanges",
                "syncEnabled"
            ]
        );
        // 默认值语义再断言一次（schema §3.1）。
        assert_eq!(value["apiBaseUrl"], "");
        assert_eq!(value["syncEnabled"], false);
        assert_eq!(value["pullCollections"], true);
        assert_eq!(value["pushLocalChanges"], false);
        assert_eq!(value["pushCompletedEpisodes"], false);
        assert_eq!(value["pullExternalStatus"], true);
        assert_eq!(
            value["preferredBroadcastSites"],
            json!(default_preferred_broadcast_sites())
        );
    }

    // -- 端点 URL / 枚举常量 ----------------------------------------------------

    #[test]
    fn endpoint_urls_follow_official_layout() {
        let base = BangumiBaseUrls {
            root: "https://api.bgm.tv".into(),
            v0: "https://api.bgm.tv/v0".into(),
        };
        assert_eq!(calendar_url(&base), "https://api.bgm.tv/calendar");
        assert_eq!(
            season_subjects_url(&base, 2026, 7, 50, 0),
            "https://api.bgm.tv/v0/subjects?type=2&year=2026&month=7&limit=50&offset=0"
        );
        // limit 上限 50。
        assert!(season_subjects_url(&base, 2026, 7, 500, 0).contains("limit=50"));
        assert_eq!(
            subject_detail_url(&base, 45678),
            "https://api.bgm.tv/v0/subjects/45678"
        );
        // 集数是 /v0/episodes，limit 上限 200。
        assert_eq!(
            subject_episodes_url(&base, 45678, 100, 0),
            "https://api.bgm.tv/v0/episodes?subject_id=45678&limit=100&offset=0"
        );
        assert!(subject_episodes_url(&base, 45678, 1000, 0).contains("limit=200"));
        assert_eq!(
            subject_characters_url(&base, 45678),
            "https://api.bgm.tv/v0/subjects/45678/characters"
        );
        assert_eq!(
            subject_related_url(&base, 45678),
            "https://api.bgm.tv/v0/subjects/45678/subjects"
        );
        assert_eq!(me_url(&base), "https://api.bgm.tv/v0/me");
        assert_eq!(
            user_collections_url(&base, "anilog_dev", 2, 30, 0),
            "https://api.bgm.tv/v0/users/anilog_dev/collections?subject_type=2&limit=30&offset=0"
        );
        assert_eq!(
            user_collection_url(&base, "anilog_dev", 45678),
            "https://api.bgm.tv/v0/users/anilog_dev/collections/45678"
        );
        // `-` 占位 = 当前 token 用户（官方 spec）。
        assert_eq!(
            update_collection_url(&base, 45678),
            "https://api.bgm.tv/v0/users/-/collections/45678"
        );
        assert_eq!(
            episode_progress_url(&base, 98765),
            "https://api.bgm.tv/v0/users/-/collections/-/episodes/98765"
        );
        assert_eq!(
            episode_progress_batch_url(&base, 45678),
            "https://api.bgm.tv/v0/users/-/collections/45678/episodes"
        );
    }

    #[test]
    fn collection_type_constants_match_official_semantics() {
        // 条目收藏：2 是 Done，不是 Doing。
        assert_eq!(SubjectCollectionType::Wish.as_u32(), 1);
        assert_eq!(SubjectCollectionType::Done.as_u32(), 2);
        assert_eq!(SubjectCollectionType::Doing.as_u32(), 3);
        assert_eq!(SubjectCollectionType::OnHold.as_u32(), 4);
        assert_eq!(SubjectCollectionType::Dropped.as_u32(), 5);
        assert_eq!(SubjectCollectionType::from_u32(2), Some(SubjectCollectionType::Done));
        assert_eq!(SubjectCollectionType::from_u32(6), None);
        // 单集进度：0 未收藏 / 1 想看 / 2 看过 / 3 抛弃。
        assert_eq!(EpisodeCollectionType::NotCollected.as_u32(), 0);
        assert_eq!(EpisodeCollectionType::Watched.as_u32(), 2);
        assert_eq!(EpisodeCollectionType::Dropped.as_u32(), 3);
        // 集数类型：0 本篇 / 1 SP / 2 OP / 3 ED / 4 预告 / 5 MAD / 6 其他。
        assert_eq!(EpType::Main.as_u32(), 0);
        assert_eq!(EpType::Preview.as_u32(), 4);
        assert_eq!(EpType::Other.as_u32(), 6);
        assert_eq!(EpType::from_u32(7), None);
    }

    // -- Token 存储 -------------------------------------------------------------

    #[test]
    fn memory_token_store_round_trip_and_validation() {
        let store = MemoryTokenStore::new();
        assert_eq!(store.load().unwrap(), None);
        store.store("  secret-token  ").unwrap();
        assert_eq!(store.load().unwrap(), Some("secret-token".into()));
        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
        assert!(matches!(
            store.store("   "),
            Err(TokenStoreError::Other(_))
        ));
    }

    #[test]
    fn unsupported_token_store_reports_platform_error() {
        let store = UnsupportedTokenStore;
        for error in [
            store.load().err().unwrap(),
            store.store("token").err().unwrap(),
            store.clear().err().unwrap(),
        ] {
            assert!(matches!(error, TokenStoreError::Platform(_)));
        }
    }
}
