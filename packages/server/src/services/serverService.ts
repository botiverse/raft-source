import { revokeSocketAccess } from "../socket/accessRevocation.js";
import { createHash } from "crypto";
import { eq, and, asc, isNull, inArray, sql, count, ne } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import { CURRENT_CONTRACT_VERSION } from "./serverSetupStateService.js";
import { servers, serverMembers, serverMembershipDepartures, serverMemberRoleAuditEvents, serverAgentMembers, users, channels, channelHumans, messages, agents, subscriptions, threadFollows } from "../db/schema.js";
import { ALL_CHANNEL_TEAM_THRESHOLD, canTransitionServerRole, currentDate, hasServerCapability, isAdminOrOwner, isOwnerRole, type ServerRole } from "@botiverse/raft-shared";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace.js";
import * as serverAgreementService from "./serverAgreementService.js";
import { refreshSubscriptionForServerIfStale } from "./billingService.js";
import { assertHumanCapacityAvailable, getServerBillingEntitlement, getServerBillingUsage } from "./planService.js";
import { evaluateFeatureFlag, ONBOARDING_OWNER_WIZARD_FEATURE_FLAG_KEY } from "./featureFlagService.js";

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
  reason?: ServerMembershipDepartureReason;
  actorUserId?: string | null;
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

    const openerFlag = await evaluateFeatureFlag({ key: "onboarding_opener_v2", serverId: server.id }, tx);

    // Auto-create virtual #all channel. Its audience is derived from server membership.
    // When the onboarding opener is enabled, #all starts hidden (type=private) and is
    // unlocked when the 2nd agent is created on the server.
    await tx.insert(channels).values({
      serverId: server.id,
      name: "all",
      description: "General channel for all members",
      type: openerFlag.enabled ? "private" : "channel",
    });

    if (openerFlag.enabled) {
      const [ownerChannel] = await tx.insert(channels).values({
        serverId: server.id,
        name: "onboarding-owner",
        description: "Your private onboarding space",
        type: "private",
      }).returning();
      await tx.insert(channelHumans).values({
        channelId: ownerChannel.id,
        userId: ownerId,
      });
    }

    return server;
  });
}

export async function getServer(serverId: string) {
  const db = getDb();
  const [server] = await db.select().from(servers).where(and(eq(servers.id, serverId), ne(servers.kind, "joint_storage"), isNull(servers.deletedAt)));
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
        serverPushMuted: serverMembers.serverPushMuted,
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

export async function updateServerOnboardingAgent(serverId: string, onboardingAgentId: string | null) {
  return getDb().transaction(async (tx) => {
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
  });
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

export async function updateServerProfile(serverId: string, updates: ServerProfileUpdates) {
  const db = getDb();
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

export async function getServerMembers(serverId: string, requesterId: string | null) {
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
    .where(eq(serverMembers.serverId, serverId))
    .orderBy(asc(serverMembers.joinedAt));

  const requesterRole = requesterId ? await getMemberRole(serverId, requesterId) : null;
  const canSeeAllEmails = isAdminOrOwner(requesterRole);

  return rows.map(({ email, ...rest }) => ({
    ...rest,
    email: canSeeAllEmails || (requesterId !== null && rest.userId === requesterId) ? email : null,
    gravatarHash: createHash("sha256").update(email.trim().toLowerCase()).digest("hex"),
  }));
}

export async function getAgentMemberRole(
  serverId: string,
  agentId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<ServerRole | null> {
  const db = executor;
  const [member] = await db
    .select({ role: serverAgentMembers.role })
    .from(serverAgentMembers)
    .innerJoin(agents, eq(serverAgentMembers.agentId, agents.id))
    .where(and(
      eq(serverAgentMembers.serverId, serverId),
      eq(serverAgentMembers.agentId, agentId),
      eq(agents.serverId, serverId),
      isNull(agents.deletedAt),
    ));
  return (member?.role as ServerRole | undefined) || null;
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
    gravatarHash: createHash("sha256").update(user.email.trim().toLowerCase()).digest("hex"),
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

    const entitlement = await getServerBillingEntitlement(db, serverId);
    const usage = await getServerBillingUsage(db, serverId);
    assertHumanCapacityAvailable(entitlement, usage);

    const [inserted] = await db.insert(serverMembers).values({
      serverId,
      userId,
      role,
    }).onConflictDoNothing().returning({ userId: serverMembers.userId });

    if (inserted) {
      await db.delete(serverMembershipDepartures).where(and(
        eq(serverMembershipDepartures.serverId, serverId),
        eq(serverMembershipDepartures.userId, userId),
      ));
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
    if (inserted) {
      const openerFlag = await evaluateFeatureFlag({ key: "onboarding_opener_v2", serverId }, db);
      if (openerFlag.enabled) {
        const [{ agentCount }] = await db
          .select({ agentCount: sql<number>`count(*)::int` })
          .from(agents)
          .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)));
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
          }
        }
      }
    }

    return !!inserted;
  };

  if (options.executor) {
    return run(options.executor);
  }

  return getDb().transaction(run);
}

