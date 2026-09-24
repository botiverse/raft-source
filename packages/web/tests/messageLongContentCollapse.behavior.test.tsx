import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import "./helpers/domSetup";
import { memo, useLayoutEffect, useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  __getExpandedMessageContentCountForTests,
  __resetMessageContentCollapseStateForTests,
  MESSAGE_CONTENT_EXPANSION_CACHE_LIMIT,
  default as CollapsibleMessageContent,
} from "../src/components/message/CollapsibleMessageContent";
import {
  MessageTimelineKeepMessageVisibleContext,
  MessageTimelinePreserveViewportContext,
} from "../src/components/message/MessageTimeline";
import { expandClonedMessageContentForScreenshot } from "../src/utils/selectScreenshot";
import { TestIntlProvider } from "./helpers/intl";
import type { Locale } from "../src/i18n/locale";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import type { Server } from "../src/store/serverStore";
import { TOPBAR_OVERFLOW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import {
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";

let renderedContentHeight = 0;
let scrollHeightReadCount = 0;
let originalScrollHeightDescriptor: PropertyDescriptor | undefined;
let originalResizeObserver: typeof ResizeObserver | undefined;
let originalWindowResizeObserver: typeof ResizeObserver | undefined;
let preserveViewportRequests = 0;
let keepVisibleRequests: string[] = [];

function makeResizeObserverEntry(target: Element, blockSize = renderedContentHeight): ResizeObserverEntry {
  const size = { blockSize, inlineSize: 480 } as ResizeObserverSize;
  return {
    target,
    borderBoxSize: [size],
    contentBoxSize: [size],
    devicePixelContentBoxSize: [size],
    contentRect: { height: blockSize } as DOMRectReadOnly,
  } as ResizeObserverEntry;
}

class TestResizeObserver implements ResizeObserver {
  static readonly instances = new Set<TestResizeObserver>();
  static emitOnObserve = true;
  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.add(this);
  }

  observe(target: Element) {
    this.observed.add(target);
    if (TestResizeObserver.emitOnObserve) this.emit(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
    TestResizeObserver.instances.delete(this);
  }

  emit(target: Element, blockSize = renderedContentHeight) {
    this.callback([makeResizeObserverEntry(target, blockSize)], this as unknown as ResizeObserver);
  }

  static emitAll(blockSize = renderedContentHeight) {
    for (const observer of Array.from(TestResizeObserver.instances)) {
      const entries = Array.from(observer.observed, (target) => makeResizeObserverEntry(target, blockSize));
      if (entries.length > 0) observer.callback(entries, observer as unknown as ResizeObserver);
    }
  }

  static activeObservedCount(): number {
    let count = 0;
    for (const observer of TestResizeObserver.instances) count += observer.observed.size;
    return count;
  }
}

function makeUser(): User {
  return {
    id: "user-1",
    email: "current@example.com",
    gravatarHash: "currenthash",
    name: "current",
    displayName: "Current User",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: null,
    autoTranslationEnabled: false,
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
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "member",
    createdAt: "2026-07-26T00:00:00.000Z",
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-1",
    serverId: "server-1",
    name: "design",
    description: null,
    type: "channel",
    createdAt: "2026-07-26T00:00:00.000Z",
    joined: true,
    ...overrides,
  };
}

function makeMessage(
  id: string,
  actionMetadata?: Message["actionMetadata"],
  attachments?: Message["attachments"],
): Message {
  return {
    id,
    seq: 1,
    channelId: "channel-1",
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Writer",
    messageType: "chat",
    content: "Outcome first.\\n\\n```text\\nDetailed evidence\\n```\\n\\n[detail](https://example.com)",
    actionMetadata,
    attachments,
    createdAt: "2026-07-26T00:00:00.000Z",
  };
}

async function renderMessage(
  id: string,
  {
    parentMessageId,
    actionMetadata,
    attachments,
    locale,
    topbarOverflowEnabled = true,
  }: {
    parentMessageId?: string;
    actionMetadata?: Message["actionMetadata"];
    attachments?: Message["attachments"];
    locale?: Locale;
    topbarOverflowEnabled?: boolean;
  } = {},
) {
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useServerStore } = await import("../src/store/serverStore");

  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  });
  useServerStore.setState({ current: makeServer(), members: [] });
  if (actionMetadata?.kind === "action-card") {
    useChannelStore.setState({ channels: [makeChannel()], dmChannels: [] });
  }
  setServerFeatureFlagForTests(
    "server-1",
    TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
    topbarOverflowEnabled,
  );

  return render(
    <MessageTimelinePreserveViewportContext.Provider value={() => { preserveViewportRequests += 1; }}>
      <MessageTimelineKeepMessageVisibleContext.Provider value={(messageId) => { keepVisibleRequests.push(messageId); }}>
        <TestIntlProvider locale={locale}>
          <MemoryRouter>
            <MessageItem
              message={makeMessage(id, actionMetadata, attachments)}
              mentionMap={new Map()}
              channels={[]}
              parentMessageId={parentMessageId}
            />
          </MemoryRouter>
        </TestIntlProvider>
      </MessageTimelineKeepMessageVisibleContext.Provider>
    </MessageTimelinePreserveViewportContext.Provider>,
  );
}

