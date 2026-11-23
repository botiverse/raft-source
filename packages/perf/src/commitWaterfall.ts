/**
 * Zero-dependency React Fiber commit waterfall recorder and analyzer for `raft-perf diagnose` (#proj-frontend:#74).
 *
 * Works on standard minified React 18/19 production bundles without profiling builds:
 * React's production reconciler invokes `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot`
 * whenever the hook is installed before `react-dom` loads.
 *
 * Crucial correctness invariants:
 *   1. Zero geometry or computed-style reads inside `onCommitFiberRoot`: only pure DOM
 *      `querySelector`/`querySelectorAll` and React fiber pointers are read, so the probe
 *      never forces layout or style recalculation.
 *   2. Exact React DevTools bailout walk: when a `memo()` or bailed-out component skips
 *      rendering, React clones the boundary fiber (clearing its `PerformedWork` flag) while
 *      leaving descendant fibers untouched with stale `PerformedWork` flags from earlier
 *      commits. Descending only when `fiber.alternate === null || fiber.child !== fiber.alternate.child`
 *      visits strictly the fibers reconciled in THIS commit.
 */

import type { TraceEvent } from "./workSplit";

export type CommitPhase =
  | "before-request"
  | "in-flight"
  | "response-to-paint"
  | "post-paint-settle"
  | "switch-window";

export interface RawCommitRecord {
  index: number;
  atMs: number;
  walkMs: number;
  /** React Fiber `root.current.actualDuration` when available (profiling build); null in standard production builds. */
  actualDurationMs?: number | null;
  scrollerMounted: boolean;
  domRows: number;
  fiberMounts: number;
  fiberUpdates: number;
  rowMounts: number;
  rowUpdates: number;
  /** Row IDs (`data-message-id` / `data-timeline-message-id`) whose owning boundary rendered in this commit. */
  renderedRowIds: string[];
  /** Non-minified component names (`length > 2` or `displayName`) with highest render counts in this commit. */
  topComponents: Array<{ name: string; count: number }>;
}

export interface RawCommitCapture {
  rendererAttached: boolean;
  droppedCommits: number;
  commits: RawCommitRecord[];
}

export interface CommitWaterfallEntry {
  index: number;
  atMs: number;
  phase: CommitPhase;
  /** Commit main-thread duration in ms (React `actualDuration` or enclosing trace JS task minus hook walk), or null if unavailable. */
  durationMs: number | null;
  scrollerMounted: boolean;
  domRows: number;
  fiberMounts: number;
  fiberUpdates: number;
  rowMounts: number;
  rowUpdates: number;
  topComponents: Array<{ name: string; count: number }>;
}

export interface RowRenderDistribution {
  distinctRows: number;
  mounts: number;
  prePaintUpdates: number;
  postPaintUpdates: number;
  totalUpdates: number;
  rendersPerRow: {
    min: number;
    median: number;
    max: number;
  };
}

export interface CommitWaterfallSummary {
  rendererAttached: boolean;
  totalCommits: number;
  droppedCommits: number;
  walkOverheadMs: number;
  /** Total attributed React commit duration in ms across included commits (deduplicated across shared trace tasks), or null when unavailable. */
  totalCommitMs: number | null;
  /** Longest single attributed React commit duration in ms, or null when unavailable. */
  maxCommitMs: number | null;
  byPhase: {
    beforeRequest: number;
    inFlight: number;
    responseToPaint: number;
    postPaintSettle: number;
    switchWindow: number;
  };
  commitsBeforeScrollerMount: number;
  scrollerMountAtMs: number | null;
  /** Delay between `messagesResponseEndMs` and `<MessageTimeline>` first mounting (`scrollerMounted === true`). */
  scrollerMountDelayAfterResponseMs: number | null;
  firstRowMountAtMs: number | null;
  /** Distinct commits before paint that mounted >= 1 message row (`1` = single-batch mount; `> 1` = incremental fill chain). */
  prePaintRowMountCommits: number;
  rows: RowRenderDistribution;
  commits: CommitWaterfallEntry[];
}

