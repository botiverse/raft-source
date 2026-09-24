import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import {
  agents,
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppIngressEndpoints,
  externalAppInstallGrantReceipts,
  externalAppInstalls,
  externalAppManifestReceipts,
  externalAppRegistrations,
  externalAppRegistrationSecrets,
  externalAppServerGrants,
  externalAuthorPolicies,
  externalChannelBindings,
  externalOutboundDeliveries,
  featureFlags,
  messages,
  oauthClientInstalls,
  oauthClients,
  users,
} from "../db/schema.js";
import { updateFeatureFlag } from "./featureFlagService.js";
import { setExternalAuthorPolicyState } from "./externalAppControlPlaneService.js";
import { slackBridgeInstallGrantHash } from "./slackBridgeInstallGrantService.js";
import { createServer } from "./serverService.js";
import { broadcastAndDeliver, drainSenderReadReceiptsForTests } from "./messageService.js";
import {
  createSlackBridgeLocalRuntimeFromEnv,
  observeSlackBridgeLocalManifestAuthorityFromEnv,
  renewSlackBridgeLocalManifestAuthorityFromEnv,
  replaceSlackBridgeLocalRealAuthorityFromEnv,
  verifySlackBridgeLocalRealAuthorityFromEnv,
  verifySlackBridgeLocalOutboundAuthorityFromEnv,
  type SlackBridgeLocalOutboundBootstrapInput,
  type SlackBridgeLocalManifestAuthorityInput,
  type SlackBridgeLocalRealAuthorityInput,
} from "./slackBridgeLocalRuntime.js";


const NOW = new Date("2026-08-06T08:30:00.000Z");
const EXPIRES = new Date(NOW.getTime() + 60 * 60_000);
const APP_ID = "A_REAL_AUTHORITY_TEST";
const TEAM_ID = "T_REAL_AUTHORITY_TEST";
const CONVERSATION_ID = "C_REAL_AUTHORITY_TEST";
const ENVELOPE_KEY_ID = "real-authority-test-key";

interface RuntimeConfigJson {
  outbound?: SlackBridgeLocalOutboundBootstrapInput;
  realAuthority?: {
    actorCount: number;
    connectionEpoch: number;
    credentialRevision: number;
    memberRevision: number;
    contextRevision: number;
    observedAt: string;
    expiresAt: string;
  };
}

afterEach(async () => {
  await drainSenderReadReceiptsForTests();
  await closeTestDatabase();
});

const noopOrchestrator = { deliverMessage: async () => undefined } as any;

function createIo() {
  return {
    to() {
      return { emit() {} };
    },
    in() {
      return { in() { return { socketsJoin() {} }; }, socketsJoin() {} };
    },
  } as any;
}

