/**
 * Internal contracts of the unified notification pipeline
 * (docs/contracts/notifications.md): enqueue -> dispatcher -> transports.
 *
 * One outbox row per (receiver, event). The dispatcher decides (policy.ts),
 * picks devices (presence.ts), renders one redacted notification
 * (envelope.ts) and hands it to every transport (transports/*). Nothing here
 * touches the database or a provider.
 */
import type {
  NotificationCategory,
  NotificationEnvelope,
  NotificationEnvelopeFields,
  NotificationLocalization,
  NotificationPreviewMode,
  NotificationRoute,
} from "@botiverse/raft-shared";
import type { notificationOutbox } from "../../db/schema";

export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;

export type NotificationDeviceKind = "desktop" | "web" | "mobile";

/** The legacy push surface kind (mobile identity, `notification:push` `kind`). */
export type NotificationSurfaceKind = "channel" | "dm" | "thread";

/**
 * Keys of the fixed phrases in an alert's title / subtitle / body (contract
 * §1.5; catalogue and English templates in raft-shared notificationCopy.ts).
 * Clients translate; the text fields hold the English fallback. A redacted
 * alert always has a body key (`push.preview.*`, bodyArgs `[sender]` /
 * `[]`) and, when hidden, the title key `push.preview.hidden.title`.
 */
export type NotificationAlertLocalization = NotificationLocalization;

/**
 * Everything a transport serializes, rendered and redacted once for one
 * receiver (envelope.ts). Text in every field is already redacted for the
 * receiver's account preview setting.
 */
export interface BuiltNotification {
  /**
   * The desktop socket payload: DesktopNotificationV1 (title = where a tap
   * lands, subtitle = context / server label, body `Sender: text`, a DM's
   * the text alone) plus every envelope field. `route` is legacy-safe (never
   * `task`); `target` is exact.
   */
  envelope: NotificationEnvelope & NotificationEnvelopeFields;
  /**
   * Push text shared by Web Push, the mobile socket, APNs and FCM: the
   * envelope's title / subtitle (title `#general`, a DM's sender,
   * `#12 Fix login`; subtitle the context and, for a receiver of 2+ servers,
   * the server label), body `Sender: text` (a DM: the text alone).
   */
  push: {
    title: string;
    /**
     * Context line (APNs `alert.subtitle`, FCM / mobile socket `subtitle`; Web
     * Push joins it to the title). Absent when there is none (single-server
     * receiver without context) and when the preview is hidden.
     */
    subtitle?: string;
    body: string;
    /** Keys of title / subtitle / body (also `envelope.localization`); absent when all three are names / message text. */
    localization?: NotificationAlertLocalization;
    /** Server label; absent when the preview is hidden. */
    serverName?: string;
    channelName: string | null;
    parentChannelKind: "channel" | "joint" | "dm" | null;
    senderId?: string;
    senderType?: "user" | "agent";
    senderName?: string;
    /** The (redacted) message preview. */
    messagePreview?: string;
    mentioned: boolean;
  };
  /** Mobile identity: APNs custom keys, FCM data keys, `notification:push` identity. */
  mobile: {
    serverId: string;
    /** The conversation a legacy client opens (a task conversation's parent channel). */
    channelId: string | null;
    threadId?: string;
    parentChannelId?: string;
    parentMessageId?: string;
    messageId?: string;
    taskId?: string;
    taskConversationChannelId?: string;
    taskMessageId?: string;
    /** Null for events without a message (reminder, system_notice, test). */
    kind: NotificationSurfaceKind | null;
    /**
     * APNs `thread-id`: `<serverId>:<channelId>` (a thread reply: its own
     * thread channel; a task conversation: its parent channel). Clients
     * retract by the payload `groupKey`, never by this.
     */
    threadIdentifier: string;
    /** FCM `notificationKey` (one per conversation; Android <= 1.16 notification id). */
    notificationKey: string;
  };
  /**
   * The exact click target (`envelope.target`) for mobile payloads; null when
   * the event opens nothing specific (then routeUrl is `/s/<slug>/activity`).
   */
  route: NotificationRoute | null;
  /** Relative app path of `route` (notificationRoutePath). */
  routeUrl: string;
}

/** Device plan for one receiver and event (presence.ts §5.1). */
export interface NotificationDevicePlan {
  /** Show a system notification on desktop sockets. */
  desktop: boolean;
  /** Send Web Push to browser subscriptions. */
  webPush: boolean;
  /** APNs / FCM alert (otherwise only a badge `sync` when needed). */
  mobileAlert: boolean;
  /** `notification:push` to mobile sockets: always for a notifying event. */
  mobileSocket: boolean;
  /** Active kinds that decided the plan (empty: nobody active, everything alerts). */
  activeKinds: NotificationDeviceKind[];
  /**
   * Account mobileDelay `1m`-`10m`: the phone alert waits until this time
   * (epoch ms), the last computer input plus the delay. Null: no wait (the
   * alert follows `mobileAlert`).
   */
  mobileDeferUntil: number | null;
}

