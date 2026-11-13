// RFC 082 §4.6: a card message's update edits its bridged Slack copy. This
// module owns the durable intent (written in the card update's transaction),
// the sync's status as three independent facts, and the operating parameters.
// The edit worker (slackCardEditWorkerService.ts) acts on it.

import { and, eq, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import {
  externalCardEditAttempts,
  externalCardEditPairNotices,
  externalCardEditSyncs,
  externalOutboundDeliveries,
  EXTERNAL_CARD_EDIT_NOTICE_KINDS,
} from "../db/schema";

// Operating parameters (RFC 082 §4.6 names them, leaves the values to us).
// Conservative: longer waits trade a slower repair for fewer races with a
// request Slack may still be processing.

/**
 * Q: after an unknown outcome nothing more is sent for this long. The Slack
 * Web API client gives up after 15 s (slackBridgeProviderRuntime.ts
 * DEFAULT_FETCH_TIMEOUT_MS); the rest is margin for Slack's own processing.
 */
export const SLACK_CARD_EDIT_QUIET_PERIOD_MS = 2 * 60_000;
/** The longer interval: the second read-back follows the first by this much. */
export const SLACK_CARD_EDIT_LATER_RECHECK_MS = 15 * 60_000;
/**
 * T: a message not confirmed for longer than this raises the pair's one "not
 * confirmed in Slack" notice. Longer than Q plus the later recheck, so a
 * message whose read-backs looked right still gets it after its last check.
 */
export const SLACK_CARD_EDIT_NOT_CONFIRMED_NOTICE_MS = 30 * 60_000;
/** An ENDED sync's notice counts this long after it ended (the card update window); an open one counts while it qualifies. */
export const SLACK_CARD_EDIT_NOTICE_DISPLAY_MS = 14 * 24 * 60 * 60_000;
/** One edit's custody; the Slack call itself is bounded at 15 s. */
export const SLACK_CARD_EDIT_LEASE_MS = 60_000;
/** How often a sync whose original is still queued or unresolved looks again. */
export const SLACK_CARD_EDIT_ORIGINAL_WAIT_MS = 30_000;
/** Retry backoff for a retryable failure or a held pair (doubling, capped). */
export const SLACK_CARD_EDIT_RETRY_BASE_MS = 30_000;
export const SLACK_CARD_EDIT_RETRY_MAX_MS = 15 * 60_000;

export function slackCardEditRetryDelayMs(retryCount: number): number {
  const exponent = Math.max(0, Math.min(10, retryCount));
  return Math.min(SLACK_CARD_EDIT_RETRY_MAX_MS, SLACK_CARD_EDIT_RETRY_BASE_MS * (2 ** exponent));
}

/**
 * Records, in the card update's own transaction, the latest revision to sync
 * for every outbound delivery of the message (one per pair epoch it was
 * queued at). Only a message that has a delivery gets a row; the delivery's
 * frozen send snapshot is not touched. An ended sync stays ended: the update
 * is never carried to a new pair or epoch, nor revives a sync whose original
 * never reached Slack.
 */
export async function recordSlackCardEditIntent(
  executor: DatabaseExecutor,
  input: { messageId: string; revision: number; now: Date },
): Promise<number> {
  if (!Number.isSafeInteger(input.revision) || input.revision < 2) {
    throw new Error("A card edit intent is recorded for an update (revision 2 or later)");
  }
  const deliveries = await executor.select({
    id: externalOutboundDeliveries.id,
    bindingId: externalOutboundDeliveries.bindingId,
    bindingEpoch: externalOutboundDeliveries.bindingEpoch,
  }).from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.sourceMessageId, input.messageId));
  let recorded = 0;
  const touched: SlackCardEditPair[] = [];
  for (const delivery of deliveries) {
    const rows = await executor.insert(externalCardEditSyncs).values({
      deliveryId: delivery.id,
      sourceMessageId: input.messageId,
      bindingId: delivery.bindingId,
      bindingEpoch: delivery.bindingEpoch,
      latestRevision: input.revision,
      nextAttemptAt: input.now,
      notConfirmedSince: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    }).onConflictDoUpdate({
      target: externalCardEditSyncs.deliveryId,
      set: {
        latestRevision: sql`greatest(${externalCardEditSyncs.latestRevision}, excluded.latest_revision)`,
        // Wake the worker; a quiet period or a held lease is still honoured there.
        nextAttemptAt: sql`excluded.next_attempt_at`,
        notConfirmedSince: sql`coalesce(${externalCardEditSyncs.notConfirmedSince}, excluded.not_confirmed_since)`,
        updatedAt: sql`excluded.updated_at`,
      },
      setWhere: eq(externalCardEditSyncs.state, "open"),
    }).returning({ id: externalCardEditSyncs.id });
    recorded += rows.length;
    if (rows.length > 0) touched.push(delivery);
  }
  // A new revision supersedes an older refused one: the pair's notices follow,
  // after every sync row is written (the global lock order).
  for (const pair of sortSlackCardEditPairs(touched)) await refreshSlackCardEditPairNotices(executor, pair, input.now);
  return recorded;
}

