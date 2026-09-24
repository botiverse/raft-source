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
import {
  authStatusBucket,
  emitAuthTrace,
  emitAuthTraceAndFlush,
} from "./webAuthTrace";
import type {
  TokenObservation,
  WaitElapsedBucket,
} from "./webAuthTrace";
import { assertValidDesktopRuntimeEnvironment, RUNTIME_API_BASE } from "../desktopRuntimeEnvironment";

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
}) {
  let refreshPromise: Promise<RefreshTokens> | null = null;

  async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const rotatedTokenWaitMs = params.rotatedTokenWaitMs ?? DEFAULT_ROTATED_TOKEN_WAIT_MS;
  const rotatedTokenPollMs = params.rotatedTokenPollMs ?? DEFAULT_ROTATED_TOKEN_POLL_MS;
  const requestRefreshLock = params.requestRefreshLock ?? ((callback) => callback());
  const createAuthRefreshAttemptId = params.createAuthRefreshAttemptId ?? defaultAuthRefreshAttemptId;

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
  ): void {
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
      emitAuthTraceAndFlush("slock.auth.cross_tab_sync", payload);
    } else {
      emitAuthTrace("slock.auth.cross_tab_sync", payload);
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
    emitCrossTabSync("wait_start", {
      authRefreshAttemptId,
      tokenObservation: "none",
      rotatedTokenWaitMs: timeoutMs,
      retryIndex,
    });
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
        emitCrossTabSync(
          reason === "timeout" && !tokens ? "wait_timeout" : "wait_observed",
          {
            status: reason === "timeout" && !tokens ? 401 : undefined,
            authRefreshAttemptId,
            tokenObservation: observation,
            waitElapsedBucket: waitElapsedBucket(Date.now() - startedAt),
            rotatedTokenWaitMs: timeoutMs,
            retryIndex,
          },
          reason === "timeout" && !tokens,
        );
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
      for (let attempt = 0; attempt <= REFRESH_RETRY_DELAYS_MS.length; attempt += 1) {
        // Correlation is observability-only. Browser entropy can fail because
        // of a broken/blocked Web Crypto implementation; that must not turn a
        // recoverable auth refresh into a logout. In that case, continue the
        // real refresh without the optional attempt id/header.
        let authRefreshAttemptId: string | undefined;
        try {
          authRefreshAttemptId = createAuthRefreshAttemptId();
        } catch {
          authRefreshAttemptId = undefined;
        }
        try {
          const tokens = await params.requestRefresh(refreshToken, { authRefreshAttemptId });
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
  requestRefresh: async (refreshToken, context) => {
    assertValidDesktopRuntimeEnvironment();

    const { data } = await axios.post(`${API_BASE}/auth/refresh`, { refreshToken }, {
      timeout: AUTH_REFRESH_REQUEST_TIMEOUT_MS,
      headers: context.authRefreshAttemptId
        ? { "X-Slock-Auth-Refresh-Attempt-Id": context.authRefreshAttemptId }
        : undefined,
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
