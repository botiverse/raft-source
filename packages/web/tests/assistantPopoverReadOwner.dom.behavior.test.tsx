import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, StrictMode } from "react";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import { ChatPanel } from "../src/features/channel/ChatPanel";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Channel } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";

// #triage:#483: the assistant popover's chat took the current channel (and
// with it live auto-read) over from #general and never gave it back.

const SERIAL = {};
const GENERAL = "read-owner-general";
const DM = "read-owner-assistant-dm";
const originalHasFocus = document.hasFocus.bind(document);
const originalGet = api.get.bind(api);

window.matchMedia = window.matchMedia ?? (() => ({
  matches: false,
  media: "",
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}));

globalThis.IntersectionObserver = globalThis.IntersectionObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
} as typeof IntersectionObserver;

globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

HTMLElement.prototype.scrollIntoView = HTMLElement.prototype.scrollIntoView ?? function scrollIntoView() {};
HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo ?? function scrollTo() {};

afterEach(() => {
  cleanup();
  document.hasFocus = originalHasFocus;
  api.get = originalGet as typeof api.get;
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, initialized: false, loading: false });
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} });
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useServerStore.setState({ current: null, members: [] });
  useTaskStore.setState({ tasks: [], currentChannelId: null });
  useThreadStore.setState(useThreadStore.getInitialState(), true);
});

function makeUser(): User {
  return {
    id: "user-1",
    email: "owner@example.com",
    name: "owner",
    displayName: "Owner",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: "UTC",
    autoTranslationEnabled: false,
    preferredTranslationDisplay: "original",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
}

function makeChannel(id: string, name: string, type: Channel["type"]): Channel {
  return {
    id,
    serverId: "server-1",
    name,
    description: null,
    type,
    joined: true,
    activityMuteSupported: false,
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

function row(channelId: string, seq: number): Message {
  return {
    id: `${channelId}-${seq}`,
    seq,
    channelId,
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Assistant",
    messageType: "chat",
    content: `message ${seq}`,
    createdAt: new Date(Date.UTC(2026, 6, 10, 6, 0, seq)).toISOString(),
  };
}

let loads: string[] = [];
let cutOffNextGeneralLoad = false;

function setChatState(general: Channel, dm: Channel) {
  loads = [];
  cutOffNextGeneralLoad = false;
  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url.endsWith("/members")) return { data: { humans: [], agents: [] } };
    if (url.endsWith("/notification-settings")) return { data: { activityMuted: false } };
    return { data: {} };
  }) as typeof api.get;

  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    initialized: true,
    loading: false,
  });
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
      role: "member",
      createdAt: "2026-07-10T00:00:00.000Z",
    },
    members: [],
    billing: null,
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
    },
    loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels: [general],
    dmChannels: [dm],
    channelActivity: { [GENERAL]: null, [DM]: null },
  });
  useTaskStore.setState({
    tasks: [],
    currentChannelId: GENERAL,
    loadTasks: async () => {},
  });
  const meta = {
    loading: false, loadingOlder: false, loadingNewer: false, loadingGap: false,
    hasMore: false, hasNewer: false, hasGap: false, historyLimited: false, contextLoadError: null,
  };
  // A chat that loads takes the current channel over, as the store loaders
  // do. `cutOffNextGeneralLoad`: #general's next load never settles (the
  // popover's load supersedes it), so its window meta stays loading.
  const loader = (kind: string) => (channelId: string, messageId?: unknown) => {
    loads.push(typeof messageId === "string" ? `${kind}:${channelId}:${messageId}` : `${kind}:${channelId}`);
    const cutOff = channelId === GENERAL && cutOffNextGeneralLoad;
    if (channelId === GENERAL) cutOffNextGeneralLoad = false;
    useMessageStore.setState((state) => ({
      currentChannelId: channelId,
      messages: state.channelMessages[channelId] ?? [],
      channelWindowMeta: { ...state.channelWindowMeta, [channelId]: { ...meta, loading: cutOff } },
      historyFetchedChannels: { ...state.historyFetchedChannels, [channelId]: !cutOff },
    }));
    return cutOff ? new Promise<void>(() => {}) : Promise.resolve();
  };
  useMessageStore.setState({
    currentUserId: "user-1",
    channelMessages: { [GENERAL]: [row(GENERAL, 1)], [DM]: [row(DM, 1)] },
    channelWindowMeta: { [GENERAL]: meta, [DM]: meta },
    historyFetchedChannels: { [GENERAL]: true, [DM]: true },
    lastSeq: 1,
    isNearBottom: true,
    unreadCounts: {},
    drafts: {},
    loadMessages: loader("latest"),
    loadMessageContext: loader("context"),
    loadMessageWindowSilent: loader("remembered"),
    loadOlderMessages: async () => {},
    loadNewerMessages: async () => {},
  });
}

