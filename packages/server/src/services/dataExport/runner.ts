// Writing an export's archive (#triage:#512, docs/development/data-export.md):
// the durable task `data_export.generate` (RFC 073), created in the
// transaction that writes the job and run inline after commit; any replica
// recovers it once its lease ran out (its own registry, always on:
// server.ts). The archive is streamed op by op from the kind's producer into
// zip volumes (lib/dataExport/streamingZip.ts) uploaded in parts
// (multipartSink.ts); nothing holds a whole volume in memory.
//
// One run at a time owns a job. A run takes the job over by writing its own
// run token into data_exports.progress, and every later write of the run is
// fenced on that token (and status = 'running'): a run that lost its lease
// and kept going (a slow batch, a paused process) writes nothing once a newer
// run took over. Each run writes its volumes under its own keys
// (`data-exports/v1/<id>/<n>-<run token>.zip`), so a stale run's clean-up
// only ever deletes objects no row names. The durable lease is extended
// before every batch, every op and every part (at most every 20 s).
//
// Resume is per volume: the producer's cursor (and the paths of that batch's
// ops already written) when the volume began, and the volume's upload id
// (recorded before its first part), are in progress. The next run aborts
// that upload and writes the volume again from there. A volume that fails is
// aborted at once (Tenny 542c7777); an upload whose id never got recorded is
// aborted by maintenance (maintenance.ts, listMultipartUploads).
//
// Before every batch: the flag and its kill switch (off: the export fails,
// `export_disabled`; a flag that can't be read is retried), the producer's
// authorize(`batch`), and for a server export the requester's
// exportServerData (lost: fails, `not_authorized`). A job deleted meanwhile
// (by its requester, or an account or server deletion) fails the fence and
// the run stops, deleting only what it wrote and could not record.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { currentDate, DATA_EXPORT_RETENTION_MS, type JsonValue } from "@botiverse/raft-shared";

import { getDb } from "../../db/index";
import { dataExports, type DataExportProgress, type DataExportVolume } from "../../db/schema";
import { MultipartSink } from "../../lib/dataExport/multipartSink";
import { StreamingZipWriter } from "../../lib/dataExport/streamingZip";
import { serializeErrorForLog } from "../../tracing/safeErrorLog";
import {
  durableTaskBackoffMs,
  durableTaskKind,
  DurableTaskDeferral,
  DurableTaskPermanentError,
  DurableTaskRegistry,
  runDurableTask,
  type DurableTaskClaim,
  type DurableTaskContext,
  type DurableTaskDefinition,
} from "../durableTasks";
import { getStorage, type MultipartStorage, type StorageBackend } from "../storageService";
import {
  canExportServer,
  dataExportFlagEnabled,
  dataExportJobOf,
  dataExportVolumeKey,
  deleteStoredObjects,
  removeExportObjects,
  serverExportAccessOf,
  uploadOf,
  type DataExportRow,
} from "./jobs";
import { notifyDataExportOutcome } from "./notifications";
import { dataExportProducers, type DataExportJob, type DataExportOp, type DataExportProducer, type DataExportProducerRegistry } from "./producer";

/**
 * A volume is closed after the first op where the archive bytes stored reach
 * this, or the bytes fed into it reach twice this: the compressed output of
 * an entry still open lags behind what was fed, and the fed bound alone keeps
 * a volume under 2 GiB plus one op (design v7 §7). Checked after every op;
 * the next volume starts at the op after it.
 */
export const DATA_EXPORT_VOLUME_BYTES = 1024 * 1024 * 1024;
/** An export that needs more volumes than this fails `too_large`. */
export const DATA_EXPORT_MAX_VOLUMES = 64;
export const DATA_EXPORT_MANIFEST_FORMAT_VERSION = 1;
/** The longest a run goes without extending its durable lease (the lease is 120 s). */
export const DATA_EXPORT_LEASE_BEAT_MS = 20_000;

