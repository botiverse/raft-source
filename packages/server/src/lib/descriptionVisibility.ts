import { isGuestRole, type ServerRole } from "@botiverse/raft-shared";

/**
 * Who may read a profile description (cindyz, product, 2026-11-17; message
 * headers: Tenny). A description is written for one's own server, so it
 * crosses only between non-guest members of the same server, judged on the
 * VIEWER's server: the server the viewer reads from (an agent's own server),
 * never the server that stores the channel.
 *
 * - Message headers (`senderDescription` / `sender_description`): the
 *   sender's description, human or agent, only under that rule.
 * - Profiles (cards, member lists, `raft user info`): an agent's description
 *   only under that rule; a human's profile description is unchanged.
 *
 * Guests and people or agents from other servers in a joint channel see an
 * agent's name, avatar and server, never its description. The server decides,
 * so web, mobile and agents get one answer; a hidden description is `null`
 * (every such field is nullable), never a removed key.
 *
 * The signed-out public server page (routes/publicServer.ts) applies it too
 * (cindyz, 2026-11-17): a visitor is never a member, so agents show name and
 * avatar only; people's descriptions there are unchanged (profile rule).
 */
export interface DescriptionViewer {
  /** The server the viewer reads from. */
  serverId: string;
  /** Whether the viewer is a member of that server other than a guest. */
  nonGuestMember: boolean;
  /** Who reads: only an agent reader is told where an outside sender is from (senderOriginFor). */
  reader: "agent" | "human";
}

/** A human viewer: their role in the server they read from (null when not a member, or signed out). */
export function humanDescriptionViewer(serverId: string, role: ServerRole | null | undefined): DescriptionViewer {
  return { serverId, nonGuestMember: role != null && !isGuestRole(role), reader: "human" };
}

/** An agent viewer: agents are never guests (ManageableServerRole), so a non-guest member of its own server. */
export function agentDescriptionViewer(serverId: string): DescriptionViewer {
  return { serverId, nonGuestMember: true, reader: "agent" };
}

/** Whose description it is: an agent belongs to one server; a human to every server where they are a non-guest member. */
export type DescriptionSubject =
  | { kind: "agent"; serverId: string }
  | { kind: "human"; nonGuestServerIds: readonly string[] };

/** A human subject known only by their role in one server (null when not a member there). */
export function humanSubjectInServer(serverId: string, role: ServerRole | null | undefined): DescriptionSubject {
  return { kind: "human", nonGuestServerIds: role != null && !isGuestRole(role) ? [serverId] : [] };
}

/** A description together with whose it is, so no reader can show it without the rule. */
export interface AttributedDescription {
  text: string;
  subject: DescriptionSubject;
}

/** The rule: viewer and subject are both non-guest members of the viewer's server. */
export function descriptionSharedWith(viewer: DescriptionViewer | null, subject: DescriptionSubject): boolean {
  if (!viewer?.nonGuestMember) return false;
  return subject.kind === "agent"
    ? subject.serverId === viewer.serverId
    : subject.nonGuestServerIds.includes(viewer.serverId);
}

/** A message sender's description as `viewer` may read it (null with no known viewer, e.g. a shared broadcast). */
export function senderDescriptionFor(viewer: DescriptionViewer | null, description: AttributedDescription | null): string | null {
  return description && descriptionSharedWith(viewer, description.subject) ? description.text : null;
}

/** An agent profile's description as `viewer` may read it. */
export function agentProfileDescriptionFor(
  viewer: DescriptionViewer | null,
  agent: { serverId: string; description?: string | null },
): string | null {
  return agent.description && descriptionSharedWith(viewer, { kind: "agent", serverId: agent.serverId })
    ? agent.description
    : null;
}

/**
 * Where an outside sender is from, for an AGENT reader (CTO, 2026-11-17;
 * guest and slug rules: RBAC review). Where the rule above withholds a
 * sender's description, the agent is told instead that the sender is not one
 * of its server's members, so it does not read `@Name` as a colleague:
 *
 * - `guest`: a guest of the reader's server. Only the host side says guest:
 *   a reader on another server never learns that someone is a guest there.
 * - `other_server`: anyone else who is not a non-guest member of the
 *   reader's server (an agent of another server; a person posting into a
 *   joint conversation from another server, a host guest included).
 *   `serverSlug` names that server only when the message is in a joint
 *   conversation the reader's server takes part in and that server takes part
 *   in too, where the reader already sees its tag; this is never a new way to
 *   learn which servers are connected. The SLUG, never the display name: a
 *   slug has a constrained charset, a name is free text another server sets.
 *
 * None only for a non-guest member of the reader's server, and for every
 * human reader: web and mobile payloads carry no origin. Anyone else gets at
 * least `other_server` (fail closed): a caller that cannot tell which joint
 * conversation a message is in says `local`, which only loses the slug. The
 * Agent API spells it `senderOrigin { kind, serverSlug? }`, the daemon
 * delivery `sender_origin { kind, server_slug? }`.
 */
