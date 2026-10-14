# RR-09 CI Security Matrix — 2026-10-14

Single workflow in scope: `.github/workflows/ci.yml` (only workflow file in the repo).

| Aspect | Before | After | Risk finding |
|---|---|---|---|
| `actions/checkout` pin | `@v4` (mutable tag) | `@11d5960…6262` + `# v4.4.0` (verified = v4/v4.4.0 commit) | Tag-reassignment / tag-confusion class closed for this ref |
| `actions/setup-node` pin | `@v4` (mutable tag) | `@49933ea5…0020` + `# v4.4.0` (verified = v4/v4.4.0 commit) | Same as above |
| Workflow permissions | implicit (broad default) | `contents: read` top-level | Least privilege; single read-only job needs nothing more |
| Triggers | `push`, `pull_request` | unchanged | No `pull_request_target`; fork-PR code runs with read-only token and no secrets referenced by any step |
| Secrets in workflow | none referenced | none referenced | No secret exposure surface in CI |
| Shell interpolation | none (`run:` steps are fixed strings, no `${{ }}` interpolation of untrusted input) | unchanged | No injection surface |
| Dependency install | `npm ci` (lockfile-enforced) | unchanged | Deterministic installs; lockfile hash recorded in `baseline.md` |
| Required checks | steps run typecheck/lint/test | unchanged | Behavior preserved; branch-protection mapping is a repo-settings matter, out of file scope |

## Remaining within CI scope (not resolved by file edits)
- Actions versions beyond v4 line (e.g. checkout v5/v6) deliberately NOT adopted — v4.4.0 preserves exact current behavior; major upgrades are a separate decision.
- `cache: npm` restore is keyed by lockfile via setup-node defaults; no custom cache keys to audit.
- Runner images (`windows/macos/ubuntu-latest`) are floating labels by design; pinning runner images is out of proportion for this repo and not done.
