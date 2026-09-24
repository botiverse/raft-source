import assert from "node:assert/strict";
import { test } from "vitest";

import type { ExternalInboundPayloadAad } from "./externalAppIngressService.js";
import {
  createSlackBridgeEnvSecretBackends,
  slackBridgeKeyFromEnv,
  SLACK_BRIDGE_CREDENTIAL_KEY_ID,
  SLACK_BRIDGE_PAYLOAD_KEY_ID,
  SLACK_BRIDGE_SIGNING_SECRET_REF,
} from "./slackBridgeEnvSecrets.js";

const REGISTRATION_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_ID = "22222222-2222-4222-8222-222222222222";

function backends() {
  return createSlackBridgeEnvSecretBackends({
    registrationId: REGISTRATION_ID,
    environment: "test",
    providerAppId: "A0123",
    providerOAuthClientId: "client-123",
    signingSecret: "signing-secret",
    oauthClientSecret: "oauth-secret",
    credentialEncryptionKey: Buffer.alloc(32, 7),
    payloadEncryptionKey: Buffer.alloc(32, 9),
  });
}

function aad(overrides: Partial<ExternalInboundPayloadAad> = {}): ExternalInboundPayloadAad {
  return {
    purpose: "external-inbound-normalized-event",
    aadVersion: 1,
    schemaVersion: 1,
    provider: "slack",
    environment: "test",
    appRegistrationId: REGISTRATION_ID,
    installId: "33333333-3333-4333-8333-333333333333",
    workspaceId: "T0123",
    providerAuthorityId: "T0123",
    providerConversationId: "C0123",
    providerEventId: "Ev0123",
    bindingId: "44444444-4444-4444-8444-444444444444",
    bindingEpoch: 2,
    connectionEpoch: 3,
    runtimeRevision: "runtime-4",
    raftChannelId: "55555555-5555-4555-8555-555555555555",
    privacyClass: "private",
    ...overrides,
  };
}

test("Slack env credential cipher rejects cross-tenant and cross-install ciphertext transplants", async () => {
  const { credentialCipher } = backends();
  const sealed = await credentialCipher.sealer.seal({
    serverId: SERVER_ID,
    accessToken: "xoxb-secret-token",
    tokenType: "bot",
    providerAppId: "A0123",
    providerTeamId: "T0123",
    botUserId: "U-BOT",
    now: new Date("2026-08-11T00:00:00.000Z"),
  });

  assert.equal(sealed.envelopeKeyId, SLACK_BRIDGE_CREDENTIAL_KEY_ID);
  assert.deepEqual(credentialCipher.unseal({
    serverId: SERVER_ID,
    providerAppId: "A0123",
    providerTeamId: "T0123",
    botUserId: "U-BOT",
    encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId,
    aadVersion: sealed.aadVersion,
  }), { accessToken: "xoxb-secret-token", tokenType: "bot" });
  assert.equal(credentialCipher.unseal({
    serverId: "66666666-6666-4666-8666-666666666666",
    providerAppId: "A0123",
    providerTeamId: "T0123",
    botUserId: "U-BOT",
    encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId,
    aadVersion: sealed.aadVersion,
  }), null);
  assert.equal(credentialCipher.unseal({
    serverId: SERVER_ID,
    providerAppId: "A0123",
    providerTeamId: "T-OTHER-INSTALL",
    botUserId: "U-BOT",
    encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId,
    aadVersion: sealed.aadVersion,
  }), null);
  assert.equal(credentialCipher.unseal({
    serverId: SERVER_ID,
    providerAppId: "A-OTHER-APP",
    providerTeamId: "T0123",
    botUserId: "U-BOT",
    encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId,
    aadVersion: sealed.aadVersion,
  }), null);
  assert.equal(credentialCipher.unseal({
    serverId: SERVER_ID,
    providerAppId: "A0123",
    providerTeamId: "T0123",
    botUserId: "U-OTHER-BOT",
    encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId,
    aadVersion: sealed.aadVersion,
  }), null);
});

