import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { and, eq, sql } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import {
  agents,
  channelAgents,
  inboxNotificationFacts,
  channelHumans,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppInstallGrantReceipts,
  externalAppInstalls,
  externalAppManifestReceipts,
  externalAppRegistrations,
  externalChannelBindings,
  externalDeliveryAttempts,
  externalDeliveryOperatorDecisions,
  externalOutboundDeliveries,
  externalInboundEvents,
  slackVerifiedIngressEvents,
  externalMessageLinks,
  externalMentionFacts,
  messages,
  messageMentions,
  users,
} from "../db/schema";
import { consumeExternalDeliverySkipDecision, __setExternalDeliveryAttemptRowLockHookForTests } from "./externalDeliveryWorkerService";
import { enqueueSlackBridgeOutboundDelivery, mintSlackBridgeReconciliationMarker, type SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService";
import { type SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import { deleteFeatureFlagRule } from "./featureFlagService";
import { createSlackDatabaseInboundWorkerRuntimeResolver, createSlackDatabaseIngressRuntimeResolver } from "./slackBridgeDatabaseRuntimeAuthority";
import { slackBridgeInstallGrantHash } from "./slackBridgeInstallGrantService";
import { resetStorageForTests } from "./storageService";
import { NOW, EXPIRES, fixture, resolveCurrentOutboundAuthorityOrNull } from "./slackBridgeDatabaseRuntimeAuthority.testkit";

afterEach(async () => {
  __setExternalDeliveryAttemptRowLockHookForTests(null);
  resetStorageForTests();
  await closeTestDatabase();
});

test("RFC 082 §4.6: a verified edit of a card message's copy is our echo only at its link's current epoch and from this installation's bot", async () => {
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const { enableTestSlackIngress, enableTestSlackBotProtocol } = await import("../test/integration/slackIngressRollout");
  const surface = await fixture("public");
  await enableTestSlackIngress();
  await enableTestSlackBotProtocol();
  const prepare = createSlackVerifiedIngressPreparer({
    db: surface.db, botSyncEnabled: true, now: () => NOW,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db),
    payloadSealer: { async sealNormalizedPayload() { return { encryptedPayload: "sealed-for-test", envelopeKeyId: "test-key", aadVersion: 1 }; } },
  });
  const appId = surface.registration.providerAppId;
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const,
    registrationId: surface.registration.id, environment: "test" as const, providerAppId: appId,
    providerAuthorityId: surface.install.providerAuthorityId, providerConversationId: surface.binding.providerConversationId,
    providerEventId: "Ev_CARD_EDIT" };
  const ts = "1785758340.000700";
  const [card] = await surface.db.insert(messages).values({ channelId: surface.channel.id, senderType: "user",
    senderId: surface.owner.id, content: "Build 1.19.0 · Ready", messageType: "chat",
    actionMetadata: { kind: "message-card", revision: 2, updatedAt: NOW.toISOString(),
      card: { version: 1, root: "t", elements: { t: { type: "Text", props: { text: "Ready" } } } } } }).returning();
  const [link] = await surface.db.insert(externalMessageLinks).values({ provider: "slack", installId: surface.install.id,
    providerAuthorityId: surface.install.providerAuthorityId, providerConversationId: surface.binding.providerConversationId,
    providerMessageId: ts, bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch,
    connectionEpoch: surface.install.connectionEpoch, raftMessageId: card.id, firstDirection: "raft_outbound",
    payloadFingerprint: "c".repeat(64), outcomeState: "accepted", authorityState: "active" }).returning();
  const edit = (message: Record<string, unknown>) => ({ type: "event_callback", api_app_id: appId, team_id: aad.providerAuthorityId,
    event_id: aad.providerEventId, event: { type: "message", subtype: "message_changed", channel: aad.providerConversationId,
      ts: "1785758400.000701", message: { ts, text: "Ready", edited: { ts: "1785758400.000701" }, ...message } } });
  const ownBot = { bot_id: "B_RUNTIME_BOT", app_id: appId,
    metadata: { event_type: "raft_message", event_payload: { card_revision: 2 } } };

  assert.partialDeepStrictEqual(await prepare(edit(ownBot), aad, NOW), { kind: "skip", reason: "provider_self_echo" },
    "a legitimate own edit is our echo: no loop");
  const copied = { bot_id: "B_COPYCAT", app_id: "A_COPYCAT", metadata: ownBot.metadata };
  assert.equal((await prepare(edit({ ...copied, ts: "1785758340.000800" }), aad, NOW)).kind, "materialize",
    "another bot's message carrying a copied card_revision marker is that bot's message, not our echo");
  assert.notEqual((await prepare(edit(copied), aad, NOW)).kind, "skip", "another bot is never our echo, even on our ts");
  assert.partialDeepStrictEqual(await prepare(edit({ app_id: appId }), aad, NOW), { kind: "unrecognized", reason: "bot_identity_pending" },
    "Slack does not name our installation's bot: retained, never discarded as an echo");
  await surface.db.update(externalMessageLinks).set({ bindingEpoch: surface.binding.bindingEpoch - 1 })
    .where(eq(externalMessageLinks.id, link.id));
  assert.partialDeepStrictEqual(await prepare(edit(ownBot), aad, NOW), { kind: "unrecognized", reason: "bot_identity_pending" },
    "a wrong binding epoch is not our echo");
  await surface.db.update(messages).set({ actionMetadata: null }).where(eq(messages.id, card.id));
  assert.partialDeepStrictEqual(await prepare(edit(ownBot), aad, NOW), { kind: "skip", reason: "provider_self_echo" },
    "an ordinary bridged message keeps its exact-receipt echo across epochs");
});

test("verified Slack preparer resolves current human authority and rejects an actor revoked before materialization", async () => {
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const surface = await fixture("public");
  let plaintext = "";
  const prepare = createSlackVerifiedIngressPreparer({
    db: surface.db,
    botSyncEnabled: true,
    now: () => NOW,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db),
    payloadSealer: { async sealNormalizedPayload(input) {
      plaintext = input.plaintext;
      return { encryptedPayload: "sealed-for-test", envelopeKeyId: "test-key", aadVersion: 1 };
    } },
  });
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const,
    registrationId: surface.registration.id, environment: "test" as const,
    providerAppId: surface.registration.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, providerEventId: "Ev_PREPARE" };
  const envelope = { type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId,
    event_id: aad.providerEventId, event: { type: "message", channel: aad.providerConversationId,
      user: surface.projection.externalActorId, ts: "1785758340.000001", text: "verified body" } };
  const prepared = await prepare(envelope, aad, NOW);
  assert.equal(prepared.kind, "materialize");
  if (prepared.kind !== "materialize") throw new Error("expected materialization");
  assert.equal(JSON.parse(plaintext).content, "verified body");
  assert.equal(await surface.db.transaction(tx => prepared.validateCurrentAuthority(tx, prepared.authority, NOW)), true);
  await surface.db.update(externalActorProjections).set({ deactivated: true })
    .where(eq(externalActorProjections.id, surface.projection.id));
  assert.equal(await surface.db.transaction(tx => prepared.validateCurrentAuthority(tx, prepared.authority, NOW)), false);
  const historical = await prepare(envelope, aad, NOW);
  assert.equal(historical.kind, "materialize", "verified history may be prepared again without restoring sender access");
  const departedReaction = { ...envelope, event: { type: "reaction_added", user: surface.projection.externalActorId,
    reaction: "thumbsup", event_ts: "1785758341.000001", item: { type: "message", channel: aad.providerConversationId, ts: "1785758340.000001" } } };
  assert.partialDeepStrictEqual(await prepare(departedReaction, aad, NOW), { kind: "unrecognized", reason: "actor_identity_pending" },
    "one departed actor reaction must not wait forever at the head");
  // A materializing bot path is available only after the verified-ingress
  // protocol-2 gate, even when the per-process feature flag is true.
  const { enableTestSlackIngress, enableTestSlackBotProtocol } = await import("../test/integration/slackIngressRollout");
  await enableTestSlackIngress();
  await enableTestSlackBotProtocol();
  const bot = { ...envelope, event: { ...envelope.event, subtype: "bot_message", bot_id: "B_OTHER" } };
  const disabledPreparer = createSlackVerifiedIngressPreparer({ db: surface.db, now: () => NOW,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db),
    payloadSealer: { async sealNormalizedPayload() { throw new Error("disabled producer must not seal"); } } });
  assert.partialDeepStrictEqual(await disabledPreparer(bot, aad, NOW), { kind: "skip", reason: "provider_bot_sync_disabled" });
  const botPrepared = await prepare(bot, aad, NOW);
  assert.equal(botPrepared.kind, "materialize");
  assert.equal(JSON.parse(plaintext).schema, "external-inbound-normalized-event.v4");
  assert.equal(JSON.parse(plaintext).externalActorId, "B_OTHER");
  // Simulate the future protocol-3 floor in this disposable database only.
  // This reader release supplies no operator path to raise the floor.
  await surface.db.execute(sql`UPDATE slack_verified_ingress_rollout SET minimum_writer_protocol = 3,
    generation = generation + 1, config_generation = config_generation + 1 WHERE id = 1`);
  const botAtThree = await prepare(bot, aad, NOW);
  assert.equal(botAtThree.kind, "materialize", "protocol 3 retains protocol 2 bot behavior");
  if (botAtThree.kind !== "materialize") throw new Error("expected protocol-3 materialization");
  assert.equal(await surface.db.transaction(tx => botAtThree.validateCurrentAuthority(tx, botAtThree.authority, NOW)), true);
  const selfBot = { ...envelope, event: { ...envelope.event, subtype: "bot_message", bot_id: "B_RUNTIME_BOT" } };
  assert.equal((await prepare(selfBot, aad, NOW)).kind, "skip");
  for (const subtype of ["channel_join", "channel_topic", "thread_broadcast", "message_deleted"]) {
    assert.deepEqual(await prepare({ ...envelope, event: { ...envelope.event, subtype } }, aad, NOW),
      { kind: "skip", reason: "unsupported_message_subtype" });
  }
  const unknown = { ...envelope, event: { ...envelope.event, user: "U_NOT_IN_DIRECTORY" } };
  assert.partialDeepStrictEqual(await prepare(unknown, aad, NOW), { kind: "unrecognized", reason: "actor_identity_pending" });
  await deleteFeatureFlagRule(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, surface.masterRule.id);
  assert.deepEqual(await prepare(unknown, aad, NOW), { kind: "wait", reason: "bridge_disabled" },
    "unknown individual events must not overtake a bridge-wide pause");
});

