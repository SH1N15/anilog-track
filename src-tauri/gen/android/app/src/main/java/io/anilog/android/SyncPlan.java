package io.anilog.android;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * 后台完整同步的七步编排计划（Phase 4 任务 1/5）。
 *
 * 纯 Java 逻辑、不依赖 Android runtime，便于 JUnit 断言步骤顺序与
 * original 无 Bangumi 的硬不变量（original 三层零 Bangumi 请求）。真正的
 * 执行在 {@link BackgroundSyncWorker}：按本计划顺序逐步执行，单步失败
 * 不阻断其余步骤。
 *
 * 七步语义：
 * <ol>
 *   <li>WEBDAV_MERGE：坚果云拉取 → Java 版 LWW 合并（SyncMerge）→ 本地写回 →
 *       远端缺内容时 PUT（If-Match/If-None-Match 沿用 WebDavClient）；</li>
 *   <li>MASTER_DATA_AND_AIRING_REFRESH：AniListScheduler.sync 为 anilistId 条目
 *       补充 nextAiringEpisode/封面（anilistId 条目补充）。standard 的 Bangumi
 *       主数据/收藏拉取在第 4 步（唯一的 Java 层 Bangumi 网络步骤）；</li>
 *   <li>NOTIFICATION_AND_TASK_DEDUPE：合并后的 airing 事件按 MobileStore
 *       delivered/seen 机制去重 + NotificationScheduler 重排；</li>
 *   <li>BANGUMI_COLLECTION_MARK（standard 且有 token 且 pullCollections）：拉取
 *       Bangumi 收藏并写入“建议”（建议追番/建议取消/ep_status 供补完成）——
 *       后台只标记不破坏，追番增删由前台 Rust 引擎（映射/hash/墓碑保护）
 *       在 run_full_sync 完成真实合并；</li>
 *   <li>WRITE_BACK_GUARD：显式空步骤。后台绝不执行写回（写回只在用户显式
 *       动作 / 前台 run_full_sync 进行，避免后台误写远端 Bangumi）；</li>
 *   <li>LOCAL_SYNC_STATUS：更新本地 lastFullSyncAt/lastWebDavSyncAt/
 *       lastBangumiSyncAt/lastScheduleSyncAt/lastSyncError（仅本地，绝不进
 *       WebDAV 文档）；</li>
 *   <li>RESCHEDULE：BackgroundSync.schedulePeriodic（幂等）+
 *       NotificationScheduler 重排。</li>
 * </ol>
 */
final class SyncPlan {
    enum Step {
        WEBDAV_MERGE,
        MASTER_DATA_AND_AIRING_REFRESH,
        NOTIFICATION_AND_TASK_DEDUPE,
        BANGUMI_COLLECTION_MARK,
        WRITE_BACK_GUARD,
        LOCAL_SYNC_STATUS,
        RESCHEDULE
    }

    private SyncPlan() {}

    /**
     * 生成七步计划。
     *
     * @param originalEdition     original edition：绝不包含 Bangumi 步骤（硬不变量 1）
     * @param webDavEnabled       坚果云同步开关（WebDavStore.enabled）
     * @param bangumiPullEnabled  standard 且 Keystore 有 token 且设置开启 pullCollections
     */
    static List<Step> steps(boolean originalEdition, boolean webDavEnabled, boolean bangumiPullEnabled) {
        List<Step> steps = new ArrayList<>();
        if (webDavEnabled) steps.add(Step.WEBDAV_MERGE);
        steps.add(Step.MASTER_DATA_AND_AIRING_REFRESH);
        steps.add(Step.NOTIFICATION_AND_TASK_DEDUPE);
        // original 三层零 Bangumi 请求：即使 bangumiPullEnabled 误传 true 也强制排除。
        if (!originalEdition && bangumiPullEnabled) steps.add(Step.BANGUMI_COLLECTION_MARK);
        steps.add(Step.WRITE_BACK_GUARD);
        steps.add(Step.LOCAL_SYNC_STATUS);
        steps.add(Step.RESCHEDULE);
        return steps;
    }

    /** standard 全量（WebDAV 开 + Bangumi 拉取开）。 */
    static List<Step> standardSteps() {
        return steps(false, true, true);
    }

    /** original 全量（WebDAV 开；Bangumi 强制排除）。 */
    static List<Step> originalSteps() {
        return steps(true, true, true);
    }

    /**
     * single-flight 标志：整条链必须串行、同一时刻至多一个同步在跑。
     * Worker 侧由 BackgroundSync 的唯一 work name（PERIODIC/IMMEDIATE/CATCH_UP
     * 互斥前缀 + ExistingWorkPolicy.KEEP / enqueueUniquePeriodicWork）保证。
     */
    static boolean singleFlight() {
        return true;
    }

    /** 展示辅助：步骤名列表（测试断言顺序用）。 */
    static List<String> names(List<Step> steps) {
        List<String> names = new ArrayList<>();
        for (Step step : steps) names.add(step.name());
        return names;
    }

    /** 防御性校验：original 计划内不得出现任何 Bangumi 步骤。 */
    static boolean containsBangumiStep(List<Step> steps) {
        return steps.contains(Step.BANGUMI_COLLECTION_MARK);
    }

    static List<Step> unmodifiableSteps(boolean originalEdition, boolean webDavEnabled, boolean bangumiPullEnabled) {
        return Arrays.asList(steps(originalEdition, webDavEnabled, bangumiPullEnabled).toArray(new Step[0]));
    }
}
