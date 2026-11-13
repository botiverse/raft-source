import { useCallback, useState } from "react";

/**
 * A one-shot request that the setup page's next card take focus on its title
 * as it mounts: after a 409 login_mode_changed the page looks the App up
 * again, and the card the person was on is gone. The first title to mount
 * spends it, so a later lookup (the Servers list refreshing) remounts the
 * card without taking focus. The title is focusable from script (tabIndex
 * -1), as Settings › Account's sign-out heading is (AccountSignOutSection).
 */
export function useTitleFocusRequest() {
  const [requested, setRequested] = useState(false);
  const focusTitle = useCallback((element: HTMLHeadingElement | null) => {
    if (!element) return;
    element.focus();
    setRequested(false);
  }, []);
  const requestTitleFocus = useCallback(() => setRequested(true), []);
  return { titleRef: requested ? focusTitle : undefined, requestTitleFocus };
}
