// test/red-team/adversarial-step5-5.test.ts
// Red-Team Adversarial & Hostile Regression Test Suite (Step 5.5)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProviderRegistry,
  ModelRegistry,
  ModelRouter,
  MockModelProvider,
  ContextBuilder,
  AutonomyPolicyEngine,
  AutonomousReasoningLoop,
  type ModelDescriptor,
} from "../../src/model-runtime/index.js";
import {
  AutonomousMissionRunner,
  AutonomousMissionStore,
  MissionRecovery,
  DelegationManager,
  DelegationError,
  VerificationEngine,
  newPlanId,
  newMilestoneId,
  newTaskId,
  MissionBudgetExceededError,
} from "../../src/mission-engine/index.js";
import { GrantStore, newMissionId, newGrantId } from "../../src/grants/grants.js";
import { LocalEnvironment, sha256Hex } from "../../src/environments/local.js";
import type { Plan } from "../../src/contracts/plan.js";
import type { SecretName } from "../../src/contracts/base.js";

function setupEnv() {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-redteam-data-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "forge-redteam-ws-"));
  return {
    dataDir,
    workspaceRoot,
    cleanup() {
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch {}
    },
  };
}

test("Red-Team FINDING-01: Secret redaction in autonomous loop artifact capture", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    const providerRegistry = new ProviderRegistry();
    const modelRegistry = new ModelRegistry();
    const mock = new MockModelProvider("mock-redteam", "Mock Redteam");
    providerRegistry.registerProvider(mock);
    modelRegistry.registerModel({
      providerId: "mock-redteam",
      modelId: "m1",
      name: "M1",
      capabilities: mock.getCapabilities(),
      isDefault: true,
    });
    const router = new ModelRouter({ providerRegistry, modelRegistry });

    const runner = new AutonomousMissionRunner({ dataDir, workspaceRoot });
    const { store, grantStore } = await runner.createMission("Redaction test");

    const mId = newMilestoneId();
    const tId = newTaskId();
    const plan: Plan = {
      planId: newPlanId(),
      missionId: store.getMission().missionId,
      version: 1,
      objective: "Secret leak test",
      assumptions: [],
      milestones: [
        {
          milestoneId: mId,
          objective: "M1",
          dependencies: [],
          status: "pending",
          successCriteria: [],
          verificationCriteria: [],
          tasks: [
            {
              taskId: tId,
              milestoneId: mId,
              title: "Echo Secret",
              description: "Echos secret token",
              capability: "shell",
              args: { argv: ["node", "-e", "console.log('API_KEY=' + process.env.github_token)"], cwd: "." },
              dependsOn: [],
              status: "pending",
              attempt: 0,
              maxAttempts: 2,
              evidenceRefs: [],
              error: null,
            },
          ],
        },
      ],
      dependencies: {},
      verificationStrategy: "mechanical",
      createdAt: new Date().toISOString() as never,
      supersedesPlanId: null,
      immutable: true,
    };
    store.acceptPlan(plan);

    grantStore.issue({
      capability: "shell",
      constraints: {
        argvClass: { kind: "argv-prefix", segments: ["node", "-e"] },
        secretNames: ["github_token" as SecretName],
      },
      expiresAt: null,
      issuer: "base-policy",
      parentGrantId: null,
    });

    const secretValue = "super-secret-ghp-token-123456";
    const secretsMap = new Map<SecretName, string>([["github_token" as SecretName, secretValue]]);

    mock.enqueueDecision({
      analysis: "Echoing environment secret",
      decisionType: "propose_action",
      proposal: {
        capability: "shell",
        args: { argv: ["node", "-e", "console.log('API_KEY=' + process.env.github_token)"], cwd: "." },
      },
    });

    const loop = new AutonomousReasoningLoop({
      store,
      grantStore,
      router,
      workspaceRoot,
      secrets: { resolve: (name) => secretsMap.get(name) ?? null },
    });

    await loop.runLoop();

    // Verify artifacts stored in ledger
    const ledger = store.ledgerStore.ledger;
    const records = store.ledgerStore.read();
    const obsRec = records.find((r) => r.kind === "observation.shell");
    assert.ok(obsRec, "observation.shell must be recorded");

    const outputRef = (obsRec.body as any).outputRef;
    const artifactPath = ledger.artifactPath(outputRef);
    assert.ok(artifactPath, "Artifact file must exist");

    const artifactContent = readFileSync(artifactPath, "utf8");
    assert.ok(!artifactContent.includes(secretValue), "Raw secret MUST NOT appear in saved artifact!");
    assert.ok(artifactContent.includes("[REDACTED]"), "Secret must be replaced with [REDACTED]");
  } finally {
    cleanup();
  }
});

