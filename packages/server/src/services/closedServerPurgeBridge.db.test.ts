// Closed-server purge, the channel step's blockers before messages
// (closedServerPurgeBridgeBlockers.ts): a channel once bound to Slack (its
// binding revoked since, inbound events naming it, a delivery, an attempt
// and a message link on its message) is now cleared and the server purged;
// a kept channel's bridge rows are never touched.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  channels,
  externalChannelBindings,
  externalDeliveryAttempts,
  externalDeliveryPartitions,
  externalInboundEvents,
  externalMessageLinks,
  externalOutboundDeliveries,
  jointChannels,
  jointChannelServers,
  messages,
  servers,
} from "../db/schema";
import { close, daysAgo, deleteFor, insertMessage, NOW, run } from "../test/closedServerPurgeFixture";
import type { ClosedServerPurgeGuardReading } from "./closedServerPurge";
import { dbTest as test } from "../test/integration/dbTest";
import { seedSlackCardEditFixture } from "../test/slackCardEditFixture";

const inbound = (fixture: { install: { id: string }; registration: { id: string }; binding: { id: string } }, channelId: string, messageId: string | null) => ({
  provider: "slack" as const, environment: "test", appRegistrationId: fixture.registration.id, installId: fixture.install.id,
  workspaceId: "T_CARD", providerAuthorityId: "T_CARD", providerConversationId: "C_CARD", providerEventId: `Ev${randomUUID()}`,
  bindingId: fixture.binding.id, bindingEpoch: 1, connectionEpoch: 1, runtimeRevision: "runtime-1", raftChannelId: channelId,
  privacyClass: "public" as const, normalizedPayloadDigest: "c".repeat(64), payloadAadPurpose: "external-inbound-normalized-event",
  payloadAadVersion: 1, payloadSchemaVersion: 3,
  // Queued: the sealed payload, kept until it expires (after its receipt: real time); committed: the payload erased, a tombstone.
  ...(messageId
    ? { status: "committed" as const, committedMessageId: messageId, payloadErasedAt: new Date(), payloadTombstoneDigest: "d".repeat(64) }
    : { status: "queued" as const, encryptedPayload: "sealed", envelopeKeyId: "key-1", payloadExpiresAt: new Date(Date.now() + 3_600_000) }),
});

test("a channel once bound to Slack (binding revoked, inbound events, a delivery, its attempt and link) is cleared, and the server purged; a kept channel's bridge rows stay", async ({ seed }) => {
  const db = getDb();
  const fixture = await seedSlackCardEditFixture(db, { providerAppId: `A_PURGE_${randomUUID().slice(0, 8)}` });
  const { server, channel, binding, message, delivery } = fixture;
  // The pair was removed later: the binding stays, revoked (it still refuses the channel's delete).
  await db.update(externalChannelBindings).set({ state: "revoked", stateReason: "provisioning_pair_removed", bindingEpoch: 2 })
    .where(eq(externalChannelBindings.id, binding.id));
  const [committed] = await db.insert(externalInboundEvents).values(inbound(fixture, channel.id, message.id) as typeof externalInboundEvents.$inferInsert).returning();
  await db.insert(externalInboundEvents).values(inbound(fixture, channel.id, null) as typeof externalInboundEvents.$inferInsert);

  // A kept channel (this server's joint projection) with an inbound event of its own.
  const storage = await seed.server({ owner: fixture.owner as never });
  const [canonical] = await db.insert(channels).values({ serverId: storage.id, name: `canonical-${randomUUID().slice(0, 8)}`, type: "joint" }).returning();
  const [projection] = await db.insert(channels).values({ serverId: server.id, name: `joint-${randomUUID().slice(0, 8)}`, type: "joint" }).returning();
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical!.id, createdByServerId: storage.id, createdByUserId: fixture.owner.id }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: joint!.id, serverId: server.id, localChannelId: projection!.id });
  const [keptEvent] = await db.insert(externalInboundEvents).values(inbound(fixture, projection!.id, null) as typeof externalInboundEvents.$inferInsert).returning();

  await close(server.id, daysAgo(40));
  await deleteFor(server.id);
  const entry = (await run({ revokers: { slackInstallToken: async () => ({ kind: "revoked" }) } }))
    .purged.find((purged) => purged.serverId === (server.id as ServerId))!;
  assert.equal(entry.outcome, "done", "no longer blocked");
  assert.equal(entry.counts.channels_bridge_cleared, 1);
  assert.equal(entry.counts.channels_blocked ?? 0, 0);

  assert.equal((await db.select().from(channels).where(eq(channels.id, channel.id))).length, 0, "the bound channel is gone");
  assert.equal((await db.select().from(messages).where(eq(messages.id, message.id))).length, 0);
  assert.equal((await db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, delivery.id))).length, 0);
  assert.equal((await db.select().from(externalDeliveryAttempts).where(eq(externalDeliveryAttempts.deliveryId, delivery.id))).length, 0);
  assert.equal((await db.select().from(externalMessageLinks).where(eq(externalMessageLinks.raftMessageId, message.id))).length, 0);
  assert.equal((await db.select().from(externalInboundEvents).where(eq(externalInboundEvents.raftChannelId, channel.id))).length, 0);
  assert.equal((await db.select().from(externalInboundEvents).where(eq(externalInboundEvents.id, committed!.id))).length, 0);
  assert.equal((await db.select().from(externalChannelBindings).where(eq(externalChannelBindings.channelId, channel.id))).length, 0, "the revoked binding too");

  assert.equal((await db.select().from(channels).where(eq(channels.id, projection!.id))).length, 1, "the kept channel stays");
  assert.equal((await db.select().from(externalInboundEvents).where(inArray(externalInboundEvents.id, [keptEvent!.id]))).length, 1, "and its bridge rows");
  const [row] = await db.select({ state: servers.purgeState }).from(servers).where(eq(servers.id, server.id));
  assert.equal(row!.state, "done");
});

