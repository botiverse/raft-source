import type { ObjectInboxItem, SummarizedObjectKind } from "@botiverse/raft-shared";

// ---- Object rows (shared activityObjectsContract): parsing what Activity serves ----

/**
 * The object kinds this client draws an Activity row for. A row of a kind it
 * doesn't know (a newer server's) is left out, as the contract asks of every
 * client; the record makes a new kind in the contract a type error here until
 * its row exists.
 */
const ACTIVITY_OBJECT_KINDS: Readonly<Record<SummarizedObjectKind, true>> = { artifact: true };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a served row is an object's (shown or not: parseObjectActivityRow decides). */
export function isObjectActivityRow(row: unknown): boolean {
  return isRecord(row) && row.kind === "object";
}

/**
 * A served object row this client can show, or null: a kind it doesn't know
 * or a row without what Activity needs (its identity, unread, time and Done
 * frontier, the event and the home) is left out rather than drawn wrong.
 */
export function parseObjectActivityRow(row: unknown): ObjectInboxItem | null {
  if (!isRecord(row) || row.kind !== "object") return null;
  const { objectKind, objectId, unreadCount, hasMention, lastActivityAt, doneFrontierSeq, latestEvent, home } = row;
  if (typeof objectKind !== "string" || !Object.hasOwn(ACTIVITY_OBJECT_KINDS, objectKind)) return null;
  if (typeof objectId !== "string" || objectId.length === 0) return null;
  if (typeof unreadCount !== "number" || !Number.isSafeInteger(unreadCount) || unreadCount < 0) return null;
  if (typeof hasMention !== "boolean" || typeof lastActivityAt !== "string") return null;
  if (typeof doneFrontierSeq !== "string" || !/^(0|[1-9][0-9]*)$/.test(doneFrontierSeq)) return null;
  if (!isRecord(latestEvent) || !isRecord(latestEvent.actor) || !isRecord(home) || typeof home.kind !== "string") return null;
  return row as unknown as ObjectInboxItem;
}
