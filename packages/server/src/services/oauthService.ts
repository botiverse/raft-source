import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import sharp from "sharp";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, not, or, sql, type SQL } from "drizzle-orm";
import {
  isSafeOAuthReturnUrl,
  RAFT_OAUTH_DEFAULT_ALLOWED_SCOPES,
  RAFT_OAUTH_PUBLIC_DISCOVERY_SCOPES,
  LEGACY_OAUTH_CLIENT_CATEGORY_ALIASES,
  OAUTH_CLIENT_CATEGORIES,
  canonicalizeOAuthClientCategory,
  currentDate,
  type AgentMessage,
  type OAuthClientCategory,
  isRaftOAuthScope,
  raftOAuthScopeRequiresResource,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import {
  agents,
  integrationAuditEvents,
  oauthClientInstalls,
  oauthClientShareLinks,
  oauthAccessRequests,
  oauthAccessTokens,
  oauthClientMaintainers,
  oauthClients,
  oauthGrants,
  serverAgentMembers,
  notificationDeliveries,
  notificationRecipients,
  serverMembers,
  servers,
  thirdPartyAgentEvents,
  users,
} from "../db/schema.js";
import { getThumbnailUrl } from "../routes/attachments.js";
import {
  sendAppReviewRequestEmail,
  type AppReviewRequestEmailInput,
} from "./emailService.js";
import { getCdnStorage, getStorage } from "./storageService.js";
import * as integrationAuditService from "./integrationAuditService.js";
import {
  oauthClientIdIsUserManagedPredicate,
  oauthClientIsUserManagedPredicate,
} from "./oauthClientManagementPolicy.js";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const HUMAN_AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
export const AUTHORIZATION_CODE_EXPIRED_ERROR = "authorization_code_expired";
const CLIENT_ID_REGEX = /^[a-z][a-z0-9-]{2,63}$/;
const WELL_KNOWN_AGENT_MANIFEST_PATH = "/.well-known/raft-agent-manifest.json";
const INTEGRATION_LOGO_SIZE = 256;
const THIRD_PARTY_EVENT_MAX_PAYLOAD_BYTES = 32 * 1024;
const THIRD_PARTY_EVENT_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const THIRD_PARTY_EVENT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
let getDbForService = getDb;
let sendAppReviewRequestEmailForService = sendAppReviewRequestEmail;

export const PUBLIC_RAFT_OAUTH_SCOPES = RAFT_OAUTH_PUBLIC_DISCOVERY_SCOPES;

const INTERNAL_RAFT_OAUTH_SCOPES = [] as const;

const LEGACY_OAUTH_SCOPE_ALLOWLIST: Record<string, readonly string[]> = {
  "local-collabdoc-1": ["creator", "owner"],
  "linkerdog-796e47": ["meetings:read"],
  winbox: [
    "winbox:opencli:google",
    "winbox:opencli:nga",
    "winbox:opencli:qixin",
    "winbox:opencli:twitter",
  ],
  "winbox-315c18": [
    "winbox:opencli:nga",
    "winbox:opencli:qixin",
    "winbox:opencli:slock",
    "winbox:opencli:twitter",
    "winbox:opencli:wcl",
    "winbox:python:exec",
  ],
};

export function __setOAuthServiceDbForTests(mockGetDb: typeof getDb) {
  getDbForService = mockGetDb;
}

export function __resetOAuthServiceDbForTests() {
  getDbForService = getDb;
  sendAppReviewRequestEmailForService = sendAppReviewRequestEmail;
}

export function __setOAuthServiceReviewEmailSenderForTests(
  sender: typeof sendAppReviewRequestEmail,
) {
  sendAppReviewRequestEmailForService = sender;
}

export type OAuthRequestStatus = "pending" | "approved" | "denied";

export type IntegrationOverviewItem = {
  id: string;
  type: "pending" | "active";
  serverId: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string | null;
  clientId: string;
  clientKey: string;
  clientName: string;
  clientDescription: string | null;
  clientHomepageUrl: string | null;
  clientReturnUrl: string | null;
  clientAgentManifestUrl: string | null;
  scopes: string[];
  remember: boolean;
  createdAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  revokedAt: string | null;
};

export type OAuthClientRecord = {
  id: string;
  serverId: string;
  clientId: string;
  appType: OAuthClientAppType;
  publishStatus: OAuthClientPublishStatus;
  category: OAuthClientCategory;
  dataAccessSummary: string | null;
  publishRejectionReason: string | null;
  name: string;
  description: string | null;
  homepageUrl: string | null;
  returnUrl: string | null;
  agentManifestUrl: string | null;
  allowedScopes: string[] | null;
  logoUrl: string | null;
  humanMarketplaceVisible: boolean;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type MarketplaceOAuthClientRecord = OAuthClientRecord & {
  installedAt: Date | null;
  marketplaceInstallBadge: MarketplaceInstallBadge;
  publisherName: string | null;
  publisherServerName: string | null;
  privateShared: boolean;
  appNotificationGroups: string[];
  appNotificationEvents: string[];
  appNotificationReviewPending: boolean;
};

export type MarketplaceInstallBadge =
  | { kind: "new" }
  | { kind: "bucket"; bucket: "10_plus" | "100_plus" | "1k_plus" }
  | { kind: "none" };

const MARKETPLACE_NEW_BADGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function projectMarketplaceInstallBadge(input: {
  effectiveInstallCount: number;
  publishedAt: Date;
  now?: Date;
}): MarketplaceInstallBadge {
  const { effectiveInstallCount, publishedAt, now = currentDate() } = input;
  if (!Number.isInteger(effectiveInstallCount) || effectiveInstallCount < 0) {
    throw new Error("effectiveInstallCount must be a non-negative integer");
  }
  if (effectiveInstallCount >= 1000) return { kind: "bucket", bucket: "1k_plus" };
  if (effectiveInstallCount >= 100) return { kind: "bucket", bucket: "100_plus" };
  if (effectiveInstallCount >= 10) return { kind: "bucket", bucket: "10_plus" };

  const publishedAgeMs = Math.max(0, now.getTime() - publishedAt.getTime());
  return publishedAgeMs <= MARKETPLACE_NEW_BADGE_MAX_AGE_MS
    ? { kind: "new" }
    : { kind: "none" };
}
export type OAuthClientShareLinkRecord = {
  id: string;
  clientId: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
export type OAuthClientShareInvite = {
  client: OAuthClientRecord & {
    publisherName: string | null;
    sourceServerName: string | null;
    installedAt: Date | null;
  };
  link: OAuthClientShareLinkRecord;
  manageableServers: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
    installedAt: Date | null;
  }>;
};

export type OAuthClientAppType = "server_local" | "slock_builtin" | "third_party_global";
export type ThirdPartyAgentEventKind = "event" | "notification" | "action_request";
type ThirdPartyAgentEventRecord = typeof thirdPartyAgentEvents.$inferSelect;
// Single source of truth for the OAuth client publish status: the marketplace
// review lifecycle.
export const OAUTH_CLIENT_PUBLISH_STATUSES = ["private", "publish_requested", "in_review", "published", "rejected", "unpublish_requested"] as const;
export type OAuthClientPublishStatus = (typeof OAUTH_CLIENT_PUBLISH_STATUSES)[number];
export type AgentManifestUrlSource = "explicit" | "well_known";
type AuthenticatedClient = OAuthClientRecord;
type OAuthPrincipalType = "agent" | "human";

function isServerLocalAppForServerPredicate(serverId: string) {
  return and(
    eq(oauthClients.serverId, serverId),
    eq(oauthClients.appType, "server_local"),
  );
}

function isLiveBuiltInAppPredicate() {
  return and(
    eq(oauthClients.enabled, true),
    eq(oauthClients.publishStatus, "published"),
    eq(oauthClients.appType, "slock_builtin"),
  );
}

function isInstalledThirdPartyAppPredicate() {
  return and(
    eq(oauthClients.appType, "third_party_global"),
    eq(oauthClients.enabled, true),
    isNotNull(oauthClientInstalls.id),
  );
}

function isPublicMarketplaceLifecycle(status: OAuthClientPublishStatus) {
  return status === "published" || status === "unpublish_requested";
}

function isSourceOwnedEditableAppPredicate(serverId: string) {
  return and(
    eq(oauthClients.serverId, serverId),
    oauthClientIsUserManagedPredicate(),
    or(
      eq(oauthClients.appType, "server_local"),
      eq(oauthClients.appType, "third_party_global"),
    ),
    or(
      eq(oauthClients.publishStatus, "private"),
      eq(oauthClients.publishStatus, "publish_requested"),
      eq(oauthClients.publishStatus, "in_review"),
      eq(oauthClients.publishStatus, "published"),
      eq(oauthClients.publishStatus, "rejected"),
      eq(oauthClients.publishStatus, "unpublish_requested"),
    ),
  );
}

function isSourceOwnedLogoEditableAppPredicate(serverId: string) {
  return and(
    eq(oauthClients.serverId, serverId),
    oauthClientIsUserManagedPredicate(),
    or(
      eq(oauthClients.appType, "server_local"),
      and(
        eq(oauthClients.appType, "third_party_global"),
        or(
          eq(oauthClients.publishStatus, "private"),
          eq(oauthClients.publishStatus, "publish_requested"),
          eq(oauthClients.publishStatus, "in_review"),
          eq(oauthClients.publishStatus, "published"),
          eq(oauthClients.publishStatus, "rejected"),
          eq(oauthClients.publishStatus, "unpublish_requested"),
        ),
      ),
    ),
  );
}

const canonicalOAuthClientCategorySql = sql<OAuthClientCategory>`case
  ${sql.join([
    ...OAUTH_CLIENT_CATEGORIES.map((category) => sql`when ${oauthClients.category} = ${category} then ${category}`),
    ...Object.entries(LEGACY_OAUTH_CLIENT_CATEGORY_ALIASES).map(
      ([legacy, canonical]) => sql`when ${oauthClients.category} = ${legacy} then ${canonical}`,
    ),
  ], sql.raw(" "))}
  else ${"Other"}
end`;

const OAUTH_CLIENT_PUBLIC_COLUMNS = {
  id: oauthClients.id,
  serverId: oauthClients.serverId,
  clientId: oauthClients.clientId,
  appType: oauthClients.appType,
  publishStatus: oauthClients.publishStatus,
  category: canonicalOAuthClientCategorySql,
  dataAccessSummary: oauthClients.dataAccessSummary,
  publishRejectionReason: oauthClients.publishRejectionReason,
  name: oauthClients.name,
  description: oauthClients.description,
  homepageUrl: oauthClients.homepageUrl,
  returnUrl: oauthClients.returnUrl,
  agentManifestUrl: oauthClients.agentManifestUrl,
  allowedScopes: oauthClients.allowedScopes,
  logoUrl: oauthClients.logoUrl,
  humanMarketplaceVisible: oauthClients.humanMarketplaceVisible,
  createdByUserId: oauthClients.createdByUserId,
  createdAt: oauthClients.createdAt,
  updatedAt: oauthClients.updatedAt,
};

const OAUTH_CLIENT_REVIEW_REQUEST_COLUMNS = {
  ...OAUTH_CLIENT_PUBLIC_COLUMNS,
  publishRequestedAt: oauthClients.publishRequestedAt,
};

const OAUTH_CLIENT_SHARE_LINK_PUBLIC_COLUMNS = {
  id: oauthClientShareLinks.id,
  clientId: oauthClientShareLinks.clientId,
  expiresAt: oauthClientShareLinks.expiresAt,
  revokedAt: oauthClientShareLinks.revokedAt,
  lastUsedAt: oauthClientShareLinks.lastUsedAt,
  createdAt: oauthClientShareLinks.createdAt,
  updatedAt: oauthClientShareLinks.updatedAt,
};

function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function generateOAuthClientSecret() {
  return `raft_secret_${randomBytes(24).toString("hex")}`;
}

function safeEqualHash(expectedHash: string, raw: string) {
  const left = Buffer.from(expectedHash, "hex");
  const right = Buffer.from(hashSecret(raw), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeScopeValues(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) {
    throw new Error("scopes must be an array");
  }

  const normalized = Array.from(new Set(
    scopes.map((scope) => {
      if (typeof scope !== "string") {
        throw new Error("scopes must contain strings");
      }
      const trimmed = scope.trim();
      if (!trimmed) {
        throw new Error("scope values must be non-empty");
      }
      return trimmed;
    }),
  )).sort();

  if (normalized.length === 0) {
    throw new Error("at least one scope is required");
  }

  return normalized;
}

function scopeSetContains(values: readonly string[], scope: string) {
  return values.includes(scope);
}

function isAllowedInternalScope(_client: Pick<OAuthClientRecord, "clientId">, scope: string) {
  return scopeSetContains(INTERNAL_RAFT_OAUTH_SCOPES, scope) && false;
}

function isGrandfatheredLegacyScope(client: Pick<OAuthClientRecord, "clientId">, scope: string) {
  return (LEGACY_OAUTH_SCOPE_ALLOWLIST[client.clientId] ?? []).includes(scope);
}

function isScopeAllowedForClient(
  client: Pick<OAuthClientRecord, "clientId" | "allowedScopes">,
  scope: string,
) {
  const allowed = allowedScopesForClient(client);
  return (
    (isRaftOAuthScope(scope) && scopeSetContains(allowed, scope))
    || isAllowedInternalScope(client, scope)
    || isGrandfatheredLegacyScope(client, scope)
  );
}

function normalizeAllowedScopes(scopes: unknown): string[] | null {
  if (scopes === undefined || scopes === null) return null;
  const normalized = normalizeScopeValues(scopes);
  const invalid = normalized.find((scope) => !isRaftOAuthScope(scope));
  if (invalid) {
    throw new Error("invalid_scope");
  }
  return normalized;
}

function allowedScopesForClient(client: Pick<OAuthClientRecord, "allowedScopes">): readonly string[] {
  return client.allowedScopes?.length ? client.allowedScopes : RAFT_OAUTH_DEFAULT_ALLOWED_SCOPES;
}

export function defaultAgentLoginScopes(
  client: Pick<OAuthClientRecord, "allowedScopes">,
): string[] {
  const allowed = allowedScopesForClient(client);
  return RAFT_OAUTH_DEFAULT_ALLOWED_SCOPES.filter((scope) => allowed.includes(scope));
}

export class OAuthScopeNotAllowedError extends Error {
  readonly validation: OAuthScopeValidation;

  constructor(validation: OAuthScopeValidation) {
    super("invalid_scope");
    this.name = "OAuthScopeNotAllowedError";
    this.validation = validation;
  }
}

export type OAuthScopeValidation = {
  allowed: boolean;
  reason: "not_allowed" | "unsupported" | "mixed" | null;
  disallowedScopes: string[];
};

export function validateOAuthScopesForClient(
  scopes: unknown,
  client: Pick<OAuthClientRecord, "clientId" | "allowedScopes">,
): OAuthScopeValidation {
  const disallowedScopes = normalizeScopeValues(scopes).filter((scope) => !isScopeAllowedForClient(client, scope));
  const hasUnsupported = disallowedScopes.some((scope) => !isRaftOAuthScope(scope));
  const hasNotAllowed = disallowedScopes.some((scope) => isRaftOAuthScope(scope));
  return {
    allowed: disallowedScopes.length === 0,
    reason: hasUnsupported && hasNotAllowed
      ? "mixed"
      : hasUnsupported
        ? "unsupported"
        : hasNotAllowed
          ? "not_allowed"
          : null,
    disallowedScopes,
  };
}

function normalizeScopes(scopes: unknown, client: Pick<OAuthClientRecord, "clientId" | "allowedScopes">): string[] {
  const normalized = normalizeScopeValues(scopes);
  const validation = validateOAuthScopesForClient(normalized, client);
  if (!validation.allowed) {
    throw new OAuthScopeNotAllowedError(validation);
  }
  return normalized;
}

export function normalizeAgentRequestedScopes(
  scopes: unknown,
  client: Pick<OAuthClientRecord, "clientId" | "allowedScopes">,
): string[] {
  return normalizeScopes(scopes, client);
}

function normalizeResourceIndicator(resource: unknown): string | null {
  if (resource === undefined || resource === null || resource === "") return null;
  if (Array.isArray(resource)) {
    if (resource.length !== 1) throw new Error("resource must be a single URI");
    return normalizeResourceIndicator(resource[0]);
  }
  if (typeof resource !== "string") {
    throw new Error("resource must be a URI string");
  }
  const trimmed = resource.trim();
  if (!trimmed) return null;
  if (trimmed.length > 512) {
    throw new Error("resource is too long");
  }
  try {
    new URL(trimmed);
  } catch {
    if (!/^urn:[A-Za-z0-9][A-Za-z0-9.+-]*:.+/.test(trimmed)) {
      throw new Error("resource must be an absolute URI");
    }
  }
  return trimmed;
}

function defaultAgentInboundResource(serverId: string): string {
  return `urn:raft:server:${serverId}:agent-inbound`;
}

function validateResourceForScopes(scopes: readonly string[], resource: string | null, serverId: string): string | null {
  const requiresResource = scopes.some((scope) => raftOAuthScopeRequiresResource(scope));
  if (!requiresResource) return resource;
  if (!resource) {
    throw new Error("resource is required for requested scopes");
  }
  const expected = defaultAgentInboundResource(serverId);
  if (resource !== expected) {
    throw new Error("resource does not match requested server");
  }
  return resource;
}

export function getAgentInboundOAuthResource(serverId: string): string {
  return defaultAgentInboundResource(serverId);
}

export function accessTokenHasScope(token: { scopes: string[] | null | undefined }, scope: string): boolean {
  return Boolean(token.scopes?.includes(scope));
}

function normalizeThirdPartyEventKind(value: unknown): Exclude<ThirdPartyAgentEventKind, "action_request"> {
  if (value === "event" || value === "notification") return value;
  throw new Error("event kind must be event or notification");
}

function normalizeThirdPartyEventSummary(value: unknown): string {
  if (typeof value !== "string") throw new Error("summary is required");
  const summary = value.trim().replace(/\s+/g, " ");
  if (!summary) throw new Error("summary is required");
  if (summary.length > 500) throw new Error("summary is too long");
  return summary;
}

function normalizeExternalEventId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("externalEventId must be a string");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 200) throw new Error("externalEventId is too long");
  return trimmed;
}

function normalizeThirdPartyEventPayload(value: unknown): { payload: Record<string, unknown>; payloadJson: string; payloadHash: string } {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  if (payloadBytes > THIRD_PARTY_EVENT_MAX_PAYLOAD_BYTES) {
    throw new Error("payload is too large");
  }
  return {
    payload,
    payloadJson,
    payloadHash: createHash("sha256").update(payloadJson).digest("hex"),
  };
}

function normalizeThirdPartyEventExpiresAt(value: unknown, now = new Date()): Date {
  const ttlSeconds = Number(value ?? THIRD_PARTY_EVENT_DEFAULT_TTL_MS / 1000);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("ttlSeconds must be positive");
  }
  const ttlMs = Math.min(Math.floor(ttlSeconds * 1000), THIRD_PARTY_EVENT_MAX_TTL_MS);
  return new Date(now.getTime() + ttlMs);
}

