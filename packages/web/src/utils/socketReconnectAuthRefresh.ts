/**
 * Plan whether to update socket auth in-place or trigger a token refresh
 * before the next socket.io reconnect attempt.
 *
 * Why this exists
 * ---------------
 * socket.io-client's built-in reconnect (the engine.io retry loop) does not
 * pass through our explicit `connectSocket()` / `ensureSocketConnected()`
 * entry points — it just calls into the existing `Socket.auth` reference.
 * If the access token in localStorage rotated (axios interceptor refreshed
 * after a 401 on a REST call) but the socket was offline at that moment,
 * the in-flight `Socket.auth` object still holds the stale token. Engine
 * retries with the stale token; the server's WS handshake middleware
 * rejects with `Invalid or expired token`; the client surfaces it as a
 * generic "timeout" / "WebSocket is closed before connection established"
 * (the auth error gets squashed by the CF/transport layer for upgrade
 * failures). The handler in `socket.ts` only triggers explicit refresh on
 * messages containing "expired"/"invalid"/"authentication", so the wedge
 * is permanent until the user reloads the page.
 *
 * Fix: attach a listener on `socket.io.on("reconnect_attempt", ...)` that
 * consults this planner and either re-reads localStorage (auth rotated
 * via axios interceptor) or proactively triggers a refresh (token expired
 * or about to expire). The planner is a pure function so it can be tested
 * deterministically without mocking socket.io / the auth store.
 */

export type ReconnectAuthRefreshAction =
  | { type: "update-auth-only"; auth: Record<string, unknown> }
  | { type: "trigger-refresh-and-update"; reason: "expired" | "near-expiry" | "no-exp-claim" }
  | { type: "skip"; reason: "no-token" };

export interface PlanReconnectAuthRefreshParams {
  /** Latest access token currently in localStorage. */
  latestAccessToken: string | null;
  /**
   * Auth object built fresh from the current store state. Used as the
   * payload for `update-auth-only` so the caller can directly assign it
   * to `socket.auth`.
   */
  freshAuth: Record<string, unknown>;
  /**
   * Returns the JWT `exp` claim in milliseconds since epoch, or null if
   * the token can't be parsed. Injected so tests can avoid real JWTs.
   */
  parseTokenExp: (token: string) => number | null;
  /** Current wall-clock time (ms since epoch). Injected for testability. */
  now: number;
  /**
   * If the token has fewer than this many ms until its `exp`, refresh
   * proactively rather than risk handshaking with a token that expires
   * mid-session. Default: 60 seconds.
   */
  refreshSoonThresholdMs?: number;
}

const DEFAULT_REFRESH_SOON_THRESHOLD_MS = 60_000;

export function planReconnectAuthRefresh(
  params: PlanReconnectAuthRefreshParams,
): ReconnectAuthRefreshAction {
  const threshold = params.refreshSoonThresholdMs ?? DEFAULT_REFRESH_SOON_THRESHOLD_MS;

  if (!params.latestAccessToken) {
    return { type: "skip", reason: "no-token" };
  }

  const exp = params.parseTokenExp(params.latestAccessToken);

  if (exp === null) {
    // Can't read exp claim — be conservative and refresh. Keeps the socket
    // from getting wedged on a malformed token left in localStorage.
    return { type: "trigger-refresh-and-update", reason: "no-exp-claim" };
  }

  const msUntilExpiry = exp - params.now;

  if (msUntilExpiry <= 0) {
    return { type: "trigger-refresh-and-update", reason: "expired" };
  }

  if (msUntilExpiry < threshold) {
    return { type: "trigger-refresh-and-update", reason: "near-expiry" };
  }

  return { type: "update-auth-only", auth: params.freshAuth };
}

/**
 * Decode a JWT's `exp` claim into ms since epoch. Returns null if the
 * token is malformed, the payload isn't valid JSON, or `exp` is missing.
 *
 * Browser-side only (uses `atob`). Does NOT verify the signature — we
 * trust the token was issued by our own server and we're only reading
 * the expiry to decide whether to refresh.
 */
export function parseAccessTokenExp(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    // `atob` is available in browsers and in Node ≥16 (where the unit
    // tests run). We don't need a Buffer fallback.
    const payloadJson = globalThis.atob(padded);
    const payload: unknown = JSON.parse(payloadJson);
    if (typeof payload !== "object" || payload === null) return null;
    const exp = (payload as { exp?: unknown }).exp;
    if (typeof exp !== "number") return null;
    return exp * 1000;
  } catch {
    return null;
  }
}
