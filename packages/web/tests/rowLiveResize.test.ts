import "./helpers/domSetup";

import assert from "node:assert/strict";
import { act, cleanup, render } from "@testing-library/react";
import { createElement, useMemo, useRef, useState } from "react";

import { useRowFacts } from "../src/components/layout/rowFacts";
import { samePlanTopology, useConversationWidth, useRowLayout, useRowPlan } from "../src/components/layout/rowLayout";
import type { LiveRowResizeHandler } from "../src/components/layout/rowLayout";
import { planRow, sideColumnKey } from "../src/components/layout/rowPlan";
import type { PlanColumn } from "../src/components/layout/rowPlan";
import MessageTimeline from "../src/components/message/MessageTimeline";
import type { MessageTimelineHandle } from "../src/components/message/MessageTimeline";
import { topAnchorDelta, topVisibleMessage } from "../src/components/message/timelineTopRow";
import { useTimelineWidthAnchor } from "../src/components/message/timelineWidthAnchor";
import { useSideRoom } from "../src/components/task/useSideRoom";
import { commitColumnWidth, resetColumnWidth } from "../src/store/columnWidthStore";
import type { Message } from "../src/store/messageStore";
import { TestIntlProvider } from "./helpers/intl";

const initialInnerWidth = window.innerWidth;

afterEach(() => {
  cleanup();
  useConversationWidth.setState({ width: null });
  resetColumnWidth("thread");
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: initialInnerWidth });
});

const COLUMNS_THREE: PlanColumn[] = [
  { key: sideColumnKey(0), regions: ["thread"], mins: [360], saved: 485 },
  { key: sideColumnKey(1), regions: ["artifact"], mins: [480], saved: 475 },
];

function mockRect(el: Element, rect: { top?: number; bottom?: number; left?: number; width?: number; height?: number }) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const top = rect.top ?? 0;
      const left = rect.left ?? 0;
      const width = rect.width ?? 0;
      const height = rect.height ?? (rect.bottom !== undefined ? rect.bottom - top : 0);
      const bottom = rect.bottom ?? top + height;
      return { top, bottom, left, right: left + width, width, height, x: left, y: top, toJSON: () => ({}) };
    },
  });
}

test("samePlanTopology stays true across continuous width changes and flips on fold, tab grouping, expansion, or rebalance", () => {
  const base = (available: number, wasFolded = false, expanded: string | null = null) => planRow({
    available,
    conversation: { saved: 453, contentMin: 360 },
    thread: { saved: 485, contentMin: 360 },
    columns: COLUMNS_THREE,
    expanded,
    expandFold: false,
    wasFolded,
  });

  const w1413 = base(1413);
  const w1300 = base(1300);
  const w1210 = base(1210);
  assert.equal(w1413.fold, false);
  assert.equal(w1210.fold, false);
  assert.equal(samePlanTopology(w1413, w1300), true, "continuous 3-column resize keeps identical topology");
  assert.equal(samePlanTopology(w1300, w1210), true, "proportional give-way keeps identical topology");

  const folded = base(1150);
  assert.equal(folded.fold, true);
  assert.equal(samePlanTopology(w1210, folded), false, "folding the thread changes topology");

  const tabbed = base(300);
  assert.equal(samePlanTopology(folded, tabbed), false, "collapsing columns into tabs changes topology");

  const expanded = base(1413, false, "artifact");
  assert.equal(samePlanTopology(w1413, expanded), false, "expanding a region changes topology");

  const rebalanced = planRow({
    available: 1300,
    conversation: { saved: 900, contentMin: 360 },
    thread: { saved: 200, contentMin: 360 },
    columns: [{ key: sideColumnKey(0), regions: ["thread"], mins: [360], saved: 200 }],
    expanded: null,
    expandFold: false,
    wasFolded: true,
  });
  assert.equal(rebalanced.rebalance !== null, true);
  assert.equal(samePlanTopology(w1300, rebalanced), false, "a pending rebalance forces a state commit");
});

