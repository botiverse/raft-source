import { useEffect, useEffectEvent } from "react";
import { useNavigate } from "react-router-dom";
import { installObjectWindowLinkRouting } from "./objectWindowLinkRouting";
import { raiseMainWindow } from "./raiseMainWindow";

/**
 * Links in an object window act on the main window (objectWindowLinkRouting.ts):
 * an unhandled click on a link to this app's own page navigates the main
 * window there and raises it. (The main router moving while an object window
 * has the focus raises it too: ObjectWindowLocationRaise.)
 */
export function ObjectWindowNavigation({ doc }: { doc: Document }) {
  const navigate = useNavigate();
  const navigateTo = useEffectEvent((path: string) => { void navigate(path); });

  useEffect(() => installObjectWindowLinkRouting(doc, {
    navigate: (path) => navigateTo(path),
    raiseMain: () => { void raiseMainWindow(); },
    appHref: () => window.location.href,
  }), [doc]);

  return null;
}
