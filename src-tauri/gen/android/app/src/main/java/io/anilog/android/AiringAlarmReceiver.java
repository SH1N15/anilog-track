package io.anilog.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class AiringAlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        NotificationScheduler.handleAired(
            context.getApplicationContext(),
            intent.getIntExtra("animeId", 0),
            intent.getIntExtra("episode", 0),
            intent.getLongExtra("airingAt", 0)
        );
    }
}
