import { ambientProcessEnv } from "../processEnvPatch";
import { daemonFetch } from "../daemonFetch";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { noteOwnCredentialWrite } from "../credentialSource";

import { KIMI_CODE_OAUTH_CLIENT_ID, kimiDeviceHeaders, type KimiCodeAuth } from "./kimiAuth";
import { withKimiRefreshLock, type KimiLockOptions } from "./kimiCredentialLock";

/**
 * task #1282 — keep the Kimi Code access token fresh before the usage probe,
 * exactly as the client keeps it fresh for itself (kimi-code `OAuthManager`,
 * identical in 0.31.1 and 2.1.1), so a 15-minute token that expired while no
 * client was running does not turn the usage panel into a false "re-login".
 *
 * Contract mirrored from the client:
 *  - refresh when `expires_at - now < max(300, expires_in * 0.5)`;
 *  - under the client's own proper-lockfile lock: re-read; if another writer
 *    already rotated the token, adopt it and do not request;
 *  - `POST <oauthHost>/api/oauth/token` (form: client_id, grant_type, refresh_token);
 *    401 / 403 / `invalid_grant` are a rejection; 429 / 5xx retry with backoff;
 *  - the response must carry a new refresh_token (rotation is enforced), the
 *    whole token is replaced on disk with the client's atomic write
 *    (tmp.<pid>.<rand> + fsync + chmod 600 + rename, 2-space JSON);
 *  - on a rejection, re-read once after 100 ms; a changed refresh_token means
 *    another writer rotated and the file is adopted.
 *
 * Deliberate differences:
 *  - this daemon does not write the client's revoked tombstone (empty
 *    tokens) for a token the user had: a rejection is reported, not
 *    persisted, so the daemon cannot sign the user out of their CLI. The one
 *    exception is a token it put back over the client's own tombstone (see
 *    below): if that is rejected too, the tombstone goes back, once;
 *  - no refresh on win32 or with `KIMI_DISABLE_OAUTH_LOCK=1` (the client runs
 *    unlocked there);
 *  - the lock wait is bounded and a lock we cannot take is a bounded failure.
 *
 * A rotation is never dropped: once the
 * server has answered with a new refresh token, the old one may already be
 * dead, so a result this daemon cannot write to the credentials file (lock
 * compromised, write failed) is kept as a pending rotation: in this
 * process's memory, and in a Raft-owned file beside the credentials
 * (`<credentials>.raft-rotated`, mode 600) when that write succeeds, so it
 * also survives a restart. The next run takes the lock and
 * moves it into place while the credentials file still holds the refresh
 * token it replaced, or the client's revoked tombstone written after the
 * rotation went out (the client tombstones only a rejected
 * refresh, i.e. the one it tried with the token we used up; `kimi logout`
 * deletes the file). A deleted file (logout) or another token (a login,
 * another writer's rotation) wins and the pending rotation is discarded; a
 * file that cannot be read at that moment (any read error but ENOENT)
 * keeps it pending. The same rules apply to the last read before this run's
 * own write. The pending file holds a live refresh token and is as sensitive
 * as the credentials file. Before the request, a lock already compromised
 * stops the run with nothing sent.
 *
 * The token endpoint must be https (a loopback http host only through
 * the `allowLoopbackHttp` test seam) and is reached through `daemonFetch`, so
 * the daemon's proxy settings apply; redirects are refused.
 *
 * Known residual window (the client's login/logout write without the lock):
 * a login that lands between this daemon's last in-lock comparison and its
 * rename is overwritten. Pinned by a test marked as an expected failure.
 */

export const KIMI_MIN_REFRESH_THRESHOLD_SECONDS = 300;
export const KIMI_REFRESH_THRESHOLD_RATIO = 0.5;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface KimiStoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  scope: string;
  token_type: string;
}

export type KimiFreshness =
  | { kind: "fresh"; expiresAt: number }
  | { kind: "refreshed"; expiresAt: number }
  | { kind: "adopted"; expiresAt: number }
  | { kind: "rejected"; reason: "refresh_rejected" }
  | { kind: "revoked" }
  | { kind: "missing"; reason: "no_file" | "unreadable" | "malformed" | "no_refresh_token" }
  | { kind: "transient"; reason: "network" | "server" | "lock_unavailable" | "lock_compromised" | "write_failed" | "rotation_missing" | "malformed_response"; expired: boolean }
  | { kind: "platform_unsupported"; reason: "win32" | "lock_disabled" | "storage_not_file" | "insecure_oauth_host" };

