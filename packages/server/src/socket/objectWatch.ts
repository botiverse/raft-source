/**
 * `object:watch` / `object:unwatch` (shared objectWatch.ts): a socket joins
 * the rooms of one object an open page shows, so it hears `object:changed`
 * (services/objectWatchRealtime.ts) after each committed change to it.
 *
 * - Joined only after the object's app said this socket's person reads the
 *   object now (`resolve`: the registered kind's AppObjectKind.watch, the
 *   app's own read rule, as the page's reads), asked as the socket's person
 *   in the socket's server; a socket of no server, an unknown kind, an object
 *   the person can't read, or a read that failed: refused, nothing joined
 *   (fail closed). One room per part the app answered (an outsider of a
 *   public Artifact hears only `version`).
 * - At most OBJECT_WATCH_MAX_PER_SOCKET objects per socket, and
 *   OBJECT_WATCH_MAX_PER_MINUTE watch requests per socket per minute (each
 *   reads the object's visibility); past either, refused before any read.
 * - Watching an object again re-checks it: its rooms follow the new answer
 *   (refused: it leaves them). An unwatch, or a later watch of the same id,
 *   wins over a watch still being checked (`superseded`).
 * - Rooms go with the socket (a reconnect is a new socket: the client watches
 *   again, and is checked again). That is how a person who loses an object by
 *   losing a membership stops hearing it: removal from a channel or a server
 *   (and a role change, a channel made private, a joint ending) closes their
 *   sockets (all of them, or that server's) after the commit
 *   (accessRevocation.ts revokeSocketAccess, on every replica), so no watch
 *   here outlives it. Sockets are only people's: an agent removed or
 *   deactivated watches nothing.
 */
import {
  OBJECT_CHANGED_PARTS,
  OBJECT_UNWATCH_EVENT,
  OBJECT_WATCH_EVENT,
  OBJECT_WATCH_MAX_PER_MINUTE,
  OBJECT_WATCH_MAX_PER_SOCKET,
  objectWatchRoom,
  type ObjectChangedPart,
  type ObjectWatchAck,
  type ObjectWatchInput,
} from "@botiverse/raft-shared";
import type { Socket } from "socket.io";

/** What a watch is asked as: the socket's person, in the socket's server (null: a socket of no server, never answered). */
export interface ObjectWatchViewer {
  userId: string;
  serverId: string | null;
  sessionFamilyId: string | null;
}

/** The object's own id and the parts the viewer reads, or null: refused. May throw (refused too). */
export type ObjectWatchResolver = (
  kind: string,
  viewer: ObjectWatchViewer & { serverId: string },
  ref: string,
) => Promise<{ id: string; parts: readonly ObjectChangedPart[] } | null>;

type WatchSocket = {
  readonly connected: boolean;
  join(room: string): unknown;
  leave(room: string): unknown;
};

const MAX_KIND_CHARS = 32;
const MAX_ID_CHARS = 128;
const MINUTE_MS = 60_000;

/** `{ kind, id }`, strings of a sane length, else null. */
export function parseObjectWatchInput(value: unknown): ObjectWatchInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { kind, id } = value as Record<string, unknown>;
  if (typeof kind !== "string" || kind.length === 0 || kind.length > MAX_KIND_CHARS) return null;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_CHARS) return null;
  return { kind, id };
}

/** The watches of one socket: its state lives as long as the socket. */
export function createObjectWatches(socket: WatchSocket, viewer: ObjectWatchViewer, resolve: ObjectWatchResolver, now: () => number = Date.now) {
  /** By `kind:<own id>`: the id it was asked by, and the rooms joined. */
  const watched = new Map<string, { kind: string; ref: string; rooms: string[] }>();
  /** By `kind:<ref>`: the newest watch still being checked. */
  const pending = new Map<string, object>();
  let windowStart = now();
  let windowCount = 0;

  const refKey = (kind: string, ref: string) => `${kind}:${ref}`;
  const entryOf = (kind: string, ref: string): string | null => {
    if (watched.has(refKey(kind, ref))) return refKey(kind, ref);
    for (const [key, entry] of watched) if (entry.kind === kind && entry.ref === ref) return key;
    return null;
  };
  const forget = (key: string) => {
    for (const room of watched.get(key)?.rooms ?? []) socket.leave(room);
    watched.delete(key);
  };
  const spend = (): boolean => {
    const at = now();
    if (at - windowStart >= MINUTE_MS) {
      windowStart = at;
      windowCount = 0;
    }
    windowCount += 1;
    return windowCount <= OBJECT_WATCH_MAX_PER_MINUTE;
  };

  async function watch(body: unknown): Promise<ObjectWatchAck> {
    const input = parseObjectWatchInput(body);
    if (!input) return { ok: false, code: "invalid" };
    if (!spend()) return { ok: false, code: "rate_limited" };
    const { kind, id: ref } = input;
    const serverId = viewer.serverId;
    if (serverId === null) return { ok: false, code: "not_visible" };
    // Room for it before any read: watching one already watched again is a re-check.
    if (entryOf(kind, ref) === null && watched.size >= OBJECT_WATCH_MAX_PER_SOCKET) return { ok: false, code: "too_many" };
    const token = {};
    pending.set(refKey(kind, ref), token);
    let answer: Awaited<ReturnType<ObjectWatchResolver>>;
    try {
      answer = await resolve(kind, { ...viewer, serverId }, ref);
    } catch {
      // A failed read fails closed.
      answer = null;
    }
    if (pending.get(refKey(kind, ref)) !== token) return { ok: false, code: "superseded" };
    pending.delete(refKey(kind, ref));
    if (!socket.connected) return { ok: false, code: "superseded" };
    if (!answer) {
      // Watched before and not readable now: it hears nothing more.
      const before = entryOf(kind, ref);
      if (before !== null) forget(before);
      return { ok: false, code: "not_visible" };
    }
    const key = refKey(kind, answer.id);
    if (!watched.has(key) && watched.size >= OBJECT_WATCH_MAX_PER_SOCKET) return { ok: false, code: "too_many" };
    const parts = OBJECT_CHANGED_PARTS.filter((part) => answer.parts.includes(part));
    const rooms = parts.map((part) => objectWatchRoom(kind, answer.id, part));
    for (const room of watched.get(key)?.rooms ?? []) if (!rooms.includes(room)) socket.leave(room);
    for (const room of rooms) socket.join(room);
    watched.set(key, { kind, ref, rooms });
    return { ok: true, id: answer.id, parts };
  }

  function unwatch(body: unknown): void {
    const input = parseObjectWatchInput(body);
    if (!input) return;
    pending.delete(refKey(input.kind, input.id));
    const key = entryOf(input.kind, input.id);
    if (key === null) return;
    // A watch of it by its other id, still being checked, is over too.
    pending.delete(refKey(input.kind, watched.get(key)!.ref));
    forget(key);
  }

  return { watch, unwatch, watching: () => watched.size };
}

/** Wire the two events on a connected socket; the ack (when the client asked for one) answers ObjectWatchAck. */
export function attachObjectWatchHandlers(
  socket: Pick<Socket, "on" | "join" | "leave" | "connected">,
  viewer: ObjectWatchViewer,
  resolve: ObjectWatchResolver,
): void {
  const watches = createObjectWatches(socket, viewer, resolve);
  socket.on(OBJECT_WATCH_EVENT, (body: unknown, ack?: unknown) => {
    void watches.watch(body).then((answer) => {
      if (typeof ack === "function" && socket.connected) ack(answer);
    });
  });
  socket.on(OBJECT_UNWATCH_EVENT, (body: unknown) => watches.unwatch(body));
}
