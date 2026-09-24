import { useEffect, useMemo, useRef, useState } from "react";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import { rankBasicComposerSuggestions, rankComposerSuggestions } from "../utils/composerSuggestionSearch";
import type { ComposerSuggestionSearchEntry, ComposerSuggestionSearchField } from "../utils/composerSuggestionSearch";

const DEFAULT_WORKER_THRESHOLD = 200;

/**
 * Trailing-edge debounce for worker rank requests (task #266). Without it every
 * keystroke fired a fresh rank request AND cleared the visible snapshot
 * (`result: null` until the worker answered), so the autocomplete popover
 * collapsed and re-mounted per keystroke — the "flicker". Now the previous
 * snapshot stays on screen while the next rank is pending (stale-while-
 * revalidate), and rapid typing coalesces into one worker request.
 */
const WORKER_RANK_DEBOUNCE_MS = 50;

interface ComposerSuggestionWorkerEntry {
  index: number;
  fields: ComposerSuggestionSearchField[];
}

interface ComposerSuggestionWorkerResponse {
  type: "ranked";
  requestId: number;
  indexes: number[];
}

interface UseRankedComposerSuggestionsOptions {
  workerThreshold?: number;
}

interface WorkerState<T> {
  pendingRequestId: number;
  result: {
    requestId: number;
    suggestions: T[];
  } | null;
}

export function useRankedComposerSuggestions<T>(
  query: string,
  entries: ComposerSuggestionSearchEntry<T>[],
  { workerThreshold = DEFAULT_WORKER_THRESHOLD }: UseRankedComposerSuggestionsOptions = {},
): T[] {
  const requestIdRef = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  const lastWorkerEntriesRef = useRef<ComposerSuggestionSearchEntry<T>[] | null>(null);
  // Tracks whether workerState currently holds the cleared reset value, so the
  // effect can skip a no-op reset setState (which still costs a render commit)
  // on the common sub-threshold path. Starts true (initial state below).
  const workerStateIsResetRef = useRef(true);
  const [workerState, setWorkerState] = useState<WorkerState<T>>({ pendingRequestId: 0, result: null });
  const [workerUnavailable, setWorkerUnavailable] = useState(false);
  const canUseWorker = typeof Worker !== "undefined";
  const needsWorker = query.trim().length > 0 && entries.length >= workerThreshold;
  const shouldUseWorker = needsWorker && canUseWorker && !workerUnavailable;

  // oxlint-disable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-cascading-set-state -- This state tracks an async worker request lifecycle keyed by query/entries. The result cannot be derived during render because it arrives from a different thread.
  useEffect(() => {
    if (!shouldUseWorker) {
      // Guard the reset setState: only fire it when the state isn't already the
      // cleared value, so the common sub-threshold path adds zero no-op render
      // commits per keystroke. A same-value setState from an effect does NOT
      // fully bail React's commit, so the guard — not an identity-preserving
      // updater — is what avoids the extra render (铁根 render-perf #4446).
      if (!workerStateIsResetRef.current) {
        setWorkerState({ pendingRequestId: 0, result: null });
        workerStateIsResetRef.current = true;
      }
      lastWorkerEntriesRef.current = null;
      return;
    }

    const disableWorker = (reason: string, detail?: unknown) => {
      console.warn(`Composer suggestion worker ${reason}; falling back to basic text matching without pinyin.`, detail);
      workerRef.current?.terminate();
      workerRef.current = null;
      lastWorkerEntriesRef.current = null;
      setWorkerUnavailable(true);
    };

    let worker: Worker;
    try {
      worker = workerRef.current ?? new Worker(new URL("../workers/composerSuggestion.worker.ts", import.meta.url), { type: "module" });
    } catch (err) {
      disableWorker("could not start", err);
      return;
    }
    workerRef.current = worker;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const suggestionsByIndex = new Map(entries.map((entry) => [entry.index, entry.suggestion]));
    // Stale-while-revalidate (task #266): keep the previous snapshot while the
    // next rank is pending. Clearing `result` here unmounted the whole popover
    // on every keystroke until the worker answered — the autocomplete flicker.
    setWorkerState((current) => ({
      pendingRequestId: requestId,
      result: current.result,
    }));
    workerStateIsResetRef.current = false;

    const handleMessage = (event: MessageEvent<ComposerSuggestionWorkerResponse>) => {
      if (event.data.type !== "ranked" || event.data.requestId !== requestIdRef.current) return;
      setWorkerState((current) => ({
        pendingRequestId: current.pendingRequestId,
        result: {
          requestId: event.data.requestId,
          suggestions: event.data.indexes
            .map((index) => suggestionsByIndex.get(index))
            .filter((suggestion): suggestion is T => suggestion != null),
        },
      }));
    };
    const handleWorkerFailure = (event: ErrorEvent | MessageEvent) => {
      disableWorker("failed", event);
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleWorkerFailure);
    worker.addEventListener("messageerror", handleWorkerFailure);
    // Trailing-edge debounce (task #266): rapid typing coalesces into one rank
    // request. The worker-received bookkeeping must happen at fire time — a
    // superseded timer never posts, so recording entries/query as sent at
    // effect time would drop an entries upload the worker never saw.
    const rankTimer = setClockTimeout(() => {
      const workerEntriesChanged = lastWorkerEntriesRef.current !== entries;
      const workerEntries: ComposerSuggestionWorkerEntry[] | undefined = workerEntriesChanged
        ? entries.map((entry) => ({
            index: entry.index,
            fields: entry.fields,
          }))
        : undefined;
      lastWorkerEntriesRef.current = entries;
      try {
        worker.postMessage({ type: "rank", requestId, query, entries: workerEntries });
      } catch (err) {
        disableWorker("could not accept a request", err);
      }
    }, WORKER_RANK_DEBOUNCE_MS);

    return () => {
      clearClockTimeout(rankTimer);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleWorkerFailure);
      worker.removeEventListener("messageerror", handleWorkerFailure);
    };
  }, [entries, query, shouldUseWorker]);
  // oxlint-enable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-cascading-set-state

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  return useMemo(() => {
    if (needsWorker && !shouldUseWorker) return rankBasicComposerSuggestions(query, entries);
    if (!shouldUseWorker) return rankComposerSuggestions(query, entries);
    if (!workerState.result) return [];
    return workerState.result.suggestions;
  }, [entries, needsWorker, query, shouldUseWorker, workerState.result]);
}
