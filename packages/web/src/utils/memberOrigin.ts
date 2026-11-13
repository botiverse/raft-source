// Member labels (#wg-rbac:#46): the facts every identity surface (message
// author row, profile hover card, channel member row, @ suggestion) reads the
// same way. Pure: each surface passes what the server sent it; nothing here
// guesses a server, a role or a model the server left out.
import type { ServerRole } from "@botiverse/raft-shared";
import type { MessageId } from "../i18n/messages/en";
import type { ChannelMemberServer } from "./channelLocalMembership";

/** A server someone from outside the viewed server takes part through. */
export interface OriginServer {
  id: string;
  name: string;
}

/** Whether someone is from another server than the viewed one, and which servers to name. */
export interface MemberOrigin {
  external: boolean;
  /** The servers to name, the viewed server left out. May be empty for an
   *  external member whose server the client was not told the name of. */
  servers: readonly OriginServer[];
}

/** What a roster row, a member, an agent or a mention candidate may carry about its server. */
export interface MemberOriginSource {
  serverId?: string | null;
  serverName?: string | null;
  serverSlug?: string | null;
  /** Joint rosters: every server the person takes part through. */
  servers?: readonly ChannelMemberServer[] | null;
  /** Computed joint rosters: the server's own answer to "is this one of the viewed server's". */
  inViewerServer?: boolean;
  /** The same roster facts on a member built from a roster row (rosterHumanAsMember). */
  roster?: {
    serverId?: string | null;
    serverName?: string | null;
    serverSlug?: string | null;
    servers?: readonly ChannelMemberServer[] | null;
    inViewerServer?: boolean;
  } | null;
}

/** A server the conversation connects (a joint channel's `jointServers`), for naming a bare server id. */
export interface KnownServer {
  serverId: string;
  serverName?: string | null;
  serverSlug?: string | null;
}

const NO_SERVERS: readonly OriginServer[] = Object.freeze([]);

/** Someone of the viewed server: no mark anywhere. */
export const LOCAL_MEMBER_ORIGIN: MemberOrigin = Object.freeze({ external: false, servers: NO_SERVERS });

/**
 * Where a member is from, as seen from `viewerServerId`. External only when
 * the server said so: `inViewerServer: false`, or a `serverId` that is not
 * the viewed server's. A member with neither is the viewed server's own.
 * `knownServers` names a server the member's own fields only gave the id of.
 */
export function memberOrigin(
  source: MemberOriginSource | null | undefined,
  viewerServerId: string | null | undefined,
  knownServers?: readonly KnownServer[] | null,
): MemberOrigin {
  if (!source || !viewerServerId) return LOCAL_MEMBER_ORIGIN;
  const inViewerServer = source.inViewerServer ?? source.roster?.inViewerServer;
  const sourceServers = source.servers ?? source.roster?.servers;
  const home = source.serverId
    ? { id: source.serverId, name: source.serverName, slug: source.serverSlug }
    : source.roster?.serverId
      ? { id: source.roster.serverId, name: source.roster.serverName, slug: source.roster.serverSlug }
      : null;
  const external = inViewerServer !== undefined
    ? !inViewerServer
    : Boolean(home && home.id !== viewerServerId);
  if (!external) return LOCAL_MEMBER_ORIGIN;
  const listed: Array<{ id: string; name?: string | null; slug?: string | null }> = sourceServers
    ? [...sourceServers]
    : home
      ? [home]
      : [];
  const servers: OriginServer[] = [];
  for (const server of listed) {
    if (server.id === viewerServerId || servers.some((seen) => seen.id === server.id)) continue;
    const known = knownServers?.find((candidate) => candidate.serverId === server.id);
    const name = server.name || server.slug || known?.serverName || known?.serverSlug || "";
    if (name) servers.push({ id: server.id, name });
  }
  return { external: true, servers };
}

/** "Acme Corp, Lumen Labs": every server, where there is room for all of them. */
export function originServerNames(origin: MemberOrigin): string {
  return origin.servers.map((server) => server.name).join(", ");
}

const HOVER_CARD_ROLE_LABELS: Partial<Record<ServerRole, MessageId>> = {
  owner: "member.role.owner",
  admin: "member.role.admin",
  guest: "member.detail.roleGuest",
};

/**
 * The server role the hover card's corner tag writes, or null for none.
 * People: Owner, Admin or Guest (Member is the default and is not written).
 * Agents: Admin only. Never for someone from another server, and never for a
 * role the server did not send.
 */
export function hoverCardRoleLabelId(
  kind: "human" | "agent",
  role: ServerRole | null | undefined,
  origin: MemberOrigin,
): MessageId | null {
  if (origin.external || !role) return null;
  if (kind === "agent" && role !== "admin") return null;
  return HOVER_CARD_ROLE_LABELS[role] ?? null;
}

/** A Guest label in a row is a fact of the viewed server only. */
export function isViewerServerGuest(role: ServerRole | null | undefined, origin: MemberOrigin): boolean {
  return role === "guest" && !origin.external;
}
