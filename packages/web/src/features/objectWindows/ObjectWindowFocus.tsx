import { useEffect, useEffectEvent } from "react";
import { installObjectWindowFocus, restoreOpenerFocus } from "./objectWindowFocusWiring";
import { useObjectWindowStore } from "./objectWindowStore";
import type { ObjectWindowEntry } from "./objectWindowStore";

/**
 * An object window's focus (objectWindowFocusWiring.ts): what had it when the window
 * lost it gets it back when the window does, and the window closing gives it
 * back to the element it was opened from in the main window.
 */
export function ObjectWindowFocus({ entry }: { entry: ObjectWindowEntry }) {
  const { name, win, doc } = entry;

  useEffect(() => installObjectWindowFocus(win, doc), [win, doc]);

  // The latest opener (a plain open that reused this window replaced it).
  const giveFocusBack = useEffectEvent(() => {
    // Gone from the store: closed (not a remount of this window's portal).
    if (useObjectWindowStore.getState().windows.has(name)) return;
    restoreOpenerFocus(entry.openedFrom?.deref());
  });
  useEffect(() => () => giveFocusBack(), [name]);

  return null;
}