/** Why an export failed (data_exports.error_code); clients map them to copy. */
export type DataExportErrorCode =
  | "export_disabled"
  | "kind_unavailable"
  | "not_authorized"
  | "storage_unavailable"
  | "too_large"
  | "invalid_cursor"
  /** The producer broke the op rules (a path written twice): a bug, never retried into the same failure. */
  | "producer_error"
  | "stuck";

export interface DataExportTaskPayload { exportId: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Slots: how many exports this process writes at once ──

/** DATA_EXPORT_CONCURRENCY when unset or not a number: each export holds a part (8 MiB) and a batch in memory. */
export const DEFAULT_DATA_EXPORT_CONCURRENCY = 2;
/** A task that found every slot taken comes back after this, its attempt not counted. */
export const DATA_EXPORT_BUSY_DEFER_MS = 30_000;
let running = 0;

export function dataExportConcurrency(raw = process.env.DATA_EXPORT_CONCURRENCY): number {
  const value = Number(raw?.trim());
  if (!raw?.trim() || !Number.isFinite(value)) return DEFAULT_DATA_EXPORT_CONCURRENCY;
  return Math.min(16, Math.max(1, Math.floor(value)));
}

// ── The run ──

/** The run no longer owns the job (fenced out, or the job ended): stop, nothing to retry. */
class ExportGone extends Error {}

/**
 * A producer named a path this volume already wrote (producer.ts: each path
 * once; only a `lines` op continuing the entry still open names it again).
 * Writing it would put two entries of one name in the zip, or lose lines;
 * skipping it would hide the bug. Only the paths a resumed volume starts
 * with (progress.writtenPathsAtVolumeStart: its first batch read again) are
 * skipped. Tenny (PR3).
 */
export class DataExportPathRepeatedError extends Error {
  constructor(readonly path: string) {
    super(`DATA_EXPORT_PATH_REPEATED:${path}`);
  }
}

export interface DataExportRunDeps {
  producers?: DataExportProducerRegistry;
  storage?: MultipartStorage | null;
  now?: () => Date;
  volumeBytes?: number;
  notify?: typeof notifyDataExportOutcome;
  /** Tests: the run's token (else a new one). */
  runToken?: string;
  /** Tests: the flag read (else dataExportFlagEnabled). */
  flagEnabled?: typeof dataExportFlagEnabled;
}

/** The job, still running, still this run's. */
function owned(id: string, runToken: string) {
  return and(eq(dataExports.id, id), eq(dataExports.status, "running"), sql`${dataExports.progress}->>'runToken' = ${runToken}`);
}

/** A write fenced on the job still being this run's; false when it is not. */
async function updateOwned(id: string, runToken: string, set: Partial<typeof dataExports.$inferInsert>, now: Date): Promise<boolean> {
  const updated = await getDb().update(dataExports).set({ ...set, updatedAt: now })
    .where(owned(id, runToken))
    .returning({ id: dataExports.id });
  return updated.length === 1;
}

/**
 * End a job as failed, drop what it stored, and tell the requester. With
 * `runToken` (the runner) only while that run owns it; without (maintenance)
 * from queued or running. False when it had already left those.
 */
export async function failDataExport(id: string, code: DataExportErrorCode, now: Date, notify: typeof notifyDataExportOutcome = notifyDataExportOutcome, runToken?: string): Promise<boolean> {
  const [row] = await getDb().update(dataExports)
    .set({ status: "failed", errorCode: code, finishedAt: now, updatedAt: now })
    .where(runToken ? owned(id, runToken) : and(eq(dataExports.id, id), sql`${dataExports.status} IN ('queued', 'running')`))
    .returning();
  if (!row) return false;
  await removeExportObjects([row]).catch((err) => console.error(`[data-export] cleaning up failed export ${id} failed:`, serializeErrorForLog(err)));
  await notify(row, "failed", now);
  return true;
}

/** `conversations/a/2026-11.jsonl` continued in volume 3: `conversations/a/2026-11.part3.jsonl`. */
export function continuedEntryName(path: string, volume: number): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? `${path.slice(0, dot)}.part${volume}${path.slice(dot)}` : `${path}.part${volume}`;
}

