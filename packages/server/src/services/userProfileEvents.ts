// `user:profile-updated`: a person's new name or avatar, pushed to the viewers
// who may see them in a server's member list, so their clients patch that one
// member in place (no member-list reload).
import { and, inArray } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { DEPRECATED_GRAVATAR_HASH, USER_PROFILE_UPDATED_EVENT, type UserProfileUpdatedEvent } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { serverMembers } from "../db/schema";
import { socketUserServerRoom } from "../socket/platformScope";
import { getUserServers } from "./serverService";

type PublicProfile = Pick<UserProfileUpdatedEvent, "userId" | "name" | "displayName" | "avatarUrl">;

/**
 * Who hears it in each of the person's servers follows the member list's own
 * visibility (serverService.listServerMemberDirectory):
 * - a server whose human directory is visible, for a person who is not a
 *   Guest there: the server room (its non-Guest members, who all list them);
 * - a hidden directory (ordinary members list only themselves), or a person
 *   who is a Guest there (only owners and admins list Guests): only that
 *   server's owners and admins, and the person, each on their per-server room.
 * Guest viewers are never addressed (the server room excludes them).
 */
export async function announceUserProfileUpdated(io: SocketServer, profile: PublicProfile): Promise<void> {
  const memberships = await getUserServers(profile.userId);
  const restricted = memberships.filter((server) => server.hideHumansFromMembers || server.role === "guest");
  const adminsByServer = new Map<string, string[]>();
  if (restricted.length > 0) {
    const admins = await getDb()
      .select({ serverId: serverMembers.serverId, userId: serverMembers.userId })
      .from(serverMembers)
      .where(and(inArray(serverMembers.serverId, restricted.map((server) => server.id)), inArray(serverMembers.role, ["owner", "admin"])));
    for (const { serverId, userId } of admins) adminsByServer.set(serverId, [...(adminsByServer.get(serverId) ?? []), userId]);
  }
  for (const server of memberships) {
    // `gravatarHash` is deprecated and always "", but released web/desktop
    // bundles parse this event strictly and require the key.
    const payload: UserProfileUpdatedEvent = { serverId: server.id, ...profile, gravatarHash: DEPRECATED_GRAVATAR_HASH };
    if (!server.hideHumansFromMembers && server.role !== "guest") {
      io.to(`server:${server.id}`).emit(USER_PROFILE_UPDATED_EVENT, payload);
      continue;
    }
    for (const viewerId of new Set([profile.userId, ...(adminsByServer.get(server.id) ?? [])])) {
      io.to(socketUserServerRoom(viewerId, server.id)).emit(USER_PROFILE_UPDATED_EVENT, payload);
    }
  }
}
