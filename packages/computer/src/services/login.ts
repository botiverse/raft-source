// LoginService — Computer domain service seam for user identity (RFC v0.8
// contract v3 §6, "device-code login"). CLI and Electron main are both
// adapters over this surface; the service itself never touches
// process.stdout / process.stderr / process.exit.
//
// Shape locked with Hao msg=51a17400 + liuliu msg=7a1a2c3d:
//   - typed opts (loginInput) + `onEvent` (best-effort) + AbortSignal
//   - typed result (loginResult) on success
//   - typed `ComputerServiceError { code, message, cause? }` thrown on failure
//   - `cause` retained in-process only — adapters MUST NOT forward it
//   - device-code event uses `expiresAt: ISO string`, never `expiresIn: seconds`
//     (renderer derives countdown locally — avoids IPC clock skew)
//   - §6 closed-set codes preserved BYTE-IDENTICAL: DEVICE_AUTHORIZE_FAILED /
//     LOGIN_DENIED / LOGIN_EXPIRED / LOGIN_FAILED. No new / changed / deleted
//     codes in this seam-extraction PR.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DeviceAuthClient,
  AuthClient,
  DeviceLoopbackRejectedError,
  type DeviceAuthorizeResult,
  type DeviceGrantRequest,
  type DevicePairingRequest,
  type DeviceTokenResult,
  type LoopbackAuthorizeResult,
} from "../apiClient";
import { userSessionPath, CURRENT_SCHEMA_VERSION } from "../paths";
import { resolveServerUrl, resolveServerUrlEnv } from "../serverUrl";
import type { ComputerApiEvent, LoginModeFallbackReason } from "../lib/events";
import { ComputerServiceError } from "./errors";
import { describeNetworkError, isTransientNetworkError, NETWORK_FAILURE_HINT } from "../networkError";
import { LOOPBACK_MAX_WAIT_MS, startLoopbackListener, type LoopbackListener } from "./loopbackListener";

export interface LoginInput {
  serverUrl?: string;
  /** The Computer install root to write the user session under. Required:
   *  every entry point resolves this exactly once at `createComputerApi`
   *  construction, so the service body never reads ambient env. Stops a new
   *  service from silently regressing to `resolveRaftHome()` and leaking
   *  to `~/.slock`. (#wg-raft-computer:f2a02081 BUG 3 sweep.) */
  slockHome: string;
}

export interface LoginResult {
  userId: string;
  sessionPath: string;
  serverUrl: string;
}

export interface LoginOptions {
  signal?: AbortSignal;
  onEvent?: (event: ComputerApiEvent) => void;
  /**
   * Offer the loopback redirect (loopback login design §6). The adapter that
   * owns the terminal decides whether this environment can use it (the
   * service never reads env or stdio) and opens the browser. Absent: device
   * code, with no `login.mode` event (callers that never offer loopback).
   */
  loopback?: LoopbackLoginOptions;
  /**
   * `--pair`: the Add Computer window the command was copied from
   * (docs/contracts/computer-pairing.md). Sent only on a device-code
   * authorize with a computer grant; loopback never sends it.
   */
  pairing?: DevicePairingRequest;
}

