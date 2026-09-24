import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { ExternalInboundWorkerDependencies } from "./externalInboundWorkerService.js";
import type {
  ExternalInboundPayloadAad,
  ExternalIngressPayloadSealer,
  ExternalIngressSecretResolver,
} from "./externalAppIngressService.js";
import type {
  SlackBotCredentialSealer,
  SlackOAuthAppSecretLeaseProvider,
} from "./slackProviderAdapter.js";

const CREDENTIAL_SCHEMA = "slack-env-credential.v1" as const;
const PAYLOAD_SCHEMA = "slack-env-inbound-payload.v1" as const;
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_PAYLOAD_BYTES = 128 * 1024;

export const SLACK_BRIDGE_SIGNING_SECRET_REF = "env:SLACK_BRIDGE_SIGNING_SECRET";
export const SLACK_BRIDGE_OAUTH_CLIENT_SECRET_REF = "env:SLACK_BRIDGE_OAUTH_CLIENT_SECRET";
export const SLACK_BRIDGE_CREDENTIAL_KEY_ID = "env:SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY:v1";
export const SLACK_BRIDGE_PAYLOAD_KEY_ID = "env:SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY:v1";

interface EncryptedEnvelope {
  schema: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface SlackBridgeEnvSecretAuthority {
  registrationId: string;
  environment: "test" | "production";
  providerAppId: string;
  providerOAuthClientId: string;
  signingSecret: string;
  oauthClientSecret: string;
  credentialEncryptionKey: Buffer;
  payloadEncryptionKey: Buffer;
}

export interface SlackBridgeCredentialCipher {
  sealer: SlackBotCredentialSealer;
  unseal(input: {
    serverId: string;
    providerAppId: string;
    providerTeamId: string;
    botUserId: string;
    encryptedMaterial: string;
    envelopeKeyId: string;
    aadVersion: number;
  }): { accessToken: string; tokenType: "bot" } | null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Slack Bridge AAD contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("Slack Bridge AAD contains an unsupported value");
}

function nonEmpty(value: unknown, max = 2_048): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !/[\r\n\0]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= max;
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= max;
}

function exactKey(value: Buffer, name: string): Buffer {
  if (!Buffer.isBuffer(value) || value.byteLength !== 32) {
    throw new Error(`Slack Bridge ${name} must be a 32-byte key`);
  }
  return Buffer.from(value);
}

export function slackBridgeKeyFromEnv(value: string | undefined, name: string): Buffer {
  const raw = value?.trim();
  if (!raw) throw new Error(`Slack Bridge requires ${name}`);
  const key = Buffer.from(raw, "base64");
  if (
    key.byteLength !== 32
    || key.toString("base64").replace(/=+$/u, "") !== raw.replace(/=+$/u, "")
  ) throw new Error(`Slack Bridge ${name} must be a base64-encoded 32-byte key`);
  return key;
}

