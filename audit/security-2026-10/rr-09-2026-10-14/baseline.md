# RR-09 Baseline — 2026-10-14 (recorded BEFORE any workflow edit)

## Source snapshot (no `.git` by design — limitation)
No commit SHA can be recorded; the reproducible snapshot is file hashes:
- `.github/workflows/ci.yml` — `61EBD54E88DAA14A1C9686BF448FF2A26297F663BE6340E630E250ABCF6BA974` (backup: `backups/ci.yml.orig`)
- `package.json` — `2178E9E98011AE91B234EEB3D032D9764FFB00338F71B8497D507DF129417366`
- `package-lock.json` — `8B07AC91E3BD3A15A82926238AE4F28BAB68C58FADE52E3BA1EACA9D1DF07208`

Environment: Node v26.11.1, npm 11.20.0, Windows host. Previous phase (`next-phase-2026-10-14/`) frozen and untouched.

## Workflow under review (full contents in `backups/ci.yml.orig`)
Single workflow `ci`: triggers `push` + `pull_request`; matrix 3 OS × Node 24.x; steps `checkout@v4`, `setup-node@v4` (npm cache), `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`.

## Third-party references found
1. `actions/checkout@v4` — tag pin, no SHA, no comment.
2. `actions/setup-node@v4` — tag pin, no SHA, no comment.

## Permissions
No `permissions:` block at workflow or job level (implicit broad default).

## Current CI behavior
No GitHub Actions run can be executed from here (no repo remote access from this workspace; no `.git`). Real-CI behavior is therefore **unverifiable in this phase** and recorded as such. Local proxy gates (typecheck/lint/build/test on the fixed tree) were green at phase freeze: 463/463, lint PASS, build exit 0, typecheck exit 0.

## Scope boundary for this phase
Only `.github/workflows/ci.yml` may change. No application source, no other workflows, no frozen-phase artifacts.
