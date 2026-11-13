import { recoverSlackLifecyclePauses } from "./slackChannelLifecycleRecovery";
import { projectSlackProviderChannelsForServer, refreshSlackConversationAuthority, type SlackBridgeProvisioningProvider } from "./slackBridgeProvisioningControlPlane";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import {
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppIngressEndpoints,
  externalAppInstallGrantReceipts,
  externalAppInstallServerGrants,
  externalAppInstalls,
  externalAppManifestReceipts,
  externalAppRegistrations,
  externalAppRegistrationSecrets,
  externalAppServerGrants,
  externalChannelBindings, slackChannelDeletions,
  externalIngressDiscardReceipts,
  externalInboundEvents,
  externalOutboundDeliveries,
  featureFlagRules,
  featureFlags,
  messages,
  oauthClientInstalls,
  oauthClients,
  users,
} from "../db/schema";
import { createServer } from "./serverService";
import {
  ExternalAppIngressError,
  verifyAndAdmitSlackIngress,
} from "./externalAppIngressService";
import { updateFeatureFlag } from "./featureFlagService";
import { readSlackBindingLifecycleProjection, reconcileSlackChannelLifecycle } from "./slackBindingLifecycleService";
import { slackBridgeInstallGrantHash } from "./slackBridgeInstallGrantService";
import { SLACK_BRIDGE_CORE_BOT_SCOPES } from "./slackBridgeProductionAppContract";


const NOW = new Date("2026-08-05T12:00:00.000Z");
const SIGNING_SECRET = "test-only-signing-secret";
const REQUEST_URL = "https://bridge-test.example.test/api/slack-bridge/events";

afterEach(async () => {
  await closeTestDatabase();
});

async function seedIngressAuthority(
  privacyClass: "public" | "private" = "public",
) {
  await openTestDatabase("pglite://");
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `slack-ingress-${randomUUID()}@test.invalid`,
    name: `slack-ingress-${randomUUID()}`,
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const server = await createServer("Slack Ingress", `slack-ingress-${randomUUID()}`, owner.id);
  const [client] = await db.insert(oauthClients).values({
    serverId: server.id,
    clientId: `slack-ingress-${randomUUID()}`,
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
    providerAppId: "A_TEST_APP",
    providerOAuthClientId: "123.456",
    capabilityManifestVersion: 1,
    capabilityManifestHash: "manifest-v1",
    requiredCapabilities: ["external_projection", "channel_events"],
  }).returning();
  const [signingSecret] = await db.insert(externalAppRegistrationSecrets).values([{
    registrationId: registration.id,
    purpose: "signing_secret",
    encryptedSecretRef: "local-ref:signing:v1",
    envelopeKeyId: "envelope-1",
    secretRevision: 1,
    aadVersion: 1,
  }, {
    registrationId: registration.id,
    purpose: "manifest_manager",
    encryptedSecretRef: "local-ref:manifest:v1",
    envelopeKeyId: "envelope-1",
    secretRevision: 1,
    aadVersion: 1,
  }]).returning();
  const [endpoint] = await db.insert(externalAppIngressEndpoints).values({
    registrationId: registration.id,
    environment: "test",
    exactRequestUrl: REQUEST_URL,
    endpointRevision: 1,
    signingSecretRevision: 1,
  }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "manifest-v1",
    grantedCapabilities: ["external_projection", "channel_events"],
    grantedByType: "human",
    grantedById: owner.id,
  }).returning();
  const scopes = ["channels:history", "channels:read", "chat:write"];
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
    providerAppId: "A_TEST_APP",
    providerTeamId: "T_TEST",
    providerEnterpriseId: null,
    authorityType: "team",
    providerAuthorityId: "T_TEST",
    botUserId: "U_BOT",
    providerBotId: "B_BOT",
    workspaceName: "Test Workspace",
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
    encryptedMaterial: "sealed-bot-token",
    envelopeKeyId: "envelope-1",
    aadVersion: 1,
    credentialRevision: 1,
  });
  await db.insert(externalAppManifestReceipts).values({
    registrationId: registration.id,
    receiptRevision: 1,
    managerCredentialRevision: 1,
    providerAppId: "A_TEST_APP",
    normalizedManifestHash: "manifest-v1",
    normalizedScopes: scopes,
    normalizedEvents: ["message.channels"],
    normalizedSettings: {},
    status: "valid",
    observedAt: new Date(NOW.getTime() - 60_000),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
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
    observedAt: new Date(NOW.getTime() - 60_000),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
  });
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `slack-ingress-${randomUUID()}`,
    type: privacyClass === "private" ? "private" : "channel",
  }).returning();
  const [binding] = await db.insert(externalChannelBindings).values({
    serverId: server.id,
    registrationId: registration.id,
    installId: install.id,
    channelId: channel.id,
    providerConversationId: "C_TEST",
    providerConversationKind: privacyClass === "private" ? "private_channel" : "public_channel",
    privacyClass,
    state: "active",
    grantEpoch: 1,
    connectionEpoch: 2,
    bindingEpoch: 3,
    audienceRevision: privacyClass === "private" ? 1 : null,
    audienceFreshUntil: privacyClass === "private"
      ? new Date(NOW.getTime() + 60 * 60_000)
      : null,
    consentedByType: "human",
    consentedById: owner.id,
    consentedAt: NOW,
  }).returning();
  const [projection] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: registration.id,
    installId: install.id,
    workspaceId: "T_TEST",
    externalActorId: "U_HUMAN",
    displayName: "External Human",
    handles: ["external-human"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 4,
    observedAt: NOW,
  }).returning();
  await db.insert(externalAddressabilityProjections).values({
    projectionId: projection.id,
    provider: "slack",
    appRegistrationId: registration.id,
    installId: install.id,
    workspaceId: "T_TEST",
    connectionEpoch: 2,
    bindingId: binding.id,
    bindingEpoch: 3,
    conversationId: "C_TEST",
    memberRevision: 5,
    contextRevision: 6,
    state: "active",
    observedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
  });
  return { registration, signingSecret, endpoint, grant, install, channel, binding, projection };
}

function signedRequest(body: Buffer) {
  const timestampHeader = String(Math.floor(NOW.getTime() / 1_000));
  const signatureHeader = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestampHeader}:`, "utf8")
    .update(body)
    .digest("hex")}`;
  return { timestampHeader, signatureHeader };
}

function handshakeDependencies() {
  return {
    secretResolver: {
      async resolveSigningSecret() {
        return SIGNING_SECRET;
      },
    },
    payloadSealer: {
      async sealNormalizedPayload() {
        assert.fail("URL verification must never reach payload sealing");
      },
    },
  };
}

test("signed Slack URL verification accepts the official three-field payload and preserves app authority", async () => {
  await seedIngressAuthority();
  const body = Buffer.from(JSON.stringify({
    token: "deprecated-verification-token-is-not-authority",
    challenge: "official-shape-challenge",
    type: "url_verification",
  }));
  const result = await verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: body,
    ...signedRequest(body),
    ...handshakeDependencies(),
    now: NOW,
  });
  assert.deepEqual(result, {
    kind: "url_verification",
    challenge: "official-shape-challenge",
    endpointRevision: 1,
    signingSecretRevision: 1,
  });
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);

  const mismatched = Buffer.from(JSON.stringify({
    token: "deprecated-verification-token-is-not-authority",
    challenge: "mismatched-app-challenge",
    type: "url_verification",
    api_app_id: "A_OTHER_APP",
  }));
  await assert.rejects(verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: mismatched,
    ...signedRequest(mismatched),
    ...handshakeDependencies(),
    now: NOW,
  }), (error: unknown) => error instanceof Error
    && "code" in error
    && error.code === "external_ingress_authority_unavailable");
});

test("Slack URL verification rejects missing and invalid request signatures", async () => {
  await seedIngressAuthority();
  const body = Buffer.from(JSON.stringify({
    token: "deprecated-verification-token-is-not-authority",
    challenge: "unsigned-challenge",
    type: "url_verification",
  }));
  const { timestampHeader } = signedRequest(body);
  for (const signatureHeader of ["", `v0=${"0".repeat(64)}`]) {
    await assert.rejects(verifyAndAdmitSlackIngress({
      requestUrl: REQUEST_URL,
      environment: "test",
      rawBody: body,
      timestampHeader,
      signatureHeader,
      ...handshakeDependencies(),
      now: NOW,
    }), (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "external_ingress_signature_invalid");
  }
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
  assert.equal((await getDb().select().from(externalIngressDiscardReceipts)).length, 0);
});

test("Slack event callbacks still require an exact application id", async () => {
  await seedIngressAuthority();
  for (const apiAppId of [undefined, "A_OTHER_APP"]) {
    const body = Buffer.from(JSON.stringify({
      type: "event_callback",
      api_app_id: apiAppId,
      team_id: "T_TEST",
      event_id: `Ev_APP_ID_${apiAppId ?? "MISSING"}`,
      event: {
        type: "message",
        channel: "C_TEST",
        user: "U_HUMAN",
        text: "must not be admitted",
        ts: "1785931200.000099",
      },
    }));
    await assert.rejects(verifyAndAdmitSlackIngress({
      requestUrl: REQUEST_URL,
      environment: "test",
      rawBody: body,
      ...signedRequest(body),
      ...handshakeDependencies(),
      now: NOW,
    }), (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "external_ingress_authority_unavailable");
  }
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
});

test("signed Slack message admission seals current normalized payload and dedupes into externalInboundEvents", async () => {
  const fixture = await seedIngressAuthority();
  const body = Buffer.from(JSON.stringify({
    type: "event_callback",
    api_app_id: "A_TEST_APP",
    team_id: "T_TEST",
    event_id: "Ev_TEST_1",
    event: {
      type: "message",
      channel: "C_TEST",
      user: "U_HUMAN",
      text: "hello <!subteam^SAGENT123|@build-bot> from Slack",
      ts: "1785931200.000100",
    },
  }));
  const signed = signedRequest(body);
  let sealCalls = 0;
  const dependencies = {
    secretResolver: {
      async resolveSigningSecret(input: { encryptedSecretRef: string }) {
        assert.equal(input.encryptedSecretRef, "local-ref:signing:v1");
        return SIGNING_SECRET;
      },
    },
    payloadSealer: {
      async sealNormalizedPayload(input: { plaintext: string; aad: Record<string, unknown> }) {
        sealCalls += 1;
        assert.equal(input.aad.bindingId, fixture.binding.id);
        assert.equal(input.aad.runtimeRevision, "runtime-exact-1");
        assert.equal(input.aad.schemaVersion, 2);
        const normalized = JSON.parse(input.plaintext) as Record<string, unknown>;
        assert.equal(normalized.schema, "external-inbound-normalized-event.v3");
        assert.deepEqual(normalized.providerAgentMentions, [{
          providerUsergroupId: "SAGENT123",
          handle: "build-bot",
        }]);
        return { encryptedPayload: "sealed:inbound-event", envelopeKeyId: "payload-key-1", aadVersion: 1 };
      },
    },
    runtimeResolver: {
      async resolveCurrentRuntime(input: { memberRevision: number; contextRevision: number }) {
        assert.equal(input.memberRevision, 5);
        assert.equal(input.contextRevision, 6);
        return { runtimeRevision: "runtime-exact-1" };
      },
    },
  };
  const first = await verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: body,
    ...signed,
    ...dependencies,
    now: NOW,
  });
  assert.equal(first.kind, "event");
  if (first.kind !== "event") assert.fail("expected event admission");
  assert.equal(first.duplicate, false);
  assert.equal(first.status, "queued");
  assert.equal(first.authority?.bindingId, fixture.binding.id);
  const [row] = await getDb().select().from(externalInboundEvents).where(eq(
    externalInboundEvents.id,
    first.eventInboxId,
  ));
  assert.equal(row.runtimeRevision, "runtime-exact-1");
  assert.equal(row.raftChannelId, fixture.channel.id);
  assert.equal(row.normalizedPayloadDigest.length, 64);
  assert.equal(row.encryptedPayload, "sealed:inbound-event");
  assert.equal(row.payloadAadPurpose, "external-inbound-normalized-event");
  assert.equal(row.payloadSchemaVersion, 2);

  const replay = await verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: body,
    ...signed,
    ...dependencies,
    now: NOW,
  });
  assert.equal(replay.kind, "event");
  if (replay.kind !== "event") assert.fail("expected replay admission");
  assert.equal(replay.eventInboxId, first.eventInboxId);
  assert.equal(replay.duplicate, true);
  assert.equal(sealCalls, 2);
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 1);
});

