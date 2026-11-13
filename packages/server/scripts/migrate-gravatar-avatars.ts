#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * One-time migration: copy each person's Gravatar into Raft's own avatar
 * storage, so the Gravatar code can later be deleted without anyone's avatar
 * changing (tygg, #triage:0cfdc93b / #triage:#238). Step 1 of that plan; it
 * changes no runtime code.
 *
 * Today the web (`GravatarAvatar`, packages/web/src/components/member) shows
 * `users.avatar_url` only when it is a stored user avatar
 * (`/avatars/users/<hex>.webp`, `isRaftUploadedHumanAvatarUrl`); otherwise it
 * loads `https://www.gravatar.com/avatar/<sha256(lower(trim(email)))>?d=404`
 * and shows the User icon on a 404. A candidate is a non-retired user for whom
 * the web falls to Gravatar: `avatar_url` NULL or empty (group `empty`), or set
 * but not a stored user avatar (group `old_link`, e.g. an old social-provider
 * URL the web ignores). `rendersStoredAvatar` ports the web predicate; the test
 * checks it against the web's own function.
 *
 * Per candidate (rate limited to --rps, default 5):
 *   GET https://www.gravatar.com/avatar/<hash>?d=404&s=256 with a timeout.
 *   - 200: bounded read (the upload limit), stored through the upload pipeline
 *     (`storeUserAvatar`: 256 cover, WebP q85, content-addressed key), then
 *     `UPDATE users SET avatar_url = <new> WHERE id = <id> AND retired_at IS NULL
 *      AND avatar_url IS NOT DISTINCT FROM <observed>`. If that UPDATE matches
 *     nothing (the person changed their avatar meanwhile, or was retired), the
 *     stored object is deleted unless someone shows it
 *     (`deleteStoredUserAvatarIfUnused`).
 *   - 404: no Gravatar; the row is left as it is (the web keeps the User icon).
 *   - 429, 5xx, a timeout or a network error: counted as an error, never as a
 *     404, and the next request waits (exponential backoff, or Retry-After).
 *     Other statuses, an oversized or undecodable image, and a failed store are
 *     errors too. --max-consecutive-errors in a row stop the walk.
 * Nothing is broadcast: the image the person sees is the same. The users
 * change_log trigger still records each changed row, as for any profile edit.
 * Errors and misses stay candidates, so a later run retries them; a migrated
 * user no longer matches, so re-running is safe.
 *
 * The walk goes over users by id in fixed slices (`id > <last> ORDER BY id
 * LIMIT --batch`), one autocommit UPDATE per migrated user.
 *
 * Usage (defaults to a dry-run: the same walk and Gravatar requests, no store,
 * no write):
 *   GRAVATAR_AVATARS_READ_DATABASE_URL=... pnpm --filter @botiverse/raft-server ops:migrate-gravatar-avatars -- \
 *     --environment production [--no-fetch] [--rps 5]
 *   GRAVATAR_AVATARS_WRITE_DATABASE_URL=... CDN_BASE_URL=... S3_CDN_BUCKET=... (CDN or main S3 credentials) \
 *     pnpm --filter @botiverse/raft-server ops:migrate-gravatar-avatars -- \
 *     --environment production --apply --approval-reference <Raft message link> --run-id <id> \
 *     [--batch 500] [--start-after <user id>] [--max-batches N] [--rps 5] [--timeout-ms 10000] [--max-consecutive-errors 20]
 * --no-fetch counts candidates only and never contacts Gravatar. No
 * DATABASE_URL fallback: a dry-run reads the READ url, --apply the WRITE url.
 * In production a dry-run refuses a primary (pg_is_in_recovery() must be true),
 * --apply refuses a replica, and --apply refuses unless the avatar storage is
 * the CDN bucket and every stored URL is under CDN_BASE_URL. Flags never grant
 * production authority; docs/operations/gravatar-avatar-migration.md says who
 * approves.
 *
 * Output: [GRAVATAR_AVATARS_START]; one [GRAVATAR_AVATARS_RECEIPT] per slice
 * (counts and id range); with --apply one [GRAVATAR_AVATARS_MIGRATED] per
 * changed user (old and new avatar_url) and [GRAVATAR_AVATARS_LOST_RACE] per
 * lost UPDATE; [GRAVATAR_AVATARS_ERROR] per error; at the end
 * [GRAVATAR_AVATARS_DONE] or [GRAVATAR_AVATARS_STOPPED] with
 * [GRAVATAR_AVATARS_RESUME], and [GRAVATAR_AVATARS_SUMMARY] (JSON). Ctrl-C
 * stops after the current user (exit 130).
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  deleteStoredUserAvatarIfUnused, PROFILE_AVATAR_TOO_LARGE_MESSAGE, readBoundedAvatarResponse, storeUserAvatar,
} from "../src/services/avatarService";
import { cdnStorageConnection } from "../src/services/storageService";

