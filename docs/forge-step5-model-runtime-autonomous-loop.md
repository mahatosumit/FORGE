# FORGE STEP 5: MODEL RUNTIME & AUTONOMOUS REASONING LOOP

## Architectural Specification & Operational Reference

### Executive Summary

FORGE Step 5 implements the native Model Runtime and Autonomous Reasoning Loop, connecting FORGE's governed mission engine to real-world and local model providers. 

The core architectural invariant of FORGE is preserved and enforced without exception:
```
MODEL/PLANNER
    ↓
MISSION STATE
    ↓
CONTEXT ASSEMBLY (INV-14 isolated)
    ↓
STRUCTURED DECISION (Schema-validated)
    ↓
AUTONOMY POLICY EVALUATION (L0 - L4)
    ↓
PROPOSAL (Canonical JSON)
    ↓
AUTHORITY GATE (Grant matching, path normalization, attenuation)
    ↓
CAPABILITY HOST (Effect boundary, process isolation, redaction)
    ↓
EVIDENCE CAPTURE (Content-addressed SHA-256 artifacts)
    ↓
CRYPTOGRAPHIC LEDGER (Hash-chained records)
    ↓
MECHANICAL VERIFICATION (Zero trust in model claims)
    ↓
STATE UPDATE & CHECKPOINT
    ↓
MODEL/PLANNER (Iterative Loop)
```

No autonomous execution path exists that bypasses Proposal validation or Authority Gate evaluation. Even at autonomy level `L4_FULL_MISSION_AUTONOMY`, all actions flow through the Authority Gate.

---

## 1. Provider-Neutral Model Runtime

The model runtime defines a strict provider abstraction layer located in `src/model-runtime/`:

### 1.1 Interfaces & Contracts
* `ModelProvider`: Defines `id`, `name`, `getCapabilities()`, and the streaming generator `complete(req: ModelRequest): AsyncGenerator<ModelEvent>`.
* `ModelCapabilities`: Declares context window size, max output tokens, native tool calling support, vision/multimodal support, reasoning/thinking support, streaming support, and rate limits.
* `ModelDescriptor`: Associates a model ID with a provider ID, human name, and specific capability profile.
* `ModelResponse`: Encapsulates completed text, stream events, tokens in, tokens out, wall-clock duration, stop reason, and provider/model identifiers.

### 1.2 Implemented Providers
* `MockModelProvider` (`src/model-runtime/providers/mock.ts`):
  Fully deterministic, zero-network mock provider for comprehensive unit, property, and fault-injection testing. Supports response queueing, error synthesis (`RateLimited`, `Transport`, `MalformedOutput`, `ContextOverflow`), and call history tracking.
* `OpenAICompatibleProvider` (`src/model-runtime/providers/openai.ts`):
  Standard HTTP/SSE provider compatible with OpenAI, Azure OpenAI, Ollama, vLLM, and compatible inference gateways. Utilizes FORGE's existing `src/model-router/` client to prevent unauthorized network surface expansion and maintain architecture linter compliance (`scripts/lint-core.mjs`).

---

## 2. Registry & Governed Model Router

### 2.1 Provider and Model Registries (`src/model-runtime/registry.ts`)
* `ProviderRegistry`: Manages registered providers by ID.
* `ModelRegistry`: Manages model configurations, default model designation, and task-level routing. For specialized tasks (e.g., vision, deep reasoning, large-scale search), models can be resolved dynamically according to required capability flags.

### 2.2 Governed Model Router (`src/model-runtime/router.ts`)
The `ModelRouter` coordinates all model invocations, performing:
1. **Ledger Auditability**: Appends `model.requested` prior to calling the provider.
2. **Streaming Execution**: Consumes `ModelEvent` streams, aggregating deltas and tracking token counts.
3. **Transparent Failover**: If the primary provider fails with a transient error (`RateLimited` or `Transport`), the router logs `model.failed` with `retryable: true` and automatically invokes the configured fallback provider without losing task context.
4. **Token & Budget Accounting**: Records `model.completed` with exact prompt/completion token usage and updates mission budget consumption (`budget.updated`).
5. **Secret Protection**: Model requests and ledger entries never contain raw API keys or credentials.

