import assert from "node:assert/strict";
import { test } from "vitest";

import type { ExternalInboundPayloadAad } from "./externalAppIngressService.js";
import {
  createSlackKmsInboundPayloadCrypto,
  createSlackSigningSecretManagerResolver,
} from "./slackBridgeAwsIngressCrypto.js";

const SECRET_ARN = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:slack-signing-AbCdEf";
const KEY_ARN = "arn:aws:kms:ap-southeast-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const REGISTRATION_ID = "11111111-1111-4111-8111-111111111111";

function signingBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "slack-signing-secret.v1",
    registrationId: REGISTRATION_ID,
    environment: "production",
    secretRevision: 4,
    aadVersion: 1,
    signingSecret: "slack-signing-secret-value",
    ...overrides,
  });
}

function signingRequest() {
  return {
    registrationId: REGISTRATION_ID,
    environment: "production" as const,
    encryptedSecretRef: SECRET_ARN,
    envelopeKeyId: KEY_ARN,
    aadVersion: 1,
    secretRevision: 4,
  };
}

test("signing-secret resolver binds AWSCURRENT, exact KMS authority, and metadata", async () => {
  const commands: Array<{ name: string; input: unknown }> = [];
  const resolver = createSlackSigningSecretManagerResolver({
    secretsManager: {
      async send(command) {
        const typed = command as { constructor: { name: string }; input: unknown };
        commands.push({ name: typed.constructor.name, input: typed.input });
        return typed.constructor.name === "DescribeSecretCommand"
          ? { ARN: SECRET_ARN, KmsKeyId: KEY_ARN }
          : { ARN: SECRET_ARN, SecretString: signingBody(), VersionStages: ["AWSCURRENT"] };
      },
    },
  });

  assert.equal(await resolver.resolveSigningSecret(signingRequest()), "slack-signing-secret-value");
  assert.deepEqual(commands, [{
    name: "DescribeSecretCommand",
    input: { SecretId: SECRET_ARN },
  }, {
    name: "GetSecretValueCommand",
    input: { SecretId: SECRET_ARN, VersionStage: "AWSCURRENT" },
  }]);
});

test("signing-secret resolver rejects wrong KMS before plaintext and metadata confusion", async () => {
  let gets = 0;
  const wrongKms = createSlackSigningSecretManagerResolver({
    secretsManager: {
      async send(command) {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === "DescribeSecretCommand") return { ARN: SECRET_ARN, KmsKeyId: `${KEY_ARN}-wrong` };
        gets += 1;
        return {};
      },
    },
  });
  await assert.rejects(() => wrongKms.resolveSigningSecret(signingRequest()), /KMS authority/);
  assert.equal(gets, 0);

  for (const [label, body] of [
    ["registration", signingBody({ registrationId: "22222222-2222-4222-8222-222222222222" })],
    ["revision", signingBody({ secretRevision: 5 })],
    ["environment", signingBody({ environment: "test" })],
    ["extra field", signingBody({ comment: "not-authority" })],
  ] as const) {
    const resolver = createSlackSigningSecretManagerResolver({
      secretsManager: {
        async send(command) {
          const name = (command as { constructor: { name: string } }).constructor.name;
          return name === "DescribeSecretCommand"
            ? { ARN: SECRET_ARN, KmsKeyId: KEY_ARN }
            : { ARN: SECRET_ARN, SecretString: body, VersionStages: ["AWSCURRENT"] };
        },
      },
    });
    await assert.rejects(() => resolver.resolveSigningSecret(signingRequest()), /metadata/, label);
  }
});

function aad(overrides: Partial<ExternalInboundPayloadAad> = {}): ExternalInboundPayloadAad {
  return {
    purpose: "external-inbound-normalized-event",
    aadVersion: 1,
    schemaVersion: 1,
    provider: "slack",
    environment: "production",
    appRegistrationId: REGISTRATION_ID,
    installId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "T_WORKSPACE",
    providerAuthorityId: "T_WORKSPACE",
    providerConversationId: "C_CHANNEL",
    providerEventId: "Ev123",
    bindingId: "33333333-3333-4333-8333-333333333333",
    bindingEpoch: 3,
    connectionEpoch: 7,
    runtimeRevision: "runtime-revision-9",
    raftChannelId: "44444444-4444-4444-8444-444444444444",
    privacyClass: "private",
    ...overrides,
  };
}

