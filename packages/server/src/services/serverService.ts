import { agentFindableBy } from "./agentMemberListPolicy";
import { JointActorUnavailableError, lockJointUsersFirst, prepareJointHumanMembershipMirror } from "./jointHumanMembershipMirror";
import { NotificationLevelError, setLevel as setNotificationLevel } from "./notifications/settings";
import { archiveAssistantsOfDepartingOwner, type DepartedOwnerAssistants } from "./assistantDepartureService";
import { removeWeChatBridgeOfDeletedServer } from "./wechatBridgeCleanup";
import { ensureAllChannelHumanRows } from "./allChannelMembership";
import { kickAgentRuntimeProvisionWorker } from "./agentRuntimeProvisionService";
import { revokeSocketAccess } from "../socket/accessRevocation";
import { broadcastAgentCredentialRevocation } from "../replicaRouter";
import { ISSUER_LEFT_SERVER_REVOKE_REASON, revokeAgentCredentialsIssuedBy } from "./agentCredentialService";
import { clearComputerOwnershipOf } from "./computerOwnerService";
import { revokeComputerKeyInTransaction, type DetachedComputer } from "./computerKeyRevocation";
import { findAgentsBoundToMachines } from "./computerAgents";
import { closeDeviceSessionKeys } from "./deviceSessionKeys";
import { createHash } from "crypto";
import { eq, and, asc, isNull, inArray, sql, count, ne, or, lt } from "drizzle-orm";
import { headcountAgent } from "./agentMemberListPolicy";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { sqlUuidOrNull } from "../db/sqlUuid";
import { CURRENT_CONTRACT_VERSION } from "./serverSetupStateService";
import { computers, servers, serverMembers, serverMembershipDepartures, serverMemberRoleAuditEvents, serverAgentMembers, users, channels, channelHumans, messages, agents, subscriptions, threadFollows, oauthAccessTokens, oauthUserConsents, oauthLinkPreviewDeclines, jointChannelServers, userNotificationLevelVersions } from "../db/schema";
import { emitAppFacingMemberEvents, kickAppNotificationDelivery } from "./appNotificationDeliveryService";
import { ALL_CHANNEL_TEAM_THRESHOLD, DEPRECATED_GRAVATAR_HASH, canTransitionServerRole, currentDate, hasServerCapability, isAdminOrOwner, isOwnerRole, isRaftThemeId, MEMBER_REMOVAL_IMPACT_MAX_COMPUTER_NAMES, parseChannelSideLayout, type ChannelSideLayout, type MemberRemovalImpact, type RaftThemeId, type ServerRole } from "@botiverse/raft-shared";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace";
import * as serverAgreementService from "./serverAgreementService";
import { refreshSubscriptionForServerIfStale } from "./billingService";
import { assertHumanCapacityAvailable, getServerBillingEntitlement, getServerBillingUsage } from "./planService";
import { evaluateFeatureFlag, ONBOARDING_OWNER_WIZARD_FEATURE_FLAG_KEY } from "./featureFlagService";
import { autoInstallOfficialAppsForProvisionedServer } from "./officialAppAutoInstallService";
import { hasServerCompletedSetupForProjection } from "./serverSetupCompletionService";
import { newAuditOperationId, recordIntegrationAuditEvent, recordSystemAgentRoleGrant, serverAuditContextMetadata, type IntegrationAuditSource } from "./integrationAuditService";
import { recordChannelMembershipsEnded, type ChannelMembershipEndAudit, type EndedChannelMembership } from "./channelMembershipAudit";
import { announceSeatJoinBlocksForSeatChange } from "./listChangedRealtime";
import { assertHumanAccountRoom } from "./deploymentUserLimit";

export interface SidebarOrderPreferences {
  channelOrder: string[];
  agentOrder: string[];
  dmOrder: string[];
  channelSortMode: "manual" | "recent" | "az";
  jointChannelSortMode: "manual" | "recent" | "az";
  dmSortMode: "manual" | "recent" | "az";
  pinnedSortMode: "manual" | "recent" | "az";
  pinned: SidebarPinnedRef[] | null;
  pinnedChannelIds: string[];
  pinnedAgentIds: string[];
  pinnedOrder: string[];
  hiddenDmIds: string[];
  channelPanelTabOrder: string[];
  agentPanelTabOrder: string[];
  /** The channel side sections' layout (task #165); null when never saved, or when what is stored doesn't parse. */
  channelSideLayout: ChannelSideLayout | null;
  customSections: SidebarCustomSection[];
  sectionOrder: string[];
  sectionPlacements: SidebarSectionPlacement[];
  sectionsVersion: number;
  pinnedVersion: number;
}

export interface SidebarCustomSection {
  id: string;
  name: string;
  emoji: string | null;
  sortMode: "manual" | "recent" | "az";
}

export interface SidebarSectionPlacement {
  kind: "channel" | "agent";
  id: string;
  sectionId: string;
  position: number;
}

export interface SidebarPinnedRef {
  kind: "channel" | "agent" | "human";
  id: string;
}

export interface ServerSwitcherOrderPreferences {
  serverOrder: string[];
  serverOrderVersion: number;
}

export interface MemberOnboardingPreferences {
  setupModalReminderOptOut: boolean;
  dismissedAddComputerStepAt: Date | null;
  dismissedCreateAgentStepAt: Date | null;
  dismissedInviteStepAt: Date | null;
  dismissedCommunityStepAt: Date | null;
  dismissedNotificationStepAt: Date | null;
  onboardingWizardCurrentStep: "add-computer" | "detect-runtime" | "create-agent" | "referral-source" | "invite-teammates" | "join-community" | "enable-notifications" | "complete" | null;
  onboardingDmSentAt: Date | null;
  onboardingDmSentByAgentId: string | null;
  onboardingOwnerOpenerV2SentAt: Date | null;
  onboardingOwnerOpenerV2SentByAgentId: string | null;
  onboardingOwnerOpenerV2MessageIds: string[];
  onboardingOwnerOpenerV2Version: string | null;
  onboardingOwnerOpenerV2Topics: string[];
  crossChannelHintShownAt: Date | null;
  allChannelUnlockInstructionSentAt: Date | null;
}

export interface ServerOnboardingSettings {
  onboardingAgentId: string | null;
  agentAllChannelGreetingEnabled: boolean;
  onboardingWizardEnabled: boolean;
}

export type ServerPushMode = "all" | "mentions" | "none";

export interface MemberNotificationPreferences {
  serverPushMuted: boolean;
  serverPushMentionsOnly: boolean;
  serverPushMode: ServerPushMode;
  prefsVersion: number;
  changed: boolean;
}

export interface ServerTranslationSettings {
  translationEnabled: boolean;
}

export interface ServerProfileUpdates {
  name?: string;
  avatarUrl?: string | null;
  hideHumansFromMembers?: boolean;
}

/** Who changed the server profile; recorded as `server.profile_updated` in the same commit. */
export interface ServerProfileAuditContext {
  actor: { type: "human" | "agent"; id: string };
  source: IntegrationAuditSource;
  /** The acting agent's live server role (agents only). */
  agentServerRole?: ServerRole | null;
  /** The acting human's server role, as the caller's permission check loaded it (humans only). */
  actorRole?: ServerRole | null;
}

const SIDEBAR_SORT_MODES = new Set(["manual", "recent", "az"]);

function toSidebarSortMode(value: unknown): SidebarOrderPreferences["channelSortMode"] {
  return typeof value === "string" && SIDEBAR_SORT_MODES.has(value)
    ? (value as SidebarOrderPreferences["channelSortMode"])
    : "manual";
}

function toSidebarCustomSections(value: unknown): SidebarCustomSection[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SidebarCustomSection => {
    if (!item || typeof item !== "object") return false;
    const section = item as Record<string, unknown>;
    return typeof section.id === "string"
      && typeof section.name === "string"
      && (section.emoji === null || typeof section.emoji === "string")
      && typeof section.sortMode === "string"
      && SIDEBAR_SORT_MODES.has(section.sortMode);
  });
}

function toSidebarSectionPlacements(value: unknown): SidebarSectionPlacement[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SidebarSectionPlacement => {
    if (!item || typeof item !== "object") return false;
    const placement = item as Record<string, unknown>;
    return (placement.kind === "channel" || placement.kind === "agent")
      && typeof placement.id === "string"
      && typeof placement.sectionId === "string"
      && typeof placement.position === "number"
      && Number.isFinite(placement.position);
  });
}

interface AddMemberOptions {
  executor?: DatabaseExecutor;
  /** Invite admission's users rows, taken before Server locks; #all's missing audience is rechecked at insertion. */
  allChannelLockedUserIds?: ReadonlySet<string>;
  /**
   * With the Guest role: the one channel the Guest belongs to (#wg-rbac:#15).
   * Accepting an external invite is the product path that adds a Guest, and
   * always binds one; without it the row is a legacy Guest, who reads nothing
   * (tests seed those). Any other role refuses a binding (database CHECK).
   */
  guestChannelId?: string;
  agreementAudit?: {
    actorUserId: string;
    source: serverAgreementService.AgreementSource;
    agreementId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
}

export type ServerMembershipDepartureReason = "left" | "removed";

interface RemoveMemberOptions {
  /**
   * Remove only while the person is still a Guest bound to this channel,
   * checked under the membership lock (removeMemberInTransaction answers null
   * otherwise): a promotion committed in between must not turn a channel
   * removal into removing a full Member from the server (#wg-rbac:#15).
   */
  onlyIfGuestBoundTo?: string;
  reason?: ServerMembershipDepartureReason;
  actorUserId?: string | null;
  /** The acting person's server role, as the caller's permission check loaded it (audit only). */
  actorRole?: ServerRole | null;
  /**
   * How the channels this removal ends are audited, when it is not a plain
   * server departure (`server_departure`, by the remover or the person
   * leaving): a Guest leaving or removed from its one channel (removeHuman).
   */
  channelAudit?: Pick<ChannelMembershipEndAudit, "actor" | "actorRole"> & { reason: "guest_unbind" | "guest_converted" };
  /**
   * The joints whose membership locks (J) the caller already holds, in their
   * order, before this removal prepares (a self_connect releasing its actor's
   * Guest seat, jointMemberConnectService): the removal's mirror refuses
   * (JointLockSetChangedError) rather than take a J outside this set, so the
   * caller restarts instead of locking out of order.
   */
  lockedJointIds?: readonly string[];
}

export async function createServer(name: string, slug: string, ownerId: string) {
  const db = getDb();

  const [existing] = await db.select({ id: servers.id }).from(servers).where(and(eq(servers.slug, slug), isNull(servers.deletedAt)));
  if (existing) {
    throw new Error(`Server slug "${slug}" is already taken`);
  }

  return db.transaction(async (tx) => {
    const [server] = await tx.insert(servers).values({
      name,
      slug,
      ownerId,
    }).returning();

    // Add owner as server member.
    //
    // Born under the CURRENT setup contract. The column's default is still the v1 contract,
    // and that default is what ~9,474 existing servers are holding: for them "Set up later"
    // is the only door out of an unfinished setup, and taking it away retroactively would
    // lock their owners out of their own chat overnight. A new server has no such history —
    // it gets the flow that either completes or rolls back, and never learns the bypass
    // existed. A contract version is for exactly this: new rules bind the contracts signed
    // under them, not the ones already signed.
    await tx.insert(serverMembers).values({
      serverId: server.id,
      userId: ownerId,
      role: "owner",
      setupContractVersion: CURRENT_CONTRACT_VERSION,
    });
    await serverAgreementService.insertMembershipAgreementAudit(tx, {
      serverId: server.id,
      subjectType: "user",
      subjectId: ownerId,
      actorUserId: ownerId,
      source: "admin-add",
      agreementId: null,
      agreementVersion: null,
    });

    // Auto-create virtual #all channel. Its audience is derived from server membership.
    // #all starts hidden (type=private) and is unlocked once the server grows into a
    // team (humans + agents >= ALL_CHANNEL_TEAM_THRESHOLD).
    await tx.insert(channels).values({
      serverId: server.id,
      name: "all",
      description: "General channel for all members",
      type: "private",
    });
    // read-position: no #all rows yet; a hidden #all gets its human rows when it
    // is revealed (ensureAllChannelHumanRows at the team-threshold unlock).

    const [ownerChannel] = await tx.insert(channels).values({
      serverId: server.id,
      name: "onboarding-owner",
      description: "Your private onboarding space",
      type: "private",
    }).returning();
    // read-position: new conversation, no history before this join (no row = position 0)
    await tx.insert(channelHumans).values({
      channelId: ownerChannel.id,
      userId: ownerId,
    });

    // Platform defaults are a Server-level provisioning fact. The protected
    // policy defaults empty, so deploying this source does not itself change
    // the live default set.
    await autoInstallOfficialAppsForProvisionedServer(server.id, tx as ReturnType<typeof getDb>);

    // The Raft License's user limit (source-available only), last: the
    // creator now owns a server, so counts. The first account on a fresh
    // deployment always fits.
    await assertHumanAccountRoom(tx, ownerId, { serverId: server.id, previousRole: null });

    return server;
  });
}

export async function getServersByIds(serverIds: readonly string[]) {
  if (serverIds.length === 0) return [];
  return getDb().select().from(servers).where(and(
    inArray(servers.id, [...new Set(serverIds)]),
    ne(servers.kind, "joint_storage"),
    isNull(servers.deletedAt),
  ));
}

export async function getServer(serverId: string) {
  const [server] = await getServersByIds([serverId]);
  return server || null;
}

export async function isOnboardingWizardEnabledForServer(
  serverId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const [server] = await executor
    .select({ slug: servers.slug })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
  if (!server) return false;

  if (server.slug === "community" || server.slug === "community-cn") {
    return false;
  }

  const evaluation = await evaluateFeatureFlag({
    key: ONBOARDING_OWNER_WIZARD_FEATURE_FLAG_KEY,
    serverId,
  }, executor);
  return evaluation.enabled;
}

export async function getServerBySlug(slug: string) {
  const db = getDb();
  const [server] = await db.select().from(servers).where(and(eq(servers.slug, slug), ne(servers.kind, "joint_storage"), isNull(servers.deletedAt)));
  return server || null;
}

export async function getUserServers(userId: string, opts: { traceQuery?: DbQueryTracer } = {}) {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  return traceQuery(
    "servers.memberships_by_user",
    () => db
      .select({
        id: servers.id,
        name: servers.name,
        avatarUrl: servers.avatarUrl,
        slug: servers.slug,
        ownerId: servers.ownerId,
        onboardingAgentId: servers.onboardingAgentId,
        hideHumansFromMembers: servers.hideHumansFromMembers,
        plan: servers.plan,
        planDowngradedAt: servers.planDowngradedAt,
        role: serverMembers.role,
        // Derived from the level for older clients (the column itself is gone).
        serverPushMuted: sql<boolean>`${serverMembers.serverPushMode} = 'none'`,
        // The server notification level (docs/contracts/notifications.md §1.1).
        notificationLevel: serverMembers.serverPushMode,
        theme: serverMembers.theme,
        themeDecor: serverMembers.themeDecor,
        publiclyVisible: servers.publiclyVisible,
        createdAt: servers.createdAt,
      })
      .from(serverMembers)
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(and(eq(serverMembers.userId, userId), ne(servers.kind, "joint_storage"), isNull(servers.deletedAt)))
      .orderBy(asc(serverMembers.joinedAt)),
    (rows) => ({
      servers_count: rows.length,
    }),
  );
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function toSidebarPinnedRefs(value: unknown): SidebarPinnedRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs: SidebarPinnedRef[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      !("kind" in item) ||
      !("id" in item) ||
      (item.kind !== "channel" && item.kind !== "agent" && item.kind !== "human") ||
      typeof item.id !== "string"
    ) {
      continue;
    }
    refs.push({ kind: item.kind, id: item.id });
  }
  return refs;
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sidebarPinnedRefsEqual(a: SidebarPinnedRef[] | null, b: SidebarPinnedRef[] | null): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length
    && left.every((ref, index) => {
      const other = right[index];
      return ref.kind === other?.kind && ref.id === other.id;
    });
}

