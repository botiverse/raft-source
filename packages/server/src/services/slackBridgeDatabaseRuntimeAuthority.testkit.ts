// Shared fixtures for the slackBridgeDatabaseRuntimeAuthority.*.test.ts files
// (one suite split by topic so CI shards can run the parts in parallel).
import { openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { eq } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { attachPoolClientErrorHandler } from "../db/pgPoolErrorHandler";
import {
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstallServerGrants,
  externalAppInstalls,
  externalAppManifestReceipts,
  externalAppRegistrations,
  externalAppRegistrationSecrets,
  externalAppServerGrants,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  slackChannelDeletions,
  externalHumanIdentityLinks,
  externalInboundEvents,
  featureFlags,
  messages,
  oauthClientInstalls,
  oauthClients,
  users,
} from "../db/schema";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService";
import { createSlackBridgeDatabaseOutboundRuntime, resolveCurrentOutboundAuthority } from "./slackBridgeDatabaseOutboundRuntime";
import {
  processExternalDeliveryPartitionHead,
  type ExternalDeliveryWorkerDependencies,
  type ActiveExternalDeliveryRuntime,
} from "./externalDeliveryWorkerService";
import { enqueueSlackBridgeOutboundDelivery, mintSlackBridgeReconciliationMarker } from "./externalDeliveryOutboxService";
import { type SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import { createFeatureFlagRule } from "./featureFlagService";
import { createServer } from "./serverService";
import { createSlackDatabaseInboundWorkerRuntimeResolver, slackBridgeDatabaseRuntimeRevision } from "./slackBridgeDatabaseRuntimeAuthority";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "./slackBridgeProductionAppContract";
import { slackBridgeInstallGrantHash } from "./slackBridgeInstallGrantService";

export const NOW = new Date("2026-08-11T08:00:00.000Z");

export const EXPIRES = new Date("2027-08-11T08:00:00.000Z");

export function legacyRuntimeRevisionV1(
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

export async function fixture(privacyClass: "public" | "private" = "private") {
  const realPgUrl = process.env.CARDY_W3_REAL_PG_URL;
  if (realPgUrl) {
    const pool = new pg.Pool({ connectionString: realPgUrl, max: 2 });
    attachPoolClientErrorHandler(pool, "slack-runtime-authority-test-migrate");
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

export async function reauthorizeSamePair(surface: Awaited<ReturnType<typeof fixture>>) {
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

export async function storeWorkerCustody(surface: Awaited<ReturnType<typeof fixture>>, frozen: Parameters<ReturnType<typeof createSlackDatabaseInboundWorkerRuntimeResolver>>[0]["frozenAuthority"]) {
  const id = randomUUID();
  await surface.db.insert(externalInboundEvents).values({
    ...frozen, id, provider: "slack", providerEventId: `Ev_${id}`,
    normalizedPayloadDigest: "e".repeat(64), encryptedPayload: "synthetic-sealed-custody",
    envelopeKeyId: "test-only", payloadSchemaVersion: 2, payloadExpiresAt: EXPIRES,
    receivedAt: NOW, updatedAt: NOW,
  });
  return id;
}

export async function resolveCurrentOutboundAuthorityOrNull(input: Parameters<typeof resolveCurrentOutboundAuthority>[0]) {
  const decision = await resolveCurrentOutboundAuthority(input);
  return decision.current ? decision.authority : null;
}

/**
 * Two sends through the real outbound worker's credential lease after
 * `mutate` changed the bound Raft channel. Admission froze the runtime
 * before the change, as it does for a message queued just before it.
 */
export async function enqueueAuthorityProbe(surface: Awaited<ReturnType<typeof fixture>>,
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

export async function leaseTwiceAfter(
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

export async function reviewUseCompleteInstalledScopes(s: Awaited<ReturnType<typeof fixture>>) {
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

export async function pairControlFixture(count = 2) {
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

export async function waitForControlState(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error("pair control did not reach its observed state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
