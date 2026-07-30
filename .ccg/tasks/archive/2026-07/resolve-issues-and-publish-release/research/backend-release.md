# Backend / Tauri / Release Analysis

Analyzed on 2026-07-30 from `codex/tauri-migration` at `06a9620`, with remote heads confirmed as `origin/main=4b73647` and `origin/codex/tauri-migration=06a9620`. This report is analysis only; no product source was changed.

## Files Found

- `src-tauri/src/lib.rs`: Rust shared core, settings validation, Bangumi HTTP client, Windows window recreation, tray/notification activation, and Tauri builder (`update_settings` at line 949, `bangumi_search` at 1437, `show_main_window` at 2179, `request_show_main_window` at 2205, `setup_tray` at 2307, `run` at 2473).
- `src-tauri/Cargo.toml`: Rust 1.85 floor, Tauri 2.11.3, edition features, and Windows dependencies. No single-instance dependency exists.
- `src-tauri/Cargo.lock`: root package version and future lock entry for any single-instance plugin.
- `src-tauri/tauri.conf.json`: canonical Tauri version, standard identifier, window definition, disabled CSP, NSIS config, and Android `versionCode=5`.
- `src-tauri/tauri.original.conf.json`: Original Windows product name, identifier, renderer path; inherits base version and Android versionCode.
- `src-tauri/tauri.android.conf.json`: generated Android platform overlay; makes the main window visible and inherits base versionCode.
- `src-tauri/tauri.android-original.conf.json`: Original Android overlay. Its `identifier` remains `io.anilog.android`; actual package ID is selected in Gradle.
- `src-tauri/gen/android/app/build.gradle.kts`: selects `io.anilog.android` versus `io.anilog.android.original` from `ANILOG_ANDROID_EDITION`, consumes generated Tauri version properties, and has no release signing configuration.
- `src-tauri/gen/android/app/tauri.properties`: ignored/generated current values (`versionName=0.6.0-beta.1`, `versionCode=5`); do not treat as source of truth.
- `src-tauri/gen/android/app/src/main/AndroidManifest.xml`: Android `singleTask` activity and min/platform behavior; issue #4 is Windows-specific.
- `src-tauri/gen/android/app/src/main/java/io/anilog/android/AniListScheduler.java`: hard-coded Android AniList User-Agent version at line 78.
- `src-tauri/gen/android/.gitignore`: already excludes `key.properties` and `keystore.properties`, but Gradle currently does not read them.
- `package.json`: canonical npm version and all four Tauri build scripts; Windows and Android edition environment/config wiring.
- `package-lock.json`: root version is duplicated at lines 3 and 9.
- `.github/workflows/ci.yml`: runs only for pushes to `main` and PRs targeting `main`; tests both Rust editions but does not package Windows/Android or verify signing.
- `scripts/test-window-lifecycle.cjs`: tests only the legacy Electron lifecycle, not the Tauri process singleton.
- `scripts/test-editions.cjs`: validates legacy edition packaging and built Original renderer content; it does not currently assert Tauri Android package/version inheritance.
- `docs/MAINTAINER_HANDOFF.md`, `docs/TAURI_MIGRATION.md`, `docs/RELEASING.md`: controlling release constraints. `RELEASING.md` body is primarily the old v0.5 Electron/Capacitor path.
- `docs/REVIEW_FOLLOWUPS.md`: user-edited follow-up list. It mislabels the singleton issue as #5 and incorrectly recommends GET for Bangumi search.
- `release-notes/v0.6.0-beta.1.md`: prior attachment names, verification claims, and SHA-256 baseline.
- `release/tauri-v0.6.0-beta.1/`: protected local backup of the four published beta.1 artifacts.

## Dependencies

### Windows startup and restoration call chain

`run()` (`src-tauri/src/lib.rs:2473`)

1. Reads `--hidden` at line 2476.
2. Registers log/opener/notification and desktop autostart plugins at lines 2477-2485.
3. Loads/manages `AppContext`, creates a hidden background native window, tray, and background workers at lines 2489-2515.
4. Calls `show_main_window()` for normal startup or destroys the configured main window for hidden startup at lines 2516-2520.
5. Tray left-click and menu Show invoke `request_show_main_window()` (`2331-2344`).
6. Windows toast activation schedules `request_show_main_window()` on the main thread (`2249-2260`).