beforeEach(() => {
  renderedContentHeight = 0;
  scrollHeightReadCount = 0;
  preserveViewportRequests = 0;
  keepVisibleRequests = [];
  TestResizeObserver.instances.clear();
  TestResizeObserver.emitOnObserve = true;
  __resetMessageContentCollapseStateForTests();
  originalResizeObserver = globalThis.ResizeObserver;
  originalWindowResizeObserver = window.ResizeObserver;
  globalThis.ResizeObserver = TestResizeObserver;
  window.ResizeObserver = TestResizeObserver;
  originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (this instanceof HTMLElement && this.dataset.messageCollapsibleMeasure === "true") {
        scrollHeightReadCount += 1;
        return renderedContentHeight;
      }
      return 0;
    },
  });
});

afterEach(() => {
  cleanup();
  __resetMessageContentCollapseStateForTests();
  if (originalResizeObserver) {
    globalThis.ResizeObserver = originalResizeObserver;
  } else {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  }
  if (originalWindowResizeObserver) {
    window.ResizeObserver = originalWindowResizeObserver;
  } else {
    delete (window as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  }
  if (originalScrollHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeightDescriptor);
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  }
  useChannelStore.setState({ channels: [], dmChannels: [] });
  resetServerFeatureFlagsForTests();
});

test("short rendered messages stay fully visible without disclosure chrome", async () => {
  renderedContentHeight = 180;
  const view = await renderMessage("short-message");

  const content = view.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  const root = view.container.querySelector<HTMLElement>("[data-message-collapsible]");
  assert.ok(root);
  assert.ok(content);
  assert.equal(root.dataset.messageCollapsible, "false");
  assert.equal(content.dataset.messageCollapsed, "false");
  assert.equal(content.style.maxHeight, "");
  assert.equal(content.className, "");
  assert.equal(screen.queryByRole("button", { name: "Show more" }), null);
});

test("the exact rendered-height boundary stays expanded", async () => {
  renderedContentHeight = 320;
  const view = await renderMessage("boundary-message");

  const content = view.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.ok(content);
  assert.equal(content.dataset.messageCollapsed, "false");
  assert.equal(screen.queryByRole("button", { name: "Show more" }), null);
});

test("unmeasured long content is clipped on its first committed frame without forcing per-row layout reads", () => {
  renderedContentHeight = 640;
  TestResizeObserver.emitOnObserve = false;
  const view = render(
    <TestIntlProvider>
      <CollapsibleMessageContent messageId="pending-long-message" disabled={false}>
        <a href="https://example.com/detail">detail</a>
      </CollapsibleMessageContent>
    </TestIntlProvider>,
  );

  const root = view.container.querySelector<HTMLElement>("[data-message-collapsible]");
  const content = view.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.ok(root);
  assert.ok(content);
  assert.equal(root.dataset.messageCollapseMeasurement, "pending");
  assert.equal(root.dataset.messageCollapsible, "false");
  assert.equal(content.dataset.messageCollapsed, "true");
  assert.equal(content.style.maxHeight, "320px");
  assert.match(content.className, /overflow-clip/);
  assert.equal(screen.queryByRole("button", { name: "Show more" }), null);
  assert.equal(scrollHeightReadCount, 0);

  act(() => TestResizeObserver.emitAll());

  assert.equal(root.dataset.messageCollapseMeasurement, "complete");
  assert.equal(root.dataset.messageCollapsible, "true");
  assert.equal(content.dataset.messageCollapsed, "true");
  assert.equal(content.style.maxHeight, "320px");
  assert.ok(screen.getByRole("button", { name: "Show more" }));
  assert.equal(scrollHeightReadCount, 0);
});

