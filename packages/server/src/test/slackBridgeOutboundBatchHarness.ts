import { closeTestDatabase, openTestDatabase } from "./integration/database.js";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  BasicTracer,
  __resetFailpointsForTests,
  __setFailpointsForTests,
  InMemoryFailpointRegistry,
  MemoryTraceSink,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import {
  channelHumans,
  channels,
  externalAppCredentials,
  externalAppInstalls,
  externalAppManifestReceipts,
  externalAppRegistrations,
  externalAppRegistrationSecrets,
  externalAppServerGrants,
  externalAuthorPolicies,
  externalChannelBindings,
  externalDeliveryAttempts,
  externalDeliveryPartitions,
  externalMessageLinks,
  externalOutboundDeliveries,
  jointChannels,
  jointChannelServers,
  messages,
  oauthClientInstalls,
  oauthClients,
  serverMembers,
  servers,
  users,
} from "../db/schema.js";
import {
  getActiveJointChannelProjectionsByLocalChannel,
  getActiveJointThreadProjectionsByCanonicalThread,
  getJointThreadProjectionForMember,
  getOrCreateThread,
} from "../services/channelService.js";
import {
  __resetOrdinaryMessageOutboundAuthorizationResolverForTests,
  __setOrdinaryMessageOutboundAuthorizationResolverForTests,
  __setSlackBridgeReconciliationMarkerMinterForTests,
  mintSlackBridgeReconciliationMarker,
  projectSlackBridgeOutboundPipelineFailure,
  SlackBridgeOutboundPipelineError,
  type ProviderNeutralOutboundRuntimeFact,
} from "../services/externalDeliveryOutboxService.js";
import {
  processExternalDeliveryPartitionHead,
  type ActiveExternalDeliveryRuntime,
  type ExternalDeliveryWorkerDependencies,
} from "../services/externalDeliveryWorkerService.js";
import {
  __resetMessageServiceDepsForTests,
  __setMessageServiceDepsForTests,
  broadcastAndDeliver,
  drainSenderReadReceiptsForTests,
} from "../services/messageService.js";
import {
  __resetMobilePushDeliveryRuntimeForTests,
  __setMobilePushDeliveryRuntimeForTests,
} from "../services/pushService.js";
import { withTraceRoot } from "../tracing/semanticTrace.js";
import {
  runSlackBridgeFullFlowPreflight,
  SLACK_BRIDGE_FULL_FLOW_PREFLIGHT_SCHEMA,
  SlackBridgeFullFlowPreflightError,
  type SlackBridgeFullFlowPreflightInput,
} from "./slackBridgeFullFlowPreflight.js";

export type SlackBridgeBatchTopology = "ordinary_channel" | "joint_channel" | "ordinary_thread";
export type SlackBridgeBatchSendMode = "first" | "same_random_replay";
export type SlackBridgeBatchResult =
  | "payload_failure"
  | "socket_failure"
  | "provider_accepted"
  | "provider_timeout"
  | "not_reached";

export interface SlackBridgeBatchCardinality {
  messages: number;
  links: number;
  outbound: number;
  partitions: number;
  attempts: number;
  providerWrites: number;
}

export interface SlackBridgeExecutableBatchCase {
  id: string;
  topology: SlackBridgeBatchTopology;
  sendMode: SlackBridgeBatchSendMode;
  authority: "fresh" | "expired";
  result: SlackBridgeBatchResult;
}

export interface SlackBridgeExecutableBatchReceipt {
  id: string;
  topology: SlackBridgeBatchTopology;
  http: 200 | 500 | "not_started";
  phase: "frontend_payload_projection" | "frontend_socket_emit" | null;
  cardinality: SlackBridgeBatchCardinality;
  providerOutcome: "accepted" | "outcome_unknown" | null;
}

export interface SlackBridgeExecutableBatchHooks {
  onDatabaseReady?(context: { channelId: string; ownerId: string }): Promise<void>;
}

type BroadcastIo = Parameters<typeof broadcastAndDeliver>[0];
type BroadcastOrchestrator = Parameters<typeof broadcastAndDeliver>[1];

const noopOrchestrator = {
  deliverMessage: async () => undefined,
} as unknown as BroadcastOrchestrator;