test("Red-Team FINDING-02: Post-effect-unknown fails closed and prevents silent re-execution", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    const runner = new AutonomousMissionRunner({ dataDir, workspaceRoot });
    const { store } = await runner.createMission("Post effect test");

    const createCrashedMission = async (name: string) => {
      const { store } = await runner.createMission(name);
      const mId = newMilestoneId();
      const tId = newTaskId();
      const plan: Plan = {
        planId: newPlanId(),
        missionId: store.getMission().missionId,
        version: 1,
        objective: name,
        assumptions: [],
        milestones: [
          {
            milestoneId: mId,
            objective: "M1",
            dependencies: [],
            status: "in_progress",
            successCriteria: [],
            verificationCriteria: [],
            tasks: [
              {
                taskId: tId,
                milestoneId: mId,
                title: "T1",
                description: "Interrupted task",
                capability: "shell",
                args: { argv: ["rm", "-rf", "test"], cwd: "." },
                dependsOn: [],
                status: "running",
                attempt: 1,
                maxAttempts: 2,
                evidenceRefs: [],
                error: null,
              },
            ],
          },
        ],
        dependencies: {},
        verificationStrategy: "mechanical",
        createdAt: new Date().toISOString() as never,
        supersedesPlanId: null,
        immutable: true,
      };
      store.acceptPlan(plan);
      store.transitionState("planning", "plan");
      store.transitionState("planned", "plan ready");
      store.transitionState("executing", "running");

      const pRec = store.appendRecord("proposal.received", {
        proposal: { capability: "shell", args: { argv: ["rm", "-rf", "test"], cwd: "." } },
        meta: { rationale: "delete", citations: [] },
      });
      const grantId = newGrantId();
      store.appendRecord("proposal.dispatched", {
        proposalId: pRec.id,
        grantId,
        environment: "local",
        timeoutMs: 30000,
      });
      store.appendRecord("task.started", {
        taskId: tId,
        milestoneId: mId,
        capability: "shell",
        attempt: 1,
      });
      return { store, plan };
    };

    // 1. Recovery without callback MUST fail closed
    const m1 = await createCrashedMission("Crash 1");
    const recoveryResult1 = await MissionRecovery.recoverMission(m1.store, m1.plan, undefined);
    assert.equal(recoveryResult1.recovered, false, "Must not recover without acknowledgment");
    assert.equal(m1.store.getMission().status, "failed", "Mission state must transition to failed");

    // 2. Recovery with explicit operator denial
    const m2 = await createCrashedMission("Crash 2");
    const recoveryResult2 = await MissionRecovery.recoverMission(m2.store, m2.plan, async () => false);
    assert.equal(recoveryResult2.recovered, false);
    assert.equal(m2.store.getMission().status, "failed");

    // 3. Recovery with explicit operator acknowledgment
    const m3 = await createCrashedMission("Crash 3");
    const recoveryResult3 = await MissionRecovery.recoverMission(m3.store, m3.plan, async () => true);
    assert.equal(recoveryResult3.recovered, true);
    assert.equal(m3.store.getMission().status, "executing");
  } finally {
    cleanup();
  }
});

