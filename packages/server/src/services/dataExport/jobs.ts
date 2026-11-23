// Data export jobs (#triage:#512, docs/development/data-export.md): the
// rows of data_exports and every change of their status outside the runner's
// own writes. Who may ask, the re-authentication and the flag are the
// routes' (routes/dataExports.ts); writing the archive is the runner's
// (runner.ts); expiry and clean-up are maintenance's (maintenance.ts).
import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { actorRoleHasServerCapability } from "../../lib/actorPermissions";
import {
  asDataExportId,
  currentDate,
  asServerId,
  DATA_EXPORT_IN_FLIGHT_STATUSES,
  DATA_EXPORT_PERSONAL_COOLDOWN_MS,
  DATA_EXPORT_SCOPE_VERSION,
  DATA_EXPORT_SERVER_COOLDOWN_MS,
  type DataExportKind,
  type DataExportScope,
  type DataExportView,
  type ServerDataExportScope,
  type ServerRole,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { dataExports, serverMembers, servers, type DataExportProgress, type DataExportVolume } from "../../db/schema";
import { serializeErrorForLog } from "../../tracing/safeErrorLog";
import { CLOSED_SERVER_PURGE_AFTER_MS } from "../closedServerPurgeDelete";
import { DATA_EXPORT_FEATURE_FLAG_KEY, evaluateFeatureFlag } from "../featureFlagService";
import { createDurableTask, type DurableTaskClaim, type DurableTaskSpec } from "../durableTasks";
import { DATA_EXPORT_STORAGE_KEY_PREFIX, getStorage } from "../storageService";
import type { DataExportJob } from "./producer";

export type DataExportRow = typeof dataExports.$inferSelect;

/**
 * Every archive's objects: `data-exports/v1/<export id>/<volume>-<run token>.zip`,
 * in the private legacy bucket. The run token (runner.ts) keeps two runs of
 * one job from ever writing, or deleting, the same object.
 */
export const DATA_EXPORT_KEY_PREFIX = `${DATA_EXPORT_STORAGE_KEY_PREFIX}v1/`;

export function dataExportVolumeKey(exportId: string, volume: number, runToken: string): string {
  return `${DATA_EXPORT_KEY_PREFIX}${exportId}/${volume}-${runToken}.zip`;
}

/** The file name a download is saved as. */
export function dataExportFileName(row: Pick<DataExportRow, "kind" | "createdAt" | "volumes">, volume: number, serverSlug?: string | null): string {
  const who = row.kind === "server" ? (serverSlug || "server").replace(/[^a-zA-Z0-9-]/g, "-") : "me";
  const day = row.createdAt.toISOString().slice(0, 10);
  return `raft-export-${who}-${day}${row.volumes.length > 1 ? `-${volume}` : ""}.zip`;
}

export function dataExportJobOf(row: DataExportRow): DataExportJob {
  return {
    id: asDataExportId(row.id),
    kind: row.kind,
    requesterUserId: row.requesterUserId,
    serverId: row.serverId ? asServerId(row.serverId) : null,
    scope: row.scope,
    createdAt: row.createdAt,
  } as DataExportJob;
}

export function dataExportView(row: DataExportRow): DataExportView {
  const iso = (at: Date | null) => at ? at.toISOString() : null;
  return {
    id: asDataExportId(row.id),
    kind: row.kind,
    serverId: row.serverId,
    scope: row.scope,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    expiresAt: row.status === "ready" ? iso(row.expiresAt) : null,
    sizeBytes: row.sizeBytes,
    volumes: row.status === "ready" ? row.volumes.map((volume) => ({ index: volume.index, sizeBytes: volume.sizeBytes })) : [],
    errorCode: row.status === "failed" ? row.errorCode : null,
    downloadedAt: iso(row.downloadedAt),
    lastDownloadedAt: iso(row.lastDownloadedAt),
  };
}

const LIST_LIMIT = 50;

/** The requester's own exports of a kind (and server), newest first. */
export async function listDataExports(input: { requesterUserId: string; kind: DataExportKind; serverId?: string }): Promise<DataExportRow[]> {
  return getDb().select().from(dataExports)
    .where(and(
      eq(dataExports.requesterUserId, input.requesterUserId),
      eq(dataExports.kind, input.kind),
      ...(input.serverId ? [eq(dataExports.serverId, input.serverId)] : []),
      ne(dataExports.status, "deleted"),
    ))
    .orderBy(desc(dataExports.createdAt))
    .limit(LIST_LIMIT);
}

/** One of the requester's own exports, or null (someone else's reads the same as none). */
export async function getOwnDataExport(input: { requesterUserId: string; exportId: string; kind: DataExportKind; serverId?: string }): Promise<DataExportRow | null> {
  const [row] = await getDb().select().from(dataExports)
    .where(and(
      eq(dataExports.id, input.exportId),
      eq(dataExports.requesterUserId, input.requesterUserId),
      eq(dataExports.kind, input.kind),
      ...(input.serverId ? [eq(dataExports.serverId, input.serverId)] : []),
      ne(dataExports.status, "deleted"),
    ));
  return row ?? null;
}

/**
 * `data_export_v0` for this person (and, for a server export, this server):
 * read by every route and before every batch of the runner, so turning it off
 * (or its kill switch) stops new exports and running ones. For the routes a
 * failed read is off.
 */
export async function dataExportEnabledFor(input: { userId: string; serverId: string | null }): Promise<boolean> {
  return dataExportFlagEnabled(input).catch(() => false);
}

/** The same, throwing when the flag can't be read: the runner retries then, it never fails an export for it. */
export async function dataExportFlagEnabled(input: { userId: string; serverId: string | null }): Promise<boolean> {
  const evaluation = await evaluateFeatureFlag({ key: DATA_EXPORT_FEATURE_FLAG_KEY, userId: input.userId, serverId: input.serverId });
  return evaluation.enabled === true;
}

// ── Who may export a server ──

export interface ServerExportAccess {
  role: ServerRole;
  slug: string;
  name: string;
  /** Closed (deleted_at), not purged yet: only a full-history export, until the purge. */
  closedAt: Date | null;
  /** The purge has begun (or is done): nothing more is exported, nothing is downloaded. */
  purgeStarted: boolean;
}

/**
 * The person's membership of a server, closed servers included (the
 * server-scoped lockdown refuses those; this router runs before it). Null for
 * a non-member and for a joint's storage server.
 */
export async function serverExportAccessOf(serverId: string, userId: string, executor: DatabaseExecutor = getDb()): Promise<ServerExportAccess | null> {
  const [row] = await executor.select({
    role: serverMembers.role,
    slug: servers.slug,
    name: servers.name,
    deletedAt: servers.deletedAt,
    purgeState: servers.purgeState,
    purgedAt: servers.purgedAt,
  }).from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId), ne(servers.kind, "joint_storage")));
  if (!row) return null;
  return {
    role: row.role as ServerRole,
    slug: row.slug,
    name: row.name,
    closedAt: row.deletedAt,
    purgeStarted: row.purgeState !== null || row.purgedAt !== null,
  };
}

