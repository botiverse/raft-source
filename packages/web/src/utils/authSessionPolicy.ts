import type { AuthRestoreState } from "./authRestoreMachine";
import { getAuthVerdict } from "./authVerdict";
import { authStatusBucket, emitAuthTrace, emitAuthTraceAndFlush } from "./webAuthTrace";

export function shouldRetryLoadUserAfterError(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

export function shouldKeepSessionAfterLoadUserFailure(status: number | undefined): boolean {
  return status !== 401 && status !== 403;
}

export function shouldLogoutAfterRefreshFailure(params: {
  status: number | undefined;
  hasRefreshToken: boolean;
  authRefreshAttemptId?: string;
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
