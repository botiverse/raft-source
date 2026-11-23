import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { MemoryRouter } from "react-router-dom";

import { ThreadPanelHeader } from "../ThreadPanelHeader";
import { resolveThreadHeaderOriginal, threadOriginalFirstLine } from "../threadHeaderTitle";
import type { ThreadHeaderOriginal } from "../threadHeaderTitle";
import { openThreadParentInConversation } from "../threadParentConversation";
import { useThreadParentOutOfView } from "../useThreadParentOutOfView";
import { useMessageStore } from "../../../store/messageStore";
import type { Message } from "../../../store/messageStore";
import { useRowPlanStore } from "../../../components/layout/rowPlanStore";
import type { Channel } from "../../../store/channelStore";
import { TestIntlProvider } from "../../../../tests/helpers/intl";

// #proj-chat:#31 v3 (raft-design conversation.md, Threads): once the message a thread started from scrolls out of
// view, the head's title names it; the place name and ⋯ View in channel locate it in its conversation.

const CHANNEL_ID = "ch-design";
const PARENT_ID = "msg-root";
const CHANNEL_PATH = `/s/acme/channel/${CHANNEL_ID}`;
const ORIGINAL: ThreadHeaderOriginal = { state: "shown", sender: "Juno", text: "Can we ship the new header on Friday?" };
const CHANNEL = { id: CHANNEL_ID, name: "chat-design", type: "channel" } as unknown as Channel;

