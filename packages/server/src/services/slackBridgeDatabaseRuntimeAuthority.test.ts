import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import sharp from "sharp";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import {
  channels,
  externalProjectionAvatarArtifacts,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstalls,
  externalAppManifestReceipts,
  externalAppRegistrations,
  externalAppRegistrationSecrets,
  externalAppServerGrants,
  externalAuthorPolicies,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalHumanIdentityLinks,
  featureFlags,
  jointChannels,
  jointChannelServers,
  oauthClientInstalls,
  oauthClients,
  users,
} from "../db/schema.js";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService.js";
import {
  createSlackBridgeDatabaseOutboundRuntime,
  resolveCurrentOutboundAuthority,
} from "./slackBridgeDatabaseOutboundRuntime.js";
import type { SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService.js";
import type { SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime.js";
import { createFeatureFlagRule, deleteFeatureFlagRule, updateFeatureFlag } from "./featureFlagService.js";
import { createServer } from "./serverService.js";
import {
  createSlackDatabaseAuthorPolicyAuthorityResolver,
  createSlackDatabaseAudienceIdentityAuthority,
  createSlackDatabaseInboundWorkerRuntimeResolver,
  createSlackDatabaseIngressRuntimeResolver,
  slackBridgeDatabaseRuntimeRevision,
} from "./slackBridgeDatabaseRuntimeAuthority.js";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "./slackBridgeProductionAppContract.js";
import { slackBridgeInstallGrantHash } from "./slackBridgeInstallGrantService.js";

import { refreshSlackPublicConversationAuthority, type SlackBridgeAvatarMaterializer } from "./slackBridgeProvisioningControlPlane.js";
import { materializeExternalProjectionAvatar } from "./externalAvatarMaterializerService.js";
import { __setCdnStorageForTests, resetStorageForTests, type StorageBackend } from "./storageService.js";
import { externalAvatarPublicRouter } from "../routes/externalAvatars.js";

const NOW = new Date("2026-08-11T08:00:00.000Z");
const EXPIRES = new Date("2027-08-11T08:00:00.000Z");

afterEach(async () => {
  resetStorageForTests();
  await closeTestDatabase();
});

async function fixture(privacyClass: "public" | "private" = "private") {
  await openTestDatabase("pglite://");
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
  assert.equal(await ingress.resolveCurrentRuntime({
    authority: surface.authority,
    projectionId: surface.projection.id,
    actorProjectionRevision: 4,
    externalActorId: "U_RUNTIME_HUMAN",
    memberRevision: 5,
    contextRevision: 6,
    requiredCapabilities: ["attachment_transfer"],
    now: NOW,
  }), null, "attachment ingress remains closed while its child fuse is absent/off");
  await createFeatureFlagRule({
    flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
    stage: "server",
    decision: "allow",
    values: [surface.server.id],
  });
  assert.deepEqual(await ingress.resolveCurrentRuntime({
    authority: surface.authority,
    projectionId: surface.projection.id,
    actorProjectionRevision: 4,
    externalActorId: "U_RUNTIME_HUMAN",
    memberRevision: 5,
    contextRevision: 6,
    requiredCapabilities: ["attachment_transfer"],
    now: NOW,
  }), runtime, "attachment ingress opens only for the explicitly allowed server");
  assert.equal(await ingress.resolveCurrentRuntime({
    authority: surface.authority,
    projectionId: surface.projection.id,
    actorProjectionRevision: 4,
    externalActorId: "U_RUNTIME_HUMAN",
    memberRevision: 5,
    contextRevision: 6,
    requiredCapabilities: ["reaction_sync"],
    now: NOW,
  }), null, "reaction ingress remains closed while its seeded child fuse has no allow rule");
  const [reactionFlag] = await surface.db.select().from(featureFlags)
    .where(eq(featureFlags.key, SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync));
  assert.equal(reactionFlag?.enabled, true);
  assert.equal(reactionFlag?.defaultEnabled, false);
  assert.equal(reactionFlag?.killSwitch, false);
  assert.equal(reactionFlag?.randomizationUnit, "server");
  assert.ok(await updateFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync, { enabled: true }));
  await createFeatureFlagRule({
    flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync,
    stage: "server",
    decision: "allow",
    values: [surface.server.id],
  });
  assert.deepEqual(await ingress.resolveCurrentRuntime({
    authority: surface.authority,
    projectionId: surface.projection.id,
    actorProjectionRevision: 4,
    externalActorId: "U_RUNTIME_HUMAN",
    memberRevision: 5,
    contextRevision: 6,
    requiredCapabilities: ["reaction_sync"],
    now: NOW,
  }), runtime, "reaction ingress opens only after canonical flag update and explicit server allow");

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
  assert.deepEqual(await resolveWorker({ eventId: "event-runtime", frozenAuthority: frozen }), frozen);
  assert.equal(await resolveWorker({
    eventId: "event-runtime",
    frozenAuthority: { ...frozen, workspaceId: "T_SUBSTITUTED" },
  }), null, "workspace identity is independent frozen authority");

  const resolveAuthor = createSlackDatabaseAuthorPolicyAuthorityResolver(surface.db);
  assert.deepEqual(await resolveAuthor({
    serverId: surface.server.id,
    bindingId: surface.binding.id,
    now: NOW,
  }), {
    provider: "slack",
    registrationId: surface.authority.registrationId,
    installId: surface.authority.installId,
    bindingId: surface.authority.bindingId,
    bindingEpoch: 3,
    consentRevision: 3,
  });
});

