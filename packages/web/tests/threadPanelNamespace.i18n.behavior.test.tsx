import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import ThreadPanel from "../src/components/message/ThreadPanel";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Channel } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";

// Behavior gate for the message.threadPanel.* migration (ThreadPanel, B2b).
// Rendered under zh-cn, the panel chrome + empty state must reach the DOM with no
// pre-migration English leak. Real-DOM teeth on purpose: reverting a wiring back
// to an English literal turns these RED (a catalog-only assertion would be a
// false green, @铁根). zh values are @AngLee-final (msg 449e7ed1).

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

window.matchMedia = window.matchMedia ?? (() => ({
  matches: false, media: "", onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
}));
globalThis.IntersectionObserver = globalThis.IntersectionObserver ?? class {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
} as typeof IntersectionObserver;
globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {} unobserve() {} disconnect() {}
} as typeof ResizeObserver;
globalThis.CSS = globalThis.CSS ?? ({ escape: (value: string) => value } as typeof CSS);
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo ?? function scrollTo(options?: ScrollToOptions | number) {
  this.scrollTop = typeof options === "number" ? options : options?.top ?? 0;
};

const renderZh: typeof rtlRender = (ui, options) =>
  rtlRender(ui, { wrapper: (props) => <TestIntlProvider locale="zh-cn" {...props} />, ...options });
const renderEn: typeof rtlRender = (ui, options) =>
  rtlRender(ui, { wrapper: TestIntlProvider, ...options });

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useThreadStore.setState(useThreadStore.getInitialState(), true);
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  window.history.pushState({}, "", "/");
});

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1", email: "ada@example.com", gravatarHash: "", name: "ada", displayName: "Ada",
    description: null, avatarUrl: null, emailVerified: true, preferredLanguage: null,
    preferredTimezone: "UTC", autoTranslationEnabled: false, preferredTranslationDisplay: "original",
    preferredTimeFormat: null, preferredMessageBodyFontSize: null, referralSource: null,
    referralSourceOther: null, referralSourceSkippedAt: null, ...overrides,
  };
}
function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "parent-channel", serverId: "server-tp-i18n", name: "parent", description: null,
    type: "channel", createdAt: "2026-07-03T00:00:00.000Z", joined: true, activityMuteSupported: false,
    ...overrides,
  };
}
function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "parent-message", channelId: "parent-channel", senderType: "user", senderId: "user-1",
    senderName: "Ada", messageType: "chat", content: "parent context", createdAt: "2026-07-03T00:00:00.000Z",
    seq: 1, ...overrides,
  };
}

function seedThreadPanel(hasReplies: boolean) {
  const parentChannel = makeChannel();
  const threadChannel = makeChannel({ id: "thread-channel", type: "thread", name: "thread" });
  const parent = makeMessage({ threadId: threadChannel.id } as Partial<Message>);
  const reply = makeMessage({ id: "reply-1", channelId: threadChannel.id, content: "a reply", seq: 2 });
  const replies = hasReplies ? [reply] : [];

  useAuthStore.setState({ user: makeUser(), initialized: true });
  useServerStore.setState({
    current: {
      id: "server-tp-i18n", name: "TP", avatarUrl: null, slug: "tp-i18n", ownerId: "user-owner",
      onboardingAgentId: null, hideHumansFromMembers: false, plan: "free", planDowngradedAt: null,
      role: "member", createdAt: "2026-07-03T00:00:00.000Z",
    },
    billing: null, members: [], sidebarOrder: null, loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels: [parentChannel, threadChannel],
    dmChannels: [],
    channelActivity: { [parentChannel.id]: null, [threadChannel.id]: null },
  });
  useMessageStore.setState({
    messages: [], channelMessages: { [parentChannel.id]: [parent], [threadChannel.id]: replies },
    loading: false, loadingOlder: false, loadingNewer: false, hasMore: false, hasNewer: false,
    historyLimited: false, highlightedMessageId: null, contextLoadError: null, transientFocusRequest: null,
    unreadCounts: {}, drafts: {},
    loadMessages: async () => {}, loadMessageContext: async () => {}, loadMessageWindowSilent: async () => {},
    loadOlderMessages: async () => {}, loadNewerMessages: async () => {},
  });
  useThreadStore.setState({
    openParentMessageId: parent.id, openParentChannelId: parentChannel.id,
    openThreadChannelId: threadChannel.id, openThreadError: null, openThreadLoading: false,
    focusedMessageId: null,
    summaries: { [parent.id]: {
      threadChannelId: threadChannel.id, replyCount: replies.length, lastReplyAt: reply.createdAt,
      participantIds: [], unreadCount: 0, firstUnreadMessageId: null,
    } },
    followedThreads: [], taskUpdatesByMessageId: {},
  });
  useTaskStore.setState({
    tasks: [], serverTasks: [], currentChannelId: threadChannel.id, tasksByChannelId: {},
    taskMetadataByMessageId: {}, taskMessageIdByTaskId: {}, loadTasks: async () => {},
  });
  api.get = (async () => ({ data: {} })) as typeof api.get;
}

