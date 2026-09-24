import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createIntl } from "react-intl";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import api from "../src/api/client";
import InviteHumanDialog from "../src/components/member/InviteHumanDialog";
import { useServerStore } from "../src/store/serverStore";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const originalGet = api.get;
const originalPost = api.post;
const originalServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useServerStore.setState(originalServerState, true);
});

function seedInviteServer() {
  useServerStore.setState({
    current: { id: "server-1", slug: "server-1", name: "Server 1", role: "owner" },
    billing: null,
    loadBilling: async () => {},
  } as never);
}

function renderInviteDialog() {
  return render(
    <MemoryRouter>
      <TestIntlProvider locale="zh-cn">
        <InviteHumanDialog onClose={() => {}} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("catalog pins invites MessageIds", () => {
  assert.equal(en["member.invite.title"], "Invite Human");
  assert.equal(en["member.invite.sendInvites"], "Send invites");
  assert.equal(en["member.invite.viewBilling"], "View Billing");
  assert.equal(en["member.invite.failedPrepareLink"], "Failed to prepare join link");
  assert.equal(en["member.invite.enterEmailOrCopyLink"], "Enter at least one email, or copy the invite link above.");
  assert.match(zh["member.invite.title"], /\p{Script=Han}/u);
  assert.match(zh["member.invite.seatLimitHint"], /\p{Script=Han}/u);
});

test("invites ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.doesNotMatch(zhIntl.formatMessage({ id: "member.invite.title" }), /Invite Human/);
  assert.equal(
    zhIntl.formatMessage({ id: "member.invite.sendInvites" }),
    zh["member.invite.sendInvites"],
  );
});

test("mounted InviteHumanDialog renders Chinese chrome and empty-submit recovery", async () => {
  seedInviteServer();
  api.get = (async () => ({
    data: [{ id: "link-1", token: "join-token" }],
  })) as typeof api.get;

  renderInviteDialog();

  assert.ok(await screen.findByText(zh["member.invite.title"]));
  assert.ok(screen.getByRole("button", { name: zh["member.invite.sendInvites"] }));
  assert.ok(screen.getByRole("button", { name: zh["common.confirm.cancel"] }));
  fireEvent.click(screen.getByRole("button", { name: zh["member.invite.sendInvites"] }));
  assert.ok(await screen.findByText(zh["member.invite.enterEmailOrCopyLink"]));
});

test("mounted InviteHumanDialog localizes join-link preparation failure", async () => {
  seedInviteServer();
  api.get = (async () => {
    throw new Error("offline");
  }) as typeof api.get;

  renderInviteDialog();

  assert.ok(await screen.findByText(zh["member.invite.failedPrepareLink"]));
});
