// RFC 081 D7, one item, one read state (#wg-ax:#24): an app event that comes
// in while its inbox item (`app:<app>/<object.ref>`, or the app's fallback
// item `app:<app>`) already has unread events is added to that item without
// waking the agent again. The item already woke it; the agent sees the new
// event, the count and the newest preview when it reads the item. Only the
// wake is skipped, never the content: the event stays unconsumed and
// readable (`inbox read`), and no re-delivery pushes it later
// (`wake_coalesced_at`, selectPendingThirdPartyAgentEvents).
//
// The item is the one appEventInboxItemTarget names, the rule the listing and
// the push already share, so the wake and `inbox check` can't disagree on
// what one item is (Remy). Only on servers with inbox items on: elsewhere
// every event is its own notice, as before.
//
// Only a recent wake holds the item (#wg-ax:#35, Tenny): an event merges
// only while the item's last wake (an unread event that was not itself
// merged) is less than APP_ITEM_WAKE_COALESCE_WINDOW_MS old. Agents that deal
// with a notice in the app itself (reply in the doc) never read the item, so
// it stayed unread and every later ask on it was silenced. Merged events
// left unread never hold it either: they woke no one.
//
// Only for an agent whose `raft` CLI lists app items in its inbox
// (agentCliInboxItems, #proj-apps:#88): a merged event is never pushed, so
// an agent whose CLI can't show it would never see it. Any other agent gets
// a wake for every event, as before inbox items.

import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { thirdPartyAgentEvents } from "../db/schema";
import { agentCliInboxItemsState } from "./agentCliInboxItems";
import { appEventInboxItemTarget, inboxItemsEnabled, inboxItemsLaunch } from "./inboxItemsLaunch";
import { claimQueuedThirdPartyAgentEventForDelivery, listPendingThirdPartyAgentEventMessages, releaseThirdPartyAgentEventDeliveryClaim } from "./oauthService";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { serializeErrorForLog } from "../tracing/safeErrorLog";

/** How long after an item's last wake later events on it are merged into that wake. */
export const APP_ITEM_WAKE_COALESCE_WINDOW_MS = 2 * 60_000;

type CoalescibleEvent = Pick<typeof thirdPartyAgentEvents.$inferSelect,
  "id" | "serverId" | "agentId" | "clientId" | "systemApp" | "objectRef" | "createdAt">;

/** Why an App's `delivery: "inbox"` event can't be held without a wake. */
export type InboxOnlyDeliveryUnavailable =
  /** The server has no app inbox items (flag off, or before the launch). */
  | "server"
  /** The agent's CLI said it can't list app inbox items (#proj-apps:#88). */
  | "agent_cli_old"
  /** No recent answer from the agent's CLI where it runs now: its Computer and daemon version, or within 24 h for an agent on no Computer (#proj-apps:#88). */
  | "agent_cli_unknown";

/**
 * Whether an App's `delivery: "inbox"` event (dm:@Remy:#1) can be held in the
 * agent's inbox without a wake: only where it becomes an inbox item the agent
 * lists with `raft inbox check` (inbox items on for the server, an event from
 * the launch's app-events start on) and the agent's CLI shows such items
 * (agentCliListsAppInboxItems). Elsewhere one never pushed would never be
 * seen: the caller wakes as usual and says why. Null: it can.
 */
export async function inboxOnlyDeliveryUnavailable(
  serverId: string,
  agentId: string,
  appKey: string,
  objectRef: string | null,
  now: Date = new Date(),
): Promise<InboxOnlyDeliveryUnavailable | null> {
  if (!await inboxItemsEnabled(serverId)) return "server";
  const launch = inboxItemsLaunch();
  if (!launch || appEventInboxItemTarget({ createdAt: now, systemApp: null, objectRef }, appKey, launch) === null) return "server";
  const cli = await agentCliInboxItemsState(agentId);
  return cli === "lists" ? null : cli === "old_cli" ? "agent_cli_old" : "agent_cli_unknown";
}

