# FORGE — Residual Risk Register

Status legend: OPEN (accepted or pending), VERIFIED-SAFE (checked, no action needed), BLOCKED (could not test).

| ID | Item | Class | Status | Notes / trigger to revisit |
|----|------|-------|--------|----------------------------|
| RR-01 | No cryptographic signing of journals (root-level rewrite reconstruction possible by an attacker with disk write access) | Design limitation | OPEN (accepted) | Documented in the shipped threat model; entry condition already stated in `architecture/IMPLEMENTATION-BOUNDARY.md` ("signed journals — first external/compliance user"). Mitigations present: hash chain detects partial edits; closure anchor binds receipts. |
| RR-02 | Packs sidecar runtime (out-of-process quarantine protocol) not exercised live in this audit | Untested area | OPEN | Covered by existing no-bypass/quarantine test suite only. Revisit with a live sidecar smoke when a real pack ships. |
| RR-03 | Container environment requires Docker; local env is process-level governance, not an OS sandbox | Design limitation | OPEN (accepted) | An in-grant injected payload can still steer *in-grant* actions. Grants bound the blast radius; this is the documented v1 posture. |
| RR-04 | Directive continuation semantics undocumented in state machines | Documentation gap | OPEN | The API allows (and the UI uses) post-closure directives that append plan/stage records; F-07 fixed the conflict, but STATE-MACHINES/MISSION docs should name the continuation lifecycle explicitly. |
| RR-05 | `LocalEnvironment.outputs` capture map grows per exec within a store lifetime; journal grows unbounded per mission | Resource growth | OPEN (bounded in practice) | Single-process, bounded by mission lifetime; no leak observed. A soak test is recommended before long unattended runs. |
| RR-06 | Token comparison is not timing-safe; token embedded in console HTML; `.forge/session.json` persists after server exit | Hardening | OPEN (low) | Loopback-only threat model; F-01 removed the practical browser path. Consider `timingSafeEqual` + deleting `session.json` on close in a future hardening pass. |
| RR-07 | `catch {}` swallow blocks (dialogue cache writes, temp cleanup) could hide future effect regressions | Maintainability | OPEN | None observed to conceal effect changes in this audit; lint cannot see them. |
| RR-08 | Browser e2e (`scripts/e2e-ui.mjs`, audit UI verifier) not wired into `npm test`/CI | CI gap | OPEN | Manual runs only; recommended as a tagged browser lane. |
| RR-09 | CI actions pinned by tag (`@v4`), no explicit `permissions:` block | Supply-chain hardening | OPEN | No dangerous triggers (`pull_request_target` absent). Recommend SHA pinning + `permissions: contents: read`. |
| RR-10 | Real-model certification not re-run on the fixed build | Blocked by authorization boundary | OPEN | Fixes do not touch the model loop; hermetic suites + isolated end-to-end used instead. Re-run `test/real-coding-mission-cert.mts` when model spend is authorized. |
| RR-11 | Fuzzing/load testing not performed (bounded scope) | Untested area | OPEN | Parser and gate matchers were exercised with fixed adversarial corpora, not random fuzzing. |
| RR-12 | Windows-specific behavior verified on one host (Windows 11, Node 26); Linux/macOS confinement path (symlinks) relies on the same `realpath` logic but was not live-tested here | Platform coverage | OPEN | Junction repro is Windows-specific; the same canonicalization covers POSIX symlinks by construction. CI matrix (3 OS) exercises the unit suite. |
| RR-13 | Foreign-origin rejection also rejects future "remote UI" designs | Behavior note | VERIFIED-SAFE | Deliberate: any remote-access feature must extend the allowlist explicitly (revisit with auth redesign). |
| RR-14 | `Host` header requirement may reject some odd clients (HTTP/1.0 without Host) | Behavior note | VERIFIED-SAFE | All supported clients send Host; curl/CLI verified. |

## Assumptions made in this audit
1. The operator's machine and browser are not already compromised by malware with user-level access (such an attacker can read `.forge` directly; out of the local-tool threat model).
2. `NVIDIA_API_KEY` present in `.env` was never used by audit tests except the (explicitly skipped) model-boundary note; all audit instances used mock models.
3. The npm advisory check (the only network use) reflects registry state at 2026-10-14.

## Accepted-by-design scope fences (from the project's own boundary docs, re-validated as present)
- Single local principal, no multi-user auth (v1).
- No marketplace auto-update execution; packs quarantine-first.
- No second execution lifecycle.