export function canExportServer(access: ServerExportAccess | null): boolean {
  return !!access && !access.purgeStarted && actorRoleHasServerCapability(access.role, "exportServerData");
}

/**
 * The close rule of a server export's scope (design §5, cindyz): an open
 * server exports as usual (the plan's history window); a closed one only
 * exports its full history, and only before its purge (30 days after the
 * close). Null when the scope fits.
 */
export function serverExportWindowRefusal(access: ServerExportAccess, scope: ServerDataExportScope, now: Date): { code: string; error: string } | null {
  if (!access.closedAt) {
    return scope.fullHistoryAfterClose
      ? { code: "data_export_full_history_not_closed", error: "Full history is only exported after the server is closed." }
      : null;
  }
  if (access.purgeStarted || access.closedAt.getTime() + CLOSED_SERVER_PURGE_AFTER_MS <= now.getTime()) {
    return { code: "data_export_window_over", error: "This server was closed more than 30 days ago, so its data can no longer be exported." };
  }
  return scope.fullHistoryAfterClose
    ? null
    : { code: "data_export_full_history_required", error: "A closed server exports its full history: ask with fullHistoryAfterClose set." };
}

// ── Asking for one ──

export type CreateDataExportOutcome =
  | { ok: true; row: DataExportRow; claim: DurableTaskClaim }
  | { ok: false; reason: "in_flight" }
  | { ok: false; reason: "cooldown"; retryAfterSeconds: number }
  /** The caller's own check in the transaction refused (an emailed code used in between). */
  | { ok: false; reason: "refused" };

