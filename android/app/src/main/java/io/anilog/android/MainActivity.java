package io.anilog.android;

import android.os.Bundle;
import android.content.Intent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        captureNotificationIntent(getIntent());
        registerPlugin(AniLogMobilePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureNotificationIntent(intent);
    }

    private void captureNotificationIntent(Intent intent) {
        if (intent != null && intent.getBooleanExtra("openTasks", false)) {
            MobileStore.requestOpenTasks(getApplicationContext());
            intent.removeExtra("openTasks");
        }
    }
}
