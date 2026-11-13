/**
 * One notification, rendered and redacted once per receiver (design §3.5).
 *
 * Banner copy (contract §1.5), the same on desktop and every push transport:
 * - title = where a tap lands: `#general`, `Thread in #general`, the sender
 *   of a DM, `#12 Fix login` for a task conversation / task notice, the
 *   agent / reminder / notice title;
 * - subtitle = context: the parent label of a task (`#general` / `DM`) and the
 *   server label, the server only for receivers in 2+ servers
 *   (`receiver.multiServer`); Web Push has no subtitle and joins it to the
 *   title (transports/webPush.ts);
 * - body = `Sender: text` (a DM: the text alone; a mention reads the same).
 *
 * The account preview setting is applied here, for every transport at once
 * (rules and localization keys of the former redactMobilePushPayload):
 * sender_only keeps the title (a task title falls back to its parent label,
 * the title is content) and replaces the body with "<sender> sent a message"
 * / "mentioned you"; hidden also replaces the title with "Raft" and drops
 * channel, server, task and agent names and the subtitle.
 *
 * Every fixed phrase in a title, subtitle or body carries its localization
 * key and args (`localization`, raft-shared notificationCopy.ts): the English
 * text is rendered from the key's template and always sent as the fallback.
 * Names, message text and `Sender: text` / `#12 Fix login` / `· Server`
 * joins have no key.
 */
import { createHash } from "node:crypto";
import {
  DESKTOP_NOTIFICATION_BODY_MAX,
  DESKTOP_NOTIFICATION_TITLE_MAX,
  boundDesktopNotificationText,
  boundNotificationPreview,
  desktopNotificationConversationGroupKey,
  desktopNotificationTaskGroupKey,
  formatNotificationCopy,
  formatNotificationSurface,
  formatPushBody,
  formatPushServerLabel,
  formatTaskSurface,
  isNotificationCopyKey,
  legacyNotificationRoute,
  notificationPreviewCopy,
  notificationRoutePath,
  notificationSurfaceCopy,
  type DesktopNotificationEventType,
  type DesktopNotificationKind,
  type DesktopNotificationSender,
  type DesktopNotificationV1,
  type NotificationAccountSettings,
  type NotificationCategory,
  type NotificationCopy,
  type NotificationCopyKey,
  type NotificationPreviewMode,
  type NotificationRoute,
  type NotificationSurface,
} from "@botiverse/raft-shared";
import { toNotificationPlainText } from "../pushDisplay";
import {
  isPersonalCategory,
  type BuiltNotification,
  type NotificationAlertLocalization,
  type NotificationSurfaceKind,
} from "./types";

export const NOTIFICATION_PREVIEW_KEYS = {
  senderOnlyMessage: "push.preview.sender_only.message",
  senderOnlyMention: "push.preview.sender_only.mention",
  hiddenTitle: "push.preview.hidden.title",
  hiddenMessage: "push.preview.hidden.message",
  hiddenMention: "push.preview.hidden.mention",
  senderOnlyTask: "push.preview.sender_only.task",
  senderOnlyAgent: "push.preview.sender_only.agent",
  senderOnlyReminder: "push.preview.sender_only.reminder",
  senderOnlyNotice: "push.preview.sender_only.notice",
  hiddenTask: "push.preview.hidden.task",
  hiddenAgent: "push.preview.hidden.agent",
  hiddenReminder: "push.preview.hidden.reminder",
  hiddenNotice: "push.preview.hidden.notice",
} as const;

/** What a redacted body says: a message, a mention, or a personal event of its own kind. */
export type NotificationPreviewSubject = "message" | "mention" | "task" | "agent" | "reminder" | "notice";