test("signed Slack message admission fails closed without exact actor addressability", async () => {
  const fixture = await seedIngressAuthority();
  await getDb().delete(externalAddressabilityProjections).where(eq(
    externalAddressabilityProjections.projectionId,
    fixture.projection.id,
  ));
  const body = Buffer.from(JSON.stringify({
    type: "event_callback",
    api_app_id: "A_TEST_APP",
    team_id: "T_TEST",
    event_id: "Ev_ADDRESSABILITY_REQUIRED",
    event: {
      type: "message",
      channel: "C_TEST",
      user: "U_HUMAN",
      text: "must remain outside admission",
      ts: "1785931200.000101",
    },
  }));
  await assert.rejects(verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: body,
    ...signedRequest(body),
    secretResolver: {
      async resolveSigningSecret() {
        return SIGNING_SECRET;
      },
    },
    payloadSealer: {
      async sealNormalizedPayload() {
        assert.fail("missing addressability must fail before payload sealing");
      },
    },
    runtimeResolver: {
      async resolveCurrentRuntime() {
        assert.fail("missing addressability must fail before runtime resolution");
      },
    },
    now: NOW,
  }), (error: unknown) => error instanceof Error
    && "code" in error
    && error.code === "external_ingress_authority_unavailable");
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
});

test("Slack loop and unsupported-subtype events ACK with attributable durable discard receipts", async () => {
  await seedIngressAuthority();
  let sealCalls = 0;
  const dependencies = {
    secretResolver: { async resolveSigningSecret() { return SIGNING_SECRET; } },
    payloadSealer: {
      async sealNormalizedPayload() {
        sealCalls += 1;
        return { encryptedPayload: "never", envelopeKeyId: "never", aadVersion: 1 };
      },
    },
    runtimeResolver: { async resolveCurrentRuntime() { return { runtimeRevision: "never" }; } },
  };
  const cases = [{
    eventId: "Ev_TEST_BOT_LOOP",
    event: {
      type: "message",
      channel: "C_TEST",
      user: "U_BOT",
      text: "unsafe echo",
      ts: "1785931200.000200",
      bot_id: "B_BOT",
    },
    reason: "provider_loop_suppressed",
    retryNum: null,
    retryReason: null,
  }, {
    eventId: "Ev_TEST_BOT_LOOP",
    event: {
      type: "message",
      channel: "C_TEST",
      user: "U_BOT",
      text: "unsafe echo",
      ts: "1785931200.000200",
      bot_id: "B_BOT",
    },
    reason: "provider_loop_suppressed",
    retryNum: "1",
    retryReason: "http_error",
  }, {
    eventId: "Ev_TEST_SUBTYPE",
    event: {
      type: "message",
      subtype: "channel_join",
      channel: "C_TEST",
      user: "U_HUMAN",
      text: "joined the channel",
      ts: "1785931200.000201",
    },
    reason: "unsupported_message_subtype",
    retryNum: "3",
    retryReason: "http_error",
  }] as const;
  for (const item of cases) {
    const body = Buffer.from(JSON.stringify({
      type: "event_callback",
      api_app_id: "A_TEST_APP",
      team_id: "T_TEST",
      event_id: item.eventId,
      event: item.event,
    }));
    const result = await verifyAndAdmitSlackIngress({
      requestUrl: REQUEST_URL,
      environment: "test",
      rawBody: body,
      ...signedRequest(body),
      slackRetryNumHeader: item.retryNum,
      slackRetryReasonHeader: item.retryReason,
      ...dependencies,
      now: NOW,
    });
    assert.equal(result.kind, "event");
    if (result.kind !== "event") assert.fail("expected event discard ACK");
    assert.equal(result.status, "unsupported");
    assert.equal(result.reason, item.reason);
    assert.equal(result.authority, null);
    const [receipt] = await getDb().select().from(externalIngressDiscardReceipts).where(eq(
      externalIngressDiscardReceipts.id,
      result.eventInboxId,
    ));
    assert.ok(receipt);
    assert.equal(receipt.providerEventId, item.eventId);
    assert.equal(receipt.providerConversationId, "C_TEST");
    assert.equal(receipt.outcomeReason, item.reason);
    assert.equal(receipt.slackRetryNum, item.retryNum);
    assert.equal(receipt.slackRetryReason, item.retryReason);
    assert.equal(receipt.payloadDigest, createHash("sha256").update(body).digest("hex"));
    assert.equal(receipt.receivedAt.toISOString(), NOW.toISOString());
  }
  assert.equal(sealCalls, 0);
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
  assert.equal(
    (await getDb().select().from(externalIngressDiscardReceipts)).length,
    cases.length,
    "every provider delivery remains separately attributable even when event_id repeats",
  );

  const noRuntimeBody = Buffer.from(JSON.stringify({
    type: "event_callback",
    api_app_id: "A_TEST_APP",
    team_id: "T_TEST",
    event_id: "Ev_TEST_NO_RUNTIME",
    event: {
      type: "message",
      channel: "C_TEST",
      user: "U_HUMAN",
      text: "must fail before admission",
      ts: "1785931200.000202",
    },
  }));
  await assert.rejects(verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: noRuntimeBody,
    ...signedRequest(noRuntimeBody),
    secretResolver: dependencies.secretResolver,
    payloadSealer: dependencies.payloadSealer,
    now: NOW,
  }), /runtime authority is unavailable/);
  assert.equal((await getDb().select().from(externalIngressDiscardReceipts)).length, cases.length);
});

test("preauthorized reaction, file, and delete events stay default-off without Raft or Slack mutation", async () => {
  await seedIngressAuthority();
  const cases = [{
    eventId: "Ev_FUTURE_REACTION_ADDED",
    event: {
      type: "reaction_added",
      user: "U_HUMAN",
      reaction: "eyes",
      item: { type: "message", channel: "C_TEST", ts: "1785931200.000300" },
      event_ts: "1785931201.000300",
    },
    reason: "capability_disabled",
  }, {
    eventId: "Ev_FUTURE_REACTION_REMOVED",
    event: {
      type: "reaction_removed",
      user: "U_HUMAN",
      reaction: "eyes",
      item: { type: "message", channel: "C_TEST", ts: "1785931200.000301" },
      event_ts: "1785931201.000301",
    },
    reason: "capability_disabled",
  }, {
    eventId: "Ev_FUTURE_FILE_SHARED",
    event: {
      type: "file_shared",
      file_id: "F_PRIVATE",
      user_id: "U_HUMAN",
      event_ts: "1785931201.000302",
    },
    reason: "unsupported_event",
  }, {
    eventId: "Ev_FUTURE_MESSAGE_DELETED",
    event: {
      type: "message",
      subtype: "message_deleted",
      channel: "C_TEST",
      deleted_ts: "1785931200.000304",
      event_ts: "1785931201.000304",
      hidden: true,
    },
    reason: "unsupported_message_subtype",
  }] as const;

  for (const item of cases) {
    const body = Buffer.from(JSON.stringify({
      type: "event_callback",
      api_app_id: "A_TEST_APP",
      team_id: "T_TEST",
      event_id: item.eventId,
      event: item.event,
    }));
    const result = await verifyAndAdmitSlackIngress({
      requestUrl: REQUEST_URL,
      environment: "test",
      rawBody: body,
      ...signedRequest(body),
      secretResolver: { async resolveSigningSecret() { return SIGNING_SECRET; } },
      payloadSealer: {
        async sealNormalizedPayload() {
          assert.fail("default-off events must not enter the durable inbound queue");
        },
      },
      runtimeResolver: {
        async resolveCurrentRuntime() {
          assert.fail("default-off events must not resolve a message runtime");
        },
      },
      now: NOW,
    });
    assert.equal(result.kind, "event");
    if (result.kind !== "event") assert.fail("expected event discard ACK");
    assert.equal(result.status, "unsupported");
    assert.equal(result.reason, item.reason);
    assert.equal(result.authority, null);
  }

  assert.equal((await getDb().select().from(externalIngressDiscardReceipts)).length, cases.length);
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
  assert.equal((await getDb().select().from(messages)).length, 0);
  assert.equal((await getDb().select().from(externalOutboundDeliveries)).length, 0);
});

test("enabled reaction admission seals only normalized message/actor/reaction coordinates as schema v3", async () => {
  const fixture = await seedIngressAuthority();
  const [reactionFlag] = await getDb().select().from(featureFlags)
    .where(eq(featureFlags.key, SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync));
  assert.equal(reactionFlag?.enabled, true);
  assert.equal(reactionFlag?.defaultEnabled, false);
  assert.equal(reactionFlag?.killSwitch, false);
  assert.equal(reactionFlag?.randomizationUnit, "server");
  // The retired reaction flag is not enabled; admission follows the master.
  for (const key of [SLACK_BRIDGE_FEATURE_FLAG_KEYS.master]) {
    assert.ok(await updateFeatureFlag(key, { enabled: true, killSwitch: false }));
    await getDb().insert(featureFlagRules).values({
      flagKey: key,
      stage: "server",
      priority: 999,
      decision: "allow",
      values: [fixture.channel.serverId],
    });
  }
  const body = Buffer.from(JSON.stringify({
    type: "event_callback",
    api_app_id: "A_TEST_APP",
    team_id: "T_TEST",
    event_id: "Ev_REACTION_ENABLED",
    event: {
      type: "reaction_added",
      user: "U_HUMAN",
      reaction: "thumbsup::skin-tone-4",
      item: { type: "message", channel: "C_TEST", ts: "1785931200.000300" },
      event_ts: "1785931201.000301",
    },
  }));
  let normalized: Record<string, unknown> | null = null;
  let aad: Record<string, unknown> | null = null;
  const result = await verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: body,
    ...signedRequest(body),
    secretResolver: { async resolveSigningSecret() { return SIGNING_SECRET; } },
    payloadSealer: {
      async sealNormalizedPayload(input) {
        normalized = JSON.parse(input.plaintext) as Record<string, unknown>;
        aad = input.aad;
        return { encryptedPayload: "sealed:reaction", envelopeKeyId: "payload-key-1", aadVersion: 1 };
      },
    },
    runtimeResolver: {
      async resolveCurrentRuntime(input) {
        assert.deepEqual(input.requiredCapabilities, ["reaction_sync"]);
        return { runtimeRevision: "runtime-reaction-1" };
      },
    },
    now: NOW,
  });
  assert.equal(result.kind, "event");
  if (result.kind !== "event") return;
  assert.equal(result.status, "queued");
  assert.equal((aad as Record<string, unknown> | null)?.schemaVersion, 3);
  assert.deepEqual(normalized, {
    schema: "external-inbound-normalized-reaction.v1",
    operation: "add",
    providerMessageId: "1785931200.000300",
    externalActorId: "U_HUMAN",
    providerReactionKey: "thumbsup::skin-tone-4",
    eventOccurredAt: "2026-08-05T12:00:01.000Z",
    eventSequence: 1_785_931_201_000_301,
    botUserId: "U_BOT",
  });
  const [row] = await getDb().select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, result.eventInboxId));
  assert.equal(row.payloadSchemaVersion, 3);
});

test("Slack Web attachment messages preserve captions without admitting private file metadata", async () => {
  await seedIngressAuthority();
  const normalizedPayloads: Array<Record<string, unknown>> = [];
  const requiredCapabilities: unknown[] = [];
  const dependencies = {
    secretResolver: { async resolveSigningSecret() { return SIGNING_SECRET; } },
    payloadSealer: {
      async sealNormalizedPayload(input: { plaintext: string }) {
        normalizedPayloads.push(JSON.parse(input.plaintext) as Record<string, unknown>);
        assert.doesNotMatch(input.plaintext, /files-pri|private_download|secret-file-name/);
        return {
          encryptedPayload: `sealed:attachment:${normalizedPayloads.length}`,
          envelopeKeyId: "payload-key-1",
          aadVersion: 1,
        };
      },
    },
    runtimeResolver: {
      async resolveCurrentRuntime(input: { requiredCapabilities?: readonly string[] }) {
        requiredCapabilities.push(input.requiredCapabilities);
        return { runtimeRevision: "runtime-exact-1" };
      },
    },
  };
  const samples = [{
    eventId: "Ev_ATTACHMENT_CAPTIONED",
    ts: "1785931200.000210",
    text: "caption from Slack",
    subtype: "file_share",
    expectedContent: "caption from Slack",
  }, {
    eventId: "Ev_ATTACHMENT_CAPTIONLESS",
    ts: "1785931200.000211",
    text: "",
    subtype: "file_share",
    expectedContent: "[Attachment]",
  }, {
    eventId: "Ev_ATTACHMENT_FILE_SHARE_COMPAT",
    ts: "1785931200.000212",
    text: "compat caption",
    subtype: "file_share",
    expectedContent: "compat caption",
  }] as const;
  for (const sample of samples) {
    const body = Buffer.from(JSON.stringify({
      type: "event_callback",
      api_app_id: "A_TEST_APP",
      team_id: "T_TEST",
      event_id: sample.eventId,
      event: {
        type: "message",
        ...(sample.subtype ? { subtype: sample.subtype } : {}),
        channel: "C_TEST",
        user: "U_HUMAN",
        text: sample.text,
        ts: sample.ts,
        files: [{
          id: "F_PRIVATE",
          name: "secret-file-name.txt",
          url_private: "https://files-pri.example.test/private_download",
        }],
      },
    }));
    const result = await verifyAndAdmitSlackIngress({
      requestUrl: REQUEST_URL,
      environment: "test",
      rawBody: body,
      ...signedRequest(body),
      ...dependencies,
      now: NOW,
    });
    assert.equal(result.kind, "event");
    if (result.kind !== "event") assert.fail("expected attachment event admission");
    assert.equal(result.status, "queued");
    assert.equal(result.duplicate, false);
    assert.equal(normalizedPayloads.at(-1)?.schema, "external-inbound-normalized-event.v3");
    assert.equal(normalizedPayloads.at(-1)?.content, sample.expectedContent);
    assert.deepEqual(normalizedPayloads.at(-1)?.providerFileIds, ["F_PRIVATE"]);
    assert.deepEqual(normalizedPayloads.at(-1)?.providerAgentMentions, []);
  }
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 3);
  assert.equal((await getDb().select().from(externalIngressDiscardReceipts)).length, 0);
  assert.deepEqual(requiredCapabilities, [
    ["attachment_transfer"],
    ["attachment_transfer"],
    ["attachment_transfer"],
  ]);
});

