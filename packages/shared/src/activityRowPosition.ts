/**
 * #244 (inbox redesign, step 1): the per-row position rule for an Activity
 * row, as a pure reducer. Design: "Fact 1" of the inbox redesign
 * (#triage:#244). Pinned by the contract cases in
 * `contract-cases/activity-row/` (README there); nothing calls it yet: web
 * adopts it in step 2, behind a flag.
 *
 * A served row says what it has counted up to: its `latestActivitySeq` (P),
 * the highest seq committed and counted in that answer. It does not say that
 * every lower seq is counted (rows commit out of seq order, rarely), so:
 * - a live message above P is applied (counted if the unread predicate says so);
 * - one at or below P already applied by this client (delivered twice) is ignored;
 * - one at or below P not applied is ambiguous: re-read this one row.
 * Merging an answer (Pa): older than the row's delivered position, keep the
 * row; otherwise take it and re-apply the seqs this client applied above Pa.
 * Applied seqs at or below Pa are trusted as counted in it, unless an
 * inversion (a live seq lower than one already applied since the last answer)
 * was seen: then re-read the row. A read covers the applied seqs at or below it:
 * they no longer count, so an answer below them does not count them again. A row with no position takes no live
 * patches: every event for it re-reads it.
 * The row keeps the highest seq the viewer read (`readSeq`, set by local reads
 * and read acks). An answer at or below it counted only read messages: the
 * server computed it before the read reached it, so its unread and @ are
 * dropped (`answer_before_read_lands`); a mention-only answer is taken as it is
 * (its @ does not follow the read cursor on every server path). A Mark as Unread
 * clears it and keeps the old value as a ceiling: a later read at or below it
 * (a late ack of a read from before the mark) does not raise it again.
 *
 * Seqs are canonical decimal strings, taken and returned as such and compared
 * exactly (`messages.seq` is a 64-bit bigserial; a Number loses precision past 2^53).
 */

/**
 * A seq applied to the row by a live message since its last answer, with its
 * verdict (re-applied on a merge). `moves: false`: a mention past a mute on a
 * row with a pre-mute message: it lights the @ but is not the row's shown
 * position (absent: it is).
 */
export type ActivityRowAppliedSeq = { seq: string; counts: boolean; mention: boolean; moves?: false };

export type ActivityRowState = {
  unreadCount: number;
  hasMention: boolean;
  /** The position delivered by the row's last answer (its `latestActivitySeq`), or null: no live patches. */
  position: string | null;
  /** A mention-only row (nothing else unread): its position is its highest mention seq. */
  mentionOnly: boolean;
  /** Seqs applied above `position` since the last answer, ascending. */
  applied: readonly ActivityRowAppliedSeq[];
  /** A live seq lower than an applied one arrived since the last answer (two messages committed out of seq order). */
  inversionObserved: boolean;
  /**
   * The highest seq the viewer read on this client ("已读到的序号"): every
   * message at or below it is read. Kept across answers; absent = none known.
   * An answer at or below it has nothing unread.
   */
  readSeq?: string;
  /**
   * Set by a Mark as Unread: the read seq it cleared. A read at or below it
   * (a late ack of a read from before the mark) does not raise `readSeq`; a
   * read above it clears it and records normally.
   */
  readSeqCeiling?: string;
};

/**
 * A served row, as an answer carries it. `readSeq` (optional): the viewer's
 * read position the server served with the row (its maxReadSeq): merged as a
 * read is, so the row keeps the higher of the two (a Mark as Unread's ceiling
 * still holds).
 */
export type ActivityRowAnswer = Pick<ActivityRowState, "unreadCount" | "hasMention" | "position" | "mentionOnly"> & { readSeq?: string };

export type ActivityRowEvent =
  /**
   * `counts`: the unread predicate's verdict; `null` = cannot be judged (re-read the row).
   * `moves`: the predicate's `moves` (absent = true). False (past a mute):
   * no mention leaves the row as it is; a mention lights the @ and moves only
   * a mention-only row.
   */
  | { type: "live"; seq: string; counts: boolean | null; mentionsViewer: boolean; moves?: boolean }
  | { type: "answer"; row: ActivityRowAnswer }
  /** The viewer read the conversation up to `seq` (a persisted read or a read change's `refSeq`). */
  | { type: "read"; seq: string }
  /** The viewer marked the conversation unread: the read cursor moved back, so `readSeq` no longer holds. */
  | { type: "markUnread" };

export type ActivityRowRereadReason = "ambiguous_seq" | "inversion" | "null_position" | "unjudged" | "partial_read";

export type ActivityRowResult = {
  row: ActivityRowState;
  /** Re-read this one row (`?ids=`), never the list. */
  reread: boolean;
  rereadReason?: ActivityRowRereadReason;
};

