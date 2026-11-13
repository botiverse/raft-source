import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  BUILTIN_RUNTIME_GATEWAY_PROVIDER_BASE_URL_ENV_KEYS,
  BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS,
  BUILTIN_RUNTIME_PROVIDER_ENV_KEYS,
  clearClockTimeout,
  currentDate,
  isBuiltInRuntimeGatewayProviderId,
  isBuiltInRuntimeProviderId,
  isProviderConnectionProviderId,
  PI_BUILTIN_PROVIDER_CONNECTION_PROBES,
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS,
  PI_BUILTIN_PROVIDER_MODELS,
  setClockTimeout,
  type RuntimeModelConfig,
  type ProviderConnectionAssignedAgentList,
  type ProviderConnectionLaunchProjection,
  type ProviderConnectionProviderId,
  type ProviderConnectionSummary,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  agentProviderConnections,
  agents,
  machines,
  providerConnectionCredentials,
  providerConnections,
  providerProbeIntents,
  providerProbeReceipts,
} from "../db/schema";
import { createSafeFetch, validateManagedMcpEndpoint } from "./managedMcpGateway";
import { isProviderProbeEnforcementEnabled } from "./providerConnectionFeature";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import { bumpProviderConnectionAgentsConfigRevision } from "./agentConfigRevision";

const KEY_ENV = "SLOCK_PROVIDER_CREDENTIAL_KEY";
const SECRET_VERSION = "v1";
const MAX_API_KEY_BYTES = 16 * 1024;
const MAX_TEST_MODEL_CHARS = 200;
const MAX_TEST_MESSAGE_CHARS = 2_000;
const MAX_MODEL_OPTIONS = 200;
let testFetchFactory: (() => { fetch: typeof globalThis.fetch; close: () => Promise<void> }) | null = null;

export function __setProviderConnectionFetchFactoryForTests(
  factory: (() => { fetch: typeof globalThis.fetch; close: () => Promise<void> }) | null,
): void {
  testFetchFactory = factory;
}

export type ProviderConnectionErrorCode =
  | "provider_connection_invalid"
  | "provider_connection_key_missing"
  | "provider_connection_not_found"
  | "provider_connection_in_use"
  | "provider_connection_assignment_active"
  | "provider_connection_unavailable"
  | "provider_connection_model_list_failed"
  | "provider_connection_test_failed"
  | "provider_connection_retired"
  | "provider_connection_unverified";

export class ProviderConnectionError extends Error {
  constructor(message: string, readonly code: ProviderConnectionErrorCode) {
    super(message);
    this.name = "ProviderConnectionError";
  }
}

function credentialKey(): Buffer {
  const raw = process.env[KEY_ENV]?.trim();
  if (!raw) {
    throw new ProviderConnectionError(
      `${KEY_ENV} must be configured before storing provider credentials`,
      "provider_connection_key_missing",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/u, "") !== raw.replace(/=+$/u, "")) {
    throw new ProviderConnectionError(
      `${KEY_ENV} must be a base64-encoded 32-byte key`,
      "provider_connection_key_missing",
    );
  }
  return key;
}

function normalizeApiKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/u.test(value)) {
    throw new ProviderConnectionError("API key is invalid", "provider_connection_invalid");
  }
  const apiKey = value.trim();
  if (Buffer.byteLength(apiKey, "utf8") > MAX_API_KEY_BYTES) {
    throw new ProviderConnectionError("API key exceeds the size limit", "provider_connection_invalid");
  }
  assertApiKeyIsLatin1(apiKey);
  return apiKey;
}

function assertApiKeyIsLatin1(apiKey: string): void {
  for (let i = 0; i < apiKey.length; i++) {
    if (apiKey.charCodeAt(i) > 0xff) {
      throw new ProviderConnectionError(
        `API key character ${i + 1} (1-based) is not Latin-1`,
        "provider_connection_invalid",
      );
    }
  }
}

function encryptApiKey(apiKey: string, scope: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialKey(), iv);
  cipher.setAAD(Buffer.from(scope, "utf8"));
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return [
    SECRET_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

function decryptApiKey(payload: string, scope: string): string {
  const [version, iv, tag, encrypted, extra] = payload.split(":");
  if (version !== SECRET_VERSION || !iv || !tag || !encrypted || extra !== undefined) {
    throw new ProviderConnectionError("Stored provider credential is invalid", "provider_connection_unavailable");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", credentialKey(), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(scope, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return normalizeApiKey(Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]).toString("utf8"));
  } catch (error) {
    if (error instanceof ProviderConnectionError) {
      if (error.code === "provider_connection_key_missing" || error.code === "provider_connection_invalid") {
        throw error;
      }
    }
    throw new ProviderConnectionError("Stored provider credential could not be decrypted", "provider_connection_unavailable");
  }
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
    throw new ProviderConnectionError("Connection name is invalid", "provider_connection_invalid");
  }
  return value.trim();
}

function normalizeProviderId(value: unknown): ProviderConnectionProviderId {
  if (!isProviderConnectionProviderId(value)) {
    throw new ProviderConnectionError("Provider is not supported", "provider_connection_invalid");
  }
  return value;
}

function normalizeTestModel(value: unknown): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.trim().length > MAX_TEST_MODEL_CHARS
    || /[\r\n\0]/u.test(value)
  ) {
    throw new ProviderConnectionError("Test model is invalid", "provider_connection_invalid");
  }
  return value.trim();
}

function normalizeTestMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_TEST_MESSAGE_CHARS || /\0/u.test(value)) {
    throw new ProviderConnectionError("Test message is invalid", "provider_connection_invalid");
  }
  return value.trim();
}

