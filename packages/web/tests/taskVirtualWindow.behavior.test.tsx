import assert from "node:assert/strict";
import test from "node:test";
import { useRef } from "react";
import type { RefObject } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import VirtualizedTaskStack, { TaskVirtualLayout } from "../src/components/task/VirtualizedTaskStack";

class PassiveResizeObserver {
  static readonly instances = new Set<PassiveResizeObserver>();
  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    PassiveResizeObserver.instances.add(this);
  }

  observe(element: Element) {
    this.observed.add(element);
  }
  unobserve(element: Element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.observed.clear();
    PassiveResizeObserver.instances.delete(this);
  }

  static trigger(element: Element) {
    for (const observer of PassiveResizeObserver.instances) {
      if (observer.observed.has(element)) observer.callback([], observer as unknown as ResizeObserver);
    }
  }

  static triggerSingleTarget(element: Element) {
    for (const observer of PassiveResizeObserver.instances) {
      if (observer.observed.size === 1 && observer.observed.has(element)) {
        observer.callback([], observer as unknown as ResizeObserver);
      }
    }
  }
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: PassiveResizeObserver,
});
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    if (this.hasAttribute("data-task-virtual-scroll")) return 720;
    return this.getAttribute("data-testid") === "task-virtual-row" ? 100 : 0;
  },
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    return this.hasAttribute("data-task-virtual-scroll") ? 320 : 0;
  },
});

test.afterEach(cleanup);

const tasks = Array.from({ length: 5_000 }, (_, index) => ({
  id: `task-${index}`,
  title: `Task ${index}`,
}));

function TaskWindowHarness() {
  const scrollElementRef = useRef<HTMLDivElement>(null);
  const setScrollElement = (element: HTMLDivElement | null) => {
    scrollElementRef.current = element;
    if (!element) return;
    Object.defineProperties(element, {
      offsetHeight: { configurable: true, value: 720 },
      offsetWidth: { configurable: true, value: 320 },
    });
  };
  return (
    <div
      ref={setScrollElement}
      data-task-virtual-scroll
      data-testid="scroll-element"
      style={{ height: 720, overflow: "auto" }}
    >
      <TaskVirtualLayout scrollElementRef={scrollElementRef} data-testid="layout-element">
        <VirtualizedTaskStack
          items={tasks}
          scrollElementRef={scrollElementRef as RefObject<HTMLDivElement | null>}
          estimateSize={100}
          gap={10}
          getItemKey={(task) => task.id}
          renderItem={(task) => <article data-task-id={task.id}>{task.title}</article>}
        />
      </TaskVirtualLayout>
    </div>
  );
}

test("5k tasks mount a bounded viewport while preserving the full scroll extent", () => {
  render(<TaskWindowHarness />);

  const windowElement = screen.getByTestId("task-virtual-window");
  assert.equal(windowElement.getAttribute("data-total-count"), "5000");
  const initialRowCount = screen.getAllByTestId("task-virtual-row").length;
  assert.ok(
    initialRowCount <= 20,
    `initial commit must mount only viewport + overscan, not 5,000 TaskCards (mounted ${initialRowCount})`,
  );
  assert.ok(document.querySelector('[data-task-id="task-0"]'));
  assert.equal(document.querySelector('[data-task-id="task-4999"]'), null);
  assert.ok(
    Number.parseFloat(windowElement.style.height) > 500_000,
    "the spacer must preserve the full 5,000-task scroll extent",
  );
  assert.ok(
    screen.getAllByTestId("task-virtual-row").length <= 20,
    "the mounted TaskCard count must stay bounded",
  );
});