`request_show_main_window()` first restores/shows/focuses an existing main WebView window. If it was destroyed on minimize/close, `AppContext.main_window_opening: AtomicBool` serializes recreation and calls `show_main_window()`. `show_main_window()` rebuilds from the configured `main` window, applies the release data directory on Windows, then unminimizes/shows/focuses it (`2179-2225`). This is the correct callback for a second process.

### Recommended issue #4 implementation

GitHub issue #4 is titled `BUG: Windows端应用已运行时仍可无限多次启动，生成多进程`. The local follow-up heading `[#5]` is stale; GitHub issue #5 is the weekday-grouping feature.

Use the official `tauri-plugin-single-instance` crate, currently `2.4.3` (Rust floor 1.77.2, Windows supported), scoped to Windows. Do not hand-roll a second mutex/FindWindow protocol: the plugin already uses a named Windows mutex plus a hidden `WM_COPYDATA` target, keys it from the Tauri identifier, forwards args/cwd to the first instance, and exits the second process after Tauri cleanup.

Required integration shape:

- Add `tauri-plugin-single-instance = "2"` under `[target.'cfg(target_os = "windows")'.dependencies]` in `src-tauri/Cargo.toml`; update `Cargo.lock` through Cargo.
- In `run()`, register it before every other plugin, as required by the plugin documentation.
- Gate registration with `#[cfg(target_os = "windows")]`, so Android is unchanged (the plugin does not support Android).
- Its callback should ignore untrusted/unused forwarded args and cwd and call the existing `request_show_main_window(app)` path. Do not create a second window implementation.
- Standard (`io.anilog.desktop`) and Original (`io.anilog.desktop.original`) identifiers naturally create separate singleton domains, so both editions can run side by side while each rejects duplicates.
- Do not enable the plugin's optional `semver` feature; that would separate singleton domains by version and could permit beta.1/beta.2 processes to coexist.

Recommended behavior: a second normal shortcut/taskbar launch exits promptly and restores/focuses the first instance whether its window is visible, minimized, destroyed-to-tray, or initially `--hidden`. It must not start a second AniList/WebDAV/reminder worker. Rapid repeated launches must still create at most one WebView window because `main_window_opening` remains the recreation guard.

One small startup race should be tested: the plugin creates its mutex before its hidden message window inside plugin setup. A second launch in that very short interval may find the mutex before the target window. The upstream Windows implementation only exits after `FindWindowW` succeeds. Stress-launch the packaged executable; if duplicates are observed, report upstream or add a narrow retry, not a separate incompatible singleton design.

### Follow-up: settings regex

`update_settings()` recompiles `^([01]\d|2[0-3]):[0-5]\d$` on every settings patch (`src-tauri/src/lib.rs:983-989`). Rust 1.85 supports `std::sync::LazyLock`.

Recommended change: define one module-level `static DAILY_TASK_REMINDER_TIME_RE: LazyLock<regex::Regex>` and use `!DAILY_TASK_REMINDER_TIME_RE.is_match(time)`. A small `is_valid_reminder_time()` helper would make unit tests direct. Preserve exact accepted values (`00:00` through `23:59`) and reset all malformed values, including `8:05` and `24:00`, to `20:00`.

This is low-risk performance cleanup, not a release blocker. Existing `scripts/test-daily-task-reminder.cjs` only tests the legacy Electron helper; add Rust-side cases if this code changes.

### Follow-up: Bangumi search method

Do **not** change `bangumi_search()` from POST to GET.

- Current code sends `POST {base}/search/subjects?limit=12&offset=0` with JSON `{keyword, sort: "match", filter: {type: [2]}}` (`src-tauri/src/lib.rs:1437-1452`).
- Bangumi's current official OpenAPI declares `post` for `/v0/search/subjects`, keeps `limit`/`offset` in query, and requires the JSON `keyword` body.
- A live official request with the current method/body returned HTTP 200 on 2026-07-30. A GET request to that path returned 404.
- Therefore the current official fallback at lines 1515-1518 is method-compatible. The review follow-up's GET recommendation would break it.

Recommended action: retain POST, correct `docs/REVIEW_FOLLOWUPS.md`, and if hardening is desired add a mock-server test that asserts method, query parameters, JSON body, and response decoding. Do not make CI depend on the live Bangumi service. This does not justify changing browser resolver version 4 or Rust resolver version 5.

