import { createHash, createHmac } from "node:crypto";
import { classifyRequesterUserAgent } from "../middleware/publicRequester";
import { raftVersionFromUserAgent } from "../services/productEventContext";
import { addTraceEvent } from "../tracing/semanticTrace";
import type { AuthRefreshReplayTrace } from "../services/sessionService";

export type AuthRefreshOutcome = { userId: string; sessionId: string; replayedRotation: boolean } | null;
export type AuthSessionIssuedFlow =
  | "email_register"
  | "email_login"
  | "passkey_login"
  | "device_auth"
  | "app_login"
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
 * Counts retries of one rejected refresh token without recording it (#triage:#241).
 * Keyed for this use only, so it can't be matched to `token_hash` in the database.
 * Long enough to count repeats, too short to stand in for the token.
 */
export function rejectedRefreshFingerprint(refreshToken: unknown): string | undefined {
  const secret = process.env.JWT_SECRET;
  if (!secret || typeof refreshToken !== "string") return undefined;
  const key = createHash("sha256").update(`raft:auth-refresh-rejected-fingerprint:v1:${secret}`).digest();
  return createHmac("sha256", key).update(refreshToken, "utf8").digest("hex").slice(0, 16);
}

/** Who sent a rejected refresh, as a fixed class. The raw User-Agent is never recorded. */
export function refreshRequesterClass(userAgent: string | undefined): string {
  return classifyRequesterUserAgent(userAgent);
}

/**
 * `count(replayed_rotation=true)` over this event is the direct positive health
 * metric for #3349.
 */
export function recordAuthRefreshTrace(
  refreshed: AuthRefreshOutcome,
  replayTrace?: AuthRefreshReplayTrace,
  opts: {
    authRefreshAttemptId?: string;
    authRefreshInstallationId?: string;
    refreshToken?: unknown;
    userAgent?: string;
  } = {},
): void {
  const superseded = replayTrace?.superseded;
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
    } : {
      rejected_refresh_fp: rejectedRefreshFingerprint(opts.refreshToken),
      requester_class: refreshRequesterClass(opts.userAgent),
    }),
    // A lost rotation (task #72): who, from which installation, how late.
    ...(superseded ? {
      user_id: superseded.userId,
      session_family_id: superseded.familyId,
      auth_refresh_installation_id: opts.authRefreshInstallationId,
    } : {}),
  });
}
