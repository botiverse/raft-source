import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { integrationAuditEvents, oauthClients, servers, users } from "../db/schema.js";

export const INTEGRATION_AUDIT_EVENT_TYPES = [
  "app.registered",
  "app.updated",
  "app.owner_transferred",
  "app.deleted",
  "app.publish_requested",
  "app.publish_approved",
  "app.publish_rejected",
  "app.offline_requested",
  "app.offline_approved",
  "app.offline_rejected",
  "marketplace.installed",
  "marketplace.uninstalled",
  "client.secret_rotated",
  "action_card.executed",
  "oauth.redirect_mismatch",
  "oauth.lifecycle",
  "oauth.token_exchange_failed",
  "private_share.link_created",
  "private_share.link_revoked",
  "private_share.installed",
  "private_share.uninstalled",
  "app.outbound_permission_requested",
  "app.outbound_permission_approved",
  "installation.outbound_grant_updated",
  "installation.outbound_subscription_updated",
  "installation.token_issued",
  "webhook.configured",
  "webhook.rotated",
  "webhook.disabled",
  "managed_mcp.tool_invocation_admitted",
  "provider_connection.created",
  "provider_connection.updated",
  "provider_connection.credential_rotated",
  "provider_connection.tested",
  "provider_connection.deleted",
] as const;

export type IntegrationAuditEventType = (typeof INTEGRATION_AUDIT_EVENT_TYPES)[number];
export type IntegrationAuditOutcome = "success" | "failure";
export type IntegrationAuditSource = "web" | "api" | "cli" | "action_card" | "system";
export type IntegrationAuditActorType = "human" | "agent" | "system";
export type IntegrationAuditSubjectType = "human" | "agent" | "app" | "system";
export type IntegrationAuditEventCategory = "registration" | "scope" | "install" | "runtime" | "revocation";

type AuditMetadata = Record<string, unknown>;
type AuditDiff = Record<string, unknown>;

const EVENT_METADATA_ALLOWLIST: Record<IntegrationAuditEventType, readonly string[]> = {
  "app.registered": ["appType", "clientKey", "name", "hasReturnUrl", "hasHomepageUrl", "hasAgentManifestUrl"],
  "app.updated": ["changedFields", "clientKey", "appType"],
  "app.owner_transferred": ["clientKey", "previousOwnerType", "previousOwnerId", "nextOwnerType", "nextOwnerId", "recovery", "ownershipOutcome", "actorAuthority"],
  "app.deleted": ["clientKey", "appType", "publishStatus"],
  "app.publish_requested": ["clientKey", "appType", "previousPublishStatus", "nextPublishStatus"],
  "app.publish_approved": ["clientKey", "appType", "previousPublishStatus", "nextPublishStatus", "installedCount"],
  "app.publish_rejected": ["clientKey", "appType", "previousPublishStatus", "nextPublishStatus"],
  "app.offline_requested": ["clientKey", "appType", "previousPublishStatus"],
  "app.offline_approved": ["clientKey", "appType", "previousPublishStatus", "nextPublishStatus", "removedInstallCount", "revokedGrantCount", "revokedTokenCount", "deniedPendingRequestCount"],
  "app.offline_rejected": ["clientKey", "appType", "previousPublishStatus", "nextPublishStatus"],
  "marketplace.installed": ["clientKey", "targetServerId"],
  "marketplace.uninstalled": ["clientKey", "targetServerId", "revokedGrantCount", "revokedTokenCount", "deniedPendingRequestCount"],
  "client.secret_rotated": ["clientKey", "appType"],
  "action_card.executed": ["actionType", "clientKey", "mode"],
  "oauth.redirect_mismatch": ["clientKey", "errorCode"],
  "oauth.lifecycle": ["clientKey", "stage", "result", "grantType", "principalType", "errorClass"],
  "oauth.token_exchange_failed": ["clientKey", "grantType", "errorCode", "requestIdHash"],
  "private_share.link_created": ["clientKey", "shareLinkId", "expiresAt", "convertedFromServerLocal"],
  "private_share.link_revoked": ["clientKey", "shareLinkId"],
  "private_share.installed": ["clientKey", "shareLinkId", "sourceServerId", "targetServerId"],
  "private_share.uninstalled": ["clientKey", "targetServerId", "revokedGrantCount", "revokedTokenCount", "deniedPendingRequestCount"],
  "app.outbound_permission_requested": ["clientKey", "revision", "state", "groupCount", "eventCount", "invalidatedInstallationCount"],
  "app.outbound_permission_approved": ["clientKey", "revision", "groupCount", "eventCount"],
  "installation.outbound_grant_updated": ["clientKey", "installationId", "grantRevision", "groupCount", "eventCount"],
  "installation.outbound_subscription_updated": ["clientKey", "installationId", "subscriptionRevision", "eventCount"],
  "installation.token_issued": ["clientKey", "installationId", "grantRevision", "audience", "expiresAt"],
  "webhook.configured": ["clientKey", "configRevision", "endpointOrigin"],
  "webhook.rotated": ["clientKey", "configRevision", "endpointOrigin", "previousValidUntil", "emergency"],
  "webhook.disabled": ["clientKey", "configRevision"],
  "managed_mcp.tool_invocation_admitted": ["toolName"],
  "provider_connection.created": ["providerId", "configVersion", "credentialVersion", "status"],
  "provider_connection.updated": ["changedFields", "configVersion", "enabled"],
  "provider_connection.credential_rotated": ["configVersion", "credentialVersion", "status"],
  "provider_connection.tested": ["configVersion", "credentialVersion", "status"],
  "provider_connection.deleted": ["providerId", "configVersion", "credentialVersion"],
};