/** Minimal fiber shape read by `walkCommittedFiberRoot` (unit-testable in Node without React/DOM). */
export interface MinimalFiber {
  tag: number;
  type: unknown;
  flags?: number;
  alternate: MinimalFiber | null;
  return: MinimalFiber | null;
  child: MinimalFiber | null;
  sibling: MinimalFiber | null;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

function medianInt(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : round1((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Pure fiber walk matching the in-browser `onCommitFiberRoot` logic so unit tests
 * can verify bailout handling and row boundary counting directly.
 */
export function walkCommittedFiberRoot(
  rootCurrent: MinimalFiber,
  rowBoundaries: WeakMap<MinimalFiber, string>,
): {
  fiberMounts: number;
  fiberUpdates: number;
  rowMounts: number;
  rowUpdates: number;
  renderedRowIds: string[];
  topComponents: Array<{ name: string; count: number }>;
} {
  const FUNCTION = 0;
  const CLASS = 1;
  const FORWARD_REF = 11;
  const SIMPLE_MEMO = 15;
  const PERFORMED_WORK = 1;

  const isComposite = (f: MinimalFiber): boolean =>
    f.tag === FUNCTION || f.tag === CLASS || f.tag === FORWARD_REF || f.tag === SIMPLE_MEMO;

  const readableName = (type: unknown): string | null => {
    if (typeof type === "function") {
      const fn = type as { displayName?: unknown; name?: unknown };
      if (typeof fn.displayName === "string" && fn.displayName.length > 0) return fn.displayName;
      if (typeof fn.name === "string" && fn.name.length > 2) return fn.name;
      return null;
    }
    if (typeof type === "object" && type !== null) {
      const obj = type as { displayName?: unknown; type?: unknown; render?: unknown };
      if (typeof obj.displayName === "string" && obj.displayName.length > 0) return obj.displayName;
      if (obj.type) return readableName(obj.type);
      if (obj.render) return readableName(obj.render);
    }
    return null;
  };

  let fiberMounts = 0;
  let fiberUpdates = 0;
  let rowMounts = 0;
  let rowUpdates = 0;
  const renderedRowIds: string[] = [];
  const seenRowIds = new Set<string>();
  const nameCounts = new Map<string, number>();

  const stack: MinimalFiber[] = [rootCurrent];
  while (stack.length > 0) {
    const fiber = stack.pop()!;
    const mounted = fiber.alternate === null;
    if (isComposite(fiber)) {
      const didRender = mounted || ((fiber.flags ?? 0) & PERFORMED_WORK) === PERFORMED_WORK;
      if (didRender) {
        if (mounted) fiberMounts++;
        else fiberUpdates++;
        const name = readableName(fiber.type);
        if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
        const rowId = rowBoundaries.get(fiber) ?? (fiber.alternate ? rowBoundaries.get(fiber.alternate) : undefined);
        if (rowId !== undefined && !seenRowIds.has(rowId)) {
          seenRowIds.add(rowId);
          renderedRowIds.push(rowId);
          if (mounted) rowMounts++;
          else rowUpdates++;
        }
      }
    }
    if (mounted || fiber.child !== fiber.alternate!.child) {
      const children: MinimalFiber[] = [];
      for (let child = fiber.child; child; child = child.sibling) {
        children.push(child);
      }
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]!);
      }
    }
  }

  const topComponents = [...nameCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return { fiberMounts, fiberUpdates, rowMounts, rowUpdates, renderedRowIds, topComponents };
}

/**
 * Self-contained browser init script passed to `page.addInitScript(installCommitWaterfallHook)`.
 * Must not reference module-scoped bindings outside this function body.
 */
export function installCommitWaterfallHook(): void {
  interface BrowserFiber {
    tag: number;
    type: unknown;
    flags?: number;
    actualDuration?: number;
    alternate: BrowserFiber | null;
    return: BrowserFiber | null;
    child: BrowserFiber | null;
    sibling: BrowserFiber | null;
  }
  interface DevToolsHook {
    supportsFiber?: boolean;
    renderers?: Map<number, unknown>;
    inject?: (renderer: unknown) => number;
    onCommitFiberRoot?: (rendererId: number, root: { current?: BrowserFiber }, priorityLevel?: unknown, didError?: boolean) => void;
    onCommitFiberUnmount?: (rendererId: number, fiber: unknown) => void;
    checkDCE?: (fn: unknown) => void;
  }

  const MAX_COMMITS = 500;
  const FUNCTION = 0;
  const CLASS = 1;
  const FORWARD_REF = 11;
  const MEMO = 14;
  const SIMPLE_MEMO = 15;
  const PERFORMED_WORK = 1;

  let rendererAttached = false;
  let commits: RawCommitRecord[] = [];
  let droppedCommits = 0;
  let rowBoundaries = new WeakMap<BrowserFiber, string>();

  const isComposite = (f: BrowserFiber): boolean =>
    f.tag === FUNCTION || f.tag === CLASS || f.tag === FORWARD_REF || f.tag === SIMPLE_MEMO;

  const isMemoWrapper = (f: BrowserFiber): boolean =>
    f.tag === SIMPLE_MEMO || f.tag === MEMO || f.return?.tag === MEMO;

  const readableName = (type: unknown): string | null => {
    if (typeof type === "function") {
      const fn = type as { displayName?: unknown; name?: unknown };
      if (typeof fn.displayName === "string" && fn.displayName.length > 0) return fn.displayName;
      if (typeof fn.name === "string" && fn.name.length > 2) return fn.name;
      return null;
    }
    if (typeof type === "object" && type !== null) {
      const obj = type as { displayName?: unknown; type?: unknown; render?: unknown };
      if (typeof obj.displayName === "string" && obj.displayName.length > 0) return obj.displayName;
      if (obj.type) return readableName(obj.type);
      if (obj.render) return readableName(obj.render);
    }
    return null;
  };

  const fiberOfElement = (el: Element): BrowserFiber | null => {
    const keys = Object.keys(el);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (k.startsWith("__reactFiber$")) {
        return ((el as unknown as Record<string, BrowserFiber | undefined>)[k] ?? null);
      }
    }
    return null;
  };

  /**
   * App-agnostic row boundary resolution:
   *   1. Climb from each row's DOM HostFiber strictly up to (never reaching) the scroller's
   *      HostFiber (`[data-testid=message-scroller]`), collecting composite/memo candidates.
   *   2. Exclude any ancestor shared by > 1 distinct row (handles lists without a testid scroller).
   *   3. Pick the OUTERMOST `memo()` boundary exclusive to that row (falling back to the outermost
   *      exclusive composite fiber), so adding nested `memo()`s inside a row's body/avatar/toolbar
   *      never shifts row attribution away from the row root.
   */
  const registerDomRowBoundaries = (): number => {
    if (typeof document === "undefined") return 0;
    const scrollerEl = document.querySelector("[data-testid=message-scroller]");
    const scrollerHost = scrollerEl ? fiberOfElement(scrollerEl) : null;
    const scrollerStop = new Set<BrowserFiber>();
    if (scrollerHost) {
      scrollerStop.add(scrollerHost);
      if (scrollerHost.alternate) scrollerStop.add(scrollerHost.alternate);
    }

    let nodes = document.querySelectorAll("[data-message-id]:not([data-timeline-message-id])");
    if (nodes.length === 0) {
      nodes = document.querySelectorAll("[data-timeline-message-id], [data-message-id]");
    }

    const chains: Array<{ rowId: string; chain: BrowserFiber[] }> = [];
    const ownerCount = new Map<BrowserFiber, number>();

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const rowId = node.getAttribute("data-message-id") ?? node.getAttribute("data-timeline-message-id") ?? `row-${i}`;
      const host = fiberOfElement(node);
      if (!host) continue;
      // Inner -> outer composite candidates strictly below the scroller element
      const chain: BrowserFiber[] = [];
      let below: BrowserFiber | null = null;
      for (let f: BrowserFiber | null = host; f && !scrollerStop.has(f) && chain.length < 24; below = f, f = f.return) {
        if (f.tag === MEMO) {
          const target = below && isComposite(below) ? below : null;
          if (target && chain[chain.length - 1] !== target) chain.push(target);
        } else if (isComposite(f)) {
          chain.push(f);
        }
      }
      if (chain.length === 0) continue;
      chains.push({ rowId, chain });
      const seenCanonical = new Set<BrowserFiber>();
      for (const cand of chain) {
        const canon = cand.alternate && ownerCount.has(cand.alternate) ? cand.alternate : cand;
        if (seenCanonical.has(canon)) continue;
        seenCanonical.add(canon);
        ownerCount.set(canon, (ownerCount.get(canon) ?? 0) + 1);
      }
    }

    for (const { rowId, chain } of chains) {
      const exclusive = chain.filter((cand) => {
        const count = ownerCount.get(cand) ?? (cand.alternate ? ownerCount.get(cand.alternate) : 0) ?? 0;
        return count <= 1;
      });
      if (exclusive.length === 0) continue;
      let chosen: BrowserFiber | null = null;
      for (let i = exclusive.length - 1; i >= 0; i--) {
        if (isMemoWrapper(exclusive[i]!)) {
          chosen = exclusive[i]!;
          break;
        }
      }
      chosen ??= exclusive[exclusive.length - 1]!;
      rowBoundaries.set(chosen, rowId);
      if (chosen.alternate) rowBoundaries.set(chosen.alternate, rowId);
    }
    return nodes.length;
  };

