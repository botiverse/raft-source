import { createHash } from "node:crypto";
import { eq, and, isNull, sql, inArray, ne } from "drizzle-orm";
import { headcountAgent, seatAgent } from "./agentMemberListPolicy";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { isInTransaction } from "../db/ambientTransaction";
import { activeAppSumoGrantsQuery } from "./appSumoLicenseService";
import { getActivePrepaidGrants } from "./prepaidProService";
import { isChannelReadOnlyByJointLimit } from "./jointChannelLimitState";
import { getExternalFreezeOfChannel } from "./externalChannelFreezeState";
import { servers, agents, machines, channels, channelHumans, serverMembers, subscriptions } from "../db/schema";
import {
  AGENT_LIMIT_REACHED_CODE,
  HUMAN_SEAT_LIMIT_REACHED_CODE,
  PLAN_CONFIG,
  canUseProBillingFeatures,
  currentDate,
  formatBillingCapacityLimitMessage,
  getBillingCapacity,
  PRO_AGENT_SEAT_BLOCK_SIZE,
  getBillingCapacityLimitState,
  getBillingUsage,
  getEffectiveLimits,
  isAppSumoTier,
  type BillingCapacity,
  type BillingCapacityLimitState,
  type BillingEntitlementProjection,
  type BillingUsage,
  type CapacityLimitDetail,
  type ServerPlan,
} from "@botiverse/raft-shared";

type ServerResourceLockProbeForTest = (event: {
  phase: "arrival" | "requested" | "acquired";
  serverId: string;
  namespace: number;
  resourceKey: string;
  mode: "exclusive" | "shared";
}) => Promise<void> | void;

let serverResourceLockProbeForTest: ServerResourceLockProbeForTest | null = null;
let beforeServerResourceLockQueryForTest: ServerResourceLockProbeForTest | null = null;

export function setServerResourceLockProbeForTest(probe: ServerResourceLockProbeForTest | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("server resource lock probes are test-only");
  }
  serverResourceLockProbeForTest = probe;
}

export function setBeforeServerResourceLockQueryForTest(
  hook: ServerResourceLockProbeForTest | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("server resource lock hooks are test-only");
  }
  beforeServerResourceLockQueryForTest = hook;
}

/** A server row's plan; a missing row counts as Free. getServerPlan and the search history window both read it here. */
function serverPlanOf(row: { plan: ServerPlan } | undefined): ServerPlan {
  return row?.plan ?? "free";
}

/** Read the compatibility projection. License lifecycle writers update it under the server row lock.
 * Keep ordinary message/channel reads to one server query; tier-specific admissions use getServerBillingEntitlement. */
export async function getServerPlan(serverId: string): Promise<ServerPlan> {
  const db = getDb();
  const [row] = await db
    .select({ plan: servers.plan })
    .from(servers)
    .where(eq(servers.id, serverId));
  return serverPlanOf(row);
}

function isSubscriptionEntitling(status: string): boolean {
  return status === "active" || status === "past_due";
}

function isInternalEntitlementPlan(plan: ServerPlan): boolean {
  return plan === "founder" || plan === "partner";
}

