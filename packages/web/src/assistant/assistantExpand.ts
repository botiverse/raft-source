// Expand and back to the popover (Artea's option A): the otter's popover
// opens the assistant page, and the page goes back to a conversation with the
// popover open again. Hand-offs across one navigation each, so plain module
// state, not a store anything renders from:
//
// - the origin: set by Expand in the popover, read by the assistant page
//   when it mounts (AssistantRoute) and cleared there, so it is taken once;
//   the page keeps it for as long as it stays mounted. Reached any other way
//   (the rail, a link, Forward), the page goes back to the conversation
//   before it in this tab's history instead (previousConversation), and with
//   none, Home;
// - the reopen request: set when the assistant page is left for that
//   conversation, by Back to popover or by the browser's own Back, and taken
//   once by the otter on that conversation's composer when it mounts there
//   (AssistantOtter), which then opens its panel.
//
// Each is for one server and expires after a few seconds, so one whose
// navigation never happened (or a server switch in between) is never picked
// up later.

import { UNKNOWN_NAVIGATION_ENTRY } from "../hooks/useAppNavigate";

export type AssistantExpandOrigin = {
  serverId: string;
  /** pathname + search + hash of the conversation to go back to. */
  path: string;
  /** The browser history index of that entry (React Router's `history.state.idx`), when known. */
  historyIdx?: number | null;
};

/** How long a hand-off waits for its page to mount. */
export const ASSISTANT_EXPAND_HANDOFF_MS = 10_000;

type Handoff = AssistantExpandOrigin & { at: number };

let origin: Handoff | null = null;
let pendingReopen: Handoff | null = null;
/** A sidebar row pressed while the popover was open: open on the conversation it opens, whichever. */
let carry: { serverId: string; at: number } | null = null;

function live(handoff: Handoff | null, serverId: string): handoff is Handoff {
  return handoff !== null && handoff.serverId === serverId && Date.now() - handoff.at <= ASSISTANT_EXPAND_HANDOFF_MS;
}

/** Expand: remember where the person came from. */
export function rememberAssistantExpandOrigin(from: AssistantExpandOrigin): void {
  origin = { ...from, at: Date.now() };
  pendingReopen = null;
}

/** The origin, if the popover was expanded on this server just now. Reads only (safe in a render). */
export function peekAssistantExpandOrigin(serverId: string | null): AssistantExpandOrigin | null {
  const current = origin;
  if (!serverId || !live(current, serverId)) return null;
  return { serverId: current.serverId, path: current.path, historyIdx: current.historyIdx ?? null };
}

/** The assistant page has read it (or found none): no later visit finds it. */
export function clearAssistantExpandOrigin(): void {
  origin = null;
}

/**
 * The otter on `to.path` opens its panel when it mounts there. With a
 * `historyIdx`, only on that history entry: leaving the assistant page some
 * other way that happens to land on the same conversation (the rail) does
 * not open it.
 */
export function requestAssistantReopen(to: AssistantExpandOrigin): void {
  origin = null;
  pendingReopen = { ...to, at: Date.now() };
}

/** An otter mounted on `path`: true once if a reopen was asked for here. */
export function takeAssistantReopen(serverId: string | null, path: string): boolean {
  const pending = pendingReopen;
  if (!serverId || !live(pending, serverId) || pending.path !== path) return false;
  const idx = currentHistoryIdx();
  if (typeof pending.historyIdx === "number" && idx !== null && pending.historyIdx !== idx) return false;
  pendingReopen = null;
  return true;
}

/**
 * A conversation was picked in the sidebar while the popover was open: the
 * popover stays open on it, attaching it instead (Tenny, #17 item 4). The
 * otter there may be the same one (channel to channel) or a new one (a
 * channel to a DM: another route); either takes this once.
 */
export function carryAssistantOpen(serverId: string): void {
  carry = { serverId, at: Date.now() };
}

/** An otter mounted, or its conversation changed: true once if the popover was carried here. */
export function takeAssistantCarry(serverId: string | null): boolean {
  const pending = carry;
  if (!serverId || pending === null || pending.serverId !== serverId || Date.now() - pending.at > ASSISTANT_EXPAND_HANDOFF_MS) return false;
  carry = null;
  return true;
}

/** The assistant page has no otter: a carry headed there (its own DM's row) is dropped. */
export function dropAssistantCarry(): void {
  carry = null;
}

/** A channel or DM page on this server (a thread opened in it included): one with an otter on its composer. */
export function isConversationPath(path: string, serverSlug: string): boolean {
  return new RegExp(`^/s/${serverSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:channel|dm)/[^/?#]+(?:[?#]|$)`).test(path);
}

/**
 * Back to popover on an assistant page not opened by Expand: the latest
 * conversation on this server in this tab's history behind it. `stack` is
 * NavigationDepthTracker's (it may not hold the assistant page's own entry
 * yet when read in its first render). Stops at an entry this document never
 * saw or one on another server: there is nothing to go back to there.
 */
export function previousConversation(
  stack: readonly string[],
  { serverId, serverSlug, assistantPath, assistantDmId, historyIdx }: {
    serverId: string;
    serverSlug: string;
    assistantPath: string;
    /** The assistant's own DM: its URL is this page (it redirects here), not a conversation to go back to. */
    assistantDmId: string | null;
    /** The assistant page's own history index, when the browser has one. */
    historyIdx: number | null;
  },
): AssistantExpandOrigin | null {
  const end = stack.at(-1) === assistantPath ? stack.length - 1 : stack.length;
  for (let at = end - 1; at >= 0; at -= 1) {
    const path = stack[at];
    if (path === UNKNOWN_NAVIGATION_ENTRY || !path.startsWith(`/s/${serverSlug}`)) return null;
    if (assistantDmId && path.startsWith(`/s/${serverSlug}/dm/${assistantDmId}`)) continue;
    if (isConversationPath(path, serverSlug)) {
      return { serverId, path, historyIdx: historyIdx === null ? null : historyIdx - (end - at) };
    }
  }
  return null;
}

/**
 * How Back to Popover gets there (Artea: a step back is better than a new
 * page). When the entry right before this one is the page it came from, step
 * back, so the browser's own Back afterwards doesn't return to the assistant
 * page; otherwise (reloaded, or arrived some other way since) go there in
 * place of this entry.
 */
export function shrinkNavigation(
  from: AssistantExpandOrigin,
  currentHistoryIdx: number | null | undefined,
): { back: true } | { back: false; path: string } {
  if (typeof from.historyIdx === "number" && currentHistoryIdx === from.historyIdx + 1) return { back: true };
  return { back: false, path: from.path };
}

/** React Router's index of the current history entry, when the browser history carries one. */
export function currentHistoryIdx(): number | null {
  const state = typeof window === "undefined" ? null : (window.history.state as { idx?: unknown } | null);
  return typeof state?.idx === "number" ? state.idx : null;
}

export function resetAssistantExpandForTests(): void {
  origin = null;
  pendingReopen = null;
  carry = null;
}
