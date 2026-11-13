import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { useDebouncedValue } from "../../hooks/useDebouncedValue";

const SEARCH_DEBOUNCE_MS = 250;

/** How a list's filter reads its choices: the route, a row's identity, and whether a row's name holds the lower-cased words. */
export interface FilterChoicesSource<T> {
  ask: (q: string) => Promise<readonly T[]>;
  keyOf: (row: T) => string;
  matches: (row: T, words: string) => boolean;
}

/**
 * `answeredFor`: the search the last answer (or refusal) was for, null before
 * any. `base`: the answer with no search, what a later search filters at once.
 * `answers`: how many answers there have been.
 * `missing`: the route answered 404 (an older server), and isn't asked again
 * until `retry`. `failed`: any other failure.
 */
type ChoicesState<T> = { status: "ok" | "missing" | "failed"; answeredFor: string | null; rows: readonly T[]; base: readonly T[]; answers: number; attempt: number };
type ChoicesAction<T> = { type: "answered"; q: string; rows: readonly T[] } | { type: "refused"; q: string; missing: boolean } | { type: "retry" };

function choicesReducer<T>(state: ChoicesState<T>, action: ChoicesAction<T>): ChoicesState<T> {
  if (action.type === "answered") return { ...state, status: "ok", answeredFor: action.q, rows: action.rows, base: action.q === "" ? action.rows : state.base, answers: state.answers + 1 };
  if (action.type === "refused") return { ...state, status: action.missing ? "missing" : "failed", answeredFor: action.q };
  return { ...state, status: "ok", answeredFor: null, attempt: state.attempt + 1 };
}

const errorStatus = (error: unknown) => (typeof error === "object" && error !== null && "status" in error ? (error as { status: unknown }).status : null);

/**
 * A filter's choices (#proj-workspace:#221), which never show a search they
 * weren't read for. While the list is open the route is asked with the settled
 * search. The rows shown are the server's answer only when it answers the words
 * in the field now; until then (typing, the debounce, the read itself) they are
 * what is already loaded, filtered here at once, and `phase` is `pending`. So an
 * answer to an older search can't overwrite a newer one: a read that was
 * superseded is dropped, and one that lands while the field has moved on isn't
 * what the field holds, so it only joins what is filtered. "Nothing found" is
 * for `ok`, which only an answer to these words gives. `answer` names the
 * server's answer to a search while it is what is shown, so the list's highlight
 * can go to its first row (ArtifactFilterCombobox); the list with no search keeps
 * its place, as an answer there only refreshes what is on screen.
 */
export function useFilterChoices<T>(open: boolean, query: string, source: FilterChoicesSource<T>) {
  const [state, dispatch] = useReducer(choicesReducer<T>, { status: "ok", answeredFor: null, rows: [], base: [], answers: 0, attempt: 0 });
  const words = query.trim();
  const settled = useDebouncedValue(words, SEARCH_DEBOUNCE_MS);
  const asked = useRef(0);
  const missing = state.status === "missing";
  useEffect(() => {
    if (!open || missing) return;
    const current = ++asked.current;
    source.ask(settled).then(
      (rows) => { if (asked.current === current) dispatch({ type: "answered", q: settled, rows }); },
      (error: unknown) => { if (asked.current === current) dispatch({ type: "refused", q: settled, missing: errorStatus(error) === 404 }); },
    );
  }, [open, settled, missing, state.attempt, source]);
  const retry = useCallback(() => dispatch({ type: "retry" }), []);
  const phase = missing ? "missing" : state.answeredFor === words ? state.status : "pending";
  const rows = useMemo(() => {
    if (phase === "ok") return state.rows;
    const known = new Map([...state.rows, ...state.base].map((row) => [source.keyOf(row), row]));
    const lower = words.toLocaleLowerCase();
    return [...known.values()].filter((row) => source.matches(row, lower));
  }, [phase, state.rows, state.base, words, source]);
  return { rows, phase, answer: phase === "ok" && words !== "" ? state.answers : null, retry };
}