test("a shared layout resize rebases a later stack after a preceding section changes extent", () => {
  function TwoStackHarness() {
    const scrollElementRef = useRef<HTMLDivElement>(null);
    const items = Array.from({ length: 2_500 }, (_, index) => ({ id: `task-${index}` }));
    return (
      <div ref={scrollElementRef} data-task-virtual-scroll data-testid="shared-scroll">
        <TaskVirtualLayout scrollElementRef={scrollElementRef} data-testid="shared-layout">
          <VirtualizedTaskStack
            items={items}
            scrollElementRef={scrollElementRef}
            estimateSize={100}
            gap={0}
            getItemKey={(item) => item.id}
            renderItem={(item) => <span>{item.id}</span>}
          />
          <VirtualizedTaskStack
            items={items}
            scrollElementRef={scrollElementRef}
            estimateSize={100}
            gap={0}
            getItemKey={(item) => `later-${item.id}`}
            renderItem={(item) => <span>{item.id}</span>}
          />
        </TaskVirtualLayout>
      </div>
    );
  }

  render(<TwoStackHarness />);
  const scrollElement = screen.getByTestId("shared-scroll");
  const layoutElement = screen.getByTestId("shared-layout");
  const [, laterStack] = screen.getAllByTestId("task-virtual-window");
  // The later section starts 250k px into the scroll content. At scrollTop
  // 300k, its physical top is -50k and the visible range is around index 500.
  let laterTop = -50_000;
  scrollElement.scrollTop = 300_000;
  scrollElement.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
  laterStack!.getBoundingClientRect = () => ({ top: laterTop } as DOMRect);

  const layoutObserverCount = Array.from(PassiveResizeObserver.instances)
    .filter((observer) => observer.observed.has(layoutElement)).length;
  assert.ok(layoutObserverCount >= 2, `expected both stacks to observe shared layout; got ${layoutObserverCount}`);

  act(() => {
    PassiveResizeObserver.trigger(layoutElement);
    fireEvent.scroll(scrollElement);
  });
  assert.equal(laterStack!.getAttribute("data-scroll-margin"), "250000");
  const initialIndexes = Array.from(laterStack!.querySelectorAll<HTMLElement>("[data-index]"))
    .map((element) => Number(element.dataset.index));
  assert.ok(initialIndexes.some((index) => index >= 495 && index <= 505));

  // A preceding section collapsed/measured 150k shorter. The later stack's
  // own size/items did not change; only its physical top moved. Its visible
  // range must rebase around index 2000 without a window.resize crutch.
  laterTop = -200_000;
  act(() => PassiveResizeObserver.trigger(layoutElement));
  assert.equal(
    laterStack!.getAttribute("data-scroll-margin"),
    "100000",
    "later stack kept stale coordinates after a preceding section changed extent",
  );
  const rebasedIndexes = Array.from(laterStack!.querySelectorAll<HTMLElement>("[data-index]"))
    .map((element) => Number(element.dataset.index));
  assert.ok(
    rebasedIndexes.some((index) => index >= 1_995 && index <= 2_005),
    `later section kept the stale mounted range: ${rebasedIndexes.join(",")}`,
  );
});

test("a batch prepend beyond overscan preserves the shared visible keyed anchor", async () => {
  function MutableStackHarness({ items }: { items: typeof tasks }) {
    const scrollElementRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={scrollElementRef} data-task-virtual-scroll data-testid="mutable-scroll">
        <TaskVirtualLayout scrollElementRef={scrollElementRef}>
          <VirtualizedTaskStack
            items={items}
            scrollElementRef={scrollElementRef}
            estimateSize={100}
            gap={10}
            getItemKey={(task) => task.id}
            renderItem={(task) => <span data-task-id={task.id}>{task.title}</span>}
          />
        </TaskVirtualLayout>
      </div>
    );
  }

  const { rerender } = render(<MutableStackHarness items={tasks} />);
  const scrollElement = screen.getByTestId("mutable-scroll");
  scrollElement.getBoundingClientRect = () => ({
    top: 0, bottom: 720, left: 0, right: 320,
  } as DOMRect);
  scrollElement.scrollTo = ((options: ScrollToOptions) => {
    if (typeof options.top === "number") scrollElement.scrollTop = options.top;
  }) as typeof scrollElement.scrollTo;
  scrollElement.scrollTop = 200_000;
  act(() => fireEvent.scroll(scrollElement));
  for (const row of screen.getAllByTestId("task-virtual-row")) {
    row.getBoundingClientRect = () => {
      const top = Number(row.dataset.index) * 110 - scrollElement.scrollTop;
      return { top, bottom: top + 100, left: 0, right: 320 } as DOMRect;
    };
  }
  act(() => fireEvent.scroll(scrollElement));
  await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
  const before = document.querySelector<HTMLElement>('[data-task-id="task-1818"]');
  assert.ok(before, "expected the keyed task at the viewport offset to be mounted before prepend");

  const prepended = [
    ...Array.from({ length: 100 }, (_, index) => ({
      id: `new-task-${index}`,
      title: `New task ${index}`,
    })),
    ...tasks,
  ];
  rerender(<MutableStackHarness items={prepended} />);
  assert.equal(
    document.querySelector('[data-task-id="task-1818"]'),
    null,
    "the batch did not evict the old visible anchor, so the fallback path was not exercised",
  );
  assert.equal(
    scrollElement.scrollTop,
    211_000,
    "a prepend larger than overscan lost the unmounted keyed anchor",
  );
});

