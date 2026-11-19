// Task v2: a task always has a source, the message that asked for it
// (#wg-task-v2:#23). A create that comes without one and cannot be asked for
// one gets its creator's own ordinary channel message, posted now: a person's
// from the web's New task (routes/tasks.ts), an agent's from a CLI too old to
// send a source (routes/internalAgentApi.ts taskCreate, isPreTaskSourceCli).
// Each route checks its sender may post and keys its retries; the message,
// what agents are told about it, and the send's refusals are the same here.

import type { Server as SocketServer } from "socket.io";

import { JointChannelAccessChangedError } from "../lib/channelActorPermissions";
import type { RefusalInput, RefusalStatus } from "../lib/refusal";
import type { AgentOrchestrator } from "./agentOrchestrator";
import * as channelService from "./channelService";
import { DmPeerNotMemberError } from "./dmSendPolicy";
import * as messageService from "./messageService";

/**
 * The text of the message a sourceless create posts as the tasks' source: one
 * title (and its description) as written, or several as a list.
 */
export function creatorSourceMessageContent(items: readonly { title: string; description?: string | null }[]): string {
  if (items.length === 1) {
    const [item] = items;
    return item!.description ? `${item!.title}\n\n${item!.description}` : item!.title;
  }
  return items
    .map((item) => {
      const description = item.description ? `\n${item.description.split("\n").map((line) => `  ${line}`).join("\n")}` : "";
      return `- ${item.title}${description}`;
    })
    .join("\n");
}

/** The source message would be longer than any message may be (routes/messages MAX_MESSAGE_LENGTH). */
export const TASK_SOURCE_MESSAGE_TOO_LONG_REFUSAL = {
  code: "task_source_message_too_long",
  error: "These tasks are too long to post as one message: shorten the titles or create fewer at once.",
} as const satisfies RefusalInput;

/**
 * Post `content` (creatorSourceMessageContent) in `localChannelId` as the
 * creator's ordinary message (not a system line): broadcast, delivered and
 * replied to like any other, except that it mentions nobody: the creator
 * typed task titles, not a chat message, so an `@name` in a title pings no
 * one. Sent through the local channel; on a joint channel broadcastAndDeliver
 * stores it in the canonical (storage) channel, where createTasks requires the
 * source. `randomId` (a person's) or `agentSendKey` (an agent's) makes a retry
 * get the same message back instead of a second one. Throws what the send
 * throws (taskCreatorSourceSendRefusal answers the shared ones).
 */
export async function postTaskCreatorSourceMessage(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  input: {
    localChannelId: string;
    creator: { type: "user" | "agent"; id: string; name: string };
    taskCount: number;
    content: string;
    randomId?: string;
    agentSendKey?: string;
  },
) {
  const one = input.taskCount === 1;
  // slack-bridge-ordinary-message-producer: tasks.create_source
  return messageService.broadcastAndDeliver(io, agentOrchestrator, {
    channelId: input.localChannelId,
    senderType: input.creator.type,
    senderId: input.creator.id,
    senderName: input.creator.name,
    content: input.content,
    contentMentions: false,
    // Agents get it before the tasks exist: say what it is, so an agent
    // doesn't take the titles as a new request to make into tasks itself.
    agentContentPrefix: `[Posted automatically as the source of the ${one ? "task" : "tasks"} this ${input.creator.type === "user" ? "person" : "agent"} is creating from it in Raft now; ${one ? "it is" : "they are"} not yours unless assigned to you.]`,
    ...(input.randomId ? { randomId: input.randomId } : {}),
    // A replay under the same key with other text or another channel is the
    // key reused for a different create: refused, never answered with it.
    ...(input.agentSendKey ? { agentSendKey: input.agentSendKey, rejectMismatchedAgentSendReplay: true } : {}),
  });
}

/** The refusal for an error postTaskCreatorSourceMessage threw that either sender can meet; null for any other. */
export function taskCreatorSourceSendRefusal(err: unknown): { status: RefusalStatus; refusal: RefusalInput } | null {
  if (err instanceof DmPeerNotMemberError || err instanceof JointChannelAccessChangedError) {
    return { status: err.status, refusal: { code: err.code, error: err.message } };
  }
  if (err instanceof channelService.ChannelArchivedError) {
    return { status: 409, refusal: { code: "channel_archived", error: "This channel is archived: unarchive it before creating tasks in it." } };
  }
  return null;
}
