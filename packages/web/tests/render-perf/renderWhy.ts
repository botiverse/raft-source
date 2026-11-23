// Why did a component render? The pure half of the render-why probe
// (renderWhyRecorder.ts walks React's fibers and feeds these functions;
// buildProbe.ts `why` bundles both for a page, and this file alone for Node).
//
// Nothing here touches React, the DOM or a bundle, so it is unit-tested as is
// (renderWhy.test.ts). A value is never copied into a record: it is reduced to
// its type, its length or size, its `id` field and an identity number
// (`describeValue`), so a report holds no message text.

export type ChangeKind = "identity" | "value";

/** One changed prop, hook value or context value. `identity`: the content is the
 *  same (shallow), only the reference is new. */
export interface ValueChange {
  key: string;
  kind: ChangeKind;
  prev: string;
  next: string;
  /** Fields of a plain object that differ (first few), when the content changed. */
  inner?: string[];
}

export type HookKind = "state" | "syncExternalStore" | "memo" | "callback" | "effect" | "ref" | "other";

export interface HookChange extends ValueChange {
  /** Position among all hooks of the component, in call order (hooks of custom hooks included). */
  index: number;
  hook: HookKind;
  /** Position among the hooks of the same kind: the 3rd useSyncExternalStore is ordinal 2. */
  ordinal: number;
}

export interface RenderRecord {
  series: string;
  /** Component names from the row's boundary down to this component. */
  path: string;
  name: string;
  /** The row's own boundary (the component the row count is read from). */
  boundary: boolean;
  /** Wrapped in memo(). */
  memo: boolean;
  /** One number per component instance. */
  instance: number;
  rowId: string | null;
  phase: "mount" | "update";
  props: ValueChange[];
  hooks: HookChange[];
  contexts: ValueChange[];
  /** useMemo / useCallback slots that produced a new value: a consequence, not a cause. */
  recomputed: number;
  /** The nearest component above rendered in the same commit. */
  parentRendered: boolean;
  /** Boundary records only: the topmost component of the chain of rendered
   *  ancestors, i.e. where this render started, and why that one rendered. */
  initiator?: { name: string; causes: string[]; chain: string[] };
}

// ---------------------------------------------------------------------------
// Describing and comparing values
// ---------------------------------------------------------------------------

export interface IdRegistry {
  of(value: object): number;
}

export function createIdRegistry(): IdRegistry {
  const ids = new WeakMap<object, number>();
  let next = 1;
  return {
    of(value) {
      let id = ids.get(value);
      if (id === undefined) {
        id = next++;
        ids.set(value, id);
      }
      return id;
    },
  };
}

const FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,23}$/;
const SAFE_ID = /^[A-Za-z0-9_:.-]{1,64}$/;
const MAX_SHAPE_KEYS = 12;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isReactElement(value: unknown): value is { $$typeof: symbol; type: unknown; props: unknown } {
  return typeof value === "object" && value !== null && typeof (value as { $$typeof?: unknown }).$$typeof === "symbol" && "type" in value && "props" in value;
}

export function typeName(type: unknown): string {
  if (typeof type === "string") return type;
  if (typeof type === "function") return (type as { displayName?: string }).displayName || type.name || "Anonymous";
  if (typeof type === "object" && type !== null) {
    const t = type as { displayName?: string; type?: unknown; render?: unknown };
    if (t.displayName) return t.displayName;
    if (t.type) return typeName(t.type);
    if (t.render) return typeName(t.render);
  }
  return "Anonymous";
}

/** The field names of a record-like object; a dictionary (many keys, or keys that are not field names) gives only its size. */
function shape(value: Record<string, unknown>): string {
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  if (keys.length > MAX_SHAPE_KEYS || keys.some((k) => !FIELD_NAME.test(k))) return `(${keys.length} keys)`;
  return `{${keys.join(",")}}`;
}