export function orderServersByStoredIds<T extends { id: string }>(serverRows: T[], storedIds: string[]): T[] {
  const byId = new Map(serverRows.map((server) => [server.id, server]));
  const ordered: T[] = [];
  const seen = new Set<string>();

  for (const id of storedIds) {
    const server = byId.get(id);
    if (!server || seen.has(id)) continue;
    ordered.push(server);
    seen.add(id);
  }

  for (const server of serverRows) {
    if (seen.has(server.id)) continue;
    ordered.push(server);
    seen.add(server.id);
  }

  return ordered;
}

export async function getServerSwitcherOrder(userId: string, opts: { traceQuery?: DbQueryTracer } = {}): Promise<ServerSwitcherOrderPreferences> {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const [orderState, rows] = await Promise.all([
    traceQuery(
      "servers.switcher_order_state_by_user",
      () => db
        .select({
          serverSwitcherOrder: users.serverSwitcherOrder,
          serverOrderVersion: users.serverOrderVersion,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
      (rows) => ({ users_count: rows.length }),
    ),
    traceQuery(
      "servers.switcher_order_by_user",
      () => db
        .select({
          serverId: serverMembers.serverId,
        })
        .from(serverMembers)
        .innerJoin(servers, eq(serverMembers.serverId, servers.id))
        .where(and(eq(serverMembers.userId, userId), ne(servers.kind, "joint_storage"), isNull(servers.deletedAt)))
        .orderBy(asc(serverMembers.joinedAt)),
      (rows) => ({ memberships_count: rows.length }),
    ),
  ]);

  const allowedIds = new Set(rows.map((row) => row.serverId));
  const savedIds = toStringArray(orderState[0]?.serverSwitcherOrder);
  return {
    serverOrder: [
      ...savedIds.filter((id, index) => allowedIds.has(id) && savedIds.indexOf(id) === index),
      ...rows.map((row) => row.serverId).filter((id) => !savedIds.includes(id)),
    ],
    serverOrderVersion: Number(orderState[0]?.serverOrderVersion) || 0,
  };
}

export async function getOrderedUserServers(userId: string, opts: { traceQuery?: DbQueryTracer } = {}) {
  const [serverRows, order] = await Promise.all([
    getUserServers(userId, opts),
    getServerSwitcherOrder(userId, opts),
  ]);
  return orderServersByStoredIds(serverRows, order.serverOrder)
    .map((server) => ({ ...server, serverOrderVersion: order.serverOrderVersion }));
}

export async function updateServerSwitcherOrder(userId: string, serverOrder: string[]): Promise<ServerSwitcherOrderPreferences> {
  const db = getDb();
  const memberships = await getUserServers(userId);
  const allowedIds = new Set(memberships.map((server) => server.id));
  const filtered = [
    ...serverOrder.filter((id, index) => allowedIds.has(id) && serverOrder.indexOf(id) === index),
    ...memberships.map((server) => server.id).filter((id) => !serverOrder.includes(id)),
  ];
  const current = await getServerSwitcherOrder(userId);
  if (stringArraysEqual(filtered, current.serverOrder)) {
    return current;
  }
  const serverOrderVersion = current.serverOrderVersion + 1;

  await db
    .update(users)
    .set({ serverSwitcherOrder: filtered, serverOrderVersion })
    .where(eq(users.id, userId));

  return { serverOrder: filtered, serverOrderVersion };
}

export async function updateServerOnboardingAgent(
  serverId: string,
  onboardingAgentId: string | null,
  options: { executor?: DatabaseTransaction } = {},
) {
  const run = async (tx: DatabaseTransaction) => {
    const [updated] = await tx
      .update(servers)
      .set({
        onboardingAgentId,
        updatedAt: new Date(),
      })
      .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
      .returning();
    if (!updated) return null;

    // Crossing the checkpoint is the third way the (owner × checkpoint) set changes (#4883): a
    // co-owner who existed BEFORE Cindy would otherwise stay not_started, since first-agent
    // completion only stamps `servers.owner_id`. Sweep every owner now (already-complete rows,
    // incl. the original owner's `normal`, are left untouched by the reconcile).
    if (onboardingAgentId) {
      await reconcileOwnersToSetupCheckpoint(tx, serverId);
    }
    return updated;
  };
  // With a caller's transaction the link commits together with the caller's writes.
  return options.executor ? run(options.executor) : getDb().transaction(run);
}

export async function getServerOnboardingSettings(serverId: string): Promise<ServerOnboardingSettings | null> {
  const db = getDb();
  const [server] = await db
    .select({
      onboardingAgentId: servers.onboardingAgentId,
      agentAllChannelGreetingEnabled: servers.agentAllChannelGreetingEnabled,
    })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));

  if (!server) return null;
  return {
    onboardingAgentId: server.onboardingAgentId ?? null,
    agentAllChannelGreetingEnabled: server.agentAllChannelGreetingEnabled !== false,
    onboardingWizardEnabled: await isOnboardingWizardEnabledForServer(serverId, db),
  };
}

/**
 * RFC-067 workspace switch: when false, nothing about anyone's activity in
 * this server is recorded as product analytics (productAnalyticsGate).
 */
export async function getServerProductAnalyticsEnabled(serverId: string): Promise<boolean | null> {
  const [server] = await getDb()
    .select({ enabled: servers.productAnalyticsEnabled })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
  return server ? server.enabled : null;
}

export async function updateServerProductAnalyticsEnabled(serverId: string, enabled: boolean): Promise<boolean | null> {
  const [updated] = await getDb()
    .update(servers)
    .set({ productAnalyticsEnabled: enabled, updatedAt: new Date() })
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
    .returning({ enabled: servers.productAnalyticsEnabled });
  return updated ? updated.enabled : null;
}

export async function getServerTranslationSettings(serverId: string): Promise<ServerTranslationSettings | null> {
  const db = getDb();
  const [server] = await db
    .select({
      translationEnabled: servers.translationEnabled,
    })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));

  if (!server) return null;
  return {
    translationEnabled: server.translationEnabled === true,
  };
}

export async function updateServerTranslationSettings(
  serverId: string,
  updates: Partial<ServerTranslationSettings>,
): Promise<ServerTranslationSettings | null> {
  const db = getDb();
  const values: Partial<typeof servers.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (Object.prototype.hasOwnProperty.call(updates, "translationEnabled")) {
    values.translationEnabled = updates.translationEnabled === true;
  }

  const [updated] = await db
    .update(servers)
    .set(values)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
    .returning({
      translationEnabled: servers.translationEnabled,
    });

  if (!updated) return null;
  return {
    translationEnabled: updated.translationEnabled === true,
  };
}

export async function updateServerOnboardingSettings(
  serverId: string,
  updates: Partial<ServerOnboardingSettings>,
) {
  return getDb().transaction(async (tx) => {
    const values: Partial<typeof servers.$inferInsert> = {
      updatedAt: new Date(),
    };
    const setsOnboardingAgent = Object.prototype.hasOwnProperty.call(updates, "onboardingAgentId");
    if (setsOnboardingAgent) {
      values.onboardingAgentId = updates.onboardingAgentId ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(updates, "agentAllChannelGreetingEnabled")) {
      values.agentAllChannelGreetingEnabled = updates.agentAllChannelGreetingEnabled !== false;
    }

    const [updated] = await tx
      .update(servers)
      .set(values)
      .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
      .returning({
        onboardingAgentId: servers.onboardingAgentId,
        agentAllChannelGreetingEnabled: servers.agentAllChannelGreetingEnabled,
      });

    if (!updated) return null;

    // This is the OTHER path that crosses the Cindy checkpoint (Settings → set onboarding agent),
    // so it must enforce the owner invariant in the same transaction — see
    // `reconcileOwnersToSetupCheckpoint` and `updateServerOnboardingAgent`. Any new writer of
    // `servers.onboarding_agent_id` must call the reconcile too, or a co-owner drifts (#4883).
    if (setsOnboardingAgent && updates.onboardingAgentId) {
      await reconcileOwnersToSetupCheckpoint(tx, serverId);
    }

    return {
      onboardingAgentId: updated.onboardingAgentId ?? null,
      agentAllChannelGreetingEnabled: updated.agentAllChannelGreetingEnabled !== false,
      onboardingWizardEnabled: await isOnboardingWizardEnabledForServer(serverId, tx),
    };
  });
}

export async function updateServerProfile(
  serverId: string,
  updates: ServerProfileUpdates,
  options: { audit: ServerProfileAuditContext },
) {
  const { audit } = options;
  return getDb().transaction(async (tx) => {
    const [before] = await tx
      .select({ name: servers.name, avatarUrl: servers.avatarUrl, hideHumansFromMembers: servers.hideHumansFromMembers })
      .from(servers)
      .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
      .for("update");
    if (!before) return null;
    const updated = await writeServerProfile(tx, serverId, updates);
    if (!updated) return null;
    const changedFields: string[] = [];
    const diff: Record<string, unknown> = {};
    if (before.name !== updated.name) {
      changedFields.push("name");
      diff.name = { before: before.name, after: updated.name };
    }
    if (before.hideHumansFromMembers !== updated.hideHumansFromMembers) {
      changedFields.push("hideHumansFromMembers");
      diff.hideHumansFromMembers = { before: before.hideHumansFromMembers, after: updated.hideHumansFromMembers };
    }
    // The avatar is a stored object key/URL; record only that it changed.
    if (before.avatarUrl !== updated.avatarUrl) {
      changedFields.push("avatar");
      diff.avatarChanged = true;
    }
    if (changedFields.length > 0) {
      await recordIntegrationAuditEvent({
        serverId,
        eventType: "server.profile_updated",
        outcome: "success",
        source: audit.source,
        actor: audit.actor,
        target: { type: "server", id: serverId },
        metadata: {
          changedFields,
          ...(audit.actor.type === "agent" ? { agentServerRole: audit.agentServerRole ?? null } : {}),
          ...serverAuditContextMetadata({ actorRole: audit.actor.type === "agent" ? audit.agentServerRole : audit.actorRole }),
        },
        diff,
      }, tx);
    }
    return updated;
  });
}

async function writeServerProfile(db: DatabaseExecutor, serverId: string, updates: ServerProfileUpdates) {
  const values: Partial<typeof servers.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (Object.prototype.hasOwnProperty.call(updates, "name")) {
    values.name = updates.name;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "avatarUrl")) {
    values.avatarUrl = updates.avatarUrl ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "hideHumansFromMembers")) {
    values.hideHumansFromMembers = updates.hideHumansFromMembers === true;
  }

  const [updated] = await db
    .update(servers)
    .set(values)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
    .returning();
  return updated || null;
}

/**
 * The server's members as `requesterId` may see them (emails: admins and
 * owners see all, others only their own). `opts.userIds` reads only those
 * members (GET /api/sync/changes), each projected the same way.
 */
export async function getServerMembers(serverId: string, requesterId: string | null, opts: { userIds?: readonly string[] } = {}) {
  if (opts.userIds && opts.userIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      displayName: users.displayName,
      description: users.description,
      avatarUrl: users.avatarUrl,
      role: serverMembers.role,
      joinedAt: serverMembers.joinedAt,
    })
    .from(serverMembers)
    .innerJoin(users, eq(serverMembers.userId, users.id))
    .where(and(
      eq(serverMembers.serverId, serverId),
      opts.userIds ? inArray(serverMembers.userId, [...new Set(opts.userIds)]) : undefined,
    ))
    .orderBy(asc(serverMembers.joinedAt));

  const requesterRole = requesterId ? await getMemberRole(serverId, requesterId) : null;
  const canSeeAllEmails = isAdminOrOwner(requesterRole);

  return rows.map(({ email, ...rest }) => ({
    ...rest,
    email: canSeeAllEmails || (requesterId !== null && rest.userId === requesterId) ? email : null,
    gravatarHash: DEPRECATED_GRAVATAR_HASH,
  }));
}

/**
 * The GET /api/servers/:id/members items for a non-guest member: everyone, or
 * only the requester when the server hides its human directory from them.
 * Guests are listed only to owners and admins (cindyz 10-23, #wg-rbac:#15):
 * anyone else meets a Guest only on its channel's roster.
 */
export async function listServerMemberDirectory(serverId: string, requesterId: string, opts: { userIds?: readonly string[] } = {}) {
  const [members, hideHumanDirectory, requesterRole] = await Promise.all([
    getServerMembers(serverId, requesterId, opts),
    shouldHideHumanDirectoryFromRequester(serverId, requesterId),
    getMemberRole(serverId, requesterId),
  ]);
  if (hideHumanDirectory) return members.filter((item) => item.userId === requesterId);
  if (isAdminOrOwner(requesterRole)) return members;
  return members.filter((item) => item.role !== "guest" || item.userId === requesterId);
}

export async function getAgentMemberRole(
  serverId: string,
  agentId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<ServerRole | null> {
  return (await getAgentMemberRoles(serverId, [agentId], executor)).get(agentId) ?? null;
}

/**
 * getAgentMemberRole for several agents in one query. An agent with no role
 * here (another server's agent, deleted, no membership row) is absent.
 */
export async function getAgentMemberRoles(
  serverId: string,
  agentIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, ServerRole>> {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select({ agentId: serverAgentMembers.agentId, role: serverAgentMembers.role })
    .from(serverAgentMembers)
    .innerJoin(agents, eq(serverAgentMembers.agentId, agents.id))
    .where(and(
      eq(serverAgentMembers.serverId, serverId),
      inArray(serverAgentMembers.agentId, ids),
      eq(agents.serverId, serverId),
      isNull(agents.deletedAt),
    ));
  const roles = new Map<string, ServerRole>();
  for (const row of rows) if (row.role) roles.set(row.agentId, row.role as ServerRole);
  return roles;
}

export async function getServerAgentRoleMap(serverId: string): Promise<Map<string, ServerRole>> {
  const db = getDb();
  const rows = await db
    .select({
      agentId: serverAgentMembers.agentId,
      role: serverAgentMembers.role,
    })
    .from(serverAgentMembers)
    .innerJoin(agents, eq(serverAgentMembers.agentId, agents.id))
    .where(and(
      eq(serverAgentMembers.serverId, serverId),
      eq(agents.serverId, serverId),
      isNull(agents.deletedAt),
    ));
  return new Map(rows.map((row) => [row.agentId, row.role as ServerRole]));
}

export async function countActiveAgentsMissingServerMembership(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ value: count() })
    .from(agents)
    .leftJoin(serverAgentMembers, and(
      eq(serverAgentMembers.serverId, agents.serverId),
      eq(serverAgentMembers.agentId, agents.id),
    ))
    .where(and(
      isNull(agents.deletedAt),
      isNull(serverAgentMembers.agentId),
    ));

  return Number(row?.value ?? 0);
}

