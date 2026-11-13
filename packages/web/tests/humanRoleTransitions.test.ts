import { getEditableHumanServerRoles } from "../src/components/member/humanRoleTransitions";

// #wg-rbac:#15 P1 c: Guest is never a target role (the server refuses a change
// to guest with 403); a Guest can still be promoted.

test("Guest is never offered as a target role", () => {
  expect(getEditableHumanServerRoles({
    actorRole: "owner",
    targetRole: "member",
    isSelf: false,
    ownerCount: 1,
  })).toEqual(["owner", "admin"]);
  expect(getEditableHumanServerRoles({
    actorRole: "admin",
    targetRole: "member",
    isSelf: false,
    ownerCount: 1,
  })).not.toContain("guest");
  expect(getEditableHumanServerRoles({
    actorRole: "owner",
    targetRole: "admin",
    isSelf: false,
    ownerCount: 1,
  })).not.toContain("guest");
});

test("an existing Guest can be promoted to member or admin", () => {
  expect(getEditableHumanServerRoles({
    actorRole: "admin",
    targetRole: "guest",
    isSelf: false,
    ownerCount: 1,
  })).toEqual(["admin", "member"]);
  expect(getEditableHumanServerRoles({
    actorRole: "owner",
    targetRole: "guest",
    isSelf: false,
    ownerCount: 1,
  })).toEqual(["owner", "admin", "member"]);
  expect(getEditableHumanServerRoles({
    actorRole: "admin",
    targetRole: "admin",
    isSelf: false,
    ownerCount: 1,
  })).toEqual([]);
});

test("Owner self-demotion requires another owner while Admin self-change stays closed", () => {
  expect(getEditableHumanServerRoles({
    actorRole: "owner",
    targetRole: "owner",
    isSelf: true,
    ownerCount: 1,
  })).toEqual([]);
  expect(getEditableHumanServerRoles({
    actorRole: "owner",
    targetRole: "owner",
    isSelf: true,
    ownerCount: 2,
  })).toEqual(["admin", "member"]);
  expect(getEditableHumanServerRoles({
    actorRole: "admin",
    targetRole: "admin",
    isSelf: true,
    ownerCount: 2,
  })).toEqual([]);
});
