package io.anilog.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class DailyTaskReminderReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        DailyTaskReminderScheduler.handle(context.getApplicationContext());
    }
}
