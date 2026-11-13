import { enableTestSlackIngress, writeSlackFixture, TEST_SLACK_RELEASE_RECORD } from "../test/integration/slackIngressRollout";
import { readSlackIngressRollout, setSlackIngressConsumption } from "./slackVerifiedIngressRollout";
import assert from "node:assert/strict";
import { vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import { getDb } from "../db/index";
import { channels, externalInboundEvents, messages, slackVerifiedIngressEvents, slackVerifiedIngressPartitions,
  slackVerifiedIngressReplayAudits, users } from "../db/schema";
import { createServer } from "./serverService";
import { enqueueExternalInboundEvent, processExternalInboundEventOnce } from "./externalInboundWorkerService";
import { openSlackVerifiedIngress, sealSlackVerifiedIngress } from "./slackVerifiedIngressCrypto";
import { enqueueSlackVerifiedIngress } from "./slackVerifiedIngressInbox";
import { claimSlackVerifiedIngressHead, claimSlackVerifiedIngressHeads, deferSlackVerifiedIngressClaim, materializeSlackVerifiedIngressClaim, discardSlackVerifiedIngressClaim, deferUnrecognizedSlackIngressClaim, replayHeldSlackIngress, readHeldSlackIngressSummary } from "./slackVerifiedIngressWorker";
import { processVerifiedSlackIngressOnce, type PreparedVerifiedSlackEvent } from "./slackVerifiedIngressRuntime";
import { SLACK_VERIFIED_INGRESS_MAX_BYTES, type SlackVerifiedIngressAad } from "./slackVerifiedIngressContracts";

const now = new Date("2026-08-05T12:00:00.000Z");
const aad: SlackVerifiedIngressAad = {
  purpose: "slack-verified-ingress", version: 1, registrationId: "11111111-1111-4111-8111-111111111111",
  environment: "test", providerAppId: "A123", providerAuthorityId: "T123",
  providerEventId: "Ev123", providerConversationId: "C123",
};
const key = Buffer.alloc(32, 7);

function receipt(event: SlackVerifiedIngressAad, body = "secret message") {
  const bytes = Buffer.from(body);
  return {
    db: getDb(), aad: event,
    rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad: event }),
    envelopeKeyId: "test-key", now, validateEndpoint: async () => true,
  };
}

beforeEach(async () => { await openTestDatabase("pglite://"); await enableTestSlackIngress(); });
afterEach(async () => { await closeTestDatabase(); });

test("duplicate verified receipts keep one encrypted event and one FIFO position", async () => {
  const first = await enqueueSlackVerifiedIngress(receipt(aad));
  const retry = await enqueueSlackVerifiedIngress(receipt(aad));
  assert.equal(first.kind, "receipt");
  assert.equal(retry.kind, "receipt");
  assert.equal(first.id, retry.id);
  assert.equal(first.kind === "receipt" && first.duplicate, false);
  assert.equal(retry.kind === "receipt" && retry.duplicate, true);
  const events = await getDb().select().from(slackVerifiedIngressEvents);
  const partitions = await getDb().select().from(slackVerifiedIngressPartitions);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.position, 1);
  assert.equal(partitions[0]?.lastPosition, 1);
  assert.ok(!events[0]?.encryptedPayload?.includes("secret message"));
  assert.equal(events[0]?.state, "queued");
});

test("a conflicting reuse of an event ID cannot change content or move it to another channel", async () => {
  await enqueueSlackVerifiedIngress(receipt(aad));
  await assert.rejects(enqueueSlackVerifiedIngress(receipt(aad, "different message")), /identity conflict/);
  await assert.rejects(enqueueSlackVerifiedIngress(receipt({ ...aad, providerConversationId: "C456" })), /identity conflict/);
  const events = await getDb().select().from(slackVerifiedIngressEvents);
  const partitions = await getDb().select().from(slackVerifiedIngressPartitions);
  assert.equal(events.length, 1);
  assert.equal(partitions.length, 1, "conflicting partition insertion rolls back");
  assert.equal(partitions[0]?.lastPosition, 1);
});

test("separate verified events advance the same conversation in admission order", async () => {
  await enqueueSlackVerifiedIngress(receipt(aad));
  await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev456" }));
  const events = await getDb().select().from(slackVerifiedIngressEvents);
  assert.deepEqual(events.map((event) => event.position).sort(), [1, 2]);
  assert.equal((await getDb().select().from(slackVerifiedIngressPartitions))[0]?.lastPosition, 2);
});

test("one batch claims distinct ready conversations without overtaking a conversation head", async () => {
  const first = await enqueueSlackVerifiedIngress(receipt(aad));
  await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_NEXT" }));
  const second = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_OTHER", providerConversationId: "C_OTHER" }));
  const claims = await claimSlackVerifiedIngressHeads({ db: getDb(), leaseOwner: "batch", leaseMs: 5_000, now: () => now, limit: 16 });
  assert.deepEqual(new Set(claims.map(claim => claim.event.id)), new Set([first.id, second.id]));
  assert.equal(new Set(claims.map(claim => claim.partition.id)).size, 2);
  assert.equal((await claimSlackVerifiedIngressHeads({ db: getDb(), leaseOwner: "other", leaseMs: 5_000, now: () => now, limit: 16 })).length, 0);
});

test("a delayed head blocks only its own conversation, and later messages never overtake it", async () => {
  const first = await enqueueSlackVerifiedIngress(receipt(aad));
  await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev456" }));
  const other = { ...aad, providerEventId: "Ev789", providerConversationId: "C_OTHER" };
  await enqueueSlackVerifiedIngress(receipt(other));
  await writeSlackFixture(() => getDb().update(slackVerifiedIngressEvents).set({ nextAttemptAt: new Date(now.getTime() + 60_000) })
    .where(eq(slackVerifiedIngressEvents.id, first.id)));
  const claim = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "worker-1", leaseMs: 5_000, now: () => now });
  assert.equal(claim?.event.providerEventId, other.providerEventId);
  assert.equal(await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "worker-2", leaseMs: 5_000, now: () => now }), null);
});

test("busy conversations rotate fairly even when claims share the same wall clock", async () => {
  const channelA = [aad, { ...aad, providerEventId: "Ev456" }];
  const channelB = [
    { ...aad, providerEventId: "Ev789", providerConversationId: "C_OTHER" },
    { ...aad, providerEventId: "Ev012", providerConversationId: "C_OTHER" },
  ];
  for (const event of [...channelA, ...channelB]) await enqueueSlackVerifiedIngress(receipt(event));
  const first = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "worker-1", leaseMs: 5_000, now: () => now });
  assert.ok(first);
  // Simulate a completed head: the next candidate in that partition is ready.
  await writeSlackFixture(() => getDb().update(slackVerifiedIngressEvents).set({
    state: "discarded", outcomeReason: "test_destination_deleted", encryptedPayload: null,
    envelopeKeyId: null, leaseOwner: null, leaseExpiresAt: null,
  }).where(eq(slackVerifiedIngressEvents.id, first.event.id)));
  const second = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "worker-2", leaseMs: 5_000, now: () => now });
  assert.ok(second);
  assert.notEqual(second.partition.id, first.partition.id);
});

test("an expired worker cannot defer a reclaimed head or lose its encrypted content", async () => {
  await enqueueSlackVerifiedIngress(receipt(aad));
  const first = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "worker-1", leaseMs: 5_000, now: () => now });
  assert.ok(first);
  const later = new Date(now.getTime() + 5_001);
  const second = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "worker-2", leaseMs: 5_000, now: () => later });
  assert.ok(second);
  assert.equal(second.event.id, first.event.id);
  assert.equal(second.event.leaseGeneration, first.event.leaseGeneration + 1);
  assert.equal(await deferSlackVerifiedIngressClaim({
    db: getDb(), partitionId: first.partition.id, eventId: first.event.id,
    leaseOwner: "worker-1", leaseGeneration: first.event.leaseGeneration,
    now: () => later, retryAt: later, reason: "binding_temporarily_unavailable",
  }), false);
  assert.equal(await deferSlackVerifiedIngressClaim({
    db: getDb(), partitionId: second.partition.id, eventId: second.event.id,
    leaseOwner: "worker-2", leaseGeneration: second.event.leaseGeneration,
    now: () => later, retryAt: new Date(later.getTime() + 30_000), reason: "binding_temporarily_unavailable",
  }), true);
  const [saved] = await getDb().select().from(slackVerifiedIngressEvents);
  assert.equal(saved?.state, "queued");
  assert.equal(saved?.encryptedPayload, first.event.encryptedPayload);
  assert.equal(saved?.outcomeReason, "binding_temporarily_unavailable");
});