test("continuous 3-column window resize updates --row-width synchronously with zero React re-renders, and fold flips atomically", () => {
  let rowWidth = 1413;
  let renders = 0;
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1852 });

  function PlannedThreeColumnHarness() {
    renders += 1;
    const [row, setRow] = useState<HTMLDivElement | null>(null);
    const [floatSlot, setFloatSlot] = useState<HTMLDivElement | null>(null);
    useRowFacts(row);
    const liveResize = useRef<LiveRowResizeHandler | null>(null);
    const room = useSideRoom(row, floatSlot, liveResize);
    const planned = room.room !== null && room.viewportWidth >= 768 && !room.legacyTask;
    const plan = useRowPlan({
      active: planned,
      available: room.rowWidth,
      columns: COLUMNS_THREE,
      thread: true,
      forceFold: false,
      threadExpanded: false,
    }, row);
    const liveBinding = useMemo(() => ({
      columns: COLUMNS_THREE,
      thread: true,
      helpBeside: false,
      handlerRef: liveResize,
    }), []);
    useRowLayout(row, room, plan, liveBinding);

    return createElement(
      "div",
      {
        ref: (el: HTMLDivElement | null) => {
          if (el) mockRect(el, { width: rowWidth, height: 900 });
          setRow(el);
        },
        className: "thread-layout-container",
        "data-testid": "row",
      },
      createElement(
        "div",
        {
          ref: (el: HTMLDivElement | null) => {
            if (el) mockRect(el, { width: 453, height: 900 });
          },
          className: "thread-main-column",
          "data-testid": "channel",
        },
        createElement("div", { "data-testid": "message-content-surface" }),
        createElement("div", { ref: setFloatSlot, className: "contents", "data-testid": "channel-side-float-slot" }),
      ),
      createElement("div", {
        className: "thread-side-column",
        "data-testid": "thread",
      }),
      createElement("div", {
        "data-testid": "channel-side-column",
        "data-in-row": "true",
        "data-column": "1",
      }),
    );
  }

  commitColumnWidth("thread", 485);
  useConversationWidth.setState({ width: 453 });

  const view = render(createElement(PlannedThreeColumnHarness));
  const row = view.getByTestId("row");
  const thread = view.getByTestId("thread");
  const artifact = view.getByTestId("channel-side-column");

  const rendersAfterMount = renders;
  assert.equal(thread.style.getPropertyValue("--row-width"), "485px");
  assert.equal(artifact.style.getPropertyValue("--row-width"), "475px");
  assert.equal(thread.hasAttribute("data-covers"), false);

  // Continuous drag steps above fold threshold (1413 -> 1335 -> 1260 -> 1335):
  // `--row-width` updates synchronously inside the resize event with 0 React re-renders.
  for (const nextRowWidth of [1335, 1260, 1335]) {
    rowWidth = nextRowWidth;
    window.innerWidth = nextRowWidth + 439;
    mockRect(row, { width: rowWidth, height: 900 });
    window.dispatchEvent(new window.Event("resize"));

    const expected = planRow({
      available: nextRowWidth,
      conversation: { saved: 453, contentMin: 360 },
      thread: { saved: 485, contentMin: 360 },
      columns: COLUMNS_THREE,
      expanded: null,
      expandFold: false,
      wasFolded: false,
    });
    assert.equal(thread.style.getPropertyValue("--row-width"), `${Math.round(expected.widths[1]! * 100) / 100}px`);
    assert.equal(artifact.style.getPropertyValue("--row-width"), `${Math.round(expected.widths[2]! * 100) / 100}px`);
    assert.equal(thread.hasAttribute("data-covers"), false);
  }
  assert.equal(renders, rendersAfterMount, "continuous resize must not re-render ChannelSideArea");

  // Crossing into fold (rowWidth = 1080 < 360 + 360 + 475): `data-covers`, `data-has-thread-covers`,
  // and folded `--row-width` all flip synchronously inside the same resize dispatch (no split-brain frame).
  rowWidth = 1080;
  window.innerWidth = 1519;
  mockRect(row, { width: rowWidth, height: 900 });
  let syncedDuringFoldEvent = false;
  act(() => {
    window.dispatchEvent(new window.Event("resize"));
    // Verify DOM attributes & widths updated synchronously BEFORE act() flushes React state!
    syncedDuringFoldEvent =
      thread.getAttribute("data-covers") === "first" &&
      row.hasAttribute("data-has-thread-covers") &&
      artifact.style.getPropertyValue("--row-width") === "475px" &&
      thread.style.getPropertyValue("--row-width") === "605px";
  });
  assert.equal(syncedDuringFoldEvent, true, "fold geometry and data-covers update synchronously inside resize event");

  // Crossing back out of fold (rowWidth = 1413): `data-covers` clears and both side widths restore immediately.
  rowWidth = 1413;
  window.innerWidth = 1852;
  mockRect(row, { width: rowWidth, height: 900 });
  let syncedDuringUnfoldEvent = false;
  act(() => {
    window.dispatchEvent(new window.Event("resize"));
    syncedDuringUnfoldEvent =
      !thread.hasAttribute("data-covers") &&
      !row.hasAttribute("data-has-thread-covers") &&
      thread.style.getPropertyValue("--row-width") === "485px" &&
      artifact.style.getPropertyValue("--row-width") === "475px";
  });
  assert.equal(syncedDuringUnfoldEvent, true, "unfold geometry and data-covers clear synchronously inside resize event");
});

