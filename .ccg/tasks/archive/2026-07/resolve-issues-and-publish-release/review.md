# Review

## Review paths

- Required Antigravity review attempted on 2026-07-30; wrapper failed because `agy` is not installed or available in `PATH`.
- Required Claude review attempted in parallel on 2026-07-30; wrapper failed because `claude` is not installed or available in `PATH`.
- Fallback review used independent Codex backend/security and frontend/release review paths plus lead review of tracked and untracked changes.

## Critical

- Fixed: the single-instance callback could arrive before `AppContext` was managed. Activation is now queued in a process-level atomic and consumed after setup; window recovery also uses `try_state` instead of panicking.
- Fixed: upstream `tauri-plugin-single-instance` could observe the mutex before its message window existed and continue startup. A vendored 2.4.3 patch waits up to one second for the target and exits rather than starting duplicate workers.
- Fixed: Cargo allowed `standard` and `original` together. Compile-time guards now require exactly one edition feature.
- Release metadata claims remain conditional until the four final artifacts are rebuilt, signed, and verified; notes will receive hashes only after that gate.

## Warning

- Fixed: `localAiringWeekday` previously preferred `airingSchedule` whenever present, even when `nextAiringEpisode` contained an earlier valid future broadcast. It now chooses the earliest valid timestamp across both sources, with a regression test.
- Fixed: malformed non-boolean `showTrayIcon` patches are ignored instead of being persisted.
- Residual manual validation: packaged Windows single-instance recovery, rapid relaunch behavior, and upgrade installation require exercising the final NSIS installers.
- Residual manual validation: Android overwrite upgrades and background notification behavior require a physical device; static package, version, alignment, and signer checks are mandatory before publication.

## Info

- `showTrayIcon` migrates additively with a visible default and remains outside the WebDAV document.
- The single-instance plugin is registered first and only on Windows. Standard and Original keep distinct Tauri identifiers.
- Original retains Rust feature isolation, blank Bangumi configuration, and the existing edition tests.
- Release remains `v0.6.0-beta.2` with Android `versionCode=6`; it must be a GitHub Pre-release and must not replace `v0.5.0` as Latest.

## Verification

- Standard Rust: 19 tests passed.
- Original Rust: 18 tests passed.
- Combined `standard,original` Cargo feature selection is rejected at compile time.
- TypeScript type check passed.
- All 12 `test:*` scripts passed.
- All six renderer builds passed.
- Production dependency audit reported 0 vulnerabilities.
- Desktop/mobile browser layout and Weekday/All interaction were checked before final review.
- Packaged Windows binary stress test: 30 concurrent launches from a clean state left exactly one process.
- Both Windows NSIS installers report the expected product names and `0.6.0-beta.2` version.
- Both Android APKs use v2/v3 signatures, are 16 KiB zipaligned, and match the required signer fingerprint, package IDs, version name/code, minSdk 24, and targetSdk 36.
- `git diff --check` passed.

Verdict: critical findings fixed; approved for rebuilt packaging, subject to final artifact identity, signature, checksum, and release metadata verification.

## Publication

- CI run `30544857581` passed.
- Commit `1e6fed4` was tagged as `v0.6.0-beta.2`.
- GitHub Release was published as a Pre-release; `v0.5.0` remains Latest.
- All four uploaded assets were downloaded again and matched the published/local SHA-256 values.
- Issues #4, #5, and #6 were closed only after release verification.
