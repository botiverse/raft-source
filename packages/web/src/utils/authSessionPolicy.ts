import type { AuthRestoreState } from "./authRestoreMachine";
import { getAuthVerdict } from "./authVerdict";
import { authStatusBucket, emitAuthTrace, emitAuthTraceAndFlush } from "./webAuthTrace";

export function shouldRetryLoadUserAfterError(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

export function shouldKeepSessionAfterLoadUserFailure(status: number | undefined): boolean {
  return status !== 401 && status !== 403;
}

/**
 * A failure with no answer from the server: the browser is offline, or the
 * request never came back (no response). A 401/403 or a 5xx is an answer.
 * Such a restore failure lets the app show the last session from the device
 * (store/offlineSession.ts).
 */
export function isUnreachableFailure(err: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const failure = err as { isAxiosError?: boolean; response?: unknown } | null | undefined;
  return failure?.isAxiosError === true && !failure.response;
}

// What asked for the refresh, so a failure's trace says where it came from
// (#triage:1683c617). Protected API requests trace their own failures with
// routeFamily "protected_request".
export type RefreshTrigger = "boot_expired" | "load_user" | "socket_connect_error" | "socket_reconnect";

export function shouldLogoutAfterRefreshFailure(params: {
  status: number | undefined;
  hasRefreshToken: boolean;
  authRefreshAttemptId?: string;
  trigger?: RefreshTrigger;
}): boolean {
  const verdict = getAuthVerdict({
    signal: {
      type: "refresh_failed",
      status: params.status,
      hasRefreshToken: params.hasRefreshToken,
    },
    initialized: true,
    restoreState: "authenticated",
  });
  const traceAttrs = {
    signalType: "refresh_failed",
    status: params.status ?? null,
    statusBucket: authStatusBucket(params.status),
    hasRefreshToken: params.hasRefreshToken,
    initialized: true,
    restoreState: "authenticated",
    authVerdict: verdict,
    routeFamily: "auth_refresh",
    authRefreshAttemptId: params.authRefreshAttemptId,
    refreshTrigger: params.trigger,
  } as const;
  if (verdict === "logout") {
    emitAuthTraceAndFlush("slock.auth.verdict", traceAttrs);
  } else {
    emitAuthTrace("slock.auth.verdict", traceAttrs);
  }
  return verdict === "logout";
}

export function shouldLogoutAfterPostRefreshLoadUserFailure(params: {
  status: number | undefined;
  initialized: boolean;
  restoreState: AuthRestoreState;
}): boolean {
  const verdict = getAuthVerdict({
    signal: { type: "post_refresh_me_failed", status: params.status },
    initialized: params.initialized,
    restoreState: params.restoreState,
  });
  const traceAttrs = {
    signalType: "post_refresh_me_failed",
    status: params.status ?? null,
    statusBucket: authStatusBucket(params.status),
    initialized: params.initialized,
    restoreState: params.restoreState,
    authVerdict: verdict,
    routeFamily: "auth_me",
  } as const;
  if (verdict === "logout") {
    emitAuthTraceAndFlush("slock.auth.verdict", traceAttrs);
  } else {
    emitAuthTrace("slock.auth.verdict", traceAttrs);
  }
  return verdict === "logout";
}