const EVENT_CATEGORY: Record<IntegrationAuditEventType, IntegrationAuditEventCategory> = {
  "app.registered": "registration",
  "app.updated": "registration",
  "app.owner_transferred": "registration",
  "app.deleted": "revocation",
  "app.publish_requested": "registration",
  "app.publish_approved": "registration",
  "app.publish_rejected": "registration",
  "app.offline_requested": "revocation",
  "app.offline_approved": "revocation",
  "app.offline_rejected": "revocation",
  "marketplace.installed": "install",
  "marketplace.uninstalled": "revocation",
  "client.secret_rotated": "revocation",
  "action_card.executed": "runtime",
  "oauth.redirect_mismatch": "runtime",
  "oauth.lifecycle": "runtime",
  "oauth.token_exchange_failed": "runtime",
  "private_share.link_created": "install",
  "private_share.link_revoked": "revocation",
  "private_share.installed": "install",
  "private_share.uninstalled": "revocation",
  "app.outbound_permission_requested": "scope",
  "app.outbound_permission_approved": "scope",
  "installation.outbound_grant_updated": "scope",
  "installation.outbound_subscription_updated": "scope",
  "installation.token_issued": "runtime",
  "webhook.configured": "runtime",
  "webhook.rotated": "revocation",
  "webhook.disabled": "revocation",
  "managed_mcp.tool_invocation_admitted": "runtime",
  "provider_connection.created": "registration",
  "provider_connection.updated": "registration",
  "provider_connection.credential_rotated": "revocation",
  "provider_connection.tested": "runtime",
  "provider_connection.deleted": "revocation",
};

const DIFF_ALLOWLIST = new Set([
  "name",
  "description",
  "homepageUrl",
  "returnUrl",
  "agentManifestUrl",
  "allowedScopes",
  "category",
  "logoUrl",
  "enabled",
  "humanMarketplaceVisible",
  "publishStatus",
]);

const CREDENTIAL_KEY_PATTERN = /(^|_)(authorization|bearer|client_secret|code|cookie|jwt|password|secret|token)(_|$)/i;
const CREDENTIAL_VALUE_PATTERN = /(?:sk_(?:agent|machine)_[A-Za-z0-9_-]+|(?:slock|raft)_secret_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~+/-]+=*|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/;

export class IntegrationAuditValidationError extends Error {}

function assertKnownEventType(eventType: string): asserts eventType is IntegrationAuditEventType {
  if (!(INTEGRATION_AUDIT_EVENT_TYPES as readonly string[]).includes(eventType)) {
    throw new IntegrationAuditValidationError(`Unknown integration audit event type: ${eventType}`);
  }
}

function isSafeValue(value: unknown): boolean {
  if (typeof value === "string") {
    return !CREDENTIAL_VALUE_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.every(isSafeValue);
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).every(([key, nested]) => (
      !CREDENTIAL_KEY_PATTERN.test(key) && isSafeValue(nested)
    ));
  }
  return true;
}

export function sanitizeIntegrationAuditMetadata(
  eventType: IntegrationAuditEventType,
  metadata: AuditMetadata | null | undefined,
): AuditMetadata {
  const allowed = new Set(EVENT_METADATA_ALLOWLIST[eventType]);
  const safe: AuditMetadata = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!allowed.has(key) || CREDENTIAL_KEY_PATTERN.test(key) || !isSafeValue(value)) continue;
    safe[key] = value;
  }
  return safe;
}