### Follow-up: CSP

`src-tauri/tauri.conf.json:29` has `"csp": null`, so Tauri's CSP protection is disabled for both editions and platforms. The renderer loads only bundled scripts/styles, but cover and banner images are remote (`src/App.tsx:493`, `521`, `523`, `594`, `631`) and React uses inline style attributes for banner URLs.

A compatible policy should include at least:

- `default-src 'self' customprotocol: asset:`
- `connect-src ipc: http://ipc.localhost`
- `script-src 'self'` (Tauri appends bundle hashes/nonces at build time)
- `style-src 'self' 'unsafe-inline'` (required by current React inline styles)
- `img-src 'self' asset: http://asset.localhost https: data: blob:`
- `font-src 'self' data:`
- `object-src 'none'`, `base-uri 'self'`, `frame-src 'none'`

Using all `https:` image origins is more compatible with AniList CDN changes but less restrictive than pinning `https://s4.anilist.co`; either choice needs an explicit product decision. No remote script origin should be allowed.

Because `csp` also applies in dev unless `devCsp` is set, permit Vite's `http://127.0.0.1:5173` and `ws://127.0.0.1:5173` only in `devCsp`, or HMR/dev startup may break. Verify actual response CSP and browser console in release and dev builds on Windows and Android. CSP is a worthwhile renderer defense but has broader compatibility risk than LazyLock, so test both editions and all image/banner/detail/settings paths before release.

### Version sources for the next beta

The conservative next version is `0.6.0-beta.2`, tag `v0.6.0-beta.2`, Android `versionCode=6`.

Update and keep synchronized:

- `package.json:3`
- `package-lock.json:3,9`
- `src-tauri/Cargo.toml:3`
- root package entry in `src-tauri/Cargo.lock:97-99` (let Cargo regenerate)
- `src-tauri/tauri.conf.json:4`
- `src-tauri/tauri.conf.json:51` from 5 to 6
- `src-tauri/gen/android/app/build.gradle.kts:26-27` fallback literals, so direct Gradle builds cannot silently fall back to beta.1/code 5
- `src-tauri/gen/android/app/src/main/java/io/anilog/android/AniListScheduler.java:78`; preferably derive from `BuildConfig.VERSION_NAME` instead of future hard-coding
- `src-tauri/src/lib.rs:273` currently says `AniLog Tauri/0.5`; preferably derive from `env!("CARGO_PKG_VERSION")`
- new `release-notes/v0.6.0-beta.2.md`, README beta links, and current-version facts in maintainer docs after artifacts are final

Do not manually commit `src-tauri/gen/android/app/tauri.properties`; it is ignored and regenerated from merged Tauri config. Original inherits the base version/versionCode. Duplicating `versionCode` in `tauri.android-original.conf.json` creates a drift risk and is unnecessary; the beta.1 Original APK proves inheritance works.

## Patterns

- Reuse existing activation path: tray (`src-tauri/src/lib.rs:2331-2344`) and notification (`2249-2260`) both converge on `request_show_main_window()` (`2205-2225`). Second-instance activation should do the same.
- Keep build edition separation at every layer: `package.json:29-36`, Cargo features in `Cargo.toml:17-20`, Windows identifiers in the two Tauri configs, and Android `applicationId` selection in `build.gradle.kts:15,23`.
- Original Android's package name comes from `ANILOG_ANDROID_EDITION=original`, not the Android Tauri overlay identifier. The stored signed beta.1 Original APK is `io.anilog.android.original`.
- The Android version source flows `tauri.conf.json` -> generated `app/tauri.properties` -> `build.gradle.kts:26-27`. Both standard and Original consume the same value.
- Release artifacts are renamed/staged outside generated output paths. Both Android variants use the same generated universal APK path, so copy the standard result immediately before building Original.
- CI validates both Rust features (`.github/workflows/ci.yml:44-47`) but does not package, sign, inspect, or install artifacts; manual release gates are mandatory.
- Tauri beta builds use `tauri:build*` and `tauri:android:build*`; `dist:all` and old `android/` Gradle variants are v0.5 fallback paths only.

## Verified Baseline

The protected beta.1 backup matches `release-notes/v0.6.0-beta.1.md` exactly:

| Artifact | Verified identity | SHA-256 |
| --- | --- | --- |
| Standard Windows | Product `AniLog`, version `0.6.0-beta.1` | `DD8E1DD53C1A306E7BCBC29A38DB41230A694EFCEC434ADE6D57EDA768ACA317` |
| Original Windows | Product `AniLog Original`, version `0.6.0-beta.1` | `BCE87741A2A957D5E9869D10A2AECD532A236C3C6BFE8FEE6329DBCAB4B22B35` |
| Standard Android | `io.anilog.android`, code 5/name beta.1 | `6B1BA7EAC9BF997838839C0767585A8073BB1E5F4C72783C9D2D17A9C16E6FB1` |
| Original Android | `io.anilog.android.original`, code 5/name beta.1 | `3C45316203E3E83B8982B19CEF9BE637BF5AA3F85BD2F11FD491E5A7C8A700BE` |

Both beta.1 APKs verify with v2/v3 signatures, are zipaligned, have `minSdk=24`/`targetSdk=36`, and have the same required signer SHA-256:

`a20feecdff2c6489f634d1c30b5eb35873ca119ffde95f6b708ca474c6dface8`

This fingerprint is a verification baseline only; it cannot recover the private key.

## Tests and Release Gates

### Automated before packaging

Run under Node 22 and JDK 17 or 21:

1. `npm ci`
2. `npm run build:all`
3. `npm run build:android` and `npm run build:android-original`
4. `npm run build:tauri:web` and `npm run build:tauri-original:web`
5. `cargo test --manifest-path src-tauri/Cargo.toml --features standard`
6. `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features original`
7. All explicit `test:*` scripts in `package.json:42-52`
8. `npm audit --omit=dev --audit-level=high`
9. `git diff --check` and review that no secret/build/local state was added

There is no generic `npm test` script. Add a Tauri/Rust validation for reminder time if LazyLock is changed. A source-shape test can ensure the Windows singleton plugin is first and Windows-gated, but only packaged-process testing proves the behavior.

### Windows package and manual tests

Build serially and stage each result immediately:

- `npm run tauri:build`
- `npm run tauri:build:original`

Validate each NSIS installer from `src-tauri/target/release/bundle/nsis/`: product/edition, x64 architecture, version, install/upgrade/uninstall, state migration, data directory, and SHA-256. Windows installers are not commercially signed, so retain the SmartScreen/unknown publisher warning.

For issue #4, test standard and Original separately:

1. Visible first instance + second shortcut launch: one process, existing window focused.
2. Minimized/destroyed-to-tray first instance + second launch: one process, exactly one recreated main window.
3. `--hidden` first instance + normal launch: one process, main window shown.
4. 10-20 rapid concurrent launches: one background worker set and one main window.
5. Standard and Original launched together: one process per edition is allowed.
6. Notification click and tray click still restore after singleton integration.
7. Logoff/shutdown remains quiet.

### Android package, sign, and inspect

Pin environment to installed JDK 17 before either build; the current global `JAVA_HOME` is JDK 25 and is unsupported. SDK 36/36.1, NDK `27.2.12479018`, all four Android Rust targets, Tauri CLI 2.11.4, and adequate disk space are present.

Build standard, immediately copy its unsigned/universal output to a unique staging filename, then build and copy Original:

- `npm run tauri:android:build`
- `npm run tauri:android:build:original`

The tracked Gradle file contains no `signingConfigs`/`signingConfig`; repository builds cannot complete release signing unattended. The maintainer must supply the existing private key out-of-repo and sign the staged APKs (Android Studio or `apksigner`). Never record key path, alias, or password in source, task files, logs, or shell history.

For both final APKs run:

- `apksigner verify --verbose --print-certs`
- `aapt dump badging`
- `zipalign -c -P 16 -v 4`
- SHA-256 hashing

Require standard package `io.anilog.android`, Original `io.anilog.android.original`, versionName beta.2, versionCode 6, signer fingerprint exactly matching the baseline, `minSdk=24`, and `targetSdk=36`. Install over both v0.5.0 and beta.1 on a real device without uninstalling; confirm state migration, boot rescheduling, notification permission, AlarmManager/WorkManager behavior, Original network isolation, and WebDAV credential recovery.

## Migration PR Conflict Implications

PR #3 is open and contains the six migration commits. Current branch topology is one commit behind and six commits ahead of `main` (`git rev-list --left-right --count origin/main...HEAD` => `1 6`). `main` added README beta links after the migration branch diverged.

