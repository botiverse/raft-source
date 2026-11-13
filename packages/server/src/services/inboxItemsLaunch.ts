// RFC 081 inbox items: when they launched on this deployment
// (`RAFT_INBOX_ITEMS_LAUNCH_AT`), and whether they are on for a server: the
// per-server flag `agent_inbox_items_v0` AND a launch time. A server with the
// flag on but no launch time is off (Tenny, #13787): the list ignores
// `items=true`, read and dismiss refuse INBOX_ITEMS_DISABLED, and the daemon
// is not told to teach `raft inbox read`. Kept apart from agentInboxItems.ts
// so the orchestrator reads it without the inbox queries' imports.
//
// Setting it (operators): both are ISO 8601 times in the server's env, read
// on every call (no restart needed to change them, only a new env).
//   RAFT_INBOX_ITEMS_LAUNCH_AT=2026-11-17T00:00:00Z
//     The launch: 00:00Z of the day the flag goes on. Reminder fires from
//     then on are items (older ones stay with the daemon, D9), and
//     conversations quiet since its day are the pre-launch line that
//     `inbox dismiss --before <day>` clears. A time in the past is fine.
//   RAFT_INBOX_ITEMS_APP_EVENTS_FROM=2026-11-10T00:00:00Z (optional)
//     App events from this time on are items: set it 7 days before the
//     launch so the inbox lists every app event still unconsumed on day one
//     (events live 7 days), without also listing 7 days of unacked reminder
//     fires or moving the pre-launch line. Unset, unparseable or later than
//     the launch: the launch time (app events never start after reminders).
//     Only unconsumed events are listed (one handed to the agent before is
//     `delivered`), and `inbox dismiss --before <launch day>` takes these too.
import { and, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { AGENT_INBOX_APP_TARGET_PREFIX } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { thirdPartyAgentEvents, type SystemAppKey } from "../db/schema";
import { AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, evaluateFeatureFlag } from "./featureFlagService";
import { serializeErrorForLog } from "../tracing/safeErrorLog";

/** The env var that fixes when inbox items launched (ISO time; set it to 00:00Z of the launch day). */
export const INBOX_ITEMS_LAUNCH_AT_ENV = "RAFT_INBOX_ITEMS_LAUNCH_AT";
/** Optional: app events from this time on are items (ISO time, at or before the launch; see the header). */
export const INBOX_ITEMS_APP_EVENTS_FROM_ENV = "RAFT_INBOX_ITEMS_APP_EVENTS_FROM";

/**
 * Raft's own system apps whose events are never inbox items: RaftBench hands
 * its events to dedicated bench agents through its own worker (service-only
 * mode). Every other system app's events are items like any app's, the
 * assistant's (`system.assistant`, one row per object) included (Tenny,
 * #wg-ax thread 4ee99a1f: `raft message check` goes when the flag goes on).
 */
export const NOT_ITEM_SYSTEM_APPS: readonly SystemAppKey[] = ["system.raftbench"];

export type InboxItemsLaunch = {
  /** Reminder fires from this time on are items (D9: older ones stay on the old path). */
  at: Date;
  /** App events from this time on are items: RAFT_INBOX_ITEMS_APP_EVENTS_FROM when set and not after `at`, else `at`. */
  appEventsFrom: Date;
  /** 00:00 UTC of the launch day: conversations whose latest activity is before it are pre-launch, which `inbox dismiss --before <day>` covers. */
  dayStart: Date;
  /** `YYYY-MM-DD` of the launch day (UTC). */
  day: string;
};

let warnedInvalidLaunchAt: string | null = null;
let warnedAppEventsFrom: string | null = null;

/** RAFT_INBOX_ITEMS_APP_EVENTS_FROM when it is a time at or before `at`; else `at` (said once per value). */
function appEventsFromOf(env: NodeJS.ProcessEnv, at: Date): Date {
  const raw = env[INBOX_ITEMS_APP_EVENTS_FROM_ENV]?.trim();
  if (!raw) return at;
  const ms = Date.parse(raw);
  if (Number.isFinite(ms) && ms <= at.getTime()) return new Date(ms);
  if (warnedAppEventsFrom !== raw) {
    warnedAppEventsFrom = raw;
    console.warn(`[AgentInboxItems] ${INBOX_ITEMS_APP_EVENTS_FROM_ENV}=${JSON.stringify(raw)} is not a time at or before ${INBOX_ITEMS_LAUNCH_AT_ENV}; app events are items from the launch`);
  }
  return at;
}

/** The launch time, or null when the env var is unset or not a time (then inbox items are off everywhere). */
export function inboxItemsLaunch(env: NodeJS.ProcessEnv = process.env): InboxItemsLaunch | null {
  const raw = env[INBOX_ITEMS_LAUNCH_AT_ENV]?.trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    if (warnedInvalidLaunchAt !== raw) {
      warnedInvalidLaunchAt = raw;
      console.warn(`[AgentInboxItems] ${INBOX_ITEMS_LAUNCH_AT_ENV}=${JSON.stringify(raw)} is not a time; inbox items stay off`);
    }
    return null;
  }
  const at = new Date(ms);
  const day = at.toISOString().slice(0, 10);
  return { at, appEventsFrom: appEventsFromOf(env, at), dayStart: new Date(`${day}T00:00:00.000Z`), day };
}

