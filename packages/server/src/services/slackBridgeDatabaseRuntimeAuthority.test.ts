import { parseSlackAttachmentFallbackDeployment } from "./slackAttachmentFallbackDeployment";
import { reconcileSlackChannelLifecycle } from "./slackBindingLifecycleService";
import { recoverSlackLifecyclePauses } from "./slackChannelLifecycleRecovery";
import type { SlackBridgeProvisioningProvider } from "./slackBridgeProvisioningControlPlane";
import { slackLifecycleClockAt } from "./slackChannelLifecycleObservation";
import { loadSlackChannelDeletionEvidence } from "./slackChannelDeletionEvidence";
import { recordVerifiedSlackChannelDeletion } from "./slackBindingLifecycleService";
import { parseSlackReconciliationScan } from "./slackReconciliationScan";
import { reserveSlackUsergroupIdentity } from "./slackUsergroupIdentityStore";
import { listSlackPairHeads, listSlackOutboundQueueBindings } from "./slackBridgePairQueue";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import express from "express";
import sharp from "sharp";
import { and, desc, eq, sql } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import {
  agents,
  attachmentObjects,
  attachments,
  channels,
  channelAgents,
  inboxNotificationFacts,
  channelHumans,
  externalProjectionAvatarArtifacts,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstallServerGrants,
  externalAppInstalls,
  externalAppManifestReceipts,
  externalAppRegistrations,
  externalAttachmentTransferJobs,
  externalAppRegistrationSecrets,
  externalAppServerGrants,
  externalBindingAudienceSnapshots,
  externalChannelBindings, slackChannelDeletions,
  externalDeliveryAttempts, externalDeliveryOperatorDecisions,
  externalDeliveryPartitions,
  externalOutboundDeliveries,
  slackAttachmentFallbackPlans, slackAttachmentPlanRollout,
  externalHumanIdentityLinks,
  externalInboundEvents,
  slackVerifiedIngressEvents,
  externalMessageLinks,
  externalMentionFacts,
  featureFlags,
  jointChannels,
  jointChannelServers,
  messages,
  messageMentions,
  slackUsergroupIdentities,
  oauthClientInstalls,
  oauthClients,
  serverMembers,
  users,
} from "../db/schema";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService";
import {
  createSlackBridgeDatabaseOutboundRuntime, SLACK_DELETED_QUEUE_CLEANUP_BATCH_SIZE,
  resolveCurrentOutboundAuthority,
} from "./slackBridgeDatabaseOutboundRuntime";
import {
  processExternalDeliveryPartitionHead, consumeExternalDeliverySkipDecision,
  cleanupDeletedSlackPairHead, recordSlackPairControlWait, clearResumedSlackPairControlWait, clearEmptySlackPairWaits,
  type ExternalDeliveryWorkerDependencies,
  __setExternalDeliveryAttemptRowLockHookForTests,
  type ActiveExternalDeliveryRuntime,
} from "./externalDeliveryWorkerService";
import {
  enqueueSlackBridgeOutboundDelivery, maybeEnqueueOrdinaryMessageExternalDelivery,
  digestSlackBridgeRenderSnapshot,
  mintSlackBridgeReconciliationMarker,
  type SlackBridgeRenderSnapshot,
} from "./externalDeliveryOutboxService";
import { createSlackBridgeProviderRuntime, type SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import { createSlackBridgeEnvCredentialCipher } from "./slackBridgeEnvSecrets";
import { createFeatureFlagRule, deleteFeatureFlagRule } from "./featureFlagService";
import { createServer } from "./serverService";
import { attachExternalBridgeMetadata } from "./channelService";
import { broadcastAndDeliver } from "./messageService";
import { withChannelDelivery } from "../test/orchestratorStub";
import {
  createSlackDatabaseInboundWorkerRuntimeResolver,
  createSlackDatabaseIngressRuntimeResolver,
  slackBridgeDatabaseRuntimeRevision,
} from "./slackBridgeDatabaseRuntimeAuthority";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "./slackBridgeProductionAppContract";
import { slackBridgeInstallGrantHash } from "./slackBridgeInstallGrantService";

import { refreshSlackConversationAuthority, type SlackBridgeAvatarMaterializer } from "./slackBridgeProvisioningControlPlane";
import { materializeExternalProjectionAvatar } from "./externalAvatarMaterializerService";
import { __setCdnStorageForTests, __setStorageForTests, resetStorageForTests, type StorageBackend } from "./storageService";
import { externalAvatarPublicRouter } from "../routes/externalAvatars";
import { prepareSlackAttachmentFallbackPlan, validateSlackAttachmentFallbackPlan } from "./slackAttachmentFallbackPlan";

const NOW = new Date("2026-08-11T08:00:00.000Z");
const EXPIRES = new Date("2027-08-11T08:00:00.000Z");

function legacyRuntimeRevisionV1(
  authority: Parameters<typeof slackBridgeDatabaseRuntimeRevision>[0],
  installGrantReceiptRevision: number,
): string {
  return createHash("sha256").update(JSON.stringify({
    schema: "slack-bridge-database-runtime-authority.v1",
    authority: {
      provider: authority.provider,
      environment: authority.environment,
      registrationId: authority.registrationId,
      serverId: authority.serverId,
      serverGrantId: authority.serverGrantId,
      grantEpoch: authority.grantEpoch,
      installId: authority.installId,
      providerAppId: authority.providerAppId,
      connectionEpoch: authority.connectionEpoch,
      scopeRevision: authority.scopeRevision,
      credentialRevision: authority.credentialRevision,
      bindingId: authority.bindingId,
      bindingEpoch: authority.bindingEpoch,
      privacyClass: authority.privacyClass,
      channelId: authority.channelId,
      providerAuthorityId: authority.providerAuthorityId,
      providerConversationId: authority.providerConversationId,
      installGrantReceiptRevision,
      audienceRevision: authority.audienceRevision,
    },
  }), "utf8").digest("hex");
}

afterEach(async () => {
  __setExternalDeliveryAttemptRowLockHookForTests(null);
  resetStorageForTests();
  await closeTestDatabase();
});

async function fixture(privacyClass: "public" | "private" = "private") {
  const realPgUrl = process.env.CARDY_W3_REAL_PG_URL;
  if (realPgUrl) {
    const pool = new pg.Pool({ connectionString: realPgUrl, max: 2 });
    try { await migrateRealPgTestDatabase(pool, fileURLToPath(new URL("../../drizzle", import.meta.url))); }
    finally { await pool.end(); }
  }
  await openTestDatabase(realPgUrl ?? "pglite://");
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `slack-runtime-${randomUUID()}@test.invalid`,
    name: `slack-runtime-${randomUUID()}`,
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const server = await createServer("Slack Runtime", `slack-runtime-${randomUUID()}`, owner.id);
  const masterRule = await createFeatureFlagRule({
    flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    stage: "server",
    decision: "allow",
    values: [server.id],
  });
  await db.insert(featureFlags).values({
    key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
    description: "Slack attachment transfer",
    enabled: true,
    defaultEnabled: false,
    killSwitch: false,
    randomizationUnit: "server",
    salt: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
  });
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `slack-runtime-${randomUUID()}`,
    type: privacyClass === "public" ? "channel" : "private",
  }).returning();
  const [client] = await db.insert(oauthClients).values({
    serverId: server.id,
    clientId: `slack-runtime-${randomUUID()}`,
    clientSecretHash: "test-only",
    appType: "slock_builtin",
    name: "Slack Bridge",
    allowedScopes: ["messages:read", "messages:write"],
    createdByUserId: owner.id,
  }).returning();
  await db.insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
  });
  const [registration] = await db.insert(externalAppRegistrations).values({
    oauthClientId: client.id,
    provider: "slack",
    environment: "test",
    providerAppId: "A_RUNTIME_TEST",
    providerOAuthClientId: "runtime-client",
    capabilityManifestVersion: 1,
    capabilityManifestHash: "runtime-manifest-v1",
    requiredCapabilities: ["external_projection", "channel_events"],
  }).returning();
  await db.insert(externalAppRegistrationSecrets).values([{
    registrationId: registration.id,
    purpose: "signing_secret",
    encryptedSecretRef: "local-ref:signing:v1",
    envelopeKeyId: "runtime-envelope-1",
    secretRevision: 1,
    aadVersion: 1,
  }, {
    registrationId: registration.id,
    purpose: "manifest_manager",
    encryptedSecretRef: "local-ref:manifest:v1",
    envelopeKeyId: "runtime-envelope-1",
    secretRevision: 1,
    aadVersion: 1,
  }]);
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "runtime-manifest-v1",
    grantedCapabilities: ["external_projection", "channel_events"],
    grantedByType: "human",
    grantedById: owner.id,
  }).returning();
  const scopes = privacyClass === "public"
    ? [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES]
    : ["channels:history", "channels:read", "chat:write"];
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: 1,
    state: "active",
    connectionEpoch: 2,
    scopeRevision: 1,
    credentialRevision: 1,
    installedScopes: scopes,
    providerAppId: "A_RUNTIME_TEST",
    providerTeamId: "T_RUNTIME_TEST",
    authorityType: "team",
    providerAuthorityId: "T_RUNTIME_TEST",
    botUserId: "U_RUNTIME_BOT",
    providerBotId: "B_RUNTIME_BOT",
    lastVerifiedAt: NOW,
  }).returning();
  await db.insert(externalAppInstallServerGrants).values({
    installId: install.id,
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: grant.grantEpoch,
    state: "active",
    authorizedByType: "human",
    authorizedById: owner.id,
  });
  await db.insert(externalAppCredentials).values({
    installId: install.id,
    state: "active",
    encryptedMaterial: "sealed-runtime-bot-token",
    envelopeKeyId: "runtime-envelope-1",
    aadVersion: 1,
    credentialRevision: 1,
  });
  await db.insert(externalAppManifestReceipts).values({
    registrationId: registration.id,
    receiptRevision: 1,
    managerCredentialRevision: 1,
    providerAppId: "A_RUNTIME_TEST",
    normalizedManifestHash: "runtime-manifest-v1",
    normalizedScopes: scopes,
    normalizedEvents: ["message.channels"],
    normalizedSettings: {},
    status: "valid",
    observedAt: NOW,
    expiresAt: EXPIRES,
  });
  await db.insert(externalAppInstallGrantReceipts).values({
    registrationId: registration.id,
    installId: install.id,
    receiptRevision: 1,
    connectionEpoch: install.connectionEpoch,
    scopeRevision: install.scopeRevision,
    credentialRevision: install.credentialRevision,
    providerAppId: install.providerAppId,
    providerAuthorityId: install.providerAuthorityId,
    botUserId: install.botUserId!,
    providerBotId: install.providerBotId!,
    grantedScopes: scopes,
    grantHash: slackBridgeInstallGrantHash({
      providerAppId: install.providerAppId,
      providerAuthorityId: install.providerAuthorityId,
      botUserId: install.botUserId!,
      providerBotId: install.providerBotId!,
      grantedScopes: scopes,
    }),
    observationSource: "token_introspection",
    status: "valid",
    observedAt: NOW,
    expiresAt: EXPIRES,
  });
  const [binding] = await db.insert(externalChannelBindings).values({
    serverId: server.id,
    registrationId: registration.id,
    installId: install.id,
    channelId: channel.id,
    providerConversationId: "C_RUNTIME_TEST",
    providerConversationKind: privacyClass === "public" ? "public_channel" : "private_channel",
    privacyClass,
    state: "active",
    grantEpoch: 1,
    connectionEpoch: 2,
    bindingEpoch: 3,
    audienceRevision: privacyClass === "private" ? 1 : null,
    audienceFreshUntil: privacyClass === "private" ? EXPIRES : null,
    consentedByType: "human",
    consentedById: owner.id,
    consentedAt: NOW,
  }).returning();
  await db.insert(externalBindingAudienceSnapshots).values({
    bindingId: binding.id,
    bindingEpoch: 3,
    audienceRevision: 1,
    externalMemberCount: 1,
    externalAudienceDigest: "runtime-audience-digest",
    raftMemberCount: 1,
    raftAudienceDigest: "runtime-audience-digest",
    status: "matched",
    observedAt: NOW,
    expiresAt: EXPIRES,
  });
  const [projection] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: registration.id,
    installId: install.id,
    workspaceId: "T_RUNTIME_TEST",
    externalActorId: "U_RUNTIME_HUMAN",
    displayName: "Runtime Human",
    handles: ["runtime-human"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 4,
    observedAt: NOW,
  }).returning();
  await db.insert(externalHumanIdentityLinks).values({
    serverId: server.id,
    installId: install.id,
    userId: owner.id,
    provider: "slack",
    providerAuthorityId: "T_RUNTIME_TEST",
    providerUserId: "U_RUNTIME_HUMAN",
    state: "active",
    linkEpoch: 1,
    observedConnectionEpoch: 1,
  });
  await db.insert(externalAddressabilityProjections).values({
    projectionId: projection.id,
    provider: "slack",
    appRegistrationId: registration.id,
    installId: install.id,
    workspaceId: "T_RUNTIME_TEST",
    connectionEpoch: 2,
    bindingId: binding.id,
    bindingEpoch: 3,
    conversationId: "C_RUNTIME_TEST",
    memberRevision: 5,
    contextRevision: 6,
    state: "active",
    observedAt: NOW,
    expiresAt: EXPIRES,
  });
  const authority = await resolveExternalBindingAuthority({
    serverId: server.id,
    bindingId: binding.id,
    expectedConnectionEpoch: 2,
    expectedBindingEpoch: 3,
    now: NOW,
  }, db);
  assert.equal(authority.active, true);
  if (!authority.active) throw new Error("fixture authority must be active");
  return {
    db,
    owner,
    server,
    channel,
    registration,
    install,
    binding,
    projection,
    masterRule,
    authority: authority.fact,
  };
}


async function reauthorizeSamePair(surface: Awaited<ReturnType<typeof fixture>>) {
  const { id: _id, createdAt: _created, updatedAt: _updated, ...old } = surface.binding;
  await surface.db.update(externalChannelBindings).set({ state: "revoked", stateReason: "test_rebind" }).where(eq(externalChannelBindings.id, surface.binding.id));
  await surface.db.update(externalAppInstalls).set({ connectionEpoch: 3 }).where(eq(externalAppInstalls.id, surface.install.id));
  const [receipt] = await surface.db.select().from(externalAppInstallGrantReceipts).where(eq(externalAppInstallGrantReceipts.installId, surface.install.id));
  await surface.db.insert(externalAppInstallGrantReceipts).values({ ...receipt!, id: randomUUID(), receiptRevision: 2, connectionEpoch: 3 });
  const [binding] = await surface.db.insert(externalChannelBindings).values({ ...old, bindingEpoch: 1, connectionEpoch: 3 }).returning();
  const [audience] = await surface.db.select().from(externalBindingAudienceSnapshots).where(eq(externalBindingAudienceSnapshots.bindingId, surface.binding.id));
  await surface.db.insert(externalBindingAudienceSnapshots).values({ ...audience!, id: randomUUID(), bindingId: binding.id, bindingEpoch: 1 });
  const [address] = await surface.db.select().from(externalAddressabilityProjections).where(eq(externalAddressabilityProjections.bindingId, surface.binding.id));
  await surface.db.insert(externalAddressabilityProjections).values({ ...address!, id: randomUUID(), bindingId: binding.id, bindingEpoch: 1, connectionEpoch: 3 });
  return binding;
}

async function storeWorkerCustody(surface: Awaited<ReturnType<typeof fixture>>, frozen: Parameters<ReturnType<typeof createSlackDatabaseInboundWorkerRuntimeResolver>>[0]["frozenAuthority"]) {
  const id = randomUUID();
  await surface.db.insert(externalInboundEvents).values({
    ...frozen, id, provider: "slack", providerEventId: `Ev_${id}`,
    normalizedPayloadDigest: "e".repeat(64), encryptedPayload: "synthetic-sealed-custody",
    envelopeKeyId: "test-only", payloadSchemaVersion: 2, payloadExpiresAt: EXPIRES,
    receivedAt: NOW, updatedAt: NOW,
  });
  return id;
}

async function resolveCurrentOutboundAuthorityOrNull(input: Parameters<typeof resolveCurrentOutboundAuthority>[0]) {
  const decision = await resolveCurrentOutboundAuthority(input);
  return decision.current ? decision.authority : null;
}

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

/**
 * Two sends through the real outbound worker's credential lease after
 * `mutate` changed the bound Raft channel. Admission froze the runtime
 * before the change, as it does for a message queued just before it.
 */
async function enqueueAuthorityProbe(surface: Awaited<ReturnType<typeof fixture>>,
  frozen: NonNullable<Awaited<ReturnType<typeof resolveCurrentOutboundAuthorityOrNull>>>) {
  const [message] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
    senderType: "user", senderId: surface.owner.id, content: "admitted authority probe" }).returning();
  await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message,
    activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
      runtimePredicateRevision: frozen.runtimeRevision, bindingAuthority: frozen.neutral },
    canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
    authorName: surface.owner.name, sanitizedText: message.content,
    mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("authority-probe", deliveryId) }));
}