test("Slack attachment admission rejects missing subtype, duplicate IDs, and more than ten files", async () => {
  await seedIngressAuthority();
  const invalidFiles = [
    { subtype: undefined, files: [{ id: "F1" }] },
    { subtype: "file_share", files: [{ id: "F1" }, { id: "F1" }] },
    {
      subtype: "file_share",
      files: Array.from({ length: 11 }, (_, index) => ({ id: `F${index + 1}` })),
    },
  ];
  for (const [index, sample] of invalidFiles.entries()) {
    const body = Buffer.from(JSON.stringify({
      type: "event_callback",
      api_app_id: "A_TEST_APP",
      team_id: "T_TEST",
      event_id: `Ev_ATTACHMENT_INVALID_${index}`,
      event: {
        type: "message",
        ...(sample.subtype ? { subtype: sample.subtype } : {}),
        channel: "C_TEST",
        user: "U_HUMAN",
        text: "invalid attachment",
        ts: `1785931200.00022${index}`,
        files: sample.files,
      },
    }));
    await assert.rejects(verifyAndAdmitSlackIngress({
      requestUrl: REQUEST_URL,
      environment: "test",
      rawBody: body,
      ...signedRequest(body),
      secretResolver: { async resolveSigningSecret() { return SIGNING_SECRET; } },
      payloadSealer: { async sealNormalizedPayload() { assert.fail("invalid files must not seal"); } },
      runtimeResolver: { async resolveCurrentRuntime() { assert.fail("invalid files must not resolve runtime"); } },
      now: NOW,
    }), (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "external_ingress_payload_invalid");
  }
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
});

function lifecycleDependencies(onResolve?: () => Promise<void>) {
  return {
    secretResolver: {
      async resolveSigningSecret() {
        await onResolve?.();
        return SIGNING_SECRET;
      },
    },
    payloadSealer: {
      async sealNormalizedPayload() {
        assert.fail("lifecycle events must never reach payload sealing");
      },
    },
  };
}

async function lifecycleAuthorityRows(fixture: Awaited<ReturnType<typeof seedIngressAuthority>>) {
  const [install] = await getDb().select().from(externalAppInstalls).where(eq(
    externalAppInstalls.id,
    fixture.install.id,
  ));
  const [credential] = await getDb().select().from(externalAppCredentials).where(eq(
    externalAppCredentials.installId,
    fixture.install.id,
  ));
  const [binding] = await getDb().select().from(externalChannelBindings).where(eq(
    externalChannelBindings.id,
    fixture.binding.id,
  ));
  return { install, credential, binding };
}

test("Slack app_uninstalled requires the real event_callback wrapper and revokes current authority", async () => {
  const fixture = await seedIngressAuthority();
  const spoof = Buffer.from(JSON.stringify({
    type: "app_uninstalled",
    api_app_id: "A_TEST_APP",
    team_id: "T_TEST",
    event_id: "Ev_APP_UNINSTALLED_SPOOF",
  }));
  const spoofResult = await verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: spoof,
    ...signedRequest(spoof),
    ...lifecycleDependencies(),
    now: NOW,
  });
  assert.equal(spoofResult.kind, "event");
  if (spoofResult.kind !== "event") assert.fail("expected event ACK");
  assert.equal(spoofResult.status, "unsupported");
  assert.equal((await getDb().select().from(externalAppInstalls).where(eq(
    externalAppInstalls.id,
    fixture.install.id,
  )))[0]?.state, "active");

  const wrapped = Buffer.from(JSON.stringify({
    type: "event_callback",
    api_app_id: "A_TEST_APP",
    team_id: "T_TEST",
    event_id: "Ev_APP_UNINSTALLED",
    event: { type: "app_uninstalled" },
  }));
  const result = await verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: wrapped,
    ...signedRequest(wrapped),
    ...lifecycleDependencies(),
    now: NOW,
  });
  assert.equal(result.kind, "event");
  if (result.kind !== "event") assert.fail("expected event ACK");
  assert.equal(result.status, "revoked");
  assert.equal(result.reason, "provider_app_uninstalled");
  assert.equal((await getDb().select().from(externalAppInstalls).where(eq(
    externalAppInstalls.id,
    fixture.install.id,
  )))[0]?.state, "revoked");
  assert.equal((await getDb().select().from(externalAppCredentials).where(eq(
    externalAppCredentials.installId,
    fixture.install.id,
  )))[0]?.state, "revoked");
  assert.equal((await getDb().select().from(externalAppInstallServerGrants).where(eq(
    externalAppInstallServerGrants.installId,
    fixture.install.id,
  )))[0]?.state, "revoked");
  assert.equal((await getDb().select().from(externalChannelBindings).where(eq(
    externalChannelBindings.id,
    fixture.binding.id,
  )))[0]?.state, "revoked");
  assert.deepEqual(await readSlackBindingLifecycleProjection({
    serverId: fixture.binding.serverId,
    bindingId: fixture.binding.id,
  }), {
    state: "disconnected",
    reason: "provider_app_uninstalled",
    recoveryAction: "reinstall_slack_app",
  });
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
});

test("signed Slack channel lifecycle pauses only the exact binding and preserves the Raft channel", async () => {
  for (const [providerEventType, privacyClass, expectedReason, expectedRecoveryAction] of [
    ["channel_archive", "public", "provider_channel_archived", "unarchive_slack_channel"],
    ["channel_deleted", "public", "provider_channel_deleted", "select_replacement_slack_channel"],
    ["group_archive", "private", "provider_channel_archived", "unarchive_slack_channel"],
    ["group_deleted", "private", "provider_channel_deleted", "select_replacement_slack_channel"],
  ] as const) {
    const fixture = await seedIngressAuthority(privacyClass);
    const [historical] = await getDb().insert(externalChannelBindings).values({
      ...fixture.binding, id: randomUUID(), state: "revoked", stateReason: "binding_removed",
    }).returning();
    const body = Buffer.from(JSON.stringify({
      type: "event_callback",
      api_app_id: "A_TEST_APP",
      team_id: "T_TEST",
      event_id: `Ev_${providerEventType}`,
      event: { type: providerEventType, channel: "C_TEST" },
    }));
    const result = await verifyAndAdmitSlackIngress({
      requestUrl: REQUEST_URL,
      environment: "test",
      rawBody: body,
      ...signedRequest(body),
      ...lifecycleDependencies(),
      now: NOW,
    });
    assert.equal(result.kind, "event");
    if (result.kind !== "event") assert.fail("expected channel lifecycle ACK");
    assert.equal(result.status, "paused");
    assert.equal(result.reason, expectedReason);
    assert.equal(result.duplicate, false);
    const deletionFacts = await getDb().select().from(slackChannelDeletions);
    if (providerEventType === "channel_deleted" || providerEventType === "group_deleted") {
      const signed = deletionFacts.filter((fact) => fact.sourceKind === "signed_event");
      assert.equal(signed.length, 1);
      assert.equal(signed[0]!.providerEventType, providerEventType);
      assert.equal(signed[0]!.providerEventId, `Ev_${providerEventType}`);
      assert.equal(signed[0]!.payloadSha256, createHash("sha256").update(body).digest("hex"));
      assert.equal(signed[0]!.signingSecretRevision, 1);
    } else assert.deepEqual(deletionFacts, [], "an archive is never deletion evidence");

    const [binding] = await getDb().select().from(externalChannelBindings).where(eq(
      externalChannelBindings.id,
      fixture.binding.id,
    ));
    assert.equal(binding.state, "paused");
    assert.equal(binding.stateReason, expectedReason);
    assert.equal(binding.bindingEpoch, fixture.binding.bindingEpoch + 1);
    const [oldBinding] = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, historical.id));
    assert.equal(oldBinding.state, "revoked");
    assert.equal(oldBinding.stateReason, "binding_removed");
    assert.equal(oldBinding.bindingEpoch, historical.bindingEpoch);
    assert.deepEqual(await readSlackBindingLifecycleProjection({
      serverId: fixture.binding.serverId,
      bindingId: fixture.binding.id,
    }), {
      state: "paused",
      reason: expectedReason,
      recoveryAction: expectedRecoveryAction,
    });
    assert.equal((await getDb().select().from(channels).where(eq(
      channels.id,
      fixture.channel.id,
    ))).length, 1, "provider lifecycle must not cascade-delete the Raft channel");
    assert.equal((await getDb().select().from(externalAppInstalls).where(eq(
      externalAppInstalls.id,
      fixture.install.id,
    )))[0]?.state, "active", "channel lifecycle must not disconnect the app install");
    const retry = await verifyAndAdmitSlackIngress({
      requestUrl: REQUEST_URL,
      environment: "test",
      rawBody: body,
      ...signedRequest(body),
      ...lifecycleDependencies(),
      now: NOW,
    });
    assert.equal(retry.kind, "event");
    if (retry.kind !== "event") assert.fail("expected idempotent lifecycle ACK");
    assert.equal(retry.duplicate, true);
    assert.equal((await getDb().select().from(externalChannelBindings).where(eq(
      externalChannelBindings.id,
      fixture.binding.id,
    )))[0]?.bindingEpoch, fixture.binding.bindingEpoch + 1);
    if (providerEventType === "channel_archive" || providerEventType === "group_archive") {
      const deletedType = providerEventType === "channel_archive"
        ? "channel_deleted"
        : "group_deleted";
      const deletedBody = Buffer.from(JSON.stringify({
        type: "event_callback",
        api_app_id: "A_TEST_APP",
        team_id: "T_TEST",
        event_id: `Ev_${deletedType}_AFTER_ARCHIVE`,
        event: { type: deletedType, channel: "C_TEST" },
      }));
      const deleted = await verifyAndAdmitSlackIngress({
        requestUrl: REQUEST_URL,
        environment: "test",
        rawBody: deletedBody,
        ...signedRequest(deletedBody),
        ...lifecycleDependencies(),
        now: NOW,
      });
      assert.equal(deleted.kind, "event");
      if (deleted.kind !== "event") assert.fail("expected delete-after-archive ACK");
      assert.equal(deleted.duplicate, false);
      const [strengthened] = await getDb().select().from(externalChannelBindings).where(eq(
        externalChannelBindings.id,
        fixture.binding.id,
      ));
      assert.equal(strengthened.stateReason, "provider_channel_deleted");
      assert.equal(strengthened.bindingEpoch, fixture.binding.bindingEpoch + 2);
    }
    assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
    await closeTestDatabase();
  }
});

test("lifecycle ignores revoked historical bindings and fences a pair revoked after selection", async () => {
  const fixture = await seedIngressAuthority();
  await getDb().update(externalChannelBindings).set({ state: "revoked", stateReason: "binding_removed" })
    .where(eq(externalChannelBindings.id, fixture.binding.id));
  const stale = await reconcileSlackChannelLifecycle({
    serverId: fixture.binding.serverId, registrationId: fixture.registration.id,
    installId: fixture.install.id, bindingId: fixture.binding.id,
    providerAuthorityId: "T_TEST", providerConversationId: "C_TEST",
    expectedConnectionEpoch: fixture.install.connectionEpoch,
    expectedBindingEpoch: fixture.binding.bindingEpoch, event: { kind: "archived" }, now: NOW,
  });
  assert.deepEqual(stale, { kind: "fence_mismatch" });
  const body = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: "A_TEST_APP",
    team_id: "T_TEST", event_id: "Ev_revoked_only", event: { type: "channel_archive", channel: "C_TEST" } }));
  const ignored = await verifyAndAdmitSlackIngress({ requestUrl: REQUEST_URL, environment: "test", rawBody: body,
    ...signedRequest(body), ...lifecycleDependencies(), now: NOW });
  assert.equal(ignored.kind === "event" ? ignored.status : null, "unsupported");
  assert.equal((await getDb().select().from(externalIngressDiscardReceipts)).length, 1);
  const [binding] = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, fixture.binding.id));
  assert.equal(binding.state, "revoked");
  assert.equal(binding.bindingEpoch, fixture.binding.bindingEpoch);
});

