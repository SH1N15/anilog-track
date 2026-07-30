package io.anilog.android;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.Locale;

final class MobileStore {
    private static final String PREFS = "anilog_mobile";
    private static final String FOLLOWING = "following";
    private static final String EVENTS = "aired_events";
    private static final String PENDING_TASKS = "pending_tasks";
    private static final String DELIVERED = "delivered_ids";
    private static final String NOTIFICATIONS = "notifications_enabled";
    private static final String CREATE_TASKS = "create_tasks_enabled";
    private static final String LAST_SYNC = "last_sync_at";
    private static final String OPEN_TASKS = "open_tasks";
    private static final String UI_LANGUAGE = "ui_language";
    private static final String DAILY_TASK_REMINDER = "daily_task_reminder_enabled";
    private static final String DAILY_TASK_REMINDER_TIME = "daily_task_reminder_time";
    private static final String LAST_TASK_REMINDER_DATE = "last_task_reminder_date";
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

    static void configure(
        Context context,
        JSONArray following,
        JSONArray pendingTasks,
        boolean notificationsEnabled,
        boolean createTasksEnabled,
        boolean dailyTaskReminderEnabled,
        String dailyTaskReminderTime,
        String uiLanguage
    ) {
        synchronized (LOCK) {
            prefs(context).edit()
                .putString(FOLLOWING, following.toString())
                .putString(PENDING_TASKS, pendingTasks.toString())
                .putBoolean(NOTIFICATIONS, notificationsEnabled)
                .putBoolean(CREATE_TASKS, createTasksEnabled)
                .putBoolean(DAILY_TASK_REMINDER, dailyTaskReminderEnabled)
                .putString(DAILY_TASK_REMINDER_TIME, normalizeReminderTime(dailyTaskReminderTime))
                .putString(UI_LANGUAGE, normalizeUiLanguage(context, uiLanguage))
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

    static JSONArray pendingTasks(Context context) {
        synchronized (LOCK) {
            return readArray(context, PENDING_TASKS);
        }
    }

    static boolean dailyTaskReminderEnabled(Context context) {
        return prefs(context).getBoolean(DAILY_TASK_REMINDER, false);
    }

    static String dailyTaskReminderTime(Context context) {
        return normalizeReminderTime(prefs(context).getString(DAILY_TASK_REMINDER_TIME, "20:00"));
    }

    static String lastTaskReminderDate(Context context) {
        return prefs(context).getString(LAST_TASK_REMINDER_DATE, "");
    }

    static void setLastTaskReminderDate(Context context, String value) {
        prefs(context).edit().putString(LAST_TASK_REMINDER_DATE, value).apply();
    }

    static String uiLanguage(Context context) {
        return normalizeUiLanguage(context, prefs(context).getString(UI_LANGUAGE, ""));
    }

    private static String normalizeUiLanguage(Context context, String value) {
        if (!context.getPackageName().contains(".original")) return "zh-CN";
        String language = value == null || value.isEmpty() ? Locale.getDefault().getLanguage() : value;
        return language.toLowerCase(Locale.ROOT).startsWith("zh") ? "zh-CN" : "en-US";
    }

    private static String normalizeReminderTime(String value) {
        return value != null && value.matches("(?:[01]\\d|2[0-3]):[0-5]\\d") ? value : "20:00";
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

                JSONArray pendingTasks = readArray(context, PENDING_TASKS);
                boolean taskKnown = false;
                for (int index = 0; index < pendingTasks.length(); index += 1) {
                    JSONObject pendingTask = pendingTasks.optJSONObject(index);
                    if (pendingTask != null && id.equals(pendingTask.optString("id"))) {
                        taskKnown = true;
                        break;
                    }
                }
                if (!taskKnown) pendingTasks.put(event);
                editor.putString(PENDING_TASKS, pendingTasks.toString());
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
