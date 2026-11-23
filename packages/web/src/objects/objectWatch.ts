import { useEffect } from "react";
import type { Socket } from "socket.io-client";
import { OBJECT_CHANGED_EVENT, OBJECT_UNWATCH_EVENT, OBJECT_WATCH_EVENT } from "@botiverse/raft-shared";
import type { ObjectChangedEvent, ObjectChangedPart } from "@botiverse/raft-shared";
import type * as SocketApi from "../api/socket";
import { useServerStore } from "../store/serverStore";

/**
 * Core's live watch of an object an app shows (shared objectWatch.ts): while
 * a page has the object open, the server pings it (`object:changed`, no
 * content) after each committed change, so the page reads that part again at
 * once instead of on its next load. The socket and its reconnects are core's:
 *
 * - One `object:watch` per object however many surfaces watch it, sent when
 *   the first one starts (or the socket connects), `object:unwatch` when the
 *   last one stops. The server joins only when the person reads the object
 *   in the socket's server, as the page's reads are answered.
 * - After every connect (a reconnect, a new socket after a server switch)
 *   each watched object is watched again (rooms don't outlive a socket) and
 *   every watcher hears `resync`: pings may have been missed meanwhile, so it
 *   reads again what it would read on a ping.
 * - Under the main layout its bridge owns the socket; outside it (the
 *   Artifact's own page, useStandaloneObjectWatchSocket) a watch connects the
 *   socket for the current server itself, only while something is watched and
 *   a server is current (a public Artifact read as an outsider has none).
 */

/** What a watcher hears: a part of the object changed, or `resync` (the socket connected: anything may have). */
export type ObjectWatchSignal = ObjectChangedPart | "resync";
type Listener = (signal: ObjectWatchSignal) => void;
type Entry = { kind: string; id: string; listeners: Set<Listener> };

const watched = new Map<string, Entry>();
let bound: Socket | null = null;
let started = false;
let standaloneHosts = 0;
/** api/socket, loaded on the first watch: importing it reads the signed-in session, which a module that only might watch must not do at load. */
let socketApi: typeof SocketApi | null = null;

const keyOf = (kind: string, id: string) => `${kind}:${id}`;
const currentServerId = () => useServerStore.getState().current?.id ?? null;

function sendWatch(socket: Socket, entry: Entry): void {
  socket.emit(OBJECT_WATCH_EVENT, { kind: entry.kind, id: entry.id });
}

function tell(entry: Entry, signal: ObjectWatchSignal): void {
  for (const listener of [...entry.listeners]) listener(signal);
}

function onChanged(event: ObjectChangedEvent): void {
  if (!event || typeof event.kind !== "string" || typeof event.id !== "string") return;
  const entry = watched.get(keyOf(event.kind, event.id));
  if (entry) tell(entry, event.part);
}

function onConnect(): void {
  const socket = bound;
  if (!socket) return;
  // Outside the main layout, a socket of another server than the page's reads nothing it watches: made again.
  if (standaloneHosts > 0 && socketApi?.connectedSocketServerId() !== currentServerId()) {
    ensureStandaloneSocket();
    return;
  }
  for (const entry of watched.values()) sendWatch(socket, entry);
  for (const entry of [...watched.values()]) tell(entry, "resync");
}

function bind(socket: Socket): void {
  if (bound === socket) return;
  bound?.off("connect", onConnect);
  bound?.off(OBJECT_CHANGED_EVENT, onChanged);
  bound = socket;
  socket.on("connect", onConnect);
  socket.on(OBJECT_CHANGED_EVENT, onChanged);
  if (socket.connected) for (const entry of watched.values()) sendWatch(socket, entry);
}

function start(): void {
  if (started) return;
  started = true;
  void import("../api/socket").then((api) => {
    socketApi = api;
    // A new socket replaces the old one (a server switch, a sign-in): its listeners went with it.
    api.onSocketCreated(bind);
    bind(api.getSocket());
    ensureStandaloneSocket();
  });
}

/** Outside the main layout: the socket, for the current server, while anything is watched. */
function ensureStandaloneSocket(): void {
  if (standaloneHosts === 0 || watched.size === 0) return;
  const serverId = currentServerId();
  if (serverId === null) return;
  // Not loaded yet: start() asks again once it is.
  socketApi?.ensureSocketForServer(serverId);
}

/**
 * Hear about one object (`kind`, its own id) while the returned stop isn't
 * called: `listener` gets each changed part, and `resync` after the socket
 * connects. Never throws; without a socket it waits for one.
 */
export function watchObject(kind: string, id: string, listener: Listener): () => void {
  start();
  const key = keyOf(kind, id);
  let entry = watched.get(key);
  if (!entry) {
    entry = { kind, id, listeners: new Set() };
    watched.set(key, entry);
    if (bound?.connected) sendWatch(bound, entry);
  }
  entry.listeners.add(listener);
  ensureStandaloneSocket();
  const own = entry;
  return () => {
    own.listeners.delete(listener);
    if (own.listeners.size > 0 || watched.get(key) !== own) return;
    watched.delete(key);
    if (bound?.connected) bound.emit(OBJECT_UNWATCH_EVENT, { kind, id });
  };
}

/**
 * For a page outside the main layout (the Artifact's own page,
 * `/artifacts/:id`, which has no realtime bridge): while it is mounted and
 * `enabled`, a watch connects the socket for the current server (and again
 * when the current server changes), so its objects' pings reach it. Under
 * the main layout, never: the bridge owns the socket.
 */
export function useStandaloneObjectWatchSocket(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    standaloneHosts += 1;
    const stop = useServerStore.subscribe((state, previous) => {
      if ((state.current?.id ?? null) !== (previous.current?.id ?? null)) ensureStandaloneSocket();
    });
    ensureStandaloneSocket();
    return () => {
      standaloneHosts -= 1;
      stop();
    };
  }, [enabled]);
}
