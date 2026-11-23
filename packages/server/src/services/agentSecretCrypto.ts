/**
 * Encryption at rest for customer secrets stored on the `agents` table
 * (#proj-runtime:#79):
 *   - `agents.runtime_config.provider.apiKey`
 *   - `agents.runtime_config.envVars` (every non-empty value; keys stay plaintext)
 *   - `agents.env_vars` (every non-empty value; keys stay plaintext)
 *
 * Uses the shared AES-256-GCM envelope (`aesGcmEnvelope.ts`: 12-byte IV,
 * 16-byte GCM tag, canonical JSON AAD) with a dedicated 32-byte subkey derived
 * via HKDF-SHA256 (`info = "agent-secret-v1"`) from `SLOCK_PROVIDER_CREDENTIAL_KEY`
 * (domain-separated from hosted provider credentials).
 *
 * Wire / DB format: `<16-hex-keyId>:env-aes-256-gcm:v1:<base64url>` (matching
 * `ssoConnectionSecret.ts`), enabling zero-downtime key rotation via
 * `SLOCK_PROVIDER_CREDENTIAL_KEY_PREVIOUS`.
 *
 * AAD binds `{ schema: "agent-secret-v1", agentId, field }`, so a ciphertext
 * copied onto another agent row or another field/env key cannot be opened.
 *
 * PR 1 dual-read: `openAgentSecret` accepts legacy plaintext strings until the
 * backfill script reaches 0 plaintext rows; PR 2 removes the plaintext branch.
 * Any value carrying the encrypted prefix is rejected on API write boundaries
 * to prevent forged ciphertext injection or accidental double encryption.
 */
import { createHash, hkdfSync } from "node:crypto";
import type { RuntimeConfig } from "@botiverse/raft-shared";
import { aes256KeyFromBase64Env, openAesGcmEnvelope, sealAesGcmEnvelope } from "./aesGcmEnvelope";

export const AGENT_SECRET_KEY_ENV = "SLOCK_PROVIDER_CREDENTIAL_KEY";
export const AGENT_SECRET_PREVIOUS_KEY_ENV = "SLOCK_PROVIDER_CREDENTIAL_KEY_PREVIOUS";

const LABEL = "Agent secret";
const SCHEMA = "raft.agent.secret.v1";
const HKDF_SALT = "raft.agent-secret.v1";
const HKDF_INFO = "agent-secret-v1";
const DEV_JWT_FALLBACK_SALT = "raft.agent-secret.dev-fallback.v1";
const DEV_JWT_FALLBACK_INFO = "agent-secret-jwt-fallback-v1";
const TEST_FALLBACK_SALT = "raft.agent-secret.test-fallback.v1";
const TEST_FALLBACK_INFO = "agent-secret-test-fallback-v1";
export const MAX_AGENT_SECRET_BYTES = 65_536;
const MAX_SECRET_BYTES = MAX_AGENT_SECRET_BYTES;

const ENVELOPE_PREFIX = "env-aes-256-gcm:v1:";
const SEALED_VALUE_RE = /^([0-9a-f]{16}):(env-aes-256-gcm:v1:[A-Za-z0-9_-]+)$/u;
const RESERVED_PREFIX_RE = /(?:^|:)env-aes-256-gcm:/u;

const STRICT_DEPLOYMENTS = new Set(["production", "staging"]);
const MAX_KEY_CACHE_ENTRIES = 16;

interface DerivedKeyEntry {
  id: string;
  key: Buffer;
}

const derivedMasterSubkeyCache = new Map<string, DerivedKeyEntry>();
const derivedJwtFallbackCache = new Map<string, DerivedKeyEntry>();
let cachedTestFallbackEntry: DerivedKeyEntry | null = null;
const openingKeysCache = new Map<string, Map<string, Buffer>>();

function boundedCacheSet<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.size >= MAX_KEY_CACHE_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

export interface AgentSecretDecryptFailure {
  readonly agentId: string;
  readonly failedFields: readonly string[];
}

const AGENT_SECRET_DECRYPT_FAILURE_SYMBOL = Symbol("raft.agentSecretDecryptFailure");

interface RowWithDecryptFailure {
  [AGENT_SECRET_DECRYPT_FAILURE_SYMBOL]?: AgentSecretDecryptFailure;
}

