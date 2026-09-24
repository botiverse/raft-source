/**
 * Minimal CLI-side client for the device-code login grant
 * (`/api/auth/device/{authorize,approve,token}` — see
 * `packages/server/src/routes/deviceAuth.ts`, landed on
 * `xx/device-code-login-shared` / PR #1916).
 *
 * NOT a shared package because the boundary linter
 * (`scripts/check-boundaries.mjs`) forbids
 * `@botiverse/raft-computer` ↔ `@botiverse/raft` direct imports both ways
 * (#1573 revert lesson, enforced by XX msg=f71a6195). The Computer
 * package has its own DeviceAuthClient; this one is the agent-side
 * mirror. A future refactor can extract the shared grant client to
 * `@slock-ai/auth-client` or similar — that's a separate refactor
 * PR, not part of the external agent credential mint work.
 *
 * Surface intentionally narrow:
 *
 *   const session = await runDeviceCodeLogin({ serverUrl, onUserAction });
 *
 * `onUserAction` is invoked once the server has returned the
 * verification URI + user_code so the caller can render
 * "Open <uri>, enter <code>". This separates UX from transport so
 * the same client can drive a TTY-style flow and a unit test.
 */

import { fetch } from "undici";

export interface DeviceCodeLoginUserAction {
  verificationUri: string;
  /**
   * RFC 8628 `verification_uri_complete` — the verification URI with the
   * user_code pre-filled as a query param. When present this is the single
   * link to hand the user (they click + approve, no code typing). The server
   * builds it (`deviceAuth.ts` buildVerificationUri) and the web approval
   * page reads `?user_code=` to pre-fill (`DeviceLoginPage.tsx`).
   */
  verificationUriComplete?: string;
  userCode: string;
  expiresInSeconds: number;
}

/**
 * Result of the authorize step alone — the device_code handle plus the
 * human verification surface. `login start` returns this to the operator
 * and `login wait` later resumes polling with `deviceCode`.
 */
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalMs: number;
}

export interface RunDeviceCodeLoginOptions {
  serverUrl: string;
  /**
   * Human-readable client label sent to the authorize endpoint;
   * surfaced on the web approval page so the user knows what they
   * are approving. Optional but recommended.
   */
  clientName?: string;
  /**
   * Called exactly once when the server returns a device_code +
   * user_code. The caller is expected to print/open the verification
   * URI for the operator.
   */
  onUserAction(action: DeviceCodeLoginUserAction): void | Promise<void>;
  /**
   * Override the poll interval the server returned. Tests pass `0`
   * to drive polls deterministically; production should accept the
   * server's value.
   */
  pollIntervalOverrideMs?: number;
  /**
   * Test seam — defaults to `globalThis.fetch` via undici.
   */
  fetchImpl?: typeof fetch;
}

export interface DeviceCodeLoginResult {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

export class DeviceCodeLoginError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DeviceCodeLoginError";
  }
}

/**
 * Human-readable mapping for the stable server error codes documented
 * in `packages/server/src/routes/deviceAuth.ts`. The CLI uses the
 * `code` field for branching; this map is what gets rendered when the
 * CLI presents a final failure to the operator (per PR-B liuliu
 * constraint: "actionable error map, not raw server response dump").
 */
const ACTIONABLE_ERROR_MESSAGES: Record<string, string> = {
  device_login_disabled:
    "Device login is not enabled on this Raft server. Ask an admin to set SLOCK_DEVICE_LOGIN_ENABLED=true.",
  device_code_required: "Internal CLI bug: device_code was missing from the poll request.",
  user_code_required: "Internal CLI bug: user_code was missing from the approve request.",
  authorization_pending: "Still waiting for you to approve the login on the web page.",
  expired_token: "The login code expired. Run `raft agent login` again to start a new flow.",
  access_denied: "You denied the login request in the web approval page.",
  device_code_consumed: "This login code has already been used. Run `raft agent login` again.",
  device_code_invalid:
    "Unknown / malformed device code. Run `raft agent login` again to start a fresh flow.",
};

export function describeDeviceCodeLoginError(code: string): string {
  return ACTIONABLE_ERROR_MESSAGES[code] ?? `Device login failed (code: ${code}).`;
}

/**
 * Drive the device-code login flow end-to-end.
 *
 * 1. POST `/api/auth/device/authorize` to claim a device_code + user_code.
 * 2. Invoke `onUserAction` so the caller can print the verification
 *    URI + user_code (and copy to clipboard / open browser if it wants).
 * 3. Poll POST `/api/auth/device/token` until the server returns a
 *    user session, or until a terminal error.
 *
 * Throws `DeviceCodeLoginError` with a stable `code` field on
 * terminal failures.
 */