// ---------------------------------------------------------------------------
// The pair's notices to its admins are a projection of its syncs' CURRENT
// state (one per pair epoch and kind, deduplicated across the pair's
// messages), recomputed in every transaction that changes a sync, under a
// per-pair lock, and recomputed again when the setup panel reads them.
//
// Global lock order for card edit state, in every transaction (the card
// update's intent, the worker's claim, attempt start, outcome and read-back,
// the T sweep): (1) the source message row (the card update FOR UPDATE, the
// attempt start FOR SHARE), (2) sync rows (FOR UPDATE or the intent's
// upsert), (3) the attempt start's authority rows (slackCardEditWorkerService.ts:
// the master flag, the conversation's root channel, installation, binding,
// audience, sender agent, its membership),
// (4) attempt rows, (5) pair notice locks LAST, one per pair, in
// (bindingId, bindingEpoch) order. A transaction holding a pair notice lock
// never waits for a row of (1)-(4): the projection reads syncs without
// locking them. So two cards of one pair updating at once queue, never
// deadlock, and each projection sees the other's committed state.

type NoticeKind = (typeof EXTERNAL_CARD_EDIT_NOTICE_KINDS)[number];

export interface SlackCardEditPair {
  bindingId: string;
  bindingEpoch: number;
}

/** Pairs in the one order pair notice locks are taken. */
export function sortSlackCardEditPairs<T extends SlackCardEditPair>(pairs: readonly T[]): T[] {
  return [...new Map(pairs.map((pair) => [`${pair.bindingId}:${pair.bindingEpoch}`, pair])).values()]
    .sort((left, right) => left.bindingId.localeCompare(right.bindingId) || left.bindingEpoch - right.bindingEpoch);
}

export interface SlackCardEditPairNoticeFact {
  /** The sync that qualifies (the most recently changed one). */
  syncId: string;
  /** edit_waiting: that sync's hold reason. */
  reason: string | null;
}

/**
 * Which notice kinds the pair's syncs qualify for now. A kind is present iff
 * at least one sync qualifies:
 * - edit_waiting: an open sync is held (holdReason set);
 * - latest_update_not_shown: a sync's CURRENT latest revision was refused by
 *   Slack (an older refusal under a newer revision does not count);
 * - not_confirmed: a sync's uncertainty latch is set, and either a read-back
 *   after it could not read the message or found an older revision it cannot
 *   replace (at once), or the latch is at least T old (the fallback when the
 *   read-backs looked right). A definite refusal or plain pending never counts;
 * - updates_cannot_be_shown: a sync ended as a card message with files.
 * An open sync counts while it qualifies; an ended one only within the
 * display window after it ended.
 */
