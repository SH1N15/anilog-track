# Frontend/Tauri analysis: issues #5 and #6

Research date: 2026-07-30. Scope is the current React + Tauri 2 path. `docs/REVIEW_FOLLOWUPS.md` was read as context only and was not changed.

GitHub's public issue pages confirm the current numbering:

- #5: `增加新番列表按星期几播出进行分组的功能` (empty issue body)
- #6: `可选隐藏托盘图标功能` (empty issue body)

`docs/REVIEW_FOLLOWUPS.md` is stale: it assigns #5 to the old multi-instance bug and #6 to weekday grouping, while its unnumbered tray item is the live #6. Do not use those numbers in release notes or issue-closing commits without correcting the mapping.

No `.ccg/spec/` files exist, so the repository-level `AGENTS.md` and maintainer handoff are the applicable conventions.

## Files Found

- `src/App.tsx:53-82` - renderer fallback state and persisted local UI state (`view`, `season`, `year`). This is the natural persistence boundary for a weekday/flat display mode.
- `src/App.tsx:295-426` - `SeasonView`; filtering happens in one `useMemo`, then one flat `.anime-grid` is rendered. This is the primary #5 implementation site.
- `src/App.tsx:680-725` - `SettingsView` derives `isAndroid` from runtime state and loads device settings.
- `src/App.tsx:819-850` - cross-platform notification settings; demonstrates inline `tr(zh, en)` localization and Android-only controls.
- `src/App.tsx:911-940` - Android and desktop behavior sections are already mutually exclusive. Add #6 only to the desktop branch at 919-927.
- `src/App.tsx:955-960` - `SettingRow` and accessible custom `Toggle` pattern (`role="switch"`, `aria-checked`). The switch still needs an accessible name because row text is not programmatically associated with it.
- `src/styles.css:63-104` - season toolbar, filters, five-column anime grid, and card dimensions.
- `src/styles.css:180-204` - settings row/toggle styles.
- `src/styles.css:234-309` - responsive breakpoints: 4 columns at 1120, 3 at 900, 2 at 680; Android safe-area rules are at 306-308.
- `src/types.ts:12-31` - `Anime` already exposes `nextAiringEpisode` and `airingSchedule.nodes[].airingAt`; no API type expansion is needed for #5.
- `src/types.ts:72-83` - shared `Settings` contract. A positive `showTrayIcon: boolean` field belongs here for #6.
- `src/utils.ts:61-69` - existing local-time formatting with `Intl.DateTimeFormat`; a weekday grouping/label helper should follow this pattern.
- `src/i18n.ts:4-16` - Standard is forced to Chinese; Original supports Chinese/English. Static UI text is localized inline with `tr`, not through a message catalog.
- `src/platform/tauri.ts:33-52` - generic `update_settings` bridge already carries `Partial<Settings>`; no new command is required.
- `src/api.ts:32-74` - browser/legacy renderer state defaults and additive settings merge. It must know any required new `Settings` field so all renderer builds still type-check and previews have a stable default.
- `src/api.ts:764-797` - browser settings update path. It can persist a new field but cannot control a native tray.
- `src-tauri/src/lib.rs:90-108` - Tauri state defaults; additive settings are migrated by `merge_defaults` at 111-135.
- `src-tauri/src/lib.rs:234-320` - state load/save. Settings are device-local in `anilog-state.json`; `runtime` is stripped before saving.
- `src-tauri/src/lib.rs:542-568` - WebDAV document explicitly contains only following, tasks, and following deletion tombstones. A tray preference must remain absent here.
- `src-tauri/src/lib.rs:698-707` - season query already fetches `nextAiringEpisode` and future-only `airingSchedule(notYetAired: true)`.
- `src-tauri/src/lib.rs:766-835` - season fetch/cache returns the AniList media array unchanged, including schedule data.
- `src-tauri/src/lib.rs:948-1019` - `update_settings` merges patches, reconciles autostart, saves, and rebuilds the tray only when language changes. #6 needs a tray-visibility side effect here.
- `src-tauri/src/lib.rs:2178-2226` - main-window create/show/focus path, reusable from tray, notifications, and a future second-instance callback.
- `src-tauri/src/lib.rs:2249-2265` - clicking a Windows toast already reopens the main window.
- `src-tauri/src/lib.rs:2273-2359` - tray labels and `setup_tray`; it removes and recreates tray id `main`, always visible today.
- `src-tauri/src/lib.rs:2472-2521` - desktop startup always creates a tray; `--hidden` autostart destroys the main window.
- `src-tauri/src/lib.rs:2548-2584` - close/minimize destroys the main window while the process remains when `minimizeToTray=true`.
- `src-tauri/src/mobile.rs:65-74` - only notification/task/language settings are sent to the Android plugin. Tray visibility should not be added.
- `src-tauri/src/mobile.rs:292-304` - legacy Android migration deliberately copies only mobile-relevant settings. It should remain unchanged.
- `scripts/test-window-lifecycle.cjs:1-101` - existing lifecycle regression style is Electron-only; it does not exercise Tauri tray behavior.
- `src-tauri/src/lib.rs:2690-2699,2909-2928` - existing Rust tests cover additive settings migration and localized tray labels; these are the closest #6 test anchors.
- `electron/main.cjs:57-77,133-151,777-811` - v0.5 fallback has its own settings/tray implementation. Because `App.tsx` is shared, either hide the new row outside Tauri or implement equivalent Electron behavior; otherwise the stable fallback advertises a non-working setting.

