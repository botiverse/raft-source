import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// The AES-256-GCM envelope Raft's env-keyed bridge ciphers share (the Slack
// Bridge's credential and payload ciphers, the WeChat bridge's credential
// cipher): `env-aes-256-gcm:v1:<base64url(JSON {schema, iv, authTag,
// ciphertext})>`, with the AAD as canonical JSON (sorted keys) so the same
// authority always authenticates the same bytes. `label` only names the owner
// in error messages ("Slack Bridge ...").

const ENVELOPE_PREFIX = "env-aes-256-gcm:v1:";
const ENVELOPE_KEYS = "authTag,ciphertext,iv,schema";

interface EncryptedEnvelope {
  schema: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

/** Sorted-key JSON; refuses values that have no single canonical form. */
export function canonicalAadJson(value: unknown, label: string): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} AAD contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalAadJson(item, label)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalAadJson(item, label)}`).join(",")}}`;
  }
  throw new Error(`${label} AAD contains an unsupported value`);
}

/** A copy of a 32-byte key, or throws `<label> <name> must be a 32-byte key`. */
export function exactAes256Key(value: Buffer, label: string, name: string): Buffer {
  if (!Buffer.isBuffer(value) || value.byteLength !== 32) {
    throw new Error(`${label} ${name} must be a 32-byte key`);
  }
  return Buffer.from(value);
}

/** A 32-byte key from canonical base64 env text (`openssl rand -base64 32`). */
export function aes256KeyFromBase64Env(value: string | undefined, label: string, name: string): Buffer {
  const raw = value?.trim();
  if (!raw) throw new Error(`${label} requires ${name}`);
  const key = Buffer.from(raw, "base64");
  if (
    key.byteLength !== 32
    || key.toString("base64").replace(/=+$/u, "") !== raw.replace(/=+$/u, "")
  ) throw new Error(`${label} ${name} must be a base64-encoded 32-byte key`);
  return key;
}

/** Canonical unpadded base64url only (optionally exactly `expectedBytes` long). */
export function strictBase64UrlBytes(value: unknown, expectedBytes?: number): Buffer | null {
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

export function sealAesGcmEnvelope(input: {
  label: string;
  schema: string;
  plaintext: string;
  aad: unknown;
  key: Buffer;
  maxPlaintextBytes: number;
}): string {
  if (!input.plaintext || Buffer.byteLength(input.plaintext, "utf8") > input.maxPlaintextBytes) {
    throw new Error(`${input.label} plaintext is invalid`);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(Buffer.from(canonicalAadJson(input.aad, input.label), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    schema: input.schema,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return `${ENVELOPE_PREFIX}${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;
}

function parseEnvelopeBody(envelope: string, maxBytes: number): Record<string, unknown> | null {
  if (!envelope.startsWith(ENVELOPE_PREFIX)) return null;
  const encoded = strictBase64UrlBytes(envelope.slice(ENVELOPE_PREFIX.length));
  if (!encoded || encoded.byteLength > maxBytes * 2) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Whether `envelope` is well-formed framing for `schema`, without
 * authenticating it: a malformed frame is definite corruption, while a frame
 * that fails authentication may instead mean the key changed.
 */
export function isWellFormedAesGcmEnvelope(envelope: string, schema: string, maxBytes: number): boolean {
  const body = parseEnvelopeBody(envelope, maxBytes);
  if (!body) return false;
  const ciphertext = strictBase64UrlBytes(body.ciphertext);
  return Object.keys(body).sort().join(",") === ENVELOPE_KEYS
    && body.schema === schema && !!strictBase64UrlBytes(body.iv, 12) && !!strictBase64UrlBytes(body.authTag, 16)
    && !!ciphertext && ciphertext.byteLength <= maxBytes;
}

/** The plaintext, or null for anything that is not this schema's envelope authenticated under this key and AAD. */
export function openAesGcmEnvelope(input: {
  label: string;
  envelope: string;
  schema: string;
  aad: unknown;
  key: Buffer;
  maxBytes: number;
}): string | null {
  const body = parseEnvelopeBody(input.envelope, input.maxBytes);
  if (!body) return null;
  if (
    Object.keys(body).sort().join(",") !== ENVELOPE_KEYS
    || body.schema !== input.schema
  ) return null;
  const iv = strictBase64UrlBytes(body.iv, 12);
  const authTag = strictBase64UrlBytes(body.authTag, 16);
  const ciphertext = strictBase64UrlBytes(body.ciphertext);
  if (!iv || !authTag || !ciphertext || ciphertext.byteLength === 0 || ciphertext.byteLength > input.maxBytes) {
    return null;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", input.key, iv);
    decipher.setAAD(Buffer.from(canonicalAadJson(input.aad, input.label), "utf8"));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength === 0 || plaintext.byteLength > input.maxBytes) return null;
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}
