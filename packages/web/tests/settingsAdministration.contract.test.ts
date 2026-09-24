import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import api from "../src/api/client";
import { ADMINISTRATION_VISUAL_SECTIONS } from "../src/components/settings/SettingsPanel";
import { useServerStore } from "../src/store/serverStore";
import {
  getAdminCandidatePrincipals,
  getAdminPrincipalKey,
  getAdminPrincipals,
} from "../src/utils/serverAdminSettings";
import { TestIntlProvider } from "./helpers/intl";

const originalGet = api.get;
const originalPut = api.put;
const PreJoinAgreementSection = ADMINISTRATION_VISUAL_SECTIONS["pre-join-agreement"];

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.put = originalPut;
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("mounted pre-join agreement uses the finalized Chinese Saved label after a valid dirty save", async () => {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Launch",
      slug: "launch",
      ownerId: "owner-1",
      role: "owner",
    },
  } as never);

  api.get = (async (url: string) => {
    assert.equal(url, "/servers/server-1/agreement");
    return { data: { enabled: false, agreement: null } };
  }) as typeof api.get;

  const writes: Array<{ url: string; body: unknown }> = [];
  api.put = (async (url: string, body: unknown) => {
    writes.push({ url, body });
    return { data: { enabled: true, agreement: body } };
  }) as typeof api.put;

  const view = render(createElement(
    TestIntlProvider,
    { locale: "zh-cn" },
    createElement(PreJoinAgreementSection),
  ));

  const checkbox = await screen.findByRole("checkbox");
  await waitFor(() => assert.equal(checkbox.hasAttribute("disabled"), false));
  const save = screen.getByRole("button", { name: "保存" });
  assert.equal(save.hasAttribute("disabled"), true);
  assert.equal(view.container.querySelector("textarea"), null);

  fireEvent.click(checkbox);
  await waitFor(() => assert.equal(screen.getAllByRole("textbox").length, 2));
  const [title, body] = screen.getAllByRole("textbox") as [HTMLInputElement, HTMLTextAreaElement];

  fireEvent.change(title, { target: { value: "Before you join" } });
  fireEvent.change(body, { target: { value: "x".repeat(5_000) } });
  assert.equal(save.hasAttribute("disabled"), false, "the documented maximum remains saveable");

  fireEvent.change(body, { target: { value: "x".repeat(5_001) } });
  assert.equal(save.hasAttribute("disabled"), true, "oversized agreement cannot be submitted");

  fireEvent.change(body, { target: { value: "Welcome to Launch" } });
  fireEvent.click(save);
  await waitFor(() => assert.deepEqual(writes, [{
    url: "/servers/server-1/agreement",
    body: {
      enabled: true,
      title: "Before you join",
      bodyMarkdown: "Welcome to Launch",
    },
  }]));
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "已保存" }).hasAttribute("disabled"), true));
  assert.equal(screen.queryByRole("button", { name: "已收藏" }), null);
});

test("admin promotion projects human and agent principals through the shared executable policy", () => {
  const members = [
    { id: "member-owner", userId: "owner-1", role: "owner", displayName: "Owner" },
    { id: "member-admin", userId: "admin-1", role: "admin", displayName: "Admin" },
    { id: "member-candidate", userId: "member-1", role: "member", displayName: "Member" },
  ] as never;
  const agents = [
    { id: "agent-admin", name: "admin-agent", serverRole: "admin", deletedAt: null },
    { id: "agent-candidate", name: "candidate-agent", serverRole: "member", deletedAt: null },
  ] as never;

  assert.deepEqual(
    new Set(getAdminPrincipals(members, agents).map(getAdminPrincipalKey)),
    new Set(["human:owner-1", "human:admin-1", "agent:agent-admin"]),
  );
  assert.deepEqual(
    new Set(getAdminCandidatePrincipals(members, agents, "owner").map(getAdminPrincipalKey)),
    new Set(["human:admin-1", "human:member-1", "agent:agent-candidate"]),
  );
});