export interface NotificationPresenceRecord {
  /** Epoch ms of the last report of this kind (online while < PRESENCE_ONLINE_TTL_MS old). */
  lastSeenAt: number;
  /**
   * Epoch ms of the last input (active while < ACTIVE_INPUT_WINDOW_MS old).
   * Computer-active clients keep it past the window (a phone delay is measured
   * from it); null = none proven (locked, unknown, an older client not active).
   */
  lastInputAt: number | null;
  /** Entry: this socket acks desktop alerts (presence report `ackAlerts`). */
  ackAlerts?: true;
  /** Entry: pushEndpointHash of this browser's Web Push subscription. */
  pushEndpointHash?: string;
  /**
   * Kind (aggregated): there are active entries and every one of them acks,
   * so a desktop alert nobody acks was not delivered. Absent: no active entry,
   * or an older client among them (trusted as before).
   */
  confirmable?: true;
  /** Kind (aggregated): socket ids of its active entries that ack (only their acks confirm). */
  ackSocketIds?: string[];
  /** Kind (aggregated): it has active entries and none reported within PRESENCE_FRESH_MS. */
  stale?: true;
  /** Kind (aggregated): the push endpoint hashes of its active entries. */
  pushEndpointHashes?: string[];
}

/** Presence of one user: absent kinds have no live record. `null` = lookup failed (fail open). */
export type NotificationUserPresence = Partial<Record<NotificationDeviceKind, NotificationPresenceRecord>>;

/** A live mobile registration of a receiver (dispatcher device load). */
export interface MobileRegistrationTarget {
  id: string;
  userId: string;
  installationId: string;
  provider: "apns" | "fcm";
  deviceToken: string;
  topic: string;
  env: "sandbox" | "production";
  /** false, or OS permission `denied`: only sync / retract pushes. */
  alertsEnabled: boolean;
  osPermission: "granted" | "denied" | "provisional" | "unknown" | null;
  /** Newest preview localization key set the app ships (contract §3.1: 1 = the original five keys, 2 = every redacted-preview key, 3 = every banner key). */
  previewKeySet: number;
  /** The app version the device last registered with (diagnostics only). */
  appVersion?: string | null;
}

/** A browser Web Push subscription of a receiver. */
export interface WebPushSubscriptionTarget {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What one provider attempt returned (a throw is a failure classified by the transport). */
export interface ExternalSendResult {
  status: "sent" | "skipped";
  reason?: string;
}

/** Background pushes: badge sync while quiet / excluded, and read retraction. */
export type MobileBackgroundPush =
  | {
    type: "sync";
    badge: number | undefined;
    /** Set when the sync is for one server: that server's term of the badge. */
    serverId?: string;
    serverBadge?: number;
  }
  | {
    type: "retract";
    badge: number | undefined;
    serverId: string;
    groupKey: string;
    conversationId: string;
    /** null = every notification of the group. */
    throughSeq: number | null;
    serverBadge?: number;
  };

/** Per-transport counters written to `notification_outbox.transports`. */
export interface NotificationTransportCounts {
  desktop: number;
  web: number;
  mobileSocket: number;
  apns: number;
  fcm: number;
  sync: number;
  failed: number;
  revoked: number;
  skippedByPresence: NotificationDeviceKind[];
  skippedDeviceDisabled: number;
  /** Phones whose alert waits in notification_mobile_deferrals (account mobileDelay). */
  mobileDeferred: number;
  /** Desktop alerts that had to be acked and got no ack (half-open socket, crashed replica). Absent when 0. */
  desktopUnconfirmed?: number;
  /** Phone alerts sent because no computer path confirmed delivery (never alert nowhere). Absent when 0. */
  mobileFallback?: number;
}

export type NotificationDecision =
  | { kind: "notify" }
  | { kind: "quiet" }
  | { kind: "suppressed"; reason: NotificationSuppressionReason };

export type NotificationSuppressionReason =
  | "server_none"
  | "server_mentions"
  | "channel_level"
  | "thread_level"
  /** Account "Replies in threads I follow" is off and the reply does not @mention the receiver. */
  | "followed_thread_replies_off"
  | "muted"
  | "not_member"
  | "stale"
  | "no_device"
  | "unread_ineligible"
  | "no_access";

export function notificationDecisionLabel(decision: NotificationDecision): string {
  return decision.kind === "suppressed" ? `suppressed:${decision.reason}` : decision.kind;
}

/** Personal categories notify at `all` and `mentions`; see policy.ts. */
export function isPersonalCategory(category: NotificationCategory, personal: boolean): boolean {
  switch (category) {
    case "dm":
    case "mention":
    case "task_assigned":
    case "agent_attention":
    case "reminder":
    case "system_notice":
    case "test":
      return true;
    case "task_status":
      return personal;
    case "thread":
    case "channel":
      return false;
  }
}

export type { NotificationCategory, NotificationPreviewMode };
