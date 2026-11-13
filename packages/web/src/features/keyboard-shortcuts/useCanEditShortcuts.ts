import { useSyncExternalStore } from "react";
import { useMediaQuery } from "../../hooks/effectPrimitives";

/** A key pressed with ⌘, Ctrl or ⌥ since the page loaded: a physical keyboard (a tablet's), whatever the pointer. */
let keyboardSeen = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && !keyboardSeen && typeof window !== "undefined") {
    // keydown-global-exempt: observes once whether a physical keyboard is used (a modifier held), never takes the key
    window.addEventListener("keydown", onKeyDown, true);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("keydown", onKeyDown, true);
  };
}

function onKeyDown(event: KeyboardEvent) {
  if (keyboardSeen || !(event.metaKey || event.ctrlKey || event.altKey)) return;
  keyboardSeen = true;
  window.removeEventListener("keydown", onKeyDown, true);
  for (const listener of listeners) listener();
}

/**
 * Whether the panel lets the person change shortcuts here (Artea: a phone is read-only, a tablet with a physical
 * keyboard can edit): a fine pointer (a mouse or trackpad), or a keyboard seen since load (a key with ⌘, Ctrl or ⌥).
 * A touch screen with no keyboard has no shortcuts to press (raft-design accessibility.md).
 */
export function useCanEditShortcuts(): boolean {
  const finePointer = useMediaQuery("(any-pointer: fine)", true);
  const seen = useSyncExternalStore(subscribe, () => keyboardSeen, () => false);
  return finePointer || seen;
}
