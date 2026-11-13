import { isSubConversationType } from "@botiverse/raft-shared";
import { inArray } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, channels, dmChannelIdentities, messages, users } from "../db/schema";
import { UUID_RE } from "../lib/messageId";
import type { TurnTriggerChannelFact, TurnTriggerFacts, TurnTriggerMessageFact, TurnTriggerRefs } from "./activityTurnSummaryView";
import { resolveLocalMessageStorage } from "./channelService";
import { loadExternalMessageAuthors } from "./externalProjectionService";

/**
 * The server's own records behind a page of turn triggers (Activity overview,
 * `trigger.display`): the channels and messages they name, by id, batched for
 * the page whatever the number of turns. Callers pass only triggers the viewer
 * may see (canUserAccessChannel). Three rounds, at most nine queries:
 *
 * 1. the channels and the messages;
 * 2. where joint channels and joint threads store their messages, and a joint
 *    thread's local parent (resolveLocalMessageStorage: two queries), the
 *    identity rows of DMs named without a message, external message authors;
 * 3. thread parent channels, user and agent names.
 *
 * Channel names come from the channel (a thread's from its parent channel),
 * sender handles from the message's own sender (users.name / agents.name, an
 * external author's display name; none for a system message), and a DM's
 * peer, for a DM named without a message, from its identity row as the agent
 * sees it. An id that is not a UUID is not looked up, so it does not resolve.
 */
export async function loadTurnTriggerFacts(agentId: string, serverId: string, refs: TurnTriggerRefs): Promise<TurnTriggerFacts> {
  const channelIds = refs.channelIds.filter((id) => UUID_RE.test(id));
  const messageIds = refs.messageIds.filter((id) => UUID_RE.test(id));
  const wantsPeer = new Set(refs.dmPeerChannelIds);
  const db = getDb();
  const [channelRows, messageRows] = await Promise.all([
    channelIds.length === 0 ? [] : db
      .select({ id: channels.id, type: channels.type, name: channels.name, parentChannelId: channels.parentChannelId, parentMessageId: channels.parentMessageId })
      .from(channels)
      .where(inArray(channels.id, channelIds)),
    messageIds.length === 0 ? [] : db
      .select({ id: messages.id, channelId: messages.channelId, senderType: messages.senderType, senderId: messages.senderId, messageType: messages.messageType })
      .from(messages)
      .where(inArray(messages.id, messageIds)),
  ]);

  const dmPeerChannelIds = channelRows.filter((row) => row.type === "dm" && wantsPeer.has(row.id)).map((row) => row.id);
  const chat = messageRows.filter((row) => row.messageType !== "system");
  const externalIds = chat.filter((row) => row.senderType === "external_projection").map((row) => row.id);
  const [storage, identityRows, externalAuthors] = await Promise.all([
    resolveLocalMessageStorage(serverId, channelRows, db),
    dmPeerChannelIds.length === 0 ? [] : db
      .select({ channelId: dmChannelIdentities.channelId, kind: dmChannelIdentities.kind, peerKey: dmChannelIdentities.peerKey })
      .from(dmChannelIdentities)
      .where(inArray(dmChannelIdentities.channelId, dmPeerChannelIds)),
    externalIds.length === 0 ? new Map() : loadExternalMessageAuthors(externalIds, db),
  ]);

  // A thread's parent, derived as canUserAccessChannel derives it: a joint
  // thread's local face through its projection's local parent, otherwise the
  // channel its parent message is in (`parentChannelId` is that channel,
  // cached by the 0297 triggers). The access check passed for every thread
  // here, so the parent it names is one the viewer may see.
  const parentOf = new Map<string, string>();
  for (const row of channelRows) {
    // A thread or a task conversation (task v2: its parent is the task's channel).
    if (!isSubConversationType(row.type)) continue;
    const parentId = storage.get(row.id)?.localParentChannelId ?? row.parentChannelId;
    if (parentId) parentOf.set(row.id, parentId);
  }
  // Only a human's DM with the agent: a human viewer cannot see an
  // agent-to-agent DM (canUserAccessChannel), so it is never looked up.
  const dmPeerUser = new Map<string, string>();
  for (const row of identityRows) {
    const participants = row.peerKey.split(":");
    const peerId = participants.find((id) => id !== agentId);
    if (row.kind === "human_agent" && participants.includes(agentId) && peerId) dmPeerUser.set(row.channelId, peerId);
  }
  const userIds = new Set([
    ...chat.filter((row) => row.senderType === "user").map((row) => row.senderId),
    ...dmPeerUser.values(),
  ].filter((id) => UUID_RE.test(id)));
  const agentIds = new Set(chat.filter((row) => row.senderType === "agent").map((row) => row.senderId).filter((id) => UUID_RE.test(id)));
  const parentIds = [...new Set(parentOf.values())];
  const [parentRows, userRows, agentRows] = await Promise.all([
    parentIds.length === 0 ? [] : db.select({ id: channels.id, type: channels.type, name: channels.name }).from(channels).where(inArray(channels.id, parentIds)),
    userIds.size === 0 ? [] : db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...userIds])),
    agentIds.size === 0 ? [] : db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, [...agentIds])),
  ]);

  const parents = new Map(parentRows.map((row) => [row.id, { type: row.type, name: row.name }] as const));
  const userNames = new Map(userRows.map((row) => [row.id, row.name] as const));
  const agentNames = new Map(agentRows.map((row) => [row.id, row.name] as const));
  const channelFacts = new Map<string, TurnTriggerChannelFact>();
  for (const row of channelRows) {
    const parentId = parentOf.get(row.id);
    const peerId = dmPeerUser.get(row.id);
    const dmPeerName = peerId ? userNames.get(peerId) : undefined;
    const storageChannelId = storage.get(row.id)?.storageChannelId;
    channelFacts.set(row.id, {
      type: row.type,
      name: row.name,
      ...(storageChannelId ? { storageChannelId } : {}),
      ...(row.type === "thread" ? { parentMessageId: row.parentMessageId, parent: (parentId && parents.get(parentId)) || null } : {}),
      ...(row.type === "task" ? { parent: (parentId && parents.get(parentId)) || null } : {}),
      ...(dmPeerName ? { dmPeerName } : {}),
    });
  }
  const messageFacts = new Map<string, TurnTriggerMessageFact>();
  for (const row of messageRows) {
    const senderName = row.messageType === "system" ? undefined
      : row.senderType === "user" ? userNames.get(row.senderId)
        : row.senderType === "agent" ? agentNames.get(row.senderId)
          : externalAuthors.get(row.id)?.displayName;
    messageFacts.set(row.id, { channelId: row.channelId, ...(senderName ? { senderName } : {}) });
  }
  return { channels: channelFacts, messages: messageFacts };
}
