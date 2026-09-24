import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { createRef, useContext, useState } from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import MessageTimeline, {
  MessageTimelineKeepMessageVisibleContext,
  MessageTimelinePreserveViewportContext,
  recallPersistedScrollMessageId,
} from "../src/components/message/MessageTimeline";
import type {
  MessageTimelineHandle,
  MessageTimelineSource,
} from "../src/components/message/MessageTimeline";
import type { Message } from "../src/store/messageStore";

const SERIAL = { concurrency: false };

let intersectionCallback: IntersectionObserverCallback | null = null;
let observedTargets: Element[] = [];
let resizeCallbacks: ResizeObserverCallback[] = [];

globalThis.IntersectionObserver = class {
  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
  }

  observe(target: Element) { observedTargets.push(target); }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
} as typeof IntersectionObserver;

globalThis.ResizeObserver = class {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback);
  }

  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

globalThis.CSS = globalThis.CSS ?? {
  escape: (value: string) => String(value).replace(/["\\]/g, "\\$&"),
} as typeof CSS;

const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalScrollTo = Element.prototype.scrollTo;
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
const originalPerformanceNow = Object.getOwnPropertyDescriptor(performance, "now");

function makeMessage(id: string, seq: number): Message {
  return {
    id,
    seq,
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Ada",
    messageType: "chat",
    content: id,
    createdAt: new Date(2026, 6, 3, 0, 0, seq).toISOString(),
  };
}

function makeSource(
  messages: Message[],
  initialFocusMessageId: string | null = null,
  overrides: Partial<MessageTimelineSource> = {},
): MessageTimelineSource {
  return {
    messages,
    hasOlder: false,
    hasNewer: false,
    loading: false,
    loadOlder: () => {},
    loadNewer: () => {},
    initialFocusMessageId,
    ...overrides,
  };
}

function renderTimeline(
  source: MessageTimelineSource,
  ref?: RefObject<MessageTimelineHandle | null>,
  persistKey?: string,
) {
  return (
    <MessageTimeline
      ref={ref}
      source={source}
      renderItem={(message) => <div>{message.content}</div>}
      testId="focus-window-scroller"
      className="h-full"
      sparseAnchor="bottom"
      persistKey={persistKey}
    />
  );
}

test("explicit message expansion at the live tail preserves the reading viewport", SERIAL, async () => {
  let expanded = false;
  let scrollerNode: HTMLElement | null = null;

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset.testid === "focus-window-scroller"
        ? expanded ? 2320 : 1320
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    const requestedTop = typeof options === "number" ? options : options?.top ?? 0;
    const maxScrollTop = (expanded ? 2320 : 1320) - 500;
    (this as HTMLElement).scrollTop = Math.min(maxScrollTop, Math.max(0, requestedTop));
  };
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement;
    if (element.dataset.testid === "focus-window-scroller") {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} };
    }
    if (element.dataset.timelineMessageId === "expand-target") {
      const top = 600 - (scrollerNode?.scrollTop ?? 0);
      const height = expanded ? 1320 : 320;
      return { top, bottom: top + height, left: 0, right: 500, width: 500, height, x: 0, y: top, toJSON() {} };
    }
    return originalGetBoundingClientRect.call(this);
  };

  function ExpandAction() {
    const preserveViewport = useContext(MessageTimelinePreserveViewportContext);
    return <button type="button" onClick={() => preserveViewport?.()}>Expand message</button>;
  }

  const timelineRef = createRef<MessageTimelineHandle>();
  const view = render(
    <MessageTimeline
      ref={timelineRef}
      source={makeSource([makeMessage("expand-target", 1)])}
      renderItem={() => <ExpandAction />}
      testId="focus-window-scroller"
      className="h-full"
      sparseAnchor="bottom"
    />,
  );
  const scroller = view.getByTestId("focus-window-scroller");
  const row = view.container.querySelector<HTMLElement>("[data-timeline-message-id='expand-target']");
  scrollerNode = scroller;
  scroller.scrollTop = 820;
  assert.ok(row);
  const beforeTop = row.getBoundingClientRect().top;
  assert.equal(timelineRef.current?.isFollowingBottom(), true);

  fireEvent.click(view.getByRole("button", { name: "Expand message" }));
  expanded = true;
  await act(async () => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });

  assert.equal(row.getBoundingClientRect().top, beforeTop);
  assert.equal(scroller.scrollTop, 820);
  assert.equal(timelineRef.current?.isFollowingBottom(), false);
});

test("collapse reveal moves only a fully hidden clicked row", SERIAL, async () => {
  let expanded = true;
  let scrollerNode: HTMLElement | null = null;

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2500; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    const requestedTop = typeof options === "number" ? options : options?.top ?? 0;
    (this as HTMLElement).scrollTop = Math.min(2000, Math.max(0, requestedTop));
  };
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement;
    if (element.dataset.testid === "focus-window-scroller") {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} };
    }
    if (element.dataset.timelineMessageId === "collapse-target") {
      const top = 100 - (scrollerNode?.scrollTop ?? 0);
      const height = expanded ? 1280 : 320;
      return { top, bottom: top + height, left: 0, right: 500, width: 500, height, x: 0, y: top, toJSON() {} };
    }
    return originalGetBoundingClientRect.call(this);
  };

  function CollapseAction() {
    const keepMessageVisible = useContext(MessageTimelineKeepMessageVisibleContext);
    return <button type="button" onClick={() => keepMessageVisible?.("collapse-target")}>Collapse message</button>;
  }

  const view = render(
    <MessageTimeline
      source={makeSource([makeMessage("collapse-target", 1)])}
      renderItem={() => <CollapseAction />}
      testId="focus-window-scroller"
      className="h-full"
    />,
  );
  const scroller = view.getByTestId("focus-window-scroller");
  const row = view.container.querySelector<HTMLElement>("[data-timeline-message-id='collapse-target']");
  scrollerNode = scroller;
  assert.ok(row);

  scroller.scrollTop = 1000;
  await act(async () => {
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });
  assert.ok(row.getBoundingClientRect().bottom > 0);

  fireEvent.click(view.getByRole("button", { name: "Collapse message" }));
  expanded = false;
  await act(async () => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });
  assert.equal(scroller.scrollTop, 100);
  assert.equal(row.getBoundingClientRect().top, 0);

  expanded = true;
  scroller.scrollTop = 300;
  fireEvent.click(view.getByRole("button", { name: "Collapse message" }));
  expanded = false;
  await act(async () => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });
  assert.equal(scroller.scrollTop, 300);
  assert.equal(row.getBoundingClientRect().bottom, 120);
});

