import assert from "node:assert/strict";
import test from "node:test";
import {
  getCachedAgentProfile,
  getCachedHumanProfile,
  primeHumanProfileFromChannelMember,
  setCachedAgentProfile,
} from "../src/components/profile/profileFallbackCache";
import type { Agent } from "../src/store/agentStore";

function makeAgent(): Agent {
  return {
    id: "agent-peer-1",
    serverId: "peer-server",
    serverName: "Peer Server",
    serverSlug: "peer",
    name: "peer-agent",
    displayName: "Peer Agent",
    avatarUrl: null,
    description: "remote peer",
    status: "active",
    model: "gpt-5.2",
    runtime: "codex",
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: null,
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: new Date(0).toISOString(),
  };
}

test("profile fallback cache stores peer agent and human summaries for instant panel open", () => {
  const agent = makeAgent();
  setCachedAgentProfile("host-server", agent);
  assert.deepEqual(getCachedAgentProfile("host-server", agent.id), agent);
  assert.equal(getCachedAgentProfile("other-server", agent.id), null);

  primeHumanProfileFromChannelMember("host-server", {
    id: "human-peer-1",
    serverId: "peer-server",
    serverName: "Peer Server",
    serverSlug: "peer",
    name: "peer-human",
    displayName: "Peer Human",
    description: "remote person",
    avatarUrl: null,
    gravatarHash: "",
  });
  assert.deepEqual(getCachedHumanProfile("host-server", "human-peer-1"), {
    userId: "human-peer-1",
    serverId: "peer-server",
    serverName: "Peer Server",
    serverSlug: "peer",
    email: null,
    gravatarHash: "",
    name: "peer-human",
    displayName: "Peer Human",
    description: "remote person",
    avatarUrl: null,
    role: null,
    joinedAt: null,
    membershipStatus: "active",
    createdAgents: [],
  });
});
