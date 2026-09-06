package io.anilog.android;

import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;

/**
 * bangumi-data 播出时间解析的 Java 版（Phase 4 任务 2）。
 *
 * 规则移植自 src-tauri/src/bangumi.rs 的 {@code next_broadcast_after} /
 * {@code parse_recurrence_rule} / {@code parse_period} / {@code parse_instant}
 * （播出 golden 向量 src-tauri/fixtures/bangumi/broadcast-vectors.json 与 Rust/JS 共享）：
 * <ul>
 *   <li>选时间源：按 preferred 站点顺序找第一个有 begin/broadcast 的站点；
 *       否则用条目级 begin/broadcast（select_broadcast_source 同义）；</li>
 *   <li>broadcast {@code R/<start>/P<nD|nW>}：从 start 起按周期步进找第一个
 *       严格晚于 after 的时刻（精确 UTC 算术、与星期无关）；</li>
 *   <li>只有 begin：begin &gt; after 时返回 begin，否则 null（电影等一次性播出）；</li>
 *   <li>全无 → null。</li>
 * </ul>
 */
final class Broadcast {
    /** 与 bangumi.rs MAX_RECURRENCE_STEPS 一致。 */
    static final int MAX_RECURRENCE_STEPS = 100_000;

    private Broadcast() {}

    /** 站点级时间源（bangumi.rs BroadcastSite 同构）。 */
    static final class Site {
        final String site;
        final String begin;
        final String broadcast;

        Site(String site, String begin, String broadcast) {
            this.site = site;
            this.begin = begin;
            this.broadcast = broadcast;
        }
    }

    /** 返回 [begin, broadcast]：命中站点时为站点级字段，否则条目级字段。 */
    static String[] selectSource(String begin, String broadcast, Site[] sites, List<String> preferred) {
        if (preferred != null && sites != null) {
            for (String name : preferred) {
                for (Site site : sites) {
                    if (site == null || !name.equals(site.site)) continue;
                    if ((site.begin != null && !site.begin.isEmpty())
                        || (site.broadcast != null && !site.broadcast.isEmpty())) {
                        return new String[]{site.begin, site.broadcast};
                    }
                }
            }
        }
        return new String[]{begin, broadcast};
    }

    /** 计算下一次播出时刻（严格晚于 after），返回 UTC Instant；无法解析返回 null。 */
    static Instant nextBroadcastAfter(
        String begin,
        String broadcast,
        Site[] sites,
        List<String> preferred,
        OffsetDateTime after
    ) {
        String[] source = selectSource(begin, broadcast, sites, preferred);
        if (source[1] != null && !source[1].isEmpty()) {
            Instant occurrence = nextRecurrence(source[1], after.toInstant());
            if (occurrence != null) return occurrence;
        }
        if (source[0] == null || source[0].isEmpty()) return null;
        Instant start = parseInstant(source[0]);
        if (start == null || !start.isAfter(after.toInstant())) return null;
        return start;
    }

    /** 解析 {@code R/<start>/P<nD|nW>} 并步进到第一个严格晚于 after 的时刻。 */
    static Instant nextRecurrence(String rule, Instant after) {
        String[] parts = parseRecurrenceRule(rule);
        if (parts == null) return null;
        Instant start = parseInstant(parts[0]);
        Duration step = parsePeriod(parts[1]);
        if (start == null || step == null) return null;
        Instant occurrence = start;
        for (int index = 0; index < MAX_RECURRENCE_STEPS; index += 1) {
            if (occurrence.isAfter(after)) return occurrence;
            occurrence = occurrence.plus(step);
        }
        return null;
    }

    /** 解析 {@code R/<start>/<period>} 为 [start, period] 字符串。 */
    static String[] parseRecurrenceRule(String rule) {
        if (rule == null) return null;
        String rest = rule.trim();
        if (!rest.startsWith("R/")) return null;
        rest = rest.substring(2);
        int separator = rest.indexOf('/');
        if (separator <= 0) return null;
        return new String[]{rest.substring(0, separator), rest.substring(separator + 1)};
    }

    /** 解析周期段：仅支持 {@code P<nD>} / {@code P<nW>}（与 Rust parse_period 一致）。 */
    static Duration parsePeriod(String period) {
        if (period == null) return null;
        String body = period.trim();
        if (!body.startsWith("P") || body.length() < 2) return null;
        body = body.substring(1);
        String digits = body.substring(0, body.length() - 1);
        String unit = body.substring(body.length() - 1);
        long count;
        try { count = Long.parseLong(digits); } catch (NumberFormatException ignored) { return null; }
        if (count < 0) return null;
        switch (unit) {
            case "D": return Duration.ofDays(count);
            case "W": return Duration.ofDays(count * 7L);
            default: return null;
        }
    }

    /** 解析 ISO8601 时间戳（含毫秒 / Z / 数字偏移），统一为 UTC Instant。 */
    static Instant parseInstant(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        if (trimmed.isEmpty()) return null;
        try {
            return OffsetDateTime.parse(trimmed).toInstant();
        } catch (RuntimeException ignored) {
            return null;
        }
    }
}