async function flushAnimationFrames(count = 8) {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

async function settleProgrammaticScroll() {
  await flushAnimationFrames();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await flushAnimationFrames();
}

afterEach(() => {
  cleanup();
  intersectionCallback = null;
  observedTargets = [];
  resizeCallbacks = [];
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  Element.prototype.scrollTo = originalScrollTo;
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
  if (originalPerformanceNow) Object.defineProperty(performance, "now", originalPerformanceNow);
});

test("duplicate resize observers apply one anchor compensation per layout", SERIAL, async () => {
  const timelineRef = createRef<MessageTimelineHandle>();
  let layoutDelta = 0;
  let scrollerNode: HTMLElement | null = null;

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement;
    if (element.dataset.testid === "focus-window-scroller") {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} };
    }
    if (element.dataset.messageId === "anchor") {
      const top = 280 + layoutDelta - (scrollerNode?.scrollTop ?? 0);
      return { top, bottom: top + 100, left: 0, right: 500, width: 500, height: 100, x: 0, y: top, toJSON() {} };
    }
    return originalGetBoundingClientRect.call(this);
  };

  const view = render(renderTimeline(makeSource([makeMessage("anchor", 1)]), timelineRef));
  const scroller = view.getByTestId("focus-window-scroller");
  scrollerNode = scroller;
  scroller.scrollTop = 300;
  timelineRef.current?.preserveAnchorOnNextLayoutChange();
  assert.equal(resizeCallbacks.length, 2, "the scroller and content observers share layout ownership");

  layoutDelta = 550;
  await act(async () => {
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
  });

  assert.equal(
    scroller.scrollTop,
    850,
    "both observers must converge on one +550px compensation instead of applying it twice",
  );
  const anchor = view.container.querySelector<HTMLElement>('[data-message-id="anchor"]');
  assert.ok(anchor);
  assert.equal(anchor.getBoundingClientRect().top, -20, "the same visual anchor must remain in place");
});

test("explicit thread-open anchor survives a delayed pre-open scroll frame", SERIAL, async () => {
  const timelineRef = createRef<MessageTimelineHandle>();
  let layoutDelta = 0;
  let scrollerNode: HTMLElement | null = null;

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement;
    if (element.dataset.testid === "focus-window-scroller") {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} };
    }
    if (element.dataset.messageId === "anchor") {
      const top = 280 + layoutDelta - (scrollerNode?.scrollTop ?? 0);
      return { top, bottom: top + 100, left: 0, right: 500, width: 500, height: 100, x: 0, y: top, toJSON() {} };
    }
    return originalGetBoundingClientRect.call(this);
  };

  const view = render(renderTimeline(makeSource([makeMessage("anchor", 1)]), timelineRef));
  const scroller = view.getByTestId("focus-window-scroller");
  scrollerNode = scroller;
  scroller.scrollTop = 300;

  // A prior scroll can leave MessageTimeline's anchor-refresh frame queued.
  // Thread-open then captures the correct pre-layout anchor synchronously,
  // but the old frame may flush after the width reflow and before either
  // ResizeObserver callback.
  fireEvent.scroll(scroller);
  timelineRef.current?.preserveAnchorOnNextLayoutChange();
  layoutDelta = 200;
  await act(async () => {
    await flushAnimationFrames(1);
  });
  await act(async () => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });

  assert.equal(
    scroller.scrollTop,
    500,
    "the explicit pre-open snapshot must win over a delayed generic scroll refresh",
  );
  const anchor = view.container.querySelector<HTMLElement>('[data-message-id="anchor"]');
  assert.ok(anchor);
  assert.equal(anchor.getBoundingClientRect().top, -20, "the thread width reflow must not move the reading row");
});

test("explicit thread-open anchor waits for the first layout observer before expiring", SERIAL, async () => {
  const timelineRef = createRef<MessageTimelineHandle>();
  let now = 100;
  let layoutDelta = 0;
  let scrollerNode: HTMLElement | null = null;

  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000 + layoutDelta; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement;
    if (element.dataset.testid === "focus-window-scroller") {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} };
    }
    if (element.dataset.messageId === "anchor") {
      const top = 280 + layoutDelta - (scrollerNode?.scrollTop ?? 0);
      return { top, bottom: top + 100, left: 0, right: 500, width: 500, height: 100, x: 0, y: top, toJSON() {} };
    }
    return originalGetBoundingClientRect.call(this);
  };

  const view = render(renderTimeline(makeSource([makeMessage("anchor", 1)]), timelineRef));
  const scroller = view.getByTestId("focus-window-scroller");
  scrollerNode = scroller;
  scroller.scrollTop = 300;

  timelineRef.current?.preserveAnchorOnNextLayoutChange();
  assert.equal(
    view.container.querySelector<HTMLElement>('[data-message-id="anchor"]')?.getBoundingClientRect().top,
    -20,
  );

  layoutDelta = 200;
  now = 1500;
  await act(async () => {
    fireEvent.scroll(scroller);
    await flushAnimationFrames(1);
  });
  assert.equal(
    view.container.querySelector<HTMLElement>('[data-message-id="anchor"]')?.getBoundingClientRect().top,
    180,
    "a delayed generic scroll refresh observes the shifted post-layout position before ResizeObserver",
  );

  await act(async () => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });

  assert.equal(
    scroller.scrollTop,
    500,
    "the pre-open anchor must survive until a layout observer has consumed it once",
  );
  assert.equal(
    view.container.querySelector<HTMLElement>('[data-message-id="anchor"]')?.getBoundingClientRect().top,
    -20,
  );
});

