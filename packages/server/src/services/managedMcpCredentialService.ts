import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const CREDENTIAL_KEY_ENV = "SLOCK_MCP_CREDENTIAL_KEY";
const CREDENTIAL_VERSION = "v1";
const MAX_CREDENTIAL_HEADERS = 64;
const MAX_CREDENTIAL_HEADER_VALUE_BYTES = 16 * 1024;
const MAX_CREDENTIAL_HEADERS_BYTES = 64 * 1024;
const MAX_ENCRYPTED_SECRET_BYTES = 256 * 1024;
const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class ManagedMcpCredentialError extends Error {
  constructor(
    message: string,
    readonly code: "managed_mcp_credential_key_missing" | "managed_mcp_credential_invalid",
  ) {
    super(message);
    this.name = "ManagedMcpCredentialError";
  }
}

function credentialKey(): Buffer {
  const raw = process.env[CREDENTIAL_KEY_ENV]?.trim();
  if (!raw) {
    throw new ManagedMcpCredentialError(
      `${CREDENTIAL_KEY_ENV} must be configured before storing managed MCP credentials`,
      "managed_mcp_credential_key_missing",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/u, "") !== raw.replace(/=+$/u, "")) {
    throw new ManagedMcpCredentialError(
      `${CREDENTIAL_KEY_ENV} must be a base64-encoded 32-byte key`,
      "managed_mcp_credential_key_missing",
    );
  }
  return key;
}

export function normalizeManagedMcpHeaders(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ManagedMcpCredentialError("Credential headers must be an object", "managed_mcp_credential_invalid");
  }
  const headers: Record<string, string> = {};
  const seenNames = new Set<string>();
  let totalBytes = 0;
  if (Object.keys(input).length > MAX_CREDENTIAL_HEADERS) {
    throw new ManagedMcpCredentialError("Too many credential headers", "managed_mcp_credential_invalid");
  }
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.trim();
    const normalizedName = name.toLowerCase();
    if (!name || name.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) {
      throw new ManagedMcpCredentialError("Credential header name is invalid", "managed_mcp_credential_invalid");
    }
    if (seenNames.has(normalizedName) || FORBIDDEN_CREDENTIAL_HEADERS.has(normalizedName)) {
      throw new ManagedMcpCredentialError(`Credential header ${name} is not allowed`, "managed_mcp_credential_invalid");
    }
    if (
      typeof rawValue !== "string"
      || !rawValue.trim()
      || /[\r\n]/u.test(rawValue)
      || Buffer.byteLength(rawValue, "utf8") > MAX_CREDENTIAL_HEADER_VALUE_BYTES
    ) {
      throw new ManagedMcpCredentialError(`Credential value for ${name} is invalid`, "managed_mcp_credential_invalid");
    }
    totalBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(rawValue, "utf8");
    if (totalBytes > MAX_CREDENTIAL_HEADERS_BYTES) {
      throw new ManagedMcpCredentialError("Credential headers exceed the size limit", "managed_mcp_credential_invalid");
    }
    seenNames.add(normalizedName);
    headers[name] = rawValue;
  }
  return headers;
}

export function encryptManagedMcpSecret(value: unknown): string {
  const plaintext = JSON.stringify(value);
  if (Buffer.byteLength(plaintext, "utf8") > MAX_ENCRYPTED_SECRET_BYTES) {
    throw new ManagedMcpCredentialError("Managed MCP secret exceeds the size limit", "managed_mcp_credential_invalid");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    CREDENTIAL_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

export function decryptManagedMcpSecret(payload: string): unknown {
  const [version, ivEncoded, tagEncoded, encryptedEncoded, extra] = payload.split(":");
  if (version !== CREDENTIAL_VERSION || !ivEncoded || !tagEncoded || !encryptedEncoded || extra !== undefined) {
    throw new ManagedMcpCredentialError("Stored managed MCP credentials are invalid", "managed_mcp_credential_invalid");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", credentialKey(), Buffer.from(ivEncoded, "base64url"));
    decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedEncoded, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as unknown;
  } catch (error) {
    if (error instanceof ManagedMcpCredentialError && error.code === "managed_mcp_credential_key_missing") throw error;
    throw new ManagedMcpCredentialError("Stored managed MCP credentials could not be decrypted", "managed_mcp_credential_invalid");
  }
}

export function encryptManagedMcpHeaders(headers: Record<string, string>): string {
  return encryptManagedMcpSecret(normalizeManagedMcpHeaders(headers));
}

export function decryptManagedMcpHeaders(payload: string | null | undefined): Record<string, string> {
  if (!payload) return {};
  return normalizeManagedMcpHeaders(decryptManagedMcpSecret(payload));
}
