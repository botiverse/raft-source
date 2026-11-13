// Where continuation records live. The runtime (runtime.ts) owns every rule
// (ownership, expiry, retention, answering once); a store only keeps records
// and tombstones, makes updates conditional, and deletes by `deleteAfter`
// alone. The CLI backs it with its agent ledger, the SDK with local files;
// `createMemoryContinuationStore` (memoryStore.ts) is the reference, and
// store.testkit.ts is the contract every store runs.

import type { MaybePromise } from "../maybePromise";
import type { ContinuationId, ContinuationRecord, ContinuationTombstone } from "./record";

export type { MaybePromise };

/**
 * Methods may answer synchronously (the CLI's SQLite ledger) or not; the
 * runtime awaits either. Records come back as JSON round-trips them, never
 * as the object that was written.
 */
export interface ContinuationStore {
  /** Insert a new record. False, writing nothing, when the id is taken. */
  put(record: ContinuationRecord): MaybePromise<boolean>;
  /** The record, expired or not (the runtime reports expiry), or undefined. */
  get(id: ContinuationId): MaybePromise<ContinuationRecord | undefined>;
  /**
   * Replace the record with `record.id` only while its stored revision is
   * `expectedRevision`. False, writing nothing, when it moved on or is gone.
   */
  update(record: ContinuationRecord, expectedRevision: number): MaybePromise<boolean>;
  /** Delete the record (not its tombstone); nothing happens when there is none. */
  delete(id: ContinuationId): MaybePromise<void>;
  /** Write the tombstone for `tombstone.id`, replacing any earlier one. */
  putTombstone(tombstone: ContinuationTombstone): MaybePromise<void>;
  getTombstone(id: ContinuationId): MaybePromise<ContinuationTombstone | undefined>;
  /**
   * Delete every record and tombstone whose `deleteAfter` is before `now`,
   * whatever else it holds (status, deadline, lease); answers how many.
   */
  deleteExpired(now: number): MaybePromise<number>;
}
