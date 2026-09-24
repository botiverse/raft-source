import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import MessageInput, { clearDraftPendingFilesForTests } from "../src/components/message/MessageInput";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

const originalApiGet = api.get;
const originalApiPost = api.post;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function classList(element: Element): string[] {
  return element.getAttribute("class")?.split(/\s+/).filter(Boolean) ?? [];
}

function hasClasses(element: Element, classes: string[]) {
  const actual = new Set(classList(element));
  for (const className of classes) {
    assert.ok(actual.has(className), `expected ${element.textContent} to include ${className}; got ${[...actual].join(" ")}`);
  }
}

function setupComposer(
  sendMessage: ReturnType<typeof useMessageStore.getState>["sendMessage"] = async () => ({
    messageId: "message-1",
    pendingMentionActions: [],
    unresolvedMentionHandles: [],
  }),
  resourceReferencesEnabled = true,
  channelAgents: unknown[] = [],
) {
  api.get = (async (url: string) => {
    if (url === "/attachments/upload-capabilities") {
      return {
        data: {
          directUploadEnabled: false,
          directUploadThresholdBytes: null,
          maxBytes: 50 * 1024 * 1024,
          sessionExpiresInSeconds: null,
        },
      };
    }
    if (url === "/servers/server-1/apps") {
      return { data: { apps: [{ appId: "system.reminder", displayName: "Reminder" }] } };
    }
    if (url === "/channels/channel-general/members") {
      return { data: { agents: channelAgents, humans: [] } };
    }
    return { data: { agents: [], humans: [] } };
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      const keys = (body as { keys?: string[] } | undefined)?.keys ?? [];
      return {
        data: {
          evaluations: keys.map((key) => ({
            key,
            enabled: key === COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY && resourceReferencesEnabled,
          })),
        },
      };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "user-1@example.com",
      gravatarHash: "",
      name: "user-1",
      displayName: "User 1",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationMode: "manual",
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      slug: "server",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-08-06T00:00:00.000Z",
    },
    members: [],
  } as never);
  useChannelStore.setState({
    channels: [
      {
        id: "channel-general",
        serverId: "server-1",
        name: "general",
        type: "channel",
        description: null,
        createdAt: "2026-08-06T00:00:00.000Z",
      },
      {
        id: "channel-visual-aid",
        serverId: "server-1",
        name: "proj-visual-aid",
        type: "channel",
        description: "UI for content: PNG and motion support only, long description that must not compress the channel name first.",
        createdAt: "2026-08-06T00:00:00.000Z",
      },
    ],
    dmChannels: [],
  } as never);
  useMessageStore.setState({
    drafts: {},
    channelMessages: { "channel-general": [] },
    currentChannelId: "channel-general",
    messages: [],
    sendMessage,
  } as never);
  useMachineStore.setState({
    machines: [{
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Desk",
      description: "Office Mac",
      status: "online",
      statusVersion: 1,
      apiKeyPrefix: null,
      runtimes: [],
      hostname: null,
      os: null,
      daemonVersion: null,
      isComputer: true,
      lastHeartbeat: null,
      createdAt: "2026-08-06T00:00:00.000Z",
    }],
  } as never);

  return render(
    <MemoryRouter>
      <MessageInput
        channelId="channel-general"
        channelName="#general"
        variant="full"
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  clearDraftPendingFilesForTests();
  api.get = originalApiGet;
  api.post = originalApiPost;
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
});

test("@ autocomplete inserts inert typed Computer and App references", async () => {
  HTMLElement.prototype.scrollIntoView = () => undefined;
  const sends: Array<{ content: string; mentions: unknown }> = [];
  setupComposer(async (_channelId, content, _attachmentIds, _asTask, _optimisticId, _randomId, mentions) => {
    sends.push({ content, mentions });
    return { messageId: "message-1", pendingMentionActions: [], unresolvedMentionHandles: [] };
  });
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "@De", selectionStart: 3, selectionEnd: 3 } });
  });

  assert.ok(await waitFor(() => screen.getByText("Computers")));
  textarea.focus();
  const computerOption = screen.getByText("Desk").closest("button");
  assert.ok(computerOption);
  const optionMouseDown = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  computerOption.dispatchEvent(optionMouseDown);
  assert.equal(optionMouseDown.defaultPrevented, true, "autocomplete pointerdown keeps the textarea focused");
  assert.equal(document.activeElement, textarea);
  fireEvent.click(computerOption);
  assert.equal(
    textarea.value,
    "[@Desk](<computer:550e8400-e29b-41d4-a716-446655440000>) ",
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => assert.equal(sends.length, 1));
  assert.deepEqual(sends[0], {
    content: "[@Desk](<computer:550e8400-e29b-41d4-a716-446655440000>) ",
    mentions: [],
  });

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "@rem", selectionStart: 4, selectionEnd: 4 } });
  });

  assert.ok(await waitFor(() => screen.getByText("Apps")));
  fireEvent.click(screen.getByText("Reminder"));
  assert.equal(textarea.value, "[@Reminder](<app:system.reminder>) ");

  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => assert.equal(sends.length, 2));
  assert.deepEqual(sends[1], {
    content: "[@Reminder](<app:system.reminder>) ",
    mentions: [],
  }, "resource references must not enter the user/agent mention payload");
});

