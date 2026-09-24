// Render-perf probe entry — bundled to an IIFE, attached early via Playwright
// `page.addInitScript({ path })` so it installs BEFORE react-dom mount.
//
// **bippyDirect mode** (Aiden #proj-frontend:9abf1db8 msg=5a9c7edf, after the
// react-scan/lite walkFiber-deadlock spike). react-scan/lite filters fibers
// by `actualDuration != null` before emitting them in `tree`; React 19.2.4
// production builds don't expose `injectProfilingHooks` so all fibers have
// `actualDuration === null` → tree is empty → count gate impossible. Lite is
// only viable when profiling hooks are available (dev / __PROFILE__ build),
// which is NOT the bundle we want to gate.
//
// Doctrine implication (also from this thread, locked into render-perf-
// methodology.md): "react-scan/lite count-gate" is NOT free for prod bundle.
// prod gate must use bippyDirect — bind `instrument({ onCommitFiberRoot })`
// directly + walk the fiber tree using `traverseRenderedFibers` /
// `didFiberRender`, no `actualDuration` dependency.
//
// Self-check (Aiden 22dd5eb4 + 铁根 23020005): probe must observe
// `renderer-injected` + ≥1 commit + non-empty tree, else fail as
// `probe-not-attached` / `hook-attached-but-no-fibers`. Real bug class
// caught here was the lite duration deadlock surfaced as
// `hook-attached-but-no-fibers` instead of as silent "0 renders, all green".

import {
  instrument,
  isCompositeFiber,
  getDisplayName,
  didFiberRender,
} from "bippy";
import type { Fiber, FiberRoot } from "bippy";
import { hasDebugSource } from "bippy/source";

declare global {
  interface Window {
    __RAFT_RENDER_PERF__?: RenderPerfHandle;
  }
}

export interface ComponentRenderRecord {
  componentName: string;
  source: { fileName: string; lineNumber?: number; columnNumber?: number } | null;
  /** Total commits in which this fiber rendered. */
  renderCount: number;
  /** True if any commit had a composite ancestor that ALSO rendered in the
   *  same commit — that's the v0 cascade red-line per Aiden's spec.
   *  Once flipped true, stays true; one cascade in any commit raises the gate. */
  parentCascade: boolean;
}

export interface ProbeState {
  renderer: "injected" | "not-injected";
  /** Total commit events seen since attach. */
  commits: number;
  /** Total composite fibers walked across all commits (sum of fibers reported
   *  per commit). Stays > 0 once a real React tree is walked, even if no
   *  fibers in a commit actually rendered. */
  fibers: number;
  /** Per-component render record, aggregated since last reset. */
  components: Record<string, ComponentRenderRecord>;
  /** Bounded raw-event log for failure-mode discrimination. Excludes per-fiber
   *  noise to keep the buffer signal-rich. */
  rawEvents: Array<{ kind: string; timestamp: number; data?: Record<string, unknown> }>;
}

export type ProbeHealth =
  | "probe-not-attached"
  | "hook-attached-but-no-fibers"
  | "attached-and-committing";

export interface DomNodeRowMetric {
  selector: string;
  matched: boolean;
  componentName: string | null;
  /** Render count for the specific row fiber instance attached to this DOM
   *  node, NOT summed across all instances of the row component. Returns 0
   *  if the row's owning fiber never rendered since `reset()`. */
  renderCount: number;
  /** True iff this row's fiber, in any commit since reset, had a composite
   *  ancestor that ALSO rendered in the same commit. The #2640 sibling-cascade
   *  signal — sibling rows should never see this on a single-row click. */
  parentCascade: boolean;
}

export interface RenderPerfHandle {
  state: () => ProbeState;
  healthCheck: () => ProbeHealth;
  /** Per-DOM-node render metrics keyed off Aiden's #2640 row-scoped gate
   *  contract: each `[data-sidebar-channel-id]` row is its OWN ChannelRow/DmRow
   *  fiber instance, so per-instance counts are what reproduce 102 → 2.
   *  Component-key aggregation (renderCount across all row instances) hides
   *  the cure because clicked-row + sibling-rows share a key. */
  queryDomRows: (selector: string) => DomNodeRowMetric[];
  reset: () => void;
  stop: () => void;
}

const RAW_EVENT_BUFFER_LIMIT = 100;

const state: ProbeState = {
  renderer: "not-injected",
  commits: 0,
  fibers: 0,
  components: {},
  rawEvents: [],
};

function pushRawEvent(kind: string, data?: Record<string, unknown>): void {
  state.rawEvents.push({
    kind,
    timestamp: typeof performance !== "undefined" ? performance.now() : Date.now(),
    data,
  });
  if (state.rawEvents.length > RAW_EVENT_BUFFER_LIMIT) {
    state.rawEvents.splice(0, state.rawEvents.length - RAW_EVENT_BUFFER_LIMIT);
  }
}

