# RR-09 Implementation Report — 2026-10-14

Scope: `.github/workflows/ci.yml` ONLY. No application source, no other workflows, no frozen-phase artifacts touched.

## Change (exact file, before → after)

File: `.github/workflows/ci.yml` (pre-change SHA-256 `61EBD54E…`, backup `backups/ci.yml.orig`).

1. `actions/checkout@v4` → `actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`
2. `actions/setup-node@v4` → `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0`
3. Added top-level block (with justification comment):
   ```yaml
   permissions:
     contents: read
   ```
4. ASCII-only comment text (replaced an em-dash after noticing console mojibake, to keep the file plain ASCII).

Nothing else changed: name, triggers (`push`, `pull_request`), matrix (3 OS × Node 24.x), and all four `run:` steps byte-identical (verified by line diff — only 4 added lines + 2 swapped `uses:` lines).

## SHA provenance (no guessing)
Resolved live via `api.github.com` (read-only): floating `v4` and release `v4.4.0` tags resolve to the **identical** commit SHA in each repo (`type: commit`, no annotated-tag dereference). Full mapping table: `sha-mapping.md`.

## Permissions justification (narrowest sufficient scope)
Job needs: clone repo, install deps, run checks. No publishing, releases, PR mutation, checks API, or deployments; no `pull_request_target`. Single job → top-level `contents: read` is the least privilege that preserves behavior.
