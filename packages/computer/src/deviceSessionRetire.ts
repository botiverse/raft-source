/**
 * Device-auth design v2 §4 step 2: a Computer that already holds its own
 * `sk_computer_*` keys retires the device session it once logged in with, so
 * nothing left on the machine still acts for the person.
 *
 * Runs in the background of a service start (never awaited by it): one try a
 * short while after the start, and one more later when the first was cut short
 * by something passing (network, 5xx, 429, a busy lock, a timeout). Nothing
 * loops.
 *
 * `POST /api/computer/retire-session` (server routes/computerRetireSession.ts)
 * takes the session's access token AND one of this machine's keys whose
 * `key_issued_by_session_family_id` is that session's family (or, for a key
 * that records no issuer, one the session's person attached). The server
 * checks the token's signature only, so the token is sent as the file has it,
 * expired or not: this never refreshes (a refresh would rotate the refresh
 * token, which for a web session an older Desktop copied in is the app's own).
 * The family is not known here, so the keys for the session's own server are
 * offered one at a time until one is accepted; a key from another family is
 * refused (403) and the next is tried.
 *
 * What happens to `computer/user-session.json`:
 * - retired (or already retired), revoked (409 `session_revoked`), not a
 *   device login at all (409 `session_not_device`: a full web session an older
 *   Desktop copied in), or the token itself refused (401 `auth_required`: the
 *   server can't verify it (another signing secret, no family, not an access
 *   token) or its session or account is gone; expiry is not checked, so it
 *   can never be accepted again): deleted locally. None of those is of use
 *   here, and nothing on disk depends on it (setup and adopt-legacy log in
 *   again when there is no session).
 * - every key refused (403 `computer_key_family_mismatch`: a device login,
 *   but none of this machine's keys came from it, e.g. a key whose issuer is
 *   another session): the session logs itself out (`POST /api/auth/logout`
 *   with its own refresh token, which needs no key), then the file is deleted
 *   whether or not that worked. Kept, it was a long-lived credential every
 *   process of this OS user (every agent on the machine) could read, retried
 *   at every start and never retirable (#proj-runtime:#47). An unrevoked
 *   session left on the server expires there on its own.
 * - no retire endpoint (older server) or any other answer, and a passing
 *   failure on the last attempt: deleted locally, no logout (the server never
 *   said it is a device login, and a web session an older Desktop copied in
 *   is the app's own).
 * - a passing failure on the first attempt: kept and tried once more later.
 * - the service stopping, a busy lock, a file that changed, or an error here:
 *   kept for the next start.
 * Only 409 `session_not_device` and the 403 above tell the session's kind:
 * a web session never gets the 403 (the server answers 409 before it compares
 * keys), so a logout never signs out a Desktop.
 *
 * An attempt holds the Computer mutation lock from its first request to the
 * delete (fail fast when busy, bounded by a time budget), so it never runs
 * beside `attach`/`setup`. `login` and Desktop write the file without that
 * lock, so the delete is conditional on the file still being byte for byte
 * the one this run read: a login that rewrote it meanwhile is never deleted.
 *
 * Neither the access token nor a key is ever logged, and both go only to the
 * session's own server (keys attached to another server origin are not sent),
 * never through a redirect.
 */
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withComputerMutationLock } from "./concurrency";
import { computerDir, userSessionPath } from "./paths";
import { computerFetch } from "./proxy";
import { listAttachedServerIds, readServerAttachment } from "./serverState";
import { canonicalizeServerUrl, resolveServerUrl, resolveServerUrlEnv } from "./serverUrl";

export const RETIRE_SESSION_PATH = "/api/computer/retire-session";
export const COMPUTER_KEY_HEADER = "X-Raft-Computer-Key";

