type HistoryMessageThreadCandidate = {
  id: string;
  threadId?: string | null;
};

type HistoryThreadSummary = {
  threadChannelId: string;
  replyCount: number;
};

export function getHistoryThreadParentMessageIds<T extends HistoryMessageThreadCandidate>(messages: T[]): string[] {
  return [...new Set(
    messages
      .filter((message) => typeof message.threadId === "string" && message.threadId.length > 0)
      .map((message) => message.id),
  )];
}

export function applyHistoryThreadMetadata<
  T extends HistoryMessageThreadCandidate,
>(
  messages: T[],
  threadSummaries: Record<string, HistoryThreadSummary>,
): Array<T & { replyCount: number }> {
  return messages.map((message) => ({
    ...message,
    replyCount: threadSummaries[message.id]?.replyCount ?? 0,
  }));
}
