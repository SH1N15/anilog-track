# Implementation Plan

## Layer 0 - Integration baseline

- Fetch `origin` and merge `origin/main` into `codex/tauri-migration`.
- Resolve the README-only conflict while retaining valid headings, stable-download links, and the Tauri beta warning.

## Layer 1 - Parallel implementation

### Frontend ownership

Files: `src/App.tsx`, `src/styles.css`, `src/utils.ts`, `src/types.ts`, `src/api.ts`.

- Add persisted `weekday` / `all` season layout mode.
- Group filtered anime Monday-first in local time, retain a final TBA group, and render semantic responsive sections.
- Add `showTrayIcon` to shared settings defaults/types and a Tauri-desktop-only accessible switch.
- Keep Android, browser preview, and legacy Electron from exposing a nonfunctional tray control.

### Rust ownership

Files: `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`.

- Register `tauri-plugin-single-instance` first on Windows and route activation through `request_show_main_window`.
- Add additive `showTrayIcon=true` state, make tray creation/recreation respect it, and update visibility after settings changes.
- Replace per-call reminder regex compilation with a static validator and add focused tests.

## Layer 2 - Release metadata

- Update npm, Cargo, Tauri, Gradle fallback, and Android network User-Agent versions to beta.2/code 6.
- Update README, maintainer/migration/releasing/review documents, and add `release-notes/v0.6.0-beta.2.md`.
- Keep Bangumi search as POST and document the live/API verification.

## Layer 3 - Verification and review

- Run Standard and Original renderer builds, Rust tests, all `test:*` scripts, production audit, and `git diff --check`.
- Run local browser visual/interaction checks at desktop and mobile widths.
- Run parallel antigravity + Claude review; if their CLIs remain unavailable, record the blocker and run two independent Codex review paths.
- Fix all Critical findings and relevant Warnings, then re-run affected checks.

## Layer 4 - Packaging and publication

- Build and stage both Windows NSIS installers with unique beta.2 names.
- Build Android Standard, immediately stage it, then build/stage Original under JDK 17.
- Sign both APKs outside the repository; verify certificate, package IDs, versionCode/versionName, zip alignment, and SHA-256.
- Insert final hashes into release notes, commit, push the migration branch, and verify PR status without merging it.
- Tag the verified commit, publish the four assets as a GitHub Pre-release with `make_latest=false`, validate downloads, then close issues #4, #5, and #6.