async function writeRuntimeConfig(input: {
  registrationId: string;
  installId: string;
  serverId: string;
  channelId: string;
  bindingId: string;
}) {
  const directory = await mkdtemp(join(tmpdir(), "slack-real-authority-"));
  const path = join(directory, "runtime.json");
  const expiresAt = EXPIRES.toISOString();
  const config = {
    schema: "slack-bridge-local-runtime.v1",
    environment: "test",
    publicOrigin: "https://bridge-real-authority.example.test",
    registrationId: input.registrationId,
    providerAppId: APP_ID,
    providerOAuthClientId: "real-authority-client",
    oauthClientSecret: "provider-disabled-oauth-secret",
    signingSecret: "provider-disabled-signing-secret",
    signingSecretRef: "local-ref:slack-signing:v2",
    signingSecretRevision: 2,
    envelopeKeyId: ENVELOPE_KEY_ID,
    envelopeKeyBase64: Buffer.alloc(32, 9).toString("base64"),
    outbound: {
      workerId: "real-authority-worker",
      pollIntervalMs: 10_000,
      raftAppOrigin: "https://app.slock.ai",
      bindings: [{
        serverId: input.serverId,
        sourceConversationId: input.channelId,
        canonicalRootMessageId: null,
        bindingId: input.bindingId,
        connectionEpoch: 1,
        bindingEpoch: 1,
        consentRevision: 1,
        level: "top_level",
        membership: {
          registrationId: input.registrationId,
          installId: input.installId,
          bindingId: input.bindingId,
          connectionEpoch: 1,
          bindingEpoch: 1,
          providerAuthorityId: TEAM_ID,
          providerConversationId: CONVERSATION_ID,
          receiptRevision: 1,
          expiresAt,
        },
        oracle: {
          bindingId: input.bindingId,
          connectionEpoch: 1,
          bindingEpoch: 1,
          privacyClass: "public",
          level: "top_level",
          releaseContractRevision: "slack-bridge-revision-5",
          oracleReceiptSchema: "slack-bridge-oracle-receipt.v1",
          oracleReceiptRevision: 1,
          inboundGreen: true,
          outboundGreen: true,
          expiresAt,
        },
      }],
    },
  };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  await chmod(path, 0o600);
  return {
    path: await realpath(path),
    read: async () => JSON.parse(await readFile(path, "utf8")) as RuntimeConfigJson,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function writeManifestManagerCredential(input: {
  directory: string;
  registrationId: string;
  token?: string;
  encryptedSecretRef?: string;
  secretRevision?: number;
}) {
  const path = join(input.directory, `manifest-manager-${randomUUID()}.json`);
  const credential = {
    schema: "slack-bridge-local-manifest-manager-credential.v1",
    registrationId: input.registrationId,
    providerAppId: APP_ID,
    encryptedSecretRef: input.encryptedSecretRef ?? "local-ref:manifest:v2",
    envelopeKeyId: ENVELOPE_KEY_ID,
    aadVersion: 1,
    secretRevision: input.secretRevision ?? 2,
    token: input.token ?? "xoxe.test-only-manager-token",
  };
  await writeFile(path, JSON.stringify(credential), { mode: 0o600 });
  await chmod(path, 0o600);
  return { path: await realpath(path), credential };
}

async function fixture() {
  await openTestDatabase("pglite://");
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `real-authority-${randomUUID()}@test.invalid`,
    name: `real-authority-${randomUUID()}`,
    displayName: "Real Authority Owner",
    passwordHash: "test-only",
    emailVerified: true,
    profileSetupCompletedAt: NOW,
  }).returning();
  const server = await createServer("Real Authority", `real-authority-${randomUUID()}`, owner.id);
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `real-authority-${randomUUID()}`,
    type: "channel",
  }).returning();
  const [client] = await db.insert(oauthClients).values({
    serverId: server.id,
    clientId: `real-authority-${randomUUID()}`,
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
    providerAppId: APP_ID,
    providerOAuthClientId: "real-authority-client",
    capabilityManifestVersion: 1,
    capabilityManifestHash: "real-authority-manifest-v1",
    requiredCapabilities: ["external_projection"],
  }).returning();
  await db.insert(externalAppRegistrationSecrets).values([{
    registrationId: registration.id,
    purpose: "signing_secret",
    encryptedSecretRef: "local-ref:slack-signing:v2",
    envelopeKeyId: ENVELOPE_KEY_ID,
    aadVersion: 1,
    secretRevision: 2,
  }, {
    registrationId: registration.id,
    purpose: "manifest_manager",
    encryptedSecretRef: "local-ref:manifest:v2",
    envelopeKeyId: ENVELOPE_KEY_ID,
    aadVersion: 1,
    secretRevision: 2,
  }]);
  await db.insert(externalAppIngressEndpoints).values({
    registrationId: registration.id,
    environment: "test",
    exactRequestUrl: "https://bridge-real-authority.example.test/api/slack-bridge/events",
    endpointRevision: 2,
    signingSecretRevision: 2,
  });
  await db.insert(externalAppManifestReceipts).values({
    registrationId: registration.id,
    receiptRevision: 2,
    managerCredentialRevision: 2,
    providerAppId: APP_ID,
    normalizedManifestHash: "real-authority-manifest-v1",
    normalizedScopes: ["channels:history", "channels:read", "chat:write", "users:read"],
    normalizedEvents: ["message.channels"],
    normalizedSettings: {},
    status: "valid",
    observedAt: NOW,
    expiresAt: EXPIRES,
  });
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "real-authority-manifest-v1",
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
    connectionEpoch: 2,
    scopeRevision: 2,
    credentialRevision: 2,
    installedScopes: ["channels:history", "channels:read", "chat:write", "users:read"],
    providerAppId: APP_ID,
    providerTeamId: TEAM_ID,
    authorityType: "team",
    providerAuthorityId: TEAM_ID,
    botUserId: "U_REAL_AUTHORITY_BOT",
    providerBotId: "B_REAL_AUTHORITY",
    lastVerifiedAt: NOW,
  }).returning();
  await db.insert(externalAppCredentials).values({
    installId: install.id,
    state: "active",
    encryptedMaterial: "test-only-sealed-credential",
    envelopeKeyId: ENVELOPE_KEY_ID,
    aadVersion: 1,
    credentialRevision: 2,
  });
  const installGrantScopes = ["channels:history", "channels:read", "chat:write", "users:read"];
  await db.insert(externalAppInstallGrantReceipts).values({
    registrationId: registration.id,
    installId: install.id,
    receiptRevision: 1,
    connectionEpoch: 2,
    scopeRevision: 2,
    credentialRevision: 2,
    providerAppId: APP_ID,
    providerAuthorityId: TEAM_ID,
    botUserId: "U_REAL_AUTHORITY_BOT",
    providerBotId: "B_REAL_AUTHORITY",
    grantedScopes: installGrantScopes,
    grantHash: slackBridgeInstallGrantHash({
      providerAppId: APP_ID,
      providerAuthorityId: TEAM_ID,
      botUserId: "U_REAL_AUTHORITY_BOT",
      providerBotId: "B_REAL_AUTHORITY",
      grantedScopes: installGrantScopes,
    }),
    observationSource: "token_introspection",
    status: "valid",
    observedAt: NOW,
    expiresAt: new Date(EXPIRES.getTime() + 2 * 60 * 60_000),
  });
  const [binding] = await db.insert(externalChannelBindings).values({
    serverId: server.id,
    registrationId: registration.id,
    installId: install.id,
    channelId: channel.id,
    providerConversationId: CONVERSATION_ID,
    providerConversationKind: "public_channel",
    privacyClass: "public",
    grantEpoch: 1,
    connectionEpoch: 1,
    bindingEpoch: 1,
    consentedByType: "human",
    consentedById: owner.id,
    consentedAt: new Date(NOW.getTime() - 60_000),
  }).returning();
  const [authorPolicy] = await db.insert(externalAuthorPolicies).values({
    serverId: server.id,
    provider: "slack",
    appRegistrationId: registration.id,
    installId: install.id,
    bindingId: binding.id,
    bindingEpoch: 1,
    authorType: "user",
    authorId: owner.id,
    displayName: owner.displayName!,
    fallbackKind: "human",
    consentRevision: 1,
    state: "granted",
  }).returning();

  const actorInputs = [
    { externalActorId: "U_ALICE", displayName: "Alice Current", handles: ["alice"], actorKind: "human" as const },
    { externalActorId: "U_BOB", displayName: "Bob Current", handles: ["bob"], actorKind: "guest" as const },
  ];
  const actors = [];
  for (const input of actorInputs) {
    const [actor] = await db.insert(externalActorProjections).values({
      provider: "slack",
      appRegistrationId: registration.id,
      installId: install.id,
      workspaceId: TEAM_ID,
      externalActorId: input.externalActorId,
      displayName: `${input.displayName} stale`,
      handles: input.handles,
      actorKind: input.actorKind,
      state: "active",
      deactivated: false,
      projectionRevision: 1,
      observedAt: new Date(NOW.getTime() - 60 * 60_000),
    }).returning();
    actors.push(actor);
    await db.insert(externalAddressabilityProjections).values({
      projectionId: actor.id,
      provider: "slack",
      appRegistrationId: registration.id,
      installId: install.id,
      workspaceId: TEAM_ID,
      connectionEpoch: 1,
      bindingId: binding.id,
      bindingEpoch: 1,
      conversationId: CONVERSATION_ID,
      memberRevision: 1,
      contextRevision: 1,
      state: "active",
      observedAt: new Date(NOW.getTime() - 60 * 60_000),
      expiresAt: EXPIRES,
    });
  }
  await db.insert(featureFlags).values({
    key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
    description: "Slack attachment transfer",
    enabled: true,
    defaultEnabled: false,
    killSwitch: false,
    randomizationUnit: "server",
    salt: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
  });
  const [reactionFlag] = await db.select().from(featureFlags)
    .where(eq(featureFlags.key, SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync));
  assert.equal(reactionFlag?.enabled, true);
  assert.equal(reactionFlag?.defaultEnabled, false);
  assert.equal(reactionFlag?.killSwitch, false);
  assert.equal(reactionFlag?.randomizationUnit, "server");
  for (const flag of Object.values(SLACK_BRIDGE_FEATURE_FLAG_KEYS)) {
    assert.ok(await updateFeatureFlag(flag, { defaultEnabled: true }));
  }
  const file = await writeRuntimeConfig({
    registrationId: registration.id,
    installId: install.id,
    serverId: server.id,
    channelId: channel.id,
    bindingId: binding.id,
  });
  const packet: SlackBridgeLocalRealAuthorityInput = {
    schema: "slack-bridge-local-real-authority.v1",
    registrationId: registration.id,
    installId: install.id,
    providerAuthorityId: TEAM_ID,
    providerConversationId: CONVERSATION_ID,
    providerConversationKind: "public_channel",
    privacyClass: "public",
    connectionEpoch: 2,
    credentialRevision: 2,
    bindingId: binding.id,
    bindingEpoch: 1,
    memberRevision: 2,
    contextRevision: 2,
    consentRevision: 1,
    observedAt: NOW.toISOString(),
    expiresAt: EXPIRES.toISOString(),
    actors: actorInputs.map((actor) => ({ ...actor, projectionRevision: 2 })),
  };
  const env = {
    NODE_ENV: "development",
    SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE: file.path,
  };
  const baselineChannelCount = (await db.select().from(channels)).length;
  return {
    db,
    owner,
    channel,
    registration,
    install,
    binding,
    authorPolicy,
    actors,
    file,
    packet,
    env,
    baselineChannelCount,
  };
}

test("real-authority preparation keeps frozen display fail-closed until an explicit policy update", async () => {
  const surface = await fixture();
  try {
    await replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    const renamedDisplayName = "Renamed Real Authority Owner";
    await surface.db.update(users).set({ displayName: renamedDisplayName })
      .where(eq(users.id, surface.owner.id));
    const renewedObservedAt = new Date(NOW.getTime() + 30 * 60_000);
    const renewedExpiresAt = new Date(renewedObservedAt.getTime() + 60 * 60_000);
    const renewedPacket: SlackBridgeLocalRealAuthorityInput = {
      ...surface.packet,
      observedAt: renewedObservedAt.toISOString(),
      expiresAt: renewedExpiresAt.toISOString(),
    };
    const beforePolicy = (await surface.db.select().from(externalAuthorPolicies))[0]!;
    const beforeActors = await surface.db.select().from(externalActorProjections);
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv(renewedPacket, surface.env, {
        db: surface.db,
        now: () => renewedObservedAt,
      }),
      /author policy display name mismatch/,
    );
    assert.deepEqual(
      (await surface.db.select().from(externalAuthorPolicies))[0],
      beforePolicy,
      "freshness renewal cannot silently refresh a frozen author identity",
    );
    assert.deepEqual(
      (await surface.db.select().from(externalActorProjections)).map((actor) => actor.observedAt),
      beforeActors.map((actor) => actor.observedAt),
      "the rejected renewal cannot partially advance provider freshness",
    );

    const policyUpdate = await setExternalAuthorPolicyState({
      serverId: surface.channel.serverId,
      requestingUserId: surface.owner.id,
      authority: {
        provider: "slack",
        registrationId: surface.registration.id,
        installId: surface.install.id,
        bindingId: surface.binding.id,
        bindingEpoch: surface.binding.bindingEpoch,
        consentRevision: surface.packet.consentRevision,
      },
      authorType: "user",
      authorId: surface.owner.id,
      state: "granted",
    }, surface.db);
    assert.equal(policyUpdate.created, false);
    assert.equal(policyUpdate.policy.id, surface.authorPolicy.id);
    assert.equal(policyUpdate.policy.displayName, renamedDisplayName);
    const receipt = await replaceSlackBridgeLocalRealAuthorityFromEnv(renewedPacket, surface.env, {
      db: surface.db,
      now: () => renewedObservedAt,
    });
    assert.equal(receipt.authorPolicyCount, 1);
    const policies = await surface.db.select().from(externalAuthorPolicies);
    assert.equal(policies.length, 1, "the explicit control-plane update preserves the unique policy");
    assert.equal(policies[0]!.id, surface.authorPolicy.id);
    assert.equal(policies[0]!.displayName, renamedDisplayName);

    const afterRuntime = await createSlackBridgeLocalRuntimeFromEnv(surface.env, {
      db: surface.db,
      now: () => renewedObservedAt,
      runWorkerOnce: async () => ({ kind: "empty" as const }),
    });
    assert.ok(afterRuntime);
    afterRuntime.start();
    const committed = await broadcastAndDeliver(createIo(), noopOrchestrator, {
      channelId: surface.channel.id,
      senderType: "user",
      senderId: surface.owner.id,
      senderName: renamedDisplayName,
      content: "prepared outbound",
      randomId: "real-authority-display-preparation-green",
    });
    await afterRuntime.stop();
    const deliveries = await surface.db.select().from(externalOutboundDeliveries);
    assert.equal((await surface.db.select().from(messages)).length, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.sourceMessageId, committed.id);
  } finally {
    await surface.file.cleanup();
  }
});