export interface KimiRefreshDeps {
  now?: () => number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  lock?: KimiLockOptions;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  identity?: { platform: string; version: string };
  /** Test seam: runs in the lock just before the token request. */
  beforeRequest?: () => Promise<void> | void;
  /** Test seam: runs between the last in-lock comparison and the rename (the residual window). */
  beforeWrite?: () => Promise<void> | void;
  maxRetries?: number;
  backoffMs?: (attempt: number) => number;
  timeoutMs?: number;
  /** Test seam: also accept an http OAuth host on a loopback address. Production requires https. */
  allowLoopbackHttp?: boolean;
}

export function kimiRefreshThresholdSeconds(expiresIn: number): number {
  return expiresIn > 0 ? Math.max(KIMI_MIN_REFRESH_THRESHOLD_SECONDS, expiresIn * KIMI_REFRESH_THRESHOLD_RATIO) : KIMI_MIN_REFRESH_THRESHOLD_SECONDS;
}

/**
 * The client's `revokedTombstone`: empty access and refresh tokens with
 * `expires_at` 0 (scope / token_type carried over). Only this exact shape is
 * a revocation. The client itself reads any record without an access token as
 * revoked (`tokenFromWire` → `classifyToken`); this daemon is stricter on
 * purpose: a file with missing or mistyped fields (`{}`, a partial write, a
 * foreign shape) is `malformed`, which lets the probe speak, and never a
 * verdict that sends the user to log in again (review on #9802).
 */
export function isKimiRevokedTombstone(record: Record<string, unknown>): boolean {
  return record.access_token === "" && record.refresh_token === "" && record.expires_at === 0;
}