/** The durable lease, extended at most every DATA_EXPORT_LEASE_BEAT_MS; a fenced-out attempt throws ExportGone. */
class Lease {
  private last = 0;
  constructor(private readonly context: Pick<DurableTaskContext, "extendLease">, private readonly clock: () => number = Date.now) {}

  async beat(force = false): Promise<void> {
    const now = this.clock();
    if (!force && now - this.last < DATA_EXPORT_LEASE_BEAT_MS) return;
    if (!(await this.context.extendLease())) throw new ExportGone();
    this.last = now;
  }
}

/** Multipart with the lease extended before every part. */
function leasedMultipart(multipart: MultipartStorage, lease: Lease): MultipartStorage {
  return {
    ...multipart,
    uploadPart: async (key, uploadId, partNumber, body) => {
      await lease.beat();
      return multipart.uploadPart(key, uploadId, partNumber, body);
    },
  };
}

/** Writes one volume's ops in order; a `lines` entry stays open until another path comes. */
class VolumeWriter {
  private open: string | null = null;
  /** Uncompressed bytes given to the zip (a file's as they stream). */
  fed = 0;
  /** Every `file` op skipped so far, this volume's and the earlier ones' (manifest.json `missingFiles`). */
  readonly missingFiles: string[];
  constructor(
    readonly zip: StreamingZipWriter,
    private readonly volume: number,
    private readonly continued: string | null,
    private readonly storage: ExportObjects,
    private readonly lease: Lease,
    missingAtStart: readonly string[],
  ) {
    this.missingFiles = [...missingAtStart];
  }

  /** Files the producer itself reports not written (a batch's `missingFiles`), once each. */
  addMissing(paths: readonly string[] | undefined): void {
    for (const path of paths ?? []) if (!this.missingFiles.includes(path)) this.missingFiles.push(path);
  }

  get openPath(): string | null {
    return this.open;
  }

  private name(path: string): string {
    return path === this.continued ? continuedEntryName(path, this.volume) : path;
  }

  async closeOpen(): Promise<void> {
    if (!this.open) return;
    await this.zip.endEntry();
    this.open = null;
  }

  /** Writes the op; false only for a `file` op whose object storage confirmed missing (skipped, listed). */
  async apply(op: DataExportOp): Promise<boolean> {
    await this.lease.beat();
    if (op.type === "lines" && this.open === op.path) {
      await this.writeLines(op.lines);
      return true;
    }
    await this.closeOpen();
    if (op.type === "json") {
      const bytes = Buffer.from(`${JSON.stringify(op.value, null, 2)}\n`);
      this.fed += bytes.length;
      await this.zip.addBytes(this.name(op.path), bytes);
    } else if (op.type === "lines") {
      await this.zip.beginEntry(this.name(op.path));
      this.open = op.path;
      await this.writeLines(op.lines);
    } else {
      let source: AsyncIterable<Buffer | Uint8Array | string>;
      try {
        source = await this.storage.get(op.storageKey);
      } catch (err) {
        // Skipped (no entry, named in the manifest) only when storage confirms this object is gone
        // (probeObjectPresence: NoSuchKey, or ENOENT under a verified root). A backend that can't tell,
        // or is unavailable (a missing bucket's 404, an unmounted disk), fails the volume: a storage
        // outage must never end as a ready export without its files.
        const presence = this.storage.probeObjectPresence
          ? await this.storage.probeObjectPresence(op.storageKey).catch(() => "unknown" as const)
          : "unknown";
        if (presence !== "missing") throw err;
        this.missingFiles.push(op.path);
        return false;
      }
      const counted = async function* (writer: VolumeWriter) {
        for await (const chunk of source) {
          writer.fed += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
          // A big file is many parts (each beats), a slow one may be few: beat as it streams too.
          await writer.lease.beat();
          yield chunk;
        }
      };
      await this.zip.addStream(this.name(op.path), counted(this));
    }
    return true;
  }

