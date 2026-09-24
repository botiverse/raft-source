import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import { inboxSuppressionStates, readCursorWidenPhase } from "../db/schema.js";

const INT4_AUTHORITY_MAX = 2_147_483_647n;

export const INBOX_SUPPRESSION_WRITE_SITES = {
  markChannelInboxDone: "channel.markChannelInboxDone",
  markThreadDone: "thread.markThreadDone",
  unfollowThreadForFollower: "thread.unfollowThreadForFollower",
  undoneThread: "thread.undoneThread",
  clearThreadDoneForAll: "thread.clearThreadDoneForAll",
  recordThreadFollow: "thread.recordThreadFollow",
  markInboxReadLatest: "inbox.markInboxReadLatest",
} as const;

export type InboxSuppressionWriteSite =
  typeof INBOX_SUPPRESSION_WRITE_SITES[keyof typeof INBOX_SUPPRESSION_WRITE_SITES];

export const INBOX_SUPPRESSION_MUTATING_WRITE_SITES = [
  INBOX_SUPPRESSION_WRITE_SITES.markChannelInboxDone,
  INBOX_SUPPRESSION_WRITE_SITES.markThreadDone,
  INBOX_SUPPRESSION_WRITE_SITES.unfollowThreadForFollower,
  INBOX_SUPPRESSION_WRITE_SITES.undoneThread,
  INBOX_SUPPRESSION_WRITE_SITES.clearThreadDoneForAll,
  INBOX_SUPPRESSION_WRITE_SITES.recordThreadFollow,
] as const satisfies readonly InboxSuppressionWriteSite[];

export const INBOX_SUPPRESSION_READ_ONLY_WRITE_SITES = [
  INBOX_SUPPRESSION_WRITE_SITES.markInboxReadLatest,
] as const satisfies readonly InboxSuppressionWriteSite[];

type InboxSuppressionTargetKind =
  | "channel"
  | "dm"
  | "followed_thread"
  | "public_channel_mention"
  | "public_thread_mention";

export type ChannelSuppressionTarget = {
  serverId: string;
  targetChannelId: string;
  sourceChannelId: string;
  targetKinds: InboxSuppressionTargetKind[];
  latestSeqExact: string | null;
};

/** Missing, non-string, zero, or non-canonical Done frontier. */
export class DoneFrontierRequiredError extends Error {
  readonly code = "DONE_FRONTIER_REQUIRED";

  constructor(readonly targetChannelId: string, readonly throughActivitySeq: unknown) {
    super(`Done requires a positive canonical-decimal throughActivitySeq for ${targetChannelId}`);
    this.name = "DoneFrontierRequiredError";
  }
}

/** The client claims content the target does not currently contain. */
export class DoneFrontierBeyondLatestError extends Error {
  readonly code = "DONE_FRONTIER_BEYOND_LATEST";

  constructor(
    readonly targetChannelId: string,
    readonly throughActivitySeq: string,
    readonly currentLatestExact: string | null,
  ) {
    super(
      `Done frontier ${throughActivitySeq} is beyond current latest ${currentLatestExact ?? "null"} for ${targetChannelId}`,
    );
    this.name = "DoneFrontierBeyondLatestError";
  }
}

/**
 * RFC 057 rollback-window value-domain fence. Until an operator explicitly
 * advances the audited widen ledger to `retired`, the int4 cursor remains a
 * possible rollback authority and a frontier above its cap must be rejected
 * before admission or any user-visible Done write.
 */
export class DoneFrontierAboveInt4AuthorityError extends Error {
  readonly code = "DONE_FRONTIER_ABOVE_INT4_AUTHORITY";

  constructor(
    readonly targetChannelId: string,
    readonly throughActivitySeq: string,
    readonly phase: string | null,
  ) {
    super(
      `Done frontier ${throughActivitySeq} exceeds the int4 rollback authority while read-cursor phase is ${phase ?? "unknown"}`,
    );
    this.name = "DoneFrontierAboveInt4AuthorityError";
  }
}

function executorFor(executor?: DatabaseExecutor): DatabaseExecutor {
  return executor ?? getDb();
}

export function parsePositiveCanonicalDecimal(value: unknown): bigint | null {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value)
    ? BigInt(value)
    : null;
}

