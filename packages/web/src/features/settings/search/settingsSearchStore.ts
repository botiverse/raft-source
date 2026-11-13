import { useEffect, useRef } from "react";
import { create } from "zustand";
import { normalizeSettingsSearchText } from "./settingsSearchMatch";

interface SettingsSearchState {
  query: string;
  /** The server the query was typed on: another server's Settings starts empty (useSettingsSearchQuery). */
  serverSlug: string | null;
  setQuery: (query: string, serverSlug: string | null) => void;
  /** Gone from the Settings of `serverSlug`: clear the query unless `pathname` is still one of its pages. */
  left: (serverSlug: string | null, pathname: string) => void;
}

/** The server of a page of Settings itself (/s/<slug>/settings…), or null for any other page. */
function settingsPathServerSlug(pathname: string): string | null {
  return /^\/s\/([^/]+)\/settings(?:\/|$)/.exec(pathname)?.[1] ?? null;
}

/** A page of Settings itself, where ⌘F / Ctrl+F is Search settings. */
export function isSettingsPath(pathname: string): boolean {
  return settingsPathServerSlug(pathname) !== null;
}

/**
 * The Settings search's query, outside the list: on a phone opening a result
 * pushes its page over the list, and Back returns to the results with the
 * query kept (raft-design settings.md#searching-settings). It lasts while the
 * person stays in Settings on one server; leaving Settings or switching
 * server clears it. Not in the URL: the page a result opens has its own
 * address, and Back must not land on a half-typed query.
 */
export const useSettingsSearchStore = create<SettingsSearchState>((set) => ({
  query: "",
  serverSlug: null,
  setQuery: (query, serverSlug) => set({ query, serverSlug }),
  left: (serverSlug, pathname) => {
    if (settingsPathServerSlug(pathname) !== serverSlug) set({ query: "" });
  },
}));

/** The query typed on this server's Settings; empty on another server's. */
export function useSettingsSearchQuery(serverSlug: string | null): string {
  return useSettingsSearchStore((s) => (s.serverSlug === serverSlug ? s.query : ""));
}

/**
 * Keep the query only inside this server's Settings. Called by the list
 * (SettingsSearch, mounted again for another server) and by a settings page
 * (SettingsPanel), one of which is on screen anywhere in Settings: the one
 * going away reads the address, which has already changed, and the query
 * goes once it is outside the Settings of the server it was mounted on.
 */
/** Whether Search settings has a query for this server: then its results take the list of pages' place. */
export function useSettingsSearching(serverSlug: string | null): boolean {
  return normalizeSettingsSearchText(useSettingsSearchQuery(serverSlug)) !== "";
}

export function useSettingsSearchLifetime(serverSlug: string | null | undefined): void {
  const mountedOn = useRef(serverSlug ?? null);
  useEffect(() => () => useSettingsSearchStore.getState().left(mountedOn.current, window.location.pathname), []);
}