---

## 3. Structured Decision Protocol & Schema Validation

Model reasoning output is parsed into a structured, validated decision schema (`src/model-runtime/decision.ts`):

### 3.1 Supported Decision Types
1. `propose_action`: Generates a concrete, governed capability proposal (`search`, `fs_read`, `fs_write`, `shell`, `web_fetch`, `mcp_call`, `doc_read`, etc.) with rationale and citations.
2. `replan`: Requests milestone or task graph modification when unexpected obstacles arise.
3. `complete_task`: Explicitly indicates that the active task has satisfied its goals.
4. `fail_task`: Signals that the active task cannot proceed, triggering governed retry evaluation.
5. `pause`: Requests durable mission pause and checkpointing (e.g., awaiting human confirmation or external factors).

### 3.2 Robust Parsing & Defense
* **Extraction Flexibility**: Recognizes structured JSON inside Markdown code fences (````json ... ````), embedded prose, or raw JSON.
* **Schema Validation**: Uses Zod schemas to enforce mandatory fields (`analysis`, `decisionType`, `proposal`).
* **Rejection Logging**: If the model output is unparseable or violates schema constraints, the event is recorded to the ledger as `decision.rejected` with detailed validation diagnostics.

---

## 4. Context Assembly & Untrusted Content Isolation (INV-14)

The `ContextBuilder` (`src/model-runtime/context-builder.ts`) compiles model prompts while strictly enforcing FORGE's security boundary:

1. **System & Role Instructions**: Injects FORGE persona, operational invariants, and output formatting rules (`provenance: "runtime-framing"`).
2. **Mission & Task State**: Serializes active intent, milestone progress, current task definition, and remaining budgets.
3. **Capability Documentation**: Injects capability signatures and constraint schemas matching currently active grants.
4. **Untrusted Workspace Isolation (INV-14)**: Any content read from files, web requests, documents, or MCP tools is explicitly tagged with `provenance: "workspace-content"`. System instructions clearly direct the model to treat workspace content as untrusted input, neutralizing prompt-injection attempts.
5. **Secret Redaction**: Environment secrets and API tokens are completely excluded from the context.

---

## 5. Autonomy Policy Engine (L0 through L4)

The `AutonomyPolicyEngine` (`src/model-runtime/autonomy-policy.ts`) enforces graduated autonomy:

| Level | Policy | Behavior |
|-------|--------|----------|
| `L0_ASK` | Full Manual | Every proposal requires explicit human approval before gate submission. |
| `L1_SUGGEST` | Advisory | Model suggests plans and proposals; human must accept each step. |
| `L2_SAFE_AUTONOMOUS` | Read-Only | Read-only actions (`search`, `fs_read`, `doc_read`, `web_fetch`) run automatically. Mutating actions require approval. |
| `L3_GOVERNED_AUTONOMOUS` | Scoped Autonomy | Actions run automatically if and only if they are covered by existing active grants. Missing grants trigger escalation. |
| `L4_FULL_MISSION_AUTONOMY` | High Autonomy | Model acts autonomously within all issued grants. |

### Critical Invariant: Non-Bypassable Authority Gate
Under no circumstances can `L4_FULL_MISSION_AUTONOMY` bypass the Authority Gate. An `L4` autonomy policy merely answers whether human-in-the-loop confirmation is needed before gate dispatch; the **Authority Gate still evaluates every single proposal against active grants, normalizes paths, checks constraints, and logs verdicts**.

---

## 6. Autonomous Reasoning Loop (`AutonomousReasoningLoop`)

The main reasoning engine (`src/model-runtime/loop.ts`) coordinates autonomous execution:

```
[Start / Resume]
   │
   ▼
[Check Hard Budgets] ──(exceeded)──► [Fail Mission: MissionBudgetExceededError]
   │
   ▼
[Find Active Milestone & Ready Tasks] ──(all succeeded)──► [Mission Verification] ──► [Complete]
   │
   ▼
[Assemble Context (INV-14)]
   │
   ▼
[Invoke ModelRouter] ──(failure)──► [Analyze Failure & Retry / Fail]
   │
   ▼
[Parse & Validate ModelDecision] ──(invalid)──► [decision.rejected & Fail]
   │
   ▼
[Evaluate Autonomy Policy (L0-L4)]
   │
   ├─► (pause) ────► [Create Checkpoint & Transition to 'paused']
   ├─► (replan) ───► [Synthesize Plan Revision & Checkpoint]
   ├─► (complete) ─► [Verify Task & Mark Succeeded]
   │
   ▼ (propose_action)
[Evaluate Authority Gate]
   │
   ├─(Escalate)──► [Execute OnEscalation Handler / Wait]
   ├─(Deny)──────► [Reject Proposal & Log to Ledger]
   │
   ▼ (Allow)
[CapabilityHost Dispatch]
   │
   ▼
[Capture Content-Addressed Evidence]
   │
   ▼
[Cryptographic Ledger Append]
   │
   ▼
[Mechanical Verification Engine]
   │
   ├─(Pass)──► [Update Task Succeeded & Checkpoint]
   └─(Fail)──► [FailureAnalyzer: Retry or Mark Failed]
   │
   ▼
[Next Iteration]
```

---

## 7. Hard Mission Budgets

Hard bounds are strictly enforced before every reasoning cycle and capability dispatch:
* `maxModelCalls`: Halts if total provider invocations exceed the limit.
* `maxTokens`: Halts if cumulative input + output tokens exceed the limit.
* `maxPlannerTurns`: Halts if total reasoning cycles exceed the limit.
* `maxCapabilityCalls`: Halts if total capability dispatches exceed the limit.
* `maxExecutionTimeMs`: Halts if wall-clock elapsed time exceeds the limit.
* `maxRetries`: Halts if task retries exceed the limit.

Budget violations immediately throw a `MissionBudgetExceededError`, write a `mission.failed` record with error category `budget_exceeded`, and transition the mission to `failed`.

---

## 8. Pause, Resume, and Crash Recovery

* **Durable Pause**: When `pauseMission()` is called or the model issues a `pause` decision, the engine resets any running in-flight task to `pending`, creates a durable snapshot checkpoint (`checkpoint.created`), records `mission.paused`, and transitions state to `paused`.
* **Idempotent Resume**: Calling `resumeMission()` transitions the mission back to `executing`, appends `mission.resumed`, and picks up from the last checkpoint without re-executing already completed tasks.
* **User Cancellation**: External abort signals or `cancelMission()` cleanly transition the mission to `cancelled` and write `mission.cancelled` without corrupting the cryptographic hash chain.

---

## 9. Cryptographic Ledger Integration

Step 5 introduces 9 first-class ledger records in `src/contracts/records.ts`:

1. `model.requested`: Logged before provider dispatch with prompt token estimate and message count.
2. `model.completed`: Logged on provider completion with exact token counts, duration, and stop reason.
3. `model.failed`: Logged on provider errors with error code, message, and retryability.
4. `decision.generated`: Logged when structured decision is successfully parsed.
5. `decision.rejected`: Logged when model output violates schema or is unparseable.
6. `autonomy.policy_evaluated`: Logged when autonomy policy (L0–L4) is assessed for a proposal.
7. `budget.updated`: Logged as tokens and model calls are consumed.
8. `mission.paused`: Logged when a mission enters paused state with checkpoint reference.
9. `mission.resumed`: Logged when a paused mission resumes execution.

---

## 10. Verification & Test Evidence

### Baseline Verification Matrix
* **TypeScript Compilation**: `npm run typecheck` → PASS (0 errors)
* **Architecture Linter**: `node scripts/lint.mjs` → PASS (seams preserved, 0 violations)
* **Production Build**: `npm run build` → PASS
* **Model Runtime Test Suite**: `node --import tsx --test test/model-runtime/model-runtime.test.ts` → 8/8 PASS
* **Full Repository Test Suite**: `npm test` → 209/209 PASS (0 failures, 0 skipped)
* **10-Task Realistic Benchmark Suite**: `node --import tsx --test test/benchmark/benchmark-suite.test.ts` → 10/10 PASS (100% success rate)