async function leaseTwiceAfter(
  surface: Awaited<ReturnType<typeof fixture>>,
  mutate: () => Promise<void>,
) {
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
  await mutate();
  const errors: unknown[] = [];
  let credentialResolves = 0;
  let resolveWorker!: (value: unknown[]) => void;
  const done = new Promise<unknown[]>((resolve) => {
    resolveWorker = resolve;
  });
  const provider = {
    transport: {},
    quarantineSink: {},
    credentialResolver: { resolve: async () => { credentialResolves += 1; return null; } },
    createOutboundAttachmentTransport: async () => null,
    releaseCredential: async () => {},
  } as unknown as SlackBridgeProviderRuntime;
  const runtime = createSlackBridgeDatabaseOutboundRuntime({
    db: surface.db,
    provider,
    reconciliationKey: "raft-privacy-pause-regression",
    registrationId: surface.registration.id,
    now: () => new Date(NOW.getTime() + 1_000),
    workerIntervalMs: 60_000,
    onError: (error) => {
      errors.push(error);
    },
    async runWorkerOnce(input) {
      const active: ActiveExternalDeliveryRuntime = {
        runtimeRevision: frozen.runtimeRevision,
        bindingAuthority: frozen.neutral,
      };
      const leases = [
        await input.dependencies!.leaseCredential({ deliveryId: randomUUID(), runtime: active }),
        await input.dependencies!.leaseCredential({ deliveryId: randomUUID(), runtime: active }),
      ];
      resolveWorker(leases);
      return { kind: "blocked", reason: "test_complete" };
    },
  });
  runtime.start();
  const leases = await Promise.race([
    done,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("outbound worker did not lease")),
      2_000,
    )),
  ]);
  await runtime.stop();
  const [binding] = await surface.db.select().from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, surface.binding.id));
  return { leases, errors, credentialResolves, binding: binding! };
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

async function reviewUseCompleteInstalledScopes(s: Awaited<ReturnType<typeof fixture>>) {
  // Original private test fixture has only three scopes; production uses the full installed set.
  const scopes = [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES];
  await s.db.update(externalAppInstalls).set({ installedScopes: scopes }).where(eq(externalAppInstalls.id, s.install.id));
  await s.db.update(externalAppInstallGrantReceipts).set({ grantedScopes: scopes,
    grantHash: slackBridgeInstallGrantHash({ providerAppId: s.install.providerAppId,
      providerAuthorityId: s.install.providerAuthorityId, botUserId: s.install.botUserId!,
      providerBotId: s.install.providerBotId!, grantedScopes: scopes })
  }).where(eq(externalAppInstallGrantReceipts.installId, s.install.id));
  await s.db.update(externalAppManifestReceipts).set({ normalizedScopes: scopes }).where(eq(externalAppManifestReceipts.registrationId, s.registration.id));
}

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

test("ordinary message send enqueues a hashless attachment when retired child flag is off", async () => {
  const surface = await fixture("public");
  const [object] = await surface.db.insert(attachmentObjects).values({
    originServerId: surface.server.id, uploaderId: surface.owner.id, uploaderType: "user",
    storageKey: `${surface.server.id}/direct-upload.png`, contentHash: null,
    mimeType: "image/png", sizeBytes: 4,
  }).returning();
  const [file] = await surface.db.insert(attachments).values({
    objectId: object.id, messageId: null, pendingChannelId: surface.channel.id,
    channelId: surface.channel.id, uploaderId: surface.owner.id, uploaderType: "user", filename: "direct.png",
  }).returning();
  const provider = {
    transport: {}, credentialResolver: {}, quarantineSink: {}, async releaseCredential() {},
  } as unknown as SlackBridgeProviderRuntime;
  const runtime = createSlackBridgeDatabaseOutboundRuntime({
    db: surface.db, provider, reconciliationKey: "ordinary-hashless-test",
    registrationId: surface.registration.id, workerIntervalMs: 60_000, now: () => NOW,
    async runWorkerOnce() { return { kind: "empty" }; },
  });
  const io = { to() { return { emit() {} }; }, in() { return { in() { return { socketsJoin() {} }; }, socketsJoin() {} }; } } as never;
  const orchestrator = withChannelDelivery({ deliverMessage: async () => undefined }) as never;
  runtime.start();
  try {
    const sent = await broadcastAndDeliver(io, orchestrator, {
      channelId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
      senderName: surface.owner.name, content: "direct-upload caption", attachmentIds: [file.id],
    });
    const [delivery] = await surface.db.select().from(externalOutboundDeliveries)
      .where(eq(externalOutboundDeliveries.sourceMessageId, sent.id));
    assert.ok(delivery, "the real message send must create durable external work");
    const snapshot = delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
    assert.equal(snapshot.sanitizedText, "direct-upload caption");
    assert.equal(snapshot.attachments[0]?.sourceAttachmentId, file.id);
    assert.equal(snapshot.attachments[0]?.contentDigest, null);
  } finally { await runtime.stop(); }
});

test("attachment fallback plan records exact immutable revisions only before a fenced first send", async () => {
  const surface = await fixture("public");
  const [message] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
    senderType: "user", senderId: surface.owner.id, content: "two files", messageType: "chat", createdAt: NOW }).returning();
  for (const position of [0, 1]) {
    const [object] = await surface.db.insert(attachmentObjects).values({ originServerId: surface.server.id,
      uploaderId: surface.owner.id, uploaderType: "user", storageKey: `${surface.server.id}/plan-${position}`,
      contentHash: "a".repeat(64), mimeType: "text/plain", sizeBytes: 4 }).returning();
    await surface.db.insert(attachments).values({ objectId: object.id, messageId: message.id,
      messagePosition: position, channelId: surface.channel.id, uploaderId: surface.owner.id,
      uploaderType: "user", filename: `plan-${position}.txt` });
  }
  const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch, expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user", senderId: surface.owner.id, now: NOW, registrationId: surface.registration.id });
  assert.ok(active);
  const queued = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message,
    activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
      runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral },
    canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
    authorName: surface.owner.name, sanitizedText: message.content,
    mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("plan-test", deliveryId) }));
  const snapshot = queued.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  let missing = new Set([snapshot.attachments[0]!.storageKey]);
  let unavailable = false;
  const storage: StorageBackend = { async put() {}, async delete() {}, async get() { throw new Error("not used"); },
    async probeObjectPresence(key) { if (unavailable) throw new Error("storage offline"); return missing.has(key) ? "missing" : "present"; } };
  const request = { db: surface.db, deliveryId: queued.delivery.id, bindingId: queued.delivery.bindingId,
    bindingEpoch: queued.delivery.bindingEpoch, snapshot, storage,
    now: () => NOW, assertWriterFleetFenced: async () => true };
  assert.equal((await prepareSlackAttachmentFallbackPlan({ ...request, assertWriterFleetFenced: async () => false })).kind,
    "lease_or_fence_unavailable");
  unavailable = true;
  assert.equal((await prepareSlackAttachmentFallbackPlan(request)).kind, "source_unavailable");
  unavailable = false;
  await surface.db.update(externalOutboundDeliveries).set({ state: "dispatching", leaseOwner: "old-worker", leaseGeneration: 1,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000), leaseOriginState: "queued" })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal((await prepareSlackAttachmentFallbackPlan(request)).kind, "lease_or_fence_unavailable",
    "never create a plan while an old worker holds a live lease");
  await surface.db.update(externalOutboundDeliveries).set({ leaseExpiresAt: new Date(NOW.getTime() - 1) })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal((await prepareSlackAttachmentFallbackPlan(request)).kind, "lease_or_fence_unavailable",
    "an expired lease still needs the normal reclaim transition before planning");
  await surface.db.update(externalOutboundDeliveries).set({ state: "queued", leaseOwner: null,
    leaseExpiresAt: null, leaseOriginState: null }).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan(request), { kind: "planned", revision: 1 });
  const [fencedDelivery] = await surface.db.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal(fencedDelivery.leaseGeneration, 2, "plan publication fences the prior lease generation");
  const rejectedByFence = (error: unknown) => error instanceof Error && error.cause instanceof Error
    && error.cause.message.includes("Slack attachment plan requires a compatible writer");
  // Model the actual old binary's SQL, which does not set the new writer marker.
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ state: "dispatching",
    leaseOwner: "legacy-worker", leaseGeneration: 3, leaseExpiresAt: new Date(NOW.getTime() + 60_000), leaseOriginState: "queued" })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id)), rejectedByFence);
  await surface.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ state: "dispatching", leaseOwner: "new-worker",
      leaseExpiresAt: new Date(NOW.getTime() - 1), leaseOriginState: "queued" })
      .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  });
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ leaseOwner: "legacy-worker", leaseGeneration: 4,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000) }).where(eq(externalOutboundDeliveries.id, queued.delivery.id)), rejectedByFence,
    "an old binary cannot reclaim a planned head after a crash");
  await surface.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ state: "queued", leaseOwner: null, leaseExpiresAt: null, leaseOriginState: null })
      .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  });
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ stateReason: "legacy-write" })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id)), rejectedByFence);
  await surface.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ stateReason: "new-writer" })
      .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  });
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ stateReason: "legacy-after-commit" })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id)), rejectedByFence,
  "transaction-local marker must not leak into the next operation");
  await assert.rejects(surface.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ stateReason: "rolled-back" })
      .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
    throw new Error("intentional rollback");
  }), /intentional rollback/);
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ stateReason: "legacy-after-rollback" })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id)), rejectedByFence);
  const staleUpdate = await surface.db.update(externalOutboundDeliveries).set({ stateReason: "stale" })
    .where(sql`${externalOutboundDeliveries.id} = ${queued.delivery.id} AND ${externalOutboundDeliveries.state} = 'dispatching'
      AND ${externalOutboundDeliveries.leaseGeneration} = 1`).returning();
  assert.equal(staleUpdate.length, 0, "a stale generation cannot update the planned head");
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan(request), { kind: "planned", revision: 1 },
    "retrying an unchanged decision must not create unbounded duplicate revisions");
  let plans = await surface.db.select().from(slackAttachmentFallbackPlans);
  assert.equal(plans[0]?.transport, "files");
  assert.deepEqual(plans[0]?.items.map((item) => [item.sourceAttachmentId, item.decision, item.evidence]), [
    [snapshot.attachments[0]!.sourceAttachmentId, "omit", "storage_object_missing"],
    [snapshot.attachments[1]!.sourceAttachmentId, "include", null],
  ]);
  const jobs = await surface.db.select().from(externalAttachmentTransferJobs)
    .where(eq(externalAttachmentTransferJobs.outboundDeliveryId, queued.delivery.id));
  const read = { deliveryId: queued.delivery.id, revision: 1,
    renderSnapshotDigest: queued.delivery.renderSnapshotDigest!, snapshot, plan: plans[0], jobs };
  assert.deepEqual(validateSlackAttachmentFallbackPlan(read), { transport: "files", items: plans[0]!.items });
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, plan: undefined }), null, "missing pointer target fails closed");
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, revision: 2 }), null, "a different revision cannot be substituted");
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, snapshot: { ...snapshot, sanitizedText: "altered" } }), null);
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, plan: { ...plans[0]!, transport: "text" } }), null);
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, plan: { ...plans[0]!, unavailableMarker: "changed marker" } }), null);
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, jobs: jobs.slice(0, 1) }), null);
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, plan: { ...plans[0]!, items: [
    { ...plans[0]!.items[0]!, evidence: null }, plans[0]!.items[1]!,
  ] } }), null, "omission without positive evidence cannot be used");
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, plan: { ...plans[0]!, items: [
    plans[0]!.items[0]!, { ...plans[0]!.items[1]!, transferJobId: plans[0]!.items[0]!.transferJobId },
  ] } }), null, "duplicated job cannot substitute another file");
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, jobs: jobs.map((job) => ({ ...job, outboundDeliveryId: randomUUID() })) }), null);
  missing = new Set();
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan(request), { kind: "no_fallback" });
  const [restoredDelivery] = await surface.db.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal(restoredDelivery.attachmentFallbackPlanRevision, null, "a restored source is not omitted before any send");
  missing = new Set(snapshot.attachments.map((attachment) => attachment.storageKey));
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan(request), { kind: "planned", revision: 2 });
  plans = await surface.db.select().from(slackAttachmentFallbackPlans).orderBy(slackAttachmentFallbackPlans.revision);
  assert.equal(plans[0]?.transport, "files"); assert.equal(plans[1]?.transport, "text");
  const [plannedDelivery] = await surface.db.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal(plannedDelivery.attachmentFallbackPlanRevision, 2);
  assert.equal(plannedDelivery.renderSnapshotDigest, digestSlackBridgeRenderSnapshot(snapshot));
  assert.ok(!JSON.stringify(plans).includes(snapshot.attachments[0]!.storageKey), "plans do not retain storage keys");
  missing = new Set();
  await surface.db.update(attachmentObjects).set({ lifecycleState: "deleted", gcToken: randomUUID(), gcStartedAt: NOW })
    .where(eq(attachmentObjects.id, snapshot.attachments[0]!.objectId));
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan(request), { kind: "planned", revision: 3 });
  const [deletedPlan] = await surface.db.select().from(slackAttachmentFallbackPlans)
    .where(eq(slackAttachmentFallbackPlans.revision, 3));
  assert.equal(deletedPlan.items[0]?.evidence, "object_deleted");
  await surface.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ providerAttempts: 1, firstDispatchedAt: NOW })
      .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  });
  assert.equal((await prepareSlackAttachmentFallbackPlan(request)).kind, "lease_or_fence_unavailable",
    "a prior possible send may only use its original plan and reconciliation");
  assert.deepEqual(validateSlackAttachmentFallbackPlan({ ...read, revision: 3, plan: deletedPlan }),
    { transport: "files", items: deletedPlan.items },
    "a prior attempt uses the frozen plan without depending on current source availability");
  assert.equal((await surface.db.select().from(slackAttachmentFallbackPlans)).length, 3);
});