test("topVisibleMessage and useTimelineWidthAnchor anchor scrolled-up channels (including tall clipped messages) while preserving tail follow", () => {
  const scroller = document.createElement("div");
  mockRect(scroller, { top: 100, bottom: 700, width: 450, height: 600 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1800 });
  Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 800 });

  const tallRow = document.createElement("div");
  tallRow.dataset.timelineMessageId = "msg-tall";
  // Starts 180px above the scroller's top (y = -80 vs top = 100), extends to y = 520.
  mockRect(tallRow, { top: -80, bottom: 520, width: 450, height: 600 });

  const hiddenBullet = document.createElement("li");
  mockRect(hiddenBullet, { top: -40, bottom: 60, width: 420, height: 100 });
  const visibleBullet = document.createElement("li");
  mockRect(visibleBullet, { top: 108, bottom: 160, width: 420, height: 52 });
  tallRow.append(hiddenBullet, visibleBullet);
  scroller.append(tallRow);

  const anchor = topVisibleMessage(scroller);
  assert.equal(anchor?.id, "msg-tall");
  assert.equal(anchor?.offset, -180);
  assert.equal(anchor?.subOffset, 8, "anchors the first visible inner block at the top edge");

  // Off-screen bullet above the viewport wraps by +44px (pushing visibleBullet from y=108 to y=152 while row top stays -80):
  mockRect(visibleBullet, { top: 152, bottom: 204, width: 340, height: 52 });
  assert.equal(topAnchorDelta(scroller, tallRow, anchor!), 44, "compensates off-screen wrapping above the visible block");

  // Hook contract across scrolled-up channel vs tail-following channel:
  const followingRef = { current: false };
  let api: ReturnType<typeof useTimelineWidthAnchor> | null = null;
  const rafQueue: FrameRequestCallback[] = [];
  const origRaf = globalThis.requestAnimationFrame;
  const origWindowRaf = window.requestAnimationFrame;
  // global-jsdom: `window` is not `globalThis`, and raft-ui reads frames from the element's own window.
  globalThis.requestAnimationFrame = window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  try {
    function AnchorProbe({ keepTopWhenShort }: { keepTopWhenShort: boolean }) {
      api = useTimelineWidthAnchor(keepTopWhenShort, () => scroller, topVisibleMessage, followingRef);
      return null;
    }
    const probe = render(createElement(AnchorProbe, { keepTopWhenShort: false }));
    while (rafQueue.length > 0) rafQueue.shift()!(16);

    // Width narrows 450 -> 360 while scrolled up (`following = false`): returns the message anchor, not null.
    mockRect(scroller, { top: 100, bottom: 700, width: 360, height: 600 });
    const keptScrolledUp = api!.take(scroller, true);
    assert.equal(typeof keptScrolledUp === "object" && keptScrolledUp?.id === "msg-tall", true);

    // Even if a temporary wide frame clamps scrollTop to maxScroll (`distanceFromBottom === 0`) while `following = false`,
    // `note()` must preserve the message anchor rather than synthesizing `atEnd: true`.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 300 });
    api!.note();
    while (rafQueue.length > 0) rafQueue.shift()!(24);
    mockRect(scroller, { top: 100, bottom: 700, width: 400, height: 600 });
    const afterClamp = api!.take(scroller, true);
    assert.equal(typeof afterClamp === "object" && afterClamp?.id === "msg-tall", true);

    // Now reader returns to bottom (`following = true`), even if content becomes short: channel keeps `"end"`.
    followingRef.current = true;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
    api!.note();
    while (rafQueue.length > 0) rafQueue.shift()!(32);
    mockRect(scroller, { top: 100, bottom: 700, width: 450, height: 600 });
    assert.equal(api!.take(scroller, true), "end");

    probe.unmount();

    // Fresh Thread mount (`keepTopWhenShort = true`):
    // (a) Short thread on mount (`scrollHeight <= clientHeight`) keeps top parent message when narrowed into overflow.
    followingRef.current = true;
    mockRect(scroller, { top: 100, bottom: 700, width: 450, height: 600 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
    const threadProbe = render(createElement(AnchorProbe, { keepTopWhenShort: true }));
    while (rafQueue.length > 0) rafQueue.shift()!(40);
    mockRect(scroller, { top: 100, bottom: 700, width: 340, height: 600 });
    const shortThreadKept = api!.take(scroller, true);
    assert.equal(typeof shortThreadKept === "object" && shortThreadKept?.id === "msg-tall", true);

    // (b) Overflowing thread (`scrollHeight > clientHeight`) following its tail returns `"end"`.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1400 });
    api!.note();
    while (rafQueue.length > 0) rafQueue.shift()!(48);
    mockRect(scroller, { top: 100, bottom: 700, width: 1200, height: 600 });
    assert.equal(api!.take(scroller, true), "end");

    // (c) #12905 Rule 5: when that overflowing thread widens so all replies fit (`scrollHeight <= clientHeight`) and `note()` runs,
    // narrowing back still returns `"end"` rather than losing tail-follow.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 400 });
    api!.note();
    while (rafQueue.length > 0) rafQueue.shift()!(56);
    mockRect(scroller, { top: 100, bottom: 700, width: 420, height: 600 });
    assert.equal(api!.take(scroller, true), "end");

    threadProbe.unmount();
  } finally {
    globalThis.requestAnimationFrame = origRaf;
    window.requestAnimationFrame = origWindowRaf;
  }

  // A tall leaf `<pre>` straddling the scroller top (`top = 100`, `pre` spans `80..580`) followed by a `<p>` near the bottom (`590..630`)
  // must NOT anchor to the bottom `<p>`; it falls back to `row`'s `offset` so lines at the top edge are not scrolled off-screen.
  const codeScroller = document.createElement("div");
  mockRect(codeScroller, { top: 100, bottom: 700, width: 450, height: 600 });
  const codeRow = document.createElement("div");
  codeRow.dataset.timelineMessageId = "msg-pre";
  mockRect(codeRow, { top: 80, bottom: 640, width: 450, height: 560 });
  const straddlingPre = document.createElement("pre");
  mockRect(straddlingPre, { top: 80, bottom: 580, width: 420, height: 500 });
  const trailingPara = document.createElement("p");
  mockRect(trailingPara, { top: 590, bottom: 630, width: 420, height: 40 });
  codeRow.append(straddlingPre, trailingPara);
  codeScroller.append(codeRow);

  const preAnchor = topVisibleMessage(codeScroller);
  assert.equal(preAnchor?.id, "msg-pre");
  assert.equal(preAnchor?.sub, undefined, "does not anchor to a trailing block below a straddling leaf <pre>");
  assert.equal(preAnchor?.offset, -20);
});

