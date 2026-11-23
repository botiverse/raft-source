import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import {
  agents,
  channels,
  externalProjectionAvatarArtifacts,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstalls,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalDeliveryAttempts,
  externalDeliveryPartitions,
  externalOutboundDeliveries,
  externalHumanIdentityLinks,
  externalInboundEvents,
  jointChannels,
  jointChannelServers,
  messages,
  users,
} from "../db/schema";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService";
import { createSlackBridgeDatabaseOutboundRuntime, resolveCurrentOutboundAuthority } from "./slackBridgeDatabaseOutboundRuntime";
import {
  processExternalDeliveryPartitionHead,
  __setExternalDeliveryAttemptRowLockHookForTests,
  type ActiveExternalDeliveryRuntime,
} from "./externalDeliveryWorkerService";
import { enqueueSlackBridgeOutboundDelivery, type SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService";
import { type SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import { createFeatureFlagRule, deleteFeatureFlagRule } from "./featureFlagService";
import {
  createSlackDatabaseInboundWorkerRuntimeResolver,
  createSlackDatabaseIngressRuntimeResolver,
  slackBridgeDatabaseRuntimeRevision,
} from "./slackBridgeDatabaseRuntimeAuthority";
import { slackBridgeInstallGrantHash } from "./slackBridgeInstallGrantService";
import { refreshSlackConversationAuthority, type SlackBridgeAvatarMaterializer } from "./slackBridgeProvisioningControlPlane";
import { materializeExternalProjectionAvatar } from "./externalAvatarMaterializerService";
import { __setCdnStorageForTests, resetStorageForTests, type StorageBackend } from "./storageService";
import { externalAvatarPublicRouter } from "../routes/externalAvatars";
import { NOW, EXPIRES, legacyRuntimeRevisionV1, fixture, storeWorkerCustody, resolveCurrentOutboundAuthorityOrNull, enqueueAuthorityProbe, leaseTwiceAfter, reviewUseCompleteInstalledScopes } from "./slackBridgeDatabaseRuntimeAuthority.testkit";

afterEach(async () => {
  __setExternalDeliveryAttemptRowLockHookForTests(null);
  resetStorageForTests();
  await closeTestDatabase();
});

test("bound channels authorize current Human and Agent subjects without per-author policy", async () => {
  const surface = await fixture("public");
  const [agent] = await surface.db.insert(agents).values({
    serverId: surface.server.id,
    name: "default-slack-agent",
    displayName: "Default Slack Agent",
    runtime: "codex",
  }).returning();
  const human = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user",
    senderId: surface.owner.id,
    now: NOW,
    registrationId: surface.registration.id,
  });
  const agentAuthority = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "agent",
    senderId: agent.id,
    now: NOW,
    registrationId: surface.registration.id,
  });
  assert.ok(human);
  assert.ok(agentAuthority);

  await surface.db.update(users).set({ displayName: "Renamed Runtime Human" })
    .where(eq(users.id, surface.owner.id));
  await surface.db.update(agents).set({ displayName: "Renamed Default Slack Agent" })
    .where(eq(agents.id, agent.id));
  for (const renamed of [{
    senderType: "user" as const,
    senderId: surface.owner.id,
    authorName: "Renamed Runtime Human",
  }, {
    senderType: "agent" as const,
    senderId: agent.id,
    authorName: "Renamed Default Slack Agent",
  }]) {
    const authority = await resolveCurrentOutboundAuthorityOrNull({
      executor: surface.db,
      bindingId: surface.binding.id,
      expectedConnectionEpoch: surface.binding.connectionEpoch,
      expectedBindingEpoch: surface.binding.bindingEpoch,
      senderType: renamed.senderType,
      senderId: renamed.senderId,
      now: new Date(NOW.getTime() + 1_000),
      registrationId: surface.registration.id,
    });
    assert.ok(authority);
    const enqueued = await surface.db.transaction(async (executor) => {
      const [message] = await executor.insert(messages).values({
        channelId: surface.channel.id,
        senderType: renamed.senderType,
        senderId: renamed.senderId,
        content: `${renamed.senderType} renamed source`,
      }).returning();
      return enqueueSlackBridgeOutboundDelivery({
        executor,
        message,
        activeRuntime: {
          level: "top_level",
          authorityConversationId: surface.channel.id,
          runtimePredicateRevision: authority.runtimeRevision,
          bindingAuthority: authority.neutral,
        },
        canonicalConversationId: surface.channel.id,
        senderType: renamed.senderType,
        senderId: renamed.senderId,
        authorName: renamed.authorName,
        sanitizedText: message.content,
        mintReconciliationMarker: () => (
          renamed.senderType === "user" ? "U".repeat(43) : "A".repeat(43)
        ),
      });
    });
    const snapshot = enqueued.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
    assert.equal(snapshot.authorName, renamed.authorName);
    assert.equal(snapshot.authorPresentation.displayName, renamed.authorName);
  }

  const outsider = randomUUID();
  assert.equal(await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user",
    senderId: outsider,
    now: NOW,
    registrationId: surface.registration.id,
  }), null, "a user outside the current Server is not an outbound subject");
  await surface.db.update(agents).set({ deletedAt: NOW }).where(eq(agents.id, agent.id));
  assert.equal(await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "agent",
    senderId: agent.id,
    now: NOW,
    registrationId: surface.registration.id,
  }), null, "a deleted Agent is not an outbound subject");
});