function isUniqueViolation(err: unknown): boolean {
  for (let cause = err; cause && typeof cause === "object"; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

class CreateRefused extends Error {}

const cooldownOf = (kind: DataExportKind) => kind === "server" ? DATA_EXPORT_SERVER_COOLDOWN_MS : DATA_EXPORT_PERSONAL_COOLDOWN_MS;

/**
 * The exports that count against the cooldown: this kind, the person's (personal) or the
 * server's (server), any status but failed (a deleted or expired one counts), asked within it.
 */
function countedTowardCooldown(input: { kind: DataExportKind; requesterUserId: string; serverId: string | null; now: Date }) {
  return and(
    eq(dataExports.kind, input.kind),
    input.kind === "server" ? eq(dataExports.serverId, input.serverId!) : eq(dataExports.requesterUserId, input.requesterUserId),
    ne(dataExports.status, "failed"),
    gt(dataExports.createdAt, new Date(input.now.getTime() - cooldownOf(input.kind))),
  );
}

/** When the cooldown lets this kind be asked for again (the list shows it), or null when it does now. */
export async function dataExportNextAllowedAt(input: { kind: DataExportKind; requesterUserId: string; serverId: string | null; now: Date }): Promise<Date | null> {
  const [last] = await getDb().select({ createdAt: dataExports.createdAt }).from(dataExports).where(countedTowardCooldown(input))
    .orderBy(desc(dataExports.createdAt)).limit(1);
  return last ? new Date(last.createdAt.getTime() + cooldownOf(input.kind)) : null;
}

/**
 * Write the job and its durable task in one transaction (RFC 073), after the
 * limits: one in flight per person and per server (the partial unique
 * indexes decide a race), and one per cooldown: a personal export per person
 * per 7 days, a server export per server per 24 hours; a failed export does
 * not count (design §6). `inTransaction` runs after the limits, just before
 * the insert (the emailed code is used there, so a refused request never
 * spends it); false refuses and writes nothing.
 */
export async function createDataExport(input: {
  /** Chosen by the caller when it needs the id before the row exists (the route's authorize). */
  id?: string;
  kind: DataExportKind;
  requesterUserId: string;
  requesterSessionFamilyId: string;
  serverId: string | null;
  scope: DataExportScope;
  now: Date;
  inTransaction?: (tx: DatabaseExecutor) => Promise<boolean>;
  /** The runner's task (runner.ts), passed in: the runner imports this file. */
  taskSpec: DurableTaskSpec<{ exportId: string }>;
}): Promise<CreateDataExportOutcome> {
  const { now } = input;
  try {
    return await getDb().transaction(async (tx) => {
      const cooldownMs = cooldownOf(input.kind);
      const counted = countedTowardCooldown(input);
      const inFlight = await tx.select({ id: dataExports.id }).from(dataExports).where(and(
        inArray(dataExports.status, [...DATA_EXPORT_IN_FLIGHT_STATUSES]),
        input.kind === "server"
          ? sql`(${dataExports.requesterUserId} = ${input.requesterUserId} OR ${dataExports.serverId} = ${input.serverId})`
          : eq(dataExports.requesterUserId, input.requesterUserId),
      )).limit(1);
      if (inFlight.length > 0) return { ok: false as const, reason: "in_flight" as const };
      const [last] = await tx.select({ createdAt: dataExports.createdAt }).from(dataExports).where(counted)
        .orderBy(desc(dataExports.createdAt)).limit(1);
      if (last) {
        return { ok: false as const, reason: "cooldown" as const, retryAfterSeconds: Math.max(1, Math.ceil((last.createdAt.getTime() + cooldownMs - now.getTime()) / 1000)) };
      }
      if (input.inTransaction && !(await input.inTransaction(tx))) throw new CreateRefused();
      const [row] = await tx.insert(dataExports).values({
        ...(input.id ? { id: input.id } : {}),
        kind: input.kind,
        requesterUserId: input.requesterUserId,
        requesterSessionFamilyId: input.requesterSessionFamilyId,
        serverId: input.serverId,
        scope: input.scope,
        scopeVersion: DATA_EXPORT_SCOPE_VERSION,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      }).returning();
      const claim = await createDurableTask(tx, { definition: input.taskSpec, payload: { exportId: row!.id }, now });
      const [withTask] = await tx.update(dataExports).set({ durableTaskId: claim.task.id }).where(eq(dataExports.id, row!.id)).returning();
      return { ok: true as const, row: withTask!, claim };
    });
  } catch (err) {
    if (err instanceof CreateRefused) return { ok: false, reason: "refused" };
    if (isUniqueViolation(err)) return { ok: false, reason: "in_flight" };
    throw err;
  }
}

// ── Ending one ──

/**
 * The requester's delete (design §6: "you can delete it early"): any
 * status but deleted. A running export's runner sees it at its next batch
 * and aborts its upload; the archive's objects go now (and, if that fails,
 * at the next maintenance: deleteFinishedExportObjects).
 */
export async function deleteDataExport(input: { requesterUserId: string; exportId: string; now: Date }): Promise<boolean> {
  const [row] = await getDb().update(dataExports)
    .set({ status: "deleted", deletedAt: input.now, updatedAt: input.now })
    .where(and(eq(dataExports.id, input.exportId), eq(dataExports.requesterUserId, input.requesterUserId), ne(dataExports.status, "deleted")))
    .returning();
  if (!row) return false;
  await removeExportObjects([row]).catch((err) => console.error(`[data-export] deleting the objects of ${row.id} failed:`, serializeErrorForLog(err)));
  return true;
}

/** Delete stored objects: volumes, and an open upload (aborted). A missing object is not an error (S3 and local delete are idempotent). */
export async function deleteStoredObjects(volumes: readonly Pick<DataExportVolume, "key">[], upload: { key: string; uploadId: string } | null): Promise<void> {
  const storage = getStorage();
  if (!storage) return;
  if (upload && storage.multipart) await storage.multipart.abortMultipartUpload(upload.key, upload.uploadId);
  for (const volume of volumes) await storage.delete(volume.key);
}

/**
 * Delete what an ended export left in storage: its finished volumes and its
 * open upload (progress.uploadId), then clear `volumes` and `progress`, so a
 * row with volumes left is retried by maintenance. Never for a job still
 * queued or running: its run owns what it writes.
 */
export async function removeExportObjects(rows: readonly Pick<DataExportRow, "id" | "volumes" | "progress">[], executor: DatabaseExecutor = getDb()): Promise<number> {
  if (!getStorage()) return 0;
  let removed = 0;
  for (const row of rows) {
    await deleteStoredObjects(row.volumes, uploadOf(row.progress));
    await executor.update(dataExports).set({ volumes: [], progress: null })
      .where(and(eq(dataExports.id, row.id), sql`${dataExports.status} NOT IN ('queued', 'running')`));
    removed += 1;
  }
  return removed;
}

export function uploadOf(progress: DataExportProgress | null): { key: string; uploadId: string } | null {
  return progress?.key && progress.uploadId ? { key: progress.key, uploadId: progress.uploadId } : null;
}

/**
 * Account deletion (services/accountDeletion/cleanup.ts): every export the
 * person asked for, personal and server, goes with the account: objects
 * first (an open upload aborted), then the rows. A failure keeps the rest for
 * the next run. A server export of someone else is not touched.
 */
export async function deleteDataExportsOfDeletedUser(userId: string): Promise<"done" | "failed"> {
  // Deleted first, committed: a running export's next write is fenced out, so
  // no volume is recorded after the read below (a volume it finished and
  // could not record, it deletes itself).
  const now = currentDate();
  await getDb().update(dataExports).set({ status: "deleted", deletedAt: now, updatedAt: now })
    .where(and(eq(dataExports.requesterUserId, userId), ne(dataExports.status, "deleted")));
  const rows = await getDb().select().from(dataExports).where(eq(dataExports.requesterUserId, userId));
  let outcome: "done" | "failed" = "done";
  for (const row of rows) {
    try {
      await removeExportObjects([row]);
      await getDb().delete(dataExports).where(eq(dataExports.id, row.id));
    } catch (err) {
      console.error(`[data-export] deleting export ${row.id} of deleted account ${userId} failed:`, serializeErrorForLog(err));
      outcome = "failed";
    }
  }
  return outcome;
}

/**
 * The closed-server purge (closedServerPurgeFinish.ts): the server's server
 * exports, objects then rows, in the purge's batches. A personal export that
 * holds this server's messages is the person's own and stays until its own
 * retention (design §6; a known leftover, docs/development/data-export.md).
 */
export async function deleteServerDataExports(executor: DatabaseExecutor, serverId: string, limit: number): Promise<number> {
  // Locked for the batch's transaction: a running export's next write waits,
  // then finds no row and deletes the volume it could not record.
  const rows = await executor.select().from(dataExports)
    .where(and(eq(dataExports.serverId, serverId), eq(dataExports.kind, "server")))
    .limit(limit)
    .for("update");
  if (rows.length === 0) return 0;
  await removeExportObjects(rows, executor);
  await executor.delete(dataExports).where(inArray(dataExports.id, rows.map((row) => row.id)));
  return rows.length;
}
