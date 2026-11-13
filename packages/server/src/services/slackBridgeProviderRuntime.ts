import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  clearClockTimeout,
  currentDate,
  setClockTimeout,
} from "@botiverse/raft-shared";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import { getDb, type Database, type DatabaseTransaction } from "../db/index";
import { getRedis, isRedisAvailable } from "../redis";
import { claimSlackMentionReconcile, redisSlackMentionReconcileClaimStore, releaseSlackMentionReconcileClaim, type SlackMentionReconcileClaim } from "./slackMentionReconcileClaim";
import {
  externalAppCredentials,
  externalAppInstalls,
  externalAppRegistrations,
  externalChannelBindings,
  externalMessageLinks,
  slackUsergroupIdentities,
} from "../db/schema";
import type { SlackAudienceCredentialResolver } from "./slackProviderAdapter";
import type { SlackBridgeCredentialCipher } from "./slackBridgeEnvSecrets";
import type { ExternalAttachmentAuthority } from "./externalAttachmentProviderAdapter";
import {
  SlackInboundAttachmentError,
  type SlackInboundAttachmentTransport,
} from "./slackInboundAttachmentAdapter";
import {
  SlackOutboundAttachmentError,
  type SlackOutboundAttachmentTransport,
} from "./slackOutboundAttachmentAdapter";
import type {
  SlackBridgeAgentMentionCandidate,
  SlackBridgeAgentMentionHandle,
  SlackBridgeAgentMentionReconcileFailure,
  SlackBridgeHumanMentionCandidate,
  SlackBridgeHumanMentionHandle,
  SlackBridgeProvisioningProvider,
  SlackBridgeProvisioningProviderAuthority,
  SlackBridgeProvisioningProviderResult,
  SlackBridgeProvisioningProviderUser,
  SlackBridgeWorkspaceDirectory,
  SlackBridgeWorkspaceObservation,
} from "./slackBridgeProvisioningControlPlane";
import {
  SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
  renderSlackBridgeUsername,
  type SlackBridgeCredentialHandle,
  type SlackJsonObject,
  type SlackProviderAuthorityFence,
  type SlackProviderAuthorityQuarantineSink,
  type SlackWebApiRequest,
  type SlackWebApiTransport,
  type SlackWebApiTransportResult,
} from "./slackProviderAdapter";
import {
  findAnyCurrentExternalInstallServerGrantAuthority,
  resolveExternalInstallServerGrantAuthority,
} from "./externalInstallServerGrantAuthority";
import { traceSlackWebApiRequest } from "./slackWebApiTrace";
import { lockSlackInstallCredential, type SlackCredentialLockRequest } from "./slackBridgeRowLocks";
import {
  type SlackUsergroupIdentity,
  bindSlackUsergroupIdentity,
  listSlackUsergroupIdentities,
  reserveSlackUsergroupIdentity,
  setCanonicalSlackHumanUsergroup,
  slackUsergroupDescription,
  slackUsergroupIdentityMarker,
  slackUsergroupRecoveryDescription,
} from "./slackUsergroupIdentityStore";
import {
  parseSlackAgentUsergroupMarker,
  parseSlackHumanUsergroupMarker,
  RAFT_AGENT_USERGROUP_MARKER_PREFIX,
  RAFT_HUMAN_USERGROUP_MARKER_PREFIX,
  SLACK_USERGROUP_NAMING_EXHAUSTED_ERROR,
  slackAgentHandleCandidates,
  slackAgentUsergroupMarker,
  slackHumanHandleCandidates,
} from "./slackMentionTokens";

import {
  slackHumanMentionSnapshotSchema, slackMentionWriteFailuresSchema, slackMentionFingerprint,
  slackMentionCapabilitySchema, SlackMentionUnsupportedError, newSlackMentionAuthorizationId,
  SLACK_MENTION_FAILURE_BACKOFF_MS, SLACK_HUMAN_RECONCILE_INTERVAL_MS, SlackMentionRateLimitedError,
} from "./slackMentionReconcileState";

const localMentionWorkspaceClaims = new Map<string, string>();

const DEFAULT_CREDENTIAL_LEASE_TTL_MS = 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
// A joined-member lookup runs before the Events API acknowledgement.
const JOIN_PROFILE_FETCH_TIMEOUT_MS = 1_500;
const DEFAULT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_PROVIDER_REQUEST_BYTES = 256 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;
const MAX_PROVIDER_PAGES = 100;
const SLACK_AUTH_REVOKED_ERRORS = new Set([
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "team_access_not_granted",
  "token_expired",
  "token_revoked",
]);
const SLACK_QUERY_METHODS = new Set([
  "conversations.list",
  "conversations.history",
  "conversations.replies",
  "conversations.info",
  "conversations.members",
  "files.info",
  "files.getUploadURLExternal",
  "conversations.history",
  "conversations.replies",
  "reactions.get",
  "usergroups.list",
  "bots.info",
  "users.info",
]);

type Tx = DatabaseTransaction;

interface CredentialAuthority {
  serverId: string;
  installId: string;
  providerAppId: string;
  providerTeamId: string;
  providerAuthorityId: string;
  botUserId: string;
  connectionEpoch: number;
  credentialRevision: number;
}

interface ProviderCredentialLease {
  leaseId: string;
  accessToken: string;
  authority: CredentialAuthority;
  expiresAt: Date;
}

export interface SlackBridgeAudienceProviderRuntime {
  credentialResolver: SlackAudienceCredentialResolver;
  transport: SlackWebApiTransport;
  quarantineSink: SlackProviderAuthorityQuarantineSink;
  inboundAttachmentTransport: SlackInboundAttachmentTransport;
  createOutboundAttachmentTransport(
    handle: SlackBridgeCredentialHandle,
    authority: SlackProviderAuthorityFence,
  ): Promise<SlackOutboundAttachmentTransport | null>;
  releaseCredential(handle: SlackBridgeCredentialHandle): Promise<void>;
  stop(): Promise<void>;
}

/** How a revoke of an install's stored token at Slack went (the closed-server purge). */
export type SlackInstallTokenRevokeOutcome =
  | { kind: "revoked" }
  /** No credential row, or its material does not unseal: nothing Raft holds to revoke. */
  | { kind: "no_credential" }
  | { kind: "failed"; failure: string };

export interface SlackBridgeProviderRuntime extends SlackBridgeAudienceProviderRuntime {
  provisioningProvider: SlackBridgeProvisioningProvider;
  /**
   * auth.revoke for an install's stored bot token, for the closed-server
   * purge: it needs no live server authority (the server is closed), only the
   * install's credential. A token Slack already treats as dead counts as
   * revoked. One call; the caller decides on retries.
   */
  revokeInstallToken(installId: string): Promise<SlackInstallTokenRevokeOutcome>;
  resolveUsers(
    authority: SlackBridgeProvisioningProviderAuthority,
    providerUserIds: readonly string[],
  ): Promise<SlackBridgeProvisioningProviderResult<{ users: readonly SlackBridgeProvisioningProviderUser[] }>>;
  resolveAgentMentionHandles(
    authority: SlackBridgeProvisioningProviderAuthority,
    input: { serverId: string; providerUsergroupIds: readonly string[] },
  ): Promise<SlackBridgeProvisioningProviderResult<{
    handles: readonly SlackBridgeAgentMentionHandle[];
    /** Managed human usergroups (`raft-user:` marker) among the requested ids. */
    humanHandles?: readonly SlackBridgeHumanMentionHandle[];
  }>>;
}

export interface SlackBridgeProviderRuntimeDependencies {
  credentialCipher: SlackBridgeCredentialCipher;
  db?: Database;
  fetch?: typeof fetch;
  now?: () => Date;
  credentialLeaseTtlMs?: number;
  fetchTimeoutMs?: number;
  attachmentDownloadTimeoutMs?: number;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function nonEmpty(value: unknown, max = 4_096): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= max
    && !/[\r\n\0]/u.test(value);
}

/** users.info omits is_custom_image/image_original for its generated default profile. */
export function slackProfileAvatarLocator(profile: Record<string, unknown>): string | null | undefined {
  const locator = nonEmpty(profile.image_72, 4_096) ? profile.image_72
    : nonEmpty(profile.image_48, 4_096) ? profile.image_48 : undefined;
  if (profile.is_custom_image === false || (
    profile.is_custom_image === undefined
    && locator !== undefined
    && nonEmpty(profile.avatar_hash, 512)
    && !nonEmpty(profile.image_original, 4_096)
  )) return null;
  // Missing/partial profile data is unknown, never an instruction to clear.
  return locator;
}