test("KMS envelope round trip binds the full normalized-event AAD and hides plaintext", async () => {
  const dataKey = Buffer.alloc(32, 7);
  const wrappedKey = Buffer.from("wrapped-data-key", "utf8");
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const crypto = createSlackKmsInboundPayloadCrypto({
    keyId: KEY_ARN,
    randomIv: () => Buffer.alloc(12, 9),
    kms: {
      async send(command) {
        const typed = command as { constructor: { name: string }; input: Record<string, unknown> };
        calls.push({ name: typed.constructor.name, input: typed.input });
        if (typed.constructor.name === "GenerateDataKeyCommand") {
          return { Plaintext: dataKey, CiphertextBlob: wrappedKey, KeyId: KEY_ARN };
        }
        assert.deepEqual(Buffer.from(typed.input.CiphertextBlob as Uint8Array), wrappedKey);
        return { Plaintext: dataKey, KeyId: KEY_ARN };
      },
    },
  });
  const plaintext = JSON.stringify({ schema: "external-inbound-normalized-event.v1", content: "secret body" });
  const sealed = await crypto.payloadSealer.sealNormalizedPayload({ plaintext, aad: aad() });

  assert.equal(sealed.envelopeKeyId, KEY_ARN);
  assert.equal(sealed.aadVersion, 1);
  assert.doesNotMatch(sealed.encryptedPayload, /secret body/);
  assert.equal(await crypto.decryptNormalizedPayload({
    eventId: "55555555-5555-4555-8555-555555555555",
    ciphertext: sealed.encryptedPayload,
    envelopeKeyId: sealed.envelopeKeyId,
    aad: aad(),
  }), plaintext);
  assert.deepEqual(calls.map((call) => call.name), ["GenerateDataKeyCommand", "DecryptCommand"]);
  assert.deepEqual(calls[0]?.input.EncryptionContext, calls[1]?.input.EncryptionContext);
  assert.deepEqual(calls[0]?.input.EncryptionContext, {
    aad_version: "1",
    app_registration_id: REGISTRATION_ID,
    binding_epoch: "3",
    binding_id: "33333333-3333-4333-8333-333333333333",
    connection_epoch: "7",
    environment: "production",
    install_id: "22222222-2222-4222-8222-222222222222",
    privacy_class: "private",
    provider: "slack",
    provider_authority_id: "T_WORKSPACE",
    provider_conversation_id: "C_CHANNEL",
    provider_event_id: "Ev123",
    purpose: "external-inbound-normalized-event",
    raft_channel_id: "44444444-4444-4444-8444-444444444444",
    runtime_revision: "runtime-revision-9",
    schema_version: "1",
    workspace_id: "T_WORKSPACE",
  });
});

test("KMS envelope refuses AAD substitution, wrong returned key authority, and invalid input before I/O", async () => {
  const dataKey = Buffer.alloc(32, 7);
  let calls = 0;
  const crypto = createSlackKmsInboundPayloadCrypto({
    keyId: KEY_ARN,
    randomIv: () => Buffer.alloc(12, 9),
    kms: {
      async send(command) {
        calls += 1;
        const name = (command as { constructor: { name: string } }).constructor.name;
        return name === "GenerateDataKeyCommand"
          ? { Plaintext: dataKey, CiphertextBlob: Buffer.from("wrapped"), KeyId: KEY_ARN }
          : { Plaintext: dataKey, KeyId: KEY_ARN };
      },
    },
  });
  await assert.rejects(() => crypto.payloadSealer.sealNormalizedPayload({
    plaintext: "",
    aad: aad(),
  }), /cannot be sealed/);
  assert.equal(calls, 0);
  const sealed = await crypto.payloadSealer.sealNormalizedPayload({ plaintext: "payload", aad: aad() });
  await assert.rejects(() => crypto.decryptNormalizedPayload({
    eventId: "55555555-5555-4555-8555-555555555555",
    ciphertext: sealed.encryptedPayload,
    envelopeKeyId: sealed.envelopeKeyId,
    aad: aad({ providerConversationId: "C_OTHER" }),
  }));
  const callsBeforeWrongConfiguredKey = calls;
  await assert.rejects(() => crypto.decryptNormalizedPayload({
    eventId: "55555555-5555-4555-8555-555555555555",
    ciphertext: sealed.encryptedPayload,
    envelopeKeyId: `${KEY_ARN}-substituted`,
    aad: aad(),
  }));
  assert.equal(calls, callsBeforeWrongConfiguredKey, "an unconfigured key never reaches KMS");

  const wrongGeneratedKey = createSlackKmsInboundPayloadCrypto({
    keyId: KEY_ARN,
    randomIv: () => Buffer.alloc(12, 9),
    kms: {
      async send() {
        return {
          Plaintext: dataKey,
          CiphertextBlob: Buffer.from("wrapped"),
          KeyId: `${KEY_ARN}-wrong`,
        };
      },
    },
  });
  await assert.rejects(() => wrongGeneratedKey.payloadSealer.sealNormalizedPayload({
    plaintext: "payload",
    aad: aad(),
  }), /data key is invalid/);

  const wrongKey = createSlackKmsInboundPayloadCrypto({
    keyId: KEY_ARN,
    randomIv: () => Buffer.alloc(12, 9),
    kms: {
      async send(command) {
        const name = (command as { constructor: { name: string } }).constructor.name;
        return name === "GenerateDataKeyCommand"
          ? { Plaintext: dataKey, CiphertextBlob: Buffer.from("wrapped"), KeyId: KEY_ARN }
          : { Plaintext: dataKey, KeyId: `${KEY_ARN}-wrong` };
      },
    },
  });
  const wrongKeySealed = await wrongKey.payloadSealer.sealNormalizedPayload({ plaintext: "payload", aad: aad() });
  await assert.rejects(() => wrongKey.decryptNormalizedPayload({
    eventId: "55555555-5555-4555-8555-555555555555",
    ciphertext: wrongKeySealed.encryptedPayload,
    envelopeKeyId: wrongKeySealed.envelopeKeyId,
    aad: aad(),
  }), /data key is invalid/);
});
