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
 *
 * Seqs are canonical decimal strings, taken and returned as such and compared
 * exactly (`messages.seq` is a 64-bit bigserial; a Number loses precision past 2^53).
 */

/** A seq applied to the row by a live message since its last answer, with its verdict (re-applied on a merge). */
export type ActivityRowAppliedSeq = { seq: string; counts: boolean; mention: boolean };

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
};

/** A served row, as an answer carries it. */
export type ActivityRowAnswer = Pick<ActivityRowState, "unreadCount" | "hasMention" | "position" | "mentionOnly">;

export type ActivityRowEvent =
  /** `counts`: the unread predicate's verdict; `null` = cannot be judged (re-read the row). */
  | { type: "live"; seq: string; counts: boolean | null; mentionsViewer: boolean }
  | { type: "answer"; row: ActivityRowAnswer }
  /** The viewer read the conversation up to `seq` (a persisted read or a read change's `refSeq`). */
  | { type: "read"; seq: string };

export type ActivityRowRereadReason = "ambiguous_seq" | "inversion" | "null_position" | "unjudged" | "partial_read";

export type ActivityRowResult = {
  row: ActivityRowState;
  /** Re-read this one row (`?ids=`), never the list. */
  reread: boolean;
  rereadReason?: ActivityRowRereadReason;
};

/** A row as an answer delivers it, with no client state. */
export function activityRowFromAnswer(answer: ActivityRowAnswer): ActivityRowState {
  return { ...answer, position: isCanonicalActivitySeq(answer.position) ? answer.position : null, applied: [], inversionObserved: false };
}

/** The position the row shows (its `latestActivitySeq` on screen): the delivered one or the highest applied above it. */
export function activityRowDisplayPosition(row: ActivityRowState): string | null {
  return row.applied.length > 0 ? row.applied[row.applied.length - 1]!.seq : row.position;
}

export function reduceActivityRow(row: ActivityRowState, event: ActivityRowEvent): ActivityRowResult {
  switch (event.type) {
    case "live": return applyLive(row, event);
    case "answer": return mergeAnswer(row, event.row);
    case "read": return applyRead(row, event.seq);
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
  if (row.position == null) return reread(row, "null_position");
  if (!isCanonicalActivitySeq(event.seq)) return reread(row, "unjudged");
  if (compareSeq(event.seq, row.position) <= 0) return reread(row, "ambiguous_seq");
  if (row.applied.some((entry) => entry.seq === event.seq)) return keep(row);
  if (event.counts == null) return reread(row, "unjudged");
  const highest = activityRowDisplayPosition(row)!;
  const inversion = compareSeq(event.seq, highest) < 0;
  const entry = { seq: event.seq, counts: event.counts, mention: event.mentionsViewer };
  const applied = [...row.applied, entry].sort((a, b) => compareSeq(a.seq, b.seq));
  return keep({ ...withVerdict(row, entry), applied, inversionObserved: row.inversionObserved || inversion });
}

function mergeAnswer(row: ActivityRowState, served: ActivityRowAnswer): ActivityRowResult {
  // A position that is not a canonical seq is no position (fail closed: no live patches).
  const answer = isCanonicalActivitySeq(served.position) ? served : { ...served, position: null };
  // An answer older than the one the row came from changes nothing.
  if (answer.position != null && row.position != null && compareSeq(answer.position, row.position) < 0) return keep(row);
  if (answer.position == null) return keep(activityRowFromAnswer(answer));
  const pa = answer.position;
  const above = row.applied.filter((entry) => compareSeq(entry.seq, pa) > 0);
  const trusted = row.applied.length - above.length;
  let next: ActivityRowState = { ...activityRowFromAnswer(answer), applied: above, inversionObserved: row.inversionObserved && above.length > 0 };
  for (const entry of above) next = withVerdict(next, entry);
  return trusted > 0 && row.inversionObserved ? reread(next, "inversion") : keep(next);
}

function applyRead(original: ActivityRowState, seq: string): ActivityRowResult {
  // The seqs the read covers are read: a later answer below them must not count them again.
  const row = withAppliedRead(original, seq);
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
