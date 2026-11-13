import { useEffect, useRef } from "react";

/** A phone, where the viewer is a page over what opened it. */
export const PHONE_QUERY = "(max-width: 767px)";

/** A history entry a page owns; `releasing` while its cleanup waits to give it back. */
type PhoneEntry = { marker: string; releasing: boolean };

/**
 * On a phone the viewer is a page over the conversation: it owns a history
 * entry, so the system or browser Back closes it, and closing it any other
 * way gives the entry back. Where the open Artifact is the page's address
 * (`?artifact=`: the Artifacts home, MainLayout's useArtifactOpenAddress; the
 * side card, the shell's card and the viewer over a task's dialog,
 * useArtifactViewerAddress, the store's `addressed`) its entry is the
 * address's, so it pushes none of its own there.
 *
 * The entry is given back a microtask after the effect's cleanup, not in
 * it: StrictMode (development, the visual host) runs the effect, its
 * cleanup and the effect again in one go, and the second run keeps the
 * entry. Given back at once, the `back()` (asynchronous) landed after the
 * second run's new entry, its popstate read as Back, and a page opened
 * with the hook already active closed itself (View Context's phone page).
 */
export function usePhoneHistoryEntry(active: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const entryRef = useRef<PhoneEntry | null>(null);
  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const kept = entryRef.current?.releasing ? entryRef.current : null;
    const entry: PhoneEntry = kept ?? { marker: `artifact-${Math.random().toString(36).slice(2)}`, releasing: false };
    entry.releasing = false;
    entryRef.current = entry;
    if (!kept) {
      const state: unknown = window.history.state;
      window.history.pushState({ ...(typeof state === "object" && state ? state : {}), raftArtifactViewer: entry.marker }, "");
    }
    let popped = false;
    const ours = () => (window.history.state as { raftArtifactViewer?: string } | null)?.raftArtifactViewer === entry.marker;
    const onPopState = () => {
      if (ours()) return;
      popped = true;
      onBackRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (popped || !ours()) {
        if (entryRef.current === entry) entryRef.current = null;
        return;
      }
      entry.releasing = true;
      queueMicrotask(() => {
        // Run again at once (StrictMode): the entry is still the page's.
        if (!entry.releasing) return;
        entry.releasing = false;
        if (entryRef.current === entry) entryRef.current = null;
        if (ours()) window.history.back();
      });
    };
  }, [active]);
}