test.each(["other", "self", "disabled"] as const)("verified Slack bots: %s sender follows current identity and custody", async (sender) => {
  const { enableTestSlackIngress } = await import("../test/integration/slackIngressRollout");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const { processExternalInboundEventOnce } = await import("./externalInboundWorkerService");
  const surface = await fixture("public");
  if (sender === "other") {
    const [mentionedBot] = await surface.db.insert(externalActorProjections).values({ provider: "slack",
      appRegistrationId: surface.registration.id, installId: surface.install.id, workspaceId: surface.install.providerAuthorityId,
      externalActorId: "UBOTUSER", displayName: "Other bot", handles: ["otherbot"], actorKind: "remote",
      projectionRevision: 1, observedAt: NOW }).returning();
    await surface.db.insert(externalAddressabilityProjections).values({ projectionId: mentionedBot!.id, provider: "slack",
      appRegistrationId: surface.registration.id, installId: surface.install.id, workspaceId: surface.install.providerAuthorityId,
      connectionEpoch: surface.install.connectionEpoch, bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch,
      conversationId: surface.binding.providerConversationId, memberRevision: 1, contextRevision: 1,
      state: "active", observedAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000) });
  }
  await enableTestSlackIngress();
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const,
    registrationId: surface.registration.id, environment: "test" as const, providerAppId: surface.registration.providerAppId,
    providerAuthorityId: surface.install.providerAuthorityId, providerConversationId: surface.binding.providerConversationId,
    providerEventId: `Ev_BOT_${sender}` };
  const body = `synthetic ${sender} bot message${sender === "other" ? " <@UBOTUSER>" : ""}`;
  const bytes = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId,
    team_id: aad.providerAuthorityId, event_id: aad.providerEventId, event: { type: "message", subtype: "bot_message",
      channel: aad.providerConversationId, bot_id: sender === "self" ? "B_RUNTIME_BOT" : "BFOREIGN",
      username: surface.owner.name, ts: `${Math.floor(NOW.getTime() / 1000)}.001000`, text: body } }));
  const prepare = createSlackVerifiedIngressPreparer({ db: surface.db, now: () => NOW, botSyncEnabled: sender !== "disabled",
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db), payloadSealer: { async sealNormalizedPayload(input) {
      return { encryptedPayload: input.plaintext, envelopeKeyId: "synthetic-key", aadVersion: 1 };
    } } });
  const oldFloor = await prepare(JSON.parse(bytes.toString()), aad, NOW);
  assert.equal(oldFloor.kind, "skip", "protocol 1 keeps the old skip-only bot behavior even with the flag set");
  if (oldFloor.kind !== "skip" || !oldFloor.validate) throw new Error("expected guarded legacy skip");
  assert.equal(await surface.db.transaction(tx => oldFloor.validate!(tx, NOW, NOW)), true);
  await (await import("../test/integration/slackIngressRollout")).enableTestSlackBotProtocol();
  assert.equal(await surface.db.transaction(tx => oldFloor.validate!(tx, NOW, NOW)), false,
    "a prepared legacy skip cannot commit after the protocol-2 cutover");
  const key = Buffer.alloc(32, 8);
  await enqueueSlackVerifiedIngress({ db: surface.db, aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "key", now: NOW,
    validateEndpoint: async () => true });
  const hints: string[] = [];
  const result = await processVerifiedSlackIngressOnce({ db: surface.db, leaseOwner: "raw-bot", leaseMs: 30_000,
    now: () => NOW, scope: { registrationId: aad.registrationId, environment: aad.environment }, prepare,
    requestBotProfileRefresh: hint => { hints.push(hint.providerBotId); throw new Error("synthetic profile scheduler failure"); },
    crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } });
  assert.equal(result.kind, sender === "other" ? "materialized" : "discarded");
  assert.deepEqual(hints, sender === "other" ? ["BFOREIGN"] : []);
  if (sender === "disabled") {
    const [raw] = await surface.db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.providerEventId, aad.providerEventId));
    assert.equal(raw?.outcomeReason, "provider_bot_sync_disabled");
    assert.equal(raw?.encryptedPayload, null);
  }
  if (sender === "other") {
    const processInput = { db: surface.db, leaseOwner: "canonical-bot", durableSlackMode: true,
      providerScope: "slack" as const, dependencies: { now: () => NOW, decryptNormalizedPayload: async (input: { ciphertext: string }) => input.ciphertext,
        resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => NOW) } };
    let worker: Awaited<ReturnType<typeof processExternalInboundEventOnce>>;
    const pgUrl = process.env.CARDY_W3_REAL_PG_URL;
    if (pgUrl) {
      const audience = new pg.Client({ connectionString: pgUrl });
      const audienceErrors: Error[] = [];
      audience.on("error", error => audienceErrors.push(error));
      await audience.connect();
      try {
        await audience.query("BEGIN");
        const audiencePid = (await audience.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        await audience.query("SELECT id FROM external_channel_bindings WHERE id = $1 FOR UPDATE", [surface.binding.id]);
        const pending = processExternalInboundEventOnce(processInput).then(value => ({ value, error: null as unknown }),
          error => ({ value: null, error }));
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          blocked = (await audience.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked", [audiencePid])).rows[0]!.blocked;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(blocked, true, "inbound mention processing waits at the binding before author locks");
        await audience.query("SET LOCAL lock_timeout = '3s'");
        await audience.query("SELECT id FROM external_actor_projections WHERE install_id = $1 AND external_actor_id = $2 FOR UPDATE", [surface.install.id, "BFOREIGN"]);
        await audience.query("COMMIT");
        const result = await pending;
        if (result.error) throw result.error;
        assert.ok(result.value); worker = result.value;
      } finally {
        await audience.query("ROLLBACK").catch(() => {}); await audience.end();
        assert.deepEqual(audienceErrors, [], "unexpected inbound-race PostgreSQL client errors");
      }
    } else worker = await processExternalInboundEventOnce(processInput);
    assert.equal(worker.kind, "committed");
    const [receipt] = await surface.db.select().from(externalInboundEvents).where(eq(externalInboundEvents.providerEventId, aad.providerEventId));
    const delivered = await surface.db.select().from(messages).where(eq(messages.id, receipt!.committedMessageId!));
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!.content, /@otherbot/);
    assert.equal((await surface.db.select().from(externalMentionFacts).where(eq(externalMentionFacts.messageId, delivered[0]!.id))).length, 0,
      "bot targets stay non-clickable and non-notifying until the separate identity mapping work");
    assert.equal(delivered[0]!.senderType, "external_projection");
    const [actor] = await surface.db.select().from(externalActorProjections).where(eq(externalActorProjections.externalActorId, "BFOREIGN"));
    assert.equal(actor?.actorKind, "bot");
    assert.equal(actor?.displayName, "Slack bot · EIGN");
    assert.notEqual(actor?.displayName, surface.owner.name, "message override cannot impersonate the Raft user");
    assert.notEqual(delivered[0]!.senderId, surface.owner.id);
    // A profile refresh racing the next event must not stall its conversation.
    const nextAad = { ...aad, providerEventId: "Ev_BOT_PROFILE_RACE" };
    const nextEnvelope = JSON.parse(bytes.toString());
    nextEnvelope.event_id = nextAad.providerEventId;
    nextEnvelope.event.ts = `${Math.floor(NOW.getTime() / 1000)}.001001`;
    const nextBytes = Buffer.from(JSON.stringify(nextEnvelope));
    await enqueueSlackVerifiedIngress({ db: surface.db, aad: nextAad, rawDigest: createHash("sha256").update(nextBytes).digest("hex"),
      encryptedPayload: sealSlackVerifiedIngress({ bytes: nextBytes, key, aad: nextAad }), envelopeKeyId: "key", now: NOW,
      validateEndpoint: async () => true });
    const racedPrepare: typeof prepare = async (...args) => {
      const prepared = await prepare(...args);
      if (prepared.kind === "materialize") await surface.db.update(externalActorProjections)
        .set({ displayName: "Recorded Bot", projectionRevision: actor!.projectionRevision + 1 }).where(eq(externalActorProjections.id, actor!.id));
      return prepared;
    };
    const raceTick = () => processVerifiedSlackIngressOnce({ db: surface.db, leaseOwner: "raw-race", leaseMs: 30_000,
      now: () => NOW, scope: { registrationId: aad.registrationId, environment: aad.environment }, prepare: racedPrepare,
      crypto: { async seal() { throw new Error("unused"); }, async open(input) {
        return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
      } } });
    let raced = await raceTick();
    if (raced.kind === "empty") raced = await raceTick();
    assert.equal(raced.kind, "materialized");
    const racedCommit = await processExternalInboundEventOnce({ db: surface.db, leaseOwner: "canonical-race", durableSlackMode: true,
      providerScope: "slack", dependencies: { now: () => NOW, decryptNormalizedPayload: async input => input.ciphertext,
        resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => NOW) } });
    assert.equal(racedCommit.kind, "committed");
    const [racedReceipt] = await surface.db.select().from(externalInboundEvents).where(eq(externalInboundEvents.providerEventId, nextAad.providerEventId));
    assert.ok(racedReceipt?.committedMessageId);
    const { externalMessageAuthorFacts } = await import("../db/schema");
    const [recordedBefore] = await surface.db.select().from(externalMessageAuthorFacts)
      .where(eq(externalMessageAuthorFacts.messageId, racedReceipt.committedMessageId));
    assert.equal(recordedBefore?.displayName, "Recorded Bot");
    // A verified refresh improves fallback-only history without changing the
    // immutable fact or revealing a newer profile through a revoked pair.
    await surface.db.update(externalActorProjections).set({ displayName: "Formal Bot", projectionRevision: actor!.projectionRevision + 1 })
      .where(eq(externalActorProjections.id, actor!.id));
    const { loadExternalMessageAuthors } = await import("./externalProjectionService");
    const visible = (await loadExternalMessageAuthors([delivered[0]!.id], surface.db, NOW)).get(delivered[0]!.id);
    assert.equal(visible?.displayName, "Slack bot · EIGN");
    assert.equal(visible?.profileDisplayName, "Formal Bot");
    const formal = (await loadExternalMessageAuthors([racedReceipt.committedMessageId], surface.db, NOW)).get(racedReceipt.committedMessageId);
    assert.equal(formal?.displayName, "Recorded Bot");
    assert.equal(formal?.profileDisplayName, undefined, "non-fallback attribution must not be overlaid");
    const [recordedAfter] = await surface.db.select().from(externalMessageAuthorFacts)
      .where(eq(externalMessageAuthorFacts.messageId, racedReceipt.committedMessageId));
    assert.deepEqual(recordedAfter, recordedBefore, "profile refresh must not mutate the immutable author fact");
    await surface.db.update(externalChannelBindings).set({ state: "revoked", stateReason: "test_revoked" }).where(eq(externalChannelBindings.id, surface.binding.id));
    const revoked = (await loadExternalMessageAuthors([delivered[0]!.id], surface.db, NOW)).get(delivered[0]!.id);
    assert.equal(revoked?.profileDisplayName, undefined);
  }
});

test("the canonical writer refuses the installation's own Slack bot even if classification is bypassed", async () => {
  const { insertCanonicalExternalMessage } = await import("./externalProjectionService");
  const surface = await fixture("public");
  const [actor] = await surface.db.insert(externalActorProjections).values({ provider: "slack",
    appRegistrationId: surface.registration.id, installId: surface.install.id, workspaceId: surface.install.providerAuthorityId,
    externalActorId: surface.install.providerBotId!, displayName: "self bot", actorKind: "bot", projectionRevision: 1,
    observedAt: NOW }).returning();
  await assert.rejects(surface.db.transaction(tx => insertCanonicalExternalMessage({ executor: tx, channelId: surface.channel.id,
    content: "synthetic own echo", createdAt: NOW, projectionId: actor!.id, provider: "slack",
    appRegistrationId: surface.registration.id, installId: surface.install.id, workspaceId: surface.install.providerAuthorityId,
    externalActorId: surface.install.providerBotId!, externalConversationId: surface.binding.providerConversationId,
    externalMessageId: "1785758340.000999", actorProjectionRevision: 1 })), /cannot write the current Slack bridge bot/);
  assert.equal((await surface.db.select().from(messages).where(eq(messages.content, "synthetic own echo"))).length, 0);
});

