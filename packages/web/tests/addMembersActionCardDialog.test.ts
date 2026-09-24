import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { createElement } from "react";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import api from "../src/api/client";
import { TestIntlProvider } from "./helpers/intl";
import AddMembersDialog from "../src/components/channel/AddMembersDialog";
import {
  ChannelMemberHoverActions,
  ChannelMemberRemoveButton,
  ChannelMemberRoleAndActions,
  MemberRoleTag,
} from "../src/components/channel/ChannelMemberList";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";

const renderIntl = (element: ReactElement) =>
  render(createElement(TestIntlProvider, null, element));

const originalApiGet = api.get;
const originalApiPost = api.post;

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  api.post = originalApiPost;
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, channelLocalMembership: {} } as never);
  useServerStore.setState({ current: null, servers: [], members: [] } as never);
});

test("AddMembersDialog uses the member-list surface and submits only candidates kept selected", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  let closeCount = 0;
  let submitted: {
    channelId: string;
    channelName: string;
    addedHumanIds: string[];
    addedAgentIds: string[];
  } | null = null;

  api.get = (async () => ({ data: { agents: [], humans: [] } })) as typeof api.get;
  api.post = (async (url: string, body: unknown) => {
    posts.push({ url, body });
    return {
      data: {
        ok: true,
        added: { userIds: [], agentIds: ["agent-wug"] },
        alreadyMembers: { userIds: [], agentIds: [] },
      },
    };
  }) as typeof api.post;

  useChannelStore.setState({
    channels: [{
      id: "channel-general",
      serverId: "server-alpha",
      name: "general",
      description: null,
      type: "channel",
      createdAt: "2026-08-21T00:00:00.000Z",
      joined: true,
    }],
  } as never);
  useServerStore.setState({
    members: [{
      userId: "user-mei",
      email: "mei@example.test",
      gravatarHash: "hash-mei",
      name: "mei",
      displayName: "Mei",
      description: "Design",
      avatarUrl: null,
      role: "member",
      joinedAt: "2026-08-21T00:00:00.000Z",
    }],
  } as never);
  useAgentStore.setState({
    agents: [{
      id: "agent-wug",
      name: "wug",
      displayName: "Wug",
      avatarUrl: null,
      description: "A wug for work",
      status: "active",
      model: "gpt-5",
      runtime: "codex",
      serverRole: "member",
      reasoningEffort: null,
      executionMode: "cloud",
      envVars: null,
      machineId: null,
      creatorType: "user",
      creatorId: "user-owner",
      creator: null,
      createdAgents: [],
      deletedAt: null,
      createdAt: "2026-08-21T00:00:00.000Z",
    }],
    agentActivities: {},
  } as never);

  renderIntl(createElement(AddMembersDialog, {
    channelId: "channel-general",
    prefilledHumanIds: ["user-mei"],
    prefilledAgentIds: ["agent-wug"],
    draftHint: "Bring the builders into #general.",
    onClose: () => { closeCount += 1; },
    onSubmitted: (result) => { submitted = result; },
  }));

  const shell = await screen.findByTestId("add-members-action-list");
  assert.match(shell.className, /max-h-72/);
  assert.match(shell.className, /overflow-y-auto/);
  assert.match(shell.className, /border-2/);
  assert.match(shell.className, /shadow-brutal-sm/);
  assert.equal(screen.getByText("Agents").tagName, "DIV");
  assert.equal(screen.getByText("Humans").tagName, "DIV");
  assert.match(screen.getByText("Agents").className, /bg-white\/50/);
  assert.equal(screen.getByText("Wug").textContent, "Wug");
  assert.equal(screen.getByText("Mei").textContent, "Mei");
  assert.ok(shell.querySelector('[data-channel-member-avatar-badge-shell="true"]'));
  assert.match(screen.getByText("Wug").closest(".group")?.className ?? "", /hover:bg-soft-signal\/30/);

  const removeMei = screen.getByRole("button", { name: "Remove Mei from add list" });
  assert.match(removeMei.className, /bg-brutal-red\/20/);
  assert.equal(removeMei.querySelector("svg")?.getAttribute("width"), "12");
  fireEvent.click(removeMei);

  await waitFor(() => assert.equal(screen.queryByText("Mei"), null));
  fireEvent.click(screen.getByRole("button", { name: "Add 1 member" }));

  await waitFor(() => assert.ok(submitted));
  assert.deepEqual(posts, [{
    url: "/channels/channel-general/members/batch",
    body: { userIds: [], agentIds: ["agent-wug"] },
  }]);
  assert.deepEqual(submitted, {
    channelId: "channel-general",
    channelName: "general",
    addedHumanIds: [],
    addedAgentIds: ["agent-wug"],
  });
  assert.equal(closeCount, 1);
});

test("channel member remove affordance is not hover-gated on mobile", () => {
  renderIntl(createElement(ChannelMemberRemoveButton, {
    label: "Remove Wug",
    onClick: () => {},
  }));

  const remove = screen.getByRole("button", { name: "Remove Wug" });
  assert.match(
    remove.className,
    /(?:^|\s)flex(?:\s|$)/,
    "touch users cannot hover member rows; default remove buttons must be visible below md",
  );
  assert.doesNotMatch(remove.className, /hidden/);
  assert.doesNotMatch(remove.className, /md:hidden/);
  assert.doesNotMatch(remove.className, /group-hover:flex/);
});

test("channel member role UI hides Member and swaps Channel Admin for hover actions", () => {
  let roleActions = 0;
  let removeActions = 0;
  const actions = createElement(ChannelMemberHoverActions, {
    roleAction: { label: "Demote", onClick: () => { roleActions += 1; } },
    removeAction: { label: "Remove Mei", onClick: () => { removeActions += 1; } },
  });
  renderIntl(createElement(ChannelMemberRoleAndActions, { role: "admin", actions }));

  assert.equal(screen.getByTestId("member-page-role-channel-admin").textContent, "Channel Admin");
  const trailing = screen.getByTestId("member-page-trailing");
  assert.match(trailing.className, /self-center/);
  assert.match(trailing.className, /items-center/);
  assert.doesNotMatch(
    screen.getByTestId("member-page-role-channel-admin").className,
    /(?:^|\s)mt-1(?:\s|$)/,
  );
  assert.match((trailing.children[0] as HTMLElement).className, /group-hover:invisible/);
  assert.match((trailing.children[1] as HTMLElement).className, /group-hover:visible/);
  const hoverActions = screen.getByTestId("channel-member-hover-actions");
  assert.equal(hoverActions.textContent, "DemoteRemove");
  assert.match(hoverActions.className, /items-center/);
  const roleAction = screen.getByTestId("channel-member-role-action");
  const removeAction = screen.getByRole("button", { name: "Remove Mei" });
  assert.equal(removeAction.textContent, "Remove");
  assert.match(roleAction.className, /h-7/);
  assert.match(removeAction.className, /h-7/);
  assert.doesNotMatch(removeAction.className, /(?:^|\s)mt-1(?:\s|$)/);

  fireEvent.click(roleAction);
  fireEvent.click(removeAction);
  assert.equal(roleActions, 1);
  assert.equal(removeActions, 1);

  cleanup();
  renderIntl(createElement(MemberRoleTag, { role: "member" }));
  assert.equal(screen.queryByTestId("member-page-role-channel-admin"), null);
});
