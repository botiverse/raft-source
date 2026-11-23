/**
 * #triage:#244 diagnostic: a whole-list answer that leaves a row's unread
 * *below* what the answer served for it. One event per such row, naming the
 * first step of the answer's application that lowered it, with the counts,
 * why the list was read, and the row's read facts (scope id, the row's latest
 * activity seq, the answer's read state, this client's ledger read state), so
 * a case can be judged from telemetry. Sent only when it happens.
 *
 * Two events (Tenny, #triage:#244, 2026-11-16):
 * - `activity:list_row_corrected`: the `ledger` step, where this client holds
 *   a newer server-issued read (higher version) whose read covers the
 *   answer's latest activity for the row. The answer was stale and the page
 *   was right; not counted against the bar.
 * - `activity:list_row_corrected` too: the `local_read` step, when this
 *   tab's read ack for the row's scope lands within LOCAL_READ_ACK_WINDOW_MS
 *   and its read covers the answer's latest activity (the answer was fetched
 *   while this tab's own read was in flight). Such a row is held until the
 *   ack or the window ends, then sent once; `ack_read_seq` and `ack_delay_ms`
 *   say what decided it, and `held_end` how the hold ended (`ack`,
 *   `window`, or `pagehide`: the tab went away first, so the row is sent at
 *   once with keepalive as a lowering; over-reporting beats a missed one).
 *   The App sends the same events and adds its own `held_end` values for
 *   the same flush: `background`, `server_switch`, `signout`.
 * - `activity:list_row_lowered`: every other step (and a ledger or local_read
 *   step whose facts don't show that cover). This is the defect count.
 *
 *
 * Added attributes (#triage:#244, 2026-11-19; event names unchanged, so the
 * existing counts keep their meaning):
 * - `inbox.lowered.class`: `expected` (a correction, or a merge/projection
 *   lowering of a row whose answer was read under an older read than this
 *   client's accepted one), `ack_pending` (a local_read hold that ended with
 *   no read ack: window/pagehide), `unexplained` (everything else: the defect
 *   count is `list_row_lowered` with class `unexplained`).
 * - `inbox.lowered.dedupe` / `inbox.lowered.suppressed`: the same lowering of
 *   a row (row, step, served read version/seq/latest activity, served, after)
 *   is sent once per LOWERED_REPORT_WINDOW_MS: `first`; re-reads inside the
 *   window send nothing; when some were left unsent, the next one after the
 *   window (within one more window) is sent as `repeat`, with `suppressed`
 *   the re-reads not sent in the window before (`0` on `first`).
 * - `inbox.lowered.proj_*` (every step; `-` without a projection): the
 *   scope's accepted read-state projection at the answer: `proj_unread`,
 *   `proj_read_seq` (the read it counted from), `proj_through_seq` (newest
 *   loaded message), `proj_loaded_above_read` (loaded messages above the
 *   read; `-` when the window is not complete), `proj_loaded_count`,
 *   `proj_loaded_min_seq`, and `proj_coverage`: `proven` (the read covers the
 *   row's newest known activity, or the complete window has that message
 *   loaded), `null_activity` (the row has no known activity seq), `gap`
 *   (within the newest loaded message but that message is not loaded),
 *   `beyond` (past the newest loaded message), `unknown` (the window is not
 *   complete: a gap, a newer page, or it does not reach back to the read).
 * - `held_end=ack_before_hold`: this tab's read ack landed before the answer
 *   registered the hold (kept for LOCAL_READ_RECENT_ACK_MS) and covers the
 *   answer's latest activity; `ack_delay_ms` is then negative (the ack's
 *   lead). An earlier ack that does not cover it leaves the row held.
 *
 * Steps, in the order loadInbox applies them: `ledger` (a newer accepted read
 * than the answer's), `local_read` (a Read here, or an open-read hold), `done`,
 * `read_hold` (an acknowledged read), `merge` (the per-row position merge and
 * the newer-activity keeps), `projection` (the loaded messages' read-state
 * projection).
 */
import type { InboxScopeReadFrontier } from "@botiverse/raft-shared";
import { compareActivitySeq } from "./activitySeq";
import { getInboxItemKey, inboxItemChannelId } from "./inboxItem";
import { proofActivitySeq } from "./inboxReadProjection";
import type { InboxItem } from "./inboxStore";
import { projectionProvesLowering } from "./readStateSync";
import type { ReadStateProjection } from "./readStateSync";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";