test("bot formal profile refresh is scoped, asynchronous and does not use message overrides", async () => {
  const { createSlackBotProfileRefresher } = await import("./slackBotProfileRefresh");
  const surface = await fixture("public");
  const [actor] = await surface.db.insert(externalActorProjections).values({ provider: "slack",
    appRegistrationId: surface.registration.id, installId: surface.install.id, workspaceId: surface.install.providerAuthorityId,
    externalActorId: "B12345", displayName: "Slack bot · 2345", actorKind: "bot", projectionRevision: 1, observedAt: NOW }).returning();
  let requestedIcon = "";
  const provider = { credentialResolver: { async resolve({ authority }: any) { return { schema: "slack-bridge-credential-lease.v1",
    leaseId: "synthetic-lease", installId: authority.installId, providerAppId: authority.providerAppId,
    providerAuthorityId: authority.providerAuthorityId, connectionEpoch: authority.connectionEpoch,
    credentialRevision: authority.credentialRevision, leaseExpiresAt: new Date(NOW.getTime() + 60_000) }; } },
    transport: { evidence: "double", async call(request: any) { assert.equal(request.method, "bots.info");
      return { kind: "response", status: 200, headers: {}, body: { ok: true, bot: { id: "B12345", user_id: "U12345", deleted: false,
        app_id: "AOTHER", name: "Official bot", icons: { image_72: "https://avatars.slack-edge.com/synthetic.png" } } } }; } },
    quarantineSink: { async quarantine() { return "already_fenced"; } }, async releaseCredential() {} } as unknown as SlackBridgeProviderRuntime;
  const refresher = createSlackBotProfileRefresher({ db: surface.db, provider, now: () => NOW,
    avatarMaterializer: { async materializeExternalProjection(input) { requestedIcon = input.sourceLocator ?? ""; return { kind: "authority_stale" }; } } });
  refresher.request({ serverId: surface.server.id, registrationId: surface.registration.id, installId: surface.install.id,
    bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch, connectionEpoch: surface.install.connectionEpoch,
    providerBotId: "B12345", projectionId: actor!.id, senderAppId: "AOTHER" });
  await refresher.stop();
  const [updated] = await surface.db.select().from(externalActorProjections).where(eq(externalActorProjections.id, actor!.id));
  assert.equal(updated?.displayName, "Official bot");
  assert.equal(updated?.projectionRevision, 2);
  assert.equal(updated?.slackBotUserId, "U12345");
  assert.equal(updated?.slackBotMappingRevision, 1);
  assert.equal(updated?.slackBotMappingConflict, false);
  assert.equal(requestedIcon, "https://avatars.slack-edge.com/synthetic.png");
  const [user] = await surface.db.insert(externalActorProjections).values({ provider: "slack",
    appRegistrationId: surface.registration.id, installId: surface.install.id, workspaceId: surface.install.providerAuthorityId,
    externalActorId: "U12345", displayName: "Official bot", handles: ["officialbot"], actorKind: "remote",
    projectionRevision: 1, observedAt: NOW }).returning();
  await surface.db.insert(externalAddressabilityProjections).values({ projectionId: user!.id, provider: "slack",
    appRegistrationId: surface.registration.id, installId: surface.install.id, workspaceId: surface.install.providerAuthorityId,
    connectionEpoch: surface.install.connectionEpoch, bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch,
    conversationId: surface.binding.providerConversationId, memberRevision: 1, contextRevision: 1,
    state: "active", observedAt: NOW, expiresAt: EXPIRES });
  const { readSlackBotMentionAuthority } = await import("./slackBotMentionAuthority");
  const context = { provider: "slack", appRegistrationId: surface.registration.id, installId: surface.install.id,
    workspaceId: surface.install.providerAuthorityId, connectionEpoch: surface.install.connectionEpoch, bindingId: surface.binding.id,
    bindingEpoch: surface.binding.bindingEpoch, conversationId: surface.binding.providerConversationId, memberRevision: 1, contextRevision: 1 };
  const read = (revision: number, now = NOW) => surface.db.transaction(tx => readSlackBotMentionAuthority({ executor: tx, context,
    botProjectionId: actor!.id, expectedMappingRevision: revision, now }));
  assert.equal(await read(1), null, "the initial floor cannot authorize a B snapshot");
  const { enableTestSlackIngress, enableTestSlackBotProtocol } = await import("../test/integration/slackIngressRollout");
  await enableTestSlackIngress();
  assert.equal(await read(1), null, "protocol 1 cannot authorize a B snapshot");
  await enableTestSlackBotProtocol();
  assert.equal(await read(1), null, "protocol 2 cannot authorize a B snapshot");
  const { resolveExternalMentionFromDurableAuthority, insertExternalMentionFact } = await import("./externalProjectionService");
  const beforeFloor = await surface.db.transaction(tx => resolveExternalMentionFromDurableAuthority({ executor: tx,
    rawHandle: "officialbot", explicitProjectionId: actor!.id, raftPrincipalCollision: false, now: NOW, context }));
  assert.equal(beforeFloor.kind, "not_resolved", "protocol 2 cannot create a notifiable B fact");
  const { getChannelExternalMembers } = await import("./channelService");
  const beforeRoster = await getChannelExternalMembers(surface.channel.id, NOW);
  assert.equal(beforeRoster.find(member => member.id === user!.id)?.mentionable, false,
    "the pre-cutover roster shows a display-only participant");
  assert.equal(beforeRoster.some(member => member.id === actor!.id), false);
  // Test-only simulation; no operational path to raise the floor is added here.
  await surface.db.execute(sql`UPDATE slack_verified_ingress_rollout SET minimum_writer_protocol = 3,
    generation = generation + 1, config_generation = config_generation + 1 WHERE id = 1`);
  assert.equal((await read(1))?.userId, "U12345");
  await surface.db.update(externalAppInstalls).set({ providerBotId: null }).where(eq(externalAppInstalls.id, surface.install.id));
  assert.equal(await read(1), null, "an unknown self bot ID cannot prove a foreign bot mapping");
  await surface.db.update(externalAppInstalls).set({ providerBotId: surface.install.providerBotId, botUserId: null }).where(eq(externalAppInstalls.id, surface.install.id));
  assert.equal(await read(1), null, "an unknown self user ID cannot prove a foreign bot mapping");
  await surface.db.update(externalAppInstalls).set({ botUserId: surface.install.botUserId }).where(eq(externalAppInstalls.id, surface.install.id));
  await surface.db.execute(sql`UPDATE external_app_install_grant_receipts SET observation_source = 'unverified' WHERE install_id = ${surface.install.id}`);
  assert.equal(await read(1), null, "an unverified receipt cannot establish the installation's own bot identity");
  await surface.db.execute(sql`UPDATE external_app_install_grant_receipts SET observation_source = 'token_introspection' WHERE install_id = ${surface.install.id}`);
  assert.equal((await read(1))?.userId, "U12345", "verified receipt restores the mapping");
  assert.equal(await read(1, new Date(NOW.getTime() + 60 * 60_000)), null, "expired mappings are display-only");
  await surface.db.update(externalActorProjections).set({ slackBotCredentialRevision: 2 }).where(eq(externalActorProjections.id, actor!.id));
  assert.equal(await read(1), null, "a stale credential revision cannot authorize a mention");
  await surface.db.update(externalActorProjections).set({ slackBotCredentialRevision: 1, slackBotScopeRevision: 2 }).where(eq(externalActorProjections.id, actor!.id));
  assert.equal(await read(1), null, "a stale scope revision cannot authorize a mention");
  await surface.db.update(externalActorProjections).set({ slackBotScopeRevision: 1 }).where(eq(externalActorProjections.id, actor!.id));
  await surface.db.update(externalActorProjections).set({ actorKind: "human" }).where(eq(externalActorProjections.id, user!.id));
  assert.equal(await read(1), null, "a human projection cannot stand in for the bot user");
  await surface.db.update(externalActorProjections).set({ actorKind: "remote" }).where(eq(externalActorProjections.id, user!.id));
  // Use a syntactically valid self ID and keep the synthetic auth.test
  // receipt consistent, so removing the self-user guard really can notify it.
  const [selfReceipt] = await surface.db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, surface.install.id));
  assert.ok(selfReceipt);
  const ownUserId = "UOWN123";
  await surface.db.update(externalAppInstalls).set({ botUserId: ownUserId }).where(eq(externalAppInstalls.id, surface.install.id));
  await surface.db.update(externalAppInstallGrantReceipts).set({ botUserId: ownUserId, grantHash: slackBridgeInstallGrantHash({
    providerAppId: selfReceipt.providerAppId, providerAuthorityId: selfReceipt.providerAuthorityId, botUserId: ownUserId,
    providerBotId: selfReceipt.providerBotId, grantedScopes: selfReceipt.grantedScopes }) }).where(eq(externalAppInstallGrantReceipts.id, selfReceipt.id));
  const [selfUser] = await surface.db.insert(externalActorProjections).values({ provider: "slack",
    appRegistrationId: surface.registration.id, installId: surface.install.id, workspaceId: surface.install.providerAuthorityId,
    externalActorId: ownUserId, displayName: "Own bot", handles: ["ownbot"], actorKind: "remote",
    projectionRevision: 1, observedAt: NOW }).returning();
  await surface.db.insert(externalAddressabilityProjections).values({ projectionId: selfUser!.id, provider: "slack",
    appRegistrationId: surface.registration.id, installId: surface.install.id, workspaceId: surface.install.providerAuthorityId,
    connectionEpoch: surface.install.connectionEpoch, bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch,
    conversationId: surface.binding.providerConversationId, memberRevision: 1, contextRevision: 1,
    state: "active", observedAt: NOW, expiresAt: EXPIRES });
  await surface.db.update(externalActorProjections).set({ slackBotUserId: ownUserId }).where(eq(externalActorProjections.id, actor!.id));
  assert.equal(await read(1), null, "our own bot user must not be notified even if it is a pair member");
  await surface.db.update(externalActorProjections).set({ slackBotUserId: "U12345" }).where(eq(externalActorProjections.id, actor!.id));
  await surface.db.delete(externalAddressabilityProjections).where(eq(externalAddressabilityProjections.projectionId, selfUser!.id));
  await surface.db.delete(externalActorProjections).where(eq(externalActorProjections.id, selfUser!.id));
  await surface.db.update(externalAppInstallGrantReceipts).set({ botUserId: selfReceipt.botUserId, grantHash: selfReceipt.grantHash })
    .where(eq(externalAppInstallGrantReceipts.id, selfReceipt.id));
  await surface.db.update(externalAppInstalls).set({ botUserId: surface.install.botUserId }).where(eq(externalAppInstalls.id, surface.install.id));
  const roster = await getChannelExternalMembers(surface.channel.id, NOW);
  const botRoster = roster.find(member => member.id === actor!.id);
  assert.equal(botRoster?.mentionable, true, "the verified bot can appear in the composer");
  assert.equal(botRoster?.displayName, "Official bot");
  assert.equal("externalActorId" in (botRoster ?? {}), false, "provider identifiers remain private");
  assert.equal(await read(2), null, "a frozen mapping version cannot authorize a later mapping");
  const realPgForAudienceRace = process.env.CARDY_W3_REAL_PG_URL;
  if (realPgForAudienceRace) {
    const audience = new pg.Client({ connectionString: realPgForAudienceRace });
    const audienceErrors: Error[] = [];
    audience.on("error", error => audienceErrors.push(error));
    await audience.connect();
    try {
      await audience.query("BEGIN");
      const audiencePid = (await audience.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await audience.query("SELECT id FROM external_channel_bindings WHERE id = $1 FOR UPDATE", [surface.binding.id]);
      const resolving = surface.db.transaction(tx => resolveExternalMentionFromDurableAuthority({ executor: tx,
        rawHandle: "officialbot", explicitProjectionId: actor!.id, raftPrincipalCollision: false, now: NOW, context }))
        .then(value => ({ value, error: null as unknown }), error => ({ value: null, error }));
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const result = await audience.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked", [audiencePid]);
        blocked = result.rows[0]!.blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true, "mention resolution must first wait on the audience binding");
      await audience.query("SET LOCAL lock_timeout = '3s'");
      await audience.query("SELECT id FROM external_addressability_projections WHERE projection_id = $1 FOR UPDATE", [user!.id]);
      await audience.query("COMMIT");
      const result = await resolving;
      if (result.error) throw result.error;
      assert.equal(result.value?.kind, "resolved", "both transactions finish without a lock cycle");
    } finally {
      await audience.query("ROLLBACK").catch(() => {});
      await audience.end();
      assert.deepEqual(audienceErrors, [], "unexpected audience-race PostgreSQL client errors");
    }
  }
  const mention = await surface.db.transaction(tx => resolveExternalMentionFromDurableAuthority({ executor: tx,
    rawHandle: "officialbot", explicitProjectionId: actor!.id, raftPrincipalCollision: false, now: NOW, context }));
  assert.equal(mention.kind, "resolved");
  if (mention.kind !== "resolved") throw new Error("the verified bot must resolve");
  assert.equal(mention.fact.externalActorId, "B12345");
  assert.equal(mention.fact.slackBotMappingRevision, 1);
  const outbound = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch, expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user", senderId: surface.owner.id, now: NOW, registrationId: surface.registration.id });
  assert.ok(outbound);
  const { message, snapshot } = await surface.db.transaction(async tx => {
    const [message] = await tx.insert(messages).values({ channelId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
      content: "hello @officialbot" }).returning();
    await insertExternalMentionFact({ executor: tx, messageId: message!.id, fact: mention.fact });
    const queued = await enqueueSlackBridgeOutboundDelivery({ executor: tx, message: message!,
      activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
        runtimePredicateRevision: outbound.runtimeRevision, bindingAuthority: outbound.neutral },
      canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
      authorName: surface.owner.displayName ?? surface.owner.name, sanitizedText: message!.content, mintReconciliationMarker: () => "M".repeat(43) });
    return { message: message!, snapshot: queued.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot };
  });
  assert.equal(snapshot.externalMentions[0]?.externalActorId, "B12345", "the durable snapshot keeps the bot identity");
  const { resolveCurrentSlackRenderMentions } = await import("./slackBridgeCurrentMentions");
  const { renderSlackBridgeText } = await import("./slackProviderAdapter");
  const render = () => surface.db.transaction(tx => resolveCurrentSlackRenderMentions(tx, snapshot, outbound.neutral, NOW));
  const rendered = await render();
  assert.equal(rendered.externalMentions[0]?.externalActorId, "U12345");
  assert.equal(renderSlackBridgeText({ ...snapshot, ...rendered }), "hello <@U12345>");
  assert.equal((await surface.db.select().from(externalMentionFacts).where(eq(externalMentionFacts.messageId, message.id)))[0]?.externalActorId, "B12345");
  assert.equal((await surface.db.select().from(messages).where(eq(messages.id, message.id)))[0]?.content, "hello @officialbot");
  await surface.db.update(externalMentionFacts).set({ slackBotMappingRevision: null }).where(eq(externalMentionFacts.messageId, message.id));
  assert.deepEqual((await render()).externalMentions, [], "a historical B fact without a frozen version stays literal");
  await surface.db.update(externalMentionFacts).set({ slackBotMappingRevision: 1 }).where(eq(externalMentionFacts.messageId, message.id));
  await surface.db.update(externalActorProjections).set({ slackBotMappingRevision: 2 }).where(eq(externalActorProjections.id, actor!.id));
  assert.deepEqual((await render()).externalMentions, [], "a changed mapping version becomes ordinary text");
  assert.equal(await read(1), null);
  assert.equal((await read(2))?.userId, "U12345");
  const pgUrl = process.env.CARDY_W3_REAL_PG_URL;
  if (pgUrl) {
    // Hold the actual mapping row while the service revalidates its frozen
    // version. Observe a real lock wait before committing a newer version.
    const holder = new pg.Client({ connectionString: pgUrl });
    const holderErrors: Error[] = [];
    holder.on("error", error => holderErrors.push(error));
    await holder.connect();
    try {
      await holder.query("BEGIN");
      const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await holder.query("SELECT id FROM external_actor_projections WHERE id = $1 FOR UPDATE", [actor!.id]);
      const pendingRead = read(2);
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const result = await holder.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked", [holderPid]);
        blocked = result.rows[0]!.blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true, "mapping revalidation must wait on the writer's row lock");
      await holder.query("UPDATE external_actor_projections SET slack_bot_mapping_revision = 3 WHERE id = $1", [actor!.id]);
      await holder.query("COMMIT");
      assert.equal(await pendingRead, null, "after the writer commits, the old frozen version cannot notify");
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
      assert.deepEqual(holderErrors, [], "unexpected mapping-race PostgreSQL client errors");
    }
    // Keep later assertions focused on membership and duplicate mapping.
    await surface.db.update(externalActorProjections).set({ slackBotMappingRevision: 2 }).where(eq(externalActorProjections.id, actor!.id));
  }
  await surface.db.update(externalAddressabilityProjections).set({ state: "removed" })
    .where(eq(externalAddressabilityProjections.projectionId, user!.id));
  assert.equal(await read(2), null, "a bot's mapped user must still be in the exact pair");
  await surface.db.update(externalAddressabilityProjections).set({ state: "active" })
    .where(eq(externalAddressabilityProjections.projectionId, user!.id));
  await surface.db.insert(externalActorProjections).values({ provider: "slack", appRegistrationId: surface.registration.id,
    installId: surface.install.id, workspaceId: surface.install.providerAuthorityId, externalActorId: "B67890",
    displayName: "Another bot", actorKind: "bot", projectionRevision: 1, observedAt: NOW,
    slackBotUserId: "U12345", slackBotMappingRevision: 1, slackBotConnectionEpoch: updated!.slackBotConnectionEpoch,
    slackBotCredentialRevision: updated!.slackBotCredentialRevision, slackBotScopeRevision: updated!.slackBotScopeRevision,
    slackBotMappingObservedAt: updated!.slackBotMappingObservedAt, slackBotMappingExpiresAt: updated!.slackBotMappingExpiresAt });
  assert.equal(await read(2), null, "two bot IDs claiming one user are never guessed");
  const replayHint = { serverId: surface.server.id, registrationId: surface.registration.id, installId: surface.install.id,
    bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch, connectionEpoch: surface.install.connectionEpoch,
    providerBotId: "B12345", projectionId: actor!.id, senderAppId: "AOTHER" };
  const sameTime = createSlackBotProfileRefresher({ db: surface.db, provider, now: () => NOW });
  sameTime.request(replayHint);
  await sameTime.stop();
  let [afterTie] = await surface.db.select().from(externalActorProjections).where(eq(externalActorProjections.id, actor!.id));
  assert.equal(afterTie?.slackBotUserId, null, "a same-time response invalidates the ambiguous mapping");
  assert.equal(afterTie?.slackBotMappingRevision, 3, "invalidation revokes frozen mapping versions");
  const sameTimeAgain = createSlackBotProfileRefresher({ db: surface.db, provider, now: () => NOW });
  sameTimeAgain.request(replayHint);
  await sameTimeAgain.stop();
  [afterTie] = await surface.db.select().from(externalActorProjections).where(eq(externalActorProjections.id, actor!.id));
  assert.equal(afterTie?.slackBotUserId, null, "a second equal-time response cannot revive a mapping");
  await surface.db.delete(externalActorProjections).where(eq(externalActorProjections.externalActorId, "B67890"));
  await surface.db.update(externalActorProjections).set({ slackBotUserId: "U12345", slackBotConnectionEpoch: updated!.slackBotConnectionEpoch,
    slackBotCredentialRevision: updated!.slackBotCredentialRevision, slackBotScopeRevision: updated!.slackBotScopeRevision,
    slackBotMappingObservedAt: updated!.slackBotMappingObservedAt, slackBotMappingExpiresAt: updated!.slackBotMappingExpiresAt,
    slackBotMappingConflict: false }).where(eq(externalActorProjections.id, actor!.id));
  assert.equal((await read(3))?.userId, "U12345", "fixture is valid before testing an unsupported floor");
  await surface.db.execute(sql`UPDATE slack_verified_ingress_rollout SET minimum_writer_protocol = 4,
    generation = generation + 1, config_generation = config_generation + 1 WHERE id = 1`);
  assert.equal(await read(3), null, "an unsupported future floor fails closed");
});

test.each(["deleted", "self_app"] as const)("bot profile refuses %s as a verified mapping", async scenario => {
  const { createSlackBotProfileRefresher } = await import("./slackBotProfileRefresh");
  const surface = await fixture("public");
  if (scenario === "self_app") {
    // The shared fixture's App ID has underscores and would be rejected by
    // bots.info parsing before exercising the self-app guard. Replace every
    // authority record with one syntactically valid, matching test identity.
    const appId = "ASELF123";
    await surface.db.update(externalAppRegistrations).set({ providerAppId: appId }).where(eq(externalAppRegistrations.id, surface.registration.id));
    await surface.db.update(externalAppInstalls).set({ providerAppId: appId }).where(eq(externalAppInstalls.id, surface.install.id));
    await surface.db.update(externalAppManifestReceipts).set({ providerAppId: appId }).where(eq(externalAppManifestReceipts.registrationId, surface.registration.id));
    const [receipt] = await surface.db.select().from(externalAppInstallGrantReceipts).where(eq(externalAppInstallGrantReceipts.installId, surface.install.id));
    assert.ok(receipt);
    await surface.db.update(externalAppInstallGrantReceipts).set({ providerAppId: appId, grantHash: slackBridgeInstallGrantHash({
      providerAppId: appId, providerAuthorityId: receipt.providerAuthorityId, botUserId: receipt.botUserId,
      providerBotId: receipt.providerBotId, grantedScopes: receipt.grantedScopes }) }).where(eq(externalAppInstallGrantReceipts.id, receipt.id));
  }
  const [actor] = await surface.db.insert(externalActorProjections).values({ provider: "slack",
    appRegistrationId: surface.registration.id, installId: surface.install.id, workspaceId: surface.install.providerAuthorityId,
    externalActorId: "BFOREIGN123", displayName: "Slack bot · N123", actorKind: "bot", projectionRevision: 1, observedAt: NOW }).returning();
  let calls = 0;
  const provider = { credentialResolver: { async resolve({ authority }: any) { return { schema: "slack-bridge-credential-lease.v1",
    leaseId: "synthetic-lease", installId: authority.installId, providerAppId: authority.providerAppId,
    providerAuthorityId: authority.providerAuthorityId, connectionEpoch: authority.connectionEpoch,
    credentialRevision: authority.credentialRevision, leaseExpiresAt: new Date(NOW.getTime() + 60_000) }; } },
    transport: { evidence: "double", async call() { calls++; return { kind: "response", status: 200, headers: {},
      body: { ok: true, bot: { id: "BFOREIGN123", user_id: "UFOREIGN123", deleted: scenario === "deleted",
        app_id: scenario === "self_app" ? "ASELF123" : "AOTHER", name: "A bot" } } }; } },
    quarantineSink: { async quarantine() { return "already_fenced"; } }, async releaseCredential() {} } as unknown as SlackBridgeProviderRuntime;
  const refresher = createSlackBotProfileRefresher({ db: surface.db, provider, now: () => NOW });
  refresher.request({ serverId: surface.server.id, registrationId: surface.registration.id, installId: surface.install.id,
    bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch, connectionEpoch: surface.install.connectionEpoch,
    providerBotId: "BFOREIGN123", projectionId: actor!.id, senderAppId: null });
  await refresher.stop();
  const [result] = await surface.db.select().from(externalActorProjections).where(eq(externalActorProjections.id, actor!.id));
  assert.equal(calls, 1, "the provider response must reach the verifier");
  assert.equal(result?.slackBotUserId, null, "deleted or self-app profiles cannot create a mapping");
  assert.equal(result?.slackBotMappingRevision, 0);
});

