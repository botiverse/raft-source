import { isAuthErrorStatus } from "./authErrors";
import type { AuthRestoreState } from "./authRestoreMachine";

export type AuthVerdictSignal =
  | { type: "refresh_succeeded" }
  | { type: "refresh_failed"; status: number | undefined; hasRefreshToken: boolean }
  | { type: "post_refresh_me_failed"; status: number | undefined };

export type AuthVerdict = "retry" | "keep-session" | "defer-to-auth-restore" | "logout";

export function getAuthVerdict(params: {
  signal: AuthVerdictSignal;
  initialized: boolean;
  restoreState: AuthRestoreState;
}): AuthVerdict {
  if (params.signal.type === "refresh_succeeded") return "retry";

  if (params.signal.type === "refresh_failed") {
    const hardFailure = !params.signal.hasRefreshToken || isAuthErrorStatus(params.signal.status);
    if (!hardFailure) return "keep-session";
    return "logout";
  }

  if (params.signal.type === "post_refresh_me_failed") {
    if (!isAuthErrorStatus(params.signal.status)) return "keep-session";
  }

  if (!params.initialized || params.restoreState === "restoring_auth") {
    return "defer-to-auth-restore";
  }

  return "logout";
}
