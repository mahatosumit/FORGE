import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine.js";
import { openMissionReadOnly } from "../src/ledger/index.js";
import { verifyChain } from "../src/codec/hashChain.js";
import { ConfigStore } from "../src/config/store.js";
import { resolveModelFn, type ProviderDescriptor } from "../src/model-router/router.js";

async function main() {
  console.log("============================================================");
  console.log("FORGE REAL CODING AGENT — FULL LIFECYCLE CERTIFICATION");
  console.log("============================================================");

  const store = new ConfigStore(join(process.cwd(), ".forge"));
  const cfg = store.getConfig();
  const provider = store.getProvider(cfg.activeProviderId) ?? store.getProviders()[0];
  if (!provider) {
    throw new Error("No provider configured — set NVIDIA_API_KEY or run `npm run cli -- config`");
  }
  const descriptor: ProviderDescriptor = {
    id: provider.id,
    kind: provider.kind === "anthropic-messages" ? "anthropic-messages" : "openai-compatible",
    baseUrl: provider.baseUrl,
    apiKeyEnvVar: provider.apiKeyEnvVar,
    model: cfg.activeModelId || provider.model,
    contextWindow: provider.capabilities?.contextWindow ?? 200_000,
  };
  console.log(`[CONFIG] Provider: ${descriptor.kind} (${descriptor.id})`);
  console.log(`[CONFIG] Model:    ${descriptor.model}`);
  console.log(`[CONFIG] BaseUrl:  ${descriptor.baseUrl}`);

  // -------------------------------------------------------------------------
  // STEP 1: CREATE DISPOSABLE GIT REPOSITORY WITH DELIBERATE BUG
  // -------------------------------------------------------------------------
  const ws = mkdtempSync(join(tmpdir(), "forge-real-coding-ws-"));
  const dataDir = mkdtempSync(join(tmpdir(), "forge-real-coding-data-"));
  console.log(`[SETUP] Disposable workspace: ${ws}`);
  console.log(`[SETUP] Disposable dataDir:   ${dataDir}`);

  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "test"), { recursive: true });

  // Init git repository
  try {
    execSync("git init", { cwd: ws, stdio: "ignore" });
    execSync('git config user.name "Test User"', { cwd: ws, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: ws, stdio: "ignore" });
  } catch (e) {
    console.warn("Git init warning (non-fatal):", e);
  }

  // 1a. package.json
  writeFileSync(
    join(ws, "package.json"),
    JSON.stringify(
      {
        name: "rate-limiter-app",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test test/rate-limiter.test.js" },
      },
      null,
      2
    )
  );

  // 1b. Defective implementation (Token Bucket)
  // BUG: tokens are initialized to 0 instead of capacity, and consume subtracts without checking
  const defectiveCode = `export class TokenBucket {
  constructor(capacity, refillRatePerSec) {
    this.capacity = capacity;
    this.refillRatePerSec = refillRatePerSec;
    // BUG: start empty instead of full capacity
    this.tokens = 0;
    this.lastRefill = Date.now();
  }

  refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRatePerSec);
    this.lastRefill = now;
  }

  consume(amount = 1) {
    this.refill();
    // BUG: does not check if tokens >= amount before deducting
    if (this.tokens < amount) {
      return false;
    }
    this.tokens -= amount;
    return true;
  }
}
`;
  writeFileSync(join(ws, "src", "token-bucket.js"), defectiveCode);

  // 1c. Unit Test Suite
  const testCode = `import test from "node:test";
import assert from "node:assert/strict";
import { TokenBucket } from "../src/token-bucket.js";

test("TokenBucket starts with full capacity and allows immediate consumption", () => {
  const bucket = new TokenBucket(10, 1);
  assert.equal(bucket.consume(1), true, "first consumption should succeed immediately");
  assert.equal(bucket.consume(5), true, "further consumption within capacity should succeed");
});

test("TokenBucket rejects consumption exceeding available tokens", () => {
  const bucket = new TokenBucket(2, 0.1);
  assert.equal(bucket.consume(2), true, "should consume initial 2 tokens");
  assert.equal(bucket.consume(1), false, "should reject when empty");
});
`;
  writeFileSync(join(ws, "test", "rate-limiter.test.js"), testCode);

  // Commit baseline to git
  try {
    execSync("git add .", { cwd: ws, stdio: "ignore" });
    execSync('git commit -m "initial baseline with bug"', { cwd: ws, stdio: "ignore" });
  } catch {}

  // -------------------------------------------------------------------------
  // STEP 2: VERIFY TEST FAILS BEFORE THE FIX
  // -------------------------------------------------------------------------
  console.log("\n[VERIFICATION] Verifying test suite FAILS before the fix...");
  let testFailedAsExpected = false;
  try {
    execSync("node --test test/rate-limiter.test.js", { cwd: ws, stdio: "pipe" });
  } catch (err) {
    testFailedAsExpected = true;
    console.log("✔ Test failed as expected on buggy baseline:");
    const out = (err as any).stderr?.toString() || (err as any).stdout?.toString();
    console.log("  " + out.split("\n").slice(0, 3).join("\n  "));
  }
  assert.ok(testFailedAsExpected, "Test suite MUST fail before FORGE attempts the fix");

  // -------------------------------------------------------------------------
  // STEP 3: RUN FORGE ENGINE WITH REAL LIVE MODEL
  // -------------------------------------------------------------------------
  console.log("\n[EXECUTION] Initializing FORGE Engine with real AI model...");
  const baseModelFn = resolveModelFn(descriptor);
  const loggingModelFn = {
    async *complete(req: any) {
      console.log("\n--- [MODEL REQUEST START] ---");
      for await (const ev of baseModelFn.complete(req)) {
        if (ev.type === "text-delta") {
          process.stdout.write(ev.text);
        } else if (ev.type === "proposal") {
          console.log("\n[PROPOSAL EVENT]:", JSON.stringify(ev.proposal, null, 2));
        } else if (ev.type === "claim") {
          console.log("\n[CLAIM EVENT]:", ev.statement);
        } else if (ev.type === "error") {
          console.log("\n[MODEL ERROR EVENT]:", ev.error);
        }
        yield ev;
      }
      console.log("\n--- [MODEL REQUEST END] ---\n");
    }
  };

  const engine = new Engine({
    dataDir,
    workspaceRoot: ws,
    modelFn: loggingModelFn as any,
    onEscalation: async (req) => {
      console.log(`[ESCALATION AUTO-APPROVED IN TEST]: ${req.capability} - ${req.rationale}`);
      return { decision: "extend", expiresAt: null };
    },
  });

  const intent = "Fix the bug in src/token-bucket.js so that the token bucket starts with full capacity and test/rate-limiter.test.js passes.";
  console.log(`[MISSION] Intent: "${intent}"`);

  const h = await engine.openQuickMission(intent);
  console.log(`[MISSION] Mission ID: ${h.missionId}`);

  console.log("[RUNTIME] Starting mission execution...");
  const startTs = Date.now();
  const execResult = await engine.executeMission(h);
  const durationMs = Date.now() - startTs;

  console.log(`\n[RUNTIME] Mission completed in ${durationMs}ms`);
  console.log(`[RUNTIME] Closure: ${execResult.closure}`);
  console.log("[RUNTIME] Receipt:", JSON.stringify(execResult.receipt, null, 2));

  // -------------------------------------------------------------------------
  // STEP 4: VERIFY REAL REPOSITORY EFFECTS & GIT DIFF
  // -------------------------------------------------------------------------
  console.log("\n[CODE INSPECTION] Inspecting workspace after FORGE execution...");
  const fixedCode = readFileSync(join(ws, "src", "token-bucket.js"), "utf8");
  console.log("Updated src/token-bucket.js contents:\n" + fixedCode);

  let gitDiff = "";
  try {
    gitDiff = execSync("git diff src/token-bucket.js", { cwd: ws, encoding: "utf8" });
    console.log("Git diff:\n" + (gitDiff || "(no git diff / untracked)"));
  } catch {}

  // -------------------------------------------------------------------------
  // STEP 5: VERIFY TEST PASSES IN ENVIRONMENT AFTER FIX
  // -------------------------------------------------------------------------
  console.log("\n[TEST VERIFICATION] Running test suite after FORGE fix...");
  let testPassed = false;
  try {
    const testOut = execSync("node --test test/rate-limiter.test.js", { cwd: ws, encoding: "utf8" });
    console.log("✔ Test output:\n" + testOut.trim());
    testPassed = true;
  } catch (err) {
    console.error("✖ Test failed after fix:", (err as any).stdout || (err as any).stderr);
  }
  assert.ok(testPassed, "Test suite MUST pass after the fix");

  // -------------------------------------------------------------------------
  // STEP 6: VERIFY AUTHORITATIVE LEDGER RECORDS & CRYPTOGRAPHIC CHAIN
  // -------------------------------------------------------------------------
  console.log("\n[LEDGER AUDIT] Reconstructing mission from authoritative ledger...");
  const readStore = openMissionReadOnly(dataDir, h.missionId);
  const records = readStore.read();
  console.log(`Ledger contains ${records.length} records:`);
  for (const r of records) {
    console.log(`  seq ${r.seq.toString().padStart(2)}: [${r.kind}] by ${r.author} (id: ${r.id})`);
  }

  // Cryptographic hash chain verification
  const chainCheck = verifyChain(records);
  assert.ok(chainCheck.ok, `Hash chain verification failed: ${chainCheck.reason}`);
  console.log("✔ SHA-256 hash chain verified with zero mutations");

  // Record presence checks
  assert.ok(records.some((r) => r.kind === "mission.opened"), "Must have mission.opened");
  assert.ok(records.some((r) => r.kind === "plan.confirmed"), "Must have plan.confirmed");
  assert.ok(records.some((r) => r.kind === "grant.issued"), "Must have grant.issued");
  assert.ok(records.some((r) => r.kind === "proposal.validated"), "Must have proposal.validated");
  assert.ok(records.some((r) => r.kind === "observation.fs" || r.kind === "observation.shell"), "Must have observation");
  assert.ok(records.some((r) => r.kind === "verdict.recorded"), "Must have verdict.recorded");
  assert.ok(records.some((r) => r.kind === "mission.closed"), "Must have mission.closed");
  assert.equal(records.find((r) => r.kind === "mission.closed")?.body?.closure, "verified");

  h.store.close();

  // -------------------------------------------------------------------------
  // CLEANUP DISPOSABLE WORKSPACES
  // -------------------------------------------------------------------------
  try { rmSync(ws, { recursive: true, force: true }); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}

  console.log("\n============================================================");
  console.log("✔ ALL REAL CODING AGENT LIFECYCLE CHECKS PASSED PERFECTLY!");
  console.log("============================================================");
}

main().catch((e) => {
  console.error("CERTIFICATION FAILED:", e);
  process.exit(1);
});
