import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import type {
  ExternalInboundPayloadAad,
  ExternalIngressPayloadSealer,
  ExternalIngressSecretResolver,
} from "./externalAppIngressService.js";
import type { ExternalInboundWorkerDependencies } from "./externalInboundWorkerService.js";

const SIGNING_SECRET_SCHEMA = "slack-signing-secret.v1" as const;
const PAYLOAD_ENVELOPE_SCHEMA = "slack-inbound-payload-envelope.v1" as const;
const MAX_SIGNING_SECRET_BYTES = 4_096;
const MAX_NORMALIZED_PAYLOAD_BYTES = 128 * 1_024;

interface AwsCommandClient {
  send(command: unknown): Promise<unknown>;
}

type SigningSecretBody = {
  schema: typeof SIGNING_SECRET_SCHEMA;
  registrationId: string;
  environment: "test" | "production";
  secretRevision: number;
  aadVersion: number;
  signingSecret: string;
};

type PayloadEnvelope = {
  schema: typeof PAYLOAD_ENVELOPE_SCHEMA;
  algorithm: "AES-256-GCM";
  wrappedDataKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

function nonEmpty(value: unknown, max = 2_048): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= max;
}

function secretArn(value: string): boolean {
  return /^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:[^\s]+$/.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function parseSigningSecretBody(value: string): SigningSecretBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  if (!exactObjectKeys(body, [
    "schema",
    "registrationId",
    "environment",
    "secretRevision",
    "aadVersion",
    "signingSecret",
  ])) return null;
  if (
    body.schema !== SIGNING_SECRET_SCHEMA
    || !nonEmpty(body.registrationId, 64)
    || (body.environment !== "test" && body.environment !== "production")
    || !positiveInteger(body.secretRevision)
    || body.aadVersion !== 1
    || !nonEmpty(body.signingSecret, MAX_SIGNING_SECRET_BYTES)
  ) return null;
  return body as SigningSecretBody;
}