/**
 * Whether `event` joins an item whose last wake is unread and recent, and so
 * wakes no one; never for an agent whose CLI doesn't list app inbox items
 * (agentCliInboxItemsState is not `lists`). When it does, marks it (`wake_coalesced_at`) so no re-delivery
 * wakes for it either. Only an earlier unread event of the item that was not
 * merged itself, created at most APP_ITEM_WAKE_COALESCE_WINDOW_MS before
 * `event`, counts: of two events arriving together, the first still wakes. `appKey` is the
 * event's app key (the OAuth client key, or its `system.<id>`).
 */
export async function coalesceWakeIntoUnreadItem(
  event: CoalescibleEvent,
  appKey: string,
  options: { now?: Date; executor?: DatabaseExecutor } = {},
): Promise<boolean> {
  if (!await inboxItemsEnabled(event.serverId)) return false;
  const launch = inboxItemsLaunch();
  if (!launch || appEventInboxItemTarget(event, appKey, launch) === null) return false;
  const db = options.executor ?? getDb();
  const now = options.now ?? new Date();
  const [earlier] = await db.select({ id: thirdPartyAgentEvents.id })
    .from(thirdPartyAgentEvents)
    .where(and(
      eq(thirdPartyAgentEvents.agentId, event.agentId),
      event.clientId === null ? isNull(thirdPartyAgentEvents.clientId) : eq(thirdPartyAgentEvents.clientId, event.clientId),
      event.systemApp === null ? isNull(thirdPartyAgentEvents.systemApp) : eq(thirdPartyAgentEvents.systemApp, event.systemApp),
      event.objectRef === null ? isNull(thirdPartyAgentEvents.objectRef) : eq(thirdPartyAgentEvents.objectRef, event.objectRef),
      ne(thirdPartyAgentEvents.id, event.id),
      or(eq(thirdPartyAgentEvents.status, "queued"), eq(thirdPartyAgentEvents.status, "delivering")),
      // A wake, not an event merged into one.
      isNull(thirdPartyAgentEvents.wakeCoalescedAt),
      gt(thirdPartyAgentEvents.expiresAt, now),
      gte(thirdPartyAgentEvents.createdAt, launch.appEventsFrom),
      gte(thirdPartyAgentEvents.createdAt, new Date(event.createdAt.getTime() - APP_ITEM_WAKE_COALESCE_WINDOW_MS)),
      or(
        lt(thirdPartyAgentEvents.createdAt, event.createdAt),
        and(eq(thirdPartyAgentEvents.createdAt, event.createdAt), sql`${thirdPartyAgentEvents.id} < ${event.id}`),
      ),
    ))
    .limit(1);
  if (!earlier) return false;
  // Checked last: one agents read, only when the event would merge.
  if (await agentCliInboxItemsState(event.agentId, { now }) !== "lists") return false;
  await db.update(thirdPartyAgentEvents)
    .set({ wakeCoalescedAt: now, updatedAt: now })
    .where(and(eq(thirdPartyAgentEvents.id, event.id), isNull(thirdPartyAgentEvents.wakeCoalescedAt)));
  return true;
}

/**
 * A push can sit in the agent's Computer until its turn ends, so an item's
 * pushed event may be handed over after later ones were merged into it: its
 * notice was written before they came, and they would never wake anyone
 * (Tenny, #13995). So when a pushed event is handed over, the newest event
 * merged into its item after it, if still unread, gets the item's one push:
 * its merge mark is cleared and it goes out the normal way. Once that one is
 * handed over, nothing newer was merged, so the chain ends. Returns the ids
 * of the events it pushed.
 */
