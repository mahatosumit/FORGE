# FORGE — QA & Reliability Report

**Scope:** behavior observed during the 2026-10-13→14 audit plus targeted review of the existing 442-test suite. All post-fix gates were run on the exact fixed tree; hashes in `remediation-log.md`.

## Reproducible defects (fixed during audit)

| ID | Type | Repro | Impact | Regression test |
|----|------|-------|--------|-----------------|
| F-07 | Integrity-reporting false positive | close a mission (or use a continued mission) → `forge resume` / POST `/missions/:id/resume` → *"journal corruption at seq N: prev-hash-mismatch"* when `verifyChain` says OK | every continued mission could not be resumed; false tamper report eroded trust in the integrity layer itself | `F-07: post-closure continuation opens cleanly; forged post-closure record still fails` |
| F-03 | Confinement failure | junction inside workspace → read/write/exec through it | silently defeated the core "workspace confinement" invariant | `F-03: read/write/exec through a directory junction are blocked` |
| F-01/F-02 | HTTP trust boundary | spoofed `Host`/`Origin`; missing headers | rebinding token theft path; clickjacking of approvals | F-01/F-02 tests |

## Test-suite quality review (findings from reading, not just running)

- **Strengths:** failure matrix, crash boundaries, adversarial multi-agent suites, effect-boundary lint, tamper tests localize first broken seq; most negative paths assert typed failure, not just "throws".
- **Weak spots identified (now closed or registered):**
  1. No test previously asserted *post-closure continuation* semantics — the F-07 guard conflict went unnoticed because the only closure test forges an invalid hash (which `verifyChain` would catch anyway). *Closed.*
  2. No confinement test exercised symlink/junction traversal for the **lexical** `absolute()` path (only `../`, absolute, UNC). *Closed.*
  3. No HTTP-layer test asserted Host/Origin rejection or header presence. *Closed.*
  4. `catch {}` swallow blocks exist (dialogue cache, projections cleanup); none observed to hide effect changes, but lint cannot see them — registered RR-07.
  5. Two prior-session false-start classes (time-bombed fixtures, stale cert harness) were already remediated pre-audit; audit re-checked fixtures for date dependence (none found in the suites run).
  6. Browser e2e scripts live under `scripts/` and are not part of `npm test`; they are run manually (CI gap — RR-08).

## Reliability observations

- **Bounded everything (verified by reading + probes):** stage budgets (steps/tokens/wall-clock), model retries ≤3, no-progress rounds ≤6, credential cooldown 60 s map, 1 MiB request-body cap, 2 MiB output capture cap, exec timeouts with kill-tree, SSE streams cleaned on close.
- **Crash semantics** (`proposal.dispatched` before effect; post-effect-unknown requiring acknowledgment) are covered by the existing CRASH-002..015 matrix; not re-litigated.
- **Recovery classification** (read-only `forge recovery list`) correctly reports all user missions as non-resumable closed-verified; incomplete records include `effectsMayHaveOccurred` for interrupted dispatches.
- **Stochastic class (not a defect):** real-model certification passes/fails with model sampling on the tiny closure task; the engine failed closed and reported honest closures each time (one `verified` pass on record; failures were model-quality, not runtime bypass).
- **Not re-run:** real-model certification on the fixed build — skipped deliberately to avoid model spend (authorization boundary). The fixes do not touch the model loop; hermetic suite + isolated end-to-end used instead.

## Post-fix verification (exact results)

- `npm run typecheck` → exit 0
- `npm run lint` → PASS (effect seams confined)
- `npm run build` → exit 0
- `npm test` (full suite incl. 11 new security regressions) → **453/453 pass, 0 fail**
- Isolated-instance live probes: Host/Origin 403 / proper 200, full CSP present, directive-after-close 200 → resume 409 clean, junction repro blocked, UI under CSP: no violations, board/mission/receipt all render

## Recommended next reliability work (not done here)

1. Move `scripts/e2e-ui.mjs` into the suite as a tagged browser lane (RR-08).
2. Add a bounded soak test for `outputs` map + journal growth on long missions (RR-05).
3. Add continuation semantics to the state-machine documentation (RR-04).