test("empty ThreadPanel renders the zh-cn no-replies state + no English leak", async () => {
  seedThreadPanel(false);
  await act(async () => {
    renderZh(<MemoryRouter><ThreadPanel /></MemoryRouter>);
    await new Promise((r) => setTimeout(r, 0));
  });

  // Once the thread context load settles to an empty reply window, the EmptyState
  // renders its zh title.
  await waitFor(() => assert.ok(screen.getByText("暂无回复"), "empty state renders zh noReplies"));
  assert.doesNotMatch(document.body.textContent ?? "", /No replies yet/, "no English empty-state leak");
});

test("ThreadPanel header chrome renders zh-cn titles", () => {
  seedThreadPanel(true);
  renderZh(<MemoryRouter><ThreadPanel /></MemoryRouter>);

  // Search-in-thread opener + close-thread control resolve zh via the catalog.
  assert.ok(screen.getByTitle("在消息列中搜索"), "search-in-thread title renders zh");
  assert.ok(screen.getAllByTitle("关闭消息列").length >= 1, "close-thread title renders zh");
  assert.equal(screen.queryByTitle("Search in thread"), null, "no English search title");
  assert.equal(screen.queryByTitle("Close thread"), null, "no English close title");

  // The open-parent control is icon-only. Its accessible name and Tooltip
  // content resolve zh; native title is intentionally absent so there is one
  // tooltip system. onOpenParentChannel is undefined here → "在频道中查看".
  const openParent = screen.getByRole("button", { name: "在频道中查看" });
  assert.equal(openParent.getAttribute("title"), null);
  assert.match(openParent.querySelector("svg")?.getAttribute("class") ?? "", /lucide-map-pin/);
  assert.doesNotMatch(document.body.textContent ?? "", /View in channel|Open Channel/, "no English channel label leak");
});

test("ThreadPanel keeps chrome above its mobile scrolling history", () => {
  seedThreadPanel(true);
  const { container } = renderEn(<MemoryRouter><ThreadPanel /></MemoryRouter>);

  const closeButton = screen.getByTestId("thread-close");
  const panel = closeButton.closest(".isolate");
  assert.ok(panel, "the real panel root owns an isolated stacking context");
  assert.match(panel.className, /\bflex-col\b/);

  const chrome = closeButton.closest(".relative.z-20");
  assert.ok(chrome, "thread header is mounted in the high chrome layer");
  assert.match(chrome.className, /\bshrink-0\b/);

  const timeline = screen.getByTestId("thread-message-scroller");
  const contentLayer = timeline.closest(".relative.z-0");
  assert.ok(contentLayer, "the real message history is mounted in the low content layer");
  assert.match(contentLayer.className, /\boverflow-hidden\b/);
  assert.match(timeline.className, /\boverflow-y-auto\b/);
  assert.equal(timeline.style.overscrollBehavior, "contain");
  assert.ok(
    (panel.compareDocumentPosition(contentLayer) & Node.DOCUMENT_POSITION_CONTAINED_BY) !== 0,
    "content layer remains inside the isolated panel",
  );
  assert.ok(container.contains(panel));
});

