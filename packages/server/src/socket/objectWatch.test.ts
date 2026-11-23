// object:watch's rules (./objectWatch.ts) on a stand-in socket: the app's
// answer decides the rooms, refusals join nothing, the per-socket cap and
// rate limit refuse before any read, and an unwatch wins over a watch still
// being checked.
import assert from "node:assert/strict";
import { OBJECT_WATCH_MAX_PER_MINUTE, OBJECT_WATCH_MAX_PER_SOCKET, objectWatchRoom } from "@botiverse/raft-shared";
import { createObjectWatches, type ObjectWatchResolver } from "./objectWatch";

function fakeSocket() {
  const rooms = new Set<string>();
  return { rooms, connected: true, join: (room: string) => rooms.add(room), leave: (room: string) => rooms.delete(room) };
}

const viewer = { userId: "u1", serverId: "s1", sessionFamilyId: null };
/** Reads `pt_<n>` and `short-<n>` as the same object; `hidden-*` is no one's to read; `public-*` is read as an outsider. */
const resolver = (asked: string[] = []): ObjectWatchResolver => async (kind, who, ref) => {
  asked.push(`${kind}:${who.serverId}:${ref}`);
  if (kind !== "artifact" || ref.startsWith("hidden-")) return null;
  if (ref.startsWith("public-")) return { id: ref, parts: ["version"] };
  return { id: ref.replace(/^short-/, "pt_"), parts: ["comments", "version"] };
};

test("a readable object joins one room per part the app answered; a refused one joins nothing", async () => {
  const socket = fakeSocket();
  const asked: string[] = [];
  const watches = createObjectWatches(socket, viewer, resolver(asked));
  assert.deepEqual(await watches.watch({ kind: "artifact", id: "hidden-1" }), { ok: false, code: "not_visible" });
  assert.equal(socket.rooms.size, 0);
  assert.deepEqual(await watches.watch({ kind: "artifact", id: "short-1" }), { ok: true, id: "pt_1", parts: ["comments", "version"] });
  assert.deepEqual([...socket.rooms].sort(), [objectWatchRoom("artifact", "pt_1", "comments"), objectWatchRoom("artifact", "pt_1", "version")]);
  assert.deepEqual(await watches.watch({ kind: "artifact", id: "public-2" }), { ok: true, id: "public-2", parts: ["version"] });
  assert.ok(socket.rooms.has(objectWatchRoom("artifact", "public-2", "version")));
  assert.ok(!socket.rooms.has(objectWatchRoom("artifact", "public-2", "comments")), "an outsider hears no comments");
  // Asked as the socket's person in its server.
  assert.deepEqual(asked, ["artifact:s1:hidden-1", "artifact:s1:short-1", "artifact:s1:public-2"]);
});

test("malformed requests, a socket of no server and a resolver that throws are refused without joining", async () => {
  const socket = fakeSocket();
  const watches = createObjectWatches(socket, viewer, async () => { throw new Error("db down"); });
  for (const body of [null, "pt_1", { kind: "artifact" }, { kind: "", id: "x" }, { kind: "artifact", id: "x".repeat(129) }]) {
    assert.deepEqual(await watches.watch(body), { ok: false, code: "invalid" });
  }
  assert.deepEqual(await watches.watch({ kind: "artifact", id: "pt_1" }), { ok: false, code: "not_visible" }, "fails closed");
  const asked: string[] = [];
  const serverless = createObjectWatches(socket, { ...viewer, serverId: null }, resolver(asked));
  assert.deepEqual(await serverless.watch({ kind: "artifact", id: "pt_1" }), { ok: false, code: "not_visible" });
  assert.deepEqual(asked, [], "no read for a socket of no server");
  assert.equal(socket.rooms.size, 0);
});

