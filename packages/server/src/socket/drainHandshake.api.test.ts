import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { WebSocket } from "ws";

import { createApiTest } from "../test/integration/apiTest";
import { seedThreadFixture } from "../routes/channels.api.fixtures";
import { __resetDrainStateForTests, markDraining, setDrainRefusalSink, type DrainRefusalKind } from "../services/drainState";

const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client");
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// Deployment thread 3f292dc3: for a few seconds after a drain starts the ALB
// still routes reconnecting tabs to the draining task. A tab accepted then is
// outside the going-away snapshot and was hard-cut at deregistration expiry,
// so a draining task refuses the Engine.IO handshake with 503 instead.

afterEach(() => {
  __resetDrainStateForTests();
});

function upgradeStatus(baseUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/socket.io/?EIO=4&transport=websocket`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("ws upgrade timeout")); }, 4_000);
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      res.resume();
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.on("open", () => { clearTimeout(timer); ws.close(); resolve(101); });
    ws.on("error", () => {});
  });
}

test("before draining a tab connects; once draining a new handshake gets 503 on polling and on WebSocket", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const socket = clientIo(app.baseUrl, { auth: { token: f.ownerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false, reconnection: false });
  try {
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no connect")), 4_000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
    });
    socket.connect();
    await connected;
    assert.equal(socket.connected, true);
    assert.equal(await upgradeStatus(app.baseUrl), 101, "not draining: the handshake is accepted");

    const refusals: DrainRefusalKind[] = [];
    setDrainRefusalSink((kind) => { refusals.push(kind); });
    markDraining();
    const polling = await fetch(`${app.baseUrl}/socket.io/?EIO=4&transport=polling`);
    assert.equal(polling.status, 503);
    assert.equal(((await polling.json()) as { code?: string }).code, "server_draining");
    assert.equal(await upgradeStatus(app.baseUrl), 503);
    // Both refusals are reported, so they can be counted apart from real 5xx.
    assert.deepEqual(refusals, ["socketio", "socketio"]);
    // A session that already exists is left to the going-away spread.
    assert.equal(socket.connected, true, "the open socket is not closed by the refusal");
  } finally {
    socket.disconnect();
  }
});

test("while draining, repeated reconnect attempts are all refused at the handshake: none connects and is then closed", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  markDraining();
  let serverConnections = 0;
  const onServerConnection = () => { serverConnections += 1; };
  app.io.on("connection", onServerConnection);
  const socket = clientIo(app.baseUrl, {
    auth: { token: f.ownerToken, serverId: f.serverId },
    transports: ["websocket"],
    autoConnect: false,
    reconnectionDelay: 10,
    reconnectionDelayMax: 50,
    randomizationFactor: 0,
  });
  let connects = 0;
  let connectErrors = 0;
  let reconnectAttempts = 0;
  socket.on("connect", () => { connects += 1; });
  socket.on("connect_error", () => { connectErrors += 1; });
  socket.io.on("reconnect_attempt", () => { reconnectAttempts += 1; });
  try {
    socket.connect();
    const deadline = Date.now() + 4_000;
    while (reconnectAttempts < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(reconnectAttempts >= 4, `expected several reconnect attempts, got ${reconnectAttempts}`);
    assert.ok(connectErrors >= reconnectAttempts, `every attempt fails at the handshake (${connectErrors} errors, ${reconnectAttempts} attempts)`);
    assert.equal(connects, 0, "no attempt reaches connected, so the client backoff never resets");
    assert.equal(serverConnections, 0, "the server never accepts a socket it would have to close");
    assert.equal(app.io.of("/").sockets.size, 0);
  } finally {
    socket.disconnect();
    app.io.off("connection", onServerConnection);
  }
});
