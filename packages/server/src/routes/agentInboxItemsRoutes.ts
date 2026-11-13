// RFC 081 inbox items on the agent API (#wg-ax:#17): `inbox check` rows
// (`GET /inbox/conversations?items=true`), `POST /inbox/read` and
// `POST /inbox/dismiss`. Mounted by internalAgentApi.ts, which passes the
// history read in (`serveConversation`): a conversation is read exactly as
// `message read --unread` reads it, so there is one read position (D1).
//
// Every refusal goes through refuse(). An item the agent can't see and an
// unknown one answer the same NOT_FOUND bytes (D6, #145).
//
// Reminder items (`reminder:<id>`) exist only for a request whose
// `X-Raft-Client-Capabilities` declares REMINDER_SERVER_ACK_CAPABILITY (D17):
// only a runner that acks reminders through the Server can ever clear one.
// Without it a reminder target answers as an unknown one, and none is listed
// or counted; the daemon's own due-item path delivers the reminder.
//
// A personal assistant (its credential's agent has an owner) has app rows
// only (Tenny, #wg-ax:#17): `inbox check` lists no conversation or reminder
// row, `inbox read` / `inbox dismiss --target` refuse every target but an
// `app:` one (refuseAssistantNonAppTarget), and `dismiss --before` takes app
// rows only. Its owner DM reaches it through GET /events, the one path that
// records its turns (and the WeChat mirror).
import type { Request, Response } from "express";
import {
  AGENT_INBOX_DISMISS_BEFORE_MIN_AGE_MS,
  AGENT_INBOX_DISMISS_BEFORE_NEXT_ACTION,
  AGENT_INBOX_DISMISS_MAX_ITEMS,
  AGENT_INBOX_READ_MAX_CHARS,
  AGENT_INBOX_READ_MAX_ENTRIES,
  AGENT_INBOX_READ_REMAINING_CAP,
  RAFT_CLIENT_CAPABILITIES_HEADER,
  RAFT_HINTS,
  hasReminderServerAckCapability,
  type AgentApiHistoryResponse,
  type AgentApiInboxDismissBody,
  type AgentApiInboxDismissResponse,
  type AgentApiInboxItemRow,
  type AgentApiInboxListResponse,
  type AgentApiInboxReadBody,
  type AgentApiInboxReadResponse,
  type AgentMessage,
} from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import * as reminderCrud from "../apps/reminder/crud";
import { refuse } from "../lib/refusal";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { renderAgentFacingContents } from "../services/agentFacingContent";
import {
  appEventMessage,
  conversationItemRows,
  conversationsBefore,
  dismissReadSeq,
  inboxItemsLaunch,
  inboxReadAppEntry,
  listAgentAppItems,
  listAgentAppItemGroups,
  listAgentReminderItems,
  orderInboxItemRows,
  parseInboxItemTarget,
  readAgentAppItemPage,
  reminderAckRef,
  reminderEntry,
  reminderFiredSince,
  renderRelatedTargets,
  REMINDER_APP,
  resolveRelatedConversationForAgent,
  unackedReminderFires,
  unconsumedAppItemEvents,
  withinPageBudget,
} from "../services/agentInboxItems";
import * as channelService from "../services/channelService";
import * as messageService from "../services/messageService";
import * as oauthService from "../services/oauthService";
import { emitScopeReadUpdated } from "../services/readReceiptService";
import { recordTraceEvent } from "../tracing/semanticTrace";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { getDb } from "../db/index";
import { messages } from "../db/schema";
import { and, gt, inArray, not, eq, sql } from "drizzle-orm";

/** The pre-launch line counts at most this many conversations (a dismiss takes at most 500 a call). */
const PRE_LAUNCH_COUNT_CAP = 1_000;

/**
 * Whether reminder items exist for this request (D17): its runner declared
 * that it acks reminders through the Server. Read per request from the
 * header; every reminder surface below takes it from here.
 */
export function reminderItemsDeclared(req: Request): boolean {
  return hasReminderServerAckCapability(req.header(RAFT_CLIENT_CAPABILITIES_HEADER));
}

