// A hostile custom Socket.IO client tries to subscribe to and replay
// conversations it must not see (another pair's DM, a private channel it is
// not in, and a channel in a server it is not a member of), then checks the
// push recipient ledger for the same messages. The DM case pins the send-time
// `socketsJoin` audience: Socket.IO `in(a).in(b)` is a union, so targeting
// `user:` and `server:` rooms together used to pull every socket in the server
// into the DM room.
import assert from "node:assert/strict";
import { once } from "node:events";
import { and, eq } from "drizzle-orm";
import WebSocket from "ws";
import { createApiTest } from "../test/integration/apiTest.js";
import { signAccessToken } from "../middleware/auth.js";
import { inboxNotificationFacts, pushRegistrations } from "../db/schema.js";

const test = createApiTest({ onboardingOpenerFlagDefaultEnabled: false });

function waitPacket(ws: WebSocket, packets: string[], predicate: (p: string) => boolean, label: string) {
  if (packets.some(predicate)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error(`No packet: ${label}`)); }, 8000);
    function clean() { clearTimeout(timer); ws.off("message", onMessage); ws.off("close", onClose); }
    function onMessage(data: WebSocket.RawData) { if (predicate(data.toString())) { clean(); resolve(); } }
    function onClose() { clean(); reject(new Error(`Socket closed before: ${label}`)); }
    ws.on("message", onMessage);
    ws.on("close", onClose);
  });
}

function rawSocket(base: string, auth: Record<string, unknown>) {
  const ws = new WebSocket(`${base.replace("http:", "ws:")}/socket.io/?EIO=4&transport=websocket`);
  const packets: string[] = [];
  ws.on("message", (data) => {
    const p = data.toString();
    packets.push(p);
    if (p.startsWith("0")) ws.send(`40${JSON.stringify(auth)}`);
  });
  return { ws, packets };
}

async function closeSocket(ws: WebSocket) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, "close");
  ws.close();
  await closed;
}

const json = { "Content-Type": "application/json" };