/** Fixed reason codes, one per outcome (the only thing logged besides counts and an HTTP status). */
export type DeviceSessionRetireReason =
  /** No user-session.json: nothing to do (not logged). */
  | "no_session"
  /** The file is not a readable user session: left alone. */
  | "session_invalid"
  /** No attached key for the session's server: left (nothing to prove with). */
  | "no_attached_key"
  /** Retired now: file deleted. */
  | "retired"
  /** The server already had it retired: file deleted. */
  | "already_retired"
  /** 409 session_revoked: the session was revoked (its keys with it): file deleted. */
  | "session_revoked"
  /** 409 session_not_device: a full web session (an older Desktop's copy): local file deleted. */
  | "session_not_device"
  /** Every key was refused (not issued by this session): logged out when it is a device login, file deleted. */
  | "no_matching_key"
  /** 401 auth_required: the token can never be used again (not even to retire): file deleted, nothing retried. */
  | "session_token_rejected"
  /** The server has no retire endpoint (older server): file deleted, no logout. */
  | "endpoint_unavailable"
  /** 429: file kept and retried later; deleted on the last attempt. */
  | "rate_limited"
  /** 5xx from the retire endpoint: file kept and retried later; deleted on the last attempt. */
  | "server_error"
  /** The server was not reached: file kept and retried later; deleted on the last attempt. */
  | "network_error"
  /** The attempt ran out of its time budget (it holds the mutation lock): kept and retried later; deleted on the last attempt. */
  | "timed_out"
  /** The file changed while this ran (a login), or went away: file kept. */
  | "session_changed"
  /** Another Computer command held the mutation lock: nothing sent, retried later. */
  | "lock_busy"
  /** The service is shutting down: stopped where it was, file kept. */
  | "cancelled"
  /** Any other answer (a redirect included): file deleted, no logout. */
  | "unexpected_response"
  /** A bug or a filesystem error here; never fails the service: file kept. */
  | "internal_error";

export interface DeviceSessionRetireOutcome {
  reason: DeviceSessionRetireReason;
  /** Whether user-session.json was deleted by this run. */
  deleted: boolean;
  /** Keys offered to the endpoint. */
  keysTried: number;
  /** The last HTTP status from the retire endpoint, if any. */
  httpStatus?: number;
  /** The session's own logout after every key was refused: whether the server took it. */
  logout?: "ok" | "failed";
}

const TRANSIENT_REASONS: ReadonlySet<DeviceSessionRetireReason> = new Set([
  "rate_limited",
  "server_error",
  "network_error",
  "timed_out",
  "lock_busy",
]);

export function isTransientRetireReason(reason: DeviceSessionRetireReason): boolean {
  return TRANSIENT_REASONS.has(reason);
}

