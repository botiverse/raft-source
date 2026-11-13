import type { InboxFilter, InboxScope } from "./inboxStore";

/**
 * The filter last chosen in Activity's Filter menu, kept per server in this
 * browser (task #172): a reload, a new tab or coming back to the server shows
 * the same list. Only the menu's choices are kept; anything else stored
 * (an old or hand-edited value) reads as All.
 */
export type ActivityFilterChoice = "all" | "unread" | "mentions" | "pinned" | "saved" | "artifacts";

export const ACTIVITY_FILTER_CHOICES: readonly ActivityFilterChoice[] = ["all", "unread", "mentions", "pinned", "saved", "artifacts"];

const STORAGE_PREFIX = "raft.activity.filter.";

export function activityFilterStorageKey(serverId: string): string {
  return STORAGE_PREFIX + serverId;
}

export function parseActivityFilterChoice(value: unknown): ActivityFilterChoice {
  return ACTIVITY_FILTER_CHOICES.find((choice) => choice === value) ?? "all";
}

export function readActivityFilterChoice(serverId: string | null | undefined): ActivityFilterChoice {
  if (!serverId) return "all";
  try {
    return parseActivityFilterChoice(localStorage.getItem(activityFilterStorageKey(serverId)));
  } catch {
    return "all";
  }
}

export function writeActivityFilterChoice(serverId: string | null | undefined, choice: ActivityFilterChoice): void {
  if (!serverId) return;
  try {
    if (choice === "all") localStorage.removeItem(activityFilterStorageKey(serverId));
    else localStorage.setItem(activityFilterStorageKey(serverId), choice);
  } catch {
    // Storage full or blocked: the choice holds until the page reloads.
  }
}

/** Pinned, Saved and Artifacts are scopes over All, not read filters: the store keeps the two apart. */
export function inboxStateForActivityFilter(choice: ActivityFilterChoice): { filter: InboxFilter; scope: InboxScope | null } {
  return choice === "pinned" || choice === "saved" || choice === "artifacts" ? { filter: "all", scope: choice } : { filter: choice, scope: null };
}

/** The menu's choice for the store's list; a filter the menu doesn't offer (Unread mentions) reads as its nearest, Mentions. */
export function activityFilterOf(filter: InboxFilter, scope: InboxScope | null): ActivityFilterChoice {
  if (scope) return scope;
  if (filter === "unread_mentions") return "mentions";
  return filter;
}