/** A personal assistant's request: app rows only (see the header). */
export function isAssistantRequest(req: Request): boolean {
  return Boolean(req.actingAgentAssistantOwnerUserId);
}

/** A personal assistant named a conversation, reminder or single event: only app items are its to read or dismiss here. */
export function refuseAssistantNonAppTarget(res: Response): void {
  refuse(res, 403, {
    code: "ASSISTANT_APP_ITEMS_ONLY",
    error: "Your owner's messages reach you by themselves; inbox read and dismiss here cover app notices only.",
    // Sage's wording (#wg-ax:4ee99a1f): where the app notices are and how to read one.
    suggestedNextAction: "raft inbox check lists your app notices (app:… rows); read one with raft inbox read --target app:<app>/<ref>.",
  });
}

/** The one answer for an item that is not the agent's or does not exist. */
export function refuseInboxItemNotFound(res: Response): void {
  refuse(res, 404, { code: "NOT_FOUND", error: "Not found, or you don't have access." });
}

/** RFC 081: inbox items are off for this server (the flag): list the inbox as before and read each conversation's unread messages. */
export function refuseInboxItemsDisabled(res: Response): void {
  refuse(res, 404, {
    code: "INBOX_ITEMS_DISABLED",
    error: "Inbox items are not switched on for this server yet: list your inbox and read each conversation's unread messages as before.",
    next: RAFT_HINTS.inboxList(),
  });
}

function orchestratorOf(req: Request): AgentOrchestrator | undefined {
  return req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
}

/**
 * Events consumed on the server leave the server's pending queue too, so
 * they are not woken or redelivered (RFC 081 §5): the same pair as
 * `POST /third-party-events/delivered`.
 */
export async function consumeAgentEvents(req: Request, agentId: string, eventIds: readonly string[], via: "read" | "dismissed"): Promise<string[]> {
  const moved = await oauthService.consumeThirdPartyAgentEvents(eventIds, { agentId, via });
  if (moved.length > 0) {
    try {
      orchestratorOf(req)?.acknowledgeDeliveredMessages(agentId, [], moved);
    } catch (err) {
      console.warn("[AgentInboxItems] pending queue not cleared", serializeErrorForLog(err));
    }
  }
  return moved;
}

/** `message read --target agent-event:<id>` (and `inbox read` of one): the event it showed is read. Never fails the read. */
export async function consumeReadAgentEvent(req: Request, agentId: string, message: AgentMessage): Promise<void> {
  const eventId = message.third_party_event?.id ?? (typeof message.message_id === "string" ? message.message_id : null);
  if (!eventId) return;
  try {
    await consumeAgentEvents(req, agentId, [eventId], "read");
  } catch (err) {
    console.error("[AgentInboxItems] read event not marked read", serializeErrorForLog(err));
  }
}

// ---------------------------------------------------------------------------
// inbox check rows