test("real-authority runtime starts before the first outbound author policy is granted", async () => {
  const surface = await fixture();
  try {
    await surface.db.delete(externalAuthorPolicies)
      .where(eq(externalAuthorPolicies.id, surface.authorPolicy.id));
    const receipt = await replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    assert.equal(receipt.authorPolicyCount, 0);

    const runtime = await createSlackBridgeLocalRuntimeFromEnv(surface.env, {
      db: surface.db,
      now: () => NOW,
      runWorkerOnce: async () => ({ kind: "empty" as const }),
    });
    assert.ok(runtime);
    runtime.start();
    await runtime.stop();
  } finally {
    await surface.file.cleanup();
  }
});

test("real-authority runtime accepts independent Human and Agent author policies", async () => {
  const surface = await fixture();
  try {
    const [agent] = await surface.db.insert(agents).values({
      serverId: surface.channel.serverId,
      name: `real-authority-agent-${randomUUID().slice(0, 8)}`,
      displayName: "Real Authority Agent",
      status: "active",
    }).returning();
    await surface.db.insert(externalAuthorPolicies).values({
      serverId: surface.channel.serverId,
      provider: "slack",
      appRegistrationId: surface.registration.id,
      installId: surface.install.id,
      bindingId: surface.binding.id,
      bindingEpoch: 1,
      authorType: "agent",
      authorId: agent.id,
      displayName: agent.displayName!,
      fallbackKind: "agent",
      consentRevision: 1,
      state: "granted",
    });

    const receipt = await replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    assert.equal(receipt.authorPolicyCount, 2);
    const runtime = await createSlackBridgeLocalRuntimeFromEnv(surface.env, {
      db: surface.db,
      now: () => NOW,
      runWorkerOnce: async () => ({ kind: "empty" as const }),
    });
    assert.ok(runtime);
    runtime.start();
    await runtime.stop();
  } finally {
    await surface.file.cleanup();
  }
});

test("real-authority accepts only an existing canonical thread target under the bound Raft channel", async () => {
  const surface = await fixture();
  try {
    const [root] = await surface.db.insert(messages).values({
      channelId: surface.channel.id,
      senderType: "user",
      senderId: surface.owner.id,
      content: "existing canonical outbound root",
    }).returning();
    const [thread] = await surface.db.insert(channels).values({
      serverId: surface.channel.serverId,
      name: `real-authority-thread-${randomUUID()}`,
      type: "thread",
      parentMessageId: root!.id,
    }).returning();
    await surface.db.update(messages).set({ threadId: thread!.id }).where(eq(messages.id, root!.id));

    const config = await surface.file.read();
    const topLevelBinding = config.outbound!.bindings[0]!;
    config.outbound!.bindings.push({
      ...topLevelBinding,
      sourceConversationId: thread!.id,
      canonicalRootMessageId: root!.id,
      level: "thread",
      oracle: { ...topLevelBinding.oracle, level: "thread" },
    });
    config.outbound!.bindings[1]!.canonicalRootMessageId = randomUUID();
    await writeFile(surface.file.path, JSON.stringify(config), { mode: 0o600 });
    let invalidTargetMutationReached = false;
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
        db: surface.db,
        now: () => NOW,
        onPhase(phase) {
          if (phase === "after_binding_update") invalidTargetMutationReached = true;
        },
      }),
      /Raft target mismatch/,
    );
    assert.equal(invalidTargetMutationReached, false,
      "an invalid canonical thread target rejects before authority mutation phases");
    assert.equal((await surface.db.select().from(externalChannelBindings))[0]!.connectionEpoch, 1);

    config.outbound!.bindings[1]!.canonicalRootMessageId = root!.id;
    await writeFile(surface.file.path, JSON.stringify(config), { mode: 0o600 });
    await replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
      db: surface.db,
      now: () => NOW,
    });

    const verified = await verifySlackBridgeLocalRealAuthorityFromEnv(surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    assert.equal(verified?.bindingId, surface.binding.id);

    const runtime = await createSlackBridgeLocalRuntimeFromEnv(surface.env, {
      db: surface.db,
      now: () => NOW,
      runWorkerOnce: async () => ({ kind: "empty" as const }),
    });
    assert.ok(runtime);
    runtime.start();
    assert.ok(runtime.resolveAuthorPolicyAuthority);
    assert.deepEqual(await runtime.resolveAuthorPolicyAuthority({
      serverId: surface.channel.serverId,
      bindingId: surface.binding.id,
      now: NOW,
    }), {
      provider: "slack",
      registrationId: surface.registration.id,
      installId: surface.install.id,
      bindingId: surface.binding.id,
      bindingEpoch: 1,
      consentRevision: 1,
    }, "top-level and thread carriers with one authority resolve one author-policy grant");
    const reply = await broadcastAndDeliver(createIo(), noopOrchestrator, {
      channelId: thread!.id,
      senderType: "user",
      senderId: surface.owner.id,
      senderName: surface.owner.displayName!,
      content: "thread target is authorized at send time",
      randomId: "real-authority-existing-thread-green",
    });
    await runtime.stop();
    const deliveries = await surface.db.select().from(externalOutboundDeliveries);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.sourceMessageId, reply.id);
    assert.equal(deliveries[0]!.renderSnapshot.level, "thread");
    assert.equal(deliveries[0]!.renderSnapshot.canonicalRootMessageId, root!.id);

    const consistentConfigBytes = await readFile(surface.file.path, "utf8");
    const divergentConfig = await surface.file.read();
    delete divergentConfig.realAuthority;
    divergentConfig.outbound!.bindings[1]!.consentRevision = 2;
    await writeFile(surface.file.path, JSON.stringify(divergentConfig), { mode: 0o600 });
    const divergentRuntime = await createSlackBridgeLocalRuntimeFromEnv(surface.env, {
      db: surface.db,
      now: () => NOW,
      runWorkerOnce: async () => ({ kind: "empty" as const }),
    });
    assert.ok(divergentRuntime);
    assert.ok(divergentRuntime.resolveAuthorPolicyAuthority);
    assert.equal(await divergentRuntime.resolveAuthorPolicyAuthority({
      serverId: surface.channel.serverId,
      bindingId: surface.binding.id,
      now: NOW,
    }), null, "carriers with divergent policy authority remain fail-closed");
    await divergentRuntime.stop();
    await writeFile(surface.file.path, consistentConfigBytes, { mode: 0o600 });
    assert.equal(await readFile(surface.file.path, "utf8"), consistentConfigBytes,
      "the authority config is restored byte-for-byte after the negative carrier check");

    const validConfig = await surface.file.read();
    validConfig.outbound!.bindings[1]!.canonicalRootMessageId = randomUUID();
    await writeFile(surface.file.path, JSON.stringify(validConfig), { mode: 0o600 });
    await assert.rejects(
      verifySlackBridgeLocalRealAuthorityFromEnv(surface.env, { db: surface.db, now: () => NOW }),
      /Raft target mismatch/,
      "a thread binding cannot name a missing or unrelated canonical root",
    );

    const [unrelatedRoot] = await surface.db.insert(messages).values({
      channelId: surface.channel.id,
      senderType: "user",
      senderId: surface.owner.id,
      content: "existing but unrelated root",
    }).returning();
    validConfig.outbound!.bindings[1]!.canonicalRootMessageId = unrelatedRoot!.id;
    await writeFile(surface.file.path, JSON.stringify(validConfig), { mode: 0o600 });
    await assert.rejects(
      verifySlackBridgeLocalRealAuthorityFromEnv(surface.env, { db: surface.db, now: () => NOW }),
      /Raft target mismatch/,
      "an existing root in the bound channel cannot authorize a different thread",
    );

    validConfig.outbound!.bindings[1]!.canonicalRootMessageId = root!.id;
    validConfig.outbound!.bindings[1]!.sourceConversationId = surface.channel.id;
    await writeFile(surface.file.path, JSON.stringify(validConfig), { mode: 0o600 });
    await assert.rejects(
      verifySlackBridgeLocalRealAuthorityFromEnv(surface.env, { db: surface.db, now: () => NOW }),
      /Raft target mismatch/,
      "a thread binding cannot reuse the top-level channel as its source",
    );

    const otherServer = await createServer(
      "Other Thread Authority",
      `other-thread-authority-${randomUUID()}`,
      surface.owner.id,
    );
    const [otherChannel] = await surface.db.insert(channels).values({
      serverId: otherServer.id,
      name: `other-thread-parent-${randomUUID()}`,
      type: "channel",
    }).returning();
    const [otherRoot] = await surface.db.insert(messages).values({
      channelId: otherChannel!.id,
      senderType: "user",
      senderId: surface.owner.id,
      content: "cross-server root",
    }).returning();
    const [otherThread] = await surface.db.insert(channels).values({
      serverId: otherServer.id,
      name: `other-thread-${randomUUID()}`,
      type: "thread",
      parentMessageId: otherRoot!.id,
    }).returning();
    await surface.db.update(messages).set({ threadId: otherThread!.id }).where(eq(messages.id, otherRoot!.id));
    validConfig.outbound!.bindings[1]!.sourceConversationId = otherThread!.id;
    validConfig.outbound!.bindings[1]!.canonicalRootMessageId = otherRoot!.id;
    await writeFile(surface.file.path, JSON.stringify(validConfig), { mode: 0o600 });
    await assert.rejects(
      verifySlackBridgeLocalRealAuthorityFromEnv(surface.env, { db: surface.db, now: () => NOW }),
      /Raft target mismatch/,
      "a canonical thread on another Server cannot reuse this binding authority",
    );

    validConfig.outbound!.bindings[1]!.canonicalRootMessageId = root!.id;
    validConfig.outbound!.bindings[1]!.sourceConversationId = thread!.id;
    await writeFile(surface.file.path, JSON.stringify(validConfig), { mode: 0o600 });
    await surface.db.update(messages).set({ threadId: null }).where(eq(messages.id, root!.id));
    await assert.rejects(
      verifySlackBridgeLocalRealAuthorityFromEnv(surface.env, { db: surface.db, now: () => NOW }),
      /Raft target mismatch/,
      "the root must point back to the exact active thread channel",
    );
  } finally {
    await surface.file.cleanup();
  }
});

