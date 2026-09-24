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
import { DeviceAuthClient, AuthClient } from "../apiClient.js";
import { userSessionPath, CURRENT_SCHEMA_VERSION } from "../paths.js";
import { resolveServerUrl, resolveServerUrlEnv } from "../serverUrl.js";
import type { ComputerApiEvent } from "../lib/events.js";
import { ComputerServiceError } from "./errors.js";

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

export async function login(input: LoginInput, options: LoginOptions = {}): Promise<LoginResult> {
  const baseUrl = resolveServerUrl(input.serverUrl, resolveServerUrlEnv());
  options.signal?.throwIfAborted?.();

  const client = new DeviceAuthClient(baseUrl);
  let grant;
  try {
    grant = await client.authorize("raft-computer");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ComputerServiceError(
      "DEVICE_AUTHORIZE_FAILED",
      `Could not start device login at ${baseUrl}: ${reason}. Check that the server URL is correct and reachable.`,
      err,
    );
  }

  const verificationUri = grant.verificationUriComplete || grant.verificationUri;
  const verifyUrl = new URL(verificationUri, baseUrl).toString();
  const expiresAt = new Date(Date.now() + grant.expiresIn * 1000).toISOString();
  emit(options, {
    kind: "login.device-code",
    verifyUrl,
    userCode: grant.userCode,
    expiresAt,
    expiresInSeconds: grant.expiresIn,
  });

  const intervalMs = Math.max(1, grant.interval) * 1000;
  const deadline = Date.now() + grant.expiresIn * 1000;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted?.();
    await sleep(intervalMs, options.signal);
    emit(options, { kind: "login.polling" });
    const r = await client.token(grant.deviceCode);
    if (r.status === "pending") continue;
    if (r.status === "denied") {
      throw new ComputerServiceError("LOGIN_DENIED", "Login was denied in the approval page.");
    }
    if (r.status === "expired") {
      throw new ComputerServiceError(
        "LOGIN_EXPIRED",
        "Login request expired before approval. Re-run `raft-computer login`.",
      );
    }
    if (r.status === "error") {
      throw new ComputerServiceError(
        "LOGIN_FAILED",
        `Login failed (${r.code}). Re-run \`raft-computer login\`.`,
      );
    }

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

    const file = userSessionPath(input.slockHome);
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
    emit(options, { kind: "login.approved", userId: r.userId, sessionPath: file });
    return { userId: r.userId, sessionPath: file, serverUrl: baseUrl };
  }
  throw new ComputerServiceError(
    "LOGIN_EXPIRED",
    "Login request expired before approval. Re-run `raft-computer login`.",
  );
}
