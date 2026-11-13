export type SearchFailureKind = "request_failed" | "query_too_broad" | "search_timeout";

export function readSearchFailureCode(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== "object") return undefined;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const payload = data as { code?: unknown; errorCode?: unknown };
  return payload.code ?? payload.errorCode;
}

export function classifySearchFailure(error: unknown): SearchFailureKind {
  const code = readSearchFailureCode(error);
  if (code === "QUERY_TOO_BROAD") return "query_too_broad";
  if (code === "SEARCH_TIMEOUT") return "search_timeout";
  return "request_failed";
}

export function searchFailureTitleId(kind: SearchFailureKind) {
  if (kind === "query_too_broad") return "search.queryTooBroad";
  if (kind === "search_timeout") return "search.searchTimedOut";
  return "search.searchFailed";
}
