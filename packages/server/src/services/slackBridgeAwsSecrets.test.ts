import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createSlackKmsBotCredentialSealer,
  createSlackOAuthSecretsManagerLeaseProvider,
  type SlackOAuthSecretAuthorityStore,
} from "./slackBridgeAwsSecrets.js";

const NOW = new Date("2026-08-11T09:00:00.000Z");
const SECRET_ARN = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:slack-oauth-AbCdEf";
const KEY_ARN = "arn:aws:kms:ap-southeast-1:123456789012:key/11111111-2222-3333-4444-555555555555";

function authority() {
  return {
    registrationId: "11111111-1111-4111-8111-111111111111",
    providerAppId: "A123",
    providerOAuthClientId: "123.456",
    environment: "production" as const,
    secretId: "22222222-2222-4222-8222-222222222222",
    encryptedSecretRef: SECRET_ARN,
    envelopeKeyId: KEY_ARN,
    aadVersion: 1,
    secretRevision: 7,
    leaseOwner: "slack-oauth:attempt-1",
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
  };
}

function secretBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "slack-oauth-client-secret.v1",
    registrationId: authority().registrationId,
    providerOAuthClientId: authority().providerOAuthClientId,
    secretRevision: 7,
    aadVersion: 1,
    clientSecret: "oauth-client-secret-value",
    ...overrides,
  });
}

function createAuthorityStore(input: { confirm?: boolean } = {}) {
  const claims: unknown[] = [];
  const confirmations: unknown[] = [];
  const store: SlackOAuthSecretAuthorityStore = {
    async claim(request) {
      claims.push(request);
      return authority();
    },
    async confirm(snapshot, now) {
      confirmations.push({ snapshot, now });
      return input.confirm ?? true;
    },
  };
  return { store, claims, confirmations };
}

function leaseRequest() {
  return {
    registrationId: authority().registrationId,
    providerAppId: authority().providerAppId,
    providerOAuthClientId: authority().providerOAuthClientId,
    environment: "production" as const,
    audience: "slack-oauth-exchange" as const,
    attemptId: "attempt-1",
    now: NOW,
  };
}