test("outbound worker keeps the frozen matched audience revision across a newer refresh", async () => {
  const surface = await fixture("private");
  await surface.db.insert(externalAuthorPolicies).values({
    serverId: surface.server.id,
    provider: "slack",
    appRegistrationId: surface.registration.id,
    installId: surface.install.id,
    bindingId: surface.binding.id,
    bindingEpoch: surface.binding.bindingEpoch,
    authorType: "user",
    authorId: surface.owner.id,
    displayName: "Slack Runtime Owner",
    fallbackKind: "human",
    consentRevision: 1,
    state: "granted",
  });

  const frozen = await resolveCurrentOutboundAuthority({
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

  const refreshedLatest = await resolveCurrentOutboundAuthority({
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

  const stillCurrentFrozen = await resolveCurrentOutboundAuthority({
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
        schema: "slack-bridge-render-snapshot.v2",
        sourceMessageId: randomUUID(),
        sourceMessageSeq: 1,
        canonicalConversationId: surface.channel.id,
        level: "top_level",
        canonicalRootMessageId: null,
        sourcePermalink: "https://app.raft.build/s/test/c/test/m/test",
        senderType: "user",
        senderId: surface.owner.id,
        authorName: "Slack Runtime Owner",
        authorAvatarDigest: null,
        authorPolicy: {
          policyId: randomUUID(),
          serverId: surface.server.id,
          consentRevision: 1,
          displayName: "Slack Runtime Owner",
          fallbackKind: "human",
          avatar: null,
        },
        sanitizedText: "frozen audience refresh regression",
        externalMentions: [],
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
    runtimeRevision: frozen.runtimeRevision,
    bindingAuthority: frozen.neutral,
    attachmentTransferEnabled: false,
  });

  assert.equal(await resolveCurrentOutboundAuthority({
    executor: surface.db,
    bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch,
    expectedAudienceRevision: frozen.neutral.memberRevision,
    senderType: "user",
    senderId: surface.owner.id,
    now: new Date(NOW.getTime() + 4_000),
    registrationId: surface.registration.id,
  }), null, "a newer refresh must not substitute for the expired frozen audience revision");
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
  assert.deepEqual(await resolveWorker({ eventId: "event-gate-on", frozenAuthority: frozen }), frozen);

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
  assert.equal(await resolveWorker({ eventId: "event-gate-off", frozenAuthority: frozen }), null,
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
    await resolveWorker({ eventId: "event-gate-restored", frozenAuthority: frozen }),
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

test("database runtime resolvers fail closed on expired addressability and revoked binding", async () => {
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
  const expiredAt = new Date(NOW.getTime() + 1);
  await surface.db.update(externalAddressabilityProjections).set({ expiresAt: expiredAt })
    .where(eq(externalAddressabilityProjections.projectionId, surface.projection.id));
  assert.equal(await ingress.resolveCurrentRuntime({
    ...input,
    now: new Date(expiredAt.getTime() + 1),
  }), null);

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
  assert.equal(await createSlackDatabaseAuthorPolicyAuthorityResolver(surface.db)({
    serverId: surface.server.id,
    bindingId: surface.binding.id,
    now: NOW,
  }), null);
});

test("audience identity authority resolves only explicit linked humans on the exact current binding", async () => {
  const surface = await fixture();
  const resolver = createSlackDatabaseAudienceIdentityAuthority();
  const input = {
    executor: surface.db,
    serverId: surface.server.id,
    channelId: surface.channel.id,
    bindingId: surface.binding.id,
    registrationId: surface.registration.id,
    installId: surface.install.id,
    providerAuthorityId: "T_RUNTIME_TEST",
    providerConversationId: "C_RUNTIME_TEST",
    connectionEpoch: 2,
    bindingEpoch: 3,
    principals: [{ kind: "human" as const, id: surface.owner.id }],
    now: NOW,
  };
  assert.deepEqual(await resolver.resolve(input), {
    kind: "resolved",
    mappings: [{
      kind: "human",
      id: surface.owner.id,
      projectionId: surface.projection.id,
    }],
  }, "a link observed before a later install reauthorization remains authoritative");
  assert.deepEqual(await resolver.resolve({
    ...input,
    principals: [{ kind: "agent" as const, id: randomUUID() }],
  }), { kind: "unavailable" });
  assert.deepEqual(await resolver.resolve({
    ...input,
    principals: [
      { kind: "human" as const, id: surface.owner.id },
      { kind: "human" as const, id: randomUUID() },
    ],
  }), { kind: "unavailable" }, "one unlinked human makes the whole audience unavailable");
  assert.deepEqual(await resolver.resolve({
    ...input,
    providerConversationId: "C_SUBSTITUTED",
  }), { kind: "unavailable" });
  assert.deepEqual(await resolver.resolve({
    ...input,
    bindingEpoch: 4,
  }), { kind: "unavailable" });
});

test("audience identity authority fails unavailable when link or actor projection is not current", async () => {
  const surface = await fixture();
  const resolver = createSlackDatabaseAudienceIdentityAuthority();
  const input = {
    executor: surface.db,
    serverId: surface.server.id,
    channelId: surface.channel.id,
    bindingId: surface.binding.id,
    registrationId: surface.registration.id,
    installId: surface.install.id,
    providerAuthorityId: "T_RUNTIME_TEST",
    providerConversationId: "C_RUNTIME_TEST",
    connectionEpoch: 2,
    bindingEpoch: 3,
    principals: [{ kind: "human" as const, id: surface.owner.id }],
    now: NOW,
  };
  await surface.db.update(externalHumanIdentityLinks).set({
    state: "revoked",
    revokedAt: NOW,
    revokeReason: "test unlink",
  }).where(eq(externalHumanIdentityLinks.userId, surface.owner.id));
  assert.deepEqual(await resolver.resolve(input), { kind: "unavailable" });

  await surface.db.update(externalHumanIdentityLinks).set({
    state: "active",
    revokedAt: null,
    revokeReason: null,
    providerUserId: "U_SUBSTITUTED",
  }).where(eq(externalHumanIdentityLinks.userId, surface.owner.id));
  assert.deepEqual(await resolver.resolve(input), { kind: "unavailable" });

  await surface.db.update(externalHumanIdentityLinks).set({
    providerUserId: "U_RUNTIME_HUMAN",
  }).where(eq(externalHumanIdentityLinks.userId, surface.owner.id));
  await surface.db.update(externalActorProjections).set({
    appRegistrationId: randomUUID(),
  }).where(eq(externalActorProjections.id, surface.projection.id));
  assert.deepEqual(
    await resolver.resolve(input),
    { kind: "unavailable" },
    "a matching Slack identity projected by another app registration is not current authority",
  );

  await surface.db.update(externalActorProjections).set({
    appRegistrationId: surface.registration.id,
  }).where(eq(externalActorProjections.id, surface.projection.id));
  await surface.db.update(externalActorProjections).set({
    state: "tombstoned",
    deactivated: true,
  }).where(eq(externalActorProjections.id, surface.projection.id));
  assert.deepEqual(await resolver.resolve(input), { kind: "unavailable" });
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
  const refresh = () => refreshSlackPublicConversationAuthority({
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
