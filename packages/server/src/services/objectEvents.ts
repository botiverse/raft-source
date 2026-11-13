/**
 * Core write side of `object_events` and `object_event_recipients`
 * (technical design §7; first-party app mechanism §三): what happened to an
 * object that is not a message, where the object lives after it, and whom
 * it is for. An app calls recordObjectEvent once per change, in the same
 * transaction as the change (platform/objects). Which object kinds and event
 * kinds exist is the app registry's (apps/firstPartyApps.ts): anything else is
 * refused before a row is written. Retention is objectEventRetention.ts.
 * Each person among the recipients gets their Activity row moved to the
 * event in the same transaction (objectInboxStates.ts).
 */
import { and, eq } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import { firstPartyApps, registeredObjectKind } from "../apps/firstPartyApps";
import type { DatabaseExecutor } from "../db/index";
import { objectEventRecipients, objectEvents, type ObjectEventData, type ObjectEventRecipientReason } from "../db/schema";
import { recordObjectInboxStates } from "./objectInboxStates";
import type { ViewHome } from "./visibilityService";

export type { ObjectEventRecipientReason };

/**
 * Where an object lives (visibilityService's homes), or a conversation home
 * whose conversation is gone (an orphan: `channelId` null), as the platform's
 * visibility treats it.
 */
export type ObjectEventHome = ViewHome | { kind: "conversation"; channelId: null };

export interface ObjectEventRecipient {
  actor: { type: "user" | "agent"; id: string };
  reason: ObjectEventRecipientReason;
}

export interface ObjectEventInput {
  serverId: ServerId;
  /** A registered object kind (FirstPartyApp.objectKinds). */
  kind: string;
  objectId: string;
  /** One of that kind's registered events. */
  eventKind: string;
  /** Where the object lives after the change (a server home is `serverId`'s). */
  home: ObjectEventHome;
  /** Where it lived before, when the change moved it. */
  previousHome?: ObjectEventHome;
  actor: { type: "user" | "agent"; id: string };
  /** Small facts (ids, positions, numbers): at most 4 KiB as stored, or the insert fails. */
  data: ObjectEventData;
  /**
   * Whom the event is for, with why (the app knows who is mentioned and who
   * follows). One row each: an actor listed more than once keeps its
   * strongest reason (mentioned, then owner, then following); the event's own
   * actor is left out.
   */
  recipients: readonly ObjectEventRecipient[];
}

/** A kind or event kind the registry doesn't have, or a home that doesn't fit the event. */
export class ObjectEventRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectEventRejected";
  }
}

const REASON_STRENGTH: Record<ObjectEventRecipientReason, number> = { mentioned: 3, owner: 2, following: 1 };

function checkInput(input: ObjectEventInput): void {
  const registered = registeredObjectKind(input.kind);
  if (!registered) {
    const known = firstPartyApps().flatMap((app) => app.objectKinds.map((objectKind) => objectKind.kind));
    throw new ObjectEventRejected(`object kind ${JSON.stringify(input.kind)} is not registered (registered: ${known.join(", ")})`);
  }
  if (!registered.objectKind.events.includes(input.eventKind)) {
    throw new ObjectEventRejected(`event ${JSON.stringify(input.eventKind)} is not registered for ${input.kind} (registered: ${registered.objectKind.events.join(", ")})`);
  }
  for (const home of [input.home, input.previousHome]) {
    if (home?.kind === "server" && home.serverId !== input.serverId) throw new ObjectEventRejected("a server home is the event's own server");
  }
}

/** One row per recipient, its strongest reason; the actor left out. */
function recipientRows(eventId: string, input: ObjectEventInput) {
  const byActor = new Map<string, ObjectEventRecipient>();
  for (const recipient of input.recipients) {
    if (recipient.actor.type === input.actor.type && recipient.actor.id === input.actor.id) continue;
    const key = `${recipient.actor.type}:${recipient.actor.id}`;
    const had = byActor.get(key);
    if (!had || REASON_STRENGTH[recipient.reason] > REASON_STRENGTH[had.reason]) byActor.set(key, recipient);
  }
  return [...byActor.values()].map((recipient) => ({
    eventId,
    recipientType: recipient.actor.type,
    recipientId: recipient.actor.id,
    reason: recipient.reason,
  }));
}

/**
 * Record one event and its recipients; pass the transaction of the change it
 * describes. Throws ObjectEventRejected for an unregistered kind or event
 * kind (nothing written).
 */
export async function recordObjectEvent(executor: DatabaseExecutor, input: ObjectEventInput): Promise<{ id: string; seq: number }> {
  checkInput(input);
  const [row] = await executor.insert(objectEvents).values({
    serverId: input.serverId,
    objectKind: input.kind,
    objectId: input.objectId,
    eventKind: input.eventKind,
    homeKind: input.home.kind,
    homeChannelId: input.home.kind === "conversation" ? input.home.channelId : null,
    actorType: input.actor.type,
    actorId: input.actor.id,
    data: input.data,
  }).returning({ id: objectEvents.id, seq: objectEvents.seq, createdAt: objectEvents.createdAt });
  if (!row) throw new Error("object event insert returned no row");
  const recipients = recipientRows(row.id, input);
  if (recipients.length > 0) await executor.insert(objectEventRecipients).values(recipients);
  // People's Activity rows (and the object's home on all of its rows), in this transaction.
  await recordObjectInboxStates(executor, {
    id: row.id,
    seq: row.seq,
    createdAt: row.createdAt,
    serverId: input.serverId,
    kind: input.kind,
    objectId: input.objectId,
    home: input.home.kind === "conversation" ? { kind: "conversation", channelId: input.home.channelId } : { kind: input.home.kind },
  }, recipients);
  // Layer 3 (§三 step 3): the change_log rows go here, in this transaction:
  // the object changed in `input.home`, and with `input.previousHome` a
  // removal in the old home, so whoever saw it there drops it from their
  // cache. Not written until change_log ships; clients sync by polling until then.
  return { id: row.id, seq: row.seq };
}

/**
 * Forget every event of one object, their recipients with them (cascade),
 * in the app's transaction: for an app removing the object for good, so
 * nothing of it (an event's `data`, a rename's titles) outlives it before
 * retention would (Artifacts' operator purge, apps/artifacts/purge.ts).
 * People's Activity rows are the app's to forget too (forgetObjectActivity).
 * Returns how many events went.
 */
export async function forgetObjectEvents(executor: DatabaseExecutor, input: { kind: string; objectId: string }): Promise<number> {
  const gone = await executor.delete(objectEvents)
    .where(and(eq(objectEvents.objectKind, input.kind), eq(objectEvents.objectId, input.objectId)))
    .returning({ id: objectEvents.id });
  return gone.length;
}