export async function shouldHideHumanDirectoryFromRequester(serverId: string, requesterId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      hideHumansFromMembers: servers.hideHumansFromMembers,
      role: serverMembers.role,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, requesterId),
      isNull(servers.deletedAt),
    ));

  return row?.hideHumansFromMembers === true && row.role === "member";
}

export async function isHumanDirectoryHidden(serverId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ hideHumansFromMembers: servers.hideHumansFromMembers })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
  return row?.hideHumansFromMembers === true;
}

export async function shouldHideHumanDirectoryFromAgentRequester(serverId: string, agentId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      hideHumansFromMembers: servers.hideHumansFromMembers,
      role: serverAgentMembers.role,
    })
    .from(servers)
    .leftJoin(serverAgentMembers, and(
      eq(serverAgentMembers.serverId, servers.id),
      eq(serverAgentMembers.agentId, agentId),
    ))
    .where(and(
      eq(servers.id, serverId),
      isNull(servers.deletedAt),
    ));

  // Missing membership must fail closed. An active orphan can still retain an
  // agent credential and channel membership after integrity drift, so treating
  // a missing row as "directory visible" would reopen mention/profile oracles.
  // Only an exact current admin membership bypasses a hidden human directory.
  return row?.hideHumansFromMembers === true && row.role !== "admin";
}

/**
 * A human of this server as an agent requester may find them, by exact handle
 * or by user id: null when there is no such member, and equally null when the
 * server hides its human directory from this agent
 * (shouldHideHumanDirectoryFromAgentRequester) and the person is not exposed
 * (shouldExposeHumanInHiddenDirectory, agent rule: no human "self"). Callers
 * answer null exactly as they answer a missing person, so handle and id
 * resolution never confirm that a hidden person exists. Both reads always run
 * (in parallel), so a hidden person and a missing one take the same path.
 */
export async function findAgentVisibleServerHuman(
  serverId: string,
  agentId: string,
  ref: { name: string; userId?: never } | { userId: string; name?: never },
): Promise<{ userId: string; name: string } | null> {
  const db = getDb();
  const [rows, hidden] = await Promise.all([
    db
      .select({
        userId: users.id,
        name: users.name,
        role: serverMembers.role,
        serverSlug: servers.slug,
      })
      .from(serverMembers)
      .innerJoin(users, eq(serverMembers.userId, users.id))
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(and(
        eq(serverMembers.serverId, serverId),
        ref.userId !== undefined ? eq(users.id, ref.userId) : eq(users.name, ref.name),
      ))
      .limit(1),
    shouldHideHumanDirectoryFromAgentRequester(serverId, agentId),
  ]);
  const human = rows[0];
  if (!human) return null;
  if (hidden && !shouldExposeHumanInHiddenDirectory(human, null)) return null;
  return { userId: human.userId, name: human.name };
}

export function shouldExposeHumanInHiddenDirectory(
  human: { id?: string | null; userId?: string | null; serverSlug?: string | null; role?: string | null },
  requesterUserId: string | null,
): boolean {
  const humanId = human.id ?? human.userId ?? null;
  if (requesterUserId && humanId === requesterUserId) return true;
  return (human.serverSlug === "community" || human.serverSlug === "community-cn")
    && (human.role === "owner" || human.role === "admin");
}

export async function getServerMemberProfile(serverId: string, userId: string, requesterId: string) {
  const db = getDb();
  const [server] = await db
    .select({
      id: servers.id,
      name: servers.name,
      slug: servers.slug,
    })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
  if (!server) return null;

  const [user] = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      displayName: users.displayName,
      description: users.description,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) return null;

  const [membership] = await db
    .select({
      role: serverMembers.role,
      joinedAt: serverMembers.joinedAt,
    })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));

  const [departure] = membership
    ? []
    : await db
        .select({ reason: serverMembershipDepartures.reason })
        .from(serverMembershipDepartures)
        .where(and(
          eq(serverMembershipDepartures.serverId, serverId),
          eq(serverMembershipDepartures.userId, userId),
        ));

  if (!membership) {
    const [historicalMessage] = await db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .where(
        and(
          eq(channels.serverId, serverId),
          eq(messages.senderType, "user"),
          eq(messages.senderId, userId),
        )
      )
      .limit(1);

    if (!historicalMessage) return null;
  }

  const requesterRole = await getMemberRole(serverId, requesterId);
  const canSeeEmail = isAdminOrOwner(requesterRole) || user.userId === requesterId;
  const createdAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      avatarUrl: agents.avatarUrl,
      runtime: agents.runtime,
      status: agents.status,
    })
    .from(agents)
    .where(and(
      eq(agents.serverId, serverId),
      eq(agents.creatorType, "user"),
      eq(agents.creatorId, user.userId),
      isNull(agents.deletedAt),
      // A personal assistant's creator is its owner: their profile lists it
      // to them alone, and to nobody else (agentFindableBy).
      agentFindableBy({ userId: requesterId }),
    ))
    .orderBy(asc(agents.createdAt));

  return {
    userId: user.userId,
    serverId: server.id,
    serverName: server.name,
    serverSlug: server.slug,
    name: user.name,
    displayName: user.displayName,
    description: user.description,
    avatarUrl: user.avatarUrl,
    email: canSeeEmail ? user.email : null,
    gravatarHash: DEPRECATED_GRAVATAR_HASH,
    role: (membership?.role ?? null),
    joinedAt: membership?.joinedAt ?? null,
    membershipStatus: membership ? "active" as const : (departure?.reason ?? "removed"),
    createdAgents,
  };
}

export async function addMember(
  serverId: string,
  userId: string,
  role: ServerRole = "member",
  options: AddMemberOptions = {},
) {
  await refreshSubscriptionForServerIfStale(serverId);

  const run = async (db: DatabaseExecutor) => {
    // Only a direct add AS owner races the checkpoint setter and needs reconciling, so only then
    // take the ordering lock. Ordinary member joins (community / invite / join-link, which pass a
    // caller executor) must NOT be serialized on the server-row mutex — see
    // lockServerForOwnerSetupOrdering.
    if (isOwnerRole(role)) {
      await lockServerForOwnerSetupOrdering(db, serverId);
    }

    const [existing] = await db
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
    if (existing) return false;

    if (role !== "guest") {
      const entitlement = await getServerBillingEntitlement(db, serverId);
      const usage = await getServerBillingUsage(db, serverId);
      assertHumanCapacityAvailable(entitlement, usage);
    }

    const [inserted] = await db.insert(serverMembers).values({
      serverId,
      userId,
      role,
      guestChannelId: options.guestChannelId ?? null,
    }).onConflictDoNothing().returning({ userId: serverMembers.userId });

    if (inserted) {
      // A seat taken: the server's seat notices show only while the seats are full.
      if (role !== "guest") await announceSeatJoinBlocksForSeatChange(db, serverId);
      // Serialize a newly eligible identity with a joint disconnect's fixed
      // victim snapshot. Acquiring J after SM follows departure's lock order;
      // this does not grant J membership or replay legacy CH on server rejoin.
      await prepareJointHumanMembershipMirror(db, { serverId, userId }, "revalidate");
      await db.delete(serverMembershipDepartures).where(and(
        eq(serverMembershipDepartures.serverId, serverId),
        eq(serverMembershipDepartures.userId, userId),
      ));
      // Same commit as the insert: the event row is the outbox.
      await emitAppFacingMemberEvents({
        serverId,
        eventType: "server.member_added",
        members: [{ principalType: "human", principalId: userId, role }],
        provenance: { source: "server_service", actor_type: "human", reason: options.agreementAudit?.source ?? "added" },
      }, db);
    }

    // Adding someone straight in as owner is the second way into the (owner × checkpoint) set
    // (#4883); reconcile their setup the same as a promotion so they never land on Meet Cindy.
    if (inserted && isOwnerRole(role)) {
      await reconcileOwnersToSetupCheckpoint(db, serverId, { onlyUserId: userId });
    }

    if (inserted && options.agreementAudit) {
      const active = await serverAgreementService.getActiveAgreement(serverId, db);
      const expectedAgreementId = options.agreementAudit.agreementId ?? null;
      if (options.agreementAudit.source !== "admin-add") {
        if (!expectedAgreementId && active) {
          throw new serverAgreementService.AgreementRequiredError(active);
        }
        if (expectedAgreementId && active?.id !== expectedAgreementId) {
          throw new serverAgreementService.AgreementChangedError(active);
        }
      }
      await serverAgreementService.insertMembershipAgreementAudit(db, {
        serverId,
        subjectType: "user",
        subjectId: userId,
        actorUserId: options.agreementAudit.actorUserId,
        source: options.agreementAudit.source,
        agreementId: active?.id ?? null,
        agreementVersion: active?.version ?? null,
        ipAddress: options.agreementAudit.ipAddress,
        userAgent: options.agreementAudit.userAgent,
      });
    }

    // Opener onboarding: a new human can be the member that grows the server
    // into a team (humans + agents >= threshold), which reveals the born-hidden
    // #all. Mirrors the 2nd-agent reveal in agentService.createAgent.
    // A Guest is outside #all and does not grow the team.
    if (inserted && role !== "guest") {
      const [{ agentCount }] = await db
        .select({ agentCount: sql<number>`count(*)::int` })
        .from(agents)
        .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt), headcountAgent()));
      const [{ humanCount }] = await db
        .select({ humanCount: sql<number>`count(*)::int` })
        .from(serverMembers)
        .where(eq(serverMembers.serverId, serverId));
      if (agentCount + humanCount >= ALL_CHANNEL_TEAM_THRESHOLD) {
        const [ownerUnlock] = await db
          .select({ sentAt: serverMembers.allChannelUnlockInstructionSentAt })
          .from(servers)
          .innerJoin(serverMembers, and(
            eq(serverMembers.serverId, servers.id),
            eq(serverMembers.userId, servers.ownerId),
          ))
          .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
        if (!ownerUnlock?.sentAt) {
          await db
            .update(channels)
            .set({ type: "channel" })
            .where(and(
              eq(channels.serverId, serverId),
              eq(channels.name, "all"),
              eq(channels.type, "private"),
            ));
          // #all just became enabled: everyone gets their row now.
          await ensureAllChannelHumanRows(db, serverId, { lockedUserIds: options.allChannelLockedUserIds });
        }
      }
    }

    // read-position: the #all row starts at the latest message, like any join.
    if (inserted && role !== "guest") {
      await ensureAllChannelHumanRows(db, serverId, { userIds: [userId], lockedUserIds: options.allChannelLockedUserIds });
    }

    // The Raft License's user limit (source-available only): last, after every
    // write and lock above. A member seat, or a second Guest seat, may make
    // one more person count.
    if (inserted) await assertHumanAccountRoom(db, userId, { serverId, previousRole: null });

    return !!inserted;
  };

  // With a caller's executor the caller commits, and kicks app delivery after.
  if (options.executor) {
    return run(options.executor);
  }

  const added = await getDb().transaction(run);
  if (added) kickAppNotificationDelivery();
  return added;
}

/**
 * Returns the personal assistants archived with the departing member, so the
 * caller can tell clients (`agent:deleted`, archive updated) as an archive does.
 */
/**
 * For a channel writer that removes Guests: after it holds the channel row,
 * lock the server (FOR SHARE) and these people's membership rows (FOR UPDATE,
 * by user id). That keeps the global order channel -> server -> member ->
 * joint -> channel membership; removeMemberInTransaction then re-takes the same
 * locks without waiting (#wg-rbac:#15).
 */
export async function lockServerMembershipsAfterChannel(tx: DatabaseTransaction, serverId: string, userIds: readonly string[]): Promise<void> {
  await tx.execute(sql`SELECT id FROM servers WHERE id = ${serverId} FOR SHARE`);
  const ids = [...new Set(userIds)].sort();
  if (ids.length === 0) return;
  await tx.execute(sql`
    SELECT user_id FROM server_members
    WHERE server_id = ${serverId}
      AND user_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY user_id
    FOR UPDATE
  `);
}

/** What a committed member removal still owes: app delivery, assistant runtime and credential-stream closes, socket revocation, revoked Computers' connections. */
export interface RemovedMemberEffects {
  announced: boolean;
  departedAssistants: DepartedOwnerAssistants | null;
  revokedCredentialAgentIds: string[];
  /** The Computers this person attached here, revoked with the membership: what to close after commit. */
  revokedComputers: { agentIds: string[]; machineIds: string[]; detached: DetachedComputer[] };
}

export interface RemovedMember {
  archivedAssistantIds: string[];
  /** Computers taken offline with the membership; the caller tells the owners of the agents on them (computerDetachedNotices.ts). */
  detachedComputers: DetachedComputer[];
}

export async function removeMember(serverId: string, userId: string, options: RemoveMemberOptions = {}): Promise<RemovedMember> {
  const effects = await getDb().transaction(async (tx) => {
    // The removed person's and the remover's users rows first (the departure,
    // membership-end and audit rows name them), before the server row:
    // locked only, never refused (a person being deleted may still leave or be
    // removed). Account deletion takes a users row FOR UPDATE, then the
    // person's owned servers (lockJointUsersFirst).
    await lockJointUsersFirst(tx, { userIds: [userId, options.actorUserId] });
    return removeMemberInTransaction(tx, serverId, userId, options);
  });
  if (!effects) return { archivedAssistantIds: [], detachedComputers: [] };
  return finishRemovedMember(serverId, userId, effects);
}

/**
 * removeMember's writes inside a caller's transaction (a Guest removed from
 * its one channel leaves the server in the same commit, #wg-rbac:#15). The
 * caller must call finishRemovedMember after its commit.
 */
export async function removeMemberInTransaction(
  tx: DatabaseTransaction,
  serverId: string,
  userId: string,
  options: RemoveMemberOptions = {},
): Promise<RemovedMemberEffects | null> {
  const prepared = await prepareMemberRemoval(tx, serverId, userId, options);
  return prepared ? executeMemberRemoval(tx, prepared) : null;
}

/**
 * removeMemberInTransaction's first phase (design v3 §3, Cody §1): every lock
 * the removal needs and its context, before any write. In order: the server
 * row (FOR SHARE), the person's member row (FOR UPDATE), then the joint
 * membership locks of every joint the person is in through this server (the
 * mirror's prepare, which takes the source-exit flag's share lock first), and
 * the joints they belong to through a copy here. Null when
 * `onlyIfGuestBoundTo` no longer holds (nothing locked beyond the rows read).
 * The caller runs executeMemberRemoval in the same transaction, then
 * finishRemovedMember after its commit.
 */
