import {
  currentDate,
  type ActivityTurnAppEventView,
  type ActivityTurnTriggerAppEvent,
  type AgentAppEventDetail,
  type AgentAppEventListResponse,
  type AgentAppEventSummary,
} from "@botiverse/raft-shared";
import { and, desc, eq, gte, lte, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { oauthClients, thirdPartyAgentEvents } from "../db/schema";
import { THIRD_PARTY_EVENT_APP_COLUMNS } from "./oauthService";

/** The RFC 074 assistant doorbell's system app (third_party_agent_events.system_app). */
export const SYSTEM_ASSISTANT_APP = "system.assistant";

// Human-facing read of the events connected apps sent to an agent (Agent panel).
// The agent's own read path stays in oauthService (readThirdPartyAgentEventForAgent).
// Callers check visibility (canInspectAgentPrivateSurfaces) before calling.

export const AGENT_APP_EVENTS_DEFAULT_LIMIT = 50;
export const AGENT_APP_EVENTS_MAX_LIMIT = 100;
/** Events are kept this long after they expire, then pruned. */
export const AGENT_APP_EVENT_RETENTION_AFTER_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH_SIZE = 1_000;
const PRUNE_MAX_BATCHES = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EventRow = {
  event: typeof thirdPartyAgentEvents.$inferSelect;
  clientKey: string;
  clientName: string;
  logoUrl: string | null;
};

function displayStatus(event: EventRow["event"], now: Date): AgentAppEventSummary["status"] {
  if (event.status === "delivered") return "delivered";
  if (event.status === "expired" || event.status === "rejected") return "expired";
  return event.expiresAt.getTime() <= now.getTime() ? "expired" : "queued";
}

function toSummary(row: EventRow, now: Date): AgentAppEventSummary {
  return {
    id: row.event.id,
    // A system app's events have no OAuth client: its fixed name doubles as the
    // filter key (`clientId=system.assistant`).
    app: { clientId: row.event.clientId ?? row.clientKey, clientKey: row.clientKey, name: row.clientName, logoUrl: row.logoUrl },
    kind: row.event.kind,
    summary: row.event.summary,
    status: displayStatus(row.event, now),
    externalEventId: row.event.externalEventId,
    createdAt: row.event.createdAt.toISOString(),
    deliveredAt: row.event.deliveredAt?.toISOString() ?? null,
    expiresAt: row.event.expiresAt.toISOString(),
    payloadBytes: Buffer.byteLength(JSON.stringify(row.event.payload), "utf8"),
  };
}

/** Opaque keyset cursor over (created_at, id), newest first. */
export function encodeAgentAppEventCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeAgentAppEventCursor(cursor: string): { createdAt: Date; id: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf("|");
  if (sep <= 0) return null;
  const createdAt = new Date(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || !UUID_RE.test(id)) return null;
  return { createdAt, id };
}

function selectEventRows(executor: DatabaseExecutor) {
  return executor.select({
    event: thirdPartyAgentEvents,
    ...THIRD_PARTY_EVENT_APP_COLUMNS,
    logoUrl: oauthClients.logoUrl,
  })
    .from(thirdPartyAgentEvents)
    // Left join: a Raft system app's events (client_id NULL) are listed too.
    .leftJoin(oauthClients, eq(oauthClients.id, thirdPartyAgentEvents.clientId));
}

export async function listAgentAppEvents(input: {
  agentId: string;
  clientId?: string;
  before?: { createdAt: Date; id: string };
  limit?: number;
  executor?: DatabaseExecutor;
}): Promise<AgentAppEventListResponse> {
  const now = currentDate();
  const limit = Math.min(Math.max(input.limit ?? AGENT_APP_EVENTS_DEFAULT_LIMIT, 1), AGENT_APP_EVENTS_MAX_LIMIT);
  const conditions: SQL[] = [eq(thirdPartyAgentEvents.agentId, input.agentId)];
  if (input.clientId === SYSTEM_ASSISTANT_APP) conditions.push(eq(thirdPartyAgentEvents.systemApp, SYSTEM_ASSISTANT_APP));
  else if (input.clientId) conditions.push(eq(thirdPartyAgentEvents.clientId, input.clientId));
  if (input.before) {
    conditions.push(or(
      lt(thirdPartyAgentEvents.createdAt, input.before.createdAt),
      and(eq(thirdPartyAgentEvents.createdAt, input.before.createdAt), lt(thirdPartyAgentEvents.id, input.before.id)),
    )!);
  }
  const rows = await selectEventRows(input.executor ?? getDb())
    .where(and(...conditions))
    .orderBy(desc(thirdPartyAgentEvents.createdAt), desc(thirdPartyAgentEvents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    events: page.map((row) => toSummary(row, now)),
    nextCursor: rows.length > limit && last ? encodeAgentAppEventCursor(last.event.createdAt, last.event.id) : null,
  };
}

/** One event of this agent, or null. Unknown and other agents' ids are the same null. */
export async function getAgentAppEvent(input: {
  agentId: string;
  eventId: string;
  executor?: DatabaseExecutor;
}): Promise<AgentAppEventDetail | null> {
  if (!UUID_RE.test(input.eventId)) return null;
  const [row] = await selectEventRows(input.executor ?? getDb())
    .where(and(
      eq(thirdPartyAgentEvents.agentId, input.agentId),
      eq(thirdPartyAgentEvents.id, input.eventId.toLowerCase()),
    ))
    .limit(1);
  if (!row) return null;
  return { ...toSummary(row, currentDate()), payload: row.event.payload };
}

/**
 * The app events delivered to this agent in [fromMs, toMs] (server clock),
 * newest first, for the Activity overview to place in turns. Only what the
 * overview shows: never the payload, its hash, the resource or token ids.
 * Never-delivered events have no deliveredAt and are not returned.
 */
export async function listAgentAppEventsDeliveredBetween(input: {
  agentId: string;
  fromMs: number;
  toMs: number;
  limit: number;
  executor?: DatabaseExecutor;
}): Promise<ActivityTurnAppEventView[]> {
  const rows = await (input.executor ?? getDb()).select({
    id: thirdPartyAgentEvents.id,
    kind: thirdPartyAgentEvents.kind,
    summary: thirdPartyAgentEvents.summary,
    deliveredAt: thirdPartyAgentEvents.deliveredAt,
    ...THIRD_PARTY_EVENT_APP_COLUMNS,
    logoUrl: oauthClients.logoUrl,
  })
    .from(thirdPartyAgentEvents)
    // Left join: a Raft system app's events (client_id NULL) count too.
    .leftJoin(oauthClients, eq(oauthClients.id, thirdPartyAgentEvents.clientId))
    .where(and(
      eq(thirdPartyAgentEvents.agentId, input.agentId),
      // delivered_at has no index; (agent_id, status) does. The two agree: the
      // only writer of delivered_at sets status 'delivered' with it
      // (markThirdPartyAgentEventsDelivered, oauthService.ts), and no writer
      // moves a delivered row to another status (the claim and release
      // updates match only queued / delivering rows). There is no created_at
      // bound: delivery does not refuse expired rows (that same update checks
      // no expires_at), so delivered_at - created_at has no upper limit.
      eq(thirdPartyAgentEvents.status, "delivered"),
      // RFC 081: a dismissed event was never shown (`raft inbox dismiss`), so it
      // is not delivered in a turn; the dismiss trace counts it instead.
      sql`${thirdPartyAgentEvents.consumedVia} is distinct from 'dismissed'`,
      gte(thirdPartyAgentEvents.deliveredAt, new Date(input.fromMs)),
      lte(thirdPartyAgentEvents.deliveredAt, new Date(input.toMs)),
    ))
    .orderBy(desc(thirdPartyAgentEvents.deliveredAt), desc(thirdPartyAgentEvents.id))
    .limit(input.limit);
  return rows.flatMap((row) => (row.deliveredAt ? [{
    id: row.id,
    appName: row.clientName,
    clientKey: row.clientKey,
    logoUrl: row.logoUrl,
    summary: row.summary,
    deliveredAt: row.deliveredAt.getTime(),
    kind: row.kind,
  }] : []));
}

/** Short ids collide rarely (32 bits), so a page's references match only a few rows. */
const EVENT_REF_QUERY_LIMIT = 500;
const EVENT_REF_RE = /^([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;

/**
 * The app events behind `agent-event:<id8>` (or full id) references, scoped
 * to this agent in SQL, one query for all of them. A reference no event of
 * this agent matches (pruned, another agent's) or that two of its events
 * share (a short-id collision) is left out.
 */
export async function resolveAgentAppEventRefs(input: {
  agentId: string;
  refs: readonly string[];
  executor?: DatabaseExecutor;
}): Promise<Map<string, ActivityTurnTriggerAppEvent>> {
  const wanted = new Map<string, string>();
  for (const ref of input.refs) {
    const normalized = ref.trim().toLowerCase();
    const match = EVENT_REF_RE.exec(normalized);
    if (match) wanted.set(ref, normalized);
  }
  const resolved = new Map<string, ActivityTurnTriggerAppEvent>();
  if (wanted.size === 0) return resolved;
  const prefixes = [...new Set([...wanted.values()].map((ref) => ref.slice(0, 8)))];
  const rows = await (input.executor ?? getDb()).select({
    id: thirdPartyAgentEvents.id,
    summary: thirdPartyAgentEvents.summary,
    ...THIRD_PARTY_EVENT_APP_COLUMNS,
  })
    .from(thirdPartyAgentEvents)
    .leftJoin(oauthClients, eq(oauthClients.id, thirdPartyAgentEvents.clientId))
    .where(and(
      eq(thirdPartyAgentEvents.agentId, input.agentId),
      // A short id is a range of the primary key (uuids order by their bytes,
      // as their hex reads), so the lookup is an index range scan.
      or(...prefixes.map((prefix) => and(
        gte(thirdPartyAgentEvents.id, `${prefix}-0000-0000-0000-000000000000`),
        lte(thirdPartyAgentEvents.id, `${prefix}-ffff-ffff-ffff-ffffffffffff`),
      )))!,
    ))
    .limit(EVENT_REF_QUERY_LIMIT);
  // A cut-off result could hide a second event behind a prefix: resolve none.
  if (rows.length >= EVENT_REF_QUERY_LIMIT) return resolved;
  for (const [ref, normalized] of wanted) {
    const matches = rows.filter((row) => (normalized.length === 8 ? row.id.startsWith(normalized) : row.id === normalized));
    if (matches.length === 1) resolved.set(ref, { appName: matches[0]!.clientName, summary: matches[0]!.summary });
  }
  return resolved;
}

/**
 * Delete events that expired more than the retention window ago, in bounded
 * batches. Called from the hourly maintenance tick; returns rows deleted.
 */
export async function pruneExpiredAgentAppEvents(opts: {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  executor?: DatabaseExecutor;
} = {}): Promise<number> {
  const db = opts.executor ?? getDb();
  const cutoff = new Date((opts.now ?? currentDate()).getTime() - AGENT_APP_EVENT_RETENTION_AFTER_EXPIRY_MS);
  const batchSize = opts.batchSize ?? PRUNE_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? PRUNE_MAX_BATCHES;
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const deleted = await db.execute<{ id: string }>(sql`
      DELETE FROM ${thirdPartyAgentEvents}
      WHERE id IN (
        SELECT id FROM ${thirdPartyAgentEvents}
        WHERE expires_at <= ${cutoff}
        ORDER BY expires_at
        LIMIT ${batchSize}
      )
      RETURNING id`);
    const count = deleted.rows.length;
    total += count;
    if (count < batchSize) break;
  }
  return total;
}