export type SenderOrigin = { kind: "other_server"; serverSlug?: string } | { kind: "guest" };

/** Whose origin it is: an agent's one server; a person's member and guest servers. */
export type OriginSubject =
  | { kind: "agent"; serverId: string }
  | { kind: "human"; nonGuestServerIds: readonly string[]; guestServerIds: readonly string[] };

/** A server with its slug (null when unknown). */
export type OriginServer = { id: string; slug: string | null };

/**
 * The conversation a message is in, as the origin reads it. `local`: not a
 * joint conversation, or not known to be one (no slug). `joint`: its active
 * servers, and the server the sender posts from there (an agent's is its own
 * server), when known.
 */
export type OriginConversation =
  | { kind: "local" }
  | { kind: "joint"; serverIds: ReadonlySet<string>; postingServer: OriginServer | null };

export const LOCAL_ORIGIN_CONVERSATION: OriginConversation = { kind: "local" };

/** A human subject known only by their role in one server (null when not a member there). */
export function humanOriginSubjectInServer(serverId: string, role: ServerRole | null | undefined): OriginSubject {
  return {
    kind: "human",
    nonGuestServerIds: role != null && !isGuestRole(role) ? [serverId] : [],
    guestServerIds: role != null && isGuestRole(role) ? [serverId] : [],
  };
}

/**
 * A joint conversation from its servers and their slugs. An agent posts from
 * its own server. For a person, where the caller does not know the server the
 * message came through (a stored message records none), this falls back to the
 * first by slug of `postingCandidates` that is one of the joint's servers (by
 * default their member and guest servers): a true server of theirs, not always
 * the one they posted through. Live sends pass that one instead.
 */
export function jointOriginConversation(
  serverSlugs: ReadonlyMap<string, string | null>,
  subject: OriginSubject | null,
  postingCandidates?: Iterable<string>,
): OriginConversation {
  const candidates = postingCandidates
    ?? (!subject ? [] : subject.kind === "agent" ? [subject.serverId] : [...subject.nonGuestServerIds, ...subject.guestServerIds]);
  const postingId = [...new Set(candidates)]
    .filter((id) => serverSlugs.has(id))
    .sort((a, b) => (serverSlugs.get(a) ?? "").localeCompare(serverSlugs.get(b) ?? "") || a.localeCompare(b))[0];
  return {
    kind: "joint",
    serverIds: new Set(serverSlugs.keys()),
    postingServer: postingId ? { id: postingId, slug: serverSlugs.get(postingId) ?? null } : null,
  };
}

function otherServer(viewer: DescriptionViewer, conversation: OriginConversation, senderServerId?: string): SenderOrigin {
  if (conversation.kind !== "joint") return { kind: "other_server" };
  const server = conversation.postingServer;
  const visible = server?.slug
    && (senderServerId === undefined || server.id === senderServerId)
    && conversation.serverIds.has(viewer.serverId)
    && conversation.serverIds.has(server.id);
  return visible ? { kind: "other_server", serverSlug: server.slug! } : { kind: "other_server" };
}

/** A message sender's origin as an agent `viewer` reads it; null for a same-server sender and for every other reader. */
export function senderOriginFor(
  viewer: DescriptionViewer | null,
  subject: OriginSubject | null,
  conversation: OriginConversation,
): SenderOrigin | null {
  if (!viewer || viewer.reader !== "agent" || !subject) return null;
  if (subject.kind === "agent") {
    return subject.serverId === viewer.serverId ? null : otherServer(viewer, conversation, subject.serverId);
  }
  if (subject.nonGuestServerIds.includes(viewer.serverId)) return null;
  if (subject.guestServerIds.includes(viewer.serverId)) return { kind: "guest" };
  return otherServer(viewer, conversation);
}

/** The daemon delivery's spelling (snake_case keys), or undefined so the key stays off the payload. */
export function senderOriginWire(origin: SenderOrigin | null | undefined): { kind: "other_server"; server_slug?: string } | { kind: "guest" } | undefined {
  if (!origin) return undefined;
  if (origin.kind === "guest") return { kind: "guest" };
  return origin.serverSlug ? { kind: "other_server", server_slug: origin.serverSlug } : { kind: "other_server" };
}

/** `sender_origin` on a daemon delivery or wire row, only when there is one (older daemons ignore the key). */
export function senderOriginWireField(origin: SenderOrigin | null | undefined): { sender_origin?: NonNullable<ReturnType<typeof senderOriginWire>> } {
  const wire = senderOriginWire(origin);
  return wire ? { sender_origin: wire } : {};
}

/** `senderOrigin` on an enriched (camelCase) row, only when there is one. */
export function senderOriginRowField(origin: SenderOrigin | null | undefined): { senderOrigin?: SenderOrigin } {
  return origin ? { senderOrigin: origin } : {};
}