  private async writeLines(lines: readonly JsonValue[]): Promise<void> {
    const bytes = Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    this.fed += bytes.length;
    await this.zip.write(bytes);
  }
}

/** What the runner reads attachments' bytes with. */
type ExportObjects = Pick<StorageBackend, "probeObjectPresence"> & { get(key: string): Promise<AsyncIterable<Buffer | Uint8Array | string>> };

function addCounts(into: Record<string, number>, more: Record<string, number> | undefined): void {
  for (const [key, n] of Object.entries(more ?? {})) into[key] = (into[key] ?? 0) + n;
}

function manifestOf(job: DataExportJob, input: { volume: number; volumes: DataExportVolume[]; counts: Record<string, number>; missingFiles: string[]; generatedAt: Date; extra: Record<string, JsonValue> | undefined }): JsonValue {
  return {
    // The producer's own keys first: the framework's below win.
    ...input.extra,
    formatVersion: DATA_EXPORT_MANIFEST_FORMAT_VERSION,
    exportId: job.id,
    kind: job.kind,
    requestedAt: job.createdAt.toISOString(),
    generatedAt: input.generatedAt.toISOString(),
    requesterUserId: job.requesterUserId,
    serverId: job.serverId,
    scope: job.scope as unknown as JsonValue,
    volume: input.volume,
    // This volume's own checksum can't be inside it; the earlier volumes' are.
    earlierVolumes: input.volumes.map((volume) => ({ index: volume.index, sizeBytes: volume.sizeBytes, sha256: volume.sha256, entries: volume.entries })),
    counts: input.counts,
    // Files the archive was meant to hold but storage no longer had.
    missingFiles: input.missingFiles,
  };
}

function freshProgress(cursor: JsonValue | null, runToken: string): DataExportProgress {
  return { runToken, volume: 1, cursorAtVolumeStart: cursor, writtenPathsAtVolumeStart: [], openPathAtVolumeStart: null, key: null, uploadId: null, counts: {}, missingFiles: [] };
}

