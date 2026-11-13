import assert from "node:assert/strict";
import {
  CHANNEL_ADMIN_CAPABILITIES,
  CHANNEL_MANAGEMENT_CAPABILITIES,
  canAddChannelMembers,
  canGuestPostToChannel,
  canGuestReadChannel,
  getChannelAdminBasis,
  hasEffectiveChannelCapability,
  channelSupportsRoles,
} from "./channelPermissions";

test("stored channel admin grants only the closed local capability set", () => {
  for (const capability of CHANNEL_ADMIN_CAPABILITIES) {
    assert.equal(hasEffectiveChannelCapability({
      serverRole: "member",
      channelRole: "admin",
      isChannelMember: true,
      supportsChannelRoles: true,
      capability,
      channelType: "channel",
    }), true, capability);
  }

  for (const capability of ["deleteChannels", "changeChannelVisibility", "federateChannels"] as const) {
    assert.equal(hasEffectiveChannelCapability({
      serverRole: "member",
      channelRole: "admin",
      isChannelMember: true,
      supportsChannelRoles: true,
      capability,
      channelType: "channel",
    }), false, capability);
  }
});

test("a stored admin on a joint channel grants nothing on its own (the host decides)", () => {
  for (const capability of CHANNEL_ADMIN_CAPABILITIES) {
    assert.equal(hasEffectiveChannelCapability({
      serverRole: "member",
      channelRole: "admin",
      isChannelMember: true,
      supportsChannelRoles: true,
      capability,
      channelType: "joint",
    }), false, capability);
  }
});

test("channel roles exist on public, private and joint channels, never on #all", () => {
  for (const type of ["channel", "private", "joint"]) assert.equal(channelSupportsRoles(type, "room"), true, type);
  for (const type of ["dm", "thread"]) assert.equal(channelSupportsRoles(type, "room"), false, type);
  assert.equal(channelSupportsRoles("channel", "all"), false);
});

test("Guest role rejects stale stored channel-admin grants", () => {
  for (const capability of CHANNEL_ADMIN_CAPABILITIES) {
    assert.equal(hasEffectiveChannelCapability({
      serverRole: "guest",
      channelRole: "admin",
      isChannelMember: true,
      supportsChannelRoles: true,
      capability,
      channelType: "channel",
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
  // apply, so a joint channel is not a way around them. A joint channel is
  // shared with other servers, so owner/admin must be in it too (#wg-rbac B6).
  for (const serverRole of ["owner", "admin"] as const) {
    assert.equal(canAddChannelMembers({
      ...base,
      serverRole,
      isChannelMember: true,
      channelType: "joint",
    }), true, `joint/${serverRole}/joined`);
    assert.equal(canAddChannelMembers({
      ...base,
      serverRole,
      isChannelMember: false,
      channelType: "joint",
    }), false, `joint/${serverRole}/not joined`);
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
    "manageVisitorAccess",
    "federateChannels",
    "addChannelMembers",
    "removeChannelMembers",
    "changeChannelMemberRoles",
  ]);
});

test("a Guest reads and posts only in its one bound channel (#wg-rbac:#15)", () => {
  const base = {
    serverRole: "guest" as const,
    channelId: "bound",
    channelType: "private" as const,
    guestChannelId: "bound",
    isChannelMember: true,
    archived: false,
    deleted: false,
  };
  assert.equal(canGuestReadChannel(base), true);
  assert.equal(canGuestPostToChannel(base), true);
  assert.equal(canGuestReadChannel({ ...base, channelType: "channel" }), true);
  // P3: its bound joint channel, once the server resolved the host entry.
  assert.equal(canGuestReadChannel({ ...base, channelType: "joint", jointEntry: true }), true);
  assert.equal(canGuestPostToChannel({ ...base, channelType: "joint", jointEntry: true }), true);
});

test("a Guest is denied everything outside its live, bound membership", () => {
  const base = {
    serverRole: "guest" as const,
    channelId: "bound",
    channelType: "private" as const,
    guestChannelId: "bound",
    isChannelMember: true,
    archived: false,
    deleted: false,
  };
  for (const [label, input] of [
    ["another channel, even as its member", { ...base, channelId: "other" }],
    ["no binding (legacy Guest)", { ...base, guestChannelId: null }],
    ["bound but no longer a member", { ...base, isChannelMember: false }],
    ["archived", { ...base, archived: true }],
    ["deleted", { ...base, deleted: true }],
    ["a DM", { ...base, channelType: "dm" as const }],
    ["a joint channel without a resolved joint entry", { ...base, channelType: "joint" as const }],
    ["a joint channel whose entry was refused", { ...base, channelType: "joint" as const, jointEntry: false }],
    ["another joint channel, even with an entry", { ...base, channelType: "joint" as const, jointEntry: true, channelId: "other" }],
    ["a joint channel with an entry but no membership", { ...base, channelType: "joint" as const, jointEntry: true, isChannelMember: false }],
    ["a thread passed unresolved", { ...base, channelType: "thread" as const }],
    ["not a Guest", { ...base, serverRole: "member" as const }],
  ] as const) {
    assert.equal(canGuestReadChannel(input), false, `read: ${label}`);
    assert.equal(canGuestPostToChannel(input), false, `post: ${label}`);
  }
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
      channelType: "channel",
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
