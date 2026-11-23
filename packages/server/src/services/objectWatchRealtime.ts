/**
 * The `object:changed` ping (shared objectWatch.ts) to the sockets watching
 * one object: after the commit of a change to one part of it (its comments,
 * a new version), to that part's room (`objectWatchRoom`), which only sockets
 * whose person could read the object when they watched it are in
 * (socket/objectWatch.ts). Carries no content. Generic: the kind is the
 * app's, as it registered it.
 *
 * - announceObjectChanged (platform/objectWatch): the ping, through the
 *   socket server's adapter (Redis across replicas), as every room emit.
 * - forgetObjectWatchers (platform/objectWatch): every socket leaves the
 *   object's rooms, on every replica, after the commit that deleted it or
 *   moved it to a smaller home; a page still open re-watches (and is
 *   checked again) on its next mount or reconnect.
 *
 * A socket server of its own, not activityRealtime's (tests replace that one
 * with fakes that count every frame): set once by server.ts and by the test
 * app; with none set (a job runner, a unit test) nothing is sent.
 */
import type { Server as SocketServer } from "socket.io";
import { OBJECT_CHANGED_EVENT, OBJECT_CHANGED_PARTS, objectWatchRoom, type ObjectChangedEvent, type ObjectChangedPart } from "@botiverse/raft-shared";

type ObjectWatchEmitter = Pick<SocketServer, "to">;

let emitter: ObjectWatchEmitter | null = null;

/** Set by server.ts once Socket.io is up (and by the test app); null stops sending. */
export function setObjectWatchRealtimeIO(io: ObjectWatchEmitter | null): void {
  emitter = io;
}

/** `object:changed` for one part of one object, to the sockets watching that part. Never throws: a ping is a hint. */
export function announceObjectChanged(kind: string, id: string, part: ObjectChangedPart): void {
  if (!emitter) return;
  try {
    const payload: ObjectChangedEvent = { kind, id, part };
    emitter.to(objectWatchRoom(kind, id, part)).emit(OBJECT_CHANGED_EVENT, payload);
  } catch (error) {
    console.error("[object-watch] announcing a change failed", error instanceof Error ? error.message : error);
  }
}

/** Every socket watching the object leaves its rooms, on every replica. Never throws. */
export function forgetObjectWatchers(kind: string, id: string): void {
  if (!emitter) return;
  const rooms = OBJECT_CHANGED_PARTS.map((part) => objectWatchRoom(kind, id, part));
  try {
    emitter.to(rooms).socketsLeave(rooms);
  } catch (error) {
    console.error("[object-watch] forgetting watchers failed", error instanceof Error ? error.message : error);
  }
}
