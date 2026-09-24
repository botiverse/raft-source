import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { MemoryRouter } from "react-router-dom";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import api from "../src/api/client";
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import type { TranslationEntry } from "../src/store/translationStore";
import type { Locale } from "../src/i18n/locale";

const originalGet = api.get;
const originalPost = api.post;
const originalWindowSetTimeout = typeof window !== "undefined" ? window.setTimeout.bind(window) : null;

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }
}

function installBrowserStubs() {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  if (originalWindowSetTimeout) {
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      if ((timeout ?? 0) >= 30_000) return 0 as ReturnType<typeof window.setTimeout>;
      return originalWindowSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  }
}

function installMermaidLayoutStubs() {
  const getBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
  const getComputedTextLength = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getComputedTextLength");
  const getContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 100, height: 20 }),
  });
  Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
    configurable: true,
    value: () => 100,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ measureText: (text: string) => ({ width: text.length * 8 }) }),
  });
  return () => {
    if (getBBox) Object.defineProperty(SVGElement.prototype, "getBBox", getBBox);
    else delete (SVGElement.prototype as SVGElement & { getBBox?: unknown }).getBBox;
    if (getComputedTextLength) {
      Object.defineProperty(SVGElement.prototype, "getComputedTextLength", getComputedTextLength);
    } else {
      delete (SVGElement.prototype as SVGElement & { getComputedTextLength?: unknown }).getComputedTextLength;
    }
    if (getContext) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", getContext);
    else delete (HTMLCanvasElement.prototype as HTMLCanvasElement & { getContext?: unknown }).getContext;
  };
}

function makeUser(): User {
  return {
    id: "viewer-1",
    email: "viewer@example.com",
    gravatarHash: "viewerhash",
    name: "viewer",
    displayName: "Viewer",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: "en",
    preferredTimezone: null,
    autoTranslationEnabled: false,
    preferredTranslationMode: "manual",
    preferredTranslationDisplay: "translated",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
}

function makeServer(): Server {
  return {
    id: "server-1",
    name: "Server",
    slug: "server",
    ownerId: "viewer-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "member",
    createdAt: "2026-07-06T00:00:00.000Z",
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-translate-1",
    channelId: "channel-1",
    senderType: "user",
    senderId: "sender-2",
    senderName: "Sender",
    messageType: "chat",
    content: "Hola original",
    createdAt: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

async function renderMessage(
  message: Message,
  options: {
    entries?: Record<string, TranslationEntry>;
    display?: "translated" | "original" | "bilingual";
    threadSummary?: {
      threadChannelId: string;
      replyCount: number;
      lastReplyAt: string | null;
      participantIds: string[];
      unreadCount: number;
      firstUnreadMessageId: string | null;
    };
    hideThreadActions?: boolean;
    locale?: Locale;
    mode?: "auto" | "manual" | "off";
    available?: boolean;
    drafts?: Record<string, string>;
  } = {},
) {
  installBrowserStubs();
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useMessageStore } = await import("../src/store/messageStore");
  const { useSavedStore } = await import("../src/store/savedStore");
  const { useServerStore } = await import("../src/store/serverStore");
  const { useTranslationStore } = await import("../src/store/translationStore");
  const { useThreadStore } = await import("../src/store/threadStore");

  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  });
  useServerStore.setState({ current: makeServer(), members: [] as ServerMember[] });
  useAgentStore.setState({ agents: [] as Agent[], agentActivities: {} });
  useChannelStore.setState({ dmChannels: [] as Channel[] });
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false });
  useMessageStore.setState({
    channelMessages: { [message.channelId]: [message] },
    messages: [message],
    drafts: options.drafts ?? {},
  });
  useThreadStore.setState(useThreadStore.getInitialState(), true);
  useTranslationStore.setState((state) => ({
    entries: options.entries ?? {},
    inFlightBatchKeys: {},
    settings: {
      ...state.settings,
      preferredLanguage: "en",
      effectiveLanguage: "en",
      autoTranslationEnabled: options.mode === "auto",
      preferredTranslationMode: options.mode ?? "manual",
      preferredTranslationDisplay: options.display ?? "translated",
      available: options.available ?? true,
      serverTranslationEnabled: true,
      providerAvailable: options.available ?? true,
    },
  }));

  const tree = (
    <MemoryRouter>
      <MessageItem
        message={message}
        mentionMap={new Map()}
        channels={[]}
        hideThreadActions={options.hideThreadActions ?? true}
        threadSummary={options.threadSummary}
      />
    </MemoryRouter>
  );
  // The default `render` shim wraps in TestIntlProvider (en); zh tests pass an
  // explicit locale to assert the migrated Chinese copy renders.
  const view = options.locale
    ? rtlRender(<TestIntlProvider locale={options.locale}>{tree}</TestIntlProvider>)
    : render(tree);
  const row = view.container.querySelector<HTMLElement>(`#message-${message.id}`);
  assert.ok(row);
  return { ...view, row };
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  if (originalWindowSetTimeout) {
    window.setTimeout = originalWindowSetTimeout as typeof window.setTimeout;
  }
});