function normalizeEndpointUrl(providerId: ProviderConnectionProviderId, value: unknown): string | null {
  if (isBuiltInRuntimeProviderId(providerId)) {
    if (value === undefined || value === null || value === "") return null;
    throw new ProviderConnectionError("Preset provider connections do not accept a custom endpoint", "provider_connection_invalid");
  }
  if (typeof value !== "string" || !value.trim() || value.length > 2_000) {
    throw new ProviderConnectionError("Endpoint URL is required for compatible gateways", "provider_connection_invalid");
  }
  try {
    const url = new URL(value.trim());
    validateManagedMcpEndpoint(url.toString());
    if (url.search) {
      throw new ProviderConnectionError("Endpoint URL must not contain query parameters", "provider_connection_invalid");
    }
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new ProviderConnectionError("Endpoint URL is invalid", "provider_connection_invalid");
  }
}

function normalizeSupportsImageInput(providerId: ProviderConnectionProviderId, value: unknown): boolean {
  if (value !== undefined && typeof value !== "boolean") {
    throw new ProviderConnectionError("Image input support must be a boolean", "provider_connection_invalid");
  }
  if (isBuiltInRuntimeProviderId(providerId) && value === true) {
    throw new ProviderConnectionError("Preset provider connections do not accept gateway capabilities", "provider_connection_invalid");
  }
  return isBuiltInRuntimeGatewayProviderId(providerId) && value === true;
}

function projectSummary(row: {
  connection: typeof providerConnections.$inferSelect;
  credentialVersion: number | null;
  assignedAgentCount: number | string;
}): ProviderConnectionSummary {
  const connection = row.connection;
  return {
    id: connection.id,
    name: connection.name,
    providerId: connection.providerId,
    authMethod: connection.authMethod,
    endpointUrl: connection.endpointUrl,
    supportsImageInput: connection.supportsImageInput,
    enabled: connection.enabled,
    status: connection.status,
    configVersion: connection.configVersion,
    credentialVersion: row.credentialVersion ?? 0,
    hasCredential: row.credentialVersion !== null,
    assignedAgentCount: Number(row.assignedAgentCount),
    latestVerified: null,
    lastCheckedAt: connection.lastCheckedAt?.toISOString() ?? null,
    lastErrorCategory: connection.lastErrorCategory,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

export async function listProviderConnections(serverId: string): Promise<ProviderConnectionSummary[]> {
  const rows = await getDb()
    .select({
      connection: providerConnections,
      credentialVersion: providerConnectionCredentials.credentialVersion,
      assignedAgentCount: sql<number>`count(${agentProviderConnections.agentId})::int`,
    })
    .from(providerConnections)
    .leftJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, providerConnections.serverId),
      eq(providerConnectionCredentials.connectionId, providerConnections.id),
    ))
    .leftJoin(agentProviderConnections, and(
      eq(agentProviderConnections.serverId, providerConnections.serverId),
      eq(agentProviderConnections.connectionId, providerConnections.id),
    ))
    .where(eq(providerConnections.serverId, serverId))
    .groupBy(providerConnections.id, providerConnectionCredentials.credentialVersion)
    .orderBy(providerConnections.name);
  const summaries = rows.map(projectSummary);
  // One batched read for the whole catalog: the latest durable success receipt
  // per connection (plus its Computer name), so the settings page never fans
  // out one request per row.
  const verified = await getDb().select({
    connectionId: providerProbeIntents.connectionId,
    computerId: providerProbeIntents.computerId,
    computerName: machines.name,
    runtime: providerProbeIntents.runtime,
    model: providerProbeIntents.model,
    verifiedAt: providerProbeReceipts.verifiedAt,
  }).from(providerProbeReceipts)
    .innerJoin(providerProbeIntents, eq(providerProbeIntents.id, providerProbeReceipts.probeId))
    .leftJoin(machines, eq(machines.id, providerProbeIntents.computerId))
    .where(and(
      eq(providerProbeIntents.serverId, serverId),
      eq(providerProbeReceipts.outcome, "success"),
    ))
    .orderBy(sql`${providerProbeIntents.connectionId}`, sql`${providerProbeReceipts.verifiedAt} desc`);
  const latestByConnection = new Map<string, (typeof verified)[number]>();
  for (const row of verified) {
    if (!latestByConnection.has(row.connectionId)) latestByConnection.set(row.connectionId, row);
  }
  return summaries.map((summary) => {
    const row = latestByConnection.get(summary.id);
    return {
      ...summary,
      latestVerified: row
        ? {
          computerId: row.computerId,
          computerName: row.computerName,
          runtime: row.runtime,
          model: row.model,
          verifiedAt: row.verifiedAt.toISOString(),
        }
        : null,
    };
  });
}

async function assertConnectionInServer(serverId: string, connectionId: string): Promise<void> {
  const [connection] = await getDb().select({ id: providerConnections.id })
    .from(providerConnections)
    .where(and(
      eq(providerConnections.serverId, serverId),
      eq(providerConnections.id, connectionId),
    ))
    .limit(1);
  if (!connection) {
    throw new ProviderConnectionError("Provider connection not found", "provider_connection_not_found");
  }
}

/**
 * Names the Agents that hold an assignment to one connection. Read-only and
 * server-scoped: a connection id from another server is a neutral 404, and the
 * projection carries identity only — never credential or provider config.
 */