test("lease expiry is checked again after waiting for transaction locks", async () => {
  await enqueueSlackVerifiedIngress(receipt(aad));
  const claimed = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "worker-1", leaseMs: 5_000, now: () => now });
  assert.ok(claimed);
  let reads = 0;
  assert.equal(await deferSlackVerifiedIngressClaim({
    db: getDb(), partitionId: claimed.partition.id, eventId: claimed.event.id,
    leaseOwner: "worker-1", leaseGeneration: claimed.event.leaseGeneration,
    now: () => new Date(now.getTime() + (reads++ === 0 ? 0 : 5_001)),
    retryAt: new Date(now.getTime() + 60_000), reason: "binding_temporarily_unavailable",
  }), false);
  assert.equal((await getDb().select().from(slackVerifiedIngressEvents))[0]?.state, "processing");
});

for (const [finalOutcome, schemaVersion] of [["committed", 1], ["confirmed_missing", 1], ["committed", 3], ["self_echo", 1],
  ["dead", 1], ["quarantined", 1], ["revoked", 1]] as const) {
test(`materialized schema ${schemaVersion} head preserves order through ${finalOutcome}`, async () => {
  const db = getDb();
  const first = await enqueueSlackVerifiedIngress(receipt(aad));
  await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev456" }));
  const [owner] = await db.insert(users).values({ email: `w4-${randomUUID()}@example.test`, name: `w4-${randomUUID()}`,
    passwordHash: "test-only" }).returning();
  const server = await createServer("W4", `w4-${randomUUID()}`, owner.id);
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: "w4", type: "channel" }).returning();
  const [message] = await db.insert(messages).values({ channelId: channel.id, senderType: "user", senderId: owner.id,
    content: "delivered", messageType: "chat" }).returning();
  const claimed = await claimSlackVerifiedIngressHead({ db, leaseOwner: "worker", leaseMs: 5_000, now: () => now });
  assert.ok(claimed);
  assert.equal(claimed.event.id, first.id);
  const authority = {
    provider: "slack", environment: "test", appRegistrationId: aad.registrationId,
    installId: "install", workspaceId: aad.providerAuthorityId, providerAuthorityId: aad.providerAuthorityId,
    providerConversationId: aad.providerConversationId!,
    bindingId: "binding", bindingEpoch: 1, connectionEpoch: 1, runtimeRevision: "revision",
    raftChannelId: channel.id, privacyClass: "public",
  } as const;
  const input = { db, partitionId: claimed.partition.id, eventId: claimed.event.id, leaseOwner: "worker",
    leaseGeneration: claimed.event.leaseGeneration, now: () => now, authority, normalizedPayloadDigest: "a".repeat(64),
    encryptedPayload: "sealed-normalized", envelopeKeyId: "key", payloadSchemaVersion: schemaVersion,
    payloadExpiresAt: new Date(now.getTime() + 60_000), validateCurrentAuthority: async () => true };
  assert.equal(await materializeSlackVerifiedIngressClaim({ ...input, validateCurrentAuthority: async () => false }), false);
  assert.equal((await db.select().from(externalInboundEvents)).length, 0);
  let reads = 0;
  assert.equal(await materializeSlackVerifiedIngressClaim({ ...input,
    now: () => new Date(now.getTime() + (reads++ === 0 ? 0 : 5_001)) }), false);
  assert.equal((await db.select().from(externalInboundEvents)).length, 0, "expired lease rolls back normalization");
  assert.equal(await materializeSlackVerifiedIngressClaim(input), true);
  const [normalized] = await db.select().from(externalInboundEvents);
  assert.equal(normalized.payloadSchemaVersion, schemaVersion);
  if (schemaVersion === 3) {
    await assert.rejects(enqueueExternalInboundEvent({ db, authority: { ...authority, provider: "other-provider" },
      providerEventId: "other-provider-reaction", normalizedPayloadDigest: "a".repeat(64),
      encryptedPayload: "sealed-normalized", envelopeKeyId: "key", payloadSchemaVersion: 3,
      payloadExpiresAt: input.payloadExpiresAt, receivedAt: now }), /frozen authority is invalid/);
  }
  assert.equal((await enqueueSlackVerifiedIngress(receipt(aad))).id, first.id, "a linked raw/normalized pair is one receipt");
  assert.equal(await claimSlackVerifiedIngressHead({ db, leaseOwner: "worker", leaseMs: 5_000, now: () => now }), null);
  const [waiting] = (await db.select().from(slackVerifiedIngressEvents)).filter((row) => row.id === first.id);
  assert.equal(waiting.state, "materialized");
  assert.ok(waiting.encryptedPayload, "source remains recoverable until delivery succeeds");
  assert.equal(await claimSlackVerifiedIngressHead({ db, leaseOwner: "worker", leaseMs: 5_000, now: () => now }), null,
    "a waiting materialized head cannot be overtaken");
  let resolvedAt = new Date(now.getTime() + 1_000);
  if (finalOutcome === "committed" && schemaVersion === 1) {
    let clock = now;
    for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const [head] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
      assert.equal(head.nextAttemptAt.getTime() - head.updatedAt.getTime(), delay);
      const early = new Date(head.nextAttemptAt.getTime() - 1);
      assert.equal(await claimSlackVerifiedIngressHead({ db, leaseOwner: "other-worker", leaseMs: 5_000, now: () => early }), null);
      clock = head.nextAttemptAt;
      assert.equal(await claimSlackVerifiedIngressHead({ db, leaseOwner: "other-worker", leaseMs: 5_000, now: () => clock }), null);
    }
    resolvedAt = new Date(clock.getTime() + 30_000);
  }
  if (finalOutcome === "committed") {
    await writeSlackFixture(() => db.update(externalInboundEvents).set({ status: "committed", outcomeReason: null, committedMessageId: message.id,
      encryptedPayload: null, envelopeKeyId: null, payloadExpiresAt: null, payloadErasedAt: now, payloadTombstoneDigest: "b".repeat(64) })
      .where(eq(externalInboundEvents.id, normalized.id)));
  } else if (finalOutcome === "confirmed_missing" || finalOutcome === "self_echo") {
    await writeSlackFixture(() => db.update(externalInboundEvents).set({ status: "dead", outcomeReason: finalOutcome === "self_echo" ? "provider_self_echo_without_link" : "confirmed_thread_root_missing",
      encryptedPayload: null, envelopeKeyId: null, payloadExpiresAt: null, payloadErasedAt: now, payloadTombstoneDigest: "b".repeat(64) })
      .where(eq(externalInboundEvents.id, normalized.id)));
  } else {
    await writeSlackFixture(() => db.update(externalInboundEvents).set({ status: finalOutcome, outcomeReason: "test_terminal_failure",
      encryptedPayload: null, envelopeKeyId: null, payloadExpiresAt: null, payloadErasedAt: now, payloadTombstoneDigest: "b".repeat(64) })
      .where(eq(externalInboundEvents.id, normalized.id)));
  }
  assert.equal(await claimSlackVerifiedIngressHead({ db, leaseOwner: "worker", leaseMs: 5_000, now: () => resolvedAt }), null);
  const [completed] = (await db.select().from(slackVerifiedIngressEvents)).filter((row) => row.id === first.id);
  assert.equal(completed.state, finalOutcome === "committed" ? "completed" : (finalOutcome === "confirmed_missing" || finalOutcome === "self_echo") ? "discarded" : "review_required");
  if (finalOutcome === "dead" || finalOutcome === "quarantined" || finalOutcome === "revoked") {
    assert.ok(completed.encryptedPayload, "terminal failures retain authenticated custody");
    assert.equal(completed.outcomeReason, `normalized_terminal_${finalOutcome}`);
  } else assert.equal(completed.encryptedPayload, null);
  assert.equal((await enqueueSlackVerifiedIngress(receipt(aad))).id, first.id, "retries keep the terminal receipt");
  assert.equal((await claimSlackVerifiedIngressHead({ db, leaseOwner: "worker", leaseMs: 5_000, now: () => resolvedAt }))?.event.providerEventId, "Ev456");
  if (finalOutcome === "dead" || finalOutcome === "quarantined" || finalOutcome === "revoked") {
    const replay = { db, partitionId: completed.partitionId, eventId: completed.id, now: () => resolvedAt,
      authorize: async () => ({ kind: "human" as const, id: owner.id }) };
    assert.equal(await replayHeldSlackIngress(replay), true, "an isolated row without side effects can be replayed");
    const [replayed] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
    assert.equal(replayed.state, "queued");
    assert.ok(replayed.position > completed.position);
  }
});
}

