import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANNEL_ADMIN_CAPABILITIES,
  CHANNEL_MANAGEMENT_CAPABILITIES,
  canAddChannelMembers,
  canGuestJoinChannel,
  canGuestPostToChannel,
  canGuestReadChannel,
  getChannelAdminBasis,
  hasEffectiveChannelCapability,
} from "./channelPermissions.js";

test("stored channel admin grants only the closed local capability set", () => {
  for (const capability of CHANNEL_ADMIN_CAPABILITIES) {
    assert.equal(hasEffectiveChannelCapability({
      serverRole: "member",
      channelRole: "admin",
      isChannelMember: true,
      supportsChannelRoles: true,
      capability,
    }), true, capability);
  }

  for (const capability of ["deleteChannels", "changeChannelVisibility", "federateChannels"] as const) {
    assert.equal(hasEffectiveChannelCapability({
      serverRole: "member",
      channelRole: "admin",
      isChannelMember: true,
      supportsChannelRoles: true,
      capability,
    }), false, capability);
  }
});

test("Guest role rejects stale stored channel-admin grants", () => {
  for (const capability of CHANNEL_ADMIN_CAPABILITIES) {
    assert.equal(hasEffectiveChannelCapability({
      serverRole: "guest",
      channelRole: "admin",
      isChannelMember: true,
      supportsChannelRoles: true,
      capability,
    }), false, capability);
  }

  assert.equal(getChannelAdminBasis({
    serverRole: "guest",
    channelRole: "admin",
    isChannelMember: true,
    supportsChannelRoles: true,
  }), null);
});

test("add-member policy is admission-aware, shape-closed, and independent of local admin", () => {
  const base = {
    admissionClass: "current_member" as const,
    channelType: "channel",
    channelName: "dev",
    archived: false,
    deleted: false,
  };
  for (const serverRole of ["owner", "admin"] as const) {
    assert.equal(canAddChannelMembers({ ...base, serverRole, isChannelMember: false }), true, serverRole);
  }
  assert.equal(canAddChannelMembers({ ...base, serverRole: "member", isChannelMember: true }), true);
  assert.equal(canAddChannelMembers({ ...base, serverRole: "member", isChannelMember: false }), false);
  assert.equal(canAddChannelMembers({ ...base, serverRole: "guest", admissionClass: "guest", isChannelMember: true }), false);
  assert.equal(canAddChannelMembers({
    ...base,
    serverRole: "member",
    admissionClass: "visitor",
    isChannelMember: true,
  }), false);

  // Joint channels are addable again (task #1150): the same admission rules
  // apply, so a joint channel is not a way around them.
  for (const serverRole of ["owner", "admin"] as const) {
    assert.equal(canAddChannelMembers({
      ...base,
      serverRole,
      isChannelMember: false,
      channelType: "joint",
    }), true, `joint/${serverRole}`);
  }
  assert.equal(canAddChannelMembers({
    ...base,
    serverRole: "member",
    isChannelMember: true,
    channelType: "joint",
  }), true);
  assert.equal(canAddChannelMembers({
    ...base,
    serverRole: "member",
    isChannelMember: false,
    channelType: "joint",
  }), false, "a joint channel still requires the member to have joined it");
  assert.equal(canAddChannelMembers({
    ...base,
    serverRole: "guest",
    admissionClass: "guest",
    isChannelMember: true,
    channelType: "joint",
  }), false, "a Guest is denied in joint channels too");

  for (const channelType of ["dm", "thread"] as const) {
    assert.equal(canAddChannelMembers({
      ...base,
      serverRole: "owner",
      isChannelMember: true,
      channelType,
    }), false, channelType);
  }
  assert.equal(canAddChannelMembers({ ...base, serverRole: "owner", isChannelMember: true, channelName: "all" }), false);
  assert.equal(canAddChannelMembers({ ...base, serverRole: "owner", isChannelMember: true, archived: true }), false);
  assert.equal(canAddChannelMembers({ ...base, serverRole: "owner", isChannelMember: true, deleted: true }), false);
});

