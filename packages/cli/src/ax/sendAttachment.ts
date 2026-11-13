// Attached on every send (glimpse G1-13, qizhi-wang 10-14): a runtime that
// compacts without telling the daemon cannot be held for what its context
// has not seen (its contextId cannot bound "seen"), so with passive AX on,
// every send to a conversation comes back with the conversation's cards and
// latest messages, within GLIMPSE_PUSH_BUDGET_CHARS. Read with
// `consume=false`: an attachment is not a read, so read positions stay.
import type { SendAttachment, ThreadWindowMessage } from "@botiverse/raft-shared";
import { isLocalStateAgentId, parseRaftRefTarget, windowAttachmentCount } from "@botiverse/raft-shared/src/agentCliSurface";

import type { createAgentApiSurfaceClient } from "../agentApiPath";
import { enabledContextSignal } from "./passiveEngine";

/** Latest messages a send attachment shows (the same window a hold shows). */
const SEND_ATTACHMENT_MESSAGES = 3;

export function attachOnEverySend(agentId: string | undefined, target: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!agentId || !isLocalStateAgentId(agentId)) return false;
  const kind = parseRaftRefTarget(target)?.kind;
  if (kind !== "channel" && kind !== "channel-thread" && kind !== "dm" && kind !== "dm-thread") return false;
  const signal = enabledContextSignal(env);
  return signal !== undefined && !signal.compactionReported;
}

/**
 * The latest messages before the one just sent (anchored on its id, which
 * every history read accepts) and the cards; null when the read fails. Best
 * effort: the send has committed, so nothing here may fail the command.
 */
export async function fetchSendAttachment(
  agentApi: ReturnType<typeof createAgentApiSurfaceClient>,
  target: string,
  sentMessageId: string,
): Promise<SendAttachment | null> {
  try {
    const res = await agentApi.history.read({
      channel: target,
      limit: String(SEND_ATTACHMENT_MESSAGES),
      consume: "false",
      before: sentMessageId,
    });
    if (!res.ok || !res.data) return null;
    const messages: ThreadWindowMessage[] = (res.data.messages ?? []).map((m) => ({
      seq: typeof m.seq === "number" ? m.seq : undefined,
      sender: m.sender_name ?? null,
      timestamp: m.timestamp ?? null,
      content: m.content ?? "",
      attachmentCount: windowAttachmentCount(m),
    }));
    return {
      target,
      channelCard: res.data.channel_card ?? null,
      peerCard: res.data.peer_card ?? null,
      messages,
    };
  } catch {
    return null;
  }
}