test.each([
  { hashless: false, slowHash: false, stallHash: false, rebind: true },
  { hashless: false, slowHash: false, stallHash: false, rebind: false },
  { hashless: true, slowHash: false, stallHash: false },
  { hashless: true, slowHash: true, stallHash: false },
  { hashless: true, slowHash: false, stallHash: true },
])("a file-share with retired child flag off recovers FIFO ($hashless, slow=$slowHash, stall=$stallHash, rebind=$rebind)", async ({ hashless, slowHash, stallHash, rebind }) => {
  const surface = await fixture("public");
  let observedNow = new Date();
  const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 29) });
  const sealed = await cipher.sealer.seal({
    serverId: surface.server.id, accessToken: "synthetic-bot-token", tokenType: "bot",
    providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!,
    botUserId: surface.install.botUserId!, now: observedNow,
  });
  await surface.db.update(externalAppCredentials).set({
    encryptedMaterial: sealed.encryptedMaterial, envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion,
  }).where(eq(externalAppCredentials.installId, surface.install.id));
  const [other] = await surface.db.insert(users).values({
    email: `file-following-${randomUUID()}@test.invalid`, name: `file-following-${randomUUID()}`, passwordHash: "test-only",
  }).returning();
  await surface.db.insert(serverMembers).values({ serverId: surface.server.id, userId: other.id, role: "member" });
  const [imageMessage, nextMessage, otherMessage] = await surface.db.insert(messages).values([
    { channelId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
      content: "caption <!channel> & <unsafe> @wake with image", messageType: "chat", createdAt: observedNow },
    { channelId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
      content: "after image", messageType: "chat", createdAt: observedNow },
    { channelId: surface.channel.id, senderType: "user", senderId: other.id,
      content: "other sender after image", messageType: "chat", createdAt: observedNow },
  ]).returning();
  const body = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#2a6fdb" } }).png().toBuffer();
  const [object] = await surface.db.insert(attachmentObjects).values({
    originServerId: surface.server.id, uploaderId: surface.owner.id, uploaderType: "user",
    storageKey: `${surface.server.id}/file-correlation.png`,
    contentHash: hashless ? null : createHash("sha256").update(body).digest("hex"), mimeType: "image/png", sizeBytes: body.length,
  }).returning();
  const [fileAttachment] = await surface.db.insert(attachments).values({
    objectId: object.id, messageId: imageMessage!.id, messagePosition: 0, channelId: surface.channel.id,
    uploaderId: surface.owner.id, uploaderType: "user", filename: "file-correlation.png",
  }).returning();
  const attachmentsForTestId = fileAttachment!.id;
  let sourceReads = 0;
  let releaseRead: (() => void) | undefined;
  let readStarted!: () => void;
  const readStartedPromise = new Promise<void>((resolve) => { readStarted = resolve; });
  __setStorageForTests({
    async put() {}, async delete() {},
    async get(key, signal) {
      assert.equal(key, object.storageKey);
      sourceReads += 1;
      if (slowHash && sourceReads === 1) {
        return Readable.from((async function* () {
          const start = observedNow.getTime();
          observedNow = new Date(start + 4 * 60_000);
          yield body.subarray(0, Math.floor(body.length / 2));
          const deadline = Date.now() + 3_000;
          let renewed = false;
          while (Date.now() < deadline) {
            const [job] = await surface.db.select().from(externalAttachmentTransferJobs)
              .where(eq(externalAttachmentTransferJobs.sourceAttachmentId, attachmentsForTestId));
            if (job?.leaseExpiresAt && job.leaseExpiresAt.getTime() > start + 5 * 60_000) { renewed = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (!renewed) throw new Error("source lease was not renewed during progress");
          observedNow = new Date(start + 6 * 60_000);
          yield body.subarray(Math.floor(body.length / 2));
        })());
      }
      if (stallHash && sourceReads === 1) {
        readStarted();
        await new Promise<void>((resolve, reject) => {
          releaseRead = resolve;
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return Readable.from(body);
    },
  });
  const active = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db, bindingId: surface.binding.id, expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch, senderType: "user", senderId: surface.owner.id,
    now: observedNow, registrationId: surface.registration.id,
  });
  assert.ok(active);
  const queued: Awaited<ReturnType<typeof enqueueSlackBridgeOutboundDelivery>>[] = [];
  for (const message of [imageMessage!, nextMessage!, otherMessage!]) {
    queued.push(await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({
      executor, message, activeRuntime: {
        level: "top_level", authorityConversationId: surface.channel.id,
        runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral,
      }, canonicalConversationId: surface.channel.id,
      senderType: "user", senderId: message.senderId,
      authorName: message.senderId === surface.owner.id ? surface.owner.name : other.name, sanitizedText: message.content,
      mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("file-correlation-regression", deliveryId),
    })));
  }
  // Exercise the real file completion path with a frozen, authorized Raft mention.
  const fileSnapshot = queued[0]!.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  await surface.db.insert(messageMentions).values({ messageId: imageMessage!.id, messageSeq: imageMessage!.seq,
    serverId: surface.server.id, channelId: surface.channel.id, targetType: "user", targetId: surface.owner.id,
    handleAtSendTime: "wake" });
  fileSnapshot.raftMentionSubstitutions = [{
    kind: "user", handle: "wake", token: "<@U_RUNTIME_HUMAN>",
    installId: surface.install.id, bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch,
  }];
  await surface.db.update(externalOutboundDeliveries).set({
    renderSnapshot: fileSnapshot as unknown as Record<string, unknown>, renderSnapshotDigest: digestSlackBridgeRenderSnapshot(fileSnapshot),
  }).where(eq(externalOutboundDeliveries.id, queued[0]!.delivery.id));
  observedNow = new Date();
  const counts = { ticket: 0, upload: 0, complete: 0, correlate: 0, post: 0 };
  const provider = createSlackBridgeProviderRuntime({
    db: surface.db, credentialCipher: cipher, now: () => observedNow,
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "files.slack.com") {
        counts.upload += 1;
        assert.deepEqual(Buffer.from(await new Response(init?.body).arrayBuffer()), body);
        return new Response("OK", { status: 200 });
      }
      const method = url.pathname.split("/").at(-1);
      let response;
      if (method === "files.getUploadURLExternal") {
        counts.ticket += 1;
        response = { ok: true, file_id: "F_CORRELATE", upload_url: "https://files.slack.com/upload/F_CORRELATE" };
      } else if (method === "files.completeUploadExternal") {
        counts.complete += 1;
        const completion = JSON.parse(String(init?.body)) as { initial_comment: string };
        assert.equal(completion.initial_comment, "caption &lt;!channel&gt; &amp; &lt;unsafe&gt; <@U_RUNTIME_HUMAN> with image");
        response = { ok: true, files: [{ id: "F_CORRELATE" }] };
      } else if (method === "conversations.history") {
        counts.correlate += 1;
        assert.equal(url.searchParams.has("include_all_metadata"), false,
          "file shares must use file-ID correlation, not text-metadata reconciliation");
        response = { ok: true, messages: counts.correlate === 1 ? [] : [{
          ts: "1788541200.000300", subtype: "file_share", files: [{ id: "F_CORRELATE" }],
        }] };
      } else if (method === "chat.postMessage") {
        counts.post += 1;
        const post = JSON.parse(String(init?.body)) as { text: string };
        const expected = counts.post === 1 ? "after image" : counts.post === 2 ? "other sender after image" : counts.post === 3 ? "quarantined historical text" : "new binding follows old FIFO";
        assert.equal(post.text.includes(expected), true);
        response = { ok: true, channel: "C_RUNTIME_TEST", ts: `1788541200.000${counts.post + 3}00` };
      } else {
        throw new Error(`unexpected provider method: ${method}`);
      }
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const runtime = createSlackBridgeDatabaseOutboundRuntime({
    db: surface.db, provider, reconciliationKey: "file-correlation-regression", registrationId: surface.registration.id,
    now: () => observedNow, workerIntervalMs: 60_000,
    async runWorkerOnce(input) {
      try {
        if (hashless) {
          const preparing = await processExternalDeliveryPartitionHead(input);
          assert.equal(preparing.kind === "blocked" ? preparing.reason : null, "attachment_source_preparing");
          assert.deepEqual(counts, { ticket: 0, upload: 0, complete: 0, correlate: 0, post: 0 },
            "hashing must finish before sending");
          const [credential] = await surface.db.select().from(externalAppCredentials)
            .where(eq(externalAppCredentials.installId, surface.install.id));
          assert.equal(credential?.leaseOwner, null, "hash preparation must not acquire the workspace credential");
          if (stallHash) {
            await readStartedPromise;
            const workerDeps = input.dependencies;
            assert.ok(workerDeps);
            const current = await workerDeps.resolveCurrentRuntime({
              deliveryId: queued[0]!.delivery.id, frozenSnapshot: fileSnapshot,
            });
            assert.ok(current && !("blockedReason" in current));
            const lease = await workerDeps.leaseCredential({ deliveryId: queued[0]!.delivery.id, runtime: current });
            assert.ok(lease, "another operation can acquire the workspace credential while storage is stalled");
            await workerDeps.releaseCredential?.({
              deliveryId: queued[0]!.delivery.id, runtime: current, credentialHandle: lease.handle, reason: "test",
            });
            releaseRead?.();
          }
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const [job] = await surface.db.select().from(externalAttachmentTransferJobs)
              .where(eq(externalAttachmentTransferJobs.outboundDeliveryId, queued[0]!.delivery.id));
            if (job?.frozenContentDigest) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        const first = await processExternalDeliveryPartitionHead(input);
        assert.equal(first.kind, "attempted");
        if (first.kind !== "attempted") throw new Error("first file attempt did not run");
        assert.equal(first.deliveryState, "outcome_unknown");
        assert.equal(counts.complete, 1);
        let replacement: Awaited<ReturnType<typeof reauthorizeSamePair>> | null = null;
        let newDeliveryId: string | null = null;
        if (rebind) {
          replacement = await reauthorizeSamePair(surface);
          observedNow = new Date(observedNow.getTime() + 25 * 60 * 60_000);
          const activeNow = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db,
            bindingId: replacement.id, expectedBindingEpoch: 1, expectedConnectionEpoch: 3,
            registrationId: surface.registration.id, senderType: "user", senderId: surface.owner.id, now: observedNow });
          assert.ok(activeNow);
          const [newMessage] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
            senderType: "user", senderId: surface.owner.id, content: "new binding follows old FIFO" }).returning();
          const admitted = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message: newMessage!,
            activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
              runtimePredicateRevision: activeNow.runtimeRevision, bindingAuthority: activeNow.neutral },
            canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
            authorName: surface.owner.name, sanitizedText: newMessage!.content,
            mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("file-correlation-regression", deliveryId) }));
          newDeliveryId = admitted.delivery.id;
          const heads = await listSlackPairHeads(surface.db, [{ bindingId: replacement.id, bindingEpoch: 1 }]);
          assert.equal(heads[0]?.deliveryId, queued[0]!.delivery.id, "the current pair must select its old unknown head ahead of new work");
        }
        observedNow = new Date(observedNow.getTime() + 30_000);
        const recovered = await processExternalDeliveryPartitionHead(input);
        assert.equal(recovered.kind, "cursor_recovered", `file recovery must reach durable file-ID correlation using its existing credential lease: ${"reason" in recovered ? recovered.reason : recovered.kind}`);
        if (recovered.kind !== "cursor_recovered") throw new Error("file recovery did not run");
        assert.equal(recovered.state, "accepted");
        let following: Awaited<ReturnType<typeof processExternalDeliveryPartitionHead>> = recovered;
        for (const expected of queued.slice(1)) {
          const result = await processExternalDeliveryPartitionHead(input);
          assert.equal(result.kind, "attempted");
          if (result.kind !== "attempted") throw new Error("following text did not run");
          assert.equal(result.deliveryState, "accepted");
          assert.equal(result.deliveryId, expected.delivery.id, "both senders must keep their original queue order");
          following = result;
        }
        const rows = await surface.db.select().from(externalOutboundDeliveries)
          .where(eq(externalOutboundDeliveries.bindingId, surface.binding.id));
        assert.equal(rows.length, 3);
        assert.ok(rows.every((row) => row.state === "accepted"));
        assert.equal(rows.find((row) => row.id === queued[0]!.delivery.id)?.providerMessageId, "1788541200.000300");
        const [partition] = await surface.db.select().from(externalDeliveryPartitions)
          .where(eq(externalDeliveryPartitions.bindingId, surface.binding.id));
        assert.equal(partition.cursorPosition, 3);
        assert.equal(rows[0]?.providerAttempts, 1, "read-only receipt acceptance must not consume another attempt");
        if (replacement) {
          // A legacy quarantined head is recovered before the new generation.
          const [quarantinedMessage] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
            senderType: "user", senderId: surface.owner.id, content: "quarantined historical text" }).returning();
          const quarantinedSnapshot = { ...fileSnapshot, sourceMessageId: quarantinedMessage!.id,
            sourceMessageSeq: quarantinedMessage!.seq, sanitizedText: quarantinedMessage!.content, attachments: [],
            enqueueRuntimeRevision: "historical-quarantine", externalMentions: [], raftMentionSubstitutions: [],
            bindingAuthority: { ...fileSnapshot.bindingAuthority, bindingEpoch: 99 } };
          let quarantinedId = "";
          await surface.db.transaction(async (tx) => {
            await tx.insert(externalDeliveryPartitions).values({ bindingId: surface.binding.id, bindingEpoch: 99, lastEnqueuedPosition: 1 });
            const [row] = await tx.insert(externalOutboundDeliveries).values({ sourceMessageId: quarantinedMessage!.id,
              bindingId: surface.binding.id, bindingEpoch: 99, partitionPosition: 1, enqueueRuntimeRevision: "historical-quarantine",
              state: "quarantined", stateReason: "authority_terminal:sender_no_longer_authorized",
              renderSnapshotSchema: quarantinedSnapshot.schema,
              renderSnapshot: quarantinedSnapshot as unknown as Record<string, unknown>,
              renderSnapshotDigest: digestSlackBridgeRenderSnapshot(quarantinedSnapshot), reconciliationMarker: "Q".repeat(43),
              createdAt: new Date(observedNow.getTime() - 2 * 24 * 60 * 60_000),
            }).returning();
            quarantinedId = row!.id;
          });
          const [visible] = await listSlackPairHeads(surface.db, [{ bindingId: replacement.id, bindingEpoch: 1 }]);
          assert.equal(visible?.deliveryId, quarantinedId, "the health read must retain the quarantined historical head");
          const [oldHead] = await listSlackPairHeads(surface.db, [{ bindingId: replacement.id, bindingEpoch: 1 }]);
          assert.equal(oldHead?.deliveryId, quarantinedId, "quarantine cannot make later work bypass its original place");
          const restored = await processExternalDeliveryPartitionHead({ ...input, bindingId: oldHead!.bindingId, bindingEpoch: oldHead!.bindingEpoch });
          assert.equal(restored.kind === "attempted" ? restored.deliveryState : null, "accepted", JSON.stringify(restored));
          const [head] = await listSlackPairHeads(surface.db, [{ bindingId: replacement.id, bindingEpoch: 1 }]);
          assert.equal(head?.deliveryId, newDeliveryId, "the new partition becomes eligible only after old work drains");
          const result = await processExternalDeliveryPartitionHead({ ...input, bindingId: head!.bindingId, bindingEpoch: head!.bindingEpoch });
          assert.equal(result.kind === "attempted" ? result.deliveryState : null, "accepted");
        }
        assert.deepEqual(counts, { ticket: 1, upload: 1, complete: 1, correlate: 2, post: rebind ? 4 : 2 });
        assert.equal(sourceReads, hashless ? 2 : 1, "hashless files are read once for hashing and once for upload, never again for recovery");
        resolveDone();
        return following;
      } catch (error) { rejectDone(error); throw error; }
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  runtime.start();
  try {
    await Promise.race([done, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("file recovery worker did not finish")), 10_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    await runtime.stop();
    await provider.stop();
  }
});

