import { getDesktopBridge } from "../../utils/desktopBridge";

/**
 * Bring the main window forward (the shell's object-window raise, through the
 * main window's bridge): for what an object window asks of the main one (a
 * link, a global shortcut). Resolves true once it has the focus.
 */
export function raiseMainWindow(): Promise<boolean> {
  return getDesktopBridge()?.objectWindows?.raise("main") ?? Promise.resolve(false);
}
