import {
  messageRef,
  setInteraction,
} from "@botiverse/raft-shared";
import type {
  MessageRef,
  SetInteractionCommandDescription,
} from "@botiverse/raft-shared";

import api from "../api/client";
import type { Message } from "./messageStore";
import type { VersionedReactionViewerSnapshot } from "./reactionReadModels";

export type MessageReactionCommandDescription = Omit<
  SetInteractionCommandDescription,
  "target"
> & { target: MessageRef };

export type MessageReactionMutationAck = Message & {
  reactionViewer?: VersionedReactionViewerSnapshot;
};

export function describeMessageReactionCommand(input: {
  serverId: string;
  messageId: string;
  emoji: string;
  active: boolean;
}): MessageReactionCommandDescription {
  return setInteraction(
    messageRef(input.serverId, input.messageId),
    "reaction",
    { emoji: input.emoji, active: input.active },
  ) as MessageReactionCommandDescription;
}

export async function executeMessageReactionCommand(
  command: MessageReactionCommandDescription,
): Promise<MessageReactionMutationAck> {
  const { data } = await api.request<MessageReactionMutationAck>({
    method: command.value.active ? "post" : "delete",
    url: `/messages/${command.target.id}/reactions`,
    data: { emoji: command.value.emoji },
  });
  return data;
}

export function setMessageReaction(input: {
  serverId: string;
  messageId: string;
  emoji: string;
  active: boolean;
}): Promise<MessageReactionMutationAck> {
  return executeMessageReactionCommand(describeMessageReactionCommand(input));
}
