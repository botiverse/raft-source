import assert from "node:assert/strict";
import test from "node:test";
import {
  canRemoveAdminPrincipal,
  canRemoveAdminMember,
  getAdminCandidateMembers,
  getAdminCandidatePrincipals,
  getAdminMembers,
  getAdminPrincipalKey,
  getAdminPrincipalRoleOptions,
  getAdminPrincipals,
  getAdminRoleOptions,
} from "../src/utils/serverAdminSettings.js";
import type {
  ServerAdminSettingsAgent,
  ServerAdminSettingsMember,
} from "../src/utils/serverAdminSettings.js";

const members: ServerAdminSettingsMember[] = [
  { userId: "owner-1", name: "owner", displayName: "Owner", email: "owner@slock.ai", role: "owner" },
  { userId: "admin-2", name: "zoe", displayName: "Zoe", email: "zoe@slock.ai", role: "admin" },
  { userId: "admin-1", name: "ada", displayName: "Ada", email: "ada@slock.ai", role: "admin" },
  { userId: "member-1", name: "member", displayName: "Member", email: "member@slock.ai", role: "member" },
];

const agents: ServerAdminSettingsAgent[] = [
  { id: "agent-2", name: "deploy", displayName: "Deploy Bot", avatarUrl: "pixel:deploy", serverRole: "admin" },
  { id: "agent-1", name: "build", displayName: "Build Bot", avatarUrl: "pixel:build", serverRole: "member" },
  { id: "agent-hidden", name: "external", displayName: "External Bot", avatarUrl: null, serverRole: null },
];

test("admin settings list owners first then admins in stable label order", () => {
  assert.deepEqual(
    getAdminMembers(members).map((member) => member.userId),
    ["owner-1", "admin-1", "admin-2"]
  );
});

test("admin settings unified list includes admin agents without granting agent owners", () => {
  assert.deepEqual(
    getAdminPrincipals(members, agents).map((principal) => getAdminPrincipalKey(principal)),
    ["human:owner-1", "human:admin-1", "agent:agent-2", "human:admin-2"]
  );
});

test("admin settings add candidates are existing members that the actor can promote", () => {
  assert.deepEqual(
    getAdminCandidateMembers(members, "owner").map((member) => member.userId),
    ["admin-1", "member-1", "admin-2"]
  );
  assert.deepEqual(
    getAdminCandidateMembers(members, "admin").map((member) => member.userId),
    ["member-1"]
  );
  assert.deepEqual(
    getAdminCandidateMembers(members, "member").map((member) => member.userId),
    []
  );
});

test("admin settings unified candidates include searchable agent principals", () => {
  assert.deepEqual(
    getAdminCandidatePrincipals(members, agents, "owner").map((principal) => getAdminPrincipalKey(principal)),
    ["human:admin-1", "agent:agent-1", "human:member-1", "human:admin-2"]
  );
  assert.deepEqual(
    getAdminCandidatePrincipals(members, agents, "admin").map((principal) => getAdminPrincipalKey(principal)),
    ["agent:agent-1", "human:member-1"]
  );
  assert.deepEqual(
    getAdminCandidatePrincipals(members, agents, "member").map((principal) => getAdminPrincipalKey(principal)),
    []
  );
});

test("admin settings role options follow server role transition policy", () => {
  assert.deepEqual(getAdminRoleOptions("owner", { role: "member" }), ["owner", "admin"]);
  assert.deepEqual(getAdminRoleOptions("owner", { role: "admin" }), ["owner"]);
  assert.deepEqual(getAdminRoleOptions("admin", { role: "member" }), ["admin"]);
  assert.deepEqual(getAdminRoleOptions("admin", { role: "admin" }), []);
});

test("admin settings agent role options are admin-only", () => {
  const agentMember = getAdminCandidatePrincipals(members, agents, "owner").find((principal) => getAdminPrincipalKey(principal) === "agent:agent-1");
  assert.ok(agentMember);
  assert.deepEqual(getAdminPrincipalRoleOptions("owner", agentMember), ["admin"]);
  assert.deepEqual(getAdminPrincipalRoleOptions("admin", agentMember), ["admin"]);
  assert.deepEqual(getAdminPrincipalRoleOptions("owner", { kind: "agent", role: "admin" }), []);
});

test("admin settings remove action follows server role transition policy", () => {
  assert.equal(canRemoveAdminMember("owner", { role: "admin" }), true);
  assert.equal(canRemoveAdminMember("admin", { role: "admin" }), false);
  assert.equal(canRemoveAdminMember("owner", { role: "owner" }, 2), true);
  assert.equal(canRemoveAdminMember("owner", { role: "owner" }, 1), false);
  assert.equal(canRemoveAdminPrincipal("owner", { kind: "agent", role: "admin" }), true);
  assert.equal(canRemoveAdminPrincipal("admin", { kind: "agent", role: "admin" }), false);
});