/** `items=true`: the rows, pre-launch count and omitted counts beside the conversation list. */
export async function inboxItemsListFields(input: {
  agentId: string;
  serverId: string;
  list: AgentApiInboxListResponse;
  pageRows: channelService.AgentInboxChainRow[];
  firstPage: boolean;
  /** reminderItemsDeclared(req): without it no reminder row is listed or counted in `omitted`. */
  reminderItems: boolean;
  /** A personal assistant: app rows only, no pre-launch line (it has no conversation rows). */
  appRowsOnly?: boolean;
}): Promise<Pick<AgentApiInboxListResponse, "rows" | "preLaunch" | "omitted" | "appRowsOnly">> {
  const launch = inboxItemsLaunch();
  if (input.appRowsOnly) {
    const appListing = launch && input.firstPage && input.list.view === "unread"
      ? await listAgentAppItems({ serverId: input.serverId, agentId: input.agentId, launch })
      : { rows: [], omitted: 0 };
    return {
      rows: orderInboxItemRows({ reminders: [], apps: appListing.rows, conversations: [] }),
      preLaunch: null,
      omitted: appListing.omitted > 0 ? { app: appListing.omitted, reminder: 0 } : null,
      appRowsOnly: true,
    };
  }
  const conversations = await conversationItemRows({ items: input.list.items, pageRows: input.pageRows, preLaunchBefore: launch?.dayStart ?? null });
  let apps: AgentApiInboxItemRow[] = [];
  let reminders: AgentApiInboxItemRow[] = [];
  let omittedApps = 0;
  let omittedReminders = 0;
  // App and reminder items exist from launch on, all on page 1; the mentions view lists conversations only.
  if (launch && input.firstPage && input.list.view === "unread") {
    const [appListing, reminderListing] = await Promise.all([
      listAgentAppItems({ serverId: input.serverId, agentId: input.agentId, launch }),
      input.reminderItems
        ? listAgentReminderItems({ serverId: input.serverId, agentId: input.agentId, launch })
        : { rows: [], omitted: 0 },
    ]);
    apps = appListing.rows;
    reminders = reminderListing.rows;
    omittedApps = appListing.omitted;
    omittedReminders = reminderListing.omitted;
  }
  // Exactly what `inbox dismiss --before <launch day>` would take, so running the line's command clears the line.
  const preLaunchCount = launch ? (await conversationsBefore(input.agentId, launch.dayStart, PRE_LAUNCH_COUNT_CAP)).length : 0;
  return {
    rows: orderInboxItemRows({ reminders, apps, conversations }),
    preLaunch: launch && preLaunchCount > 0 ? { count: preLaunchCount, before: launch.day } : null,
    omitted: omittedApps > 0 || omittedReminders > 0 ? { app: omittedApps, reminder: omittedReminders } : null,
  };
}

// ---------------------------------------------------------------------------
// inbox read

/**
 * Where the history read hands its page for an `inbox read`. `consumePage`
 * marks the page read; nothing is marked until the sink calls it, which it
 * does only once the response has passed its contract.
 */
export type ServeConversationReadSink = (
  body: AgentApiHistoryResponse,
  facts: { storageChannelId: string; historyCutoff: Date | undefined; pageLastSeq: number | null; consumePage: () => Promise<void> },
) => Promise<void>;

export type ServeConversationRead = (
  req: Request,
  res: Response,
  input: {
    target: string;
    limit: number;
    maxChars: number;
    sink: ServeConversationReadSink;
  },
) => Promise<void>;

/**
 * Checks the response against the contract without sending it: the returned
 * function sends. Null when it fails the check (the refusal is then already
 * answered). Every read below checks, then consumes, then sends: a read that
 * cannot answer consumes nothing.
 */
type InboxReadPrepare = (body: AgentApiInboxReadResponse) => (() => void) | null;

/** Others' messages after `afterSeq` in the conversation's window, stopping at the cap (+1 says "capped"). */
async function remainingConversationMessages(input: { storageChannelId: string; afterSeq: number; historyCutoff: Date | undefined; agentId: string }): Promise<{ remaining: number; capped: boolean }> {
  const rows = await getDb().select({ seq: messages.seq }).from(messages).where(and(
    eq(messages.channelId, input.storageChannelId),
    gt(messages.seq, input.afterSeq),
    input.historyCutoff ? gt(messages.createdAt, input.historyCutoff) : undefined,
    not(and(eq(messages.senderType, "agent"), eq(messages.senderId, input.agentId))!),
    sql`${messages.deletedAt} is null`,
  )).limit(AGENT_INBOX_READ_REMAINING_CAP + 1);
  return { remaining: Math.min(rows.length, AGENT_INBOX_READ_REMAINING_CAP), capped: rows.length > AGENT_INBOX_READ_REMAINING_CAP };
}

