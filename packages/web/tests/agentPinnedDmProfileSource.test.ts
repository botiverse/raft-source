import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentDmChannelByAgentId, resolveAgentDmProfileSource } from "../src/components/layout/agentDmProfileSource";
import type { Channel } from "../src/store/channelStore";

function channel(overrides: Partial<Channel>): Channel {
  return {
    id: overrides.id ?? "dm-1",
    name: overrides.name ?? "DM",
    description: null,
    type: "dm",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("agent DM rows prefer the live agent avatar over a stale DM snapshot", () => {
  const profile = resolveAgentDmProfileSource(
    {
      name: "agent-fallback-name",
      displayName: "Agent fallback",
      description: "agent fallback description",
      avatarUrl: "https://example.com/agent.png",
    },
    {
      peerName: "dm-peer-name",
      peerDisplayName: "DM profile",
      peerDescription: "DM source description",
      peerAvatarUrl: "https://example.com/dm.png",
    },
  );

  assert.deepEqual(profile, {
    displayName: "Agent fallback",
    description: "agent fallback description",
    avatarUrl: "https://example.com/agent.png",
  });
});

test("pinned agent DM rows fall back to the agent profile before a DM channel exists", () => {
  const profile = resolveAgentDmProfileSource(
    {
      name: "agent-name",
      displayName: null,
      description: "agent fallback description",
      avatarUrl: "https://example.com/agent.png",
    },
    undefined,
  );

  assert.deepEqual(profile, {
    displayName: "agent-name",
    description: "agent fallback description",
    avatarUrl: "https://example.com/agent.png",
  });
});

test("agent DM rows keep the live agent display name when the DM snapshot only has a peer name", () => {
  const profile = resolveAgentDmProfileSource(
    {
      name: "agent-name",
      displayName: "Agent fallback",
      description: null,
      avatarUrl: null,
    },
    {
      peerName: "dm-peer-name",
      peerDisplayName: null,
      peerDescription: null,
      peerAvatarUrl: null,
    },
  );

  assert.deepEqual(profile, {
    displayName: "Agent fallback",
    description: null,
    avatarUrl: null,
  });
});

test("pinned agent lookup indexes only agent DM channels by peer id", () => {
  const agentDm = channel({
    id: "agent-dm",
    peerType: "agent",
    peerId: "agent-1",
  });
  const humanDm = channel({
    id: "human-dm",
    peerType: "user",
    peerId: "user-1",
  });
  const missingPeer = channel({
    id: "missing-peer",
    peerType: "agent",
    peerId: undefined,
  });

  assert.deepEqual(buildAgentDmChannelByAgentId([humanDm, agentDm, missingPeer]), {
    "agent-1": agentDm,
  });
});
