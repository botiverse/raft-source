import {
  aes256KeyFromBase64Env,
  exactAes256Key,
  openAesGcmEnvelope,
  sealAesGcmEnvelope,
} from "./aesGcmEnvelope";
import type { ILinkBotId, ILinkBotToken } from "./wechatILinkClient";

// The WeChat bridge's bot tokens at rest (wechat_bridge_bindings): an
// AES-256-GCM envelope (aesGcmEnvelope.ts, the Slack Bridge's format) under the
// env key WECHAT_BRIDGE_CREDENTIAL_ENCRYPTION_KEY (32 random bytes, base64),
// named by WECHAT_BRIDGE_CREDENTIAL_KEY_ID (default
// `env:WECHAT_BRIDGE_CREDENTIAL_ENCRYPTION_KEY:v1`). The AAD binds a token to
// its binding row, its owner and its bot, so a ciphertext copied onto another
// row does not open. Rotating the key means a new key id: tokens sealed under
// another id no longer open (unseal answers null) and their owners scan again.
// No key configured: the bridge is unavailable (wechatBridgeCredentialCipher()
// answers null).

export const WECHAT_BRIDGE_CREDENTIAL_KEY_ENV = "WECHAT_BRIDGE_CREDENTIAL_ENCRYPTION_KEY";
export const WECHAT_BRIDGE_CREDENTIAL_KEY_ID_ENV = "WECHAT_BRIDGE_CREDENTIAL_KEY_ID";
export const WECHAT_BRIDGE_DEFAULT_CREDENTIAL_KEY_ID = `env:${WECHAT_BRIDGE_CREDENTIAL_KEY_ENV}:v1`;
export const WECHAT_BRIDGE_CREDENTIAL_AAD_VERSION = 1;

const LABEL = "WeChat bridge";
const CREDENTIAL_SCHEMA = "wechat-env-credential.v1";
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_ID_BYTES = 2_048;
const KEY_ID_PATTERN = /^[A-Za-z0-9:_./-]{1,320}$/u;

/** What a sealed token is bound to; every field must match to open it. */
export interface WeChatBotCredentialAuthority {
  bindingId: string;
  userId: string;
  ilinkBotId: ILinkBotId;
}

export interface SealedWeChatBotCredential {
  encryptedBotToken: string;
  envelopeKeyId: string;
  aadVersion: number;
}

export interface WeChatBridgeCredentialCipher {
  readonly keyId: string;
  seal(input: WeChatBotCredentialAuthority & { botToken: ILinkBotToken }): SealedWeChatBotCredential;
  /** The token, or null for anything that does not open under this key, key id and authority. */
  unseal(input: WeChatBotCredentialAuthority & SealedWeChatBotCredential): ILinkBotToken | null;
}

function boundedId(value: unknown, max = MAX_ID_BYTES): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !/[\r\n\0]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= max;
}

function validAuthority(input: WeChatBotCredentialAuthority): boolean {
  return boundedId(input.bindingId) && boundedId(input.userId) && boundedId(input.ilinkBotId);
}

function credentialAad(input: WeChatBotCredentialAuthority) {
  return {
    purpose: "wechat_bot_credential",
    aadVersion: WECHAT_BRIDGE_CREDENTIAL_AAD_VERSION,
    bindingId: input.bindingId,
    userId: input.userId,
    ilinkBotId: input.ilinkBotId,
  } as const;
}

export function createWeChatBridgeCredentialCipher(input: { key: Buffer; keyId: string }): WeChatBridgeCredentialCipher {
  const key = exactAes256Key(input.key, LABEL, "credential encryption key");
  if (!KEY_ID_PATTERN.test(input.keyId)) throw new Error(`${LABEL} credential key id is invalid`);
  const keyId = input.keyId;
  return {
    keyId,
    seal(request) {
      if (!validAuthority(request) || !boundedId(request.botToken, MAX_SECRET_BYTES)) {
        throw new Error(`${LABEL} bot credential authority is invalid`);
      }
      return {
        encryptedBotToken: sealAesGcmEnvelope({
          label: LABEL,
          schema: CREDENTIAL_SCHEMA,
          plaintext: JSON.stringify({ botToken: request.botToken }),
          aad: credentialAad(request),
          key,
          maxPlaintextBytes: MAX_SECRET_BYTES + 64,
        }),
        envelopeKeyId: keyId,
        aadVersion: WECHAT_BRIDGE_CREDENTIAL_AAD_VERSION,
      };
    },
    unseal(request) {
      if (
        request.envelopeKeyId !== keyId
        || request.aadVersion !== WECHAT_BRIDGE_CREDENTIAL_AAD_VERSION
        || !validAuthority(request)
        || typeof request.encryptedBotToken !== "string"
      ) return null;
      const plaintext = openAesGcmEnvelope({
        label: LABEL,
        envelope: request.encryptedBotToken,
        schema: CREDENTIAL_SCHEMA,
        aad: credentialAad(request),
        key,
        maxBytes: MAX_SECRET_BYTES + 64,
      });
      if (!plaintext) return null;
      try {
        const parsed = JSON.parse(plaintext) as Record<string, unknown>;
        if (Object.keys(parsed).join(",") !== "botToken" || !boundedId(parsed.botToken, MAX_SECRET_BYTES)) return null;
        return parsed.botToken as ILinkBotToken;
      } catch {
        return null;
      }
    },
  };
}

let cached: { raw: string; keyId: string; cipher: WeChatBridgeCredentialCipher | null } | null = null;

/**
 * The deployment's cipher, or null when WECHAT_BRIDGE_CREDENTIAL_ENCRYPTION_KEY
 * is missing or malformed (or the key id is): the bridge is then unavailable
 * everywhere. Rebuilt whenever the env changes.
 */
export function wechatBridgeCredentialCipher(env: NodeJS.ProcessEnv = process.env): WeChatBridgeCredentialCipher | null {
  const raw = env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV]?.trim() ?? "";
  const keyId = env[WECHAT_BRIDGE_CREDENTIAL_KEY_ID_ENV]?.trim() || WECHAT_BRIDGE_DEFAULT_CREDENTIAL_KEY_ID;
  if (cached && cached.raw === raw && cached.keyId === keyId) return cached.cipher;
  let cipher: WeChatBridgeCredentialCipher | null = null;
  if (raw) {
    try {
      cipher = createWeChatBridgeCredentialCipher({ key: aes256KeyFromBase64Env(raw, LABEL, WECHAT_BRIDGE_CREDENTIAL_KEY_ENV), keyId });
    } catch (err) {
      console.error(`[wechat-bridge] credential key unusable, bridge unavailable: ${err instanceof Error ? err.message : "invalid"}`);
    }
  }
  cached = { raw, keyId, cipher };
  return cipher;
}
