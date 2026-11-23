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
//
// Core groups (WebSearchItemsByCoreGroup: `channels`, `people`) sit beside
// the app groups in the same `{ app, items, nextCursor }` shape, but core
// searches them itself: no app, no flag, always on. They are opt-in, so the
// answer an existing caller gets is unchanged (docs/contracts/web-search.md):
// - `include=channels,people` adds their first pages to the request without
//   `app` (after the app groups, in that order);
// - `app=channels` / `app=people` asks for that one group alone, paged with its
//   `cursor` ("show all"); a client may fire each group as its own request.
// A core group's page also carries `total`: how many matches the group has in
// all (so a client can say "Show all 37"); app groups don't (`nextCursor`
// non-null is their "has more").
// Every item's status fields (archived, joined, external, guest, canPost,
// requiredAction) are part of the contract: added to, never renamed or
// removed. A new core group (`computers` is the next one planned) is a new key
// of WebSearchItemsByCoreGroup and of WEB_SEARCH_CORE_GROUPS: additive.

import type { Brand } from "./brandedIds";
import type { ServerRole } from "./serverPermissions";
import type { ArtifactSearchHit } from "./webArtifactsContract";

/** The longest `q`, in characters (Unicode code points), after trimming. */
export const WEB_SEARCH_QUERY_MAX_CHARS = 200;
/** Results a group holds when `limit` is absent. */
export const WEB_SEARCH_DEFAULT_LIMIT = 20;
/** The largest `limit` (per group). */
export const WEB_SEARCH_MAX_LIMIT = 50;
/** Results a core group (channels, people) holds when `limit` is absent. */
export const WEB_SEARCH_CORE_DEFAULT_LIMIT = 10;

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

/**
 * What a result needs done before the reader can post to it (the forward
 * target search's names): join the public channel first, or open a DM with
 * the person first (none exists yet). Null: nothing (or nothing can be done).
 */
export type WebSearchRequiredAction = "join_channel" | "create_dm";

/**
 * A channel the reader can read, as core's search finds it (`channels`
 * group): public, private and joint channels of the reader's server,
 * archived and not-joined ones included; never one the reader can't read
 * (a private channel they aren't in, another Guest's channel), never a DM,
 * thread or Agent Lounge. The status fields are the contract: additive only.
 */
export interface ChannelSearchHit {
  id: string;
  /** Without `#`. */
  name: string;
  description: string | null;
  type: "channel" | "private" | "joint";
  /** Archived: readable, not writable; ranked after live channels. */
  archived: boolean;
  /** The reader is a member (a joint the reader can read counts as joined). */
  joined: boolean;
  /** An external channel: shared with another server (a joint). */
  external: boolean;
  /**
   * Guests take part in it (a Guest's channel). Only told to readers who may
   * see Guests (owners and admins: the Members page's rule); false for anyone
   * else.
   */
  guest: boolean;
  /** The reader can post there now: a member, not archived, not read-only by a plan limit. */
  canPost: boolean;
  /** `join_channel`: a live public channel the reader hasn't joined. */
  requiredAction: Extract<WebSearchRequiredAction, "join_channel"> | null;
}

/**
 * A person or agent of the reader's server (`people` group). Humans as the
 * Members page lists them to the reader (Guests only for owners and admins;
 * only themselves where the server hides its human directory); live agents
 * the reader may find (another person's personal assistant never). A Guest
 * reader gets an empty group (Guests have no member directory, no DMs).
 * Humans have no deactivated state on the server, so there is no such field.
 * The status fields are the contract: additive only.
 */