export type ListRowStep = "ledger" | "local_read" | "done" | "read_hold" | "merge" | "projection";

function unreadByKey(items: readonly InboxItem[]): Map<string, number> {
  return new Map(items.filter((item) => item.kind !== "mention_action" && item.kind !== "object").map((item) => [getInboxItemKey(item), item.unreadCount]));
}

/** This client's accepted read state for a scope (readStateSync.getAcceptedReadState). */
export type LedgerReadState = { maxReadSeq: number; readStateVersion: number } | null;

type RowFacts = {
  scopeId: string | null;
  rowLatestSeq: string | null;
  servedReadVersion: number | null;
  servedReadSeq: string | null;
  servedLatestActivitySeq: string | null;
  ledgerReadVersion: number | null;
  ledgerReadSeq: string | null;
};

function rowLatestSeqOf(item: InboxItem): string | null {
  const seq = (item as { latestActivitySeq?: unknown }).latestActivitySeq;
  return typeof seq === "string" ? seq : null;
}

/** The ledger step corrected a stale answer: a newer server-issued read covers the answer's latest activity. */
function isLedgerCorrection(facts: RowFacts): boolean {
  if (facts.servedReadVersion === null || facts.ledgerReadVersion === null) return false;
  if (facts.ledgerReadVersion <= facts.servedReadVersion) return false;
  if (facts.servedLatestActivitySeq === null || facts.ledgerReadSeq === null) return false;
  return covers(facts.ledgerReadSeq, facts.servedLatestActivitySeq);
}

/** How long a `local_read` lowering waits for this tab's read ack before it counts as a lowering. */
export const LOCAL_READ_ACK_WINDOW_MS = 5_000;

/**
 * How long a read ack is kept for a hold registered after it (the ack-before-hold
 * race): as long as a local read holds its row in later answers
 * (inboxStore INBOX_LOCAL_MUTATION_HOLD_MS).
 */
export const LOCAL_READ_RECENT_ACK_MS = 90_000;

/** The same lowering of a row is sent once per this window (one local read's hold, INBOX_LOCAL_MUTATION_HOLD_MS). */
export const LOWERED_REPORT_WINDOW_MS = 90_000;

/** How a held `local_read` row was settled; `-` for a row that was never held. */
type HeldEnd = "ack" | "ack_before_hold" | "window" | "pagehide";

export type LoweredClass = "expected" | "ack_pending" | "unexplained";

/** This tab's latest read ack per scope id (highest read seq, when it landed). */
const recentAcks = new Map<string, { readSeq: string; at: number }>();

/** Lowerings already sent, by dedupe key: when the window started and how many re-reads were not sent since. */
const reportedLowerings = new Map<string, { at: number; suppressed: number }>();

type PendingLocalRead = {
  loweredAt: number;
  emit: (end: HeldEnd, ack: { readSeq: string; delayMs: number } | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** `local_read` lowerings waiting for their scope's read ack, by scope id (one tab's module state). */
const pendingLocalReads = new Map<string, PendingLocalRead[]>();

/** A read or activity seq as a decimal string, or null when it is not a non-negative safe integer. */
function parseSeq(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === "string") return /^\d+$/.test(value) ? value : null;
  return null;
}

function covers(readSeq: string | null, latestSeq: string | null): boolean {
  const read = parseSeq(readSeq);
  const latest = parseSeq(latestSeq);
  if (read === null || latest === null) return false;
  return BigInt(read) >= BigInt(latest);
}

/**
 * This tab's read of `scopeId` was acknowledged by the server with `maxReadSeq`.
 * Every read this tab sends reports its ack here: `/read` (messageStore
 * flushPendingRead: opening a conversation, markCurrentChannelRead on resume,
 * a live message read in view), `/read-all` (transport postReadAllCoalesced:
 * Activity's Read, a thread opened; messageStore markRead) and
 * `/conversation-read-all` (messageStore markConversationRead). The ack is
 * kept LOCAL_READ_RECENT_ACK_MS for a hold registered after it.
 * Settles the scope's held `local_read` lowerings: a corrected one when the
 * read covers the answer's latest activity, a lowering otherwise. An ack
 * without a usable seq is ignored (the window decides).
 */