test("bot profile refresh reports the original error as a cause", async () => {
  const { createSlackBotProfileRefresher } = await import("./slackBotProfileRefresh");
  const surface = await fixture("public");
  const [actor] = await surface.db.insert(externalActorProjections).values({ provider: "slack",
    appRegistrationId: surface.registration.id, installId: surface.install.id, workspaceId: surface.install.providerAuthorityId,
    externalActorId: "B12345", displayName: "Slack bot · 2345", actorKind: "bot", projectionRevision: 1, observedAt: NOW }).returning();
  const cause = new Error("synthetic provider failure");
  const provider = { credentialResolver: { async resolve() { throw cause; } } } as unknown as SlackBridgeProviderRuntime;
  let reported: unknown;
  const refresher = createSlackBotProfileRefresher({ db: surface.db, provider, now: () => NOW, onError(error) { reported = error; } });
  refresher.request({ serverId: surface.server.id, registrationId: surface.registration.id, installId: surface.install.id,
    bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch, connectionEpoch: surface.install.connectionEpoch,
    providerBotId: "B12345", projectionId: actor!.id, senderAppId: "AOTHER" });
  await refresher.stop();
  assert.ok(reported instanceof Error);
  assert.equal(reported.cause, cause);
});

test("a bot profile response cannot update the projection after credentials rotate", async () => {
  const { createSlackBotProfileRefresher } = await import("./slackBotProfileRefresh");
  const surface = await fixture("public");
  const [actor] = await surface.db.insert(externalActorProjections).values({ provider: "slack",
    appRegistrationId: surface.registration.id, installId: surface.install.id, workspaceId: surface.install.providerAuthorityId,
    externalActorId: "B12345", displayName: "Slack bot · 2345", actorKind: "bot", projectionRevision: 1, observedAt: NOW }).returning();
  let started!: () => void, release!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  const unblock = new Promise<void>(resolve => { release = resolve; });
  let avatarCalls = 0;
  const provider = { credentialResolver: { async resolve({ authority }: any) { return { schema: "slack-bridge-credential-lease.v1",
    leaseId: "synthetic-lease", installId: authority.installId, providerAppId: authority.providerAppId,
    providerAuthorityId: authority.providerAuthorityId, connectionEpoch: authority.connectionEpoch,
    credentialRevision: authority.credentialRevision, leaseExpiresAt: new Date(NOW.getTime() + 60_000) }; } },
    transport: { evidence: "double", async call() { started(); await unblock;
      return { kind: "response", status: 200, headers: {}, body: { ok: true, bot: { id: "B12345", deleted: false,
        app_id: "AOTHER", name: "Stale profile", icons: { image_72: "https://avatars.slack-edge.com/synthetic.png" } } } }; } },
    quarantineSink: { async quarantine() { return "already_fenced"; } }, async releaseCredential() {} } as unknown as SlackBridgeProviderRuntime;
  const refresher = createSlackBotProfileRefresher({ db: surface.db, provider, now: () => NOW,
    avatarMaterializer: { async materializeExternalProjection() { avatarCalls++; } } });
  refresher.request({ serverId: surface.server.id, registrationId: surface.registration.id, installId: surface.install.id,
    bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch, connectionEpoch: surface.install.connectionEpoch,
    providerBotId: "B12345", projectionId: actor!.id, senderAppId: "AOTHER" });
  try {
    await requested;
    await surface.db.update(externalAppInstalls).set({ credentialRevision: surface.install.credentialRevision + 1 })
      .where(eq(externalAppInstalls.id, surface.install.id));
  } finally { release(); await refresher.stop(); }
  const [unchanged] = await surface.db.select().from(externalActorProjections).where(eq(externalActorProjections.id, actor!.id));
  assert.equal(unchanged?.displayName, "Slack bot · 2345");
  assert.equal(avatarCalls, 0);
});

test("a backlog of twenty Slack bot mentions preserves messages but wakes an agent only five times", async () => {
  const { enableTestSlackIngress } = await import("../test/integration/slackIngressRollout");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const { processExternalInboundEventOnce } = await import("./externalInboundWorkerService");
  const surface = await fixture("public");
  const botUserId = "URUNTIMEBOT";
  await surface.db.update(externalAppInstalls).set({ botUserId }).where(eq(externalAppInstalls.id, surface.install.id));
  await surface.db.update(externalAppInstallGrantReceipts).set({ botUserId,
    grantHash: slackBridgeInstallGrantHash({ providerAppId: surface.install.providerAppId,
      providerAuthorityId: surface.install.providerAuthorityId, botUserId, providerBotId: surface.install.providerBotId!,
      grantedScopes: surface.install.installedScopes }) }).where(eq(externalAppInstallGrantReceipts.installId, surface.install.id));
  const [agent] = await surface.db.insert(agents).values({ serverId: surface.server.id, name: "notify-test-agent", runtime: "codex" }).returning();
  await surface.db.insert(channelAgents).values({ channelId: surface.channel.id, agentId: agent!.id });
  await surface.db.insert(channelHumans).values({ channelId: surface.channel.id, userId: surface.owner.id });
  await enableTestSlackIngress();
  await (await import("../test/integration/slackIngressRollout")).enableTestSlackBotProtocol();
  const scope = { registrationId: surface.registration.id, environment: "test" as const };
  const key = Buffer.alloc(32, 9);
  const prepare = createSlackVerifiedIngressPreparer({ db: surface.db, now: () => NOW, botSyncEnabled: true,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db), payloadSealer: { async sealNormalizedPayload(input) {
      return { encryptedPayload: input.plaintext, envelopeKeyId: "synthetic-key", aadVersion: 1 };
    } } });
  const tick = () => processVerifiedSlackIngressOnce({ db: surface.db, leaseOwner: "rate-raw", leaseMs: 30_000,
    now: () => NOW, scope, prepare, crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } });
  const receivedAt = new Date(NOW.getTime() - 20 * 60_000);
  for (let n = 0; n < 20; n++) {
    const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const, ...scope,
      providerAppId: surface.registration.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
      providerConversationId: surface.binding.providerConversationId, providerEventId: `Ev_BOT_RATE_${n}` };
    const mention = n % 2 === 0 ? `<@${botUserId}>` : "@notify-test-agent";
    const text = `synthetic bot mention ${n} ${mention}`;
    const bytes = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId,
      team_id: aad.providerAuthorityId, event_id: aad.providerEventId, event: { type: "message", subtype: "bot_message",
        channel: aad.providerConversationId, bot_id: "B_FOREIGN_RATE", username: "Monitor",
        ts: `${Math.floor(receivedAt.getTime() / 1000)}.${String(1000 + n).padStart(6, "0")}`, text } }));
    await enqueueSlackVerifiedIngress({ db: surface.db, aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
      encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "key", now: receivedAt,
      validateEndpoint: async () => true });
    let rawResult = await tick();
    // A tick may only settle the prior normalized head, making no new claim.
    if (rawResult.kind === "empty") rawResult = await tick();
    assert.equal(rawResult.kind, "materialized");
    const worker = await processExternalInboundEventOnce({ db: surface.db, leaseOwner: "rate-canonical", durableSlackMode: true,
      providerScope: "slack", dependencies: { now: () => NOW, decryptNormalizedPayload: async input => input.ciphertext,
        resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => NOW) } });
    assert.equal(worker.kind, "committed");
    const [receipt] = await surface.db.select().from(externalInboundEvents).where(eq(externalInboundEvents.providerEventId, aad.providerEventId));
    const [created] = await surface.db.select().from(messages).where(eq(messages.id, receipt!.committedMessageId!));
    assert.ok(created);
    const mentions = await surface.db.select().from(messageMentions).where(eq(messageMentions.messageId, created!.id));
    assert.ok(mentions.some(row => row.targetType === "agent" && row.targetId === agent!.id));
    const inbox = await surface.db.select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.messageId, created!.id));
    assert.equal(inbox.some(row => row.receiverType === "agent" && row.receiverId === agent!.id), n < 5);
    assert.ok(inbox.some(row => row.receiverType === "user" && row.receiverId === surface.owner.id));
    if (n >= 5) assert.equal(receipt?.outcomeReason, "provider_bot_wake_rate_limited");
  }
});

test.each(["skip", "accepted", "late_result"] as const)("unknown bot waits off-head then handles outbound %s", async resolution => {
  const { enableTestSlackIngress } = await import("../test/integration/slackIngressRollout");
  const { slackVerifiedIngressEvents } = await import("../db/schema");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const { requeueDueSlackActor } = await import("./slackVerifiedIngressWorker");
  const surface = await fixture("public");
  const [outgoing] = await surface.db.insert(messages).values({ channelId: surface.channel.id, senderType: "user",
    senderId: surface.owner.id, content: "synthetic outgoing", messageType: "chat", createdAt: NOW }).returning();
  const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch, expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user", senderId: surface.owner.id, now: NOW, registrationId: surface.registration.id });
  assert.ok(active);
  const queued = await surface.db.transaction(executor => enqueueSlackBridgeOutboundDelivery({ executor, message: outgoing!,
    activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
      runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral }, canonicalConversationId: surface.channel.id,
    senderType: "user", senderId: surface.owner.id, authorName: surface.owner.name, sanitizedText: outgoing!.content,
    mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("bot-pending-test", deliveryId) }));
  await surface.db.update(externalOutboundDeliveries).set({ state: "outcome_unknown", providerAttempts: 1,
    firstDispatchedAt: new Date(NOW.getTime() - 1_000) }).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  await enableTestSlackIngress();
  await (await import("../test/integration/slackIngressRollout")).enableTestSlackBotProtocol();
  const scope = { registrationId: surface.registration.id, environment: "test" as const };
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const, ...scope,
    providerAppId: surface.registration.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, providerEventId: "Ev_BOT_PENDING" };
  const bytes = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId,
    team_id: aad.providerAuthorityId, event_id: aad.providerEventId, event: { type: "message", subtype: "bot_message",
      channel: aad.providerConversationId, bot_id: "B_UNKNOWN", text: "synthetic pending bot", ts: "1786435200.000123" } }));
  const key = Buffer.alloc(32, 7);
  await enqueueSlackVerifiedIngress({ db: surface.db, aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "key", now: NOW,
    validateEndpoint: async () => true });
  let clock = NOW;
  const prepare = createSlackVerifiedIngressPreparer({ db: surface.db, now: () => clock, botSyncEnabled: true,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db), payloadSealer: { async sealNormalizedPayload(input) {
      return { encryptedPayload: input.plaintext, envelopeKeyId: "synthetic-key", aadVersion: 1 };
    } } });
  const tick = () => processVerifiedSlackIngressOnce({ db: surface.db, leaseOwner: "pending-bot", leaseMs: 30_000,
    now: () => clock, scope, prepare, crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } });
  assert.equal((await tick()).kind, "held");
  const [held] = await surface.db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.providerEventId, aad.providerEventId));
  assert.equal(held!.outcomeReason, "bot_outbound_pending");
  if (resolution === "late_result") {
    // A result/recovery may rewrite firstDispatchedAt after the inbound
    // receipt. The immutable I/O attempt still proves this send was in flight.
    await surface.db.insert(externalDeliveryAttempts).values({ deliveryId: queued.delivery.id, attemptNumber: 1,
      leaseGeneration: 1, runtimeRevision: "synthetic", credentialRevision: 1, dispatchAuthorization: "automatic",
      providerIoStartedAt: new Date(NOW.getTime() - 1_000), outcome: "outcome_unknown", outcomeReason: "synthetic_timeout",
      terminalAt: new Date(NOW.getTime() + 30_000) });
    await surface.db.update(externalOutboundDeliveries).set({ firstDispatchedAt: new Date(NOW.getTime() + 30_000) })
      .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
    clock = new Date(held!.nextAttemptAt);
    assert.equal(await requeueDueSlackActor({ db: surface.db, ...scope, now: clock }), true);
    assert.equal((await tick()).kind, "held", "rewritten delivery time cannot release the plausible echo");
    return;
  }
  if (resolution === "skip") {
    const [decision] = await surface.db.insert(externalDeliveryOperatorDecisions).values({ deliveryId: queued.delivery.id,
      bindingId: queued.delivery.bindingId, bindingEpoch: queued.delivery.bindingEpoch, partitionPosition: queued.delivery.partitionPosition,
      action: "skip", actorType: "user", actorId: surface.owner.id, reason: "synthetic operator decision",
      dataLossAcknowledged: true, decisionRevision: 1 }).returning();
    const skippedAt = new Date(NOW.getTime() + 1_000);
    assert.equal((await consumeExternalDeliverySkipDecision({ db: surface.db, bindingId: queued.delivery.bindingId,
      bindingEpoch: queued.delivery.bindingEpoch, decisionId: decision!.id, now: skippedAt })).kind, "skipped");
  } else {
    await surface.db.transaction(async tx => {
      await tx.insert(externalMessageLinks).values({ deliveryId: queued.delivery.id, provider: "slack", installId: surface.install.id,
        providerAuthorityId: surface.install.providerAuthorityId, providerConversationId: surface.binding.providerConversationId,
        providerMessageId: "1786435200.000123", bindingId: queued.delivery.bindingId, bindingEpoch: queued.delivery.bindingEpoch,
        connectionEpoch: surface.install.connectionEpoch, raftMessageId: outgoing!.id, firstDirection: "raft_outbound",
        payloadFingerprint: queued.delivery.renderSnapshotDigest, outcomeState: "accepted", authorityState: "active" });
      await tx.update(externalOutboundDeliveries).set({ state: "accepted", acceptedAt: new Date(NOW.getTime() + 1_000),
        providerMessageId: "1786435200.000123" }).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
    });
  }
  clock = new Date(NOW.getTime() + 61_000);
  assert.equal(await requeueDueSlackActor({ db: surface.db, ...scope, now: clock }), true);
  assert.equal((await tick()).kind, resolution === "skip" ? "materialized" : "discarded");
  const [released] = await surface.db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, held!.id));
  if (resolution === "skip") assert.equal(released!.lastIsolationReason, "bot_pending_same_channel_manual_skip");
  else assert.equal(released!.outcomeReason, "provider_self_echo");
});

