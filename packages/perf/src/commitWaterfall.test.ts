import { describe, expect, it } from "vitest";
import {
  type MinimalFiber,
  type RawCommitCapture,
  attributeCommitDurationsFromTrace,
  installCommitWaterfallHook,
  summarizeCommitWaterfall,
  walkCommittedFiberRoot,
} from "./commitWaterfall";

function makeFiber(
  tag: number,
  type: unknown,
  flags = 0,
  alternate: MinimalFiber | null = null,
): MinimalFiber {
  return { tag, type, flags, alternate, return: null, child: null, sibling: null };
}

describe("walkCommittedFiberRoot", () => {
  it("counts mounted and updated fibers while skipping stale PerformedWork flags under bailed-out memo subtrees", () => {
    function ChatPanel() {}
    function ConnectedMessageItem() {}
    function MessageHoverToolbar() {}

    // Commit 1: mount ChatPanel -> MemoRow1 (with inner toolbar) + MemoRow2
    const root1 = makeFiber(3, null);
    const panel1 = makeFiber(0, ChatPanel, 1);
    const row1Mount = makeFiber(15, ConnectedMessageItem, 1);
    const toolbar1 = makeFiber(0, MessageHoverToolbar, 1);
    const row2Mount = makeFiber(15, ConnectedMessageItem, 1);

    root1.child = panel1;
    panel1.return = root1;
    panel1.child = row1Mount;
    row1Mount.return = panel1;
    row1Mount.child = toolbar1;
    toolbar1.return = row1Mount;
    row1Mount.sibling = row2Mount;
    row2Mount.return = panel1;

    const boundaries = new WeakMap<MinimalFiber, string>();
    boundaries.set(row1Mount, "msg-1");
    boundaries.set(row2Mount, "msg-2");

    const first = walkCommittedFiberRoot(root1, boundaries);
    expect(first.fiberMounts).toBe(4);
    expect(first.fiberUpdates).toBe(0);
    expect(first.rowMounts).toBe(2);
    expect(first.rowUpdates).toBe(0);
    expect(first.renderedRowIds).toEqual(["msg-1", "msg-2"]);

    // Commit 2: ChatPanel updates (flags=1), row1 bails out (flags=0, child === row1Mount.child -> toolbar1 keeps stale flags=1!),
    // while row2 genuinely re-renders (flags=1).
    const root2 = makeFiber(3, null, 0, root1);
    const panel2 = makeFiber(0, ChatPanel, 1, panel1);
    const row1Bailed = makeFiber(15, ConnectedMessageItem, 0, row1Mount);
    row1Bailed.child = toolbar1; // identical child pointer -> bailed out!
    const row2Updated = makeFiber(15, ConnectedMessageItem, 1, row2Mount);

    root2.child = panel2;
    panel2.child = row1Bailed;
    row1Bailed.sibling = row2Updated;
    boundaries.set(row1Bailed, "msg-1");
    boundaries.set(row2Updated, "msg-2");

    const second = walkCommittedFiberRoot(root2, boundaries);
    // Only ChatPanel + row2Updated rendered; row1Bailed and stale toolbar1 are NOT counted!
    expect(second.fiberMounts).toBe(0);
    expect(second.fiberUpdates).toBe(2);
    expect(second.rowMounts).toBe(0);
    expect(second.rowUpdates).toBe(1);
    expect(second.renderedRowIds).toEqual(["msg-2"]);
    expect(second.topComponents).toEqual([
      { name: "ChatPanel", count: 1 },
      { name: "ConnectedMessageItem", count: 1 },
    ]);
  });
});