test("hostile custom client cannot subscribe to, replay, or be push-targeted for foreign conversations", async ({ app, seed, db, http }) => {
  const victimA = await seed.human();
  const victimB = await seed.human();
  const attacker = await seed.human();
  const s1 = await seed.server({ owner: victimA, members: [victimB, attacker] });
  const s2 = await seed.server({ owner: victimA, members: [victimB] });

  const publicS1 = await seed.channel({ server: s1, members: [victimA, victimB, attacker] });
  const sentinel = await seed.message({ channel: publicS1, author: victimA, content: "sentinel-before-cursor" });
  const privateS1 = await seed.channel({ server: s1, members: [victimA, victimB], visibility: "private" });
  const publicS2 = await seed.channel({ server: s2, members: [victimA, victimB] });
  const dmRes = await http.as(victimA, s1).request("/api/channels/dm", { method: "POST", headers: json, body: JSON.stringify({ userId: victimB.id }) });
  assert.equal(dmRes.status, 200, await dmRes.clone().text());
  const dm = await dmRes.json() as { id: string };

  // Attacker registers a mobile push device with a real login session so the
  // registration carries a session family, exactly like the iOS app would.
  const login = await fetch(`${app.baseUrl}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ email: attacker.email, password: "password123" }) });
  assert.equal(login.status, 200, await login.clone().text());
  const { accessToken } = await login.json() as { accessToken: string };
  const reg = await fetch(`${app.baseUrl}/api/push/registrations`, {
    method: "POST",
    headers: { ...json, Authorization: `Bearer ${accessToken}`, "X-Server-Id": s1.id },
    body: JSON.stringify({ installationId: "attacker-install", provider: "apns", env: "production", topic: "ai.slock.app", deviceToken: "attacker-token" }),
  });
  assert.equal(reg.status, 200, await reg.clone().text());

  // 1. Handshake against a server the attacker is not a member of is refused.
  {
    const { ws, packets } = rawSocket(app.baseUrl, { token: signAccessToken(attacker.id), serverId: s2.id });
    try {
      await waitPacket(ws, packets, (p) => p.startsWith("44") || p.startsWith("40"), "handshake result");
      const denied = packets.find((p) => p.startsWith("44"));
      assert.ok(denied, `expected CONNECT_ERROR, got ${JSON.stringify(packets)}`);
      assert.match(denied, /Not a member of this server/);
      assert.equal(packets.some((p) => p.startsWith("40")), false);
    } finally { await closeSocket(ws); }
  }

  // 2. Legit handshake against s1, then hostile join:channel attempts.
  const { ws, packets } = rawSocket(app.baseUrl, { token: signAccessToken(attacker.id), serverId: s1.id, clientKind: "mobile" });
  try {
    await waitPacket(ws, packets, (p) => p.includes('"rooms:joined"'), "rooms:joined");
    const connected = packets.find((p) => p.startsWith("40"))!;
    const socket = app.io.of("/").sockets.get(JSON.parse(connected.slice(2)).sid)!;
    assert.ok(socket);

    const handler = socket.listeners("join:channel")[0] as (...args: unknown[]) => Promise<void>;
    socket.off("join:channel", handler);
    let pending = 0; let release!: () => void;
    const allJoined = new Promise<void>((r) => { release = r; });
    socket.on("join:channel", async (...args: unknown[]) => {
      try { await handler(...args); } finally { if (--pending === 0) release(); }
    });
    const hostileTargets = [privateS1.id, dm.id, publicS2.id, "not-a-uuid"];
    pending = hostileTargets.length;
    for (const id of hostileTargets) ws.send(`42${JSON.stringify(["join:channel", id])}`);
    await allJoined;

    const rooms = [...socket.rooms];
    assert.ok(rooms.includes(`channel:${publicS1.id}`), "control: public channel room joined");
    for (const id of [privateS1.id, dm.id, publicS2.id]) {
      assert.equal(rooms.includes(`channel:${id}`), false, `attacker must not be in room channel:${id}`);
    }

    // 3. Real sends through the HTTP API by the victims.
    const sends: Array<[typeof victimA, typeof s1, string, string]> = [
      [victimA, s1, privateS1.id, "SECRET-PRIVATE-S1"],
      [victimA, s1, dm.id, "SECRET-DM-A-B"],
      [victimB, s2, publicS2.id, "SECRET-PUBLIC-S2"],
      [victimA, s1, publicS1.id, "CONTROL-PUBLIC-S1"],
    ];
    for (const [author, server, channelId, content] of sends) {
      const r = await http.as(author, server).request("/api/messages", { method: "POST", headers: json, body: JSON.stringify({ channelId, content }) });
      assert.equal(r.status, 200, `${content}: ${await r.clone().text()}`);
    }
    await waitPacket(ws, packets, (p) => p.includes("CONTROL-PUBLIC-S1"), "control message");
    app.io.to(`user:${attacker.id}`).emit("audit:barrier");
    await waitPacket(ws, packets, (p) => p.includes('"audit:barrier"'), "barrier");
    assert.equal([...socket.rooms].includes(`channel:${dm.id}`), false, "attacker socket was pulled into the DM room by a send-time socketsJoin");
    for (const secret of ["SECRET-PRIVATE-S1", "SECRET-DM-A-B", "SECRET-PUBLIC-S2"]) {
      assert.equal(packets.some((p) => p.includes(secret)), false, `${secret} leaked over socket`);
    }

    // 4. sync:resume replay from before the secrets were written.
    ws.send(`42${JSON.stringify(["sync:resume", { lastSeq: sentinel.seq }])}`);
    await waitPacket(ws, packets, (p) => p.includes('"sync:resume:response"'), "resume response");
    const response = packets.find((p) => p.includes('"sync:resume:response"'))!;
    const contents = (JSON.parse(response.slice(2))[1].messages as Array<{ content: string }>).map((m) => m.content);
    assert.ok(contents.includes("CONTROL-PUBLIC-S1"), `control missing from replay: ${JSON.stringify(contents)}`);
    for (const secret of ["SECRET-PRIVATE-S1", "SECRET-DM-A-B", "SECRET-PUBLIC-S2"]) {
      assert.equal(contents.includes(secret), false, `${secret} leaked via sync:resume`);
    }

    // 5. Push recipient ledger: the attacker is a receiver only for the public s1 message.
    const facts = await db.select({ sourceChannelId: inboxNotificationFacts.sourceChannelId })
      .from(inboxNotificationFacts)
      .where(and(eq(inboxNotificationFacts.receiverType, "user"), eq(inboxNotificationFacts.receiverId, attacker.id)));
    const factChannels = new Set(facts.map((f) => f.sourceChannelId));
    assert.ok(factChannels.has(publicS1.id), "control: attacker is a push receiver for the public channel");
    for (const id of [privateS1.id, dm.id, publicS2.id]) {
      assert.equal(factChannels.has(id), false, `attacker is a push receiver for foreign channel ${id}`);
    }
    const [regRow] = await db.select().from(pushRegistrations).where(eq(pushRegistrations.installationId, "attacker-install"));
    assert.equal(regRow.userId, attacker.id);
  } finally {
    await closeSocket(ws);
  }
});