function hashStableSourceId(value: string | null): string | null {
  return value ? createHash("sha256").update(value).digest("hex") : null;
}

/**
 * Re-read ONE third-party event the acting agent already holds the address for.
 *
 * `raft message check` delivers the body once and advances the read cursor, so an
 * agent that was woken by an event and later needs it again had no way back --
 * `agent-event:<id8>` is printed in every rendered line but nothing implemented a
 * read for it (task #257).
 *
 * The query is scoped to the acting agent rather than filtering afterwards, so
 * "no such event" and "someone else's event" take the SAME code path and cannot
 * produce different responses. That is required, not stylistic: the read surface
 * is addressed by id, and any observable difference between those two cases turns
 * it into an enumeration oracle for other agents' events (#145 neutrality policy,
 * confirmed by @Tenny to cover id-addressed routes).
 */
export type ThirdPartyAgentEventRead =
  | { kind: "found"; message: AgentMessage }
  | { kind: "expired" }
  | { kind: "ambiguous" }
  | { kind: "absent" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHORT_ID_RE = /^[0-9a-f]{8}$/;

export async function readThirdPartyAgentEventForAgent(input: {
  agentId: string;
  ref: string;
}): Promise<ThirdPartyAgentEventRead> {
  const ref = input.ref.trim().toLowerCase();
  const isFull = UUID_RE.test(ref);
  if (!isFull && !SHORT_ID_RE.test(ref)) return { kind: "absent" };

  const db = getDbForService();
  const rows = await db.select({
    event: thirdPartyAgentEvents,
    clientKey: oauthClients.clientId,
    clientName: oauthClients.name,
  })
    .from(thirdPartyAgentEvents)
    .innerJoin(oauthClients, eq(oauthClients.id, thirdPartyAgentEvents.clientId))
    .where(and(
      // Scoped in SQL for BOTH forms. Filtering after the query would let "not
      // yours" and "no such event" diverge, and this route is addressed by id:
      // any observable difference is an enumeration oracle for other agents'
      // events (#145 neutrality, confirmed to cover id-addressed routes).
      eq(thirdPartyAgentEvents.agentId, input.agentId),
      isFull
        ? eq(thirdPartyAgentEvents.id, ref)
        : sql`${thirdPartyAgentEvents.id}::text LIKE ${`${ref}%`}`,
    ))
    // 2 is enough to DETECT a short-prefix collision without scanning the rest.
    .limit(2);

  if (rows.length === 0) return { kind: "absent" };

  // Two events the caller OWNS behind one 8-hex address. Returning `absent` here
  // (the first cut of this change) was safe but broke the card's actual promise:
  // the formatter prints that same short target for both, so both owned, live
  // events became permanently unreadable. A 32-bit prefix collides with ~1.16%
  // probability at 10k accumulated events and ~68.8% at 100k (@ApplePI), and no
  // deletion path or short-prefix uniqueness constraint exists -- not unreachable.
  //
  // Safe to distinguish: this state is only ever produced from OWNER-SCOPED rows,
  // so it discloses nothing about anyone else. Unknown and non-owned ids continue
  // to return the byte-identical neutral 404.
  if (rows.length > 1) return { kind: "ambiguous" };

  const row = rows[0]!;
  if (row.event.status === "expired" || row.event.expiresAt.getTime() <= Date.now()) {
    return { kind: "expired" };
  }
  return {
    kind: "found",
    message: buildThirdPartyAgentMessage({
      event: row.event,
      clientKey: row.clientKey,
      clientName: row.clientName,
    }),
  };
}

export function buildThirdPartyAgentMessage(input: {
  event: typeof thirdPartyAgentEvents.$inferSelect;
  clientKey: string;
  clientName: string;
}): AgentMessage {
  const eventId = input.event.id;
  return {
    // Pending inbox notices intentionally group third-party events by agent so
    // bursts coalesce. The concrete agent-facing message target is specialized
    // by the CLI formatter to `agent-event:<eventId>` from `third_party_event`.
    channel_id: `third-party-agent-events:${input.event.agentId}`,
    channel_name: `third-party-agent-events:${input.event.agentId}`,
    channel_type: "dm",
    sender_id: input.event.clientId,
    sender_name: input.clientKey,
    sender_description: input.clientName,
    sender_type: "third_party_app",
    message_id: eventId,
    timestamp: input.event.createdAt.toISOString(),
    content: [
      `Third-party ${input.event.kind}: ${input.event.summary}`,
      "",
      `event_id: ${eventId}`,
      `payload_hash: ${input.event.payloadHash}`,
      `resource: ${input.event.resource}`,
    ].join("\n"),
    third_party_event: {
      id: eventId,
      kind: input.event.kind,
      client_id: input.clientKey,
      client_name: input.clientName,
      external_event_id: input.event.externalEventId,
      payload_hash: input.event.payloadHash,
      payload: input.event.payload,
      expires_at: input.event.expiresAt.toISOString(),
      source: {
        client_id: input.clientKey,
        client_name: input.clientName,
        oauth_client_id: input.event.clientId,
        access_token_id_hash: hashStableSourceId(input.event.accessTokenId),
        resource: input.event.resource,
      },
    },
  };
}

function scopesCover(grantedScopes: string[], requestedScopes: string[]) {
  const granted = new Set(grantedScopes);
  return requestedScopes.every((scope) => granted.has(scope));
}

function scopesEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, idx) => value === b[idx]);
}

function canAutoGrantAgentClient(appType: OAuthClientAppType, installed: boolean): boolean {
  return appType === "server_local" || appType === "slock_builtin" || installed;
}

function defaultClientId(name: string) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const slug = base && CLIENT_ID_REGEX.test(base) ? base : "client";
  return `${slug}-${randomBytes(3).toString("hex")}`;
}

function normalizeClientId(clientId: unknown, name: string) {
  if (typeof clientId !== "string" || !clientId.trim()) {
    return defaultClientId(name);
  }
  const normalized = clientId.trim().toLowerCase();
  if (!CLIENT_ID_REGEX.test(normalized)) {
    throw new Error("clientId must start with a letter and contain only lowercase letters, numbers, and hyphens");
  }
  return normalized;
}

function normalizeReturnUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim() || null;
  if (value && !isSafeOAuthReturnUrl(value)) throw new Error("returnUrl must be HTTPS (or loopback HTTP), without credentials or fragment");
  return value;
}

function normalizeAgentManifestUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("agentManifestUrl must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("agentManifestUrl must be an HTTPS URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("agentManifestUrl must not include credentials");
  }
  parsed.hash = "";
  return parsed.toString();
}

function integrationLogoUrl(clientId: string, contentHash: string, storageKey: string) {
  return getThumbnailUrl(storageKey) ?? `/api/integration-logos/${clientId}/${contentHash}.webp`;
}

async function storeIntegrationLogo(clientId: string, fileBuffer: Buffer): Promise<{ logoUrl: string; logoStorageKey: string }> {
  const storage = getCdnStorage() || getStorage();
  if (!storage) {
    throw new Error("Storage not configured");
  }

  const processed = await sharp(fileBuffer)
    .resize(INTEGRATION_LOGO_SIZE, INTEGRATION_LOGO_SIZE, { fit: "cover" })
    .webp({ quality: 85 })
    .toBuffer();
  const contentHash = createHash("sha256").update(processed).digest("hex").slice(0, 32);
  const logoStorageKey = `integration-logos/${clientId}/${contentHash}.webp`;
  await storage.put(logoStorageKey, processed, "image/webp");

  return {
    logoUrl: integrationLogoUrl(clientId, contentHash, logoStorageKey),
    logoStorageKey,
  };
}

function buildWellKnownAgentManifestUrl(rawOrigin: string | null | undefined): string | null {
  const trimmed = rawOrigin?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return null;
  }
  parsed.pathname = WELL_KNOWN_AGENT_MANIFEST_PATH;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function resolveAgentManifestUrl(input: {
  agentManifestUrl?: string | null;
  homepageUrl?: string | null;
  returnUrl?: string | null;
}): string | null {
  return resolveAgentManifest(input).url;
}

export function resolveAgentManifest(input: {
  agentManifestUrl?: string | null;
  homepageUrl?: string | null;
  returnUrl?: string | null;
}): { url: string | null; source: AgentManifestUrlSource | null } {
  const explicit = normalizeAgentManifestUrl(input.agentManifestUrl);
  if (explicit) return { url: explicit, source: "explicit" };
  const wellKnown = buildWellKnownAgentManifestUrl(input.homepageUrl)
    ?? buildWellKnownAgentManifestUrl(input.returnUrl);
  return wellKnown
    ? { url: wellKnown, source: "well_known" }
    : { url: null, source: null };
}

function normalizeCategory(raw: unknown): OAuthClientCategory {
  if (raw === undefined || raw === null || raw === "") return "Other";
  const category = canonicalizeOAuthClientCategory(raw);
  if (category) return category;
  throw new Error(`category must be one of: ${OAUTH_CLIENT_CATEGORIES.join(", ")}`);
}