test("unconsumed thread-open anchor yields to synchronous user scroll ownership", SERIAL, async () => {
  const timelineRef = createRef<MessageTimelineHandle>();
  let now = 100;
  let layoutDelta = 0;
  let scrollerNode: HTMLElement | null = null;

  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000 + layoutDelta; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement;
    if (element.dataset.testid === "focus-window-scroller") {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} };
    }
    const id = element.dataset.timelineMessageId;
    if (id === "old-anchor" || id === "reading-anchor") {
      const top = (id === "old-anchor" ? 280 : 680 + layoutDelta) - (scrollerNode?.scrollTop ?? 0);
      return { top, bottom: top + 100, left: 0, right: 500, width: 500, height: 100, x: 0, y: top, toJSON() {} };
    }
    return originalGetBoundingClientRect.call(this);
  };

  const view = render(renderTimeline(makeSource([
    makeMessage("old-anchor", 1),
    makeMessage("reading-anchor", 2),
  ]), timelineRef));
  const scroller = view.getByTestId("focus-window-scroller");
  scrollerNode = scroller;
  await act(async () => {
    await settleProgrammaticScroll();
  });

  scroller.scrollTop = 300;
  timelineRef.current?.preserveAnchorOnNextLayoutChange();
  now = 1500;
  await act(async () => {
    fireEvent.wheel(scroller);
    scroller.scrollTop = 700;
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });

  const row = view.container.querySelector<HTMLElement>('[data-timeline-message-id="reading-anchor"]');
  assert.ok(row);
  assert.equal(row.getBoundingClientRect().top, -20);

  layoutDelta = 200;
  await act(async () => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });

  assert.equal(scroller.scrollTop, 900, "later layout must preserve the user's new reading row");
  assert.equal(row.getBoundingClientRect().top, -20);
});

test("newer explicit message jump supersedes expired unconsumed snapshot", SERIAL, async () => {
  const timelineRef = createRef<MessageTimelineHandle>();
  let now = 100;
  let layoutDelta = 0;
  let scrollerNode: HTMLElement | null = null;

  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000 + layoutDelta; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement;
    if (element.dataset.testid === "focus-window-scroller") {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} };
    }
    const id = element.dataset.timelineMessageId;
    if (id === "old-anchor" || id === "reading-anchor") {
      const top = (id === "old-anchor" ? 280 : 680 + layoutDelta) - (scrollerNode?.scrollTop ?? 0);
      return { top, bottom: top + 100, left: 0, right: 500, width: 500, height: 100, x: 0, y: top, toJSON() {} };
    }
    return originalGetBoundingClientRect.call(this);
  };

  const view = render(renderTimeline(makeSource([
    makeMessage("old-anchor", 1),
    makeMessage("reading-anchor", 2),
  ]), timelineRef));
  const scroller = view.getByTestId("focus-window-scroller");
  scrollerNode = scroller;
  await act(async () => {
    await settleProgrammaticScroll();
  });

  scroller.scrollTop = 300;
  timelineRef.current?.preserveAnchorOnNextLayoutChange();
  now = 1500;
  await act(async () => {
    Element.prototype.scrollIntoView = function scrollIntoView() { scroller.scrollTop = 700; };
    timelineRef.current?.scrollToMessage("reading-anchor");
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });

  const row = view.container.querySelector<HTMLElement>('[data-timeline-message-id="reading-anchor"]');
  assert.ok(row);
  assert.equal(row.getBoundingClientRect().top, -20);

  layoutDelta = 200;
  await act(async () => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });

  assert.equal(scroller.scrollTop, 900, "later layout must preserve the newer explicit message jump");
  assert.equal(row.getBoundingClientRect().top, -20);
});

test("explicit scroll-to-top supersedes expired unconsumed snapshot", SERIAL, async () => {
  const timelineRef = createRef<MessageTimelineHandle>();
  let now = 100;
  let layoutDelta = 0;
  let scrollerNode: HTMLElement | null = null;

  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000 + layoutDelta; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    const requestedTop = typeof options === "number" ? options : options?.top ?? 0;
    (this as HTMLElement).scrollTop = Math.max(0, requestedTop);
  };
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement;
    if (element.dataset.testid === "focus-window-scroller") {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} };
    }
    if (element.dataset.timelineMessageId === "top-anchor") {
      const top = 0 - (scrollerNode?.scrollTop ?? 0);
      return { top, bottom: top + 100, left: 0, right: 500, width: 500, height: 100, x: 0, y: top, toJSON() {} };
    }
    if (element.dataset.timelineMessageId === "old-anchor") {
      const top = 280 + layoutDelta - (scrollerNode?.scrollTop ?? 0);
      return { top, bottom: top + 100, left: 0, right: 500, width: 500, height: 100, x: 0, y: top, toJSON() {} };
    }
    return originalGetBoundingClientRect.call(this);
  };

  const view = render(renderTimeline(makeSource([
    makeMessage("top-anchor", 1),
    makeMessage("old-anchor", 2),
  ]), timelineRef));
  const scroller = view.getByTestId("focus-window-scroller");
  scrollerNode = scroller;
  await act(async () => {
    await settleProgrammaticScroll();
  });

  scroller.scrollTop = 300;
  timelineRef.current?.preserveAnchorOnNextLayoutChange();
  now = 1500;
  await act(async () => {
    timelineRef.current?.scrollToTop();
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });

  const row = view.container.querySelector<HTMLElement>('[data-timeline-message-id="top-anchor"]');
  assert.ok(row);
  assert.equal(scroller.scrollTop, 0);
  assert.equal(row.getBoundingClientRect().top, 0);

  layoutDelta = 200;
  await act(async () => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });

  assert.equal(scroller.scrollTop, 0, "later layout must preserve the newer explicit top jump");
  assert.equal(row.getBoundingClientRect().top, 0);
});

