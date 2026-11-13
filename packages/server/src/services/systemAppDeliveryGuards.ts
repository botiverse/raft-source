/**
 * Delivery-time guards for Raft system-app agent events (`third_party_agent_events`
 * rows with `system_app` set).
 *
 * A queued or delivering event can be (re)delivered long after it was written:
 * by its first push (and that push's short ack retries / wake conversion), the
 * inbox push sweep, the reconnect / `/events` rebuild, the hand-over of the
 * agent's in-memory buffer (`/events`, the legacy daemon receive, the wake on
 * machine ready), the managed-agent re-delivery on machine ready and its
 * periodic sweep (`thirdPartyAgentEventRedelivery`), or re-read by
 * `agent-event:<id>`. A system app whose events
 * the recipient may stop being allowed to see registers a guard; every one of
 * those paths runs it over the batch it is about to hand over (one call per
 * system app per batch).
 *
 * Three outcomes per event:
 * - allowed: the guard returned true for it;
 * - vetoed: the guard returned false for it, or left it out of a verdict map
 *   it did return. Not delivered, and marked `expired` (the table's terminal
 *   "never delivered" status) so no later path serves it;
 * - withheld (fail closed): its app requires a guard
 *   (`systemAppsRequiringDeliveryGuard`: every first-party app with agent
 *   notices) and has none, or the guard threw. Not delivered, but the row
 *   is left as is (logged), so a later attempt, e.g. once a deploy that
 *   registers the guard has rolled out everywhere, can still deliver it.
 * A re-read never changes a row: vetoed and withheld both read as no such event.
 *
 * Rollout: a first-party app's guard comes with the registration that makes
 * it required, so a replica that requires it always has it.
 *
 * Apps with no guard registered that are not required to have one (the
 * assistant doorbell, RaftBench) skip all of this: no query, no change.
 * Third-party OAuth rows (client_id set) are never guarded here.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { currentDate, type AgentMessage } from "@botiverse/raft-shared";
import { firstPartyAppOfSystemApp, firstPartyApps, systemAppsWithAgentNotices } from "../apps/firstPartyApps";
import { getDb, type DatabaseExecutor } from "../db/index";
import { CORE_SYSTEM_APPS, thirdPartyAgentEvents } from "../db/schema";

export type SystemAppAgentEvent = typeof thirdPartyAgentEvents.$inferSelect;
export type SystemApp = NonNullable<SystemAppAgentEvent["systemApp"]>;

/** Verdict per event id; an id the guard leaves out counts as false (vetoed). */
export type SystemAppDeliveryGuardVerdicts = ReadonlyMap<string, boolean>;
export type SystemAppDeliveryGuard = (
  events: readonly SystemAppAgentEvent[],
) => Promise<SystemAppDeliveryGuardVerdicts> | SystemAppDeliveryGuardVerdicts;

/**
 * System apps whose events must never be delivered without their guard's
 * say-so: every first-party app that sends agents notices (apps/firstPartyApps.ts;
 * an app's `agentNotice.deliverable` is its guard, about objects its
 * recipient may stop being able to see).
 */
export function systemAppsRequiringDeliveryGuard(): ReadonlySet<SystemApp> {
  return new Set<SystemApp>(systemAppsWithAgentNotices() as SystemApp[]);
}

/** Core's own system apps and every first-party app's. */
function isSystemApp(value: string): value is SystemApp {
  return (CORE_SYSTEM_APPS as readonly string[]).includes(value) || firstPartyApps().some((app) => app.systemApp === value);
}

let requiredSystemAppsOverride: ReadonlySet<SystemApp> | null = null;
/** Guards registered at run time (core's own system apps, tests); a first-party app's comes from the registry. */
const deliveryGuards = new Map<SystemApp, SystemAppDeliveryGuard>();

function requiresDeliveryGuard(systemApp: SystemApp): boolean {
  return (requiredSystemAppsOverride ?? systemAppsRequiringDeliveryGuard()).has(systemApp);
}

/** The guard of a system app: one registered at run time, else its first-party app's `agentNotice.deliverable`. */
function guardOf(systemApp: SystemApp): SystemAppDeliveryGuard | undefined {
  const registered = deliveryGuards.get(systemApp);
  if (registered) return registered;
  const deliverable = firstPartyAppOfSystemApp(systemApp)?.agentNotice?.deliverable;
  return deliverable ? (events) => deliverable(events) : undefined;
}

