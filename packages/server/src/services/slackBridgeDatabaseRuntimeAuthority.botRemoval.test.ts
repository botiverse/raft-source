import { reconcileSlackChannelLifecycle } from "./slackBindingLifecycleService";
import { recoverSlackLifecyclePauses } from "./slackChannelLifecycleRecovery";
import type { SlackBridgeProvisioningProvider } from "./slackBridgeProvisioningControlPlane";
import { slackLifecycleClockAt } from "./slackChannelLifecycleObservation";
import { listSlackPairHeads } from "./slackBridgePairQueue";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import {
  agents,
  channelAgents,
  inboxNotificationFacts,
  channelHumans,
  externalActorProjections,
  externalAppCredentials,
  externalAppInstalls,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalDeliveryAttempts,
  externalDeliveryOperatorDecisions,
  externalDeliveryPartitions,
  externalOutboundDeliveries,
  externalInboundEvents,
  featureFlags,
  messages,
  messageMentions,
} from "../db/schema";
import { createSlackBridgeDatabaseOutboundRuntime, resolveCurrentOutboundAuthority } from "./slackBridgeDatabaseOutboundRuntime";
import {
  processExternalDeliveryPartitionHead,
  consumeExternalDeliverySkipDecision,
  recordSlackPairControlWait,
  clearResumedSlackPairControlWait,
  clearEmptySlackPairWaits,
  __setExternalDeliveryAttemptRowLockHookForTests,
} from "./externalDeliveryWorkerService";
import {
  enqueueSlackBridgeOutboundDelivery,
  maybeEnqueueOrdinaryMessageExternalDelivery,
  mintSlackBridgeReconciliationMarker,
} from "./externalDeliveryOutboxService";
import { createSlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import { createSlackBridgeEnvCredentialCipher } from "./slackBridgeEnvSecrets";
import { deleteFeatureFlagRule } from "./featureFlagService";
import { attachExternalBridgeMetadata } from "./channelService";
import { createSlackDatabaseInboundWorkerRuntimeResolver, slackBridgeDatabaseRuntimeRevision } from "./slackBridgeDatabaseRuntimeAuthority";
import { refreshSlackConversationAuthority } from "./slackBridgeProvisioningControlPlane";
import { resetStorageForTests } from "./storageService";
import { NOW, EXPIRES, fixture, resolveCurrentOutboundAuthorityOrNull, pairControlFixture, waitForControlState } from "./slackBridgeDatabaseRuntimeAuthority.testkit";

afterEach(async () => {
  __setExternalDeliveryAttemptRowLockHookForTests(null);
  resetStorageForTests();
  await closeTestDatabase();
});

for (const recovery of ["archive", "bot_removed", "bot_removed_provider_error"] as const) {
test(`${recovery} recovery clears the old pair wait and sends its original queued body followed by the next one`, async () => {
  const surface = await pairControlFixture(2);
  const before = new Date(NOW.getTime() - 3_600_000);
  const base = { serverId: surface.server.id, registrationId: surface.registration.id, installId: surface.install.id,
    bindingId: surface.binding.id, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, expectedConnectionEpoch: surface.install.connectionEpoch };
  const archived = await reconcileSlackChannelLifecycle({ ...base, expectedBindingEpoch: 3,
    event: recovery === "archive" ? { kind: "archived" } : { kind: "member_left", userId: surface.install.botUserId! }, eventClock: slackLifecycleClockAt(before), now: before });
  assert.equal(archived.kind, "applied");
  if (recovery === "bot_removed_provider_error") await surface.db.update(externalDeliveryPartitions)
    .set({ authorityBlockedReason: "slack_not_in_channel", authorityBlockedAt: before });
  else await recordSlackPairControlWait({ db: surface.db, ...surface.scope, currentBindingEpoch: 4,
    reason: recovery === "archive" ? "binding_paused_archived" : "binding_paused_bot_removed", now: before });
  if (recovery === "archive") {
    await reconcileSlackChannelLifecycle({ ...base, expectedBindingEpoch: 4,
      event: { kind: "available", name: "verified-restored" }, eventClock: slackLifecycleClockAt(NOW), now: NOW });
  } else {
    const provider: SlackBridgeProvisioningProvider = {
      async readInstallGrant() { return { kind: "unverified" }; },
      async readWorkspace() { return { oauth: "unverified", directory: { kind: "unverified" } }; },
      async readConversationState() { return { kind: "fact", fact: { id: surface.binding.providerConversationId,
        name: "verified-restored", isArchived: false, isMember: true } }; },
      async readConversationAudience() { return { kind: "fact", fact: {
        providerMemberIds: [surface.install.botUserId!, surface.projection.externalActorId],
        users: [{ id: surface.projection.externalActorId, displayName: "External Human", handle: null, actorKind: "human" }],
      } }; },
    };
    await recoverSlackLifecyclePauses({ db: surface.db, provider, bindingId: surface.binding.id, now: NOW });
  }
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, null);
  const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 43) });
  const sealed = await cipher.sealer.seal({ serverId: surface.server.id, accessToken: "synthetic-lifecycle-token", tokenType: "bot",
    providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!, botUserId: surface.install.botUserId!, now: NOW });
  await surface.db.update(externalAppCredentials).set({ encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion });
  const texts: string[] = [];
  const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: cipher, now: () => NOW,
    fetch: (async (url, init) => {
      assert.equal(new URL(String(url)).pathname.split("/").at(-1), "chat.postMessage");
      const body = JSON.parse(String(init?.body)); texts.push(body.text);
      return new Response(JSON.stringify({ ok: true, channel: surface.binding.providerConversationId,
        ts: `${Math.floor(NOW.getTime() / 1000)}.${String(texts.length).padStart(6, "0")}` }), { status: 200 });
    }) as typeof fetch });
  let complete!: () => void; let fail!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
    reconciliationKey: "control-test", now: () => NOW, workerIntervalMs: 60_000,
    async runWorkerOnce(input) {
      try {
        for (let index = 0; index < 2; index++) {
          const result = await processExternalDeliveryPartitionHead(input);
          assert.equal(result.kind === "attempted" ? result.deliveryState : result.kind, "accepted");
        }
        complete(); return { kind: "empty" };
      } catch (error) { fail(error); throw error; }
    } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  runtime.start();
  try { await Promise.race([done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("resumed queue did not drain")), 10_000); })]); }
  finally { if (timer) clearTimeout(timer); await runtime.stop(); await provider.stop(); }
  assert.equal(texts.length, 2);
  assert.ok(texts[0]!.includes("pair control body 0")); assert.ok(texts[1]!.includes("pair control body 1"));
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.cursorPosition, 2);
});

}

