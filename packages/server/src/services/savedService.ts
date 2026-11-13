import { eq, and, asc, desc, gt, lte, sql, inArray, isNull, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb } from "../db/index";
import { historyLimitedPreview } from "./historyPreview";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import * as channelService from "./channelService";
import {
  userSaved,
  messages,
  channels,
  users,
  agents,
  channelHumans,
  jointChannels,
  jointChannelServers,
  externalMessageAuthorFacts,
  externalProjectionAvatarArtifacts,
  tasks,
  threadFollows,
} from "../db/schema";

/**
 * The channel a saved message's sub-conversation hangs off: a thread's parent
 * message channel, or (task v2) a task conversation's parent channel, which is
 * on its row. Top-level messages get none.
 */
function savedParentChannelJoin(
  parentChannels: { id: AnyPgColumn },
  parentMessages: { channelId: AnyPgColumn },
) {
  return sql`${parentChannels.id} = COALESCE(
    ${parentMessages.channelId},
    CASE WHEN ${channels.type} = 'task' THEN ${channels.parentChannelId} END
  )`;
}

/**
 * A guest's readable root channels on this server (the guest's listChannels
 * roots, as message search uses them), or null for anyone else. Saved rows
 * whose root is outside the set are neither savable nor listed (the
 * saved SQL alone lets every public channel through).
 */
async function guestReadableRootIds(userId: string, serverId: string): Promise<string[] | null> {
  if (await getActorServerRoleInServer(serverId, "user", userId) !== "guest") return null;
  return (await channelService.listChannels(serverId, userId, { archived: "include" })).map((channel) => channel.id);
}

/** The saved row's root (its own channel, or a sub-conversation's parent) is in `allowed`; an empty set admits nothing. */
function savedRootInSql(allowed: readonly string[], rootIdSql: SQL) {
  if (allowed.length === 0) return sql`FALSE`;
  return sql`${rootIdSql} IN (${sql.join(allowed.map((id) => sql`${id}::uuid`), sql`, `)})`;
}

/**
 * The thread a new save follows, or null to save without a follow: resolving
 * it can fail where a save never did (say, getOrCreateThreadForChannel's
 * "Parent message not found"), and a save must not fail for its follow.
 */
async function resolveThreadForNewSave(userId: string, messageId: string, serverId: string): Promise<string | null> {
  try {
    return await channelService.resolveSavedMessageThreadChannelId(serverId, userId, messageId);
  } catch (error) {
    console.warn(`[Saved] message ${messageId} saved without following its thread:`, error);
    return null;
  }
}

/**
 * Save a message for the user, and follow its thread (thread contract D,
 * db/schema.ts thread_follows): the save row, linked to the thread, and the
 * follow are written in one transaction under lockSaveFollow, so a racing
 * unsave either sees both or neither. A new save starts a follow unless one
 * is active (an unfollowed thread is re-followed). Re-saving a saved message
 * only restores its follow when it has none at all (an explicit unfollow
 * stands); a save from before the link changes nothing.
 * `followedThreadChannelId`: the thread whose follow this started.
 */
export async function saveMessage(userId: string, messageId: string, serverId: string): Promise<{ followedThreadChannelId: string | null }> {
  const db = getDb();
  const [existing] = await db.select({ threadChannelId: userSaved.threadChannelId })
    .from(userSaved)
    .where(and(eq(userSaved.userId, userId), eq(userSaved.messageId, messageId)))
    .limit(1);
  if (existing && !existing.threadChannelId) return { followedThreadChannelId: null };
  const threadChannelId = existing ? existing.threadChannelId : await resolveThreadForNewSave(userId, messageId, serverId);
  const started = await db.transaction(async (tx) => {
    if (threadChannelId) await channelService.lockSaveFollow(tx, userId, threadChannelId);
    if (!existing) {
      await tx.insert(userSaved).values({ userId, messageId, serverId, threadChannelId }).onConflictDoNothing();
    }
    if (!threadChannelId) return false;
    return channelService.writeSaveFollow(tx, userId, threadChannelId, { reactivateUnfollowed: !existing });
  });
  if (!started || !threadChannelId) return { followedThreadChannelId: null };
  await channelService.markThreadReadAfterFollowChange(userId, threadChannelId);
  return { followedThreadChannelId: threadChannelId };
}