test("database runtime resolvers bind current control-plane, actor, addressability, and worker authority", async () => {
  const surface = await fixture();
  const ingress = createSlackDatabaseIngressRuntimeResolver(surface.db);
  const runtime = await ingress.resolveCurrentRuntime({
    authority: surface.authority,
    projectionId: surface.projection.id,
    actorProjectionRevision: 4,
    externalActorId: "U_RUNTIME_HUMAN",
    memberRevision: 5,
    contextRevision: 6,
    now: NOW,
  });
  assert.deepEqual(runtime, {
    runtimeRevision: slackBridgeDatabaseRuntimeRevision(surface.authority),
  });
  // Both legacy child flags are seeded without an allow rule. Neither can
  // block admission while the master bridge is enabled.
  for (const capability of ["attachment_transfer", "reaction_sync"] as const) {
    assert.deepEqual(await ingress.resolveCurrentRuntime({
      authority: surface.authority,
      projectionId: surface.projection.id,
      actorProjectionRevision: 4,
      externalActorId: "U_RUNTIME_HUMAN",
      memberRevision: 5,
      contextRevision: 6,
      requiredCapabilities: [capability],
      now: NOW,
    }), runtime);
  }

  const frozen = {
    runtimeRevision: runtime!.runtimeRevision,
    provider: "slack",
    environment: "test" as const,
    appRegistrationId: surface.authority.registrationId,
    installId: surface.authority.installId,
    workspaceId: surface.authority.providerAuthorityId,
    providerAuthorityId: surface.authority.providerAuthorityId,
    providerConversationId: surface.authority.providerConversationId,
    bindingId: surface.authority.bindingId,
    bindingEpoch: surface.authority.bindingEpoch,
    connectionEpoch: surface.authority.connectionEpoch,
    raftChannelId: surface.authority.channelId,
    privacyClass: surface.authority.privacyClass,
  };
  const resolveWorker = createSlackDatabaseInboundWorkerRuntimeResolver(surface.db);
  const admittedEventId = await storeWorkerCustody(surface, frozen);
  assert.deepEqual(await resolveWorker({ eventId: admittedEventId, frozenAuthority: frozen }), frozen);

  const legacyEventId = randomUUID();
  const legacyFrozen = {
    ...frozen,
    runtimeRevision: legacyRuntimeRevisionV1(surface.authority, 1),
  };
  await surface.db.insert(externalInboundEvents).values({
    id: legacyEventId,
    provider: "slack",
    environment: "test",
    appRegistrationId: surface.registration.id,
    installId: surface.install.id,
    workspaceId: surface.authority.providerAuthorityId,
    providerAuthorityId: surface.authority.providerAuthorityId,
    providerConversationId: surface.authority.providerConversationId,
    providerEventId: "Ev_LEGACY_RUNTIME_RENEWAL",
    bindingId: surface.binding.id,
    bindingEpoch: surface.binding.bindingEpoch,
    connectionEpoch: surface.binding.connectionEpoch,
    runtimeRevision: legacyFrozen.runtimeRevision,
    raftChannelId: surface.channel.id,
    privacyClass: surface.authority.privacyClass,
    normalizedPayloadDigest: "e".repeat(64),
    encryptedPayload: "sealed-legacy-runtime-payload",
    envelopeKeyId: "runtime-envelope-1",
    payloadSchemaVersion: 2,
    payloadExpiresAt: EXPIRES,
    receivedAt: new Date(NOW.getTime() + 500),
    updatedAt: new Date(NOW.getTime() + 500),
  });

  await surface.db.insert(externalAppInstallGrantReceipts).values({
    registrationId: surface.registration.id,
    installId: surface.install.id,
    receiptRevision: 2,
    connectionEpoch: surface.install.connectionEpoch,
    scopeRevision: surface.install.scopeRevision,
    credentialRevision: surface.install.credentialRevision,
    providerAppId: surface.install.providerAppId,
    providerAuthorityId: surface.install.providerAuthorityId,
    botUserId: surface.install.botUserId!,
    providerBotId: surface.install.providerBotId!,
    grantedScopes: surface.install.installedScopes,
    grantHash: slackBridgeInstallGrantHash({
      providerAppId: surface.install.providerAppId,
      providerAuthorityId: surface.install.providerAuthorityId,
      botUserId: surface.install.botUserId!,
      providerBotId: surface.install.providerBotId!,
      grantedScopes: surface.install.installedScopes,
    }),
    observationSource: "token_introspection",
    status: "valid",
    observedAt: new Date(NOW.getTime() + 1_000),
    expiresAt: EXPIRES,
  });
  const renewedAuthority = await resolveExternalBindingAuthority({
    serverId: surface.server.id,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    now: new Date(NOW.getTime() + 2_000),
  }, surface.db);
  assert.equal(renewedAuthority.active, true);
  if (!renewedAuthority.active) throw new Error("renewed authority must stay active");
  assert.equal(renewedAuthority.fact.installGrantReceiptRevision, 2);
  assert.equal(
    slackBridgeDatabaseRuntimeRevision(renewedAuthority.fact),
    frozen.runtimeRevision,
    "freshness-only install-grant renewal must not poison queued work",
  );
  assert.deepEqual(
    await resolveWorker({ eventId: admittedEventId, frozenAuthority: frozen }),
    frozen,
    "worker accepts the same grant content after a receipt-only renewal",
  );
  assert.deepEqual(
    await resolveWorker({ eventId: legacyEventId, frozenAuthority: legacyFrozen }),
    legacyFrozen,
    "v2 worker accepts an exact queued v1 event across a receipt-only renewal",
  );
  assert.equal(await resolveWorker({
    eventId: admittedEventId,
    frozenAuthority: { ...frozen, workspaceId: "T_SUBSTITUTED" },
  }), null, "workspace identity is independent frozen authority");

  assert.deepEqual(await resolveWorker({
    eventId: admittedEventId,
    frozenAuthority: frozen,
    requiredCapabilities: ["attachment_transfer"],
  }), frozen, "fresh attachment authority reaches its consumer");
  assert.deepEqual(await resolveWorker({
    eventId: admittedEventId,
    frozenAuthority: frozen,
    requiredCapabilities: ["reaction_sync"],
  }), frozen, "fresh reaction authority reaches its consumer");

  const [bindingBeforePrivacyExpiry] = await surface.db.select()
    .from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, surface.binding.id));
  await surface.db.update(externalChannelBindings).set({ privacyFreshUntil: NOW })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  assert.equal((await resolveExternalBindingAuthority({
    serverId: surface.server.id,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: 2,
    expectedBindingEpoch: 3,
    now: NOW,
  }, surface.db)).active, true,
  "privacy cache expiry no longer revokes authority — visibility is per-platform (task #241)");
  assert.ok(await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: 2,
    expectedBindingEpoch: 3,
    expectedAudienceRevision: 1,
    senderType: "user",
    senderId: surface.owner.id,
    now: NOW,
    registrationId: surface.registration.id,
  }), "expired privacy cache still leases outbound authority");
  assert.ok(await ingress.resolveCurrentRuntime({
    // The receipt renewed mid-test (revision 2): post-renewal ingress must
    // name the current authority, exactly as a real caller would.
    authority: renewedAuthority.fact,
    projectionId: surface.projection.id,
    actorProjectionRevision: 4,
    externalActorId: "U_RUNTIME_HUMAN",
    memberRevision: 5,
    contextRevision: 6,
    now: NOW,
  }), "expired privacy cache still admits inbound authority");
  assert.ok(await ingress.resolveCurrentRuntime({
    authority: renewedAuthority.fact,
    projectionId: surface.projection.id,
    actorProjectionRevision: 4,
    externalActorId: "U_RUNTIME_HUMAN",
    memberRevision: 5,
    contextRevision: 6,
    requiredCapabilities: ["attachment_transfer"],
    now: NOW,
  }), "expired privacy cache still admits attachment ingress");
  assert.ok(await resolveWorker({
    eventId: admittedEventId,
    frozenAuthority: frozen,
    requiredCapabilities: ["reaction_sync"],
  }), "expired privacy cache still admits the reaction worker");
  const [bindingAfterPrivacyExpiry] = await surface.db.select()
    .from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, surface.binding.id));
  assert.deepEqual(bindingAfterPrivacyExpiry, {
    ...bindingBeforePrivacyExpiry,
    privacyFreshUntil: NOW,
  }, "consumer denial changes only the test-owned expiry and performs no recovery write");
});

