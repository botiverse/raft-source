// The fiber half of the render-why probe: per commit, which components of the
// watched rows rendered, and what changed for each (renderWhy.ts holds the
// diffing and the aggregation). No bippy import: it reads plain fiber fields,
// so a DOM test can feed it a root directly (renderWhyRecorder.test.tsx).
//
// Which fibers rendered in THIS commit. React's PerformedWork flag alone is
// not enough: when a component bails out without touching its children, the
// children keep the flag of their last render. So the walk follows React
// DevTools' rule: go below a fiber only when it is new (no alternate) or its
// `child` pointer differs from its alternate's (its children were reconciled
// or cloned in this commit); the flags of the fibers reached that way are of
// this commit.
import { addRecord, causesOf, createAggregate, createIdRegistry, diffContexts, diffHooks, diffProps, typeName } from "./renderWhy";
import type { ContextNode, HookNode, RenderRecord, ValueChange, WhyAggregate, HookChange } from "./renderWhy";

/** The fields of a React fiber this file reads. */
export interface WhyFiber {
  tag: number;
  type: unknown;
  flags?: number;
  memoizedProps: unknown;
  memoizedState: unknown;
  dependencies?: { firstContext: ContextNode | null } | null;
  alternate: WhyFiber | null;
  return: WhyFiber | null;
  child: WhyFiber | null;
  sibling: WhyFiber | null;
}

export interface WhySeries {
  /** DOM nodes of the rows. */
  selector: string;
  /** The attribute of such a node that holds the row's id. */
  idAttribute: string;
}

export const DEFAULT_SERIES: Record<string, WhySeries> = {
  // The body first: were both to resolve to one boundary, it is the body's.
  messageBody: { selector: "[data-message-id]:not([data-timeline-message-id])", idAttribute: "data-message-id" },
  timelineRow: { selector: "[data-timeline-message-id]", idAttribute: "data-timeline-message-id" },
};

export interface BoundaryInfo {
  series: string;
  /** The boundary component. */
  name: string;
  /** A memo() component, or the first component above the node when there is none. */
  memo: boolean;
  /** Distinct boundary fibers and the DOM nodes they cover: more nodes than fibers means rows share one boundary. */
  fibers: number;
  nodes: number;
  /** Component names above the boundary, nearest first. */
  ancestors: string[];
}

export interface CommitEntry {
  /** Date.now() of the commit. */
  at: number;
  /** Per series: boundary mounts and updates in this commit. */
  series: Record<string, { mounts: number; updates: number }>;
  /** Where the boundary updates of this commit started. */
  started: string[];
}

export interface WhyReading {
  aggregate: WhyAggregate;
  boundaries: BoundaryInfo[];
  /** Commits in which a watched row rendered, oldest first (capped). */
  timeline: CommitEntry[];
  errors: string[];
}

const FUNCTION = 0;
const CLASS = 1;
const FORWARD_REF = 11;
const MEMO = 14;
const SIMPLE_MEMO = 15;
const PERFORMED_WORK = 1;
const MAX_TIMELINE = 400;
const MAX_PATH = 14;

/** Fibers whose component function runs (a MemoComponent fiber only wraps the one that does). */
const renders = (fiber: WhyFiber) => fiber.tag === FUNCTION || fiber.tag === CLASS || fiber.tag === FORWARD_REF || fiber.tag === SIMPLE_MEMO;
const isMemo = (fiber: WhyFiber) => fiber.tag === SIMPLE_MEMO || fiber.tag === MEMO || fiber.return?.tag === MEMO;
const nameOf = (fiber: WhyFiber) => typeName(fiber.type);

/**
 * The row's boundary: the nearest memo() component above the DOM node's fiber,
 * else the first component above it (renderPerfProbe.ts's rule, so the counts
 * agree). For a MemoComponent fiber the boundary is the fiber it wraps: that
 * is the one that renders.
 */
export function boundaryOf(host: WhyFiber): WhyFiber | null {
  let first: WhyFiber | null = null;
  let below: WhyFiber | null = null;
  for (let f: WhyFiber | null = host; f; below = f, f = f.return) {
    if (f.tag === SIMPLE_MEMO) return f;
    if (f.tag === MEMO) return below && renders(below) ? below : f;
    if (renders(f)) first ??= f;
  }
  return first;
}