  const recordRootCommit = (root: { current?: BrowserFiber } | null | undefined): void => {
    rendererAttached = true;
    if (!root || !root.current) return;
    if (commits.length >= MAX_COMMITS) {
      droppedCommits++;
      return;
    }
    const t0 = performance.now();
    const nextIndex = commits.length + 1;
    try {
      performance.mark(`__raft_perf_commit_${nextIndex}`);
    } catch {
      /* ignore mark failures */
    }
    const rawActual = root.current.actualDuration;
    const actualDurationMs =
      typeof rawActual === "number" && Number.isFinite(rawActual) && rawActual >= 0
        ? Math.round(rawActual * 100) / 100
        : null;
    const scrollerMounted = typeof document !== "undefined" && Boolean(document.querySelector("[data-testid=message-scroller]"));
    const domRows = registerDomRowBoundaries();

    let fiberMounts = 0;
    let fiberUpdates = 0;
    let rowMounts = 0;
    let rowUpdates = 0;
    const renderedRowIds: string[] = [];
    const seenRowIds = new Set<string>();
    const nameCounts = new Map<string, number>();

    const stack: BrowserFiber[] = [root.current];
    while (stack.length > 0) {
      const fiber = stack.pop()!;
      const mounted = fiber.alternate === null;
      if (isComposite(fiber)) {
        const didRender = mounted || ((fiber.flags ?? 0) & PERFORMED_WORK) === PERFORMED_WORK;
        if (didRender) {
          if (mounted) fiberMounts++;
          else fiberUpdates++;
          const name = readableName(fiber.type);
          if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
          const rowId = rowBoundaries.get(fiber) ?? (fiber.alternate ? rowBoundaries.get(fiber.alternate) : undefined);
          if (rowId !== undefined && !seenRowIds.has(rowId)) {
            seenRowIds.add(rowId);
            renderedRowIds.push(rowId);
            if (mounted) rowMounts++;
            else rowUpdates++;
          }
        }
      }
      if (mounted || fiber.child !== fiber.alternate!.child) {
        const children: BrowserFiber[] = [];
        for (let child = fiber.child; child; child = child.sibling) {
          children.push(child);
        }
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push(children[i]!);
        }
      }
    }

