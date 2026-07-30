# Requirements

## Objective

Take over the current Tauri migration line, resolve every open GitHub issue, build the four Windows/Android Standard/Original artifacts, and publish `v0.6.0-beta.2` as a GitHub Pre-release while leaving `v0.5.0` as Latest.

## Functional scope

- Issue #4: enforce one running Windows process per edition; a second launch restores, recreates, and focuses the existing main window.
- Issue #5: group seasonal anime Monday through Sunday in the device time zone, with a final unscheduled group and a retained flat view.
- Issue #6: add a desktop-only persisted tray-icon visibility setting; hiding the icon must not disable background sync or notifications, and relaunching must remain a reliable recovery path.
- Correct stale review follow-ups: keep the verified Bangumi POST contract, correct issue numbering, and record Android version inheritance.
- Apply the low-risk reminder-time regex optimization with focused Rust coverage.

## Release scope

- Version: `0.6.0-beta.2`; tag: `v0.6.0-beta.2`; Android `versionCode`: `6`.
- Build Standard and Original Windows NSIS installers.
- Build, sign, and verify Standard and Original Android APKs with the existing release certificate.
- Preserve Standard/Original package separation and Original's complete Bangumi isolation.
- Preserve `electron/` and `android/` as the v0.5 rollback path.
- Publish as Pre-release and do not change the repository's Latest release.

## Acceptance criteria

- A second Windows launch never starts duplicate background workers and restores exactly one main window.
- Standard and Original can run simultaneously, one process per edition.
- Weekday grouping uses the first valid future schedule, falls back to `nextAiringEpisode`, and places missing schedules last.
- Search and filters apply before grouping; desktop/mobile layouts remain stable.
- Tray visibility survives restart and Original language changes, remains absent on Android and browser/Electron fallback, and never enters WebDAV data.
- Both Rust feature suites, all repository regression scripts, all renderer builds, production dependency audit, and diff checks pass.
- APK package IDs, version name/code, alignment, and signer fingerprint match release requirements.
- Release attachment hashes match the published release notes.

## Known constraints

- External antigravity and Claude CLI backends are unavailable on this machine; their wrapper calls fail because `agy` and `claude` are not installed. Two independent Codex research agents provide the implementation analysis fallback.
- Android publication is blocked if the existing private signing key cannot be located or accessed. The key, alias, passwords, and local paths must never be committed or documented.
