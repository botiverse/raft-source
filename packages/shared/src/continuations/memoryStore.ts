// In-memory ContinuationStore: the reference semantics of the store contract
// (store.ts). Rows are kept serialized, like a file or a SQLite row, so a
// caller can never share an object with the store. Used by tests and by
// drivers that keep continuations in a long-lived process.

import type { ContinuationId, ContinuationRecord, ContinuationTombstone } from "./record";
import type { ContinuationStore } from "./store";

type Row = { revision: number; deleteAfter: number; json: string };

export function createMemoryContinuationStore(): ContinuationStore {
  const rows = new Map<ContinuationId, Row>();
  const tombstones = new Map<ContinuationId, { deleteAfter: number; json: string }>();
  const write = (record: ContinuationRecord): void => {
    rows.set(record.id, { revision: record.revision, deleteAfter: record.deleteAfter, json: JSON.stringify(record) });
  };

  return {
    put(record) {
      if (rows.has(record.id)) return false;
      write(record);
      return true;
    },
    get(id) {
      const row = rows.get(id);
      return row === undefined ? undefined : JSON.parse(row.json) as ContinuationRecord;
    },
    update(record, expectedRevision) {
      if (rows.get(record.id)?.revision !== expectedRevision) return false;
      write(record);
      return true;
    },
    delete(id) {
      rows.delete(id);
    },
    putTombstone(tombstone) {
      tombstones.set(tombstone.id, { deleteAfter: tombstone.deleteAfter, json: JSON.stringify(tombstone) });
    },
    getTombstone(id) {
      const row = tombstones.get(id);
      return row === undefined ? undefined : JSON.parse(row.json) as ContinuationTombstone;
    },
    deleteExpired(now) {
      let deleted = 0;
      for (const table of [rows, tombstones]) {
        for (const [id, row] of table) {
          if (row.deleteAfter < now && table.delete(id)) deleted += 1;
        }
      }
      return deleted;
    },
  };
}
