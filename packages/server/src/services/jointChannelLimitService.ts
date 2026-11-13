import { and, asc, eq, exists, gt, inArray, isNull, ne, notInArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  APPSUMO_PLAN_LIMITS,
  EXTERNAL_CHANNELS_FEATURE_FLAG_KEY,
  MAX_JOINT_CHANNEL_FREE_SERVERS,
  MAX_JOINT_CHANNEL_SERVERS,
  MAX_FREE_SERVER_HOSTED_JOINT_CHANNELS,
  canUseProBillingFeatures,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { channelConversionJobs, channels, jointChannelInvites, jointChannels, jointChannelServers, servers } from "../db/schema";
import { forEachBounded } from "../lib/boundedConcurrency";
import { acquireServerLock, getServerBillingEntitlement, getServerBillingEntitlements, JOINT_HOST_LOCK_NAMESPACE } from "./planService";
import { resolveParentJointId } from "./jointChannelLimitState";
import { acquireFeatureFlagReadLock, evaluateFeatureFlags } from "./featureFlagService";

// Contract v0.3 §18.5–§18.8. Every check here works on the top-level joint;
// callers holding a sub-thread joint id must resolve it first.

export type JointChannelLimitErrorCode =
  | "joint_free_server_limit"
  | "joint_server_limit"
  | "joint_channel_free_limit_reached"
  | "joint_channel_plan_limit_reached";

export class JointChannelLimitError extends Error {
  constructor(
    message: string,
    readonly code: JointChannelLimitErrorCode,
    /** joint_channel_free_limit_reached: host-side name of the joint using the slot. */
    readonly details: { blockingChannelName?: string } = {},
  ) {
    super(message);
    this.name = "JointChannelLimitError";
  }
}

const REFRESH_CONCURRENCY = 4;

const SWEEP_PAGE_SIZE = 200;

/**
 * Called after a background observer (sweep, billing sync) changes a parent
 * joint's `over_limit_since`, so open clients re-read the channel instead of
 * waiting for a reload (§18.8). Request paths (accept, disconnect) already
 * emit their own updates after commit. Wired to the socket layer by server.ts.
 */
export type JointLimitStateListener = (parentJointId: string) => Promise<void> | void;

let jointLimitStateListener: JointLimitStateListener | null = null;

export function onJointLimitStateChanged(listener: JointLimitStateListener | null): void {
  jointLimitStateListener = listener;
}

async function notifyJointLimitStateChanged(parentJointIds: readonly string[]): Promise<void> {
  const listener = jointLimitStateListener;
  if (!listener) return;
  for (const parentJointId of parentJointIds) {
    try {
      await listener(parentJointId);
    } catch (err) {
      // Best effort: the state is already stored; clients still see it on
      // their next fetch.
      console.warn(`[JointLimit] Failed to notify clients for joint ${parentJointId}:`, err instanceof Error ? err.message : err);
    }
  }
}

function sameOverLimitSince(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/** Local channel id of one active projection, for emitting projection updates. */
export async function getActiveJointProjectionLocalChannelId(parentJointId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, parentJointId), eq(jointChannelServers.status, "active")))
    .limit(1);
  return row?.localChannelId ?? null;
}

export type JointLimitServers = {
  /** Active projections whose real server is not deleted (§18.5). */
  active: string[];
  /** Unexpired pending invite targets that are not already active. */
  pending: string[];
};

export async function listJointLimitServers(
  executor: DatabaseExecutor,
  parentJointId: string,
  now: Date,
): Promise<JointLimitServers> {
  const activeRows = await executor
    .select({ serverId: jointChannelServers.serverId })
    .from(jointChannelServers)
    .innerJoin(servers, eq(servers.id, jointChannelServers.serverId))
    .where(and(
      eq(jointChannelServers.jointChannelId, parentJointId),
      eq(jointChannelServers.status, "active"),
      isNull(servers.deletedAt),
    ));
  const active = [...new Set(activeRows.map((row) => row.serverId))];
  const activeSet = new Set(active);
  const pendingRows = await executor
    .selectDistinct({ serverId: jointChannelInvites.toServerId })
    .from(jointChannelInvites)
    .innerJoin(servers, eq(servers.id, jointChannelInvites.toServerId))
    .where(and(
      eq(jointChannelInvites.jointChannelId, parentJointId),
      eq(jointChannelInvites.status, "pending"),
      gt(jointChannelInvites.expiresAt, now),
      isNull(servers.deletedAt),
    ));
  const pending = pendingRows.map((row) => row.serverId).filter((id) => !activeSet.has(id));
  return { active, pending };
}