test("anchor capture ignores clipped message bodies that reuse a row id", SERIAL, async () => {
  const timelineRef = createRef<MessageTimelineHandle>();

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement;
    if (element.dataset.testid === "focus-window-scroller") {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} };
    }
    if (element.dataset.timelineMessageId === "clipped") {
      return { top: -1000, bottom: -500, left: 0, right: 500, width: 500, height: 500, x: 0, y: -1000, toJSON() {} };
    }
    if (element.dataset.innerMessageBody === "clipped") {
      return { top: -968, bottom: 400, left: 0, right: 500, width: 500, height: 1368, x: 0, y: -968, toJSON() {} };
    }
    if (element.dataset.timelineMessageId === "visible") {
      return { top: 100, bottom: 300, left: 0, right: 500, width: 500, height: 200, x: 0, y: 100, toJSON() {} };
    }
    return originalGetBoundingClientRect.call(this);
  };

  const view = render(
    <MessageTimeline
      ref={timelineRef}
      source={makeSource([makeMessage("clipped", 1), makeMessage("visible", 2)])}
      renderItem={(message) => (
        <div data-message-id={message.id} data-inner-message-body={message.id}>
          {message.content}
        </div>
      )}
      testId="focus-window-scroller"
      className="h-full"
    />,
  );
  const scroller = view.getByTestId("focus-window-scroller");
  scroller.scrollTop = 1300;

  timelineRef.current?.preserveAnchorOnNextLayoutChange();
  await act(async () => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });
  assert.equal(scroller.scrollTop, 1300);
});

test("send follow-bottom intent wins over a stale preserved focus anchor", SERIAL, async () => {
  const timelineRef = createRef<MessageTimelineHandle>();
  let focusedContentTop = 8600;

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 12695; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 779; },
  });
  Element.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    const element = this as HTMLElement;
    const requestedTop = typeof options === "number" ? options : options?.top ?? 0;
    element.scrollTop = Math.min(11916, Math.max(0, requestedTop));
  };
  Element.prototype.scrollIntoView = function scrollIntoView() {
    const element = this as HTMLElement;
    const scroller = element.closest<HTMLElement>('[data-testid="focus-window-scroller"]');
    if (scroller) scroller.scrollTop = 8535;
  };
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement;
    if (element.dataset.testid === "focus-window-scroller") {
      return { top: 0, bottom: 779, left: 0, right: 500, width: 500, height: 779, x: 0, y: 0, toJSON() {} };
    }
    if (element.dataset.messageId === "focused") {
      const scroller = element.closest<HTMLElement>('[data-testid="focus-window-scroller"]');
      const top = focusedContentTop - (scroller?.scrollTop ?? 0);
      return { top, bottom: top + 100, left: 0, right: 500, width: 500, height: 100, x: 0, y: top, toJSON() {} };
    }
    return originalGetBoundingClientRect.call(this);
  };

  const view = render(renderTimeline(makeSource([makeMessage("focused", 1)], "focused"), timelineRef));
  const scroller = view.getByTestId("focus-window-scroller");
  assert.equal(scroller.scrollTop, 8535, "focused thread/activity entry starts at the historical anchor");

  timelineRef.current?.preserveAnchorOnNextLayoutChange();
  scroller.scrollTop = 11916;
  timelineRef.current?.armFollowOnNextAppend();

  // Simulate the old focus target moving in the content coordinate space after
  // a send/inline-reply mutation. A stale anchor restore would pull the user
  // back to the original activity-open offset (8535).
  focusedContentTop = 5219;
  assert.equal(resizeCallbacks.length, 2, "scroller and content observers should be installed");
  await act(async () => {
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
  });

  assert.equal(
    scroller.scrollTop,
    11916,
    "send follow-bottom must ignore the stale preserved focus anchor and remain at the live tail",
  );
});

test("explicit scroll-to-top leaves live-tail follow mode", SERIAL, async () => {
  const scrollCalls: unknown[] = [];
  const timelineRef = createRef<MessageTimelineHandle>();
  const initialMessages = [
    makeMessage("parent", 1),
    makeMessage("reply", 2),
  ];

  Element.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    scrollCalls.push(options);
  };

  const view = render(renderTimeline(makeSource(initialMessages), timelineRef));
  assert.equal(timelineRef.current?.isFollowingBottom(), true);

  await act(async () => {
    timelineRef.current?.scrollToTop();
    await settleProgrammaticScroll();
  });

  assert.deepEqual(scrollCalls, [{ top: 0, behavior: "smooth" }]);
  assert.equal(timelineRef.current?.isFollowingBottom(), false);

  await act(async () => {
    view.rerender(renderTimeline(
      makeSource([...initialMessages, makeMessage("new-live-reply", 3)]),
      timelineRef,
    ));
  });

  assert.equal(scrollCalls.length, 1, "a new reply must not pull the reader back to the bottom");
});

test("momentum settling at the bottom re-engages follow only inside a real gesture window", SERIAL, async () => {
  let now = 100;
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.scrollTo = function scrollTo() {};

  const timelineRef = createRef<MessageTimelineHandle>();
  const view = render(renderTimeline(
    makeSource([makeMessage("m1", 1), makeMessage("m2", 2), makeMessage("m3", 3)]),
    timelineRef,
  ));
  await settleProgrammaticScroll();
  const scroller = view.getByTestId("focus-window-scroller");

  scroller.scrollTop = 200;
  await act(async () => {
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });
  assert.equal(timelineRef.current?.isFollowingBottom(), false, "flinging up leaves follow mode");

  now = 700;
  scroller.scrollTop = 1500;
  await act(async () => {
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });
  assert.equal(
    timelineRef.current?.isFollowingBottom(),
    true,
    "gesture-attributed Safari momentum settling at the bottom must re-engage follow",
  );

  scroller.scrollTop = 200;
  now = 800;
  await act(async () => {
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });
  assert.equal(timelineRef.current?.isFollowingBottom(), false);

  now = 1501;
  scroller.scrollTop = 1500;
  await act(async () => {
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });
  assert.equal(
    timelineRef.current?.isFollowingBottom(),
    false,
    "a gesture-less bottom scroll after the 700ms attribution window must not change user follow intent",
  );
});