test("MessageItem routes patch, document, and generic attachments through one pinned wrapping chip row", async () => {
  api.get = (async () => ({ data: null })) as typeof api.get;
  const attachments = [
    { id: "attachment-patch", filename: "changes.patch", mimeType: "text/x-patch", sizeBytes: 1024 },
    { id: "attachment-csv", filename: "report.csv", mimeType: "text/csv", sizeBytes: 2048 },
    { id: "attachment-zip", filename: "archive.zip", mimeType: "application/zip", sizeBytes: 4096 },
  ];
  const { row } = await renderMessage(makeMessage({
    id: "message-attachments",
    content: "three attachment branches",
    attachments,
  }));

  const roots = attachments.map(({ filename }) => {
    const root = screen.getByLabelText(filename);
    assert.match(root.className, /\bw-44\b/);
    assert.match(root.className, /\bmin-w-44\b/);
    assert.match(root.className, /\bmax-w-44\b/);
    assert.match(root.className, /\bshrink-0\b/);
    assert.match(root.className, /\boverflow-hidden\b/);
    const filenameNode = root.querySelector("[data-message-affordance='attachment-filename']");
    assert.ok(filenameNode);
    assert.equal(filenameNode.textContent, filename);
    assert.match(filenameNode.className, /\btruncate\b/);
    return root;
  });

  assert.equal(roots[0]?.className, roots[1]?.className, "patch and document branches use the same compact chip");
  assert.equal(roots[1]?.className, roots[2]?.className, "generic wide compatibility renders the same chip");
  assert.ok(roots[0]?.querySelector("[data-message-affordance='file-download']"));
  assert.ok(roots[1]?.querySelector("[data-message-affordance='document-preview']"));
  assert.ok(roots[2]?.querySelector("[data-message-affordance='file-download']"));

  const chipRow = roots[0]?.parentElement;
  assert.ok(chipRow);
  assert.ok(row.contains(chipRow));
  assert.match(chipRow.className, /(?:^|\s)max-w-\[22\.5rem\](?:\s|$)/);
  assert.match(chipRow.className, /\bflex-wrap\b/);
});

test("MessageItem thread badge opens the first unread reply and keeps unread plus draft in one pill", async () => {
  const message = makeMessage({ id: "message-thread-badge" });
  const { useThreadStore } = await import("../src/store/threadStore");
  await renderMessage(message, {
    hideThreadActions: false,
    drafts: { "thread-channel-1": "unfinished reply" },
    threadSummary: {
      threadChannelId: "thread-channel-1",
      replyCount: 2,
      lastReplyAt: "2026-07-06T00:01:00.000Z",
      participantIds: ["sender-2"],
      unreadCount: 1,
      firstUnreadMessageId: "reply-unread-1",
    },
  });

  const badge = screen.getByTestId("message-thread-replies-badge");
  assert.match(badge.textContent ?? "", /2 replies/);
  assert.match(badge.textContent ?? "", /1 new/);
  assert.match(badge.textContent ?? "", /draft/);
  assert.match(badge.className, /\bbg-brutal-cyan\/20\b/);
  assert.equal(screen.getAllByTestId("message-thread-replies-badge").length, 1);
  fireEvent.click(badge);

  await waitFor(() => {
    const state = useThreadStore.getState();
    assert.equal(state.openParentMessageId, message.id);
    assert.equal(state.openParentChannelId, message.channelId);
    assert.equal(state.openThreadChannelId, "thread-channel-1");
    assert.equal(state.focusedMessageId, "reply-unread-1");
    assert.equal(state.openIntent, "thread");
  });
});