test.each(["active", "left", "left_during_prepare", "left_after_materialization", "left_channel", "left_channel_during_prepare", "left_channel_after_materialization"] as const)("verified raw Slack message reaches the canonical worker after the author is %s", async (authorState) => {
  const { enableTestSlackIngress, writeSlackFixture } = await import("../test/integration/slackIngressRollout");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const { processExternalInboundEventOnce } = await import("./externalInboundWorkerService");
  const surface = await fixture("public");
  if (authorState !== "active") {
    const [agent] = await surface.db.insert(agents).values({ serverId: surface.server.id, name: "history-test-agent", runtime: "codex" }).returning();
    await surface.db.insert(channelAgents).values({ channelId: surface.channel.id, agentId: agent!.id });
  }
  await enableTestSlackIngress();
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const,
    registrationId: surface.registration.id, environment: "test" as const,
    providerAppId: surface.registration.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, providerEventId: "Ev_FULL_PREPARE" };
  const body = authorState !== "active" ? "durable history <!subteam^SAGENT123|@history-test-agent>" : "durable message from verified receipt";
  const bytes = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId,
    team_id: aad.providerAuthorityId, event_id: aad.providerEventId,
    event: { type: "message", channel: aad.providerConversationId, user: surface.projection.externalActorId,
      ts: `${Math.floor(NOW.getTime() / 1000)}.001000`, text: body } }));
  const key = Buffer.alloc(32, 8);
  await enqueueSlackVerifiedIngress({ db: surface.db, aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "key", now: NOW,
    validateEndpoint: async () => true });
  const channelOnly = authorState.startsWith("left_channel");
  const depart = async () => {
    if (!channelOnly) await surface.db.update(externalActorProjections).set({ deactivated: true, state: "tombstoned" })
      .where(eq(externalActorProjections.id, surface.projection.id));
    await surface.db.update(externalAddressabilityProjections).set({ state: "removed" })
      .where(eq(externalAddressabilityProjections.projectionId, surface.projection.id));
  };
  if (authorState === "left" || authorState === "left_channel") await depart();
  let clock = NOW;
  const prepareActual = createSlackVerifiedIngressPreparer({ db: surface.db, now: () => clock,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db),
    payloadSealer: { async sealNormalizedPayload(input) {
      return { encryptedPayload: input.plaintext, envelopeKeyId: "synthetic-test-key", aadVersion: 1 };
    } } });
  let departed = false;
  const prepare: typeof prepareActual = async (event, eventAad, receivedAt) => {
    const value = await prepareActual(event, eventAad, receivedAt);
    if ((authorState === "left_during_prepare" || authorState === "left_channel_during_prepare") && !departed) {
      departed = true;
      await depart();
    }
    return value;
  };
  const tick = () => processVerifiedSlackIngressOnce({ db: surface.db, leaseOwner: "raw-real-authority", leaseMs: 30_000,
    now: () => clock, scope: { registrationId: aad.registrationId, environment: aad.environment }, prepare,
    crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } });
  let result = await tick();
  if (authorState === "left_during_prepare" || authorState === "left_channel_during_prepare") {
    assert.equal(result.kind, "deferred", "stale actor authority cannot be committed");
    clock = new Date(NOW.getTime() + 60_000);
    result = await tick();
  }
  assert.equal(result.kind, "materialized");
  if (authorState === "left_after_materialization" || authorState === "left_channel_after_materialization") await depart();
  if (authorState !== "active") {
    const { slackVerifiedIngressEvents } = await import("../db/schema");
    const { insertSlackHistoricalAuthorMessage } = await import("./externalProjectionService");
    const [raw] = await surface.db.select().from(slackVerifiedIngressEvents)
      .where(eq(slackVerifiedIngressEvents.providerEventId, aad.providerEventId));
    const [normalized] = await surface.db.select().from(externalInboundEvents)
      .where(eq(externalInboundEvents.id, raw!.materializedInboundEventId!));
    // Model a processing lease, then attempt to reuse the real receipt with a
    // different actor. The encrypted normalized payload remains untouched.
    await writeSlackFixture(() => surface.db.update(externalInboundEvents).set({ status: "processing",
      leaseOwner: "spoof-test", leaseGeneration: 1, leaseExpiresAt: new Date(clock.getTime() + 30_000) })
      .where(eq(externalInboundEvents.id, normalized!.id)));
    await assert.rejects(surface.db.transaction(tx => insertSlackHistoricalAuthorMessage({ executor: tx,
      channelId: surface.channel.id, content: "durable\n\n[One or more attachments unavailable]",
      createdAt: new Date(NOW.getTime() + 1), projectionId: surface.projection.id,
      provider: "slack", appRegistrationId: surface.registration.id, installId: surface.install.id,
      workspaceId: surface.install.providerAuthorityId, externalActorId: surface.projection.externalActorId,
      externalConversationId: surface.binding.providerConversationId,
      externalMessageId: `${Math.floor(NOW.getTime() / 1000)}.001000`,
      actorProjectionRevision: surface.projection.projectionRevision,
    }, { inboundEventId: normalized!.id, leaseOwner: "spoof-test", leaseGeneration: 1,
      at: clock, sourcePlaintext: normalized!.encryptedPayload! })), /content mismatch/);
    await assert.rejects(surface.db.transaction(tx => insertSlackHistoricalAuthorMessage({ executor: tx,
      channelId: surface.channel.id, content: body, createdAt: NOW, projectionId: surface.projection.id,
      provider: "slack", appRegistrationId: surface.registration.id, installId: surface.install.id,
      workspaceId: surface.install.providerAuthorityId, externalActorId: surface.projection.externalActorId,
      externalConversationId: surface.binding.providerConversationId,
      externalMessageId: `${Math.floor(NOW.getTime() / 1000)}.001000`,
      actorProjectionRevision: surface.projection.projectionRevision,
    }, { inboundEventId: normalized!.id, leaseOwner: "stale-owner", leaseGeneration: 1,
      at: clock, sourcePlaintext: normalized!.encryptedPayload! })), /verified Slack custody/);
    await assert.rejects(surface.db.transaction(tx => insertSlackHistoricalAuthorMessage({ executor: tx,
      channelId: surface.channel.id, content: body, createdAt: NOW, projectionId: surface.projection.id,
      provider: "slack", appRegistrationId: surface.registration.id, installId: surface.install.id,
      workspaceId: surface.install.providerAuthorityId, externalActorId: "U_FORGED",
      externalConversationId: surface.binding.providerConversationId,
      externalMessageId: `${Math.floor(NOW.getTime() / 1000)}.001000`,
      actorProjectionRevision: surface.projection.projectionRevision,
    }, { inboundEventId: normalized!.id, leaseOwner: "spoof-test", leaseGeneration: 1,
      at: clock, sourcePlaintext: normalized!.encryptedPayload! })), /payload identity mismatch/);
    await writeSlackFixture(() => surface.db.update(externalInboundEvents).set({ status: "queued", leaseOwner: null,
      leaseExpiresAt: null }).where(eq(externalInboundEvents.id, normalized!.id)));
  }
  const worker = await processExternalInboundEventOnce({ db: surface.db, leaseOwner: "canonical-real-authority",
    durableSlackMode: true, providerScope: "slack", dependencies: { now: () => clock,
      decryptNormalizedPayload: async input => input.ciphertext,
      resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => clock) } });
  assert.equal(worker.kind, "committed");
  const delivered = await surface.db.select().from(messages).where(eq(messages.content, body));
  assert.equal(delivered.length, 1);
  if (authorState !== "active") {
    const [author] = await surface.db.select().from(externalActorProjections).where(eq(externalActorProjections.id, surface.projection.id));
    assert.equal(author?.state, channelOnly ? "active" : "tombstoned", "history must not alter the directory identity");
    assert.equal(author?.deactivated, !channelOnly);
    const [address] = await surface.db.select().from(externalAddressabilityProjections)
      .where(eq(externalAddressabilityProjections.projectionId, surface.projection.id));
    assert.equal(address?.state, "removed", "history must not restore channel membership");
    assert.equal((await surface.db.select().from(messageMentions).where(eq(messageMentions.messageId, delivered[0]!.id))).length, 0);
    const notifications = await surface.db.select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.messageId, delivered[0]!.id));
    assert.equal(notifications.filter(fact => fact.receiverType === "agent").length, 0, "former sender cannot wake an agent");
  }
});

test("a former Slack author's unverified event cannot use the historical message path", async () => {
  const { insertSlackHistoricalAuthorMessage } = await import("./externalProjectionService");
  const surface = await fixture("public");
  await surface.db.update(externalActorProjections).set({ deactivated: true, state: "tombstoned" })
    .where(eq(externalActorProjections.id, surface.projection.id));
  await assert.rejects(surface.db.transaction(tx => insertSlackHistoricalAuthorMessage({ executor: tx,
    channelId: surface.channel.id, content: "not a verified event", createdAt: NOW,
    projectionId: surface.projection.id, provider: "slack", appRegistrationId: surface.registration.id,
    installId: surface.install.id, workspaceId: surface.install.providerAuthorityId,
    externalActorId: surface.projection.externalActorId, externalConversationId: surface.binding.providerConversationId,
    externalMessageId: "1786406400.000002", actorProjectionRevision: surface.projection.projectionRevision,
  }, { inboundEventId: randomUUID(), leaseOwner: "worker", leaseGeneration: 1, at: NOW,
    sourcePlaintext: "{}" })), /verified Slack custody/);
  assert.equal((await surface.db.select().from(messages).where(eq(messages.content, "not a verified event"))).length, 0);
});

test("verified file occurrence survives a tombstoned author without granting unrelated file access", async () => {
  const { enableTestSlackIngress, writeSlackFixture } = await import("../test/integration/slackIngressRollout");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const { processExternalInboundEventOnce } = await import("./externalInboundWorkerService");
  const { externalAttachmentMessageFacts, slackVerifiedIngressFileFacts, slackVerifiedIngressEvents } = await import("../db/schema");
  const { hasVerifiedSlackFileFact, verifySlackInboundFile } = await import("./slackVerifiedInboundFileProvenance");
  const { slackAttachmentAuthorityIsCurrent } = await import("./slackBridgeServerRuntime");
  const surface = await fixture("public");
  await enableTestSlackIngress();
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const,
    registrationId: surface.registration.id, environment: "test" as const, providerAppId: surface.registration.providerAppId,
    providerAuthorityId: surface.install.providerAuthorityId, providerConversationId: surface.binding.providerConversationId,
    providerEventId: "Ev_LEFT_WITH_FILE" };
  const bytes = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId,
    event_id: aad.providerEventId, event: { type: "message", channel: aad.providerConversationId,
      user: surface.projection.externalActorId, ts: `${Math.floor(NOW.getTime() / 1000)}.001000`,
      text: "file from earlier", files: [{ id: "F_ORIGINAL" }] } }));
  const key = Buffer.alloc(32, 8);
  await enqueueSlackVerifiedIngress({ db: surface.db, aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "key", now: NOW, validateEndpoint: async () => true });
  await surface.db.update(externalActorProjections).set({ deactivated: true, state: "tombstoned" })
    .where(eq(externalActorProjections.id, surface.projection.id));
  const prepare = createSlackVerifiedIngressPreparer({ db: surface.db, now: () => NOW,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db),
    payloadSealer: { async sealNormalizedPayload(input) { return { encryptedPayload: input.plaintext, envelopeKeyId: "test", aadVersion: 1 }; } } });
  const rawResult = await processVerifiedSlackIngressOnce({ db: surface.db, leaseOwner: "file-raw", leaseMs: 30_000,
    now: () => NOW, scope: { registrationId: aad.registrationId, environment: aad.environment }, prepare,
    crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } });
  assert.equal(rawResult.kind, "materialized");
  const [raw] = await surface.db.select().from(slackVerifiedIngressEvents)
    .where(eq(slackVerifiedIngressEvents.providerEventId, aad.providerEventId));
  const [normalized] = await surface.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, raw.materializedInboundEventId!));
  await writeSlackFixture(() => surface.db.update(externalInboundEvents).set({ status: "processing", leaseOwner: "proof-test",
    leaseGeneration: 1, leaseExpiresAt: new Date(NOW.getTime() + 30_000) }).where(eq(externalInboundEvents.id, normalized.id)));
  const proof = { leaseOwner: "proof-test", leaseGeneration: 1, at: NOW, sourcePlaintext: normalized.encryptedPayload! };
  const proofInput = { eventId: normalized.id, projectionId: surface.projection.id, providerFileId: "F_ORIGINAL", orderedPosition: 0, proof };
  assert.ok(await verifySlackInboundFile(surface.db, proofInput));
  assert.equal(await verifySlackInboundFile(surface.db, { ...proofInput, providerFileId: "F_FORGED" }), null);
  assert.equal(await verifySlackInboundFile(surface.db, { ...proofInput, orderedPosition: 1 }), null);
  assert.equal(await verifySlackInboundFile(surface.db, { ...proofInput, proof: { ...proof, sourcePlaintext: `${proof.sourcePlaintext} ` } }), null);
  await writeSlackFixture(() => surface.db.update(slackVerifiedIngressEvents).set({ normalizationSource: null }).where(eq(slackVerifiedIngressEvents.id, raw.id)));
  assert.equal(await verifySlackInboundFile(surface.db, proofInput), null, "legacy-linked rows are not verified normalization");
  await writeSlackFixture(() => surface.db.update(slackVerifiedIngressEvents).set({ normalizationSource: "verified_raw" }).where(eq(slackVerifiedIngressEvents.id, raw.id)));
  await writeSlackFixture(() => surface.db.update(externalInboundEvents).set({ status: "queued", leaseOwner: null, leaseExpiresAt: null })
    .where(eq(externalInboundEvents.id, normalized.id)));
  const result = await processExternalInboundEventOnce({ db: surface.db, leaseOwner: "file-normalized", durableSlackMode: true,
    providerScope: "slack", dependencies: { now: () => NOW, decryptNormalizedPayload: async input => input.ciphertext,
      resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => NOW) } });
  assert.equal(result.kind, "blocked");
  if (result.kind !== "blocked") throw new Error("expected attachment wait");
  assert.equal(result.reason, "attachment_transfer_pending");
  const [fact] = await surface.db.select().from(externalAttachmentMessageFacts);
  assert.ok(fact); const [storedProof] = await surface.db.select().from(slackVerifiedIngressFileFacts);
  assert.equal(storedProof?.factId, fact.id);
  assert.equal(await hasVerifiedSlackFileFact(surface.db, { factId: fact.id, eventId: fact.inboundEventId!,
    projectionId: surface.projection.id, providerFileId: "F_ORIGINAL" }), true);
  // A completed raw receipt can still be the durable proof used by a pending
  // attachment transfer; aging it out must not cascade that proof.
  const { compactTerminalSlackIngress, SLACK_INGRESS_TERMINAL_RETENTION_MS } = await import("./slackVerifiedIngressRetention");
  await writeSlackFixture(() => surface.db.update(slackVerifiedIngressEvents).set({ state: "completed", encryptedPayload: null,
    envelopeKeyId: null, outcomeReason: "normalized_committed", updatedAt: NOW }).where(eq(slackVerifiedIngressEvents.id, raw.id)));
  await compactTerminalSlackIngress({ db: surface.db, registrationId: aad.registrationId, environment: aad.environment,
    now: new Date(NOW.getTime() + SLACK_INGRESS_TERMINAL_RETENTION_MS + 1) });
  assert.equal((await surface.db.select().from(slackVerifiedIngressFileFacts).where(eq(slackVerifiedIngressFileFacts.factId, fact.id))).length,
    1, "retention preserves attachment custody");
  assert.equal((await surface.db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, raw.id))).length, 1);
  await writeSlackFixture(() => surface.db.update(slackVerifiedIngressEvents).set({ state: "materialized",
    encryptedPayload: raw.encryptedPayload, envelopeKeyId: raw.envelopeKeyId, outcomeReason: raw.outcomeReason })
    .where(eq(slackVerifiedIngressEvents.id, raw.id)));
  const authority = { provider: "slack", appRegistrationId: surface.registration.id, installId: surface.install.id,
    workspaceId: surface.install.providerAuthorityId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, connectionEpoch: surface.binding.connectionEpoch,
    bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch };
  const custody = { factId: fact.id, eventId: fact.inboundEventId!, providerFileId: "F_ORIGINAL" };
  assert.equal(await slackAttachmentAuthorityIsCurrent(surface.db, authority, surface.projection.id, custody), true);
  assert.equal(await slackAttachmentAuthorityIsCurrent(surface.db, authority, surface.projection.id), false);
  assert.equal(await slackAttachmentAuthorityIsCurrent(surface.db, authority, surface.projection.id, { ...custody, providerFileId: "F_OTHER" }), false);
  assert.equal(await hasVerifiedSlackFileFact(surface.db, { factId: fact.id, eventId: fact.inboundEventId!,
    projectionId: surface.projection.id, providerFileId: "F_OTHER" }), false);
  await writeSlackFixture(() => surface.db.update(slackVerifiedIngressEvents).set({ normalizationSource: null }).where(eq(slackVerifiedIngressEvents.id, raw.id)));
  assert.equal(await hasVerifiedSlackFileFact(surface.db, { factId: fact.id, eventId: fact.inboundEventId!,
    projectionId: surface.projection.id, providerFileId: "F_ORIGINAL" }), false, "a legacy-linked row cannot authorize file work");
  await writeSlackFixture(() => surface.db.update(slackVerifiedIngressEvents).set({ normalizationSource: "verified_raw" }).where(eq(slackVerifiedIngressEvents.id, raw.id)));
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "manager_paused" }).where(eq(externalChannelBindings.id, surface.binding.id));
  assert.equal(await slackAttachmentAuthorityIsCurrent(surface.db, authority, surface.projection.id, custody), false,
    "proven historical content never overrides current pair authority");
  const [actor] = await surface.db.select().from(externalActorProjections).where(eq(externalActorProjections.id, surface.projection.id));
  assert.equal(actor.state, "tombstoned");
});