function slackProvisioningUser(value: unknown, expectedProviderUserId: string): SlackBridgeProvisioningProviderUser | null {
  if (!record(value) || value.id !== expectedProviderUserId) return null;
  const profile = record(value.profile) ? value.profile : {};
  const displayName = nonEmpty(profile.display_name, 512)
    ? profile.display_name
    : nonEmpty(profile.real_name, 512)
      ? profile.real_name
      : nonEmpty(value.name, 512)
        ? value.name
        : expectedProviderUserId;
  const handle = nonEmpty(value.name, 512) ? value.name : null;
  const actorKind = value.is_bot === true || value.is_app_user === true
    ? "remote" as const
    : value.is_restricted === true || value.is_ultra_restricted === true
      ? "guest" as const
      : "human" as const;
  return {
    id: expectedProviderUserId,
    displayName,
    handle,
    actorKind,
    avatarLocator: slackProfileAvatarLocator(profile),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type SlackAgentUsergroup = {
  id: string;
  name: string;
  handle: string;
  description: string;
  disabled: boolean;
};

function parseSlackAgentUsergroup(value: unknown): SlackAgentUsergroup | null {
  if (!record(value)) return null;
  if (
    !nonEmpty(value.id, 160)
    || !nonEmpty(value.name, 80)
    || !nonEmpty(value.handle, 80)
  ) return null;
  return {
    id: value.id,
    name: value.name,
    handle: value.handle,
    description: typeof value.description === "string" ? value.description : "",
    disabled: value.date_delete !== undefined && Number(value.date_delete) > 0,
  };
}

/**
 * Slack refuses a usergroup write whose handle or name is taken or invalid
 * (e.g. a handle equal to an existing Slack username). Those refusals move
 * the principal to its next candidate; any other failure (rate limit,
 * permission, transport) does not.
 */
export function slackUsergroupNamingConflict(
  slackError: string | undefined,
): "handle" | "name" | null {
  if (!slackError) return null;
  const naming = /(?:already_exists|_taken|^invalid_(?:name|handle))/u.test(slackError);
  if (!naming) return null;
  return slackError.includes("handle") ? "handle" : "name";
}

/** One Raft principal (Agent or human) that should own a managed Slack usergroup. */
type SlackMentionPrincipal = {
  kind: "agent" | "user";
  id: string;
  marker: string;
  handleCandidates: readonly string[];
  nameCandidates: readonly string[];
};

/** Usergroup names tell Slack users which entries are Raft Agents. */
const SLACK_AGENT_USERGROUP_NAME_LABEL = " (agent)";
const SLACK_USERGROUP_NAME_LIMIT = 80;

function slackUsergroupNameWithSuffix(
  baseValue: string,
  suffixValue: string,
  label: string,
): string {
  const base = Array.from(baseValue.trim());
  const suffix = Array.from(suffixValue.trim()).slice(0, 32);
  if (base.length === 0 || suffix.length === 0) return "";
  const separator = " · ";
  const available = Math.max(
    1,
    SLACK_USERGROUP_NAME_LIMIT - separator.length - suffix.length - label.length,
  );
  return `${base.slice(0, available).join("")}${label}${separator}${suffix.join("")}`
    .slice(0, SLACK_USERGROUP_NAME_LIMIT);
}

function slackUsergroupNameCandidates(input: {
  displayName: string;
  serverName: string;
  serverSlug: string;
  label: string;
}): string[] {
  // Names are visible workspace-wide. Keep the Raft server in every variant
  // and disambiguate collisions without exposing a member's internal UUID.
  return [...new Set([
    slackUsergroupNameWithSuffix(input.displayName, input.serverName, input.label),
    slackUsergroupNameWithSuffix(input.displayName, input.serverSlug, input.label),
    ...[2, 3, 4, 5].map((ordinal) => slackUsergroupNameWithSuffix(
      input.displayName, `${input.serverName} (${ordinal})`, input.label,
    )),
  ].filter(Boolean))];
}

function slackAgentMentionPrincipal(candidate: SlackBridgeAgentMentionCandidate): SlackMentionPrincipal {
  return {
    kind: "agent",
    id: candidate.agentId,
    marker: slackAgentUsergroupMarker(candidate.serverId, candidate.agentId),
    handleCandidates: slackAgentHandleCandidates(candidate),
    nameCandidates: slackUsergroupNameCandidates({
      displayName: candidate.displayName,
      serverName: candidate.serverName,
      serverSlug: candidate.serverSlug,
      label: SLACK_AGENT_USERGROUP_NAME_LABEL,
    }),
  };
}

function slackHumanMentionPrincipal(candidate: SlackBridgeHumanMentionCandidate): SlackMentionPrincipal {
  return {
    kind: "user",
    id: candidate.userId,
    marker: `workspace-user:${candidate.userId}`,
    handleCandidates: slackHumanHandleCandidates(candidate),
    nameCandidates: slackUsergroupNameCandidates({
      displayName: candidate.displayName,
      serverName: "Raft",
      serverSlug: "raft",
      label: "",
    }),
  };
}

function jsonObject(value: unknown): SlackJsonObject {
  return record(value) ? value as SlackJsonObject : {};
}

function sameAuthority(left: SlackProviderAuthorityFence, right: CredentialAuthority): boolean {
  return left.installId === right.installId
    && left.providerAppId === right.providerAppId
    && left.providerAuthorityId === right.providerAuthorityId
    && left.connectionEpoch === right.connectionEpoch
    && left.credentialRevision === right.credentialRevision;
}

function sameHandle(handle: SlackBridgeCredentialHandle, lease: ProviderCredentialLease): boolean {
  return handle.schema === SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA
    && handle.installId === lease.authority.installId
    && handle.providerAppId === lease.authority.providerAppId
    && handle.providerAuthorityId === lease.authority.providerAuthorityId
    && handle.connectionEpoch === lease.authority.connectionEpoch
    && handle.credentialRevision === lease.authority.credentialRevision
    && handle.leaseExpiresAt.getTime() === lease.expiresAt.getTime();
}

function exactProvisioningAuthority(
  request: SlackBridgeProvisioningProviderAuthority,
  authority: CredentialAuthority,
): boolean {
  return request.installId === authority.installId
    && request.providerAppId === authority.providerAppId
    && request.providerAuthorityId === authority.providerAuthorityId
    && request.botUserId === authority.botUserId
    && request.connectionEpoch === authority.connectionEpoch
    && request.credentialRevision === authority.credentialRevision;
}

function responseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function retryAfterMs(headers: Readonly<Record<string, string | undefined>>): number {
  const raw = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  if (!raw || !/^\d+$/.test(raw.trim())) return 60_000;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= 0
    ? Math.min(2_147_483_647, seconds * 1_000)
    : 60_000;
}

function nextCursor(body: Record<string, unknown>): string | null | undefined {
  if (!record(body.response_metadata) || typeof body.response_metadata.next_cursor !== "string") {
    return undefined;
  }
  return body.response_metadata.next_cursor.trim() || null;
}

function providerQuery(body: Record<string, unknown>): string | null {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (!nonEmpty(key, 160)) return null;
    if (typeof value === "string" || typeof value === "boolean") {
      query.set(key, String(value));
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      query.set(key, String(value));
      continue;
    }
    return null;
  }
  return query.toString();
}

/**
 * Database-backed one-use Slack credential custody. Runtime-generated bot
 * tokens remain encrypted at rest with an env master key; plaintext exists
 * only inside a claimed lease and is released before provider I/O.
 */
/** A failed channel listing must not erase a successful, identity-matched auth.test. */
export async function readSlackWorkspaceObservation(
  authority: SlackBridgeProvisioningProviderAuthority,
  query: (method: string, body: Record<string, unknown>) => Promise<SlackBridgeProvisioningProviderResult<Record<string, unknown>>>,
): Promise<SlackBridgeWorkspaceObservation> {
  const auth = await query("auth.test", {}).catch(() => ({ kind: "unverified" as const }));
  if (auth.kind !== "fact") return { oauth: auth.kind, directory: { kind: "unverified" } };
  const observedTeamId = auth.fact.team_id;
  const observedAppId = auth.fact.api_app_id;
  const observedBotUserId = auth.fact.user_id;
  if (
    observedTeamId !== authority.providerAuthorityId
    || (observedAppId !== undefined && observedAppId !== authority.providerAppId)
    || (observedBotUserId !== undefined && observedBotUserId !== authority.botUserId)
  ) return { oauth: "failed", directory: { kind: "unverified" } };
  const directory = await (async (): Promise<SlackBridgeProvisioningProviderResult<SlackBridgeWorkspaceDirectory>> => {
    const workspaceName = nonEmpty(auth.fact.team, 512) ? auth.fact.team : null;
    const channels = new Map<string, {
      id: string;
      name: string;
      privacyClass: "public" | "private";
      isMember: boolean;
    }>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
      const body: Record<string, unknown> = {
        exclude_archived: true,
        limit: 200,
        types: "public_channel,private_channel",
      };
      if (cursor) body.cursor = cursor;
      const response = await query("conversations.list", body);
      if (response.kind !== "fact") return response;
      if (!Array.isArray(response.fact.channels)) return { kind: "unverified" };
      for (const item of response.fact.channels) {
        if (!record(item)) return { kind: "unverified" };
        if (item.is_archived === true) continue;
        if (!nonEmpty(item.id, 160) || !nonEmpty(item.name, 512) || typeof item.is_private !== "boolean") {
          return { kind: "unverified" };
        }
        const privacyClass = item.is_private === true ? "private" as const : "public" as const;
        const isMember = item.is_member === true;
        const previous = channels.get(item.id);
        if (previous && (
          previous.name !== item.name
          || previous.privacyClass !== privacyClass
          || previous.isMember !== isMember
        )) {
          return { kind: "unverified" };
        }
        channels.set(item.id, { id: item.id, name: item.name, privacyClass, isMember });
      }
      const next = nextCursor(response.fact);
      if (next === undefined) return { kind: "unverified" };
      if (next === null) {
        return {
          kind: "fact",
          fact: {
            workspaceName,
            channels: [...channels.values()].sort((left, right) => left.id.localeCompare(right.id)),
          },
        };
      }
      if (seenCursors.has(next)) return { kind: "unverified" };
      seenCursors.add(next);
      cursor = next;
    }
    return { kind: "unverified" };
  })().catch(() => ({ kind: "unverified" as const }));
  return { oauth: "passed", directory };
}

export async function readSlackConversationMember(
  input: { providerConversationId: string; providerUserId: string },
  query: (body: Record<string, unknown>) => Promise<SlackBridgeProvisioningProviderResult<Record<string, unknown>>>,
): Promise<SlackBridgeProvisioningProviderResult<boolean>> {
  if (!nonEmpty(input.providerConversationId, 160) || !nonEmpty(input.providerUserId, 160)) return { kind: "unverified" };
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
    const body: Record<string, unknown> = { channel: input.providerConversationId, limit: 200 };
    if (cursor) body.cursor = cursor;
    const response = await query(body);
    if (response.kind !== "fact") return response;
    if (!Array.isArray(response.fact.members)
      || response.fact.members.some(value => !nonEmpty(value, 160))) return { kind: "unverified" };
    if (response.fact.members.includes(input.providerUserId)) return { kind: "fact", fact: true };
    const next = nextCursor(response.fact);
    if (next === undefined) return { kind: "unverified" };
    if (next === null) return { kind: "fact", fact: false };
    if (cursors.has(next)) return { kind: "unverified" };
    cursors.add(next);
    cursor = next;
  }
  return { kind: "unverified" };
}

