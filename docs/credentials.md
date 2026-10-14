# Credential & Secret Management in FORGE v1.1

FORGE treats secrets with zero-trust architectural rigor.

## Security Invariants

1. **No Raw Secrets in Ledger or Receipts**:
   API keys, tokens, and system secrets are never recorded in plaintext in journals, records, receipts, or telemetry.
2. **Automatic Redaction (F-06/F-07)**:
   Any process stdout, stderr, or tool observation that contains known credentials is systematically scrubbed and replaced with `[REDACTED:SECRET]`.
3. **Key Masking**:
   Keys are always displayed masked (e.g. `nvap••••••••l_Lz`) in both the Web UI and the CLI.
4. **Environment Isolation**:
   Credentials can be backed by OS environment variables (`NVIDIA_API_KEY`, `OPENAI_API_KEY`, etc.) or stored in `.forge/.env` with strict local permissions.

## Managing Credentials

### In Web UI:
- Open **API Credentials** from the sidebar.
- Enter the environment variable name and secret value.
- FORGE saves the credential reference and applies masking immediately.

### In CLI:
```bash
# List credentials with masked status
forge credentials

# Add or update credential
forge credentials add cred-nv NVIDIA_API_KEY nvapi-your-key-here

# Verify resolution
forge credentials test cred-nv
```