export function noteLocalReadAck(scopeId: string, maxReadSeq: unknown, now: number = Date.now()): void {
  const readSeq = parseSeq(maxReadSeq);
  if (readSeq === null) return;
  for (const [scope, ack] of recentAcks) if (now - ack.at > LOCAL_READ_RECENT_ACK_MS) recentAcks.delete(scope);
  const previous = recentAcks.get(scopeId);
  recentAcks.set(scopeId, { readSeq: previous && BigInt(previous.readSeq) > BigInt(readSeq) ? previous.readSeq : readSeq, at: now });
  const pending = pendingLocalReads.get(scopeId);
  if (!pending) return;
  pendingLocalReads.delete(scopeId);
  for (const entry of pending) {
    clearTimeout(entry.timer);
    entry.emit("ack", { readSeq, delayMs: Math.max(0, now - entry.loweredAt) });
  }
}

/** The tab is going away: send every held row now, as a lowering, with keepalive. */
export function flushPendingLocalReadsBeforeUnload(): void {
  const all = [...pendingLocalReads.values()].flat();
  pendingLocalReads.clear();
  for (const entry of all) {
    clearTimeout(entry.timer);
    entry.emit("pagehide", null);
  }
}

/** The window the pagehide flush is registered on (registered at the first hold). */
let pagehideTarget: Window | null = null;

/** Test seam: drop held lowerings without sending them, and forget the pagehide listener. */
export function __resetPendingLocalReadsForTest(): void {
  for (const pending of pendingLocalReads.values()) for (const entry of pending) clearTimeout(entry.timer);
  pendingLocalReads.clear();
  recentAcks.clear();
  reportedLowerings.clear();
  repeatOf.clear();
  pagehideTarget?.removeEventListener("pagehide", flushPendingLocalReadsBeforeUnload);
  pagehideTarget = null;
}

function holdLocalRead(scopeId: string, servedLatestActivitySeq: string | null, entry: Omit<PendingLocalRead, "timer">): void {
  // The ack may have landed before this answer registered the hold. Only one
  // that covers the answer's latest activity settles it: an older read's ack
  // (activity after it) leaves the hold for this read's own ack or the window.
  const early = recentAcks.get(scopeId);
  if (early && entry.loweredAt - early.at <= LOCAL_READ_RECENT_ACK_MS && covers(early.readSeq, servedLatestActivitySeq)) {
    entry.emit("ack_before_hold", { readSeq: early.readSeq, delayMs: early.at - entry.loweredAt });
    return;
  }
  if (pagehideTarget === null && typeof window !== "undefined") {
    pagehideTarget = window;
    window.addEventListener("pagehide", flushPendingLocalReadsBeforeUnload);
  }
  const timer = setTimeout(() => {
    const list = pendingLocalReads.get(scopeId);
    if (!list) return;
    const rest = list.filter((candidate) => candidate.timer !== timer);
    if (rest.length > 0) pendingLocalReads.set(scopeId, rest);
    else pendingLocalReads.delete(scopeId);
    entry.emit("window", null);
  }, LOCAL_READ_ACK_WINDOW_MS);
  const list = pendingLocalReads.get(scopeId) ?? [];
  list.push({ ...entry, timer });
  pendingLocalReads.set(scopeId, list);
}

/**
 * Suppressed re-reads of lowerings whose window ended, carried to the next
 * report of the same lowering (`suppressed`, `dedupe=repeat`).
 */
const repeatOf = new Map<string, { suppressed: number; endedAt: number }>();

/** End expired windows; one that suppressed re-reads is carried for one more window (`repeatOf`). */
function expireReported(now: number): void {
  for (const [key, entry] of repeatOf) if (now - entry.endedAt > LOWERED_REPORT_WINDOW_MS) repeatOf.delete(key);
  for (const [key, entry] of reportedLowerings) {
    if (now - entry.at <= LOWERED_REPORT_WINDOW_MS) continue;
    reportedLowerings.delete(key);
    // The window ended at its end, not when this pass noticed it.
    if (entry.suppressed > 0) repeatOf.set(key, { suppressed: entry.suppressed, endedAt: entry.at + LOWERED_REPORT_WINDOW_MS });
  }
}