/** A controllable IntersectionObserver: the test says when the origin row leaves or comes back. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets: Element[] = [];
  readonly root: Element | Document | null;
  disconnected = false;
  constructor(private readonly callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.root = options?.root ?? null;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) { this.targets.push(target); }
  unobserve() {}
  disconnect() { this.disconnected = true; }
  takeRecords() { return []; }
  /** As a browser does for a target taken out of the document: not intersecting, unless the observer let it go. */
  emitDetached() {
    const target = this.targets[0];
    if (this.disconnected || !target || target.isConnected) return;
    this.callback([{ isIntersecting: false, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  emit(isIntersecting: boolean) {
    const target = this.targets[0]!;
    this.callback([{ isIntersecting, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
const liveObserver = () => FakeIntersectionObserver.instances.filter((io) => !io.disconnected).at(-1)!;

let realIntersectionObserver: typeof IntersectionObserver;
let realMatchMedia: typeof window.matchMedia | undefined;
function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  realIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  window.IntersectionObserver = globalThis.IntersectionObserver;
  realMatchMedia = window.matchMedia;
  setReducedMotion(false);
  useMessageStore.setState({ highlightedMessageId: null, highlightNonce: 0, channelMessages: { [CHANNEL_ID]: [{ id: PARENT_ID, channelId: CHANNEL_ID } as Message] } });
});
afterEach(() => {
  cleanup();
  globalThis.IntersectionObserver = realIntersectionObserver;
  window.IntersectionObserver = realIntersectionObserver;
  if (realMatchMedia) window.matchMedia = realMatchMedia;
  document.querySelectorAll('[data-testid="thread-layout-container"]').forEach((node) => node.remove());
  useRowPlanStore.setState({ threadExpand: null });
});

/** The head over a list holding the origin row, wired as AuthenticatedThreadPanel wires them. */
function Harness({ original, navigate, onJumpToStart, pathname = CHANNEL_PATH, startWithPlaceholder = false }: {
  original: ThreadHeaderOriginal | null;
  navigate?: (to: string, options?: { replace?: boolean }) => void;
  onJumpToStart?: () => void;
  pathname?: string;
  /** Start as the replies load: the parent in the placeholder ScrollArea, which the timeline later replaces. */
  startWithPlaceholder?: boolean;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const [rowMounted, setRowMounted] = useState(true);
  const [placeholder, setPlaceholder] = useState(startWithPlaceholder);
  const outOfView = useThreadParentOutOfView(regionRef, true, PARENT_ID);
  const open = useCallback(() => openThreadParentInConversation({
    original,
    isDesktop: true,
    presentation: "side",
    currentPathname: pathname,
    parentChannelId: CHANNEL_ID,
    parentMessageId: PARENT_ID,
    parentRouteKind: "channel",
    serverSlug: "acme",
    navigate: navigate ?? (() => {}),
    nextFrame: (callback) => callback(),
  }), [navigate, original, pathname]);
  const jump = useCallback(async () => { onJumpToStart?.(); }, [onJumpToStart]);
  const noop = useCallback(() => {}, []);
  const messages = useMemo<Message[]>(() => [], []);
  return (
    <>
      <ThreadPanelHeader
        headerLeading={null}
        headerDrag={undefined}
        presentation="side"
        mobileBackHandler={noop}
        handleClose={noop}
        closeButtonClassName="flex"
        jumpToThreadStart={jump}
        parentChannelId={CHANNEL_ID}
        parentMessageId={PARENT_ID}
        threadChannelId={null}
        parentChannel={CHANNEL}
        messages={messages}
        historyLimited={false}
        hiddenThreadHistory={null}
        displayedParentThreadSummary={{ threadChannelId: "th-1", replyCount: 68, lastReplyAt: null, participantIds: [], unreadCount: 0, firstUnreadMessageId: null }}
        loading={false}
        repliesLoadFailed={false}
        handleOpenParentChannelAction={open}
        handleOpenThreadSearch={noop}
        allowExpand={false}
        original={original}
        originalOutOfView={outOfView}
      />
      <div ref={regionRef}>
        {placeholder ? (
          // ThreadPanelReplies while the replies load: the parent and a placeholder in a ScrollArea.
          <div key="placeholder" data-testid="thread-replies-placeholder-scroll">
            <div data-testid="thread-panel-parent" data-message-id={PARENT_ID} />
            <div>loading</div>
          </div>
        ) : (
          // The timeline: its rows (raft-ui VirtualList) hold the parent's row among them.
          <div key="timeline" data-testid="thread-message-scroller">
            <div data-slot="virtual-list-items">
              <div data-slot="virtual-list-visible-items">
                {rowMounted ? <div><div data-testid="thread-panel-parent" data-message-id={PARENT_ID} /></div> : null}
                <div>reply</div>
              </div>
            </div>
          </div>
        )}
      </div>
      <button type="button" data-testid="unmount-row" onClick={() => setRowMounted(false)} />
      <button type="button" data-testid="replies-loaded" onClick={() => setPlaceholder(false)} />
    </>
  );
}

function renderHead(props: Parameters<typeof Harness>[0]) {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[CHANNEL_PATH]}>
        <Harness {...props} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

const title = () => screen.getByTestId("thread-scroll-to-top");
const swapped = () => title().querySelector("[data-title-swapped]")?.getAttribute("data-title-swapped");

test("the title names the original once it scrolls fully out of view, and is Thread again when it comes back", () => {
  renderHead({ original: ORIGINAL });
  assert.equal(swapped(), "false");
  assert.equal(title().textContent?.includes("Thread"), true);
  const io = liveObserver();
  assert.ok(io.root === screen.getByTestId("thread-message-scroller"), "observed in the thread's scroller");
  assert.ok(io.targets[0] === screen.getByTestId("thread-panel-parent"), "the origin row is observed");

  act(() => io.emit(false));
  assert.equal(swapped(), "true");
  assert.equal(screen.getByTestId("thread-title-original").getAttribute("aria-hidden"), null, "the shown face is read");
  assert.equal(screen.getByTestId("thread-title-default").getAttribute("aria-hidden"), "true", "the other is hidden");
  // The second line is the same in both states.
  assert.equal(screen.getByTestId("thread-header-channel-link").textContent, "#chat-design");
  assert.match(screen.getByTestId("thread-header-reply-count").textContent ?? "", /68 replies/);

  act(() => io.emit(true));
  assert.equal(swapped(), "false");
  assert.equal(screen.getByTestId("thread-title-original").getAttribute("aria-hidden"), "true");
  assert.equal(screen.getByTestId("thread-title-default").getAttribute("aria-hidden"), null);
});

test("when the timeline replaces the placeholder, the parent's new row is the one watched: the title stays Thread", async () => {
  renderHead({ original: ORIGINAL, startWithPlaceholder: true });
  const first = liveObserver();
  assert.ok(first.root === screen.getByTestId("thread-replies-placeholder-scroll"), "first watched in the placeholder");
  fireEvent.click(screen.getByTestId("replies-loaded"));
  await act(async () => { await Promise.resolve(); });
  // The old row left the document; an observer still holding it would now say "not intersecting".
  act(() => FakeIntersectionObserver.instances.forEach((io) => io.emitDetached()));
  const now = liveObserver();
  assert.ok(now.targets[0] === screen.getByTestId("thread-panel-parent"), "the timeline's row is observed");
  assert.ok(now.root === screen.getByTestId("thread-message-scroller"), "in the timeline's scroller");
  act(() => now.emit(true));
  assert.equal(swapped(), "false", "the parent is at the top: Thread");
});

test("an origin row the virtualized list unmounts counts as out of view", async () => {
  renderHead({ original: ORIGINAL });
  assert.equal(swapped(), "false");
  fireEvent.click(screen.getByTestId("unmount-row"));
  await act(async () => { await Promise.resolve(); });
  assert.equal(swapped(), "true");
});

test("the accessible name follows the words shown, after Thread", () => {
  renderHead({ original: ORIGINAL });
  assert.equal(title().getAttribute("aria-label"), null, "at the top the name is the word shown, Thread");
  assert.ok(screen.getByRole("button", { name: "Thread" }) === title(), "named Thread at the top");
  act(() => liveObserver().emit(false));
  const named = screen.getByRole("button", { name: "Thread: Juno: Can we ship the new header on Friday?" });
  assert.ok(named === title(), "the title button has that name");
  // Not a live region: the change isn't announced.
  assert.ok(title().closest("[aria-live]") === null, "no live region");
});

test("an agent sender is named as a reply's name is: no Agent badge, in the title or its name", () => {
  renderHead({ original: { ...ORIGINAL, sender: "Scout" } });
  act(() => liveObserver().emit(false));
  assert.equal(screen.getByTestId("thread-title-original").textContent, "Scout: Can we ship the new header on Friday?");
  assert.equal(title().getAttribute("aria-label"), "Thread: Scout: Can we ship the new header on Friday?");
});

test("selecting the title scrolls the thread back to the original, swapped or not", () => {
  let jumps = 0;
  renderHead({ original: ORIGINAL, onJumpToStart: () => { jumps += 1; } });
  fireEvent.click(title());
  act(() => liveObserver().emit(false));
  fireEvent.click(title());
  assert.equal(jumps, 2);
});

test("the place name locates the original in its conversation with the located highlight, again on each press", () => {
  renderHead({ original: ORIGINAL });
  fireEvent.click(screen.getByTestId("thread-header-channel-link"));
  assert.equal(useMessageStore.getState().highlightedMessageId, PARENT_ID);
  assert.equal(useMessageStore.getState().highlightNonce, 1);
  fireEvent.click(screen.getByTestId("thread-header-channel-link"));
  assert.equal(useMessageStore.getState().highlightNonce, 2, "a new nonce restarts the highlight");
});

test("⋯ View in channel locates the original the same way", async () => {
  renderHead({ original: ORIGINAL });
  fireEvent.click(screen.getByTestId("thread-overflow-trigger"));
  fireEvent.click(await screen.findByTestId("thread-overflow-view-in-channel"));
  assert.equal(useMessageStore.getState().highlightedMessageId, PARENT_ID);
  assert.equal(useMessageStore.getState().highlightNonce, 1);
});

test("away from its conversation, the place name opens the conversation's ?msg= route", () => {
  const to: string[] = [];
  renderHead({ original: ORIGINAL, pathname: "/s/acme/activity", navigate: (path) => { to.push(path); } });
  fireEvent.click(screen.getByTestId("thread-header-channel-link"));
  assert.deepEqual(to, [`${CHANNEL_PATH}?msg=${PARENT_ID}`]);
});

test("in Focus Mode the row is restored before the original is located", () => {
  const layout = document.createElement("div");
  layout.setAttribute("data-testid", "thread-layout-container");
  layout.setAttribute("data-thread-maximized", "true");
  document.body.append(layout);
  const order: string[] = [];
  useRowPlanStore.setState({ threadExpand: (expanded) => { order.push(`expand:${expanded}`); } });
  const unsubscribe = useMessageStore.subscribe((state) => { if (state.highlightedMessageId) order.push("located"); });
  renderHead({ original: ORIGINAL });
  fireEvent.click(screen.getByTestId("thread-header-channel-link"));
  unsubscribe();
  assert.deepEqual(order, ["expand:false", "located"]);
});

test("a deleted original: the title stays Thread with a descriptive name, and both ways in only open the conversation", async () => {
  const to: string[] = [];
  renderHead({ original: { state: "deleted" }, pathname: "/s/acme/activity", navigate: (path) => { to.push(path); } });
  act(() => liveObserver().emit(false));
  assert.equal(swapped(), "false", "nothing to name");
  assert.ok(screen.queryByTestId("thread-title-original") === null, "no original face");
  assert.equal(title().getAttribute("aria-label"), "Thread: original message deleted");
  fireEvent.click(screen.getByTestId("thread-header-channel-link"));
  fireEvent.click(screen.getByTestId("thread-overflow-trigger"));
  fireEvent.click(await screen.findByTestId("thread-overflow-view-in-channel"));
  assert.deepEqual(to, [CHANNEL_PATH, CHANNEL_PATH], "no ?msg=: nothing to locate");
  assert.equal(useMessageStore.getState().highlightedMessageId, null);
});

test("an original the person can't see: plain place name, no View in channel, a descriptive name", async () => {
  renderHead({ original: { state: "unavailable" } });
  act(() => liveObserver().emit(false));
  assert.equal(swapped(), "false");
  assert.equal(title().getAttribute("aria-label"), "Thread: can't view the original message");
  assert.ok(screen.queryByTestId("thread-header-channel-link") === null, "no place link");
  assert.ok(screen.getByTestId("thread-header-subtitle").querySelector("button, a") === null, "the place name is plain text");
  assert.match(screen.getByTestId("thread-header-subtitle").textContent ?? "", /#chat-design/);
  fireEvent.click(screen.getByTestId("thread-overflow-trigger"));
  await screen.findByTestId("thread-overflow-menu");
  assert.ok(screen.queryByTestId("thread-overflow-view-in-channel") === null, "no View in channel");
});

test("the faces cross-fade, and swap at once with reduced motion", () => {
  const { unmount } = renderHead({ original: ORIGINAL });
  assert.match(screen.getByTestId("thread-title-original").className, /transition-opacity/);
  assert.match(screen.getByTestId("thread-title-original").className, /duration-140/);
  unmount();
  setReducedMotion(true);
  renderHead({ original: ORIGINAL });
  assert.equal(title().querySelector("[data-title-motion]")?.getAttribute("data-title-motion"), "reduce");
  assert.doesNotMatch(screen.getByTestId("thread-title-original").className, /transition/);
  assert.doesNotMatch(screen.getByTestId("thread-title-default").className, /transition/);
  act(() => liveObserver().emit(false));
  assert.equal(swapped(), "true");
});

test("the original's first line: plain text, else what it holds", () => {
  const formatMessage = (({ id }: { id: string }, values?: { count?: number }) => `${id}:${values?.count ?? ""}`) as Parameters<typeof threadOriginalFirstLine>[1];
  assert.equal(threadOriginalFirstLine({ content: "**Ship** it @Kai\n\nsecond line" }, formatMessage), "Ship it @Kai");
  const file = (mimeType: string) => ({ id: mimeType, filename: "f", mimeType, sizeBytes: 1 });
  assert.equal(threadOriginalFirstLine({ content: "", attachments: [file("image/png"), file("image/jpeg")] }, formatMessage), "message.threadPanel.titleImage:");
  assert.equal(threadOriginalFirstLine({ content: "", attachments: [file("image/png"), file("application/pdf")] }, formatMessage), "message.threadPanel.titleFile:");
  // Who sent it isn't known: a neutral name, never "Agent".
  assert.deepEqual(
    resolveThreadHeaderOriginal({ parentMessage: { id: PARENT_ID, channelId: CHANNEL_ID, senderType: "agent", senderId: "a2", content: "Hi", createdAt: "" } as Message, unavailable: false, senderName: null, formatMessage }),
    { state: "shown", sender: "message.author.unknown:", text: "Hi" },
  );
  const parent = { id: PARENT_ID, channelId: CHANNEL_ID, senderType: "agent", senderId: "a1", content: "Daily check", createdAt: "" } as Message;
  assert.deepEqual(resolveThreadHeaderOriginal({ parentMessage: parent, unavailable: false, senderName: "Scout", formatMessage }), { state: "shown", sender: "Scout", text: "Daily check" });
  assert.deepEqual(resolveThreadHeaderOriginal({ parentMessage: { ...parent, deletedAt: "2026-11-17T00:00:00Z" }, unavailable: false, senderName: "Scout", formatMessage }), { state: "deleted" });
  assert.deepEqual(resolveThreadHeaderOriginal({ parentMessage: null, unavailable: true, senderName: null, formatMessage }), { state: "unavailable" });
});