/** The redacted body keys of each subject; the English is the key's template (notificationCopy.ts). */
const PREVIEW_WORDING: Record<NotificationPreviewSubject, { senderOnlyKey: NotificationCopyKey; hiddenKey: NotificationCopyKey }> = {
  message: { senderOnlyKey: NOTIFICATION_PREVIEW_KEYS.senderOnlyMessage, hiddenKey: NOTIFICATION_PREVIEW_KEYS.hiddenMessage },
  mention: { senderOnlyKey: NOTIFICATION_PREVIEW_KEYS.senderOnlyMention, hiddenKey: NOTIFICATION_PREVIEW_KEYS.hiddenMention },
  task: { senderOnlyKey: NOTIFICATION_PREVIEW_KEYS.senderOnlyTask, hiddenKey: NOTIFICATION_PREVIEW_KEYS.hiddenTask },
  agent: { senderOnlyKey: NOTIFICATION_PREVIEW_KEYS.senderOnlyAgent, hiddenKey: NOTIFICATION_PREVIEW_KEYS.hiddenAgent },
  reminder: { senderOnlyKey: NOTIFICATION_PREVIEW_KEYS.senderOnlyReminder, hiddenKey: NOTIFICATION_PREVIEW_KEYS.hiddenReminder },
  notice: { senderOnlyKey: NOTIFICATION_PREVIEW_KEYS.senderOnlyNotice, hiddenKey: NOTIFICATION_PREVIEW_KEYS.hiddenNotice },
};

/** The redaction subject of a category (personal events never read as "mentioned you"). */
export function previewSubject(category: NotificationCategory, mentioned: boolean): NotificationPreviewSubject {
  switch (category) {
    case "task_status":
    case "task_assigned":
      return "task";
    case "agent_attention":
      return "agent";
    case "reminder":
      return "reminder";
    case "system_notice":
    case "test":
      return "notice";
    default:
      return mentioned ? "mention" : "message";
  }
}

type ParentChannel = { id: string; type: "channel" | "private" | "joint" | "dm" | "thread" | "task"; name: string };

/** Where a message event happened. */
export type NotificationConversation =
  | { surface: "channel" | "dm"; channelId: string; channelName: string | null }
  | {
    surface: "thread";
    threadChannelId: string;
    /** The parent conversation (a joint thread: this server's projection). */
    parent: ParentChannel | null;
    parentMessageId: string | null;
  }
  | {
    /** A task conversation (task v2). */
    surface: "task";
    conversationChannelId: string;
    parent: ParentChannel | null;
    taskId: string | null;
    /** The task's number and title (the banner title); null when it could not be loaded. */
    task: { number: number; title: string } | null;
    /** A message in the parent channel a legacy client lands on (task source message, else the latest). */
    anchorMessageId: string | null;
  };

/** A task / agent system notice carried by the message. */
export type NotificationMessageNotice =
  | { type: "task_status" | "task_assigned"; task: { id: string; number: number; title: string; status: string } | null }
  | { type: "agent_attention"; event: "agent_action_required"; agent: { id: string; name: string } };

/** Event data stored on the outbox row for events without a message. */
export interface NotificationNoticePayload {
  title: string;
  body: string;
  /** The key the English `title` / `body` was rendered from (notificationCopy.ts), when it is a fixed phrase. */
  titleKey?: NotificationCopyKey;
  titleArgs?: string[];
  bodyKey?: NotificationCopyKey;
  bodyArgs?: string[];
  kind: DesktopNotificationKind;
  event: DesktopNotificationEventType;
  route: NotificationRoute;
  /** Defaults to `<serverId>:<conversationId>` / a per-event key. */
  groupKey?: string;
  agent?: { id: string; name: string };
  /**
   * An account notice with nothing to open (a two-step verification
   * recovery): mobile gets `route: null` and `routeUrl` `/s/<slug>/activity`
   * (contract §4.1), as a test notification does; `route` stays the legacy
   * desktop route (a `channel` route with an empty channelId) and the desktop
   * navigates by `url`, the same Activity path.
   */
  opensActivity?: boolean;
  /**
   * A security notice (a two-step verification recovery started): notifies
   * past the person's server level and quiet hours (policy.ts). Only on a
   * `system_notice` row; the server alone writes payloads.
   */
  securityNotice?: boolean;
}

export function parseNotificationNoticePayload(value: unknown): NotificationNoticePayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<NotificationNoticePayload>;
  if (typeof payload.title !== "string" || typeof payload.body !== "string") return null;
  if (typeof payload.kind !== "string" || typeof payload.event !== "string" || !payload.route || typeof payload.route !== "object") return null;
  return payload as NotificationNoticePayload;
}

export type NotificationEventContext =
  | {
    type: "message";
    eventKey: string;
    server: { id: string; name: string | null; slug: string };
    message: {
      id: string;
      seq: number | null;
      createdAt: Date;
      /** Message text, Markdown included (rendered to a plain preview here). */
      content: string;
      attachmentCount: number;
      sender: { id: string; type: "user" | "agent" | "system"; name: string };
    };
    conversation: NotificationConversation;
    notice?: NotificationMessageNotice;
  }
  | {
    type: "notice";
    eventKey: string;
    server: { id: string; name: string | null; slug: string };
    createdAt: Date;
    payload: NotificationNoticePayload;
  };