export async function handleInboxRead(req: Request, res: Response, deps: { serveConversation: ServeConversationRead; prepare: InboxReadPrepare }): Promise<void> {
  const agentId = req.actingAgentId!;
  const serverId = req.serverId!;
  const body = req.body as AgentApiInboxReadBody;
  const limit = Math.min(body.limit ?? AGENT_INBOX_READ_MAX_ENTRIES, AGENT_INBOX_READ_MAX_ENTRIES);
  const target = parseInboxItemTarget(body.target);
  // inboxItemsEnabled already required one; read again here, the same env.
  const launch = inboxItemsLaunch();
  if (!launch) {
    refuseInboxItemsDisabled(res);
    return;
  }
  if (target.kind === "invalid") {
    refuse(res, 400, {
      code: "INVALID_TARGET",
      error: "That is not an inbox item target: give a conversation, an app item (app, then a slash and the object), an app, a reminder or one app event, as the inbox list names them.",
      next: RAFT_HINTS.inboxList(),
    });
    return;
  }
  if (isAssistantRequest(req) && target.kind !== "app") {
    refuseAssistantNonAppTarget(res);
    return;
  }
  if (body.cursor !== undefined && target.kind !== "reminder") {
    refuse(res, 400, {
      code: "INVALID_CURSOR",
      error: "Only a reminder's read takes a cursor: read any other item again to get its next page, because what a read returns is consumed.",
    });
    return;
  }

  if (target.kind === "conversation") {
    await deps.serveConversation(req, res, {
      target: target.target,
      limit,
      maxChars: AGENT_INBOX_READ_MAX_CHARS,
      sink: async (history, facts) => {
        const seqOf = (value: unknown): number | null | undefined => (typeof value === "number" || value === null ? value : undefined);
        const lastReadSeq = seqOf(history.last_read_seq);
        const readThroughSeq = seqOf(history.read_through_seq);
        const after = facts.pageLastSeq ?? readThroughSeq ?? lastReadSeq ?? 0;
        const { remaining, capped } = await remainingConversationMessages({ storageChannelId: facts.storageChannelId, afterSeq: Number(after) || 0, historyCutoff: facts.historyCutoff, agentId });
        // Validated against the inbox read schema on the way out (sendAgentApiResponse); the history types are hand-written.
        const reply: Record<string, unknown> = {
          target: typeof history.target === "string" ? history.target : target.target,
          kind: "conversation",
          entries: history.messages as unknown as AgentApiInboxReadResponse["entries"],
          unreadBefore: history.messages.length + remaining,
          remaining,
          remainingCapped: capped,
          // The settle window counts as given out: its read-position move is the history read's deferred one (Tenny, Q5).
          consumed: remaining === 0,
          nextCursor: null,
          ...(lastReadSeq !== undefined ? { last_read_seq: lastReadSeq } : {}),
          ...(readThroughSeq !== undefined ? { read_through_seq: readThroughSeq } : {}),
          ...(history.consumption_scope && { consumption_scope: history.consumption_scope }),
          ...(history.historyLimited ? { historyLimited: true, ...(typeof history.historyLimitMessage === "string" ? { historyLimitMessage: history.historyLimitMessage } : {}) } : {}),
          ...(history.channel_card && { channel_card: history.channel_card }),
          ...(history.peer_card && { peer_card: history.peer_card }),
        };
        const send = deps.prepare(reply as AgentApiInboxReadResponse);
        if (!send) return;
        await facts.consumePage();
        send();
      },
    });
    return;
  }

  if (target.kind === "event") {
    const found = await oauthService.readThirdPartyAgentEventForAgent({ agentId, ref: target.ref });
    if (found.kind === "ambiguous") {
      refuse(res, 409, {
        code: "AMBIGUOUS_ID",
        error: `That 8-character event address matches more than one of your events (${found.candidates.map((candidate) => candidate.id).join(", ")}): read one by its full id.`,
      });
      return;
    }
    if (found.kind === "expired") {
      refuse(res, 410, { code: "EXPIRED", error: "This app event has expired and is no longer kept." });
      return;
    }
    if (found.kind === "absent") {
      refuseInboxItemNotFound(res);
      return;
    }
    const [content] = await renderAgentFacingContents([found.message], agentId, serverId);
    // No raw data in an inbox read (Tenny): `message read --target agent-event:<id>` shows the payload.
    const entry = inboxReadAppEntry(found.message, content!);
    const send = deps.prepare({
      target: `agent-event:${String(found.message.message_id ?? target.ref)}`,
      kind: "event",
      entries: [entry as unknown as AgentApiInboxReadResponse["entries"][number]],
      unreadBefore: 1,
      remaining: 0,
      remainingCapped: false,
      consumed: true,
      nextCursor: null,
    });
    if (!send) return;
    await consumeReadAgentEvent(req, agentId, found.message);
    send();
    return;
  }

  if (target.kind === "app") {
    const page = await readAgentAppItemPage({ agentId, appKey: target.appKey, objectRef: target.objectRef, launch, limit });
    if (page.kind === "absent") {
      refuseInboxItemNotFound(res);
      return;
    }
    if (page.kind === "expired") {
      refuse(res, 410, { code: "EXPIRED", error: "Every notice in this item has expired and is no longer kept." });
      return;
    }
    const built = page.events.map((row) => ({ row, message: appEventMessage(row) }));
    const contents = await renderAgentFacingContents(built.map((entry) => entry.message), agentId, serverId);
    const shown = withinPageBudget(
      built.map((entry, index) => ({ ...entry, entry: inboxReadAppEntry(entry.message, contents[index]!) })),
      (entry) => String(entry.entry.content ?? ""),
    );
    const shownIds = shown.map((entry) => entry.row.event.id);
    const { remaining, capped } = await page.remainingAfterPage(shownIds);
    const related = page.relatedChannelId ? await renderRelatedTargets(serverId, agentId, [page.relatedChannelId]) : new Map<string, string>();
    const send = deps.prepare({
      target: `app:${target.appKey}${target.objectRef !== null ? `/${target.objectRef}` : ""}`,
      kind: target.objectRef !== null ? "app" : "app_fallback",
      entries: shown.map((entry) => entry.entry as unknown as AgentApiInboxReadResponse["entries"][number]),
      unreadBefore: page.unreadBefore,
      remaining,
      remainingCapped: capped,
      consumed: remaining === 0,
      nextCursor: null,
      ...(page.app && { app: page.app }),
      related: page.relatedChannelId && related.has(page.relatedChannelId) ? { target: related.get(page.relatedChannelId)! } : null,
    });
    if (!send) return;
    // Consumes exactly what this page returns.
    await consumeAgentEvents(req, agentId, shownIds, "read");
    send();
    return;
  }

  // A reminder: shown with its acks, never consumed by reading (D13).
  // Not an item for a runner that can't ack it on the Server (D17): unknown.
  if (!reminderItemsDeclared(req)) {
    refuseInboxItemNotFound(res);
    return;
  }
  const resolved = await reminderCrud.resolveAppHistoricalReminderIdForOwner(target.ref, serverId, agentId);
  if (resolved.kind === "ambiguous") {
    refuse(res, 409, { code: "AMBIGUOUS_ID", error: "That short reminder id matches more than one of your reminders: read it by its full id." });
    return;
  }
  // Only a reminder that fired since launch is an item (D9); one that fired only before is not found.
  if (resolved.kind !== "resolved" || !await reminderFiredSince({ serverId, agentId, reminderId: resolved.reminderId, since: launch.at })) {
    refuseInboxItemNotFound(res);
    return;
  }
  const fires = await unackedReminderFires({ serverId, agentId, since: launch.at, reminderId: resolved.reminderId });
  const offset = body.cursor === undefined ? 0 : /^(0|[1-9][0-9]{0,6})$/.test(body.cursor) ? Number(body.cursor) : -1;
  if (offset < 0 || offset > fires.length) {
    refuse(res, 400, { code: "INVALID_CURSOR", error: "That cursor is not one this reminder's read gave: start again without it." });
    return;
  }
  const shown = withinPageBudget(fires.slice(offset, offset + limit).map(reminderEntry), (entry) => entry.content);
  const nextOffset = offset + shown.length;
  const remaining = fires.length - nextOffset;
  // A reminder is never consumed by reading: checked and sent in one step.
  deps.prepare({
    target: `reminder:${resolved.reminderId.slice(0, 8)}`,
    kind: "reminder",
    entries: shown as AgentApiInboxReadResponse["entries"],
    unreadBefore: fires.length - offset,
    remaining,
    remainingCapped: false,
    consumed: false,
    nextCursor: remaining > 0 ? String(nextOffset) : null,
    app: { ...REMINDER_APP },
    related: null,
    ack: fires.map(reminderAckRef),
  })?.();
}

