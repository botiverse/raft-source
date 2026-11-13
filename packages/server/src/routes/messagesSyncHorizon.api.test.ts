import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import WebSocket from "ws";
import { createApiTest } from "../test/integration/apiTest";
import { accessTokenForTest } from "../test/integration/credentials";
import type { Database } from "../db/index";
import { getWebCorsOrigins } from "../config/appUrl";
import { __setSyncLateCapForTests, SYNC_HORIZON_HEADER, SYNC_HORIZON_RESET_HEADER } from "../services/syncHorizon";
import { getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";

// Sync horizon (services/syncHorizon.ts). PGlite runs one transaction at a
// time, so an out-of-order commit is modelled the way it happens in
// production: the seq is allocated first (nextval, as a long transaction's
// INSERT does), the row is written after a reader already passed that seq.
// The in-flight case with two real connections is syncHorizon.realPg.test.ts.

const test = createApiTest();

type Db = Database;

async function reserveSeq(db: Db): Promise<number> {
  const result = await db.execute(sql`SELECT nextval(pg_get_serial_sequence('messages', 'seq')) AS seq`);
  return Number((result.rows[0] as { seq: unknown }).seq);
}

/** A message whose seq was allocated earlier; the writer also tries to choose its insert_xid (the trigger overwrites it). */
async function insertLate(db: Db, input: { seq: number; channelId: string; senderId: string; content: string }) {
  // insert_xid is not in the drizzle table on purpose (schema.ts): raw SQL.
  const result = await db.execute(sql`
    INSERT INTO messages (id, seq, channel_id, sender_type, sender_id, content, insert_xid)
    VALUES (${randomUUID()}, ${input.seq}, ${input.channelId}, 'user', ${input.senderId}, ${input.content}, '1'::xid8)
    RETURNING id, seq, insert_xid::text AS "insertXid"
  `);
  const row = result.rows[0] as { id: string; seq: unknown; insertXid: string | null };
  return { id: row.id, seq: Number(row.seq), insertXid: row.insertXid };
}

type SyncedMessage = { id: string; seq: number; content: string; channelId: string };

test("GET /messages/sync: bare array body, X-Sync-Horizon header, late rows with since_horizon, old requests unchanged", async ({ app, seed, db, http }) => {
  const owner = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [outsider] });
  const channel = await seed.channel({ server, members: [owner, outsider] });
  const hidden = await seed.channel({ server, members: [owner], visibility: "private" });
  const client = http.as(outsider, server);

  const m0 = await seed.message({ channel, author: owner, content: "m0" });
  // Two long transactions took their seqs before B, and commit after the first read.
  const lateSeqA = await reserveSeq(db);
  const lateSeqHidden = await reserveSeq(db);
  const b = await seed.message({ channel, author: owner, content: "b" });

  const sync = async (query: string) => {
    const res = await client.get(`/api/messages/sync?${query}`);
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as SyncedMessage[];
    assert.ok(Array.isArray(body), "the body stays a bare Message[]");
    const horizon = res.headers.get(SYNC_HORIZON_HEADER);
    assert.match(horizon ?? "", /^(0|[1-9][0-9]*)$/, "every response carries the horizon");
    return { body, horizon: horizon!, reset: res.headers.get(SYNC_HORIZON_RESET_HEADER) };
  };

  // Round 1, first page. A client that has no horizon yet sends since_horizon=0.
  const round1 = await sync(`since_seq=0&channel_id=${channel.id}&since_horizon=0`);
  assert.deepEqual(round1.body.map((m) => m.id), [m0.id, b.id]);
  assert.equal(round1.reset, null);
  // An old-style request returns exactly the same rows.
  const old1 = await sync(`since_seq=0&channel_id=${channel.id}`);
  assert.deepEqual(old1.body.map((m) => m.id), [m0.id, b.id]);

  // The long transactions commit now: their seqs are below the client's cursor (b.seq).
  const a = await insertLate(db, { seq: lateSeqA, channelId: channel.id, senderId: owner.id, content: "a (late)" });
  await insertLate(db, { seq: lateSeqHidden, channelId: hidden.id, senderId: owner.id, content: "hidden (late)" });
  assert.notEqual(a.insertXid, "1", "the trigger overwrote the caller's insert_xid");
  assert.ok(BigInt(a.insertXid!) >= BigInt(round1.horizon), "a finished after round 1's horizon");
  const c = await seed.message({ channel, author: owner, content: "c" });

  // Round 2 sends round 1's horizon: the late row, then the page, ordered by seq.
  const round2 = await sync(`since_seq=${b.seq}&channel_id=${channel.id}&since_horizon=${round1.horizon}`);
  assert.deepEqual(round2.body.map((m) => m.id), [a.id, c.id]);
  assert.ok(round2.body[0]!.seq < b.seq && round2.body[1]!.seq > b.seq);
  assert.ok(BigInt(round2.horizon) > BigInt(round1.horizon));
  // Server-wide sync applies the same visibility to late rows: the private channel's row stays out.
  const serverWide = await sync(`since_seq=${b.seq}&since_horizon=${round1.horizon}`);
  assert.deepEqual(serverWide.body.map((m) => m.content), ["a (late)", "c"]);
  // A request without since_horizon is the pre-horizon behaviour: the late row is not returned
  // (the known old-client gap this horizon closes).
  const old2 = await sync(`since_seq=${b.seq}&channel_id=${channel.id}`);
  assert.deepEqual(old2.body.map((m) => m.id), [c.id]);
  // Round 3 with round 2's horizon: nothing finished since, so no late rows.
  const round3 = await sync(`since_seq=${c.seq}&channel_id=${channel.id}&since_horizon=${round2.horizon}`);
  assert.deepEqual(round3.body, []);
  // The owner (a member of the private channel) does get its late row.
  const ownerWide = await http.as(owner, server).get(`/api/messages/sync?since_seq=${b.seq}&since_horizon=${round1.horizon}`);
  assert.deepEqual((await ownerWide.json() as SyncedMessage[]).map((m) => m.content), ["a (late)", "hidden (late)", "c"]);

  // The web client is cross-origin: the horizon headers must be readable by its script.
  const origin = getWebCorsOrigins()[0];
  assert.ok(origin);
  const cors = await fetch(`${app.baseUrl}/api/messages/sync?since_seq=0&channel_id=${channel.id}`, {
    headers: { Authorization: `Bearer ${await accessTokenForTest(outsider.id)}`, "X-Server-Id": server.id, Origin: origin },
  });
  assert.equal(cors.status, 200);
  const exposed = (cors.headers.get("access-control-expose-headers") ?? "").toLowerCase().split(/\s*,\s*/);
  assert.ok(exposed.includes(SYNC_HORIZON_HEADER.toLowerCase()), `exposed: ${exposed.join(",")}`);
  assert.ok(exposed.includes(SYNC_HORIZON_RESET_HEADER.toLowerCase()));
});