test("touchmove refreshes momentum attribution for a long Safari drag", SERIAL, async () => {
  let now = 100;
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.scrollTo = function scrollTo() {};

  const timelineRef = createRef<MessageTimelineHandle>();
  const view = render(renderTimeline(
    makeSource([makeMessage("m1", 1), makeMessage("m2", 2), makeMessage("m3", 3)]),
    timelineRef,
  ));
  await settleProgrammaticScroll();
  const scroller = view.getByTestId("focus-window-scroller");

  scroller.scrollTop = 200;
  await act(async () => {
    fireEvent.touchStart(scroller);
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });
  assert.equal(timelineRef.current?.isFollowingBottom(), false);

  now = 800;
  fireEvent.touchMove(scroller);
  now = 850;
  scroller.scrollTop = 1500;
  await act(async () => {
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });
  assert.equal(
    timelineRef.current?.isFollowingBottom(),
    true,
    "touchmove must refresh attribution when a deliberate drag outlives the original window",
  );
});

test("a user scroll that interrupts an older programmatic scroll owns a synchronous append", SERIAL, async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    const requestedTop = typeof options === "number" ? options : options?.top ?? 0;
    (this as HTMLElement).scrollTop = Math.min(1500, Math.max(0, requestedTop));
  };
  Element.prototype.scrollIntoView = function scrollIntoView() {};

  const timelineRef = createRef<MessageTimelineHandle>();
  const initialMessages = [makeMessage("m1", 1), makeMessage("m2", 2)];
  const view = render(renderTimeline(makeSource(initialMessages), timelineRef));
  await settleProgrammaticScroll();
  const scroller = view.getByTestId("focus-window-scroller");

  timelineRef.current?.scrollToMessage("m1", { smooth: true });
  scroller.scrollTop = 400;
  fireEvent.scroll(scroller);
  scroller.scrollTop = 200;
  fireEvent.wheel(scroller);
  fireEvent.scroll(scroller);

  flushSync(() => {
    view.rerender(renderTimeline(
      makeSource([...initialMessages, makeMessage("append-before-scroll-frame", 3)]),
      timelineRef,
    ));
  });

  assert.equal(
    timelineRef.current?.isFollowingBottom(),
    false,
    "the later real user scroll must cancel the older programmatic owner before append classification",
  );
  assert.equal(
    scroller.scrollTop,
    200,
    "an append must preserve the reading position even when its commit beats the queued scroll frame",
  );
});

test("a programmatic command issued after a pending user gesture owns its scroll frames", SERIAL, async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    const requestedTop = typeof options === "number" ? options : options?.top ?? 0;
    (this as HTMLElement).scrollTop = Math.min(1500, Math.max(0, requestedTop));
  };

  const timelineRef = createRef<MessageTimelineHandle>();
  const view = render(renderTimeline(
    makeSource([makeMessage("m1", 1), makeMessage("m2", 2)]),
    timelineRef,
  ));
  await settleProgrammaticScroll();
  const scroller = view.getByTestId("focus-window-scroller");

  scroller.scrollTop = 200;
  fireEvent.wheel(scroller);
  timelineRef.current?.scrollToBottom();
  fireEvent.scroll(scroller);
  await act(async () => {
    await flushAnimationFrames();
  });

  assert.equal(
    timelineRef.current?.isFollowingBottom(),
    true,
    "the newer explicit bottom command must replace, rather than inherit, an older pending gesture",
  );
  assert.equal(scroller.scrollTop, 1500);
});

test("programmatic scrolling never consumes a fresh user gesture as follow intent", SERIAL, async () => {
  let now = 100;
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = function scrollIntoView() {};

  const timelineRef = createRef<MessageTimelineHandle>();
  const view = render(renderTimeline(
    makeSource([makeMessage("m1", 1), makeMessage("m2", 2), makeMessage("m3", 3)]),
    timelineRef,
  ));
  await settleProgrammaticScroll();
  const scroller = view.getByTestId("focus-window-scroller");

  scroller.scrollTop = 200;
  await act(async () => {
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });
  assert.equal(timelineRef.current?.isFollowingBottom(), false);

  now = 200;
  fireEvent.pointerDown(scroller);
  timelineRef.current?.scrollToMessage("m2");
  scroller.scrollTop = 1500;
  await act(async () => {
    fireEvent.scroll(scroller);
    await flushAnimationFrames(1);
  });
  assert.equal(
    timelineRef.current?.isFollowingBottom(),
    false,
    "programmatic scroll frames must not flip the user-owned follow flag even inside a gesture window",
  );
});

test("residual smooth-scroll frames stay programmatic after the RAF guard releases", SERIAL, async () => {
  let now = 100;
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = function scrollIntoView() {};

  const timelineRef = createRef<MessageTimelineHandle>();
  const view = render(renderTimeline(
    makeSource([makeMessage("m1", 1), makeMessage("m2", 2), makeMessage("m3", 3)]),
    timelineRef,
  ));
  await settleProgrammaticScroll();
  const scroller = view.getByTestId("focus-window-scroller");

  scroller.scrollTop = 200;
  await act(async () => {
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });
  assert.equal(timelineRef.current?.isFollowingBottom(), false);

  now = 200;
  fireEvent.pointerDown(scroller);
  timelineRef.current?.scrollToMessage("m2", { smooth: true });
  scroller.scrollTop = 400;
  await act(async () => {
    fireEvent.scroll(scroller);
    await flushAnimationFrames(1);
    await flushAnimationFrames(1);
  });

  now = 250;
  scroller.scrollTop = 1500;
  await act(async () => {
    fireEvent.scroll(scroller);
    await flushAnimationFrames(1);
  });
  assert.equal(
    timelineRef.current?.isFollowingBottom(),
    false,
    "a residual smooth frame after the two-frame guard must not inherit user momentum attribution",
  );
});