async function assertRetiredForAboveInt4Frontier(
  targetChannelId: string,
  frontier: bigint,
  executor?: DatabaseExecutor,
): Promise<void> {
  if (frontier <= INT4_AUTHORITY_MAX) return;
  const db = executorFor(executor);
  const [ledger] = await db
    .select({ phase: readCursorWidenPhase.phase })
    .from(readCursorWidenPhase)
    .where(eq(readCursorWidenPhase.id, true))
    .limit(1);
  if (ledger?.phase !== "retired") {
    throw new DoneFrontierAboveInt4AuthorityError(
      targetChannelId,
      frontier.toString(),
      ledger?.phase ?? null,
    );
  }
}

export async function resolveChannelSuppressionTarget(
  channelId: string,
  executor?: DatabaseExecutor,
): Promise<ChannelSuppressionTarget | null> {
  const db = executorFor(executor);
  const result = await db.execute(sql`
    SELECT
      c.server_id::text AS "serverId",
      c.id::text AS "targetChannelId",
      COALESCE(joint_storage.canonical_channel_id, c.id)::text AS "sourceChannelId",
      c.type::text AS "channelType",
      max(m.seq)::bigint AS "latestSeq"
    FROM channels c
    LEFT JOIN joint_channel_servers joint_projection
      ON joint_projection.local_channel_id = c.id
     AND joint_projection.server_id = c.server_id
     AND joint_projection.status = 'active'
    LEFT JOIN joint_channels joint_storage
      ON joint_storage.id = joint_projection.joint_channel_id
     AND joint_storage.status = 'active'
    LEFT JOIN messages m
      ON m.channel_id = COALESCE(joint_storage.canonical_channel_id, c.id)
    WHERE c.id = ${channelId}::uuid
      AND c.deleted_at IS NULL
    GROUP BY c.server_id, c.id, COALESCE(joint_storage.canonical_channel_id, c.id), c.type
  `);

  const row = result.rows[0] as {
    serverId: string;
    targetChannelId: string;
    sourceChannelId: string;
    channelType: string;
    latestSeq: string | number | null;
  } | undefined;
  if (!row) return null;

  const memberKind: InboxSuppressionTargetKind = row.channelType === "dm" ? "dm" : "channel";
  const targetKinds: InboxSuppressionTargetKind[] = [memberKind];
  if (row.channelType === "channel") {
    targetKinds.push("public_channel_mention");
  }

  return {
    serverId: row.serverId,
    targetChannelId: row.targetChannelId,
    sourceChannelId: row.sourceChannelId,
    targetKinds,
    latestSeqExact: row.latestSeq == null ? null : String(row.latestSeq),
  };
}

export async function resolveThreadSuppressionTarget(
  threadChannelId: string,
  executor?: DatabaseExecutor,
): Promise<Omit<ChannelSuppressionTarget, "targetKinds"> | null> {
  const db = executorFor(executor);
  const result = await db.execute(sql`
    SELECT
      t.server_id::text AS "serverId",
      t.id::text AS "targetChannelId",
      COALESCE(canonical_thread.id, t.id)::text AS "sourceChannelId",
      COALESCE(max(m.seq), parent_msg.seq)::bigint AS "latestSeq"
    FROM channels t
    LEFT JOIN joint_channel_servers thread_projection
      ON thread_projection.local_channel_id = t.id
     AND thread_projection.server_id = t.server_id
     AND thread_projection.status = 'active'
    LEFT JOIN joint_channels thread_joint
      ON thread_joint.id = thread_projection.joint_channel_id
     AND thread_joint.status = 'active'
    LEFT JOIN channels canonical_thread
      ON canonical_thread.id = thread_joint.canonical_channel_id
     AND canonical_thread.type = 'thread'
     AND canonical_thread.deleted_at IS NULL
    LEFT JOIN messages m
      ON m.channel_id = COALESCE(canonical_thread.id, t.id)
    LEFT JOIN messages parent_msg
      ON parent_msg.id = COALESCE(canonical_thread.parent_message_id, t.parent_message_id)
    WHERE t.id = ${threadChannelId}::uuid
      AND t.type = 'thread'
      AND t.deleted_at IS NULL
    GROUP BY t.server_id, t.id, COALESCE(canonical_thread.id, t.id), parent_msg.seq
  `);

  const row = result.rows[0] as {
    serverId: string;
    targetChannelId: string;
    sourceChannelId: string;
    latestSeq: string | number | null;
  } | undefined;
  if (!row) return null;

  return {
    serverId: row.serverId,
    targetChannelId: row.targetChannelId,
    sourceChannelId: row.sourceChannelId,
    latestSeqExact: row.latestSeq == null ? null : String(row.latestSeq),
  };
}