test("unarchiving a pair while the master is off retains the original administrative wait", async () => {
  const surface = await pairControlFixture(1);
  const before = new Date(NOW.getTime() - 3_600_000);
  const base = { serverId: surface.server.id, registrationId: surface.registration.id, installId: surface.install.id,
    bindingId: surface.binding.id, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, expectedConnectionEpoch: surface.install.connectionEpoch };
  await reconcileSlackChannelLifecycle({ ...base, expectedBindingEpoch: 3, event: { kind: "archived" }, now: before });
  await recordSlackPairControlWait({ db: surface.db, ...surface.scope, currentBindingEpoch: 4, reason: "master_disabled", now: before });
  await surface.db.update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, SLACK_BRIDGE_FEATURE_FLAG_KEYS.master));
  await reconcileSlackChannelLifecycle({ ...base, expectedBindingEpoch: 4, event: { kind: "available", name: "verified-restored" }, now: NOW });
  const [partition] = await surface.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.authorityBlockedReason, "master_disabled");
  assert.equal(partition.authorityBlockedAt?.toISOString(), before.toISOString());
  assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.providerAttempts, 0);
});

for (const pause of ["archive", "bot_removed", "bot_removed_audience", "manual", "inactive_install"] as const) {
  test(`new bodies published during ${pause} obey lifecycle queue admission and resume in order`, async () => {
    const surface = await pairControlFixture(1);
    const base = { serverId: surface.server.id, registrationId: surface.registration.id, installId: surface.install.id,
      bindingId: surface.binding.id, providerAuthorityId: surface.install.providerAuthorityId,
      providerConversationId: surface.binding.providerConversationId, expectedConnectionEpoch: surface.install.connectionEpoch };
    if (pause === "manual") await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "manager_paused" });
    else if (pause === "bot_removed_audience") {
      // Exercise the actual full-audience path, without a bot-leave event.
      const missingBot: SlackBridgeProvisioningProvider = {
        async readInstallGrant() { return { kind: "unverified" }; },
        async readWorkspace() { return { oauth: "unverified", directory: { kind: "unverified" } }; },
        async readConversationAudience() { return { kind: "fact", fact: {
          providerMemberIds: [surface.projection.externalActorId],
          users: [{ id: surface.projection.externalActorId, displayName: "External Human", handle: null, actorKind: "human" }],
        } }; },
      };
      await refreshSlackConversationAuthority({ db: surface.db, provider: missingBot,
        bindingId: surface.binding.id, now: new Date(NOW.getTime() + 1_000) });
      const [paused] = await surface.db.select().from(externalChannelBindings).where(eq(externalChannelBindings.id, surface.binding.id));
      assert.equal(paused.state, "paused");
      assert.equal(paused.stateReason, "provider_bot_removed");
      assert.equal(paused.bindingEpoch, 4);
    } else await reconcileSlackChannelLifecycle({ ...base, expectedBindingEpoch: 3,
      event: pause === "archive" ? { kind: "archived" } : { kind: "member_left", userId: surface.install.botUserId! },
      now: new Date(NOW.getTime() - 60_000) });
    if (pause === "inactive_install") await surface.db.update(externalAppInstalls).set({ state: "reauth_required", stateReason: "provider_tokens_revoked" });
    const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 45) });
    const sealed = await cipher.sealer.seal({ serverId: surface.server.id, accessToken: "synthetic-paused-admission", tokenType: "bot",
      providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!, botUserId: surface.install.botUserId!, now: NOW });
    await surface.db.update(externalAppCredentials).set({ encryptedMaterial: sealed.encryptedMaterial,
      envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion });
    let resumed = false; let providerPosts = 0;
    let clock = pause === "bot_removed_audience" ? new Date(NOW.getTime() + 2_000) : NOW;
    const texts: string[] = [];
    const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: cipher, now: () => clock,
      fetch: (async (url, init) => {
        providerPosts++;
        assert.ok(resumed, "queue admission during a pause must not call Slack");
        assert.equal(new URL(String(url)).pathname.split("/").at(-1), "chat.postMessage");
        if (pause === "bot_removed_audience") {
          const [proof] = await surface.db.select().from(externalBindingAudienceSnapshots).where(and(
            eq(externalBindingAudienceSnapshots.bindingId, surface.binding.id),
            eq(externalBindingAudienceSnapshots.bindingEpoch, 4),
          )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1);
          assert.equal(proof?.status, "matched", "a durable matched audience must precede each send");
        }
        texts.push(JSON.parse(String(init?.body)).text);
        return new Response(JSON.stringify({ ok: true, channel: surface.binding.providerConversationId,
          ts: `${Math.floor(NOW.getTime() / 1000)}.${String(texts.length).padStart(6, "0")}` }), { status: 200 });
      }) as typeof fetch });
    const runtimeErrors: unknown[] = [];
    const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider,
      registrationId: surface.registration.id, reconciliationKey: "paused-admission", now: () => clock, workerIntervalMs: 20,
      onError: error => runtimeErrors.push(error) });
    runtime.start();
    try {
      const queued = await surface.db.transaction(async executor => {
        const [message] = await executor.insert(messages).values({ channelId: surface.channel.id,
          senderType: "user", senderId: surface.owner.id, messageType: "chat", content: "published while paused" }).returning();
        return maybeEnqueueOrdinaryMessageExternalDelivery({ executor, message: message!, requestedChannelId: surface.channel.id,
          senderType: "user", senderId: surface.owner.id, authorName: surface.owner.name,
          sourceText: message!.content, decision: { eligible: true } });
      });
      assert.equal(Boolean(queued), pause !== "manual" && pause !== "inactive_install");
      assert.equal(texts.length, 0);
      if (pause === "manual" || pause === "inactive_install") return;
      const forbidden = await resolveCurrentOutboundAuthority({ executor: surface.db, bindingId: surface.binding.id,
        expectedConnectionEpoch: surface.install.connectionEpoch, expectedBindingEpoch: 4, expectedAudienceRevision: 1,
        senderType: "user", senderId: surface.owner.id, registrationId: surface.registration.id, now: NOW,
        allowLifecyclePausedAdmission: true });
      assert.equal(forbidden.current, false, "queue-only admission cannot authorize a frozen provider dispatch");
      if (pause === "bot_removed" || pause === "bot_removed_audience") {
        let audienceAvailable = pause !== "bot_removed_audience";
        const verifier: SlackBridgeProvisioningProvider = {
          async readInstallGrant() { return { kind: "unverified" }; },
          async readWorkspace() { return { oauth: "unverified", directory: { kind: "unverified" } }; },
          async readConversationState() { return { kind: "fact", fact: { id: surface.binding.providerConversationId,
            name: "verified-restored", isArchived: false, isMember: true } }; },
          async readConversationAudience() { return audienceAvailable ? { kind: "fact", fact: {
            providerMemberIds: [surface.install.botUserId!, surface.projection.externalActorId],
            users: [{ id: surface.projection.externalActorId, displayName: "External Human", handle: null, actorKind: "human" }],
          } } : { kind: "unverified" }; },
        };
        if (pause === "bot_removed_audience") {
          await waitForControlState(async () => (await surface.db.select().from(externalDeliveryPartitions))
            .some(partition => partition.authorityBlockedReason === "binding_paused_bot_removed"));
          await recoverSlackLifecyclePauses({ db: surface.db, provider: verifier, bindingId: surface.binding.id, now: clock,
            clock: () => clock, onError: error => runtimeErrors.push(error) });
          const [stillPaused] = await surface.db.select().from(externalChannelBindings).where(eq(externalChannelBindings.id, surface.binding.id));
          assert.equal(stillPaused.stateReason, "provider_bot_removed", "an unverified audience cannot resume the pair");
          assert.equal(providerPosts, 0, "neither queued message can reach Slack before a matched audience");
          audienceAvailable = true;
          clock = new Date(clock.getTime() + 31_000);
        }
        resumed = true;
        await recoverSlackLifecyclePauses({ db: surface.db, provider: verifier, bindingId: surface.binding.id, now: clock,
          clock: () => clock, onError: error => runtimeErrors.push(error) });
      } else {
        resumed = true;
        await reconcileSlackChannelLifecycle({ ...base, expectedBindingEpoch: 4,
          event: { kind: "available", name: "verified-restored" }, now: clock });
      }
      await waitForControlState(async () => (await surface.db.select().from(externalOutboundDeliveries)).every(row => row.state === "accepted"));
      assert.deepEqual(runtimeErrors, []);
      assert.equal(texts.length, 2); assert.ok(texts[0]!.includes("pair control body 0"));
      assert.ok(texts[1]!.includes("published while paused"));
    } finally { await runtime.stop(); await provider.stop(); }
  });
}