/** A row as an answer delivers it, with no client state. */
export function activityRowFromAnswer(answer: ActivityRowAnswer): ActivityRowState {
  const { readSeq, ...served } = answer;
  return {
    ...served,
    position: isCanonicalActivitySeq(served.position) ? served.position : null,
    applied: [],
    inversionObserved: false,
    ...(isCanonicalActivitySeq(readSeq) ? { readSeq } : {}),
  };
}

/** The position the row shows (its `latestActivitySeq` on screen): the delivered one or the highest applied above it. */
export function activityRowDisplayPosition(row: ActivityRowState): string | null {
  for (let index = row.applied.length - 1; index >= 0; index -= 1) {
    if (row.applied[index]!.moves !== false) return row.applied[index]!.seq;
  }
  return row.position;
}

export function reduceActivityRow(row: ActivityRowState, event: ActivityRowEvent): ActivityRowResult {
  switch (event.type) {
    case "live": return applyLive(row, event);
    case "answer": return mergeAnswer(row, event.row);
    case "read": return applyRead(row, event.seq);
    case "markUnread": return keep(markedUnread(row));
  }
}

const CANONICAL_SEQ = /^(0|[1-9][0-9]*)$/;

/** A canonical decimal seq string (no sign, no leading zeros). */
export function isCanonicalActivitySeq(seq: string | null | undefined): seq is string {
  return typeof seq === "string" && CANONICAL_SEQ.test(seq);
}

/**
 * Exact order of two canonical decimal seq strings: >0, 0 or <0. Seqs are
 * 64-bit; a Number compare loses precision past 2^53 (contract case
 * seq_above_2_53). Throws on a non-canonical seq: the reducer never passes one.
 */
export function compareActivityRowSeq(a: string, b: string): number {
  if (!isCanonicalActivitySeq(a) || !isCanonicalActivitySeq(b)) throw new Error(`not a canonical decimal seq: ${a} / ${b}`);
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a > b ? 1 : a < b ? -1 : 0;
}

const compareSeq = compareActivityRowSeq;

const keep = (row: ActivityRowState): ActivityRowResult => ({ row, reread: false });
const reread = (row: ActivityRowState, rereadReason: ActivityRowRereadReason): ActivityRowResult => ({ row, reread: true, rereadReason });

/**
 * A counted message (a mention included) turns a mention-only row into a
 * normal unread row; a mention that does not count (a muted conversation)
 * lights the @ and keeps it mention-only.
 */
function withVerdict(row: ActivityRowState, verdict: { counts: boolean; mention: boolean }): ActivityRowState {
  if (!verdict.counts) return verdict.mention ? { ...row, hasMention: true } : row;
  return { ...row, unreadCount: row.unreadCount + 1, hasMention: row.hasMention || verdict.mention, mentionOnly: false };
}

function applyLive(row: ActivityRowState, event: Extract<ActivityRowEvent, { type: "live" }>): ActivityRowResult {
  // Past a mute (RisingWave's muted prefix, #triage:#244): the server's row
  // stays at its last message before the mute. A message that does not
  // mention the viewer changes nothing; a mention lights the @, and moves
  // only a mention-only row (its position is its highest mention).
  if (event.moves === false && !event.mentionsViewer) return keep(row);
  const stays = event.moves === false && !row.mentionOnly;
  if (row.position == null) return reread(row, "null_position");
  if (!isCanonicalActivitySeq(event.seq)) return reread(row, "unjudged");
  if (compareSeq(event.seq, row.position) <= 0) return reread(row, "ambiguous_seq");
  if (row.applied.some((entry) => entry.seq === event.seq)) return keep(row);
  if (event.counts == null) return reread(row, "unjudged");
  const highest = row.applied.length > 0 ? row.applied[row.applied.length - 1]!.seq : row.position;
  const inversion = compareSeq(event.seq, highest) < 0;
  const entry: ActivityRowAppliedSeq = { seq: event.seq, counts: event.counts, mention: event.mentionsViewer, ...(stays ? { moves: false as const } : {}) };
  const applied = [...row.applied, entry].sort((a, b) => compareSeq(a.seq, b.seq));
  return keep({ ...withVerdict(row, entry), applied, inversionObserved: row.inversionObserved || inversion });
}

function mergeAnswer(row: ActivityRowState, served: ActivityRowAnswer): ActivityRowResult {
  // A position that is not a canonical seq is no position (fail closed: no live patches).
  const answer = isCanonicalActivitySeq(served.position) ? served : { ...served, position: null };
  // An answer older than the one the row came from changes nothing.
  if (answer.position != null && row.position != null && compareSeq(answer.position, row.position) < 0) return keep(row);
  // The row's read seq and ceiling, raised by the answer's own read seq as a read would (max, under the ceiling).
  const merged = answer.readSeq === undefined ? row : withReadSeq(row, answer.readSeq);
  const read = {
    ...(merged.readSeq === undefined ? {} : { readSeq: merged.readSeq }),
    ...(merged.readSeqCeiling === undefined ? {} : { readSeqCeiling: merged.readSeqCeiling }),
  };
  if (answer.position == null) return keep({ ...withoutRead(activityRowFromAnswer(answer)), ...read });
  const pa = answer.position;
  const above = row.applied.filter((entry) => compareSeq(entry.seq, pa) > 0);
  const trusted = row.applied.length - above.length;
  // Everything the answer counted is at or below Pa: at or below the read, it is all read
  // (the server computed the answer before the read reached it). Not a mention-only
  // answer: its @ does not follow the read cursor on every server path (as applyRead).
  const counted = !answer.mentionOnly && read.readSeq !== undefined && compareSeq(pa, read.readSeq) <= 0
    ? { ...answer, unreadCount: 0, hasMention: false, mentionOnly: false }
    : answer;
  let next: ActivityRowState = { ...withoutRead(activityRowFromAnswer(counted)), ...read, applied: above, inversionObserved: row.inversionObserved && above.length > 0 };
  for (const entry of above) next = withVerdict(next, entry);
  return trusted > 0 && row.inversionObserved ? reread(next, "inversion") : keep(next);
}

