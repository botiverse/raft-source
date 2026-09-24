import { createHash } from "node:crypto";
import { eq, and, isNull, sql, inArray } from "drizzle-orm";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index.js";
import { servers, agents, machines, channels, jointChannels, jointChannelServers, messages, serverMembers, subscriptions } from "../db/schema.js";
import {
  PLAN_CONFIG,
  canUseProBillingFeatures,
  currentDate,
  formatBillingCapacityLimitMessage,
  getBillingCapacity,
  getBillingCapacityLimitState,
  getBillingUsage,
  getEffectiveLimits,
  type BillingCapacity,
  type BillingEntitlementProjection,
  type BillingUsage,
  type ServerPlan,
} from "@botiverse/raft-shared";

/** Get the plan for a server. */
export async function getServerPlan(serverId: string): Promise<ServerPlan> {
  const db = getDb();
  const [row] = await db
    .select({ plan: servers.plan })
    .from(servers)
    .where(eq(servers.id, serverId));
  return (row?.plan as ServerPlan) || "free";
}

function isSubscriptionEntitling(status: string): boolean {
  return status === "active" || status === "past_due";
}

function isInternalEntitlementPlan(plan: ServerPlan): boolean {
  return plan === "founder" || plan === "partner";
}

export type ServerBillingEntitlement = BillingEntitlementProjection & {
  source: "server" | "subscription";
  capacity: BillingCapacity;
};

type ServerBillingEntitlementRow = {
  serverId: string;
  serverPlan: ServerPlan;
  subscriptionPlan: "pro" | null;
  status: BillingEntitlementProjection["status"];
  billingInterval: BillingEntitlementProjection["billingInterval"];
  provisionedHumanSeats: number | null;
  provisionedAgentSeats: number | null;
  proPackQuantity: number | null;
  trialFreePackQuantity: number | null;
  firstPackTrialEndsAt: Date | null;
};

function projectServerBillingEntitlement(
  row: ServerBillingEntitlementRow | undefined,
  now: Date,
): ServerBillingEntitlement {
  const fallbackPlan = (row?.serverPlan as ServerPlan | undefined) ?? "free";
  const hasSubscription = Boolean(row?.subscriptionPlan);
  const hasEntitlingSubscription = Boolean(row?.subscriptionPlan && row.status && isSubscriptionEntitling(row.status));
  const hasInternalEntitlement = isInternalEntitlementPlan(fallbackPlan);
  const plan = (hasInternalEntitlement
    ? fallbackPlan
    : hasEntitlingSubscription
    ? row?.subscriptionPlan
    : hasSubscription
      ? "free"
      : fallbackPlan) as ServerPlan;
  const projection: BillingEntitlementProjection = {
    plan,
    status: row?.status ?? null,
    billingInterval: hasEntitlingSubscription && !hasInternalEntitlement ? row?.billingInterval ?? null : null,
    provisionedHumanSeats: hasEntitlingSubscription && !hasInternalEntitlement ? row?.provisionedHumanSeats ?? null : null,
    provisionedAgentSeats: hasEntitlingSubscription && !hasInternalEntitlement ? row?.provisionedAgentSeats ?? null : null,
    proPackQuantity: hasEntitlingSubscription && !hasInternalEntitlement ? row?.proPackQuantity ?? null : null,
    trialFreePackQuantity: hasEntitlingSubscription && !hasInternalEntitlement ? row?.trialFreePackQuantity ?? null : null,
    firstPackTrialEndsAt: hasEntitlingSubscription && !hasInternalEntitlement ? row?.firstPackTrialEndsAt ?? null : null,
  };

  return {
    ...projection,
    source: hasEntitlingSubscription && !hasInternalEntitlement ? "subscription" : "server",
    capacity: getBillingCapacity(projection, now),
  };
}