export async function slackCardEditPairNoticeFacts(
  executor: DatabaseExecutor,
  pair: SlackCardEditPair,
  now: Date,
): Promise<Map<NoticeKind, SlackCardEditPairNoticeFact>> {
  const s = externalCardEditSyncs;
  const recentEnd = new Date(now.getTime() - SLACK_CARD_EDIT_NOTICE_DISPLAY_MS).toISOString();
  const latchedBefore = new Date(now.getTime() - SLACK_CARD_EDIT_NOT_CONFIRMED_NOTICE_MS).toISOString();
  const live = sql`(${s.state} = 'open' OR ${s.updatedAt} > ${recentEnd}::timestamptz)`;
  const first = (condition: ReturnType<typeof sql>) =>
    sql<string | null>`(array_agg(${s.id}::text ORDER BY ${s.updatedAt} DESC, ${s.id}) FILTER (WHERE ${condition}))[1]`;
  const held = sql`${s.state} = 'open' AND ${s.holdReason} IS NOT NULL`;
  const [facts] = await executor.select({
    waiting: first(held),
    waitingReason: sql<string | null>`(array_agg(${s.holdReason} ORDER BY ${s.updatedAt} DESC, ${s.id}) FILTER (WHERE ${held}))[1]`,
    refused: first(sql`${s.refusedRevision} = ${s.latestRevision} AND ${live}`),
    uncertain: first(sql`${s.uncertainAt} IS NOT NULL
      AND (${s.readbackProblemAt} IS NOT NULL OR ${s.uncertainAt} <= ${latchedBefore}::timestamptz) AND ${live}`),
    files: first(sql`${s.state} = 'ended' AND ${s.endReason} = 'card_has_files' AND ${s.updatedAt} > ${recentEnd}::timestamptz`),
  }).from(s).where(and(eq(s.bindingId, pair.bindingId), eq(s.bindingEpoch, pair.bindingEpoch)));
  const result = new Map<NoticeKind, SlackCardEditPairNoticeFact>();
  if (facts?.waiting) result.set("edit_waiting", { syncId: facts.waiting, reason: facts.waitingReason });
  if (facts?.refused) result.set("latest_update_not_shown", { syncId: facts.refused, reason: null });
  if (facts?.uncertain) result.set("not_confirmed", { syncId: facts.uncertain, reason: null });
  if (facts?.files) result.set("updates_cannot_be_shown", { syncId: facts.files, reason: null });
  return result;
}

/**
 * Recompute the pair's notice rows from its syncs, in the caller's
 * transaction (the one that changed a sync), under a per-pair transaction
 * lock: two syncs of one pair changing at once (one leaving a hold while
 * another enters one) serialize here, and the later sees the earlier's
 * committed state. Lock order: a caller locks its sync row first, then this.
 * A kind that still qualifies keeps its first-raised time.
 */
let beforePairNoticeLockHookForTests: ((pair: SlackCardEditPair) => Promise<void> | void) | null = null;

/** Tests only: runs in the caller's transaction right before it takes the pair notice lock. */
export function __setSlackCardEditBeforePairNoticeLockHookForTests(
  hook: ((pair: SlackCardEditPair) => Promise<void> | void) | null,
): void {
  beforePairNoticeLockHookForTests = hook;
}

