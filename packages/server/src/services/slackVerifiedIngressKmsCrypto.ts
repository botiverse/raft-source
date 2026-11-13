import { createHash } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import { isSlackVerifiedIngressAad, SLACK_VERIFIED_INGRESS_MAX_BYTES, type SlackVerifiedIngressAad, type SlackVerifiedIngressPayloadCrypto } from "./slackVerifiedIngressContracts";
import { openSlackVerifiedIngress, sealSlackVerifiedIngress, slackVerifiedIngressAuthenticatedData } from "./slackVerifiedIngressCrypto";

const WRAPPER_SCHEMA = "slack-verified-ingress-kms.v1";
const MAX_WRAPPER_BYTES = 1_500_000;
const MAX_WRAPPED_KEY_BYTES = 16 * 1024;
interface KmsClient { send(command: unknown): Promise<unknown> }

function context(aad: SlackVerifiedIngressAad): Record<string, string> {
  if (!isSlackVerifiedIngressAad(aad)) throw new Error("Invalid Slack ingress encryption authority");
  return {
    purpose: "slack-verified-ingress",
    version: "1",
    registration_id: aad.registrationId,
    environment: aad.environment,
    // KMS encryption context is logged. Hash event and channel coordinates.
    authority_digest: createHash("sha256").update(slackVerifiedIngressAuthenticatedData(aad)).digest("hex"),
  };
}

/** AWS KMS wraps a fresh data key; event bytes never leave this process in plaintext. */
export function createSlackVerifiedIngressKmsCrypto(input: {
  kms: KmsClient;
  keyId: string;
  decryptionKeyIds?: readonly string[];
}): SlackVerifiedIngressPayloadCrypto {
  if (!/^[A-Za-z0-9:_./-]{1,320}$/u.test(input.keyId)) {
    throw new Error("Invalid Slack ingress encryption key");
  }
  const keyId = input.keyId;
  const readKeyIds = new Set([keyId, ...(input.decryptionKeyIds ?? [])]);
  if (readKeyIds.size > 16 || [...readKeyIds].some(id => !/^[A-Za-z0-9:_./-]{1,320}$/u.test(id))) {
    throw new Error("Invalid Slack ingress encryption key");
  }
  const kms = input.kms;
  return {
    async seal(request) {
      if (!Buffer.isBuffer(request.bytes) || !request.bytes.length || request.bytes.length > SLACK_VERIFIED_INGRESS_MAX_BYTES) {
        throw new Error("Invalid Slack ingress payload");
      }
      const aad = { ...request.aad };
      const encryptionContext = context(aad);
      const bytes = Buffer.from(request.bytes);
      let key: Buffer | null = null;
      try {
        const generated = await kms.send(new GenerateDataKeyCommand({
          KeyId: keyId, KeySpec: "AES_256", EncryptionContext: encryptionContext,
        })) as { Plaintext?: unknown; CiphertextBlob?: unknown; KeyId?: unknown };
        const sourceKey = generated.Plaintext instanceof Uint8Array ? generated.Plaintext : null;
        key = sourceKey ? Buffer.from(sourceKey) : null;
        sourceKey?.fill(0);
        const wrapped = generated.CiphertextBlob instanceof Uint8Array ? Buffer.from(generated.CiphertextBlob) : null;
        if (!key || key.length !== 32 || !wrapped || !wrapped.length
          || wrapped.length > MAX_WRAPPED_KEY_BYTES || generated.KeyId !== keyId) {
          throw new Error("Invalid Slack ingress data key");
        }
        const payload = sealSlackVerifiedIngress({ bytes, key, aad });
        const encryptedPayload = JSON.stringify({ schema: WRAPPER_SCHEMA, wrappedKey: wrapped.toString("base64url"), payload });
        if (Buffer.byteLength(encryptedPayload, "utf8") > MAX_WRAPPER_BYTES) throw new Error("Invalid Slack ingress envelope");
        return { encryptedPayload, envelopeKeyId: keyId };
      } finally {
        bytes.fill(0);
        key?.fill(0);
      }
    },
    async open(request) {
      if (!readKeyIds.has(request.envelopeKeyId) || typeof request.encryptedPayload !== "string"
        || Buffer.byteLength(request.encryptedPayload, "utf8") > MAX_WRAPPER_BYTES) {
        throw new Error("Invalid Slack ingress envelope");
      }
      let parsed: unknown;
      try { parsed = JSON.parse(request.encryptedPayload); } catch { throw new Error("Invalid Slack ingress envelope"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Slack ingress envelope");
      const wrapper = parsed as Record<string, unknown>;
      if (Object.keys(wrapper).sort().join(",") !== "payload,schema,wrappedKey"
        || wrapper.schema !== WRAPPER_SCHEMA || typeof wrapper.payload !== "string"
        || typeof wrapper.wrappedKey !== "string" || !/^[A-Za-z0-9_-]+$/u.test(wrapper.wrappedKey)
        || wrapper.wrappedKey.length > Math.ceil(MAX_WRAPPED_KEY_BYTES * 4 / 3)) {
        throw new Error("Invalid Slack ingress envelope");
      }
      const wrapped = Buffer.from(wrapper.wrappedKey, "base64url");
      if (!wrapped.length || wrapped.length > MAX_WRAPPED_KEY_BYTES || wrapped.toString("base64url") !== wrapper.wrappedKey) {
        throw new Error("Invalid Slack ingress envelope");
      }
      const aad = { ...request.aad };
      const response = await kms.send(new DecryptCommand({
        KeyId: request.envelopeKeyId, CiphertextBlob: wrapped, EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: context(aad),
      })) as { Plaintext?: unknown; KeyId?: unknown };
      const sourceKey = response.Plaintext instanceof Uint8Array ? response.Plaintext : null;
      const key = sourceKey ? Buffer.from(sourceKey) : null;
      sourceKey?.fill(0);
      try {
        if (!key || key.length !== 32 || response.KeyId !== request.envelopeKeyId) throw new Error("Invalid Slack ingress data key");
        return openSlackVerifiedIngress({ envelope: wrapper.payload, key, aad });
      } finally {
        key?.fill(0);
      }
    },
  };
}
