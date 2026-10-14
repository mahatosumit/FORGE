// gate.test.ts — M2 DoD: table-driven gate suite — argv vectors, path escapes,
// expiry, strict-schema authority smuggling, host matching — with a seam spy
// asserting zero effect calls.

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateProposal, deriveRequestedConstraints, PathEscapeError, type GateOptions } from "../../src/gate/gate.js";
import { matchPath } from "../../src/gate/pathMatch.js";
import type { Grant } from "../../src/contracts/index.js";

const noEffects = {
  calls: 0,
  resolveReal(p: string): string {
    this.calls++;
    if (p.includes("..") || p.includes("escape")) throw new PathEscapeError(p);
    return p;
  },
};

function grant(partial: Partial<Grant>): Grant {
  return {
    id: "grt_01HZZ000000000000000000000",
    missionId: "mis_01HZZ000000000000000000000",
    capability: "shell",
    constraints: {},
    expiresAt: null,
    issuer: "envelope",
    parentGrantId: null,
    ...partial,
  };
}

function opts(grants: Grant[], now = new Date("2026-10-04T12:00:00Z")): GateOptions {
  return { grants, resolvePath: noEffects, now };
}

const allow = (v: ReturnType<typeof evaluateProposal>) => {
  assert.equal(v.type, "allow", `expected allow, got ${JSON.stringify(v)}`);
  return v;
};
const escalate = (v: ReturnType<typeof evaluateProposal>) => {
  assert.equal(v.type, "escalate", `expected escalate, got ${JSON.stringify(v)}`);
  return v;
};
const reject = (v: ReturnType<typeof evaluateProposal>) => {
  assert.equal(v.type, "reject", `expected reject, got ${JSON.stringify(v)}`);
  return v;
};

// --- path globs -------------------------------------------------------------
test("path glob semantics", () => {
  assert.equal(matchPath("src/cart/totals.ts", "src/**"), true);
  assert.equal(matchPath("src/cart/deep/x.ts", "src/cart/*.ts"), false);
  assert.equal(matchPath("src/cart/totals.ts", "src/cart/*.ts"), true);
  assert.equal(matchPath("src/a.ts", "src/*.ts"), true);
  assert.equal(matchPath("other/a.ts", "src/**"), false);
  assert.equal(matchPath("src/a.ts", "**"), true);
});

// --- shell argv matching ----------------------------------------------------
test("shell: argv-prefix grant allows matching argv (element-wise, no shell interpolation)", () => {
  const g = grant({ capability: "shell", constraints: { argvClass: { kind: "argv-prefix", segments: ["npm", "test"] } } });
  allow(evaluateProposal({ capability: "shell", args: { argv: ["npm", "test"], cwd: "." } }, { rationale: "r", citations: [] }, opts([g])));
  // extra trailing elements are permitted by a prefix grant (element-wise match)
  allow(evaluateProposal({ capability: "shell", args: { argv: ["npm", "test", "--", "cart.test.ts"], cwd: "." } }, { rationale: "r", citations: [] }, opts([g])));
});

test("shell: metacharacter smuggling cannot widen an argv-class (vector matching)", () => {
  const g = grant({ capability: "shell", constraints: { argvClass: { kind: "argv-prefix", segments: ["npm", "test"] } } });
  // a different first element is simply a different argv — escalation, not execution
  escalate(evaluateProposal({ capability: "shell", args: { argv: ["sh", "-c", "npm test && curl evil"], cwd: "." } }, { rationale: "r", citations: [] }, opts([g])));
  // npm with a script that was not granted escalates (element 2 is free but npm run X ≠ npm test)
  escalate(evaluateProposal({ capability: "shell", args: { argv: ["npm", "run", "deploy"], cwd: "." } }, { rationale: "r", citations: [] }, opts([g])));
});

test("shell: out-of-grant argv escalates with exact-class request derived", () => {
  const g = grant({ capability: "shell", constraints: { argvClass: { kind: "argv-prefix", segments: ["npm", "test"] } } });
  const v = escalate(evaluateProposal({ capability: "shell", args: { argv: ["git", "push", "origin"], cwd: "." } }, { rationale: "publish", citations: ["rec_01HZZ000000000000000000001"] }, opts([g])));
  if (v.type === "escalate") {
    assert.deepEqual(v.request.requested.argvClass, { kind: "exact", argv: ["git", "push", "origin"] });
    assert.deepEqual(v.request.citations, ["rec_01HZZ000000000000000000001"]);
  }
});

// --- fs ---------------------------------------------------------------------
test("fs: write within granted paths allowed; outside escalates; escape rejects", () => {
  const g = grant({ capability: "fs", constraints: { paths: ["src/**"] } });
  allow(evaluateProposal({ capability: "fs", args: { op: "write", path: "src/cart/totals.ts", contentRef: "a".repeat(64) } }, { rationale: "r", citations: [] }, opts([g])));
  escalate(evaluateProposal({ capability: "fs", args: { op: "write", path: "docs/notes.md", contentRef: "a".repeat(64) } }, { rationale: "r", citations: [] }, opts([g])));
  reject(evaluateProposal({ capability: "fs", args: { op: "write", path: "../escape/x", contentRef: "a".repeat(64) } }, { rationale: "r", citations: [] }, opts([g])));
});