/**
 * Returns decrypt failure metadata attached by `openAgentRowSecretsIsolated`, or null.
 * Stored under an enumerable own Symbol so object spreads (`{ ...agent }`) preserve it
 * while `JSON.stringify` and `Object.keys` ignore it.
 */
export function getAgentSecretDecryptFailure(row: unknown): AgentSecretDecryptFailure | null {
  if (typeof row !== "object" || row === null) return null;
  const failure = (row as RowWithDecryptFailure)[AGENT_SECRET_DECRYPT_FAILURE_SYMBOL];
  return failure ?? null;
}

export function hasAgentSecretDecryptFailure(row: unknown): boolean {
  return getAgentSecretDecryptFailure(row) !== null;
}

export class AgentSecretKeyUnavailableError extends Error {
  constructor(message = `${AGENT_SECRET_KEY_ENV} must be configured before storing or reading agent secrets`) {
    super(message);
    this.name = "AgentSecretKeyUnavailableError";
  }
}

export class AgentSecretDecryptionError extends Error {
  constructor(agentId: string, field: string) {
    super(`Failed to decrypt agent secret (agentId=${agentId}, field=${field})`);
    this.name = "AgentSecretDecryptionError";
  }
}

export class AgentSecretInputError extends Error {
  constructor(message = "Secret value uses a reserved internal encryption prefix") {
    super(message);
    this.name = "AgentSecretInputError";
  }
}

function isStrictDeployment(env: NodeJS.ProcessEnv): boolean {
  const deployment = env.DEPLOYMENT_ENV?.trim().toLowerCase();
  if (deployment) return STRICT_DEPLOYMENTS.has(deployment);
  return env.NODE_ENV?.trim().toLowerCase() === "production";
}

function isTestProcess(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

function deriveSubkey(master: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", master, HKDF_SALT, HKDF_INFO, 32));
}

function deriveDevJwtFallbackKey(jwtSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(jwtSecret, "utf8"), DEV_JWT_FALLBACK_SALT, DEV_JWT_FALLBACK_INFO, 32));
}

function deriveTestFallbackKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from("raft-vitest-agent-secret-key", "utf8"), TEST_FALLBACK_SALT, TEST_FALLBACK_INFO, 32));
}

function keyIdOf(derivedKey: Buffer): string {
  return createHash("sha256").update("raft-agent-secret-key-id:").update(derivedKey).digest("hex").slice(0, 16);
}

function parseMasterKeyFromEnv(env: NodeJS.ProcessEnv, name: string): Buffer {
  try {
    return aes256KeyFromBase64Env(env[name], LABEL, name);
  } catch {
    throw new AgentSecretKeyUnavailableError(`${name} must be a base64-encoded 32-byte key`);
  }
}

function cachedMasterSubkey(rawBase64: string, envName: string): DerivedKeyEntry {
  const cached = derivedMasterSubkeyCache.get(rawBase64);
  if (cached) return cached;
  let master: Buffer;
  try {
    master = aes256KeyFromBase64Env(rawBase64, LABEL, envName);
  } catch {
    throw new AgentSecretKeyUnavailableError(`${envName} must be a base64-encoded 32-byte key`);
  }
  const key = deriveSubkey(master);
  const entry: DerivedKeyEntry = { id: keyIdOf(key), key };
  boundedCacheSet(derivedMasterSubkeyCache, rawBase64, entry);
  return entry;
}

function cachedDevJwtFallbackKey(jwtSecret: string): DerivedKeyEntry {
  const cached = derivedJwtFallbackCache.get(jwtSecret);
  if (cached) return cached;
  const key = deriveDevJwtFallbackKey(jwtSecret);
  const entry: DerivedKeyEntry = { id: keyIdOf(key), key };
  boundedCacheSet(derivedJwtFallbackCache, jwtSecret, entry);
  return entry;
}

function cachedTestFallbackKey(): DerivedKeyEntry {
  if (!cachedTestFallbackEntry) {
    const key = deriveTestFallbackKey();
    cachedTestFallbackEntry = { id: keyIdOf(key), key };
  }
  return cachedTestFallbackEntry;
}