test("stale server-grant epoch cannot apply a Slack channel lifecycle mutation", async () => {
  const fixture = await seedIngressAuthority("public");
  await getDb().update(externalAppServerGrants).set({ grantEpoch: fixture.grant.grantEpoch + 1 })
    .where(eq(externalAppServerGrants.id, fixture.grant.id));
  const body = Buffer.from(JSON.stringify({
    type: "event_callback",
    api_app_id: "A_TEST_APP",
    team_id: "T_TEST",
    event_id: "Ev_CHANNEL_ARCHIVE_STALE_GRANT",
    event: { type: "channel_archive", channel: "C_TEST" },
  }));

  const ignored = await verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: body,
    ...signedRequest(body),
    ...lifecycleDependencies(),
    now: NOW,
  });
  assert.equal(ignored.kind === "event" ? ignored.reason : null, "lifecycle_metadata_stale_authority");
  const [binding] = await getDb().select().from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, fixture.binding.id));
  assert.equal(binding.state, "active");
  assert.equal(binding.bindingEpoch, fixture.binding.bindingEpoch);
});

test("Slack tokens_revoked fences only the current install bot user id", async () => {
  const fixture = await seedIngressAuthority();
  for (const [eventId, tokens] of [
    ["Ev_TOKENS_OAUTH_ONLY", { oauth: ["U_BOT"], bot: [] }],
    ["Ev_TOKENS_OTHER_BOT", { oauth: [], bot: ["U_OTHER_BOT"] }],
  ] as const) {
    const unrelated = Buffer.from(JSON.stringify({
      type: "event_callback",
      api_app_id: "A_TEST_APP",
      team_id: "T_TEST",
      event_id: eventId,
      event: { type: "tokens_revoked", tokens },
    }));
    const unrelatedResult = await verifyAndAdmitSlackIngress({
      requestUrl: REQUEST_URL,
      environment: "test",
      rawBody: unrelated,
      ...signedRequest(unrelated),
      ...lifecycleDependencies(),
      now: NOW,
    });
    assert.equal(unrelatedResult.kind, "event");
    if (unrelatedResult.kind !== "event") assert.fail("expected event ACK");
    assert.equal(unrelatedResult.status, "unsupported");
    assert.equal(unrelatedResult.reason, "provider_tokens_unrelated");
    assert.equal((await getDb().select().from(externalAppInstalls).where(eq(
      externalAppInstalls.id,
      fixture.install.id,
    )))[0]?.state, "active");
  }

  const matching = Buffer.from(JSON.stringify({
    type: "event_callback",
    api_app_id: "A_TEST_APP",
    team_id: "T_TEST",
    event_id: "Ev_TOKENS_CURRENT_BOT",
    event: { type: "tokens_revoked", tokens: { oauth: ["U_OTHER"], bot: ["U_BOT"] } },
  }));
  const result = await verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: matching,
    ...signedRequest(matching),
    ...lifecycleDependencies(),
    now: NOW,
  });
  assert.equal(result.kind, "event");
  if (result.kind !== "event") assert.fail("expected event ACK");
  assert.equal(result.status, "revoked");
  assert.equal(result.reason, "provider_tokens_revoked");
  assert.equal((await getDb().select().from(externalAppInstalls).where(eq(
    externalAppInstalls.id,
    fixture.install.id,
  )))[0]?.state, "reauth_required");
  assert.equal((await getDb().select().from(externalAppCredentials).where(eq(
    externalAppCredentials.installId,
    fixture.install.id,
  )))[0]?.state, "revoked");
  assert.equal((await getDb().select().from(externalChannelBindings).where(eq(
    externalChannelBindings.id,
    fixture.binding.id,
  )))[0]?.state, "revoked");
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
});

test("Slack app_uninstalled cannot revoke authority after the ingress endpoint is disabled", async () => {
  const fixture = await seedIngressAuthority();
  const before = await lifecycleAuthorityRows(fixture);
  const wrapped = Buffer.from(JSON.stringify({
    type: "event_callback",
    api_app_id: "A_TEST_APP",
    team_id: "T_TEST",
    event_id: "Ev_APP_UNINSTALLED_STALE_ENDPOINT",
    event: { type: "app_uninstalled" },
  }));
  await assert.rejects(verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: wrapped,
    ...signedRequest(wrapped),
    ...lifecycleDependencies(async () => {
      await getDb().update(externalAppIngressEndpoints).set({
        state: "disabled",
        endpointRevision: 2,
        updatedAt: NOW,
      }).where(eq(externalAppIngressEndpoints.id, fixture.endpoint.id));
    }),
    now: NOW,
  }), (error: unknown) => error instanceof Error
    && "code" in error
    && error.code === "external_ingress_endpoint_unavailable");
  assert.deepEqual(await lifecycleAuthorityRows(fixture), before);
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
});

test("Slack app_uninstalled cannot revoke authority after the app registration is disabled", async () => {
  const fixture = await seedIngressAuthority();
  const before = await lifecycleAuthorityRows(fixture);
  const wrapped = Buffer.from(JSON.stringify({
    type: "event_callback",
    api_app_id: "A_TEST_APP",
    team_id: "T_TEST",
    event_id: "Ev_APP_UNINSTALLED_STALE_REGISTRATION",
    event: { type: "app_uninstalled" },
  }));
  await assert.rejects(verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: wrapped,
    ...signedRequest(wrapped),
    ...lifecycleDependencies(async () => {
      await getDb().update(externalAppRegistrations).set({
        state: "disabled",
        updatedAt: NOW,
      }).where(eq(externalAppRegistrations.id, fixture.registration.id));
    }),
    now: NOW,
  }), (error: unknown) => error instanceof Error
    && "code" in error
    && error.code === "external_ingress_endpoint_unavailable");
  assert.equal((await getDb().select().from(externalAppRegistrations).where(eq(
    externalAppRegistrations.id,
    fixture.registration.id,
  )))[0]?.state, "disabled");
  assert.deepEqual(await lifecycleAuthorityRows(fixture), before);
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
});

test("Slack tokens_revoked cannot revoke authority after signing-secret revision rotation", async () => {
  const fixture = await seedIngressAuthority();
  const before = await lifecycleAuthorityRows(fixture);
  const wrapped = Buffer.from(JSON.stringify({
    type: "event_callback",
    api_app_id: "A_TEST_APP",
    team_id: "T_TEST",
    event_id: "Ev_TOKENS_STALE_SECRET",
    event: { type: "tokens_revoked", tokens: { oauth: [], bot: ["U_BOT"] } },
  }));
  await assert.rejects(verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: wrapped,
    ...signedRequest(wrapped),
    ...lifecycleDependencies(async () => {
      await getDb().update(externalAppRegistrationSecrets).set({
        encryptedSecretRef: "local-ref:signing:v2",
        envelopeKeyId: "envelope-2",
        secretRevision: 2,
        updatedAt: NOW,
      }).where(eq(externalAppRegistrationSecrets.id, fixture.signingSecret.id));
      await getDb().update(externalAppIngressEndpoints).set({
        signingSecretRevision: 2,
        updatedAt: NOW,
      }).where(eq(externalAppIngressEndpoints.id, fixture.endpoint.id));
    }),
    now: NOW,
  }), (error: unknown) => error instanceof Error
    && "code" in error
    && error.code === "external_ingress_endpoint_unavailable");
  assert.deepEqual(await lifecycleAuthorityRows(fixture), before);
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
});

test("signed Slack delivery-rate notices are acknowledged without enqueuing a message", async () => {
  await seedIngressAuthority();
  const body = Buffer.from(JSON.stringify({ type: "app_rate_limited", api_app_id: "A_TEST_APP",
    team_id: "T_TEST", minute_rate_limited: Math.floor(NOW.getTime() / 60_000) }));
  const input = { requestUrl: REQUEST_URL, environment: "test" as const, rawBody: body, ...signedRequest(body),
    secretResolver: { async resolveSigningSecret() { return SIGNING_SECRET; } },
    payloadSealer: { async sealNormalizedPayload(): Promise<never> { throw new Error("rate notices have no payload"); } }, now: NOW };
  await assert.rejects(verifyAndAdmitSlackIngress({ ...input, signatureHeader: "v0=" + "0".repeat(64) }));
  const result = await verifyAndAdmitSlackIngress(input);
  assert.equal(result.kind, "event");
  if (result.kind === "event") { assert.equal(result.status, "unsupported"); assert.equal(result.reason, "app_rate_limited"); }
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
});

test.each(["U_HUMAN", "U_BOT"])("reaction from %s crosses production cipher and database worker authority", async (actorId) => {
  const fixture = await seedIngressAuthority();
  const db = getDb();
  for (const key of [SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync]) {
    assert.ok(await updateFeatureFlag(key, { enabled: true, killSwitch: false }));
    await db.insert(featureFlagRules).values({
      flagKey: key, stage: "server", priority: 999, decision: "allow", values: [fixture.channel.serverId],
    });
  }
  const { createSlackBridgeEnvSecretBackends } = await import("./slackBridgeEnvSecrets");
  const { createSlackDatabaseIngressRuntimeResolver, createSlackDatabaseInboundWorkerRuntimeResolver } =
    await import("./slackBridgeDatabaseRuntimeAuthority");
  const crypto = createSlackBridgeEnvSecretBackends({
    registrationId: fixture.registration.id, environment: "test", providerAppId: "A_TEST_APP",
    providerOAuthClientId: "test-client", signingSecret: SIGNING_SECRET, oauthClientSecret: "test-only",
    credentialEncryptionKey: Buffer.alloc(32, 7), payloadEncryptionKey: Buffer.alloc(32, 9),
  });
  const body = Buffer.from(JSON.stringify({
    type: "event_callback", api_app_id: "A_TEST_APP", team_id: "T_TEST", event_id: `Ev_REAL_CRYPTO_${actorId}`,
    event: { type: "reaction_added", user: actorId, reaction: "+1",
      item: { type: "message", channel: "C_TEST", ts: "1785931200.000300" }, event_ts: "1785931201.000301" },
  }));
  const admitted = await verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL, environment: "test", rawBody: body, ...signedRequest(body),
    secretResolver: { async resolveSigningSecret() { return SIGNING_SECRET; } },
    payloadSealer: crypto.payloadSealer, runtimeResolver: createSlackDatabaseIngressRuntimeResolver(db), now: NOW,
  });
  assert.equal(admitted.kind, "event");
  const [event] = await db.select().from(externalInboundEvents);
  assert.ok(event);
  const frozen = {
    runtimeRevision: event.runtimeRevision, provider: event.provider, environment: event.environment,
    appRegistrationId: event.appRegistrationId, installId: event.installId, workspaceId: event.workspaceId,
    providerAuthorityId: event.providerAuthorityId, providerConversationId: event.providerConversationId,
    bindingId: event.bindingId, bindingEpoch: event.bindingEpoch, connectionEpoch: event.connectionEpoch,
    raftChannelId: event.raftChannelId, privacyClass: event.privacyClass,
  };
  const workerAuthority = await createSlackDatabaseInboundWorkerRuntimeResolver(db, () => NOW)({
    eventId: event.id, frozenAuthority: frozen, requiredCapabilities: ["reaction_sync"],
  });
  assert.deepEqual(workerAuthority, frozen, "admitted bot echoes must be consumable by the production worker");
  const plaintext = await crypto.decryptNormalizedPayload({
    eventId: event.id, ciphertext: event.encryptedPayload!, envelopeKeyId: event.envelopeKeyId!,
    aad: { ...frozen, purpose: "external-inbound-normalized-event", aadVersion: 1, schemaVersion: 3,
      providerEventId: event.providerEventId },
  });
  assert.equal(JSON.parse(plaintext).externalActorId, actorId);
  assert.equal((await db.select().from(externalActorProjections)).length, 1, "bot echo creates no human identity");
});

