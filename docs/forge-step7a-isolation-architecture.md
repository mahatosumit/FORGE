# FORGE STEP 7A — EXECUTION ISOLATION & CONTAINERIZED SANDBOXING ARCHITECTURE

**Status:** APPROVED ARCHITECTURAL SPECIFICATION  
**Author:** FORGE Architecture Core Team  
**Date:** October 7, 2026  
**Document Version:** 1.0.0  
**Predecessor Milestone:** Step 6 Closed (253/253 tests pass, Gates A–G verified, 0 Category-E effects)

---

## 1. EXECUTIVE SUMMARY & PURPOSE

FORGE Step 6 successfully unified capability typing, version pinning, authority gates, cryptographic CAS, socket-level SSRF prevention, and ledger attribution. However, Step 6 executed capabilities directly on the host machine using `LocalEnvironment`.

Step 7A introduces **Execution Isolation**, establishing a fundamental security boundary between *Governance* and *Isolation*:

$$\begin{aligned}
\textbf{Governance (Step 6):} & \quad \text{“Was this action authorized?”} \\
\textbf{Isolation (Step 7A):} & \quad \text{“What can the action damage if the authorized program itself is malicious?”}
\end{aligned}$$

### Core Invariant
> **The sandbox is defense-in-depth, not the authority boundary.**  
> If the sandbox fails or is escaped, the **Proposal $\to$ Gate $\to$ Host** governance model must still hold.  
> If an authorized program is malicious, buggy, or compromised, the **sandbox must strictly contain its blast radius**.

Capabilities do **not** select their own execution environment. The isolation profile is an authoritative policy enforced **above** the environment by the Authority Gate.

---

## 2. THREAT MODEL & TRUST BOUNDARIES

### 2.1 System Trust Boundaries

```text
[ UNTRUSTED ]
  Model / LLM Output
       ↓
  Proposal (Intent & Arguments)
══════════════════════════════════════════════════════════════════ [ TRUST BOUNDARY 1 ]
[ TRUSTED FORGE CONTROL PLANE ]
  Autonomy Policy
       ↓
  Authority Gate (Evaluates Grants & Assigns IsolationProfile)
       ↓
  Capability Host (Computes Hashes, Pre-dispatch CAS, Quarantine)
       ↓
  Execution Provider Supervisor
══════════════════════════════════════════════════════════════════ [ TRUST BOUNDARY 2 ]
[ ISOLATED GUEST BOUNDARY ]
  Container / OCI Sandbox (Read-Only Root, Tmpfs, Network Namespaces, PID Limits)
       ↓
  Guest Process (sh, python, node, gcc, git, build scripts)
══════════════════════════════════════════════════════════════════ [ TRUST BOUNDARY 3 ]
[ PROTECTED INFRASTRUCTURE ]
  Host OS, Host Filesystem, Host Network, Host Ledger, Host Secrets, Docker Daemon Socket
```

### 2.2 Attacker Model
The threat model assumes an attacker has achieved arbitrary code execution *inside* the execution sandbox via:
1. Model-generated malicious code (e.g. `python -c "..."` or shell scripts).
2. Malicious third-party dependencies (`npm install`, `pip install`, git submodules).
3. Compromised or backdoored tools executed within an authorized mission task.
4. Exploitation of binary parsing bugs in compilers, linkers, or runtimes.

### 2.3 Blast Radius Containment Goals
Under an active arbitrary-code-execution compromise inside the guest sandbox:
1. **Host Filesystem:** Zero read/write access to host files outside the explicitly mounted `/workspace`.
2. **Host Secrets:** Zero ambient access to host environment variables, user credentials, SSH keys, or cloud metadata.
3. **Host Control Interface:** Zero access to the host container daemon socket (`/var/run/docker.sock`, `/run/podman/podman.sock`).
4. **Authority & Audit Plane:** Zero access or write capability to the FORGE ledger journal, mission projections, SQLite database, or Grant store.
5. **Network:** Zero unmanaged outbound or lateral intranet network access (default `network:none`).
6. **Persistence:** Zero persistence across sandbox destruction; all intermediate processes and temporary files are obliterated upon sandbox termination.

---

## 3. CORE ARCHITECTURAL INVARIANTS (INV-15 THROUGH INV-18)

### INV-15 — Isolation is Authoritative
A model or capability proposal cannot specify an environment or isolation profile to escape sandboxing:
```json
// REJECTED / IGNORED:
{
  "capability": "sh",
  "args": { "command": "whoami", "environment": "host" }
}
```
The `IsolationProfile` is determined strictly by the **Authority Gate** and the **Grant**, based on the capability risk tier and active constraints. The model runtime and proposal arguments have zero authority over environment selection.

