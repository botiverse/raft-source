import {
  asServerId,
  extractSameConversationQuoteBlocks,
  isSubConversationType,
  QUOTE_REPLY_FEATURE_FLAG_KEY,
  verifyQuoteExcerptInContent,
  type ResolvedInlineQuote,
  type ResolvedInlineQuotesMap,
} from "@botiverse/raft-shared";
import { and, eq, gt, inArray, isNull, or, type SQL } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, channels, externalActorProjections, messages, tasks, users } from "../db/schema";
import { isMessageShortId, messageIdShortPrefixConditions, UUID_RE } from "../lib/messageId";
import { mapWithConcurrency } from "../lib/mapWithConcurrency";
import * as channelService from "./channelService";
import { evaluateFeatureFlag } from "./featureFlagService";
import { personLocalConversationId } from "./messageResourceAccess";
import { canView } from "./visibilityService";

export interface QuoteResolvableMessage {
  id: string;
  channelId: string;
  content: string;
  deletedAt?: Date | string | null;
  messageType?: string | null;
}

export interface ResolveInlineQuotesViewer {
  serverId: string;
  userId: string;
  historyCutoff?: Date;
  /**
   * Canonical storage channel ID when all messages in the batch are known to
   * live in a single storage conversation (e.g. `GET /channel/:id` after joint
   * projection). Omit for multi-channel batches (`GET /sync`).
   */
  storageChannelId?: string;
}

function isRetracted(deletedAt: Date | string | null | undefined): boolean {
  return deletedAt !== null && deletedAt !== undefined;
}

async function resolveStorageChannelIdForViewer(
  localOrCanonicalChannelId: string,
  serverId: string,
): Promise<string> {
  const channel = await channelService.getChannel(localOrCanonicalChannelId);
  if (!channel) return localOrCanonicalChannelId;
  if (channel.type === "joint") {
    const access = await channelService.resolveChannelAccess({ serverId, channelId: channel.id });
    if (access?.kind === "joint") return access.canonicalChannelId;
  }
  if (isSubConversationType(channel.type)) {
    const jointThread = await channelService.getJointThreadProjectionByLocalThread(channel.id, serverId);
    if (jointThread) return jointThread.canonicalThreadChannelId;
  }
  return channel.id;
}

/**
 * Resolve same-conversation inline quote blocks (`> <excerpt>\n> msg=<id>`) for
 * one authenticated viewer in a single batched pass.
 *
 * Security & privacy invariants (@Warden, @Tenny):
 * - Ephemeral read-time projection ONLY: never written to DB, never expanded in
 *   agent CLI reads, and NEVER attached to room-wide WebSocket broadcasts.
 * - Same-conversation scope is determined strictly by stored channel / thread
 *   `parentMessageId` / task `sourceMessageId`, never by text inside the message.
 * - Author, timestamp, and jump target are attached ONLY when:
 *   (1) `quote_reply_v0` is enabled on the viewer's server,
 *   (2) the target lives in the same conversation (or is the thread root / task source),
 *   (3) the target has not been retracted (`deletedAt == null`),
 *   (4) the viewer has read visibility to the target's conversation (`canView`)
 *       and the target is strictly within the viewer's history window, and
 *   (5) `verifyQuoteExcerptInContent` confirms the excerpt appears in target content.
 * - Any failed check omits that entry identically, so every failure degrades to a
 *   plain blockquote with zero existence oracle.
 */