test.each([{
  label: "reaction",
  capabilityFlag: SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync,
  event: {
    type: "reaction_added",
    user: "U_HUMAN",
    reaction: "eyes",
    item: { type: "message", channel: "C_TEST", ts: "1785931200.000300" },
    event_ts: "1785931201.000301",
  },
}, {
  label: "attachment",
  capabilityFlag: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
  event: {
    type: "message",
    subtype: "file_share",
    channel: "C_TEST",
    user: "U_HUMAN",
    text: "must not be sealed",
    ts: "1785931200.000302",
    files: [{ id: "F_PRIVACY_STALE" }],
  },
}] as const)("expired privacy cache still admits $label (directory TTL degrades, not blocks)", async (sample) => {
  const fixture = await seedIngressAuthority();
  const db = getDb();
  for (const key of [SLACK_BRIDGE_FEATURE_FLAG_KEYS.master]) {
    await db.insert(featureFlags).values({
      key,
      description: `test ${key}`,
      enabled: true,
      defaultEnabled: false,
      killSwitch: false,
      randomizationUnit: "server",
      salt: key,
    }).onConflictDoUpdate({
      target: featureFlags.key,
      set: { enabled: true, killSwitch: false },
    });
    await db.insert(featureFlagRules).values({
      flagKey: key,
      stage: "server",
      priority: 999,
      decision: "allow",
      values: [fixture.channel.serverId],
    });
  }
  await db.update(externalChannelBindings).set({ privacyFreshUntil: NOW })
    .where(eq(externalChannelBindings.id, fixture.binding.id));
  const { createSlackDatabaseIngressRuntimeResolver } =
    await import("./slackBridgeDatabaseRuntimeAuthority");
  const body = Buffer.from(JSON.stringify({
    type: "event_callback",
    api_app_id: "A_TEST_APP",
    team_id: "T_TEST",
    event_id: `Ev_PRIVACY_STALE_${sample.label.toUpperCase()}`,
    event: sample.event,
  }));
  let sealCalls = 0;
  // Privacy freshness is directory metadata: an expired cache degrades to
  // the recorded class; it must not reject admission (task #241).
  await verifyAndAdmitSlackIngress({
    requestUrl: REQUEST_URL,
    environment: "test",
    rawBody: body,
    ...signedRequest(body),
    secretResolver: { async resolveSigningSecret() { return SIGNING_SECRET; } },
    payloadSealer: {
      async sealNormalizedPayload() {
        sealCalls += 1;
        return { encryptedPayload: "sealed:privacy-stale", envelopeKeyId: "payload-key-1", aadVersion: 1 };
      },
    },
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(db),
    now: NOW,
  });
  assert.equal(sealCalls, 1, "admission reaches payload sealing");
  assert.equal((await db.select().from(externalInboundEvents)).length, 1);
  const [binding] = await db.select().from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, fixture.binding.id));
  assert.equal(binding.state, "active");
  assert.equal(binding.privacyFreshUntil.getTime(), NOW.getTime());
});

for (const privacyClass of ["public", "private"] as const) {
  test(`Slack edit admission uses nested message identity and exact edit time (${privacyClass})`, async () => {
    await seedIngressAuthority(privacyClass);
    const body = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: "A_TEST_APP", team_id: "T_TEST", event_id: "Ev_EDIT",
      event: { type: "message", subtype: "message_changed", channel: "C_TEST", ts: "1785931230.999999",
        message: { type: "message", user: "U_HUMAN", text: "changed text", ts: "1785931200.000001",
          thread_ts: "1785931200.000001", edited: { user: "U_HUMAN", ts: "1785931230.000002" } } } }));
    let plaintext = "";
    const result = await verifyAndAdmitSlackIngress({ requestUrl: REQUEST_URL, environment: "test", rawBody: body, ...signedRequest(body),
      secretResolver: { async resolveSigningSecret() { return SIGNING_SECRET; } },
      payloadSealer: { async sealNormalizedPayload(input) {
        plaintext = input.plaintext;
        assert.equal(input.aad.schemaVersion, 4);
        return { encryptedPayload: "sealed-edit", envelopeKeyId: "test-key", aadVersion: 1 };
      } },
      runtimeResolver: { async resolveCurrentRuntime() { return { runtimeRevision: "runtime-edit" }; } }, now: NOW });
    assert.equal(result.kind, "event");
    const parsed = JSON.parse(plaintext);
    assert.equal(parsed.providerMessageId, "1785931200.000001");
    assert.equal(parsed.providerThreadId, null);
    assert.equal(parsed.providerEditedTs, "1785931230.000002");
    assert.equal(parsed.content, "changed text");
    const [event] = await getDb().select().from(externalInboundEvents);
    assert.equal(event.payloadSchemaVersion, 4);
  });
}

test("Slack edited bot messages are loop-suppressed using the nested author", async () => {
  await seedIngressAuthority();
  const body = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: "A_TEST_APP", team_id: "T_TEST", event_id: "Ev_BOT_EDIT",
    event: { type: "message", subtype: "message_changed", channel: "C_TEST", event_ts: "1785931230.000001",
      message: { user: "U_BOT", bot_id: "B_BOT", text: "bridge echo", ts: "1785931200.000001" } } }));
  const result = await verifyAndAdmitSlackIngress({ requestUrl: REQUEST_URL, environment: "test", rawBody: body, ...signedRequest(body),
    secretResolver: { async resolveSigningSecret() { return SIGNING_SECRET; } },
    payloadSealer: { async sealNormalizedPayload() { assert.fail("echo must not enter custody"); } }, now: NOW });
  assert.equal(result.kind, "event");
  if (result.kind === "event") assert.equal(result.reason, "provider_loop_suppressed");
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
});

test.each([undefined, { user: "U_HUMAN", ts: "not-a-timestamp", text: "bad" }])("malformed Slack edit cannot enqueue or seal payload: %j", async (message) => {
  await seedIngressAuthority();
  const body = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: "A_TEST_APP", team_id: "T_TEST", event_id: "Ev_BAD_EDIT",
    event: { type: "message", subtype: "message_changed", channel: "C_TEST", event_ts: "1785931230.000001", message } }));
  await assert.rejects(verifyAndAdmitSlackIngress({ requestUrl: REQUEST_URL, environment: "test", rawBody: body, ...signedRequest(body),
    secretResolver: { async resolveSigningSecret() { return SIGNING_SECRET; } },
    payloadSealer: { async sealNormalizedPayload() { assert.fail("invalid edit must not enter custody"); } }, now: NOW }),
    (error: unknown) => error instanceof ExternalAppIngressError && error.code === "external_ingress_payload_invalid");
  assert.equal((await getDb().select().from(externalInboundEvents)).length, 0);
});


test("signed deletion records removed history despite stale visibility without reenabling its pair", async () => {
  const fixture = await seedIngressAuthority("public");
  await getDb().update(externalChannelBindings).set({ state: "revoked", stateReason: "provisioning_pair_removed" })
    .where(eq(externalChannelBindings.id, fixture.binding.id));
  await getDb().update(externalAppInstalls).set({ state: "revoked", stateReason: "provisioning_unbound",
    connectionEpoch: fixture.install.connectionEpoch + 1 }).where(eq(externalAppInstalls.id, fixture.install.id));
  const body = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: "A_TEST_APP",
    team_id: "T_TEST", event_id: "E".repeat(320), event: { type: "group_deleted", channel: "C_TEST" } }));
  const input = { requestUrl: REQUEST_URL, environment: "test" as const, rawBody: body,
    ...signedRequest(body), ...lifecycleDependencies(), now: NOW };
  await assert.rejects(verifyAndAdmitSlackIngress({ ...input, signatureHeader: "v0=" + "0".repeat(64) }));
  assert.deepEqual(await getDb().select().from(slackChannelDeletions), []);
  const first = await verifyAndAdmitSlackIngress(input);
  const retry = await verifyAndAdmitSlackIngress(input);
  assert.equal(first.kind === "event" ? first.status : null, "unsupported");
  assert.equal(retry.kind === "event" ? retry.duplicate : null, true);
  const facts = await getDb().select().from(slackChannelDeletions);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.sourceKind, "signed_event");
  assert.equal(facts[0]!.providerAuthorityId, "T_TEST");
  assert.equal(facts[0]!.providerConversationId, "C_TEST");
  assert.equal((await getDb().select().from(externalChannelBindings))[0]!.state, "revoked");
  const receipts = await getDb().select().from(externalIngressDiscardReceipts);
  assert.ok(receipts.length > 0);
  assert.ok(receipts.every((receipt) => receipt.outcomeReason === "unsupported_event"
    && receipt.providerEventId === facts[0]!.providerEventId && receipt.providerConversationId === facts[0]!.providerConversationId));
  assert.deepEqual(await getDb().select().from(externalInboundEvents), []);
});

test("a signed deletion with no matching channel history does not mint a fact", async () => {
  await seedIngressAuthority("public");
  const body = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: "A_TEST_APP",
    team_id: "T_TEST", event_id: "Ev_DELETE_UNSEEN", event: { type: "channel_deleted", channel: "C_NEVER_BOUND" } }));
  await assert.rejects(verifyAndAdmitSlackIngress({ requestUrl: REQUEST_URL, environment: "test", rawBody: body,
    ...signedRequest(body), ...lifecycleDependencies(), now: NOW }),
    (error: unknown) => error instanceof ExternalAppIngressError && error.code === "external_ingress_authority_unavailable");
  assert.deepEqual(await getDb().select().from(slackChannelDeletions), []);
});


const lifecycleSecond = Math.floor(NOW.getTime() / 1000);
async function signedMetadata(event: Record<string, unknown>, suffix = "000100", requestLifecycleRefresh?: (bindingId: string) => void,
  readLifecycleMemberProfile?: Parameters<typeof verifyAndAdmitSlackIngress>[0]["readLifecycleMemberProfile"]) {
  const body = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: "A_TEST_APP", team_id: "T_TEST",
    event_id: `Ev_meta_${randomUUID()}`, event: { event_ts: `${lifecycleSecond}.${suffix}`, ...event } }));
  return verifyAndAdmitSlackIngress({ requestUrl: REQUEST_URL, environment: "test", rawBody: body,
    ...signedRequest(body), ...lifecycleDependencies(), requestLifecycleRefresh, readLifecycleMemberProfile, now: NOW });
}

test("unarchive is not an Events API recovery witness and a late archive cannot reverse positive verification", async () => {
  const fixture = await seedIngressAuthority();
  await signedMetadata({ type: "channel_archive", channel: "C_TEST" });
  const ignored = await signedMetadata({ type: "channel_unarchive", channel: "C_TEST" }, "000102");
  assert.equal(ignored.kind === "event" ? ignored.status : null, "unsupported");
  assert.equal((await getDb().select().from(externalChannelBindings))[0]!.state, "paused");
  const [paused] = await getDb().select().from(externalChannelBindings);
  await reconcileSlackChannelLifecycle({ serverId: paused.serverId, registrationId: paused.registrationId,
    installId: paused.installId, bindingId: paused.id, providerAuthorityId: "T_TEST", providerConversationId: "C_TEST",
    expectedConnectionEpoch: paused.connectionEpoch, expectedBindingEpoch: paused.bindingEpoch,
    event: { kind: "available", name: "current-name" }, now: new Date(NOW.getTime() + 1000) });
  const [restored] = await getDb().select().from(externalChannelBindings);
  assert.equal(restored.state, "active"); assert.equal(restored.stateReason, null);
  assert.equal(restored.bindingEpoch, fixture.binding.bindingEpoch + 2);
  await signedMetadata({ type: "channel_archive", channel: "C_TEST" }, "000101");
  assert.deepEqual((await getDb().select().from(externalChannelBindings))[0], restored);
});

test.each(["public", "private"] as const)("member join projects an address immediately for a following %s message", async privacy => {
  const fixture = await seedIngressAuthority(privacy);
  const refresh: string[] = [];
  await signedMetadata({ type: "member_joined_channel", channel: "C_TEST", user: "U_NEW_MEMBER" }, "000100", id => refresh.push(id),
    async (bindingId, userId) => { assert.equal(bindingId, fixture.binding.id); assert.equal(userId, "U_NEW_MEMBER");
      return { id: userId, displayName: "New member profile", handle: "new-member", actorKind: "human" }; });
  const [projection] = await getDb().select().from(externalActorProjections).where(eq(externalActorProjections.externalActorId, "U_NEW_MEMBER"));
  assert.equal(projection.displayName, "New member profile"); assert.equal(projection.actorKind, "human");
  const [address] = await getDb().select().from(externalAddressabilityProjections).where(eq(externalAddressabilityProjections.projectionId, projection.id));
  assert.equal(address.state, "active"); assert.equal(address.bindingId, fixture.binding.id);
  assert.deepEqual(refresh, [], "targeted users.info must not rely on the workspace refresh claim");
  const body = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: "A_TEST_APP", team_id: "T_TEST", event_id: "Ev_new_member_body",
    event: { type: "message", channel: "C_TEST", user: "U_NEW_MEMBER", text: "first message before directory refresh", ts: `${lifecycleSecond}.000200` } }));
  const result = await verifyAndAdmitSlackIngress({ requestUrl: REQUEST_URL, environment: "test", rawBody: body,
    ...signedRequest(body), secretResolver: lifecycleDependencies().secretResolver,
    payloadSealer: { async sealNormalizedPayload() { return { encryptedPayload: "sealed:member", envelopeKeyId: "key", aadVersion: 1 }; } },
    runtimeResolver: { async resolveCurrentRuntime(input) { assert.equal(input.projectionId, projection.id); return { runtimeRevision: "member-current" }; } }, now: NOW });
  assert.equal(result.kind === "event" ? result.status : null, "queued");
});

