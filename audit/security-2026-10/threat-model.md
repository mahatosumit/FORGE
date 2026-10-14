# FORGE — Threat Model (audit-verified)

## Assets
| Asset | Location | Sensitivity |
|---|---|---|
| Mission journals (hash-chained) | `.forge/data/missions/*/journal.jsonl` | Integrity-critical evidence |
| Provider API keys | env vars (`NVIDIA_API_KEY`, …), `.env` (untracked) | Secret |
| Bearer session token | server memory; embedded in console HTML; `.forge/session.json` | Secret (local) |
| Workspace files | user project tree | User data (must not leave workspace) |
| Artifact store | `.forge/data/missions/*/artifacts/` | Derived, may contain secrets captured at dispatch (redaction is capture-time) |
| Config (providers/credentials metadata) | `.forge/forge-config.json` | Keys masked; env var names only |

## Trust boundaries (verified)
1. **HTTP client ↔ local server.** Single principal; bearer token 48 hex. All routes except `GET /` require auth; `?token=` accepted only on `/events` (SSE). **Now enforced:** Host allowlist + Origin allowlist (F-01 fix) closes DNS-rebinding/foreign-origin paths. Loopback bind default `127.0.0.1`.
2. **Model output ↔ runtime.** Model emits proposals/claims only; typed channel validated by strict schemas; authority fields rejected; all effects pass the Proposal Gate. Prompt contents are never a security control.
3. **Runtime ↔ environment (effects).** `LocalEnvironment` is the only effect seam (with container). Confinement now canonical (F-03 fix): deepest-existing-ancestor `realpath` + real-root containment + Windows alias rejection; sandboxed exec additionally blocks `..`/absolute argv.
4. **Extensions (packs/MCP) ↔ runtime.** Out-of-process, quarantine-first, deny-by-default (design); not runtime-tested in this audit (see residual R-02).
5. **Browser rendering ↔ hostile data.** All user/model-derived strings in the console are escaped or `textContent`; latent raw sinks fixed (F-08). Console under CSP with `frame-ancestors 'none'` (F-02).
6. **Ledger continuity.** Append-only, hash-chained; single-writer lock; tamper localizes first broken seq; continuation after closure is legitimate and now verifiable (F-07).

## Attacker capabilities considered
- Malicious local web page in the operator's browser (rebinding, fetch/forms, iframes, EventSource).
- Malicious repository content (prompt injection in files/test output; pre-planted junctions/symlinks; hostile filenames).
- Malicious/derailed model output (authority smuggling, malformed structured output, misleading claims, silent-drop probing).
- Local low-privilege process racing the file system (TOCTOU) — bounded by canonical resolution + atomic replace.
- **Out of scope by design:** multi-user/tenant attackers; root-level attacker rewriting the whole journal (signing deferred — documented); physical/memory attackers.

## Security invariants (asserted in this audit)
- INV-A: No effect executes without a gate-`allow` and a `proposal.dispatched` record.
- INV-B: Effects never land outside the canonical workspace root (junction/symlink/alias resistant).
- INV-C: Model output cannot mint authority (schema + gate), and denials are typed, side-effect-free.
- INV-D: Journal integrity is verifiable independently (`verifyChain`), and integrity alarms never fire on legitimate flows (F-07 regression guard).
- INV-E: Secrets never enter prompts, journals, logs, package tarball, or audit artifacts.
- INV-F: HTTP effects require the local token, from a loopback Host, without a foreign Origin.

## Key abuse cases → outcome in audit
| Abuse case | Outcome |
|---|---|
| Rebinding page reads `/` then calls API | **Blocked** (F-01) |
| Crafted link with `?missionId=<payload>` | Rendering escaped; ULID-validated (F-08) |
| Repo contains junction to `C:\Windows` | **Blocked** after fix (F-03); reproduced before |
| `node -e…` under `["node"]`-prefix grant | Now escalated (F-04) |
| Grant `hosts:["[::1]"]`, fetch `[2001:db8::]` | **Blocked** after fix (F-06) |
| Append forged record post-closure | Fails closed via `verifyChain` (F-07 test) |
| Directive post-closure then resume | Legit continuation; resume → clean 409 |
| Hostile `onerror` goal rendered in conversation | Literal text only (playwright verified) |