for (const oldReason of ["confirmed_thread_root_missing", "payload_expired"] as const) {
  test(`legacy ordered worker handles ${oldReason} without losing another conversation`, async () => {
    const db = getDb();
    const [owner] = await db.insert(users).values({ email: `w4-${randomUUID()}@example.test`, name: `w4-${randomUUID()}`,
      passwordHash: "test-only" }).returning();
    const server = await createServer("W4 order", `w4-order-${randomUUID()}`, owner.id);
    const [channel] = await db.insert(channels).values({ serverId: server.id, name: "w4", type: "channel" }).returning();
    const base = { provider: "slack", environment: "test" as const, appRegistrationId: aad.registrationId,
      installId: "install", workspaceId: aad.providerAuthorityId, providerAuthorityId: aad.providerAuthorityId,
      providerConversationId: "C123", bindingId: "binding", bindingEpoch: 1, connectionEpoch: 1,
      runtimeRevision: "revision", raftChannelId: channel.id, privacyClass: "public" as const,
      normalizedPayloadDigest: "a".repeat(64) };
    const oldAt = new Date(now.getTime() - 2 * 60_000);
    await writeSlackFixture(() => db.insert(externalInboundEvents).values({ ...base, providerEventId: "old", status: "dead",
      outcomeReason: oldReason, payloadErasedAt: oldAt, payloadTombstoneDigest: "b".repeat(64),
      receivedAt: oldAt, updatedAt: oldAt }));
    const [same] = await writeSlackFixture(() => db.insert(externalInboundEvents).values({ ...base, providerEventId: "same",
      encryptedPayload: "sealed", envelopeKeyId: "key", payloadExpiresAt: new Date(now.getTime() + 60_000),
      receivedAt: new Date(oldAt.getTime() + 1_000), updatedAt: oldAt }).returning());
    await writeSlackFixture(() => db.insert(externalInboundEvents).values({ ...base, providerEventId: "other",
      providerConversationId: "C_OTHER", encryptedPayload: "sealed", envelopeKeyId: "key",
      payloadExpiresAt: new Date(now.getTime() + 60_000), receivedAt: new Date(oldAt.getTime() + 2_000), updatedAt: oldAt,
    }).returning());
    const result = await processExternalInboundEventOnce({ db, leaseOwner: "worker", durableSlackMode: true,
      dependencies: { now: () => now, decryptNormalizedPayload: async () => { throw new Error("test unavailable"); },
        resolveCurrentRuntime: async () => null } });
    assert.equal(result.kind, "blocked");
    if (result.kind === "blocked") assert.equal(result.eventId, same.id, "a legacy terminal row does not block its conversation");
  });
}

test("durable Slack mode keeps an expired encrypted legacy event for recovery", async () => {
  const db = getDb();
  const [owner] = await db.insert(users).values({ email: `w4-${randomUUID()}@example.test`, name: `w4-${randomUUID()}`,
    passwordHash: "test-only" }).returning();
  const server = await createServer("W4 retention", `w4-retention-${randomUUID()}`, owner.id);
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: "w4", type: "channel" }).returning();
  const receivedAt = new Date(now.getTime() - 48 * 60 * 60_000);
  const [event] = await writeSlackFixture(() => db.insert(externalInboundEvents).values({
    provider: "slack", environment: "test", appRegistrationId: aad.registrationId,
    installId: "install", workspaceId: aad.providerAuthorityId, providerAuthorityId: aad.providerAuthorityId,
    providerConversationId: "C123", providerEventId: "old", bindingId: "binding", bindingEpoch: 1,
    connectionEpoch: 1, runtimeRevision: "revision", raftChannelId: channel.id, privacyClass: "public",
    normalizedPayloadDigest: "a".repeat(64), encryptedPayload: "sealed", envelopeKeyId: "key",
    payloadExpiresAt: new Date(receivedAt.getTime() + 24 * 60 * 60_000), receivedAt, updatedAt: receivedAt,
  }).returning());
  const result = await processExternalInboundEventOnce({ db, leaseOwner: "worker", durableSlackMode: true,
    dependencies: { now: () => now, decryptNormalizedPayload: async () => { throw new Error("test unavailable"); },
      resolveCurrentRuntime: async () => null } });
  assert.deepEqual(result, { kind: "blocked", eventId: event.id, reason: "payload_decrypt_failed" });
  const [saved] = await db.select().from(externalInboundEvents).where(eq(externalInboundEvents.id, event.id));
  assert.equal(saved.status, "queued");
  assert.equal(saved.encryptedPayload, "sealed");
});


test("a proven absent conversation may be discarded without overtaking or losing uncertain events", async () => {
  const first = await enqueueSlackVerifiedIngress(receipt(aad));
  await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "EvNext" }));
  const claim = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "worker", leaseMs: 5_000, now: () => now });
  assert.ok(claim);
  const input = { db: getDb(), partitionId: claim.partition.id, eventId: claim.event.id, leaseOwner: "worker",
    leaseGeneration: claim.event.leaseGeneration, now: () => now, reason: "no_recoverable_pair" as const,
    proveDefinitiveAbsence: async () => false };
  assert.equal(await discardSlackVerifiedIngressClaim(input), false, "unknown is not absence");
  let reads = 0;
  assert.equal(await discardSlackVerifiedIngressClaim({ ...input, proveDefinitiveAbsence: async () => true,
    now: () => new Date(now.getTime() + (reads++ === 0 ? 0 : 5_001)) }), false, "expiry rolls the discard back");
  const [waiting] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(waiting.state, "processing");
  assert.ok(waiting.encryptedPayload);
  assert.equal(await discardSlackVerifiedIngressClaim({ ...input, leaseGeneration: claim.event.leaseGeneration + 1,
    proveDefinitiveAbsence: async () => true }), false, "another claimant cannot discard this lease");
  assert.equal(await discardSlackVerifiedIngressClaim({ ...input, proveDefinitiveAbsence: async () => true }), true);
  const [discarded] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(discarded.state, "discarded");
  assert.equal(discarded.outcomeReason, "no_recoverable_pair");
  assert.equal(discarded.encryptedPayload, null);
  assert.equal((await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "worker", leaseMs: 5_000, now: () => now }))?.event.providerEventId, "EvNext");
});

test("raw tick retains custody through current-authority normalization and respects the rollout fence", async () => {
  const body = JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId,
    event_id: aad.providerEventId, event: { type: "message", channel: aad.providerConversationId, text: "private body" } });
  const first = await enqueueSlackVerifiedIngress(receipt(aad, body));
  const nextAad = { ...aad, providerEventId: "EvNext" };
  await enqueueSlackVerifiedIngress(receipt(nextAad, body.replace(aad.providerEventId, nextAad.providerEventId)));
  const db = getDb();
  const [owner] = await db.insert(users).values({ email: `w4-runtime-${randomUUID()}@example.test`,
    name: `w4-runtime-${randomUUID()}`, passwordHash: "test-only" }).returning();
  const server = await createServer("W4 runtime", `w4-runtime-${randomUUID()}`, owner.id);
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: "w4-runtime", type: "channel" }).returning();
  let decrypted: Buffer | undefined;
  const crypto = { async seal() { throw new Error("unused"); }, async open(input: { encryptedPayload: string; aad: SlackVerifiedIngressAad }) {
    decrypted = openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad }); return decrypted;
  } };
  const authority = { provider: "slack", environment: "test" as const, appRegistrationId: aad.registrationId,
    installId: "install", workspaceId: aad.providerAuthorityId, providerAuthorityId: aad.providerAuthorityId,
    providerConversationId: aad.providerConversationId!, bindingId: "binding", bindingEpoch: 1,
    connectionEpoch: 1, runtimeRevision: "current", raftChannelId: channel.id, privacyClass: "public" as const };
  const tick = { db, crypto, leaseOwner: "raw-worker", leaseMs: 5_000, now: () => now,
    prepare: async () => ({ kind: "materialize" as const, authority,
      normalizedPayloadDigest: "a".repeat(64), encryptedPayload: "normalized-ciphertext", envelopeKeyId: "key",
      payloadSchemaVersion: 3 as const, payloadExpiresAt: new Date(now.getTime() + 60_000),
      validateCurrentAuthority: async () => true }) };
  let rollout = await readSlackIngressRollout(db);
  await setSlackIngressConsumption({ db, enabled: false, expectedGeneration: rollout.generation, now });
  assert.equal((await processVerifiedSlackIngressOnce(tick)).kind, "disabled");
  assert.equal((await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id)))[0]?.state, "queued");
  rollout = await readSlackIngressRollout(db);
  await setSlackIngressConsumption({ db, enabled: true, expectedGeneration: rollout.generation,
    releaseRecord: TEST_SLACK_RELEASE_RECORD, now });
  assert.equal((await processVerifiedSlackIngressOnce(tick)).kind, "materialized");
  assert.ok(decrypted?.every((byte) => byte === 0), "plaintext bytes are cleared after processing");
  const [raw] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(raw.state, "materialized"); assert.ok(raw.encryptedPayload);
  const [normalized] = await db.select().from(externalInboundEvents);
  assert.equal(normalized.payloadSchemaVersion, 3);
  assert.equal((await processVerifiedSlackIngressOnce(tick)).kind, "empty",
    "the unresolved normalized head blocks its follower");
});

