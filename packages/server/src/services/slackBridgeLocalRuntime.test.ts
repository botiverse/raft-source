import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import {
  channels,
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
  externalDeliveryPartitions,
  externalMessageLinks,
  externalOutboundDeliveries,
  featureFlagConfigVersions,
  messages,
  oauthClientInstalls,
  oauthClients,
  users,
} from "../db/schema.js";
import {
  digestSlackBridgeRenderSnapshot,
  maybeEnqueueOrdinaryMessageExternalDelivery,
  type SlackBridgeRenderSnapshot,
} from "./externalDeliveryOutboxService.js";
import { processExternalDeliveryPartitionHead } from "./externalDeliveryWorkerService.js";
import { updateFeatureFlag } from "./featureFlagService.js";
import { resolveSlackBridgeBindingActive } from "./slackBridgeRuntimeService.js";
import { slackBridgeInstallGrantHash } from "./slackBridgeInstallGrantService.js";
import { createServer } from "./serverService.js";
import { createSlackBridgeLocalRuntimeFromEnv } from "./slackBridgeLocalRuntime.js";


const NOW = new Date("2026-08-05T10:00:00.000Z");

async function runtimeConfig(
  mode = 0o600,
  extra: Record<string, unknown> = {},
  key = randomBytes(32),
) {
  const directory = await mkdtemp(join(tmpdir(), "slack-runtime-current-"));
  const path = join(directory, "runtime.json");
  await writeFile(path, JSON.stringify({
    schema: "slack-bridge-local-runtime.v1",
    environment: "test",
    publicOrigin: "https://bridge-test.example.test",
    registrationId: "11111111-1111-4111-8111-111111111111",
    providerAppId: "A_TEST_APP",
    providerOAuthClientId: "123.456",
    oauthClientSecret: "oauth-client-secret-value",
    signingSecret: "signing-secret-value",
    signingSecretRef: "local-ref:slack-signing:v3",
    signingSecretRevision: 3,
    envelopeKeyId: "local-slack-test-key-v1",
    envelopeKeyBase64: key.toString("base64"),
    ...extra,
  }), { mode });
  await chmod(path, mode);
  return { path: await realpath(path), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

afterEach(async () => {
  await closeTestDatabase();
});

test("local Slack runtime is absent unless an owner-only config is explicitly selected", async () => {
  assert.equal(await createSlackBridgeLocalRuntimeFromEnv({ NODE_ENV: "development" }), undefined);
  const file = await runtimeConfig(0o644);
  try {
    await assert.rejects(createSlackBridgeLocalRuntimeFromEnv({
      NODE_ENV: "development",
      SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE: file.path,
    }), /permissions must be 0600/);
  } finally {
    await file.cleanup();
  }
});

test("local Slack runtime can never be enabled in production", async () => {
  const file = await runtimeConfig();
  try {
    await assert.rejects(createSlackBridgeLocalRuntimeFromEnv({
      NODE_ENV: "production",
      SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE: file.path,
    }), /forbidden in production/);
  } finally {
    await file.cleanup();
  }
});

test("local OAuth completion uses the canonical app origin and active server path", async ({ db }) => {

  const [owner] = await getDb().insert(users).values({
    email: `slack-local-redirect-${randomUUID()}@raft.test`,
    name: `slack-local-redirect-${randomUUID().slice(0, 8)}`,
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const server = await createServer(
    "Slack Local Redirect",
    `slack-local-redirect-${randomUUID()}`,
    owner.id,
  );
  const file = await runtimeConfig();
  try {
    const runtime = await createSlackBridgeLocalRuntimeFromEnv({
      NODE_ENV: "development",
      APP_URL: "http://127.0.0.1:5173/ignored/path",
      SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE: file.path,
    }, {
      db: getDb(),
      now: () => NOW,
      verifyIngressAuthority: async () => ({
        registrationId: "11111111-1111-4111-8111-111111111111",
        endpointId: "22222222-2222-4222-8222-222222222222",
        endpointRevision: 1,
        exactRequestUrl: "https://bridge-test.example.test/api/slack-bridge/events",
        signingSecretRevision: 3,
        signingSecretRef: "local-ref:slack-signing:v3",
        envelopeKeyId: "local-slack-test-key-v1",
      }),
    });
    assert.ok(runtime);
    assert.equal(runtime.appOrigin, "http://127.0.0.1:5173");
    assert.equal(
      await runtime.resolveOAuthCompletionRedirectPath({ serverId: server.id }),
      `/s/${encodeURIComponent(server.slug)}/settings/im-bridges`,
    );
    await runtime.stop();
  } finally {
    await file.cleanup();
  }
});

test("local outbound config remains the OAuth completion app-origin authority", async () => {
  const key = randomBytes(32);
  const file = await runtimeConfig(0o600, {
    outbound: {
      workerId: "local-outbound-origin",
      pollIntervalMs: 500,
      raftAppOrigin: "https://configured.raft.test",
      bindings: [{
        serverId: "11111111-1111-4111-8111-111111111111",
        sourceConversationId: "22222222-2222-4222-8222-222222222222",
        canonicalRootMessageId: null,
        bindingId: "33333333-3333-4333-8333-333333333333",
        connectionEpoch: 1,
        bindingEpoch: 1,
        consentRevision: 1,
        level: "top_level",
        membership: {
          registrationId: "11111111-1111-4111-8111-111111111111",
          installId: "44444444-4444-4444-8444-444444444444",
          bindingId: "33333333-3333-4333-8333-333333333333",
          connectionEpoch: 1,
          bindingEpoch: 1,
          providerAuthorityId: "T_LOCAL",
          providerConversationId: "C_LOCAL",
          receiptRevision: 1,
          expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        },
        oracle: {
          bindingId: "33333333-3333-4333-8333-333333333333",
          connectionEpoch: 1,
          bindingEpoch: 1,
          privacyClass: "public",
          level: "top_level",
          releaseContractRevision: "slack-bridge-revision-5",
          oracleReceiptSchema: "slack-bridge-oracle-receipt.v1",
          oracleReceiptRevision: 1,
          inboundGreen: true,
          outboundGreen: true,
          expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        },
      }],
    },
  }, key);
  try {
    await openTestDatabase("pglite://");
    const runtime = await createSlackBridgeLocalRuntimeFromEnv({
      NODE_ENV: "development",
      APP_URL: "http://wrong.raft.test",
      SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE: file.path,
    }, {
      db: getDb(),
      now: () => NOW,
      verifyIngressAuthority: async () => ({
        registrationId: "11111111-1111-4111-8111-111111111111",
        endpointId: "22222222-2222-4222-8222-222222222222",
        endpointRevision: 1,
        exactRequestUrl: "https://bridge-test.example.test/api/slack-bridge/events",
        signingSecretRevision: 3,
        signingSecretRef: "local-ref:slack-signing:v3",
        envelopeKeyId: "local-slack-test-key-v1",
      }),
    });
    assert.ok(runtime);
    assert.equal(runtime.appOrigin, "https://configured.raft.test");
    await runtime.stop();
  } finally {
    await file.cleanup();
  }
});

test("local Slack signing secret and normalized payload sealing are exact-reference bound", async () => {
  const file = await runtimeConfig();
  try {
    const runtime = await createSlackBridgeLocalRuntimeFromEnv({
      NODE_ENV: "development",
      SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE: file.path,
    }, {
      now: () => NOW,
      verifyIngressAuthority: async () => ({
        registrationId: "11111111-1111-4111-8111-111111111111",
        endpointId: "22222222-2222-4222-8222-222222222222",
        endpointRevision: 1,
        exactRequestUrl: "https://bridge-test.example.test/api/slack-bridge/events",
        signingSecretRevision: 3,
        signingSecretRef: "local-ref:slack-signing:v3",
        envelopeKeyId: "local-slack-test-key-v1",
      }),
    });
    assert.ok(runtime);
    assert.equal(await runtime.secretResolver.resolveSigningSecret({
      registrationId: "11111111-1111-4111-8111-111111111111",
      environment: "test",
      encryptedSecretRef: "local-ref:slack-signing:v3",
      envelopeKeyId: "local-slack-test-key-v1",
      aadVersion: 1,
      secretRevision: 3,
    }), "signing-secret-value");
    await assert.rejects(runtime.secretResolver.resolveSigningSecret({
      registrationId: "11111111-1111-4111-8111-111111111111",
      environment: "test",
      encryptedSecretRef: "local-ref:slack-signing:v2",
      envelopeKeyId: "local-slack-test-key-v1",
      aadVersion: 1,
      secretRevision: 2,
    }), /reference mismatch/);
    const aad = {
      purpose: "external-inbound-normalized-event" as const,
      aadVersion: 1 as const,
      schemaVersion: 1 as const,
      provider: "slack" as const,
      environment: "test" as const,
      appRegistrationId: "11111111-1111-4111-8111-111111111111",
      installId: "install-1",
      workspaceId: "T_TEST",
      providerAuthorityId: "T_TEST",
      providerConversationId: "C_TEST",
      providerEventId: "Ev_TEST",
      bindingId: "binding-1",
      bindingEpoch: 1,
      connectionEpoch: 1,
      runtimeRevision: "runtime-1",
      raftChannelId: "channel-1",
      privacyClass: "public" as const,
    };
    const first = await runtime.payloadSealer.sealNormalizedPayload({ plaintext: "sensitive", aad });
    const second = await runtime.payloadSealer.sealNormalizedPayload({ plaintext: "sensitive", aad });
    assert.match(first.encryptedPayload, /^local-aes-256-gcm-v1\./);
    assert.notEqual(first.encryptedPayload, second.encryptedPayload);
    assert.equal(first.envelopeKeyId, "local-slack-test-key-v1");
    assert.equal(first.aadVersion, 1);
    await runtime.stop();
    await assert.rejects(runtime.payloadSealer.sealNormalizedPayload({ plaintext: "sensitive", aad }), /stopped/);
  } finally {
    await file.cleanup();
  }
});

function sealCredential(input: {
  key: Buffer;
  accessToken: string;
  providerAppId: string;
  providerTeamId: string;
}): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify({
    providerAppId: input.providerAppId,
    providerTeamId: input.providerTeamId,
    purpose: "slack_bot_credential",
  }), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ accessToken: input.accessToken, tokenType: "bot" }), "utf8"),
    cipher.final(),
  ]);
  return [
    "local-aes-256-gcm-v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

test("local runtime drives current worker through one exact credential lease and one Slack transport call", async ({ db: database }) => {

  const db = getDb();
  const key = Buffer.alloc(32, 7);
  const [owner] = await db.insert(users).values({
    email: `local-worker-${randomUUID()}@test.invalid`,
    name: `local-worker-${randomUUID()}`,
    displayName: "Local Worker Human",
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const server = await createServer("Local Worker", `local-worker-${randomUUID()}`, owner.id);
  const [client] = await db.insert(oauthClients).values({
    serverId: server.id,
    clientId: `local-worker-${randomUUID()}`,
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
    id: "11111111-1111-4111-8111-111111111111",
    oauthClientId: client.id,
    provider: "slack",
    environment: "test",
    providerAppId: "A_TEST_APP",
    providerOAuthClientId: "123.456",
    capabilityManifestVersion: 1,
    capabilityManifestHash: "local-manifest-v1",
    requiredCapabilities: ["external_projection"],
  }).returning();
  await db.insert(externalAppRegistrationSecrets).values([{
    registrationId: registration.id,
    purpose: "signing_secret",
    encryptedSecretRef: "local-ref:slack-signing:v3",
    envelopeKeyId: "local-slack-test-key-v1",
    aadVersion: 1,
    secretRevision: 3,
  }, {
    registrationId: registration.id,
    purpose: "manifest_manager",
    encryptedSecretRef: "local-ref:manifest:v1",
    envelopeKeyId: "local-slack-test-key-v1",
    aadVersion: 1,
    secretRevision: 1,
  }]);
  await db.insert(externalAppIngressEndpoints).values({
    registrationId: registration.id,
    environment: "test",
    exactRequestUrl: "https://bridge-test.example.test/api/slack-bridge/events",
    endpointRevision: 1,
    signingSecretRevision: 3,
  });
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "local-manifest-v1",
    grantedCapabilities: ["external_projection"],
    grantedByType: "human",
    grantedById: owner.id,
  }).returning();
  const scopes = [
    "channels:history",
    "channels:read",
    "chat:write",
    "chat:write.customize",
    "groups:history",
    "groups:read",
    "users:read",
  ];
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: 1,
    state: "active",
    connectionEpoch: 2,
    scopeRevision: 3,
    credentialRevision: 1,
    installedScopes: scopes,
    providerAppId: "A_TEST_APP",
    providerTeamId: "T_TEST",
    authorityType: "team",
    providerAuthorityId: "T_TEST",
    botUserId: "U_TEST_BOT",
    providerBotId: "B_TEST",
    lastVerifiedAt: NOW,
  }).returning();
  await db.insert(externalAppCredentials).values({
    installId: install.id,
    state: "active",
    encryptedMaterial: sealCredential({
      key,
      accessToken: "xoxb-local-one-use",
      providerAppId: "A_TEST_APP",
      providerTeamId: "T_TEST",
    }),
    envelopeKeyId: "local-slack-test-key-v1",
    aadVersion: 1,
    credentialRevision: 1,
    leaseOwner: "crashed-local-worker",
    leaseExpiresAt: new Date(NOW.getTime() - 1),
  });
  await db.insert(externalAppInstallGrantReceipts).values({
    registrationId: registration.id,
    installId: install.id,
    receiptRevision: 1,
    connectionEpoch: 2,
    scopeRevision: 3,
    credentialRevision: 1,
    providerAppId: "A_TEST_APP",
    providerAuthorityId: "T_TEST",
    botUserId: "U_TEST_BOT",
    providerBotId: "B_TEST",
    grantedScopes: scopes,
    grantHash: slackBridgeInstallGrantHash({
      providerAppId: "A_TEST_APP",
      providerAuthorityId: "T_TEST",
      botUserId: "U_TEST_BOT",
      providerBotId: "B_TEST",
      grantedScopes: scopes,
    }),
    observationSource: "token_introspection",
    status: "valid",
    observedAt: new Date(NOW.getTime() - 60_000),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
  });
  await db.insert(externalAppManifestReceipts).values({
    registrationId: registration.id,
    receiptRevision: 1,
    managerCredentialRevision: 1,
    providerAppId: "A_TEST_APP",
    normalizedManifestHash: "local-manifest-v1",
    normalizedScopes: scopes,
    normalizedEvents: ["message.channels"],
    normalizedSettings: {},
    status: "valid",
    observedAt: new Date(NOW.getTime() - 60_000),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
  });
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `local-worker-${randomUUID()}`,
    type: "channel",
  }).returning();
  const [binding] = await db.insert(externalChannelBindings).values({
    serverId: server.id,
    registrationId: registration.id,
    installId: install.id,
    channelId: channel.id,
    providerConversationId: "C_TEST",
    providerConversationKind: "public_channel",
    privacyClass: "public",
    grantEpoch: 1,
    connectionEpoch: 2,
    bindingEpoch: 7,
    consentedByType: "human",
    consentedById: owner.id,
    consentedAt: NOW,
  }).returning();
  for (const key of [
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.directory,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.enqueue,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.dispatch,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.customAuthorship,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.nativeMention,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.threadDelivery,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.eventIngress,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.inboundProjection,
  ]) {
    assert.ok(await updateFeatureFlag(key, { defaultEnabled: true }));
  }
  const [flagVersion] = await db.select({ version: featureFlagConfigVersions.version })
    .from(featureFlagConfigVersions)
    .where(eq(featureFlagConfigVersions.scope, "global"));
  assert.ok(flagVersion && flagVersion.version > 0, "writer-backed enablement establishes a valid snapshot revision");
  const membership = {
    registrationId: registration.id,
    installId: install.id,
    bindingId: binding.id,
    connectionEpoch: 2,
    bindingEpoch: 7,
    providerAuthorityId: "T_TEST",
    providerConversationId: "C_TEST",
    receiptRevision: 6,
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
  };
  const oracle = {
    bindingId: binding.id,
    connectionEpoch: 2,
    bindingEpoch: 7,
    privacyClass: "public" as const,
    level: "top_level" as const,
    releaseContractRevision: "slack-bridge-revision-5" as const,
    oracleReceiptSchema: "slack-bridge-oracle-receipt.v1" as const,
    oracleReceiptRevision: 7,
    inboundGreen: true,
    outboundGreen: true,
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
  };
  const decision = await resolveSlackBridgeBindingActive({
    serverId: server.id,
    bindingId: binding.id,
    expectedConnectionEpoch: 2,
    expectedBindingEpoch: 7,
    level: "top_level",
    now: NOW,
  }, {
    resolveAppMembership: async () => ({ active: true, fact: membership }),
    resolveReleaseOracle: async () => ({ active: true, fact: oracle }),
  });
  if (!decision.active) assert.fail(decision.reason);
  const authority = {
    provider: "slack",
    environment: "test",
    appRegistrationId: registration.id,
    installId: install.id,
    workspaceId: "T_TEST",
    connectionEpoch: 2,
    bindingId: binding.id,
    bindingEpoch: 7,
    memberRevision: 6,
    contextRevision: 7,
    consentRevision: 8,
    privacyClass: "public" as const,
    raftChannelId: channel.id,
    providerAuthorityId: "T_TEST",
    providerConversationId: "C_TEST",
  };
  const [policy] = await db.insert(externalAuthorPolicies).values({
    serverId: server.id,
    provider: "slack",
    appRegistrationId: registration.id,
    installId: install.id,
    bindingId: binding.id,
    bindingEpoch: 7,
    authorType: "user",
    authorId: owner.id,
    displayName: "Local Worker Human",
    fallbackKind: "human",
    consentRevision: 8,
    state: "granted",
  }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "outbound exact",
    messageType: "chat",
  }).returning();
  const snapshot: SlackBridgeRenderSnapshot = {
    schema: "slack-bridge-render-snapshot.v2",
    sourceMessageId: message.id,
    sourceMessageSeq: message.seq,
    canonicalConversationId: channel.id,
    level: "top_level",
    canonicalRootMessageId: null,
    sourcePermalink: `https://app.slock.ai/s/${server.slug}/channel/${channel.id}?msg=${message.id}`,
    senderType: "user",
    senderId: owner.id,
    authorName: "Local Worker Human",
    authorAvatarDigest: null,
    authorPolicy: {
      policyId: policy.id,
      serverId: server.id,
      consentRevision: 8,
      displayName: "Local Worker Human",
      fallbackKind: "human",
      avatar: null,
    },
    sanitizedText: "outbound exact",
    externalMentions: [],
    attachments: [],
    bindingAuthority: authority,
    enqueueRuntimeRevision: decision.fact.runtimePredicateRevision,
  };
  const [partition] = await db.insert(externalDeliveryPartitions).values({
    bindingId: binding.id,
    bindingEpoch: 7,
  }).returning();
  const [delivery] = await db.transaction(async (executor) => {
    await executor.update(externalDeliveryPartitions).set({
      lastEnqueuedPosition: 1,
    }).where(eq(externalDeliveryPartitions.id, partition.id));
    return executor.insert(externalOutboundDeliveries).values({
      sourceMessageId: message.id,
      bindingId: binding.id,
      bindingEpoch: 7,
      partitionPosition: 1,
      enqueueRuntimeRevision: decision.fact.runtimePredicateRevision,
      renderSnapshotSchema: snapshot.schema,
      renderSnapshot: snapshot as unknown as Record<string, unknown>,
      renderSnapshotDigest: digestSlackBridgeRenderSnapshot(snapshot),
      reconciliationMarker: "A".repeat(43),
    }).returning();
  });

  const outbound = {
    workerId: "local-worker-test",
    pollIntervalMs: 10_000,
    raftAppOrigin: "https://app.slock.ai",
    bindings: [{
      serverId: server.id,
      sourceConversationId: channel.id,
      canonicalRootMessageId: null,
      bindingId: binding.id,
      connectionEpoch: 2,
      bindingEpoch: 7,
      consentRevision: 8,
      level: "top_level",
      membership: { ...membership, expiresAt: membership.expiresAt.toISOString() },
      oracle: { ...oracle, expiresAt: oracle.expiresAt.toISOString() },
    }],
  };
  const file = await runtimeConfig(0o600, { outbound }, key);
  let providerCalls = 0;
  let finish!: (value: unknown) => void;
  const result = new Promise<unknown>((resolve) => { finish = resolve; });
  const runtime = await createSlackBridgeLocalRuntimeFromEnv({
    NODE_ENV: "development",
    SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE: file.path,
  }, {
    db,
    now: () => NOW,
    fetch: async (url, init) => {
      providerCalls += 1;
      assert.equal(String(url), "https://slack.com/api/chat.postMessage");
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer xoxb-local-one-use");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.username, "Local Worker Human from Raft");
      assert.equal(String(body.text), "outbound exact");
      return new Response(JSON.stringify({ ok: true, channel: "C_TEST", ts: "1785931200.000300" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    runWorkerOnce: async (args) => {
      const workerResult = await processExternalDeliveryPartitionHead(args);
      finish(workerResult);
      return workerResult;
    },
  });
  assert.ok(runtime);
  runtime.start();
  const workerResult = await result;
  assert.equal((workerResult as { kind: string }).kind, "attempted");
  assert.equal(providerCalls, 1);
  const [accepted] = await db.select().from(externalOutboundDeliveries).where(eq(
    externalOutboundDeliveries.id,
    delivery.id,
  ));
  assert.equal(accepted.state, "accepted");
  const [link] = await db.select().from(externalMessageLinks).where(eq(
    externalMessageLinks.deliveryId,
    delivery.id,
  ));
  assert.equal(link.providerMessageId, "1785931200.000300");
  const [credential] = await db.select().from(externalAppCredentials).where(eq(
    externalAppCredentials.installId,
    install.id,
  ));
  assert.equal(credential.leaseOwner, null);
  assert.equal(credential.leaseExpiresAt, null);
  await runtime.stop();

  const enqueueAttempt = (runtimeFile: Awaited<ReturnType<typeof runtimeConfig>>) =>
    createSlackBridgeLocalRuntimeFromEnv({
      NODE_ENV: "development",
      SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE: runtimeFile.path,
    }, {
      db,
      now: () => NOW,
      fetch: async () => { throw new Error("mismatched authority must make zero provider I/O"); },
      runWorkerOnce: async () => ({ kind: "empty" as const }),
    });
  const maybeEnqueue = () => db.transaction((executor) => maybeEnqueueOrdinaryMessageExternalDelivery({
    executor,
    message,
    requestedChannelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    authorName: "Local Worker Human",
    sourceText: "must stay local",
    decision: { eligible: true },
  }));

  const wrongServerFile = await runtimeConfig(0o600, {
    outbound: {
      ...outbound,
      bindings: [{ ...outbound.bindings[0], serverId: randomUUID() }],
    },
  }, key);
  const wrongServerRuntime = await enqueueAttempt(wrongServerFile);
  assert.ok(wrongServerRuntime);
  wrongServerRuntime.start();
  assert.equal(await maybeEnqueue(), null);
  await wrongServerRuntime.stop();
  await wrongServerFile.cleanup();

  const wrongThreadFile = await runtimeConfig(0o600, {
    outbound: {
      ...outbound,
      bindings: [{
        ...outbound.bindings[0],
        canonicalRootMessageId: message.id,
        level: "thread",
        oracle: { ...oracle, level: "thread" },
      }],
    },
  }, key);
  const wrongThreadRuntime = await enqueueAttempt(wrongThreadFile);
  assert.ok(wrongThreadRuntime);
  wrongThreadRuntime.start();
  assert.equal(await maybeEnqueue(), null);
  await wrongThreadRuntime.stop();
  await wrongThreadFile.cleanup();
  assert.equal((await db.select().from(externalOutboundDeliveries)).length, 1);

  await file.cleanup();
});
