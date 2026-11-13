import type { NavigateFunction } from "react-router-dom";

// History-entry mark for a Search / Activity result opened as a pushed page
// (phone). Kept in the entry's router state, not in memory: leaving for another
// page and coming Back re-shows the same entry, mark included, so closing the
// result still pops it instead of leaving a duplicate list entry behind.
export const CONTENT_SLOT_ENTRY_MARK = "raftContentSlotEntry";

export function isContentSlotEntry(): boolean {
  const usr = (window.history.state as { usr?: unknown } | null)?.usr;
  return !!usr && typeof usr === "object" && (usr as Record<string, unknown>)[CONTENT_SLOT_ENTRY_MARK] === true;
}

export function historyEntryIndex(): number | null {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : null;
}

/** Puts the mark back on the current entry, keeping its router index/key and any other state. */
export function stampContentSlotEntry(): void {
  const state = (window.history.state ?? {}) as { usr?: unknown };
  const usr = state.usr && typeof state.usr === "object" ? state.usr as Record<string, unknown> : {};
  window.history.replaceState({ ...state, usr: { ...usr, [CONTENT_SLOT_ENTRY_MARK]: true } }, "", window.location.href);
}

/**
 * Rewrites the current entry's query in place, its state (the mark) kept: a
 * param a store is about to want (`?thread=`, `?task=`) written first, so the
 * store's own URL sync finds it there and pushes no entry of its own.
 */
export function replaceEntryParams(navigate: NavigateFunction, edit: (params: URLSearchParams) => void): void {
  const params = new URLSearchParams(window.location.search);
  edit(params);
  const search = params.toString();
  const usr = (window.history.state as { usr?: unknown } | null)?.usr;
  navigate({ pathname: window.location.pathname, search: search ? `?${search}` : "" }, { replace: true, state: usr });
}