test("bot-removal queue admission does not relax other mismatch or dispatch fences", async () => {
  const surface = await pairControlFixture(0);
  await surface.db.insert(externalBindingAudienceSnapshots).values({
    bindingId: surface.binding.id, bindingEpoch: 3, audienceRevision: 2,
    externalMemberCount: 0, externalAudienceDigest: "synthetic-external",
    raftMemberCount: 1, raftAudienceDigest: "synthetic-raft", status: "mismatch",
    observedAt: NOW, expiresAt: EXPIRES,
  });
  const input = { executor: surface.db, bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.install.connectionEpoch, expectedBindingEpoch: 3,
    senderType: "user" as const, senderId: surface.owner.id, registrationId: surface.registration.id,
    allowLifecyclePausedAdmission: true as const, now: NOW };
  assert.equal((await resolveCurrentOutboundAuthority(input)).current, false, "active mismatch stays blocked");
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_archived" })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  assert.equal((await resolveCurrentOutboundAuthority(input)).current, false, "archive mismatch stays blocked");
  await surface.db.update(externalChannelBindings).set({ stateReason: "provider_bot_removed" })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  assert.equal((await resolveCurrentOutboundAuthority(input)).current, true, "bot pause admits to custody");
  assert.equal((await resolveCurrentOutboundAuthority({ ...input, expectedAudienceRevision: 1 })).current, false,
    "queue admission never authorizes a frozen dispatch");
  await surface.db.update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, SLACK_BRIDGE_FEATURE_FLAG_KEYS.master));
  assert.equal((await resolveCurrentOutboundAuthority(input)).current, false, "master switch still blocks admission");
});

