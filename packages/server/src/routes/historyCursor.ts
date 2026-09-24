export function classifyHistoryAroundCursor(around: string): "seq" | "short_id" | "message_id" {
  if (/^[0-9a-f]{8}$/i.test(around)) return "short_id";
  if (/^\d+$/.test(around)) return "seq";
  return "message_id";
}

export type HistoryPageDirection = "latest" | "before" | "after";

/**
 * Turn a chronological limit-plus-one result into a history page.
 *
 * `latest` and `before` queries are fetched newest-first and then reversed by
 * messageService, so their extra row is at the start. `after` queries are
 * fetched oldest-first, so their extra row is at the end.
 */
export function paginateHistoryProbe<T>(
  messages: readonly T[],
  limit: number,
  direction: HistoryPageDirection,
): { messages: T[]; hasOlder: boolean; hasNewer: boolean } {
  const hasMore = messages.length > limit;
  if (direction === "after") {
    return {
      messages: messages.slice(0, limit),
      hasOlder: false,
      hasNewer: hasMore,
    };
  }
  return {
    messages: messages.slice(Math.max(0, messages.length - limit)),
    hasOlder: hasMore,
    hasNewer: false,
  };
}
