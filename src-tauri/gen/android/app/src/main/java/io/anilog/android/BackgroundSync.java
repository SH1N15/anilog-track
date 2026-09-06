package io.anilog.android;

import android.content.Context;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

/**
 * WorkManager 调度纪律（Phase 4 任务 4）：
 * <ul>
 *   <li>周期任务默认 {@link ExistingPeriodicWorkPolicy#KEEP}；仅当设置里的间隔
 *       与上次已排度的间隔不同才 {@link ExistingPeriodicWorkPolicy#UPDATE}
 *       （幂等：反复调用不再重置周期起点）；</li>
 *   <li>{@link NetworkType#CONNECTED} 约束保留；following 为空时取消周期任务；</li>
 *   <li>失败退避：{@link BackoffPolicy#EXPONENTIAL}（WorkManager 最低 10 分钟）；</li>
 *   <li>single-flight：PERIODIC / IMMEDIATE / CATCH_UP 唯一 work name 互斥
 *       （SyncPlan.singleFlight 的实现载体）。</li>
 * </ul>
 */
final class BackgroundSync {
    private static final String PERIODIC_WORK = "anilog-periodic-schedule-sync";
    private static final String IMMEDIATE_WORK = "anilog-immediate-schedule-sync";
    private static final String CATCH_UP_WORK = "anilog-network-catch-up-sync";
    private static final int DEFAULT_INTERVAL_HOURS = 6;

    private BackgroundSync() {}

    private static Constraints networkConstraints() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    private static PeriodicWorkRequest periodicRequest(int intervalHours) {
        return new PeriodicWorkRequest.Builder(BackgroundSyncWorker.class, intervalHours, TimeUnit.HOURS)
            .setConstraints(networkConstraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.MINUTES)
            .build();
    }

    /** 幂等重排：仅间隔设置变化才 UPDATE，否则 KEEP（不打断既有周期节奏）。 */
    static void schedulePeriodic(Context context) {
        WorkManager workManager = WorkManager.getInstance(context);
        if (MobileStore.following(context).length() == 0) {
            workManager.cancelUniqueWork(PERIODIC_WORK);
            workManager.cancelUniqueWork(IMMEDIATE_WORK);
            workManager.cancelUniqueWork(CATCH_UP_WORK);
            return;
        }
        int interval = MobileStore.syncIntervalHours(context);
        if (MobileStore.scheduledIntervalHours(context) != interval) {
            workManager.enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.UPDATE, periodicRequest(interval));
            MobileStore.setScheduledIntervalHours(context, interval);
        } else {
            workManager.enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, periodicRequest(interval));
        }
    }

    static void enqueueImmediate(Context context) {
        if (MobileStore.following(context).length() == 0) return;
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(BackgroundSyncWorker.class)
            .setConstraints(networkConstraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.MINUTES)
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(IMMEDIATE_WORK, ExistingWorkPolicy.KEEP, request);
    }

    /** 开机/网络恢复后的一次性“网络可用即同步”（与周期任务互斥，KEEP 防重复入队）。 */
    static void enqueueNetworkCatchUp(Context context) {
        if (MobileStore.following(context).length() == 0) return;
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(BackgroundSyncWorker.class)
            .setConstraints(networkConstraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.MINUTES)
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(CATCH_UP_WORK, ExistingWorkPolicy.KEEP, request);
    }

    static int defaultIntervalHours() {
        return DEFAULT_INTERVAL_HOURS;
    }
}
