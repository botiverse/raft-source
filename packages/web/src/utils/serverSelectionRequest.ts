export const SERVER_SELECTION_REQUESTED_KEY = "slock_server_selection_requested";

/** Ask the root route to render the server picker instead of restoring a server. */
export function requestServerSelection(): void {
  try {
    sessionStorage.setItem(SERVER_SELECTION_REQUESTED_KEY, "1");
  } catch {
    // Ignore storage failures; navigation still falls back safely.
  }
}

/** Check whether the current page load was explicitly sent to the picker. */
export function isServerSelectionRequested(): boolean {
  try {
    return sessionStorage.getItem(SERVER_SELECTION_REQUESTED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Consume the one-shot picker request from the mounted route resolver. */
export function consumeServerSelectionRequest(): boolean {
  const requested = isServerSelectionRequested();
  if (!requested) return false;
  try {
    sessionStorage.removeItem(SERVER_SELECTION_REQUESTED_KEY);
  } catch {
    // Ignore storage failures; the request has already been observed.
  }
  return true;
}
