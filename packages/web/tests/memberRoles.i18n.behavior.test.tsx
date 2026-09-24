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

test("catalog pins agent-admin role help details MessageId", () => {
  assert.equal(
    en["member.roles.help.agentAdminDetails"],
    "Server profile. Channels and channel members. No agents, machines, invites, join links, or role promotion yet.",
  );
  assert.match(zh["member.roles.help.agentAdminDetails"], /\p{Script=Han}/u);
});

test("RolePermissionHelpDialog renders the zh-cn agent-admin details", () => {
  renderWithIntl(<RolePermissionHelpDialog subject="agent" onClose={() => {}} />, {
    locale: "zh-cn",
  });

  assert.ok(screen.getByRole("heading", { name: zh["member.roles.help.agentRoles"] }));
  assert.ok(screen.getByText(zh["member.roles.help.agentAdminDetails"]));
  assert.ok(screen.getByText(zh["member.roles.help.agentMemberDetails"]));
  assert.equal(
    screen.queryByText(en["member.roles.help.agentAdminDetails"]),
    null,
  );
});
