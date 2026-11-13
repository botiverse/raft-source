import { listSlackPairHeads, listSlackPairHeadsForHealth, SLACK_PAIR_HEAD_BATCH_SIZE, slackPairBlockHint, slackPairConfirmationDetail } from "./slackBridgePairQueue";
import { replayHeldSlackIngress } from "./slackVerifiedIngressWorker";
import { createHash, randomBytes } from "node:crypto";

import {
  asServerId,
  currentDate,
  needsSlackBridgeManualRetry,
  effectiveAllowedOAuthScopes,
  SLACK_BRIDGE_PROVISIONING_PROTOCOL_VERSION,
  type SlackBridgePreflight,
  type SlackBridgeProvisioningResponse,
  type SlackBridgeRawHealth,
} from "@botiverse/raft-shared";
import { and, asc, desc, eq, gt, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";

import {
  getDb,
  type Database,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "../db/index";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppIngressEndpoints,
  externalAppInstallGrantReceipts,
  externalAppInstallServerGrants,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppRegistrationSecrets,
  externalAppServerGrants,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalDeliveryPartitions,
  externalDeliveryOperatorDecisions,
  externalHumanIdentityLinks,
  jointChannels,
  jointChannelServers,
  notificationRecipients,
  oauthAccessRequests,
  oauthAccessTokens,
  oauthAppInstallationTokens,
  oauthAppPermissionRevisions,
  oauthAppWebhookConfigs,
  oauthClientMaintainers,
  oauthClientInstalls,
  oauthClientShareLinks,
  oauthClients,
  oauthGrants,
  serverMembers,
  servers,
  slackVerifiedIngressEvents,
  slackVerifiedIngressPartitions,
  thirdPartyAgentEvents,
  users,
} from "../db/schema";
import {
  type SlackBridgeProvisioningControlPlane,
  type SlackBridgeProvisioningRequestAuthority,
} from "../routes/slackBridge";
import { ExternalAppControlPlaneError, retryExternalAppInstallLockSet } from "./externalAppControlPlaneService";
import { lockSlackInstallConversations, SlackInstallLockSetChanged } from "./slackBridgeRowLocks";
import {
  applySlackInstallGrantScopeDrift,
  classifySlackInstallGrantObservation,
  SLACK_BRIDGE_INSTALL_GRANT_FRESHNESS_MS,
  slackBridgeGrantScopesSupportRuntime,
  slackBridgeInstallGrantHash,
  slackBridgeInstallGrantMatchesInstall,
} from "./slackBridgeInstallGrantService";
import {
  SLACK_BRIDGE_AGENT_MENTION_BOT_SCOPES,
  SLACK_BRIDGE_ACTIVE_BOT_SCOPES,
} from "./slackBridgeProductionAppContract";
import { slackPrivacyFreshUntil } from "./slackBindingPrivacyFreshnessService";
import { currentConversationAuthorityStatus } from "./slackBridgeConversationAuthorityStatus";
import { projectSlackBindingLifecycle } from "./slackBindingLifecycleService";
import { slackAudienceEventRevision, slackLifecycleClockAt, slackLifecycleClockIsNewer } from "./slackChannelLifecycleObservation";
import { grantMatchesCurrentRegistration, resolveExternalInstallServerGrantAuthority } from "./externalInstallServerGrantAuthority";
import { recordExternalDeliveryRetryDecision } from "./externalDeliveryWorkerService";
import { listSlackCardEditPanelNotices } from "./slackCardEditSync";
import { effectiveAgentSenderName } from "./effectiveSenderName";
import { canUserAccessChannel, filterChannelIdsVisibleToHuman } from "./channelService";
import { lockSlackConversations } from "./slackBridgeRowLocks";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CHANNELS = 500;
const AVATAR_MATERIALIZATION_CONCURRENCY = 8;
const AUDIENCE_FRESHNESS_MS = 30 * 60_000;
const AUDIENCE_RENEWAL_LEAD_MS = 10 * 60_000;
const PROVISIONING_PENDING_REASON = "provisioning_preflight_pending";
const PROVISIONING_PASSED_REASON = "provisioning_preflight_passed";
const PROVISIONING_REPLACED_REASON = "provisioning_pair_replaced";
const PROVISIONING_REMOVED_REASON = "provisioning_pair_removed";
const PROVISIONING_UNBOUND_REASON = "manager_unbound_workspace";
// Written by completeExternalOAuthAttempt when an active install is re-authorized.
const PROVIDER_REAUTHORIZED_REASON = "provider_reauthorized_review_required";
class SlackPairLockSetChanged extends Error {}

type Tx = DatabaseTransaction;
type Install = typeof externalAppInstalls.$inferSelect;
type Credential = typeof externalAppCredentials.$inferSelect;
type Binding = typeof externalChannelBindings.$inferSelect;
type InstallGrantReceipt = typeof externalAppInstallGrantReceipts.$inferSelect;
type InstallServerGrant = typeof externalAppInstallServerGrants.$inferSelect;

export interface SlackBridgeProvisioningSecretAuthority {
  encryptedSecretRef: string;
  envelopeKeyId: string;
  secretRevision: number;
}

export interface SlackBridgeProvisioningBootstrapAuthority {
  registrationId: string;
  environment: "test" | "production";
  providerAppId: string;
  providerOAuthClientId: string;
  oauthRedirectUri: string;
  eventsRequestUrl: string;
  capabilityManifestVersion: number;
  capabilityManifestHash: string;
  requiredCapabilities: readonly string[];
  signingSecret: SlackBridgeProvisioningSecretAuthority;
  oauthClientSecret: SlackBridgeProvisioningSecretAuthority;
}

export interface SlackBridgeProvisioningProviderChannel {
  id: string;
  name: string;
  privacyClass: "public" | "private";
  isMember?: boolean;
}

export interface SlackBridgeProvisioningProviderUser {
  id: string;
  displayName: string;
  handle: string | null;
  actorKind: "human" | "guest" | "remote";
  /** Transient locator; null means explicitly removed, omitted means unknown. */
  avatarLocator?: string | null;
}

type ExistingSlackActorProjection = Pick<
  typeof externalActorProjections.$inferSelect,
  "displayName" | "handles" | "actorKind" | "state" | "deactivated" | "projectionRevision"
>;

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => typeof item === "string" && item === expected[index]);
}

export function slackActorProjectionRevisionAfterRefresh(
  existing: ExistingSlackActorProjection,
  observed: SlackBridgeProvisioningProviderUser,
): number {
  const observedHandles = observed.handle ? [observed.handle] : [];
  const materiallyCurrent = existing.displayName === observed.displayName
    && exactStringArray(existing.handles, observedHandles)
    && existing.actorKind === observed.actorKind
    && existing.state === "active"
    && !existing.deactivated;
  return materiallyCurrent
    ? existing.projectionRevision
    : existing.projectionRevision + 1;
}

export interface SlackBridgeProvisioningProviderAuthority {
  /** Local lifecycle cancellation, checked immediately before each provider call. */
  isRunHeld?(): Promise<boolean>;
  installId: string;
  providerAppId: string;
  providerAuthorityId: string;
  botUserId: string;
  connectionEpoch: number;
  credentialRevision: number;
  now: Date;
}

export interface SlackBridgeProvisioningInstallGrant {
  providerAppId: string;
  providerAuthorityId: string;
  botUserId: string;
  providerBotId: string;
  grantedScopes: readonly string[];
}

export interface SlackBridgeAgentMentionCandidate {
  serverId: string;
  agentId: string;
  name: string;
  displayName: string;
  serverSlug: string;
  serverName: string;
}

export interface SlackBridgeAgentMentionHandle {
  agentId: string;
  providerUsergroupId: string;
  handle: string;
}

/**
 * A principal that could not be reconciled this round, with Slack's error
 * when one was observed. Agents carry `agentId`, humans `userId`.
 */
export type SlackBridgeAgentMentionReconcileFailure = (
  | { agentId: string; userId?: never }
  | { userId: string; agentId?: never }
) & {
  slackError: string | null;
  // Transient failures (lease/transport/429/5xx) should not downgrade the
  // persisted sync state or surface workspace-policy hints to the operator.
  transient: boolean;
};

/** A Raft human in a Slack-paired channel, mentionable via a managed usergroup. */
export interface SlackBridgeHumanMentionCandidate {
  serverId: string;
  userId: string;
  name: string;
  displayName: string;
  serverSlug: string;
  serverName: string;
}

export interface SlackBridgeHumanMentionHandle {
  userId: string;
  providerUsergroupId: string;
  handle: string;
}

/**
 * Agents and humans share one handle namespace, with Agents first. Agent
 * candidates retain this cap; complete human retention is reconciled once per
 * workspace candidate version/interval and reused by associated servers.
 */
export const SLACK_BRIDGE_MENTION_HANDLE_RECONCILE_LIMIT = 200;

export type SlackBridgeProvisioningProviderResult<T> =
  | { kind: "fact"; fact: T }
  // Slack's `error` payload field (e.g. "restricted_action", "name_taken")
  // travels with deterministic failures so callers can persist and render
  // actionable recovery hints instead of an opaque "failed".
  | { kind: "failed"; slackError?: string }
  | { kind: "unverified"; retryAfterMs?: number };

/** OAuth identity and channel-directory availability are separate observations. */
export interface SlackBridgeWorkspaceDirectory {
  workspaceName: string | null;
  channels: readonly SlackBridgeProvisioningProviderChannel[];
}

export type SlackBridgeWorkspaceObservation =
  | { oauth: "passed"; directory: SlackBridgeProvisioningProviderResult<SlackBridgeWorkspaceDirectory> }
  | { oauth: "failed" | "unverified"; directory: { kind: "unverified" } };

export interface SlackBridgeProvisioningProvider {
  readInstallGrant(input: SlackBridgeProvisioningProviderAuthority): Promise<
    SlackBridgeProvisioningProviderResult<SlackBridgeProvisioningInstallGrant>
  >;
  readWorkspace(input: SlackBridgeProvisioningProviderAuthority): Promise<SlackBridgeWorkspaceObservation>;
  readUserProfile?(input: SlackBridgeProvisioningProviderAuthority & { providerUserId: string }): Promise<
    SlackBridgeProvisioningProviderResult<SlackBridgeProvisioningProviderUser>
  >;
  /** Positive channel state for lifecycle recovery; no message-send authority. */
  readConversationState?(input: SlackBridgeProvisioningProviderAuthority & { providerConversationId: string }): Promise<
    SlackBridgeProvisioningProviderResult<{ id: string; name: string; isArchived: boolean; isMember: boolean }>
  >;
  /** Provider-authoritative membership of the human who authorized this server. */
  readConversationMember?(input: SlackBridgeProvisioningProviderAuthority & {
    providerConversationId: string; providerUserId: string;
  }): Promise<SlackBridgeProvisioningProviderResult<boolean>>;
  readConversationAudience(input: SlackBridgeProvisioningProviderAuthority & {
    providerConversationId: string;
  }): Promise<SlackBridgeProvisioningProviderResult<{
    providerMemberIds: readonly string[];
    users: readonly SlackBridgeProvisioningProviderUser[];
  }>>;
  reconcileAgentMentionHandles?(
    input: SlackBridgeProvisioningProviderAuthority,
    request: {
      serverId: string;
      candidates: readonly SlackBridgeAgentMentionCandidate[];
      /**
       * Omitted: human usergroups are left untouched (Agent-only reconcile).
       * Present (even empty): human groups are reconciled to exactly this set.
       */
      humanCandidates?: readonly SlackBridgeHumanMentionCandidate[];
      /**
       * Cross-replica claim check, consulted before every usergroup write.
       * Once it reports false the reconcile issues no further write and
       * returns `unverified`. Omitted: the caller is the only writer.
       */
      isClaimHeld?(): Promise<boolean>;
    },
  ): Promise<SlackBridgeProvisioningProviderResult<{
    handles: readonly SlackBridgeAgentMentionHandle[];
    humanHandles?: readonly SlackBridgeHumanMentionHandle[];
    // Principals (Agents and humans) that could not be reconciled this round,
    // with Slack's error when one was observed. Empty when every candidate
    // succeeded.
    failures: readonly SlackBridgeAgentMentionReconcileFailure[];
    cleanupFailures?: readonly { slackError: string | null }[];
  }>>;
}

export interface SlackBridgeProvisioningControlPlaneDependencies {
  db?: Database;
  bootstrap: SlackBridgeProvisioningBootstrapAuthority;
  provider: SlackBridgeProvisioningProvider;
  avatarMaterializer?: SlackBridgeAvatarMaterializer;
  /** Deterministic authority-race seam for isolated integration tests. */
  testOnlyBeforeReplay?: () => Promise<void>;
}

export interface SlackBridgeAvatarMaterializer {
  materializeExternalProjection(input: {
    projectionId: string;
    expectedProjectionRevision: number;
    expectedObservedAt?: Date;
    sourceLocator: string | null;
    lockAdditionalAuthority?: (tx: DatabaseTransaction) => Promise<boolean>;
  }): Promise<unknown>;
}

interface CurrentAuthority {
  grant: typeof externalAppServerGrants.$inferSelect | null;
  installServerGrant: InstallServerGrant | null;
  install: Install | null;
  credential: Credential | null;
  installGrantReceipt: InstallGrantReceipt | null;
  bindings: Binding[];
}

interface ProviderObservation {
  oauthStatus: "passed" | "failed" | "unverified";
  directoryStatus: "passed" | "failed" | "unverified";
  workspaceName: string | null;
  channels: SlackBridgeProvisioningProviderChannel[];
  authorizingUserId: string | null;
  evidence: { installId: string; connectionEpoch: number; credentialRevision: number;
    grantId: string; serverGrantId: string; grantEpoch: number } | null;
}

// Managers may mutate setup; every viewer's channel facts stay limited to
// channels that human can actually view, independently of the server role.
type SlackBridgeProvisioningViewer =
  | { kind: "manager" }
  | { kind: "member"; userId: string };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = canonicalStrings(left);
  const b = canonicalStrings(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}


function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function listSlackBridgeAgentMentionCandidates(
  executor: DatabaseExecutor,
  serverId: string,
  bindings: readonly Binding[],
): Promise<SlackBridgeAgentMentionCandidate[]> {
  const channelIds = [...new Set(bindings.map((binding) => binding.channelId))];
  if (channelIds.length === 0) return [];
  const rows = await executor.select({
    agentId: agents.id,
    name: agents.name,
    displayName: agents.displayName,
    serverSlug: servers.slug,
    serverName: servers.name,
  }).from(channelAgents)
    .innerJoin(agents, and(
      eq(agents.id, channelAgents.agentId),
      eq(agents.serverId, serverId),
      isNull(agents.deletedAt),
    ))
    .innerJoin(servers, eq(servers.id, agents.serverId))
    .where(inArray(channelAgents.channelId, channelIds));
  return [...new Map(rows.map((row) => [row.agentId, {
    serverId,
    agentId: row.agentId,
    name: row.name,
    displayName: effectiveAgentSenderName(row),
    serverSlug: row.serverSlug,
    serverName: row.serverName,
  }])).values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
}

export type SlackBridgeMentionSyncState = NonNullable<
  (typeof externalAppInstallServerGrants.$inferSelect)["agentMentionSync"]
>;

/**
 * Persisted mention-usergroup sync state for one reconcile result; counts
 * Agents and humans together. `null` for transport-level "unverified", which
 * must not rewrite the stored state.
 */
export function slackBridgeMentionSyncState(input: {
  reconciled: SlackBridgeProvisioningProviderResult<{
    handles: readonly SlackBridgeAgentMentionHandle[];
    humanHandles?: readonly SlackBridgeHumanMentionHandle[];
    failures: readonly SlackBridgeAgentMentionReconcileFailure[];
    cleanupFailures?: readonly { slackError: string | null }[];
  }>;
  candidates: readonly SlackBridgeAgentMentionCandidate[];
  humanCandidates: readonly SlackBridgeHumanMentionCandidate[];
  observedAt: Date;
}): SlackBridgeMentionSyncState | null {
  const { reconciled } = input;
  const expected = input.candidates.length + input.humanCandidates.length;
  const observedAt = input.observedAt.toISOString();
  if (reconciled.kind === "unverified") return null;
  if (reconciled.kind === "failed") {
    return {
      state: "degraded",
      slackError: reconciled.slackError ?? null,
      expected,
      actual: 0,
      observedAt,
    };
  }
  const agentIds = new Set(reconciled.fact.handles.map((handle) => handle.agentId));
  const userIds = new Set((reconciled.fact.humanHandles ?? []).map((handle) => handle.userId));
  const actual = input.candidates.filter((candidate) => agentIds.has(candidate.agentId)).length
    + input.humanCandidates.filter((candidate) => userIds.has(candidate.userId)).length;
  const relevantFailures = reconciled.fact.failures.filter((failure) =>
    "agentId" in failure ? input.candidates.some((candidate) => candidate.agentId === failure.agentId)
      : input.humanCandidates.some((candidate) => candidate.userId === failure.userId));
  if (actual === expected && relevantFailures.length === 0) {
    return {
      state: "synced",
      slackError: reconciled.fact.cleanupFailures?.length ? "cleanup_pending" : null,
      expected, actual, observedAt,
    };
  }
  return {
    state: "degraded",
    slackError: relevantFailures.find(
      (failure) => !failure.transient && failure.slackError,
    )?.slackError ?? null,
    expected,
    actual,
    observedAt,
  };
}

/**
 * Raft humans who are members of the server's paired channels for this
 * install, deterministic by user id. An explicit limit bounds callers that
 * need a display subset; full workspace retention omits it. Retired accounts
 * are excluded.
 */
export async function listSlackBridgeHumanMentionCandidates(
  executor: DatabaseExecutor,
  serverId: string,
  bindings: readonly Binding[],
  limit?: number,
): Promise<SlackBridgeHumanMentionCandidate[]> {
  const channelIds = [...new Set(bindings.map((binding) => binding.channelId))];
  if (channelIds.length === 0 || (limit !== undefined && limit <= 0)) return [];
  const query = executor.selectDistinct({
    userId: users.id,
    name: users.name,
    displayName: users.displayName,
    serverSlug: servers.slug,
    serverName: servers.name,
  }).from(channelHumans)
    .innerJoin(channels, and(
      eq(channels.id, channelHumans.channelId),
      eq(channels.serverId, serverId),
    ))
    .innerJoin(users, and(
      eq(users.id, channelHumans.userId),
      isNull(users.retiredAt),
    ))
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .where(inArray(channelHumans.channelId, channelIds))
    .orderBy(users.id);
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.map((row) => ({
    serverId,
    userId: row.userId,
    name: row.name,
    displayName: row.displayName?.trim() || row.name,
    serverSlug: row.serverSlug,
    serverName: row.serverName,
  }));
}

/** Local health candidates plus workspace-wide human reconciliation candidates. */
export async function listSlackBridgeMentionCandidates(
  executor: DatabaseExecutor,
  serverId: string,
  bindings: readonly Binding[],
): Promise<{
  candidates: SlackBridgeAgentMentionCandidate[];
  humanCandidates: SlackBridgeHumanMentionCandidate[];
  workspaceHumanCandidates: SlackBridgeHumanMentionCandidate[];
}> {
  const candidates = await listSlackBridgeAgentMentionCandidates(executor, serverId, bindings);
  // Humans have one identity per Slack install. Reconcile the union so one
  // server cannot retire a group still needed by another server's channel.
  const installId = bindings[0]?.installId;
  const workspaceBindings = installId ? await executor.select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.installId, installId),
    // A temporary pause (including shared-install reauthorization) does not
    // withdraw the pairing or retire its humans' workspace-wide mention group.
    inArray(externalChannelBindings.state, ["active", "paused", "quarantined"]),
  )) : [];
  const humans = new Map<string, SlackBridgeHumanMentionCandidate>();
  for (const candidateServerId of new Set([serverId, ...workspaceBindings.map((binding) => binding.serverId)])) {
    const active = candidateServerId === serverId ? bindings : workspaceBindings.filter((binding) => binding.serverId === candidateServerId);
    if (installId && candidateServerId !== serverId) {
      const authority = await resolveExternalInstallServerGrantAuthority(executor, { installId, serverId: candidateServerId, registrationId: active[0]!.registrationId });
      if (!authority.current) continue;
    }
    for (const human of await listSlackBridgeHumanMentionCandidates(executor, candidateServerId, active)) {
      humans.set(human.userId, { ...human, serverId });
    }
  }
  const workspaceHumanCandidates = [...humans.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  const humanCandidates = await listSlackBridgeHumanMentionCandidates(executor, serverId, bindings);
  return { candidates, humanCandidates, workspaceHumanCandidates };
}