test("VirtualMessageTimeline re-follows after user scroll when widened to fit, and programmatic jumps clear active width anchors", () => {
  const observed = new Map<Element, ResizeObserverCallback[]>();
  const OrigRO = globalThis.ResizeObserver;
  const OrigWindowRO = window.ResizeObserver;
  const origRaf = globalThis.requestAnimationFrame;
  const origWindowRaf = window.requestAnimationFrame;
  const rafQueue: FrameRequestCallback[] = [];
  // global-jsdom: `window` is not `globalThis`, and raft-ui VirtualList takes frames and its
  // ResizeObserver from the element's own window, so both are stubbed.
  globalThis.requestAnimationFrame = window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  globalThis.ResizeObserver = window.ResizeObserver = class MockTimelineRO {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; }
    observe(target: Element) {
      const list = observed.get(target) ?? [];
      list.push(this.cb);
      observed.set(target, list);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  const fireResize = (target: Element) => {
    for (const cb of observed.get(target) ?? []) {
      cb([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], {} as ResizeObserver);
    }
  };

  try {
    const messages = [
      { id: "m1", channelId: "c1", content: "one", createdAt: "2026-11-16T00:00:00Z", seq: 1 },
      { id: "m2", channelId: "c1", content: "two", createdAt: "2026-11-16T00:00:01Z", seq: 2 },
      { id: "m3", channelId: "c1", content: "three", createdAt: "2026-11-16T00:00:02Z", seq: 3 },
    ] as unknown as Message[];
    const handleRef = { current: null as MessageTimelineHandle | null };
    const renderTimeline = (atStartKey: number | null = null) =>
      createElement(
        TestIntlProvider,
        null,
        createElement(MessageTimeline, {
          ref: (inst) => { handleRef.current = inst; },
          keepTopOnWidthChange: true,
          source: {
            messages,
            hasOlder: false,
            hasNewer: false,
            loading: false,
            loadOlder: () => {},
            loadNewer: () => {},
            atStartKey,
          },
          renderItem: (msg) => createElement("div", null, msg.content),
        }),
      );

    const view = render(renderTimeline(null));
    const scroller = view.getByTestId("message-scroller");
    mockRect(scroller, { top: 100, bottom: 500, width: 380, height: 400 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 500 });

    const row1 = scroller.querySelector<HTMLElement>('[data-timeline-message-id="m1"]')!;
    const row2 = scroller.querySelector<HTMLElement>('[data-timeline-message-id="m2"]')!;
    mockRect(row1, { top: 112, bottom: 260, width: 380, height: 148 });
    mockRect(row2, { top: 260, bottom: 420, width: 380, height: 160 });
    const flushRaf = (t = 16) => {
      act(() => {
        while (rafQueue.length > 0) rafQueue.shift()!(t);
      });
    };
    flushRaf(16);

    // 1. Reader scrolls up in an overflowing thread (`userHasScrolledRef = true`, `followRef = false`):
    act(() => {
      scroller.dispatchEvent(new window.Event("wheel", { bubbles: true }));
      scroller.scrollTop = 180;
      scroller.dispatchEvent(new window.Event("scroll"));
    });
    flushRaf(32);
    assert.equal(handleRef.current!.isFollowingBottom(), false);

    // Row widens so every reply fits (`scrollHeight <= clientHeight`): thread resumes following!
    mockRect(scroller, { top: 100, bottom: 500, width: 720, height: 400 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 320 });
    scroller.scrollTop = 0;
    act(() => { fireResize(scroller); });
    flushRaf(48);
    assert.equal(handleRef.current!.isFollowingBottom(), true, "thread follows again once widened to fit");

    // 2. Scroll up again in an overflowing list, trigger width resize (`layoutAnchorRef` armed for 1.2s),
    // then run a programmatic jump (`scrollToMessage` and `atStartKey`): content resize must NOT pull scrollTop back.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    act(() => {
      scroller.dispatchEvent(new window.Event("wheel", { bubbles: true }));
      scroller.scrollTop = 200;
      scroller.dispatchEvent(new window.Event("scroll"));
    });
    flushRaf(64);

    mockRect(scroller, { top: 100, bottom: 500, width: 500, height: 400 });
    act(() => { fireResize(scroller); });

    // Programmatic `scrollToMessage("m3")` clears `layoutAnchorRef`: moving `row1` by +90px on a content resize does NOT adjust scrollTop.
    act(() => { handleRef.current!.scrollToMessage("m3", { align: "center" }); });
    scroller.scrollTop = 580;
    mockRect(row1, { top: 202, bottom: 350, width: 500, height: 148 });
    act(() => {
      for (const el of Array.from(observed.keys())) {
        if (el !== scroller) fireResize(el);
      }
    });
    assert.equal(scroller.scrollTop, 580, "scrollToMessage clears width layoutAnchorRef so content resize does not pull back");

    // Re-arm width anchor, then trigger `atStartKey` jump: also clears `layoutAnchorRef`.
    flushRaf(80);
    mockRect(scroller, { top: 100, bottom: 500, width: 420, height: 400 });
    act(() => { fireResize(scroller); });
    view.rerender(renderTimeline(1));
    scroller.scrollTop = 0;
    mockRect(row1, { top: 260, bottom: 408, width: 420, height: 148 });
    act(() => {
      for (const el of Array.from(observed.keys())) {
        if (el !== scroller) fireResize(el);
      }
    });
    assert.equal(scroller.scrollTop, 0, "atStartKey jump clears width layoutAnchorRef");

    view.unmount();
  } finally {
    globalThis.ResizeObserver = OrigRO;
    window.ResizeObserver = OrigWindowRO;
    globalThis.requestAnimationFrame = origRaf;
    window.requestAnimationFrame = origWindowRaf;
  }
});