export async function removeMember(serverId: string, userId: string, options: RemoveMemberOptions = {}) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const serverChannelIds = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.serverId, serverId), isNull(channels.deletedAt)));

    if (serverChannelIds.length > 0) {
      await tx.execute(sql`
        DELETE FROM ${threadFollows}
        WHERE ${threadFollows.followerType} = 'user'
          AND ${threadFollows.followerId} = ${userId}
          AND EXISTS (
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
      `);

      await tx.delete(channelHumans).where(
        and(
          eq(channelHumans.userId, userId),
          inArray(channelHumans.channelId, serverChannelIds.map((row) => row.id)),
        )
      );
    }

    const departedAt = currentDate();
    await tx.insert(serverMembershipDepartures).values({
      serverId,
      userId,
      reason: options.reason ?? "removed",
      actorUserId: options.actorUserId ?? null,
      departedAt,
    }).onConflictDoUpdate({
      target: [serverMembershipDepartures.serverId, serverMembershipDepartures.userId],
      set: {
        reason: options.reason ?? "removed",
        actorUserId: options.actorUserId ?? null,
        departedAt,
      },
    });

    await tx.delete(serverMembers).where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, userId),
    ));
  });
  await revokeSocketAccess({ userId });
}

/**
 * The onboarding invariant, enforced in one place (#4883): on a server that has crossed the
 * Cindy checkpoint (`onboarding_agent_id` set — the same fact the projection reads as
 * `everHadAgent`), every `role='owner'` member row must be `complete`. Setup is owner-only, so a
 * non-complete owner row is exactly what the projection turns into a stuck, undismissable
 * "Meet Cindy" for an agent that already exists.
 *
 * The `(owner × checkpoint-crossed)` set changes through four write paths, and all four call
 * this: a member BECOMES owner (`updateMemberRole` promote, `addMember` direct add) — pass their
 * `onlyUserId`; and the checkpoint is FIRST crossed (`updateServerOnboardingAgent` and
 * `updateServerOnboardingSettings`) — omit `onlyUserId` to sweep every existing owner. Rows
 * already `complete` are never touched, so the
 * original owner's `normal` (stamped by `markServerSetupCompleteOnFirstAgent` when they created
 * Cindy) is preserved; newly-reconciled owners are `grandfathered` — they never onboarded, so
 * they are not owed the post-setup survey/handoff either.
 *
 * Must run inside the same executor/transaction as the mutation that changed the set, so the
 * reconciliation cannot be lost to a crash between the two writes.
 */
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
  const [server] = await db
    .select({ onboardingAgentId: servers.onboardingAgentId })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
  if (!server?.onboardingAgentId) return;

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
  | "last_owner";

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

/**
 * The complete server-role cutover boundary. The server row is the first lock
 * for every transition, serializing last-owner decisions and preserving the
 * existing servers -> server_members lock order used by owner setup.
 */