export async function prepareMemberRemoval(
  tx: DatabaseTransaction,
  serverId: string,
  userId: string,
  options: RemoveMemberOptions = {},
): Promise<PreparedMemberRemoval | null> {
  // Task #101: keep the global order servers -> member rows -> resource rows. The `servers` row is locked FOR SHARE
  // first because the departure insert below takes a key-share lock on it through its foreign key, while
  // transitionMemberRole holds `servers` FOR UPDATE and then waits on member rows. The target's member row is locked
  // FOR UPDATE before any channel_humans / thread_follows delete, so a fenced writer holding that member row and then
  // waiting on channel_humans (the read-state sequencer for private, DM and joint scopes) makes this removal wait
  // instead of deadlocking. A missing member row is not an error here: the deletes below are no-ops, as before.
  await tx.execute(sql`
    SELECT id
    FROM servers
    WHERE id = ${serverId}
    FOR SHARE
  `);
  const memberRows = await tx.execute<{ role: string; guest_channel_id: string | null }>(sql`
    SELECT role, guest_channel_id
    FROM server_members
    WHERE server_id = ${serverId}
      AND user_id = ${userId}
    FOR UPDATE
  `);
  const removedRole = memberRows.rows[0]?.role;
  if (options.onlyIfGuestBoundTo !== undefined
    && (removedRole !== "guest" || memberRows.rows[0]?.guest_channel_id !== options.onlyIfGuestBoundTo)) {
    return null;
  }
  // An exit: with source exit on, the person also leaves every J this server
  // was their last live source of (audited below with the other ended joints).
  const mirrorHumans = await prepareJointHumanMembershipMirror(tx, { serverId, userId }, "revalidate", {
    exit: true,
    ...(options.lockedJointIds ? { lockedJointIds: options.lockedJointIds } : {}),
  });
  // The joints the person belongs to through a copy on this server, before the
  // revalidation below: those it ends are audited once each (one per joint).
  const jointsBefore = await tx.execute<{ jointChannelId: string; localChannelId: string; hostServerId: string }>(sql`
    SELECT m.joint_channel_id AS "jointChannelId", p.local_channel_id AS "localChannelId", j.created_by_server_id AS "hostServerId"
    FROM joint_channel_members m
    JOIN joint_channel_servers p ON p.joint_channel_id = m.joint_channel_id AND p.server_id = ${serverId}::uuid
    JOIN channels c ON c.id = p.local_channel_id AND c.type = 'joint'
    JOIN joint_channels j ON j.id = m.joint_channel_id
    WHERE m.user_id = ${userId}::uuid`);
  return {
    serverId,
    userId,
    options,
    removedRole,
    guestChannelId: memberRows.rows[0]?.guest_channel_id ?? null,
    mirrorHumans,
    jointsBefore: jointsBefore.rows,
  };
}

/** What prepareMemberRemoval locked and read, for executeMemberRemoval in the same transaction. */
export interface PreparedMemberRemoval {
  serverId: string;
  userId: string;
  options: RemoveMemberOptions;
  removedRole: string | undefined;
  guestChannelId: string | null;
  mirrorHumans: Awaited<ReturnType<typeof prepareJointHumanMembershipMirror>>;
  jointsBefore: ReadonlyArray<{ jointChannelId: string; localChannelId: string; hostServerId: string }>;
}

/**
 * removeMemberInTransaction's second phase: every write of the removal, under
 * the locks prepareMemberRemoval took (no lock on a server, member or joint
 * row it did not take first). The effects are finishRemovedMember's, after
 * the caller's commit.
 */
export async function executeMemberRemoval(tx: DatabaseTransaction, prepared: PreparedMemberRemoval): Promise<RemovedMemberEffects> {
  const { serverId, userId, options, removedRole, mirrorHumans } = prepared;
  const jointsBefore = { rows: prepared.jointsBefore };
  const effects: RemovedMemberEffects = {
    announced: false,
    departedAssistants: null,
    revokedCredentialAgentIds: [],
    revokedComputers: { agentIds: [], machineIds: [], detached: [] },
  };
  const endedChannels: EndedChannelMembership[] = [];

  const serverChannelIds = await tx
    .select({ id: channels.id, type: channels.type })
    .from(channels)
    .where(and(eq(channels.serverId, serverId), isNull(channels.deletedAt)));

  if (serverChannelIds.length > 0) {
    // Joint thread follows are keyed by each server's local thread
    // projection (no parent_message_id; local_channel_id is unique), so the
    // second branch removes exactly the follows held through this server.
    // A follow of the same joint thread through another server the user
    // still belongs to is a different row and stays.
    await tx.execute(sql`
      DELETE FROM ${threadFollows}
      WHERE ${threadFollows.followerType} = 'user'
        AND ${threadFollows.followerId} = ${userId}
        AND (
          EXISTS (
            SELECT 1
            FROM ${channels} thread_channels
            INNER JOIN ${messages} parent_messages
              ON parent_messages.id = thread_channels.parent_message_id
            INNER JOIN ${channels} parent_channels
              ON parent_channels.id = parent_messages.channel_id
            WHERE thread_channels.id = ${threadFollows.threadChannelId}
              AND thread_channels.type = 'thread'
              AND parent_channels.server_id = ${serverId}
          )
          OR EXISTS (
            SELECT 1
            FROM ${channels} thread_channels
            INNER JOIN ${jointChannelServers} thread_projections
              ON thread_projections.local_channel_id = thread_channels.id
            WHERE thread_channels.id = ${threadFollows.threadChannelId}
              AND thread_channels.type = 'thread'
              AND thread_projections.server_id = ${serverId}
          )
          -- Task v2 conversations followed through this server: the
          -- canonical conversation of an ordinary channel and this server's
          -- local projection of a joint one both live on this server (a
          -- joint canonical lives on the storage server and has no follows).
          OR EXISTS (
            SELECT 1
            FROM ${channels} task_conversations
            WHERE task_conversations.id = ${threadFollows.threadChannelId}
              AND task_conversations.type = 'task'
              AND task_conversations.server_id = ${serverId}
          )
        )
    `);

    // A DM's participants belong to its durable pair, not to a particular
    // server-membership stint. Access still requires a live server member;
    // keeping these rows lets a returning member use the same conversation.
    const joinedChannelIds = serverChannelIds.filter((row) => row.type !== "dm").map((row) => row.id);
    if (joinedChannelIds.length > 0) {
      const deleted = await tx.delete(channelHumans).where(and(
        eq(channelHumans.userId, userId),
        inArray(channelHumans.channelId, joinedChannelIds),
      )).returning({ channelId: channelHumans.channelId });
      // Ordinary channels audit their own row; a joint copy's row is the joint's, audited below.
      const typeById = new Map(serverChannelIds.map((row) => [row.id, row.type]));
      for (const row of deleted) {
        const type = typeById.get(row.channelId);
        if (type === "channel" || type === "private") endedChannels.push({ serverId, channelId: row.channelId, channelType: type });
      }
    }
  }

  const departedAt = currentDate();
  // Only a membership that ended writes its departure: a call that found no member row (a
  // leave racing a removal that already committed) must not rewrite how it ended. The stricter
  // one wins the other way round: a removal arriving just after the person left upgrades
  // their `left` to `removed`, so SSO auto-join does not bring them back (Warden 5e812f5f).
  if (removedRole === undefined && (options.reason ?? "removed") === "removed") {
    await tx.update(serverMembershipDepartures).set({ reason: "removed", actorUserId: options.actorUserId ?? null })
      .where(and(eq(serverMembershipDepartures.serverId, serverId), eq(serverMembershipDepartures.userId, userId), eq(serverMembershipDepartures.reason, "left")));
  }
  if (removedRole !== undefined) {
    await tx.insert(serverMembershipDepartures).values({
      serverId,
      userId,
      reason: options.reason ?? "removed",
      actorUserId: options.actorUserId ?? null,
      role: removedRole as ServerRole,
      departedAt,
    }).onConflictDoUpdate({
      target: [serverMembershipDepartures.serverId, serverMembershipDepartures.userId],
      set: {
        reason: options.reason ?? "removed",
        actorUserId: options.actorUserId ?? null,
        role: removedRole as ServerRole,
        departedAt,
      },
    });
  }

  await tx.delete(serverMembers).where(and(
    eq(serverMembers.serverId, serverId),
    eq(serverMembers.userId, userId),
  ));
  // Every audit event this removal writes (channel memberships, membership,
  // revoked credentials, departed assistants) shares one operation id.
  const reason = options.reason ?? "removed";
  const auditActorId = options.actorUserId ?? (reason === "left" ? userId : null);
  // The same person is recorded on a joint copy this removal empties.
  await mirrorHumans.apply([userId], auditActorId ? { actorUserId: auditActorId } : {});
  const audit = {
    operationId: newAuditOperationId(),
    // A person who leaves acts with the role they are leaving.
    actorRole: auditActorId ? options.actorRole ?? (auditActorId === userId ? removedRole as ServerRole : null) : null,
  };

  // The joints the revalidation took the person out of (its joint_channel_members row is gone).
  if (jointsBefore.rows.length > 0) {
    const remaining = new Set((await tx.execute<{ jointChannelId: string }>(sql`
      SELECT joint_channel_id AS "jointChannelId" FROM joint_channel_members
      WHERE user_id = ${userId}::uuid
        AND joint_channel_id IN (${sql.join(jointsBefore.rows.map((row) => sql`${row.jointChannelId}::uuid`), sql`, `)})`)).rows.map((row) => row.jointChannelId));
    for (const row of jointsBefore.rows) {
      // A Guest converted to entering through a server of theirs (guest_converted)
      // keeps the joint: its entry through this copy, the one it was bound to, is
      // what ended, and is audited as such.
      const converted = options.channelAudit?.reason === "guest_converted" && row.localChannelId === prepared.guestChannelId;
      if (remaining.has(row.jointChannelId) && !converted) continue;
      endedChannels.push({ serverId, channelId: row.localChannelId, channelType: "joint", joint: { jointChannelId: row.jointChannelId, hostServerId: row.hostServerId } });
    }
  }
  // Same transaction, one INSERT: a failed audit write fails the removal.
  await recordChannelMembershipsEnded(tx, {
    reason: options.channelAudit?.reason ?? "server_departure",
    actor: options.channelAudit?.actor ?? (auditActorId ? { type: "human", id: auditActorId } : { type: "system" }),
    actorRole: options.channelAudit?.actorRole ?? audit.actorRole,
    operationId: audit.operationId,
    targetUserId: userId,
    memberships: endedChannels,
  });

  if (removedRole === undefined) return { ...effects, announced: false };
  // A seat freed: the server's seat notices show only while the seats are full.
  if (removedRole !== "guest") await announceSeatJoinBlocksForSeatChange(tx, serverId);
  // A Guest leaving can leave its channel with no Guest, no longer external:
  // the free plan's freeze follows in this commit.
  if (removedRole === "guest") {
    const { reconcileServerExternalFreeze } = await import("./externalChannelFreezeService");
    await reconcileServerExternalFreeze(tx, serverId, departedAt, { clearOnly: true });
  }

  // The user's personal assistants leave with them (archived, hosted runtime
  // deleted, credentials revoked): nobody else may run them.
  effects.departedAssistants = await archiveAssistantsOfDepartingOwner(tx, {
    serverId,
    ownerUserId: userId,
    actorUserId: options.actorUserId ?? userId,
    audit,
  });

  // Sign-in with Raft tokens and consents die with the membership, and so do
  // link-preview declines. Without this they only fail while the user is
  // absent and come back to life on rejoin; a member who returns signs in to
  // their apps again and answers their preview prompts afresh.
  await tx.update(oauthAccessTokens).set({ revokedAt: departedAt }).where(and(
    eq(oauthAccessTokens.serverId, serverId),
    eq(oauthAccessTokens.principalType, "human"),
    eq(oauthAccessTokens.userId, userId),
    isNull(oauthAccessTokens.revokedAt),
  ));
  await tx.update(oauthUserConsents).set({ revokedAt: departedAt, updatedAt: departedAt }).where(and(
    eq(oauthUserConsents.userId, userId),
    eq(oauthUserConsents.serverId, serverId),
    isNull(oauthUserConsents.revokedAt),
  ));
  await tx.delete(oauthLinkPreviewDeclines).where(and(
    eq(oauthLinkPreviewDeclines.userId, userId),
    eq(oauthLinkPreviewDeclines.serverId, serverId),
  ));
  // Agent credentials this person issued here die with the membership too:
  // they were the person's own access, handed to an Agent (#wg-rbac B12).
  const revokedCredentials = await revokeAgentCredentialsIssuedBy({ serverId, userId, revokedAt: departedAt }, tx);
  effects.revokedCredentialAgentIds = [...new Set(revokedCredentials.map((row) => row.agentId))];
  // Computers this person owned here become Public (Computer owner v1, #wg-rbac:#32); each change audited.
  await clearComputerOwnershipOf(tx, { userId, serverId, reason: "owner_left_server", actorUserId: auditActorId, audit });
  // Every live Computer this person attached here is revoked, as its "Revoke
  // Computer key" does (computerKeyRevocation.ts): the key and what its machine
  // minted, each audited under this removal's operation id. The machine and its
  // agents stay bound; the connection closes after commit. Their Computers on
  // other servers are untouched. A demotion revokes nothing.
  const attached = await tx
    .select({ id: computers.id })
    .from(computers)
    .where(liveComputersAttachedBy(serverId, userId))
    .orderBy(asc(computers.id));
  const computerReach = { agentIds: new Set<string>(), machineIds: new Set<string>() };
  for (const computer of attached) {
    const result = await revokeComputerKeyInTransaction(tx, {
      computerId: computer.id,
      by: { via: "member_removed", actorUserId: auditActorId, actorRole: audit.actorRole, departureReason: reason },
      now: departedAt,
      operationId: audit.operationId,
    });
    for (const agentId of result?.reach.agentIds ?? []) computerReach.agentIds.add(agentId);
    for (const machineId of result?.reach.machineIds ?? []) computerReach.machineIds.add(machineId);
    if (result?.detached) effects.revokedComputers.detached.push(result.detached);
  }
  effects.revokedComputers.agentIds = [...computerReach.agentIds];
  effects.revokedComputers.machineIds = [...computerReach.machineIds];

  const auditActor = auditActorId ? { type: "human" as const, id: auditActorId } : { type: "system" as const };
  const auditSource = auditActorId ? "web" as const : "system" as const;
  await recordIntegrationAuditEvent({
    serverId,
    eventType: "membership.removed",
    outcome: "success",
    source: auditSource,
    actor: auditActor,
    target: { type: "human", id: userId },
    metadata: { reason, removedRole, revokedAgentCredentialCount: revokedCredentials.length, ...serverAuditContextMetadata(audit) },
  }, tx);
  for (const credential of revokedCredentials) {
    await recordIntegrationAuditEvent({
      serverId,
      eventType: "agent_credential.revoked",
      outcome: "success",
      source: auditSource,
      actor: auditActor,
      subject: { type: "human", id: userId },
      target: { type: "agent_credential", id: credential.credentialId },
      metadata: { agentId: credential.agentId, credentialId: credential.credentialId, reason: ISSUER_LEFT_SERVER_REVOKE_REASON, ...serverAuditContextMetadata(audit) },
    }, tx);
  }
  // Same commit as the delete: the event row is the outbox.
  const { recipientCount } = await emitAppFacingMemberEvents({
    serverId,
    eventType: "server.member_removed",
    members: [{ principalType: "human", principalId: userId, role: removedRole }],
    occurredAt: departedAt,
    provenance: { source: "server_service", actor_type: "human", reason: options.reason ?? "removed" },
  }, tx);
  return { ...effects, announced: recipientCount > 0 };
}