test("a recovered author racing fallback cannot be overwritten by a display stub", async () => {
  const { enableTestSlackIngress } = await import("../test/integration/slackIngressRollout");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const surface = await fixture("public"); await enableTestSlackIngress();
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const, registrationId: surface.registration.id,
    environment: "test" as const, providerAppId: surface.registration.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, providerEventId: "Ev_AUTHOR_RACE" };
  const event = { type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId, event_id: aad.providerEventId,
    event: { type: "message", channel: aad.providerConversationId, user: "U_RECOVERED", ts: "1786444800.001000", text: "race body" } };
  const bytes = Buffer.from(JSON.stringify(event)), key = Buffer.alloc(32, 16), clock = new Date(NOW.getTime() + 24 * 60 * 60_000 + 1);
  await enqueueSlackVerifiedIngress({ db: surface.db, aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "test", now: NOW, validateEndpoint: async () => true });
  const actual = createSlackVerifiedIngressPreparer({ db: surface.db, now: () => clock,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db), payloadSealer: { async sealNormalizedPayload(input) {
      return { encryptedPayload: input.plaintext, envelopeKeyId: "test", aadVersion: 1 };
    } } });
  const prepared = await actual(event, aad, NOW);
  assert.equal(prepared.kind, "materialize");
  const [real] = await surface.db.insert(externalActorProjections).values({ provider: "slack", appRegistrationId: aad.registrationId,
    installId: surface.install.id, workspaceId: aad.providerAuthorityId, externalActorId: "U_RECOVERED", displayName: "Recovered person",
    actorKind: "human", projectionRevision: 1, observedAt: clock }).returning();
  const result = await processVerifiedSlackIngressOnce({ db: surface.db, leaseOwner: "race", leaseMs: 30_000,
    now: () => clock, prepare: async () => prepared, crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } });
  assert.equal(result.kind, "deferred");
  const [stillReal] = await surface.db.select().from(externalActorProjections).where(eq(externalActorProjections.id, real.id));
  assert.equal(stillReal.displayName, "Recovered person"); assert.equal(stillReal.actorKind, "human");
  assert.equal((await surface.db.select().from(messages).where(eq(messages.content, "race body"))).length, 0);
});

test("anonymous attachment transfer requires exact signed file custody", async () => {
  const { enableTestSlackIngress } = await import("../test/integration/slackIngressRollout");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const { processExternalInboundEventOnce } = await import("./externalInboundWorkerService");
  const { hasVerifiedSlackFileFact } = await import("./slackVerifiedInboundFileProvenance");
  const { slackAttachmentAuthorityIsCurrent } = await import("./slackBridgeServerRuntime");
  const { externalAttachmentMessageFacts } = await import("../db/schema");
  const surface = await fixture("public"); await enableTestSlackIngress();
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const, registrationId: surface.registration.id,
    environment: "test" as const, providerAppId: surface.registration.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, providerEventId: "Ev_ANON_FILE" };
  const event = { type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId, event_id: aad.providerEventId,
    event: { type: "message", subtype: "file_share", channel: aad.providerConversationId, ts: "1786444800.001000",
      text: "body with file", files: [{ id: "F_ANON" }] } };
  const bytes = Buffer.from(JSON.stringify(event)), key = Buffer.alloc(32, 15);
  await enqueueSlackVerifiedIngress({ db: surface.db, aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "test", now: NOW, validateEndpoint: async () => true });
  const prepare = createSlackVerifiedIngressPreparer({ db: surface.db, now: () => NOW,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db), payloadSealer: { async sealNormalizedPayload(input) {
      return { encryptedPayload: input.plaintext, envelopeKeyId: "test", aadVersion: 1 };
    } } });
  assert.equal((await processVerifiedSlackIngressOnce({ db: surface.db, leaseOwner: "anon-file-raw", leaseMs: 30_000,
    now: () => NOW, prepare, crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } })).kind, "materialized");
  const result = await processExternalInboundEventOnce({ db: surface.db, leaseOwner: "anon-file-normalized", durableSlackMode: true,
    providerScope: "slack", dependencies: { now: () => NOW, decryptNormalizedPayload: async input => input.ciphertext,
      resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => NOW) } });
  assert.equal(result.kind, "blocked");
  if (result.kind !== "blocked") throw new Error("expected attachment wait");
  assert.equal(result.reason, "attachment_transfer_pending");
  const [fact] = await surface.db.select().from(externalAttachmentMessageFacts);
  assert.ok(fact?.inboundEventId && fact.sourceActorProjectionId);
  const proof = { factId: fact.id, eventId: fact.inboundEventId, providerFileId: "F_ANON" };
  const authority = { provider: "slack", appRegistrationId: surface.registration.id, installId: surface.install.id,
    workspaceId: surface.install.providerAuthorityId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, connectionEpoch: surface.binding.connectionEpoch,
    bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch };
  assert.equal(await hasVerifiedSlackFileFact(surface.db, { ...proof, projectionId: fact.sourceActorProjectionId }), true);
  assert.equal(await hasVerifiedSlackFileFact(surface.db, { ...proof, projectionId: fact.sourceActorProjectionId, providerFileId: "F_OTHER" }), false);
  assert.equal(await slackAttachmentAuthorityIsCurrent(surface.db, authority, fact.sourceActorProjectionId), false);
  assert.equal(await slackAttachmentAuthorityIsCurrent(surface.db, authority, fact.sourceActorProjectionId, proof), true);
});

test("unavailable reaction author waits 24 hours and is rechecked before discard", async () => {
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const { enableTestSlackIngress } = await import("../test/integration/slackIngressRollout");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { slackVerifiedIngressEvents } = await import("../db/schema");
  const surface = await fixture("public");
  await enableTestSlackIngress();
  await surface.db.update(externalAddressabilityProjections).set({ state: "removed" })
    .where(eq(externalAddressabilityProjections.projectionId, surface.projection.id));
  let clock = new Date(NOW.getTime() + 24 * 60 * 60_000 - 1);
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const, registrationId: surface.registration.id,
    environment: "test" as const, providerAppId: surface.registration.providerAppId,
    providerAuthorityId: surface.install.providerAuthorityId, providerConversationId: surface.binding.providerConversationId,
    providerEventId: "Ev_REACTION_EXPIRY" };
  const event = { type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId, event_id: aad.providerEventId,
    event: { type: "reaction_added", user: surface.projection.externalActorId, reaction: "thumbsup", event_ts: "1786444801.000001",
      item: { type: "message", channel: aad.providerConversationId, ts: "1786444800.001000" } } };
  const prepare = createSlackVerifiedIngressPreparer({ db: surface.db, now: () => clock,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db), payloadSealer: { async sealNormalizedPayload() { throw new Error("unused"); } } });
  assert.partialDeepStrictEqual(await prepare(event, aad, NOW), { kind: "unrecognized", reason: "actor_identity_pending" });
  clock = new Date(NOW.getTime() + 24 * 60 * 60_000 + 1);
  const prepared = await prepare(event, aad, NOW);
  assert.equal(prepared.kind, "skip");
  if (prepared.kind !== "skip" || !prepared.validate) throw new Error("missing expiry proof");
  assert.equal(prepared.reason, "reaction_author_unavailable");
  assert.equal(await surface.db.transaction(tx => prepared.validate!(tx, NOW, clock)), true);
  await surface.db.update(externalAddressabilityProjections).set({ state: "active" })
    .where(eq(externalAddressabilityProjections.projectionId, surface.projection.id));
  assert.equal(await surface.db.transaction(tx => prepared.validate!(tx, NOW, clock)), false,
    "a recovered author must not be discarded using stale absence evidence");
  await surface.db.update(externalAddressabilityProjections).set({ state: "removed" })
    .where(eq(externalAddressabilityProjections.projectionId, surface.projection.id));
  const bytes = Buffer.from(JSON.stringify(event)), key = Buffer.alloc(32, 14);
  const raw = await enqueueSlackVerifiedIngress({ db: surface.db, aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "test", now: NOW, validateEndpoint: async () => true });
  const result = await processVerifiedSlackIngressOnce({ db: surface.db, leaseOwner: "reaction-expiry", leaseMs: 30_000,
    now: () => clock, prepare, crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } });
  assert.equal(result.kind, "discarded");
  const [stored] = await surface.db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, raw.id));
  assert.equal(stored.outcomeReason, "reaction_author_unavailable"); assert.equal(stored.encryptedPayload, null);
});

test.each(["missing", "unknown"] as const)("unavailable %s edit author expires after 24 hours and is rechecked", async (kind) => {
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const { enableTestSlackIngress } = await import("../test/integration/slackIngressRollout");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { slackVerifiedIngressEvents } = await import("../db/schema");
  const surface = await fixture("public");
  await enableTestSlackIngress();
  if (kind === "unknown") await surface.db.update(externalActorProjections).set({ actorKind: "unknown" })
    .where(eq(externalActorProjections.id, surface.projection.id));
  const actorId = kind === "missing" ? "U_MISSING_EDIT" : surface.projection.externalActorId;
  let clock = new Date(NOW.getTime() + 24 * 60 * 60_000 - 1);
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const, registrationId: surface.registration.id,
    environment: "test" as const, providerAppId: surface.registration.providerAppId,
    providerAuthorityId: surface.install.providerAuthorityId, providerConversationId: surface.binding.providerConversationId,
    providerEventId: "Ev_EDIT_EXPIRY" };
  const event = { type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId, event_id: aad.providerEventId,
    event: { type: "message", subtype: "message_changed", channel: aad.providerConversationId, event_ts: "1786444801.000001",
      message: { user: actorId, ts: "1786444800.001000", text: "edited text" } } };
  const prepare = createSlackVerifiedIngressPreparer({ db: surface.db, now: () => clock,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db), payloadSealer: { async sealNormalizedPayload() { throw new Error("unused"); } } });
  assert.partialDeepStrictEqual(await prepare(event, aad, NOW), { kind: "unrecognized", reason: "actor_identity_pending" });
  clock = new Date(NOW.getTime() + 24 * 60 * 60_000 + 1);
  const prepared = await prepare(event, aad, NOW);
  assert.equal(prepared.kind, "skip");
  if (prepared.kind !== "skip" || !prepared.validate) throw new Error("missing expiry proof");
  assert.equal(prepared.reason, "edit_author_unavailable");
  assert.equal(await surface.db.transaction(tx => prepared.validate!(tx, NOW, clock)), true);
  await surface.db.update(externalActorProjections).set({ actorKind: "human", externalActorId: actorId })
    .where(eq(externalActorProjections.id, surface.projection.id));
  assert.equal(await surface.db.transaction(tx => prepared.validate!(tx, NOW, clock)), false,
    "a recovered author must not be discarded using stale absence evidence");
  await surface.db.update(externalActorProjections).set({ actorKind: "unknown" })
    .where(eq(externalActorProjections.id, surface.projection.id));
  const bytes = Buffer.from(JSON.stringify(event)), key = Buffer.alloc(32, 14);
  const raw = await enqueueSlackVerifiedIngress({ db: surface.db, aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "test", now: NOW, validateEndpoint: async () => true });
  const nextAad = { ...aad, providerEventId: "Ev_EDIT_FOLLOWER" };
  const nextBytes = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: nextAad.providerAppId,
    team_id: nextAad.providerAuthorityId, event_id: nextAad.providerEventId,
    event: { type: "file_shared", channel: nextAad.providerConversationId } }));
  const follower = await enqueueSlackVerifiedIngress({ db: surface.db, aad: nextAad,
    rawDigest: createHash("sha256").update(nextBytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes: nextBytes, key, aad: nextAad }),
    envelopeKeyId: "test", now: NOW, validateEndpoint: async () => true });
  const worker = { db: surface.db, leaseOwner: "edit-expiry", leaseMs: 30_000,
    now: () => clock, prepare, crypto: { async seal() { throw new Error("unused"); }, async open(input: any) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } };
  const result = await processVerifiedSlackIngressOnce({ db: surface.db, leaseOwner: "edit-expiry", leaseMs: 30_000,
    now: () => clock, prepare, crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } });
  assert.equal(result.kind, "discarded");
  const [stored] = await surface.db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, raw.id));
  assert.equal(stored.outcomeReason, "edit_author_unavailable"); assert.equal(stored.encryptedPayload, null);
  assert.equal((await processVerifiedSlackIngressOnce(worker)).kind, "discarded");
  const [following] = await surface.db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, follower.id));
  assert.equal(following.outcomeReason, "unsupported_event", "a later receipt can advance after the expired edit");
});