test("bot rejoin requests verification without resuming or reviving a manual pause", async () => {
  const fixture = await seedIngressAuthority();
  await signedMetadata({ type: "member_left_channel", channel: "C_TEST", user: fixture.install.botUserId });
  const [paused] = await getDb().select().from(externalChannelBindings);
  assert.equal(paused.stateReason, "provider_bot_removed");
  assert.equal((await getDb().select().from(slackChannelDeletions)).length, 0);
  await signedMetadata({ type: "member_joined_channel", channel: "C_TEST", user: fixture.install.botUserId }, "000102");
  const [active] = await getDb().select().from(externalChannelBindings);
  assert.equal(active.state, "paused");
  assert.equal(active.stateReason, "provider_bot_removed");
  await signedMetadata({ type: "member_left_channel", channel: "C_TEST", user: fixture.install.botUserId }, "000101");
  assert.deepEqual((await getDb().select().from(externalChannelBindings))[0], active);
  await getDb().update(externalChannelBindings).set({ state: "paused", stateReason: "manager_paused" });
  await signedMetadata({ type: "channel_unarchive", channel: "C_TEST" }, "000103");
  assert.equal((await getDb().select().from(externalChannelBindings))[0]!.stateReason, "manager_paused");
});

test("rename updates the display fallback without moving a pair or its authority", async () => {
  const fixture = await seedIngressAuthority("private");
  await signedMetadata({ type: "group_rename", channel: { id: "C_TEST", name: "current-name" } }, "000102");
  await signedMetadata({ type: "group_rename", channel: { id: "C_TEST", name: "old-name" } }, "000101");
  const [binding] = await getDb().select().from(externalChannelBindings);
  assert.equal(binding.slackLifecycleObservation?.name?.value, "current-name");
  assert.equal(binding.bindingEpoch, fixture.binding.bindingEpoch);
  assert.equal(binding.channelId, fixture.channel.id); assert.equal(binding.providerConversationId, "C_TEST");
  assert.equal(projectSlackProviderChannelsForServer({ observed: [], currentBindings: [binding], reservedByOtherServer: new Set() })[0]!.name, "current-name");
  assert.equal((await getDb().select().from(channels).where(eq(channels.id, fixture.channel.id)))[0]!.name, fixture.channel.name);
});

test("nonactive installation retains archive and deletion facts without allowing unarchive to reconnect", async () => {
  await seedIngressAuthority();
  await getDb().update(externalAppInstalls).set({ state: "reauth_required", stateReason: "provider_tokens_revoked" });
  await signedMetadata({ type: "channel_archive", channel: "C_TEST" });
  assert.equal((await getDb().select().from(externalChannelBindings))[0]!.slackLifecycleObservation?.archive?.archived, true);
  await signedMetadata({ type: "channel_unarchive", channel: "C_TEST" }, "000102");
  assert.equal((await getDb().select().from(externalChannelBindings))[0]!.state, "paused");
  await signedMetadata({ type: "channel_deleted", channel: "C_TEST" }, "000103");
  assert.equal((await getDb().select().from(slackChannelDeletions)).filter(fact => fact.sourceKind === "signed_event").length, 1);
  assert.equal((await getDb().select().from(externalAppInstalls))[0]!.state, "reauth_required");
});

test("a signed message on an archived pair requests verification but cannot prove recovery", async () => {
  const fixture = await seedIngressAuthority();
  await signedMetadata({ type: "channel_archive", channel: "C_TEST" });
  const body = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: "A_TEST_APP", team_id: "T_TEST", event_id: "Ev_paused_body",
    event: { type: "message", channel: "C_TEST", user: "U_HUMAN", text: "trigger only", ts: `${lifecycleSecond}.000200` } }));
  const refresh: string[] = [];
  const request = { requestUrl: REQUEST_URL, environment: "test" as const, rawBody: body, ...signedRequest(body), ...lifecycleDependencies(),
    runtimeResolver: { async resolveCurrentRuntime() { assert.fail("paused pair cannot admit a message"); } },
    requestLifecycleRefresh: (id: string) => refresh.push(id), now: NOW };
  await assert.rejects(verifyAndAdmitSlackIngress(request), (error: unknown) => error instanceof ExternalAppIngressError && error.code === "external_ingress_authority_unavailable");
  assert.deepEqual(refresh, [fixture.binding.id]);
  assert.equal((await getDb().select().from(externalChannelBindings))[0]!.stateReason, "provider_channel_archived");
  await assert.rejects(verifyAndAdmitSlackIngress({ ...request, signatureHeader: `v0=${"0".repeat(64)}` }));
  assert.deepEqual(refresh, [fixture.binding.id], "unverified input cannot request provider reads");
  await signedMetadata({ type: "member_joined_channel", channel: "C_TEST", user: "U_JOINED_WHILE_PAUSED" }, "000300", id => refresh.push(id));
  assert.deepEqual(refresh, [fixture.binding.id, fixture.binding.id], "a joined member also requests proof before resuming");
  assert.equal((await getDb().select().from(externalActorProjections).where(eq(externalActorProjections.externalActorId, "U_JOINED_WHILE_PAUSED"))).length, 0,
    "a hint alone cannot grant addressability through a paused pair");
});

test("targeted recovery requires positive current conversation state and preserves failures", async () => {
  const fixture = await seedIngressAuthority();
  await updateFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, { enabled: true, killSwitch: false });
  await getDb().insert(featureFlagRules).values({ flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, stage: "server", priority: 999,
    decision: "allow", values: [fixture.binding.serverId] });
  await signedMetadata({ type: "channel_archive", channel: "C_TEST" });
  let state: "unknown" | "archived" | "not_member" | "available" | "racing" = "unknown";
  let calls = 0;
  const provider: SlackBridgeProvisioningProvider = {
    async readInstallGrant() { assert.fail("only conversations.info is needed"); },
    async readWorkspace() { assert.fail("must not scan the whole workspace directory"); },
    async readConversationAudience() { assert.fail("membership refresh follows recovery separately"); },
    async readConversationState(input) {
      calls++; assert.equal(input.providerConversationId, "C_TEST");
      if (state === "unknown") return { kind: "unverified" };
      if (state === "racing") await getDb().update(externalChannelBindings).set({ state: "paused", stateReason: "manager_paused", bindingEpoch: 20 });
      return { kind: "fact", fact: { id: "C_TEST", name: "restored-name", isArchived: state === "archived", isMember: state !== "not_member" } };
    },
  };
  let recoveryClock = NOW.getTime() + 1000;
  const recover = () => { recoveryClock += 31_000; return recoverSlackLifecyclePauses({ db: getDb(), provider,
    bindingId: fixture.binding.id, now: new Date(recoveryClock) }); };
  for (const next of ["unknown", "archived", "not_member"] as const) {
    state = next; await recover(); assert.equal((await getDb().select().from(externalChannelBindings))[0]!.state, "paused");
  }
  await updateFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, { killSwitch: true });
  state = "available"; await recover(); assert.equal(calls, 3, "master-off must not read Slack");
  await updateFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, { killSwitch: false });
  await getDb().update(externalAppRegistrations).set({ state: "disabled" });
  await recover(); assert.equal(calls, 3, "disabled registration must not read Slack");
  await getDb().update(externalAppRegistrations).set({ state: "active" });
  await recover(); assert.equal((await getDb().select().from(externalChannelBindings))[0]!.state, "active");
  await getDb().update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_archived" });
  state = "racing"; await recover();
  assert.equal((await getDb().select().from(externalChannelBindings))[0]!.stateReason, "manager_paused", "stale read cannot reopen a changed pair");
});


test("signing endpoint changes roll back lifecycle metadata and its receipt together", async () => {
  const fixture = await seedIngressAuthority();
  const body = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: "A_TEST_APP", team_id: "T_TEST", event_id: "Ev_revoked_signer",
    event: { type: "member_joined_channel", channel: "C_TEST", user: "U_REVOKED_SOURCE", event_ts: `${lifecycleSecond}.000100` } }));
  await assert.rejects(verifyAndAdmitSlackIngress({ requestUrl: REQUEST_URL, environment: "test", rawBody: body, ...signedRequest(body),
    ...lifecycleDependencies(async () => { await getDb().update(externalAppIngressEndpoints).set({ endpointRevision: 2 }); }), now: NOW }));
  assert.equal((await getDb().select().from(externalActorProjections).where(eq(externalActorProjections.externalActorId, "U_REVOKED_SOURCE"))).length, 0);
  assert.equal((await getDb().select().from(externalIngressDiscardReceipts)).length, 0);
  assert.equal((await getDb().select().from(externalChannelBindings))[0]!.bindingEpoch, fixture.binding.bindingEpoch);
});

test("the production lifecycle reader uses one authenticated conversations.info and rejects incomplete state", async () => {
  const fixture = await seedIngressAuthority();
  const { createSlackBridgeEnvCredentialCipher } = await import("./slackBridgeEnvSecrets");
  const { createSlackBridgeProviderRuntime } = await import("./slackBridgeProviderRuntime");
  const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 44) });
  const sealed = await cipher.sealer.seal({ serverId: fixture.binding.serverId, accessToken: "synthetic-state-token", tokenType: "bot",
    providerAppId: fixture.install.providerAppId, providerTeamId: fixture.install.providerTeamId!, botUserId: fixture.install.botUserId!, now: NOW });
  await getDb().update(externalAppCredentials).set({ encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion });
  let channel: Record<string, unknown> = { id: "C_TEST", name: "current-name", is_archived: false, is_member: true };
  let user: Record<string, unknown> = { id: "U_JOIN", name: "joined", is_bot: false, profile: { display_name: "Joined member" } };
  let calls = 0;
  const provider = createSlackBridgeProviderRuntime({ db: getDb(), credentialCipher: cipher, now: () => NOW,
    fetch: (async (url, init) => { calls++; const parsed = new URL(String(url));
      assert.equal(init?.method, "GET");
      if (parsed.pathname.endsWith("users.info")) {
        assert.equal(parsed.searchParams.get("user"), "U_JOIN");
        return new Response(JSON.stringify({ ok: true, user }), { status: 200 });
      }
      assert.equal(parsed.pathname.split("/").at(-1), "conversations.info");
      assert.equal(parsed.searchParams.get("channel"), "C_TEST");
      return new Response(JSON.stringify({ ok: true, channel }), { status: 200 }); }) as typeof fetch });
  const read = () => provider.provisioningProvider.readConversationState!({ installId: fixture.install.id,
    providerAppId: fixture.install.providerAppId, providerAuthorityId: fixture.install.providerAuthorityId, botUserId: fixture.install.botUserId!,
    connectionEpoch: fixture.install.connectionEpoch, credentialRevision: fixture.install.credentialRevision, providerConversationId: "C_TEST", now: NOW });
  try {
    assert.equal((await read()).kind, "fact");
    channel = { id: "C_OTHER", name: "wrong", is_archived: false, is_member: true }; assert.equal((await read()).kind, "unverified");
    channel = { id: "C_TEST", name: "partial", is_member: true }; assert.equal((await read()).kind, "unverified");
    assert.equal(calls, 3);
    const profile = () => provider.provisioningProvider.readUserProfile!({ installId: fixture.install.id,
      providerAppId: fixture.install.providerAppId, providerAuthorityId: fixture.install.providerAuthorityId,
      botUserId: fixture.install.botUserId!, connectionEpoch: fixture.install.connectionEpoch,
      credentialRevision: fixture.install.credentialRevision, providerUserId: "U_JOIN", now: NOW });
    const verified = await profile();
    assert.equal(verified.kind === "fact" ? verified.fact.displayName : null, "Joined member");
    for (const bad of [{ id: "U_JOIN", is_bot: false }, { id: "U_OTHER", name: "other", is_bot: false },
      { id: "U_JOIN", name: "deleted", is_bot: false, deleted: true }]) {
      user = bad; assert.equal((await profile()).kind, "unverified", "partial, wrong or deleted profiles cannot freeze a human author");
    }
    await signedMetadata({ type: "channel_archive", channel: "C_TEST" });
    await updateFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, { enabled: true, killSwitch: false });
    await getDb().insert(featureFlagRules).values({ flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
      stage: "server", priority: 999, decision: "allow", values: [fixture.binding.serverId] });
    channel = { id: "C_TEST", name: "restored-name", is_archived: false, is_member: true };
    const { createSlackBridgeProductionLifecycle } = await import("./slackBridgeProductionLifecycle");
    const lifecycle = createSlackBridgeProductionLifecycle({ db: getDb(), provider, now: () => new Date(NOW.getTime() + 1000) });
    try {
      await Promise.all([lifecycle.requestConversationReconcile(fixture.binding.id), lifecycle.requestConversationReconcile(fixture.binding.id)]);
      assert.equal(calls, 8, "concurrent hints for one pair coalesce into one conversations.info read");
      assert.equal((await getDb().select().from(externalChannelBindings))[0]!.state, "active");
    } finally { lifecycle.stop(); }
  } finally { await provider.stop(); }
});

