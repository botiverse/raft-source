import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_CAPABILITY_KEYS,
  canChangeMemberRole,
  canTransitionServerRole,
  canMutateBilling,
  canReadBillingSummary,
  getServerCapabilities,
  hasServerCapability,
  type ServerCapability,
  type ServerRole,
} from "./serverPermissions.js";

const MEMBER_CAPABILITIES = new Set<ServerCapability>([
  "viewChannel",
  "createChannels",
  "viewChannelMembers",
  "joinPublicChannels",
  "addChannelMembers",
  "viewMembers",
  "viewAgents",
  "controlAgentRuntime",
  "viewMachines",
  "assignTasks",
]);

test("server capability registry contains the complete 40-capability contract", () => {
  assert.equal(SERVER_CAPABILITY_KEYS.length, 40);
  assert.equal(new Set(SERVER_CAPABILITY_KEYS).size, 40);
});

test("role bundles match every role x capability cell", () => {
  for (const role of ["owner", "admin", "member", "guest"] satisfies ServerRole[]) {
    const capabilities = getServerCapabilities(role);
    assert.deepEqual(Object.keys(capabilities), [...SERVER_CAPABILITY_KEYS]);

    for (const capability of SERVER_CAPABILITY_KEYS) {
      const expected = role === "owner"
        || (role === "admin" && capability !== "manageBilling")
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

test("member has exactly the ten explicitly approved capabilities", () => {
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
