/**
 * The OIDC client secret of a Server's SSO connection at rest
 * (rfcs/083-server-sso.md §4): the shared AES-256-GCM envelope under its own
 * key, so a leak of another store's key exposes no SSO secret. The connection
 * and its Server are the AAD: a ciphertext copied onto another connection
 * does not open.
 *
 * Stored as `<key id>:<envelope>`. The key id (a short hash of the key, not
 * the key) names which key sealed it, so a read picks that key and a
 * rotation knows what is left to re-seal.
 *
 * Rotation: put the new key in RAFT_SSO_SECRET_ENCRYPTION_KEY and the old one
 * in RAFT_SSO_SECRET_ENCRYPTION_KEY_PREVIOUS, run
 * resealServerSsoConnectionSecrets() (ssoConnections.ts), then drop the old key.
 */
import { createHash } from "node:crypto";
import { aes256KeyFromBase64Env, openAesGcmEnvelope, sealAesGcmEnvelope } from "../aesGcmEnvelope";

export const SSO_SECRET_KEY_ENV = "RAFT_SSO_SECRET_ENCRYPTION_KEY";
export const SSO_SECRET_PREVIOUS_KEY_ENV = "RAFT_SSO_SECRET_ENCRYPTION_KEY_PREVIOUS";
const LABEL = "SSO connection secret";
const SCHEMA = "raft.sso.client_secret.v1";
const MAX_SECRET_BYTES = 4096;
const KEY_ID_PATTERN = /^([0-9a-f]{16}):(.+)$/su;

export class SsoSecretUnavailableError extends Error {
  constructor() {
    super(`${SSO_SECRET_KEY_ENV} must be configured before storing SSO client secrets`);
    this.name = "SsoSecretUnavailableError";
  }
}

type SecretScope = { connectionId: string; serverId: string };

function aad(scope: SecretScope) {
  return { kind: "server_sso_connection", connectionId: scope.connectionId, serverId: scope.serverId };
}

/** A key from env, or SsoSecretUnavailableError when it is missing or malformed. */
function keyFromEnv(env: NodeJS.ProcessEnv, name: string): Buffer {
  if (!env[name]?.trim()) throw new SsoSecretUnavailableError();
  try {
    return aes256KeyFromBase64Env(env[name], LABEL, name);
  } catch {
    throw new SsoSecretUnavailableError();
  }
}

function keyId(key: Buffer): string {
  return createHash("sha256").update("raft-sso-secret-key-id:").update(key).digest("hex").slice(0, 16);
}

function currentKey(env: NodeJS.ProcessEnv): Buffer {
  return keyFromEnv(env, SSO_SECRET_KEY_ENV);
}

export function isSsoSecretStoreConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    currentKey(env);
    return true;
  } catch {
    return false;
  }
}

export function sealSsoClientSecret(secret: string, scope: SecretScope, env: NodeJS.ProcessEnv = process.env): string {
  const key = currentKey(env);
  const envelope = sealAesGcmEnvelope({
    label: LABEL,
    schema: SCHEMA,
    plaintext: secret,
    aad: aad(scope),
    key,
    maxPlaintextBytes: MAX_SECRET_BYTES,
  });
  return `${keyId(key)}:${envelope}`;
}

/** Whether the current key sealed it (nothing to re-seal). */
export function isSealedUnderCurrentKey(stored: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const match = KEY_ID_PATTERN.exec(stored);
  return !!match && match[1] === keyId(currentKey(env));
}

/** The secret, or null when the key that sealed it is not configured or it does not open for this connection. */
export function openSsoClientSecret(stored: string, scope: SecretScope, env: NodeJS.ProcessEnv = process.env): string | null {
  const match = KEY_ID_PATTERN.exec(stored);
  if (!match) return null;
  const [, id, envelope] = match;
  const current = currentKey(env);
  let key: Buffer | null = null;
  if (keyId(current) === id) key = current;
  else if (env[SSO_SECRET_PREVIOUS_KEY_ENV]?.trim()) {
    const previous = keyFromEnv(env, SSO_SECRET_PREVIOUS_KEY_ENV);
    if (keyId(previous) === id) key = previous;
  }
  if (!key) return null;
  return openAesGcmEnvelope({ label: LABEL, envelope: envelope!, schema: SCHEMA, aad: aad(scope), key, maxBytes: MAX_SECRET_BYTES });
}

/** Re-sealed under the current key, or null when no configured key opens it. */
export function resealSsoClientSecret(stored: string, scope: SecretScope, env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = openSsoClientSecret(stored, scope, env);
  return secret === null ? null : sealSsoClientSecret(secret, scope, env);
}
