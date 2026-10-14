# Authority, Grants & Escalation in FORGE v1.1

## Core Invariant: The Model Has Zero Inherent Authority

In FORGE, the model is strictly a cognitive planner. It cannot execute code, mutate files, or contact the network on its own. Every proposed action must be evaluated against the active **Grant Store** by the **Authority Gate**.

## Authority Envelopes

### 1. `read-only`
- **Capabilities**: `search`, `verify`, `artifact`, `git` (read status/diff).
- **Filesystem**: No write or delete permissions.
- **Shell**: Denied.
- **Network**: Denied.

### 2. `safe-dev` (Default)
- **Capabilities**: `fs` (scoped to `src/**`, `test/**`, `docs/**`), `search`, `verify`, `artifact`, `shell` (argv prefix restricted to verification criteria commands).
- **Network**: Denied.
- **Escalation Trigger**: Modifying configuration (`package.json`), writing outside granted folders, or running arbitrary shell commands triggers an explicit human escalation request.

### 3. `full-dev`
- **Capabilities**: `fs` (workspace root `**`), `search`, `verify`, `artifact`, `http`, `git`, `shell` (prefixed to common tooling `npm`, `node`, `git`, `npx`).
- **Escalation Trigger**: Unknown network endpoints or shell commands outside standard developer tooling.

## The Escalation Review Workflow

When an action exceeds active grants:
1. The Authority Gate halts execution for that proposal.
2. An `escalation.requested` event is appended to the ledger.
3. The UI presents the **Escalation Review** panel:
   - What capability is requested (`fs`, `shell`, `http`).
   - The exact proposed arguments.
   - The model's stated rationale.
   - Why it is currently blocked.
4. The user clicks **Approve** (mints a scoped, attenuated grant) or **Deny** (rejects the proposal, forcing the model to rethink or close blocked).