    const topComponents = [...nameCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    const t1 = performance.now();
    commits.push({
      index: nextIndex,
      atMs: Math.round(t0 * 10) / 10,
      walkMs: Math.round((t1 - t0) * 100) / 100,
      actualDurationMs,
      scrollerMounted,
      domRows,
      fiberMounts,
      fiberUpdates,
      rowMounts,
      rowUpdates,
      renderedRowIds,
      topComponents,
    });
  };

  const win = window as unknown as {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook;
    __raftPerfCommits?: {
      read: () => RawCommitCapture;
      reset: () => void;
    };
  };

  const existing = win.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing) {
    const prevCommit = typeof existing.onCommitFiberRoot === "function" ? existing.onCommitFiberRoot.bind(existing) : null;
    const prevInject = typeof existing.inject === "function" ? existing.inject.bind(existing) : null;
    existing.supportsFiber = true;
    existing.inject = (renderer: unknown): number => {
      rendererAttached = true;
      return prevInject ? prevInject(renderer) : 1;
    };
    existing.onCommitFiberRoot = (rendererId, root, priorityLevel, didError) => {
      try {
        recordRootCommit(root);
      } catch {
        /* never disrupt app commit */
      }
      if (prevCommit) prevCommit(rendererId, root, priorityLevel, didError);
    };
  } else {
    let nextRendererId = 1;
    const renderers = new Map<number, unknown>();
    win.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers,
      inject(renderer: unknown): number {
        rendererAttached = true;
        const id = nextRendererId++;
        renderers.set(id, renderer);
        return id;
      },
      onCommitFiberRoot(_rendererId, root) {
        try {
          recordRootCommit(root);
        } catch {
          /* never disrupt app commit */
        }
      },
      onCommitFiberUnmount() {},
      checkDCE() {},
    };
  }

  win.__raftPerfCommits = {
    read: () => ({
      rendererAttached,
      droppedCommits,
      commits: commits.slice(),
    }),
    reset: () => {
      commits = [];
      droppedCommits = 0;
      rowBoundaries = new WeakMap<BrowserFiber, string>();
      registerDomRowBoundaries();
    },
  };
}