function healthyIo() {
  return {
    to() {
      return { emit() {} };
    },
    in() {
      return { in() { return { socketsJoin() {} }; }, socketsJoin() {} };
    },
  } as unknown as BroadcastIo;
}

function failingIo() {
  return {
    ...healthyIo(),
    to() {
      return { emit() { throw new Error("private batch socket failure"); } };
    },
  } as unknown as BroadcastIo;
}

async function seedBaseFixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "slack-batch-owner@raft.test",
    name: "slack-batch-owner",
    displayName: "Slack Batch Owner",
    passwordHash: "test-only",
    emailVerified: true,
    profileSetupCompletedAt: new Date("1999-12-31T23:00:00.000Z"),
  }).returning();
  const [peer] = await db.insert(users).values({
    email: "slack-batch-peer@raft.test",
    name: "slack-batch-peer",
    displayName: "Slack Batch Peer",
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Slack Batch Server",
    slug: "slack-batch-server",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: peer.id, role: "member" },
  ]);
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "slack-batch-channel",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: owner.id },
    { channelId: channel.id, userId: peer.id },
  ]);
  const [oauthClient] = await db.insert(oauthClients).values({
    serverId: server.id,
    clientId: "slack-batch-client",
    clientSecretHash: "test-only",
    appType: "slock_builtin",
    name: "Slack Batch Bridge",
    allowedScopes: ["messages:read", "messages:write"],
    createdByUserId: owner.id,
  }).returning();
  await db.insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: oauthClient.id,
    installedByUserId: owner.id,
  });
  const [registration] = await db.insert(externalAppRegistrations).values({
    oauthClientId: oauthClient.id,
    provider: "slack",
    environment: "test",
    providerAppId: "A_BATCH",
    providerOAuthClientId: "oauth-batch",
    capabilityManifestVersion: 1,
    capabilityManifestHash: "manifest-batch",
    requiredCapabilities: ["external_projection"],
  }).returning();
  const [signingSecret] = await db.insert(externalAppRegistrationSecrets).values({
    registrationId: registration.id,
    purpose: "signing_secret",
    encryptedSecretRef: "test-only-signing-secret-ref",
    envelopeKeyId: "batch-key",
    aadVersion: 1,
    secretRevision: 1,
  }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "manifest-batch",
    grantedCapabilities: ["external_projection"],
    grantedByType: "human",
    grantedById: owner.id,
  }).returning();
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: 1,
    state: "active",
    connectionEpoch: 1,
    scopeRevision: 1,
    credentialRevision: 1,
    installedScopes: ["chat:write"],
    providerAppId: "A_BATCH",
    providerTeamId: "T_BATCH",
    authorityType: "team",
    providerAuthorityId: "T_BATCH",
    lastVerifiedAt: new Date("1999-12-31T23:00:00.000Z"),
  }).returning();
  const [credential] = await db.insert(externalAppCredentials).values({
    installId: install.id,
    state: "active",
    encryptedMaterial: "test-only-encrypted-material",
    envelopeKeyId: "batch-key",
    aadVersion: 1,
    credentialRevision: 1,
  }).returning();
  const [manifest] = await db.insert(externalAppManifestReceipts).values({
    registrationId: registration.id,
    receiptRevision: 1,
    managerCredentialRevision: 1,
    providerAppId: "A_BATCH",
    normalizedManifestHash: "manifest-batch",
    normalizedScopes: ["chat:write"],
    normalizedEvents: ["message.channels"],
    normalizedSettings: {},
    status: "valid",
    observedAt: new Date("1999-12-31T23:00:00.000Z"),
    expiresAt: new Date("2000-01-01T00:00:00.000Z"),
  }).returning();
  const [binding] = await db.insert(externalChannelBindings).values({
    serverId: server.id,
    registrationId: registration.id,
    installId: install.id,
    channelId: channel.id,
    providerConversationId: "C_BATCH",
    providerConversationKind: "public_channel",
    privacyClass: "public",
    grantEpoch: 1,
    connectionEpoch: 1,
    bindingEpoch: 1,
    consentedByType: "human",
    consentedById: owner.id,
    consentedAt: new Date("1999-12-31T23:00:00.000Z"),
  }).returning();
  const [policy] = await db.insert(externalAuthorPolicies).values({
    serverId: server.id,
    provider: "slack",
    appRegistrationId: registration.id,
    installId: install.id,
    bindingId: binding.id,
    bindingEpoch: binding.bindingEpoch,
    authorType: "user",
    authorId: owner.id,
    displayName: owner.displayName ?? owner.name,
    fallbackKind: "human",
    consentRevision: 1,
    state: "granted",
  }).returning();
  return {
    owner,
    peer,
    server,
    channel,
    oauthClient,
    registration,
    signingSecret,
    grant,
    install,
    credential,
    manifest,
    binding,
    policy,
  };
}

