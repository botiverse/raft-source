// A flag key the deployment answers itself (deploymentAnsweredFlags.ts):
// evaluateFeatureFlags answers it without Feature Flag Admin, the same for
// every server and user, and still asks the store for every other key.
import assert from "node:assert/strict";
import type { DatabaseExecutor } from "../db/index";
import { __answerFlagForTests, answerFlagFromDeployment, deploymentAnswerOf } from "./deploymentAnsweredFlags";
import { evaluateFeatureFlag, evaluateFeatureFlags } from "./featureFlagService";

const KEY = "deployment_answered_test_v0";
const OTHER = "deployment_answered_other_v0";

/** No query may be sent for a key the deployment answers. */
const NO_STORE = new Proxy({}, { get: (_target, property) => { throw new Error(`the flag store was asked (${String(property)})`); } }) as unknown as DatabaseExecutor;

afterEach(() => {
  __answerFlagForTests(KEY, undefined);
  __answerFlagForTests(OTHER, undefined);
});

test("a key nobody registered is Feature Flag Admin's: no deployment answer", () => {
  assert.equal(deploymentAnswerOf("never_registered_v0"), undefined);
});

test("a registered key is answered by the deployment, asked again each time, the same for every server", () => {
  let capable = false;
  answerFlagFromDeployment(KEY, () => capable);
  assert.equal(deploymentAnswerOf(KEY), false);
  capable = true;
  assert.equal(deploymentAnswerOf(KEY), true, "not remembered: what the deployment has now");
});

test("evaluateFeatureFlags answers such a key without the flag store: enabled as the deployment says, reason `default`", async () => {
  let capable = true;
  answerFlagFromDeployment(KEY, () => capable);
  assert.deepEqual(
    await evaluateFeatureFlags([{ key: KEY, serverId: "server-1" }, { key: KEY, serverId: "server-2", userId: "user-1" }, { key: KEY }], NO_STORE),
    [{ key: KEY, enabled: true, reason: "default" }, { key: KEY, enabled: true, reason: "default" }, { key: KEY, enabled: true, reason: "default" }],
  );
  capable = false;
  assert.deepEqual(await evaluateFeatureFlag({ key: KEY, serverId: "server-1" }, NO_STORE), { key: KEY, enabled: false, reason: "default" });
});

test("a test's own answer wins over the deployment's, for every server alike; undefined gives the deployment's back", async () => {
  answerFlagFromDeployment(KEY, () => false);
  __answerFlagForTests(KEY, true);
  assert.equal(deploymentAnswerOf(KEY), true);
  assert.deepEqual(
    (await evaluateFeatureFlags([{ key: KEY, serverId: "server-1" }, { key: KEY, serverId: "server-2" }, { key: KEY }], NO_STORE)).map((answer) => answer.enabled),
    [true, true, true],
    "no server is told apart",
  );
  __answerFlagForTests(KEY, false);
  assert.equal(deploymentAnswerOf(KEY), false);
  __answerFlagForTests(KEY, undefined);
  assert.equal(deploymentAnswerOf(KEY), false, "the deployment's again");
  // Also for a key nothing registered: a test can run as a deployment that answers it.
  __answerFlagForTests(OTHER, true);
  assert.equal(deploymentAnswerOf(OTHER), true);
  __answerFlagForTests(OTHER, undefined);
  assert.equal(deploymentAnswerOf(OTHER), undefined);
});
