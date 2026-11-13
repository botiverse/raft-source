// RFC 081 inbox items (#wg-ax:#17): what `raft inbox check` lists beside
// conversations, and the reads and dismissals of `raft inbox read` /
// `raft inbox dismiss`. An item is a conversation, an app item (an app's
// events about one object: `app:<key>/<object_ref>`), an app's fallback item
// (its events with no object: `app:<key>`), or a reminder item
// (`reminder:<id>`: its fired revisions not yet acked).
//
// One read state (RFC 081 §5): a conversation's read position; an event's
// `status = 'delivered'` (with `consumed_via`); a reminder revision's ack row.
// Nothing here adds another. Every query is scoped to the acting agent in
// SQL, so another agent's item and an unknown one take the same path (D6).
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import {
  AGENT_INBOX_APP_TARGET_PREFIX,
  AGENT_INBOX_MAX_APP_ROWS,
  AGENT_INBOX_MAX_REMINDER_ROWS,
  AGENT_INBOX_OBJECT_REF_MAX_CHARS,
  AGENT_INBOX_OBJECT_REF_PATTERN,
  AGENT_INBOX_PREVIEW_MAX_CHARS,
  AGENT_INBOX_READ_MAX_CHARS,
  AGENT_INBOX_READ_REMAINING_CAP,
  AGENT_INBOX_REMINDER_TARGET_PREFIX,
  RAFT_TASK_REF_SEPARATOR,
  foldAgentOneLineText,
  renderThirdPartyInertText,
  type AgentApiInboxAckRef,
  type AgentApiInboxItemRow,
  type AgentApiInboxLatestSender,
  type AgentMessage,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, channels, messages, oauthClients, tasks, thirdPartyAgentEvents, users } from "../db/schema";
import { resolveAgentTaskRefConversation, taskRefOfMessageTarget } from "../routes/agentWritableTarget";
import * as channelService from "./channelService";
import { THIRD_PARTY_EVENT_APP_COLUMNS, buildThirdPartyAgentMessage } from "./oauthService";
import { filterReadableSystemAppEvents } from "./systemAppDeliveryGuards";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { NOT_ITEM_SYSTEM_APPS, appEventInboxItemTarget, type InboxItemsLaunch } from "./inboxItemsLaunch";

// ---------------------------------------------------------------------------
// Switch and launch (inboxItemsLaunch.ts)

export { INBOX_ITEMS_APP_EVENTS_FROM_ENV, INBOX_ITEMS_LAUNCH_AT_ENV, inboxItemsEnabled, inboxItemsLaunch, type InboxItemsLaunch } from "./inboxItemsLaunch";

/**
 * The first message seq at or after `at` (through idx_messages_created_at),
 * or null when no message is that new yet. Seq order is close to, not
 * exactly, commit order: good enough for a boundary.
 *
 * Across every server on purpose: `messages.seq` is one global sequence (a
 * bigserial), so the first message at or after `at` on any server is the
 * right boundary. It only narrows the scan; at the edge the message's own
 * time decides (conversationsBefore).
 */
export async function firstMessageSeqAtOrAfter(at: Date): Promise<number | null> {
  const [row] = await getDb().select({ seq: messages.seq }).from(messages)
    .where(gte(messages.createdAt, at))
    .orderBy(asc(messages.createdAt))
    .limit(1);
  return row ? Number(row.seq) : null;
}

// ---------------------------------------------------------------------------
// Targets

export type InboxItemTarget =
  | { kind: "app"; appKey: string; objectRef: string | null }
  | { kind: "reminder"; ref: string }
  | { kind: "event"; ref: string }
  | { kind: "conversation"; target: string }
  | { kind: "invalid"; reason: string };