export interface LoopbackLoginOptions {
  /** Set when this environment cannot use loopback (SSH, no display, WSL, no TTY, --device-code). */
  unavailableReason?: LoginModeFallbackReason;
  /** Start this machine's browser on `url`; false when the opener could not start. */
  openBrowser: (url: string) => Promise<boolean>;
  /** Aborted when the person asks for a code instead (pressed c): a fresh device-code request follows. */
  switchToDeviceCode?: AbortSignal;
  /** Test seam: the listener (default: 127.0.0.1, random port). */
  startListener?: typeof startLoopbackListener;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function emit(opts: LoginOptions | undefined, event: ComputerApiEvent): void {
  const cb = opts?.onEvent;
  if (!cb) return;
  try {
    cb(event);
  } catch {
    // onEvent is best-effort — never let a renderer/listener fault break the
    // login flow.
  }
}

/**
 * What the device-code poll ended with (pending is polled away).
 * `unreachable`: the last polls never got an answer (connection reset,
 * DNS, timeout, …); `cause` is the last transport error, kept in-process.
 */
export type DeviceAuthorizationOutcome =
  | Exclude<DeviceTokenResult, { status: "pending" }>
  | { status: "unreachable"; cause: unknown };

/**
 * Polls in a row that may fail at the network layer before the poll gives up.
 * One dropped poll (a VPN blip, a proxy closing an idle socket) must not end a
 * sign-in the person is in the middle of approving.
 */
export const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/**
 * The poll lost the server: name the host and the cause's code only (a
 * cause's message can carry a proxy URL with credentials).
 */
export function lostConnectionMessage(baseUrl: string, cause: unknown, retry: string, note = ""): string {
  return `Lost connection to ${new URL(baseUrl).host} while waiting for approval (${describeNetworkError(cause)}).${note ? ` ${note}` : ""} ${NETWORK_FAILURE_HINT} Then run \`${retry}\` again.`;
}

/**
 * Start a device authorization (with a one-time `grant`, when given) and wait
 * for its answer. With `options.loopback` and a grant, the approval is
 * finished by loopback redirect when it can be (`runLoopbackAuthorization`);
 * otherwise the device-code prompt event is emitted and the token polled
 * until the server answers with something other than "pending". Running out
 * of time counts as `expired`. Callers map the outcome to their own messages;
 * only a failed start throws here.
 */
export async function runDeviceAuthorization(
  baseUrl: string,
  grant: DeviceGrantRequest | undefined,
  options: LoginOptions = {},
): Promise<DeviceAuthorizationOutcome> {
  options.signal?.throwIfAborted?.();
  const client = new DeviceAuthClient(baseUrl);
  const loopback = options.loopback;
  if (!loopback) return runDeviceCodeFlow(client, baseUrl, grant, options);

  // Loopback finishes a one-time grant only (the server refuses it without
  // one: `loopback_grant_required`); a device session is a device code.
  // A person who already asked for a code in this command keeps getting codes.
  const unavailable: LoginModeFallbackReason | undefined = !grant
    ? "no_grant"
    : (loopback.unavailableReason ?? (loopback.switchToDeviceCode?.aborted ? "user_chose_code" : undefined));
  if (unavailable || !grant) {
    const reason = unavailable ?? "no_grant";
    emit(options, { kind: "login.mode", mode: "device_code", reason });
    return runDeviceCodeFlow(client, baseUrl, grant, options, undefined, reason);
  }

  const attempt = await runLoopbackAuthorization(client, baseUrl, grant, loopback, options);
  if (attempt.kind === "done") return attempt.outcome;
  emit(options, { kind: "login.mode", mode: "device_code", reason: attempt.reason });
  return runDeviceCodeFlow(client, baseUrl, grant, options, attempt.authorization, attempt.reason);
}

function deviceAuthorizeFailed(baseUrl: string, err: unknown): ComputerServiceError {
  const reason = err instanceof Error ? err.message : String(err);
  return new ComputerServiceError(
    "DEVICE_AUTHORIZE_FAILED",
    `Could not start device login at ${baseUrl}: ${reason}. Check that the server URL is correct and reachable.`,
    err,
  );
}

/**
 * The device-code flow (as before loopback): start a request (or take the
 * one an older server already started for a loopback authorize), emit the
 * prompt, poll. `fallbackReason`: why loopback was not used, sent on the
 * request this starts so the server keeps it on the row (audit only).
 */
async function runDeviceCodeFlow(
  client: DeviceAuthClient,
  baseUrl: string,
  grant: DeviceGrantRequest | undefined,
  options: LoginOptions,
  started?: DeviceAuthorizeResult,
  fallbackReason?: LoginModeFallbackReason,
): Promise<DeviceAuthorizationOutcome> {
  options.signal?.throwIfAborted?.();
  let authorization: DeviceAuthorizeResult;
  if (started) {
    authorization = started;
  } else {
    try {
      authorization = await client.authorize("raft-computer", grant, grant ? options.pairing : undefined, fallbackReason);
    } catch (err) {
      throw deviceAuthorizeFailed(baseUrl, err);
    }
  }

  // The approval page's fixed address, never a link with the code in it (an
  // older server still sends `verificationUriComplete`): a link that carries
  // the code lets someone get a person to approve their login in one click.
  // The person types the code shown here.
  const verifyUrl = new URL(authorization.verificationUri, baseUrl).toString();
  const expiresAt = new Date(Date.now() + authorization.expiresIn * 1000).toISOString();
  emit(options, {
    kind: "login.device-code",
    verifyUrl,
    userCode: authorization.userCode,
    expiresAt,
    expiresInSeconds: authorization.expiresIn,
    // Only when this authorize sent a pairing (never the id itself).
    ...(authorization.paired !== undefined ? { paired: authorization.paired } : {}),
  });

  const intervalMs = Math.max(1, authorization.interval) * 1000;
  const deadline = Date.now() + authorization.expiresIn * 1000;
  let failures = 0;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted?.();
    await sleep(intervalMs, options.signal);
    emit(options, { kind: "login.polling" });
    let r: DeviceTokenResult;
    try {
      r = await client.token(authorization.deviceCode, options.signal);
    } catch (err) {
      // The person's cancel is never retried; neither is anything that is
      // not a dropped connection.
      if (options.signal?.aborted) throw abortError(options.signal);
      if (!isTransientNetworkError(err)) throw err;
      failures += 1;
      lastFailure = err;
      if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) return { status: "unreachable", cause: err };
      continue;
    }
    failures = 0;
    if (r.status === "pending") continue;
    return r;
  }
  // Out of time while the server could not be reached: say so, not "expired".
  if (failures > 0) return { status: "unreachable", cause: lastFailure };
  return { status: "expired" };
}