let warnedFlagWithoutLaunch = false;

/**
 * The flag is per server, so this is said once per process, at the first
 * evaluation that finds it on with no launch time.
 */
function warnFlagWithoutLaunch(): void {
  if (warnedFlagWithoutLaunch) return;
  warnedFlagWithoutLaunch = true;
  console.warn(`[AgentInboxItems] ${AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY} is on for a server but ${INBOX_ITEMS_LAUNCH_AT_ENV} is not set: inbox items stay off until it is`);
}

/**
 * Whether inbox items are on, given the flag's answer for a server: only with
 * a launch time. Also what the orchestrator sends as `AgentConfig.inboxItems`.
 */
export function inboxItemsOnWith(flagOn: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!flagOn) return false;
  if (inboxItemsLaunch(env)) return true;
  warnFlagWithoutLaunch();
  return false;
}

/** Whether inbox items are on for this server: the flag (an evaluation failure reads as off) and a launch time. */
export async function inboxItemsEnabled(serverId: string): Promise<boolean> {
  let flagOn = false;
  try {
    flagOn = (await evaluateFeatureFlag({ key: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, serverId })).enabled === true;
  } catch (err) {
    console.error("[AgentInboxItems] flag evaluation failed; reading it as off", serializeErrorForLog(err));
    return false;
  }
  return inboxItemsOnWith(flagOn);
}

/**
 * The inbox item an app event belongs to, or null when it is not one: an
 * event from `launch.appEventsFrom` on, of any app but NOT_ITEM_SYSTEM_APPS
 * (RaftBench). `app:<appKey>/<object_ref>`, or `app:<appKey>` (its
 * fallback item) without a ref. The one rule both the item listing
 * (agentInboxItems listAgentAppItemGroups) and the push to the daemon
 * (`third_party_event.inbox_item_target`) apply, so they can't disagree.
 * `appKey` is the event's `third_party_event.client_id`: the OAuth client
 * key, or `system.<id>`.
 */
export function appEventInboxItemTarget(
  event: { createdAt: Date; systemApp: string | null; objectRef: string | null },
  appKey: string,
  launch: InboxItemsLaunch,
): string | null {
  if (event.createdAt.getTime() < launch.appEventsFrom.getTime()) return null;
  if (event.systemApp !== null && (NOT_ITEM_SYSTEM_APPS as readonly string[]).includes(event.systemApp)) return null;
  return `${AGENT_INBOX_APP_TARGET_PREFIX}${appKey}${event.objectRef ? `/${event.objectRef}` : ""}`;
}

type PushedAppEvent = { third_party_event?: { id: string; client_id: string; inbox_item_target?: string; inbox_item_unread?: number } | null };