function hasMarketplaceListingDescription(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function auditBoolean(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function auditClientDiff(
  before: Partial<OAuthClientRecord>,
  after: Partial<OAuthClientRecord>,
) {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of ["name", "description", "homepageUrl", "returnUrl", "agentManifestUrl", "allowedScopes", "category", "logoUrl"] as const) {
    if (before[key] !== after[key]) {
      diff[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
  }
  return diff;
}

function normalizeReviewStatus(raw: unknown): Extract<OAuthClientPublishStatus, "published" | "rejected" | "private"> {
  if (raw === "published" || raw === "rejected" || raw === "private") return raw;
  throw new Error("review status must be published, rejected, or private");
}

export async function createOAuthClient(input: {
  serverId: string;
  createdByUserId: string;
  name: string;
  appType?: OAuthClientAppType;
  description?: string | null;
  homepageUrl?: string | null;
  returnUrl?: string | null;
  agentManifestUrl?: string | null;
  clientId?: string;
  allowedScopes?: unknown;
  category?: unknown;
}, dbOrTx: ReturnType<typeof getDb> = getDbForService()) {
  const db = dbOrTx;
  const trimmedName = input.name.trim();
  if (!trimmedName) {
    throw new Error("name is required");
  }

  const normalizedClientId = normalizeClientId(input.clientId, trimmedName);
  const rawSecret = generateOAuthClientSecret();
  const appType = input.appType ?? "server_local";
  const allowedScopes = normalizeAllowedScopes(input.allowedScopes);

  return db.transaction(async (tx) => {
    const [created] = await tx.insert(oauthClients).values({
      serverId: input.serverId,
      clientId: normalizedClientId,
      clientSecretHash: hashSecret(rawSecret),
      clientSecret: appType === "slock_builtin" ? rawSecret : null,
      appType,
      publishStatus: appType === "slock_builtin" ? "published" : "private",
      name: trimmedName,
      description: input.description?.trim() || null,
      homepageUrl: input.homepageUrl?.trim() || null,
      returnUrl: normalizeReturnUrl(input.returnUrl),
      agentManifestUrl: normalizeAgentManifestUrl(input.agentManifestUrl),
      allowedScopes,
      category: normalizeCategory(input.category),
      logoUrl: null,
      createdByUserId: input.createdByUserId,
    }).returning(OAUTH_CLIENT_PUBLIC_COLUMNS);

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: created.serverId,
      clientId: created.id,
      eventType: "app.registered",
      outcome: "success",
      source: "api",
      actor: { type: "human", id: input.createdByUserId },
      subject: { type: "app", id: created.id },
      target: { type: "app", id: created.id },
      metadata: {
        appType: created.appType,
        clientKey: created.clientId,
        name: created.name,
        hasReturnUrl: auditBoolean(created.returnUrl),
        hasHomepageUrl: auditBoolean(created.homepageUrl),
        hasAgentManifestUrl: auditBoolean(created.agentManifestUrl),
      },
    }, tx);

    return {
      client: created,
      clientSecret: rawSecret,
    };
  });
}

// Agent App mutations use resource ownership or the caller's current server
// admin role. Every mutating service rechecks authority while holding the app,
// membership, and maintainer rows so route preflight cannot create a TOCTOU
// authorization window.
export type AgentAppMutationResult<T> =
  | { status: "ok"; value: T }
  | { status: "not_found" }
  | { status: "owner_required" };

export type AgentAppAuthority = "owner" | "admin";
type IntegrationMutationActor = { type: "human" | "agent"; id: string };

function resolveMutationActor(input: {
  userId?: string;
  agentId?: string;
}): IntegrationMutationActor {
  if (input.agentId && !input.userId) return { type: "agent", id: input.agentId };
  if (input.userId && !input.agentId) return { type: "human", id: input.userId };
  throw new Error("exactly one integration mutation actor is required");
}

async function getAgentAppAuthority(
  dbOrTx: ReturnType<typeof getDb>,
  input: {
    serverId: string;
    clientId: string;
    actorAgentId: string;
    allowRotateMaintainer?: boolean;
  },
): Promise<AgentAppAuthority | null> {
  const [membership] = await dbOrTx
    .select({ role: serverAgentMembers.role })
    .from(serverAgentMembers)
    .where(and(
      eq(serverAgentMembers.serverId, input.serverId),
      eq(serverAgentMembers.agentId, input.actorAgentId),
    ))
    .limit(1)
    .for("update");
  if (membership?.role === "admin") return "admin";

  const [maintainer] = await dbOrTx
    .select({ id: oauthClientMaintainers.id })
    .from(oauthClientMaintainers)
    .where(and(
      eq(oauthClientMaintainers.clientId, input.clientId),
      eq(oauthClientMaintainers.principalType, "agent"),
      eq(oauthClientMaintainers.agentId, input.actorAgentId),
      input.allowRotateMaintainer
        ? inArray(oauthClientMaintainers.role, ["owner", "rotate"])
        : eq(oauthClientMaintainers.role, "owner"),
      isNull(oauthClientMaintainers.revokedAt),
    ))
    .limit(1)
    .for("update");
  return maintainer ? "owner" : null;
}

export async function resolveOAuthClientForAgentMutation(input: {
  serverId: string;
  clientKey: string;
  actorAgentId: string;
}): Promise<AgentAppMutationResult<{ client: OAuthClientRecord; authority: AgentAppAuthority }>> {
  const db = getDbForService();
  const [client] = await db
    .select(OAUTH_CLIENT_PUBLIC_COLUMNS)
    .from(oauthClients)
    .where(and(
      eq(oauthClients.serverId, input.serverId),
      eq(oauthClients.clientId, input.clientKey),
      or(
        eq(oauthClients.appType, "server_local"),
        eq(oauthClients.appType, "third_party_global"),
      ),
      oauthClientIsUserManagedPredicate(),
    ))
    .limit(1);
  if (!client) return { status: "not_found" };
  const authority = await getAgentAppAuthority(db, {
    serverId: input.serverId,
    clientId: client.id,
    actorAgentId: input.actorAgentId,
  });
  if (!authority) return { status: "owner_required" };
  return { status: "ok", value: { client, authority } };
}

export async function rotateClientSecretForAgent(input: {
  serverId: string;
  clientKey: string;
  actorAgentId: string;
}): Promise<AgentAppMutationResult<{ clientId: string; clientKey: string; clientName: string; clientSecret: string }>> {
  const db = getDbForService();
  const rawSecret = generateOAuthClientSecret();
  return db.transaction(async (tx) => {
    const [client] = await tx
      .select({
        id: oauthClients.id,
        clientId: oauthClients.clientId,
        name: oauthClients.name,
        appType: oauthClients.appType,
      })
      .from(oauthClients)
      .where(and(
        eq(oauthClients.serverId, input.serverId),
        eq(oauthClients.clientId, input.clientKey),
        or(
          eq(oauthClients.appType, "server_local"),
          eq(oauthClients.appType, "third_party_global"),
        ),
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1)
      .for("update");

    if (!client) {
      return { status: "not_found" };
    }

    const authority = await getAgentAppAuthority(tx as ReturnType<typeof getDb>, {
      serverId: input.serverId,
      clientId: client.id,
      actorAgentId: input.actorAgentId,
      allowRotateMaintainer: true,
    });
    if (!authority) {
      return { status: "owner_required" };
    }

    await tx
      .update(oauthClients)
      .set({
        clientSecretHash: hashSecret(rawSecret),
        // server_local apps never persist the plaintext column (only built-ins
        // do); keep it null so no plaintext sits at rest after rotation.
        clientSecret: null,
        updatedAt: new Date(),
      })
      .where(eq(oauthClients.id, client.id));

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: input.serverId,
      clientId: client.id,
      eventType: "client.secret_rotated",
      outcome: "success",
      source: "api",
      actor: { type: "agent", id: input.actorAgentId },
      subject: { type: "app", id: client.id },
      target: { type: "app", id: client.id },
      metadata: { clientKey: client.clientId, appType: client.appType },
    }, tx);

    return {
      status: "ok",
      value: {
        clientId: client.id,
        clientKey: client.clientId,
        clientName: client.name,
        clientSecret: rawSecret,
      },
    };
  });
}

export async function transferClientOwnershipForAgent(input: {
  serverId: string;
  clientKey: string;
  actorAgentId: string;
  targetAgentId: string;
}): Promise<AgentAppMutationResult<{
  clientId: string;
  clientKey: string;
  clientName: string;
  ownerAgentId: string;
  ownershipOutcome: "transferred" | "already_owner";
  auditEventId: string;
}> | { status: "target_not_found" }> {
  const db = getDbForService();
  return db.transaction(async (tx) => {
    const [client] = await tx
      .select({ id: oauthClients.id, clientId: oauthClients.clientId, name: oauthClients.name })
      .from(oauthClients)
      .where(and(
        eq(oauthClients.serverId, input.serverId),
        eq(oauthClients.clientId, input.clientKey),
        or(
          eq(oauthClients.appType, "server_local"),
          eq(oauthClients.appType, "third_party_global"),
        ),
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1)
      .for("update");
    if (!client) return { status: "not_found" };

    const [currentOwner] = await tx
      .select({
        id: oauthClientMaintainers.id,
        agentId: oauthClientMaintainers.agentId,
        assignedByType: oauthClientMaintainers.assignedByType,
        assignedById: oauthClientMaintainers.assignedById,
        assignedByAuthority: oauthClientMaintainers.assignedByAuthority,
      })
      .from(oauthClientMaintainers)
      .where(and(
        eq(oauthClientMaintainers.clientId, client.id),
        eq(oauthClientMaintainers.role, "owner"),
        isNull(oauthClientMaintainers.revokedAt),
      ))
      .limit(1);
    if (!currentOwner) {
      return { status: "owner_required" };
    }

    const [target] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(
        eq(agents.id, input.targetAgentId),
        eq(agents.serverId, input.serverId),
        isNull(agents.deletedAt),
      ))
      .limit(1);
    if (!target) return { status: "target_not_found" };

    const authority = await getAgentAppAuthority(tx as ReturnType<typeof getDb>, {
      serverId: input.serverId,
      clientId: client.id,
      actorAgentId: input.actorAgentId,
    });
    // Transfer provenance is app-specific. A dual-role actor transfers its own
    // app as owner even when it is also a server admin; only a non-owner admin
    // records admin authority. This keeps lost-response replay bound to the
    // authority that justified this app transfer without making admin role
    // loss revoke an owner's exact-target receipt replay.
    const transferActorAuthority: AgentAppAuthority | null = currentOwner.agentId === input.actorAgentId
      ? "owner"
      : authority;
    const isDisplacedOwnerTransferActorReplay = !authority
      && target.id === currentOwner.agentId
      && currentOwner.assignedByType === "agent"
      && currentOwner.assignedById === input.actorAgentId
      && currentOwner.assignedByAuthority === "owner";
    if (!authority && !isDisplacedOwnerTransferActorReplay) {
      return { status: "owner_required" };
    }

    if (target.id === currentOwner.agentId) {
      const auditEvent = await integrationAuditService.recordIntegrationAuditEvent({
        serverId: input.serverId,
        clientId: client.id,
        eventType: "app.owner_transferred",
        outcome: "success",
        source: "api",
        actor: { type: "agent", id: input.actorAgentId },
        subject: { type: "app", id: client.id },
        target: { type: "agent", id: target.id },
        metadata: {
          clientKey: client.clientId,
          previousOwnerType: "agent",
          previousOwnerId: currentOwner.agentId,
          nextOwnerType: "agent",
          nextOwnerId: target.id,
          recovery: false,
          ownershipOutcome: "already_owner",
          actorAuthority: transferActorAuthority ?? "displaced_owner_replay",
        },
      }, tx);
      if (!auditEvent) throw new Error("App ownership replay audit insert returned no row");
      return {
        status: "ok",
        value: {
          clientId: client.id,
          clientKey: client.clientId,
          clientName: client.name,
          ownerAgentId: target.id,
          ownershipOutcome: "already_owner",
          auditEventId: auditEvent.id,
        },
      };
    }

    const transferredAt: SQL = sql`now()`;
    await tx
      .update(oauthClientMaintainers)
      .set({ revokedAt: transferredAt })
      .where(eq(oauthClientMaintainers.id, currentOwner.id));
    await tx.insert(oauthClientMaintainers).values({
      clientId: client.id,
      principalType: "agent",
      agentId: target.id,
      role: "owner",
      assignedByType: "agent",
      assignedById: input.actorAgentId,
      assignedByAuthority: transferActorAuthority,
      assignedAt: transferredAt,
    });
    await tx
      .update(oauthClients)
      .set({ ownerAgentId: target.id, updatedAt: transferredAt })
      .where(eq(oauthClients.id, client.id));

    const auditEvent = await integrationAuditService.recordIntegrationAuditEvent({
      serverId: input.serverId,
      clientId: client.id,
      eventType: "app.owner_transferred",
      outcome: "success",
      source: "api",
      actor: { type: "agent", id: input.actorAgentId },
      subject: { type: "app", id: client.id },
      target: { type: "agent", id: target.id },
      metadata: {
        clientKey: client.clientId,
        previousOwnerType: "agent",
        previousOwnerId: currentOwner.agentId,
        nextOwnerType: "agent",
        nextOwnerId: target.id,
        recovery: false,
        ownershipOutcome: "transferred",
        actorAuthority: transferActorAuthority,
      },
    }, tx);
    if (!auditEvent) throw new Error("App ownership transfer audit insert returned no row");

    return {
      status: "ok",
      value: {
        clientId: client.id,
        clientKey: client.clientId,
        clientName: client.name,
        ownerAgentId: target.id,
        ownershipOutcome: "transferred",
        auditEventId: auditEvent.id,
      },
    };
  });
}

export async function updateOAuthClientForAgent(input: {
  serverId: string;
  clientKey: string;
  actorAgentId: string;
  name?: string;
  description?: string | null;
  category?: unknown;
  homepageUrl?: string | null;
  returnUrl?: string | null;
  agentManifestUrl?: string | null;
  allowedScopes?: unknown;
}): Promise<AgentAppMutationResult<OAuthClientRecord> | { status: "invalid_return_url" }> {
  if (input.returnUrl !== undefined && (!input.returnUrl || !isSafeOAuthReturnUrl(input.returnUrl))) {
    return { status: "invalid_return_url" };
  }
  const db = getDbForService();
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(OAUTH_CLIENT_PUBLIC_COLUMNS)
      .from(oauthClients)
      .where(and(
        eq(oauthClients.serverId, input.serverId),
        eq(oauthClients.clientId, input.clientKey),
        or(
          eq(oauthClients.appType, "server_local"),
          eq(oauthClients.appType, "third_party_global"),
        ),
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1)
      .for("update");
    if (!before) return { status: "not_found" };

    const authority = await getAgentAppAuthority(tx as ReturnType<typeof getDb>, {
      serverId: input.serverId,
      clientId: before.id,
      actorAgentId: input.actorAgentId,
    });
    if (!authority) return { status: "owner_required" };

    const updates: Partial<typeof oauthClients.$inferInsert> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new Error("name is required");
      updates.name = name;
    }
    if (input.description !== undefined) updates.description = input.description?.trim() || null;
    if (input.category !== undefined) updates.category = normalizeCategory(input.category);
    if (input.homepageUrl !== undefined) updates.homepageUrl = input.homepageUrl?.trim() || null;
    if (input.returnUrl !== undefined) updates.returnUrl = normalizeReturnUrl(input.returnUrl);
    if (input.agentManifestUrl !== undefined) updates.agentManifestUrl = normalizeAgentManifestUrl(input.agentManifestUrl);
    if (input.allowedScopes !== undefined) updates.allowedScopes = normalizeAllowedScopes(input.allowedScopes);

    const [updated] = await tx
      .update(oauthClients)
      .set({ ...updates, updatedAt: sql`now()` })
      .where(eq(oauthClients.id, before.id))
      .returning(OAUTH_CLIENT_PUBLIC_COLUMNS);
    if (!updated) return { status: "not_found" };

    const diff = auditClientDiff(before, updated);
    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: updated.serverId,
      clientId: updated.id,
      eventType: "app.updated",
      outcome: "success",
      source: "api",
      actor: { type: "agent", id: input.actorAgentId },
      subject: { type: "app", id: updated.id },
      target: { type: "app", id: updated.id },
      metadata: { changedFields: Object.keys(diff), clientKey: updated.clientId, appType: updated.appType },
      diff,
    }, tx);
    return { status: "ok", value: updated };
  });
}

export async function regenerateClientSecretForUser(input: {
  serverId: string;
  clientId: string;
  actorUserId: string;
}): Promise<{ client: OAuthClientRecord; clientSecret: string } | null> {
  const db = getDbForService();
  const rawSecret = generateOAuthClientSecret();
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(OAUTH_CLIENT_PUBLIC_COLUMNS)
      .from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        isSourceOwnedEditableAppPredicate(input.serverId),
      ))
      .limit(1)
      .for("update");

    if (!before) {
      return null;
    }

    const [updated] = await tx
      .update(oauthClients)
      .set({
        clientSecretHash: hashSecret(rawSecret),
        clientSecret: null,
        updatedAt: sql`now()`,
      })
      .where(eq(oauthClients.id, before.id))
      .returning(OAUTH_CLIENT_PUBLIC_COLUMNS);

    if (!updated) {
      return null;
    }

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: updated.serverId,
      clientId: updated.id,
      eventType: "client.secret_rotated",
      outcome: "success",
      source: "api",
      actor: { type: "human", id: input.actorUserId },
      subject: { type: "app", id: updated.id },
      target: { type: "app", id: updated.id },
      metadata: { clientKey: updated.clientId, appType: updated.appType },
    }, tx);

    return {
      client: updated,
      clientSecret: rawSecret,
    };
  });
}

export async function listOAuthClients(serverId: string) {
  const db = getDbForService();
  return db.select(OAUTH_CLIENT_PUBLIC_COLUMNS).from(oauthClients).where(and(
    eq(oauthClients.serverId, serverId),
    oauthClientIsUserManagedPredicate(),
    or(
      eq(oauthClients.appType, "server_local"),
      eq(oauthClients.appType, "third_party_global"),
    ),
  ));
}

