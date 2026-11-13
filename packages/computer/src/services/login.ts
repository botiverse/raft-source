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
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DeviceAuthClient, AuthClient, type DeviceGrantRequest, type DeviceTokenResult } from "../apiClient";
import { userSessionPath, CURRENT_SCHEMA_VERSION } from "../paths";
import { resolveServerUrl, resolveServerUrlEnv } from "../serverUrl";
import type { ComputerApiEvent } from "../lib/events";
import { ComputerServiceError } from "./errors";
import { describeNetworkError, isTransientNetworkError, NETWORK_FAILURE_HINT } from "../networkError";

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
 * Start a device authorization (with a one-time `grant`, when given), emit the
 * approval prompt event, and poll until the server answers with something
 * other than "pending". The poll timing out counts as `expired`. Callers map
 * the outcome to their own messages; only a failed start throws here.
 */
export async function runDeviceAuthorization(
  baseUrl: string,
  grant: DeviceGrantRequest | undefined,
  options: LoginOptions = {},
): Promise<DeviceAuthorizationOutcome> {
  options.signal?.throwIfAborted?.();
  const client = new DeviceAuthClient(baseUrl);
  let authorization;
  try {
    authorization = await client.authorize("raft-computer", grant);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ComputerServiceError(
      "DEVICE_AUTHORIZE_FAILED",
      `Could not start device login at ${baseUrl}: ${reason}. Check that the server URL is correct and reachable.`,
      err,
    );
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