test("a short first data window rechecks the top sentinel after an early mount-time IO record", SERIAL, async () => {
  let loadOlderCalls = 0;
  const loadOlder = () => { loadOlderCalls += 1; };
  const emptySource = makeSource([], null, {
    hasOlder: true,
    loadOlder,
  });
  const view = render(renderTimeline(emptySource));

  const topSentinel = observedTargets[0];
  assert.ok(topSentinel, "the top history sentinel must be observed");
  assert.ok(intersectionCallback, "the timeline must install its IntersectionObserver");

  await act(async () => {
    intersectionCallback?.([
      { target: topSentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });
  assert.equal(
    loadOlderCalls,
    0,
    "the empty mount-time record must stay suppressed until initial positioning is known",
  );

  const scroller = view.getByTestId("focus-window-scroller");
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this === scroller) {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} };
    }
    if (this === topSentinel) {
      return { top: 100, bottom: 101, left: 0, right: 500, width: 500, height: 1, x: 0, y: 100, toJSON() {} };
    }
    return originalGetBoundingClientRect.call(this);
  };

  await act(async () => {
    view.rerender(renderTimeline(makeSource([makeMessage("short-first-page", 10)], null, {
      hasOlder: true,
      loadOlder,
    })));
  });

  assert.equal(
    loadOlderCalls,
    1,
    "the data commit must recover the missed IO transition while the top sentinel remains visible",
  );
});

