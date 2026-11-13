import type { Server as SocketServer } from "socket.io";
import { afterAmbientCommit } from "../db/ambientTransaction";
import { socketUserServerRoom } from "../socket/platformScope";
import type { ReadScope } from "./notifications/retraction";
import { isReceiverStatePushEnabled } from "./receiverStatePushService";
import type { JointReadFanoutUpdate } from "./jointHumanReadFanout";

let io: SocketServer | null = null;
let retractRead: ((userId: string, serverId: string, scopes: readonly ReadScope[]) => void) | undefined;

/** The HTTP and durable-worker executors share this post-commit outlet. */
export function setJointHumanReadRealtimeIO(value: SocketServer | null, retract?: typeof retractRead): void {
  io = value;
  retractRead = retract;
}

export function announceJointHumanReadUpdates(input: {
  userId: string;
  mutationId: string;
  forward: boolean;
  updates: readonly JointReadFanoutUpdate[];
}): void {
  for (const serverId of new Set(input.updates.map((row) => row.serverId))) {
    const scopes = input.updates.filter((row) => row.serverId === serverId && row.changed);
    if (!scopes.length) continue;
    afterAmbientCommit(`joint-read:${input.mutationId}:${serverId}`, () => {
      if (!io) return;
      // Notification delivery and cursor push recover independently. A
      // failure in one must not suppress the other after a successful commit.
      if (input.forward) {
        try {
          retractRead?.(input.userId, serverId,
            scopes.map((row) => ({ conversationId: row.scopeId, throughSeq: row.maxReadSeq })));
        } catch (error) {
          console.error("[JointHumanRead] notification retraction failed", error);
        }
      }
      try {
        if (!isReceiverStatePushEnabled()) return;
        io.to(socketUserServerRoom(input.userId, serverId)).emit("read_state:updated_bulk", {
          serverId,
          scopes: scopes.map((row) => ({ scopeId: row.scopeId, maxReadSeq: row.maxReadSeq,
            readStateVersion: row.readStateVersion,
            ...(row.unreadCount !== undefined ? { unreadCount: row.unreadCount } : {}),
            ...(row.markedUnread ? { markedUnread: true } : {}),
          })),
        });
      } catch (error) {
        // The commit is authoritative; existing cursor sync recovers a missed
        // push. A broken socket must never turn it into a failed read response.
        console.error("[JointHumanRead] post-commit publication failed", error);
      }
    });
  }
}