function activeRuntime(fixture: Awaited<ReturnType<typeof seedBaseFixture>>): ProviderNeutralOutboundRuntimeFact {
  return {
    level: "top_level",
    authorityConversationId: fixture.channel.id,
    runtimePredicateRevision: "runtime-batch-1",
    bindingAuthority: {
      provider: "slack",
      environment: "test",
      appRegistrationId: fixture.registration.id,
      installId: fixture.install.id,
      workspaceId: fixture.install.providerAuthorityId,
      connectionEpoch: fixture.install.connectionEpoch,
      bindingId: fixture.binding.id,
      bindingEpoch: fixture.binding.bindingEpoch,
      memberRevision: 3,
      contextRevision: 4,
      consentRevision: fixture.policy.consentRevision,
      privacyClass: "public",
      raftChannelId: fixture.channel.id,
      providerAuthorityId: fixture.install.providerAuthorityId,
      providerConversationId: fixture.binding.providerConversationId,
    },
  };
}

function installAuthorizationResolver(fixture: Awaited<ReturnType<typeof seedBaseFixture>>) {
  __setOrdinaryMessageOutboundAuthorizationResolverForTests(async ({ requestedChannelId, sourceText }) =>
    requestedChannelId === fixture.channel.id
      ? {
        activeRuntime: activeRuntime(fixture),
        canonicalConversationId: fixture.channel.id,
        sanitizedText: sourceText,
      }
      : null
  );
}

async function targetForTopology(
  topology: SlackBridgeBatchTopology,
  fixture: Awaited<ReturnType<typeof seedBaseFixture>>,
): Promise<{ requestChannelId: string; storedChannelId: string }> {
  if (topology === "ordinary_channel") {
    return { requestChannelId: fixture.channel.id, storedChannelId: fixture.channel.id };
  }
  if (topology === "ordinary_thread") {
    const [parent] = await getDb().insert(messages).values({
      channelId: fixture.channel.id,
      senderType: "user",
      senderId: fixture.owner.id,
      content: "batch thread parent",
      messageType: "chat",
    }).returning();
    const thread = await getOrCreateThread(parent.id, fixture.owner.id, "user");
    return { requestChannelId: thread.id, storedChannelId: thread.id };
  }

  const [peerServer] = await getDb().insert(servers).values({
    name: "Slack Batch Joint Peer",
    slug: "slack-batch-joint-peer",
    ownerId: fixture.peer.id,
  }).returning();
  await getDb().insert(serverMembers).values({
    serverId: peerServer.id,
    userId: fixture.peer.id,
    role: "owner",
  });
  const [canonicalChannel, localChannel, peerLocalChannel] = await getDb().insert(channels).values([{
    serverId: fixture.server.id,
    name: "slack-batch-joint-canonical",
    type: "joint",
  }, {
    serverId: fixture.server.id,
    name: "slack-batch-joint-local",
    type: "joint",
  }, {
    serverId: peerServer.id,
    name: "slack-batch-joint-peer",
    type: "joint",
  }]).returning();
  const [joint] = await getDb().insert(jointChannels).values({
    canonicalChannelId: canonicalChannel.id,
    createdByServerId: fixture.server.id,
    createdByUserId: fixture.owner.id,
  }).returning();
  await getDb().insert(jointChannelServers).values([{
    jointChannelId: joint.id,
    serverId: fixture.server.id,
    localChannelId: localChannel.id,
    role: "host",
    status: "active",
    joinedByUserId: fixture.owner.id,
  }, {
    jointChannelId: joint.id,
    serverId: peerServer.id,
    localChannelId: peerLocalChannel.id,
    role: "participant",
    status: "active",
    joinedByUserId: fixture.peer.id,
  }]);
  await getDb().insert(channelHumans).values({ channelId: localChannel.id, userId: fixture.owner.id });
  return { requestChannelId: localChannel.id, storedChannelId: canonicalChannel.id };
}