export type ServerBillingEntitlement = BillingEntitlementProjection & {
  source: "server" | "subscription" | "appsumo" | "prepaid";
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

  const activeGrants = activeAppSumoGrantsQuery(executor, uniqueServerIds).as("active_appsumo_grants");
  const rows = await executor
    .select({
      appsumoTier: activeGrants.tier,
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
    .leftJoin(activeGrants, eq(activeGrants.serverId, servers.id))
    .where(and(inArray(servers.id, uniqueServerIds), isNull(servers.deletedAt)));

  const rowByServerId = new Map(rows.map((row) => [row.serverId, row]));
  const prepaidGrants = await getActivePrepaidGrants(executor, uniqueServerIds, now);
  return new Map(uniqueServerIds.map((serverId) => {
    const row = rowByServerId.get(serverId);
    const tier = row?.appsumoTier;
    const entitlement = projectServerBillingEntitlement(row, now);
    const prepaid = prepaidGrants.get(serverId);
    // Prepaid time ranks below an entitling subscription and an AppSumo
    // license; checkout keeps them apart, so overlap means a race to resolve.
    if (prepaid && !isAppSumoTier(tier) && entitlement.source !== "subscription" && !isInternalEntitlementPlan(entitlement.plan)) {
      const projection: BillingEntitlementProjection = {
        plan: "pro",
        prepaid,
        status: "active",
        billingInterval: null,
        provisionedHumanSeats: prepaid.seatQuantity,
        provisionedAgentSeats: prepaid.seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE,
        proPackQuantity: prepaid.seatQuantity,
      };
      return [serverId, { ...projection, source: "prepaid" as const, capacity: getBillingCapacity(projection, now) }] as const;
    }
    if (!isAppSumoTier(tier) || isInternalEntitlementPlan(entitlement.plan)) return [serverId, entitlement] as const;
    const projection: BillingEntitlementProjection = {
      plan: "pro",
      appsumo: { tier, lifetime: true },
      status: "active",
      billingInterval: null,
      provisionedHumanSeats: null,
      provisionedAgentSeats: null,
      proPackQuantity: null,
    };
    return [serverId, { ...projection, source: "appsumo" as const, capacity: getBillingCapacity(projection, now) }] as const;
  }));

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
    .where(and(eq(serverMembers.serverId, serverId), ne(serverMembers.role, "guest")));
  // App-owned Bots carry no seat (design-v3 §zero-seats): a managed Bot is
  // still a directory/channel member, but not billable. Exclusion is a
  // server-side durable binding, not a caller-controlled label. Nor does a
  // personal assistant: it belongs to its owner, not the server (tygg,
  // #proj-assistant a859e8fd).
  const [agentRow] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(
      eq(agents.serverId, serverId),
      isNull(agents.deletedAt),
      seatAgent(),
    ));
  return getBillingUsage(humanRow?.count ?? 0, agentRow?.count ?? 0);
}

export function assertHumanCapacityAvailable(
  entitlement: ServerBillingEntitlement,
  usage: BillingUsage,
): void {
  const limitState = getBillingCapacityLimitState(entitlement.capacity, usage, "human");
  if (isReachedLimit(limitState)) {
    throw new HumanSeatLimitError(
      formatBillingCapacityLimitMessage("human", limitState, PLAN_CONFIG[entitlement.plan].displayName),
      limitState,
      usage,
    );
  }
}

type ReachedLimitState = BillingCapacityLimitState & { reached: true; limitType: CapacityLimitDetail["limitType"] };

function isReachedLimit(state: BillingCapacityLimitState): state is ReachedLimitState {
  return state.reached && state.limitType !== null;
}

/**
 * A refusal because the server has no room left: no seat for a human, or no
 * room for an agent (a Pro seat share, or Free's agent count). It keeps the
 * numbers, so a route can hand them to a member who may add seats or ask for them.
 */
export abstract class CapacityLimitError extends Error {
  abstract readonly code: typeof HUMAN_SEAT_LIMIT_REACHED_CODE | typeof AGENT_LIMIT_REACHED_CODE;

  constructor(message: string, readonly limitState: ReachedLimitState, readonly usage: BillingUsage) {
    super(message);
    this.name = new.target.name;
  }

  /** The numbers for a refusal body. Only for a member of the server: they say how many people and agents it has. */
  get detail(): CapacityLimitDetail {
    return {
      limitType: this.limitState.limitType,
      limit: this.limitState.limit,
      usage: this.limitState.usage,
      nextUsage: this.limitState.nextUsage,
      humans: this.usage.humans,
      agents: this.usage.agents,
    };
  }
}

export class HumanSeatLimitError extends CapacityLimitError {
  readonly code = HUMAN_SEAT_LIMIT_REACHED_CODE;
}

export class AgentCapacityLimitError extends CapacityLimitError {
  readonly code = AGENT_LIMIT_REACHED_CODE;
}

export function assertAgentCapacityAvailable(
  entitlement: ServerBillingEntitlement,
  usage: BillingUsage,
): void {
  const limitState = getBillingCapacityLimitState(entitlement.capacity, usage, "agent");
  if (isReachedLimit(limitState)) {
    throw new AgentCapacityLimitError(
      formatBillingCapacityLimitMessage("agent", limitState, PLAN_CONFIG[entitlement.plan].displayName, " Upgrade for more."),
      limitState,
      usage,
    );
  }
}

async function refreshSubscriptionBeforeEntitlementGate(serverId: string, now: Date): Promise<void> {
  const { refreshSubscriptionForServerIfStale } = await import("./billingService");
  await refreshSubscriptionForServerIfStale(serverId, now);
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

/** Count agents in a server, less personal assistants (not the server's). */
export async function countAgents(serverId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt), headcountAgent()));
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
 * The regular channels that stay writable while the server has more than the
 * plan allows (the oldest N); null when the server is within its limit.
 */
