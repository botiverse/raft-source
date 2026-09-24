import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { afterEach, beforeEach, test } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import {
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalInboundEvents,
  externalMessageLinks,
  externalReactionFacts,
  externalReactionStates,
  messageReactionDiscussionVersions,
  messages,
  servers,
  users,
} from "../db/schema.js";
import { applyExternalReactionObservation } from "./externalReactionSyncService.js";
import { processExternalInboundEventOnce } from "./externalInboundWorkerService.js";
import { listReactionActors } from "./messageReactionService.js";
import { listMessagesByIds } from "./messageService.js";

beforeEach(async () => { await initDatabase("pglite://"); });
afterEach(async () => { await closeDatabase(); });

async function fixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `reaction-${randomUUID()}@raft.test`,
    name: `reaction-${randomUUID()}`,
    passwordHash: "test",
  }).returning();
  const [clock] = await db.select({ value: sql<string>`now()::text` }).from(users).limit(1);
  const now = new Date(clock.value);
  const [server] = await db.insert(servers).values({
    name: "Reaction server",
    slug: `reaction-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "reactions",
    type: "channel",
  }).returning();
  const [root, reply] = await db.insert(messages).values([
    { channelId: channel.id, senderType: "user", senderId: owner.id, content: "root", messageType: "chat" },
    { channelId: channel.id, senderType: "user", senderId: owner.id, content: "reply", messageType: "chat" },
  ]).returning();
  const [actor] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "T_WORKSPACE",
    externalActorId: "U_EXTERNAL",
    displayName: "External Reactor",
    handles: ["external"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: now,
  }).returning();
  await db.insert(externalAddressabilityProjections).values({
    projectionId: actor.id,
    provider: "slack",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "T_WORKSPACE",
    connectionEpoch: 1,
    bindingId: "binding-1",
    bindingEpoch: 1,
    conversationId: "C_CHANNEL",
    memberRevision: 1,
    contextRevision: 1,
    state: "active",
    observedAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
  });
  const links = await db.insert(externalMessageLinks).values([
    {
      provider: "slack", installId: "install-1", providerAuthorityId: "T_WORKSPACE",
      providerConversationId: "C_CHANNEL", providerMessageId: "1788571200.000100",
      bindingId: "binding-1", bindingEpoch: 1, connectionEpoch: 1, raftMessageId: root.id,
      firstDirection: "raft_outbound", payloadFingerprint: "a".repeat(64),
      outcomeState: "accepted", authorityState: "active",
    },
    {
      provider: "slack", installId: "install-1", providerAuthorityId: "T_WORKSPACE",
      providerConversationId: "C_CHANNEL", providerMessageId: "1788571200.000200",
      providerThreadId: "1788571200.000100",
      bindingId: "binding-1", bindingEpoch: 1, connectionEpoch: 1, raftMessageId: reply.id,
      raftCanonicalRootMessageId: root.id,
      firstDirection: "raft_outbound", payloadFingerprint: "b".repeat(64),
      outcomeState: "accepted", authorityState: "active",
    },
  ]).returning();
  return { db, actor, root, reply, links, now };
}

async function event(state: Awaited<ReturnType<typeof fixture>>, providerEventId: string) {
  const [created] = await state.db.insert(externalInboundEvents).values({
    provider: "slack",
    environment: "test",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "T_WORKSPACE",
    providerAuthorityId: "T_WORKSPACE",
    providerConversationId: "C_CHANNEL",
    providerEventId,
    bindingId: "binding-1",
    bindingEpoch: 1,
    connectionEpoch: 1,
    runtimeRevision: "runtime-1",
    raftChannelId: state.root.channelId,
    privacyClass: "public",
    status: "queued",
    normalizedPayloadDigest: "c".repeat(64),
    encryptedPayload: "sealed",
    envelopeKeyId: "key-1",
    payloadAadPurpose: "external-inbound-normalized-event",
    payloadAadVersion: 1,
    payloadSchemaVersion: 3,
    payloadExpiresAt: new Date(state.now.getTime() + 60_000),
    receivedAt: state.now,
    updatedAt: state.now,
  }).returning();
  return created;
}

async function apply(state: Awaited<ReturnType<typeof fixture>>, input: {
  id: string;
  operation: "add" | "remove";
  sequence: number;
  providerMessageId?: string;
  actorId?: string;
  reaction?: string;
}) {
  const inbound = await event(state, input.id);
  return state.db.transaction((tx) => applyExternalReactionObservation({
    tx,
    inboundEventId: inbound.id,
    providerEventId: input.id,
    operation: input.operation,
    providerMessageId: input.providerMessageId ?? "1788571200.000100",
    externalActorId: input.actorId ?? state.actor.externalActorId,
    providerReactionKey: input.reaction ?? "thumbsup",
    eventOccurredAt: new Date(state.now.getTime() + input.sequence),
    eventSequence: 1_788_571_200_000_000 + input.sequence,
    botUserId: "U_BOT",
    now: state.now,
  }));
}

async function enqueueWorkerReaction(state: Awaited<ReturnType<typeof fixture>>, input: {
  id: string;
  operation: "add" | "remove";
  sequence: number;
  reaction?: string;
  actorId?: string;
}) {
  const payload = JSON.stringify({
    schema: "external-inbound-normalized-reaction.v1",
    operation: input.operation,
    providerMessageId: "1788571200.000100",
    externalActorId: input.actorId ?? "U_EXTERNAL",
    providerReactionKey: input.reaction ?? "eyes",
    eventOccurredAt: new Date(state.now.getTime() + input.sequence).toISOString(),
    eventSequence: 1_788_571_201_000_000 + input.sequence,
    botUserId: "U_BOT",
  });
  const [inbound] = await state.db.insert(externalInboundEvents).values({
    provider: "slack",
    environment: "test",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "T_WORKSPACE",
    providerAuthorityId: "T_WORKSPACE",
    providerConversationId: "C_CHANNEL",
    providerEventId: input.id,
    bindingId: "binding-1",
    bindingEpoch: 1,
    connectionEpoch: 1,
    runtimeRevision: "runtime-1",
    raftChannelId: state.root.channelId,
    privacyClass: "public",
    status: "queued",
    normalizedPayloadDigest: createHash("sha256").update(payload).digest("hex"),
    encryptedPayload: "sealed",
    envelopeKeyId: "key-1",
    payloadAadPurpose: "external-inbound-normalized-event",
    payloadAadVersion: 1,
    payloadSchemaVersion: 3,
    payloadExpiresAt: new Date(state.now.getTime() + 60_000),
    receivedAt: state.now,
    updatedAt: state.now,
  }).returning();
  return { inbound, payload };
}

test("external human add/noop/remove/stale/equal-conflict preserves causal presence and versions", async () => {
  const state = await fixture();
  assert.deepEqual(await apply(state, { id: "Ev1", operation: "add", sequence: 100 }), {
    outcome: "applied", changed: true, raftMessageId: state.root.id,
  });
  assert.equal((await apply(state, { id: "Ev2", operation: "add", sequence: 200 })).outcome, "noop");
  assert.equal((await apply(state, { id: "Ev3", operation: "remove", sequence: 400 })).outcome, "applied");
  assert.equal((await apply(state, { id: "Ev4", operation: "add", sequence: 300 })).outcome, "stale");
  assert.equal((await apply(state, { id: "Ev5", operation: "add", sequence: 400 })).outcome, "quarantined");
  const [current] = await state.db.select().from(externalReactionStates);
  assert.equal(current.present, false);
  assert.equal(current.lastProviderEventId, "Ev3");
  const [version] = await state.db.select().from(messageReactionDiscussionVersions);
  assert.equal(version.version, 2);
  assert.deepEqual((await state.db.select().from(externalReactionFacts)).map((fact) => fact.outcome), [
    "applied", "noop", "applied", "stale", "quarantined",
  ]);
});

test("reply reaction targets its own exact link and bot echo creates no external actor state", async () => {
  const state = await fixture();
  const reply = await apply(state, {
    id: "EvReply", operation: "add", sequence: 100,
    providerMessageId: "1788571200.000200",
  });
  assert.equal(reply.raftMessageId, state.reply.id);
  const echo = await apply(state, {
    id: "EvBot", operation: "add", sequence: 200,
    actorId: "U_BOT",
  });
  assert.equal(echo.outcome, "bot_echo");
  const states = await state.db.select().from(externalReactionStates);
  assert.equal(states.length, 1);
  assert.equal(states[0]!.raftMessageId, state.reply.id);
  const [echoFact] = await state.db.select().from(externalReactionFacts)
    .where(eq(externalReactionFacts.providerEventId, "EvBot"));
  assert.equal(echoFact.projectionId, null);
});

test("schema-v3 inbound worker decrypts and atomically terminalizes one reaction observation", async () => {
  const state = await fixture();
  const { inbound, payload } = await enqueueWorkerReaction(state, {
    id: "EvWorker",
    operation: "add",
    sequence: 100,
  });
  const published: Array<{ eventId: string; messageId: string }> = [];
  const result = await processExternalInboundEventOnce({
    db: state.db,
    leaseOwner: "reaction-inbound-worker",
    dependencies: {
      now: () => state.now,
      async decryptNormalizedPayload() { return payload; },
      async resolveCurrentRuntime({ frozenAuthority, requiredCapabilities }) {
        assert.deepEqual(requiredCapabilities, ["reaction_sync"]);
        return frozenAuthority;
      },
      onReactionCommitted(input) { published.push(input); },
    },
  });
  assert.deepEqual(result, { kind: "committed", eventId: inbound.id, messageId: state.root.id });
  const [closed] = await state.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, inbound.id));
  assert.equal(closed.status, "committed");
  assert.equal(closed.encryptedPayload, null);
  assert.equal((await state.db.select().from(externalReactionStates)).length, 1);
  assert.deepEqual(published, [{ eventId: inbound.id, messageId: state.root.id }]);
});

test("reaction realtime emits only for changed durable state and socket failure never replays", async () => {
  const state = await fixture();
  const published: Array<{ eventId: string; messageId: string }> = [];
  const errors: unknown[] = [];
  const run = async (input: { id: string; operation: "add" | "remove"; sequence: number }) => {
    const { inbound, payload } = await enqueueWorkerReaction(state, input);
    const result = await processExternalInboundEventOnce({
      db: state.db,
      leaseOwner: `reaction-inbound-${input.id}`,
      dependencies: {
        now: () => state.now,
        async decryptNormalizedPayload() { return payload; },
        async resolveCurrentRuntime({ frozenAuthority }) { return frozenAuthority; },
        async onReactionCommitted(event) {
          published.push(event);
          if (input.id === "EvRealtimeRemove") throw new Error("socket unavailable");
        },
        onReactionCommittedError(error) { errors.push(error); },
      },
    });
    return { inbound, result };
  };

  const added = await run({ id: "EvRealtimeAdd", operation: "add", sequence: 100 });
  assert.equal(added.result.kind, "committed");
  const noop = await run({ id: "EvRealtimeNoop", operation: "add", sequence: 200 });
  assert.equal(noop.result.kind, "committed");
  const removed = await run({ id: "EvRealtimeRemove", operation: "remove", sequence: 300 });
  assert.equal(removed.result.kind, "committed");

  assert.deepEqual(published, [
    { eventId: added.inbound.id, messageId: state.root.id },
    { eventId: removed.inbound.id, messageId: state.root.id },
  ]);
  assert.equal(errors.length, 1);
  const closed = await state.db.select({ id: externalInboundEvents.id, status: externalInboundEvents.status })
    .from(externalInboundEvents);
  assert.deepEqual(closed.map((row) => row.status), ["committed", "committed", "committed"]);
  const [reaction] = await state.db.select().from(externalReactionStates);
  assert.equal(reaction.present, false);
});

test.each(["current", "expired"])("reaction actor read model exposes only %s addressability without inventing a Raft principal", async (addressability) => {
  const state = await fixture();
  await apply(state, { id: "EvRead", operation: "add", sequence: 100, reaction: "eyes" });
  const [message] = await listMessagesByIds([state.root.id]);
  assert.deepEqual(message.reactions, [{
    emoji: "👀",
    count: 1,
    reactorIds: [state.actor.id],
    reactorNames: ["External Reactor"],
  }]);
  if (addressability === "expired") {
    await state.db.update(externalAddressabilityProjections).set({
      observedAt: sql`now() - interval '2 minutes'`,
      expiresAt: sql`now() - interval '1 minute'`,
    }).where(eq(externalAddressabilityProjections.projectionId, state.actor.id));
  }
  const priorSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "reaction-read-test-secret";
  try {
    const page = await listReactionActors({
      principalId: randomUUID(),
      serverId: randomUUID(),
      parentScope: { kind: "channel", id: state.root.channelId },
      messageId: state.root.id,
      emoji: "👀",
      limit: 100,
      visibleActorIds: { users: [], agents: [] },
    });
    assert.deepEqual(page.actors, addressability === "expired" ? [] : [{
      actorRef: { kind: "external_projection", id: state.actor.id },
      name: "External Reactor",
      displayName: "External Reactor",
    }]);
  } finally {
    if (priorSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = priorSecret;
  }
});