## Dependencies

### #5 weekday grouping

```text
AniList `airingAt` Unix seconds
  -> Rust SEASON_QUERY / season cache (unchanged payload)
  -> tauriApi.fetchSeason(): Anime[]
  -> App.loadSeason / season-updated event
  -> SeasonView filters visible items
  -> local-time weekday grouping
  -> one semantic group section + anime grid per weekday
```

Recommended ownership:

- `src/utils.ts`: pure functions for choosing a representative airing timestamp, mapping it to a local weekday key, producing localized labels, and grouping while preserving input order.
- `src/App.tsx`: display-mode control, local persistence, empty/loading states, and group rendering.
- `src/styles.css`: unframed group sections/headings and responsive spacing; retain the existing card grids.

No Rust response-shape change is required for the live/current season. The query is future-only, however, so historical seasons will commonly place finished titles in `TBA`; see Risks.

### #6 tray visibility

```text
SettingsView desktop switch
  -> DesktopApi.updateSettings(Partial<Settings>)
  -> Tauri `update_settings`
  -> persisted settings in anilog-state.json
  -> tray id `main`.set_visible(...)

Startup / language change
  -> setup_tray reads both uiLanguage and showTrayIcon
  -> newly rebuilt tray preserves hidden/visible state

Hidden tray + closed window
  -> no renderer and no tray entry
  -> Start-menu/shortcut second launch MUST focus existing instance
  -> otherwise a second process is created and the first is unreachable
```

Use a positive `showTrayIcon` field, default `true`. Positive naming makes old state migration safe and makes an absent field mean the legacy visible behavior. `merge_defaults` already adds new settings to old Tauri state, so a state-version bump is unnecessary.

## Patterns

### Proposed #5 behavior

1. Offer a compact segmented display control: `按星期 / Weekday` and `全部 / All` (or `热度 / Popularity` if product wording should expose the current order). Default to weekday so the requested feature is visible; retain flat view for the existing popularity scan workflow.
2. Persist the display mode in the edition-specific `UI_STATE_KEY` beside view/season/year (`App.tsx:70-82,143-145`), not in backend settings. It is a renderer layout preference, works in browser preview and Android, and should not enter WebDAV.
3. Determine a title's group from the earliest valid future `airingSchedule.nodes[].airingAt`, falling back to `nextAiringEpisode.airingAt`. Ignore non-finite/non-positive values. If neither exists, use a final `TBA` group.
4. Convert with `new Date(airingAt * 1000).getDay()` so grouping matches the existing promise that times use the device's local timezone (`App.tsx:376`, `utils.ts:61-68`). Order Monday through Sunday, followed by TBA; preserve AniList popularity order within each group.
5. Do not infer a weekday from an incomplete AniList `startDate`. It has no timezone/time and can be only year/month; using it can silently report the wrong local broadcast day.
6. Generate visible weekday names using `Intl.DateTimeFormat(language, { weekday: 'long' })` and localize only the TBA/count strings through `tr`. This covers Standard Chinese and Original Chinese/English without a parallel dictionary.
7. Render each non-empty group as an unframed `<section aria-labelledby=...>` with an `h3`, item count, and the existing `.anime-grid`. Do not nest group containers as cards.
8. The display control should use `aria-pressed` (or radio semantics), explicit button type, visible focus treatment, and stable dimensions. Group headings must remain in the accessibility tree; color alone must not encode the day.
9. On <=680 px Android/mobile, keep two card columns and full-width group headings. Avoid horizontal weekday tabs that hide groups or create a second scrolling axis.

