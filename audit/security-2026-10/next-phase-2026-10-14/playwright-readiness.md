# Playwright / browser-automation readiness (RR-08 CI lane) — 2026-10-14

Verification only. No server started, e2e script not executed, no source modified.

## 1. Installed versions (verified read-only)

| Component | Value | How verified |
|---|---|---|
| `playwright-core` resolved path | `D:\quack pro\quack-current-worktree\node_modules\playwright-core\index.js` | `createRequire('D:/quack pro/quack-current-worktree/package.json').resolve('playwright-core')` via `node -e` |
| `playwright-core` installed version | `1.62.1` | `require('playwright-core/package.json').version` from same require context |
| `playwright-core` declared version | `1.62.1` (exact pin, dependencies or devDependencies of `quack-current-worktree/package.json`) | read-only `node -e` against package.json |
| Node | `v26.11.1` | `node --version` |
| Edge executable | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` exists (`Test-Path` = True) | PowerShell `Test-Path` |
| Edge version | `155.0.4283.45` (FileVersion = ProductVersion) | `(Get-Item ...).VersionInfo` |

Note on `--version` invocation: a plain `msedge.exe --version` while an Edge
instance is running prints `Opening in existing browser session.` (delegates to
the live instance, no version string). `msedge.exe --headless --disable-gpu
--version` printed nothing on this host. File metadata (`155.0.4283.45`) is the
authoritative version record here.

No installs, no downloads, no network performed.

## 2. Launch mechanism (`forge/scripts/e2e-ui.mjs`, 101 lines, read-only)

- Resolves `playwright-core` from the **sibling checkout** via
  `createRequire("D:/quack pro/quack-current-worktree/package.json")` (line 8–9),
  not from `forge/package.json`. FORGE has no independent browser-driver dep.
- Launches with `chromium.launch({ executablePath: EDGE, headless: true })`
  (line 21) where `EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"`
  (line 13) — hardcoded Windows-only system Edge. No `PLAYWRIGHT_*` env override,
  no channel selection, no bundled-Chromium fallback.
- Single context/page at 1440×900 (line 22). Error collector: `pageerror` events
  plus any response with HTTP status ≥ 400 (lines 23–25).
- Base URL derived from `D:/quack pro/forge/.forge/session.json` → `port`
  (lines 11–12). **Prereq (line 4): `npm run cli -- serve 3100` already running.**
  The script does no server startup and no readiness wait.
- Teardown: `await browser.close()` (line 97) on the happy path only — no
  `try/finally`, so an early throw leaks the browser process.

## 3. Assertion style

- Bespoke `check(name, ok, extra)` helper (lines 15–19): pushes `{name, ok}` to
  `results`, prints `PASS`/`FAIL` lines. Final tally `E2E: passed/total`, exit
  code 0 iff all pass (lines 99–101). No test runner (node:test/vitest/playwright
  test), no JUnit/XML reporter.
- DOM assertions via `page.evaluate` against element IDs/classes
  (`missionsCountBadge`, `topBarModelDisplay`, `#sidebarMissionsList .nav-item`,
  `#mission-view`, tab buttons) plus regex scans of `document.body.innerText`
  (lines 27–43, 57–58, 70–79, 87–88).
- Synchronization is fixed `waitForTimeout` sleeps (3000/1500/800/1200/9000/600 ms),
  with one event-based wait: `waitForResponse` for `POST /missions` (lines 50–53).
- Artifact capture: three full-page screenshots to fixed repo paths
  `forge/ui-2-mission.png`, `forge/ui-3-live.png`, `forge/ui-4-tabs.png`
  (lines 44, 59, 81). No trace, video, HAR, or per-failure artifacts; screenshots
  overwrite on every run.

## 4. What a CI lane (RR-08) would still need

1. **Browser install story.** Today: hardcoded system-Edge path on Windows.
   CI needs one of: (a) `npx playwright install --with-deps chromium` with
   bundled Chromium (reproducible, Linux-friendly), or (b) a documented
   `EDGE_EXECUTABLE_PATH` env override with fallback matrix (Edge channel /
   Chrome / bundled Chromium). Current script supports neither.
2. **Server startup + readiness.** The script assumes a live server and reads
   `session.json` for the port. CI must: spawn `serve` on an ephemeral port,
   poll `/` or a health endpoint with timeout, then run the driver; fail fast
   with logs on timeout. Also decide the `session.json` contract (currently an
   absolute-path read with no missing-file handling).
3. **Teardown hardening.** Wrap driver in `try/finally` (always `browser.close()`);
   track and kill the spawned server; ensure non-zero exit propagates without
   orphaned `msedge.exe` / node processes on Windows runners.
4. **Artifact capture.** Redirect screenshots (and add trace-on-failure / video
   or at minimum failure-only screenshots) into a run-scoped artifact dir
   (e.g. `artifacts/e2e/<run-id>/`), upload in CI, never overwrite repo files.
   Emit a machine-readable summary (JSON and/or JUnit) alongside PASS/FAIL text.
5. **Hermeticity / secrets.** The live-mission step (`submitPrompt`, 9 s stream
   wait) exercises the real model path — CI needs a stub/mock model endpoint or
   a flagged tiny-model run, otherwise the lane needs network + model credentials
   and inherits flake (fixed sleeps, timing-sensitive streaming assertions,
   `badgeAfter >= badgeBefore + 1 || true` tautology at line 55 that always passes).
6. **Cross-platform paths.** Absolute `D:/quack pro/...` paths in `createRequire`,
   `session.json`, and screenshot outputs break on any other agent/host. CI lane
   should resolve relative to repo root + env vars.
7. **Failure diagnostics.** Surface collected `pageErrors` as a structured list
   (currently joined into one line, truncated at 200 chars per error) and include
   console messages, not just `pageerror`/HTTP≥400.

## 5. Recommendation

**Ready for a local manual lane, not yet for CI.** The driver dependency
(`playwright-core@1.62.1`) and system Edge (`155.0.4283.45`) are present and the
script's mechanism is understood, so RR-08 can proceed to a hardening pass
first: env-overridable browser path + bundled-Chromium fallback, spawned server
with readiness gate, `try/finally` teardown, run-scoped artifacts + JSON/JUnit
summary, and a hermetic model stub for the submission step. After that, a trial
CI job (Windows runner with Edge + Linux runner with bundled Chromium) is
low-risk. Do not promote the script as-is: hardcoded host paths, external-server
prereq, leaky teardown, and repo-overwriting screenshots will flake or pollute
on shared runners.