test("real-authority replacement is existing-only, rollback-safe, restart-gated, and idempotent", async () => {
  const surface = await fixture();
  try {
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv({
        ...surface.packet,
        actors: surface.packet.actors.slice(0, 1),
      }, surface.env, { db: surface.db, now: () => NOW }),
      /actor set is incomplete or has extras/,
    );
    assert.equal((await surface.db.select().from(externalChannelBindings))[0]!.connectionEpoch, 1);

    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv({
        ...surface.packet,
        actors: surface.packet.actors.map((actor, index) => ({
          ...actor,
          projectionRevision: index === 0 ? 3 : actor.projectionRevision,
        })),
      }, surface.env, { db: surface.db, now: () => NOW }),
      /existing actor precheck failed/,
      "actor revisions may advance by exactly one, never skip",
    );

    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv({
        ...surface.packet,
        connectionEpoch: 3,
      }, surface.env, {
        db: surface.db,
        now: () => NOW,
      }),
      /config revision is partial or skipped/,
      "binding connection epochs may advance by exactly one, never skip",
    );

    await surface.db.update(externalActorProjections).set({ projectionRevision: 2 })
      .where(eq(externalActorProjections.id, surface.actors[0]!.id));
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
        db: surface.db,
        now: () => NOW,
      }),
      /partial current state is not replaceable/,
    );
    await surface.db.update(externalActorProjections).set({ projectionRevision: 1 })
      .where(eq(externalActorProjections.id, surface.actors[0]!.id));

    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
        db: surface.db,
        now: () => NOW,
        onPhase(phase) {
          if (phase === "after_binding_update") throw new Error("injected transaction failure");
        },
      }),
      /injected transaction failure/,
    );
    assert.equal((await surface.db.select().from(externalChannelBindings))[0]!.connectionEpoch, 1);
    assert.deepEqual(
      (await surface.db.select().from(externalActorProjections)).map((actor) => actor.projectionRevision),
      [1, 1],
    );

    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
        db: surface.db,
        now: () => NOW,
        onPhase(phase) {
          if (phase === "after_db_commit") throw new Error("injected config handoff failure");
        },
      }),
      /injected config handoff failure/,
    );
    assert.equal((await surface.db.select().from(externalChannelBindings))[0]!.connectionEpoch, 2);
    assert.equal((await surface.file.read()).outbound!.bindings[0]!.connectionEpoch, 1);
    await assert.rejects(
      verifySlackBridgeLocalOutboundAuthorityFromEnv(surface.env, { db: surface.db, now: () => NOW }),
      /outbound authority mismatch/,
      "a DB-committed/config-stale partial handoff must fail the explicit pre-start gate",
    );

    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
        db: surface.db,
        now: () => NOW,
        async onPhase(phase) {
          if (phase !== "before_config_rename") return;
          const concurrent = await surface.file.read();
          concurrent.outbound!.workerId = "concurrent-authorized-worker";
          await writeFile(surface.file.path, JSON.stringify(concurrent), { mode: 0o600 });
        },
      }),
      /config changed during real-authority replacement/,
      "an injected concurrent config rewrite must not be overwritten",
    );
    assert.equal((await surface.file.read()).outbound!.workerId, "concurrent-authorized-worker");

    const receipt = await replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    assert.equal(receipt.connectionEpoch, 2);
    assert.equal(receipt.credentialRevision, 2);
    assert.equal(receipt.actorCount, 2);
    assert.equal(receipt.addressabilityCount, 2);
    const config = await surface.file.read();
    assert.equal(config.outbound!.bindings[0]!.connectionEpoch, 2);
    assert.equal(config.outbound!.bindings[0]!.membership.receiptRevision, 2);
    assert.equal(config.outbound!.bindings[0]!.oracle.oracleReceiptRevision, 2);
    assert.equal(config.outbound!.workerId, "concurrent-authorized-worker");
    assert.ok(config.realAuthority);
    assert.equal(config.realAuthority.actorCount, 2);

    const actorRows = await surface.db.select().from(externalActorProjections);
    const addressRows = await surface.db.select().from(externalAddressabilityProjections);
    assert.deepEqual(actorRows.map((actor) => actor.id).sort(), surface.actors.map((actor) => actor.id).sort());
    assert.deepEqual(actorRows.map((actor) => actor.projectionRevision), [2, 2]);
    assert.deepEqual(addressRows.map((address) => address.connectionEpoch), [2, 2]);
    assert.equal((await surface.db.select().from(externalChannelBindings)).length, 1);
    assert.equal(
      (await surface.db.select().from(channels)).length,
      surface.baselineChannelCount,
      "no Raft target is created",
    );

    const verified = await verifySlackBridgeLocalRealAuthorityFromEnv(surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    assert.deepEqual(verified, receipt);
    await surface.db.update(externalActorProjections).set({
      observedAt: new Date(NOW.getTime() - 1),
    }).where(eq(externalActorProjections.id, surface.actors[0]!.id));
    await assert.rejects(
      verifySlackBridgeLocalRealAuthorityFromEnv(surface.env, {
        db: surface.db,
        now: () => NOW,
      }),
      /actor mismatch/,
      "listener pre-start verification must reject stale actor observation time",
    );
    await surface.db.update(externalActorProjections).set({ observedAt: NOW })
      .where(eq(externalActorProjections.id, surface.actors[0]!.id));
    await verifySlackBridgeLocalOutboundAuthorityFromEnv(surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    const runtime = await createSlackBridgeLocalRuntimeFromEnv(surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    assert.ok(runtime);
    await runtime.stop();

    const nextObservedAt = new Date(NOW.getTime() + 60_000);
    const nextExpiresAt = new Date(EXPIRES.getTime() + 60_000);
    const nextPacket: SlackBridgeLocalRealAuthorityInput = {
      ...surface.packet,
      connectionEpoch: 3,
      credentialRevision: 3,
      memberRevision: 3,
      contextRevision: 3,
      observedAt: nextObservedAt.toISOString(),
      expiresAt: nextExpiresAt.toISOString(),
      actors: surface.packet.actors.map((actor) => ({
        ...actor,
        displayName: `${actor.displayName} Next`,
        projectionRevision: 3,
      })),
    };
    await surface.db.update(externalAppInstalls).set({
      connectionEpoch: 3,
      credentialRevision: 3,
    }).where(eq(externalAppInstalls.id, surface.install.id));
    await surface.db.update(externalAppCredentials).set({ credentialRevision: 3 })
      .where(eq(externalAppCredentials.installId, surface.install.id));
    const nextReceipt = await replaceSlackBridgeLocalRealAuthorityFromEnv(nextPacket, surface.env, {
      db: surface.db,
      now: () => nextObservedAt,
    });
    assert.equal(nextReceipt.connectionEpoch, 3);
    assert.equal(nextReceipt.credentialRevision, 3);
    assert.equal((await surface.file.read()).outbound!.bindings[0]!.connectionEpoch, 3);
    const repeated = await replaceSlackBridgeLocalRealAuthorityFromEnv(nextPacket, surface.env, {
      db: surface.db,
      now: () => nextObservedAt,
    });
    assert.deepEqual(repeated, nextReceipt);
    assert.deepEqual(
      (await surface.db.select().from(externalActorProjections)).map((actor) => actor.projectionRevision),
      [3, 3],
      "a second replacement advances once and its exact retry advances no further",
    );
  } finally {
    await surface.file.cleanup();
  }
});

