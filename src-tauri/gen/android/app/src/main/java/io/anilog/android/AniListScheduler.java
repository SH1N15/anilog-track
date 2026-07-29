package io.anilog.android;

import android.content.Context;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class AniListScheduler {
    private static final String ENDPOINT = "https://graphql.anilist.co";
    private static final String QUERY = "query MobileSchedules($ids: [Int]) { Page(page: 1, perPage: 50) { media(type: ANIME, id_in: $ids) { id coverImage { medium } nextAiringEpisode { episode airingAt } } } }";

    private AniListScheduler() {}

    static synchronized int sync(Context context) throws IOException, JSONException {
        Context appContext = context.getApplicationContext();
        NotificationScheduler.scheduleAll(appContext);
        JSONArray following = MobileStore.following(appContext);
        if (following.length() == 0) {
            MobileStore.setLastSyncAt(appContext, System.currentTimeMillis() / 1000L);
            return 0;
        }

        int updated = 0;
        for (int offset = 0; offset < following.length(); offset += 50) {
            JSONArray ids = new JSONArray();
            for (int index = offset; index < Math.min(offset + 50, following.length()); index += 1) {
                JSONObject follow = following.optJSONObject(index);
                if (follow != null && follow.optInt("id") > 0) ids.put(follow.optInt("id"));
            }
            if (ids.length() == 0) continue;
            JSONArray media = request(ids);
            for (int index = 0; index < media.length(); index += 1) {
                JSONObject item = media.optJSONObject(index);
                if (item == null) continue;
                int animeId = item.optInt("id");
                JSONObject next = item.optJSONObject("nextAiringEpisode");
                JSONObject cover = item.optJSONObject("coverImage");
                String coverImage = cover == null ? null : cover.optString("medium", null);
                if (next == null) {
                    MobileStore.updateSchedule(appContext, animeId, null, null, coverImage);
                    NotificationScheduler.cancel(appContext, animeId);
                } else {
                    MobileStore.updateSchedule(
                        appContext,
                        animeId,
                        next.optInt("episode"),
                        next.optLong("airingAt"),
                        coverImage
                    );
                    JSONObject follow = MobileStore.findFollow(appContext, animeId);
                    if (follow != null) NotificationScheduler.schedule(appContext, follow);
                }
                updated += 1;
            }
        }
        MobileStore.setLastSyncAt(appContext, System.currentTimeMillis() / 1000L);
        return updated;
    }

    private static JSONArray request(JSONArray ids) throws IOException, JSONException {
        JSONObject variables = new JSONObject().put("ids", ids);
        JSONObject payload = new JSONObject().put("query", QUERY).put("variables", variables);
        HttpURLConnection connection = (HttpURLConnection) new URL(ENDPOINT).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(20_000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "AniLog-Android/0.6.0-beta.1 (https://github.com/SH1N15/anilog-tracker)");
        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(body.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(body);
        }

        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        String response = readAll(stream);
        connection.disconnect();
        if (status < 200 || status >= 300) throw new IOException("AniList HTTP " + status);
        JSONObject root = new JSONObject(response);
        if (root.has("errors")) throw new IOException("AniList returned GraphQL errors");
        JSONObject data = root.optJSONObject("data");
        JSONObject page = data == null ? null : data.optJSONObject("Page");
        JSONArray media = page == null ? null : page.optJSONArray("media");
        if (media == null) throw new IOException("AniList returned invalid schedule data");
        return media;
    }

    private static String readAll(InputStream stream) throws IOException {
        if (stream == null) return "";
        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) output.append(line);
        }
        return output.toString();
    }
}
