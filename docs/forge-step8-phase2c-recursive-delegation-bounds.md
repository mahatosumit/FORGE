# FORGE STEP 8 PHASE 2C — RECURSIVE DELEGATION BOUNDS & TOPOLOGY GOVERNANCE
## Mathematical Depth Bounds, Fanout Throttling, and Anti-Fork-Bomb Architecture

**Status:** DESIGN GATE (Implementation STRICTLY LOCKED)  
**Security Invariant:** Hard topological bounds enforced at Gate evaluation time:
$$D(a) \le 2, \quad F(p) \le 3, \quad N_{\text{total}} \le 10, \quad \text{CycleFree}(\pi)$$

---

## 1. Problem Statement: Topology Explosion & Fork Bombs

Unchecked recursive delegation in autonomous systems inevitably leads to resource collapse:
1. **Depth Runaways:** Recursive delegation where an agent delegates a task to another, which delegates to another, resulting in an unmanageable stack of waiting agents and cascading budget depletion.
2. **Fanout Explosions (Fork Bombs):** An agent spawning an unbounded number of concurrent child processes (e.g. 50 parallel agents to inspect 50 files), triggering OS thread starvation, memory exhaustion, and lock contention.
3. **Graph Cycles:** Indirect delegation loops where Agent A delegates to Agent B, which delegates to Agent C, which delegates back to Agent A, creating infinite circular loops.

Prompt constraints or LLM self-restraint cannot prevent these dynamics. The runtime must enforce **hard mathematical invariants**.

---

## 2. Formal Topological Invariants

```
                                      ROOT AGENT (Depth 0)
                                    [Active Children <= 3]
                                               │
                   ┌───────────────────────────┼───────────────────────────┐
                   ▼                           ▼                           ▼
            CHILD 1 (Depth 1)           CHILD 2 (Depth 1)           CHILD 3 (Depth 1)
          [Active Children <= 3]      [Active Children <= 3]      [Active Children <= 3]
                   │                           │                           │
          ┌────────┴────────┐                  │                  ┌────────┴────────┐
          ▼                 ▼                  ▼                  ▼                 ▼
     GRANDCHILD 1.1    GRANDCHILD 1.2    GRANDCHILD 2.1      GRANDCHILD 3.1    GRANDCHILD 3.2
       (Depth 2)         (Depth 2)         (Depth 2)           (Depth 2)         (Depth 2)
       [CANNOT           [CANNOT           [CANNOT             [CANNOT           [CANNOT
      DELEGATE]         DELEGATE]         DELEGATE]           DELEGATE]         DELEGATE]
```

### Invariant 1: Maximum Hierarchy Depth ($D_{max} = 2$)
- **Depth 0:** Root Mission Agent (Human / Operator created).
- **Depth 1:** Child Agent (Delegated by Root).
- **Depth 2:** Grandchild Agent (Delegated by Child).
- **Depth 3+:** **STRICTLY PROHIBITED.**
  - If an agent at Depth 2 attempts to propose a `delegate` capability, the Authority Gate immediately rejects the proposal:
    $$\text{evaluateProposal}(\text{delegate}) \implies \text{REJECT [reason: depth_limit_exceeded]}$$
  - A Grandchild has zero delegation authority. It can only execute terminal work within its physical jail.

### Invariant 2: Maximum Concurrent Child Fanout ($F_{max} = 3$)
- Any individual parent agent can have at most **3 active child delegations** executing concurrently.
- If Parent $P$ currently has 3 children in states `authorized`, `activating`, or `active`, any proposal to delegate a 4th child is rejected closed:
  $$\text{getActiveChildCount}(P) \ge 3 \implies \text{REJECT [reason: fanout_limit_exceeded]}$$
- The 4th child cannot be authorized until one of the existing 3 children transitions to a terminal state (`completed`, `failed`, or `revoked`).

### Invariant 3: Global Runtime Concurrency Ceiling ($N_{max} = 10$)
- Across all missions and depths, the entire FORGE host daemon limits concurrent active agents to **10**.
- If the global active agent count is $\ge 10$, all new delegation proposals across the system are blocked until resources free.

### Invariant 4: Strict Directed Acyclic Graph ($\text{CycleFree}$)
- Every registered delegation entry contains an immutable ancestor vector:
  $$\pi(d) = [d_0, d_1, \dots, d_{k-1}, d]$$
- When Parent $P$ proposes to delegate to target $C$, the Gate checks:
  $$C \notin \pi(P) \land \forall a \in \pi(P), \quad a.\text{status} \notin \{\text{revoked}, \text{expired}, \text{failed}\}$$
- Any self-reference or ancestor collision throws `CycleDetectedError`.

---

## 3. Atomic Reservation Mechanics Under Lock

To prevent TOCTOU concurrency races where multiple parent planners race to spawn children simultaneously, fanout and depth checks are executed under cross-process lock:

```typescript
export class TopologyGovernor {
  static validateDelegationRequest(
    parentEntry: DelegationRegistryEntry,
    registry: DelegationRegistry,
  ): void {
    // 1. Depth Bound Enforcement
    if (parentEntry.depth >= 2) {
      throw new TopologyLimitError(
        "depth",
        `Agent at depth ${parentEntry.depth} cannot delegate: maximum hierarchy depth is 2 (INV-37)`,
      );
    }

    // 2. Parent Fanout Bound Enforcement
    const activeChildren = registry.getActiveChildCount(parentEntry.delegationId);
    if (activeChildren >= 3) {
      throw new TopologyLimitError(
        "fanout",
        `Parent delegation "${parentEntry.delegationId}" has reached max active child fanout (3) (INV-38)`,
      );
    }

    // 3. Global Agent Count Enforcement
    const totalActive = registry.getActiveAgentCount();
    if (totalActive >= 10) {
      throw new TopologyLimitError(
        "global_concurrency",
        `Global active agent count (${totalActive}) has reached runtime limit (10)`,
      );
    }
  }
}
```

---

## 4. Anti-Fork-Bomb Verification Proof

Under these parameters, the theoretical maximum number of active agents in any FORGE deployment is strictly bounded:
$$\text{Max Active Agents} = 1 \text{ (Root)} + 3 \text{ (Depth 1)} + (3 \times 3) \text{ (Depth 2)} = 1 + 3 + 9 = 13$$
Constrained further by the **Global Concurrency Ceiling ($N_{max} = 10$)**:
$$\text{Active Agents Running Simultaneously} \le 10$$

This mathematically prevents any runaway exponential fork-bomb from exhausting host process limits, file descriptors, or memory.
