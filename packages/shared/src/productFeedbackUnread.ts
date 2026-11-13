/**
 * Socket push of the product-feedback unread total, replacing the web's
 * 60-second `GET /api/product-feedback/tickets?limit=1` poll for its unread
 * dot. Sent only to the user's own connections (`user:<id>`), with the
 * `unread_total` Hands answered for that user's own reporter reads (what the
 * reporter can see: never internal notes or ticket text): when a ticket of
 * theirs got a new public reply, or after they read a ticket. Additive: a
 * client that doesn't know the event ignores it.
 *
 * Two events, because each client kind files into its own Hands app and each
 * app has its own total:
 * - `product_feedback:unread`: the web app's total, and only that. Web clients
 *   take every such event as their own total, so nothing of another app is
 *   ever sent on it.
 * - `product_feedback:app_unread`: a mobile app's total, with the app it is
 *   of. A client uses only the events whose `source` is its own platform.
 * Either way the first value is `unread_total` of
 * `GET /api/product-feedback/tickets?limit=1`, read on start and reconnect.
 */
import type { ProductFeedbackAppSource } from "./actionCards";

export const PRODUCT_FEEDBACK_UNREAD_EVENT = "product_feedback:unread" as const;

/** The whole payload: whose total it is, and the total. */
export interface ProductFeedbackUnreadEvent {
  userId: string;
  unreadTotal: number;
}

export const PRODUCT_FEEDBACK_APP_UNREAD_EVENT = "product_feedback:app_unread" as const;

/** The Hands feedback apps of the mobile clients: every app but the web's. */
export type ProductFeedbackMobileAppSource = Exclude<ProductFeedbackAppSource, "web">;

/** The whole payload: which app's total it is, and the total (the room says whose). */
export interface ProductFeedbackAppUnreadEvent {
  source: ProductFeedbackMobileAppSource;
  unreadTotal: number;
}