test("raw tick retains ciphertext and follower order when decryption fails", async () => {
  const first = await enqueueSlackVerifiedIngress(receipt(aad));
  await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "EvNext" }));
  const tick = { db: getDb(), crypto: { async seal() { throw new Error("unused"); }, async open() { throw new Error("temporary key outage"); } },
    leaseOwner: "raw-worker", leaseMs: 5_000, now: () => now, prepare: async () => ({ kind: "wait" as const, reason: "unused" }) };
  assert.equal((await processVerifiedSlackIngressOnce(tick)).kind, "deferred");
  const [raw] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(raw.state, "queued"); assert.ok(raw.encryptedPayload);
  assert.equal(raw.outcomeReason, "verified_event_processing_failed");
  assert.equal((await processVerifiedSlackIngressOnce(tick)).kind, "empty");
});

test("raw tick refuses a valid ciphertext whose event coordinates do not match its custody identity", async () => {
  const body = JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId,
    event_id: aad.providerEventId, event: { type: "message", channel: "C_WRONG", text: "private body" } });
  const first = await enqueueSlackVerifiedIngress(receipt(aad, body));
  let prepared = false;
  const tick = { db: getDb(), crypto: { async seal() { throw new Error("unused"); },
    async open(input: { encryptedPayload: string; aad: SlackVerifiedIngressAad }) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } }, leaseOwner: "raw-worker", leaseMs: 5_000, now: () => now, prepare: async () => { prepared = true; return { kind: "wait" as const, reason: "unused" }; } };
  assert.equal((await processVerifiedSlackIngressOnce(tick)).kind, "deferred");
  assert.equal(prepared, false, "normalization cannot use a different channel");
  const [raw] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(raw.state, "queued"); assert.ok(raw.encryptedPayload);
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
});

test("raw tick reports a failed deferral and keeps the leased ciphertext for recovery", async () => {
  const first = await enqueueSlackVerifiedIngress(receipt(aad));
  const db = getDb();
  let opened = false;
  const failingDb = new Proxy(db, { get(target, property, receiver) {
    if (property === "transaction") return (...args: unknown[]) => {
      if (opened) return Promise.reject(new Error("injected database outage"));
      return Reflect.apply(Reflect.get(target, property, receiver), target, args);
    };
    return Reflect.get(target, property, receiver);
  } });
  await assert.rejects(processVerifiedSlackIngressOnce({ db: failingDb,
    crypto: { async seal() { throw new Error("unused"); }, async open() { opened = true; throw new Error("key outage"); } },
    leaseOwner: "raw-worker", leaseMs: 5_000, now: () => now, prepare: async () => ({ kind: "wait" as const, reason: "unused" }) }), /injected database outage/);
  const [raw] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(raw.state, "processing"); assert.ok(raw.encryptedPayload);
  const recovered = await claimSlackVerifiedIngressHead({ db, leaseOwner: "recovery", leaseMs: 5_000,
    now: () => new Date(now.getTime() + 5_001) });
  assert.equal(recovered?.event.id, first.id);
});

test("raw tick clears an invalid oversized decrypted buffer before deferring", async () => {
  const first = await enqueueSlackVerifiedIngress(receipt(aad));
  const db = getDb();
  const plaintext = Buffer.alloc(SLACK_VERIFIED_INGRESS_MAX_BYTES + 1, 0x61);
  let opened = false;
  let transitions = 0;
  const observedDb = new Proxy(db, { get(target, property, receiver) {
    if (property === "transaction") return (...args: unknown[]) => {
      if (opened) { transitions++; assert.ok(plaintext.every((byte) => byte === 0), "plaintext must be cleared before waiting on the database"); }
      return Reflect.apply(Reflect.get(target, property, receiver), target, args);
    };
    return Reflect.get(target, property, receiver);
  } });
  const result = await processVerifiedSlackIngressOnce({ db: observedDb,
    crypto: { async seal() { throw new Error("unused"); }, async open() { opened = true; return plaintext; } },
    leaseOwner: "raw-worker", leaseMs: 5_000, now: () => now, prepare: async () => { throw new Error("invalid bytes reached normalizer"); } });
  assert.equal(result.kind, "deferred");
  assert.equal(transitions, 2, "pair-absence proof and quarantine retry both run after zeroing plaintext");
  const [raw] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(raw.state, "queued"); assert.ok(raw.encryptedPayload);
});

test.each(["wait", "discard", "materialize"] as const)(
  "raw tick surfaces a one-time database failure in %s without a second transition",
  async (kind) => {
    const body = JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId,
      event_id: aad.providerEventId, event: { type: "message", channel: aad.providerConversationId, text: "private body" } });
    const first = await enqueueSlackVerifiedIngress(receipt(aad, body));
    const db = getDb();
    let transitionReady = false;
    let transitions = 0;
    const failingDb = new Proxy(db, { get(target, property, receiver) {
      if (property === "transaction") return (...args: unknown[]) => {
        if (transitionReady) transitions++;
        if (transitions === 1) return Promise.reject(new Error("one-time database outage"));
        return Reflect.apply(Reflect.get(target, property, receiver), target, args);
      };
      return Reflect.get(target, property, receiver);
    } });
    const authority = { provider: "slack", environment: "test" as const, appRegistrationId: aad.registrationId,
      installId: "install", workspaceId: aad.providerAuthorityId, providerAuthorityId: aad.providerAuthorityId,
      providerConversationId: aad.providerConversationId!, bindingId: "binding", bindingEpoch: 1,
      connectionEpoch: 1, runtimeRevision: "current", raftChannelId: "channel", privacyClass: "public" as const };
    const prepared: PreparedVerifiedSlackEvent = kind === "wait" ? { kind, reason: "binding_unavailable" }
      : kind === "discard" ? { kind, reason: "no_recoverable_pair" }
      : { kind, authority, normalizedPayloadDigest: "a".repeat(64), encryptedPayload: "normalized-ciphertext",
        envelopeKeyId: "key", payloadSchemaVersion: 3, payloadExpiresAt: new Date(now.getTime() + 60_000),
        validateCurrentAuthority: async () => true };
    await assert.rejects(processVerifiedSlackIngressOnce({ db: failingDb,
      crypto: { async seal() { throw new Error("unused"); }, async open(input) {
        return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
      } }, leaseOwner: "raw-worker", leaseMs: 5_000, now: () => now, prepare: async () => { transitionReady = true; return prepared; } }), /one-time database outage/);
    assert.equal(transitions, 1, "the failed transition must not be silently retried with a different reason");
    const [raw] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
    assert.equal(raw.state, "processing");
    assert.ok(raw.encryptedPayload, "a failed transaction retains the original encrypted receipt");
    const recovered = await claimSlackVerifiedIngressHead({ db, leaseOwner: "recovery", leaseMs: 5_000,
      now: () => new Date(now.getTime() + 5_001) });
    assert.equal(recovered?.event.id, first.id);
  },
);


test("one unrecognized event is held after bounded retries, preserving later messages and replay", async () => {
  const db = getDb();
  await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_FIRST" }));
  const bad = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_BAD" }));
  await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_LAST" }));
  let clock = new Date(now);
  const claim = () => claimSlackVerifiedIngressHead({ db, leaseOwner: "worker", leaseMs: 10_000, now: () => clock });
  const first = await claim();
  assert.equal(first?.event.providerEventId, "Ev_FIRST");
  // Model a completed first delivery, then exercise the actual queue worker
  // transitions for the unrecognized middle event.
  await writeSlackFixture(() => db.update(slackVerifiedIngressEvents).set({ state: "discarded", outcomeReason: "test_completed",
    encryptedPayload: null, envelopeKeyId: null, leaseOwner: null, leaseExpiresAt: null })
    .where(eq(slackVerifiedIngressEvents.id, first!.event.id)));
  for (let n = 1; n <= 3; n++) {
    const current = await claim();
    assert.equal(current?.event.id, bad.id);
    const retryAt = new Date(clock.getTime() + 1_000);
    const transition = await deferUnrecognizedSlackIngressClaim({ db, partitionId: current!.partition.id,
      eventId: current!.event.id, leaseOwner: "worker", leaseGeneration: current!.event.leaseGeneration,
      now: () => clock, retryAt, reason: "unsupported_event_format" });
    assert.equal(transition, n < 3 ? "retry" : "held");
    clock = retryAt;
  }
  const [held] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, bad.id));
  assert.equal(held.state, "held");
  assert.ok(held.encryptedPayload);
  assert.equal(held.parseFailureCount, 3);
  const summary = await readHeldSlackIngressSummary({ db, registrationId: aad.registrationId,
    environment: aad.environment, providerAuthorityId: aad.providerAuthorityId,
    providerConversationId: aad.providerConversationId! });
  assert.equal(summary.count, 1);
  assert.equal(new Date(summary.oldestFirstFailureAt!).getTime(), now.getTime());
  const last = await claim();
  assert.equal(last?.event.providerEventId, "Ev_LAST", "the later normal event can proceed");
  const replay = { db, partitionId: held.partitionId, eventId: held.id, now: () => clock, authorize: async () => null };
  assert.equal(await replayHeldSlackIngress(replay), false);
  assert.equal(await replayHeldSlackIngress({ ...replay, authorize: async () => ({ kind: "human" as const, id: "test-operator" }) }), true);
  assert.equal(await replayHeldSlackIngress({ ...replay, authorize: async () => ({ kind: "human" as const, id: "test-operator" }) }), false, "replay is idempotent");
  const [requeued] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, held.id));
  assert.equal(requeued.state, "queued");
  assert.ok(requeued.encryptedPayload);
  assert.equal(requeued.position, 4, "replay goes behind events already admitted");
  assert.equal(requeued.parseFailureCount, 0);
  assert.equal(requeued.replayCount, 1);
  const audit = await db.select().from(slackVerifiedIngressReplayAudits).where(eq(slackVerifiedIngressReplayAudits.eventId, held.id));
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.actorId, "test-operator");
  assert.equal(audit[0]?.previousPosition, 2);
  assert.equal(audit[0]?.replayPosition, 4);
  assert.equal(audit[0]?.isolationReason, "unsupported_event_format");
  assert.equal((await readHeldSlackIngressSummary({ db, registrationId: aad.registrationId,
    environment: aad.environment, providerAuthorityId: aad.providerAuthorityId,
    providerConversationId: aad.providerConversationId! })).count, 0);
});