/** True when delivering this app's events goes through a guard (registered or required). */
export function isSystemAppDeliveryGuarded(systemApp: SystemApp): boolean {
  return guardOf(systemApp) !== undefined || requiresDeliveryGuard(systemApp);
}

/**
 * The system apps that require a delivery guard, each of which has one; throws
 * naming any that has none. The production entry (server.ts) runs it at
 * startup and logs the list, so no process that delivers events starts
 * without them (serverEntry.deliveryGuards.test.ts).
 */
export function assertRequiredSystemAppDeliveryGuards(): SystemApp[] {
  const required = [...(requiredSystemAppsOverride ?? systemAppsRequiringDeliveryGuard())].sort();
  const missing = required.filter((systemApp) => !guardOf(systemApp));
  if (missing.length > 0) throw new Error(`system apps without the delivery guard they require: ${missing.join(", ")}`);
  return required;
}

/**
 * Registers the delivery guard of a system app at run time (one per app).
 * Returns the function that unregisters it. A first-party app's guard is its
 * registration's and needs no call.
 */
export function registerSystemAppDeliveryGuard(systemApp: SystemApp, guard: SystemAppDeliveryGuard): () => void {
  if (guardOf(systemApp)) throw new Error(`delivery guard for ${systemApp} is already registered`);
  deliveryGuards.set(systemApp, guard);
  return () => {
    if (deliveryGuards.get(systemApp) === guard) deliveryGuards.delete(systemApp);
  };
}

/** Test hook: replaces the required set until the returned restore is called. */
export function __setSystemAppsRequiringDeliveryGuardForTests(systemApps: Iterable<SystemApp>): () => void {
  const previous = requiredSystemAppsOverride;
  requiredSystemAppsOverride = new Set(systemApps);
  return () => { requiredSystemAppsOverride = previous; };
}

/** Moves vetoed events that are still pending to `expired`. */
async function expireVetoedSystemAppEvents(eventIds: readonly string[], executor: DatabaseExecutor): Promise<void> {
  if (eventIds.length === 0) return;
  await executor.update(thirdPartyAgentEvents)
    .set({ status: "expired", updatedAt: currentDate() })
    .where(and(
      inArray(thirdPartyAgentEvents.id, [...eventIds]),
      or(eq(thirdPartyAgentEvents.status, "queued"), eq(thirdPartyAgentEvents.status, "delivering")),
    ));
}

type GuardOutcome = "allowed" | "vetoed" | "withheld";

/** Each guarded event's outcome, one guard call per system app. */
async function guardOutcomes(groups: Map<SystemApp, SystemAppAgentEvent[]>): Promise<Map<string, GuardOutcome>> {
  const outcomes = new Map<string, GuardOutcome>();
  const withhold = (events: SystemAppAgentEvent[]) => { for (const event of events) outcomes.set(event.id, "withheld"); };
  for (const [systemApp, events] of groups) {
    const guard = guardOf(systemApp);
    if (!guard) {
      // Only required apps reach here without a guard.
      console.warn(`[SystemAppDeliveryGuard] ${systemApp} requires a delivery guard and none is registered; withholding ${events.length} event(s)`);
      withhold(events);
      continue;
    }
    let verdicts: SystemAppDeliveryGuardVerdicts;
    try {
      verdicts = await guard(events);
    } catch (err) {
      console.warn(`[SystemAppDeliveryGuard] ${systemApp} delivery guard failed; withholding ${events.length} event(s)`, err);
      withhold(events);
      continue;
    }
    for (const event of events) outcomes.set(event.id, verdicts.get(event.id) === true ? "allowed" : "vetoed");
  }
  return outcomes;
}

type GuardSplit<T> = { allowed: T[]; vetoed: T[]; withheld: T[] };

/** Runs the guards over a batch. No side effects. */
async function splitByDeliveryGuards<T>(
  items: readonly T[],
  eventOf: (item: T) => SystemAppAgentEvent,
): Promise<GuardSplit<T>> {
  const groups = new Map<SystemApp, SystemAppAgentEvent[]>();
  for (const item of items) {
    const event = eventOf(item);
    if (event.clientId !== null || !event.systemApp || !isSystemAppDeliveryGuarded(event.systemApp)) continue;
    const group = groups.get(event.systemApp);
    if (group) group.push(event);
    else groups.set(event.systemApp, [event]);
  }
  const split: GuardSplit<T> = { allowed: [], vetoed: [], withheld: [] };
  if (groups.size === 0) {
    split.allowed.push(...items);
    return split;
  }
  const outcomes = await guardOutcomes(groups);
  for (const item of items) split[outcomes.get(eventOf(item).id) ?? "allowed"].push(item);
  return split;
}

