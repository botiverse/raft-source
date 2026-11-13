import { and, eq, inArray, isNull } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channels, messages } from "../db/schema";
import { filterAgentAccessibleChannelIds, filterUserAccessibleChannelIds, getActiveJointThreadProjectionsByCanonicalThreadsForServer } from "../services/channelService";

/** Local permission identity and canonical message storage are deliberately distinct. */
export type AnalysisSource = { localId: string; storageId: string; target: string; parentId?: string };

export async function includeThreadSources(roots: AnalysisSource[], serverId: string, userId: string, agentId: string): Promise<AnalysisSource[]> {
  if (!roots.length) return roots;
  // Resolve by the actual parent message, including legacy rows without parent_channel_id.
  const threads = await getDb().select({ id: channels.id, serverId: channels.serverId, parentMessageId: messages.id, parentStorageId: messages.channelId })
    .from(channels).innerJoin(messages, eq(messages.id, channels.parentMessageId))
    .where(and(eq(channels.type, "thread"), isNull(channels.deletedAt), isNull(channels.archivedAt), isNull(messages.deletedAt),
      inArray(messages.channelId, roots.map(root => root.storageId))));
  const projections = await getActiveJointThreadProjectionsByCanonicalThreadsForServer(threads.map(thread => thread.id), serverId);
  const rootsByStorage = new Map(roots.map(root => [root.storageId, root]));
  const projectionsByCanonical = new Map(projections.filter(projection => projection.kind === "thread" && !projection.threadChannel.archivedAt).map(projection => [projection.canonicalThreadChannelId, projection]));
  const candidates: AnalysisSource[] = [];
  for (const thread of threads) {
    const root = rootsByStorage.get(thread.parentStorageId)!;
    const projection = projectionsByCanonical.get(thread.id);
    const localId = (projection?.localParentChannelId === root.localId ? projection.localThreadChannelId : null) ?? (thread.serverId === serverId && root.localId === root.storageId ? thread.id : null);
    if (localId) candidates.push({ localId, storageId: thread.id, parentId: root.localId, target: `${root.target}:${thread.parentMessageId.slice(0, 8)}` });
  }
  const ids = candidates.map(source => source.localId);
  const human = await filterUserAccessibleChannelIds(ids, userId, asServerId(serverId));
  const agent = await filterAgentAccessibleChannelIds(ids, agentId, asServerId(serverId));
  return [...roots, ...candidates.filter(source => human.has(source.localId) && agent.has(source.localId))];
}
