import {
  aes256KeyFromBase64Env,
  exactAes256Key,
  isWellFormedAesGcmEnvelope,
  openAesGcmEnvelope,
  sealAesGcmEnvelope,
} from "./aesGcmEnvelope";
import type { ExternalInboundWorkerDependencies } from "./externalInboundWorkerService";
import { SlackNormalizedEnvelopeInvalid } from "./slackNormalizedPayloadError";
import type {
  ExternalInboundPayloadAad,
  ExternalIngressPayloadSealer,
  ExternalIngressSecretResolver,
} from "./externalAppIngressService";
import type {
  SlackBotCredentialSealer,
  SlackOAuthAppSecretLeaseProvider,
} from "./slackProviderAdapter";

const CREDENTIAL_SCHEMA = "slack-env-credential.v1" as const;
const PAYLOAD_SCHEMA = "slack-env-inbound-payload.v1" as const;
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_PAYLOAD_BYTES = 128 * 1024;

export const SLACK_BRIDGE_SIGNING_SECRET_REF = "env:SLACK_BRIDGE_SIGNING_SECRET";
export const SLACK_BRIDGE_OAUTH_CLIENT_SECRET_REF = "env:SLACK_BRIDGE_OAUTH_CLIENT_SECRET";
export const SLACK_BRIDGE_CREDENTIAL_KEY_ID = "env:SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY:v1";
export const SLACK_BRIDGE_PAYLOAD_KEY_ID = "env:SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY:v1";

export interface SlackBridgeEnvSecretAuthority {
  registrationId: string;
  environment: "test" | "production";
  providerAppId: string;
  providerOAuthClientId: string;
  signingSecret: string;
  oauthClientSecret: string;
  credentialEncryptionKey: Buffer;
  payloadEncryptionKey: Buffer;
  payloadKeyId?: string;
  payloadDecryptionKeys?: ReadonlyMap<string, Buffer>;
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

const LABEL = "Slack Bridge";

function exactKey(value: Buffer, name: string): Buffer {
  return exactAes256Key(value, LABEL, name);
}

export function slackBridgeKeyFromEnv(value: string | undefined, name: string): Buffer {
  return aes256KeyFromBase64Env(value, LABEL, name);
}

/** The legacy env key always retains its original id for old ciphertext. */
export function slackBridgePayloadKeyringFromEnv(legacyKey: Buffer, activeId?: string, raw?: string): {
  activePayloadKey: Buffer; activePayloadKeyId: string; payloadReadKeys: ReadonlyMap<string, Buffer>;
} {
  const payloadReadKeys = new Map<string, Buffer>([[SLACK_BRIDGE_PAYLOAD_KEY_ID, exactKey(legacyKey, "payload encryption key")]]);
  if (raw?.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error("Slack Bridge payload keyring is invalid"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 15) {
      throw new Error("Slack Bridge payload keyring is invalid");
    }
    for (const [id, value] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9:_./-]{1,320}$/u.test(id) || typeof value !== "string") throw new Error("Slack Bridge payload keyring is invalid");
      const key = slackBridgeKeyFromEnv(value, "payload decryption key");
      const previous = payloadReadKeys.get(id);
      if (previous && !previous.equals(key)) throw new Error("Slack Bridge payload keyring is invalid");
      payloadReadKeys.set(id, key);
    }
  }
  if (activeId !== undefined && !/^[A-Za-z0-9:_./-]{1,320}$/u.test(activeId)) {
    throw new Error("Slack Bridge active payload key id is invalid");
  }
  const activePayloadKeyId = activeId ?? SLACK_BRIDGE_PAYLOAD_KEY_ID;
  const activePayloadKey = payloadReadKeys.get(activePayloadKeyId);
  if (!activePayloadKey) throw new Error("Slack Bridge active payload key is unavailable");
  return { activePayloadKey, activePayloadKeyId, payloadReadKeys };
}

function encrypt(input: {
  schema: string;
  plaintext: string;
  aad: unknown;
  key: Buffer;
}): string {
  return sealAesGcmEnvelope({ ...input, label: LABEL, maxPlaintextBytes: MAX_PAYLOAD_BYTES });
}

/** Only malformed framing is definite single-event corruption; a valid frame
 * that fails authentication may instead mean the runtime key has changed. */
function validNormalizedPayloadEnvelope(value: string): boolean {
  return isWellFormedAesGcmEnvelope(value, PAYLOAD_SCHEMA, MAX_PAYLOAD_BYTES);
}

function decrypt(input: {
  envelope: string;
  schema: string;
  aad: unknown;
  key: Buffer;
  maxBytes: number;
}): string | null {
  return openAesGcmEnvelope({ ...input, label: LABEL });
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
    && (value.schemaVersion === 1 || value.schemaVersion === 2 || value.schemaVersion === 3 || value.schemaVersion === 4)
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
  const payloadKeyId = authority.payloadKeyId ?? SLACK_BRIDGE_PAYLOAD_KEY_ID;
  if (!/^[A-Za-z0-9:_./-]{1,320}$/u.test(payloadKeyId)) throw new Error("Slack Bridge payload key id is invalid");
  const payloadReadKeys = new Map<string, Buffer>([[payloadKeyId, payloadKey]]);
  if ((authority.payloadDecryptionKeys?.size ?? 0) > 16) throw new Error("Slack Bridge payload keyring is invalid");
  for (const [id, candidate] of authority.payloadDecryptionKeys ?? []) {
    if (!/^[A-Za-z0-9:_./-]{1,320}$/u.test(id)) throw new Error("Slack Bridge payload keyring is invalid");
    const key = exactKey(candidate, "payload decryption key");
    if (id === payloadKeyId && !key.equals(payloadKey)) throw new Error("Slack Bridge payload keyring is invalid");
    payloadReadKeys.set(id, key);
  }
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
        envelopeKeyId: payloadKeyId,
        aadVersion: 1,
      };
    },
  };
  const decryptNormalizedPayload: ExternalInboundWorkerDependencies["decryptNormalizedPayload"] = async (request) => {
    const readKey = payloadReadKeys.get(request.envelopeKeyId);
    if (
      !readKey
      || !validPayloadAad(request.aad as ExternalInboundPayloadAad)
      || request.signal?.aborted
    ) throw new Error("Slack inbound payload cannot be decrypted");
    if (!validNormalizedPayloadEnvelope(request.ciphertext)) throw new SlackNormalizedEnvelopeInvalid();
    const plaintext = decrypt({
      envelope: request.ciphertext,
      schema: PAYLOAD_SCHEMA,
      aad: request.aad,
      key: readKey,
      maxBytes: MAX_PAYLOAD_BYTES,
    });
    if (!plaintext) throw new Error("Slack inbound payload envelope is invalid");
    return plaintext;
  };
  return { appSecrets, credentialCipher, secretResolver, payloadSealer, decryptNormalizedPayload };
}