export async function wakeForEventsMergedSinceHandover(
  deliverer: Pick<AgentOrchestrator, "deliverMessage"> | undefined,
  agentId: string,
  handedOverIds: readonly string[],
  options: { now?: Date } = {},
): Promise<string[]> {
  if (!deliverer || handedOverIds.length === 0) return [];
  const db = getDb();
  const now = options.now ?? new Date();
  const handed = await db.select({
    id: thirdPartyAgentEvents.id,
    clientId: thirdPartyAgentEvents.clientId,
    systemApp: thirdPartyAgentEvents.systemApp,
    objectRef: thirdPartyAgentEvents.objectRef,
    createdAt: thirdPartyAgentEvents.createdAt,
  }).from(thirdPartyAgentEvents).where(and(
    eq(thirdPartyAgentEvents.agentId, agentId),
    inArray(thirdPartyAgentEvents.id, [...handedOverIds]),
    eq(thirdPartyAgentEvents.status, "delivered"),
    isNull(thirdPartyAgentEvents.wakeCoalescedAt),
  ));
  // The latest handed-over event per item.
  const byItem = new Map<string, (typeof handed)[number]>();
  for (const row of handed) {
    const key = JSON.stringify([row.clientId, row.systemApp, row.objectRef]);
    const prev = byItem.get(key);
    if (!prev || row.createdAt > prev.createdAt) byItem.set(key, row);
  }
  const released: string[] = [];
  for (const row of byItem.values()) {
    const sameItem = and(
      eq(thirdPartyAgentEvents.agentId, agentId),
      row.clientId === null ? isNull(thirdPartyAgentEvents.clientId) : eq(thirdPartyAgentEvents.clientId, row.clientId),
      row.systemApp === null ? isNull(thirdPartyAgentEvents.systemApp) : eq(thirdPartyAgentEvents.systemApp, row.systemApp),
      row.objectRef === null ? isNull(thirdPartyAgentEvents.objectRef) : eq(thirdPartyAgentEvents.objectRef, row.objectRef),
    );
    // A push of this item still in flight covers what came before it.
    const [inFlight] = await db.select({ id: thirdPartyAgentEvents.id }).from(thirdPartyAgentEvents)
      .where(and(sameItem, eq(thirdPartyAgentEvents.status, "delivering"), gt(thirdPartyAgentEvents.expiresAt, now)))
      .limit(1);
    if (inFlight) continue;
    // Merged after the item's latest handed-over event: never in any notice yet.
    const [latestHanded] = await db.select({ createdAt: thirdPartyAgentEvents.createdAt }).from(thirdPartyAgentEvents)
      .where(and(sameItem, eq(thirdPartyAgentEvents.status, "delivered"), isNull(thirdPartyAgentEvents.wakeCoalescedAt)))
      .orderBy(desc(thirdPartyAgentEvents.createdAt))
      .limit(1);
    const since = latestHanded?.createdAt ?? row.createdAt;
    const [newest] = await db.select({ id: thirdPartyAgentEvents.id })
      .from(thirdPartyAgentEvents)
      .where(and(
        sameItem,
        isNotNull(thirdPartyAgentEvents.wakeCoalescedAt),
        // Merged into a wake, not sent to wake no one (`delivery: "inbox"`).
        eq(thirdPartyAgentEvents.delivery, "wake"),
        eq(thirdPartyAgentEvents.status, "queued"),
        gt(thirdPartyAgentEvents.expiresAt, now),
        gt(thirdPartyAgentEvents.createdAt, since),
      ))
      .orderBy(desc(thirdPartyAgentEvents.createdAt), desc(thirdPartyAgentEvents.id))
      .limit(1);
    if (!newest) continue;
    // Conditional: of two handovers racing, one releases it.
    const [cleared] = await db.update(thirdPartyAgentEvents)
      .set({ wakeCoalescedAt: null, updatedAt: now })
      .where(and(eq(thirdPartyAgentEvents.id, newest.id), isNotNull(thirdPartyAgentEvents.wakeCoalescedAt)))
      .returning({ id: thirdPartyAgentEvents.id });
    if (cleared) released.push(cleared.id);
  }
  if (released.length === 0) return [];
  // Through the delivery guards, as every push.
  const messages = await listPendingThirdPartyAgentEventMessages({ agentId, onlyEventIds: released });
  const pushed: string[] = [];
  for (const message of messages) {
    const id = message.third_party_event?.id;
    if (!id || !await claimQueuedThirdPartyAgentEventForDelivery(id)) continue;
    try {
      await deliverer.deliverMessage(agentId, message);
      pushed.push(id);
    } catch (err) {
      await releaseThirdPartyAgentEventDeliveryClaim(id);
      console.warn(`[AppItemWake] push of merged event ${id} failed; the sweep retries it`, serializeErrorForLog(err));
    }
  }
  return pushed;
}
