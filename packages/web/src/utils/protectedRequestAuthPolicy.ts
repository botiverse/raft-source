import { getAuthVerdict } from "./authVerdict";
import type { AuthRestoreState } from "./authRestoreMachine";
import { authStatusBucket, emitAuthTrace, emitAuthTraceAndFlush } from "./webAuthTrace";

export type ProtectedRequestAuthFailureAction =
  | "keep-session"
  | "defer-to-auth-restore"
  | "logout";

export function getProtectedRequestAuthFailureAction(params: {
  status: number | undefined;
  hasRefreshToken: boolean;
  initialized: boolean;
  restoreState: AuthRestoreState;
  authRefreshAttemptId?: string;
}): ProtectedRequestAuthFailureAction {
  const verdict = getAuthVerdict({
    signal: {
      type: "refresh_failed",
      status: params.status,
      hasRefreshToken: params.hasRefreshToken,
    },
    initialized: params.initialized,
    restoreState: params.restoreState,
  });

  const traceAttrs = {
    signalType: "refresh_failed",
    status: params.status ?? null,
    statusBucket: authStatusBucket(params.status),
    hasRefreshToken: params.hasRefreshToken,
    initialized: params.initialized,
    restoreState: params.restoreState,
    authVerdict: verdict,
    routeFamily: "protected_request",
    authRefreshAttemptId: params.authRefreshAttemptId,
  } as const;
  if (verdict === "logout") {
    emitAuthTraceAndFlush("slock.auth.verdict", traceAttrs);
  } else {
    emitAuthTrace("slock.auth.verdict", traceAttrs);
  }

  if (verdict === "keep-session") {
    return "keep-session";
  }
  if (verdict === "defer-to-auth-restore") {
    return "defer-to-auth-restore";
  }
  return "logout";
}
