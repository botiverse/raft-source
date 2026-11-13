import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  isSlackVerifiedIngressAad,
  SLACK_VERIFIED_INGRESS_MAX_BYTES,
  type SlackVerifiedIngressAad,
} from "./slackVerifiedIngressContracts";

const ENVELOPE_SCHEMA = "slack-verified-ingress-aes-gcm.v1";
// One base64 encoding of a 1 MiB ciphertext, plus bounded JSON metadata.
const MAX_ENVELOPE_BYTES = 1_400_000;

type Envelope = {
  schema: typeof ENVELOPE_SCHEMA;
  iv: string;
  tag: string;
  ciphertext: string;
};

// Fixed field order means callers cannot accidentally change the AAD encoding.
export function slackVerifiedIngressAuthenticatedData(aad: SlackVerifiedIngressAad): Buffer {
  if (!isSlackVerifiedIngressAad(aad)) throw new Error("Invalid verified Slack ingress authority");
  return Buffer.from(JSON.stringify([
    aad.purpose, aad.version, aad.registrationId, aad.environment, aad.providerAppId,
    aad.providerAuthorityId, aad.providerEventId, aad.providerConversationId,
  ]), "utf8");
}

function decoded(value: unknown, expectedBytes?: number): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value && (!expectedBytes || bytes.length === expectedBytes)
    ? bytes : null;
}

/** Encrypt verified, credential-stripped event bytes with a provider-supplied key. */
export function sealSlackVerifiedIngress(input: {
  bytes: Buffer;
  key: Buffer;
  aad: SlackVerifiedIngressAad;
}): string {
  if (!Buffer.isBuffer(input.key) || input.key.length !== 32
    || !Buffer.isBuffer(input.bytes) || input.bytes.length === 0
    || input.bytes.length > SLACK_VERIFIED_INGRESS_MAX_BYTES) {
    throw new Error("Invalid verified Slack ingress payload");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(slackVerifiedIngressAuthenticatedData(input.aad));
  const ciphertext = Buffer.concat([cipher.update(input.bytes), cipher.final()]);
  const envelope: Envelope = {
    schema: ENVELOPE_SCHEMA,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return JSON.stringify(envelope);
}

/** Authenticate before returning bytes; never return partially decrypted data. */
export function openSlackVerifiedIngress(input: {
  envelope: string;
  key: Buffer;
  aad: SlackVerifiedIngressAad;
}): Buffer {
  if (!Buffer.isBuffer(input.key) || input.key.length !== 32
    || typeof input.envelope !== "string"
    || Buffer.byteLength(input.envelope, "utf8") > MAX_ENVELOPE_BYTES) {
    throw new Error("Invalid verified Slack ingress envelope");
  }
  try {
    const parsed: unknown = JSON.parse(input.envelope);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const envelope = parsed as Record<string, unknown>;
    if (Object.keys(envelope).sort().join(",") !== "ciphertext,iv,schema,tag"
      || envelope.schema !== ENVELOPE_SCHEMA) throw new Error();
    const iv = decoded(envelope.iv, 12);
    const tag = decoded(envelope.tag, 16);
    const ciphertext = decoded(envelope.ciphertext);
    if (!iv || !tag || !ciphertext || ciphertext.length > SLACK_VERIFIED_INGRESS_MAX_BYTES) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", input.key, iv);
    decipher.setAAD(slackVerifiedIngressAuthenticatedData(input.aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Invalid verified Slack ingress envelope");
  }
}

/** Reject malformed or plaintext provider receipts before they enter custody. */
export function isSlackVerifiedIngressEnvelope(value: unknown): value is string {
  return validEnvelope(value, true);
}

function validEnvelope(value: unknown, allowWrapper: boolean): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1_500_000) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const row = parsed as Record<string, unknown>;
  if (row.schema === "slack-verified-ingress-kms.v1") {
    if (!allowWrapper || Object.keys(row).sort().join(",") !== "payload,schema,wrappedKey" || typeof row.payload !== "string"
      || typeof row.wrappedKey !== "string" || row.wrappedKey.length > Math.ceil(16_384 * 4 / 3)) return false;
    const wrapped = decoded(row.wrappedKey);
    return Boolean(wrapped && wrapped.length <= 16_384 && validEnvelope(row.payload, false));
  }
  if (row.schema !== ENVELOPE_SCHEMA || Object.keys(row).sort().join(",") !== "ciphertext,iv,schema,tag") return false;
  const iv = decoded(row.iv, 12);
  const tag = decoded(row.tag, 16);
  const ciphertext = decoded(row.ciphertext);
  return Boolean(iv && tag && ciphertext && ciphertext.length <= SLACK_VERIFIED_INGRESS_MAX_BYTES);
}