test("MessageItem thread badge renders draft-only and stays absent for empty or hidden actions", async () => {
  await renderMessage(makeMessage({ id: "message-draft-thread" }), {
    hideThreadActions: false,
    drafts: { "thread-channel-draft": "unfinished reply" },
    threadSummary: {
      threadChannelId: "thread-channel-draft",
      replyCount: 0,
      lastReplyAt: null,
      participantIds: [],
      unreadCount: 0,
      firstUnreadMessageId: null,
    },
  });
  const draftOnly = screen.getByTestId("message-thread-replies-badge");
  assert.equal(draftOnly.textContent?.trim(), "draft");
  assert.equal(draftOnly.querySelectorAll("svg").length, 1);

  cleanup();
  await renderMessage(makeMessage({ id: "message-empty-thread" }), {
    hideThreadActions: false,
    threadSummary: {
      threadChannelId: "thread-channel-empty",
      replyCount: 0,
      lastReplyAt: null,
      participantIds: [],
      unreadCount: 0,
      firstUnreadMessageId: null,
    },
  });
  assert.equal(screen.queryByTestId("message-thread-replies-badge"), null);

  cleanup();
  await renderMessage(makeMessage({ id: "message-hidden-thread" }), {
    hideThreadActions: true,
    threadSummary: {
      threadChannelId: "thread-channel-hidden",
      replyCount: 2,
      lastReplyAt: "2026-07-06T00:01:00.000Z",
      participantIds: [],
      unreadCount: 1,
      firstUnreadMessageId: "reply-hidden",
    },
  });
  assert.equal(screen.queryByTestId("message-thread-replies-badge"), null);
});

test("bilingual display renders translated content plus the original sidecar", async () => {
  const message = makeMessage();
  const { row } = await renderMessage(message, {
    display: "bilingual",
    entries: {
      [message.id]: {
        messageId: message.id,
        status: "translated",
        translatedContent: "Hello translated",
        sourceLanguage: "es",
        targetLanguage: "en",
        originalContent: message.content,
      },
    },
  });

  assert.match(row.textContent ?? "", /Hello translated/);
  const original = screen.getByTestId(`message-translation-bilingual-original-${message.id}`);
  assert.match(original.textContent ?? "", /Original/);
  assert.match(original.textContent ?? "", /Hola original/);
  const originalBody = original.querySelector("div.break-words.select-text");
  assert.ok(originalBody, "original sidecar keeps the selectable message-body layout");
});

test("show translation overrides an original default view for the message", async () => {
  const message = makeMessage();
  const { row } = await renderMessage(message, {
    display: "original",
    entries: {
      [message.id]: {
        messageId: message.id,
        status: "translated",
        translatedContent: "Hello translated",
        sourceLanguage: "es",
        targetLanguage: "en",
        originalContent: message.content,
      },
    },
  });

  assert.match(row.textContent ?? "", /Hola original/);
  assert.doesNotMatch(row.textContent ?? "", /Hello translated/);

  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Show translation" }));
  });

  await waitFor(() => assert.match(row.textContent ?? "", /Hello translated/));
  assert.doesNotMatch(row.textContent ?? "", /Hola original/);
  assert.ok(screen.getByRole("button", { name: "Show original" }));
});

test("show translation returns to bilingual when both is the default view", async () => {
  const message = makeMessage();
  const { row } = await renderMessage(message, {
    display: "bilingual",
    entries: {
      [message.id]: {
        messageId: message.id,
        status: "translated",
        translatedContent: "Hello translated",
        sourceLanguage: "es",
        targetLanguage: "en",
        originalContent: message.content,
        showOriginal: true,
      },
    },
  });

  assert.match(row.textContent ?? "", /Hola original/);
  assert.doesNotMatch(row.textContent ?? "", /Hello translated/);

  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Show translation" }));
  });

  await waitFor(() => assert.match(row.textContent ?? "", /Hello translated/));
  const original = screen.getByTestId(`message-translation-bilingual-original-${message.id}`);
  assert.match(original.textContent ?? "", /Original/);
  assert.match(original.textContent ?? "", /Hola original/);
  assert.ok(screen.getByRole("button", { name: "Show original" }));
});

test("same-language result never exposes a translation toggle above reply metadata", async () => {
  const message = makeMessage();
  const { row } = await renderMessage(message, {
    hideThreadActions: false,
    entries: {
      [message.id]: {
        messageId: message.id,
        status: "skipped",
        reason: "same_language",
        sourceLanguage: "en",
        targetLanguage: "en",
        originalContent: message.content,
        showOriginal: false,
      },
    },
    threadSummary: {
      threadChannelId: "thread-channel-1",
      replyCount: 2,
      lastReplyAt: "2026-07-06T00:01:00.000Z",
      participantIds: ["sender-2"],
      unreadCount: 0,
      firstUnreadMessageId: null,
    },
  });

  assert.match(row.textContent ?? "", /Hola original/);
  const replies = screen.getByTestId("message-thread-replies-badge");
  assert.ok(replies);
  assert.equal(screen.queryByRole("button", { name: "Show original" }), null);
  assert.equal(screen.queryByRole("button", { name: "Show translation" }), null);
});