for (const history of ["found", "absent", "unknown_root", "unknown_child"] as const) {
test(`historical root recovery and following FIFO delivery (${history})`, async () => {
  const surface = await fixture("public");
  let observedNow = new Date();
  const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 31) });
  const sealed = await cipher.sealer.seal({
    serverId: surface.server.id, accessToken: "synthetic-history-token", tokenType: "bot",
    providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!,
    botUserId: surface.install.botUserId!, now: observedNow,
  });
  await surface.db.update(externalAppCredentials).set({
    encryptedMaterial: sealed.encryptedMaterial, envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion,
  }).where(eq(externalAppCredentials.installId, surface.install.id));
  const [root] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
    senderType: "user", senderId: surface.owner.id, content: "historical root", messageType: "chat" }).returning();
  const [thread] = await surface.db.insert(channels).values({ serverId: surface.server.id,
    name: "historical-thread", type: "thread", parentChannelId: surface.channel.id, parentMessageId: root.id }).returning();
  await surface.db.update(messages).set({ threadId: thread.id }).where(eq(messages.id, root.id));
  const link = history === "found" ? (await surface.db.insert(externalMessageLinks).values({
    provider: "slack", installId: "historical-install", providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, providerMessageId: "1788541200.000100",
    bindingId: "historical-binding", bindingEpoch: surface.binding.bindingEpoch - 1,
    connectionEpoch: 1, raftMessageId: root.id, firstDirection: "raft_outbound",
    payloadFingerprint: "a".repeat(64), outcomeState: "accepted", authorityState: "stale",
  }).returning())[0]! : null;
  const active = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db, bindingId: surface.binding.id, expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch, senderType: "user", senderId: surface.owner.id,
    now: observedNow, registrationId: surface.registration.id,
  });
  assert.ok(active);
  const queued: Awaited<ReturnType<typeof enqueueSlackBridgeOutboundDelivery>>[] = [];
  for (const [index, channelId] of [thread.id, surface.channel.id].entries()) {
    const [message] = await surface.db.insert(messages).values({ channelId,
      senderType: "user", senderId: surface.owner.id, content: `current message ${index}`, messageType: "chat" }).returning();
    queued.push(await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({
      executor, message, activeRuntime: { level: index === 0 ? "thread" : "top_level",
        authorityConversationId: channelId, runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral },
      canonicalConversationId: channelId, canonicalRootMessageId: index === 0 ? root.id : null,
      senderType: "user", senderId: surface.owner.id, authorName: surface.owner.name, sanitizedText: message.content,
      mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("history-regression", deliveryId),
    })));
  }
  if (history === "unknown_child") {
    await surface.db.update(externalOutboundDeliveries).set({ state: "outcome_unknown", providerAttempts: 1,
      firstDispatchedAt: observedNow }).where(eq(externalOutboundDeliveries.id, queued[0].delivery.id));
  }
  if (history === "unknown_root") {
    const frozen = queued[0].delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
    await surface.db.transaction(async (tx) => {
    await tx.insert(externalDeliveryPartitions).values({ bindingId: surface.binding.id,
      bindingEpoch: surface.binding.bindingEpoch - 1, lastEnqueuedPosition: 1 });
    await tx.insert(externalOutboundDeliveries).values({ sourceMessageId: root.id,
      bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch - 1, partitionPosition: 1,
      enqueueRuntimeRevision: "old-runtime", state: "outcome_unknown", providerAttempts: 1,
      firstDispatchedAt: observedNow, renderSnapshotSchema: frozen.schema,
      renderSnapshot: { ...frozen, level: "top_level", canonicalRootMessageId: null,
        sourceMessageId: root.id, bindingAuthority: { ...frozen.bindingAuthority, bindingEpoch: surface.binding.bindingEpoch - 1 } },
      renderSnapshotDigest: "b".repeat(64), reconciliationMarker: "B".repeat(43),
    });
    });
  }
  const posts: Array<{ thread_ts?: string }> = [];
  const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: cipher, now: () => observedNow,
    fetch: (async (input, init) => {
      assert.equal(new URL(String(input)).pathname.split("/").at(-1), "chat.postMessage");
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, ts: `1788541200.000${200 + posts.length}`, channel: surface.binding.providerConversationId }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const runtime = createSlackBridgeDatabaseOutboundRuntime({
    db: surface.db, provider, reconciliationKey: "history-regression", registrationId: surface.registration.id,
    now: () => observedNow, workerIntervalMs: 60_000,
    async runWorkerOnce(input) {
      try {
        if (link) {
          const [conflict] = await surface.db.insert(externalMessageLinks).values({
          ...link!, id: randomUUID(), bindingEpoch: surface.binding.bindingEpoch,
          providerMessageId: "1788541200.000999",
        }).returning();
        const blocked = await processExternalDeliveryPartitionHead(input);
        assert.equal(blocked.kind, "blocked");
        assert.equal("reason" in blocked ? blocked.reason : null, "provider_thread_receipt_conflict");
        assert.equal(posts.length, 0, "conflicting historical receipts must not choose an arbitrary Slack thread");
        await surface.db.delete(externalMessageLinks).where(eq(externalMessageLinks.id, conflict.id));
        }
        if (history === "unknown_root" || history === "unknown_child") {
          const result = await processExternalDeliveryPartitionHead(input);
          assert.equal(result.kind, "blocked");
          assert.equal(posts.length, 0, "unknown provider results cannot be treated as confirmed absence");
          const [head] = await surface.db.select().from(externalOutboundDeliveries)
            .where(eq(externalOutboundDeliveries.id, queued[0].delivery.id));
          assert.equal(head.state, history === "unknown_child" ? "outcome_unknown" : "queued");
          assert.equal(head.providerAttempts, history === "unknown_child" ? 1 : 0);
          resolveDone();
          return result;
        }
        for (const [index, expected] of queued.entries()) {
          if (history === "absent" && index === 0) {
            await surface.db.update(externalDeliveryPartitions).set({
              authorityBlockedAt: new Date(observedNow.getTime() - 60_000),
              authorityBlockedReason: "historical_root_wait", authorityRetryAt: observedNow,
              authorityOverdueAlertedAt: observedNow,
            }).where(eq(externalDeliveryPartitions.bindingId, surface.binding.id));
          }
          const result = await processExternalDeliveryPartitionHead(input);
          if (history === "absent" && index === 0) {
            assert.equal(result.kind, "skipped", JSON.stringify(result));
            const [discarded] = await surface.db.select().from(externalOutboundDeliveries)
              .where(eq(externalOutboundDeliveries.id, expected.delivery.id));
            assert.equal(discarded.stateReason, "confirmed_thread_root_missing");
            assert.equal(discarded.providerAttempts, 0);
            assert.equal(posts.length, 0, "orphan discard must not call Slack");
            const [afterDiscard] = await surface.db.select().from(externalDeliveryPartitions)
              .where(eq(externalDeliveryPartitions.bindingId, surface.binding.id));
            assert.deepEqual([afterDiscard.authorityBlockedAt, afterDiscard.authorityBlockedReason,
              afterDiscard.authorityRetryAt, afterDiscard.authorityOverdueAlertedAt], [null, null, null, null],
            "advancing a confirmed orphan clears its stale pair wait");
            continue;
          }
          assert.equal(result.kind, "attempted", JSON.stringify(result));
          if (result.kind !== "attempted") throw new Error("historical thread did not dispatch");
          assert.equal(result.deliveryState, "accepted");
          assert.equal(result.deliveryId, expected.delivery.id);
          observedNow = new Date(observedNow.getTime() + 1_000);
        }
        const [partition] = await surface.db.select().from(externalDeliveryPartitions)
          .where(eq(externalDeliveryPartitions.bindingId, surface.binding.id));
        assert.equal(partition.cursorPosition, 2);
        assert.deepEqual(posts.map((post) => post.thread_ts ?? null), history === "absent" ? [null] : ["1788541200.000100", null]);
        if (link) {
        const [historical] = await surface.db.select().from(externalMessageLinks).where(eq(externalMessageLinks.id, link.id));
        assert.equal(historical.bindingEpoch, surface.binding.bindingEpoch - 1);
        }
        resolveDone();
        return { kind: "empty" };
      } catch (error) { rejectDone(error); throw error; }
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  runtime.start();
  try {
    await Promise.race([done, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("historical thread worker did not finish")), 10_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    await runtime.stop();
    await provider.stop();
  }
});

}


test("admitted inbound custody survives new binding identity and reauthorization but still requires the current target", async () => {
  const surface = await fixture("public");
  const a = surface.authority;
  const frozen = { runtimeRevision: slackBridgeDatabaseRuntimeRevision(a), provider: "slack", environment: "test" as const,
    appRegistrationId: a.registrationId, installId: a.installId, workspaceId: a.providerAuthorityId,
    providerAuthorityId: a.providerAuthorityId, providerConversationId: a.providerConversationId,
    bindingId: a.bindingId, bindingEpoch: a.bindingEpoch, connectionEpoch: a.connectionEpoch,
    raftChannelId: a.channelId, privacyClass: a.privacyClass };
  const eventId = await storeWorkerCustody(surface, frozen);
  const binding = await reauthorizeSamePair(surface);
  const resolve = createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => NOW);
  const continued = await resolve({ eventId, frozenAuthority: frozen });
  assert.equal(continued?.bindingId, frozen.bindingId, "sealed custody stays original");
  assert.equal(continued?.operationAuthority?.bindingId, binding.id, "current authorization uses the replacement pair");
  assert.equal(await resolve({ eventId: randomUUID(), frozenAuthority: frozen }), null, "unrecorded custody cannot authorize replay");
  await surface.db.update(externalChannelBindings).set({ providerConversationId: "C_OTHER_TARGET" }).where(eq(externalChannelBindings.id, binding.id));
  assert.equal(await resolve({ eventId, frozenAuthority: frozen }), null, "a real destination change cannot consume old work");
});

for (const recovery of ["found", "expired_before_write", "paged", "lease_replaced", "lease_replaced_before_evidence", "delayed_response", "unconfirmable", "sender_unverified", "sender_copied", "workspace_restricted_read"] as const) {
  test(`text unknown result uses current reauthorized credentials without nested lease (${recovery})`, async () => {
    const surface = await fixture("public");
    let clock = new Date();
    const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 32) });
    const sealed = await cipher.sealer.seal({ serverId: surface.server.id, accessToken: "synthetic-bot-token", tokenType: "bot",
      providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!, botUserId: surface.install.botUserId!, now: clock });
    await surface.db.update(externalAppCredentials).set({ encryptedMaterial: sealed.encryptedMaterial,
      envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion }).where(eq(externalAppCredentials.installId, surface.install.id));
    const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
      expectedBindingEpoch: 3, expectedConnectionEpoch: 2, senderType: "user", senderId: surface.owner.id,
      now: clock, registrationId: surface.registration.id });
    assert.ok(active);
    const [message] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
      senderType: "user", senderId: surface.owner.id, content: "unknown initial text" }).returning();
    const admitted = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message: message!,
      activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
        runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral },
      canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
      authorName: surface.owner.name, sanitizedText: message!.content,
      mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("text-rebind", deliveryId) }));
    let posts = 0;
    let reads = 0;
    let acceptedMetadata: Record<string, unknown> | undefined;
    let acceptedTimestamp = "";
    const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: cipher, now: () => clock,
      fetch: (async (input, init) => {
        const method = new URL(String(input)).pathname.split("/").at(-1);
        if (method === "chat.postMessage") {
          posts += 1;
          acceptedMetadata = JSON.parse(String(init?.body)).metadata;
          acceptedTimestamp = (clock.getTime() / 1000).toFixed(6);
          if (recovery === "delayed_response") clock = new Date(clock.getTime() + 90_000);
          throw new Error("synthetic accepted write with lost response");
        }
        assert.equal(method, "conversations.history");
        reads += 1;
        if (recovery === "workspace_restricted_read") return new Response(JSON.stringify({ ok: false, error: "app_access_restricted" }),
          { status: 200, headers: { "content-type": "application/json" } });
        if (recovery === "expired_before_write") clock = new Date(clock.getTime() + 61_000);
        if (recovery === "lease_replaced") {
          const foreignScan = parseSlackReconciliationScan({ schema: "slack-reconciliation-scan.v3", providerAttempt: 1,
            scopeKey: "f".repeat(64), oldest: "1.000000", latest: "2.000000", cursor: "replacement-cursor",
            match: null, metadataMissing: false, markerUnconfirmed: false, historyLimited: false });
          assert.ok(foreignScan);
          await surface.db.update(externalOutboundDeliveries).set({ leaseOwner: "replacement-worker",
            leaseGeneration: sql`${externalOutboundDeliveries.leaseGeneration} + 1`, reconciliationScan: foreignScan,
          }).where(eq(externalOutboundDeliveries.id, admitted.delivery.id));
          return new Response(JSON.stringify({ ok: true, messages: [], has_more: true, response_metadata: { next_cursor: "old-page" } }),
            { status: 200, headers: { "content-type": "application/json" } });
        }
        if (recovery === "paged" && reads <= 2) return new Response(JSON.stringify({ ok: true, messages: [], has_more: true,
          response_metadata: { next_cursor: `page-${reads}` } }), { status: 200, headers: { "content-type": "application/json" } });
        if (recovery === "paged") assert.equal(new URL(String(input)).searchParams.get("cursor"), "page-2");
        return new Response(JSON.stringify({ ok: true, messages: recovery === "unconfirmable" ? [{ ts: acceptedTimestamp, app_id: surface.install.providerAppId }]
          : (recovery === "sender_unverified" || recovery === "sender_copied")
            ? [{ ts: acceptedTimestamp, metadata: acceptedMetadata, ...(recovery === "sender_copied" ? { app_id: "A_OTHER" } : {}) }]
          : (recovery === "found" || recovery === "paged" || recovery === "delayed_response")
            && Number(acceptedTimestamp) >= Number(new URL(String(input)).searchParams.get("oldest"))
            && Number(acceptedTimestamp) <= Number(new URL(String(input)).searchParams.get("latest"))
          ? [{ ts: acceptedTimestamp, app_id: surface.install.providerAppId, metadata: acceptedMetadata }] : [], has_more: false }),
          { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    let done!: () => void;
    let fail!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
    const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider,
      reconciliationKey: "text-rebind", registrationId: surface.registration.id, now: () => clock, workerIntervalMs: 60_000,
      async runWorkerOnce(input) {
        try {
          const sent = await processExternalDeliveryPartitionHead(input);
          assert.equal(sent.kind === "attempted" ? sent.deliveryState : null, "outcome_unknown");
          const replacement = await reauthorizeSamePair(surface);
          if (recovery === "found") clock = new Date(clock.getTime() + 25 * 60 * 60_000);
          const [head] = await listSlackPairHeads(surface.db, [{ bindingId: replacement.id, bindingEpoch: 1 }]);
          assert.equal(head?.deliveryId, admitted.delivery.id);
          const workerDependencies = input.dependencies;
          assert.ok(workerDependencies?.prepareProvider);
          const originalPrepareProvider = workerDependencies.prepareProvider;
          const request = { ...input, dependencies: workerDependencies, bindingId: head!.bindingId, bindingEpoch: head!.bindingEpoch,
            ...(recovery === "lease_replaced_before_evidence" ? { dependencies: { ...workerDependencies,
              async prepareProvider(claim: Parameters<typeof originalPrepareProvider>[0]) {
                await surface.db.update(externalOutboundDeliveries).set({ leaseOwner: "replacement-worker",
                  leaseGeneration: sql`${externalOutboundDeliveries.leaseGeneration} + 1`, reconciliationScan: {
                    schema: "slack-reconciliation-scan.v3", providerAttempt: 1, scopeKey: "f".repeat(64), oldest: "1.000000", latest: "2.000000",
                    cursor: null, match: null, metadataMissing: false, markerUnconfirmed: false, historyLimited: false,
                  },
                }).where(eq(externalOutboundDeliveries.id, admitted.delivery.id));
                return originalPrepareProvider(claim);
              },
            } } : {}),
          };
          let recovered = await processExternalDeliveryPartitionHead(request);
          if (recovery === "paged") {
            assert.equal("reason" in recovered ? recovered.reason : null, "reconciliation_scan_pending");
            const [checkpoint] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, admitted.delivery.id));
            assert.equal(checkpoint.reconciliationScan?.cursor, "page-2", "progress must be durable, not process-local");
            assert.equal(checkpoint.providerAttempts, 1);
            clock = new Date(clock.getTime() + 31_000);
            recovered = await processExternalDeliveryPartitionHead(request);
          }
          const accepted = recovery === "found" || recovery === "paged" || recovery === "delayed_response";
          assert.equal(recovered.kind, accepted ? "cursor_recovered" : (recovery === "unconfirmable" || recovery === "sender_unverified" || recovery === "sender_copied" || recovery === "workspace_restricted_read") ? "authority_blocked" : "blocked", JSON.stringify(recovered));
          if (!accepted) assert.equal("reason" in recovered ? recovered.reason : null,
            (recovery === "lease_replaced" || recovery === "expired_before_write") ? "provider_preflight_exception" : recovery === "lease_replaced_before_evidence" ? "reconciliation_attempt_evidence_missing"
              : recovery === "unconfirmable" ? "reconciliation_bridge_metadata_missing" : (recovery === "sender_unverified" || recovery === "sender_copied") ? "reconciliation_marker_unconfirmed" : recovery === "workspace_restricted_read" ? "slack_workspace_admin_required" : "lease_expired_before_attempt_start");
          const [credential] = await surface.db.select().from(externalAppCredentials).where(eq(externalAppCredentials.installId, surface.install.id));
          assert.equal(credential.leaseOwner, null, "preparation must release the actual replacement credential even without dispatch");
          const [delivery] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, admitted.delivery.id));
          assert.equal(delivery.providerAttempts, 1);
          assert.equal(posts, 1, "reconciliation must not duplicate the original write");
          assert.equal(reads, recovery === "paged" ? 3 : recovery === "lease_replaced_before_evidence" ? 0 : 1, "the outer credential cannot prevent read-only reconciliation");
          if (recovery === "paged") assert.equal(delivery.reconciliationScan, null);
          if (recovery === "lease_replaced" || recovery === "lease_replaced_before_evidence") {
            assert.equal(delivery.leaseOwner, "replacement-worker");
            assert.equal(delivery.reconciliationScan?.scopeKey, "f".repeat(64), "a stale callback cannot overwrite another lease's progress");
          }
          if (recovery === "workspace_restricted_read") {
            const [partition] = await surface.db.select().from(externalDeliveryPartitions)
              .where(eq(externalDeliveryPartitions.bindingId, admitted.delivery.bindingId));
            assert.equal(partition.authorityBlockedReason, "slack_workspace_admin_required");
          }
          if (recovery === "unconfirmable" || recovery === "sender_unverified" || recovery === "sender_copied") {
            const expectedReason = recovery === "sender_unverified" || recovery === "sender_copied" ? "reconciliation_marker_unconfirmed" : "reconciliation_bridge_metadata_missing";
            const [partition] = await surface.db.select().from(externalDeliveryPartitions)
              .where(eq(externalDeliveryPartitions.bindingId, admitted.delivery.bindingId));
            assert.equal(partition.authorityBlockedReason, expectedReason);
            assert.equal(partition.authorityRetryAt?.getTime(), clock.getTime() + 900_000);
            assert.equal(delivery.reconciliationScan?.conclusion?.reason, expectedReason);
            clock = new Date(clock.getTime() + 31_000);
            assert.equal((await processExternalDeliveryPartitionHead(request)).kind, "blocked");
            assert.equal(reads, 1, "unconfirmable work is visible without rescanning or sending");
          }
          done();
          return recovered;
        } catch (error) { fail(error); throw error; }
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    runtime.start();
    try { await Promise.race([finished, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("text rebind worker timed out")), 10_000); })]); }
    finally { if (timer) clearTimeout(timer); await runtime.stop(); await provider.stop(); }
  });
}