for (const change of ["presentation", "identity_unavailable", "provisional_profile", "provisional_timeout", "provisional_timeout_private"] as const) {
  test(`same-binding inbound retains and revalidates a joined member (${change})`, async () => {
    const timeout = change.startsWith("provisional_timeout");
    const surface = await fixture(change === "provisional_timeout_private" ? "private" : "public");
    const { enqueueExternalInboundEvent, processExternalInboundEventOnce } = await import("./externalInboundWorkerService");
    const { externalMessageAuthorFacts } = await import("../db/schema");
    if (timeout) {
      await surface.db.insert(channelHumans).values({ channelId: surface.channel.id, userId: surface.owner.id });
      const [reader] = await surface.db.insert(agents).values({ serverId: surface.server.id, name: "provisional-reader", runtime: "codex" }).returning();
      await surface.db.insert(channelAgents).values({ channelId: surface.channel.id, agentId: reader!.id });
    }
    const body = timeout ? `first joined-member body @provisional-reader <@${surface.install.botUserId}>` : "first joined-member body";
    const a = surface.authority;
    const frozen = { runtimeRevision: slackBridgeDatabaseRuntimeRevision(a), provider: "slack", environment: "test" as const,
      appRegistrationId: a.registrationId, installId: a.installId, workspaceId: a.providerAuthorityId,
      providerAuthorityId: a.providerAuthorityId, providerConversationId: a.providerConversationId,
      bindingId: a.bindingId, bindingEpoch: a.bindingEpoch, connectionEpoch: a.connectionEpoch,
      raftChannelId: a.channelId, privacyClass: a.privacyClass };
    const plaintext = JSON.stringify({ schema: "external-inbound-normalized-event.v1", projectionId: surface.projection.id,
      actorProjectionRevision: surface.projection.projectionRevision, externalActorId: surface.projection.externalActorId,
      providerMessageId: `${Math.floor(NOW.getTime() / 1000)}.001000`, providerThreadId: null,
      content: body, createdAt: NOW.toISOString() });
    const admitted = await enqueueExternalInboundEvent({ db: surface.db, authority: frozen,
      providerEventId: `Ev_joined_${change}`, normalizedPayloadDigest: createHash("sha256").update(plaintext).digest("hex"),
      encryptedPayload: plaintext, envelopeKeyId: "synthetic-joined", payloadSchemaVersion: 1,
      payloadExpiresAt: new Date(NOW.getTime() + 30 * 60_000), receivedAt: NOW });
    assert.ok(admitted.event.id);
    if (change === "presentation") await surface.db.update(externalActorProjections).set({ displayName: "Current member profile",
      projectionRevision: surface.projection.projectionRevision + 1 }).where(eq(externalActorProjections.id, surface.projection.id));
    else if (change === "identity_unavailable") await surface.db.update(externalActorProjections).set({ deactivated: true })
      .where(eq(externalActorProjections.id, surface.projection.id));
    else await surface.db.update(externalActorProjections).set({ actorKind: "unknown", displayName: surface.projection.externalActorId })
      .where(eq(externalActorProjections.id, surface.projection.id));
    let clock = NOW;
    const run = () => processExternalInboundEventOnce({ db: surface.db, leaseOwner: "joined-member-worker",
      dependencies: { now: () => clock, decryptNormalizedPayload: async input => input.ciphertext,
        resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => clock) } });
    const first = await run();
    if (change !== "presentation") {
      assert.equal(first.kind, "blocked");
      const [held] = await surface.db.select().from(externalInboundEvents).where(eq(externalInboundEvents.id, admitted.event.id));
      assert.notEqual(held.status, "revoked"); assert.equal(held.encryptedPayload, plaintext, "temporary identity failure must retain custody");
      if (!timeout) await surface.db.update(externalActorProjections).set({ state: "active", deactivated: false, actorKind: "human", displayName: "Current member profile",
        projectionRevision: surface.projection.projectionRevision + 1 }).where(eq(externalActorProjections.id, surface.projection.id));
      clock = new Date(NOW.getTime() + (timeout ? 11 * 60_000 : 60_000));
      assert.equal((await run()).kind, "committed");
    } else assert.equal(first.kind, "committed");
    const delivered = await surface.db.select().from(messages).where(eq(messages.content, body));
    assert.equal(delivered.length, 1);
    const [author] = await surface.db.select().from(externalMessageAuthorFacts).where(eq(externalMessageAuthorFacts.messageId, delivered[0]!.id));
    assert.equal(author.displayName, timeout ? surface.projection.externalActorId : "Current member profile");
    assert.equal(author.actorKind, timeout ? "unknown" : "human");
    if (timeout) {
      assert.equal((await surface.db.select().from(messageMentions).where(eq(messageMentions.messageId, delivered[0]!.id))).length, 0);
      const facts = await surface.db.select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.messageId, delivered[0]!.id));
      assert.equal(facts.filter(fact => fact.receiverType === "agent").length, 0, "provisional author cannot wake an agent");
      if (change === "provisional_timeout") assert.ok(facts.some(fact => fact.receiverType === "user"), "human inbox still receives the body");
    }
  });
}

test("a bot-removal control wait preserves an earlier not_in_channel failure", async () => {
  const surface = await pairControlFixture(1);
  surface.deps.dispatchProvider = async () => ({ kind: "deterministic_failure", reasonCode: "not_in_channel", pairBlockedReason: "slack_not_in_channel" });
  assert.equal((await surface.head()).kind, "attempted");
  const [failed] = await surface.db.select().from(externalDeliveryPartitions);
  assert.equal(failed.authorityBlockedReason, "slack_not_in_channel");
  await reconcileSlackChannelLifecycle({ db: surface.db, serverId: surface.server.id, registrationId: surface.registration.id,
    installId: surface.install.id, bindingId: surface.binding.id, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, expectedConnectionEpoch: surface.install.connectionEpoch,
    expectedBindingEpoch: 3, event: { kind: "member_left", userId: surface.install.botUserId! }, now: NOW });
  const result = await recordSlackPairControlWait({ db: surface.db, ...surface.scope, currentBindingEpoch: 4,
    reason: "binding_paused_bot_removed", now: NOW });
  assert.equal(result.kind, "authority_blocked");
  const [retained] = await surface.db.select().from(externalDeliveryPartitions);
  assert.equal(retained.authorityBlockedReason, "slack_not_in_channel");
  assert.equal(retained.authorityBlockedAt?.getTime(), failed.authorityBlockedAt?.getTime());
  await surface.db.update(externalDeliveryPartitions).set({ authorityRetryAt: null });
  const guarded = await surface.head();
  assert.equal(guarded.kind === "blocked" ? guarded.reason : null, "slack_audience_revalidation_required",
    "the audience guard, not the retry timer, prevents a new claim");
});

