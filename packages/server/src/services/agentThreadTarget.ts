// A thread target as an agent writes it (`#channel:<msg8>`, `dm:@peer:<msg8>`):
// the root message it names, and that message's thread, created when no one
// has replied yet. `raft message send --target` (routes/agentWritableTarget)
// and an app notice's `object.conversation` (agentInboxItems) resolve it here,
// so both find the same thread under the same checks.
import { parseDmPeerRef } from "@botiverse/raft-shared";
import { and, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { getDb } from "../db/index";
import { channels, messages } from "../db/schema";
import { messageIdShortPrefixConditions, uuidShortIdRange } from "../lib/messageId";
import * as channelService from "./channelService";
import { isAppId } from "./rapRegistry";
import { getBuiltInConversationChannel } from "./rapRegistryStore";

export type ParsedThreadTarget =
  | { kind: "channel"; channelName: string; shortId: string }
  | { kind: "dm"; peerName: string; shortId: string };

export function parseThreadTarget(target: string): ParsedThreadTarget | null {
  const channelMatch = target.match(/^#(.+):([0-9a-f]{8})$/i);
  if (channelMatch) {
    const [, channelName, shortId] = channelMatch;
    return { kind: "channel", channelName, shortId };
  }

  if (target.startsWith("dm:@") || target.startsWith("DM:@")) {
    const rest = target.slice(4);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0) {
      const peerName = rest.slice(0, lastColon);
      const shortId = rest.slice(lastColon + 1);
      if (/^[0-9a-f]{8}$/i.test(shortId)) {
        return { kind: "dm", peerName, shortId };
      }
    }
  }

  return null;
}

export function isThreadTarget(target: string): boolean {
  return parseThreadTarget(target) !== null;
}

/**
 * The root message a thread target's 8-hex suffix names. Read-only. The suffix
 * is tried as a message short id in `parentLookupChannelId`, then as a thread
 * channel id short form anywhere in the server (`threadId=` in the header):
 * a thread id names a thread that already exists, and the reply still lands on
 * its parent message. Callers check that the message belongs to the parent
 * target they named.
 */
export async function findThreadTargetParentMessage(
  serverId: string,
  parentLookupChannelId: string,
  shortId: string,
): Promise<{ id: string; channelId: string } | null> {
  const db = getDb();
  let parentMsgs = await db
    .select({ id: messages.id, channelId: messages.channelId })
    .from(messages)
    .where(and(
      eq(messages.channelId, parentLookupChannelId),
      ...messageIdShortPrefixConditions(shortId),
    ))
    .limit(2);

  if (parentMsgs.length !== 1) {
    const bounds = uuidShortIdRange(shortId);
    const threadCandidates = await db
      .select({ id: channels.id, parentMessageId: channels.parentMessageId })
      .from(channels)
      .where(and(
        eq(channels.serverId, serverId),
        eq(channels.type, "thread"),
        gte(channels.id, bounds.lower),
        ...(bounds.upper ? [lt(channels.id, bounds.upper)] : []),
        isNull(channels.deletedAt),
        isNotNull(channels.parentMessageId),
      ))
      .limit(2);
    if (threadCandidates.length !== 1 || !threadCandidates[0].parentMessageId) return null;
    parentMsgs = await db
      .select({ id: messages.id, channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, threadCandidates[0].parentMessageId))
      .limit(1);
    if (parentMsgs.length !== 1) return null;
  }

  return parentMsgs[0] ?? null;
}

/**
 * The thread channel a thread target names, created (no reply posted, no
 * broadcast) when its root message has none yet; for a joint parent, this
 * server's projection of it. The root must be in the channel or DM the target
 * names and the agent must be able to post there (thread post authority =
 * parent membership). "forbidden": it exists but the agent may not post
 * there; null: not a thread target, or no such message there.
 */
export async function resolveOrCreateThreadTarget(
  serverId: string,
  agentId: string,
  target: string
): Promise<string | "forbidden" | null> {
  const parsed = parseThreadTarget(target);
  if (!parsed) return null;

  let localParentChannelId: string | null = null;
  let parentLookupChannelId: string | null = null;
  let builtInAppParentChannelId: string | null = null;
  if (parsed.kind === "channel") {
    const localChannel = await channelService.resolveChannelByName(serverId, agentId, `#${parsed.channelName}`);
    if (!localChannel || !["channel", "private", "joint"].includes(localChannel.type)) {
      return null;
    }
    parentLookupChannelId = localChannel.channelId;
    if (localChannel.type === "joint") {
      const resolved = await channelService.resolveChannelAccess({ serverId, channelId: localChannel.channelId });
      if (resolved?.kind === "joint") {
        localParentChannelId = localChannel.channelId;
        parentLookupChannelId = resolved.canonicalChannelId;
      }
    }
  } else {
    const dmChannel = await channelService.resolveChannelByName(serverId, agentId, `dm:@${parsed.peerName}`);
    if (!dmChannel || dmChannel.type !== "dm") return null;
    parentLookupChannelId = dmChannel.channelId;
    if (isAppId(parsed.peerName)) {
      const builtInAppDm = await getBuiltInConversationChannel(serverId, parsed.peerName, agentId);
      if (builtInAppDm?.id === dmChannel.channelId) {
        builtInAppParentChannelId = builtInAppDm.id;
      }
    }
  }

  const parentMsg = await findThreadTargetParentMessage(serverId, parentLookupChannelId, parsed.shortId);
  if (!parentMsg) return null;
  const parentChannel = await channelService.getChannel(parentMsg.channelId);
  if (!parentChannel) return null;

  if (parsed.kind === "channel") {
    const visibleParentChannel = localParentChannelId ? await channelService.getChannel(localParentChannelId) : parentChannel;
    if (!visibleParentChannel || !["channel", "private", "joint"].includes(visibleParentChannel.type) || visibleParentChannel.name !== parsed.channelName) {
      return null;
    }
  } else {
    if (parentChannel.type !== "dm") return null;
    // `peerName` may carry an explicit kind (`Twin~agent`); compare members
    // against the bare name, and only members of that kind.
    const parsedPeer = parseDmPeerRef(parsed.peerName);
    if (!parsedPeer.ok) return null;
    const { peerName: bareName, peerKind } = parsedPeer;
    const humans = peerKind === "agent" ? [] : await channelService.getChannelHumans(parentMsg.channelId);
    const agents = peerKind === "human" ? [] : await channelService.getChannelAgents(parentMsg.channelId);
    if (
      !humans.some((human) => human.name === bareName)
      && !agents.some((agent) => agent.name === bareName && (peerKind !== "agent" || agent.id !== agentId))
      && builtInAppParentChannelId !== parentMsg.channelId
    ) {
      return null;
    }
  }

  // Thread post authority = parent channel/DM membership. Following a thread
  // grants listen access only; it must not grant send rights.
  const canPostToParent = await channelService.canAgentPostToChannel(localParentChannelId ?? parentMsg.channelId, agentId);
  if (!canPostToParent) return "forbidden";

  const thread = await channelService.getOrCreateThreadForChannel(localParentChannelId ?? parentMsg.channelId, parentMsg.id, agentId, "agent");
  return thread.id;
}
