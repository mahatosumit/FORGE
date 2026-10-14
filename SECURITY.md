# FORGE — Security Summary

The full threat model with per-row mechanisms and tests lives in ../architecture/SECURITY-THREAT-MODEL.md. This file states what a user of the V1 product can and cannot rely on.

## What is enforced mechanically

- **Authority**: every world-affecting action arrives as a typed proposal and is
  checked against scoped, expiring, revocable grants BEFORE dispatch. The
  proposal schema has no authority-bearing fields (timeout, risk, grant,
  approval) — they cannot be smuggled in.
- **Evidence integrity**: observations are written exclusively by the runtime;
  model claims must cite observation ids; the journal is append-only and
  hash-chained (SHA-256). Tampering with any record is detectable.
- **Effect boundary**: the only path from model output to the world is
  proposal → gate → capability host → environment. A repository lint
  () fails the build if any other module reaches an effect seam.
- **Secrets**: resolved only at dispatch into the execution environment; never
  in model context, never in the journal. Capture-time redaction.
- **Extensions**: packs run out-of-process, are quarantined until explicitly
  enabled, are hash-pinned, start deny-by-default, and cannot append records,
  self-grant, or reach effect seams (malicious-frame test: ).

## What is NOT enforced (honest limits)

- **OS-level isolation**: the default container" environment (Docker,
  --network none, --cap-drop ALL) for isolation-hungry work.
- **Prompt injection**: injected instructions in workspace/web/tool content
  cannot cause effects directly (they still need grants), but they CAN steer
  actions already inside the grant scope. Grant scope = blast radius.
- **Verification quality**: a model can write tautological tests or run
  favorable commands. Receipts expose tier (mechanical vs adjudicated), the
  exact commands, and the captured output so you can judge. Mutation-based
  check quality scoring is future work.
- **Journal vs root**: the hash chain detects tampering by any process running
  as you; it does not defend against root malware rewriting history and
  recomputing hashes (signing is future work). Back up mission directories for
  high assurance.
- **Windows shell shims**: .cmd/.bat shims (npm etc.) are executed via
  cmd.exe; argument quoting is handled but grant matching operates on the
  original argv vector, and no shell interpreter sees the raw argv string.

## Reporting

Security issues: see the repository's SECURITY policy.
