import { getDesktopBridge } from "../../utils/desktopBridge";

/**
 * Open an http(s) address in the system browser, never in the app (Raft Desktop's bridge openInSystemBrowser): an
 * object's "Open in system browser" in its window's ⋯ (#337 PR3; an own-app address through window.open would open
 * in the app). False where the shell has no such call (a browser, an older shell): the caller does what it did before.
 */
export function openInSystemBrowser(url: string): boolean {
  const bridge = getDesktopBridge();
  if (!bridge?.openInSystemBrowser) return false;
  bridge.openInSystemBrowser(url);
  return true;
}