test("translated-message toggle stays compact and precedes reply metadata", async () => {
  const message = makeMessage();
  const { row } = await renderMessage(message, {
    hideThreadActions: false,
    entries: {
      [message.id]: {
        messageId: message.id,
        status: "translated",
        translatedContent: "Hello translated",
        sourceLanguage: "es",
        targetLanguage: "en",
        originalContent: message.content,
        showOriginal: false,
      },
    },
    threadSummary: {
      threadChannelId: "thread-channel-1",
      replyCount: 2,
      lastReplyAt: "2026-07-06T00:01:00.000Z",
      participantIds: ["sender-2"],
      unreadCount: 0,
      firstUnreadMessageId: null,
    },
  });

  const indicator = screen.getByTestId(`message-translation-indicator-${message.id}`);
  const toggle = screen.getByRole("button", { name: "Show original" });
  const replies = screen.getByTestId("message-thread-replies-badge");
  assert.equal(toggle.textContent, "Show original", "the compact action has no Translated/Original prefix");
  assert.doesNotMatch(indicator.textContent ?? "", /Translated|Original/);
  assert.ok(row.contains(indicator));
  assert.ok(row.contains(replies));
  assert.ok(
    indicator.compareDocumentPosition(replies) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the translation action must render before the footer reply metadata",
  );
});

test("same-language result never exposes a translation toggle without reply metadata", async () => {
  const message = makeMessage();
  const { row } = await renderMessage(message, {
    entries: {
      [message.id]: {
        messageId: message.id,
        status: "skipped",
        reason: "same_language",
        sourceLanguage: "en",
        targetLanguage: "en",
        originalContent: message.content,
        showOriginal: false,
      },
    },
  });

  assert.match(row.textContent ?? "", /Hola original/);
  assert.equal(screen.queryByRole("button", { name: "Show original" }), null);
  assert.equal(screen.queryByRole("button", { name: "Show translation" }), null);
  assert.equal(screen.queryByTestId("message-thread-replies-badge"), null);
});

test("manual same-language request result drops explicit translation view intent without a payload", async () => {
  installBrowserStubs();
  const message = makeMessage();
  const { useTranslationStore } = await import("../src/store/translationStore");
  useTranslationStore.setState((state) => ({
    entries: {},
    inFlightBatchKeys: {},
    settings: {
      ...state.settings,
      available: true,
      serverTranslationEnabled: true,
      providerAvailable: true,
    },
  }));
  api.post = (async (url: string, body?: any) => {
    assert.equal(url, "/message-translations:batch");
    assert.equal(body?.mode, "manual");
    assert.deepEqual(body?.messageIds, [message.id]);
    return {
      data: {
        results: [{
          messageId: message.id,
          status: "skipped",
          reason: "same_language",
          sourceLanguage: "en",
          targetLanguage: "en",
        }],
      },
    };
  }) as typeof api.post;

  await useTranslationStore.getState().requestTranslations([message], {
    targetLanguage: "en",
    viewerUserId: "viewer-1",
    force: true,
  });

  assert.equal(useTranslationStore.getState().entries[message.id]?.showOriginal, undefined);
});

test("auto same-language request result remains a passive silent skip", async () => {
  installBrowserStubs();
  const message = makeMessage();
  const { useTranslationStore } = await import("../src/store/translationStore");
  useTranslationStore.setState((state) => ({
    entries: {},
    inFlightBatchKeys: {},
    settings: {
      ...state.settings,
      available: true,
      serverTranslationEnabled: true,
      providerAvailable: true,
    },
  }));
  api.post = (async (url: string, body?: any) => {
    assert.equal(url, "/message-translations:batch");
    assert.equal(body?.mode, "auto");
    return {
      data: {
        results: [{
          messageId: message.id,
          status: "skipped",
          reason: "same_language",
          sourceLanguage: "en",
          targetLanguage: "en",
        }],
      },
    };
  }) as typeof api.post;

  await useTranslationStore.getState().requestTranslations([message], {
    targetLanguage: "en",
    viewerUserId: "viewer-1",
  });

  assert.equal(useTranslationStore.getState().entries[message.id]?.showOriginal, undefined);
});

