import assert from "node:assert/strict";
import {
  SERVER_CAPABILITY_KEYS,
  canChangeAgentMemberRole,
  canChangeMemberRole,
  canTransitionServerRole,
  canMutateBilling,
  canReadBillingSummary,
  getServerCapabilities,
  getServerSurfaceCapabilities,
  hasServerCapability,
  type ServerCapability,
  type ServerRole,
} from "./serverPermissions";

test("public server view modes never derive membership powers from authentication", () => {
  const anonymous = getServerSurfaceCapabilities("public-anonymous");
  const signedIn = getServerSurfaceCapabilities("public-authenticated-nonmember");

  for (const projection of [anonymous, signedIn]) {
    assert.equal(projection.readPublicChannels, true);
    assert.equal(projection.writeMessages, false);
    assert.equal(projection.reactToMessages, false);
    assert.equal(projection.followThreads, false);
    assert.deepEqual(
      SERVER_CAPABILITY_KEYS.filter((key) => projection.server[key]),
      [],
      "a public viewer has no server membership capability",
    );
  }
  assert.equal(anonymous.showHelp, false);
  assert.equal(anonymous.settingsScope, "anonymous-resources");
  assert.equal(signedIn.showHelp, true);
  assert.equal(signedIn.settingsScope, "account-and-resources");
});

const MEMBER_CAPABILITIES = new Set<ServerCapability>([
  "createChannels",
  "joinPublicChannels",
  "addChannelMembers",
  "viewMembers",
  "viewServerProfile",
  "viewAgents",
  "controlAgentRuntime",
  "viewMachines",
  "assignTasks",
]);

test("server capability registry contains the complete 41-capability contract", () => {
  assert.equal(SERVER_CAPABILITY_KEYS.length, 41);
  assert.equal(new Set(SERVER_CAPABILITY_KEYS).size, 41);
});

test("role bundles match every role x capability cell", () => {
  for (const role of ["owner", "admin", "member", "guest"] satisfies ServerRole[]) {
    const capabilities = getServerCapabilities(role);
    assert.deepEqual(Object.keys(capabilities), [...SERVER_CAPABILITY_KEYS]);

    for (const capability of SERVER_CAPABILITY_KEYS) {
      const expected = role === "owner"
        || (role === "admin" && capability !== "manageBilling" && capability !== "manageSso")
        || (role === "member" && MEMBER_CAPABILITIES.has(capability));
      assert.equal(hasServerCapability(role, capability), expected, `${role}.${capability}`);
    }
  }
});

test("guest has an explicit all-false server capability bundle", () => {
  assert.deepEqual(
    SERVER_CAPABILITY_KEYS.filter((capability) => hasServerCapability("guest", capability)),
    [],
  );
});

test("member has exactly the nine explicitly approved capabilities", () => {
  const granted = SERVER_CAPABILITY_KEYS.filter((capability) => hasServerCapability("member", capability));
  assert.deepEqual(granted, [...MEMBER_CAPABILITIES]);
});

test("unknown membership fails closed for every capability", () => {
  for (const capability of SERVER_CAPABILITY_KEYS) {
    assert.equal(hasServerCapability(null, capability), false, `null.${capability}`);
    assert.equal(hasServerCapability(undefined, capability), false, `undefined.${capability}`);
  }
});

test("billing read and mutation use distinct capabilities", () => {
  assert.equal(canReadBillingSummary("owner"), true);
  assert.equal(canReadBillingSummary("admin"), true);
  assert.equal(canReadBillingSummary("member"), false);
  assert.equal(canMutateBilling("owner"), true);
  assert.equal(canMutateBilling("admin"), false);
  assert.equal(canMutateBilling("member"), false);
});

test("owner can change any existing member role through the currently exposed role surface", () => {
  for (const targetRole of ["owner", "admin", "member", "guest"] satisfies ServerRole[]) {
    for (const nextRole of ["owner", "admin", "member"] as const) {
      assert.equal(canChangeMemberRole("owner", targetRole, nextRole), true, `${targetRole}->${nextRole}`);
    }
  }
});