export interface NotificationReceiver {
  category: NotificationCategory;
  /** Personally addressed (mention, assignee, own task, own agent, ...). */
  personal: boolean;
  /**
   * The receiver is a member of 2+ servers (joint storage and deleted servers
   * excluded): only then does the server label show. Unknown = true, so a
   * caller that cannot tell still names the server.
   */
  multiServer?: boolean;
}

function boundedTitle(value: string): string {
  return boundDesktopNotificationText(value, DESKTOP_NOTIFICATION_TITLE_MAX);
}

function boundedBody(value: string): string {
  return boundDesktopNotificationText(value, DESKTOP_NOTIFICATION_BODY_MAX);
}

/** Plain notification text of a notice body (optionally its first line). */
export function noticePlainBody(content: string, firstLineOnly = false): string {
  const plain = toNotificationPlainText(content);
  const text = firstLineOnly ? plain.split("\n").find((line) => line.trim()) ?? plain : plain;
  return boundedBody(text);
}

/** Banner text and, when it is a fixed phrase, its key and args. */
interface Phrase {
  text: string;
  copy?: NotificationCopy;
}

function phrase(key: NotificationCopyKey, ...args: string[]): Phrase {
  return { text: formatNotificationCopy(key, args), copy: { key, args } };
}

function titled(value: Phrase): Phrase {
  return { ...value, text: boundedTitle(value.text) };
}

function surfacePhrase(surface: NotificationSurface): Phrase {
  const copy = notificationSurfaceCopy(surface);
  return { text: formatNotificationSurface(surface), ...(copy ? { copy } : {}) };
}

function surfaceLabel(channel: { type: string; name: string } | null): Phrase | null {
  if (!channel) return null;
  return surfacePhrase(channel.type === "dm" ? { kind: "dm" } : { kind: "channel", channelName: channel.name });
}

/** A key stored with a notice payload, kept only while its template still renders the stored English. */
function storedCopy(key: unknown, args: unknown, english: string): NotificationCopy | undefined {
  if (!isNotificationCopyKey(key)) return undefined;
  const list = Array.isArray(args) && args.every((arg) => typeof arg === "string") ? args as string[] : [];
  return formatNotificationCopy(key, list) === english ? { key, args: list } : undefined;
}

function parentKindOf(parent: ParentChannel | null): "channel" | "joint" | "dm" | null {
  if (!parent) return null;
  return parent.type === "dm" ? "dm" : parent.type === "joint" ? "joint" : "channel";
}

function conversationKey(serverId: string, channelId: string): string {
  return createHash("sha256")
    .update("mobile-push-conversation-v1\0")
    .update(serverId)
    .update("\0")
    .update(channelId)
    .digest("base64url");
}

interface Location {
  route: NotificationRoute;
  conversationId: string | null;
  mobile: BuiltNotification["mobile"];
  /** Legacy desktop identity fields. */
  channelId: string | null;
  threadId: string | null;
  parentChannelId: string | null;
  parentMessageId: string | null;
  /** The title (where a tap lands). */
  surface: Phrase;
  /** Subtitle context before the server label (a task's parent label), or null. */
  context: Phrase | null;
  /** sender_only: a title that is content (a task title) is replaced by these. */
  redactedSurface?: { surface: Phrase; context: Phrase | null };
  channelName: string | null;
  parentChannelKind: "channel" | "joint" | "dm" | null;
  surfaceKind: "channel" | "dm" | "thread";
}