test("channel projection includes local and server-only management capabilities", () => {
  assert.deepEqual(CHANNEL_MANAGEMENT_CAPABILITIES, [
    "editChannelMetadata",
    "archiveChannels",
    "deleteChannels",
    "changeChannelVisibility",
    "manageGuestAccess",
    "federateChannels",
    "addChannelMembers",
    "removeChannelMembers",
    "changeChannelMemberRoles",
  ]);
});

test("guest channel policy separates read, join, and post authority", () => {
  const base = {
    gateEnabled: true,
    serverRole: "guest" as const,
    channelType: "channel" as const,
    channelName: "project",
    guestVisible: true,
    guestJoinable: true,
    isChannelMember: false,
    archived: false,
    deleted: false,
  };
  assert.equal(canGuestReadChannel(base), true);
  assert.equal(canGuestJoinChannel(base), true);
  assert.equal(canGuestPostToChannel(base), false);
  assert.equal(canGuestPostToChannel({ ...base, isChannelMember: true }), true);
});

test("guest channel policy fails closed for rollout, shape, archive, and hidden all boundaries", () => {
  const base = {
    gateEnabled: true,
    serverRole: "guest" as const,
    channelType: "channel" as const,
    channelName: "project",
    guestVisible: true,
    guestJoinable: true,
    isChannelMember: false,
    archived: false,
    deleted: false,
  };
  assert.equal(canGuestReadChannel({ ...base, gateEnabled: false }), false);
  assert.equal(canGuestReadChannel({ ...base, channelType: "joint" }), false);
  assert.equal(canGuestReadChannel({ ...base, archived: true }), true);
  assert.equal(canGuestReadChannel({ ...base, deleted: true }), false);
  assert.equal(canGuestJoinChannel({ ...base, archived: true }), false);
  assert.equal(canGuestReadChannel({ ...base, channelName: "all", allChannelHidden: true }), false);
  assert.equal(canGuestReadChannel({ ...base, channelType: "private", isChannelMember: false }), false);
  assert.equal(canGuestReadChannel({ ...base, channelType: "private", isChannelMember: true }), true);
  assert.equal(canGuestReadChannel({ ...base, channelType: "dm", isChannelMember: true }), true);
  assert.equal(canGuestPostToChannel({ ...base, channelType: "dm", isChannelMember: true }), true);
  assert.equal(canGuestPostToChannel({ ...base, archived: true, isChannelMember: true }), false);
});

test("#all exposes one read-only Guest policy and never creates Guest membership", () => {
  const all = {
    gateEnabled: true,
    serverRole: "guest" as const,
    channelType: "channel" as const,
    channelName: "all",
    allChannelHidden: false,
    guestVisible: true,
    guestJoinable: true,
    isChannelMember: false,
    archived: false,
    deleted: false,
  };
  assert.equal(canGuestReadChannel(all), true);
  assert.equal(canGuestReadChannel({ ...all, guestVisible: false }), false);
  assert.equal(canGuestReadChannel({ ...all, allChannelHidden: true }), false);
  assert.equal(canGuestJoinChannel(all), false);
  assert.equal(canGuestJoinChannel({ ...all, isChannelMember: true }), false);
  assert.equal(canGuestPostToChannel({ ...all, isChannelMember: true }), false);
});

test("local role never bypasses membership or unsupported channel shape", () => {
  for (const input of [
    { isChannelMember: false, supportsChannelRoles: true },
    { isChannelMember: true, supportsChannelRoles: false },
  ]) {
    assert.equal(hasEffectiveChannelCapability({
      serverRole: "member",
      channelRole: "admin",
      capability: "archiveChannels",
      ...input,
    }), false);
  }
});

test("server inheritance and stored grants retain distinct basis", () => {
  assert.equal(getChannelAdminBasis({
    serverRole: "admin",
    channelRole: "member",
    isChannelMember: true,
    supportsChannelRoles: true,
  }), "server_role");
  assert.equal(getChannelAdminBasis({
    serverRole: "member",
    channelRole: "admin",
    isChannelMember: true,
    supportsChannelRoles: true,
  }), "channel_role");
  assert.equal(getChannelAdminBasis({
    serverRole: "owner",
    channelRole: "admin",
    isChannelMember: true,
    supportsChannelRoles: true,
  }), "both");
});