export function sanitizeIntegrationAuditDiff(diff: AuditDiff | null | undefined): AuditDiff | null {
  const safe: AuditDiff = {};
  for (const [key, value] of Object.entries(diff ?? {})) {
    if (!DIFF_ALLOWLIST.has(key) || CREDENTIAL_KEY_PATTERN.test(key) || !isSafeValue(value)) continue;
    safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

export async function recordIntegrationAuditEvent(input: {
  serverId?: string | null;
  clientId?: string | null;
  eventType: IntegrationAuditEventType;
  outcome: IntegrationAuditOutcome;
  source: IntegrationAuditSource;
  actor: { type: IntegrationAuditActorType; id?: string | null };
  requester?: { type: IntegrationAuditSubjectType; id?: string | null } | null;
  subject?: { type: IntegrationAuditSubjectType; id?: string | null } | null;
  target: { type: string; id?: string | null };
  correlationId?: string | null;
  requestId?: string | null;
  metadata?: AuditMetadata | null;
  diff?: AuditDiff | null;
}, dbOrTx: ReturnType<typeof getDb> = getDb()) {
  assertKnownEventType(input.eventType);
  const [created] = await dbOrTx.insert(integrationAuditEvents).values({
    serverId: input.serverId ?? null,
    clientId: input.clientId ?? null,
    eventType: input.eventType,
    eventCategory: EVENT_CATEGORY[input.eventType],
    outcome: input.outcome,
    source: input.source,
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    requesterType: input.requester?.type ?? null,
    requesterId: input.requester?.id ?? null,
    subjectType: input.subject?.type ?? null,
    subjectId: input.subject?.id ?? null,
    targetType: input.target.type,
    targetId: input.target.id ?? null,
    correlationId: input.correlationId ?? null,
    requestId: input.requestId ?? null,
    metadata: sanitizeIntegrationAuditMetadata(input.eventType, input.metadata),
    diff: sanitizeIntegrationAuditDiff(input.diff),
  }).returning();
  return created;
}

export async function recordIntegrationAuditEventBestEffort(
  input: Parameters<typeof recordIntegrationAuditEvent>[0],
  dbOrTx: ReturnType<typeof getDb> = getDb(),
) {
  try {
    await recordIntegrationAuditEvent(input, dbOrTx);
  } catch (err) {
    console.warn("[integration-audit] audit_write_failed", err instanceof Error ? err.message : err);
  }
}

export function redactIntegrationAuditEventForAppAdmin<T extends {
  eventType: string;
  correlationId: string | null;
  requestId: string | null;
  metadata: unknown;
}>(event: T): T {
  if (event.eventType !== "oauth.token_exchange_failed") {
    return event;
  }
  const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
    ? Object.fromEntries(
        Object.entries(event.metadata as Record<string, unknown>).filter(([key]) => key !== "requestIdHash"),
      )
    : event.metadata;
  return {
    ...event,
    correlationId: null,
    requestId: null,
    metadata,
  };
}

export async function listIntegrationAuditEventsForAppAdmin(limit = 100) {
  const safeLimit = Math.max(1, Math.min(limit, 250));
  const rows = await getDb().select({
    id: integrationAuditEvents.id,
    serverId: integrationAuditEvents.serverId,
    serverName: servers.name,
    serverSlug: servers.slug,
    clientId: integrationAuditEvents.clientId,
    clientKey: oauthClients.clientId,
    clientName: oauthClients.name,
    eventType: integrationAuditEvents.eventType,
    eventCategory: integrationAuditEvents.eventCategory,
    outcome: integrationAuditEvents.outcome,
    source: integrationAuditEvents.source,
    actorType: integrationAuditEvents.actorType,
    actorId: integrationAuditEvents.actorId,
    actorName: users.name,
    actorDisplayName: users.displayName,
    requesterType: integrationAuditEvents.requesterType,
    requesterId: integrationAuditEvents.requesterId,
    subjectType: integrationAuditEvents.subjectType,
    subjectId: integrationAuditEvents.subjectId,
    targetType: integrationAuditEvents.targetType,
    targetId: integrationAuditEvents.targetId,
    correlationId: integrationAuditEvents.correlationId,
    requestId: integrationAuditEvents.requestId,
    metadata: integrationAuditEvents.metadata,
    diff: integrationAuditEvents.diff,
    createdAt: integrationAuditEvents.createdAt,
  })
    .from(integrationAuditEvents)
    .leftJoin(oauthClients, eq(oauthClients.id, integrationAuditEvents.clientId))
    .leftJoin(servers, eq(servers.id, integrationAuditEvents.serverId))
    .leftJoin(users, eq(users.id, integrationAuditEvents.actorId))
    .orderBy(desc(integrationAuditEvents.createdAt))
    .limit(safeLimit);
  return rows.map(redactIntegrationAuditEventForAppAdmin);
}