test("outbound worker keeps the frozen matched audience revision across a newer refresh", async () => {
  const surface = await fixture("private");

  const frozen = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user",
    senderId: surface.owner.id,
    now: NOW,
    registrationId: surface.registration.id,
  });
  assert.ok(frozen);
  await enqueueAuthorityProbe(surface, frozen);
  assert.equal(frozen.neutral.memberRevision, 1);

  await surface.db.update(externalBindingAudienceSnapshots).set({
    expiresAt: new Date(NOW.getTime() + 3_000),
  }).where(eq(externalBindingAudienceSnapshots.bindingId, surface.binding.id));

  await surface.db.insert(externalBindingAudienceSnapshots).values({
    bindingId: surface.binding.id,
    bindingEpoch: surface.binding.bindingEpoch,
    audienceRevision: 2,
    externalMemberCount: 1,
    externalAudienceDigest: "runtime-audience-digest-refresh",
    raftMemberCount: 1,
    raftAudienceDigest: "runtime-audience-digest-refresh",
    status: "matched",
    observedAt: new Date(NOW.getTime() + 1_000),
    expiresAt: EXPIRES,
  });
  await surface.db.update(externalChannelBindings).set({
    audienceRevision: 2,
    audienceFreshUntil: EXPIRES,
  }).where(eq(externalChannelBindings.id, surface.binding.id));

  const refreshedLatest = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user",
    senderId: surface.owner.id,
    now: new Date(NOW.getTime() + 2_000),
    registrationId: surface.registration.id,
  });
  assert.ok(refreshedLatest);
  assert.equal(refreshedLatest.neutral.memberRevision, 2);

  const stillCurrentFrozen = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    expectedAudienceRevision: frozen.neutral.memberRevision,
    senderType: "user",
    senderId: surface.owner.id,
    now: new Date(NOW.getTime() + 2_000),
    registrationId: surface.registration.id,
  });
  assert.ok(stillCurrentFrozen);
  assert.equal(stillCurrentFrozen.runtimeRevision, frozen.runtimeRevision);
  assert.deepEqual(stillCurrentFrozen.neutral, frozen.neutral);

  // Credential/scope rotation no longer feeds the dispatch fingerprint:
  // the outbound runtime revision digests only the dispatch fence (bound
  // destination coordinates + frozen audience revision). A rotated
  // credential surfaces through the credential lease / provider error path,
  // not as an authority mismatch that wedges the FIFO head.
  await surface.db.update(externalAppInstalls).set({
    scopeRevision: 2,
    credentialRevision: 2,
  }).where(eq(externalAppInstalls.id, surface.install.id));
  await surface.db.update(externalAppCredentials).set({
    credentialRevision: 2,
  }).where(eq(externalAppCredentials.installId, surface.install.id));
  await surface.db.update(externalAppInstallGrantReceipts).set({
    scopeRevision: 2,
    credentialRevision: 2,
  }).where(eq(externalAppInstallGrantReceipts.installId, surface.install.id));
  const refreshedRuntime = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    expectedAudienceRevision: frozen.neutral.memberRevision,
    senderType: "user",
    senderId: surface.owner.id,
    now: new Date(NOW.getTime() + 2_000),
    registrationId: surface.registration.id,
  });
  assert.ok(refreshedRuntime);
  assert.equal(refreshedRuntime.runtimeRevision, frozen.runtimeRevision);
  assert.deepEqual(refreshedRuntime.neutral, frozen.neutral);

  let resolveWorker!: (value: unknown) => void;
  const workerResolution = new Promise<unknown>((resolve) => {
    resolveWorker = resolve;
  });
  const provider = {
    transport: {},
    quarantineSink: {},
    credentialResolver: { resolve: async () => null },
    createOutboundAttachmentTransport: async () => null,
    releaseCredential: async () => {},
  } as unknown as SlackBridgeProviderRuntime;
  const runtime = createSlackBridgeDatabaseOutboundRuntime({
    db: surface.db,
    provider,
    reconciliationKey: "runtime-reconciliation-key",
    registrationId: surface.registration.id,
    now: () => new Date(NOW.getTime() + 2_000),
    workerIntervalMs: 60_000,
    async runWorkerOnce(input) {
      assert.ok(input.dependencies);
      const frozenSnapshot: SlackBridgeRenderSnapshot = {
        schema: "slack-bridge-render-snapshot.v4",
        sourceMessageId: randomUUID(),
        sourceMessageSeq: 1,
        canonicalConversationId: surface.channel.id,
        level: "top_level",
        canonicalRootMessageId: null,
        sourcePermalink: "https://app.raft.build/s/test/c/test/m/test",
        senderType: "user",
        senderId: surface.owner.id,
        authorName: "Slack Runtime Owner",
        authorPresentation: {
          displayName: "Slack Runtime Owner",
          fallbackKind: "human",
          avatar: null,
        },
        sanitizedText: "frozen audience refresh regression",
        externalMentions: [],
        raftMentionSubstitutions: [],
        attachments: [],
        bindingAuthority: frozen.neutral,
        enqueueRuntimeRevision: frozen.runtimeRevision,
      };
      resolveWorker(await input.dependencies.resolveCurrentRuntime({
        deliveryId: randomUUID(),
        frozenSnapshot,
      }));
      return { kind: "blocked", reason: "test_complete", deliveryId: randomUUID() };
    },
  });
  runtime.start();
  const resolvedThroughWorker = await Promise.race([
    workerResolution,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("outbound worker did not resolve frozen authority")),
      2_000,
    )),
  ]);
  await runtime.stop();
  assert.deepEqual(resolvedThroughWorker, {
    runtimeRevision: refreshedRuntime.runtimeRevision,
    bindingAuthority: frozen.neutral,
  });

  const stillAlive = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    expectedAudienceRevision: frozen.neutral.memberRevision,
    senderType: "user",
    senderId: surface.owner.id,
    now: new Date(NOW.getTime() + 4_000),
    registrationId: surface.registration.id,
  });
  assert.ok(
    stillAlive,
    "private dispatch now uses the public rule: the newest matched, "
      + "unexpired observation keeps a frozen revision alive — an expired "
      + "frozen snapshot no longer wedges the FIFO head",
  );
  assert.equal(
    stillAlive.neutral.memberRevision,
    frozen.neutral.memberRevision,
    "the delivery still carries its frozen revision",
  );
});

test("public outbound delivery survives a matched audience refresh without substituting a mismatched snapshot", async () => {
  const surface = await fixture("public");

  const frozen = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user",
    senderId: surface.owner.id,
    now: NOW,
    registrationId: surface.registration.id,
  });
  assert.ok(frozen);
  assert.equal(frozen.neutral.memberRevision, 1);

  await surface.db.update(externalBindingAudienceSnapshots).set({
    expiresAt: new Date(NOW.getTime() + 1_000),
  }).where(eq(externalBindingAudienceSnapshots.bindingId, surface.binding.id));
  await surface.db.insert(externalBindingAudienceSnapshots).values({
    bindingId: surface.binding.id,
    bindingEpoch: surface.binding.bindingEpoch,
    audienceRevision: 2,
    externalMemberCount: 1,
    externalAudienceDigest: "public-audience-refresh",
    raftMemberCount: 1,
    raftAudienceDigest: "public-audience-refresh",
    status: "matched",
    observedAt: new Date(NOW.getTime() + 1_000),
    expiresAt: EXPIRES,
  });

  const refreshed = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    expectedAudienceRevision: frozen.neutral.memberRevision,
    senderType: "user",
    senderId: surface.owner.id,
    now: new Date(NOW.getTime() + 2_000),
    registrationId: surface.registration.id,
  });
  assert.ok(refreshed, "a current matched public snapshot should keep the frozen delivery dispatchable");
  assert.deepEqual(refreshed.neutral, frozen.neutral);
  assert.equal(refreshed.runtimeRevision, frozen.runtimeRevision);

  await surface.db.insert(externalBindingAudienceSnapshots).values({
    bindingId: surface.binding.id,
    bindingEpoch: surface.binding.bindingEpoch,
    audienceRevision: 3,
    externalMemberCount: 0,
    externalAudienceDigest: "public-audience-mismatch",
    raftMemberCount: 1,
    raftAudienceDigest: "public-audience-mismatch",
    status: "mismatch",
    observedAt: new Date(NOW.getTime() + 3_000),
    expiresAt: EXPIRES,
  });
  assert.equal(await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    expectedAudienceRevision: frozen.neutral.memberRevision,
    senderType: "user",
    senderId: surface.owner.id,
    now: new Date(NOW.getTime() + 4_000),
    registrationId: surface.registration.id,
  }), null, "a newest mismatched public snapshot must still fail closed");
});