function messageLocation(serverId: string, messageId: string, conversation: NotificationConversation): Location {
  switch (conversation.surface) {
    case "channel":
    case "dm": {
      const isDm = conversation.surface === "dm";
      const channelName = isDm ? null : conversation.channelName;
      // "Message" (a channel without a name) has no key: the web catalogs already render that English as a verb.
      const surface: Phrase = isDm ? phrase("push.title.dm") : { text: channelName ? `#${channelName}` : "Message" };
      return {
        route: { type: isDm ? "dm" : "channel", serverId, channelId: conversation.channelId, messageId },
        conversationId: conversation.channelId,
        channelId: conversation.channelId,
        threadId: null,
        parentChannelId: null,
        parentMessageId: null,
        surface,
        context: null,
        channelName,
        parentChannelKind: null,
        surfaceKind: isDm ? "dm" : "channel",
        mobile: {
          serverId,
          channelId: conversation.channelId,
          messageId,
          kind: isDm ? "dm" : "channel",
          threadIdentifier: `${serverId}:${conversation.channelId}`,
          notificationKey: conversationKey(serverId, conversation.channelId),
        },
      };
    }
    case "thread": {
      const parent = conversation.parent;
      const parentKind = parentKindOf(parent);
      const surface = surfacePhrase({
        kind: "thread",
        parentKind: parentKind === "dm" ? "dm" : "channel",
        parentChannelName: parentKind === "dm" ? null : parent?.name ?? null,
      });
      const route: NotificationRoute = parent && conversation.parentMessageId
        ? {
          type: "thread",
          serverId,
          parentChannelId: parent.id,
          parentChannelType: parentKind === "dm" ? "dm" : "channel",
          parentMessageId: conversation.parentMessageId,
          messageId,
        }
        : { type: "channel", serverId, channelId: conversation.threadChannelId, messageId };
      return {
        route,
        conversationId: conversation.threadChannelId,
        channelId: conversation.threadChannelId,
        threadId: conversation.threadChannelId,
        parentChannelId: parent?.id ?? null,
        parentMessageId: conversation.parentMessageId,
        surface,
        context: null,
        channelName: parentKind === "dm" ? null : parent?.name ?? null,
        parentChannelKind: parentKind,
        surfaceKind: "thread",
        mobile: {
          serverId,
          channelId: conversation.threadChannelId,
          threadId: conversation.threadChannelId,
          ...(parent ? { parentChannelId: parent.id } : {}),
          ...(conversation.parentMessageId ? { parentMessageId: conversation.parentMessageId } : {}),
          messageId,
          kind: "thread",
          // One stack per thread (the banner title is the thread). Retraction
          // matches the payload groupKey, never the thread-id.
          threadIdentifier: `${serverId}:${conversation.threadChannelId}`,
          notificationKey: conversationKey(serverId, conversation.threadChannelId),
        },
      };
    }
    case "task": {
      const parent = conversation.parent;
      const parentKind = parentKindOf(parent);
      const scope: Phrase | null = parentKind === "dm" ? phrase("push.title.dm") : parent?.name ? { text: `#${parent.name}` } : null;
      // `#12 Fix login` under its parent label; without the task, today's label.
      const fallback = parentKind === "dm"
        ? phrase("push.title.task_in_dm")
        : parent?.name ? phrase("push.title.task_in_channel", parent.name) : phrase("push.title.task");
      const taskSurface: Phrase | null = conversation.task ? { text: formatTaskSurface(conversation.task) } : null;
      const legacyChannelId = parent?.id ?? conversation.conversationChannelId;
      const route: NotificationRoute = parent && conversation.taskId
        ? {
          type: "task",
          serverId,
          parentChannelId: parent.id,
          parentChannelType: parentKind === "dm" ? "dm" : "channel",
          taskId: conversation.taskId,
          messageId,
        }
        : { type: parentKind === "dm" ? "dm" : "channel", serverId, channelId: legacyChannelId, messageId: conversation.anchorMessageId };
      return {
        route,
        conversationId: conversation.conversationChannelId,
        channelId: legacyChannelId,
        threadId: null,
        parentChannelId: parent?.id ?? null,
        parentMessageId: null,
        surface: taskSurface ?? fallback,
        context: taskSurface ? scope : null,
        ...(taskSurface ? { redactedSurface: { surface: scope ?? phrase("push.title.task"), context: null } } : {}),
        channelName: parentKind === "dm" ? null : parent?.name ?? null,
        parentChannelKind: parentKind,
        surfaceKind: parentKind === "dm" ? "dm" : "channel",
        mobile: {
          serverId,
          channelId: legacyChannelId,
          ...(conversation.anchorMessageId ? { messageId: conversation.anchorMessageId } : {}),
          ...(conversation.taskId ? { taskId: conversation.taskId } : {}),
          taskConversationChannelId: conversation.conversationChannelId,
          taskMessageId: messageId,
          kind: parentKind === "dm" ? "dm" : "channel",
          threadIdentifier: `${serverId}:${legacyChannelId}`,
          notificationKey: conversationKey(serverId, legacyChannelId),
        },
      };
    }
  }
}

