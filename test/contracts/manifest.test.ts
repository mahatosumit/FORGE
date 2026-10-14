// manifest.test.ts — CapabilityManifest: valid manifests; invalid proposal
// schemas / constraints / risk / provenance; size limits; unsupported fields.
// The manifest is data: nothing here executes anything.

import test from "node:test";
import assert from "node:assert/strict";
import { CapabilityManifestSchema, CONSTRAINT_VOCAB } from "../../src/contracts/grants.js";

const HASH = "a".repeat(64);

export const validManifest = {
  id: "fs",
  version: "1.2.0",
  purpose: "read and write files in the workspace",
  environments: ["local", "container"],
  proposalKind: "fs",
  constraintsVocab: ["paths", "exclusive"],
  concurrency: "parallel",
  idempotent: true,
  riskClass: ["write"],
  provenance: { pack: "core", hash: HASH },
};

test("valid manifest parses and stays data", () => {
  const m = CapabilityManifestSchema.parse(validManifest);
  assert.equal(m.id, "fs");
  assert.equal(m.provenance.pack, "core");
  // data-only: parsed manifest has no callables
  for (const v of Object.values(m)) {
    assert.equal(typeof v !== "function", true);
  }
});

test("invalid proposal kinds rejected (closed union tie)", () => {
  assert.throws(() => CapabilityManifestSchema.parse({ ...validManifest, proposalKind: "telepathy" }));
  assert.throws(() => CapabilityManifestSchema.parse({ ...validManifest, proposalKind: "fs-write" }));
});

test("invalid constraint declarations rejected", () => {
  assert.throws(() =>
    CapabilityManifestSchema.parse({ ...validManifest, constraintsVocab: ["grantIds"] }),
  );
  // empty vocab is VALID by design (read-only capabilities) — see ADR-007
  assert.doesNotThrow(() => CapabilityManifestSchema.parse({ ...validManifest, constraintsVocab: [] }));
  assert.throws(() =>
    CapabilityManifestSchema.parse({
      ...validManifest,
      constraintsVocab: [...CONSTRAINT_VOCAB, "bogus"],
    }),
  );
});

test("invalid risk declarations rejected", () => {
  assert.throws(() => CapabilityManifestSchema.parse({ ...validManifest, riskClass: [] }));
  assert.throws(() => CapabilityManifestSchema.parse({ ...validManifest, riskClass: ["omnipotent"] }));
});

test("invalid environment / observation-ish / concurrency declarations rejected", () => {
  assert.throws(() => CapabilityManifestSchema.parse({ ...validManifest, environments: ["ssh"] }));
  assert.throws(() => CapabilityManifestSchema.parse({ ...validManifest, environments: [] }));
  assert.throws(() => CapabilityManifestSchema.parse({ ...validManifest, concurrency: "sometimes" }));
  assert.throws(() => CapabilityManifestSchema.parse({ ...validManifest, idempotent: "yes" }));
});

test("invalid provenance rejected", () => {
  assert.throws(() =>
    CapabilityManifestSchema.parse({ ...validManifest, provenance: { pack: "core", hash: "not-a-hash" } }),
  );
  assert.throws(() =>
    CapabilityManifestSchema.parse({ ...validManifest, provenance: { pack: "", hash: HASH } }),
  );
  assert.throws(() =>
    CapabilityManifestSchema.parse({ ...validManifest, provenance: { pack: "core" } }),
  );
});

test("size limits enforced", () => {
  assert.throws(() => CapabilityManifestSchema.parse({ ...validManifest, purpose: "x".repeat(201) }));
  assert.throws(() => CapabilityManifestSchema.parse({ ...validManifest, version: "1.2" }));
  assert.throws(() => CapabilityManifestSchema.parse({ ...validManifest, id: "UPPER" }));
  assert.throws(() => CapabilityManifestSchema.parse({ ...validManifest, id: "x".repeat(65) }));
});

test("unsupported fields rejected (strict)", () => {
  assert.throws(() => CapabilityManifestSchema.parse({ ...validManifest, execute: "everything" }));
  assert.throws(() =>
    CapabilityManifestSchema.parse({ ...validManifest, provenance: { pack: "core", hash: HASH, sign: true } }),
  );
});

test("environment kinds limited to the v1 maximum (local, container)", () => {
  const m = CapabilityManifestSchema.parse({ ...validManifest, environments: ["container"] });
  assert.deepEqual(m.environments, ["container"]);
});
