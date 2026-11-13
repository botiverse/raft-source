// Core's search across first-party apps (first-party app mechanism §五):
// `GET /api/search`, for the signed-in person in their current server
// (X-Server-Id). Core works out the homes the reader can see once, then asks
// every first-party app that registers a search and is switched on for the
// server; each app searches its own index with that visibility condition in
// its own query, and the answer is one group per app. Message search is not
// part of it yet (`/api/messages/search` stays as it is).
//
// - Without `app`: the first page of every enabled app's group, in the
//   registry's order. An app switched off for the server has no group.
// - With `app`: that app's group only, paged with `cursor` (a group's
//   `nextCursor`, which only continues that app's results for the same `q`).
// - A group that took too long (each app's queries run under a statement
//   timeout) is `{ app, error: "timeout" }`, one that failed otherwise
//   `{ app, error: "failed" }`; the other groups are answered regardless.
// - Errors are `{ error, code }` (WEB_SEARCH_ERROR_CODES); `error` is a
//   technical label, the client writes what people read.
// - Answers are per reader: `Cache-Control: private, no-store`.

import type { Brand } from "./brandedIds";
import type { ArtifactSearchHit } from "./webArtifactsContract";

/** The longest `q`, in characters (Unicode code points), after trimming. */
export const WEB_SEARCH_QUERY_MAX_CHARS = 200;
/** Results a group holds when `limit` is absent. */
export const WEB_SEARCH_DEFAULT_LIMIT = 20;
/** The largest `limit` (per group). */
export const WEB_SEARCH_MAX_LIMIT = 50;

/**
 * A group's cursor: opaque to the client and to core, minted and read by the
 * app whose group it continues. Mint with {@link asSearchCursor} where it is
 * first known to be one (an app's page, a request's `cursor`).
 */
export type SearchCursor = Brand<string, "SearchCursor">;
export const asSearchCursor = (cursor: string): SearchCursor => cursor as SearchCursor;

/** What each app's group holds, by app id: the app's own result type. */
export interface WebSearchItemsByApp {
  artifacts: ArtifactSearchHit;
}
/** An app that answers searches. */
export type WebSearchApp = keyof WebSearchItemsByApp;

/** Why a group has no results to show. */
export type WebSearchGroupError = "timeout" | "failed";

/** One app's group: a page of its results, or why there is none. */
export type WebSearchGroup = {
  [A in WebSearchApp]:
    | { app: A; items: WebSearchItemsByApp[A][]; nextCursor: SearchCursor | null }
    | { app: A; error: WebSearchGroupError };
}[WebSearchApp];

export interface WebSearchResponse {
  groups: WebSearchGroup[];
}

/**
 * Error codes of `GET /api/search`:
 * - 400 INVALID_QUERY: `q` missing, empty after trimming, or longer than
 *   WEB_SEARCH_QUERY_MAX_CHARS;
 * - 400 INVALID_REQUEST: `limit` not a whole number from 1 to
 *   WEB_SEARCH_MAX_LIMIT, or `cursor` without `app`;
 * - 400 INVALID_CURSOR: a cursor the app doesn't take (another query's, or
 *   not one of its cursors): drop it to start over;
 * - 404 APP_NOT_FOUND: `app` names no app that searches here (unknown, or
 *   switched off for the server);
 * - 429 RATE_LIMITED: more than 300 searches a minute by one person.
 */
export const WEB_SEARCH_ERROR_CODES = ["INVALID_QUERY", "INVALID_REQUEST", "INVALID_CURSOR", "APP_NOT_FOUND", "RATE_LIMITED"] as const;
export type WebSearchErrorCode = (typeof WEB_SEARCH_ERROR_CODES)[number];

export interface WebSearchQuery {
  q: string;
  app?: WebSearchApp;
  cursor?: SearchCursor;
  limit?: number;
}

/** `GET` → WebSearchResponse. Built by the client; absent options are left out. */
export function webSearchPath(query: WebSearchQuery): string {
  const params = new URLSearchParams({ q: query.q });
  if (query.app !== undefined) params.set("app", query.app);
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  return `/api/search?${params.toString()}`;
}