test("Slack env credential cipher round-trips the accepted plaintext boundary and rejects overflow", async () => {
  const { credentialCipher } = backends();
  const wrapperBytes = Buffer.byteLength(
    JSON.stringify({ accessToken: "", tokenType: "bot" }),
    "utf8",
  );
  const acceptedToken = "x".repeat((16 * 1024) - wrapperBytes);
  const request = {
    serverId: SERVER_ID,
    accessToken: acceptedToken,
    tokenType: "bot" as const,
    providerAppId: "A0123",
    providerTeamId: "T0123",
    botUserId: "U-BOT",
    now: new Date("2026-08-11T00:00:00.000Z"),
  };

  const sealed = await credentialCipher.sealer.seal(request);
  assert.deepEqual(credentialCipher.unseal({
    serverId: request.serverId,
    providerAppId: request.providerAppId,
    providerTeamId: request.providerTeamId,
    botUserId: request.botUserId,
    encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId,
    aadVersion: sealed.aadVersion,
  }), { accessToken: acceptedToken, tokenType: "bot" });

  await assert.rejects(() => credentialCipher.sealer.seal({
    ...request,
    accessToken: `${acceptedToken}x`,
  }), /credential authority is invalid/);
});

test.each([1, 2, 3] as const)("Slack env payload cipher v%i binds the full install and binding authority", async (schemaVersion) => {
  const { payloadSealer, decryptNormalizedPayload } = backends();
  const authority = aad({ schemaVersion });
  const plaintext = JSON.stringify({ text: "line one\nline two" });
  const sealed = await payloadSealer.sealNormalizedPayload({ plaintext, aad: authority });

  assert.equal(sealed.envelopeKeyId, SLACK_BRIDGE_PAYLOAD_KEY_ID);
  assert.equal(await decryptNormalizedPayload({
    eventId: "event-1",
    ciphertext: sealed.encryptedPayload,
    envelopeKeyId: sealed.envelopeKeyId,
    aad: authority,
  }), plaintext);
  await assert.rejects(() => decryptNormalizedPayload({
    eventId: "event-1",
    ciphertext: sealed.encryptedPayload,
    envelopeKeyId: sealed.envelopeKeyId,
    aad: aad({ installId: "77777777-7777-4777-8777-777777777777" }),
  }), /envelope is invalid/);
  await assert.rejects(() => decryptNormalizedPayload({
    eventId: "event-1",
    ciphertext: sealed.encryptedPayload,
    envelopeKeyId: sealed.envelopeKeyId,
    aad: aad({ bindingEpoch: authority.bindingEpoch + 1 }),
  }), /envelope is invalid/);
});

test("Slack static env secrets are leased only for the exact registration authority", async () => {
  const { appSecrets, secretResolver } = backends();
  const now = new Date("2026-08-11T00:00:00.000Z");
  assert.deepEqual(await appSecrets.lease({
    registrationId: REGISTRATION_ID,
    providerAppId: "A0123",
    providerOAuthClientId: "client-123",
    environment: "test",
    audience: "slack-oauth-exchange",
    attemptId: "attempt-1",
    now,
  }), {
    providerOAuthClientId: "client-123",
    clientSecret: "oauth-secret",
    expiresAt: new Date(now.getTime() + 60_000),
  });
  assert.equal(await appSecrets.lease({
    registrationId: "88888888-8888-4888-8888-888888888888",
    providerAppId: "A0123",
    providerOAuthClientId: "client-123",
    environment: "test",
    audience: "slack-oauth-exchange",
    attemptId: "attempt-2",
    now,
  }), null);
  assert.equal(await secretResolver.resolveSigningSecret({
    registrationId: REGISTRATION_ID,
    environment: "test",
    encryptedSecretRef: SLACK_BRIDGE_SIGNING_SECRET_REF,
    envelopeKeyId: "env:process",
    aadVersion: 1,
    secretRevision: 1,
  }), "signing-secret");
  await assert.rejects(() => secretResolver.resolveSigningSecret({
    registrationId: REGISTRATION_ID,
    environment: "test",
    encryptedSecretRef: SLACK_BRIDGE_SIGNING_SECRET_REF,
    envelopeKeyId: "env:process",
    aadVersion: 1,
    secretRevision: 2,
  }), /authority is mismatched/);
});

test("Slack env keys require canonical base64 for exactly 32 bytes", () => {
  const value = Buffer.alloc(32, 4).toString("base64");
  assert.deepEqual(slackBridgeKeyFromEnv(value, "TEST_KEY"), Buffer.alloc(32, 4));
  assert.throws(() => slackBridgeKeyFromEnv("not-base64", "TEST_KEY"), /base64-encoded 32-byte/);
  assert.throws(() => slackBridgeKeyFromEnv(undefined, "TEST_KEY"), /requires TEST_KEY/);
});