export interface PersonSearchHit {
  kind: "human" | "agent";
  /** A human's user id, an agent's agent id. */
  id: string;
  /** The handle, without `@`. */
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** The server role (an agent's too); null when it has none here. */
  role: ServerRole | null;
  /** A Guest of this server. */
  guest: boolean;
  /** The reader's existing DM with them, else null. */
  dmChannelId: string | null;
  /** The reader can message them now: a DM exists and isn't read-only by a plan limit (the channel quota). */
  canPost: boolean;
  /** `create_dm`: no DM yet (never for the reader themselves). */
  requiredAction: Extract<WebSearchRequiredAction, "create_dm"> | null;
}

/** What each core group holds, by group id. */
export interface WebSearchItemsByCoreGroup {
  channels: ChannelSearchHit;
  people: PersonSearchHit;
}
/** A group core searches itself (no app, no flag). */
export type WebSearchCoreGroupId = keyof WebSearchItemsByCoreGroup;
/** Core groups, in the order they follow the app groups. */
export const WEB_SEARCH_CORE_GROUPS = ["channels", "people"] as const satisfies readonly WebSearchCoreGroupId[];

export function isWebSearchCoreGroupId(value: string): value is WebSearchCoreGroupId {
  return (WEB_SEARCH_CORE_GROUPS as readonly string[]).includes(value);
}

/**
 * A core group's page (`app` is the group id, as an app group's is its app
 * id): `total` is every match the group has for `q`, not just this page.
 */
export type WebSearchCoreGroup = {
  [G in WebSearchCoreGroupId]:
    | { app: G; items: WebSearchItemsByCoreGroup[G][]; nextCursor: SearchCursor | null; total: number }
    | { app: G; error: WebSearchGroupError };
}[WebSearchCoreGroupId];

/** Why a group has no results to show. */
export type WebSearchGroupError = "timeout" | "failed";

/** One app's group: a page of its results, or why there is none. */
export type WebSearchGroup = {
  [A in WebSearchApp]:
    | { app: A; items: WebSearchItemsByApp[A][]; nextCursor: SearchCursor | null }
    | { app: A; error: WebSearchGroupError };
}[WebSearchApp];

export interface WebSearchResponse {
  /** App groups (WebSearchGroup), then the core groups asked for (WebSearchCoreGroup). */
  groups: Array<WebSearchGroup | WebSearchCoreGroup>;
}

/**
 * Error codes of `GET /api/search`:
 * - 400 INVALID_QUERY: `q` missing, empty after trimming, or longer than
 *   WEB_SEARCH_QUERY_MAX_CHARS;
 * - 400 INVALID_REQUEST: `limit` not a whole number from 1 to
 *   WEB_SEARCH_MAX_LIMIT, `cursor` without `app`, `include` naming something
 *   other than core groups, or `include` with `app`;
 * - 400 INVALID_CURSOR: a cursor the app doesn't take (another query's, or
 *   not one of its cursors): drop it to start over;
 * - 404 APP_NOT_FOUND: `app` names no app or core group that searches here
 *   (unknown, or an app switched off for the server);
 * - 429 RATE_LIMITED: more than 300 searches a minute by one person.
 */
export const WEB_SEARCH_ERROR_CODES = ["INVALID_QUERY", "INVALID_REQUEST", "INVALID_CURSOR", "APP_NOT_FOUND", "RATE_LIMITED"] as const;
export type WebSearchErrorCode = (typeof WEB_SEARCH_ERROR_CODES)[number];

export interface WebSearchQuery {
  q: string;
  /** One app's or one core group's group only (pageable with `cursor`). */
  app?: WebSearchApp | WebSearchCoreGroupId;
  cursor?: SearchCursor;
  limit?: number;
  /** Without `app`: core groups to answer beside the app groups. */
  include?: readonly WebSearchCoreGroupId[];
}

/** `GET` → WebSearchResponse. Built by the client; absent options are left out. */
export function webSearchPath(query: WebSearchQuery): string {
  const params = new URLSearchParams({ q: query.q });
  if (query.app !== undefined) params.set("app", query.app);
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.include !== undefined && query.include.length > 0) params.set("include", query.include.join(","));
  return `/api/search?${params.toString()}`;
}
