package io.anilog.android;

import android.content.Context;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

final class BackgroundSync {
    private static final String PERIODIC_WORK = "anilog-periodic-schedule-sync";
    private static final String IMMEDIATE_WORK = "anilog-immediate-schedule-sync";

    private BackgroundSync() {}

    private static Constraints networkConstraints() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    static void schedulePeriodic(Context context) {
        WorkManager workManager = WorkManager.getInstance(context);
        if (MobileStore.following(context).length() == 0) {
            workManager.cancelUniqueWork(PERIODIC_WORK);
            workManager.cancelUniqueWork(IMMEDIATE_WORK);
            return;
        }
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(AniListSyncWorker.class, 6, TimeUnit.HOURS)
            .setConstraints(networkConstraints())
            .build();
        workManager.enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.UPDATE, request);
    }

    static void enqueueImmediate(Context context) {
        if (MobileStore.following(context).length() == 0) return;
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(AniListSyncWorker.class)
            .setConstraints(networkConstraints())
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(IMMEDIATE_WORK, ExistingWorkPolicy.KEEP, request);
    }
}