/** The subset of pg.Client / PGlite this script uses. */
export interface Queryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const TAG = "GRAVATAR_AVATARS";
export const GRAVATAR_AVATAR_BASE = "https://www.gravatar.com/avatar/";
export const GRAVATAR_SIZE = 256;
/** Upper bound of one backoff wait (also caps Retry-After). */
export const MAX_BACKOFF_MS = 300_000;
/** Error ids kept in the summary, at most. */
export const MAX_ERROR_IDS = 200;

// Port of packages/web/src/utils/humanAvatar.ts isRaftUploadedHumanAvatarUrl
// (the test compares the two). Note `[0-9a-f]+`: the web accepts any length,
// the server's isStoredUserAvatarUrl only 32.
const WEB_STORED_USER_AVATAR_PATH = /^\/(?:api\/)?avatars\/users\/[0-9a-f]+\.webp$/i;

/** The web shows this avatar_url instead of Gravatar. */
export function rendersStoredAvatar(avatarUrl: string | null | undefined): boolean {
  if (!avatarUrl) return false;
  if (WEB_STORED_USER_AVATAR_PATH.test(avatarUrl)) return true;
  try {
    return WEB_STORED_USER_AVATAR_PATH.test(new URL(avatarUrl).pathname);
  } catch {
    return false;
  }
}

export type CandidateGroup = "empty" | "oldLink";

/** Why the web falls to Gravatar for this avatar_url, or null when it shows the stored avatar. */
export function candidateGroup(avatarUrl: string | null): CandidateGroup | null {
  if (rendersStoredAvatar(avatarUrl)) return null;
  return avatarUrl === null || avatarUrl === "" ? "empty" : "oldLink";
}

/** The hash the server sends the web (sha256 of the trimmed, lower-cased email). */
export function gravatarHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export function gravatarUrl(hash: string): string {
  return `${GRAVATAR_AVATAR_BASE}${hash}?d=404&s=${GRAVATAR_SIZE}`;
}

export type ErrorReason =
  | "rate_limited" | "server_error" | "timeout" | "network" | "unexpected_status"
  | "too_large" | "store_failed" | "bad_url";

/** Errors that say Gravatar (or the way there) is struggling: the next request waits. */
const BACKOFF_REASONS = new Set<ErrorReason>(["rate_limited", "server_error", "timeout", "network"]);

type Probe =
  | { kind: "hit"; body: Buffer | null }
  | { kind: "miss" }
  | { kind: "error"; reason: ErrorReason; detail: string; retryAfterMs: number | null };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.min(Math.max(at - now, 0), MAX_BACKOFF_MS) : null;
}