test("watching again re-checks: an object no longer readable leaves its rooms", async () => {
  const socket = fakeSocket();
  let readable = true;
  const watches = createObjectWatches(socket, viewer, async (_kind, _who, ref) => (readable ? { id: ref, parts: ["comments", "version"] } : null));
  assert.equal((await watches.watch({ kind: "artifact", id: "pt_1" })).ok, true);
  assert.equal(socket.rooms.size, 2);
  readable = false;
  assert.deepEqual(await watches.watch({ kind: "artifact", id: "pt_1" }), { ok: false, code: "not_visible" });
  assert.equal(socket.rooms.size, 0);
  assert.equal(watches.watching(), 0);
});

test("unwatch leaves the rooms, by the id watched or the object's own; and wins over a watch still being checked", async () => {
  const socket = fakeSocket();
  const watches = createObjectWatches(socket, viewer, resolver());
  await watches.watch({ kind: "artifact", id: "short-1" });
  watches.unwatch({ kind: "artifact", id: "short-1" });
  assert.equal(socket.rooms.size, 0);
  await watches.watch({ kind: "artifact", id: "short-1" });
  watches.unwatch({ kind: "artifact", id: "pt_1" });
  assert.equal(socket.rooms.size, 0);

  let release: () => void = () => {};
  const slow = createObjectWatches(socket, viewer, async (_kind, _who, ref) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { id: ref, parts: ["comments"] };
  });
  const pending = slow.watch({ kind: "artifact", id: "pt_9" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  slow.unwatch({ kind: "artifact", id: "pt_9" });
  release();
  assert.deepEqual(await pending, { ok: false, code: "superseded" });
  assert.equal(socket.rooms.size, 0);
});

test("a disconnected socket joins nothing", async () => {
  const socket = fakeSocket();
  const watches = createObjectWatches(socket, viewer, async (_kind, _who, ref) => {
    socket.connected = false;
    return { id: ref, parts: ["comments"] };
  });
  assert.deepEqual(await watches.watch({ kind: "artifact", id: "pt_1" }), { ok: false, code: "superseded" });
  assert.equal(socket.rooms.size, 0);
});

test(`at most ${OBJECT_WATCH_MAX_PER_SOCKET} objects per socket, re-watching one of them still allowed`, async () => {
  const socket = fakeSocket();
  const asked: string[] = [];
  const watches = createObjectWatches(socket, viewer, resolver(asked));
  for (let n = 0; n < OBJECT_WATCH_MAX_PER_SOCKET; n += 1) assert.equal((await watches.watch({ kind: "artifact", id: `pt_${n}` })).ok, true);
  const before = asked.length;
  assert.deepEqual(await watches.watch({ kind: "artifact", id: "pt_extra" }), { ok: false, code: "too_many" });
  assert.equal(asked.length, before, "refused before any read");
  assert.equal((await watches.watch({ kind: "artifact", id: "pt_0" })).ok, true, "one already watched is re-checked");
  watches.unwatch({ kind: "artifact", id: "pt_1" });
  assert.equal((await watches.watch({ kind: "artifact", id: "pt_extra" })).ok, true, "room again after an unwatch");
  assert.equal(watches.watching(), OBJECT_WATCH_MAX_PER_SOCKET);
});

test(`at most ${OBJECT_WATCH_MAX_PER_MINUTE} watch requests a minute per socket`, async () => {
  const socket = fakeSocket();
  let clock = 0;
  const asked: string[] = [];
  const watches = createObjectWatches(socket, viewer, resolver(asked), () => clock);
  for (let n = 0; n < OBJECT_WATCH_MAX_PER_MINUTE; n += 1) assert.equal((await watches.watch({ kind: "artifact", id: "pt_1" })).ok, true);
  assert.deepEqual(await watches.watch({ kind: "artifact", id: "pt_1" }), { ok: false, code: "rate_limited" });
  assert.equal(asked.length, OBJECT_WATCH_MAX_PER_MINUTE, "refused before any read");
  clock += 60_000;
  assert.equal((await watches.watch({ kind: "artifact", id: "pt_1" })).ok, true, "a new minute");
});
