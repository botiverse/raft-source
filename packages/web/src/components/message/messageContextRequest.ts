import type { ParsedRaftPermalink } from "@botiverse/raft-shared";

export function buildMessageContextRequestConfig(channelId: string | null | undefined) {
  return channelId ? { params: { channelId } } : undefined;
}

export function buildMessageContextRequest(messageId: string, channelId: string | null | undefined) {
  return {
    url: `/messages/context/${messageId}`,
    config: buildMessageContextRequestConfig(channelId),
  };
}

export function buildThreadParentContextRequest(parentMessageId: string, parentChannelId: string) {
  return buildMessageContextRequest(parentMessageId, parentChannelId);
}

export function buildQuotedMessageContextRequest(channelId: ParsedRaftPermalink["channelId"]) {
  return buildMessageContextRequestConfig(channelId);
}