/** The Computers ending this person's membership of the server revokes (removeMemberInTransaction): the live ones they attached to it. */
function liveComputersAttachedBy(serverId: string, userId: string) {
  return and(eq(computers.serverId, serverId), eq(computers.attachedByUserId, userId), isNull(computers.revokedAt));
}

/**
 * How many live Computers the person attached to the server (the ones ending
 * their membership would revoke). Read under their member row's lock, the one
 * a Computer's attach takes (FOR SHARE, computerCredentialService), it cannot
 * grow before the caller's commit.
 */
export async function countLiveComputersAttachedBy(executor: DatabaseExecutor, serverId: string, userId: string): Promise<number> {
  const [row] = await executor.select({ n: count() }).from(computers).where(liveComputersAttachedBy(serverId, userId));
  return Number(row?.n ?? 0);
}

/**
 * What removing this person from the server, or their leaving it, takes
 * offline (MemberRemovalImpact): the Computers removeMemberInTransaction
 * revokes and the live agents bound to their machines. An agent is the
 * person's own when they created it or it is their personal assistant
 * (findAgentsBoundToMachines); every other one, another person's or one an
 * agent created, counts in othersAgents. No agent is named.
 */
export async function getMemberRemovalImpact(serverId: string, userId: string): Promise<MemberRemovalImpact> {
  const attached = await getDb()
    .select({ name: computers.name, machineId: computers.machineId })
    .from(computers)
    .where(liveComputersAttachedBy(serverId, userId))
    .orderBy(asc(computers.name), asc(computers.id));
  const machineIds = [...new Set(attached.flatMap((computer) => computer.machineId ? [computer.machineId] : []))];
  const bound = await findAgentsBoundToMachines(getDb(), machineIds, userId);
  return {
    computers: attached.length,
    agents: bound.length,
    othersAgents: bound.filter((agent) => !agent.ownedByActor).length,
    computerNames: attached.slice(0, MEMBER_REMOVAL_IMPACT_MAX_COMPUTER_NAMES).map((computer) => computer.name),
  };
}

/** After the removal's commit (see removeMemberInTransaction). */
export async function finishRemovedMember(serverId: string, userId: string, effects: RemovedMemberEffects): Promise<RemovedMember> {
  if (effects.announced) kickAppNotificationDelivery();
  const departed = effects.departedAssistants;
  if (departed && departed.agentIds.length > 0) {
    if (departed.hostedDeletion) kickAgentRuntimeProvisionWorker();
    for (const agentId of departed.agentIds) await broadcastAgentCredentialRevocation(agentId);
  }
  await revokeSocketAccess({ userId, removedFromServerId: serverId });
  // After commit: close the revoked credentials' open streams on every replica.
  for (const agentId of effects.revokedCredentialAgentIds) {
    await broadcastAgentCredentialRevocation(agentId);
  }
  // The revoked Computers' connections and what their machines minted, on every replica.
  await closeDeviceSessionKeys({ agentIds: effects.revokedComputers.agentIds, machineIds: effects.revokedComputers.machineIds });
  return { archivedAssistantIds: departed?.agentIds ?? [], detachedComputers: effects.revokedComputers.detached };
}

/**
 * Keep a newly-created owner row aligned with the server-wide setup state (#4883, task #240).
 * Once any owner completed setup (or the Cindy compatibility checkpoint is set), later owners
 * inherit `complete`; setup is not owed independently by every owner.
 *
 * A member BECOMES owner through `updateMemberRole` or `addMember`; pass their `onlyUserId`.
 * The Cindy compatibility checkpoint is set through `updateServerOnboardingAgent` or
 * `updateServerOnboardingSettings`; omit `onlyUserId` to sweep every existing owner. The
 * projection independently derives server completion from any completed owner, so historical
 * incomplete co-owner rows fail open without a data backfill. Rows already `complete` are never
 * touched, so the
 * original owner's `normal` (stamped by `markServerSetupCompleteOnFirstAgent` when they created
 * Cindy) is preserved; newly-reconciled owners are `grandfathered` — they never onboarded, so
 * they are not owed the post-setup survey/handoff either.
 *
 * Must run inside the same executor/transaction as the mutation that changed the set, so the
 * reconciliation cannot be lost to a crash between the two writes.
 */
/**
 * For a server invite or join link (inviteService.admitByInvite), after the
 * SERVER_MEMBERSHIP_ADMISSION lock: the server row FOR UPDATE, at the strength
 * a Guest's promotion (transitionMemberRoleInTransaction) takes it, then the
 * person's member row FOR UPDATE. Their role under those locks, or null.
 */
export async function lockServerMembershipForAdmission(tx: DatabaseTransaction, serverId: string, userId: string): Promise<ServerRole | null> {
  await lockServerForOwnerSetupOrdering(tx, serverId);
  const [member] = await tx
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .for("update");
  return member?.role ?? null;
}

/**
 * Serialize owner-entry against the checkpoint setters on ONE consistent lock order:
 * `servers` row first, then `server_members`. #4883 review found a real lost-update race — the two
 * mutations touch the (owner × checkpoint) set in opposite orders (owner-entry writes
 * `server_members` then reads `servers`; a setter writes `servers` then sweeps `server_members`),
 * so under snapshot isolation each misses the other's uncommitted change and a promoted owner is
 * left `not_started`. Owner-entry calls this BEFORE touching `server_members`; the setters already
 * hold the `servers` row lock via their `UPDATE servers`. Taking the lock here rather than turning
 * the reconcile helper's SELECT into `FOR UPDATE` (which runs AFTER the member write) is deliberate:
 * it keeps the order servers→members everywhere and avoids a reverse-order deadlock.
 */
async function lockServerForOwnerSetupOrdering(db: DatabaseExecutor, serverId: string): Promise<void> {
  await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
    .for("update");
}

export async function reconcileOwnersToSetupCheckpoint(
  db: DatabaseExecutor,
  serverId: string,
  opts: { onlyUserId?: string } = {},
): Promise<void> {
  if (!(await hasServerCompletedSetupForProjection(db, serverId))) return;

  const conditions = [
    eq(serverMembers.serverId, serverId),
    eq(serverMembers.role, "owner"),
    ne(serverMembers.setupStatus, "complete"),
  ];
  if (opts.onlyUserId) conditions.push(eq(serverMembers.userId, opts.onlyUserId));

  await db
    .update(serverMembers)
    .set({ setupStatus: "complete", setupCompletionReason: "grandfathered" })
    .where(and(...conditions));
}

export type ServerMemberRoleTransitionErrorCode =
  | "actor_not_member"
  | "target_not_member"
  | "transition_forbidden"
  | "last_owner"
  /** The locked role is not the caller's expectedRole. */
  | "role_changed";

export class ServerMemberRoleTransitionError extends Error {
  constructor(readonly code: ServerMemberRoleTransitionErrorCode) {
    super(code);
    this.name = "ServerMemberRoleTransitionError";
  }
}

export interface ServerMemberRoleTransitionResult {
  changed: boolean;
  previousRole: ServerRole;
  nextRole: ServerRole;
  removedAllChannelIds: string[];
}

export interface ServerMemberRoleTransitionInput {
  serverId: string;
  actorUserId: string;
  targetUserId: string;
  nextRole: ServerRole;
  /** Refuse (role_changed) unless the target's locked role is this one. */
  expectedRole?: ServerRole;
}

/**
 * The complete server-role cutover boundary. The actor's and the target's
 * users rows first (lockJointUsersFirst; an actor retired or being deleted is
 * refused as a transition they may not make), then the server row, which
 * serializes last-owner decisions and keeps the servers -> server_members
 * lock order used by owner setup.
 */
export async function transitionMemberRole(input: ServerMemberRoleTransitionInput): Promise<ServerMemberRoleTransitionResult> {
  const result = await getDb().transaction(async (tx) => {
    await lockJointUsersFirst(tx, { actorUserId: input.actorUserId, userIds: [input.targetUserId] }).catch((err: unknown) => {
      if (err instanceof JointActorUnavailableError) throw new ServerMemberRoleTransitionError("transition_forbidden");
      throw err;
    });
    return transitionMemberRoleInTransaction(tx, input);
  });
  await finishMemberRoleTransition(input.targetUserId, result);
  return result;
}

/** What a committed transition still owes: app delivery and the target's socket access. */
export async function finishMemberRoleTransition(targetUserId: string, result: ServerMemberRoleTransitionResult): Promise<void> {
  if (result.changed) kickAppNotificationDelivery();
  // Authorized idempotent retries must repair a failed post-commit fanout too.
  await revokeSocketAccess({ userId: targetUserId });
}

/**
 * transitionMemberRole inside a caller's transaction, for a caller whose own
 * write must commit with the role change (a Guest accepting a server invite).
 * The caller runs finishMemberRoleTransition after commit. Its first lock is
 * the actor's and the target's users rows (lockJointUsersFirst; the member
 * row, the audit rows and the joint mirror name both), only locked: the
 * caller has taken them already, before any other lock (transitionMemberRole,
 * admitByInvite), or is the actor's own account retirement, which took the
 * actor's row FOR UPDATE and the promoted person's FOR KEY SHARE before any
 * server row (lockRetirementUsers), so both are re-entrant here and never
 * wait. Then the server row FOR UPDATE: the caller holds no channel,
 * member or invite lock yet, or already holds that server row FOR UPDATE
 * (lockServerMembershipForAdmission), never FOR SHARE (upgrading would
 * deadlock with a removal holding it FOR SHARE and waiting on the member).
 */
export async function transitionMemberRoleInTransaction(
  tx: DatabaseTransaction,
  input: ServerMemberRoleTransitionInput,
): Promise<ServerMemberRoleTransitionResult> {
  await lockJointUsersFirst(tx, { userIds: [input.actorUserId, input.targetUserId] });
  await lockServerForOwnerSetupOrdering(tx, input.serverId);

  const principalIds = [...new Set([input.actorUserId, input.targetUserId])].sort();
  const memberships = await tx
    .select({ userId: serverMembers.userId, role: serverMembers.role })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, input.serverId),
      inArray(serverMembers.userId, principalIds),
    ))
    .orderBy(asc(serverMembers.userId))
    .for("update");
  const actor = memberships.find((membership) => membership.userId === input.actorUserId);
  const target = memberships.find((membership) => membership.userId === input.targetUserId);
  if (!actor) throw new ServerMemberRoleTransitionError("actor_not_member");
  if (!target) throw new ServerMemberRoleTransitionError("target_not_member");
  if (input.expectedRole && target.role !== input.expectedRole) throw new ServerMemberRoleTransitionError("role_changed");

  // A Guest belongs to exactly one channel (#wg-rbac:#15), bound only when an
  // external invite is accepted; a role change cannot bind one, so nobody
  // becomes a Guest this way. Promoting a Guest needs no rollout flag:
  // turning guests off must never strand the ones that exist.
  if (input.nextRole === "guest" && target.role !== "guest") {
    throw new ServerMemberRoleTransitionError("transition_forbidden");
  }

  if (target.role === input.nextRole) {
    const mayManageTarget = actor.role === "owner"
      || (actor.role === "admin"
        && input.actorUserId !== input.targetUserId
        && (target.role === "member" || target.role === "guest")
        && input.nextRole !== "owner");
    if (!mayManageTarget) throw new ServerMemberRoleTransitionError("transition_forbidden");
    return {
      changed: false,
      previousRole: target.role,
      nextRole: input.nextRole,
      removedAllChannelIds: [],
    };
  }

  const [ownerCountRow] = await tx
    .select({ value: count() })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, input.serverId), eq(serverMembers.role, "owner")));
  const ownerCount = Number(ownerCountRow?.value ?? 0);
  if (!canTransitionServerRole({
    actorRole: actor.role,
    targetRole: target.role,
    nextRole: input.nextRole,
    isSelf: input.actorUserId === input.targetUserId,
    ownerCount,
  })) {
    if (actor.role === "owner" && target.role === "owner" && input.nextRole !== "owner" && ownerCount <= 1) {
      throw new ServerMemberRoleTransitionError("last_owner");
    }
    throw new ServerMemberRoleTransitionError("transition_forbidden");
  }

  const mirrorHumans = await prepareJointHumanMembershipMirror(tx, { serverId: input.serverId, userId: input.targetUserId }, "revalidate");
  const removedAllChannelIds: string[] = [];
  if (target.role === "guest" && input.nextRole !== "guest") {
    const entitlement = await getServerBillingEntitlement(tx, input.serverId);
    const usage = await getServerBillingUsage(tx, input.serverId);
    assertHumanCapacityAvailable(entitlement, usage);
  }
  const [updated] = await tx
    .update(serverMembers)
    // A role change never binds a Guest's channel (only accepting an external
    // invite does), and leaving the Guest role clears it in the same write
    // (server_members_guest_channel_only_for_guest); channel memberships stay.
    .set({ role: input.nextRole, guestChannelId: null })
    .where(and(
      eq(serverMembers.serverId, input.serverId),
      eq(serverMembers.userId, input.targetUserId),
      eq(serverMembers.role, target.role),
    ))
    .returning();
  if (!updated) throw new ServerMemberRoleTransitionError("transition_forbidden");
  await mirrorHumans.apply([input.targetUserId], { actorUserId: input.actorUserId });
  // To or from Guest takes or frees a seat (the seat notices show only while
  // full), and any role change changes which notices this person is shown
  // (an owner or admin sees every one, anyone else those they invited).
  await announceSeatJoinBlocksForSeatChange(tx, input.serverId);
  // A Guest's promotion unbinds it from its channel, which may stop being
  // external: the free plan's freeze follows in this commit.
  if (target.role === "guest" && input.nextRole !== "guest") {
    const { reconcileServerExternalFreeze } = await import("./externalChannelFreezeService");
    await reconcileServerExternalFreeze(tx, input.serverId, currentDate(), { clearOnly: true });
  }
  // A guest promoted to member joins #all's audience; the demotion above deletes the row.
  if (target.role === "guest" && input.nextRole !== "guest") {
    await ensureAllChannelHumanRows(tx, input.serverId, { userIds: [input.targetUserId] });
  }

  await tx.insert(serverMemberRoleAuditEvents).values({
    serverId: input.serverId,
    actorUserId: input.actorUserId,
    targetUserId: input.targetUserId,
    previousRole: target.role,
    nextRole: input.nextRole,
  });
  // Dual-write: the role audit table above stays; the server-wide audit table gets the same fact.
  await recordIntegrationAuditEvent({
    serverId: input.serverId,
    eventType: "membership.role_changed",
    outcome: "success",
    source: "web",
    actor: { type: "human", id: input.actorUserId },
    target: { type: "human", id: input.targetUserId },
    metadata: { previousRole: target.role, nextRole: input.nextRole, ...serverAuditContextMetadata({ actorRole: actor.role }) },
    diff: { role: { before: target.role, after: input.nextRole } },
  }, tx);

  if (isOwnerRole(input.nextRole)) {
    await reconcileOwnersToSetupCheckpoint(tx, input.serverId, { onlyUserId: input.targetUserId });
  }
  await emitAppFacingMemberEvents({
    serverId: input.serverId,
    eventType: "server.member_role_changed",
    members: [{ principalType: "human", principalId: input.targetUserId, role: input.nextRole }],
    provenance: { source: "server_service", actor_type: "human", previous_role: target.role },
  }, tx);
  // The Raft License's user limit (source-available only), last: a Guest
  // leaving the role may make one more person count. Other role changes
  // never change who counts.
  if (target.role === "guest") {
    await assertHumanAccountRoom(tx, input.targetUserId, { serverId: input.serverId, previousRole: target.role });
  }
  return {
    changed: true,
    previousRole: target.role,
    nextRole: input.nextRole,
    removedAllChannelIds,
  };
}

