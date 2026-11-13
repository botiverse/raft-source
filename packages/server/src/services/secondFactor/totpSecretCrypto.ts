/**
 * TOTP secrets at rest (`user_totp.secret_ciphertext`): AES-256-GCM under a
 * dedicated app key, the person's id as AAD so a ciphertext copied onto
 * another person's row does not decrypt. Same shape as the other stored
 * secrets (agentRuntimeProviderService, managedMcpCredentialService,
 * appWebhookConfigService): a base64 32-byte key from the environment, a
 * versioned `v1:<iv>:<tag>:<ciphertext>` payload.
 *
 * The repo has no shared envelope helper: each store keeps its own key, so a
 * leak of one key exposes one kind of secret. Used by the management routes
 * (management.ts; 503 `second_factor_unavailable` without it): the key must be
 * provisioned on every deployment that serves two-step verification.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const TOTP_SECRET_KEY_ENV = "RAFT_TOTP_SECRET_ENCRYPTION_KEY";
const PAYLOAD_VERSION = "v1";

export class TotpSecretCryptoError extends Error {
  constructor(message: string, readonly code: "totp_secret_key_missing" | "totp_secret_invalid") {
    super(message);
    this.name = "TotpSecretCryptoError";
  }
}

function secretKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env[TOTP_SECRET_KEY_ENV]?.trim();
  if (!raw) throw new TotpSecretCryptoError(`${TOTP_SECRET_KEY_ENV} must be configured before storing TOTP secrets`, "totp_secret_key_missing");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new TotpSecretCryptoError(`${TOTP_SECRET_KEY_ENV} must be a base64-encoded 32-byte key`, "totp_secret_key_missing");
  return key;
}

function aad(userId: string): Buffer {
  return Buffer.from(`user_totp:${userId}`, "utf8");
}

export function encryptTotpSecret(secret: string, userId: string, env: NodeJS.ProcessEnv = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(env), iv);
  cipher.setAAD(aad(userId));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [PAYLOAD_VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptTotpSecret(payload: string, userId: string, env: NodeJS.ProcessEnv = process.env): string {
  const [version, iv, tag, encrypted, extra] = payload.split(":");
  if (version !== PAYLOAD_VERSION || !iv || !tag || !encrypted || extra !== undefined) {
    throw new TotpSecretCryptoError("Stored TOTP secret is invalid", "totp_secret_invalid");
  }
  const decipher = createDecipheriv("aes-256-gcm", secretKey(env), Buffer.from(iv, "base64url"));
  decipher.setAAD(aad(userId));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new TotpSecretCryptoError("Stored TOTP secret cannot be decrypted", "totp_secret_invalid");
  }
}
