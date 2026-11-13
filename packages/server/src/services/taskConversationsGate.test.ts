import assert from "node:assert/strict";
import { beforeEach, vi } from "vitest";

import { TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import type { DatabaseExecutor } from "../db";
import { evaluateFeatureFlag } from "./featureFlagService";
import { isTaskV2ConversationsEnabled, isTaskV2ConversationsEnabledForRequest, readTaskV2ConversationsEnabled } from "./taskConversationsGate";

vi.mock("./featureFlagService", () => ({
  evaluateFeatureFlag: vi.fn(async () => ({ key: "task_v2_conversations_v0", enabled: false, reason: "default" })),
}));

const evaluate = vi.mocked(evaluateFeatureFlag);
// The gate only hands the executor through to the (mocked) evaluator.
const executor = {} as DatabaseExecutor;

beforeEach(() => {
  evaluate.mockReset();
});

test("the gate reads the server's task_v2_conversations_v0 evaluation", async () => {
  evaluate.mockResolvedValueOnce({ key: TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY, enabled: true, reason: "server_rule" });
  assert.equal(await isTaskV2ConversationsEnabled("srv-on", executor), true);
  assert.deepEqual(evaluate.mock.calls[0]?.[0], { key: TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY, serverId: "srv-on" });
});

test("a flag evaluation that throws reads as off, for the server and for a request", async () => {
  evaluate.mockRejectedValue(new Error("feature flag store unavailable"));
  assert.equal(await isTaskV2ConversationsEnabled("srv-broken", executor), false);
  assert.equal(
    await isTaskV2ConversationsEnabledForRequest({ initiatingServerId: "srv-broken", storageChannelId: "ch-joint" }, executor),
    false,
  );
  assert.equal(evaluate.mock.calls.length, 2);
  assert.ok(evaluate.mock.calls.every(([input]) => input.key === TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY && input.serverId === "srv-broken"));
});

test("the strict read distinguishes a failed flag evaluation from a missing or disabled flag", async () => {
  evaluate.mockRejectedValueOnce(new Error("feature flag store unavailable"));
  await assert.rejects(readTaskV2ConversationsEnabled("srv-broken", executor), /feature flag store unavailable/);
  evaluate.mockResolvedValueOnce({ key: TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY, enabled: false, reason: "missing_flag" });
  assert.equal(await readTaskV2ConversationsEnabled("srv-missing", executor), false);
});