test("public outbound worker sends a frozen 19766 snapshot when live audience revision is null", async () => {
  const surface = await fixture("public");
  const frozen = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    expectedAudienceRevision: 19_766,
    senderType: "user",
    senderId: surface.owner.id,
    now: NOW,
    registrationId: surface.registration.id,
  });
  assert.ok(frozen);
  assert.equal(frozen.neutral.memberRevision, 19_766);
  assert.equal(surface.binding.audienceRevision, null);

  const [message] = await surface.db.insert(messages).values({
    channelId: surface.channel.id,
    senderType: "user",
    senderId: surface.owner.id,
    content: "public mutable authority regression",
  }).returning();
  const enqueued = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({
    executor,
    message,
    activeRuntime: {
      level: "top_level",
      authorityConversationId: surface.channel.id,
      runtimePredicateRevision: frozen.runtimeRevision,
      bindingAuthority: frozen.neutral,
    },
    canonicalConversationId: surface.channel.id,
    senderType: "user",
    senderId: surface.owner.id,
    authorName: surface.owner.name,
    sanitizedText: message.content,
    mintReconciliationMarker: () => "P".repeat(43),
  }));
  const [secondMessage] = await surface.db.insert(messages).values({
    channelId: surface.channel.id,
    senderType: "user",
    senderId: surface.owner.id,
    content: "public mutable authority following row",
  }).returning();
  const secondEnqueued = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({
    executor,
    message: secondMessage,
    activeRuntime: {
      level: "top_level",
      authorityConversationId: surface.channel.id,
      runtimePredicateRevision: frozen.runtimeRevision,
      bindingAuthority: frozen.neutral,
    },
    canonicalConversationId: surface.channel.id,
    senderType: "user",
    senderId: surface.owner.id,
    authorName: surface.owner.name,
    sanitizedText: secondMessage.content,
    mintReconciliationMarker: () => "Q".repeat(43),
  }));

  await surface.db.update(externalAppInstalls).set({
    scopeRevision: 2,
    credentialRevision: 2,
  }).where(eq(externalAppInstalls.id, surface.install.id));
  await surface.db.update(externalAppCredentials).set({
    credentialRevision: 2,
  }).where(eq(externalAppCredentials.installId, surface.install.id));
  await surface.db.update(externalAppInstallGrantReceipts).set({
    scopeRevision: 2,
    credentialRevision: 2,
  }).where(eq(externalAppInstallGrantReceipts.installId, surface.install.id));

  let workerResult!: unknown;
  let providerCalls = 0;
  let resolveWorker!: (value: unknown) => void;
  const workerResolution = new Promise<unknown>((resolve) => {
    resolveWorker = resolve;
  });
  const provider = {
    transport: {},
    quarantineSink: {},
    credentialResolver: { resolve: async () => ({}) },
    createOutboundAttachmentTransport: async () => null,
    releaseCredential: async () => {},
  } as unknown as SlackBridgeProviderRuntime;
  const runtime = createSlackBridgeDatabaseOutboundRuntime({
    db: surface.db,
    provider,
    reconciliationKey: "public-mutable-authority-regression",
    registrationId: surface.registration.id,
    now: () => new Date(NOW.getTime() + 1_000),
    workerIntervalMs: 60_000,
    onError(error) {
      resolveWorker({ error });
    },
    async runWorkerOnce(input) {
      const current = input.dependencies!;
      const workerDependencies = {
        ...current,
        prepareProvider: undefined,
        leaseCredential: async ({ runtime: currentRuntime }: {
          runtime: ActiveExternalDeliveryRuntime;
        }) => ({
          handle: {},
          credentialRevision: 2,
          runtimeRevision: currentRuntime.runtimeRevision,
          provider: currentRuntime.bindingAuthority.provider,
          installId: currentRuntime.bindingAuthority.installId,
          providerAuthorityId: currentRuntime.bindingAuthority.providerAuthorityId,
          providerConversationId: currentRuntime.bindingAuthority.providerConversationId,
          connectionEpoch: currentRuntime.bindingAuthority.connectionEpoch,
          bindingId: currentRuntime.bindingAuthority.bindingId,
          bindingEpoch: currentRuntime.bindingAuthority.bindingEpoch,
        }),
        dispatchProvider: async () => {
          providerCalls += 1;
          return {
            kind: "accepted" as const,
            providerMessageId: `public-mutable-authority-provider-message-${providerCalls}`,
          };
        },
        now: () => new Date(NOW.getTime() + 1_000),
        jitterUnit: () => 0.5,
      };
      const firstResult = await processExternalDeliveryPartitionHead({
        ...input,
        dependencies: workerDependencies,
      });
      const secondResult = await processExternalDeliveryPartitionHead({
        ...input,
        dependencies: workerDependencies,
      });
      workerResult = { firstResult, secondResult };
      resolveWorker(workerResult);
      return secondResult;
    },
  });
  runtime.start();
  const result = await Promise.race([
    workerResolution,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("public mutable authority worker did not resolve")),
      2_000,
    )),
  ]);
  await runtime.stop();

  const results = result as {
    firstResult: { kind?: string };
    secondResult: { kind?: string };
  };
  assert.equal(results.firstResult.kind, "attempted");
  assert.equal(results.secondResult.kind, "attempted");
  assert.equal(providerCalls, 2);
  const [delivery] = await surface.db.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.id, enqueued.delivery.id));
  assert.equal(delivery?.state, "accepted");
  const [attempt] = await surface.db.select().from(externalDeliveryAttempts)
    .where(eq(externalDeliveryAttempts.deliveryId, enqueued.delivery.id));
  assert.equal(attempt?.runtimeRevision, frozen.runtimeRevision);
  const [secondDelivery] = await surface.db.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.id, secondEnqueued.delivery.id));
  assert.equal(secondDelivery?.state, "accepted");
  const [partition] = await surface.db.select().from(externalDeliveryPartitions)
    .where(eq(externalDeliveryPartitions.bindingId, surface.binding.id));
  assert.equal(partition?.cursorPosition, 2);
});

test("database ingress and inbound worker current-runtime checks follow master gate ON to OFF to ON", async () => {
  const surface = await fixture();
  const ingress = createSlackDatabaseIngressRuntimeResolver(surface.db);
  const input = {
    authority: surface.authority,
    projectionId: surface.projection.id,
    actorProjectionRevision: 4,
    externalActorId: "U_RUNTIME_HUMAN",
    memberRevision: 5,
    contextRevision: 6,
    now: NOW,
  };
  const expectedRuntime = {
    runtimeRevision: slackBridgeDatabaseRuntimeRevision(surface.authority),
  };
  assert.deepEqual(await ingress.resolveCurrentRuntime(input), expectedRuntime);

  const frozen = {
    runtimeRevision: expectedRuntime.runtimeRevision,
    provider: "slack",
    environment: "test" as const,
    appRegistrationId: surface.authority.registrationId,
    installId: surface.authority.installId,
    workspaceId: surface.authority.providerAuthorityId,
    providerAuthorityId: surface.authority.providerAuthorityId,
    providerConversationId: surface.authority.providerConversationId,
    bindingId: surface.authority.bindingId,
    bindingEpoch: surface.authority.bindingEpoch,
    connectionEpoch: surface.authority.connectionEpoch,
    raftChannelId: surface.authority.channelId,
    privacyClass: surface.authority.privacyClass,
  };
  const resolveWorker = createSlackDatabaseInboundWorkerRuntimeResolver(surface.db);
  const admittedEventId = await storeWorkerCustody(surface, frozen);
  assert.deepEqual(await resolveWorker({ eventId: admittedEventId, frozenAuthority: frozen }), frozen);

  assert.equal(await deleteFeatureFlagRule(
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    surface.masterRule.id,
  ), true);
  const bindingAuthorityWhileOff = await resolveExternalBindingAuthority({
    serverId: surface.server.id,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: 2,
    expectedBindingEpoch: 3,
    now: NOW,
  }, surface.db);
  assert.equal(bindingAuthorityWhileOff.active, true,
    "the binding remains a positive control when only the master gate changes");
  assert.equal(await ingress.resolveCurrentRuntime(input), null,
    "events ingress closes when the master gate is off");
  assert.equal(await resolveWorker({ eventId: admittedEventId, frozenAuthority: frozen }), null,
    "an already admitted event pauses at the worker current-runtime recheck while the gate is off");

  await createFeatureFlagRule({
    flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    stage: "server",
    decision: "allow",
    values: [surface.server.id],
  });
  assert.deepEqual(await ingress.resolveCurrentRuntime(input), expectedRuntime,
    "events ingress resumes when the same server is allowed again");
  assert.deepEqual(
    await resolveWorker({ eventId: admittedEventId, frozenAuthority: frozen }),
    frozen,
    "an already admitted event becomes eligible again after the gate is restored",
  );
});