describe("summarizeCommitWaterfall", () => {
  it("computes phase counts, pre-scroller starvation delay, single-batch row mounts, and per-row render counts", () => {
    const capture: RawCommitCapture = {
      rendererAttached: true,
      droppedCommits: 0,
      commits: [
        {
          index: 1,
          atMs: 40,
          walkMs: 0.2,
          scrollerMounted: false,
          domRows: 0,
          fiberMounts: 12,
          fiberUpdates: 0,
          rowMounts: 0,
          rowUpdates: 0,
          renderedRowIds: [],
          topComponents: [{ name: "AppShell", count: 1 }],
        },
        {
          index: 2,
          atMs: 320,
          walkMs: 0.3,
          scrollerMounted: false,
          domRows: 0,
          fiberMounts: 5,
          fiberUpdates: 18,
          rowMounts: 0,
          rowUpdates: 0,
          renderedRowIds: [],
          topComponents: [{ name: "Composer", count: 8 }],
        },
        {
          index: 3,
          atMs: 1631.3,
          walkMs: 0.4,
          scrollerMounted: true,
          domRows: 0,
          fiberMounts: 8,
          fiberUpdates: 4,
          rowMounts: 0,
          rowUpdates: 0,
          renderedRowIds: [],
          topComponents: [{ name: "VirtualList", count: 1 }],
        },
        {
          index: 4,
          atMs: 1807.2,
          walkMs: 1.5,
          scrollerMounted: true,
          domRows: 2,
          fiberMounts: 20,
          fiberUpdates: 2,
          rowMounts: 2,
          rowUpdates: 0,
          renderedRowIds: ["m1", "m2"],
          topComponents: [{ name: "ConnectedMessageItem", count: 2 }],
        },
        {
          index: 5,
          atMs: 1938.8,
          walkMs: 1.2,
          scrollerMounted: true,
          domRows: 2,
          fiberMounts: 0,
          fiberUpdates: 14,
          rowMounts: 0,
          rowUpdates: 2,
          renderedRowIds: ["m1", "m2"],
          topComponents: [{ name: "ConnectedMessageItem", count: 2 }],
        },
        {
          index: 6,
          atMs: 2210,
          walkMs: 1.0,
          scrollerMounted: true,
          domRows: 2,
          fiberMounts: 0,
          fiberUpdates: 10,
          rowMounts: 0,
          rowUpdates: 1,
          renderedRowIds: ["m2"],
          topComponents: [{ name: "ConnectedMessageItem", count: 1 }],
        },
      ],
    };

    const summary = summarizeCommitWaterfall(capture, {
      kind: "startup",
      messagesStartMs: 69.1,
      messagesResponseEndMs: 815.0,
      paintedMs: 1970.6,
      settleEndMs: 3970.6,
    });

    expect(summary.totalCommits).toBe(6);
    expect(summary.byPhase).toEqual({
      beforeRequest: 1,
      inFlight: 1,
      responseToPaint: 3,
      postPaintSettle: 1,
      switchWindow: 0,
    });
    expect(summary.commitsBeforeScrollerMount).toBe(2);
    expect(summary.scrollerMountAtMs).toBe(1631.3);
    expect(summary.scrollerMountDelayAfterResponseMs).toBe(816.3);
    expect(summary.firstRowMountAtMs).toBe(1807.2);
    expect(summary.prePaintRowMountCommits).toBe(1);
    expect(summary.rows).toEqual({
      distinctRows: 2,
      mounts: 2,
      prePaintUpdates: 2,
      postPaintUpdates: 1,
      totalUpdates: 3,
      rendersPerRow: {
        min: 2,
        median: 2.5,
        max: 3,
      },
    });
  });

  it("filters and rebases timestamps on switch-window captures", () => {
    const capture: RawCommitCapture = {
      rendererAttached: true,
      droppedCommits: 0,
      commits: [
        {
          index: 1,
          atMs: 500,
          walkMs: 0.2,
          scrollerMounted: true,
          domRows: 5,
          fiberMounts: 0,
          fiberUpdates: 3,
          rowMounts: 0,
          rowUpdates: 0,
          renderedRowIds: [],
          topComponents: [],
        },
        {
          index: 2,
          atMs: 1050,
          walkMs: 0.5,
          scrollerMounted: true,
          domRows: 10,
          fiberMounts: 10,
          fiberUpdates: 4,
          rowMounts: 10,
          rowUpdates: 0,
          renderedRowIds: ["r1", "r2"],
          topComponents: [],
        },
      ],
    };
    const summary = summarizeCommitWaterfall(capture, {
      kind: "switch",
      startPerfNowMs: 1000,
      windowMs: 3000,
    });
    expect(summary.totalCommits).toBe(1);
    expect(summary.byPhase.switchWindow).toBe(1);
    expect(summary.commits[0]?.atMs).toBe(50);
  });

  it("attributes per-commit durations from Chrome trace marks and deduplicates shared slices in totalCommitMs", () => {
    const traceEvents = [
      // Enclosing slice 1 (20ms): contains commits 1 and 2 (synchronous layout-effect nested commit)
      { name: "RunMicrotasks", ph: "X", pid: 1, tid: 2, ts: 100_000, dur: 20_000 },
      { name: "__raft_perf_commit_1", ph: "R", pid: 1, tid: 2, ts: 105_000 },
      { name: "__raft_perf_commit_2", ph: "R", pid: 1, tid: 2, ts: 112_000 },
      // Enclosing slice 2 (35ms): contains commit 3
      { name: "FunctionCall", ph: "X", pid: 1, tid: 2, ts: 200_000, dur: 35_000 },
      { name: "__raft_perf_commit_3", ph: "R", pid: 1, tid: 2, ts: 210_000 },
    ];
    const map = attributeCommitDurationsFromTrace(traceEvents);
    expect(map.get(1)?.sliceDurationMs).toBe(20);
    expect(map.get(2)?.sliceKey).toBe(map.get(1)?.sliceKey);
    expect(map.get(3)?.sliceDurationMs).toBe(35);

    const capture: RawCommitCapture = {
      rendererAttached: true,
      droppedCommits: 0,
      commits: [
        { index: 1, atMs: 105, walkMs: 1.0, scrollerMounted: true, domRows: 1, fiberMounts: 1, fiberUpdates: 0, rowMounts: 1, rowUpdates: 0, renderedRowIds: [], topComponents: [] },
        { index: 2, atMs: 112, walkMs: 0.5, scrollerMounted: true, domRows: 1, fiberMounts: 0, fiberUpdates: 1, rowMounts: 0, rowUpdates: 0, renderedRowIds: [], topComponents: [] },
        { index: 3, atMs: 210, walkMs: 2.0, scrollerMounted: true, domRows: 2, fiberMounts: 1, fiberUpdates: 0, rowMounts: 1, rowUpdates: 0, renderedRowIds: [], topComponents: [] },
      ],
    };
    const summary = summarizeCommitWaterfall(
      capture,
      { kind: "startup", messagesStartMs: 50, messagesResponseEndMs: 100, paintedMs: 300, settleEndMs: 500 },
      traceEvents,
    );
    expect(summary.commits[0]?.durationMs).toBe(19);
    expect(summary.commits[2]?.durationMs).toBe(33);
    // Slice 1 counted once (19ms) + Slice 2 (33ms) = 52ms total; max = 33ms
    expect(summary.totalCommitMs).toBe(52);
    expect(summary.maxCommitMs).toBe(33);
  });
});

