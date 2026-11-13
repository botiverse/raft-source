/**
 * Server-authored desktop notification contract (v1).
 *
 * The server decides who is notified (the same audience as web and mobile
 * push) and authors the text; Raft Desktop only applies device-local display
 * gates (window attended, dedupe, staleness, grouping, rate limits). Desktop
 * must never add recipients or re-derive mute / mention rules.
 *
 * Transport: the `notification:desktop` socket event, emitted to every one of
 * the user's `clientKind: "desktop"` sockets, across every server of the user.
 * It is Raft Desktop's only notification source (no flag, no local fallback).
 * The mobile `notification:push` event is unchanged and stays mobile-only.
 */

export const DESKTOP_NOTIFICATION_EVENT = "notification:desktop";

/**
 * Raft Desktop → server, from desktops before the unified notifications:
 * "the user is / is not using this desktop right now". Payload
 * `DesktopInputPresenceReport`. The server still accepts it as an alias of
 * `presence:activity` (PRESENCE_ACTIVITY_EVENT in ./notifications).
 */
export const DESKTOP_INPUT_PRESENCE_EVENT = "desktop:input-presence";

export interface DesktopInputPresenceReport {
  /** The window is visible, focused, not minimized, and the user is not away / locked. */
  attended: boolean;
  /** Seconds since the last system-wide keyboard / mouse input; null if unknown. */
  idleSeconds: number | null;
}

export const DESKTOP_NOTIFICATION_KINDS = ["dm", "channel", "thread", "mention", "task", "agent", "reminder"] as const;
export type DesktopNotificationKind = (typeof DESKTOP_NOTIFICATION_KINDS)[number];

export const DESKTOP_NOTIFICATION_EVENT_TYPES = [
  "message",
  "task_status",
  "task_assigned",
  "agent_action_required",
  "reminder_fired",
  // Unified notifications: an account notice (agent migration confirmed) and
  // POST /notifications/test. Desktops before them drop these (closed list).
  "system_notice",
  "test",
] as const;
export type DesktopNotificationEventType = (typeof DESKTOP_NOTIFICATION_EVENT_TYPES)[number];

export const DESKTOP_NOTIFICATION_TITLE_MAX = 160;
export const DESKTOP_NOTIFICATION_BODY_MAX = 512;

export type DesktopNotificationRoute =
  | { type: "channel"; serverId: string; channelId: string; messageId: string | null }
  | { type: "dm"; serverId: string; channelId: string; messageId: string | null }
  | {
    type: "thread";
    serverId: string;
    parentChannelId: string;
    parentChannelType: "channel" | "dm";
    parentMessageId: string;
    messageId: string | null;
  }
  | { type: "agent"; serverId: string; agentId: string };

export interface DesktopNotificationSender {
  id: string;
  type: "user" | "agent" | "system";
  name: string;
}

export interface DesktopNotificationV1 {
  v: 1;
  /** Dedupe id: the same event always carries the same id. */
  id: string;
  kind: DesktopNotificationKind;
  event: DesktopNotificationEventType;
  /** Plain text, at most DESKTOP_NOTIFICATION_TITLE_MAX characters. */
  title: string;
  /** Plain text. macOS subtitle; Windows and Linux fold it into the title or drop it. */
  subtitle?: string;
  /** Plain text (Markdown already stripped), at most DESKTOP_NOTIFICATION_BODY_MAX characters. */
  body: string;
  serverId: string;
  serverName: string;
  /** Conversation of the source message (the thread channel for a thread reply). */
  channelId: string | null;
  threadId: string | null;
  parentChannelId: string | null;
  parentMessageId: string | null;
  messageId: string | null;
  /** The recipient was personally addressed (mention, assignment, own task, own agent). */
  mentioned: boolean;
  sender: DesktopNotificationSender | null;
  task?: { id: string; number: number; title: string; status: string | null };
  agent?: { id: string; name: string };
  /** Relative app path (`/s/<slug>/...`). */
  url: string;
  route: DesktopNotificationRoute;
  /** Grouping key (macOS threadIdentifier, Windows Group). */
  groupKey: string;
  /** Replace a visible notification with the same key (burst coalescing). */
  replaceKey?: string;
  /** ISO time of the source event. */
  createdAt: string;
}

