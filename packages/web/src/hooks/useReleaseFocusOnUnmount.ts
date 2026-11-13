import { useLayoutEffect } from "react";

/**
 * Before a tree that holds the focus is taken out of the page, move the focus off it.
 *
 * Removing the focused element makes the browser restyle the page in the same
 * call that removes it: switching away from a 300-channel server spent ~45ms of
 * its ~110ms task there, the composer being focused (#proj-frontend:#40). A
 * blur first, in the same task, costs almost nothing, so the removal doesn't.
 *
 * A layout effect's cleanup runs while React walks the removed tree, before it
 * detaches the tree's DOM, so the blur comes first: synchronously, never
 * deferred. `root` names the element the tree draws (a selector). Focus outside
 * the app's own container (`app`) is released too: that is a portal in the body,
 * such as a dialog opened over the server, and it goes with the tree (3 of 12
 * slow leaves had the focus on the old task modal's backdrop). Focus elsewhere
 * in the app is left alone.
 *
 * It only lets the focus go; it never gives it back. Where the focus goes next
 * is the next tree's call: entering a server is the person's action, and its
 * composer takes the focus on mount (desktop only, and only if the focus isn't
 * already in another field or an open dialog: mayTakeFocus). StrictMode's
 * mount-time cleanup (dev only) blurs too: the composer's mount effect runs
 * again after it and takes the focus back, but focus set by a JSX `autoFocus`
 * in the shell's first commit, or held in a body portal (a dialog) then, stays
 * released in dev. Production never runs the cleanup without the tree leaving.
 */
export function useReleaseFocusOnUnmount(root: string, app = "#root"): void {
  useLayoutEffect(() => () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) return;
    const appRoot = document.querySelector(app);
    if (!active.closest(root) && (!appRoot || appRoot.contains(active))) return;
    active.blur();
  }, [root, app]);
}
