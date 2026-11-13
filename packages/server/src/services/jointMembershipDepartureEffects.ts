import { and, eq } from "drizzle-orm";
import { jointConversationFamilySql } from "./jointHumanMembershipAccess";
import { getDb } from "../db";
import { agentActivityEvents, channels } from "../db/schema";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { deliverSystemNoticeToAgent } from "./messageService";
import { revokeSocketAccess } from "../socket/accessRevocation";
import type { JointDepartureEffects } from "./jointMembershipDeparture";

/** Composition-root side effects. Authorization and persistent own-side
 * explanations are committed before this executes. Exact scoped turn stop is
 * a separate runtime change; an old Computer is never credited with stopping. */
export function jointMembershipDepartureEffects(
  orchestrator: AgentOrchestrator,
): JointDepartureEffects {
  return {
    async revoke(batch, keepLease) {
      const family = await getDb().execute<{ id: string }>(
        jointConversationFamilySql(batch.departure.jointChannelId),
      );
      const channelIds = family.rows.map((row) => row.id);
      for (const removal of batch.removals) {
        if (keepLease && !(await keepLease()))
          throw new Error("Joint departure attempt superseded");
        if (removal.userId)
          await revokeSocketAccess({
            userId: removal.userId,
            ...(removal.removeMembership
              ? {}
              : { entryServerId: batch.departure.serverId }),
          });
        if (!removal.agentId) continue;
        await orchestrator.purgeAgentInboxForChannels(
          removal.agentId,
          channelIds,
          "joint_channel_disconnected",
        );
        const [notice] = await getDb()
          .select({ entries: agentActivityEvents.entries })
          .from(agentActivityEvents)
          .where(
            and(
              eq(agentActivityEvents.agentId, removal.agentId),
              eq(
                agentActivityEvents.dedupeKey,
                `joint_departure:${batch.departure.id}:${removal.agentId}`,
              ),
            ),
          )
          .limit(1);
        const entry = notice?.entries.find(
          (item) => item.kind === "slock_action",
        );
        const [own] = await getDb()
          .select({ id: channels.id, name: channels.name, type: channels.type })
          .from(channels)
          .where(
            and(
              eq(channels.serverId, batch.departure.serverId),
              eq(channels.name, "all"),
            ),
          )
          .limit(1);
        if (entry?.kind === "slock_action" && own) {
          // Intrinsic personal notice, no shared chat message and no removed-J
          // write. The durable Activity Log entry remains if the machine is offline.
          await deliverSystemNoticeToAgent(orchestrator, removal.agentId, {
            serverId: batch.departure.serverId,
            channel_id: own.id,
            channel_name: own.name,
            channel_type: own.type === "private" ? "private" : "channel",
            content: entry.text,
          });
        }
      }
    },
  };
}
