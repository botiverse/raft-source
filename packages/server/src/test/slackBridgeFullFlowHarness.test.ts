import { createApiTest } from "./integration/apiTest.js";
import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  CURRENT_LEGAL_ACCEPTANCE,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import {
  attachments,
  channelHumans,
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
  externalDeliveryAttempts,
  externalDeliveryPartitions,
  externalMessageLinks,
  externalOutboundDeliveries,
  featureFlagConfigVersions,
  featureFlags,
  inboxNotificationFacts,
  inboxServingRows,
  jointChannels,
  jointChannelServers,
  messages,
  mobilePushOutbox,
  oauthClientInstalls,
  oauthClients,
  serverMembers,
  servers,
  users,
} from "../db/schema.js";
import { processExternalDeliveryPartitionHead } from "../services/externalDeliveryWorkerService.js";
import { verifyAndAdmitSlackIngress } from "../services/externalAppIngressService.js";
import { slackBridgeInstallGrantHash } from "../services/slackBridgeInstallGrantService.js";
import { updateFeatureFlag } from "../services/featureFlagService.js";
import {
  createSlackBridgeLocalRuntimeFromEnv,
  rebindSlackBridgeLocalIngressAuthorityFromEnv,
  verifySlackBridgeLocalIngressAuthorityFromEnv,
} from "../services/slackBridgeLocalRuntime.js";
import { openTestApp } from "./integration/app.js";
import {
  runSlackBridgeFullFlowPreflight,
  SLACK_BRIDGE_FULL_FLOW_PREFLIGHT_SCHEMA,
  SlackBridgeFullFlowPreflightError,
  type SlackBridgeFullFlowPreflightGate,
  type SlackBridgeFullFlowPreflightInput,
} from "./slackBridgeFullFlowPreflight.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const APP_ID = "A_FULL_FLOW_TEST";
const TEAM_ID = "T_FULL_FLOW_TEST";
const CONVERSATION_ID = "C_FULL_FLOW_TEST";
const MANIFEST_HASH = "full-flow-manifest-v1";
const ENVELOPE_KEY_ID = "local-slack-full-flow-key-v1";
const PASSWORD = "password123";
const SCOPES = [
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.customize",
  "groups:history",
  "groups:read",
  "users:read",
];

function registrationBody(input: { email: string; name: string; password: string }) {
  return {
    ...input,
    acceptTerms: true,
    termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
    privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
  };
}

async function register(baseUrl: string, input: { email: string; name: string; password?: string }) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registrationBody({ ...input, password: input.password ?? PASSWORD })),
  });
  const body = await response.json() as {
    user?: { id: string };
    accessToken?: string;
    error?: string;
  };
  return { response, body };
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const bodyText = await response.text();
  assert.equal(response.status, 200, `login failed: ${bodyText}`);
  return (JSON.parse(bodyText) as { accessToken: string }).accessToken;
}

