import { inArray, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db";
import { serverMembers } from "../db/schema";

export class DmPeerNotMemberError extends Error {
  readonly status = 403;
  readonly code = "peer_not_member";
  constructor() {
    super("The other person is no longer a member of this server. You can send messages after they rejoin.");
    this.name = "DmPeerNotMemberError";
  }
}

/** New chat writes only, inside their persistence transaction. Reading history
 * and system notices remain available. DM threads/tasks inherit the DM root.
 * Durable identity covers legacy missing participant rows; channel_humans is
 * the fallback for DMs predating identity stamping. */
export async function assertDmHumanPeersAreMembers(
  tx: DatabaseExecutor,
  channelId: string,
  senderType: "user" | "agent",
  senderId: string,
): Promise<void> {
  const peers = await tx.execute<{ server_id: string; user_id: string }>(sql`
    WITH dm AS (
      SELECT root.id, root.server_id
      FROM channels conversation
      LEFT JOIN messages parent_message ON parent_message.id = conversation.parent_message_id
      INNER JOIN channels root ON root.id = CASE
        WHEN conversation.type IN ('thread', 'task')
          THEN COALESCE(conversation.parent_channel_id, parent_message.channel_id)
        ELSE conversation.id END
      WHERE conversation.id = ${channelId} AND root.type = 'dm'
    ), humans AS (
      SELECT member.user_id FROM dm
      INNER JOIN channel_humans member ON member.channel_id = dm.id
      UNION
      SELECT person.id FROM dm
      INNER JOIN dm_channel_identities identity ON identity.channel_id = dm.id AND identity.server_id = dm.server_id
      INNER JOIN users person ON person.id = ANY(string_to_array(identity.peer_key, ':')::uuid[])
      WHERE identity.kind IN ('human_human', 'human_agent', 'human_self')
    )
    SELECT dm.server_id, humans.user_id FROM dm CROSS JOIN humans
    WHERE ${senderType !== "user"} OR humans.user_id <> ${senderId}::uuid
    ORDER BY humans.user_id
  `);
  if (peers.rows.length === 0) return;

  // KEY SHARE conflicts with removeMember's FOR UPDATE / DELETE. A removal
  // that wins first makes this write roll back; otherwise it waits until the
  // accepted message commits. Lock in stable user-id order for pair sends.
  const members = await tx.select({ userId: serverMembers.userId }).from(serverMembers)
    .where(sql`${serverMembers.serverId} = ${peers.rows[0]!.server_id}
      AND ${inArray(serverMembers.userId, peers.rows.map((peer) => peer.user_id))}`)
    .orderBy(serverMembers.userId).for("key share");
  if (members.length !== peers.rows.length) throw new DmPeerNotMemberError();
}