interface Text {
  /** Desktop and push title (where a tap lands). */
  title: Phrase;
  /** Desktop subtitle, push.subtitle / APNs alert.subtitle; absent when there is no context. */
  subtitle?: Phrase;
  desktopBody: string;
  pushBody: string;
  /** The key of the body when it is a fixed phrase (desktop and push bodies are then the same text). */
  bodyCopy?: NotificationCopy;
  messagePreview: string;
  senderName: string;
  /** sender_only: the title and subtitle when the full title is content (a task title). */
  redacted?: { title: Phrase; subtitle?: Phrase };
}

/** The keys of the shown title / subtitle / body; undefined when none is a fixed phrase. */
function localizationOf(title: Phrase, subtitle: Phrase | undefined, body: NotificationCopy | undefined): NotificationAlertLocalization | undefined {
  const localization: NotificationAlertLocalization = {};
  if (title.copy) {
    localization.titleKey = title.copy.key;
    if (title.copy.args.length > 0) localization.titleArgs = title.copy.args;
  }
  if (subtitle?.copy) {
    localization.subtitleKey = subtitle.copy.key;
    if (subtitle.copy.args.length > 0) localization.subtitleArgs = subtitle.copy.args;
  }
  if (body) {
    localization.bodyKey = body.key;
    localization.bodyArgs = body.args;
  }
  return Object.keys(localization).length > 0 ? localization : undefined;
}

function redact(
  text: Text,
  mode: NotificationPreviewMode,
  subject: NotificationPreviewSubject,
): { text: Text; localization?: NotificationAlertLocalization } {
  if (mode === "full") return { text, localization: localizationOf(text.title, text.subtitle, text.bodyCopy) };
  const wording = PREVIEW_WORDING[subject];
  if (mode === "sender_only") {
    const bodyCopy: NotificationCopy = { key: wording.senderOnlyKey, args: [text.senderName] };
    const body = formatNotificationCopy(bodyCopy.key, bodyCopy.args);
    const heading = text.redacted ?? { title: text.title, subtitle: text.subtitle };
    return {
      text: { ...text, title: heading.title, subtitle: heading.subtitle, desktopBody: body, pushBody: body, bodyCopy, messagePreview: body },
      localization: localizationOf(heading.title, heading.subtitle, bodyCopy),
    };
  }
  const bodyCopy: NotificationCopy = { key: wording.hiddenKey, args: [] };
  const body = formatNotificationCopy(bodyCopy.key);
  const title = phrase(NOTIFICATION_PREVIEW_KEYS.hiddenTitle);
  return {
    text: { ...text, title, subtitle: undefined, desktopBody: body, pushBody: body, bodyCopy, messagePreview: body },
    localization: localizationOf(title, undefined, bodyCopy),
  };
}

/** `<serverId>:reminder` / `<serverId>:notice` (contract §4.1), unless the payload names one. */
function noticeGroupKey(serverId: string, payload: NotificationNoticePayload): string {
  if (payload.groupKey) return payload.groupKey;
  return `${serverId}:${payload.event === "reminder_fired" ? "reminder" : "notice"}`;
}