test("Computer and App rows use the same compact avatar footprint as people and show product names", async () => {
  HTMLElement.prototype.scrollIntoView = () => undefined;
  setupComposer();
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
  });

  const humanRow = (await waitFor(() => screen.getByText("User 1"))).closest("button");
  const computerRow = screen.getByText("Desk").closest("button");
  const appRow = screen.getByText("Reminder").closest("button");
  assert.ok(humanRow && computerRow && appRow);

  const humanAvatar = humanRow.querySelector('[class~="size-5"]');
  const computerAvatar = computerRow.querySelector('[data-mention-candidate-avatar="computer"]');
  const appAvatar = appRow.querySelector('[data-mention-candidate-avatar="app"]');
  assert.ok(humanAvatar && computerAvatar && appAvatar);

  for (const avatar of [humanAvatar, computerAvatar, appAvatar]) {
    hasClasses(avatar, ["size-5", "border"]);
    assert.equal(avatar.classList.contains("size-8"), false);
    assert.equal(avatar.classList.contains("border-2"), false);
  }
  for (const row of [humanRow, computerRow, appRow]) {
    hasClasses(row, ["items-center", "px-3", "py-2", "text-sm"]);
  }
  assert.ok(appRow.textContent?.includes("@system.reminder"), "the stable App id remains visible as the handle");
  assert.equal(screen.queryByText("system.canary"), null, "internal Apps are absent from the mounted picker");
});

test("human and agent mention rows render live avatar identity and scoped activity", async () => {
  HTMLElement.prototype.scrollIntoView = () => undefined;
  const agent = {
    id: "agent-1",
    serverId: "server-1",
    name: "helper",
    displayName: "Helper Agent",
    avatarUrl: null,
    description: null,
    status: "active",
    model: "opus",
    runtime: "claude",
    serverRole: "member",
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: "machine-1",
    creatorType: "user",
    creatorId: "user-1",
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-08-06T00:00:00.000Z",
    activity: "online",
  };
  setupComposer(undefined, true, [agent]);
  act(() => {
    useServerStore.setState({
      members: [{
        userId: "user-peer",
        serverId: "server-1",
        serverName: "Server",
        serverSlug: "server",
        email: "peer@example.com",
        gravatarHash: "member-gravatar-hash",
        name: "peer",
        displayName: "Peer Human",
        description: null,
        avatarUrl: null,
        role: "member",
        joinedAt: "2026-08-06T00:00:00.000Z",
      }],
    } as never);
    useAgentStore.setState({
      agents: [agent],
    } as never);
  });

  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
  });

  const peerRow = (await screen.findByText("Peer Human")).closest("button");
  const agentRow = (await screen.findByText("Helper Agent")).closest("button");
  assert.ok(peerRow && agentRow);
  const peerImage = peerRow.querySelector<HTMLImageElement>("img");
  assert.ok(peerImage?.src.includes("/avatar/member-gravatar-hash?"), "server-member Gravatar identity reaches AvatarSlot");
  const badgeShell = agentRow.querySelector<HTMLElement>('[data-mention-avatar-badge-shell="true"]');
  assert.ok(badgeShell, "in-channel agent rows mount the scoped activity badge");
  const activityDot = badgeShell.querySelector<HTMLElement>(".animate-pulse");
  assert.ok(activityDot, "the mounted agent activity dot pulses at compact-list size");
  assert.match(activityDot.className, /(^|\s)size-2(\s|$)/);
});