Edge cases:

- Sunday is JavaScript day `0`; explicit Monday-first ordering avoids accidental Sunday-first display.
- UTC timestamps near midnight can move to the prior/next weekday in the user's timezone; this is expected and should match the displayed card time.
- A delayed/special episode may move weekday. Using the next scheduled episode reflects the current actionable schedule rather than an obsolete premiere day.
- Empty `airingSchedule.nodes`, missing `nextAiringEpisode`, invalid timestamps, movies/OVA, and finished titles go to TBA.
- Filters/search apply before grouping. Empty groups are omitted. If all filtered results are empty, keep the existing global empty state.
- When `season-updated` replaces the array, recompute groups without resetting search, format, following-only, or display mode.
- A timezone change while the app is already open is uncommon; regroup on reload/focus is sufficient unless product explicitly requires live timezone-change handling.

### Proposed #6 behavior

1. Add a desktop-only `显示托盘图标 / Show tray icon` switch under `桌面行为 / Desktop behavior`. Description when enabled can identify the tray restore/menu path; when disabled it must say the window can be reopened from the Start menu/shortcut.
2. Hiding the icon should not disable background AniList/WebDAV sync or notifications. It is visibility only, not a background-mode toggle.
3. Keep `minimizeToTray` independent: users may close the window and retain a fully hidden background process. This requires a single-instance reopen path before release (see below).
4. In `update_settings`, normalize the new value to a boolean, save it, then call `app.tray_by_id("main").set_visible(show)`. If the tray is unexpectedly absent, recreate it through `setup_tray` rather than silently succeeding.
5. `setup_tray` must read visibility every time. Otherwise changing `uiLanguage` at `lib.rs:1013-1016` removes/recreates a hidden tray as visible.
6. Startup should create the tray in its persisted visibility state. Retaining the tray object while hidden is preferable to removing it because `set_visible(true)` can restore the same menu/event handlers.
7. Treat missing/non-boolean `showTrayIcon` as `true` in a small pure helper, even though `merge_defaults` normally fills it. This avoids a corrupt/legacy state unexpectedly hiding the only affordance.
8. Do not send this setting through `mobile::configuration_payload`, Android SharedPreferences/Keystore, or WebDAV. The Android settings branch remains unchanged and must not show a disabled Windows control.
9. Gate the row to the Tauri desktop runtime (`IS_TAURI_APP` plus desktop runtime), or implement the same feature in `electron/main.cjs`. Merely adding the shared row would expose a no-op in the retained v0.5 Electron fallback.
10. Give the switch an accessible name. The current `Toggle` has switch semantics but `SettingRow` text is not connected by `aria-labelledby`; adding a `label`/`aria-label` prop is a focused improvement and should be applied consistently to the desktop switches touched here.

Required recoverability policy:

- Preferred: add/enforce a Tauri single-instance mechanism whose second-instance callback runs `request_show_main_window`. Then a Start-menu/shortcut launch reliably restores the sole existing process whether the tray is shown or hidden. Register it before application setup so the second process never starts background loops.
- Notification activation is already a secondary restore path (`lib.rs:2249-2260`) but cannot be the only path because notifications may be disabled or no episode may air.
- If single-instance activation is not in this release's scope, do **not** ship the independent hidden-background combination. Safe fallback is to make effective `minimizeToTray` false and avoid `--hidden` startup while the tray is hidden, so closing exits and login launch opens a window. This is less faithful to the issue but prevents an unreachable process.

## Tests

### Automated #5

- Pure helper tests with a fixed process timezone: Monday, Sunday, UTC-to-local date rollover, DST boundary, invalid/zero timestamp, schedule-node ordering, `nextAiringEpisode` fallback, TBA, Monday-first order, and stable input/popularity order within a group.
- Filtering integration: search/format/following-only runs before grouping and omits empty groups.
- UI-state migration: malformed/old localStorage falls back safely; old records without display mode get the chosen default; Standard and Original keys remain separate.
- Build both renderers: `npm run build:tauri:web` and `npm run build:tauri-original:web`. Also build Android variants because the same `SeasonView` ships there.
- The repo has no React test runner. Prefer a small pure TypeScript helper test runnable under the repository's required Node 22, or add a focused test runner only if the task already accepts dependency/lockfile churn. Do not duplicate the grouping algorithm in a `.cjs` test fixture.

