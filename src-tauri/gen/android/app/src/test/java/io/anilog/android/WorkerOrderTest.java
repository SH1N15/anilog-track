package io.anilog.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import java.util.List;

/**
 * Worker 七步编排测试（Phase 4 任务 5）。
 *
 * SyncPlan 是纯 Java 逻辑（不依赖 Android runtime），把七步编排从
 * BackgroundSyncWorker 抽出为可测单元：断言步骤顺序、single-flight 标志，
 * 以及 original 无 Bangumi 的硬不变量（硬不变量 1：Original 三层零 Bangumi 请求）。
 */
public class WorkerOrderTest {

    // ------------------------------------------------------------------
    // 七步顺序（standard 全量：WebDAV 开 + Bangumi 拉取开）
    // ------------------------------------------------------------------

    @Test
    public void standardPlanHasSevenStepsInFixedOrder() {
        List<String> steps = SyncPlan.names(SyncPlan.standardSteps());
        assertEquals(
            "[WEBDAV_MERGE, " +
            "MASTER_DATA_AND_AIRING_REFRESH, " +
            "NOTIFICATION_AND_TASK_DEDUPE, " +
            "BANGUMI_COLLECTION_MARK, " +
            "WRITE_BACK_GUARD, " +
            "LOCAL_SYNC_STATUS, " +
            "RESCHEDULE]",
            steps.toString());
        assertEquals(7, steps.size());
    }

    @Test
    public void planIsDeterministicAcrossCalls() {
        assertEquals(SyncPlan.names(SyncPlan.steps(false, true, true)),
            SyncPlan.names(SyncPlan.steps(false, true, true)));
        assertEquals(SyncPlan.names(SyncPlan.steps(true, false, false)),
            SyncPlan.names(SyncPlan.steps(true, false, false)));
    }

    // ------------------------------------------------------------------
    // original 无 Bangumi：即使 pull 开关误开，也不包含 Bangumi 步骤
    // ------------------------------------------------------------------

    @Test
    public void originalPlanNeverContainsBangumiSteps() {
        // 误传 bangumiPullEnabled=true 也必须排除（双保险在 BangumiSync.isSupported）。
        List<SyncPlan.Step> original = SyncPlan.steps(true, true, true);
        assertFalse(SyncPlan.containsBangumiStep(original));
        assertEquals(6, original.size());
        // original 无 Bangumi 主数据步骤：第 2 步仅 AniListScheduler.sync。
        assertEquals(SyncPlan.names(SyncPlan.steps(true, true, false)),
            SyncPlan.names(SyncPlan.steps(true, true, true)));
        assertFalse(SyncPlan.containsBangumiStep(SyncPlan.originalSteps()));
    }

    @Test
    public void bangumiStepRespectsTokenAndSettingFlags() {
        // standard 但未配置 token / 未开启 pullCollections：不排 Bangumi 步骤。
        assertFalse(SyncPlan.containsBangumiStep(SyncPlan.steps(false, true, false)));
        assertTrue(SyncPlan.containsBangumiStep(SyncPlan.steps(false, true, true)));
    }

    // ------------------------------------------------------------------
    // WebDAV 开关与 single-flight
    // ------------------------------------------------------------------

    @Test
    public void webDavDisabledSkipsMergeStepButKeepsRest() {
        List<String> steps = SyncPlan.names(SyncPlan.steps(false, false, true));
        assertFalse(steps.contains("WEBDAV_MERGE"));
        assertEquals(6, steps.size());
        assertEquals("MASTER_DATA_AND_AIRING_REFRESH", steps.get(0));
        assertEquals("RESCHEDULE", steps.get(steps.size() - 1));
    }

    @Test
    public void singleFlightFlagIsAlwaysOn() {
        // Worker 侧由唯一 work name（PERIODIC/IMMEDIATE/CATCH_UP）+ KEEP 策略实现。
        assertTrue(SyncPlan.singleFlight());
    }
}
