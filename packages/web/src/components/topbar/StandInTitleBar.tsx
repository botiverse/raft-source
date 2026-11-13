import RaftBrandLockup from "../brand/RaftBrandLockup";
import { AUTH_BRAND_TOP_BAR_CLASS } from "../brand/AuthBrandShell";

/**
 * The window's title bar on pages without the web's top bar (signed out, the
 * restoring-session screen, onboarding, the server picker), in a shell whose
 * top row is the window's title bar: the desktop app, and the installed web
 * app under the Window Controls Overlay; TitleBarHost renders it while the top
 * bar is absent. Without
 * it such a window would have no drag region, and nothing would keep content
 * out from under the window controls (titleBar.css pads `data-raft-titlebar`).
 *
 * Same recipe as the auth pages' own AuthBrandTopBar, which hides itself in
 * these shells in favour of this strip: the same frame tokens in light and
 * dark and the same logo treatment, so a signed-out window looks like the
 * signed-out web in both modes. Only the height differs: h-11 (44px) matches the
 * desktop top bar it stands in for, and centres the desktop's native traffic
 * lights, which sit at a fixed y tuned to that bar (task #85); 48px with a
 * coarse pointer (Windows tablet mode), as the top bar and the reported
 * overlay height (installTitleBarOverlayReport) are.
 */
export function StandInTitleBar() {
  return (
    <div data-raft-titlebar data-testid="stand-in-title-bar" className={AUTH_BRAND_TOP_BAR_CLASS.replace("h-panel-header", "h-11 pointer-coarse:h-12")}>
      <RaftBrandLockup className="h-5 w-auto [color-scheme:only_light]" />
    </div>
  );
}