/** The redacted notification of one event for one receiver. */
export function buildNotification(
  context: NotificationEventContext,
  receiver: NotificationReceiver,
  account: Pick<NotificationAccountSettings, "previewMode" | "sound">,
): BuiltNotification {
  const serverId = context.server.id;
  const serverLabel = formatPushServerLabel(context.server.name, context.server.slug);
  const multiServer = receiver.multiServer !== false;
  /** The subtitle: `context · Server` / `Server` for a multi-server receiver, the context alone otherwise. */
  const subtitleOf = (contextLabel: Phrase | null): Phrase | undefined => {
    const value = multiServer
      ? (contextLabel ? `${contextLabel.text} · ${serverLabel}` : serverLabel)
      : contextLabel?.text;
    if (!value) return undefined;
    const text = boundedTitle(value);
    // Only a DM context is words; `#general` and the server label are names.
    if (contextLabel?.copy?.key !== "push.title.dm") return { text };
    return { text, copy: multiServer ? { key: "push.subtitle.dm_server", args: [serverLabel] } : { key: "push.subtitle.dm", args: [] } };
  };
  const personal = isPersonalCategory(receiver.category, receiver.personal);
  // Only an actual @mention of the receiver (in a channel, thread, task
  // conversation or DM) reads as "mentioned you"; a DM or a personal event does not.
  const mentioned = receiver.category === "mention";
  const previewMode = account.previewMode;
  const hidden = previewMode === "hidden";

  let location: Location;
  let text: Text;
  let kind: DesktopNotificationKind;
  let event: DesktopNotificationEventType;
  let sender: DesktopNotificationSender | null;
  let createdAt: Date;
  let seq: number | null;
  let groupKey: string;
  let replaceKey: string | undefined;
  let task: DesktopNotificationV1["task"];
  let agent: DesktopNotificationV1["agent"];
  let pushSender: Pick<BuiltNotification["push"], "senderId" | "senderType" | "senderName"> = {};

  if (context.type === "message") {
    const { message } = context;
    location = messageLocation(serverId, message.id, context.conversation);
    createdAt = message.createdAt;
    seq = message.seq;
    groupKey = desktopNotificationConversationGroupKey(serverId, location.conversationId ?? message.id);
    const plainText = toNotificationPlainText(message.content);
    const preview = boundNotificationPreview(plainText, message.attachmentCount);
    const notice = context.notice;
    if (notice) {
      sender = { id: "system", type: "system", name: "Raft" };
      pushSender = { senderName: "Raft" };
      // A notice in a thread / task conversation is labelled by its parent conversation.
      const conversation = context.conversation;
      const label = conversation.surface === "thread" || conversation.surface === "task"
        ? surfaceLabel(conversation.parent)
        : location.surface;
      if (notice.type === "agent_attention") {
        const title = titled(phrase("push.title.agent_action_required", notice.agent.name));
        const body = noticePlainBody(message.content, true);
        kind = "agent";
        event = notice.event;
        agent = { id: notice.agent.id, name: notice.agent.name };
        text = {
          title,
          subtitle: subtitleOf(null),
          desktopBody: body,
          pushBody: body,
          messagePreview: body,
          senderName: "Raft",
        };
      } else {
        const body = noticePlainBody(message.content);
        // `#12 Fix login`; without the task: the conversation (status) / "Assigned to you".
        const fallbackTitle = notice.type === "task_status" ? location.surface : phrase("push.title.task_assigned");
        const title = titled(notice.task ? { text: formatTaskSurface(notice.task) } : fallbackTitle);
        kind = "task";
        event = notice.type;
        if (notice.task) {
          task = { id: notice.task.id, number: notice.task.number, title: notice.task.title, status: notice.task.status };
          if (notice.type === "task_status") replaceKey = desktopNotificationTaskGroupKey(serverId, notice.task.id);
        }
        text = {
          title,
          subtitle: subtitleOf(label),
          desktopBody: body,
          pushBody: body,
          messagePreview: body,
          senderName: "Raft",
          // sender_only: the task title is content; its parent label stands in.
          ...(notice.task || location.redactedSurface ? { redacted: { title: titled(label ?? phrase("push.title.task")), subtitle: subtitleOf(null) } } : {}),
        };
      }
    } else {
      const senderName = message.sender.name.trim() || "Someone";
      sender = message.sender.type === "system" ? { id: "system", type: "system", name: "Raft" } : { id: message.sender.id, type: message.sender.type, name: senderName };
      if (message.sender.type !== "system") pushSender = { senderId: message.sender.id, senderType: message.sender.type, senderName };
      else pushSender = { senderName };
      const isDm = location.surfaceKind === "dm" && context.conversation.surface === "dm";
      kind = isDm ? "dm" : mentioned ? "mention" : location.surfaceKind === "thread" || context.conversation.surface === "task" ? "thread" : "channel";
      event = "message";
      const redactedSurface = location.redactedSurface;
      // "Sent an attachment" / "(no text)" when there is no text (a system
      // sender's desktop body is its own text, so it has no key).
      const bodyCopy = message.sender.type === "system"
        ? null
        : notificationPreviewCopy(plainText, message.attachmentCount, isDm ? undefined : senderName);
      text = {
        // A DM is titled by its sender, its body the text alone.
        title: titled(isDm ? { text: senderName } : location.surface),
        subtitle: subtitleOf(location.context),
        // A system notice reads as its own text (no "Raft:" prefix) on desktop.
        desktopBody: message.sender.type === "system"
          ? noticePlainBody(message.content)
          : boundedBody(isDm ? preview : formatPushBody(senderName, preview)),
        pushBody: isDm ? preview : formatPushBody(senderName, preview),
        ...(bodyCopy ? { bodyCopy } : {}),
        messagePreview: preview,
        senderName,
        ...(redactedSurface ? { redacted: { title: titled(redactedSurface.surface), subtitle: subtitleOf(redactedSurface.context) } } : {}),
      };
    }
  } else {
    const { payload } = context;
    location = noticeLocation(serverId, payload);
    createdAt = context.createdAt;
    seq = null;
    groupKey = noticeGroupKey(serverId, payload);
    kind = payload.kind;
    event = payload.event;
    sender = null;
    pushSender = { senderName: "Raft" };
    if (payload.agent) agent = payload.agent;
    const body = boundedBody(payload.body);
    const titleCopy = storedCopy(payload.titleKey, payload.titleArgs, payload.title);
    const bodyCopy = storedCopy(payload.bodyKey, payload.bodyArgs, payload.body);
    text = {
      title: { text: boundedTitle(payload.title), ...(titleCopy ? { copy: titleCopy } : {}) },
      subtitle: subtitleOf(null),
      desktopBody: body,
      pushBody: body,
      ...(bodyCopy ? { bodyCopy } : {}),
      messagePreview: body,
      senderName: "Raft",
    };
  }

  const { text: shown, localization } = redact(text, previewMode, previewSubject(receiver.category, mentioned));
  const route = location.route;
  const opensActivity = context.type === "notice" && context.payload.opensActivity === true;
  const routeUrl = opensActivity ? `/s/${context.server.slug}/activity` : notificationRoutePath(route, context.server.slug);
  const legacyRoute = legacyNotificationRoute(route);
  const envelope: BuiltNotification["envelope"] = {
    v: 1,
    id: context.eventKey,
    kind,
    event,
    title: boundedTitle(shown.title.text),
    ...(shown.subtitle ? { subtitle: shown.subtitle.text } : {}),
    body: boundedBody(shown.desktopBody),
    serverId,
    serverName: hidden ? "" : serverLabel,
    channelId: location.channelId,
    threadId: location.threadId,
    parentChannelId: location.parentChannelId,
    parentMessageId: location.parentMessageId,
    messageId: context.type === "message" ? context.message.id : null,
    mentioned,
    sender: hidden && sender?.type !== "system" ? null : sender,
    // sender_only: the task title is content (the banner already shows the parent label).
    ...(task && !hidden ? { task: previewMode === "sender_only" ? { ...task, title: "" } : task } : {}),
    ...(agent && !hidden ? { agent } : {}),
    url: routeUrl,
    route: legacyRoute,
    groupKey,
    ...(replaceKey ? { replaceKey } : {}),
    createdAt: createdAt.toISOString(),
    category: receiver.category,
    priority: personal ? "high" : "normal",
    seq,
    conversationId: location.conversationId,
    silent: !account.sound,
    previewMode,
    target: route,
    ...(localization ? { localization } : {}),
  };
  return {
    envelope,
    push: {
      title: shown.title.text,
      ...(shown.subtitle ? { subtitle: shown.subtitle.text } : {}),
      body: shown.pushBody,
      ...(localization ? { localization } : {}),
      ...(hidden ? {} : { serverName: serverLabel }),
      channelName: hidden ? null : location.channelName,
      parentChannelKind: location.parentChannelKind,
      ...pushSender,
      ...(hidden ? { senderName: undefined, senderId: undefined, senderType: undefined } : {}),
      messagePreview: shown.messagePreview,
      mentioned,
    },
    mobile: location.mobile,
    route: opensActivity ? null : route,
    routeUrl,
  };
}

function noticeLocation(serverId: string, payload: NotificationNoticePayload): Location {
  const route = payload.route;
  const groupKey = noticeGroupKey(serverId, payload);
  const channelId = route.type === "channel" || route.type === "dm" ? route.channelId : null;
  const surfaceKind: NotificationSurfaceKind = route.type === "dm" ? "dm" : "channel";
  return {
    route,
    conversationId: null,
    channelId,
    threadId: null,
    parentChannelId: null,
    parentMessageId: null,
    surface: { text: payload.title },
    context: null,
    channelName: null,
    parentChannelKind: null,
    surfaceKind,
    mobile: {
      serverId,
      // Events without a message carry no conversation identity (contract §4.1).
      channelId: null,
      kind: null,
      threadIdentifier: groupKey,
      notificationKey: conversationKey(serverId, groupKey),
    },
  };
}
