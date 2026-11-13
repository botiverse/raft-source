import axios from "axios";
import {
  AUTH_REFRESH_REQUEST_TIMEOUT_MS,
  AUTH_REFRESH_ROTATED_TOKEN_WAIT_MS,
} from "@botiverse/raft-shared";
import {
  isAuthErrorStatus,
  MissingRefreshTokenError,
  setAuthRefreshAttemptIdOnError,
} from "./authErrors";
import { authTokenSync } from "./authTokenSync";
import { clientRequestHeaders } from "./clientPlatformHint";
import {
  authStatusBucket,
  emitAuthTrace,
  emitAuthTraceAndFlush,
  startWebSpan,
} from "./webAuthTrace";
import type {
  TokenObservation,
  WaitElapsedBucket,
  WebSpanHandle,
} from "./webAuthTrace";
import { RUNTIME_API_BASE } from "../runtimeEndpoints";

const API_BASE = RUNTIME_API_BASE;
const REFRESH_RETRY_DELAYS_MS = [250, 750];
// Allows a small chain of tabs to recover from single-use refresh-token
// rotation races without turning real revocation into an endless retry loop.
const ROTATED_REFRESH_TOKEN_RETRY_LIMIT = 3;
const DEFAULT_ROTATED_TOKEN_WAIT_MS = AUTH_REFRESH_ROTATED_TOKEN_WAIT_MS;
const DEFAULT_ROTATED_TOKEN_POLL_MS = 100;
const REFRESH_LOCK_NAME = "slock-auth-refresh";

export type RefreshTokens = {
  accessToken: string;
  refreshToken: string;
};

export type AuthRefreshAttemptContext = {
  authRefreshAttemptId?: string;
  // Sent only together with an attempt id: the server then keeps a durable
  // receipt for the rotation, so a reply lost to a sleeping or offline client
  // can be replayed later with the same old token and attempt id (#10977).
  authRefreshInstallationId?: string;
};

type RotatedTokenObservation = RefreshTokens | string | null;
type RefreshLock = <T>(callback: () => Promise<T>) => Promise<T>;
type BrowserLockManager = {
  request<T>(
    name: string,
    callback: () => T | Promise<T>,
  ): Promise<T>;
};

function tokenObservationKind(tokens: RotatedTokenObservation): TokenObservation {
  if (!tokens) return "none";
  return typeof tokens === "string" ? "refresh_only" : "token_pair";
}

