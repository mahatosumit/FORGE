# FORGE — Independent Security Audit Report

**Audit window:** 2026-10-13 → 2026-10-14 (local)
**Auditor:** independent agent audit session (adversarial role)
**Target:** `D:\quack pro\forge` source tree + isolated test instance (`audit/security-2026-10/tools/audit-server.mts`, port 3131, temp data/workspace). The user's live instance was **not running** during the audit (stale `session.json` remained from a prior serve; see RR-06). No user mission history was modified; recovery classification of all user missions remains `verified`.

## Executive summary

FORGE's *architectural* trust core held up well under probing: the proposal gate, capability enforcement, hash-chained ledger, secret-free prompts, and fail-closed defaults were exercised against authority smuggling, hostile hosts, traversal, injection and lifecycle abuse — and behaved fail-closed in every tested control case. Eight defects were confirmed; **three were materially significant (F-03 High, F-01 Medium-High, F-07 High-reliability)**, and all eight are **fixed and covered by 11 new behavioral regression tests** in `test/security/audit-2026-10-regressions.test.ts` (fail-before/pass-after verified for F-01/02/04/06/07; F-03 by live repro).

**Confidence:** High for the tested boundaries (HTTP trust boundary, local filesystem confinement, gate matching, ledger integrity semantics, console rendering). Medium for untested areas (packs sidecar runtime, container environment, long-run resource growth). No third-party systems were contacted except the npm advisory database (read-only) and no secrets were read, logged, or transmitted.

## Confirmed findings

| ID | Severity | Status | Summary |
|----|----------|--------|---------|
| F-03 | **High** | Fixed | Directory junction/symlink traversal escaped workspace confinement in *all* local effect seams (read, write, exec cwd). Gate returned `allow`; write landed outside the workspace. |
| F-01 | **Medium-High** | Fixed | No `Host`/`Origin` validation on the HTTP server → DNS-rebinding page could read the console-embedded bearer token (public `GET /`) and drive the full API. |
| F-07 | **High (reliability/integrity)** | Fixed | Ledger open-guard flagged *any* record after `mission.closed` as tampering → every legitimately continued mission (first-class directive reopen) failed with a false "journal corruption" 500, blocking resume. |
| F-02 | **Medium** | Fixed | Console shipped with zero security headers (no CSP, no frame denial, no nosniff) while hosting approval actions → clickjacking + no XSS containment. |
| F-08 | Low (latent) | Fixed | Unsafe DOM sinks: raw `e.message`/`res.error` into `innerHTML` (×3), unescaped `missionId` in inline `onclick` attributes, unvalidated deep-link `missionId`. Not reachable with attacker characters today (server echoes fixed strings — probed), fixed as defense-in-depth + ULID validation. |
| F-04 | Low | Fixed | Attached interpreter-eval forms (`node -e…`, `--eval=…`, `cmd /cecho`) bypassed the R4 detection with bare argv-prefix grants. |
| F-06 | Low | Fixed | IPv6 host patterns cross-matched *any* IPv6 host (`"[::1]".split(":")[0] === "["`), in both gate copies. |
| F-05 | Low | Fixed (via F-03) | Windows canonicalization aliases accepted as distinct names: ADS (`f.txt:stream`), trailing dot/space, drive-relative `C:foo`. |

Detailed evidence, reproduction and remediation for each are in `findings.json`, `reproduction-cases.md`, `remediation-log.md`.

## What withstood attack (selected evidence)

- **Authority/parser:** proposals carrying authority fields rejected (`rejected-schema`); malformed/truncated structured output fails loud (no silent drop — pinned in earlier session work and re-probed); hostile mission goal `<img onerror>` stored + rendered as **literal text** (playwright: 0 dialogs, 0 injected elements).
- **Gate matching:** `npm testevil` does not prefix-match `["npm","test"]`; `api.example.com.evil.com` does not match `api.example.com`; UNC/absolute/`../` rejected; every denial produced typed errors with no side effects.
- **HTTP auth:** unauthenticated/wrong-token/malformed requests → 401 on every route; the `?token=` query form works **only** on `/events`; no method-override handling; crafted IDs are never echoed in error bodies.
- **Ledger:** every user mission chain verifies; the forged-record attack (invalid hash appended post-closure) still fails closed after the F-07 fix (now via `verifyChain`, which is the correct layer).
- **Secrets:** provider keys resolved only at dispatch (`apiKeyEnvVar`), masked in config output; token comparison happens server-side only; no secret value appears in any audit artifact.

## Overall assessment

**Safe for isolated local use by a single operator; not yet safe to expose to other users or untrusted networks.** The remaining exposure is operational (single-principal auth model, no signing against root rewrite in the journal — documented design), not a defect found in this audit. See `residual-risk-register.md`.

Sources: `phase0-evidence.md`; live probe logs summarized in `reproduction-cases.md`; suite results: **453/453 pass**, lint PASS, build OK (post-fix, see `remediation-log.md` §Verification).
