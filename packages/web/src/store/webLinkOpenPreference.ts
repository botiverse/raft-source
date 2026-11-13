import { useSyncExternalStore } from "react";

/**
 * How a plain web link in a message opens in Raft Desktop (Settings ›
 * Appearance › How web links open; asked once, on the first such click:
 * features/webPreview/WebLinkChoiceDialog). Only where the desktop web
 * preview view is on (desktop_web_preview_view_v0 and a shell with
 * raftDesktop.webPreview); a browser tab never reads it. Kept on this device
 * only, like the Raft-link choice beside it (linkOpenPreference.ts).
 *
 * - `beside`: in Raft, in the web preview beside the conversation.
 * - `browser`: in the system browser, as before.
 * - null: not chosen yet; the first click asks.
 */
export type WebLinkOpenPreference = "beside" | "browser";

export const WEB_LINK_OPEN_PREFERENCE_STORAGE_KEY = "raft_web_link_open_preference";

const listeners = new Set<() => void>();

function parse(value: string | null): WebLinkOpenPreference | null {
  return value === "beside" || value === "browser" ? value : null;
}

export function readWebLinkOpenPreference(): WebLinkOpenPreference | null {
  try {
    return parse(window.localStorage.getItem(WEB_LINK_OPEN_PREFERENCE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeWebLinkOpenPreference(preference: WebLinkOpenPreference | null): void {
  try {
    if (preference === null) window.localStorage.removeItem(WEB_LINK_OPEN_PREFERENCE_STORAGE_KEY);
    else window.localStorage.setItem(WEB_LINK_OPEN_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // Storage blocked: nothing is remembered and the next click asks again.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === WEB_LINK_OPEN_PREFERENCE_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useWebLinkOpenPreference(): WebLinkOpenPreference | null {
  return useSyncExternalStore(subscribe, readWebLinkOpenPreference, () => null);
}