function sealCredential(key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify({
    providerAppId: APP_ID,
    providerTeamId: TEAM_ID,
    purpose: "slack_bot_credential",
  }), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ accessToken: "xoxb-provider-disabled", tokenType: "bot" }), "utf8"),
    cipher.final(),
  ]);
  return [
    "local-aes-256-gcm-v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

async function writeRuntimeConfig(input: {
  key: Buffer;
  registrationId: string;
  serverId: string;
  channelId: string;
  bindingId: string;
  installId: string;
  membership: SlackBridgeFullFlowPreflightInput["membership"];
  oracle: SlackBridgeFullFlowPreflightInput["oracle"];
}) {
  const directory = await mkdtemp(join(tmpdir(), "slack-full-flow-"));
  const path = join(directory, "runtime.json");
  await writeFile(path, JSON.stringify({
    schema: "slack-bridge-local-runtime.v1",
    environment: "test",
    publicOrigin: "https://bridge-full-flow.example.test",
    registrationId: input.registrationId,
    providerAppId: APP_ID,
    providerOAuthClientId: "full-flow-client-id",
    oauthClientSecret: "provider-disabled-oauth-secret",
    signingSecret: "provider-disabled-signing-secret",
    signingSecretRef: "local-ref:slack-signing:v2",
    signingSecretRevision: 2,
    envelopeKeyId: ENVELOPE_KEY_ID,
    envelopeKeyBase64: input.key.toString("base64"),
    outbound: {
      workerId: "full-flow-worker",
      pollIntervalMs: 5,
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
        membership: input.membership,
        oracle: input.oracle,
      }],
    },
  }), { mode: 0o600 });
  await chmod(path, 0o600);
  return {
    path: await realpath(path),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function validPreflightInput(): SlackBridgeFullFlowPreflightInput {
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const peerId = "22222222-2222-4222-8222-222222222222";
  return {
    schema: SLACK_BRIDGE_FULL_FLOW_PREFLIGHT_SCHEMA,
    identity: {
      userId: ownerId,
      email: "slack-full-flow@test.invalid",
      name: "slack-full-flow",
      displayName: "Slack Full Flow Human",
      password: PASSWORD,
      emailVerified: true,
      profileSetupCompleted: true,
    },
    audience: {
      serverId: "33333333-3333-4333-8333-333333333333",
      channelId: "44444444-4444-4444-8444-444444444444",
      ownerId,
      memberIds: [ownerId, peerId],
      channelHumanIds: [ownerId, peerId],
    },
    topology: {
      requestedChannelType: "channel",
      canonicalJointRows: 0,
      localJointRows: 0,
      externalBindingRows: 1,
      runtimeBuildFingerprint: "a".repeat(64),
      expectedRuntimeBuildFingerprint: "a".repeat(64),
    },
    registration: {
      id: "55555555-5555-4555-8555-555555555555",
      provider: "slack",
      environment: "test",
      providerAppId: APP_ID,
      oauthClientId: "66666666-6666-4666-8666-666666666666",
      oauthClientInstalled: true,
      manifestVersion: 1,
      manifestHash: MANIFEST_HASH,
    },
    grant: {
      id: "77777777-7777-4777-8777-777777777777",
      serverId: "33333333-3333-4333-8333-333333333333",
      registrationId: "55555555-5555-4555-8555-555555555555",
      grantEpoch: 1,
      manifestVersion: 1,
      manifestHash: MANIFEST_HASH,
    },
    install: {
      id: "88888888-8888-4888-8888-888888888888",
      serverId: "33333333-3333-4333-8333-333333333333",
      registrationId: "55555555-5555-4555-8555-555555555555",
      serverGrantId: "77777777-7777-4777-8777-777777777777",
      state: "active",
      grantEpoch: 1,
      connectionEpoch: 1,
      credentialRevision: 1,
      providerAppId: APP_ID,
      providerAuthorityId: TEAM_ID,
    },
    credential: {
      installId: "88888888-8888-4888-8888-888888888888",
      state: "active",
      credentialRevision: 1,
      envelopeKeyId: ENVELOPE_KEY_ID,
      aadVersion: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
    manifest: {
      registrationId: "55555555-5555-4555-8555-555555555555",
      status: "valid",
      receiptRevision: 1,
      managerCredentialRevision: 1,
      providerAppId: APP_ID,
      normalizedManifestHash: MANIFEST_HASH,
      expiresAt,
    },
    signingSecret: {
      registrationId: "55555555-5555-4555-8555-555555555555",
      purpose: "signing_secret",
      secretRevision: 1,
      envelopeKeyId: ENVELOPE_KEY_ID,
      aadVersion: 1,
    },
    binding: {
      id: "99999999-9999-4999-8999-999999999999",
      serverId: "33333333-3333-4333-8333-333333333333",
      registrationId: "55555555-5555-4555-8555-555555555555",
      installId: "88888888-8888-4888-8888-888888888888",
      channelId: "44444444-4444-4444-8444-444444444444",
      state: "active",
      connectionEpoch: 1,
      bindingEpoch: 1,
      privacyClass: "public",
      providerConversationId: CONVERSATION_ID,
      consentRevision: 1,
    },
    membership: {
      registrationId: "55555555-5555-4555-8555-555555555555",
      installId: "88888888-8888-4888-8888-888888888888",
      bindingId: "99999999-9999-4999-8999-999999999999",
      connectionEpoch: 1,
      bindingEpoch: 1,
      providerAuthorityId: TEAM_ID,
      providerConversationId: CONVERSATION_ID,
      receiptRevision: 1,
      expiresAt,
    },
    oracle: {
      bindingId: "99999999-9999-4999-8999-999999999999",
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
    authorPolicy: {
      serverId: "33333333-3333-4333-8333-333333333333",
      provider: "slack",
      registrationId: "55555555-5555-4555-8555-555555555555",
      installId: "88888888-8888-4888-8888-888888888888",
      bindingId: "99999999-9999-4999-8999-999999999999",
      bindingEpoch: 1,
      authorId: ownerId,
      displayName: "Slack Full Flow Human",
      consentRevision: 1,
      state: "granted",
    },
    flags: {
      configRevision: 1,
      enabled: Object.fromEntries(Object.values(SLACK_BRIDGE_FEATURE_FLAG_KEYS).map((key) => [key, true])),
    },
    baseline: {
      sourceMessages: 0,
      outboundDeliveries: 0,
      providerLinks: 0,
      deliveryAttempts: 0,
      activeCredentialLeases: 0,
    },
    executionFence: {
      providerNetworkDisabled: true,
      localSlackSinkOnly: true,
    },
  };
}

test("full-flow preflight has a tooth for every declared input and authority gate", () => {
  assert.equal(runSlackBridgeFullFlowPreflight.length, 1, "execution entry has no caller clock override");
  assert.match(runSlackBridgeFullFlowPreflight(validPreflightInput()).inputDigest, /^[0-9a-f]{64}$/);

  const mutations: Array<{
    gate: SlackBridgeFullFlowPreflightGate;
    mutate(input: SlackBridgeFullFlowPreflightInput): void;
  }> = [
    { gate: "registration_input", mutate: (input) => { input.identity.name = "x".repeat(50); } },
    { gate: "registration_input", mutate: (input) => { input.identity.displayName = "   "; } },
    { gate: "user_ready", mutate: (input) => { input.identity.profileSetupCompleted = false; } },
    { gate: "audience", mutate: (input) => { input.audience.channelHumanIds.pop(); } },
    { gate: "topology", mutate: (input) => { input.topology.localJointRows = 1; } },
    { gate: "topology", mutate: (input) => { input.topology.runtimeBuildFingerprint = "0".repeat(64); } },
    { gate: "registration", mutate: (input) => { input.registration.provider = "not-slack"; } },
    { gate: "grant_install", mutate: (input) => { input.install.serverGrantId = randomUUID(); } },
    { gate: "credential", mutate: (input) => { input.credential.leaseOwner = "stale-worker"; } },
    { gate: "manifest", mutate: (input) => { input.manifest.status = "mismatch"; } },
    { gate: "binding", mutate: (input) => { input.binding.channelId = randomUUID(); } },
    { gate: "membership", mutate: (input) => { input.membership.expiresAt = new Date(0).toISOString(); } },
    { gate: "oracle", mutate: (input) => { input.oracle.outboundGreen = false; } },
    { gate: "author_policy", mutate: (input) => { input.authorPolicy.displayName = "drifted"; } },
    { gate: "flags", mutate: (input) => { input.flags.enabled[SLACK_BRIDGE_FEATURE_FLAG_KEYS.enqueue] = false; } },
    { gate: "baseline", mutate: (input) => { input.baseline.outboundDeliveries = 1; } },
    { gate: "network_fence", mutate: (input) => { input.executionFence.providerNetworkDisabled = false; } },
  ];

  for (const mutation of mutations) {
    const input = structuredClone(validPreflightInput());
    mutation.mutate(input);
    assert.throws(
      () => runSlackBridgeFullFlowPreflight(input),
      (error) => error instanceof SlackBridgeFullFlowPreflightError && error.gate === mutation.gate,
      mutation.gate,
    );
  }

  const detachedFuture = structuredClone(validPreflightInput()) as SlackBridgeFullFlowPreflightInput & {
    membershipExpiresAt?: string;
  };
  detachedFuture.membership.expiresAt = new Date(0).toISOString();
  detachedFuture.membershipExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  assert.throws(
    () => runSlackBridgeFullFlowPreflight(detachedFuture),
    (error) => error instanceof SlackBridgeFullFlowPreflightError && error.gate === "membership",
    "detached future expiry cannot cover an expired authoritative receipt",
  );
});

test("public register validators fail before any harness identity is created", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, skipAuthRateLimit: true });
  try {
    const before = await getDb().select({ count: sql<number>`count(*)::int` }).from(users);
    const overlong = await register(app.baseUrl, {
      email: "overlong@test.invalid",
      name: `slack25-final-${randomUUID()}`,
    });
    assert.equal(overlong.response.status, 400);
    assert.match(overlong.body.error ?? "", /at most 32 characters/);

    const emptyEmail = await register(app.baseUrl, { email: "", name: "valid-harness-name" });
    assert.equal(emptyEmail.response.status, 400);
    assert.equal(emptyEmail.body.error, "Invalid email registration body");

    const shortPassword = await register(app.baseUrl, {
      email: "short-password@test.invalid",
      name: "valid-harness-name",
      password: "short",
    });
    assert.equal(shortPassword.response.status, 400);
    assert.match(shortPassword.body.error ?? "", /at least 8 characters/);

    const after = await getDb().select({ count: sql<number>`count(*)::int` }).from(users);
    assert.deepEqual(after, before);
  } finally {
    await app.close();
  }
});