function requireManagerInput(input: SlackBridgeProvisioningRequestAuthority): void {
  if (
    !UUID_PATTERN.test(input.serverId)
    || !UUID_PATTERN.test(input.requestingUserId)
    || !validDate(input.now)
  ) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge provisioning authority is invalid",
      "external_app_invalid_state",
    );
  }
}

async function requireManager(
  executor: Database | Tx,
  input: SlackBridgeProvisioningRequestAuthority,
  lock = false,
): Promise<void> {
  requireManagerInput(input);
  const query = executor.select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, input.serverId),
      eq(serverMembers.userId, input.requestingUserId),
    ))
    .limit(1);
  const [membership] = lock ? await query.for("update") : await query;
  if (membership?.role !== "owner" && membership?.role !== "admin") {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge provisioning operation is not authorized",
      "external_app_not_authorized",
    );
  }
}

// Reading the setup state needs server membership (Guests excluded); every
// mutation stays behind requireManager. Members get the privacy-narrowed projection.
async function requireReader(
  executor: Database,
  input: SlackBridgeProvisioningRequestAuthority,
): Promise<SlackBridgeProvisioningViewer> {
  requireManagerInput(input);
  const [membership] = await executor.select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, input.serverId),
      eq(serverMembers.userId, input.requestingUserId),
    ))
    .limit(1);
  if (!membership || membership.role === "guest") {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge provisioning operation is not authorized",
      "external_app_not_authorized",
    );
  }
  return membership.role === "owner" || membership.role === "admin"
    ? { kind: "manager" }
    : { kind: "member", userId: input.requestingUserId };
}

function assertBootstrap(bootstrap: SlackBridgeProvisioningBootstrapAuthority): void {
  if (
    !UUID_PATTERN.test(bootstrap.registrationId)
    || !bootstrap.providerAppId.trim()
    || !bootstrap.providerOAuthClientId.trim()
    || !validHttps(bootstrap.oauthRedirectUri)
    || !validHttps(bootstrap.eventsRequestUrl)
    || !Number.isSafeInteger(bootstrap.capabilityManifestVersion)
    || bootstrap.capabilityManifestVersion <= 0
    || !bootstrap.capabilityManifestHash.trim()
    || canonicalStrings(bootstrap.requiredCapabilities).length === 0
  ) {
    throw new Error("Slack Bridge provisioning bootstrap authority is invalid");
  }
  for (const secret of [bootstrap.signingSecret, bootstrap.oauthClientSecret]) {
    if (
      !secret.encryptedSecretRef.trim()
      || !secret.envelopeKeyId.trim()
      || !Number.isSafeInteger(secret.secretRevision)
      || secret.secretRevision <= 0
    ) throw new Error("Slack Bridge provisioning secret authority is invalid");
  }
}

function registrationMatchesBootstrapIdentity(
  registration: typeof externalAppRegistrations.$inferSelect,
  bootstrap: SlackBridgeProvisioningBootstrapAuthority,
): boolean {
  return registration.id === bootstrap.registrationId
    && registration.provider === "slack"
    && registration.environment === bootstrap.environment
    && registration.state === "active"
    && registration.providerAppId === bootstrap.providerAppId
    && registration.providerOAuthClientId === bootstrap.providerOAuthClientId
    && registration.capabilityManifestVersion === bootstrap.capabilityManifestVersion
    && exactStrings(registration.requiredCapabilities, bootstrap.requiredCapabilities);
}

function assertRegistration(
  registration: typeof externalAppRegistrations.$inferSelect,
  bootstrap: SlackBridgeProvisioningBootstrapAuthority,
): void {
  if (
    !registrationMatchesBootstrapIdentity(registration, bootstrap)
    || registration.capabilityManifestHash !== bootstrap.capabilityManifestHash
  ) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge registration conflicts with runtime authority",
      "external_app_install_conflict",
    );
  }
}

// The capability-manifest hash covers the code-owned scope list
// (`slackBridgeProvisioningManifestHash`), so shipping a scope change (e.g.
// usergroups:* for agent mentions) drifts every existing registration row.
//
// Why moving the recorded hash forward is safe: the manifest hash records
// what the *code* expects the app definition to look like, not which scopes
// any install actually holds — granted scopes live on `installed_scopes` and
// can only grow through a fresh Slack OAuth (the provider will not mint
// usergroups:* onto an existing token). `granted_capabilities` and the
// manifest version are checked separately and must match, so this repair
// only re-pins the content fingerprint; it never enlarges what a server
// admin consented to in capability terms, and an install without the new
// scopes simply keeps running with the old scope set (degrade contract).
//
// MUST run inside a transaction and MUST validate every active grant before
// writing: a partial repair (registration moved, grants left behind) would
// wedge the drift permanently because the registration hash already matches
// on the next call. Callers pass `db` when not already in a transaction.
async function reconcileRegistrationManifestDrift(input: {
  db: Database;
  executor: Database | Tx;
  bootstrap: SlackBridgeProvisioningBootstrapAuthority;
  registration: typeof externalAppRegistrations.$inferSelect;
  now: Date;
}): Promise<void> {
  const { bootstrap, registration, now, db, executor } = input;
  const run = async (tx: Database | Tx): Promise<void> => {
    const previousManifestHash = registration.capabilityManifestHash;
    // Validate before any write: a grant under an unrelated hash means we
    // cannot prove what it authorized — conflict out with nothing changed.
    const activeGrants = await tx.select({
      id: externalAppServerGrants.id,
      grantedManifestVersion: externalAppServerGrants.grantedManifestVersion,
      grantedManifestHash: externalAppServerGrants.grantedManifestHash,
    }).from(externalAppServerGrants).where(and(
      eq(externalAppServerGrants.registrationId, registration.id),
      eq(externalAppServerGrants.state, "active"),
    )).for("update");
    const unrepairable = activeGrants.filter((grant) =>
      grant.grantedManifestVersion !== bootstrap.capabilityManifestVersion
      || (grant.grantedManifestHash !== previousManifestHash
        && grant.grantedManifestHash !== bootstrap.capabilityManifestHash));
    if (unrepairable.length > 0) {
      throw new ExternalAppControlPlaneError(
        "Slack Bridge active grant manifest authority is ambiguous",
        "external_app_install_conflict",
      );
    }
    const [updated] = await tx.update(externalAppRegistrations)
      .set({ capabilityManifestHash: bootstrap.capabilityManifestHash, updatedAt: now })
      .where(and(
        eq(externalAppRegistrations.id, registration.id),
        eq(externalAppRegistrations.capabilityManifestHash, previousManifestHash),
      ))
      .returning({ id: externalAppRegistrations.id });
    if (!updated) {
      throw new ExternalAppControlPlaneError(
        "Slack Bridge registration manifest changed during reconcile",
        "external_app_install_conflict",
      );
    }
    const driftedIds = activeGrants
      .filter((grant) => grant.grantedManifestHash === previousManifestHash)
      .map((grant) => grant.id);
    if (driftedIds.length > 0) {
      await tx.update(externalAppServerGrants)
        .set({ grantedManifestHash: bootstrap.capabilityManifestHash, updatedAt: now })
        .where(inArray(externalAppServerGrants.id, driftedIds));
    }
    console.warn("[Slock] Slack Bridge registration manifest drift reconciled", JSON.stringify({
      registrationId: registration.id,
      previousManifestHash,
      capabilityManifestHash: bootstrap.capabilityManifestHash,
      repairedGrantCount: driftedIds.length,
    }));
  };
  if (executor === db) {
    await db.transaction(async (tx) => run(tx as Tx));
  } else {
    await run(executor);
  }
  registration.capabilityManifestHash = bootstrap.capabilityManifestHash;
}

export type SlackBridgeOAuthIdentityAppType = "slock_builtin" | "third_party_global";

function assertBootstrapClient(
  client: typeof oauthClients.$inferSelect,
  bootstrap: SlackBridgeProvisioningBootstrapAuthority,
): asserts client is typeof oauthClients.$inferSelect & {
  appType: SlackBridgeOAuthIdentityAppType;
} {
  if (
    client.clientId !== `slack-bridge:${bootstrap.registrationId}`
    // Rollout compatibility is intentionally two-state: source must accept
    // the exact legacy identity before the separately authorized reconcile,
    // and accept the standard installed identity afterwards. No other app
    // type or loose client-id prefix is valid.
    || (client.appType !== "slock_builtin" && client.appType !== "third_party_global")
    || client.enabled !== true
    || client.publishStatus !== "published"
    || client.humanMarketplaceVisible !== false
    || !exactStrings(client.allowedScopes ?? [], [])
    || client.name !== "Slack Bridge"
    || client.description !== "Raft first-party Slack Bridge control plane"
    || client.homepageUrl !== null
    || client.returnUrl !== null
    || client.agentManifestUrl !== null
    || client.logoUrl !== null
    || client.logoStorageKey !== null
    || client.category !== "Other"
    || client.dataAccessSummary !== null
    || client.publishRequestedAt !== null
    || client.publishReviewedAt !== null
    || client.publishReviewedByUserId !== null
    || client.publishRejectionReason !== null
    || client.ownerAgentId !== null
    || client.outboundRequestRevision !== 0
    || client.outboundCurrentRevisionId !== null
    || client.outboundPendingRevisionId !== null
    || !exactStrings(client.outboundCurrentGroups, [])
    || !exactStrings(client.outboundCurrentEvents, [])
  ) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge OAuth client conflicts with runtime authority",
      "external_app_install_conflict",
    );
  }
}

export interface SlackBridgeOAuthIdentityReconcileReceipt {
  registrationId: string;
  clientId: string;
  previousAppType: SlackBridgeOAuthIdentityAppType;
  nextAppType: SlackBridgeOAuthIdentityAppType;
  changed: boolean;
  installCount: number;
  authoritySha256: string;
}

function identityMigrationConflict(message: string): never {
  throw new ExternalAppControlPlaneError(message, "external_app_install_conflict");
}

function exactStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Explicit, reversible data reconcile for the Slack Bridge OAuth identity.
 * It is never called from ordinary provisioning. A deployment may therefore
 * accept the legacy identity without silently mutating it; an operator must
 * separately invoke this reviewed transition under live-write authority.
 */
export async function reconcileSlackBridgeOAuthIdentityAppType(input: {
  bootstrap: SlackBridgeProvisioningBootstrapAuthority;
  expectedAppType: SlackBridgeOAuthIdentityAppType;
  nextAppType: SlackBridgeOAuthIdentityAppType;
  expectedAuthoritySha256?: string;
  dryRun?: boolean;
  db?: Database;
}): Promise<SlackBridgeOAuthIdentityReconcileReceipt> {
  assertBootstrap(input.bootstrap);
  if (!input.dryRun && input.expectedAppType === input.nextAppType) {
    identityMigrationConflict("Slack Bridge OAuth identity reconcile types must differ");
  }
  if (
    !input.dryRun
    && !/^[0-9a-f]{64}$/.test(input.expectedAuthoritySha256 ?? "")
  ) {
    identityMigrationConflict("Slack Bridge OAuth identity expected authority fingerprint is invalid");
  }
  const db = input.db ?? getDb();
  return db.transaction(async (tx) => {
    const registrations = await tx.select().from(externalAppRegistrations)
      .where(eq(externalAppRegistrations.id, input.bootstrap.registrationId))
      .limit(2)
      .for("update");
    if (registrations.length !== 1) {
      identityMigrationConflict("Slack Bridge OAuth identity registration is missing or ambiguous");
    }
    const registration = registrations[0]!;
    if (
      registration.capabilityManifestHash !== input.bootstrap.capabilityManifestHash
      && registrationMatchesBootstrapIdentity(registration, input.bootstrap)
    ) {
      await reconcileRegistrationManifestDrift({
        db,
        executor: tx,
        bootstrap: input.bootstrap,
        registration,
        now: currentDate(),
      });
    }
    assertRegistration(registration, input.bootstrap);

    const clients = await tx.select().from(oauthClients)
      .where(eq(oauthClients.id, registration.oauthClientId))
      .limit(2)
      .for("update");
    if (clients.length !== 1) {
      identityMigrationConflict("Slack Bridge OAuth identity client is missing or ambiguous");
    }
    const client = clients[0]!;
    assertBootstrapClient(client, input.bootstrap);
    if (client.clientSecret !== null) {
      identityMigrationConflict("Slack Bridge OAuth identity client shape has drifted");
    }
    if (
      !input.dryRun
      && client.appType !== input.expectedAppType
      && client.appType !== input.nextAppType
    ) {
      identityMigrationConflict("Slack Bridge OAuth identity app type has drifted");
    }

    const [installs, grants, accessRequests, accessGrants, accessTokens, maintainers,
      permissionRevisions, installationTokens, webhookConfigs, shareLinks, agentEvents] = await Promise.all([
      tx.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id)).for("update"),
      tx.select().from(externalAppServerGrants).where(eq(externalAppServerGrants.registrationId, registration.id)).for("update"),
      tx.select({ id: oauthAccessRequests.id }).from(oauthAccessRequests).where(eq(oauthAccessRequests.clientId, client.id)).limit(1),
      tx.select({ id: oauthGrants.id }).from(oauthGrants).where(eq(oauthGrants.clientId, client.id)).limit(1),
      tx.select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(eq(oauthAccessTokens.clientId, client.id)).limit(1),
      tx.select({ id: oauthClientMaintainers.id }).from(oauthClientMaintainers).where(eq(oauthClientMaintainers.clientId, client.id)).limit(1),
      tx.select({ id: oauthAppPermissionRevisions.id }).from(oauthAppPermissionRevisions).where(eq(oauthAppPermissionRevisions.clientId, client.id)).limit(1),
      tx.select({ id: oauthAppInstallationTokens.id }).from(oauthAppInstallationTokens).where(eq(oauthAppInstallationTokens.clientId, client.id)).limit(1),
      tx.select({ id: oauthAppWebhookConfigs.id }).from(oauthAppWebhookConfigs).where(eq(oauthAppWebhookConfigs.clientId, client.id)).limit(1),
      tx.select({ id: oauthClientShareLinks.id }).from(oauthClientShareLinks).where(eq(oauthClientShareLinks.clientId, client.id)).limit(1),
      tx.select({ id: thirdPartyAgentEvents.id }).from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.clientId, client.id)).limit(1),
    ]);

    const activeGrantServers = grants
      .filter((grant) => grant.state === "active")
      .map((grant) => grant.serverId);
    const activeInstallServers = installs
      .filter((install) => install.status === "active")
      .map((install) => install.serverId);
    if (
      installs.length === 0
      || grants.length !== installs.length
      || installs.some((install) => (
        install.status !== "active"
        || install.installedByUserId === null
        || install.installedByAgentId !== null
        || install.approvedRequestRevisionId !== null
        || install.approvedGroups.length !== 0
        || install.subscribedEvents.length !== 0
        || install.grantRevision !== 0
        || install.subscriptionRevision !== 0
      ))
      || grants.some((grant) => (
        grant.state !== "active"
        || !grantMatchesCurrentRegistration(grant, registration)
        || !Number.isSafeInteger(grant.grantEpoch)
        || grant.grantEpoch <= 0
        || grant.grantedByType !== "human"
        || !UUID_PATTERN.test(grant.grantedById)
        || grant.revokedAt !== null
        || grant.revokeReason !== null
      ))
      || !exactStringSet(activeInstallServers, activeGrantServers)
      || accessRequests.length > 0
      || accessGrants.length > 0
      || accessTokens.length > 0
      || maintainers.length > 0
      || permissionRevisions.length > 0
      || installationTokens.length > 0
      || webhookConfigs.length > 0
      || shareLinks.length > 0
      || agentEvents.length > 0
    ) {
      identityMigrationConflict("Slack Bridge OAuth identity authority has unexpected generic App state");
    }

    const notifications = await tx.select({ id: notificationRecipients.id })
      .from(notificationRecipients)
      .where(and(
        eq(notificationRecipients.recipientType, "app_installation"),
        inArray(notificationRecipients.recipientId, installs.map((install) => install.id)),
      ))
      .limit(1);
    if (notifications.length > 0) {
      identityMigrationConflict("Slack Bridge OAuth identity has unexpected App Notification state");
    }

    const authoritySha256 = sha256(JSON.stringify({
      registration,
      client: {
        ...client,
        clientSecretHash: sha256(client.clientSecretHash),
        clientSecret: client.clientSecret === null ? null : "present",
      },
      installs: [...installs].sort((left, right) => left.id.localeCompare(right.id)),
      grants: [...grants].sort((left, right) => left.id.localeCompare(right.id)),
      genericStateIds: {
        accessRequests: accessRequests.map(({ id }) => id).sort(),
        accessGrants: accessGrants.map(({ id }) => id).sort(),
        accessTokens: accessTokens.map(({ id }) => id).sort(),
        maintainers: maintainers.map(({ id }) => id).sort(),
        permissionRevisions: permissionRevisions.map(({ id }) => id).sort(),
        installationTokens: installationTokens.map(({ id }) => id).sort(),
        webhookConfigs: webhookConfigs.map(({ id }) => id).sort(),
        shareLinks: shareLinks.map(({ id }) => id).sort(),
        agentEvents: agentEvents.map(({ id }) => id).sort(),
        notifications: notifications.map(({ id }) => id).sort(),
      },
    }));

    if (input.dryRun) {
      return {
        registrationId: registration.id,
        clientId: client.id,
        previousAppType: client.appType,
        nextAppType: client.appType,
        changed: false,
        installCount: installs.length,
        authoritySha256,
      };
    }
    if (authoritySha256 !== input.expectedAuthoritySha256) {
      identityMigrationConflict("Slack Bridge OAuth identity authority fingerprint changed; run a fresh preflight");
    }

    if (client.appType === input.nextAppType) {
      return {
        registrationId: registration.id,
        clientId: client.id,
        previousAppType: input.nextAppType,
        nextAppType: input.nextAppType,
        changed: false,
        installCount: installs.length,
        authoritySha256,
      };
    }

    const [updated] = await tx.update(oauthClients)
      .set({ appType: input.nextAppType, updatedAt: new Date() })
      .where(and(
        eq(oauthClients.id, client.id),
        eq(oauthClients.appType, input.expectedAppType),
      ))
      .returning({ id: oauthClients.id, appType: oauthClients.appType });
    if (!updated || updated.appType !== input.nextAppType) {
      identityMigrationConflict("Slack Bridge OAuth identity reconcile lost its exact compare-and-set");
    }
    return {
      registrationId: registration.id,
      clientId: updated.id,
      previousAppType: input.expectedAppType,
      nextAppType: input.nextAppType,
      changed: true,
      installCount: installs.length,
      authoritySha256,
    };
  });
}

