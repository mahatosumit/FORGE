# RR-09 Residual-Risk Update — 2026-10-14 (amended post-CI-observation)

## RR-09 status: CLOSED (with explicit caveat)
Acceptance criterion — workflows reviewed, SHA pins + permission change verified, behavior preserved, gaps recorded — is satisfied:
- Pins verified **in production**: both SHA-pinned actions downloaded and executed on all 3 OSes (run 38517345801); checkout/setup-node/npm-ci/typecheck/lint/build all green everywhere.
- `permissions: contents: read` proven sufficient by the same green infra steps (token perms logged as `Contents: read`).
- Behavior preserved: identical triggers/matrix/steps plus the required build step (missing-`dist/` diagnosis from run 38517045931).
- Remaining gap (red suite on CI) is a **distinct pre-existing condition**, not an RR-09 defect → tracked as RR-15 below. Overrule path: reopen RR-09 if any future run shows a pin/permission-caused failure.

## New item RR-15: CI-portability of environment-assuming tests (OPEN)
Six pre-existing tests fail on GitHub-hosted runners while passing on the dev machine; none is caused by RR-09. Per-test characterization (evidence: `evidence/ci-*.log`, run 38517345801):
1. `GATE B` process-tree termination (ubuntu, mac) — middle-child liveness after group kill; PID-reuse vs zombie-window undetermined. Needs Linux repro with `/proc` state before any product-code conclusion.
2. `FREEZE-001` docker-unavailable + `P2B-E02` docker.sock-absent (ubuntu) — precondition (no daemon) absent on runners. Skip-with-reason when daemon present.
3. `P2B-E04` metadata-refused (ubuntu, windows) — Azure IMDS answers on runners. Skip-with-reason or loopback-only assertion; gate-level coverage already exists (F-06).
4. `P2B-003` root-mounts (ubuntu, mac) — Windows root literals are plain filenames on POSIX; product correct. Make the root list platform-conditional (test-only fix).
5. packs-admission cwd (mac) — compare canonical realpaths (test-only fix).
Rule for the fixing phase: no weakening of security assertions to get green; skips must name the absent precondition; GATE B requires a genuine Linux repro first.

## Previous residual items (unchanged)
SHA freshness still decays (re-verify procedure in `sha-mapping.md`); no `actionlint` locally; real-CI evidence now EXISTS (this file + `verification-report.md` + `evidence/ci-*.log`), superseding the prior "unverified" note.