test("provider-disabled harness closes public register to HTTP message to worker and local sink", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, skipAuthRateLimit: true });
  const key = randomBytes(32);
  let runtime: Awaited<ReturnType<typeof createSlackBridgeLocalRuntimeFromEnv>>;
  let runtimeFile: Awaited<ReturnType<typeof writeRuntimeConfig>> | undefined;
  try {
    const suffix = randomUUID().slice(0, 8);
    const identity = {
      email: `slack-full-${suffix}@test.invalid`,
      name: `slack-full-${suffix}`,
      displayName: `Slack Full Flow ${suffix}`,
      password: PASSWORD,
    };
    const peerIdentity = {
      email: `slack-peer-${suffix}@test.invalid`,
      name: `slack-peer-${suffix}`,
      password: PASSWORD,
    };
    const primaryRegistration = await register(app.baseUrl, identity);
    const peerRegistration = await register(app.baseUrl, peerIdentity);
    assert.equal(primaryRegistration.response.status, 200);
    assert.equal(peerRegistration.response.status, 200);
    assert.ok(primaryRegistration.body.user?.id);
    assert.ok(peerRegistration.body.user?.id);

    const db = getDb();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60_000);
    const seeded = await db.transaction(async (tx) => {
      const ownerId = primaryRegistration.body.user!.id;
      const peerId = peerRegistration.body.user!.id;
      await tx.update(users).set({
        name: identity.name,
        displayName: identity.displayName,
        emailVerified: true,
        profileSetupCompletedAt: now,
      }).where(eq(users.id, ownerId));
      await tx.update(users).set({
        name: peerIdentity.name,
        displayName: peerIdentity.name,
        emailVerified: true,
        profileSetupCompletedAt: now,
      }).where(eq(users.id, peerId));

      const [server] = await tx.insert(servers).values({
        name: "Slack Full Flow",
        slug: `slack-full-${suffix}`,
        ownerId,
        plan: "founder",
      }).returning();
      await tx.insert(serverMembers).values([
        { serverId: server.id, userId: ownerId, role: "owner" },
        { serverId: server.id, userId: peerId, role: "member" },
      ]);
      const [channel] = await tx.insert(channels).values({
        serverId: server.id,
        name: "slack-full-flow",
        type: "channel",
      }).returning();
      await tx.insert(channelHumans).values([
        { channelId: channel.id, userId: ownerId },
        { channelId: channel.id, userId: peerId },
      ]);

      const [client] = await tx.insert(oauthClients).values({
        serverId: server.id,
        clientId: `slack-full-${suffix}`,
        clientSecretHash: "provider-disabled",
        appType: "slock_builtin",
        name: "Slack Bridge",
        allowedScopes: ["messages:read", "messages:write"],
        createdByUserId: ownerId,
      }).returning();
      await tx.insert(oauthClientInstalls).values({
        serverId: server.id,
        clientId: client.id,
        installedByUserId: ownerId,
      });
      const [registration] = await tx.insert(externalAppRegistrations).values({
        oauthClientId: client.id,
        provider: "slack",
        environment: "test",
        providerAppId: APP_ID,
        providerOAuthClientId: "full-flow-client-id",
        capabilityManifestVersion: 1,
        capabilityManifestHash: MANIFEST_HASH,
        requiredCapabilities: ["external_projection"],
      }).returning();
      const secrets = await tx.insert(externalAppRegistrationSecrets).values([{
        registrationId: registration.id,
        purpose: "signing_secret",
        encryptedSecretRef: "local-ref:slack-signing:v1",
        envelopeKeyId: ENVELOPE_KEY_ID,
        aadVersion: 1,
        secretRevision: 1,
      }, {
        registrationId: registration.id,
        purpose: "manifest_manager",
        encryptedSecretRef: "local-ref:manifest:v1",
        envelopeKeyId: ENVELOPE_KEY_ID,
        aadVersion: 1,
        secretRevision: 1,
      }]).returning();
      const [endpoint] = await tx.insert(externalAppIngressEndpoints).values({
        registrationId: registration.id,
        environment: "test",
        exactRequestUrl: "https://stale-tunnel.example.test/api/slack-bridge/events",
        endpointRevision: 1,
        signingSecretRevision: 1,
      }).returning();
      const [grant] = await tx.insert(externalAppServerGrants).values({
        serverId: server.id,
        registrationId: registration.id,
        grantEpoch: 1,
        grantedManifestVersion: 1,
        grantedManifestHash: MANIFEST_HASH,
        grantedCapabilities: ["external_projection"],
        grantedByType: "human",
        grantedById: ownerId,
      }).returning();
      const [install] = await tx.insert(externalAppInstalls).values({
        serverId: server.id,
        registrationId: registration.id,
        serverGrantId: grant.id,
        grantEpoch: 1,
        state: "active",
        connectionEpoch: 1,
        scopeRevision: 1,
        credentialRevision: 1,
        installedScopes: SCOPES,
        providerAppId: APP_ID,
        providerTeamId: TEAM_ID,
        authorityType: "team",
        providerAuthorityId: TEAM_ID,
        botUserId: "U_FULL_FLOW_BOT",
        providerBotId: "B_FULL_FLOW",
        lastVerifiedAt: now,
      }).returning();
      const [credential] = await tx.insert(externalAppCredentials).values({
        installId: install.id,
        state: "active",
        encryptedMaterial: sealCredential(key),
        envelopeKeyId: ENVELOPE_KEY_ID,
        aadVersion: 1,
        credentialRevision: 1,
      }).returning();
      await tx.insert(externalAppInstallGrantReceipts).values({
        registrationId: registration.id,
        installId: install.id,
        receiptRevision: 1,
        connectionEpoch: 1,
        scopeRevision: 1,
        credentialRevision: 1,
        providerAppId: APP_ID,
        providerAuthorityId: TEAM_ID,
        botUserId: "U_FULL_FLOW_BOT",
        providerBotId: "B_FULL_FLOW",
        grantedScopes: SCOPES,
        grantHash: slackBridgeInstallGrantHash({
          providerAppId: APP_ID,
          providerAuthorityId: TEAM_ID,
          botUserId: "U_FULL_FLOW_BOT",
          providerBotId: "B_FULL_FLOW",
          grantedScopes: SCOPES,
        }),
        observationSource: "token_introspection",
        status: "valid",
        observedAt: now,
        expiresAt,
      });
      const [manifest] = await tx.insert(externalAppManifestReceipts).values({
        registrationId: registration.id,
        receiptRevision: 1,
        managerCredentialRevision: 1,
        providerAppId: APP_ID,
        normalizedManifestHash: MANIFEST_HASH,
        normalizedScopes: SCOPES,
        normalizedEvents: ["message.channels"],
        normalizedSettings: {},
        status: "valid",
        observedAt: now,
        expiresAt,
      }).returning();
      const [binding] = await tx.insert(externalChannelBindings).values({
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
        consentedById: ownerId,
        consentedAt: now,
      }).returning();
      const [policy] = await tx.insert(externalAuthorPolicies).values({
        serverId: server.id,
        provider: "slack",
        appRegistrationId: registration.id,
        installId: install.id,
        bindingId: binding.id,
        bindingEpoch: 1,
        authorType: "user",
        authorId: ownerId,
        displayName: identity.displayName,
        fallbackKind: "human",
        consentRevision: 1,
        state: "granted",
      }).returning();
      return {
        ownerId,
        peerId,
        server,
        channel,
        client,
        registration,
        endpoint,
        signingSecret: secrets.find((secret) => secret.purpose === "signing_secret")!,
        grant,
        install,
        credential,
        manifest,
        binding,
        policy,
      };
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
    const [reactionFlag] = await db.select().from(featureFlags)
      .where(eq(featureFlags.key, SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync));
    assert.equal(reactionFlag?.enabled, true);
    assert.equal(reactionFlag?.defaultEnabled, false);
    assert.equal(reactionFlag?.killSwitch, false);
    assert.equal(reactionFlag?.randomizationUnit, "server");
    for (const flag of Object.values(SLACK_BRIDGE_FEATURE_FLAG_KEYS)) {
      assert.ok(await updateFeatureFlag(flag, { defaultEnabled: true }));
    }
    const [flagVersion] = await db.select({ version: featureFlagConfigVersions.version })
      .from(featureFlagConfigVersions)
      .where(eq(featureFlagConfigVersions.scope, "global"));
    assert.ok(flagVersion && flagVersion.version > 0);

    const membership: SlackBridgeFullFlowPreflightInput["membership"] = {
      registrationId: seeded.registration.id,
      installId: seeded.install.id,
      bindingId: seeded.binding.id,
      connectionEpoch: 1,
      bindingEpoch: 1,
      providerAuthorityId: TEAM_ID,
      providerConversationId: CONVERSATION_ID,
      receiptRevision: 1,
      expiresAt: expiresAt.toISOString(),
    };
    const oracle: SlackBridgeFullFlowPreflightInput["oracle"] = {
      bindingId: seeded.binding.id,
      connectionEpoch: 1,
      bindingEpoch: 1,
      privacyClass: "public",
      level: "top_level",
      releaseContractRevision: "slack-bridge-revision-5",
      oracleReceiptSchema: "slack-bridge-oracle-receipt.v1",
      oracleReceiptRevision: 1,
      inboundGreen: true,
      outboundGreen: true,
      expiresAt: expiresAt.toISOString(),
    };
    runtimeFile = await writeRuntimeConfig({
      key,
      registrationId: seeded.registration.id,
      serverId: seeded.server.id,
      channelId: seeded.channel.id,
      bindingId: seeded.binding.id,
      installId: seeded.install.id,
      membership,
      oracle,
    });
    const runtimeEnv = {
      NODE_ENV: "test",
      SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE: runtimeFile.path,
    };

    await assert.rejects(
      verifySlackBridgeLocalIngressAuthorityFromEnv(runtimeEnv, { db }),
      /Events request URL mismatch/,
    );
    const firstRebind = await rebindSlackBridgeLocalIngressAuthorityFromEnv(runtimeEnv, { db });
    assert.equal(firstRebind.endpointRevision, seeded.endpoint.endpointRevision + 1);
    assert.equal(firstRebind.exactRequestUrl, "https://bridge-full-flow.example.test/api/slack-bridge/events");
    assert.equal(firstRebind.signingSecretRevision, 2);
    assert.equal(firstRebind.signingSecretRef, "local-ref:slack-signing:v2");
    assert.equal(firstRebind.envelopeKeyId, ENVELOPE_KEY_ID);
    assert.deepEqual(
      await rebindSlackBridgeLocalIngressAuthorityFromEnv(runtimeEnv, { db }),
      firstRebind,
      "an exact authority rebind is idempotent",
    );

    const driftMutations: Array<{
      error: RegExp;
      mutate(): Promise<unknown>;
    }> = [{
      error: /Events request URL mismatch/,
      mutate: () => db.update(externalAppIngressEndpoints).set({
        exactRequestUrl: "https://drifted-tunnel.example.test/api/slack-bridge/events",
      }).where(eq(externalAppIngressEndpoints.id, seeded.endpoint.id)),
    }, {
      error: /signing-secret revision mismatch/,
      mutate: () => db.update(externalAppIngressEndpoints).set({
        signingSecretRevision: 1,
      }).where(eq(externalAppIngressEndpoints.id, seeded.endpoint.id)),
    }, {
      error: /signing-secret reference mismatch/,
      mutate: () => db.update(externalAppRegistrationSecrets).set({
        encryptedSecretRef: "local-ref:slack-signing:drifted",
      }).where(eq(externalAppRegistrationSecrets.id, seeded.signingSecret.id)),
    }, {
      error: /signing-secret envelope mismatch/,
      mutate: () => db.update(externalAppRegistrationSecrets).set({
        envelopeKeyId: "drifted-envelope-key",
      }).where(eq(externalAppRegistrationSecrets.id, seeded.signingSecret.id)),
    }];
    let expectedEndpointRevision = firstRebind.endpointRevision;
    for (const drift of driftMutations) {
      await drift.mutate();
      await assert.rejects(
        createSlackBridgeLocalRuntimeFromEnv(runtimeEnv, { db }),
        drift.error,
        "runtime startup must fail closed on durable ingress authority drift",
      );
      const rebound = await rebindSlackBridgeLocalIngressAuthorityFromEnv(runtimeEnv, { db });
      expectedEndpointRevision += 1;
      assert.equal(rebound.endpointRevision, expectedEndpointRevision);
      assert.deepEqual(
        await verifySlackBridgeLocalIngressAuthorityFromEnv(runtimeEnv, { db }),
        rebound,
      );
    }
    const [signingSecretAfterRebind] = await db.select().from(externalAppRegistrationSecrets).where(and(
      eq(externalAppRegistrationSecrets.registrationId, seeded.registration.id),
      eq(externalAppRegistrationSecrets.purpose, "signing_secret"),
    ));
    assert.ok(signingSecretAfterRebind);

    let sinkCalls = 0;
    let finishWorker!: (value: unknown) => void;
    const terminalWorker = new Promise<unknown>((resolve) => { finishWorker = resolve; });
    runtime = await createSlackBridgeLocalRuntimeFromEnv(runtimeEnv, {
      db,
      fetch: async (url, init) => {
        sinkCalls += 1;
        assert.equal(String(url), "https://slack.com/api/chat.postMessage");
        assert.equal((init?.headers as Record<string, string>).authorization, "Bearer xoxb-provider-disabled");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.channel, CONVERSATION_ID);
        assert.equal(body.username, `${identity.displayName} from Raft`);
        return new Response(JSON.stringify({ ok: true, channel: CONVERSATION_ID, ts: "1785990000.000001" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      runWorkerOnce: async (args) => {
        const result = await processExternalDeliveryPartitionHead(args);
        if (result.kind === "attempted") finishWorker(result);
        return result;
      },
    });
    assert.ok(runtime);
    const verificationBody = Buffer.from(JSON.stringify({
      type: "url_verification",
      challenge: "source-controlled-authority-rebind-pass",
    }), "utf8");
    const verificationNow = new Date();
    const verificationTimestamp = Math.floor(verificationNow.getTime() / 1_000).toString();
    const verificationSignature = `v0=${createHmac("sha256", "provider-disabled-signing-secret")
      .update(`v0:${verificationTimestamp}:${verificationBody.toString("utf8")}`)
      .digest("hex")}`;
    assert.deepEqual(await verifyAndAdmitSlackIngress({
      requestUrl: "https://bridge-full-flow.example.test/api/slack-bridge/events",
      environment: "test",
      rawBody: verificationBody,
      timestampHeader: verificationTimestamp,
      signatureHeader: verificationSignature,
      secretResolver: runtime.secretResolver,
      payloadSealer: runtime.payloadSealer,
      now: verificationNow,
    }), {
      kind: "url_verification",
      challenge: "source-controlled-authority-rebind-pass",
      endpointRevision: expectedEndpointRevision,
      signingSecretRevision: 2,
    });
    runtime.start();

    const accessToken = await login(app.baseUrl, identity.email);
    const [alreadyLinkedMessage] = await db.insert(messages).values({
      channelId: seeded.channel.id,
      senderType: "user",
      senderId: seeded.ownerId,
      content: "attachment identity conservation seed",
    }).returning({ id: messages.id });
    const [alreadyLinkedAttachment] = await db.insert(attachments).values({
      messageId: alreadyLinkedMessage.id,
      messagePosition: 0,
      channelId: seeded.channel.id,
      uploaderId: seeded.ownerId,
      uploaderType: "user",
      filename: "already-linked.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      storageKey: `slack-full-flow/${suffix}/already-linked.txt`,
    }).returning({ id: attachments.id });
    const assertAttachmentFailure = async (
      label: string,
      attachmentIds: string[],
      expectedCode: string,
    ) => {
      const beforeMessages = await db.select({ id: messages.id }).from(messages)
        .where(eq(messages.channelId, seeded.channel.id));
      const beforeDeliveries = await db.select({ id: externalOutboundDeliveries.id })
        .from(externalOutboundDeliveries)
        .where(eq(externalOutboundDeliveries.bindingId, seeded.binding.id));
      const response = await fetch(`${app.baseUrl}/api/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "x-server-id": seeded.server.id,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          channelId: seeded.channel.id,
          content: `attachment ${label}`,
          attachmentIds,
          randomId: `slack-attachment-${label}-${suffix}`,
        }),
      });
      assert.equal(response.status, 400, `${label} must preserve its HTTP contract`);
      assert.equal((await response.json() as { code?: string }).code, expectedCode);
      assert.deepEqual(
        await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, seeded.channel.id)),
        beforeMessages,
        `${label} source rollback`,
      );
      assert.deepEqual(
        await db.select({ id: externalOutboundDeliveries.id }).from(externalOutboundDeliveries)
          .where(eq(externalOutboundDeliveries.bindingId, seeded.binding.id)),
        beforeDeliveries,
        `${label} outbox rollback`,
      );
    };
    const missingAttachmentId = randomUUID();
    await assertAttachmentFailure(
      "duplicate",
      [missingAttachmentId, missingAttachmentId],
      "attachment_duplicate",
    );
    await assertAttachmentFailure("missing", [randomUUID()], "attachment_not_found");
    await assertAttachmentFailure(
      "already-linked",
      [alreadyLinkedAttachment.id],
      "attachment_already_linked",
    );
    await db.delete(messages).where(eq(messages.id, alreadyLinkedMessage.id));

    await db.update(externalAuthorPolicies).set({ displayName: "diagnostic-stale-display" })
      .where(eq(externalAuthorPolicies.id, seeded.policy.id));
    const diagnosticPost = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-server-id": seeded.server.id,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channelId: seeded.channel.id,
        content: "provider-disabled diagnostic message",
        randomId: `slack-diagnostic-${suffix}`,
      }),
    });
    assert.equal(diagnosticPost.status, 500);
    assert.deepEqual(await diagnosticPost.json(), {
      error: "Failed to send message",
      code: "slack_bridge_outbound_admission_failed",
      phase: "render_authority",
    });
    assert.deepEqual(
      await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, seeded.channel.id)),
      [],
    );
    assert.equal((await db.select().from(externalOutboundDeliveries)
      .where(eq(externalOutboundDeliveries.bindingId, seeded.binding.id))).length, 0);
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const productionDiagnosticPost = await fetch(`${app.baseUrl}/api/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "x-server-id": seeded.server.id,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          channelId: seeded.channel.id,
          content: "production-suppressed diagnostic message",
          randomId: `slack-production-diagnostic-${suffix}`,
        }),
      });
      assert.equal(productionDiagnosticPost.status, 500);
      assert.deepEqual(await productionDiagnosticPost.json(), { error: "Failed to send message" });
      assert.deepEqual(
        await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, seeded.channel.id)),
        [],
      );
      assert.equal((await db.select().from(externalOutboundDeliveries)
        .where(eq(externalOutboundDeliveries.bindingId, seeded.binding.id))).length, 0);
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
    await db.update(externalAuthorPolicies).set({ displayName: identity.displayName })
      .where(eq(externalAuthorPolicies.id, seeded.policy.id));

    const memberRows = await db.select({ userId: serverMembers.userId })
      .from(serverMembers)
      .where(eq(serverMembers.serverId, seeded.server.id));
    const channelRows = await db.select({ userId: channelHumans.userId })
      .from(channelHumans)
      .where(eq(channelHumans.channelId, seeded.channel.id));
    const [messageBaseline] = await db.select({ count: sql<number>`count(*)::int` }).from(messages)
      .where(eq(messages.channelId, seeded.channel.id));
    const [deliveryBaseline] = await db.select({ count: sql<number>`count(*)::int` }).from(externalOutboundDeliveries)
      .where(eq(externalOutboundDeliveries.bindingId, seeded.binding.id));
    const [linkBaseline] = await db.select({ count: sql<number>`count(*)::int` }).from(externalMessageLinks)
      .where(eq(externalMessageLinks.bindingId, seeded.binding.id));
    const [attemptBaseline] = await db.select({ count: sql<number>`count(*)::int` }).from(externalDeliveryAttempts);
    const [leaseBaseline] = await db.select({ count: sql<number>`count(*)::int` }).from(externalAppCredentials)
      .where(and(eq(externalAppCredentials.installId, seeded.install.id), isNotNull(externalAppCredentials.leaseOwner)));
    const [targetChannel] = await db.select({ type: channels.type }).from(channels)
      .where(eq(channels.id, seeded.channel.id));
    const [canonicalJointRows] = await db.select({ count: sql<number>`count(*)::int` }).from(jointChannels)
      .where(eq(jointChannels.canonicalChannelId, seeded.channel.id));
    const [localJointRows] = await db.select({ count: sql<number>`count(*)::int` }).from(jointChannelServers)
      .where(eq(jointChannelServers.localChannelId, seeded.channel.id));
    const [externalBindingRows] = await db.select({ count: sql<number>`count(*)::int` }).from(externalChannelBindings)
      .where(and(
        eq(externalChannelBindings.channelId, seeded.channel.id),
        eq(externalChannelBindings.state, "active"),
      ));
    const runtimeBuildManifest = JSON.parse(await readFile(
      new URL("./slackBridgeRuntimeBuildManifest.json", import.meta.url),
      "utf8",
    )) as { schema: string; sources: string[]; fingerprint: string };
    assert.deepEqual(runtimeBuildManifest, {
      schema: "slack-bridge-runtime-build-manifest.v1",
      sources: [
        "../server.ts",
        "../app.ts",
        "../routes/externalAvatars.ts",
        "../services/userService.ts",
        "../services/agentService.ts",
        "../services/messageService.ts",
        "../services/messageReactionService.ts",
        "../services/externalDeliveryOutboxService.ts",
        "../services/externalAppIngressService.ts",
        "../services/externalInboundWorkerService.ts",
        "../services/externalAttachmentProviderAdapter.ts",
        "../services/externalAttachmentTransferService.ts",
        "../services/externalOutboundAttachmentCoordinator.ts",
        "../services/externalReactionEmojiMap.ts",
        "../services/externalReactionCommandRuntime.ts",
        "../services/externalReactionSyncService.ts",
        "../services/externalReactionWorkerService.ts",
        "../services/externalAvatarMaterializerService.ts",
        "../services/externalAuthorAvatarSyncRuntime.ts",
        "../services/externalInboundAttachmentStorageService.ts",
        "../services/externalInboundAttachmentWorkerService.ts",
        "../services/attachmentUploadPolicy.ts",
        "../services/fileUploadQuotaService.ts",
        "../services/attachmentProjectionWriterService.ts",
        "../services/attachmentTransferIntentService.ts",
        "../services/attachmentLinkingService.ts",
        "../services/storageService.ts",
        "../services/slackInboundAttachmentAdapter.ts",
        "../services/slackOutboundAttachmentAdapter.ts",
        "../services/slackAvatarSourceAdapter.ts",
        "../services/raftAvatarSourceAdapter.ts",
        "../services/slackBridgeDatabaseRuntimeAuthority.ts",
        "../services/slackBridgeDatabaseOutboundRuntime.ts",
        "../services/slackProviderAdapter.ts",
        "../services/slackBridgeProviderRuntime.ts",
        "../services/slackBridgeServerRuntime.ts",
      ],
      fingerprint: runtimeBuildManifest.fingerprint,
    });
    const runtimeBuildHasher = createHash("sha256");
    for (const source of runtimeBuildManifest.sources) {
      runtimeBuildHasher.update(await readFile(new URL(source, import.meta.url)));
    }
    const runtimeBuildFingerprint = runtimeBuildHasher.digest("hex");
    const serverBootstrapSource = await readFile(new URL("../server.ts", import.meta.url), "utf8");
    assert.match(serverBootstrapSource, /onInboundMessageCommitted:\s*async/u);
    assert.match(serverBootstrapSource, /emitExternalProjectionMessageToFrontend\(slackBridgeSocket, messageId\)/u);
    assert.match(serverBootstrapSource, /onInboundReactionCommitted:\s*async/u);
    assert.match(serverBootstrapSource, /emitExternalReactionMessageUpdateToFrontend\(slackBridgeSocket, messageId\)/u);

    const preflightInput: SlackBridgeFullFlowPreflightInput = {
      schema: SLACK_BRIDGE_FULL_FLOW_PREFLIGHT_SCHEMA,
      identity: {
        userId: seeded.ownerId,
        ...identity,
        emailVerified: true,
        profileSetupCompleted: true,
      },
      audience: {
        serverId: seeded.server.id,
        channelId: seeded.channel.id,
        ownerId: seeded.server.ownerId,
        memberIds: memberRows.map((row) => row.userId),
        channelHumanIds: channelRows.map((row) => row.userId),
      },
      topology: {
        requestedChannelType: targetChannel?.type ?? "missing",
        canonicalJointRows: canonicalJointRows?.count ?? -1,
        localJointRows: localJointRows?.count ?? -1,
        externalBindingRows: externalBindingRows?.count ?? -1,
        runtimeBuildFingerprint,
        expectedRuntimeBuildFingerprint: runtimeBuildManifest.fingerprint,
      },
      registration: {
        id: seeded.registration.id,
        provider: seeded.registration.provider,
        environment: seeded.registration.environment,
        providerAppId: seeded.registration.providerAppId,
        oauthClientId: seeded.registration.oauthClientId,
        oauthClientInstalled: true,
        manifestVersion: seeded.registration.capabilityManifestVersion,
        manifestHash: seeded.registration.capabilityManifestHash,
      },
      grant: {
        id: seeded.grant.id,
        serverId: seeded.grant.serverId,
        registrationId: seeded.grant.registrationId,
        grantEpoch: seeded.grant.grantEpoch,
        manifestVersion: seeded.grant.grantedManifestVersion,
        manifestHash: seeded.grant.grantedManifestHash,
      },
      install: {
        id: seeded.install.id,
        serverId: seeded.install.serverId,
        registrationId: seeded.install.registrationId,
        serverGrantId: seeded.install.serverGrantId,
        state: seeded.install.state,
        grantEpoch: seeded.install.grantEpoch,
        connectionEpoch: seeded.install.connectionEpoch,
        credentialRevision: seeded.install.credentialRevision,
        providerAppId: seeded.install.providerAppId,
        providerAuthorityId: seeded.install.providerAuthorityId,
      },
      credential: {
        installId: seeded.credential.installId,
        state: seeded.credential.state,
        credentialRevision: seeded.credential.credentialRevision,
        envelopeKeyId: seeded.credential.envelopeKeyId,
        aadVersion: seeded.credential.aadVersion,
        leaseOwner: seeded.credential.leaseOwner,
        leaseExpiresAt: seeded.credential.leaseExpiresAt?.toISOString() ?? null,
      },
      manifest: {
        registrationId: seeded.manifest.registrationId,
        status: seeded.manifest.status,
        receiptRevision: seeded.manifest.receiptRevision,
        managerCredentialRevision: seeded.manifest.managerCredentialRevision,
        providerAppId: seeded.manifest.providerAppId,
        normalizedManifestHash: seeded.manifest.normalizedManifestHash,
        expiresAt: seeded.manifest.expiresAt.toISOString(),
      },
      signingSecret: {
        registrationId: signingSecretAfterRebind.registrationId,
        purpose: signingSecretAfterRebind.purpose,
        secretRevision: signingSecretAfterRebind.secretRevision,
        envelopeKeyId: signingSecretAfterRebind.envelopeKeyId,
        aadVersion: signingSecretAfterRebind.aadVersion,
      },
      binding: {
        id: seeded.binding.id,
        serverId: seeded.binding.serverId,
        registrationId: seeded.binding.registrationId,
        installId: seeded.binding.installId,
        channelId: seeded.binding.channelId,
        state: seeded.binding.state,
        connectionEpoch: seeded.binding.connectionEpoch,
        bindingEpoch: seeded.binding.bindingEpoch,
        privacyClass: seeded.binding.privacyClass,
        providerConversationId: seeded.binding.providerConversationId,
        consentRevision: seeded.policy.consentRevision,
      },
      membership,
      oracle,
      authorPolicy: {
        serverId: seeded.policy.serverId,
        provider: seeded.policy.provider,
        registrationId: seeded.policy.appRegistrationId,
        installId: seeded.policy.installId,
        bindingId: seeded.policy.bindingId,
        bindingEpoch: seeded.policy.bindingEpoch,
        authorId: seeded.policy.authorId,
        displayName: seeded.policy.displayName,
        consentRevision: seeded.policy.consentRevision,
        state: seeded.policy.state,
      },
      flags: {
        configRevision: flagVersion.version,
        enabled: Object.fromEntries(Object.values(SLACK_BRIDGE_FEATURE_FLAG_KEYS).map((flag) => [flag, true])),
      },
      baseline: {
        sourceMessages: messageBaseline?.count ?? 0,
        outboundDeliveries: deliveryBaseline?.count ?? 0,
        providerLinks: linkBaseline?.count ?? 0,
        deliveryAttempts: attemptBaseline?.count ?? 0,
        activeCredentialLeases: leaseBaseline?.count ?? 0,
      },
      executionFence: {
        providerNetworkDisabled: true,
        localSlackSinkOnly: true,
      },
    };
    const preflight = runSlackBridgeFullFlowPreflight(preflightInput);

    assert.ok(Date.now() - new Date(preflight.capturedAt).getTime() < 5_000, "POST begins within preflight window");
    const messageBody = JSON.stringify({
      channelId: seeded.channel.id,
      content: "provider-disabled full-flow message",
      randomId: `slack-full-${suffix}`,
    });
    app.app.set("io", {
      to() {
        return { emit() { throw new Error("private full-flow socket failure"); } };
      },
      in() {
        return { in() { return { socketsJoin() {} }; }, socketsJoin() {} };
      },
    });
    const send = () => fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-server-id": seeded.server.id,
        "content-type": "application/json",
      },
      body: messageBody,
    });
    const post = await send();
    const postBodyText = await post.text();
    assert.equal(post.status, 200, `first response must return the durable message: ${postBodyText}`);
    const posted = JSON.parse(postBodyText) as { id: string; channelId: string; content: string };
    assert.equal(posted.channelId, seeded.channel.id);

    const workerResult = await Promise.race([
      terminalWorker,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("worker terminal timeout")), 3_000)),
    ]) as { kind: string; outcome?: string; deliveryState?: string };
    assert.deepEqual(
      { kind: workerResult.kind, outcome: workerResult.outcome, deliveryState: workerResult.deliveryState },
      { kind: "attempted", outcome: "accepted", deliveryState: "accepted" },
    );
    assert.equal(sinkCalls, 1);

    const replay = await send();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), posted);
    assert.equal(sinkCalls, 1, "same-randomId replay never reaches the provider");

    await runtime.stop();
    runtime = await createSlackBridgeLocalRuntimeFromEnv(runtimeEnv, {
      db,
      fetch: async (url, init) => {
        sinkCalls += 1;
        assert.equal(String(url), "https://slack.com/api/chat.postMessage");
        assert.equal((init?.headers as Record<string, string>).authorization, "Bearer xoxb-provider-disabled");
        return new Response(JSON.stringify({ ok: true, channel: CONVERSATION_ID, ts: "1785990000.000001" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.ok(runtime);
    runtime.start();
    const recoveredReplay = await send();
    const recoveredBodyText = await recoveredReplay.text();
    assert.equal(recoveredReplay.status, 200, `restart replay failed: ${recoveredBodyText}`);
    assert.deepEqual(JSON.parse(recoveredBodyText), posted);
    assert.equal(sinkCalls, 1, "restart readback never repeats an accepted provider write");

    const sourceRows = await db.select().from(messages).where(eq(messages.id, posted.id));
    const deliveries = await db.select().from(externalOutboundDeliveries)
      .where(eq(externalOutboundDeliveries.sourceMessageId, posted.id));
    const attempts = await db.select().from(externalDeliveryAttempts)
      .where(eq(externalDeliveryAttempts.deliveryId, deliveries[0]!.id));
    const links = await db.select().from(externalMessageLinks)
      .where(eq(externalMessageLinks.deliveryId, deliveries[0]!.id));
    const [partition] = await db.select().from(externalDeliveryPartitions)
      .where(eq(externalDeliveryPartitions.bindingId, seeded.binding.id));
    const facts = await db.select().from(inboxNotificationFacts)
      .where(eq(inboxNotificationFacts.messageId, posted.id));
    const serving = await db.select().from(inboxServingRows)
      .where(and(
        eq(inboxServingRows.sourceChannelId, seeded.channel.id),
        inArray(inboxServingRows.receiverId, [seeded.ownerId, seeded.peerId]),
      ));
    const mobile = await db.select().from(mobilePushOutbox)
      .where(eq(mobilePushOutbox.messageId, posted.id));
    const [credentialAfter] = await db.select().from(externalAppCredentials)
      .where(eq(externalAppCredentials.installId, seeded.install.id));

    assert.equal(sourceRows.length, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.state, "accepted");
    assert.equal(deliveries[0]!.providerMessageId, "1785990000.000001");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.outcome, "accepted");
    assert.equal(links.length, 1);
    assert.equal(links[0]!.outcomeState, "accepted");
    assert.equal(partition.lastEnqueuedPosition, 1);
    assert.equal(partition.cursorPosition, 1);
    assert.deepEqual(new Set(facts.map((fact) => fact.receiverId)), new Set([seeded.ownerId, seeded.peerId]));
    assert.equal(serving.length, 2);
    assert.equal(mobile.length, 1);
    assert.equal(mobile[0]!.receiverId, seeded.peerId);
    assert.equal(credentialAfter.leaseOwner, null);
    assert.equal(credentialAfter.leaseExpiresAt, null);
    assert.equal(deliveries[0]!.leaseOwner, null);
    assert.equal(deliveries[0]!.leaseExpiresAt, null);
  } finally {
    await runtime?.stop();
    await runtimeFile?.cleanup();
    await app.close();
  }
});