export function createSlackSigningSecretManagerResolver(input: {
  secretsManager: AwsCommandClient;
}): ExternalIngressSecretResolver {
  return {
    async resolveSigningSecret(request) {
      if (
        !nonEmpty(request.registrationId, 64)
        || (request.environment !== "test" && request.environment !== "production")
        || !secretArn(request.encryptedSecretRef)
        || !nonEmpty(request.envelopeKeyId)
        || request.aadVersion !== 1
        || !positiveInteger(request.secretRevision)
      ) throw new Error("Slack signing-secret authority is invalid");

      const described = await input.secretsManager.send(new DescribeSecretCommand({
        SecretId: request.encryptedSecretRef,
      })) as { ARN?: unknown; KmsKeyId?: unknown };
      if (
        described.ARN !== request.encryptedSecretRef
        || described.KmsKeyId !== request.envelopeKeyId
      ) throw new Error("Slack signing-secret KMS authority is mismatched");

      const resolved = await input.secretsManager.send(new GetSecretValueCommand({
        SecretId: request.encryptedSecretRef,
        VersionStage: "AWSCURRENT",
      })) as { ARN?: unknown; SecretString?: unknown; VersionStages?: unknown };
      if (
        resolved.ARN !== request.encryptedSecretRef
        || typeof resolved.SecretString !== "string"
        || !Array.isArray(resolved.VersionStages)
        || !resolved.VersionStages.includes("AWSCURRENT")
      ) throw new Error("Slack signing secret is unavailable");
      const body = parseSigningSecretBody(resolved.SecretString);
      if (
        !body
        || body.registrationId !== request.registrationId
        || body.environment !== request.environment
        || body.secretRevision !== request.secretRevision
        || body.aadVersion !== request.aadVersion
      ) throw new Error("Slack signing-secret metadata is mismatched");
      return body.signingSecret;
    },
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

function payloadEncryptionContext(aad: ExternalInboundPayloadAad): Record<string, string> {
  return {
    aad_version: String(aad.aadVersion),
    app_registration_id: aad.appRegistrationId,
    binding_epoch: String(aad.bindingEpoch),
    binding_id: aad.bindingId,
    connection_epoch: String(aad.connectionEpoch),
    environment: aad.environment,
    install_id: aad.installId,
    privacy_class: aad.privacyClass,
    provider: aad.provider,
    provider_authority_id: aad.providerAuthorityId,
    provider_conversation_id: aad.providerConversationId,
    provider_event_id: aad.providerEventId,
    purpose: aad.purpose,
    raft_channel_id: aad.raftChannelId,
    runtime_revision: aad.runtimeRevision,
    schema_version: String(aad.schemaVersion),
    workspace_id: aad.workspaceId,
  };
}

function validAad(value: ExternalInboundPayloadAad): boolean {
  return value.purpose === "external-inbound-normalized-event"
    && value.aadVersion === 1
    && (value.schemaVersion === 1 || value.schemaVersion === 2)
    && value.provider === "slack"
    && (value.environment === "test" || value.environment === "production")
    && nonEmpty(value.appRegistrationId, 64)
    && nonEmpty(value.installId, 64)
    && nonEmpty(value.workspaceId, 160)
    && nonEmpty(value.providerAuthorityId, 160)
    && nonEmpty(value.providerConversationId, 160)
    && nonEmpty(value.providerEventId, 320)
    && nonEmpty(value.bindingId, 64)
    && positiveInteger(value.bindingEpoch)
    && positiveInteger(value.connectionEpoch)
    && nonEmpty(value.runtimeRevision, 320)
    && nonEmpty(value.raftChannelId, 64)
    && (value.privacyClass === "public" || value.privacyClass === "private");
}

function encodeEnvelope(envelope: PayloadEnvelope): string {
  return `kms-envelope:v1:${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;
}

function strictBase64Url(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength === 0 || decoded.byteLength > maxBytes) return null;
  return decoded.toString("base64url") === value ? decoded : null;
}

function parseEnvelope(value: string): {
  wrappedDataKey: Buffer;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
} | null {
  const prefix = "kms-envelope:v1:";
  if (!value.startsWith(prefix)) return null;
  const serialized = strictBase64Url(value.slice(prefix.length), MAX_NORMALIZED_PAYLOAD_BYTES * 2);
  if (!serialized) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown>;
  if (!exactObjectKeys(envelope, [
    "schema",
    "algorithm",
    "wrappedDataKey",
    "iv",
    "authTag",
    "ciphertext",
  ])) return null;
  if (envelope.schema !== PAYLOAD_ENVELOPE_SCHEMA || envelope.algorithm !== "AES-256-GCM") return null;
  const wrappedDataKey = strictBase64Url(envelope.wrappedDataKey, 16 * 1_024);
  const iv = strictBase64Url(envelope.iv, 12);
  const authTag = strictBase64Url(envelope.authTag, 16);
  const ciphertext = strictBase64Url(envelope.ciphertext, MAX_NORMALIZED_PAYLOAD_BYTES + 16);
  if (!wrappedDataKey || !iv || iv.byteLength !== 12 || !authTag || authTag.byteLength !== 16 || !ciphertext) {
    return null;
  }
  return { wrappedDataKey, iv, authTag, ciphertext };
}

export interface SlackInboundPayloadCrypto {
  payloadSealer: ExternalIngressPayloadSealer;
  decryptNormalizedPayload: ExternalInboundWorkerDependencies["decryptNormalizedPayload"];
}

export function createSlackKmsInboundPayloadCrypto(input: {
  kms: AwsCommandClient;
  keyId: string;
  randomIv?: () => Buffer;
}): SlackInboundPayloadCrypto {
  if (!nonEmpty(input.keyId)) throw new Error("Slack inbound payload KMS key is required");
  const randomIv = input.randomIv ?? (() => randomBytes(12));
  return {
    payloadSealer: {
      async sealNormalizedPayload(request) {
        if (!validAad(request.aad) || !nonEmpty(request.plaintext, MAX_NORMALIZED_PAYLOAD_BYTES)) {
          throw new Error("Slack inbound payload cannot be sealed");
        }
        const generated = await input.kms.send(new GenerateDataKeyCommand({
          KeyId: input.keyId,
          KeySpec: "AES_256",
          EncryptionContext: payloadEncryptionContext(request.aad),
        })) as { Plaintext?: unknown; CiphertextBlob?: unknown; KeyId?: unknown };
        const plaintextKey = generated.Plaintext instanceof Uint8Array
          ? Buffer.from(generated.Plaintext)
          : null;
        const wrappedDataKey = generated.CiphertextBlob instanceof Uint8Array
          ? Buffer.from(generated.CiphertextBlob)
          : null;
        if (
          !plaintextKey
          || plaintextKey.byteLength !== 32
          || !wrappedDataKey
          || wrappedDataKey.byteLength === 0
          || generated.KeyId !== input.keyId
        ) {
          plaintextKey?.fill(0);
          throw new Error("Slack inbound payload data key is invalid");
        }
        try {
          const iv = randomIv();
          if (!(iv instanceof Buffer) || iv.byteLength !== 12) {
            throw new Error("Slack inbound payload IV is invalid");
          }
          const cipher = createCipheriv("aes-256-gcm", plaintextKey, iv);
          cipher.setAAD(Buffer.from(canonicalJson(request.aad), "utf8"));
          const ciphertext = Buffer.concat([
            cipher.update(request.plaintext, "utf8"),
            cipher.final(),
          ]);
          const envelope: PayloadEnvelope = {
            schema: PAYLOAD_ENVELOPE_SCHEMA,
            algorithm: "AES-256-GCM",
            wrappedDataKey: wrappedDataKey.toString("base64url"),
            iv: iv.toString("base64url"),
            authTag: cipher.getAuthTag().toString("base64url"),
            ciphertext: ciphertext.toString("base64url"),
          };
          return {
            encryptedPayload: encodeEnvelope(envelope),
            envelopeKeyId: generated.KeyId,
            aadVersion: 1,
          };
        } finally {
          plaintextKey.fill(0);
        }
      },
    },
    async decryptNormalizedPayload(request) {
      if (
        !nonEmpty(request.eventId, 64)
        || !nonEmpty(request.envelopeKeyId)
        || request.envelopeKeyId !== input.keyId
        || !validAad(request.aad as ExternalInboundPayloadAad)
        || request.signal?.aborted
      ) throw new Error("Slack inbound payload cannot be decrypted");
      const envelope = parseEnvelope(request.ciphertext);
      if (!envelope) throw new Error("Slack inbound payload envelope is invalid");
      const decrypted = await input.kms.send(new DecryptCommand({
        KeyId: request.envelopeKeyId,
        CiphertextBlob: envelope.wrappedDataKey,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: payloadEncryptionContext(request.aad as ExternalInboundPayloadAad),
      })) as { Plaintext?: unknown; KeyId?: unknown };
      const plaintextKey = decrypted.Plaintext instanceof Uint8Array
        ? Buffer.from(decrypted.Plaintext)
        : null;
      if (
        !plaintextKey
        || plaintextKey.byteLength !== 32
        || decrypted.KeyId !== request.envelopeKeyId
      ) {
        plaintextKey?.fill(0);
        throw new Error("Slack inbound payload data key is invalid");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", plaintextKey, envelope.iv);
        decipher.setAAD(Buffer.from(canonicalJson(request.aad), "utf8"));
        decipher.setAuthTag(envelope.authTag);
        const plaintext = Buffer.concat([
          decipher.update(envelope.ciphertext),
          decipher.final(),
        ]);
        if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_NORMALIZED_PAYLOAD_BYTES) {
          throw new Error("Slack inbound payload plaintext is invalid");
        }
        return plaintext.toString("utf8");
      } finally {
        plaintextKey.fill(0);
      }
    },
  };
}

export function createSlackBridgeAwsIngressCrypto(input: {
  signingSecretsManager?: AwsCommandClient;
  payloadKms?: AwsCommandClient;
  payloadKmsKeyId: string;
}): {
  secretResolver: ExternalIngressSecretResolver;
  payloadSealer: ExternalIngressPayloadSealer;
  decryptNormalizedPayload: ExternalInboundWorkerDependencies["decryptNormalizedPayload"];
} {
  const secretsManager = input.signingSecretsManager ?? new SecretsManagerClient({});
  const kms = input.payloadKms ?? new KMSClient({});
  const payloadCrypto = createSlackKmsInboundPayloadCrypto({
    kms,
    keyId: input.payloadKmsKeyId,
  });
  return {
    secretResolver: createSlackSigningSecretManagerResolver({ secretsManager }),
    ...payloadCrypto,
  };
}
