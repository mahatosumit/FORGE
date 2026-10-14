// FORGE packs — extension boundary (ADR-0009, EXTENSIONS.md).
// Packs add capabilities ONLY: manifest + out-of-process sidecar speaking a
// JSON-lines protocol over stdio. Sidecars can never append ledger records,
// issue grants, or reach effect seams directly — the host mediates every call
// and authors every observation (INV-15). Lifecycle: install → quarantine →
// explicit enable. Deny-by-default: enabling grants nothing.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CapabilityManifestSchema, type CapabilityManifest } from "../contracts/grants.js";
import type { CapabilityImpl, DispatchContext } from "../capability-host/types.js";
import type { Proposal } from "../contracts/index.js";
import type { RecordKind } from "../contracts/records.js";

export type PackState = "quarantined" | "enabled";

export interface PackRecord {
  id: string;
  state: PackState;
  manifestHash: string;
  entry: string; // path to the sidecar entry script
  capabilities: string[];
}

export class PackError extends Error {}

/** Admission is a typed boundary: schema violations surface as PackError. */
function parseManifestOrPackError(raw: unknown): CapabilityManifest {
  try {
    return CapabilityManifestSchema.parse(raw);
  } catch (e) {
    const first = (e as { issues?: Array<{ path?: Array<string | number>; message?: string }> }).issues?.[0];
    const where = first?.path?.length ? ` at ${first.path.join(".")}` : "";
    throw new PackError(`pack manifest rejected${where}: ${first?.message ?? (e as Error).message}`);
  }
}

export interface PackRegistry {
  packs: Record<string, PackRecord>;
}

export class PackManager {
  private registry: PackRegistry = { packs: Object.create(null) as Record<string, PackRecord> };

  constructor(private readonly packsDir: string) {
    mkdirSync(packsDir, { recursive: true });
    const regPath = join(packsDir, "registry.json");
    if (existsSync(regPath)) {
      // RR-02 hardening: a corrupt registry is a typed, actionable failure —
      // never a raw JSON.parse crash, and never a prototype-bearing map.
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(regPath, "utf8"));
      } catch (e) {
        throw new PackError(`pack registry is corrupt (${regPath}): ${(e as Error).message} — remove or restore the file to continue`);
      }
      if (typeof parsed !== "object" || parsed === null || typeof (parsed as PackRegistry).packs !== "object" || (parsed as PackRegistry).packs === null) {
        throw new PackError(`pack registry has an invalid shape (${regPath})`);
      }
      this.registry = { packs: Object.assign(Object.create(null) as Record<string, PackRecord>, (parsed as PackRegistry).packs) };
    }
  }

  private lookup(packId: string): PackRecord | undefined {
    // RR-02 hardening: own-key only — "constructor"/"toString" must never
    // resolve to inherited Object members.
    return Object.hasOwn(this.registry.packs, packId) ? this.registry.packs[packId] : undefined;
  }

  private persist(): void {
    writeFileSync(join(this.packsDir, "registry.json"), JSON.stringify(this.registry, null, 2));
  }

  /** Install: validate manifest + entry, record hash, land in QUARANTINE. */
  install(packDir: string): PackRecord {
    const manifestPath = join(packDir, "manifest.json");
    if (!existsSync(manifestPath)) throw new PackError("manifest.json missing");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      throw new PackError(`pack manifest is not valid JSON: ${(e as Error).message}`);
    }
    const manifest = parseManifestOrPackError(raw);
    const entry = join(packDir, "sidecar.mjs");
    if (!existsSync(entry)) throw new PackError("sidecar.mjs missing");
    const manifestHash = createHash("sha256")
      .update(JSON.stringify(manifest) + readFileSync(entry))
      .digest("hex");
    // re-install with changed content re-enters quarantine (no auto-update)
    const record: PackRecord = {
      id: manifest.id, state: "quarantined", manifestHash,
      entry, capabilities: [manifest.id],
    };
    this.registry.packs[manifest.id] = record;
    this.persist();
    return record;
  }

  /** Explicit enable — the ONLY way out of quarantine. Grants nothing. */
  enable(packId: string, reviewedHash: string): void {
    const rec = this.lookup(packId);
    if (!rec) throw new PackError(`unknown pack ${packId}`);
    // recompute from on-disk content: any change since review re-quarantines
    const manifestPath = rec.entry.replace(/sidecar.mjs$/, "manifest.json");
    const current = createHash("sha256")
      .update(JSON.stringify(JSON.parse(readFileSync(manifestPath, "utf8"))) + readFileSync(rec.entry))
      .digest("hex");
    if (current !== reviewedHash || current !== rec.manifestHash) {
      throw new PackError(`pack ${packId} content changed since review (hash mismatch) — re-review required`);
    }
    rec.state = "enabled";
    this.persist();
  }

  /** Build capability impls for ENABLED packs; capabilities run in a sidecar
   *  process and are behind the same Gate as built-ins. */
  capabilityImpls(capture: (bytes: Uint8Array) => string): Map<string, CapabilityImpl> {
    const out = new Map<string, CapabilityImpl>();
    for (const rec of Object.values(this.registry.packs)) {
      if (!rec || typeof rec !== "object" || rec.state !== "enabled") continue; // deny-by-default
      const manifest = this.loadManifest(rec);
      const impl = sidecarCapabilityImpl(rec, manifest, capture);
      out.set(manifest.id, impl);
    }
    return out;
  }

  private loadManifest(rec: PackRecord): CapabilityManifest {
    let manifestRaw: unknown;
    let sidecarBytes: Buffer;
    try {
      manifestRaw = JSON.parse(readFileSync(rec.entry.replace(/sidecar\.mjs$/, "manifest.json"), "utf8"));
      sidecarBytes = readFileSync(rec.entry);
    } catch (e) {
      throw new PackError(`pack ${rec.id} content is unreadable (${(e as Error).message}) — re-review required`);
    }
    const m = parseManifestOrPackError(manifestRaw);
    const hash = createHash("sha256").update(JSON.stringify(m) + sidecarBytes).digest("hex");
    if (hash !== rec.manifestHash) throw new PackError(`pack ${rec.id} hash mismatch — re-review required`);
    return m;
  }
}