async function allowLifecycleRecovery(serverId: string) {
  await updateFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, { enabled: true, killSwitch: false });
  await getDb().insert(featureFlagRules).values({ flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    stage: "server", priority: 999, decision: "allow", values: [serverId] });
}

function recoveryProvider(readConversationState: NonNullable<SlackBridgeProvisioningProvider["readConversationState"]>): SlackBridgeProvisioningProvider {
  return { readConversationState,
    async readInstallGrant() { assert.fail("recovery cannot refresh OAuth"); },
    async readWorkspace() { assert.fail("recovery cannot scan the workspace"); },
    async readConversationAudience() { assert.fail("audience refresh is a separate maintenance phase"); } };
}

async function completeRecoveryGrant(fixture: Awaited<ReturnType<typeof seedIngressAuthority>>) {
  const scopes = [...SLACK_BRIDGE_CORE_BOT_SCOPES];
  await getDb().update(externalAppInstalls).set({ installedScopes: scopes }).where(eq(externalAppInstalls.id, fixture.install.id));
  await getDb().update(externalAppInstallGrantReceipts).set({ grantedScopes: scopes,
    grantHash: slackBridgeInstallGrantHash({ providerAppId: fixture.install.providerAppId,
      providerAuthorityId: fixture.install.providerAuthorityId, botUserId: fixture.install.botUserId!,
      providerBotId: fixture.install.providerBotId!, grantedScopes: scopes })
  }).where(eq(externalAppInstallGrantReceipts.installId, fixture.install.id));
}

test("only complete audience evidence that the bot is missing pauses an active pair", async () => {
  const fixture = await seedIngressAuthority("public");
  await completeRecoveryGrant(fixture);
  let mode: "failed" | "incomplete" | "missing" = "failed";
  const provider = recoveryProvider(async () => ({ kind: "unverified" }));
  provider.readConversationAudience = async () => mode === "failed" ? { kind: "unverified" }
    : { kind: "fact", fact: { providerMemberIds: ["U_HUMAN"], users: mode === "incomplete" ? []
      : [{ id: "U_HUMAN", displayName: "External Human", handle: "external-human", actorKind: "human" }] } };
  for (const value of ["failed", "incomplete"] as const) {
    mode = value;
    await refreshSlackConversationAuthority({ db: getDb(), provider, bindingId: fixture.binding.id, now: NOW });
    assert.equal((await getDb().select().from(externalChannelBindings))[0]!.state, "active");
  }
  mode = "missing";
  const missingReceipt = await refreshSlackConversationAuthority({ db: getDb(), provider, bindingId: fixture.binding.id, now: NOW });
  const [paused] = await getDb().select().from(externalChannelBindings);
  assert.equal(paused.state, "paused", JSON.stringify(missingReceipt)); assert.equal(paused.stateReason, "provider_bot_removed");
  assert.equal(paused.bindingEpoch, fixture.binding.bindingEpoch + 1);
});

test("bot recovery needs a fresh complete audience and rejects an event racing the read", async () => {
  const fixture = await seedIngressAuthority("public");
  await completeRecoveryGrant(fixture);
  await allowLifecycleRecovery(fixture.binding.serverId);
  await signedMetadata({ type: "member_left_channel", channel: "C_TEST", user: fixture.install.botUserId });
  let mode: "unavailable" | "race" | "matched" = "unavailable";
  const provider = recoveryProvider(async () => ({ kind: "fact", fact: { id: "C_TEST", name: "current",
    isArchived: false, isMember: true } }));
  provider.readConversationAudience = async () => {
    if (mode === "unavailable") return { kind: "unverified" };
    if (mode === "race") await signedMetadata({ type: "member_joined_channel", channel: "C_TEST", user: "U_OTHER" }, "000500");
    return { kind: "fact", fact: { providerMemberIds: ["U_BOT", "U_HUMAN"],
      users: [{ id: "U_HUMAN", displayName: "External Human", handle: "external-human", actorKind: "human" }] } };
  };
  let clock = NOW.getTime();
  const errors: unknown[] = [];
  const recover = () => { clock += 31_000; return recoverSlackLifecyclePauses({ db: getDb(), provider,
    bindingId: fixture.binding.id, now: new Date(clock), clock: () => new Date(clock), onError: (error) => errors.push(error) }); };
  await recover(); assert.equal((await getDb().select().from(externalChannelBindings))[0]!.stateReason, "provider_bot_removed");
  mode = "race"; await recover(); assert.equal((await getDb().select().from(externalChannelBindings))[0]!.stateReason, "provider_bot_removed");
  mode = "matched"; await recover();
  const [restored] = await getDb().select().from(externalChannelBindings);
  assert.equal(restored.state, "active", JSON.stringify(errors)); assert.equal(restored.stateReason, null);
});

test("channel-left hints request recheck without asserting bot removal", async () => {
  const fixture = await seedIngressAuthority("public");
  const requested: string[] = [];
  for (const type of ["channel_left", "group_left"]) {
    await signedMetadata({ type, channel: "C_TEST" }, type === "channel_left" ? "000200" : "000300", (id) => requested.push(id));
  }
  assert.deepEqual(requested, [fixture.binding.id, fixture.binding.id]);
  assert.equal((await getDb().select().from(externalChannelBindings))[0]!.state, "active");
});

test("periodic recovery caps reads, continues after a failed pair and gives remaining pairs their turn", async () => {
  const fixture = await seedIngressAuthority("public");
  await allowLifecycleRecovery(fixture.binding.serverId);
  await signedMetadata({ type: "channel_archive", channel: "C_TEST" });
  for (let index = 0; index < 12; index++) {
    const [channel] = await getDb().insert(channels).values({ serverId: fixture.binding.serverId, name: `recovery-${index}`, type: "channel" }).returning();
    await getDb().insert(externalChannelBindings).values({ ...fixture.binding, id: randomUUID(), channelId: channel!.id,
      providerConversationId: `C_RECOVER_${index}`, state: "paused", stateReason: "provider_channel_archived" });
  }
  const seen = new Set<string>(); let calls = 0; const errors: unknown[] = [];
  const provider = recoveryProvider(async input => {
    calls++; seen.add(input.providerConversationId);
    if (calls === 1) throw new Error("synthetic failed pair");
    return { kind: "unverified" };
  });
  const recover = () => recoverSlackLifecyclePauses({ db: getDb(), provider, now: new Date(NOW.getTime() + 1000), onError: error => errors.push(error) });
  await recover(); assert.equal(calls, 10); assert.equal(errors.length, 1);
  await recover(); assert.equal(calls, 13); assert.equal(seen.size, 13, "reserved pairs must move behind the remaining due pairs");
  await recover(); assert.equal(calls, 13, "a new pass cannot bypass persisted backoff");
});

test("provider Retry-After survives a fresh recovery instance and fences other pairs in the same install", async () => {
  const fixture = await seedIngressAuthority("public");
  await allowLifecycleRecovery(fixture.binding.serverId);
  await signedMetadata({ type: "channel_archive", channel: "C_TEST" });
  let calls = 0; let clock = new Date(NOW.getTime() + 1000);
  const provider = recoveryProvider(async () => { calls++; return { kind: "unverified", retryAfterMs: 10 * 60_000 }; });
  await recoverSlackLifecyclePauses({ db: getDb(), provider, now: clock });
  assert.equal(calls, 1);
  const [install] = await getDb().select().from(externalAppInstalls);
  assert.equal(install.slackLifecycleRetryNotBefore?.getTime(), clock.getTime() + 10 * 60_000);
  clock = new Date(clock.getTime() + 31_000);
  await recoverSlackLifecyclePauses({ db: getDb(), provider: recoveryProvider(async () => { assert.fail("a second instance must obey install Retry-After"); }),
    bindingId: fixture.binding.id, now: clock });
  clock = new Date(NOW.getTime() + 11 * 60_000);
  await recoverSlackLifecyclePauses({ db: getDb(), provider: recoveryProvider(async () => { calls++; return { kind: "unverified" }; }), now: clock });
  assert.equal(calls, 2);
});

test("audience Retry-After also defers recovery for the installation", async () => {
  const fixture = await seedIngressAuthority("public");
  await completeRecoveryGrant(fixture); await allowLifecycleRecovery(fixture.binding.serverId);
  await signedMetadata({ type: "member_left_channel", channel: "C_TEST", user: fixture.install.botUserId });
  let stateReads = 0;
  const provider = recoveryProvider(async () => { stateReads++; return { kind: "fact", fact: {
    id: "C_TEST", name: "current", isArchived: false, isMember: true,
  } }; });
  provider.readConversationAudience = async () => ({ kind: "unverified", retryAfterMs: 10 * 60_000 });
  let clock = new Date(NOW.getTime() + 1000);
  await recoverSlackLifecyclePauses({ db: getDb(), provider, bindingId: fixture.binding.id, now: clock });
  const [install] = await getDb().select().from(externalAppInstalls);
  assert.equal(install.slackLifecycleRetryNotBefore?.getTime(), clock.getTime() + 10 * 60_000);
  assert.equal((await getDb().select().from(externalChannelBindings))[0]!.stateReason, "provider_bot_removed");
  clock = new Date(clock.getTime() + 31_000);
  await recoverSlackLifecyclePauses({ db: getDb(), provider, bindingId: fixture.binding.id, now: clock });
  assert.equal(stateReads, 1, "a fresh worker must respect the audience limit");
});

test("a successful active-pair hint resets backoff without removing the hint throttle", async () => {
  const fixture = await seedIngressAuthority("public");
  await completeRecoveryGrant(fixture); await allowLifecycleRecovery(fixture.binding.serverId);
  await getDb().update(externalChannelBindings).set({ slackLifecycleObservation: { recovery: { attempt: 10,
    lastCheckedAt: new Date(NOW.getTime() - 60_000).toISOString(), nextCheckAt: new Date(NOW.getTime() + 21_600_000).toISOString() } } })
    .where(eq(externalChannelBindings.id, fixture.binding.id));
  let stateReads = 0;
  const provider = recoveryProvider(async () => { stateReads++; return { kind: "fact", fact: {
    id: "C_TEST", name: "current", isArchived: false, isMember: true,
  } }; });
  provider.readConversationAudience = async () => ({ kind: "fact", fact: { providerMemberIds: ["U_BOT", "U_HUMAN"],
    users: [{ id: "U_HUMAN", displayName: "External Human", handle: "external-human", actorKind: "human" }] } });
  const now = new Date(NOW.getTime() + 1000);
  await recoverSlackLifecyclePauses({ db: getDb(), provider, bindingId: fixture.binding.id, now });
  const [binding] = await getDb().select().from(externalChannelBindings);
  assert.equal(binding.slackLifecycleObservation?.recovery?.attempt, 0);
  assert.equal(binding.slackLifecycleObservation?.recovery?.nextCheckAt, new Date(now.getTime() + 5 * 60_000).toISOString());
  await recoverSlackLifecyclePauses({ db: getDb(), provider, bindingId: fixture.binding.id, now: new Date(now.getTime() + 1000) });
  assert.equal(stateReads, 1, "a successful hint still has a thirty-second minimum interval");
});

test("stale install grants acknowledge signed metadata without changing the pair or claiming it was processed", async () => {
  const fixture = await seedIngressAuthority("public");
  await getDb().update(externalAppInstallServerGrants).set({ state: "revoked", revokedAt: NOW, revokeReason: "synthetic revoked grant" });
  const result = await signedMetadata({ type: "channel_rename", channel: { id: "C_TEST", name: "must-not-change" } });
  assert.equal(result.kind === "event" ? result.reason : null, "lifecycle_metadata_stale_authority");
  const [binding] = await getDb().select().from(externalChannelBindings);
  assert.equal(binding.bindingEpoch, fixture.binding.bindingEpoch); assert.equal(binding.slackLifecycleObservation, null);
  const [receipt] = await getDb().select().from(externalIngressDiscardReceipts);
  assert.equal(receipt.outcomeReason, "lifecycle_metadata_stale_authority");
});

test("member clocks compare newer directory observations as well as older event clocks", async () => {
  const fixture = await seedIngressAuthority("public");
  await getDb().update(externalAddressabilityProjections).set({ observedAt: new Date(NOW.getTime() + 1000) })
    .where(eq(externalAddressabilityProjections.projectionId, fixture.projection.id));
  await signedMetadata({ type: "member_left_channel", channel: "C_TEST", user: "U_HUMAN" }, "000200");
  const [current] = await getDb().select().from(externalAddressabilityProjections);
  assert.equal(current.state, "active", "an older event cannot undo the newer directory witness");
  await signedMetadata({ type: "member_joined_channel", channel: "C_TEST", user: "U_NEW_CLOCK" }, "000300");
  await signedMetadata({ type: "member_left_channel", channel: "C_TEST", user: "U_NEW_CLOCK" }, "000500");
  await signedMetadata({ type: "member_joined_channel", channel: "C_TEST", user: "U_NEW_CLOCK" }, "000400");
  const [actor] = await getDb().select().from(externalActorProjections).where(eq(externalActorProjections.externalActorId, "U_NEW_CLOCK"));
  const [address] = await getDb().select().from(externalAddressabilityProjections).where(eq(externalAddressabilityProjections.projectionId, actor.id));
  assert.equal(address.state, "removed", "same-millisecond event ordering must preserve the later departure");
});