export function boundDesktopNotificationText(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

export function desktopNotificationMessageId(messageId: string): string {
  return `message:${messageId}`;
}

export function desktopNotificationReminderId(reminderId: string, firedAt: string): string {
  return `reminder:${reminderId}:${firedAt}`;
}

/**
 * One group per conversation: channel, DM, or thread (the thread's own channel
 * id, never its parent's). Raft Desktop withdraws a group when exactly that
 * conversation is read, so reading a thread retracts only its replies and
 * reading the parent channel leaves unread thread replies alone.
 */
export function desktopNotificationConversationGroupKey(serverId: string, conversationId: string): string {
  return `${serverId}:${conversationId}`;
}

export function desktopNotificationTaskGroupKey(serverId: string, taskId: string): string {
  return `${serverId}:task:${taskId}`;
}

export function desktopNotificationAgentGroupKey(serverId: string, agentId: string): string {
  return `${serverId}:agent:${agentId}`;
}

export function desktopNotificationReminderGroupKey(serverId: string): string {
  return `${serverId}:reminder`;
}

/** Message kind: a DM stays `dm` even when it mentions; elsewhere a mention wins. */
export function desktopNotificationMessageKind(
  surface: "channel" | "dm" | "thread",
  mentioned: boolean,
): DesktopNotificationKind {
  if (surface === "dm") return "dm";
  if (mentioned) return "mention";
  return surface;
}

const DESKTOP_NOTIFICATION_ROUTE_MAX = 2048;

/**
 * In-app routes a desktop notification may open on click: a server-scoped
 * path (`/s/<slug>...`), no scheme, no protocol-relative `//`, no backslashes
 * or `.` / `..` segments. The web checks what it hands to the shell, and the
 * shell's main process checks again before it keeps the route.
 */
export function isDesktopNotificationRoute(value: unknown): value is string {
  if (typeof value !== "string" || value.length > DESKTOP_NOTIFICATION_ROUTE_MAX) return false;
  if (!/^\/s\/[^/?#\s]+(?:[/?#]|$)/.test(value)) return false;
  if (value.includes("\\") || value.includes("//")) return false;
  const path = value.split(/[?#]/, 1)[0];
  return !path.split("/").some((segment) => segment === ".." || segment === ".");
}

/**
 * The user is in front of the desktop window: visible, not minimized,
 * focused and not away (idle or screen locked). The one test for "attended",
 * shared by the notification gate and the attention reports.
 */
export function isDesktopWindowAttended(state: {
  visible: boolean;
  minimized: boolean;
  focused: boolean;
  away: boolean;
}): boolean {
  return state.visible && !state.minimized && state.focused && !state.away;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseRoute(value: unknown): DesktopNotificationRoute | null {
  if (!isRecord(value) || !isString(value.serverId)) return null;
  switch (value.type) {
    case "channel":
    case "dm":
      return isString(value.channelId) && isNullableString(value.messageId)
        ? { type: value.type, serverId: value.serverId, channelId: value.channelId, messageId: value.messageId }
        : null;
    case "thread":
      return isString(value.parentChannelId)
        && (value.parentChannelType === "channel" || value.parentChannelType === "dm")
        && isString(value.parentMessageId)
        && isNullableString(value.messageId)
        ? {
          type: "thread",
          serverId: value.serverId,
          parentChannelId: value.parentChannelId,
          parentChannelType: value.parentChannelType,
          parentMessageId: value.parentMessageId,
          messageId: value.messageId,
        }
        : null;
    case "agent":
      return isString(value.agentId) ? { type: "agent", serverId: value.serverId, agentId: value.agentId } : null;
    default:
      return null;
  }
}

/**
 * Closed validation for a received `notification:desktop` payload. Returns
 * null for anything that is not a well-formed v1 payload (an unknown future
 * version included), so a consumer never renders a half-parsed notification.
 */
export function parseDesktopNotificationV1(value: unknown): DesktopNotificationV1 | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (!isString(value.id) || !isString(value.title) || !isString(value.body)) return null;
  if (!(DESKTOP_NOTIFICATION_KINDS as readonly unknown[]).includes(value.kind)) return null;
  if (!(DESKTOP_NOTIFICATION_EVENT_TYPES as readonly unknown[]).includes(value.event)) return null;
  if (value.subtitle !== undefined && !isString(value.subtitle)) return null;
  if (!isString(value.serverId) || !isString(value.serverName)) return null;
  for (const key of ["channelId", "threadId", "parentChannelId", "parentMessageId", "messageId"] as const) {
    if (!isNullableString(value[key])) return null;
  }
  if (typeof value.mentioned !== "boolean") return null;
  if (!isString(value.url) || !isString(value.groupKey) || !isString(value.createdAt)) return null;
  if (value.replaceKey !== undefined && !isString(value.replaceKey)) return null;
  const route = parseRoute(value.route);
  if (!route) return null;
  let sender: DesktopNotificationSender | null = null;
  if (value.sender !== null) {
    if (
      !isRecord(value.sender)
      || !isString(value.sender.id)
      || !isString(value.sender.name)
      || !(value.sender.type === "user" || value.sender.type === "agent" || value.sender.type === "system")
    ) return null;
    sender = { id: value.sender.id, type: value.sender.type, name: value.sender.name };
  }
  let task: DesktopNotificationV1["task"];
  if (value.task !== undefined) {
    if (
      !isRecord(value.task)
      || !isString(value.task.id)
      || typeof value.task.number !== "number"
      || !isString(value.task.title)
      || !isNullableString(value.task.status)
    ) return null;
    task = { id: value.task.id, number: value.task.number, title: value.task.title, status: value.task.status };
  }
  let agent: DesktopNotificationV1["agent"];
  if (value.agent !== undefined) {
    if (!isRecord(value.agent) || !isString(value.agent.id) || !isString(value.agent.name)) return null;
    agent = { id: value.agent.id, name: value.agent.name };
  }
  return {
    v: 1,
    id: value.id,
    kind: value.kind as DesktopNotificationKind,
    event: value.event as DesktopNotificationEventType,
    title: value.title,
    ...(value.subtitle !== undefined && { subtitle: value.subtitle }),
    body: value.body,
    serverId: value.serverId,
    serverName: value.serverName,
    channelId: value.channelId as string | null,
    threadId: value.threadId as string | null,
    parentChannelId: value.parentChannelId as string | null,
    parentMessageId: value.parentMessageId as string | null,
    messageId: value.messageId as string | null,
    mentioned: value.mentioned,
    sender,
    ...(task && { task }),
    ...(agent && { agent }),
    url: value.url,
    route,
    groupKey: value.groupKey,
    ...(value.replaceKey !== undefined && { replaceKey: value.replaceKey }),
    createdAt: value.createdAt,
  };
}
