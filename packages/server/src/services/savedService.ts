import { eq, and, asc, desc, sql, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db/index.js";
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
} from "../db/schema.js";

/** Save a message for the user. */
export async function saveMessage(userId: string, messageId: string, serverId: string) {
  const db = getDb();
  await db.insert(userSaved).values({
    userId,
    messageId,
    serverId,
  }).onConflictDoNothing();
}

/** Unsave a message. */
export async function unsaveMessage(userId: string, messageId: string) {
  const db = getDb();
  await db.delete(userSaved).where(
    and(eq(userSaved.userId, userId), eq(userSaved.messageId, messageId))
  );
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
    .leftJoin(parentChannels, eq(parentChannels.id, parentMessages.channelId))
    .leftJoin(directChannelHumans, and(sql`${directChannelHumans.channelId} = COALESCE(${localChannels.id}, ${channels.id})`, eq(directChannelHumans.userId, userId)))
    .leftJoin(parentChannelHumans, and(eq(parentChannelHumans.channelId, parentChannels.id), eq(parentChannelHumans.userId, userId)))
    .where(and(
      eq(messages.id, messageId),
      sql`(${channels.serverId} = ${serverId} OR ${jointChannelServers.serverId} = ${serverId})`,
      sql`${channels.deletedAt} IS NULL`,
      sql`(
        COALESCE(${localChannels.type}, ${channels.type}) = 'channel'
        OR (
          COALESCE(${localChannels.type}, ${channels.type}) IN ('private', 'joint', 'dm')
          AND ${directChannelHumans.userId} IS NOT NULL
        )
        OR (
          COALESCE(${localChannels.type}, ${channels.type}) = 'thread'
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
}

/** List saved messages for a user in a server, newest first. */
export async function listSaved(userId: string, serverId: string, opts?: {
  limit?: number;
  offset?: number;
  channelId?: string;
  q?: string;
  sort?: "asc" | "desc";
}): Promise<SavedEntry[]> {
  const db = getDb();
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
  const searchPattern = opts?.q ? `%${opts.q}%` : null;

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
        WHEN COALESCE(${localChannels.type}, ${channels.type}) = 'thread'
        THEN COALESCE(${parentLocalChannels.id}, ${parentChannels.id})
        ELSE NULL
      END`,
      parentChannelName: sql<string | null>`CASE
        WHEN COALESCE(${localChannels.type}, ${channels.type}) = 'thread'
        THEN COALESCE(${parentLocalChannels.name}, ${parentChannels.name})
        ELSE NULL
      END`,
      parentChannelType: sql<string | null>`CASE
        WHEN COALESCE(${localChannels.type}, ${channels.type}) = 'thread'
        THEN COALESCE(${parentLocalChannels.type}, ${parentChannels.type})
        ELSE NULL
      END`,
      parentMessagePreview: parentMessages.content,
      parentMessageSenderType: parentMessages.senderType,
      parentMessageSenderId: parentMessages.senderId,
      replyCount: sql<number>`CASE
        WHEN COALESCE(${localChannels.type}, ${channels.type}) = 'thread'
        THEN (SELECT count(*)::int FROM ${messages} saved_thread_reply WHERE saved_thread_reply.channel_id = ${messages.channelId})
        ELSE 0
      END`,
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
    .leftJoin(parentChannels, eq(parentChannels.id, parentMessages.channelId))
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
    .where(and(
      eq(userSaved.userId, userId),
      eq(userSaved.serverId, serverId),
      sql`(${channels.serverId} = ${serverId} OR ${jointChannelServers.serverId} = ${serverId})`,
      sql`${channels.deletedAt} IS NULL`,
      opts?.channelId
        ? sql`CASE
            WHEN COALESCE(${localChannels.type}, ${channels.type}) = 'thread' THEN COALESCE(${parentLocalChannels.id}, ${parentChannels.id})
            ELSE COALESCE(${localChannels.id}, ${channels.id})
          END = ${opts.channelId}::uuid`
        : undefined,
      searchPattern
        ? sql`(
            COALESCE(${localChannels.name}, ${channels.name}) ILIKE ${searchPattern}
            OR COALESCE(${parentLocalChannels.name}, ${parentChannels.name}) ILIKE ${searchPattern}
            OR COALESCE(${parentMessages.content}, '') ILIKE ${searchPattern}
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
          COALESCE(${localChannels.type}, ${channels.type}) = 'thread'
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
      parentMessagePreview: r.parentMessagePreview ?? null,
      parentMessageSenderType: r.parentMessageSenderType ?? null,
      parentMessageSenderId: r.parentMessageSenderId ?? null,
      replyCount: r.replyCount,
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
}): Promise<number> {
  const db = getDb();
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
    .leftJoin(parentChannels, eq(parentChannels.id, parentMessages.channelId))
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
      opts?.channelId
        ? sql`CASE
            WHEN COALESCE(${localChannels.type}, ${channels.type}) = 'thread' THEN COALESCE(${parentLocalChannels.id}, ${parentChannels.id})
            ELSE COALESCE(${localChannels.id}, ${channels.id})
          END = ${opts.channelId}::uuid`
        : undefined,
      searchPattern
        ? sql`(
            COALESCE(${localChannels.name}, ${channels.name}) ILIKE ${searchPattern}
            OR COALESCE(${parentLocalChannels.name}, ${parentChannels.name}) ILIKE ${searchPattern}
            OR COALESCE(${parentMessages.content}, '') ILIKE ${searchPattern}
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
          COALESCE(${localChannels.type}, ${channels.type}) = 'thread'
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
    .leftJoin(parentChannels, eq(parentChannels.id, parentMessages.channelId))
    .leftJoin(directChannelHumans, and(sql`${directChannelHumans.channelId} = COALESCE(${localChannels.id}, ${channels.id})`, eq(directChannelHumans.userId, userId)))
    .leftJoin(parentChannelHumans, and(eq(parentChannelHumans.channelId, parentChannels.id), eq(parentChannelHumans.userId, userId)))
    .where(and(
      eq(userSaved.userId, userId),
      eq(userSaved.serverId, serverId),
      sql`(${channels.serverId} = ${serverId} OR ${jointChannelServers.serverId} = ${serverId})`,
      inArray(userSaved.messageId, messageIds),
      sql`${channels.deletedAt} IS NULL`,
      sql`(
        COALESCE(${localChannels.type}, ${channels.type}) = 'channel'
        OR (
          COALESCE(${localChannels.type}, ${channels.type}) IN ('private', 'joint', 'dm')
          AND ${directChannelHumans.userId} IS NOT NULL
        )
        OR (
          COALESCE(${localChannels.type}, ${channels.type}) = 'thread'
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
