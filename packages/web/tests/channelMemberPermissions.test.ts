import assert from "node:assert/strict";
import test from "node:test";
import { canUseChannelMemberAction, resolveChannelMemberViewerRole } from "../src/utils/channelMemberPermissions";

const baseInput = {
  currentUserId: "viewer",
  currentServerId: "server-1",
  channelServerId: "server-1",
  channelHumans: [],
  serverMembers: [],
};

test("channel member actions are available to ordinary members when the action capability is granted", () => {
  assert.equal(canUseChannelMemberAction({
    ...baseInput,
    channelHumans: [{ id: "viewer", serverId: "server-1", role: "member" }],
    serverMembers: [{ userId: "viewer", serverId: "server-1", role: "member" }],
    hasChannelMemberCapability: true,
  }), true);
});

test("channel member controls are available to server admins from the server member snapshot", () => {
  assert.equal(canUseChannelMemberAction({
    ...baseInput,
    serverMembers: [{ userId: "viewer", serverId: "server-1", role: "admin" }],
    hasChannelMemberCapability: true,
  }), true);
});

test("channel member actions require their action-specific capability", () => {
  assert.equal(canUseChannelMemberAction({
    ...baseInput,
    serverMembers: [{ userId: "viewer", serverId: "server-1", role: "owner" }],
    hasChannelMemberCapability: false,
  }), false);
});

test("channel member controls stay disabled for the system #all channel", () => {
  assert.equal(canUseChannelMemberAction({
    ...baseInput,
    serverMembers: [{ userId: "viewer", serverId: "server-1", role: "owner" }],
    hasChannelMemberCapability: true,
    isAllChannel: true,
  }), false);
});

test("channel member actions require a local viewer membership", () => {
  assert.equal(canUseChannelMemberAction({
    ...baseInput,
    hasChannelMemberCapability: true,
  }), false);
});

test("viewer role resolution ignores remote joint-member rows", () => {
  assert.equal(resolveChannelMemberViewerRole({
    ...baseInput,
    channelHumans: [{ id: "viewer", serverId: "peer-server", role: "admin" }],
    serverMembers: [{ userId: "viewer", serverId: "server-1", role: "member" }],
  }), "member");
});