test("a new signed bot join makes verification due immediately without allowing duplicate hints to reset it", async () => {
  const fixture = await seedIngressAuthority("public");
  await allowLifecycleRecovery(fixture.binding.serverId);
  await getDb().update(externalChannelBindings).set({ state: "paused", stateReason: "provider_bot_removed",
    slackLifecycleObservation: { recovery: { attempt: 12, lastCheckedAt: new Date(NOW.getTime() - 10_000).toISOString(),
      nextCheckAt: new Date(NOW.getTime() + 6 * 3_600_000).toISOString() } } });
  await signedMetadata({ type: "member_joined_channel", channel: "C_TEST", user: fixture.install.botUserId }, "000200");
  let calls = 0;
  const provider = recoveryProvider(async () => { calls++; return { kind: "unverified" }; });
  await recoverSlackLifecyclePauses({ db: getDb(), provider, bindingId: fixture.binding.id, now: new Date(NOW.getTime() + 1000) });
  assert.equal(calls, 1, "the old thirty-second guard and six-hour backoff must not swallow a new self-join");
  const [checked] = await getDb().select().from(externalChannelBindings);
  await signedMetadata({ type: "member_joined_channel", channel: "C_TEST", user: fixture.install.botUserId }, "000200");
  const [duplicate] = await getDb().select().from(externalChannelBindings);
  assert.deepEqual(duplicate.slackLifecycleObservation?.recovery, checked.slackLifecycleObservation?.recovery);
  await recoverSlackLifecyclePauses({ db: getDb(), provider, bindingId: fixture.binding.id, now: new Date(NOW.getTime() + 2000) });
  assert.equal(calls, 1, "replayed joins cannot bypass the new check's minimum interval");
  assert.equal(duplicate.state, "paused", "a join remains a hint, not recovery proof");
});

test("recovery window excludes bot-less installations instead of starving a usable pair", async () => {
  const fixture = await seedIngressAuthority("public");
  await allowLifecycleRecovery(fixture.binding.serverId);
  await signedMetadata({ type: "channel_archive", channel: "C_TEST" });
  const [paused] = await getDb().select().from(externalChannelBindings);
  await getDb().update(externalChannelBindings).set({ slackLifecycleObservation: { ...paused.slackLifecycleObservation,
    recovery: { attempt: 0, lastCheckedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), nextCheckAt: NOW.toISOString() } } })
    .where(eq(externalChannelBindings.id, fixture.binding.id));
  const empty = Array.from({ length: 100 }, (_, index) => ({ installId: randomUUID(), channelId: randomUUID(), team: `T_NO_BOT_${index}` }));
  await getDb().insert(externalAppInstalls).values(empty.map(row => ({ ...fixture.install, id: row.installId,
    providerTeamId: row.team, providerAuthorityId: row.team, botUserId: null, providerBotId: null })));
  await getDb().insert(channels).values(empty.map((row, index) => ({ id: row.channelId, serverId: fixture.binding.serverId,
    name: `no-bot-${index}`, type: "channel" as const })));
  await getDb().insert(externalChannelBindings).values(empty.map(row => ({ ...fixture.binding, id: randomUUID(),
    installId: row.installId, channelId: row.channelId, providerConversationId: `C_${row.team}`,
    state: "paused" as const, stateReason: "provider_channel_archived" })));
  let calls = 0;
  await recoverSlackLifecyclePauses({ db: getDb(), now: new Date(NOW.getTime() + 1000),
    provider: recoveryProvider(async input => { calls++; assert.equal(input.providerConversationId, "C_TEST"); return { kind: "unverified" }; }) });
  assert.equal(calls, 1, "100 unusable rows must not occupy the whole candidate window");
});

test("a slow joined-member users.info aborts before the Slack ACK budget and keeps an unknown profile", async () => {
  const fixture = await seedIngressAuthority("public");
  await allowLifecycleRecovery(fixture.binding.serverId);
  const { createSlackBridgeEnvCredentialCipher } = await import("./slackBridgeEnvSecrets");
  const { createSlackBridgeProviderRuntime } = await import("./slackBridgeProviderRuntime");
  const { createSlackBridgeProductionLifecycle } = await import("./slackBridgeProductionLifecycle");
  const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 47) });
  const sealed = await cipher.sealer.seal({ serverId: fixture.binding.serverId, accessToken: "synthetic-joined-timeout", tokenType: "bot",
    providerAppId: fixture.install.providerAppId, providerTeamId: fixture.install.providerTeamId!, botUserId: fixture.install.botUserId!, now: NOW });
  await getDb().update(externalAppCredentials).set({ encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion });
  let aborted = false;
  const provider = createSlackBridgeProviderRuntime({ db: getDb(), credentialCipher: cipher, now: () => NOW,
    fetch: (async (url, init) => {
      assert.equal(new URL(String(url)).pathname.split("/").at(-1), "users.info");
      assert.ok(init?.signal);
      return new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener("abort", () => {
        aborted = true; reject(new Error("synthetic profile abort"));
      }, { once: true }); });
    }) as typeof fetch });
  const lifecycle = createSlackBridgeProductionLifecycle({ db: getDb(), provider, now: () => NOW });
  try {
    const start = performance.now();
    const result = await signedMetadata({ type: "member_joined_channel", channel: "C_TEST", user: "U_SLOW_JOIN" }, "000200",
      undefined, lifecycle.readMemberProfile);
    assert.ok(performance.now() - start < 2_750, "a fifteen-second provider read cannot hold the event ACK");
    assert.equal(aborted, true, "the actual provider fetch must be cancelled, not left running after a race");
    assert.equal(result.kind === "event" ? result.status : null, "committed");
    const [actor] = await getDb().select().from(externalActorProjections).where(eq(externalActorProjections.externalActorId, "U_SLOW_JOIN"));
    assert.equal(actor.actorKind, "unknown"); assert.equal(actor.displayName, "U_SLOW_JOIN");
  } finally { lifecycle.stop(); await provider.stop(); }
}, 25_000);

test("test-channel identity observation is scoped, content-free and does not change admission", async () => {
  await seedIngressAuthority();
  const observations: unknown[] = [];
  let resolveObservation: () => void = () => {};
  const nextObservation = () => new Promise<void>(resolve => { resolveObservation = resolve; });
  const observer = { providerConversationIds: ["C_TEST"],
    record: (sample: unknown) => { observations.push(sample); resolveObservation(); } };
  const body = (eventId: string, channel: string) => Buffer.from(JSON.stringify({ type: "event_callback",
    api_app_id: "A_TEST_APP", team_id: "T_TEST", event_id: eventId,
    event: { type: "message", subtype: "bot_message", channel, ts: "1785931200.123456", bot_id: "B_BOT",
      app_id: "A_TEST_APP", user: "U_BOT", text: "private-test-body", files: [{ id: "F_TEST" }] } }));
  const call = async (eventId: string, channel: string, signatureInvalid = false) => {
    const rawBody = body(eventId, channel);
    return verifyAndAdmitSlackIngress({ requestUrl: REQUEST_URL, environment: "test", rawBody,
      ...signedRequest(rawBody), ...(signatureInvalid ? { signatureHeader: "v0=invalid" } : {}),
      ...handshakeDependencies(), testIdentityObserver: observer, now: NOW });
  };
  await assert.rejects(call("Ev_observe_bad", "C_TEST", true));
  assert.equal(observations.length, 0);
  await call("Ev_observe_other", "C_OTHER");
  assert.equal(observations.length, 0);
  const retryBody = body("Ev_observe_retry", "C_TEST");
  const retry = await verifyAndAdmitSlackIngress({ requestUrl: REQUEST_URL, environment: "test", rawBody: retryBody,
    ...signedRequest(retryBody), ...handshakeDependencies(), testIdentityObserver: observer,
    slackRetryNumHeader: "1", now: NOW });
  assert.equal(retry.kind === "event" && retry.reason, "provider_loop_suppressed");
  assert.equal(observations.length, 0);
  let observed = nextObservation();
  const bot = await call("Ev_observe_good", "C_TEST");
  await observed;
  assert.equal(bot.kind === "event" && bot.reason, "provider_loop_suppressed");
  assert.deepEqual(observations, [{ isRecognizedBot: true, userIdMatchesHistory: true, hasSenderAppId: true, senderAppIdMatches: true,
    senderAppIdsConflict: false, hasBotId: true, botIdMatchesHistory: true, hasText: true, hasFiles: true }]);
  const human = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: "A_TEST_APP", team_id: "T_TEST",
    event_id: "Ev_observe_human", event: { type: "message", channel: "C_TEST", ts: "1785931201.123456",
      user: "U_HUMAN", text: "private human body" } }));
  observed = nextObservation();
  const humanResult = await verifyAndAdmitSlackIngress({ requestUrl: REQUEST_URL, environment: "test", rawBody: human,
    ...signedRequest(human), secretResolver: handshakeDependencies().secretResolver,
    payloadSealer: { async sealNormalizedPayload() { return { encryptedPayload: "sealed", envelopeKeyId: "test", aadVersion: 1 }; } },
    runtimeResolver: { async resolveCurrentRuntime() { return { runtimeRevision: "runtime-exact-1" }; } },
    testIdentityObserver: observer, now: NOW });
  await observed;
  assert.equal(humanResult.kind === "event" && humanResult.status, "queued");
  assert.deepEqual(observations[1], { isRecognizedBot: false, userIdMatchesHistory: false, hasSenderAppId: false, senderAppIdMatches: false,
    senderAppIdsConflict: false, hasBotId: false, botIdMatchesHistory: false, hasText: true, hasFiles: false });
  // A diagnostic failure must not turn the original skip into a retry.
  const failureBody = body("Ev_observe_log_failure", "C_TEST");
  let resolveFailure: () => void = () => {};
  const failureObserved = new Promise<void>(resolve => { resolveFailure = resolve; });
  const failure = await verifyAndAdmitSlackIngress({ requestUrl: REQUEST_URL, environment: "test", rawBody: failureBody,
    ...signedRequest(failureBody), ...handshakeDependencies(), now: NOW,
    testIdentityObserver: { ...observer, record() { resolveFailure(); throw new Error("diagnostic failed"); } } });
  await failureObserved;
  assert.equal(failure.kind === "event" && failure.reason, "provider_loop_suppressed");
  // A stalled diagnostic sink must not stall Slack's acknowledgement.
  let started: () => void = () => {};
  let release: () => void = () => {};
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const stalledBody = body("Ev_observe_stalled_sink", "C_TEST");
  const stalledRequest = verifyAndAdmitSlackIngress({ requestUrl: REQUEST_URL, environment: "test", rawBody: stalledBody,
    ...signedRequest(stalledBody), ...handshakeDependencies(), now: NOW,
    testIdentityObserver: { ...observer, record() { started(); return blocked; } } });
  await startedPromise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stalled = await Promise.race([stalledRequest, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("diagnostic stalled admission")), 2_000);
    })]);
    assert.equal(stalled.kind === "event" && stalled.reason, "provider_loop_suppressed");
  } finally {
    if (timer) clearTimeout(timer);
    release();
  }
});


test("identity observation accepts the signed AWS staging endpoint in production registration mode", async () => {
  await seedIngressAuthority();
  const stagingUrl = "https://api-aws-staging.botiverse.dev/api/slack-bridge/events";
  await getDb().update(externalAppRegistrations).set({ environment: "production" });
  await getDb().update(externalAppIngressEndpoints).set({ environment: "production", exactRequestUrl: stagingUrl });
  let observed: (value: unknown) => void = () => {};
  const observation = new Promise<unknown>(resolve => { observed = resolve; });
  const rawBody = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: "A_TEST_APP", team_id: "T_TEST",
    event_id: "Ev_staging_observe", event: { type: "message", subtype: "bot_message", channel: "C_TEST",
      ts: "1785931201.123456", bot_id: "B_BOT", app_id: "A_TEST_APP", text: "test" } }));
  const result = await verifyAndAdmitSlackIngress({ requestUrl: stagingUrl, environment: "production", rawBody,
    ...signedRequest(rawBody), ...handshakeDependencies(), now: NOW,
    testIdentityObserver: { providerConversationIds: ["C_TEST"], record: observed } });
  const sample = await observation as { senderAppIdMatches: boolean };
  assert.equal(sample.senderAppIdMatches, true);
  assert.equal(result.kind === "event" && result.reason, "provider_loop_suppressed");
});
