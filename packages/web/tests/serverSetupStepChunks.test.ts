import assert from "node:assert/strict";
import { projectionOwesSetupStep } from "../src/components/onboarding/serverSetupStepChunks";
import type { ServerSetupProjection } from "../src/components/onboarding/serverSetupProjection";

const projection = (over: Partial<ServerSetupProjection>) => ({ phase: "in_progress", surface: "computer_runtime", postSetup: null, ...over }) as unknown as ServerSetupProjection;

test("a projection in setup, or with a post-setup step owed, starts the steps' code", () => {
  assert.equal(projectionOwesSetupStep(projection({})), true);
  assert.equal(projectionOwesSetupStep(projection({ phase: "complete", surface: "complete", postSetup: { surveyPending: true } } as never)), true);
  assert.equal(projectionOwesSetupStep(projection({ phase: "complete", surface: "complete", postSetup: { handoffPending: true } } as never)), true);
});

test("a set-up server, or one this person isn't setting up, starts none", () => {
  assert.equal(projectionOwesSetupStep(projection({ phase: "complete", surface: "complete", postSetup: { surveyPending: false, upgradePending: false, handoffPending: false } } as never)), false);
  assert.equal(projectionOwesSetupStep(projection({ phase: null } as never)), false);
  assert.equal(projectionOwesSetupStep(projection({ phase: "deferred" })), false, "a deferred setup shows its resume bar only");
});