function resolveSealingKey(env: NodeJS.ProcessEnv): DerivedKeyEntry {
  const rawPrimary = env[AGENT_SECRET_KEY_ENV]?.trim();
  if (rawPrimary) {
    return cachedMasterSubkey(rawPrimary, AGENT_SECRET_KEY_ENV);
  }
  // Production and staging always fail closed — never fall back to JWT_SECRET or plaintext.
  if (isStrictDeployment(env)) {
    throw new AgentSecretKeyUnavailableError();
  }
  const jwtSecret = env.JWT_SECRET?.trim();
  if (jwtSecret) {
    return cachedDevJwtFallbackKey(jwtSecret);
  }
  if (isTestProcess(env)) {
    return cachedTestFallbackKey();
  }
  throw new AgentSecretKeyUnavailableError();
}

function resolveOpeningKeys(env: NodeJS.ProcessEnv): Map<string, Buffer> {
  const rawPrimary = env[AGENT_SECRET_KEY_ENV]?.trim() ?? "";
  const rawPrevious = env[AGENT_SECRET_PREVIOUS_KEY_ENV]?.trim() ?? "";
  const strict = isStrictDeployment(env);
  const jwtSecret = strict ? "" : (env.JWT_SECRET?.trim() ?? "");
  const inTest = !strict && isTestProcess(env);
  const cacheKey = `${strict ? "1" : "0"}\0${inTest ? "1" : "0"}\0${rawPrimary}\0${rawPrevious}\0${jwtSecret}`;
  const cached = openingKeysCache.get(cacheKey);
  if (cached) return cached;

  const keys = new Map<string, Buffer>();
  if (rawPrimary) {
    const primary = cachedMasterSubkey(rawPrimary, AGENT_SECRET_KEY_ENV);
    keys.set(primary.id, primary.key);
  } else if (strict) {
    throw new AgentSecretKeyUnavailableError();
  }

  if (rawPrevious) {
    const previous = cachedMasterSubkey(rawPrevious, AGENT_SECRET_PREVIOUS_KEY_ENV);
    keys.set(previous.id, previous.key);
  }

  // Outside production/staging, also allow opening rows sealed with the local
  // dev/QA JWT fallback or test fallback so adding SLOCK_PROVIDER_CREDENTIAL_KEY
  // locally does not lock out existing dev rows.
  if (!strict) {
    if (jwtSecret) {
      const jwtEntry = cachedDevJwtFallbackKey(jwtSecret);
      if (!keys.has(jwtEntry.id)) keys.set(jwtEntry.id, jwtEntry.key);
    }
    if (inTest) {
      const testEntry = cachedTestFallbackKey();
      if (!keys.has(testEntry.id)) keys.set(testEntry.id, testEntry.key);
    }
  }

  if (keys.size === 0) {
    throw new AgentSecretKeyUnavailableError();
  }
  boundedCacheSet(openingKeysCache, cacheKey, keys);
  return keys;
}

export function __clearAgentSecretKeyCacheForTests(): void {
  derivedMasterSubkeyCache.clear();
  derivedJwtFallbackCache.clear();
  cachedTestFallbackEntry = null;
  openingKeysCache.clear();
}

/** Fail fast at boot in production/staging when the primary encryption key is missing or malformed. */
export function assertAgentSecretKeyConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const rawPrimary = env[AGENT_SECRET_KEY_ENV]?.trim();
  if (!rawPrimary) {
    if (isStrictDeployment(env)) {
      throw new AgentSecretKeyUnavailableError();
    }
  } else {
    parseMasterKeyFromEnv(env, AGENT_SECRET_KEY_ENV);
  }
  if (env[AGENT_SECRET_PREVIOUS_KEY_ENV]?.trim()) {
    parseMasterKeyFromEnv(env, AGENT_SECRET_PREVIOUS_KEY_ENV);
  }
}

export function isEncryptedAgentSecret(value: unknown): value is string {
  return typeof value === "string" && SEALED_VALUE_RE.test(value);
}

/**
 * True when user-supplied plaintext looks like our internal ciphertext framing.
 * API write boundaries reject such input so callers cannot inject ciphertexts
 * copied from another row or cause double encryption.
 */