async function upsertSuppressionTargets(params: {
  receiverId: string;
  serverId: string;
  targetChannelId: string;
  sourceChannelId: string;
  targetKinds: InboxSuppressionTargetKind[];
  doneThroughSeqExact: string | null;
  writeSite: InboxSuppressionWriteSite;
  executor?: DatabaseExecutor;
}) {
  if (params.targetKinds.length === 0) return;

  const db = executorFor(params.executor);
  const now = new Date();
  await db
    .insert(inboxSuppressionStates)
    .values(params.targetKinds.map((targetKind) => ({
      receiverType: "user" as const,
      receiverId: params.receiverId,
      serverId: params.serverId,
      targetKind,
      targetChannelId: params.targetChannelId,
      sourceChannelId: params.sourceChannelId,
      doneThroughSeq: params.doneThroughSeqExact == null
        ? null
        : sql`${params.doneThroughSeqExact}::bigint`,
      doneAt: now,
      writeSite: params.writeSite,
      updatedAt: now,
    })))
    .onConflictDoUpdate({
      target: [
        inboxSuppressionStates.receiverType,
        inboxSuppressionStates.receiverId,
        inboxSuppressionStates.targetKind,
        inboxSuppressionStates.targetChannelId,
      ],
      set: {
        serverId: params.serverId,
        sourceChannelId: params.sourceChannelId,
        doneThroughSeq: sql`GREATEST(COALESCE(${inboxSuppressionStates.doneThroughSeq}, 0), COALESCE(EXCLUDED.done_through_seq, 0))`,
        doneAt: now,
        writeSite: params.writeSite,
        updatedAt: now,
      },
    });
}

export async function writeChannelInboxSuppression(params: {
  userId: string;
  channelId: string;
  throughActivitySeq?: string;
  executor?: DatabaseExecutor;
}) {
  const target = await resolveChannelSuppressionTarget(params.channelId, params.executor);
  if (!target) return;

  const doneThroughSeqExact = params.throughActivitySeq == null
    ? target.latestSeqExact
    : (await validateDoneFrontier(target, params.throughActivitySeq, params.executor)).toString();

  await upsertSuppressionTargets({
    receiverId: params.userId,
    serverId: target.serverId,
    targetChannelId: target.targetChannelId,
    sourceChannelId: target.sourceChannelId,
    targetKinds: target.targetKinds,
    doneThroughSeqExact,
    writeSite: INBOX_SUPPRESSION_WRITE_SITES.markChannelInboxDone,
    executor: params.executor,
  });
}

export async function clearChannelDoneSuppression(params: {
  userId: string;
  channelId: string;
  executor?: DatabaseExecutor;
}) {
  const target = await resolveChannelSuppressionTarget(params.channelId, params.executor);
  if (!target) return;

  const db = executorFor(params.executor);
  await db
    .delete(inboxSuppressionStates)
    .where(and(
      eq(inboxSuppressionStates.receiverType, "user"),
      eq(inboxSuppressionStates.receiverId, params.userId),
      eq(inboxSuppressionStates.targetChannelId, target.targetChannelId),
      inArray(inboxSuppressionStates.targetKind, target.targetKinds),
    ));
}

export async function writeThreadDoneSuppression(params: {
  userId: string;
  threadChannelId: string;
  throughActivitySeq?: string;
  writeSite?: InboxSuppressionWriteSite;
  executor?: DatabaseExecutor;
}) {
  const target = await resolveThreadSuppressionTarget(params.threadChannelId, params.executor);
  if (!target) return;

  const doneThroughSeqExact = params.throughActivitySeq == null
    ? target.latestSeqExact
    : (await validateDoneFrontier(target, params.throughActivitySeq, params.executor)).toString();

  await upsertSuppressionTargets({
    receiverId: params.userId,
    serverId: target.serverId,
    targetChannelId: target.targetChannelId,
    sourceChannelId: target.sourceChannelId,
    targetKinds: ["followed_thread", "public_thread_mention"],
    doneThroughSeqExact,
    writeSite: params.writeSite ?? INBOX_SUPPRESSION_WRITE_SITES.markThreadDone,
    executor: params.executor,
  });
}

