# Model Selection & Routing in FORGE v1.1

## First-Class Models

In FORGE, models are cognitive engines that emit structured proposals. Models NEVER execute commands or mutate files directly.

## Configurable Routing Strategies

FORGE supports multiple routing strategies configured via the Settings menu or CLI:

1. **Single**:
   Always execute using the selected active model.
2. **Fallback**:
   When the primary model experiences rate limits (`429`), timeouts, or 5xx failures, FORGE automatically fails over to the configured fallback model while recording the transition in the tamper-evident ledger.
3. **Best Available**:
   Selects the model with lowest latency and verified healthy status.

## Credential Pools

Multiple API keys may be registered per provider (`forge credentials add`). On
rate-limit (`429`), quota, transport, or auth failure, FORGE rotates to the
next non-cooling credential (60s cooldown) *before* attempting a model
fallback — same model, same request. Rotations surface as
`[FORGE Router: credential rotation ...]` deltas and broadcast events.

## Context Discipline

Two mechanical mechanisms keep every model round small (INV-14: compiled, not
dumped):

- **Progressive capability disclosure** — only the core loop cards
  (fs/shell/search/verify) plus relevance-scored capabilities for the current
  goal are sent each round; the full catalog id list stays in the prompt as an
  escape hatch.
- **Mechanical compaction** — when an assembled request exceeds ~160k chars,
  the runtime derives a `checkpoint.created` record from the journal
  (completed/unfinished tasks, verdicts, unresolved errors) and continues with
  the checkpoint + a short tail. No model-authored summaries enter the ledger.

## Active Model Selection

Users can change active models without restarting the server:

### In Web UI:
- Click the **Active Model** pill in the top header or navigate to **Providers & Models**.
- Select the desired model and fallback model from the dropdown.

### In CLI:
```bash
# View active and configured models
forge models

# Select active model
forge models select moonshotai/kimi-k3 nvidia-nim

# Select OpenAI fallback
forge models select gpt-4o openai
```

## Reasoning & Structured Output

Models interact with the FORGE runtime by emitting typed events:
- `text-delta`: Cognitive reasoning and progress commentary.
- `content`: Base64-encoded payload paired with its SHA-256 hash.
- `proposal`: Governed capability invocation request (`fs`, `shell`, `git`, `http`, etc.).