test("keyed bounded context blocks every sentinel path until the next user scroll", SERIAL, async () => {
  let loadOlderCalls = 0;
  let loadNewerCalls = 0;
  const loadOlder = () => { loadOlderCalls += 1; };
  const loadNewer = () => { loadNewerCalls += 1; };

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  Element.prototype.scrollTo = function scrollTo() {};

  const view = render(renderTimeline(makeSource([
    makeMessage("tail-1", 1),
    makeMessage("tail-2", 2),
  ])));
  const scroller = view.getByTestId("focus-window-scroller");
  const [topSentinel, bottomSentinel] = observedTargets;
  assert.ok(topSentinel, "the top history sentinel must be observed");
  assert.ok(bottomSentinel, "the bottom history sentinel must be observed");

  // A scroll before the context swap must not satisfy the newly armed barrier.
  await settleProgrammaticScroll();
  scroller.scrollTop = 200;
  await act(async () => {
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });

  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this === scroller) {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} };
    }
    if (this === topSentinel) {
      return { top: 100, bottom: 101, left: 0, right: 500, width: 500, height: 1, x: 0, y: 100, toJSON() {} };
    }
    return originalGetBoundingClientRect.call(this);
  };

  await act(async () => {
    view.rerender(renderTimeline(makeSource(
      [
        makeMessage("context-oldest", 10),
        makeMessage("context-target", 11),
        makeMessage("context-newest", 12),
      ],
      "context-target",
      {
        hasOlder: true,
        hasNewer: true,
        loadOlder,
        loadNewer,
        sentinelAutoLoadBlockKey: "context-target",
      },
    )));
  });

  assert.equal(
    loadOlderCalls,
    0,
    "the post-commit geometry recheck must respect the newly armed barrier",
  );

  // Residual momentum from the pre-context wheel remains inside the ordinary
  // attribution window, but it is not a new gesture after this key was armed.
  scroller.scrollTop = 225;
  await act(async () => {
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });

  await act(async () => {
    intersectionCallback?.([
      { target: topSentinel, isIntersecting: true } as IntersectionObserverEntry,
      { target: bottomSentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });
  assert.equal(loadOlderCalls, 0);
  assert.equal(loadNewerCalls, 0);

  await settleProgrammaticScroll();
  scroller.scrollTop = 250;
  await act(async () => {
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });
  await act(async () => {
    intersectionCallback?.([
      { target: topSentinel, isIntersecting: true } as IntersectionObserverEntry,
      { target: bottomSentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });
  assert.equal(loadOlderCalls, 1);
  assert.equal(loadNewerCalls, 1);

  await act(async () => {
    view.rerender(renderTimeline(makeSource(
      [
        makeMessage("second-context-oldest", 20),
        makeMessage("second-context-target", 21),
        makeMessage("second-context-newest", 22),
      ],
      "second-context-target",
      {
        hasOlder: true,
        hasNewer: true,
        loadOlder,
        loadNewer,
        sentinelAutoLoadBlockKey: "second-context-target",
      },
    )));
  });
  assert.equal(loadOlderCalls, 1, "a distinct context key must re-arm the geometry barrier");

  await act(async () => {
    intersectionCallback?.([
      { target: topSentinel, isIntersecting: true } as IntersectionObserverEntry,
      { target: bottomSentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });
  assert.equal(loadOlderCalls, 1);
  assert.equal(loadNewerCalls, 1);
});

test("bounded-context keys preserve one-shot gesture semantics across rerenders", SERIAL, async () => {
  let loadOlderCalls = 0;
  const loadOlder = () => { loadOlderCalls += 1; };
  const messages = [makeMessage("bounded-a", 1), makeMessage("bounded-b", 2)];

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  Element.prototype.scrollTo = function scrollTo() {};

  const source = (sentinelAutoLoadBlockKey: string | null) => makeSource(messages, null, {
    hasOlder: true,
    loadOlder,
    sentinelAutoLoadBlockKey,
  });
  const view = render(renderTimeline(source("initial-context")));
  const scroller = view.getByTestId("focus-window-scroller");
  const [topSentinel] = observedTargets;
  assert.ok(topSentinel);

  await settleProgrammaticScroll();
  await act(async () => {
    intersectionCallback?.([
      { target: topSentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });
  assert.equal(loadOlderCalls, 0, "a non-null key must block on the initial mount");

  scroller.scrollTop = 200;
  await act(async () => {
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });
  await act(async () => {
    view.rerender(renderTimeline(source("initial-context")));
    intersectionCallback?.([
      { target: topSentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });
  assert.equal(loadOlderCalls, 1, "a stable key must not re-arm after the user releases it");

  await act(async () => {
    view.rerender(renderTimeline(source(null)));
  });
  await act(async () => {
    intersectionCallback?.([
      { target: topSentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });
  assert.equal(loadOlderCalls, 2, "a null key must explicitly retire the barrier");

  // A gesture that begins before the new key is armed cannot count as the
  // post-arm gesture which releases it.
  fireEvent.wheel(scroller);
  await act(async () => {
    view.rerender(renderTimeline(source("stale-gesture-context")));
  });
  await act(async () => {
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
    intersectionCallback?.([
      { target: topSentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });
  assert.equal(loadOlderCalls, 2);

  await act(async () => {
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
    intersectionCallback?.([
      { target: topSentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });
  assert.equal(loadOlderCalls, 3, "a fresh post-arm gesture must release the barrier");
});

test("at-bottom notifications update the parent outside the child state updater", SERIAL, async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });

  const consoleErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };

  function Parent() {
    const [atBottom, setAtBottom] = useState(true);
    return (
      <>
        <output data-testid="parent-at-bottom">{String(atBottom)}</output>
        <MessageTimeline
          source={makeSource([makeMessage("first", 1), makeMessage("second", 2)])}
          renderItem={(message) => <div>{message.content}</div>}
          testId="parent-update-scroller"
          onAtBottomChange={setAtBottom}
        />
      </>
    );
  }

  try {
    const view = render(<Parent />);
    const scroller = view.getByTestId("parent-update-scroller");
    scroller.scrollTop = 0;

    await act(async () => {
      fireEvent.scroll(scroller);
      await flushAnimationFrames(2);
    });

    assert.equal(view.getByTestId("parent-at-bottom").textContent, "false");
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(
    consoleErrors.some((message) => message.includes("Cannot update a component")),
    false,
    "MessageTimeline must not call the parent onAtBottomChange setter from inside its own state updater",
  );
});

test("context window swaps center the focused message instead of following the bottom", SERIAL, async () => {
  const focusCalls: Array<{ id: string; block?: ScrollLogicalPosition }> = [];
  const bottomCalls: unknown[] = [];
  const timelineRef = createRef<MessageTimelineHandle>();

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });

  Element.prototype.scrollIntoView = function scrollIntoView(arg?: boolean | ScrollIntoViewOptions) {
    const id = (this as HTMLElement).dataset.messageId;
    if (id) {
      focusCalls.push({
        id,
        block: typeof arg === "object" ? arg.block : undefined,
      });
    }
  };
  Element.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    bottomCalls.push(options);
  };

  const initialTail = [
    makeMessage("tail-1", 1),
    makeMessage("tail-2", 2),
  ];
  const contextWindow = [
    makeMessage("older", 10),
    makeMessage("saved-target", 11),
    makeMessage("newer", 12),
  ];

  const view = render(renderTimeline(makeSource(initialTail), timelineRef));
  assert.deepEqual(focusCalls, []);
  assert.deepEqual(bottomCalls, []);

  await act(async () => {
    view.rerender(renderTimeline(makeSource(contextWindow, "saved-target"), timelineRef));
  });

  assert.deepEqual(focusCalls, [{ id: "saved-target", block: "center" }]);
  assert.deepEqual(bottomCalls, []);
  assert.equal(timelineRef.current?.isFollowingBottom(), false);

  await act(async () => {
    view.rerender(renderTimeline(makeSource([...contextWindow, makeMessage("append", 13)]), timelineRef));
  });

  assert.deepEqual(bottomCalls, []);

  await act(async () => {
    view.rerender(renderTimeline(makeSource([
      makeMessage("replacement-after-focus-1", 20),
      makeMessage("replacement-after-focus-2", 21),
    ]), timelineRef));
  });

  assert.deepEqual(bottomCalls, []);
});

test("context window swaps without a focus target keep the existing follow-bottom behavior", SERIAL, async () => {
  const bottomCalls: unknown[] = [];

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });

  Element.prototype.scrollIntoView = function scrollIntoView() {};
  Element.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    bottomCalls.push(options);
  };

  const view = render(renderTimeline(makeSource([
    makeMessage("tail-1", 1),
    makeMessage("tail-2", 2),
  ])));

  await act(async () => {
    view.rerender(renderTimeline(makeSource([
      makeMessage("replacement-1", 10),
      makeMessage("replacement-2", 11),
    ])));
  });

  assert.equal(bottomCalls.length, 1);
});

test("focused context windows suppress bottom-sentinel loadNewer until user scroll", SERIAL, async () => {
  let loadNewerCount = 0;

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });

  Element.prototype.scrollIntoView = function scrollIntoView() {};
  Element.prototype.scrollTo = function scrollTo() {};

  const view = render(renderTimeline(makeSource([
    makeMessage("tail-1", 1),
    makeMessage("tail-2", 2),
  ])));

  await act(async () => {
    view.rerender(renderTimeline(makeSource(
      [
        makeMessage("older", 10),
        makeMessage("saved-target", 11),
        makeMessage("newer", 12),
      ],
      "saved-target",
      {
        hasNewer: true,
        loadNewer: () => { loadNewerCount += 1; },
      },
    )));
  });

  const bottomSentinel = observedTargets[1];
  assert.ok(bottomSentinel, "bottom sentinel should be observed");

  await act(async () => {
    intersectionCallback?.([
      { target: bottomSentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });

  assert.equal(loadNewerCount, 0);
});

test("focused context windows re-arm bottom-follow after the user returns to bottom", SERIAL, async () => {
  const bottomCalls: unknown[] = [];
  const timelineRef = createRef<MessageTimelineHandle>();

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });

  Element.prototype.scrollIntoView = function scrollIntoView() {};
  Element.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    bottomCalls.push(options);
  };

  const contextWindow = [
    makeMessage("older", 10),
    makeMessage("saved-target", 11),
    makeMessage("newer", 12),
  ];

  const view = render(renderTimeline(makeSource([
    makeMessage("tail-1", 1),
    makeMessage("tail-2", 2),
  ]), timelineRef));

  await act(async () => {
    view.rerender(renderTimeline(makeSource(contextWindow, "saved-target"), timelineRef));
    await settleProgrammaticScroll();
  });

  assert.equal(timelineRef.current?.isFollowingBottom(), false);

  await act(async () => {
    view.rerender(renderTimeline(makeSource(contextWindow), timelineRef));
    await settleProgrammaticScroll();
  });

  const scroller = view.getByTestId("focus-window-scroller");
  scroller.scrollTop = 1500;

  await act(async () => {
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });

  assert.equal(timelineRef.current?.isFollowingBottom(), true);

  await act(async () => {
    view.rerender(renderTimeline(makeSource([...contextWindow, makeMessage("append-after-bottom", 13)]), timelineRef));
  });

  assert.equal(bottomCalls.length, 1);
});

test("imperative scrollToBottom clears persisted context-window scroll anchors", SERIAL, async () => {
  const timelineRef = createRef<MessageTimelineHandle>();
  const persistKey = "channel:search-hit";
  let loadNewerCount = 0;
  const contextWindow = [
    makeMessage("older", 10),
    makeMessage("saved-target", 11),
    makeMessage("newer", 12),
  ];

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });

  Element.prototype.scrollIntoView = function scrollIntoView() {};
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement;
    if (element.dataset.testid === "focus-window-scroller") {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON: () => ({}) };
    }
    if (element.dataset.messageId === "older") {
      return { top: -80, bottom: 0, left: 0, right: 500, width: 500, height: 80, x: 0, y: -80, toJSON: () => ({}) };
    }
    if (element.dataset.messageId === "saved-target") {
      return { top: 12, bottom: 112, left: 0, right: 500, width: 500, height: 100, x: 0, y: 12, toJSON: () => ({}) };
    }
    if (element.dataset.messageId === "newer") {
      return { top: 120, bottom: 220, left: 0, right: 500, width: 500, height: 100, x: 0, y: 120, toJSON: () => ({}) };
    }
    return originalGetBoundingClientRect.call(this);
  };

  const view = render(renderTimeline(makeSource(contextWindow, "saved-target", {
    hasNewer: true,
    loadNewer: () => { loadNewerCount += 1; },
  }), timelineRef, persistKey));
  await settleProgrammaticScroll();

  const scroller = view.getByTestId("focus-window-scroller");
  scroller.scrollTop = 300;
  await act(async () => {
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    await flushAnimationFrames();
  });

  assert.equal(
    recallPersistedScrollMessageId(persistKey),
    "saved-target",
    "off-bottom user scrolling from a search/permalink context window remembers the visible anchor",
  );

  await act(async () => {
    timelineRef.current?.scrollToBottom();
    await settleProgrammaticScroll();
  });

  assert.equal(
    recallPersistedScrollMessageId(persistKey),
    null,
    "explicit Back to bottom / scrollToBottom intent must not replay the old search anchor on next channel entry",
  );

  const bottomSentinel = observedTargets[1];
  assert.ok(bottomSentinel, "bottom sentinel should be observed");

  await act(async () => {
    intersectionCallback?.([
      { target: bottomSentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });

  assert.equal(
    loadNewerCount,
    1,
    "explicit scrollToBottom exits restored-anchor mode so the bottom sentinel can load newer messages again",
  );
});

test("imperative scrollToBottom without a persistKey leaves scroll memory untouched", SERIAL, async () => {
  const timelineRef = createRef<MessageTimelineHandle>();
  window.sessionStorage.setItem("slock.scroll-memory.v1.undefined", "keep-undefined-sentinel");

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });

  Element.prototype.scrollIntoView = function scrollIntoView() {};
  Element.prototype.scrollTo = function scrollTo() {};

  render(renderTimeline(makeSource([
    makeMessage("tail-1", 1),
    makeMessage("tail-2", 2),
  ]), timelineRef));

  await act(async () => {
    timelineRef.current?.scrollToBottom();
    await settleProgrammaticScroll();
  });

  assert.equal(
    window.sessionStorage.getItem("slock.scroll-memory.v1.undefined"),
    "keep-undefined-sentinel",
    "scrollToBottom must not call forgetScroll for an absent persistKey",
  );
});

test("imperative scrollToBottom exits restored-anchor mode without requiring user scroll", SERIAL, async () => {
  const timelineRef = createRef<MessageTimelineHandle>();
  let loadNewerCount = 0;
  const contextWindow = [
    makeMessage("older", 10),
    makeMessage("saved-target", 11),
    makeMessage("newer", 12),
  ];

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return 2000; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 500; },
  });

  Element.prototype.scrollIntoView = function scrollIntoView() {};
  Element.prototype.scrollTo = function scrollTo() {};

  render(renderTimeline(makeSource(contextWindow, "saved-target", {
    hasNewer: true,
    loadNewer: () => { loadNewerCount += 1; },
  }), timelineRef, "channel:focused-no-user-scroll"));
  await settleProgrammaticScroll();

  const bottomSentinel = observedTargets[1];
  assert.ok(bottomSentinel, "bottom sentinel should be observed");

  await act(async () => {
    intersectionCallback?.([
      { target: bottomSentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });

  assert.equal(
    loadNewerCount,
    0,
    "focused/restored context windows suppress mount-time loadNewer before explicit bottom intent",
  );

  await act(async () => {
    timelineRef.current?.scrollToBottom();
    await settleProgrammaticScroll();
  });

  await act(async () => {
    intersectionCallback?.([
      { target: bottomSentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });

  assert.equal(
    loadNewerCount,
    1,
    "explicit scrollToBottom must clear restored-anchor mode even if the user never manually scrolled",
  );
});
