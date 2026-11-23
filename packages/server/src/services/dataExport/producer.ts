// What a data export kind plugs into the job framework (#triage:#512,
// docs/development/data-export.md): the job, routes and runner are shared;
// what an archive holds, who may ask for it and what its scope means are the
// kind's producer's, registered at startup (server.ts): personalProducer.ts
// and serverProducer.ts; a kind with none answers 404
// `data_export_kind_unavailable`.
import type { DataExportId, DataExportKind, DataExportScopeOf, JsonValue, ServerId } from "@botiverse/raft-shared";

/** A job as a producer sees it: who asked, for what, and as of when. */
export interface DataExportJob<K extends DataExportKind = DataExportKind> {
  id: DataExportId;
  kind: K;
  requesterUserId: string;
  /** Server exports only. */
  serverId: ServerId | null;
  scope: DataExportScopeOf<K>;
  /**
   * When it was asked: visibility is computed for the requester as of this
   * moment, every batch again (a channel made private since is left out).
   */
  createdAt: Date;
}

/**
 * When a producer is asked whether the requester may still have this:
 * `create` (the route, before the job is written), `batch` (before every
 * batch: a requester who lost the right stops the export) and `download`
 * (every download link: an archive is never handed to someone who could no
 * longer ask for it).
 */
export type DataExportAuthorizeStage = "create" | "batch" | "download";

export type DataExportAuthorization = { ok: true } | { ok: false; code: string; error: string };

/**
 * What a batch writes into the archive, in order:
 *   - `json`: a whole entry (manifest-like files: account.json, users.json);
 *   - `lines`: JSON lines appended to an entry (a month of a conversation);
 *     the entry stays open across batches until another op names a different
 *     path, so a producer emits each path's lines together, never coming
 *     back to a path once it moved on;
 *   - `file`: a stored object's bytes (an attachment), read from storage;
 *     one storage no longer has is skipped (no entry) and its path listed in
 *     manifest.json's `missingFiles`: the export goes on without it.
 * Paths are relative, `/`-separated, never `..`, each written once: the
 * runner fails the export `producer_error` on a path named again
 * (DataExportPathRepeatedError, runner.ts).
 */
export type DataExportOp =
  | { type: "json"; path: string; value: JsonValue }
  | { type: "lines"; path: string; lines: JsonValue[] }
  | { type: "file"; path: string; storageKey: string };

export interface DataExportBatch<C extends JsonValue> {
  ops: DataExportOp[];
  /** Where the next batch starts; null when this was the last. Stored as JSON (a lost run restarts its volume from one). */
  next: C | null;
  /**
   * Files this batch's lines (or an earlier batch's) named but the producer
   * does not write (retracted or revoked since, or out of view): listed in
   * manifest.json `missingFiles` with the ones storage no longer had, once
   * the batch is written (a batch read again adds them once).
   */
  missingFiles?: string[];
  /** Rows written by this batch, added to the job's counts (shown in manifest.json). */
  counts?: Record<string, number>;
  /**
   * The last batch only (next null): the producer's own keys in manifest.json
   * (what was skipped and why). Never the framework's keys, which win.
   */
  manifest?: Record<string, JsonValue>;
}

export type DataExportScopeCheck<K extends DataExportKind> =
  | { ok: true; scope: DataExportScopeOf<K> }
  | { ok: false; status: 400 | 403 | 404 | 409; code: string; error: string };

export interface DataExportProducer<K extends DataExportKind = DataExportKind, C extends JsonValue = JsonValue> {
  kind: K;
  /** Whether the requester may (still) have this export; see DataExportAuthorizeStage. */
  authorize(job: DataExportJob<K>, stage: DataExportAuthorizeStage): Promise<DataExportAuthorization>;
  /**
   * The producer's own checks on a parsed scope before the job is written
   * (the framework has parsed its shape and checked the server-level
   * fullHistoryAfterClose rule): for example, that the named servers are the
   * requester's, or that the owner allows context. May narrow the scope.
   */
  validateScope(input: { requesterUserId: string; serverId: ServerId | null; scope: DataExportScopeOf<K>; now: Date }): Promise<DataExportScopeCheck<K>>;
  initialCursor(job: DataExportJob<K>): C;
  /** A stored cursor back; throw when it is not one of this producer's (the job fails). */
  decodeCursor(raw: JsonValue): C;
  nextBatch(job: DataExportJob<K>, cursor: C): Promise<DataExportBatch<C>>;
}

/** The producers by kind. */
export class DataExportProducerRegistry {
  private readonly producers = new Map<DataExportKind, DataExportProducer>();

  register<K extends DataExportKind, C extends JsonValue>(producer: DataExportProducer<K, C>): this {
    if (this.producers.has(producer.kind)) throw new Error(`DATA_EXPORT_PRODUCER_DUPLICATE:${producer.kind}`);
    this.producers.set(producer.kind, producer as unknown as DataExportProducer);
    return this;
  }

  /** The kind's producer, typed for its kind (register keyed it by `producer.kind`). */
  get<K extends DataExportKind>(kind: K): DataExportProducer<K> | undefined {
    return this.producers.get(kind) as DataExportProducer<K> | undefined;
  }

  /** Tests: drop a kind registered for a test. */
  unregister(kind: DataExportKind): void {
    this.producers.delete(kind);
  }
}

/** The process's producers: routes and the runner both read it. */
export const dataExportProducers = new DataExportProducerRegistry();