test("Red-Team FINDING-03: Delegation grant attenuation (expiry) and token budget reconciliation", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    const runner = new AutonomousMissionRunner({ dataDir, workspaceRoot });
    const { store } = await runner.createMission("Delegation test", {
      budget: { maxModelCalls: 10, maxTokens: 50_000, maxCapabilityCalls: 10, maxPlannerTurns: 10 },
    });

    const parentMission = store.getMission();
    const parentGrant: Grant = {
      id: "g_parent" as never,
      capability: "search",
      constraints: {},
      expiresAt: "2026-12-31T00:00:00.000Z" as never,
      issuer: "base-policy",
      parentGrantId: null,
    };

    const delegationManager = new DelegationManager(2);

    // 1. Child grant with later expiration must be rejected (INV-9 breach)
    assert.throws(
      () => {
        delegationManager.createDelegation(
          parentMission,
          {
            agentId: "child-agent",
            taskScope: ["t1"],
            scopedGrants: [
              {
                capability: "search",
                constraints: {},
                expiresAt: "2027-01-01T00:00:00.000Z" as never,
              },
            ],
            budget: { maxPlannerTurns: 2, maxCapabilityCalls: 2, maxRetries: 1 },
          },
          [parentGrant],
        );
      },
      (err: any) => err instanceof DelegationError && err.message.includes("outlives parent grant"),
    );

    // 2. Child grant with perpetual null expiration when parent expires must be rejected
    assert.throws(
      () => {
        delegationManager.createDelegation(
          parentMission,
          {
            agentId: "child-agent",
            taskScope: ["t1"],
            scopedGrants: [
              {
                capability: "search",
                constraints: {},
                expiresAt: null as never,
              },
            ],
            budget: { maxPlannerTurns: 2, maxCapabilityCalls: 2, maxRetries: 1 },
          },
          [parentGrant],
        );
      },
      (err: any) => err instanceof DelegationError && err.message.includes("outlives parent grant"),
    );

    // 3. Child budget exceeding parent tokens or model calls must be rejected
    assert.throws(
      () => {
        delegationManager.createDelegation(
          parentMission,
          {
            agentId: "child-agent",
            taskScope: ["t1"],
            scopedGrants: [
              {
                capability: "search",
                constraints: {},
                expiresAt: "2026-12-30T00:00:00.000Z" as never,
              },
            ],
            budget: { maxPlannerTurns: 2, maxCapabilityCalls: 2, maxRetries: 1, maxTokens: 100_000 },
          },
          [parentGrant],
        );
      },
      (err: any) => err instanceof DelegationError && err.message.includes("maxTokens"),
    );

    // 4. Budget reconciliation must charge child tokens and model calls to parent
    delegationManager.reconcileChildBudget(parentMission, {
      plannerTurns: 1,
      modelCalls: 4,
      tokensIn: 1000,
      tokensOut: 500,
      capabilityCalls: 2,
      retries: 0,
      executionTimeMs: 500,
      artifactBytes: 200,
    });

    assert.equal(parentMission.budgetConsumed.modelCalls, 4);
    assert.equal(parentMission.budgetConsumed.tokensIn, 1000);
    assert.equal(parentMission.budgetConsumed.tokensOut, 500);
  } finally {
    cleanup();
  }
});