export async function transitionMemberRole(input: {
  serverId: string;
  actorUserId: string;
  targetUserId: string;
  nextRole: ServerRole;
  guestTransitionsEnabled: boolean;
}): Promise<ServerMemberRoleTransitionResult> {
  const result = await getDb().transaction(async (tx) => {
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

    if (!input.guestTransitionsEnabled && (target.role === "guest" || input.nextRole === "guest")) {
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

    const removedAllChannelIds: string[] = [];
    if (input.nextRole === "guest") {
      const serverChannelRows = await tx
        .select({ id: channels.id, name: channels.name })
        .from(channels)
        .where(eq(channels.serverId, input.serverId));
      const allChannelIds = serverChannelRows
        .filter((channel) => channel.name === "all")
        .map((channel) => channel.id);
      if (allChannelIds.length > 0) {
        const removed = await tx.delete(channelHumans).where(and(
          eq(channelHumans.userId, input.targetUserId),
          inArray(channelHumans.channelId, allChannelIds),
        )).returning({ channelId: channelHumans.channelId });
        removedAllChannelIds.push(...removed.map((row) => row.channelId));
      }

      // Preserve every non-#all membership, but revoke all stored admin authority, including
      // legacy rows on deleted or currently unsupported channel shapes.
      const nonAllChannelIds = serverChannelRows
        .filter((channel) => channel.name !== "all")
        .map((channel) => channel.id);
      if (nonAllChannelIds.length > 0) {
        await tx.update(channelHumans).set({
          role: "member",
          authorityRevision: sql`${channelHumans.authorityRevision} + 1`,
        }).where(and(
          eq(channelHumans.userId, input.targetUserId),
          eq(channelHumans.role, "admin"),
          inArray(channelHumans.channelId, nonAllChannelIds),
        ));
      }
    }

    const [updated] = await tx
      .update(serverMembers)
      .set({ role: input.nextRole })
      .where(and(
        eq(serverMembers.serverId, input.serverId),
        eq(serverMembers.userId, input.targetUserId),
        eq(serverMembers.role, target.role),
      ))
      .returning();
    if (!updated) throw new ServerMemberRoleTransitionError("transition_forbidden");

    await tx.insert(serverMemberRoleAuditEvents).values({
      serverId: input.serverId,
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId,
      previousRole: target.role,
      nextRole: input.nextRole,
    });

    if (isOwnerRole(input.nextRole)) {
      await reconcileOwnersToSetupCheckpoint(tx, input.serverId, { onlyUserId: input.targetUserId });
    }
    return {
      changed: true,
      previousRole: target.role,
      nextRole: input.nextRole,
      removedAllChannelIds,
    };
  });
  // Authorized idempotent retries must repair a failed post-commit fanout too.
  await revokeSocketAccess({ userId: input.targetUserId });
  return result;
}

export async function updateAgentMemberRole(serverId: string, agentId: string, role: Extract<ServerRole, "admin" | "member">) {
  const db = getDb();
  const [updated] = await db
    .update(serverAgentMembers)
    .set({ role })
    .where(and(eq(serverAgentMembers.serverId, serverId), eq(serverAgentMembers.agentId, agentId)))
    .returning();
  return updated || null;
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
      prefsVersion: serverMembers.notificationPrefsVersion,
    })
    .from(serverMembers)
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

export async function updateMemberNotificationPreferences(
  serverId: string,
  userId: string,
  updates: Partial<MemberNotificationPreferences>
): Promise<MemberNotificationPreferences | null> {
  const db = getDb();
  const payload: Partial<typeof serverMembers.$inferInsert> = {};
  const current = await getMemberNotificationPreferences(serverId, userId);
  if (!current) return null;

  const requestedMode = updates.serverPushMode
    ?? (updates.serverPushMuted === undefined
      ? undefined
      : updates.serverPushMuted ? "none" : "all");
  if (requestedMode !== undefined) {
    if (requestedMode === current.serverPushMode) {
      return { ...current, changed: false };
    }
    payload.serverPushMode = requestedMode;
    // Rolling-deploy compatibility: old binaries still read/write the legacy boolean.
    // The migration trigger also keeps old-writer updates synchronized back to mode.
    payload.serverPushMuted = requestedMode === "none";
    payload.notificationPrefsVersion = sql`${serverMembers.notificationPrefsVersion} + 1` as unknown as number;
  }

  if (Object.keys(payload).length === 0) {
    return current;
  }

  const [member] = await db
    .update(serverMembers)
    .set(payload)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .returning({
      serverPushMode: serverMembers.serverPushMode,
      prefsVersion: serverMembers.notificationPrefsVersion,
    });

  if (!member) return null;
  return {
    serverPushMuted: member.serverPushMode === "none",
    serverPushMentionsOnly: member.serverPushMode === "mentions",
    serverPushMode: member.serverPushMode,
    prefsVersion: member.prefsVersion,
    changed: true,
  };
}

export function shouldSuppressServerPush(mode: ServerPushMode, mentioned: boolean): boolean {
  return mode === "none" || (mode === "mentions" && !mentioned);
}

export async function getServerPushMutedUserIds(serverId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const db = getDb();
  const rows = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.serverPushMode, "none"),
      inArray(serverMembers.userId, userIds),
    ));

  return new Set(rows.map((row) => row.userId));
}

