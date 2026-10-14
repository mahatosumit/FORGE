# RR-09 Verified SHA Mapping — 2026-10-14

Resolved live against `api.github.com` (read-only; User-Agent `forge-rr09-audit`). No SHA was guessed or copied from secondary sources.

| Action ref in workflow | Floating tag resolves to | Release tag resolves to | Match | Pinned SHA | Comment |
|---|---|---|---|---|---|
| `actions/checkout@v4` | `v4` → commit `11d5960a326750d5838078e36cf38b85af677262` | `v4.4.0` → commit `11d5960a326750d5838078e36cf38b85af677262` | identical | `11d5960a326750d5838078e36cf38b85af677262` | `v4.4.0` |
| `actions/setup-node@v4` | `v4` → commit `49933ea5288caeca8642d1e84afbd3f7d6820020` | `v4.4.0` → commit `49933ea5288caeca8642d1e84afbd3f7d6820020` | identical | `49933ea5288caeca8642d1e84afbd3f7d6820020` | `v4.4.0` |

Both tag objects were `type: commit` (no annotated-tag dereference needed; verified inline). Pinning to the full 40-hex SHA of the current v4-lineage release preserves exact current behavior while making future tag moves visible and reviewable.

## Permissions justification
Workflow needs: clone the repo (`contents: read`), install deps, run tests. No publishing, no release creation, no PR mutation, no checks API writes, no deployments. `pull_request` trigger is from same-repo branches in this design (no `pull_request_target`). Narrowest sufficient scope: top-level `permissions: contents: read` (single job; no per-job elevation needed).