async function quotaWritableChannelIds(serverId: string, _now?: Date): Promise<Set<string> | null> {
  const plan = await getServerPlan(serverId);
  const maxChannels = getEffectiveLimits(plan, _now).maxChannels;
  if (maxChannels === -1) return null;

  const db = getDb();
  // Get all non-deleted regular channels ordered by createdAt ASC (oldest first)
  const allChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.serverId, serverId), inArray(channels.type, ["channel", "private"]), isNull(channels.deletedAt)))
    .orderBy(channels.createdAt);

  if (allChannels.length <= maxChannels) return null;

  // The first maxChannels channels (oldest) are writable; the rest are read-only
  return new Set(allChannels.slice(0, maxChannels).map((c) => c.id));
}

/**
 * Check if a channel is read-only due to quota.
 * When a server has more channels than the plan allows, the newest channels
 * (beyond the limit) become read-only. Oldest N channels remain writable.
 */
export async function isChannelReadOnlyByQuota(channelId: string, serverId: string, _now?: Date): Promise<boolean> {
  const writableIds = await quotaWritableChannelIds(serverId, _now);
  return writableIds !== null && !writableIds.has(channelId);
}

/**
 * What `isChannelReadOnlyByQuota` answers for every DM of this server, an
 * existing one or one not created yet: a DM is never among the writable
 * regular channels. Lets a send refuse before it opens a new DM.
 */
export async function areDmsReadOnlyByQuota(serverId: string, _now?: Date): Promise<boolean> {
  return await quotaWritableChannelIds(serverId, _now) !== null;
}

/** Why a channel is read-only for a server's writers because of a plan limit. */
export type ChannelBillingReadOnly =
  /** Contract v0.3 §18.8: the parent joint's over-limit grace has passed. */
  | { reason: "joint_over_limit" }
  /**
   * The writer's entry server is a free server in more than one external
   * channel and its freeze time has passed; this is one of them
   * (externalChannelFreezeState).
   */
  | { reason: "external_limit_frozen"; freezeAt: Date };

export const JOINT_CHANNEL_READ_ONLY_ERROR = "This joint channel is read-only because it has more than 2 free servers. It becomes writable again when a server upgrades or a free server leaves.";
export const EXTERNAL_LIMIT_FROZEN_ERROR = "This server is on the Free plan and shares more than one channel with people outside it, so it can't post in them. It can post again once it upgrades, or leaves or disconnects all but one of them.";

/**
 * The plan limits that make a channel read-only for `serverId`'s writers
 * (the writer's entry server: a Guest's is the host). The freeze first: one
 * primary-key read, and more only once the server is frozen; then the joint
 * over-limit rule, one stored field. No per-message billing lookups.
 */
