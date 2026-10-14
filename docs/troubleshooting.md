# Troubleshooting Guide for FORGE v1.1

## Common Diagnostic Checks

Run the built-in system doctor:

```bash
forge doctor
```

This verifies:
- Journal integrity across all existing missions.
- Active provider connection health and latency.
- Valid API keys and environment configurations.

---

## Frequently Encountered Issues

### 1. `Provider Connection Failed: Missing API key`
- **Cause**: The selected provider has no credentials configured.
- **Resolution**:
  - In Web UI: Go to **Providers & Models** or **API Credentials**, enter your API key, and click Save.
  - In CLI: `forge credentials add cred-nv NVIDIA_API_KEY nvapi-your-key-here` or set `export NVIDIA_API_KEY=...` in your shell or `.env`.

### 2. `Escalation Pending: fs out-of-grant`
- **Cause**: The model attempted to modify a file outside the active authority envelope (e.g. attempting to touch `package.json` in `Safe Dev` mode).
- **Resolution**:
  - Review the proposed file path in the **Escalation Review** panel.
  - Click **Approve** to mint a temporary scoped grant, or **Deny** to enforce the restriction.

### 3. `Mission Closed: blocked`
- **Cause**: The model requested an action that was denied, or exceeded its stage step budget without satisfying mechanical criteria.
- **Resolution**:
  - Check `forge inspect <missionId>` or the **Evidence Graph** in the UI to see which criteria failed.
  - Re-run with more specific instructions or adjust the authority level to `Full Dev`.

### 4. `Hash Chain Integrity Broken`
- **Cause**: Manual edits or corruption occurred in `journal.jsonl`.
- **Resolution**:
  - The ledger quarantines corrupted missions to prevent state poisoning.
  - Check the output of `forge doctor` to locate the exact record sequence mismatch.
