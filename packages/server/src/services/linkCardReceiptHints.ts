import type { Server as SocketServer } from "socket.io";
import { LINK_CARD_OPERATION_CHANGED_EVENT, type LinkCardOperationChangedEvent } from "@botiverse/raft-shared/src/appLinkPreview";
import { socketUserServerRoom } from "../socket/platformScope";

// Interactive link card receipt hints (RFC 076 §6.8; protocol v3.2.3 §8.3).
// Whenever an operation's receipt changes (the execute answer, a forwarded
// status, a terminal update from the App, a sweep), Raft tells the viewer's own
// sockets on that Server that operation `operation_id` is now at
// `receipt_revision`, and nothing else: no state, no App, no text. The client
// then reads status under its current access. A hint is sent after the change
// commits, never from inside a transaction, and a lost one costs nothing: the
// socket is not the source of truth.

export type LinkCardReceiptChange = { viewerId: string; serverId: string; operationId: string; receiptRevision: number };
export type LinkCardReceiptHints = (change: LinkCardReceiptChange) => void;

export const noLinkCardReceiptHints: LinkCardReceiptHints = () => {};

/** Hints through this Socket.IO server (cross-replica through its adapter); none without one. */
export function linkCardReceiptHints(io: SocketServer | null | undefined): LinkCardReceiptHints {
  if (!io) return noLinkCardReceiptHints;
  return (change) => {
    const payload: LinkCardOperationChangedEvent = { operation_id: change.operationId, receipt_revision: change.receiptRevision };
    try {
      io.to(socketUserServerRoom(change.viewerId, change.serverId)).emit(LINK_CARD_OPERATION_CHANGED_EVENT, payload);
    } catch (error) {
      // A hint is best effort; never fail the request or the sweep for it.
      console.error("[LinkCardHints] emit failed", error instanceof Error ? error.name : "unknown");
    }
  };
}
