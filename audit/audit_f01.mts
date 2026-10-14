import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { httpImpl, HTTP_MAX_HOPS } from "../src/capabilities/http.js";
import type { DispatchContext } from "../src/capability-host/types.js";
import { evaluateProposal } from "../src/gate/gate.js";
import { GrantSchema } from "../src/contracts/grants.js";
import { ProposalSchema } from "../src/contracts/proposals.js";

function makeCtx(isAllowed: (url: string) => boolean): DispatchContext {
  return {
    workspaceRoot: ".",
    environment: {} as never,
    environmentKind: "local",
    secrets: new Map(),
    capture: () => "c".repeat(64),
    artifactBytes: () => null,
    criterionResolver: () => null,
    signal: new AbortController().signal,
    urlAuthority: isAllowed,
  };
}

async function runAudit() {
  console.log("=== F-01 HTTP REDIRECT AUDIT ===");

  // 1. Cross-host redirect
  {
    let evilHits = 0;
    const evil: Server = createServer((_req, res) => { evilHits++; res.writeHead(200); res.end("stolen"); });
    await new Promise<void>((r) => evil.listen(0, "127.0.0.1", () => r()));
    const evilPort = (evil.address() as { port: number }).port;

    const granted: Server = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${evilPort}/steal` });
      res.end();
    });
    await new Promise<void>((r) => granted.listen(0, "127.0.0.1", () => r()));
    const grantedPort = (granted.address() as { port: number }).port;

    const res = await httpImpl.run(
      { capability: "http", args: { method: "GET", url: `http://127.0.0.1:${grantedPort}/`, maxBytes: 1000 } },
      makeCtx((u) => {
        try { return new URL(u).port === String(grantedPort); } catch { return false; }
      }),
      { timeoutMs: 5000, signal: new AbortController().signal },
    ) as { observation: { status: number; effectiveUrl: string; redirectBlocked: boolean } };

    assert.equal(evilHits, 0, "Test 1: evil.example must receive ZERO requests");
    assert.equal(res.observation.redirectBlocked, true, "Test 1: redirectBlocked must be true");
    assert.equal(res.observation.status, 302, "Test 1: status is 302");
    granted.close(); evil.close();
    console.log("✔ Test 1 passed: Cross-host redirect blocked with 0 requests to evil");
  }

  // 2. Same-host redirect
  {
    let hops = 0;
    const s: Server = createServer((req, res) => {
      hops++;
      if (hops === 1) { res.writeHead(302, { location: "/step2" }); res.end(); }
      else { res.writeHead(200); res.end("ok"); }
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const res = await httpImpl.run(
      { capability: "http", args: { method: "GET", url: base + "/", maxBytes: 1000 } },
      makeCtx((u) => u.startsWith(base)),
      { timeoutMs: 5000, signal: new AbortController().signal },
    ) as { observation: { status: number; effectiveUrl: string; redirectBlocked: boolean } };

    assert.equal(hops, 2);
    assert.equal(res.observation.status, 200);
    assert.equal(res.observation.effectiveUrl, `${base}/step2`);
    assert.equal(res.observation.redirectBlocked, false);
    s.close();
    console.log("✔ Test 2 passed: Same-host redirect succeeds");
  }

  // 3. Explicitly authorized second host
  {
    let host2Hits = 0;
    const s2: Server = createServer((_req, res) => { host2Hits++; res.writeHead(200); res.end("s2 ok"); });
    await new Promise<void>((r) => s2.listen(0, "127.0.0.1", () => r()));
    const p2 = (s2.address() as { port: number }).port;

    const s1: Server = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${p2}/` });
      res.end();
    });
    await new Promise<void>((r) => s1.listen(0, "127.0.0.1", () => r()));
    const p1 = (s1.address() as { port: number }).port;

    const res = await httpImpl.run(
      { capability: "http", args: { method: "GET", url: `http://127.0.0.1:${p1}/`, maxBytes: 1000 } },
      makeCtx((u) => {
        try {
          const port = new URL(u).port;
          return port === String(p1) || port === String(p2);
        } catch { return false; }
      }),
      { timeoutMs: 5000, signal: new AbortController().signal },
    ) as { observation: { status: number; effectiveUrl: string; redirectBlocked: boolean } };

    assert.equal(host2Hits, 1);
    assert.equal(res.observation.status, 200);
    assert.equal(res.observation.effectiveUrl, `http://127.0.0.1:${p2}/`);
    assert.equal(res.observation.redirectBlocked, false);
    s1.close(); s2.close();
    console.log("✔ Test 3 passed: Explicitly authorized second host succeeds");
  }

  // 4. Redirect chain A -> B -> C -> evil
  {
    let evilHits = 0;
    const evil: Server = createServer((_req, res) => { evilHits++; res.writeHead(200); res.end("evil"); });
    await new Promise<void>((r) => evil.listen(0, "127.0.0.1", () => r()));
    const pe = (evil.address() as { port: number }).port;

    const sC: Server = createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${pe}/` }); res.end(); });
    await new Promise<void>((r) => sC.listen(0, "127.0.0.1", () => r()));
    const pC = (sC.address() as { port: number }).port;

    const sB: Server = createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${pC}/` }); res.end(); });
    await new Promise<void>((r) => sB.listen(0, "127.0.0.1", () => r()));
    const pB = (sB.address() as { port: number }).port;

    const sA: Server = createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${pB}/` }); res.end(); });
    await new Promise<void>((r) => sA.listen(0, "127.0.0.1", () => r()));
    const pA = (sA.address() as { port: number }).port;

    const res = await httpImpl.run(
      { capability: "http", args: { method: "GET", url: `http://127.0.0.1:${pA}/`, maxBytes: 1000 } },
      makeCtx((u) => {
        try {
          const port = new URL(u).port;
          return port === String(pA) || port === String(pB) || port === String(pC);
        } catch { return false; }
      }),
      { timeoutMs: 5000, signal: new AbortController().signal },
    ) as { observation: { status: number; effectiveUrl: string; redirectBlocked: boolean } };

    assert.equal(evilHits, 0, "Evil must receive 0 hits");
    assert.equal(res.observation.redirectBlocked, true);
    assert.equal(res.observation.effectiveUrl, `http://127.0.0.1:${pC}/`);
    sA.close(); sB.close(); sC.close(); evil.close();
    console.log("✔ Test 4 passed: Chain A->B->C->evil halts at C, evil gets 0 hits");
  }

  // 5. Redirect loop
  {
    let hits = 0;
    const s: Server = createServer((req, res) => {
      hits++;
      res.writeHead(302, { location: `/loop_${hits}` });
      res.end();
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const p = (s.address() as { port: number }).port;

    const res = await httpImpl.run(
      { capability: "http", args: { method: "GET", url: `http://127.0.0.1:${p}/`, maxBytes: 1000 } },
      makeCtx(() => true),
      { timeoutMs: 5000, signal: new AbortController().signal },
    ) as { observation: { redirectBlocked: boolean } };

    assert.equal(res.observation.redirectBlocked, true);
    assert.ok(hits <= HTTP_MAX_HOPS + 2, `hits was ${hits}, expected <= ${HTTP_MAX_HOPS + 2}`);
    s.close();
    console.log("✔ Test 5 passed: Redirect loop bounded by HTTP_MAX_HOPS");
  }

  // 6. URL parser attacks
  {
    // Test URL parsing resolution tricks against urlWithinGrantScope logic and gate host matching
    const grant = GrantSchema.parse({
      id: "grt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      missionId: "mis_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      capability: "http",
      constraints: { hosts: ["allowed.example", "*.allowed.example"] },
      expiresAt: null,
      issuer: "base-policy",
      parentGrantId: null,
    });

    const checkHost = (inputUrl: string): boolean => {
      const v = evaluateProposal(
        { capability: "http", args: { method: "GET", url: inputUrl, maxBytes: 1000 } },
        { rationale: "test", citations: [] },
        { grants: [grant] },
      );
      return v.type === "allow";
    };

    // Attacks:
    assert.equal(checkHost("https://allowed.example.evil.example/"), false, "suffix trick blocked");
    assert.equal(checkHost("https://allowed.example@evil.example/"), false, "userinfo trick blocked (actual host evil.example)");
    assert.equal(checkHost("https://evil.example@allowed.example/"), true, "userinfo with allowed host parsed correctly (host is allowed.example)");
    assert.equal(checkHost("https://EVIL.EXAMPLE/"), false, "uppercase evil host blocked");
    assert.equal(checkHost("https://ALLOWED.EXAMPLE/"), true, "uppercase allowed host matches correctly (URL host normalized)");
    assert.equal(checkHost("https://sub.allowed.example/"), true, "wildcard subdomain allowed");
    assert.equal(checkHost("https://notsuballowed.example/"), false, "non-subdomain suffix blocked");
    
    // Note: HostPatternSchema only accepts domain names (e.g. *.example.com).
    // An out-of-grant request to an IP (127.0.0.1) or localhost throws in deriveRequestedConstraints:
    let ipThrew = false;
    try {
      checkHost("https://127.0.0.1/");
    } catch (e: any) {
      ipThrew = true;
      assert.ok(e.message.includes("HostPattern") || e.message.includes("host must be a hostname"));
    }
    assert.ok(ipThrew, "127.0.0.1 is rejected as not a valid domain pattern");
    console.log("✔ Test 6 passed: URL parser attacks and host validation withstand spoofing");
  }

  // 7. Observation integrity
  {
    let hops = 0;
    const s: Server = createServer((req, res) => {
      hops++;
      if (hops === 1) { res.writeHead(301, { location: "/canonical-dest" }); res.end(); }
      else { res.writeHead(200); res.end("final body"); }
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const p = (s.address() as { port: number }).port;

    const res = await httpImpl.run(
      { capability: "http", args: { method: "GET", url: `http://127.0.0.1:${p}/initial`, maxBytes: 1000 } },
      makeCtx(() => true),
      { timeoutMs: 5000, signal: new AbortController().signal },
    ) as { observation: { effectiveUrl: string; url: string } };

    assert.equal(res.observation.url, `http://127.0.0.1:${p}/initial`);
    assert.equal(res.observation.effectiveUrl, `http://127.0.0.1:${p}/canonical-dest`);
    s.close();
    console.log("✔ Test 7 passed: Observation accurately records initial and effective URL");
  }

  // 8. Model manipulation
  {
    // Verify that Proposal schema strictly forbids model from specifying effectiveUrl or observation
    const proposalPayloadWithExtra = {
      capability: "http",
      args: { method: "GET", url: "https://allowed.example", maxBytes: 1000, effectiveUrl: "https://evil.example", redirectBlocked: false },
    };
    const parsed = ProposalSchema.safeParse(proposalPayloadWithExtra);
    assert.equal(parsed.success, false, "Extra fields like effectiveUrl in Proposal args must be rejected by schema");
    console.log("✔ Test 8 passed: Model cannot inject effectiveUrl or observation fields into Proposal");
  }

  console.log("ALL F-01 AUDIT TESTS PASSED!\n");
}

runAudit().catch((e) => {
  console.error("F-01 AUDIT FAILED:", e);
  process.exit(1);
});
