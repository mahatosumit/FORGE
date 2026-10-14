# Cryptographic Receipts in FORGE v1.1

Upon closure, FORGE produces an immutable, cryptographically verifiable receipt.

## Receipt Structure

A complete FORGE receipt contains:
- **`missionId`**: Unique identifier for the mission.
- **`closure`**: Final outcome (`verified`, `completed-unverified`, `blocked`, `failed`).
- **`weakestTier`**: Weakest verification tier across all evaluated criteria (`mechanical`, `adjudicated`, `none`).
- **`criteria`**: List of all criteria and their verdicts.
- **`ledgerRange`**: Sequential record span from genesis (`seq: 0`) to closure.
- **`chainIntegrity`**: Validated SHA-256 hash pointer chain across all journal entries.
- **`receiptHash`**: Cryptographic SHA-256 digest over the finalized closure body.

## Verifying Integrity

Anyone can verify a receipt without trusting the model or the UI:

### In Web UI:
- Click the **Cryptographic Receipt** tab.
- Click **Verify Hash Chain**: The runtime parses every raw record in `journal.jsonl`, recalculates each hash preimage from `prevHash`, and confirms `ok: true`.

### In CLI:
```bash
forge receipt <missionId>
```
Output:
```text
=== FORGE CRYPTOGRAPHIC RECEIPT ===
{
  "closure": "verified",
  "criteria": [
    { "criterionId": "cri_01JB...", "result": "pass", "tier": "mechanical" }
  ],
  "seqRange": [0, 42]
}

Hash Chain Integrity: VALID (All 43 records verified)
```