export async function listProviderConnectionAssignedAgents(input: {
  serverId: string;
  connectionId: string;
}): Promise<ProviderConnectionAssignedAgentList> {
  await assertConnectionInServer(input.serverId, input.connectionId);
  const assigned = await getDb().select({
    id: agents.id,
    name: agents.name,
    displayName: agents.displayName,
    runtime: agents.runtime,
    status: agents.status,
    computerName: machines.name,
    deletedAt: agents.deletedAt,
  }).from(agentProviderConnections)
    .innerJoin(agents, and(
      eq(agents.id, agentProviderConnections.agentId),
      eq(agents.serverId, agentProviderConnections.serverId),
    ))
    .leftJoin(machines, and(
      eq(machines.id, agents.machineId),
      eq(machines.serverId, agentProviderConnections.serverId),
    ))
    .where(and(
      eq(agentProviderConnections.serverId, input.serverId),
      eq(agentProviderConnections.connectionId, input.connectionId),
    ))
    .orderBy(asc(agents.name), asc(agents.id));
  return {
    agents: assigned.map((agent) => ({
      id: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      runtime: agent.runtime,
      status: agent.status,
      computerName: agent.computerName ?? null,
      deleted: agent.deletedAt !== null,
    })),
  };
}

/**
 * Releases the assignment left behind by a soft-deleted Agent. Deleting an Agent
 * clears its own assignment, so this is the recovery path for rows that already
 * existed; without it a connection could stay permanently undeletable with no
 * reachable Agent to unbind it from. Active Agents are refused: their provider
 * is changed in the Agent editor, which owns assignment versions.
 */
export async function detachProviderConnectionDeletedAgent(input: {
  serverId: string;
  userId: string;
  connectionId: string;
  agentId: string;
}): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [connection] = await tx.select({
      id: providerConnections.id,
      providerId: providerConnections.providerId,
      configVersion: providerConnections.configVersion,
      credentialVersion: providerConnectionCredentials.credentialVersion,
    }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, providerConnections.serverId),
      eq(providerConnectionCredentials.connectionId, providerConnections.id),
    )).where(and(
      eq(providerConnections.serverId, input.serverId),
      eq(providerConnections.id, input.connectionId),
    )).limit(1).for("update");
    if (!connection) {
      throw new ProviderConnectionError("Provider connection not found", "provider_connection_not_found");
    }
    const [assignment] = await tx.select({
      agentId: agentProviderConnections.agentId,
      deletedAt: agents.deletedAt,
    }).from(agentProviderConnections)
      .innerJoin(agents, and(
        eq(agents.id, agentProviderConnections.agentId),
        eq(agents.serverId, agentProviderConnections.serverId),
      ))
      .where(and(
        eq(agentProviderConnections.serverId, input.serverId),
        eq(agentProviderConnections.connectionId, input.connectionId),
        eq(agentProviderConnections.agentId, input.agentId),
      ))
      .limit(1);
    if (!assignment) {
      throw new ProviderConnectionError(
        "Agent is not assigned to this provider connection",
        "provider_connection_not_found",
      );
    }
    if (assignment.deletedAt === null) {
      throw new ProviderConnectionError(
        "Provider connection is assigned to an active Agent",
        "provider_connection_assignment_active",
      );
    }
    await tx.delete(agentProviderConnections).where(and(
      eq(agentProviderConnections.serverId, input.serverId),
      eq(agentProviderConnections.connectionId, input.connectionId),
      eq(agentProviderConnections.agentId, input.agentId),
    ));
    await recordIntegrationAuditEvent({
      serverId: input.serverId,
      eventType: "provider_connection.assignment_detached",
      outcome: "success",
      source: "web",
      actor: { type: "human", id: input.userId },
      subject: { type: "agent", id: input.agentId },
      target: { type: "provider_connection", id: input.connectionId },
      metadata: {
        providerId: connection.providerId,
        configVersion: connection.configVersion,
        credentialVersion: connection.credentialVersion,
        agentId: input.agentId,
        reason: "agent_deleted",
      },
    }, tx);
  });
}

export async function createProviderConnection(input: {
  serverId: string;
  userId: string;
  name: unknown;
  providerId: unknown;
  endpointUrl?: unknown;
  supportsImageInput?: unknown;
  apiKey: unknown;
}): Promise<ProviderConnectionSummary> {
  const id = randomUUID();
  const name = normalizeName(input.name);
  const providerId = normalizeProviderId(input.providerId);
  const endpointUrl = normalizeEndpointUrl(providerId, input.endpointUrl);
  const apiKey = normalizeApiKey(input.apiKey);
  const supportsImageInput = normalizeSupportsImageInput(providerId, input.supportsImageInput);
  await getDb().transaction(async (tx) => {
    await tx.insert(providerConnections).values({
      id,
      serverId: input.serverId,
      name,
      providerId,
      endpointUrl,
      supportsImageInput,
      createdByUserId: input.userId,
      updatedByUserId: input.userId,
    });
    await tx.insert(providerConnectionCredentials).values({
      serverId: input.serverId,
      connectionId: id,
      encryptedApiKey: encryptApiKey(apiKey, `${input.serverId}:${id}`),
    });
    await recordIntegrationAuditEvent({
      serverId: input.serverId,
      eventType: "provider_connection.created",
      outcome: "success",
      source: "web",
      actor: { type: "human", id: input.userId },
      target: { type: "provider_connection", id },
      metadata: { providerId, configVersion: 1, credentialVersion: 1, status: "unchecked" },
    }, tx);
  });
  const result = (await listProviderConnections(input.serverId)).find((connection) => connection.id === id);
  if (!result) throw new ProviderConnectionError("Provider connection was not created", "provider_connection_unavailable");
  return result;
}

