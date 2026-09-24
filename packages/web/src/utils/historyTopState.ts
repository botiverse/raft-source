export type HistoryTopState = "load_older" | "history_limited" | "beginning";

export function getHistoryTopState(params: {
  hasMore: boolean;
  historyLimited: boolean;
}): HistoryTopState {
  if (params.hasMore) return "load_older";
  if (params.historyLimited) return "history_limited";
  return "beginning";
}