test("an optimistic long message resolves its final collapsed height before paint and carries it across persistence", () => {
  renderedContentHeight = 640;
  const parentSawReservedToggleSpace: boolean[] = [];
  function OptimisticLongMessage() {
    const rootRef = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
      parentSawReservedToggleSpace.push(
        Boolean(rootRef.current?.querySelector("[data-message-content-toggle-placeholder='true']")),
      );
    }, []);
    return (
      <div ref={rootRef}>
        <CollapsibleMessageContent
          messageId="optimistic-message-1"
          measurementKey="random-message-1"
          measureBeforePaint
          disabled={false}
        >
          <span>new outgoing long content</span>
        </CollapsibleMessageContent>
      </div>
    );
  }
  const optimistic = render(
    <TestIntlProvider>
      <OptimisticLongMessage />
    </TestIntlProvider>,
  );

  const optimisticRoot = optimistic.container.querySelector<HTMLElement>("[data-message-collapsible]");
  const optimisticContent = optimistic.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.ok(optimisticRoot);
  assert.ok(optimisticContent);
  assert.equal(optimisticRoot.dataset.messageCollapseMeasurement, "complete");
  assert.equal(optimisticRoot.dataset.messageCollapsible, "true");
  assert.equal(optimisticContent.dataset.messageCollapsed, "true");
  assert.equal(optimisticContent.style.maxHeight, "320px");
  assert.ok(screen.getByRole("button", { name: "Show more" }));
  assert.deepEqual(parentSawReservedToggleSpace, [true]);
  assert.equal(optimistic.container.querySelector("[data-message-content-toggle-placeholder='true']"), null);
  assert.equal(scrollHeightReadCount, 1);

  optimistic.unmount();
  const persisted = render(
    <TestIntlProvider>
      <CollapsibleMessageContent
        messageId="persisted-message-1"
        measurementKey="random-message-1"
        disabled={false}
      >
        <span>new outgoing long content</span>
      </CollapsibleMessageContent>
    </TestIntlProvider>,
  );

  const persistedRoot = persisted.container.querySelector<HTMLElement>("[data-message-collapsible]");
  const persistedContent = persisted.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.ok(persistedRoot);
  assert.ok(persistedContent);
  assert.equal(persistedRoot.dataset.messageCollapseMeasurement, "complete");
  assert.equal(persistedRoot.dataset.messageCollapsible, "true");
  assert.equal(persistedContent.dataset.messageCollapsed, "true");
  assert.equal(persistedContent.style.maxHeight, "320px");
  assert.ok(screen.getByRole("button", { name: "Show more" }));
  assert.equal(scrollHeightReadCount, 1);
});

test("an optimistic short message reserves append height and removes disclosure space before paint", () => {
  renderedContentHeight = 180;
  const parentSawReservedToggleSpace: boolean[] = [];
  function OptimisticShortMessage() {
    const rootRef = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
      parentSawReservedToggleSpace.push(
        Boolean(rootRef.current?.querySelector("[data-message-content-toggle-placeholder='true']")),
      );
    }, []);
    return (
      <div ref={rootRef}>
        <CollapsibleMessageContent
          messageId="optimistic-short-message"
          measurementKey="random-short-message"
          measureBeforePaint
          disabled={false}
        >
          <span>short outgoing content</span>
        </CollapsibleMessageContent>
      </div>
    );
  }

  const view = render(
    <TestIntlProvider>
      <OptimisticShortMessage />
    </TestIntlProvider>,
  );

  const root = view.container.querySelector<HTMLElement>("[data-message-collapsible]");
  const content = view.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.ok(root);
  assert.ok(content);
  assert.equal(root.dataset.messageCollapseMeasurement, "complete");
  assert.equal(root.dataset.messageCollapsible, "false");
  assert.equal(content.dataset.messageCollapsed, "false");
  assert.equal(content.style.maxHeight, "");
  assert.deepEqual(parentSawReservedToggleSpace, [true]);
  assert.equal(view.container.querySelector("[data-message-content-toggle-placeholder='true']"), null);
  assert.equal(screen.queryByRole("button", { name: "Show more" }), null);
  assert.equal(scrollHeightReadCount, 1);
});