test("skipping a bot-removal head and multiple generation waits cannot release a later generation without audience verification", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: NOW, authorityBlockedReason: "slack_not_in_channel" });
  const [decision] = await surface.db.insert(externalDeliveryOperatorDecisions).values({ deliveryId: surface.deliveries[0]!.id,
    bindingId: surface.binding.id, bindingEpoch: 3, partitionPosition: 1, action: "skip", actorType: "user",
    actorId: surface.owner.id, reason: "synthetic skip", dataLossAcknowledged: true, decisionRevision: 1 }).returning();
  assert.equal((await consumeExternalDeliverySkipDecision({ db: surface.db, bindingId: surface.binding.id,
    bindingEpoch: 3, decisionId: decision!.id, now: NOW })).kind, "skipped");
  await clearEmptySlackPairWaits({ db: surface.db, bindings: [{ bindingId: surface.binding.id, bindingEpoch: 3 }], now: NOW });
  await surface.db.update(externalChannelBindings).set({ bindingEpoch: 4 }).where(eq(externalChannelBindings.id, surface.binding.id));
  await clearResumedSlackPairControlWait({ db: surface.db, ...surface.scope, currentBindingEpoch: 4,
    now: NOW, verifiedConversationAvailable: true });
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "slack_not_in_channel");

  const current = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
    expectedBindingEpoch: 4, expectedConnectionEpoch: 2, senderType: "user", senderId: surface.owner.id,
    now: NOW, registrationId: surface.registration.id });
  assert.ok(current);
  const [message] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
    senderType: "user", senderId: surface.owner.id, content: "later generation" }).returning();
  await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message: message!,
    activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
      runtimePredicateRevision: current.runtimeRevision, bindingAuthority: current.neutral },
    canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
    authorName: surface.owner.name, sanitizedText: message!.content,
    mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("control-test", deliveryId) }));
  const [channel] = await attachExternalBridgeMetadata([{ id: surface.channel.id }]);
  assert.deepEqual(channel.bridge?.outbound, { status: "waiting", reason: "invite_app", since: NOW.toISOString() },
    "the actual channel projection shows a wait held in an empty older generation");
  await surface.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: NOW, authorityBlockedReason: "binding_paused_bot_removed" })
    .where(and(eq(externalDeliveryPartitions.bindingId, surface.binding.id), eq(externalDeliveryPartitions.bindingEpoch, 4)));
  const runNew = () => processExternalDeliveryPartitionHead({ db: surface.db, bindingId: surface.binding.id,
    bindingEpoch: 4, leaseOwner: "pair-control-test", dependencies: surface.deps });
  const blocked = await runNew();
  assert.equal(blocked.kind === "blocked" ? blocked.reason : null, "slack_audience_revalidation_required");
  assert.equal(surface.providerCalls(), 0);

  const provider: SlackBridgeProvisioningProvider = {
    async readInstallGrant() { return { kind: "unverified" }; },
    async readWorkspace() { return { oauth: "unverified", directory: { kind: "unverified" } }; },
    async readConversationState() { return { kind: "fact", fact: { id: surface.binding.providerConversationId,
      name: "verified-restored", isArchived: false, isMember: true } }; },
    async readConversationAudience() { return { kind: "fact", fact: {
      providerMemberIds: [surface.install.botUserId!, surface.projection.externalActorId],
      users: [{ id: surface.projection.externalActorId, displayName: "External Human", handle: null, actorKind: "human" }],
    } }; },
  };
  await recoverSlackLifecyclePauses({ db: surface.db, provider, bindingId: surface.binding.id, now: new Date(NOW.getTime() + 31_000) });
  let partitions = await surface.db.select().from(externalDeliveryPartitions);
  assert.equal(partitions.filter((partition) => partition.authorityBlockedReason !== null).length, 1);
  const stillBlocked = await runNew();
  assert.equal(stillBlocked.kind === "blocked" ? stillBlocked.reason : null, "slack_audience_revalidation_required");
  assert.equal(surface.providerCalls(), 0);
  await recoverSlackLifecyclePauses({ db: surface.db, provider, bindingId: surface.binding.id, now: new Date(NOW.getTime() + 62_000) });
  partitions = await surface.db.select().from(externalDeliveryPartitions);
  assert.ok(partitions.every((partition) => partition.authorityBlockedReason === null));
  surface.deps.resolveCurrentRuntime = async () => ({ runtimeRevision: current.runtimeRevision, bindingAuthority: current.neutral });
  surface.deps.leaseCredential = async () => ({ handle: {}, runtimeRevision: current.runtimeRevision, credentialRevision: 1, ...current.neutral });
  surface.deps.dispatchProvider = async () => ({ kind: "accepted", providerMessageId: "later-generation" });
  const sent = await runNew();
  assert.equal(sent.kind === "attempted" ? sent.deliveryState : sent.kind, "accepted");
});

test("active not_in_channel wait clears only after a fresh matched audience", async () => {
  const surface = await pairControlFixture(1);
  surface.deps.dispatchProvider = async () => ({ kind: "deterministic_failure", reasonCode: "not_in_channel", pairBlockedReason: "slack_not_in_channel" });
  assert.equal((await surface.head()).kind, "attempted");
  let matched = false;
  const provider: SlackBridgeProvisioningProvider = {
    async readInstallGrant() { return { kind: "unverified" }; },
    async readWorkspace() { return { oauth: "unverified", directory: { kind: "unverified" } }; },
    async readConversationState() { return { kind: "fact", fact: { id: surface.binding.providerConversationId,
      name: "runtime", isArchived: false, isMember: true } }; },
    async readConversationAudience() { return matched ? { kind: "fact", fact: {
      providerMemberIds: [surface.install.botUserId!, surface.projection.externalActorId],
      users: [{ id: surface.projection.externalActorId, displayName: "External Human", handle: null, actorKind: "human" }],
    } } : { kind: "unverified" }; },
  };
  let now = new Date(NOW.getTime() + 1000);
  const recover = () => recoverSlackLifecyclePauses({ db: surface.db, provider, bindingId: surface.binding.id,
    now, clock: () => now });
  await recover();
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "slack_not_in_channel");
  matched = true; now = new Date(now.getTime() + 31_000); await recover();
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, null);
  let reconciliations = 0;
  surface.deps.now = () => now;
  surface.deps.prepareProvider = async ({ reconcileUnknownOutcome }) => {
    assert.equal(reconcileUnknownOutcome, true, "the old uncertain outcome must be checked before another write");
    reconciliations++;
    const receipt = { kind: "accepted" as const, providerMessageId: "recovered-once", reconciled: true };
    return { ready: true, receipt, async dispatch() { assert.fail("a confirmed receipt must not be sent again"); } };
  };
  surface.deps.dispatchProvider = async () => { assert.fail("unknown outcome must not be written blindly"); };
  await surface.head();
  assert.equal(reconciliations, 1);
  assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.state, "accepted");
});

test("a not_in_channel failure during audience verification requires a newer proof", async () => {
  const surface = await pairControlFixture(1);
  surface.deps.dispatchProvider = async () => ({ kind: "deterministic_failure", reasonCode: "not_in_channel", pairBlockedReason: "slack_not_in_channel" });
  let sendDuringRead = true;
  const provider: SlackBridgeProvisioningProvider = {
    async readInstallGrant() { return { kind: "unverified" }; },
    async readWorkspace() { return { oauth: "unverified", directory: { kind: "unverified" } }; },
    async readConversationState() { return { kind: "fact", fact: { id: surface.binding.providerConversationId,
      name: "runtime", isArchived: false, isMember: true } }; },
    async readConversationAudience() {
      const observed = { kind: "fact" as const, fact: {
        providerMemberIds: [surface.install.botUserId!, surface.projection.externalActorId],
        users: [{ id: surface.projection.externalActorId, displayName: "External Human", handle: null, actorKind: "human" as const }],
      } };
      if (sendDuringRead) { sendDuringRead = false; assert.equal((await surface.head()).kind, "attempted"); }
      return observed;
    },
  };
  const now = new Date(NOW.getTime() + 1000);
  await recoverSlackLifecyclePauses({ db: surface.db, provider, bindingId: surface.binding.id, now });
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "slack_not_in_channel");
  assert.equal((await surface.head()).kind, "blocked");
  await recoverSlackLifecyclePauses({ db: surface.db, provider, bindingId: surface.binding.id,
    now: new Date(now.getTime() + 31_000) });
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, null);
});