export async function getServerPushSuppressedUserIds(
  serverId: string,
  userIds: string[],
  mentionedUserIds: ReadonlySet<string>,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const db = getDb();
  const rows = await db
    .select({
      userId: serverMembers.userId,
      serverPushMode: serverMembers.serverPushMode,
    })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, serverId),
      inArray(serverMembers.userId, userIds),
    ));

  return new Set(
    rows
      .filter((row) => shouldSuppressServerPush(
        row.serverPushMode,
        mentionedUserIds.has(row.userId),
      ))
      .map((row) => row.userId),
  );
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
  const result = await traceQuery(
    "servers.sidebar_order_by_member_sanitized",
    () => db.execute(sql`
      SELECT
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.sidebar_channel_order, '[]'::json)) WITH ORDINALITY e(id, ord)
          WHERE EXISTS (
            SELECT 1
            FROM channels c
            WHERE c.id::text = e.id
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
          WHERE EXISTS (
            SELECT 1
            FROM agents a
            WHERE a.id::text = e.id
              AND a.server_id = ${serverId}
              AND a.deleted_at IS NULL
          )
        ), ARRAY[]::text[]) AS "agentOrder",
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.sidebar_dm_order, '[]'::json)) WITH ORDINALITY e(id, ord)
          WHERE EXISTS (
            SELECT 1
            FROM channels c
            INNER JOIN channel_humans ch
              ON ch.channel_id = c.id
             AND ch.user_id = ${userId}
            WHERE c.id::text = e.id
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
          WHERE EXISTS (
            SELECT 1
            FROM channels c
            WHERE c.id::text = e.id
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
            WHERE c.id::text = e.id
              AND c.server_id = ${serverId}
              AND c.type = 'dm'
          )
        ), ARRAY[]::text[]) AS "pinnedChannelIds",
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.pinned_agent_ids, '[]'::json)) WITH ORDINALITY e(id, ord)
          WHERE EXISTS (
            SELECT 1
            FROM agents a
            WHERE a.id::text = e.id
              AND a.server_id = ${serverId}
              AND a.deleted_at IS NULL
          )
        ), ARRAY[]::text[]) AS "pinnedAgentIds",
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.pinned_order, '[]'::json)) WITH ORDINALITY e(id, ord)
          WHERE EXISTS (
            SELECT 1
            FROM channels c
            WHERE c.id::text = e.id
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
            WHERE c.id::text = e.id
              AND c.server_id = ${serverId}
              AND c.type = 'dm'
          )
          OR EXISTS (
            SELECT 1
            FROM agents a
            WHERE a.id::text = e.id
              AND a.server_id = ${serverId}
              AND a.deleted_at IS NULL
          )
        ), ARRAY[]::text[]) AS "pinnedOrder",
        COALESCE((
          SELECT array_agg(id ORDER BY ord)
          FROM json_array_elements_text(COALESCE(sm.hidden_dm_ids, '[]'::json)) WITH ORDINALITY e(id, ord)
          WHERE EXISTS (
            SELECT 1
            FROM channels c
            INNER JOIN channel_humans ch
              ON ch.channel_id = c.id
             AND ch.user_id = ${userId}
            WHERE c.id::text = e.id
              AND c.server_id = ${serverId}
              AND c.type = 'dm'
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
          WHERE e.id = ANY(ARRAY['profile', 'chat', 'dms', 'reminders', 'workspace', 'integrations', 'activity']::text[])
        ), ARRAY[]::text[]) AS "agentPanelTabOrder",
        COALESCE(sm.pinned_version, 0) AS "pinnedVersion"
        ,COALESCE(sm.sidebar_custom_sections, '[]'::json) AS "customSections"
        ,COALESCE(sm.sidebar_section_order, '[]'::json) AS "sectionOrder"
        ,COALESCE(sm.sidebar_section_placements, '[]'::json) AS "sectionPlacements"
        ,COALESCE(sm.sidebar_sections_version, 0) AS "sectionsVersion"
      FROM server_members sm
      INNER JOIN servers s
        ON s.id = sm.server_id
       AND s.deleted_at IS NULL
      WHERE sm.server_id = ${serverId}
        AND sm.user_id = ${userId}
    `),
  );

  const row = result.rows[0] as unknown as SidebarOrderPreferences | undefined;
  return row ?? null;
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

export async function deleteServer(serverId: string) {
  const db = getDb();

  // Keep the provider call outside the database transaction. If it or the
  // module load fails, the server is still visible and the same DELETE can be
  // retried. Stripe failures themselves are best-effort inside the helper,
  // matching the existing deletion contract.
  const { cancelSubscriptionForDeletedServer } = await import("./billingService.js");
  await cancelSubscriptionForDeletedServer(serverId);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), ne(servers.kind, "joint_storage")));
    if (!existing) return null;

    const [updated] = existing.deletedAt == null
      ? await tx
        .update(servers)
        .set({ deletedAt: new Date() })
        .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
        .returning()
      : [];

    // The local billing row and tombstone are one commit. A failure here rolls
    // the tombstone back instead of hiding a half-deleted server from retries.
    await tx.delete(subscriptions).where(eq(subscriptions.serverId, serverId));

    return {
      server: updated ?? existing,
      newlyDeleted: Boolean(updated),
    };
  });
}