export interface DeviceSessionRetireDeps {
  fetchFn?: typeof computerFetch;
  /** Run `fn` holding the Computer mutation lock; throws if it is busy. */
  withLock?: <T>(slockHome: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  /** Per request. */
  requestTimeoutMs?: number;
  /** The whole attempt while it holds the mutation lock. */
  attemptBudgetMs?: number;
  /** Aborts the attempt (the service is shutting down). */
  signal?: AbortSignal;
  /** No retry follows: a passing failure deletes the file too. */
  lastAttempt?: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 2_500;
// The logout after every key was refused may run a little past the attempt
// budget (the key requests may have used it up): at most what is left of the
// budget plus this, and never more than LOGOUT_TIMEOUT_MS, so the whole locked
// attempt stays under the ~5.6 s a CLI command waits for the lock.
const LOGOUT_TIMEOUT_MS = 1_500;
const LOGOUT_GRACE_MS = 500;
const LOGOUT_MIN_TIMEOUT_MS = 100;
export const LOGOUT_PATH = "/api/auth/logout";
// CLI commands wait ~5.6 s for the mutation lock (concurrency.ts): the whole
// locked attempt stays well under that, so a command started meanwhile waits
// instead of failing. Wrong-key answers are fast, so several keys still fit.
const DEFAULT_ATTEMPT_BUDGET_MS = 4_000;
const LOCK_WAIT_MS = 1_000;

interface SessionSnapshot {
  raw: string;
  accessToken: string;
  refreshToken?: string;
  serverUrl?: string;
}

async function readSnapshot(slockHome: string): Promise<SessionSnapshot | "missing" | "invalid"> {
  let raw: string;
  try {
    raw = await readFile(userSessionPath(slockHome), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "invalid";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "invalid";
  const session = parsed as Record<string, unknown>;
  if (session.kind !== "user-session" || typeof session.accessToken !== "string" || session.accessToken.length === 0) {
    return "invalid";
  }
  return {
    raw,
    accessToken: session.accessToken,
    ...(typeof session.refreshToken === "string" && session.refreshToken.length > 0 ? { refreshToken: session.refreshToken } : {}),
    ...(typeof session.serverUrl === "string" && session.serverUrl.trim() ? { serverUrl: session.serverUrl } : {}),
  };
}

function sessionBaseUrl(snapshot: SessionSnapshot): string {
  return resolveServerUrl(snapshot.serverUrl, resolveServerUrlEnv());
}

async function defaultWithLock<T>(slockHome: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return withComputerMutationLock(slockHome, fn, { waitMs: LOCK_WAIT_MS });
}

/** Delete user-session.json only if it is still byte for byte the file this run used (caller holds the lock). */
async function deleteIfUnchanged(slockHome: string, expectedRaw: string): Promise<"deleted" | "changed"> {
  let current: string;
  try {
    current = await readFile(userSessionPath(slockHome), "utf8");
  } catch (err) {
    // Gone already (a logout meanwhile): not deleted by this run.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "changed";
    throw err;
  }
  if (current !== expectedRaw) return "changed";
  await rm(userSessionPath(slockHome));
  return "deleted";
}

async function attachedKeysFor(slockHome: string, baseUrl: string): Promise<string[]> {
  const keys: string[] = [];
  for (const serverId of await listAttachedServerIds(slockHome)) {
    const attachment = await readServerAttachment(slockHome, serverId).catch(() => null);
    if (!attachment || typeof attachment.apiKey !== "string" || !attachment.apiKey.startsWith("sk_computer_")) continue;
    // A key goes only to the server it belongs to.
    if (typeof attachment.serverUrl !== "string" || canonicalizeServerUrl(attachment.serverUrl) !== baseUrl) continue;
    if (!keys.includes(attachment.apiKey)) keys.push(attachment.apiKey);
  }
  return keys;
}

type RetireAnswer =
  | { kind: "delete"; reason: "retired" | "already_retired" | "session_revoked" | "session_not_device" | "session_token_rejected"; status: number }
  /** `deviceSession`: the 403 family mismatch, which only a device login gets. */
  | { kind: "wrong_key"; status: number; deviceSession: boolean }
  | { kind: "stop"; reason: DeviceSessionRetireReason; status?: number };

async function postRetire(
  fetchFn: typeof computerFetch,
  baseUrl: string,
  accessToken: string,
  key: string,
  timeoutMs: number,
  attemptSignal: AbortSignal,
  abortedReason: () => DeviceSessionRetireReason,
): Promise<RetireAnswer> {
  let res: Awaited<ReturnType<typeof computerFetch>>;
  try {
    res = await fetchFn(new URL(RETIRE_SESSION_PATH, baseUrl).toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        [COMPUTER_KEY_HEADER]: key,
      },
      // Never carry the key (a custom header survives a cross-origin
      // redirect) anywhere but this endpoint.
      redirect: "manual",
      signal: AbortSignal.any([attemptSignal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch {
    return { kind: "stop", reason: attemptSignal.aborted ? abortedReason() : "network_error" };
  }
  const status = res.status;
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const code = typeof body?.code === "string" ? body.code : null;
  if (status === 200 && body?.ok === true) {
    return { kind: "delete", reason: body.alreadyRetired === true ? "already_retired" : "retired", status };
  }
  if (status === 409 && code === "session_revoked") return { kind: "delete", reason: "session_revoked", status };
  if (status === 409 && code === "session_not_device") return { kind: "delete", reason: "session_not_device", status };
  if (status === 403 && code === "computer_key_family_mismatch") return { kind: "wrong_key", status, deviceSession: true };
  if (status === 401 && (code === "computer_key_invalid" || code === "computer_key_required")) return { kind: "wrong_key", status, deviceSession: false };
  if (status === 401 && code === "auth_required") return { kind: "delete", reason: "session_token_rejected", status };
  if (status === 404 || status === 405) return { kind: "stop", reason: "endpoint_unavailable", status };
  if (status === 429) return { kind: "stop", reason: "rate_limited", status };
  if (status >= 500) return { kind: "stop", reason: "server_error", status };
  return { kind: "stop", reason: "unexpected_response", status };
}

/** The logout's timeout: what is left of the attempt budget plus a little, within [100 ms, 1.5 s]. */
export function logoutTimeoutMs(budgetEndsAtMs: number, nowMs: number): number {
  return Math.max(LOGOUT_MIN_TIMEOUT_MS, Math.min(LOGOUT_TIMEOUT_MS, budgetEndsAtMs - nowMs + LOGOUT_GRACE_MS));
}

/** The session logs itself out with its own refresh token (no key needed). Never throws. */
async function postLogout(
  fetchFn: typeof computerFetch,
  baseUrl: string,
  refreshToken: string,
  lockSignal: AbortSignal,
  timeoutMs: number,
): Promise<"ok" | "failed"> {
  try {
    const res = await fetchFn(new URL(LOGOUT_PATH, baseUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      redirect: "manual",
      signal: AbortSignal.any([lockSignal, AbortSignal.timeout(timeoutMs)]),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return res.status === 200 && body?.ok === true ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

/** Answers after which the file goes without a logout: the server never said what kind of session it is. */
const DROP_WITHOUT_LOGOUT: ReadonlySet<DeviceSessionRetireReason> = new Set(["endpoint_unavailable", "unexpected_response"]);

/**
 * One retire attempt. Never throws. Holds the Computer mutation lock from the
 * first request to the delete, so it never runs beside `attach`/`setup` (which
 * use the session under the same lock); a busy lock skips the attempt.
 */
export async function retireOwnDeviceSession(
  slockHome: string,
  deps: DeviceSessionRetireDeps = {},
): Promise<DeviceSessionRetireOutcome> {
  let keysTried = 0;
  let httpStatus: number | undefined;
  let logout: "ok" | "failed" | undefined;
  const done = (reason: DeviceSessionRetireReason, deleted = false): DeviceSessionRetireOutcome => ({
    reason,
    deleted,
    keysTried,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(logout !== undefined ? { logout } : {}),
  });
  try {
    // The steady state after migration: no file, no lock taken. Outcomes that
    // send nothing are decided without the lock too (re-checked under it).
    const peek = await readSnapshot(slockHome);
    if (peek === "missing") return done("no_session");
    if (deps.signal?.aborted) return done("cancelled");
    if (peek === "invalid") return done("session_invalid");
    if ((await attachedKeysFor(slockHome, sessionBaseUrl(peek))).length === 0) return done("no_attached_key");

    const withLock = deps.withLock ?? defaultWithLock;
    let locked = false;
    try {
      return await withLock(slockHome, async (lockSignal) => {
        locked = true;
        return await attemptLocked(lockSignal);
      });
    } catch (err) {
      if (!locked && (err as { code?: string }).code === "CONCURRENT_OPERATION") return done("lock_busy");
      return done("internal_error");
    }
  } catch {
    return done("internal_error");
  }

  async function attemptLocked(lockSignal: AbortSignal): Promise<DeviceSessionRetireOutcome> {
    const fetchFn = deps.fetchFn ?? computerFetch;
    const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const budgetMs = deps.attemptBudgetMs ?? DEFAULT_ATTEMPT_BUDGET_MS;
    const budgetEndsAt = Date.now() + budgetMs;
    const budget = AbortSignal.timeout(budgetMs);
    const attemptSignal = AbortSignal.any([lockSignal, budget, ...(deps.signal ? [deps.signal] : [])]);
    const abortedReason = (): DeviceSessionRetireReason =>
      deps.signal?.aborted ? "cancelled" : budget.aborted ? "timed_out" : "internal_error";

    const snapshot = await readSnapshot(slockHome);
    if (snapshot === "missing") return done("no_session");
    if (snapshot === "invalid") return done("session_invalid");
    const baseUrl = sessionBaseUrl(snapshot);
    const keys = await attachedKeysFor(slockHome, baseUrl);
    if (keys.length === 0) return done("no_attached_key");

    // Deletes the file this run read; the server-side outcome stands even if
    // the service is stopping, only a lost lock stops the local delete.
    const drop = async (reason: DeviceSessionRetireReason): Promise<DeviceSessionRetireOutcome> => {
      if (lockSignal.aborted) return done("internal_error");
      return (await deleteIfUnchanged(slockHome, snapshot.raw)) === "deleted"
        ? done(reason, true)
        : done("session_changed");
    };

    let deviceSession = false;
    for (const key of keys) {
      if (attemptSignal.aborted) {
        const reason = abortedReason();
        return reason === "timed_out" && deps.lastAttempt ? drop(reason) : done(reason);
      }
      keysTried += 1;
      const answer = await postRetire(fetchFn, baseUrl, snapshot.accessToken, key, timeoutMs, attemptSignal, abortedReason);
      if (answer.status !== undefined) httpStatus = answer.status;
      if (answer.kind === "wrong_key") {
        deviceSession ||= answer.deviceSession;
        continue;
      }
      if (answer.kind === "stop") {
        if (DROP_WITHOUT_LOGOUT.has(answer.reason)) return drop(answer.reason);
        if (isTransientRetireReason(answer.reason) && deps.lastAttempt) return drop(answer.reason);
        return done(answer.reason);
      }
      return drop(answer.reason);
    }
    // Every key refused. A device login logs itself out first; either way the
    // file goes (a credential nothing here can retire is only a liability).
    // The service stopping: keep it, the next start logs it out and deletes it
    // (deleting now would leave the server-side session unrevoked for nothing).
    if (deps.signal?.aborted) return done("cancelled");
    if (deviceSession && snapshot.refreshToken) {
      logout = await postLogout(fetchFn, baseUrl, snapshot.refreshToken, lockSignal, logoutTimeoutMs(budgetEndsAt, Date.now()));
    }
    return drop("no_matching_key");
  }
}

function formatOutcome(outcome: DeviceSessionRetireOutcome, attempt: number): string {
  const parts = [
    `attempt ${attempt}`,
    `keys tried ${outcome.keysTried}`,
    ...(outcome.httpStatus !== undefined ? [`http ${outcome.httpStatus}`] : []),
    ...(outcome.logout !== undefined ? [`logout ${outcome.logout}`] : []),
    outcome.deleted ? "user-session.json deleted" : "user-session.json kept",
  ];
  return `Service startup: device session retire: ${outcome.reason} (${parts.join(", ")}).\n`;
}

export interface DeviceSessionRetireSchedule {
  /** Settles with every attempt's outcome once no more attempts are planned. */
  readonly done: Promise<DeviceSessionRetireOutcome[]>;
  cancel(): void;
}

export interface ScheduleDeviceSessionRetireOptions extends DeviceSessionRetireDeps {
  /** Wait this long after the service start before the first attempt. */
  initialDelayMs?: number;
  /** Wait this long before the one retry after a transient failure. */
  retryDelayMs?: number;
  log?: (line: string) => void;
  attemptFn?: typeof retireOwnDeviceSession;
  /** Hands the start's last outcome to a runner to report (default: the report file). */
  report?: (report: DeviceSessionRetireReport) => Promise<void>;
}

const DEFAULT_INITIAL_DELAY_MS = 20_000;
const DEFAULT_RETRY_DELAY_MS = 10 * 60_000;

/**
 * Start the background retire for this service start and return at once.
 * Timers are unref'd, nothing is awaited by the caller, and nothing throws.
 * `cancel()` (service shutdown) clears a pending attempt and aborts one in
 * flight.
 * A "no_session" outcome logs nothing (the steady state after migration).
 */
export function scheduleDeviceSessionRetire(
  slockHome: string,
  options: ScheduleDeviceSessionRetireOptions = {},
): DeviceSessionRetireSchedule {
  const log = options.log ?? ((line: string) => { process.stderr.write(line); });
  const attemptFn = options.attemptFn ?? retireOwnDeviceSession;
  const outcomes: DeviceSessionRetireOutcome[] = [];
  const abort = new AbortController();
  let cancelled = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveDone!: (value: DeviceSessionRetireOutcome[]) => void;
  const done = new Promise<DeviceSessionRetireOutcome[]>((resolve) => { resolveDone = resolve; });

  const later = (delayMs: number, attempt: number): void => {
    timer = setTimeout(() => {
      timer = null;
      void run(attempt);
    }, Math.max(0, delayMs));
    timer.unref?.();
  };
  const run = async (attempt: number): Promise<void> => {
    if (cancelled) return resolveDone(outcomes);
    let outcome: DeviceSessionRetireOutcome;
    try {
      outcome = await attemptFn(slockHome, { ...options, signal: abort.signal, lastAttempt: attempt === 2 });
    } catch {
      outcome = { reason: "internal_error", deleted: false, keysTried: 0 };
    }
    outcomes.push(outcome);
    if (outcome.reason !== "no_session") {
      try { log(formatOutcome(outcome, attempt)); } catch { /* logging never fails the service */ }
    }
    if (attempt === 1 && isTransientRetireReason(outcome.reason) && !cancelled) {
      later(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, 2);
      return;
    }
    if (outcome.reason !== "no_session") {
      try {
        await (options.report ?? ((r) => writeDeviceSessionRetireReport(slockHome, r)))({ ...outcome, attempt });
      } catch { /* reporting never fails the service */ }
    }
    resolveDone(outcomes);
  };
  later(options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS, 1);
  return {
    done,
    cancel: () => {
      cancelled = true;
      // An attempt in flight stops at its next step.
      abort.abort();
      if (timer) {
        clearTimeout(timer);
        timer = null;
        resolveDone(outcomes);
      }
    },
  };
}

/** What a start's retire ended with, for a runner to report once (`daemon.computer.device_session_retire`). */
export interface DeviceSessionRetireReport extends DeviceSessionRetireOutcome {
  attempt: number;
}

export function deviceSessionRetireReportPath(slockHome: string): string {
  return join(computerDir(slockHome), "device-session-retire-report.json");
}

/** Codes and counts only: no token, key, id or URL. */
export async function writeDeviceSessionRetireReport(slockHome: string, report: DeviceSessionRetireReport): Promise<void> {
  const file = deviceSessionRetireReportPath(slockHome);
  const tmp = `${file}.${process.pid}.tmp`;
  const body: DeviceSessionRetireReport = {
    reason: report.reason,
    deleted: report.deleted,
    keysTried: report.keysTried,
    attempt: report.attempt,
    ...(report.httpStatus !== undefined ? { httpStatus: report.httpStatus } : {}),
    ...(report.logout !== undefined ? { logout: report.logout } : {}),
  };
  await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * The report not yet sent, claimed for this caller: the first runner to ask
 * takes it (a rename, so two runners never both send it), and it is gone
 * after. Null when there is none or it is unreadable.
 */
export async function claimDeviceSessionRetireReport(slockHome: string): Promise<DeviceSessionRetireReport | null> {
  const file = deviceSessionRetireReportPath(slockHome);
  const claimed = `${file}.${process.pid}.${Date.now()}.claimed`;
  try {
    await rename(file, claimed);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(claimed, "utf8")) as Partial<DeviceSessionRetireReport> | null;
    if (!parsed || typeof parsed.reason !== "string" || typeof parsed.deleted !== "boolean") return null;
    return {
      reason: parsed.reason,
      deleted: parsed.deleted,
      keysTried: typeof parsed.keysTried === "number" ? parsed.keysTried : 0,
      attempt: typeof parsed.attempt === "number" ? parsed.attempt : 1,
      ...(typeof parsed.httpStatus === "number" ? { httpStatus: parsed.httpStatus } : {}),
      ...(parsed.logout === "ok" || parsed.logout === "failed" ? { logout: parsed.logout } : {}),
    };
  } catch {
    return null;
  } finally {
    await rm(claimed, { force: true }).catch(() => undefined);
  }
}