test("a new failure on the same partition during verification requires a new head proof", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: NOW, authorityBlockedReason: "slack_not_in_channel" });
  surface.deps.dispatchProvider = async () => ({ kind: "deterministic_failure", reasonCode: "not_in_channel", pairBlockedReason: "slack_not_in_channel" });
  let replaceWait = true;
  const provider: SlackBridgeProvisioningProvider = {
    async readInstallGrant() { return { kind: "unverified" }; },
    async readWorkspace() { return { oauth: "unverified", directory: { kind: "unverified" } }; },
    async readConversationState() { return { kind: "fact", fact: { id: surface.binding.providerConversationId,
      name: "runtime", isArchived: false, isMember: true } }; },
    async readConversationAudience() {
      if (replaceWait) {
        replaceWait = false;
        // A different recovery clears the old wait before a new provider
        // failure puts the same partition back in the same kind of wait.
        await surface.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: null, authorityBlockedReason: null });
        assert.equal((await surface.head()).kind, "attempted");
      }
      return { kind: "fact", fact: { providerMemberIds: [surface.install.botUserId!, surface.projection.externalActorId],
        users: [{ id: surface.projection.externalActorId, displayName: "External Human", handle: null, actorKind: "human" }] } };
    },
  };
  const now = new Date(NOW.getTime() + 1000);
  await recoverSlackLifecyclePauses({ db: surface.db, provider, bindingId: surface.binding.id, now });
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "slack_not_in_channel",
    "the same wait id cannot reuse a proof taken before the head was sent");
  assert.equal((await surface.head()).kind, "blocked");
  await recoverSlackLifecyclePauses({ db: surface.db, provider, bindingId: surface.binding.id,
    now: new Date(now.getTime() + 31_000) });
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, null);
});

test("a removed bot can recover after an expired pre-I/O claim without sending during the pause", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalOutboundDeliveries).set({ state: "dispatching", leaseOwner: "crashed-worker", leaseGeneration: 1,
    leaseOriginState: "queued", leaseExpiresAt: new Date(NOW.getTime() + 60_000) });
  await reconcileSlackChannelLifecycle({ db: surface.db, serverId: surface.server.id, registrationId: surface.registration.id,
    installId: surface.install.id, bindingId: surface.binding.id, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, expectedConnectionEpoch: surface.install.connectionEpoch,
    expectedBindingEpoch: 3, event: { kind: "member_left", userId: surface.install.botUserId! }, now: NOW });
  const scope = { ...surface.scope, currentBindingEpoch: 4 };
  const live = await recordSlackPairControlWait({ db: surface.db, ...scope, reason: "binding_paused_bot_removed",
    now: new Date(NOW.getTime() + 30_000) });
  assert.equal(live.kind === "blocked" ? live.reason : null, "lease_owned");
  const expired = await recordSlackPairControlWait({ db: surface.db, ...scope, reason: "binding_paused_bot_removed",
    now: new Date(NOW.getTime() + 61_000) });
  assert.equal(expired.kind, "authority_blocked");
  const [reclaimed] = await surface.db.select().from(externalOutboundDeliveries);
  assert.equal(reclaimed.state, "queued"); assert.equal(reclaimed.leaseOwner, null);
  assert.equal((await surface.db.select().from(externalDeliveryAttempts)).length, 0);
  assert.equal(surface.providerCalls(), 0);
  const provider: SlackBridgeProvisioningProvider = {
    async readInstallGrant() { return { kind: "unverified" }; },
    async readWorkspace() { return { oauth: "unverified", directory: { kind: "unverified" } }; },
    async readConversationState() { return { kind: "fact", fact: { id: surface.binding.providerConversationId,
      name: "verified", isArchived: false, isMember: true } }; },
    async readConversationAudience() { return { kind: "fact", fact: {
      providerMemberIds: [surface.install.botUserId!, surface.projection.externalActorId],
      users: [{ id: surface.projection.externalActorId, displayName: "External Human", handle: null, actorKind: "human" }],
    } }; },
  };
  await recoverSlackLifecyclePauses({ db: surface.db, provider, bindingId: surface.binding.id,
    now: new Date(NOW.getTime() + 62_000) });
  assert.equal((await surface.db.select().from(externalChannelBindings))[0]!.state, "active");
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, null);
  assert.equal(surface.providerCalls(), 0, "recovery itself never sends the queued message");
});

test("the paused runtime reclaims an expired head even when a bot-removal wait is already recorded", async () => {
  const surface = await pairControlFixture(1);
  await reconcileSlackChannelLifecycle({ db: surface.db, serverId: surface.server.id, registrationId: surface.registration.id,
    installId: surface.install.id, bindingId: surface.binding.id, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, expectedConnectionEpoch: surface.install.connectionEpoch,
    expectedBindingEpoch: 3, event: { kind: "member_left", userId: surface.install.botUserId! }, now: NOW });
  await surface.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: NOW, authorityBlockedReason: "binding_paused_bot_removed" });
  await surface.db.update(externalOutboundDeliveries).set({ state: "dispatching", leaseOwner: "crashed-worker", leaseGeneration: 1,
    leaseOriginState: "queued", leaseExpiresAt: new Date(NOW.getTime() + 60_000) });
  const clock = new Date(NOW.getTime() + 61_000);
  const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) }),
    now: () => clock, fetch: (async () => { assert.fail("paused reclamation cannot call Slack"); }) as typeof fetch });
  let workerCalls = 0; const errors: unknown[] = [];
  const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
    reconciliationKey: "control-test", now: () => clock, workerIntervalMs: 10, onError: (error) => errors.push(error),
    runWorkerOnce: async () => { workerCalls++; throw new Error("paused reclamation cannot run the sender"); } });
  runtime.start();
  try { await waitForControlState(async () => (await surface.db.select().from(externalOutboundDeliveries))[0]?.state === "queued"); }
  finally { await runtime.stop(); await provider.stop(); }
  assert.equal(workerCalls, 0); assert.deepEqual(errors, []);
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "binding_paused_bot_removed");
});

