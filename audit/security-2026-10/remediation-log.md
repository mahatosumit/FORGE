# FORGE — Remediation Log

All changes were minimal, evidence-backed, and made after a reproduction existed. Pre-change copies of every modified file are in `backups/` (`.orig` suffix). No user mission data was modified. No security control was disabled.

## Change manifest (with before/after SHA-256 prefixes)

| File | Pre (`sha256[:20]`) | Post (`sha256[:20]`) | Change |
|---|---|---|---|
| src/environments/local.ts | 666600605F03B94E63… | A95ED9A4CF6C68B2F316… | F-03: canonical `absolute()` — realpath deepest existing ancestor, compare against canonical `realRoot`, reject Windows alias segments (ADS `:`, trailing `.`/` `, drive-relative). `resolveReal()` compares against `realRoot`. |
| src/ledger/ledger.ts | 9493213865E19514… | D82DD872DC1A5E3442EB… | F-07: closure-anchor guard no longer requires `mission.closed` to be the last record; it verifies `receipt.chainTip === closed.prevHash`. Post-closure continuation remains valid; forged records still fail via `verifyChain`. |
| src/api/server.ts | C852BFD0A53A770C… | 240DDA6D9D9FCC7AB1CF… | F-01: Host + Origin allowlists before routing (403 otherwise). F-02: CSP + X-Frame-Options + nosniff + no-store on console; nosniff + no-store on JSON. |
| src/api/webui.ts | 527E6BFA6C47402C… | 1B94FD333E766BD2D96E… | F-08: escapeHtml on all error strings entering innerHTML; receipt buttons use `data-mid` + `getAttribute`; `?missionId`/localStorage deep-link validated as `mis_[A-Za-z0-9]{10,40}`. |
| src/gate/gate.ts | F1EDA294A0A7ED6F… | 4AE3AD2AA3E681DA2DD6… | F-06: bracket-aware host extraction. F-04: attached interpreter-eval flag forms (`-eX`, `--eval=X`, `/cecho`) detected. |
| src/multi-agent/effective-authority.ts | 3511B78EC41D2C59… | E5D0CFA8D7B75CFE101A… | F-06 (second copy): bracket-aware host extraction. |
| test/security/audit-2026-10-regressions.test.ts | (new) | — | 11 behavioral regressions: F-01 ×3, F-02 ×1, F-03 ×2 (win-only), F-04 ×2, F-06 ×2, F-07 ×1. Each asserts attacker-visible behavior, not implementation text. |
| audit/security-2026-10/** | (new) | — | Audit deliverables, tools, evidence, backups. Excluded from the npm package (`files` allowlist unaffected). |

## Justification per fix
- **F-03 root fix over per-call patches:** every effect seam funnels through `absolute()`; canonicalizing there closes read/write/exec/mkdir/stat/search at once and keeps one enforcement point.
- **F-01 at the boundary:** even if a token leaked, foreign-origin/rebinding requests now die at the door; no change to the CLI/local clients (no Origin sent, loopback Host present).
- **F-07 semantic correction, not suppression:** the old guard's job (detect closure-body rewriting) is preserved; the wrong clause (post-closure continuity == tampering) removed. The existing F-04 forged-record test still passes because invalid records fail `verifyChain`.
- **F-02 headers:** CSP includes `'unsafe-inline'` script permission because the console is intentionally a single inline-script page; this still blocks external/remote script injection and all framing. Verified zero CSP violations under real Edge.
- **F-08:** all three sink classes fixed plus input-shape validation; UI e2e re-run green.

## Verification on the exact fixed tree
```
npm run typecheck   → exit 0
npm run lint        → PASS (effect seams confined to designated modules; no dynamic imports; no forbidden deps)
npm run build       → exit 0
npm test            → 453/453 pass, 0 fail  (442 pre-existing + 11 new security regressions)
```
Live isolated probes: RC-01..RC-08 all as specified in `reproduction-cases.md`. UI under CSP: `problems: none`.

## Deliberately not changed
- Token compare remains `===` (loopback-only threat model; timing attack over loopback on a 48-hex token is not a practical vector) — hardening registered as RR-06.
- `?token=` on `/events` retained (EventSource limitation), restricted to that route — verified 401 elsewhere.
- Directive-after-close remains allowed (first-class continuation); documented rather than restricted (RR-04 asks for docs).
- Session token embedded in console HTML retained; the rebinding path that made it dangerous is closed (F-01).