const APP_KEY_RE = /^(?:[a-z][a-z0-9-]{2,63}|system\.[a-z][a-z0-9_-]{0,62})$/;
const REMINDER_REF_RE = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const EVENT_TARGET_RE = /^agent-event:([0-9a-fA-F]{8}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** An item target as `inbox check` lists it: `app:` first, then `reminder:`, `agent-event:`, else a conversation target. */
export function parseInboxItemTarget(raw: string): InboxItemTarget {
  const target = raw.trim();
  if (target.startsWith(AGENT_INBOX_APP_TARGET_PREFIX)) {
    const rest = target.slice(AGENT_INBOX_APP_TARGET_PREFIX.length);
    const slash = rest.indexOf("/");
    const appKey = slash < 0 ? rest : rest.slice(0, slash);
    const objectRef = slash < 0 ? null : rest.slice(slash + 1);
    if (!APP_KEY_RE.test(appKey)) return { kind: "invalid", reason: "app" };
    if (objectRef !== null && (objectRef.length < 1 || objectRef.length > AGENT_INBOX_OBJECT_REF_MAX_CHARS || !AGENT_INBOX_OBJECT_REF_PATTERN.test(objectRef))) {
      return { kind: "invalid", reason: "object_ref" };
    }
    return { kind: "app", appKey, objectRef };
  }
  if (target.startsWith(AGENT_INBOX_REMINDER_TARGET_PREFIX)) {
    const ref = target.slice(AGENT_INBOX_REMINDER_TARGET_PREFIX.length).toLowerCase();
    return REMINDER_REF_RE.test(ref) ? { kind: "reminder", ref } : { kind: "invalid", reason: "reminder" };
  }
  const event = EVENT_TARGET_RE.exec(target);
  if (event) return { kind: "event", ref: event[1]!.toLowerCase() };
  if (target.startsWith("agent-event:")) return { kind: "invalid", reason: "event" };
  return { kind: "conversation", target };
}

/** Whether an app's events can be inbox items: every app's but NOT_ITEM_SYSTEM_APPS (RaftBench keeps its own path). */
export function isItemAppKey(appKey: string): boolean {
  return !(NOT_ITEM_SYSTEM_APPS as readonly string[]).includes(appKey);
}

// ---------------------------------------------------------------------------
// Related conversations (D8)

/**
 * `object.conversation` for the receiving agent: the conversation's channel
 * id when the agent can open it, else null (no such conversation, or not
 * the agent's: the app is told the same either way). Task refs and threads
 * resolve as `message read` resolves them.
 */
export async function resolveRelatedConversationForAgent(serverId: string, agentId: string, target: string): Promise<string | null> {
  try {
    const taskRef = taskRefOfMessageTarget(target);
    let channelId: string | null = null;
    if (taskRef) {
      const found = await resolveAgentTaskRefConversation(serverId, agentId, taskRef, { create: false });
      channelId = found && typeof found === "object" && found.kind === "conversation" ? found.channelId : null;
    } else {
      channelId = (await channelService.resolveChannelByName(serverId, agentId, target))?.channelId ?? null;
    }
    if (!channelId) return null;
    return await channelService.canAgentAccessChannel(channelId, agentId) ? channelId : null;
  } catch (err) {
    console.warn("[AgentInboxItems] object.conversation not resolved", serializeErrorForLog(err));
    return null;
  }
}

/**
 * How the agent addresses each of these conversations now, for the ones it
 * can still open (checked again on every listing: a notice never widens what
 * the agent can see). A thread is `<parent>:<msg8>`, a task conversation
 * `<board>:#<n>`.
 */
export async function renderRelatedTargets(serverId: string, agentId: string, channelIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(channelIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const rows = await getDb().select({
    id: channels.id,
    type: channels.type,
    parentChannelId: channels.parentChannelId,
    parentMessageId: channels.parentMessageId,
    taskNumber: tasks.taskNumber,
  }).from(channels)
    .leftJoin(tasks, eq(tasks.id, channels.taskId))
    .where(inArray(channels.id, ids));
  for (const row of rows) {
    try {
      if (!await channelService.canAgentAccessChannel(row.id, agentId)) continue;
      if (row.type === "thread" && row.parentChannelId && row.parentMessageId) {
        const parent = await channelService.resolveAgentFacingChannelRef(serverId, agentId, row.parentChannelId);
        if (parent) out.set(row.id, `${parent}:${row.parentMessageId.slice(0, 8)}`);
        continue;
      }
      if (row.type === "task" && row.parentChannelId && row.taskNumber != null) {
        const board = await channelService.resolveAgentFacingChannelRef(serverId, agentId, row.parentChannelId);
        if (board) out.set(row.id, `${board}${RAFT_TASK_REF_SEPARATOR}${row.taskNumber}`);
        continue;
      }
      const ref = await channelService.resolveAgentFacingChannelRef(serverId, agentId, row.id);
      if (ref) out.set(row.id, ref);
    } catch (err) {
      console.warn("[AgentInboxItems] related conversation not rendered", serializeErrorForLog(err));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Previews

/** One folded, inert line of at most AGENT_INBOX_PREVIEW_MAX_CHARS, and whether it was cut. */
export function inboxPreview(text: string | null | undefined, inert: boolean): { preview: string | null; previewTruncated: boolean } {
  if (!text) return { preview: null, previewTruncated: false };
  const firstLine = text.split(/\r\n|[\r\n\u0085\u2028\u2029]/).find((line) => line.trim()) ?? "";
  const folded = foldAgentOneLineText(inert ? renderThirdPartyInertText({ field: "tool_result", value: firstLine }) : firstLine);
  if (!folded) return { preview: null, previewTruncated: false };
  const cutForLines = firstLine.length < text.trim().length;
  if (folded.length <= AGENT_INBOX_PREVIEW_MAX_CHARS) return { preview: folded, previewTruncated: cutForLines };
  let cut = AGENT_INBOX_PREVIEW_MAX_CHARS;
  const last = folded.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // never split a surrogate pair
  return { preview: folded.slice(0, cut), previewTruncated: true };
}

type MessageFacts = { seq: number; createdAt: string; content: string; senderName: string | null; senderType: AgentApiInboxLatestSender["type"]; inert: boolean };

/** Content, sender and time of these messages (seq is global), for a page of conversation rows. */
async function messageFactsBySeq(seqs: readonly number[]): Promise<Map<number, MessageFacts>> {
  const out = new Map<number, MessageFacts>();
  const wanted = [...new Set(seqs.filter((seq) => Number.isSafeInteger(seq) && seq > 0))];
  if (wanted.length === 0) return out;
  const rows = await getDb().select({
    seq: messages.seq,
    createdAt: messages.createdAt,
    content: messages.content,
    messageType: messages.messageType,
    senderType: messages.senderType,
    userName: users.name,
    agentName: agents.name,
  })
    .from(messages)
    .leftJoin(users, and(eq(messages.senderType, "user"), sql`${users.id}::text = ${messages.senderId}`))
    .leftJoin(agents, and(eq(messages.senderType, "agent"), sql`${agents.id}::text = ${messages.senderId}`))
    .where(inArray(messages.seq, wanted));
  for (const row of rows) {
    const system = row.messageType === "system";
    const senderName = system ? null : row.senderType === "user" ? row.userName : row.senderType === "agent" ? row.agentName : null;
    out.set(Number(row.seq), {
      seq: Number(row.seq),
      createdAt: (row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)).toISOString(),
      content: row.content ?? "",
      senderName: senderName ?? null,
      senderType: system ? "system" : row.senderType === "user" ? "user" : row.senderType === "agent" ? "agent" : "app",
      // A mirrored external message is someone else's text: inert, as every read hands it over.
      inert: row.senderType === "external_projection",
    });
  }
  return out;
}

/** The `inbox check` rows for one page of the conversation list, in its order. */
export async function conversationItemRows(input: {
  items: readonly import("./channelService").AgentInboxConversation[];
  pageRows: readonly channelService.AgentInboxChainRow[];
  /** 00:00 UTC of the launch day: a row whose latest message is older is pre-launch (as conversationsBefore decides). */
  preLaunchBefore: Date | null;
}): Promise<AgentApiInboxItemRow[]> {
  const facts = await messageFactsBySeq([
    ...input.items.map((item) => item.activitySeq),
    ...input.pageRows.map((row) => row.firstUnreadSeq ?? 0),
  ]);
  return input.items.map((item, index) => {
    const chain = input.pageRows[index];
    const latest = facts.get(item.activitySeq);
    const firstUnread = chain?.firstUnreadSeq ? facts.get(chain.firstUnreadSeq) : undefined;
    const conversationKind = item.conversationKind === "task" ? "task" : item.kind === "dm" ? "dm" : item.kind === "thread" ? "thread" : "channel";
    return {
      target: item.target,
      kind: "conversation",
      conversationKind,
      ...(conversationKind === "task" ? { title: item.title ?? null } : {}),
      mentions: item.mentions,
      lastReadSeq: item.lastReadSeq,
      activitySeq: item.activitySeq,
      unread: item.unread,
      latestSender: latest?.senderName ? { name: latest.senderName, type: latest.senderType } : null,
      ...inboxPreview(latest?.content, latest?.inert ?? false),
      firstUnreadAt: firstUnread?.createdAt ?? null,
      latestAt: item.latestAt,
      preLaunch: input.preLaunchBefore !== null && item.latestAt !== null && Date.parse(item.latestAt) < input.preLaunchBefore.getTime(),
    };
  });
}

// ---------------------------------------------------------------------------
// App items

type EventRow = typeof thirdPartyAgentEvents.$inferSelect;
type EventWithApp = { event: EventRow; clientKey: string; clientName: string };

/** The app's name as the agent sees it: an external app's display name inert; Raft's own system app's key. */
function shownAppName(row: EventWithApp): string {
  return row.event.clientId === null ? row.clientName : renderThirdPartyInertText({ field: "app_name", value: row.clientName });
}

function unconsumedLive(now: Date) {
  return and(
    or(eq(thirdPartyAgentEvents.status, "queued"), eq(thirdPartyAgentEvents.status, "delivering")),
    sql`${thirdPartyAgentEvents.expiresAt} > ${now}`,
  );
}

function notItemSystemApp() {
  return or(isNull(thirdPartyAgentEvents.systemApp), sql`${thirdPartyAgentEvents.systemApp} not in (${sql.join(NOT_ITEM_SYSTEM_APPS.map((app) => sql`${app}`), sql`, `)})`);
}

/** At most this many unconsumed events are grouped into one listing (an agent holds at most 7 days of them). */
const APP_LISTING_EVENT_SCAN = 5_000;

export type AppItemListing = { rows: AgentApiInboxItemRow[]; omitted: number };

/**
 * The agent's unconsumed, live events from `launch.appEventsFrom` on, grouped
 * by (app, object_ref), each group newest first, the groups in order of their
 * latest event. A system app's events its delivery guard withholds are left
 * out, as on every read; NOT_ITEM_SYSTEM_APPS (RaftBench) are never items.
 */
export async function listAgentAppItemGroups(input: { agentId: string; launch: InboxItemsLaunch; now?: Date }): Promise<EventWithApp[][]> {
  const now = input.now ?? new Date();
  const scanned = await getDb().select({ event: thirdPartyAgentEvents, ...THIRD_PARTY_EVENT_APP_COLUMNS })
    .from(thirdPartyAgentEvents)
    .leftJoin(oauthClients, eq(oauthClients.id, thirdPartyAgentEvents.clientId))
    .where(and(
      eq(thirdPartyAgentEvents.agentId, input.agentId),
      unconsumedLive(now),
      gte(thirdPartyAgentEvents.createdAt, input.launch.appEventsFrom),
      notItemSystemApp(),
    ))
    .orderBy(desc(thirdPartyAgentEvents.createdAt), desc(thirdPartyAgentEvents.id))
    .limit(APP_LISTING_EVENT_SCAN);
  const readable = await filterReadableSystemAppEvents(scanned, (row) => row.event);
  const groups = new Map<string, EventWithApp[]>();
  for (const row of readable) {
    // The rule the push to the daemon applies too (inbox_item_target); the query above only narrows the scan.
    const key = appEventInboxItemTarget(row.event, row.clientKey, input.launch);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()];
}

/**
 * The agent's app items and fallback items (listAgentAppItemGroups), newest
 * activity first, at most AGENT_INBOX_MAX_APP_ROWS (the rest counted in
 * `omitted`), each naming its related conversation when the agent can open it.
 */
export async function listAgentAppItems(input: { serverId: string; agentId: string; launch: InboxItemsLaunch; now?: Date }): Promise<AppItemListing> {
  const ordered = await listAgentAppItemGroups(input);
  const listed = ordered.slice(0, AGENT_INBOX_MAX_APP_ROWS);
  const related = await renderRelatedTargets(
    input.serverId,
    input.agentId,
    listed.flatMap((group) => group.map((row) => row.event.relatedChannelId).filter((id): id is string => Boolean(id))),
  );
  const rows = listed.map((group): AgentApiInboxItemRow => {
    const latest = group[0]!;
    const oldest = group.at(-1)!;
    const objectRef = latest.event.objectRef;
    const relatedChannelId = group.find((row) => row.event.relatedChannelId && related.has(row.event.relatedChannelId))?.event.relatedChannelId;
    const name = shownAppName(latest);
    return {
      target: appEventInboxItemTarget(latest.event, latest.clientKey, input.launch)!,
      kind: objectRef ? "app" : "app_fallback",
      app: { key: latest.clientKey, name },
      ...(objectRef ? { objectRef } : {}),
      related: relatedChannelId ? { target: related.get(relatedChannelId)! } : null,
      unread: group.length,
      latestSender: { name, type: latest.event.clientId === null ? "system" : "app" },
      ...inboxPreview(latest.event.summary, latest.event.clientId !== null),
      firstUnreadAt: oldest.event.createdAt.toISOString(),
      latestAt: latest.event.createdAt.toISOString(),
      preLaunch: false,
    };
  });
  return { rows, omitted: Math.max(0, ordered.length - listed.length) };
}

/** The client row behind an app key, scoped nowhere (a key is global): its OAuth client id, or a system app. Null: no such app. */
async function appSource(appKey: string): Promise<{ clientId: string } | { systemApp: `system.${string}` } | null> {
  if (!isItemAppKey(appKey)) return null;
  if (appKey.startsWith("system.")) return { systemApp: appKey as `system.${string}` };
  const [client] = await getDb().select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.clientId, appKey)).limit(1);
  return client ? { clientId: client.id } : null;
}

function appItemWhere(agentId: string, source: { clientId: string } | { systemApp: `system.${string}` }, objectRef: string | null, launch: InboxItemsLaunch) {
  return and(
    eq(thirdPartyAgentEvents.agentId, agentId),
    "clientId" in source
      ? eq(thirdPartyAgentEvents.clientId, source.clientId)
      : and(isNull(thirdPartyAgentEvents.clientId), eq(thirdPartyAgentEvents.systemApp, source.systemApp)),
    objectRef === null ? isNull(thirdPartyAgentEvents.objectRef) : eq(thirdPartyAgentEvents.objectRef, objectRef),
    gte(thirdPartyAgentEvents.createdAt, launch.appEventsFrom),
  );
}

export type AppItemPage =
  | { kind: "absent" }
  | { kind: "expired" }
  | {
    kind: "page";
    app: { key: string; name: string } | null;
    /** Oldest first, each as the agent reads one event (its payload shown). */
    events: EventWithApp[];
    unreadBefore: number;
    /** Unconsumed live events after this page (capped). */
    remainingAfterPage: (shownIds: readonly string[]) => Promise<{ remaining: number; capped: boolean }>;
    relatedChannelId: string | null;
  };

/**
 * One page of an app item for the acting agent: its unconsumed live events
 * from `launch.appEventsFrom` on, oldest first (`limit`; the char budget is the caller's).
 * `absent` when the agent has no event of it at all (or of an app that is
 * not an item app), `expired` when every unconsumed one expired. An item read
 * to the end is a page with no events.
 */
export async function readAgentAppItemPage(input: {
  agentId: string;
  appKey: string;
  objectRef: string | null;
  launch: InboxItemsLaunch;
  limit: number;
  now?: Date;
}): Promise<AppItemPage> {
  const now = input.now ?? new Date();
  const source = await appSource(input.appKey);
  if (!source) return { kind: "absent" };
  const where = appItemWhere(input.agentId, source, input.objectRef, input.launch);
  const db = getDb();
  const unconsumed = await db.select({ event: thirdPartyAgentEvents, ...THIRD_PARTY_EVENT_APP_COLUMNS })
    .from(thirdPartyAgentEvents)
    .leftJoin(oauthClients, eq(oauthClients.id, thirdPartyAgentEvents.clientId))
    .where(and(where, unconsumedLive(now)))
    .orderBy(asc(thirdPartyAgentEvents.createdAt), asc(thirdPartyAgentEvents.id))
    .limit(AGENT_INBOX_READ_REMAINING_CAP + input.limit);
  const readable = await filterReadableSystemAppEvents(unconsumed, (row) => row.event);
  if (readable.length === 0) {
    const [any] = await db.select({
      consumed: sql<number>`count(*) filter (where ${thirdPartyAgentEvents.status} = 'delivered')`,
      gone: sql<number>`count(*) filter (where ${thirdPartyAgentEvents.status} = 'expired' or ${thirdPartyAgentEvents.expiresAt} <= ${now})`,
      total: sql<number>`count(*)`,
    }).from(thirdPartyAgentEvents).where(where);
    if (!any || Number(any.total) === 0) return { kind: "absent" };
    // Withheld by a system app's guard (the agent lost access): nothing of it is the agent's to read.
    if (unconsumed.length > 0) return { kind: "absent" };
    if (Number(any.consumed) === 0 && Number(any.gone) > 0) return { kind: "expired" };
  }
  const events = readable.slice(0, input.limit);
  const capped = readable.length >= AGENT_INBOX_READ_REMAINING_CAP + input.limit;
  const first = readable[0] ?? null;
  return {
    kind: "page",
    app: first ? { key: first.clientKey, name: shownAppName(first) } : null,
    events,
    unreadBefore: readable.length,
    remainingAfterPage: async (shownIds) => {
      const shown = new Set(shownIds);
      const left = readable.filter((row) => !shown.has(row.event.id)).length;
      return { remaining: Math.min(left, AGENT_INBOX_READ_REMAINING_CAP), capped: capped || left > AGENT_INBOX_READ_REMAINING_CAP };
    },
    relatedChannelId: [...readable].reverse().find((row) => row.event.relatedChannelId)?.event.relatedChannelId ?? null,
  };
}

/** The unconsumed live events of one app item (all of them, for a dismiss); null when the agent has none of it at all. */
export async function unconsumedAppItemEvents(input: {
  agentId: string;
  appKey: string;
  objectRef: string | null;
  launch: InboxItemsLaunch;
  now?: Date;
}): Promise<EventWithApp[] | null> {
  const now = input.now ?? new Date();
  const source = await appSource(input.appKey);
  if (!source) return null;
  const where = appItemWhere(input.agentId, source, input.objectRef, input.launch);
  const rows = await getDb().select({ event: thirdPartyAgentEvents, ...THIRD_PARTY_EVENT_APP_COLUMNS })
    .from(thirdPartyAgentEvents)
    .leftJoin(oauthClients, eq(oauthClients.id, thirdPartyAgentEvents.clientId))
    .where(where)
    .orderBy(asc(thirdPartyAgentEvents.createdAt), asc(thirdPartyAgentEvents.id))
    .limit(APP_LISTING_EVENT_SCAN);
  if (rows.length === 0) return null;
  const live = rows.filter((row) => (row.event.status === "queued" || row.event.status === "delivering") && row.event.expiresAt > now);
  return filterReadableSystemAppEvents(live, (row) => row.event);
}

/** One event as delivered (no payload asked for); `inboxReadAppEntry` turns it into an `inbox read` entry. */
export function appEventMessage(row: EventWithApp): AgentMessage {
  return buildThirdPartyAgentMessage({ event: row.event, clientKey: row.clientKey, clientName: row.clientName });
}

/**
 * An app event as an `inbox read` entry (Tenny; shape Sage's): its
 * `third_party_event` envelope (id, client_id, client_name, kind, ...) with
 * the summary line as `content`, and no raw data: no `payload`,
 * `payload_hash` or `source.resource`, and no lines Raft adds after the
 * summary. `message read --target agent-event:<id>` still shows everything.
 * `renderedContent` is the content as renderAgentFacingContents hands it over.
 */
export function inboxReadAppEntry(message: AgentMessage, renderedContent: string): Record<string, unknown> {
  const event = message.third_party_event;
  const [summaryLine = ""] = renderedContent.split("\n");
  if (!event) return { ...message, content: summaryLine };
  const { payload: _payload, payload_hash: _hash, source, ...kept } = event;
  const { resource: _resource, ...keptSource } = source;
  return { ...message, content: summaryLine, third_party_event: { ...kept, source: keptSource } };
}

/**
 * The conversations `inbox dismiss --before <cutoff>` takes, and so the ones
 * the pre-launch line counts (one selection for both): offered rows past the
 * agent's durable read position, with unread left, whose latest message is
 * before the cutoff, at most `limit`, oldest activity first.
 */
export async function conversationsBefore(agentId: string, cutoff: Date, limit: number): Promise<Array<{ row: channelService.AgentInboxChainRow; at: number }>> {
  const beforeSeq = (await firstMessageSeqAtOrAfter(cutoff)) ?? Number.MAX_SAFE_INTEGER;
  const rows = await channelService.readAgentInboxChainRowsForDismiss(agentId, { beforeSeq, limit });
  const facts = await messageFactsBySeq(rows.map((row) => row.activitySeq));
  const cutoffMs = cutoff.getTime();
  return rows.flatMap((row) => {
    if (dismissReadSeq(row) <= row.lastReadSeq) return [];
    // The seq bound is close to the time; the latest message's own time decides.
    const latest = facts.get(row.activitySeq);
    const at = latest ? Date.parse(latest.createdAt) : Number.NaN;
    return Number.isFinite(at) && at < cutoffMs ? [{ row, at }] : [];
  }).sort((a, b) => a.at - b.at);
}

/** The read position a dismiss moves a conversation to: its latest seq as the chain knows it (later messages stay unread). */
export function dismissReadSeq(row: channelService.AgentInboxChainRow): number {
  return Math.max(row.latestSeq ?? 0, row.maxMentionSeq ?? 0, row.activitySeq);
}

/**
 * Entries that fit one page: in order, while their content stays within
 * AGENT_INBOX_READ_MAX_CHARS, and always the first (given whole, whatever its
 * size). The server consumes exactly what this returns.
 */
export function withinPageBudget<T>(entries: readonly T[], contentOf: (entry: T) => string, maxChars = AGENT_INBOX_READ_MAX_CHARS): T[] {
  const out: T[] = [];
  let used = 0;
  for (const entry of entries) {
    const size = contentOf(entry).length;
    if (out.length > 0 && used + size > maxChars) break;
    out.push(entry);
    used += size;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reminder items (D13)

export type ReminderFire = { reminderId: string; title: string; revision: number; eventId: string; firedAt: Date };

/**
 * The agent's fired reminder revisions since launch with no ack row, oldest
 * first: `reminder_events` fired minus `reminder_source_acknowledgements`
 * (the server's authority, the same rows `raft reminder ack` writes). Fires
 * from before launch stay on the old path (D9): almost none were ever acked
 * (182k of 182k in November 2026), and listing them would flood every agent
 * at launch with items dismiss can't clear (Tenny, #13787). The bound is in
 * the query, on idx_reminder_events_owner (owner_agent_id, occurred_at).
 *
 * None of a canceled reminder's, and none for an owner agent that is deleted
 * (D21, RFC 081 §14.3): canceling says nobody wants it any more, and a
 * deleted agent reads nothing. The rows stay; they are only not shown, and a
 * fire of a canceled reminder can still be acked.
 *
 * Of a recurring reminder, only its latest fire (D22): once it has fired
 * again, an earlier fire nobody acked asks for nothing any more, so it is not
 * listed and needs no ack. Otherwise a reminder that fires every hour would
 * add one more ack to its row each time, without end. A reminder that
 * doesn't recur keeps one ack per fired revision (D13).
 */
export async function unackedReminderFires(input: { serverId: string; agentId: string; since: Date; reminderId?: string }): Promise<ReminderFire[]> {
  const rows = await getDb().execute<{ reminder_id: string; title: string; revision: number; event_id: string; fired_at: Date | string }>(sql`
    select distinct on (e.reminder_id, e.revision) e.reminder_id, r.title, e.revision, e.id as event_id, e.occurred_at as fired_at
    from (
      select ev.id, ev.reminder_id, ev.server_id, ev.owner_agent_id, ev.occurred_at,
        case when (ev.metadata->>'sourceVersion') ~ '^[1-9][0-9]{0,8}$' then (ev.metadata->>'sourceVersion')::int end as revision
      from reminder_events ev
      where ev.server_id = ${input.serverId}
        and ev.owner_agent_id = ${input.agentId}
        and ev.event_type = 'fired'
        and ev.metadata->>'fired' = 'true'
        and ev.occurred_at >= ${input.since}
        ${input.reminderId ? sql`and ev.reminder_id = ${input.reminderId}` : sql``}
    ) e
    join reminders r on r.id = e.reminder_id
    join agents owner on owner.id = e.owner_agent_id
    where e.revision is not null
      and r.status <> 'canceled'
      and owner.deleted_at is null
      and (r.recurrence is null or not exists (
        select 1 from reminder_events newer
        where newer.reminder_id = e.reminder_id
          and newer.event_type = 'fired'
          and newer.metadata->>'fired' = 'true'
          and case when (newer.metadata->>'sourceVersion') ~ '^[1-9][0-9]{0,8}$' then (newer.metadata->>'sourceVersion')::int end > e.revision
      ))
      and not exists (
        select 1 from reminder_source_acknowledgements a
        where a.server_id = e.server_id and a.owner_agent_id = e.owner_agent_id
          and a.reminder_id = e.reminder_id and a.source_version = e.revision
      )
    order by e.reminder_id, e.revision, e.occurred_at
  `);
  return (rows.rows ?? rows as unknown as Array<{ reminder_id: string; title: string; revision: number; event_id: string; fired_at: Date | string }>)
    .map((row) => ({
      reminderId: String(row.reminder_id),
      title: String(row.title ?? ""),
      revision: Number(row.revision),
      eventId: String(row.event_id),
      firedAt: row.fired_at instanceof Date ? row.fired_at : new Date(row.fired_at),
    }))
    .sort((a, b) => a.firedAt.getTime() - b.firedAt.getTime() || a.revision - b.revision);
}

/**
 * Whether the reminder fired at all since launch (acked or not): only then is
 * it an inbox item. One that fired only before launch is not, and answers as
 * an unknown target does.
 */
export async function reminderFiredSince(input: { serverId: string; agentId: string; reminderId: string; since: Date }): Promise<boolean> {
  const rows = await getDb().execute<{ one: number }>(sql`
    select 1 as one from reminder_events ev
    where ev.server_id = ${input.serverId}
      and ev.owner_agent_id = ${input.agentId}
      and ev.reminder_id = ${input.reminderId}
      and ev.event_type = 'fired'
      and ev.occurred_at >= ${input.since}
    limit 1
  `);
  return ((rows.rows ?? rows as unknown as unknown[]) as unknown[]).length > 0;
}

export function reminderAckRef(fire: ReminderFire): AgentApiInboxAckRef {
  return { app: "system.reminder", id: fire.reminderId, revision: String(fire.revision) };
}

export const REMINDER_APP = { key: "system.reminder", name: "Reminder" } as const;

/** One row per reminder with unacked revisions (their acks in `ack`), newest first, at most AGENT_INBOX_MAX_REMINDER_ROWS. */
export async function listAgentReminderItems(input: { serverId: string; agentId: string; launch: InboxItemsLaunch }): Promise<{ rows: AgentApiInboxItemRow[]; omitted: number }> {
  const fires = await unackedReminderFires({ serverId: input.serverId, agentId: input.agentId, since: input.launch.at });
  const byReminder = new Map<string, ReminderFire[]>();
  for (const fire of fires) {
    const list = byReminder.get(fire.reminderId);
    if (list) list.push(fire);
    else byReminder.set(fire.reminderId, [fire]);
  }
  const groups = [...byReminder.values()].sort((a, b) => b.at(-1)!.firedAt.getTime() - a.at(-1)!.firedAt.getTime());
  const listed = groups.slice(0, AGENT_INBOX_MAX_REMINDER_ROWS);
  return {
    rows: listed.map((group): AgentApiInboxItemRow => {
      const latest = group.at(-1)!;
      return {
        target: `${AGENT_INBOX_REMINDER_TARGET_PREFIX}${latest.reminderId.slice(0, 8)}`,
        kind: "reminder",
        app: { ...REMINDER_APP },
        related: null,
        ack: group.map(reminderAckRef),
        unread: group.length,
        latestSender: { name: REMINDER_APP.name, type: "system" },
        ...inboxPreview(latest.title, false),
        firstUnreadAt: group[0]!.firedAt.toISOString(),
        latestAt: latest.firedAt.toISOString(),
        preLaunch: false,
      };
    }),
    omitted: Math.max(0, groups.length - listed.length),
  };
}

/** A reminder revision as an `inbox read` entry: what fired and when, with its ack. Never consumed by reading. */
/**
 * A reminder revision as an `inbox read` entry, in the snake_case fields the
 * shared message line reads (as an app event's entry is), with the item's
 * `target` (`reminder:<id8>`) and its `ack`. Never consumed by reading.
 */
export function reminderEntry(fire: ReminderFire): Record<string, unknown> & { content: string; ack: AgentApiInboxAckRef } {
  const title = foldAgentOneLineText(fire.title) || "(untitled)";
  return {
    id: fire.eventId,
    message_id: fire.eventId,
    target: `${AGENT_INBOX_REMINDER_TARGET_PREFIX}${fire.reminderId.slice(0, 8)}`,
    sender_type: "system",
    sender_name: REMINDER_APP.name,
    timestamp: fire.firedAt.toISOString(),
    content: `Reminder fired: ${title} (revision ${fire.revision}). It stays in the inbox until acked.`,
    ack: reminderAckRef(fire),
  };
}

// ---------------------------------------------------------------------------
// Rows in list order

/**
 * Page 1: reminder rows first (they need an ack), then app rows and
 * conversation rows by latest activity, newest first. Later pages:
 * conversation rows only.
 */
export function orderInboxItemRows(input: { reminders: readonly AgentApiInboxItemRow[]; apps: readonly AgentApiInboxItemRow[]; conversations: readonly AgentApiInboxItemRow[] }): AgentApiInboxItemRow[] {
  const at = (row: AgentApiInboxItemRow) => (row.latestAt ? Date.parse(row.latestAt) : 0);
  // A merge, not a sort: conversations keep the list's own order (activity
  // seq), and each app row goes before the first conversation older than it.
  const apps = [...input.apps].sort((a, b) => at(b) - at(a));
  const merged: AgentApiInboxItemRow[] = [];
  let next = 0;
  for (const conversation of input.conversations) {
    while (next < apps.length && at(apps[next]!) > at(conversation)) merged.push(apps[next++]!);
    merged.push(conversation);
  }
  merged.push(...apps.slice(next));
  return [...input.reminders, ...merged];
}