function fiberOfNode(node: Element): WhyFiber | null {
  const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
  return key ? ((node as unknown as Record<string, WhyFiber>)[key] ?? null) : null;
}

interface Tracked {
  series: string;
  rowId: string | null;
}

interface Scope {
  series: string;
  rowId: string | null;
  path: string[];
}

export function createWhyRecorder(options: { series?: Record<string, WhySeries>; root?: ParentNode } = {}) {
  const series = options.series ?? DEFAULT_SERIES;
  const ids = createIdRegistry();
  const contextIds = createIdRegistry();
  let instances = new WeakMap<WhyFiber, number>();
  let nextInstance = 1;
  let boundaries = new WeakMap<WhyFiber, Tracked>();
  let boundaryInfo = new Map<string, BoundaryInfo>();
  let aggregate = createAggregate();
  let timeline: CommitEntry[] = [];
  const errors: string[] = [];

  const contextName = (context: object) => {
    const named = (context as { displayName?: unknown }).displayName;
    return typeof named === "string" && named ? named : `#${contextIds.of(context)}`;
  };
  const tracked = (fiber: WhyFiber) => boundaries.get(fiber) ?? (fiber.alternate ? boundaries.get(fiber.alternate) : undefined);
  // The two fibers of an instance share one number.
  const instanceOf = (fiber: WhyFiber) => {
    let id = instances.get(fiber) ?? (fiber.alternate ? instances.get(fiber.alternate) : undefined);
    if (id === undefined) id = nextInstance++;
    instances.set(fiber, id);
    if (fiber.alternate) instances.set(fiber.alternate, id);
    return id;
  };

  /** Registers the boundaries of the rows now in the document. */
  function findBoundaries(): void {
    const root = options.root ?? (typeof document === "undefined" ? null : document);
    if (!root) return;
    for (const [name, config] of Object.entries(series)) {
      const nodes = root.querySelectorAll(config.selector);
      const seen = new Set<WhyFiber>();
      let info = boundaryInfo.get(name);
      nodes.forEach((node) => {
        const host = fiberOfNode(node);
        const boundary = host ? boundaryOf(host) : null;
        if (!boundary) return;
        // One of a pair stands for both, so shared boundaries are counted once.
        const canonical = boundary.alternate && seen.has(boundary.alternate) ? boundary.alternate : boundary;
        seen.add(canonical);
        if (!tracked(boundary)) boundaries.set(boundary, { series: name, rowId: node.getAttribute(config.idAttribute) });
        if (!info) {
          const ancestors: string[] = [];
          for (let f = boundary.return; f && ancestors.length < 30; f = f.return) if (renders(f)) ancestors.push(`${nameOf(f)}${isMemo(f) ? " (memo)" : ""}`);
          info = { series: name, name: nameOf(boundary), memo: isMemo(boundary), fibers: 0, nodes: 0, ancestors };
          boundaryInfo.set(name, info);
        }
      });
      if (info && nodes.length > 0) {
        info.fibers = seen.size;
        info.nodes = nodes.length;
      }
    }
  }

  interface Diff {
    props: ValueChange[];
    hooks: HookChange[];
    contexts: ValueChange[];
    recomputed: number;
  }

  function diffOf(fiber: WhyFiber, cache: Map<WhyFiber, Diff>): Diff {
    let diff = cache.get(fiber);
    if (diff) return diff;
    const before = fiber.alternate;
    if (!before) diff = { props: [], hooks: [], contexts: [], recomputed: 0 };
    else {
      // A class keeps its state object, not a hook list, in memoizedState.
      const hooks = fiber.tag === CLASS ? { hooks: [], recomputed: 0 } : diffHooks(before.memoizedState as HookNode | null, fiber.memoizedState as HookNode | null, ids);
      diff = {
        props: diffProps(before.memoizedProps, fiber.memoizedProps, ids),
        hooks: hooks.hooks,
        contexts: diffContexts(before.dependencies?.firstContext ?? null, fiber.dependencies?.firstContext ?? null, contextName, ids),
        recomputed: hooks.recomputed,
      };
    }
    cache.set(fiber, diff);
    return diff;
  }

  function onCommit(root: { current: WhyFiber }): void {
    aggregate.commits++;
    findBoundaries();
    const rendered = new Set<WhyFiber>();
    const diffs = new Map<WhyFiber, Diff>();
    const entry: CommitEntry = { at: Date.now(), series: {}, started: [] };
    const nearestRendered = (fiber: WhyFiber) => {
      for (let f = fiber.return; f; f = f.return) if (renders(f)) return rendered.has(f) ? f : null;
      return null;
    };

    const stack: Array<{ fiber: WhyFiber; scope: Scope | null }> = [{ fiber: root.current, scope: null }];
    while (stack.length > 0) {
      const { fiber, scope: outer } = stack.pop()!;
      const mounted = fiber.alternate === null;
      let scope = outer;
      if (renders(fiber)) {
        const didRender = mounted || ((fiber.flags ?? 0) & PERFORMED_WORK) === PERFORMED_WORK;
        if (didRender) rendered.add(fiber);
        const own = tracked(fiber);
        const name = nameOf(fiber);
        if (own) scope = { series: own.series, rowId: own.rowId, path: [name] };
        else if (scope) scope = { ...scope, path: scope.path.length < MAX_PATH ? [...scope.path, name] : scope.path };
        if (scope && didRender) {
          const diff = diffOf(fiber, diffs);
          const parent = nearestRendered(fiber);
          const record: RenderRecord = {
            series: scope.series,
            path: scope.path.join(" > "),
            name,
            boundary: Boolean(own),
            memo: isMemo(fiber),
            instance: instanceOf(fiber),
            rowId: scope.rowId,
            phase: mounted ? "mount" : "update",
            ...diff,
            parentRendered: parent !== null,
          };
          if (own) {
            const counts = (entry.series[own.series] ??= { mounts: 0, updates: 0 });
            if (mounted) counts.mounts++;
            else {
              counts.updates++;
              // The chain of rendered components above, up to the one that started it.
              const chain = [name];
              let top = fiber;
              for (let up = nearestRendered(top); up; up = nearestRendered(top)) {
                top = up;
                if (chain.length < 12) chain.unshift(nameOf(up));
              }
              const topDiff = diffOf(top, diffs);
              const causes = causesOf({ phase: top.alternate ? "update" : "mount", memo: isMemo(top), ...topDiff, parentRendered: false });
              record.initiator = { name: nameOf(top), causes, chain };
              const started = `${own.series}: ${nameOf(top)}: ${causes.join(", ")}`;
              if (!entry.started.includes(started) && entry.started.length < 6) entry.started.push(started);
            }
          }
          addRecord(aggregate, record);
        }
      }
      // Below: only what this commit reconciled or cloned.
      if (mounted || fiber.child !== fiber.alternate!.child) {
        for (let child = fiber.child; child; child = child.sibling) stack.push({ fiber: child, scope });
      }
    }
    if (Object.keys(entry.series).length > 0 && timeline.length < MAX_TIMELINE) timeline.push(entry);
  }

  return {
    onCommit(root: { current: WhyFiber }): void {
      try {
        onCommit(root);
      } catch (error) {
        if (errors.length < 20) errors.push(error instanceof Error ? `${error.message}` : String(error));
      }
    },
    read(): WhyReading {
      findBoundaries();
      return { aggregate: JSON.parse(JSON.stringify(aggregate)) as WhyAggregate, boundaries: [...boundaryInfo.values()].map((b) => ({ ...b })), timeline: timeline.slice(), errors: errors.slice() };
    },
    /** Starts a new reading. Rows already on screen stay known, so their updates are still attributed. */
    reset(): void {
      aggregate = createAggregate();
      timeline = [];
      errors.length = 0;
      instances = new WeakMap();
      nextInstance = 1;
      boundaryInfo = new Map();
      boundaries = new WeakMap();
      findBoundaries();
    },
  };
}

export type WhyRecorder = ReturnType<typeof createWhyRecorder>;