/**
 * Messages about to be pushed to a managed daemon: each app event that is an
 * inbox item on this server (inboxItemsEnabled, then appEventInboxItemTarget
 * on its row) gets `third_party_event.inbox_item_target`; every other message,
 * and every event when inbox items are off, goes as it was. Never throws: on a
 * failure the events go without it (the daemon then lists them as before).
 */
export async function withInboxItemTargets<M extends PushedAppEvent>(
  messages: readonly M[],
  agentId: string,
  serverId: string | undefined,
  executor: DatabaseExecutor = getDb(),
): Promise<M[]> {
  const ids = [...new Set(messages.flatMap((message) => (message.third_party_event?.id ? [message.third_party_event.id] : [])))];
  if (ids.length === 0 || !serverId) return [...messages];
  try {
    if (!await inboxItemsEnabled(serverId)) return [...messages];
    const launch = inboxItemsLaunch();
    if (!launch) return [...messages];
    const rows = await executor.select({
      id: thirdPartyAgentEvents.id,
      createdAt: thirdPartyAgentEvents.createdAt,
      clientId: thirdPartyAgentEvents.clientId,
      systemApp: thirdPartyAgentEvents.systemApp,
      objectRef: thirdPartyAgentEvents.objectRef,
    }).from(thirdPartyAgentEvents).where(and(eq(thirdPartyAgentEvents.agentId, agentId), inArray(thirdPartyAgentEvents.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const unread = await unreadByItem(executor, agentId, launch, rows);
    return messages.map((message) => {
      const event = message.third_party_event;
      const row = event ? byId.get(event.id) : undefined;
      const target = event && row ? appEventInboxItemTarget(row, event.client_id, launch) : null;
      if (!event || !target || !row) return message;
      const count = unread.get(itemKey(row));
      return { ...message, third_party_event: { ...event, inbox_item_target: target, ...(count ? { inbox_item_unread: count } : {}) } };
    });
  } catch (err) {
    console.warn("[AgentInboxItems] inbox item targets not added to a push", serializeErrorForLog(err));
    return [...messages];
  }
}

type ItemRow = { clientId: string | null; systemApp: string | null; objectRef: string | null };
const itemKey = (row: ItemRow) => JSON.stringify([row.clientId, row.systemApp, row.objectRef]);

/**
 * #wg-ax:#24: the unread (unconsumed, live, from launch on) events of each
 * inbox item the pushed events are on, so the pushed notice counts the
 * events that joined the item without a wake too (`inbox_item_unread`).
 */
async function unreadByItem(executor: DatabaseExecutor, agentId: string, launch: InboxItemsLaunch, rows: readonly ItemRow[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (rows.length === 0) return counts;
  const refs = [...new Set(rows.map((row) => row.objectRef).filter((ref): ref is string => ref !== null))];
  const grouped = await executor.select({
    clientId: thirdPartyAgentEvents.clientId,
    systemApp: thirdPartyAgentEvents.systemApp,
    objectRef: thirdPartyAgentEvents.objectRef,
    n: sql<number>`count(*)::int`,
  }).from(thirdPartyAgentEvents).where(and(
    eq(thirdPartyAgentEvents.agentId, agentId),
    or(eq(thirdPartyAgentEvents.status, "queued"), eq(thirdPartyAgentEvents.status, "delivering")),
    gt(thirdPartyAgentEvents.expiresAt, new Date()),
    gte(thirdPartyAgentEvents.createdAt, launch.appEventsFrom),
    refs.length > 0 && rows.some((row) => row.objectRef === null)
      ? or(isNull(thirdPartyAgentEvents.objectRef), inArray(thirdPartyAgentEvents.objectRef, refs))
      : refs.length > 0 ? inArray(thirdPartyAgentEvents.objectRef, refs) : isNull(thirdPartyAgentEvents.objectRef),
  )).groupBy(thirdPartyAgentEvents.clientId, thirdPartyAgentEvents.systemApp, thirdPartyAgentEvents.objectRef);
  for (const group of grouped) counts.set(itemKey(group), Number(group.n));
  return counts;
}

export function __resetInboxItemsLaunchWarningsForTests(): void {
  warnedInvalidLaunchAt = null;
  warnedAppEventsFrom = null;
  warnedFlagWithoutLaunch = false;
}