test("database ingress authority follows only a reconfirmed public Joint host projection", async () => {
  const surface = await fixture();
  const [canonical] = await surface.db.insert(channels).values({
    serverId: surface.server.id,
    name: `slack-runtime-canonical-${randomUUID()}`,
    type: "channel",
  }).returning();
  const [joint] = await surface.db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: surface.server.id,
    createdByUserId: surface.owner.id,
  }).returning();
  await surface.db.update(channels).set({ type: "joint" })
    .where(eq(channels.id, surface.channel.id));
  await surface.db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: surface.server.id,
    localChannelId: surface.channel.id,
    role: "host",
    joinedByUserId: surface.owner.id,
  });
  await surface.db.update(externalChannelBindings).set({
    providerConversationKind: "public_channel",
    privacyClass: "public",
    audienceRevision: null,
    audienceFreshUntil: null,
  }).where(eq(externalChannelBindings.id, surface.binding.id));

  const hostAuthority = await resolveExternalBindingAuthority({
    serverId: surface.server.id,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: 2,
    expectedBindingEpoch: 3,
    now: NOW,
  }, surface.db);
  assert.equal(hostAuthority.active, true,
    "a public binding retains authority through its active Joint host projection");
  if (!hostAuthority.active) throw new Error("Joint host authority must be active");
  const runtime = await createSlackDatabaseIngressRuntimeResolver(surface.db)
    .resolveCurrentRuntime({
      authority: hostAuthority.fact,
      projectionId: surface.projection.id,
      actorProjectionRevision: 4,
      externalActorId: "U_RUNTIME_HUMAN",
      memberRevision: 5,
      contextRevision: 6,
      now: NOW,
    });
  assert.deepEqual(runtime, {
    runtimeRevision: slackBridgeDatabaseRuntimeRevision(hostAuthority.fact),
  }, "the real ingress runtime accepts the same reconfirmed Joint authority");

  await surface.db.update(jointChannelServers).set({ role: "participant" })
    .where(eq(jointChannelServers.localChannelId, surface.channel.id));
  assert.deepEqual(await resolveExternalBindingAuthority({
    serverId: surface.server.id,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: 2,
    expectedBindingEpoch: 3,
    now: NOW,
  }, surface.db), { active: false, reason: "channel_unavailable" },
  "a participant projection cannot inherit the host Slack endpoint");

  await surface.db.update(jointChannelServers).set({ role: "host" })
    .where(eq(jointChannelServers.localChannelId, surface.channel.id));
  await surface.db.update(externalChannelBindings).set({ channelId: canonical.id })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  assert.deepEqual(await resolveExternalBindingAuthority({
    serverId: surface.server.id,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: 2,
    expectedBindingEpoch: 3,
    now: NOW,
  }, surface.db), { active: false, reason: "channel_unavailable" },
  "canonical storage never grants external binding authority");
});

test("database runtime resolvers degrade on expired addressability and fail closed on revoked binding", async () => {
  const surface = await fixture();
  const ingress = createSlackDatabaseIngressRuntimeResolver(surface.db);
  const input = {
    authority: surface.authority,
    projectionId: surface.projection.id,
    actorProjectionRevision: 4,
    externalActorId: "U_RUNTIME_HUMAN",
    memberRevision: 5,
    contextRevision: 6,
    now: NOW,
  };
  // Directory TTL expiry degrades to the last observation — it does not
  // block ingress. Only a concrete state change (removed/revoked) gates.
  const expiredAt = new Date(NOW.getTime() + 1);
  await surface.db.update(externalAddressabilityProjections).set({ expiresAt: expiredAt })
    .where(eq(externalAddressabilityProjections.projectionId, surface.projection.id));
  assert.ok(await ingress.resolveCurrentRuntime({
    ...input,
    now: new Date(expiredAt.getTime() + 1),
  }));

  const frozen = {
    runtimeRevision: slackBridgeDatabaseRuntimeRevision(surface.authority),
    provider: "slack",
    environment: "test" as const,
    appRegistrationId: surface.authority.registrationId,
    installId: surface.authority.installId,
    workspaceId: surface.authority.providerAuthorityId,
    providerAuthorityId: surface.authority.providerAuthorityId,
    providerConversationId: surface.authority.providerConversationId,
    bindingId: surface.authority.bindingId,
    bindingEpoch: surface.authority.bindingEpoch,
    connectionEpoch: surface.authority.connectionEpoch,
    raftChannelId: surface.authority.channelId,
    privacyClass: surface.authority.privacyClass,
  };
  await surface.db.update(externalChannelBindings).set({
    state: "revoked",
    stateReason: "test revocation",
  })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  assert.equal(await createSlackDatabaseInboundWorkerRuntimeResolver(surface.db)({
    eventId: "event-revoked",
    frozenAuthority: frozen,
  }), null);
});

