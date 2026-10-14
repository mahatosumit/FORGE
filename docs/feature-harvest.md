# FEATURE-HARVEST — REA evidence + reference repo analysis → FORGE roadmap

Grounded in: REA `analyze_javascript_application` runs over the three shipped
trees (evidence IDs below), their shipped `AGENTS.md` files, and `../research/*.md`.

## REA evidence (retained this session)

| Tree | Evidence record | Scale observed |
| ---- | --------------- | -------------- |
| `D:\quack pro\opencode-2\opencode-2` | `ev_19a6fa3aa40b3eb899d552c2c26f4bccc211715dbba2d30fb374e527d70233f0` | 4,275 JS files parsed, 4.2M AST nodes, 28,443 findings |
| `D:\quack pro\research-repos\deepseek-harness` | `ev_b1b867e20d1316a8611ed3ddf8673d32b2400326732a8b8eb96425797378776b` | 5,746 files, 7.4M AST nodes, 39,249 findings |
| `D:\quack pro\hermes-agent-main\hermes-agent-main` | `ev_4f36594be55299911a469b5bd3e868679d0c837a788ddeb174d662fe2a15fa3c` | 3,790 JS files (TS/web/desktop subset; Python core not JS-indexed by design), 22,313 findings |

Session bundles exported: `…/Temp/opencode/rea-session-bundle.json`, `…-bundle2.json`.
Coverage limitation (all three): dynamic IPC/dynamic imports unresolved; inert
syntax only, no runtime execution — absence of a finding is not proof of absence.

## Capability inventory deltas (vs FORGE v1.1)

### OpenCode v2 (Anomaly) — observed in REA graph + AGENTS.md
- packages/{ai, core, cli, tui, server, schema, plugin, codemode, session-ui,
  desktop, protocol, merman, simulation, enterprise, httpapi-codegen}
- durable event-sourced session core; inbox steer-vs-queue; structured
  compaction; typed AI-error taxonomy; models.dev-style catalog
- plugin package with effectful registration; TUI storybook harness

### DeepSeek Harness — observed in REA graph + AGENTS.md
- all-plugin Cordis architecture; sandbox/windows-acl; ssh/subprocess providers;
  compaction/spill/todo/plan/goal packages; subagent; schedule; session
  persistence JSONL + CID chain; SDKs (TS + Python); feedback/identity;
  migration versioning (SESSION_FORMAT_VERSION monotonic)
- CI gates: duplication, snapshot replay, docs sync, 100% per-file coverage gate

### Hermes Agent (Nous Research) — observed + repo docs
- declarative ProviderProfile as data; credential pools with 429 rotation;
  progressive tool disclosure (BM25 over tools); PTC (programmatic tool calling);
  gateway cron; skills with quarantine + AST audit; incident-numbered evals;
  profile scoping rules; prompts-as-code discipline (cache-preserving)

## Verdict per item (FORGE discipline: thesis + boundary fence)

| Feature | Verdict | Where |
| ------- | ------- | ----- |
| Progressive capability disclosure (relevance-gated cards) | **BUILD NOW** — enforces INV-14 (context compiled) | `engine/context` |
| Credential pool rotation (429/auth failover chains) | **BUILD NOW** — reliability of ingress authority | `model-router` |
| Structured compaction → `checkpoint.created` (mechanical, runtime-authored) | **BUILD NOW** — record kind exists, engine never wrote it | `engine` |
| Skill/catalog marketplace | PARTIAL EXISTS (packs skeleton) — quarantine-only, never auto-update (NEVER list) | `packs` |
| Windows-ACL local sandbox (DSH pattern) | LATER — entry when container env proven in ≥3 real missions | `environments` |
| PTC (model-authored tool programs) | LATER — must ride the proposal gate; open eval question | research |
| Cron/schedule/watch mission sources | LATER — entry condition: lifecycle stable + demand | boundary |
| TUI storybook / desktop app | NEVER for v1 (boundary fence) | — |
| Outbound telemetry without opt-in | NEVER | — |
| Second execution lifecycle | NEVER (thesis) | — |

## Build order adopted
1. credential pool rotation in router (+tests)
2. relevant capability card selection in engine context (+tests)
3. mechanical checkpoint writing on context pressure (+tests)