// ---------------------------------------------------------------------------
// Sidecar protocol (host-initiated request/response over stdio):
//   host → sidecar: {"id": "<n>", "proposal": <Proposal>}
//   sidecar → host: {"id": "<n>", "ok": true,  "observation": <body>}   |
//                    {"id": "<n>", "ok": false, "error": "<msg>"}
// Any non-conforming frame → security violation: sidecar killed, dispatch
// fails with a security note (INV-15).
// ---------------------------------------------------------------------------

function sidecarCapabilityImpl(
  rec: PackRecord,
  manifest: CapabilityManifest,
  capture: (bytes: Uint8Array) => string,
): CapabilityImpl {
  return {
    manifest,
    async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal }) {
      // RR-02 hardening: sidecars get the same minimal environment treatment as
      // every other exec seam — no ambient secrets, deterministic cwd.
      const childEnv: Record<string, string> = {};
      for (const k of ["PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TMP", "TEMP"]) {
        const v = process.env[k];
        if (v !== undefined) childEnv[k] = v;
      }
      const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [rec.entry], {
        stdio: ["pipe", "pipe", "pipe"],
        signal: opts.signal,
        env: childEnv,
        cwd: dirname(rec.entry),
      });
      const frameId = "1";
      return new Promise((resolve, rejectFrame) => {
        // RR-02 hardening: bound child lifetime — resolve/reject only after the
        // child exits (or a short cap), so the pack directory is released and
        // no orphan sidecar lingers.
        const reap = (child2: typeof child, done: () => void, capMs = 1500): void => {
          if (child2.exitCode !== null || child2.signalCode !== null) { done(); return; }
          const t = setTimeout(done, capMs);
          child2.once("exit", () => { clearTimeout(t); done(); });
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reap(child, () => {}, 500);
          rejectFrame(new Error("sidecar timeout"));
        }, opts.timeoutMs);
        let buffer = "";
        let resolved = false;
        // RR-02 hardening: spawn faults (entry deleted after enable, EACCES,
        // aborted signal) must reject with a typed PackError, never surface as
        // an uncaught 'error' event that takes down the host process.
        child.on("error", (err: Error) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          rejectFrame(new PackError(`pack ${rec.id} sidecar failed to start: ${err.message}`));
        });
        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            let frame: unknown;
            try { frame = JSON.parse(line); } catch {
              resolved = true; clearTimeout(timer); child.kill("SIGKILL");
              reap(child, () => rejectFrame(new Error(`INV-15 violation: non-JSON frame from sidecar (logged as security.note)`)));
              return;
            }
            const f = frame as { id?: unknown; ok?: unknown; observation?: unknown; error?: unknown };
            if (f.id !== frameId) {
              resolved = true; clearTimeout(timer); child.kill("SIGKILL");
              reap(child, () => rejectFrame(new Error(`INV-15 violation: unexpected frame from sidecar`)));
              return;
            }
            resolved = true; clearTimeout(timer);
            child.kill();
            if (f.ok === true && f.observation && typeof f.observation === "object") {
              const body = f.observation as Record<string, unknown>;
              // host authors the observation: capture any bytes ref sidecars claim
              const ref = typeof body["outputRef"] === "string" ? body["outputRef"] : null;
              if (ref) capture(new TextEncoder().encode(ref));
              reap(child, () => resolve({ observationKind: observationKindFor(manifest), observation: body }));
            } else {
              reap(child, () => rejectFrame(new Error(`sidecar error: ${String(f.error ?? "unknown").slice(0, 200)}`)));
            }
          }
        });
        child.stderr.on("data", () => { /* stderr is not protocol */ });
        child.stdin.on("error", () => { /* EPIPE when the child dies early — surfaced via exit */ });
        child.on("exit", () => {
          if (!resolved) { clearTimeout(timer); rejectFrame(new PackError(`pack ${rec.id} sidecar exited before responding`)); }
        });
        child.stdin.write(JSON.stringify({ id: frameId, proposal }) + "\n");
      });
    },
  };
}

// Observation kind derivation: sidecar observations reuse the built-in
// observation record kind matching the capability's proposal kind.
function observationKindFor(manifest: CapabilityManifest): RecordKind {
  return ("observation." + manifest.proposalKind) as RecordKind;
}
