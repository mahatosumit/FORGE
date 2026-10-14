import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ProposalSchema } from "../../src/contracts/proposals.js";
import { evaluateProposal } from "../../src/gate/gate.js";
import { htmlToMarkdown, parseDuckDuckGoHtml, webSearchImpl, webFetchImpl } from "../../src/capabilities/web.js";
import { openMission } from "../../src/ledger/index.js";
import { GrantStore, newMissionId } from "../../src/grants/grants.js";
const nowIso = () => new Date().toISOString();
import type { DispatchContext } from "../../src/capability-host/types.js";
import { LocalEnvironment } from "../../src/environments/local.js";

test("ProposalSchema: validates web_search and web_fetch proposals", () => {
  const searchProposal = {
    capability: "web_search",
    args: { query: "vitest typescript testing guide", maxResults: 10 },
  };
  const parsedSearch = ProposalSchema.safeParse(searchProposal);
  assert.equal(parsedSearch.success, true);

  const fetchProposal = {
    capability: "web_fetch",
    args: { url: "https://vitest.dev/guide/", extractMode: "markdown", maxBytes: 100000 },
  };
  const parsedFetch = ProposalSchema.safeParse(fetchProposal);
  assert.equal(parsedFetch.success, true);

  // Invalid URL scheme (e.g. ftp) rejected
  const badFetch = {
    capability: "web_fetch",
    args: { url: "ftp://files.example.com/data.txt" },
  };
  assert.equal(ProposalSchema.safeParse(badFetch).success, false);
});

test("Authority Gate: governs web_search and web_fetch with grants", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-gate-web-"));
  const missionId = newMissionId();
  const store = openMission({ dataDir, missionId });
  const grants = new GrantStore(store);

  // 1. Without grants: both escalate
  const searchProposal = {
    capability: "web_search",
    args: { query: "node js releases" },
  };
  const v1 = evaluateProposal(searchProposal, { rationale: "find versions", citations: [] }, { grants: grants.active() });
  assert.equal(v1.type, "escalate");

  // 2. Grant web_search
  const gSearch = grants.issue({
    missionId,
    capability: "web_search",
    constraints: {},
    expiresAt: null,
    issuer: "base-policy",
    parentGrantId: null,
  });
  const v2 = evaluateProposal(searchProposal, { rationale: "find versions", citations: [] }, { grants: grants.active() });
  assert.equal(v2.type, "allow");
  assert.equal(v2.grantId, gSearch.id);

  // 3. web_fetch to scoped host
  const fetchProposal = {
    capability: "web_fetch",
    args: { url: "https://docs.python.org/3/tutorial/index.html" },
  };
  const v3 = evaluateProposal(fetchProposal, { rationale: "read python docs", citations: [] }, { grants: grants.active() });
  assert.equal(v3.type, "escalate");

  // Issue host-scoped grant for docs.python.org
  const gFetch = grants.issue({
    missionId,
    capability: "web_fetch",
    constraints: { hosts: ["docs.python.org" as never] },
    expiresAt: null,
    issuer: "base-policy",
    parentGrantId: null,
  });
  const v4 = evaluateProposal(fetchProposal, { rationale: "read python docs", citations: [] }, { grants: grants.active() });
  assert.equal(v4.type, "allow");
  assert.equal(v4.grantId, gFetch.id);

  // Host mismatch escalates
  const unauthorizedFetch = {
    capability: "web_fetch",
    args: { url: "https://malicious.example.com/exploit" },
  };
  const v5 = evaluateProposal(unauthorizedFetch, { rationale: "read other", citations: [] }, { grants: grants.active() });
  assert.equal(v5.type, "escalate");

  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("htmlToMarkdown: cleans web boilerplate and produces structured markdown", () => {
  const sampleHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>FastAPI Tutorial &amp; Guide</title>
        <style>.ads { color: red; }</style>
        <script>console.log("tracking");</script>
      </head>
      <body>
        <nav><a href="/home">Home</a> | <a href="/about">About</a></nav>
        <header><h1>Header Banner</h1></header>
        <main>
          <h1>FastAPI Overview</h1>
          <p>FastAPI is a modern, fast web framework for building APIs with Python.</p>
          <h2>Key Features</h2>
          <ul>
            <li><strong>Fast:</strong> Very high performance on par with NodeJS and Go.</li>
            <li><strong>Fast to code:</strong> Increase speed to develop features.</li>
          </ul>
          <h3>Example Code</h3>
          <pre><code>from fastapi import FastAPI
app = FastAPI()

@app.get("/")
def read_root():
    return {"Hello": "World"}</code></pre>
          <p>For more info visit <a href="https://fastapi.tiangolo.com">Official Docs</a>.</p>
        </main>
        <footer><p>&copy; 2026 FastAPI</p></footer>
      </body>
    </html>
  `;

  const { title, markdown } = htmlToMarkdown(sampleHtml);
  assert.equal(title, "FastAPI Tutorial & Guide");
  assert.ok(!markdown.includes("console.log"));
  assert.ok(!markdown.includes(".ads {"));
  assert.ok(!markdown.includes("<nav>"));
  assert.ok(markdown.includes("# FastAPI Overview"));
  assert.ok(markdown.includes("## Key Features"));
  assert.ok(markdown.includes("- Fast: Very high performance"));
  assert.ok(markdown.includes("```\nfrom fastapi import FastAPI"));
  assert.ok(markdown.includes("[Official Docs](https://fastapi.tiangolo.com)"));
});

test("parseDuckDuckGoHtml: extracts structured search results and decodes redirects", () => {
  const ddgHtml = `
    <div class="results">
      <div class="result results_links results_links_deep web-result">
        <div class="result__body">
          <h2 class="result__title">
            <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2F&rut=1">Vitest | Next Generation Testing Framework</a>
          </h2>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2F&rut=1">
            A Vite-native unit test framework. Fast, modern and developer-friendly.
          </a>
        </div>
      </div>
      <div class="result results_links results_links_deep web-result">
        <div class="result__body">
          <h2 class="result__title">
            <a class="result__url" href="https://github.com/vitest-dev/vitest">Vitest GitHub Repository</a>
          </h2>
          <div class="result__snippet">
            Next generation testing framework powered by Vite.
          </div>
        </div>
      </div>
    </div>
  `;

  const items = parseDuckDuckGoHtml(ddgHtml, 5);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.title, "Vitest | Next Generation Testing Framework");
  assert.equal(items[0]?.url, "https://vitest.dev/");
  assert.ok(items[0]?.snippet.includes("Vite-native unit test framework"));

  assert.equal(items[1]?.title, "Vitest GitHub Repository");
  assert.equal(items[1]?.url, "https://github.com/vitest-dev/vitest");
});

