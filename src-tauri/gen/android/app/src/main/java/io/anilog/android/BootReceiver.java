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
        // Phase 4：开机后额外排一次性“网络可用即同步”，补齐周期任务之外的失同步窗口。
        BackgroundSync.enqueueNetworkCatchUp(appContext);
    }
}