async function assertBootstrapRows(
  executor: Database | Tx,
  bootstrap: SlackBridgeProvisioningBootstrapAuthority,
  now: Date,
  db: Database,
): Promise<typeof externalAppRegistrations.$inferSelect | null> {
  const registrations = await executor.select().from(externalAppRegistrations)
    .where(eq(externalAppRegistrations.id, bootstrap.registrationId)).limit(2);
  if (registrations.length === 0) return null;
  if (registrations.length !== 1) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge registration authority is ambiguous",
      "external_app_install_conflict",
    );
  }
  const registration = registrations[0]!;
  if (
    registration.capabilityManifestHash !== bootstrap.capabilityManifestHash
    && registrationMatchesBootstrapIdentity(registration, bootstrap)
  ) {
    await reconcileRegistrationManifestDrift({ db, executor, bootstrap, registration, now });
  }
  assertRegistration(registration, bootstrap);
  const clients = await executor.select().from(oauthClients)
    .where(eq(oauthClients.id, registration.oauthClientId)).limit(2);
  if (clients.length !== 1) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge OAuth client authority is missing or ambiguous",
      "external_app_install_conflict",
    );
  }
  assertBootstrapClient(clients[0]!, bootstrap);

  const secrets = await executor.select().from(externalAppRegistrationSecrets)
    .where(eq(externalAppRegistrationSecrets.registrationId, registration.id));
  const assertSecret = (
    purpose: "signing_secret" | "oauth_client_secret",
    expected: SlackBridgeProvisioningSecretAuthority,
  ) => {
    const matches = secrets.filter((secret) => secret.purpose === purpose);
    const secret = matches[0];
    if (
      matches.length !== 1
      || !secret
      || secret.revokedAt !== null
      || secret.leaseOwner !== null
      || secret.leaseExpiresAt !== null
      || secret.encryptedSecretRef !== expected.encryptedSecretRef
      || secret.envelopeKeyId !== expected.envelopeKeyId
      || secret.aadVersion !== 1
      || secret.secretRevision !== expected.secretRevision
    ) {
      throw new ExternalAppControlPlaneError(
        `Slack Bridge ${purpose} authority conflicts with runtime authority`,
        "external_app_install_conflict",
      );
    }
  };
  assertSecret("signing_secret", bootstrap.signingSecret);
  assertSecret("oauth_client_secret", bootstrap.oauthClientSecret);

  const endpoints = await executor.select().from(externalAppIngressEndpoints)
    .where(eq(externalAppIngressEndpoints.registrationId, registration.id)).limit(2);
  const endpoint = endpoints[0];
  if (
    endpoints.length !== 1
    || !endpoint
    || endpoint.environment !== bootstrap.environment
    || endpoint.state !== "active"
    || endpoint.exactRequestUrl !== bootstrap.eventsRequestUrl
    || endpoint.signingSecretRevision !== bootstrap.signingSecret.secretRevision
  ) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge ingress endpoint conflicts with runtime authority",
      "external_app_install_conflict",
    );
  }
  return registration;
}

async function loadCurrentAuthority(
  db: Database,
  bootstrap: SlackBridgeProvisioningBootstrapAuthority,
  serverId: string,
): Promise<CurrentAuthority> {
  const grants = await db.select().from(externalAppServerGrants).where(and(
    eq(externalAppServerGrants.serverId, serverId),
    eq(externalAppServerGrants.registrationId, bootstrap.registrationId),
  )).limit(2);
  if (grants.length > 1) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge server grant authority is ambiguous",
      "external_app_install_conflict",
    );
  }
  const grant = grants[0] ?? null;
  const installServerGrants = await db.select().from(externalAppInstallServerGrants).where(and(
    eq(externalAppInstallServerGrants.serverId, serverId),
    eq(externalAppInstallServerGrants.registrationId, bootstrap.registrationId),
    eq(externalAppInstallServerGrants.state, "active"),
  )).orderBy(desc(externalAppInstallServerGrants.updatedAt)).limit(2);
  if (installServerGrants.length > 1) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge server has multiple current workspace authorities",
      "external_app_install_conflict",
    );
  }
  const installServerGrant = installServerGrants[0] ?? null;
  const installs = installServerGrant
    ? await db.select().from(externalAppInstalls).where(and(
      eq(externalAppInstalls.id, installServerGrant.installId),
      eq(externalAppInstalls.registrationId, bootstrap.registrationId),
    )).limit(2)
    : [];
  if (installs.length > 1 && installs.filter((install) => install.state !== "revoked").length > 1) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge server has multiple current workspace installs",
      "external_app_install_conflict",
    );
  }
  const install = installs.find((candidate) => candidate.state !== "revoked") ?? installs[0] ?? null;
  const credentials = install
    ? await db.select().from(externalAppCredentials)
      .where(eq(externalAppCredentials.installId, install.id)).limit(2)
    : [];
  if (credentials.length > 1) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge credential authority is ambiguous",
      "external_app_install_conflict",
    );
  }
  const bindings = install
    ? await db.select().from(externalChannelBindings).where(and(
      eq(externalChannelBindings.serverId, serverId),
      eq(externalChannelBindings.registrationId, bootstrap.registrationId),
      eq(externalChannelBindings.installId, install.id),
      eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
    )).orderBy(externalChannelBindings.createdAt)
    : [];
  const installGrantReceipts = install
    ? await db.select().from(externalAppInstallGrantReceipts).where(and(
      eq(externalAppInstallGrantReceipts.registrationId, bootstrap.registrationId),
      eq(externalAppInstallGrantReceipts.installId, install.id),
    )).orderBy(desc(externalAppInstallGrantReceipts.receiptRevision)).limit(2)
    : [];
  return {
    grant,
    installServerGrant,
    install,
    credential: credentials[0] ?? null,
    installGrantReceipt: installGrantReceipts[0] ?? null,
    bindings: bindings.filter((binding) =>
      binding.stateReason !== PROVISIONING_REPLACED_REASON
      && binding.stateReason !== PROVISIONING_REMOVED_REASON),
  };
}

function currentGrant(
  authority: CurrentAuthority,
  bootstrap: SlackBridgeProvisioningBootstrapAuthority,
): CurrentAuthority["grant"] {
  const grant = authority.grant;
  if (
    !grant
    || grant.state !== "active"
    || grant.registrationId !== bootstrap.registrationId
    || grant.grantedManifestVersion !== bootstrap.capabilityManifestVersion
    || grant.grantedManifestHash !== bootstrap.capabilityManifestHash
    || !exactStrings(grant.grantedCapabilities, bootstrap.requiredCapabilities)
  ) return null;
  return grant;
}

function currentInstall(authority: CurrentAuthority): Install | null {
  const install = authority.install;
  const grant = authority.grant;
  const installServerGrant = authority.installServerGrant;
  if (
    !install
    || !grant
    || !installServerGrant
    || grant.state !== "active"
    || installServerGrant.serverGrantId !== grant.id
    || installServerGrant.grantEpoch !== grant.grantEpoch
    || installServerGrant.installId !== install.id
    || installServerGrant.registrationId !== install.registrationId
  ) return null;
  return install;
}

function activeProviderAuthority(
  authority: CurrentAuthority,
  now: Date,
): SlackBridgeProvisioningProviderAuthority | null {
  const install = currentInstall(authority);
  const credential = authority.credential;
  if (
    !install
    || install.state !== "active"
    || !credential
    || credential.state !== "active"
    || credential.credentialRevision !== install.credentialRevision
    || (credential.expiresAt !== null && credential.expiresAt <= now)
    || !install.providerAuthorityId.trim()
    || !install.botUserId?.trim()
  ) return null;
  return {
    installId: install.id,
    providerAppId: install.providerAppId,
    providerAuthorityId: install.providerAuthorityId,
    botUserId: install.botUserId,
    connectionEpoch: install.connectionEpoch,
    credentialRevision: install.credentialRevision,
    now,
  };
}

function currentInstallGrantReceipt(
  authority: CurrentAuthority,
  now: Date,
): InstallGrantReceipt | null {
  const install = currentInstall(authority);
  const receipt = authority.installGrantReceipt;
  if (
    !install
    || !receipt
    || receipt.status !== "valid"
    || receipt.expiresAt <= now
    || receipt.registrationId !== install.registrationId
    || receipt.installId !== install.id
    || receipt.connectionEpoch !== install.connectionEpoch
    || receipt.scopeRevision !== install.scopeRevision
    || receipt.credentialRevision !== install.credentialRevision
    || !slackBridgeInstallGrantMatchesInstall(install, receipt)
    || receipt.grantHash !== slackBridgeInstallGrantHash(receipt)
  ) return null;
  return receipt;
}

async function observeProvider(
  provider: SlackBridgeProvisioningProvider,
  authority: CurrentAuthority,
  now: Date,
): Promise<ProviderObservation> {
  const providerAuthority = activeProviderAuthority(authority, now);
  if (!providerAuthority) {
    return { oauthStatus: "unverified", directoryStatus: "unverified", workspaceName: authority.install?.workspaceName ?? null, channels: [], authorizingUserId: null, evidence: null };
  }
  let result: Awaited<ReturnType<SlackBridgeProvisioningProvider["readWorkspace"]>>;
  try {
    result = await provider.readWorkspace(providerAuthority);
  } catch {
    result = { oauth: "unverified", directory: { kind: "unverified" } };
  }
  const directory = result.directory;
  if (directory.kind !== "fact") {
    return {
      oauthStatus: result.oauth,
      directoryStatus: directory.kind,
      workspaceName: authority.install?.workspaceName ?? null,
      channels: [],
      authorizingUserId: null,
      evidence: null,
    };
  }
  const seen = new Set<string>();
  const providerChannels = directory.fact.channels.filter((channel) => {
    if (
      !channel.id.trim()
      || !channel.name.trim()
      || channel.id.length > 256
      || channel.name.length > 200
      || seen.has(channel.id)
    ) return false;
    seen.add(channel.id);
    return true;
  }).slice(0, MAX_CHANNELS);
  const authorizingUserId = authority.installServerGrant?.providerAuthorizingUserId ?? null;
  // Absence, permission errors and incomplete provider pagination do not prove
  // membership. Never expose a private channel on ambiguous evidence.
  const visibleChannels: SlackBridgeProvisioningProviderChannel[] = [];
  for (const channel of providerChannels) {
    if (channel.privacyClass !== "private") { visibleChannels.push(channel); continue; }
    if (!authorizingUserId || !provider.readConversationMember) continue;
    try {
      const membership = await provider.readConversationMember({ ...providerAuthority,
        providerConversationId: channel.id, providerUserId: authorizingUserId });
      if (membership.kind === "fact" && membership.fact === true) visibleChannels.push(channel);
    } catch { /* unverified is not consent */ }
  }
  return {
    oauthStatus: result.oauth,
    directoryStatus: "passed",
    workspaceName: directory.fact.workspaceName?.trim() || authority.install?.workspaceName || null,
    channels: visibleChannels,
    authorizingUserId,
    evidence: authority.installServerGrant ? { installId: providerAuthority.installId,
      connectionEpoch: providerAuthority.connectionEpoch, credentialRevision: providerAuthority.credentialRevision,
      grantId: authority.installServerGrant.id, serverGrantId: authority.installServerGrant.serverGrantId,
      grantEpoch: authority.installServerGrant.grantEpoch } : null,
  };
}

async function observeInstallGrant(
  provider: SlackBridgeProvisioningProvider,
  authority: CurrentAuthority,
  now: Date,
): Promise<Awaited<ReturnType<SlackBridgeProvisioningProvider["readInstallGrant"]>>> {
  const providerAuthority = activeProviderAuthority(authority, now);
  if (!providerAuthority) return { kind: "unverified" };
  try {
    return await provider.readInstallGrant(providerAuthority);
  } catch {
    return { kind: "unverified" };
  }
}

export async function listSlackBridgeRaftConversationTargets(db: Database, serverId: string) {
  const ordinary = await db.select({ id: channels.id, name: channels.name, type: channels.type })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      inArray(channels.type, ["channel", "private"]),
      isNull(channels.archivedAt),
      isNull(channels.deletedAt),
    )).orderBy(channels.name).limit(MAX_CHANNELS);
  const jointHosts = await db.select({ id: channels.id, name: channels.name, type: channels.type })
    .from(channels)
    .innerJoin(jointChannelServers, and(
      eq(jointChannelServers.localChannelId, channels.id),
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.role, "host"),
      eq(jointChannelServers.status, "active"),
    ))
    .innerJoin(jointChannels, and(
      eq(jointChannels.id, jointChannelServers.jointChannelId),
      eq(jointChannels.status, "active"),
    ))
    .where(and(
      eq(channels.serverId, serverId),
      eq(channels.type, "joint"),
      isNull(channels.archivedAt),
      isNull(channels.deletedAt),
    )).orderBy(channels.name).limit(MAX_CHANNELS);
  return [...ordinary, ...jointHosts]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_CHANNELS);
}

async function audienceStatuses(
  db: Database,
  bindings: readonly Binding[],
  now: Date,
  providerObservation: ProviderObservation,
): Promise<Array<{ bindingId: string; status: "matched" | "mismatch" | "unavailable" }>> {
  const results: Array<{ bindingId: string; status: "matched" | "mismatch" | "unavailable" }> = [];
  const providerChannels = new Map(providerObservation.channels.map((channel) => [channel.id, channel]));
  for (const binding of bindings) {
    const providerChannel = providerChannels.get(binding.providerConversationId);
    // A cached public classification cannot prove present visibility after a
    // Slack-side privacy change or a failed inventory/membership lookup.
    if (!providerChannel) {
      results.push({ bindingId: binding.id,
        status: providerObservation.directoryStatus === "passed" ? "mismatch" : "unavailable" });
      continue;
    }
    if (
      providerObservation.directoryStatus === "passed"
      && (
        providerChannel.privacyClass !== binding.privacyClass
        || providerChannel.isMember !== true
      )
    ) {
      results.push({ bindingId: binding.id, status: "mismatch" });
      continue;
    }
    const status = await currentConversationAuthorityStatus(db, binding, now);
    results.push({
      bindingId: binding.id,
      status,
    });
  }
  return results;
}


function preflightFor(input: {
  authority: CurrentAuthority;
  bootstrap: SlackBridgeProvisioningBootstrapAuthority;
  audiences: readonly { bindingId: string; status: "matched" | "mismatch" | "unavailable" }[];
  oauthStatus: "passed" | "failed" | "unverified";
}): SlackBridgePreflight {
  const install = currentInstall(input.authority);
  const credential = input.authority.credential;
  const oauth = install?.state === "active" && credential?.state === "active"
    ? input.oauthStatus
    : install && ["reauth_required", "disconnected", "revoked", "quarantined"].includes(install.state)
        || credential?.state === "revoked"
      ? "failed"
      : "unverified";
  const endpoint = currentGrant(input.authority, input.bootstrap) ? "passed" : "failed";
  const scope = install?.state === "active"
    ? slackBridgeGrantScopesSupportRuntime(install.installedScopes)
      ? "passed"
      : "failed"
    : "unverified";
  const audience = input.authority.bindings.length === 0
    ? "unverified"
    : input.audiences.some((item) => item.status === "mismatch")
      ? "failed"
      : input.audiences.some((item) => item.status === "unavailable")
        ? "unverified"
        : "passed";
  const checks: SlackBridgePreflight["checks"] = [
    { id: "oauth", state: oauth },
    { id: "endpoint", state: endpoint },
    { id: "scope", state: scope },
    { id: "audience", state: audience },
  ];
  return {
    state: checks.every((check) => check.state === "passed")
      ? "passed"
      : checks.some((check) => check.state === "failed")
        ? "failed"
        : "pending",
    checks,
  };
}

function rawHealth(input: {
  authority: CurrentAuthority;
  audiences: readonly { bindingId: string; status: "matched" | "mismatch" | "unavailable" }[];
  connection: ProviderObservation["oauthStatus"];
  preflight: SlackBridgePreflight;
}): SlackBridgeRawHealth {
  const install = input.authority.install;
  const credential = input.authority.credential;
  const bindings = input.authority.bindings.map((binding) => {
    const lifecycle = projectSlackBindingLifecycle({
      installState: install?.state ?? "quarantined",
      installStateReason: install?.stateReason ?? null,
      bindingState: binding.state,
      bindingStateReason: binding.stateReason,
    });
    return {
      id: binding.id,
      state: binding.state,
      bindingEpoch: binding.bindingEpoch,
      stateReason: lifecycle.reason,
      recoveryAction: lifecycle.recoveryAction,
    };
  });
  const failingSurface: SlackBridgeRawHealth["failingSurface"] = !install || install.state !== "active"
    ? "install"
    : !credential || credential.state !== "active"
      ? "credential"
      : bindings.some((binding) => binding.state === "quarantined" || binding.state === "revoked")
        ? "binding"
        : input.audiences.some((audience) => audience.status !== "matched")
          ? "audience"
          : input.preflight.checks.find((check) => check.id === "scope")?.state === "failed"
            ? "scope"
            : input.connection !== "passed"
              ? "connection"
              : null;
  return {
    install: install ? {
      state: install.state,
      epochs: {
        grant: String(input.authority.installServerGrant?.grantEpoch ?? install.grantEpoch),
        connection: String(install.connectionEpoch),
        scope: String(install.scopeRevision),
        credential: String(install.credentialRevision),
      },
    } : null,
    credential: credential ? { state: credential.state } : null,
    bindings,
    audiences: [...input.audiences],
    lastVerifiedAt: install?.lastVerifiedAt?.toISOString() ?? null,
    agentMentionSync: input.authority.installServerGrant?.agentMentionSync ?? null,
    failingSurface,
  };
}

function stageFor(
  authority: CurrentAuthority,
  preflight: SlackBridgePreflight,
  now: Date,
): SlackBridgeProvisioningResponse["snapshot"]["stage"] {
  const grant = authority.grant;
  const install = currentInstall(authority);
  if (!grant || grant.state !== "active") return "connect";
  if (!install || install.state !== "active" || authority.credential?.state !== "active") return "oauth";
  if (authority.bindings.length === 0) return "channels";
  if (authority.bindings.some((binding) => binding.state === "active")) {
    return preflight.state === "passed"
      && currentInstallGrantReceipt(authority, now)
      ? "health"
      : "enable";
  }
  if (
    preflight.state === "passed"
    && authority.bindings.every((binding) =>
      binding.state === "paused" && binding.stateReason === PROVISIONING_PASSED_REASON)
  ) return "enable";
  return "preflight";
}

function providerChannelFallback(
  bindings: readonly (Pick<Binding, "providerConversationId" | "privacyClass"> & Partial<Pick<Binding, "slackLifecycleObservation">>)[],
): SlackBridgeProvisioningProviderChannel[] {
  return bindings.map((binding) => ({
    id: binding.providerConversationId,
    name: binding.slackLifecycleObservation?.name?.value ?? `Slack channel ${binding.providerConversationId}`.slice(0, 200),
    privacyClass: binding.privacyClass,
  }));
}

export function projectSlackProviderChannelsForServer(input: {
  observed: readonly SlackBridgeProvisioningProviderChannel[];
  currentBindings: readonly (Pick<Binding, "providerConversationId" | "privacyClass"> & Partial<Pick<Binding, "slackLifecycleObservation">>)[];
  reservedByOtherServer: ReadonlySet<string>;
}): SlackBridgeProvisioningProviderChannel[] {
  const channels = new Map<string, SlackBridgeProvisioningProviderChannel>();
  for (const channel of [
    ...input.observed.filter((candidate) => !input.reservedByOtherServer.has(candidate.id)),
    ...providerChannelFallback(input.currentBindings),
  ]) {
    if (!channels.has(channel.id)) channels.set(channel.id, channel);
  }
  return [...channels.values()];
}