test("real-authority replacement renews only freshness on a same-revision provider observation", async () => {
  const surface = await fixture();
  try {
    await replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    const beforeBinding = (await surface.db.select().from(externalChannelBindings))[0]!;
    const beforeActors = await surface.db.select().from(externalActorProjections);
    const beforeAddresses = await surface.db.select().from(externalAddressabilityProjections);
    const renewedObservedAt = new Date(EXPIRES.getTime() + 60_000);
    const renewedExpiresAt = new Date(renewedObservedAt.getTime() + 60 * 60_000);
    const renewedPacket: SlackBridgeLocalRealAuthorityInput = {
      ...surface.packet,
      observedAt: renewedObservedAt.toISOString(),
      expiresAt: renewedExpiresAt.toISOString(),
    };

    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv(renewedPacket, surface.env, {
        db: surface.db,
        now: () => renewedObservedAt,
        onPhase(phase) {
          if (phase === "after_freshness_update") throw new Error("injected freshness renewal failure");
        },
      }),
      /injected freshness renewal failure/,
    );
    assert.deepEqual(
      (await surface.db.select().from(externalActorProjections)).map((actor) => actor.observedAt),
      beforeActors.map((actor) => actor.observedAt),
      "freshness timestamps roll back with the transaction",
    );
    assert.deepEqual(
      (await surface.db.select().from(externalAddressabilityProjections)).map((address) => address.expiresAt),
      beforeAddresses.map((address) => address.expiresAt),
    );
    assert.equal((await surface.file.read()).realAuthority!.observedAt, NOW.toISOString());

    await surface.db.update(externalActorProjections).set({ observedAt: new Date(NOW.getTime() - 1) })
      .where(eq(externalActorProjections.id, surface.actors[0]!.id));
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv(renewedPacket, surface.env, {
        db: surface.db,
        now: () => renewedObservedAt,
      }),
      /actor mismatch/,
      "a partial freshness preimage cannot be normalized",
    );
    await surface.db.update(externalActorProjections).set({ observedAt: NOW })
      .where(eq(externalActorProjections.id, surface.actors[0]!.id));

    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv(renewedPacket, surface.env, {
        db: surface.db,
        now: () => renewedObservedAt,
        async onPhase(phase) {
          if (phase !== "before_config_rename") return;
          const concurrent = await surface.file.read();
          concurrent.outbound!.workerId = "concurrent-renewal-worker";
          await writeFile(surface.file.path, JSON.stringify(concurrent), { mode: 0o600 });
        },
      }),
      /config changed during real-authority replacement/,
    );
    assert.deepEqual(
      (await surface.db.select().from(externalActorProjections)).map((actor) => actor.observedAt),
      [renewedObservedAt, renewedObservedAt],
      "the freshness transaction may commit before a failed config handoff",
    );
    assert.equal(
      (await surface.file.read()).realAuthority!.observedAt,
      NOW.toISOString(),
      "a failed config CAS leaves the previous sealed receipt intact",
    );

    const receipt = await replaceSlackBridgeLocalRealAuthorityFromEnv(renewedPacket, surface.env, {
      db: surface.db,
      now: () => renewedObservedAt,
    });
    assert.equal(receipt.connectionEpoch, 2);
    assert.equal(receipt.credentialRevision, 2);
    assert.equal(receipt.memberRevision, 2);
    assert.equal(receipt.contextRevision, 2);
    const afterBinding = (await surface.db.select().from(externalChannelBindings))[0]!;
    const afterActors = await surface.db.select().from(externalActorProjections);
    const afterAddresses = await surface.db.select().from(externalAddressabilityProjections);
    assert.equal(afterBinding.id, beforeBinding.id);
    assert.equal(afterBinding.connectionEpoch, beforeBinding.connectionEpoch);
    assert.equal(afterBinding.updatedAt.getTime(), beforeBinding.updatedAt.getTime());
    assert.deepEqual(afterActors.map((actor) => actor.id), beforeActors.map((actor) => actor.id));
    assert.deepEqual(afterActors.map((actor) => actor.projectionRevision), [2, 2]);
    assert.deepEqual(afterActors.map((actor) => actor.observedAt), [renewedObservedAt, renewedObservedAt]);
    assert.deepEqual(afterAddresses.map((address) => address.id), beforeAddresses.map((address) => address.id));
    assert.deepEqual(afterAddresses.map((address) => address.connectionEpoch), [2, 2]);
    assert.deepEqual(afterAddresses.map((address) => address.memberRevision), [2, 2]);
    assert.deepEqual(afterAddresses.map((address) => address.contextRevision), [2, 2]);
    assert.deepEqual(afterAddresses.map((address) => address.observedAt), [renewedObservedAt, renewedObservedAt]);
    assert.deepEqual(afterAddresses.map((address) => address.expiresAt), [renewedExpiresAt, renewedExpiresAt]);
    const config = await surface.file.read();
    assert.equal(config.realAuthority!.observedAt, renewedObservedAt.toISOString());
    assert.equal(config.realAuthority!.expiresAt, renewedExpiresAt.toISOString());
    assert.equal(config.outbound!.bindings[0]!.membership.expiresAt, renewedExpiresAt.toISOString());
    assert.equal(config.outbound!.bindings[0]!.oracle.expiresAt, renewedExpiresAt.toISOString());
    assert.equal(config.outbound!.workerId, "concurrent-renewal-worker");
    assert.equal((await surface.db.select().from(channels)).length, surface.baselineChannelCount);
    assert.equal((await surface.db.select().from(messages)).length, 0);
    assert.equal((await surface.db.select().from(externalOutboundDeliveries)).length, 0);

    const verified = await verifySlackBridgeLocalRealAuthorityFromEnv(surface.env, {
      db: surface.db,
      now: () => renewedObservedAt,
    });
    assert.deepEqual(verified, receipt, "the real-authority pre-start gate accepts the renewed receipt");
    const repeated = await replaceSlackBridgeLocalRealAuthorityFromEnv(renewedPacket, surface.env, {
      db: surface.db,
      now: () => renewedObservedAt,
    });
    assert.deepEqual(repeated, receipt, "an exact freshness packet replay remains idempotent");

    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv({
        ...renewedPacket,
        expiresAt: new Date(renewedExpiresAt.getTime() + 60_000).toISOString(),
      }, surface.env, { db: surface.db, now: () => renewedObservedAt }),
      /config receipt is partial or skipped/,
      "the same observation cannot extend its expiry",
    );
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv({
        ...renewedPacket,
        observedAt: new Date(renewedObservedAt.getTime() - 1).toISOString(),
        expiresAt: new Date(renewedExpiresAt.getTime() + 60_000).toISOString(),
      }, surface.env, { db: surface.db, now: () => renewedObservedAt }),
      /config receipt is partial or skipped/,
      "an older observation cannot renew current authority",
    );
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv({
        ...renewedPacket,
        observedAt: new Date(renewedObservedAt.getTime() + 1).toISOString(),
        expiresAt: new Date(renewedExpiresAt.getTime() + 60_000).toISOString(),
        actors: renewedPacket.actors.map((actor, index) => index === 0
          ? { ...actor, displayName: `${actor.displayName} Drifted` }
          : actor),
      }, surface.env, {
        db: surface.db,
        now: () => new Date(renewedObservedAt.getTime() + 1),
      }),
      /config receipt is partial or skipped/,
      "same-revision actor drift is not a freshness renewal",
    );
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv({
        ...renewedPacket,
        observedAt: new Date(renewedObservedAt.getTime() + 1).toISOString(),
        expiresAt: new Date(renewedExpiresAt.getTime() + 60_000).toISOString(),
      }, surface.env, { db: surface.db, now: () => renewedObservedAt }),
      /input is stale or from the future/,
    );
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv({
        ...renewedPacket,
        observedAt: new Date(renewedObservedAt.getTime() + 1).toISOString(),
        expiresAt: renewedObservedAt.toISOString(),
      }, surface.env, { db: surface.db, now: () => new Date(renewedObservedAt.getTime() + 1) }),
      /freshness window is invalid|input is stale or from the future/,
    );
  } finally {
    await surface.file.cleanup();
  }
});

