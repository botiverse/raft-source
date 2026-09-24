import assert from "node:assert/strict";
import test from "node:test";
import { getSidebarDmContextTarget } from "../src/components/layout/sidebarDmContext.js";
import type { Channel } from "../src/store/channelStore.js";

function makeDm(overrides: Partial<Channel> & { id: string }): Channel {
  return {
    id: overrides.id,
    name: "dm",
    description: null,
    type: "dm",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("uses peer context menu when an agent DM peer is still visible", () => {
  const target = getSidebarDmContextTarget(
    makeDm({ id: "dm-agent", peerType: "agent", peerId: "agent-1" }),
    { agentIds: new Set(["agent-1"]), humanIds: new Set() },
  );

  assert.deepEqual(target, { type: "agent", id: "agent-1" });
});

test("falls back to DM conversation menu when an agent peer was removed", () => {
  const target = getSidebarDmContextTarget(
    makeDm({ id: "dm-agent", peerType: "agent", peerId: "agent-removed" }),
    { agentIds: new Set(), humanIds: new Set() },
  );

  assert.deepEqual(target, { type: "dm", id: "dm-agent" });
});

test("uses peer context menu when a human DM peer is still visible", () => {
  const target = getSidebarDmContextTarget(
    makeDm({ id: "dm-human", peerType: "user", peerId: "user-1" }),
    { agentIds: new Set(), humanIds: new Set(["user-1"]) },
  );

  assert.deepEqual(target, { type: "human", id: "user-1" });
});

test("falls back to DM conversation menu when a human peer was removed", () => {
  const target = getSidebarDmContextTarget(
    makeDm({ id: "dm-human", peerType: "user", peerId: "user-removed" }),
    { agentIds: new Set(), humanIds: new Set() },
  );

  assert.deepEqual(target, { type: "dm", id: "dm-human" });
});

test("falls back to DM conversation menu when peer metadata is missing", () => {
  const target = getSidebarDmContextTarget(
    makeDm({ id: "dm-legacy", peerType: "user" }),
    { agentIds: new Set(["agent-1"]), humanIds: new Set(["user-1"]) },
  );

  assert.deepEqual(target, { type: "dm", id: "dm-legacy" });
});