test("GET /messages/sync rejects a since_horizon that is not a decimal xid8", async ({ seed, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const client = http.as(owner, server);
  for (const bad of ["", "-1", "01", "1.5", "abc", "18446744073709551616", "1&since_horizon=2"]) {
    const res = await client.get(`/api/messages/sync?since_seq=0&channel_id=${channel.id}&since_horizon=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, bad);
    assert.deepEqual(await res.json(), {
      error: "since_horizon must be the decimal string of a non-negative 64-bit transaction id",
      code: "invalid_since_horizon",
    });
  }
  // A repeated parameter arrives as an array: refused too.
  const repeated = await client.get(`/api/messages/sync?since_seq=0&channel_id=${channel.id}&since_horizon=1&since_horizon=2`);
  assert.equal(repeated.status, 400);
});

test("more late rows than the cap: none of them, X-Sync-Horizon-Reset: 1, the normal page still returned", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const client = http.as(owner, server);
  const seqs = [await reserveSeq(db), await reserveSeq(db), await reserveSeq(db)];
  const b = await seed.message({ channel, author: owner, content: "b" });
  const first = await client.get(`/api/messages/sync?since_seq=0&channel_id=${channel.id}&since_horizon=0`);
  const horizon = first.headers.get(SYNC_HORIZON_HEADER)!;
  for (const [i, seq] of seqs.entries()) {
    await insertLate(db, { seq, channelId: channel.id, senderId: owner.id, content: `late ${i}` });
  }
  const c = await seed.message({ channel, author: owner, content: "c" });

  __setSyncLateCapForTests(2);
  try {
    const capped = await client.get(`/api/messages/sync?since_seq=${b.seq}&channel_id=${channel.id}&since_horizon=${horizon}`);
    assert.equal(capped.status, 200);
    assert.equal(capped.headers.get(SYNC_HORIZON_RESET_HEADER), "1");
    assert.match(capped.headers.get(SYNC_HORIZON_HEADER) ?? "", /^[0-9]+$/);
    assert.deepEqual((await capped.json() as SyncedMessage[]).map((m) => m.id), [c.id]);

    // Exactly at the cap: every late row, no reset.
    __setSyncLateCapForTests(3);
    const atCap = await client.get(`/api/messages/sync?since_seq=${b.seq}&channel_id=${channel.id}&since_horizon=${horizon}`);
    assert.equal(atCap.headers.get(SYNC_HORIZON_RESET_HEADER), null);
    assert.deepEqual((await atCap.json() as SyncedMessage[]).map((m) => m.content), ["late 0", "late 1", "late 2", "c"]);
  } finally {
    __setSyncLateCapForTests(null);
  }
});

function waitPacket(ws: WebSocket, packets: string[], predicate: (p: string) => boolean, label: string) {
  if (packets.some(predicate)) return Promise.resolve(packets.find(predicate)!);
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error(`No packet: ${label}`)); }, 8000);
    function clean() { clearTimeout(timer); ws.off("message", onMessage); ws.off("close", onClose); }
    function onMessage(data: WebSocket.RawData) { const p = data.toString(); if (predicate(p)) { clean(); resolve(p); } }
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
    if (p === "2") ws.send("3");
  });
  return { ws, packets };
}

async function closeSocket(ws: WebSocket) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, "close");
  ws.close();
  await closed;
}

type ResumeResponse = {
  messages: SyncedMessage[];
  currentSeq: number;
  hasMore: boolean;
  horizon: string;
  horizonReset: boolean;
};

test("socket sync:resume carries horizon / late messages / horizonReset; sync:horizon acks the horizon", async ({ app, seed, db }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const m0 = await seed.message({ channel, author: owner, content: "m0" });
  const lateSeq = await reserveSeq(db);
  const b = await seed.message({ channel, author: owner, content: "b" });

  const { ws, packets } = rawSocket(app.baseUrl, { token: await accessTokenForTest(owner.id), serverId: server.id });
  let resumes = 0;
  const resume = async (payload: Record<string, unknown>) => {
    const before = packets.filter((p) => p.includes('"sync:resume:response"')).length;
    ws.send(`42${JSON.stringify(["sync:resume", payload])}`);
    resumes += 1;
    const label = `resume ${resumes}`;
    await waitPacket(ws, packets, () => packets.filter((p) => p.includes('"sync:resume:response"')).length > before, label);
    const response = packets.filter((p) => p.includes('"sync:resume:response"'))[before]!;
    return JSON.parse(response.slice(2))[1] as ResumeResponse;
  };
  let ackId = 0;
  const askHorizon = async (...args: unknown[]) => {
    ackId += 1;
    ws.send(`42${ackId}${JSON.stringify(["sync:horizon", ...args])}`);
    const packet = await waitPacket(ws, packets, (p) => p.startsWith(`43${ackId}[`), `ack ${ackId}`);
    return JSON.parse(packet.slice(`43${ackId}`.length))[0] as { horizon?: string; error?: string };
  };

  try {
    await waitPacket(ws, packets, (p) => p.includes('"rooms:joined"'), "rooms:joined");

    // sync:horizon: the current horizon, with or without a payload before the ack.
    const fresh = await askHorizon();
    assert.match(fresh.horizon ?? "", /^[0-9]+$/);
    assert.deepEqual(Object.keys(fresh), ["horizon"]);
    const withPayload = await askHorizon({});
    assert.ok(BigInt(withPayload.horizon!) >= BigInt(fresh.horizon!));

    // An old client's payload: the old fields, unchanged rows, plus the additive horizon fields.
    const old = await resume({ lastSeq: m0.seq });
    assert.deepEqual(old.messages.map((m) => m.id), [b.id]);
    assert.equal(old.currentSeq, b.seq);
    assert.equal(old.hasMore, false);
    assert.match(old.horizon, /^[0-9]+$/);
    assert.equal(old.horizonReset, false);

    // A late message commits below the cursor (b.seq).
    const a = await insertLate(db, { seq: lateSeq, channelId: channel.id, senderId: owner.id, content: "a (late)" });

    // With sinceHorizon: the late message, the cursor stays at b.seq (late seqs are below it).
    const late = await resume({ lastSeq: b.seq, sinceHorizon: old.horizon });
    assert.deepEqual(late.messages.map((m) => m.id), [a.id]);
    assert.equal(late.currentSeq, b.seq, "late messages never move the cursor back");
    assert.equal(late.hasMore, false);
    assert.equal(late.horizonReset, false);

    // An invalid sinceHorizon is ignored: the resume runs as an old one (no late messages).
    const ignored = await resume({ lastSeq: b.seq, sinceHorizon: "not-a-horizon" });
    assert.deepEqual(ignored.messages, []);
    assert.equal(ignored.currentSeq, b.seq);
    const numeric = await resume({ lastSeq: b.seq, sinceHorizon: Number(old.horizon) });
    assert.deepEqual(numeric.messages, [], "a number is not a horizon (precision): ignored");

    // Over the cap: no late messages, horizonReset: true.
    __setSyncLateCapForTests(0);
    try {
      const reset = await resume({ lastSeq: b.seq, sinceHorizon: old.horizon });
      assert.deepEqual(reset.messages, []);
      assert.equal(reset.horizonReset, true);
      assert.equal(reset.currentSeq, b.seq);
    } finally {
      __setSyncLateCapForTests(null);
    }
  } finally {
    await closeSocket(ws);
  }
});

test("socket sync:resume on a Free server leaves out what the plan's history window hides; Pro replays it", async ({ app, seed, db }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const first = await seed.message({ channel, author: owner, content: "first, still in the window" });
  const old = await seed.message({ channel, author: owner, content: "older than the window" });
  const recent = await seed.message({ channel, author: owner, content: "inside the window" });
  await db.execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${old.id}::uuid`);

  const { ws, packets } = rawSocket(app.baseUrl, { token: await accessTokenForTest(owner.id), serverId: server.id });
  let resumes = 0;
  const resume = async (lastSeq: number) => {
    const before = packets.filter((p) => p.includes('"sync:resume:response"')).length;
    ws.send(`42${JSON.stringify(["sync:resume", { lastSeq }])}`);
    resumes += 1;
    await waitPacket(ws, packets, () => packets.filter((p) => p.includes('"sync:resume:response"')).length > before, `resume ${resumes}`);
    return JSON.parse(packets.filter((p) => p.includes('"sync:resume:response"'))[before]!.slice(2))[1] as ResumeResponse;
  };

  try {
    await waitPacket(ws, packets, (p) => p.includes('"rooms:joined"'), "rooms:joined");

    const free = await resume(first.seq);
    assert.deepEqual(free.messages.map((m) => m.id), [recent.id], "the replay skips the message behind the window");
    assert.equal(free.currentSeq, recent.seq);

    await db.execute(sql`UPDATE servers SET plan = 'pro' WHERE id = ${server.id}::uuid`);
    const pro = await resume(first.seq);
    assert.deepEqual(pro.messages.map((m) => m.id), [old.id, recent.id]);
  } finally {
    await closeSocket(ws);
  }
});

test("socket sync:resume: every replayed message carries the conversationContext its message:new carried", async ({ app, seed, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const client = http.as(owner, server);
  const dmRes = await client.request("/api/channels/dm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: peer.id }) });
  assert.equal(dmRes.status, 200, await dmRes.clone().text());
  const dm = await dmRes.json() as { id: string };

  const sentinel = await seed.message({ channel, author: owner, content: "sentinel" });
  const channelParent = await seed.message({ channel, author: owner, content: "channel parent" });
  const dmParent = await createMessage(dm.id, "user", owner.id, "dm parent");
  const channelThread = await getOrCreateThread(channelParent.id, owner.id, "user");
  const dmThread = await getOrCreateThread(dmParent.id, owner.id, "user");

  const { ws, packets } = rawSocket(app.baseUrl, { token: await accessTokenForTest(owner.id), serverId: server.id });
  try {
    await waitPacket(ws, packets, (p) => p.includes('"rooms:joined"'), "rooms:joined");
    // A public channel's thread broadcasts to its room; a DM's thread to its followers.
    ws.send(`42${JSON.stringify(["join:channel", channelThread.id])}`);
    await waitPacket(ws, packets, (p) => p.includes('"channel:joined"') && p.includes(channelThread.id), "thread room joined");

    const sends = [
      [channel.id, "resume-ctx channel"],
      [dm.id, "resume-ctx dm"],
      [channelThread.id, "resume-ctx channel thread"],
      [dmThread.id, "resume-ctx dm thread"],
    ] as const;
    const live = new Map<string, { channelId: string; conversationContext: unknown }>();
    for (const [channelId, content] of sends) {
      const res = await client.request("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId, content }) });
      assert.equal(res.status, 200, `${content}: ${await res.clone().text()}`);
      const packet = await waitPacket(ws, packets, (p) => p.startsWith('42["message:new"') && p.includes(`"${content}"`), `message:new ${content}`);
      live.set(content, JSON.parse(packet.slice(2))[1]);
    }

    ws.send(`42${JSON.stringify(["sync:resume", { lastSeq: sentinel.seq }])}`);
    const response = JSON.parse((await waitPacket(ws, packets, (p) => p.includes('"sync:resume:response"'), "resume")).slice(2))[1] as {
      messages: Array<SyncedMessage & { conversationContext?: unknown }>;
    };
    const replayed = new Map(response.messages.map((m) => [m.content, m]));

    for (const [, content] of sends) {
      const resumed = replayed.get(content);
      assert.ok(resumed, `${content} is replayed: ${JSON.stringify([...replayed.keys()])}`);
      assert.equal(resumed.channelId, live.get(content)!.channelId);
      assert.deepEqual(resumed.conversationContext, live.get(content)!.conversationContext, content);
    }
    // The broadcast's contexts, spelled out: a thread names its parent and the parent's channel.
    assert.deepEqual(replayed.get("resume-ctx channel")!.conversationContext, { channelType: "channel" });
    assert.deepEqual(replayed.get("resume-ctx dm")!.conversationContext, { channelType: "dm" });
    assert.deepEqual(replayed.get("resume-ctx channel thread")!.conversationContext, {
      channelType: "thread", parentMessageId: channelParent.id, parentChannelId: channel.id, parentChannelType: "channel",
    });
    assert.deepEqual(replayed.get("resume-ctx dm thread")!.conversationContext, {
      channelType: "thread", parentMessageId: dmParent.id, parentChannelId: dm.id, parentChannelType: "dm",
    });
    // Rows written without a broadcast (the parents) carry it too.
    assert.deepEqual(replayed.get("channel parent")!.conversationContext, { channelType: "channel" });
    assert.deepEqual(replayed.get("dm parent")!.conversationContext, { channelType: "dm" });
  } finally {
    await closeSocket(ws);
  }
});

test("GET /messages/channel/:id: the latest page reports a horizon a first sync round can start from; other pages do not", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const client = http.as(owner, server);

  await seed.message({ channel, author: owner, content: "m0" });
  // A long transaction took its seq before B, and commits after the page is read.
  const lateSeq = await reserveSeq(db);
  const b = await seed.message({ channel, author: owner, content: "b" });

  const latest = await client.get(`/api/messages/channel/${channel.id}?limit=50`);
  assert.equal(latest.status, 200, await latest.clone().text());
  const horizon = latest.headers.get(SYNC_HORIZON_HEADER);
  assert.match(horizon ?? "", /^(0|[1-9][0-9]*)$/, "the latest page carries the horizon");
  const page = await latest.json() as { messages: SyncedMessage[] };
  assert.ok(page.messages.some((m) => m.id === b.id));

  const older = await client.get(`/api/messages/channel/${channel.id}?limit=50&before=${b.seq}`);
  assert.equal(older.status, 200);
  assert.equal(older.headers.get(SYNC_HORIZON_HEADER), null, "only the latest page");

  // The late row commits now, below the page's newest seq: a sync round from the page's horizon returns it.
  const late = await insertLate(db, { seq: lateSeq, channelId: channel.id, senderId: owner.id, content: "late" });
  const sync = await client.get(`/api/messages/sync?since_seq=${b.seq}&channel_id=${channel.id}&since_horizon=${horizon}`);
  assert.equal(sync.status, 200);
  const synced = await sync.json() as SyncedMessage[];
  assert.ok(synced.some((m) => m.id === late.id), "the late row is caught up from the page's horizon");
});
