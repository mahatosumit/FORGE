# Next-Phase Plan (after RR-09) — 2026-10-14

Ordered by the standing risk matrix; each item is a separate bounded phase with its own baseline and acceptance criteria.

1. **RR-08: deterministic browser lane** (P2). Input: `playwright-readiness.md`. Acceptance: hermetic stub (no creds/model), server readiness gate, de-hardcoded paths, run-scoped artifacts, and a demonstrated fail-then-pass cycle. Prove with a real CI execution before claiming coverage.
2. **RR-04 + RR-12 + serve-signal test** (P2, small). Document continuation semantics preserving F-07 behavior; obtain POSIX symlink evidence on Linux (CI or container); automate the `serve` shutdown test where feasible.
3. **RR-02 residual: pack boot wiring** (P3). Wire `PackManager` into boot behind the existing quarantine boundary; run the admission suite at engine level. Do NOT start this until RR-08 evidence exists (browser + engine lanes both green).
4. **RR-05 soak** (P3). Bounded long-mission fixture asserting `outputs`-map and journal growth ceilings.
5. **RR-10 real-model certification** (gated). Only with explicit spend authorization; the deterministic evidence above is prerequisite, not a substitute.

Do not combine these into one change. Do not declare pilot readiness until RR-02 boot integration and the trust-model gates each have explicit acceptance evidence.
