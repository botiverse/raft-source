/**
 * Unified notification contract (server, web, desktop, mobile).
 *
 * A notification is a projection of an Activity (inbox) fact. The server is the
 * only place that decides who is notified, on which device, and with what
 * text; clients only apply device-local display gates (the conversation is on
 * screen, dedupe, throttling). The wire contract for every client, mobile
 * included, is documented in docs/contracts/notifications.md.
 *
 * The desktop socket payload (`notification:desktop`, DesktopNotificationV1 in
 * ./desktopNotifications) stays `v: 1`; the envelope fields below are optional
 * additions, so an older parser keeps working.
 */

import type { DesktopNotificationRoute, DesktopNotificationV1 } from "./desktopNotifications";
import { parseNotificationLocalization, type NotificationLocalization } from "./notificationCopy";

// ---------------------------------------------------------------------------
// Levels: one enum, three scopes (server, channel incl. DM, thread incl. task)
// ---------------------------------------------------------------------------

export const NOTIFICATION_LEVELS = ["all", "mentions", "none"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/** `default` inherits the next wider scope (thread -> channel -> server). */
export const NOTIFICATION_LEVEL_SETTINGS = ["default", ...NOTIFICATION_LEVELS] as const;
export type NotificationLevelSetting = (typeof NOTIFICATION_LEVEL_SETTINGS)[number];

export const NOTIFICATION_LEVEL_SCOPES = ["server", "channel", "thread"] as const;
export type NotificationLevelScope = (typeof NOTIFICATION_LEVEL_SCOPES)[number];

export function isNotificationLevel(value: unknown): value is NotificationLevel {
  return typeof value === "string" && (NOTIFICATION_LEVELS as readonly string[]).includes(value);
}

export function isNotificationLevelSetting(value: unknown): value is NotificationLevelSetting {
  return typeof value === "string" && (NOTIFICATION_LEVEL_SETTINGS as readonly string[]).includes(value);
}

const LEVEL_RANK: Record<NotificationLevel, number> = { none: 0, mentions: 1, all: 2 };

export interface EffectiveLevelInput {
  /** The server-wide level (server_members.server_push_mode). */
  server: NotificationLevel;
  /** Explicit channel (or DM) level; for a thread, its parent channel's. `default`/null/undefined inherit. */
  channel?: NotificationLevelSetting | null;
  /** Explicit thread (or task conversation) level; only for thread messages. */
  thread?: NotificationLevelSetting | null;
  /** The channel (or DM) is muted in Activity: caps the level at `mentions`. */
  muted?: boolean;
}

function explicit(value: NotificationLevelSetting | null | undefined): NotificationLevel | null {
  return value && value !== "default" ? value : null;
}

/**
 * The level that applies: the most specific explicit setting wins
 * (thread > channel > server), then a mute caps it at `mentions`. The server's
 * policy and every client's display use this one function (mobile mirrors it
 * against the same fixtures, docs/contracts/fixtures/notification-levels.json).
 */
export function resolveEffectiveLevel(input: EffectiveLevelInput): NotificationLevel {
  const level = explicit(input.thread) ?? explicit(input.channel) ?? input.server;
  if (input.muted && LEVEL_RANK[level] > LEVEL_RANK.mentions) return "mentions";
  return level;
}

/** What a `default` setting inherits at this scope (for "Default (<inherited>)" labels). */
export function inheritedNotificationLevel(input: {
  scope: "channel" | "thread";
  server: NotificationLevel;
  channel?: NotificationLevelSetting | null;
}): NotificationLevel {
  if (input.scope === "channel") return input.server;
  return explicit(input.channel) ?? input.server;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const NOTIFICATION_CATEGORIES = [
  "dm",
  "mention",
  "task_assigned",
  "agent_attention",
  "reminder",
  "task_status",
  "thread",
  "channel",
  "system_notice",
  "test",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === "string" && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

export type NotificationPriority = "high" | "normal";

export const NOTIFICATION_PREVIEW_MODES = ["full", "sender_only", "hidden"] as const;
export type NotificationPreviewMode = (typeof NOTIFICATION_PREVIEW_MODES)[number];

export function isNotificationPreviewMode(value: unknown): value is NotificationPreviewMode {
  return typeof value === "string" && (NOTIFICATION_PREVIEW_MODES as readonly string[]).includes(value);
}

/** Strictest first: what a merge of several devices' preview modes keeps. */
export function strictestPreviewMode(modes: readonly NotificationPreviewMode[]): NotificationPreviewMode | null {
  if (modes.includes("hidden")) return "hidden";
  if (modes.includes("sender_only")) return "sender_only";
  if (modes.includes("full")) return "full";
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface NotificationTaskRoute {
  type: "task";
  serverId: string;
  parentChannelId: string;
  parentChannelType: "channel" | "dm";
  taskId: string;
  messageId: string | null;
}

/**
 * Where a click lands. `DesktopNotificationRoute` (channel, dm, thread, agent)
 * plus `task` (a task conversation). The legacy `route` field of a desktop
 * payload never carries `task` (an older desktop would drop the notification);
 * the exact target travels as the optional `target`.
 */
export type NotificationRoute = DesktopNotificationRoute | NotificationTaskRoute;

const TASK_CONVERSATION_PARAM_PREFIX = "task:";

/**
 * The one relative app path for a route (`/s/<slug>/...`). The server builds
 * notification URLs with it and the web parses the same shapes.
 */
export function notificationRoutePath(route: NotificationRoute, serverSlug: string): string {
  const base = `/s/${serverSlug}`;
  switch (route.type) {
    case "channel":
    case "dm":
      return `${base}/${route.type}/${route.channelId}${route.messageId ? `?msg=${route.messageId}` : ""}`;
    case "thread": {
      const params = new URLSearchParams({ thread: `${route.parentChannelId}:${route.parentMessageId}` });
      if (route.messageId) params.set("msg", route.messageId);
      return `${base}/${route.parentChannelType}/${route.parentChannelId}?${params.toString()}`;
    }
    case "task": {
      const params = new URLSearchParams({
        task: `${route.parentChannelId}:${TASK_CONVERSATION_PARAM_PREFIX}${route.taskId}`,
      });
      return `${base}/${route.parentChannelType}/${route.parentChannelId}?${params.toString()}`;
    }
    case "agent":
      return `${base}/agent/${route.agentId}`;
  }
}

/** The legacy-safe `route` for a target: a task opens its parent channel. */
export function legacyNotificationRoute(route: NotificationRoute): DesktopNotificationRoute {
  if (route.type !== "task") return route;
  return {
    type: route.parentChannelType,
    serverId: route.serverId,
    channelId: route.parentChannelId,
    messageId: route.messageId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Closed validation of a route object (any of the five types). */
export function parseNotificationRoute(value: unknown): NotificationRoute | null {
  if (!isRecord(value) || typeof value.serverId !== "string") return null;
  switch (value.type) {
    case "channel":
    case "dm":
      return typeof value.channelId === "string" && isNullableString(value.messageId ?? null)
        ? { type: value.type, serverId: value.serverId, channelId: value.channelId, messageId: (value.messageId as string | null | undefined) ?? null }
        : null;
    case "thread":
      return typeof value.parentChannelId === "string"
        && (value.parentChannelType === "channel" || value.parentChannelType === "dm")
        && typeof value.parentMessageId === "string"
        && isNullableString(value.messageId ?? null)
        ? {
          type: "thread",
          serverId: value.serverId,
          parentChannelId: value.parentChannelId,
          parentChannelType: value.parentChannelType,
          parentMessageId: value.parentMessageId,
          messageId: (value.messageId as string | null | undefined) ?? null,
        }
        : null;
    case "task":
      return typeof value.parentChannelId === "string"
        && (value.parentChannelType === "channel" || value.parentChannelType === "dm")
        && typeof value.taskId === "string"
        && isNullableString(value.messageId ?? null)
        ? {
          type: "task",
          serverId: value.serverId,
          parentChannelId: value.parentChannelId,
          parentChannelType: value.parentChannelType,
          taskId: value.taskId,
          messageId: (value.messageId as string | null | undefined) ?? null,
        }
        : null;
    case "agent":
      return typeof value.agentId === "string" ? { type: "agent", serverId: value.serverId, agentId: value.agentId } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Envelope: DesktopNotificationV1 + optional additions
// ---------------------------------------------------------------------------

export interface NotificationEnvelopeFields {
  category: NotificationCategory;
  priority: NotificationPriority;
  /** Source message seq in `conversationId`; retraction closes notifications with seq <= throughSeq. */
  seq: number | null;
  /** The conversation in `groupKey` (a thread's or task conversation's own channel id). */
  conversationId: string | null;
  /** The account sound setting is off. */
  silent: boolean;
  /** The account preview setting the text was already redacted for. */
  previewMode: NotificationPreviewMode;
  /** Exact click target (may be `task`); `route` stays legacy-safe. */
  target?: NotificationRoute;
  /** Set when the notification answers POST /notifications/test. */
  testId?: string;
  /**
   * Keys of the fixed phrases in title / subtitle / body (notificationCopy.ts,
   * contract §1.5); title / subtitle / body stay the English text, the fallback
   * for a key a client does not know.
   */
  localization?: NotificationLocalization;
}

export type NotificationEnvelope = DesktopNotificationV1 & Partial<NotificationEnvelopeFields>;

/** Reads the optional envelope additions off a parsed desktop payload (unknown values dropped). */
export function parseNotificationEnvelopeFields(value: unknown): Partial<NotificationEnvelopeFields> {
  if (!isRecord(value)) return {};
  const fields: Partial<NotificationEnvelopeFields> = {};
  if (isNotificationCategory(value.category)) fields.category = value.category;
  if (value.priority === "high" || value.priority === "normal") fields.priority = value.priority;
  if (value.seq === null || (typeof value.seq === "number" && Number.isFinite(value.seq))) fields.seq = value.seq as number | null;
  if (isNullableString(value.conversationId)) fields.conversationId = value.conversationId;
  if (typeof value.silent === "boolean") fields.silent = value.silent;
  if (isNotificationPreviewMode(value.previewMode)) fields.previewMode = value.previewMode;
  const target = parseNotificationRoute(value.target);
  if (target) fields.target = target;
  if (typeof value.testId === "string") fields.testId = value.testId;
  const localization = parseNotificationLocalization(value.localization);
  if (localization) fields.localization = localization;
  return fields;
}

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------

/** Server -> desktop, web and mobile sockets of the reader: a conversation was read. */
export const NOTIFICATION_RETRACT_EVENT = "notification:retract";

export interface NotificationRetractPayload {
  serverId: string;
  /** `<serverId>:<conversationId>` (desktopNotificationConversationGroupKey). */
  groupKey: string;
  conversationId: string;
  /** Close notifications of this conversation whose seq is <= this; null closes all of them. */
  throughSeq: number | null;
}

export function parseNotificationRetractPayload(value: unknown): NotificationRetractPayload | null {
  if (!isRecord(value)) return null;
  if (typeof value.serverId !== "string" || typeof value.groupKey !== "string" || typeof value.conversationId !== "string") return null;
  const throughSeq = value.throughSeq === null || value.throughSeq === undefined
    ? null
    : typeof value.throughSeq === "number" && Number.isFinite(value.throughSeq) ? value.throughSeq : undefined;
  if (throughSeq === undefined) return null;
  return { serverId: value.serverId, groupKey: value.groupKey, conversationId: value.conversationId, throughSeq };
}

/** Every client -> server: "the user is / is not actively using this device". */
export const PRESENCE_ACTIVITY_EVENT = "presence:activity";

/**
 * One device's presence (contract §1.3, §5). Two signals travel separately:
 *
 * - **Computer active** (routes the phone alert): input on this device within
 *   ACTIVE_INPUT_WINDOW_MS and the screen not locked. Desktop: system-wide
 *   input (any app), whatever window has focus. Web: input in the tab (a
 *   browser cannot see the rest of the system). Mobile: app in the foreground.
 * - **Attended** (only the device's own display gate): the Raft window or tab
 *   is in front of the user. The server never routes on it.
 *
 * Clients of the computer-active protocol always send `locked` (and
 * `attended`); the server then derives the last input from `idleSeconds`
 * whenever the screen is not locked, so a delay longer than the active window
 * (mobileDelay `5m`, `10m`) can be measured. A report without `locked` is an
 * older client's: its input counts only while `active` (the behaviour before).
 */
export interface PresenceActivityReport {
  /**
   * Computer-active protocol: input within ACTIVE_INPUT_WINDOW_MS and not
   * locked, regardless of focus. Older desktops and webs: window / tab
   * attended AND input within the window. Mobile: app in the foreground.
   */
  active: boolean;
  /** Seconds since the last input on this device; null when unknown (mobile foreground: 0). */
  idleSeconds: number | null;
  /** The screen is locked (web: always false). Absent from older clients and mobile. */
  locked?: boolean;
  /** The Raft window / tab is in front of the user. Informational; absent from older clients. */
  attended?: boolean;
  /**
   * Raft Desktop: this socket acks every `notification:desktop` on receipt, so
   * the server can tell a delivered alert from a half-open socket and alert
   * the phone instead. Absent: an older client (trusted as before).
   */
  ackAlerts?: boolean;
  /** Web: this browser holds a Web Push subscription (Notification permission granted). */
  pushSubscribed?: boolean;
  /**
   * Web: pushEndpointHash() of this browser's push subscription endpoint, so
   * the server knows which stored subscription reaches this computer. Null
   * or absent: none.
   */
  pushEndpointHash?: string | null;
}

/**
 * The short, non-reversible id of a Web Push endpoint the presence report
 * carries: the first PUSH_ENDPOINT_HASH_LENGTH characters of base64url
 * SHA-256(endpoint). The web computes it with SubtleCrypto, the server with
 * node:crypto (one rule, two implementations, a shared test vector).
 */
export const PUSH_ENDPOINT_HASH_LENGTH = 16;

/** A client re-reports once its last input moved this far since its last report (keeps the server's input time honest). */
export const PRESENCE_INPUT_REPORT_STEP_MS = 30 * 1000;
/** A desktop presence entry counts as deliverable only while its last report is this recent (heartbeat + 15 s). */
export const PRESENCE_FRESH_MS = 75 * 1000;

export function parsePresenceActivityReport(value: unknown): PresenceActivityReport | null {
  if (!isRecord(value) || typeof value.active !== "boolean") return null;
  const idle = value.idleSeconds;
  if (idle !== null && idle !== undefined && !(typeof idle === "number" && Number.isFinite(idle) && idle >= 0)) return null;
  return {
    active: value.active,
    idleSeconds: typeof idle === "number" ? idle : null,
    // Anything but a boolean is treated as absent: the older client's rules.
    ...(typeof value.locked === "boolean" ? { locked: value.locked } : {}),
    ...(typeof value.attended === "boolean" ? { attended: value.attended } : {}),
    ...(value.ackAlerts === true ? { ackAlerts: true } : {}),
    ...(typeof value.pushSubscribed === "boolean" ? { pushSubscribed: value.pushSubscribed } : {}),
    ...(typeof value.pushEndpointHash === "string" && value.pushEndpointHash.length === PUSH_ENDPOINT_HASH_LENGTH && /^[A-Za-z0-9_-]+$/.test(value.pushEndpointHash)
      ? { pushEndpointHash: value.pushEndpointHash }
      : {}),
  };
}

/** A device is active while its last input is this recent (CTO on #10462: 2-5 minutes). */
export const ACTIVE_INPUT_WINDOW_MS = 3 * 60 * 1000;
/** Clients re-send presence:activity this often while connected. */
export const PRESENCE_HEARTBEAT_MS = 60 * 1000;
/** A device kind is online while its last report is this recent. */
export const PRESENCE_ONLINE_TTL_MS = 150 * 1000;

// ---------------------------------------------------------------------------
// Account settings
// ---------------------------------------------------------------------------

export interface NotificationQuietHours {
  enabled: boolean;
  /** Minutes after local midnight, 0-1439. start > end spans midnight. */
  startMinute: number;
  endMinute: number;
  /** IANA time zone, e.g. "Europe/Berlin". */
  timeZone: string;
}

/**
 * "Phone alerts" (contract §1.3, Slack's "send to mobile"):
 * - `inactive` (default): only when I'm not active on a computer. Decided once
 *   at send time: while a computer is active the phone is never alerted for
 *   that message (it still gets the badge sync; Activity keeps the item).
 * - `1m`-`10m`: if I'm away from my computer that long and it's still unread
 *   (held, re-checked at the due time, cancelled once read).
 * - `always`: always, even when I'm active on a computer.
 */
export const NOTIFICATION_MOBILE_DELAYS = ["always", "inactive", "1m", "2m", "5m", "10m"] as const;
export type NotificationMobileDelay = (typeof NOTIFICATION_MOBILE_DELAYS)[number];

export function isNotificationMobileDelay(value: unknown): value is NotificationMobileDelay {
  return typeof value === "string" && (NOTIFICATION_MOBILE_DELAYS as readonly string[]).includes(value);
}

/** The wait after the last computer input; null for `always` and `inactive`. */
export function notificationMobileDelayMs(delay: NotificationMobileDelay): number | null {
  switch (delay) {
    case "1m": return 60_000;
    case "2m": return 2 * 60_000;
    case "5m": return 5 * 60_000;
    case "10m": return 10 * 60_000;
    default: return null;
  }
}

export interface NotificationAccountSettings {
  /** ISO time; notifications are paused until then. null = not paused. */
  pausedUntil: string | null;
  quietHours: NotificationQuietHours;
  previewMode: NotificationPreviewMode;
  sound: boolean;
  /** When a phone alerts while a computer is in use. */
  mobileDelay: NotificationMobileDelay;
  /**
   * "Replies in threads I follow" (contract §1.2, v1.2): off, a reply in a
   * followed thread or task conversation alerts only when it @mentions the
   * person. Following and Activity are unchanged. Absent on the wire = true.
   */
  followedThreadReplies: boolean;
  /** Optimistic concurrency: send it back on PATCH; a stale one gets 409. */
  version: number;
}

export const DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS: NotificationAccountSettings = {
  pausedUntil: null,
  quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 8 * 60, timeZone: "UTC" },
  previewMode: "full",
  sound: true,
  mobileDelay: "inactive",
  followedThreadReplies: true,
  version: 0,
};

function localMinuteOfDay(now: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return (hour % 24) * 60 + minute;
  } catch {
    return null;
  }
}

/** Inside the daily quiet hours now (start inclusive, end exclusive; start > end spans midnight). */
export function isWithinQuietHours(quiet: NotificationQuietHours, now: Date): boolean {
  if (!quiet.enabled || quiet.startMinute === quiet.endMinute) return false;
  const minute = localMinuteOfDay(now, quiet.timeZone);
  if (minute === null) return false;
  return quiet.startMinute < quiet.endMinute
    ? minute >= quiet.startMinute && minute < quiet.endMinute
    : minute >= quiet.startMinute || minute < quiet.endMinute;
}

/** Paused or in quiet hours: no alert anywhere, badges still sync. */
export function isNotificationQuiet(settings: Pick<NotificationAccountSettings, "pausedUntil" | "quietHours">, now: Date): boolean {
  if (settings.pausedUntil && Date.parse(settings.pausedUntil) > now.getTime()) return true;
  return isWithinQuietHours(settings.quietHours, now);
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

/**
 * The one badge number: Activity unread summed over every server whose level
 * is not `none`. Dock, taskbar overlay, tray dot, web title / favicon /
 * setAppBadge, iOS and Android all show this.
 */
export function notificationBadgeCount(
  servers: Iterable<{ level: NotificationLevel; activityUnreadCount: number }>,
): number {
  let total = 0;
  for (const server of servers) {
    if (server.level === "none") continue;
    if (Number.isFinite(server.activityUnreadCount) && server.activityUnreadCount > 0) total += server.activityUnreadCount;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Test notifications
// ---------------------------------------------------------------------------

export const NOTIFICATION_TEST_DEVICE_KINDS = ["desktop", "web", "mobile"] as const;
export type NotificationTestDeviceKind = (typeof NOTIFICATION_TEST_DEVICE_KINDS)[number];

export type NotificationTestStatus = "pending" | "shown" | "not_shown" | "failed";

/** Web page <-> service worker messages. */
export const SW_NOTIFICATION_RETRACT_MESSAGE = "RAFT_NOTIFICATION_RETRACT";
export const SW_NOTIFICATION_SHOWN_MESSAGE = "RAFT_NOTIFICATION_SHOWN";
