// What core hands a first-party app's mounts and jobs (platform/apps.ts),
// for any registered app (apps/firstPartyApps.ts): its notice outbox in the agent
// event queue. Attachments an app reads through platform/attachments.
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { AppNoticeOutbox, FirstPartyApp } from "../platform/apps";
import { appNoticeKinds } from "../apps/firstPartyApps";
import { getDb, type DatabaseExecutor } from "../db/index";
import { thirdPartyAgentEvents } from "../db/schema";
import { createSystemAppAgentEvent, deliverSystemAppAgentEvent, type SystemAppAgentEventDeliverer } from "./systemAppAgentEvents";

/** The app_event fields core sets from the registration and the checked kind. */
const APP_EVENT_RESERVED_KEYS = ["app", "kind"] as const;
/** A notice's `key` is kept in `external_event_id`, which an external app's own id fills up to this length. */
const NOTICE_KEY_MAX_CHARS = 200;

/**
 * An app's notices as `system.<id>` notifications in the agent event queue,
 * pushed through `deliverer` (the router's or the server's agent
 * orchestrator; none: they wait for the agent's next pull). The payload is
 * `{ app_event: { ...event, app, kind } }`; `kind` must be one of the app's
 * object kinds or notice kinds. `app` and `kind` are core's, checked here: an event naming
 * either itself is refused, never let through to stand in for them. A
 * failed push leaves the event queued: the agent's next /events pull or the
 * push sweep takes it.
 *
 * One read state (RFC 081 §5): `withdrawUnread` and `onceWithinMs` move an
 * event between the statuses every other path already reads. Taken back is
 * `expired`, the table's "never delivered" status (as a delivery guard's
 * veto), so the inbox listing, the pending queue, the wake merge and the
 * hand-over of a buffered push all leave it out without knowing why; back
 * again is `queued`. `wake_coalesced_at` says the event's wake is spent (it
 * was pushed before it was taken back), so nothing pushes it a second time.
 */
