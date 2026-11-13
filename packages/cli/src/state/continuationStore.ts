// The CLI's ContinuationStore (shared/src/continuations/store.ts): the agent
// ledger (./agentLedger.ts) of one agent, $SLOCK_HOME/agent-state/<agentId>/
// state.db, as the store the continuation runtime keeps paused commands in.
// Records and tombstones are stored as JSON, so what comes back is what JSON
// round-trips, like the reference memory store.
//
// The store only stores: who may resume a record (`ownerAgentId`), expiry and
// answering once are the runtime's rules. One ledger per agent means another
// agent's CLI does not even find the record; the runtime's owner check is what
// holds when two agents share a store. Every method answers synchronously and
// throws when the ledger cannot read or write (see agentLedger.ts).

import type {
  ContinuationId,
  ContinuationRecord,
  ContinuationStore,
  ContinuationTombstone,
} from "@botiverse/raft-shared/src/continuations/index";

import {
  deleteContinuationRow,
  deleteExpiredContinuationRows,
  insertContinuationRow,
  readContinuationRow,
  readContinuationTombstoneRow,
  updateContinuationRow,
  writeContinuationTombstoneRow,
} from "./agentLedger";

/** A ContinuationStore whose every answer is synchronous. */
export interface SyncContinuationStore extends ContinuationStore {
  put(record: ContinuationRecord): boolean;
  get(id: ContinuationId): ContinuationRecord | undefined;
  update(record: ContinuationRecord, expectedRevision: number): boolean;
  delete(id: ContinuationId): void;
  putTombstone(tombstone: ContinuationTombstone): void;
  getTombstone(id: ContinuationId): ContinuationTombstone | undefined;
  deleteExpired(now: number): number;
}

const rowOf = (record: ContinuationRecord) => ({
  id: record.id,
  revision: record.revision,
  deleteAfter: record.deleteAfter,
  payload: JSON.stringify(record),
});

/** The ledger store of `agentId`; `env` locates the ledger, as for every ledger call. */
export function createCliContinuationStore(agentId: string, env: NodeJS.ProcessEnv): SyncContinuationStore {
  return {
    put: (record) => insertContinuationRow(agentId, rowOf(record), env),
    get: (id) => {
      const payload = readContinuationRow(agentId, id, env);
      return payload === undefined ? undefined : JSON.parse(payload) as ContinuationRecord;
    },
    update: (record, expectedRevision) => updateContinuationRow(agentId, rowOf(record), expectedRevision, env),
    delete: (id) => deleteContinuationRow(agentId, id, env),
    putTombstone: (tombstone) => writeContinuationTombstoneRow(
      agentId,
      { id: tombstone.id, deleteAfter: tombstone.deleteAfter, payload: JSON.stringify(tombstone) },
      env,
    ),
    getTombstone: (id) => {
      const payload = readContinuationTombstoneRow(agentId, id, env);
      return payload === undefined ? undefined : JSON.parse(payload) as ContinuationTombstone;
    },
    deleteExpired: (now) => deleteExpiredContinuationRows(agentId, now, env),
  };
}
