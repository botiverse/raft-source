/**
 * Flag keys this deployment answers itself.
 *
 * A rollout flag that is retired while clients and core still ask it by its
 * key (an app's `FirstPartyApp.flag`: old web tabs and App builds evaluate
 * it, core gates the app's objects by it) is answered by what the deployment
 * can run: the same for every server and user, never a Feature Flag Admin
 * row, whose rules, kill switch and default no longer count. Who retires the
 * flag registers the answer (Artifacts: apps/artifacts/deployment.ts, through
 * platform/flags.ts); featureFlagService.ts evaluateFeatureFlags asks here
 * first.
 *
 * A module of its own, importing nothing: an app registers at its load, and
 * that must not depend on the flag service's own module graph.
 */
const answers = new Map<string, () => boolean>();
const answeredForTests = new Map<string, boolean>();

/** Answer `key` by `answer()` from now on, in every evaluation. */
export function answerFlagFromDeployment(key: string, answer: () => boolean): void {
  answers.set(key, answer);
}

/**
 * The deployment's answer for `key`, or undefined for a key Feature Flag
 * Admin answers. One answer for the whole deployment: no server or user is
 * asked for.
 */
export function deploymentAnswerOf(key: string): boolean | undefined {
  return answeredForTests.get(key) ?? answers.get(key)?.();
}

/**
 * Tests: `key` answers `enabled` whatever the deployment has, also where
 * nothing registered an answer; undefined: back to what is
 * (test/setup/artifactsDeployment.ts does that after each test). As for a
 * real deployment, the answer is the same for every server: a test can't
 * turn the key on for one server and off for another.
 */
export function __answerFlagForTests(key: string, enabled: boolean | undefined): void {
  if (enabled === undefined) answeredForTests.delete(key);
  else answeredForTests.set(key, enabled);
}
