import assert from "node:assert/strict";
import { DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import { SLACK_VERIFIED_INGRESS_MAX_BYTES, type SlackVerifiedIngressAad } from "./slackVerifiedIngressContracts";
import { createSlackVerifiedIngressEnvCrypto } from "./slackVerifiedIngressEnvCrypto";
import { createSlackVerifiedIngressKmsCrypto } from "./slackVerifiedIngressKmsCrypto";

const aad: SlackVerifiedIngressAad = { purpose: "slack-verified-ingress", version: 1,
  registrationId: "registration-1", environment: "test", providerAppId: "A123",
  providerAuthorityId: "T123", providerEventId: "Ev123", providerConversationId: "C123" };
const key = Buffer.alloc(32, 7);

test("environment adapter retains full-size encrypted events under pinned authority", async () => {
  const crypto = createSlackVerifiedIngressEnvCrypto({ key, keyId: "env-key", registrationId: aad.registrationId,
    environment: aad.environment, providerAppId: aad.providerAppId });
  const bytes = Buffer.alloc(SLACK_VERIFIED_INGRESS_MAX_BYTES, 0x61);
  const sealed = await crypto.seal({ bytes, aad });
  assert.deepEqual(await crypto.open({ ...sealed, aad }), bytes);
  await assert.rejects(crypto.open({ ...sealed, aad: { ...aad, registrationId: "other" } }));
  await assert.rejects(crypto.open({ ...sealed, envelopeKeyId: "other", aad }));
});

test("KMS adapter wraps a fresh key and binds decryption to the verified event authority", async () => {
  let generatedContext: Record<string, string> | undefined;
  const generatedKeys: Uint8Array[] = [];
  const kms = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof GenerateDataKeyCommand) {
        generatedContext = command.input.EncryptionContext;
        const generatedKey = Uint8Array.from(key);
        generatedKeys.push(generatedKey);
        return { KeyId: "kms-key", Plaintext: generatedKey, CiphertextBlob: Buffer.from("wrapped-key") };
      }
      if (command instanceof DecryptCommand) {
        assert.deepEqual(command.input.EncryptionContext, generatedContext);
        assert.deepEqual(Buffer.from(command.input.CiphertextBlob as Uint8Array), Buffer.from("wrapped-key"));
        return { KeyId: "kms-key", Plaintext: Uint8Array.from(key) };
      }
      throw new Error("unexpected KMS command");
    },
  };
  const crypto = createSlackVerifiedIngressKmsCrypto({ kms, keyId: "kms-key" });
  const bytes = Buffer.from("confidential message");
  const sealed = await crypto.seal({ bytes, aad });
  assert.ok(generatedKeys[0]?.every((byte) => byte === 0), "generated plaintext data key is cleared");
  assert.ok(!sealed.encryptedPayload.includes("confidential message"));
  assert.deepEqual(await crypto.open({ ...sealed, aad }), bytes);
  await assert.rejects(crypto.open({ ...sealed, aad: { ...aad, providerEventId: "Ev_other" } }));
  const wrapper = JSON.parse(sealed.encryptedPayload) as { payload: string };
  const payload = JSON.parse(wrapper.payload) as { ciphertext: string };
  const ciphertext = Buffer.from(payload.ciphertext, "base64url");
  ciphertext[0] ^= 1;
  payload.ciphertext = ciphertext.toString("base64url");
  wrapper.payload = JSON.stringify(payload);
  await assert.rejects(crypto.open({ ...sealed, encryptedPayload: JSON.stringify(wrapper), aad }));
});

test("KMS round-trip uses the verified authority and payload as they were at call time", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let observedContext: Record<string, string> | undefined;
  const kms = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof GenerateDataKeyCommand) {
        observedContext = command.input.EncryptionContext;
        await gate;
        return { KeyId: "kms-key", Plaintext: Uint8Array.from(key), CiphertextBlob: Buffer.from("wrapped-key") };
      }
      if (command instanceof DecryptCommand) {
        assert.deepEqual(command.input.EncryptionContext, observedContext);
        return { KeyId: "kms-key", Plaintext: Uint8Array.from(key) };
      }
      throw new Error("unexpected KMS command");
    },
  };
  const crypto = createSlackVerifiedIngressKmsCrypto({ kms, keyId: "kms-key" });
  const mutableAad = { ...aad };
  const bytes = Buffer.from("original body");
  const pending = crypto.seal({ bytes, aad: mutableAad });
  mutableAad.providerEventId = "Ev_changed";
  bytes.fill(0);
  release();
  const sealed = await pending;
  assert.equal((await crypto.open({ ...sealed, aad })).toString("utf8"), "original body");
});

test("environment keyring reads old custody but seals only with the active key", async () => {
  const old = createSlackVerifiedIngressEnvCrypto({ key, keyId: "old", registrationId: aad.registrationId,
    environment: aad.environment, providerAppId: aad.providerAppId });
  const oldReceipt = await old.seal({ bytes: Buffer.from("before rotation"), aad });
  const nextKey = Buffer.alloc(32, 8);
  const rotated = createSlackVerifiedIngressEnvCrypto({ key: nextKey, keyId: "new", decryptionKeys: new Map([["old", key]]),
    registrationId: aad.registrationId, environment: aad.environment, providerAppId: aad.providerAppId });
  assert.equal((await rotated.open({ ...oldReceipt, aad })).toString(), "before rotation");
  const nextReceipt = await rotated.seal({ bytes: Buffer.from("after rotation"), aad });
  assert.equal(nextReceipt.envelopeKeyId, "new");
  assert.equal((await rotated.open({ ...nextReceipt, aad })).toString(), "after rotation");
  await assert.rejects(rotated.open({ ...oldReceipt, envelopeKeyId: "new", aad }));
  await assert.rejects(rotated.open({ ...oldReceipt, envelopeKeyId: "unconfigured", aad }));
});

test("KMS keyring asks KMS for the stored old key and rejects unconfigured ids", async () => {
  const kms = { async send(command: unknown) {
    if (command instanceof GenerateDataKeyCommand) return { KeyId: command.input.KeyId,
      Plaintext: Uint8Array.from(key), CiphertextBlob: Buffer.from("wrapped-key") };
    if (command instanceof DecryptCommand) return { KeyId: command.input.KeyId, Plaintext: Uint8Array.from(key) };
    throw new Error("unexpected KMS command");
  } };
  const old = createSlackVerifiedIngressKmsCrypto({ kms, keyId: "old" });
  const sealed = await old.seal({ bytes: Buffer.from("old"), aad });
  const rotated = createSlackVerifiedIngressKmsCrypto({ kms, keyId: "new", decryptionKeyIds: ["old"] });
  assert.equal((await rotated.open({ ...sealed, aad })).toString(), "old");
  assert.equal((await rotated.seal({ bytes: Buffer.from("new"), aad })).envelopeKeyId, "new");
  await assert.rejects(rotated.open({ ...sealed, envelopeKeyId: "unknown", aad }));
});
