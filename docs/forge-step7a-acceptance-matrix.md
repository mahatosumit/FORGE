# FORGE STEP 7A — ACCEPTANCE MATRIX & ADVERSARIAL ESCAPE TEST SUITE

**Document Version:** 1.0.0  
**Source Architecture:** [docs/forge-step7a-isolation-architecture.md](file:///d:/quack%20pro/forge/docs/forge-step7a-isolation-architecture.md)  
**Status:** APPROVED ACCEPTANCE SPECIFICATION  
**Scope:** Execution Isolation, Sandboxed Environments & Adversarial Escape Containment  

---

## 1. ACCEPTANCE CRITERIA SUMMARY

Step 7A is certified **only** when all 10 adversarial sandbox escape tests (SANDBOX-001 through SANDBOX-010) and all 4 architectural invariants (INV-15 through INV-18) pass with genuine behavioral boundary evidence on an isolated execution runtime.

Aggregate test counts or mocked assertions do **not** constitute proof of isolation.

---

## 2. ADVERSARIAL ESCAPE TEST SPECIFICATIONS (SANDBOX-001 THROUGH SANDBOX-010)

### SANDBOX-001 — Host Filesystem Read Protection
- **Target Threat:** Attacker inside sandbox attempts directory traversal or direct absolute paths to inspect host OS files (e.g., `/etc/shadow`, `/etc/passwd`, `C:\Windows\System32`, host user SSH keys `~/.ssh/id_rsa`).
- **Attack Payload:**
  ```sh
  cat /etc/shadow 2>/dev/null || cat /root/.ssh/id_rsa 2>/dev/null || type %USERPROFILE%\.ssh\id_rsa
  ```
- **Execution Condition:** Sandboxed container with `/workspace` mounted.
- **Pass Criteria:**
  1. The guest process receives `Permission denied` or `No such file or directory`.
  2. The output captured in ledger contains **0 bytes** of host private files.
  3. Exit code is non-zero (failure).

---

### SANDBOX-002 — Asynchronous Grandchild Process Termination
- **Target Threat:** An authorized program spawns detached background worker daemons or deep grandchild processes that attempt to persist after task cancellation.
- **Attack Payload:**
  ```sh
  node -e "const { spawn } = require('child_process'); spawn('node', ['-e', 'setInterval(()=>{}, 100)'], { detached: true, stdio: 'ignore' });"
  ```
- **Execution Condition:** Execution initiated; `AbortSignal` triggered 200 ms into flight.
- **Pass Criteria:**
  1. Container destruction primitive is invoked (`terminateContainer`).
  2. The container transitions to `DESTROYED`.
  3. Inspection of host OS process table confirms **zero** orphaned container or guest processes running.

---

### SANDBOX-003 — Workspace Containment (Write Outside Workspace)
- **Target Threat:** Malicious script attempts to write outside the mounted `/workspace` directory (e.g. attempting to overwrite system binaries in `/bin`, `/usr/bin`, or host parent directories `../`).
- **Attack Payload:**
  ```sh
  echo "ROOTKIT" > /bin/sh || echo "ESCAPE" > /workspace/../../host_file.txt
  ```
- **Execution Condition:** Container running with `--read-only` root filesystem.
- **Pass Criteria:**
  1. Write attempt fails immediately with `Read-only file system` or path escape error.
  2. Host filesystem outside `workspaceRoot` is bit-for-bit unchanged.
  3. No files created in parent directories.

---

### SANDBOX-004 — Host Environment & Secret Protection
- **Target Threat:** Script attempts to inspect `env` or `/proc/1/environ` to exfiltrate host environment variables, LLM API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), or host system tokens.
- **Attack Payload:**
  ```sh
  printenv && cat /proc/1/environ
  ```
- **Execution Condition:** Standard sandboxed execution under `ExecutionProvider`.
- **Pass Criteria:**
  1. Output contains **only** container-scoped variables (`PATH`, `HOME`, `WORKSPACE_DIR`).
  2. Host environment secrets are completely absent from stdout/stderr.
  3. Secret redaction engine records zero unredacted leaks.

---

### SANDBOX-005 — Network Isolation under `network:none`
- **Target Threat:** Malicious code attempts to phone home, exfiltrate stolen data, scan local network (RFC 1918), or query cloud metadata (`169.254.169.254`).
- **Attack Payload:**
  ```sh
  curl -s --connect-timeout 2 http://169.254.169.254/latest/meta-data || nc -z -v -w2 1.1.1.1 53
  ```
- **Execution Condition:** Proposal evaluated without explicit network grant; `isolationProfile = "sandboxed"` (`network:none`).
- **Pass Criteria:**
  1. Network request fails with `Network is unreachable` or socket initialization failure.
  2. 0 network packets egress from the sandbox container.
  3. Exit code is non-zero.

---

### SANDBOX-006 — Privilege Escalation Rejection
- **Target Threat:** Guest process attempts to execute `setuid` binaries, escalate privileges via `sudo`, or exploit Linux capabilities to gain `root` within the container or host.
- **Attack Payload:**
  ```sh
  sudo -n whoami || su root || chroot /workspace
  ```
