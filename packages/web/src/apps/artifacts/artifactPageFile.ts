import { useCallback, useSyncExternalStore } from "react";

import { ARTIFACT_PAGE_FILE_PARAM } from "./artifactShownFile";

/**
 * The file the Artifact's own page shows, kept in its address (`?file=<path>`; #proj-workspace:#272):
 * opening a file is a new history entry, so Back returns to the one before (the entry file, at
 * first), and the address can be sent to someone as a link to that file. A version pick goes to
 * that version's address, which names no file.
 *
 * The page takes no router (its moves are its host's: `onGo`), so the address is read from the
 * window: on Back and Forward (`popstate`), and after this page's own move (told here, since a
 * pushed entry fires no event).
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

const fileInAddress = (): string | null => new URLSearchParams(window.location.search).get(ARTIFACT_PAGE_FILE_PARAM);
const noFile = (): null => null;

/** The address with `path` as its file (null: none), the rest of it kept: the path, the other queries, the hash. */
export function pageAddressWithFile(location: Pick<Location, "pathname" | "search" | "hash">, path: string | null): string {
  const params = new URLSearchParams(location.search);
  if (path === null) params.delete(ARTIFACT_PAGE_FILE_PARAM);
  else params.set(ARTIFACT_PAGE_FILE_PARAM, path);
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
}

/** The file the page's address names (null: none), and the move to another: a new history entry through `onGo`. */
export function usePageFile(onGo: (path: string) => void): { path: string | null; show: (path: string | null) => void } {
  const path = useSyncExternalStore(subscribe, fileInAddress, noFile);
  const show = useCallback((next: string | null) => {
    if (next === fileInAddress()) return;
    onGo(pageAddressWithFile(window.location, next));
    for (const listener of listeners) listener();
  }, [onGo]);
  return { path, show };
}