async function responseFor(input: {
  db: Database;
  bootstrap: SlackBridgeProvisioningBootstrapAuthority;
  authority: CurrentAuthority;
  providerObservation: ProviderObservation;
  request: SlackBridgeProvisioningRequestAuthority;
  viewer?: SlackBridgeProvisioningViewer;
}): Promise<SlackBridgeProvisioningResponse> {
  const viewer = input.viewer ?? { kind: "manager" };
  const raft = await listSlackBridgeRaftConversationTargets(input.db, input.request.serverId);
  const audiences = await audienceStatuses(
    input.db,
    input.authority.bindings,
    input.request.now,
    input.providerObservation,
  );
  const preflight = preflightFor({
    authority: input.authority,
    bootstrap: input.bootstrap,
    audiences,
    oauthStatus: input.providerObservation.oauthStatus,
  });
  const stage = stageFor(
    input.authority,
    preflight,
    input.request.now,
  );
  const reservedProviderConversationIds = new Set<string>();
  if (input.authority.install) {
    const reserved = await input.db.select({
      providerConversationId: externalChannelBindings.providerConversationId,
    }).from(externalChannelBindings).where(and(
      eq(externalChannelBindings.installId, input.authority.install.id),
      ne(externalChannelBindings.serverId, input.request.serverId),
      inArray(externalChannelBindings.state, ["active", "paused", "quarantined"]),
    ));
    for (const binding of reserved) {
      reservedProviderConversationIds.add(binding.providerConversationId);
    }
  }
  // Both the acting Raft human and this server's Slack authorizer must be able to access the pair.
  const visibleRaftChannelIds = await filterChannelIdsVisibleToHuman(
    input.request.serverId, input.request.requestingUserId,
    [...raft.map((channel) => channel.id), ...input.authority.bindings.map((binding) => binding.channelId)],
    input.db,
  );
  const evidence = input.providerObservation.evidence;
  const latest = evidence ? await loadCurrentAuthority(input.db, input.bootstrap, input.request.serverId) : null;
  const [latestRegistration] = evidence ? await input.db.select().from(externalAppRegistrations)
    .where(eq(externalAppRegistrations.id, input.bootstrap.registrationId)).limit(1) : [];
  const latestProvider = latest ? activeProviderAuthority(latest, input.request.now) : null;
  const privateEvidenceCurrent = !!evidence && !!input.providerObservation.authorizingUserId
    && !!latestRegistration && registrationMatchesBootstrapIdentity(latestRegistration, input.bootstrap)
    && latestRegistration.capabilityManifestHash === input.bootstrap.capabilityManifestHash
    && !!latest && !!currentGrant(latest, input.bootstrap)
    && latestProvider?.installId === evidence.installId
    && latestProvider.connectionEpoch === evidence.connectionEpoch
    && latestProvider.credentialRevision === evidence.credentialRevision
    && latest.installServerGrant?.id === evidence.grantId
    && latest.installServerGrant.state === "active"
    && latest.installServerGrant.serverGrantId === evidence.serverGrantId
    && latest.installServerGrant.grantEpoch === evidence.grantEpoch
    && latest.installServerGrant.providerAuthorizingUserId === input.providerObservation.authorizingUserId;
  const visibleObservedChannels = input.providerObservation.channels.filter(channel =>
    channel.privacyClass !== "private" || privateEvidenceCurrent);
  // A formerly public channel may have become private. Stored privacy is not
  // enough to expose its name or binding when its current status is unknown.
  const visibleProviderIds = new Set(visibleObservedChannels.map(channel => channel.id));
  const authorizedBindings = input.authority.bindings.filter(binding =>
    visibleProviderIds.has(binding.providerConversationId));
  const visibleBindings = authorizedBindings.filter(binding => visibleRaftChannelIds.has(binding.channelId));
  const providerChannels = projectSlackProviderChannelsForServer({
    observed: visibleObservedChannels,
    currentBindings: authorizedBindings,
    reservedByOtherServer: reservedProviderConversationIds,
  });
  // Pairs saved earlier can stop matching current authority (Raft channel
  // archived or re-classified, app removed from the Slack channel). Mark them
  // so the UI can offer removal; only judged against a passed inventory.
  const raftTargetsById = new Map(raft.map((channel) => [channel.id, channel]));
  const observedProviderById = input.providerObservation.directoryStatus === "passed"
    ? new Map(input.providerObservation.channels.map((channel) => [channel.id, channel]))
    : null;
  const pairs = visibleBindings.map((binding) => {
    const pair = {
      raftChannelId: binding.channelId,
      slackChannelId: binding.providerConversationId,
      bindingEpoch: binding.bindingEpoch,
    };
    const invalidReason = observedProviderById
      ? slackBridgeChannelPairFailureReason(
        raftTargetsById.get(binding.channelId),
        observedProviderById.get(binding.providerConversationId),
      )
      : null;
    return invalidReason ? { ...pair, invalidReason } : pair;
  });
  const pairedSlackChannelIds = new Set(pairs.map((pair) => pair.slackChannelId));
  const visibleProviderChannels = viewer.kind === "member"
    ? providerChannels.filter((channel) => pairedSlackChannelIds.has(channel.id))
    : providerChannels;
  const visibleRaft = new Map(raft
    .filter((channel) => visibleRaftChannelIds.has(channel.id))
    .map((channel) => [channel.id, { id: channel.id, name: channel.name }]));
  if (pairs.some((pair) => !visibleRaft.has(pair.raftChannelId))) {
    const boundRows = await input.db.select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(inArray(channels.id, pairs.map((pair) => pair.raftChannelId)));
    for (const channel of boundRows) visibleRaft.set(channel.id, channel);
  }
  const health = rawHealth({
    authority: input.authority,
    audiences,
    connection: input.providerObservation.oauthStatus,
    preflight,
  });
  const visibleBindingIds = new Set(visibleBindings.map((binding) => binding.id));
  if (input.request.includeInboundRecovery) {
    health.inboundIsolated = [];
    health.inboundIsolatedSummary = { count: 0, oldestFirstFailureAt: null, undisplayed: 0 };
    health.inboundIsolatedGroups = [];
    const providerAuthorityId = input.authority.install?.providerAuthorityId;
    if (providerAuthorityId && visibleBindings.length) {
      const byConversation = new Map(visibleBindings.map((binding) => [binding.providerConversationId, binding]));
      const held = await input.db.select({ eventId: slackVerifiedIngressEvents.id,
        reason: slackVerifiedIngressEvents.outcomeReason,
        firstFailureAt: slackVerifiedIngressEvents.firstParseFailureAt,
        heldAt: slackVerifiedIngressEvents.heldAt,
        total: sql<number>`(count(*) over())::integer`,
        oldest: sql<Date | string | null>`min(${slackVerifiedIngressEvents.firstParseFailureAt}) over ()`,
        providerConversationId: slackVerifiedIngressPartitions.providerConversationId,
      }).from(slackVerifiedIngressEvents).innerJoin(slackVerifiedIngressPartitions,
        eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId)).where(and(
        eq(slackVerifiedIngressPartitions.appRegistrationId, input.bootstrap.registrationId),
        eq(slackVerifiedIngressPartitions.environment, input.bootstrap.environment),
        eq(slackVerifiedIngressPartitions.providerAuthorityId, providerAuthorityId),
        eq(slackVerifiedIngressPartitions.partitionKind, "conversation"),
        inArray(slackVerifiedIngressPartitions.providerConversationId, [...byConversation.keys()]),
        inArray(slackVerifiedIngressEvents.state, ["held", "quarantined", "review_required"]),
      )).orderBy(asc(slackVerifiedIngressEvents.heldAt), asc(slackVerifiedIngressEvents.id)).limit(500);
      health.inboundIsolated = held.flatMap((row) => {
        const binding = byConversation.get(row.providerConversationId);
        if (!binding || !row.reason) return [];
        return [{ raftChannelId: binding.channelId, bindingId: binding.id, bindingEpoch: binding.bindingEpoch,
          eventId: row.eventId, reason: row.reason, firstFailureAt: row.firstFailureAt?.toISOString() ?? null,
          heldAt: row.heldAt?.toISOString() ?? null }];
      });
      const groups = await input.db.select({ count: sql<number>`count(*)::integer`,
        reason: slackVerifiedIngressEvents.outcomeReason,
        providerConversationId: slackVerifiedIngressPartitions.providerConversationId })
        .from(slackVerifiedIngressEvents).innerJoin(slackVerifiedIngressPartitions,
          eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId)).where(and(
          eq(slackVerifiedIngressPartitions.appRegistrationId, input.bootstrap.registrationId),
          eq(slackVerifiedIngressPartitions.environment, input.bootstrap.environment),
          eq(slackVerifiedIngressPartitions.providerAuthorityId, providerAuthorityId),
          eq(slackVerifiedIngressPartitions.partitionKind, "conversation"),
          inArray(slackVerifiedIngressPartitions.providerConversationId, [...byConversation.keys()]),
          inArray(slackVerifiedIngressEvents.state, ["held", "quarantined", "review_required"]),
        )).groupBy(slackVerifiedIngressPartitions.providerConversationId, slackVerifiedIngressEvents.outcomeReason);
      health.inboundIsolatedGroups = groups.flatMap(group => {
        const binding = byConversation.get(group.providerConversationId);
        return binding && group.reason ? [{ raftChannelId: binding.channelId, bindingId: binding.id,
          bindingEpoch: binding.bindingEpoch, reason: group.reason, count: group.count }] : [];
      });
      const count = held[0]?.total ?? 0;
      health.inboundIsolatedSummary = { count, oldestFirstFailureAt: held[0]?.oldest ? new Date(held[0].oldest).toISOString() : null,
        undisplayed: Math.max(0, count - health.inboundIsolated.length) };
    }
  }
  // Old browser clients use strict response parsers; negotiate the additive health fields.
  if (input.request.includeDeliveryHealth) {
    // Read the actual FIFO head, scoped to the viewer's current binding epochs.
    const heads: Awaited<ReturnType<typeof listSlackPairHeads>> = [];
    for (let offset = 0; offset < visibleBindings.length; offset += SLACK_PAIR_HEAD_BATCH_SIZE) {
      heads.push(...await listSlackPairHeadsForHealth(input.db, visibleBindings.slice(offset, offset + SLACK_PAIR_HEAD_BATCH_SIZE)
        .map((binding) => ({ bindingId: binding.id, bindingEpoch: binding.bindingEpoch }))));
    }
    if (input.request.includePairDeliveryHealth) {
      health.outboundPairBlocks = heads.flatMap((head) => {
        if (!head.authorityBlockedAt || !head.authorityBlockedReason) return [];
        const block = head.authorityBlockedReason;
        const reason = slackPairBlockHint(block);
        return [{ bindingId: head.currentBindingId,
          raftChannelId: visibleBindings.find((binding) => binding.id === head.currentBindingId)!.channelId,
          since: head.authorityBlockedAt.toISOString(), nextRetryAt: head.authorityRetryAt?.toISOString() ?? null, reason,
          ...(input.request.includeWorkspaceAdminHint && block === "slack_workspace_admin_required"
            ? { action: "workspace_admin" as const } : {}),
          ...(input.request.includeConfirmationHint && slackPairConfirmationDetail(block)
            ? { detail: slackPairConfirmationDetail(block) } : {}) }];
      });
      if (health.failingSurface === null && health.outboundPairBlocks.length) health.failingSurface = "delivery";
    }
    const outboundDeliveries = heads.filter((head) =>
      head.state === "dead" || head.state === "outcome_unknown" || head.state === "retry_wait" || head.state === "quarantined"
      || (head.state === "queued" && head.stateReason !== null))
      .map((head) => ({ ...head, bindingId: head.currentBindingId, bindingEpoch: head.currentBindingEpoch }));
    const pendingRetries = outboundDeliveries.length === 0 ? [] : await input.db.select({
      deliveryId: externalDeliveryOperatorDecisions.deliveryId,
    }).from(externalDeliveryOperatorDecisions).where(and(
      inArray(externalDeliveryOperatorDecisions.deliveryId, outboundDeliveries.map((delivery) => delivery.deliveryId)),
      eq(externalDeliveryOperatorDecisions.action, "retry_in_place"),
      isNull(externalDeliveryOperatorDecisions.consumedAt),
    ));
    health.outboundDeliveries = outboundDeliveries.flatMap((delivery) => {
      if (delivery.authorityBlockedReason) return [];
      if (delivery.state !== "dead" && delivery.state !== "outcome_unknown" && delivery.state !== "retry_wait") return [];
      if (!needsSlackBridgeManualRetry({
        ...delivery, firstDispatchedAt: delivery.firstDispatchedAt?.toISOString() ?? null,
      }, input.request.now)) return [];
      return [{
        bindingId: delivery.bindingId,
        bindingEpoch: delivery.bindingEpoch,
        deliveryId: delivery.deliveryId,
        providerAttempts: delivery.providerAttempts,
        raftChannelId: visibleBindings.find((binding) => binding.id === delivery.bindingId)!.channelId,
        state: delivery.state,
        retryRequested: pendingRetries.some((pending) => pending.deliveryId === delivery.deliveryId),
      }];
    });
    if (input.request.includeAttachmentSourceHealth) {
      health.attachmentSourceIssues = outboundDeliveries.flatMap((delivery) => {
        const reason = ["attachment_source_read_failed", "attachment_source_digest_mismatch", "attachment_private_preparation_failed"].includes(delivery.stateReason ?? "") ? "unavailable" as const
          : delivery.stateReason === "attachment_source_size_mismatch" ? "size_mismatch" as const : null;
        const binding = visibleBindings.find((candidate) => candidate.id === delivery.bindingId);
        return reason && binding ? [{ raftChannelId: binding.channelId, reason }] : [];
      });
    }
    if (input.request.includeCardEditNotices) {
      // RFC 082 §4.6: one notice per pair and kind, for the pairs (current
      // epochs) whose Raft channel this viewer can see; recomputed from the
      // syncs' current state, so a notice whose condition no longer holds is
      // never shown.
      const notices = await listSlackCardEditPanelNotices(input.db,
        visibleBindings.map((binding) => ({ bindingId: binding.id, bindingEpoch: binding.bindingEpoch })), input.request.now);
      health.cardEditNotices = notices.flatMap((notice) => {
        const binding = visibleBindings.find((candidate) => candidate.id === notice.bindingId);
        if (!binding) return [];
        return [{ raftChannelId: binding.channelId, bindingId: binding.id, kind: notice.kind,
          ...(notice.kind === "edit_waiting" && notice.reason ? { reason: slackPairBlockHint(notice.reason) } : {}),
          since: notice.since.toISOString() }];
      });
    }
    if (health.failingSurface === null && (health.outboundDeliveries.length > 0
      || outboundDeliveries.some((delivery) => delivery.state === "quarantined" || (delivery.state === "queued" && delivery.stateReason !== null)))) {
      health.failingSurface = "delivery";
    }
  }
  const grant = currentGrant(input.authority, input.bootstrap);
  if (viewer.kind === "manager" && stage === "oauth" && !grant) {
    // A manager at `oauth` must be able to start it; fail closed rather than
    // render a consent step that cannot be completed.
    throw new Error("Slack Bridge OAuth stage requires current server-grant authority");
  }
  return {
    protocolVersion: SLACK_BRIDGE_PROVISIONING_PROTOCOL_VERSION,
    snapshot: {
      stage,
      ...(input.request.includePrivateAuthorizerHint ? { needsSlackReauthorization:
        input.authority.install?.state === "active" && input.authority.installServerGrant?.state === "active"
          && !input.authority.installServerGrant.providerAuthorizingUserId } : {}),
      workspaceName: stage === "connect"
        ? null
        : input.providerObservation.workspaceName ?? input.authority.install?.workspaceName ?? null,
      raftChannels: [...visibleRaft.values()].slice(0, MAX_CHANNELS),
      slackChannels: stage === "connect"
        ? []
        : visibleProviderChannels.map(({ id, name, privacyClass, isMember }) => ({
          id,
          name,
          privacyClass,
          ...(isMember === undefined ? {} : { isMember }),
        })).slice(0, MAX_CHANNELS),
      channelPairs: stage === "connect" ? [] : pairs,
      preflight: stage === "connect" || stage === "oauth" || stage === "channels" ? null : preflight,
      rawHealth: {
        ...health,
        bindings: health.bindings.filter((binding) => visibleBindingIds.has(binding.id)),
        audiences: health.audiences.filter((audience) => visibleBindingIds.has(audience.bindingId)),
      },
    },
    // Past `connect` the same grant also authorizes an in-place
    // re-authorization (new scopes) of the connected workspace. Only managers
    // may start OAuth, so a member's projection never carries the authority.
    oauthAuthority: viewer.kind === "manager" && stage !== "connect" && grant ? {
      registrationId: input.bootstrap.registrationId,
      serverGrantId: grant.id,
      grantEpoch: grant.grantEpoch,
    } : null,
  };
}

