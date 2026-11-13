import { randomUUID } from "node:crypto";
import { getDb, type DatabaseExecutor } from "../db/index";
import { channelHumans, serverMembers } from "../db/schema";
import { createChannel } from "../services/channelService";

/**
 * A Guest of `serverId` bound to `channelId` and a member of it: the state an
 * accepted external invite leaves (#wg-rbac:#15). Every Guest has its one
 * channel (server_members_guest_has_channel, #wg-rbac:#48), so this is the
 * only way tests seed one. Upserts: a member made a Guest here is bound in the
 * same write.
 *
 * Without `channelId` it binds the Guest to a new private channel of the
 * server made for it, for tests that need a Guest but not a particular
 * channel; pass a channel the test already has when it asserts on it.
 * `member: false` leaves out the channel membership, for "bound but removed"
 * cases. Returns the bound channel's id.
 */
export async function seedBoundGuest(
  input: { serverId: string; userId: string; channelId?: string; member?: boolean },
  executor: DatabaseExecutor = getDb(),
): Promise<string> {
  const channelId = input.channelId
    ?? (await createChannel(input.serverId, `guest-home-${randomUUID().slice(0, 8)}`, undefined, "private", { executor })).id;
  await executor.insert(serverMembers)
    .values({ serverId: input.serverId, userId: input.userId, role: "guest", guestChannelId: channelId })
    .onConflictDoUpdate({
      target: [serverMembers.serverId, serverMembers.userId],
      set: { role: "guest", guestChannelId: channelId },
    });
  if (input.member === false) return channelId;
  await executor.insert(channelHumans)
    .values({ channelId, userId: input.userId, role: "member" })
    .onConflictDoNothing();
  return channelId;
}