function workerDependencies(
  runtimeFact: ProviderNeutralOutboundRuntimeFact,
  result: "provider_accepted" | "provider_timeout",
  providerWrites: { value: number },
): ExternalDeliveryWorkerDependencies {
  const runtime: ActiveExternalDeliveryRuntime = {
    runtimeRevision: runtimeFact.runtimePredicateRevision,
    bindingAuthority: runtimeFact.bindingAuthority,
  };
  return {
    now: () => new Date("2026-08-07T07:00:00.000Z"),
    jitterUnit: () => 0.5,
    async resolveCurrentRuntime() {
      return runtime;
    },
    async leaseCredential({ runtime: current }) {
      return {
        handle: { opaque: true },
        credentialRevision: 1,
        runtimeRevision: current.runtimeRevision,
        provider: current.bindingAuthority.provider,
        installId: current.bindingAuthority.installId,
        providerAuthorityId: current.bindingAuthority.providerAuthorityId,
        providerConversationId: current.bindingAuthority.providerConversationId,
        connectionEpoch: current.bindingAuthority.connectionEpoch,
        bindingId: current.bindingAuthority.bindingId,
        bindingEpoch: current.bindingAuthority.bindingEpoch,
      };
    },
    async dispatchProvider() {
      providerWrites.value += 1;
      if (result === "provider_timeout") throw new Error("private provider timeout");
      return { kind: "accepted", providerMessageId: "provider-batch-accepted-1" };
    },
  };
}