export async function resolveInlineQuotesMapForViewer(
  inputMessages: readonly QuoteResolvableMessage[],
  viewer: ResolveInlineQuotesViewer,
): Promise<Map<string, ResolvedInlineQuotesMap>> {
  const result = new Map<string, ResolvedInlineQuotesMap>();
  if (inputMessages.length === 0) return result;

  const flag = await evaluateFeatureFlag({
    key: QUOTE_REPLY_FEATURE_FLAG_KEY,
    serverId: viewer.serverId,
  }).catch(() => ({ enabled: false }));
  if (!flag.enabled) return result;

  const candidatesByMsg: Array<{
    msg: QuoteResolvableMessage;
    blocks: ReturnType<typeof extractSameConversationQuoteBlocks>;
  }> = [];

  for (const msg of inputMessages) {
    if (isRetracted(msg.deletedAt)) continue;
    if (msg.messageType && msg.messageType !== "chat") continue;
    const blocks = extractSameConversationQuoteBlocks(msg.content);
    if (blocks.length > 0) {
      candidatesByMsg.push({ msg, blocks });
    }
  }
  if (candidatesByMsg.length === 0) return result;

  const db = getDb();

  // Map every quoting message's local/projected channelId to its stored storage channelId.
  const storageByInputChannelId = new Map<string, string>();
  if (viewer.storageChannelId) {
    for (const { msg } of candidatesByMsg) {
      storageByInputChannelId.set(msg.channelId, viewer.storageChannelId);
    }
  } else {
    const distinctInputChannelIds = [...new Set(candidatesByMsg.map(({ msg }) => msg.channelId))];
    await mapWithConcurrency(distinctInputChannelIds, 4, async (cid) => {
      storageByInputChannelId.set(cid, await resolveStorageChannelIdForViewer(cid, viewer.serverId));
    });
  }

  const distinctStorageChannelIds = [...new Set(storageByInputChannelId.values())];
  const storageChannelRows = await db
    .select({
      id: channels.id,
      serverId: channels.serverId,
      type: channels.type,
      parentMessageId: channels.parentMessageId,
    })
    .from(channels)
    .where(inArray(channels.id, distinctStorageChannelIds));

  const storageChannelById = new Map(storageChannelRows.map((row) => [row.id, row]));

  // Load `sourceMessageId` for any task v2 conversation channels in this batch.
  const taskStorageChannelIds = storageChannelRows
    .filter((row) => row.type === "task")
    .map((row) => row.id);
  const taskSourceByChannelId = new Map<string, string>();
  if (taskStorageChannelIds.length > 0) {
    const taskRows = await db
      .select({
        conversationChannelId: tasks.conversationChannelId,
        sourceMessageId: tasks.sourceMessageId,
      })
      .from(tasks)
      .where(inArray(tasks.conversationChannelId, taskStorageChannelIds));
    for (const row of taskRows) {
      if (row.conversationChannelId && row.sourceMessageId) {
        taskSourceByChannelId.set(row.conversationChannelId, row.sourceMessageId);
      }
    }
  }

  // Allowed parent message IDs (thread root or task source) per storageChannelId.
  const allowedParentMessageIdByStorage = new Map<string, string>();
  for (const ch of storageChannelRows) {
    if (ch.type === "thread" && ch.parentMessageId) {
      allowedParentMessageIdByStorage.set(ch.id, ch.parentMessageId);
    } else if (ch.type === "task") {
      const src = taskSourceByChannelId.get(ch.id);
      if (src) allowedParentMessageIdByStorage.set(ch.id, src);
    }
  }

  // Collect all unique referenced IDs across the batch to build ONE indexed query.
  const fullUuids = new Set<string>();
  const shortIds = new Set<string>();
  for (const { blocks } of candidatesByMsg) {
    for (const block of blocks) {
      if (UUID_RE.test(block.refId)) fullUuids.add(block.refId);
      else if (isMessageShortId(block.refId)) shortIds.add(block.refId);
    }
  }

  const idFilters: SQL[] = [];
  if (fullUuids.size > 0) {
    idFilters.push(inArray(messages.id, [...fullUuids]));
  }
  for (const shortId of shortIds) {
    const rangeConds = messageIdShortPrefixConditions(shortId);
    const combined = and(...rangeConds);
    if (combined) idFilters.push(combined);
  }
  if (idFilters.length === 0) return result;

  const allowedParentIds = [...new Set(allowedParentMessageIdByStorage.values())];
  const scopeCond =
    allowedParentIds.length > 0
      ? or(inArray(messages.channelId, distinctStorageChannelIds), inArray(messages.id, allowedParentIds))
      : inArray(messages.channelId, distinctStorageChannelIds);

  const targetRows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      senderType: messages.senderType,
      senderId: messages.senderId,
      content: messages.content,
      createdAt: messages.createdAt,
      deletedAt: messages.deletedAt,
      messageType: messages.messageType,
    })
    .from(messages)
    .where(
      and(
        scopeCond,
        isNull(messages.deletedAt),
        ...(viewer.historyCutoff ? [gt(messages.createdAt, viewer.historyCutoff)] : []),
        or(...idFilters),
      ),
    );

  if (targetRows.length === 0) return result;

  // Verify viewer read access to every distinct target channel (including parent channels of thread roots/task sources).
  const distinctTargetChannelIds = [...new Set(targetRows.map((row) => row.channelId))];
  const targetChannelRows = await db
    .select({
      id: channels.id,
      serverId: channels.serverId,
      type: channels.type,
    })
    .from(channels)
    .where(inArray(channels.id, distinctTargetChannelIds));

  const targetChannelById = new Map(targetChannelRows.map((row) => [row.id, row]));
  const localChannelEntries: Array<{ storageChannelId: string; localChannelId: string }> = [];
  await mapWithConcurrency(distinctTargetChannelIds, 4, async (cid) => {
    const ch = targetChannelById.get(cid);
    if (!ch) return;
    const localId = await personLocalConversationId(ch, viewer.serverId);
    if (localId) {
      localChannelEntries.push({ storageChannelId: cid, localChannelId: localId });
    }
  });

  const viewableStorageChannels = new Set<string>();
  if (localChannelEntries.length > 0) {
    const decisions = await canView(
      { type: "user", id: viewer.userId, serverId: asServerId(viewer.serverId) },
      localChannelEntries.map((entry) => ({ kind: "conversation" as const, channelId: entry.localChannelId })),
    );
    localChannelEntries.forEach((entry, idx) => {
      if (decisions[idx]) viewableStorageChannels.add(entry.storageChannelId);
    });
  }

  const viewableTargets = targetRows.filter((row) => {
    if (row.deletedAt !== null) return false;
    if (row.messageType && row.messageType !== "chat") return false;
    if (viewer.historyCutoff && row.createdAt.getTime() <= viewer.historyCutoff.getTime()) return false;
    return viewableStorageChannels.has(row.channelId);
  });
  if (viewableTargets.length === 0) return result;

  // Batch-resolve target author display names.
  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  const extIds = new Set<string>();
  for (const row of viewableTargets) {
    if (row.senderType === "user" && UUID_RE.test(row.senderId)) userIds.add(row.senderId);
    else if (row.senderType === "agent" && UUID_RE.test(row.senderId)) agentIds.add(row.senderId);
    else if (row.senderType === "external_projection" && UUID_RE.test(row.senderId)) extIds.add(row.senderId);
  }

  const [userRows, agentRows, extRows] = await Promise.all([
    userIds.size > 0
      ? db
          .select({ id: users.id, displayName: users.displayName, name: users.name })
          .from(users)
          .where(inArray(users.id, [...userIds]))
      : Promise.resolve([]),
    agentIds.size > 0
      ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, [...agentIds]))
      : Promise.resolve([]),
    extIds.size > 0
      ? db
          .select({ id: externalActorProjections.id, displayName: externalActorProjections.displayName })
          .from(externalActorProjections)
          .where(inArray(externalActorProjections.id, [...extIds]))
      : Promise.resolve([]),
  ]);

  const userNameById = new Map(userRows.map((u) => [u.id, u.displayName || u.name || "User"]));
  const agentNameById = new Map(agentRows.map((a) => [a.id, a.name || "Agent"]));
  const extNameById = new Map(extRows.map((e) => [e.id, e.displayName || "External user"]));

  const authorOf = (row: (typeof viewableTargets)[number]): ResolvedInlineQuote["author"] => {
    if (row.senderType === "user") {
      return { name: userNameById.get(row.senderId) ?? "User", type: "user" };
    }
    if (row.senderType === "agent") {
      return { name: agentNameById.get(row.senderId) ?? "Agent", type: "agent" };
    }
    if (row.senderType === "external_projection") {
      return { name: extNameById.get(row.senderId) ?? "External user", type: "external_projection" };
    }
    return { name: "System", type: "system" };
  };

  for (const { msg, blocks } of candidatesByMsg) {
    const mStorageChannelId = storageByInputChannelId.get(msg.channelId);
    if (!mStorageChannelId || !storageChannelById.has(mStorageChannelId)) continue;
    const allowedParentId = allowedParentMessageIdByStorage.get(mStorageChannelId) ?? null;

    const mapForMsg: ResolvedInlineQuotesMap = {};
    for (const block of blocks) {
      const refIsFullUuid = UUID_RE.test(block.refId);
      const matches = viewableTargets.filter((candidate) => {
        const sameConversation =
          candidate.channelId === mStorageChannelId ||
          (allowedParentId !== null && candidate.id === allowedParentId);
        if (!sameConversation) return false;
        const candidateLower = candidate.id.toLowerCase();
        return refIsFullUuid ? candidateLower === block.refId : candidateLower.startsWith(block.refId);
      });

      if (matches.length !== 1) continue;
      const target = matches[0];
      const verification = verifyQuoteExcerptInContent(block.excerpt, target.content);
      if (!verification.verified) continue;

      mapForMsg[String(block.blockIndex)] = {
        messageId: target.id,
        shortId: target.id.slice(0, 8),
        author: authorOf(target),
        createdAt: target.createdAt.toISOString(),
        isPartial: verification.isPartial,
      };
    }

    if (Object.keys(mapForMsg).length > 0) {
      result.set(msg.id, mapForMsg);
    }
  }

  return result;
}

/**
 * Shallow-clone each message in `inputMessages` with its per-viewer `resolvedQuotes`
 * attached when non-empty. Never mutates input objects (preserving broadcast safety).
 */
export async function attachResolvedInlineQuotesForViewer<T extends QuoteResolvableMessage>(
  inputMessages: readonly T[],
  viewer: ResolveInlineQuotesViewer,
): Promise<Array<T & { resolvedQuotes?: ResolvedInlineQuotesMap }>> {
  const map = await resolveInlineQuotesMapForViewer(inputMessages, viewer);
  if (map.size === 0) return [...inputMessages];
  return inputMessages.map((msg) => {
    const resolvedQuotes = map.get(msg.id);
    return resolvedQuotes ? { ...msg, resolvedQuotes } : msg;
  });
}