export async function updateProviderConnection(input: {
  serverId: string;
  userId: string;
  connectionId: string;
  name?: unknown;
  enabled?: unknown;
  endpointUrl?: unknown;
  supportsImageInput?: unknown;
  apiKey?: unknown;
}): Promise<ProviderConnectionSummary> {
  await getDb().transaction(async (tx) => {
    const [row] = await tx.select({
      connection: providerConnections,
      credential: providerConnectionCredentials,
    }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, providerConnections.serverId),
      eq(providerConnectionCredentials.connectionId, providerConnections.id),
    )).where(and(
      eq(providerConnections.serverId, input.serverId),
      eq(providerConnections.id, input.connectionId),
    )).limit(1);
    if (!row) throw new ProviderConnectionError("Provider connection not found", "provider_connection_not_found");

    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new ProviderConnectionError("Enabled state must be a boolean", "provider_connection_invalid");
    }

    const name = input.name !== undefined ? normalizeName(input.name) : row.connection.name;
    const enabled = input.enabled !== undefined ? input.enabled : row.connection.enabled;
    const endpointUrl = input.endpointUrl !== undefined
      ? normalizeEndpointUrl(row.connection.providerId, input.endpointUrl)
      : row.connection.endpointUrl;
    const supportsImageInput = input.supportsImageInput !== undefined
      ? normalizeSupportsImageInput(row.connection.providerId, input.supportsImageInput)
      : row.connection.supportsImageInput;

    const hasNewApiKey = input.apiKey !== undefined && input.apiKey !== null && String(input.apiKey).trim() !== "";
    const apiKey = hasNewApiKey ? normalizeApiKey(input.apiKey) : null;

    const nameChanged = name !== row.connection.name;
    const enabledChanged = enabled !== row.connection.enabled;
    const endpointUrlChanged = endpointUrl !== row.connection.endpointUrl;
    const supportsImageInputChanged = supportsImageInput !== row.connection.supportsImageInput;
    const configChanged = nameChanged || enabledChanged || endpointUrlChanged || supportsImageInputChanged;
    const credentialChanged = hasNewApiKey;

    if (!configChanged && !credentialChanged) {
      return;
    }

    const nextConfigVersion = row.connection.configVersion + (configChanged ? 1 : 0);
    const nextCredentialVersion = row.credential.credentialVersion + (credentialChanged ? 1 : 0);
    const shouldResetStatus = endpointUrlChanged || credentialChanged;

    await tx.update(providerConnections).set({
      name,
      enabled,
      endpointUrl,
      supportsImageInput,
      configVersion: nextConfigVersion,
      ...(shouldResetStatus ? {
        status: "unchecked",
        lastCheckedAt: null,
        lastErrorCategory: null,
      } : {}),
      updatedByUserId: input.userId,
      updatedAt: currentDate(),
    }).where(and(
      eq(providerConnections.serverId, input.serverId),
      eq(providerConnections.id, input.connectionId),
    ));

    if (credentialChanged && apiKey) {
      await tx.update(providerConnectionCredentials).set({
        encryptedApiKey: encryptApiKey(apiKey, `${input.serverId}:${input.connectionId}`),
        credentialVersion: nextCredentialVersion,
        updatedAt: currentDate(),
      }).where(eq(providerConnectionCredentials.id, row.credential.id));
    }

    await tx.update(agentProviderConnections).set({
      expectedConfigVersion: nextConfigVersion,
      expectedCredentialVersion: nextCredentialVersion,
      updatedByUserId: input.userId,
      updatedAt: currentDate(),
    }).where(and(
      eq(agentProviderConnections.serverId, input.serverId),
      eq(agentProviderConnections.connectionId, input.connectionId),
    ));
    // Reconciler step 11b: a new key or endpoint changes the launch of every agent on it.
    if (shouldResetStatus) await bumpProviderConnectionAgentsConfigRevision(tx, input.serverId, input.connectionId);

    const changedFields = [
      ...(nameChanged ? ["name"] : []),
      ...(enabledChanged ? ["enabled"] : []),
      ...(endpointUrlChanged ? ["endpointUrl"] : []),
      ...(supportsImageInputChanged ? ["supportsImageInput"] : []),
      ...(credentialChanged ? ["apiKey"] : []),
    ];

    await recordIntegrationAuditEvent({
      serverId: input.serverId,
      eventType: credentialChanged ? "provider_connection.credential_rotated" : "provider_connection.updated",
      outcome: "success",
      source: "web",
      actor: { type: "human", id: input.userId },
      target: { type: "provider_connection", id: input.connectionId },
      metadata: {
        changedFields,
        configVersion: nextConfigVersion,
        credentialVersion: nextCredentialVersion,
        enabled,
        status: shouldResetStatus ? "unchecked" : row.connection.status,
      },
    }, tx);
  });
  const result = (await listProviderConnections(input.serverId)).find((connection) => connection.id === input.connectionId);
  if (!result) throw new ProviderConnectionError("Provider connection not found", "provider_connection_not_found");
  return result;
}

