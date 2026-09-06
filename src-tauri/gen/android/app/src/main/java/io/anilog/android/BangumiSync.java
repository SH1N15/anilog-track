package io.anilog.android;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.net.URLEncoder;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Java 版 Bangumi 收藏拉取（Phase 4 任务 3；standard 专用，original 绝不调用）。
 *
 * <p><b>分层取舍（架构决策）</b>：后台 Worker 承担“数据保鲜 + 通知不丢”；
 * 破坏性合并（追番增删、任务重键）留给前台 Rust 引擎。原因：后台 Java 层没有
 * 映射确认流、payload hash 引擎与墓碑保护，直接增删追番误删风险高。因此本类
 * 只做状态映射与“建议”标记，结果写入 MobileStore 供前台 run_full_sync 细化合并：
 * <ul>
 *   <li>type 3 doing → “建议追番”标记（不自动创建 following）；</li>
 *   <li>type 5 dropped → 本地存在时“建议取消”标记（不直接删，前台确认后
 *       只删未完成任务、已完成任务作为观看历史保留）；</li>
 *   <li>type 2 done → 记录 ep_status 供前台补完成（不新建、不改写历史）。</li>
 * </ul>
 *
 * <p>端点（schema §5）：{@code GET {v0}/me} → username →
 * {@code GET {v0}/users/{username}/collections?subject_type=2&limit=50} 分页（≤20 页）。
 * 双基址：配置为空用官方 {@code https://api.bgm.tv}（v0 前缀 {@code /v0}，与根路径
 * {@code /calendar} 分离）；反代以 {@code /v0} 结尾则原样作为 v0。token 绝不进日志。
 * 429/5xx/网络异常 → 抛出供 Worker 记 lastSyncError（无 token 内容），本轮不重试。
 */
final class BangumiSync {
    private static final String OFFICIAL_BASE = "https://api.bgm.tv";
    private static final int PAGE_SIZE = 50;
    private static final int MAX_PAGES = 20;

    private BangumiSync() {}

    static final class PullResult {
        int pages;
        int collections;
        int suggestionsAdded;
    }

    /** original 硬拒绝（双保险：SyncPlan 已排除该步骤）。 */
    static boolean isSupported() {
        return !BuildConfig.isOriginalEdition;
    }

    /** 拉取收藏并写入“建议”标记；只标记不破坏（见类注释）。JSONException 统一按失败处理。 */
    static synchronized PullResult pull(Context context) throws Exception {
        if (!isSupported()) throw new IOException("original 版不支持 Bangumi 同步");
        String token = BangumiTokenStore.load(context);
        if (token == null || token.isEmpty()) throw new IOException("Bangumi token 未配置");
        String v0 = resolveV0Base(MobileStore.bangumiApiBaseUrl(context));

        OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build();

        // /v0/me → username（读端点用 {username} 实名，schema §5）。
        JSONObject profile = getJson(client, v0 + "/me", token);
        String username = profile.optString("username", "").trim();
        if (username.isEmpty()) throw new IOException("Bangumi 用户资料缺少 username");
        String encoded;
        try {
            encoded = URLEncoder.encode(username, "UTF-8");
        } catch (java.io.UnsupportedEncodingException error) {
            throw new IOException("Bangumi 用户名编码失败");
        }

        PullResult result = new PullResult();
        JSONArray suggestions = new JSONArray();
        JSONArray existing = MobileStore.bangumiSuggestions(context);
        for (int index = 0; index < existing.length(); index += 1) {
            JSONObject item = existing.optJSONObject(index);
            if (item != null) suggestions.put(item);
        }

        for (int page = 0; page < MAX_PAGES; page += 1) {
            int offset = page * PAGE_SIZE;
            JSONObject payload = getJson(client,
                v0 + "/users/" + encoded + "/collections?subject_type=2&limit=" + PAGE_SIZE + "&offset=" + offset,
                token);
            JSONArray data = payload.optJSONArray("data");
            if (data == null) break;
            result.pages = page + 1;
            for (int index = 0; index < data.length(); index += 1) {
                JSONObject collection = data.optJSONObject(index);
                if (collection == null) continue;
                long subjectId = collection.optLong("subject_id", 0);
                if (subjectId <= 0) continue;
                int type = collection.optInt("type", 0);
                int epStatus = collection.optInt("ep_status", 0);
                result.collections += 1;
                String kind = suggestionKind(context, subjectId, type);
                if (kind == null) continue;
                if (hasSuggestion(suggestions, subjectId, kind)) continue;
                JSONObject suggestion = new JSONObject();
                suggestion.put("subjectId", subjectId);
                suggestion.put("kind", kind);
                suggestion.put("epStatus", epStatus);
                suggestion.put("at", System.currentTimeMillis() / 1000L);
                suggestions.put(suggestion);
                result.suggestionsAdded += 1;
            }
            if (data.length() < PAGE_SIZE) break;
        }
        MobileStore.setBangumiSuggestions(context, suggestions);
        return result;
    }

    /** 收藏 type → 建议种类；null = 无需标记。 */
    private static String suggestionKind(Context context, long subjectId, int type) {
        boolean followed = isFollowed(context, subjectId);
        switch (type) {
            case 3: return followed ? null : "suggest-follow";      // doing → 建议追番
            case 5: return followed ? "suggest-unfollow" : null;    // dropped → 建议取消（后台不删）
            case 2: return "episode-progress";                      // done → ep_status 供补完成
            default: return null;                                   // wish/on_hold 等不标记
        }
    }

    /** subjectId 是否已在本地追番（bangumi 来源条目 id 即 subjectId；也匹配显式 subjectId 字段）。 */
    private static boolean isFollowed(Context context, long subjectId) {
        JSONArray following = MobileStore.following(context);
        for (int index = 0; index < following.length(); index += 1) {
            JSONObject item = following.optJSONObject(index);
            if (item == null) continue;
            if (item.optLong("subjectId", 0) == subjectId) return true;
            if ("bangumi".equals(item.optString("source")) && item.optLong("id") == subjectId) return true;
        }
        return false;
    }

    private static boolean hasSuggestion(JSONArray suggestions, long subjectId, String kind) {
        for (int index = 0; index < suggestions.length(); index += 1) {
            JSONObject item = suggestions.optJSONObject(index);
            if (item != null && item.optLong("subjectId", 0) == subjectId && kind.equals(item.optString("kind"))) {
                return true;
            }
        }
        return false;
    }

    /**
     * 双基址解析（lib.rs resolve_base_urls 同义）：
     * 空 → 官方 root + {@code /v0}；配置以 {@code /v0} 结尾 → 原样为 v0；
     * 其他 → 配置 + {@code /v0}。根路径 {@code /calendar} 与本任务无关。
     */
    static String resolveV0Base(String configured) {
        String base = configured == null ? "" : configured.trim();
        if (base.isEmpty()) return OFFICIAL_BASE + "/v0";
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        if (base.toLowerCase(java.util.Locale.ROOT).endsWith("/v0")) return base;
        return base + "/v0";
    }

    private static JSONObject getJson(OkHttpClient client, String url, String token) throws IOException {
        Request request = new Request.Builder()
            .url(url)
            .header("Authorization", "Bearer " + token)
            .header("User-Agent", "AniLog Tauri/" + BuildConfig.VERSION_NAME)
            .header("Accept", "application/json")
            .get()
            .build();
        try (Response response = client.newCall(request).execute()) {
            int status = response.code();
            if (status == 401 || status == 403) throw new IOException("Bangumi 认证失败（HTTP " + status + "），请重新保存 token");
            if (status == 429) throw new IOException("Bangumi 限流（429），等待下个周期");
            if (status >= 500) throw new IOException("Bangumi 服务端错误（HTTP " + status + "）");
            if (status < 200 || status >= 300) throw new IOException("Bangumi 请求失败（HTTP " + status + "）");
            ResponseBody body = response.body();
            if (body == null) throw new IOException("Bangumi 响应为空");
            return new JSONObject(body.string());
        } catch (IOException | org.json.JSONException error) {
            // JSONException 也统一转 IOException：消息只含形状描述，绝不含 token。
            if (error instanceof IOException) throw (IOException) error;
            throw new IOException("Bangumi 响应解析失败");
        }
    }
}