test("an expired or replaced lease cannot park a receipt", async () => {
  await enqueueSlackVerifiedIngress(receipt(aad));
  const current = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "worker", leaseMs: 1_000, now: () => now });
  assert.ok(current);
  const later = new Date(now.getTime() + 1_001);
  const result = await deferUnrecognizedSlackIngressClaim({ db: getDb(), partitionId: current.partition.id,
    eventId: current.event.id, leaseOwner: "worker", leaseGeneration: current.event.leaseGeneration,
    now: () => later, retryAt: new Date(later.getTime() + 1_000), reason: "invalid_event_shape" });
  assert.equal(result, "lease_lost");
  const [saved] = await getDb().select().from(slackVerifiedIngressEvents);
  assert.equal(saved.state, "processing");
  assert.equal(saved.parseFailureCount, 0);
  assert.ok(saved.encryptedPayload);
});

test("raw worker puts an unrecognized event aside after its bounded retries", async () => {
  const db = getDb();
  const raw = JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId,
    event_id: aad.providerEventId, event: { type: "message", channel: aad.providerConversationId, subtype: "future_format" } });
  const bad = await enqueueSlackVerifiedIngress(receipt(aad, raw));
  await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_NEXT" }));
  let clock = new Date(now);
  const tick = { db, crypto: { async seal() { throw new Error("unused"); },
    async open(input: { encryptedPayload: string; aad: SlackVerifiedIngressAad }) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } }, leaseOwner: "worker", leaseMs: 5_000, now: () => clock,
    prepare: async () => ({ kind: "unrecognized" as const, reason: "unsupported_event_format" as const }) };
  for (let n = 1; n <= 3; n++) {
    assert.equal((await processVerifiedSlackIngressOnce(tick)).kind, n < 3 ? "deferred" : "held");
    clock = new Date(clock.getTime() + 60_000);
  }
  const [stored] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, bad.id));
  assert.equal(stored.state, "held");
  assert.ok(stored.encryptedPayload);
  const next = await claimSlackVerifiedIngressHead({ db, leaseOwner: "worker", leaseMs: 5_000, now: () => clock });
  assert.equal(next?.event.providerEventId, "Ev_NEXT");
});

test("channel authority waits remain FIFO and never become single-event holds", async () => {
  const db = getDb();
  const raw = JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId,
    event_id: aad.providerEventId, event: { type: "message", channel: aad.providerConversationId, text: "body" } });
  const first = await enqueueSlackVerifiedIngress(receipt(aad, raw));
  await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_FOLLOWER" }));
  let clock = new Date(now);
  const tick = { db, crypto: { async seal() { throw new Error("unused"); },
    async open(input: { encryptedPayload: string; aad: SlackVerifiedIngressAad }) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } }, leaseOwner: "worker", leaseMs: 5_000, now: () => clock,
    prepare: async () => ({ kind: "wait" as const, reason: "binding_temporarily_unavailable" }) };
  for (let n = 0; n < 5; n++) {
    assert.equal((await processVerifiedSlackIngressOnce(tick)).kind, "deferred");
    clock = new Date(clock.getTime() + 60_000);
  }
  const [saved] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(saved.state, "queued");
  assert.equal(saved.parseFailureCount, 0);
  assert.ok(saved.encryptedPayload);
  const next = await claimSlackVerifiedIngressHead({ db, leaseOwner: "worker", leaseMs: 5_000, now: () => clock });
  assert.equal(next?.event.id, first.id, "the later event remains behind the channel-level wait");
});

test("a scoped raw worker cannot claim another registration or environment", async () => {
  const foreign = { ...aad, registrationId: "22222222-2222-4222-8222-222222222222", providerEventId: "Ev_FOREIGN" };
  const wrongEnvironment = { ...aad, environment: "production" as const, providerEventId: "Ev_PROD" };
  await enqueueSlackVerifiedIngress(receipt(foreign));
  await enqueueSlackVerifiedIngress(receipt(wrongEnvironment));
  await enqueueSlackVerifiedIngress(receipt(aad));
  // Force either foreign scope to sort first if its predicate is removed.
  await writeSlackFixture(() => getDb().update(slackVerifiedIngressPartitions)
    .set({ lastServedOrdinal: 1 }).where(and(eq(slackVerifiedIngressPartitions.appRegistrationId, aad.registrationId),
      eq(slackVerifiedIngressPartitions.environment, aad.environment))));
  const claim = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "scoped-worker", leaseMs: 5_000,
    now: () => now, scope: { registrationId: aad.registrationId, environment: aad.environment } });
  assert.equal(claim?.event.providerEventId, aad.providerEventId);
  assert.equal(await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "scoped-worker-2", leaseMs: 5_000,
    now: () => now, scope: { registrationId: aad.registrationId, environment: aad.environment } }), null);
  const untouched = await getDb().select().from(slackVerifiedIngressEvents)
    .where(eq(slackVerifiedIngressEvents.providerEventId, foreign.providerEventId));
  assert.equal(untouched[0]?.state, "queued");
  const production = await getDb().select().from(slackVerifiedIngressEvents)
    .where(eq(slackVerifiedIngressEvents.providerEventId, wrongEnvironment.providerEventId));
  assert.equal(production[0]?.state, "queued");
});

test("a preparer failure surfaces to the supervisor and leaves custody recoverable", async () => {
  const body = JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId,
    event_id: aad.providerEventId, event: { type: "message", channel: aad.providerConversationId, text: "retained" } });
  const first = await enqueueSlackVerifiedIngress(receipt(aad, body));
  await assert.rejects(processVerifiedSlackIngressOnce({ db: getDb(), leaseOwner: "failing-preparer", leaseMs: 5_000,
    now: () => now, crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } }, prepare: async () => { throw new Error("database authority outage"); } }), /database authority outage/);
  const [stored] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(stored?.state, "processing");
  assert.ok(stored?.encryptedPayload);
  const retry = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "retry", leaseMs: 5_000,
    now: () => new Date(now.getTime() + 5_001) });
  assert.equal(retry?.event.id, first.id);
});

test("a held event without a conversation remains recoverable by an authorized replay", async () => {
  const db = getDb();
  const scope = { ...aad, providerEventId: "Ev_NO_CHANNEL", providerConversationId: null };
  const stored = await enqueueSlackVerifiedIngress(receipt(scope));
  let clock = new Date(now);
  for (let n = 1; n <= 3; n++) {
    const current = await claimSlackVerifiedIngressHead({ db, leaseOwner: "worker", leaseMs: 5_000, now: () => clock });
    assert.ok(current);
    const retryAt = new Date(clock.getTime() + 1_000);
    const result = await deferUnrecognizedSlackIngressClaim({ db, partitionId: current.partition.id,
      eventId: current.event.id, leaseOwner: "worker", leaseGeneration: current.event.leaseGeneration,
      now: () => clock, retryAt, reason: "unsupported_event_format" });
    assert.equal(result, n < 3 ? "retry" : "held");
    clock = retryAt;
  }
  const [held] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, stored.id));
  const replay = { db, partitionId: held!.partitionId, eventId: held!.id, now: () => clock, authorize: async () => null };
  assert.equal(await replayHeldSlackIngress(replay), false);
  assert.equal(await replayHeldSlackIngress({ ...replay, authorize: async () => ({ kind: "human" as const, id: "test-operator" }) }), true);
  const [requeued] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, stored.id));
  assert.equal(requeued?.state, "queued");
  assert.ok(requeued?.encryptedPayload);
});