/** The answer was read under an older read than this client's accepted one, or this client's read covers its latest activity. */
function answerBehindClientRead(facts: RowFacts, projection: ReadStateProjection | null): boolean {
  if (facts.servedReadVersion !== null && facts.ledgerReadVersion !== null && facts.ledgerReadVersion > facts.servedReadVersion) return true;
  if (covers(facts.ledgerReadSeq, facts.servedLatestActivitySeq)) return true;
  // The projection counted from a read past the answer's.
  const projectionRead = projection?.readSeq == null ? null : String(projection.readSeq);
  return covers(projectionRead, facts.servedReadSeq) && !covers(facts.servedReadSeq, projectionRead);
}

function classify(step: ListRowStep, corrected: boolean, end: HeldEnd | null, facts: RowFacts, projection: ReadStateProjection | null): LoweredClass {
  if (corrected) return "expected";
  if (step === "local_read" && (end === "window" || end === "pagehide")) return "ack_pending";
  if ((step === "merge" || step === "projection") && answerBehindClientRead(facts, projection)) return "expected";
  return "unexplained";
}

type ProjectionCoverage = "proven" | "null_activity" | "gap" | "beyond" | "unknown";

function projectionCoverage(projection: ReadStateProjection, activitySeq: string | null): ProjectionCoverage {
  if (activitySeq === null) return "null_activity";
  if (projectionProvesLowering(projection, activitySeq)) return "proven";
  if (!projection.complete || !projection.loadedSeqsAboveRead) return "unknown";
  if (projection.throughSeq != null && compareActivitySeq(activitySeq, String(projection.throughSeq)) <= 0) return "gap";
  return "beyond";
}

function projectionFacts(projection: ReadStateProjection | null, item: InboxItem, loadedSeqOf: ((messageId: string) => number | null) | undefined): Record<string, string> {
  const text = (value: number | null | undefined) => (value == null ? "-" : String(value));
  return {
    "inbox.lowered.proj_unread": projection ? String(projection.unreadCount) : "-",
    "inbox.lowered.proj_read_seq": text(projection?.readSeq),
    "inbox.lowered.proj_through_seq": text(projection?.throughSeq),
    "inbox.lowered.proj_loaded_above_read": text(projection?.loadedSeqsAboveRead?.length),
    "inbox.lowered.proj_loaded_count": text(projection?.loadedCount),
    "inbox.lowered.proj_loaded_min_seq": text(projection?.loadedMinSeq),
    "inbox.lowered.proj_coverage": projection ? projectionCoverage(projection, proofActivitySeq(item, loadedSeqOf)) : "-",
  };
}