export type CommitTimelineWindow =
  | {
      kind: "startup";
      messagesStartMs: number | null;
      messagesResponseEndMs: number | null;
      paintedMs: number | null;
      settleEndMs: number;
    }
  | {
      kind: "switch";
      startPerfNowMs: number;
      windowMs: number;
    };

const COMMIT_MARK_PREFIX = "__raft_perf_commit_";
const COMMIT_JS_SLICES = new Set([
  "RunMicrotasks",
  "FunctionCall",
  "TimerFire",
  "FireAnimationFrame",
  "EventDispatch",
  "XHRLoad",
  "XHRReadyStateChange",
]);

export interface TraceCommitAttribution {
  /** Attributed slice duration in ms (before subtracting `walkMs`). */
  sliceDurationMs: number;
  /** Enclosing trace slice identity so two synchronous commits inside one task are not double-counted in `totalCommitMs`. */
  sliceKey: string;
}

/**
 * Match `__raft_perf_commit_<index>` marks emitted by `installCommitWaterfallHook`
 * to their innermost enclosing Chrome trace JS slice (`RunMicrotasks`, `FunctionCall`, …)
 * or fallback `RunTask`, giving per-commit durations even on production React builds.
 */
export function attributeCommitDurationsFromTrace(
  events: readonly TraceEvent[] | null | undefined,
): Map<number, TraceCommitAttribution> {
  const out = new Map<number, TraceCommitAttribution>();
  if (!events || events.length === 0) return out;

  const marks: Array<{ index: number; pid: number; tid: number; ts: number }> = [];
  for (const e of events) {
    if (!e.name.startsWith(COMMIT_MARK_PREFIX) || !(e.ts > 0)) continue;
    const idx = Number(e.name.slice(COMMIT_MARK_PREFIX.length));
    if (Number.isInteger(idx) && idx > 0) {
      marks.push({ index: idx, pid: e.pid, tid: e.tid, ts: e.ts });
    }
  }
  if (marks.length === 0) return out;

  const threadKeys = new Set(marks.map((m) => `${m.pid}:${m.tid}`));
  const jsSlices: TraceEvent[] = [];
  const taskSlices: TraceEvent[] = [];
  for (const e of events) {
    if (e.ph !== "X" || !(e.dur && e.dur > 0)) continue;
    if (!threadKeys.has(`${e.pid}:${e.tid}`)) continue;
    if (COMMIT_JS_SLICES.has(e.name)) jsSlices.push(e);
    else if (e.name === "RunTask") taskSlices.push(e);
  }

  for (const mark of marks) {
    let best: TraceEvent | null = null;
    for (const s of jsSlices) {
      if (s.pid !== mark.pid || s.tid !== mark.tid) continue;
      if (s.ts <= mark.ts && s.ts + s.dur! >= mark.ts) {
        if (!best || s.dur! < best.dur!) best = s;
      }
    }
    if (!best) {
      for (const s of taskSlices) {
        if (s.pid !== mark.pid || s.tid !== mark.tid) continue;
        if (s.ts <= mark.ts && s.ts + s.dur! >= mark.ts) {
          if (!best || s.dur! < best.dur!) best = s;
        }
      }
    }
    if (best) {
      out.set(mark.index, {
        sliceDurationMs: best.dur! / 1000,
        sliceKey: `${best.pid}:${best.tid}:${best.ts}:${best.dur}`,
      });
    }
  }
  return out;
}

