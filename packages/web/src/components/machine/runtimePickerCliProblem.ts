import type { RuntimeAuthStatus } from "@botiverse/raft-shared";

/**
 * What the picker says about the runtime's CLI itself: missing or too old
 * (the Computer card's `unavailable`), or nothing. `unsupported_installation`
 * (an install OAR can't sign in from here) still runs agents, so it is not
 * warned about under the picker.
 */
export function runtimePickerCliProblem(status: RuntimeAuthStatus | null): "not_installed" | "version_unsupported" | null {
  if (status?.kind !== "unavailable" || status.reason === "unsupported_installation") return null;
  return status.reason;
}