export function reportListRowsLowered(input: {
  served: readonly InboxItem[];
  /** The answer's read state per served row, index-aligned with `served` (absent when the caller has none). */
  servedFrontiers?: readonly (InboxScopeReadFrontier | undefined)[];
  /** This client's ledger read state for a scope at the time the answer was applied. */
  ledgerOf?: (scopeId: string) => LedgerReadState;
  before: readonly InboxItem[];
  stages: ReadonlyArray<readonly [ListRowStep, readonly InboxItem[]]>;
  reason: string | undefined;
  trigger: string | undefined;
  rowPosition: boolean;
  /** This client's accepted read-state projection for a scope at the time the answer was applied. */
  projectionOf?: (scopeId: string) => ReadStateProjection | null;
  /** A loaded message's seq in a scope, by id: the proof's fallback for a row served without activity seqs (proofActivitySeq). */
  loadedSeqOf?: (scopeId: string) => (messageId: string) => number | null;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  expireReported(now);
  const stages = input.stages.map(([step, items]) => [step, unreadByKey(items)] as const);
  const final = stages[stages.length - 1]?.[1];
  if (!final) return;
  const before = unreadByKey(input.before);
  const servedByKey = unreadByKey(input.served);
  const reported = new Set<string>();
  input.served.forEach((item, index) => {
    if (item.kind === "mention_action" || item.kind === "object") return;
    const key = getInboxItemKey(item);
    // One event per row, judged on the count the stages saw for it (the last served copy).
    if (reported.has(key) || servedByKey.get(key) !== item.unreadCount) return;
    reported.add(key);
    const served = item.unreadCount;
    const after = final.get(key);
    if (after === undefined || after >= served) return;
    const step = stages.find(([, counts]) => (counts.get(key) ?? served) < served)?.[0] ?? "merge";
    const frontier = input.servedFrontiers?.[index];
    const present = frontier?.kind === "present" ? frontier : null;
    const scopeId = inboxItemChannelId(item);
    const ledger = scopeId && input.ledgerOf ? input.ledgerOf(scopeId) : null;
    const facts: RowFacts = {
      scopeId,
      rowLatestSeq: rowLatestSeqOf(item),
      servedReadVersion: present ? present.readStateVersion : null,
      servedReadSeq: present ? present.maxReadSeq : null,
      servedLatestActivitySeq: present?.latestActivity?.seq ?? null,
      ledgerReadVersion: ledger ? ledger.readStateVersion : null,
      ledgerReadSeq: ledger ? String(ledger.maxReadSeq) : null,
    };
    // One report per window for the same lowering of the row (a local read's hold re-lowers it on every re-read).
    const dedupeKey = [key, step, facts.servedReadVersion ?? "-", facts.servedReadSeq ?? "-", facts.servedLatestActivitySeq ?? "-", served, after].join("|");
    const seen = reportedLowerings.get(dedupeKey);
    if (seen) {
      seen.suppressed += 1;
      return;
    }
    const previous = repeatOf.get(dedupeKey)?.suppressed;
    repeatOf.delete(dedupeKey);
    reportedLowerings.set(dedupeKey, { at: now, suppressed: 0 });
    const projection = scopeId && input.projectionOf ? input.projectionOf(scopeId) : null;
    const proj = projectionFacts(projection, item, scopeId ? input.loadedSeqOf?.(scopeId) : undefined);
    const send = (corrected: boolean, ack: { readSeq: string; delayMs: number } | null, end: HeldEnd | null) => emitStateTransitionTrace({
      domain: "inbox",
      event: corrected ? "activity:list_row_corrected" : "activity:list_row_lowered",
      entityId: "list",
      outcome: corrected ? "noop" : "conflict",
      outcomeDetail: `step=${step};before=${before.get(key) ?? -1};served=${served};after=${after}`,
      touched: 1,
      timestamp: now,
    }, {
      "inbox.lowered.step": step,
      "inbox.lowered.before": String(before.get(key) ?? -1),
      "inbox.lowered.served": String(served),
      "inbox.lowered.after": String(after),
      "inbox.lowered.fetch_reason": input.reason ?? "none",
      "inbox.lowered.fetch_trigger": input.trigger ?? "none",
      "inbox.lowered.row_position": input.rowPosition ? "true" : "false",
      "inbox.lowered.row_kind": item.kind,
      "inbox.lowered.scope_id": facts.scopeId ?? "-",
      "inbox.lowered.row_latest_seq": facts.rowLatestSeq ?? "-",
      "inbox.lowered.served_read_version": facts.servedReadVersion === null ? "-" : String(facts.servedReadVersion),
      "inbox.lowered.served_read_seq": facts.servedReadSeq ?? "-",
      "inbox.lowered.served_latest_activity_seq": facts.servedLatestActivitySeq ?? "-",
      "inbox.lowered.ledger_read_version": facts.ledgerReadVersion === null ? "-" : String(facts.ledgerReadVersion),
      "inbox.lowered.ledger_read_seq": facts.ledgerReadSeq ?? "-",
      "inbox.lowered.ack_read_seq": ack ? ack.readSeq : "-",
      "inbox.lowered.ack_delay_ms": ack ? String(ack.delayMs) : "-",
      "inbox.lowered.held_end": end ?? "-",
      "inbox.lowered.class": classify(step, corrected, end, facts, projection),
      "inbox.lowered.dedupe": previous === undefined ? "first" : "repeat",
      "inbox.lowered.suppressed": String(previous ?? 0),
      ...proj,
    }, { beforeUnload: end === "pagehide" });
    if (step === "local_read" && scopeId) {
      holdLocalRead(scopeId, facts.servedLatestActivitySeq, {
        loweredAt: now,
        emit: (end, ack) => send(ack !== null && covers(ack.readSeq, facts.servedLatestActivitySeq), ack, end),
      });
      return;
    }
    send(step === "ledger" && isLedgerCorrection(facts), null, null);
  });
}
