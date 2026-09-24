import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterEach } from "vitest";

import { eq } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import {
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
  externalChannelBindings,
  externalIngressDiscardReceipts,
  externalInboundEvents,
  externalOutboundDeliveries,
  featureFlagRules,
  featureFlags,
  messages,
  oauthClientInstalls,
  oauthClients,
  users,
} from "../db/schema.js";
import { createServer } from "./serverService.js";
import { verifyAndAdmitSlackIngress } from "./externalAppIngressService.js";
import { updateFeatureFlag } from "./featureFlagService.js";
import { readSlackBindingLifecycleProjection } from "./slackBindingLifecycleService.js";
import { slackBridgeInstallGrantHash } from "./slackBridgeInstallGrantService.js";


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
  return { registration, signingSecret, endpoint, install, channel, binding, projection };
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
      text: "hello from Slack",
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
        assert.match(input.plaintext, /hello from Slack/);
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
  }, {
    eventId: "Ev_TEST_MESSAGE_CHANGED_WITH_FILE",
    event: {
      type: "message",
      subtype: "message_changed",
      channel: "C_TEST",
      user: "U_HUMAN",
      text: "edited with a file",
      ts: "1785931200.000203",
      files: [{ url_private: "https://files-pri.example.test/must-not-be-admitted" }],
    },
    reason: "unsupported_message_subtype",
    retryNum: null,
    retryReason: null,
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
    4,
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
  assert.equal((await getDb().select().from(externalIngressDiscardReceipts)).length, 4);
});

test("preauthorized reaction, file, edit, and delete events stay default-off without Raft or Slack mutation", async () => {
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
    eventId: "Ev_FUTURE_MESSAGE_CHANGED",
    event: {
      type: "message",
      subtype: "message_changed",
      channel: "C_TEST",
      ts: "1785931201.000303",
      message: { user: "U_HUMAN", text: "edited", ts: "1785931200.000303" },
    },
    reason: "unsupported_message_subtype",
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
  for (const key of [SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync]) {
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
    assert.equal(normalizedPayloads.at(-1)?.schema, "external-inbound-normalized-event.v2");
    assert.equal(normalizedPayloads.at(-1)?.content, sample.expectedContent);
    assert.deepEqual(normalizedPayloads.at(-1)?.providerFileIds, ["F_PRIVATE"]);
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

    const [binding] = await getDb().select().from(externalChannelBindings).where(eq(
      externalChannelBindings.id,
      fixture.binding.id,
    ));
    assert.equal(binding.state, "paused");
    assert.equal(binding.stateReason, expectedReason);
    assert.equal(binding.bindingEpoch, fixture.binding.bindingEpoch + 1);
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

test.each(["U_HUMAN", "U_BOT"])("reaction from %s crosses production cipher and database worker authority", async (actorId) => {
  const fixture = await seedIngressAuthority();
  const db = getDb();
  for (const key of [SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync]) {
    assert.ok(await updateFeatureFlag(key, { enabled: true, killSwitch: false }));
    await db.insert(featureFlagRules).values({
      flagKey: key, stage: "server", priority: 999, decision: "allow", values: [fixture.channel.serverId],
    });
  }
  const { createSlackBridgeEnvSecretBackends } = await import("./slackBridgeEnvSecrets.js");
  const { createSlackDatabaseIngressRuntimeResolver, createSlackDatabaseInboundWorkerRuntimeResolver } =
    await import("./slackBridgeDatabaseRuntimeAuthority.js");
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
