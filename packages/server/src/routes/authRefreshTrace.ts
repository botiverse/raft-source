import { addTraceEvent } from "../tracing/semanticTrace.js";
import type { AuthRefreshReplayTrace } from "../services/sessionService.js";

export type AuthRefreshOutcome = { userId: string; sessionId: string; replayedRotation: boolean } | null;
export type AuthSessionIssuedFlow =
  | "email_register"
  | "email_login"
  | "device_auth"
  | "mobile_oauth"
  | "social_oauth";

export function recordAuthSessionIssuedTrace(input: {
  flow: AuthSessionIssuedFlow;
  userId: string;
  sessionId: string;
}): void {
  addTraceEvent("auth.session.issued", {
    flow: input.flow,
    user_id: input.userId,
    session_id: input.sessionId,
  });
}

/**
 * Emit the POST /auth/refresh outcome as a trace event so prod can DIRECTLY
 * count grace replays (`replayed_rotation=true`) — i.e. the #3349 server-side
 * replay-grace actually firing — instead of inferring it from the absence of
 * the client's rare `cross_tab_sync` wait_timeout signature.
 *
 *   replayed: a consumed-but-recently-rotated refresh token was replayed within
 *             the grace window (`ROTATED_REFRESH_REPLAY_GRACE_MS`) — the #3349 save
 *             that keeps a frozen-winner's loser tab from logging out.
 *   rotated:  a normal single-use rotation.
 *   rejected: invalid/expired refresh token (grace expired or genuine revocation) -> 401.
 *
 */
export function authRefreshAttemptIdFromHeader(headerValue: unknown): string | undefined {
  if (typeof headerValue !== "string") return undefined;
  const trimmed = headerValue.trim();
  if (/^arf_[0-9a-f]{16}$/.test(trimmed)) return trimmed;
  return undefined;
}

export function authRefreshInstallationIdFromHeader(headerValue: unknown): string | undefined {
  if (typeof headerValue !== "string") return undefined;
  const trimmed = headerValue.trim();
  if (/^ari_[0-9a-f]{32}$/.test(trimmed)) return trimmed;
  return undefined;
}

/**
 * `count(replayed_rotation=true)` over this event is the direct positive health
 * metric for #3349.
 */
export function recordAuthRefreshTrace(
  refreshed: AuthRefreshOutcome,
  replayTrace?: AuthRefreshReplayTrace,
  opts: { authRefreshAttemptId?: string } = {},
): void {
  addTraceEvent("auth.refresh.completed", {
    outcome: refreshed ? (refreshed.replayedRotation ? "replayed" : "rotated") : "rejected",
    replayed_rotation: refreshed?.replayedRotation === true,
    auth_refresh_attempt_id: opts.authRefreshAttemptId,
    replay_lookup_result: replayTrace?.replayLookupResult,
    redis_available: replayTrace?.redisAvailable,
    grace_age_bucket: replayTrace?.graceAgeBucket ?? undefined,
    ...(refreshed ? {
      user_id: refreshed.userId,
      session_id: refreshed.sessionId,
    } : {}),
  });
}