test("late row measurement converges through the RAF settle pass", async (t) => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  let nextFrameId = 1;
  const queuedFrames = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextFrameId++;
    queuedFrames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    queuedFrames.delete(id);
  };
  t.after(() => {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });
  const flushFrame = () => act(() => {
    const callbacks = Array.from(queuedFrames.values());
    queuedFrames.clear();
    for (const callback of callbacks) callback(0);
  });

  function MutableStackHarness({ items }: { items: typeof tasks }) {
    const scrollElementRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={scrollElementRef} data-task-virtual-scroll data-testid="settle-scroll">
        <TaskVirtualLayout scrollElementRef={scrollElementRef}>
          <VirtualizedTaskStack
            items={items}
            scrollElementRef={scrollElementRef}
            estimateSize={100}
            gap={10}
            getItemKey={(task) => task.id}
            renderItem={(task) => <span>{task.title}</span>}
          />
        </TaskVirtualLayout>
      </div>
    );
  }

  render(<MutableStackHarness items={tasks} />);
  const scrollElement = screen.getByTestId("settle-scroll");
  scrollElement.getBoundingClientRect = () => ({
    top: 0, bottom: 720, left: 0, right: 320,
  } as DOMRect);
  scrollElement.scrollTo = ((options: ScrollToOptions) => {
    if (typeof options.top === "number") scrollElement.scrollTop = options.top;
  }) as typeof scrollElement.scrollTo;
  let lateMeasurement = 0;
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function getMeasuredTaskRowRect() {
    if (this.matches('[data-testid="task-virtual-row"]')) {
      const top = Number(this.dataset.index) * 110 - scrollElement.scrollTop + lateMeasurement;
      return { top, bottom: top + 100, left: 0, right: 320 } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
  t.after(() => {
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  scrollElement.scrollTop = 200_000;
  act(() => fireEvent.scroll(scrollElement));
  flushFrame();

  const layoutElement = document.querySelector<HTMLElement>("[data-task-virtual-layout-root]");
  assert.ok(layoutElement);
  lateMeasurement = 30;
  act(() => PassiveResizeObserver.triggerSingleTarget(layoutElement));
  assert.equal(scrollElement.scrollTop, 200_030, "the first measured-size delta was not compensated");
  assert.ok(queuedFrames.size > 0, "the first correction did not schedule a settle frame");

  lateMeasurement = 45;
  flushFrame();
  assert.equal(
    scrollElement.scrollTop,
    200_045,
    "the late measured-size delta was not consumed by a subsequent settle pass",
  );
});

test("wheel and pointer input cancel a pending settle before it can pull the user back", async (t) => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  let nextFrameId = 1;
  const queuedFrames = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextFrameId++;
    queuedFrames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    queuedFrames.delete(id);
  };
  t.after(() => {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });
  const flushFrame = () => act(() => {
    const callbacks = Array.from(queuedFrames.values());
    queuedFrames.clear();
    for (const callback of callbacks) callback(0);
  });

  function InputCancelHarness() {
    const scrollElementRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={scrollElementRef} data-task-virtual-scroll data-testid="input-cancel-scroll">
        <TaskVirtualLayout scrollElementRef={scrollElementRef}>
          <VirtualizedTaskStack
            items={tasks}
            scrollElementRef={scrollElementRef}
            estimateSize={100}
            gap={10}
            getItemKey={(task) => task.id}
            renderItem={(task) => <span>{task.title}</span>}
          />
        </TaskVirtualLayout>
      </div>
    );
  }

  let activeScrollElement: HTMLElement | null = null;
  let lateMeasurement = 0;
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function getInputCancelTaskRect() {
    if (activeScrollElement && this.matches('[data-testid="task-virtual-row"]')) {
      const top = Number(this.dataset.index) * 110 - activeScrollElement.scrollTop + lateMeasurement;
      return { top, bottom: top + 100, left: 0, right: 320 } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
  t.after(() => {
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  for (const input of ["wheel", "pointerdown"] as const) {
    const view = render(<InputCancelHarness />);
    const scrollElement = screen.getByTestId("input-cancel-scroll");
    activeScrollElement = scrollElement;
    scrollElement.getBoundingClientRect = () => ({
      top: 0, bottom: 720, left: 0, right: 320,
    } as DOMRect);
    scrollElement.scrollTo = ((options: ScrollToOptions) => {
      if (typeof options.top === "number") scrollElement.scrollTop = options.top;
    }) as typeof scrollElement.scrollTo;

    scrollElement.scrollTop = 200_000;
    act(() => fireEvent.scroll(scrollElement));
    flushFrame();
    const layoutElement = view.container.querySelector<HTMLElement>("[data-task-virtual-layout-root]");
    assert.ok(layoutElement);
    lateMeasurement = 30;
    act(() => PassiveResizeObserver.triggerSingleTarget(layoutElement));
    assert.ok(queuedFrames.size > 0, `${input} case did not begin with a pending settle`);

    if (input === "wheel") fireEvent.wheel(scrollElement);
    else fireEvent.pointerDown(scrollElement);
    scrollElement.scrollTop = 210_000;
    lateMeasurement = 45;
    flushFrame();
    assert.equal(
      scrollElement.scrollTop,
      210_000,
      `${input} did not cancel the pending settle before the user scroll`,
    );

    view.unmount();
    activeScrollElement = null;
    lateMeasurement = 0;
    queuedFrames.clear();
  }
});

test("a departed key cannot mask the surviving anchor through a transient empty settle frame", async (t) => {
  function MutableStackHarness({ items }: { items: typeof tasks }) {
    const scrollElementRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={scrollElementRef} data-task-virtual-scroll data-testid="roundtrip-scroll">
        <TaskVirtualLayout scrollElementRef={scrollElementRef}>
          <VirtualizedTaskStack
            items={items}
            scrollElementRef={scrollElementRef}
            estimateSize={100}
            gap={10}
            getItemKey={(task) => task.id}
            renderItem={(task) => <span>{task.title}</span>}
          />
        </TaskVirtualLayout>
      </div>
    );
  }

  const { rerender } = render(<MutableStackHarness items={tasks} />);
  const scrollElement = screen.getByTestId("roundtrip-scroll");
  scrollElement.getBoundingClientRect = () => ({
    top: 0, bottom: 720, left: 0, right: 320,
  } as DOMRect);
  scrollElement.scrollTo = ((options: ScrollToOptions) => {
    if (typeof options.top === "number") scrollElement.scrollTop = options.top;
  }) as typeof scrollElement.scrollTo;

  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function getTaskRowRect() {
    if (this.matches('[data-testid="task-virtual-row"]')) {
      const top = Number(this.dataset.index) * 110 - scrollElement.scrollTop;
      return { top, bottom: top + 100, left: 0, right: 320 } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
  t.after(() => {
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  scrollElement.scrollTop = 200_000;
  act(() => fireEvent.scroll(scrollElement));
  await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));

  const movedIndex = 1_818;
  rerender(<MutableStackHarness items={tasks.filter((_, index) => index !== movedIndex)} />);
  assert.equal(scrollElement.scrollTop, 199_890, "removing the visible row did not preserve its successor");

  // jsdom's virtualizer window is transiently empty during these settle
  // frames, so there is no new viewport capture. A rapid reverse update must
  // therefore continue from the surviving source key, not resurrect the key
  // that already departed this collection. A real settled browser viewport
  // recaptures its current first-visible row and anchors subsequent updates to
  // that newer key instead.
  await act(() => new Promise((resolve) => requestAnimationFrame(() => {
    requestAnimationFrame(() => resolve(undefined));
  })));
  rerender(<MutableStackHarness items={tasks} />);
  assert.equal(
    scrollElement.scrollTop,
    200_000,
    "the departed key masked the surviving anchor during rapid reinsertion",
  );
});

test("a cross-column move has one shared anchor writer regardless of target stack", async () => {
  const sourceTasks = tasks;
  const targetTasks = [
    { id: "target-0", title: "Target 0" },
    { id: "target-1", title: "Target 1" },
  ];

  function BoardHarness({
    source,
    target,
  }: {
    source: typeof tasks;
    target: typeof tasks;
  }) {
    const scrollElementRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={scrollElementRef} data-task-virtual-scroll data-testid="board-scroll">
        <TaskVirtualLayout scrollElementRef={scrollElementRef}>
          {/* Target intentionally mounts first: stack/effect order must not be
              able to overwrite the single shared anchor decision. */}
          <div data-stack="target">
            <VirtualizedTaskStack
              items={target}
              scrollElementRef={scrollElementRef}
              estimateSize={100}
              gap={10}
              getItemKey={(task) => task.id}
              renderItem={(task) => <button type="button">{task.title}</button>}
            />
          </div>
          <div data-stack="source">
            <VirtualizedTaskStack
              items={source}
              scrollElementRef={scrollElementRef}
              estimateSize={100}
              gap={10}
              getItemKey={(task) => task.id}
              renderItem={(task) => <button type="button">{task.title}</button>}
            />
          </div>
        </TaskVirtualLayout>
      </div>
    );
  }

  const { rerender } = render(<BoardHarness source={sourceTasks} target={targetTasks} />);
  const scrollElement = screen.getByTestId("board-scroll");
  scrollElement.getBoundingClientRect = () => ({
    top: 0, bottom: 720, left: 0, right: 660,
  } as DOMRect);
  scrollElement.scrollTo = ((options: ScrollToOptions) => {
    if (typeof options.top === "number") scrollElement.scrollTop = options.top;
  }) as typeof scrollElement.scrollTo;
  scrollElement.scrollTop = 200_000;
  act(() => fireEvent.scroll(scrollElement));

  const sourceRows = Array.from(document.querySelectorAll<HTMLElement>('[data-stack="source"] [data-task-virtual-key]'));
  const targetRows = Array.from(document.querySelectorAll<HTMLElement>('[data-stack="target"] [data-task-virtual-key]'));
  for (const row of sourceRows) {
    row.getBoundingClientRect = () => {
      const top = Number(row.dataset.index) * 110 - scrollElement.scrollTop;
      return { top, bottom: top + 100, left: 0, right: 320 } as DOMRect;
    };
  }
  for (const row of targetRows) {
    row.getBoundingClientRect = () => {
      const top = Number(row.dataset.index) * 110 - scrollElement.scrollTop;
      return { top, bottom: top + 100, left: 340, right: 660 } as DOMRect;
    };
  }
  act(() => fireEvent.scroll(scrollElement));
  await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));

  const anchor = sourceRows.find((row) => {
    const rect = row.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < 720;
  });
  assert.ok(anchor, "expected a visible source-column anchor");
  const movedIndex = Number(anchor.dataset.index);
  const movedTask = sourceTasks[movedIndex]!;

  rerender(
    <BoardHarness
      source={sourceTasks.filter((_, index) => index !== movedIndex)}
      target={[movedTask, ...targetTasks]}
    />,
  );

  assert.equal(
    scrollElement.scrollTop,
    199_890,
    "source and offscreen target stacks wrote competing shared-scroll anchor adjustments",
  );
});

test("Tab at a mounted-window edge advances to the next logical task instead of leaving the list", () => {
  function KeyboardHarness() {
    const scrollElementRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={scrollElementRef} data-task-virtual-scroll data-testid="keyboard-scroll">
        <TaskVirtualLayout scrollElementRef={scrollElementRef}>
          <VirtualizedTaskStack
            items={tasks.slice(0, 100)}
            scrollElementRef={scrollElementRef}
            estimateSize={100}
            gap={10}
            getItemKey={(task) => task.id}
            renderItem={(task) => <button type="button">{task.title}</button>}
          />
        </TaskVirtualLayout>
      </div>
    );
  }

  render(<KeyboardHarness />);
  const scrollElement = screen.getByTestId("keyboard-scroll");
  Object.defineProperties(scrollElement, {
    clientHeight: { configurable: true, value: 720 },
    scrollHeight: { configurable: true, value: 11_000 },
  });
  scrollElement.scrollTo = ((options: ScrollToOptions) => {
    if (typeof options.top === "number") scrollElement.scrollTop = options.top;
  }) as typeof scrollElement.scrollTo;
  const rows = screen.getAllByTestId("task-virtual-row");
  const lastMountedButton = rows[rows.length - 1]!.querySelector("button");
  assert.ok(lastMountedButton);
  lastMountedButton.focus();

  const wasNotCancelled = fireEvent.keyDown(lastMountedButton, { key: "Tab" });
  assert.equal(wasNotCancelled, false, "Tab escaped after the last mounted row even though more tasks exist");
  assert.ok(scrollElement.scrollTop > 0, "Tab did not advance the virtual window to the next logical task");

  const forwardOffset = scrollElement.scrollTop;
  act(() => fireEvent.scroll(scrollElement));
  const shiftedRows = screen.getAllByTestId("task-virtual-row");
  const firstMountedButton = shiftedRows[0]!.querySelector("button");
  assert.ok(firstMountedButton);
  firstMountedButton.focus();
  const backwardWasNotCancelled = fireEvent.keyDown(firstMountedButton, { key: "Tab", shiftKey: true });
  assert.equal(
    backwardWasNotCancelled,
    false,
    "Shift+Tab escaped before the first mounted row even though earlier tasks exist",
  );
  assert.ok(
    scrollElement.scrollTop < forwardOffset,
    "Shift+Tab did not move the virtual window to the previous logical task",
  );
});
