import { eq, sql } from "drizzle-orm";
import { messages } from "../db/schema";
import type { Server as SocketServer } from "socket.io";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { afterAmbientCommit } from "../db/ambientTransaction";
import { getDb, type DatabaseExecutor } from "../db";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { evaluateFeatureFlag } from "./featureFlagService";
import { acquireJointSourceExitFlagReadLock, jointHostSideMembersSql } from "./jointHumanMembershipAccess";
import { lockJointLifecycleOfChannel } from "./jointLifecycleLock";
import { assertBoundJointGuestsUnchanged, lockJointProjectionWrite } from "../lib/channelActorPermissions";
import type { EndedChannelGuest } from "./channelService";
import {
  createDurableTask,
  durableTaskKind,
  DurableTaskPermanentError,
  DurableTaskRegistry,
  runDurableTask,
  type DurableTaskClaim,
  type DurableTaskContext,
  type DurableTaskDefinition,
} from "./durableTasks";

/**
 * A joint channel whose host side has no human member left is archived for
 * every side (cindyz 2026-10-30, behind the host's external_channels_v1).
 *
 * A host-side member is a current J member (joint_channel_members) who is a
 * non-Guest member of the host server, not queued for removal: the same
 * identity rule that keeps a partner's connection alive in the computed
 * membership mirror. Agents and Guests never count.
 *
 * The decision is made under the J lock, in the transaction that removes the
 * member (jointHumanMembershipMirror: removeHuman, server member removal,
 * demotion to Guest), so of two concurrent last leaves exactly one sees the
 * host side go from non-empty to empty. The archive itself cannot run there:
 * it writes every projection's channel row, which must be locked before J
 * (lockComputedJointActor), and the server-departure path already holds the
 * server/member locks. So that commit writes a durable task; the task archives
 * in the archive's own lock order and re-checks the condition first.
 */

/** Joints whose host side had a member before the removal. */
export type JointHostSideSnapshot = ReadonlySet<string>;

type HostEntry = {
  localChannelId: string;
  serverId: string;
  serverName: string;
  archived: boolean;
};

async function hostEntry(tx: DatabaseExecutor, jointId: string): Promise<HostEntry | null> {
  const result = await tx.execute<HostEntry>(sql`
    SELECT p.local_channel_id AS "localChannelId", p.server_id AS "serverId", s.name AS "serverName",
      (c.archived_at IS NOT NULL) AS archived
    FROM joint_channels j
    JOIN joint_channel_servers p ON p.joint_channel_id=j.id AND p.server_id=j.created_by_server_id AND p.status='active'
    JOIN channels c ON c.id=p.local_channel_id AND c.server_id=p.server_id AND c.type='joint' AND c.deleted_at IS NULL
    JOIN servers s ON s.id=p.server_id AND s.deleted_at IS NULL
    WHERE j.id=${jointId}::uuid AND j.status='active'`);
  return result.rows[0] ?? null;
}

/** Caller holds J. At most `limit` ids. */
async function hostSideMemberIds(tx: DatabaseExecutor, jointId: string, limit: number): Promise<string[]> {
  const result = await tx.execute<{ userId: string }>(sql`
    SELECT h.user_id AS "userId" FROM (${jointHostSideMembersSql(sql`${jointId}::uuid`)}) h
    ORDER BY h.user_id LIMIT ${limit}`);
  return result.rows.map((row) => row.userId);
}

async function hostArchivesWhenEmptied(tx: DatabaseExecutor, hostServerId: string): Promise<boolean> {
  return (await evaluateFeatureFlag({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId: hostServerId, userId: null }, tx)).enabled;
}

/**
 * Under J, before a removal: the host-side members of each computed joint whose
 * host entry is active, not archived, and opted in. Only these joints can be
 * emptied by the removal that follows.
 */
export async function snapshotJointHostSides(tx: DatabaseExecutor, computedJointIds: readonly string[]): Promise<JointHostSideSnapshot> {
  const snapshot = new Set<string>();
  for (const jointId of [...new Set(computedJointIds)].sort()) {
    const host = await hostEntry(tx, jointId);
    if (!host || host.archived) continue;
    if ((await hostSideMemberIds(tx, jointId, 1)).length === 0) continue;
    if (!await hostArchivesWhenEmptied(tx, host.serverId)) continue;
    snapshot.add(jointId);
  }
  return snapshot;
}