export async function runDeviceCodeLogin(
  options: RunDeviceCodeLoginOptions,
): Promise<DeviceCodeLoginResult> {
  // --- step 1: authorize ---
  const authorization = await authorizeDeviceCode({
    serverUrl: options.serverUrl,
    ...(options.clientName ? { clientName: options.clientName } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  // --- step 2: hand the verification surface to the caller ---
  await options.onUserAction({
    verificationUri: authorization.verificationUri,
    ...(authorization.verificationUriComplete
      ? { verificationUriComplete: authorization.verificationUriComplete }
      : {}),
    userCode: authorization.userCode,
    expiresInSeconds: authorization.expiresInSeconds,
  });

  // --- step 3: poll the token endpoint ---
  const pollIntervalMs = options.pollIntervalOverrideMs ?? authorization.intervalMs;
  const deadlineMs = Date.now() + Math.max(1, authorization.expiresInSeconds) * 1000;
  return pollDeviceToken({
    serverUrl: options.serverUrl,
    deviceCode: authorization.deviceCode,
    pollIntervalMs,
    deadlineMs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

/**
 * Step 1 of the device-code grant: claim a device_code + user_code and the
 * human verification surface. Split out so `raft agent login start` can
 * return the handoff and exit without blocking on approval (the nonblocking
 * agent-safe flow — `rfcs/035`); `runDeviceCodeLogin` composes it for the
 * one-shot path.
 *
 * Throws `DeviceCodeLoginError` with a stable `code` on terminal failure.
 */
export async function authorizeDeviceCode(options: {
  serverUrl: string;
  clientName?: string;
  fetchImpl?: typeof fetch;
}): Promise<DeviceAuthorization> {
  const httpFetch = options.fetchImpl ?? fetch;
  const base = options.serverUrl.replace(/\/+$/, "");

  const authorizeRes = await httpFetch(`${base}/api/auth/device/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(options.clientName ? { clientName: options.clientName } : {}),
    }),
  });
  if (!authorizeRes.ok) {
    const payload = await safeJson(authorizeRes);
    throw new DeviceCodeLoginError(
      typeof payload?.code === "string" ? payload.code : "authorize_failed",
      describeDeviceCodeLoginError(typeof payload?.code === "string" ? payload.code : "authorize_failed"),
    );
  }
  const authorizeBody = (await authorizeRes.json()) as {
    deviceCode?: string;
    userCode?: string;
    verificationUri?: string;
    verificationUriComplete?: string;
    expiresIn?: number;
    interval?: number;
  };
  if (!authorizeBody.deviceCode || !authorizeBody.userCode || !authorizeBody.verificationUri) {
    throw new DeviceCodeLoginError(
      "authorize_response_invalid",
      "Server's authorize response was missing deviceCode / userCode / verificationUri.",
    );
  }

  // URIs may be server-relative — compose against the base.
  const absolutize = (uri: string): string => (uri.startsWith("http") ? uri : `${base}${uri}`);

  return {
    deviceCode: authorizeBody.deviceCode,
    userCode: authorizeBody.userCode,
    verificationUri: absolutize(authorizeBody.verificationUri),
    ...(authorizeBody.verificationUriComplete
      ? { verificationUriComplete: absolutize(authorizeBody.verificationUriComplete) }
      : {}),
    expiresInSeconds: authorizeBody.expiresIn ?? 600,
    intervalMs: (authorizeBody.interval ?? 5) * 1000,
  };
}

/**
 * Step 3 of the device-code grant: poll the token endpoint until the user
 * approves (success), a terminal error occurs, or the client deadline passes.
 * Split out so `raft agent login wait` can resume polling with a device_code
 * issued by an earlier `login start`.
 *
 * Throws `DeviceCodeLoginError` with a stable `code` on terminal failure.
 */
export async function pollDeviceToken(options: {
  serverUrl: string;
  deviceCode: string;
  pollIntervalMs: number;
  deadlineMs: number;
  fetchImpl?: typeof fetch;
}): Promise<DeviceCodeLoginResult> {
  const httpFetch = options.fetchImpl ?? fetch;
  const base = options.serverUrl.replace(/\/+$/, "");

  while (Date.now() < options.deadlineMs) {
    let tokenRes: Awaited<ReturnType<typeof httpFetch>>;
    try {
      tokenRes = await httpFetch(`${base}/api/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: options.deviceCode }),
      });
    } catch {
      // Transient network error (DNS / connect / timeout / reset) —
      // retry after a short backoff instead of crashing the whole flow.
      // The server hasn't seen this request, so no state was consumed.
      await delay(options.pollIntervalMs);
      continue;
    }
    if (tokenRes.ok) {
      const tokenBody = (await tokenRes.json()) as {
        accessToken?: string;
        refreshToken?: string;
        userId?: string;
      };
      if (!tokenBody.accessToken || !tokenBody.refreshToken || !tokenBody.userId) {
        throw new DeviceCodeLoginError(
          "token_response_invalid",
          "Server's token response was missing accessToken / refreshToken / userId.",
        );
      }
      return {
        accessToken: tokenBody.accessToken,
        refreshToken: tokenBody.refreshToken,
        userId: tokenBody.userId,
      };
    }
    const tokenError = await safeJson(tokenRes);
    const code = typeof tokenError?.code === "string" ? tokenError.code : "token_failed";
    if (code === "authorization_pending") {
      // Expected — keep polling.
      await delay(options.pollIntervalMs);
      continue;
    }
    // Any other status → terminal.
    throw new DeviceCodeLoginError(code, describeDeviceCodeLoginError(code));
  }
  throw new DeviceCodeLoginError(
    "expired_token",
    describeDeviceCodeLoginError("expired_token"),
  );
}

async function safeJson(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