export function containsReservedAgentSecretPrefix(value: unknown): boolean {
  return typeof value === "string" && RESERVED_PREFIX_RE.test(value);
}

function aadFor(agentId: string, field: string) {
  return { schema: "agent-secret-v1", agentId, field };
}

export function providerApiKeyField(): string {
  return "runtime_config.provider.apiKey";
}

export function runtimeConfigEnvVarField(key: string): string {
  return `runtime_config.envVars:${key}`;
}

export function agentEnvVarField(key: string): string {
  return `env_vars:${key}`;
}

export function sealAgentSecret(
  agentId: string,
  field: string,
  plaintext: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (plaintext === "") return "";
  if (isEncryptedAgentSecret(plaintext)) {
    throw new AgentSecretInputError("Refusing to double-encrypt an already-sealed agent secret");
  }
  const { id, key } = resolveSealingKey(env);
  const envelope = sealAesGcmEnvelope({
    label: LABEL,
    schema: SCHEMA,
    plaintext,
    aad: aadFor(agentId, field),
    key,
    maxPlaintextBytes: MAX_SECRET_BYTES,
  });
  return `${id}:${envelope}`;
}

/**
 * Dual-read (PR 1): decrypts sealed values and passes through legacy plaintext
 * rows unchanged. Throws `AgentSecretDecryptionError` if a sealed value fails
 * authentication (wrong key, tampered payload, or mismatched agentId/field).
 */
export function openAgentSecret(
  agentId: string,
  field: string,
  stored: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (stored === "") return "";
  const match = SEALED_VALUE_RE.exec(stored);
  if (!match) return stored;
  const [, id, envelope] = match;
  const keys = resolveOpeningKeys(env);
  const key = keys.get(id!);
  if (!key) {
    throw new AgentSecretDecryptionError(agentId, field);
  }
  const plaintext = openAesGcmEnvelope({
    label: LABEL,
    envelope: envelope!,
    schema: SCHEMA,
    aad: aadFor(agentId, field),
    key,
    maxBytes: MAX_SECRET_BYTES,
  });
  if (plaintext === null) {
    throw new AgentSecretDecryptionError(agentId, field);
  }
  return plaintext;
}