/**
 * Unsave a message. The last save linked to a thread releases the follow
 * the save started, never one with another reason (channelService.releaseSaveFollow),
 * in one transaction with the delete under lockSaveFollow (a save row's thread
 * never changes, so it is read first to take the lock before any row lock).
 * `unfollowedThreadChannelId`: the thread whose follow this deleted.
 */
export async function unsaveMessage(userId: string, messageId: string): Promise<{ unfollowedThreadChannelId: string | null }> {
  const db = getDb();
  const savedRow = and(eq(userSaved.userId, userId), eq(userSaved.messageId, messageId));
  const [existing] = await db.select({ threadChannelId: userSaved.threadChannelId }).from(userSaved).where(savedRow).limit(1);
  const threadChannelId = existing?.threadChannelId ?? null;
  const released = await db.transaction(async (tx) => {
    if (threadChannelId) await channelService.lockSaveFollow(tx, userId, threadChannelId);
    await tx.delete(userSaved).where(savedRow);
    return threadChannelId ? channelService.releaseSaveFollow(tx, userId, threadChannelId) : false;
  });
  return { unfollowedThreadChannelId: released ? threadChannelId : null };
}

/**
 * Activity's Saved filter (`scope=saved`): the threads of this server the
 * user follows (not unfollowed) with a save of theirs linked to them, whatever
 * the follow's reason. Saves from before the link list nothing. Done threads
 * are listed here and hidden by the inbox read, as Pinned and All hide them.
 * Lowercased,
 * deduplicated and sorted, so the list is also a stable cache-key input.
 */
export async function listSavedFollowThreadChannelIds(userId: string, serverId: string): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ threadChannelId: threadFollows.threadChannelId })
    .from(userSaved)
    .innerJoin(threadFollows, and(
      sql`${threadFollows.threadChannelId} = ${userSaved.threadChannelId}`,
      eq(threadFollows.followerType, "user"),
      eq(threadFollows.followerId, userSaved.userId),
      isNull(threadFollows.unfollowedAt),
    ))
    .where(and(eq(userSaved.userId, userId), eq(userSaved.serverId, serverId)));
  return [...new Set(rows.map((row) => row.threadChannelId.toLowerCase()))].sort();
}

/** Check if a message is saved by the user. */
export async function isSaved(userId: string, messageId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.select({ messageId: userSaved.messageId })
    .from(userSaved)
    .where(and(eq(userSaved.userId, userId), eq(userSaved.messageId, messageId)))
    .limit(1);
  return rows.length > 0;
}