// ---------------------------------------------------------------------------
// inbox dismiss

const BEFORE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BEFORE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** `YYYY-MM-DD` (00:00 UTC) or an RFC 3339 time with `Z` or an offset; null when it is neither. */
export function parseDismissBefore(raw: string): Date | null {
  const value = raw.trim();
  const iso = BEFORE_DAY_RE.test(value) ? `${value}T00:00:00.000Z` : BEFORE_TIME_RE.test(value) ? value : null;
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  // `2026-02-31` parses to March in some engines: the day must round-trip.
  if (BEFORE_DAY_RE.test(value) && new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return new Date(ms);
}

type DismissCandidate =
  | { kind: "conversation"; at: number; row: channelService.AgentInboxChainRow }
  | { kind: "app"; at: number; firstAt: number; eventIds: string[] };

type DismissOutcome = { conversations: number; appItems: number; earliestMs: number | null; appEvents: number };

async function messageTimesBySeq(seqs: readonly number[]): Promise<Map<number, number>> {
  const wanted = [...new Set(seqs.filter((seq) => Number.isSafeInteger(seq) && seq > 0))];
  if (wanted.length === 0) return new Map();
  const rows = await getDb().select({ seq: messages.seq, createdAt: messages.createdAt }).from(messages).where(inArray(messages.seq, wanted));
  return new Map(rows.map((row) => [Number(row.seq), (row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)).getTime()]));
}