export function isSealedUnderCurrentAgentSecretKey(
  stored: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const match = SEALED_VALUE_RE.exec(stored);
  if (!match) return false;
  return match[1] === resolveSealingKey(env).id;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sealAgentEnvVars(
  agentId: string,
  envVars: Record<string, string> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fieldForKey: (key: string) => string = agentEnvVarField,
): Record<string, string> | null {
  if (envVars == null) return null;
  const entries = Object.entries(envVars);
  if (entries.length === 0) return {};
  const sealed: Record<string, string> = {};
  for (const [key, value] of entries) {
    sealed[key] = typeof value === "string" ? sealAgentSecret(agentId, fieldForKey(key), value, env) : value;
  }
  return sealed;
}

export function openAgentEnvVars(
  agentId: string,
  envVars: Record<string, string> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fieldForKey: (key: string) => string = agentEnvVarField,
): Record<string, string> | null {
  if (envVars == null) return null;
  const entries = Object.entries(envVars);
  if (entries.length === 0) return envVars;
  if (!entries.some(([, value]) => isEncryptedAgentSecret(value))) return envVars;
  const opened: Record<string, string> = {};
  for (const [key, value] of entries) {
    opened[key] = typeof value === "string" ? openAgentSecret(agentId, fieldForKey(key), value, env) : value;
  }
  return opened;
}

export function sealAgentRuntimeConfig<T extends RuntimeConfig | Record<string, unknown> | null | undefined>(
  agentId: string,
  runtimeConfig: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (!isPlainRecord(runtimeConfig)) return runtimeConfig;
  let next: Record<string, unknown> | null = null;

  const provider = runtimeConfig.provider;
  if (isPlainRecord(provider) && typeof provider.apiKey === "string" && provider.apiKey.length > 0) {
    const sealedApiKey = sealAgentSecret(agentId, providerApiKeyField(), provider.apiKey, env);
    next = { ...runtimeConfig, provider: { ...provider, apiKey: sealedApiKey } };
  }

  const rcEnvVars = runtimeConfig.envVars;
  if (isPlainRecord(rcEnvVars)) {
    const entries = Object.entries(rcEnvVars);
    const hasNonEmptyString = entries.some(([, v]) => typeof v === "string" && v.length > 0);
    if (hasNonEmptyString) {
      const sealedRcEnv: Record<string, unknown> = {};
      for (const [k, v] of entries) {
        sealedRcEnv[k] = typeof v === "string"
          ? sealAgentSecret(agentId, runtimeConfigEnvVarField(k), v, env)
          : v;
      }
      next = { ...(next ?? runtimeConfig), envVars: sealedRcEnv };
    }
  }

  return (next ?? runtimeConfig) as T;
}

export function openAgentRuntimeConfig<T>(
  agentId: string,
  runtimeConfig: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (!isPlainRecord(runtimeConfig)) return runtimeConfig;
  let next: Record<string, unknown> | null = null;

  const provider = runtimeConfig.provider;
  if (isPlainRecord(provider) && typeof provider.apiKey === "string" && isEncryptedAgentSecret(provider.apiKey)) {
    const openedApiKey = openAgentSecret(agentId, providerApiKeyField(), provider.apiKey, env);
    next = { ...runtimeConfig, provider: { ...provider, apiKey: openedApiKey } };
  }

  const rcEnvVars = runtimeConfig.envVars;
  if (isPlainRecord(rcEnvVars)) {
    const entries = Object.entries(rcEnvVars);
    const hasEncrypted = entries.some(([, v]) => isEncryptedAgentSecret(v));
    if (hasEncrypted) {
      const openedRcEnv: Record<string, unknown> = {};
      for (const [k, v] of entries) {
        openedRcEnv[k] = typeof v === "string"
          ? openAgentSecret(agentId, runtimeConfigEnvVarField(k), v, env)
          : v;
      }
      next = { ...(next ?? runtimeConfig), envVars: openedRcEnv };
    }
  }

  return (next ?? runtimeConfig) as T;
}

/** Open all encrypted secret fields on an `agents` row (strict: throws on failure or prior isolated failure). */
export function openAgentRowSecrets<
  T extends {
    id: string;
    runtimeConfig?: unknown;
    envVars?: Record<string, string> | null;
  },
>(row: T, env: NodeJS.ProcessEnv = process.env): T {
  const priorFailure = getAgentSecretDecryptFailure(row);
  if (priorFailure) {
    throw new AgentSecretDecryptionError(priorFailure.agentId, priorFailure.failedFields.join(","));
  }
  const openedRuntimeConfig = row.runtimeConfig !== undefined
    ? openAgentRuntimeConfig(row.id, row.runtimeConfig, env)
    : row.runtimeConfig;
  const openedEnvVars = row.envVars !== undefined
    ? openAgentEnvVars(row.id, row.envVars, env, agentEnvVarField)
    : row.envVars;
  if (openedRuntimeConfig === row.runtimeConfig && openedEnvVars === row.envVars) {
    return row;
  }
  return {
    ...row,
    ...(row.runtimeConfig !== undefined ? { runtimeConfig: openedRuntimeConfig } : {}),
    ...(row.envVars !== undefined ? { envVars: openedEnvVars } : {}),
  };
}

function openAgentEnvVarsIsolated(
  agentId: string,
  envVars: Record<string, string> | null | undefined,
  env: NodeJS.ProcessEnv,
  fieldForKey: (key: string) => string,
  failedFields: string[],
): Record<string, string> | null | undefined {
  if (envVars == null) return envVars;
  const entries = Object.entries(envVars);
  if (entries.length === 0) return envVars;
  if (!entries.some(([, value]) => isEncryptedAgentSecret(value))) return envVars;
  const opened: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value === "string" && isEncryptedAgentSecret(value)) {
      const field = fieldForKey(key);
      try {
        opened[key] = openAgentSecret(agentId, field, value, env);
      } catch {
        failedFields.push(field);
      }
    } else {
      opened[key] = value;
    }
  }
  return opened;
}