/** True when a message is visible from the caller server and may be saved. */
export async function canSaveMessage(userId: string, serverId: string, messageId: string): Promise<boolean> {
  const db = getDb();
  const guestRoots = await guestReadableRootIds(userId, serverId);
  const parentMessages = alias(messages, "saved_can_parent_messages");
  const parentChannels = alias(channels, "saved_can_parent_channels");
  const localChannels = alias(channels, "saved_can_local_channels");
  const directChannelHumans = alias(channelHumans, "saved_can_direct_channel_humans");
  const parentChannelHumans = alias(channelHumans, "saved_can_parent_channel_humans");
  const rows = await db
    .select({ messageId: messages.id })
    .from(messages)
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .leftJoin(jointChannels, and(
      eq(jointChannels.canonicalChannelId, messages.channelId),
      eq(jointChannels.status, "active"),
    ))
    .leftJoin(jointChannelServers, and(
      eq(jointChannelServers.jointChannelId, jointChannels.id),
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
    ))
    .leftJoin(localChannels, eq(localChannels.id, jointChannelServers.localChannelId))
    .leftJoin(parentMessages, eq(parentMessages.id, channels.parentMessageId))
    .leftJoin(parentChannels, savedParentChannelJoin(parentChannels, parentMessages))
    .leftJoin(directChannelHumans, and(sql`${directChannelHumans.channelId} = COALESCE(${localChannels.id}, ${channels.id})`, eq(directChannelHumans.userId, userId)))
    .leftJoin(parentChannelHumans, and(eq(parentChannelHumans.channelId, parentChannels.id), eq(parentChannelHumans.userId, userId)))
    .where(and(
      eq(messages.id, messageId),
      sql`(${channels.serverId} = ${serverId} OR ${jointChannelServers.serverId} = ${serverId})`,
      sql`${channels.deletedAt} IS NULL`,
      guestRoots ? savedRootInSql(guestRoots, sql`CASE
        WHEN COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task') THEN ${parentChannels.id}
        ELSE COALESCE(${localChannels.id}, ${channels.id})
      END`) : undefined,
      sql`(
        COALESCE(${localChannels.type}, ${channels.type}) = 'channel'
        OR (
          COALESCE(${localChannels.type}, ${channels.type}) IN ('private', 'joint', 'dm')
          AND ${directChannelHumans.userId} IS NOT NULL
        )
        OR (
          COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task')
          AND ${parentChannels.deletedAt} IS NULL
          AND (
            ${parentChannels.type} = 'channel'
            OR (
              ${parentChannels.type} IN ('private', 'joint', 'dm')
              AND ${parentChannelHumans.userId} IS NOT NULL
            )
          )
        )
      )`,
    ))
    .limit(1);
  return rows.length > 0;
}

export interface SavedEntry {
  messageId: string;
  channelId: string;
  channelName: string;
  channelType: string;
  content: string;
  senderType: string;
  senderId: string;
  senderName: string | null;
  senderAvatarUrl: string | null;
  createdAt: string;
  savedAt: string;
  /** For thread messages: the parent channel's ID */
  parentChannelId: string | null;
  /** For thread messages: the parent channel's name */
  parentChannelName: string | null;
  /** For thread messages: the parent channel's type */
  parentChannelType: string | null;
  /** For thread messages: the parent message ID (thread root) */
  parentMessageId: string | null;
  parentMessagePreview: string | null;
  parentMessageSenderType: string | null;
  parentMessageSenderId: string | null;
  replyCount: number;
  /** Task v2: set for a message in a task conversation (its parent is the task, not a message). */
  taskId?: string;
  taskNumber?: number;
  taskTitle?: string;
}

