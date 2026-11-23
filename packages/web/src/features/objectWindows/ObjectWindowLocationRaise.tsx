import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { takeObjectWindowNavigationIntent } from "./objectWindowLinkRouting";
import { raiseMainWindow } from "./raiseMainWindow";

/**
 * A main-router navigation started in an object window (a Link or a button
 * in its object: the portal shares the main window's router; a press there
 * notes the intent, objectWindowLinkRouting.ts) brings the main window
 * forward, where the page changed. A navigation of the main page's own (a
 * redirect, a replace, a socket-driven move) raises nothing. Mounted once by
 * ObjectWindowsHost, for the layout's life.
 */
export function ObjectWindowLocationRaise() {
  const { key } = useLocation();
  useEffect(() => {
    if (takeObjectWindowNavigationIntent()) void raiseMainWindow();
  }, [key]);
  return null;
}
