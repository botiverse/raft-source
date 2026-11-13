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
