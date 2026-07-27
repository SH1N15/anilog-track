package io.anilog.android;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class NotificationScheduler {
    static final String CHANNEL_ID = "episode_updates";
    private static final String ACTION_PREFIX = "io.anilog.android.AIRING.";

    private NotificationScheduler() {}

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        boolean english = "en-US".equals(MobileStore.uiLanguage(context));
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            english ? "Anime updates" : "番剧更新",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription(english ? "Notifications when new episodes air" : "新一集播出时显示通知");
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(channel);
    }

    static void scheduleAll(Context context) {
        JSONArray following = MobileStore.following(context);
        for (int index = 0; index < following.length(); index += 1) {
            JSONObject item = following.optJSONObject(index);
            if (item != null) schedule(context, item);
        }
    }

    static void schedule(Context context, JSONObject follow) {
        int animeId = follow.optInt("id");
        int episode = follow.optInt("nextEpisode");
        long airingAt = follow.optLong("nextAiringAt");
        if (animeId <= 0 || episode <= 0 || airingAt <= 0) {
            cancel(context, animeId);
            return;
        }
        if (airingAt <= System.currentTimeMillis() / 1000L) {
            handleAired(context, animeId, episode, airingAt);
            return;
        }

        Intent intent = new Intent(context, AiringAlarmReceiver.class)
            .setAction(ACTION_PREFIX + animeId)
            .putExtra("animeId", animeId)
            .putExtra("episode", episode)
            .putExtra("airingAt", airingAt);
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pending = PendingIntent.getBroadcast(
            context,
            animeId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()) {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, airingAt * 1000L, pending);
        } else {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, airingAt * 1000L, pending);
        }
    }

    static void cancel(Context context, int animeId) {
        if (animeId <= 0) return;
        Intent intent = new Intent(context, AiringAlarmReceiver.class).setAction(ACTION_PREFIX + animeId);
        PendingIntent pending = PendingIntent.getBroadcast(
            context,
            animeId,
            intent,
            PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE
        );
        if (pending == null) return;
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        alarms.cancel(pending);
        pending.cancel();
    }

    static void handleAired(Context context, int animeId, int episode, long airingAt) {
        JSONObject follow = MobileStore.findFollow(context, animeId);
        if (follow == null || follow.optInt("nextEpisode") != episode || follow.optLong("nextAiringAt") != airingAt) return;

        JSONObject event = new JSONObject();
        boolean english = "en-US".equals(MobileStore.uiLanguage(context));
        String title = follow.optString("displayTitle", english ? "Untitled anime" : "未命名番剧");
        try {
            event.put("id", animeId + "-" + episode);
            event.put("animeId", animeId);
            event.put("animeTitle", title);
            event.put("coverImage", follow.optString("coverImage", ""));
            event.put("episode", episode);
            event.put("airingAt", airingAt);
            event.put("createdAt", System.currentTimeMillis() / 1000L);
        } catch (JSONException ignored) {
            return;
        }

        boolean createTask = MobileStore.createTasksEnabled(context);
        boolean isNew = MobileStore.addAiredEvent(context, event, createTask);
        MobileStore.updateSchedule(context, animeId, null, null, null);
        if (isNew && MobileStore.notificationsEnabled(context)) showNotification(context, animeId, episode, title, createTask);
        BackgroundSync.enqueueImmediate(context);
    }

    private static void showNotification(Context context, int animeId, int episode, String title, boolean taskCreated) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;

        ensureChannel(context);
        Intent openApp = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("openTasks", true);
        PendingIntent contentIntent = PendingIntent.getActivity(
            context,
            animeId,
            openApp,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        boolean english = "en-US".equals(MobileStore.uiLanguage(context));
        NotificationCompat.Builder notification = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(english ? title + " has a new episode" : title + " 更新了")
            .setContentText(english
                ? "Episode " + episode + (taskCreated ? " has aired and was added to your watch tasks." : " has aired.")
                : "第 " + episode + (taskCreated ? " 集已播出，已加入待看任务。" : " 集已播出。"))
            .setAutoCancel(true)
            .setContentIntent(contentIntent)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_REMINDER);
        NotificationManagerCompat.from(context).notify((animeId + "-" + episode).hashCode(), notification.build());
    }
}
