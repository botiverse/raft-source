// The provider a shell uses when the page's top row is the window's title bar.
//
// Two shells lay window controls over the page instead of drawing a title bar
// of their own: the desktop app (apps/desktop, every platform) and the
// installed web app under the Window Controls Overlay (windowControlsOverlay.tsx).
// Both hand the web their TopBarHost here, and with `titleBar` set the web
// does the rest itself:
//   - the top bar (server pages) is the title bar: TopBarHostContext;
//   - off server pages (signed out, onboarding, the server picker) the
//     stand-in strip is, so the window always has a drag region and nothing
//     sits under the controls;
//   - the layer guard keeps the bar clickable under open menus and dialogs;
//   - in the desktop app, the bridge's window facts go onto <html> for
//     titleBar.css and, on Windows / Linux, the bar's colours go back to the
//     shell for the caption buttons (desktopTitleBar.ts).
// With a null host (or no `titleBar`) it only provides the context: a browser
// tab is unchanged. The element tree is the same either way, so a host that
// comes and goes (the overlay toggled) never remounts the app.

import { useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import { getDesktopBridge } from "../../utils/desktopBridge";
import { installDesktopWindowChrome, installTitleBarOverlayReport } from "./desktopTitleBar";
import { installLayerGuard } from "./layerGuard";
import { StandInTitleBar } from "./StandInTitleBar";
import { TopBarHostContext, TopBarMountedContext } from "./topBarHostContext";
import type { TopBarHost } from "./topBarHostContext";

export function TitleBarHost({ host, children }: { host: TopBarHost | null; children: ReactNode }) {
  const titleBar = host?.titleBar === true;
  // The top bar reports itself (ShellTopBar); until then the stand-in strip is the title bar.
  const [barMounted, setBarMounted] = useState(false);
  useLayoutEffect(() => {
    if (!titleBar) return undefined;
    const bridge = getDesktopBridge();
    const removeChrome = bridge ? installDesktopWindowChrome(document.documentElement, bridge) : null;
    let reporter: ReturnType<typeof installTitleBarOverlayReport> | null = null;
    const removeGuard = installLayerGuard(document, () => reporter?.sync());
    // Windows / Linux paint their caption buttons in the bar's colours; macOS
    // draws the traffic lights in the system's own, so there is nothing to report.
    if (bridge?.titleBar === "overlay" && bridge.platform !== "darwin" && bridge.window?.setTitleBarOverlay) {
      reporter = installTitleBarOverlayReport(document, (overlay) => bridge.window.setTitleBarOverlay(overlay));
    }
    return () => {
      removeGuard();
      reporter?.dispose();
      removeChrome?.();
    };
  }, [titleBar]);
  return (
    <TopBarHostContext value={host}>
      <TopBarMountedContext value={setBarMounted}>
        {titleBar && !barMounted ? <StandInTitleBar /> : null}
        {children}
      </TopBarMountedContext>
    </TopBarHostContext>
  );
}