for (const mode of ["external_bot", "external_present", "external_removed", "external_removed_before_dispatch", "external_fact_changed",
  "group_current", "group_replaced", "group_retired", "group_replaced_before_dispatch", "group_target_removed",
  "group_wrong_principal", "group_missing_original_fact", "group_mapping_read_failed", "ambiguous_handle",
  "group_joint_current", "group_joint_projection_removed", "group_agent_current", "group_agent_removed"] as const) {
  test(`queued Slack mentions validate current identity at publication (${mode})`, async () => {
    const groupMode = mode.startsWith("group_") || mode === "ambiguous_handle";
    const present = mode !== "external_removed";
    const removeBeforeDispatch = mode === "external_removed_before_dispatch";
    const surface = await fixture("public");
    if (mode === "external_bot") {
      await surface.db.update(externalActorProjections).set({ externalActorId: "BOTHERBOT", actorKind: "bot" }).where(eq(externalActorProjections.id, surface.projection.id));
      surface.projection.externalActorId = "BOTHERBOT";
    }
    const clock = new Date();
    const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 33) });
    const sealed = await cipher.sealer.seal({ serverId: surface.server.id, accessToken: "synthetic-bot-token", tokenType: "bot",
      providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!, botUserId: surface.install.botUserId!, now: clock });
    await surface.db.update(externalAppCredentials).set({ encryptedMaterial: sealed.encryptedMaterial,
      envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion }).where(eq(externalAppCredentials.installId, surface.install.id));
    let sourceChannelId = surface.channel.id;
    let mentionChannelId = surface.channel.id;
    let mentionServerId = surface.server.id;
    let participantProjectionId: string | null = null;
    if (mode.startsWith("group_joint")) {
      const participant = await createServer("Mention participant", `mention-part-${randomUUID()}`, surface.owner.id);
      const [canonical, face] = await surface.db.insert(channels).values([
        { serverId: surface.server.id, name: "canonical mention parent", type: "channel" },
        { serverId: participant.id, name: "participant mention face", type: "joint" },
      ]).returning();
      const [joint] = await surface.db.insert(jointChannels).values({ canonicalChannelId: canonical!.id,
        createdByServerId: surface.server.id, createdByUserId: surface.owner.id }).returning();
      await surface.db.update(channels).set({ type: "joint" }).where(eq(channels.id, surface.channel.id));
      const projections = await surface.db.insert(jointChannelServers).values([
        { jointChannelId: joint!.id, serverId: surface.server.id, localChannelId: surface.channel.id,
          role: "host", joinedByUserId: surface.owner.id },
        { jointChannelId: joint!.id, serverId: participant.id, localChannelId: face!.id,
          role: "participant", joinedByUserId: surface.owner.id },
      ]).returning();
      participantProjectionId = projections[1]!.localChannelId;
      sourceChannelId = canonical!.id; mentionChannelId = face!.id; mentionServerId = participant.id;
    }
    const [message] = await surface.db.insert(messages).values({ channelId: sourceChannelId,
      senderType: "user", senderId: surface.owner.id, content: "hello @runtime-human body continues" }).returning();
    if (!groupMode || mode === "ambiguous_handle") await surface.db.insert(externalMentionFacts).values({ messageId: message!.id, projectionId: surface.projection.id,
      provider: "slack", appRegistrationId: surface.registration.id, installId: surface.install.id,
      workspaceId: surface.install.providerAuthorityId, externalActorId: surface.projection.externalActorId,
      connectionEpoch: 2, bindingId: surface.binding.id, bindingEpoch: 3, conversationId: "C_RUNTIME_TEST",
      memberRevision: 1, contextRevision: 1, freshnessObservedAt: NOW, freshnessExpiresAt: EXPIRES,
      handleAtSendTime: "runtime-human", resolutionReason: "explicit_projection" });
    const [target] = await surface.db.insert(users).values({ email: `${randomUUID()}@mention.test`,
      name: `target-${randomUUID()}`, passwordHash: "synthetic" }).returning();
    let identity: Awaited<ReturnType<typeof reserveSlackUsergroupIdentity>> | null = null;
    if (groupMode) {
      await surface.db.insert(serverMembers).values({ serverId: mentionServerId, userId: target!.id, role: "member" });
      if (mode.startsWith("group_agent")) {
        await surface.db.insert(agents).values({ id: target!.id, serverId: mentionServerId, name: target!.name, status: "active" });
        await surface.db.insert(channelAgents).values({ channelId: mentionChannelId, agentId: target!.id });
      }
      identity = await reserveSlackUsergroupIdentity(surface.db, { installId: surface.install.id, serverId: mentionServerId,
        principalKind: mode.startsWith("group_agent") ? "agent" : "user", principalId: target!.id });
      await surface.db.update(slackUsergroupIdentities).set({ providerUsergroupId: "S_RUNTIME_GROUP", humanCanonical: !mode.startsWith("group_agent") })
        .where(eq(slackUsergroupIdentities.id, identity.id));
      await surface.db.insert(messageMentions).values({ messageId: message!.id, messageSeq: message!.seq,
        serverId: mentionServerId, channelId: mentionChannelId,
        targetType: mode.startsWith("group_agent") ? "agent" : "user", targetId: target!.id,
        handleAtSendTime: "runtime-human" });
    }
    const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
      expectedBindingEpoch: 3, expectedConnectionEpoch: 2, senderType: "user", senderId: surface.owner.id,
      registrationId: surface.registration.id, now: clock });
    assert.ok(active);
    const admitted = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message: message!,
      activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
        runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral },
      canonicalConversationId: sourceChannelId, senderType: "user", senderId: surface.owner.id,
      authorName: surface.owner.name, sanitizedText: message!.content,
      mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("mention-rebind", deliveryId) }));
    if (participantProjectionId) {
      // Reproduce an older frozen snapshot admitted from the participant face;
      // the original principal fact is still scoped to that active projection.
      const frozen = admitted.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
      frozen.raftMentionSubstitutions = [{ kind: "usergroup", handle: "runtime-human", token: "<!subteam^S_RUNTIME_GROUP>",
        installId: surface.install.id, bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch }];
      await surface.db.update(externalOutboundDeliveries).set({
        renderSnapshot: frozen as unknown as Record<string, unknown>, renderSnapshotDigest: digestSlackBridgeRenderSnapshot(frozen),
      }).where(eq(externalOutboundDeliveries.id, admitted.delivery.id));
      if (mode === "group_joint_projection_removed") await surface.db.update(jointChannelServers).set({ status: "disconnected" })
        .where(eq(jointChannelServers.localChannelId, participantProjectionId));
    }
    if (mode === "group_agent_removed") await surface.db.delete(channelAgents).where(eq(channelAgents.agentId, target!.id));
    const binding = await reauthorizeSamePair(surface);
    if (!present) await surface.db.update(externalAddressabilityProjections).set({ state: "stale" })
      .where(eq(externalAddressabilityProjections.bindingId, binding.id));
    if (identity) {
      if (mode === "group_replaced") await surface.db.update(slackUsergroupIdentities).set({ providerUsergroupId: "S_REPLACEMENT" })
        .where(eq(slackUsergroupIdentities.id, identity.id));
      if (mode === "group_retired") await surface.db.update(slackUsergroupIdentities).set({ humanCanonical: false })
        .where(eq(slackUsergroupIdentities.id, identity.id));
      if (mode === "group_wrong_principal") await surface.db.update(slackUsergroupIdentities).set({ principalId: surface.owner.id })
        .where(eq(slackUsergroupIdentities.id, identity.id));
      if (mode === "group_target_removed") await surface.db.delete(serverMembers).where(eq(serverMembers.userId, target!.id));
      if (mode === "group_missing_original_fact") await surface.db.delete(messageMentions).where(eq(messageMentions.messageId, message!.id));
      if (mode === "group_mapping_read_failed") await surface.db.execute(sql`DROP TABLE slack_usergroup_identities`);
      if (mode === "group_replaced_before_dispatch") __setExternalDeliveryAttemptRowLockHookForTests(async () => {
        await surface.db.update(slackUsergroupIdentities).set({ providerUsergroupId: "S_REPLACEMENT" })
          .where(eq(slackUsergroupIdentities.id, identity!.id));
      });
    }
    if (mode === "external_fact_changed") await surface.db.update(externalMentionFacts).set({ handleAtSendTime: "changed-intent" })
      .where(eq(externalMentionFacts.messageId, message!.id));
    // The stale old observation must neither authorize a removed member nor block a current member.
    if (present) await surface.db.update(externalAddressabilityProjections).set({ state: "stale" })
      .where(eq(externalAddressabilityProjections.bindingId, surface.binding.id));
    if (removeBeforeDispatch) __setExternalDeliveryAttemptRowLockHookForTests(async () => {
      await surface.db.update(externalAddressabilityProjections).set({ state: "stale" })
        .where(eq(externalAddressabilityProjections.bindingId, binding.id));
    });
    let posted = "";
    const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: cipher, now: () => clock,
      fetch: (async (input, init) => {
        assert.equal(new URL(String(input)).pathname.split("/").at(-1), "chat.postMessage");
        posted = JSON.parse(String(init?.body)).text;
        return new Response(JSON.stringify({ ok: true, channel: "C_RUNTIME_TEST", ts: "1788541200.000800" }),
          { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch });
    let done!: () => void; let fail!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
    const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
      reconciliationKey: "mention-rebind", now: () => clock, workerIntervalMs: 60_000,
      async runWorkerOnce(input) { try {
        const result = await processExternalDeliveryPartitionHead(input);
        assert.equal(result.kind === "attempted" ? result.deliveryState : null, "accepted", JSON.stringify(result));
        assert.equal(posted, ["group_current", "group_joint_current", "group_agent_current"].includes(mode) ? "hello <!subteam^S_RUNTIME_GROUP> body continues"
          : ["group_replaced", "group_replaced_before_dispatch"].includes(mode) ? "hello <!subteam^S_REPLACEMENT> body continues"
          : mode === "external_present" ? "hello <@U_RUNTIME_HUMAN> body continues" : "hello @runtime-human body continues");
        const [delivery] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, admitted.delivery.id));
        assert.deepEqual(delivery.renderSnapshot, admitted.delivery.renderSnapshot, "render degradation cannot rewrite original intent");
        done(); return result;
      } catch (error) { fail(error); throw error; } },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    runtime.start();
    try { await Promise.race([finished, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("mention rebind timed out")), 10_000); })]); }
    finally { if (timer) clearTimeout(timer); await runtime.stop(); await provider.stop(); }
  });
}

async function pairControlFixture(count = 2) {
  const surface = await fixture("public");
  const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
    expectedBindingEpoch: 3, expectedConnectionEpoch: 2, senderType: "user", senderId: surface.owner.id,
    now: NOW, registrationId: surface.registration.id });
  assert.ok(active);
  const deliveries = [];
  for (let index = 0; index < count; index += 1) {
    const [message] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
      senderType: "user", senderId: surface.owner.id, content: `pair control body ${index}` }).returning();
    const queued = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message: message!,
      activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
        runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral },
      canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
      authorName: surface.owner.name, sanitizedText: message!.content,
      mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("control-test", deliveryId) }));
    deliveries.push(queued.delivery);
  }
  const runtime = { runtimeRevision: active.runtimeRevision, bindingAuthority: active.neutral };
  let providerCalls = 0;
  const deps: ExternalDeliveryWorkerDependencies = {
    now: () => NOW, resolveCurrentRuntime: async () => runtime,
    leaseCredential: async () => ({ handle: {}, runtimeRevision: active.runtimeRevision, credentialRevision: 1, ...active.neutral }),
    dispatchProvider: async () => { providerCalls += 1; return { kind: "outcome_unknown", reasonCode: "lost_response" }; },
  };
  const scope = { registrationId: surface.registration.id, currentBindingId: surface.binding.id, currentBindingEpoch: 3,
    bindingId: surface.binding.id, bindingEpoch: 3 };
  const head = () => processExternalDeliveryPartitionHead({ db: surface.db, bindingId: surface.binding.id,
    bindingEpoch: 3, leaseOwner: "pair-control-test", dependencies: deps });
  const deleted = async () => {
    await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_deleted", bindingEpoch: 4 })
      .where(eq(externalChannelBindings.id, surface.binding.id));
    // A persisted legacy fact is sufficient even after the capture trigger is removed.
    await surface.db.insert(slackChannelDeletions).values({ registrationId: surface.registration.id,
      environment: "test", providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
      providerConversationId: surface.binding.providerConversationId, sourceInstallId: surface.install.id,
      sourceKind: "legacy_binding", sourceKey: `binding:${surface.binding.id}:4`, sourceBindingId: surface.binding.id, observedAt: NOW });
    return { ...scope, currentBindingEpoch: 4 };
  };
  return { ...surface, deliveries, deps, scope, head, deleted, providerCalls: () => providerCalls };
}

async function waitForControlState(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error("pair control did not reach its observed state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("administrative pauses retain the first wait without claiming or changing attempts", async () => {
  const surface = await pairControlFixture();
  const before = await surface.db.select().from(externalOutboundDeliveries);
  await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "master_disabled", now: NOW });
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "manager_paused" })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "binding_paused", now: new Date(NOW.getTime() + 10_000) });
  const [waiting] = await surface.db.select().from(externalDeliveryPartitions);
  assert.equal(waiting.authorityBlockedAt?.toISOString(), NOW.toISOString());
  assert.equal(waiting.authorityBlockedReason, "binding_paused");
  assert.equal(waiting.authorityRetryAt, null);
  assert.deepEqual(await surface.db.select().from(externalOutboundDeliveries), before);
  assert.equal((await surface.db.select().from(externalDeliveryAttempts)).length, 0);
  await surface.db.update(externalChannelBindings).set({ state: "active", stateReason: null })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  await clearResumedSlackPairControlWait({ db: surface.db, ...surface.scope, now: new Date(NOW.getTime() + 20_000) });
  const [resumed] = await surface.db.select().from(externalDeliveryPartitions);
  assert.equal(resumed.authorityBlockedAt, null);
  assert.equal(resumed.authorityBlockedReason, null);
});

test("a maintenance pause cannot erase an earlier provider wait or its reconciliation cooldown", async () => {
  const surface = await pairControlFixture();
  const earlier = new Date(NOW.getTime() - 120_000);
  const retry = new Date(NOW.getTime() + 900_000);
  await surface.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: earlier,
    authorityBlockedReason: "reconciliation_bridge_metadata_missing", authorityRetryAt: retry });
  await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "master_disabled", now: NOW });
  await clearResumedSlackPairControlWait({ db: surface.db, ...surface.scope, now: NOW });
  const [row] = await surface.db.select().from(externalDeliveryPartitions);
  assert.equal(row.authorityBlockedAt?.toISOString(), earlier.toISOString());
  assert.equal(row.authorityBlockedReason, "reconciliation_bridge_metadata_missing");
  assert.equal(row.authorityRetryAt?.toISOString(), retry.toISOString());
});

test("the master OFF to ON runtime records waiting with zero claims and automatically drains original work", async () => {
  const surface = await pairControlFixture(1);
  const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) });
  const sealed = await cipher.sealer.seal({ serverId: surface.server.id, accessToken: "synthetic-bot-token", tokenType: "bot",
    providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!, botUserId: surface.install.botUserId!, now: NOW });
  await surface.db.update(externalAppCredentials).set({ encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion }).where(eq(externalAppCredentials.installId, surface.install.id));
  await deleteFeatureFlagRule(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, surface.masterRule.id);
  let posts = 0;
  let claims = 0;
  const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: cipher, now: () => NOW,
    fetch: (async (input) => {
      assert.equal(new URL(String(input)).pathname.split("/").at(-1), "chat.postMessage"); posts += 1;
      return new Response(JSON.stringify({ ok: true, channel: surface.binding.providerConversationId, ts: "1793210000.000100" }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch });
  const errors: unknown[] = [];
  const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
    reconciliationKey: "control-test", now: () => NOW, workerIntervalMs: 10, onError: (error) => errors.push(error),
    runWorkerOnce: async (input) => { claims += 1; return processExternalDeliveryPartitionHead(input); } });
  runtime.start();
  try {
    await waitForControlState(async () => (await surface.db.select().from(externalDeliveryPartitions))[0]?.authorityBlockedReason === "master_disabled");
    const [off] = await surface.db.select().from(externalOutboundDeliveries);
    assert.equal(off.state, "queued"); assert.equal(off.leaseGeneration, 0); assert.equal(off.providerAttempts, 0);
    assert.equal(claims, 0); assert.equal(posts, 0);
    await createFeatureFlagRule({ flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, stage: "server", decision: "allow", values: [surface.server.id] });
    await waitForControlState(async () => (await surface.db.select().from(externalOutboundDeliveries))[0]?.state === "accepted");
    assert.equal(posts, 1);
    assert.deepEqual(errors, []);
    const [pair] = await surface.db.select().from(externalDeliveryPartitions);
    assert.equal(pair.cursorPosition, 1); assert.equal(pair.authorityBlockedAt, null);
  } finally { await runtime.stop(); await provider.stop(); }
});

test("a deleted destination drains attempted unknown and following untouched work with no provider I/O", async () => {
  const surface = await pairControlFixture(3);
  assert.equal((await surface.head()).kind, "attempted");
  const checkpoint = parseSlackReconciliationScan({ schema: "slack-reconciliation-scan.v3", providerAttempt: 1, scopeKey: "f".repeat(64),
    oldest: "1.000000", latest: "2.000000", cursor: "preserved-checkpoint", match: null, metadataMissing: false, markerUnconfirmed: false, historyLimited: false });
  await surface.db.update(externalOutboundDeliveries).set({ reconciliationScan: checkpoint })
    .where(eq(externalOutboundDeliveries.id, surface.deliveries[0]!.id));
  const ledger = await surface.db.select().from(externalDeliveryAttempts);
  await surface.deleted();
  const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) }),
    now: () => NOW, fetch: (async () => { throw new Error("deleted destination must never call Slack"); }) as typeof fetch });
  let ordinaryWorkerCalls = 0;
  const errors: unknown[] = [];
  const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
    reconciliationKey: "control-test", now: () => NOW, workerIntervalMs: 10, onError: (error) => errors.push(error),
    runWorkerOnce: async () => { ordinaryWorkerCalls += 1; throw new Error("deleted pair must use local cleanup"); } });
  runtime.start();
  try {
    await waitForControlState(async () => (await surface.db.select().from(externalDeliveryPartitions))[0]?.cursorPosition === 3);
  } finally { await runtime.stop(); await provider.stop(); }
  const rows = await surface.db.select().from(externalOutboundDeliveries).orderBy(externalOutboundDeliveries.partitionPosition);
  assert.deepEqual(rows.map((row) => row.stateReason), ["destination_deleted_outcome_unconfirmed", "destination_deleted", "destination_deleted"]);
  assert.ok(rows.every((row) => row.state === "skipped"));
  assert.deepEqual(rows.map((row) => row.providerAttempts), [1, 0, 0]);
  assert.deepEqual(rows[0]!.reconciliationScan, checkpoint);
  assert.deepEqual(await surface.db.select().from(externalDeliveryAttempts), ledger.map((attempt) => attempt.outcome === "provider_io_started"
    ? { ...attempt, outcome: "outcome_unknown", outcomeReason: "destination_deleted", terminalAt: NOW, updatedAt: NOW } : attempt));
  assert.deepEqual(rows.map((row) => row.renderSnapshot), surface.deliveries.map((row) => row.renderSnapshot));
  assert.equal(ordinaryWorkerCalls, 0); assert.equal(surface.providerCalls(), 1); assert.deepEqual(errors, []);
});