test("anonymous Slack edits can only update a message from the same binding and source", async () => {
  const { enableTestSlackIngress } = await import("../test/integration/slackIngressRollout");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const { processExternalInboundEventOnce } = await import("./externalInboundWorkerService");
  const { externalMessageAuthorFacts, slackVerifiedIngressEvents } = await import("../db/schema");
  const surface = await fixture("public"); await enableTestSlackIngress();
  const base = { purpose: "slack-verified-ingress" as const, version: 1 as const, registrationId: surface.registration.id,
    environment: "test" as const, providerAppId: surface.registration.providerAppId,
    providerAuthorityId: surface.install.providerAuthorityId, providerConversationId: surface.binding.providerConversationId };
  const key = Buffer.alloc(32, 13); let clock = NOW;
  const prepare = createSlackVerifiedIngressPreparer({ db: surface.db, now: () => clock,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db), payloadSealer: { async sealNormalizedPayload(input) {
      return { encryptedPayload: input.plaintext, envelopeKeyId: "test", aadVersion: 1 };
    } } });
  const send = async (id: string, event: Record<string, unknown>) => {
    const aad = { ...base, providerEventId: id };
    const bytes = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId,
      team_id: aad.providerAuthorityId, event_id: id, event }));
    const raw = await enqueueSlackVerifiedIngress({ db: surface.db, aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
      encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "test", now: clock, validateEndpoint: async () => true });
    const tick = () => processVerifiedSlackIngressOnce({ db: surface.db, leaseOwner: "edit-raw", leaseMs: 30_000,
      now: () => clock, prepare, crypto: { async seal() { throw new Error("unused"); }, async open(input) {
        return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
      } } });
    assert.equal((await tick()).kind, "materialized");
    const normalized = await processExternalInboundEventOnce({ db: surface.db, leaseOwner: "edit-normalized", durableSlackMode: true,
      providerScope: "slack", dependencies: { now: () => clock, decryptNormalizedPayload: async input => input.ciphertext,
        resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => clock) } });
    await tick();
    return { raw, normalized };
  };
  const ts = "1786444800.001000";
  const original = await send("Ev_ORIGINAL", { type: "message", channel: base.providerConversationId,
    user: surface.projection.externalActorId, ts, text: "original body" });
  assert.equal(original.normalized.kind, "committed");
  const [before] = await surface.db.select().from(messages).where(eq(messages.content, "original body"));
  const [beforeAuthor] = await surface.db.select().from(externalMessageAuthorFacts).where(eq(externalMessageAuthorFacts.messageId, before.id));
  clock = new Date(NOW.getTime() + 1_000);
  const replyEvent = { type: "message", channel: base.providerConversationId,
    ts: "1786444801.001000", thread_ts: ts, text: "anonymous thread reply" };
  const anonymousReply = await send("Ev_ANON_THREAD", replyEvent);
  assert.equal(anonymousReply.normalized.kind, "committed");
  const retryAad = { ...base, providerEventId: "Ev_ANON_THREAD" };
  const retryBytes = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: base.providerAppId,
    team_id: base.providerAuthorityId, event_id: retryAad.providerEventId, event: replyEvent }));
  const retried = await enqueueSlackVerifiedIngress({ db: surface.db, aad: retryAad,
    rawDigest: createHash("sha256").update(retryBytes).digest("hex"), encryptedPayload: sealSlackVerifiedIngress({ bytes: retryBytes, key, aad: retryAad }),
    envelopeKeyId: "test", now: clock, validateEndpoint: async () => true });
  assert.equal(retried.id, anonymousReply.raw.id, "the same signed event is deduplicated");
  const [reply] = await surface.db.select().from(messages).where(eq(messages.content, "anonymous thread reply"));
  const { getThreadReplyContextForParentChannel } = await import("./messageService");
  const thread = await getThreadReplyContextForParentChannel(surface.channel.id, reply.id);
  const threadReply = thread?.messages.find(row => row.id === reply.id);
  assert.ok(threadReply?.externalAuthor);
  assert.match(threadReply.senderId, /^slack-anonymous:[0-9a-f]{64}$/);
  assert.equal(threadReply.externalAuthor.externalActorId, threadReply.senderId);
  assert.equal(threadReply.externalAuthor.displayName, "Slack");
  for (const key of ["actorKind", "appRegistrationId", "displayName", "externalActorId", "externalConversationId",
    "externalMessageId", "installId", "projectionId", "provider", "workspaceId"] as const) {
    assert.ok(threadReply.externalAuthor[key], key);
  }
  assert.equal(typeof threadReply.externalAuthor.actorProjectionRevision, "number");
  const otherReply = await send("Ev_ANON_THREAD_TWO", { ...replyEvent, ts: "1786444801.002000" });
  assert.equal(otherReply.normalized.kind, "committed");
  const replies = await surface.db.select().from(messages).where(eq(messages.content, "anonymous thread reply"));
  assert.equal(replies.length, 2, "different event identities cannot collide on the shared anonymous display author");
  clock = new Date(NOW.getTime() + 2_000);
  const edit = await send("Ev_ANON_EDIT", { type: "message", subtype: "message_changed", channel: base.providerConversationId,
    event_ts: "1786444801.000000", message: { ts, text: "edited body", edited: { ts: "1786444801.000000" } } });
  assert.equal(edit.normalized.kind, "committed", JSON.stringify(edit.normalized));
  const [after] = await surface.db.select().from(messages).where(eq(messages.id, before.id));
  const [afterAuthor] = await surface.db.select().from(externalMessageAuthorFacts).where(eq(externalMessageAuthorFacts.messageId, before.id));
  assert.equal(after.content, "edited body"); assert.equal(afterAuthor.projectionId, beforeAuthor.projectionId);
  await surface.db.update(externalMessageLinks).set({ bindingEpoch: surface.binding.bindingEpoch + 1 })
    .where(eq(externalMessageLinks.raftMessageId, before.id));
  clock = new Date(NOW.getTime() + 3_000);
  const wrongPair = await send("Ev_WRONG_PAIR_EDIT", { type: "message", subtype: "message_changed", channel: base.providerConversationId,
    event_ts: "1786444802.000000", message: { ts, text: "cross pair overwrite", edited: { ts: "1786444802.000000" } } });
  assert.equal(wrongPair.normalized.kind, "blocked");
  const [wrongReceipt] = await surface.db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, wrongPair.raw.id));
  assert.equal(wrongReceipt.state, "discarded"); assert.equal(wrongReceipt.outcomeReason, "edit_target_unverified");
  assert.equal((await surface.db.select().from(messages).where(eq(messages.id, before.id)))[0].content, "edited body");
  clock = new Date(NOW.getTime() + 4_000);
  const missing = await send("Ev_MISSING_EDIT", { type: "message", subtype: "message_changed", channel: base.providerConversationId,
    event_ts: "1786444803.000000", message: { ts: "1786444799.001000", text: "must not appear", edited: { ts: "1786444803.000000" } } });
  assert.equal(missing.normalized.kind, "blocked");
  const [discarded] = await surface.db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, missing.raw.id));
  assert.equal(discarded.state, "discarded"); assert.equal(discarded.outcomeReason, "edit_target_unverified");
  assert.equal((await surface.db.select().from(messages).where(eq(messages.content, "must not appear"))).length, 0);
});

