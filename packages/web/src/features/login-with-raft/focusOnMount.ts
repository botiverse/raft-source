import type { RefCallback } from "react";

/**
 * Moves focus to the element as it mounts: the refusal that answers Login
 * with Raft, when the button pressed is gone. The element is focusable from
 * script (tabIndex -1), as Settings › Account's sign-out heading is
 * (AccountSignOutSection). Focusing it also scrolls it into view.
 */
export const focusOnMount: RefCallback<HTMLElement> = (element) => {
  element?.focus();
};