async function recordConversationAuthority(input: {
  db: Database;
  provider: SlackBridgeProvisioningProvider;
  avatarMaterializer?: SlackBridgeAvatarMaterializer;
  serverId: string;
  now: Date;
  authority: CurrentAuthority;
  binding: Binding;
  onProviderRetryAfter?(retryAfterMs: number): void;
  isRunHeld?(): Promise<boolean>;
}): Promise<"committed" | "bot_missing" | "fence_mismatch" | "authority_quarantined"> {
  const providerAuthority = activeProviderAuthority(input.authority, input.now);
  const install = currentInstall(input.authority);
  if (!providerAuthority || !install) return "fence_mismatch";

  // Private bindings reuse the public audience path: Slack members are observed
  // directly and bridged via external actor projections, so per-member OAuth
  // links are not a precondition. `privacyClass` still gates which pairs are
  // eligible to bind at all and which writes flow through the private fence.
  const privateBinding = input.binding.privacyClass === "private";

  let providerResult: Awaited<ReturnType<SlackBridgeProvisioningProvider["readConversationAudience"]>> = {
    kind: "unverified",
  };
  try {
    providerResult = await input.provider.readConversationAudience({
      ...providerAuthority,
      isRunHeld: input.isRunHeld,
      providerConversationId: input.binding.providerConversationId,
    });
  } catch {
    providerResult = { kind: "unverified" };
  }

  if (providerResult.kind === "unverified" && Number.isSafeInteger(providerResult.retryAfterMs)
    && providerResult.retryAfterMs! > 0) input.onProviderRetryAfter?.(providerResult.retryAfterMs!);

  if (input.isRunHeld && !await input.isRunHeld()) return "fence_mismatch";

  let status: "matched" | "unavailable" = "unavailable";
  let confirmedBotMissing = false;
  let externalMembers: string[] = [];
  let providerUsers: SlackBridgeProvisioningProviderUser[] = [];
  let unavailableReason = providerResult.kind === "failed"
    ? "provider_failed"
    : "provider_unavailable";
  if (providerResult.kind === "fact") {
    const providerHasBot = Boolean(
      install.botUserId && providerResult.fact.providerMemberIds.includes(install.botUserId),
    );
    externalMembers = canonicalStrings(providerResult.fact.providerMemberIds)
      .filter((memberId) => memberId !== install.botUserId);
    providerUsers = [...providerResult.fact.users];
    const usersById = new Map(providerUsers.map((user) => [user.id, user]));
    const completeProviderIdentity = externalMembers.length > 0
      && usersById.size === providerUsers.length
      && providerUsers.length === externalMembers.length
      && externalMembers.every((providerUserId) => usersById.has(providerUserId));
    if (!providerHasBot && completeProviderIdentity && install.botUserId) {
      confirmedBotMissing = true;
      unavailableReason = "provider_bot_not_in_conversation";
    } else if (!completeProviderIdentity) {
      unavailableReason = externalMembers.length === 0
        ? "provider_audience_empty"
        : "provider_identity_unavailable";
    } else if (providerHasBot) {
      status = "matched";
    }
  }

  const committed = await input.db.transaction(async (tx) => {
    // The network observation must still refer to the same installation and
    // member-event revision when it is committed. Install precedes binding,
    // matching the lifecycle writer's lock order.
    const [lockedInstall] = await tx.select().from(externalAppInstalls).where(and(
      eq(externalAppInstalls.id, install.id), eq(externalAppInstalls.registrationId, install.registrationId),
      eq(externalAppInstalls.state, "active"), eq(externalAppInstalls.connectionEpoch, install.connectionEpoch),
      eq(externalAppInstalls.credentialRevision, install.credentialRevision),
      eq(externalAppInstalls.providerAppId, install.providerAppId),
      eq(externalAppInstalls.providerAuthorityId, install.providerAuthorityId),
    )).for("update").limit(1);
    if (!lockedInstall || lockedInstall.botUserId !== install.botUserId) return "fence_mismatch" as const;
    const [binding] = await tx.select().from(externalChannelBindings).where(and(
      eq(externalChannelBindings.id, input.binding.id),
      eq(externalChannelBindings.serverId, input.serverId),
      eq(externalChannelBindings.installId, install.id),
      inArray(externalChannelBindings.state, ["paused", "active"]),
      eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
      eq(externalChannelBindings.bindingEpoch, input.binding.bindingEpoch),
    )).for("update").limit(1);
    if (!binding || binding.privacyClass !== input.binding.privacyClass
      || binding.providerConversationId !== input.binding.providerConversationId
      || binding.registrationId !== input.binding.registrationId
      || slackAudienceEventRevision(binding.slackLifecycleObservation) === null
      || slackAudienceEventRevision(binding.slackLifecycleObservation) !== slackAudienceEventRevision(input.binding.slackLifecycleObservation)) {
      return "fence_mismatch" as const;
    }
    const [registration] = await tx.select().from(externalAppRegistrations)
      .where(eq(externalAppRegistrations.id, binding.registrationId)).for("share").limit(1);
    const serverAuthority = await resolveExternalInstallServerGrantAuthority(tx, {
      installId: binding.installId,
      serverId: binding.serverId,
      registrationId: binding.registrationId,
    }, { lock: true });
    if (!registration || !serverAuthority.current || binding.grantEpoch !== serverAuthority.grant.grantEpoch
      || !grantMatchesCurrentRegistration(serverAuthority.grant, registration)) {
      return "authority_quarantined" as const;
    }
    const [credential] = await tx.select().from(externalAppCredentials).where(and(
      eq(externalAppCredentials.installId, install.id), eq(externalAppCredentials.state, "active"),
      eq(externalAppCredentials.credentialRevision, install.credentialRevision),
    )).for("update").limit(1);
    if (!credential || (credential.expiresAt && credential.expiresAt <= input.now)) return "fence_mismatch" as const;

    if (confirmedBotMissing) {
      const observedClock = slackLifecycleClockAt(input.now);
      if (binding.slackLifecycleObservation?.botMembership?.clock
        && slackLifecycleClockIsNewer(binding.slackLifecycleObservation.botMembership.clock, observedClock)) {
        return "fence_mismatch" as const;
      }
      let observationEpoch = binding.bindingEpoch;
      if (binding.state === "active") {
        observationEpoch += 1;
        await tx.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_bot_removed",
          bindingEpoch: observationEpoch, updatedAt: input.now,
          slackLifecycleObservation: { ...binding.slackLifecycleObservation, botMembership: { member: false, clock: observedClock } },
        }).where(eq(externalChannelBindings.id, binding.id));
      }
      // Preserve an explicit, fenced mismatch for preflight and dispatch. A
      // later successful audience read supersedes it; no member projections
      // are changed on this missing-bot path.
      const [latestSnapshot] = await tx.select({
        audienceRevision: externalBindingAudienceSnapshots.audienceRevision,
      }).from(externalBindingAudienceSnapshots).where(and(
        eq(externalBindingAudienceSnapshots.bindingId, binding.id),
        eq(externalBindingAudienceSnapshots.bindingEpoch, observationEpoch),
      )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1).for("update");
      await tx.insert(externalBindingAudienceSnapshots).values({
        bindingId: binding.id,
        bindingEpoch: observationEpoch,
        audienceRevision: (latestSnapshot?.audienceRevision ?? 0) + 1,
        externalMemberCount: externalMembers.length,
        externalAudienceDigest: sha256(JSON.stringify(["slack-external-audience", externalMembers])),
        raftMemberCount: externalMembers.length,
        raftAudienceDigest: sha256(JSON.stringify(["raft-authorized-provider-audience", externalMembers])),
        status: "mismatch",
        observedAt: input.now,
        expiresAt: new Date(input.now.getTime() + AUDIENCE_FRESHNESS_MS),
        createdAt: input.now,
      });
      return "bot_missing" as const;
    }

    const [latestSnapshot] = await tx.select({
      audienceRevision: externalBindingAudienceSnapshots.audienceRevision,
    }).from(externalBindingAudienceSnapshots).where(and(
      eq(externalBindingAudienceSnapshots.bindingId, binding.id),
      eq(externalBindingAudienceSnapshots.bindingEpoch, binding.bindingEpoch),
    )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1).for("update");
    const nextRevision = (latestSnapshot?.audienceRevision ?? 0) + 1;
    const expiresAt = new Date(input.now.getTime() + AUDIENCE_FRESHNESS_MS);
    const existingAddresses = await tx.select().from(externalAddressabilityProjections).where(and(
      eq(externalAddressabilityProjections.bindingId, binding.id),
      eq(externalAddressabilityProjections.bindingEpoch, binding.bindingEpoch),
      eq(externalAddressabilityProjections.conversationId, binding.providerConversationId),
    )).orderBy(asc(externalAddressabilityProjections.id)).for("update");
    const addressedProjectionIds = new Set<string>();
    if (status === "matched") {
      for (const fact of providerUsers) {
        const providerUserId = fact.id;
        const existingRows = await tx.select().from(externalActorProjections).where(and(
          eq(externalActorProjections.provider, "slack"),
          eq(externalActorProjections.appRegistrationId, install.registrationId),
          eq(externalActorProjections.installId, install.id),
          eq(externalActorProjections.workspaceId, install.providerAuthorityId),
          eq(externalActorProjections.externalActorId, providerUserId),
        )).for("update").limit(2);
        if (existingRows.length > 1) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge provider identity is ambiguous",
            "external_app_invalid_state",
          );
        }
        const [projection] = existingRows.length === 1
          ? await tx.update(externalActorProjections).set({
            displayName: fact.displayName,
            handles: fact.handle ? [fact.handle] : [],
            actorKind: fact.actorKind,
            state: "active",
            deactivated: false,
            // projectionRevision is an authority/content version, not an
            // observation counter. Advancing it for a freshness-only audience
            // refresh can revoke an ingress event between enqueue and worker
            // commit even though the Slack actor is still the same authority.
            projectionRevision: slackActorProjectionRevisionAfterRefresh(existingRows[0]!, fact),
            observedAt: input.now,
            updatedAt: input.now,
          }).where(eq(externalActorProjections.id, existingRows[0]!.id)).returning()
          : await tx.insert(externalActorProjections).values({
            provider: "slack",
            appRegistrationId: install.registrationId,
            installId: install.id,
            workspaceId: install.providerAuthorityId,
            externalActorId: providerUserId,
            displayName: fact.displayName,
            handles: fact.handle ? [fact.handle] : [],
            actorKind: fact.actorKind,
            state: "active",
            deactivated: false,
            projectionRevision: 1,
            observedAt: input.now,
            createdAt: input.now,
            updatedAt: input.now,
          }).returning();
        if (!projection) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge provider identity could not be persisted",
            "external_app_persist_failed",
          );
        }
        addressedProjectionIds.add(projection.id);
        const addresses = existingAddresses.filter((address) =>
          address.projectionId === projection.id);
        if (addresses.length > 1) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge provider addressability is ambiguous",
            "external_app_invalid_state",
          );
        }
        const addressValues = {
          provider: "slack",
          appRegistrationId: install.registrationId,
          installId: install.id,
          workspaceId: install.providerAuthorityId,
          connectionEpoch: install.connectionEpoch,
          bindingId: binding.id,
          bindingEpoch: binding.bindingEpoch,
          conversationId: binding.providerConversationId,
          memberRevision: nextRevision,
          contextRevision: nextRevision,
          state: "active" as const,
          observedAt: input.now,
          expiresAt,
          updatedAt: input.now,
        };
        if (addresses[0]) {
          await tx.update(externalAddressabilityProjections).set(addressValues)
            .where(eq(externalAddressabilityProjections.id, addresses[0].id));
        } else {
          await tx.insert(externalAddressabilityProjections).values({
            projectionId: projection.id,
            ...addressValues,
            createdAt: input.now,
          });
        }
      }
    }

    for (const address of existingAddresses) {
      if (addressedProjectionIds.has(address.projectionId)) continue;
      // An unavailable refresh knows nothing about membership: marking
      // addresses stale would revoke in-flight frozen mentions and stall
      // deliveries a failed directory refresh must not touch (degrade,
      // don't gate). A matched refresh that observed the member missing
      // still marks them stale.
      if (status === "unavailable") continue;
      await tx.update(externalAddressabilityProjections).set({
        memberRevision: nextRevision,
        contextRevision: nextRevision,
        state: "stale",
        observedAt: input.now,
        expiresAt,
        updatedAt: input.now,
      }).where(eq(externalAddressabilityProjections.id, address.id));
    }

    const externalAudienceDigest = status === "unavailable"
      ? sha256(JSON.stringify(["slack-external-audience-unavailable", unavailableReason]))
      : sha256(JSON.stringify(["slack-external-audience", externalMembers]));
    const raftAudienceDigest = status === "unavailable"
      ? sha256(JSON.stringify(["raft-authorized-audience-unavailable", unavailableReason]))
      : sha256(JSON.stringify(["raft-authorized-provider-audience", externalMembers]));
    if (privateBinding) {
      // Private bindings still track audience freshness as refresh metadata.
      // It no longer gates dispatch, but it keeps the snapshot chain and
      // addressability expiry bookkeeping moving.
      await tx.update(externalChannelBindings).set({
        audienceRevision: nextRevision,
        audienceFreshUntil: expiresAt,
        updatedAt: input.now,
      }).where(eq(externalChannelBindings.id, binding.id));
    }
    await tx.insert(externalBindingAudienceSnapshots).values({
      bindingId: binding.id,
      bindingEpoch: binding.bindingEpoch,
      audienceRevision: nextRevision,
      externalMemberCount: status === "unavailable" ? 0 : externalMembers.length,
      externalAudienceDigest,
      raftMemberCount: status === "unavailable" ? 0 : externalMembers.length,
      raftAudienceDigest,
      status,
      observedAt: input.now,
      expiresAt,
      createdAt: input.now,
    });
    return "committed" as const;
  });
  if (committed !== "committed" || status !== "matched" || !input.avatarMaterializer) {
    return committed;
  }
  const avatarUsers = providerUsers.filter((user) => user.avatarLocator !== undefined);
  if (avatarUsers.length === 0) return "committed";
  const projections = await input.db.select({
    id: externalActorProjections.id,
    externalActorId: externalActorProjections.externalActorId,
    projectionRevision: externalActorProjections.projectionRevision,
  }).from(externalActorProjections).where(and(
    eq(externalActorProjections.provider, "slack"),
    eq(externalActorProjections.appRegistrationId, install.registrationId),
    eq(externalActorProjections.installId, install.id),
    eq(externalActorProjections.workspaceId, install.providerAuthorityId),
    eq(externalActorProjections.state, "active"),
    eq(externalActorProjections.deactivated, false),
    eq(externalActorProjections.observedAt, input.now),
    inArray(externalActorProjections.externalActorId, avatarUsers.map((user) => user.id)),
  ));
  const byExternalId = new Map(projections.map((projection) => [projection.externalActorId, projection]));
  const queue = avatarUsers.flatMap((user) => {
    const projection = byExternalId.get(user.id);
    return projection && user.avatarLocator !== undefined
      ? [{ projection, sourceLocator: user.avatarLocator }] : [];
  });
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(AVATAR_MATERIALIZATION_CONCURRENCY, queue.length) },
    async () => {
      while (cursor < queue.length) {
        const work = queue[cursor++];
        if (!work) return;
        try {
          await input.avatarMaterializer!.materializeExternalProjection({
            projectionId: work.projection.id,
            expectedProjectionRevision: work.projection.projectionRevision,
            expectedObservedAt: input.now,
            sourceLocator: work.sourceLocator,
          });
        } catch {
          // Avatar refresh is deliberately non-authoritative for membership. A
          // failed image keeps the prior artifact/fallback without degrading
          // the audience snapshot that was independently verified above.
        }
      }
    },
  ));
  return "committed";
}

export interface SlackConversationAuthorityRefreshReceipt {
  bindingId: string;
  audienceStatus: "matched" | "mismatch" | "unavailable";
  observedAtMs: number;
  reason?: "authority_quarantined" | "credential_unavailable" | "identity_mapping_unavailable" | "provider_unavailable";
  revision?: number;
  bindingEpoch?: number;
  credentialRevision?: number;
  audienceEventRevision?: number;
  retryAfterMs?: number;
}

/**
 * Refreshes one active binding (public or private) from the same provider-
 * backed producer used by self-serve setup. The lifecycle caller gets no
 * synthetic fallback: every DB authority row and the current install-grant
 * receipt must still match before provider identity can extend actor
 * addressability.
 */
export async function refreshSlackConversationAuthority(input: {
  db?: Database;
  provider: SlackBridgeProvisioningProvider;
  avatarMaterializer?: SlackBridgeAvatarMaterializer;
  bindingId: string;
  now: Date;
  /** Lifecycle may reuse a coherent snapshot with more than ten minutes left. */
  reuseFresh?: boolean;
  /** Recovery only; manual pauses must never be made eligible. */
  allowBotRemovedPause?: true;
  isRunHeld?(): Promise<boolean>;
}): Promise<SlackConversationAuthorityRefreshReceipt> {
  const db = input.db ?? getDb();
  let retryAfterMs: number | undefined;
  const unavailable = (
    reason: NonNullable<SlackConversationAuthorityRefreshReceipt["reason"]>,
  ): SlackConversationAuthorityRefreshReceipt => ({
    bindingId: input.bindingId,
    audienceStatus: "unavailable",
    observedAtMs: input.now.getTime(),
    reason,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
  if (!input.bindingId.trim() || !validDate(input.now)) {
    return unavailable("identity_mapping_unavailable");
  }

  // Refresh is privacy-agnostic: public and private bindings share the same
  // member observation and actor-projection path now that the per-member
  // OAuth link precondition is removed.
  const bindings = await db.select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.id, input.bindingId),
    input.allowBotRemovedPause ? or(eq(externalChannelBindings.state, "active"), and(
      eq(externalChannelBindings.state, "paused"), eq(externalChannelBindings.stateReason, "provider_bot_removed"),
    )) : eq(externalChannelBindings.state, "active"),
  )).limit(2);
  if (bindings.length !== 1) return unavailable("identity_mapping_unavailable");
  const binding = bindings[0]!;
  const installs = await db.select().from(externalAppInstalls).where(and(
    eq(externalAppInstalls.id, binding.installId),
    eq(externalAppInstalls.registrationId, binding.registrationId),
  )).limit(2);
  if (installs.length !== 1) return unavailable("identity_mapping_unavailable");
  const install = installs[0]!;
  const registrations = await db.select().from(externalAppRegistrations).where(and(
    eq(externalAppRegistrations.id, binding.registrationId),
    eq(externalAppRegistrations.state, "active"),
  )).limit(2);
  const serverAuthority = await resolveExternalInstallServerGrantAuthority(db, {
    installId: install.id,
    serverId: binding.serverId,
    registrationId: binding.registrationId,
  });
  const credentials = await db.select().from(externalAppCredentials)
    .where(eq(externalAppCredentials.installId, install.id)).limit(2);
  const receipts = await db.select().from(externalAppInstallGrantReceipts).where(and(
    eq(externalAppInstallGrantReceipts.registrationId, binding.registrationId),
    eq(externalAppInstallGrantReceipts.installId, install.id),
  )).orderBy(desc(externalAppInstallGrantReceipts.receiptRevision)).limit(2);
  if (
    registrations.length !== 1
    || credentials.length !== 1
  ) {
    return unavailable("identity_mapping_unavailable");
  }
  if (
    !serverAuthority.current
    || binding.grantEpoch !== serverAuthority.grant.grantEpoch
    || !grantMatchesCurrentRegistration(serverAuthority.grant, registrations[0]!)
  ) {
    return unavailable("authority_quarantined");
  }
  const authority: CurrentAuthority = {
    grant: serverAuthority.grant,
    installServerGrant: serverAuthority.association,
    install,
    credential: credentials[0]!,
    installGrantReceipt: receipts[0] ?? null,
    bindings: [binding],
  };
  if (!activeProviderAuthority(authority, input.now)) {
    return unavailable("credential_unavailable");
  }
  if (!currentInstallGrantReceipt(authority, input.now)) {
    return unavailable("authority_quarantined");
  }

  if (input.reuseFresh) {
    const [snapshot] = await db.select({
      status: externalBindingAudienceSnapshots.status,
      expiresAt: externalBindingAudienceSnapshots.expiresAt,
    }).from(externalBindingAudienceSnapshots).where(and(
      eq(externalBindingAudienceSnapshots.bindingId, binding.id),
      eq(externalBindingAudienceSnapshots.bindingEpoch, binding.bindingEpoch),
    )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1);
    if (snapshot?.status === "matched"
      && snapshot.expiresAt.getTime() > input.now.getTime() + AUDIENCE_RENEWAL_LEAD_MS
      && await currentConversationAuthorityStatus(db, binding, input.now) === "matched") {
      return { bindingId: binding.id, audienceStatus: "matched", observedAtMs: input.now.getTime() };
    }
  }

  const recorded = await recordConversationAuthority({
    db,
    provider: input.provider,
    avatarMaterializer: input.avatarMaterializer,
    serverId: binding.serverId,
    now: input.now,
    authority,
    binding,
    onProviderRetryAfter: (duration) => { retryAfterMs = duration; },
    isRunHeld: input.isRunHeld,
  });
  if (recorded === "authority_quarantined") return unavailable("authority_quarantined");
  if (recorded !== "committed") return unavailable("identity_mapping_unavailable");
  const currentBindings = await db.select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.id, binding.id),
    eq(externalChannelBindings.serverId, binding.serverId),
    eq(externalChannelBindings.registrationId, binding.registrationId),
    eq(externalChannelBindings.installId, binding.installId),
    eq(externalChannelBindings.connectionEpoch, binding.connectionEpoch),
    eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
    input.allowBotRemovedPause ? or(eq(externalChannelBindings.state, "active"), and(
      eq(externalChannelBindings.state, "paused"), eq(externalChannelBindings.stateReason, "provider_bot_removed"),
    )) : eq(externalChannelBindings.state, "active"),
  )).limit(2);
  if (currentBindings.length !== 1) return unavailable("identity_mapping_unavailable");
  const status = await currentConversationAuthorityStatus(db, currentBindings[0]!, input.now);
  const audienceEventRevision = slackAudienceEventRevision(binding.slackLifecycleObservation);
  if (audienceEventRevision === null
    || slackAudienceEventRevision(currentBindings[0]!.slackLifecycleObservation) !== audienceEventRevision) {
    return unavailable("identity_mapping_unavailable");
  }
  const [snapshot] = await db.select({
    audienceRevision: externalBindingAudienceSnapshots.audienceRevision,
  }).from(externalBindingAudienceSnapshots).where(and(
    eq(externalBindingAudienceSnapshots.bindingId, binding.id),
    eq(externalBindingAudienceSnapshots.bindingEpoch, binding.bindingEpoch),
  )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1);
  return {
    bindingId: binding.id,
    audienceStatus: status,
    observedAtMs: input.now.getTime(),
    ...(status === "unavailable" ? { reason: "provider_unavailable" as const } : {}),
    ...(snapshot ? { revision: snapshot.audienceRevision } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    bindingEpoch: binding.bindingEpoch, credentialRevision: install.credentialRevision, audienceEventRevision,
  };
}

async function markPreflightResult(input: {
  db: Database;
  request: SlackBridgeProvisioningRequestAuthority;
  authority: CurrentAuthority;
  passed: boolean;
}): Promise<void> {
  const install = currentInstall(input.authority);
  if (!install) return;
  await input.db.transaction(async (tx) => {
    await requireManager(tx, input.request, true);
    const bindings = await tx.select().from(externalChannelBindings).where(and(
      eq(externalChannelBindings.serverId, input.request.serverId),
      eq(externalChannelBindings.installId, install.id),
      eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
      eq(externalChannelBindings.state, "paused"),
      inArray(externalChannelBindings.stateReason, [PROVISIONING_PENDING_REASON, PROVISIONING_PASSED_REASON]),
    )).for("update");
    for (const binding of bindings) {
      await tx.update(externalChannelBindings).set({
        stateReason: input.passed ? PROVISIONING_PASSED_REASON : PROVISIONING_PENDING_REASON,
        updatedAt: input.request.now,
      }).where(and(
        eq(externalChannelBindings.id, binding.id),
        eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
        eq(externalChannelBindings.state, "paused"),
      ));
    }
    if (input.passed) {
      await tx.update(externalAppInstalls).set({
        lastVerifiedAt: input.request.now,
        updatedAt: input.request.now,
      }).where(and(
        eq(externalAppInstalls.id, install.id),
        eq(externalAppInstalls.connectionEpoch, install.connectionEpoch),
        eq(externalAppInstalls.credentialRevision, install.credentialRevision),
        eq(externalAppInstalls.state, "active"),
      ));
    }
  });
}