/** The one place that decides free vs paid for joint limits (§18.11 item 1). */
export async function freeServerIds(
  executor: DatabaseExecutor,
  serverIds: readonly string[],
  now: Date,
): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set();
  const entitlements = await getServerBillingEntitlements(executor, serverIds, now);
  const free = new Set<string>();
  for (const serverId of serverIds) {
    const entitlement = entitlements.get(serverId);
    if (!entitlement || !canUseProBillingFeatures(entitlement.plan, now)) free.add(serverId);
  }
  return free;
}

/**
 * Joints whose host has external_channels_v1 on follow the external channel
 * rules instead of the free-server cap: no MAX_JOINT_CHANNEL_FREE_SERVERS per
 * joint, no over-limit grace or read-only (over_limit_since stays null), and
 * a free server newly connecting is held to the one-external-channel rule
 * (assertJointParticipantCanConnect). Evaluated per host server, with no
 * user: it is a property of the joint, the same for every caller and for
 * the background sweep. `pin` takes the flag's shared lock first (an
 * authoritative check inside a transaction, ADMISSION_LOCK_ORDER rule 5).
 */
export async function externalChannelRulesForHosts(
  executor: DatabaseExecutor,
  hostServerIds: readonly string[],
  options: { pin?: boolean } = {},
): Promise<Set<string>> {
  const hosts = [...new Set(hostServerIds)];
  if (hosts.length === 0) return new Set();
  if (options.pin) await acquireFeatureFlagReadLock(executor, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY);
  const evaluations = await evaluateFeatureFlags(
    hosts.map((serverId) => ({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId, userId: null })),
    executor,
  );
  return new Set(hosts.filter((_, index) => evaluations[index]?.enabled === true));
}

export async function jointHostUsesExternalChannelRules(
  executor: DatabaseExecutor,
  hostServerId: string,
  options: { pin?: boolean } = {},
): Promise<boolean> {
  return (await externalChannelRulesForHosts(executor, [hostServerId], options)).has(hostServerId);
}

