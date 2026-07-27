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
import java.util.Calendar;
import org.json.JSONArray;
import org.json.JSONObject;

final class DailyTaskReminderScheduler {
    private static final String CHANNEL_ID = "watch_task_reminders";
    private static final int ALARM_REQUEST_CODE = 70001;
    private static final int NOTIFICATION_ID = 70002;

    private DailyTaskReminderScheduler() {}

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        boolean english = "en-US".equals(MobileStore.uiLanguage(context));
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            english ? "Watch task reminders" : "待看任务提醒",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription(english ? "Daily summaries of pending watch tasks" : "每日汇总尚未完成的待看任务");
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(channel);
    }

    static void schedule(Context context, boolean checkMissed) {
        cancel(context);
        if (!MobileStore.dailyTaskReminderEnabled(context)) return;

        Calendar now = Calendar.getInstance();
        Calendar target = targetFor(now, MobileStore.dailyTaskReminderTime(context));
        String today = dateKey(now);
        if (checkMissed
            && now.getTimeInMillis() >= target.getTimeInMillis()
            && !today.equals(MobileStore.lastTaskReminderDate(context))
            && showNotification(context)) {
            MobileStore.setLastTaskReminderDate(context, today);
        }

        Calendar next = target;
        if (next.getTimeInMillis() <= now.getTimeInMillis()) next.add(Calendar.DAY_OF_YEAR, 1);
        setAlarm(context, next.getTimeInMillis());
    }

    static void handle(Context context) {
        if (MobileStore.dailyTaskReminderEnabled(context)) {
            Calendar now = Calendar.getInstance();
            String today = dateKey(now);
            if (!today.equals(MobileStore.lastTaskReminderDate(context)) && showNotification(context)) {
                MobileStore.setLastTaskReminderDate(context, today);
            }
        }
        schedule(context, false);
    }

    private static boolean showNotification(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;

        JSONArray tasks = MobileStore.pendingTasks(context);
        int count = tasks.length();
        if (count == 0) return false;

        ensureChannel(context);
        boolean english = "en-US".equals(MobileStore.uiLanguage(context));
        Intent openApp = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("openTasks", true);
        PendingIntent contentIntent = PendingIntent.getActivity(
            context,
            NOTIFICATION_ID,
            openApp,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.InboxStyle details = new NotificationCompat.InboxStyle();
        int previewCount = Math.min(3, count);
        String firstLine = "";
        for (int index = 0; index < previewCount; index += 1) {
            JSONObject task = tasks.optJSONObject(index);
            if (task == null) continue;
            String title = task.optString("animeTitle", english ? "Untitled anime" : "未命名番剧");
            int episode = task.optInt("episode");
            String line = english ? title + " · Episode " + episode : title + " · 第 " + episode + " 集";
            if (firstLine.isEmpty()) firstLine = line;
            details.addLine(line);
        }
        if (count > previewCount) {
            details.setSummaryText(english ? (count - previewCount) + " more" : "另有 " + (count - previewCount) + " 集");
        }

        NotificationCompat.Builder notification = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(english
                ? count + (count == 1 ? " episode to watch" : " episodes to watch")
                : "今日还有 " + count + " 集待看")
            .setContentText(firstLine)
            .setStyle(details)
            .setAutoCancel(true)
            .setContentIntent(contentIntent)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_REMINDER);
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification.build());
        return true;
    }

    private static Calendar targetFor(Calendar now, String reminderTime) {
        String[] parts = reminderTime.split(":", 2);
        int hour = Integer.parseInt(parts[0]);
        int minute = Integer.parseInt(parts[1]);
        Calendar target = (Calendar) now.clone();
        target.set(Calendar.HOUR_OF_DAY, hour);
        target.set(Calendar.MINUTE, minute);
        target.set(Calendar.SECOND, 0);
        target.set(Calendar.MILLISECOND, 0);
        return target;
    }

    private static String dateKey(Calendar value) {
        return value.get(Calendar.YEAR) + "-" + value.get(Calendar.DAY_OF_YEAR);
    }

    private static PendingIntent alarmIntent(Context context, int flags) {
        Intent intent = new Intent(context, DailyTaskReminderReceiver.class)
            .setAction(context.getPackageName() + ".DAILY_TASK_REMINDER");
        return PendingIntent.getBroadcast(context, ALARM_REQUEST_CODE, intent, flags | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void setAlarm(Context context, long triggerAtMillis) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pending = alarmIntent(context, PendingIntent.FLAG_UPDATE_CURRENT);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()) {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pending);
        } else {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pending);
        }
    }

    private static void cancel(Context context) {
        PendingIntent pending = alarmIntent(context, PendingIntent.FLAG_NO_CREATE);
        if (pending == null) return;
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        alarms.cancel(pending);
        pending.cancel();
    }
}
