export type HistoryTopState = "load_older" | "history_limited" | "beginning";

export function getHistoryTopState(params: {
  hasMore: boolean;
  historyLimited: boolean;
}): HistoryTopState {
  if (params.hasMore) return "load_older";
  if (params.historyLimited) return "history_limited";
  return "beginning";
}

// The timeline's boundary row for a history-top state; `beginning` names the
// list's own start ("start" for a channel or DM, "replies-start" for a thread).
export function historyBoundaryVariant(
  state: HistoryTopState,
  beginning: "start" | "replies-start",
): "loading" | "history-limit" | "start" | "replies-start" {
  if (state === "load_older") return "loading";
  if (state === "history_limited") return "history-limit";
  return beginning;
}