function waitElapsedBucket(elapsedMs: number): WaitElapsedBucket {
  if (elapsedMs < 100) return "<100ms";
  if (elapsedMs < 1000) return "100-999ms";
  if (elapsedMs < 3000) return "1-3s";
  if (elapsedMs < 10_000) return "3-10s";
  return ">=10s";
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function defaultAuthRefreshAttemptId(): string {
  return `arf_${randomHex(8)}`;
}

export function createRefreshCoordinator(params: {
  readAccessToken?: () => string | null;
  readRefreshToken: () => string | null;
  writeTokens: (tokens: RefreshTokens) => void;
  requestRefresh: (refreshToken: string, context: AuthRefreshAttemptContext) => Promise<RefreshTokens>;
  onTokensRefreshed?: (tokens: RefreshTokens) => void;
  subscribeToTokenUpdates?: (listener: (tokens: RefreshTokens) => void) => () => void;
  waitForRotatedToken?: (currentToken: string, timeoutMs: number) => Promise<string | null>;
  waitForRotatedTokens?: (currentToken: string, timeoutMs: number) => Promise<RefreshTokens | null>;
  requestRefreshLock?: RefreshLock;
  rotatedTokenWaitMs?: number;
  rotatedTokenPollMs?: number;
  createAuthRefreshAttemptId?: () => string;
  // The attempt id for one refresh token, kept across failed tries and page
  // loads, so every replay of that token is the same attempt to the server.
  // Without it, ids are still shared by the tries of one refresh.
  attemptIdForRefreshToken?: (refreshToken: string, create: () => string) => string;
  readInstallationId?: () => string | undefined;
}) {
  let refreshPromise: Promise<RefreshTokens> | null = null;

  async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const rotatedTokenWaitMs = params.rotatedTokenWaitMs ?? DEFAULT_ROTATED_TOKEN_WAIT_MS;
  const rotatedTokenPollMs = params.rotatedTokenPollMs ?? DEFAULT_ROTATED_TOKEN_POLL_MS;
  const requestRefreshLock = params.requestRefreshLock ?? ((callback) => callback());
  const createAuthRefreshAttemptId = params.createAuthRefreshAttemptId ?? defaultAuthRefreshAttemptId;

  // Correlation must not turn a recoverable refresh into a logout: a broken
  // Web Crypto or storage just means no attempt id (and so no receipt).
  function attemptIdFor(refreshToken: string): string | undefined {
    try {
      return params.attemptIdForRefreshToken
        ? params.attemptIdForRefreshToken(refreshToken, createAuthRefreshAttemptId)
        : createAuthRefreshAttemptId();
    } catch {
      return undefined;
    }
  }

  function installationIdFor(authRefreshAttemptId: string | undefined): string | undefined {
    if (!authRefreshAttemptId) return undefined;
    try {
      return params.readInstallationId?.();
    } catch {
      return undefined;
    }
  }

  function emitCrossTabSync(
    phase: "adopt_pair" | "adopt_refresh_token" | "wait_start" | "wait_observed" | "wait_timeout",
    attrs: {
      status?: number;
      tokenObservation?: TokenObservation;
      waitElapsedBucket?: WaitElapsedBucket;
      authRefreshAttemptId?: string;
      rotatedTokenRetries?: 0 | 1 | 2 | 3;
      rotatedTokenWaitMs?: number;
      retryIndex?: 0 | 1 | 2 | 3;
    } = {},
    urgent = false,
    waitSpan: WebSpanHandle | null = null,
  ): void {
    // The wait phases are attached to the running cross_tab_wait span.
    const spanContext = waitSpan ? { traceId: waitSpan.traceId, spanId: waitSpan.spanId } : {};
    const payload = {
      routeFamily: "auth_refresh",
      crossTabSyncPhase: phase,
      status: attrs.status ?? null,
      statusBucket: authStatusBucket(attrs.status),
      tokenObservation: attrs.tokenObservation,
      waitElapsedBucket: attrs.waitElapsedBucket,
      authRefreshAttemptId: attrs.authRefreshAttemptId,
      rotatedTokenRetries: attrs.rotatedTokenRetries,
      rotatedTokenWaitMs: attrs.rotatedTokenWaitMs,
      retryIndex: attrs.retryIndex,
    } as const;
    if (urgent) {
      emitAuthTraceAndFlush("slock.auth.cross_tab_sync", payload, spanContext);
    } else {
      emitAuthTrace("slock.auth.cross_tab_sync", payload, spanContext);
    }
  }

  function readRotatedRefreshToken(currentToken: string): string | null {
    const refreshToken = params.readRefreshToken();
    return refreshToken && refreshToken !== currentToken ? refreshToken : null;
  }

  function readRotatedTokens(currentToken: string): RefreshTokens | null {
    const accessToken = params.readAccessToken?.();
    const refreshToken = readRotatedRefreshToken(currentToken);
    return accessToken && refreshToken
      ? { accessToken, refreshToken }
      : null;
  }

  // Wait (bounded) for another tab's single-use rotation to land in the shared
  // store after our refresh token was rejected. Cross-tab token notifications
  // wake immediately when available; polling and the timeout remain as a
  // compatibility/backstop path. A null return falls through to the existing
  // throw, so genuine revocation still surfaces.
  async function defaultWaitForRotatedTokenObservation(
    currentToken: string,
    timeoutMs: number,
    retryIndex: 0 | 1 | 2 | 3,
    authRefreshAttemptId: string | undefined,
  ): Promise<RotatedTokenObservation> {
    const startedAt = Date.now();
    const waitSpan = startWebSpan("slock.auth.cross_tab_wait");
    emitCrossTabSync("wait_start", {
      authRefreshAttemptId,
      tokenObservation: "none",
      rotatedTokenWaitMs: timeoutMs,
      retryIndex,
    }, false, waitSpan);
    return new Promise((resolve) => {
      let completed = false;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | undefined;

      const readObservation = (): RotatedTokenObservation =>
        readRotatedTokens(currentToken) ?? readRotatedRefreshToken(currentToken);

      const finish = (tokens: RotatedTokenObservation, reason: "observed" | "timeout") => {
        if (completed) return;
        completed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        unsubscribe?.();
        const observation = tokenObservationKind(tokens);
        const timedOut = reason === "timeout" && !tokens;
        const elapsedBucket = waitElapsedBucket(Date.now() - startedAt);
        emitCrossTabSync(
          timedOut ? "wait_timeout" : "wait_observed",
          {
            status: timedOut ? 401 : undefined,
            authRefreshAttemptId,
            tokenObservation: observation,
            waitElapsedBucket: elapsedBucket,
            rotatedTokenWaitMs: timeoutMs,
            retryIndex,
          },
          timedOut,
          waitSpan,
        );
        waitSpan.end(timedOut ? "error" : "ok", {
          routeFamily: "auth_refresh",
          tokenObservation: observation,
          waitElapsedBucket: elapsedBucket,
          rotatedTokenWaitMs: timeoutMs,
          retryIndex,
        });
        resolve(tokens);
      };

      unsubscribe = params.subscribeToTokenUpdates?.((tokens) => {
        if (tokens.refreshToken && tokens.refreshToken !== currentToken) {
          finish(tokens, "observed");
          return;
        }
        const latest = readObservation();
        if (latest) finish(latest, "observed");
      });

      const poll = () => {
        const latest = readObservation();
        if (latest) finish(latest, "observed");
      };

      poll();
      if (!completed) {
        pollTimer = setInterval(poll, rotatedTokenPollMs);
        timeoutTimer = setTimeout(() => finish(readObservation(), "timeout"), timeoutMs);
      }
    });
  }

  async function waitForRotatedTokenObservation(
    currentToken: string,
    timeoutMs: number,
    retryIndex: 0 | 1 | 2 | 3,
    authRefreshAttemptId: string | undefined,
  ): Promise<RotatedTokenObservation> {
    if (params.waitForRotatedTokens) {
      const tokens = await params.waitForRotatedTokens(currentToken, timeoutMs);
      if (tokens) return tokens;
    }
    if (params.waitForRotatedToken) {
      const refreshToken = await params.waitForRotatedToken(currentToken, timeoutMs);
      return refreshToken && refreshToken !== currentToken
        ? readRotatedTokens(currentToken) ?? refreshToken
        : null;
    }
    return defaultWaitForRotatedTokenObservation(currentToken, timeoutMs, retryIndex, authRefreshAttemptId);
  }

  async function runRefresh(): Promise<RefreshTokens> {
    let refreshToken = params.readRefreshToken();
    if (!refreshToken) throw new MissingRefreshTokenError();
    let rotatedTokenRetries = 0;

    while (true) {
      // One attempt id per refresh token, shared by every try of it: a retry
      // after a lost reply is then a replay of the same attempt, which the
      // server answers from its receipt instead of a 401.
      const authRefreshAttemptId = attemptIdFor(refreshToken);
      const authRefreshInstallationId = installationIdFor(authRefreshAttemptId);
      for (let attempt = 0; attempt <= REFRESH_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          const tokens = await params.requestRefresh(refreshToken, {
            authRefreshAttemptId,
            ...(authRefreshInstallationId ? { authRefreshInstallationId } : {}),
          });
          // A session stored while this refresh was out (a sign-in completing
          // on a login callback page, or another tab) wins: never write the
          // older session back over it (#proj-workspace:f07141a9, Tenny).
          const superseded = readRotatedTokens(refreshToken);
          if (superseded) return superseded;
          params.writeTokens(tokens);
          params.onTokensRefreshed?.(tokens);
          return tokens;
        } catch (error: any) {
          const status = error?.response?.status as number | undefined;
          if (isAuthErrorStatus(status)) {
            const latestRefreshToken = params.readRefreshToken();
            const latestTokens = readRotatedTokens(refreshToken);
            if (latestTokens) {
              emitCrossTabSync("adopt_pair", {
                status,
                authRefreshAttemptId,
                tokenObservation: "token_pair",
                rotatedTokenRetries: rotatedTokenRetries as 0 | 1 | 2 | 3,
              });
              return latestTokens;
            }

            if (
              latestRefreshToken
              && latestRefreshToken !== refreshToken
              && rotatedTokenRetries < ROTATED_REFRESH_TOKEN_RETRY_LIMIT
            ) {
              emitCrossTabSync("adopt_refresh_token", {
                status,
                authRefreshAttemptId,
                tokenObservation: "refresh_only",
                rotatedTokenRetries: rotatedTokenRetries as 0 | 1 | 2 | 3,
              });
              refreshToken = latestRefreshToken;
              rotatedTokenRetries += 1;
              break;
            }

            if (
              latestRefreshToken === refreshToken
              && rotatedTokenRetries < ROTATED_REFRESH_TOKEN_RETRY_LIMIT
            ) {
              const retryIndex = rotatedTokenRetries as 0 | 1 | 2 | 3;
              const rotatedObservation = await waitForRotatedTokenObservation(
                refreshToken,
                rotatedTokenWaitMs,
                retryIndex,
                authRefreshAttemptId,
              );
              if (rotatedObservation) {
                if (typeof rotatedObservation !== "string") {
                  return rotatedObservation;
                }
                refreshToken = rotatedObservation;
                rotatedTokenRetries += 1;
                break;
              }
            }

            if (authRefreshAttemptId) {
              setAuthRefreshAttemptIdOnError(error, authRefreshAttemptId);
            }
            throw error;
          }

          // Retries intentionally reuse the same refresh token. This relies on
          // the server only revoking the old token after a successful rotation.
          if (attempt < REFRESH_RETRY_DELAYS_MS.length) {
            await sleep(REFRESH_RETRY_DELAYS_MS[attempt]);
            // A session stored meanwhile (another tab, a sign-in) wins over
            // resending the old token.
            const stored = readRotatedTokens(refreshToken);
            if (stored) return stored;
            continue;
          }

          throw error;
        }
      }
    }
  }

  async function runRefreshWithLock(): Promise<RefreshTokens> {
    const observedRefreshToken = params.readRefreshToken();
    if (!observedRefreshToken) throw new MissingRefreshTokenError();
    return requestRefreshLock(async () => {
      const latestTokens = readRotatedTokens(observedRefreshToken);
      if (latestTokens) {
        emitCrossTabSync("adopt_pair", {
          tokenObservation: "token_pair",
          rotatedTokenRetries: 0,
        });
        return latestTokens;
      }
      const latestRefreshToken = params.readRefreshToken();
      if (latestRefreshToken && latestRefreshToken !== observedRefreshToken) {
        emitCrossTabSync("adopt_refresh_token", {
          tokenObservation: "refresh_only",
          rotatedTokenRetries: 0,
        });
      }
      return runRefresh();
    });
  }

  return {
    async refresh(): Promise<RefreshTokens> {
      if (!refreshPromise) {
        refreshPromise = runRefreshWithLock().finally(() => {
          refreshPromise = null;
        });
      }
      return refreshPromise;
    },
  };
}

