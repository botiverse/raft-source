import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgentMessage } from "@botiverse/raft-shared";
import type { Database } from "../db/index";
import { agents, thirdPartyAgentEvents } from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { buildThirdPartyAgentMessage, getAgentInboundOAuthResource } from "./oauthService";
import { createSystemAppAgentEvent, deliverSystemAppAgentEvent, type SystemAppAgentEventDeliverer } from "./systemAppAgentEvents";

async function seedAgent(db: Database, seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `a-${randomUUID().slice(0, 8)}` }).returning();
  return { serverId: server.id, agentId: agent.id };
}

const statusOf = async (db: Database, id: string) =>
  (await db.select({ status: thirdPartyAgentEvents.status }).from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, id)))[0]?.status;

test("createSystemAppAgentEvent writes the queued system row inside the caller's transaction", async ({ db, seed }) => {
  const { serverId, agentId } = await seedAgent(db, seed);
  const now = new Date("2030-01-02T03:04:05.000Z");
  const payload = { type: "synthetic", n: 1 };

  // Rolled back with the caller's transaction.
  await assert.rejects(db.transaction(async (tx) => {
    await createSystemAppAgentEvent({ serverId, agentId, systemApp: "system.raftbench", summary: "rolled back", payload, ttlMs: 1000, now, executor: tx });
    throw new Error("rollback");
  }), /rollback/);
  assert.equal((await db.select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.agentId, agentId))).length, 0);

  const event = await db.transaction((tx) => createSystemAppAgentEvent({
    serverId, agentId, systemApp: "system.assistant", summary: "Synthetic summary", payload, ttlMs: 60 * 60 * 1000, now, executor: tx,
  }));
  const [row] = await db.select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, event.id));
  // The fields the assistant doorbell/brief and RaftBench inserts wrote inline before.
  assert.deepEqual({ ...row }, {
    id: event.id,
    serverId,
    agentId,
    clientId: null,
    systemApp: "system.assistant",
    accessTokenId: null,
    externalEventId: null,
    kind: "event",
    summary: "Synthetic summary",
    payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    resource: getAgentInboundOAuthResource(serverId),
    status: "queued",
    deliveredAt: null,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
    // RFC 081: no object, no related conversation, not consumed yet.
    objectRef: null,
    relatedChannelId: null,
    consumedVia: null,
    // #wg-ax:#24: not added to an unread item without a wake.
    wakeCoalescedAt: null,
  });
  assert.deepEqual(event, row);
});

test("deliverSystemAppAgentEvent claims, delivers once, and releases the claim when the push fails", async ({ db, seed }) => {
  const { serverId, agentId } = await seedAgent(db, seed);
  const delivered: Array<{ agentId: string; message: AgentMessage }> = [];
  const ok: SystemAppAgentEventDeliverer = {
    deliverMessage: async (id: string, message: AgentMessage) => {
      delivered.push({ agentId: id, message });
      return { status: "queued", reason: "direct_dispatch" };
    },
  };

  const event = await createSystemAppAgentEvent({ serverId, agentId, systemApp: "system.assistant", summary: "Deliver me", payload: { a: 1 }, ttlMs: 60_000 });
  assert.equal(await deliverSystemAppAgentEvent({ event, deliverer: ok }), true);
  assert.equal(await statusOf(db, event.id), "delivering");
  assert.deepEqual(delivered, [{
    agentId,
    message: buildThirdPartyAgentMessage({ event, clientKey: "system.assistant", clientName: "system.assistant" }),
  }]);
  // Already claimed: no second push.
  assert.equal(await deliverSystemAppAgentEvent({ event, deliverer: ok }), false);
  assert.equal(delivered.length, 1);

  const failing: SystemAppAgentEventDeliverer = { deliverMessage: async () => { throw new Error("push failed"); } };
  const swallowed = await createSystemAppAgentEvent({ serverId, agentId, systemApp: "system.assistant", summary: "Fail softly", payload: { a: 2 }, ttlMs: 60_000 });
  const errors: unknown[] = [];
  assert.equal(await deliverSystemAppAgentEvent({ event: swallowed, deliverer: failing, onDeliveryError: (err) => errors.push(err) }), false);
  assert.equal(await statusOf(db, swallowed.id), "queued");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /push failed/);

  const thrown = await createSystemAppAgentEvent({ serverId, agentId, systemApp: "system.raftbench", summary: "Fail loudly", payload: { a: 3 }, ttlMs: 60_000 });
  await assert.rejects(deliverSystemAppAgentEvent({ event: thrown, deliverer: failing }), /push failed/);
  assert.equal(await statusOf(db, thrown.id), "queued");
  // Released: the next attempt claims it again.
  assert.equal(await deliverSystemAppAgentEvent({ event: thrown, deliverer: ok }), true);
  assert.equal(delivered.at(-1)?.message.third_party_event?.client_id, "system.raftbench");
});