test("Secrets Manager lease binds DB authority, KMS key, secret metadata, and fresh confirmation", async () => {
  const { store, claims, confirmations } = createAuthorityStore();
  const commands: Array<{ name: string; input: unknown }> = [];
  const provider = createSlackOAuthSecretsManagerLeaseProvider({
    authorityStore: store,
    now: () => NOW,
    secretsManager: {
      async send(command) {
        const typed = command as { constructor: { name: string }; input: unknown };
        commands.push({ name: typed.constructor.name, input: typed.input });
        if (typed.constructor.name === "DescribeSecretCommand") {
          return { ARN: SECRET_ARN, KmsKeyId: KEY_ARN };
        }
        return {
          ARN: SECRET_ARN,
          SecretString: secretBody(),
          VersionStages: ["AWSCURRENT"],
        };
      },
    },
  });

  const result = await provider.lease(leaseRequest());

  assert.deepEqual(result, {
    providerOAuthClientId: "123.456",
    clientSecret: "oauth-client-secret-value",
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  assert.equal(claims.length, 1);
  assert.equal(confirmations.length, 1);
  assert.deepEqual(commands, [{
    name: "DescribeSecretCommand",
    input: { SecretId: SECRET_ARN },
  }, {
    name: "GetSecretValueCommand",
    input: { SecretId: SECRET_ARN, VersionStage: "AWSCURRENT" },
  }]);
  assert.equal(JSON.stringify(result).includes(SECRET_ARN), false, "secret references stay behind the lease seam");
});

test("Secrets Manager lease fails closed when the described KMS authority differs", async () => {
  const { store, confirmations } = createAuthorityStore();
  let getCalls = 0;
  const provider = createSlackOAuthSecretsManagerLeaseProvider({
    authorityStore: store,
    now: () => NOW,
    secretsManager: {
      async send(command) {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === "DescribeSecretCommand") {
          return { ARN: SECRET_ARN, KmsKeyId: `${KEY_ARN}-wrong` };
        }
        getCalls += 1;
        return {};
      },
    },
  });

  assert.equal(await provider.lease(leaseRequest()), null);
  assert.equal(getCalls, 0, "wrong KMS authority is rejected before plaintext resolution");
  assert.equal(confirmations.length, 0);
});

test("Secrets Manager lease rejects metadata confusion and post-resolution authority revocation", async () => {
  for (const [label, body, confirm] of [
    ["registration", secretBody({ registrationId: "33333333-3333-4333-8333-333333333333" }), true],
    ["revision", secretBody({ secretRevision: 8 }), true],
    ["unexpected field", secretBody({ comment: "not-authority" }), true],
    ["fresh authority", secretBody(), false],
  ] as const) {
    const { store } = createAuthorityStore({ confirm });
    const provider = createSlackOAuthSecretsManagerLeaseProvider({
      authorityStore: store,
      now: () => NOW,
      secretsManager: {
        async send(command) {
          const name = (command as { constructor: { name: string } }).constructor.name;
          return name === "DescribeSecretCommand"
            ? { ARN: SECRET_ARN, KmsKeyId: KEY_ARN }
            : { ARN: SECRET_ARN, SecretString: body, VersionStages: ["AWSCURRENT"] };
        },
      },
    });
    assert.equal(await provider.lease(leaseRequest()), null, label);
  }
});

test("KMS bot sealer binds identity context and returns ciphertext only", async () => {
  const calls: unknown[] = [];
  const sealer = createSlackKmsBotCredentialSealer({
    keyId: KEY_ARN,
    kms: {
      async send(command) {
        calls.push((command as { input: unknown }).input);
        return {
          CiphertextBlob: Uint8Array.from([1, 2, 3, 4]),
          KeyId: KEY_ARN,
        };
      },
    },
  });

  const sealed = await sealer.seal({
    serverId: "11111111-1111-4111-8111-111111111111",
    accessToken: "xoxb-super-secret-token",
    tokenType: "bot",
    providerAppId: "A123",
    providerTeamId: "T123",
    botUserId: "U123",
    now: NOW,
  });

  assert.deepEqual(sealed, {
    encryptedMaterial: "kms:v1:AQIDBA==",
    envelopeKeyId: KEY_ARN,
    aadVersion: 1,
  });
  assert.equal(JSON.stringify(sealed).includes("xoxb-super-secret-token"), false);
  const call = calls[0] as {
    KeyId: string;
    Plaintext: Uint8Array;
    EncryptionAlgorithm: string;
    EncryptionContext: Record<string, string>;
  };
  assert.equal(call.KeyId, KEY_ARN);
  assert.equal(call.EncryptionAlgorithm, "SYMMETRIC_DEFAULT");
  assert.equal(Buffer.from(call.Plaintext).toString("utf8"), JSON.stringify({
    accessToken: "xoxb-super-secret-token",
    tokenType: "bot",
  }));
  assert.deepEqual(call.EncryptionContext, {
    aad_version: "1",
    bot_user_id: "U123",
    provider: "slack",
    provider_app_id: "A123",
    provider_team_id: "T123",
    purpose: "slack_bot_credential",
    token_type: "bot",
  });
});

test("KMS bot sealer rejects ciphertext from a different returned KMS authority", async () => {
  const sealer = createSlackKmsBotCredentialSealer({
    keyId: KEY_ARN,
    kms: {
      async send() {
        return {
          CiphertextBlob: Uint8Array.from([1, 2, 3, 4]),
          KeyId: `${KEY_ARN}-wrong`,
        };
      },
    },
  });

  await assert.rejects(() => sealer.seal({
    serverId: "11111111-1111-4111-8111-111111111111",
    accessToken: "xoxb-super-secret-token",
    tokenType: "bot",
    providerAppId: "A123",
    providerTeamId: "T123",
    botUserId: "U123",
    now: NOW,
  }), /KMS response is invalid/);
});

test("KMS bot sealer rejects invalid plaintext before provider I/O", async () => {
  let calls = 0;
  const sealer = createSlackKmsBotCredentialSealer({
    keyId: KEY_ARN,
    kms: { async send() { calls += 1; return {}; } },
  });
  await assert.rejects(() => sealer.seal({
    serverId: "11111111-1111-4111-8111-111111111111",
    accessToken: "",
    tokenType: "bot",
    providerAppId: "A123",
    providerTeamId: "T123",
    botUserId: "U123",
    now: NOW,
  }), /cannot be sealed/);
  await assert.rejects(() => sealer.seal({
    serverId: "11111111-1111-4111-8111-111111111111",
    accessToken: "x".repeat(4_096),
    tokenType: "bot",
    providerAppId: "A123",
    providerTeamId: "T123",
    botUserId: "U123",
    now: NOW,
  }), /cannot be sealed/);
  assert.equal(calls, 0);
});