describe("installCommitWaterfallHook (in-browser code path & nested inner memo resilience)", () => {
  it("picks the outermost per-row memo boundary even when an inner child inside the row is also wrapped in memo()", () => {
    function VirtualListShared() {}
    function OuterRowMemo() {}
    function InnerBodyMemo() {}

    // Build synthetic fiber tree: Root -> VirtualListShared -> ScrollerDiv -> [RowWrapper -> OuterRowMemo (15) -> InnerBodyMemo (15) -> MsgDiv]
    const root1 = makeFiber(3, null);
    const list1 = makeFiber(0, VirtualListShared, 1);
    const scrollerHost1 = makeFiber(5, "div", 0);
    const outerMemo1 = makeFiber(15, OuterRowMemo, 1);
    const innerMemo1 = makeFiber(15, InnerBodyMemo, 1);
    const msgHost1 = makeFiber(5, "div", 0);

    root1.child = list1;
    list1.return = root1;
    list1.child = scrollerHost1;
    scrollerHost1.return = list1;
    scrollerHost1.child = outerMemo1;
    outerMemo1.return = scrollerHost1;
    outerMemo1.child = innerMemo1;
    innerMemo1.return = outerMemo1;
    innerMemo1.child = msgHost1;
    msgHost1.return = innerMemo1;

    const fakeScrollerEl = {
      __reactFiber$test: scrollerHost1,
      getAttribute: () => null,
    };
    const fakeMsgEl = {
      __reactFiber$test: msgHost1,
      getAttribute: (attr: string) => (attr === "data-message-id" ? "row-alpha" : null),
    };

    const g = globalThis as unknown as Record<string, unknown>;
    const prevWindow = g.window;
    const prevDocument = g.document;
    try {
      const mockWindow: Record<string, unknown> = {};
      g.window = mockWindow;
      g.document = {
        querySelector: (sel: string) => (sel === "[data-testid=message-scroller]" ? fakeScrollerEl : null),
        querySelectorAll: (sel: string) => (sel.includes("data-message-id") ? [fakeMsgEl] : []),
      };

      // Execute the serialized browser hook directly
      const serialized = `(${installCommitWaterfallHook.toString()})();`;
      new Function(serialized)();

      const hook = mockWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__ as {
        onCommitFiberRoot: (id: number, root: { current: MinimalFiber }) => void;
      };
      const api = mockWindow.__raftPerfCommits as { read: () => RawCommitCapture };

      // Commit 1: initial mount -> rowMounts = 1
      hook.onCommitFiberRoot(1, { current: root1 });

      // Commit 2: OuterRowMemo re-renders (flags=1), while InnerBodyMemo bails out (flags=0)!
      // Because boundary selection picked OuterRowMemo (outermost exclusive memo), this MUST count as a rowUpdate!
      const root2 = makeFiber(3, null, 0, root1);
      const list2 = makeFiber(0, VirtualListShared, 1, list1);
      const scrollerHost2 = makeFiber(5, "div", 0, scrollerHost1);
      const outerMemo2 = makeFiber(15, OuterRowMemo, 1, outerMemo1);
      const innerMemo2Bailed = makeFiber(15, InnerBodyMemo, 0, innerMemo1);
      innerMemo2Bailed.child = msgHost1;

      root2.child = list2;
      list2.return = root2;
      list2.child = scrollerHost2;
      scrollerHost2.return = list2;
      scrollerHost2.child = outerMemo2;
      outerMemo2.return = scrollerHost2;
      outerMemo2.child = innerMemo2Bailed;
      innerMemo2Bailed.return = outerMemo2;
      fakeScrollerEl.__reactFiber$test = scrollerHost2;

      hook.onCommitFiberRoot(1, { current: root2 });

      const captured = api.read();
      expect(captured.rendererAttached).toBe(true);
      expect(captured.commits).toHaveLength(2);
      expect(captured.commits[0]).toMatchObject({ rowMounts: 1, rowUpdates: 0, renderedRowIds: ["row-alpha"] });
      expect(captured.commits[1]).toMatchObject({ rowMounts: 0, rowUpdates: 1, renderedRowIds: ["row-alpha"] });
    } finally {
      if (prevWindow === undefined) delete g.window;
      else g.window = prevWindow;
      if (prevDocument === undefined) delete g.document;
      else g.document = prevDocument;
    }
  });
});