function fiberSource(fiber: Fiber): ComponentRenderRecord["source"] {
  // _debugSource is dev-only on React, but React 19 sometimes also populates
  // _debugStack — we don't try the heavier owner-stack path in v0 for cost.
  if (hasDebugSource(fiber)) {
    const s = fiber._debugSource;
    if (s && typeof s.fileName === "string" && s.fileName) {
      return {
        fileName: s.fileName,
        lineNumber: typeof s.lineNumber === "number" ? s.lineNumber : undefined,
        columnNumber: typeof s.columnNumber === "number" ? s.columnNumber : undefined,
      };
    }
  }
  return null;
}

function componentKey(name: string, source: ComponentRenderRecord["source"]): string {
  if (!source) return name;
  return `${name}@${source.fileName}:${source.lineNumber ?? "?"}:${source.columnNumber ?? "?"}`;
}

// Per-fiber record keyed by canonical fiber identity (current/alternate pair
// share one record). Used for the per-DOM-row query API — each row instance
// gets its own count, NOT summed across all rows of the same component.
interface FiberRecord {
  componentName: string;
  renderCount: number;
  parentCascade: boolean;
}

let fiberRecords = new WeakMap<Fiber, FiberRecord>();

// Record-based canonicalization (Aiden msg=ce0c95dd). React keeps two fibers
// per component (current + work-in-progress alternate). `fiber.alternate?.alternate
// === fiber` is true on BOTH sides of the pair, so it cannot pick a canonical
// side. Instead, lookup is record-keyed:
//
//   1. If either side already has a record → use that record.
//   2. If neither side has a record → create one and BIND BOTH keys to it
//      (so a later commit visiting via the alternate finds the same record).
//   3. If both sides have records but they differ → merge into one record,
//      sum the counts, OR the cascade flags, repoint both keys to the merged.
//
// Returns the record to use for this commit. Always pairs `fiber` and
// `fiber.alternate` to the SAME record before returning.
function getOrCreateInstanceRecord(fiber: Fiber, name: string): FiberRecord {
  const a = fiberRecords.get(fiber);
  const altFiber = fiber.alternate;
  const b = altFiber ? fiberRecords.get(altFiber) : undefined;

  if (a && b && a !== b) {
    // Both sides have differing records — merge into one to recover from a
    // race where the alternate slot was visited before its mate was bound.
    const merged: FiberRecord = {
      componentName: a.componentName,
      renderCount: a.renderCount + b.renderCount,
      parentCascade: a.parentCascade || b.parentCascade,
    };
    fiberRecords.set(fiber, merged);
    if (altFiber) fiberRecords.set(altFiber, merged);
    return merged;
  }

  const existing = a ?? b;
  if (existing) {
    // Ensure both keys point to the same record before we return.
    if (!a) fiberRecords.set(fiber, existing);
    if (altFiber && !b) fiberRecords.set(altFiber, existing);
    return existing;
  }

  const fresh: FiberRecord = { componentName: name, renderCount: 0, parentCascade: false };
  fiberRecords.set(fiber, fresh);
  if (altFiber) fiberRecords.set(altFiber, fresh);
  return fresh;
}

function lookupInstanceRecord(fiber: Fiber): FiberRecord | undefined {
  return fiberRecords.get(fiber) ?? (fiber.alternate ? fiberRecords.get(fiber.alternate) : undefined);
}

function recordCommit(root: FiberRoot): void {
  state.commits++;

  // Pass 1: collect every composite fiber that rendered in this commit. We
  // walk the whole tree (no `traverseRenderedFibers` — that helper short-
  // circuits subtrees that didn't render, which we still need for cascade
  // detection because a parent's `didFiberRender` is exactly the signal).
  const renderedFibers = new Set<Fiber>();
  const renderedFiberRecords: Array<{
    fiber: Fiber;
    componentRecord: ComponentRenderRecord;
    instanceRecord: FiberRecord;
  }> = [];

  // Manual depth-first walk; bippy's `traverseFiber` yields each fiber but
  // not in a way that gives us "did this one render". We do our own walk +
  // call `didFiberRender(fiber)` per node.
  const stack: (Fiber | null)[] = [root.current];
  while (stack.length > 0) {
    const fiber = stack.pop();
    if (!fiber) continue;
    state.fibers++;
    if (isCompositeFiber(fiber) && didFiberRender(fiber)) {
      renderedFibers.add(fiber);
      const name = getDisplayName(fiber.type) ?? "Anonymous";
      const source = fiberSource(fiber);
      const key = componentKey(name, source);
      const existing = state.components[key] ?? {
        componentName: name,
        source,
        renderCount: 0,
        parentCascade: false,
      };
      state.components[key] = existing;

      // Per-instance record. Aiden record-based canonicalization keeps
      // current + alternate bound to a single shared record across commits.
      const instanceRecord = getOrCreateInstanceRecord(fiber, name);

      // Defer increments to Pass 2 so cascade detection sees the full set.
      renderedFiberRecords.push({ fiber, componentRecord: existing, instanceRecord });
    }
    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling) stack.push(fiber.sibling);
  }

  // Pass 2: for each rendered fiber, walk `fiber.return` chain and check if
  // any composite ancestor is in the renderedFibers set. If yes → that's a
  // parent cascade for this fiber's component. v0 sticky flag — never
  // un-set within an interaction window.
  for (const { fiber, componentRecord, instanceRecord } of renderedFiberRecords) {
    componentRecord.renderCount++;
    instanceRecord.renderCount++;
    let cascaded = false;
    let ancestor = fiber.return;
    while (ancestor) {
      if (isCompositeFiber(ancestor) && renderedFibers.has(ancestor)) {
        cascaded = true;
        break;
      }
      ancestor = ancestor.return;
    }
    if (cascaded) {
      componentRecord.parentCascade = true;
      instanceRecord.parentCascade = true;
    }
  }
}