test("public authority refresh carries null avatar removal through materialization to 404 and ignores unknown", async () => {
  const surface = await fixture("public");
  const objects = new Map<string, Buffer>();
  const storage: StorageBackend = {
    async put(key, bytes) { objects.set(key, Buffer.from(bytes)); },
    async get(key) {
      const bytes = objects.get(key);
      assert.ok(bytes, "active artifact must have stored bytes");
      return Readable.from(bytes);
    },
    async delete(key) { objects.delete(key); },
  };
  const image = await sharp({ create: {
    width: 64, height: 64, channels: 3, background: { r: 20, g: 80, b: 40 },
  } }).png().toBuffer();
  let avatarLocator: string | null | undefined = "https://avatars.slack-edge.com/carrier.png";
  const calls: Parameters<SlackBridgeAvatarMaterializer["materializeExternalProjection"]>[0][] = [];
  let observedAt = new Date(NOW.getTime() + 1_000);
  const refresh = () => refreshSlackConversationAuthority({
    db: surface.db, bindingId: surface.binding.id, now: observedAt,
    provider: {
      async readInstallGrant() { throw new Error("unexpected install probe"); },
      async readWorkspace() { throw new Error("unexpected workspace probe"); },
      async readConversationAudience(input) {
        assert.equal(input.providerConversationId, "C_RUNTIME_TEST");
        return { kind: "fact", fact: {
          providerMemberIds: ["U_RUNTIME_BOT", "U_RUNTIME_HUMAN"],
          users: [{ id: "U_RUNTIME_HUMAN", displayName: "Runtime Human", handle: "runtime-human",
            actorKind: "human", ...(avatarLocator !== undefined ? { avatarLocator } : {}) }],
        } };
      },
    },
    avatarMaterializer: {
      async materializeExternalProjection(input) {
        calls.push(input);
        return materializeExternalProjectionAvatar({
          ...input, db: surface.db, storage, publicOrigin: "https://api.raft.test", now: () => observedAt,
          source: { provider: "slack", async readSource() { return image; } },
        });
      },
    },
  });
  assert.equal((await refresh()).audienceStatus, "matched");
  assert.equal(calls.length, 1);
  const [artifact] = await surface.db.select().from(externalProjectionAvatarArtifacts);
  assert.ok(artifact?.storageKey);
  assert.equal(artifact.state, "active");
  __setCdnStorageForTests(storage);
  const app = express();
  app.use("/api/external-avatars", externalAvatarPublicRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/api/external-avatars/${artifact.id}.webp`;
    assert.equal((await fetch(url)).status, 200);
    avatarLocator = undefined;
    observedAt = new Date(NOW.getTime() + 2_000);
    assert.equal((await refresh()).audienceStatus, "matched");
    assert.equal(calls.length, 1, "unknown profile must not invoke the materializer");
    assert.equal((await fetch(url)).status, 200, "unknown profile preserves the last good image");
    avatarLocator = null;
    observedAt = new Date(NOW.getTime() + 3_000);
    assert.equal((await refresh()).audienceStatus, "matched");
    const [projection] = await surface.db.select().from(externalActorProjections)
      .where(eq(externalActorProjections.id, surface.projection.id));
    assert.equal(projection.avatarArtifactId, null, "refresh must propagate explicit removal to the projection");
    assert.equal(calls.length, 2, "explicit removal must cross the production handoff exactly once");
    assert.equal(calls[1]!.sourceLocator, null);
    assert.equal(calls[1]!.expectedObservedAt?.getTime(), observedAt.getTime());
    assert.equal((await surface.db.select().from(externalProjectionAvatarArtifacts))[0]!.state, "revoked");
    assert.equal(objects.has(artifact.storageKey), false);
    assert.equal((await fetch(url)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

// Visibility flips no longer gate: each platform keeps its own visibility,
// so a binding stays authoritative when either side changes class and queued
// work keeps flowing (yezizp, task #241).
for (const privacyClass of ["public", "private"] as const) {
  test(`a running ${privacyClass} binding keeps authority after its Raft channel flips visibility`, async () => {
    const surface = await fixture(privacyClass);
    const input = {
      serverId: surface.server.id,
      bindingId: surface.binding.id,
      expectedConnectionEpoch: surface.authority.connectionEpoch,
      expectedBindingEpoch: surface.authority.bindingEpoch,
      now: NOW,
    };
    assert.equal((await resolveExternalBindingAuthority(input, surface.db)).active, true,
      "a matching binding is active before the change");

    await surface.db.update(channels)
      .set({ type: privacyClass === "public" ? "private" : "channel" })
      .where(eq(channels.id, surface.channel.id));
    assert.equal((await resolveExternalBindingAuthority(input, surface.db)).active, true,
      "a visibility flip no longer revokes authority");
  });
}

test("a running public binding whose Raft channel turns private keeps leasing credentials", async () => {
  const surface = await fixture("public");
  const result = await leaseTwiceAfter(surface, async () => {
    await surface.db.update(channels).set({ type: "private" }).where(eq(channels.id, surface.channel.id));
    assert.equal((await resolveExternalBindingAuthority({
      serverId: surface.server.id,
      bindingId: surface.binding.id,
      expectedConnectionEpoch: 2,
      expectedBindingEpoch: 3,
      now: NOW,
    }, surface.db)).active, true);
  });
  assert.equal(result.credentialResolves, 2, "both sends reach the credential lease after the flip");
  assert.deepEqual(result.errors, []);
  assert.equal(result.binding.state, "active");
  assert.equal(result.binding.bindingEpoch, 3);
});

test("a running private binding whose Raft channel turns public keeps leasing credentials", async () => {
  const surface = await fixture("private");
  const result = await leaseTwiceAfter(surface, async () => {
    await surface.db.update(channels).set({ type: "channel" }).where(eq(channels.id, surface.channel.id));
  });
  assert.equal(result.credentialResolves, 2);
  assert.equal(result.binding.state, "active");
  assert.equal(result.binding.stateReason, null);
  assert.equal(result.binding.bindingEpoch, 3);
});

test("an archived Raft channel continues previously authorized outbound work without admitting new authority", async () => {
  const surface = await fixture("public");
  const result = await leaseTwiceAfter(surface, async () => {
    await surface.db.update(channels).set({ archivedAt: NOW }).where(eq(channels.id, surface.channel.id));
    const request = { serverId: surface.server.id, bindingId: surface.binding.id,
      expectedConnectionEpoch: 2, expectedBindingEpoch: 3, now: NOW };
    assert.deepEqual(await resolveExternalBindingAuthority(request, surface.db), { active: false, reason: "channel_unavailable" });
    assert.equal((await resolveExternalBindingAuthority({ ...request, allowArchivedForQueuedDelivery: true }, surface.db)).active, true);
  });
  assert.equal(result.credentialResolves, 2, "queued messages retain current installation and credential checks");
});

test("a deleted Raft channel still blocks sends as channel_unavailable", async () => {
  const surface = await fixture("public");
  const result = await leaseTwiceAfter(surface, async () => {
    await surface.db.update(channels).set({ type: "private", deletedAt: NOW })
      .where(eq(channels.id, surface.channel.id));
    assert.deepEqual(await resolveExternalBindingAuthority({
      serverId: surface.server.id,
      bindingId: surface.binding.id,
      expectedConnectionEpoch: 2,
      expectedBindingEpoch: 3,
      now: NOW,
    }, surface.db), { active: false, reason: "channel_unavailable" });
  });
  assert.equal(result.credentialResolves, 0, "a deleted channel never reaches credential leasing");
  assert.equal(result.binding.state, "active");
  assert.equal(result.binding.stateReason, null);
  assert.equal(result.binding.bindingEpoch, 3);
});

// Independent review controls for PR11004; synthetic DB only.
for (const privacyClass of ["public", "private"] as const) {
  test(`review11004 old v2 queued event survives deployment (${privacyClass})`, async () => {
    const s = await fixture(privacyClass);
    await reviewUseCompleteInstalledScopes(s);
    await s.db.delete(externalHumanIdentityLinks);
    const a = s.authority;
    // Exact pre-PR v2 hash serialization, including the trailing audienceRevision.
    const oldRevision = createHash("sha256").update(JSON.stringify({
      schema: "slack-bridge-database-runtime-authority.v2",
      authority: {
        provider: a.provider, environment: a.environment, registrationId: a.registrationId,
        serverId: a.serverId, serverGrantId: a.serverGrantId, grantEpoch: a.grantEpoch,
        installId: a.installId, providerAppId: a.providerAppId, connectionEpoch: a.connectionEpoch,
        scopeRevision: a.scopeRevision, credentialRevision: a.credentialRevision,
        bindingId: a.bindingId, bindingEpoch: a.bindingEpoch, privacyClass: a.privacyClass,
        channelId: a.channelId, providerAuthorityId: a.providerAuthorityId,
        providerConversationId: a.providerConversationId,
        audienceRevision: privacyClass === "private" ? s.binding.audienceRevision : null,
      },
    }), "utf8").digest("hex");
    const frozen = {
      runtimeRevision: oldRevision, provider: "slack", environment: "test" as const,
      appRegistrationId: a.registrationId, installId: a.installId, workspaceId: a.providerAuthorityId,
      providerAuthorityId: a.providerAuthorityId, providerConversationId: a.providerConversationId,
      bindingId: a.bindingId, bindingEpoch: a.bindingEpoch, connectionEpoch: a.connectionEpoch,
      raftChannelId: a.channelId, privacyClass: a.privacyClass,
    };
    const eventId = randomUUID();
    await s.db.insert(externalInboundEvents).values({
      id: eventId, provider: "slack", environment: "test", appRegistrationId: s.registration.id,
      installId: s.install.id, workspaceId: a.providerAuthorityId, providerAuthorityId: a.providerAuthorityId,
      providerConversationId: a.providerConversationId, providerEventId: "Ev_OLD_V2",
      bindingId: s.binding.id, bindingEpoch: s.binding.bindingEpoch, connectionEpoch: s.binding.connectionEpoch,
      runtimeRevision: oldRevision, raftChannelId: s.channel.id, privacyClass,
      normalizedPayloadDigest: "e".repeat(64), encryptedPayload: "synthetic-old-v2",
      envelopeKeyId: "test-only", payloadSchemaVersion: 2, payloadExpiresAt: EXPIRES,
      receivedAt: new Date(NOW.getTime() + 500), updatedAt: NOW,
    });
    const resolve = createSlackDatabaseInboundWorkerRuntimeResolver(s.db, () => NOW);
    assert.equal(await resolve({ eventId, frozenAuthority: { ...frozen, runtimeRevision: slackBridgeDatabaseRuntimeRevision(a) } }), null, "substituting a different hash cannot match original custody");
    assert.deepEqual(await resolve({ eventId, frozenAuthority: frozen }), frozen, "the already-queued pre-deploy v2 event must remain eligible");
  });

  test(`review11004 profile read failure preserves plain inbound messages (${privacyClass})`, async () => {
    const s = await fixture(privacyClass);
    await reviewUseCompleteInstalledScopes(s);
    await s.db.delete(externalHumanIdentityLinks);
    const ingress = createSlackDatabaseIngressRuntimeResolver(s.db);
    const input = {
      authority: s.authority, projectionId: s.projection.id, actorProjectionRevision: 4,
      externalActorId: "U_RUNTIME_HUMAN", memberRevision: 5, contextRevision: 6, now: NOW,
    };
    assert.ok(await ingress.resolveCurrentRuntime(input), "zero-link positive control before refresh");
    let providerCalls = 0;
    const receipt = await refreshSlackConversationAuthority({
      db: s.db, bindingId: s.binding.id, now: new Date(NOW.getTime() + 1000),
      provider: {
        async readInstallGrant() { throw new Error("unexpected probe"); },
        async readWorkspace() { throw new Error("unexpected probe"); },
        async readConversationAudience() { providerCalls += 1; return { kind: "fact", fact: {
          providerMemberIds: ["U_RUNTIME_BOT", "U_RUNTIME_HUMAN"],
          users: [], // membership is known; profile lookup is temporarily unavailable
        } }; },
      },
    });
    assert.equal(providerCalls, 1, "must actually exercise the unified provider producer");
    assert.equal(receipt.audienceStatus, "unavailable");
    const [address] = await s.db.select().from(externalAddressabilityProjections)
      .where(eq(externalAddressabilityProjections.projectionId, s.projection.id));
    const current = await resolveExternalBindingAuthority({ serverId: s.server.id, bindingId: s.binding.id,
      expectedConnectionEpoch: 2, expectedBindingEpoch: 3, now: new Date(NOW.getTime() + 1000) }, s.db);
    assert.ok(current.active, "binding, install and visibility still authorized");
    if (!current.active) throw new Error("positive control failed");
    const result = await ingress.resolveCurrentRuntime({ ...input, authority: current.fact,
      memberRevision: address.memberRevision, contextRevision: address.contextRevision,
      now: new Date(NOW.getTime() + 1000) });
    console.log("review11004 profile failure", privacyClass, { addressState: address.state, ingressAccepted: result !== null });
    assert.ok(result, "profile lookup failure must not disable plain message ingress");
  });

  test(`review11004 directory outage does not stop outbound after observation TTL (${privacyClass})`, async () => {
    const s = await fixture(privacyClass);
    await reviewUseCompleteInstalledScopes(s);
    await s.db.delete(externalHumanIdentityLinks);
    const input = { executor: s.db, bindingId: s.binding.id, expectedConnectionEpoch: 2, expectedBindingEpoch: 3,
      senderType: "user" as const, senderId: s.owner.id, registrationId: s.registration.id };
    assert.ok((await resolveCurrentOutboundAuthority({ ...input, now: NOW })).current);
    await s.db.update(externalBindingAudienceSnapshots).set({ expiresAt: new Date(NOW.getTime() + 30 * 60_000) })
      .where(eq(externalBindingAudienceSnapshots.bindingId, s.binding.id));
    await s.db.insert(externalBindingAudienceSnapshots).values({
      bindingId: s.binding.id, bindingEpoch: 3, audienceRevision: 2,
      externalMemberCount: 0, externalAudienceDigest: "directory-unavailable", raftMemberCount: 0,
      raftAudienceDigest: "directory-unavailable", status: "unavailable", observedAt: NOW, expiresAt: EXPIRES,
    });
    assert.ok((await resolveCurrentOutboundAuthority({ ...input, now: new Date(NOW.getTime() + 29 * 60_000) })).current, "last good observation still works before its TTL");
    const result = await resolveCurrentOutboundAuthority({ ...input, expectedAudienceRevision: 1, now: new Date(NOW.getTime() + 31 * 60_000) });
    console.log("review11004 directory TTL", privacyClass, result.current ? "accepted" : result.reason);
    assert.ok(result.current, "directory-only expiry must not stop an otherwise authorized frozen message");
  });
}

for (const privacyClass of ["public", "private"] as const) {
  test(`review11004 directory outage does not stop inbound after address TTL (${privacyClass})`, async () => {
    const s = await fixture(privacyClass);
    await reviewUseCompleteInstalledScopes(s);
    await s.db.delete(externalHumanIdentityLinks);
    const ingress = createSlackDatabaseIngressRuntimeResolver(s.db);
    const input = { authority: s.authority, projectionId: s.projection.id, actorProjectionRevision: 4,
      externalActorId: "U_RUNTIME_HUMAN", memberRevision: 5, contextRevision: 6, now: NOW };
    assert.ok(await ingress.resolveCurrentRuntime(input));
    await s.db.update(externalAddressabilityProjections).set({ expiresAt: new Date(NOW.getTime() + 30 * 60_000) })
      .where(eq(externalAddressabilityProjections.projectionId, s.projection.id));
    const receipt = await refreshSlackConversationAuthority({ db: s.db, bindingId: s.binding.id,
      now: new Date(NOW.getTime() + 29 * 60_000), provider: {
        async readInstallGrant() { throw new Error("unexpected probe"); },
        async readWorkspace() { throw new Error("unexpected probe"); },
        async readConversationAudience() { return { kind: "fact", fact: {
          providerMemberIds: ["U_RUNTIME_BOT", "U_RUNTIME_HUMAN"], users: [],
        } }; },
      } });
    assert.equal(receipt.audienceStatus, "unavailable");
    const [address] = await s.db.select().from(externalAddressabilityProjections)
      .where(eq(externalAddressabilityProjections.projectionId, s.projection.id));
    const freshInput = { ...input, memberRevision: address.memberRevision, contextRevision: address.contextRevision };
    assert.ok(await ingress.resolveCurrentRuntime({ ...freshInput, now: new Date(NOW.getTime() + 29 * 60_000) }), "last good sender address is usable before directory TTL");
    assert.ok(await ingress.resolveCurrentRuntime({ ...freshInput, now: new Date(NOW.getTime() + 31 * 60_000) }), "directory-only expiry must not block plain message ingress");
  });
}

for (const privacyClass of ["private"] as const) {
  test(`review11004 historical v2 survives 17 refreshes (${privacyClass})`, async () => {
    const s = await fixture(privacyClass);
    await reviewUseCompleteInstalledScopes(s);
    await s.db.delete(externalHumanIdentityLinks);
    const a = s.authority;
    // Exact pre-PR v2 hash serialization, including the trailing audienceRevision.
    const oldRevision = createHash("sha256").update(JSON.stringify({
      schema: "slack-bridge-database-runtime-authority.v2",
      authority: {
        provider: a.provider, environment: a.environment, registrationId: a.registrationId,
        serverId: a.serverId, serverGrantId: a.serverGrantId, grantEpoch: a.grantEpoch,
        installId: a.installId, providerAppId: a.providerAppId, connectionEpoch: a.connectionEpoch,
        scopeRevision: a.scopeRevision, credentialRevision: a.credentialRevision,
        bindingId: a.bindingId, bindingEpoch: a.bindingEpoch, privacyClass: a.privacyClass,
        channelId: a.channelId, providerAuthorityId: a.providerAuthorityId,
        providerConversationId: a.providerConversationId,
        audienceRevision: privacyClass === "private" ? s.binding.audienceRevision : null,
      },
    }), "utf8").digest("hex");
    const frozen = {
      runtimeRevision: oldRevision, provider: "slack", environment: "test" as const,
      appRegistrationId: a.registrationId, installId: a.installId, workspaceId: a.providerAuthorityId,
      providerAuthorityId: a.providerAuthorityId, providerConversationId: a.providerConversationId,
      bindingId: a.bindingId, bindingEpoch: a.bindingEpoch, connectionEpoch: a.connectionEpoch,
      raftChannelId: a.channelId, privacyClass: a.privacyClass,
    };
    const eventId = randomUUID();
    await s.db.insert(externalInboundEvents).values({
      id: eventId, provider: "slack", environment: "test", appRegistrationId: s.registration.id,
      installId: s.install.id, workspaceId: a.providerAuthorityId, providerAuthorityId: a.providerAuthorityId,
      providerConversationId: a.providerConversationId, providerEventId: "Ev_OLD_V2",
      bindingId: s.binding.id, bindingEpoch: s.binding.bindingEpoch, connectionEpoch: s.binding.connectionEpoch,
      runtimeRevision: oldRevision, raftChannelId: s.channel.id, privacyClass,
      normalizedPayloadDigest: "e".repeat(64), encryptedPayload: "synthetic-old-v2",
      envelopeKeyId: "test-only", payloadSchemaVersion: 2, payloadExpiresAt: EXPIRES,
      receivedAt: new Date(NOW.getTime() + 500), updatedAt: NOW,
    });
    const resolve = createSlackDatabaseInboundWorkerRuntimeResolver(s.db, () => NOW);
    assert.equal(await resolve({ eventId, frozenAuthority: { ...frozen, runtimeRevision: slackBridgeDatabaseRuntimeRevision(a) } }), null, "substituting a different hash cannot match original custody");
    assert.deepEqual(await resolve({ eventId, frozenAuthority: frozen }), frozen, "the already-queued pre-deploy v2 event must remain eligible");
    await s.db.insert(externalBindingAudienceSnapshots).values(Array.from({ length: 17 }, (_, index) => ({
      bindingId: s.binding.id, bindingEpoch: s.binding.bindingEpoch, audienceRevision: index + 2,
      externalMemberCount: 1, externalAudienceDigest: "unchanged-members", raftMemberCount: 1,
      raftAudienceDigest: "unchanged-members", status: "matched" as const,
      observedAt: new Date(NOW.getTime() + (index + 1) * 1000), expiresAt: EXPIRES,
    })));
    await s.db.update(externalChannelBindings).set({ audienceRevision: 18 })
      .where(eq(externalChannelBindings.id, s.binding.id));
    const afterRefreshes = createSlackDatabaseInboundWorkerRuntimeResolver(s.db, () => new Date(NOW.getTime() + 20_000));
    assert.equal(await afterRefreshes({ eventId, frozenAuthority: { ...frozen, runtimeRevision: slackBridgeDatabaseRuntimeRevision(a) } }), null, "a different runtime hash is still not the original custody");
    assert.deepEqual(await afterRefreshes({ eventId, frozenAuthority: frozen }), frozen,
      "ordinary refresh history must not age out an otherwise valid queued event");

  });

}

for (const privacyClass of ["public", "private"] as const) {
  test(`review11004 old v1 uses historical private audience (${privacyClass})`, async () => {
    const s = await fixture(privacyClass);
    await reviewUseCompleteInstalledScopes(s);
    await s.db.delete(externalHumanIdentityLinks);
    const a = s.authority;
    // Exact pre-PR v2 hash serialization, including the trailing audienceRevision.
    const oldRevision = legacyRuntimeRevisionV1({ ...a, audienceRevision:
      privacyClass === "private" ? s.binding.audienceRevision : null }, 1);
    const frozen = {
      runtimeRevision: oldRevision, provider: "slack", environment: "test" as const,
      appRegistrationId: a.registrationId, installId: a.installId, workspaceId: a.providerAuthorityId,
      providerAuthorityId: a.providerAuthorityId, providerConversationId: a.providerConversationId,
      bindingId: a.bindingId, bindingEpoch: a.bindingEpoch, connectionEpoch: a.connectionEpoch,
      raftChannelId: a.channelId, privacyClass: a.privacyClass,
    };
    const eventId = randomUUID();
    await s.db.insert(externalInboundEvents).values({
      id: eventId, provider: "slack", environment: "test", appRegistrationId: s.registration.id,
      installId: s.install.id, workspaceId: a.providerAuthorityId, providerAuthorityId: a.providerAuthorityId,
      providerConversationId: a.providerConversationId, providerEventId: "Ev_OLD_V2",
      bindingId: s.binding.id, bindingEpoch: s.binding.bindingEpoch, connectionEpoch: s.binding.connectionEpoch,
      runtimeRevision: oldRevision, raftChannelId: s.channel.id, privacyClass,
      normalizedPayloadDigest: "e".repeat(64), encryptedPayload: "synthetic-old-v2",
      envelopeKeyId: "test-only", payloadSchemaVersion: 2, payloadExpiresAt: EXPIRES,
      receivedAt: new Date(NOW.getTime() + 500), updatedAt: NOW,
    });
    const resolve = createSlackDatabaseInboundWorkerRuntimeResolver(s.db, () => NOW);
    assert.equal(await resolve({ eventId, frozenAuthority: { ...frozen, runtimeRevision: slackBridgeDatabaseRuntimeRevision(a) } }), null, "substituting a different hash cannot match original custody");
    assert.deepEqual(await resolve({ eventId, frozenAuthority: frozen }), frozen, "the already-queued pre-deploy v2 event must remain eligible");
  });

}

for (const privacyClass of ["public", "private"] as const) {
  for (const revoked of [false, true]) {
    test(`review11004 visibility cache expiry is not authority revoked=${revoked} (${privacyClass})`, async () => {
      const s = await fixture(privacyClass);
      await reviewUseCompleteInstalledScopes(s);
      await s.db.delete(externalHumanIdentityLinks);
      const current = () => resolveExternalBindingAuthority({ serverId: s.server.id, bindingId: s.binding.id,
        expectedConnectionEpoch: s.binding.connectionEpoch, expectedBindingEpoch: s.binding.bindingEpoch, now: NOW }, s.db);
      const outbound = () => resolveCurrentOutboundAuthority({ executor: s.db, bindingId: s.binding.id,
        expectedConnectionEpoch: s.binding.connectionEpoch, expectedBindingEpoch: s.binding.bindingEpoch,
        senderType: "user", senderId: s.owner.id, registrationId: s.registration.id, now: NOW });
      assert.equal((await current()).active, true);
      assert.equal((await outbound()).current, true);
      await s.db.update(externalChannelBindings).set({ privacyFreshUntil: NOW,
        ...(revoked ? { state: "revoked" as const, stateReason: "review_explicit_revoke" } : {})
      }).where(eq(externalChannelBindings.id, s.binding.id));
      const read = await current();
      const send = await outbound();
      console.log("privacy metadata expiry", privacyClass, revoked, read, send.current ? "current" : send.reason);
      assert.deepEqual({ inboundAuthority: read.active, outboundAuthority: send.current },
        { inboundAuthority: !revoked, outboundAuthority: !revoked },
        "visibility metadata expiry must not stop delivery, but actual revocation still must");
    });
  }
}