/** `count` more queued deliveries of new messages in the channel on the binding's partition `epoch`, its tail moved with them. */
async function addDeliveries(fixture: Awaited<ReturnType<typeof seedSlackCardEditFixture>>, epoch: number, count: number, from: number) {
  const db = getDb();
  const added: Array<Awaited<ReturnType<typeof insertMessage>>> = [];
  for (let position = from; position < from + count; position++) added.push(await insertMessage(fixture.channel.id, fixture.owner.id, `bridged ${epoch}.${position}`));
  // The partition tail is checked against its deliveries at commit: write both together.
  await db.transaction(async (tx) => {
    for (const [index, message] of added.entries()) {
      await tx.insert(externalOutboundDeliveries).values({
        sourceMessageId: message.id, bindingId: fixture.binding.id, bindingEpoch: epoch, partitionPosition: from + index,
        enqueueRuntimeRevision: "runtime-card", renderSnapshotSchema: fixture.delivery.renderSnapshotSchema,
        renderSnapshot: fixture.delivery.renderSnapshot, renderSnapshotDigest: "e".repeat(64),
        reconciliationMarker: createHash("sha256").update(message.id).digest("base64url").slice(0, 43), state: "queued",
      });
    }
    await tx.update(externalDeliveryPartitions).set({ lastEnqueuedPosition: from + count - 1 })
      .where(and(eq(externalDeliveryPartitions.bindingId, fixture.binding.id), eq(externalDeliveryPartitions.bindingEpoch, epoch)));
  });
}

