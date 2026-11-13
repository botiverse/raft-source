import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createApiTest } from "../test/integration/apiTest";
import { seedThreadFixture } from "./channels.api.fixtures";

const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client");
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const waitEvent = (socket: any, event: string, timeoutMs = 4_000) => new Promise<any>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no ${event}`)), timeoutMs);
  socket.once(event, (value: any) => { clearTimeout(timer); resolve(value); });
});

// Thread rooms are never joined at connect (`rooms:joined` covers listable
// channels only), so a client that must know it receives every later reply waits
// for this per-join ack. The ack has to follow the actual room join.
test("join:channel acks a granted join with channel:joined after the socket is in the room", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const socket = clientIo(app.baseUrl, { auth: { token: f.ownerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  try {
    const ready = waitEvent(socket, "rooms:joined"); socket.connect(); await ready;
    const serverSocket = app.io.sockets.sockets.get(socket.id)!;
    assert.equal(serverSocket.rooms.has(`channel:${f.threadId}`), false, "thread rooms are not joined at connect");
    // The negative wait is armed only after the real ack, so a slow access check
    // cannot leave an unobserved rejected promise behind.
    const ack = waitEvent(socket, "channel:joined");
    socket.emit("join:channel", f.threadId);
    assert.deepEqual(await ack, { channelId: f.threadId });
    assert.equal(serverSocket.rooms.has(`channel:${f.threadId}`), true, "ack must follow the room join");
    await assert.rejects(waitEvent(socket, "channel:join_denied", 300), /no channel:join_denied/);
  } finally { socket.disconnect(); }
});

test("join:channel answers a refused join with channel:join_denied and joins nothing", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const socket = clientIo(app.baseUrl, { auth: { token: f.ownerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  try {
    const ready = waitEvent(socket, "rooms:joined"); socket.connect(); await ready;
    const serverSocket = app.io.sockets.sockets.get(socket.id)!;
    const missing = randomUUID();
    const denied = waitEvent(socket, "channel:join_denied");
    socket.emit("join:channel", missing);
    assert.deepEqual(await denied, { channelId: missing });
    assert.equal(serverSocket.rooms.has(`channel:${missing}`), false);
    await assert.rejects(waitEvent(socket, "channel:joined", 300), /no channel:joined/);
  } finally { socket.disconnect(); }
});

test("join:channel without a string id sends no ack", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const socket = clientIo(app.baseUrl, { auth: { token: f.ownerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  try {
    const ready = waitEvent(socket, "rooms:joined"); socket.connect(); await ready;
    const outcomes = Promise.all([
      assert.rejects(waitEvent(socket, "channel:joined", 300), /no channel:joined/),
      assert.rejects(waitEvent(socket, "channel:join_denied", 300), /no channel:join_denied/),
    ]);
    socket.emit("join:channel", { not: "a string" });
    await outcomes;
  } finally { socket.disconnect(); }
});