- **Execution Condition:** Container initialized with `CAP_DROP_ALL`, `--security-opt=no-new-privileges:true`, and non-root user (`UID 1000`).
- **Pass Criteria:**
  1. Command execution fails with `sudo: command not found` or `Operation not permitted`.
  2. Effective UID remains unprivileged (`UID 1000`).

---

### SANDBOX-007 — Malicious Program Host Damage Resistance
- **Target Threat:** An authorized, syntactically valid Python/Node script contains destructive logic (e.g. `shutil.rmtree("/")`, `rm -rf /*`, fork bomb `:(){ :|:& };:`).
- **Attack Payload:**
  ```python
  import os, shutil
  os.system("rm -rf /* 2>/dev/null")
  ```
- **Execution Condition:** Sandboxed container execution.
- **Pass Criteria:**
  1. Script fails or damages only ephemeral `/tmp`.
  2. Host OS files, host workspace files outside `/workspace`, and host system health are 100% unaffected.
  3. Host machine remains fully operational and responsive.

---

### SANDBOX-008 — Process Tree Annihilation on Interruption
- **Target Threat:** A complex tree of processes (Parent $\to$ Child $\to$ Grandchild) running heavy computations or I/O loops is abruptly cancelled.
- **Attack Payload:**
  ```sh
  bash -c "bash -c 'bash -c \"while true; do echo active; sleep 0.1; done\" & wait' & wait"
  ```
- **Execution Condition:** Cancellation signal triggered while all 3 tiers are active.
- **Pass Criteria:**
  1. Container destruction terminates all 3 tiers atomically.
  2. Zero surviving PIDs exist inside or outside the container.
  3. Host CPU and memory return to baseline immediately.

---

### SANDBOX-009 — Ledger & Authority State Tampering Rejection
- **Target Threat:** Sandboxed code attempts to alter the mission ledger, insert fake approval records, overwrite `journal.jsonl`, or modify grant tables in `db.sqlite`.
- **Attack Payload:**
  ```sh
  find / -name "journal.jsonl" -exec rm -f {} + 2>/dev/null || rm -f /workspace/.forge/db.sqlite
  ```
- **Execution Condition:** The FORGE ledger is managed exclusively by the host process.
- **Pass Criteria:**
  1. `journal.jsonl` is not mounted and cannot be discovered or accessed by the container.
  2. Cryptographic ledger hash chain remains 100% intact and valid.
  3. Verification engine confirms zero unauthorized modifications.

---

### SANDBOX-010 — Container Daemon Socket Abuse Protection
- **Target Threat:** Attacker looks for `/var/run/docker.sock` or `/run/podman/podman.sock` to escape the container by issuing API commands directly to the host container daemon.
- **Attack Payload:**
  ```sh
  curl -s --unix-socket /var/run/docker.sock http://localhost/containers/json
  ```
- **Execution Condition:** Container configuration verified.
- **Pass Criteria:**
  1. No container daemon sockets exist inside the sandbox.
  2. Attack fails with `No such file or directory` or `Connection refused`.
  3. Host container daemon logs show zero requests received from the sandbox.

---

## 3. ARCHITECTURAL INVARIANTS VERIFICATION MATRIX

| Invariant ID | Name | Architectural Requirement | Verification Mechanism |
| :--- | :--- | :--- | :--- |
| **INV-15** | **Isolation is Authoritative** | The model runtime and proposal arguments cannot specify or override the `isolationProfile`. | Test proposal providing `args: { environment: "host" }` is executed under `sandboxed` profile. |
| **INV-16** | **Host Execution is Exceptional** | R4 shell and interpreter execution mandates sandboxing unless an explicit administrative R4 `host_execution` grant is active. | Test: R4 proposal without `host_execution` grant fails if container runtime is unavailable; succeeds in container when runtime is available. |
| **INV-17** | **Sandbox Destruction is Kill Primitive** | Host supervisor terminates the container as an atomic unit rather than attempting internal PID termination. | Abort during multi-tier process execution triggers container stop $\to$ verification of container non-existence. |
| **INV-18** | **Evidence Survives Destruction** | The container is ephemeral, but stdout/stderr, artifacts, and exit metadata survive destruction and are committed to the host ledger. | Verify `observation.output` and `observation.artifact` records are committed to ledger *after* container is destroyed. |

---

## 4. PRE-IMPLEMENTATION VERIFICATION CHECKLIST

Before modifying production code for Step 7A:
- [x] Step 6 Closed and frozen (253/253 tests pass, 0 Category-E primitives).
- [x] Threat model & trust boundaries established in `docs/forge-step7a-isolation-architecture.md`.
- [x] Acceptance criteria defined for SANDBOX-001 through SANDBOX-010 in `docs/forge-step7a-acceptance-matrix.md`.
- [x] Invariants INV-15 through INV-18 specified with exact failure conditions.
- [ ] User review and approval of the Step 7A architecture and acceptance matrix.

---
*Approved for Step 7A implementation planning.*