test("Red-Team FINDING-04: Mechanical verification rejects failed HTTP/web responses", async () => {
  const { workspaceRoot, cleanup } = setupEnv();
  try {
    const env = new LocalEnvironment(workspaceRoot);
    const verifier = new VerificationEngine(env, () => null);

    const task = {
      taskId: "t1" as never,
      milestoneId: "m1" as never,
      title: "Fetch API",
      description: "Fetches remote data",
      capability: "web_fetch",
      args: { url: "https://example.com/api" },
      dependsOn: [],
      status: "running" as const,
      attempt: 1,
      maxAttempts: 2,
      evidenceRefs: [],
      error: null,
    };

    // 1. HTTP 500 Internal Server Error observation
    const obs500 = {
      kind: "observation.web_fetch" as const,
      id: "r1" as never,
      author: "runtime" as const,
      seq: 1,
      ts: new Date().toISOString() as never,
      body: {
        url: "https://example.com/api",
        status: 500,
        title: "500 Internal Server Error",
        truncated: false,
        contentRef: "sha" as never,
      },
    };

    const check500 = await verifier.verifyTask(task, obs500);
    assert.equal(check500.passed, false, "HTTP 500 MUST fail mechanical verification");
    assert.ok(check500.reason?.includes("500"));

    // 2. HTTP 404 Not Found observation
    const obs404 = {
      kind: "observation.web_fetch" as const,
      id: "r2" as never,
      author: "runtime" as const,
      seq: 2,
      ts: new Date().toISOString() as never,
      body: {
        url: "https://example.com/api",
        status: 404,
        title: "404 Not Found",
        truncated: false,
        contentRef: "sha" as never,
      },
    };

    const check404 = await verifier.verifyTask(task, obs404);
    assert.equal(check404.passed, false, "HTTP 404 MUST fail mechanical verification");

    // 3. HTTP 200 OK observation
    const obs200 = {
      kind: "observation.web_fetch" as const,
      id: "r3" as never,
      author: "runtime" as const,
      seq: 3,
      ts: new Date().toISOString() as never,
      body: {
        url: "https://example.com/api",
        status: 200,
        title: "Success",
        truncated: false,
        contentRef: "sha" as never,
      },
    };

    const check200 = await verifier.verifyTask(task, obs200);
    assert.equal(check200.passed, true, "HTTP 200 must pass mechanical verification");
  } finally {
    cleanup();
  }
});

test("Red-Team FINDING-05: Host dispatch capability exceptions caught without crashing loop", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    const providerRegistry = new ProviderRegistry();
    const modelRegistry = new ModelRegistry();
    const mock = new MockModelProvider("mock-err", "Mock Err");
    providerRegistry.registerProvider(mock);
    modelRegistry.registerModel({
      providerId: "mock-err",
      modelId: "m1",
      name: "M1",
      capabilities: mock.getCapabilities(),
      isDefault: true,
    });
    const router = new ModelRouter({ providerRegistry, modelRegistry });

    const runner = new AutonomousMissionRunner({ dataDir, workspaceRoot });
    const { store, grantStore } = await runner.createMission("Exception test");

    const mId = newMilestoneId();
    const tId = newTaskId();
    const plan: Plan = {
      planId: newPlanId(),
      missionId: store.getMission().missionId,
      version: 1,
      objective: "Exception recovery",
      assumptions: [],
      milestones: [
        {
          milestoneId: mId,
          objective: "M1",
          dependencies: [],
          status: "pending",
          successCriteria: [],
          verificationCriteria: [],
          tasks: [
            {
              taskId: tId,
              milestoneId: mId,
              title: "Failing Command",
              description: "Exits with code 1",
              capability: "shell",
              args: { argv: ["node", "-e", "process.exit(1)"], cwd: "." },
              dependsOn: [],
              status: "pending",
              attempt: 0,
              maxAttempts: 1,
              evidenceRefs: [],
              error: null,
            },
          ],
        },
      ],
      dependencies: {},
      verificationStrategy: "mechanical",
      createdAt: new Date().toISOString() as never,
      supersedesPlanId: null,
      immutable: true,
    };
    store.acceptPlan(plan);

    grantStore.issue({
      capability: "shell",
      constraints: { argvClass: { kind: "argv-prefix", segments: ["node", "-e"] } },
      expiresAt: null,
      issuer: "base-policy",
      parentGrantId: null,
    });

    mock.enqueueDecision({
      analysis: "Running failing command",
      decisionType: "propose_action",
      proposal: { capability: "shell", args: { argv: ["node", "-e", "process.exit(1)"], cwd: "." } },
    });

    const loop = new AutonomousReasoningLoop({
      store,
      grantStore,
      router,
      workspaceRoot,
    });

    // Loop should complete cleanly with failure recorded, NOT throw unhandled exception
    const snapshot = await loop.runLoop();
    assert.equal(snapshot.status, "failed");

    const records = store.ledgerStore.read();
    assert.ok(records.some((r) => r.kind === "task.failed"), "task.failed must be recorded");
    assert.ok(records.some((r) => r.kind === "mission.failed"), "mission.failed must be recorded");
  } finally {
    cleanup();
  }
});