A local three-way `git merge-tree` shows one textual conflict only: `README.md`, where main added `- ### Tauri 2 测试版...` and the migration branch uses the corrected `### Tauri 2 测试版...` heading. No product source conflict currently exists. Resolve by retaining a valid level-3 heading and combining the useful beta warning/link text; do not lose the statement that v0.5.0 remains Latest.

The remote `refs/pull/3/merge` hash exists but is not present locally and may be a stale GitHub test ref; do not treat it as proof that current heads merge cleanly. Re-run merge/merge-tree against freshly fetched heads immediately before updating the PR.

Recommended implication for release: integrate current `main` into the migration branch before adding final release metadata, resolve README once, push so PR CI runs, and merge only after review. Build/tag the exact final `main` commit after merge, not an earlier branch commit, so released bytes correspond to the published tag. If main moves again, repeat the conflict/test check.

## Risks

### Critical / blockers

- **Android private key availability:** the repository has no signing key/config. Without the private key matching fingerprint `a20f...ace8`, no compatible Android update can be published. This is the hard external blocker.
- **JDK mismatch:** active Java/JAVA_HOME is JDK 25. Android build must explicitly switch both `JAVA_HOME` and leading `PATH` entry to installed JDK 17 (or 21).
- **Release authorization/state changes:** push, PR merge, tag, GitHub Release, issue closure, and changing Latest require explicit maintainer authorization. A beta/rc must be Pre-release; v0.5.0 remains Latest.

### Compatibility/security

- A Windows singleton must be keyed by edition identifier. A shared hard-coded mutex would incorrectly prevent Standard and Original from running together.
- A second process must activate the first; merely exiting produces poor UX and leaves hidden-autostart users unable to open the app.
- CSP can break IPC, Vite HMR, remote covers, and inline banner styles. Test a tailored release CSP and separate dev CSP; never allow remote scripts to solve a broken policy.
- Changing Bangumi search to GET is a confirmed regression against the official API. Keep POST.
- `src-tauri/tauri.android-original.conf.json` looks like a standard identifier, but changing it casually can disturb generated Tauri namespace/capability assumptions. Gradle's applicationId is the verified packaging authority for this project.
- Standard and Original Android outputs overwrite the same generated output location. Failing to stage immediately can publish two copies of the last-built edition.
- VersionCode 5 cannot be reused even with a new beta versionName; Android will reject/downgrade the update path.
- Windows packages remain unsigned and can trigger SmartScreen. Do not imply authenticity beyond GitHub source plus published SHA-256.
- CI does not build installers/APKs or exercise real process singleton behavior, signing, upgrades, notifications, or shutdown.
- Current Node is 24.18.0 while project policy is Node 22. Use Node 22 for reproducible install/build and lockfile stability.

## Recommended Release Sequence

1. Confirm the existing Android release key is available out-of-repo; stop before release work if it is not.
2. Fetch current heads, merge/rebase `main` into `codex/tauri-migration`, resolve the single README conflict, and re-run merge-tree.
3. Implement issue #4 with the Windows-gated official singleton plugin and reuse `request_show_main_window`; add focused tests.
4. Apply low-risk LazyLock cleanup. Keep Bangumi POST and correct the erroneous follow-up. Add/test CSP only if both desktop/mobile dev and release WebViews can be exercised in this cycle.
5. Run dual-model review required by task policy, fix critical/warning findings, and run the complete automated suite under Node 22.
6. Set `0.6.0-beta.2` consistently and Android versionCode 6; create release notes without final hashes yet.
7. Push the branch, require PR CI/review, then merge PR #3. Do not delete Electron/Capacitor fallback directories.
8. On the exact final main commit, rebuild Windows Standard/Original and Android Standard/Original under the pinned toolchains.
9. Sign both Android APKs with the existing release key, then verify identities, signer, versions, alignment, hashes, and upgrade paths. Complete Windows singleton/upgrade/shutdown manual tests.
10. Insert final attachment SHA-256 values into release notes and verify `git status` contains no binaries, credentials, local data, or signing paths.
11. Tag `v0.6.0-beta.2` at the exact verified commit and create a GitHub **Pre-release**, not Latest. Upload four uniquely named artifacts; never overwrite beta.1 assets.
12. Download each published attachment, re-hash it, inspect APK identity/signature again, verify README links, and only then close issue #4 with the verified release reference.