for (const receipt of ["accepted_delivery", "accepted_link"] as const) {
  test(`a deleted pair preserves the accepted local fact (${receipt})`, async () => {
    const surface = await pairControlFixture(1);
    surface.deps.dispatchProvider = async () => ({ kind: "accepted", providerMessageId: "original-accepted" });
    await surface.head();
    await surface.db.update(externalOutboundDeliveries).set({ stateReason: "original_acceptance_evidence" });
    await surface.db.update(externalDeliveryPartitions).set({ cursorPosition: 0, authorityBlockedAt: NOW,
      authorityBlockedReason: "slack_not_in_channel" });
    if (receipt === "accepted_delivery") await surface.db.delete(externalMessageLinks);
    else await surface.db.update(externalOutboundDeliveries).set({ state: "outcome_unknown", acceptedAt: null, providerMessageId: null });
    const scope = await surface.deleted();
    const result = await cleanupDeletedSlackPairHead({ db: surface.db, ...scope, now: NOW });
    assert.equal(result.kind, "cursor_recovered");
    const [row] = await surface.db.select().from(externalOutboundDeliveries);
    assert.equal(row.state, "accepted"); assert.equal(row.providerMessageId, "original-accepted"); assert.equal(row.providerAttempts, 1);
    assert.equal(row.stateReason, "original_acceptance_evidence", "cleanup preserves the original receipt reason");
    const [partition] = await surface.db.select().from(externalDeliveryPartitions);
    assert.equal(partition.cursorPosition, 1); assert.equal(partition.authorityBlockedAt, null);
  });
}

for (const evidence of ["archived", "access_error", "different_target", "revoked"] as const) {
  test(`a destination cannot be discarded without its current deletion proof (${evidence})`, async () => {
    const surface = await pairControlFixture(1);
    await surface.db.update(externalChannelBindings).set({ state: evidence === "revoked" ? "revoked" : "paused",
      stateReason: evidence === "archived" ? "provider_channel_archived" : evidence === "access_error" ? "slack_channel_not_found" : "provider_channel_deleted",
      ...(evidence === "different_target" ? { providerConversationId: "C_DIFFERENT_DESTINATION" } : {}),
    }).where(eq(externalChannelBindings.id, surface.binding.id));
    const result = await cleanupDeletedSlackPairHead({ db: surface.db, ...surface.scope, now: NOW });
    assert.equal(result.kind, "blocked");
    const [row] = await surface.db.select().from(externalOutboundDeliveries);
    assert.equal(row.state, "queued"); assert.equal(row.providerAttempts, 0);
    assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.cursorPosition, 0);
  });
}

test("a deletion cleanup respects an in-flight lease and fences its expired pre-I/O claim", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalOutboundDeliveries).set({ state: "dispatching", leaseOwner: "old-worker", leaseGeneration: 1,
    leaseOriginState: "queued", leaseExpiresAt: new Date(NOW.getTime() + 60_000) });
  const scope = await surface.deleted();
  assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...scope, now: NOW })).kind, "blocked");
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.cursorPosition, 0);
  assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...scope, now: new Date(NOW.getTime() + 61_000) })).kind, "skipped");
  const [row] = await surface.db.select().from(externalOutboundDeliveries);
  assert.equal(row.leaseGeneration, 2); assert.equal(row.leaseOwner, null); assert.equal(row.providerAttempts, 0);
});

test("a late provider response cannot resurrect work consumed by proven deletion", async () => {
  const surface = await pairControlFixture(1);
  let clock = NOW;
  surface.deps.now = () => clock;
  let entered!: () => void;
  const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
  let complete!: () => void;
  const providerResponse = new Promise<void>((resolve) => { complete = resolve; });
  surface.deps.dispatchProvider = async () => {
    entered();
    await providerResponse;
    return { kind: "accepted", providerMessageId: "late-original-receipt" };
  };
  const inFlight = surface.head();
  let ledger: typeof externalDeliveryAttempts.$inferSelect[] = [];
  try {
    await providerEntered;
    ledger = await surface.db.select().from(externalDeliveryAttempts);
    const scope = await surface.deleted();
    assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...scope, now: clock })).kind, "blocked");
    clock = new Date(NOW.getTime() + 61_000);
    assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...scope, now: clock })).kind, "skipped");
  } finally {
    complete();
    await assert.rejects(inFlight, /outcome lost exact lease authority/);
  }
  const [row] = await surface.db.select().from(externalOutboundDeliveries);
  assert.equal(row.state, "skipped");
  assert.equal(row.stateReason, "destination_deleted_outcome_unconfirmed");
  assert.equal(row.providerAttempts, 1);
  assert.equal(row.providerMessageId, null, "the expired writer cannot overwrite the recorded unknown outcome");
  assert.deepEqual(await surface.db.select().from(externalDeliveryAttempts), ledger.map((attempt) => ({
    ...attempt, outcome: "outcome_unknown", outcomeReason: "destination_deleted", terminalAt: clock, updatedAt: clock,
  })));
  assert.equal((await surface.db.select().from(externalMessageLinks)).length, 0);
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.cursorPosition, 1);
});

test("an empty current queue drops obsolete wait fields without touching consumed delivery facts", async () => {
  const surface = await pairControlFixture(1);
  surface.deps.dispatchProvider = async () => ({ kind: "accepted", providerMessageId: "sent-before-empty-cleanup" });
  await surface.head();
  await surface.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: NOW, authorityBlockedReason: "master_disabled" });
  const before = await surface.db.select().from(externalOutboundDeliveries);
  await clearEmptySlackPairWaits({ db: surface.db, bindings: [{ bindingId: surface.binding.id, bindingEpoch: 3 }], now: NOW });
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedAt, null);
  assert.deepEqual(await surface.db.select().from(externalOutboundDeliveries), before);
});


for (const blockedBy of ["runtime", "credential"] as const) {
  test(`the first real ${blockedBy} failure after maintenance starts a new wait clock`, async () => {
    const surface = await pairControlFixture(1);
    await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "master_disabled",
      now: new Date(NOW.getTime() - 3_600_000) });
    if (blockedBy === "runtime") surface.deps.resolveCurrentRuntime = async () => null;
    else surface.deps.leaseCredential = async () => null;
    const result = await surface.head();
    assert.equal(result.kind, "authority_blocked");
    if (result.kind !== "authority_blocked") assert.fail("expected a real authority wait");
    assert.equal(result.severity, "retrying");
    assert.equal(result.alert, undefined, "maintenance age cannot produce an immediate fault alert");
    const [partition] = await surface.db.select().from(externalDeliveryPartitions);
    assert.equal(partition.authorityBlockedAt?.toISOString(), NOW.toISOString());
    assert.equal(partition.authorityOverdueAlertedAt, null);
  });
}

test("a recorded legacy deletion survives a mid-cleanup replacement and drains the bounded remainder", async () => {
  const surface = await pairControlFixture(SLACK_DELETED_QUEUE_CLEANUP_BATCH_SIZE + 1);
  await surface.deleted();
  const scope = { registrationId: surface.registration.id, environment: "test" as const,
    providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId };
  const proof = await loadSlackChannelDeletionEvidence(surface.db, scope);
  assert.ok(proof, "expected recorded legacy deletion");
  assert.equal(proof.sourceKind, "legacy_binding");
  assert.equal(proof.providerEventId, null); assert.equal(proof.payloadSha256, null);
  const provider = createSlackBridgeProviderRuntime({ db: surface.db,
    credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) }), now: () => NOW,
    fetch: (async () => { throw new Error("local deletion cleanup cannot call Slack"); }) as typeof fetch });
  let normalWorkers = 0;
  const runtime = () => createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
    reconciliationKey: "control-test", now: () => NOW, workerIntervalMs: 60_000,
    runWorkerOnce: async () => { normalWorkers += 1; throw new Error("old work cannot move to the replacement"); } });
  const first = runtime(); first.start();
  try { await waitForControlState(async () => (await surface.db.select().from(externalDeliveryPartitions))[0]!.cursorPosition === SLACK_DELETED_QUEUE_CLEANUP_BATCH_SIZE); }
  finally { await first.stop(); }
  await surface.db.update(externalChannelBindings).set({ state: "revoked", stateReason: "provisioning_pair_replaced", bindingEpoch: 5 })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  await surface.db.insert(externalChannelBindings).values({ ...surface.binding, id: randomUUID(), bindingEpoch: 1,
    providerConversationId: "C_REPLACEMENT", state: "active", stateReason: null });
  assert.ok((await listSlackOutboundQueueBindings(surface.db, surface.registration.id)).some((binding) => binding.id === surface.binding.id),
    "deleted revoked bindings with unfinished work remain eligible");
  const second = runtime(); second.start();
  try { await waitForControlState(async () => (await surface.db.select().from(externalDeliveryPartitions))[0]!.cursorPosition === SLACK_DELETED_QUEUE_CLEANUP_BATCH_SIZE + 1); }
  finally { await second.stop(); await provider.stop(); }
  assert.equal(normalWorkers, 0);
  assert.ok(!(await listSlackOutboundQueueBindings(surface.db, surface.registration.id)).some((binding) => binding.id === surface.binding.id),
    "a fully consumed revoked binding is no longer scanned on every tick");
  assert.ok((await surface.db.select().from(externalOutboundDeliveries)).every((delivery) => delivery.state === "skipped"
    && delivery.stateReason === "destination_deleted" && delivery.providerAttempts === 0));
  assert.deepEqual(await loadSlackChannelDeletionEvidence(surface.db, scope), proof);
  for (const mismatch of [{ environment: "production" as const }, { providerAppId: "A_OTHER" },
    { providerAuthorityId: "T_OTHER" }, { providerConversationId: "C_OTHER" }, { registrationId: randomUUID() }]) {
    assert.equal(await loadSlackChannelDeletionEvidence(surface.db, { ...scope, ...mismatch }), null);
  }
});

test("a paused binding without a deletion fact remains unknown and cannot discard a queued message", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_deleted", bindingEpoch: 4 })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  const cleanupScope = { ...surface.scope, currentBindingEpoch: 4 };
  const [binding] = await surface.db.select().from(externalChannelBindings);
  assert.equal(binding.state, "paused"); assert.equal(binding.stateReason, "provider_channel_deleted");
  assert.deepEqual(await surface.db.select().from(slackChannelDeletions), []);
  const scope = { registrationId: surface.registration.id, environment: "test" as const,
    providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId };
  assert.equal(await loadSlackChannelDeletionEvidence(surface.db, scope), null);
  await surface.db.update(externalChannelBindings).set({ state: "revoked", stateReason: "provisioning_pair_removed" });
  assert.equal(await loadSlackChannelDeletionEvidence(surface.db, scope), null);
  assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...cleanupScope, now: NOW })).kind, "blocked");
  assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.state, "queued");
});

test("retirement backfills old paused state before outbound cleanup consumes it", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_deleted", bindingEpoch: 4 })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  const scope = { registrationId: surface.registration.id, environment: "test" as const,
    providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId };
  assert.equal(await loadSlackChannelDeletionEvidence(surface.db, scope), null);
  const directory = fileURLToPath(new URL("../../drizzle", import.meta.url));
  const journal = JSON.parse(readFileSync(`${directory}/meta/_journal.json`, "utf8")) as { entries: { tag: string }[] };
  const tag = journal.entries.find((entry) => entry.tag.endsWith("_slack_deletion_capture_retirement"))?.tag;
  assert.ok(tag);
  const statements = readFileSync(`${directory}/${tag}.sql`, "utf8").split("--> statement-breakpoint");
  await surface.db.transaction(async (tx) => {
    for (const statement of statements) if (statement.trim()) await tx.execute(sql.raw(statement));
  });
  const proof = await loadSlackChannelDeletionEvidence(surface.db, scope);
  assert.equal(proof?.sourceKind, "legacy_binding");
  assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...surface.scope, currentBindingEpoch: 4, now: NOW })).kind, "skipped");
  assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.stateReason, "destination_deleted");
});

test("archived controls retain the specific unarchive hint", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_archived" });
  await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "binding_paused", now: NOW });
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "binding_paused_archived");
});


test("a cleanup custody conflict stays visible and retries only after its cooldown", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalChannelBindings).set({ providerConversationId: "C_DIFFERENT_DESTINATION",
    state: "paused", stateReason: "provider_channel_deleted" });
  await surface.db.insert(slackChannelDeletions).values({ registrationId: surface.registration.id,
    environment: "test", providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: "C_DIFFERENT_DESTINATION", sourceInstallId: surface.install.id,
    sourceKind: "legacy_binding", sourceKey: `binding:${surface.binding.id}:3`, sourceBindingId: surface.binding.id, observedAt: NOW });
  let clock = NOW;
  let diagnostics = 0;
  const warning = vi.spyOn(console, "warn").mockImplementation((_message, metadata) => {
    if (metadata?.event === "server.slack_bridge.destination.cleaned" && metadata.outcome === "blocked") diagnostics += 1;
  });
  const provider = createSlackBridgeProviderRuntime({ db: surface.db,
    credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) }), now: () => clock,
    fetch: (async () => { throw new Error("custody conflict cannot call Slack"); }) as typeof fetch });
  const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider,
    registrationId: surface.registration.id, reconciliationKey: "control-test", now: () => clock, workerIntervalMs: 10 });
  runtime.start();
  try {
    await waitForControlState(async () => diagnostics === 1);
    const [partition] = await surface.db.select().from(externalDeliveryPartitions);
    assert.equal(partition.authorityBlockedReason, "destination_cleanup_custody_conflict");
    assert.equal(partition.authorityRetryAt?.getTime(), NOW.getTime() + 60_000);
    clock = new Date(NOW.getTime() + 10_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(diagnostics, 1, "the recorded cooldown prevents per-tick audit/query churn");
    clock = new Date(NOW.getTime() + 61_000);
    await waitForControlState(async () => diagnostics === 2);
    assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.state, "queued");
  } finally { await runtime.stop(); await provider.stop(); warning.mockRestore(); }
});


for (const previous of ["fresh", "provider_archive"] as const) {
  test(`an archived binding resumes with a fresh real-fault clock (${previous})`, async () => {
    const surface = await pairControlFixture(1);
    await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_archived" });
    const since = new Date(NOW.getTime() - 3_600_000);
    if (previous === "provider_archive") await surface.db.update(externalDeliveryPartitions).set({
      authorityBlockedAt: since, authorityBlockedReason: "slack_channel_archived", authorityOverdueAlertedAt: since });
    await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "binding_paused_archived", now: since });
    assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "binding_paused_archived");
    await surface.db.update(externalChannelBindings).set({ state: "active", stateReason: null });
    surface.deps.resolveCurrentRuntime = async () => null;
    const result = await surface.head();
    assert.equal(result.kind, "authority_blocked");
    if (result.kind !== "authority_blocked") assert.fail("expected a real fault");
    assert.equal(result.severity, "retrying"); assert.equal(result.alert, undefined);
    const [partition] = await surface.db.select().from(externalDeliveryPartitions);
    assert.equal(partition.authorityBlockedAt?.toISOString(), NOW.toISOString());
    assert.equal(partition.authorityOverdueAlertedAt, null);
  });
}

test("a provider pair failure after maintenance starts its own fault clock", async () => {
  const surface = await pairControlFixture(1);
  await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "master_disabled",
    now: new Date(NOW.getTime() - 3_600_000) });
  let posted = 0;
  surface.deps.dispatchProvider = async () => { posted += 1; return {
    kind: "deterministic_failure", reasonCode: "not_in_channel", pairBlockedReason: "slack_not_in_channel" }; };
  const result = await surface.head();
  assert.equal(result.kind, "attempted"); assert.equal(posted, 1, "exercise actual post-outcome recording");
  const [partition] = await surface.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.authorityBlockedAt?.toISOString(), NOW.toISOString());
  assert.equal(partition.authorityBlockedReason, "slack_not_in_channel");
  await clearResumedSlackPairControlWait({ db: surface.db, ...surface.scope, now: NOW });
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "slack_not_in_channel",
    "an active cached binding alone cannot erase a provider membership failure");
});

