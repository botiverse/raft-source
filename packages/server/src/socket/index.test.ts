import assert from "node:assert/strict";
import { countSocketClients, joinMemberConversationRooms, MEMBER_ROOM_JOIN_RETRY_MAX_MS, memberRoomJoinRetryDelayMs, parseSocketHandshakeAuth, requiresSocketChannelAccessCheck, SOCKET_ROOMS_JOIN_FAILED_EVENT } from "./index";
import { SOCKET_CLIENT_KINDS } from "./platformScope";

test("socket join access check treats joint channels as explicit-membership surfaces", () => {
  assert.equal(requiresSocketChannelAccessCheck("channel"), true);
  assert.equal(requiresSocketChannelAccessCheck("private"), true);
  assert.equal(requiresSocketChannelAccessCheck("joint"), true);
  assert.equal(requiresSocketChannelAccessCheck("dm"), true);
  assert.equal(requiresSocketChannelAccessCheck("thread"), true);
  assert.equal(requiresSocketChannelAccessCheck("future-channel-type"), true);
});

test("socket handshake auth parser accepts current web auth shape", () => {
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: "server-1" }), {
    ok: true,
    token: "access-token",
    serverId: "server-1",
    clientKind: "web",
  });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: null }), {
    ok: true,
    token: "access-token",
    serverId: null,
    clientKind: "web",
  });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token" }), {
    ok: true,
    token: "access-token",
    serverId: null,
    clientKind: "web",
  });
});

test("socket handshake auth parser accepts explicit clientKind values", () => {
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: "server-1", clientKind: "mobile" }), {
    ok: true,
    token: "access-token",
    serverId: "server-1",
    clientKind: "mobile",
  });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: "server-1", clientKind: "desktop" }), {
    ok: true,
    token: "access-token",
    serverId: "server-1",
    clientKind: "desktop",
  });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: "server-1", clientKind: "cli" }), {
    ok: true,
    token: "access-token",
    serverId: "server-1",
    clientKind: "cli",
  });
});

test("socket handshake auth parser rejects malformed auth bags before authentication", () => {
  assert.deepEqual(parseSocketHandshakeAuth(null), { ok: false, reason: "auth_not_object" });
  assert.deepEqual(parseSocketHandshakeAuth("token"), { ok: false, reason: "auth_not_object" });
  assert.deepEqual(parseSocketHandshakeAuth(["access-token"]), { ok: false, reason: "auth_not_object" });
  assert.deepEqual(parseSocketHandshakeAuth({}), { ok: false, reason: "token_missing" });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "" }), { ok: false, reason: "token_missing" });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: "" }), {
    ok: false,
    reason: "server_id_invalid",
  });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: 123 }), {
    ok: false,
    reason: "server_id_invalid",
  });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", clientKind: "watch" }), {
    ok: false,
    reason: "client_kind_invalid",
  });
});

test("countSocketClients counts by kind, with zeros and an other bucket", () => {
  assert.deepEqual(
    countSocketClients([
      { data: { clientKind: "web" } },
      { data: { clientKind: "web" } },
      { data: { clientKind: "mobile" } },
      { data: {} },
    ]),
    { ...Object.fromEntries(SOCKET_CLIENT_KINDS.map((kind) => [`socket_clients_${kind}`, 0])), socket_clients_web: 2, socket_clients_mobile: 1, socket_clients_other: 1 },
  );
});

function fakeMemberSocket() {
  const joined: string[] = [];
  const emitted: string[] = [];
  const socket = {
    connected: true,
    join: (room: string) => { joined.push(room); },
    emit: (event: string) => { emitted.push(event); },
  };
  return { socket, joined, emitted };
}

test("member room join retry delay: 1 s doubling to 60 s, jittered into [50%, 100%]", () => {
  const top = () => 1 - Number.EPSILON;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => memberRoomJoinRetryDelayMs(n, top)), [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  assert.equal(memberRoomJoinRetryDelayMs(1, () => 0), 500);
  assert.equal(memberRoomJoinRetryDelayMs(40, () => 0), MEMBER_ROOM_JOIN_RETRY_MAX_MS / 2);
});

test("a failed member room lookup keeps the socket, signals once, and joins with rooms:joined after a retry", async () => {
  const { socket, joined, emitted } = fakeMemberSocket();
  const waits: number[] = [];
  let calls = 0;
  const result = await joinMemberConversationRooms(socket, async () => {
    calls += 1;
    if (calls < 4) throw new Error("db timeout");
    return [{ id: "c1" }, { id: "dm1" }];
  }, { sleep: async (ms) => { waits.push(ms); }, random: () => 1 - Number.EPSILON });
  assert.equal(result, "joined");
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1_000, 2_000, 4_000], "exponential backoff between attempts");
  assert.deepEqual(joined, ["channel:c1", "channel:dm1"]);
  assert.deepEqual(emitted, [SOCKET_ROOMS_JOIN_FAILED_EVENT, "rooms:joined"], "degraded once, then joined");
  assert.equal(socket.connected, true, "never disconnected");
});

test("a member room lookup that keeps failing keeps retrying (capped) and never emits rooms:joined", async () => {
  const { socket, emitted } = fakeMemberSocket();
  const waits: number[] = [];
  const controller = new AbortController();
  const result = await joinMemberConversationRooms(socket, async () => {
    throw new Error("db down");
  }, {
    signal: controller.signal,
    random: () => 1 - Number.EPSILON,
    sleep: async (ms) => {
      waits.push(ms);
      if (waits.length === 10) controller.abort();
    },
  });
  assert.equal(result, "gone");
  assert.equal(waits.length, 10);
  assert.equal(Math.max(...waits), MEMBER_ROOM_JOIN_RETRY_MAX_MS);
  assert.deepEqual(emitted, [SOCKET_ROOMS_JOIN_FAILED_EVENT], "one degraded signal, no rooms:joined");
  assert.equal(socket.connected, true);
});

test("a disconnect stops the background retry: the wait ends and nothing more is read", async () => {
  vi.useFakeTimers();
  try {
    const { socket, emitted } = fakeMemberSocket();
    const controller = new AbortController();
    let calls = 0;
    const done = joinMemberConversationRooms(socket, async () => {
      calls += 1;
      throw new Error("db down");
    }, { signal: controller.signal, random: () => 0 });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(calls, 1);
    socket.connected = false;
    controller.abort();
    assert.equal(await done, "gone", "the pending backoff wait resolves on disconnect");
    await vi.advanceTimersByTimeAsync(10 * MEMBER_ROOM_JOIN_RETRY_MAX_MS);
    assert.equal(calls, 1, "no lookup after the disconnect");
    assert.deepEqual(emitted, [SOCKET_ROOMS_JOIN_FAILED_EVENT]);
    assert.equal(vi.getTimerCount(), 0, "no timer left behind");
  } finally {
    vi.useRealTimers();
  }
});

test("member room join stops quietly when the socket left during the lookup", async () => {
  const left = fakeMemberSocket();
  const result = await joinMemberConversationRooms(left.socket, async () => {
    left.socket.connected = false;
    return [{ id: "c1" }];
  });
  assert.equal(result, "gone");
  assert.deepEqual(left.joined, []);
  assert.deepEqual(left.emitted, []);
});