export function createSlackBridgeProviderRuntime(
  dependencies: SlackBridgeProviderRuntimeDependencies,
): SlackBridgeProviderRuntime {
  const leaseTtlMs = dependencies.credentialLeaseTtlMs ?? DEFAULT_CREDENTIAL_LEASE_TTL_MS;
  const fetchTimeoutMs = dependencies.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const attachmentDownloadTimeoutMs = dependencies.attachmentDownloadTimeoutMs
    ?? DEFAULT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0 || leaseTtlMs > 5 * 60_000) {
    throw new Error("Slack provider credential lease TTL is invalid");
  }
  if (!Number.isSafeInteger(fetchTimeoutMs) || fetchTimeoutMs <= 0) {
    throw new Error("Slack provider fetch timeout is invalid");
  }
  if (
    !Number.isSafeInteger(attachmentDownloadTimeoutMs)
    || attachmentDownloadTimeoutMs <= 0
    || attachmentDownloadTimeoutMs > 30 * 60_000
  ) {
    throw new Error("Slack provider attachment download timeout is invalid");
  }
  const db = dependencies.db ?? getDb();
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? currentDate;
  const credentialLeases = new Map<string, ProviderCredentialLease>();
  const providerAbortControllers = new Set<AbortController>();
  let stopped = false;

  const releaseCredentialLease = async (
    installId: string,
    credentialRevision: number,
    leaseId: string,
    at: Date,
  ): Promise<void> => {
    await db.update(externalAppCredentials).set({
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: at,
    }).where(and(
      eq(externalAppCredentials.installId, installId),
      eq(externalAppCredentials.credentialRevision, credentialRevision),
      eq(externalAppCredentials.leaseOwner, leaseId),
    ));
  };

  // Lock order: slackBridgeRowLocks.ts (install, binding, credential, grant).
  const selectCredential = async (
    tx: Tx,
    request: SlackCredentialLockRequest,
    requestedAt: Date,
  ) => {
    const locked = await lockSlackInstallCredential(tx, request, requestedAt);
    if (!locked) return [];
    const { install, binding, credential } = locked;
    const row = {
      serverId: install.serverId,
      installId: install.id,
      registrationId: install.registrationId,
      installState: install.state,
      providerAppId: install.providerAppId,
      providerTeamId: install.providerTeamId,
      providerAuthorityId: install.providerAuthorityId,
      botUserId: install.botUserId,
      connectionEpoch: install.connectionEpoch,
      installCredentialRevision: install.credentialRevision,
      credentialId: credential.id,
      credentialState: credential.state,
      encryptedMaterial: credential.encryptedMaterial,
      envelopeKeyId: credential.envelopeKeyId,
      aadVersion: credential.aadVersion,
      credentialRevision: credential.credentialRevision,
    };
    return [binding
      ? {
          ...row,
          bindingServerId: binding.serverId,
          bindingRegistrationId: binding.registrationId,
          bindingGrantEpoch: binding.grantEpoch,
        }
      : row];
  };

  const claimCredential = async (
    request: {
      installId: string;
      providerAppId: string;
      providerAuthorityId: string;
      connectionEpoch: number;
      credentialRevision: number;
      binding?: Pick<SlackProviderAuthorityFence, "bindingId" | "bindingEpoch" | "providerConversationId">;
    },
    requestedAt: Date,
  ): Promise<ProviderCredentialLease | null> => {
    if (stopped || !validDate(requestedAt)) return null;
    const leaseId = `slack-provider:${randomUUID()}`;
    const leaseExpiresAt = new Date(requestedAt.getTime() + leaseTtlMs);
    const row = await db.transaction(async (tx) => {
      const candidates = await selectCredential(tx, request, requestedAt);
      if (candidates.length !== 1) return null;
      const current = candidates[0]!;
      if (
        current.installState !== "active"
        || current.credentialState !== "active"
        || current.providerAppId !== request.providerAppId
        || current.providerAuthorityId !== request.providerAuthorityId
        || current.connectionEpoch !== request.connectionEpoch
        || current.installCredentialRevision !== request.credentialRevision
        || current.credentialRevision !== request.credentialRevision
        || !nonEmpty(current.serverId)
        || !nonEmpty(current.providerTeamId)
        || !nonEmpty(current.botUserId)
      ) return null;
      if (request.binding) {
        if (
          !("bindingServerId" in current)
          || typeof current.bindingServerId !== "string"
          || !("bindingRegistrationId" in current)
          || typeof current.bindingRegistrationId !== "string"
          || !("bindingGrantEpoch" in current)
          || typeof current.bindingGrantEpoch !== "number"
          || current.bindingRegistrationId !== current.registrationId
        ) return null;
        const serverAuthority = await resolveExternalInstallServerGrantAuthority(tx, {
          installId: current.installId,
          serverId: current.bindingServerId,
          registrationId: current.bindingRegistrationId,
        }, { lock: true });
        if (!serverAuthority.current || current.bindingGrantEpoch !== serverAuthority.grant.grantEpoch) {
          return null;
        }
      } else {
        const serverAuthority = await findAnyCurrentExternalInstallServerGrantAuthority(tx, {
          installId: current.installId,
          registrationId: current.registrationId,
        }, { lock: true });
        if (!serverAuthority) return null;
      }
      const claimed = await tx.update(externalAppCredentials).set({
        leaseOwner: leaseId,
        leaseExpiresAt,
        updatedAt: requestedAt,
      }).where(and(
        eq(externalAppCredentials.id, current.credentialId),
        eq(externalAppCredentials.state, "active"),
        eq(externalAppCredentials.credentialRevision, request.credentialRevision),
        or(isNull(externalAppCredentials.leaseExpiresAt), lte(externalAppCredentials.leaseExpiresAt, requestedAt)),
      )).returning({ id: externalAppCredentials.id });
      return claimed.length === 1 ? current : null;
    });
    if (!row) return null;
    const material = dependencies.credentialCipher.unseal({
      serverId: row.serverId,
      providerAppId: row.providerAppId,
      providerTeamId: row.providerTeamId!,
      botUserId: row.botUserId!,
      encryptedMaterial: row.encryptedMaterial,
      envelopeKeyId: row.envelopeKeyId,
      aadVersion: row.aadVersion,
    });
    if (!material || stopped) {
      await releaseCredentialLease(row.installId, row.credentialRevision, leaseId, requestedAt);
      return null;
    }
    return {
      leaseId,
      accessToken: material.accessToken,
      expiresAt: leaseExpiresAt,
      authority: {
        serverId: row.serverId,
        installId: row.installId,
        providerAppId: row.providerAppId,
        providerTeamId: row.providerTeamId!,
        providerAuthorityId: row.providerAuthorityId,
        botUserId: row.botUserId!,
        connectionEpoch: row.connectionEpoch,
        credentialRevision: row.credentialRevision,
      },
    };
  };

  const callWithToken = async (input: {
    method: string;
    body: Record<string, unknown>;
    accessToken: string;
    timeoutMs?: number;
  }): Promise<SlackWebApiTransportResult> => {
    const queryMethod = SLACK_QUERY_METHODS.has(input.method);
    const requestBody = queryMethod ? providerQuery(input.body) : JSON.stringify(input.body);
    if (requestBody === null || Buffer.byteLength(requestBody, "utf8") > MAX_PROVIDER_REQUEST_BYTES) {
      return { kind: "transport_failure", phase: "before_send", code: "unavailable" };
    }
    const requestUrl = `https://slack.com/api/${input.method}`
      + (queryMethod && requestBody ? `?${requestBody}` : "");
    // One client span per outbound Web API request (method, status, 429,
    // Retry-After); before_send rejections above never reach Slack.
    return traceSlackWebApiRequest(input.method, () => sendWithToken({
      accessToken: input.accessToken,
      queryMethod,
      requestBody,
      requestUrl,
      timeoutMs: input.timeoutMs,
    }));
  };

  const sendWithToken = async (input: {
    accessToken: string;
    queryMethod: boolean;
    requestBody: string;
    requestUrl: string;
    timeoutMs?: number;
  }): Promise<SlackWebApiTransportResult> => {
    const { queryMethod, requestBody, requestUrl } = input;
    const controller = new AbortController();
    providerAbortControllers.add(controller);
    const timeout = setClockTimeout(() => controller.abort(), Math.min(input.timeoutMs ?? fetchTimeoutMs, fetchTimeoutMs));
    let receivedHeaders = false;
    try {
      const response = await fetcher(requestUrl, {
        method: queryMethod ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          ...(queryMethod ? {} : { "content-type": "application/json; charset=utf-8" }),
        },
        ...(queryMethod ? {} : { body: requestBody }),
        redirect: "error",
        signal: controller.signal,
      });
      receivedHeaders = true;
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
        return { kind: "transport_failure", phase: "after_send", code: "unavailable" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {};
      }
      return {
        kind: "response",
        status: response.status,
        headers: responseHeaders(response.headers),
        body: jsonObject(parsed),
      };
    } catch {
      return {
        kind: "transport_failure",
        phase: receivedHeaders ? "after_send" : "unknown",
        code: controller.signal.aborted ? "timeout" : "unavailable",
      };
    } finally {
      clearClockTimeout(timeout);
      providerAbortControllers.delete(controller);
    }
  };

  const attachmentFailure = (
    failureClass: "rate_limited" | "transient" | "deterministic" | "authority_revoked",
    reason: string,
    retryAfterMs: number | null = null,
    scope: "asset_global" | "occurrence_local" = "asset_global",
  ) => new SlackInboundAttachmentError({ class: failureClass, reason, retryAfterMs, scope });

  const resolveAttachmentCredentialRequest = async (authority: ExternalAttachmentAuthority) => {
    if (authority.provider !== "slack" || authority.workspaceId !== authority.providerAuthorityId) return null;
    const [historical] = await db.select({ channelId: externalChannelBindings.channelId,
      environment: externalAppRegistrations.environment }).from(externalChannelBindings)
      .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
      .innerJoin(externalAppRegistrations, eq(externalAppRegistrations.id, externalChannelBindings.registrationId))
      .where(and(eq(externalChannelBindings.id, authority.bindingId),
        eq(externalChannelBindings.installId, authority.installId),
        eq(externalChannelBindings.registrationId, authority.appRegistrationId),
        eq(externalChannelBindings.providerConversationId, authority.providerConversationId),
        eq(externalAppInstalls.providerAuthorityId, authority.providerAuthorityId),
        eq(externalAppRegistrations.provider, "slack"))).limit(1);
    if (!historical) return null;
    const rows = await db.select({
      installId: externalAppInstalls.id, providerAppId: externalAppInstalls.providerAppId,
      providerAuthorityId: externalAppInstalls.providerAuthorityId, connectionEpoch: externalAppInstalls.connectionEpoch,
      credentialRevision: externalAppInstalls.credentialRevision, bindingId: externalChannelBindings.id,
      providerConversationId: externalChannelBindings.providerConversationId, bindingEpoch: externalChannelBindings.bindingEpoch,
    }).from(externalAppInstalls)
      .innerJoin(externalChannelBindings, eq(externalChannelBindings.installId, externalAppInstalls.id))
      .innerJoin(externalAppRegistrations, eq(externalAppRegistrations.id, externalAppInstalls.registrationId))
      .where(and(
        eq(externalAppInstalls.providerAuthorityId, authority.providerAuthorityId),
        eq(externalAppInstalls.registrationId, authority.appRegistrationId),
        eq(externalAppInstalls.state, "active"),
        eq(externalChannelBindings.registrationId, authority.appRegistrationId),
        eq(externalChannelBindings.channelId, historical.channelId),
        eq(externalChannelBindings.providerConversationId, authority.providerConversationId),
        eq(externalChannelBindings.connectionEpoch, externalAppInstalls.connectionEpoch),
        eq(externalChannelBindings.state, "active"),
        eq(externalAppRegistrations.environment, historical.environment),
        eq(externalAppRegistrations.provider, "slack"),
      )).limit(2);
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    return {
      installId: row.installId,
      providerAppId: row.providerAppId,
      providerAuthorityId: row.providerAuthorityId,
      connectionEpoch: row.connectionEpoch,
      credentialRevision: row.credentialRevision,
      binding: {
        bindingId: row.bindingId,
        bindingEpoch: row.bindingEpoch,
        providerConversationId: row.providerConversationId,
      },
    };
  };

  const claimInboundAttachmentCredential = async (
    authority: ExternalAttachmentAuthority,
    requestedAt: Date,
  ) => {
    const request = validDate(requestedAt)
      ? await resolveAttachmentCredentialRequest(authority)
      : null;
    if (!request) {
      throw attachmentFailure(
        "authority_revoked",
        "provider_attachment_authority_unavailable",
        null,
        "occurrence_local",
      );
    }
    const lease = await claimCredential(request, requestedAt);
    if (lease) return lease;

    // A credential lease is intentionally exclusive across Server replicas.
    // Losing that short race means the credential is busy, not revoked. Keep
    // the attachment queued so it can retry after the competing provider call
    // releases the lease.
    const credentials = await db.select({
      state: externalAppCredentials.state,
      credentialRevision: externalAppCredentials.credentialRevision,
      expiresAt: externalAppCredentials.expiresAt,
    }).from(externalAppCredentials).where(and(
      eq(externalAppCredentials.installId, request.installId),
      eq(externalAppCredentials.credentialRevision, request.credentialRevision),
    )).limit(2);
    const credential = credentials.length === 1 ? credentials[0]! : null;
    if (
      credential?.state === "active"
      && credential.credentialRevision === request.credentialRevision
      && (credential.expiresAt === null || credential.expiresAt > requestedAt)
    ) {
      throw attachmentFailure(
        "transient",
        "provider_attachment_credential_busy",
        null,
        "occurrence_local",
      );
    }
    throw attachmentFailure(
      "authority_revoked",
      "provider_attachment_authority_unavailable",
      null,
      "occurrence_local",
    );
  };

  const inboundAttachmentTransport: SlackInboundAttachmentTransport = {
    async inspect({ authority, providerFileId }) {
      const requestedAt = now();
      const lease = await claimInboundAttachmentCredential(authority, requestedAt);
      try {
        const response = await callWithToken({
          method: "files.info",
          body: { file: providerFileId },
          accessToken: lease.accessToken,
        });
        if (response.kind === "transport_failure") {
          throw attachmentFailure("transient", "provider_file_metadata_unavailable");
        }
        const providerError = nonEmpty(response.body.error, 160) ? response.body.error : null;
        if (response.status === 429) {
          throw attachmentFailure(
            "rate_limited",
            "provider_file_metadata_rate_limited",
            retryAfterMs(response.headers),
          );
        }
        if (providerError && SLACK_AUTH_REVOKED_ERRORS.has(providerError)) {
          throw attachmentFailure(
            "authority_revoked",
            "provider_attachment_authority_revoked",
            null,
            "occurrence_local",
          );
        }
        if (response.status < 200 || response.status >= 300 || response.body.ok !== true) {
          throw attachmentFailure(
            providerError === "file_not_found" || providerError === "missing_scope"
              ? "deterministic"
              : "transient",
            providerError === "file_not_found"
              ? "provider_file_not_found"
              : providerError === "missing_scope"
                ? "provider_file_scope_missing"
                : "provider_file_metadata_unavailable",
            null,
            providerError === "missing_scope" ? "occurrence_local" : "asset_global",
          );
        }
        const file = record(response.body.file) ? response.body.file : null;
        const id = file && nonEmpty(file.id, 320) ? file.id : null;
        const user = file && nonEmpty(file.user, 160) ? file.user : null;
        const name = file && nonEmpty(file.name, 1024) ? file.name : null;
        const mimetype = file && nonEmpty(file.mimetype, 255) ? file.mimetype : null;
        const urlPrivateDownload = file && nonEmpty(file.url_private_download, 4096)
          ? file.url_private_download
          : file && nonEmpty(file.url_private, 4096)
            ? file.url_private
            : null;
        const size = file?.size;
        const timestamp = file?.timestamp;
        if (!id || !user || !name || !mimetype || !urlPrivateDownload || typeof size !== "number") {
          throw attachmentFailure("deterministic", "provider_file_metadata_invalid");
        }
        return {
          id,
          user,
          name,
          mimetype,
          size,
          timestamp: typeof timestamp === "number" ? timestamp : null,
          urlPrivateDownload,
        };
      } finally {
        const releasedAt = now();
        await releaseCredentialLease(
          lease.authority.installId,
          lease.authority.credentialRevision,
          lease.leaseId,
          validDate(releasedAt) ? releasedAt : currentDate(),
        );
      }
    },
    async *download({ authority, privateUrl, maximumBytes, signal }) {
      let parsedPrivateUrl: URL;
      try {
        parsedPrivateUrl = new URL(privateUrl);
      } catch {
        throw attachmentFailure("deterministic", "provider_file_download_locator_invalid");
      }
      if (
        parsedPrivateUrl.protocol !== "https:"
        || parsedPrivateUrl.hostname !== "files.slack.com"
        || parsedPrivateUrl.username
        || parsedPrivateUrl.password
        || parsedPrivateUrl.hash
      ) throw attachmentFailure("deterministic", "provider_file_download_locator_invalid");
      const requestedAt = now();
      const lease = await claimInboundAttachmentCredential(authority, requestedAt);
      const controller = new AbortController();
      providerAbortControllers.add(controller);
      const abortFromCaller = () => controller.abort();
      signal.addEventListener("abort", abortFromCaller, { once: true });
      const timeout = setClockTimeout(() => controller.abort(), attachmentDownloadTimeoutMs);
      try {
        const response = await fetcher(privateUrl, {
          method: "GET",
          headers: { authorization: `Bearer ${lease.accessToken}` },
          redirect: "error",
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          throw attachmentFailure(
            "authority_revoked",
            "provider_attachment_authority_revoked",
            null,
            "occurrence_local",
          );
        }
        if (response.status === 404 || response.status === 410) {
          throw attachmentFailure("deterministic", "provider_file_not_found");
        }
        if (response.status === 429) {
          throw attachmentFailure(
            "rate_limited",
            "provider_file_download_rate_limited",
            retryAfterMs(responseHeaders(response.headers)),
          );
        }
        if (!response.ok || !response.body) {
          throw attachmentFailure("transient", "provider_file_download_unavailable");
        }
        const contentLengthHeader = response.headers.get("content-length");
        if (contentLengthHeader) {
          const contentLength = /^\d+$/.test(contentLengthHeader) ? Number(contentLengthHeader) : Number.NaN;
          if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
            throw attachmentFailure("deterministic", "provider_file_content_length_invalid");
          }
          if (contentLength > maximumBytes) {
            throw attachmentFailure(
              "deterministic",
              "provider_file_size_exceeds_plan",
              null,
              "occurrence_local",
            );
          }
        }
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          yield chunk;
        }
      } catch (error) {
        if (error instanceof SlackInboundAttachmentError) throw error;
        throw attachmentFailure(
          controller.signal.aborted ? "transient" : "transient",
          controller.signal.aborted ? "provider_file_download_timeout" : "provider_file_download_unavailable",
        );
      } finally {
        clearClockTimeout(timeout);
        signal.removeEventListener("abort", abortFromCaller);
        providerAbortControllers.delete(controller);
        const releasedAt = now();
        await releaseCredentialLease(
          lease.authority.installId,
          lease.authority.credentialRevision,
          lease.leaseId,
          validDate(releasedAt) ? releasedAt : currentDate(),
        );
      }
    },
  };

  const createOutboundAttachmentTransport = async (
    handle: SlackBridgeCredentialHandle,
    attachmentAuthority: SlackProviderAuthorityFence,
  ): Promise<SlackOutboundAttachmentTransport | null> => {
    const lease = credentialLeases.get(handle.leaseId);
    const preparedAt = now();
    if (
      !lease
      || !sameHandle(handle, lease)
      || !sameAuthority(attachmentAuthority, lease.authority)
      || !validDate(preparedAt)
      || handle.leaseExpiresAt <= preparedAt
      || stopped
    ) return null;
    credentialLeases.delete(handle.leaseId);
    await releaseCredentialLease(
      lease.authority.installId,
      lease.authority.credentialRevision,
      lease.leaseId,
      preparedAt,
    );
    const fail = (
      failureClass: "rate_limited" | "transient" | "deterministic" | "outcome_unknown" | "authority_revoked",
      reason: string,
      retryAfterValue: number | null = null,
    ) => new SlackOutboundAttachmentError({
      class: failureClass,
      reason,
      retryAfterMs: retryAfterValue,
      scope: "occurrence_local",
    });
    const assertAuthority = (authority: ExternalAttachmentAuthority) => {
      const calledAt = now();
      if (
        !validDate(calledAt)
        || stopped
        || authority.provider !== "slack"
        || authority.installId !== lease.authority.installId
        || authority.workspaceId !== lease.authority.providerAuthorityId
        || authority.providerAuthorityId !== lease.authority.providerAuthorityId
        || authority.providerConversationId !== attachmentAuthority.providerConversationId
        || authority.connectionEpoch !== lease.authority.connectionEpoch
        || authority.bindingId !== attachmentAuthority.bindingId
        || authority.bindingEpoch !== attachmentAuthority.bindingEpoch
      ) throw fail("authority_revoked", "provider_attachment_authority_mismatch");
    };
    const authorizeProviderCall = async (authority: ExternalAttachmentAuthority): Promise<string> => {
      assertAuthority(authority);
      const requestedAt = now();
      if (!validDate(requestedAt)) throw fail("authority_revoked", "provider_attachment_authority_mismatch");
      const currentLease = await claimCredential({
        installId: attachmentAuthority.installId,
        providerAppId: attachmentAuthority.providerAppId,
        providerAuthorityId: attachmentAuthority.providerAuthorityId,
        connectionEpoch: attachmentAuthority.connectionEpoch,
        credentialRevision: attachmentAuthority.credentialRevision,
        binding: {
          bindingId: attachmentAuthority.bindingId,
          bindingEpoch: attachmentAuthority.bindingEpoch,
          providerConversationId: attachmentAuthority.providerConversationId,
        },
      }, requestedAt);
      if (!currentLease) throw fail("authority_revoked", "provider_attachment_authority_unavailable");
      await releaseCredentialLease(
        currentLease.authority.installId,
        currentLease.authority.credentialRevision,
        currentLease.leaseId,
        requestedAt,
      );
      return currentLease.accessToken;
    };
    const providerCall = async (
      authority: ExternalAttachmentAuthority,
      method: string,
      body: Record<string, unknown>,
    ) => {
      const accessToken = await authorizeProviderCall(authority);
      const response = await callWithToken({ method, body, accessToken });
      if (response.kind === "transport_failure") {
        throw fail(
          response.phase === "before_send" ? "transient" : "outcome_unknown",
          response.phase === "before_send" ? "provider_request_not_sent" : "provider_request_outcome_unknown",
        );
      }
      const error = nonEmpty(response.body.error, 160) ? response.body.error : null;
      if (response.status === 429) {
        throw fail("rate_limited", "provider_rate_limited", retryAfterMs(response.headers));
      }
      if (error && SLACK_AUTH_REVOKED_ERRORS.has(error)) {
        throw fail("authority_revoked", "provider_attachment_authority_revoked");
      }
      if (response.status < 200 || response.status >= 300 || response.body.ok !== true) {
        throw fail(
          error === "file_not_found" || error === "channel_not_found" || error === "missing_scope"
            ? "deterministic"
            : "transient",
          error === "file_not_found"
            ? "provider_file_not_found"
            : error === "channel_not_found"
              ? "provider_channel_not_found"
              : error === "missing_scope"
                ? "provider_file_scope_missing"
                : "provider_attachment_request_failed",
        );
      }
      return response.body;
    };
    return {
      async createUpload({ authority, asset }) {
        assertAuthority(authority);
        const body = await providerCall(authority, "files.getUploadURLExternal", {
          filename: asset.filename,
          length: asset.byteSize,
        });
        if (!nonEmpty(body.file_id, 320) || !nonEmpty(body.upload_url, 4096)) {
          throw fail("deterministic", "provider_upload_ticket_invalid");
        }
        return { providerFileId: body.file_id, uploadUrl: body.upload_url };
      },
      async upload({ authority, uploadUrl, bytes, expectedByteSize, expectedContentDigest, signal }) {
        await authorizeProviderCall(authority);
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        providerAbortControllers.add(controller);
        const timeout = setClockTimeout(() => controller.abort(), attachmentDownloadTimeoutMs);
        let byteSize = 0;
        const hash = createHash("sha256");
        const verified = async function* () {
          for await (const raw of bytes) {
            const chunk = Buffer.from(raw);
            byteSize += chunk.length;
            if (byteSize > expectedByteSize) throw fail("deterministic", "attachment_upload_size_mismatch");
            hash.update(chunk);
            yield chunk;
          }
          if (byteSize !== expectedByteSize) throw fail("deterministic", "attachment_upload_size_mismatch");
          if (hash.digest("hex") !== expectedContentDigest) {
            throw fail("deterministic", "attachment_upload_digest_mismatch");
          }
        };
        try {
          const response = await fetcher(uploadUrl, {
            method: "POST",
            body: Readable.from(verified()),
            redirect: "error",
            signal: controller.signal,
            duplex: "half",
          } as unknown as RequestInit & { duplex: "half" });
          if (!response.ok) {
            throw fail(
              response.status === 429 ? "rate_limited" : response.status >= 500 ? "outcome_unknown" : "deterministic",
              response.status === 429 ? "provider_upload_rate_limited" : "provider_upload_failed",
              response.status === 429 ? retryAfterMs(responseHeaders(response.headers)) : null,
            );
          }
          return { uploadedByteSize: byteSize, uploadedContentDigest: expectedContentDigest };
        } catch (error) {
          if (error instanceof SlackOutboundAttachmentError) throw error;
          throw fail(controller.signal.aborted ? "outcome_unknown" : "outcome_unknown", "provider_upload_outcome_unknown");
        } finally {
          clearClockTimeout(timeout);
          signal.removeEventListener("abort", abort);
          providerAbortControllers.delete(controller);
        }
      },
      async complete({ authority, completion }) {
        assertAuthority(authority);
        const username = renderSlackBridgeUsername(completion.author.displayName);
        const body = await providerCall(authority, "files.completeUploadExternal", {
          ...(username ? { username } : {}),
          ...(completion.author.avatarPublicUrl
            ? { icon_url: completion.author.avatarPublicUrl }
            : { icon_emoji: completion.author.fallbackKind === "agent" ? ":robot_face:" : ":bust_in_silhouette:" }),
          files: completion.providerFileIds.map((id) => ({ id })),
          channel_id: completion.providerConversationId,
          ...(completion.providerRootThreadId ? { thread_ts: completion.providerRootThreadId } : {}),
          ...(completion.renderedText ? { initial_comment: completion.renderedText } : {}),
        });
        if (!Array.isArray(body.files)) throw fail("outcome_unknown", "provider_completion_receipt_invalid");
        const returnedIds = body.files.flatMap((file) => (
          record(file) && nonEmpty(file.id, 320) ? [file.id] : []
        )).sort();
        const expectedIds = [...completion.providerFileIds].sort();
        if (returnedIds.length !== expectedIds.length || returnedIds.some((id, index) => id !== expectedIds[index])) {
          throw fail("outcome_unknown", "provider_completion_file_set_mismatch");
        }
        return { kind: "accepted_pending_correlation" };
      },
      async correlate({ authority, correlation }) {
        assertAuthority(authority);
        const method = correlation.providerRootThreadId
          ? "conversations.replies"
          : "conversations.history";
        const body = await providerCall(authority, method, {
          channel: correlation.providerConversationId,
          ...(correlation.providerRootThreadId ? { ts: correlation.providerRootThreadId } : {}),
          limit: 100,
        });
        const expected = [...correlation.providerFileIds].sort();
        const matches = Array.isArray(body.messages) ? body.messages.flatMap((message) => {
          if (!record(message) || !nonEmpty(message.ts, 160) || !Array.isArray(message.files)) return [];
          const ids = message.files.flatMap((file) => (
            record(file) && nonEmpty(file.id, 320) ? [file.id] : []
          )).sort();
          return ids.length === expected.length && ids.every((id, index) => id === expected[index])
            ? [message.ts]
            : [];
        }) : [];
        if (matches.length === 0) return { kind: "pending" };
        if (matches.length !== 1) return { kind: "conflict", reason: "provider_file_set_correlation_ambiguous" };
        return { kind: "matched", providerMessageId: matches[0]! };
      },
      classify(error) {
        return error instanceof SlackOutboundAttachmentError
          ? error.failure
          : {
            class: "outcome_unknown",
            reason: "provider_attachment_io_exception",
            retryAfterMs: null,
            scope: "occurrence_local",
          };
      },
    };
  };

  const credentialResolver: SlackAudienceCredentialResolver = {
    async resolve({ authority, now: requestedAt }) {
      const lease = await claimCredential({
        installId: authority.installId,
        providerAppId: authority.providerAppId,
        providerAuthorityId: authority.providerAuthorityId,
        connectionEpoch: authority.connectionEpoch,
        credentialRevision: authority.credentialRevision,
        binding: {
          bindingId: authority.bindingId,
          bindingEpoch: authority.bindingEpoch,
          providerConversationId: authority.providerConversationId,
        },
      }, requestedAt);
      if (!lease) return null;
      credentialLeases.set(lease.leaseId, lease);
      return {
        schema: SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
        leaseId: lease.leaseId,
        installId: authority.installId,
        providerAppId: authority.providerAppId,
        providerAuthorityId: authority.providerAuthorityId,
        connectionEpoch: authority.connectionEpoch,
        credentialRevision: authority.credentialRevision,
        leaseExpiresAt: lease.expiresAt,
      };
    },
  };

  const transport: SlackWebApiTransport = {
    evidence: "live",
    async call(request: SlackWebApiRequest): Promise<SlackWebApiTransportResult> {
      const lease = credentialLeases.get(request.credentialHandle.leaseId);
      credentialLeases.delete(request.credentialHandle.leaseId);
      if (!lease) return { kind: "transport_failure", phase: "before_send", code: "unavailable" };
      const calledAt = now();
      const releaseAt = validDate(calledAt) ? calledAt : currentDate();
      await releaseCredentialLease(
        lease.authority.installId,
        lease.authority.credentialRevision,
        lease.leaseId,
        releaseAt,
      );
      if (
        stopped
        || !validDate(calledAt)
        || lease.expiresAt <= calledAt
        || !sameAuthority(request.authority, lease.authority)
        || !sameHandle(request.credentialHandle, lease)
      ) return { kind: "transport_failure", phase: "before_send", code: "unavailable" };
      return callWithToken({
        method: request.method,
        body: request.body,
        accessToken: lease.accessToken,
      });
    },
  };

  const releaseCredential = async (handle: SlackBridgeCredentialHandle): Promise<void> => {
    const lease = credentialLeases.get(handle.leaseId);
    credentialLeases.delete(handle.leaseId);
    if (!lease || !sameHandle(handle, lease)) return;
    const releasedAt = now();
    await releaseCredentialLease(
      lease.authority.installId,
      lease.authority.credentialRevision,
      lease.leaseId,
      validDate(releasedAt) ? releasedAt : currentDate(),
    );
  };

  const quarantineSink: SlackProviderAuthorityQuarantineSink = {
    async quarantine(fence) {
      return db.transaction(async (tx) => {
        const [install] = await tx.select().from(externalAppInstalls)
          .where(eq(externalAppInstalls.id, fence.installId)).for("update").limit(1);
        const [binding] = await tx.select().from(externalChannelBindings)
          .where(eq(externalChannelBindings.id, fence.bindingId)).for("update").limit(1);
        const [credential] = await tx.select().from(externalAppCredentials)
          .where(eq(externalAppCredentials.installId, fence.installId)).for("update").limit(1);
        if (
          !install || !binding || !credential
          || install.providerAppId !== fence.providerAppId
          || install.providerAuthorityId !== fence.providerAuthorityId
          || install.connectionEpoch !== fence.connectionEpoch
          || install.credentialRevision !== fence.credentialRevision
          || binding.installId !== fence.installId
          || binding.providerConversationId !== fence.providerConversationId
          || binding.connectionEpoch !== fence.connectionEpoch
          || binding.bindingEpoch !== fence.bindingEpoch
          || credential.credentialRevision !== fence.credentialRevision
        ) return "fence_mismatch";
        if (install.state !== "active" || binding.state !== "active" || credential.state !== "active") {
          return "already_fenced";
        }
        const at = now();
        await tx.update(externalAppInstalls).set({
          state: fence.reason === "provider_credential_revoked" ? "reauth_required" : "quarantined",
          stateReason: fence.reason,
          updatedAt: at,
        }).where(and(
          eq(externalAppInstalls.id, fence.installId),
          eq(externalAppInstalls.state, "active"),
          eq(externalAppInstalls.connectionEpoch, fence.connectionEpoch),
          eq(externalAppInstalls.credentialRevision, fence.credentialRevision),
        ));
        await tx.update(externalChannelBindings).set({
          state: "quarantined",
          stateReason: fence.reason,
          updatedAt: at,
        }).where(and(
          eq(externalChannelBindings.id, fence.bindingId),
          eq(externalChannelBindings.state, "active"),
          eq(externalChannelBindings.connectionEpoch, fence.connectionEpoch),
          eq(externalChannelBindings.bindingEpoch, fence.bindingEpoch),
        ));
        if (fence.reason === "provider_credential_revoked") {
          await tx.update(externalAppCredentials).set({
            state: "revoked",
            revokedAt: at,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: at,
          }).where(and(
            eq(externalAppCredentials.id, credential.id),
            eq(externalAppCredentials.state, "active"),
            eq(externalAppCredentials.credentialRevision, fence.credentialRevision),
          ));
        }
        await tx.update(externalMessageLinks).set({
          authorityState: "stale",
          stateReason: fence.reason,
          updatedAt: at,
        }).where(and(
          eq(externalMessageLinks.bindingId, fence.bindingId),
          eq(externalMessageLinks.bindingEpoch, fence.bindingEpoch),
          eq(externalMessageLinks.connectionEpoch, fence.connectionEpoch),
          eq(externalMessageLinks.authorityState, "active"),
        ));
        return "applied";
      });
    },
  };

  const provisioningCall = async (
    authority: SlackBridgeProvisioningProviderAuthority,
    method: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<SlackBridgeProvisioningProviderResult<Record<string, unknown>>> => {
    const result = await provisioningCallWithMetadata(authority, method, body, timeoutMs);
    return result.kind === "fact"
      ? { kind: "fact", fact: result.fact.body }
      : result;
  };

  const provisioningCallWithMetadata = async (
    authority: SlackBridgeProvisioningProviderAuthority,
    method: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<SlackBridgeProvisioningProviderResult<{
    body: Record<string, unknown>;
    headers: Readonly<Record<string, string | undefined>>;
  }>> => {
    if (authority.isRunHeld && !await authority.isRunHeld()) return { kind: "unverified" };
    const lease = await claimCredential({
      installId: authority.installId,
      providerAppId: authority.providerAppId,
      providerAuthorityId: authority.providerAuthorityId,
      connectionEpoch: authority.connectionEpoch,
      credentialRevision: authority.credentialRevision,
    }, authority.now);
    if (!lease) return { kind: "unverified" };
    await releaseCredentialLease(
      lease.authority.installId,
      lease.authority.credentialRevision,
      lease.leaseId,
      authority.now,
    );
    if (
      stopped
      || (authority.isRunHeld && !await authority.isRunHeld())
      || lease.expiresAt <= authority.now
      || !exactProvisioningAuthority(authority, lease.authority)
    ) return { kind: "unverified" };
    const result = await callWithToken({ method, body, accessToken: lease.accessToken, timeoutMs });
    if (result.kind !== "response") return { kind: "unverified" };
    const responseBody = result.body as Record<string, unknown>;
    if (result.status === 429) return { kind: "unverified", retryAfterMs: retryAfterMs(result.headers) };
    if (result.status >= 500) return { kind: "unverified" };
    if (responseBody.ok !== true) {
      const slackError = typeof responseBody.error === "string"
        ? responseBody.error.slice(0, 160)
        : undefined;
      console.warn("[SlackBridge] provisioning call failed", {
        method,
        status: result.status,
        slackError,
      });
      return { kind: "failed", slackError };
    }
    return {
      kind: "fact",
      fact: { body: responseBody, headers: result.headers },
    };
  };

  const resolveUsers: SlackBridgeProviderRuntime["resolveUsers"] = async (authority, providerUserIds) => {
    if (
      stopped
      || !validDate(authority.now)
      || providerUserIds.length === 0
      || providerUserIds.length > 50
      || new Set(providerUserIds).size !== providerUserIds.length
      || providerUserIds.some((providerUserId) => !nonEmpty(providerUserId, 160))
    ) return { kind: "unverified" };
    const users: SlackBridgeProvisioningProviderUser[] = [];
    for (const providerUserId of providerUserIds) {
      const response = await provisioningCall(authority, "users.info", { user: providerUserId });
      if (response.kind !== "fact") return response;
      const user = slackProvisioningUser(response.fact.user, providerUserId);
      if (!user) return { kind: "failed" };
      users.push(user);
    }
    return { kind: "fact", fact: { users } };
  };

  const resolveAgentMentionHandles: SlackBridgeProviderRuntime["resolveAgentMentionHandles"] = async (
    authority,
    input,
  ) => {
    if (
      stopped
      || !validDate(authority.now)
      || !nonEmpty(input.serverId, 160)
      || input.providerUsergroupIds.length === 0
      || input.providerUsergroupIds.length > 50
      || new Set(input.providerUsergroupIds).size !== input.providerUsergroupIds.length
      || input.providerUsergroupIds.some((id) => !/^S[A-Z0-9]{2,}$/u.test(id))
    ) return { kind: "unverified" };
    const listed = await provisioningCall(authority, "usergroups.list", {
      include_count: false,
      include_disabled: true,
    });
    if (listed.kind !== "fact") return listed;
    if (!Array.isArray(listed.fact.usergroups)) return { kind: "unverified" };
    const requested = new Set(input.providerUsergroupIds);
    const identities = await listSlackUsergroupIdentities(db, authority.installId, input.serverId);
    const handles: SlackBridgeAgentMentionHandle[] = [];
    const humanHandles: SlackBridgeHumanMentionHandle[] = [];
    for (const raw of listed.fact.usergroups) {
      const group = parseSlackAgentUsergroup(raw);
      if (!group) return { kind: "unverified" };
      if (!requested.has(group.id)) continue;
      const identity = identities.find((row) => row.providerUsergroupId === group.id
        || (row.providerUsergroupId === null && slackUsergroupRecoveryDescription(row) === group.description));
      // Retired human aliases remain identity locators for queued old tokens;
      // the inbound worker still requires current channel membership. Agent
      // groups retain their existing enabled-only behavior.
      if (group.disabled && identity?.principalKind !== "user") continue;
      // A known provider id is authoritative; human-readable descriptions are
      // not interpreted as names/handles or trusted as identity metadata.
      const description = identity ? slackUsergroupIdentityMarker(identity) : group.description;
      const marker = parseSlackAgentUsergroupMarker(description);
      if (marker && marker.serverId === input.serverId) {
        handles.push({
          agentId: marker.agentId,
          providerUsergroupId: group.id,
          handle: group.handle.toLocaleLowerCase("en-US"),
        });
        continue;
      }
      const humanMarker = parseSlackHumanUsergroupMarker(description);
      const humanUserId = identity?.principalKind === "user" ? identity.principalId
        : humanMarker?.serverId === input.serverId ? humanMarker.userId : null;
      if (humanUserId) {
        humanHandles.push({
          userId: humanUserId,
          providerUsergroupId: group.id,
          handle: group.handle.toLocaleLowerCase("en-US"),
        });
      }
    }
    const providerUsergroupIds = [...handles, ...humanHandles]
      .map((handle) => handle.providerUsergroupId);
    if (new Set(providerUsergroupIds).size !== providerUsergroupIds.length) {
      return { kind: "failed" };
    }
    const byProviderUsergroupId = (
      left: { providerUsergroupId: string },
      right: { providerUsergroupId: string },
    ) => left.providerUsergroupId.localeCompare(right.providerUsergroupId);
    return {
      kind: "fact",
      fact: {
        handles: handles.sort(byProviderUsergroupId),
        humanHandles: humanHandles.sort(byProviderUsergroupId),
      },
    };
  };

  const provisioningProvider: SlackBridgeProvisioningProvider = {
    async readInstallGrant(authority) {
      if (stopped || !validDate(authority.now)) return { kind: "unverified" };
      const auth = await provisioningCallWithMetadata(authority, "auth.test", {});
      if (auth.kind !== "fact") return auth;
      const observedTeamId = auth.fact.body.team_id;
      const observedBotUserId = auth.fact.body.user_id;
      const observedBotId = auth.fact.body.bot_id;
      const scopesHeader = auth.fact.headers["x-oauth-scopes"];
      if (
        observedTeamId !== authority.providerAuthorityId
        || observedBotUserId !== authority.botUserId
        || !nonEmpty(observedBotId, 160)
        || !nonEmpty(scopesHeader, 8_192)
      ) return { kind: "failed" };
      const grantedScopes = [...new Set(scopesHeader.split(",")
        .map((scope) => scope.trim())
        .filter((scope) => nonEmpty(scope, 160)))]
        .sort();
      if (grantedScopes.length === 0) return { kind: "unverified" };
      return {
        kind: "fact",
        fact: {
          // auth.test intentionally does not claim app identity. The provider
          // app is the durable install/credential authority that had to match
          // before the token lease was released for this call.
          providerAppId: authority.providerAppId,
          providerAuthorityId: observedTeamId,
          botUserId: observedBotUserId,
          providerBotId: observedBotId,
          grantedScopes,
        },
      };
    },

    async readWorkspace(authority) {
      if (stopped || !validDate(authority.now)) {
        return { oauth: "unverified", directory: { kind: "unverified" } };
      }
      return readSlackWorkspaceObservation(authority, (method, body) => provisioningCall(authority, method, body));
    },

    async readUserProfile(authority) {
      if (stopped || !validDate(authority.now) || !nonEmpty(authority.providerUserId, 160)) return { kind: "unverified" };
      const response = await provisioningCall(authority, "users.info", { user: authority.providerUserId }, JOIN_PROFILE_FETCH_TIMEOUT_MS);
      if (response.kind !== "fact") return response;
      const raw = response.fact.user;
      if (!record(raw) || raw.deleted === true || typeof raw.is_bot !== "boolean") return { kind: "unverified" };
      const user = slackProvisioningUser(raw, authority.providerUserId);
      return user && user.displayName !== authority.providerUserId ? { kind: "fact", fact: user } : { kind: "unverified" };
    },

    async readConversationState(authority) {
      if (stopped || !validDate(authority.now) || !nonEmpty(authority.providerConversationId, 160)) return { kind: "unverified" };
      const response = await provisioningCall(authority, "conversations.info", { channel: authority.providerConversationId });
      if (response.kind !== "fact") return response;
      const channel = response.fact.channel;
      if (!record(channel) || channel.id !== authority.providerConversationId || !nonEmpty(channel.name, 200)
        || typeof channel.is_archived !== "boolean" || typeof channel.is_member !== "boolean") return { kind: "unverified" };
      return { kind: "fact", fact: { id: channel.id, name: channel.name, isArchived: channel.is_archived, isMember: channel.is_member } };
    },

    async readConversationMember(authority) {
      if (stopped || !validDate(authority.now) || !nonEmpty(authority.providerConversationId, 160)
        || !nonEmpty(authority.providerUserId, 160)) return { kind: "unverified" };
      return readSlackConversationMember(authority, body => provisioningCall(authority, "conversations.members", body));
    },

    async readConversationAudience(authority) {
      if (
        stopped
        || !validDate(authority.now)
        || !nonEmpty(authority.providerConversationId, 160)
      ) return { kind: "unverified" };
      const providerMemberIds = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let completed = false;
      for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
        const body: Record<string, unknown> = {
          channel: authority.providerConversationId,
          limit: 200,
        };
        if (cursor) body.cursor = cursor;
        const response = await provisioningCall(authority, "conversations.members", body);
        if (response.kind !== "fact") return response;
        if (!Array.isArray(response.fact.members)) return { kind: "unverified" };
        for (const item of response.fact.members) {
          if (!nonEmpty(item, 160)) return { kind: "unverified" };
          providerMemberIds.add(item);
        }
        const next = nextCursor(response.fact);
        if (next === undefined) return { kind: "unverified" };
        if (next === null) {
          completed = true;
          break;
        }
        if (seenCursors.has(next)) return { kind: "unverified" };
        seenCursors.add(next);
        cursor = next;
      }
      if (!completed) return { kind: "unverified" };

      const users: SlackBridgeProvisioningProviderUser[] = [];
      const observableMemberIds = [...providerMemberIds]
        .filter((providerUserId) => providerUserId !== authority.botUserId)
        .sort();
      if (observableMemberIds.length === 0 || observableMemberIds.length > 500) {
        return { kind: "unverified" };
      }
      for (const providerUserId of observableMemberIds) {
        const response = await provisioningCall(authority, "users.info", { user: providerUserId });
        if (response.kind !== "fact") return response;
        const user = slackProvisioningUser(response.fact.user, providerUserId);
        if (!user) return { kind: "failed" };
        users.push(user);
      }
      return {
        kind: "fact",
        fact: {
          providerMemberIds: [...providerMemberIds].sort(),
          users,
        },
      };
    },

    async reconcileAgentMentionHandles(authority, request) {
      let humanCandidates = request.humanCandidates;
      if (
        stopped
        || !validDate(authority.now)
        || !nonEmpty(request.serverId, 160)
        || request.candidates.length > 200
        || request.candidates.some((candidate) => (
          candidate.serverId !== request.serverId
          || !nonEmpty(candidate.agentId, 160)
          || !nonEmpty(candidate.name, 160)
          || !nonEmpty(candidate.displayName, 512)
          || !nonEmpty(candidate.serverSlug, 160)
          || !nonEmpty(candidate.serverName, 512)
        ))
        || new Set(request.candidates.map((candidate) => candidate.agentId)).size
          !== request.candidates.length
        || (humanCandidates ?? []).some((candidate) => (
          candidate.serverId !== request.serverId
          || !nonEmpty(candidate.userId, 160)
          || !nonEmpty(candidate.name, 160)
          || !nonEmpty(candidate.displayName, 512)
          || !nonEmpty(candidate.serverSlug, 160)
          || !nonEmpty(candidate.serverName, 512)
        ))
        || new Set((humanCandidates ?? []).map((candidate) => candidate.userId)).size
          !== (humanCandidates?.length ?? 0)
      ) return { kind: "unverified" };

      const observedNow = () => Math.max(authority.now.getTime(), now().getTime());
      const [install] = await db.select({
        rateLimitedUntil: externalAppInstalls.slackMentionRateLimitedUntil,
        humanSnapshot: externalAppInstalls.slackHumanMentionSnapshot,
        capability: externalAppInstalls.slackMentionCapability,
      }).from(externalAppInstalls).where(and(
        eq(externalAppInstalls.id, authority.installId),
        eq(externalAppInstalls.connectionEpoch, authority.connectionEpoch),
        eq(externalAppInstalls.credentialRevision, authority.credentialRevision),
        eq(externalAppInstalls.state, "active"),
      )).limit(1);
      if (!install) return { kind: "unverified" };
      const capability = slackMentionCapabilitySchema.safeParse(install.capability);
      if (capability.success && capability.data.result === "paid_teams_only"
        && capability.data.connectionEpoch === authority.connectionEpoch
        && capability.data.credentialRevision === authority.credentialRevision) {
        return { kind: "failed", slackError: "paid_teams_only" };
      }
      if (install.rateLimitedUntil && install.rateLimitedUntil.getTime() > observedNow()) {
        return { kind: "unverified", retryAfterMs: install.rateLimitedUntil.getTime() - observedNow() };
      }
      const mentionAuthorizationId = capability.success ? capability.data.authorizationId : null;
      const candidateSetHash = slackMentionFingerprint({
        authorizationId: mentionAuthorizationId,
        connectionEpoch: authority.connectionEpoch, credentialRevision: authority.credentialRevision,
        humans: [...(humanCandidates ?? [])].map(slackHumanMentionPrincipal)
          .map(({ id, handleCandidates, nameCandidates }) => ({ id, handleCandidates, nameCandidates }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      });
      const storedSnapshot = slackHumanMentionSnapshotSchema.safeParse(install.humanSnapshot);
      const cachedHumans = humanCandidates !== undefined && storedSnapshot.success
        && storedSnapshot.data.candidateSetHash === candidateSetHash
        && Date.parse(storedSnapshot.data.nextAttemptAt) > observedNow()
        ? storedSnapshot.data : null;
      // One workspace human pass per candidate version/interval. Other servers
      // reuse its result while still reconciling their own Agent groups.
      if (cachedHumans) humanCandidates = undefined;
      const mentionCall: typeof provisioningCall = async (...args) => {
        const result = await provisioningCall(...args);
        // Stop this entire workspace pass on the first deterministic plan
        // refusal, including reads: further principals cannot succeed either.
        if (result.kind === "failed" && result.slackError === "paid_teams_only") {
          throw new SlackMentionUnsupportedError(capability.success ? capability.data : null);
        }
        if (result.kind === "unverified" && result.retryAfterMs !== undefined) {
          throw new SlackMentionRateLimitedError(result.retryAfterMs);
        }
        return result;
      };
      const listed = await mentionCall(authority, "usergroups.list", {
        include_count: false,
        include_disabled: true,
      });
      if (listed.kind !== "fact") return { kind: listed.kind, slackError: listed.kind === "failed" ? listed.slackError : undefined };
      if (!Array.isArray(listed.fact.usergroups)) return { kind: "unverified" };
      const groups: SlackAgentUsergroup[] = [];
      for (const raw of listed.fact.usergroups) {
        const group = parseSlackAgentUsergroup(raw);
        if (!group) return { kind: "unverified" };
        groups.push(group);
      }

      // Agents stay server-scoped; known human identities are workspace-wide.
      // Agent-only requests leave humans untouched. Unknown legacy markers
      // are adopted only for this server; foreign/plain groups stay untouched.
      const managedPrefixes = [
        `${RAFT_AGENT_USERGROUP_MARKER_PREFIX}${request.serverId}:`,
        ...(humanCandidates ? [`${RAFT_HUMAN_USERGROUP_MARKER_PREFIX}${request.serverId}:`, "workspace-user:"] : []),
      ];
      const identities = await listSlackUsergroupIdentities(db, authority.installId, request.serverId);
      const identitiesByMarker = new Map<string, (typeof identities)[number]>();
      for (const row of identities) {
        const marker = slackUsergroupIdentityMarker(row);
        const kept = identitiesByMarker.get(marker);
        const keptGroup = kept && groups.find((group) => group.id === kept.providerUsergroupId);
        const candidateGroup = groups.find((group) => group.id === row.providerUsergroupId);
        if (!kept || (candidateGroup && !candidateGroup.disabled && (!keptGroup || keptGroup.disabled))) {
          identitiesByMarker.set(marker, row);
        }
      }
      // Two replicas racing a create can leave two groups with the same
      // exact marker (same server, same principal). Keep one — enabled
      // first, then the lowest id — and disable the rest below, so the race
      // heals on the next pass instead of failing every pass. Groups are
      // matched by their full marker only, never by name or handle.
      const managedByMarker = new Map<string, SlackAgentUsergroup>();
      const managedMarkerByGroupId = new Map<string, string>();
      const duplicateManaged: SlackAgentUsergroup[] = [];
      for (const group of groups) {
        const identity = identities.find((row) => row.providerUsergroupId === group.id
          || slackUsergroupRecoveryDescription(row) === group.description);
        const legacyHuman = parseSlackHumanUsergroupMarker(group.description);
        const marker = identity ? slackUsergroupIdentityMarker(identity)
          : legacyHuman?.serverId === request.serverId ? `workspace-user:${legacyHuman.userId}` : group.description;
        if (!managedPrefixes.some((prefix) => marker.startsWith(prefix))) continue;
        // Parse legacy descriptions strictly before adopting them. The legacy
        // path exists only to migrate already-provisioned groups in place.
        const agent = parseSlackAgentUsergroupMarker(marker);
        const human = legacyHuman?.serverId === request.serverId ? legacyHuman : parseSlackHumanUsergroupMarker(marker);
        if (!agent && !human && identity?.principalKind !== "user") continue;
        managedMarkerByGroupId.set(group.id, marker);
        if (!identitiesByMarker.has(marker)) identitiesByMarker.set(marker,
          await reserveSlackUsergroupIdentity(db, {
            installId: authority.installId, serverId: request.serverId,
            principalKind: agent ? "agent" : "user", principalId: agent?.agentId ?? human!.userId,
          }));
        const kept = managedByMarker.get(marker);
        if (!kept) {
          managedByMarker.set(marker, group);
          continue;
        }
        const boundId = identitiesByMarker.get(marker)?.providerUsergroupId;
        const alreadyBound = boundId === group.id || boundId === kept.id;
        const preferNew = alreadyBound ? boundId === group.id
          : kept.disabled !== group.disabled ? kept.disabled : group.id < kept.id;
        duplicateManaged.push(preferNew ? kept : group);
        if (preferNew) managedByMarker.set(marker, group);
      }
      // Checked before every write: a holder whose claim lapsed (renewal
      // refused, or its last confirmed window elapsed) sends nothing more and
      // reports `unverified`, which never rewrites the persisted state.
      const claimLost = async () => request.isClaimHeld !== undefined && !(await request.isClaimHeld());
      const mentionWrite = async (
        identity: SlackUsergroupIdentity, method: string, body: Record<string, unknown>,
      ): Promise<SlackBridgeProvisioningProviderResult<Record<string, unknown>>> => {
        const fingerprint = slackMentionFingerprint({
          authorizationId: mentionAuthorizationId,
          connectionEpoch: authority.connectionEpoch, credentialRevision: authority.credentialRevision, method, body,
        });
        const stored = slackMentionWriteFailuresSchema.safeParse(identity.mentionWriteFailures);
        const failures = stored.success ? stored.data.filter((failure) => Date.parse(failure.retryAt) > observedNow()) : [];
        const blocked = failures.find((failure) => failure.fingerprint === fingerprint);
        if (blocked) return { kind: "failed", slackError: blocked.slackError };
        if (await claimLost()) return { kind: "unverified" };
        const result = await mentionCall(authority, method, body);
        if (result.kind === "failed") {
          if (await claimLost()) return { kind: "unverified" };
          const next = [...failures.filter((failure) => failure.fingerprint !== fingerprint), {
            fingerprint, slackError: result.slackError ?? "unknown_error",
            retryAt: new Date(observedNow() + SLACK_MENTION_FAILURE_BACKOFF_MS).toISOString(),
          }];
          await db.update(slackUsergroupIdentities).set({ mentionWriteFailures: next })
            .where(eq(slackUsergroupIdentities.id, identity.id));
          identity.mentionWriteFailures = next;
        }
        return result;
      };
      // Agents first, then humans: an Agent keeps first claim on a handle.
      const principals: SlackMentionPrincipal[] = [
        ...[...request.candidates]
          .sort((left, right) => left.agentId.localeCompare(right.agentId))
          .map(slackAgentMentionPrincipal),
        ...[...(humanCandidates ?? [])]
          .sort((left, right) => left.userId.localeCompare(right.userId))
          .map(slackHumanMentionPrincipal),
      ];
      const desiredMarkers = new Set(principals.map((principal) => principal.marker));
      const occupied = new Set(groups.map((group) => group.handle.toLocaleLowerCase("en-US")));
      const occupiedNames = new Set(groups.map((group) => group.name.toLocaleLowerCase("en-US")));
      const handles: SlackBridgeAgentMentionHandle[] = [];
      const humanHandles: SlackBridgeHumanMentionHandle[] = [];
      const failures: SlackBridgeAgentMentionReconcileFailure[] = [];
      const cleanupFailures: { slackError: string | null }[] = [];
      const recordFailure = (
        principal: SlackMentionPrincipal,
        slackError: string | null,
        transient: boolean,
      ) => {
        failures.push(principal.kind === "agent"
          ? { agentId: principal.id, slackError, transient }
          : { userId: principal.id, slackError, transient });
      };

      for (const principal of principals) {
        // Per-principal isolation: a collision on every handle/name candidate
        // or a provider error for one principal must not starve the rest —
        // reconcile continues so remaining principals still get groups and the
        // disable pass still runs. The failure (with Slack's error) is
        // reported to the caller; the next tick retries.
        const marker = principal.marker;
        const identity = identitiesByMarker.get(marker) ?? await reserveSlackUsergroupIdentity(db, {
          installId: authority.installId, serverId: request.serverId,
          principalKind: principal.kind, principalId: principal.id,
        });
        identitiesByMarker.set(marker, identity);
        let group = managedByMarker.get(marker) ?? null;
        if (group) {
          if (await claimLost()) return { kind: "unverified" };
          await bindSlackUsergroupIdentity(db, identity, group.id);
        }
        const description = slackUsergroupDescription(principal.kind);
        // A previously confirmed human group observed missing/disabled cannot
        // remain an outbound destination during a cached enable/create refusal.
        if (principal.kind === "user" && (!group || group.disabled)
          && !(await setCanonicalSlackHumanUsergroup(db, identity, false, async () => !(await claimLost())))) {
          return { kind: "unverified" };
        }
        if (group) {
          occupied.delete(group.handle.toLocaleLowerCase("en-US"));
          occupiedNames.delete(group.name.toLocaleLowerCase("en-US"));
          if (group.disabled) {
            let enabled: SlackBridgeProvisioningProviderResult<Record<string, unknown>>;
            if (await claimLost()) return { kind: "unverified" };
            enabled = await mentionWrite(identity, "usergroups.enable", {
              usergroup: group.id,
            });
            if (enabled.kind !== "fact") {
              recordFailure(
                principal,
                enabled.kind === "failed" ? enabled.slackError ?? null : null,
                enabled.kind === "unverified",
              );
              continue;
            }
          }
        }
        // A group already holding one of this principal's candidates keeps it.
        // Re-claiming an earlier candidate every tick re-sends a write Slack
        // refuses (e.g. the handle is a Slack username, which usergroups.list
        // never shows), so the reconcile would never converge and every tick
        // would spend a rate-limited write on it.
        const keptHandle = group && (principal.kind === "user" || principal.handleCandidates.includes(group.handle))
          ? group.handle
          : null;
        const keptName = group && principal.nameCandidates.includes(group.name)
          ? group.name
          : null;
        let reconciled: { group: SlackAgentUsergroup; handle: string; name: string } | null = null;
        for (;;) {
          const handle = keptHandle && !occupied.has(keptHandle)
            ? keptHandle
            : principal.handleCandidates
              .find((value) => value.length > 0 && !occupied.has(value)) ?? null;
          const name = !handle
            ? null
            : keptName && !occupiedNames.has(keptName.toLocaleLowerCase("en-US"))
              ? keptName
              : principal.nameCandidates
                .find((value) => !occupiedNames.has(value.toLocaleLowerCase("en-US"))) ?? null;
          if (!handle || !name) {
            // Every candidate is occupied or was refused as taken/invalid.
            recordFailure(principal, SLACK_USERGROUP_NAMING_EXHAUSTED_ERROR, false);
            break;
          }
          let write: SlackBridgeProvisioningProviderResult<Record<string, unknown>> | null = null;
          const needsWrite = !group
            || group.name !== name || group.handle !== handle || group.description !== description;
          if (needsWrite && await claimLost()) return { kind: "unverified" };
          if (!group) {
            write = await mentionWrite(identity, "usergroups.create", {
              name,
              handle,
              description: slackUsergroupRecoveryDescription(identity),
            });
          } else if (
            group.name !== name || group.handle !== handle || group.description !== description
          ) {
            write = await mentionWrite(identity, "usergroups.update", {
              usergroup: group.id,
              name,
              handle,
              description,
            });
          }
          if (!write) {
            reconciled = { group: group!, handle, name };
            break;
          }
          if (write.kind !== "fact") {
            // A taken/invalid handle is retired for this tick (later
            // principals skip it too) and the next candidate is tried. Slack
            // reports some handle clashes (e.g. with a Slack username) as name
            // errors, so a name conflict retires both the handle and the name.
            // Any other failure (permission, plan, rate limit) does not cycle.
            const conflict = write.kind === "failed"
              ? slackUsergroupNamingConflict(write.slackError)
              : null;
            if (!conflict) {
              recordFailure(
                principal,
                write.kind === "failed" ? write.slackError ?? null : null,
                write.kind === "unverified",
              );
              break;
            }
            occupied.add(handle);
            if (conflict === "name") occupiedNames.add(name.toLocaleLowerCase("en-US"));
            continue;
          }
          const observed = parseSlackAgentUsergroup(write.fact.usergroup);
          const expectedDescription = group ? description : slackUsergroupRecoveryDescription(identity);
          if (!observed || observed.description !== expectedDescription || observed.handle !== handle) {
            recordFailure(principal, null, false);
            break;
          }
          if (await claimLost()) return { kind: "unverified" };
          await bindSlackUsergroupIdentity(db, identity, observed.id);
          if (!group) {
            // Persist identity before removing the recovery reference. If this
            // write fails, the next reconcile finds the same group by its id.
            group = observed;
            continue;
          }
          reconciled = { group: observed, handle, name };
          break;
        }
        if (!reconciled) continue;
        const { handle, name } = reconciled;
        group = reconciled.group;
        occupied.add(handle);
        occupiedNames.add(name.toLocaleLowerCase("en-US"));
        if (principal.kind === "agent") {
          handles.push({ agentId: principal.id, providerUsergroupId: group.id, handle });
        } else {
          if (!(await setCanonicalSlackHumanUsergroup(db, identity, true, async () => !(await claimLost())))) return { kind: "unverified" };
          humanHandles.push({ userId: principal.id, providerUsergroupId: group.id, handle });
        }
      }

      const retired = [
        ...[...managedByMarker].filter(([marker]) => !desiredMarkers.has(marker)).map(([, group]) => group),
        ...duplicateManaged,
      ];
      const humanCleanupFailures: { slackError: string | null }[] = [];
      for (const group of retired) {
        const marker = managedMarkerByGroupId.get(group.id)!;
        const writeIdentity = identities.find((row) => row.providerUsergroupId === group.id) ?? identitiesByMarker.get(marker);
        if (!writeIdentity) return { kind: "unverified" };
        const recordCleanupFailure = (slackError: string | null) => {
          cleanupFailures.push({ slackError });
          if (writeIdentity.principalKind === "user") humanCleanupFailures.push({ slackError });
        };
        const retiredIdentity = identities.find((row) => row.providerUsergroupId === group.id);
        if (retiredIdentity?.principalKind === "user" && !(await setCanonicalSlackHumanUsergroup(db, retiredIdentity, false, async () => !(await claimLost())))) return { kind: "unverified" };
        if (!group.disabled) {
          if (await claimLost()) return { kind: "unverified" };
          const disabled = await mentionWrite(writeIdentity, "usergroups.disable", { usergroup: group.id });
          if (disabled.kind !== "fact") {
            recordCleanupFailure(disabled.kind === "failed" ? disabled.slackError ?? null : null);
            continue;
          }
        }
        const entry = [...managedByMarker].find(([, kept]) => kept.id === group.id);
        const identity = identitiesByMarker.get(marker);
        if (entry && identity) {
          if (await claimLost()) return { kind: "unverified" };
          await bindSlackUsergroupIdentity(db, identity, group.id);
        }
        const kind = parseSlackAgentUsergroupMarker(marker) ? "agent" : "user";
        const description = slackUsergroupDescription(kind);
        if (group.description !== description) {
          if (await claimLost()) return { kind: "unverified" };
          const cleaned = await mentionWrite(writeIdentity, "usergroups.update", { usergroup: group.id, description });
          if (cleaned.kind !== "fact") recordCleanupFailure(cleaned.kind === "failed" ? cleaned.slackError ?? null : null);
        }
      }
      if (humanCandidates !== undefined) {
        if (await claimLost()) return { kind: "unverified" };
        await db.update(externalAppInstalls).set({ slackHumanMentionSnapshot: {
          candidateSetHash, nextAttemptAt: new Date(observedNow() + SLACK_HUMAN_RECONCILE_INTERVAL_MS).toISOString(),
          handles: humanHandles,
          failures: failures.flatMap((failure) => failure.userId ? [{ userId: failure.userId, slackError: failure.slackError, transient: failure.transient }] : []),
          cleanupFailures: humanCleanupFailures,
        } }).where(eq(externalAppInstalls.id, authority.installId));
      }
      return {
        kind: "fact",
        fact: {
          handles,
          ...(cachedHumans ? { humanHandles: cachedHumans.handles }
            : humanCandidates !== undefined ? { humanHandles } : {}),
          failures: [...failures, ...(cachedHumans?.failures ?? [])],
          cleanupFailures: [...cleanupFailures, ...(cachedHumans?.cleanupFailures ?? [])],
        },
      };
    },
  };

  // Serialize the entire list/create/bind/cleanup sequence at the common
  // provider seam, including interactive enable and background lifecycle calls.
  // Reserving one DB row alone cannot stop two creates from both losing their
  // recovery description after concurrent provider responses.
  const reconcileMentionHandles = provisioningProvider.reconcileAgentMentionHandles!;
  provisioningProvider.reconcileAgentMentionHandles = async (authority, request) => {
    const key = `slock:slack-bridge:mention-write:${authority.installId}`;
    const token = randomUUID();
    let claim: SlackMentionReconcileClaim | null;
    const redis = isRedisAvailable() ? getRedis() : null;
    if (redis) {
      claim = await claimSlackMentionReconcile({
        store: redisSlackMentionReconcileClaimStore(redis), key, token,
        ttlMs: 30_000, renewEveryMs: 10_000,
      });
    } else {
      if (process.env.NODE_ENV === "production") return { kind: "unverified" };
      if (localMentionWorkspaceClaims.has(key)) return { kind: "unverified" };
      localMentionWorkspaceClaims.set(key, token);
      claim = {
        held: async () => localMentionWorkspaceClaims.get(key) === token,
        end: () => { if (localMentionWorkspaceClaims.get(key) === token) localMentionWorkspaceClaims.delete(key); },
      };
    }
    if (!claim) return { kind: "unverified" };
    try {
      return await reconcileMentionHandles(authority, {
        ...request,
        isClaimHeld: async () => {
          if (stopped) return false;
          const callerHeld = !request.isClaimHeld || await request.isClaimHeld();
          return callerHeld && await claim.held() && !stopped;
        },
      });
    } catch (error) {
      if (error instanceof SlackMentionUnsupportedError) {
        if (stopped || !(await claim.held()) || (request.isClaimHeld && !(await request.isClaimHeld()))) {
          return { kind: "unverified" };
        }
        // A delayed response from an old token must not disable the new
        // install's capability after reauthorization or reinstallation.
        const [updated] = await db.update(externalAppInstalls).set({
          slackMentionCapability: {
            authorizationId: error.observedCapability?.authorizationId ?? newSlackMentionAuthorizationId(),
            result: "paid_teams_only",
            connectionEpoch: authority.connectionEpoch,
            credentialRevision: authority.credentialRevision,
          },
        }).where(and(
          eq(externalAppInstalls.id, authority.installId),
          eq(externalAppInstalls.connectionEpoch, authority.connectionEpoch),
          eq(externalAppInstalls.credentialRevision, authority.credentialRevision),
          eq(externalAppInstalls.state, "active"),
          // A shared-server install can renew consent without rotating the
          // token; its new authorization id also fences old provider results.
          error.observedCapability === null
            ? sql`${externalAppInstalls.slackMentionCapability} IS NULL`
            : eq(externalAppInstalls.slackMentionCapability, error.observedCapability),
        )).returning({ id: externalAppInstalls.id });
        return updated ? { kind: "failed", slackError: "paid_teams_only" } : { kind: "unverified" };
      }
      if (error instanceof SlackMentionRateLimitedError) {
        const until = new Date(Math.max(authority.now.getTime(), now().getTime()) + Math.max(1_000, error.retryAfterMs));
        await db.update(externalAppInstalls).set({
          slackMentionRateLimitedUntil: sql`greatest(${externalAppInstalls.slackMentionRateLimitedUntil}, ${until})`,
        }).where(eq(externalAppInstalls.id, authority.installId));
        return { kind: "unverified", retryAfterMs: error.retryAfterMs };
      }
      return { kind: "unverified" };
    } finally {
      claim.end();
      // Do not leave TTL spacing here: another server in the same lifecycle
      // batch must be able to proceed. A release error falls back to the TTL.
      if (redis) await releaseSlackMentionReconcileClaim(redis, key, token).catch(() => false);
    }
  };

  const revokeInstallToken = async (installId: string): Promise<SlackInstallTokenRevokeOutcome> => {
    const [row] = await db.select({
      serverId: externalAppInstalls.serverId,
      providerAppId: externalAppInstalls.providerAppId,
      providerTeamId: externalAppInstalls.providerTeamId,
      botUserId: externalAppInstalls.botUserId,
      encryptedMaterial: externalAppCredentials.encryptedMaterial,
      envelopeKeyId: externalAppCredentials.envelopeKeyId,
      aadVersion: externalAppCredentials.aadVersion,
    }).from(externalAppInstalls)
      .innerJoin(externalAppCredentials, eq(externalAppCredentials.installId, externalAppInstalls.id))
      .where(eq(externalAppInstalls.id, installId))
      .limit(1);
    if (!row || !nonEmpty(row.providerTeamId) || !nonEmpty(row.botUserId)) return { kind: "no_credential" };
    const material = dependencies.credentialCipher.unseal({
      serverId: row.serverId,
      providerAppId: row.providerAppId,
      providerTeamId: row.providerTeamId,
      botUserId: row.botUserId,
      encryptedMaterial: row.encryptedMaterial,
      envelopeKeyId: row.envelopeKeyId,
      aadVersion: row.aadVersion,
    });
    if (!material) return { kind: "no_credential" };
    const result = await callWithToken({ method: "auth.revoke", body: {}, accessToken: material.accessToken });
    if (result.kind === "transport_failure") return { kind: "failed", failure: `transport_${result.code}` };
    if (result.body.ok === true) return { kind: "revoked" };
    const error = typeof result.body.error === "string" ? result.body.error : `http_${result.status}`;
    // Already dead at Slack: nothing left to revoke.
    if (["invalid_auth", "token_revoked", "account_inactive", "not_authed", "token_expired"].includes(error)) return { kind: "revoked" };
    return { kind: "failed", failure: error.slice(0, 64) };
  };

  return {
    revokeInstallToken,
    credentialResolver,
    transport,
    inboundAttachmentTransport,
    createOutboundAttachmentTransport,
    quarantineSink,
    releaseCredential,
    resolveUsers,
    resolveAgentMentionHandles,
    provisioningProvider,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const controller of providerAbortControllers) controller.abort();
      const leases = [...credentialLeases.values()];
      credentialLeases.clear();
      const stoppedAt = now();
      if (!validDate(stoppedAt)) return;
      await Promise.all(leases.map((lease) => releaseCredentialLease(
        lease.authority.installId,
        lease.authority.credentialRevision,
        lease.leaseId,
        stoppedAt,
      )));
    },
  };
}