/** Run (or resume) the export. Idempotent: a job no longer queued or running is left alone. */
export async function generateDataExport(exportId: string, context: Pick<DurableTaskContext, "extendLease">, deps: DataExportRunDeps = {}): Promise<void> {
  const clock = deps.now ?? currentDate;
  const notify = deps.notify ?? notifyDataExportOutcome;
  const runToken = deps.runToken ?? randomUUID();
  const [row] = await getDb().select().from(dataExports).where(eq(dataExports.id, exportId));
  if (!row || (row.status !== "queued" && row.status !== "running")) return;
  const job = dataExportJobOf(row);
  const producer = (deps.producers ?? dataExportProducers).get(row.kind);
  const multipart = deps.storage === undefined ? getStorage()?.multipart ?? null : deps.storage;
  const objects = getStorage();

  // Take the job over: from now on every write of an earlier run is fenced out.
  const previous = row.progress;
  const progress: DataExportProgress = previous
    ? { ...previous, runToken, key: null, uploadId: null }
    : freshProgress(producer ? producer.initialCursor(job) : null, runToken);
  const [taken] = await getDb().update(dataExports)
    .set({ status: "running", ...(row.status === "queued" ? { startedAt: clock() } : {}), progress, updatedAt: clock() })
    .where(and(
      eq(dataExports.id, row.id),
      eq(dataExports.status, row.status),
      sql`${dataExports.progress}->>'runToken' IS NOT DISTINCT FROM ${previous?.runToken ?? null}`,
    ))
    .returning({ id: dataExports.id });
  if (!taken) return;
  // The previous run's volume: discard its parts (that run can no longer record anything).
  const lost = uploadOf(previous);
  if (lost && multipart) await multipart.abortMultipartUpload(lost.key, lost.uploadId);

  // A read error is retried; only a flag that reads off fails the export.
  const flagEnabled = deps.flagEnabled ?? dataExportFlagEnabled;
  if (!(await flagEnabled({ userId: job.requesterUserId, serverId: job.serverId }))) {
    await failDataExport(row.id, "export_disabled", clock(), notify, runToken);
    return;
  }
  if (!producer) {
    await failDataExport(row.id, "kind_unavailable", clock(), notify, runToken);
    return;
  }
  if (!multipart || !objects) {
    await failDataExport(row.id, "storage_unavailable", clock(), notify, runToken);
    return;
  }

  const lease = new Lease(context, () => clock().getTime());
  const volumes = [...row.volumes];
  const volumeBytes = deps.volumeBytes ?? DATA_EXPORT_VOLUME_BYTES;
  let current = progress;
  try {
    for (;;) {
      if (current.volume > DATA_EXPORT_MAX_VOLUMES) {
        await failDataExport(row.id, "too_large", clock(), notify, runToken);
        return;
      }
      const next = await writeVolume({ row, job, producer, progress: current, runToken, volumes, multipart: leasedMultipart(multipart, lease), objects, lease, clock, volumeBytes, notify, flagEnabled });
      if (next === "done") return;
      current = next;
    }
  } catch (err) {
    if (err instanceof ExportGone) return;
    throw err;
  }
}