test("legacy app-manifest observation renewal is append-only and never substitutes for install authority", async () => {
  const surface = await fixture();
  try {
    await replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    const renewedObservedAt = new Date(EXPIRES.getTime() + 60_000);
    const renewedExpiresAt = new Date(renewedObservedAt.getTime() + 60 * 60_000);
    const renewedAuthority: SlackBridgeLocalRealAuthorityInput = {
      ...surface.packet,
      observedAt: renewedObservedAt.toISOString(),
      expiresAt: renewedExpiresAt.toISOString(),
    };
    await replaceSlackBridgeLocalRealAuthorityFromEnv(renewedAuthority, surface.env, {
      db: surface.db,
      now: () => renewedObservedAt,
    });
    await assert.doesNotReject(
      verifySlackBridgeLocalOutboundAuthorityFromEnv(surface.env, {
        db: surface.db,
        now: () => renewedObservedAt,
      }),
      "an expired app-manifest observation does not revoke a current provider install-grant receipt",
    );

    const oldManifest = (await surface.db.select().from(externalAppManifestReceipts))[0]!;
    const manifestInput: SlackBridgeLocalManifestAuthorityInput = {
      schema: "slack-bridge-local-manifest-authority.v1",
      registrationId: surface.registration.id,
      receiptRevision: 3,
      managerCredentialRevision: 2,
      providerAppId: APP_ID,
      normalizedManifestHash: "real-authority-manifest-v1",
      normalizedScopes: ["channels:history", "channels:read", "chat:write", "users:read"],
      normalizedEvents: ["message.channels"],
      normalizedSettings: {},
      observedAt: renewedObservedAt.toISOString(),
      expiresAt: renewedExpiresAt.toISOString(),
    };

    await assert.rejects(
      renewSlackBridgeLocalManifestAuthorityFromEnv(manifestInput, surface.env, {
        db: surface.db,
        now: () => renewedObservedAt,
        onPhase(phase) {
          if (phase === "after_manifest_insert") throw new Error("injected manifest transaction failure");
        },
      }),
      /injected manifest transaction failure/,
    );
    assert.equal((await surface.db.select().from(externalAppManifestReceipts)).length, 1);
    assert.deepEqual((await surface.db.select().from(externalAppManifestReceipts))[0], oldManifest,
      "a failed renewal does not mutate the expired receipt");

    await assert.rejects(
      renewSlackBridgeLocalManifestAuthorityFromEnv(manifestInput, surface.env, {
        db: surface.db,
        now: () => renewedObservedAt,
        onPhase(phase) {
          if (phase === "after_db_commit") throw new Error("injected lost response");
        },
      }),
      /injected lost response/,
    );
    assert.equal((await surface.db.select().from(externalAppManifestReceipts)).length, 2);
    const receipt = await renewSlackBridgeLocalManifestAuthorityFromEnv(manifestInput, surface.env, {
      db: surface.db,
      now: () => renewedObservedAt,
    });
    assert.equal(receipt.receiptRevision, 3);
    assert.equal((await surface.db.select().from(externalAppManifestReceipts)).length, 2,
      "an exact lost-response replay does not append twice");
    const manifests = await surface.db.select().from(externalAppManifestReceipts);
    assert.deepEqual(manifests.find((manifest) => manifest.id === oldManifest.id), oldManifest,
      "manifest history remains immutable");
    assert.equal(manifests.find((manifest) => manifest.receiptRevision === 3)!.expiresAt.getTime(),
      renewedExpiresAt.getTime());

    await verifySlackBridgeLocalOutboundAuthorityFromEnv(surface.env, {
      db: surface.db,
      now: () => renewedObservedAt,
    });
    const runtime = await createSlackBridgeLocalRuntimeFromEnv(surface.env, {
      db: surface.db,
      now: () => renewedObservedAt,
      runWorkerOnce: async () => ({ kind: "empty" as const }),
    });
    assert.ok(runtime?.runtimeResolver, "legacy app-manifest renewal does not disturb the install-grant resolver");
    await runtime!.stop();
    assert.equal((await surface.db.select().from(messages)).length, 0);
    assert.equal((await surface.db.select().from(externalOutboundDeliveries)).length, 0);
  } finally {
    await surface.file.cleanup();
  }
});

