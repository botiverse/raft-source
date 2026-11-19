import { useLayoutEffect } from "react";

/**
 * The facts about the row's columns that index.css's row rules depend on, written as attributes on the row itself
 * (`.thread-layout-container`) instead of being read with `:has(> …)` there.
 *
 * Any `:has()` on the row, even one that only looks at its direct children, made the browser restyle the whole page
 * again after a channel switch: four extra full-page style passes, about 80 ms, with the rules not even matching
 * (raft-perf on `#wa-main`, #proj-frontend:#58). Attributes on the row change only when a fact changes, and then
 * invalidate only what the rules select.
 *
 * Each attribute mirrors one selector the rules used, so they mean exactly what the `:has()` did:
 * - `data-has-thread`: `> .thread-side-column`
 * - `data-has-thread-covers`: `> .thread-side-column[data-covers]`
 * - `data-has-profile`: `> .thread-profile-side-column`
 * - `data-profile-collapse-channel` / `data-profile-collapse-thread`: that column's `data-collapse-*` values
 * - `data-has-legacy-task`: `> :is([data-testid="legacy-task-panel"], [data-legacy-task-panel-fallback])`
 * - `data-has-help`: `> .shortcut-help-column`
 * - `data-help-row-width`: `> .shortcut-help-column[data-row-width]`
 * - `data-has-side-beside`: `> [data-testid="channel-side-slot"] [data-mode="beside"]`
 * - `data-has-side-float`: `[data-testid="channel-side-float-slot"] [data-mode="float"]`
 */
export const ROW_FACT_ATTRIBUTES = [
  "data-has-thread",
  "data-has-thread-covers",
  "data-has-profile",
  "data-profile-collapse-channel",
  "data-profile-collapse-thread",
  "data-has-legacy-task",
  "data-has-help",
  "data-help-row-width",
  "data-has-side-beside",
  "data-has-side-float",
] as const;

type RowFact = (typeof ROW_FACT_ATTRIBUTES)[number];

/** The attributes of the row's columns and the side areas the facts come from (the columns' classes are fixed). */
const WATCHED_ATTRIBUTES = ["data-covers", "data-collapse-channel", "data-collapse-thread", "data-row-width", "data-mode"];
const SIDE_SLOT = '[data-testid="channel-side-slot"]';
const FLOAT_SLOT = '[data-testid="channel-side-float-slot"]';
const LEGACY_TASK = '[data-testid="legacy-task-panel"], [data-legacy-task-panel-fallback]';

/** What the row's columns say now: an attribute's value, or null where it doesn't hold. One pass over the row's own
 *  children for the column facts; only the floating side area, which sits inside the conversation, is searched for. */
export function readRowFacts(row: Element): Record<RowFact, string | null> {
  let thread: Element | null = null;
  let profile: Element | null = null;
  let help: Element | null = null;
  let legacyTask = false;
  let sideBeside = false;
  for (const child of Array.from(row.children)) {
    if (!thread && child.classList.contains("thread-side-column")) thread = child;
    if (!profile && child.classList.contains("thread-profile-side-column")) profile = child;
    if (!help && child.classList.contains("shortcut-help-column")) help = child;
    if (!legacyTask && child.matches(LEGACY_TASK)) legacyTask = true;
    if (!sideBeside && child.matches(SIDE_SLOT) && child.querySelector('[data-mode="beside"]')) sideBeside = true;
  }
  return {
    "data-has-thread": thread ? "" : null,
    "data-has-thread-covers": thread?.hasAttribute("data-covers") ? "" : null,
    "data-has-profile": profile ? "" : null,
    "data-profile-collapse-channel": profile?.getAttribute("data-collapse-channel") ?? null,
    "data-profile-collapse-thread": profile?.getAttribute("data-collapse-thread") ?? null,
    "data-has-legacy-task": legacyTask ? "" : null,
    "data-has-help": help ? "" : null,
    "data-help-row-width": help?.hasAttribute("data-row-width") ? "" : null,
    "data-has-side-beside": sideBeside ? "" : null,
    "data-has-side-float": row.querySelector(`${FLOAT_SLOT} [data-mode="float"]`) ? "" : null,
  };
}

/** Whether a mutation can change a fact: on the row or one of its columns, inside a side area, or adding or removing
 *  one. A change in the conversation (every message) is none of these, so it costs a few checks, not a re-read. */
function touchesFacts(row: Element, record: MutationRecord): boolean {
  const target = record.target as Element;
  if (target === row || target.parentElement === row) return true;
  if (target.closest?.(`${SIDE_SLOT}, ${FLOAT_SLOT}`)) return true;
  for (const node of [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]) {
    if (node instanceof Element && (node.matches(FLOAT_SLOT) || node.querySelector(FLOAT_SLOT))) return true;
  }
  return false;
}

/** Writes the facts that changed; an unchanged attribute is left alone, so it invalidates nothing. */
export function applyRowFacts(row: Element): void {
  const facts = readRowFacts(row);
  for (const name of ROW_FACT_ATTRIBUTES) {
    const value = facts[name];
    if (value === null) {
      if (row.hasAttribute(name)) row.removeAttribute(name);
    } else if (row.getAttribute(name) !== value) {
      row.setAttribute(name, value);
    }
  }
}

/**
 * Keeps the row's fact attributes current: once before the first paint, then after every change to its columns or
 * side areas. The observer's callback runs before the browser's next style calculation. Code that reads computed
 * style from its own MutationObserver on the row must create it after this one (ChannelSideArea calls this hook before
 * useSideRoom), or it reads the facts from before the change.
 */
export function useRowFacts(row: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (!row) return;
    applyRowFacts(row);
    const observer = new MutationObserver((records) => {
      if (records.some((record) => touchesFacts(row, record))) applyRowFacts(row);
    });
    observer.observe(row, { childList: true, subtree: true, attributes: true, attributeFilter: WATCHED_ATTRIBUTES });
    return () => observer.disconnect();
  }, [row]);
}