function applyRead(original: ActivityRowState, seq: string): ActivityRowResult {
  // The seqs the read covers are read: a later answer below them must not count them again.
  const row = withReadSeq(withAppliedRead(original, seq), seq);
  const shown = activityRowDisplayPosition(row);
  if (row.unreadCount === 0 && !row.hasMention) return keep(row);
  // A mention-only row's @ is not a cursor matter on every server path; a
  // partial read cannot be split; a row without a position cannot be judged.
  if (shown == null) return reread(row, "null_position");
  if (!isCanonicalActivitySeq(seq)) return reread(row, "unjudged");
  if (row.mentionOnly || compareSeq(seq, shown) < 0) return reread(row, "partial_read");
  return keep({ ...row, unreadCount: 0, hasMention: false });
}

/** The applied seqs at or below a read's seq no longer count or light the @ (they stay applied: a repeat is still a repeat). */
function withAppliedRead(row: ActivityRowState, seq: string): ActivityRowState {
  if (!isCanonicalActivitySeq(seq)) return row;
  const covered = (entry: ActivityRowAppliedSeq) => compareSeq(entry.seq, seq) <= 0 && (entry.counts || entry.mention);
  if (!row.applied.some(covered)) return row;
  return { ...row, applied: row.applied.map((entry) => (covered(entry) ? { ...entry, counts: false, mention: false } : entry)) };
}

/**
 * The read raises `readSeq` (never lowers it: a late, older read ack changes
 * nothing). At or below a Mark as Unread's ceiling it does not raise it (a late
 * ack of a read from before the mark); above it, the ceiling goes.
 */
function withReadSeq(row: ActivityRowState, seq: string): ActivityRowState {
  if (!isCanonicalActivitySeq(seq)) return row;
  if (row.readSeqCeiling !== undefined) {
    if (compareSeq(seq, row.readSeqCeiling) <= 0) return row;
    const { readSeqCeiling: _lifted, ...rest } = row;
    return withReadSeq(rest, seq);
  }
  if (row.readSeq !== undefined && compareSeq(seq, row.readSeq) <= 0) return row;
  return { ...row, readSeq: seq };
}

/** Mark as Unread: the read seq goes, kept as the ceiling a late read ack must pass to raise it again. */
function markedUnread(row: ActivityRowState): ActivityRowState {
  if (row.readSeq === undefined) return row;
  const { readSeq, ...rest } = row;
  const ceiling = row.readSeqCeiling !== undefined && compareSeq(row.readSeqCeiling, readSeq) > 0 ? row.readSeqCeiling : readSeq;
  return { ...rest, readSeqCeiling: ceiling };
}

function withoutRead(row: ActivityRowState): ActivityRowState {
  if (row.readSeq === undefined) return row;
  const { readSeq: _merged, ...rest } = row;
  return rest;
}

/**
 * A sync `inbox_row` change (GET /api/sync/changes, inbox_row capability) applied to
 * the held row (null: none held). An upsert is an answer (the same merge as a
 * GET /api/channels/inbox answer: older than the held position ignored, equal
 * replaces, the read seq kept as the higher one). A delete removes the row (null)
 * when its position is null or at or past the held row's delivered position;
 * below it, a newer message brought the row back and it is kept.
 */
export function applySyncInboxRowChange(
  held: ActivityRowState | null,
  change: { op: "upsert"; row: ActivityRowAnswer } | { op: "delete"; position: string | null },
): Omit<ActivityRowResult, "row"> & { row: ActivityRowState | null } {
  if (change.op === "upsert") return held ? reduceActivityRow(held, { type: "answer", row: change.row }) : keep(activityRowFromAnswer(change.row));
  const removed = { row: null, reread: false };
  if (!held || change.position === null) return removed;
  // Compared with what the row shows (a live message applied above its answer included).
  const shown = activityRowDisplayPosition(held);
  if (shown === null) return removed;
  if (!isCanonicalActivitySeq(change.position)) return keep(held);
  return compareSeq(change.position, shown) >= 0 ? removed : keep(held);
}
