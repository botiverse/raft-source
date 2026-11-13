// The server features helpers (`./featuresChanged`): what an `agent:start`
// config carries, when two sets of values turn the same things on, and the
// config a daemon runs with after applying new values. The daemon decides
// whether to restart an agent from `agentServerFeaturesEqual`, so a false
// "changed" restarts agents for nothing and a false "same" keeps them on the
// old prompt.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_SERVER_FEATURE_KEYS,
  agentServerFeaturesEqual,
  normalizeAgentServerFeatures,
  pickAgentServerFeatures,
  withAgentServerFeatures,
  type AgentConfig,
} from "./index";

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "alice",
    displayName: "Alice",
    description: null,
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    envVars: { A: "1" },
    sessionId: "session-1",
    serverUrl: "https://raft.example.test",
    authToken: "",
    ...overrides,
  };
}

test("pick: booleans only when true, enabledApps as given, nothing else", () => {
  const picked = pickAgentServerFeatures(config({
    subagentDelegation: true,
    passiveAx: false,
    reminderApp: true,
    piSessionRotation: undefined,
    taskConversations: true,
    inboxItems: true,
    enabledApps: ["b", "a", "b"],
    runtimeHost: "oar",
    installedApps: [{ name: "x", description: null, whenToUse: "y" }],
  }));
  assert.deepEqual(picked, { subagentDelegation: true, reminderApp: true, taskConversations: true, inboxItems: true, enabledApps: ["b", "a", "b"] });
  assert.deepEqual(pickAgentServerFeatures(config()), {}, "an older Server's config: enabledApps stays absent");
});

test("normalize: false and absent read the same; enabledApps sorted, de-duplicated, absent as none", () => {
  assert.deepEqual(normalizeAgentServerFeatures({ passiveAx: false, vaultApp: true, enabledApps: ["b", "a", "b"] }), { vaultApp: true, enabledApps: ["a", "b"] });
  assert.deepEqual(normalizeAgentServerFeatures({}), { enabledApps: [] });
});

test("equal: order and duplicates in enabledApps, and false against absent, are never a change", () => {
  assert.equal(agentServerFeaturesEqual({ enabledApps: ["a", "b"] }, { enabledApps: ["b", "a", "a"] }), true);
  assert.equal(agentServerFeaturesEqual({ passiveAx: false }, {}), true);
  assert.equal(agentServerFeaturesEqual({}, { enabledApps: [] }), true);
  assert.equal(agentServerFeaturesEqual({ enabledApps: ["a"] }, { enabledApps: ["a", "b"] }), false);
  assert.equal(agentServerFeaturesEqual({ enabledApps: ["a"] }, { enabledApps: ["b"] }), false);
  for (const key of AGENT_SERVER_FEATURE_KEYS) {
    if (key === "enabledApps" || key === "inboxItemsLaunchAt") continue;
    assert.equal(agentServerFeaturesEqual({ [key]: true }, {}), false, key);
  }
});

test("with: every server feature replaced from the new values, every other field untouched", () => {
  const before = config({
    subagentDelegation: true,
    passiveAx: true,
    taskConversations: true,
    enabledApps: ["artifacts"],
    runtimeHost: "oar",
    agentCredentialKey: "sk_agent_x",
  });
  const after = withAgentServerFeatures(before, { passiveAx: true, reminderApp: true, vaultApp: false });
  assert.deepEqual(after, {
    ...config({ runtimeHost: "oar", agentCredentialKey: "sk_agent_x" }),
    passiveAx: true,
    reminderApp: true,
    enabledApps: [],
  });
  assert.equal("subagentDelegation" in after, false, "a flag turned off is removed, as agent:start leaves it out");
  assert.equal("vaultApp" in after, false);
  assert.deepEqual(before.enabledApps, ["artifacts"], "the input is not modified");
  assert.equal(agentServerFeaturesEqual(pickAgentServerFeatures(after), { passiveAx: true, reminderApp: true }), true);
});

// RFC 081: `inboxItemsLaunchAt` rides beside `inboxItems` (only then), so the
// daemon can tell reminders fired after the launch from older ones.
const LAUNCH_AT = "2026-01-01T00:00:00.000Z";

test("inboxItemsLaunchAt: picked, normalized and applied beside inboxItems, and only beside it", () => {
  assert.deepEqual(pickAgentServerFeatures(config({ inboxItems: true, inboxItemsLaunchAt: LAUNCH_AT })), { inboxItems: true, inboxItemsLaunchAt: LAUNCH_AT });
  assert.deepEqual(pickAgentServerFeatures(config({ inboxItemsLaunchAt: LAUNCH_AT })), {}, "without inboxItems it is dropped");
  assert.deepEqual(pickAgentServerFeatures(config({ inboxItems: true })), { inboxItems: true }, "an older Server: the boolean alone, unchanged");
  assert.deepEqual(normalizeAgentServerFeatures({ inboxItems: true, inboxItemsLaunchAt: LAUNCH_AT }), { inboxItems: true, inboxItemsLaunchAt: LAUNCH_AT, enabledApps: [] });
  assert.deepEqual(normalizeAgentServerFeatures({ inboxItems: false, inboxItemsLaunchAt: LAUNCH_AT }), { enabledApps: [] });

  const on = withAgentServerFeatures(config(), { inboxItems: true, inboxItemsLaunchAt: LAUNCH_AT });
  assert.equal(on.inboxItems, true);
  assert.equal(on.inboxItemsLaunchAt, LAUNCH_AT);
  const off = withAgentServerFeatures(on, {});
  assert.equal("inboxItems" in off, false);
  assert.equal("inboxItemsLaunchAt" in off, false, "turned off, the launch time goes with the flag");
});

test("inboxItemsLaunchAt: a different launch time is a change; one without inboxItems is not", () => {
  assert.equal(agentServerFeaturesEqual({ inboxItems: true, inboxItemsLaunchAt: LAUNCH_AT }, { inboxItems: true }), false);
  assert.equal(agentServerFeaturesEqual({ inboxItems: true, inboxItemsLaunchAt: LAUNCH_AT }, { inboxItems: true, inboxItemsLaunchAt: "2026-02-01T00:00:00.000Z" }), false);
  assert.equal(agentServerFeaturesEqual({ inboxItems: true, inboxItemsLaunchAt: LAUNCH_AT }, { inboxItems: true, inboxItemsLaunchAt: LAUNCH_AT }), true);
  assert.equal(agentServerFeaturesEqual({ inboxItemsLaunchAt: LAUNCH_AT }, {}), true);
});