/** Batch entitlement read used by feature-flag evaluation to avoid per-flag N+1. */
export async function getServerBillingEntitlements(
  executor: DatabaseExecutor,
  serverIds: readonly string[],
  now: Date = currentDate(),
): Promise<Map<string, ServerBillingEntitlement>> {
  const uniqueServerIds = [...new Set(serverIds.filter(Boolean))];
  if (uniqueServerIds.length === 0) return new Map();

  const rows = await executor
    .select({
      serverId: servers.id,
      serverPlan: servers.plan,
      subscriptionPlan: subscriptions.plan,
      status: subscriptions.status,
      billingInterval: subscriptions.billingInterval,
      provisionedHumanSeats: subscriptions.provisionedHumanSeats,
      provisionedAgentSeats: subscriptions.provisionedAgentSeats,
      proPackQuantity: subscriptions.proPackQuantity,
      trialFreePackQuantity: subscriptions.trialFreePackQuantity,
      firstPackTrialEndsAt: subscriptions.firstPackTrialEndsAt,
    })
    .from(servers)
    .leftJoin(subscriptions, eq(subscriptions.serverId, servers.id))
    .where(and(inArray(servers.id, uniqueServerIds), isNull(servers.deletedAt)));

  const rowByServerId = new Map(rows.map((row) => [row.serverId, row]));
  return new Map(uniqueServerIds.map((serverId) => [
    serverId,
    projectServerBillingEntitlement(rowByServerId.get(serverId), now),
  ]));
}

export async function getServerBillingEntitlement(
  executor: DatabaseExecutor,
  serverId: string,
  now: Date = new Date(),
): Promise<ServerBillingEntitlement> {
  const entitlements = await getServerBillingEntitlements(executor, [serverId], now);
  return entitlements.get(serverId) ?? projectServerBillingEntitlement(undefined, now);
}

export async function getServerBillingUsage(
  executor: DatabaseExecutor,
  serverId: string,
): Promise<BillingUsage> {
  const [humanRow] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(serverMembers)
    .where(eq(serverMembers.serverId, serverId));
  const [agentRow] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)));
  return getBillingUsage(humanRow?.count ?? 0, agentRow?.count ?? 0);
}

export function assertHumanCapacityAvailable(
  entitlement: ServerBillingEntitlement,
  usage: BillingUsage,
): void {
  const limitState = getBillingCapacityLimitState(entitlement.capacity, usage, "human");
  if (limitState.reached) {
    throw new Error(formatBillingCapacityLimitMessage("human", limitState, PLAN_CONFIG[entitlement.plan].displayName));
  }
}

export function assertAgentCapacityAvailable(
  entitlement: ServerBillingEntitlement,
  usage: BillingUsage,
): void {
  const limitState = getBillingCapacityLimitState(entitlement.capacity, usage, "agent");
  if (limitState.reached) {
    throw new Error(formatBillingCapacityLimitMessage("agent", limitState, PLAN_CONFIG[entitlement.plan].displayName, " Upgrade for more."));
  }
}

async function refreshSubscriptionBeforeEntitlementGate(serverId: string, now: Date): Promise<void> {
  const { refreshSubscriptionForServerIfStale } = await import("./billingService.js");
  await refreshSubscriptionForServerIfStale(serverId, now);
}

async function hasEntitledJointChannelParticipant(
  executor: DatabaseExecutor,
  jointChannelId: string,
  now: Date,
): Promise<boolean> {
  const [jointChannel] = await executor
    .select({ createdByServerId: jointChannels.createdByServerId })
    .from(jointChannels)
    .where(and(
      eq(jointChannels.id, jointChannelId),
      eq(jointChannels.status, "active"),
    ))
    .limit(1);
  if (jointChannel) {
    const [freeJointChannel] = await executor
      .select({ id: jointChannels.id })
      .from(jointChannels)
      .where(and(
        eq(jointChannels.createdByServerId, jointChannel.createdByServerId),
        eq(jointChannels.status, "active"),
      ))
      .orderBy(jointChannels.createdAt, jointChannels.id)
      .limit(1);
    if (freeJointChannel?.id === jointChannelId) return true;
  }

  const activeParticipants = await executor
    .select({ serverId: jointChannelServers.serverId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannelServers.jointChannelId, jointChannelId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ));

  for (const participant of activeParticipants) {
    await refreshSubscriptionBeforeEntitlementGate(participant.serverId, now);
    const entitlement = await getServerBillingEntitlement(executor, participant.serverId, now);
    if (canUseProBillingFeatures(entitlement.plan, now)) {
      return true;
    }
  }
  return false;
}