// A bot-removal wait remains authoritative under every other control. Repeated
// polling must neither lock a no-op transaction nor send queued messages.
for (const control of ["master", "paused", "quarantined", "install"] as const) {
  for (const expired of [false, true]) {
    test(`${control} preserves a bot wait ${expired ? "while reclaiming an expired lease" : "without repeated control writes"}`, async () => {
      const surface = await pairControlFixture(1);
      if (control === "master") await deleteFeatureFlagRule(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, surface.masterRule.id);
      if (control === "paused") await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "manager_paused" });
      if (control === "quarantined") await surface.db.update(externalChannelBindings).set({ state: "quarantined", stateReason: "operator_quarantined" });
      if (control === "install") await surface.db.update(externalAppInstalls).set({ state: "reauth_required", stateReason: "provider_tokens_revoked" });
      await surface.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: NOW, authorityBlockedReason: "binding_paused_bot_removed" });
      if (expired) await surface.db.update(externalOutboundDeliveries).set({ state: "dispatching", leaseOwner: "crashed-worker", leaseGeneration: 1,
        leaseOriginState: "queued", leaseExpiresAt: new Date(NOW.getTime() - 1) });
      const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) }),
        now: () => NOW, fetch: (async () => { throw new Error("controlled pair must not use Slack"); }) as typeof fetch });
      let samples = 0, writes = 0, claims = 0; const errors: unknown[] = [];
      const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
        reconciliationKey: "control-test", now: () => NOW, workerIntervalMs: 10, onError: (error) => errors.push(error),
        listPairHeads: async (...args) => { const rows = await listSlackPairHeads(...args); samples++; return rows; },
        recordControlWait: async (input) => { writes++; return recordSlackPairControlWait(input); },
        runWorkerOnce: async () => { claims++; throw new Error("controlled pair must not send"); } });
      runtime.start();
      try { await waitForControlState(async () => samples >= 4 && (!expired || (await surface.db.select().from(externalOutboundDeliveries))[0]?.state === "queued")); }
      finally { await runtime.stop(); await provider.stop(); }
      assert.deepEqual(errors, []);
      assert.equal(writes, expired ? 1 : 0);
      assert.equal(claims, 0);
      assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "binding_paused_bot_removed");
      assert.equal((await surface.db.select().from(externalDeliveryAttempts)).length, 0);
    });
  }
}

test("an active pair does not repeatedly clear a bot-removal wait or send before revalidation", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: NOW, authorityBlockedReason: "binding_paused_bot_removed", authorityRetryAt: null });
  const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) }),
    now: () => NOW, fetch: (async () => { throw new Error("unverified pair must not use Slack"); }) as typeof fetch });
  let samples = 0, clears = 0; const results: string[] = [], errors: unknown[] = [];
  const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
    reconciliationKey: "control-test", now: () => NOW, workerIntervalMs: 10, onError: (error) => errors.push(error),
    listPairHeads: async (...args) => { const rows = await listSlackPairHeads(...args); samples++; return rows; },
    clearControlWait: async (input) => { clears++; return clearResumedSlackPairControlWait(input); },
    runWorkerOnce: async (input) => { const result = await processExternalDeliveryPartitionHead(input); results.push(result.kind === "blocked" ? result.reason : result.kind); return result; } });
  runtime.start();
  try { await waitForControlState(async () => samples >= 4 && results.length >= 3); }
  finally { await runtime.stop(); await provider.stop(); }
  assert.deepEqual(errors, []); assert.equal(clears, 0);
  assert.ok(results.every((result) => result === "slack_audience_revalidation_required"));
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "binding_paused_bot_removed");
  assert.equal((await surface.db.select().from(externalDeliveryAttempts)).length, 0);
});

test("a terminal attempt on an expired paused lease is checked at a bounded rate and never sent", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "manager_paused" });
  await surface.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: NOW, authorityBlockedReason: "binding_paused_bot_removed" });
  await surface.db.update(externalOutboundDeliveries).set({ state: "dispatching", leaseOwner: "crashed-worker", leaseGeneration: 1,
    leaseOriginState: "queued", leaseExpiresAt: new Date(NOW.getTime() - 1), providerAttempts: 1,
    ambiguityBudgetProviderAttempts: 1, firstDispatchedAt: NOW });
  await surface.db.insert(externalDeliveryAttempts).values({ deliveryId: surface.deliveries[0]!.id, attemptNumber: 1, leaseGeneration: 1,
    runtimeRevision: "runtime-r1", credentialRevision: 1, dispatchAuthorization: "automatic", providerIoStartedAt: NOW,
    outcome: "outcome_unknown", outcomeReason: "already_terminal", terminalAt: NOW });
  let clock = NOW, samples = 0, writes = 0, claims = 0; const errors: unknown[] = [];
  const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) }),
    now: () => clock, fetch: (async () => { throw new Error("controlled pair must not use Slack"); }) as typeof fetch });
  const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
    reconciliationKey: "control-test", now: () => clock, workerIntervalMs: 10, onError: (error) => errors.push(error),
    listPairHeads: async (...args) => { const rows = await listSlackPairHeads(...args); samples++; return rows; },
    recordControlWait: async (input) => { writes++; return recordSlackPairControlWait(input); },
    runWorkerOnce: async () => { claims++; throw new Error("controlled pair must not send"); } });
  runtime.start();
  try {
    await waitForControlState(async () => samples >= 4);
    assert.equal(writes, 1, "the inconsistent lease is not locked every tick");
    clock = new Date(NOW.getTime() + 60_001);
    await waitForControlState(async () => writes >= 2);
    assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.state, "dispatching");
    // A distinct lease generation invalidates the cache immediately; never
    // let the exceptional old head suppress reclaiming new work.
    await surface.db.update(externalOutboundDeliveries).set({ leaseGeneration: 2 });
    await waitForControlState(async () => (await surface.db.select().from(externalOutboundDeliveries))[0]!.state === "queued");
  } finally { await runtime.stop(); await provider.stop(); }
  assert.deepEqual(errors, []); assert.equal(claims, 0); assert.equal(writes, 3);
  assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.state, "queued");
  assert.equal((await surface.db.select().from(externalDeliveryAttempts))[0]!.outcome, "outcome_unknown");
});

