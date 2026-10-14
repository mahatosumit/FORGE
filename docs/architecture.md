# Architecture Specification of FORGE v1.1

## Architectural Principle

```
MODEL → PROPOSAL → AUTHORITY GATE → CAPABILITY HOST → ENVIRONMENT → OBSERVATION → LEDGER
```

## System Layers

1. **Contracts Tier (`src/contracts/`)**:
   Pure schemas and domain types (Zod). Defines records, proposals, criteria, grants, stages, and model events. Zero side effects.
2. **Codec Tier (`src/codec/`)**:
   Deterministic serialization, cryptographic hash chaining (`prevHash -> record -> sha256`), and tamper-evident decoding.
3. **Ledger Tier (`src/ledger/`)**:
   Append-only journal (`journal.jsonl`) paired with fast read projections (`projections.sqlite`).
4. **Gate Tier (`src/gate/`)**:
   Pure mathematical authorization evaluator. Compares proposed capability invocations against active grant constraints.
5. **Grants Tier (`src/grants/`)**:
   Cryptographic capability tokens, minting, scoping, attenuation, and revocation.
6. **Capabilities Host (`src/capability-host/` & `src/capabilities/`)**:
   Central dispatcher for built-in tools (`fs`, `shell`, `git`, `http`, `search`, `verify`, `artifact`).
7. **Environments Tier (`src/environments/`)**:
   Physical isolation seam (`LocalEnvironment`, `ContainerEnvironment`) where system processes and filesystem mutations take place.
8. **Config Store (`src/config/`)**:
   Persistent provider, model, credentials, workspace, and routing policy configuration.
9. **API & Web UI (`src/api/`)**:
   Unified REST + SSE HTTP server and single-page AI Engineering Control Plane.
10. **CLI Tier (`src/cli/`)**:
    Unified stateless command-line interface sharing runtime engines with the Web UI.
