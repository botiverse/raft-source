/**
 * Mobile socket transport (docs/contracts/notifications.md §4.1):
 * `notification:push` to the user's mobile sockets only (in-app banner;
 * GMS-less Android posts it). The fields older apps read are unchanged; the
 * envelope fields are additions.
 */
import type { Server as SocketServer } from "socket.io";
import { formatPushSurfaceTitle } from "@botiverse/raft-shared";
import type {
  NotificationCategory,
  NotificationLocalization,
  NotificationPreviewMode,
  NotificationPriority,
  NotificationRoute,
} from "@botiverse/raft-shared";
import { emitPlatformScopedUserEvent } from "../../../socket/platformScope";
import type { BuiltNotification, NotificationSurfaceKind } from "../types";

export const MOBILE_NOTIFICATION_PUSH_EVENT = "notification:push";

export interface NotificationPushSocketPayload {
  title: string;
  /** The context line (server label for a receiver of 2+ servers); additive. */
  subtitle?: string;
  body: string;
  tag: string;
  /** Absolute app URL. */
  url: string;
  serverName?: string;
  channelName?: string | null;
  parentChannelKind?: "channel" | "joint" | "dm" | null;
  senderId?: string;
  senderType?: "user" | "agent";
  senderName?: string;
  messagePreview?: string;
  mentioned?: boolean;
  serverId: string;
  /** Null for events without a message (reminder, system_notice, test). */
  kind: NotificationSurfaceKind | null;
  channelId: string | null;
  threadId: string | null;
  parentChannelId: string | null;
  parentMessageId: string | null;
  messageId: string | null;
  // Unified notification additions (§4.1).
  id: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  seq: number | null;
  groupKey: string;
  conversationId: string | null;
  /** Null when the event opens nothing specific (routeUrl is then `/s/<slug>/activity`). */
  route: NotificationRoute | null;
  routeUrl: string;
  silent: boolean;
  previewMode: NotificationPreviewMode;
  testId?: string;
  /**
   * Whether the device plan alerts the phone for this event now (contract
   * §1.3); additive, absent on test notifications. False while a computer is
   * in use ("Phone alerts") or while the alert is held: an app that posts this
   * event to the tray itself (GMS-less Android) should then only update its
   * in-app state.
   */
  phoneAlert?: boolean;
  /**
   * Keys of the fixed phrases in title / subtitle / body (contract §1.5);
   * additive. `title` stays `title · subtitle`, so an app that translates
   * `titleKey` joins the (translated) subtitle itself.
   */
  localization?: NotificationLocalization;
}

export function mobileSocketPayload(
  built: BuiltNotification,
  appUrl: string,
  extra: { testId?: string; phoneAlert?: boolean } = {},
): NotificationPushSocketPayload {
  const { envelope, mobile, push } = built;
  return {
    // The app draws this banner itself and does not know `subtitle` yet: the
    // context joins the title (as Web Push) until it does.
    title: push.subtitle ? formatPushSurfaceTitle(push.title, push.subtitle) : push.title,
    ...(push.subtitle ? { subtitle: push.subtitle } : {}),
    body: push.body,
    tag: envelope.id,
    url: `${appUrl}${built.routeUrl}`,
    ...(push.serverName !== undefined ? { serverName: push.serverName } : {}),
    channelName: push.channelName,
    parentChannelKind: push.parentChannelKind,
    ...(push.senderId !== undefined ? { senderId: push.senderId } : {}),
    ...(push.senderType !== undefined ? { senderType: push.senderType } : {}),
    ...(push.senderName !== undefined ? { senderName: push.senderName } : {}),
    ...(push.messagePreview !== undefined ? { messagePreview: push.messagePreview } : {}),
    mentioned: push.mentioned,
    serverId: mobile.serverId,
    kind: mobile.kind,
    channelId: mobile.channelId,
    threadId: mobile.threadId ?? null,
    parentChannelId: mobile.parentChannelId ?? null,
    parentMessageId: mobile.parentMessageId ?? null,
    messageId: mobile.messageId ?? null,
    id: envelope.id,
    category: envelope.category,
    priority: envelope.priority,
    seq: envelope.seq,
    groupKey: envelope.groupKey,
    conversationId: envelope.conversationId,
    route: built.route,
    routeUrl: built.routeUrl,
    silent: envelope.silent,
    previewMode: envelope.previewMode,
    ...(extra.testId ? { testId: extra.testId } : {}),
    ...(extra.phoneAlert !== undefined ? { phoneAlert: extra.phoneAlert } : {}),
    ...(push.localization ? { localization: push.localization } : {}),
  };
}

export function emitMobileNotification(io: SocketServer, userId: string, payload: NotificationPushSocketPayload): void {
  emitPlatformScopedUserEvent(io, userId, MOBILE_NOTIFICATION_PUSH_EVENT, payload);
}