export async function listMarketplaceOAuthClients(serverId: string) {
  const db = getDbForService();
  const clients = await db.select({
    ...OAUTH_CLIENT_PUBLIC_COLUMNS,
    installationId: oauthClientInstalls.id,
    installedAt: oauthClientInstalls.createdAt,
    effectiveInstallCount: sql<number>`(
      select count(*)::int
      from ${oauthClientInstalls} marketplace_badge_install
      where marketplace_badge_install.client_id = ${oauthClients.id}
        and marketplace_badge_install.status = 'active'
        and marketplace_badge_install.server_id <> ${oauthClients.serverId}
    )`.mapWith(Number),
    publishedAt: sql<Date>`coalesce(
      (
        select max(${integrationAuditEvents.createdAt})
        from ${integrationAuditEvents}
        where ${integrationAuditEvents.clientId} = ${oauthClients.id}
          and ${integrationAuditEvents.eventType} = 'app.publish_approved'
          and ${integrationAuditEvents.outcome} = 'success'
      ),
      ${oauthClients.publishReviewedAt},
      ${oauthClients.createdAt}
    )`.mapWith(oauthClients.createdAt),
    publisherName: users.displayName,
    publisherServerName: servers.name,
    privateShared: sql<boolean>`${oauthClientInstalls.id} is not null and ${oauthClients.publishStatus} not in ('published', 'unpublish_requested')`,
    appNotificationGroups: oauthClients.outboundCurrentGroups,
    appNotificationEvents: oauthClients.outboundCurrentEvents,
    appNotificationReviewPending: sql<boolean>`${oauthClients.outboundPendingRevisionId} is not null`,
  })
    .from(oauthClients)
    .innerJoin(servers, eq(servers.id, oauthClients.serverId))
    .leftJoin(oauthClientInstalls, and(
      eq(oauthClientInstalls.clientId, oauthClients.id),
      eq(oauthClientInstalls.serverId, serverId),
    ))
    .leftJoin(users, eq(users.id, oauthClients.createdByUserId))
    .where(and(
      eq(oauthClients.appType, "third_party_global"),
      eq(oauthClients.enabled, true),
      oauthClientIsUserManagedPredicate(),
      or(
        and(
          or(
            eq(oauthClients.publishStatus, "published"),
            eq(oauthClients.publishStatus, "unpublish_requested"),
          ),
          eq(oauthClients.humanMarketplaceVisible, true),
        ),
        and(
          ne(oauthClients.serverId, serverId),
          isNotNull(oauthClientInstalls.id),
        ),
      ),
    ))
    .orderBy(asc(oauthClients.category), asc(oauthClients.name));

  const now = currentDate();
  return clients.map(({ effectiveInstallCount, publishedAt, ...client }) => ({
    ...client,
    marketplaceInstallBadge: isPublicMarketplaceLifecycle(client.publishStatus) && client.humanMarketplaceVisible
      ? projectMarketplaceInstallBadge({ effectiveInstallCount, publishedAt, now })
      : { kind: "none" as const },
  }));
}