test("long channel and thread messages collapse by rendered height and remember expansion for the session", async () => {
  renderedContentHeight = 640;
  const channelView = await renderMessage("long-message");

  const content = channelView.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  const root = channelView.container.querySelector<HTMLElement>("[data-message-collapsible]");
  assert.ok(root);
  assert.ok(content);
  assert.equal(root.dataset.messageCollapsible, "true");
  assert.equal(content.dataset.messageCollapsed, "true");
  assert.equal(content.style.maxHeight, "320px");
  assert.match(content.className, /overflow-clip/);

  const showMore = screen.getByRole("button", { name: "Show more" });
  assert.equal(showMore.getAttribute("aria-expanded"), "false");
  fireEvent.click(showMore);
  assert.equal(preserveViewportRequests, 1);
  assert.equal(content.dataset.messageCollapsed, "false");
  assert.equal(content.style.maxHeight, "");
  assert.equal(content.className, "");
  assert.equal(screen.getByRole("button", { name: "Collapse" }).getAttribute("aria-expanded"), "true");

  channelView.unmount();
  const threadView = await renderMessage("long-message", "thread-parent");
  const rememberedContent = threadView.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.ok(rememberedContent);
  assert.equal(rememberedContent.dataset.messageCollapsed, "false");
  assert.equal(screen.getByRole("button", { name: "Collapse" }).getAttribute("aria-expanded"), "true");

  fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
  assert.deepEqual(keepVisibleRequests, ["long-message"]);
  assert.equal(rememberedContent.dataset.messageCollapsed, "true");
  threadView.unmount();

  const collapsedAgain = await renderMessage("long-message");
  assert.equal(
    collapsedAgain.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']")?.dataset.messageCollapsed,
    "true",
  );
  assert.ok(screen.getByRole("button", { name: "Show more" }));
});

test("collapsed long messages keep the attachments section outside the clipped content", async () => {
  renderedContentHeight = 640;
  const view = await renderMessage("long-message-with-attachment", {
    attachments: [{
      id: "optimistic-att-evidence",
      filename: "evidence.txt",
      mimeType: "text/plain",
      sizeBytes: 128,
    }],
  });

  const collapsibleContent = view.container.querySelector<HTMLElement>(
    "[data-message-collapsible-content='true']",
  );
  const attachment = screen.getByText("evidence.txt");
  assert.ok(collapsibleContent);
  assert.equal(collapsibleContent.dataset.messageCollapsed, "true");
  assert.ok(screen.getByRole("button", { name: "Show more" }));
  assert.equal(
    collapsibleContent.contains(attachment),
    false,
    "attachments must not be descendants of the max-height/overflow-hidden region",
  );
  assert.equal(attachment.closest("[data-message-collapsible-content='true']"), null);
});

test("share-image clone expands the full message without changing the collapsed live row", async () => {
  renderedContentHeight = 640;
  await renderMessage("share-image-long-message");

  const liveRow = document.getElementById("message-share-image-long-message");
  const liveContent = liveRow?.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.ok(liveRow);
  assert.ok(liveContent);
  assert.equal(liveContent.dataset.messageCollapsed, "true");
  assert.equal(liveContent.style.maxHeight, "320px");
  assert.match(liveContent.className, /overflow-clip/);
  assert.ok(liveRow.querySelector("[data-message-content-toggle]"));

  const clone = liveRow.cloneNode(true) as HTMLElement;
  expandClonedMessageContentForScreenshot(clone);

  const exportedContent = clone.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.ok(exportedContent);
  assert.equal(exportedContent.dataset.messageCollapsed, "false");
  assert.equal(exportedContent.style.maxHeight, "");
  assert.doesNotMatch(exportedContent.className, /overflow-clip/);
  assert.equal(clone.querySelector("[data-message-content-toggle]"), null);
  assert.equal(clone.querySelector("[data-message-content-toggle-placeholder]"), null);
  assert.equal(clone.querySelector("[data-message-collapse-fade]"), null);
  assert.match(exportedContent.textContent ?? "", /Detailed evidence/);

  // Export normalization is clone-only: the chat row stays folded exactly as
  // the user left it, including the same disclosure control.
  assert.equal(liveContent.dataset.messageCollapsed, "true");
  assert.equal(liveContent.style.maxHeight, "320px");
  assert.match(liveContent.className, /overflow-clip/);
  assert.ok(liveRow.querySelector("[data-message-content-toggle]"));
});

