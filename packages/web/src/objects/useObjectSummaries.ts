import { useEffect, useState } from "react";
import type { ObjectRefOf, SummarizedObjectKind } from "@botiverse/raft-shared";

import { useServerStore } from "../store/serverStore";
import { loadObjectSummaries, objectRefKey, peekObjectSummaries, subscribeObjectSummaryInvalidation } from "./objectSummaryLoader";
import type { ObjectSummaryResults } from "./objectSummaryLoader";

function retryAfterOf(results: ObjectSummaryResults | null): number | null {
  let longest: number | null = null;
  for (const result of results?.values() ?? []) {
    if (result.status === "error" && result.retryAfterMs !== null) longest = Math.max(longest ?? 0, result.retryAfterMs);
  }
  return longest;
}

/**
 * A failed refetch keeps a reference's previous answer on screen (a card does
 * not vanish because one request after an invalidation failed); with nothing
 * shown before, the error is the answer.
 */
function keepShown<K extends SummarizedObjectKind>(shown: ObjectSummaryResults<K> | null, next: ObjectSummaryResults<K>): ObjectSummaryResults<K> {
  if (!shown) return next;
  let merged: ObjectSummaryResults<K> | null = null;
  for (const [key, result] of next) {
    const before = shown.get(key);
    if (result.status === "error" && before && before.status !== "error") (merged ??= new Map(next)).set(key, before);
  }
  return merged ?? next;
}

export interface UseObjectSummariesOptions {
  /** False: no lookup, null back. Default true. */
  enabled?: boolean;
  /** The server to read in; default the current one. */
  serverId?: string | null;
}

/**
 * The summaries of `refs` (objects of `kind`) for a component on screen,
 * through the page's loader (objectSummaryLoader.ts): the components that
 * mount together share one request, and a remount within the TTL asks
 * nothing (kept answers are there on the first render).
 *
 * Returns null until every ref is answered, then a map by
 * `objectRefKey(ref)`: `ok`, `deleted`, `unavailable` or `error` (the request failed;
 * after a 429 it is asked again by itself once Retry-After has passed,
 * otherwise on the next mount). An invalidation that covers one of the refs
 * (`invalidateObjectSummary`, `activity:changed`, a server switch) asks again,
 * showing the previous answers until the new ones come. `refs` may be a new
 * array each render: only their keys count.
 */
export function useObjectSummaries<K extends SummarizedObjectKind>(
  kind: K,
  refs: ReadonlyArray<ObjectRefOf<K>>,
  options: UseObjectSummariesOptions = {},
): ObjectSummaryResults<K> | null {
  const currentServerId = useServerStore((state) => state.current?.id ?? null);
  // null and absent both mean the current server (as the loader reads them), so
  // `activity:changed` for it, which names it, reaches these cards too.
  const serverId = options.serverId ?? currentServerId;
  const enabled = options.enabled ?? true;
  const key = `${enabled ? "on" : "off"}\u0000${serverId ?? ""}\u0000${kind}\u0000${refs.map(objectRefKey).join("\u0001")}`;
  // The refs as of their key (a new array with the same refs keeps the old
  // one), and their answers: on a new key, what the page already keeps, so a
  // remount draws its cards on the first render.
  const [held, setHeld] = useState(() => ({ key, refs, results: enabled ? peekObjectSummaries(serverId, kind, refs) : null }));
  let current = held;
  if (held.key !== key) {
    current = { key, refs, results: enabled ? peekObjectSummaries(serverId, kind, refs) : null };
    setHeld(current);
  }
  const heldRefs = current.refs;
  // Bumped to ask again: an invalidation, or a 429's Retry-After passing.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadObjectSummaries(serverId, kind, heldRefs).then((results) => {
      if (!cancelled) setHeld((last) => (last.key === key ? { ...last, results: keepShown(last.results, results) } : last));
    });
    return () => { cancelled = true; };
  }, [enabled, serverId, kind, heldRefs, key, generation]);

  // After a 429, ask again once its Retry-After has passed (the loader holds that server's requests until then).
  const retryAfterMs = retryAfterOf(current.results);
  useEffect(() => {
    if (retryAfterMs === null) return;
    const timer = setTimeout(() => setGeneration((n) => n + 1), retryAfterMs);
    return () => clearTimeout(timer);
  }, [retryAfterMs, current.results]);

  useEffect(() => {
    if (!enabled) return;
    return subscribeObjectSummaryInvalidation((change) => {
      if (change.serverId !== undefined && change.serverId !== serverId) return;
      if (change.kind !== undefined && change.kind !== kind) return;
      if (change.id !== undefined && !heldRefs.some((ref) => ref.id === change.id)) return;
      const only = change.ref === undefined ? null : objectRefKey(change.ref);
      if (only !== null && !heldRefs.some((ref) => objectRefKey(ref) === only)) return;
      setGeneration((n) => n + 1);
    });
  }, [enabled, serverId, kind, heldRefs]);

  return enabled ? current.results : null;
}