/**
 * The onboarding agent is made the server's onboarding agent and given its
 * admin role in one transaction, together with the system-grant audit row, so
 * the role never exists without the record of who gave it. The row carries the
 * real previous role; a re-link that changes nothing records nothing.
 */
export async function grantOnboardingAgentRole(
  serverId: string,
  agentId: string,
  role: Extract<ServerRole, "admin" | "member">,
  options: { executor?: DatabaseTransaction } = {},
): Promise<void> {
  const run = async (tx: DatabaseTransaction) => {
    const previousRole = await getAgentMemberRole(serverId, agentId, tx);
    await updateServerOnboardingAgent(serverId, agentId, { executor: tx });
    await updateAgentMemberRole(serverId, agentId, role, { executor: tx });
    if (previousRole !== role) {
      await recordSystemAgentRoleGrant({ serverId, agentId, nextRole: role, previousRole, grantedBy: "onboarding_agent_created" }, tx);
    }
  };
  if (options.executor) return run(options.executor);
  await getDb().transaction(run);
}

export async function updateAgentMemberRole(
  serverId: string,
  agentId: string,
  role: Extract<ServerRole, "admin" | "member">,
  options: { executor?: DatabaseExecutor } = {},
) {
  const change = async (db: DatabaseExecutor) => {
    const [previous] = await db
      .select({ role: serverAgentMembers.role })
      .from(serverAgentMembers)
      .where(and(eq(serverAgentMembers.serverId, serverId), eq(serverAgentMembers.agentId, agentId)))
      .for("update");
    const [updated] = await db
      .update(serverAgentMembers)
      .set({ role })
      .where(and(eq(serverAgentMembers.serverId, serverId), eq(serverAgentMembers.agentId, agentId)))
      .returning();
    if (updated && previous && previous.role !== role) {
      await emitAppFacingMemberEvents({
        serverId,
        eventType: "server.member_role_changed",
        members: [{ principalType: "agent", principalId: agentId, role }],
        provenance: { source: "server_service", actor_type: "human", previous_role: previous.role },
      }, db);
    }
    return updated || null;
  };
  // With a caller's executor the caller commits, and kicks app delivery after.
  if (options.executor) return change(options.executor);
  const updated = await getDb().transaction(change);
  if (updated) kickAppNotificationDelivery();
  return updated;
}

export async function countOwners(serverId: string) {
  const db = getDb();
  const [row] = await db
    .select({ value: count() })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.role, "owner"),
      isNull(servers.deletedAt),
    ));
  return Number(row?.value ?? 0);
}

export async function getMemberOnboardingPreferences(
  serverId: string,
  userId: string
): Promise<MemberOnboardingPreferences | null> {
  const db = getDb();
  const [member] = await db
    .select({
      setupModalReminderOptOut: serverMembers.setupModalReminderOptOut,
      dismissedAddComputerStepAt: serverMembers.dismissedAddComputerStepAt,
      dismissedCreateAgentStepAt: serverMembers.dismissedCreateAgentStepAt,
      dismissedInviteStepAt: serverMembers.dismissedInviteStepAt,
      dismissedCommunityStepAt: serverMembers.dismissedCommunityStepAt,
      dismissedNotificationStepAt: serverMembers.dismissedNotificationStepAt,
      onboardingWizardCurrentStep: serverMembers.onboardingWizardCurrentStep,
      onboardingDmSentAt: serverMembers.onboardingDmSentAt,
      onboardingDmSentByAgentId: serverMembers.onboardingDmSentByAgentId,
      onboardingOwnerOpenerV2SentAt: serverMembers.onboardingOwnerOpenerV2SentAt,
      onboardingOwnerOpenerV2SentByAgentId: serverMembers.onboardingOwnerOpenerV2SentByAgentId,
      onboardingOwnerOpenerV2MessageIds: serverMembers.onboardingOwnerOpenerV2MessageIds,
      onboardingOwnerOpenerV2Version: serverMembers.onboardingOwnerOpenerV2Version,
      onboardingOwnerOpenerV2Topics: serverMembers.onboardingOwnerOpenerV2Topics,
      crossChannelHintShownAt: serverMembers.crossChannelHintShownAt,
      allChannelUnlockInstructionSentAt: serverMembers.allChannelUnlockInstructionSentAt,
    })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));

  if (!member) return null;
  return {
    setupModalReminderOptOut: !!member.setupModalReminderOptOut,
    dismissedAddComputerStepAt: member.dismissedAddComputerStepAt ?? null,
    dismissedCreateAgentStepAt: member.dismissedCreateAgentStepAt ?? null,
    dismissedInviteStepAt: member.dismissedInviteStepAt ?? null,
    dismissedCommunityStepAt: member.dismissedCommunityStepAt ?? null,
    dismissedNotificationStepAt: member.dismissedNotificationStepAt ?? null,
    onboardingWizardCurrentStep: member.onboardingWizardCurrentStep ?? null,
    onboardingDmSentAt: member.onboardingDmSentAt ?? null,
    onboardingDmSentByAgentId: member.onboardingDmSentByAgentId ?? null,
    onboardingOwnerOpenerV2SentAt: member.onboardingOwnerOpenerV2SentAt ?? null,
    onboardingOwnerOpenerV2SentByAgentId: member.onboardingOwnerOpenerV2SentByAgentId ?? null,
    onboardingOwnerOpenerV2MessageIds: member.onboardingOwnerOpenerV2MessageIds ?? [],
    onboardingOwnerOpenerV2Version: member.onboardingOwnerOpenerV2Version ?? null,
    onboardingOwnerOpenerV2Topics: member.onboardingOwnerOpenerV2Topics ?? [],
    crossChannelHintShownAt: member.crossChannelHintShownAt ?? null,
    allChannelUnlockInstructionSentAt: member.allChannelUnlockInstructionSentAt ?? null,
  };
}

export async function getMemberNotificationPreferences(
  serverId: string,
  userId: string
): Promise<MemberNotificationPreferences | null> {
  const db = getDb();
  const [member] = await db
    .select({
      serverPushMode: serverMembers.serverPushMode,
      // The level counter (services/notifications/settings.ts bumpPrefsVersion) over the legacy column.
      prefsVersion: sql<number>`GREATEST(${serverMembers.notificationPrefsVersion}, COALESCE(${userNotificationLevelVersions.version}, 0))`.mapWith(Number),
    })
    .from(serverMembers)
    .leftJoin(userNotificationLevelVersions, and(
      eq(userNotificationLevelVersions.userId, serverMembers.userId),
      eq(userNotificationLevelVersions.serverId, serverMembers.serverId),
    ))
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));

  if (!member) return null;
  return {
    serverPushMuted: member.serverPushMode === "none",
    serverPushMentionsOnly: member.serverPushMode === "mentions",
    serverPushMode: member.serverPushMode,
    prefsVersion: member.prefsVersion,
    changed: false,
  };
}

/**
 * Legacy server notification write (GET/PATCH /servers/:id/notification-settings,
 * older mobile and web): the same write as PUT /notification-levels with
 * scope `server` (services/notifications/settings.ts setLevel). The answer
 * keeps serverPushMuted / serverPushMentionsOnly, derived from the mode.
 */
export async function updateMemberNotificationPreferences(
  serverId: string,
  userId: string,
  updates: Partial<MemberNotificationPreferences>
): Promise<MemberNotificationPreferences | null> {
  const requestedMode = updates.serverPushMode
    ?? (updates.serverPushMuted === undefined
      ? undefined
      : updates.serverPushMuted ? "none" : "all");
  if (requestedMode === undefined) return getMemberNotificationPreferences(serverId, userId);
  try {
    const result = await setNotificationLevel({ userId, scope: "server", id: serverId, level: requestedMode });
    return {
      serverPushMuted: requestedMode === "none",
      serverPushMentionsOnly: requestedMode === "mentions",
      serverPushMode: requestedMode,
      prefsVersion: result.prefsVersion,
      changed: result.changed,
    };
  } catch (error) {
    if (error instanceof NotificationLevelError && error.status === 404) return null;
    throw error;
  }
}

/** The member's own look in this server (design/foundations/themes.md). */
export interface MemberAppearance {
  /** The stored choice; null is the default, Raft Yellow. */
  theme: RaftThemeId | null;
  themeDecor: boolean;
}

export async function getMemberAppearance(serverId: string, userId: string, db: DatabaseExecutor = getDb()): Promise<MemberAppearance | null> {
  const [member] = await db
    .select({ theme: serverMembers.theme, themeDecor: serverMembers.themeDecor })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  if (!member) return null;
  return { theme: isRaftThemeId(member.theme) ? member.theme : null, themeDecor: member.themeDecor };
}

/**
 * Saves the member's own theme or decorations in this server. A Pro theme is
 * kept on any plan (effectiveRaftTheme shows it as Raft Yellow on Free); the
 * picker offers the upgrade instead of saving it there.
 */
export async function updateMemberAppearance(
  serverId: string,
  userId: string,
  updates: Partial<MemberAppearance>,
  db: DatabaseExecutor = getDb(),
): Promise<MemberAppearance | null> {
  const payload: Partial<typeof serverMembers.$inferInsert> = {};
  if (updates.theme !== undefined) payload.theme = updates.theme === "raft" ? null : updates.theme;
  if (updates.themeDecor !== undefined) payload.themeDecor = updates.themeDecor;
  if (Object.keys(payload).length === 0) return getMemberAppearance(serverId, userId, db);
  const [member] = await db
    .update(serverMembers)
    .set(payload)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .returning({ theme: serverMembers.theme, themeDecor: serverMembers.themeDecor });
  if (!member) return null;
  return { theme: isRaftThemeId(member.theme) ? member.theme : null, themeDecor: member.themeDecor };
}

export function shouldSuppressServerPush(mode: ServerPushMode, mentioned: boolean): boolean {
  return mode === "none" || (mode === "mentions" && !mentioned);
}

/**
 * "Let's Go" — the owner accepting the handoff. Its own durable fact, on the owner's row.
 *
 * Idempotent by construction: the stamp is only written when it is absent, so pressing the
 * button twice (or retrying after a dropped response) keeps the first time it happened.
 * Read by the setup projection; NOT to be confused with the briefing delivery timestamps,
 * which record whether Cindy received her instructions, not whether the human clicked.
 */
export async function markSetupHandoffAcknowledged(
  serverId: string,
  userId: string,
  sessionFamilyId?: string,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx
      .update(serverMembers)
      // The database's clock, not this process's: one ambient clock read fewer, and the stamp
      // comes from the same place every other row's timestamps do.
      .set({ setupHandoffAcknowledgedAt: sql`now()` })
      .where(and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId),
        isNull(serverMembers.setupHandoffAcknowledgedAt),
      ));

    // Account-global and monotonic: only the first final handoff defines the
    // new-user announcement gate. The auth family is durable server evidence
    // that refreshes in this same login must stay suppressed.
    await tx
      .update(users)
      .set({
        firstOnboardingCompletedAt: sql`now()`,
        firstOnboardingCompletedSessionFamilyId: sessionFamilyId ?? null,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(users.id, userId),
        isNull(users.firstOnboardingCompletedAt),
      ));
  });
}

/** The owner answered the setup Pro step. Idempotent: the first answer keeps its time. */
export async function markSetupUpgradePromptSeen(serverId: string, userId: string): Promise<void> {
  await getDb()
    .update(serverMembers)
    .set({ setupUpgradePromptSeenAt: sql`now()` })
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, userId),
      isNull(serverMembers.setupUpgradePromptSeenAt),
    ));
}

/** A claim older than this belongs to a sender that died and can be taken over. */
export const OWNER_OPENER_CLAIM_LEASE_MS = 5 * 60_000;

/**
 * Claim the owner opener for one sender. Returns the claim's token (its
 * time) only to the caller that set it: the opener is unsent and unclaimed
 * (or the claim's lease ran out); null otherwise. Pair with
 * releaseOwnerOpenerClaim(token) on failure; a successful send stamps
 * onboardingOwnerOpenerV2SentAt and the claim no longer matters.
 */
export async function claimOwnerOpener(serverId: string, userId: string, now: Date = currentDate()): Promise<Date | null> {
  const staleBefore = new Date(now.getTime() - OWNER_OPENER_CLAIM_LEASE_MS);
  const rows = await getDb().update(serverMembers)
    .set({ onboardingOwnerOpenerClaimedAt: now })
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, userId),
      isNull(serverMembers.onboardingOwnerOpenerV2SentAt),
      or(isNull(serverMembers.onboardingOwnerOpenerClaimedAt), lt(serverMembers.onboardingOwnerOpenerClaimedAt, staleBefore)),
    ))
    .returning({ claimedAt: serverMembers.onboardingOwnerOpenerClaimedAt });
  return rows[0]?.claimedAt ?? null;
}

/**
 * Release a claim this sender still holds. A slow sender whose lease ran out
 * and was taken over must not clear the new holder's claim, so the release
 * only matches the token its own claim returned.
 */
export async function releaseOwnerOpenerClaim(serverId: string, userId: string, token: Date): Promise<void> {
  await getDb().update(serverMembers)
    .set({ onboardingOwnerOpenerClaimedAt: null })
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, userId),
      eq(serverMembers.onboardingOwnerOpenerClaimedAt, token),
    ));
}