/** The Guests bound to an active projection of the joint, when its host admits guests (P3); else 0. */
async function countJointGuestsForCap(
  executor: DatabaseExecutor,
  parentJointId: string,
  pin: boolean | undefined,
  releasingGuest?: ReleasingGuest,
): Promise<number> {
  // A Guest whose seat the same transaction ends (releasingGuest) is not
  // counted: its slot is the server it connects (one party for one).
  const result = await executor.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM server_members sm
    JOIN joint_channel_servers p ON p.local_channel_id=sm.guest_channel_id AND p.server_id=sm.server_id
    WHERE p.joint_channel_id=${parentJointId}::uuid AND p.status='active' AND sm.role='guest'
      ${releasingGuest ? sql`AND NOT (sm.server_id=${releasingGuest.serverId}::uuid AND sm.user_id=${releasingGuest.userId}::uuid)` : sql``}`);
  const guests = Number(result.rows[0]?.n ?? 0);
  if (guests === 0) return 0;
  const hostServerId = await jointHostServerId(executor, parentJointId);
  return hostServerId && await jointHostUsesExternalChannelRules(executor, hostServerId, { pin }) ? guests : 0;
}

/** The top-level joint's host (`created_by_server_id`); null for a missing joint. */
export async function jointHostServerId(executor: DatabaseExecutor, parentJointId: string): Promise<string | null> {
  const [joint] = await executor
    .select({ hostServerId: jointChannels.createdByServerId })
    .from(jointChannels)
    .where(eq(jointChannels.id, parentJointId));
  return joint?.hostServerId ?? null;
}

/**
 * Refresh stale subscriptions for everyone the next admission will count.
 * Runs outside any transaction: the refresh can call the billing provider,
 * and must not hold the joint row lock while it does (§18.11 item 5).
 */
export async function refreshJointEntitlementsBeforeAdmission(
  parentJointId: string | null,
  extraServerIds: readonly string[],
  now: Date,
): Promise<void> {
  const { refreshSubscriptionForServerIfStale } = await import("./billingService");
  const ids = new Set(extraServerIds);
  if (parentJointId) {
    const listed = await listJointLimitServers(getDb(), parentJointId, now);
    for (const id of [...listed.active, ...listed.pending]) ids.add(id);
  }
  await forEachBounded([...ids], REFRESH_CONCURRENCY, async (serverId) => {
    await refreshSubscriptionForServerIfStale(serverId, now);
  });
}

export type JointAdmission =
  /**
   * create / invite: counts active + pending + the new targets. `hostServerId`:
   * the creating server, for a joint not created yet (no parent joint id).
   */
  | { kind: "invite"; targetServerIds: readonly string[]; hostServerId?: string }
  /** accept: counts active + the accepting server (§18.8, Tenny aae3d5ed). */
  | { kind: "accept"; serverId: string }
  /** convert: host only; called so all four entry points share one check. */
  | { kind: "convert"; hostServerId: string };

/**
 * Lock the parent joint row and reject an admission that would break a limit
 * (§18.7). Only new free servers are rejected by the free cap and only new
 * servers by the total cap, so a joint that is already over can still admit
 * paid servers (§18.8). Reads the database only; call
 * `refreshJointEntitlementsBeforeAdmission` first.
 */
export async function assertJointAdmission(
  tx: DatabaseTransaction,
  parentJointId: string | null,
  admission: JointAdmission,
  now: Date,
  options: { releasingGuest?: ReleasingGuest } = {},
): Promise<void> {
  if (parentJointId) {
    await tx.execute(sql`SELECT ${jointChannels.id} FROM ${jointChannels} WHERE ${jointChannels.id} = ${parentJointId} FOR UPDATE`);
  }
  await checkJointAdmission(tx, parentJointId, admission, now, { pinFlag: true, ...options });
}

/**
 * A Guest of the host whose seat the admitting transaction ends once the
 * server connects (a self_connect by that Guest, jointMemberConnectService):
 * its slot is the connecting server's, so the cap counts it once. Only the
 * caller that holds the Guest's member row FOR UPDATE and deletes it in the
 * same commit passes it; a Guest already released is no longer counted anyway.
 */
export interface ReleasingGuest {
  serverId: string;
  userId: string;
}

/**
 * assertJointAdmission's rule without its lock: the caller holds the joint
 * row, or wants a lock-free early answer (the authoritative check still runs
 * under the lock).
 *
 * `newFreeServer`: one more server joins that does not exist yet (an external
 * invitee creating one to connect it). It is counted as a new free server,
 * never looked up: a new server is on the free plan. With it, `{ kind:
 * "accept" }` without a serverId is the accept of that server alone. The
 * locked assertJointAdmission never passes it.
 */
export async function checkJointAdmission(
  executor: DatabaseExecutor,
  parentJointId: string | null,
  admission: JointAdmission | { kind: "accept"; serverId?: undefined },
  now: Date,
  options: { newFreeServer?: boolean; pinFlag?: boolean; releasingGuest?: ReleasingGuest } = {},
): Promise<void> {
  let base: string[] = [];
  if (parentJointId) {
    const listed = await listJointLimitServers(executor, parentJointId, now);
    base = admission.kind === "accept" ? listed.active : [...listed.active, ...listed.pending];
  }
  const baseSet = new Set(base);
  const adding = admission.kind === "invite"
    ? admission.targetServerIds
    : admission.kind === "accept" ? (admission.serverId ? [admission.serverId] : []) : [admission.hostServerId];
  const newIds = [...new Set(adding)].filter((id) => !baseSet.has(id));
  const newFree = options.newFreeServer ? 1 : 0;
  if (newIds.length === 0 && newFree === 0) return;
  const after = [...baseSet, ...newIds];

  // One cap for a channel's parties (P3, #wg-rbac:#25): servers and the
  // Guests in it, as countChannelParties counts them. Guests are in a joint
  // only when its host has external_channels_v1 on.
  const guests = parentJointId ? await countJointGuestsForCap(executor, parentJointId, options.pinFlag, options.releasingGuest) : 0;
  if (after.length + newFree + guests > MAX_JOINT_CHANNEL_SERVERS) {
    throw new JointChannelLimitError(
      `Joint channels are limited to ${MAX_JOINT_CHANNEL_SERVERS} servers.`,
      "joint_server_limit",
    );
  }
  const free = await freeServerIds(executor, after, now);
  if (free.size + newFree > MAX_JOINT_CHANNEL_FREE_SERVERS && (newFree > 0 || newIds.some((id) => free.has(id)))) {
    // Read only when the cap would refuse: external channel rules have no cap.
    const hostServerId = parentJointId
      ? await jointHostServerId(executor, parentJointId)
      : admission.kind === "convert" ? admission.hostServerId : admission.kind === "invite" ? admission.hostServerId : undefined;
    if (hostServerId && await jointHostUsesExternalChannelRules(executor, hostServerId, { pin: options.pinFlag })) return;
    throw new JointChannelLimitError(
      `This joint channel already has ${MAX_JOINT_CHANNEL_FREE_SERVERS} free servers; one side needs to upgrade.`,
      "joint_free_server_limit",
    );
  }
}

/**
 * Condition: a server other than the host has an active projection on the
 * joint and is not deleted.
 */
function otherActiveServerJoined(executor: DatabaseExecutor, jointChannelId: SQL | string, hostServerId: SQL | string): SQL {
  const otherProjection = alias(jointChannelServers, "counted_joint_other_projection");
  const otherServer = alias(servers, "counted_joint_other_server");
  return exists(executor
    .select({ one: sql`1` })
    .from(otherProjection)
    .innerJoin(otherServer, eq(otherServer.id, otherProjection.serverId))
    .where(and(
      sql`${otherProjection.jointChannelId} = ${jointChannelId}`,
      sql`${otherProjection.serverId} <> ${hostServerId}`,
      eq(otherProjection.status, "active"),
      isNull(otherServer.deletedAt),
    )));
}

async function hostedJointUsage(
  executor: DatabaseExecutor,
  hostServerId: string,
  options: { excludeJointId?: string },
): Promise<{ count: number; blockingChannelName?: string }> {
  const hostProjection = alias(jointChannelServers, "counted_joint_host_projection");
  const hostLocalChannel = alias(channels, "counted_joint_host_local_channel");
  const [row] = await executor
    .select({
      count: sql<number>`count(distinct ${jointChannels.id})::int`,
      blockingChannelName: sql<string | null>`min(${hostLocalChannel.name})`,
    })
    .from(jointChannels)
    .innerJoin(channels, eq(channels.id, jointChannels.canonicalChannelId))
    .innerJoin(hostProjection, and(
      eq(hostProjection.jointChannelId, jointChannels.id),
      eq(hostProjection.serverId, jointChannels.createdByServerId),
      eq(hostProjection.status, "active"),
    ))
    .innerJoin(hostLocalChannel, eq(hostLocalChannel.id, hostProjection.localChannelId))
    .where(and(
      eq(jointChannels.createdByServerId, hostServerId),
      topLevelActiveJoints(),
      options.excludeJointId ? ne(jointChannels.id, options.excludeJointId) : undefined,
      otherActiveServerJoined(executor, sql`${jointChannels.id}`, sql`${jointChannels.createdByServerId}`),
    ));
  return { count: row?.count ?? 0, blockingChannelName: row?.blockingChannelName ?? undefined };
}

/**
 * Joints that use a free server's one hosting slot. A joint counts when all of:
 * - the server created it (`created_by_server_id`) and it is top-level:
 *   sub-thread joints never count, even though the server that opened the
 *   thread is recorded as their creator;
 * - the joint row is `active` (nothing sets a joint to `closed` today; a
 *   server leaving is per projection, see `disconnectJointChannel`);
 * - the host's own projection is still `active`;
 * - at least one OTHER server has an `active` projection and is not deleted.
 * So a joint whose invites are pending, declined or expired, or whose every
 * other server disconnected, was removed or was deleted, does not count, and
 * neither does an in-flight conversion. Several other servers count once.
 * The authoritative check runs when the first other server connects
 * (`assertFreeHostCanConnectFirstServer`); creating, converting and inviting
 * only get a lock-free preflight.
 */
export async function countHostedJointChannels(
  executor: DatabaseExecutor,
  hostServerId: string,
  options: { excludeJointId?: string } = {},
): Promise<number> {
  return (await hostedJointUsage(executor, hostServerId, options)).count;
}

/**
 * Who a hosting-limit refusal is shown to. "host": an owner or admin of the
 * host server acting on it (creating, converting, inviting from it,
 * connecting servers of theirs to its channel). "outsider": anyone else (an
 * invitee, an approver on another server, a member connecting their own
 * server): the host's plan, its limit and its other channels are not theirs
 * to know (#wg-rbac:#61).
 */
export type HostLimitAudience = "host" | "outsider";

/** "connect": the joint accept's own check, always shown to the connecting side. */
type HostLimitContext = HostLimitAudience | "connect";

/**
 * A host's limit as someone outside the host server is told it, by every
 * check that refuses them for it: no plan, no number, no other channel.
 */
export const HOST_LIMIT_OUTSIDER_MESSAGE = "This channel's server can't share another channel with people outside it right now. Ask the person who invited you.";

function freeHostLimitError(context: HostLimitContext, blockingChannelName?: string): JointChannelLimitError {
  if (context === "host") {
    return new JointChannelLimitError(
      `This server is on the Free plan and already hosts a Joint Channel another server has joined${blockingChannelName ? ` (#${blockingChannelName})` : ""}. Upgrade to connect another one.`,
      "joint_channel_free_limit_reached",
      { blockingChannelName },
    );
  }
  // Shown to another organisation: never the host's plan, nor the channel using its slot.
  const message = context === "outsider" ? HOST_LIMIT_OUTSIDER_MESSAGE
    : "The server hosting this Joint Channel has reached its Joint Channel limit. Ask its admin to make room, then accept the invite again.";
  return new JointChannelLimitError(message, "joint_channel_free_limit_reached");
}

/** Hosted slots use the same count for Free and AppSumo. Other paid plans stay unlimited. */
async function hostedJointLimit(executor: DatabaseExecutor, serverId: string, now: Date): Promise<{ limit: number; appsumo: boolean }> {
  const entitlement = await getServerBillingEntitlement(executor, serverId, now);
  if (entitlement.appsumo) return { limit: APPSUMO_PLAN_LIMITS[entitlement.appsumo.tier].maxHostedJointChannels, appsumo: true };
  return { limit: canUseProBillingFeatures(entitlement.plan, now) ? -1 : MAX_FREE_SERVER_HOSTED_JOINT_CHANNELS, appsumo: false };
}

function hostPlanLimitError(limit: number, context: HostLimitContext): JointChannelLimitError {
  return new JointChannelLimitError(
    context === "host" ? `This server has reached its plan limit of ${limit} hosted Joint Channels.`
      // Shown to another organisation: never the host's limit (it tells its plan).
      : context === "outsider" ? HOST_LIMIT_OUTSIDER_MESSAGE
      : "The server hosting this Joint Channel has reached its Joint Channel limit. Ask its admin to make room, then accept the invite again.",
    "joint_channel_plan_limit_reached",
  );
}

async function jointHasOtherActiveServer(executor: DatabaseExecutor, jointChannelId: string, hostServerId: string) {
  const [row] = await executor
    .select({ joined: sql<boolean>`${otherActiveServerJoined(executor, jointChannelId, hostServerId)}` })
    .from(jointChannels)
    .where(eq(jointChannels.id, jointChannelId));
  return row?.joined === true;
}

/**
 * Authoritative free-host check, run when `connectingServerId` is about to
 * get an active projection on the top-level joint `jointChannelId`. Only the
 * first other server to connect turns a joint into a counted one, so the
 * check applies to the first other connection, and to a disconnected host
 * rejoining a joint with other active servers. Both can make a joint counted.
 * An already-active host or an additional participant does not add a slot. Rejects with
 * `joint_channel_free_limit_reached` when the host is free and already has a
 * counted joint. Existing joints over the cap (downgrade, history) are left
 * alone; only new connections are blocked.
 *
 * Lock order (ADMISSION_LOCK_ORDER in planService): the caller holds the
 * connecting server's admission lock and `withServerLock(connectingServerId,
 * 3)`; this takes the host's JOINT_HOST lock, then the joint row FOR UPDATE.
 * One JOINT_HOST lock per transaction, and nothing waits for a ns-3 or an
 * admission lock while holding one. Reads the database only; refresh the
 * host's entitlement first.
 */
export async function assertFreeHostCanConnectFirstServer(
  tx: DatabaseTransaction,
  jointChannelId: string,
  connectingServerId: string,
  now: Date,
): Promise<void> {
  const [joint] = await tx
    .select({ hostServerId: jointChannels.createdByServerId })
    .from(jointChannels)
    .where(eq(jointChannels.id, jointChannelId));
  if (!joint) return;
  await acquireServerLock(tx, joint.hostServerId, JOINT_HOST_LOCK_NAMESPACE);
  await tx.execute(sql`SELECT ${jointChannels.id} FROM ${jointChannels} WHERE ${jointChannels.id} = ${jointChannelId} FOR UPDATE`);
  await checkFreeHostCanConnectFirstServer(tx, jointChannelId, { serverId: connectingServerId }, now);
}

/**
 * assertFreeHostCanConnectFirstServer's rule without its locks (see
 * checkJointAdmission): the caller holds them, or wants a lock-free early answer.
 */
export async function checkFreeHostCanConnectFirstServer(
  executor: DatabaseExecutor,
  jointChannelId: string,
  /** The server connecting, or one not created yet (never the host). */
  connecting: { serverId: string } | { newServer: true },
  now: Date,
): Promise<void> {
  const [joint] = await executor
    .select({ hostServerId: jointChannels.createdByServerId })
    .from(jointChannels)
    .where(eq(jointChannels.id, jointChannelId));
  if (!joint) return;
  const { hostServerId } = joint;
  const hasOtherActiveServer = await jointHasOtherActiveServer(executor, jointChannelId, hostServerId);
  if ("serverId" in connecting && hostServerId === connecting.serverId) {
    const [activeHost] = await executor.select({id: jointChannelServers.localChannelId}).from(jointChannelServers)
      .where(and(eq(jointChannelServers.jointChannelId, jointChannelId), eq(jointChannelServers.serverId, connecting.serverId), eq(jointChannelServers.status, "active")));
    if (activeHost || !hasOtherActiveServer) return;
  } else if (hasOtherActiveServer) return;
  const { limit, appsumo } = await hostedJointLimit(executor, hostServerId, now);
  if (limit === -1) return;
  if (await countHostedJointChannels(executor, hostServerId, { excludeJointId: jointChannelId }) >= limit) {
    throw appsumo ? hostPlanLimitError(limit, "connect") : freeHostLimitError("connect");
  }
}

/**
 * Lock-free early answer where we can already tell a later connection would
 * be rejected: creating a joint with invites, converting a channel, and
 * inviting a server into a joint no other server has joined yet. Rejects when
 * the host is free and already has a counted joint other than
 * `excludeJointId`. `audience` is who the refusal is shown to
 * (HostLimitAudience): the host's own owner or admin is told the plan and the
 * joint using the slot; anyone else gets the neutral sentence, without them.
 * The accept-time check stays authoritative.
 */
export async function preflightFreeHostJointCapacity(
  hostServerId: string,
  now: Date,
  options: {
    /** Required, so every caller says who reads its refusal. */
    audience: HostLimitAudience;
    /** The joint being invited into; skipped when another server already joined it. */
    excludeJointId?: string;
    /** Re-starting this channel's in-flight conversion resumes it; not checked. */
    resumingConversionOfChannelId?: string;
  },
): Promise<void> {
  const db = getDb();
  if (options.resumingConversionOfChannelId) {
    const [existing] = await db
      .select({ id: channelConversionJobs.id })
      .from(channelConversionJobs)
      .where(and(
        eq(channelConversionJobs.sourceChannelId, options.resumingConversionOfChannelId),
        inArray(channelConversionJobs.status, ["pending", "running", "failed"]),
      ))
      .limit(1);
    if (existing) return;
  }
  if (options.excludeJointId && await jointHasOtherActiveServer(db, options.excludeJointId, hostServerId)) return;
  await refreshJointEntitlementsBeforeAdmission(null, [hostServerId], now);
  const { limit, appsumo } = await hostedJointLimit(db, hostServerId, now);
  if (limit === -1) return;
  const usage = await hostedJointUsage(db, hostServerId, { excludeJointId: options.excludeJointId });
  if (usage.count >= limit) {
    throw appsumo ? hostPlanLimitError(limit, options.audience) : freeHostLimitError(options.audience, usage.blockingChannelName);
  }
}

/**
 * Record whether the parent joint is over the free-server cap among its
 * active participants (§18.8). The first observation sets `over_limit_since`;
 * later observations keep it; getting back within the cap clears it, so the
 * next overage starts a fresh round. A joint whose host follows the external
 * channel rules has no cap: it is never over, and a stored round is cleared.
 */
export async function reconcileJointOverLimit(
  executor: DatabaseExecutor,
  parentJointId: string,
  now: Date,
): Promise<Date | null> {
  const { active } = await listJointLimitServers(executor, parentJointId, now);
  const free = await freeServerIds(executor, active, now);
  const overCap = free.size > MAX_JOINT_CHANNEL_FREE_SERVERS;
  const hostServerId = overCap ? await jointHostServerId(executor, parentJointId) : null;
  const over = overCap && !(hostServerId && await jointHostUsesExternalChannelRules(executor, hostServerId));
  const [row] = await executor
    .update(jointChannels)
    .set({ overLimitSince: over ? sql`COALESCE(${jointChannels.overLimitSince}, ${now})` : null })
    .where(eq(jointChannels.id, parentJointId))
    .returning({ overLimitSince: jointChannels.overLimitSince });
  return row?.overLimitSince ?? null;
}

/** Reconcile after membership changes that were keyed by any joint id. */
export async function reconcileJointOverLimitFor(
  executor: DatabaseExecutor,
  jointChannelId: string,
  now: Date,
): Promise<void> {
  const parentJointId = await resolveParentJointId(executor, jointChannelId);
  if (parentJointId) await reconcileJointOverLimit(executor, parentJointId, now);
}

function topLevelActiveJoints() {
  // Sub-records (threads, task v2 conversations) follow their parent joint.
  return and(eq(jointChannels.status, "active"), notInArray(channels.type, ["thread", "task"]));
}

/** Billing-change hook: re-evaluate every top-level joint the server is active in. */
export async function reconcileJointsForServer(serverId: string, now: Date = new Date()): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ jointChannelId: jointChannels.id, overLimitSince: jointChannels.overLimitSince })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(channels, eq(channels.id, jointChannels.canonicalChannelId))
    .where(and(
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
      topLevelActiveJoints(),
    ));
  const changed: string[] = [];
  for (const row of rows) {
    const after = await reconcileJointOverLimit(db, row.jointChannelId, now);
    if (!sameOverLimitSince(row.overLimitSince, after)) changed.push(row.jointChannelId);
  }
  await notifyJointLimitStateChanged(changed);
}

export type JointOverLimitSweepResult = { scanned: number; over: number; started: number; cleared: number };

/**
 * Periodic observer (§18.8): finds joints that went over without anyone
 * posting, so notices appear and the grace expires on time. Existing joints
 * that are already over are first observed by the first sweep after launch,
 * which is exactly "grace starts at launch" (§18.9); no backfill needed.
 * Joints whose host follows the external channel rules are never over: the
 * sweep clears a round stored before the host's flag went on.
 */
export async function sweepJointOverLimit(now: Date = new Date()): Promise<JointOverLimitSweepResult> {
  const db = getDb();
  const result: JointOverLimitSweepResult = { scanned: 0, over: 0, started: 0, cleared: 0 };
  let afterId: string | null = null;
  const changed: string[] = [];
  for (;;) {
    const page: { id: string; hostServerId: string; overLimitSince: Date | null }[] = await db
      .select({ id: jointChannels.id, hostServerId: jointChannels.createdByServerId, overLimitSince: jointChannels.overLimitSince })
      .from(jointChannels)
      .innerJoin(channels, eq(channels.id, jointChannels.canonicalChannelId))
      .where(afterId ? and(topLevelActiveJoints(), gt(jointChannels.id, afterId)) : topLevelActiveJoints())
      .orderBy(asc(jointChannels.id))
      .limit(SWEEP_PAGE_SIZE);
    if (page.length === 0) break;
    afterId = page[page.length - 1]!.id;
    result.scanned += page.length;

    const participants = await db
      .select({ jointChannelId: jointChannelServers.jointChannelId, serverId: jointChannelServers.serverId })
      .from(jointChannelServers)
      .innerJoin(servers, eq(servers.id, jointChannelServers.serverId))
      .where(and(
        inArray(jointChannelServers.jointChannelId, page.map((row) => row.id)),
        eq(jointChannelServers.status, "active"),
        isNull(servers.deletedAt),
      ));
    const free = await freeServerIds(db, [...new Set(participants.map((row) => row.serverId))], now);
    const freeCount = new Map<string, number>();
    for (const row of participants) {
      if (free.has(row.serverId)) freeCount.set(row.jointChannelId, (freeCount.get(row.jointChannelId) ?? 0) + 1);
    }

    const overCap = (row: { id: string }) => (freeCount.get(row.id) ?? 0) > MAX_JOINT_CHANNEL_FREE_SERVERS;
    // One flag evaluation per distinct host of this page's over-cap joints.
    const externalRules = await externalChannelRulesForHosts(db, page.filter(overCap).map((row) => row.hostServerId));
    const toStart: string[] = [];
    const toClear: { id: string; overLimitSince: Date }[] = [];
    for (const row of page) {
      const over = overCap(row) && !externalRules.has(row.hostServerId);
      if (over) result.over += 1;
      if (over && !row.overLimitSince) toStart.push(row.id);
      if (!over && row.overLimitSince) toClear.push({ id: row.id, overLimitSince: row.overLimitSince });
    }
    if (toStart.length > 0) {
      const started = await db.update(jointChannels)
        .set({ overLimitSince: now })
        .where(and(inArray(jointChannels.id, toStart), isNull(jointChannels.overLimitSince)))
        .returning({ id: jointChannels.id });
      result.started += started.length;
      changed.push(...started.map((row) => row.id));
    }
    // Compare-and-clear: only clear the round this page read. A write path
    // may have recorded a new round between the read and this update.
    // Exact match relies on every writer storing a JS Date (millisecond
    // precision). A writer using SQL now() (microseconds) would never match
    // here, leaving a recovered joint to go read-only after its grace.
    for (const row of toClear) {
      const cleared = await db.update(jointChannels)
        .set({ overLimitSince: null })
        .where(and(eq(jointChannels.id, row.id), eq(jointChannels.overLimitSince, row.overLimitSince)))
        .returning({ id: jointChannels.id });
      result.cleared += cleared.length;
      if (cleared.length > 0) changed.push(row.id);
    }
    if (page.length < SWEEP_PAGE_SIZE) break;
  }
  await notifyJointLimitStateChanged(changed);
  return result;
}