/** Moves the read position through the conversation's latest seq as the chain knows it: messages after that stay unread. */
async function dismissConversation(req: Request, agentId: string, serverId: string, row: channelService.AgentInboxChainRow): Promise<boolean> {
  const seq = dismissReadSeq(row);
  if (seq <= row.lastReadSeq) return false;
  const readState = await channelService.markRead({ kind: "agent", id: agentId }, row.targetId, seq);
  void emitScopeReadUpdated({
    io: req.app.get("io") as SocketServer | undefined,
    serverId,
    scopeId: row.targetId,
    peerKind: "agent",
    peerId: agentId,
    maxReadSeq: readState.maxReadSeq,
    changed: readState.changed,
  });
  return true;
}

async function applyDismiss(req: Request, agentId: string, serverId: string, candidates: readonly DismissCandidate[]): Promise<DismissOutcome> {
  const outcome: DismissOutcome = { conversations: 0, appItems: 0, earliestMs: null, appEvents: 0 };
  const firstUnread = await messageTimesBySeq(candidates.flatMap((candidate) => (candidate.kind === "conversation" && candidate.row.firstUnreadSeq ? [candidate.row.firstUnreadSeq] : [])));
  const note = (ms: number) => {
    if (outcome.earliestMs === null || ms < outcome.earliestMs) outcome.earliestMs = ms;
  };
  for (const candidate of candidates) {
    if (candidate.kind === "conversation") {
      if (await dismissConversation(req, agentId, serverId, candidate.row)) {
        outcome.conversations += 1;
        note(candidate.row.firstUnreadSeq ? firstUnread.get(candidate.row.firstUnreadSeq) ?? candidate.at : candidate.at);
      }
      continue;
    }
    const moved = await consumeAgentEvents(req, agentId, candidate.eventIds, "dismissed");
    if (moved.length > 0) {
      outcome.appItems += 1;
      outcome.appEvents += moved.length;
      note(candidate.firstAt);
    }
  }
  return outcome;
}

async function conversationCandidate(serverId: string, agentId: string, target: string): Promise<{ channelId: string } | null> {
  const channelId = await resolveRelatedConversationForAgent(serverId, agentId, target);
  return channelId ? { channelId } : null;
}