type LoopbackAttempt =
  | { kind: "done"; outcome: DeviceAuthorizationOutcome }
  /** Use a device code: `authorization` when an older server already started one. */
  | { kind: "fallback"; reason: LoginModeFallbackReason; authorization?: DeviceAuthorizeResult };

/** Redeem attempts for a loopback code when the connection drops before an answer. */
const LOOPBACK_REDEEM_ATTEMPTS = 3;
const LOOPBACK_REDEEM_RETRY_MS = 1_000;

/** RFC 7636 verifier: 32 random bytes, base64url (43 chars). */
export function createPkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * The loopback redirect (loopback login design §5): listen on 127.0.0.1,
 * authorize with the return URI and a PKCE challenge, open the approval page
 * in this machine's browser, wait for the browser to come back with a
 * one-time code, redeem it with the verifier. Falls back to a device code
 * when the port cannot be bound, the server does not support loopback, the
 * browser cannot be started, or the person asks for a code.
 */
async function runLoopbackAuthorization(
  client: DeviceAuthClient,
  baseUrl: string,
  grant: DeviceGrantRequest,
  loopback: LoopbackLoginOptions,
  options: LoginOptions,
): Promise<LoopbackAttempt> {
  const verifier = createPkceVerifier();
  const state = randomBytes(24).toString("base64url");
  let listener: LoopbackListener;
  try {
    listener = await (loopback.startListener ?? startLoopbackListener)({
      state,
      onRejected: (why) => emit(options, { kind: "login.loopback.result", result: why }),
    });
  } catch {
    return { kind: "fallback", reason: "bind_failed" };
  }
  try {
    let authorization: LoopbackAuthorizeResult;
    try {
      const answered = await client.authorizeLoopback("raft-computer", grant, {
        returnUri: listener.returnUri,
        codeChallenge: pkceS256Challenge(verifier),
      });
      // An older server ignored `loopback` and started a device-code request:
      // use that one (a second request would leave this one dangling).
      if (answered.kind === "device") {
        return { kind: "fallback", reason: "server_unsupported", authorization: answered.authorization };
      }
      authorization = answered.authorization;
    } catch (err) {
      if (err instanceof DeviceLoopbackRejectedError) return { kind: "fallback", reason: "server_unsupported" };
      throw deviceAuthorizeFailed(baseUrl, err);
    }

    const approvalUrl = acceptableApprovalUrl(authorization.approvalUrl, baseUrl);
    if (!approvalUrl) return { kind: "fallback", reason: "server_unsupported" };
    options.signal?.throwIfAborted?.();
    let opened = false;
    try {
      opened = await loopback.openBrowser(approvalUrl);
    } catch {
      opened = false;
    }
    // The loopback request is left to expire on the server: nothing can
    // complete it without this process's verifier.
    if (!opened) return { kind: "fallback", reason: "browser_open_failed" };

    emit(options, { kind: "login.mode", mode: "loopback" });
    const timeoutMs = Math.min(Math.max(0, authorization.expiresIn) * 1000, LOOPBACK_MAX_WAIT_MS);
    const startedAt = Date.now();
    emit(options, {
      kind: "login.loopback-waiting",
      approvalUrl,
      expiresAt: new Date(startedAt + timeoutMs).toISOString(),
      expiresInSeconds: Math.round(timeoutMs / 1000),
      canSwitchToCode: Boolean(loopback.switchToDeviceCode),
    });

    const cancels = [options.signal, loopback.switchToDeviceCode].filter((s): s is AbortSignal => Boolean(s));
    const callback = await listener.wait({ timeoutMs, ...(cancels.length > 0 ? { signal: AbortSignal.any(cancels) } : {}) });
    if (options.signal?.aborted) throw abortError(options.signal);
    const msToResult = Date.now() - startedAt;
    if (callback.status === "cancelled") return { kind: "fallback", reason: "user_chose_code" };
    if (callback.status === "expired") {
      emit(options, { kind: "login.loopback.result", result: "expired", msToResult });
      return { kind: "done", outcome: { status: "expired" } };
    }
    if (callback.status === "denied") {
      emit(options, { kind: "login.loopback.result", result: "denied", msToResult });
      return { kind: "done", outcome: { status: "denied" } };
    }
    emit(options, { kind: "login.loopback.result", result: "approved", msToResult });
    return {
      kind: "done",
      outcome: await redeemLoopbackCode(client, { requestId: authorization.requestId, code: callback.code, codeVerifier: verifier }, options),
    };
  } finally {
    await listener.close();
  }
}