export async function rotateProviderConnectionCredential(input: {
  serverId: string;
  userId: string;
  connectionId: string;
  apiKey: unknown;
  endpointUrl?: unknown;
  supportsImageInput?: unknown;
}): Promise<ProviderConnectionSummary> {
  await getDb().transaction(async (tx) => {
    const [row] = await tx.select({
      connection: providerConnections,
      credential: providerConnectionCredentials,
    }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, providerConnections.serverId),
      eq(providerConnectionCredentials.connectionId, providerConnections.id),
    )).where(and(
      eq(providerConnections.serverId, input.serverId),
      eq(providerConnections.id, input.connectionId),
    )).limit(1);
    if (!row) throw new ProviderConnectionError("Provider connection not found", "provider_connection_not_found");

    const endpointUrl = input.endpointUrl === undefined
      ? row.connection.endpointUrl
      : normalizeEndpointUrl(row.connection.providerId, input.endpointUrl);
    const supportsImageInput = input.supportsImageInput === undefined
      ? row.connection.supportsImageInput
      : normalizeSupportsImageInput(row.connection.providerId, input.supportsImageInput);
    const configChanged = endpointUrl !== row.connection.endpointUrl
      || supportsImageInput !== row.connection.supportsImageInput;
    const nextConfigVersion = row.connection.configVersion + (configChanged ? 1 : 0);
    const nextCredentialVersion = row.credential.credentialVersion + 1;

    await tx.update(providerConnections).set({
      endpointUrl,
      supportsImageInput,
      status: "unchecked",
      configVersion: nextConfigVersion,
      lastCheckedAt: null,
      lastErrorCategory: null,
      updatedByUserId: input.userId,
      updatedAt: currentDate(),
    }).where(and(
      eq(providerConnections.serverId, input.serverId),
      eq(providerConnections.id, input.connectionId),
    ));
    await tx.update(providerConnectionCredentials).set({
      encryptedApiKey: encryptApiKey(normalizeApiKey(input.apiKey), `${input.serverId}:${input.connectionId}`),
      credentialVersion: nextCredentialVersion,
      updatedAt: currentDate(),
    }).where(eq(providerConnectionCredentials.id, row.credential.id));
    await tx.update(agentProviderConnections).set({
      expectedConfigVersion: nextConfigVersion,
      expectedCredentialVersion: nextCredentialVersion,
      updatedByUserId: input.userId,
      updatedAt: currentDate(),
    }).where(and(
      eq(agentProviderConnections.serverId, input.serverId),
      eq(agentProviderConnections.connectionId, input.connectionId),
    ));
    await bumpProviderConnectionAgentsConfigRevision(tx, input.serverId, input.connectionId);
    await recordIntegrationAuditEvent({
      serverId: input.serverId,
      eventType: "provider_connection.credential_rotated",
      outcome: "success",
      source: "web",
      actor: { type: "human", id: input.userId },
      target: { type: "provider_connection", id: input.connectionId },
      metadata: {
        configVersion: nextConfigVersion,
        credentialVersion: nextCredentialVersion,
        status: "unchecked",
      },
    }, tx);
  });
  const result = (await listProviderConnections(input.serverId)).find((connection) => connection.id === input.connectionId);
  if (!result) throw new ProviderConnectionError("Provider connection not found", "provider_connection_not_found");
  return result;
}

export async function deleteProviderConnection(input: {
  serverId: string;
  userId: string;
  connectionId: string;
}): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [current] = await tx.select({
      connection: providerConnections,
      credentialVersion: providerConnectionCredentials.credentialVersion,
    }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, providerConnections.serverId),
      eq(providerConnectionCredentials.connectionId, providerConnections.id),
    )).where(and(
      eq(providerConnections.serverId, input.serverId),
      eq(providerConnections.id, input.connectionId),
    )).limit(1).for("update");
    if (!current) throw new ProviderConnectionError("Provider connection not found", "provider_connection_not_found");
    const [usage] = await tx.select({ count: sql<number>`count(*)::int` }).from(agentProviderConnections).where(and(
      eq(agentProviderConnections.serverId, input.serverId),
      eq(agentProviderConnections.connectionId, input.connectionId),
    ));
    if (Number(usage?.count ?? 0) > 0) {
      throw new ProviderConnectionError("Provider connection is assigned to an Agent", "provider_connection_in_use");
    }
    await tx.delete(providerConnections).where(and(
      eq(providerConnections.serverId, input.serverId),
      eq(providerConnections.id, input.connectionId),
    ));
    await recordIntegrationAuditEvent({
      serverId: input.serverId,
      eventType: "provider_connection.deleted",
      outcome: "success",
      source: "web",
      actor: { type: "human", id: input.userId },
      target: { type: "provider_connection", id: input.connectionId },
      metadata: {
        providerId: current.connection.providerId,
        configVersion: current.connection.configVersion,
        credentialVersion: current.credentialVersion,
      },
    }, tx);
  });
}

/** Connection ids are UUIDs; an untrusted id never reaches the UUID column (a
 *  malformed value is "unavailable", never a database error). */
export const SAVED_CONNECTION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveProviderConnectionSelection(serverId: string, connectionId: string) {
  if (!SAVED_CONNECTION_ID_SHAPE.test(connectionId)) {
    throw new ProviderConnectionError("Provider connection is unavailable", "provider_connection_unavailable");
  }
  const [row] = await getDb().select({
    connection: providerConnections,
    credentialVersion: providerConnectionCredentials.credentialVersion,
  }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
    eq(providerConnectionCredentials.serverId, providerConnections.serverId),
    eq(providerConnectionCredentials.connectionId, providerConnections.id),
  )).where(and(
    eq(providerConnections.serverId, serverId),
    eq(providerConnections.id, connectionId),
  )).limit(1);
  if (!row || !row.connection.enabled) {
    throw new ProviderConnectionError("Provider connection is unavailable", "provider_connection_unavailable");
  }
  return {
    id: row.connection.id,
    providerId: row.connection.providerId,
    configVersion: row.connection.configVersion,
    credentialVersion: row.credentialVersion,
  };
}

