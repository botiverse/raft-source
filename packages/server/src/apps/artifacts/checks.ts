// Publish checks (task #proj-workspace:#130; docs/development/workspace-artifacts.md,
// "Publish check"): after a version is pushed, Raft opens it in a headless
// browser (the check Worker, which opens the version's content ticket
// top-level) and keeps two screenshots and what the page got wrong. Only
// where the deployment has a check Worker (checkWorkerToken.ts
// checksConfigured; once the flag artifact_publish_check_v0). This module is
// the server's state of it, `app_artifacts.version_checks` (schema.ts), and
// what the check's durable task (checkTask.ts, the only importer of
// checkFrame.ts) needs around it:
//
// - Only shared ARTIFACT_CHECKED_KINDS are checked, HTML (not Markdown, whose
//   card shows an excerpt, excerpt.ts; not PDF, for now): every place that
//   decides whether a version is checked asks isArtifactCheckedKind (recording here, the check task's lease, its
//   ticket in checkFrame.ts, authorize in contentRoutes.ts).
// - recordVersionCheck: the row an agent's push writes in its transaction
//   (publish.ts commit, after the version's files), `pending`,
//   or `skipped` from the start: files byte-identical to the previous
//   version's (`unchanged`), or over a daily cap (mayCheck). Only checked
//   kinds; without a check Worker no row is written. It runs in a savepoint of the
//   push's transaction and never fails the push: a failure rolls back the
//   row alone and the push goes on without a check.
// - versionCheckOf: a version's row, null without a check Worker (a replayed
//   push's answer, checkRead.ts).
// - mayCheck: today's (UTC) checks that run, of the server
//   (ARTIFACTS_CHECK_DAILY_PER_SERVER, default 300) and of the platform
//   (ARTIFACTS_CHECK_DAILY_TOTAL, default 5000). A soft cap: two pushes at
//   once may both pass at the edge, by one each; it bounds cost, not access.
//   mayStartCheck asks again when the check task leases a pending check: is
//   it still among the first of its day under the caps as they are now.
// - No per-server in-flight cap: the check task's lease (checkTask.ts
//   leaseCheck) takes the server with the fewest checks running first
//   (work-conserving: a lone server may use every browser the Worker runs, its
//   own in-flight cap of 40 per run, runs overlapping only at their ends).
// - isCheckRunning: what authorize asks (contentRoutes.ts), with checksConfigured.
// - cardCheckShots: the screenshots the cards show (webCards.ts, ArtifactPreview
//   `screenshot`), batched for a page of cards.
// - checkShotPart, checkShotFileOf: a screenshot is a core object file of
//   the Artifact (platform/objectFiles), hung on its version
//   (`version:<version id>`); the row keeps its id. People read it through
//   core's route (`GET /api/objects/artifact/:id/files/:fileId`), which
//   checks the Artifact's visibility; Artifacts has no web screenshot route.
//   Agents read a check and its screenshots through checkRead.ts.
// - checkShotReadable: core's last question before it serves any of the
//   Artifact's files (register.ts fileReadable): a screenshot only while the
//   deployment has a check Worker (the cards show none either:
//   cardCheckShots), every other file as core decides.
// - keepNewestCheckShots: only the newest three versions of an Artifact with
//   screenshots keep them; older rows' ids are cleared and their files let
//   go in one transaction, then core deletes the bytes. The check task calls
//   it after a check finishes.
// - deleteItemChecks: deleting the Artifact (manage.ts deleteArtifact)
//   deletes its rows in its transaction, beside letting every file of the
//   Artifact go (deleteObjectFiles); a soft-deleted server's files are
//   core's sweep's.
//
// The check task (checkTask.ts) stores each screenshot with putObjectFile
// (uploaded by the version's publisher), hangs it on checkShotPart(version)
// and sets the row's id in the transaction that finishes the check.
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  artifactFileType,
  currentDate,
  isArtifactCheckedKind,
  type ArtifactCheckShot,
  type ObjectFileId,
  type ServerId,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { withAppSpan } from "../../platform/tracing";
import { deleteObjectFileBytes, deleteObjectFiles, type ObjectFileObject } from "../../platform/objectFiles";
import { readableVersion, readsAsOutsider } from "./apiCommon";
import { checksConfigured } from "./checkWorkerToken";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import {
  artifactItems,
  artifactVersionChecks,
  artifactVersionFiles,
  artifactVersions,
  type ArtifactCheckSkipReason,
  type ArtifactItemRow,
  type ArtifactVersionCheckRow,
  type ArtifactVersionRow,
} from "./schema";