/** One volume, from progress's start: the next volume's progress, or done (ready, failed or gone). */
async function writeVolume(input: {
  row: DataExportRow;
  job: DataExportJob;
  producer: DataExportProducer;
  progress: DataExportProgress;
  runToken: string;
  volumes: DataExportVolume[];
  multipart: MultipartStorage;
  objects: ExportObjects;
  lease: Lease;
  clock: () => Date;
  volumeBytes: number;
  notify: typeof notifyDataExportOutcome;
  flagEnabled: typeof dataExportFlagEnabled;
}): Promise<DataExportProgress | "done"> {
  const { row, job, producer, progress, runToken, volumes, multipart, lease, clock } = input;
  const fail = (code: DataExportErrorCode) => failDataExport(row.id, code, clock(), input.notify, runToken);
  const key = dataExportVolumeKey(row.id, progress.volume, runToken);
  let cursor: JsonValue;
  try {
    cursor = producer.decodeCursor(progress.cursorAtVolumeStart ?? producer.initialCursor(job));
  } catch {
    await fail("invalid_cursor");
    return "done";
  }
  const sink = await MultipartSink.open(multipart, key, "application/zip");
  if (!(await updateOwned(row.id, runToken, { progress: { ...progress, key, uploadId: sink.uploadId } }, clock()))) {
    await sink.abort();
    throw new ExportGone();
  }
  const zip = new StreamingZipWriter(sink, job.createdAt);
  const writer = new VolumeWriter(zip, progress.volume, progress.openPathAtVolumeStart, input.objects, lease, progress.missingFiles ?? []);
  const counts = { ...progress.counts };
  // The ops of the volume's first batch the previous volume already holds, by path (paths are written
  // once): the batch read again may have shifted (a message retracted, a channel made private since),
  // so a count of ops would skip the wrong ones. Only that first batch skips them.
  let resumed = new Set(progress.writtenPathsAtVolumeStart ?? []);
  /** This batch's paths written so far, the resumed ones included (a volume cut mid-batch records them). */
  let written = new Set(resumed);
  /** Every path this volume wrote: one named again (but the open entry's lines) is a producer bug. */
  const inVolume = new Set<string>();
  let stopped = false;
  /** Close this volume; if the job is no longer ours, its object goes (no row names it). */
  const finishVolume = async (): Promise<DataExportVolume> => {
    await zip.finish();
    const uploaded = await sink.complete();
    return { index: progress.volume, key, sizeBytes: uploaded.sizeBytes, sha256: uploaded.sha256, entries: zip.entryCount };
  };
  const unrecorded = async (volume: DataExportVolume): Promise<never> => {
    await deleteStoredObjects([volume], null).catch(() => undefined);
    throw new ExportGone();
  };
  try {
    for (;;) {
      await lease.beat(true);
      if (!(await input.flagEnabled({ userId: job.requesterUserId, serverId: job.serverId }))) {
        stopped = true;
        await sink.abort();
        await fail("export_disabled");
        return "done";
      }
      const allowed = await producer.authorize(job, "batch");
      const serverAllowed = job.serverId === null || canExportServer(await serverExportAccessOf(job.serverId, job.requesterUserId));
      if (!allowed.ok || !serverAllowed) {
        stopped = true;
        await sink.abort();
        await fail("not_authorized");
        return "done";
      }
      const batch = await producer.nextBatch(job, cursor);
      for (let index = 0; index < batch.ops.length; index += 1) {
        const op = batch.ops[index]!;
        if (resumed.has(op.path)) continue;
        const continuesOpen = op.type === "lines" && writer.openPath === op.path;
        if (!continuesOpen && inVolume.has(op.path)) throw new DataExportPathRepeatedError(op.path);
        inVolume.add(op.path);
        // `files` counts the file entries written (the runner's: a missing one is not one).
        if (await writer.apply(op) && op.type === "file") counts.files = (counts.files ?? 0) + 1;
        written.add(op.path);
        const lastOp = index === batch.ops.length - 1;
        const full = zip.bytesWritten >= input.volumeBytes || writer.fed >= 2 * input.volumeBytes;
        if (!full || (lastOp && batch.next === null)) continue;
        // Full: this volume ends after this op; the next starts at the op after it.
        if (lastOp) {
          addCounts(counts, batch.counts);
          writer.addMissing(batch.missingFiles);
        }
        const carried = writer.openPath;
        await writer.closeOpen();
        const volume = await finishVolume();
        const recorded = [...volumes, volume];
        const nextProgress: DataExportProgress = {
          runToken,
          volume: progress.volume + 1,
          cursorAtVolumeStart: lastOp ? batch.next : cursor,
          writtenPathsAtVolumeStart: lastOp ? [] : [...written],
          openPathAtVolumeStart: carried,
          key: null,
          uploadId: null,
          counts,
          missingFiles: writer.missingFiles,
        };
        if (!(await updateOwned(row.id, runToken, { volumes: recorded, progress: nextProgress }, clock()))) return await unrecorded(volume);
        volumes.push(volume);
        return nextProgress;
      }
      resumed = new Set();
      written = new Set();
      addCounts(counts, batch.counts);
      writer.addMissing(batch.missingFiles);
      if (batch.next === null) {
        await writer.closeOpen();
        await zip.addBytes("manifest.json", Buffer.from(`${JSON.stringify(manifestOf(job, { volume: progress.volume, volumes, counts, missingFiles: writer.missingFiles, generatedAt: clock(), extra: batch.manifest }), null, 2)}\n`));
        const volume = await finishVolume();
        if (!(await markReady(row, runToken, [...volumes, volume], counts, writer.missingFiles, clock(), input.notify))) return await unrecorded(volume);
        return "done";
      }
      cursor = batch.next;
      // Still ours? A delete meanwhile ends the run here, not at the end of the archive.
      if (!(await updateOwned(row.id, runToken, {}, clock()))) throw new ExportGone();
    }
  } catch (err) {
    if (stopped) throw err;
    // The volume failed (or the run lost the job): its parts are discarded now, not left for maintenance.
    zip.abort(err);
    await sink.abort().catch((abortErr) => console.error(`[data-export] aborting the upload of ${key} failed:`, serializeErrorForLog(abortErr)));
    if (err instanceof ExportGone) throw err;
    if (err instanceof DataExportPathRepeatedError) {
      // A bug, not an outage: a retry reads the same batch again. Fail it now (not counted against the limits).
      console.error(`[data-export] ${row.kind} producer wrote ${err.path} twice in export ${row.id}`);
      await fail("producer_error");
      return "done";
    }
    // Not ours any more (taken over, deleted: its upload was aborted under it): stop, nothing to retry.
    if (!(await updateOwned(row.id, runToken, { progress: { ...progress, key: null, uploadId: null } }, clock()).catch(() => true))) throw new ExportGone();
    throw err;
  }
}

