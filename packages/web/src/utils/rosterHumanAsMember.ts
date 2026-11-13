import type { ChannelHuman } from "../hooks/useChannelMembers";
import type { ServerMember } from "../store/serverStore";

/**
 * A channel roster's person in the shape message rows and hover cards read a
 * member in. It keeps what the roster says about their server (`serverId`,
 * `roster`), so a row can tell someone from another server
 * and name where they are from (#wg-rbac:#46). Another server's person in a
 * joint channel carries no role; they read as a plain member. A Guest stays a
 * Guest; whether that is written is memberOrigin's isViewerServerGuest.
 *
 * `homeServer: false` leaves out the top-level `serverId` / `serverName` /
 * `serverSlug`: the channel timeline never passed them, and MessageItem also
 * reads them to decide whether a sender is known on the viewed server. The
 * same three stay under `roster`, so where someone is from reads the same in
 * the channel timeline and in a thread.
 */
export function rosterHumanAsMember(human: ChannelHuman, { homeServer = true }: { homeServer?: boolean } = {}): ServerMember {
  return {
    userId: human.id,
    ...(homeServer ? { serverId: human.serverId, serverName: human.serverName, serverSlug: human.serverSlug } : {}),
    roster: {
      serverId: human.serverId,
      serverName: human.serverName,
      serverSlug: human.serverSlug,
      servers: human.servers,
      inViewerServer: human.inViewerServer,
    },
    email: null,
    name: human.name,
    displayName: human.displayName,
    description: human.description,
    avatarUrl: human.avatarUrl,
    // A Guest is read the way the member list reads it (rosterRoleTag): the
    // roster sends a guest viewer no `role`, only the effective channel role.
    role: human.effectiveChannelRole === "guest" ? "guest" : human.role ?? "member",
    joinedAt: "",
  };
}
