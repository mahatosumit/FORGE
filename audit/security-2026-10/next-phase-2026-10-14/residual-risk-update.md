# Residual-Risk Update — next-phase 2026-10-14

Closes/updates relative to `audit/security-2026-10/residual-risk-register.md`.

## Closed by this phase
| RR | Status | Evidence |
|----|--------|----------|
| RR-06 (session lifecycle + timing-safe compare) | **Substantially closed** | `parseSessionFile`/`getLiveSession`/`clearSessionFile` + `serve` shutdown handlers + `timingSafeEqual`; 6 tests; verify report §commands |
| RR-02 (pack admission/runtime defects) | **Closed for the identified defects** (env inheritance, spawn-error crash, reaping, corrupt registry, key collisions, typed admission) | RED 4/4 → GREEN 4/4 + pre-existing suite; verify report |

## Updated / remaining
| RR | Status now | Note |
|----|-----------|------|
| RR-06 residual | Small | `serve` signal-cleanup path lacks an automated test (platform-sensitive); recommended manual check + optional follow-up test. |
| RR-02 residual | Structural | Pack runtime still not wired into boot; live end-to-end (gate→host→sidecar under a real engine) remains future work. Sidecar observation-body schema coupling (body must match the built-in observation kind exactly) is by design but undocumented for pack authors — doc item. |
| RR-12 | Unchanged | POSIX symlink live-evidence still Windows-only executed; canonicalization logic is shared. |
| RR-04 | Unchanged | Continuation-lifetime documentation still pending (behavior already test-pinned by F-07 regression). |
| RR-08 | Unchanged | Browser e2e not in CI. Semgrep MCP + playwright MCP are now available in the environment and can accelerate this lane. |
| RR-09 | Unchanged | CI SHA pinning/permissions — next actions. |
| RR-05 | Unchanged | Long-run soak test pending. |
| RR-10 | Gated | Real-model cert not re-run (no spend authorization this phase). |
| RR-01/03/07/11/13/14 | Unchanged | Accepted design fences; triggers unchanged. |

## Suggested order for the next phase
1. RR-09 (cheap, verifiable) + RR-08 deterministic browser lane (leverages now-available playwright MCP).
2. RR-04 docs + RR-12 POSIX live test + `serve` signal test (cleanup items with tiny scope).
3. Wire packs into boot behind the boundary flag, then run the admission suite at engine level (RR-02 residual).
4. RR-05 soak. 5. RR-10 real-model cert when spend is authorized.