test("ThreadPanel reply rows use the current auth avatar when the member cache is stale", async () => {
  seedThreadPanel(true);
  useAuthStore.setState({
    // Uploaded-avatar URLs intentionally require a hex basename; social or
    // malformed profile URLs must not preempt Gravatar in the real renderer.
    user: makeUser({ avatarUrl: "/api/avatars/users/5e1f.webp" }),
    initialized: true,
  });
  useServerStore.setState({
    members: [{
      userId: "user-1",
      email: "ada@example.com",
      gravatarHash: "",
      name: "ada",
      displayName: "Ada",
      description: null,
      avatarUrl: null,
      role: "member",
      joinedAt: "2026-07-03T00:00:00.000Z",
    }],
  });

  let mounted: ReturnType<typeof renderEn> | undefined;
  await act(async () => {
    mounted = renderEn(<MemoryRouter><ThreadPanel /></MemoryRouter>);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const replyRow = await waitFor(() => {
    const row = document.getElementById("message-reply-1");
    assert.ok(row, "the real thread reply row mounted");
    return row;
  });
  const avatar = replyRow.querySelector('[data-avatar-kind="human"]');
  assert.ok(avatar, "the reply renders its human avatar control");
  assert.equal(avatar.getAttribute("data-avatar-source"), "uploaded");
  assert.match(avatar.querySelector("img")?.getAttribute("src") ?? "", /\/api\/avatars\/users\/5e1f\.webp$/);
  await act(async () => {
    mounted?.unmount();
    await Promise.resolve();
  });
});

test("ThreadPanel Escape closes from a non-editable focus inside the panel", async () => {
  seedThreadPanel(true);
  renderZh(<MemoryRouter><ThreadPanel composerAutoFocus={false} /></MemoryRouter>);

  const closeButton = await screen.findByTestId("thread-close");
  await act(async () => {
    closeButton.focus();
    fireEvent.keyDown(closeButton, { key: "Escape" });
    await Promise.resolve();
  });
  assert.equal(
    useThreadStore.getState().openParentMessageId,
    null,
    "Escape on a non-editable control inside the panel closes the thread",
  );
});

test("ThreadPanel Escape delegates to a host close handler", async () => {
  seedThreadPanel(true);
  let hostCloseCalls = 0;
  renderZh(
    <MemoryRouter>
      <ThreadPanel
        presentation="modal"
        onClose={() => { hostCloseCalls += 1; }}
        composerAutoFocus={false}
      />
    </MemoryRouter>,
  );

  const closeButton = await screen.findByTestId("thread-close");
  await act(async () => {
    closeButton.focus();
    fireEvent.keyDown(closeButton, { key: "Escape" });
    await Promise.resolve();
  });

  assert.equal(hostCloseCalls, 1, "Escape must use the modal host close contract");
  assert.equal(
    useThreadStore.getState().openParentMessageId,
    "parent-message",
    "the host owns teardown; Escape must not silently clear thread state first",
  );
});

test("ThreadPanel Escape stays available to input, composer, and contenteditable children", async () => {
  seedThreadPanel(true);
  renderZh(<MemoryRouter><ThreadPanel composerAutoFocus={false} /></MemoryRouter>);

  const input = document.createElement("input");
  input.type = "text";
  const headerActions = screen.getByTestId("thread-close").parentElement;
  assert.ok(headerActions, "the editable fixtures mount inside the real thread panel");
  headerActions.append(input);
  await act(async () => {
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    await Promise.resolve();
  });
  assert.equal(
    useThreadStore.getState().openParentMessageId,
    "parent-message",
    "Escape in a thread input must stay available to the editor",
  );

  const composer = await waitFor(() => {
    const textarea = document.querySelector("textarea");
    assert.ok(textarea, "the mounted thread composer exposes its textarea");
    return textarea;
  });
  assert.equal(composer.tagName, "TEXTAREA", "the mounted thread composer exercises the textarea guard");
  await act(async () => {
    composer.focus();
    fireEvent.keyDown(composer, { key: "Escape" });
    await Promise.resolve();
  });
  assert.equal(
    useThreadStore.getState().openParentMessageId,
    "parent-message",
    "Escape in the thread composer must stay available to the editor",
  );

  const editable = document.createElement("div");
  editable.contentEditable = "true";
  editable.tabIndex = 0;
  Object.defineProperty(editable, "isContentEditable", { configurable: true, value: true });
  headerActions.append(editable);
  await act(async () => {
    editable.focus();
    fireEvent.keyDown(editable, { key: "Escape" });
    await Promise.resolve();
  });
  assert.equal(
    useThreadStore.getState().openParentMessageId,
    "parent-message",
    "Escape in contenteditable thread content must stay available to the editor",
  );
});

test("ThreadPanel honors an already-prevented Escape inside the panel", async () => {
  seedThreadPanel(true);
  renderZh(<MemoryRouter><ThreadPanel composerAutoFocus={false} /></MemoryRouter>);

  const insideButton = await screen.findByTestId("thread-close");
  const preventEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") event.preventDefault();
  };
  insideButton.addEventListener("keydown", preventEscape);
  try {
    await act(async () => {
      insideButton.focus();
      fireEvent.keyDown(insideButton, { key: "Escape" });
      await Promise.resolve();
    });
    assert.equal(
      useThreadStore.getState().openParentMessageId,
      "parent-message",
      "a child that consumes Escape prevents the panel-level close",
    );
  } finally {
    insideButton.removeEventListener("keydown", preventEscape);
  }
});

test("ThreadPanel ignores Escape when focus is outside the panel", async () => {
  seedThreadPanel(true);
  renderZh(<MemoryRouter><ThreadPanel composerAutoFocus={false} /></MemoryRouter>);

  const outsideButton = document.createElement("button");
  outsideButton.textContent = "outside thread panel";
  document.body.append(outsideButton);
  try {
    await act(async () => {
      outsideButton.focus();
      fireEvent.keyDown(outsideButton, { key: "Escape" });
      await Promise.resolve();
    });
    assert.equal(
      useThreadStore.getState().openParentMessageId,
      "parent-message",
      "focus outside the panel must not close the thread",
    );
  } finally {
    outsideButton.remove();
  }
});

test("loaded, loading, and empty thread parents keep balanced brutal spacing", async () => {
  const expectedClasses = ["border-b-2", "border-black", "bg-white", "px-3", "py-3"];
  const assertParentRecipe = (branch: string) => {
    const parent = screen.getByTestId("thread-panel-parent");
    for (const className of expectedClasses) {
      assert.ok(parent.classList.contains(className), `${branch} parent keeps ${className}`);
    }
  };

  seedThreadPanel(true);
  const loaded = renderZh(<MemoryRouter><ThreadPanel composerAutoFocus={false} /></MemoryRouter>);
  assertParentRecipe("loaded");
  loaded.unmount();

  seedThreadPanel(false);
  api.get = ((url: string) => {
    if (url.startsWith("/messages/channel/thread-channel")) {
      return new Promise(() => {});
    }
    return Promise.resolve({ data: {} });
  }) as typeof api.get;
  const loading = renderZh(<MemoryRouter><ThreadPanel composerAutoFocus={false} /></MemoryRouter>);
  await waitFor(() => assertParentRecipe("loading"));
  loading.unmount();

  seedThreadPanel(false);
  renderZh(<MemoryRouter><ThreadPanel composerAutoFocus={false} /></MemoryRouter>);
  await screen.findByText("暂无回复");
  assertParentRecipe("empty");
});

test("joined channel threads render the composer against the parent membership scope", async () => {
  seedThreadPanel(true);
  const memberReads: string[] = [];
  api.get = (async (url: string) => {
    if (url.includes("/members")) memberReads.push(url);
    if (url === "/channels/parent-channel/members") {
      return { data: { agents: [], humans: [{
        id: "parent-member-id",
        name: "parent-member",
        displayName: "Parent Member",
        description: null,
        avatarUrl: null,
        gravatarHash: "",
        role: "member",
      }] } };
    }
    if (url === "/channels/thread-channel/members") {
      return { data: { agents: [], humans: [{
        id: "thread-member-id",
        name: "thread-member",
        displayName: "Thread Member",
        description: null,
        avatarUrl: null,
        gravatarHash: "",
        role: "member",
      }] } };
    }
    return { data: {} };
  }) as typeof api.get;

  renderEn(<MemoryRouter><ThreadPanel composerAutoFocus={false} /></MemoryRouter>);

  const composer = await screen.findByPlaceholderText("Message thread");
  await waitFor(() => assert.ok(memberReads.includes("/channels/parent-channel/members")));
  fireEvent.change(composer, {
    target: { value: "@parent", selectionStart: 7, selectionEnd: 7 },
  });
  assert.ok(await screen.findByText("@parent-member"), "parent member reaches real mention autocomplete");
  assert.equal(screen.queryByText("@thread-member"), null, "thread-only member does not leak into autocomplete");
  assert.ok(screen.queryByRole("button", { name: "Join channel to reply" }) === null);
});

test("unjoined channel threads replace the composer with a real parent-channel join action", async () => {
  seedThreadPanel(true);
  const posts: string[] = [];
  const threadChannel = makeChannel({ id: "thread-channel", type: "thread", name: "thread" });
  useChannelStore.setState({
    channels: [makeChannel({ joined: false }), threadChannel],
  } as never);
  api.post = (async (url: string) => {
    posts.push(url);
    return { data: {} };
  }) as typeof api.post;

  renderEn(<MemoryRouter><ThreadPanel composerAutoFocus={false} /></MemoryRouter>);

  assert.equal(screen.queryByPlaceholderText("Message thread"), null);
  fireEvent.click(screen.getByRole("button", { name: "Join channel to reply" }));
  await waitFor(() => assert.deepEqual(
    posts.filter((url) => url.endsWith("/join")),
    ["/channels/parent-channel/join"],
  ));
  assert.equal(posts.includes("/channels/thread-channel/join"), false, "the reply-channel id is never joined");
});

test("Guest thread hides the parent Join action when the visible parent is read-only", () => {
  seedThreadPanel(true);
  const threadChannel = makeChannel({ id: "thread-channel", type: "thread", name: "thread" });
  useServerStore.setState((state) => ({
    current: state.current ? { ...state.current, role: "guest" } : null,
  }));
  useChannelStore.setState({
    channels: [makeChannel({ joined: false, guestVisible: true, guestJoinable: false }), threadChannel],
  } as never);

  renderEn(<MemoryRouter><ThreadPanel composerAutoFocus={false} /></MemoryRouter>);

  assert.equal(screen.queryByPlaceholderText("Message thread"), null);
  assert.equal(screen.queryByRole("button", { name: "Join channel to reply" }), null);
});

test("DM threads keep their composer even when channel-style joined metadata is false", async () => {
  seedThreadPanel(true);
  const parentDm = makeChannel({
    type: "dm",
    joined: false,
    peerType: "user",
    peerId: "peer-1",
    peerName: "peer",
    peerDisplayName: "Peer",
  });
  const threadChannel = makeChannel({ id: "thread-channel", type: "thread", name: "thread" });
  useChannelStore.setState({
    channels: [threadChannel],
    dmChannels: [parentDm],
  } as never);

  renderEn(<MemoryRouter><ThreadPanel composerAutoFocus={false} /></MemoryRouter>);

  assert.ok(await screen.findByPlaceholderText("Message thread"));
  assert.equal(screen.queryByRole("button", { name: "Join channel to reply" }), null);
});

test("sending from an Activity-owned focused thread consumes the external message anchor", async () => {
  seedThreadPanel(true);
  let consumed = 0;
  const reply = makeMessage({ id: "reply-1", channelId: "thread-channel", content: "a reply", seq: 2 });
  api.get = (async (url: string) => {
    if (url.startsWith("/messages/channel/thread-channel")) {
      return { data: { messages: [reply], hasOlder: false, hasNewer: false } };
    }
    if (url.startsWith("/messages/context/parent-message")) {
      return { data: { messages: [makeMessage()] } };
    }
    if (url === "/tasks/channel/parent-channel") return { data: { tasks: [] } };
    return { data: {} };
  }) as typeof api.get;
  api.post = (async () => ({
    data: makeMessage({
      id: "reply-new",
      channelId: "thread-channel",
      content: "new reply",
      seq: 3,
    }),
  })) as typeof api.post;

  renderZh(
    <MemoryRouter>
      <ThreadPanel
        threadIdentity={{
          parentMessageId: "parent-message",
          parentChannelId: "parent-channel",
          threadChannelId: "thread-channel",
          focusedMessageId: "reply-1",
        }}
        onFocusedMessageConsumed={() => { consumed += 1; }}
        composerAutoFocus={false}
      />
    </MemoryRouter>,
  );

  const composer = await screen.findByRole("textbox");
  await act(async () => {
    fireEvent.change(composer, { target: { value: "new reply" } });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
    await Promise.resolve();
  });

  await waitFor(() => assert.equal(consumed, 1, "send preflight must retire the Activity-owned focus"));
});

test("Activity-owned thread focus does not re-center after the reader scrolls", async () => {
  seedThreadPanel(true);
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const focusedScrolls: ScrollIntoViewOptions[] = [];
  const reply = makeMessage({ id: "reply-1", channelId: "thread-channel", content: "a reply", seq: 2 });
  api.get = (async (url: string) => {
    if (url.startsWith("/messages/context/reply-1")) {
      return { data: { messages: [reply], hasOlder: false, hasNewer: false } };
    }
    if (url.startsWith("/messages/context/parent-message")) {
      return { data: { messages: [makeMessage()] } };
    }
    if (url === "/tasks/channel/parent-channel") return { data: { tasks: [] } };
    return { data: {} };
  }) as typeof api.get;
  Element.prototype.scrollIntoView = function scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
    if ((this as HTMLElement).dataset.timelineMessageId === "reply-1") {
      focusedScrolls.push(typeof options === "object" ? options : {});
    }
  };

  try {
    renderZh(
      <MemoryRouter>
        <ThreadPanel
          threadIdentity={{
            parentMessageId: "parent-message",
            parentChannelId: "parent-channel",
            threadChannelId: "thread-channel",
            focusedMessageId: "reply-1",
          }}
          composerAutoFocus={false}
        />
      </MemoryRouter>,
    );

    await screen.findByText("a reply");
    await waitFor(() => assert.ok(focusedScrolls.length > 0, "initial focused thread open should reveal the reply"));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    focusedScrolls.length = 0;

    const scroller = screen.getByTestId("thread-message-scroller");
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    await act(async () => {
      useMessageStore.setState((state) => ({
        channelMessages: {
          ...state.channelMessages,
          "thread-channel": [
            makeMessage({ id: "reply-1", channelId: "thread-channel", content: "edited while focused", seq: 2 }),
          ],
        },
      }));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });

    assert.equal(
      focusedScrolls.length,
      0,
      "message-window updates while the blue focus is visible must not pull the user's scroll back to the focus row",
    );
  } finally {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  }
});

