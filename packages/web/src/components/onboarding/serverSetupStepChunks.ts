import { sharedModule } from "../../boot/sharedModule";
import type { ServerSetupProjection } from "./serverSetupProjection";

/**
 * The setup steps' code (ServerSetupProjectionGate): only a server in setup
 * draws one, so each is its own chunk and a set-up server's first screen never
 * downloads them. The gate starts all of them as soon as a projection owes a
 * step (preloadServerSetupSteps), so moving to the next step doesn't wait for
 * its download. Each is one shared load that remembers its module
 * (boot/sharedModule), so a step whose code is in opens without a fallback.
 */
export const loadComputerRuntimeStep = sharedModule(() => import("./ServerSetupComputerRuntimeStep"));
export const loadDisplayStyleStep = sharedModule(() => import("./ServerSetupDisplayStyleStep"));
export const loadHandoffStep = sharedModule(() => import("./ServerSetupHandoffStep"));
export const loadSurveyStep = sharedModule(() => import("./ServerSetupSurveyStep"));
export const loadUpgradeStep = sharedModule(() => import("./ServerSetupUpgradeStep"));

const ALL_STEPS = [loadComputerRuntimeStep, loadDisplayStyleStep, loadHandoffStep, loadSurveyStep, loadUpgradeStep];

/** Start every step's code (a failed start is retried when the step renders, where its Try again can show). */
export function preloadServerSetupSteps(): void {
  for (const load of ALL_STEPS) void load().catch(() => {});
}

/** Whether this projection has the gate draw a step (setup under way, or a post-setup step owed). */
export function projectionOwesSetupStep(projection: ServerSetupProjection): boolean {
  if (projection.phase === null) return false;
  const post = projection.postSetup;
  if (post?.surveyPending || post?.upgradePending || post?.handoffPending) return true;
  // A deferred setup shows only its resume bar: its steps load when it resumes.
  return projection.phase !== "deferred" && projection.surface !== "complete";
}