export const ARTIFACT_CHECK_DAILY_PER_SERVER_DEFAULT = 300;
export const ARTIFACT_CHECK_DAILY_TOTAL_DEFAULT = 5000;
/** How many of an Artifact's versions keep their screenshots: the newest ones that have them. */
export const ARTIFACT_CHECK_SHOTS_KEPT = 3;

// ---- caps --------------------------------------------------------------------------

const warnedCaps = new Set<string>();

/** A cap from `name`: a whole number (0 skips every check), else `fallback` (with a warning, once per value). */
function capOf(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim() ?? "";
  if (raw === "") return fallback;
  if (/^\d{1,9}$/.test(raw)) return Number(raw);
  if (!warnedCaps.has(`${name}=${raw}`)) {
    warnedCaps.add(`${name}=${raw}`);
    console.warn(`[artifacts] ${name} is not a whole number; using ${fallback}`);
  }
  return fallback;
}

/** The day's caps: per server (ARTIFACTS_CHECK_DAILY_PER_SERVER) and for the platform (ARTIFACTS_CHECK_DAILY_TOTAL). */
export function checkDailyCaps(env: NodeJS.ProcessEnv = process.env): { perServer: number; total: number } {
  return {
    perServer: capOf(env, "ARTIFACTS_CHECK_DAILY_PER_SERVER", ARTIFACT_CHECK_DAILY_PER_SERVER_DEFAULT),
    total: capOf(env, "ARTIFACTS_CHECK_DAILY_TOTAL", ARTIFACT_CHECK_DAILY_TOTAL_DEFAULT),
  };
}

const utcDayOf = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** The caps' count: the day's (from `since`) checks that run (not `skipped`), of `serverId` and of all, those matching `also` only. */
export type ArtifactCheckCount = (executor: DatabaseExecutor, serverId: ServerId, since: Date, also?: SQL) => Promise<{ server: number; total: number }>;