/** List saved messages for a user in a server, newest first. */
export async function listSaved(userId: string, serverId: string, opts?: {
  limit?: number;
  offset?: number;
  channelId?: string;
  q?: string;
  sort?: "asc" | "desc";
  /** List inside the plan's history window, or (`side: "behind"`) what it leaves out (services/historyWindow.ts). */
  history?: { cutoff: Date; side: "inside" | "behind" };
}): Promise<SavedEntry[]> {
  const db = getDb();
  const guestRoots = await guestReadableRootIds(userId, serverId);
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;
  const parentMessages = alias(messages, "saved_parent_messages");
  const parentChannels = alias(channels, "saved_parent_channels");
  const parentJointChannels = alias(jointChannels, "saved_parent_joint_channels");
  const parentJointServers = alias(jointChannelServers, "saved_parent_joint_servers");
  const parentLocalChannels = alias(channels, "saved_parent_local_channels");
  const localChannels = alias(channels, "saved_local_channels");
  const directChannelHumans = alias(channelHumans, "saved_direct_channel_humans");
  const parentChannelHumans = alias(channelHumans, "saved_parent_channel_humans");
  const savedSenderUsers = alias(users, "saved_sender_users");
  const savedSenderAgents = alias(agents, "saved_sender_agents");
  const savedExternalAuthors = alias(externalMessageAuthorFacts, "saved_external_authors");
  const savedExternalAvatars = alias(externalProjectionAvatarArtifacts, "saved_external_avatars");
  const savedTasks = alias(tasks, "saved_tasks");
  const searchPattern = opts?.q ? `%${opts.q}%` : null;
  const historyCutoff = opts?.history?.cutoff;

  const rows = await db
    .select({
      messageId: messages.id,
      channelId: sql<string>`COALESCE(${localChannels.id}, ${messages.channelId})`,
      channelName: sql<string>`COALESCE(${localChannels.name}, ${channels.name})`,
      channelType: sql<string>`COALESCE(${localChannels.type}, ${channels.type})`,
      channelParentMessageId: sql<string | null>`COALESCE(${localChannels.parentMessageId}, ${channels.parentMessageId})`,
      content: messages.content,
      senderType: messages.senderType,
      senderId: messages.senderId,
      senderName: sql<string | null>`COALESCE(${savedExternalAuthors.displayName}, ${savedSenderUsers.displayName}, ${savedSenderUsers.name}, ${savedSenderAgents.displayName}, ${savedSenderAgents.name})`,
      senderAvatarUrl: sql<string | null>`CASE
        WHEN ${savedExternalAvatars.state} = 'active'
          AND ${savedExternalAvatars.publicUrl} = ${savedExternalAuthors.avatarUrl}
          AND ${savedExternalAvatars.sourceDigest} = ${savedExternalAuthors.avatarDigest}
        THEN ${savedExternalAvatars.publicUrl}
        ELSE NULL
      END`,
      createdAt: messages.createdAt,
      savedAt: userSaved.createdAt,
      parentChannelId: sql<string | null>`CASE
        WHEN COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task')
        THEN COALESCE(${parentLocalChannels.id}, ${parentChannels.id})
        ELSE NULL
      END`,
      parentChannelName: sql<string | null>`CASE
        WHEN COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task')
        THEN COALESCE(${parentLocalChannels.name}, ${parentChannels.name})
        ELSE NULL
      END`,
      parentChannelType: sql<string | null>`CASE
        WHEN COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task')
        THEN COALESCE(${parentLocalChannels.type}, ${parentChannels.type})
        ELSE NULL
      END`,
      parentMessagePreview: parentMessages.content,
      parentMessageCreatedAt: parentMessages.createdAt,
      parentMessageSenderType: parentMessages.senderType,
      parentMessageSenderId: parentMessages.senderId,
      replyCount: sql<number>`CASE
        WHEN COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task')
        THEN (SELECT count(*)::int FROM ${messages} saved_thread_reply WHERE saved_thread_reply.channel_id = ${messages.channelId})
        ELSE 0
      END`,
      // Task v2: the canonical task conversation (storage) names its task.
      taskId: savedTasks.id,
      taskNumber: savedTasks.taskNumber,
      taskTitle: savedTasks.title,
    })
    .from(userSaved)
    .innerJoin(messages, eq(userSaved.messageId, messages.id))
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .leftJoin(jointChannels, and(
      eq(jointChannels.canonicalChannelId, messages.channelId),
      eq(jointChannels.status, "active"),
    ))
    .leftJoin(jointChannelServers, and(
      eq(jointChannelServers.jointChannelId, jointChannels.id),
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
    ))
    .leftJoin(localChannels, eq(localChannels.id, jointChannelServers.localChannelId))
    .leftJoin(parentMessages, eq(parentMessages.id, channels.parentMessageId))
    .leftJoin(parentChannels, savedParentChannelJoin(parentChannels, parentMessages))
    .leftJoin(parentJointChannels, and(
      eq(parentJointChannels.canonicalChannelId, parentChannels.id),
      eq(parentJointChannels.status, "active"),
    ))
    .leftJoin(parentJointServers, and(
      eq(parentJointServers.jointChannelId, parentJointChannels.id),
      eq(parentJointServers.serverId, serverId),
      eq(parentJointServers.status, "active"),
    ))
    .leftJoin(parentLocalChannels, eq(parentLocalChannels.id, parentJointServers.localChannelId))
    .leftJoin(directChannelHumans, and(sql`${directChannelHumans.channelId} = COALESCE(${localChannels.id}, ${channels.id})`, eq(directChannelHumans.userId, userId)))
    .leftJoin(parentChannelHumans, and(
      sql`${parentChannelHumans.channelId} = COALESCE(${parentLocalChannels.id}, ${parentChannels.id})`,
      eq(parentChannelHumans.userId, userId),
    ))
    .leftJoin(savedSenderUsers, and(
      sql`${messages.senderType} = 'user'`,
      sql`${savedSenderUsers.id}::text = ${messages.senderId}`,
    ))
    .leftJoin(savedSenderAgents, and(
      sql`${messages.senderType} = 'agent'`,
      sql`${savedSenderAgents.id}::text = ${messages.senderId}`,
    ))
    .leftJoin(savedExternalAuthors, and(
      sql`${messages.senderType} = 'external_projection'`,
      eq(savedExternalAuthors.messageId, messages.id),
    ))
    .leftJoin(savedExternalAvatars, eq(savedExternalAvatars.id, savedExternalAuthors.avatarArtifactId))
    .leftJoin(savedTasks, and(sql`${channels.type} = 'task'`, eq(savedTasks.id, channels.taskId)))
    .where(and(
      eq(userSaved.userId, userId),
      eq(userSaved.serverId, serverId),
      sql`(${channels.serverId} = ${serverId} OR ${jointChannelServers.serverId} = ${serverId})`,
      sql`${channels.deletedAt} IS NULL`,
      // Only what the plan's history window shows (cindyz, task #8: the saved
      // list is no exception; what it leaves out is counted, not listed).
      opts?.history
        ? opts.history.side === "inside" ? gt(messages.createdAt, opts.history.cutoff) : lte(messages.createdAt, opts.history.cutoff)
        : undefined,
      opts?.channelId
        ? sql`CASE
            WHEN COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task') THEN COALESCE(${parentLocalChannels.id}, ${parentChannels.id})
            ELSE COALESCE(${localChannels.id}, ${channels.id})
          END = ${opts.channelId}::uuid`
        : undefined,
      guestRoots ? savedRootInSql(guestRoots, sql`CASE
        WHEN COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task') THEN COALESCE(${parentLocalChannels.id}, ${parentChannels.id})
        ELSE COALESCE(${localChannels.id}, ${channels.id})
      END`) : undefined,
      searchPattern
        ? sql`(
            COALESCE(${localChannels.name}, ${channels.name}) ILIKE ${searchPattern}
            OR COALESCE(${parentLocalChannels.name}, ${parentChannels.name}) ILIKE ${searchPattern}
            OR (${historyCutoff ? sql`${parentMessages.createdAt} > ${historyCutoff}` : sql`true`} AND COALESCE(${parentMessages.content}, '') ILIKE ${searchPattern})
            OR ${messages.content} ILIKE ${searchPattern}
            OR COALESCE(${savedExternalAuthors.displayName}, ${savedSenderUsers.displayName}, ${savedSenderUsers.name}, ${savedSenderAgents.displayName}, ${savedSenderAgents.name}, '') ILIKE ${searchPattern}
          )`
        : undefined,
      sql`(
        COALESCE(${localChannels.type}, ${channels.type}) = 'channel'
        OR (
          COALESCE(${localChannels.type}, ${channels.type}) IN ('private', 'joint', 'dm')
          AND ${directChannelHumans.userId} IS NOT NULL
        )
        OR (
          COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task')
          AND COALESCE(${parentLocalChannels.deletedAt}, ${parentChannels.deletedAt}) IS NULL
          AND (
            COALESCE(${parentLocalChannels.type}, ${parentChannels.type}) = 'channel'
            OR (
              COALESCE(${parentLocalChannels.type}, ${parentChannels.type}) IN ('private', 'joint', 'dm')
              AND ${parentChannelHumans.userId} IS NOT NULL
            )
          )
        )
      )`,
    ))
    .orderBy(
      opts?.sort === "asc" ? asc(userSaved.createdAt) : desc(userSaved.createdAt),
      opts?.sort === "asc" ? asc(userSaved.messageId) : desc(userSaved.messageId),
    )
    .limit(limit)
    .offset(offset);

  if (rows.some((row) => row.senderType === "external_projection" && !row.senderName)) {
    throw new Error("External projection saved row is missing immutable author fact");
  }

  return rows.map(r => {
    return {
      messageId: r.messageId,
      channelId: r.channelId,
      channelName: r.channelName,
      channelType: r.channelType,
      content: r.content,
      senderType: r.senderType,
      senderId: r.senderId,
      senderName: r.senderName ?? null,
      senderAvatarUrl: r.senderAvatarUrl ?? null,
      createdAt: r.createdAt.toISOString(),
      savedAt: r.savedAt.toISOString(),
      parentChannelId: r.parentChannelId ?? null,
      parentChannelName: r.parentChannelName ?? null,
      parentChannelType: r.parentChannelType ?? null,
      parentMessageId: r.channelParentMessageId ?? null,
      // A thread's first message behind the window: a 40-character glimpse, as
      // Activity and search show it, never its full text.
      parentMessagePreview: historyCutoff && r.parentMessageCreatedAt && r.parentMessageCreatedAt <= historyCutoff
        ? historyLimitedPreview(r.parentMessagePreview)
        : r.parentMessagePreview ?? null,
      parentMessageSenderType: r.parentMessageSenderType ?? null,
      parentMessageSenderId: r.parentMessageSenderId ?? null,
      replyCount: r.replyCount,
      ...(r.taskId ? { taskId: r.taskId, taskNumber: r.taskNumber ?? undefined, taskTitle: r.taskTitle ?? undefined } : {}),
    };
  });
}