test("the scoped verified worker runs on start and stops without claiming more work", async () => {
  const { createSlackVerifiedIngressWorkerRuntime } = await import("./slackVerifiedIngressRuntime");
  const body = JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId,
    event_id: aad.providerEventId, event: { type: "message", channel: aad.providerConversationId, text: "retained" } });
  const first = await enqueueSlackVerifiedIngress(receipt(aad, body));
  let prepared = 0;
  const errors: unknown[] = [];
  const worker = createSlackVerifiedIngressWorkerRuntime({ db: getDb(),
    crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } }, scope: { registrationId: aad.registrationId, environment: aad.environment },
    leaseOwner: "scheduler-test", leaseMs: 5_000, now: () => now, intervalMs: 10,
    prepare: async () => { prepared++; return { kind: "wait", reason: "binding_unavailable" }; },
    onError: error => { errors.push(error); },
  });
  worker.start();
  // stop drains the first tick, including a DB operation already in flight.
  await worker.stop();
  assert.equal(prepared, 1);
  assert.deepEqual(errors, []);
  const [saved] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(saved?.state, "queued");
  assert.equal(saved?.outcomeReason, "binding_unavailable");
  worker.tick();
  assert.equal(prepared, 1, "a stopped scheduler must not claim later events");
});

test("retention compacts only old terminal custody and preserves exact duplicate evidence", async () => {
  const { compactTerminalSlackIngress, SLACK_INGRESS_TERMINAL_RETENTION_MS } = await import("./slackVerifiedIngressRetention");
  const { slackVerifiedIngressDedupe } = await import("../db/schema");
  const old = await enqueueSlackVerifiedIngress(receipt(aad));
  const audited = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_AUDITED" }));
  const unresolved = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_UNRESOLVED" }));
  await writeSlackFixture(async () => {
    await getDb().update(slackVerifiedIngressEvents).set({ state: "discarded", outcomeReason: "no_recoverable_pair",
      encryptedPayload: null, envelopeKeyId: null, updatedAt: now }).where(inArray(slackVerifiedIngressEvents.id, [old.id, audited.id]));
    const [row] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, audited.id));
    await getDb().insert(slackVerifiedIngressReplayAudits).values({ eventId: audited.id, partitionId: row.partitionId,
      previousPosition: 1, replayPosition: 2, actorKind: "human", actorId: "operator", isolationReason: "unsupported_event_format", replayedAt: now });
  });
  const after = new Date(now.getTime() + SLACK_INGRESS_TERMINAL_RETENTION_MS + 1);
  assert.equal(await compactTerminalSlackIngress({ db: getDb(), now: after, registrationId: aad.registrationId, environment: aad.environment }), 1);
  assert.equal((await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, old.id))).length, 0);
  assert.equal((await getDb().select().from(slackVerifiedIngressDedupe)).length, 1);
  assert.equal((await enqueueSlackVerifiedIngress(receipt(aad))).id, old.id, "a late signed retry remains a duplicate");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await assert.rejects(enqueueSlackVerifiedIngress(receipt(aad, "changed bytes")), /identity conflict/);
    assert.equal(warning.mock.calls.length, 1);
    const [label, details] = warning.mock.calls[0]!;
    assert.equal(label, "[Slack Bridge] signed event digest conflict");
    assert.deepEqual(details, { eventId: aad.providerEventId, previousDigest: receipt(aad).rawDigest,
      incomingDigest: receipt(aad, "changed bytes").rawDigest });
    assert.ok(!JSON.stringify(warning.mock.calls).includes("changed bytes"), "logs contain no payload");
  } finally { warning.mockRestore(); }
  assert.equal((await getDb().select().from(slackVerifiedIngressEvents).where(inArray(slackVerifiedIngressEvents.id, [audited.id, unresolved.id]))).length, 2);
});

test("corrupt signed payloads remain replayable until quarantine retention expires", async () => {
  const { expireQuarantinedSlackIngress, SLACK_INGRESS_TERMINAL_RETENTION_MS } = await import("./slackVerifiedIngressRetention");
  const original = await enqueueSlackVerifiedIngress(receipt(aad, "not JSON"));
  let clock = new Date(now);
  const tick = () => processVerifiedSlackIngressOnce({ db: getDb(), leaseOwner: "quarantine-test", leaseMs: 30_000,
    now: () => clock, prepare: async () => { throw new Error("invalid payload reached preparer"); },
    crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } });
  for (let i = 0; i < 3; i++) {
    assert.equal((await tick()).kind, i === 2 ? "quarantined" : "deferred");
    clock = new Date(clock.getTime() + 2_000);
  }
  const [isolated] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, original.id));
  assert.equal(isolated.state, "quarantined");
  assert.ok(isolated.encryptedPayload);
  const scope = { db: getDb(), registrationId: aad.registrationId, environment: "test" as const };
  assert.equal(await expireQuarantinedSlackIngress({ ...scope, now: new Date(isolated.heldAt!.getTime() + SLACK_INGRESS_TERMINAL_RETENTION_MS - 1) }), 0);
  assert.equal(await expireQuarantinedSlackIngress({ ...scope, now: new Date(isolated.heldAt!.getTime() + SLACK_INGRESS_TERMINAL_RETENTION_MS + 1) }), 1);
  const [expired] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, original.id));
  assert.equal(expired.state, "discarded");
  assert.equal(expired.encryptedPayload, null);
  assert.equal(expired.outcomeReason, "quarantine_retention_expired");
  assert.equal(expired.lastIsolationReason, "verified_payload_invalid");
});

test("waiting for an author moves aside, then returns to its original position", async () => {
  const { requeueDueSlackActor } = await import("./slackVerifiedIngressWorker");
  const first = await enqueueSlackVerifiedIngress(receipt(aad));
  const next = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_AFTER_ACTOR" }));
  let clock = new Date(now);
  for (let i = 0; i < 3; i++) {
    const claim = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "actor-retry", leaseMs: 30_000, now: () => clock });
    assert.equal(claim?.event.id, first.id);
    assert.equal(await deferUnrecognizedSlackIngressClaim({ db: getDb(), partitionId: claim!.partition.id,
      eventId: first.id, leaseOwner: "actor-retry", leaseGeneration: claim!.event.leaseGeneration,
      now: () => clock, retryAt: new Date(clock.getTime() + 1_000), reason: "actor_identity_pending",
      pendingAuthor: { installId: "install", bindingId: "binding", workspaceId: aad.providerAuthorityId, actorId: "U_TEST" },
      validatePendingAuthor: async () => true }), i === 2 ? "held" : "retry");
    clock = new Date(clock.getTime() + 1_001);
  }
  const second = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "later", leaseMs: 30_000, now: () => clock });
  assert.equal(second?.event.id, next.id);
  const scope = { db: getDb(), registrationId: aad.registrationId, environment: "test" as const };
  assert.equal(await requeueDueSlackActor({ ...scope, now: clock }), false);
  clock = new Date(now.getTime() + 11 * 60_000);
  assert.equal(await requeueDueSlackActor({ ...scope, now: clock }), true);
  const [returned] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(returned.state, "queued");
  assert.ok(returned.position < second!.event.position);
  assert.ok(returned.encryptedPayload);
});

test("bot outbound wait parks off-head and retries at its original position", async () => {
  const reason = "bot_outbound_pending" as const;
  const { requeueDueSlackActor } = await import("./slackVerifiedIngressWorker");
  const db = getDb();
  const first = await enqueueSlackVerifiedIngress(receipt(aad));
  const next = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_AFTER_PENDING_BOT" }));
  let clock = new Date(now);
  for (let i = 0; i < 3; i++) {
    const claim = await claimSlackVerifiedIngressHead({ db, leaseOwner: "bot-retry", leaseMs: 30_000, now: () => clock });
    assert.equal(claim?.event.id, first.id);
    assert.equal(await deferUnrecognizedSlackIngressClaim({ db, partitionId: claim!.partition.id, eventId: first.id,
      leaseOwner: "bot-retry", leaseGeneration: claim!.event.leaseGeneration, now: () => clock,
      retryAt: new Date(clock.getTime() + 1_000), reason,
      pendingAuthor: { installId: "install", bindingId: "binding", workspaceId: aad.providerAuthorityId, actorId: "B_TEST" },
      validatePendingAuthor: async () => true }), i === 2 ? "held" : "retry");
    clock = new Date(clock.getTime() + 1_001);
  }
  const [held] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(held.outcomeReason, reason);
  assert.ok(held.encryptedPayload);
  const second = await claimSlackVerifiedIngressHead({ db, leaseOwner: "other-bot", leaseMs: 30_000, now: () => clock });
  assert.equal(second?.event.id, next.id);
  const scope = { db, registrationId: aad.registrationId, environment: "test" as const };
  assert.equal(await requeueDueSlackActor({ ...scope, now: clock }), false);
  clock = new Date(held.nextAttemptAt.getTime());
  assert.equal(await requeueDueSlackActor({ ...scope, now: clock }), true);
  const [restored] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(restored.state, "queued");
  assert.equal(restored.lastIsolationReason, reason);
  assert.ok(restored.position < second!.event.position);
});