/** Type + length/size + `id` + identity number. Never the content of a string or a number. */
export function describeValue(value: unknown, ids: IdRegistry, nested = false): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "boolean":
      return String(value);
    case "number":
      return Number.isNaN(value) ? "NaN" : "number";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "string":
      return `string(${value.length})`;
    case "function": {
      const name = FIELD_NAME.test(value.name) ? ` ${value.name}` : "";
      return nested ? "fn" : `fn${name}#${ids.of(value)}`;
    }
    default:
      break;
  }
  const object = value as object;
  const tail = nested ? "" : `#${ids.of(object)}`;
  if (Array.isArray(object)) {
    const first = !nested && object.length > 0 ? `<${describeValue(object[0], ids, true)}>` : "";
    return `array(${object.length})${first}${tail}`;
  }
  if (isReactElement(object)) return `element<${typeName(object.type)}>`;
  if (object instanceof Map) return `Map(${object.size})${tail}`;
  if (object instanceof Set) return `Set(${object.size})${tail}`;
  if (object instanceof Date) return "Date";
  if (typeof (object as { then?: unknown }).then === "function") return `Promise${tail}`;
  if (!isPlainObject(object)) return `${object.constructor?.name && FIELD_NAME.test(object.constructor.name) ? object.constructor.name : "object"}${tail}`;
  const id = object.id;
  const idText = (typeof id === "string" || typeof id === "number") && SAFE_ID.test(String(id)) ? ` id=${id}` : "";
  return `object${shape(object)}${idText}${tail}`;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && Object.is(a[k], b[k]));
  }
  return false;
}

/** `identity` when only the reference is new: equal function source, shallow-equal array / object, or an element of the same type with shallow-equal props. */
export function changeKind(prev: unknown, next: unknown): ChangeKind {
  if (typeof prev === "function" && typeof next === "function") {
    return Function.prototype.toString.call(prev) === Function.prototype.toString.call(next) ? "identity" : "value";
  }
  if (isReactElement(prev) && isReactElement(next)) return prev.type === next.type && shallowEqual(prev.props, next.props) ? "identity" : "value";
  return shallowEqual(prev, next) ? "identity" : "value";
}

function innerChanges(prev: unknown, next: unknown): string[] | undefined {
  if (!isPlainObject(prev) || !isPlainObject(next)) return undefined;
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])];
  if (keys.length > 80 || keys.some((k) => !FIELD_NAME.test(k))) return undefined;
  const changed = keys.filter((k) => !Object.is(prev[k], next[k]));
  return changed.length > 0 && changed.length < keys.length ? changed.slice(0, 8) : undefined;
}

export function describeChange(key: string, prev: unknown, next: unknown, ids: IdRegistry): ValueChange {
  const kind = changeKind(prev, next);
  const inner = kind === "value" ? innerChanges(prev, next) : undefined;
  return { key, kind, prev: describeValue(prev, ids), next: describeValue(next, ids), ...(inner ? { inner } : {}) };
}

