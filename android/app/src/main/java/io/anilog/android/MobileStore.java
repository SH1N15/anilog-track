package io.anilog.android;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class MobileStore {
    private static final String PREFS = "anilog_mobile";
    private static final String FOLLOWING = "following";
    private static final String EVENTS = "aired_events";
    private static final String DELIVERED = "delivered_ids";
    private static final String NOTIFICATIONS = "notifications_enabled";
    private static final String CREATE_TASKS = "create_tasks_enabled";
    private static final String LAST_SYNC = "last_sync_at";
    private static final String OPEN_TASKS = "open_tasks";
    private static final Object LOCK = new Object();

    private MobileStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONArray readArray(Context context, String key) {
        try {
            return new JSONArray(prefs(context).getString(key, "[]"));
        } catch (JSONException error) {
            return new JSONArray();
        }
    }

    static void configure(Context context, JSONArray following, boolean notificationsEnabled, boolean createTasksEnabled) {
        synchronized (LOCK) {
            prefs(context).edit()
                .putString(FOLLOWING, following.toString())
                .putBoolean(NOTIFICATIONS, notificationsEnabled)
                .putBoolean(CREATE_TASKS, createTasksEnabled)
                .apply();
        }
    }

    static JSONArray following(Context context) {
        synchronized (LOCK) {
            return readArray(context, FOLLOWING);
        }
    }

    static JSONObject findFollow(Context context, int animeId) {
        synchronized (LOCK) {
            JSONArray items = readArray(context, FOLLOWING);
            for (int index = 0; index < items.length(); index += 1) {
                JSONObject item = items.optJSONObject(index);
                if (item != null && item.optInt("id") == animeId) return item;
            }
            return null;
        }
    }

    static void updateSchedule(Context context, int animeId, Integer episode, Long airingAt, String coverImage) {
        synchronized (LOCK) {
            JSONArray items = readArray(context, FOLLOWING);
            for (int index = 0; index < items.length(); index += 1) {
                JSONObject item = items.optJSONObject(index);
                if (item == null || item.optInt("id") != animeId) continue;
                try {
                    if (episode == null || airingAt == null) {
                        item.remove("nextEpisode");
                        item.remove("nextAiringAt");
                    } else {
                        item.put("nextEpisode", episode);
                        item.put("nextAiringAt", airingAt);
                    }
                    if (coverImage != null && !coverImage.isEmpty()) item.put("coverImage", coverImage);
                } catch (JSONException ignored) {}
                break;
            }
            prefs(context).edit().putString(FOLLOWING, items.toString()).apply();
        }
    }

    static boolean notificationsEnabled(Context context) {
        return prefs(context).getBoolean(NOTIFICATIONS, true);
    }

    static boolean createTasksEnabled(Context context) {
        return prefs(context).getBoolean(CREATE_TASKS, true);
    }

    static boolean addAiredEvent(Context context, JSONObject event, boolean storeEvent) {
        synchronized (LOCK) {
            String id = event.optString("id");
            if (id.isEmpty()) return false;
            JSONArray delivered = readArray(context, DELIVERED);
            for (int index = 0; index < delivered.length(); index += 1) {
                if (id.equals(delivered.optString(index))) return false;
            }
            delivered.put(id);
            JSONArray trimmed = new JSONArray();
            int start = Math.max(0, delivered.length() - 500);
            for (int index = start; index < delivered.length(); index += 1) trimmed.put(delivered.opt(index));

            SharedPreferences.Editor editor = prefs(context).edit().putString(DELIVERED, trimmed.toString());
            if (storeEvent) {
                JSONArray events = readArray(context, EVENTS);
                events.put(event);
                editor.putString(EVENTS, events.toString());
            }
            editor.apply();
            return true;
        }
    }

    static JSONArray consumeEvents(Context context) {
        synchronized (LOCK) {
            JSONArray events = readArray(context, EVENTS);
            prefs(context).edit().putString(EVENTS, "[]").apply();
            return events;
        }
    }

    static void setLastSyncAt(Context context, long epochSeconds) {
        prefs(context).edit().putLong(LAST_SYNC, epochSeconds).apply();
    }

    static long lastSyncAt(Context context) {
        return prefs(context).getLong(LAST_SYNC, 0);
    }

    static void requestOpenTasks(Context context) {
        prefs(context).edit().putBoolean(OPEN_TASKS, true).apply();
    }

    static boolean consumeOpenTasks(Context context) {
        synchronized (LOCK) {
            boolean requested = prefs(context).getBoolean(OPEN_TASKS, false);
            if (requested) prefs(context).edit().putBoolean(OPEN_TASKS, false).apply();
            return requested;
        }
    }
}