/**
 * Under the same J, after the removal: a joint whose host side this removal
 * emptied gets its archive task in this commit. A joint that was already empty
 * (e.g. unarchived through the service while nobody from the host is in it) is
 * never re-archived by a later, unrelated leave. (A host admin's unarchive
 * through the route rejoins them, so the host side is not empty.)
 */
export async function queueArchiveForEmptiedHostSides(
  tx: DatabaseExecutor,
  before: JointHostSideSnapshot,
  /** Per joint: the people whose removal from THAT joint may have emptied it. */
  removedUserIds: (jointId: string) => readonly string[],
): Promise<void> {
  for (const jointId of [...before].sort()) {
    const lastMemberUserId = [...removedUserIds(jointId)].sort()[0];
    if (!lastMemberUserId) continue;
    if ((await hostSideMemberIds(tx, jointId, 1)).length > 0) continue;
    const claim = await createDurableTask(tx, {
      definition: jointHostSideArchiveDefinition,
      payload: { jointId, lastMemberUserId },
    });
    afterAmbientCommit(`joint-host-side-archive:${jointId}`, () => {
      if (effects) void runJointHostSideArchive(claim).catch((error) => {
        console.error("[JointHostSideArchive] post-commit run failed", error);
      });
    });
  }
}

export interface JointHostSideArchiveEffects {
  io: SocketServer | null | undefined;
  orchestrator: AgentOrchestrator;
}
let effects: JointHostSideArchiveEffects | null = null;
/** Composition root: the archive's post-commit effects need the socket server and orchestrator. */
export function configureJointHostSideArchiveEffects(value: JointHostSideArchiveEffects | null) {
  effects = value;
}

export function jointHostSideArchiveMessage(hostServerName: string): string {
  return `📦 This channel was archived because the last member from ${hostServerName} left.`;
}

/**
 * The task's two stages, so a retry neither repeats the state transition nor
 * loses the publication (Cody, PR #13168):
 *
 * 1. Apply. Under the archive's locks, re-check and archive; in the SAME
 *    transaction write the system message as one canonical row with its inbox
 *    facts (as addHumanWithMembershipSystemMessage does), and record on this
 *    task's own row that the intent was applied (`applied`, fenced on this
 *    attempt). A retry that finds `applied` never archives again, so an
 *    unarchive after a failed attempt stands, and never writes a second row.
 * 2. Publish, after commit, on every attempt that reaches it:
 *    finishChannelArchive with that persisted row. Every step re-runs safely:
 *    socket revocation and the projection update re-send current state, and
 *    the message's realtime and agent delivery re-send the same row id.
 */
async function archiveJointWhoseHostSideEmptied(
  payload: JointHostSideArchivePayload,
  context: DurableTaskContext,
  runtime: JointHostSideArchiveEffects,
): Promise<void> {
  await failpointForTests?.("start", context.attempt);
  const applied = payload.applied ?? await applyArchive(payload, context);
  if (!applied) return;
  await failpointForTests?.("applied", context.attempt);
  await publishArchive(payload, applied, runtime);
  await failpointForTests?.("published", context.attempt);
}

