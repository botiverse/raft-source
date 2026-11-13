import assert from "node:assert/strict";
import { once } from "node:events";
import { sql } from "drizzle-orm";
import WebSocket from "ws";
import { createApiTest } from "../test/integration/apiTest";
import { accessTokenForTest } from "../test/integration/credentials";
import { createAgent } from "../services/agentService";
import { addAgent } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { __setExternalAgentInboxChainSelectorForTests } from "../services/messageService";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";

// messages.insert_xid (the inserting transaction id, sync horizon only) is
// left out of the drizzle table so no message row can carry it
// (messagesInsertXidMigration.test.ts pins that). This proves it end to end
// on the surfaces that serialize message rows: the send response, the
// socket message:new payload, the channel page, /messages/sync and the
// agent-api /events drain.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// CI has no RisingWave: the external agent inbox pull reads the reference chain.
__setExternalAgentInboxChainSelectorForTests(async (agentId: string) => ({ source: "chain", rows: await referenceAgentInboxChain(agentId) }));

const LEAK = /insert_?xid/i;

function assertNoInsertXid(surface: string, text: string, messageId: string) {
  assert.ok(text.includes(messageId), `${surface} must carry the message to examine: ${text.slice(0, 300)}`);
  assert.doesNotMatch(text, LEAK, `${surface} must not carry the inserting transaction id`);
}

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

test("insert_xid reaches no send response, socket message:new, channel page, /messages/sync or agent /events", async ({ app, seed, db, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const agent = await createAgent(server.id, "InsertXidLeakExt", { runtime: "external", model: "external" });
  await addAgent(channel.id, agent.id);
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "insert-xid-leak", issuedVia: "computer", createdByUserId: null });
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const client = http.as(owner, server);

  const token = await accessTokenForTest(owner.id);
  const ws = new WebSocket(`${app.baseUrl.replace("http:", "ws:")}/socket.io/?EIO=4&transport=websocket`);
  const packets: string[] = [];
  ws.on("message", (data) => {
    const p = data.toString();
    packets.push(p);
    if (p.startsWith("0")) ws.send(`40${JSON.stringify({ token, serverId: server.id })}`);
    if (p === "2") ws.send("3");
  });
  try {
    await waitPacket(ws, packets, (p) => p.includes('"rooms:joined"'), "rooms:joined");

    const sent = await client.request("/api/v2/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: channel.id, content: "insert xid leak probe" }),
    });
    const sentText = await sent.text();
    assert.equal(sent.status, 200, sentText);
    const messageId = (JSON.parse(sentText) as { message: { id: string } }).message.id;
    assertNoInsertXid("send response", sentText, messageId);

    // The row really has one (the trigger), so absence above is the projection, not a NULL.
    const stored = await db.execute(sql`SELECT insert_xid::text AS xid FROM messages WHERE id = ${messageId}`);
    assert.match(String((stored.rows[0] as { xid: unknown }).xid), /^[0-9]+$/);

    const pushed = await waitPacket(ws, packets, (p) => p.includes('"message:new"') && p.includes(messageId), "message:new");
    assertNoInsertXid("socket message:new", pushed, messageId);

    const page = await client.get(`/api/messages/channel/${channel.id}?limit=50`);
    assertNoInsertXid("channel page", await page.text(), messageId);

    for (const query of [`since_seq=0&channel_id=${channel.id}`, `since_seq=0&channel_id=${channel.id}&since_horizon=0`, "since_seq=0"]) {
      const synced = await client.get(`/api/messages/sync?${query}`);
      assert.equal(synced.status, 200);
      assertNoInsertXid(`/messages/sync?${query}`, await synced.text(), messageId);
    }

    const events = await fetch(`${app.baseUrl}/internal/agent-api/events`, { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(events.status, 200);
    assertNoInsertXid("agent-api /events", await events.text(), messageId);
  } finally {
    if (ws.readyState !== WebSocket.CLOSED) {
      const closed = once(ws, "close");
      ws.close();
      await closed;
    }
  }
});
