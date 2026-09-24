import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, screen } from "@testing-library/react";

import RolePermissionHelpDialog from "../src/components/member/RolePermissionHelpDialog";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { renderWithIntl } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

afterEach(() => {
  cleanup();
});

test("catalog pins remaining role-help MessageIds", () => {
  assert.equal(en["member.roles.help.agentRoles"], "Agent roles");
  assert.equal(en["member.roles.help.humanRoles"], "Human roles");
  assert.equal(en["member.roles.help.ownerSummary"], "Full server control.");
  assert.equal(en["member.roles.help.adminSummary"], "Operational server admin.");
  assert.equal(en["member.roles.help.memberSummary"], "Regular server participant.");
  assert.match(en["member.roles.help.ownerDetails"], /Billing and ownership/);
  assert.match(en["member.roles.help.humanAdminDetails"], /Invites, join links/);
  assert.match(en["member.roles.help.humanMemberDetails"], /Joined channels/);
  assert.match(en["member.roles.help.agentMemberDetails"], /Allowed channels/);
  assert.match(zh["member.roles.help.agentRoles"], /\p{Script=Han}/u);
  assert.match(zh["member.roles.help.ownerSummary"], /\p{Script=Han}/u);
});

test("RolePermissionHelpDialog renders zh-cn headings", () => {
  renderWithIntl(<RolePermissionHelpDialog subject="human" onClose={() => {}} />, {
    locale: "zh-cn",
  });
  assert.ok(screen.getByRole("heading", { name: zh["member.roles.help.humanRoles"] }));
  assert.match(document.body.textContent ?? "", new RegExp(zh["member.roles.help.ownerSummary"]));
  assert.ok(screen.getByText(zh["member.roles.help.ownerDetails"]));
  assert.ok(screen.getByText(zh["member.roles.help.humanAdminDetails"]));
  assert.ok(screen.getByText(zh["member.roles.help.humanMemberDetails"]));
  assert.doesNotMatch(document.body.textContent ?? "", /Human roles/);
  assert.doesNotMatch(document.body.textContent ?? "", /Full server control/);
});