export function appNoticeOutbox(app: FirstPartyApp, deliverer: SystemAppAgentEventDeliverer | undefined): AppNoticeOutbox {
  const queuedEvent = async (eventId: string) => {
    const [event] = await getDb().select().from(thirdPartyAgentEvents)
      .where(and(
        eq(thirdPartyAgentEvents.id, eventId),
        eq(thirdPartyAgentEvents.status, "queued"),
        // Joined an unread item, or its wake was spent before it was taken back: readable, never pushed.
        isNull(thirdPartyAgentEvents.wakeCoalescedAt),
      )).limit(1);
    return event ?? null;
  };
  /** The app's events for one agent about one object: the events of one inbox item. */
  const itemEvents = (agentId: string, objectRef: string) => and(
    eq(thirdPartyAgentEvents.agentId, agentId),
    isNull(thirdPartyAgentEvents.clientId),
    eq(thirdPartyAgentEvents.systemApp, app.systemApp),
    eq(thirdPartyAgentEvents.objectRef, objectRef),
  );
  const unread = (now: Date) => and(
    or(eq(thirdPartyAgentEvents.status, "queued"), eq(thirdPartyAgentEvents.status, "delivering")),
    gt(thirdPartyAgentEvents.expiresAt, now),
  );
  /** onceWithinMs: the newest notice with this key queued in the window, unread again when it had been taken back. */
  const earlierNotice = async (executor: DatabaseExecutor, input: { agentId: string; objectRef: string; key: string; withinMs: number; now: Date }) => {
    const [earlier] = await executor.select({
      id: thirdPartyAgentEvents.id,
      status: thirdPartyAgentEvents.status,
      expiresAt: thirdPartyAgentEvents.expiresAt,
    }).from(thirdPartyAgentEvents)
      .where(and(
        itemEvents(input.agentId, input.objectRef),
        eq(thirdPartyAgentEvents.externalEventId, input.key),
        gt(thirdPartyAgentEvents.createdAt, new Date(input.now.getTime() - input.withinMs)),
      ))
      .orderBy(desc(thirdPartyAgentEvents.createdAt), desc(thirdPartyAgentEvents.id))
      .limit(1)
      .for("update");
    if (!earlier) return null;
    if (earlier.status === "expired" && earlier.expiresAt.getTime() > input.now.getTime()) {
      // Taken back (or vetoed: its delivery guard decides again on the next hand-over or listing). Its merge mark stays as it was.
      await executor.update(thirdPartyAgentEvents)
        .set({ status: "queued", updatedAt: input.now })
        .where(and(eq(thirdPartyAgentEvents.id, earlier.id), eq(thirdPartyAgentEvents.status, "expired")));
    }
    return earlier.id;
  };
  return {
    async queue(executor, input) {
      if (!app.agentNotice) throw new Error(`first-party app ${app.id} registers no agent notices`);
      if (!appNoticeKinds(app).includes(input.kind)) throw new Error(`${input.kind} is not an object kind or a notice kind of ${app.id}`);
      const reserved = APP_EVENT_RESERVED_KEYS.filter((key) => Object.hasOwn(input.event, key));
      if (reserved.length > 0) throw new Error(`${app.id}'s notice event may not set ${reserved.join(", ")}: core sets them`);
      if (input.key !== undefined && (input.key.length < 1 || input.key.length > NOTICE_KEY_MAX_CHARS)) {
        throw new Error(`${app.id}'s notice key must be 1-${NOTICE_KEY_MAX_CHARS} characters`);
      }
      if (input.onceWithinMs !== undefined) {
        if (input.key === undefined || input.objectRef === undefined) throw new Error(`${app.id}: onceWithinMs needs the notice's key and objectRef`);
        const earlier = await earlierNotice(executor, { agentId: input.agentId, objectRef: input.objectRef, key: input.key, withinMs: input.onceWithinMs, now: input.now });
        if (earlier) return { eventId: earlier, created: false };
      }
      const event = await createSystemAppAgentEvent({
        serverId: input.serverId,
        agentId: input.agentId,
        systemApp: app.systemApp,
        kind: "notification",
        summary: input.summary,
        payload: { app_event: { ...input.event, app: app.id, kind: input.kind } },
        ttlMs: input.ttlMs,
        now: input.now,
        executor,
        objectRef: input.objectRef,
        relatedChannelId: input.relatedChannelId ?? null,
        eventKey: input.key ?? null,
      });
      return { eventId: event.id, created: true };
    },
    async push(eventId) {
      const event = deliverer ? await queuedEvent(eventId) : null;
      if (!event || !deliverer) return;
      await deliverSystemAppAgentEvent({
        event,
        deliverer,
        onDeliveryError: (err) => console.error(`[${app.id}] notice delivery failed; left queued`, err instanceof Error ? err.message : err),
      });
    },
    async withdraw(eventId) {
      await getDb().delete(thirdPartyAgentEvents)
        .where(and(eq(thirdPartyAgentEvents.id, eventId), eq(thirdPartyAgentEvents.status, "queued")));
    },
    async withdrawUnread(executor, input) {
      const item = itemEvents(input.agentId, input.objectRef);
      const targets = await executor.select({
        id: thirdPartyAgentEvents.id,
        status: thirdPartyAgentEvents.status,
        wakeCoalescedAt: thirdPartyAgentEvents.wakeCoalescedAt,
      }).from(thirdPartyAgentEvents)
        .where(and(item, unread(input.now), input.key === undefined ? undefined : eq(thirdPartyAgentEvents.externalEventId, input.key)))
        .for("update");
      if (targets.length === 0) return { withdrawn: 0, pushEventId: null };
      await executor.update(thirdPartyAgentEvents)
        .set({
          status: "expired",
          updatedAt: input.now,
          // SET reads the row as it was: a pushed (`delivering`) event's wake is spent, so one that comes back is not pushed again.
          wakeCoalescedAt: sql`case when ${thirdPartyAgentEvents.status} = 'delivering' then coalesce(${thirdPartyAgentEvents.wakeCoalescedAt}, ${input.now}) else ${thirdPartyAgentEvents.wakeCoalescedAt} end`,
        })
        .where(and(
          inArray(thirdPartyAgentEvents.id, targets.map((target) => target.id)),
          or(eq(thirdPartyAgentEvents.status, "queued"), eq(thirdPartyAgentEvents.status, "delivering")),
        ));
      const withdrawn = targets.length;
      // The item's wake went with what was taken back only when that held it (never merged) and was never pushed.
      const heldWakeUnpushed = targets.some((target) => target.status === "queued" && target.wakeCoalescedAt === null);
      if (!heldWakeUnpushed || targets.some((target) => target.status === "delivering")) return { withdrawn, pushEventId: null };
      const remaining = await executor.select({ id: thirdPartyAgentEvents.id, wakeCoalescedAt: thirdPartyAgentEvents.wakeCoalescedAt })
        .from(thirdPartyAgentEvents)
        .where(and(item, unread(input.now)))
        .orderBy(asc(thirdPartyAgentEvents.createdAt), asc(thirdPartyAgentEvents.id));
      // Others are still unread, every one merged into the item: its oldest takes the wake
      // (the push's own merge check then finds no earlier unread event, so it goes out).
      const oldest = remaining[0];
      if (!oldest || remaining.some((row) => row.wakeCoalescedAt === null)) return { withdrawn, pushEventId: null };
      await executor.update(thirdPartyAgentEvents)
        .set({ wakeCoalescedAt: null, updatedAt: input.now })
        .where(eq(thirdPartyAgentEvents.id, oldest.id));
      return { withdrawn, pushEventId: oldest.id };
    },
  };
}