async function redeemLoopbackCode(
  client: DeviceAuthClient,
  input: { requestId: string; code: string; codeVerifier: string },
  options: LoginOptions,
): Promise<DeviceAuthorizationOutcome> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= LOOPBACK_REDEEM_ATTEMPTS; attempt += 1) {
    options.signal?.throwIfAborted?.();
    let r: DeviceTokenResult;
    try {
      r = await client.redeemLoopback(input, options.signal);
    } catch (err) {
      if (options.signal?.aborted) throw abortError(options.signal);
      if (!isTransientNetworkError(err)) throw err;
      // An answer lost after the server took the code comes back as
      // device_code_consumed on the next try, which callers explain.
      lastFailure = err;
      if (attempt < LOOPBACK_REDEEM_ATTEMPTS) await sleep(LOOPBACK_REDEEM_RETRY_MS, options.signal);
      continue;
    }
    // A loopback code is never pending: the browser only comes back once
    // the request is approved.
    if (r.status === "pending") return { status: "error", code: "unexpected_response" };
    return r;
  }
  return { status: "unreachable", cause: lastFailure };
}

/**
 * Write the device session a legacy (grant-less) device login returned to
 * `user-session.json` (0600). Only the legacy path calls this: a one-time
 * grant never yields a session.
 */