test("channel collapse preference OFF renders long messages fully expanded without disclosure chrome", async () => {
  renderedContentHeight = 640;
  useChannelStore.setState({
    channels: [makeChannel({ collapseLongMessages: false, displayPrefsVersion: 1 })],
    dmChannels: [],
  });
  const view = await renderMessage("pref-off-long-message");

  assert.equal(view.container.querySelector("[data-message-collapsible]"), null);
  assert.equal(screen.queryByRole("button", { name: "Show more" }), null);
  assert.ok(screen.getByRole("link", { name: "detail" }));
});

test("channel collapse preference ON keeps long messages collapsed behind the disclosure", async () => {
  renderedContentHeight = 640;
  useChannelStore.setState({
    channels: [makeChannel({ collapseLongMessages: true, displayPrefsVersion: 2 })],
    dmChannels: [],
  });
  const view = await renderMessage("pref-on-long-message");

  const content = view.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.ok(content);
  assert.equal(content.dataset.messageCollapsed, "true");
  assert.equal(content.style.maxHeight, "320px");
  assert.ok(screen.getByRole("button", { name: "Show more" }));
});

test("flag off ignores a persisted channel expansion preference and restores legacy collapsing", async () => {
  renderedContentHeight = 640;
  useChannelStore.setState({
    channels: [makeChannel({ collapseLongMessages: false, displayPrefsVersion: 1 })],
    dmChannels: [],
  });
  const view = await renderMessage("flag-off-channel-long-message", {
    topbarOverflowEnabled: false,
  });

  const content = view.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.equal(content?.dataset.messageCollapsed, "true");
  assert.ok(screen.getByRole("button", { name: "Show more" }));
});

test("flag off ignores a persisted DM expansion preference and restores legacy collapsing", async () => {
  renderedContentHeight = 640;
  useChannelStore.setState({
    channels: [],
    dmChannels: [makeChannel({ type: "dm", collapseLongMessages: false, displayPrefsVersion: 1 })],
  });
  const view = await renderMessage("flag-off-dm-long-message", {
    topbarOverflowEnabled: false,
  });

  const content = view.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.equal(content?.dataset.messageCollapsed, "true");
  assert.ok(screen.getByRole("button", { name: "Show more" }));
});

test("flipping the channel collapse preference ON at runtime re-measures and collapses the long message", async () => {
  renderedContentHeight = 640;
  useChannelStore.setState({
    channels: [makeChannel({ collapseLongMessages: false, displayPrefsVersion: 1 })],
    dmChannels: [],
  });
  const view = await renderMessage("runtime-toggle-long-message");

  // Sanity: OFF renders fully expanded with no measurement wrapper.
  assert.equal(view.container.querySelector("[data-message-collapsible]"), null);

  // Flip the pref ON the same way the socket/settings path applies it.
  act(() => {
    useChannelStore.getState().setMessageDisplayPrefsState("channel-1", {
      collapseLongMessages: true,
      prefsVersion: 2,
    });
  });
  act(() => TestResizeObserver.emitAll());

  const root = view.container.querySelector("[data-message-collapsible='true']");
  assert.ok(root, "wrapper must re-measure after the runtime OFF->ON flip");
  assert.equal(root.getAttribute("data-message-collapse-measurement"), "complete");
  const content = view.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.equal(content?.dataset.messageCollapsed, "true");
  assert.equal(content?.style.maxHeight, "320px");
  assert.ok(screen.getByRole("button", { name: "Show more" }));
});

