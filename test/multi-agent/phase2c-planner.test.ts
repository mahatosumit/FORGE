// FORGE Step 8 Phase 2C-3 Acceptance Tests: Planner Runtime
// Tests: P2C-001, P2C-002, P2C-003.

import test from "node:test";
import assert from "node:assert/strict";
import type { Proposal } from "../../src/contracts/index.js";
import {
  GovernedPlannerLoop,
  TurnBudgetExhaustedError,
  ActionRepeatExhaustionError,
  EvidenceRequiredError,
  MechanicalTaskVerifier,
  ProgressTracker,
} from "../../src/multi-agent/planner-loop.js";

// ============================================================================
// P2C-001: Runaway circular self-reflection terminated by turn budget
// ============================================================================
test("P2C-001: Planner circular self-reflection terminates upon reaching maxPlannerTurns", async () => {
  const loop = new GovernedPlannerLoop({
    maxPlannerTurns: 5,
    maxActionRepeats: 3,
  });

  // Execute 5 non-acting self-reflection turns
  for (let i = 0; i < 5; i++) {
    loop.stepTurn();
  }
  assert.equal(loop.turn, 5);

  // 6th turn exceeds maxPlannerTurns -> must throw TurnBudgetExhaustedError
  assert.throws(
    () => {
      loop.stepTurn();
    },
    (err: any) => {
      assert(err instanceof TurnBudgetExhaustedError);
      assert.equal(err.turnsUsed, 6);
      assert.equal(err.maxTurns, 5);
      return true;
    },
  );
});

// ============================================================================
// P2C-002: Repeated identical failing action triggers loop abort
// ============================================================================
test("P2C-002: Repeating identical failing action 3 times triggers ActionRepeatExhaustionError", async () => {
  const tracker = new ProgressTracker(3);

  const failingProposal: Proposal = {
    capability: "fs",
    args: {
      op: "patch",
      path: "src/auth.ts" as any,
      patch: "@@ -1 +1 @@\n-broken\n+fixed\n",
    },
  };

  // 1st failure
  tracker.recordActionOutcome(failingProposal, false);
  assert.equal(tracker.getFailureCount(failingProposal), 1);

  // 2nd failure
  tracker.recordActionOutcome(failingProposal, false);
  assert.equal(tracker.getFailureCount(failingProposal), 2);

  // 3rd failure must throw ActionRepeatExhaustionError
  assert.throws(
    () => {
      tracker.recordActionOutcome(failingProposal, false);
    },
    (err: any) => {
      assert(err instanceof ActionRepeatExhaustionError);
      assert.equal(err.capability, "fs");
      assert.equal(err.repeatCount, 3);
      assert.match(err.message, /Repeated identical failing action "fs" 3 times/);
      return true;
    },
  );
});

// ============================================================================
// P2C-003: Natural language text claiming success without observations rejected
// ============================================================================
test("P2C-003: Model text claiming completion without observations fails mechanical verification", async () => {
  // Model claims "I have successfully fixed the bug and verified everything" but cites 0 evidence
  const ungroundedClaim = {
    taskId: "task-fix-auth",
    hasModelClaim: true,
    evidenceRefs: [],
    observationCount: 0,
  };

  const verifierResult = MechanicalTaskVerifier.verifyCompletionClaim(ungroundedClaim);

  assert.equal(verifierResult.passed, false);
  assert(verifierResult.error instanceof EvidenceRequiredError);
  assert.match(verifierResult.error.message, /claimed success in text without evidence/);

  // Verified claim with real evidence artifacts passes
  const groundedClaim = {
    taskId: "task-fix-auth",
    hasModelClaim: true,
    evidenceRefs: ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as any],
    observationCount: 1,
  };

  const groundedResult = MechanicalTaskVerifier.verifyCompletionClaim(groundedClaim);
  assert.equal(groundedResult.passed, true);
  assert.equal(groundedResult.error, undefined);
});
