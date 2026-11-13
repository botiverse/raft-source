/**
 * Core write side of `object_inbox_states` (S6, first-party app mechanism
 * §四): a person's Activity row for an object, kept at write time so Activity
 * and its badge read one index range of one table (services/objectActivity.ts)
 * and never aggregate events or ask the app on the badge's path.
 *
 * - recordObjectInboxStates: called by recordObjectEvent in the event's
 *   transaction. Every event moves the object's home on all its rows; each
 *   person among the recipients gets their row created or moved to the event
 *   (agents get none: Activity rows are people's).
 * - markObjectRead (platform/activity): the app reports that a person's read
 *   position on an object moved, in the transaction that moves it; core turns
 *   it into an event seq (`read_through_seq`).
 * - forgetObjectActivity (platform/activity): an object nobody may see any
 *   more (deleted): its rows go; or some people may not (moved to a smaller
 *   home): theirs go (objectActivityPeople lists whose rows there are).
 *
 * Nothing here names an app: kinds are the registry's (recordObjectEvent has
 * checked them).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { objectInboxStates, type ObjectEventRecipientReason } from "../db/schema";
import { objectActivityFanout } from "../metrics";

/** The event as recordObjectEvent wrote it. */
export interface RecordedObjectEvent {
  id: string;
  seq: number;
  createdAt: Date;
  serverId: string;
  kind: string;
  objectId: string;
  /** The object's home after the event (a conversation home without its conversation: an orphan). */
  home: { kind: "conversation"; channelId: string | null } | { kind: "server" } | { kind: "public" };
}

function homeColumns(home: RecordedObjectEvent["home"]): { homeKind: "conversation" | "server" | "public"; homeChannelId: string | null } {
  return { homeKind: home.kind, homeChannelId: home.kind === "conversation" ? home.channelId : null };
}

/**
 * The rows of one event, in its transaction: the object's home on all its
 * rows, then each person among `recipients` (one row each: recordObjectEvent
 * has kept each actor's strongest reason and left out the actor) moved to
 * this event, unless a newer one is already there (events of one object can
 * commit out of seq order). Rows are written in user order, so concurrent
 * events of one object take their row locks in the same order.
 */
export async function recordObjectInboxStates(
  executor: DatabaseExecutor,
  event: RecordedObjectEvent,
  recipients: ReadonlyArray<{ recipientType: "user" | "agent"; recipientId: string; reason: ObjectEventRecipientReason }>,
): Promise<void> {
  const home = homeColumns(event.home);
  await executor.update(objectInboxStates)
    .set(home)
    .where(and(
      eq(objectInboxStates.objectKind, event.kind),
      eq(objectInboxStates.objectId, event.objectId),
      sql`(${objectInboxStates.homeKind}, ${objectInboxStates.homeChannelId}) IS DISTINCT FROM (${home.homeKind}::text, ${home.homeChannelId}::uuid)`,
    ));
  const people = recipients.filter((recipient) => recipient.recipientType === "user")
    .sort((left, right) => left.recipientId.localeCompare(right.recipientId));
  // The fan-out (metrics.ts says when it outgrows Postgres): the app's recipients, those mentioned and followers, never all who can see.
  objectActivityFanout.observe({ object_kind: event.kind }, people.length);
  if (people.length === 0) return;
  await executor.insert(objectInboxStates).values(people.map((person) => ({
    userId: person.recipientId,
    objectKind: event.kind,
    objectId: event.objectId,
    serverId: event.serverId,
    ...home,
    lastEventId: event.id,
    lastEventSeq: event.seq,
    lastEventAt: event.createdAt,
    lastMentionSeq: person.reason === "mentioned" ? event.seq : null,
  }))).onConflictDoUpdate({
    target: [objectInboxStates.userId, objectInboxStates.objectKind, objectInboxStates.objectId],
    set: {
      lastEventId: sql`CASE WHEN excluded.last_event_seq > ${objectInboxStates.lastEventSeq} THEN excluded.last_event_id ELSE ${objectInboxStates.lastEventId} END`,
      lastEventAt: sql`CASE WHEN excluded.last_event_seq > ${objectInboxStates.lastEventSeq} THEN excluded.last_event_at ELSE ${objectInboxStates.lastEventAt} END`,
      lastEventSeq: sql`GREATEST(${objectInboxStates.lastEventSeq}, excluded.last_event_seq)`,
      lastMentionSeq: sql`GREATEST(${objectInboxStates.lastMentionSeq}, excluded.last_mention_seq)`,
      updatedAt: sql`now()`,
    },
  });
}