/** Ready, if the job is still this run's. */
async function markReady(row: DataExportRow, runToken: string, volumes: DataExportVolume[], counts: Record<string, number>, missingFiles: string[], now: Date, notify: typeof notifyDataExportOutcome): Promise<boolean> {
  const [ready] = await getDb().update(dataExports)
    .set({
      status: "ready",
      volumes,
      sizeBytes: volumes.reduce((total, volume) => total + volume.sizeBytes, 0),
      progress: { runToken, volume: volumes.length, cursorAtVolumeStart: null, writtenPathsAtVolumeStart: [], openPathAtVolumeStart: null, key: null, uploadId: null, counts, missingFiles },
      finishedAt: now,
      expiresAt: new Date(now.getTime() + DATA_EXPORT_RETENTION_MS),
      updatedAt: now,
    })
    .where(owned(row.id, runToken))
    .returning();
  if (!ready) return false;
  await notify(ready, "ready", now);
  return true;
}

// ── The durable task ──

/** Retries come back within 15 minutes (a storage hiccup, a flag that can't be read), never graphile's hours. */
const MAX_BACKOFF_MS = 15 * 60_000;

export const dataExportTaskDefinition: DurableTaskDefinition<DataExportTaskPayload> = {
  kind: durableTaskKind("data_export.generate"),
  payloadVersion: 1,
  // Extended before every batch, op and part (Lease).
  leaseMs: 120_000,
  maxAttempts: 30,
  backoffMs: (attempt) => Math.min(durableTaskBackoffMs(attempt), MAX_BACKOFF_MS),
  decode(payload, version) {
    if (version !== 1 || typeof payload !== "object" || payload === null
      || !("exportId" in payload) || typeof payload.exportId !== "string" || !UUID_RE.test(payload.exportId)) {
      throw new DurableTaskPermanentError("DATA_EXPORT_PAYLOAD_INVALID");
    }
    return { exportId: payload.exportId };
  },
  async handle(payload, context) {
    // Every slot taken: back in a while, without spending an attempt (a busy hour never fails an export).
    if (running >= dataExportConcurrency()) throw new DurableTaskDeferral(DATA_EXPORT_BUSY_DEFER_MS, "DATA_EXPORT_BUSY");
    running += 1;
    try {
      await generateDataExport(payload.exportId, context);
    } finally {
      running -= 1;
    }
  },
};

// Recovered on every replica, independent of the legacy durable-task switch
// (as jointHostSideArchiveRegistry).
export const dataExportTaskRegistry = new DurableTaskRegistry().register(dataExportTaskDefinition);

/** The inline run after the create's commit: in the background, never holding the request. */
export function startDataExportRun(claim: DurableTaskClaim): void {
  void runDurableTask(claim, dataExportTaskRegistry).catch((err) => {
    console.error(`[data-export] run of task ${claim.task.id} failed:`, serializeErrorForLog(err));
  });
}

/** Tests: the slots in use. */
export const dataExportRunsInFlight = (): number => running;
/** Tests: take every slot (true) or give them back (false). */
export function __fillDataExportSlotsForTests(fill: boolean): void {
  running = fill ? dataExportConcurrency() : 0;
}
