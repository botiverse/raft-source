import assert from "node:assert/strict";
import { test } from "vitest";

import { decideReadStateDelegation } from "./actorPermissions.js";

const USER = "human-caller";
const creatorAgent = { creatorType: "user" as const, creatorId: USER };
const strangerAgent = { creatorType: "user" as const, creatorId: "someone-else" };

test("server manageAgents capability (owner) authorizes with server_manage_agents basis", () => {
  const decision = decideReadStateDelegation({
    callerServerRole: "owner",
    userId: USER,
    agent: strangerAgent,
  });
  assert.deepEqual(decision, { allowed: true, basis: "server_manage_agents" });
});

test("server manageAgents capability (admin) authorizes with server_manage_agents basis", () => {
  const decision = decideReadStateDelegation({
    callerServerRole: "admin",
    userId: USER,
    agent: strangerAgent,
  });
  assert.deepEqual(decision, { allowed: true, basis: "server_manage_agents" });
});

test("agent creator (member role) authorizes with agent_creator basis", () => {
  const decision = decideReadStateDelegation({
    callerServerRole: "member",
    userId: USER,
    agent: creatorAgent,
  });
  assert.deepEqual(decision, { allowed: true, basis: "agent_creator" });
});

test("when both capability and creator hold, basis is stably server_manage_agents (no trace jitter)", () => {
  const decision = decideReadStateDelegation({
    callerServerRole: "owner",
    userId: USER,
    agent: creatorAgent,
  });
  assert.deepEqual(decision, { allowed: true, basis: "server_manage_agents" });
});

test("member who is neither creator nor capable is denied with null basis (fail-closed)", () => {
  const decision = decideReadStateDelegation({
    callerServerRole: "member",
    userId: USER,
    agent: strangerAgent,
  });
  assert.deepEqual(decision, { allowed: false, basis: null });
});

test("agent-kind creator does NOT authorize a human (creator must be creatorType=user)", () => {
  const decision = decideReadStateDelegation({
    callerServerRole: "member",
    userId: USER,
    agent: { creatorType: "agent", creatorId: USER },
  });
  assert.deepEqual(decision, { allowed: false, basis: null });
});

test("null server role (not a member) who is not creator is denied (fail-closed)", () => {
  const decision = decideReadStateDelegation({
    callerServerRole: null,
    userId: USER,
    agent: strangerAgent,
  });
  assert.deepEqual(decision, { allowed: false, basis: null });
});

test("null-role creator is allowed at the pure policy (mirrors canInspectAgentPrivateSurfaces; membership gated upstream by requireServer)", () => {
  // DOCUMENTED SEMANTICS, not a loophole: the creator branch does not check
  // server membership itself. A null-role creator is allowed here exactly as in
  // canInspectAgentPrivateSurfaces; safety comes from the read-all route sitting
  // under requireServer (which validates non-deleted membership before this
  // runs). A standalone reuser must enforce membership itself. This tooth pins
  // the current mirrored semantics so any future change to it is deliberate.
  const decision = decideReadStateDelegation({
    callerServerRole: null,
    userId: USER,
    agent: creatorAgent,
  });
  assert.deepEqual(decision, { allowed: true, basis: "agent_creator" });
});

test("null creatorType/creatorId never matches (fail-closed)", () => {
  const decision = decideReadStateDelegation({
    callerServerRole: "member",
    userId: USER,
    agent: { creatorType: null, creatorId: null },
  });
  assert.deepEqual(decision, { allowed: false, basis: null });
});