function Screen({ general, dm, popoverOpen, path = "/" }: { general: Channel; dm: Channel; popoverOpen: boolean; path?: string }) {
  const screen = (
    <MemoryRouter initialEntries={[path]}>
      <ChatPanel channel={general} />
      {popoverOpen ? <ChatPanel channel={dm} hideHeader allowTasks={false} ownsUrl={false} /> : null}
    </MemoryRouter>
  );
  return strictMode ? <StrictMode>{screen}</StrictMode> : screen;
}

let strictMode = false;

for (const strict of [false, true]) {
  test(`closing the assistant popover gives read ownership back to the channel under it${strict ? " (StrictMode)" : ""}`, SERIAL, async () => {
    strictMode = strict;
    const general = makeChannel(GENERAL, "general", "channel");
    const dm = makeChannel(DM, "assistant", "dm");
    setChatState(general, dm);
    document.hasFocus = () => true;

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<Screen general={general} dm={dm} popoverOpen={false} />, { wrapper: TestIntlProvider });
    });
    assert.equal(useMessageStore.getState().currentChannelId, GENERAL);

    await act(async () => {
      view.rerender(<Screen general={general} dm={dm} popoverOpen />);
    });
    assert.equal(useMessageStore.getState().currentChannelId, DM, "the popover's chat owns the window while open");

    await act(async () => {
      view.rerender(<Screen general={general} dm={dm} popoverOpen={false} />);
    });
    assert.equal(useMessageStore.getState().currentChannelId, GENERAL, "closing the popover hands the window back");

    // The person is using the window, at the bottom of #general.
    document.dispatchEvent(new window.Event("pointerdown"));
    await act(async () => {
      useMessageStore.getState().addMessage(row(GENERAL, 2));
      useMessageStore.getState().addMessage(row(DM, 2));
    });
    assert.equal(useMessageStore.getState().unreadCounts[GENERAL] ?? 0, 0, "a new #general message in view is read");
    assert.equal(useMessageStore.getState().unreadCounts[DM], 1, "a new message in the closed assistant DM stays unread");
  });
}

async function openAndClosePopover(general: Channel, dm: Channel, path?: string, whileOpen?: () => void) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Screen general={general} dm={dm} popoverOpen={false} path={path} />, { wrapper: TestIntlProvider });
  });
  await act(async () => {
    view.rerender(<Screen general={general} dm={dm} popoverOpen path={path} />);
  });
  assert.equal(useMessageStore.getState().currentChannelId, DM);
  whileOpen?.();
  await act(async () => {
    view.rerender(<Screen general={general} dm={dm} popoverOpen={false} path={path} />);
  });
}

test("a #general ?msg= load the popover cut off is reopened on its linked message on close", SERIAL, async () => {
  strictMode = false;
  const general = makeChannel(GENERAL, "general", "channel");
  const dm = makeChannel(DM, "assistant", "dm");
  setChatState(general, dm);
  cutOffNextGeneralLoad = true;
  document.hasFocus = () => true;
  const focus = `${GENERAL}-1`;

  await openAndClosePopover(general, dm, `/?msg=${focus}`);

  assert.equal(loads[0], `context:${GENERAL}:${focus}`);
  assert.equal(loads.at(-1), `context:${GENERAL}:${focus}`, "reopened on the linked message, not the latest page");
  assert.equal(loads.filter((load) => load.startsWith("latest:" + GENERAL)).length, 0);
  const state = useMessageStore.getState();
  assert.equal(state.currentChannelId, GENERAL);
  assert.equal(state.channelWindowMeta[GENERAL]?.loading, false);

  document.dispatchEvent(new window.Event("pointerdown"));
  await act(async () => {
    useMessageStore.getState().addMessage(row(GENERAL, 2));
  });
  assert.equal(useMessageStore.getState().unreadCounts[GENERAL] ?? 0, 0, "a new #general message in view is read");
});

test("a ?msg= window on #general survives the close when live rows left a hole in its list", SERIAL, async () => {
  strictMode = false;
  const general = makeChannel(GENERAL, "general", "channel");
  const dm = makeChannel(DM, "assistant", "dm");
  setChatState(general, dm);
  const focus = `${GENERAL}-1`;

  await openAndClosePopover(general, dm, `/?msg=${focus}`, () => {
    // Live rows landed past a hole in the context window: its list is no longer fetched history.
    useMessageStore.setState((state) => ({ historyFetchedChannels: { ...state.historyFetchedChannels, [GENERAL]: false } }));
  });

  assert.equal(loads[0], `context:${GENERAL}:${focus}`);
  assert.equal(loads.at(-1), `context:${GENERAL}:${focus}`, "reopened on the linked message, not the latest page");
  assert.equal(loads.filter((load) => load.startsWith("latest:" + GENERAL)).length, 0);
  assert.equal(useMessageStore.getState().currentChannelId, GENERAL);
});