/**
 * Splits a batch about to be delivered by its guards' outcomes and marks the
 * vetoed events expired (withheld ones are left as is). `eventOf` maps an item
 * to its event row; rows of unguarded apps and OAuth-client rows are always
 * deliverable (and cost nothing).
 */
export async function partitionDeliverableSystemAppEvents<T>(
  items: readonly T[],
  eventOf: (item: T) => SystemAppAgentEvent,
  options: { executor?: DatabaseExecutor } = {},
): Promise<{ deliverable: T[]; vetoed: T[]; withheld: T[] }> {
  const { allowed, vetoed, withheld } = await splitByDeliveryGuards(items, eventOf);
  await expireVetoedSystemAppEvents(vetoed.map((item) => eventOf(item).id), options.executor ?? getDb());
  return { deliverable: allowed, vetoed, withheld };
}

/**
 * For a re-read of events the agent may already have (`agent-event:<id>`):
 * the items the guards let through. Nothing is expired, since a re-read is not
 * a delivery and the row may be delivered.
 */
export async function filterReadableSystemAppEvents<T>(
  items: readonly T[],
  eventOf: (item: T) => SystemAppAgentEvent,
): Promise<T[]> {
  return (await splitByDeliveryGuards(items, eventOf)).allowed;
}

/**
 * The same split for messages already in an agent's in-memory buffer, which
 * carry the event only as `third_party_event`: the rows of guarded system
 * apps' messages are read back (one query) and guarded. Neither `vetoed` nor
 * `withheld` may be handed over now. `vetoed` (expired by the check, or whose
 * row is gone or no longer pending) can be dropped from the buffer; `withheld`
 * (fail closed, row left as is) stays there for a later attempt. Messages
 * whose event id is in `guardedEventIds` (just guarded by the caller) and
 * everything else are deliverable untouched, in their order.
 */
export async function partitionDeliverableSystemAppEventMessages<M extends AgentMessage>(
  messages: readonly M[],
  agentId: string,
  options: { executor?: DatabaseExecutor; guardedEventIds?: ReadonlySet<string> } = {},
): Promise<{ deliverable: M[]; vetoed: M[]; withheld: M[] }> {
  // System rows carry the app as their client key (buildSystemAppAgentMessage);
  // the row read below confirms it is a system row, not a same-named client.
  const candidates = new Set(messages
    .filter((m) => {
      const app = m.third_party_event?.client_id;
      return typeof app === "string" && isSystemApp(app) && isSystemAppDeliveryGuarded(app)
        && !options.guardedEventIds?.has(m.third_party_event!.id);
    })
    .map((m) => m.third_party_event!.id));
  if (candidates.size === 0) return { deliverable: [...messages], vetoed: [], withheld: [] };

  const executor = options.executor ?? getDb();
  const rows = await executor.select().from(thirdPartyAgentEvents).where(and(
    eq(thirdPartyAgentEvents.agentId, agentId),
    inArray(thirdPartyAgentEvents.id, [...candidates]),
  ));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const now = currentDate().getTime();
  const live = rows.filter((row) => row.clientId === null
    && (row.status === "queued" || row.status === "delivering")
    && row.expiresAt.getTime() > now);
  const split = await partitionDeliverableSystemAppEvents(live, (row) => row, { executor });
  const allowedIds = new Set(split.deliverable.map((row) => row.id));
  const withheldIds = new Set(split.withheld.map((row) => row.id));

  const deliverable: M[] = [];
  const vetoed: M[] = [];
  const withheld: M[] = [];
  for (const message of messages) {
    const id = message.third_party_event?.id;
    const row = id ? rowsById.get(id) : undefined;
    if (!id || !candidates.has(id)) deliverable.push(message);
    // A same-named OAuth client's row is not a system row.
    else if (row && (row.clientId !== null || allowedIds.has(row.id))) deliverable.push(message);
    else if (row && withheldIds.has(row.id)) withheld.push(message);
    else vetoed.push(message);
  }
  return { deliverable, vetoed, withheld };
}