test("resuming an archive clears its stale hint before a dead head offers manual recovery", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalOutboundDeliveries).set({ state: "dead", stateReason: "failure_budget_exhausted",
    providerAttempts: 4, ambiguityBudgetProviderAttempts: 3, dispatchedFailureAttempts: 4, firstDispatchedAt: NOW });
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_archived" });
  await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "binding_paused_archived",
    now: new Date(NOW.getTime() - 3_600_000) });
  await surface.db.update(externalChannelBindings).set({ state: "active", stateReason: null });
  let complete!: () => void; let fail!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  const provider = createSlackBridgeProviderRuntime({ db: surface.db,
    credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) }), now: () => NOW,
    fetch: (async () => { throw new Error("manual head cannot call Slack"); }) as typeof fetch });
  const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
    reconciliationKey: "control-test", now: () => NOW, workerIntervalMs: 60_000,
    async runWorkerOnce(input) { try {
      const [before] = await surface.db.select().from(externalDeliveryPartitions);
      assert.equal(before.authorityBlockedReason, null, "clear the archive control before examining a terminal head");
      const result = await processExternalDeliveryPartitionHead(input);
      assert.equal(result.kind, "blocked");
      assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.state, "dead");
      complete(); return result;
    } catch (error) { fail(error); throw error; } } });
  runtime.start();
  try { await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error("resumed archive did not run")), 5_000))]); }
  finally { await runtime.stop(); await provider.stop(); }
});

test("deletion cursor recovery retains an operator skip audit label", async () => {
  const surface = await pairControlFixture(1);
  const [decision] = await surface.db.insert(externalDeliveryOperatorDecisions).values({ deliveryId: surface.deliveries[0]!.id,
    bindingId: surface.binding.id, bindingEpoch: 3, partitionPosition: 1, action: "skip", actorType: "user",
    actorId: surface.owner.id, reason: "operator-selected skip", duplicateRiskAcknowledged: false,
    dataLossAcknowledged: true, decisionRevision: 1 }).returning();
  assert.equal((await consumeExternalDeliverySkipDecision({ db: surface.db, bindingId: surface.binding.id,
    bindingEpoch: 3, decisionId: decision!.id, now: NOW })).kind, "skipped");
  await surface.db.update(externalDeliveryPartitions).set({ cursorPosition: 0 });
  const scope = await surface.deleted();
  const outcomes: string[] = [];
  const warning = vi.spyOn(console, "warn").mockImplementation((_message, metadata) => {
    if (metadata?.event === "server.slack_bridge.destination.cleaned") outcomes.push(metadata.outcome);
  });
  try { assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...scope, now: NOW })).kind, "cursor_recovered"); }
  finally { warning.mockRestore(); }
  assert.deepEqual(outcomes, ["operator_skip"]);
  assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.stateReason, "operator_audited_skip");
});