export async function updateMemberOnboardingPreferences(
  serverId: string,
  userId: string,
  updates: Partial<MemberOnboardingPreferences>
): Promise<MemberOnboardingPreferences | null> {
  const db = getDb();
  const payload: Partial<typeof serverMembers.$inferInsert> = {};

  if (updates.setupModalReminderOptOut !== undefined) {
    payload.setupModalReminderOptOut = updates.setupModalReminderOptOut;
  }
  if (updates.dismissedAddComputerStepAt !== undefined) {
    payload.dismissedAddComputerStepAt = updates.dismissedAddComputerStepAt;
  }
  if (updates.dismissedCreateAgentStepAt !== undefined) {
    payload.dismissedCreateAgentStepAt = updates.dismissedCreateAgentStepAt;
  }
  if (updates.dismissedInviteStepAt !== undefined) {
    payload.dismissedInviteStepAt = updates.dismissedInviteStepAt;
  }
  if (updates.dismissedCommunityStepAt !== undefined) {
    payload.dismissedCommunityStepAt = updates.dismissedCommunityStepAt;
  }
  if (updates.dismissedNotificationStepAt !== undefined) {
    payload.dismissedNotificationStepAt = updates.dismissedNotificationStepAt;
  }
  if (updates.onboardingWizardCurrentStep !== undefined) {
    payload.onboardingWizardCurrentStep = updates.onboardingWizardCurrentStep;
  }
  if (updates.onboardingDmSentAt !== undefined) {
    payload.onboardingDmSentAt = updates.onboardingDmSentAt;
  }
  if (updates.onboardingDmSentByAgentId !== undefined) {
    payload.onboardingDmSentByAgentId = updates.onboardingDmSentByAgentId;
  }
  if (updates.onboardingOwnerOpenerV2SentAt !== undefined) {
    payload.onboardingOwnerOpenerV2SentAt = updates.onboardingOwnerOpenerV2SentAt;
  }
  if (updates.onboardingOwnerOpenerV2SentByAgentId !== undefined) {
    payload.onboardingOwnerOpenerV2SentByAgentId = updates.onboardingOwnerOpenerV2SentByAgentId;
  }
  if (updates.onboardingOwnerOpenerV2MessageIds !== undefined) {
    payload.onboardingOwnerOpenerV2MessageIds = updates.onboardingOwnerOpenerV2MessageIds;
  }
  if (updates.onboardingOwnerOpenerV2Version !== undefined) {
    payload.onboardingOwnerOpenerV2Version = updates.onboardingOwnerOpenerV2Version;
  }
  if (updates.onboardingOwnerOpenerV2Topics !== undefined) {
    payload.onboardingOwnerOpenerV2Topics = updates.onboardingOwnerOpenerV2Topics;
  }
  if (updates.crossChannelHintShownAt !== undefined) {
    payload.crossChannelHintShownAt = updates.crossChannelHintShownAt;
  }
  if (updates.allChannelUnlockInstructionSentAt !== undefined) {
    payload.allChannelUnlockInstructionSentAt = updates.allChannelUnlockInstructionSentAt;
  }

  if (Object.keys(payload).length === 0) {
    return getMemberOnboardingPreferences(serverId, userId);
  }

  const [member] = await db
    .update(serverMembers)
    .set(payload)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .returning({
      setupModalReminderOptOut: serverMembers.setupModalReminderOptOut,
      dismissedAddComputerStepAt: serverMembers.dismissedAddComputerStepAt,
      dismissedCreateAgentStepAt: serverMembers.dismissedCreateAgentStepAt,
      dismissedInviteStepAt: serverMembers.dismissedInviteStepAt,
      dismissedCommunityStepAt: serverMembers.dismissedCommunityStepAt,
      dismissedNotificationStepAt: serverMembers.dismissedNotificationStepAt,
      onboardingWizardCurrentStep: serverMembers.onboardingWizardCurrentStep,
      onboardingDmSentAt: serverMembers.onboardingDmSentAt,
      onboardingDmSentByAgentId: serverMembers.onboardingDmSentByAgentId,
      onboardingOwnerOpenerV2SentAt: serverMembers.onboardingOwnerOpenerV2SentAt,
      onboardingOwnerOpenerV2SentByAgentId: serverMembers.onboardingOwnerOpenerV2SentByAgentId,
      onboardingOwnerOpenerV2MessageIds: serverMembers.onboardingOwnerOpenerV2MessageIds,
      onboardingOwnerOpenerV2Version: serverMembers.onboardingOwnerOpenerV2Version,
      onboardingOwnerOpenerV2Topics: serverMembers.onboardingOwnerOpenerV2Topics,
      crossChannelHintShownAt: serverMembers.crossChannelHintShownAt,
      allChannelUnlockInstructionSentAt: serverMembers.allChannelUnlockInstructionSentAt,
    });

  if (!member) return null;
  return {
    setupModalReminderOptOut: !!member.setupModalReminderOptOut,
    dismissedAddComputerStepAt: member.dismissedAddComputerStepAt ?? null,
    dismissedCreateAgentStepAt: member.dismissedCreateAgentStepAt ?? null,
    dismissedInviteStepAt: member.dismissedInviteStepAt ?? null,
    dismissedCommunityStepAt: member.dismissedCommunityStepAt ?? null,
    dismissedNotificationStepAt: member.dismissedNotificationStepAt ?? null,
    onboardingWizardCurrentStep: member.onboardingWizardCurrentStep ?? null,
    onboardingDmSentAt: member.onboardingDmSentAt ?? null,
    onboardingDmSentByAgentId: member.onboardingDmSentByAgentId ?? null,
    onboardingOwnerOpenerV2SentAt: member.onboardingOwnerOpenerV2SentAt ?? null,
    onboardingOwnerOpenerV2SentByAgentId: member.onboardingOwnerOpenerV2SentByAgentId ?? null,
    onboardingOwnerOpenerV2MessageIds: member.onboardingOwnerOpenerV2MessageIds ?? [],
    onboardingOwnerOpenerV2Version: member.onboardingOwnerOpenerV2Version ?? null,
    onboardingOwnerOpenerV2Topics: member.onboardingOwnerOpenerV2Topics ?? [],
    crossChannelHintShownAt: member.crossChannelHintShownAt ?? null,
    allChannelUnlockInstructionSentAt: member.allChannelUnlockInstructionSentAt ?? null,
  };
}

export async function tryClaimAllChannelUnlockInstruction(serverId: string, userId: string, claimedAt: Date): Promise<boolean> {
  const db = getDb();
  const [updated] = await db.update(serverMembers)
    .set({ allChannelUnlockInstructionSentAt: claimedAt })
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, userId),
      isNull(serverMembers.allChannelUnlockInstructionSentAt),
    ))
    .returning({ serverId: serverMembers.serverId });
  return !!updated;
}

export async function clearAllChannelUnlockInstructionClaim(serverId: string, userId: string, claimedAt: Date): Promise<void> {
  const db = getDb();
  await db.update(serverMembers)
    .set({ allChannelUnlockInstructionSentAt: null })
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, userId),
      eq(serverMembers.allChannelUnlockInstructionSentAt, claimedAt),
    ));
}

export async function isMember(serverId: string, userId: string, opts: { traceQuery?: DbQueryTracer } = {}): Promise<boolean> {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const [member] = await traceQuery(
    "servers.member_by_user",
    () => db
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId), isNull(servers.deletedAt))),
  );
  return !!member;
}

export async function getMemberRole(
  serverId: string,
  userId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<ServerRole | null> {
  const db = executor;
  const [member] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId), isNull(servers.deletedAt)));
  return (member?.role as ServerRole | undefined) || null;
}

/**
 * The users among these ids that are members of this (non-deleted) server,
 * by id: getMemberRole + getUser's id and name for a list, in one query.
 */
export async function getServerMemberUsersByIds(
  serverId: string,
  userIds: readonly string[],
): Promise<Map<string, { id: string; name: string }>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: users.id, name: users.name })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.userId, ids), isNull(servers.deletedAt)));
  return new Map(rows.map((row) => [row.id, row]));
}

export async function userCanEditServerSettings(serverId: string, userId: string): Promise<boolean> {
  return hasServerCapability(await getMemberRole(serverId, userId), "editServerSettings");
}

export async function userIsServerOwner(serverId: string, userId: string): Promise<boolean> {
  return isOwnerRole(await getMemberRole(serverId, userId));
}

export async function userIsServerOwnerIncludingDeleted(serverId: string, userId: string): Promise<boolean> {
  const db = getDb();
  const [member] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, userId),
      ne(servers.kind, "joint_storage"),
    ));
  return isOwnerRole(member?.role as ServerRole | undefined);
}

export async function getMemberSidebarOrder(serverId: string, userId: string, opts: { traceQuery?: DbQueryTracer } = {}): Promise<SidebarOrderPreferences | null> {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const [member] = await traceQuery(
    "servers.sidebar_order_by_member",
    () => db
      .select({
        channelOrder: serverMembers.sidebarChannelOrder,
        agentOrder: serverMembers.sidebarAgentOrder,
        dmOrder: serverMembers.sidebarDmOrder,
        channelSortMode: serverMembers.sidebarChannelSortMode,
        jointChannelSortMode: serverMembers.sidebarJointChannelSortMode,
        dmSortMode: serverMembers.sidebarDmSortMode,
        pinnedSortMode: serverMembers.sidebarPinnedSortMode,
        pinned: serverMembers.pinnedRefs,
        pinnedChannelIds: serverMembers.pinnedChannelIds,
        pinnedAgentIds: serverMembers.pinnedAgentIds,
        pinnedOrder: serverMembers.pinnedOrder,
        hiddenDmIds: serverMembers.hiddenDmIds,
        channelPanelTabOrder: serverMembers.channelPanelTabOrder,
        agentPanelTabOrder: serverMembers.agentPanelTabOrder,
        channelSideLayout: serverMembers.channelSideLayout,
        customSections: serverMembers.sidebarCustomSections,
        sectionOrder: serverMembers.sidebarSectionOrder,
        sectionPlacements: serverMembers.sidebarSectionPlacements,
        sectionsVersion: serverMembers.sidebarSectionsVersion,
        pinnedVersion: serverMembers.pinnedVersion,
      })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId))),
  );

  if (!member) return null;

  return {
    channelOrder: toStringArray(member.channelOrder),
    agentOrder: toStringArray(member.agentOrder),
    dmOrder: toStringArray(member.dmOrder),
    channelSortMode: toSidebarSortMode(member.channelSortMode),
    jointChannelSortMode: toSidebarSortMode(member.jointChannelSortMode),
    dmSortMode: toSidebarSortMode(member.dmSortMode),
    pinnedSortMode: toSidebarSortMode(member.pinnedSortMode),
    pinned: toSidebarPinnedRefs(member.pinned),
    pinnedChannelIds: toStringArray(member.pinnedChannelIds),
    pinnedAgentIds: toStringArray(member.pinnedAgentIds),
    pinnedOrder: toStringArray(member.pinnedOrder),
    hiddenDmIds: toStringArray(member.hiddenDmIds),
    channelPanelTabOrder: toStringArray(member.channelPanelTabOrder),
    agentPanelTabOrder: toStringArray(member.agentPanelTabOrder),
    channelSideLayout: parseChannelSideLayout(member.channelSideLayout),
    customSections: toSidebarCustomSections(member.customSections),
    sectionOrder: toStringArray(member.sectionOrder),
    sectionPlacements: toSidebarSectionPlacements(member.sectionPlacements),
    sectionsVersion: Number(member.sectionsVersion) || 0,
    pinnedVersion: Number(member.pinnedVersion) || 0,
  };
}

