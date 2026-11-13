import assert from "node:assert/strict";
import { getServerCapabilities } from "@botiverse/raft-shared";
import { agentRuntimePermissions, canViewAgentPrivateSurfaces } from "../src/utils/agentVisibility";

test("agent private surfaces are visible to server agent managers", () => {
  assert.equal(
    canViewAgentPrivateSurfaces({ creatorType: null, creatorId: null }, undefined, true),
    true,
  );
});

test("agent private surfaces are visible to the human creator", () => {
  assert.equal(
    canViewAgentPrivateSurfaces({ creatorType: "user", creatorId: "user-1" }, "user-1", false),
    true,
  );
});

test("agent private surfaces are hidden from non-creator members", () => {
  assert.equal(
    canViewAgentPrivateSurfaces({ creatorType: "user", creatorId: "user-1" }, "user-2", false),
    false,
  );
  assert.equal(
    canViewAgentPrivateSurfaces({ creatorType: "agent", creatorId: "agent-1" }, "user-1", false),
    false,
  );
});

// The one rule the agent profile and the Members page's menu read (agentRuntimePermissions).
test("runtime permissions: none for an external agent or a bounded projection; Stop and Full reset are the creator's or an admin's", () => {
  const someoneElses = { creatorType: "user" as const, creatorId: "user-1" };
  const none = { canControlAgentRuntime: false, canStopAgent: false, canResetAgentWorkspace: false };
  const admin = getServerCapabilities("admin");
  const member = getServerCapabilities("member");
  assert.deepEqual(agentRuntimePermissions(someoneElses, "user-2", admin, { isExternalAgent: true }), none);
  assert.deepEqual(agentRuntimePermissions(someoneElses, "user-2", admin, { isExternalAgent: false, isBoundedPublicProjection: true }), none);
  assert.deepEqual(
    agentRuntimePermissions(someoneElses, "user-2", admin, { isExternalAgent: false }),
    { canControlAgentRuntime: true, canStopAgent: true, canResetAgentWorkspace: true },
  );
  const memberOnOthers = agentRuntimePermissions(someoneElses, "user-2", member, { isExternalAgent: false });
  assert.equal(memberOnOthers.canStopAgent, false, "a member does not stop someone else's agent");
  assert.equal(memberOnOthers.canResetAgentWorkspace, false);
  assert.equal(memberOnOthers.canControlAgentRuntime, member.controlAgentRuntime);
  assert.deepEqual(
    agentRuntimePermissions(someoneElses, "user-1", member, { isExternalAgent: false }),
    { canControlAgentRuntime: true, canStopAgent: true, canResetAgentWorkspace: true },
    "its creator may",
  );
});