/**
 * How far a person has read an object, as its app knows it:
 * - `latest`: everything there is now;
 * - `{ field, upTo }`: the app's own order of its events, a number at
 *   `field` of each event's data (such as an item position): the person has
 *   read everything at or before `upTo`. An event can carry an older place
 *   than events before it (an edit of an old comment carries that comment's
 *   position), so the read covers the events up to the first one past
 *   `upTo`, not every event at or before it.
 */
export type ObjectReadThrough = "latest" | { field: string; upTo: number };

/**
 * Report that a person's read positions on objects of one kind moved, in the
 * transaction that moves them (platform/activity). Moves each of the
 * person's rows' `read_through_seq` forward: for `latest`, to the object's
 * newest event; for `{ field, upTo }`, to just before the oldest event whose
 * `field` is past `upTo` (seq order is the order events happened in: an
 * event the person hasn't read is never covered, whatever came after it),
 * or to the newest event when none is. An event without a number at `field`
 * is covered by those around it. An object the person has no row for has
 * nothing to move. One statement however many objects.
 *
 * A read reported from a position read earlier (a viewer that read the
 * object's last position, then wrote it after newer events committed) only
 * covers what lay at or before that position: the newer events stay unread.
 */
export async function markObjectRead(executor: DatabaseExecutor, input: {
  userId: string;
  kind: string;
  objects: ReadonlyArray<{ objectId: string; through: ObjectReadThrough }>;
}): Promise<void> {
  if (input.objects.length === 0) return;
  const targets = JSON.stringify(input.objects.map(({ objectId, through }) => (through === "latest"
    ? { object_id: objectId, field: null, up_to: null }
    : { object_id: objectId, field: through.field, up_to: through.upTo })));
  // A value at `field` that isn't a number (or a missing one) is never past the read; CASE keeps the cast from ever seeing it.
  await executor.execute(sql`
    UPDATE object_inbox_states s
    SET read_through_seq = GREATEST(COALESCE(s.read_through_seq, 0), r.seq), updated_at = now()
    FROM (
      SELECT t.object_id, (
        SELECT LEAST(max(e.seq), COALESCE(min(e.seq) FILTER (
          WHERE t.field IS NOT NULL AND (CASE WHEN jsonb_typeof(e.data -> t.field) = 'number' THEN (e.data ->> t.field)::numeric END) > t.up_to
        ) - 1, max(e.seq)))
        FROM object_events e
        WHERE e.object_kind = ${input.kind} AND e.object_id = t.object_id
      ) AS seq
      FROM jsonb_to_recordset(${targets}::jsonb) AS t(object_id text, field text, up_to numeric)
    ) r
    WHERE s.user_id = ${input.userId}::uuid AND s.object_kind = ${input.kind} AND s.object_id = r.object_id
      AND r.seq IS NOT NULL
      AND r.seq > COALESCE(s.read_through_seq, 0)`);
}

/**
 * An object nobody may see any more (deleted by its app): every person's row
 * for it goes, in the deleting transaction. With `userIds`, an object some
 * people may no longer see (moved to a smaller home): only their rows go.
 * Returns whose rows went, for the caller to tell their clients after the
 * commit (announceActivityChanged).
 */
export async function forgetObjectActivity(
  executor: DatabaseExecutor,
  input: { kind: string; objectId: string; userIds?: readonly string[] },
): Promise<ForgottenActivityRow[]> {
  if (input.userIds?.length === 0) return [];
  return executor.delete(objectInboxStates)
    .where(and(
      eq(objectInboxStates.objectKind, input.kind),
      eq(objectInboxStates.objectId, input.objectId),
      input.userIds ? inArray(objectInboxStates.userId, [...input.userIds]) : undefined,
    ))
    .returning({ userId: objectInboxStates.userId, serverId: objectInboxStates.serverId, homeKind: objectInboxStates.homeKind, homeChannelId: objectInboxStates.homeChannelId });
}

/** A person's row that went (forgetObjectActivity): whose, the object's server and its home then (a joint's is announced in the person's servers in it too). */
export interface ForgottenActivityRow {
  userId: string;
  serverId: string;
  homeKind: string | null;
  homeChannelId: string | null;
}

/** The people who have an Activity row for an object, and the server it is in for them. One query. */
export async function objectActivityPeople(executor: DatabaseExecutor, input: { kind: string; objectId: string }): Promise<Array<{ userId: string; serverId: string }>> {
  return executor.select({ userId: objectInboxStates.userId, serverId: objectInboxStates.serverId }).from(objectInboxStates)
    .where(and(eq(objectInboxStates.objectKind, input.kind), eq(objectInboxStates.objectId, input.objectId)));
}
