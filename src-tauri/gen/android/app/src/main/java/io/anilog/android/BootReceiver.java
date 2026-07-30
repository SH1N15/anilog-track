package io.anilog.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Context appContext = context.getApplicationContext();
        NotificationScheduler.ensureChannel(appContext);
        DailyTaskReminderScheduler.ensureChannel(appContext);
        NotificationScheduler.scheduleAll(appContext);
        DailyTaskReminderScheduler.schedule(appContext, true);
        BackgroundSync.schedulePeriodic(appContext);
    }
}
