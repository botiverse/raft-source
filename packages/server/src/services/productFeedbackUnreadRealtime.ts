/**
 * A user's product-feedback unread total, to that user's own connections only
 * (`user:<id>`, every replica through the Socket.IO Redis adapter), one event
 * per kind of Hands app (shared productFeedbackUnread.ts):
 * - `product_feedback:unread`: the web app's total, and nothing else. An open
 *   web client takes every such event as its own total, so a mobile app's
 *   total is never sent on it.
 * - `product_feedback:app_unread`: a mobile app's total with its `source`; a
 *   mobile client uses only its own platform's.
 * Sent by the unread reconcile job (productFeedbackUnreadReconcile.ts) and
 * after a ticket read (routes/productFeedback.ts). The payload is the count
 * from that user's own reporter detail answer (with the user id, or the app):
 * never anything else of the change feed or the ticket (text, replies,
 * internal-note activity).
 *
 * The socket server is set once by server.ts (as listChangedRealtime's); with
 * none set (a unit test, a job runner) nothing is sent. A send never throws.
 */
import type { Server as SocketServer } from "socket.io";
import {
  PRODUCT_FEEDBACK_APP_UNREAD_EVENT,
  PRODUCT_FEEDBACK_UNREAD_EVENT,
  type ProductFeedbackAppUnreadEvent,
  type ProductFeedbackMobileAppSource,
  type ProductFeedbackUnreadEvent,
} from "@botiverse/raft-shared";

type UnreadEmitter = Pick<SocketServer, "to">;

let emitter: UnreadEmitter | null = null;

/** Set by server.ts once Socket.IO is up (and by tests); null stops sending. */
export function setProductFeedbackUnreadRealtimeIO(io: UnreadEmitter | null): void {
  emitter = io;
}

/** Whether a push would go anywhere (a socket server is set). */
export function isProductFeedbackUnreadRealtimeReady(): boolean {
  return emitter !== null;
}

function send(userId: string, event: string, payload: ProductFeedbackUnreadEvent | ProductFeedbackAppUnreadEvent): boolean {
  if (!emitter || !Number.isSafeInteger(payload.unreadTotal) || payload.unreadTotal < 0) return false;
  try {
    emitter.to(`user:${userId}`).emit(event, payload);
    return true;
  } catch (error) {
    console.error(`[product-feedback] ${event} push failed (${error instanceof Error ? error.name : "unknown"})`);
    return false;
  }
}

/** Push the web app's `unreadTotal` to `userId`'s own connections; false when not sent. */
export function pushProductFeedbackUnread(userId: string, unreadTotal: number): boolean {
  return send(userId, PRODUCT_FEEDBACK_UNREAD_EVENT, { userId, unreadTotal });
}

/** Push the `unreadTotal` of the mobile app `source` to `userId`'s own connections; false when not sent. */
export function pushProductFeedbackAppUnread(userId: string, source: ProductFeedbackMobileAppSource, unreadTotal: number): boolean {
  return send(userId, PRODUCT_FEEDBACK_APP_UNREAD_EVENT, { source, unreadTotal });
}