export async function getChannelBillingReadOnly(channelId: string, serverId: string, now: Date = new Date()): Promise<ChannelBillingReadOnly | null> {
  const frozen = await getExternalFreezeOfChannel(channelId, serverId, now);
  if (frozen) return { reason: "external_limit_frozen", freezeAt: frozen.freezeAt };
  if (await isChannelReadOnlyByJointLimit(channelId, serverId, now)) return { reason: "joint_over_limit" };
  return null;
}

/** The 403 body for a write refused by getChannelBillingReadOnly. */
export function channelBillingReadOnlyBody(readOnly: ChannelBillingReadOnly): { error: string; code?: "external_limit_frozen"; externalFreezeAt?: string } {
  return readOnly.reason === "external_limit_frozen"
    ? { error: EXTERNAL_LIMIT_FROZEN_ERROR, code: "external_limit_frozen", externalFreezeAt: readOnly.freezeAt.toISOString() }
    : { error: JOINT_CHANNEL_READ_ONLY_ERROR };
}

/**
 * The same refusal on an agent route (through refuse()): a code for both
 * reasons, and the sentence; `externalFreezeAt` stays the web's (its banner
 * reads it, no agent client does).
 */
export function channelBillingReadOnlyRefusal(readOnly: ChannelBillingReadOnly): { code: "external_limit_frozen" | "channel_read_only"; error: string } {
  return readOnly.reason === "external_limit_frozen"
    ? { code: "external_limit_frozen", error: EXTERNAL_LIMIT_FROZEN_ERROR }
    : { code: "channel_read_only", error: JOINT_CHANNEL_READ_ONLY_ERROR };
}

/**
 * Whether a plan limit makes the channel read-only for the server's writers
 * (getChannelBillingReadOnly). The name is kept because every write path
 * (messages, uploads, attachments, comments, channels, internal, agent API)
 * already calls it.
 */