test("Back to bottom from an Activity-owned focused thread retires the mount focus before reloading latest", async () => {
  seedThreadPanel(true);
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const originalScrollTo = HTMLElement.prototype.scrollTo;
  const focusedScrolls: ScrollIntoViewOptions[] = [];
  const bottomScrolls: ScrollToOptions[] = [];
  let consumed = 0;
  const focusedReply = makeMessage({
    id: "reply-focus",
    channelId: "thread-channel",
    content: "focused historical reply",
    seq: 2,
  });
  const latestReply = makeMessage({
    id: "reply-latest",
    channelId: "thread-channel",
    content: "latest thread reply",
    seq: 3,
  });
  const liveReply = makeMessage({
    id: "reply-live",
    channelId: "thread-channel",
    content: "realtime reply after bottom intent",
    seq: 4,
  });
  let latestRequests = 0;
  let resolveLatest!: (value: { data: { messages: Message[] } }) => void;
  const latestResponse = new Promise<{ data: { messages: Message[] } }>((resolve) => {
    resolveLatest = resolve;
  });

  api.get = ((url: string) => {
    if (url.startsWith("/messages/context/reply-focus")) {
      return Promise.resolve({
        data: {
          messages: [focusedReply],
          hasOlder: true,
          hasNewer: true,
        },
      });
    }
    if (url.startsWith("/messages/channel/thread-channel")) {
      latestRequests += 1;
      return latestResponse;
    }
    if (url.startsWith("/messages/context/parent-message")) {
      return Promise.resolve({ data: { messages: [makeMessage()] } });
    }
    if (url === "/tasks/channel/parent-channel") {
      return Promise.resolve({ data: { tasks: [] } });
    }
    return Promise.resolve({ data: {} });
  }) as typeof api.get;
  Element.prototype.scrollIntoView = function scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
    if ((this as HTMLElement).dataset.timelineMessageId === focusedReply.id) {
      focusedScrolls.push(typeof options === "object" ? options : {});
    }
  };
  HTMLElement.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    const normalized = typeof options === "number" ? { top: options } : (options ?? {});
    bottomScrolls.push(normalized);
    this.scrollTop = normalized.top ?? 0;
  };

  try {
    renderZh(
      <MemoryRouter>
        <ThreadPanel
          threadIdentity={{
            parentMessageId: "parent-message",
            parentChannelId: "parent-channel",
            threadChannelId: "thread-channel",
            focusedMessageId: focusedReply.id,
          }}
          onFocusedMessageConsumed={() => {
            consumed += 1;
          }}
          composerAutoFocus={false}
        />
      </MemoryRouter>,
    );

    await screen.findByText(focusedReply.content);
    await waitFor(() => assert.ok(focusedScrolls.length > 0, "Activity entry should reveal its focused reply once"));
    const focusedScrollsBeforeBottomIntent = focusedScrolls.length;

    fireEvent.click(screen.getByRole("button", { name: "回到底部" }));
    assert.equal(consumed, 1, "explicit bottom intent should retire Activity's external focus immediately");
    await waitFor(() => assert.ok(latestRequests >= 1, "Back to bottom should request the live thread tail"));

    await act(async () => {
      resolveLatest({ data: { messages: [focusedReply, latestReply] } });
      await latestResponse;
    });
    await screen.findByText(latestReply.content);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });

    assert.equal(
      focusedScrolls.length,
      focusedScrollsBeforeBottomIntent,
      "the latest-window remount must not replay the stale Activity focus after explicit bottom intent",
    );

    const bottomScrollsBeforeLiveReply = bottomScrolls.length;
    await act(async () => {
      useMessageStore.setState((state) => ({
        channelMessages: {
          ...state.channelMessages,
          "thread-channel": [focusedReply, latestReply, liveReply],
        },
      }));
    });
    await screen.findByText(liveReply.content);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });

    assert.ok(
      bottomScrolls.length > bottomScrollsBeforeLiveReply,
      "the first realtime reply after Back to bottom must remain in live-tail follow mode",
    );
  } finally {
    Element.prototype.scrollIntoView = originalScrollIntoView;
    HTMLElement.prototype.scrollTo = originalScrollTo;
  }
});