async function expiredPreflightInput(
  fixture: Awaited<ReturnType<typeof seedBaseFixture>>,
  runtimeFingerprint: string,
): Promise<SlackBridgeFullFlowPreflightInput> {
  const db = getDb();
  const expiredAt = fixture.manifest.expiresAt.toISOString();
  const memberRows = await db.select({ userId: serverMembers.userId }).from(serverMembers)
    .where(eq(serverMembers.serverId, fixture.server.id));
  const channelRows = await db.select({ userId: channelHumans.userId }).from(channelHumans)
    .where(eq(channelHumans.channelId, fixture.channel.id));
  const [targetChannel] = await db.select({ type: channels.type }).from(channels)
    .where(eq(channels.id, fixture.channel.id));
  const [canonicalJointRows] = await db.select({ count: sql<number>`count(*)::int` }).from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, fixture.channel.id));
  const [localJointRows] = await db.select({ count: sql<number>`count(*)::int` }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, fixture.channel.id));
  const [externalBindingRows] = await db.select({ count: sql<number>`count(*)::int` }).from(externalChannelBindings)
    .where(and(
      eq(externalChannelBindings.channelId, fixture.channel.id),
      eq(externalChannelBindings.state, "active"),
    ));
  const [clientInstallRows] = await db.select({ count: sql<number>`count(*)::int` }).from(oauthClientInstalls)
    .where(and(
      eq(oauthClientInstalls.serverId, fixture.server.id),
      eq(oauthClientInstalls.clientId, fixture.oauthClient.id),
    ));
  const [messageRows] = await db.select({ count: sql<number>`count(*)::int` }).from(messages)
    .where(eq(messages.channelId, fixture.channel.id));
  const [deliveryRows] = await db.select({ count: sql<number>`count(*)::int` }).from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.bindingId, fixture.binding.id));
  const [linkRows] = await db.select({ count: sql<number>`count(*)::int` }).from(externalMessageLinks)
    .where(eq(externalMessageLinks.bindingId, fixture.binding.id));
  const [attemptRows] = await db.select({ count: sql<number>`count(*)::int` }).from(externalDeliveryAttempts);
  const [leaseRows] = await db.select({ count: sql<number>`count(*)::int` }).from(externalAppCredentials)
    .where(and(
      eq(externalAppCredentials.installId, fixture.install.id),
      isNotNull(externalAppCredentials.leaseOwner),
    ));

  return {
    schema: SLACK_BRIDGE_FULL_FLOW_PREFLIGHT_SCHEMA,
    identity: {
      userId: fixture.owner.id,
      email: fixture.owner.email,
      name: fixture.owner.name,
      displayName: fixture.owner.displayName ?? fixture.owner.name,
      password: "password123",
      emailVerified: fixture.owner.emailVerified,
      profileSetupCompleted: fixture.owner.profileSetupCompletedAt !== null,
    },
    audience: {
      serverId: fixture.server.id,
      channelId: fixture.channel.id,
      ownerId: fixture.server.ownerId,
      memberIds: memberRows.map((row) => row.userId),
      channelHumanIds: channelRows.map((row) => row.userId),
    },
    topology: {
      requestedChannelType: targetChannel?.type ?? "missing",
      canonicalJointRows: canonicalJointRows?.count ?? -1,
      localJointRows: localJointRows?.count ?? -1,
      externalBindingRows: externalBindingRows?.count ?? -1,
      runtimeBuildFingerprint: runtimeFingerprint,
      expectedRuntimeBuildFingerprint: runtimeFingerprint,
    },
    registration: {
      id: fixture.registration.id,
      provider: fixture.registration.provider,
      environment: fixture.registration.environment,
      providerAppId: fixture.registration.providerAppId,
      oauthClientId: fixture.registration.providerOAuthClientId,
      oauthClientInstalled: clientInstallRows?.count === 1,
      manifestVersion: fixture.registration.capabilityManifestVersion,
      manifestHash: fixture.registration.capabilityManifestHash,
    },
    grant: {
      id: fixture.grant.id,
      serverId: fixture.grant.serverId,
      registrationId: fixture.grant.registrationId,
      grantEpoch: fixture.grant.grantEpoch,
      manifestVersion: fixture.grant.grantedManifestVersion,
      manifestHash: fixture.grant.grantedManifestHash,
    },
    install: {
      id: fixture.install.id,
      serverId: fixture.install.serverId,
      registrationId: fixture.install.registrationId,
      serverGrantId: fixture.install.serverGrantId,
      state: fixture.install.state,
      grantEpoch: fixture.install.grantEpoch,
      connectionEpoch: fixture.install.connectionEpoch,
      credentialRevision: fixture.install.credentialRevision,
      providerAppId: fixture.install.providerAppId,
      providerAuthorityId: fixture.install.providerAuthorityId,
    },
    credential: {
      installId: fixture.credential.installId,
      state: fixture.credential.state,
      credentialRevision: fixture.credential.credentialRevision,
      envelopeKeyId: fixture.credential.envelopeKeyId,
      aadVersion: fixture.credential.aadVersion,
      leaseOwner: fixture.credential.leaseOwner,
      leaseExpiresAt: fixture.credential.leaseExpiresAt?.toISOString() ?? null,
    },
    manifest: {
      registrationId: fixture.manifest.registrationId,
      status: fixture.manifest.status,
      receiptRevision: fixture.manifest.receiptRevision,
      managerCredentialRevision: fixture.manifest.managerCredentialRevision,
      providerAppId: fixture.manifest.providerAppId,
      normalizedManifestHash: fixture.manifest.normalizedManifestHash,
      expiresAt: expiredAt,
    },
    signingSecret: {
      registrationId: fixture.signingSecret.registrationId,
      purpose: fixture.signingSecret.purpose,
      secretRevision: fixture.signingSecret.secretRevision,
      envelopeKeyId: fixture.signingSecret.envelopeKeyId,
      aadVersion: fixture.signingSecret.aadVersion,
    },
    binding: {
      id: fixture.binding.id,
      serverId: fixture.binding.serverId,
      registrationId: fixture.binding.registrationId,
      installId: fixture.binding.installId,
      channelId: fixture.binding.channelId,
      state: fixture.binding.state,
      connectionEpoch: fixture.binding.connectionEpoch,
      bindingEpoch: fixture.binding.bindingEpoch,
      privacyClass: fixture.binding.privacyClass,
      providerConversationId: fixture.binding.providerConversationId,
      consentRevision: fixture.policy.consentRevision,
    },
    membership: {
      registrationId: fixture.registration.id,
      installId: fixture.install.id,
      bindingId: fixture.binding.id,
      connectionEpoch: fixture.install.connectionEpoch,
      bindingEpoch: fixture.binding.bindingEpoch,
      providerAuthorityId: fixture.install.providerAuthorityId,
      providerConversationId: fixture.binding.providerConversationId,
      receiptRevision: 1,
      expiresAt: expiredAt,
    },
    oracle: {
      bindingId: fixture.binding.id,
      connectionEpoch: fixture.install.connectionEpoch,
      bindingEpoch: fixture.binding.bindingEpoch,
      privacyClass: fixture.binding.privacyClass,
      level: "top_level",
      releaseContractRevision: "slack-bridge-revision-5",
      oracleReceiptSchema: "slack-bridge-oracle-receipt.v1",
      oracleReceiptRevision: 1,
      inboundGreen: true,
      outboundGreen: true,
      expiresAt: expiredAt,
    },
    authorPolicy: {
      serverId: fixture.policy.serverId,
      provider: fixture.policy.provider,
      registrationId: fixture.policy.appRegistrationId,
      installId: fixture.policy.installId,
      bindingId: fixture.policy.bindingId,
      bindingEpoch: fixture.policy.bindingEpoch,
      authorId: fixture.policy.authorId,
      displayName: fixture.policy.displayName,
      consentRevision: fixture.policy.consentRevision,
      state: fixture.policy.state,
    },
    flags: {
      configRevision: 1,
      enabled: Object.fromEntries(Object.values(SLACK_BRIDGE_FEATURE_FLAG_KEYS).map((key) => [key, true])),
    },
    baseline: {
      sourceMessages: messageRows?.count ?? -1,
      outboundDeliveries: deliveryRows?.count ?? -1,
      providerLinks: linkRows?.count ?? -1,
      deliveryAttempts: attemptRows?.count ?? -1,
      activeCredentialLeases: leaseRows?.count ?? -1,
    },
    executionFence: { providerNetworkDisabled: true, localSlackSinkOnly: true },
  };
}