async function applyArchive(payload: JointHostSideArchivePayload, context: DurableTaskContext): Promise<AppliedArchive | null> {
  const candidate = await hostEntry(getDb(), payload.jointId);
  if (!candidate || candidate.archived) return null;
  const { archiveBoundGuestIds, archiveChannel, getActiveJointChannelProjectionsByLocalChannel, getChannel } = await import("./channelService");
  const { createMessage, recordInboxFactsForPersistedMessages } = await import("./messageService");
  const { withChannelWriterFence } = await import("./channelConversionFenceService");
  const { lockJointUsersFirst, withJointUsersGuessed } = await import("./jointHumanMembershipMirror");
  // The bound Guests the archive removes, guessed unlocked: their users rows
  // are its first lock (lockJointUsersFirst, as the archive route's), only
  // locked (no actor: nothing refused). A Guest bound since restarts it.
  return withJointUsersGuessed(() => archiveBoundGuestIds(candidate.localChannelId), (lockedUserIds) => withChannelWriterFence(candidate.localChannelId, async (tx) => {
    await lockJointUsersFirst(tx, { userIds: [...lockedUserIds] });
    // The host archive route's order (withLockedChannelActorCapability with
    // archiveChannels, P3): lifecycle lock, the host's channel row and every
    // projection's row FOR NO KEY UPDATE, the bound Guests' member rows, then
    // J, re-checking the Guests under it. Same helpers as the route.
    if (!await lockJointLifecycleOfChannel(tx, candidate.localChannelId)) return null;
    await tx.execute(sql`SELECT id FROM channels WHERE id=${candidate.localChannelId}::uuid FOR NO KEY UPDATE`);
    // The source-exit flag after every row lock (incl. the bound Guests'
    // member rows), right before J, as the archive route (lockComputedJointActor).
    const lockedGuests = await lockJointProjectionWrite(tx, payload.jointId, { lockBoundGuests: true });
    await acquireJointSourceExitFlagReadLock(tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`joint-human-membership:${payload.jointId}`},0))`);
    if (lockedGuests) await assertBoundJointGuestsUnchanged(tx, payload.jointId, lockedGuests);
    const host = await hostEntry(tx, payload.jointId);
    if (!host || host.archived || host.localChannelId !== candidate.localChannelId) return null;
    if (!await hostArchivesWhenEmptied(tx, host.serverId)) return null;
    // Someone from the host joined meanwhile: the channel stays open.
    if ((await hostSideMemberIds(tx, payload.jointId, 1)).length > 0) return null;
    // P3: the archive ends its bound Guests' server memberships and open
    // invites here; what each removal owes after commit is kept in `applied`.
    const endedGuests: EndedChannelGuest[] = [];
    const channel = await archiveChannel(host.localChannelId, null, tx, { endedGuests, lockedUserIds });
    if (!channel.archivedAt) throw new Error("Joint host-side archive did not archive");

    // The explanation, in the canonical history every server reads, with its
    // inbox facts for every copy. After J and the channel rows, as the
    // membership notice is written after lockComputedJointActor.
    const projections = await getActiveJointChannelProjectionsByLocalChannel(host.localChannelId, tx);
    const canonicalChannelIds = new Set(projections.map((projection) => projection.canonicalChannelId));
    const [canonicalChannelId] = canonicalChannelIds;
    if (canonicalChannelIds.size !== 1 || !canonicalChannelId) throw new Error("Joint host-side archive needs one canonical channel");
    const canonicalChannel = await getChannel(canonicalChannelId, { executor: tx });
    if (!canonicalChannel) throw new Error("Joint host-side archive canonical channel is unavailable");
    const causalActor = { type: "user" as const, id: payload.lastMemberUserId };
    const message = await createMessage(canonicalChannelId, "user", "system", jointHostSideArchiveMessage(host.serverName), "system", undefined, {
      causalActorType: causalActor.type,
      causalActorId: causalActor.id,
      systemSubtype: "channel.archive",
    }, tx);
    await recordInboxFactsForPersistedMessages([{ message, causalActor }], {
      inboxFactPolicy: { mode: "record", producer: "channel.archive", reason: "channel archive is shared channel activity" },
      executor: tx,
      channel: canonicalChannel,
      jointProjections: projections,
      dedupeLogicalReceiverAcrossJointProjections: true,
    });

    const applied: AppliedArchive = {
      hostLocalChannelId: host.localChannelId,
      hostServerName: host.serverName,
      archivedAt: channel.archivedAt.toISOString(),
      messageId: message.id,
      endedGuests,
    };
    // Fenced on this attempt: a recovery that claimed the task meanwhile has
    // bumped `attempts`, and this whole archive rolls back.
    const marked = await tx.execute(sql`UPDATE durable_tasks
      SET payload = payload || ${JSON.stringify({ applied })}::jsonb, updated_at = now()
      WHERE id = ${context.taskId} AND state = 'open' AND attempts = ${context.attempt}
      RETURNING id`);
    if (marked.rows.length !== 1) throw new Error("Joint host-side archive attempt superseded");
    return applied;
  }));
}

async function publishArchive(payload: JointHostSideArchivePayload, applied: AppliedArchive, runtime: JointHostSideArchiveEffects): Promise<void> {
  const { getChannel } = await import("./channelService");
  const { finishChannelArchive } = await import("./channelArchiveEffects");
  const channel = await getChannel(applied.hostLocalChannelId);
  if (!channel) return;
  const [message] = await getDb().select().from(messages).where(eq(messages.id, applied.messageId)).limit(1);
  // The row and its facts were committed with the archive: delivery re-sends
  // that row (also after an unarchive, as it is history), never a new one.
  // The ended Guests' memberships ended once, with the archive; their
  // after-commit effects (sockets, credential streams, deliveries) re-run
  // safely from `applied` on a retry that reaches here.
  await finishChannelArchive(runtime.io, runtime.orchestrator, channel, {
    endedGuests: applied.endedGuests,
    ...(message ? {
      systemMessage: {
        content: message.content,
        causalActor: { type: "user" as const, id: payload.lastMemberUserId },
        await: true,
        persisted: message,
      },
    } : {}),
  });
}

interface AppliedArchive {
  hostLocalChannelId: string;
  hostServerName: string;
  /** channels.archived_at this task wrote: identifies its archive episode. */
  archivedAt: string;
  /** The system message row committed with the archive. */
  messageId: string;
  /** Guests whose server membership the archive ended, with what each removal owes after commit. */
  endedGuests: EndedChannelGuest[];
}

interface JointHostSideArchivePayload {
  jointId: string;
  /** The host-side member whose departure emptied the host side (system message's causal actor). */
  lastMemberUserId: string;
  /** Written by the attempt that archived, in the archive's transaction. */
  applied?: AppliedArchive;
}

type Failpoint = (stage: "start" | "applied" | "published", attempt: number) => void | Promise<void>;
let failpointForTests: Failpoint | null = null;
/** Tests: pause an attempt before it applies ("start"), or fail it after the archive committed ("applied") or after its publication ("published"). */
export function setJointHostSideArchiveFailpointForTests(value: Failpoint | null) {
  failpointForTests = value;
}

const UUID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function decodeApplied(value: unknown): AppliedArchive | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null
    || !("hostLocalChannelId" in value) || typeof value.hostLocalChannelId !== "string" || !UUID.test(value.hostLocalChannelId)
    || !("hostServerName" in value) || typeof value.hostServerName !== "string"
    || !("archivedAt" in value) || typeof value.archivedAt !== "string" || Number.isNaN(Date.parse(value.archivedAt))
    || !("messageId" in value) || typeof value.messageId !== "string" || !UUID.test(value.messageId)
    || !("endedGuests" in value) || !Array.isArray(value.endedGuests)) {
    throw new DurableTaskPermanentError("JOINT_HOST_SIDE_ARCHIVE_PAYLOAD_INVALID");
  }
  return {
    hostLocalChannelId: value.hostLocalChannelId, hostServerName: value.hostServerName, archivedAt: value.archivedAt,
    messageId: value.messageId, endedGuests: value.endedGuests.map(decodeEndedGuest),
  };
}

function decodeEndedGuest(value: unknown): EndedChannelGuest {
  const invalid = () => new DurableTaskPermanentError("JOINT_HOST_SIDE_ARCHIVE_PAYLOAD_INVALID");
  if (typeof value !== "object" || value === null || !("userId" in value) || typeof value.userId !== "string" || !UUID.test(value.userId)
    || ("serverId" in value && value.serverId !== undefined && (typeof value.serverId !== "string" || !UUID.test(value.serverId)))
    || !("effects" in value) || typeof value.effects !== "object" || value.effects === null) throw invalid();
  const effects = value.effects as Record<string, unknown>;
  const departed = effects.departedAssistants as Record<string, unknown> | null | undefined;
  if (typeof effects.announced !== "boolean" || !Array.isArray(effects.revokedCredentialAgentIds)
    || effects.revokedCredentialAgentIds.some((id) => typeof id !== "string")
    || (departed != null && (!Array.isArray(departed.agentIds) || departed.agentIds.some((id) => typeof id !== "string") || typeof departed.hostedDeletion !== "boolean"))) {
    throw invalid();
  }
  return {
    userId: value.userId,
    ...("serverId" in value && typeof value.serverId === "string" ? { serverId: value.serverId } : {}),
    effects: {
      announced: effects.announced,
      revokedCredentialAgentIds: effects.revokedCredentialAgentIds as string[],
      departedAssistants: departed ? { agentIds: departed.agentIds as string[], hostedDeletion: departed.hostedDeletion as boolean } : null,
      revokedComputers: decodeRevokedComputers(effects.revokedComputers, invalid),
    },
  };
}

/** Absent on payloads written before a removal revoked the person's Computers: nothing to close. */
function decodeRevokedComputers(value: unknown, invalid: () => Error): EndedChannelGuest["effects"]["revokedComputers"] {
  if (value === undefined) return { agentIds: [], machineIds: [], detached: [] };
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((item) => typeof item === "string");
  if (typeof value !== "object" || value === null) throw invalid();
  const record = value as Record<string, unknown>;
  if (!strings(record.agentIds) || !strings(record.machineIds) || !Array.isArray(record.detached)) throw invalid();
  const detached = record.detached.map((item: unknown) => {
    const computer = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof computer.machineId !== "string" || typeof computer.serverId !== "string" || typeof computer.computerName !== "string") throw invalid();
    return { machineId: computer.machineId, serverId: computer.serverId, computerName: computer.computerName };
  });
  return { agentIds: record.agentIds, machineIds: record.machineIds, detached };
}

const jointHostSideArchiveDefinition: DurableTaskDefinition<JointHostSideArchivePayload> = {
  kind: durableTaskKind("joint.host_side_archive"),
  payloadVersion: 1,
  leaseMs: 30_000,
  maxAttempts: 12,
  decode(payload, version) {
    if (version !== 1 || typeof payload !== "object" || payload === null
      || !("jointId" in payload) || typeof payload.jointId !== "string" || !UUID.test(payload.jointId)
      || !("lastMemberUserId" in payload) || typeof payload.lastMemberUserId !== "string" || !UUID.test(payload.lastMemberUserId)) {
      throw new DurableTaskPermanentError("JOINT_HOST_SIDE_ARCHIVE_PAYLOAD_INVALID");
    }
    const applied = decodeApplied("applied" in payload ? payload.applied : undefined);
    return { jointId: payload.jointId, lastMemberUserId: payload.lastMemberUserId, ...(applied ? { applied } : {}) };
  },
  async handle(payload, context) {
    if (!effects) throw new Error("Joint host-side archive runtime effects unavailable");
    if (!(await context.extendLease())) return;
    await archiveJointWhoseHostSideEmptied(payload, context, effects);
  },
};

// Recovered on every replica, independent of the legacy durable-task switch
// (as jointDepartureRegistry).
export const jointHostSideArchiveRegistry = new DurableTaskRegistry().register(jointHostSideArchiveDefinition);

export function runJointHostSideArchive(claim: DurableTaskClaim) {
  return runDurableTask(claim, jointHostSideArchiveRegistry);
}

/**
 * For the client's leave confirmation: whether this user is the joint's last
 * host-side member, so leaving would archive it for everyone. An unlocked read.
 */
export async function isLastJointHostSideMember(localChannelId: string, userId: string, tx: DatabaseExecutor = getDb()): Promise<boolean> {
  const [row] = (await tx.execute<{ jointId: string }>(sql`
    SELECT p.joint_channel_id AS "jointId" FROM joint_channel_servers p
    WHERE p.local_channel_id=${localChannelId}::uuid AND p.status='active'`)).rows;
  if (!row) return false;
  const host = await hostEntry(tx, row.jointId);
  if (!host || host.archived) return false;
  const members = await hostSideMemberIds(tx, row.jointId, 2);
  if (members.length !== 1 || members[0] !== userId) return false;
  return hostArchivesWhenEmptied(tx, host.serverId);
}