export async function persistUserSession(
  slockHome: string,
  baseUrl: string,
  r: Extract<DeviceTokenResult, { status: "success" }>,
): Promise<string> {
  // Enrich the session with the user's display identity so surfaces (menu-bar,
  // CLI status) can show a real name instead of a raw UUID (task #112). The
  // session previously stored only `userId`. Best-effort: a /me failure must
  // NOT fail an otherwise-successful login — we just persist without the
  // display fields and the presenter falls back to the id.
  let identity: { email?: string; name?: string; displayName?: string | null } = {};
  try {
    const me = await new AuthClient(baseUrl, r.accessToken).me();
    if (me.status === "success") {
      identity = { email: me.user.email, name: me.user.name, displayName: me.user.displayName };
    }
  } catch {
    // best-effort; leave identity empty
  }

  const file = userSessionPath(slockHome);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      {
        kind: "user-session",
        // On-disk schema version; readers tolerate a missing value.
        schemaVersion: CURRENT_SCHEMA_VERSION,
        userId: r.userId,
        accessToken: r.accessToken,
        refreshToken: r.refreshToken,
        serverUrl: baseUrl,
        // Display identity (task #112) — optional; absent on older sessions
        // and when /me was unreachable at login. Presenters fall back to the
        // userId when these are missing.
        ...(identity.email !== undefined ? { email: identity.email } : {}),
        ...(identity.name !== undefined ? { name: identity.name } : {}),
        ...(identity.displayName !== undefined && identity.displayName !== null
          ? { displayName: identity.displayName }
          : {}),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return file;
}

export async function login(input: LoginInput, options: LoginOptions = {}): Promise<LoginResult> {
  const baseUrl = resolveServerUrl(input.serverUrl, resolveServerUrlEnv());
  const r = await runDeviceAuthorization(baseUrl, undefined, options);
  if (r.status === "denied") {
    throw new ComputerServiceError("LOGIN_DENIED", "Login was denied in the approval page.");
  }
  if (r.status === "expired") {
    throw new ComputerServiceError(
      "LOGIN_EXPIRED",
      "Login request expired before approval. Re-run `raft-computer login`.",
    );
  }
  if (r.status === "unreachable") {
    throw new ComputerServiceError("LOGIN_FAILED", lostConnectionMessage(baseUrl, r.cause, "raft-computer login"), r.cause);
  }
  if (r.status === "error" && r.code === "device_code_consumed") {
    // Only this machine holds the device code, so the server consumed it for
    // an earlier poll of ours whose answer never arrived.
    throw new ComputerServiceError(
      "LOGIN_FAILED",
      "Login failed (device_code_consumed): the login was approved, but the server's answer was lost on the network before it reached this machine. Re-run `raft-computer login`.",
    );
  }
  if (r.status === "error") {
    throw new ComputerServiceError(
      "LOGIN_FAILED",
      `Login failed (${r.code}). Re-run \`raft-computer login\`.`,
    );
  }
  if (r.status === "attach_token" || r.status === "migrate_token") {
    // This login never asks for a grant, so a server answering with a
    // grant's token is broken; never treat it as a session.
    throw new ComputerServiceError(
      "LOGIN_FAILED",
      "Login failed (unexpected_response). Re-run `raft-computer login`.",
    );
  }
  const file = await persistUserSession(input.slockHome, baseUrl, r);
  emit(options, { kind: "login.approved", userId: r.userId, sessionPath: file });
  return { userId: r.userId, sessionPath: file, serverUrl: baseUrl };
}

/**
 * The approval page a loopback authorize named, if it is one this Computer
 * opens in the browser: a `/login/device` path over https, or over http only
 * when the server itself is on this machine (local development). What this
 * guarantees is the scheme and the path: never `javascript:`, `file:` or a
 * custom protocol handler, never another kind of page. The host is not
 * pinned (the API, `api.raft.build`, and the web app, `app.raft.build`, are
 * different origins): it is trusted because the answer came over TLS from the
 * server the person chose. Anything else gets a device code instead.
 */
export function acceptableApprovalUrl(raw: string, baseUrl: string): string | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(raw, baseUrl);
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  if (url.pathname !== "/login/device") return null;
  const localBase = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localBase && url.hostname === base.hostname)) return null;
  return url.toString();
}
