import assert from "node:assert/strict";
import test from "node:test";
import {
  isFullPageAgentDetailPath,
  openConversationAgentProfile,
  resolveOrderedFirstAgentTab,
  shouldDeleteAgentTabDuringProfileSync,
} from "../src/utils/profilePanelUrl";

test("profile overlay clears stale agentTab when opening a different agent", () => {
  assert.equal(
    shouldDeleteAgentTabDuringProfileSync(
      "/s/botiverse/channel/chan-1",
      "agent:old-agent",
      "agent",
      "new-agent",
    ),
    true,
  );
});

test("profile overlay preserves agentTab while syncing the same open agent", () => {
  assert.equal(
    shouldDeleteAgentTabDuringProfileSync(
      "/s/botiverse/channel/chan-1",
      "agent:same-agent",
      "agent",
      "same-agent",
    ),
    false,
  );
});

test("profile overlay clears agentTab when explicitly reopening the same agent", () => {
  assert.equal(
    shouldDeleteAgentTabDuringProfileSync(
      "/s/botiverse/channel/chan-1",
      "agent:same-agent",
      "agent",
      "same-agent",
      { resetAgentTabForProfileReopen: true },
    ),
    true,
  );
});

test("profile overlay clears agentTab when switching from an agent to a human", () => {
  assert.equal(
    shouldDeleteAgentTabDuringProfileSync(
      "/s/botiverse/channel/chan-1",
      "agent:agent-1",
      "human",
      "human-1",
    ),
    true,
  );
});

test("full page agent route owns agentTab and does not clear it during route sync", () => {
  assert.equal(isFullPageAgentDetailPath("/s/botiverse/agent/agent-1"), true);
  assert.equal(
    shouldDeleteAgentTabDuringProfileSync(
      "/s/botiverse/agent/agent-1",
      null,
      null,
      null,
    ),
    false,
  );
});

test("conversation-flow ordered-first intent resolves the first persisted visible agent tab", () => {
  assert.equal(
    resolveOrderedFirstAgentTab(
      ["profile", "activity", "chat"],
      ["activity", "profile", "chat"],
    ),
    "activity",
  );
});

test("ordered-first intent normalizes legacy channel tab names", () => {
  assert.equal(
    resolveOrderedFirstAgentTab(
      ["profile", "activity", "chat"],
      ["channels", "activity", "profile"],
    ),
    "chat",
  );
});

test("conversation message agent navigation carries ordered-first profile intent", () => {
  const calls: Array<unknown[]> = [];
  openConversationAgentProfile((...args) => {
    calls.push(args);
  }, "agent-1");

  assert.deepEqual(calls, [
    ["agent", "agent-1", { defaultAgentTabIntent: "ordered-first" }],
  ]);
});

test("conversation message agent navigation records its opening surface", () => {
  const calls: Array<unknown[]> = [];
  openConversationAgentProfile((...args) => {
    calls.push(args);
  }, "agent-1", { openSource: "thread" });

  assert.deepEqual(calls, [
    ["agent", "agent-1", { defaultAgentTabIntent: "ordered-first", openSource: "thread" }],
  ]);
});
