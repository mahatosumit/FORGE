# Getting Started with FORGE v1.1

FORGE is a provider-neutral, governed AI engineering operating environment. It enforces strict separation between cognition, authority, and execution:

```
MODEL → PROPOSAL → AUTHORITY GATE → CAPABILITY HOST → ENVIRONMENT → OBSERVATION → LEDGER
```

## Quick Start (Zero Code Modification)

### 1. Launching FORGE Web UI

Start the AI Engineering Control Plane:

```bash
cd forge
npm run cli -- serve 3000
```

Open your browser at `http://127.0.0.1:3000`. You will be greeted by the FORGE Control Plane.

### 2. Configuring an AI Provider & Key

1. Click **Providers & Models** in the sidebar.
2. Select your provider (e.g., **NVIDIA NIM**, **OpenAI**, **Anthropic**, or **Ollama**).
3. If using NVIDIA NIM, enter your key or set `NVIDIA_API_KEY` in `.env`.
4. Click **Test Connection**. FORGE connects to the provider endpoint, reports round-trip latency, and dynamically registers all available models.
5. Select **moonshotai/kimi-k3** or your preferred model as the active primary model.

### 3. Creating a Workspace

1. Click **Workspaces** in the sidebar.
2. Verify or add your project directory path (e.g., `D:\my-project`).
3. FORGE establishes filesystem containment boundaries ensuring no out-of-boundary traversal can occur.

### 4. Running Your First Governed Mission

1. In the **Mission Control Center**, input an objective:
   ```
   Inspect the repository, identify failing unit tests, implement the minimal fix, run the test suite, and generate a verified cryptographic receipt.
   ```
2. Choose your **Authority Level**:
   - `Safe Dev`: Scoped filesystem access (`src/**`, `test/**`), strict shell command prefix, network disabled.
   - `Full Dev`: Extended workspace write, git commit access, governed HTTP capabilities.
   - `Read Only`: Read and search operations only.
3. Choose your **Verification Policy**:
   - `Standard`: Runs mechanical project test runners (`npm test`, `pytest`, etc.).
   - `Strict`: Test pass required + zero unintended repository diff.
4. Click **Launch Governed Mission**.
5. Watch the live execution stream. When an action falls outside initial authority, an **Escalation Review** prompt appears with 1-click Approve / Deny controls.
6. Upon closure, inspect the **Evidence Graph**, view the unified **Git Diff**, and verify the **Cryptographic SHA-256 Receipt Chain**.

---

## CLI Quick Reference

```bash
# Provider management & connection test
forge providers
forge providers test nvidia-nim
forge providers add custom "Custom Gateway" openai-compatible https://my-gateway/v1 CUSTOM_KEY

# Model selection
forge models
forge models select moonshotai/kimi-k3 nvidia-nim

# Workspaces
forge workspaces
forge workspace create "Billing Microservice" /path/to/project

# Git & Status
forge git status
forge git diff

# Run mission
forge run "Fix failing checkout test"

# Inspect & Verify Receipt
forge receipt <mission-id>
```
