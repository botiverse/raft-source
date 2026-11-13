import assert from "node:assert/strict";
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
  assert.doesNotMatch(shell.className, /overflow-y-auto/, "the card is the frame, not the scroller");
  const area = shell.firstElementChild as HTMLElement;
  assert.ok(area.classList.contains("r-scroll-area"), "the rows scroll in a raft-ui ScrollArea that fills the card");
  assert.equal(area.tabIndex, -1, "each row is a control: the area is no tab stop");
  // DS inset list: raft-ui's Card, a card surface with a hairline edge, no shadow.
  assert.equal(shell.getAttribute("data-slot"), "card");
  assert.match(shell.className, /rounded-container/);
  assert.match(shell.className, /border-line-hairline/);
  assert.doesNotMatch(shell.className, /shadow-(?!none(?:\s|$))/);
  assert.equal(screen.getByText("Agents").tagName, "DIV");
  assert.equal(screen.getByText("Humans").tagName, "DIV");
  // DS section title: ink-3 text, no band behind it.
  assert.match(screen.getByText("Agents").className, /text-foreground-hint/);
  assert.doesNotMatch(screen.getByText("Agents").className, /(?:^|\s)bg-/);
  assert.equal(screen.getByText("Wug").textContent, "Wug");
  assert.equal(screen.getByText("Mei").textContent, "Mei");
  assert.ok(shell.querySelector('[data-channel-member-avatar-badge-shell="true"]'));
  // Raft DS Row hover: a member row hovers with the subtle tier (fill-subtle), not the medium tier.
  assert.match(screen.getByText("Wug").closest(".group")?.className ?? "", /hover:bg-fill-subtle/);
  assert.doesNotMatch(screen.getByText("Wug").closest(".group")?.className ?? "", /hover:bg-fill-medium/);

  const removeMei = screen.getByRole("button", { name: "Remove Mei from add list" });
  // Taking someone off the add list is reversible: a quiet icon button, not red.
  assert.match(removeMei.className, /hover:bg-fill-medium/);
  assert.doesNotMatch(removeMei.className, /danger/);
  // raft-ui ghost icon-md: a 32px box whose recipe sizes the glyph (18px).
  assert.match(removeMei.className, /(?:^|\s)size-8(?:\s|$)/);
  assert.ok(removeMei.querySelector("svg"), "remove control renders its glyph");
  fireEvent.click(removeMei);

  await waitFor(() => assert.ok(screen.queryByText("Mei") === null));
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

  assert.equal(screen.getByTestId("member-page-role-channel-admin").textContent, "Channel admin");
  const trailing = screen.getByTestId("member-page-trailing");
  assert.match(trailing.className, /self-center/);
  assert.match(trailing.className, /items-center/);
  assert.doesNotMatch(
    screen.getByTestId("member-page-role-channel-admin").className,
    /(?:^|\s)mt-1(?:\s|$)/,
  );
  assert.match((trailing.children[0] as HTMLElement).className, /group-hover:invisible/);
  assert.match((trailing.children[1] as HTMLElement).className, /group-hover:visible/);
  // Hover-reveal needs a mouse, not just a wide window: touch tablets
  // (>=768px, no hover) must still see the actions.
  for (const cell of [trailing, ...trailing.children] as HTMLElement[]) {
    assert.doesNotMatch(cell.className, /(?:^|\s)md:(?!pointer-fine:)/);
  }
  assert.match((trailing.children[1] as HTMLElement).className, /(?:^|\s)md:pointer-fine:invisible(?:\s|$)/);
  const hoverActions = screen.getByTestId("channel-member-hover-actions");
  assert.equal(hoverActions.textContent, "Demote");
  assert.match(hoverActions.className, /items-center/);
  const roleAction = screen.getByTestId("channel-member-role-action");
  const removeAction = screen.getByRole("button", { name: "Remove Mei" });
  // Icon-only now: the action carries no text, just its glyph and label.
  assert.equal(removeAction.textContent, "");
  assert.ok(removeAction.querySelector("svg"), "remove action renders its icon");
  // Both hover actions are the DS small control (32): the role action is
  // raft-ui's `size="md"` (h-8), the remove control is a hand-sized 32 square.
  assert.match(roleAction.className, /(^| )h-8( |$)/);
  assert.match(removeAction.className, /size-8|h-8/);
  assert.doesNotMatch(removeAction.className, /(?:^|\s)mt-1(?:\s|$)/);

  fireEvent.click(roleAction);
  fireEvent.click(removeAction);
  assert.equal(roleActions, 1);
  assert.equal(removeActions, 1);

  cleanup();
  renderIntl(createElement(MemberRoleTag, { role: "member" }));
  assert.ok(screen.queryByTestId("member-page-role-channel-admin") === null);
});