### INV-16 — Host Execution is Exceptional
Sandboxed execution is the default for all effect-producing capabilities:
- **R0 / R1** (Pure read / metadata): Sandboxed where practical; isolated local read allowed for verified workspace files.
- **R2 / R3** (Filesystem write / process spawn / network): Mandatory containerized sandbox with controlled mounts and network policies.
- **R4** (Arbitrary code execution / interpreters / raw shell): **Strictly mandatory containerized sandbox**.

Host execution requires an explicit, separate capability grant:
```ts
capability: "host_execution"
```
or an explicit constraint flag (`allowHostExecution: true`) issued by an administrator envelope. Host execution is classified as **Tier R4**, generates high-severity audit telemetry, and is never granted by default autonomy policies.

### INV-17 — Sandbox Destruction is the Kill Primitive
When a mission, task, or capability execution is aborted, cancelled, or times out:
```text
AbortSignal / Timeout
       ↓
Terminate Container (docker kill / podman stop / cgroups kill)
       ↓
Wait for Container Exit
       ↓
Verify Container and Guest Processes No Longer Exist
       ↓
Extract Bounded Evidence from Host Buffer
       ↓
Append observation.interrupted to Ledger
```
The execution supervisor does **not** rely on killing individual PIDs inside the guest sandbox. The container itself is the unit of termination. Destruction of the container guarantees destruction of the entire guest process tree (including background daemons, fork bombs, and detached grandchildren).

### INV-18 — Evidence Survives Sandbox Destruction
The container sandbox is entirely disposable, but audit evidence and artifacts are durable:
```text
Guest Sandbox
 ├── stdout / stderr (streamed to Host Supervisor pipe)
 ├── workspace mutations (persisted on Host Workspace bind-mount)
 └── execution metadata (exit code, duration, OOM status)
       ↓
 Bounded Ingestion by Host Supervisor (2 MiB limit)
       ↓
 Content-Addressed Artifact Store (Host Ledger)
       ↓
 Cryptographic Ledger Journal Append
```
The guest sandbox never has direct write or delete access to the host ledger directory (`paths.dir`, `journal.jsonl`, `artifacts/`). The Host Supervisor captures evidence from outside the container and authors the ledger records.

---

## 4. EXECUTION ARCHITECTURE & PROVIDER LAYER

### 4.1 Layered Architecture

```text
                     Model Runtime
                           │
                           ▼
                        Proposal
                           │
                           ▼
                    Authority Gate
              (Evaluates Grant & Constraints)
              (Assigns IsolationProfile: sandboxed | host)
                           │
                           ▼
                    Capability Host
              (Checks CAS, Hash Pinning, Concurrency)
                           │
                           ▼
                   ExecutionProvider
                           │
         ┌─────────────────┴─────────────────┐
         ▼                                   ▼
 ContainerExecutionProvider           LocalExecutionProvider
 (IsolationProfile: sandboxed)       (IsolationProfile: host)
         │                                   │
   OCI / Docker / Podman               LocalEnvironment
   Container Lifecycle                (Host OS Process)
   [Strict Sandboxing]               [Requires R4 Host Grant]
```

### 4.2 IsolationProfile Specification

```ts
export type IsolationProfile =
  | "sandboxed"           // Default: No network, read-only root, workspace mount, tmpfs
  | "sandboxed-network"   // Governed network: Egress proxy with domain allowlist
  | "host";               // Exceptional: Direct host execution (R4 grant required)
```

### 4.3 ExecutionProvider Interface

```ts
export interface ExecutionRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal: AbortSignal;
  isolationProfile: IsolationProfile;
  networkPolicy?: NetworkPolicy;
  resourceLimits?: ResourceLimits;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  durationMs: number;
  truncated: boolean;
  oomKilled: boolean;
  isolationProfile: IsolationProfile;
}

export interface ExecutionProvider {
  execute(req: ExecutionRequest): Promise<ExecutionResult>;
  cleanup(): Promise<void>;
}
```

---

## 5. CONTAINER LIFECYCLE MANAGEMENT

The `ContainerExecutionProvider` manages a strict, observable 9-stage container lifecycle:

```text
[CREATING] ──► [CONFIGURING] ──► [MOUNTING] ──► [STARTING] ──► [RUNNING]
                                                                  │
                                                                  ▼
[DESTROYED] ◄── [VERIFYING] ◄── [TERMINATING] ◄── [CAPTURING] ◄──┘
```

1. **CREATING:** Container runtime allocation (Docker/Podman/OCI runtime client initialization).
2. **CONFIGURING:** Applies cgroup resource limits, security profiles (`seccomp`, `apparmor`), user UID/GID (non-root `1000:1000`), drops all Linux capabilities (`CAP_DROP_ALL`).
3. **MOUNTING:**
   - Mounts read-only root filesystem image (`--read-only`).
   - Mounts ephemeral `/tmp` as `tmpfs` (`size=128m,noexec,nosuid`).
   - Mounts host `workspaceRoot` strictly to `/workspace` (`rw`).
   - **Banned Mounts:** Never mount `/var/run/docker.sock`, `/run/podman/podman.sock`, host root `/`, `/etc`, or the FORGE ledger directory.
