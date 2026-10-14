# Implementation Report — Session/Extension Trust-Boundary Hardening (2026-10-14)

Phase: RR-06 + RR-02 (see `risk-priority-matrix.md`). All changes minimal, backed up in `backups/`, no security check weakened, no new dependencies.

## Changes (exact files, behavior before → after)

### 1. `src/api/server.ts` — timing-safe bearer comparison (RR-06)
- **Before:** `req.headers["authorization"] === \`Bearer ${token}\`` and `searchParams.get("token") === token` (timing-variable `===`).
- **After:** private `safeEqual()` = length check + `crypto.timingSafeEqual`; used for the header AND the `/events` query path. Behavior otherwise identical (verified by the unchanged F-01 auth suite: 401/403/200 matrix still green).

### 2. `src/cli/cli.ts` — session-file lifecycle (RR-06)
- **Before:** `getSession()` returned whatever `JSON.parse` produced; no shape validation. `forge run` wrote `session.json` and never removed it (two exit paths); `serve` never removed it on exit. Dead/stale files caused subsequent commands to make raw fetch calls against dead ports (audit observation; backup `backups/src_cli_cli.ts.orig`).
- **After:**
  - `parseSessionFile(raw)` — validated shape (port int 1..65535, token 48 lowercase hex, optional int pid); anything else ⇒ `null`.
  - `clearSessionFile(dir)` — idempotent removal.
  - `async getLiveSession(dir)` — uses the file only if `/health` answers 200 with the stored token within 1.2 s; otherwise clears the file and returns `null` (commands fall back to local execution paths instead of failing against a dead port).
  - `main` now starts with `await getLiveSession()`.
  - `run` clears the session file on both exit paths; `serve` installs `SIGINT`/`SIGTERM` handlers that clear the file, close the listener and exit.
- **Before/after evidence:** 6 new tests (`test/security/session-lifecycle.test.ts`) all green; stale-session behavior (dead port, wrong token, malformed file) previously unhandled by any test.

### 3. `src/packs/packs.ts` — extension admission/runtime hardening (RR-02)
- **Before:** registry `JSON.parse`d raw in the constructor (corrupt file ⇒ raw SyntaxError at boot); `enable`/lookups hit the prototype chain (`enable("constructor")` resolved an inherited function); manifest schema failures surfaced as raw `ZodError`; sidecars spawned with the FULL inherited process environment (provider keys included), inherited cwd, no `child.on("error")` handler (deleted entry ⇒ uncaught error event), no reaping (live child held the pack dir).
- **After:**
  - Typed admission: corrupt/invalid registry ⇒ `PackError` with remediation text; manifest JSON/schema failures ⇒ `PackError` with field path; unreadable content at activation ⇒ typed `PackError` (fail-closed before any dispatch).
  - Own-key registry (`Object.create(null)` + `Object.hasOwn` lookups) — `constructor`/`toString` can never resolve to inherited members; `__proto__` already schema-rejected.
  - Sidecar spawn: minimal env allowlist (`PATH`, `SYSTEMROOT`, `COMSPEC`, `PATHEXT`, `TMP`, `TEMP`), `cwd` = pack directory, `child.on("error")` ⇒ typed `PackError`, `stdin` EPIPE guard, bounded child reaping at every kill path, exit-before-response ⇒ typed `PackError`.
- **Before/after evidence:** `test/packs/packs-admission.test.ts` — RED 4/4 before the fix (captured in `%TEMP%\pack-red.tap`), GREEN 4/4 after; the 4 pre-existing packs tests stay green (child-reaping change also fixed their cleanup EPERM).

### 4. New tests
- `test/packs/packs-admission.test.ts` — 4 adversarial tests (env isolation + cwd, activation/spawn-race typed failures, corrupt registry, key-collision safety). No untrusted code executed: fixtures are protocol-valid minimal sidecars; malicious inputs only ever hit admission/registry paths.
- `test/security/session-lifecycle.test.ts` — 6 tests (shape matrix, malformed/stale/wrong-token clearing, live adoption, idempotent clear).

### 5. `src/cli/session.ts` extraction (this turn, behavior-preserving)
- **Before:** `ForgeSession` / `parseSessionFile` / `clearSessionFile` / `getLiveSession` / `FORGE_DIR` lived inline in `src/cli/cli.ts` (~800-line command module); the session-lifecycle test imported them from `cli.js`, pulling the whole CLI surface.
- **After:** new module `src/cli/session.ts` owns the RR-06 contract with its header comment; `cli.ts` imports `{ FORGE_DIR, getLiveSession, clearSessionFile }`; unused `rmSync` import dropped from `cli.ts`; `test/security/session-lifecycle.test.ts` imports from `session.js`. Zero logic changes — pure move.
- **Evidence:** typecheck exit 0; focused suites 14/14 (`session-lifecycle` 6 + `packs-admission` 4 + `packs` 4); full suite **463/463**, lint PASS, build exit 0 (`%TEMP%\full-after-extract.tap`).

## Deliberately untouched
Directive-after-close continuation (first-class, F-07 semantics), pack quarantine/enable policy, all gate/authority logic, console headers, canonical path confinement — no behavior change beyond the two risk items.
