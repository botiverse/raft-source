import { OBJECT_SUMMARIES_MAX_REFS, objectWebPaths } from "@botiverse/raft-shared";
import type {
  ObjectDeletedOf,
  ObjectRefOf,
  ObjectSummaries,
  ObjectSummariesInput,
  ObjectSummaryOf,
  SummarizedObjectKind,
} from "@botiverse/raft-shared";

import api from "../api/client";
import { parseRetryAfterMs } from "../api/overloadRetry";
import { useServerStore } from "../store/serverStore";
import { accessTokenSubject } from "../utils/hostAccessTokenSync";

/**
 * The page's loader for first-party object summaries (the card an app shows
 * wherever one of its objects is named): core's `POST /api/objects/summaries`
 * (shared webObjectsContract.ts), for any kind, behind one function. Core
 * code: it knows kinds only as the contract types them, no app.
 *
 * - Batching: every `loadObjectSummaries` in the same
 *   OBJECT_SUMMARY_BATCH_WINDOW_MS (the messages a list mounts in one commit,
 *   or a few frames of scrolling) goes out as one request per (server, kind),
 *   each reference once (by `objectRefKey`), at most OBJECT_SUMMARIES_MAX_REFS
 *   a request. A reference already asked and not answered yet waits on that
 *   request.
 * - Cache: answers are kept for this page, per (server, kind, reference): a
 *   summary OBJECT_SUMMARY_OK_TTL_MS, `unavailable` and `deleted`
 *   OBJECT_SUMMARY_UNAVAILABLE_TTL_MS (a deleted object stays deleted, but the
 *   reader may lose the view of it, which turns it `unavailable`),
 *   the least recently used dropped past OBJECT_SUMMARY_MAX_ENTRIES. Answers are
 *   per viewer (the route says `no-store`): kept in memory only, and dropped
 *   whenever the current server or the signed-in person changes (sign-out,
 *   another person signing in on another tab).
 * - Invalidation: `invalidateObjectSummary(kind, id)` after a change this
 *   page made, `invalidateObjectSummaries({ serverId })` when the server
 *   says something changed (`activity:changed`). Subscribers are told
 *   (`useObjectSummaries` asks again). An answer to a request sent before an
 *   invalidation is still delivered, never kept.
 * - Errors: a failed request answers each of its references `error` (never
 *   kept, so the next load asks again). A 429 says when to ask again
 *   (`retryAfterMs`, from Retry-After): that server's next request waits
 *   until then.
 */

/** How long lookups are gathered into one request. */
export const OBJECT_SUMMARY_BATCH_WINDOW_MS = 10;
/** How long a summary is kept. */
export const OBJECT_SUMMARY_OK_TTL_MS = 60_000;
/** How long `unavailable` is kept (it may become visible: shared, published). */
export const OBJECT_SUMMARY_UNAVAILABLE_TTL_MS = 15_000;
/** At most this many answers kept. */
export const OBJECT_SUMMARY_MAX_ENTRIES = 1_000;
/** A 429 without a usable Retry-After waits this long; a shorter one is raised, a longer one capped. */
const DEFAULT_RETRY_AFTER_MS = 5_000;
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;

/** One reference's answer. */
export type ObjectSummaryResult<K extends SummarizedObjectKind = SummarizedObjectKind> =
  | { status: "ok"; summary: ObjectSummaryOf<K> }
  /** Not visible, missing, revoked, deleted to a reader who couldn't see it, nothing at that reference: one answer for every reason. */
  | { status: "unavailable" }
  /**
   * Deleted, to a reader who could see it before: what its kind shows of it
   * (webObjectsContract ObjectSummaryAnswer). Only checked to be an object:
   * each reader parses the kind's fields (an Artifact's: artifactDeletedOf).
   */
  | { status: "deleted"; deleted: ObjectDeletedOf<K> }
  /** The request failed (not kept). `retryAfterMs`: a 429's Retry-After, else null. */
  | { status: "error"; error: ObjectSummaryError; retryAfterMs: number | null };

/** Why a summaries request failed: the HTTP status and the body's `code` when there was a response, else both null (network). */
export interface ObjectSummaryError {
  status: number | null;
  code: string | null;
}

/** The answers to one load, by `objectRefKey`, in the order the references were given (repeats once). */
export type ObjectSummaryResults<K extends SummarizedObjectKind = SummarizedObjectKind> = Map<string, ObjectSummaryResult<K>>;

/** What an invalidation covers: every field given must match; none given is everything. */
export interface ObjectSummaryInvalidation {
  serverId?: string | null;
  kind?: SummarizedObjectKind;
  /** The object's id: every reference to it (each version). */
  id?: string;
  /**
   * One reference only (by `objectRefKey`; its id is `id` too): e.g. a poll
   * for an object's latest that leaves its other references (a pinned
   * version's card) kept.
   */
  ref?: AnyRef;
}