/** Classify recorded commits into startup/switch phases and compute timeline & row re-render diagnostics. */
export function summarizeCommitWaterfall(
  capture: RawCommitCapture,
  win: CommitTimelineWindow,
  traceEvents?: readonly TraceEvent[] | null,
): CommitWaterfallSummary {
  const byPhase = {
    beforeRequest: 0,
    inFlight: 0,
    responseToPaint: 0,
    postPaintSettle: 0,
    switchWindow: 0,
  };

  const traceDurations = attributeCommitDurationsFromTrace(traceEvents);
  const seenSliceKeys = new Set<string>();
  let totalCommitMsSum = 0;
  let maxCommitMsVal: number | null = null;
  let hasCommitTiming = false;

  let walkOverheadMs = 0;
  let commitsBeforeScrollerMount = 0;
  let scrollerSeen = false;
  let scrollerMountAtMs: number | null = null;
  let firstRowMountAtMs: number | null = null;
  let prePaintRowMountCommits = 0;

  let rowMountsTotal = 0;
  let prePaintRowUpdates = 0;
  let postPaintRowUpdates = 0;
  const rendersPerRowMap = new Map<string, number>();

  const entries: CommitWaterfallEntry[] = [];

  for (const raw of capture.commits) {
    let phase: CommitPhase;
    let relativeAtMs = raw.atMs;
    let isPrePaint = true;

    if (win.kind === "switch") {
      if (raw.atMs < win.startPerfNowMs || raw.atMs > win.startPerfNowMs + win.windowMs) {
        continue;
      }
      relativeAtMs = round1(raw.atMs - win.startPerfNowMs);
      phase = "switch-window";
      byPhase.switchWindow++;
      isPrePaint = true;
    } else {
      if (raw.atMs > win.settleEndMs) continue;
      const painted = win.paintedMs;
      const respEnd = win.messagesResponseEndMs;
      const msgStart = win.messagesStartMs;

      if (painted != null && raw.atMs > painted) {
        phase = "post-paint-settle";
        byPhase.postPaintSettle++;
        isPrePaint = false;
      } else if (respEnd != null && raw.atMs >= respEnd) {
        phase = "response-to-paint";
        byPhase.responseToPaint++;
        isPrePaint = true;
      } else if (msgStart != null && raw.atMs >= msgStart) {
        phase = "in-flight";
        byPhase.inFlight++;
        isPrePaint = true;
      } else {
        phase = "before-request";
        byPhase.beforeRequest++;
        isPrePaint = true;
      }
    }

    walkOverheadMs += raw.walkMs;

    let durationMs: number | null = null;
    if (typeof raw.actualDurationMs === "number" && Number.isFinite(raw.actualDurationMs) && raw.actualDurationMs >= 0) {
      durationMs = round1(raw.actualDurationMs);
      totalCommitMsSum += raw.actualDurationMs;
      maxCommitMsVal = maxCommitMsVal === null ? durationMs : Math.max(maxCommitMsVal, durationMs);
      hasCommitTiming = true;
    } else {
      const attr = traceDurations.get(raw.index);
      if (attr) {
        const netMs = Math.max(0, attr.sliceDurationMs - raw.walkMs);
        durationMs = round1(netMs);
        if (!seenSliceKeys.has(attr.sliceKey)) {
          seenSliceKeys.add(attr.sliceKey);
          totalCommitMsSum += netMs;
        }
        maxCommitMsVal = maxCommitMsVal === null ? durationMs : Math.max(maxCommitMsVal, durationMs);
        hasCommitTiming = true;
      }
    }

    if (!scrollerSeen) {
      if (raw.scrollerMounted) {
        scrollerSeen = true;
        scrollerMountAtMs = relativeAtMs;
      } else {
        commitsBeforeScrollerMount++;
      }
    }

    if (raw.rowMounts > 0) {
      if (firstRowMountAtMs === null) firstRowMountAtMs = relativeAtMs;
      if (isPrePaint) prePaintRowMountCommits++;
    }

    rowMountsTotal += raw.rowMounts;
    if (isPrePaint) prePaintRowUpdates += raw.rowUpdates;
    else postPaintRowUpdates += raw.rowUpdates;

    for (const rowId of raw.renderedRowIds) {
      rendersPerRowMap.set(rowId, (rendersPerRowMap.get(rowId) ?? 0) + 1);
    }

    entries.push({
      index: entries.length + 1,
      atMs: relativeAtMs,
      phase,
      durationMs,
      scrollerMounted: raw.scrollerMounted,
      domRows: raw.domRows,
      fiberMounts: raw.fiberMounts,
      fiberUpdates: raw.fiberUpdates,
      rowMounts: raw.rowMounts,
      rowUpdates: raw.rowUpdates,
      topComponents: raw.topComponents,
    });
  }

  const rowCounts = [...rendersPerRowMap.values()].sort((a, b) => a - b);
  const scrollerMountDelayAfterResponseMs =
    win.kind === "startup" &&
    scrollerMountAtMs !== null &&
    win.messagesResponseEndMs !== null &&
    scrollerMountAtMs >= win.messagesResponseEndMs
      ? round1(scrollerMountAtMs - win.messagesResponseEndMs)
      : null;

  return {
    rendererAttached: capture.rendererAttached,
    totalCommits: entries.length,
    droppedCommits: capture.droppedCommits,
    walkOverheadMs: round1(walkOverheadMs),
    totalCommitMs: hasCommitTiming ? round1(totalCommitMsSum) : null,
    maxCommitMs: hasCommitTiming ? maxCommitMsVal : null,
    byPhase,
    commitsBeforeScrollerMount,
    scrollerMountAtMs,
    scrollerMountDelayAfterResponseMs,
    firstRowMountAtMs,
    prePaintRowMountCommits,
    rows: {
      distinctRows: rowCounts.length,
      mounts: rowMountsTotal,
      prePaintUpdates: prePaintRowUpdates,
      postPaintUpdates: postPaintRowUpdates,
      totalUpdates: prePaintRowUpdates + postPaintRowUpdates,
      rendersPerRow: {
        min: rowCounts[0] ?? 0,
        median: medianInt(rowCounts),
        max: rowCounts[rowCounts.length - 1] ?? 0,
      },
    },
    commits: entries,
  };
}
