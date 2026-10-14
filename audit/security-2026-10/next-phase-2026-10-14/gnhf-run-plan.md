# GNHF Run Plan — RR-09 CI hardening (hands-off worker brief)

Date: 2026-10-14. Status: PLAN ONLY — no run launched, no source modified.
Scope source: `audit/security-2026-10/residual-risk-register.md` (RR-09) +
`audit/security-2026-10/next-phase-2026-10-14/residual-risk-update.md` (RR-09 unchanged, first in suggested order).

## 1. Readiness check (config/help output only — no runs, no network, no model calls)

- `gnhf --version` → **0.1.51**.
- `gnhf --help` supported `--agent` roster: **claude, codex, rovodev, opencode, copilot, pi, cursor, acp:\<target-or-command\>**.
- Key flags recorded: `--model` (overrides `agentModel.<agent>` from config),
  `--max-iterations <n>`, `--max-tokens <n>`, `--max-rate-limit-wait <duration>`,
  `--fallback-model <model>`, `--stop-when <condition>`,
  `--prevent-sleep on|off`, `--worktree`, `--current-branch`, `--push`,
  `--meteor-frequency 0-5` (default 3), `--mock`.
- No gnhf config file found locally (`%APPDATA%\gnhf`, `~\.config\gnhf`, `~\.gnhf`,
  `forge\.gnhf`, `forge\gnhf.json` all absent); no gnhf-related env keys set.
  First run will therefore use gnhf defaults unless flags/config are supplied.
- Agent CLIs detected by `--version` only: **claude 2.1.296 PRESENT**,
  **opencode v2.0.26 PRESENT**, **cursor 3.24.12 PRESENT**;
  codex / copilot / pi / rovo CLIs absent from PATH.
- Auth/config dirs (existence only, contents never read): `~\.claude` PRESENT,
  `~\.codex` PRESENT, `~\.config\opencode` PRESENT, `~\.copilot` PRESENT;
  `~\.cursor`, `~\.pi` absent. Auth validity NOT probed (that would need a
  network/model call, explicitly out of scope) — treat as "config present,
  authentication unverified".

## 2. Available agents (for this machine)

| Agent | CLI | Config dir | Usable for RR-09? |
|-------|-----|-----------|-------------------|
| claude | present (2.1.296) | present | yes (fallback) |
| opencode | present (v2.0.26) | present | yes (**recommended**, see §3) |
| cursor | present (3.24.12) | absent | possible, weaker local config evidence |
| codex | absent | present | no (no CLI) |
| copilot | absent | present | no (no CLI) |
| rovodev / pi | absent | absent | no |

## 3. Recommended agent for RR-09: `opencode`

- RR-09 is a tiny, deterministic YAML-only task (2 `uses:` lines, no logic
  changes): lowest risk of agent improvisation, and opencode is present with
  local config on this machine.
- Fallback: `claude` (CLI + config both present).
- Suggested invocation shape (DO NOT RUN until authorized):
  `gnhf --agent opencode --max-iterations 5 --stop-when "<stop condition in §5>" "<worker prompt in §5>"`
  Add `--worktree` if parallel lanes (RR-08/RR-04) run concurrently; do NOT pass
  `--push` (see non-goals).

## 4. RR-09 scope (ground truth, read-only)

- Target file: `.github/workflows/ci.yml` (25 lines, single `test` job,
  3-OS × node-24 matrix).
- Current findings (matches register): `actions/checkout@v4` (line 17) and
  `actions/setup-node@v4` (line 18) are **tag-pinned, not SHA-pinned**; there is
  **no `permissions:` block** at workflow or job level; no dangerous triggers
  (`pull_request_target` absent — confirmed by grep, zero matches).
- Required change: SHA-pin both `uses:` entries (with tag comment retained,
  e.g. `actions/checkout@<sha> # v4`) and add least-privilege
  `permissions: contents: read` (top-level; job needs nothing more — steps are
  checkout, setup-node, `npm ci`, typecheck, lint, test).
- Verification scripts exist in `package.json`: `build`, `typecheck`,
  `typecheck:tests`, `test`, `lint`. CI itself runs typecheck → lint → test.

## 5. Hands-off worker prompt (paste verbatim into the future `gnhf` invocation)

> Objective: close RR-09 in `.github/workflows/ci.yml` (FORGE repo).
> (1) Pin `actions/checkout@v4` and `actions/setup-node@v4` to full commit SHAs,
> keeping the human-readable tag as a trailing comment on each line.
> Resolve the SHAs for the v4 tags as part of the task and record each
> SHA + tag + resolution date in the commit message.
> (2) Add a least-privilege `permissions:` block (`contents: read`) at workflow
> level unless a job needs more — it does not; do not grant more.
> Constraints: edit ONLY `.github/workflows/ci.yml`. Do not change triggers,
> matrix, steps, scripts, or any other file. No new dependencies, no workflow
> logic changes. Verify locally with `npm run typecheck`, `npm run lint`,
> `npm run build`, and `npm test`, in that order; all four must pass.
> Also run a YAML sanity check that every `uses:` line is SHA-pinned
> (40-char hex) and that a `permissions:` block is present.
> Non-goals: no model spend (RR-10 real-model cert stays gated), no unrelated
> refactors, no other RR items, no force-push, no `--push` without human review.
> Stop condition: the task is DONE if and only if (a) `ci.yml` diff touches only
> `uses:` SHA pins (+tag comments) and the added `permissions:` block,
> (b) all four verification commands pass cleanly, and
> (c) `git status --porcelain` shows no other modified files.
> Report the SHAs, the verification outputs, and the final diff, then stop.

Concrete `--stop-when` value for the invocation:
`DONE iff ci.yml diff is limited to SHA-pinned uses: lines plus a permissions: contents: read block, npm run typecheck/lint/build and npm test all pass, and no other files are modified`.

## 6. Explicit non-goals (binding on the worker run)

1. **No model spend** — RR-10 (`test/real-coding-mission-cert.mts`) stays gated;
   hermetic/local verification only.
2. **No unrelated refactors** — RR-08 (browser lane), RR-04 (docs), RR-02/RR-05
   and all other files are out of scope for this run.
3. **No force-push, no auto-push** — run without `--push`; branch push/merge
   only after human review of the diff.
4. **No scope creep on triggers/matrix** — triggers (`push`, `pull_request`)
   and the 3-OS matrix stay exactly as-is.
5. **No long unattended run launched by this plan** — this file authorizes
   nothing; a human issues the `gnhf` command with `--max-iterations ≤ 5`.
