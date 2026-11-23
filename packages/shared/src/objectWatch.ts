// Watching one object live (an open Artifact's page): a content-free ping
// when what its page shows changed, so the page reads it again at once
// instead of on its next load.
//
// - The client asks OBJECT_WATCH_EVENT `{ kind, id }` (an Artifact: its
//   `pt_` id or its 22-character short id) while the page is open, again
//   after every reconnect (rooms don't survive one), and OBJECT_UNWATCH_EVENT
//   when it closes. The server joins the socket to the object's rooms only
//   when its person can read the object now, by the app's own read rule (the
//   rule the page's reads answer by), one room per part the person reads:
//   an outsider of a public Artifact reads no comments, so hears only
//   `version`. The optional ack answers ObjectWatchAck.
// - After the commit of a change to a part, the server sends
//   OBJECT_CHANGED_EVENT (ObjectChangedEvent) to that part's room: no
//   content, only which object and which part; the page reads that part
//   again through its ordinary (checked) reads.
// - A socket watches at most OBJECT_WATCH_MAX_PER_SOCKET objects, and asks at
//   most OBJECT_WATCH_MAX_PER_MINUTE times a minute; past either, refused.
// - Rooms are joined on the socket's own replica; pings go through the
//   socket server's adapter (Redis across replicas), as every room emit.

/** Client -> server: ObjectWatchInput, with an optional ack (ObjectWatchAck). */
export const OBJECT_WATCH_EVENT = "object:watch" as const;
/** Client -> server: ObjectWatchInput (the id as watched, or the id the ack answered). */
export const OBJECT_UNWATCH_EVENT = "object:unwatch" as const;
/** Server -> client: ObjectChangedEvent. */
export const OBJECT_CHANGED_EVENT = "object:changed" as const;

/** Most objects one socket watches at once. */
export const OBJECT_WATCH_MAX_PER_SOCKET = 20;
/** Most watch requests one socket makes in a minute (each one reads the object's visibility). */
export const OBJECT_WATCH_MAX_PER_MINUTE = 60;

/** What part of an object's page changed: its comments (written, edited, deleted, resolved, reopened, a review), or a new version. */
export const OBJECT_CHANGED_PARTS = ["comments", "version"] as const;
export type ObjectChangedPart = (typeof OBJECT_CHANGED_PARTS)[number];

export interface ObjectWatchInput {
  /** The object kind (`artifact`). */
  kind: string;
  /** The object's id as the client has it (an Artifact: `pt_…` or its short id). */
  id: string;
}

/**
 * The watch's answer. `id`: the object's own id (the one pings carry);
 * `parts`: what this person hears of. Refused: `not_visible` (no such object,
 * not theirs to read, or a socket of no server), `too_many`, `rate_limited`,
 * `invalid` (a malformed request), `superseded` (an unwatch or a newer watch
 * of the same id came first).
 */
export type ObjectWatchAck =
  | { ok: true; id: string; parts: ObjectChangedPart[] }
  | { ok: false; code: "not_visible" | "too_many" | "rate_limited" | "invalid" | "superseded" };

export interface ObjectChangedEvent {
  kind: string;
  /** The object's own id (an Artifact's `pt_…`, as ObjectWatchAck `id`). */
  id: string;
  part: ObjectChangedPart;
}

/** The socket room of one part of one object. */
export function objectWatchRoom(kind: string, id: string, part: ObjectChangedPart): string {
  return `object-watch:${kind}:${id}:${part}`;
}