function encrypt(input: {
  schema: string;
  plaintext: string;
  aad: unknown;
  key: Buffer;
}): string {
  if (!input.plaintext || Buffer.byteLength(input.plaintext, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Slack Bridge plaintext is invalid");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(Buffer.from(canonicalJson(input.aad), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    schema: input.schema,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return `env-aes-256-gcm:v1:${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;
}

function strictBytes(value: unknown, expectedBytes?: number): Buffer | null {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value || (expectedBytes && decoded.byteLength !== expectedBytes)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function decrypt(input: {
  envelope: string;
  schema: string;
  aad: unknown;
  key: Buffer;
  maxBytes: number;
}): string | null {
  const prefix = "env-aes-256-gcm:v1:";
  if (!input.envelope.startsWith(prefix)) return null;
  const encoded = strictBytes(input.envelope.slice(prefix.length));
  if (!encoded || encoded.byteLength > input.maxBytes * 2) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  if (
    Object.keys(body).sort().join(",") !== "authTag,ciphertext,iv,schema"
    || body.schema !== input.schema
  ) return null;
  const iv = strictBytes(body.iv, 12);
  const authTag = strictBytes(body.authTag, 16);
  const ciphertext = strictBytes(body.ciphertext);
  if (!iv || !authTag || !ciphertext || ciphertext.byteLength === 0 || ciphertext.byteLength > input.maxBytes) {
    return null;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", input.key, iv);
    decipher.setAAD(Buffer.from(canonicalJson(input.aad), "utf8"));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength === 0 || plaintext.byteLength > input.maxBytes) return null;
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

function credentialAad(input: {
  serverId: string;
  providerAppId: string;
  providerTeamId: string;
  botUserId: string;
}) {
  return {
    purpose: "slack_bot_credential",
    aadVersion: 1,
    serverId: input.serverId,
    providerAppId: input.providerAppId,
    providerTeamId: input.providerTeamId,
    botUserId: input.botUserId,
  } as const;
}

function validPayloadAad(value: ExternalInboundPayloadAad): boolean {
  return value.purpose === "external-inbound-normalized-event"
    && value.aadVersion === 1
    && (value.schemaVersion === 1 || value.schemaVersion === 2 || value.schemaVersion === 3)
    && value.provider === "slack"
    && (value.environment === "test" || value.environment === "production")
    && nonEmpty(value.appRegistrationId)
    && nonEmpty(value.installId)
    && nonEmpty(value.workspaceId)
    && nonEmpty(value.providerAuthorityId)
    && nonEmpty(value.providerConversationId)
    && nonEmpty(value.providerEventId)
    && nonEmpty(value.bindingId)
    && Number.isSafeInteger(value.bindingEpoch) && value.bindingEpoch > 0
    && Number.isSafeInteger(value.connectionEpoch) && value.connectionEpoch > 0
    && nonEmpty(value.runtimeRevision)
    && nonEmpty(value.raftChannelId)
    && (value.privacyClass === "public" || value.privacyClass === "private");
}

export function createSlackBridgeEnvCredentialCipher(input: {
  key: Buffer;
}): SlackBridgeCredentialCipher {
  const key = exactKey(input.key, "credential encryption key");
  return {
    sealer: {
      async seal(request) {
        const plaintext = JSON.stringify({ accessToken: request.accessToken, tokenType: "bot" });
        if (
          !nonEmpty(request.serverId)
          || !nonEmpty(request.accessToken, MAX_SECRET_BYTES)
          || request.tokenType !== "bot"
          || !nonEmpty(request.providerAppId)
          || !nonEmpty(request.providerTeamId)
          || !nonEmpty(request.botUserId)
          || !Number.isFinite(request.now.getTime())
          || Buffer.byteLength(plaintext, "utf8") > MAX_SECRET_BYTES
        ) throw new Error("Slack bot credential authority is invalid");
        return {
          encryptedMaterial: encrypt({
            schema: CREDENTIAL_SCHEMA,
            plaintext,
            aad: credentialAad(request),
            key,
          }),
          envelopeKeyId: SLACK_BRIDGE_CREDENTIAL_KEY_ID,
          aadVersion: 1,
          expiresAt: null,
        };
      },
    },
    unseal(request) {
      if (
        request.envelopeKeyId !== SLACK_BRIDGE_CREDENTIAL_KEY_ID
        || request.aadVersion !== 1
        || !nonEmpty(request.serverId)
        || !nonEmpty(request.providerAppId)
        || !nonEmpty(request.providerTeamId)
        || !nonEmpty(request.botUserId)
      ) return null;
      const plaintext = decrypt({
        envelope: request.encryptedMaterial,
        schema: CREDENTIAL_SCHEMA,
        aad: credentialAad(request),
        key,
        maxBytes: MAX_SECRET_BYTES,
      });
      if (!plaintext) return null;
      try {
        const parsed = JSON.parse(plaintext) as Record<string, unknown>;
        if (
          Object.keys(parsed).sort().join(",") !== "accessToken,tokenType"
          || !nonEmpty(parsed.accessToken, MAX_SECRET_BYTES)
          || parsed.tokenType !== "bot"
        ) return null;
        return { accessToken: parsed.accessToken, tokenType: "bot" };
      } catch {
        return null;
      }
    },
  };
}

export function createSlackBridgeEnvSecretBackends(
  authority: SlackBridgeEnvSecretAuthority,
): {
  appSecrets: SlackOAuthAppSecretLeaseProvider;
  credentialCipher: SlackBridgeCredentialCipher;
  secretResolver: ExternalIngressSecretResolver;
  payloadSealer: ExternalIngressPayloadSealer;
  decryptNormalizedPayload: ExternalInboundWorkerDependencies["decryptNormalizedPayload"];
} {
  if (
    !nonEmpty(authority.registrationId)
    || !nonEmpty(authority.providerAppId)
    || !nonEmpty(authority.providerOAuthClientId)
    || !nonEmpty(authority.signingSecret, MAX_SECRET_BYTES)
    || !nonEmpty(authority.oauthClientSecret, MAX_SECRET_BYTES)
  ) throw new Error("Slack Bridge env secret authority is invalid");
  const credentialCipher = createSlackBridgeEnvCredentialCipher({ key: authority.credentialEncryptionKey });
  const payloadKey = exactKey(authority.payloadEncryptionKey, "payload encryption key");
  const appSecrets: SlackOAuthAppSecretLeaseProvider = {
    async lease(request) {
      if (
        request.registrationId !== authority.registrationId
        || request.providerAppId !== authority.providerAppId
        || request.providerOAuthClientId !== authority.providerOAuthClientId
        || request.environment !== authority.environment
        || request.audience !== "slack-oauth-exchange"
        || !nonEmpty(request.attemptId)
        || !Number.isFinite(request.now.getTime())
      ) return null;
      return {
        providerOAuthClientId: authority.providerOAuthClientId,
        clientSecret: authority.oauthClientSecret,
        expiresAt: new Date(request.now.getTime() + 60_000),
      };
    },
  };
  const secretResolver: ExternalIngressSecretResolver = {
    async resolveSigningSecret(request) {
      if (
        request.registrationId !== authority.registrationId
        || request.environment !== authority.environment
        || request.encryptedSecretRef !== SLACK_BRIDGE_SIGNING_SECRET_REF
        || request.envelopeKeyId !== "env:process"
        || request.aadVersion !== 1
        || request.secretRevision !== 1
      ) throw new Error("Slack signing-secret env authority is mismatched");
      return authority.signingSecret;
    },
  };
  const payloadSealer: ExternalIngressPayloadSealer = {
    async sealNormalizedPayload(request) {
      if (!validPayloadAad(request.aad) || !boundedText(request.plaintext, MAX_PAYLOAD_BYTES)) {
        throw new Error("Slack inbound payload cannot be sealed");
      }
      return {
        encryptedPayload: encrypt({
          schema: PAYLOAD_SCHEMA,
          plaintext: request.plaintext,
          aad: request.aad,
          key: payloadKey,
        }),
        envelopeKeyId: SLACK_BRIDGE_PAYLOAD_KEY_ID,
        aadVersion: 1,
      };
    },
  };
  const decryptNormalizedPayload: ExternalInboundWorkerDependencies["decryptNormalizedPayload"] = async (request) => {
    if (
      request.envelopeKeyId !== SLACK_BRIDGE_PAYLOAD_KEY_ID
      || !validPayloadAad(request.aad as ExternalInboundPayloadAad)
      || request.signal?.aborted
    ) throw new Error("Slack inbound payload cannot be decrypted");
    const plaintext = decrypt({
      envelope: request.ciphertext,
      schema: PAYLOAD_SCHEMA,
      aad: request.aad,
      key: payloadKey,
      maxBytes: MAX_PAYLOAD_BYTES,
    });
    if (!plaintext) throw new Error("Slack inbound payload envelope is invalid");
    return plaintext;
  };
  return { appSecrets, credentialCipher, secretResolver, payloadSealer, decryptNormalizedPayload };
}