test("manifest-manager observation resolves independent custody and returns a bounded exact-next provider observation", async () => {
  const surface = await fixture();
  try {
    await replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    const token = "xoxe.test-only-manager-token-never-returned";
    const credential = await writeManifestManagerCredential({
      directory: dirname(surface.file.path),
      registrationId: surface.registration.id,
      token,
    });
    const observedAt = new Date(EXPIRES.getTime() + 60_000);
    const manifestsBefore = await surface.db.select().from(externalAppManifestReceipts);
    let providerCalls = 0;
    const observation = await observeSlackBridgeLocalManifestAuthorityFromEnv({
      ...surface.env,
      SLACK_BRIDGE_LOCAL_MANIFEST_MANAGER_CREDENTIAL_FILE: credential.path,
    }, {
      db: surface.db,
      now: () => observedAt,
      fetch: async (url, init) => {
        providerCalls += 1;
        assert.equal(String(url), "https://slack.com/api/apps.manifest.export");
        assert.equal(init?.method, "POST");
        assert.deepEqual(init?.headers, {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        });
        assert.equal(init?.body, `app_id=${APP_ID}`);
        assert.equal(init?.redirect, "error");
        return new Response(JSON.stringify({
          ok: true,
          manifest: {
            oauth_config: {
              scopes: {
                bot: ["users:read", "channels:read", "chat:write", "channels:history"],
              },
            },
            settings: {
              event_subscriptions: {
                bot_events: ["message.channels"],
                request_url: "https://bridge-real-authority.example.test/api/slack-bridge/events",
              },
              socket_mode_enabled: false,
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(providerCalls, 1);
    assert.equal(observation.receiptRevision, 3);
    assert.equal(observation.managerCredentialRevision, 2);
    assert.equal(observation.normalizedManifestHash, "real-authority-manifest-v1");
    assert.deepEqual(observation.normalizedScopes, [
      "channels:history",
      "channels:read",
      "chat:write",
      "users:read",
    ]);
    assert.deepEqual(observation.normalizedEvents, ["message.channels"]);
    assert.deepEqual(observation.normalizedSettings, {});
    assert.equal(observation.observedAt, observedAt.toISOString());
    assert.equal(observation.expiresAt, new Date(observedAt.getTime() + 60 * 60_000).toISOString());
    assert.ok(!JSON.stringify(observation).includes(token), "the provider token is never projected");
    assert.deepEqual(await surface.db.select().from(externalAppManifestReceipts), manifestsBefore,
      "provider observation itself is read-only");

    await renewSlackBridgeLocalManifestAuthorityFromEnv(observation, surface.env, {
      db: surface.db,
      now: () => observedAt,
    });
    assert.equal((await surface.db.select().from(externalAppManifestReceipts)).length, 2);
  } finally {
    await surface.file.cleanup();
  }
});

test("manifest-manager observation fails closed across custody, authority, provider, size, and redaction boundaries", async () => {
  const surface = await fixture();
  try {
    await replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    const token = "xoxe.test-only-manager-token-sensitive";
    const credential = await writeManifestManagerCredential({
      directory: dirname(surface.file.path),
      registrationId: surface.registration.id,
      token,
    });
    const observedAt = new Date(EXPIRES.getTime() + 60_000);
    const env = {
      ...surface.env,
      SLACK_BRIDGE_LOCAL_MANIFEST_MANAGER_CREDENTIAL_FILE: credential.path,
    };
    let providerCalls = 0;
    const validProviderResponse = () => new Response(JSON.stringify({
      ok: true,
      manifest: {
        oauth_config: { scopes: { bot: ["channels:history", "channels:read", "chat:write", "users:read"] } },
        settings: { event_subscriptions: { bot_events: ["message.channels"] } },
      },
    }), { status: 200 });
    const call = (override: Parameters<typeof observeSlackBridgeLocalManifestAuthorityFromEnv>[1] = {}) =>
      observeSlackBridgeLocalManifestAuthorityFromEnv(env, {
        db: surface.db,
        now: () => observedAt,
        fetch: async () => {
          providerCalls += 1;
          return validProviderResponse();
        },
        ...override,
      });

    await assert.rejects(
      observeSlackBridgeLocalManifestAuthorityFromEnv(surface.env, {
        db: surface.db,
        now: () => observedAt,
        fetch: async () => {
          providerCalls += 1;
          return validProviderResponse();
        },
      }),
      /credential file is required/,
    );
    assert.equal(providerCalls, 0);

    await writeFile(credential.path, JSON.stringify({
      ...credential.credential,
      encryptedSecretRef: "local-ref:manifest:wrong",
    }), { mode: 0o600 });
    await assert.rejects(call(), /credential authority mismatch/);
    assert.equal(providerCalls, 0, "a wrong ref rejects before provider I/O");

    await writeFile(credential.path, JSON.stringify({
      ...credential.credential,
      secretRevision: 3,
    }), { mode: 0o600 });
    await assert.rejects(call(), /credential authority mismatch/);
    assert.equal(providerCalls, 0, "a wrong revision rejects before provider I/O");

    await writeFile(credential.path, JSON.stringify(credential.credential), { mode: 0o600 });
    await chmod(credential.path, 0o644);
    await assert.rejects(call(), /permissions must be 0600/);
    assert.equal(providerCalls, 0, "unreadable custody rejects before provider I/O");
    await chmod(credential.path, 0o600);

    await surface.db.update(externalAppRegistrationSecrets).set({
      leaseOwner: "another-manager-reader",
      leaseExpiresAt: observedAt,
    }).where(eq(externalAppRegistrationSecrets.purpose, "manifest_manager"));
    await assert.rejects(call(), /secret reference mismatch/);
    assert.equal(providerCalls, 0, "an active or inconsistent manager lease rejects before provider I/O");
    await surface.db.update(externalAppRegistrationSecrets).set({
      leaseOwner: null,
      leaseExpiresAt: null,
    }).where(eq(externalAppRegistrationSecrets.purpose, "manifest_manager"));

    await assert.rejects(call({
      fetch: async () => {
        providerCalls += 1;
        return new Response(`provider-error-containing-${token}`, { status: 403 });
      },
    }), (error) => error instanceof Error
      && error.message === "Slack Bridge provider manifest export failed"
      && !error.message.includes(token));

    await assert.rejects(call({
      fetch: async () => {
        providerCalls += 1;
        return new Response("x".repeat(1024 * 1024 + 1), {
          status: 200,
          headers: { "content-length": String(1024 * 1024 + 1) },
        });
      },
    }), /provider manifest export failed/);

    await assert.rejects(call({
      fetch: async () => {
        providerCalls += 1;
        const response = validProviderResponse();
        const payload = await response.json() as any;
        payload.manifest.oauth_config.scopes.bot = ["chat:write"];
        return new Response(JSON.stringify(payload), { status: 200 });
      },
    }), /provider manifest observation mismatch/);
    assert.equal((await surface.db.select().from(externalAppManifestReceipts)).length, 1,
      "provider failures and drift never append a receipt");

    await assert.rejects(call({
      fetch: async () => {
        providerCalls += 1;
        await surface.db.update(externalAppRegistrationSecrets).set({
          encryptedSecretRef: "local-ref:manifest:rotated-during-read",
        }).where(eq(externalAppRegistrationSecrets.purpose, "manifest_manager"));
        return validProviderResponse();
      },
    }), /authority changed during provider observation/);
    assert.equal((await surface.db.select().from(externalAppManifestReceipts)).length, 1);

    await assert.rejects(
      observeSlackBridgeLocalManifestAuthorityFromEnv({ ...env, NODE_ENV: "production" }, {
        db: surface.db,
        now: () => observedAt,
        fetch: async () => {
          providerCalls += 1;
          return validProviderResponse();
        },
      }),
      /forbidden in production/,
    );
  } finally {
    await surface.file.cleanup();
  }
});

test("manifest-authority renewal rejects drift and allows only one competing next revision", async () => {
  const surface = await fixture();
  try {
    await replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    const observedAt = new Date(EXPIRES.getTime() + 60_000);
    const expiresAt = new Date(observedAt.getTime() + 60 * 60_000);
    const manifestInput: SlackBridgeLocalManifestAuthorityInput = {
      schema: "slack-bridge-local-manifest-authority.v1",
      registrationId: surface.registration.id,
      receiptRevision: 3,
      managerCredentialRevision: 2,
      providerAppId: APP_ID,
      normalizedManifestHash: "real-authority-manifest-v1",
      normalizedScopes: ["channels:history", "channels:read", "chat:write", "users:read"],
      normalizedEvents: ["message.channels"],
      normalizedSettings: {},
      observedAt: observedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    for (const drift of [{
      ...manifestInput,
      normalizedEvents: ["message.channels", "message.groups"],
    }, {
      ...manifestInput,
      normalizedSettings: { socket_mode: true },
    }, {
      ...manifestInput,
      managerCredentialRevision: 3,
    }, {
      ...manifestInput,
      normalizedScopes: ["channels:history", "channels:read", "chat:write"],
    }, {
      ...manifestInput,
      expiresAt: new Date(expiresAt.getTime() + 1).toISOString(),
    }]) {
      await assert.rejects(
        renewSlackBridgeLocalManifestAuthorityFromEnv(drift, surface.env, {
          db: surface.db,
          now: () => observedAt,
        }),
      );
      assert.equal((await surface.db.select().from(externalAppManifestReceipts)).length, 1,
        "drift rejects before appending a receipt");
    }

    const competing = {
      ...manifestInput,
      observedAt: new Date(observedAt.getTime() + 1).toISOString(),
    };
    const outcomes = await Promise.allSettled([
      renewSlackBridgeLocalManifestAuthorityFromEnv(manifestInput, surface.env, {
        db: surface.db,
        now: () => new Date(observedAt.getTime() + 1),
      }),
      renewSlackBridgeLocalManifestAuthorityFromEnv(competing, surface.env, {
        db: surface.db,
        now: () => new Date(observedAt.getTime() + 1),
      }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    assert.equal((await surface.db.select().from(externalAppManifestReceipts)).length, 2,
      "the registration lock and revision uniqueness permit one append only");
  } finally {
    await surface.file.cleanup();
  }
});

test("real-authority replacement is production-forbidden and rejects config piggyback", async () => {
  const surface = await fixture();
  try {
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, {
        ...surface.env,
        NODE_ENV: "production",
      }, { db: surface.db, now: () => NOW }),
      /forbidden in production/,
    );
    const config = await surface.file.read();
    config.outbound!.bindings.push({
      ...config.outbound!.bindings[0],
      bindingId: randomUUID(),
      sourceConversationId: randomUUID(),
    });
    await writeFile(surface.file.path, JSON.stringify(config), { mode: 0o600 });
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
        db: surface.db,
        now: () => NOW,
      }),
      /detached or future outbound authority/,
    );
    assert.equal((await surface.db.select().from(externalChannelBindings))[0]!.connectionEpoch, 1);
  } finally {
    await surface.file.cleanup();
  }
});

test("real-authority replacement bootstraps only an existing target when outbound config is absent", async () => {
  const surface = await fixture();
  try {
    const initialConfig = await surface.file.read();
    const outboundBootstrap = initialConfig.outbound!;
    delete initialConfig.outbound;
    await writeFile(surface.file.path, JSON.stringify(initialConfig), { mode: 0o600 });

    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv(surface.packet, surface.env, {
        db: surface.db,
        now: () => NOW,
      }),
      /requires outbound config or bootstrap/,
    );
    assert.equal((await surface.db.select().from(externalChannelBindings))[0]!.connectionEpoch, 1);

    let bootstrapMutationReached = false;
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv({
        ...surface.packet,
        outboundBootstrap: {
          ...outboundBootstrap,
          bindings: outboundBootstrap.bindings.map((binding) => ({
            ...binding,
            sourceConversationId: randomUUID(),
          })),
        },
      }, surface.env, {
        db: surface.db,
        now: () => NOW,
        onPhase(phase) {
          if (phase === "after_binding_update") bootstrapMutationReached = true;
        },
      }),
      /bootstrap Raft target mismatch/,
      "a bootstrap packet cannot redirect authority to a new Raft target",
    );
    assert.equal(bootstrapMutationReached, false,
      "a wrong bootstrap target rejects before the database mutation phase");
    assert.equal((await surface.db.select().from(externalChannelBindings))[0]!.connectionEpoch, 1);
    assert.equal((await surface.db.select().from(channels)).length, surface.baselineChannelCount);

    await surface.db.update(externalActorProjections).set({ projectionRevision: 2 })
      .where(eq(externalActorProjections.id, surface.actors[0]!.id));
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv({
        ...surface.packet,
        outboundBootstrap,
      }, surface.env, { db: surface.db, now: () => NOW }),
      /partial current state is not replaceable/,
      "missing config cannot normalize a partial database authority",
    );
    await surface.db.update(externalActorProjections).set({ projectionRevision: 1 })
      .where(eq(externalActorProjections.id, surface.actors[0]!.id));

    const [duplicateChannel] = await surface.db.insert(channels).values({
      serverId: surface.binding.serverId,
      name: `real-authority-duplicate-${randomUUID()}`,
      type: "channel",
    }).returning();
    const [duplicateBinding] = await surface.db.insert(externalChannelBindings).values({
      serverId: surface.binding.serverId,
      registrationId: surface.binding.registrationId,
      installId: surface.binding.installId,
      channelId: duplicateChannel!.id,
      providerConversationId: "C_REAL_AUTHORITY_DUPLICATE",
      providerConversationKind: "public_channel",
      privacyClass: "public",
      grantEpoch: surface.binding.grantEpoch,
      connectionEpoch: surface.binding.connectionEpoch,
      bindingEpoch: surface.binding.bindingEpoch,
      consentedByType: surface.binding.consentedByType,
      consentedById: surface.binding.consentedById,
      consentedAt: surface.binding.consentedAt,
    }).returning();
    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv({
        ...surface.packet,
        outboundBootstrap,
      }, surface.env, { db: surface.db, now: () => NOW }),
      /binding is missing or duplicated/,
      "multiple active database bindings reject before replacement",
    );
    await surface.db.delete(externalChannelBindings)
      .where(eq(externalChannelBindings.id, duplicateBinding!.id));
    await surface.db.delete(channels).where(eq(channels.id, duplicateChannel!.id));

    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv({
        ...surface.packet,
        outboundBootstrap,
      }, surface.env, {
        db: surface.db,
        now: () => NOW,
        onPhase(phase) {
          if (phase === "after_db_commit") throw new Error("injected bootstrap config failure");
        },
      }),
      /injected bootstrap config failure/,
    );
    assert.equal((await surface.db.select().from(externalChannelBindings))[0]!.connectionEpoch, 2);
    assert.equal((await surface.file.read()).outbound, undefined);
    const stoppedRuntime = await createSlackBridgeLocalRuntimeFromEnv(surface.env, {
      db: surface.db,
      now: () => NOW,
    });
    assert.ok(stoppedRuntime);
    assert.equal(stoppedRuntime.runtimeResolver, undefined,
      "DB-current/config-missing recovery remains fail-closed before config handoff");
    await stoppedRuntime.stop();

    const receipt = await replaceSlackBridgeLocalRealAuthorityFromEnv({
      ...surface.packet,
      outboundBootstrap,
    }, surface.env, { db: surface.db, now: () => NOW });
    assert.equal(receipt.connectionEpoch, 2);
    const recoveredConfig = await surface.file.read();
    assert.equal(recoveredConfig.outbound!.bindings.length, 1);
    assert.equal(recoveredConfig.outbound!.bindings[0]!.bindingId, surface.binding.id);
    assert.equal(recoveredConfig.outbound!.bindings[0]!.sourceConversationId, surface.binding.channelId);
    assert.equal(recoveredConfig.outbound!.bindings[0]!.connectionEpoch, 2);
    assert.equal(recoveredConfig.realAuthority!.actorCount, 2);
    assert.equal((await surface.db.select().from(externalChannelBindings)).length, 1);
    assert.equal((await surface.db.select().from(channels)).length, surface.baselineChannelCount);
    assert.deepEqual(
      (await surface.db.select().from(externalActorProjections)).map((actor) => actor.projectionRevision),
      [2, 2],
      "reentrant recovery does not advance current actors twice",
    );

    await assert.rejects(
      replaceSlackBridgeLocalRealAuthorityFromEnv({
        ...surface.packet,
        outboundBootstrap,
      }, surface.env, { db: surface.db, now: () => NOW }),
      /rejects outbound config piggyback/,
      "bootstrap data cannot alter the original existing-outbound path",
    );
  } finally {
    await surface.file.cleanup();
  }
});