test("old unresolved bot sends back off up to thirty minutes without blocking other authors", async () => {
  const db = getDb();
  const first = await enqueueSlackVerifiedIngress(receipt(aad));
  const next = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_AFTER_BOT_BACKOFF" }));
  const clock = new Date(now.getTime() + 2 * 60 * 60_000);
  const claim = await claimSlackVerifiedIngressHead({ db, leaseOwner: "old-bot", leaseMs: 30_000, now: () => clock });
  assert.equal(claim?.event.id, first.id);
  assert.equal(await deferUnrecognizedSlackIngressClaim({ db, partitionId: claim!.partition.id, eventId: first.id,
    leaseOwner: "old-bot", leaseGeneration: claim!.event.leaseGeneration, now: () => clock,
    retryAt: new Date(clock.getTime() + 1_000), reason: "bot_outbound_pending", immediate: true,
    pendingAuthor: { installId: "install", bindingId: "binding", workspaceId: aad.providerAuthorityId, actorId: "B_TEST" },
    validatePendingAuthor: async () => true }), "held");
  const [held] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(held.nextAttemptAt.getTime(), clock.getTime() + 30 * 60_000);
  assert.equal((await claimSlackVerifiedIngressHead({ db, leaseOwner: "other", leaseMs: 30_000, now: () => clock }))?.event.id, next.id);
});

test.each(["invalid_json", "identity_mismatch"] as const)("decrypted %s is isolated while following events proceed", async kind => {
  const db = getDb();
  const body = kind === "invalid_json" ? "{" : JSON.stringify({ type: "event_callback", api_app_id: "A123",
    team_id: "T_DIFFERENT", event_id: aad.providerEventId, event: { type: "message", channel: aad.providerConversationId } });
  const first = await enqueueSlackVerifiedIngress(receipt(aad, body));
  await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_AFTER_BAD_RAW" }));
  let clock = new Date(now);
  const tick = { db, crypto: { async seal() { throw new Error("unused"); }, async open(input: { encryptedPayload: string; aad: SlackVerifiedIngressAad }) {
    return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
  } }, leaseOwner: "bad-raw", leaseMs: 5_000, now: () => clock, prepare: async () => { throw new Error("must not prepare"); } };
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal((await processVerifiedSlackIngressOnce(tick)).kind, attempt < 3 ? "deferred" : "quarantined");
    clock = new Date(clock.getTime() + 1_000);
  }
  const [held] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(held.outcomeReason, "verified_payload_invalid"); assert.ok(held.encryptedPayload);
  assert.equal((await claimSlackVerifiedIngressHead({ db, leaseOwner: "next", leaseMs: 5_000, now: () => clock }))?.event.providerEventId, "Ev_AFTER_BAD_RAW");
});

test("dedupe evidence expires only after 30 days, in bounded scope", async () => {
  const { expireSlackIngressDedupe, SLACK_INGRESS_TERMINAL_RETENTION_MS } = await import("./slackVerifiedIngressRetention");
  const { slackVerifiedIngressDedupe } = await import("../db/schema");
  const db = getDb();
  const finishedAt = new Date(now.getTime() - SLACK_INGRESS_TERMINAL_RETENTION_MS - 1);
  const row = (eventId: string, environment: "test" | "production", time: Date) => ({ id: randomUUID(),
    appRegistrationId: aad.registrationId, providerEventId: eventId, providerAppId: aad.providerAppId,
    environment, providerAuthorityId: aad.providerAuthorityId, providerConversationId: aad.providerConversationId!,
    rawDigest: receipt(aad).rawDigest, finishedAt: time });
  await db.insert(slackVerifiedIngressDedupe).values([
    row("Ev_EXPIRED1", "test", finishedAt), row("Ev_EXPIRED2", "test", finishedAt),
    row("Ev_BOUNDARY", "test", new Date(finishedAt.getTime() + 1)), row("Ev_PROD", "production", finishedAt),
  ]);
  const scope = { db, now, registrationId: aad.registrationId, environment: "test" as const, limit: 1 };
  assert.equal(await expireSlackIngressDedupe(scope), 1);
  assert.equal(await expireSlackIngressDedupe(scope), 1);
  assert.equal(await expireSlackIngressDedupe(scope), 0);
  const remaining = await db.select().from(slackVerifiedIngressDedupe);
  assert.deepEqual(new Set(remaining.map(item => item.providerEventId)), new Set(["Ev_BOUNDARY", "Ev_PROD"]));
});

test("a durable author wake blocks overtaking and restores only the matching pair and author in place", async () => {
  const { requeueDueSlackActor, discardClassifiedSlackIngressClaim } = await import("./slackVerifiedIngressWorker");
  const { slackIngressAuthorWakeSignals } = await import("../db/schema");
  const { expireSlackAuthorWakeSignals } = await import("./slackVerifiedIngressRetention");
  const db = getDb();
  const target = { installId: "install-1", workspaceId: aad.providerAuthorityId, bindingId: "pair-1", actorId: "U_ONE" };
  const otherAuthor = { ...target, actorId: "U_TWO" };
  const otherPair = { ...target, bindingId: "pair-2" };
  const first = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_WAKE_FIRST" }));
  const second = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_WAKE_SECOND" }));
  const third = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_OTHER_AUTHOR" }));
  let clock = new Date(now);
  async function isolate(id: string, author: typeof target) {
    for (let n = 0; n < 3; n++) {
      const claim = await claimSlackVerifiedIngressHead({ db, leaseOwner: "isolate", leaseMs: 30_000, now: () => clock });
      assert.equal(claim?.event.id, id);
      assert.equal(await deferUnrecognizedSlackIngressClaim({ db, partitionId: claim!.partition.id, eventId: id,
        leaseOwner: "isolate", leaseGeneration: claim!.event.leaseGeneration, now: () => clock,
        retryAt: new Date(clock.getTime() + 1_000), reason: "actor_identity_pending", pendingAuthor: author,
        validatePendingAuthor: async () => true }), n === 2 ? "held" : "retry");
      clock = new Date(clock.getTime() + 1_001);
    }
  }
  await isolate(first.id, target); await isolate(second.id, target); await isolate(third.id, otherAuthor);
  const fourth = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_OTHER_PAIR", providerConversationId: "C_OTHER" }));
  await isolate(fourth.id, otherPair);
  const newer = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_NEW_AFTER_WAKE" }));
  const future = new Date(clock.getTime() + 60 * 60_000);
  await writeSlackFixture(() => db.update(slackVerifiedIngressEvents).set({ nextAttemptAt: future })
    .where(inArray(slackVerifiedIngressEvents.id, [first.id, second.id, third.id, fourth.id])));
  await db.insert(slackIngressAuthorWakeSignals).values({ registrationId: aad.registrationId, ...target,
    signaledAt: clock, expiresAt: new Date(clock.getTime() + 24 * 60 * 60_000) });
  const pendingNewer = await claimSlackVerifiedIngressHead({ db, leaseOwner: "newer", leaseMs: 30_000, now: () => clock });
  assert.equal(pendingNewer?.event.id, newer.id, "other authors are allowed to reach identity classification");
  assert.equal(await deferSlackVerifiedIngressClaim({ db, partitionId: pendingNewer!.partition.id, eventId: newer.id,
    leaseOwner: "newer", leaseGeneration: pendingNewer!.event.leaseGeneration, now: () => clock,
    retryAt: future, reason: "binding_temporarily_unavailable" }), true);
  // Reading the signal and exiting without changing the queue models a worker
  // crash: the committed signal must be sufficient for a new worker.
  assert.equal((await db.select().from(slackIngressAuthorWakeSignals)).length, 1);
  const afterExpiry = new Date(clock.getTime() + 24 * 60 * 60_000 + 1);
  assert.equal(await expireSlackAuthorWakeSignals({ db, registrationId: aad.registrationId, now: afterExpiry }), 0,
    "expired signals stay until matching held receipts are restored");
  const scope = { db, registrationId: aad.registrationId, environment: "test" as const, now: clock };
  assert.equal(await requeueDueSlackActor(scope), true);
  const [restored] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, first.id));
  assert.equal(restored.position, 1, "the original queue position is reserved while held");
  const claim = await claimSlackVerifiedIngressHead({ db, leaseOwner: "restored", leaseMs: 30_000, now: () => clock });
  assert.equal(claim?.event.id, first.id);
  assert.equal(await discardClassifiedSlackIngressClaim({ db, partitionId: claim!.partition.id, eventId: claim!.event.id,
    rawDigest: claim!.event.rawDigest, leaseOwner: "restored", leaseGeneration: claim!.event.leaseGeneration,
    now: () => clock, reason: "unsupported_event" }), true);
  assert.equal(await requeueDueSlackActor(scope), true);
  const [secondRestored] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, second.id));
  assert.equal(secondRestored.position, 2);
  for (const id of [third.id, fourth.id]) {
    const [unchanged] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, id));
    assert.equal(unchanged.state, "held", "other author or pairing must not wake");
    assert.equal(unchanged.nextAttemptAt.getTime(), future.getTime());
  }
  assert.equal(await expireSlackAuthorWakeSignals({ db, registrationId: aad.registrationId, now: afterExpiry }), 1);
  assert.equal((await db.select().from(slackIngressAuthorWakeSignals)).length, 0);
  assert.ok(newer.id);
});