export async function isChannelReadOnlyByBillingFeature(channelId: string, serverId: string, now: Date = new Date()): Promise<boolean> {
  return (await getChannelBillingReadOnly(channelId, serverId, now)) !== null;
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

/**
 * The plan's history cutoff and when the server was created. Search bounds its
 * query by the cutoff, and tells the viewer only when the searched scope is
 * older than the cutoff, so there is older history to leave out.
 */
export async function getServerHistoryWindow(
  serverId: string,
  now: Date = new Date(),
): Promise<{ plan: ServerPlan; cutoff: Date | undefined; serverCreatedAt: Date | undefined }> {
  const db = getDb();
  const [row] = await db
    .select({ plan: servers.plan, createdAt: servers.createdAt })
    .from(servers)
    .where(eq(servers.id, serverId));
  const plan = serverPlanOf(row);
  return {
    plan,
    cutoff: getHistoryCutoff(plan, now),
    serverCreatedAt: row?.createdAt,
  };
}

// ── Atomic quota-guarded inserts ──

// Agent creation and pre-checkpoint setup reset are two competing answers to the same
// server-level question, so they must never drift onto different advisory namespaces.
// The numeric value is intentionally unimportant; sharing this symbol is the contract.
export const AGENT_CREATE_LOCK_NAMESPACE = 1;
// 4 was the retired Guest-joinable channel cap (#wg-rbac:#47): left unused so
// no new lock shares it with an older image still running beside this one.
/** Serializes "may this server host another joint" (create + convert start). */
export const JOINT_HOST_LOCK_NAMESPACE = 6;
/** Serializes the daily external channel invite cap of a host server (send + resend). */
export const EXTERNAL_INVITE_DAILY_CAP_LOCK_NAMESPACE = 7;
/**
 * Serializes letting people and servers into one server's channels: accepting
 * an external invite as a Guest, a server invite or join link (join, or a
 * Guest's promotion), and a server connecting to a joint channel (external
 * connect, ordinary joint invite accept). The person may have no
 * server_members row yet, so no row lock can order two admissions (one
 * person's two invites, the free plan's one external channel, a server
 * invite racing an external one). Order: ADMISSION_LOCK_ORDER below.
 */
export const SERVER_MEMBERSHIP_ADMISSION_LOCK_NAMESPACE = 8;

// ADMISSION_LOCK_ORDER: lock rule for every transaction that takes a
// SERVER_MEMBERSHIP_ADMISSION_LOCK_NAMESPACE lock (Tenny):
//
// 1. The admission lock is always first: before ns-3, JOINT_HOST, the joint
//    lifecycle and membership locks, and before any row lock. Never acquire
//    an admission lock while holding any of those.
//    The one lock allowed before it is a channel's conversion lock
//    (CHANNEL_CONVERSION_LOCK_NAMESPACE, shared through the writer fence or
//    exclusive in a conversion start): a Guest accept and the reservation of
//    a connection by conversion take it first, so they do not hold anyone's
//    admission while queued behind a conversion's copy batch. Nothing takes a
//    conversion lock after an admission lock.
// 2. Several servers: all their admission locks, in server-id order
//    (acquireServerAdmissionLocks), before anything else.
// 3. Then the connecting server(s)' ns-3 lock(s) (withServerLock(..., 3)),
//    several in server-id order.
// 4. Then the joint's own locks (lifecycle, the connecting server's prior
//    local channel row, server and member rows, the membership mirror lock),
//    then the free plan's external channel freeze rows
//    (server_external_freezes, written by primary key, several in server-id
//    order, never the servers row: externalChannelFreezeService), then
//    JOINT_HOST of the joint's host (one per transaction), then the joint
//    row FOR UPDATE. A joint accept therefore writes the freeze rows before
//    its projection exists, counting the joint as connected
//    (reconcileExternalFreezesForJointConnect). A path that takes no joint
//    row writes them after its own changes.
// 5. The feature-flag read lock, when taken, comes last.
//
// Paths: acceptExternalInviteAsGuest (externalInviteService), admitByInvite
// (inviteService), reserveConnection and connectJointChannel
// (externalInviteConnectService), acceptJointChannelInvite(s)
// (channelService), an unarchive (the free plan's external channel rule,
// channelService), the external channel freeze reconciles of
// externalChannelFreezeService. An ordinary joint accept (single or batch)
// takes the host's admission lock too, unconditionally, with the connecting
// servers': the accept writes the host's external channel freeze row (the
// joint may become the host's external channel), and the freeze sweep and
// billing hook count a server under its admission lock, so the count cannot
// go stale before the write. The host's hosting limit is still decided under
// JOINT_HOST (assertFreeHostCanConnectFirstServer). Servers already active in
// the joint need no lock: their count does not change.
// Reconciles not started by a change path (the sweep, the billing hook) run
// in their own short transaction: the server's admission lock, then count,
// then write. Paths that only take external channels away (a disconnect, an
// archive, a removal, a delete) hold no admission lock; they only delete,
// and only the freeze row version they locked before counting.

/**
 * Takes the admission locks of `serverIds` (deduplicated, in server-id
 * order), per ADMISSION_LOCK_ORDER: call it before any other lock of the
 * transaction (a conversion lock excepted).
 */
export async function acquireServerAdmissionLocks(
  executor: DatabaseExecutor,
  serverIds: readonly string[],
): Promise<void> {
  for (const serverId of [...new Set(serverIds)].sort()) {
    await acquireServerLock(executor, serverId, SERVER_MEMBERSHIP_ADMISSION_LOCK_NAMESPACE);
  }
}
/**
 * Serializes a joint channel's lifecycle across its projections, keyed on the
 * parent joint id: archive/unarchive (and other writes to every projection)
 * against a projection being created (joint accept, external connect). Taken
 * before any channel row of the joint (jointLifecycleLock.ts).
 */
export const JOINT_LIFECYCLE_LOCK_NAMESPACE = 9;

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

export async function acquireServerLock(
  executor: DatabaseExecutor,
  serverId: string,
  namespace: number,
): Promise<void> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(${serverIdToLockKey(serverId)}, ${namespace})`);
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
    await lockServerResourceInTransaction(tx, serverId, namespace, resourceKey);
    return fn(tx);
  });
}

/**
 * Acquire a per-server resource lock inside an existing transaction.
 *
 * `mode: "shared"` takes the shared form of the same advisory key: shared
 * holders never block each other and only conflict with an exclusive holder.
 * A transaction must not take a key shared and later exclusive — two such
 * transactions deadlock on the upgrade.
 */
export async function lockServerResourceInTransaction(
  tx: DatabaseExecutor,
  serverId: string,
  namespace: number,
  resourceKey: string,
  mode: "exclusive" | "shared" = "exclusive",
): Promise<void> {
  const probe = serverResourceLockProbeForTest;
  const event = { serverId, namespace, resourceKey, mode };
  await probe?.({ phase: "arrival", ...event });
  await beforeServerResourceLockQueryForTest?.({ phase: "arrival", ...event });
  const serverKey = serverIdToLockKey(serverId);
  const resourceLockKey = resourceToLockKey(namespace, resourceKey);
  const lock = mode === "shared"
    ? tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${serverKey}, ${resourceLockKey})`)
    : tx.execute(sql`SELECT pg_advisory_xact_lock(${serverKey}, ${resourceLockKey})`);
  // `requested` belongs to the lower primitive and is emitted only after the
  // real advisory SQL call has returned its in-flight promise. A wrapper may
  // observe arrival, but it cannot attest that PostgreSQL has been asked.
  await probe?.({ phase: "requested", ...event });
  await lock;
  await probe?.({ phase: "acquired", ...event });
}