/**
 * Count a user's saved messages on a server. Mirrors listSaved's inner joins so
 * the count matches what is actually listable (orphaned saves of deleted
 * messages/channels are excluded, exactly as listSaved drops them). Cheap COUNT
 * — no row materialization or parent-channel resolution.
 */
export async function countSaved(userId: string, serverId: string, opts?: {
  channelId?: string;
  q?: string;
  /** Count inside the plan's history window, or (`side: "behind"`) what it leaves out. */
  history?: { cutoff: Date; side: "inside" | "behind" };
}): Promise<number> {
  const db = getDb();
  const guestRoots = await guestReadableRootIds(userId, serverId);
  const parentMessages = alias(messages, "saved_count_parent_messages");
  const parentChannels = alias(channels, "saved_count_parent_channels");
  const parentJointChannels = alias(jointChannels, "saved_count_parent_joint_channels");
  const parentJointServers = alias(jointChannelServers, "saved_count_parent_joint_servers");
  const parentLocalChannels = alias(channels, "saved_count_parent_local_channels");
  const localChannels = alias(channels, "saved_count_local_channels");
  const directChannelHumans = alias(channelHumans, "saved_count_direct_channel_humans");
  const parentChannelHumans = alias(channelHumans, "saved_count_parent_channel_humans");
  const savedSenderUsers = alias(users, "saved_count_sender_users");
  const savedSenderAgents = alias(agents, "saved_count_sender_agents");
  const savedExternalAuthors = alias(externalMessageAuthorFacts, "saved_count_external_authors");
  const searchPattern = opts?.q ? `%${opts.q}%` : null;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userSaved)
    .innerJoin(messages, eq(userSaved.messageId, messages.id))
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .leftJoin(jointChannels, and(
      eq(jointChannels.canonicalChannelId, messages.channelId),
      eq(jointChannels.status, "active"),
    ))
    .leftJoin(jointChannelServers, and(
      eq(jointChannelServers.jointChannelId, jointChannels.id),
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
    ))
    .leftJoin(localChannels, eq(localChannels.id, jointChannelServers.localChannelId))
    .leftJoin(parentMessages, eq(parentMessages.id, channels.parentMessageId))
    .leftJoin(parentChannels, savedParentChannelJoin(parentChannels, parentMessages))
    .leftJoin(parentJointChannels, and(
      eq(parentJointChannels.canonicalChannelId, parentChannels.id),
      eq(parentJointChannels.status, "active"),
    ))
    .leftJoin(parentJointServers, and(
      eq(parentJointServers.jointChannelId, parentJointChannels.id),
      eq(parentJointServers.serverId, serverId),
      eq(parentJointServers.status, "active"),
    ))
    .leftJoin(parentLocalChannels, eq(parentLocalChannels.id, parentJointServers.localChannelId))
    .leftJoin(directChannelHumans, and(sql`${directChannelHumans.channelId} = COALESCE(${localChannels.id}, ${channels.id})`, eq(directChannelHumans.userId, userId)))
    .leftJoin(parentChannelHumans, and(
      sql`${parentChannelHumans.channelId} = COALESCE(${parentLocalChannels.id}, ${parentChannels.id})`,
      eq(parentChannelHumans.userId, userId),
    ))
    .leftJoin(savedSenderUsers, and(
      sql`${messages.senderType} = 'user'`,
      sql`${savedSenderUsers.id}::text = ${messages.senderId}`,
    ))
    .leftJoin(savedSenderAgents, and(
      sql`${messages.senderType} = 'agent'`,
      sql`${savedSenderAgents.id}::text = ${messages.senderId}`,
    ))
    .leftJoin(savedExternalAuthors, and(
      sql`${messages.senderType} = 'external_projection'`,
      eq(savedExternalAuthors.messageId, messages.id),
    ))
    .where(and(
      eq(userSaved.userId, userId),
      eq(userSaved.serverId, serverId),
      sql`(${channels.serverId} = ${serverId} OR ${jointChannelServers.serverId} = ${serverId})`,
      sql`${channels.deletedAt} IS NULL`,
      opts?.history
        ? opts.history.side === "inside" ? gt(messages.createdAt, opts.history.cutoff) : lte(messages.createdAt, opts.history.cutoff)
        : undefined,
      opts?.channelId
        ? sql`CASE
            WHEN COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task') THEN COALESCE(${parentLocalChannels.id}, ${parentChannels.id})
            ELSE COALESCE(${localChannels.id}, ${channels.id})
          END = ${opts.channelId}::uuid`
        : undefined,
      guestRoots ? savedRootInSql(guestRoots, sql`CASE
        WHEN COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task') THEN COALESCE(${parentLocalChannels.id}, ${parentChannels.id})
        ELSE COALESCE(${localChannels.id}, ${channels.id})
      END`) : undefined,
      searchPattern
        ? sql`(
            COALESCE(${localChannels.name}, ${channels.name}) ILIKE ${searchPattern}
            OR COALESCE(${parentLocalChannels.name}, ${parentChannels.name}) ILIKE ${searchPattern}
            OR (${opts?.history ? sql`${parentMessages.createdAt} > ${opts.history.cutoff}` : sql`true`} AND COALESCE(${parentMessages.content}, '') ILIKE ${searchPattern})
            OR ${messages.content} ILIKE ${searchPattern}
            OR COALESCE(${savedExternalAuthors.displayName}, ${savedSenderUsers.displayName}, ${savedSenderUsers.name}, ${savedSenderAgents.displayName}, ${savedSenderAgents.name}, '') ILIKE ${searchPattern}
          )`
        : undefined,
      sql`(
        COALESCE(${localChannels.type}, ${channels.type}) = 'channel'
        OR (
          COALESCE(${localChannels.type}, ${channels.type}) IN ('private', 'joint', 'dm')
          AND ${directChannelHumans.userId} IS NOT NULL
        )
        OR (
          COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task')
          AND COALESCE(${parentLocalChannels.deletedAt}, ${parentChannels.deletedAt}) IS NULL
          AND (
            COALESCE(${parentLocalChannels.type}, ${parentChannels.type}) = 'channel'
            OR (
              COALESCE(${parentLocalChannels.type}, ${parentChannels.type}) IN ('private', 'joint', 'dm')
              AND ${parentChannelHumans.userId} IS NOT NULL
            )
          )
        )
      )`,
    ));
  return row?.count ?? 0;
}