test("server-pending translation result keeps timeout metadata", async () => {
  installBrowserStubs();
  const message = makeMessage();
  const { useTranslationStore } = await import("../src/store/translationStore");
  useTranslationStore.setState((state) => ({
    entries: {},
    inFlightBatchKeys: {},
    settings: {
      ...state.settings,
      available: true,
      serverTranslationEnabled: true,
      providerAvailable: true,
    },
  }));
  api.post = (async (url: string, body?: any) => {
    assert.equal(url, "/message-translations:batch");
    assert.equal(body?.mode, "auto");
    return {
      data: {
        results: [{
          messageId: message.id,
          status: "pending",
          targetLanguage: "en",
        }],
      },
    };
  }) as typeof api.post;

  await useTranslationStore.getState().requestTranslations([message], {
    targetLanguage: "en",
    viewerUserId: "viewer-1",
  });

  const entry = useTranslationStore.getState().entries[message.id];
  assert.equal(entry?.status, "pending");
  assert.equal(typeof entry?.pendingSince, "number");
});

test("missing batch result keeps the requested language and exits the auto placeholder", async () => {
  installBrowserStubs();
  const message = makeMessage();
  const { useTranslationStore } = await import("../src/store/translationStore");
  useTranslationStore.setState((state) => ({
    entries: {},
    inFlightBatchKeys: {},
    settings: {
      ...state.settings,
      available: true,
      serverTranslationEnabled: true,
      providerAvailable: true,
    },
  }));
  api.post = (async () => ({ data: { results: [] } })) as typeof api.post;

  await useTranslationStore.getState().requestTranslations([message], {
    targetLanguage: "en",
    viewerUserId: "viewer-1",
  });

  const entry = useTranslationStore.getState().entries[message.id];
  assert.equal(entry?.status, "not_found");
  assert.equal(entry?.targetLanguage, "en");
  await renderMessage(message, { entries: { [message.id]: entry! } });
  assert.equal(screen.queryByTestId(`message-translation-placeholder-${message.id}`), null);
  assert.ok(screen.getByText(message.content));
});

test("manual translation mode exposes Translate only in the shared message context menu", async () => {
  const message = makeMessage();
  let requestCount = 0;
  let requestBody: any = null;
  api.post = (async (url: string, body?: any) => {
    requestCount += 1;
    assert.equal(url, "/message-translations:batch");
    requestBody = body;
    return { data: { results: [] } };
  }) as typeof api.post;

  const { row } = await renderMessage(message);
  assert.equal(screen.queryByTestId(`message-translate-button-${message.id}`), null);
  assert.equal(requestCount, 0);

  fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
  const translate = screen.getByRole("menuitem", { name: "Translate" });
  assert.equal(translate.getAttribute("data-testid"), `message-translate-menu-item-${message.id}`);

  fireEvent.click(translate);
  await waitFor(() => assert.equal(requestCount, 1));
  assert.deepEqual(requestBody, {
    messageIds: [message.id],
    targetLanguage: "en",
    mode: "manual",
  });
});

test("manual translation lets the current human translate their own message", async () => {
  const message = makeMessage({ senderId: "viewer-1", senderName: "Viewer" });
  let requestBody: any = null;
  api.post = (async (url: string, body?: any) => {
    assert.equal(url, "/message-translations:batch");
    requestBody = body;
    return { data: { results: [] } };
  }) as typeof api.post;

  const { row } = await renderMessage(message);
  fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Translate" }));

  await waitFor(() => assert.deepEqual(requestBody, {
    messageIds: [message.id],
    targetLanguage: "en",
    mode: "manual",
  }));
});

test("mobile long-press opens the same Manual Translate action", async () => {
  const message = makeMessage();
  const { row } = await renderMessage(message);

  fireEvent.touchStart(row, {
    touches: [{ clientX: 24, clientY: 36 }],
  });
  await waitFor(
    () => assert.ok(screen.getByRole("menuitem", { name: "Translate" })),
    { timeout: 1_000 },
  );
  fireEvent.touchEnd(row);
});