function openAgentRuntimeConfigIsolated<T>(
  agentId: string,
  runtimeConfig: T,
  env: NodeJS.ProcessEnv,
  failedFields: string[],
): T {
  if (!isPlainRecord(runtimeConfig)) return runtimeConfig;
  let next: Record<string, unknown> | null = null;

  const provider = runtimeConfig.provider;
  if (isPlainRecord(provider) && typeof provider.apiKey === "string" && isEncryptedAgentSecret(provider.apiKey)) {
    const field = providerApiKeyField();
    try {
      const openedApiKey = openAgentSecret(agentId, field, provider.apiKey, env);
      next = { ...runtimeConfig, provider: { ...provider, apiKey: openedApiKey } };
    } catch {
      failedFields.push(field);
      const { apiKey: _dropped, ...restProvider } = provider;
      next = { ...runtimeConfig, provider: restProvider };
    }
  }

  const rcEnvVars = runtimeConfig.envVars;
  if (isPlainRecord(rcEnvVars)) {
    const entries = Object.entries(rcEnvVars);
    const hasEncrypted = entries.some(([, v]) => isEncryptedAgentSecret(v));
    if (hasEncrypted) {
      const openedRcEnv: Record<string, unknown> = {};
      for (const [k, v] of entries) {
        if (typeof v === "string" && isEncryptedAgentSecret(v)) {
          const field = runtimeConfigEnvVarField(k);
          try {
            openedRcEnv[k] = openAgentSecret(agentId, field, v, env);
          } catch {
            failedFields.push(field);
          }
        } else {
          openedRcEnv[k] = v;
        }
      }
      next = { ...(next ?? runtimeConfig), envVars: openedRcEnv };
    }
  }

  return (next ?? runtimeConfig) as T;
}

/**
 * Per-row fault-isolated decrypt for list/batch/read paths (#proj-runtime:#79):
 * one row failing decryption (e.g. a missing `_PREVIOUS` key during rotation)
 * must not take down `listAgents`, `getAgentsByIds`, or `getAgentsForMachine`.
 *
 * Unreadable secret fields are stripped (never left as raw ciphertext), a single
 * value-free error is logged for the row, and failure metadata is attached under
 * `AGENT_SECRET_DECRYPT_FAILURE_SYMBOL` so strict single-agent execution paths
 * (`buildAgentConfig`, `openAgentRowSecrets`) still refuse that agent alone.
 */
export function openAgentRowSecretsIsolated<
  T extends {
    id: string;
    runtimeConfig?: unknown;
    envVars?: Record<string, string> | null;
  },
>(row: T, env: NodeJS.ProcessEnv = process.env): T {
  if (hasAgentSecretDecryptFailure(row)) {
    return row;
  }
  const failedFields: string[] = [];
  const openedRuntimeConfig = row.runtimeConfig !== undefined
    ? openAgentRuntimeConfigIsolated(row.id, row.runtimeConfig, env, failedFields)
    : row.runtimeConfig;
  const openedEnvVars = row.envVars !== undefined
    ? openAgentEnvVarsIsolated(row.id, row.envVars, env, agentEnvVarField, failedFields)
    : row.envVars;
  if (failedFields.length === 0 && openedRuntimeConfig === row.runtimeConfig && openedEnvVars === row.envVars) {
    return row;
  }
  const result: T & RowWithDecryptFailure = {
    ...row,
    ...(row.runtimeConfig !== undefined ? { runtimeConfig: openedRuntimeConfig } : {}),
    ...(row.envVars !== undefined ? { envVars: openedEnvVars } : {}),
  };
  if (failedFields.length > 0) {
    console.error(`[agentSecretCrypto] Failed to decrypt agent secrets (agentId=${row.id}, fields=${failedFields.join(",")})`);
    result[AGENT_SECRET_DECRYPT_FAILURE_SYMBOL] = { agentId: row.id, failedFields };
  }
  return result;
}

/**
 * Check incoming API payload for any string carrying the internal ciphertext
 * prefix in `runtimeConfig.provider.apiKey`, `runtimeConfig.envVars`, or `envVars`.
 * Returns a safe field description (never the value) if rejected, else null.
 */
