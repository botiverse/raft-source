import type { Server as SocketServer } from "socket.io";
import type { channels, messages } from "../db/schema";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { finishEndedChannelGuests, revokeBoundGuestSockets, type EndedChannelGuest } from "./channelService";
import { emitJointProjectionUpdates, publishChannelUpdate } from "./channelRealtimeEvents";
import { broadcastSystemMessageToLocalSurfaces, type CausalActor } from "./messageService";

/**
 * After an archive's commit, whoever archived it (a host admin's route, or the
 * joint's host side emptying): the ended Guests' removal, the Guests' live
 * connections, the channel update on every projection, and, when this archive
 * changed the channel, its system message.
 *
 * The message goes through the joint-aware publisher: for a joint it is one
 * row in the canonical history, with inbox facts and realtime for every
 * server's copy (before #13168 the route posted it on the archiving server's
 * copy only, so partners never saw it). Every step is safe to repeat when the
 * caller passes `persisted` (a row and inbox facts it committed with the
 * archive): delivery then re-sends that same row and writes nothing.
 */
export async function finishChannelArchive(
  io: SocketServer | null | undefined,
  orchestrator: AgentOrchestrator,
  updated: typeof channels.$inferSelect,
  input: {
    endedGuests: EndedChannelGuest[];
    systemMessage?: {
      content: string;
      causalActor: CausalActor;
      /** A durable caller fails (and retries) when delivery fails; the route posts in the background. */
      await?: boolean;
      /** Row and inbox facts already committed by the caller: deliver it, don't create one. */
      persisted?: typeof messages.$inferSelect;
    };
  },
): Promise<void> {
  await finishEndedChannelGuests(updated.serverId, input.endedGuests);
  // An archived channel's Guests lose their live connections (#wg-rbac:#15).
  // Also on an idempotent retry, so a retry repairs a replica where an earlier
  // revocation failed after commit.
  if (updated.archivedAt) await revokeBoundGuestSockets(updated.id);

  if (updated.type === "joint") {
    await emitJointProjectionUpdates(io, updated.id);
  } else {
    await publishChannelUpdate(io, updated);
  }

  if (input.systemMessage) {
    const posting = broadcastSystemMessageToLocalSurfaces(io as SocketServer, orchestrator, updated.id, input.systemMessage.content, {
      inboxFactPolicy: {
        mode: "record",
        producer: "channel.archive",
        reason: "channel archive is shared channel activity",
        causalActor: input.systemMessage.causalActor,
      },
      ...(input.systemMessage.persisted ? { persistedMessage: input.systemMessage.persisted } : {}),
    });
    if (input.systemMessage.await) await posting;
    else posting.catch(() => {});
  }
}