function getBrowserLockManager(): BrowserLockManager | null {
  const navigatorLike = globalThis.navigator as (Navigator & { locks?: BrowserLockManager }) | undefined;
  return navigatorLike?.locks ?? null;
}

function requestBrowserRefreshLock<T>(callback: () => Promise<T>): Promise<T> {
  const locks = getBrowserLockManager();
  if (!locks) return callback();
  return locks.request(REFRESH_LOCK_NAME, callback);
}

// This browser profile / desktop install, for the server's durable rotation
// receipts (the same contract the mobile app uses). Not a secret: alone it
// replays nothing, the old refresh token is still required.
const INSTALLATION_ID_KEY = "slock_auth_installation_id";
// The attempt id of the stored refresh token, kept so a refresh that failed
// while the device slept is replayed later as the same attempt. Keyed by a
// fingerprint of the token, so a new session never reuses an old attempt.
const REFRESH_ATTEMPT_KEY = "slock_auth_refresh_attempt";
const INSTALLATION_ID_PATTERN = /^ari_[0-9a-f]{32}$/;
const ATTEMPT_ID_PATTERN = /^arf_[0-9a-f]{16}$/;

// FNV-1a, 64-bit. Only tells this token's slot from another's; a collision
// would merely reuse an attempt id, which the server checks with the token.
function refreshTokenFingerprint(refreshToken: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < refreshToken.length; i += 1) {
    hash ^= BigInt(refreshToken.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function readBrowserInstallationId(): string | undefined {
  const stored = localStorage.getItem(INSTALLATION_ID_KEY);
  if (stored && INSTALLATION_ID_PATTERN.test(stored)) return stored;
  const created = `ari_${randomHex(16)}`;
  localStorage.setItem(INSTALLATION_ID_KEY, created);
  return created;
}

function browserAttemptIdForRefreshToken(refreshToken: string, create: () => string): string {
  const fingerprint = refreshTokenFingerprint(refreshToken);
  try {
    const stored = JSON.parse(localStorage.getItem(REFRESH_ATTEMPT_KEY) ?? "null") as
      { fingerprint?: unknown; attemptId?: unknown } | null;
    if (
      stored?.fingerprint === fingerprint
      && typeof stored.attemptId === "string"
      && ATTEMPT_ID_PATTERN.test(stored.attemptId)
    ) {
      return stored.attemptId;
    }
  } catch {
    // Unreadable slot: start a new attempt below.
  }
  const attemptId = create();
  localStorage.setItem(REFRESH_ATTEMPT_KEY, JSON.stringify({ fingerprint, attemptId }));
  return attemptId;
}

const browserRefreshCoordinator = createRefreshCoordinator({
  readAccessToken: () => localStorage.getItem("slock_access_token"),
  readRefreshToken: () => localStorage.getItem("slock_refresh_token"),
  writeTokens: (tokens) => {
    localStorage.setItem("slock_access_token", tokens.accessToken);
    localStorage.setItem("slock_refresh_token", tokens.refreshToken);
  },
  onTokensRefreshed: (tokens) => {
    authTokenSync.publish(tokens);
  },
  subscribeToTokenUpdates: (listener) => authTokenSync.subscribe(listener),
  requestRefreshLock: requestBrowserRefreshLock,
  attemptIdForRefreshToken: browserAttemptIdForRefreshToken,
  readInstallationId: readBrowserInstallationId,
  requestRefresh: async (refreshToken, context) => {
    const { data } = await axios.post(`${API_BASE}/auth/refresh`, { refreshToken }, {
      timeout: AUTH_REFRESH_REQUEST_TIMEOUT_MS,
      headers: {
        ...clientRequestHeaders(),
        ...(context.authRefreshAttemptId ? { "X-Slock-Auth-Refresh-Attempt-Id": context.authRefreshAttemptId } : {}),
        // The server rejects an installation id without an attempt id (400).
        ...(context.authRefreshAttemptId && context.authRefreshInstallationId
          ? { "X-Slock-Auth-Installation-Id": context.authRefreshInstallationId }
          : {}),
      },
    });
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    };
  },
});

export function refreshTokensWithDedupe(): Promise<RefreshTokens> {
  return browserRefreshCoordinator.refresh();
}