export async function searchPublicMarketplaceOAuthClients(input: {
  serverId: string;
  query?: string | null;
  limit?: number;
}) {
  const db = getDbForService();
  const query = input.query?.trim() ?? "";
  const tokens = Array.from(new Set(query.split(/\s+/u).map((token) => token.trim()).filter(Boolean))).slice(0, 8);
  const searchPredicates = tokens.flatMap((token) => {
    const pattern = `%${token.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return [
      sql`${oauthClients.clientId} ilike ${pattern} escape '\\'`,
      sql`${oauthClients.name} ilike ${pattern} escape '\\'`,
      sql`${oauthClients.description} ilike ${pattern} escape '\\'`,
      sql`${oauthClients.homepageUrl} ilike ${pattern} escape '\\'`,
      sql`${oauthClients.category} ilike ${pattern} escape '\\'`,
      sql`${oauthClients.dataAccessSummary} ilike ${pattern} escape '\\'`,
    ];
  });
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)));

  return db.select({
    ...OAUTH_CLIENT_PUBLIC_COLUMNS,
    installedAt: oauthClientInstalls.createdAt,
  })
    .from(oauthClients)
    .leftJoin(oauthClientInstalls, and(
      eq(oauthClientInstalls.clientId, oauthClients.id),
      eq(oauthClientInstalls.serverId, input.serverId),
    ))
    .where(and(
      eq(oauthClients.appType, "third_party_global"),
      eq(oauthClients.enabled, true),
      oauthClientIsUserManagedPredicate(),
      eq(oauthClients.humanMarketplaceVisible, true),
      or(
        eq(oauthClients.publishStatus, "published"),
        eq(oauthClients.publishStatus, "unpublish_requested"),
      ),
      ...(searchPredicates.length > 0 ? [or(...searchPredicates)!] : []),
    ))
    .orderBy(asc(oauthClients.category), asc(oauthClients.name), asc(oauthClients.clientId))
    .limit(limit);
}

/**
 * Public Marketplace discovery is deliberately separate from the installed
 * integration inventory. Callers may use it only as a fallback after the
 * Server-scoped installed lookup misses; private/shared apps are excluded.
 */
export async function listPublicMarketplaceOAuthClients() {
  const db = getDbForService();
  return db.select(OAUTH_CLIENT_PUBLIC_COLUMNS)
    .from(oauthClients)
    .where(and(
      eq(oauthClients.appType, "third_party_global"),
      eq(oauthClients.enabled, true),
      oauthClientIsUserManagedPredicate(),
      or(
        eq(oauthClients.publishStatus, "published"),
        eq(oauthClients.publishStatus, "unpublish_requested"),
      ),
      eq(oauthClients.humanMarketplaceVisible, true),
    ))
    .orderBy(asc(oauthClients.name));
}

export async function requestOAuthClientPublish(input: {
  serverId: string;
  clientId: string;
  requestedByUserId?: string;
  requestedByAgentId?: string;
}) {
  const db = getDbForService();
  const now = new Date();
  const actor = resolveMutationActor({
    userId: input.requestedByUserId,
    agentId: input.requestedByAgentId,
  });
  const result = await db.transaction(async (tx) => {
    const [publishCandidate] = await tx.select({
      id: oauthClients.id,
      description: oauthClients.description,
      publishStatus: oauthClients.publishStatus,
    })
      .from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        eq(oauthClients.serverId, input.serverId),
        oauthClientIsUserManagedPredicate(),
        or(
          eq(oauthClients.appType, "server_local"),
          eq(oauthClients.appType, "third_party_global"),
        ),
        or(
          eq(oauthClients.publishStatus, "private"),
          eq(oauthClients.publishStatus, "rejected"),
          eq(oauthClients.publishStatus, "publish_requested"),
          eq(oauthClients.publishStatus, "in_review"),
        ),
      ))
      .limit(1)
      .for("update");

    if (publishCandidate && actor.type === "agent") {
      const authority = await getAgentAppAuthority(tx as ReturnType<typeof getDb>, {
        serverId: input.serverId,
        clientId: publishCandidate.id,
        actorAgentId: actor.id,
      });
      if (!authority) return null;
    }

    if (publishCandidate && !hasMarketplaceListingDescription(publishCandidate.description)) {
      throw new Error("description is required before requesting marketplace review");
    }

    const [updated] = await tx.update(oauthClients)
      .set({
        publishStatus: "publish_requested",
        dataAccessSummary: null,
        publishRejectionReason: null,
        publishRequestedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(oauthClients.id, input.clientId),
        eq(oauthClients.serverId, input.serverId),
        oauthClientIsUserManagedPredicate(),
        or(
          eq(oauthClients.appType, "server_local"),
          eq(oauthClients.appType, "third_party_global"),
        ),
        or(
          eq(oauthClients.publishStatus, "private"),
          eq(oauthClients.publishStatus, "rejected"),
        ),
      ))
      .returning(OAUTH_CLIENT_REVIEW_REQUEST_COLUMNS);

    if (updated) {
      await integrationAuditService.recordIntegrationAuditEvent({
        serverId: updated.serverId,
        clientId: updated.id,
        eventType: "app.publish_requested",
        outcome: "success",
        source: "api",
        actor,
        subject: { type: "app", id: updated.id },
        target: { type: "app", id: updated.id },
        metadata: {
          clientKey: updated.clientId,
          appType: updated.appType,
          previousPublishStatus: publishCandidate?.publishStatus ?? null,
          nextPublishStatus: updated.publishStatus,
        },
      }, tx);
      const { publishRequestedAt, ...client } = updated;
      return { client, publishRequestedAt };
    }

    const [existingRequest] = await tx.select(OAUTH_CLIENT_REVIEW_REQUEST_COLUMNS)
      .from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        eq(oauthClients.serverId, input.serverId),
        or(
          eq(oauthClients.appType, "server_local"),
          eq(oauthClients.appType, "third_party_global"),
        ),
        oauthClientIsUserManagedPredicate(),
        or(
          eq(oauthClients.publishStatus, "publish_requested"),
          eq(oauthClients.publishStatus, "in_review"),
        ),
      ))
      .limit(1);

    if (!existingRequest) return null;
    const { publishRequestedAt, ...client } = existingRequest;
    return { client, publishRequestedAt };
  });

  if (!result) return null;
  if (!result.publishRequestedAt) {
    throw new Error("marketplace review request timestamp is missing");
  }
  await sendOAuthClientReviewRequestEmail({
    client: result.client,
    requestKind: "publish",
    publishRequestedAt: result.publishRequestedAt,
  });
  return result.client;
}

export async function requestOAuthClientUnpublish(input: {
  serverId: string;
  clientId: string;
  requestedByUserId?: string;
  requestedByAgentId?: string;
}) {
  const db = getDbForService();
  const now = currentDate();
  const actor = resolveMutationActor({
    userId: input.requestedByUserId,
    agentId: input.requestedByAgentId,
  });
  const result = await db.transaction(async (tx) => {
    const [publishCandidate] = await tx.select({
      id: oauthClients.id,
      publishStatus: oauthClients.publishStatus,
    })
      .from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        eq(oauthClients.serverId, input.serverId),
        eq(oauthClients.appType, "third_party_global"),
        eq(oauthClients.enabled, true),
        oauthClientIsUserManagedPredicate(),
        or(
          eq(oauthClients.publishStatus, "published"),
          eq(oauthClients.publishStatus, "unpublish_requested"),
        ),
      ))
      .limit(1)
      .for("update");

    if (publishCandidate && actor.type === "agent") {
      const authority = await getAgentAppAuthority(tx as ReturnType<typeof getDb>, {
        serverId: input.serverId,
        clientId: publishCandidate.id,
        actorAgentId: actor.id,
      });
      if (!authority) return null;
    }

    const [updated] = await tx.update(oauthClients)
      .set({
        publishStatus: "unpublish_requested",
        publishRejectionReason: null,
        publishRequestedAt: now,
        publishReviewedAt: null,
        publishReviewedByUserId: null,
        updatedAt: now,
      })
      .where(and(
        eq(oauthClients.id, input.clientId),
        eq(oauthClients.serverId, input.serverId),
        eq(oauthClients.appType, "third_party_global"),
        eq(oauthClients.enabled, true),
        oauthClientIsUserManagedPredicate(),
        eq(oauthClients.publishStatus, "published"),
      ))
      .returning(OAUTH_CLIENT_REVIEW_REQUEST_COLUMNS);

    if (updated) {
      await integrationAuditService.recordIntegrationAuditEvent({
        serverId: updated.serverId,
        clientId: updated.id,
        eventType: "app.offline_requested",
        outcome: "success",
        source: "api",
        actor,
        subject: { type: "app", id: updated.id },
        target: { type: "app", id: updated.id },
        metadata: {
          clientKey: updated.clientId,
          appType: updated.appType,
          previousPublishStatus: publishCandidate?.publishStatus ?? "published",
        },
      }, tx);
      const { publishRequestedAt, ...client } = updated;
      return { client, publishRequestedAt };
    }

    const [existingRequest] = await tx.select(OAUTH_CLIENT_REVIEW_REQUEST_COLUMNS)
      .from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        eq(oauthClients.serverId, input.serverId),
        eq(oauthClients.appType, "third_party_global"),
        eq(oauthClients.publishStatus, "unpublish_requested"),
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1);

    if (!existingRequest) return null;
    const { publishRequestedAt, ...client } = existingRequest;
    return { client, publishRequestedAt };
  });

  if (!result) return null;
  if (!result.publishRequestedAt) {
    throw new Error("marketplace offline request timestamp is missing");
  }
  await sendOAuthClientReviewRequestEmail({
    client: result.client,
    requestKind: "offline",
    publishRequestedAt: result.publishRequestedAt,
  });
  return result.client;
}

async function sendOAuthClientReviewRequestEmail(input: {
  client: OAuthClientRecord;
  requestKind: AppReviewRequestEmailInput["requestKind"];
  publishRequestedAt: Date;
}) {
  await sendAppReviewRequestEmailForService({
    requestKind: input.requestKind,
    appName: input.client.name,
    clientKey: input.client.clientId,
    description: input.client.description,
    homepageUrl: input.client.homepageUrl,
    category: input.client.category,
    allowedScopes: input.client.allowedScopes,
  }, {
    idempotencyKey: [
      "oauth-client-review",
      input.requestKind,
      input.client.id,
      input.publishRequestedAt.toISOString(),
    ].join(":"),
  });
}

export async function getOAuthClientShareLink(input: {
  serverId: string;
  clientId: string;
  actorAgentId?: string;
}) {
  const db = getDbForService();
  return db.transaction(async (tx) => {
    if (input.actorAgentId) {
      const [client] = await tx.select({ id: oauthClients.id })
        .from(oauthClients)
        .where(and(
          eq(oauthClients.id, input.clientId),
          eq(oauthClients.serverId, input.serverId),
          or(
            eq(oauthClients.appType, "server_local"),
            eq(oauthClients.appType, "third_party_global"),
          ),
          oauthClientIsUserManagedPredicate(),
        ))
        .limit(1)
        .for("update");
      if (!client) return null;

      const authority = await getAgentAppAuthority(tx as ReturnType<typeof getDb>, {
        serverId: input.serverId,
        clientId: client.id,
        actorAgentId: input.actorAgentId,
      });
      if (!authority) return null;
    }

    const [row] = await tx.select({
      ...OAUTH_CLIENT_SHARE_LINK_PUBLIC_COLUMNS,
    })
      .from(oauthClientShareLinks)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthClientShareLinks.clientId))
      .where(and(
        eq(oauthClients.id, input.clientId),
        eq(oauthClients.serverId, input.serverId),
        oauthClientIsUserManagedPredicate(),
        isNull(oauthClientShareLinks.revokedAt),
      ))
      .orderBy(desc(oauthClientShareLinks.createdAt))
      .limit(1);

    return row ?? null;
  });
}

export async function createOAuthClientShareLink(input: {
  serverId: string;
  clientId: string;
  createdByUserId?: string;
  createdByAgentId?: string;
  expiresInDays?: number;
}) {
  const db = getDbForService();
  const now = new Date();
  const actor = resolveMutationActor({
    userId: input.createdByUserId,
    agentId: input.createdByAgentId,
  });
  const expiresInDays = Number.isFinite(input.expiresInDays) && input.expiresInDays && input.expiresInDays > 0
    ? Math.min(Math.floor(input.expiresInDays), 365)
    : 30;
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000);
  const token = `raft_share_${randomBytes(32).toString("hex")}`;
  const tokenHash = hashSecret(token);

  return db.transaction(async (tx) => {
    const [existing] = await tx.select(OAUTH_CLIENT_PUBLIC_COLUMNS)
      .from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        eq(oauthClients.serverId, input.serverId),
        eq(oauthClients.enabled, true),
        or(
          eq(oauthClients.appType, "server_local"),
          eq(oauthClients.appType, "third_party_global"),
        ),
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1)
      .for("update");

    if (!existing) {
      return null;
    }

    if (actor.type === "agent") {
      const authority = await getAgentAppAuthority(tx as ReturnType<typeof getDb>, {
        serverId: input.serverId,
        clientId: existing.id,
        actorAgentId: actor.id,
      });
      if (!authority) return null;
    }

    const convertedFromServerLocal = existing.appType === "server_local";
    const [client] = existing.appType === "server_local"
      ? await tx.update(oauthClients)
        .set({
          appType: "third_party_global",
          publishStatus: existing.publishStatus,
          humanMarketplaceVisible: isPublicMarketplaceLifecycle(existing.publishStatus)
            ? existing.humanMarketplaceVisible
            : false,
          updatedAt: now,
        })
        .where(eq(oauthClients.id, existing.id))
        .returning(OAUTH_CLIENT_PUBLIC_COLUMNS)
      : [existing];

    const [notificationGrant] = await tx.select({
      revisionId: oauthClients.outboundCurrentRevisionId,
      groups: oauthClients.outboundCurrentGroups,
    }).from(oauthClients).where(eq(oauthClients.id, client.id)).limit(1);
    await tx.insert(oauthClientInstalls).values({
      serverId: input.serverId,
      clientId: client.id,
      installedByUserId: actor.type === "human" ? actor.id : null,
      installedByAgentId: actor.type === "agent" ? actor.id : null,
      approvedRequestRevisionId: notificationGrant?.revisionId ?? null,
      approvedGroups: notificationGrant?.groups ?? [],
      grantRevision: notificationGrant?.revisionId ? 1 : 0,
    }).onConflictDoNothing();

    await tx.update(oauthClientShareLinks).set({
      revokedAt: now,
      updatedAt: now,
    }).where(and(
      eq(oauthClientShareLinks.clientId, client.id),
      isNull(oauthClientShareLinks.revokedAt),
    ));

    const [link] = await tx.insert(oauthClientShareLinks).values({
      clientId: client.id,
      tokenHash,
      createdByUserId: actor.type === "human" ? actor.id : null,
      createdByAgentId: actor.type === "agent" ? actor.id : null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    }).returning(OAUTH_CLIENT_SHARE_LINK_PUBLIC_COLUMNS);

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: client.serverId,
      clientId: client.id,
      eventType: "private_share.link_created",
      outcome: "success",
      source: "api",
      actor,
      subject: { type: "app", id: client.id },
      target: { type: "private_share_link", id: link.id },
      metadata: {
        clientKey: client.clientId,
        shareLinkId: link.id,
        expiresAt: link.expiresAt?.toISOString() ?? null,
        convertedFromServerLocal,
      },
    }, tx);

    return {
      client,
      link,
      token,
    };
  });
}

export async function revokeOAuthClientShareLink(input: {
  serverId: string;
  clientId: string;
  revokedByUserId?: string;
  revokedByAgentId?: string;
}) {
  const db = getDbForService();
  const now = new Date();
  const actor = resolveMutationActor({
    userId: input.revokedByUserId,
    agentId: input.revokedByAgentId,
  });
  return db.transaction(async (tx) => {
    if (actor.type === "agent") {
      const [client] = await tx.select({ id: oauthClients.id })
        .from(oauthClients)
        .where(and(
          eq(oauthClients.id, input.clientId),
          eq(oauthClients.serverId, input.serverId),
          or(
            eq(oauthClients.appType, "server_local"),
            eq(oauthClients.appType, "third_party_global"),
          ),
          oauthClientIsUserManagedPredicate(),
        ))
        .limit(1)
        .for("update");
      if (!client) return null;

      const authority = await getAgentAppAuthority(tx as ReturnType<typeof getDb>, {
        serverId: input.serverId,
        clientId: client.id,
        actorAgentId: actor.id,
      });
      if (!authority) return null;
    }

    const [row] = await tx.update(oauthClientShareLinks)
      .set({
        revokedAt: now,
        updatedAt: now,
      })
      .from(oauthClients)
      .where(and(
        eq(oauthClientShareLinks.clientId, oauthClients.id),
        eq(oauthClients.id, input.clientId),
        eq(oauthClients.serverId, input.serverId),
        oauthClientIsUserManagedPredicate(),
        isNull(oauthClientShareLinks.revokedAt),
      ))
      .returning({
        ...OAUTH_CLIENT_SHARE_LINK_PUBLIC_COLUMNS,
        clientKey: oauthClients.clientId,
      });

    if (!row) {
      return null;
    }

    const { clientKey, ...link } = row;
    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: input.serverId,
      clientId: input.clientId,
      eventType: "private_share.link_revoked",
      outcome: "success",
      source: "api",
      actor,
      subject: { type: "app", id: input.clientId },
      target: { type: "private_share_link", id: link.id },
      metadata: {
        clientKey,
        shareLinkId: link.id,
      },
    }, tx);

    return link;
  });
}

async function getOAuthClientShareInviteByToken(token: string, userId: string, targetServerId?: string) {
  const tokenHash = hashSecret(token.trim());
  const db = getDbForService();
  const [row] = await db.select({
    ...OAUTH_CLIENT_SHARE_LINK_PUBLIC_COLUMNS,
    tokenHash: oauthClientShareLinks.tokenHash,
    client: OAUTH_CLIENT_PUBLIC_COLUMNS,
    publisherName: users.displayName,
    sourceServerName: servers.name,
  })
    .from(oauthClientShareLinks)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientShareLinks.clientId))
    .innerJoin(servers, eq(servers.id, oauthClients.serverId))
    .leftJoin(users, eq(users.id, oauthClients.createdByUserId))
    .where(and(
      eq(oauthClientShareLinks.tokenHash, tokenHash),
      isNull(oauthClientShareLinks.revokedAt),
      eq(oauthClients.appType, "third_party_global"),
      eq(oauthClients.enabled, true),
      oauthClientIsUserManagedPredicate(),
      isNull(servers.deletedAt),
    ))
    .limit(1);

  if (!row || !safeEqualHash(row.tokenHash, token.trim())) {
    return null;
  }
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  const manageableRows = await db.select({
    id: servers.id,
    name: servers.name,
    slug: servers.slug,
    role: serverMembers.role,
    installedAt: oauthClientInstalls.createdAt,
  })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .leftJoin(oauthClientInstalls, and(
      eq(oauthClientInstalls.serverId, serverMembers.serverId),
      eq(oauthClientInstalls.clientId, row.client.id),
    ))
    .where(and(
      eq(serverMembers.userId, userId),
      or(
        eq(serverMembers.role, "owner"),
        eq(serverMembers.role, "admin"),
      ),
      isNull(servers.deletedAt),
      ...(targetServerId ? [eq(serverMembers.serverId, targetServerId)] : []),
    ))
    .orderBy(asc(servers.name));

  return {
    client: {
      ...row.client,
      publisherName: row.publisherName,
      sourceServerName: row.sourceServerName,
      installedAt: targetServerId ? manageableRows[0]?.installedAt ?? null : null,
    },
    link: {
      id: row.id,
      clientId: row.clientId,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    manageableServers: manageableRows,
  } satisfies OAuthClientShareInvite;
}

export async function getOAuthClientShareInvite(input: {
  token: string;
  userId: string;
}) {
  return getOAuthClientShareInviteByToken(input.token, input.userId);
}

export async function installOAuthClientShareInvite(input: {
  token: string;
  userId: string;
  serverId: string;
}) {
  const invite = await getOAuthClientShareInviteByToken(input.token, input.userId, input.serverId);
  if (!invite || invite.manageableServers.length === 0) {
    return null;
  }

  const db = getDbForService();
  const now = new Date();
  await db.transaction(async (tx) => {
    const [notificationGrant] = await tx.select({
      revisionId: oauthClients.outboundCurrentRevisionId,
      groups: oauthClients.outboundCurrentGroups,
    }).from(oauthClients).where(eq(oauthClients.id, invite.client.id)).limit(1);
    const installed = await tx.insert(oauthClientInstalls).values({
      serverId: input.serverId,
      clientId: invite.client.id,
      installedByUserId: input.userId,
      approvedRequestRevisionId: notificationGrant?.revisionId ?? null,
      approvedGroups: notificationGrant?.groups ?? [],
      grantRevision: notificationGrant?.revisionId ? 1 : 0,
    }).onConflictDoNothing().returning({ id: oauthClientInstalls.id });

    await tx.update(oauthClientShareLinks).set({
      lastUsedAt: now,
      updatedAt: now,
    }).where(eq(oauthClientShareLinks.id, invite.link.id));

    if (installed.length > 0) {
      await integrationAuditService.recordIntegrationAuditEvent({
        serverId: input.serverId,
        clientId: invite.client.id,
        eventType: "private_share.installed",
        outcome: "success",
        source: "api",
        actor: { type: "human", id: input.userId },
        subject: { type: "app", id: invite.client.id },
        target: { type: "server", id: input.serverId },
        metadata: {
          clientKey: invite.client.clientId,
          shareLinkId: invite.link.id,
          sourceServerId: invite.client.serverId,
          targetServerId: input.serverId,
        },
      }, tx);
    }
  });

  return getOAuthClientShareInviteByToken(input.token, input.userId, input.serverId);
}

export async function reviewOAuthClientPublish(input: {
  reviewerUserId: string;
  clientId: string;
  status: unknown;
  rejectionReason?: unknown;
}) {
  const status = normalizeReviewStatus(input.status);
  const db = getDbForService();
  const now = new Date();
  return db.transaction(async (tx) => {
    const [current] = await tx.select(OAUTH_CLIENT_PUBLIC_COLUMNS)
      .from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        oauthClientIsUserManagedPredicate(),
        or(
          eq(oauthClients.publishStatus, "publish_requested"),
          eq(oauthClients.publishStatus, "in_review"),
          eq(oauthClients.publishStatus, "unpublish_requested"),
        ),
      ))
      .limit(1)
      .for("update");

    if (!current) {
      return null;
    }

    if (current.publishStatus === "unpublish_requested") {
      if (status !== "private" && status !== "published") {
        throw new Error("offline review status must be private or published");
      }

      const installedRows = status === "private"
        ? await tx.select({ serverId: oauthClientInstalls.serverId })
          .from(oauthClientInstalls)
          .where(eq(oauthClientInstalls.clientId, current.id))
          .for("update")
        : [];
      const installedServerIds = installedRows.map((row) => row.serverId);

      const [updated] = await tx.update(oauthClients)
        .set({
          appType: "third_party_global",
          enabled: true,
          publishStatus: status,
          humanMarketplaceVisible: status === "private" ? false : current.humanMarketplaceVisible,
          publishRejectionReason: status === "published" && typeof input.rejectionReason === "string"
            ? input.rejectionReason.trim().slice(0, 1000) || null
            : null,
          publishReviewedAt: now,
          publishReviewedByUserId: input.reviewerUserId,
          updatedAt: now,
        })
        .where(and(
          eq(oauthClients.id, input.clientId),
          eq(oauthClients.publishStatus, "unpublish_requested"),
        ))
        .returning(OAUTH_CLIENT_PUBLIC_COLUMNS);

      if (!updated) {
        return null;
      }

      let removedInstallCount = 0;
      let revokedGrantCount = 0;
      let revokedTokenCount = 0;
      let deniedPendingRequestCount = 0;
      if (status === "private" && installedServerIds.length > 0) {
        const removedInstalls = await tx.delete(oauthClientInstalls)
          .where(and(
            eq(oauthClientInstalls.clientId, updated.id),
            inArray(oauthClientInstalls.serverId, installedServerIds),
          ))
          .returning({ id: oauthClientInstalls.id });
        removedInstallCount = removedInstalls.length;

        const revokedAt = now;
        const revokedGrants = await tx.update(oauthGrants).set({
          revokedByUserId: input.reviewerUserId,
          revokedAt,
          updatedAt: revokedAt,
        }).where(and(
          eq(oauthGrants.clientId, updated.id),
          inArray(oauthGrants.serverId, installedServerIds),
          isNull(oauthGrants.revokedAt),
        )).returning({ id: oauthGrants.id });
        revokedGrantCount = revokedGrants.length;

        const revokedTokens = await tx.update(oauthAccessTokens).set({
          revokedAt,
        }).where(and(
          eq(oauthAccessTokens.clientId, updated.id),
          inArray(oauthAccessTokens.serverId, installedServerIds),
          isNull(oauthAccessTokens.revokedAt),
        )).returning({ id: oauthAccessTokens.id });
        revokedTokenCount = revokedTokens.length;

        const deniedRequests = await tx.update(oauthAccessRequests).set({
          status: "denied",
          remember: false,
          resolvedByUserId: input.reviewerUserId,
          resolvedAt: revokedAt,
          updatedAt: revokedAt,
        }).where(and(
          eq(oauthAccessRequests.clientId, updated.id),
          inArray(oauthAccessRequests.serverId, installedServerIds),
          eq(oauthAccessRequests.status, "pending"),
        )).returning({ id: oauthAccessRequests.id });
        deniedPendingRequestCount = deniedRequests.length;
      }

      await integrationAuditService.recordIntegrationAuditEvent({
        serverId: updated.serverId,
        clientId: updated.id,
        eventType: status === "private" ? "app.offline_approved" : "app.offline_rejected",
        outcome: "success",
        source: "api",
        actor: { type: "human", id: input.reviewerUserId },
        subject: { type: "app", id: updated.id },
        target: { type: "app", id: updated.id },
        metadata: {
          clientKey: updated.clientId,
          appType: updated.appType,
          previousPublishStatus: "unpublish_requested",
          nextPublishStatus: updated.publishStatus,
          removedInstallCount,
          revokedGrantCount,
          revokedTokenCount,
          deniedPendingRequestCount,
        },
      }, tx);

      return updated;
    }

    if (status === "private") {
      throw new Error("publish review status must be published or rejected");
    }

    if (status === "published") {
      if (!hasMarketplaceListingDescription(current.description)) {
        throw new Error("description is required before publishing to marketplace");
      }
    }

    const [updated] = await tx.update(oauthClients)
      .set({
        appType: status === "published" ? "third_party_global" : current.appType,
        enabled: true,
        publishStatus: status,
        humanMarketplaceVisible: status === "published" ? true : current.humanMarketplaceVisible,
        publishRejectionReason: status === "rejected" && typeof input.rejectionReason === "string"
          ? input.rejectionReason.trim().slice(0, 1000) || null
          : null,
        publishReviewedAt: now,
        publishReviewedByUserId: input.reviewerUserId,
        updatedAt: now,
      })
      .where(and(
        eq(oauthClients.id, input.clientId),
        or(
          eq(oauthClients.publishStatus, "publish_requested"),
          eq(oauthClients.publishStatus, "in_review"),
        ),
      ))
      .returning(OAUTH_CLIENT_PUBLIC_COLUMNS);

    if (!updated) {
      return null;
    }

    let installedCount = 0;
    if (status === "published") {
      const [notificationGrant] = await tx.select({
        revisionId: oauthClients.outboundCurrentRevisionId,
        groups: oauthClients.outboundCurrentGroups,
      }).from(oauthClients).where(eq(oauthClients.id, updated.id)).limit(1);
      const installed = await tx.insert(oauthClientInstalls).values({
        serverId: updated.serverId,
        clientId: updated.id,
        installedByUserId: updated.createdByUserId,
        approvedRequestRevisionId: notificationGrant?.revisionId ?? null,
        approvedGroups: notificationGrant?.groups ?? [],
        grantRevision: notificationGrant?.revisionId ? 1 : 0,
      }).onConflictDoNothing().returning({ id: oauthClientInstalls.id });
      installedCount = installed.length;
    }

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: updated.serverId,
      clientId: updated.id,
      eventType: status === "published" ? "app.publish_approved" : "app.publish_rejected",
      outcome: "success",
      source: "api",
      actor: { type: "human", id: input.reviewerUserId },
      subject: { type: "app", id: updated.id },
      target: { type: "app", id: updated.id },
      metadata: {
        clientKey: updated.clientId,
        appType: updated.appType,
        previousPublishStatus: current.publishStatus,
        nextPublishStatus: updated.publishStatus,
        installedCount,
      },
    }, tx);

    return updated;
  });
}

export async function installMarketplaceOAuthClient(input: {
  serverId: string;
  clientId: string;
  installedByUserId: string;
}, dbOrTx: ReturnType<typeof getDb> = getDbForService()) {
  const install = async (tx: ReturnType<typeof getDb>) => {
    const [client] = await tx.select({
      ...OAUTH_CLIENT_PUBLIC_COLUMNS,
      outboundCurrentRevisionId: oauthClients.outboundCurrentRevisionId,
      outboundCurrentGroups: oauthClients.outboundCurrentGroups,
    })
      .from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        eq(oauthClients.appType, "third_party_global"),
        oauthClientIsUserManagedPredicate(),
        or(
          eq(oauthClients.publishStatus, "published"),
          eq(oauthClients.publishStatus, "unpublish_requested"),
        ),
        eq(oauthClients.enabled, true),
        eq(oauthClients.humanMarketplaceVisible, true),
      ))
      .limit(1);

    if (!client) {
      return null;
    }

    const installed = await tx.insert(oauthClientInstalls).values({
      serverId: input.serverId,
      clientId: client.id,
      installedByUserId: input.installedByUserId,
      approvedRequestRevisionId: client.outboundCurrentRevisionId,
      approvedGroups: client.outboundCurrentGroups,
      grantRevision: client.outboundCurrentRevisionId ? 1 : 0,
    }).onConflictDoNothing().returning({ id: oauthClientInstalls.id });

    if (installed.length > 0) {
      await integrationAuditService.recordIntegrationAuditEvent({
        serverId: input.serverId,
        clientId: client.id,
        eventType: "marketplace.installed",
        outcome: "success",
        source: "api",
        actor: { type: "human", id: input.installedByUserId },
        subject: { type: "app", id: client.id },
        target: { type: "server", id: input.serverId },
        metadata: {
          clientKey: client.clientId,
          targetServerId: input.serverId,
        },
      }, tx);
    }

    const { outboundCurrentRevisionId: _revisionId, outboundCurrentGroups: _groups, ...publicClient } = client;
    return publicClient;
  };
  return "transaction" in dbOrTx
    ? dbOrTx.transaction(async (tx) => install(tx as ReturnType<typeof getDb>))
    : install(dbOrTx);
}

export async function uninstallMarketplaceOAuthClient(input: {
  serverId: string;
  clientId: string;
  revokedByUserId: string;
}) {
  const db = getDbForService();
  return db.transaction(async (tx) => {
    const [client] = await tx.select({
      id: oauthClients.id,
      serverId: oauthClients.serverId,
      clientId: oauthClients.clientId,
      publishStatus: oauthClients.publishStatus,
    })
      .from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        eq(oauthClients.appType, "third_party_global"),
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1);

    if (!client) {
      return null;
    }
    if (!isPublicMarketplaceLifecycle(client.publishStatus) && client.serverId === input.serverId) {
      return null;
    }

    const [install] = await tx.delete(oauthClientInstalls)
      .where(and(
        eq(oauthClientInstalls.serverId, input.serverId),
        eq(oauthClientInstalls.clientId, client.id),
      ))
      .returning({ id: oauthClientInstalls.id });

    if (!install) {
      return { clientId: client.id, revokedGrantCount: 0, revokedTokenCount: 0, deniedPendingRequestCount: 0 };
    }

    const revokedAt = new Date();
    const outboundRecipients = await tx.select({ id: notificationRecipients.id })
      .from(notificationRecipients)
      .where(and(
        eq(notificationRecipients.recipientType, "app_installation"),
        eq(notificationRecipients.recipientId, install.id),
      ));
    if (outboundRecipients.length > 0) {
      await tx.update(notificationDeliveries).set({
        status: "suppressed",
        terminalReason: "installation_uninstalled",
        lockedAt: null,
        nextAttemptAt: revokedAt,
        updatedAt: revokedAt,
      }).where(and(
        inArray(notificationDeliveries.notificationId, outboundRecipients.map((row) => row.id)),
        inArray(notificationDeliveries.status, ["pending", "processing"]),
      ));
    }
    const revokedGrants = await tx.update(oauthGrants).set({
      revokedByUserId: input.revokedByUserId,
      revokedAt,
      updatedAt: revokedAt,
    }).where(and(
      eq(oauthGrants.serverId, input.serverId),
      eq(oauthGrants.clientId, client.id),
      isNull(oauthGrants.revokedAt),
    )).returning({ id: oauthGrants.id });

    const revokedTokens = await tx.update(oauthAccessTokens).set({
      revokedAt,
    }).where(and(
      eq(oauthAccessTokens.serverId, input.serverId),
      eq(oauthAccessTokens.clientId, client.id),
      isNull(oauthAccessTokens.revokedAt),
    )).returning({ id: oauthAccessTokens.id });

    const deniedRequests = await tx.update(oauthAccessRequests).set({
      status: "denied",
      remember: false,
      resolvedByUserId: input.revokedByUserId,
      resolvedAt: revokedAt,
      updatedAt: revokedAt,
    }).where(and(
      eq(oauthAccessRequests.serverId, input.serverId),
      eq(oauthAccessRequests.clientId, client.id),
      eq(oauthAccessRequests.status, "pending"),
    )).returning({ id: oauthAccessRequests.id });

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: input.serverId,
      clientId: client.id,
      eventType: isPublicMarketplaceLifecycle(client.publishStatus) ? "marketplace.uninstalled" : "private_share.uninstalled",
      outcome: "success",
      source: "api",
      actor: { type: "human", id: input.revokedByUserId },
      subject: { type: "app", id: client.id },
      target: { type: "server", id: input.serverId },
      metadata: {
        clientKey: client.clientId,
        targetServerId: input.serverId,
        revokedGrantCount: revokedGrants.length,
        revokedTokenCount: revokedTokens.length,
        deniedPendingRequestCount: deniedRequests.length,
      },
    }, tx);

    return {
      clientId: client.id,
      revokedGrantCount: revokedGrants.length,
      revokedTokenCount: revokedTokens.length,
      deniedPendingRequestCount: deniedRequests.length,
    };
  });
}

export async function listAgentAvailableOAuthClients(serverId: string) {
  const db = getDbForService();
  return db.select(OAUTH_CLIENT_PUBLIC_COLUMNS)
    .from(oauthClients)
    .leftJoin(oauthClientInstalls, and(
      eq(oauthClientInstalls.clientId, oauthClients.id),
      eq(oauthClientInstalls.serverId, serverId),
    ))
    .where(and(
      oauthClientIsUserManagedPredicate(),
      or(
        and(
          eq(oauthClients.serverId, serverId),
          eq(oauthClients.appType, "server_local"),
        ),
        isLiveBuiltInAppPredicate(),
        isInstalledThirdPartyAppPredicate(),
      ),
    )).orderBy(asc(oauthClients.appType), asc(oauthClients.name));
}

export async function listBuiltInOAuthClients() {
  const db = getDbForService();
  return db.select({
    id: oauthClients.id,
    clientId: oauthClients.clientId,
    appType: oauthClients.appType,
    name: oauthClients.name,
    description: oauthClients.description,
    homepageUrl: oauthClients.homepageUrl,
    agentManifestUrl: oauthClients.agentManifestUrl,
    humanMarketplaceVisible: oauthClients.humanMarketplaceVisible,
    createdAt: oauthClients.createdAt,
    updatedAt: oauthClients.updatedAt,
  }).from(oauthClients)
    .where(and(
      eq(oauthClients.appType, "slock_builtin"),
      eq(oauthClients.enabled, true),
      eq(oauthClients.publishStatus, "published"),
      eq(oauthClients.humanMarketplaceVisible, true),
    ))
    .orderBy(oauthClients.name);
}

export async function getOAuthClientForServer(input: {
  serverId: string;
  clientKey: string;
}) {
  const db = getDbForService();
  const [client] = await db.select(OAUTH_CLIENT_PUBLIC_COLUMNS).from(oauthClients)
    .leftJoin(oauthClientInstalls, and(
      eq(oauthClientInstalls.clientId, oauthClients.id),
      eq(oauthClientInstalls.serverId, input.serverId),
    ))
    .where(and(
      eq(oauthClients.clientId, input.clientKey),
      oauthClientIsUserManagedPredicate(),
      or(
        and(
          eq(oauthClients.serverId, input.serverId),
          eq(oauthClients.appType, "server_local"),
        ),
        isLiveBuiltInAppPredicate(),
        isInstalledThirdPartyAppPredicate(),
      ),
    ))
    .limit(1);

  return client ?? null;
}

export async function updateOAuthClient(input: {
  serverId: string;
  clientId: string;
  actorUserId?: string;
  name?: string;
  description?: string | null;
  homepageUrl?: string | null;
  returnUrl?: string | null;
  agentManifestUrl?: string | null;
  allowedScopes?: unknown;
  category?: unknown;
}, dbOrTx: ReturnType<typeof getDb> = getDbForService()) {
  const db = dbOrTx;
  return db.transaction(async (tx) => {
    const [before] = await tx.select(OAUTH_CLIENT_PUBLIC_COLUMNS)
      .from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        isSourceOwnedEditableAppPredicate(input.serverId),
      ))
      .limit(1);

    if (!before) {
      return null;
    }

    const updates: Partial<typeof oauthClients.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) {
      const trimmedName = input.name.trim();
      if (!trimmedName) {
        throw new Error("name is required");
      }
      updates.name = trimmedName;
    }

    if (input.description !== undefined) {
      updates.description = input.description?.trim() || null;
    }
    if (input.homepageUrl !== undefined) {
      updates.homepageUrl = input.homepageUrl?.trim() || null;
    }
    if (input.returnUrl !== undefined) {
      updates.returnUrl = normalizeReturnUrl(input.returnUrl);
    }
    if (input.agentManifestUrl !== undefined) {
      updates.agentManifestUrl = normalizeAgentManifestUrl(input.agentManifestUrl);
    }
    if (input.allowedScopes !== undefined) {
      updates.allowedScopes = normalizeAllowedScopes(input.allowedScopes);
    }
    if (input.category !== undefined) {
      updates.category = normalizeCategory(input.category);
    }

    const [updated] = await tx.update(oauthClients)
      .set(updates)
      .where(eq(oauthClients.id, before.id))
      .returning(OAUTH_CLIENT_PUBLIC_COLUMNS);

    if (updated) {
      const diff = auditClientDiff(before, updated);
      await integrationAuditService.recordIntegrationAuditEvent({
        serverId: updated.serverId,
        clientId: updated.id,
        eventType: "app.updated",
        outcome: "success",
        source: "api",
        actor: { type: "human", id: input.actorUserId ?? updated.createdByUserId },
        subject: { type: "app", id: updated.id },
        target: { type: "app", id: updated.id },
        metadata: {
          changedFields: Object.keys(diff),
          clientKey: updated.clientId,
          appType: updated.appType,
        },
        diff,
      }, tx);
    }

    return updated ?? null;
  });
}

export async function deleteOAuthClient(input: {
  serverId: string;
  clientId: string;
  deletedByUserId?: string;
  deletedByAgentId?: string;
}) {
  const db = getDbForService();
  return db.transaction(async (tx) => {
    const [client] = await tx.select()
      .from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        eq(oauthClients.serverId, input.serverId),
        oauthClientIsUserManagedPredicate(),
        or(
          eq(oauthClients.appType, "server_local"),
          eq(oauthClients.appType, "third_party_global"),
        ),
        or(
          eq(oauthClients.publishStatus, "private"),
          eq(oauthClients.publishStatus, "publish_requested"),
          eq(oauthClients.publishStatus, "in_review"),
          eq(oauthClients.publishStatus, "rejected"),
        ),
      ))
      .limit(1)
      .for("update");

    if (!client) {
      return null;
    }
    if (input.deletedByAgentId) {
      const authority = await getAgentAppAuthority(tx as ReturnType<typeof getDb>, {
        serverId: input.serverId,
        clientId: client.id,
        actorAgentId: input.deletedByAgentId,
      });
      if (!authority) return null;
    }
    const actor = input.deletedByUserId || input.deletedByAgentId
      ? resolveMutationActor({
        userId: input.deletedByUserId,
        agentId: input.deletedByAgentId,
      })
      : { type: "human" as const, id: client.createdByUserId };

    const revokedAt = new Date();
    await tx.update(oauthGrants).set({
      revokedAt,
      updatedAt: revokedAt,
    }).where(and(
      eq(oauthGrants.clientId, client.id),
      isNull(oauthGrants.revokedAt),
    ));

    await tx.update(oauthAccessTokens).set({
      revokedAt,
    }).where(and(
      eq(oauthAccessTokens.clientId, client.id),
      isNull(oauthAccessTokens.revokedAt),
    ));

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: input.serverId,
      clientId: null,
      eventType: "app.deleted",
      outcome: "success",
      source: "api",
      actor,
      subject: { type: "app", id: client.id },
      target: { type: "app", id: client.id },
      metadata: {
        clientKey: client.clientId,
        appType: client.appType,
        publishStatus: client.publishStatus,
      },
    }, tx);

    const [deleted] = await tx.delete(oauthClients)
      .where(and(
        eq(oauthClients.id, client.id),
        eq(oauthClients.serverId, input.serverId),
      ))
      .returning(OAUTH_CLIENT_PUBLIC_COLUMNS);

    const storage = getCdnStorage() || getStorage();
    if (storage && client.logoStorageKey) {
      void storage.delete(client.logoStorageKey).catch(() => undefined);
    }

    return deleted ?? null;
  });
}

export async function updateOAuthClientLogo(input: {
  serverId: string;
  clientId: string;
  fileBuffer: Buffer;
  appType?: OAuthClientAppType;
  actorUserId?: string;
  actorAgentId?: string;
}) {
  const db = getDbForService();
  const actor = resolveMutationActor({
    userId: input.actorUserId,
    agentId: input.actorAgentId,
  });
  return db.transaction(async (tx) => {
    const [client] = await tx.select({
      id: oauthClients.id,
      clientId: oauthClients.clientId,
      appType: oauthClients.appType,
      logoUrl: oauthClients.logoUrl,
      logoStorageKey: oauthClients.logoStorageKey,
    }).from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        input.appType
          ? and(
            eq(oauthClients.serverId, input.serverId),
            eq(oauthClients.appType, input.appType),
            oauthClientIsUserManagedPredicate(),
          )
          : isSourceOwnedLogoEditableAppPredicate(input.serverId),
      ))
      .limit(1)
      .for("update");

    if (!client) {
      return null;
    }
    if (actor.type === "agent") {
      const authority = await getAgentAppAuthority(tx as ReturnType<typeof getDb>, {
        serverId: input.serverId,
        clientId: client.id,
        actorAgentId: actor.id,
      });
      if (!authority) return null;
    }

    const nextLogo = await storeIntegrationLogo(client.id, input.fileBuffer);
    const [updated] = await tx.update(oauthClients)
      .set({
        logoUrl: nextLogo.logoUrl,
        logoStorageKey: nextLogo.logoStorageKey,
        updatedAt: new Date(),
      })
      .where(eq(oauthClients.id, client.id))
      .returning(OAUTH_CLIENT_PUBLIC_COLUMNS);

    if (updated) {
      const diff = auditClientDiff(client, updated);
      await integrationAuditService.recordIntegrationAuditEvent({
        serverId: updated.serverId,
        clientId: updated.id,
        eventType: "app.updated",
        outcome: "success",
        source: "api",
        actor,
        subject: { type: "app", id: updated.id },
        target: { type: "app", id: updated.id },
        metadata: {
          changedFields: Object.keys(diff),
          clientKey: updated.clientId,
          appType: updated.appType,
        },
        diff,
      }, tx);
    }

    const storage = getCdnStorage() || getStorage();
    if (storage && client.logoStorageKey && client.logoStorageKey !== nextLogo.logoStorageKey) {
      void storage.delete(client.logoStorageKey).catch(() => undefined);
    }

    return updated ?? null;
  });
}

export async function clearOAuthClientLogo(input: {
  serverId: string;
  clientId: string;
  appType?: OAuthClientAppType;
  actorUserId?: string;
  actorAgentId?: string;
}) {
  const db = getDbForService();
  const actor = resolveMutationActor({
    userId: input.actorUserId,
    agentId: input.actorAgentId,
  });
  return db.transaction(async (tx) => {
    const [client] = await tx.select({
      id: oauthClients.id,
      clientId: oauthClients.clientId,
      appType: oauthClients.appType,
      logoUrl: oauthClients.logoUrl,
      logoStorageKey: oauthClients.logoStorageKey,
    }).from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        input.appType
          ? and(
            eq(oauthClients.serverId, input.serverId),
            eq(oauthClients.appType, input.appType),
            oauthClientIsUserManagedPredicate(),
          )
          : isSourceOwnedLogoEditableAppPredicate(input.serverId),
      ))
      .limit(1)
      .for("update");

    if (!client) {
      return null;
    }
    if (actor.type === "agent") {
      const authority = await getAgentAppAuthority(tx as ReturnType<typeof getDb>, {
        serverId: input.serverId,
        clientId: client.id,
        actorAgentId: actor.id,
      });
      if (!authority) return null;
    }

    const [updated] = await tx.update(oauthClients)
      .set({
        logoUrl: null,
        logoStorageKey: null,
        updatedAt: new Date(),
      })
      .where(eq(oauthClients.id, client.id))
      .returning(OAUTH_CLIENT_PUBLIC_COLUMNS);

    if (updated) {
      const diff = auditClientDiff(client, updated);
      await integrationAuditService.recordIntegrationAuditEvent({
        serverId: updated.serverId,
        clientId: updated.id,
        eventType: "app.updated",
        outcome: "success",
        source: "api",
        actor,
        subject: { type: "app", id: updated.id },
        target: { type: "app", id: updated.id },
        metadata: {
          changedFields: Object.keys(diff),
          clientKey: updated.clientId,
          appType: updated.appType,
        },
        diff,
      }, tx);
    }

    const storage = getCdnStorage() || getStorage();
    if (storage && client.logoStorageKey) {
      void storage.delete(client.logoStorageKey).catch(() => undefined);
    }

    return updated ?? null;
  });
}

export async function getOAuthClientLogoStorageKey(input: {
  clientId: string;
  contentHash: string;
}) {
  const db = getDbForService();
  const [client] = await db.select({
    logoStorageKey: oauthClients.logoStorageKey,
  }).from(oauthClients)
    .where(eq(oauthClients.id, input.clientId))
    .limit(1);

  if (!client?.logoStorageKey) return null;
  if (!client.logoStorageKey.endsWith(`/${input.contentHash}.webp`)) return null;
  return client.logoStorageKey;
}

export async function authenticateOAuthClient(clientKey: string, clientSecret: string): Promise<AuthenticatedClient | null> {
  const db = getDbForService();
  const [client] = await db.select({
    ...OAUTH_CLIENT_PUBLIC_COLUMNS,
    clientSecretHash: oauthClients.clientSecretHash,
    enabled: oauthClients.enabled,
    publishStatus: oauthClients.publishStatus,
  }).from(oauthClients).where(and(
    eq(oauthClients.clientId, clientKey),
    oauthClientIsUserManagedPredicate(),
  )).limit(1);

  if (!client || !safeEqualHash(client.clientSecretHash, clientSecret)) {
    return null;
  }

  if (
    client.appType === "slock_builtin"
    && (!client.enabled || client.publishStatus !== "published")
  ) {
    return null;
  }

  if (
    client.appType === "third_party_global"
    && !client.enabled
  ) {
    return null;
  }

  const { clientSecretHash: _, enabled: _enabled, ...safeClient } = client;
  return safeClient;
}

export async function requestAgentAccess(input: {
  clientId: string;
  serverSlug: string;
  agentName: string;
  scopes: unknown;
}) {
  const db = getDbForService();

  const [agent] = await db.select({
    agentId: agents.id,
    agentName: agents.name,
    agentDisplayName: agents.displayName,
    serverId: agents.serverId,
    serverSlug: servers.slug,
  }).from(agents)
    .innerJoin(servers, eq(agents.serverId, servers.id))
    .where(and(
      eq(servers.slug, input.serverSlug),
      eq(agents.name, input.agentName),
      isNull(agents.deletedAt),
      isNull(servers.deletedAt),
    ))
    .limit(1);

  if (!agent) {
    throw new Error("Agent not found");
  }

  const [client] = await db.select({
    id: oauthClients.id,
    clientId: oauthClients.clientId,
    appType: oauthClients.appType,
    name: oauthClients.name,
    description: oauthClients.description,
    homepageUrl: oauthClients.homepageUrl,
    allowedScopes: oauthClients.allowedScopes,
    createdByUserId: oauthClients.createdByUserId,
    installId: oauthClientInstalls.id,
  }).from(oauthClients)
    .leftJoin(oauthClientInstalls, and(
      eq(oauthClientInstalls.clientId, oauthClients.id),
      eq(oauthClientInstalls.serverId, agent.serverId),
    ))
    .where(and(
      eq(oauthClients.id, input.clientId),
      oauthClientIsUserManagedPredicate(),
      or(
        and(
          eq(oauthClients.serverId, agent.serverId),
          eq(oauthClients.appType, "server_local"),
        ),
        isLiveBuiltInAppPredicate(),
        isInstalledThirdPartyAppPredicate(),
      ),
    ))
    .limit(1);

  if (!client) {
    throw new Error("OAuth client not found for server");
  }

  const scopes = normalizeScopes(input.scopes, client);

  const activeGrants = await db.select().from(oauthGrants).where(and(
    eq(oauthGrants.serverId, agent.serverId),
    eq(oauthGrants.agentId, agent.agentId),
    eq(oauthGrants.clientId, client.id),
    isNull(oauthGrants.revokedAt),
  ));

  const coveringGrant = activeGrants.find((grant) => scopesCover(grant.scopes ?? [], scopes));
  if (coveringGrant) {
    const [autoApproved] = await db.insert(oauthAccessRequests).values({
      serverId: agent.serverId,
      agentId: agent.agentId,
      clientId: client.id,
      scopes,
      status: "approved",
      remember: true,
      resolvedAt: new Date(),
    }).returning();

    return {
      request: autoApproved,
      status: "approved" as const,
      grantStatus: "reused" as const,
      agent,
      client,
    };
  }

  const now = new Date();
  if (!canAutoGrantAgentClient(client.appType, client.installId !== null)) {
    const pendingRequests = await db.select().from(oauthAccessRequests).where(and(
      eq(oauthAccessRequests.serverId, agent.serverId),
      eq(oauthAccessRequests.agentId, agent.agentId),
      eq(oauthAccessRequests.clientId, client.id),
      eq(oauthAccessRequests.status, "pending"),
    ));
    const coveringPending = pendingRequests.find((request) => scopesCover(request.scopes ?? [], scopes));
    if (coveringPending) {
      return {
        request: coveringPending,
        status: "pending" as const,
        grantStatus: "pending" as const,
        agent,
        client,
      };
    }

    const [pending] = await db.insert(oauthAccessRequests).values({
      serverId: agent.serverId,
      agentId: agent.agentId,
      clientId: client.id,
      scopes,
      status: "pending",
      remember: false,
      createdAt: now,
      updatedAt: now,
    }).returning();

    return {
      request: pending,
      status: "pending" as const,
      grantStatus: "pending" as const,
      agent,
      client,
    };
  }

  return db.transaction(async (tx) => {
    await tx.insert(oauthGrants).values({
      serverId: agent.serverId,
      agentId: agent.agentId,
      clientId: client.id,
      scopes,
      grantedByUserId: client.createdByUserId,
      createdAt: now,
      updatedAt: now,
    });

    const [created] = await tx.insert(oauthAccessRequests).values({
      serverId: agent.serverId,
      agentId: agent.agentId,
      clientId: client.id,
      scopes,
      status: "approved",
      remember: true,
      resolvedAt: now,
      createdAt: now,
      updatedAt: now,
    }).returning();

    return {
      request: created,
      status: "approved" as const,
      grantStatus: "created" as const,
      agent,
      client,
    };
  });
}

export async function issueHumanAuthorizationCode(input: {
  clientKey: string;
  userId: string;
  serverId: string;
  returnUrl?: string | null;
  scopes?: unknown;
}) {
  const db = getDbForService();
  const now = currentDate();
  const [client] = await db.select({
    id: oauthClients.id,
    serverId: oauthClients.serverId,
    clientId: oauthClients.clientId,
    appType: oauthClients.appType,
    name: oauthClients.name,
    description: oauthClients.description,
    homepageUrl: oauthClients.homepageUrl,
    returnUrl: oauthClients.returnUrl,
    allowedScopes: oauthClients.allowedScopes,
  }).from(oauthClients)
    .leftJoin(oauthClientInstalls, and(
      eq(oauthClientInstalls.clientId, oauthClients.id),
      eq(oauthClientInstalls.serverId, input.serverId),
    ))
    .where(and(
      eq(oauthClients.clientId, input.clientKey),
      oauthClientIsUserManagedPredicate(),
      or(
        and(
          eq(oauthClients.serverId, input.serverId),
          eq(oauthClients.appType, "server_local"),
        ),
        isLiveBuiltInAppPredicate(),
        isInstalledThirdPartyAppPredicate(),
      ),
    ))
    .limit(1);

  if (!client) {
    throw new Error("OAuth client not found for server");
  }

  const scopes = input.scopes === undefined || input.scopes === null
    ? ["openid", "profile"]
    : normalizeScopes(input.scopes, client);

  const requestedReturnUrl = normalizeReturnUrl(input.returnUrl);
  // Non-browser clients may omit a callback entirely. Any requested navigation
  // must match a registered safe URL; also reject unsafe pre-existing records.
  if ((client.returnUrl && !isSafeOAuthReturnUrl(client.returnUrl))
    || (requestedReturnUrl && requestedReturnUrl !== client.returnUrl)) {
    await integrationAuditService.recordIntegrationAuditEventBestEffort({
      serverId: input.serverId,
      clientId: client.id,
      eventType: "oauth.redirect_mismatch",
      outcome: "failure",
      source: "api",
      actor: { type: "human", id: input.userId },
      subject: { type: "human", id: input.userId },
      target: { type: "app", id: client.id },
      metadata: {
        clientKey: client.clientId,
        errorCode: "return_url_mismatch",
      },
    });
    throw new Error("returnUrl does not match registered OAuth client");
  }

  const [member] = await db.select({
    userId: serverMembers.userId,
    serverId: serverMembers.serverId,
    role: serverMembers.role,
    serverSlug: servers.slug,
  }).from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(
      eq(serverMembers.serverId, input.serverId),
      eq(serverMembers.userId, input.userId),
      isNull(servers.deletedAt),
    ))
    .limit(1);

  if (!member) {
    throw new Error("User is not a member of this server");
  }

  const created = await db.transaction(async (tx) => {
    const [request] = await tx.insert(oauthAccessRequests).values({
      serverId: input.serverId,
      principalType: "human",
      userId: input.userId,
      agentId: null,
      clientId: client.id,
      scopes,
      status: "approved",
      remember: false,
      resolvedByUserId: input.userId,
      resolvedAt: now,
      createdAt: now,
      updatedAt: now,
    }).returning();

    await integrationAuditService.recordIntegrationAuditEvent({
      clientId: client.id,
      eventType: "oauth.lifecycle",
      outcome: "success",
      source: "api",
      actor: { type: "system" },
      target: { type: "app", id: client.id },
      metadata: {
        clientKey: client.clientId,
        stage: "authorization",
        result: "issued",
        grantType: "authorization_code",
        principalType: "human",
      },
    }, tx);

    return request;
  });

  return {
    code: created.id,
    request: created,
    client,
    server: {
      id: member.serverId,
      slug: member.serverSlug,
      role: member.role,
    },
    scopes,
    returnUrl: client.returnUrl,
  };
}

export async function approveAccessRequest(input: {
  serverId: string;
  requestId: string;
  resolvedByUserId: string;
  remember: boolean;
}) {
  const db = getDbForService();
  return db.transaction(async (tx) => {
    const [request] = await tx.select()
      .from(oauthAccessRequests)
      .where(and(
        eq(oauthAccessRequests.id, input.requestId),
        eq(oauthAccessRequests.serverId, input.serverId),
        oauthClientIdIsUserManagedPredicate(oauthAccessRequests.clientId),
      ))
      .limit(1)
      .for("update");
    if (!request || request.serverId !== input.serverId) {
      throw new Error("Access request not found");
    }
    if (request.status !== "pending") {
      return {
        request,
        grantId: null,
      };
    }

    let createdGrantId: string | null = null;
    if (input.remember && (request.principalType ?? "agent") === "agent" && request.agentId) {
      const existingGrants = await tx.select().from(oauthGrants).where(and(
        eq(oauthGrants.serverId, request.serverId),
        eq(oauthGrants.agentId, request.agentId),
        eq(oauthGrants.clientId, request.clientId),
        isNull(oauthGrants.revokedAt),
      ));
      const matched = existingGrants.find((grant) => scopesEqual(grant.scopes ?? [], request.scopes ?? []));
      if (matched) {
        createdGrantId = matched.id;
      } else {
        const [grant] = await tx.insert(oauthGrants).values({
          serverId: request.serverId,
          agentId: request.agentId,
          clientId: request.clientId,
          scopes: request.scopes,
          grantedByUserId: input.resolvedByUserId,
        }).returning();
        createdGrantId = grant.id;
      }
    }

    const [updated] = await tx.update(oauthAccessRequests).set({
      status: "approved",
      remember: input.remember,
      resolvedByUserId: input.resolvedByUserId,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(oauthAccessRequests.id, request.id)).returning();

    return {
      request: updated,
      grantId: createdGrantId,
    };
  });
}

export async function denyAccessRequest(input: {
  serverId: string;
  requestId: string;
  resolvedByUserId: string;
}) {
  const db = getDbForService();
  return db.transaction(async (tx) => {
    const [request] = await tx.select()
      .from(oauthAccessRequests)
      .where(and(
        eq(oauthAccessRequests.id, input.requestId),
        eq(oauthAccessRequests.serverId, input.serverId),
      ))
      .limit(1)
      .for("update");
    if (!request || request.serverId !== input.serverId) {
      return null;
    }
    if (request.status !== "pending") {
      return request;
    }

    const [updated] = await tx.update(oauthAccessRequests).set({
      status: "denied",
      remember: false,
      resolvedByUserId: input.resolvedByUserId,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(oauthAccessRequests.id, input.requestId)).returning();
    return updated || null;
  });
}

export async function revokeGrant(input: {
  serverId: string;
  grantId: string;
  revokedByUserId: string;
}) {
  const db = getDbForService();
  return db.transaction(async (tx) => {
    const [grant] = await tx.select()
      .from(oauthGrants)
      .where(and(
        eq(oauthGrants.id, input.grantId),
        eq(oauthGrants.serverId, input.serverId),
      ))
      .limit(1)
      .for("update");
    if (!grant || grant.serverId !== input.serverId) {
      return null;
    }
    if (grant.revokedAt) {
      return grant;
    }

    const revokedAt = new Date();
    const [updated] = await tx.update(oauthGrants).set({
      revokedByUserId: input.revokedByUserId,
      revokedAt,
      updatedAt: revokedAt,
    }).where(eq(oauthGrants.id, input.grantId)).returning();

    await tx.update(oauthAccessTokens).set({
      revokedAt,
    }).where(and(
      eq(oauthAccessTokens.grantId, input.grantId),
      isNull(oauthAccessTokens.revokedAt),
    ));

    return updated || null;
  });
}

export async function exchangeAccessRequest(input: {
  clientId: string;
  requestId: string;
  resource?: unknown;
  now?: Date;
}) {
  const db = getDbForService();
  return db.transaction(async (tx) => {
    const now = input.now ?? currentDate();
    const [request] = await tx.select()
      .from(oauthAccessRequests)
      .where(and(
        eq(oauthAccessRequests.id, input.requestId),
        oauthClientIdIsUserManagedPredicate(oauthAccessRequests.clientId),
      ))
      .limit(1)
      .for("update");
    if (!request || request.clientId !== input.clientId) {
      throw new Error("Access request not found");
    }
    if (request.status === "pending") {
      throw new Error("authorization_pending");
    }
    if (request.status === "denied") {
      throw new Error("access_denied");
    }
    if (request.consumedAt) {
      throw new Error("request_already_consumed");
    }
    const principalType = (request.principalType ?? "agent") as OAuthPrincipalType;
    if (
      principalType === "human"
      && now.getTime() > request.createdAt.getTime() + HUMAN_AUTHORIZATION_CODE_TTL_MS
    ) {
      throw new Error(AUTHORIZATION_CODE_EXPIRED_ERROR);
    }
    const resource = validateResourceForScopes(
      request.scopes ?? [],
      normalizeResourceIndicator(input.resource),
      request.serverId,
    );

    const [grant] = request.remember && principalType === "agent"
      ? await tx.select().from(oauthGrants).where(and(
          eq(oauthGrants.serverId, request.serverId),
          eq(oauthGrants.agentId, request.agentId!),
          eq(oauthGrants.clientId, request.clientId),
          isNull(oauthGrants.revokedAt),
        )).limit(1)
      : [null];
    if (request.remember && principalType === "agent" && !grant) {
      throw new Error("access_denied");
    }

    const rawToken = `slock_at_${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
    const [createdToken] = await tx.insert(oauthAccessTokens).values({
      serverId: request.serverId,
      principalType,
      agentId: request.agentId,
      userId: request.userId,
      clientId: request.clientId,
      requestId: request.id,
      grantId: grant?.id ?? null,
      tokenHash: hashSecret(rawToken),
      scopes: request.scopes,
      resource,
      expiresAt,
    }).returning();

    const identity = (request.scopes ?? []).includes("openid")
      ? await getIdentityByAccessToken(rawToken, tx)
      : null;
    if ((request.scopes ?? []).includes("openid") && !identity) {
      throw new Error("openid_identity_unavailable");
    }

    await tx.update(oauthAccessRequests).set({
      consumedAt: now,
      updatedAt: now,
    }).where(eq(oauthAccessRequests.id, request.id));

    await integrationAuditService.recordIntegrationAuditEvent({
      clientId: request.clientId,
      eventType: "oauth.lifecycle",
      outcome: "success",
      source: "api",
      actor: { type: "system" },
      target: { type: "app", id: request.clientId },
      metadata: {
        stage: "token_exchange",
        result: "issued",
        principalType,
      },
    }, tx);

    return {
      accessToken: rawToken,
      expiresAt,
      scopes: request.scopes ?? [],
      resource,
      token: createdToken,
      identity,
    };
  });
}

export async function createThirdPartyAgentEvent(input: {
  serverId: string;
  agentId: string;
  clientId: string;
  accessTokenId: string;
  clientKey: string;
  clientName: string;
  kind: unknown;
  summary: unknown;
  payload: unknown;
  externalEventId?: unknown;
  ttlSeconds?: unknown;
  resource: string;
}) {
  const db = getDbForService();
  const now = new Date();
  const kind = normalizeThirdPartyEventKind(input.kind);
  const summary = normalizeThirdPartyEventSummary(input.summary);
  const externalEventId = normalizeExternalEventId(input.externalEventId);
  const { payload, payloadHash } = normalizeThirdPartyEventPayload(input.payload);
  const expiresAt = normalizeThirdPartyEventExpiresAt(input.ttlSeconds, now);

  const selectExistingEvent = async (): Promise<ThirdPartyAgentEventRecord | null> => {
    if (!externalEventId) return null;
    const [existing] = await db.select()
      .from(thirdPartyAgentEvents)
      .where(and(
        eq(thirdPartyAgentEvents.clientId, input.clientId),
        eq(thirdPartyAgentEvents.agentId, input.agentId),
        eq(thirdPartyAgentEvents.externalEventId, externalEventId),
      ))
      .limit(1);
    return existing ?? null;
  };

  const [event] = await db.insert(thirdPartyAgentEvents).values({
    serverId: input.serverId,
    agentId: input.agentId,
    clientId: input.clientId,
    accessTokenId: input.accessTokenId,
    externalEventId,
    kind,
    summary,
    payload,
    payloadHash,
    resource: input.resource,
    status: "queued",
    expiresAt,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning();

  if (!event) {
    const existing = await selectExistingEvent();
    if (!existing) {
      throw new Error("third_party_event_dedupe_lookup_failed");
    }
    return {
      event: existing,
      message: buildThirdPartyAgentMessage({ event: existing, clientKey: input.clientKey, clientName: input.clientName }),
      created: false,
      shouldDeliver: existing.status === "queued",
    };
  }

  return {
    event,
    message: buildThirdPartyAgentMessage({ event, clientKey: input.clientKey, clientName: input.clientName }),
    created: true,
    shouldDeliver: true,
  };
}

export async function markThirdPartyAgentEventDelivered(eventId: string) {
  await markThirdPartyAgentEventsDelivered([eventId]);
}

export async function markThirdPartyAgentEventsDelivered(eventIds: string[]) {
  const ids = [...new Set(eventIds.filter(Boolean))];
  if (ids.length === 0) return;
  const db = getDbForService();
  const now = new Date();
  await db.update(thirdPartyAgentEvents)
    .set({
      status: "delivered",
      deliveredAt: now,
      updatedAt: now,
    })
    .where(and(
      inArray(thirdPartyAgentEvents.id, ids),
      or(
        eq(thirdPartyAgentEvents.status, "queued"),
        eq(thirdPartyAgentEvents.status, "delivering"),
      ),
    ));
}

export async function rebuildPendingThirdPartyAgentEventMessages(input: {
  agentId: string;
  excludeEventIds?: string[];
  limit?: number;
}): Promise<AgentMessage[]> {
  const db = getDbForService();
  const now = new Date();
  const excludeIds = [...new Set(input.excludeEventIds?.filter(Boolean) ?? [])];
  const whereClauses: SQL[] = [
    eq(thirdPartyAgentEvents.agentId, input.agentId),
    or(
      eq(thirdPartyAgentEvents.status, "queued"),
      eq(thirdPartyAgentEvents.status, "delivering"),
    )!,
    sql`${thirdPartyAgentEvents.expiresAt} > ${now}`,
  ];
  if (excludeIds.length > 0) {
    whereClauses.push(not(inArray(thirdPartyAgentEvents.id, excludeIds)));
  }

  const rows = await db.select({
    event: thirdPartyAgentEvents,
    clientKey: oauthClients.clientId,
    clientName: oauthClients.name,
  })
    .from(thirdPartyAgentEvents)
    .innerJoin(oauthClients, eq(oauthClients.id, thirdPartyAgentEvents.clientId))
    .where(and(...whereClauses))
    .orderBy(asc(thirdPartyAgentEvents.createdAt), asc(thirdPartyAgentEvents.id))
    .limit(input.limit ?? 100);

  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.event.id);
  await db.update(thirdPartyAgentEvents)
    .set({
      status: "delivering",
      updatedAt: new Date(),
    })
    .where(and(
      inArray(thirdPartyAgentEvents.id, ids),
      or(
        eq(thirdPartyAgentEvents.status, "queued"),
        eq(thirdPartyAgentEvents.status, "delivering"),
      ),
    ));

  return rows.map((row) => buildThirdPartyAgentMessage({
    event: row.event,
    clientKey: row.clientKey,
    clientName: row.clientName,
  }));
}

export async function claimQueuedThirdPartyAgentEventForDelivery(eventId: string) {
  const db = getDbForService();
  const now = new Date();
  const [event] = await db.update(thirdPartyAgentEvents)
    .set({
      status: "delivering",
      updatedAt: now,
    })
    .where(and(
      eq(thirdPartyAgentEvents.id, eventId),
      eq(thirdPartyAgentEvents.status, "queued"),
    ))
    .returning();
  return event ?? null;
}

export async function releaseThirdPartyAgentEventDeliveryClaim(eventId: string) {
  const db = getDbForService();
  const now = new Date();
  await db.update(thirdPartyAgentEvents)
    .set({
      status: "queued",
      updatedAt: now,
    })
    .where(and(
      eq(thirdPartyAgentEvents.id, eventId),
      eq(thirdPartyAgentEvents.status, "delivering"),
    ));
}

export async function getOAuthAccessRequestAuditContext(input: {
  clientId: string;
  requestId: string;
}) {
  const db = getDbForService();
  const [row] = await db.select({
    requestId: oauthAccessRequests.id,
    serverId: oauthAccessRequests.serverId,
    principalType: oauthAccessRequests.principalType,
    agentId: oauthAccessRequests.agentId,
    userId: oauthAccessRequests.userId,
    clientId: oauthAccessRequests.clientId,
    scopes: oauthAccessRequests.scopes,
    status: oauthAccessRequests.status,
    clientKey: oauthClients.clientId,
  })
    .from(oauthAccessRequests)
    .leftJoin(oauthClients, eq(oauthClients.id, oauthAccessRequests.clientId))
    .where(and(
      eq(oauthAccessRequests.id, input.requestId),
      eq(oauthAccessRequests.clientId, input.clientId),
    ))
    .limit(1);
  return row ?? null;
}

export async function getIdentityByAccessToken(
  rawToken: string,
  dbOrTx: ReturnType<typeof getDb> = getDbForService(),
) {
  const db = dbOrTx;
  const [token] = await db.select({
    tokenId: oauthAccessTokens.id,
    principalType: oauthAccessTokens.principalType,
    scopes: oauthAccessTokens.scopes,
    resource: oauthAccessTokens.resource,
    expiresAt: oauthAccessTokens.expiresAt,
    revokedAt: oauthAccessTokens.revokedAt,
    grantRevokedAt: oauthGrants.revokedAt,
    clientRecordId: oauthClients.id,
    clientKey: oauthClients.clientId,
    clientName: oauthClients.name,
    serverId: servers.id,
    serverSlug: servers.slug,
    serverName: servers.name,
    serverAvatarUrl: servers.avatarUrl,
    serverDeletedAt: servers.deletedAt,
    serverPlan: servers.plan,
    humanId: users.id,
    humanName: users.name,
    humanDisplayName: users.displayName,
    humanEmail: users.email,
    humanEmailVerified: users.emailVerified,
    humanAvatarUrl: users.avatarUrl,
    humanDescription: users.description,
    humanRole: serverMembers.role,
    agentRole: serverAgentMembers.role,
    agentId: agents.id,
    agentName: agents.name,
    agentDisplayName: agents.displayName,
    agentAvatarUrl: agents.avatarUrl,
    agentDescription: agents.description,
    agentDeletedAt: agents.deletedAt,
  }).from(oauthAccessTokens)
    .innerJoin(oauthClients, eq(oauthAccessTokens.clientId, oauthClients.id))
    .innerJoin(servers, eq(oauthAccessTokens.serverId, servers.id))
    .leftJoin(agents, eq(oauthAccessTokens.agentId, agents.id))
    .leftJoin(users, eq(oauthAccessTokens.userId, users.id))
    .leftJoin(serverMembers, and(
      eq(serverMembers.serverId, oauthAccessTokens.serverId),
      eq(serverMembers.userId, oauthAccessTokens.userId),
    ))
    .leftJoin(serverAgentMembers, and(
      eq(serverAgentMembers.serverId, oauthAccessTokens.serverId),
      eq(serverAgentMembers.agentId, oauthAccessTokens.agentId),
    ))
    .leftJoin(oauthGrants, eq(oauthAccessTokens.grantId, oauthGrants.id))
    .where(and(
      eq(oauthAccessTokens.tokenHash, hashSecret(rawToken)),
      oauthClientIsUserManagedPredicate(),
    ))
    .limit(1);

  if (!token) {
    return null;
  }
  if (token.revokedAt || token.grantRevokedAt || token.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  if (token.serverDeletedAt) {
    return null;
  }

  const principalType = (token.principalType ?? "agent") as OAuthPrincipalType;
  if (principalType === "agent" && (!token.agentId || token.agentDeletedAt || !token.agentRole)) {
    return null;
  }
  if (principalType === "human" && (!token.humanId || !token.humanRole)) {
    return null;
  }

  return token;
}

export async function getServerIntegrationsOverview(serverId: string): Promise<IntegrationOverviewItem[]> {
  const db = getDbForService();
  const [pendingRows, activeRows] = await Promise.all([
    db.select({
      id: oauthAccessRequests.id,
      serverId: oauthAccessRequests.serverId,
      agentId: agents.id,
      agentName: agents.name,
      agentDisplayName: agents.displayName,
      clientId: oauthClients.id,
      clientKey: oauthClients.clientId,
      clientName: oauthClients.name,
      clientDescription: oauthClients.description,
      clientHomepageUrl: oauthClients.homepageUrl,
      clientReturnUrl: oauthClients.returnUrl,
      clientAgentManifestUrl: oauthClients.agentManifestUrl,
      scopes: oauthAccessRequests.scopes,
      remember: oauthAccessRequests.remember,
      createdAt: oauthAccessRequests.createdAt,
      resolvedAt: oauthAccessRequests.resolvedAt,
      resolvedByUserId: oauthAccessRequests.resolvedByUserId,
    }).from(oauthAccessRequests)
      .innerJoin(agents, eq(oauthAccessRequests.agentId, agents.id))
      .innerJoin(oauthClients, eq(oauthAccessRequests.clientId, oauthClients.id))
      .where(and(
        eq(oauthAccessRequests.serverId, serverId),
        eq(oauthAccessRequests.status, "pending"),
        oauthClientIsUserManagedPredicate(),
      ))
      .orderBy(desc(oauthAccessRequests.createdAt)),
    db.select({
      id: oauthGrants.id,
      serverId: oauthGrants.serverId,
      agentId: agents.id,
      agentName: agents.name,
      agentDisplayName: agents.displayName,
      clientId: oauthClients.id,
      clientKey: oauthClients.clientId,
      clientName: oauthClients.name,
      clientDescription: oauthClients.description,
      clientHomepageUrl: oauthClients.homepageUrl,
      clientReturnUrl: oauthClients.returnUrl,
      clientAgentManifestUrl: oauthClients.agentManifestUrl,
      scopes: oauthGrants.scopes,
      createdAt: oauthGrants.createdAt,
      revokedAt: oauthGrants.revokedAt,
      resolvedByUserId: oauthGrants.grantedByUserId,
    }).from(oauthGrants)
      .innerJoin(agents, eq(oauthGrants.agentId, agents.id))
      .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
      .where(and(
        eq(oauthGrants.serverId, serverId),
        isNull(oauthGrants.revokedAt),
        oauthClientIsUserManagedPredicate(),
      ))
      .orderBy(desc(oauthGrants.createdAt)),
  ]);

  const pending = pendingRows.map((row) => ({
    id: row.id,
    type: "pending" as const,
    serverId: row.serverId,
    agentId: row.agentId,
    agentName: row.agentName,
    agentDisplayName: row.agentDisplayName,
    clientId: row.clientId,
    clientKey: row.clientKey,
    clientName: row.clientName,
    clientDescription: row.clientDescription,
    clientHomepageUrl: row.clientHomepageUrl,
    clientReturnUrl: row.clientReturnUrl,
    clientAgentManifestUrl: row.clientAgentManifestUrl,
    scopes: row.scopes ?? [],
    remember: false,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByUserId: row.resolvedByUserId,
    revokedAt: null,
  }));

  const active = activeRows.map((row) => ({
    id: row.id,
    type: "active" as const,
    serverId: row.serverId,
    agentId: row.agentId,
    agentName: row.agentName,
    agentDisplayName: row.agentDisplayName,
    clientId: row.clientId,
    clientKey: row.clientKey,
    clientName: row.clientName,
    clientDescription: row.clientDescription,
    clientHomepageUrl: row.clientHomepageUrl,
    clientReturnUrl: row.clientReturnUrl,
    clientAgentManifestUrl: row.clientAgentManifestUrl,
    scopes: row.scopes ?? [],
    remember: true,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.createdAt.toISOString(),
    resolvedByUserId: row.resolvedByUserId,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }));

  return [...pending, ...active];
}

export async function getAgentIntegrationsOverview(agentId: string): Promise<IntegrationOverviewItem[]> {
  const db = getDbForService();
  const [agent] = await db.select({ serverId: agents.serverId }).from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) return [];
  const all = await getServerIntegrationsOverview(agent.serverId);
  return all.filter((item) => item.agentId === agentId);
}