async function getActiveJointChannelIdForLocalProjection(
  executor: DatabaseExecutor,
  localChannelId: string,
  serverId: string,
): Promise<string | null> {
  const [projection] = await executor
    .select({ jointChannelId: jointChannelServers.jointChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannelServers.localChannelId, localChannelId),
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ))
    .limit(1);
  return projection?.jointChannelId ?? null;
}

export async function requireTeamBillingFeature(
  executor: DatabaseExecutor,
  serverId: string,
  featureName: string,
  now: Date = new Date(),
): Promise<void> {
  await refreshSubscriptionBeforeEntitlementGate(serverId, now);
  const entitlement = await getServerBillingEntitlement(executor, serverId, now);
  if (!canUseProBillingFeatures(entitlement.plan, now)) {
    throw new Error(`${featureName} requires the Pro plan.`);
  }
}

export type JointChannelCreationEntitlement = "plan" | "free";

/** Resolve whether a server may create unlimited or one free active Joint Channel. */
export async function getJointChannelCreationEntitlement(
  executor: DatabaseExecutor,
  serverId: string,
  now: Date = currentDate(),
): Promise<JointChannelCreationEntitlement> {
  await refreshSubscriptionBeforeEntitlementGate(serverId, now);
  const entitlement = await getServerBillingEntitlement(executor, serverId, now);
  if (canUseProBillingFeatures(entitlement.plan, now)) {
    return "plan";
  }
  return "free";
}

/** Enforce the single active host-created Joint Channel limit for Free servers. */
export async function assertJointChannelCreationCapacity(
  executor: DatabaseExecutor,
  serverId: string,
  entitlement: JointChannelCreationEntitlement,
): Promise<void> {
  if (entitlement === "plan") return;
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(jointChannels)
    .where(and(
      eq(jointChannels.createdByServerId, serverId),
      eq(jointChannels.status, "active"),
    ));
  if ((row?.count ?? 0) >= 1) {
    throw new Error("Creating a second Joint Channel requires the Pro plan.");
  }
}

/** Count agents in a server. */
export async function countAgents(serverId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)));
  return row?.count ?? 0;
}

/** Count non-deleted regular channels in a server (includes system #all). */
export async function countChannels(serverId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(channels)
    .where(and(eq(channels.serverId, serverId), inArray(channels.type, ["channel", "private"]), isNull(channels.deletedAt)));
  return row?.count ?? 0;
}

/**
 * Check if a channel is read-only due to quota.
 * When a server has more channels than the plan allows, the newest channels
 * (beyond the limit) become read-only. Oldest N channels remain writable.
 */
export async function isChannelReadOnlyByQuota(channelId: string, serverId: string, _now?: Date): Promise<boolean> {
  const plan = await getServerPlan(serverId);
  const maxChannels = getEffectiveLimits(plan, _now).maxChannels;
  if (maxChannels === -1) return false;

  const db = getDb();
  // Get all non-deleted regular channels ordered by createdAt ASC (oldest first)
  const allChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.serverId, serverId), inArray(channels.type, ["channel", "private"]), isNull(channels.deletedAt)))
    .orderBy(channels.createdAt);

  if (allChannels.length <= maxChannels) return false;

  // The first maxChannels channels (oldest) are writable; the rest are read-only
  const writableIds = new Set(allChannels.slice(0, maxChannels).map((c) => c.id));
  return !writableIds.has(channelId);
}

