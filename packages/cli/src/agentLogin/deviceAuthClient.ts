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
 * That session flow is what `raft agent list` uses to read the agents a
 * person may key. `raft agent login start` / `wait` instead ask for an
 * `agent_key` grant (`authorizeDeviceCode({ grant })` + `pollAgentKey`): the
 * token poll answers with the agent's own `sk_agent_*` once, never a session.
 *
 * `onUserAction` is invoked once the server has returned the
 * verification URI + user_code so the caller can render
 * "Open <uri>, enter <code>". This separates UX from transport so
 * the same client can drive a TTY-style flow and a unit test.
 */

import { undiciFetch as fetch } from "../proxy";

/**
 * What a person needs to approve the login: the approval page's fixed address
 * and the code to type there. Never a link with the code in it (RFC 8628
 * `verification_uri_complete`): such a link lets someone send a person a
 * login of theirs to approve in one click, so the CLI ignores one even from
 * a server that still sends it, and the approval page never reads it.
 */
export interface DeviceCodeLoginUserAction {
  verificationUri: string;
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
  expiresInSeconds: number;
  intervalMs: number;
}

/** The client name the raft CLI gives the approval page when the caller names none. */
export const DEFAULT_DEVICE_LOGIN_CLIENT_NAME = "raft-cli";

/**
 * A one-time `agent_key` grant (server `deviceLoginGrantService`): the person
 * approving picks the agent on the page, and the token poll returns that
 * agent's own key. `agentId` only names the agent asked for; the page never
 * lets it steer the pick. The machine fields are shown to the person as the
 * requester's own (unverified) account of itself.
 */
export interface AgentKeyGrantRequest {
  kind: "agent_key";
  machineName: string;
  hostname: string | null;
  os: string | null;
  agentId?: string;
}

/** The key an approved `agent_key` grant returns, exactly once. */
export interface AgentKeyCredential {
  credentialId: string;
  apiKey: string;
  scopes: string[];
  agentId: string;
  agentName: string;
  serverId: string;
}

/**
 * What the token poll gave for an `agent_key` login. A server from before
 * one-time grants ignores `grant` and answers with a device session instead;
 * that answer is told apart by its shape (no `kind: "agent_key"`), and only
 * then is it read as a session.
 */
export type AgentKeyTokenResult =
  | { kind: "agent_key"; credential: AgentKeyCredential }
  | { kind: "legacy_session"; session: DeviceCodeLoginResult };

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
  token_response_invalid: "The server's answer to the login was not a usable agent key or session. Nothing was saved.",
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
  /** Ask for a one-time grant instead of a device session. */
  grant?: AgentKeyGrantRequest;
  fetchImpl?: typeof fetch;
}): Promise<DeviceAuthorization> {
  const httpFetch = options.fetchImpl ?? fetch;
  const base = options.serverUrl.replace(/\/+$/, "");

  const authorizeRes = await httpFetch(`${base}/api/auth/device/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientName: options.clientName || DEFAULT_DEVICE_LOGIN_CLIENT_NAME,
      ...(options.grant ? { grant: options.grant } : {}),
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
    expiresInSeconds: authorizeBody.expiresIn ?? 600,
    intervalMs: (authorizeBody.interval ?? 5) * 1000,
  };
}

interface PollOptions {
  serverUrl: string;
  deviceCode: string;
  pollIntervalMs: number;
  deadlineMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Step 3 of the device-code grant: poll the token endpoint until the user
 * approves (success), a terminal error occurs, or the client deadline passes.
 * Split out so `raft agent login wait` can resume polling with a device_code
 * issued by an earlier `login start`.
 *
 * Throws `DeviceCodeLoginError` with a stable `code` on terminal failure.
 */
export async function pollDeviceToken(options: PollOptions): Promise<DeviceCodeLoginResult> {
  const session = readSession(await pollTokenAnswer(options));
  if (!session) {
    throw new DeviceCodeLoginError(
      "token_response_invalid",
      "Server's token response was missing accessToken / refreshToken / userId.",
    );
  }
  return session;
}

/**
 * Step 3 for an `agent_key` login: poll until approved, then return the key
 * the server issued (or, from a server older than one-time grants, the device
 * session it answered with instead). The key is returned exactly once by the
 * server; the caller must save it or lose it.
 *
 * Throws `DeviceCodeLoginError` with a stable `code` on terminal failure.
 */
export async function pollAgentKey(options: PollOptions): Promise<AgentKeyTokenResult> {
  const body = await pollTokenAnswer(options);
  if (body?.kind === "agent_key") {
    const credential = readAgentKeyCredential(body);
    if (!credential) {
      throw new DeviceCodeLoginError("token_response_invalid", describeDeviceCodeLoginError("token_response_invalid"));
    }
    return { kind: "agent_key", credential };
  }
  // Only an answer that is not a grant answer is ever read as a session.
  const session = body && body.kind === undefined ? readSession(body) : null;
  if (!session) {
    throw new DeviceCodeLoginError("token_response_invalid", describeDeviceCodeLoginError("token_response_invalid"));
  }
  return { kind: "legacy_session", session };
}

function readAgentKeyCredential(body: Record<string, unknown>): AgentKeyCredential | null {
  const { credentialId, apiKey, scopes, agentId, agentName, serverId } = body;
  if (
    typeof apiKey !== "string" || !/^sk_agent_[A-Za-z0-9_-]+$/.test(apiKey)
    || typeof credentialId !== "string" || !credentialId
    || typeof agentId !== "string" || !agentId
    || typeof agentName !== "string"
    || typeof serverId !== "string" || !serverId
    || !Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")
  ) {
    return null;
  }
  return { credentialId, apiKey, scopes: scopes as string[], agentId, agentName, serverId };
}

function readSession(body: Record<string, unknown> | null): DeviceCodeLoginResult | null {
  const { accessToken, refreshToken, userId } = body ?? {};
  if (typeof accessToken !== "string" || !accessToken
    || typeof refreshToken !== "string" || !refreshToken
    || typeof userId !== "string" || !userId) {
    return null;
  }
  return { accessToken, refreshToken, userId };
}

/** Poll until a 200 and return its JSON body (null when unparsable). */
async function pollTokenAnswer(options: PollOptions): Promise<Record<string, unknown> | null> {
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
      return safeJson(tokenRes);
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