test("Governed web execution: captures artifacts into ledger store", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-web-exec-"));
  const missionId = newMissionId();
  const store = openMission({ dataDir, missionId });
  const env = new LocalEnvironment(process.cwd());

  const capturedArtifacts = new Map<string, Uint8Array>();
  const ctx: DispatchContext = {
    environment: env,
    environmentKind: "local",
    urlAuthority: () => true,
    criterionResolver: () => undefined,
    artifactBytes: (ref) => capturedArtifacts.get(ref) ?? null,
    capture: (bytes) => {
      const hash = createHash("sha256").update(bytes).digest("hex");
      store.ledger.writeArtifact(bytes, hash);
      capturedArtifacts.set(hash, bytes);
      return hash;
    },
    secrets: {},
  };

  // Run webSearchImpl
  const searchProposal = {
    capability: "web_search" as const,
    args: { query: "typescript official documentation", maxResults: 3 },
  };
  const searchObs = await webSearchImpl.run(searchProposal, ctx, {
    timeoutMs: 3000,
    signal: new AbortController().signal,
  });

  assert.equal(searchObs.observationKind, "observation.web_search");
  assert.equal(searchObs.observation.query, "typescript official documentation");
  assert.ok(searchObs.observation.resultsRef !== null);

  // Append observation to ledger and verify cryptographic chain
  const rec = store.append({
    kind: "observation.web_search",
    author: "runtime",
    ts: nowIso(),
    body: searchObs.observation,
  });

  assert.ok(rec.hash);
  const verifyResult = store.ledger.verify();
  assert.equal(verifyResult.ok, true);

  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});