test("a consumed wake does not repeatedly requeue an author still awaiting identity", async () => {
  const { requeueDueSlackActor } = await import("./slackVerifiedIngressWorker");
  const { slackIngressAuthorWakeSignals } = await import("../db/schema");
  const db = getDb();
  const event = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_WAKE_ONCE" }));
  const pendingAuthor = { installId: "install-1", workspaceId: aad.providerAuthorityId, bindingId: "pair-1", actorId: "U_ONE" };
  let clock = new Date(now);
  async function hold() {
    for (let n = 0; n < 3; n++) {
      const claim = await claimSlackVerifiedIngressHead({ db, leaseOwner: "worker", leaseMs: 30_000, now: () => clock });
      assert.equal(claim?.event.id, event.id);
      await deferUnrecognizedSlackIngressClaim({ db, partitionId: claim!.partition.id, eventId: event.id,
        leaseOwner: "worker", leaseGeneration: claim!.event.leaseGeneration, now: () => clock,
        retryAt: new Date(clock.getTime() + 1_000), reason: "actor_identity_pending", pendingAuthor,
        validatePendingAuthor: async () => true });
      clock = new Date(clock.getTime() + 1_001);
    }
  }
  await hold();
  await db.insert(slackIngressAuthorWakeSignals).values({ registrationId: aad.registrationId, ...pendingAuthor,
    signaledAt: clock, expiresAt: new Date(clock.getTime() + 86_400_000) });
  const scope = { db, registrationId: aad.registrationId, environment: "test" as const, now: clock };
  assert.equal(await requeueDueSlackActor(scope), true);
  await hold();
  assert.equal(await requeueDueSlackActor({ ...scope, now: clock }), false, "the same old signal cannot spin on a re-held event");
  const fresh = new Date(clock.getTime() + 1);
  await db.update(slackIngressAuthorWakeSignals).set({ signaledAt: fresh, expiresAt: new Date(fresh.getTime() + 86_400_000) });
  assert.equal(await requeueDueSlackActor({ ...scope, now: fresh }), true, "a genuinely newer fallback may wake it once");
});

test.each([
  { label: "same author and pair", actorId: "U_ONE", bindingId: "pair-1", allowed: false },
  { label: "another author", actorId: "U_TWO", bindingId: "pair-1", allowed: true },
  { label: "another pair", actorId: "U_ONE", bindingId: "pair-2", allowed: true },
  { label: "same author with a wake", actorId: "U_ONE", bindingId: "pair-1", allowed: false, wake: true },
  { label: "another author with a wake", actorId: "U_TWO", bindingId: "pair-1", allowed: true, wake: true },
  { label: "same bot with an uncertain send", actorId: "U_ONE", bindingId: "pair-1", allowed: false, bot: true },
  { label: "old same-bot follower backs off", actorId: "U_ONE", bindingId: "pair-1", allowed: false, bot: true, old: true },
  { label: "another bot during an uncertain send", actorId: "U_TWO", bindingId: "pair-1", allowed: true, bot: true },
])("only an older matching author blocks $label", async ({ actorId, bindingId, allowed, wake, bot, old }) => {
  const db = getDb();
  const older = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_ORDER_OLDER" }));
  await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_ORDER_NEWER" }));
  const otherAuthor = await enqueueSlackVerifiedIngress(receipt({ ...aad, providerEventId: "Ev_ORDER_OTHER" }));
  let clock = new Date(now);
  for (let n = 0; n < 3; n++) {
    const claim = await claimSlackVerifiedIngressHead({ db, leaseOwner: "older", leaseMs: 30_000, now: () => clock });
    assert.equal(claim?.event.id, older.id);
    await deferUnrecognizedSlackIngressClaim({ db, partitionId: claim!.partition.id, eventId: older.id,
      leaseOwner: "older", leaseGeneration: claim!.event.leaseGeneration, now: () => clock,
      retryAt: new Date(clock.getTime() + 1_000), reason: bot ? "bot_outbound_pending" : "actor_identity_pending",
      pendingAuthor: { installId: "install-1", workspaceId: aad.providerAuthorityId, bindingId: "pair-1", actorId: "U_ONE" },
      validatePendingAuthor: async () => true });
    clock = new Date(clock.getTime() + 1_001);
  }
  if (old) clock = new Date(now.getTime() + 2 * 60 * 60_000);
  if (wake) {
    const { slackIngressAuthorWakeSignals } = await import("../db/schema");
    await db.insert(slackIngressAuthorWakeSignals).values({ registrationId: aad.registrationId,
      installId: "install-1", workspaceId: aad.providerAuthorityId, bindingId: "pair-1", actorId: "U_ONE",
      signaledAt: clock, expiresAt: new Date(clock.getTime() + 86_400_000) });
  }
  const [owner] = await db.insert(users).values({ email: `order-${randomUUID()}@example.test`, name: "order", passwordHash: "test-only" }).returning();
  const server = await createServer("Order", `order-${randomUUID()}`, owner.id);
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: "order", type: "channel" }).returning();
  const claim = await claimSlackVerifiedIngressHead({ db, leaseOwner: "newer", leaseMs: 30_000, now: () => clock });
  assert.ok(claim);
  const request = { db, partitionId: claim.partition.id, eventId: claim.event.id,
    leaseOwner: "newer", leaseGeneration: claim.event.leaseGeneration, now: () => clock, orderedActorId: actorId,
    authority: { provider: "slack", environment: "test" as const, appRegistrationId: aad.registrationId, installId: "install-1",
      workspaceId: aad.providerAuthorityId, providerAuthorityId: aad.providerAuthorityId,
      providerConversationId: aad.providerConversationId!, bindingId, bindingEpoch: 1, connectionEpoch: 1,
      runtimeRevision: "revision", raftChannelId: channel.id, privacyClass: "public" as const },
    normalizedPayloadDigest: "a".repeat(64), encryptedPayload: "sealed", envelopeKeyId: "key", payloadSchemaVersion: 1 as const,
    payloadExpiresAt: new Date(clock.getTime() + 60_000), validateCurrentAuthority: async () => true };
  assert.equal(await materializeSlackVerifiedIngressClaim(request), allowed ? true : "author_wait");
  assert.equal((await db.select().from(externalInboundEvents)).length, allowed ? 1 : 0);
  if (!allowed) {
    const waiting = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, claim.event.id));
    assert.equal(waiting[0]?.state, "held"); assert.ok(waiting[0]?.encryptedPayload);
    assert.equal(waiting[0]?.outcomeReason, bot ? "bot_outbound_pending" : "actor_identity_pending");
    if (old) assert.equal(waiting[0]?.nextAttemptAt.getTime(), clock.getTime() + 30 * 60_000);
    const next = await claimSlackVerifiedIngressHead({ db, leaseOwner: "other", leaseMs: 30_000, now: () => clock });
    assert.equal(next?.event.id, otherAuthor.id, "an unrelated author is not stuck behind the held follower");
    assert.equal(await materializeSlackVerifiedIngressClaim({ ...request, eventId: next!.event.id, leaseOwner: "other",
      leaseGeneration: next!.event.leaseGeneration, orderedActorId: "U_OTHER" }), true);
  }
});

test("a failed author-refresh hint cannot lose custody or repeat on a normal retry", async () => {
  const db = getDb();
  const body = JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId,
    event_id: aad.providerEventId, event: { type: "message", channel: aad.providerConversationId, user: "U_MISSING", text: "body" } });
  const stored = await enqueueSlackVerifiedIngress(receipt(aad, body));
  let clock = new Date(now); let refreshes = 0; let reported = 0;
  const tick = () => processVerifiedSlackIngressOnce({ db, leaseOwner: "refresh-hint", leaseMs: 30_000, now: () => clock,
    prepare: async () => ({ kind: "unrecognized", reason: "actor_identity_pending", pendingAuthor: {
      installId: "install", workspaceId: aad.providerAuthorityId, bindingId: "binding", actorId: "U_MISSING" },
      validatePendingAuthor: async () => true }),
    requestAuthorRefresh: async () => { refreshes++; throw new Error("synthetic provider outage"); },
    onAuthorRefreshError: () => { reported++; throw new Error("synthetic reporter outage"); },
    crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } });
  assert.equal((await tick()).kind, "deferred"); await Promise.resolve();
  assert.equal(refreshes, 1); assert.equal(reported, 1);
  clock = new Date(clock.getTime() + 1_001);
  assert.equal((await tick()).kind, "deferred"); await Promise.resolve();
  assert.equal(refreshes, 1, "ordinary retries must not flood provider refresh");
  const [saved] = await db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, stored.id));
  assert.ok(saved.encryptedPayload); assert.equal(saved.state, "queued");
});