export async function isChannelReadOnlyByBillingFeature(channelId: string, serverId: string, now: Date = new Date()): Promise<boolean> {
  const db = getDb();
  const [channel] = await db
    .select({
      id: channels.id,
      type: channels.type,
      parentMessageId: channels.parentMessageId,
    })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.serverId, serverId)));

  if (!channel) {
    const [jointStorage] = await db
      .select({ jointChannelId: jointChannels.id })
      .from(jointChannels)
      .innerJoin(jointChannelServers, and(
        eq(jointChannelServers.jointChannelId, jointChannels.id),
        eq(jointChannelServers.serverId, serverId),
        eq(jointChannelServers.status, "active"),
      ))
      .where(and(
        eq(jointChannels.canonicalChannelId, channelId),
        eq(jointChannels.status, "active"),
      ))
      .limit(1);
    if (!jointStorage) return false;

    return !(await hasEntitledJointChannelParticipant(db, jointStorage.jointChannelId, now));
  }

  let gatedJointChannelId: string | null = channel.type === "joint"
    ? await getActiveJointChannelIdForLocalProjection(db, channel.id, serverId)
    : null;
  if (!gatedJointChannelId && channel.type === "thread" && channel.parentMessageId) {
    const [parent] = await db
      .select({
        parentChannelId: channels.id,
        parentChannelType: channels.type,
      })
      .from(messages)
      .innerJoin(channels, and(
        eq(channels.id, messages.channelId),
        eq(channels.serverId, serverId),
      ))
      .where(eq(messages.id, channel.parentMessageId));
    if (parent?.parentChannelType === "joint") {
      gatedJointChannelId = await getActiveJointChannelIdForLocalProjection(db, parent.parentChannelId, serverId);
    }
  }

  if (!gatedJointChannelId) return false;
  return !(await hasEntitledJointChannelParticipant(db, gatedJointChannelId, now));
}

/** Count machines in a server. */
export async function countMachines(serverId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(machines)
    .where(eq(machines.serverId, serverId));
  return row?.count ?? 0;
}

/**
 * Get the message history cutoff date based on plan.
 * Returns undefined if unlimited (no filter needed).
 */
export function getHistoryCutoff(plan: ServerPlan, now: Date = new Date()): Date | undefined {
  const days = getEffectiveLimits(plan, now).messageHistoryDays;
  if (days === -1) return undefined;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff;
}

// ── Atomic quota-guarded inserts ──

// Agent creation and pre-checkpoint setup reset are two competing answers to the same
// server-level question, so they must never drift onto different advisory namespaces.
// The numeric value is intentionally unimportant; sharing this symbol is the contract.
export const AGENT_CREATE_LOCK_NAMESPACE = 1;

/**
 * Convert a UUID string to a stable int for pg_advisory_xact_lock.
 * Uses first 8 hex chars → 32-bit signed integer.
 */
function serverIdToLockKey(serverId: string): number {
  const hex = serverId.replace(/-/g, "").slice(0, 8);
  return parseInt(hex, 16) | 0; // force 32-bit signed
}

function resourceToLockKey(namespace: number, resourceKey: string): number {
  const digest = createHash("sha256").update(`${namespace}:${resourceKey}`).digest();
  return digest.readInt32BE(0);
}

/**
 * Run a callback inside a transaction with a per-server advisory lock.
 * Concurrent calls for the same serverId + namespace will serialize.
 * The lock is released automatically when the transaction commits/rolls back.
 *
 * @param serverId - The server to lock on
 * @param namespace - Second lock key to separate agent vs machine locks (e.g. 1 for agents, 2 for machines)
 * @param fn - Callback receiving a transaction-scoped Drizzle instance
 */
export async function withServerLock<T>(
  serverId: string,
  namespace: number,
  fn: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${serverIdToLockKey(serverId)}, ${namespace})`);
    return fn(tx);
  });
}

/**
 * The one lock for the first-Agent checkpoint.
 *
 * Agent creation and pre-checkpoint setup reset must call this helper instead of choosing a
 * namespace independently. Source ratchets pin both call sites and this exact withServerLock
 * delegation; a separate PGlite tooth covers the caller-observed serialization contract.
 */
let agentCreateLockObserverForTests: ((serverId: string) => void) | null = null;

export function __setAgentCreateLockObserverForTests(
  observer: ((serverId: string) => void) | null,
): void {
  agentCreateLockObserverForTests = observer;
}

export function withAgentCreateLock<T>(
  serverId: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  agentCreateLockObserverForTests?.(serverId);
  return withServerLock(serverId, AGENT_CREATE_LOCK_NAMESPACE, fn);
}

/**
 * Run a callback inside a transaction with a per-server, per-resource advisory lock.
 * Concurrent calls for the same serverId + namespace + resourceKey will serialize,
 * while unrelated resources in the same server can proceed independently.
 */
export async function withServerResourceLock<T>(
  serverId: string,
  namespace: number,
  resourceKey: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(${serverIdToLockKey(serverId)}, ${resourceToLockKey(namespace, resourceKey)})
    `);
    return fn(tx);
  });
}