export function readKimiStoredToken(path: string): { kind: "ok"; token: KimiStoredToken } | { kind: "missing"; reason: "no_file" | "unreadable" | "malformed" } | { kind: "revoked" } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // Only a file that is not there is "no file": EACCES, EMFILE or EIO
    // on a daemon running many agents is a transient read failure, and a
    // pending rotation must survive it.
    return { kind: "missing", reason: (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "no_file" : "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "missing", reason: "unreadable" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "missing", reason: "unreadable" };
  if (Array.isArray(parsed)) return { kind: "missing", reason: "unreadable" };
  const record = parsed as Record<string, unknown>;
  if (isKimiRevokedTombstone(record)) return { kind: "revoked" };
  // A usable token needs a non-empty access token; a present refresh_token
  // must be a string (an empty one is reported as no_refresh_token later).
  if (typeof record.access_token !== "string" || record.access_token.length === 0) return { kind: "missing", reason: "malformed" };
  if (record.refresh_token !== undefined && typeof record.refresh_token !== "string") return { kind: "missing", reason: "malformed" };
  return {
    kind: "ok",
    token: {
      access_token: record.access_token,
      refresh_token: typeof record.refresh_token === "string" ? record.refresh_token : "",
      expires_at: typeof record.expires_at === "number" ? record.expires_at : 0,
      expires_in: typeof record.expires_in === "number" ? record.expires_in : 0,
      scope: typeof record.scope === "string" ? record.scope : "",
      token_type: typeof record.token_type === "string" ? record.token_type : "Bearer",
    },
  };
}

/** The client's FileTokenStorage.save, byte for byte in shape. */
export function writeKimiStoredToken(path: string, token: KimiStoredToken): void {
  writeKimiJsonFile(path, token);
  // Reconciler step 15: the daemon's own refresh is not a user's sign-in.
  noteOwnCredentialWrite(path);
}

/** Atomic write: tmp.<pid>.<rand> + fsync + chmod 600 + rename, 2-space JSON. */
function writeKimiJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const fd = openSync(tmp, "w", 0o600);
  try {
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
}

/** Where a rotated token this daemon could not write waits for the next run. */
export function kimiPendingRotationPath(credentialPath: string): string {
  return `${credentialPath}.raft-rotated`;
}

function refreshTokenDigest(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

interface KimiPendingRotation {
  /** sha256 of the refresh token the rotation replaced; the old token itself is never stored. */
  replaces: string;
  token: KimiStoredToken;
  /** Wall-clock ms when the refresh request went out: from then on the replaced refresh token may be dead. */
  rotatedAtMs: number;
}

/**
 * Slack for the credentials file's mtime against `rotatedAtMs` (filesystem
 * timestamp granularity); the client writes its tombstone only after its own
 * request with the replaced token was rejected, which is later still.
 */
const TOMBSTONE_MTIME_SLACK_MS = 1_000;

/**
 * The client writes its revoked tombstone only when its refresh was
 * rejected (kimi-code `OAuthManager.ensureFresh`, 0.31.1 / 2.1.1 / 2.2.0
 * oauth-manager.ts:388); `kimi logout` deletes the file instead (:246). A
 * tombstone written after this daemon's rotation went out is therefore the
 * client being signed out by the refresh token the rotation used up, not a
 * logout, and the pending token is what logs it back in.
 */
function isTombstoneFromOurRotation(credentialPath: string, rotatedAtMs: number): boolean {
  if (!(rotatedAtMs > 0)) return false;
  try {
    return statSync(credentialPath).mtimeMs >= rotatedAtMs - TOMBSTONE_MTIME_SLACK_MS;
  } catch {
    return false;
  }
}

/** Pending rotations by credentials path, for when even the pending file cannot be written. */
const pendingRotationsInMemory = new Map<string, KimiPendingRotation>();

/**
 * Refresh tokens this daemon put back over a client tombstone, by credentials
 * path (sha256). If such a token is rejected too (the grant itself was
 * revoked), the tombstone goes back and stays: one restore, never a loop.
 */
const restoredOverTombstone = new Map<string, string>();

/** The client's `revokedTombstone(prior)`, field for field (kimi-code token-state.ts). */
function kimiTombstoneOf(prior: KimiStoredToken): KimiStoredToken {
  return { access_token: "", refresh_token: "", expires_at: 0, expires_in: 0, scope: prior.scope, token_type: prior.token_type };
}

function writeKimiPendingRotation(credentialPath: string, replacedRefreshToken: string, token: KimiStoredToken, rotatedAtMs: number): void {
  const pending: KimiPendingRotation = { replaces: refreshTokenDigest(replacedRefreshToken), token, rotatedAtMs };
  pendingRotationsInMemory.set(credentialPath, pending);
  try {
    writeKimiJsonFile(kimiPendingRotationPath(credentialPath), pending);
  } catch {
    // The in-memory copy still reaches the next run of this process.
  }
}

function hasKimiPendingRotation(credentialPath: string): boolean {
  return pendingRotationsInMemory.has(credentialPath) || existsSync(kimiPendingRotationPath(credentialPath));
}

function readKimiPendingRotation(credentialPath: string): KimiPendingRotation | "malformed" | null {
  const inMemory = pendingRotationsInMemory.get(credentialPath);
  if (inMemory !== undefined) return inMemory;
  let raw: string;
  try {
    raw = readFileSync(kimiPendingRotationPath(credentialPath), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "malformed";
    const record = parsed as Record<string, unknown>;
    const token = record.token;
    if (typeof record.replaces !== "string" || !/^[0-9a-f]{64}$/u.test(record.replaces)) return "malformed";
    if (typeof token !== "object" || token === null || Array.isArray(token)) return "malformed";
    const t = token as Record<string, unknown>;
    if (typeof t.access_token !== "string" || t.access_token.length === 0) return "malformed";
    if (typeof t.refresh_token !== "string" || t.refresh_token.length === 0) return "malformed";
    if (typeof t.expires_at !== "number" || typeof t.expires_in !== "number") return "malformed";
    return {
      replaces: record.replaces,
      // A pending file without the time (none was ever written in production:
      // the refresh is gated off) is never used to undo a tombstone.
      rotatedAtMs: typeof record.rotatedAtMs === "number" ? record.rotatedAtMs : 0,
      token: {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: t.expires_at,
        expires_in: t.expires_in,
        scope: typeof t.scope === "string" ? t.scope : "",
        token_type: typeof t.token_type === "string" ? t.token_type : "Bearer",
      },
    };
  } catch {
    return "malformed";
  }
}

function discardKimiPendingRotation(credentialPath: string): void {
  pendingRotationsInMemory.delete(credentialPath);
  try { unlinkSync(kimiPendingRotationPath(credentialPath)); } catch { /* already gone */ }
}

/**
 * The refresh token is only ever sent over https. A loopback http host
 * is accepted only through the test seam.
 */
export function isAllowedKimiOAuthHost(oauthHost: string, allowLoopbackHttp = false): boolean {
  let url: URL;
  try {
    url = new URL(oauthHost);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return allowLoopbackHttp && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function needsRefresh(token: KimiStoredToken, nowSeconds: number): boolean {
  if (token.expires_at === 0) return false;
  return token.expires_at - nowSeconds < kimiRefreshThresholdSeconds(token.expires_in);
}

type RefreshOutcome =
  | { kind: "ok"; token: KimiStoredToken }
  | { kind: "unauthorized" }
  | { kind: "network" }
  | { kind: "server" }
  | { kind: "rotation_missing" }
  | { kind: "malformed_response" };

/**
 * A 200 that is not a usable token is never written: a non-empty string
 * access_token is required first (an empty one would have put the client's
 * tombstone shape on disk and signed the user out — review on #9802); then
 * rotation (a non-empty refresh_token and a positive expires_in).
 */
export function parseKimiRefreshResponse(data: Record<string, unknown>, nowSeconds: number): RefreshOutcome {
  const accessToken = data.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return { kind: "malformed_response" };
  const refreshed = data.refresh_token;
  const expiresIn = Number(data.expires_in);
  if (typeof refreshed !== "string" || refreshed.length === 0 || !Number.isFinite(expiresIn) || expiresIn <= 0) return { kind: "rotation_missing" };
  return {
    kind: "ok",
    token: {
      access_token: accessToken,
      refresh_token: refreshed,
      expires_at: nowSeconds + expiresIn,
      expires_in: expiresIn,
      scope: typeof data.scope === "string" ? data.scope : "",
      token_type: typeof data.token_type === "string" ? data.token_type : "Bearer",
    },
  };
}

async function requestRefresh(auth: KimiCodeAuth, refreshToken: string, deps: KimiRefreshDeps): Promise<RefreshOutcome> {
  const fetchFn = deps.fetchFn ?? ((input: string | URL | Request, init?: RequestInit) => daemonFetch(input, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = deps.maxRetries ?? 3;
  const backoff = deps.backoffMs ?? ((attempt: number) => 2 ** attempt * 1_000);
  const url = `${auth.oauthHost.replace(/\/$/, "")}/api/oauth/token`;
  const headers = {
    ...kimiDeviceHeaders(auth.home, deps.identity ?? { platform: "raft_computer", version: "unknown" }),
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  const body = new URLSearchParams({ client_id: KIMI_CODE_OAUTH_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }).toString();
  let last: RefreshOutcome = { kind: "network" };
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    let status: number;
    let data: Record<string, unknown> = {};
    try {
      // Never follow a redirect: a 307/308 would resend the body,
      // refresh_token included, to wherever it points (the https check above
      // covers only the first hop).
      const response = await fetchFn(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000) });
      status = response.status;
      try {
        const parsed: unknown = await response.json();
        if (typeof parsed === "object" && parsed !== null) data = parsed as Record<string, unknown>;
      } catch { /* non-JSON body */ }
    } catch {
      last = { kind: "network" };
      if (attempt < maxRetries - 1) { await sleep(backoff(attempt)); continue; }
      return last;
    }
    if (status === 200) return parseKimiRefreshResponse(data, Math.floor((deps.now ?? Date.now)() / 1_000));
    const errorCode = typeof data.error === "string" ? data.error : "";
    if (status === 401 || status === 403 || errorCode === "invalid_grant") return { kind: "unauthorized" };
    if (RETRYABLE_STATUSES.has(status)) {
      last = { kind: "server" };
      if (attempt < maxRetries - 1) { await sleep(backoff(attempt)); continue; }
      return last;
    }
    return { kind: "server" };
  }
  return last;
}

/**
 * Ensures the stored access token is fresh enough for a probe. Never throws;
 * every outcome is a `KimiFreshness` the collector maps onto the wire.
 */
export async function ensureFreshKimiToken(auth: KimiCodeAuth, deps: KimiRefreshDeps = {}): Promise<KimiFreshness> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? ambientProcessEnv();
  const now = () => Math.floor((deps.now ?? Date.now)() / 1_000);
  if (auth.storage !== "file") return { kind: "platform_unsupported", reason: "storage_not_file" };
  if (platform === "win32") return { kind: "platform_unsupported", reason: "win32" };
  if (env.KIMI_DISABLE_OAUTH_LOCK === "1") return { kind: "platform_unsupported", reason: "lock_disabled" };
  if (!isAllowedKimiOAuthHost(auth.oauthHost, deps.allowLoopbackHttp)) return { kind: "platform_unsupported", reason: "insecure_oauth_host" };

  const initial = readKimiStoredToken(auth.credentialPath);
  // A pending rotation is settled under the lock even when the file's
  // own token looks fresh: its refresh token may already be dead.
  const pendingExists = hasKimiPendingRotation(auth.credentialPath);
  if (!pendingExists) {
    if (initial.kind === "missing") return { kind: "missing", reason: initial.reason };
    if (initial.kind === "revoked") return { kind: "revoked" };
    if (!needsRefresh(initial.token, now())) return { kind: "fresh", expiresAt: initial.token.expires_at };
    if (initial.token.refresh_token.length === 0) return { kind: "missing", reason: "no_refresh_token" };
  }
  const expiredBefore = initial.kind === "ok" ? initial.token.expires_at <= now() : true;

  const locked = await withKimiRefreshLock(auth.lockTarget, async (lock): Promise<KimiFreshness> => {
    const afterLock = readKimiStoredToken(auth.credentialPath);
    const pending = readKimiPendingRotation(auth.credentialPath);
    if (pending !== null) {
      // Only the exact token the rotation replaced may be overwritten; any
      // other content was written after it (login, logout, another rotation).
      // A file that cannot be read right now (the client's login/logout
      // write without the lock) says nothing yet: the rotation stays pending
      // for the next run (review on #10253).
      const unreadableNow = afterLock.kind === "missing" && afterLock.reason !== "no_file";
      if (pending !== "malformed" && unreadableNow) return { kind: "missing", reason: afterLock.reason };
      // The client's tombstone written after the rotation went out: it was
      // signed out by the refresh token the rotation used up, so the pending
      // token goes in. A deleted file (logout) or another token (login,
      // another rotation) still wins.
      const replacedOrSignedOutByUs = pending !== "malformed" && (
        (afterLock.kind === "ok" && refreshTokenDigest(afterLock.token.refresh_token) === pending.replaces)
        || (afterLock.kind === "revoked" && isTombstoneFromOurRotation(auth.credentialPath, pending.rotatedAtMs))
      );
      if (pending === "malformed" || !replacedOrSignedOutByUs) {
        discardKimiPendingRotation(auth.credentialPath);
      } else {
        if (lock.isCompromised()) return { kind: "transient", reason: "lock_compromised", expired: expiredBefore };
        try {
          writeKimiStoredToken(auth.credentialPath, pending.token);
        } catch {
          return { kind: "transient", reason: "write_failed", expired: expiredBefore };
        }
        discardKimiPendingRotation(auth.credentialPath);
        if (afterLock.kind === "revoked") restoredOverTombstone.set(auth.credentialPath, refreshTokenDigest(pending.token.refresh_token));
        if (!needsRefresh(pending.token, now())) return { kind: "adopted", expiresAt: pending.token.expires_at };
      }
    }
    const current = pending === null ? afterLock : readKimiStoredToken(auth.credentialPath);
    if (current.kind === "revoked") return { kind: "revoked" };
    if (current.kind === "missing") return { kind: "missing", reason: current.reason };
    const active = current.token;
    if (!needsRefresh(active, now())) return { kind: "adopted", expiresAt: active.expires_at };
    if (active.refresh_token.length === 0) return { kind: "missing", reason: "no_refresh_token" };
    // A lock that is already lost must not lead to a request whose
    // rotated token this run could then not write.
    await deps.beforeRequest?.();
    if (lock.isCompromised()) return { kind: "transient", reason: "lock_compromised", expired: expiredBefore };

    const rotatedAtMs = Date.now();
    const outcome = await requestRefresh(auth, active.refresh_token, deps);
    if (outcome.kind === "ok") {
      // The last in-lock comparison: a writer that does not take the lock (the
      // client's login/logout) may have replaced the file meanwhile; its token
      // is kept and ours is dropped. (The window between this read and the
      // rename below remains; see the expected-failure test.)
      const beforeWrite = readKimiStoredToken(auth.credentialPath);
      // Another token: a login or another writer's rotation wins.
      if (beforeWrite.kind === "ok" && beforeWrite.token.refresh_token !== active.refresh_token) {
        return { kind: "adopted", expiresAt: beforeWrite.token.expires_at };
      }
      // The file is gone: the user logged out meanwhile.
      if (beforeWrite.kind === "missing" && beforeWrite.reason === "no_file") return { kind: "missing", reason: "no_file" };
      // Cannot be read right now: the replaced refresh token is used
      // up, so the rotation is kept for the next locked run, never dropped.
      if (beforeWrite.kind === "missing") {
        writeKimiPendingRotation(auth.credentialPath, active.refresh_token, outcome.token, rotatedAtMs);
        return { kind: "missing", reason: beforeWrite.reason };
      }
      // beforeWrite is the replaced token, or the client's tombstone written
      // because its own refresh with the used-up token was rejected:
      // either way our rotated token is the one that keeps the user signed in.
      await deps.beforeWrite?.();
      // A lock that was reclaimed or removed while we worked no longer
      // protects this write: do not race the new holder. The rotation is kept
      // as a pending file for the next locked run.
      if (lock.isCompromised()) {
        writeKimiPendingRotation(auth.credentialPath, active.refresh_token, outcome.token, rotatedAtMs);
        return { kind: "transient", reason: "lock_compromised", expired: expiredBefore };
      }
      try {
        writeKimiStoredToken(auth.credentialPath, outcome.token);
      } catch {
        writeKimiPendingRotation(auth.credentialPath, active.refresh_token, outcome.token, rotatedAtMs);
        return { kind: "transient", reason: "write_failed", expired: expiredBefore };
      }
      if (beforeWrite.kind === "revoked") restoredOverTombstone.set(auth.credentialPath, refreshTokenDigest(outcome.token.refresh_token));
      else restoredOverTombstone.delete(auth.credentialPath);
      return { kind: "refreshed", expiresAt: outcome.token.expires_at };
    }
    if (outcome.kind === "unauthorized") {
      await (deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(100);
      const recovery = readKimiStoredToken(auth.credentialPath);
      if (recovery.kind === "ok" && recovery.token.refresh_token !== active.refresh_token) {
        return { kind: "adopted", expiresAt: recovery.token.expires_at };
      }
      // The client would write its revoked tombstone here; this daemon reports
      // and leaves the file alone, except for a token it put back over the
      // client's tombstone itself: that tombstone goes back (the grant is
      // revoked) and the restore is not repeated.
      if (restoredOverTombstone.get(auth.credentialPath) === refreshTokenDigest(active.refresh_token)) {
        restoredOverTombstone.delete(auth.credentialPath);
        if (!lock.isCompromised()) {
          try { writeKimiStoredToken(auth.credentialPath, kimiTombstoneOf(active)); } catch { /* the client writes it on its own next refresh */ }
        }
      }
      return { kind: "rejected", reason: "refresh_rejected" };
    }
    return { kind: "transient", reason: outcome.kind, expired: expiredBefore };
  }, deps.lock);

  if (locked.kind === "unavailable") {
    // Without the lock a pending rotation stays pending; the file's own state is reported as it would have been.
    if (initial.kind === "revoked") return { kind: "revoked" };
    if (initial.kind === "missing") return { kind: "missing", reason: initial.reason };
    return { kind: "transient", reason: "lock_unavailable", expired: expiredBefore };
  }
  return locked.value;
}