export async function getSanitizedMemberSidebarOrder(serverId: string, userId: string, opts: { traceQuery?: DbQueryTracer } = {}): Promise<SidebarOrderPreferences | null> {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  // Stored ids are text; turn each into a uuid once (NULL when it is not
  // one) so the existence checks below are primary-key probes. Comparing
  // id::text instead hides the channels/agents primary keys.
  const sidebarElementUuid = sqlUuidOrNull(sql.raw("e.id"));
  const result = await traceQuery(
    "servers.sidebar_order_by_member_sanitized",
    () => db.execute(sql`
      SELECT
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.sidebar_channel_order, '[]'::json)) WITH ORDINALITY e(id, ord)
          CROSS JOIN LATERAL (SELECT ${sidebarElementUuid} AS uid) e_uuid
          WHERE EXISTS (
            SELECT 1
            FROM channels c
            WHERE c.id = e_uuid.uid
              AND c.server_id = ${serverId}
              AND (
                c.type = 'channel'
                OR (
                  c.type IN ('private', 'joint')
                  AND EXISTS (
                    SELECT 1
                    FROM channel_humans ch
                    WHERE ch.channel_id = c.id
                      AND ch.user_id = ${userId}
                  )
                )
              )
              AND c.deleted_at IS NULL
              AND c.archived_at IS NULL
          )
        ), ARRAY[]::text[]) AS "channelOrder",
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.sidebar_agent_order, '[]'::json)) WITH ORDINALITY e(id, ord)
          CROSS JOIN LATERAL (SELECT ${sidebarElementUuid} AS uid) e_uuid
          WHERE EXISTS (
            SELECT 1
            FROM agents a
            WHERE a.id = e_uuid.uid
              AND a.server_id = ${serverId}
              AND a.deleted_at IS NULL
          )
        ), ARRAY[]::text[]) AS "agentOrder",
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.sidebar_dm_order, '[]'::json)) WITH ORDINALITY e(id, ord)
          CROSS JOIN LATERAL (SELECT ${sidebarElementUuid} AS uid) e_uuid
          WHERE EXISTS (
            SELECT 1
            FROM channels c
            INNER JOIN channel_humans ch
              ON ch.channel_id = c.id
             AND ch.user_id = ${userId}
            WHERE c.id = e_uuid.uid
              AND c.server_id = ${serverId}
              AND c.type = 'dm'
          )
        ), ARRAY[]::text[]) AS "dmOrder",
        COALESCE(sm.sidebar_channel_sort_mode, 'manual') AS "channelSortMode",
        COALESCE(sm.sidebar_joint_channel_sort_mode, 'manual') AS "jointChannelSortMode",
        COALESCE(sm.sidebar_dm_sort_mode, 'manual') AS "dmSortMode",
        COALESCE(sm.sidebar_pinned_sort_mode, 'manual') AS "pinnedSortMode",
        sm.pinned_refs AS "pinned",
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.pinned_channel_ids, '[]'::json)) WITH ORDINALITY e(id, ord)
          CROSS JOIN LATERAL (SELECT ${sidebarElementUuid} AS uid) e_uuid
          WHERE EXISTS (
            SELECT 1
            FROM channels c
            WHERE c.id = e_uuid.uid
              AND c.server_id = ${serverId}
              AND (
                c.type = 'channel'
                OR (
                  c.type IN ('private', 'joint')
                  AND EXISTS (
                    SELECT 1
                    FROM channel_humans ch
                    WHERE ch.channel_id = c.id
                      AND ch.user_id = ${userId}
                  )
                )
              )
              AND c.deleted_at IS NULL
              AND c.archived_at IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM channels c
            INNER JOIN channel_humans ch
              ON ch.channel_id = c.id
             AND ch.user_id = ${userId}
            WHERE c.id = e_uuid.uid
              AND c.server_id = ${serverId}
              AND c.type = 'dm'
          )
        ), ARRAY[]::text[]) AS "pinnedChannelIds",
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.pinned_agent_ids, '[]'::json)) WITH ORDINALITY e(id, ord)
          CROSS JOIN LATERAL (SELECT ${sidebarElementUuid} AS uid) e_uuid
          WHERE EXISTS (
            SELECT 1
            FROM agents a
            WHERE a.id = e_uuid.uid
              AND a.server_id = ${serverId}
              AND a.deleted_at IS NULL
          )
        ), ARRAY[]::text[]) AS "pinnedAgentIds",
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.pinned_order, '[]'::json)) WITH ORDINALITY e(id, ord)
          CROSS JOIN LATERAL (SELECT ${sidebarElementUuid} AS uid) e_uuid
          WHERE EXISTS (
            SELECT 1
            FROM channels c
            WHERE c.id = e_uuid.uid
              AND c.server_id = ${serverId}
              AND (
                c.type = 'channel'
                OR (
                  c.type IN ('private', 'joint')
                  AND EXISTS (
                    SELECT 1
                    FROM channel_humans ch
                    WHERE ch.channel_id = c.id
                      AND ch.user_id = ${userId}
                  )
                )
              )
              AND c.deleted_at IS NULL
              AND c.archived_at IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM channels c
            INNER JOIN channel_humans ch
              ON ch.channel_id = c.id
             AND ch.user_id = ${userId}
            WHERE c.id = e_uuid.uid
              AND c.server_id = ${serverId}
              AND c.type = 'dm'
          )
          OR EXISTS (
            SELECT 1
            FROM agents a
            WHERE a.id = e_uuid.uid
              AND a.server_id = ${serverId}
              AND a.deleted_at IS NULL
          )
        ), ARRAY[]::text[]) AS "pinnedOrder",
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.hidden_dm_ids, '[]'::json)) WITH ORDINALITY e(id, ord)
          CROSS JOIN LATERAL (SELECT ${sidebarElementUuid} AS uid) e_uuid
          WHERE EXISTS (
            SELECT 1
            FROM channels c
            INNER JOIN channel_humans ch
              ON ch.channel_id = c.id
             AND ch.user_id = ${userId}
            WHERE c.id = e_uuid.uid
              AND c.server_id = ${serverId}
              AND c.type = 'dm'
          )
          -- A closed agent lounge (#proj-chat:30a58e4d), while it lasts: its
          -- channel and agent are not gone. Who may read it is applied by
          -- the caller (hydrateSidebarPinnedResponse); closing never joins.
          OR EXISTS (
            SELECT 1
            FROM agent_lounges l
            INNER JOIN channels c ON c.id = l.channel_id
            INNER JOIN agents a ON a.id = l.agent_id
            WHERE l.channel_id = e_uuid.uid
              AND l.server_id = ${serverId}
              AND c.server_id = ${serverId}
              AND c.deleted_at IS NULL
              AND c.archived_at IS NULL
              AND a.deleted_at IS NULL
          )
        ), ARRAY[]::text[]) AS "hiddenDmIds",
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.channel_panel_tab_order, '[]'::json)) WITH ORDINALITY e(id, ord)
          WHERE e.id = ANY(ARRAY['chat', 'tasks', 'files']::text[])
        ), ARRAY[]::text[]) AS "channelPanelTabOrder",
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.agent_panel_tab_order, '[]'::json)) WITH ORDINALITY e(id, ord)
          WHERE e.id = ANY(ARRAY['profile', 'chat', 'dms', 'reminders', 'workspace', 'integrations', 'activity', 'usage']::text[])
        ), ARRAY[]::text[]) AS "agentPanelTabOrder",
        COALESCE(sm.pinned_version, 0) AS "pinnedVersion"
        ,COALESCE(sm.sidebar_custom_sections, '[]'::json) AS "customSections"
        ,COALESCE(sm.sidebar_section_order, '[]'::json) AS "sectionOrder"
        ,COALESCE(sm.sidebar_section_placements, '[]'::json) AS "sectionPlacements"
        ,COALESCE(sm.sidebar_sections_version, 0) AS "sectionsVersion"
        ,sm.channel_side_layout AS "channelSideLayout"
      FROM server_members sm
      INNER JOIN servers s
        ON s.id = sm.server_id
       AND s.deleted_at IS NULL
      WHERE sm.server_id = ${serverId}
        AND sm.user_id = ${userId}
    `),
  );

  const row = result.rows[0] as unknown as (Omit<SidebarOrderPreferences, "channelSideLayout"> & { channelSideLayout: unknown }) | undefined;
  // A stored layout that doesn't parse reads as never saved.
  return row ? { ...row, channelSideLayout: parseChannelSideLayout(row.channelSideLayout) } : null;
}

export async function updateMemberSidebarOrder(
  serverId: string,
  userId: string,
  updates: Partial<SidebarOrderPreferences>,
): Promise<SidebarOrderPreferences | null> {
  const db = getDb();
  const payload: Partial<typeof serverMembers.$inferInsert> = {};
  const updatesPinnedState = updates.pinnedSortMode !== undefined
    || updates.pinned !== undefined
    || updates.pinnedChannelIds !== undefined
    || updates.pinnedAgentIds !== undefined
    || updates.pinnedOrder !== undefined;
  const updatesSectionState = updates.customSections !== undefined
    || updates.sectionOrder !== undefined
    || updates.sectionPlacements !== undefined;

  if (updates.channelOrder !== undefined) {
    payload.sidebarChannelOrder = updates.channelOrder;
  }
  if (updates.agentOrder !== undefined) {
    payload.sidebarAgentOrder = updates.agentOrder;
  }
  if (updates.dmOrder !== undefined) {
    payload.sidebarDmOrder = updates.dmOrder;
  }
  if (updates.channelSortMode !== undefined) {
    payload.sidebarChannelSortMode = updates.channelSortMode;
  }
  if (updates.jointChannelSortMode !== undefined) {
    payload.sidebarJointChannelSortMode = updates.jointChannelSortMode;
  }
  if (updates.dmSortMode !== undefined) {
    payload.sidebarDmSortMode = updates.dmSortMode;
  }
  if (updates.pinnedSortMode !== undefined) {
    payload.sidebarPinnedSortMode = updates.pinnedSortMode;
  }
  if (updates.pinned !== undefined) {
    payload.pinnedRefs = updates.pinned;
  }
  if (updates.pinnedChannelIds !== undefined) {
    payload.pinnedChannelIds = updates.pinnedChannelIds;
  }
  if (updates.pinnedAgentIds !== undefined) {
    payload.pinnedAgentIds = updates.pinnedAgentIds;
  }
  if (updates.pinnedOrder !== undefined) {
    payload.pinnedOrder = updates.pinnedOrder;
  }
  if (updates.hiddenDmIds !== undefined) {
    payload.hiddenDmIds = updates.hiddenDmIds;
  }
  if (updates.channelPanelTabOrder !== undefined) {
    payload.channelPanelTabOrder = updates.channelPanelTabOrder;
  }
  if (updates.agentPanelTabOrder !== undefined) {
    payload.agentPanelTabOrder = updates.agentPanelTabOrder;
  }
  if (updates.channelSideLayout !== undefined) {
    payload.channelSideLayout = updates.channelSideLayout;
  }
  if (updates.customSections !== undefined) {
    payload.sidebarCustomSections = updates.customSections;
  }
  if (updates.sectionOrder !== undefined) {
    payload.sidebarSectionOrder = updates.sectionOrder;
  }
  if (updates.sectionPlacements !== undefined) {
    payload.sidebarSectionPlacements = updates.sectionPlacements;
  }
  if (updatesSectionState) {
    payload.sidebarSectionsVersion = sql`${serverMembers.sidebarSectionsVersion} + 1` as unknown as number;
  }
  if (updatesPinnedState) {
    const current = await getMemberSidebarOrder(serverId, userId);
    if (!current) return null;
    const pinnedStateChanged = (
      (updates.pinnedSortMode !== undefined && updates.pinnedSortMode !== current.pinnedSortMode) ||
      (updates.pinned !== undefined && !sidebarPinnedRefsEqual(updates.pinned, current.pinned)) ||
      (updates.pinnedChannelIds !== undefined && !stringArraysEqual(updates.pinnedChannelIds, current.pinnedChannelIds)) ||
      (updates.pinnedAgentIds !== undefined && !stringArraysEqual(updates.pinnedAgentIds, current.pinnedAgentIds)) ||
      (updates.pinnedOrder !== undefined && !stringArraysEqual(updates.pinnedOrder, current.pinnedOrder))
    );
    if (pinnedStateChanged) {
      payload.pinnedVersion = current.pinnedVersion + 1;
    }
  }

  if (Object.keys(payload).length === 0) {
    return getMemberSidebarOrder(serverId, userId);
  }

  const memberPredicate = updatesSectionState && updates.sectionsVersion !== undefined
    ? and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId),
        eq(serverMembers.sidebarSectionsVersion, updates.sectionsVersion),
      )
    : and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId));

  const [member] = await db
    .update(serverMembers)
    .set(payload)
    .where(memberPredicate)
    .returning({
      channelOrder: serverMembers.sidebarChannelOrder,
      agentOrder: serverMembers.sidebarAgentOrder,
      dmOrder: serverMembers.sidebarDmOrder,
      channelSortMode: serverMembers.sidebarChannelSortMode,
      jointChannelSortMode: serverMembers.sidebarJointChannelSortMode,
      dmSortMode: serverMembers.sidebarDmSortMode,
      pinnedSortMode: serverMembers.sidebarPinnedSortMode,
      pinned: serverMembers.pinnedRefs,
      pinnedChannelIds: serverMembers.pinnedChannelIds,
      pinnedAgentIds: serverMembers.pinnedAgentIds,
      pinnedOrder: serverMembers.pinnedOrder,
      hiddenDmIds: serverMembers.hiddenDmIds,
      channelPanelTabOrder: serverMembers.channelPanelTabOrder,
      agentPanelTabOrder: serverMembers.agentPanelTabOrder,
      channelSideLayout: serverMembers.channelSideLayout,
      customSections: serverMembers.sidebarCustomSections,
      sectionOrder: serverMembers.sidebarSectionOrder,
      sectionPlacements: serverMembers.sidebarSectionPlacements,
      sectionsVersion: serverMembers.sidebarSectionsVersion,
      pinnedVersion: serverMembers.pinnedVersion,
    });

  if (!member) return null;

  return {
    channelOrder: toStringArray(member.channelOrder),
    agentOrder: toStringArray(member.agentOrder),
    dmOrder: toStringArray(member.dmOrder),
    channelSortMode: toSidebarSortMode(member.channelSortMode),
    jointChannelSortMode: toSidebarSortMode(member.jointChannelSortMode),
    dmSortMode: toSidebarSortMode(member.dmSortMode),
    pinnedSortMode: toSidebarSortMode(member.pinnedSortMode),
    pinned: toSidebarPinnedRefs(member.pinned),
    pinnedChannelIds: toStringArray(member.pinnedChannelIds),
    pinnedAgentIds: toStringArray(member.pinnedAgentIds),
    pinnedOrder: toStringArray(member.pinnedOrder),
    hiddenDmIds: toStringArray(member.hiddenDmIds),
    channelPanelTabOrder: toStringArray(member.channelPanelTabOrder),
    agentPanelTabOrder: toStringArray(member.agentPanelTabOrder),
    channelSideLayout: parseChannelSideLayout(member.channelSideLayout),
    customSections: toSidebarCustomSections(member.customSections),
    sectionOrder: toStringArray(member.sectionOrder),
    sectionPlacements: toSidebarSectionPlacements(member.sectionPlacements),
    sectionsVersion: Number(member.sectionsVersion) || 0,
    pinnedVersion: Number(member.pinnedVersion) || 0,
  };
}

export async function listServerMemberIds(serverId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(eq(serverMembers.serverId, serverId), isNull(servers.deletedAt)));
  return rows.map((row) => row.userId);
}

/** `options.deletedByUserId`: the owner deleting it, recorded on the joint copies it retires. */
export async function deleteServer(serverId: string, options: { deletedByUserId?: string } = {}) {
  const db = getDb();

  // Keep the provider call outside the database transaction. If it or the
  // module load fails, the server is still visible and the same DELETE can be
  // retried. Stripe failures themselves are best-effort inside the helper,
  // matching the existing deletion contract.
  const { cancelSubscriptionForDeletedServer } = await import("./billingService");
  await cancelSubscriptionForDeletedServer(serverId);

  return db.transaction((tx) => softDeleteServerInTransaction(tx, serverId, options)).then(async (result) => {

    if (result?.announced) kickAppNotificationDelivery();
    return result && { server: result.server, newlyDeleted: result.newlyDeleted };
  });
}

/**
 * deleteServer's transaction: the tombstone, the members' removal announced
 * to apps, the joint mirror and the local billing row, in the caller's
 * transaction. The caller cancels the Stripe subscription (outside any
 * transaction) and, when `announced`, kicks app delivery after commit. Null
 * when there is no such server.
 */
export async function softDeleteServerInTransaction(tx: DatabaseTransaction, serverId: string, options: { deletedByUserId?: string } = {}) {
  const [existing] = await tx
    .select()
    .from(servers)
    .where(and(eq(servers.id, serverId), ne(servers.kind, "joint_storage")))
    .for("update");
  if (!existing) return null;
  const mirrorHumans = await prepareJointHumanMembershipMirror(tx, { serverId }, "retire");

  // Announce every member's removal before the tombstone, in the same commit.
  const announced = existing.deletedAt == null
    ? await announceServerDeletionToApps(tx, serverId)
    : false;

  const [updated] = existing.deletedAt == null
    ? await tx
      .update(servers)
      .set({ deletedAt: new Date() })
      .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
      .returning()
    : [];

  // An account deletion's cleanup passes no person: the system retires them.
  await mirrorHumans.apply(undefined, options.deletedByUserId ? { actorUserId: options.deletedByUserId } : {});

  // Nothing in a deleted server mirrors to WeChat (its members can no longer
  // reach Disconnect): its bindings, their tokens and its QR attempts go.
  await removeWeChatBridgeOfDeletedServer(tx, { serverId });

  // The local billing row and tombstone are one commit. A failure here rolls
  // the tombstone back instead of hiding a half-deleted server from retries.
  await tx.delete(subscriptions).where(eq(subscriptions.serverId, serverId));

  return {
    server: updated ?? existing,
    newlyDeleted: Boolean(updated),
    announced,
  };
}

async function announceServerDeletionToApps(tx: DatabaseExecutor, serverId: string): Promise<boolean> {
  const [humans, agentMembers] = await Promise.all([
    tx.select({ principalId: serverMembers.userId, role: serverMembers.role })
      .from(serverMembers).where(eq(serverMembers.serverId, serverId)),
    tx.select({ principalId: serverAgentMembers.agentId, role: serverAgentMembers.role })
      .from(serverAgentMembers).where(eq(serverAgentMembers.serverId, serverId)),
  ]);
  const { recipientCount } = await emitAppFacingMemberEvents({
    serverId,
    eventType: "server.member_removed",
    members: [
      ...humans.map((member) => ({ principalType: "human" as const, ...member })),
      ...agentMembers.map((member) => ({ principalType: "agent" as const, ...member })),
    ],
    provenance: { source: "server_service", actor_type: "human", reason: "server_deleted" },
  }, tx);
  return recipientCount > 0;
}