async function readCardinality(storedChannelId: string, providerWrites: number): Promise<SlackBridgeBatchCardinality> {
  return {
    messages: (await getDb().select().from(messages).where(eq(messages.channelId, storedChannelId))).length,
    links: (await getDb().select().from(externalMessageLinks)).length,
    outbound: (await getDb().select().from(externalOutboundDeliveries)).length,
    partitions: (await getDb().select().from(externalDeliveryPartitions)).length,
    attempts: (await getDb().select().from(externalDeliveryAttempts)).length,
    providerWrites,
  };
}

export async function runSlackBridgeExecutableBatchCase(
  entry: SlackBridgeExecutableBatchCase,
  runtimeFingerprint: string,
  hooks: SlackBridgeExecutableBatchHooks = {},
): Promise<SlackBridgeExecutableBatchReceipt> {
  await openTestDatabase("pglite://");
  __setMobilePushDeliveryRuntimeForTests({ schedule: () => undefined });
  __setMessageServiceDepsForTests({
    sendPushNotifications: async () => undefined,
    persistNativeNotificationIntents: async () => 0,
    getActiveJointChannelProjectionsByLocalChannel,
    getActiveJointThreadProjectionsByCanonicalThread,
    getJointThreadProjectionForMember,
  });
  __setSlackBridgeReconciliationMarkerMinterForTests(({ deliveryId }) =>
    mintSlackBridgeReconciliationMarker("test-only-batch-key", deliveryId)
  );
  const providerWrites = { value: 0 };
  try {
    const fixture = await seedBaseFixture();
    await hooks.onDatabaseReady?.({ channelId: fixture.channel.id, ownerId: fixture.owner.id });

    if (entry.authority === "expired") {
      if (entry.topology !== "ordinary_channel") {
        throw new Error(`${entry.id} is not a reachable external Slack authority topology`);
      }
      let failure: unknown;
      try {
        runSlackBridgeFullFlowPreflight(await expiredPreflightInput(fixture, runtimeFingerprint));
      } catch (error) {
        failure = error;
      }
      if (!(failure instanceof SlackBridgeFullFlowPreflightError) || failure.gate !== "manifest") {
        throw failure ?? new Error("expired authority unexpectedly passed preflight");
      }
      return {
        id: entry.id,
        topology: "ordinary_channel",
        http: "not_started",
        phase: null,
        cardinality: await readCardinality(fixture.channel.id, providerWrites.value),
        providerOutcome: null,
      };
    }

    installAuthorizationResolver(fixture);
    const target = await targetForTopology(entry.topology, fixture);
    const request = {
      channelId: target.requestChannelId,
      senderType: "user" as const,
      senderId: fixture.owner.id,
      senderName: fixture.owner.displayName ?? fixture.owner.name,
      content: `batch ${entry.id}`,
      randomId: `batch-${entry.id}`,
    };
    const sendCount = entry.sendMode === "same_random_replay" ? 2 : 1;
    let phase: SlackBridgeExecutableBatchReceipt["phase"] = null;
    let http: SlackBridgeExecutableBatchReceipt["http"] = 200;
    let observedTopology: SlackBridgeBatchTopology | null = null;

    if (entry.result === "payload_failure") {
      const registry = new InMemoryFailpointRegistry();
      registry.configure("server.message.frontend.payloadProjection", {
        mode: "always",
        effect: "throw",
        payload: "private batch payload failure",
      });
      __setFailpointsForTests(registry);
    }

    for (let sendIndex = 0; sendIndex < sendCount; sendIndex += 1) {
      const traceSink = entry.result === "socket_failure" ? new MemoryTraceSink() : null;
      const tracer = traceSink ? new BasicTracer({ sink: traceSink }) : null;
      const send = () => broadcastAndDeliver(
        entry.result === "socket_failure" ? failingIo() : healthyIo(),
        noopOrchestrator,
        request,
      );
      try {
        await (tracer
          ? withTraceRoot(
              tracer,
              "test.slack_bridge.batch_send",
              { surface: "server", kind: "server" },
              send,
            )
          : send());
        if (entry.result === "payload_failure") {
          throw new Error(`${entry.id} unexpectedly completed its frontend failure scenario`);
        }
      } catch (error) {
        if (!(error instanceof SlackBridgeOutboundPipelineError)) throw error;
        const projection = projectSlackBridgeOutboundPipelineFailure(error, "test");
        if (!projection) throw new Error(`${entry.id} did not project a test diagnostic`);
        http = 500;
        phase = projection.phase === "frontend_payload_projection" || projection.phase === "frontend_socket_emit"
          ? projection.phase
          : null;
        if (projection.topology !== entry.topology) {
          throw new Error(`${entry.id} executed topology ${projection.topology ?? "missing"}`);
        }
        observedTopology = projection.topology;
      }
      if (entry.result === "socket_failure") {
        const degraded = traceSink!.getAllSpans().flatMap((span) => span.events).filter((event) =>
          event.name === "message_pipeline.frontend_socket_emit.degraded"
        );
        if (degraded.length === 0) {
          throw new Error(`${entry.id} did not record its Socket degradation fact`);
        }
        for (const event of degraded) {
          const fact = event.attrs;
          if (
            fact?.phase !== "frontend_socket_emit"
            || fact.topology !== entry.topology
            || fact.persistence_state !== "durable"
            || fact.failure_policy !== "continue_from_persisted_state"
            || fact.replayed !== (sendIndex > 0)
          ) {
            throw new Error(`${entry.id} recorded a mismatched Socket degradation fact`);
          }
        }
        observedTopology = entry.topology;
      }
    }

    let providerOutcome: SlackBridgeExecutableBatchReceipt["providerOutcome"] = null;
    if (entry.result === "provider_accepted" || entry.result === "provider_timeout") {
      if (entry.topology !== "ordinary_channel") {
        throw new Error(`${entry.id} cannot dispatch a provider from a non-ordinary topology`);
      }
      const runtimeFact = activeRuntime(fixture);
      const worker = await processExternalDeliveryPartitionHead({
        db: getDb(),
        bindingId: runtimeFact.bindingAuthority.bindingId,
        bindingEpoch: runtimeFact.bindingAuthority.bindingEpoch,
        leaseOwner: "batch-worker",
        dependencies: workerDependencies(runtimeFact, entry.result, providerWrites),
      });
      if (worker.kind !== "attempted") throw new Error(`${entry.id} worker did not attempt the provider`);
      providerOutcome = worker.outcome === "accepted" ? "accepted" : "outcome_unknown";
    }

    return {
      id: entry.id,
      topology: observedTopology ?? entry.topology,
      http,
      phase,
      cardinality: await readCardinality(target.storedChannelId, providerWrites.value),
      providerOutcome,
    };
  } finally {
    __resetFailpointsForTests();
    __resetOrdinaryMessageOutboundAuthorizationResolverForTests();
    __resetMessageServiceDepsForTests();
    __resetMobilePushDeliveryRuntimeForTests();
    await drainSenderReadReceiptsForTests();
    await closeTestDatabase();
  }
}
