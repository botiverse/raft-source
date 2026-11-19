import type {
  CompletedTraceSpan,
  TraceAttributes,
  TraceEventRecord,
  TraceLogEvent,
  TraceSink,
  TraceSpanFactRecord,
} from "@botiverse/raft-shared";
import { traceAgentIdHash, traceMachineIdHash, traceServerIdHash } from "./traceIdentity";

// Request spans name an agent, a Computer or a server by its keyed hash
// (`agent_id_hash`, ...); background spans and events (the orchestrator, machine
// routing) carry the raw id. The two halves could not be joined without the
// operator's reverse lookup. The exporting sink adds the hash next to a raw id
// on every span, span event and log event, with the same function and key the
// request spans use, so one hash joins both.
//
// Only these three ids. A raw id stays as it is (they point at no person). An
// existing hash is never overwritten. A user is never handled here: the user
// id is replaced by `trace_user_id` in traceUserIdTraceSink.ts and no raw
// value is kept.
const HASHED_IDS: ReadonlyArray<{ raw: string; hash: string; of: (id: string) => string | null }> = [
  { raw: "agent_id", hash: "agent_id_hash", of: traceAgentIdHash },
  { raw: "machine_id", hash: "machine_id_hash", of: traceMachineIdHash },
  { raw: "server_id", hash: "server_id_hash", of: traceServerIdHash },
];

// The same few thousand ids repeat on every span; one HMAC per id, not per span.
const CACHE_MAX = 20_000;
const cache = new Map<string, string | null>();
let cachedForRoot: string | undefined;

function cachedHash(entry: (typeof HASHED_IDS)[number], id: string): string | null {
  // traceIdentity re-derives its keys when JWT_SECRET changes; follow it, or
  // this sink would keep serving hashes under the old key.
  const root = process.env.JWT_SECRET;
  if (root !== cachedForRoot) {
    cache.clear();
    cachedForRoot = root;
  }
  const key = `${entry.hash}:${id}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = entry.of(id);
  // No key yet (JWT_SECRET unset) gives null: don't remember that, it may come later.
  if (value === null) return null;
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, value);
  return value;
}

function addIdHashes(attrs: TraceAttributes | undefined): TraceAttributes | undefined {
  if (!attrs) return attrs;
  let next: Record<string, unknown> | null = null;
  for (const entry of HASHED_IDS) {
    const raw = attrs[entry.raw];
    if (typeof raw !== "string" || !raw) continue;
    const existing = attrs[entry.hash];
    if (existing !== undefined && existing !== null && existing !== "") continue;
    const hash = cachedHash(entry, raw);
    if (!hash) continue;
    next ??= { ...attrs };
    next[entry.hash] = hash;
  }
  return next ?? attrs;
}

function withAttrs<T extends { attrs?: TraceAttributes }>(item: T): T {
  const attrs = addIdHashes(item.attrs);
  return attrs === item.attrs ? item : { ...item, attrs };
}

function completedSpan(span: CompletedTraceSpan): CompletedTraceSpan {
  const replaced = withAttrs(span);
  let eventsChanged = false;
  const events = span.events.map((event) => {
    const next = withAttrs(event);
    if (next !== event) eventsChanged = true;
    return next;
  });
  return eventsChanged ? { ...replaced, events } : replaced;
}

export class TraceIdHashTraceSink implements TraceSink {
  constructor(private readonly sink: TraceSink) {}

  record(span: CompletedTraceSpan): void {
    this.sink.record(completedSpan(span));
  }

  recordEvent(record: TraceEventRecord): void {
    this.sink.recordEvent?.({ ...record, span: withAttrs(record.span), event: withAttrs(record.event) });
  }

  recordSpanFact(record: TraceSpanFactRecord): void {
    this.sink.recordSpanFact?.({ ...record, span: completedSpan(record.span) });
  }

  recordLogEvent(event: TraceLogEvent): void {
    this.sink.recordLogEvent?.(withAttrs(event));
  }
}

export const __traceIdHashForTests = {
  reset() { cache.clear(); cachedForRoot = undefined; },
};