// Walk up from a DOM node to its owning React fiber. React stores the fiber
// reference on the DOM element under a key that starts with `__reactFiber$`
// (DOM-to-fiber link), and we then climb `fiber.return` until we hit a
// composite fiber (skipping host elements like the <button>'s host fiber).
function fiberFromDomNode(node: Element): Fiber | null {
  const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return null;
  const hostFiber = (node as unknown as Record<string, Fiber>)[key];
  if (!hostFiber) return null;
  let f: Fiber | null = hostFiber;
  while (f && !isCompositeFiber(f)) {
    f = f.return;
  }
  return f;
}

function queryDomRows(selector: string): DomNodeRowMetric[] {
  const nodes = document.querySelectorAll(selector);
  const result: DomNodeRowMetric[] = [];
  nodes.forEach((node) => {
    const fiber = fiberFromDomNode(node);
    if (!fiber) {
      result.push({
        selector,
        matched: false,
        componentName: null,
        renderCount: 0,
        parentCascade: false,
      });
      return;
    }
    const rec = lookupInstanceRecord(fiber);
    result.push({
      selector,
      matched: true,
      componentName: getDisplayName(fiber.type) ?? "Anonymous",
      renderCount: rec?.renderCount ?? 0,
      parentCascade: rec?.parentCascade ?? false,
    });
  });
  return result;
}

let detachInstrumentation: (() => void) | null = null;

function start(): RenderPerfHandle {
  if (detachInstrumentation) return getApi();

  // bippy `instrument` returns a removal callback (or void if hook patches
  // are sticky); we capture it as best-effort.
  const result = instrument({
    name: "raft-render-perf-probe",
    onActive: () => {
      state.renderer = "injected";
      pushRawEvent("renderer-injected");
    },
    onCommitFiberRoot: (_rendererId, root) => {
      try {
        recordCommit(root);
      } catch (err) {
        pushRawEvent("commit-error", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  detachInstrumentation = typeof result === "function" ? result : () => {};
  return getApi();
}

function getApi(): RenderPerfHandle {
  return {
    state: () => snapshot(),
    healthCheck: () => {
      if (state.renderer !== "injected" || state.commits === 0) return "probe-not-attached";
      if (state.fibers === 0) return "hook-attached-but-no-fibers";
      return "attached-and-committing";
    },
    queryDomRows,
    reset: () => {
      state.commits = 0;
      state.fibers = 0;
      state.components = {};
      state.rawEvents.length = 0;
      // Drop the per-instance fiber map so renderCount / parentCascade per row
      // start at 0 for the next interaction window. WeakMap can't be cleared
      // in place, so we replace the binding.
      fiberRecords = new WeakMap();
      // Note: do NOT reset `renderer` — that's an attach-lifetime fact, not
      // an interaction-scoped counter.
    },
    stop: () => {
      if (detachInstrumentation) {
        try {
          detachInstrumentation();
        } catch {
          // best-effort
        }
        detachInstrumentation = null;
      }
    },
  };
}

function snapshot(): ProbeState {
  return {
    renderer: state.renderer,
    commits: state.commits,
    fibers: state.fibers,
    components: Object.fromEntries(
      Object.entries(state.components).map(([k, v]) => [
        k,
        {
          componentName: v.componentName,
          source: v.source ? { ...v.source } : null,
          renderCount: v.renderCount,
          parentCascade: v.parentCascade,
        },
      ]),
    ),
    rawEvents: state.rawEvents.slice(),
  };
}

window.__RAFT_RENDER_PERF__ = start();
