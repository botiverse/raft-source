/**
 * #244 (flag `inbox_row_position_v1`): what an Activity row's read seq
 * (shared reduceActivityRow's `readSeq` / `readSeqCeiling`, #15301) learns
 * from the read-state ledger (readStateSync). inboxRowPosition.ts keeps the
 * row's state; this module says which reducer events the ledger's accepted
 * read state brings, whichever path accepted it: a socket or HTTP read-state
 * update (applyReadStateUpdate), or a served row's `readState` (a list
 * answer, a row re-read, another snapshot).
 *
 * Folded once per accepted version, per conversation:
 * - marked unread (nothing countable), or its cursor below the last folded
 *   one or the row's read seq, whichever is higher (a counted Mark as Unread:
 *   the server rewinds the cursor and sends no flag; a send of mine raises the
 *   read seq here with a version this tab may never fold): `markUnread`, so an
 *   answer at or below the old read keeps its unread. A false alarm only drops
 *   the read seq (safe); a missed mark would hide an unread;
 * - otherwise: a `read` at its cursor;
 * - no accepted state any more, or an older version than the one folded (the
 *   cursor row deleted, e.g. access lost, and begun again): `forget`, the fold
 *   and the row's read seq and ceiling go (safe), so a new v1 is not ignored.
 * Past ROW_STATE_CAP conversations the oldest fold goes, as the row states do;
 * the row's read seq still catches a rewind below it.
 */
import type { ActivityRowEvent, ActivityRowState } from "@botiverse/raft-shared";
import { getAcceptedReadState } from "./readStateSync";

export type RowReadEvent = Extract<ActivityRowEvent, { type: "read" | "markUnread" }>;

type Folded = { readStateVersion: number; maxReadSeq: number };

const FOLD_CAP = 500;
const folded = new Map<string, Folded>();

/** The read seq and ceiling of a kept row state, without absent keys. */
export function rowReadFields(row: Pick<ActivityRowState, "readSeq" | "readSeqCeiling"> | undefined): Pick<ActivityRowState, "readSeq" | "readSeqCeiling"> {
  return {
    ...(row?.readSeq === undefined ? {} : { readSeq: row.readSeq }),
    ...(row?.readSeqCeiling === undefined ? {} : { readSeqCeiling: row.readSeqCeiling }),
  };
}

/**
 * The reducer events the ledger's accepted read state for the scope brings
 * since the last fold (none: nothing new), against the row's read seq
 * (`readSeq`); `forget`: drop the row's read seq and ceiling.
 */
export function takeLedgerReadEvents(serverId: string | null, scopeId: string, readSeq: string | undefined): RowReadEvent[] | "forget" {
  const accepted = getAcceptedReadState(serverId, scopeId);
  const last = folded.get(scopeId);
  if (last && (!accepted || accepted.readStateVersion < last.readStateVersion)) {
    folded.delete(scopeId);
    return "forget";
  }
  if (!accepted || (last && accepted.readStateVersion <= last.readStateVersion)) return [];
  folded.delete(scopeId);
  folded.set(scopeId, { readStateVersion: accepted.readStateVersion, maxReadSeq: accepted.maxReadSeq });
  while (folded.size > FOLD_CAP) folded.delete(folded.keys().next().value!);
  if (accepted.markedUnread) return [{ type: "markUnread" }];
  const read: RowReadEvent = { type: "read", seq: String(accepted.maxReadSeq) };
  const cursor = BigInt(accepted.maxReadSeq);
  const rewound = (last !== undefined && cursor < BigInt(last.maxReadSeq)) || (readSeq !== undefined && cursor < BigInt(readSeq));
  return rewound ? [{ type: "markUnread" }, read] : [read];
}

/** A server switch, or the row states cleared (inboxRowPosition clearRowPosition). */
export function clearLedgerReadFolds(): void {
  folded.clear();
}