test("admin can only promote a member to admin", () => {
  assert.equal(canChangeMemberRole("admin", "member", "admin"), true);
  for (const [targetRole, nextRole] of [
    ["member", "member"],
    ["member", "owner"],
    ["admin", "member"],
    ["admin", "admin"],
    ["admin", "owner"],
    ["owner", "member"],
    ["owner", "admin"],
    ["owner", "owner"],
  ] satisfies [ServerRole, ServerRole][]) {
    assert.equal(canChangeMemberRole("admin", targetRole, nextRole), false, `${targetRole}->${nextRole}`);
  }
});

test("an admin can also demote an admin agent to member; nothing else widens for agents", () => {
  assert.equal(canChangeAgentMemberRole("admin", "admin", "member"), true);
  assert.equal(canChangeAgentMemberRole("admin", "member", "admin"), true);
  // People keep the peer-admin rule.
  assert.equal(canChangeMemberRole("admin", "admin", "member"), false);
  for (const [targetRole, nextRole] of [
    ["member", "member"],
    ["member", "owner"],
    ["admin", "admin"],
    ["admin", "owner"],
    ["owner", "member"],
    ["owner", "admin"],
    ["owner", "owner"],
  ] satisfies [ServerRole, ServerRole][]) {
    assert.equal(canChangeAgentMemberRole("admin", targetRole, nextRole), false, `${targetRole}->${nextRole}`);
  }
  for (const actorRole of ["member", "guest", null] as const) {
    assert.equal(canChangeAgentMemberRole(actorRole, "admin", "member"), false, String(actorRole));
    assert.equal(canChangeAgentMemberRole(actorRole, "member", "admin"), false, String(actorRole));
  }
  assert.equal(canChangeAgentMemberRole("owner", "admin", "member"), true);
  assert.equal(canChangeAgentMemberRole("admin", null, "member"), false);
});

test("member and missing actors cannot change roles", () => {
  assert.equal(canChangeMemberRole("member", "member", "admin"), false);
  assert.equal(canChangeMemberRole(null, "member", "admin"), false);
  assert.equal(canChangeMemberRole("owner", null, "admin"), false);
});

test("future Guest role transition resolver matches the target-aware closed matrix", () => {
  for (const nextRole of ["owner", "admin", "member", "guest"] satisfies ServerRole[]) {
    assert.equal(canTransitionServerRole({
      actorRole: "owner",
      targetRole: "member",
      nextRole,
      isSelf: false,
      ownerCount: 1,
    }), nextRole !== "member");
  }
  assert.equal(canTransitionServerRole({ actorRole: "owner", targetRole: "owner", nextRole: "guest", isSelf: true, ownerCount: 1 }), false);
  assert.equal(canTransitionServerRole({ actorRole: "owner", targetRole: "owner", nextRole: "guest", isSelf: true, ownerCount: 2 }), true);
  assert.equal(canTransitionServerRole({ actorRole: "admin", targetRole: "guest", nextRole: "member", isSelf: false, ownerCount: 1 }), true);
  assert.equal(canTransitionServerRole({ actorRole: "admin", targetRole: "member", nextRole: "guest", isSelf: false, ownerCount: 1 }), true);
  assert.equal(canTransitionServerRole({ actorRole: "admin", targetRole: "guest", nextRole: "owner", isSelf: false, ownerCount: 1 }), false);
  assert.equal(canTransitionServerRole({ actorRole: "admin", targetRole: "member", nextRole: "admin", isSelf: false, ownerCount: 1 }), true);
  assert.equal(canTransitionServerRole({ actorRole: "admin", targetRole: "admin", nextRole: "member", isSelf: false, ownerCount: 1 }), false);
  assert.equal(canTransitionServerRole({ actorRole: "admin", targetRole: "member", nextRole: "guest", isSelf: true, ownerCount: 1 }), false);
  assert.equal(canTransitionServerRole({ actorRole: "member", targetRole: "guest", nextRole: "member", isSelf: false, ownerCount: 1 }), false);
  assert.equal(canTransitionServerRole({ actorRole: "guest", targetRole: "guest", nextRole: "member", isSelf: true, ownerCount: 1 }), false);
});