type AnyRef = { id: string };

/**
 * The key of a reference: its id, then its other fields by name (an
 * undefined field is no field). `{ id }` and `{ id, version: 2 }` differ.
 */
export function objectRefKey(ref: AnyRef): string {
  const rest = Object.keys(ref)
    .filter((key) => key !== "id" && (ref as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `;${key}=${JSON.stringify((ref as Record<string, unknown>)[key])}`);
  return `${ref.id}${rest.join("")}`;
}

export interface ObjectSummaryLoader {
  /** The answers for `refs` of `kind` in `serverId` (null: the client's current server). Never rejects. */
  load<K extends SummarizedObjectKind>(serverId: string | null, kind: K, refs: ReadonlyArray<ObjectRefOf<K>>): Promise<ObjectSummaryResults<K>>;
  /** The kept answers for every one of `refs`, or null if any is not kept (no request). */
  peek<K extends SummarizedObjectKind>(serverId: string | null, kind: K, refs: ReadonlyArray<ObjectRefOf<K>>): ObjectSummaryResults<K> | null;
  invalidate(change?: ObjectSummaryInvalidation): void;
  /** Drops everything kept and tells subscribers (as `invalidate({})`). */
  clear(): void;
  subscribe(listener: (change: ObjectSummaryInvalidation) => void): () => void;
}

export interface ObjectSummaryLoaderOptions {
  /** One summaries request, in `serverId` (null: the client's current one). */
  post(serverId: string | null, input: ObjectSummariesInput): Promise<ObjectSummaries>;
  batchWindowMs?: number;
  okTtlMs?: number;
  unavailableTtlMs?: number;
  maxEntries?: number;
  maxRefsPerRequest?: number;
}

type AnyResult = ObjectSummaryResult;
interface Kept { serverId: string | null; kind: SummarizedObjectKind; id: string; key: string; result: AnyResult; expiresAt: number }
interface Waiting { serverId: string | null; kind: SummarizedObjectKind; ref: AnyRef; full: string; promise: Promise<AnyResult>; resolve: (result: AnyResult) => void; sent: boolean }
interface Group { serverId: string | null; kind: SummarizedObjectKind; waiting: Map<string, Waiting> }

const scopeOf = (serverId: string | null, kind: string) => `${serverId ?? ""}\u0000${kind}`;

type FailedResponse = { status?: unknown; headers?: unknown; data?: unknown } | undefined;
const responseOf = (error: unknown): FailedResponse => (error as { response?: FailedResponse } | null)?.response;

/** The Retry-After of a 429, within bounds; null for any other failure. */
function retryAfterOf(error: unknown): number | null {
  const response = responseOf(error);
  if (response?.status !== 429) return null;
  return Math.max(MIN_RETRY_AFTER_MS, Math.min(parseRetryAfterMs(response.headers) ?? DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS));
}

function summaryErrorOf(error: unknown): ObjectSummaryError {
  const response = responseOf(error);
  if (!response || typeof response.status !== "number") return { status: null, code: null };
  const code = (response.data as { code?: unknown } | null | undefined)?.code;
  return { status: response.status, code: typeof code === "string" ? code : null };
}

/**
 * A `deleted` answer with its payload, else null: any other `reason`
 * (one this client doesn't know, from a newer server) is `unavailable`. The
 * kind's own fields are checked where the kind is drawn.
 */
function deletedOf(answered: { reason?: unknown; deleted?: unknown }): AnyResult | null {
  if (answered.reason !== "deleted" || typeof answered.deleted !== "object" || answered.deleted === null) return null;
  return { status: "deleted", deleted: answered.deleted as ObjectDeletedOf<SummarizedObjectKind> };
}

function matches(change: ObjectSummaryInvalidation, kept: { serverId: string | null; kind: string; id: string; key: string }): boolean {
  return (change.serverId === undefined || change.serverId === kept.serverId)
    && (change.kind === undefined || change.kind === kept.kind)
    && (change.id === undefined || change.id === kept.id)
    && (change.ref === undefined || objectRefKey(change.ref) === kept.key);
}

export function createObjectSummaryLoader(options: ObjectSummaryLoaderOptions): ObjectSummaryLoader {
  const batchWindowMs = options.batchWindowMs ?? OBJECT_SUMMARY_BATCH_WINDOW_MS;
  const okTtlMs = options.okTtlMs ?? OBJECT_SUMMARY_OK_TTL_MS;
  const unavailableTtlMs = options.unavailableTtlMs ?? OBJECT_SUMMARY_UNAVAILABLE_TTL_MS;
  const maxEntries = options.maxEntries ?? OBJECT_SUMMARY_MAX_ENTRIES;
  const maxRefs = options.maxRefsPerRequest ?? OBJECT_SUMMARIES_MAX_REFS;

  /** Kept answers by scope + ref key; Map order is the LRU order (oldest first). */
  const kept = new Map<string, Kept>();
  /** Every reference asked and not answered yet, by scope + ref key. */
  const inFlight = new Map<string, Waiting>();
  /** Not sent yet, by scope. */
  const pending = new Map<string, Group>();
  /** A server's requests wait until then after a 429. */
  const heldUntil = new Map<string, number>();
  const listeners = new Set<(change: ObjectSummaryInvalidation) => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerAt = 0;

  function keptResult(full: string): AnyResult | null {
    const entry = kept.get(full);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      kept.delete(full);
      return null;
    }
    // Most recently used: to the end.
    kept.delete(full);
    kept.set(full, entry);
    return entry.result;
  }

  function keep(full: string, entry: Kept) {
    kept.delete(full);
    kept.set(full, entry);
    while (kept.size > maxEntries) kept.delete(kept.keys().next().value!);
  }

  function schedule(delayMs: number) {
    const at = Date.now() + delayMs;
    if (timer !== null && timerAt <= at) return;
    if (timer !== null) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(flush, delayMs);
  }

  function flush() {
    timer = null;
    const now = Date.now();
    let nextHeld = Infinity;
    for (const [scope, group] of pending) {
      const until = heldUntil.get(group.serverId ?? "") ?? 0;
      if (until > now) {
        nextHeld = Math.min(nextHeld, until);
        continue;
      }
      pending.delete(scope);
      send(group);
    }
    if (nextHeld !== Infinity) schedule(nextHeld - now);
  }

  function settle(waiting: Waiting, result: AnyResult, entry: Omit<Kept, "result" | "expiresAt"> | null) {
    // Still the one asked for this reference: not invalidated since it was sent.
    if (inFlight.get(waiting.full) === waiting) {
      inFlight.delete(waiting.full);
      if (entry && result.status !== "error") {
        keep(waiting.full, { ...entry, result, expiresAt: Date.now() + (result.status === "ok" ? okTtlMs : unavailableTtlMs) });
      }
    }
    waiting.resolve(result);
  }

  function send(group: Group) {
    const all = [...group.waiting.values()];
    for (const waiting of all) waiting.sent = true;
    for (let i = 0; i < all.length; i += maxRefs) {
      const chunk = all.slice(i, i + maxRefs);
      const input = { kind: group.kind, refs: chunk.map((w) => w.ref) } as ObjectSummariesInput;
      void options.post(group.serverId, input).then(
        (answer) => {
          const byKey = new Map(answer.summaries.map((s) => [objectRefKey(s.ref as AnyRef), s]));
          for (const waiting of chunk) {
            const answered = byKey.get(objectRefKey(waiting.ref));
            const where = { serverId: waiting.serverId, kind: waiting.kind, id: waiting.ref.id, key: objectRefKey(waiting.ref) };
            if (!answered) settle(waiting, { status: "unavailable" }, null);
            else if (answered.ok) settle(waiting, { status: "ok", summary: answered.summary }, where);
            else settle(waiting, deletedOf(answered) ?? { status: "unavailable" }, where);
          }
        },
        (error: unknown) => {
          const retryAfterMs = retryAfterOf(error);
          if (retryAfterMs !== null) {
            const until = Date.now() + retryAfterMs;
            heldUntil.set(group.serverId ?? "", Math.max(until, heldUntil.get(group.serverId ?? "") ?? 0));
          }
          const failure = summaryErrorOf(error);
          for (const waiting of chunk) settle(waiting, { status: "error", error: failure, retryAfterMs }, null);
        },
      );
    }
  }

  function ask(serverId: string | null, kind: SummarizedObjectKind, ref: AnyRef, full: string): Promise<AnyResult> {
    const scope = scopeOf(serverId, kind);
    let group = pending.get(scope);
    if (!group) {
      group = { serverId, kind, waiting: new Map() };
      pending.set(scope, group);
    }
    let resolve!: (result: AnyResult) => void;
    const promise = new Promise<AnyResult>((r) => { resolve = r; });
    const waiting: Waiting = { serverId, kind, ref, full, promise, resolve, sent: false };
    group.waiting.set(full, waiting);
    inFlight.set(full, waiting);
    schedule(batchWindowMs);
    return promise;
  }

  function distinct(refs: ReadonlyArray<AnyRef>): Array<[string, AnyRef]> {
    return [...new Map(refs.map((ref) => [objectRefKey(ref), ref])).entries()];
  }

  const loader: ObjectSummaryLoader = {
    async load(serverId, kind, refs) {
      const scope = scopeOf(serverId, kind);
      const answers = await Promise.all(distinct(refs).map(async ([key, ref]) => {
        const full = `${scope}\u0000${key}`;
        const result = keptResult(full) ?? await (inFlight.get(full)?.promise ?? ask(serverId, kind, ref, full));
        return [key, result] as const;
      }));
      return new Map(answers) as ObjectSummaryResults<typeof kind>;
    },
    peek(serverId, kind, refs) {
      const scope = scopeOf(serverId, kind);
      const answers = new Map<string, AnyResult>();
      for (const [key] of distinct(refs)) {
        const result = keptResult(`${scope}\u0000${key}`);
        if (!result) return null;
        answers.set(key, result);
      }
      return answers as ObjectSummaryResults<typeof kind>;
    },
    invalidate(change = {}) {
      for (const [full, entry] of kept) if (matches(change, entry)) kept.delete(full);
      // A sent request's answer may predate the change: delivered, not kept,
      // and the next load asks again. Not sent yet: it will be current.
      for (const [full, waiting] of inFlight) {
        if (waiting.sent && matches(change, { serverId: waiting.serverId, kind: waiting.kind, id: waiting.ref.id, key: objectRefKey(waiting.ref) })) inFlight.delete(full);
      }
      for (const listener of [...listeners]) listener(change);
    },
    clear() {
      loader.invalidate({});
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return loader;
}

/** `objectWebPaths` are absolute (`/api/…`); the client's base already ends in `/api`. */
const SUMMARIES_ROUTE = objectWebPaths.summaries().replace(/^\/api(?=\/)/, "");

const pageLoader = createObjectSummaryLoader({
  async post(serverId, input) {
    const { data } = await api.post<ObjectSummaries>(SUMMARIES_ROUTE, input, serverId ? { headers: { "X-Server-Id": serverId } } : undefined);
    return data;
  },
});

const currentServerId = () => useServerStore.getState().current?.id ?? null;

let watchingViewer = false;
/**
 * Answers are one person's in one server: a server switch, sign-out, or
 * another person's tokens arriving from another tab (authTokenSync) drops them.
 */
function watchViewer() {
  if (watchingViewer) return;
  watchingViewer = true;
  useServerStore.subscribe((state, previous) => {
    if (state.current?.id !== previous.current?.id) pageLoader.clear();
  });
  // Loaded when first used, not with this module: the auth store reads localStorage as it loads, and core
  // modules that load in node (the socket bridge) import this one.
  void import("../store/authStore").then(({ useAuthStore }) => {
    useAuthStore.subscribe((state, previous) => {
      if (accessTokenSubject(state.accessToken) !== accessTokenSubject(previous.accessToken)) pageLoader.clear();
    });
  });
}

/**
 * The summaries of `refs` (objects of `kind`) for the signed-in person in
 * `serverId` (null: the client's current server), by `objectRefKey(ref)`:
 * `ok` with the summary, `unavailable`, or `error` (the request failed; ask
 * again later, after `retryAfterMs` when given). Batched and kept as the
 * module comment says. Never rejects.
 */
export function loadObjectSummaries<K extends SummarizedObjectKind>(serverId: string | null, kind: K, refs: ReadonlyArray<ObjectRefOf<K>>): Promise<ObjectSummaryResults<K>> {
  watchViewer();
  return pageLoader.load(serverId ?? currentServerId(), kind, refs);
}

/** The kept answers for every one of `refs`, or null if any is not kept. Synchronous; never asks. */
export function peekObjectSummaries<K extends SummarizedObjectKind>(serverId: string | null, kind: K, refs: ReadonlyArray<ObjectRefOf<K>>): ObjectSummaryResults<K> | null {
  watchViewer();
  return pageLoader.peek(serverId ?? currentServerId(), kind, refs);
}

/** Forget every reference to one object (each version), in every server: after this page changed it. */
export function invalidateObjectSummary(kind: SummarizedObjectKind, id: string): void {
  pageLoader.invalidate({ kind, id });
}

/** Forget one reference only (`objectRefKey`), in `serverId` (null: the current server): its other references stay kept. */
export function invalidateObjectSummaryRef<K extends SummarizedObjectKind>(serverId: string | null, kind: K, ref: ObjectRefOf<K>): void {
  pageLoader.invalidate({ serverId: serverId ?? currentServerId(), kind, id: ref.id, ref });
}

/** Forget what `change` covers (all of it with none): e.g. one server's after `activity:changed`. */
export function invalidateObjectSummaries(change: ObjectSummaryInvalidation = {}): void {
  pageLoader.invalidate(change);
}

/** Forget everything kept (tests; a server switch does it itself). */
export function clearObjectSummaries(): void {
  pageLoader.clear();
}

/** Told of every invalidation; returns the unsubscribe. */
export function subscribeObjectSummaryInvalidation(listener: (change: ObjectSummaryInvalidation) => void): () => void {
  return pageLoader.subscribe(listener);
}