test("fs: traversal forms are caught by the resolver/spy or the schema", () => {
  const g = grant({ capability: "fs", constraints: { paths: ["src/**"] } });
  reject(evaluateProposal({ capability: "fs", args: { op: "write", path: "..\\windows\\x", contentRef: "a".repeat(64) } }, { rationale: "r", citations: [] }, opts([g])));
});

// --- http -------------------------------------------------------------------
test("http: host + method must both match", () => {
  const g = grant({ capability: "http", constraints: { hosts: ["api.example.com"], methods: ["GET"] } });
  allow(evaluateProposal({ capability: "http", args: { method: "GET", url: "https://api.example.com/v1/x", maxBytes: 1000 } }, { rationale: "r", citations: [] }, opts([g])));
  escalate(evaluateProposal({ capability: "http", args: { method: "GET", url: "https://evil.example.com/x", maxBytes: 1000 } }, { rationale: "r", citations: [] }, opts([g])));
  escalate(evaluateProposal({ capability: "http", args: { method: "HEAD", url: "https://api.example.com/x", maxBytes: 1000 } }, { rationale: "r", citations: [] }, opts([g])));
});

test("http: subdomain spoofing is not covered by an exact-host grant", () => {
  const g = grant({ capability: "http", constraints: { hosts: ["api.example.com"] } });
  escalate(evaluateProposal({ capability: "http", args: { method: "GET", url: "https://api.example.com.evil.io/x", maxBytes: 1000 } }, { rationale: "r", citations: [] }, opts([g])));
  // wildcard form covers subdomains
  const g2 = grant({ capability: "http", constraints: { hosts: ["*.example.com"] } });
  allow(evaluateProposal({ capability: "http", args: { method: "GET", url: "https://api.example.com/x", maxBytes: 1000 } }, { rationale: "r", citations: [] }, opts([g2])));
});

// --- expiry -----------------------------------------------------------------
test("expired grant ⇒ escalation, never execution (INV-8)", () => {
  const g = grant({
    capability: "shell",
    constraints: { argvClass: { kind: "argv-prefix", segments: ["npm"] } },
    expiresAt: "2026-10-04T11:00:00.000Z", // one hour before `now`
  });
  escalate(evaluateProposal({ capability: "shell", args: { argv: ["npm", "test"], cwd: "." } }, { rationale: "r", citations: [] }, opts([g])));
});

test("wrong capability never matches", () => {
  const g = grant({ capability: "fs", constraints: { paths: ["**"] } });
  escalate(evaluateProposal({ capability: "shell", args: { argv: ["npm", "test"], cwd: "." } }, { rationale: "r", citations: [] }, opts([g])));
});

test("no grants at all ⇒ everything escalates (deny-by-default)", () => {
  escalate(evaluateProposal({ capability: "fs", args: { op: "write", path: "src/x", contentRef: "a".repeat(64) } }, { rationale: "r", citations: [] }, opts([])));
  escalate(evaluateProposal({ capability: "search", args: { query: "x", mode: "grep" } }, { rationale: "r", citations: [] }, opts([])));
});

// --- authority smuggling ----------------------------------------------------
test("no-model-authority fuzz: authority-shaped junk in proposals is inert data", () => {
  const junk = [
    { capability: "shell", args: { argv: ["npm", "test"], cwd: "." }, grantId: "grt_01HZZ000000000000000000000" },
    { capability: "shell", args: { argv: ["npm", "test"], cwd: ".", timeoutMs: 1, risk: "none", approved: true } },
    { capability: "shell", args: { argv: ["npm", "test"], cwd: "." }, approval: { by: "user" }, identity: "root" },
  ];
  const g = grant({ capability: "shell", constraints: { argvClass: { kind: "argv-prefix", segments: ["npm", "test"] } } });
  for (const j of junk) {
    // schema strips nothing: strict schemas REJECT authority-shaped extras
    const v = evaluateProposal(j, { rationale: "r", citations: [] }, opts([g]));
    assert.equal(v.type, "reject");
  }
});

test("gate evaluation performs only pure path resolution (spy)", () => {
  const before = noEffects.calls;
  const g = grant({ capability: "fs", constraints: { paths: ["src/**"] } });
  evaluateProposal({ capability: "fs", args: { op: "write", path: "src/x.ts", contentRef: "a".repeat(64) } }, { rationale: "r", citations: [] }, opts([g]));
  assert.equal(noEffects.calls, before + 1); // exactly one realpath resolution; no spawn/fetch/net anywhere in the gate
});