4. **STARTING:** Container spawned with isolated namespaces (PID, Mount, Network, IPC, UTS).
5. **RUNNING:** Guest process executed via `exec` inside the active container sandbox.
6. **CAPTURING:** Host supervisor drains stdout/stderr streams up to bounded buffer limit (2 MiB); extracts output artifacts.
7. **TERMINATING:** On process exit, timeout, or AbortSignal: triggers immediate container termination (`docker kill` / `podman kill`).
8. **VERIFYING:** Queries container daemon to verify container status is `exited`/`removed` and no guest processes remain.
9. **DESTROYED:** Prunes container instance (`--rm` or explicit `docker rm -f`).

---

## 6. FILESYSTEM ISOLATION MODEL

| Filesystem Path | Guest Mount Type | Permissions | Rationale |
| :--- | :--- | :--- | :--- |
| `/` (Container Root) | RootFS Image | **Read-Only (`ro`)** | Prevents system binary tampering or rootkit persistence |
| `/tmp` | `tmpfs` | **Read/Write (`rw,noexec,nosuid`)** | Ephemeral scratch space, cleared on container exit, no execution |
| `/workspace` | Bind Mount (`workspaceRoot`) | **Read/Write (`rw`)** | Confined strictly to the mission workspace directory |
| Host Data Dir (`paths.dir`) | **NOT MOUNTED** | **NO ACCESS** | Protects ledger journal, projections, and audit store |
| `/var/run/docker.sock` | **STRICTLY FORBIDDEN** | **NO ACCESS** | Prevents container breakout to host Docker daemon |
| `/proc` / `/sys` | Virtual FS | **Read-Only (`ro`)** | Masks sensitive kernel parameters and hardware interfaces |

---

## 7. NETWORK ISOLATION MODEL

### 7.1 Network Modes
1. **`network:none` (Default):**
   - Configured with `--network none`.
   - Guest container has zero network interfaces except isolated loopback.
   - Mandatory for all shell execution, build tools, and local script runs.
2. **`network:proxy` (Governed Egress):**
   - Container network bridged strictly to an internal governed Egress Proxy.
   - All HTTP/HTTPS requests must pass through the proxy.
   - Proxy validates requests against:
     - Authority Gate domain allowlist constraints.
     - Step 6 connection-level socket pinning (`safeConnectionFetch`).
     - SSRF blocking (prohibiting RFC 1918, CGNAT, loopback, cloud metadata `169.254.169.254`).
   - All network bytes are counted toward the mission network budget.

---

## 8. RESOURCE ISOLATION LIMITS

| Resource | Sandbox Enforcement Mechanism | Default Limit | Purpose |
| :--- | :--- | :--- | :--- |
| **CPU** | `--cpus <n>` / cgroup `cpu.max` | 1.0 CPU | Prevents CPU starvation & cryptomining |
| **Memory** | `--memory <bytes>` / cgroup `memory.max` | 512 MiB | Prevents host OOM exhaustion |
| **Swap** | `--memory-swap <bytes>` | 512 MiB (0 swap) | Disables swap amplification attacks |
| **PIDs / Tasks** | `--pids-limit <n>` / cgroup `pids.max` | 64 processes | Blocks fork bombs & runaway thread pools |
| **Execution Time** | Host Supervisor Timeout + Container Kill | 30,000 ms | Prevents hanging or deadlocked processes |
| **Disk Output** | Host Stream Truncation (`OUTPUT_MAX_BYTES`) | 2 MiB | Prevents disk flood attacks |
| **Tmpfs Storage** | `--tmpfs /tmp:size=128m` | 128 MiB | Bounds memory consumed by ephemeral scratch |

---

## 9. CROSS-PLATFORM & DEGRADED-MODE SEMANTICS

1. **Linux Production Environment:**
   - Primary: Rootless Docker, Podman, or direct OCI runtime (`runc`/`crun`).
   - Uses native Linux cgroups v2, user namespaces, and seccomp profiles.
2. **Windows Development / Host Environment:**
   - Primary: Docker Desktop with WSL2 backend or Hyper-V containers.
   - Degraded Mode: If no container runtime daemon is detected on the host:
     - R4 shell/interpreter execution **fails closed** by default with `CONTAINER_RUNTIME_UNAVAILABLE`.
     - Host execution is permitted **only** if the mission is explicitly launched with a `--allow-local-fallback` flag and the Authority Gate possesses an administrative R4 `host_execution` grant.
     - When local fallback is active, all Step 6 process tree kill (`taskkill /F /T`) and resource bounds remain enforced.

---

*Approved for pre-implementation acceptance matrix specification.*