export function assertProviderConnectionModelCompatible(
  providerId: ProviderConnectionProviderId,
  model: RuntimeModelConfig,
): void {
  if (isBuiltInRuntimeProviderId(providerId)) {
    const allowed = PI_BUILTIN_PROVIDER_MODELS[providerId] ?? [];
    if (model.kind !== "preset" || !allowed.some((candidate) => candidate.id === model.id)) {
      throw new ProviderConnectionError(
        "Selected model is not compatible with the provider connection",
        "provider_connection_invalid",
      );
    }
    return;
  }
  if (model.kind !== "custom" || !model.name.trim()) {
    throw new ProviderConnectionError(
      "Compatible gateway connections require a custom model",
      "provider_connection_invalid",
    );
  }
}

function connectionEnv(providerId: ProviderConnectionProviderId, endpointUrl: string | null, apiKey: string) {
  if (isBuiltInRuntimeProviderId(providerId)) {
    return { [BUILTIN_RUNTIME_PROVIDER_ENV_KEYS[providerId]]: apiKey };
  }
  const apiKeyEnv = BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS[providerId];
  const baseUrlEnv = BUILTIN_RUNTIME_GATEWAY_PROVIDER_BASE_URL_ENV_KEYS[providerId];
  if (!apiKeyEnv || !baseUrlEnv || !endpointUrl) {
    throw new ProviderConnectionError("Provider connection configuration is incomplete", "provider_connection_unavailable");
  }
  return { [apiKeyEnv]: apiKey, [baseUrlEnv]: endpointUrl };
}

function connectionTestRequest(
  providerId: ProviderConnectionProviderId,
  endpointUrl: string | null,
  apiKey: string,
  requestedModel?: unknown,
  requestedMessage?: unknown,
): { url: string; init: RequestInit } {
  if (isBuiltInRuntimeGatewayProviderId(providerId)) {
    if (!endpointUrl) {
      throw new ProviderConnectionError("Provider connection configuration is incomplete", "provider_connection_unavailable");
    }
    if (requestedModel !== undefined) {
      const model = normalizeTestModel(requestedModel);
      const message = normalizeTestMessage(requestedMessage ?? "Reply with OK.");
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (providerId === "anthropic-compatible") {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
        return {
          url: `${endpointUrl.replace(/\/$/u, "")}/messages`,
          init: {
            method: "POST",
            headers,
            body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: message }] }),
          },
        };
      }
      headers.Authorization = `Bearer ${apiKey}`;
      return {
        url: `${endpointUrl.replace(/\/$/u, "")}/chat/completions`,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: message }] }),
        },
      };
    }
    const url = `${endpointUrl.replace(/\/$/u, "")}/models`;
    if (providerId === "anthropic-compatible") {
      return {
        url,
        init: {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
        },
      };
    }
    return {
      url,
      init: { headers: { Authorization: `Bearer ${apiKey}` } },
    };
  }

  const probe = PI_BUILTIN_PROVIDER_CONNECTION_PROBES[providerId];
  const fullModelId = PI_BUILTIN_PROVIDER_DEFAULT_MODELS[providerId];
  if (!probe || !fullModelId) {
    throw new ProviderConnectionError("Provider connection probe is unavailable", "provider_connection_unavailable");
  }
  const model = requestedModel === undefined
    ? fullModelId.slice(`${providerId}/`.length)
    : normalizeTestModel(requestedModel);
  const message = normalizeTestMessage(requestedMessage ?? "Reply with OK.");
  const headers: Record<string, string> = {
    ...probe.headers,
    "content-type": "application/json",
  };
  let path: string;
  let body: unknown;
  if (probe.api === "anthropic-messages") {
    path = "/v1/messages";
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = { model, max_tokens: 1, messages: [{ role: "user", content: message }] };
  } else if (probe.api === "google-generative-ai") {
    path = `/models/${encodeURIComponent(model)}:generateContent`;
    headers["x-goog-api-key"] = apiKey;
    body = {
      contents: [{ role: "user", parts: [{ text: message }] }],
      generationConfig: { maxOutputTokens: 1 },
    };
  } else if (probe.api === "openai-responses") {
    path = "/responses";
    headers.Authorization = `Bearer ${apiKey}`;
    body = { model, input: message, max_output_tokens: 1 };
  } else if (probe.api === "openai-completions") {
    path = "/chat/completions";
    headers.Authorization = `Bearer ${apiKey}`;
    body = { model, max_tokens: 1, messages: [{ role: "user", content: message }] };
  } else {
    throw new ProviderConnectionError("Provider connection probe protocol is unavailable", "provider_connection_unavailable");
  }
  return {
    url: `${probe.baseUrl.replace(/\/$/u, "")}${path}`,
    init: { method: "POST", headers, body: JSON.stringify(body) },
  };
}