test("keyboard focus entering clipped content expands it before interaction", async () => {
  renderedContentHeight = 640;
  const view = await renderMessage("focus-message");

  const content = view.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.ok(content);
  const hiddenLink = screen.getByRole("link", { name: "detail" });
  content.getBoundingClientRect = () => ({ bottom: 320 }) as DOMRect;
  hiddenLink.getBoundingClientRect = () => ({ bottom: 500 }) as DOMRect;

  fireEvent.focus(hiddenLink);

  assert.equal(content.dataset.messageCollapsed, "false");
  assert.equal(screen.getByRole("button", { name: "Collapse" }).getAttribute("aria-expanded"), "true");

  content.getBoundingClientRect = () => ({ bottom: 320 }) as DOMRect;
  hiddenLink.getBoundingClientRect = () => ({ bottom: 500 }) as DOMRect;
  fireEvent.focus(hiddenLink);
  assert.equal(content.dataset.messageCollapsed, "false");
});

test("keyboard focus at the visible boundary does not expand clipped content", async () => {
  renderedContentHeight = 640;
  const view = await renderMessage("visible-focus-message");

  const content = view.container.querySelector<HTMLElement>("[data-message-collapsible-content='true']");
  assert.ok(content);
  const visibleLink = screen.getByRole("link", { name: "detail" });
  content.getBoundingClientRect = () => ({ bottom: 320 }) as DOMRect;
  visibleLink.getBoundingClientRect = () => ({ bottom: 320 }) as DOMRect;

  fireEvent.focus(visibleLink);

  assert.equal(content.dataset.messageCollapsed, "true");
  assert.ok(screen.getByRole("button", { name: "Show more" }));
});

test("late content growth is remeasured and the observer disconnects on unmount", async () => {
  renderedContentHeight = 180;
  const view = await renderMessage("late-growth-message");
  assert.equal(TestResizeObserver.instances.size, 1);
  assert.equal(TestResizeObserver.activeObservedCount(), 1);
  assert.equal(screen.queryByRole("button", { name: "Show more" }), null);

  renderedContentHeight = 640;
  act(() => TestResizeObserver.emitAll());

  assert.ok(screen.getByRole("button", { name: "Show more" }));
  view.unmount();
  assert.equal(TestResizeObserver.instances.size, 0);
  assert.equal(TestResizeObserver.activeObservedCount(), 0);
});