/** The caps' count in one query (idx_version_checks_created). */
const countRunning: ArtifactCheckCount = async (executor, serverId, since, also) => {
  const [counted] = await executor
    .select({
      server: sql<number>`count(*) FILTER (WHERE ${artifactItems.serverId} = ${serverId})::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(artifactVersionChecks)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifactVersionChecks.versionId))
    .innerJoin(artifactItems, eq(artifactItems.id, artifactVersions.itemId))
    .where(and(gte(artifactVersionChecks.createdAt, since), ne(artifactVersionChecks.status, "skipped"), also));
  return counted!;
};

function allowanceOf(counted: { server: number; total: number }, caps: { perServer: number; total: number }): ArtifactCheckAllowance {
  if (counted.server >= caps.perServer) return { ok: false, reason: "server_daily_cap" };
  if (counted.total >= caps.total) return { ok: false, reason: "platform_daily_cap" };
  return { ok: true };
}

export type ArtifactCheckAllowance = { ok: true } | { ok: false; reason: Extract<ArtifactCheckSkipReason, "server_daily_cap" | "platform_daily_cap"> };

/**
 * Whether one more check may run today (UTC) for `serverId`: fewer than its
 * daily cap of the server's checks, then fewer than the platform's of all,
 * counting the rows that run (not `skipped`) created since midnight, in one
 * query (idx_version_checks_created). The server's cap is named first when
 * both are reached. `count`: that query (default the real one; a test makes
 * it fail).
 */
export async function mayCheck(
  serverId: ServerId,
  opts: { now?: Date; executor?: DatabaseExecutor; env?: NodeJS.ProcessEnv; count?: ArtifactCheckCount } = {},
): Promise<ArtifactCheckAllowance> {
  const since = utcDayOf(opts.now ?? currentDate());
  return allowanceOf(await (opts.count ?? countRunning)(opts.executor ?? getDb(), serverId, since), checkDailyCaps(opts.env));
}

/**
 * Whether the pending check `check` of `serverId` may start now (the check
 * task's lease): under the caps as they are now (a lowered cap holds back a
 * check recorded under the old one), counting the checks that run of its own
 * UTC day recorded before it (by created_at, then id), as mayCheck counted
 * when it was recorded. So the first `cap` of a day start, whatever order
 * they are leased in.
 */
export async function mayStartCheck(
  executor: DatabaseExecutor,
  check: Pick<ArtifactVersionCheckRow, "id" | "createdAt">,
  serverId: ServerId,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<ArtifactCheckAllowance> {
  const before = or(
    lt(artifactVersionChecks.createdAt, check.createdAt),
    and(eq(artifactVersionChecks.createdAt, check.createdAt), lt(artifactVersionChecks.id, check.id)),
  );
  return allowanceOf(await countRunning(executor, serverId, utcDayOf(check.createdAt), before), checkDailyCaps(opts.env));
}

// ---- recording a check -------------------------------------------------------------

type CheckedVersion = Pick<ArtifactVersionRow, "id" | "itemId" | "number" | "entry" | "spa">;

/**
 * Whether `version` shows exactly what the Artifact's previous published
 * version (the readable one numbered just below it) showed: the same entry,
 * the same `spa`, and the same files, path for path, byte for byte (sha256;
 * a server keeps one blob per sha256, so the same blobs). False when there is
 * no previous version.
 */
export async function filesUnchanged(executor: DatabaseExecutor, version: CheckedVersion): Promise<boolean> {
  const [previous] = await executor.select().from(artifactVersions)
    .where(and(readableVersion(version.itemId), lt(artifactVersions.number, version.number)))
    .orderBy(desc(artifactVersions.number))
    .limit(1);
  if (!previous || previous.entry !== version.entry || previous.spa !== version.spa) return false;
  const filesOf = (versionId: string) => executor.select({ path: artifactVersionFiles.path, sha256: artifactVersionFiles.sha256 })
    .from(artifactVersionFiles)
    .where(eq(artifactVersionFiles.versionId, versionId))
    .orderBy(asc(artifactVersionFiles.path));
  const mine = await filesOf(version.id);
  const theirs = await filesOf(previous.id);
  return mine.length === theirs.length && mine.every((file, at) => file.path === theirs[at]!.path && file.sha256 === theirs[at]!.sha256);
}

type RecordInput = {
  item: Pick<ArtifactItemRow, "id" | "serverId">;
  version: CheckedVersion;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /** The daily caps' count query (mayCheck's `count`): a test makes it fail. */
  count?: ArtifactCheckCount;
};

/**
 * The check of a pushed version, written in the push's transaction
 * (`executor`): null, and no row, for a kind that isn't checked
 * (shared ARTIFACT_CHECKED_KINDS) or where the deployment has no check Worker
 * (checksConfigured); else the row, `skipped` (`unchanged`, or the cap
 * mayCheck names) or `pending` for the check task to run. Idempotent per
 * version: a version that has its row already answers that row.
 *
 * Never fails the push: its queries run in a savepoint of the push's
 * transaction (a nested `transaction`, as appOutboundPermissionService.ts
 * does inside a caller's), so a failed one (a cap count that throws, the
 * insert) rolls back to it alone, leaving the push's transaction usable; the
 * failure is logged (ids and its class only) and ends the
 * `server.artifacts.check.record` span as an error, and the answer is null:
 * the push goes on without a check.
 */
export async function recordVersionCheck(executor: DatabaseExecutor, input: RecordInput): Promise<ArtifactVersionCheckRow | null> {
  const { item, version } = input;
  if (version.itemId !== item.id) throw new Error("recordVersionCheck: the version is not the item's");
  if (!isArtifactCheckedKind(artifactFileType(version.entry).kind)) return null;
  try {
    return await withAppSpan(
      "server.artifacts.check.record",
      {},
      () => executor.transaction((savepoint) => recordInSavepoint(savepoint, input)),
      { onSuccess: (row) => ({ outcome: row?.status ?? "none" }) },
    );
  } catch (error) {
    console.warn("[artifacts] the push's publish check was not recorded; the push goes on without it", {
      versionId: version.id,
      ...failureOf(error),
    });
    return null;
  }
}

/** recordVersionCheck's queries, in its savepoint. */
async function recordInSavepoint(executor: DatabaseExecutor, input: RecordInput): Promise<ArtifactVersionCheckRow | null> {
  const { item, version } = input;
  if (!checksConfigured(input.env)) return null;
  const now = input.now ?? currentDate();
  let skipReason: ArtifactCheckSkipReason | null = null;
  if (await filesUnchanged(executor, version)) {
    skipReason = "unchanged";
  } else {
    const allowance = await mayCheck(item.serverId, { now, executor, env: input.env, count: input.count });
    if (!allowance.ok) skipReason = allowance.reason;
  }
  const [inserted] = await executor.insert(artifactVersionChecks)
    .values({
      versionId: version.id,
      status: skipReason === null ? "pending" : "skipped",
      skipReason,
      createdAt: now,
      finishedAt: skipReason === null ? null : now,
    })
    .onConflictDoNothing({ target: artifactVersionChecks.versionId })
    .returning();
  if (inserted) return inserted;
  const [existing] = await executor.select().from(artifactVersionChecks).where(eq(artifactVersionChecks.versionId, version.id)).limit(1);
  return existing ?? null;
}

/** What a log may say of a failure: its class and, from Postgres, its SQLSTATE; never its message (it may quote values). */
function failureOf(error: unknown): { errorClass: string; sqlstate?: string } {
  const errorClass = error instanceof Error ? error.name : typeof error;
  for (let at: unknown = error, depth = 0; at && typeof at === "object" && depth < 3; at = (at as { cause?: unknown }).cause, depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return { errorClass, sqlstate: code };
  }
  return { errorClass };
}

/**
 * `versionId`'s check as stored, or null: none recorded, or the deployment
 * has no check Worker now (nothing is served). A replayed push's answer and
 * checkRead.ts.
 */
export async function versionCheckOf(versionId: string, opts: { executor?: DatabaseExecutor; env?: NodeJS.ProcessEnv } = {}): Promise<ArtifactVersionCheckRow | null> {
  const executor = opts.executor ?? getDb();
  if (!checksConfigured(opts.env)) return null;
  const [row] = await executor.select().from(artifactVersionChecks).where(eq(artifactVersionChecks.versionId, versionId)).limit(1);
  return row ?? null;
}

/** How long a running check may read its version (a single check times out at 15 s): its lease (checkTask.ts leaseCheck). */
export const ARTIFACT_CHECK_LEASE_MS = 2 * 60 * 1000;

/**
 * Whether `versionId`'s check is running now, within its lease: the one time its check subject
 * may read it (contentRoutes.ts decideCheck). A check whose task died stays `running` but its
 * lease runs out, so the door closes by itself.
 */
export async function isCheckRunning(versionId: string, now: Date = new Date()): Promise<boolean> {
  const [row] = await getDb().select({ id: artifactVersionChecks.id }).from(artifactVersionChecks)
    .where(and(
      eq(artifactVersionChecks.versionId, versionId),
      eq(artifactVersionChecks.status, "running"),
      gt(artifactVersionChecks.leaseExpiresAt, now),
    ))
    .limit(1);
  return row !== undefined;
}

// ---- screenshots ----------------------------------------------------------------------

/** The Artifact as the object its files belong to (platform/objectFiles). */
export const artifactFileObject = (itemId: string): ObjectFileObject => ({ kind: ARTIFACT_OBJECT_KIND, id: itemId });

/** The part a version's screenshots hang on: its files go when the version's are let go. */
export const checkShotPart = (versionId: string): string => `version:${versionId}`;

/** The file id of screenshot `which` of `versionId`'s check, or null when it has none (not done, never taken, or cleared). */
export async function checkShotFileOf(versionId: string, which: ArtifactCheckShot): Promise<ObjectFileId | null> {
  const [row] = await getDb().select({ desktop: artifactVersionChecks.desktopFileId, phone: artifactVersionChecks.phoneFileId })
    .from(artifactVersionChecks)
    .where(and(eq(artifactVersionChecks.versionId, versionId), eq(artifactVersionChecks.status, "done")))
    .limit(1);
  return row ? row[which] : null;
}

/**
 * Whether core may serve an Artifact's file hung on `parent`
 * (AppObjectKind.fileReadable, asked after core's own rules): a check's
 * screenshot (a `version:` part) only while the deployment has a check
 * Worker (checksConfigured), else it is answered as one there isn't; every
 * other part (a comment's images) as core decides.
 */
export function checkShotReadable(parent: string, env?: NodeJS.ProcessEnv): boolean {
  return !parent.startsWith(checkShotPart("")) || checksConfigured(env);
}

/** A version a card shows, for its screenshots: by number, or null for the item's current version. */
export interface CardShotAsk {
  item: Pick<ArtifactItemRow, "id" | "currentVersionId" | "serverId" | "homeKind">;
  number: number | null;
}

/** A finished check's screenshots of one version: desktop always, phone when it was taken. */
export interface CardCheckShots {
  desktop: ObjectFileId;
  phone: ObjectFileId | null;
}

/** cardCheckShots' key: the item and the version number. */
export const cardShotKey = (itemId: string, number: number): string => `${itemId}@${number}`;

/**
 * The screenshots of the versions cards show (ArtifactPreview `screenshot`),
 * by cardShotKey: only a `done` check's that kept its desktop one (the newest
 * three versions' do: keepNewestCheckShots), in one query however many cards
 * (idx_versions_item_number, idx_version_checks_version), and only where the
 * deployment has a check Worker (checksConfigured). Who sees the Artifact is the caller's (the
 * cards are of visible Artifacts); the files are read through core's route,
 * which checks it again and never serves them to another server's reader of
 * a public Artifact (its public face only), so such a reader
 * (readsAsOutsider) is asked nothing and gets none.
 */
export async function cardCheckShots(readerServerId: ServerId, all: readonly CardShotAsk[], env?: NodeJS.ProcessEnv): Promise<ReadonlyMap<string, CardCheckShots>> {
  if (!checksConfigured(env)) return new Map();
  const asked = all.filter((ask) => !readsAsOutsider(readerServerId, ask.item));
  const currentIds = [...new Set(asked.flatMap((ask) => (ask.number === null && ask.item.currentVersionId ? [ask.item.currentVersionId] : [])))];
  const numbered = [...new Map(asked.flatMap((ask) => (ask.number === null ? [] : [[cardShotKey(ask.item.id, ask.number), { itemId: ask.item.id, number: ask.number }] as const]))).values()];
  if (currentIds.length === 0 && numbered.length === 0) return new Map();
  const rows = await getDb()
    .select({ itemId: artifactVersions.itemId, number: artifactVersions.number, desktop: artifactVersionChecks.desktopFileId, phone: artifactVersionChecks.phoneFileId })
    .from(artifactVersionChecks)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifactVersionChecks.versionId))
    .where(and(
      eq(artifactVersionChecks.status, "done"),
      isNotNull(artifactVersionChecks.desktopFileId),
      or(
        ...(currentIds.length > 0 ? [inArray(artifactVersions.id, currentIds)] : []),
        ...numbered.map((ask) => and(eq(artifactVersions.itemId, ask.itemId), eq(artifactVersions.number, ask.number))),
      ),
    ));
  return new Map(rows.map((row) => [cardShotKey(row.itemId, row.number), { desktop: row.desktop!, phone: row.phone ?? null }]));
}

/**
 * Only the newest ARTIFACT_CHECK_SHOTS_KEPT versions of the Artifact that have
 * screenshots keep them: in one transaction (holding those rows, so two calls
 * at once clear each once) the older rows' file ids are cleared and their
 * versions' files let go (deleteObjectFiles); core deletes the bytes after
 * it commits. The rows stay, with their findings. Returns how many files'
 * bytes went.
 */
export async function keepNewestCheckShots(itemId: string, opts: { keep?: number } = {}): Promise<number> {
  const keep = opts.keep ?? ARTIFACT_CHECK_SHOTS_KEPT;
  const released = await getDb().transaction(async (tx) => {
    // `FOR UPDATE OF` takes a table name or an alias, never a schema-qualified
    // name (app_artifacts.version_checks is one): hold the checks under an alias.
    const held = alias(artifactVersionChecks, "held_checks");
    const rows = await tx.select({ id: held.id, versionId: held.versionId })
      .from(held)
      .innerJoin(artifactVersions, eq(artifactVersions.id, held.versionId))
      .where(and(eq(artifactVersions.itemId, itemId), or(isNotNull(held.desktopFileId), isNotNull(held.phoneFileId))))
      .orderBy(desc(artifactVersions.number))
      .for("update", { of: held });
    const older = rows.slice(keep);
    if (older.length === 0) return null;
    await tx.update(artifactVersionChecks)
      .set({ desktopFileId: null, phoneFileId: null })
      .where(inArray(artifactVersionChecks.id, older.map((row) => row.id)));
    return deleteObjectFiles({ object: artifactFileObject(itemId), parent: older.map((row) => checkShotPart(row.versionId)), executor: tx });
  });
  return released ? deleteObjectFileBytes(released) : 0;
}

/**
 * Delete every check of the Artifact `itemId`, in the caller's transaction
 * (manage.ts deleteArtifact, which lets the Artifact's files go beside it).
 */
export async function deleteItemChecks(executor: DatabaseExecutor, itemId: string): Promise<void> {
  await executor.delete(artifactVersionChecks)
    .where(inArray(artifactVersionChecks.versionId, executor.select({ id: artifactVersions.id }).from(artifactVersions).where(eq(artifactVersions.itemId, itemId))));
}