export function findReservedAgentSecretPrefixInInput(input: {
  runtimeConfig?: unknown;
  envVars?: Record<string, string> | null | undefined;
}): string | null {
  if (isPlainRecord(input.runtimeConfig)) {
    const provider = input.runtimeConfig.provider;
    if (isPlainRecord(provider) && containsReservedAgentSecretPrefix(provider.apiKey)) {
      return "runtimeConfig.provider.apiKey";
    }
    const rcEnv = input.runtimeConfig.envVars;
    if (isPlainRecord(rcEnv)) {
      for (const [key, value] of Object.entries(rcEnv)) {
        if (containsReservedAgentSecretPrefix(value)) {
          return `runtimeConfig.envVars.${key}`;
        }
      }
    }
  }
  if (input.envVars && isPlainRecord(input.envVars)) {
    for (const [key, value] of Object.entries(input.envVars)) {
      if (containsReservedAgentSecretPrefix(value)) {
        return `envVars.${key}`;
      }
    }
  }
  return null;
}

/**
 * Defense-in-depth guard called before dispatching an `AgentConfig` to a
 * Computer or returning an agent payload over HTTP: fails loudly if any
 * encrypted agent secret string escaped decryption.
 */
export function assertNoEncryptedAgentSecrets(
  runtimeConfig: unknown,
  envVars?: Record<string, string> | null,
): void {
  if (isPlainRecord(runtimeConfig)) {
    const provider = runtimeConfig.provider;
    if (isPlainRecord(provider) && isEncryptedAgentSecret(provider.apiKey)) {
      throw new Error("Encrypted agent secret leaked into outbound runtimeConfig.provider.apiKey");
    }
    const rcEnv = runtimeConfig.envVars;
    if (isPlainRecord(rcEnv)) {
      for (const [key, value] of Object.entries(rcEnv)) {
        if (isEncryptedAgentSecret(value)) {
          throw new Error(`Encrypted agent secret leaked into outbound runtimeConfig.envVars.${key}`);
        }
      }
    }
  }
  if (envVars) {
    for (const [key, value] of Object.entries(envVars)) {
      if (isEncryptedAgentSecret(value)) {
        throw new Error(`Encrypted agent secret leaked into outbound envVars.${key}`);
      }
    }
  }
}

/**
 * True when an `agents` row still contains any non-empty plaintext secret in
 * `runtimeConfig.provider.apiKey`, `runtimeConfig.envVars`, or `envVars`.
 * Used by the backfill migration script and its 0-plaintext verification pass.
 */
export function hasPlaintextAgentSecrets(row: {
  runtimeConfig?: unknown;
  envVars?: Record<string, string> | null;
}): boolean {
  if (isPlainRecord(row.runtimeConfig)) {
    const provider = row.runtimeConfig.provider;
    if (
      isPlainRecord(provider)
      && typeof provider.apiKey === "string"
      && provider.apiKey.length > 0
      && !isEncryptedAgentSecret(provider.apiKey)
    ) {
      return true;
    }
    const rcEnv = row.runtimeConfig.envVars;
    if (isPlainRecord(rcEnv)) {
      for (const value of Object.values(rcEnv)) {
        if (typeof value === "string" && value.length > 0 && !isEncryptedAgentSecret(value)) {
          return true;
        }
      }
    }
  }
  if (row.envVars && isPlainRecord(row.envVars)) {
    for (const value of Object.values(row.envVars)) {
      if (typeof value === "string" && value.length > 0 && !isEncryptedAgentSecret(value)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when an `agents` row has any encrypted value sealed under a key other
 * than the current key (for key-rotation resealing).
 */
export function hasRotatableAgentSecrets(
  row: { runtimeConfig?: unknown; envVars?: Record<string, string> | null },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const check = (value: unknown) =>
    isEncryptedAgentSecret(value) && !isSealedUnderCurrentAgentSecretKey(value, env);
  if (isPlainRecord(row.runtimeConfig)) {
    const provider = row.runtimeConfig.provider;
    if (isPlainRecord(provider) && check(provider.apiKey)) return true;
    const rcEnv = row.runtimeConfig.envVars;
    if (isPlainRecord(rcEnv) && Object.values(rcEnv).some(check)) return true;
  }
  if (row.envVars && isPlainRecord(row.envVars) && Object.values(row.envVars).some(check)) {
    return true;
  }
  return false;
}

/** Exported for tests verifying framing alignment with `aesGcmEnvelope.ts`. */
export const AGENT_SECRET_ENVELOPE_PREFIX = ENVELOPE_PREFIX;
