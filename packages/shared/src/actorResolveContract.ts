// POST /api/actors/resolve: batched display identity for message authors and
// mentions, same-server and joint-channel peers alike. The server returns only
// the actors the caller may see; a missing id means "not found or not allowed"
// (the two are indistinguishable by design).
//
// Do not add `import "zod-openapi"` here: this file is reachable from the
// package barrel (see attachmentUploadContract.ts for why).
import { z } from "zod";
import { lazySchema } from "./lazySchema";

export const ACTOR_RESOLVE_MAX_ACTORS = 200;

/**
 * @deprecated Raft no longer uses Gravatar. Every `gravatarHash`,
 * `senderGravatarHash` and `peerGravatarHash` the server sends is this empty
 * string (or null where the field is nullable and was null before). The keys
 * stay only because older clients require them: released desktop/web bundles
 * parse `user:profile-updated` with a strict schema that requires
 * `gravatarHash`, and older mobile builds read the others. Remove the keys
 * once no supported client reads them. Clients ignore the value.
 */
export const DEPRECATED_GRAVATAR_HASH = "";

export const actorResolveKindSchema = lazySchema("actorResolveKindSchema", () => z.enum(["human", "agent"]));
export type ActorResolveKind = z.infer<typeof actorResolveKindSchema>;

export const actorResolveRefSchema = lazySchema("actorResolveRefSchema", () => z.strictObject({
  kind: actorResolveKindSchema,
  id: z.uuid(),
}));
export type ActorResolveRef = z.infer<typeof actorResolveRefSchema>;

export const actorResolveRequestSchema = lazySchema("actorResolveRequestSchema", () => z.strictObject({
  actors: z.array(actorResolveRefSchema).min(1).max(ACTOR_RESOLVE_MAX_ACTORS),
}));
export type ActorResolveRequest = z.infer<typeof actorResolveRequestSchema>;

/**
 * Identity-only projection, a subset of the joint-channel profiles
 * (channel-scoped human profile / joint agent profile). `gravatarHash` is
 * deprecated (see DEPRECATED_GRAVATAR_HASH): empty for humans who are members
 * of the requested server, null for everyone else; clients ignore it.
 */
export const resolvedActorSchema = lazySchema("resolvedActorSchema", () => z.strictObject({
  kind: actorResolveKindSchema,
  id: z.uuid(),
  // Empty for a visible J human with no current source label; never substitute
  // another server membership to fill display metadata.
  homeServerId: z.union([z.uuid(), z.literal("")]),
  name: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /** @deprecated Always empty or null; kept for older clients. See DEPRECATED_GRAVATAR_HASH. */
  gravatarHash: z.string().nullable(),
}));
export type ResolvedActor = z.infer<typeof resolvedActorSchema>;

export const actorResolveResponseSchema = lazySchema("actorResolveResponseSchema", () => z.strictObject({
  actors: z.array(resolvedActorSchema),
}));
export type ActorResolveResponse = z.infer<typeof actorResolveResponseSchema>;

/**
 * Socket event `actor:updated`: an actor's display identity changed. Sent to
 * the joint projection channel rooms on OTHER servers that see the actor
 * through an active joint channel, so their actors table stays current
 * without a re-resolve. The fields are exactly the external projection
 * (`resolvedActorSchema` without the deprecated `gravatarHash`), never
 * anything only the actor's home server sees. Only agents emit it today.
 * The home server keeps its id-only `agent:updated` push.
 */
export const ACTOR_UPDATED_EVENT = "actor:updated";

export const actorUpdatedEventSchema = lazySchema("actorUpdatedEventSchema", () => z.strictObject({
  kind: actorResolveKindSchema,
  id: z.uuid(),
  homeServerId: z.uuid(),
  name: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
}));
export type ActorUpdatedEvent = z.infer<typeof actorUpdatedEventSchema>;

/**
 * Socket event `user:profile-updated`: a person changed their name or avatar.
 * The fields are exactly what this server's member list shows of a person
 * (never email); clients patch that one member in place rather than re-read
 * the list. Sent per server only to sockets that may see the person in that
 * server's member list: the server room when its human directory is visible
 * and the person is not a Guest, else only the server's owners and admins and
 * the person themself.
 */
export const USER_PROFILE_UPDATED_EVENT = "user:profile-updated";

export const userProfileUpdatedEventSchema = lazySchema("userProfileUpdatedEventSchema", () => z.strictObject({
  serverId: z.uuid(),
  userId: z.uuid(),
  name: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /**
   * @deprecated Always "" (DEPRECATED_GRAVATAR_HASH). The server must keep
   * sending it: released web/desktop bundles parse this event with a strict
   * schema that requires it. Optional here so this client ignores it.
   */
  gravatarHash: z.string().optional(),
}));
export type UserProfileUpdatedEvent = z.infer<typeof userProfileUpdatedEventSchema>;