test("a child dropdown backdrop owns its portaled touch sequence", async () => {
  const restoreMermaidLayout = installMermaidLayoutStubs();
  try {
    const message = makeMessage({
      content: "```mermaid\ngraph TD\n  A --> B\n```",
    });
    const { row } = await renderMessage(message);
    const download = await screen.findByRole("button", { name: "Download Mermaid diagram" }, { timeout: 5_000 });
    await waitFor(() => assert.equal((download as HTMLButtonElement).disabled, false), { timeout: 5_000 });

    fireEvent.click(download);
    const dropdownMenu = await screen.findByRole("menu");
    const backdrop = Array.from(document.body.querySelectorAll("[data-base-ui-inert]"))
      .find((candidate) => candidate instanceof HTMLElement && candidate.style.position === "fixed");
    assert.ok(backdrop instanceof HTMLElement, "the modal dropdown needs its portaled interaction backdrop");

    await act(async () => {
      fireEvent.touchStart(dropdownMenu, {
        touches: [{ clientX: 52, clientY: 68 }],
      });
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    const leakedFromMenuContent = screen.queryByRole("menu", { name: "Message context menu" }) !== null;
    if (leakedFromMenuContent) cleanup();
    assert.equal(leakedFromMenuContent, false,
      "touching child portal content must not arm the message long-press timer");
    fireEvent.touchEnd(dropdownMenu, {
      changedTouches: [{ clientX: 52, clientY: 68 }],
    });
    fireEvent.contextMenu(dropdownMenu, { clientX: 52, clientY: 68 });
    const leakedContextMenuFromContent = screen.queryByRole("menu", { name: "Message context menu" }) !== null;
    if (leakedContextMenuFromContent) cleanup();
    assert.equal(leakedContextMenuFromContent, false,
      "right-clicking child portal content must stay outside MessageItem ownership");

    // The portal is logically nested under MessageItem, but its DOM target lives
    // under body. Only the child overlay owns this long touch; MessageItem must
    // not arm its 500ms long-press timer from React's logical portal bubbling.
    await act(async () => {
      fireEvent.touchStart(backdrop, {
        touches: [{ clientX: 48, clientY: 64 }],
      });
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    const leakedMessageMenu = screen.queryByRole("menu", { name: "Message context menu" }) !== null;
    if (leakedMessageMenu) cleanup();
    assert.equal(leakedMessageMenu, false,
      "a child overlay touch must not open the message context menu");

    fireEvent.contextMenu(backdrop, { clientX: 48, clientY: 64 });
    const leakedNativeContextMenu = screen.queryByRole("menu", { name: "Message context menu" }) !== null;
    if (leakedNativeContextMenu) cleanup();
    assert.equal(leakedNativeContextMenu, false,
      "a native contextmenu from the child backdrop must stay outside MessageItem ownership");

    fireEvent.touchEnd(backdrop, {
      changedTouches: [{ clientX: 48, clientY: 64 }],
    });
    fireEvent.mouseDown(backdrop, { clientX: 48, clientY: 64 });
    fireEvent.mouseUp(backdrop, { clientX: 48, clientY: 64 });
    fireEvent.click(backdrop);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.equal(download.getAttribute("aria-expanded"), "false",
      "the same outside interaction must return dropdown ownership immediately");

    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    assert.match(row.textContent ?? "", /graph TD/, "toolbar actions must work immediately after dismissing the dropdown");

    fireEvent.contextMenu(row, { clientX: 24, clientY: 36 });
    const pointerMessageMenu = screen.getByRole("menu", { name: "Message context menu" });
    assert.ok(pointerMessageMenu, "a physical desktop right-click inside the row still belongs to MessageItem");
    const pointerBackdrop = pointerMessageMenu.previousElementSibling;
    assert.ok(pointerBackdrop instanceof HTMLElement);
    fireEvent.click(pointerBackdrop);

    fireEvent.touchStart(row, {
      touches: [{ clientX: 24, clientY: 36 }],
    });
    await waitFor(
      () => assert.ok(screen.getByRole("menu", { name: "Message context menu" })),
      { timeout: 1_000 },
    );
    fireEvent.touchEnd(row);
  } finally {
    restoreMermaidLayout();
  }
});

test("pending manual translation keeps the original and disables Translating in the context menu", async () => {
  const message = makeMessage();
  const { row } = await renderMessage(message, {
    entries: {
      [message.id]: {
        messageId: message.id,
        status: "pending",
        targetLanguage: "en",
        originalContent: message.content,
        pendingSince: 1,
      },
    },
  });

  assert.ok(screen.getByText(message.content));
  assert.equal(screen.queryByTestId(`message-translation-placeholder-${message.id}`), null);
  assert.ok(screen.getByText("Translating…"));
  assert.equal(screen.queryByTestId(`message-translate-button-${message.id}`), null);

  fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
  const pendingAction = screen.getByRole("menuitem", { name: "Translating…" });
  assert.equal((pendingAction as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByRole("button", { name: "Show original" }), null);
  assert.equal(screen.queryByRole("button", { name: "Show translation" }), null);
});

test("a Manual menu request shows the returned translation before the original-default view", async () => {
  const message = makeMessage();
  api.post = (async (_url: string, body?: any) => ({
    data: {
      results: [{
        messageId: body.messageIds[0],
        status: "translated",
        translatedContent: "Hello translated",
        sourceLanguage: "es",
        targetLanguage: body.targetLanguage,
      }],
    },
  })) as typeof api.post;

  const { row } = await renderMessage(message, { display: "original" });
  fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Translate" }));

  await waitFor(() => assert.match(row.textContent ?? "", /Hello translated/));
  assert.doesNotMatch(row.textContent ?? "", /Hola original/);
  assert.ok(screen.getByRole("button", { name: "Show original" }));

  fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
  assert.equal(screen.queryByRole("menuitem", { name: "Translate" }), null);
});

test("a skipped Manual result keeps the original, has no toggle, and offers Translate again", async () => {
  const message = makeMessage();
  api.post = (async (_url: string, body?: any) => ({
    data: {
      results: [{
        messageId: body.messageIds[0],
        status: "skipped",
        reason: "same_language",
        sourceLanguage: "en",
        targetLanguage: body.targetLanguage,
      }],
    },
  })) as typeof api.post;

  const { row } = await renderMessage(message);
  fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Translate" }));

  await waitFor(() => assert.ok(screen.getByText(message.content)));
  assert.equal(screen.queryByRole("button", { name: "Show original" }), null);
  assert.equal(screen.queryByRole("button", { name: "Show translation" }), null);

  fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
  assert.ok(screen.getByRole("menuitem", { name: "Translate" }));
});

test("a translated result without usable content has no Retry or toggle and offers Translate again", async () => {
  const message = makeMessage();
  const { row } = await renderMessage(message, {
    entries: {
      [message.id]: {
        messageId: message.id,
        status: "translated",
        translatedContent: "   ",
        targetLanguage: "en",
        originalContent: message.content,
      },
    },
  });

  assert.ok(screen.getByText(message.content));
  assert.equal(screen.queryByRole("button", { name: "Retry" }), null);
  assert.equal(screen.queryByRole("button", { name: "Show original" }), null);
  assert.equal(screen.queryByRole("button", { name: "Show translation" }), null);

  fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
  assert.ok(screen.getByRole("menuitem", { name: "Translate" }));
});

test("Manual Translate stays absent for Auto, Off, unavailable, empty, and structured messages", async () => {
  const cases: Array<{
    label: string;
    message: Message;
    options?: Parameters<typeof renderMessage>[1];
  }> = [
    { label: "auto", message: makeMessage(), options: { mode: "auto" } },
    { label: "off", message: makeMessage(), options: { mode: "off" } },
    { label: "unavailable", message: makeMessage(), options: { available: false } },
    { label: "empty", message: makeMessage({ content: "" }) },
    {
      label: "structured",
      message: makeMessage({
        actionMetadata: {
          kind: "action-card",
          state: "prepared",
          action: {
            type: "integration:approve_agent_login",
            requestId: "request-1",
            agentId: "agent-1",
            agentName: "Writer",
            clientId: "client-1",
            clientKey: "demo-app",
            clientName: "Demo App",
            scopes: ["messages:read"],
          },
        },
      }),
    },
  ];

  for (const testCase of cases) {
    const { row, unmount } = await renderMessage(testCase.message, testCase.options);
    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
    assert.equal(
      screen.queryByTestId(`message-translate-menu-item-${testCase.message.id}`),
      null,
      `${testCase.label} must not expose Manual Translate`,
    );
    unmount();
    cleanup();
  }
});

test("failed Manual state exposes only Retry while content or target invalidation re-enables Translate", async () => {
  const failed = makeMessage();
  const failedView = await renderMessage(failed, {
    entries: {
      [failed.id]: {
        messageId: failed.id,
        status: "failed",
        targetLanguage: "en",
        originalContent: failed.content,
      },
    },
  });
  assert.ok(screen.getByRole("button", { name: "Retry" }));
  fireEvent.contextMenu(failedView.row, { clientX: 20, clientY: 30 });
  assert.equal(screen.queryByRole("menuitem", { name: "Translate" }), null);
  failedView.unmount();
  cleanup();

  const edited = makeMessage({ content: "Edited source" });
  const editedView = await renderMessage(edited, {
    entries: {
      [edited.id]: {
        messageId: edited.id,
        status: "translated",
        translatedContent: "Stale translation",
        targetLanguage: "en",
        originalContent: "Old source",
      },
    },
  });
  assert.match(editedView.row.textContent ?? "", /Edited source/);
  assert.doesNotMatch(editedView.row.textContent ?? "", /Stale translation/);
  fireEvent.contextMenu(editedView.row, { clientX: 20, clientY: 30 });
  assert.ok(screen.getByRole("menuitem", { name: "Translate" }));
});

test("Manual request dedupes the same pending message while allowing a new target", async () => {
  installBrowserStubs();
  const message = makeMessage();
  const { useTranslationStore } = await import("../src/store/translationStore");
  useTranslationStore.setState({ entries: {}, inFlightBatchKeys: {} });

  let release!: (value: { data: { results: any[] } }) => void;
  let postCount = 0;
  api.post = (() => {
    postCount += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  }) as typeof api.post;

  const first = useTranslationStore.getState().requestTranslations([message], {
    targetLanguage: "en",
    viewerUserId: "viewer-1",
    force: true,
  });
  const duplicate = useTranslationStore.getState().requestTranslations([message], {
    targetLanguage: "en",
    viewerUserId: "viewer-1",
    force: true,
  });
  assert.equal(postCount, 1);
  await duplicate;
  release({
    data: {
      results: [{
        messageId: message.id,
        status: "translated",
        translatedContent: "Hello",
        targetLanguage: "en",
      }],
    },
  });
  await first;

  api.post = (async () => {
    postCount += 1;
    return { data: { results: [] } };
  }) as typeof api.post;
  await useTranslationStore.getState().requestTranslations([message], {
    targetLanguage: "de",
    viewerUserId: "viewer-1",
  });
  assert.equal(postCount, 2, "target changes must not reuse the prior-language entry");
});

test("i18n: Manual context-menu translation uses the zh action label", async () => {
  const message = makeMessage();
  const { row } = await renderMessage(message, { locale: "zh-cn" });
  fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
  assert.ok(screen.getByRole("menuitem", { name: "翻译" }));
});

// --- MI-1 react-intl migration teeth: MessageItem translation indicator renders
// zh copy and, critically, the action still routes by the stable `action`
// discriminator (not the localized label). Pre-migration the handler compared
// `text.label === "Retry"`, which would misroute every action under zh. ---

test("i18n: translated message shows the zh toggle-to-original control", async () => {
  const message = makeMessage();
  const { row } = await renderMessage(message, {
    locale: "zh-cn",
    display: "translated",
    entries: {
      [message.id]: {
        messageId: message.id,
        status: "translated",
        translatedContent: "Hello translated",
        sourceLanguage: "es",
        targetLanguage: "en",
        originalContent: message.content,
      },
    },
  });

  // Translated content is shown; the control offers switching to the original.
  assert.match(row.textContent ?? "", /Hello translated/);
  const toggle = screen.getByRole("button", { name: "显示原文" });

  // Clicking the localized control routes to onToggleOriginal (action-based, not
  // an English label compare) and swaps to the original content under zh.
  act(() => {
    fireEvent.click(toggle);
  });
  await waitFor(() => assert.match(row.textContent ?? "", /Hola original/));
  assert.ok(screen.getByRole("button", { name: "显示翻译" }));
});

test("i18n: original-view translated message shows the zh show-translation control", async () => {
  const message = makeMessage();
  await renderMessage(message, {
    locale: "zh-cn",
    display: "original",
    entries: {
      [message.id]: {
        messageId: message.id,
        status: "translated",
        translatedContent: "Hello translated",
        sourceLanguage: "es",
        targetLanguage: "en",
        originalContent: message.content,
      },
    },
  });

  assert.ok(screen.getByRole("button", { name: "显示翻译" }));
});

test("i18n: failed translation routes the zh retry control to a retranslation (action, not label)", async () => {
  const message = makeMessage();
  const { row } = await renderMessage(message, {
    locale: "zh-cn",
    entries: {
      [message.id]: {
        messageId: message.id,
        status: "failed",
        targetLanguage: "en",
        originalContent: message.content,
      },
    },
  });

  assert.match(row.textContent ?? "", /翻译不可用/);
  const retry = screen.getByRole("button", { name: "重试" });

  // Clicking the localized "重试" must route to onRetry → a retranslation POST.
  // The pre-migration handler compared `text.label === "Retry"`, which under zh
  // ("重试") would fall through to onToggleOriginal and never retry — the stable
  // `action: "retry"` discriminator is what keeps this correct.
  const postCalls: string[] = [];
  api.post = ((url: string) => {
    postCalls.push(url);
    return Promise.resolve({ data: { results: [] } });
  }) as typeof api.post;

  act(() => {
    fireEvent.click(retry);
  });

  await waitFor(() => assert.ok(postCalls.includes("/message-translations:batch"),
    "retry must issue a retranslation batch request"));
});