test.each(["anonymous", "unresolved", "unknown_present", "unknown_departed"] as const)("verified %s fallback delivers inert display-only content", async kind => {
  const { processExternalInboundEventOnce } = await import("./externalInboundWorkerService");
  const { enableTestSlackIngress } = await import("../test/integration/slackIngressRollout");
  const { externalMessageAuthorFacts, thirdPartyAgentEvents } = await import("../db/schema");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const surface = await fixture("public"); await enableTestSlackIngress();
  if (kind === "unknown_present" || kind === "unknown_departed") await surface.db.update(externalActorProjections).set({
    actorKind: "unknown", displayName: surface.projection.externalActorId,
    ...(kind === "unknown_departed" ? { state: "tombstoned", deactivated: true } : {}),
  }).where(eq(externalActorProjections.id, surface.projection.id));
  const [reader] = await surface.db.insert(agents).values({ serverId: surface.server.id, name: "fallback-reader", runtime: "codex" }).returning();
  await surface.db.insert(channelAgents).values({ channelId: surface.channel.id, agentId: reader.id });
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const,
    registrationId: surface.registration.id, environment: "test" as const, providerAppId: surface.registration.providerAppId,
    providerAuthorityId: surface.install.providerAuthorityId, providerConversationId: surface.binding.providerConversationId,
    providerEventId: `Ev_FALLBACK_${kind}` };
  const event = { type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId, event_id: aad.providerEventId,
    event: { type: "message", channel: aad.providerConversationId,
      ...(kind === "anonymous" ? {} : { user: kind === "unresolved" ? "U_UNRESOLVED" : surface.projection.externalActorId }),
      ts: "1785758340.000001", text: "fallback @fallback-reader body" } };
  const bytes = Buffer.from(JSON.stringify(event)), key = Buffer.alloc(32, 12);
  await enqueueSlackVerifiedIngress({ db: surface.db, aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "test-key", now: NOW, validateEndpoint: async () => true });
  let clock = NOW;
  const prepare = createSlackVerifiedIngressPreparer({ db: surface.db, now: () => clock,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db), payloadSealer: { async sealNormalizedPayload(input) {
      return { encryptedPayload: input.plaintext, envelopeKeyId: "test", aadVersion: 1 };
    } } });
  let refreshes = 0;
  const tick = () => processVerifiedSlackIngressOnce({ db: surface.db, leaseOwner: "fallback-raw", leaseMs: 30_000,
    requestAuthorRefresh: async () => { refreshes++; }, now: () => clock, prepare, crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } });
  if (kind !== "anonymous") {
    for (let i = 0; i < 3; i++) {
      assert.equal((await tick()).kind, i === 2 ? "held" : "deferred");
      clock = new Date(clock.getTime() + 60_000);
    }
    const { requeueDueSlackActor } = await import("./slackVerifiedIngressWorker");
    if (kind === "unresolved") {
      clock = new Date(NOW.getTime() + 10 * 60_000);
      assert.partialDeepStrictEqual(await prepare(event, aad, NOW), { kind: "unrecognized", reason: "actor_identity_pending" },
        "ten minutes alone cannot authorize the first fallback");
    }
    clock = new Date(NOW.getTime() + 24 * 60 * 60_000 + 1);
    if (kind === "unresolved") {
      const ready = await prepare(event, aad, NOW);
      assert.equal(ready.kind, "materialize");
      if (ready.kind === "materialize") assert.equal(ready.orderedActorId, "U_UNRESOLVED");
    }
    assert.equal(await requeueDueSlackActor({ db: surface.db, registrationId: aad.registrationId, environment: "test", now: clock }), true);
  }
  const staged = await tick();
  assert.equal(staged.kind, "materialized");
  const delivered = await processExternalInboundEventOnce({ db: surface.db, leaseOwner: "fallback-normalized", durableSlackMode: true,
    providerScope: "slack", dependencies: { now: () => clock, decryptNormalizedPayload: async input => input.ciphertext,
      resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => clock) } });
  assert.equal(delivered.kind, "committed");
  const [message] = await surface.db.select().from(messages).where(eq(messages.content, "fallback @fallback-reader body"));
  assert.ok(message);
  const [author] = await surface.db.select().from(externalMessageAuthorFacts).where(eq(externalMessageAuthorFacts.messageId, message.id));
  const expectedActorId = kind === "anonymous" ? "" : kind === "unresolved" ? "U_UNRESOLVED" : surface.projection.externalActorId;
  assert.equal(author.displayName, kind === "anonymous" ? "Slack" : `Slack user ${expectedActorId}`);
  assert.equal(author.externalActorId, expectedActorId);
  assert.equal(author.identityKind, kind === "anonymous" ? "anonymous" : "provider_actor");
  assert.equal(author.profileFallback, kind === "anonymous" ? null : "unresolved");
  assert.equal(refreshes, kind === "anonymous" ? 0 : 1, "the initial unknown author requests one refresh");
  if (kind === "unresolved") {
    const { slackIngressAuthorWakeSignals } = await import("../db/schema");
    const [wake] = await surface.db.select().from(slackIngressAuthorWakeSignals);
    assert.ok(wake, "fallback commit atomically records its author wake");
    assert.equal(wake.registrationId, aad.registrationId); assert.equal(wake.bindingId, surface.binding.id);
    assert.equal(wake.installId, surface.install.id); assert.equal(wake.workspaceId, aad.providerAuthorityId);
    assert.equal(wake.actorId, expectedActorId);
    const { listMessagesByIds } = await import("./messageService");
    const [view] = await listMessagesByIds([message.id]);
    assert.equal(view.externalAuthor?.profileFallback, "unresolved");
    const { hasSlackFallbackAuthor } = await import("./slackFallbackPolicy");
    const fallbackScope = { projectionId: author.projectionId, registrationId: aad.registrationId, installId: surface.install.id,
      workspaceId: aad.providerAuthorityId, externalActorId: expectedActorId };
    assert.equal(await hasSlackFallbackAuthor(surface.db, fallbackScope), true);
    assert.equal(await hasSlackFallbackAuthor(surface.db, { ...fallbackScope, externalActorId: "U_OTHER" }), false);
    assert.equal(await hasSlackFallbackAuthor(surface.db, { ...fallbackScope, workspaceId: "T_OTHER" }), false);
    clock = new Date(clock.getTime() + 250);
    await tick(); // settle the first normalized message, releasing the head
    const nextReceivedAt = clock;
    const nextAad = { ...aad, providerEventId: "Ev_FALLBACK_NEXT" };
    const nextEvent = { ...event, event_id: nextAad.providerEventId,
      event: { ...event.event, ts: "1785758341.000001", text: "next unresolved body" } };
    const nextBytes = Buffer.from(JSON.stringify(nextEvent));
    const nextReceipt = await enqueueSlackVerifiedIngress({ db: surface.db, aad: nextAad, rawDigest: createHash("sha256").update(nextBytes).digest("hex"),
      encryptedPayload: sealSlackVerifiedIngress({ bytes: nextBytes, key, aad: nextAad }), envelopeKeyId: "test-key",
      now: nextReceivedAt, validateEndpoint: async () => true });
    assert.equal((await tick()).kind, "held");
    const { slackVerifiedIngressEvents } = await import("../db/schema");
    const [heldNext] = await surface.db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, nextReceipt.id));
    assert.equal(heldNext?.nextAttemptAt.getTime(), nextReceivedAt.getTime() + 10 * 60_000);
    assert.equal(refreshes, 2, "the next unknown message requests one refresh");
    const otherAad = { ...aad, providerEventId: "Ev_OTHER_DURING_GRACE" };
    const otherEvent = { ...event, event_id: otherAad.providerEventId,
      event: { ...event.event, user: surface.projection.externalActorId, ts: "1785758341.100001", text: "other author during grace" } };
    const otherBytes = Buffer.from(JSON.stringify(otherEvent));
    await enqueueSlackVerifiedIngress({ db: surface.db, aad: otherAad, rawDigest: createHash("sha256").update(otherBytes).digest("hex"),
      encryptedPayload: sealSlackVerifiedIngress({ bytes: otherBytes, key, aad: otherAad }), envelopeKeyId: "test-key",
      now: clock, validateEndpoint: async () => true });
    assert.equal((await tick()).kind, "materialized", "another author can proceed during the grace period");
    assert.equal((await processExternalInboundEventOnce({ db: surface.db, leaseOwner: "grace-other", durableSlackMode: true,
      providerScope: "slack", dependencies: { now: () => clock, decryptNormalizedPayload: async input => input.ciphertext,
        resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => clock) } })).kind, "committed");
    clock = new Date(clock.getTime() + 250); await tick();
    clock = new Date(nextReceivedAt.getTime() + 9 * 60_000);
    assert.equal((await tick()).kind, "empty");
    const { requeueDueSlackActor } = await import("./slackVerifiedIngressWorker");
    assert.equal(await requeueDueSlackActor({ db: surface.db, registrationId: aad.registrationId, environment: "test", now: clock }), false,
      "a signal predating this hold cannot bypass the grace deadline");
    assert.equal(refreshes, 2, "retries of the same waiting head do not send another hint");
    clock = new Date(nextReceivedAt.getTime() + 10 * 60_000);
    assert.equal(await requeueDueSlackActor({ db: surface.db, registrationId: aad.registrationId, environment: "test", now: clock }), true);
    assert.equal((await tick()).kind, "materialized", "a proven fallback waits ten minutes, not another day");
    const nextResult = await processExternalInboundEventOnce({ db: surface.db, leaseOwner: "fallback-normalized-next", durableSlackMode: true,
      providerScope: "slack", dependencies: { now: () => clock, decryptNormalizedPayload: async input => input.ciphertext,
        resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => clock) } });
    assert.equal(nextResult.kind, "committed");
    const [nextMessage] = await surface.db.select().from(messages).where(eq(messages.content, "next unresolved body"));
    assert.ok(nextMessage); assert.ok(nextMessage.seq > message.seq);
    const [nextView] = await listMessagesByIds([nextMessage.id]);
    assert.equal(nextView.externalAuthor?.profileFallback, "unresolved");
    assert.equal(nextView.externalAuthor?.displayName, "Slack user U_UNRESOLVED");
    clock = new Date(clock.getTime() + 250); await tick();
    const fileReceivedAt = clock;
    const fileAad = { ...aad, providerEventId: "Ev_FALLBACK_FILE" };
    const fileEvent = { ...event, event_id: fileAad.providerEventId, event: { ...event.event, subtype: "file_share",
      ts: "1785758342.000001", text: "unresolved with file", files: [{ id: "F_FALLBACK" }] } };
    const fileBytes = Buffer.from(JSON.stringify(fileEvent));
    await enqueueSlackVerifiedIngress({ db: surface.db, aad: fileAad, rawDigest: createHash("sha256").update(fileBytes).digest("hex"),
      encryptedPayload: sealSlackVerifiedIngress({ bytes: fileBytes, key, aad: fileAad }), envelopeKeyId: "test-key",
      now: fileReceivedAt, validateEndpoint: async () => true });
    assert.equal((await tick()).kind, "held");
    clock = new Date(fileReceivedAt.getTime() + 10 * 60_000);
    assert.equal(await requeueDueSlackActor({ db: surface.db, registrationId: aad.registrationId, environment: "test", now: clock }), true);
    assert.equal((await tick()).kind, "materialized");
    const fileResult = await processExternalInboundEventOnce({ db: surface.db, leaseOwner: "fallback-normalized-file", durableSlackMode: true,
      providerScope: "slack", dependencies: { now: () => clock, decryptNormalizedPayload: async input => input.ciphertext,
        resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => clock) } });
    assert.equal(fileResult.kind, "blocked");
    if (fileResult.kind !== "blocked") throw new Error("expected file wait");
    assert.equal(fileResult.reason, "attachment_transfer_pending");
    const { externalAttachmentMessageFacts } = await import("../db/schema");
    const { hasVerifiedSlackFileFact } = await import("./slackVerifiedInboundFileProvenance");
    const [fileFact] = await surface.db.select().from(externalAttachmentMessageFacts);
    assert.ok(fileFact?.inboundEventId && fileFact.sourceActorProjectionId);
    assert.equal(await hasVerifiedSlackFileFact(surface.db, { factId: fileFact.id, eventId: fileFact.inboundEventId,
      projectionId: fileFact.sourceActorProjectionId, providerFileId: "F_FALLBACK" }), true);
    assert.equal(await hasVerifiedSlackFileFact(surface.db, { factId: fileFact.id, eventId: fileFact.inboundEventId,
      projectionId: fileFact.sourceActorProjectionId, providerFileId: "F_WRONG" }), false);
  }
  assert.equal((await surface.db.select().from(messageMentions).where(eq(messageMentions.messageId, message.id))).length, 0);
  assert.equal((await surface.db.select().from(inboxNotificationFacts).where(and(
    eq(inboxNotificationFacts.messageId, message.id), eq(inboxNotificationFacts.receiverType, "agent")))).length, 0);
  assert.equal((await surface.db.select().from(thirdPartyAgentEvents)).length, 0);
  const { deliverExternalInboundCommittedMessageToAgents } = await import("./messageService");
  const deliveries: unknown[] = [];
  await deliverExternalInboundCommittedMessageToAgents({ async deliverMessage(...args: unknown[]) {
    deliveries.push(args); return { status: "queued" };
  } } as never, message.id);
  assert.deepEqual(deliveries, [], "a display-only fallback must not notify any agent or app");
  if (kind === "anonymous") {
    const { listMessagesByIds, toAgentVisibleExternalMessage, projectAgentVisibleHttpMessageResponse, deliverMessagesToAgents,
      getMessageContext, syncMessages, emitExternalProjectionMessageToFrontend } = await import("./messageService");
    const { searchMessagesForUser } = await import("./searchService");
    const { agentApiMessageEnvelopeSchema, agentApiSearchResultSchema } = await import("@botiverse/raft-shared");
    const [enriched] = await listMessagesByIds([message.id]);
    assert.equal(enriched.senderName, "Slack");
    const marker = enriched.externalAuthor?.externalActorId;
    assert.match(marker ?? "", /^slack-anonymous:[0-9a-f]{64}$/);
    assert.equal(marker, `slack-anonymous:${createHash("sha256").update(JSON.stringify(["slack-anonymous-pair-v1",
      aad.registrationId, surface.binding.id])).digest("hex")}`, "the display marker is stable across epochs of the same pairing");
    const { resolveExternalMentionFromDurableAuthority } = await import("./externalProjectionService");
    const [address] = await surface.db.select().from(externalAddressabilityProjections)
      .where(eq(externalAddressabilityProjections.projectionId, surface.projection.id));
    const resolved = await surface.db.transaction(tx => resolveExternalMentionFromDurableAuthority({ executor: tx,
      rawHandle: "@Slack", explicitProjectionId: enriched.externalAuthor!.projectionId, raftPrincipalCollision: false, now: clock,
      context: { provider: "slack", appRegistrationId: aad.registrationId, installId: surface.install.id,
        workspaceId: aad.providerAuthorityId, connectionEpoch: surface.binding.connectionEpoch, bindingId: surface.binding.id,
        bindingEpoch: surface.binding.bindingEpoch, conversationId: aad.providerConversationId,
        memberRevision: address.memberRevision, contextRevision: address.contextRevision } }));
    assert.equal(resolved.kind, "not_resolved", "anonymous source cannot be mentioned as an external member");
    const markerMention = await surface.db.transaction(tx => resolveExternalMentionFromDurableAuthority({ executor: tx,
      rawHandle: "@Slack", explicitProjectionId: marker!, raftPrincipalCollision: false, now: clock,
      context: { provider: "slack", appRegistrationId: aad.registrationId, installId: surface.install.id,
        workspaceId: aad.providerAuthorityId, connectionEpoch: surface.binding.connectionEpoch, bindingId: surface.binding.id,
        bindingEpoch: surface.binding.bindingEpoch, conversationId: aad.providerConversationId,
        memberRevision: address.memberRevision, contextRevision: address.contextRevision } }));
    assert.equal(markerMention.kind, "not_resolved", "the public anonymous marker cannot be used as a mention target");
    assert.equal((await surface.db.select().from(users).where(sql`${users.id}::text = ${marker!}`)).length, 0);
    assert.equal((await surface.db.select().from(agents).where(sql`${agents.id}::text = ${marker!}`)).length, 0);
    assert.equal((await surface.db.select().from(externalAddressabilityProjections)
      .where(eq(externalAddressabilityProjections.projectionId, enriched.externalAuthor!.projectionId))).length, 0);
    assert.equal((await surface.db.select().from(users).where(eq(users.name, marker!))).length, 0);
    assert.equal((await surface.db.select().from(agents).where(eq(agents.name, marker!))).length, 0);
    await assert.rejects(surface.db.update(externalActorProjections).set({ actorKind: "human" })
      .where(eq(externalActorProjections.id, enriched.externalAuthor!.projectionId)), "anonymous projections cannot become members");
    await assert.rejects(surface.db.update(externalMessageAuthorFacts).set({ anonymousDisplayId: null })
      .where(eq(externalMessageAuthorFacts.messageId, message.id)), "an anonymous receipt must always retain its display marker");
    const mobileAccepts = (item: any) => {
      const author = item?.externalAuthor;
      return item?.senderType === "external_projection" && typeof item.senderId === "string" && !!item.senderId
        && !!author && ["actorKind", "appRegistrationId", "displayName", "externalActorId", "externalConversationId",
          "externalMessageId", "installId", "projectionId", "provider", "workspaceId"].every(key => typeof author[key] === "string" && !!author[key])
        && typeof author.actorProjectionRevision === "number";
    };
    assert.equal(enriched.senderId, marker); assert.equal(mobileAccepts(enriched), true);
    for (const key of ["actorKind", "appRegistrationId", "displayName", "externalActorId", "externalConversationId",
      "externalMessageId", "installId", "projectionId", "provider", "workspaceId", "actorProjectionRevision"]) {
      const incomplete = { ...enriched, externalAuthor: { ...enriched.externalAuthor } } as any;
      delete incomplete.externalAuthor[key]; assert.equal(mobileAccepts(incomplete), false, key);
    }
    const context = await getMessageContext(message.id);
    assert.equal(mobileAccepts(context?.messages.find(row => row.id === message.id)), true);
    const synced = await syncMessages(0, surface.channel.id, 200, surface.server.id);
    assert.equal(mobileAccepts(synced.find(row => row.id === message.id)), true);
    const emitted: any[] = [];
    const io = { to() { return { emit(event: string, value: unknown) { if (event === "message:new") emitted.push(value); } }; },
      in() { return { in() { return { socketsJoin() {} }; }, socketsJoin() {} }; } };
    await emitExternalProjectionMessageToFrontend(io as never, message.id);
    assert.ok(emitted.some(mobileAccepts), "realtime emission must retain the mobile-compatible anonymous author");
    assert.deepEqual(JSON.parse(JSON.stringify(toAgentVisibleExternalMessage(enriched))), { sender_id: "", senderId: "" });
    assert.equal(agentApiMessageEnvelopeSchema.safeParse({ sender_type: "third_party_app", sender_name: "Slack",
      content: message.content, ...toAgentVisibleExternalMessage(enriched) }).success, true);
    const projected = projectAgentVisibleHttpMessageResponse(enriched, message.content, reader.id);
    const parsedProjected = agentApiMessageEnvelopeSchema.safeParse(JSON.parse(JSON.stringify(projected)));
    assert.equal(parsedProjected.success, true, parsedProjected.success ? "" : JSON.stringify(parsedProjected.error.issues));
    assert.equal(projected.senderId, ""); assert.equal(projected.mentioned, false);
    const manuallyProjected: any[] = [];
    await deliverMessagesToAgents({ async deliverMessage(_id: string, data: unknown) {
      manuallyProjected.push(data); return { status: "queued" };
    } } as never, [enriched], "Slack");
    assert.ok(manuallyProjected.length > 0);
    for (const output of manuallyProjected) {
      assert.equal(agentApiMessageEnvelopeSchema.safeParse(output).success, true);
      assert.equal(output.sender_id, ""); assert.equal("external_message" in output, false);
      assert.equal(output.mentioned, false);
    }
    const found = await searchMessagesForUser({ serverId: surface.server.id, userId: surface.owner.id,
      channelId: surface.channel.id, query: "fallback", historyCutoff: undefined });
    const hit = found.results.find(row => row.id === message.id);
    assert.ok(hit); assert.equal(hit.externalMessage, null); assert.equal(hit.senderName, "Slack");
    assert.equal(agentApiSearchResultSchema.safeParse({ ...hit, senderId: "", senderType: "third_party_app" }).success, true);
  }
});

test.each(["unknown_human", "self_bot"] as const)("verified %s is safely settled or retained", async kind => {
  const { enableTestSlackIngress } = await import("../test/integration/slackIngressRollout");
  const { slackVerifiedIngressEvents, slackVerifiedIngressReplayAudits } = await import("../db/schema");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const { readHeldSlackIngressSummary, replayHeldSlackIngress } = await import("./slackVerifiedIngressWorker");
  const surface = await fixture("public"); await enableTestSlackIngress();
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const,
    registrationId: surface.registration.id, environment: "test" as const,
    providerAppId: surface.registration.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, providerEventId: `Ev_PENDING_${kind}` };
  const event = { type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId,
    event_id: aad.providerEventId, event: { type: "message", channel: aad.providerConversationId,
      user: kind === "self_bot" ? surface.install.botUserId : "U_NEVER_SEEN", ts: "1785758340.000001",
      text: "preserve this original", ...(kind === "self_bot" ? { subtype: "bot_message", bot_id: "B_SELF", app_id: aad.providerAppId } : {}) } };
  const bytes = Buffer.from(JSON.stringify(event)), key = Buffer.alloc(32, 11);
  const receipt = { db: surface.db, aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "test-key", now: NOW,
    validateEndpoint: async () => true };
  const original = await enqueueSlackVerifiedIngress(receipt);
  let clock = new Date(NOW);
  const prepare = createSlackVerifiedIngressPreparer({ db: surface.db, now: () => clock,
    botSyncEnabled: kind === "self_bot",
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(surface.db), payloadSealer: { async sealNormalizedPayload(input) {
      return { encryptedPayload: input.plaintext, envelopeKeyId: "test", aadVersion: 1 };
    } } });
  const tick = () => processVerifiedSlackIngressOnce({ db: surface.db, leaseOwner: "pending-author", leaseMs: 30_000,
    now: () => clock, scope: { registrationId: aad.registrationId, environment: aad.environment }, prepare,
    crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } } });
  const attempts = kind === "self_bot" ? 1 : 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    assert.equal((await tick()).kind, kind === "self_bot" ? "discarded" : attempt === attempts ? "held" : "deferred");
    clock = new Date(clock.getTime() + 60_000);
  }
  const [held] = await surface.db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, original.id));
  if (kind === "self_bot") {
    assert.equal(held.state, "discarded"); assert.equal(held.encryptedPayload, null);
    assert.equal(held.outcomeReason, "provider_self_echo");
    assert.equal((await enqueueSlackVerifiedIngress(receipt)).id, original.id);
    return;
  }
  assert.equal(held.state, "held"); assert.ok(held.encryptedPayload);
  assert.equal(held.outcomeReason, "actor_identity_pending");
  assert.equal((await enqueueSlackVerifiedIngress(receipt)).id, original.id, "provider retry must not make a second receipt");
  assert.equal((await readHeldSlackIngressSummary({ db: surface.db, registrationId: aad.registrationId,
    environment: aad.environment, providerAuthorityId: aad.providerAuthorityId,
    providerConversationId: aad.providerConversationId })).count, 1);
  const replay = { db: surface.db, partitionId: held.partitionId, eventId: held.id, now: () => clock,
    authorize: async () => ({ kind: "human" as const, id: "test-operator" }) };
  assert.equal(await replayHeldSlackIngress(replay), true);
  assert.equal(await replayHeldSlackIngress(replay), false);
  assert.equal((await surface.db.select().from(slackVerifiedIngressReplayAudits).where(eq(slackVerifiedIngressReplayAudits.eventId, held.id))).length, 1);
  const [replayed] = await surface.db.select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, held.id));
  assert.equal(replayed.state, "queued"); assert.ok(replayed.encryptedPayload);
  assert.equal((await surface.db.select().from(externalInboundEvents).where(eq(externalInboundEvents.providerEventId, aad.providerEventId))).length, 0);
});
