/**
 * Whether the app shell mounts the top bar.
 *
 * On its own the web shows it at desktop width only, and never inside the
 * host-shell embed, which draws its own chrome. A shell that hands its chrome to the bar through `TopBarHostContext`
 * gets it at any width: the row is then the window's title bar and its drag
 * region, which must not disappear when the window is narrow. Unless the shell
 * asks for desktop width only (`hostDesktopWidthOnly`, the installed web app,
 * whose window can be narrower than the desktop layout): below it the phone
 * layout takes over and the shell's own strip is the title bar.
 *
 * Raft Design System: the bar is part of the frame, with the rail under it.
 */
export function shouldShowTopBar(input: {
  hosted: boolean;
  /** The host shows the bar at desktop width only (TopBarHost.desktopWidthOnly). */
  hostDesktopWidthOnly?: boolean;
  desktopWidth: boolean;
  hostShell: boolean;
}): boolean {
  if (input.hosted) return input.desktopWidth || input.hostDesktopWidthOnly !== true;
  return input.desktopWidth && !input.hostShell;
}
