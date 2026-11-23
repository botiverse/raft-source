// The Window Controls Overlay's geometry on <html>, for titleBar.css. Shared by
// the two shells that lay window controls over the page: the installed web app
// (windowControlsOverlay.tsx) and the desktop app (desktopTitleBar.ts; Electron
// implements the same overlay when the window has `titleBarOverlay`).

/** `navigator.windowControlsOverlay` (Chromium; not in TypeScript's DOM types yet). */
interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

function overlayOf(win: Window): WindowControlsOverlay | undefined {
  return (win.navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay;
}

/**
 * Mirrors the overlay onto <html> for titleBar.css: `data-title-bar="overlay"`
 * (the controls take the bar's right end, as on the desktop app under Windows),
 * and `data-title-bar-start="overlay"` while they also take its left end (macOS:
 * the traffic lights, so the clear area starts past them, titlebar-area-x > 0).
 * Kept in step with the overlay's geometry. Returns a disposer.
 */
export function installWindowControlsOverlayAttributes(root: HTMLElement, win: Window = window): () => void {
  const overlay = overlayOf(win);
  root.dataset.titleBar = "overlay";
  const syncStart = () => {
    const startsAfterControls = (overlay?.getTitlebarAreaRect?.().x ?? 0) > 0;
    if (startsAfterControls) root.dataset.titleBarStart = "overlay";
    else delete root.dataset.titleBarStart;
  };
  syncStart();
  overlay?.addEventListener?.("geometrychange", syncStart);
  return () => {
    overlay?.removeEventListener?.("geometrychange", syncStart);
    delete root.dataset.titleBar;
    delete root.dataset.titleBarStart;
  };
}

/** The traffic lights' corner on <html>, set only from a consistent reading (installSteadyMacTitleBarArea). */
export const STEADY_TITLE_BAR_START_VAR = "--raft-desktop-titlebar-start";

/**
 * Raft Desktop on macOS: the traffic lights' corner from the overlay's
 * geometry, but only from readings that are consistent, held while the window
 * is resized.
 *
 * Electron reads the overlay's geometry off the traffic lights' current
 * frames. The app puts them at its own spot (trafficLightPosition, x=16);
 * AppKit's default is x≈7. While the window is resized some readings come back
 * with the lights at AppKit's spot (observed on Electron 44.11.3 in a screen
 * recording; why the deferred read still sees them there after Electron's
 * redraw is unresolved): titlebar-area-x 9px short and, since the width is the
 * window less the lights' box, an area that ends 9px before the window's right
 * edge on a Mac that has nothing there. titleBar.css padded the bar by both,
 * so it jumped 9px left and back during a drag (#proj-deskop:#12).
 *
 * A reading with the lights where the app put them spans the page to its right
 * edge (x + width = the page's width; 1px of slack for Blink's rounding to
 * whole CSS px); one with them at AppKit's spot ends 9px short. Only spanning
 * readings are published (STEADY_TITLE_BAR_START_VAR plus
 * `data-title-bar-steady`, which also zeroes the end inset: the desktop on
 * macOS has no controls on the right). Before the first one, titleBar.css keeps
 * the live env(titlebar-area-*). A stale reading from a window about 9px
 * wider can also span the page (9px short of the old width); it is told apart
 * by its x: at one zoom and screen scale (devicePixelRatio) the lights'
 * corner never moves, and a mid-move reading is always further left, so a
 * smaller x at the same ratio is ignored. Any change of ratio (zoom, another
 * display; watched with a resolution media query, so one that happens while
 * no reading arrives, as in full screen, still counts) starts over from the
 * next spanning reading.
 * DevTools docked beside the page (developer only): Electron clips the area to
 * the page; docked right the x check above still drops mid-move readings, and
 * docked left x is 0 and the left corner is dropped as before. Returns a
 * disposer.
 */
export function installSteadyMacTitleBarArea(root: HTMLElement, win: Window = window): () => void {
  const overlay = overlayOf(win);
  let held: { x: number; ratio: number } | null = null;
  let ratioQuery: MediaQueryList | null = null;
  const onRatioChange = () => {
    held = null;
    watchRatio();
    sync();
  };
  const watchRatio = () => {
    ratioQuery?.removeEventListener?.("change", onRatioChange);
    ratioQuery = win.matchMedia?.(`(resolution: ${win.devicePixelRatio || 1}dppx)`) ?? null;
    ratioQuery?.addEventListener?.("change", onRatioChange);
  };
  const sync = () => {
    const rect = overlay?.getTitlebarAreaRect?.();
    if (!rect || rect.x <= 0 || rect.width <= 0) return;
    if (Math.abs(rect.x + rect.width - win.innerWidth) > 1) return;
    const ratio = win.devicePixelRatio || 1;
    if (held && held.ratio === ratio && rect.x < held.x) return;
    held = { x: rect.x, ratio };
    const value = `${rect.x}px`;
    if (root.style.getPropertyValue(STEADY_TITLE_BAR_START_VAR) !== value) root.style.setProperty(STEADY_TITLE_BAR_START_VAR, value);
    root.dataset.titleBarSteady = "";
  };
  watchRatio();
  sync();
  overlay?.addEventListener?.("geometrychange", sync);
  return () => {
    overlay?.removeEventListener?.("geometrychange", sync);
    ratioQuery?.removeEventListener?.("change", onRatioChange);
    root.style.removeProperty(STEADY_TITLE_BAR_START_VAR);
    delete root.dataset.titleBarSteady;
  };
}