/**
 * The exclusive form of lockServerResourceInTransaction's key, without
 * waiting: true when this transaction now holds it, false when another one
 * does (nothing is held then). Same keys, so it serializes with every holder
 * of the blocking form; a try never waits, so it cannot close a lock-order
 * cycle wherever it is taken.
 */
export async function tryLockServerResourceInTransaction(
  tx: DatabaseExecutor,
  serverId: string,
  namespace: number,
  resourceKey: string,
): Promise<boolean> {
  const probe = serverResourceLockProbeForTest;
  const event = { serverId, namespace, resourceKey, mode: "exclusive" as const };
  await probe?.({ phase: "arrival", ...event });
  await beforeServerResourceLockQueryForTest?.({ phase: "arrival", ...event });
  const serverKey = serverIdToLockKey(serverId);
  const resourceLockKey = resourceToLockKey(namespace, resourceKey);
  const lock = tx.execute(sql`SELECT pg_try_advisory_xact_lock(${serverKey}, ${resourceLockKey}) AS acquired`);
  await probe?.({ phase: "requested", ...event });
  const result = await lock;
  const acquired = (result.rows[0] as { acquired?: unknown } | undefined)?.acquired === true;
  if (acquired) await probe?.({ phase: "acquired", ...event });
  return acquired;
}

/**
 * Whether the exclusive key is free right now, holding nothing afterwards:
 * one standalone pg_try_advisory_xact_lock on a pooled connection in
 * autocommit, so the lock ends with the statement. A hint only (the key can
 * be taken the next moment); the caller's own try in its transaction decides.
 * Inside an open transaction the statement would join it and keep the lock
 * until that transaction ends, so there it does not probe and answers true.
 */
export async function probeServerResourceLockFree(
  serverId: string,
  namespace: number,
  resourceKey: string,
): Promise<boolean> {
  if (isInTransaction()) return true;
  const result = await getDb().execute(sql`SELECT pg_try_advisory_xact_lock(${serverIdToLockKey(serverId)}, ${resourceToLockKey(namespace, resourceKey)}) AS acquired`);
  return (result.rows[0] as { acquired?: unknown } | undefined)?.acquired === true;
}