test("same-handle human and agent rows show explicit types and submit only the selected actor", async () => {
  HTMLElement.prototype.scrollIntoView = () => undefined;
  const sameHandleAgent = {
    id: "agent-same-handle",
    serverId: "server-1",
    name: "user-1",
    displayName: "Agent Twin",
    avatarUrl: null,
    description: null,
    status: "active",
    model: "opus",
    runtime: "claude",
    serverRole: "member",
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: "machine-1",
    creatorType: "user",
    creatorId: "user-1",
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-08-06T00:00:00.000Z",
    activity: "online",
  };
  const sends: Array<{ content: string; mentions: unknown }> = [];
  setupComposer(async (_channelId, content, _attachmentIds, _asTask, _optimisticId, _randomId, mentions) => {
    sends.push({ content, mentions });
    return { messageId: "message-same-handle", pendingMentionActions: [], unresolvedMentionHandles: [] };
  }, true, [sameHandleAgent]);
  act(() => {
    useAgentStore.setState({ agents: [sameHandleAgent] } as never);
  });

  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "@user", selectionStart: 5, selectionEnd: 5 } });
  });

  const humanType = await screen.findByTestId("mention-actor-type-user");
  const agentType = await screen.findByTestId("mention-actor-type-agent");
  assert.equal(humanType.textContent, "Human");
  assert.equal(agentType.textContent, "Agent");
  const agentRow = agentType.closest("button");
  assert.ok(agentRow);
  fireEvent.click(agentRow);
  assert.equal(textarea.value, "@user-1 ");
  await waitFor(() => assert.equal(screen.queryByTestId("mention-autocomplete-popover"), null));

  const secondDraft = `${textarea.value}and @user`;
  await act(async () => {
    fireEvent.change(textarea, {
      target: { value: secondDraft, selectionStart: secondDraft.length, selectionEnd: secondDraft.length },
    });
  });
  await waitFor(() => assert.ok(screen.getByTestId("mention-autocomplete-popover")));
  const replacementHumanType = await screen.findByTestId("mention-actor-type-user");
  const humanRow = replacementHumanType.closest("button");
  assert.ok(humanRow);
  fireEvent.click(humanRow);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => assert.equal(sends.length, 1));
  assert.deepEqual(sends[0], {
    content: "@user-1 and @user-1 ",
    mentions: [{ type: "user", id: "user-1", name: "user-1" }],
  });
});

test("message composer renders v2 unresolved-mention warnings only after the sender acknowledgement", async () => {
  HTMLElement.prototype.scrollIntoView = () => undefined;
  setupComposer(async () => ({
    messageId: "message-unresolved",
    pendingMentionActions: [],
    unresolvedMentionHandles: ["@same_handle"],
  }));
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "raw @same_handle" } });
  assert.equal(screen.queryByText(/Not notified:/u), null);

  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  assert.ok(await screen.findByText(
    "Not notified: @same_handle. Select a person or agent from the mention picker and try again if needed.",
  ));
});

test("Computer and App autocomplete stays hidden when the server gate is disabled", async () => {
  HTMLElement.prototype.scrollIntoView = () => undefined;
  setupComposer(undefined, false);
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "@De", selectionStart: 3, selectionEnd: 3 } });
  });

  await waitFor(() => assert.equal(screen.queryByText("Computers"), null));
  assert.equal(screen.queryByText("Desk"), null);
  assert.equal(screen.queryByText("Apps"), null);
});

test("channel autocomplete keeps descriptions tight and left-aligned after naturally sized channel names", async () => {
  HTMLElement.prototype.scrollIntoView = () => undefined;
  setupComposer();
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "#visual-a" } });
  });

  const name = await waitFor(() => screen.getByText("proj-visual-aid"));
  const description = screen.getByText(/UI for content: PNG and motion support only/u);
  const textGroup = name.parentElement;

  assert.ok(textGroup, "channel name and description must share a text group");
  hasClasses(textGroup, ["min-w-0", "flex-1", "items-baseline", "gap-2", "text-left"]);
  assert.equal(description.parentElement, textGroup, "description must baseline-align with its channel name");
  hasClasses(name, ["max-w-[50%]", "flex-none", "truncate"]);
  assert.equal(name.classList.contains("min-w-[9rem]"), false);
  hasClasses(description, ["min-w-0", "flex-1", "truncate"]);
});
