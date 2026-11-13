// An Artifact's original message (xxchan, #proj-workspace:2e5a5da3): the one
// through which it entered a conversation, `items.origin_message_id`, set
// once and never moved (save.ts: the attachment's message; webShare.ts: the
// message a share posted while it had none). Shown to a reader only while
// they can read that message now (platform/messages messageSource: its
// conversation as the reader's server shows it, the plan's history window,
// not retracted), whatever the Artifact's home: an Artifact moved out of a
// private conversation never names it, nor that it exists, to someone who
// can't see it. Never to a reader outside the Artifact's server (a public
// one read from another server) nor signed out (the public view has no such
// field). Null in every other case, one answer for every reason.
import { agentTaskThreadTarget, asChannelId, asMessageId, type AgentApiArtifactReadResponse, type ArtifactViewerData } from "@botiverse/raft-shared";
import { agentConversationRefs } from "../../platform/conversations";
import { messageSource, type MessageSource } from "../../platform/messages";
import type { ServerViewActor } from "../../platform/visibility";
import { accessOf, viewActor, type ArtifactAgent } from "./apiCommon";
import type { ArtifactItemRow } from "./schema";
import { readerViewActor, type ArtifactWebReader } from "./webCommon";

/** The origin's message where the reader (inside the Artifact's server) can read it now, and how it came. */
async function readableOrigin(reader: ServerViewActor, item: ArtifactItemRow): Promise<{ source: MessageSource; via: NonNullable<ArtifactItemRow["originVia"]> } | null> {
  if (!accessOf(reader, item).inside || item.originMessageId === null || item.originVia === null) return null;
  const source = await messageSource(reader, item.originMessageId);
  return source ? { source, via: item.originVia } : null;
}

/** ArtifactViewerData.origin for a signed-in person. */
export async function webOriginOf(reader: ArtifactWebReader, item: ArtifactItemRow): Promise<ArtifactViewerData["origin"]> {
  const origin = await readableOrigin(readerViewActor(reader), item);
  if (!origin) return null;
  const { source, via } = origin;
  return {
    messageId: asMessageId(source.messageId),
    conversationId: asChannelId(source.conversationId),
    ...(source.threadRootId !== null ? { threadRootId: asMessageId(source.threadRootId) } : {}),
    via,
  };
}

/**
 * The agent read's `origin`: the conversation as the agent names it
 * (platform/conversations agentConversationRefs: `#channel`, `dm:@peer`), a
 * thread's as its thread target (`<target>:<root short id>`); null also when
 * the agent can't name the conversation (a DM peer it can't name).
 */
export async function agentOriginOf(agent: ArtifactAgent, item: ArtifactItemRow): Promise<AgentApiArtifactReadResponse["origin"]> {
  const origin = await readableOrigin(viewActor(agent), item);
  if (!origin) return null;
  const { source, via } = origin;
  const ref = (await agentConversationRefs(agent, [source.conversationId])).get(source.conversationId);
  if (!ref?.target) return null;
  return {
    target: source.threadRootId !== null ? agentTaskThreadTarget(ref.target, source.threadRootId) : ref.target,
    messageId: source.messageId,
    via,
  };
}
