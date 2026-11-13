import { useSyncExternalStore } from "react";

/**
 * How Raft links open in this browser (deep links v1, Settings › Appearance ›
 * How links open; the desktop banner's "Remember my choice"). Kept in this
 * browser only, never on the account: the question is whether this computer
 * has Raft Desktop.
 *
 * - `ask` (default): a desktop browser that lands on a Raft address from
 *   outside offers Raft Desktop, with this computer's download unless the
 *   account used the app in the last 30 days.
 * - `app`: the same offer, told the app is here: no hint read, no download,
 *   no checkbox. The page still never launches raft:// on its own; the
 *   person clicks.
 * - `web`: the offer never shows.
 *
 * Beside it, a quiet time for `ask`: Continue on Web without "Remember my
 * choice" puts the offer away in this browser for 7 days, so someone who
 * stays on the web isn't asked on every new tab. It is not a fourth choice:
 * the preference stays `ask`, and any explicit choice (the setting, or the
 * banner with Remember) ends the quiet time.
 */
export type LinkOpenPreference = "ask" | "app" | "web";

export const LINK_OPEN_PREFERENCE_STORAGE_KEY = "raft_link_open_preference";
/** Epoch milliseconds until which `ask` stays quiet. */
export const LINK_OPEN_QUIET_UNTIL_STORAGE_KEY = "raft_link_open_quiet_until";
export const LINK_OPEN_QUIET_MS = 7 * 24 * 60 * 60 * 1000;

const listeners = new Set<() => void>();

function parse(value: string | null): LinkOpenPreference {
  return value === "app" || value === "web" ? value : "ask";
}

export function readLinkOpenPreference(): LinkOpenPreference {
  try {
    return parse(window.localStorage.getItem(LINK_OPEN_PREFERENCE_STORAGE_KEY));
  } catch {
    return "ask";
  }
}

/** An explicit choice (the setting, or the banner with Remember): it also ends the quiet time. */
export function writeLinkOpenPreference(preference: LinkOpenPreference): void {
  try {
    if (preference === "ask") window.localStorage.removeItem(LINK_OPEN_PREFERENCE_STORAGE_KEY);
    else window.localStorage.setItem(LINK_OPEN_PREFERENCE_STORAGE_KEY, preference);
    window.localStorage.removeItem(LINK_OPEN_QUIET_UNTIL_STORAGE_KEY);
  } catch {
    // Storage blocked: the choice holds for this page only.
  }
  for (const listener of listeners) listener();
}

/** Whether `ask` is quiet now. A missing, unreadable or past time is not quiet. */
export function isLinkOpenQuiet(): boolean {
  try {
    const until = Number(window.localStorage.getItem(LINK_OPEN_QUIET_UNTIL_STORAGE_KEY));
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

/** Continue on Web without Remember: no offer in this browser for 7 days. */
export function quietLinkOpenOffer(): void {
  try {
    window.localStorage.setItem(LINK_OPEN_QUIET_UNTIL_STORAGE_KEY, String(Date.now() + LINK_OPEN_QUIET_MS));
  } catch {
    // Storage blocked: the banner still goes away for this page.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === LINK_OPEN_PREFERENCE_STORAGE_KEY || event.key === LINK_OPEN_QUIET_UNTIL_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useLinkOpenPreference(): LinkOpenPreference {
  return useSyncExternalStore(subscribe, readLinkOpenPreference, () => "ask");
}

export function useLinkOpenQuiet(): boolean {
  return useSyncExternalStore(subscribe, isLinkOpenQuiet, () => false);
}
