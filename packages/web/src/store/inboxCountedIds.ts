/**
 * #244 under-count: the live messages each Activity row was patched with since
 * its last served answer, so one that comes late (an older seq than the row,
 * after a newer one) or that the store first got from a catch-up is counted
 * once, and a repeat of it never again.
 *
 * Per row (keyed by its scope: the channel, DM, thread or task conversation
 * id): the highest seq a served answer had for it, and the ids (with their
 * seqs) of the live messages applied to it since. A served answer for the row
 * drops only the ids it covers (seq at or below the served seq): an answer
 * still behind a counted message leaves it counted, so a repeat does not count
 * again. The served seq never moves back; a reset answer also forgets the
 * rows it does not list. Bounded: past
 * COUNTED_IDS_PER_ROW ids on a row or COUNTED_IDS_TOTAL in all, an id is not
 * kept, the row stops counting late messages until an answer covers it
 * (`blindTo`), and the caller asks for a re-read instead.
 */
import { compareActivitySeq } from "./activitySeq";
import { inboxItemChannelId } from "./inboxItem";
import type { InboxItem } from "./inboxStore";
import { registerServerReset } from "./serverResetRegistry";

export const COUNTED_IDS_PER_ROW = 64;
export const COUNTED_IDS_TOTAL = 1024;

type CountedRow = {
  /** The highest seq a served answer had for the row; null: none seen (no late counting). */
  servedSeq: string | null;
  /** Live messages applied since, id to seq. */
  ids: Map<string, string>;
  /** A live message past the cap was not kept: no late counting until an answer reaches this seq. */
  blindTo: string | null;
};

const rows = new Map<string, CountedRow>();
let total = 0;

function forget(scopeId: string): void {
  const row = rows.get(scopeId);
  if (!row) return;
  total -= row.ids.size;
  rows.delete(scopeId);
}

registerServerReset(() => resetInboxCountedIds());

/**
 * An accepted answer (any page). `reset`: the list's first window, which
 * replaces it, so a row it does not list is forgotten.
 */
export function noteServedInboxRows(items: readonly InboxItem[], reset: boolean): void {
  const served = new Map<string, string | null>();
  for (const item of items) {
    if (item.kind === "mention_action" || item.kind === "object") continue;
    const scopeId = inboxItemChannelId(item);
    if (scopeId) served.set(scopeId, item.latestActivitySeq ?? null);
  }
  if (reset) for (const scopeId of [...rows.keys()]) if (!served.has(scopeId)) forget(scopeId);
  for (const [scopeId, seq] of served) {
    const row = rows.get(scopeId) ?? { servedSeq: null, ids: new Map<string, string>(), blindTo: null };
    rows.set(scopeId, row);
    // Never backwards: an answer behind an earlier one (the view's lag) does not reopen what that one covered.
    if (seq != null && (row.servedSeq == null || compareActivitySeq(seq, row.servedSeq) > 0)) row.servedSeq = seq;
    const covered = row.servedSeq;
    if (covered == null) continue;
    for (const [id, idSeq] of row.ids) {
      if (compareActivitySeq(idSeq, covered) > 0) continue;
      row.ids.delete(id);
      total -= 1;
    }
    if (row.blindTo != null && compareActivitySeq(covered, row.blindTo) >= 0) row.blindTo = null;
  }
}

/** Was this live message already applied to its row since the row's last served answer? */
export function isInboxCounted(scopeId: string, messageId: string): boolean {
  return rows.get(scopeId)?.ids.has(messageId) ?? false;
}

/**
 * A message at or below its row's seq: is it one the row has not counted yet?
 * Newer than the row's last served answer, not applied since, and the row
 * still keeps every id it applied.
 */
export function isLateUncounted(scopeId: string, messageId: string, seq: string): boolean {
  const row = rows.get(scopeId);
  if (!row || row.servedSeq == null || row.blindTo != null || row.ids.has(messageId)) return false;
  return compareActivitySeq(seq, row.servedSeq) > 0;
}

/**
 * A live message applied to its row. False when it could not be kept (the
 * row or all rows are at the cap): the caller asks for a re-read.
 */
export function noteInboxCounted(scopeId: string, messageId: string, seq: string): boolean {
  const row = rows.get(scopeId) ?? { servedSeq: null, ids: new Map<string, string>(), blindTo: null };
  rows.set(scopeId, row);
  if (row.ids.has(messageId)) return true;
  if (row.ids.size >= COUNTED_IDS_PER_ROW || total >= COUNTED_IDS_TOTAL) {
    if (row.blindTo == null || compareActivitySeq(seq, row.blindTo) > 0) row.blindTo = seq;
    return false;
  }
  row.ids.set(messageId, seq);
  total += 1;
  return true;
}

export function resetInboxCountedIds(): void {
  rows.clear();
  total = 0;
}

export function inboxCountedIdsSizeForTests(scopeId: string): number {
  return rows.get(scopeId)?.ids.size ?? 0;
}