test("Red-Team FINDING-06: Artifact budget exhaustion is mechanically enforced", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    const providerRegistry = new ProviderRegistry();
    const modelRegistry = new ModelRegistry();
    const mock = new MockModelProvider("mock-art", "Mock Art");
    providerRegistry.registerProvider(mock);
    modelRegistry.registerModel({
      providerId: "mock-art",
      modelId: "m1",
      name: "M1",
      capabilities: mock.getCapabilities(),
      isDefault: true,
    });
    const router = new ModelRouter({ providerRegistry, modelRegistry });

    const runner = new AutonomousMissionRunner({ dataDir, workspaceRoot });
    // Restrict artifact budget to 1024 bytes
    const { store, grantStore } = await runner.createMission("Artifact budget test", {
      budget: { maxArtifactBytes: 1024 },
    });

    const mId = newMilestoneId();
    const tId = newTaskId();
    const plan: Plan = {
      planId: newPlanId(),
      missionId: store.getMission().missionId,
      version: 1,
      objective: "Exhaust artifact budget",
      assumptions: [],
      milestones: [
        {
          milestoneId: mId,
          objective: "M1",
          dependencies: [],
          status: "pending",
          successCriteria: [],
          verificationCriteria: [],
          tasks: [
            {
              taskId: tId,
              milestoneId: mId,
              title: "Write large artifact",
              description: "Outputs 2KB of text",
              capability: "search",
              args: { query: "big", mode: "grep" },
              dependsOn: [],
              status: "pending",
              attempt: 0,
              maxAttempts: 1,
              evidenceRefs: [],
              error: null,
            },
          ],
        },
      ],
      dependencies: {},
      verificationStrategy: "mechanical",
      createdAt: new Date().toISOString() as never,
      supersedesPlanId: null,
      immutable: true,
    };
    store.acceptPlan(plan);
    grantStore.issue({ capability: "search", constraints: {}, expiresAt: null, issuer: "base-policy", parentGrantId: null });

    // Pre-consume 1000 bytes
    store.getMission().budgetConsumed.artifactBytes = 1000;

    // Proposal will capture search results > 24 bytes, triggering budget overflow
    mock.enqueueDecision({
      analysis: "Searching",
      decisionType: "propose_action",
      proposal: { capability: "search", args: { query: "big", mode: "grep" } },
    });

    writeFileSync(join(workspaceRoot, "large.txt"), "big match\n".repeat(200), "utf8");

    const loop = new AutonomousReasoningLoop({
      store,
      grantStore,
      router,
      workspaceRoot,
    });

    const snapshot = await loop.runLoop();
    assert.equal(snapshot.status, "failed");

    const records = store.ledgerStore.read();
    assert.ok(
      records.some(
        (r) => r.kind === "mission.failed" && (r.body as any).errorCategory === "resource_exhaustion",
      ),
      "Must fail with resource_exhaustion category",
    );
  } finally {
    cleanup();
  }
});

