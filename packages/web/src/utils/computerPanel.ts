import { isHostShell } from "../embed";

/**
 * Where a computer opens (Raft DS › Navigation, "Opening an item"). From this
 * width it opens in the side panel beside the Computers card wall, as an
 * agent's or a person's profile does: `/computers?profile=computer:<id>`.
 * Otherwise it is a page of its own with Back: on a phone and in the host
 * app's WebView (which always shows the phone's Computers page):
 * `/computer/<id>`.
 */
export const COMPUTER_PANEL_QUERY = "(min-width: 768px)";

/** The `profile=` value of a computer's side panel. */
export function computerProfileParam(machineId: string): string {
  return `computer:${machineId}`;
}

/** Whether a computer opens in the side panel beside the card wall, at this window's width. */
export function opensComputerInPanel(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  if (isHostShell()) return false;
  return window.matchMedia(COMPUTER_PANEL_QUERY).matches;
}

/** The address that opens a computer: its panel beside the Computers page, or its own page. */
export function computerPath(base: string, machineId: string, inPanel: boolean): string {
  if (!inPanel) return `${base}/computer/${machineId}`;
  const params = new URLSearchParams({ profile: computerProfileParam(machineId) });
  return `${base}/computers?${params.toString()}`;
}

/** computerPath for this window, read when a link is followed (useAppNavigate). */
export function currentComputerPath(base: string, machineId: string): string {
  return computerPath(base, machineId, opensComputerInPanel());
}

/** A computer's sidebar row is selected while the computer is open: in the side panel, or as its own page. */
export function isComputerOpen(
  machineId: string,
  { pathname, pathBase, openComputerId }: { pathname: string; pathBase: string; openComputerId: string | null },
): boolean {
  return openComputerId === machineId
    || pathname === `${pathBase}/computer/${machineId}`
    || pathname === `${pathBase}/machine/${machineId}`;
}