/** One Gravatar request; with readBody the image is read (bounded) within the same timeout. */
async function probeGravatar(fetchImpl: FetchLike, hash: string, readBody: boolean, timeoutMs: number, now: number): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(gravatarUrl(hash), {
      headers: { Accept: "image/jpeg,image/png,image/gif,image/webp" },
      signal: controller.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404) return { kind: "miss" };
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), now);
      if (response.status === 429) return { kind: "error", reason: "rate_limited", detail: "429", retryAfterMs };
      if (response.status >= 500) return { kind: "error", reason: "server_error", detail: String(response.status), retryAfterMs };
      return { kind: "error", reason: "unexpected_status", detail: String(response.status), retryAfterMs: null };
    }
    if (!readBody) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "hit", body: null };
    }
    try {
      return { kind: "hit", body: await readBoundedAvatarResponse(response) };
    } catch (error) {
      if (controller.signal.aborted) throw error;
      if ((error as Error)?.message === PROFILE_AVATAR_TOO_LARGE_MESSAGE) {
        return { kind: "error", reason: "too_large", detail: (error as Error).message, retryAfterMs: null };
      }
      throw error;
    }
  } catch (error) {
    if (controller.signal.aborted) return { kind: "error", reason: "timeout", detail: `${timeoutMs}ms`, retryAfterMs: null };
    return { kind: "error", reason: "network", detail: (error as Error)?.message ?? String(error), retryAfterMs: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Spaces request starts 1/rps apart; a backoff pushes the next start out. */
class Pacer {
  private next = 0;
  constructor(private readonly intervalMs: number, private readonly deps: Pick<Deps, "now" | "sleep">) {}
  async wait(): Promise<void> {
    const now = this.deps.now();
    if (this.next > now) await this.deps.sleep(this.next - now);
    this.next = Math.max(now, this.next) + this.intervalMs;
  }
  defer(ms: number): void {
    this.next = Math.max(this.next, this.deps.now() + ms);
  }
}

export function backoffMs(streak: number, retryAfterMs: number | null): number {
  const exponential = Math.min(1000 * 2 ** Math.max(streak - 1, 0), 60_000);
  return Math.min(Math.max(exponential, retryAfterMs ?? 0), MAX_BACKOFF_MS);
}

/**
 * A live account or agent still shows the user avatar with this content hash:
 * avatarService.isUserAvatarHashStillShown on this script's connection.
 */
export async function hashStillShown(db: Queryable, contentHash: string): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(contentHash)) return true;
  const pattern = `%/avatars/users/${contentHash}.webp%`;
  const { rows: [row] } = await db.query<{ shown: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM users WHERE lower(avatar_url) LIKE $1 AND retired_at IS NULL)
       OR EXISTS (SELECT 1 FROM agents WHERE lower(avatar_url) LIKE $1 AND deleted_at IS NULL) AS shown`,
    [pattern],
  );
  return row?.shown !== false;
}

export interface Deps {
  fetch: FetchLike;
  /** The upload pipeline; returns the stored avatar's URL. */
  store(existingAvatarUrl: string | null, image: Buffer): Promise<string>;
  /** Deletes a stored user avatar no live account or agent shows; true when deleted. */
  deleteIfUnused(avatarUrl: string, db: Queryable): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const DEFAULT_DEPS: Deps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  store: storeUserAvatar,
  deleteIfUnused: (avatarUrl, db) => deleteStoredUserAvatarIfUnused(avatarUrl, (hash) => hashStillShown(db, hash)),
  sleep: (ms) => sleep(ms),
  now: () => Date.now(),
};

export interface Options {
  /** Store and update (--apply). */
  write: boolean;
  /** Contact Gravatar (false: --no-fetch, counts only). */
  fetch: boolean;
  runId: string | null;
  startAfter: string | null;
  batchSize: number;
  maxBatches: number | null;
  rps: number;
  timeoutMs: number;
  maxConsecutiveErrors: number;
  /** --apply in production: every stored URL must start with this (CDN_BASE_URL/avatars/users/). */
  expectedUrlPrefix: string | null;
  shouldStop: () => boolean;
  log: (line: string) => void;
}

export const DEFAULT_OPTIONS: Options = {
  write: false,
  fetch: true,
  runId: null,
  startAfter: null,
  batchSize: 500,
  maxBatches: null,
  rps: 5,
  timeoutMs: 10_000,
  maxConsecutiveErrors: 20,
  expectedUrlPrefix: null,
  shouldStop: () => false,
  log: (line) => console.log(line),
};

export interface Counts {
  scanned: number;
  retired: number;
  /** The web already shows their stored avatar: not candidates. */
  stored: number;
  /** Candidates without an email to hash (none expected: email is NOT NULL). */
  noEmail: number;
  candidatesEmpty: number;
  candidatesOldLink: number;
  hitsEmpty: number;
  hitsOldLink: number;
  misses: number;
  errors: number;
  /** --apply: avatar_url replaced. */
  migratedEmpty: number;
  migratedOldLink: number;
  /** --apply: the conditional UPDATE matched nothing; and of those, objects deleted. */
  lostRace: number;
  orphansDeleted: number;
}

function zeroCounts(): Counts {
  return {
    scanned: 0, retired: 0, stored: 0, noEmail: 0, candidatesEmpty: 0, candidatesOldLink: 0, hitsEmpty: 0, hitsOldLink: 0,
    misses: 0, errors: 0, migratedEmpty: 0, migratedOldLink: 0, lostRace: 0, orphansDeleted: 0,
  };
}

const GROUP_KEYS = {
  empty: { candidates: "candidatesEmpty", hits: "hitsEmpty", migrated: "migratedEmpty" },
  oldLink: { candidates: "candidatesOldLink", hits: "hitsOldLink", migrated: "migratedOldLink" },
} as const satisfies Record<CandidateGroup, Record<string, keyof Counts>>;

export interface RunResult {
  completed: boolean;
  stopReason: "max_batches" | "signal" | "consecutive_errors" | null;
  /** The last user processed. */
  lastId: string | null;
  /** Where to resume (--start-after); null: from the start. */
  resumeAfter: string | null;
  batches: number;
  counts: Counts;
  errorsByReason: Partial<Record<ErrorReason, number>>;
  /** Up to MAX_ERROR_IDS users whose request or store failed. */
  errorIds: string[];
  firstCandidateId: string | null;
  lastCandidateId: string | null;
}

interface UserRow {
  id: string;
  email: string | null;
  avatar_url: string | null;
  retired: boolean;
}

type Outcome = "skipped" | "hit" | "miss" | "error";

async function readSlice(db: Queryable, afterId: string | null, batchSize: number): Promise<UserRow[]> {
  const { rows } = await db.query<UserRow>(
    `SELECT id::text AS id, email, avatar_url, retired_at IS NOT NULL AS retired
     FROM users ${afterId === null ? "" : "WHERE id > $2::uuid"} ORDER BY id LIMIT $1`,
    afterId === null ? [batchSize] : [batchSize, afterId],
  );
  return rows;
}

/** Walks users by id in fixed slices from `startAfter`, migrating (or with a dry-run counting) each candidate. */
export async function run(db: Queryable, deps: Deps = DEFAULT_DEPS, options: Options = DEFAULT_OPTIONS): Promise<RunResult> {
  if (options.write && !options.runId) throw new Error("a write run needs a run id");
  if (options.write && !options.fetch) throw new Error("a write run fetches from Gravatar");
  if (!(options.rps > 0)) throw new Error("rps must be positive");
  const mode = options.write ? "apply" : options.fetch ? "dry-run" : "dry-run-no-fetch";
  const pacer = new Pacer(1000 / options.rps, deps);
  const counts = zeroCounts();
  const errorsByReason: Partial<Record<ErrorReason, number>> = {};
  const errorIds: string[] = [];
  let firstCandidateId: string | null = null;
  let lastCandidateId: string | null = null;
  let afterId = options.startAfter;
  let lastId = options.startAfter;
  let batches = 0;
  let completed = false;
  let stopReason: RunResult["stopReason"] = null;
  let streak = 0;
  let streakStartAfter: string | null = null;
  const started = deps.now();

  const fail = (slice: Counts, row: UserRow, reason: ErrorReason, detail: string): Outcome => {
    slice.errors += 1;
    errorsByReason[reason] = (errorsByReason[reason] ?? 0) + 1;
    if (errorIds.length < MAX_ERROR_IDS) errorIds.push(row.id);
    options.log(`[${TAG}_ERROR] user=${row.id} reason=${reason} detail=${JSON.stringify(detail)}`);
    return "error";
  };

  const processUser = async (row: UserRow, slice: Counts): Promise<Outcome> => {
    if (row.retired) {
      slice.retired += 1;
      return "skipped";
    }
    const group = candidateGroup(row.avatar_url);
    if (group === null) {
      slice.stored += 1;
      return "skipped";
    }
    const email = row.email?.trim();
    if (!email) {
      slice.noEmail += 1;
      return "skipped";
    }
    const keys = GROUP_KEYS[group];
    slice[keys.candidates] += 1;
    firstCandidateId ??= row.id;
    lastCandidateId = row.id;
    if (!options.fetch) return "skipped";

    await pacer.wait();
    const probe = await probeGravatar(deps.fetch, gravatarHash(email), options.write, options.timeoutMs, deps.now());
    if (probe.kind === "miss") {
      slice.misses += 1;
      return "miss";
    }
    if (probe.kind === "error") {
      if (BACKOFF_REASONS.has(probe.reason)) pacer.defer(backoffMs(streak + 1, probe.retryAfterMs));
      return fail(slice, row, probe.reason, probe.detail);
    }
    slice[keys.hits] += 1;
    if (!options.write || probe.body === null) return "hit";

    let avatarUrl: string;
    try {
      avatarUrl = await deps.store(row.avatar_url, probe.body);
    } catch (error) {
      return fail(slice, row, "store_failed", (error as Error)?.message ?? String(error));
    }
    if (!rendersStoredAvatar(avatarUrl) || (options.expectedUrlPrefix !== null && !avatarUrl.startsWith(options.expectedUrlPrefix))) {
      // Never write a URL the web would not show; the object is not referenced.
      await deps.deleteIfUnused(avatarUrl, db).catch(() => false);
      return fail(slice, row, "bad_url", avatarUrl);
    }
    const { rows: updated } = await db.query<{ id: string }>(
      `UPDATE users SET avatar_url = $1, updated_at = now()
       WHERE id = $2::uuid AND retired_at IS NULL AND avatar_url IS NOT DISTINCT FROM $3::text
       RETURNING id`,
      [avatarUrl, row.id, row.avatar_url],
    );
    if (updated.length === 1) {
      slice[keys.migrated] += 1;
      options.log(`[${TAG}_MIGRATED] run_id=${options.runId} user=${row.id} group=${group} old=${JSON.stringify(row.avatar_url)} new=${avatarUrl}`);
      return "hit";
    }
    // Changed (or retired) since it was read: keep their change, drop our object unless someone shows it.
    slice.lostRace += 1;
    const deleted = await deps.deleteIfUnused(avatarUrl, db).catch((error: unknown) => {
      options.log(`[${TAG}_ORPHAN_DELETE_FAILED] user=${row.id} url=${avatarUrl} detail=${JSON.stringify((error as Error)?.message ?? String(error))}`);
      return false;
    });
    if (deleted) slice.orphansDeleted += 1;
    options.log(`[${TAG}_LOST_RACE] run_id=${options.runId} user=${row.id} url=${avatarUrl} orphan_deleted=${deleted}`);
    return "hit";
  };

  const status = () => `scanned=${counts.scanned} candidates_empty=${counts.candidatesEmpty} candidates_old_link=${counts.candidatesOldLink} `
    + `hits_empty=${counts.hitsEmpty} hits_old_link=${counts.hitsOldLink} misses=${counts.misses} errors=${counts.errors}`
    + `${options.write ? ` migrated_empty=${counts.migratedEmpty} migrated_old_link=${counts.migratedOldLink} lost_race=${counts.lostRace}` : ""}`;

  try {
    for (;;) {
      if (options.maxBatches !== null && batches >= options.maxBatches) {
        stopReason = "max_batches";
        break;
      }
      if (options.shouldStop()) {
        stopReason = "signal";
        break;
      }
      const rows = await readSlice(db, afterId, options.batchSize);
      if (rows.length === 0) {
        completed = true;
        break;
      }
      const slice = zeroCounts();
      const sliceAfter = afterId;
      for (const row of rows) {
        if (options.shouldStop()) {
          stopReason = "signal";
          break;
        }
        const outcome = await processUser(row, slice);
        slice.scanned += 1;
        if (outcome === "error") {
          if (streak === 0) streakStartAfter = lastId;
          streak += 1;
        } else if (outcome !== "skipped") {
          streak = 0;
        }
        lastId = row.id;
        if (streak >= options.maxConsecutiveErrors) {
          stopReason = "consecutive_errors";
          break;
        }
      }
      if (slice.scanned > 0) {
        batches += 1;
        for (const key of Object.keys(counts) as (keyof Counts)[]) counts[key] += slice[key];
        options.log(`[${TAG}_RECEIPT] run_id=${options.runId ?? "-"} mode=${mode} slice_after=${sliceAfter ?? "-"} slice_last=${lastId} `
          + `scanned=${slice.scanned} candidates_empty=${slice.candidatesEmpty} candidates_old_link=${slice.candidatesOldLink} `
          + `hits=${slice.hitsEmpty + slice.hitsOldLink} misses=${slice.misses} errors=${slice.errors}`
          + `${options.write ? ` migrated=${slice.migratedEmpty + slice.migratedOldLink} lost_race=${slice.lostRace}` : ""}`);
      }
      afterId = lastId;
      if (stopReason !== null) break;
      if (rows.length < options.batchSize) {
        completed = true;
        break;
      }
    }
  } catch (error) {
    options.log(`[${TAG}_FAILED] after=${lastId ?? "-"} ${status()} reason=${JSON.stringify((error as Error)?.message ?? String(error))}`);
    options.log(`[${TAG}_RESUME] ${lastId === null ? "(from the start)" : `--start-after ${lastId}`}`);
    throw error;
  }
  // After a run of errors, resume before the first of them so they are retried.
  const resumeAfter = stopReason === "consecutive_errors" ? streakStartAfter : lastId;
  options.log(`[${TAG}_${completed ? "DONE" : "STOPPED"}] mode=${mode} batches=${batches} ${status()} `
    + `last_id=${lastId ?? "-"}${stopReason ? ` reason=${stopReason}` : ""} elapsed=${((deps.now() - started) / 1000).toFixed(1)}s`);
  if (!completed) options.log(`[${TAG}_RESUME] ${resumeAfter === null ? "(from the start)" : `--start-after ${resumeAfter}`}`);
  const result: RunResult = {
    completed, stopReason, lastId, resumeAfter, batches, counts, errorsByReason, errorIds, firstCandidateId, lastCandidateId,
  };
  options.log(`[${TAG}_SUMMARY] ${JSON.stringify({ mode, runId: options.runId, rps: options.rps, ...result })}`);
  return result;
}

export type Environment = "local" | "staging" | "production";

export interface CliOptions {
  environment: Environment;
  apply: boolean;
  fetch: boolean;
  approvalReference: string | null;
  runId: string | null;
  batchSize: number;
  startAfter: string | null;
  maxBatches: number | null;
  rps: number;
  timeoutMs: number;
  maxConsecutiveErrors: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: readonly string[]): CliOptions {
  let environment: string | null = null;
  const options: Omit<CliOptions, "environment"> = {
    apply: false, fetch: true, approvalReference: null, runId: null, batchSize: DEFAULT_OPTIONS.batchSize, startAfter: null,
    maxBatches: null, rps: DEFAULT_OPTIONS.rps, timeoutMs: DEFAULT_OPTIONS.timeoutMs, maxConsecutiveErrors: DEFAULT_OPTIONS.maxConsecutiveErrors,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--environment") environment = argv[++i] ?? "";
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--no-fetch") options.fetch = false;
    else if (arg === "--approval-reference") options.approvalReference = argv[++i] ?? "";
    else if (arg === "--run-id") options.runId = argv[++i] ?? "";
    else if (arg === "--batch") options.batchSize = Number(argv[++i]);
    else if (arg === "--start-after") options.startAfter = argv[++i] ?? "";
    else if (arg === "--max-batches") options.maxBatches = Number(argv[++i]);
    else if (arg === "--rps") options.rps = Number(argv[++i]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--max-consecutive-errors") options.maxConsecutiveErrors = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (environment !== "local" && environment !== "staging" && environment !== "production") {
    throw new Error("--environment must be local, staging or production");
  }
  if (options.apply && !options.fetch) throw new Error("--no-fetch is only for a dry-run");
  if (options.apply && !options.approvalReference?.trim()) throw new Error("--apply requires --approval-reference <the human approval message>");
  if (options.apply && !/^[A-Za-z0-9._:-]{1,100}$/.test(options.runId ?? "")) throw new Error("--apply requires --run-id <id> ([A-Za-z0-9._:-], at most 100)");
  if (!options.apply && (options.approvalReference !== null || options.runId !== null)) {
    throw new Error("--approval-reference and --run-id are only for --apply");
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 5000) throw new Error("--batch must be 1..5000");
  if (options.startAfter !== null && !UUID.test(options.startAfter)) throw new Error("--start-after must be a user id (uuid)");
  if (options.maxBatches !== null && (!Number.isInteger(options.maxBatches) || options.maxBatches < 1)) throw new Error("--max-batches must be a positive integer");
  if (!Number.isFinite(options.rps) || options.rps <= 0 || options.rps > 20) throw new Error("--rps must be above 0 and at most 20");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60_000) throw new Error("--timeout-ms must be 1000..60000");
  if (!Number.isInteger(options.maxConsecutiveErrors) || options.maxConsecutiveErrors < 1 || options.maxConsecutiveErrors > 1000) {
    throw new Error("--max-consecutive-errors must be 1..1000");
  }
  return { ...options, environment };
}

/** Production dry-runs read a replica; production writes go to the primary. */
export function checkEndpoint(environment: Environment, apply: boolean, inRecovery: boolean): string | null {
  if (environment !== "production") return null;
  if (!apply && !inRecovery) return "a production dry-run reads a replica: GRAVATAR_AVATARS_READ_DATABASE_URL is a primary";
  if (apply && inRecovery) return "--apply writes to the primary: GRAVATAR_AVATARS_WRITE_DATABASE_URL is a replica";
  return null;
}

/**
 * A production --apply stores into the CDN bucket and writes CDN URLs: without
 * these, storeUserAvatar would fall back to main storage or a local directory
 * and write `/api/avatars/...`. Returns the refusal, or the URL prefix every
 * stored avatar must have (null outside production).
 */
export function checkStorage(environment: Environment, apply: boolean, env: NodeJS.ProcessEnv): { refusal: string | null; expectedUrlPrefix: string | null } {
  if (!apply || environment !== "production") return { refusal: null, expectedUrlPrefix: null };
  const connection = cdnStorageConnection(env);
  const missing = [
    ["CDN_BASE_URL", env.CDN_BASE_URL?.trim()],
    ["S3_CDN_BUCKET", env.S3_CDN_BUCKET?.trim()],
    ["S3_CDN_ENDPOINT or S3_ENDPOINT", connection.endpoint],
    ["S3_CDN_ACCESS_KEY_ID or S3_ACCESS_KEY_ID", connection.accessKeyId],
    ["S3_CDN_SECRET_ACCESS_KEY or S3_SECRET_ACCESS_KEY", connection.secretAccessKey],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) return { refusal: `--apply in production stores into the CDN bucket: set ${missing.join(", ")}`, expectedUrlPrefix: null };
  return { refusal: null, expectedUrlPrefix: `${env.CDN_BASE_URL!.trim().replace(/\/$/, "")}/avatars/users/` };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const storage = checkStorage(options.environment, options.apply, process.env);
  if (storage.refusal) throw new Error(storage.refusal);
  const variable = options.apply ? "GRAVATAR_AVATARS_WRITE_DATABASE_URL" : "GRAVATAR_AVATARS_READ_DATABASE_URL";
  const connectionString = process.env[variable];
  if (!connectionString) throw new Error(`${variable} is required (no DATABASE_URL fallback)`);
  const client = new pg.Client({ connectionString });
  await client.connect();
  let stopRequested = false;
  const onSignal = (signal: string) => {
    stopRequested = true;
    console.log(`[${TAG}_STOPPING] ${signal}: stopping after the current user`);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  try {
    const { rows: [endpoint] } = await client.query<{ replica: boolean; replay_at: Date | null }>(
      `SELECT pg_is_in_recovery() AS replica, pg_last_xact_replay_timestamp() AS replay_at`,
    );
    const refusal = checkEndpoint(options.environment, options.apply, endpoint?.replica === true);
    if (refusal) throw new Error(refusal);
    // A dry-run writes nothing; make the session refuse writes too.
    if (!options.apply) await client.query("SET default_transaction_read_only = on");
    console.log(`[${TAG}_START] ${JSON.stringify({
      mode: options.apply ? "apply" : options.fetch ? "dry-run" : "dry-run-no-fetch", environment: options.environment,
      replica: endpoint?.replica ?? null, replayAt: endpoint?.replay_at ?? null, approvalReference: options.approvalReference,
      runId: options.runId, batch: options.batchSize, rps: options.rps, timeoutMs: options.timeoutMs,
      maxConsecutiveErrors: options.maxConsecutiveErrors, startAfter: options.startAfter,
      expectedUrlPrefix: storage.expectedUrlPrefix, startedAt: new Date().toISOString(),
    })}`);
    const result = await run(client, DEFAULT_DEPS, {
      ...DEFAULT_OPTIONS,
      write: options.apply,
      fetch: options.fetch,
      runId: options.runId,
      startAfter: options.startAfter,
      batchSize: options.batchSize,
      maxBatches: options.maxBatches,
      rps: options.rps,
      timeoutMs: options.timeoutMs,
      maxConsecutiveErrors: options.maxConsecutiveErrors,
      expectedUrlPrefix: storage.expectedUrlPrefix,
      shouldStop: () => stopRequested,
    });
    if (!options.apply) console.log("dry-run; pass --apply --approval-reference <message> --run-id <id> to write");
    if (stopRequested && !result.completed) process.exitCode = 130;
    else if (result.stopReason === "consecutive_errors") process.exitCode = 2;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