export async function handleInboxDismiss(req: Request, res: Response, deps: { answer: (body: AgentApiInboxDismissResponse) => void }): Promise<void> {
  const agentId = req.actingAgentId!;
  const serverId = req.serverId!;
  const body = req.body as AgentApiInboxDismissBody;
  const hasTarget = typeof body.target === "string" && body.target.trim() !== "";
  const hasBefore = typeof body.before === "string" && body.before.trim() !== "";
  if (hasTarget === hasBefore) {
    refuse(res, 400, { code: "INVALID_ARG", error: "Give exactly one of target (one item) or before (every item with no activity since then); there is no form that dismisses everything." });
    return;
  }
  const launch = inboxItemsLaunch();
  if (!launch) {
    refuseInboxItemsDisabled(res);
    return;
  }
  const now = Date.now();
  let candidates: DismissCandidate[] = [];
  let skippedNeedsAck = 0;
  let remaining = 0;
  let targetKind: string | null = null;

  if (hasTarget) {
    const target = parseInboxItemTarget(body.target!);
    targetKind = target.kind;
    if (target.kind === "invalid" || target.kind === "event") {
      refuse(res, 400, {
        code: "INVALID_TARGET",
        error: target.kind === "event"
          ? "One app event is not an item: dismiss the item it belongs to, or read the event."
          : "That is not an inbox item target: give a conversation, an app item, an app or a reminder, as the inbox list names them.",
        next: RAFT_HINTS.inboxList(),
      });
      return;
    }
    if (isAssistantRequest(req) && target.kind !== "app") {
      refuseAssistantNonAppTarget(res);
      return;
    }
    if (target.kind === "reminder") {
      // Not an item for a runner that can't ack it on the Server (D17): unknown, not NEEDS_ACK.
      if (!reminderItemsDeclared(req)) {
        refuseInboxItemNotFound(res);
        return;
      }
      const resolved = await reminderCrud.resolveAppHistoricalReminderIdForOwner(target.ref, serverId, agentId);
      if (resolved.kind === "ambiguous") {
        refuse(res, 409, { code: "AMBIGUOUS_ID", error: "That short reminder id matches more than one of your reminders: name it by its full id." });
        return;
      }
      if (resolved.kind !== "resolved" || !await reminderFiredSince({ serverId, agentId, reminderId: resolved.reminderId, since: launch.at })) {
        refuseInboxItemNotFound(res);
        return;
      }
      const fires = await unackedReminderFires({ serverId, agentId, since: launch.at, reminderId: resolved.reminderId });
      const first = fires[0];
      refuse(res, 409, {
        code: "NEEDS_ACK",
        error: "A reminder can't be dismissed: it stays in the inbox until each fired revision is acked.",
        ...(first && { suggestedNextAction: `raft reminder ack --id ${first.reminderId} --revision ${first.revision}` }),
      });
      return;
    }
    if (target.kind === "app") {
      const events = await unconsumedAppItemEvents({ agentId, appKey: target.appKey, objectRef: target.objectRef, launch });
      if (events === null) {
        refuseInboxItemNotFound(res);
        return;
      }
      if (events.length > 0) {
        candidates = [{
          kind: "app",
          at: events.at(-1)!.event.createdAt.getTime(),
          firstAt: events[0]!.event.createdAt.getTime(),
          eventIds: events.map((row) => row.event.id),
        }];
      }
    } else {
      const found = await conversationCandidate(serverId, agentId, target.target);
      if (!found) {
        refuseInboxItemNotFound(res);
        return;
      }
      const [row] = await channelService.readAgentInboxChainRowsForDismiss(agentId, { targetIds: [found.channelId] });
      if (row) candidates = [{ kind: "conversation", at: (await messageTimesBySeq([row.activitySeq])).get(row.activitySeq) ?? now, row }];
    }
  } else {
    const before = parseDismissBefore(body.before!);
    if (!before) {
      refuse(res, 400, { code: "INVALID_BEFORE", error: "before must be a day as YYYY-MM-DD (00:00 UTC) or an RFC 3339 time with Z or an offset, such as 2026-11-01T09:00:00Z." });
      return;
    }
    // At least 24 h ago, so it can never act as "all"; the one exception is
    // the launch day itself (00:00 UTC), which the pre-launch line names, as
    // long as it has begun (Tenny, #13787).
    const isLaunchDay = before.getTime() === launch.dayStart.getTime() && before.getTime() <= now;
    if (!isLaunchDay && before.getTime() > now - AGENT_INBOX_DISMISS_BEFORE_MIN_AGE_MS) {
      refuse(res, 400, {
        code: "BEFORE_TOO_RECENT",
        error: "before must be at least 24 hours ago, or the launch day the inbox list names, so it can't dismiss everything: give an earlier time.",
        suggestedNextAction: AGENT_INBOX_DISMISS_BEFORE_NEXT_ACTION,
      });
      return;
    }
    const beforeMs = before.getTime();
    // The same selection the pre-launch line counts. A personal assistant's `before` takes app rows only.
    const appRowsOnly = isAssistantRequest(req);
    const selected = appRowsOnly ? [] : await conversationsBefore(agentId, before, AGENT_INBOX_DISMISS_MAX_ITEMS + 1);
    const conversations = selected.map(({ row, at }): DismissCandidate => ({ kind: "conversation", at, row }));
    const appGroups = await listAgentAppItemGroups({ agentId, launch });
    const apps = appGroups.flatMap((group): DismissCandidate[] => {
      const latest = group[0]!.event.createdAt.getTime();
      return latest < beforeMs ? [{ kind: "app", at: latest, firstAt: group.at(-1)!.event.createdAt.getTime(), eventIds: group.map((row) => row.event.id) }] : [];
    });
    // Reminders are skipped, and counted as such, only where they are items (D17).
    const reminders = reminderItemsDeclared(req) && !appRowsOnly ? await unackedReminderFires({ serverId, agentId, since: launch.at }) : [];
    const reminderLatest = new Map<string, number>();
    for (const fire of reminders) reminderLatest.set(fire.reminderId, Math.max(reminderLatest.get(fire.reminderId) ?? 0, fire.firedAt.getTime()));
    skippedNeedsAck = [...reminderLatest.values()].filter((at) => at < beforeMs).length;
    const all = [...conversations, ...apps].sort((a, b) => a.at - b.at);
    candidates = all.slice(0, AGENT_INBOX_DISMISS_MAX_ITEMS);
    remaining = all.length - candidates.length + (selected.length > AGENT_INBOX_DISMISS_MAX_ITEMS && all.length <= AGENT_INBOX_DISMISS_MAX_ITEMS ? 1 : 0);
  }

  const outcome = await applyDismiss(req, agentId, serverId, candidates);
  const dismissed = outcome.conversations + outcome.appItems;
  const earliestActivityAt = outcome.earliestMs === null ? null : new Date(outcome.earliestMs).toISOString();
  // Every use is visible (D12): a trace, and the agent's own activity. Counts and times only, never content.
  recordTraceEvent("server.agent_api.inbox_dismiss", {
    agent_id: agentId,
    server_id: serverId,
    mode: hasTarget ? "target" : "before",
    ...(targetKind && { target_kind: targetKind }),
    ...(hasBefore && { before: body.before!.trim() }),
    dismissed_count: dismissed,
    dismissed_conversations: outcome.conversations,
    dismissed_app_items: outcome.appItems,
    dismissed_app_events: outcome.appEvents,
    skipped_needs_ack_count: skippedNeedsAck,
    remaining_count: remaining,
    ...(earliestActivityAt && { earliest_activity_at: earliestActivityAt }),
    client_kind: clientKindOf(req),
  });
  if (dismissed > 0) {
    const orchestrator = orchestratorOf(req);
    if (typeof orchestrator?.recordAgentRaftAction === "function") {
      await orchestrator.recordAgentRaftAction(agentId, {
        title: "Dismissed inbox items",
        text: `${dismissed} item${dismissed === 1 ? "" : "s"} dismissed without reading (${outcome.conversations} conversation${outcome.conversations === 1 ? "" : "s"}, ${outcome.appItems} app item${outcome.appItems === 1 ? "" : "s"}); earliest activity ${earliestActivityAt}${hasTarget ? `; ${body.target!.trim()}` : ""}`,
      }).catch((err: unknown) => console.warn("[AgentInboxItems] dismiss action not recorded", serializeErrorForLog(err)));
    }
  }
  deps.answer({
    dismissed,
    conversations: outcome.conversations,
    appItems: outcome.appItems,
    skippedNeedsAck,
    earliestActivityAt,
    remaining,
  });
}

function clientKindOf(req: Request): string {
  const client = req.header("X-Raft-Client") ?? req.header("X-Slock-Client");
  if (!client) return "absent";
  if (client === "cli" || client === "sdk") return client;
  return client.startsWith("daemon") ? "daemon" : "other";
}
