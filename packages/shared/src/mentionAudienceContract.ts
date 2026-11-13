// Core's "who can be @-mentioned here" for the web (POST /api/mentions/audience):
// the people and agents a signed-in person may name in a conversation, or on
// a first-party app's object (an Artifact's comments), for one picker shared
// by every surface. The server's rule is one place
// (packages/server/src/platform/mentions.ts):
//
// - only for an audience the reader can see: anything else, an unknown one
//   included, is the same 404 NOT_FOUND;
// - the candidates are those who can see the audience, and of those only whom
//   core shows the reader (a guest: whom it meets; a member of a server that
//   hides its people: whom it shares a conversation with);
// - the list is not a permission: whoever sends checks each mention again
//   (an Artifact comment refuses one who can't see it, 422 MENTION_NOT_VISIBLE).
//
// No special mentions (`@everyone`, `@all`): the client decides those from
// the source. Answers are the reader's own (`private, no-store`) and never
// cached on the server: a narrowed home applies to the next request.
import type { Brand, ChannelId } from "./brandedIds";

/**
 * A first-party app's id as its registration names it (`FirstPartyApp.id`,
 * such as the Artifacts app's). Not a RAP app id. Mint with {@link asFirstPartyAppId}.
 */
export type FirstPartyAppId = Brand<string, "FirstPartyAppId">;
/** An object kind a first-party app registers (`AppObjectKind.kind`). Mint with {@link asFirstPartyObjectKind}. */
export type FirstPartyObjectKind = Brand<string, "FirstPartyObjectKind">;
/** The id of one object of a first-party app's kind, as the app names it. Mint with {@link asFirstPartyObjectId}. */
export type FirstPartyObjectId = Brand<string, "FirstPartyObjectId">;

/** Brand a first-party app id where it is read (a checked request body, the app's own constant). */
export const asFirstPartyAppId = (id: string): FirstPartyAppId => id as FirstPartyAppId;
/** Brand an object kind where it is read (a checked request body, the app's own constant). */
export const asFirstPartyObjectKind = (kind: string): FirstPartyObjectKind => kind as FirstPartyObjectKind;
/** Brand an object id where it is read (a checked request body, an object the app returned). */
export const asFirstPartyObjectId = (id: string): FirstPartyObjectId => id as FirstPartyObjectId;

/**
 * Where the mention is written:
 * - `conversation`: a channel, private channel, DM or joint channel of the
 *   request's server, by id; a thread (or task conversation) by its own id
 *   stands for its parent conversation's audience;
 * - `object`: an object of a first-party app (its id, the kind it registers,
 *   its id), of the request's server, by where it lives now (its home).
 */
export type MentionAudience =
  | { kind: "conversation"; channelId: ChannelId }
  | { kind: "object"; app: FirstPartyAppId; objectKind: FirstPartyObjectKind; objectId: FirstPartyObjectId };

/** At most this many candidates in one answer. */
export const MENTION_AUDIENCE_MAX_CANDIDATES = 200;
/** `q` is trimmed and cut to this many code points. */
export const MENTION_AUDIENCE_QUERY_MAX_CHARS = 64;
/** At most this many characters in a conversation or object id (`String.length`). */
export const MENTION_AUDIENCE_MAX_ID_CHARS = 256;

export const mentionAudiencePaths = {
  /**
   * POST MentionAudienceInput → MentionAudienceCandidates, for the signed-in
   * person in the request's server (X-Server-Id). Reads only.
   * - 400 INVALID_REQUEST: a body other than `{ audience, q? }` (`q` a string;
   *   ids strings of 1 to MENTION_AUDIENCE_MAX_ID_CHARS).
   * - 404 NOT_FOUND, the same body for every reason: no such conversation or
   *   object, one the reader can't see, another server's, an object whose kind
   *   isn't the named app's or whose app is off for the server.
   * - 300 a minute per user, then 429 RATE_LIMITED.
   */
  audience: () => "/api/mentions/audience",
} as const;

export interface MentionAudienceInput {
  audience: MentionAudience;
  /**
   * Matched against handles and display names (any case, `%` and `_`
   * literal). Empty or absent: the first MENTION_AUDIENCE_MAX_CANDIDATES.
   */
  q?: string;
}

/**
 * A person or agent the reader may mention: core's profile (handle, display
 * name, avatar) and whether a person is a guest of the request's server (never
 * for another server's person in a joint channel: their roles stay with their
 * own organization, as the joint roster shows them).
 */
export interface MentionAudienceActor {
  type: "user" | "agent";
  id: string;
  /** The handle (`@name`). */
  name: string;
  /** The display name, else the handle. */
  displayName: string;
  avatarUrl: string | null;
  guest: boolean;
}

/**
 * Members of the audience's conversation (an object's home conversation)
 * first, people before agents, then by handle. `capped`: more match than
 * the list holds (MENTION_AUDIENCE_MAX_CANDIDATES).
 */
export interface MentionAudienceCandidates {
  candidates: MentionAudienceActor[];
  capped: boolean;
}

/** Error codes POST /api/mentions/audience answers with. */
export const MENTION_AUDIENCE_ERROR_CODES = ["INVALID_REQUEST", "NOT_FOUND", "RATE_LIMITED"] as const;
export type MentionAudienceErrorCode = (typeof MENTION_AUDIENCE_ERROR_CODES)[number];