for (const attempted of [false, true]) test(`a ${attempted ? "previously attempted" : "never-attempted"} planned head can use confirmed destination deletion cleanup`, async () => {
  const surface = await fixture("public");
  const [message] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
    senderType: "user", senderId: surface.owner.id, content: "planned missing file", messageType: "chat", createdAt: NOW }).returning();
  const [object] = await surface.db.insert(attachmentObjects).values({ originServerId: surface.server.id,
    uploaderId: surface.owner.id, uploaderType: "user", storageKey: `${surface.server.id}/missing-cleanup`,
    contentHash: "a".repeat(64), mimeType: "text/plain", sizeBytes: 4 }).returning();
  await surface.db.insert(attachments).values({ objectId: object.id, messageId: message.id,
    messagePosition: 0, channelId: surface.channel.id, uploaderId: surface.owner.id,
    uploaderType: "user", filename: "missing.txt" });
  const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch, expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user", senderId: surface.owner.id, now: NOW, registrationId: surface.registration.id });
  assert.ok(active);
  const queued = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message,
    activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
      runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral },
    canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
    authorName: surface.owner.name, sanitizedText: message.content,
    mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("plan-cleanup", deliveryId) }));
  const snapshot = queued.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  const storage: StorageBackend = { async put() {}, async delete() {}, async get() { throw new Error("unused"); },
    async probeObjectPresence() { return "missing"; } };
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan({ db: surface.db, deliveryId: queued.delivery.id,
    bindingId: queued.delivery.bindingId, bindingEpoch: queued.delivery.bindingEpoch, snapshot, storage,
    now: () => NOW, assertWriterFleetFenced: async () => true }), { kind: "planned", revision: 1 });
  if (attempted) {
    await surface.db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('slock.attachment_plan', '1', true)`);
      await tx.update(externalOutboundDeliveries).set({ state: "outcome_unknown", providerAttempts: 1,
        firstDispatchedAt: NOW, updatedAt: NOW }).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
      await tx.insert(externalDeliveryAttempts).values({ deliveryId: queued.delivery.id, attemptNumber: 1,
        leaseGeneration: 1, runtimeRevision: "runtime-r1", credentialRevision: 1,
        dispatchAuthorization: "automatic", providerIoStartedAt: NOW });
    });
  }
  const denied = () => surface.db.update(externalOutboundDeliveries).set({ state: "skipped", stateReason: attempted ? "destination_deleted_outcome_unconfirmed" : "destination_deleted",
    leaseGeneration: 2, updatedAt: NOW }).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  await assert.rejects(denied(), "without confirmed deletion an old writer cannot skip a planned head");
  await surface.db.insert(slackChannelDeletions).values({ registrationId: surface.registration.id,
    environment: "test", providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: "C_OTHER", sourceInstallId: surface.install.id, sourceKind: "legacy_binding",
    sourceKey: "wrong-channel", sourceBindingId: surface.binding.id, observedAt: NOW });
  await assert.rejects(denied(), "another channel's deletion cannot authorize a skip");
  const recorded = await recordVerifiedSlackChannelDeletion({ registrationId: surface.registration.id,
    environment: "test", providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, providerEventId: `Ev_DELETE_${randomUUID()}`,
    providerEventType: "channel_deleted", signingSecretRevision: 1, payloadSha256: "a".repeat(64), now: NOW });
  assert.ok(recorded?.paused);
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ state: "skipped", stateReason: attempted ? "destination_deleted_outcome_unconfirmed" : "destination_deleted",
    leaseGeneration: 2, renderSnapshotDigest: "b".repeat(64), updatedAt: NOW })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id)), "deletion may not rewrite the frozen snapshot");
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ stateReason: "legacy-claim" })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id)), "deletion evidence must not unblock a legacy send");
  if (attempted) {
    const [accepted] = await surface.db.insert(externalMessageLinks).values({
      deliveryId: queued.delivery.id, provider: "slack", installId: surface.install.id,
      providerAuthorityId: surface.install.providerAuthorityId, providerConversationId: surface.binding.providerConversationId,
      providerMessageId: "1700000000.000001", bindingId: queued.delivery.bindingId,
      bindingEpoch: queued.delivery.bindingEpoch, connectionEpoch: surface.binding.connectionEpoch,
      raftMessageId: message.id, firstDirection: "raft_outbound", payloadFingerprint: queued.delivery.renderSnapshotDigest,
      outcomeState: "accepted", authorityState: "active",
    }).returning();
    await assert.rejects(denied(), "an accepted receipt must never be discarded as unknown");
    await surface.db.delete(externalMessageLinks).where(eq(externalMessageLinks.id, accepted.id));
  }
  const [currentBinding] = await surface.db.select().from(externalChannelBindings).where(eq(externalChannelBindings.id, surface.binding.id));
  const cleanup = () => cleanupDeletedSlackPairHead({ db: surface.db, registrationId: surface.registration.id,
    currentBindingId: currentBinding.id, currentBindingEpoch: currentBinding.bindingEpoch,
    bindingId: queued.delivery.bindingId, bindingEpoch: queued.delivery.bindingEpoch, now: NOW });
  const realPgUrl = process.env.CARDY_W3_REAL_PG_URL;
  if (realPgUrl) {
    const holder = new pg.Client({ connectionString: realPgUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM external_outbound_deliveries WHERE id = $1 FOR UPDATE", [queued.delivery.id]);
      assert.equal((await cleanup()).kind, "empty", "a locked head cannot be skipped or passed");
      const [whileLocked] = await surface.db.select().from(externalDeliveryPartitions)
        .where(eq(externalDeliveryPartitions.bindingId, queued.delivery.bindingId));
      assert.equal(whileLocked.cursorPosition, 0);
      await holder.query("COMMIT");
      assert.equal((await cleanup()).kind, "skipped");
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  } else {
    assert.equal((await cleanup()).kind, "skipped");
  }
  const [settled] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal(settled.stateReason, attempted ? "destination_deleted_outcome_unconfirmed" : "destination_deleted");
  assert.equal(settled.providerAttempts, attempted ? 1 : 0);
  if (attempted) {
    const attempts = await surface.db.select().from(externalDeliveryAttempts)
      .where(eq(externalDeliveryAttempts.deliveryId, queued.delivery.id));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.outcome, "outcome_unknown");
    assert.equal(attempts[0]!.outcomeReason, "destination_deleted");
  }
  const [partition] = await surface.db.select().from(externalDeliveryPartitions)
    .where(eq(externalDeliveryPartitions.bindingId, queued.delivery.bindingId));
  assert.equal(partition.cursorPosition, queued.delivery.partitionPosition);
});

for (const receipt of ["delivery", "link"] as const) test(`planned accepted ${receipt} survives deleted destination cleanup`, async () => {
  const surface = await fixture("public");
  const [message] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
    senderType: "user", senderId: surface.owner.id, content: "planned missing file", messageType: "chat", createdAt: NOW }).returning();
  const [object] = await surface.db.insert(attachmentObjects).values({ originServerId: surface.server.id,
    uploaderId: surface.owner.id, uploaderType: "user", storageKey: `${surface.server.id}/missing-cleanup`,
    contentHash: "a".repeat(64), mimeType: "text/plain", sizeBytes: 4 }).returning();
  await surface.db.insert(attachments).values({ objectId: object.id, messageId: message.id,
    messagePosition: 0, channelId: surface.channel.id, uploaderId: surface.owner.id,
    uploaderType: "user", filename: "missing.txt" });
  const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch, expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user", senderId: surface.owner.id, now: NOW, registrationId: surface.registration.id });
  assert.ok(active);
  const queued = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message,
    activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
      runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral },
    canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
    authorName: surface.owner.name, sanitizedText: message.content,
    mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("plan-cleanup", deliveryId) }));
  const snapshot = queued.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  const storage: StorageBackend = { async put() {}, async delete() {}, async get() { throw new Error("unused"); },
    async probeObjectPresence() { return "missing"; } };
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan({ db: surface.db, deliveryId: queued.delivery.id,
    bindingId: queued.delivery.bindingId, bindingEpoch: queued.delivery.bindingEpoch, snapshot, storage,
    now: () => NOW, assertWriterFleetFenced: async () => true }), { kind: "planned", revision: 1 });
  const acceptedTs = "1700000000.000001";
  await surface.db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ state: receipt === "delivery" ? "accepted" : "outcome_unknown",
      providerAttempts: 1, firstDispatchedAt: NOW,
      providerMessageId: receipt === "delivery" ? acceptedTs : null,
      acceptedAt: receipt === "delivery" ? NOW : null, stateReason: "original_reason", updatedAt: NOW,
    }).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
    await tx.insert(externalDeliveryAttempts).values({ deliveryId: queued.delivery.id, attemptNumber: 1,
      leaseGeneration: 1, runtimeRevision: "runtime-r1", credentialRevision: 1,
      dispatchAuthorization: "automatic", providerIoStartedAt: NOW });
  });
  if (receipt === "link") {
    await surface.db.insert(externalMessageLinks).values({ deliveryId: queued.delivery.id,
      provider: "slack", installId: surface.install.id, providerAuthorityId: surface.install.providerAuthorityId,
      providerConversationId: surface.binding.providerConversationId, providerMessageId: acceptedTs,
      bindingId: queued.delivery.bindingId, bindingEpoch: queued.delivery.bindingEpoch,
      connectionEpoch: surface.binding.connectionEpoch, raftMessageId: message.id,
      raftCanonicalRootMessageId: snapshot.canonicalRootMessageId,
      firstDirection: "raft_outbound", payloadFingerprint: queued.delivery.renderSnapshotDigest,
      outcomeState: "accepted", authorityState: "active" });
  }
  const promote = (id: string) => surface.db.update(externalOutboundDeliveries).set({ state: "accepted",
    providerMessageId: id, acceptedAt: NOW, nextAttemptAt: null, leaseGeneration: 2, updatedAt: NOW,
  }).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  await assert.rejects(promote(acceptedTs), "accepted cursor recovery requires deletion evidence");
  const recorded = await recordVerifiedSlackChannelDeletion({ registrationId: surface.registration.id,
    environment: "test", providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, providerEventId: `Ev_DELETE_${randomUUID()}`,
    providerEventType: "channel_deleted", signingSecretRevision: 1, payloadSha256: "a".repeat(64), now: NOW });
  assert.ok(recorded?.paused);
  await assert.rejects(promote("1700000000.000099"), "cleanup must not change or invent the accepted receipt");
  if (receipt === "link") {
    await surface.db.update(externalMessageLinks).set({ payloadFingerprint: "b".repeat(64) })
      .where(eq(externalMessageLinks.deliveryId, queued.delivery.id));
    await assert.rejects(promote(acceptedTs), "a receipt with a different frozen payload is not proof");
    await surface.db.update(externalMessageLinks).set({ payloadFingerprint: queued.delivery.renderSnapshotDigest })
      .where(eq(externalMessageLinks.deliveryId, queued.delivery.id));
  }
  const [currentBinding] = await surface.db.select().from(externalChannelBindings).where(eq(externalChannelBindings.id, surface.binding.id));
  const result = await cleanupDeletedSlackPairHead({ db: surface.db, registrationId: surface.registration.id,
    currentBindingId: currentBinding.id, currentBindingEpoch: currentBinding.bindingEpoch,
    bindingId: queued.delivery.bindingId, bindingEpoch: queued.delivery.bindingEpoch, now: NOW });
  assert.equal(result.kind, "cursor_recovered");
  const [settled] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal(settled.state, "accepted"); assert.equal(settled.providerMessageId, acceptedTs);
  assert.equal(settled.providerAttempts, 1); assert.equal(settled.stateReason, "original_reason");
  const [partition] = await surface.db.select().from(externalDeliveryPartitions)
    .where(eq(externalDeliveryPartitions.bindingId, queued.delivery.bindingId));
  assert.equal(partition.cursorPosition, queued.delivery.partitionPosition);
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

for (const scenario of [
  { missingCount: 0, hashless: false, unknown: false, deploymentRepair: true },
  { missingCount: 0, hashless: false, unknown: false, planningOff: true, resetUploadOnce: true },
  { missingCount: 0, hashless: false, unknown: false, planningOff: true, slowRead: true },
  { missingCount: 0, hashless: false, unknown: false, planningOff: true, slowUpload: true },
  { missingCount: 0, hashless: false, unknown: false, slowUpload: true },
  { missingCount: 0, hashless: false, unknown: false, corruptSource: true },
  { missingCount: 0, hashless: false, unknown: false },
  { missingCount: 0, hashless: false, unknown: false, ticketDeniedOnce: true },
  { missingCount: 0, hashless: false, unknown: false, emptyBody: true },
  { missingCount: 2, hashless: false, unknown: false, emptyBody: true },
  { missingCount: 1, hashless: false, unknown: false, transient: false, missingLast: false },
  { missingCount: 1, hashless: false, unknown: false, transient: true, missingLast: false },
  { missingCount: 1, hashless: false, unknown: false, transient: false, missingLast: true },
  { missingCount: 2, hashless: false, unknown: false },
  { missingCount: 1, hashless: true, unknown: false },
  { missingCount: 2, hashless: true, unknown: true },
  { missingCount: 1, hashless: false, unknown: true },
  { missingCount: 1, hashless: false, unknown: true, rebind: true, senderLeft: true },
]) test(`W3 actual runtime preserves body and fixed transport ${JSON.stringify(scenario)}`, async () => {
  const surface = await fixture("public");
  let author = surface.owner;
  if (scenario.senderLeft) {
    const [member] = await surface.db.insert(users).values({ email: `w3-sender-${randomUUID()}@test.invalid`,
      name: `w3-sender-${randomUUID()}`, passwordHash: "synthetic" }).returning();
    author = member!;
    await surface.db.insert(serverMembers).values({ serverId: surface.server.id, userId: author.id, role: "member" });
  }
  let clock = new Date();
  const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 31) });
  const sealed = await cipher.sealer.seal({ serverId: surface.server.id, accessToken: "synthetic-token",
    tokenType: "bot", providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!,
    botUserId: surface.install.botUserId!, now: clock });
  await surface.db.update(externalAppCredentials).set({ encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion }).where(eq(externalAppCredentials.installId, surface.install.id));
  const [priorRollout] = await surface.db.select().from(slackAttachmentPlanRollout);
  const configGeneration = (priorRollout?.configGeneration ?? 0) + 1;
  let deploymentConfig = parseSlackAttachmentFallbackDeployment({ SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED: scenario.planningOff ? "false" : "true",
    SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION: String(configGeneration), SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_RELEASE: "a".repeat(40), SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_BY: "@test-verifier" });
  assert.ok(deploymentConfig);
  if (scenario.deploymentRepair) await surface.db.execute(sql`alter table external_attachment_transfer_jobs disable trigger slack_attachment_plan_job_write_fence`);
  const [message, following] = await surface.db.insert(messages).values([
    { channelId: surface.channel.id, senderType: "user", senderId: author.id, content: scenario.emptyBody ? "" : "caption & <preserve>", messageType: "chat" },
    { channelId: surface.channel.id, senderType: "user", senderId: author.id, content: "following continues", messageType: "chat" },
  ]).returning();
  const bodies = [Buffer.from("missing-or-first"), Buffer.from("second-file")];
  const missing = new Set<string>();
  for (const [position, body] of bodies.entries()) {
    const [object] = await surface.db.insert(attachmentObjects).values({ originServerId: surface.server.id,
      uploaderId: surface.owner.id, uploaderType: "user", storageKey: `${surface.server.id}/w3-${position}`,
      contentHash: scenario.hashless ? null : createHash("sha256").update(body).digest("hex"),
      mimeType: "text/plain", sizeBytes: body.length }).returning();
    if (scenario.missingLast ? position === 1 : position < scenario.missingCount) missing.add(object.storageKey);
    await surface.db.insert(attachments).values({ objectId: object.id, messageId: message!.id, messagePosition: position,
      channelId: surface.channel.id, uploaderId: surface.owner.id, uploaderType: "user", filename: `w3-${position}.txt` });
  }
  let unavailable = scenario.transient ?? false;
  let sourceReadsAfterFirstPublication = 0;
  let published = false;
  let delayedSource = false;
  let corruptSource = scenario.corruptSource ?? false;
  __setStorageForTests({ async put() {}, async delete() {},
    async get(key) {
      if (published) sourceReadsAfterFirstPublication++;
      if (unavailable || missing.has(key)) throw new Error("synthetic source unavailable");
      const body = bodies[key.endsWith("-0") ? 0 : 1]!;
      if (corruptSource) return Readable.from(Buffer.alloc(body.length, 1));
      if (!delayedSource && (scenario.slowRead || scenario.slowUpload)) {
        delayedSource = true;
        if (scenario.slowRead) clock = new Date(clock.getTime() + 61_000);
        else return Readable.from((async function* () {
          const start = clock.getTime();
          clock = new Date(start + 4 * 60_000);
          yield body.subarray(0, 1);
          // Do not move the injected clock until the consumer has actually
          // processed the first chunk; Readable may prefetch the next chunk.
          await waitForControlState(async () => (await surface.db.select().from(externalAttachmentTransferJobs))
            .some(job => job.leaseExpiresAt && job.leaseExpiresAt.getTime() > start + 5 * 60_000));
          clock = new Date(start + 6 * 60_000);
          yield body.subarray(1);
        })(), { highWaterMark: 1 });
      }
      return Readable.from(body);
    },
    async probeObjectPresence(key) { if (unavailable) throw new Error("temporary failure"); return missing.has(key) ? "missing" : "present"; },
  });
  const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch, expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user", senderId: author.id, now: clock, registrationId: surface.registration.id });
  assert.ok(active);
  const queued: Awaited<ReturnType<typeof enqueueSlackBridgeOutboundDelivery>>[] = [];
  for (const source of [message!, following!]) queued.push(await surface.db.transaction(executor => enqueueSlackBridgeOutboundDelivery({
    executor, message: source, activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
      runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral }, canonicalConversationId: surface.channel.id,
    senderType: "user", senderId: author.id, authorName: author.name, sanitizedText: source.content,
    mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("w3-actual-runtime", deliveryId),
  })));
  clock = new Date(Date.now() + 1_000); // All inserted jobs must be due at the first tick.
  const expectedCaption = scenario.missingCount === 0 ? (scenario.emptyBody ? "" : "caption &amp; &lt;preserve&gt;")
    : scenario.emptyBody ? "[One or more attachments unavailable]" : "caption &amp; &lt;preserve&gt;\n\n[One or more attachments unavailable]";
  const sentTexts: string[] = [];
  const completedFileSets: string[][] = [];
  let lastTextBody: Record<string, unknown> | undefined;
  let firstFileHistory = true;
  let publications = 0;
  let deniedTicket = false;
  let uploads = 0;
  let publicationTs = "";
  const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: cipher, now: () => clock,
    fetch: (async (urlInput, init) => {
      const url = new URL(String(urlInput));
      let response: Record<string, unknown>;
      if (url.hostname === "files.slack.com") {
        uploads++; await new Response(init?.body).arrayBuffer();
        if (scenario.resetUploadOnce && uploads === 1) throw new Error("synthetic upload connection reset");
        return new Response("OK");
      }
      const method = url.pathname.split("/").at(-1);
      if (method === "files.getUploadURLExternal") {
        if (scenario.ticketDeniedOnce && !deniedTicket) {
          deniedTicket = true;
          const [before] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, queued[0]!.delivery.id));
          assert.equal(before.providerAttempts, 0, "private permission failures do not spend publication attempts");
          return new Response(JSON.stringify({ ok: false, error: "missing_scope" }));
        }
        const filename = url.searchParams.get("filename") ?? (JSON.parse(String(init?.body)) as { filename: string }).filename;
        response = { ok: true, file_id: `F_${filename.replace(/[^A-Za-z0-9]/g, "")}`,
          upload_url: "https://files.slack.com/upload/synthetic" };
      } else if (method === "files.completeUploadExternal") {
        const body = JSON.parse(String(init?.body)) as { files: Array<{ id: string }>; initial_comment: string };
        assert.equal(body.initial_comment ?? "", expectedCaption);
        completedFileSets.push(body.files.map(file => file.id)); publications++; published = true;
        publicationTs = (clock.getTime() / 1000).toFixed(6);
        response = { ok: true, files: body.files };
      } else if (method === "chat.postMessage") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentTexts.push(String(body.text));
        if (sentTexts.length === 1 && scenario.missingCount === 2) {
          assert.equal(body.text, expectedCaption); publications++; published = true; lastTextBody = body;
          publicationTs = (clock.getTime() / 1000).toFixed(6);
          if (scenario.unknown) { unavailable = true; throw new Error("response lost after accepted"); }
        }
        response = { ok: true, channel: "C_RUNTIME_TEST", ts: body.text === expectedCaption ? publicationTs : (clock.getTime() / 1000).toFixed(6) };
      } else if (method === "conversations.history") {
        if (scenario.missingCount === 2) {
          response = { ok: true, has_more: false, messages: lastTextBody ? [{ ts: publicationTs, user: "U_RUNTIME_BOT",
            bot_id: "B_RUNTIME_BOT", app_id: "A_RUNTIME_TEST", metadata: lastTextBody.metadata }] : [] };
        } else {
          const pending = scenario.unknown && firstFileHistory; firstFileHistory = false;
          if (pending) unavailable = true;
          response = { ok: true, has_more: false, messages: pending ? [] : [{ ts: publicationTs, subtype: "file_share",
            files: completedFileSets[0]!.map(id => ({ id })) }] };
        }
      } else throw new Error(`unexpected method ${method}`);
      return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  let firstInput!: Parameters<typeof processExternalDeliveryPartitionHead>[0];
  let observedTicks = 0;
  const errors: unknown[] = [];
  const recoveries: unknown[][] = [];
  const originalInfo = console.info;
  if (scenario.deploymentRepair) console.info = (...args: unknown[]) => {
    if (args[0] === "[SlackBridge] attachment deployment configuration recovered") recoveries.push(args);
    else originalInfo(...args);
  };
  let runtime: ReturnType<typeof createSlackBridgeDatabaseOutboundRuntime>;
  const startRuntime = async (restarted: boolean) => {
    let captured = false;
    runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, reconciliationKey: "w3-actual-runtime",
      attachmentFallbackDeployment: deploymentConfig,
      workerLeaseOwner: restarted ? "restarted-w3-worker" : "first-w3-worker",
      registrationId: surface.registration.id, now: () => clock, workerIntervalMs: scenario.deploymentRepair ? 20 : 60_000, onError: error => errors.push(error),
      async runWorkerOnce(input) {
        if (input.bindingId === queued[0]!.delivery.bindingId && input.bindingEpoch === queued[0]!.delivery.bindingEpoch) {
          firstInput = input; captured = true; observedTicks++;
        }
        return { kind: "empty" };
      },
    });
    runtime.start(); await waitForControlState(async () => captured);
  };
  try {
    await startRuntime(false);
    if (scenario.deploymentRepair) {
      await waitForControlState(async () => observedTicks >= 3);
      assert.equal(errors.length, 1, "persistent control failure is reported once while normal ticks continue");
      clock = new Date(clock.getTime() + 60_001);
      await waitForControlState(async () => errors.length === 2);
      await surface.db.execute(sql`CREATE FUNCTION test_reject_attachment_control() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'synthetic rollout denied'; END $$`);
      await surface.db.execute(sql`CREATE TRIGGER test_reject_attachment_control BEFORE UPDATE ON slack_attachment_plan_rollout
        FOR EACH ROW EXECUTE FUNCTION test_reject_attachment_control()`);
      await waitForControlState(async () => errors.length === 3);
      const before = observedTicks;
      clock = new Date(clock.getTime() + 1); // Outer query parameters change; the underlying failure stays the same.
      await waitForControlState(async () => observedTicks >= before + 2);
      assert.equal(errors.length, 3, "a new failure reports immediately but timestamped wrapper changes do not spam");
    }
    const originalPrepare = firstInput.dependencies!.prepareProvider!;
    firstInput.dependencies!.prepareProvider = async request => {
      try { return await originalPrepare(request); }
      catch (error) { errors.push(error); throw error; }
    };
    let accepted = false;
    let restarted = false;
    const steps: unknown[] = [];
    for (let turn = 0; turn < 80; turn++) {
      const step = await processExternalDeliveryPartitionHead(firstInput);
      if (steps.length < 12) steps.push(step);
      if (scenario.deploymentRepair && turn === 0) {
        assert.ok(errors.length >= 1, "the failed control update is reported");
        assert.equal((await surface.db.select().from(slackAttachmentPlanRollout)).length, 0, "the failed activation rolled back");
        assert.ok(publications >= 1, "ordinary publication continues before the control is repaired");
        await surface.db.execute(sql`DROP TRIGGER test_reject_attachment_control ON slack_attachment_plan_rollout`);
        await surface.db.execute(sql`DROP FUNCTION test_reject_attachment_control()`);
        await surface.db.execute(sql`alter table external_attachment_transfer_jobs enable trigger slack_attachment_plan_job_write_fence`);
        await waitForControlState(async () => (await surface.db.select().from(slackAttachmentPlanRollout))[0]?.enabled === true);
        await waitForControlState(async () => recoveries.length === 1);
        assert.deepEqual(recoveries[0], ["[SlackBridge] attachment deployment configuration recovered", { generation: configGeneration, outcome: "applied" }]);
      }
      if (scenario.unknown && !restarted && step.kind === "attempted" && step.deliveryState === "outcome_unknown") {
        await runtime!.stop();
        if (scenario.rebind) await reauthorizeSamePair(surface);
        if (scenario.senderLeft) await surface.db.delete(serverMembers).where(and(
          eq(serverMembers.serverId, surface.server.id), eq(serverMembers.userId, author.id),
        ));
        deploymentConfig = parseSlackAttachmentFallbackDeployment({ SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED: "false",
          SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION: String(configGeneration + 1) });
        assert.ok(deploymentConfig);
        __setStorageForTests(null); // Receipt recovery must not require even a configured source backend.
        await startRuntime(true); restarted = true;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
      if (scenario.slowUpload || scenario.corruptSource) {
        await waitForControlState(async () => (await surface.db.select().from(externalAttachmentTransferJobs))
          .every(job => job.state !== "leased"));
      }
      clock = new Date(clock.getTime() + 31_000);
      if (scenario.corruptSource && turn === 3) {
        const [held] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, queued[0]!.delivery.id));
        assert.equal(uploads, 0, "known digest mismatch is detected before any private upload");
        assert.equal(held.providerAttempts, 0);
        assert.equal(held.stateReason, "attachment_source_digest_mismatch");
        const [job] = await surface.db.select().from(externalAttachmentTransferJobs)
          .where(eq(externalAttachmentTransferJobs.outboundDeliveryId, held.id)).orderBy(externalAttachmentTransferJobs.createdAt);
        assert.ok(job.attempts >= 2);
        assert.ok(job.nextAttemptAt.getTime() - job.updatedAt.getTime() >= 60_000, "repeated private failures back off");
        corruptSource = false;
      }
      if (scenario.transient && unavailable && turn >= 3) {
        const [held] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, queued[0]!.delivery.id));
        assert.equal(held.providerAttempts, 0, "temporary storage errors cannot spend publication budget");
        assert.equal((await surface.db.select().from(slackAttachmentFallbackPlans)).length, 0, "temporary failures prove no omission");
        // Filesystem staging is asynchronous: restore storage only after the
        // actual queue head exposes the warning, never after a fixed sleep.
        if (held.stateReason === "attachment_source_read_failed") unavailable = false;
      }
      const rows = await surface.db.select().from(externalOutboundDeliveries)
        .where(eq(externalOutboundDeliveries.bindingId, surface.binding.id));
      if (rows.length === 2 && rows.every(row => row.state === "accepted")) { accepted = true; break; }
    }
    if (scenario.deploymentRepair) assert.ok(errors.every(error => error instanceof Error && (/database protocol/.test(error.message)
      || (error.cause instanceof Error && error.cause.message === "synthetic rollout denied"))));
    else assert.deepEqual(errors.map(error => error instanceof Error ? error.message : String(error)), []);
    assert.equal(accepted, true, `both messages must be accepted: ${JSON.stringify({steps,jobs:await surface.db.select().from(externalAttachmentTransferJobs),plans:await surface.db.select().from(slackAttachmentFallbackPlans)})}`);
    assert.equal(restarted, scenario.unknown);
    assert.equal(deniedTicket, scenario.ticketDeniedOnce ?? false);
    assert.equal(publications, 1, "a missing response or restart must not publish a second message");
    assert.equal(sourceReadsAfterFirstPublication, 0, "reconciliation never reads vanished sources");
    assert.equal(completedFileSets.length, scenario.missingCount === 2 ? 0 : 1);
    if (completedFileSets.length) assert.equal(completedFileSets[0]!.length, 2 - scenario.missingCount);
    assert.equal(uploads, 2 - scenario.missingCount, "retained private uploads are reused across plan creation and recovery");
    assert.equal(sentTexts.at(-1), "following continues");
    const [delivery] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, queued[0]!.delivery.id));
    assert.equal(delivery.providerAttempts, scenario.resetUploadOnce ? 2 : 1, "private preparation/source failures do not consume publication attempts");
    assert.deepEqual(delivery.renderSnapshot, queued[0]!.delivery.renderSnapshot, "original snapshot stays immutable");
    const transferJobs = await surface.db.select().from(externalAttachmentTransferJobs).where(eq(externalAttachmentTransferJobs.outboundDeliveryId, delivery.id));
    assert.equal(transferJobs.filter(job => job.state === "failed" && job.lastErrorClass === "attachment_source_missing_omitted").length, scenario.missingCount);
    assert.equal(transferJobs.filter(job => job.state === "completed").length, 2 - scenario.missingCount);
  } finally {
    try { await runtime!.stop(); }
    finally { console.info = originalInfo; }
  }
});

test("W3 planning is default-off and requires durable fleet evidence and both writer fences", async () => {
  const surface = await fixture("public");
  const { isSlackAttachmentPlanningEnabled } = await import("./slackAttachmentFallbackProtocol");
  assert.equal(await isSlackAttachmentPlanningEnabled(surface.db), false);
  await assert.rejects(surface.db.insert(slackAttachmentPlanRollout).values({ id: "slack-attachment-plan-v1",
    enabled: true, minimumWriterVersion: 1, verifiedAt: NOW }), "null release/operator cannot attest a fleet");
  await surface.db.insert(slackAttachmentPlanRollout).values({ id: "slack-attachment-plan-v1", enabled: true,
    minimumWriterVersion: 1, verifiedRelease: "a".repeat(40), verifiedBy: "synthetic-operator", verifiedAt: NOW });
  assert.equal(await isSlackAttachmentPlanningEnabled(surface.db), true);
  await surface.db.execute(sql`alter table external_attachment_transfer_jobs disable trigger slack_attachment_plan_job_write_fence`);
  assert.equal(await isSlackAttachmentPlanningEnabled(surface.db), false, "a named control cannot replace the actual old-writer barrier");
  await surface.db.execute(sql`alter table external_attachment_transfer_jobs enable trigger slack_attachment_plan_job_write_fence`);
  assert.equal(await isSlackAttachmentPlanningEnabled(surface.db), true);
  await surface.db.update(slackAttachmentPlanRollout).set({ enabled: false });
  assert.equal(await isSlackAttachmentPlanningEnabled(surface.db), false);
  await assert.rejects(surface.db.update(slackAttachmentPlanRollout).set({ minimumWriterVersion: 0 }));
  await assert.rejects(surface.db.delete(slackAttachmentPlanRollout), "pause does not release the rollback floor");
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