export async function validateDoneFrontier(
  target: Pick<ChannelSuppressionTarget, "targetChannelId" | "latestSeqExact">,
  throughActivitySeq: unknown,
  executor?: DatabaseExecutor,
): Promise<bigint> {
  const frontier = parsePositiveCanonicalDecimal(throughActivitySeq);
  if (frontier == null) {
    throw new DoneFrontierRequiredError(target.targetChannelId, throughActivitySeq);
  }
  const currentLatest = target.latestSeqExact == null
    ? null
    : BigInt(target.latestSeqExact);
  if (currentLatest == null || frontier > currentLatest) {
    throw new DoneFrontierBeyondLatestError(
      target.targetChannelId,
      frontier.toString(),
      target.latestSeqExact,
    );
  }
  await assertRetiredForAboveInt4Frontier(target.targetChannelId, frontier, executor);
  return frontier;
}

/** Fast, zero-write Done admission guards. The worker repeats these checks
 * under the canonical content lock before applying the composite mutation. */
export async function assertChannelDoneFrontier(params: {
  channelId: string;
  throughActivitySeq: unknown;
  executor?: DatabaseExecutor;
}): Promise<{ target: ChannelSuppressionTarget; frontier: bigint }> {
  const frontier = parsePositiveCanonicalDecimal(params.throughActivitySeq);
  if (frontier == null) {
    throw new DoneFrontierRequiredError(params.channelId, params.throughActivitySeq);
  }
  const target = await resolveChannelSuppressionTarget(params.channelId, params.executor);
  if (!target) {
    throw new DoneFrontierBeyondLatestError(params.channelId, frontier.toString(), null);
  }
  return {
    target,
    frontier: await validateDoneFrontier(target, frontier.toString(), params.executor),
  };
}

export async function assertThreadDoneFrontier(params: {
  threadChannelId: string;
  throughActivitySeq: unknown;
  executor?: DatabaseExecutor;
}): Promise<{ target: Omit<ChannelSuppressionTarget, "targetKinds">; frontier: bigint }> {
  const frontier = parsePositiveCanonicalDecimal(params.throughActivitySeq);
  if (frontier == null) {
    throw new DoneFrontierRequiredError(params.threadChannelId, params.throughActivitySeq);
  }
  const target = await resolveThreadSuppressionTarget(params.threadChannelId, params.executor);
  if (!target) {
    throw new DoneFrontierBeyondLatestError(params.threadChannelId, frontier.toString(), null);
  }
  return {
    target,
    frontier: await validateDoneFrontier(target, frontier.toString(), params.executor),
  };
}

export async function clearThreadDoneSuppression(params: {
  userId: string;
  threadChannelId: string;
  executor?: DatabaseExecutor;
}) {
  const db = executorFor(params.executor);
  await db
    .delete(inboxSuppressionStates)
    .where(and(
      eq(inboxSuppressionStates.receiverType, "user"),
      eq(inboxSuppressionStates.receiverId, params.userId),
      eq(inboxSuppressionStates.targetChannelId, params.threadChannelId),
      inArray(inboxSuppressionStates.targetKind, ["followed_thread", "public_thread_mention"]),
    ));
}

export const parsePositiveCanonicalDecimalForTest = parsePositiveCanonicalDecimal;

export async function clearFollowedThreadSuppressionForAll(params: {
  threadChannelId: string;
  executor?: DatabaseExecutor;
}) {
  const db = executorFor(params.executor);
  await db
    .delete(inboxSuppressionStates)
    .where(and(
      eq(inboxSuppressionStates.receiverType, "user"),
      eq(inboxSuppressionStates.targetChannelId, params.threadChannelId),
      eq(inboxSuppressionStates.targetKind, "followed_thread"),
    ));
}

export async function clearFollowedThreadSuppressionForReceiver(params: {
  followerType: "user" | "agent";
  followerId: string;
  threadChannelId: string;
  executor?: DatabaseExecutor;
}) {
  if (params.followerType !== "user") return;

  const db = executorFor(params.executor);
  await db
    .delete(inboxSuppressionStates)
    .where(and(
      eq(inboxSuppressionStates.receiverType, "user"),
      eq(inboxSuppressionStates.receiverId, params.followerId),
      eq(inboxSuppressionStates.targetChannelId, params.threadChannelId),
      eq(inboxSuppressionStates.targetKind, "followed_thread"),
    ));
}