test("a repaired terminal head immediately records the active control wait", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "manager_paused" });
  await surface.db.update(externalOutboundDeliveries).set({ state: "dispatching", leaseOwner: "crashed-worker", leaseGeneration: 1,
    leaseOriginState: "queued", leaseExpiresAt: new Date(NOW.getTime() - 1), providerAttempts: 1,
    ambiguityBudgetProviderAttempts: 1, firstDispatchedAt: NOW });
  await surface.db.insert(externalDeliveryAttempts).values({ deliveryId: surface.deliveries[0]!.id, attemptNumber: 1, leaseGeneration: 1,
    runtimeRevision: "runtime-r1", credentialRevision: 1, dispatchAuthorization: "automatic", providerIoStartedAt: NOW,
    outcome: "outcome_unknown", outcomeReason: "already_terminal", terminalAt: NOW });
  const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) }),
    now: () => NOW, fetch: (async () => { throw new Error("paused pair must not use Slack"); }) as typeof fetch });
  let samples = 0, writes = 0, claims = 0; const errors: unknown[] = [];
  const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
    reconciliationKey: "control-test", now: () => NOW, workerIntervalMs: 10, onError: (error) => errors.push(error),
    listPairHeads: async (...args) => { const rows = await listSlackPairHeads(...args); samples++; return rows; },
    recordControlWait: async (input) => { writes++; return recordSlackPairControlWait(input); },
    runWorkerOnce: async () => { claims++; throw new Error("paused pair must not send"); } });
  runtime.start();
  try {
    await waitForControlState(async () => samples >= 4);
    assert.equal(writes, 1);
    assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, null);
    // Simulate a repair without advancing the clock or changing the lease generation.
    await surface.db.update(externalOutboundDeliveries).set({ state: "queued", leaseOwner: null, leaseExpiresAt: null, leaseOriginState: null });
    await waitForControlState(async () => (await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason === "binding_paused");
  } finally { await runtime.stop(); await provider.stop(); }
  assert.deepEqual(errors, []); assert.equal(writes, 2); assert.equal(claims, 0);
  assert.equal((await surface.db.select().from(externalDeliveryAttempts))[0]!.outcome, "outcome_unknown");
});

test("a removed bot reclaims an expired started send as unknown before audience recovery", async () => {
  const surface = await pairControlFixture(1);
  let clock = NOW;
  surface.deps.now = () => clock;
  let entered!: () => void; let finish!: () => void;
  const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
  const providerResponse = new Promise<void>((resolve) => { finish = resolve; });
  surface.deps.dispatchProvider = async () => { entered(); await providerResponse;
    return { kind: "accepted", providerMessageId: "late-original" }; };
  const oldWorker = surface.head().then(() => null, (error: unknown) => String(error));
  try {
    await providerEntered;
    await reconcileSlackChannelLifecycle({ db: surface.db, serverId: surface.server.id, registrationId: surface.registration.id,
      installId: surface.install.id, bindingId: surface.binding.id, providerAuthorityId: surface.install.providerAuthorityId,
      providerConversationId: surface.binding.providerConversationId, expectedConnectionEpoch: surface.install.connectionEpoch,
      expectedBindingEpoch: 3, event: { kind: "member_left", userId: surface.install.botUserId! }, now: NOW });
    clock = new Date(NOW.getTime() + 61_000);
    const result = await recordSlackPairControlWait({ db: surface.db, ...surface.scope, currentBindingEpoch: 4,
      reason: "binding_paused_bot_removed", now: clock });
    assert.equal(result.kind, "authority_blocked");
    const [delivery] = await surface.db.select().from(externalOutboundDeliveries);
    const [attempt] = await surface.db.select().from(externalDeliveryAttempts);
    assert.equal(delivery.state, "outcome_unknown"); assert.equal(delivery.leaseOwner, null);
    assert.equal(attempt.outcome, "outcome_unknown"); assert.equal(delivery.providerAttempts, 1);
    assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "binding_paused_bot_removed");
    // If the audience guard is accidentally removed, fail immediately rather
    // than entering the first worker's deliberately unresolved provider call.
    surface.deps.dispatchProvider = async () => { throw new Error("unexpected second provider dispatch before audience proof"); };
    assert.equal((await surface.head()).kind === "blocked", true, "no retry before fresh audience proof");
  } finally {
    finish();
    assert.match((await oldWorker) ?? "", /lost exact lease authority/);
  }
  const provider: SlackBridgeProvisioningProvider = {
    async readInstallGrant() { return { kind: "unverified" }; },
    async readWorkspace() { return { oauth: "unverified", directory: { kind: "unverified" } }; },
    async readConversationState() { return { kind: "fact", fact: { id: surface.binding.providerConversationId,
      name: "verified", isArchived: false, isMember: true } }; },
    async readConversationAudience() { return { kind: "fact", fact: {
      providerMemberIds: [surface.install.botUserId!, surface.projection.externalActorId],
      users: [{ id: surface.projection.externalActorId, displayName: "External Human", handle: null, actorKind: "human" }],
    } }; },
  };
  clock = new Date(NOW.getTime() + 62_000);
  await recoverSlackLifecyclePauses({ db: surface.db, provider, bindingId: surface.binding.id, now: clock });
  const [binding] = await surface.db.select().from(externalChannelBindings);
  assert.equal(binding.state, "active");
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, null);
  const current = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: binding.id,
    expectedBindingEpoch: binding.bindingEpoch, expectedConnectionEpoch: surface.install.connectionEpoch,
    senderType: "user", senderId: surface.owner.id, now: clock, registrationId: surface.registration.id });
  assert.ok(current);
  surface.deps.resolveCurrentRuntime = async () => ({ runtimeRevision: current.runtimeRevision, bindingAuthority: current.neutral });
  surface.deps.leaseCredential = async () => ({ handle: {}, runtimeRevision: current.runtimeRevision, credentialRevision: 1, ...current.neutral });
  let reconciliations = 0;
  surface.deps.prepareProvider = async ({ reconcileUnknownOutcome }) => {
    assert.equal(reconcileUnknownOutcome, true, "a started send must be reconciled before any retry");
    reconciliations++;
    return { ready: true, receipt: { kind: "accepted", providerMessageId: "original-confirmed", reconciled: true },
      async dispatch() { assert.fail("a confirmed receipt must not be sent again"); } };
  };
  surface.deps.dispatchProvider = async () => { assert.fail("no blind retry after an uncertain send"); };
  const confirmed = await surface.head();
  assert.equal(confirmed.kind, "cursor_recovered");
  assert.equal(confirmed.kind === "cursor_recovered" ? confirmed.state : null, "accepted");
  assert.equal(reconciliations, 1);
});
