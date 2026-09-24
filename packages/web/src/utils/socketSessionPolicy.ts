import type { AuthRestoreState } from "./authRestoreMachine";
import { getAuthVerdict } from "./authVerdict";
import { authStatusBucket, emitAuthTrace, emitAuthTraceAndFlush } from "./webAuthTrace";

export function shouldAttemptSocketTokenRefresh(params: {
  message: string | undefined;
  refreshInFlight: boolean;
}): boolean {
  if (params.refreshInFlight) return false;

  const message = (params.message ?? "").toLowerCase();
  return (
    message.includes("expired")
    || message.includes("invalid")
    || message.includes("authentication")
  );
}

export type SocketAuthErrorRecoveryAction =
  | "ignore"
  | "retry-with-latest-token"
  | "refresh-token";

export function getSocketAuthErrorRecoveryAction(params: {
  message: string | undefined;
  refreshInFlight: boolean;
  socketAuthToken: string | null | undefined;
  latestAccessToken: string | null | undefined;
}): SocketAuthErrorRecoveryAction {
  if (!shouldAttemptSocketTokenRefresh({
    message: params.message,
    refreshInFlight: params.refreshInFlight,
  })) {
    return "ignore";
  }

  if (
    params.latestAccessToken
    && params.socketAuthToken
    && params.latestAccessToken !== params.socketAuthToken
  ) {
    return "retry-with-latest-token";
  }

  return "refresh-token";
}

export type SocketRefreshOutcome = "retry" | "keep-session" | "logout";

export function resolveSocketRefreshOutcome(params: {
  refreshSucceeded: boolean;
  hasRefreshToken: boolean;
  initialized: boolean;
  restoreState: AuthRestoreState;
}): SocketRefreshOutcome {
  const verdict = getAuthVerdict({
    signal: params.refreshSucceeded
      ? { type: "refresh_succeeded" }
      : {
          type: "refresh_failed",
          status: undefined,
          hasRefreshToken: params.hasRefreshToken,
        },
    initialized: params.initialized,
    restoreState: params.restoreState,
  });

  const traceAttrs = {
    signalType: params.refreshSucceeded ? "refresh_succeeded" : "refresh_failed",
    status: null,
    statusBucket: authStatusBucket(undefined),
    hasRefreshToken: params.hasRefreshToken,
    initialized: params.initialized,
    restoreState: params.restoreState,
    authVerdict: verdict,
    routeFamily: "socket_auth",
  } as const;
  if (verdict === "logout") {
    emitAuthTraceAndFlush("slock.auth.verdict", traceAttrs);
  } else {
    emitAuthTrace("slock.auth.verdict", traceAttrs);
  }

  if (verdict === "retry") return "retry";
  if (verdict === "keep-session" || verdict === "defer-to-auth-restore") {
    return "keep-session";
  }
  return "logout";
}
