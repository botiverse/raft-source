import { expect, test } from "vitest";
import { getEditableHumanServerRoles } from "../src/components/member/humanRoleTransitions.js";

test("Guest role options fail closed with server_guest_v0 off", () => {
  expect(getEditableHumanServerRoles({
    actorRole: "owner",
    targetRole: "member",
    isSelf: false,
    ownerCount: 1,
    serverGuestEnabled: false,
  })).toEqual(["owner", "admin"]);
  expect(getEditableHumanServerRoles({
    actorRole: "owner",
    targetRole: "guest",
    isSelf: false,
    ownerCount: 1,
    serverGuestEnabled: false,
  })).toEqual([]);
});

test("Owner and Admin receive only contract-valid Guest transition options", () => {
  expect(getEditableHumanServerRoles({
    actorRole: "owner",
    targetRole: "member",
    isSelf: false,
    ownerCount: 1,
    serverGuestEnabled: true,
  })).toEqual(["owner", "admin", "guest"]);
  expect(getEditableHumanServerRoles({
    actorRole: "admin",
    targetRole: "guest",
    isSelf: false,
    ownerCount: 1,
    serverGuestEnabled: true,
  })).toEqual(["admin", "member"]);
  expect(getEditableHumanServerRoles({
    actorRole: "admin",
    targetRole: "admin",
    isSelf: false,
    ownerCount: 1,
    serverGuestEnabled: true,
  })).toEqual([]);
});

test("Owner self-demotion requires another owner while Admin self-change stays closed", () => {
  expect(getEditableHumanServerRoles({
    actorRole: "owner",
    targetRole: "owner",
    isSelf: true,
    ownerCount: 1,
    serverGuestEnabled: true,
  })).toEqual([]);
  expect(getEditableHumanServerRoles({
    actorRole: "owner",
    targetRole: "owner",
    isSelf: true,
    ownerCount: 2,
    serverGuestEnabled: true,
  })).toEqual(["admin", "member", "guest"]);
  expect(getEditableHumanServerRoles({
    actorRole: "admin",
    targetRole: "admin",
    isSelf: true,
    ownerCount: 2,
    serverGuestEnabled: true,
  })).toEqual([]);
});