test("Red-Team FINDING-07: Provider failover accumulates token and model call consumption", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    const providerRegistry = new ProviderRegistry();
    const modelRegistry = new ModelRegistry();
    const primary = new MockModelProvider("primary-p", "Primary P");
    const fallback = new MockModelProvider("fallback-p", "Fallback P");
    providerRegistry.registerProvider(primary);
    providerRegistry.registerProvider(fallback);

    modelRegistry.registerModel({
      providerId: "primary-p",
      modelId: "m1",
      name: "M1",
      capabilities: primary.getCapabilities(),
      isDefault: true,
    });

    const router = new ModelRouter({
      providerRegistry,
      modelRegistry,
      fallbackProviderId: "fallback-p",
    });

    const runner = new AutonomousMissionRunner({ dataDir, workspaceRoot });
    const { store } = await runner.createMission("Failover accounting");

    // Primary fails with RateLimited (consumed prompt tokens)
    primary.enqueueError("RateLimited", "Rate limit hit (429)");

    // Fallback succeeds
    fallback.enqueueDecision({
      analysis: "Fallback done",
      decisionType: "complete_task",
    });

    const req = {
      messages: [{ role: "user" as const, content: "Hello test", provenance: "runtime-framing" as const }],
      capabilityCards: [],
      activeGrants: [],
      maxOutputTokens: 1024,
      signal: new AbortController().signal,
    };

    await router.invokeModel(req, undefined, store);

    // Both provider attempts must be charged to modelCalls
    const consumed = store.getMission().budgetConsumed;
    assert.equal(consumed.modelCalls, 2, "Both primary attempt and fallback attempt must be counted in modelCalls");
  } finally {
    cleanup();
  }
});

test("Red-Team INVARIANT VERIFICATION: L4 autonomy policy cannot bypass Authority Gate", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    const providerRegistry = new ProviderRegistry();
    const modelRegistry = new ModelRegistry();
    const mock = new MockModelProvider("mock-l4", "Mock L4");
    providerRegistry.registerProvider(mock);
    modelRegistry.registerModel({
      providerId: "mock-l4",
      modelId: "m1",
      name: "M1",
      capabilities: mock.getCapabilities(),
      isDefault: true,
    });
    const router = new ModelRouter({ providerRegistry, modelRegistry });

    const runner = new AutonomousMissionRunner({ dataDir, workspaceRoot });
    // Configure mission with L4 full autonomy
    const { store, grantStore } = await runner.createMission("L4 test", {
      riskPolicy: { autonomyLevel: "L4_FULL_MISSION_AUTONOMY" },
    });

    const mId = newMilestoneId();
    const tId = newTaskId();
    const plan: Plan = {
      planId: newPlanId(),
      missionId: store.getMission().missionId,
      version: 1,
      objective: "L4 Gate bypass attempt",
      assumptions: [],
      milestones: [
        {
          milestoneId: mId,
          objective: "M1",
          dependencies: [],
          status: "pending",
          successCriteria: [],
          verificationCriteria: [],
          tasks: [
            {
              taskId: tId,
              milestoneId: mId,
              title: "Ungranted Shell Action",
              description: "Attempts ungranted shell under L4",
              capability: "shell",
              args: { argv: ["rm", "-rf", "/"], cwd: "." },
              dependsOn: [],
              status: "pending",
              attempt: 0,
              maxAttempts: 1,
              evidenceRefs: [],
              error: null,
            },
          ],
        },
      ],
      dependencies: {},
      verificationStrategy: "mechanical",
      createdAt: new Date().toISOString() as never,
      supersedesPlanId: null,
      immutable: true,
    };
    store.acceptPlan(plan);

    // ZERO grants issued for shell!

    mock.enqueueDecision({
      analysis: "Executing rogue shell command under L4",
      decisionType: "propose_action",
      proposal: { capability: "shell", args: { argv: ["rm", "-rf", "/"], cwd: "." } },
    });

    const loop = new AutonomousReasoningLoop({
      store,
      grantStore,
      router,
      workspaceRoot,
    });

    const snapshot = await loop.runLoop();

    // Mission must be blocked or failed by Authority Gate, NEVER executed
    assert.ok(snapshot.status === "blocked" || snapshot.status === "failed");

    const records = store.ledgerStore.read();
    assert.ok(!records.some((r) => r.kind === "proposal.dispatched"), "Ungranted proposal MUST NEVER be dispatched!");
    assert.ok(!records.some((r) => r.kind === "observation.shell"), "Observation MUST NEVER exist!");
    assert.ok(records.some((r) => r.kind === "autonomy.policy_evaluated" && (r.body as any).requiresApproval === true), "Policy must block ungranted capability");
  } finally {
    cleanup();
  }
});
