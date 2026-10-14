# FORGE

**State the outcome. FORGE plans in the open, works inside an authority envelope you set, verifies the result against evidence, and hands you a receipt — resumable at any point, on any model.**

FORGE is a local-first agent runtime built on one substrate-level rule: **the model proposes; the runtime owns what happened and what may happen.**

- **Runtime-owned truth** — every mission is an append-only, hash-chained journal. Observations are written exclusively by the runtime; model claims are valid only when they cite runtime-captured evidence.
- **Runtime-owned authority** — every world-affecting action arrives through one typed proposal channel, mechanically checked against scoped, expiring grants *before* execution. Approving an escalation extends a grant; it never approves a single call.
- **Tiered verification** — criteria resolve as *mechanical* (runtime-computed from observations) or *adjudicated* (labeled judgment). `inconclusive` never renders as success.
- **Receipts** — closure produces a machine-readable record: verdicts, authority manifest, change manifest, costs, and the journal's chain tip.

Coding is one capability among many (filesystem, shell, git, http, search, verify, artifact).

## Install & build

```bash
npm install
npm run build        # → dist/
npm test             # full suite (unit, slice, recovery, security, provider, CLI e2e)
npm run typecheck
npm run lint         # effect-boundary lint
```

Requires Node ≥ 24 (uses the built-in `node:sqlite` for rebuildable projections). Note: `package.json` engines allow ≥ 22.5, where `node:sqlite` may still require `--experimental-sqlite`; Node 24+ is the supported path.

## Configure a provider

```bash
npm run cli -- config       # writes .forge/config.json on first run
```

`.forge/config.json`:

```json
{
  "provider": { "kind": "openai-compatible", "baseUrl": "https://api.openai.com/v1", "apiKeyEnvVar": "OPENAI_API_KEY", "model": "gpt-4o-mini" },
  "dataDir": ".forge/data"
}
```

Set the API key environment variable named in `apiKeyEnvVar`. Any OpenAI-compatible endpoint works (OpenAI, OpenRouter, Groq, DeepSeek, Qwen, Mistral, vLLM, Ollama, LM Studio); `anthropic-messages` is the second built-in adapter. With no credential the model fails closed (`AuthFailed`) — the runtime never improvises.

## Run a mission

```bash
forge run "Fix the failing checkout test"
forge missions            # list missions
forge inspect <id>        # record-kind summary
forge log <id>            # compact log (real observations only)
forge receipt <id>        # the closure receipt
forge resume <id>         # reconstruct from the journal and continue
forge doctor              # journal chain verification + configuration checks
forge approve <mission> <requestId>   # decide a pending escalation
```

`forge run` uses the **quick lane**: a single-stage mission with an auto-derived, expiring authority envelope (write within common source trees, run the project's test command, no network). Out-of-envelope steps pause the mission with a structured escalation showing *why* (with citations) and *what scope* is requested — `forge approve` extends the grant for the mission.

## How it works

```
intent → mission (ledger) → plan → authority envelope
      → stages: model proposes → Proposal Gate (mechanical grant check)
              → capability host → environment → runtime-authored observation
      → verifier (mechanical criteria from observations; adjudicated labeled)
      → receipt → closure (verified | completed-unverified | blocked | failed | revised)
```

- **Nothing the model says becomes state.** Narration is ephemeral. Claims must cite observation ids; unresolved citations are rejected.
- **The crash boundary is explicit**: a `proposal.dispatched` record is written *before* any effect. After a crash, recovery distinguishes *known-not-executed*, *known-executed*, and *possibly-executed* — a non-idempotent effect that may have landed requires your explicit acknowledgment before resume continues.
- **The web console** is served by the API server (see `src/api/webui.ts`): mission board, log, escalations, receipts.

## Security

See `SECURITY.md` for the threat model summary. Key points:

- The trusted computing base is small: ledger + proposal gate + capability host.
- Secrets are resolved only at dispatch into the execution environment; they never enter model context or the journal (capture-time redaction).
- Extension packs run **out-of-process**, are quarantined until explicitly enabled, are hash-pinned, and start deny-by-default. They can never append records, self-grant, or bypass the gate.
- Honest limits: the default `local` environment is process-level governance, **not an OS sandbox** (use the `container` environment for isolation); an injected payload can still steer *in-grant* actions (grants bound the blast radius); a model can write tautological tests — verification tiers exist so you can see exactly how much to trust a receipt.

## Known limitations (v1)

- Single local principal; no multi-user auth.
- No vector memory — project memory is a user-approved manifest with citations.
- Criteria are only as good as their authors: mutation-based test-quality checking is future work.
- Journals are integrity-checked (hash-chained) but not cryptographically signed against root compromise.
- The `container` environment requires Docker; the default path is `local`.

## Development

Note: this repository is intentionally not Git-backed in this workspace; the
mission journals (hash-chained) are the product-level evidence store. The
`doctor` command verifies journal chain integrity and configuration.

```bash
npm run typecheck && npm run lint && npm test
```

Architecture documents live in `../architecture/` (KERNEL, DATA-CONTRACTS, STATE-MACHINES, FAILURE-SEMANTICS, SECURITY-THREAT-MODEL, INVARIANTS, IMPLEMENTATION-BOUNDARY, ADRs). The code conforms to them; the import-boundary lint (`scripts/lint.mjs`) mechanically enforces the effect boundary:

```
ModelFn → Proposal → Proposal Gate → Capability Host → Environment → Observation → Ledger
```

is the only path from model output to a world effect.

## License

MIT — see `LICENSE`. Architectural patterns were refined from three MIT-licensed reference systems (Hermes Agent by Nous Research, OpenCode, QUACK); see `NOTICE`.