function connectionModelCatalogRequest(
  providerId: ProviderConnectionProviderId,
  endpointUrl: string | null,
  apiKey: string,
): { url: string; init: RequestInit } {
  if (isBuiltInRuntimeGatewayProviderId(providerId)) {
    if (!endpointUrl) {
      throw new ProviderConnectionError("Provider connection configuration is incomplete", "provider_connection_unavailable");
    }
    const headers: Record<string, string> = providerId === "anthropic-compatible"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${apiKey}` };
    return { url: `${endpointUrl.replace(/\/$/u, "")}/models`, init: { headers } };
  }

  const probe = PI_BUILTIN_PROVIDER_CONNECTION_PROBES[providerId];
  if (!probe) {
    throw new ProviderConnectionError("Provider connection model catalog is unavailable", "provider_connection_unavailable");
  }
  const headers: Record<string, string> = { ...probe.headers };
  let path = "/models";
  if (probe.api === "anthropic-messages") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    if (providerId === "anthropic") path = "/v1/models";
  } else if (probe.api === "google-generative-ai") {
    headers["x-goog-api-key"] = apiKey;
    path = "/models?pageSize=200";
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return { url: `${probe.baseUrl.replace(/\/$/u, "")}${path}`, init: { headers } };
}

function modelIdsFromCatalog(providerId: ProviderConnectionProviderId, payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as { data?: unknown; models?: unknown };
  const rawModels = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const ids = rawModels.flatMap((entry): string[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const raw = (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name;
    if (typeof raw !== "string") return [];
    const normalized = providerId === "google" && raw.startsWith("models/") ? raw.slice("models/".length) : raw;
    try {
      return [normalizeTestModel(normalized)];
    } catch {
      return [];
    }
  });
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right)).slice(0, MAX_MODEL_OPTIONS);
}

export async function resolveProviderConnectionLaunchEnv(input: {
  serverId: string;
  agentId: string;
  connectionId: string;
}): Promise<Record<string, string>> {
  return (await resolveProviderConnectionLaunch(input)).envVars;
}

export async function resolveProviderConnectionLaunch(input: {
  serverId: string;
  agentId: string;
  connectionId: string;
}): Promise<{
  envVars: Record<string, string>;
  providerConnection: ProviderConnectionLaunchProjection;
}> {
  const [row] = await getDb().select({
    assignment: agentProviderConnections,
    connection: providerConnections,
    credential: providerConnectionCredentials,
  }).from(agentProviderConnections)
    .innerJoin(providerConnections, and(
      eq(providerConnections.serverId, agentProviderConnections.serverId),
      eq(providerConnections.id, agentProviderConnections.connectionId),
    ))
    .innerJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, agentProviderConnections.serverId),
      eq(providerConnectionCredentials.connectionId, agentProviderConnections.connectionId),
    ))
    .where(and(
      eq(agentProviderConnections.serverId, input.serverId),
      eq(agentProviderConnections.agentId, input.agentId),
      eq(agentProviderConnections.connectionId, input.connectionId),
    )).limit(1);
  if (
    !row
    || !row.connection.enabled
    || row.assignment.expectedConfigVersion !== row.connection.configVersion
    || row.assignment.expectedCredentialVersion !== row.credential.credentialVersion
  ) {
    throw new ProviderConnectionError("Provider connection assignment is stale or unavailable", "provider_connection_unavailable");
  }
  const apiKey = decryptApiKey(row.credential.encryptedApiKey, `${input.serverId}:${input.connectionId}`);
  return {
    envVars: connectionEnv(row.connection.providerId, row.connection.endpointUrl, apiKey),
    providerConnection: {
      providerId: row.connection.providerId,
      endpointUrl: row.connection.endpointUrl,
      supportsImageInput: row.connection.supportsImageInput,
    },
  };
}

/**
 * Probe-scoped materialization: credential env + projection for one connection
 * WITHOUT the enabled/ready/assignment gates, because a Computer probe is what
 * establishes verification before any of those can mean anything. Callers must
 * already hold a one-time claim (providerProbeService); the env carries the
 * decrypted key and must never be logged, audited or persisted.
 */
let probeMaterializationCalls = 0;

/** Test seam: count credential-decrypting materializations (0-credential teeth). */
export function __providerConnectionProbeMaterializationCallCount(): number {
  return probeMaterializationCalls;
}

export function __resetProviderConnectionProbeMaterializationCallCount(): void {
  probeMaterializationCalls = 0;
}

export async function resolveProviderConnectionProbeMaterialization(input: {
  serverId: string;
  connectionId: string;
}): Promise<{
  envVars: Record<string, string>;
  providerConnection: ProviderConnectionLaunchProjection;
  envKeyNames: string[];
  configVersion: number;
  credentialVersion: number;
}> {
  const [row] = await getDb().select({
    connection: providerConnections,
    credential: providerConnectionCredentials,
  }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
    eq(providerConnectionCredentials.serverId, providerConnections.serverId),
    eq(providerConnectionCredentials.connectionId, providerConnections.id),
  )).where(and(
    eq(providerConnections.serverId, input.serverId),
    eq(providerConnections.id, input.connectionId),
  )).limit(1);
  if (!row) throw new ProviderConnectionError("Provider connection not found", "provider_connection_not_found");
  probeMaterializationCalls += 1;
  const apiKey = decryptApiKey(row.credential.encryptedApiKey, `${input.serverId}:${input.connectionId}`);
  const envVars = connectionEnv(row.connection.providerId, row.connection.endpointUrl, apiKey);
  return {
    envVars,
    providerConnection: {
      providerId: row.connection.providerId,
      endpointUrl: row.connection.endpointUrl,
      supportsImageInput: row.connection.supportsImageInput,
    },
    envKeyNames: Object.keys(envVars).sort(),
    configVersion: row.connection.configVersion,
    credentialVersion: row.credential.credentialVersion,
  };
}

export async function listProviderConnectionModels(input: {
  serverId: string;
  connectionId: string;
}): Promise<{ models: string[] }> {
  // Wave 3 retirement: with enforcement on, the Server no longer performs any
  // provider I/O for discovery; verification happens on a Computer instead.
  if (await isProviderProbeEnforcementEnabled(input.serverId)) {
    throw new ProviderConnectionError(
      "Provider discovery is retired; verify on a Computer instead",
      "provider_connection_retired",
    );
  }
  const [row] = await getDb().select({ connection: providerConnections, credential: providerConnectionCredentials })
    .from(providerConnections)
    .innerJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, providerConnections.serverId),
      eq(providerConnectionCredentials.connectionId, providerConnections.id),
    ))
    .where(and(eq(providerConnections.serverId, input.serverId), eq(providerConnections.id, input.connectionId)))
    .limit(1);
  if (!row) throw new ProviderConnectionError("Provider connection not found", "provider_connection_not_found");
  const apiKey = decryptApiKey(row.credential.encryptedApiKey, `${input.serverId}:${input.connectionId}`);
  const safeFetch = testFetchFactory?.() ?? createSafeFetch();
  const controller = new AbortController();
  const timeout = setClockTimeout(() => controller.abort(), 8_000);
  try {
    const request = connectionModelCatalogRequest(row.connection.providerId, row.connection.endpointUrl, apiKey);
    validateManagedMcpEndpoint(request.url);
    const response = await safeFetch.fetch(request.url, { ...request.init, signal: controller.signal });
    if (!response.ok) {
      throw new ProviderConnectionError("Provider model catalog request failed", "provider_connection_model_list_failed");
    }
    const models = modelIdsFromCatalog(row.connection.providerId, await response.json());
    if (models.length === 0) {
      throw new ProviderConnectionError("Provider returned no usable models", "provider_connection_model_list_failed");
    }
    return { models };
  } catch (error) {
    if (error instanceof ProviderConnectionError) throw error;
    throw new ProviderConnectionError("Provider model catalog request failed", "provider_connection_model_list_failed");
  } finally {
    clearClockTimeout(timeout);
    await safeFetch.close();
  }
}

export async function testProviderConnection(input: {
  serverId: string;
  userId: string;
  connectionId: string;
  model?: unknown;
  message?: unknown;
}): Promise<ProviderConnectionSummary> {
  // Wave 3 retirement: with enforcement on, the Server no longer performs any
  // provider I/O for tests; verification happens on a Computer instead.
  if (await isProviderProbeEnforcementEnabled(input.serverId)) {
    throw new ProviderConnectionError(
      "Server-side provider tests are retired; verify on a Computer instead",
      "provider_connection_retired",
    );
  }
  const [row] = await getDb().select({ connection: providerConnections, credential: providerConnectionCredentials })
    .from(providerConnections)
    .innerJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, providerConnections.serverId),
      eq(providerConnectionCredentials.connectionId, providerConnections.id),
    ))
    .where(and(eq(providerConnections.serverId, input.serverId), eq(providerConnections.id, input.connectionId)))
    .limit(1);
  if (!row) throw new ProviderConnectionError("Provider connection not found", "provider_connection_not_found");
  const apiKey = decryptApiKey(row.credential.encryptedApiKey, `${input.serverId}:${input.connectionId}`);
  const safeFetch = testFetchFactory?.() ?? createSafeFetch();
  const controller = new AbortController();
  const timeout = setClockTimeout(() => controller.abort(), 8_000);
  let ok = false;
  try {
    const request = connectionTestRequest(
      row.connection.providerId,
      row.connection.endpointUrl,
      apiKey,
      input.model,
      input.message,
    );
    validateManagedMcpEndpoint(request.url);
    const response = await safeFetch.fetch(request.url, {
      ...request.init,
      signal: controller.signal,
    });
    ok = response.ok;
  } catch {
    ok = false;
  } finally {
    clearClockTimeout(timeout);
    await safeFetch.close();
  }
  const status = ok ? "ready" : "error";
  await getDb().transaction(async (tx) => {
    const [current] = await tx.select({
      configVersion: providerConnections.configVersion,
      credentialVersion: providerConnectionCredentials.credentialVersion,
    }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, providerConnections.serverId),
      eq(providerConnectionCredentials.connectionId, providerConnections.id),
    )).where(and(
      eq(providerConnections.serverId, input.serverId),
      eq(providerConnections.id, input.connectionId),
    )).limit(1).for("update");
    if (
      !current
      || current.configVersion !== row.connection.configVersion
      || current.credentialVersion !== row.credential.credentialVersion
    ) {
      throw new ProviderConnectionError(
        "Provider connection changed while the test was running",
        "provider_connection_unavailable",
      );
    }
    await tx.update(providerConnections).set({
      status,
      lastCheckedAt: currentDate(),
      lastErrorCategory: ok ? null : "connection_test_failed",
      updatedAt: currentDate(),
    }).where(and(
      eq(providerConnections.serverId, input.serverId),
      eq(providerConnections.id, input.connectionId),
    ));
    await recordIntegrationAuditEvent({
      serverId: input.serverId,
      eventType: "provider_connection.tested",
      outcome: ok ? "success" : "failure",
      source: "web",
      actor: { type: "human", id: input.userId },
      target: { type: "provider_connection", id: input.connectionId },
      metadata: {
        configVersion: row.connection.configVersion,
        credentialVersion: row.credential.credentialVersion,
        status,
      },
    }, tx);
  });
  if (!ok) throw new ProviderConnectionError("Provider connection test failed", "provider_connection_test_failed");
  const result = (await listProviderConnections(input.serverId)).find((connection) => connection.id === input.connectionId);
  if (!result) throw new ProviderConnectionError("Provider connection not found", "provider_connection_not_found");
  return result;
}