/** Get visible saved message IDs for a set of messages (for batch checking in message list). */
export async function getSavedMessageIds(userId: string, serverId: string, messageIds: string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const db = getDb();
  const guestRoots = await guestReadableRootIds(userId, serverId);
  const parentMessages = alias(messages, "saved_check_parent_messages");
  const parentChannels = alias(channels, "saved_check_parent_channels");
  const localChannels = alias(channels, "saved_check_local_channels");
  const directChannelHumans = alias(channelHumans, "saved_check_direct_channel_humans");
  const parentChannelHumans = alias(channelHumans, "saved_check_parent_channel_humans");
  const rows = await db.select({ messageId: userSaved.messageId })
    .from(userSaved)
    .innerJoin(messages, eq(userSaved.messageId, messages.id))
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .leftJoin(jointChannels, and(
      eq(jointChannels.canonicalChannelId, messages.channelId),
      eq(jointChannels.status, "active"),
    ))
    .leftJoin(jointChannelServers, and(
      eq(jointChannelServers.jointChannelId, jointChannels.id),
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
    ))
    .leftJoin(localChannels, eq(localChannels.id, jointChannelServers.localChannelId))
    .leftJoin(parentMessages, eq(parentMessages.id, channels.parentMessageId))
    .leftJoin(parentChannels, savedParentChannelJoin(parentChannels, parentMessages))
    .leftJoin(directChannelHumans, and(sql`${directChannelHumans.channelId} = COALESCE(${localChannels.id}, ${channels.id})`, eq(directChannelHumans.userId, userId)))
    .leftJoin(parentChannelHumans, and(eq(parentChannelHumans.channelId, parentChannels.id), eq(parentChannelHumans.userId, userId)))
    .where(and(
      eq(userSaved.userId, userId),
      eq(userSaved.serverId, serverId),
      sql`(${channels.serverId} = ${serverId} OR ${jointChannelServers.serverId} = ${serverId})`,
      inArray(userSaved.messageId, messageIds),
      sql`${channels.deletedAt} IS NULL`,
      guestRoots ? savedRootInSql(guestRoots, sql`CASE
        WHEN COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task') THEN ${parentChannels.id}
        ELSE COALESCE(${localChannels.id}, ${channels.id})
      END`) : undefined,
      sql`(
        COALESCE(${localChannels.type}, ${channels.type}) = 'channel'
        OR (
          COALESCE(${localChannels.type}, ${channels.type}) IN ('private', 'joint', 'dm')
          AND ${directChannelHumans.userId} IS NOT NULL
        )
        OR (
          COALESCE(${localChannels.type}, ${channels.type}) IN ('thread', 'task')
          AND ${parentChannels.deletedAt} IS NULL
          AND (
            ${parentChannels.type} = 'channel'
            OR (
              ${parentChannels.type} IN ('private', 'joint', 'dm')
              AND ${parentChannelHumans.userId} IS NOT NULL
            )
          )
        )
      )`,
    ));
  return new Set(rows.map(r => r.messageId));
}