/** Shallow diff of two props objects, by key. */
export function diffProps(prev: unknown, next: unknown, ids: IdRegistry): ValueChange[] {
  if (prev === next) return [];
  const a = (typeof prev === "object" && prev !== null ? prev : {}) as Record<string, unknown>;
  const b = (typeof next === "object" && next !== null ? next : {}) as Record<string, unknown>;
  const changes: ValueChange[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!Object.is(a[key], b[key])) changes.push(describeChange(key, a[key], b[key], ids));
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Hooks and contexts (the shapes React keeps on a fiber; see renderWhyRecorder.ts)
// ---------------------------------------------------------------------------

export interface HookNode {
  memoizedState: unknown;
  queue: unknown;
  next: HookNode | null;
}

export interface ContextNode {
  context: object;
  memoizedValue: unknown;
  next: ContextNode | null;
}

/** The kind of a hook, from what React stores in its slot (the same in a minified production build). */
export function hookKind(hook: HookNode): HookKind {
  const queue = hook.queue as Record<string, unknown> | null;
  if (queue && typeof queue === "object") {
    if ("getSnapshot" in queue && "value" in queue) return "syncExternalStore";
    if ("dispatch" in queue || "lastRenderedReducer" in queue) return "state";
  }
  const state = hook.memoizedState as Record<string, unknown> | null;
  if (state && typeof state === "object") {
    if (Array.isArray(state)) {
      if (state.length === 2 && (state[1] === null || Array.isArray(state[1]))) return typeof state[0] === "function" ? "callback" : "memo";
      return "other";
    }
    if ("create" in state && "deps" in state && "tag" in state) return "effect";
    const keys = Object.keys(state);
    if (keys.length === 1 && keys[0] === "current") return "ref";
  }
  return "other";
}

export const HOOK_LABEL: Record<HookKind, string> = {
  state: "useState/useReducer",
  syncExternalStore: "useSyncExternalStore",
  memo: "useMemo",
  callback: "useCallback",
  effect: "effect",
  ref: "useRef",
  other: "hook",
};

/**
 * The hook slots whose value differs between two renders of a component.
 * State, external-store and other value slots are causes; a useMemo /
 * useCallback slot with a new value is counted in `recomputed` only.
 */
export function diffHooks(prev: HookNode | null, next: HookNode | null, ids: IdRegistry): { hooks: HookChange[]; recomputed: number; slots: number } {
  const hooks: HookChange[] = [];
  const ordinals: Partial<Record<HookKind, number>> = {};
  let recomputed = 0;
  let index = 0;
  let a = prev;
  let b = next;
  while (a && b && index < 2000) {
    const hook = hookKind(b);
    const ordinal = ordinals[hook] ?? 0;
    ordinals[hook] = ordinal + 1;
    if (hook === "memo" || hook === "callback") {
      if ((a.memoizedState as unknown[] | null)?.[0] !== (b.memoizedState as unknown[])[0]) recomputed++;
    } else if (hook !== "effect" && hook !== "ref" && !Object.is(a.memoizedState, b.memoizedState)) {
      hooks.push({ ...describeChange(`${hook}[${index}]`, a.memoizedState, b.memoizedState, ids), index, hook, ordinal });
    }
    a = a.next;
    b = b.next;
    index++;
  }
  return { hooks, recomputed, slots: index };
}

/** The contexts a component read whose value differs between two renders. `nameOf` labels a context object. */
export function diffContexts(prev: ContextNode | null, next: ContextNode | null, nameOf: (context: object) => string, ids: IdRegistry): ValueChange[] {
  const before = new Map<object, unknown>();
  for (let node = prev, guard = 0; node && guard < 500; node = node.next, guard++) before.set(node.context, node.memoizedValue);
  const changes: ValueChange[] = [];
  const seen = new Set<object>();
  for (let node = next, guard = 0; node && guard < 500; node = node.next, guard++) {
    if (seen.has(node.context) || !before.has(node.context)) continue;
    seen.add(node.context);
    const was = before.get(node.context);
    if (!Object.is(was, node.memoizedValue)) changes.push(describeChange(nameOf(node.context), was, node.memoizedValue, ids));
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Causes
// ---------------------------------------------------------------------------

export interface CauseInput {
  phase: "mount" | "update";
  memo: boolean;
  props: ValueChange[];
  hooks: HookChange[];
  contexts: ValueChange[];
  parentRendered: boolean;
}

/**
 * The cause keys of one render. Keys:
 *   mount
 *   hook:<index>:<kind>:<identity|value>     own state / store
 *   context:<name>:<identity|value>
 *   prop:<key>:<identity|value>              the parent passed something new
 *   parent                                   the parent rendered, nothing of this component changed, and no memo() stops it
 *   unknown                                  nothing found (a memo() component with equal props, a class forceUpdate, ...)
 */
export function causesOf(record: CauseInput): string[] {
  if (record.phase === "mount") return ["mount"];
  const causes = [
    ...record.hooks.map((h) => `hook:${h.index}:${h.hook}:${h.kind}`),
    ...record.contexts.map((c) => `context:${c.key}:${c.kind}`),
    ...record.props.map((p) => `prop:${p.key}:${p.kind}`),
  ];
  if (causes.length > 0) return causes;
  return [record.parentRendered && !record.memo ? "parent" : "unknown"];
}

/** Own state / store / context, as opposed to something handed down by the parent. */
export function isOwnCause(cause: string): boolean {
  return cause.startsWith("hook:") || cause.startsWith("context:");
}

export function causeLabel(cause: string): string {
  const [type, a, b, c] = cause.split(":");
  const how = (kind: string | undefined) => (kind === "identity" ? "new identity, same content" : "changed");
  if (type === "mount") return "mounted";
  if (type === "parent") return "parent rendered, nothing of its own changed (no memo() in between)";
  if (type === "unknown") return "no changed prop, hook or context found";
  if (type === "hook") return `${HOOK_LABEL[b as HookKind] ?? "hook"} slot ${a} ${how(c)}`;
  if (type === "context") return `context ${a} ${how(b)}`;
  if (type === "prop") return `prop \`${a}\` ${how(b)}`;
  return cause;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface CauseCount {
  count: number;
  /** `prev -> next` of the first occurrence. */
  example?: string;
  /** For a hook: its position among the hooks of its kind. */
  ordinal?: number;
}

export interface ComponentAggregate {
  series: string;
  path: string;
  name: string;
  boundary: boolean;
  memo: boolean;
  mounts: number;
  updates: number;
  /** Updates with at least one own cause (state, store, context). */
  ownUpdates: number;
  /** Updates while the parent rendered in the same commit. */
  parentUpdates: number;
  recomputed: number;
  /** Renders per component instance. */
  instances: Record<string, number>;
  causes: Record<string, CauseCount>;
  /** The sets of causes that occurred together in one update. */
  combos: Record<string, number>;
}

export interface WhyAggregate {
  commits: number;
  /** Records left out because a cap was reached; 0 in a trustworthy reading. */
  dropped: number;
  components: Record<string, ComponentAggregate>;
  /** Per series: where the boundary renders started, `Name: cause, cause` -> count. */
  initiators: Record<string, Record<string, { count: number; chain: string[] }>>;
  /** Per series: boundary renders per row id. */
  rows: Record<string, Record<string, number>>;
}

const MAX_CAUSE_KEYS = 80;
const MAX_COMBOS = 60;
const MAX_COMPONENTS = 4000;

export function createAggregate(): WhyAggregate {
  return { commits: 0, dropped: 0, components: {}, initiators: {}, rows: {} };
}

function bump<T extends { count: number }>(map: Record<string, T>, key: string, cap: number, fresh: () => T): T | null {
  let entry = map[key];
  if (!entry) {
    if (Object.keys(map).length >= cap) {
      entry = map["(other)"] ??= fresh();
    } else {
      entry = map[key] = fresh();
    }
  }
  entry.count++;
  return entry;
}

export function addRecord(aggregate: WhyAggregate, record: RenderRecord): void {
  const key = `${record.series}|${record.path}`;
  let component = aggregate.components[key];
  if (!component) {
    if (Object.keys(aggregate.components).length >= MAX_COMPONENTS) {
      aggregate.dropped++;
      return;
    }
    component = aggregate.components[key] = {
      series: record.series,
      path: record.path,
      name: record.name,
      boundary: record.boundary,
      memo: record.memo,
      mounts: 0,
      updates: 0,
      ownUpdates: 0,
      parentUpdates: 0,
      recomputed: 0,
      instances: {},
      causes: {},
      combos: {},
    };
  }
  const instance = String(record.instance);
  component.instances[instance] = (component.instances[instance] ?? 0) + 1;
  component.recomputed += record.recomputed;
  const causes = causesOf(record);
  if (record.phase === "mount") component.mounts++;
  else {
    component.updates++;
    if (causes.some(isOwnCause)) component.ownUpdates++;
    if (record.parentRendered) component.parentUpdates++;
    const combo = [...causes].sort().join(" + ");
    const comboCount = component.combos[combo] ?? (Object.keys(component.combos).length < MAX_COMBOS ? 0 : null);
    if (comboCount !== null) component.combos[combo] = comboCount + 1;
  }
  const changes = [...record.hooks, ...record.contexts, ...record.props];
  causes.forEach((cause, i) => {
    const entry = bump(component.causes, cause, MAX_CAUSE_KEYS, () => ({ count: 0 }) as CauseCount);
    const change = record.phase === "update" ? changes[i] : undefined;
    if (entry && change && entry.example === undefined) {
      entry.example = `${change.prev} -> ${change.next}${change.inner ? ` (fields: ${change.inner.join(", ")})` : ""}`;
      if (i < record.hooks.length) entry.ordinal = record.hooks[i]!.ordinal;
    }
  });
  if (record.boundary) {
    const rows = (aggregate.rows[record.series] ??= {});
    const rowKey = record.rowId ?? `instance-${instance}`;
    rows[rowKey] = (rows[rowKey] ?? 0) + 1;
    if (record.initiator && record.phase === "update") {
      const started = (aggregate.initiators[record.series] ??= {});
      const startKey = `${record.initiator.name}: ${record.initiator.causes.join(", ")}`;
      const chain = record.initiator.chain;
      bump(started, startKey, MAX_CAUSE_KEYS, () => ({ count: 0, chain }));
    }
  }
}

/** Sums readings (one per visit). Instances and rows of different readings stay apart. */
export function mergeAggregates(list: WhyAggregate[]): WhyAggregate {
  const out = createAggregate();
  list.forEach((aggregate, round) => {
    out.commits += aggregate.commits;
    out.dropped += aggregate.dropped;
    for (const [key, c] of Object.entries(aggregate.components)) {
      const into = (out.components[key] ??= { ...c, mounts: 0, updates: 0, ownUpdates: 0, parentUpdates: 0, recomputed: 0, instances: {}, causes: {}, combos: {} });
      into.mounts += c.mounts;
      into.updates += c.updates;
      into.ownUpdates += c.ownUpdates;
      into.parentUpdates += c.parentUpdates;
      into.recomputed += c.recomputed;
      for (const [id, n] of Object.entries(c.instances)) into.instances[`${round}:${id}`] = n;
      for (const [cause, v] of Object.entries(c.causes)) {
        const entry = (into.causes[cause] ??= { count: 0, example: v.example, ordinal: v.ordinal });
        entry.count += v.count;
      }
      for (const [combo, n] of Object.entries(c.combos)) into.combos[combo] = (into.combos[combo] ?? 0) + n;
    }
    for (const [series, started] of Object.entries(aggregate.initiators)) {
      const into = (out.initiators[series] ??= {});
      for (const [key, v] of Object.entries(started)) {
        const entry = (into[key] ??= { count: 0, chain: v.chain });
        entry.count += v.count;
      }
    }
    for (const [series, rows] of Object.entries(aggregate.rows)) {
      const into = (out.rows[series] ??= {});
      for (const [id, n] of Object.entries(rows)) into[`${round}:${id}`] = n;
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Summary and report
// ---------------------------------------------------------------------------

export interface RankedCause {
  cause: string;
  label: string;
  count: number;
  /** What `count` is out of: the component's updates (its renders, for `mount`). */
  of: number;
  example?: string;
  ordinal?: number;
}

export interface ComponentSummary {
  name: string;
  path: string;
  boundary: boolean;
  memo: boolean;
  instances: number;
  renders: number;
  mounts: number;
  updates: number;
  rendersPerRow: number;
  maxPerInstance: number;
  ownUpdates: number;
  parentUpdates: number;
  causes: RankedCause[];
  combos: Array<{ causes: string; count: number }>;
}

export interface SeriesSummary {
  rows: number;
  rowRenders: { total: number; min: number; median: number; max: number };
  boundaries: string[];
  initiators: Array<{ started: string; count: number; chain: string[] }>;
  components: ComponentSummary[];
}

export interface WhySummary {
  commits: number;
  dropped: number;
  series: Record<string, SeriesSummary>;
}

function middle(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function summarize(aggregate: WhyAggregate, options: { top?: number; causes?: number } = {}): WhySummary {
  const top = options.top ?? 12;
  const maxCauses = options.causes ?? 10;
  const series: Record<string, SeriesSummary> = {};
  const names = new Set([...Object.values(aggregate.components).map((c) => c.series), ...Object.keys(aggregate.rows)]);
  for (const name of names) {
    const counts = Object.values(aggregate.rows[name] ?? {}).sort((a, b) => a - b);
    const rows = counts.length;
    const components = Object.values(aggregate.components)
      .filter((c) => c.series === name)
      .map((c): ComponentSummary => {
        const perInstance = Object.values(c.instances);
        const renders = c.mounts + c.updates;
        return {
          name: c.name,
          path: c.path,
          boundary: c.boundary,
          memo: c.memo,
          instances: perInstance.length,
          renders,
          mounts: c.mounts,
          updates: c.updates,
          rendersPerRow: round1(renders / Math.max(rows, 1)),
          maxPerInstance: perInstance.reduce((max, n) => Math.max(max, n), 0),
          ownUpdates: c.ownUpdates,
          parentUpdates: c.parentUpdates,
          causes: Object.entries(c.causes)
            .map(([cause, v]): RankedCause => ({ cause, label: causeLabel(cause), count: v.count, of: cause === "mount" ? renders : c.updates, example: v.example, ordinal: v.ordinal }))
            .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause))
            .slice(0, maxCauses),
          combos: Object.entries(c.combos)
            .map(([causes, count]) => ({ causes, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5),
        };
      })
      // The boundary first, then by renders per row.
      .sort((a, b) => Number(b.boundary) - Number(a.boundary) || b.renders - a.renders || a.path.localeCompare(b.path));
    series[name] = {
      rows,
      rowRenders: { total: counts.reduce((sum, n) => sum + n, 0), min: counts[0] ?? 0, median: middle(counts), max: counts[counts.length - 1] ?? 0 },
      boundaries: [...new Set(components.filter((c) => c.boundary).map((c) => c.name))],
      initiators: Object.entries(aggregate.initiators[name] ?? {})
        .map(([started, v]) => ({ started, count: v.count, chain: v.chain }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12),
      components: components.slice(0, top),
    };
  }
  return { commits: aggregate.commits, dropped: aggregate.dropped, series };
}

/** `prop \`x\` new identity, same content: 9 of 12 updates`. */
export function causeLine(cause: RankedCause): string {
  const unit = cause.cause === "mount" ? "renders" : "updates";
  const ordinal = cause.ordinal === undefined ? "" : ` (${ordinalWord(cause.ordinal)} of its kind)`;
  const example = cause.example ? ` — e.g. ${cause.example}` : "";
  return `${cause.label}${ordinal}: ${cause.count} of ${cause.of} ${unit}${example}`;
}

function ordinalWord(zeroBased: number): string {
  const n = zeroBased + 1;
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** The markdown of one step's summary. */
export function summaryMarkdown(step: string, summary: WhySummary): string[] {
  const lines: string[] = [`## ${step}`, "", `${summary.commits} commit(s).${summary.dropped ? ` ${summary.dropped} record(s) dropped at a cap: counts are low.` : ""}`, ""];
  for (const [name, s] of Object.entries(summary.series)) {
    lines.push(`### ${step} / ${name}: ${s.rows} row(s), ${s.rowRenders.total} boundary render(s) (per row: min ${s.rowRenders.min}, median ${s.rowRenders.median}, max ${s.rowRenders.max})`, "");
    lines.push(`Boundary component: ${s.boundaries.length ? s.boundaries.map((b) => `\`${b}\``).join(", ") : "(none rendered)"}`, "");
    if (s.initiators.length) {
      lines.push("Where the boundary's updates started (topmost rendered ancestor, and why it rendered):", "");
      for (const i of s.initiators) lines.push(`- ${i.count}× \`${i.started}\`${i.chain.length > 1 ? ` — via ${i.chain.join(" > ")}` : ""}`);
      lines.push("");
    }
    if (s.components.length) lines.push("| component | memo | instances | renders | per row | mounts | updates | own state/store/context | with parent | most per instance |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const c of s.components) {
      lines.push(`| \`${c.path}\`${c.boundary ? " (boundary)" : ""} | ${c.memo ? "yes" : "no"} | ${c.instances} | ${c.renders} | ${c.rendersPerRow} | ${c.mounts} | ${c.updates} | ${c.ownUpdates} | ${c.parentUpdates} | ${c.maxPerInstance} |`);
    }
    lines.push("");
    for (const c of s.components) {
      if (c.updates === 0) continue;
      lines.push(`**\`${c.name}\`**${c.boundary ? " (boundary)" : ""} — ${c.updates} update(s), \`${c.path}\``, "");
      for (const cause of c.causes) if (cause.cause !== "mount") lines.push(`- ${causeLine(cause)}`);
      if (c.combos.length > 1 || (c.combos[0] && c.combos[0].causes.includes(" + "))) {
        lines.push("- together in one update:");
        for (const combo of c.combos) lines.push(`  - ${combo.count}× ${combo.causes}`);
      }
      lines.push("");
    }
  }
  return lines;
}