### Automated #6

- Rust `default_state`: Standard and Original default `showTrayIcon == true`.
- Rust `merge_defaults`: a legacy state lacking the field gains `true`, while explicit `false` survives migration/restart.
- Pure tray-visibility helper: missing, null, string, true, false values; only explicit false hides.
- Verify settings remain excluded from `document_from_state` so WebDAV payload shape does not change.
- Verify a language-triggered `setup_tray` preserves hidden state.
- If single-instance is added, unit/integration-test that second launch calls the shared show/focus route and does not start a second set of background workers.
- Run both Cargo editions because `lib.rs` is shared:
  - `cargo test --manifest-path src-tauri/Cargo.toml --features standard`
  - `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features original`

### Manual/visual acceptance

- Windows Standard and Original: toggle off hides immediately; toggle on restores immediately; restart retains both states; changing Original language while hidden does not reveal the icon.
- With `minimizeToTray=true` and tray hidden: close window, relaunch from shortcut, and confirm the same PID/window is restored; notification click also restores it.
- With login startup enabled and tray hidden: confirm background starts once and shortcut restore works. Confirm there is still a reliable exit path before installer upgrade/uninstall.
- Android Standard and Original: tray setting is absent; weekday sections fit 390 px width, use two stable card columns, respect safe areas, and do not overlap bottom navigation.
- Desktop screenshots at 1280x820 and minimum configured 940x640; verify long English weekday/TBA labels, focus outlines, and no filter/control wrapping overlap.
- Run `npm run test:editions` after the builds and `git diff --check`.

## Risks

### Critical / release blocking

- **Unreachable hidden process:** current Tauri has no demonstrated single-instance activation. `--hidden` destroys the window (`lib.rs:2516-2520`), close-to-tray destroys it (`2552-2567`), and hiding the tray removes the remaining deterministic UI. Launching again currently creates another process rather than restoring the first. #6 must ship with single-instance restore or the safe fallback policy above.
- **No Quit affordance:** tray menu `Quit` is currently the only explicit quit command while close-to-tray is enabled (`lib.rs:2341-2355`). A hidden-tray background process can block upgrade/uninstall until killed. Single-instance restore lets the user reopen Settings, but product may also need a visible in-app Quit command when the window is restored.

### Warning

- **Historical grouping quality:** Rust requests only not-yet-aired schedule nodes. Past/finished seasons will often collapse into TBA. If historical weekday grouping is an acceptance criterion, change the query to include schedules (and bump the season cache version) or obtain a reliable representative airing timestamp; that turns #5 into a backend/cache change with a larger payload.
- **Tray recreation regression:** current language changes call `setup_tray`, which removes and rebuilds the icon. Unless visibility is read inside `setup_tray`, a hidden icon reappears.
- **Shared renderer / legacy fallback:** `App.tsx` and `Settings` are shared by Tauri, browser, Android, and retained Electron builds. A Tauri-only native implementation must not leave an enabled no-op control in Electron.
- **Async setting failure:** `App` updates state only from the returned command result, but `update_settings` currently saves before all tray side effects. Define whether a `set_visible` failure rolls back the saved preference or returns a warning while retaining it; avoid UI/native state silently disagreeing.
- **Timezone expectations:** weekday labels are device-local, not Japan time. This matches current time display copy, but release notes should say local time if users may expect the Japanese broadcast day.
- **TBA-heavy formats:** movies, OVA, specials, unscheduled titles, and completed shows naturally lack a next airing. TBA must remain a first-class group, not silently omit those titles.

### Info

- Additive local settings do not require a state version bump because Rust and browser paths merge defaults.
- `airingSchedule` is already in the TypeScript contract and Tauri payload, so the normal live-season version of #5 can remain frontend-only.
- Neither feature changes following/tasks or WebDAV contracts. Settings and local UI preferences must remain device-local by project policy.
- Both features are edition-neutral. Original adds English copy/testing; Standard must continue to force Chinese and make no new Bangumi calls.
