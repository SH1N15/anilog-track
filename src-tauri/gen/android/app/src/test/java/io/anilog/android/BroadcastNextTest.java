package io.anilog.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.OffsetDateTime;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Broadcast golden 测试（Phase 4 任务 5）。
 *
 * 向量来源：直接读取仓库内的 src-tauri/fixtures/bangumi/broadcast-vectors.json
 * （只读引用，不复制到 test resources——保证与 Rust/JS 三层共享同一份 golden 向量，
 * 避免复制漂移；测试通过从 user.dir 逐级向上定位仓库根）。
 * 断言 Java 版 Broadcast.nextBroadcastAfter 与 expectedNextLocal 表示同一 UTC 时刻，
 * 且按 nowLocalISO 的时区偏移渲染一致（时区用向量自身的 offset，而非固定 Asia/Shanghai）。
 */
public class BroadcastNextTest {

    private static File locateVectors() {
        File dir = new File(System.getProperty("user.dir", ".")).getAbsoluteFile();
        for (int depth = 0; depth < 10 && dir != null; depth += 1, dir = dir.getParentFile()) {
            File candidate = new File(dir, "src-tauri/fixtures/bangumi/broadcast-vectors.json");
            if (candidate.isFile()) return candidate;
        }
        // 兜底：环境变量显式指定仓库根。
        String root = System.getenv("ANILOG_REPO_ROOT");
        if (root != null) {
            File candidate = new File(root, "src-tauri/fixtures/bangumi/broadcast-vectors.json");
            if (candidate.isFile()) return candidate;
        }
        throw new AssertionError("无法定位 src-tauri/fixtures/bangumi/broadcast-vectors.json（user.dir="
            + System.getProperty("user.dir") + "）");
    }

    private static JSONArray readVectors() throws Exception {
        File file = locateVectors();
        byte[] bytes = Files.readAllBytes(file.toPath());
        return new JSONObject(new String(bytes, StandardCharsets.UTF_8)).optJSONArray("vectors");
    }

    @Test
    public void goldenVectorsMatchJavaNextBroadcastAfter() throws Exception {
        JSONArray vectors = readVectors();
        assertNotNull("broadcast-vectors.json 应包含 vectors 数组", vectors);
        assertTrue("至少应有一个 golden 向量", vectors.length() >= 6);

        for (int index = 0; index < vectors.length(); index += 1) {
            JSONObject vector = vectors.optJSONObject(index);
            String name = vector.optString("name", "#" + index);
            OffsetDateTime nowLocal = OffsetDateTime.parse(vector.getString("nowLocalISO"));
            List<String> preferred = toStringList(vector.optJSONArray("preferredSites"));
            Broadcast.Site[] sites = toSites(vector.optJSONArray("sites"));
            String begin = nullableString(vector, "begin");
            String broadcast = nullableString(vector, "broadcast");

            Instant actual = Broadcast.nextBroadcastAfter(begin, broadcast, sites, preferred, nowLocal);
            OffsetDateTime expectedLocal = OffsetDateTime.parse(vector.getString("expectedNextLocal"));
            assertNotNull(name + "：应能解析出下一次播出", actual);
            assertEquals(name + "：与 expectedNextLocal 表示的 UTC 时刻一致",
                expectedLocal.toInstant(), actual);
            // 复活语义：同一时刻按向量 nowLocal 的偏移渲染，本地墙上时间必须一致。
            OffsetDateTime rendered = actual.atOffset(nowLocal.getOffset());
            assertEquals(name + "：按向量时区渲染的墙上时间一致",
                expectedLocal.toLocalDateTime(), rendered.toLocalDateTime());
            assertEquals(name + "：时区偏移一致", expectedLocal.getOffset(), rendered.getOffset());
        }
    }

    @Test
    public void recurrenceRuleSupportsOnlyDaysAndWeeks() {
        assertNotNull(Broadcast.parsePeriod("P7D"));
        assertNotNull(Broadcast.parsePeriod("P2W"));
        assertEquals(java.time.Duration.ofDays(14), Broadcast.parsePeriod("P2W"));
        assertEquals(java.time.Duration.ofDays(7), Broadcast.parsePeriod("P7D"));
        failUnlessNull(Broadcast.parsePeriod("PT30M"));
        failUnlessNull(Broadcast.parsePeriod("P"));
        failUnlessNull(Broadcast.parsePeriod(null));
        assertNotNull(Broadcast.parseRecurrenceRule("R/2026-07-08T13:00:22.000Z/P7D"));
        failUnlessRuleNull(Broadcast.parseRecurrenceRule("2026-07-08T13:00:22.000Z/P7D"));
        failUnlessRuleNull(Broadcast.parseRecurrenceRule(null));
    }

    private static void failUnlessNull(java.time.Duration duration) {
        if (duration != null) fail("仅支持 P<nD>/P<nW>：" + duration);
    }

    private static void failUnlessRuleNull(String[] rule) {
        if (rule != null) fail("非法 RRule 应返回 null");
    }

    /** Android/JSON.org 的 optString 会把 null 强转成 "null" 串；统一按 has+isNull 取值。 */
    private static String nullableString(JSONObject object, String key) {
        if (!object.has(key) || object.isNull(key)) return null;
        try {
            return object.getString(key);
        } catch (org.json.JSONException error) {
            return null;
        }
    }

    private static List<String> toStringList(JSONArray array) {
        List<String> list = new ArrayList<>();
        if (array == null) return list;
        for (int index = 0; index < array.length(); index += 1) {
            String value = array.optString(index, null);
            if (value != null) list.add(value);
        }
        return list;
    }

    private static Broadcast.Site[] toSites(JSONArray array) {
        if (array == null) return new Broadcast.Site[0];
        Broadcast.Site[] sites = new Broadcast.Site[array.length()];
        for (int index = 0; index < array.length(); index += 1) {
            JSONObject site = array.optJSONObject(index);
            if (site == null) continue;
            sites[index] = new Broadcast.Site(
                site.optString("site", null),
                nullableString(site, "begin"),
                nullableString(site, "broadcast"));
        }
        return sites;
    }

    @Test
    public void strictAfterSemanticsAndOneShotBegin() {
        OffsetDateTime now = OffsetDateTime.parse("2026-07-19T00:00:00+08:00");
        // 与参考时刻相同 → 不算“下一次”（严格晚于）。
        assertTrue(Broadcast.nextBroadcastAfter(
            "2026-07-19T00:00:00+08:00", null, new Broadcast.Site[0], Arrays.asList(), now) == null);
        // 晚于参考的一次性 begin 返回该时刻。
        Instant movie = Broadcast.nextBroadcastAfter(
            "2026-09-12T10:30:00Z", null, new Broadcast.Site[0], Arrays.asList(), now);
        assertEquals(OffsetDateTime.parse("2026-09-12T10:30:00Z").toInstant(), movie);
    }
}