/**
 * Concrete, durable Slack Bridge setup authority. Every operation re-reads
 * registration/grant/install/credential/binding/audience rows and validates
 * the requesting human's current manageServer capability. Provider data is
 * read-only input and is always fenced by the persisted install epochs.
 */
export function createSlackBridgeProvisioningControlPlane(
  dependencies: SlackBridgeProvisioningControlPlaneDependencies,
): SlackBridgeProvisioningControlPlane {
  assertBootstrap(dependencies.bootstrap);
  const db = dependencies.db ?? getDb();
  const bootstrap = {
    ...dependencies.bootstrap,
    requiredCapabilities: canonicalStrings(dependencies.bootstrap.requiredCapabilities),
  };

  const load = async (
    request: SlackBridgeProvisioningRequestAuthority,
  ): Promise<SlackBridgeProvisioningResponse> => {
    const viewer = await requireReader(db, request);
    const registration = await assertBootstrapRows(db, bootstrap, request.now, db);
    const authority = registration
      ? await loadCurrentAuthority(db, bootstrap, request.serverId)
      : {
        grant: null,
        installServerGrant: null,
        install: null,
        credential: null,
        installGrantReceipt: null,
        bindings: [],
      };
    // Members read the same live workspace observation as managers: stage,
    // preflight and paired Slack channel names all depend on it, and a stored
    // fallback would show a healthy bridge as unverified.
    const observation = registration
      ? await observeProvider(dependencies.provider, authority, request.now)
      : { oauthStatus: "unverified" as const, directoryStatus: "unverified" as const, workspaceName: null, channels: [], authorizingUserId: null, evidence: null };
    return responseFor({ db, bootstrap, authority, providerObservation: observation, request, viewer });
  };

  const loadWithoutProvider = async (
    request: SlackBridgeProvisioningRequestAuthority,
  ): Promise<SlackBridgeProvisioningResponse> => {
    await requireManager(db, request);
    const registration = await assertBootstrapRows(db, bootstrap, request.now, db);
    const authority = registration
      ? await loadCurrentAuthority(db, bootstrap, request.serverId)
      : {
        grant: null,
        installServerGrant: null,
        install: null,
        credential: null,
        installGrantReceipt: null,
        bindings: [],
      };
    return responseFor({
      db,
      bootstrap,
      authority,
      providerObservation: {
        oauthStatus: "unverified",
        directoryStatus: "unverified",
        workspaceName: authority.install?.workspaceName ?? null,
        channels: [],
        authorizingUserId: null,
        evidence: null,
      },
      request,
    });
  };

  const controlPlane: SlackBridgeProvisioningControlPlane = {
    load,

    async connect(request) {
      requireManagerInput(request);
      await db.transaction(async (tx) => {
        await requireManager(tx, request, true);
        const clientId = `slack-bridge:${bootstrap.registrationId}`;
        let [client] = await tx.select().from(oauthClients)
          .where(eq(oauthClients.clientId, clientId)).for("update").limit(1);
        if (!client) {
          [client] = await tx.insert(oauthClients).values({
            serverId: request.serverId,
            clientId,
            clientSecretHash: sha256(randomBytes(32).toString("base64url")),
            appType: "third_party_global",
            publishStatus: "published",
            name: "Slack Bridge",
            description: "Raft first-party Slack Bridge control plane",
            allowedScopes: [],
            enabled: true,
            humanMarketplaceVisible: false,
            createdByUserId: request.requestingUserId,
            createdAt: request.now,
            updatedAt: request.now,
          }).onConflictDoNothing({ target: oauthClients.clientId }).returning();
          if (!client) {
            [client] = await tx.select().from(oauthClients)
              .where(eq(oauthClients.clientId, clientId)).for("update").limit(1);
          }
        }
        if (!client) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge OAuth client could not be persisted",
            "external_app_persist_failed",
          );
        }
        assertBootstrapClient(client, bootstrap);

        let registration = await assertBootstrapRows(tx, bootstrap, request.now, db);
        if (!registration) {
          [registration] = await tx.insert(externalAppRegistrations).values({
            id: bootstrap.registrationId,
            oauthClientId: client.id,
            provider: "slack",
            environment: bootstrap.environment,
            state: "active",
            providerAppId: bootstrap.providerAppId,
            providerOAuthClientId: bootstrap.providerOAuthClientId,
            capabilityManifestVersion: bootstrap.capabilityManifestVersion,
            capabilityManifestHash: bootstrap.capabilityManifestHash,
            requiredCapabilities: bootstrap.requiredCapabilities,
            createdAt: request.now,
            updatedAt: request.now,
          }).returning();
          if (!registration) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge registration could not be persisted",
              "external_app_persist_failed",
            );
          }
          await tx.insert(externalAppRegistrationSecrets).values([{
            registrationId: registration.id,
            purpose: "signing_secret",
            encryptedSecretRef: bootstrap.signingSecret.encryptedSecretRef,
            envelopeKeyId: bootstrap.signingSecret.envelopeKeyId,
            aadVersion: 1,
            secretRevision: bootstrap.signingSecret.secretRevision,
            createdAt: request.now,
            updatedAt: request.now,
          }, {
            registrationId: registration.id,
            purpose: "oauth_client_secret",
            encryptedSecretRef: bootstrap.oauthClientSecret.encryptedSecretRef,
            envelopeKeyId: bootstrap.oauthClientSecret.envelopeKeyId,
            aadVersion: 1,
            secretRevision: bootstrap.oauthClientSecret.secretRevision,
            createdAt: request.now,
            updatedAt: request.now,
          }]);
          await tx.insert(externalAppIngressEndpoints).values({
            registrationId: registration.id,
            environment: bootstrap.environment,
            exactRequestUrl: bootstrap.eventsRequestUrl,
            state: "active",
            endpointRevision: 1,
            signingSecretRevision: bootstrap.signingSecret.secretRevision,
            createdAt: request.now,
            updatedAt: request.now,
          });
        }
        assertRegistration(registration, bootstrap);
        if (registration.oauthClientId !== client.id) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge registration references a conflicting OAuth client",
            "external_app_install_conflict",
          );
        }
        await assertBootstrapRows(tx, bootstrap, request.now, db);

        await tx.insert(oauthClientInstalls).values({
          serverId: request.serverId,
          clientId: client.id,
          installedByUserId: request.requestingUserId,
          status: "active",
          approvedScopes: effectiveAllowedOAuthScopes(client.allowedScopes),
          createdAt: request.now,
          updatedAt: request.now,
        }).onConflictDoUpdate({
          target: [oauthClientInstalls.serverId, oauthClientInstalls.clientId],
          set: {
            installedByUserId: request.requestingUserId,
            installedByAgentId: null,
            status: "active",
            approvedScopes: effectiveAllowedOAuthScopes(client.allowedScopes),
            updatedAt: request.now,
          },
        });

        const [existingGrant] = await tx.select().from(externalAppServerGrants).where(and(
          eq(externalAppServerGrants.serverId, request.serverId),
          eq(externalAppServerGrants.registrationId, registration.id),
        )).for("update").limit(1);
        if (existingGrant?.state === "active") {
          if (
            existingGrant.grantedManifestVersion !== bootstrap.capabilityManifestVersion
            || existingGrant.grantedManifestHash !== bootstrap.capabilityManifestHash
            || !exactStrings(existingGrant.grantedCapabilities, bootstrap.requiredCapabilities)
          ) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge active grant conflicts with runtime authority",
              "external_app_install_conflict",
            );
          }
        } else if (existingGrant) {
          await tx.update(externalAppServerGrants).set({
            state: "active",
            grantEpoch: existingGrant.grantEpoch + 1,
            grantedManifestVersion: bootstrap.capabilityManifestVersion,
            grantedManifestHash: bootstrap.capabilityManifestHash,
            grantedCapabilities: bootstrap.requiredCapabilities,
            grantedByType: "human",
            grantedById: request.requestingUserId,
            revokedAt: null,
            revokeReason: null,
            updatedAt: request.now,
          }).where(eq(externalAppServerGrants.id, existingGrant.id));
        } else {
          await tx.insert(externalAppServerGrants).values({
            serverId: request.serverId,
            registrationId: registration.id,
            state: "active",
            grantEpoch: 1,
            grantedManifestVersion: bootstrap.capabilityManifestVersion,
            grantedManifestHash: bootstrap.capabilityManifestHash,
            grantedCapabilities: bootstrap.requiredCapabilities,
            grantedByType: "human",
            grantedById: request.requestingUserId,
            createdAt: request.now,
            updatedAt: request.now,
          });
        }
      });
      return load(request);
    },

    async saveChannelPairs(input) {
      requireManagerInput(input);
      const registration = await assertBootstrapRows(db, bootstrap, input.now, db);
      if (!registration) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge connect must complete before channel selection",
          "external_app_invalid_state",
        );
      }
      const authority = await loadCurrentAuthority(db, bootstrap, input.serverId);
      const providerAuthority = activeProviderAuthority(authority, input.now);
      const serverGrant = currentGrant(authority, bootstrap);
      const installServerGrant = authority.installServerGrant;
      if (!providerAuthority || !serverGrant || !installServerGrant) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge OAuth authority is not active",
          "external_app_not_authorized",
        );
      }
      const observation = await observeProvider(dependencies.provider, authority, input.now);
      if (observation.directoryStatus !== "passed") {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge provider channel inventory is unavailable",
          "external_app_invalid_state",
          "provider_unavailable",
        );
      }
      const providerById = new Map(observation.channels.map((channel) => [channel.id, channel]));
      const raft = await listSlackBridgeRaftConversationTargets(db, input.serverId);
      const raftById = new Map(raft.map((channel) => [channel.id, channel]));

      // Reject unauthorized callers before allowing them to contend on stable
      // conversation keys; the transaction repeats this check with a row lock.
      await requireManager(db, input);
      for (let lockAttempt = 0; ; lockAttempt += 1) {
        // Setup also revokes omitted paused pairs. Discover them before taking
        // row locks, then recheck after locking: another save can introduce a
        // new omitted pair between discovery and the transaction.
        const priorPaused = await db.select({ providerConversationId: externalChannelBindings.providerConversationId })
          .from(externalChannelBindings).where(and(
            eq(externalChannelBindings.serverId, input.serverId),
            eq(externalChannelBindings.installId, providerAuthority.installId),
            eq(externalChannelBindings.connectionEpoch, providerAuthority.connectionEpoch),
            eq(externalChannelBindings.state, "paused"),
          ));
        const conversationIds = new Set([...input.pairs.map((pair) => pair.slackChannelId),
          ...priorPaused.map((binding) => binding.providerConversationId)]);
        try {
          await db.transaction(async (tx) => {
        // Serialize creation/revival against a never-paired proof across
        // installation generations. This is only one of the writer paths;
        // do not enable absence-based discard until every writer and the
        // mixed-version rollout fence participate.
        await lockSlackConversations(tx, [...conversationIds].map((providerConversationId) => ({
          registrationId: bootstrap.registrationId,
          providerAuthorityId: providerAuthority.providerAuthorityId,
          providerConversationId,
        })));
        await requireManager(tx, input, true);
        // Re-check in the mutation transaction, after provider I/O and before
        // any persisted/kept-pair shortcut. Never trust the earlier UI list.
        for (const pair of input.pairs) {
          if (!await canUserAccessChannel(pair.raftChannelId, input.requestingUserId, asServerId(input.serverId), { executor: tx })) {
            throw new ExternalAppControlPlaneError("Slack Bridge channel selection is not authorized", "external_app_not_authorized");
          }
        }
        const [install] = await tx.select().from(externalAppInstalls).where(and(
          eq(externalAppInstalls.id, providerAuthority.installId),
          eq(externalAppInstalls.registrationId, bootstrap.registrationId),
          notInArray(externalAppInstalls.state, ["revoked"]),
          eq(externalAppInstalls.connectionEpoch, providerAuthority.connectionEpoch),
          eq(externalAppInstalls.credentialRevision, providerAuthority.credentialRevision),
        )).for("update").limit(1);
        if (!install) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge install changed during channel selection",
            "external_app_not_authorized",
          );
        }
        const [lockedInstallServerGrant] = await tx.select()
          .from(externalAppInstallServerGrants)
          .where(and(
            eq(externalAppInstallServerGrants.id, installServerGrant.id),
            eq(externalAppInstallServerGrants.installId, install.id),
            eq(externalAppInstallServerGrants.serverId, input.serverId),
            eq(externalAppInstallServerGrants.registrationId, bootstrap.registrationId),
            eq(externalAppInstallServerGrants.serverGrantId, serverGrant.id),
            eq(externalAppInstallServerGrants.grantEpoch, serverGrant.grantEpoch),
            eq(externalAppInstallServerGrants.state, "active"),
          ))
          .for("update")
          .limit(1);
        if (!lockedInstallServerGrant) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge server workspace authority changed during channel selection",
            "external_app_not_authorized",
          );
        }
        const currentServerAuthority = await resolveExternalInstallServerGrantAuthority(tx, {
          installId: install.id, serverId: input.serverId, registrationId: bootstrap.registrationId,
        }, { lock: true });
        if (!currentServerAuthority.current || currentServerAuthority.association.id !== lockedInstallServerGrant.id
          || currentServerAuthority.grant.id !== serverGrant.id
          || currentServerAuthority.grant.grantEpoch !== serverGrant.grantEpoch
          || !grantMatchesCurrentRegistration(currentServerAuthority.grant, registration)) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge server authorization changed during channel selection",
            "external_app_not_authorized",
          );
        }
        if (lockedInstallServerGrant.providerAuthorizingUserId !== observation.authorizingUserId) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge authorizing identity changed during channel selection",
            "external_app_not_authorized",
          );
        }
        const existing = await tx.select().from(externalChannelBindings).where(and(
          eq(externalChannelBindings.serverId, input.serverId),
          eq(externalChannelBindings.installId, install.id),
          eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
        )).for("update");
        if (existing.some((binding) => binding.state === "paused"
          && !conversationIds.has(binding.providerConversationId))) {
          throw new SlackPairLockSetChanged();
        }
        // The form only submits visible pairs. Preserve omitted invisible
        // rows without changing their state, consent or epochs; their historical
        // authorization is a separate audit, not an implicit delete on save.
        const visibleExistingIds = await filterChannelIdsVisibleToHuman(input.serverId,
          input.requestingUserId, existing.map(binding => binding.channelId), tx);
        // The web always resubmits every saved pair with the new one. A pair
        // that is already persisted (not revoked) is kept as-is even when it no
        // longer matches current authority, so one stale pair cannot block
        // every later save; only new or revived pairs are validated here. A
        // kept invalid pair is never re-consented, and preflight/enable re-check
        // provider membership and privacy before anything goes live.
        const persistedKeys = new Set(existing
          .filter((binding) => binding.state !== "revoked")
          .map((binding) => `${binding.channelId}:${binding.providerConversationId}`));
        const keptInvalidKeys = new Set<string>();
        for (const pair of input.pairs) {
          const key = `${pair.raftChannelId}:${pair.slackChannelId}`;
          const channel = providerById.get(pair.slackChannelId);
          if (!channel) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge channel visibility is unavailable",
              "external_app_not_authorized",
            );
          }
          const reason = slackBridgeChannelPairFailureReason(
            raftById.get(pair.raftChannelId),
            providerById.get(pair.slackChannelId),
          );
          if (!reason) continue;
          if (persistedKeys.has(key)) {
            keptInvalidKeys.add(key);
            continue;
          }
          throw new ExternalAppControlPlaneError(
            "Slack Bridge channel pairs do not match current channel authority",
            "external_app_invalid_state",
            reason,
          );
        }
        if (input.pairs.length > 0) {
          const reservedProviderBindings = await tx.select({
            serverId: externalChannelBindings.serverId,
            providerConversationId: externalChannelBindings.providerConversationId,
          }).from(externalChannelBindings).where(and(
            eq(externalChannelBindings.installId, install.id),
            inArray(
              externalChannelBindings.providerConversationId,
              input.pairs.map((pair) => pair.slackChannelId),
            ),
            inArray(externalChannelBindings.state, ["active", "paused", "quarantined"]),
          )).for("update");
          if (reservedProviderBindings.some((binding) => binding.serverId !== input.serverId)) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge channel is already assigned to another server",
              "external_app_install_conflict",
            );
          }
        }
        const desiredKeys = new Set(input.pairs.map((pair) => `${pair.raftChannelId}:${pair.slackChannelId}`));
        // A channel omitted from the authorized provider inventory is not
        // visible to this server's authorizer. Saving unrelated selections
        // must not silently revoke, replace, or disclose its existing binding.
        const hiddenPrivateKeys = new Set(existing.filter(binding => !providerById.has(binding.providerConversationId))
          .map(binding => `${binding.channelId}:${binding.providerConversationId}`));
        const protectedBindings = existing.filter(binding => visibleExistingIds.has(binding.channelId)
          && (binding.state === "active" || binding.state === "quarantined"));
        const omitsProtectedBinding = protectedBindings.some((binding) =>
          !desiredKeys.has(`${binding.channelId}:${binding.providerConversationId}`)
          && !hiddenPrivateKeys.has(`${binding.channelId}:${binding.providerConversationId}`));
        const conflictsWithProtectedBinding = input.pairs.some((pair) =>
          protectedBindings.some((binding) =>
            (binding.channelId === pair.raftChannelId
              || binding.providerConversationId === pair.slackChannelId)
            && (binding.channelId !== pair.raftChannelId
              || binding.providerConversationId !== pair.slackChannelId)));
        if (omitsProtectedBinding || conflictsWithProtectedBinding) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge active or quarantined bindings cannot be omitted or replaced by setup",
            "external_app_install_conflict",
          );
        }
        const collidesWithExistingBinding = input.pairs.some((pair) =>
          existing.some((binding) =>
            !(binding.state === "revoked" && binding.stateReason === PROVISIONING_REMOVED_REASON)
            && (binding.channelId === pair.raftChannelId
              || binding.providerConversationId === pair.slackChannelId)
            && (binding.channelId !== pair.raftChannelId
              || binding.providerConversationId !== pair.slackChannelId)));
        if (collidesWithExistingBinding) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge channel coordinates are already bound to a different pair",
            "external_app_install_conflict",
          );
        }
        for (const binding of existing) {
          const key = `${binding.channelId}:${binding.providerConversationId}`;
          if (visibleExistingIds.has(binding.channelId) && binding.state === "paused"
            && !desiredKeys.has(key) && !hiddenPrivateKeys.has(key)) {
            await tx.update(externalChannelBindings).set({
              state: "revoked",
              stateReason: PROVISIONING_REPLACED_REASON,
              bindingEpoch: binding.bindingEpoch + 1,
              updatedAt: input.now,
            }).where(and(
              eq(externalChannelBindings.id, binding.id),
              eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
              eq(externalChannelBindings.state, "paused"),
            ));
          }
        }
        for (const pair of input.pairs) {
          const protectedExact = protectedBindings.find((binding) =>
            binding.channelId === pair.raftChannelId
            && binding.providerConversationId === pair.slackChannelId);
          if (protectedExact) continue;
          if (keptInvalidKeys.has(`${pair.raftChannelId}:${pair.slackChannelId}`)) {
            // Kept, not re-consented. A paused pair drops back to pending so a
            // stale preflight pass cannot carry it into enable.
            const keptPaused = existing.find((binding) =>
              binding.state === "paused"
              && binding.channelId === pair.raftChannelId
              && binding.providerConversationId === pair.slackChannelId);
            if (keptPaused && keptPaused.stateReason !== PROVISIONING_PENDING_REASON) {
              await tx.update(externalChannelBindings).set({
                stateReason: PROVISIONING_PENDING_REASON,
                updatedAt: input.now,
              }).where(and(
                eq(externalChannelBindings.id, keptPaused.id),
                eq(externalChannelBindings.bindingEpoch, keptPaused.bindingEpoch),
                eq(externalChannelBindings.state, "paused"),
              ));
            }
            continue;
          }
          const providerChannel = providerById.get(pair.slackChannelId)!;
          const revokedExactWithOtherReason = existing.find((binding) =>
            binding.state === "revoked"
            && binding.stateReason !== PROVISIONING_REMOVED_REASON
            && binding.channelId === pair.raftChannelId
            && binding.providerConversationId === pair.slackChannelId);
          if (revokedExactWithOtherReason) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge channel pair is revoked outside provisioning teardown",
              "external_app_install_conflict",
            );
          }
          const revokedExact = existing.find((binding) =>
            binding.state === "revoked"
            && binding.stateReason === PROVISIONING_REMOVED_REASON
            && binding.channelId === pair.raftChannelId
            && binding.providerConversationId === pair.slackChannelId);
          if (revokedExact) {
            const [revived] = await tx.update(externalChannelBindings).set({
              state: "paused",
              stateReason: PROVISIONING_PENDING_REASON,
              bindingEpoch: revokedExact.bindingEpoch + 1,
              audienceRevision: revokedExact.audienceRevision,
              audienceFreshUntil: null,
              consentedByType: "human",
              consentedById: input.requestingUserId,
              consentedAt: input.now,
              updatedAt: input.now,
            }).where(and(
              eq(externalChannelBindings.id, revokedExact.id),
              eq(externalChannelBindings.bindingEpoch, revokedExact.bindingEpoch),
              eq(externalChannelBindings.state, "revoked"),
              eq(externalChannelBindings.stateReason, PROVISIONING_REMOVED_REASON),
            )).returning({ id: externalChannelBindings.id });
            if (!revived) {
              throw new ExternalAppControlPlaneError(
                "Slack Bridge removed channel pair changed during revival",
                "external_app_install_conflict",
              );
            }
            continue;
          }
          const exact = existing.find((binding) =>
            binding.state === "paused"
            && binding.channelId === pair.raftChannelId
            && binding.providerConversationId === pair.slackChannelId);
          if (exact) {
            await tx.update(externalChannelBindings).set({
              stateReason: PROVISIONING_PENDING_REASON,
              consentedByType: "human",
              consentedById: input.requestingUserId,
              consentedAt: input.now,
              updatedAt: input.now,
            }).where(and(
              eq(externalChannelBindings.id, exact.id),
              eq(externalChannelBindings.bindingEpoch, exact.bindingEpoch),
              eq(externalChannelBindings.state, "paused"),
            ));
            continue;
          }
          await tx.insert(externalChannelBindings).values({
            serverId: input.serverId,
            registrationId: bootstrap.registrationId,
            installId: install.id,
            channelId: pair.raftChannelId,
            providerConversationId: pair.slackChannelId,
            providerConversationKind: providerChannel.privacyClass === "private"
              ? "private_channel"
              : "public_channel",
            privacyClass: providerChannel.privacyClass,
            privacyFreshUntil: slackPrivacyFreshUntil(input.now),
            state: "paused",
            stateReason: PROVISIONING_PENDING_REASON,
            grantEpoch: lockedInstallServerGrant.grantEpoch,
            connectionEpoch: install.connectionEpoch,
            bindingEpoch: 1,
            audienceRevision: null,
            audienceFreshUntil: null,
            consentedByType: "human",
            consentedById: input.requestingUserId,
            consentedAt: input.now,
            createdAt: input.now,
            updatedAt: input.now,
          });
        }
          });
          break;
        } catch (error) {
          if (!(error instanceof SlackPairLockSetChanged)) throw error;
          if (lockAttempt >= 2) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge channel pairs changed during setup",
              "external_app_install_conflict",
            );
          }
        }
      }
      return load(input);
    },

    async removeChannelPairs(input) {
      requireManagerInput(input);
      const registration = await assertBootstrapRows(db, bootstrap, input.now, db);
      if (!registration) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge connect must complete before channel removal",
          "external_app_invalid_state",
        );
      }
      const authority = await loadCurrentAuthority(db, bootstrap, input.serverId);
      const install = authority.install;
      if (!install || install.state === "revoked") {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge install is unavailable for channel removal",
          "external_app_invalid_state",
        );
      }
      await requireManager(db, input);
      await db.transaction(async (tx) => {
        await lockSlackConversations(tx, input.pairs.map((pair) => ({
          registrationId: bootstrap.registrationId,
          providerAuthorityId: install.providerAuthorityId,
          providerConversationId: pair.slackChannelId,
        })));
        await requireManager(tx, input, true);
        const existing = await tx.select().from(externalChannelBindings).where(and(
          eq(externalChannelBindings.serverId, input.serverId),
          eq(externalChannelBindings.registrationId, bootstrap.registrationId),
          eq(externalChannelBindings.installId, install.id),
          eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
        )).for("update");
        const requested = input.pairs.map((pair) => existing.find((binding) =>
          binding.channelId === pair.raftChannelId
          && binding.providerConversationId === pair.slackChannelId
          && binding.bindingEpoch === pair.expectedBindingEpoch));
        if (requested.some((binding) =>
          !binding || !["active", "paused", "quarantined"].includes(binding.state))) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge channel removal coordinates are stale or unavailable",
            "external_app_install_conflict",
          );
        }
        for (const binding of requested) {
          const exact = binding!;
          const [updated] = await tx.update(externalChannelBindings).set({
            state: "revoked",
            stateReason: PROVISIONING_REMOVED_REASON,
            bindingEpoch: exact.bindingEpoch + 1,
            updatedAt: input.now,
          }).where(and(
            eq(externalChannelBindings.id, exact.id),
            eq(externalChannelBindings.bindingEpoch, exact.bindingEpoch),
            eq(externalChannelBindings.state, exact.state),
          )).returning({ id: externalChannelBindings.id });
          if (!updated) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge channel removal changed during mutation",
              "external_app_install_conflict",
            );
          }
        }
      });
      return loadWithoutProvider(input);
    },

    async disconnect(input) {
      requireManagerInput(input);
      if (!Number.isInteger(input.expectedConnectionEpoch) || input.expectedConnectionEpoch < 1) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge disconnect coordinate is invalid",
          "external_app_invalid_state",
        );
      }
      const registration = await assertBootstrapRows(db, bootstrap, input.now, db);
      if (!registration) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge is not connected",
          "external_app_invalid_state",
        );
      }
      await retryExternalAppInstallLockSet(() => db.transaction(async (tx) => {
        await requireManager(tx, input, true);
        const [candidateGrant] = await tx.select().from(externalAppServerGrants).where(and(
          eq(externalAppServerGrants.serverId, input.serverId),
          eq(externalAppServerGrants.registrationId, registration.id),
          eq(externalAppServerGrants.state, "active"),
        )).limit(1);
        if (!candidateGrant) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge server grant changed before disconnect",
            "external_app_install_conflict",
          );
        }
        const [candidateInstallServerGrant] = await tx.select()
          .from(externalAppInstallServerGrants)
          .where(and(
            eq(externalAppInstallServerGrants.serverId, input.serverId),
            eq(externalAppInstallServerGrants.registrationId, registration.id),
            eq(externalAppInstallServerGrants.serverGrantId, candidateGrant.id),
            eq(externalAppInstallServerGrants.grantEpoch, candidateGrant.grantEpoch),
            eq(externalAppInstallServerGrants.state, "active"),
          ))
          .limit(1);
        if (!candidateInstallServerGrant) throw new ExternalAppControlPlaneError(
          "Slack Bridge workspace changed before disconnect", "external_app_install_conflict");
        const scope = await lockSlackInstallConversations(tx, candidateInstallServerGrant.installId);
        const { install } = scope;
        if (install.registrationId !== registration.id || install.state === "revoked"
          || install.connectionEpoch !== input.expectedConnectionEpoch) throw new ExternalAppControlPlaneError(
          "Slack Bridge workspace changed before disconnect", "external_app_install_conflict");
        // Shared authority follows conversation, install and binding locks.
        const [lockedRegistration] = await tx.select({ id: externalAppRegistrations.id }).from(externalAppRegistrations)
          .where(and(eq(externalAppRegistrations.id, registration.id), eq(externalAppRegistrations.state, "active")))
          .for("update").limit(1);
        const [grant] = await tx.select().from(externalAppServerGrants).where(and(
          eq(externalAppServerGrants.id, candidateGrant.id), eq(externalAppServerGrants.serverId, input.serverId),
          eq(externalAppServerGrants.registrationId, registration.id), eq(externalAppServerGrants.state, "active"),
          eq(externalAppServerGrants.grantEpoch, candidateGrant.grantEpoch),
        )).for("update").limit(1);
        if (!lockedRegistration || !grant) throw new ExternalAppControlPlaneError(
          "Slack Bridge server grant changed before disconnect", "external_app_install_conflict");
        const [installServerGrant] = await tx.select().from(externalAppInstallServerGrants).where(and(
        eq(externalAppInstallServerGrants.id, candidateInstallServerGrant.id),
        eq(externalAppInstallServerGrants.installId, install.id),
        eq(externalAppInstallServerGrants.serverId, input.serverId),
        eq(externalAppInstallServerGrants.registrationId, registration.id),
        eq(externalAppInstallServerGrants.serverGrantId, grant.id),
        eq(externalAppInstallServerGrants.grantEpoch, grant.grantEpoch),
        eq(externalAppInstallServerGrants.state, "active"),
        )).for("update").limit(1);
        if (!installServerGrant) {
          throw new SlackInstallLockSetChanged();
        }

        await tx.update(externalHumanIdentityLinks).set({
          state: "revoked",
          revokedAt: input.now,
          revokeReason: PROVISIONING_UNBOUND_REASON,
          updatedAt: input.now,
        }).where(and(
          eq(externalHumanIdentityLinks.serverId, input.serverId),
          eq(externalHumanIdentityLinks.installId, install.id),
          eq(externalHumanIdentityLinks.state, "active"),
        ));
        const bindings = scope.bindings.filter(binding => binding.serverId === input.serverId
          && binding.registrationId === registration.id && binding.connectionEpoch === install.connectionEpoch);
        for (const binding of bindings) {
          const [revoked] = await tx.update(externalChannelBindings).set({
            state: "revoked",
            stateReason: PROVISIONING_UNBOUND_REASON,
            bindingEpoch: binding.bindingEpoch + 1,
            updatedAt: input.now,
          }).where(and(
            eq(externalChannelBindings.id, binding.id),
            eq(externalChannelBindings.state, binding.state),
            eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
          )).returning({ id: externalChannelBindings.id });
          if (!revoked) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge binding changed during disconnect",
              "external_app_install_conflict",
            );
          }
        }
        const [revokedInstallServerGrant] = await tx.update(externalAppInstallServerGrants).set({
          state: "revoked",
          revokedAt: input.now,
          revokeReason: PROVISIONING_UNBOUND_REASON,
          updatedAt: input.now,
        }).where(and(
          eq(externalAppInstallServerGrants.id, installServerGrant.id),
          eq(externalAppInstallServerGrants.state, "active"),
          eq(externalAppInstallServerGrants.grantEpoch, installServerGrant.grantEpoch),
        )).returning({ id: externalAppInstallServerGrants.id });
        if (!revokedInstallServerGrant) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge server workspace authority changed during disconnect",
            "external_app_install_conflict",
          );
        }
        const otherServerGrants = await tx.select({ id: externalAppInstallServerGrants.id })
          .from(externalAppInstallServerGrants)
          .where(and(
            eq(externalAppInstallServerGrants.installId, install.id),
            eq(externalAppInstallServerGrants.state, "active"),
          ))
          .for("update")
          .limit(1);
        if (otherServerGrants.length === 0) {
          const [credential] = await tx.select().from(externalAppCredentials)
            .where(eq(externalAppCredentials.installId, install.id)).for("update").limit(1);
          if (credential && credential.state !== "revoked") {
            const [revokedCredential] = await tx.update(externalAppCredentials).set({
              state: "revoked",
              leaseOwner: null,
              leaseExpiresAt: null,
              revokedAt: input.now,
              updatedAt: input.now,
            }).where(and(
              eq(externalAppCredentials.id, credential.id),
              eq(externalAppCredentials.state, credential.state),
              eq(externalAppCredentials.credentialRevision, credential.credentialRevision),
            )).returning({ id: externalAppCredentials.id });
            if (!revokedCredential) {
              throw new ExternalAppControlPlaneError(
                "Slack Bridge credential changed during disconnect",
                "external_app_install_conflict",
              );
            }
          }
          const [revokedInstall] = await tx.update(externalAppInstalls).set({
            state: "revoked",
            stateReason: PROVISIONING_UNBOUND_REASON,
            connectionEpoch: install.connectionEpoch + 1,
            disconnectedAt: input.now,
            installGrantRenewalLeaseOwner: null,
            installGrantRenewalLeaseExpiresAt: null,
            installGrantRenewalNextAttemptAt: null,
            updatedAt: input.now,
          }).where(and(
            eq(externalAppInstalls.id, install.id),
            eq(externalAppInstalls.state, install.state),
            eq(externalAppInstalls.connectionEpoch, install.connectionEpoch),
          )).returning({ id: externalAppInstalls.id });
          if (!revokedInstall) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge install changed during disconnect",
              "external_app_install_conflict",
            );
          }
        }
        const [revokedGrant] = await tx.update(externalAppServerGrants).set({
          state: "revoked",
          revokedAt: input.now,
          revokeReason: PROVISIONING_UNBOUND_REASON,
          updatedAt: input.now,
        }).where(and(
          eq(externalAppServerGrants.id, grant.id),
          eq(externalAppServerGrants.state, "active"),
          eq(externalAppServerGrants.grantEpoch, grant.grantEpoch),
        )).returning({ id: externalAppServerGrants.id });
        if (!revokedGrant) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge server grant changed during disconnect",
            "external_app_install_conflict",
          );
        }
        const clientId = `slack-bridge:${bootstrap.registrationId}`;
        const [client] = await tx.select({ id: oauthClients.id }).from(oauthClients)
          .where(eq(oauthClients.clientId, clientId)).limit(1);
        if (client) {
          await tx.update(oauthClientInstalls).set({
            status: "suspended",
            updatedAt: input.now,
          }).where(and(
            eq(oauthClientInstalls.serverId, input.serverId),
            eq(oauthClientInstalls.clientId, client.id),
            eq(oauthClientInstalls.status, "active"),
          ));
        }
      }));
      return loadWithoutProvider(input);
    },

    async retryDelivery(request) {
      await requireManager(db, request);
      const authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      const binding = authority.bindings.find((candidate) => candidate.id === request.bindingId
        && candidate.bindingEpoch === request.bindingEpoch && candidate.state === "active");
      if (!binding || !currentInstall(authority)) {
        throw new ExternalAppControlPlaneError("Slack Bridge binding changed before retry", "external_app_invalid_state");
      }
      await db.transaction(async (tx) => {
        await requireManager(tx, request, true);
        // A retry authorizes one attempt only; the worker rechecks live install,
        // binding, message and credential authority before any provider I/O.
        const [current] = await tx.select({ id: externalChannelBindings.id }).from(externalChannelBindings).where(and(
          eq(externalChannelBindings.id, binding.id),
          eq(externalChannelBindings.serverId, request.serverId),
          eq(externalChannelBindings.bindingEpoch, request.bindingEpoch),
          eq(externalChannelBindings.state, "active"),
        )).for("update").limit(1);
        const [head] = current ? await listSlackPairHeads(tx, [{
          bindingId: binding.id, bindingEpoch: binding.bindingEpoch,
        }]) : [];
        if (!current || head?.deliveryId !== request.deliveryId || !await recordExternalDeliveryRetryDecision({
          executor: tx,
          bindingId: head.bindingId,
          bindingEpoch: head.bindingEpoch,
          deliveryId: request.deliveryId,
          expectedProviderAttempts: request.expectedProviderAttempts,
          actorId: request.requestingUserId,
          now: request.now,
        })) {
          throw new ExternalAppControlPlaneError("Slack Bridge delivery is no longer the stalled head", "external_app_invalid_state");
        }
      });
      return load({ ...request, includeDeliveryHealth: true });
    },

    async replayInbound(request) {
      await requireManager(db, request);
      const initial = await loadCurrentAuthority(db, bootstrap, request.serverId);
      const provider = activeProviderAuthority(initial, request.now);
      const grant = currentGrant(initial, bootstrap);
      const association = initial.installServerGrant;
      const binding = initial.bindings.find((row) => row.id === request.bindingId
        && row.bindingEpoch === request.bindingEpoch && row.state === "active");
      if (!provider || !grant || !association || !binding) {
        throw new ExternalAppControlPlaneError("Slack Bridge replay authority is unavailable", "external_app_not_authorized");
      }
      // The existing read path checks both Raft visibility and fresh Slack
      // authorizer evidence before exposing any held event identifier.
      const visible = await load({ ...request, includeInboundRecovery: true });
      if (!visible.snapshot.rawHealth?.bindings.some((item) => item.id === binding.id
        && item.bindingEpoch === binding.bindingEpoch)) {
        throw new ExternalAppControlPlaneError("Slack Bridge event is not available for replay", "external_app_not_authorized");
      }
      await dependencies.testOnlyBeforeReplay?.();
      const [partition] = await db.select({ id: slackVerifiedIngressPartitions.id }).from(slackVerifiedIngressPartitions).where(and(
        eq(slackVerifiedIngressPartitions.appRegistrationId, bootstrap.registrationId),
        eq(slackVerifiedIngressPartitions.environment, bootstrap.environment),
        eq(slackVerifiedIngressPartitions.providerAuthorityId, provider.providerAuthorityId),
        eq(slackVerifiedIngressPartitions.partitionKind, "conversation"),
        eq(slackVerifiedIngressPartitions.providerConversationId, binding.providerConversationId),
      )).limit(1);
      if (!partition) throw new ExternalAppControlPlaneError("Slack Bridge event is not available for replay", "external_app_invalid_state");
      let replayCount = 0;
      const replayedIds: string[] = [];
      // Bound a batch to 100 independently committed transactions. Each
      // transaction selects one matching held event and rechecks authority.
      // Repeating the action advances through later events without trusting
      // event IDs from the first page.
      for (let i = 0; i < (request.reason ? 100 : 1); i++) {
        let candidateId: string | null = null;
        const replayed = await replayHeldSlackIngress({ db, partitionId: partition.id,
          ...(request.eventId ? { eventId: request.eventId } : { reason: request.reason }),
          excludeEventIds: replayedIds,
          now: () => currentDate(), lockRequester: (tx) => requireManager(tx, request, true), authorize: async (tx, partition, event) => {
            if (partition.partitionKind !== "conversation" || partition.appRegistrationId !== bootstrap.registrationId
              || partition.environment !== bootstrap.environment || partition.providerAuthorityId !== provider.providerAuthorityId
              || partition.providerConversationId !== binding.providerConversationId || event.providerAppId !== provider.providerAppId) return null;
            const [lockedInstall] = await tx.select().from(externalAppInstalls).where(and(
              eq(externalAppInstalls.id, provider.installId), eq(externalAppInstalls.registrationId, bootstrap.registrationId),
              eq(externalAppInstalls.state, "active"), eq(externalAppInstalls.connectionEpoch, provider.connectionEpoch),
              eq(externalAppInstalls.credentialRevision, provider.credentialRevision),
              eq(externalAppInstalls.providerAuthorityId, provider.providerAuthorityId),
            )).for("update").limit(1);
            if (!lockedInstall) return null;
            const [lockedBinding] = await tx.select().from(externalChannelBindings).where(and(
              eq(externalChannelBindings.id, binding.id), eq(externalChannelBindings.serverId, request.serverId),
              eq(externalChannelBindings.installId, provider.installId), eq(externalChannelBindings.state, "active"),
              eq(externalChannelBindings.bindingEpoch, request.bindingEpoch),
              eq(externalChannelBindings.connectionEpoch, provider.connectionEpoch),
              eq(externalChannelBindings.channelId, binding.channelId),
              eq(externalChannelBindings.providerConversationId, binding.providerConversationId),
            )).for("update").limit(1);
            if (!lockedBinding) return null;
            const [registration] = await tx.select().from(externalAppRegistrations)
              .where(eq(externalAppRegistrations.id, bootstrap.registrationId)).for("share").limit(1);
            if (!registration || !registrationMatchesBootstrapIdentity(registration, bootstrap)
              || registration.capabilityManifestHash !== bootstrap.capabilityManifestHash) return null;
            const current = await resolveExternalInstallServerGrantAuthority(tx, {
              installId: provider.installId, serverId: request.serverId, registrationId: bootstrap.registrationId,
            }, { lock: true });
            if (!current.current || current.grant.id !== grant.id || current.grant.grantEpoch !== grant.grantEpoch
              || current.association.id !== association.id
              || current.association.providerAuthorizingUserId !== association.providerAuthorizingUserId
              || !grantMatchesCurrentRegistration(current.grant, registration)
              || !await canUserAccessChannel(binding.channelId, request.requestingUserId, asServerId(request.serverId), { executor: tx })) return null;
            candidateId = event.id;
            return { kind: "human" as const, id: request.requestingUserId };
          } });
        if (!replayed) break;
        if (!candidateId) throw new Error("Slack Bridge replay omitted its selected event");
        replayedIds.push(candidateId);
        replayCount++;
      }
      if (!replayCount) throw new ExternalAppControlPlaneError("Slack Bridge event changed before replay", "external_app_invalid_state");
      return load({ ...request, includeDeliveryHealth: true, includeInboundRecovery: true });
    },

    async runPreflight(request) {
      await requireManager(db, request);
      const registration = await assertBootstrapRows(db, bootstrap, request.now, db);
      if (!registration) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge connect must complete before preflight",
          "external_app_invalid_state",
        );
      }
      let authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      const observation = await observeProvider(dependencies.provider, authority, request.now);
      for (const binding of authority.bindings) {
        if ((binding.state === "paused" || binding.state === "active")
          && observation.channels.some(channel => channel.id === binding.providerConversationId
            && channel.isMember === true)) {
          await recordConversationAuthority({
            db,
            provider: dependencies.provider,
            avatarMaterializer: dependencies.avatarMaterializer,
            serverId: request.serverId,
            now: request.now,
            authority,
            binding,
          });
        }
      }
      authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      const audiences = await audienceStatuses(db, authority.bindings, request.now, observation);
      const preflight = preflightFor({
        authority,
        bootstrap,
        audiences,
        oauthStatus: observation.oauthStatus,
      });
      await markPreflightResult({ db, request, authority, passed: preflight.state === "passed" });
      authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      return responseFor({ db, bootstrap, authority, providerObservation: observation, request });
    },

    async enable(request) {
      await requireManager(db, request);
      const registration = await assertBootstrapRows(db, bootstrap, request.now, db);
      if (!registration) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge connect must complete before enable",
          "external_app_invalid_state",
        );
      }
      let authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      const observation = await observeProvider(dependencies.provider, authority, request.now);
      for (const binding of authority.bindings) {
        if ((binding.state === "paused" || binding.state === "active")
          && observation.channels.some(channel => channel.id === binding.providerConversationId
            && channel.isMember === true)) {
          await recordConversationAuthority({
            db,
            provider: dependencies.provider,
            avatarMaterializer: dependencies.avatarMaterializer,
            serverId: request.serverId,
            now: request.now,
            authority,
            binding,
          });
        }
      }
      authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      const installGrantObservation = await observeInstallGrant(
        dependencies.provider,
        authority,
        request.now,
      );
      const audiences = await audienceStatuses(db, authority.bindings, request.now, observation);
      const preflight = preflightFor({
        authority,
        bootstrap,
        audiences,
        oauthStatus: observation.oauthStatus,
      });
      const repairingActiveBindings = authority.bindings.length > 0
        && authority.bindings.every((binding) => binding.state === "active");
      const activatingPausedBindings = authority.bindings.length > 0
        && authority.bindings.some((binding) => binding.state === "paused")
        && authority.bindings.every((binding) =>
          binding.state === "active"
          || (binding.state === "paused" && binding.stateReason === PROVISIONING_PASSED_REASON));
      if (
        preflight.state !== "passed"
        || (!repairingActiveBindings && !activatingPausedBindings)
        || installGrantObservation.kind !== "fact"
        || !currentInstall(authority)
        || classifySlackInstallGrantObservation(
          currentInstall(authority)!,
          installGrantObservation.fact,
        ) === "mismatch"
      ) {
        if (!repairingActiveBindings) {
          await markPreflightResult({ db, request, authority, passed: false });
        }
        authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
        return responseFor({ db, bootstrap, authority, providerObservation: observation, request });
      }
      const install = currentInstall(authority)!;
      const installServerGrant = authority.installServerGrant!;
      const credential = authority.credential!;
      const installGrant = installGrantObservation.fact;
      const observedGrantHash = slackBridgeInstallGrantHash(installGrant);
      const expectedBindings = new Map(authority.bindings.map((binding) => [binding.id, binding]));
      if (SLACK_BRIDGE_AGENT_MENTION_BOT_SCOPES.every((scope) => (
        install.installedScopes.includes(scope)
      ))) {
        const providerAuthority = activeProviderAuthority(authority, request.now);
        if (!providerAuthority) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge provider authority changed before Agent mention reconciliation",
            "external_app_invalid_state",
          );
        }
        // Agent-mention usergroup sync is an additive capability: failures
        // (Slack free plan without usergroups, admin-only usergroup policy,
        // handle collision on all candidates) degrade to "agent temporarily
        // not @-able from Slack" — they must never block channel binding,
        // which would starve core message sync. The 5-minute lifecycle tick
        // retries this reconciliation on its own schedule.
        try {
          const {
            candidates: mentionCandidates,
            humanCandidates: humanMentionCandidates,
            workspaceHumanCandidates,
          } = await listSlackBridgeMentionCandidates(
            db,
            request.serverId,
            authority.bindings,
          );
          if (!dependencies.provider.reconcileAgentMentionHandles) {
            console.warn("[SlackBridge] Agent mention reconciliation unavailable", {
              serverId: request.serverId,
            });
          } else {
            const mentionReconciliation = await dependencies.provider.reconcileAgentMentionHandles(
              providerAuthority,
              {
                serverId: request.serverId,
                candidates: mentionCandidates,
                humanCandidates: workspaceHumanCandidates,
              },
            );
            const mentionSync = slackBridgeMentionSyncState({
              reconciled: mentionReconciliation,
              candidates: mentionCandidates,
              humanCandidates: humanMentionCandidates,
              observedAt: request.now,
            });
            if (mentionSync?.state === "degraded") {
              console.warn("[SlackBridge] Agent mention reconciliation degraded", {
                serverId: request.serverId,
                kind: mentionReconciliation.kind,
                slackError: mentionSync.slackError,
                expected: mentionSync.expected,
                actual: mentionSync.actual,
                ...(mentionReconciliation.kind === "fact"
                  ? { failures: mentionReconciliation.fact.failures }
                  : {}),
              });
            }
            if (mentionSync) {
              await db.update(externalAppInstallServerGrants)
                .set({ agentMentionSync: mentionSync })
                .where(and(
                  eq(externalAppInstallServerGrants.installId, install.id),
                  eq(externalAppInstallServerGrants.serverId, request.serverId),
                  eq(externalAppInstallServerGrants.grantEpoch, installServerGrant.grantEpoch),
                  eq(externalAppInstallServerGrants.state, "active"),
                ));
            }
          }
        } catch (error) {
          console.warn("[SlackBridge] Agent mention reconciliation threw", {
            serverId: request.serverId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await db.transaction(async (tx) => {
        await requireManager(tx, request, true);
        const [lockedInstall] = await tx.select().from(externalAppInstalls).where(and(
          eq(externalAppInstalls.id, install.id),
          eq(externalAppInstalls.registrationId, bootstrap.registrationId),
          eq(externalAppInstalls.connectionEpoch, install.connectionEpoch),
          eq(externalAppInstalls.credentialRevision, install.credentialRevision),
          eq(externalAppInstalls.state, "active"),
        )).for("update").limit(1);
        const [lockedInstallServerGrant] = await tx.select()
          .from(externalAppInstallServerGrants)
          .where(and(
            eq(externalAppInstallServerGrants.id, installServerGrant.id),
            eq(externalAppInstallServerGrants.installId, install.id),
            eq(externalAppInstallServerGrants.serverId, request.serverId),
            eq(externalAppInstallServerGrants.registrationId, bootstrap.registrationId),
            eq(externalAppInstallServerGrants.serverGrantId, installServerGrant.serverGrantId),
            eq(externalAppInstallServerGrants.grantEpoch, installServerGrant.grantEpoch),
            eq(externalAppInstallServerGrants.state, "active"),
          ))
          .for("update")
          .limit(1);
        const [lockedGrant] = await tx.select().from(externalAppServerGrants).where(and(
          eq(externalAppServerGrants.id, installServerGrant.serverGrantId),
          eq(externalAppServerGrants.serverId, request.serverId),
          eq(externalAppServerGrants.registrationId, bootstrap.registrationId),
          eq(externalAppServerGrants.state, "active"),
          eq(externalAppServerGrants.grantEpoch, installServerGrant.grantEpoch),
        )).for("update").limit(1);
        const [lockedCredential] = await tx.select().from(externalAppCredentials).where(and(
          eq(externalAppCredentials.id, credential.id),
          eq(externalAppCredentials.installId, install.id),
          eq(externalAppCredentials.state, "active"),
          eq(externalAppCredentials.credentialRevision, install.credentialRevision),
          or(
            isNull(externalAppCredentials.expiresAt),
            gt(externalAppCredentials.expiresAt, request.now),
          ),
        )).for("update").limit(1);
        if (
          !lockedInstall
          || !lockedInstallServerGrant
          || !lockedGrant
          || !lockedCredential
          || lockedGrant.grantedManifestVersion !== bootstrap.capabilityManifestVersion
          || lockedGrant.grantedManifestHash !== bootstrap.capabilityManifestHash
          || !exactStrings(lockedGrant.grantedCapabilities, bootstrap.requiredCapabilities)
        ) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge OAuth authority changed before enable",
            "external_app_invalid_state",
          );
        }
        const currentBindings = await tx.select().from(externalChannelBindings).where(and(
          eq(externalChannelBindings.serverId, request.serverId),
          eq(externalChannelBindings.installId, install.id),
          eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
          or(
            isNull(externalChannelBindings.stateReason),
            notInArray(externalChannelBindings.stateReason, [
              PROVISIONING_REPLACED_REASON,
              PROVISIONING_REMOVED_REASON,
            ]),
          ),
        )).for("update");
        if (
          currentBindings.length !== authority.bindings.length
          || currentBindings.some((binding) => {
            const expected = expectedBindings.get(binding.id);
            return !expected
              || (repairingActiveBindings
                ? binding.state !== "active" || binding.stateReason !== null
                : expected.state === "active"
                  ? binding.state !== "active" || binding.stateReason !== null
                  : binding.state !== "paused" || binding.stateReason !== PROVISIONING_PASSED_REASON)
              || binding.channelId !== expected.channelId
              || binding.providerConversationId !== expected.providerConversationId
              || binding.privacyClass !== expected.privacyClass
              || binding.bindingEpoch !== expected.bindingEpoch
              || binding.audienceRevision !== expected.audienceRevision
              || binding.connectionEpoch !== install.connectionEpoch
              || binding.grantEpoch !== installServerGrant.grantEpoch;
          })
        ) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge preflight authority changed before enable",
            "external_app_invalid_state",
          );
        }
        // A scope set that drifted on the provider side (Slack app scopes
        // changed without a Raft re-OAuth) is a stale install record, not a
        // failed grant. Reconcile installed_scopes + scope_revision under the
        // install row lock in this same transaction; bumping scope_revision
        // invalidates receipts on every server sharing the install, and each
        // writes a fresh one on its next renewal tick.
        const grantClassification = classifySlackInstallGrantObservation(lockedInstall, installGrant);
        if (grantClassification === "mismatch") {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge install grant changed before enable",
            "external_app_invalid_state",
          );
        }
        let effectiveInstall = lockedInstall;
        if (grantClassification === "scope_drift") {
          const nextScopeRevision = await applySlackInstallGrantScopeDrift({
            tx,
            install: lockedInstall,
            grant: installGrant,
            now: request.now,
            source: "enable",
          });
          if (nextScopeRevision === null) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge install authority changed before enable",
              "external_app_invalid_state",
            );
          }
          effectiveInstall = {
            ...lockedInstall,
            installedScopes: canonicalStrings(installGrant.grantedScopes),
            scopeRevision: nextScopeRevision,
          };
        }
        const receipts = await tx.select().from(externalAppInstallGrantReceipts).where(and(
          eq(externalAppInstallGrantReceipts.registrationId, bootstrap.registrationId),
          eq(externalAppInstallGrantReceipts.installId, lockedInstall.id),
        )).orderBy(desc(externalAppInstallGrantReceipts.receiptRevision)).limit(2).for("update");
        const latestReceipt = receipts[0] ?? null;
        const currentReceipt = latestReceipt
          && latestReceipt.status === "valid"
          && latestReceipt.expiresAt > request.now
          && latestReceipt.connectionEpoch === lockedInstall.connectionEpoch
          && latestReceipt.scopeRevision === effectiveInstall.scopeRevision
          && latestReceipt.credentialRevision === lockedInstall.credentialRevision
          && latestReceipt.providerAppId === installGrant.providerAppId
          && latestReceipt.providerAuthorityId === installGrant.providerAuthorityId
          && latestReceipt.botUserId === installGrant.botUserId
          && latestReceipt.providerBotId === installGrant.providerBotId
          && exactStrings(latestReceipt.grantedScopes, installGrant.grantedScopes)
          && latestReceipt.grantHash === observedGrantHash;
        if (!currentReceipt) {
          await tx.insert(externalAppInstallGrantReceipts).values({
            registrationId: bootstrap.registrationId,
            installId: lockedInstall.id,
            receiptRevision: (latestReceipt?.receiptRevision ?? 0) + 1,
            connectionEpoch: lockedInstall.connectionEpoch,
            scopeRevision: effectiveInstall.scopeRevision,
            credentialRevision: lockedInstall.credentialRevision,
            providerAppId: installGrant.providerAppId,
            providerAuthorityId: installGrant.providerAuthorityId,
            botUserId: installGrant.botUserId,
            providerBotId: installGrant.providerBotId,
            grantedScopes: canonicalStrings(installGrant.grantedScopes),
            grantHash: observedGrantHash,
            observationSource: "token_introspection",
            status: "valid",
            errorCode: null,
            observedAt: request.now,
            expiresAt: new Date(
              request.now.getTime() + SLACK_BRIDGE_INSTALL_GRANT_FRESHNESS_MS,
            ),
            createdAt: request.now,
          });
        }
        if (lockedInstall.providerBotId === null && grantClassification === "match") {
          await tx.update(externalAppInstalls).set({
            providerBotId: installGrant.providerBotId,
            lastVerifiedAt: request.now,
            updatedAt: request.now,
          }).where(and(
            eq(externalAppInstalls.id, lockedInstall.id),
            eq(externalAppInstalls.connectionEpoch, lockedInstall.connectionEpoch),
            eq(externalAppInstalls.scopeRevision, lockedInstall.scopeRevision),
            eq(externalAppInstalls.credentialRevision, lockedInstall.credentialRevision),
            isNull(externalAppInstalls.providerBotId),
          ));
        }
        for (const binding of currentBindings) {
          if (await currentConversationAuthorityStatus(tx, binding, request.now) !== "matched") {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge audience authority changed before enable",
              "external_app_invalid_state",
            );
          }
          await tx.update(externalChannelBindings).set({
            privacyFreshUntil: slackPrivacyFreshUntil(request.now),
            updatedAt: request.now,
          }).where(and(
            eq(externalChannelBindings.id, binding.id),
            eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
            eq(externalChannelBindings.connectionEpoch, binding.connectionEpoch),
          ));
        }
        // Activation and delivery readiness are one durable transition. A
        // worker may poll an active binding before its first message exists;
        // the zero-position partition makes that state ordinary idleness.
        await tx.insert(externalDeliveryPartitions).values(
          currentBindings.map((binding) => ({
            bindingId: binding.id,
            bindingEpoch: binding.bindingEpoch,
          })),
        ).onConflictDoNothing({
          target: [
            externalDeliveryPartitions.bindingId,
            externalDeliveryPartitions.bindingEpoch,
          ],
        });
        if (activatingPausedBindings) {
          for (const binding of currentBindings) {
            await tx.update(externalChannelBindings).set({
              state: "active",
              stateReason: null,
              updatedAt: request.now,
            }).where(and(
              eq(externalChannelBindings.id, binding.id),
              eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
              eq(externalChannelBindings.state, "paused"),
              eq(externalChannelBindings.stateReason, PROVISIONING_PASSED_REASON),
            ));
          }
        }
      });
      authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      return responseFor({ db, bootstrap, authority, providerObservation: observation, request });
    },

    // A fresh OAuth exchange on an already-connected workspace pauses every
    // binding at the new connection epoch (`provider_reauthorized_review_required`).
    // The manager who just re-authorized has reviewed the connection, so
    // re-confirm the same pairs and run them through the ordinary
    // channel-pairs → preflight → enable path. Every check still applies; a
    // pair that fails preflight stays paused. Slack stops retrying a rejected
    // event within minutes, so this runs in the OAuth callback rather than
    // waiting for a separate manual step.
    async resumeAfterReauthorization(request) {
      requireManagerInput(request);
      const authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      if (authority.install?.state !== "active") return null;
      const reauthorized = authority.bindings.some((binding) =>
        binding.state === "paused" && binding.stateReason === PROVIDER_REAUTHORIZED_REASON);
      if (!reauthorized) return null;
      const pairs = authority.bindings
        .filter((binding) => binding.state === "active" || binding.state === "paused" || binding.state === "quarantined")
        .map((binding) => ({ raftChannelId: binding.channelId, slackChannelId: binding.providerConversationId }));
      await controlPlane.saveChannelPairs({ ...request, pairs });
      await controlPlane.runPreflight(request);
      return controlPlane.enable(request);
    },
  };
  return controlPlane;
}

export function slackBridgeProvisioningManifestHash(input: {
  oauthRedirectUri: string;
  eventsRequestUrl: string;
}): string {
  return sha256(JSON.stringify({
    version: 1,
    provider: "slack",
    oauthRedirectUri: input.oauthRedirectUri,
    eventsRequestUrl: input.eventsRequestUrl,
    scopes: [...SLACK_BRIDGE_ACTIVE_BOT_SCOPES],
  }));
}

export const SLACK_BRIDGE_PROVISIONING_CAPABILITIES = [
  "channel_events",
  "external_projection",
  "private_audience",
] as const;

/** Classifies existing selection checks without adding new admission rules. */
export function slackBridgeChannelPairFailureReason(
  raftChannel: { type: string } | undefined,
  providerChannel: { privacyClass: "public" | "private"; isMember?: boolean } | undefined,
): "channel_unavailable" | "not_member" | null {
  if (!raftChannel || !providerChannel) return "channel_unavailable";
  if (providerChannel.isMember !== true) return "not_member";
  // Cross-class pairing is allowed: each platform keeps its own visibility.
  return null;
}
