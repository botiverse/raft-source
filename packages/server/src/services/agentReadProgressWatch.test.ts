/**
 * Agent read progress watches (agentReadProgressService.watchAgentReadProgress):
 * who may watch, the answer, the per-socket cap (oldest dropped), and watches
 * overtaken by an unwatch. The checks themselves are injected here; the
 * database-backed ones are covered in routes/agentReadProgress.api.test.ts.
 */
import assert from "node:assert/strict";
import {
  asServerId,
  READ_PROGRESS_MAX_WATCHED_SCOPES,
  READ_PROGRESS_WATCHED_EVENT,
  readProgressRoom,
  type ServerId,
} from "@botiverse/raft-shared";
import {
  unwatchAgentReadProgress,
  watchAgentReadProgress,
  type WatchAgentReadProgressDeps,
} from "./agentReadProgressService";

const SERVER = asServerId("server-1");

function fakeSocket() {
  const rooms = new Set<string>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    connected: true,
    data: {} as Record<string, unknown>,
    join(room: string | string[]) { for (const r of [room].flat()) rooms.add(r); },
    leave(room: string) { rooms.delete(room); },
    emit(event: string, payload: unknown) { emitted.push({ event, payload }); return true; },
  };
  return { socket: socket as unknown as Parameters<typeof watchAgentReadProgress>[0], raw: socket, rooms, emitted };
}

function allow(overrides: Partial<WatchAgentReadProgressDeps> = {}): WatchAgentReadProgressDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    flagEnabled: async () => { calls.push("flag"); return true; },
    canAccess: async () => { calls.push("access"); return true; },
    isEligible: async () => { calls.push("eligible"); return true; },
    ...overrides,
  };
}

test("an allowed watch joins the conversation's read-progress room and answers ok", async () => {
  const { socket, rooms, emitted } = fakeSocket();
  const deps = allow();
  assert.equal(await watchAgentReadProgress(socket, { userId: "u1", serverId: SERVER, body: { scopeId: "c1" } }, deps), true);
  assert.deepEqual([...rooms], [readProgressRoom("c1")]);
  assert.deepEqual(emitted, [{ event: READ_PROGRESS_WATCHED_EVENT, payload: { scopeId: "c1", ok: true } }]);
  assert.deepEqual(deps.calls, ["flag", "access", "eligible"]);
});

test("a watch is refused when the flag is off, without reading access", async () => {
  const { socket, rooms, emitted } = fakeSocket();
  const deps = allow({ flagEnabled: async () => false });
  assert.equal(await watchAgentReadProgress(socket, { userId: "u1", serverId: SERVER, body: { scopeId: "c1" } }, deps), false);
  assert.equal(rooms.size, 0);
  assert.deepEqual(emitted, [{ event: READ_PROGRESS_WATCHED_EVENT, payload: { scopeId: "c1", ok: false } }]);
  assert.deepEqual(deps.calls, [], "no access or scope read once the flag says no");
});

test("a watch is refused without access, outside the read-receipt scopes, without a server, or when a check fails", async () => {
  const cases: Array<[string, Partial<WatchAgentReadProgressDeps>, ServerId | null]> = [
    ["no access", { canAccess: async () => false }, SERVER],
    ["not eligible (#all)", { isEligible: async () => false }, SERVER],
    ["no server on the socket", {}, null],
    ["a check throws", { canAccess: async () => { throw new Error("invalid input syntax for type uuid"); } }, SERVER],
  ];
  for (const [label, overrides, serverId] of cases) {
    const { socket, rooms, emitted } = fakeSocket();
    assert.equal(await watchAgentReadProgress(socket, { userId: "u1", serverId, body: { scopeId: "c1" } }, allow(overrides)), false, label);
    assert.equal(rooms.size, 0, label);
    assert.deepEqual(emitted, [{ event: READ_PROGRESS_WATCHED_EVENT, payload: { scopeId: "c1", ok: false } }], label);
  }
});

test("a body without a string scope id is not answered", async () => {
  for (const body of [undefined, null, "c1", ["c1"], {}, { scopeId: 7 }, { scopeId: "" }, { scopeId: "x".repeat(65) }]) {
    const { socket, rooms, emitted } = fakeSocket();
    assert.equal(await watchAgentReadProgress(socket, { userId: "u1", serverId: SERVER, body }, allow()), false);
    assert.equal(rooms.size, 0);
    assert.deepEqual(emitted, []);
  }
});

test(`a socket watches at most ${READ_PROGRESS_MAX_WATCHED_SCOPES} conversations; one more drops the oldest`, async () => {
  const { socket, rooms } = fakeSocket();
  const deps = allow();
  const ids = Array.from({ length: READ_PROGRESS_MAX_WATCHED_SCOPES }, (_, index) => `c${index}`);
  for (const scopeId of ids) await watchAgentReadProgress(socket, { userId: "u1", serverId: SERVER, body: { scopeId } }, deps);
  assert.equal(rooms.size, READ_PROGRESS_MAX_WATCHED_SCOPES);

  // Watching c0 again makes it the newest, so c1 is now the oldest.
  await watchAgentReadProgress(socket, { userId: "u1", serverId: SERVER, body: { scopeId: "c0" } }, deps);
  assert.equal(rooms.size, READ_PROGRESS_MAX_WATCHED_SCOPES);
  await watchAgentReadProgress(socket, { userId: "u1", serverId: SERVER, body: { scopeId: "extra" } }, deps);
  assert.equal(rooms.size, READ_PROGRESS_MAX_WATCHED_SCOPES);
  assert.equal(rooms.has(readProgressRoom("c1")), false, "the oldest watch was dropped");
  assert.equal(rooms.has(readProgressRoom("c0")), true);
  assert.equal(rooms.has(readProgressRoom("extra")), true);
});

test("an unwatch leaves the room, and overtakes a watch still being checked", async () => {
  const { socket, rooms, emitted } = fakeSocket();
  await watchAgentReadProgress(socket, { userId: "u1", serverId: SERVER, body: { scopeId: "c1" } }, allow());
  unwatchAgentReadProgress(socket, { scopeId: "c1" });
  assert.equal(rooms.size, 0);

  let releaseAccess: (value: boolean) => void = () => {};
  const slow = allow({ canAccess: () => new Promise<boolean>((resolve) => { releaseAccess = resolve; }) });
  const watching = watchAgentReadProgress(socket, { userId: "u1", serverId: SERVER, body: { scopeId: "c2" } }, slow);
  await new Promise<void>((resolve) => setImmediate(resolve));
  unwatchAgentReadProgress(socket, { scopeId: "c2" });
  releaseAccess(true);
  assert.equal(await watching, false);
  assert.equal(rooms.has(readProgressRoom("c2")), false, "the overtaken watch joins nothing");
  assert.deepEqual(emitted.map((entry) => entry.payload), [{ scopeId: "c1", ok: true }], "and is not answered");
});

test("a socket that disconnected while its watch was checked joins nothing and gets no answer", async () => {
  const { socket, raw, rooms, emitted } = fakeSocket();
  const deps = allow({ isEligible: async () => { raw.connected = false; return true; } });
  assert.equal(await watchAgentReadProgress(socket, { userId: "u1", serverId: SERVER, body: { scopeId: "c1" } }, deps), false);
  assert.equal(rooms.size, 0);
  assert.deepEqual(emitted, []);
});