test("a large Slack-bound channel is cleared in batches the run's guards stop between, and the next run finishes it; a kept channel's rows stay", async ({ seed }) => {
  const db = getDb();
  const fixture = await seedSlackCardEditFixture(db, { providerAppId: `A_PURGE_${randomUUID().slice(0, 8)}` });
  const { server, channel, binding, message } = fixture;
  // Two partitions: epoch 1 (the fixture's delivery and 4 more), epoch 2 after a rebind (3).
  await addDeliveries(fixture, 1, 4, 2);
  await db.update(externalChannelBindings).set({ bindingEpoch: 2 }).where(eq(externalChannelBindings.id, binding.id));
  await db.insert(externalDeliveryPartitions).values({ bindingId: binding.id, bindingEpoch: 2 });
  await addDeliveries(fixture, 2, 3, 1);
  // 7 inbound events: one committed, 6 queued.
  await db.insert(externalInboundEvents).values(inbound(fixture, channel.id, message.id) as typeof externalInboundEvents.$inferInsert);
  for (let i = 0; i < 6; i++) await db.insert(externalInboundEvents).values(inbound(fixture, channel.id, null) as typeof externalInboundEvents.$inferInsert);

  // A kept channel (this server's joint projection) with inbound events of its own, more than a batch.
  const storage = await seed.server({ owner: fixture.owner as never });
  const [canonical] = await db.insert(channels).values({ serverId: storage.id, name: `canonical-${randomUUID().slice(0, 8)}`, type: "joint" }).returning();
  const [projection] = await db.insert(channels).values({ serverId: server.id, name: `joint-${randomUUID().slice(0, 8)}`, type: "joint" }).returning();
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical!.id, createdByServerId: storage.id, createdByUserId: fixture.owner.id }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: joint!.id, serverId: server.id, localChannelId: projection!.id });
  const keptIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const [row] = await db.insert(externalInboundEvents).values(inbound(fixture, projection!.id, null) as typeof externalInboundEvents.$inferInsert).returning();
    keptIds.push(row!.id);
  }

  const count = async (query: ReturnType<typeof sql>) => Number(((await db.execute(query)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);
  const deliveries = () => count(sql`SELECT count(*)::int AS n FROM external_outbound_deliveries d JOIN messages m ON m.id = d.source_message_id WHERE m.channel_id = ${channel.id}`);
  const partitions = () => count(sql`SELECT count(*)::int AS n FROM external_delivery_partitions WHERE binding_id = ${binding.id}`);
  const events = () => count(sql`SELECT count(*)::int AS n FROM external_inbound_events WHERE raft_channel_id = ${channel.id}`);
  const messagesLeft = () => count(sql`SELECT count(*)::int AS n FROM messages WHERE channel_id = ${channel.id}`);
  const keptLeft = async () => (await db.select().from(externalInboundEvents).where(inArray(externalInboundEvents.id, keptIds))).length;
  assert.equal(await deliveries(), 8);
  assert.equal(await partitions(), 2);
  assert.equal(await events(), 7);
  const messagesBefore = await messagesLeft();

  await close(server.id, daysAgo(40));
  await deleteFor(server.id);
  const revokers = { slackInstallToken: async () => ({ kind: "revoked" as const }) };
  const entryOf = (result: Awaited<ReturnType<typeof run>>) => result.purged.find((purged) => purged.serverId === (server.id as ServerId))!;

  // The run's row cap, already spent: the bridge clearing doesn't start.
  const capped = await run({ revokers, messageCap: 0, bridgeRowBatch: 2 });
  assert.equal(capped.stoppedReason, "message_cap");
  assert.equal(entryOf(capped).outcome, "stopped");
  assert.equal(await deliveries(), 8);
  assert.equal(await events(), 7);

  // The guards, read before every batch, stop the run halfway through the inbound events.
  const seenDeliveries = new Set<number>();
  let stopped = false;
  const readGuards = async (): Promise<ClosedServerPurgeGuardReading> => {
    seenDeliveries.add(await deliveries());
    const left = await events();
    if (!stopped && left > 0 && left < 7) {
      stopped = true;
      return { slot: null, rwOverloadedRecently: true };
    }
    return { slot: null, rwOverloadedRecently: false };
  };
  const first = await run({ revokers, readGuards, bridgeRowBatch: 2 });
  assert.equal(first.stoppedReason, "rw_overloaded");
  const partial = entryOf(first);
  assert.equal(partial.outcome, "stopped");
  assert.equal(partial.counts.bridge_external_outbound_deliveries_deleted, 8, "every delivery");
  assert.equal(partial.counts.bridge_external_delivery_partitions_deleted, 2, "with its partition");
  assert.ok([...seenDeliveries].every((n) => [8, 5, 3, 0].includes(n)), `a partition's deliveries go together, never part of them: ${[...seenDeliveries]}`);
  assert.ok(seenDeliveries.has(5) || seenDeliveries.has(3), "one partition a batch");
  assert.equal(partial.counts.bridge_external_inbound_events_deleted, 2, "one batch of 2 inbound events, then the stop");
  // Consistent where it stopped: what is left is still found from the channel; nothing past the stop touched.
  assert.equal(await deliveries(), 0);
  assert.equal(await partitions(), 0);
  assert.equal(await events(), 5);
  assert.equal((await db.select().from(externalChannelBindings).where(eq(externalChannelBindings.id, binding.id))).length, 1, "the binding goes last");
  assert.equal(await messagesLeft(), messagesBefore, "the messages wait for their blockers");
  assert.equal((await db.select().from(channels).where(eq(channels.id, channel.id))).length, 1);
  const [middle] = await db.select({ state: servers.purgeState }).from(servers).where(eq(servers.id, server.id));
  assert.equal(middle!.state, "channels");
  assert.equal(await keptLeft(), 3, "the kept channel's rows untouched");

  const second = await run({ revokers, bridgeRowBatch: 2 });
  const done = entryOf(second);
  assert.equal(done.outcome, "done");
  assert.equal(done.counts.bridge_external_inbound_events_deleted, 5, "the rest, each once");
  assert.equal(done.counts.bridge_external_outbound_deliveries_deleted ?? 0, 0);
  assert.equal(done.counts.bridge_external_channel_bindings_deleted, 1);
  assert.equal(await events(), 0);
  assert.equal((await db.select().from(channels).where(eq(channels.id, channel.id))).length, 0, "the bound channel is gone");
  assert.equal((await db.select().from(channels).where(eq(channels.id, projection!.id))).length, 1, "the kept channel stays");
  assert.equal(await keptLeft(), 3, "and its bridge rows");
});
