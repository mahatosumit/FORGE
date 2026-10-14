// host.test.ts — M3 DoD core: dispatch record precedes the effect (ADR-006
// boundary), exclusive serialization, runtime-owned timeouts, runtime-authored
// observations, verdict binding.

import test from "node:test";
import assert from "node:assert/strict";
import { CapabilityHost, VerdictMismatchError } from "../../src/capability-host/host.js";
import type { CapabilityImpl, DispatchContext } from "../../src/capability-host/types.js";
import type { ForgeRecord } from "../../src/contracts/index.js";
import { bodyFixtures, TS } from "../helpers/fixtures.js";

const noopEnv = {
  identity: { type: "local" as const, hostFingerprint: "a".repeat(64) },
  exec: async () => ({ exit: 0, signal: null, outputHandle: "h", durationMs: 1 }),
  output: () => ({ bytes: new Uint8Array(), truncated: false }),
  readFile: () => new Uint8Array(),
  putFile: () => ({ afterHash: "a".repeat(64) }),
  realpath: (p: string) => p,
  mkdir: () => {},
};

function makeHost(impl: CapabilityImpl, events: ForgeRecord[]): CapabilityHost {
  return new CapabilityHost({
    capabilities: new Map([[impl.manifest.id, impl]]),
    timeoutFor: () => 30_000,
    append: (input) => {
      const rec = {
        id: `rec_${events.length.toString(16).padStart(2, "0")}` + "0".repeat(22),
        missionId: "mis_01HZZ000000000000000000000",
        seq: events.length + 1,
        kind: input.kind,
        author: input.author,
        ts: TS,
        refs: input.refs ?? [],
        prevHash: "a".repeat(64),
        hash: "b".repeat(64),
        body: input.body,
      } as unknown as ForgeRecord;
      events.push(rec);
      return rec;
    },
    environment: () => noopEnv as unknown as DispatchContext["environment"],
  });
}

const ctx = (extra: Partial<DispatchContext> = {}): DispatchContext => ({
  workspaceRoot: ".",
  environment: noopEnv as unknown as DispatchContext["environment"],
  environmentKind: "local",
  secrets: new Map(),
  capture: () => "c".repeat(64),
  artifactBytes: () => new Uint8Array([1, 2, 3]),
  criterionResolver: () => null,
  signal: new AbortController().signal,
  ...extra,
});

const fsImpl: CapabilityImpl = {
  manifest: {
    id: "fs", version: "1.0.0", purpose: "test", environments: ["local"],
    proposalKind: "fs", constraintsVocab: ["paths"], concurrency: "parallel",
    idempotent: true, riskClass: ["write"], provenance: { pack: "core", hash: "0".repeat(64) },
  },
  async run(proposal, ctx) {
    if (proposal.capability !== "fs") throw new Error("mismatch");
    const r = ctx.environment.putFile(proposal.args.path, new Uint8Array([9]));
    return { observationKind: "observation.fs", observation: { op: "write", path: proposal.args.path, beforeHash: null, afterHash: r.afterHash, diffRef: null } };
  },
};

const ALLOWED = {
  type: "allow" as const,
  grantId: "grt_01HZZ000000000000000000000",
  resolved: { capability: "fs" as const, args: { op: "write" as const, path: "src/x.ts", contentRef: "a".repeat(64) }, paths: ["src/x.ts"], hosts: [], argv: [] },
};

test("dispatch record is appended BEFORE the capability effect runs (ADR-006)", async () => {
  const events: ForgeRecord[] = [];
  let effectRan = false;
  let dispatchSeenBeforeEffect = false;
  const impl: CapabilityImpl = {
    ...fsImpl,
    async run(p, c) {
      // at effect time, the journal must already contain the dispatch record
      dispatchSeenBeforeEffect = events.some((r) => r.kind === "proposal.dispatched");
      effectRan = true;
      return fsImpl.run(p, c, { timeoutMs: 1, signal: new AbortController().signal });
    },
  };
  const host = makeHost(impl, events);
  const proposal = { capability: "fs" as const, args: { op: "write" as const, path: "src/x.ts", contentRef: "a".repeat(64) } };
  const obs = await host.execute(proposal, structuredClone(ALLOWED), "rec_test", ctx());
  assert.equal(effectRan, true);
  assert.equal(dispatchSeenBeforeEffect, true);
  assert.equal(events[0]!.kind, "proposal.dispatched");
  assert.equal(events[1]!.kind, "observation.fs");
  assert.equal(events[1]!.author, "runtime"); // INV-1: runtime-authored
  assert.equal(obs.kind, "observation.fs");
});

test("host refuses dispatch without an allow verdict (INV-3)", async () => {
  const events: ForgeRecord[] = [];
  const host = makeHost(fsImpl, events);
  const proposal = { capability: "fs" as const, args: { op: "write", path: "src/x.ts", contentRef: "a".repeat(64) } };
  await assert.rejects(
    // @ts-expect-error deliberate: escalate verdict must not execute
    () => host.execute(proposal, { type: "escalate", request: { capability: "fs", requested: {}, rationale: "r", citations: [] } }, "rec_test", ctx()),
    VerdictMismatchError,
  );
  await assert.rejects(
    // @ts-expect-error deliberate: malformed verdict must not execute
    () => host.execute(proposal, { type: "allow" } as never, "rec_test", ctx()),
    VerdictMismatchError,
  );
  assert.equal(events.length, 0); // nothing journaled, nothing executed
});

test("verdict bound to proposal capability", async () => {
  const events: ForgeRecord[] = [];
  const host = makeHost(fsImpl, events);
  const proposal = { capability: "fs" as const, args: { op: "write", path: "src/x.ts", contentRef: "a".repeat(64) } };
  const wrongVerdict = { ...structuredClone(ALLOWED), resolved: { ...ALLOWED.resolved, capability: "shell" as const } };
  await assert.rejects(() => host.execute(proposal, wrongVerdict, "rec_test", ctx()), VerdictMismatchError);
});

test("exclusive capabilities serialize", async () => {
  const events: ForgeRecord[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const shellImpl: CapabilityImpl = {
    manifest: { id: "shell", version: "1.0.0", purpose: "t", environments: ["local"], proposalKind: "shell", constraintsVocab: ["argvClass"], concurrency: "exclusive", idempotent: false, riskClass: ["execute"], provenance: { pack: "core", hash: "0".repeat(64) } },
    async run() {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return { observationKind: "observation.shell", observation: bodyFixtures["observation.shell"]() };
    },
  };
  const host = makeHost(shellImpl, events);
  const mkVerdict = () => ({
    type: "allow" as const,
    grantId: "grt_01HZZ000000000000000000000",
    resolved: { capability: "shell" as const, args: { argv: ["npm", "test"], cwd: "." }, paths: [], hosts: [], argv: ["npm", "test"] },
  });
  await Promise.all([
    host.execute({ capability: "shell", args: { argv: ["npm", "test"], cwd: "." } }, mkVerdict(), "rec_a", ctx()),
    host.execute({ capability: "shell", args: { argv: ["npm", "test"], cwd: "." } }, mkVerdict(), "rec_b", ctx()),
  ]);
  assert.equal(maxConcurrent, 1);
});