export async function refreshSlackCardEditPairNotices(
  executor: DatabaseExecutor,
  pair: SlackCardEditPair,
  now: Date,
): Promise<void> {
  if (beforePairNoticeLockHookForTests) await beforePairNoticeLockHookForTests(pair);
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`card-edit-pair-notices:${pair.bindingId}:${pair.bindingEpoch}`}, 0))`);
  const facts = await slackCardEditPairNoticeFacts(executor, pair, now);
  const existing = await executor.select().from(externalCardEditPairNotices).where(and(
    eq(externalCardEditPairNotices.bindingId, pair.bindingId),
    eq(externalCardEditPairNotices.bindingEpoch, pair.bindingEpoch),
  ));
  for (const kind of EXTERNAL_CARD_EDIT_NOTICE_KINDS) {
    const fact = facts.get(kind);
    const row = existing.find((notice) => notice.kind === kind);
    if (!fact) {
      if (row) await executor.delete(externalCardEditPairNotices).where(eq(externalCardEditPairNotices.id, row.id));
      continue;
    }
    const reason = fact.reason?.slice(0, 160) ?? null;
    if (row) {
      if (row.lastSyncId !== fact.syncId || row.reason !== reason) {
        await executor.update(externalCardEditPairNotices).set({ lastSyncId: fact.syncId, reason,
          lastRaisedAt: new Date(Math.max(now.getTime(), row.lastRaisedAt.getTime())) })
          .where(eq(externalCardEditPairNotices.id, row.id));
      }
      continue;
    }
    await executor.insert(externalCardEditPairNotices).values({ bindingId: pair.bindingId, bindingEpoch: pair.bindingEpoch,
      kind, reason, lastSyncId: fact.syncId, firstRaisedAt: now, lastRaisedAt: now });
  }
}

export interface SlackCardEditPanelNotice {
  bindingId: string;
  kind: NoticeKind;
  reason: string | null;
  since: Date;
}

/**
 * The setup panel's read: for each pair (current epoch) the caller may show,
 * the notice kinds its syncs qualify for right now (the same projection),
 * since when the notice row says it was first raised. A row whose condition
 * no longer holds is never shown. It carries no message content, card or
 * sender: only the pair, the kind, a hold reason code and a time; the caller
 * passes only pairs whose Raft channel the viewer can see (a thread's card
 * belongs to its parent channel's pair).
 */
export async function listSlackCardEditPanelNotices(
  executor: DatabaseExecutor,
  pairs: readonly SlackCardEditPair[],
  now: Date,
): Promise<SlackCardEditPanelNotice[]> {
  if (pairs.length === 0) return [];
  const rows = await executor.select().from(externalCardEditPairNotices).where(or(...pairs.map((pair) => and(
    eq(externalCardEditPairNotices.bindingId, pair.bindingId),
    eq(externalCardEditPairNotices.bindingEpoch, pair.bindingEpoch),
  ))));
  const notices: SlackCardEditPanelNotice[] = [];
  for (const pair of pairs) {
    const facts = await slackCardEditPairNoticeFacts(executor, pair, now);
    for (const kind of EXTERNAL_CARD_EDIT_NOTICE_KINDS) {
      const fact = facts.get(kind);
      if (!fact) continue;
      const row = rows.find((notice) => notice.bindingId === pair.bindingId
        && notice.bindingEpoch === pair.bindingEpoch && notice.kind === kind);
      notices.push({ bindingId: pair.bindingId, kind, reason: fact.reason, since: row?.firstRaisedAt ?? now });
    }
  }
  return notices.sort((left, right) => left.since.getTime() - right.since.getTime()
    || EXTERNAL_CARD_EDIT_NOTICE_KINDS.indexOf(left.kind) - EXTERNAL_CARD_EDIT_NOTICE_KINDS.indexOf(right.kind));
}

type SyncRow = typeof externalCardEditSyncs.$inferSelect;

/**
 * Whether a sync has a revision to send: the latest is not what Slack is
 * known to show (never sent, superseded in flight, or a read-back found an
 * older one), and Slack has not definitely refused it. A refused revision is
 * never sent again; a newer one is.
 */
export function slackCardEditNeedsSend(row: Pick<SyncRow, "latestRevision" | "shownRevision" | "refusedRevision">): boolean {
  return row.refusedRevision !== row.latestRevision && (row.shownRevision ?? 1) !== row.latestRevision;
}

export type SlackCardEditLatestResult = "succeeded" | "refused" | null;

/**
 * A card's Slack sync as three independent facts (RFC 082 §4.6), and what
 * they combine to. Confirmed only with a definite success for the latest
 * revision, nothing pending, and no unknown outcome ever. A refusal of the
 * latest revision is "not synced" and is reported with the latch; pending is
 * never confirmed. An ended sync is never confirmed either.
 */
export interface SlackCardEditSyncStatus {
  uncertain: boolean;
  latestResult: SlackCardEditLatestResult;
  pending: boolean;
  ended: SyncRow["endReason"];
  confirmed: boolean;
  summary: "confirmed" | "pending" | "not_synced" | "not_confirmed" | "ended";
}

export function slackCardEditSyncStatus(
  row: Pick<SyncRow, "state" | "endReason" | "latestRevision" | "shownRevision" | "succeededRevision"
    | "refusedRevision" | "uncertainAt">,
  attemptInFlight: boolean,
): SlackCardEditSyncStatus {
  const uncertain = row.uncertainAt !== null;
  const latestResult: SlackCardEditLatestResult = row.refusedRevision === row.latestRevision ? "refused"
    : row.succeededRevision === row.latestRevision ? "succeeded" : null;
  const ended = row.state === "ended" ? row.endReason : null;
  const pending = !ended && (attemptInFlight || slackCardEditNeedsSend(row));
  const confirmed = !ended && latestResult === "succeeded" && !pending && !uncertain;
  const summary = ended ? "ended"
    : latestResult === "refused" ? "not_synced"
      : pending ? "pending"
        : confirmed ? "confirmed" : "not_confirmed";
  return { uncertain, latestResult, pending, ended, confirmed, summary };
}

/** Operators: each pair epoch's sync of a message and its status. */
export async function readSlackCardEditSyncState(executor: DatabaseExecutor, messageId: string) {
  const rows = await executor.select().from(externalCardEditSyncs)
    .where(eq(externalCardEditSyncs.sourceMessageId, messageId));
  const result = [];
  for (const row of rows) {
    const [inFlight] = await executor.select({ id: externalCardEditAttempts.id }).from(externalCardEditAttempts)
      .where(and(eq(externalCardEditAttempts.syncId, row.id), eq(externalCardEditAttempts.state, "sending"))).limit(1);
    result.push({ sync: row, status: slackCardEditSyncStatus(row, Boolean(inFlight)) });
  }
  return result;
}