test("English fallback labels work without an Intl provider", async () => {
  renderedContentHeight = 640;
  render(
    <CollapsibleMessageContent messageId="fallback-message" disabled={false}>
      <a href="https://example.com">detail</a>
    </CollapsibleMessageContent>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  assert.ok(screen.getByRole("button", { name: "Collapse" }));
});

test("Chinese disclosure labels come from the active message catalog", async () => {
  renderedContentHeight = 640;
  await renderMessage("zh-message", { locale: "zh-cn" });

  fireEvent.click(screen.getByRole("button", { name: "展开全文" }));
  assert.ok(screen.getByRole("button", { name: "收起" }));
});

test("action cards stay fully interactive instead of entering message collapse", async () => {
  renderedContentHeight = 640;
  await renderMessage("action-message", {
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
  });

  assert.equal(document.querySelector("[data-message-collapsible]"), null);
  assert.equal(screen.queryByRole("button", { name: "Show more" }), null);
  assert.ok(screen.getByRole("button", { name: "Approve Login" }));
});

test("forwarded bundles keep only their card-level disclosure instead of nesting message collapse", async () => {
  renderedContentHeight = 640;
  await renderMessage("forwarded-message", {
    actionMetadata: {
      kind: "forwarded-bundle",
      forwardedItems: [{
        sourceMessageId: "source-message-1",
        sourceAuthorSnapshot: {
          type: "user",
          id: "source-user-1",
          name: "Source User",
        },
        contentSnapshot: "Forwarded detail ".repeat(40),
      }],
    },
  });

  assert.equal(document.querySelector("[data-message-collapsible]"), null);
  assert.equal(screen.queryByRole("button", { name: "Show more" }), null);
  assert.ok(screen.getByTestId("forwarded-bundle-card"));
  assert.ok(screen.getByRole("button", { name: "View all 1 message" }));
});

test("mounted rows share one observer and avoid initial scrollHeight layout reads", () => {
  renderedContentHeight = 640;

  render(
    <TestIntlProvider>
      {Array.from({ length: 12 }, (_, index) => (
        <CollapsibleMessageContent key={index} messageId={`cardinality-${index}`} disabled={false}>
          <a href={`https://example.com/${index}`}>detail {index}</a>
        </CollapsibleMessageContent>
      ))}
    </TestIntlProvider>,
  );

  assert.equal(TestResizeObserver.instances.size, 1);
  assert.equal(TestResizeObserver.activeObservedCount(), 12);
  assert.equal(scrollHeightReadCount, 0);
  assert.equal(screen.getAllByRole("button", { name: "Show more" }).length, 12);
});

test("append and locale changes do not commit old non-overflow rows", () => {
  const renderCounts = new Map<string, number>();
  const Row = memo(function Row({ id }: { id: string }) {
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    return (
      <CollapsibleMessageContent messageId={id} disabled={false}>
        <a href={`https://example.com/${id}`}>detail {id}</a>
      </CollapsibleMessageContent>
    );
  });
  function List({ ids, locale = "en" }: { ids: string[]; locale?: Locale }) {
    return (
      <TestIntlProvider locale={locale}>
        {ids.map((id) => (
          <Row key={id} id={id} />
        ))}
      </TestIntlProvider>
    );
  }

  renderedContentHeight = 180;
  const view = render(<List ids={["row-1", "row-2", "row-3"]} />);
  assert.deepEqual(Object.fromEntries(renderCounts), { "row-1": 1, "row-2": 1, "row-3": 1 });
  assert.equal(scrollHeightReadCount, 0);

  view.rerender(<List ids={["row-1", "row-2", "row-3", "row-4"]} />);
  assert.deepEqual(Object.fromEntries(renderCounts), { "row-1": 1, "row-2": 1, "row-3": 1, "row-4": 1 });

  view.rerender(<List ids={["row-1", "row-2", "row-3", "row-4"]} locale="zh-cn" />);
  assert.deepEqual(Object.fromEntries(renderCounts), { "row-1": 1, "row-2": 1, "row-3": 1, "row-4": 1 });

  act(() => TestResizeObserver.emitAll(180));
  assert.deepEqual(Object.fromEntries(renderCounts), { "row-1": 1, "row-2": 1, "row-3": 1, "row-4": 1 });
});

test("expanded message memory is pruned so long sessions stay bounded", () => {
  renderedContentHeight = 640;
  const messageIds = Array.from({ length: MESSAGE_CONTENT_EXPANSION_CACHE_LIMIT + 3 }, (_, index) => `expanded-${index}`);
  const view = render(
    <TestIntlProvider>
      {messageIds.map((id) => (
        <CollapsibleMessageContent key={id} messageId={id} disabled={false}>
          <a href={`https://example.com/${id}`}>detail {id}</a>
        </CollapsibleMessageContent>
      ))}
    </TestIntlProvider>,
  );

  for (const button of screen.getAllByRole("button", { name: "Show more" })) {
    fireEvent.click(button);
  }
  assert.equal(__getExpandedMessageContentCountForTests(), MESSAGE_CONTENT_EXPANSION_CACHE_LIMIT);

  view.unmount();
  cleanup();
  render(
    <TestIntlProvider>
      <CollapsibleMessageContent messageId={messageIds[0]} disabled={false}>
        <a href="https://example.com/first">detail first</a>
      </CollapsibleMessageContent>
      <CollapsibleMessageContent messageId={messageIds.at(-1) ?? ""} disabled={false}>
        <a href="https://example.com/last">detail last</a>
      </CollapsibleMessageContent>
    </TestIntlProvider>,
  );

  const [firstContent, lastContent] = Array.from(
    document.querySelectorAll<HTMLElement>("[data-message-collapsible-content='true']"),
  );
  assert.equal(firstContent?.dataset.messageCollapsed, "true");
  assert.equal(lastContent?.dataset.messageCollapsed, "false");
});
