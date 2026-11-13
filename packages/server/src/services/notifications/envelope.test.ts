import assert from "node:assert/strict";
import {
  desktopNotificationReminderGroupKey,
  desktopNotificationReminderId,
  formatNotificationCopy,
  notificationRoutePath,
  parseDesktopNotificationV1,
  parseNotificationEnvelopeFields,
  type NotificationAccountSettings,
  type NotificationCopyKey,
  type NotificationPreviewMode,
} from "@botiverse/raft-shared";
import {
  NOTIFICATION_PREVIEW_KEYS,
  buildNotification,
  type NotificationConversation,
  type NotificationEventContext,
  type NotificationMessageNotice,
  type NotificationNoticePayload,
  type NotificationReceiver,
} from "./envelope";
import type { BuiltNotification } from "./types";

const SERVER = { id: "srv-1", name: "Acme", slug: "acme" };
const CREATED_AT = new Date("2026-01-15T12:00:00.000Z");
const FULL: Pick<NotificationAccountSettings, "previewMode" | "sound"> = { previewMode: "full", sound: true };

const CHANNEL: NotificationConversation = { surface: "channel", channelId: "ch-1", channelName: "general" };
const DM: NotificationConversation = { surface: "dm", channelId: "dm-1", channelName: null };
const PARENT_CHANNEL = { id: "ch-1", type: "channel" as const, name: "general" };
const PARENT_DM = { id: "dm-1", type: "dm" as const, name: "dm-name" };

const CHANNEL_RECEIVER: NotificationReceiver = { category: "channel", personal: false };
const MENTION_RECEIVER: NotificationReceiver = { category: "mention", personal: true };
const DM_RECEIVER: NotificationReceiver = { category: "dm", personal: true };
const THREAD_RECEIVER: NotificationReceiver = { category: "thread", personal: false };

const SYSTEM_SENDER = { id: "system", type: "system" as const, name: "system" };
const TASK = { id: "task-1", number: 12, title: "Fix login", status: "in_review" };

function messageContext(options: {
  conversation: NotificationConversation;
  content?: string;
  messageId?: string;
  seq?: number | null;
  sender?: { id: string; type: "user" | "agent" | "system"; name: string };
  notice?: NotificationMessageNotice;
  server?: typeof SERVER;
  attachmentCount?: number;
}): NotificationEventContext {
  const messageId = options.messageId ?? "m-1";
  return {
    type: "message",
    eventKey: `message:${messageId}`,
    server: options.server ?? SERVER,
    message: {
      id: messageId,
      seq: options.seq === undefined ? 7 : options.seq,
      createdAt: CREATED_AT,
      content: options.content ?? "hello there",
      attachmentCount: options.attachmentCount ?? 0,
      sender: options.sender ?? { id: "u-alice", type: "user", name: "Alice" },
    },
    conversation: options.conversation,
    ...(options.notice ? { notice: options.notice } : {}),
  };
}

function noticeContext(eventKey: string, payload: NotificationNoticePayload): NotificationEventContext {
  return { type: "notice", eventKey, server: SERVER, createdAt: CREATED_AT, payload };
}

/** Every built notification must be a valid desktop payload and agree with its own route. */
function assertWellFormed(built: BuiltNotification, slug = SERVER.slug): void {
  const wire = JSON.parse(JSON.stringify(built.envelope)) as unknown;
  assert.ok(parseDesktopNotificationV1(wire), "envelope passes parseDesktopNotificationV1");
  const fields = parseNotificationEnvelopeFields(wire);
  assert.deepEqual(fields, {
    category: built.envelope.category,
    priority: built.envelope.priority,
    seq: built.envelope.seq,
    conversationId: built.envelope.conversationId,
    silent: built.envelope.silent,
    previewMode: built.envelope.previewMode,
    target: built.route,
    ...(built.envelope.localization ? { localization: fields.localization } : {}),
  });
  // Desktop and push carry the same keys, and each key renders the English text sent with it.
  assert.deepEqual(built.envelope.localization, built.push.localization);
  const localization = built.push.localization;
  if (localization?.titleKey) assert.equal(formatNotificationCopy(localization.titleKey as NotificationCopyKey, localization.titleArgs ?? []), built.push.title);
  if (localization?.subtitleKey) assert.equal(formatNotificationCopy(localization.subtitleKey as NotificationCopyKey, localization.subtitleArgs ?? []), built.push.subtitle);
  if (localization?.bodyKey) assert.equal(formatNotificationCopy(localization.bodyKey as NotificationCopyKey, localization.bodyArgs ?? []), built.push.body);
  assert.equal(built.routeUrl, notificationRoutePath(built.route!, slug));
  assert.equal(built.envelope.url, built.routeUrl);
  assert.notEqual(built.envelope.route.type, "task" as string, "legacy route never carries task");
}

// ---------------------------------------------------------------------------
// Message surfaces
// ---------------------------------------------------------------------------

describe("channel message", () => {
  test("desktop and push text, identity and route", () => {
    const built = buildNotification(messageContext({ conversation: CHANNEL }), CHANNEL_RECEIVER, FULL);
    assertWellFormed(built);
    const { envelope, push, mobile } = built;
    assert.equal(envelope.id, "message:m-1");
    assert.equal(envelope.title, "#general");
    assert.equal(envelope.subtitle, "Acme");
    assert.equal(envelope.body, "Alice: hello there");
    assert.equal(envelope.serverName, "Acme");
    assert.equal(envelope.kind, "channel");
    assert.equal(envelope.event, "message");
    assert.equal(envelope.mentioned, false);
    assert.equal(envelope.priority, "normal");
    assert.equal(envelope.category, "channel");
    assert.equal(envelope.seq, 7);
    assert.equal(envelope.conversationId, "ch-1");
    assert.equal(envelope.groupKey, "srv-1:ch-1");
    assert.equal(envelope.channelId, "ch-1");
    assert.equal(envelope.threadId, null);
    assert.equal(envelope.messageId, "m-1");
    assert.deepEqual(envelope.sender, { id: "u-alice", type: "user", name: "Alice" });
    assert.equal(envelope.createdAt, CREATED_AT.toISOString());
    assert.equal(envelope.silent, false);
    assert.equal(envelope.previewMode, "full");
    assert.deepEqual(built.route, { type: "channel", serverId: "srv-1", channelId: "ch-1", messageId: "m-1" });
    assert.equal(built.routeUrl, "/s/acme/channel/ch-1?msg=m-1");

    assert.equal(push.title, "#general");
    assert.equal(push.subtitle, "Acme", "the receiver's server count is unknown: the server label shows (fail safe)");
    assert.equal(push.body, "Alice: hello there");
    assert.equal(push.localization, undefined);
    assert.equal(push.serverName, "Acme");
    assert.equal(push.channelName, "general");
    assert.equal(push.parentChannelKind, null);
    assert.equal(push.senderId, "u-alice");
    assert.equal(push.senderType, "user");
    assert.equal(push.senderName, "Alice");
    assert.equal(push.messagePreview, "hello there");
    assert.equal(push.mentioned, false);

    assert.equal(mobile.serverId, "srv-1");
    assert.equal(mobile.channelId, "ch-1");
    assert.equal(mobile.messageId, "m-1");
    assert.equal(mobile.kind, "channel");
    assert.equal(mobile.threadIdentifier, "srv-1:ch-1");
    assert.equal(typeof mobile.notificationKey, "string");
  });

  test("a mention reads `Sender: text` (no \"mentioned you\" prefix), kind mention, priority high", () => {
    const built = buildNotification(messageContext({ conversation: CHANNEL }), MENTION_RECEIVER, FULL);
    assertWellFormed(built);
    assert.equal(built.envelope.body, "Alice: hello there");
    assert.equal(built.envelope.kind, "mention");
    assert.equal(built.envelope.category, "mention");
    assert.equal(built.envelope.priority, "high");
    assert.equal(built.envelope.mentioned, true);
    assert.equal(built.push.body, "Alice: hello there");
    assert.equal(built.push.mentioned, true);
  });

  test("the server label falls back to the slug; Markdown is stripped from the preview", () => {
    const built = buildNotification(
      messageContext({ conversation: CHANNEL, content: "**bold** text", server: { ...SERVER, name: null as unknown as string } }),
      CHANNEL_RECEIVER,
      FULL,
    );
    assert.equal(built.envelope.subtitle, "acme");
    assert.equal(built.push.title, "#general");
    assert.equal(built.push.subtitle, "acme");
    assert.equal(built.push.messagePreview, "bold text");
  });

  test("notifications of one conversation share a notificationKey; another conversation differs", () => {
    const a = buildNotification(messageContext({ conversation: CHANNEL, messageId: "m-1" }), CHANNEL_RECEIVER, FULL);
    const b = buildNotification(messageContext({ conversation: CHANNEL, messageId: "m-2" }), CHANNEL_RECEIVER, FULL);
    const c = buildNotification(messageContext({ conversation: { ...CHANNEL, channelId: "ch-2" } as NotificationConversation }), CHANNEL_RECEIVER, FULL);
    assert.equal(a.mobile.notificationKey, b.mobile.notificationKey);
    assert.notEqual(a.mobile.notificationKey, c.mobile.notificationKey);
  });
});

describe("DM", () => {
  test("desktop and push: the title is the sender, the body the bare text; category and kind dm", () => {
    const built = buildNotification(messageContext({ conversation: DM }), DM_RECEIVER, FULL);
    assertWellFormed(built);
    assert.equal(built.envelope.title, "Alice");
    assert.equal(built.envelope.subtitle, "Acme");
    assert.equal(built.envelope.body, "hello there");
    assert.equal(built.envelope.kind, "dm");
    assert.equal(built.envelope.category, "dm");
    assert.equal(built.envelope.priority, "high");
    assert.equal(built.push.title, "Alice");
    assert.equal(built.push.subtitle, "Acme");
    assert.equal(built.push.body, "hello there");
    assert.equal(built.push.messagePreview, "hello there");
    assert.equal(built.push.channelName, null);
    assert.equal(built.mobile.kind, "dm");
    assert.equal(built.mobile.threadIdentifier, "srv-1:dm-1");
    assert.deepEqual(built.route, { type: "dm", serverId: "srv-1", channelId: "dm-1", messageId: "m-1" });
    assert.equal(built.routeUrl, "/s/acme/dm/dm-1?msg=m-1");
  });
});

describe("thread reply", () => {
  test("in a channel: `Thread in #general`, thread route, its own APNs stack on mobile", () => {
    const conversation: NotificationConversation = { surface: "thread", threadChannelId: "thr-1", parent: PARENT_CHANNEL, parentMessageId: "pm-1" };
    const built = buildNotification(messageContext({ conversation, messageId: "m-9", seq: 3 }), THREAD_RECEIVER, FULL);
    assertWellFormed(built);
    assert.equal(built.envelope.title, "Thread in #general");
    assert.equal(built.envelope.body, "Alice: hello there");
    assert.equal(built.envelope.kind, "thread");
    assert.equal(built.envelope.category, "thread");
    assert.equal(built.envelope.priority, "normal");
    assert.equal(built.envelope.seq, 3);
    assert.equal(built.envelope.conversationId, "thr-1");
    assert.equal(built.envelope.groupKey, "srv-1:thr-1");
    assert.equal(built.envelope.channelId, "thr-1");
    assert.equal(built.envelope.threadId, "thr-1");
    assert.equal(built.envelope.parentChannelId, "ch-1");
    assert.equal(built.envelope.parentMessageId, "pm-1");
    assert.deepEqual(built.route, {
      type: "thread",
      serverId: "srv-1",
      parentChannelId: "ch-1",
      parentChannelType: "channel",
      parentMessageId: "pm-1",
      messageId: "m-9",
    });
    assert.equal(built.push.title, "Thread in #general");
    assert.equal(built.push.subtitle, "Acme");
    assert.equal(built.push.channelName, "general");
    assert.equal(built.push.parentChannelKind, "channel");
    assert.equal(built.mobile.kind, "thread");
    assert.equal(built.mobile.channelId, "thr-1");
    assert.equal(built.mobile.threadId, "thr-1");
    assert.equal(built.mobile.parentChannelId, "ch-1");
    assert.equal(built.mobile.parentMessageId, "pm-1");
    // One APNs stack per thread; groupKey / notificationKey are unchanged.
    assert.equal(built.mobile.threadIdentifier, "srv-1:thr-1");
  });

  test("in a DM: `Thread in DM`, parentChannelType dm", () => {
    const conversation: NotificationConversation = { surface: "thread", threadChannelId: "thr-2", parent: PARENT_DM, parentMessageId: "pm-2" };
    const built = buildNotification(messageContext({ conversation }), THREAD_RECEIVER, FULL);
    assertWellFormed(built);
    assert.equal(built.envelope.title, "Thread in DM");
    assert.equal(built.push.title, "Thread in DM");
    assert.equal(built.push.channelName, null);
    assert.equal(built.push.parentChannelKind, "dm");
    assert.equal(built.route?.type, "thread");
    assert.equal(built.route?.type === "thread" && built.route.parentChannelType, "dm");
    assert.equal(built.mobile.threadIdentifier, "srv-1:thr-2");
    assert.equal(built.envelope.groupKey, "srv-1:thr-2");
  });

  test("a joint thread without a visible parent falls back to the thread channel", () => {
    const conversation: NotificationConversation = { surface: "thread", threadChannelId: "thr-3", parent: null, parentMessageId: null };
    const built = buildNotification(messageContext({ conversation }), THREAD_RECEIVER, FULL);
    assertWellFormed(built);
    assert.deepEqual(built.route, { type: "channel", serverId: "srv-1", channelId: "thr-3", messageId: "m-1" });
    assert.equal(built.envelope.title, "Thread");
    assert.equal(built.envelope.conversationId, "thr-3");
    assert.equal(built.mobile.threadIdentifier, "srv-1:thr-3");
    assert.equal(built.mobile.parentChannelId, undefined);
  });
});

describe("task conversation", () => {
  const conversation: NotificationConversation = {
    surface: "task",
    conversationChannelId: "tc-1",
    parent: PARENT_CHANNEL,
    taskId: "task-1",
    task: { number: 7, title: "Ship it" },
    anchorMessageId: "anchor-1",
  };

  test("target is the task, the legacy route the parent channel; mobile opens the parent at the anchor", () => {
    const built = buildNotification(messageContext({ conversation, messageId: "m-5", seq: 4 }), THREAD_RECEIVER, FULL);
    assertWellFormed(built);
    assert.deepEqual(built.route, {
      type: "task",
      serverId: "srv-1",
      parentChannelId: "ch-1",
      parentChannelType: "channel",
      taskId: "task-1",
      messageId: "m-5",
    });
    assert.deepEqual(built.envelope.target, built.route);
    assert.equal(built.envelope.route.type, "channel");
    assert.equal(built.envelope.route.type === "channel" && built.envelope.route.channelId, "ch-1");
    assert.equal(new URL(built.routeUrl, "https://raft.test").searchParams.get("task"), "ch-1:task:task-1");
    assert.ok(built.routeUrl.startsWith("/s/acme/channel/ch-1?"));
    assert.equal(built.envelope.title, "#7 Ship it");
    assert.equal(built.envelope.subtitle, "#general · Acme");
    assert.equal(built.envelope.body, "Alice: hello there");
    assert.equal(built.push.title, "#7 Ship it");
    assert.equal(built.push.subtitle, "#general · Acme");
    assert.equal(built.push.body, "Alice: hello there");
    assert.equal(built.envelope.kind, "thread");
    assert.equal(built.envelope.conversationId, "tc-1");
    assert.equal(built.envelope.groupKey, "srv-1:tc-1");
    assert.equal(built.envelope.channelId, "ch-1");
    assert.equal(built.envelope.seq, 4);
    assert.equal(built.mobile.channelId, "ch-1");
    assert.equal(built.mobile.messageId, "anchor-1");
    assert.equal(built.mobile.taskId, "task-1");
    assert.equal(built.mobile.taskConversationChannelId, "tc-1");
    assert.equal(built.mobile.taskMessageId, "m-5");
    assert.equal(built.mobile.kind, "channel");
    assert.equal(built.mobile.threadIdentifier, "srv-1:ch-1");
  });

  test("a task conversation in a DM", () => {
    const built = buildNotification(messageContext({ conversation: { ...conversation, parent: PARENT_DM } }), THREAD_RECEIVER, FULL);
    assertWellFormed(built);
    assert.equal(built.envelope.title, "#7 Ship it");
    assert.equal(built.envelope.subtitle, "DM · Acme");
    assert.equal(built.push.title, "#7 Ship it");
    assert.equal(built.route?.type === "task" && built.route.parentChannelType, "dm");
    assert.equal(built.envelope.route.type, "dm");
    assert.equal(built.mobile.kind, "dm");
  });

  test("single-server receiver: the parent label alone is the subtitle", () => {
    const built = buildNotification(messageContext({ conversation }), { ...THREAD_RECEIVER, multiServer: false }, FULL);
    assert.equal(built.envelope.title, "#7 Ship it");
    assert.equal(built.envelope.subtitle, "#general");
    assert.equal(built.push.title, "#7 Ship it");
    assert.equal(built.push.subtitle, "#general");
    assert.equal(built.push.serverName, "Acme", "serverName stays for clients");
  });

  test("a task that could not be loaded keeps the old label", () => {
    const channel = buildNotification(messageContext({ conversation: { ...conversation, task: null } }), THREAD_RECEIVER, FULL);
    assert.equal(channel.envelope.title, "Task in #general");
    assert.equal(channel.envelope.subtitle, "Acme");
    assert.equal(channel.push.title, "Task in #general");
    const dm = buildNotification(messageContext({ conversation: { ...conversation, parent: PARENT_DM, task: null } }), THREAD_RECEIVER, FULL);
    assert.equal(dm.envelope.title, "Task in DM");
    const orphan = buildNotification(messageContext({ conversation: { ...conversation, parent: null, task: null } }), { ...THREAD_RECEIVER, multiServer: false }, FULL);
    assert.equal(orphan.envelope.title, "Task");
    assert.equal(orphan.envelope.subtitle, undefined);
  });

  test("sender_only: the task title is content, the parent label stands in", () => {
    const secret = { ...conversation, task: { number: 7, title: "Hushproject" } };
    const multi = buildNotification(messageContext({ conversation: secret }), THREAD_RECEIVER, { previewMode: "sender_only", sound: true });
    assert.equal(JSON.stringify(multi).includes("Hushproject"), false);
    assert.equal(multi.envelope.title, "#general");
    assert.equal(multi.envelope.subtitle, "Acme");
    assert.equal(multi.push.title, "#general");
    assert.equal(multi.push.subtitle, "Acme");
    assert.equal(multi.push.body, "Alice sent a message");
    const single = buildNotification(messageContext({ conversation: secret }), { ...THREAD_RECEIVER, multiServer: false }, { previewMode: "sender_only", sound: true });
    assert.equal(single.envelope.title, "#general");
    assert.equal(single.envelope.subtitle, undefined);
    assert.equal(single.push.subtitle, undefined);
    const orphan = buildNotification(messageContext({ conversation: { ...secret, parent: null } }), THREAD_RECEIVER, { previewMode: "sender_only", sound: true });
    assert.equal(orphan.envelope.title, "Task");
    assert.equal(JSON.stringify(orphan).includes("Hushproject"), false);
  });
});

// ---------------------------------------------------------------------------
// Server label: only for receivers in 2+ servers
// ---------------------------------------------------------------------------

describe("server label by the receiver's server count", () => {
  const single = (receiver: NotificationReceiver): NotificationReceiver => ({ ...receiver, multiServer: false });
  const multi = (receiver: NotificationReceiver): NotificationReceiver => ({ ...receiver, multiServer: true });

  test("channel: single-server has no subtitle; multi-server has the server subtitle; titles never carry the server", () => {
    const one = buildNotification(messageContext({ conversation: CHANNEL }), single(CHANNEL_RECEIVER), FULL);
    assertWellFormed(one);
    assert.equal(one.envelope.title, "#general");
    assert.equal(one.envelope.subtitle, undefined);
    assert.equal("subtitle" in one.envelope, false);
    assert.equal(one.envelope.serverName, "Acme", "envelope.serverName stays");
    assert.equal(one.push.title, "#general");
    assert.equal(one.push.subtitle, undefined);
    assert.equal("subtitle" in one.push, false);
    assert.equal(one.push.serverName, "Acme", "push.serverName stays");
    assert.equal(one.push.body, "Alice: hello there");

    const many = buildNotification(messageContext({ conversation: CHANNEL }), multi(CHANNEL_RECEIVER), FULL);
    assert.equal(many.envelope.title, "#general");
    assert.equal(many.envelope.subtitle, "Acme");
    assert.equal(many.push.title, "#general");
    assert.equal(many.push.subtitle, "Acme");
  });

  test("DM, thread, agent and reminder follow the same rule", () => {
    const thread: NotificationConversation = { surface: "thread", threadChannelId: "thr-1", parent: PARENT_CHANNEL, parentMessageId: "pm-1" };
    const agent = { type: "agent_attention" as const, event: "agent_action_required" as const, agent: { id: "ag-1", name: "Ferris" } };
    const reminder = noticeContext("reminder:r:1", {
      title: "Reminder", body: "Check the build", kind: "reminder", event: "reminder_fired",
      route: { type: "agent", serverId: "srv-1", agentId: "ag-1" }, groupKey: "srv-1:reminder",
    });
    const cases: Array<{ name: string; build: (receiver: (r: NotificationReceiver) => NotificationReceiver) => BuiltNotification; title: string }> = [
      { name: "dm", build: (r) => buildNotification(messageContext({ conversation: DM }), r(DM_RECEIVER), FULL), title: "Alice" },
      { name: "thread", build: (r) => buildNotification(messageContext({ conversation: thread }), r(THREAD_RECEIVER), FULL), title: "Thread in #general" },
      { name: "agent", build: (r) => buildNotification(messageContext({ conversation: DM, sender: SYSTEM_SENDER, notice: agent }), r({ category: "agent_attention", personal: true }), FULL), title: "Ferris needs your attention" },
      { name: "reminder", build: (r) => buildNotification(reminder, r({ category: "reminder", personal: true }), FULL), title: "Reminder" },
    ];
    for (const entry of cases) {
      const one = entry.build(single);
      assert.equal(one.envelope.title, entry.title, `${entry.name}: desktop title`);
      assert.equal(one.push.title, entry.title, `${entry.name}: push title`);
      assert.equal(one.envelope.subtitle, undefined, `${entry.name}: no desktop subtitle`);
      assert.equal(one.push.subtitle, undefined, `${entry.name}: no push subtitle`);
      assert.equal(one.push.serverName, "Acme", `${entry.name}: serverName kept`);
      const many = entry.build(multi);
      assert.equal(many.push.title, entry.title, `${entry.name}: no server suffix in the title`);
      assert.equal(many.envelope.subtitle, "Acme", `${entry.name}: desktop subtitle`);
      assert.equal(many.push.subtitle, "Acme", `${entry.name}: push subtitle`);
    }
  });

  test("task notices keep their parent label; the server is added for multi-server only", () => {
    const thread: NotificationConversation = { surface: "thread", threadChannelId: "thr-1", parent: PARENT_CHANNEL, parentMessageId: "pm-1" };
    const build = (multiServer: boolean) => buildNotification(
      messageContext({ conversation: thread, sender: SYSTEM_SENDER, notice: { type: "task_status", task: TASK } }),
      { category: "task_status", personal: true, multiServer },
      FULL,
    );
    assert.equal(build(false).envelope.subtitle, "#general");
    assert.equal(build(false).push.subtitle, "#general");
    assert.equal(build(false).push.title, "#12 Fix login");
    assert.equal(build(true).envelope.subtitle, "#general · Acme");
    assert.equal(build(true).push.subtitle, "#general · Acme");
  });

  test("hidden never carries a subtitle; sender_only keeps the server subtitle of a multi-server receiver", () => {
    const hidden = buildNotification(messageContext({ conversation: CHANNEL }), multi(CHANNEL_RECEIVER), { previewMode: "hidden", sound: true });
    assert.equal(hidden.envelope.subtitle, undefined);
    assert.equal(hidden.push.subtitle, undefined);
    const senderOnly = buildNotification(messageContext({ conversation: CHANNEL }), multi(CHANNEL_RECEIVER), { previewMode: "sender_only", sound: true });
    assert.equal(senderOnly.push.title, "#general");
    assert.equal(senderOnly.push.subtitle, "Acme");
  });
});

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

describe("task and agent notices", () => {
  test("task_status in a task thread: `#12 Fix login`, parent label subtitle, task replaceKey", () => {
    const conversation: NotificationConversation = { surface: "thread", threadChannelId: "thr-1", parent: PARENT_CHANNEL, parentMessageId: "pm-1" };
    const built = buildNotification(
      messageContext({ conversation, sender: SYSTEM_SENDER, content: "Ferris moved #12 to **In Review**", notice: { type: "task_status", task: TASK } }),
      { category: "task_status", personal: true },
      FULL,
    );
    assertWellFormed(built);
    assert.equal(built.envelope.title, "#12 Fix login");
    assert.equal(built.envelope.subtitle, "#general · Acme");
    assert.equal(built.envelope.body, "Ferris moved #12 to In Review");
    assert.equal(built.envelope.kind, "task");
    assert.equal(built.envelope.event, "task_status");
    assert.equal(built.envelope.replaceKey, "srv-1:task:task-1");
    assert.deepEqual(built.envelope.task, TASK);
    assert.deepEqual(built.envelope.sender, { id: "system", type: "system", name: "Raft" });
    assert.equal(built.envelope.priority, "high");
    assert.equal(built.push.title, "#12 Fix login");
    assert.equal(built.push.subtitle, "#general · Acme");
    assert.equal(built.push.senderName, "Raft");
    assert.equal(built.push.senderId, undefined);
  });

  test("task_status of a DM parent and of a follower", () => {
    const conversation: NotificationConversation = { surface: "thread", threadChannelId: "thr-2", parent: PARENT_DM, parentMessageId: "pm-2" };
    const built = buildNotification(
      messageContext({ conversation, sender: SYSTEM_SENDER, notice: { type: "task_status", task: TASK } }),
      { category: "task_status", personal: false },
      FULL,
    );
    assertWellFormed(built);
    assert.equal(built.envelope.subtitle, "DM · Acme");
    assert.equal(built.envelope.priority, "normal");
    assert.equal(built.envelope.mentioned, false);
  });

  test("task_assigned: `#12 Fix login`, the system text as body", () => {
    const built = buildNotification(
      messageContext({ conversation: CHANNEL, sender: SYSTEM_SENDER, content: "#12 Fix login was assigned to you", notice: { type: "task_assigned", task: TASK } }),
      { category: "task_assigned", personal: true },
      FULL,
    );
    assertWellFormed(built);
    assert.equal(built.envelope.title, "#12 Fix login");
    assert.equal(built.envelope.body, "#12 Fix login was assigned to you");
    assert.equal(built.push.body, "#12 Fix login was assigned to you");
    assert.equal(built.envelope.subtitle, "#general · Acme");
    assert.equal(built.envelope.event, "task_assigned");
    assert.equal(built.envelope.kind, "task");
    assert.equal(built.envelope.replaceKey, undefined);
    assert.deepEqual(built.envelope.task, TASK);
    assert.equal(built.push.title, "#12 Fix login");
    assert.equal(built.push.subtitle, "#general · Acme");
  });

  test("task_assigned without a loadable task keeps `Assigned to you`", () => {
    const built = buildNotification(
      messageContext({ conversation: CHANNEL, sender: SYSTEM_SENDER, content: "A task was assigned to you", notice: { type: "task_assigned", task: null } }),
      { category: "task_assigned", personal: true, multiServer: false },
      FULL,
    );
    assert.equal(built.envelope.title, "Assigned to you");
    assert.equal(built.envelope.subtitle, "#general");
    assert.equal(built.push.title, "Assigned to you");
    assert.equal(built.push.subtitle, "#general");
  });

  test("task notices under sender_only: the parent label replaces the task title", () => {
    const thread: NotificationConversation = { surface: "thread", threadChannelId: "thr-1", parent: PARENT_CHANNEL, parentMessageId: "pm-1" };
    const secretTask = { ...TASK, title: "Hushproject" };
    const status = buildNotification(
      messageContext({ conversation: thread, sender: SYSTEM_SENDER, notice: { type: "task_status", task: secretTask } }),
      { category: "task_status", personal: true },
      { previewMode: "sender_only", sound: true },
    );
    assert.equal(JSON.stringify(status).includes("Hushproject"), false);
    assert.equal(status.envelope.title, "#general");
    assert.equal(status.envelope.subtitle, "Acme");
    assert.equal(status.push.title, "#general");
    assert.equal(status.push.body, "Raft: task update");
    const assigned = buildNotification(
      messageContext({ conversation: DM, sender: SYSTEM_SENDER, notice: { type: "task_assigned", task: secretTask } }),
      { category: "task_assigned", personal: true, multiServer: false },
      { previewMode: "sender_only", sound: true },
    );
    assert.equal(JSON.stringify(assigned).includes("Hushproject"), false);
    assert.equal(assigned.envelope.title, "DM");
    assert.equal(assigned.envelope.subtitle, undefined);
  });

  test("agent_attention: `<agent> needs your attention`, first line of the body", () => {
    const agent = { id: "ag-1", name: "Ferris" };
    const content = "\nPlease approve the deploy\nsecond line";
    const required = buildNotification(
      messageContext({ conversation: DM, sender: SYSTEM_SENDER, content, notice: { type: "agent_attention", event: "agent_action_required", agent } }),
      { category: "agent_attention", personal: true },
      FULL,
    );
    assertWellFormed(required);
    assert.equal(required.envelope.title, "Ferris needs your attention");
    assert.equal(required.envelope.subtitle, "Acme");
    assert.equal(required.envelope.body, "Please approve the deploy");
    assert.equal(required.envelope.kind, "agent");
    assert.equal(required.envelope.event, "agent_action_required");
    assert.deepEqual(required.envelope.agent, agent);
    assert.equal(required.push.title, "Ferris needs your attention");
    assert.equal(required.push.subtitle, "Acme");
    assert.equal(required.push.body, "Please approve the deploy");
  });
});

describe("notice events without a message", () => {
  test("reminder: agent route, reminder group, eventKey id, no seq / conversation", () => {
    const eventKey = desktopNotificationReminderId("rem-1", "2026-01-15T12:00:00.000Z");
    const built = buildNotification(noticeContext(eventKey, {
      title: "Reminder",
      body: "Check the build",
      kind: "reminder",
      event: "reminder_fired",
      route: { type: "agent", serverId: "srv-1", agentId: "ag-1" },
      groupKey: desktopNotificationReminderGroupKey("srv-1"),
    }), { category: "reminder", personal: true }, FULL);
    assertWellFormed(built);
    assert.equal(built.envelope.id, eventKey);
    assert.equal(built.envelope.title, "Reminder");
    assert.equal(built.envelope.subtitle, "Acme");
    assert.equal(built.envelope.body, "Check the build");
    assert.equal(built.envelope.kind, "reminder");
    assert.equal(built.envelope.event, "reminder_fired");
    assert.equal(built.envelope.groupKey, "srv-1:reminder");
    assert.equal(built.envelope.seq, null);
    assert.equal(built.envelope.conversationId, null);
    assert.equal(built.envelope.messageId, null);
    assert.equal(built.envelope.sender, null);
    assert.equal(built.envelope.priority, "high");
    assert.deepEqual(built.route, { type: "agent", serverId: "srv-1", agentId: "ag-1" });
    assert.equal(built.routeUrl, "/s/acme/agent/ag-1");
    assert.equal(built.push.title, "Reminder");
    assert.equal(built.push.subtitle, "Acme");
    assert.equal(built.push.body, "Check the build");
    assert.equal(built.push.senderName, "Raft");
    assert.equal(built.mobile.channelId, null);
    assert.equal(built.mobile.threadIdentifier, "srv-1:reminder");
  });

  test("system_notice: `<server>:notice` group key by default, no conversation identity, agent field", () => {
    const agent = { id: "ag-1", name: "Ferris" };
    const built = buildNotification(noticeContext("migration:mig-1", {
      title: "Confirm moving Ferris to the cloud",
      body: "Ferris is paused until you confirm.",
      kind: "agent",
      event: "system_notice",
      route: { type: "agent", serverId: "srv-1", agentId: "ag-1" },
      agent,
    }), { category: "system_notice", personal: true }, FULL);
    assertWellFormed(built);
    assert.equal(built.envelope.id, "migration:mig-1");
    assert.equal(built.envelope.event, "system_notice");
    assert.equal(built.envelope.category, "system_notice");
    assert.equal(built.envelope.groupKey, "srv-1:notice");
    assert.equal(built.envelope.conversationId, null);
    assert.equal(built.envelope.seq, null);
    assert.equal(built.mobile.kind, null);
    assert.equal(built.mobile.channelId, null);
    assert.deepEqual(built.envelope.agent, agent);
    assert.equal(built.envelope.title, "Confirm moving Ferris to the cloud");
  });
});

// ---------------------------------------------------------------------------
// Preview redaction, sound
// ---------------------------------------------------------------------------

const SECRET = "zebraquokka";

function secretMessage(mode: NotificationPreviewMode, receiver: NotificationReceiver): BuiltNotification {
  return buildNotification(
    messageContext({ conversation: { surface: "channel", channelId: "ch-1", channelName: "hushroom" }, content: `the ${SECRET} launch code`, server: { id: "srv-1", name: "Hushco", slug: "acme" }, sender: { id: "u-mal", type: "user", name: "Mallory" } }),
    receiver,
    { previewMode: mode, sound: true },
  );
}

describe("preview redaction", () => {
  test("full keeps everything and has no localization", () => {
    const built = secretMessage("full", CHANNEL_RECEIVER);
    assert.ok(JSON.stringify(built).includes(SECRET));
    assert.equal(built.push.localization, undefined);
    assert.equal(built.envelope.previewMode, "full");
  });

  test("sender_only keeps the title and sender, replaces the body (message)", () => {
    const built = secretMessage("sender_only", CHANNEL_RECEIVER);
    assertWellFormed(built);
    assert.equal(JSON.stringify(built).includes(SECRET), false, "no message text anywhere");
    assert.equal(built.envelope.previewMode, "sender_only");
    assert.equal(built.envelope.title, "#hushroom");
    assert.equal(built.envelope.subtitle, "Hushco");
    assert.equal(built.envelope.body, "Mallory sent a message");
    assert.equal(built.envelope.serverName, "Hushco");
    assert.deepEqual(built.envelope.sender, { id: "u-mal", type: "user", name: "Mallory" });
    assert.equal(built.push.title, "#hushroom");
    assert.equal(built.push.subtitle, "Hushco");
    assert.equal(built.push.body, "Mallory sent a message");
    assert.equal(built.push.messagePreview, "Mallory sent a message");
    assert.equal(built.push.serverName, "Hushco");
    assert.equal(built.push.channelName, "hushroom");
    assert.equal(built.push.senderName, "Mallory");
    assert.deepEqual(built.push.localization, { bodyKey: NOTIFICATION_PREVIEW_KEYS.senderOnlyMessage, bodyArgs: ["Mallory"] });
    assert.equal(NOTIFICATION_PREVIEW_KEYS.senderOnlyMessage, "push.preview.sender_only.message");
  });

  test("sender_only (mention)", () => {
    const built = secretMessage("sender_only", MENTION_RECEIVER);
    assert.equal(JSON.stringify(built).includes(SECRET), false);
    assert.equal(built.envelope.body, "Mallory mentioned you");
    assert.equal(built.push.body, "Mallory mentioned you");
    assert.deepEqual(built.push.localization, { bodyKey: "push.preview.sender_only.mention", bodyArgs: ["Mallory"] });
  });

  test("hidden replaces title and body and drops channel, server and sender", () => {
    const built = secretMessage("hidden", CHANNEL_RECEIVER);
    assertWellFormed(built);
    const json = JSON.stringify(built);
    for (const word of [SECRET, "hushroom", "Hushco", "Mallory"]) assert.equal(json.includes(word), false, `${word} is not in the hidden payload`);
    assert.equal(built.envelope.previewMode, "hidden");
    assert.equal(built.envelope.title, "Raft");
    assert.equal(built.envelope.subtitle, undefined);
    assert.equal(built.envelope.body, "You have a new message");
    assert.equal(built.envelope.serverName, "");
    assert.equal(built.envelope.sender, null);
    assert.equal(built.push.title, "Raft");
    assert.equal(built.push.subtitle, undefined);
    assert.equal(built.push.body, "You have a new message");
    assert.equal(built.push.messagePreview, "You have a new message");
    assert.equal("serverName" in built.push, false);
    assert.equal(built.push.channelName, null);
    assert.equal(built.push.senderName, undefined);
    assert.equal(built.push.senderId, undefined);
    assert.equal(built.push.senderType, undefined);
    assert.deepEqual(built.push.localization, {
      titleKey: "push.preview.hidden.title",
      bodyKey: "push.preview.hidden.message",
      bodyArgs: [],
    });
  });

  test("hidden (mention)", () => {
    const built = secretMessage("hidden", MENTION_RECEIVER);
    assert.equal(JSON.stringify(built).includes(SECRET), false);
    assert.equal(built.envelope.body, "You were mentioned");
    assert.deepEqual(built.push.localization, {
      titleKey: "push.preview.hidden.title",
      bodyKey: "push.preview.hidden.mention",
      bodyArgs: [],
    });
  });

  test("a thread reply in a DM under hidden carries no text", () => {
    const conversation: NotificationConversation = { surface: "thread", threadChannelId: "thr-2", parent: { id: "dm-1", type: "dm", name: "hushroom" }, parentMessageId: "pm-2" };
    const built = buildNotification(messageContext({ conversation, content: SECRET, sender: { id: "u-mal", type: "agent", name: "Mallory" } }), THREAD_RECEIVER, { previewMode: "hidden", sound: true });
    const json = JSON.stringify(built);
    for (const word of [SECRET, "hushroom", "Mallory"]) assert.equal(json.includes(word), false, word);
  });

  for (const mode of ["sender_only", "hidden"] as const) {
    test(`${mode}: task, agent and reminder notices carry no body text`, () => {
      const thread: NotificationConversation = { surface: "thread", threadChannelId: "thr-1", parent: PARENT_CHANNEL, parentMessageId: "pm-1" };
      const notices = [
        buildNotification(
          messageContext({ conversation: thread, sender: SYSTEM_SENDER, content: `moved ${SECRET}`, notice: { type: "task_status", task: TASK } }),
          { category: "task_status", personal: true },
          { previewMode: mode, sound: true },
        ),
        buildNotification(
          messageContext({ conversation: DM, sender: SYSTEM_SENDER, content: `asks ${SECRET}`, notice: { type: "agent_attention", event: "agent_action_required", agent: { id: "ag-1", name: "Ferris" } } }),
          { category: "agent_attention", personal: true },
          { previewMode: mode, sound: true },
        ),
        buildNotification(noticeContext("reminder:r:1", {
          title: "Reminder",
          body: `remember ${SECRET}`,
          kind: "reminder",
          event: "reminder_fired",
          route: { type: "agent", serverId: "srv-1", agentId: "ag-1" },
          groupKey: "srv-1:reminder",
        }), { category: "reminder", personal: true }, { previewMode: mode, sound: true }),
      ];
      for (const built of notices) {
        assertWellFormed(built);
        assert.equal(JSON.stringify(built).includes(SECRET), false, `${built.envelope.event}: no body text`);
      }
    });
  }

  test("hidden drops task and agent names; the system sender stays", () => {
    const thread: NotificationConversation = { surface: "thread", threadChannelId: "thr-1", parent: PARENT_CHANNEL, parentMessageId: "pm-1" };
    const task = buildNotification(
      messageContext({ conversation: thread, sender: SYSTEM_SENDER, notice: { type: "task_status", task: { ...TASK, title: "Hushproject" } } }),
      { category: "task_status", personal: true },
      { previewMode: "hidden", sound: true },
    );
    assert.equal(JSON.stringify(task).includes("Hushproject"), false);
    assert.equal(task.envelope.task, undefined);
    assert.equal(task.envelope.title, "Raft");
    assert.deepEqual(task.envelope.sender, { id: "system", type: "system", name: "Raft" });

    const agent = buildNotification(
      messageContext({ conversation: DM, sender: SYSTEM_SENDER, notice: { type: "agent_attention", event: "agent_action_required", agent: { id: "ag-1", name: "Hushbot" } } }),
      { category: "agent_attention", personal: true },
      { previewMode: "hidden", sound: true },
    );
    assert.equal(JSON.stringify(agent).includes("Hushbot"), false);
    assert.equal(agent.envelope.agent, undefined);

    const notice = buildNotification(noticeContext("migration:m", {
      title: "Confirm moving Hushbot",
      body: "Hushbot is paused",
      kind: "agent",
      event: "system_notice",
      route: { type: "agent", serverId: "srv-1", agentId: "ag-1" },
      agent: { id: "ag-1", name: "Hushbot" },
    }), { category: "system_notice", personal: true }, { previewMode: "hidden", sound: true });
    assert.equal(JSON.stringify(notice).includes("Hushbot"), false);
  });
});

describe("preview wording per category", () => {
  test("a DM is not a mention in any mode", () => {
    const dm = (mode: NotificationPreviewMode) => buildNotification(messageContext({ conversation: DM, content: "hi" }), DM_RECEIVER, { previewMode: mode, sound: true });
    const full = dm("full");
    assert.equal(full.envelope.title, "Alice");
    assert.equal(full.envelope.body, "hi");
    assert.equal(full.envelope.mentioned, false);
    assert.equal(full.envelope.kind, "dm");
    assert.equal(full.envelope.priority, "high");
    assert.equal(full.push.title, "Alice");
    assert.equal(full.push.body, "hi");
    assert.equal(full.push.messagePreview, "hi");
    assert.equal(full.push.mentioned, false);
    assert.equal(full.push.localization, undefined);

    const senderOnly = dm("sender_only");
    assert.equal(senderOnly.envelope.title, "Alice");
    assert.equal(senderOnly.envelope.body, "Alice sent a message");
    assert.equal(senderOnly.envelope.mentioned, false);
    assert.equal(senderOnly.push.title, "Alice", "the sender is not content");
    assert.equal(senderOnly.push.body, "Alice sent a message");
    assert.deepEqual(senderOnly.push.localization, { bodyKey: "push.preview.sender_only.message", bodyArgs: ["Alice"] });

    const hidden = dm("hidden");
    assert.equal(hidden.envelope.title, "Raft");
    assert.equal(hidden.envelope.body, "You have a new message");
    assert.equal(hidden.envelope.mentioned, false);
    assert.equal(hidden.push.title, "Raft");
    assert.equal(hidden.push.body, "You have a new message");
    assert.deepEqual(hidden.push.localization, { titleKey: "push.preview.hidden.title", bodyKey: "push.preview.hidden.message", bodyArgs: [] });
  });

  test("an @mention in a DM keeps kind dm and the DM text style; mentioned is set", () => {
    const built = buildNotification(messageContext({ conversation: DM, content: "hi" }), MENTION_RECEIVER, FULL);
    assert.equal(built.envelope.kind, "dm");
    assert.equal(built.envelope.mentioned, true);
    assert.equal(built.push.mentioned, true);
    assert.equal(built.envelope.title, "Alice");
    assert.equal(built.envelope.body, "hi");
    assert.equal(built.push.title, "Alice");
    assert.equal(built.push.body, "hi");
    assert.equal(buildNotification(messageContext({ conversation: DM, content: "hi" }), MENTION_RECEIVER, { previewMode: "sender_only", sound: true }).push.body, "Alice mentioned you");
  });

  test("an @mention in a followed thread is a mention in every mode", () => {
    const conversation: NotificationConversation = { surface: "thread", threadChannelId: "thr-1", parent: PARENT_CHANNEL, parentMessageId: "pm-1" };
    const build = (mode: NotificationPreviewMode) => buildNotification(messageContext({ conversation, content: "hi" }), MENTION_RECEIVER, { previewMode: mode, sound: true });
    const full = build("full");
    assert.equal(full.envelope.kind, "mention");
    assert.equal(full.envelope.mentioned, true);
    assert.equal(full.envelope.priority, "high");
    assert.equal(full.envelope.body, "Alice: hi");
    assert.equal(full.push.body, "Alice: hi");
    assert.deepEqual(build("sender_only").push.localization, {
      titleKey: "push.title.thread_in_channel",
      titleArgs: ["general"],
      bodyKey: "push.preview.sender_only.mention",
      bodyArgs: ["Alice"],
    });
    assert.equal(build("sender_only").envelope.body, "Alice mentioned you");
    assert.deepEqual(build("hidden").push.localization, { titleKey: "push.preview.hidden.title", bodyKey: "push.preview.hidden.mention", bodyArgs: [] });
    assert.equal(build("hidden").envelope.body, "You were mentioned");
  });

  const thread: NotificationConversation = { surface: "thread", threadChannelId: "thr-1", parent: PARENT_CHANNEL, parentMessageId: "pm-1" };
  const agentNotice = { type: "agent_attention" as const, event: "agent_action_required" as const, agent: { id: "ag-1", name: "Ferris" } };
  const notices: Array<{
    name: string;
    build: (mode: NotificationPreviewMode) => BuiltNotification;
    senderOnly: string;
    senderOnlyKey: string;
    /** sender_only keeps a title that is a fixed phrase, with its key. */
    senderOnlyTitle?: { titleKey: string; titleArgs?: string[] };
    hidden: string;
    hiddenKey: string;
  }> = [
    {
      name: "task_status (personal)",
      build: (mode) => buildNotification(messageContext({ conversation: thread, sender: SYSTEM_SENDER, notice: { type: "task_status", task: TASK } }), { category: "task_status", personal: true }, { previewMode: mode, sound: true }),
      senderOnly: "Raft: task update", senderOnlyKey: "push.preview.sender_only.task", hidden: "You have a task update", hiddenKey: "push.preview.hidden.task",
    },
    {
      name: "task_status (follower)",
      build: (mode) => buildNotification(messageContext({ conversation: thread, sender: SYSTEM_SENDER, notice: { type: "task_status", task: TASK } }), { category: "task_status", personal: false }, { previewMode: mode, sound: true }),
      senderOnly: "Raft: task update", senderOnlyKey: "push.preview.sender_only.task", hidden: "You have a task update", hiddenKey: "push.preview.hidden.task",
    },
    {
      name: "task_assigned",
      build: (mode) => buildNotification(messageContext({ conversation: CHANNEL, sender: SYSTEM_SENDER, notice: { type: "task_assigned", task: TASK } }), { category: "task_assigned", personal: true }, { previewMode: mode, sound: true }),
      senderOnly: "Raft: task update", senderOnlyKey: "push.preview.sender_only.task", hidden: "You have a task update", hiddenKey: "push.preview.hidden.task",
    },
    {
      name: "agent_attention",
      build: (mode) => buildNotification(messageContext({ conversation: DM, sender: SYSTEM_SENDER, notice: agentNotice }), { category: "agent_attention", personal: true }, { previewMode: mode, sound: true }),
      senderOnly: "Raft needs your attention", senderOnlyKey: "push.preview.sender_only.agent", hidden: "An agent needs your attention", hiddenKey: "push.preview.hidden.agent",
      senderOnlyTitle: { titleKey: "push.title.agent_action_required", titleArgs: ["Ferris"] },
    },
    {
      name: "reminder",
      build: (mode) => buildNotification(noticeContext("reminder:r:1", {
        title: "Reminder", body: "Check the build", kind: "reminder", event: "reminder_fired",
        route: { type: "agent", serverId: "srv-1", agentId: "ag-1" }, groupKey: "srv-1:reminder",
      }), { category: "reminder", personal: true }, { previewMode: mode, sound: true }),
      senderOnly: "Raft: reminder", senderOnlyKey: "push.preview.sender_only.reminder", hidden: "A reminder is due", hiddenKey: "push.preview.hidden.reminder",
    },
    {
      name: "system_notice",
      build: (mode) => buildNotification(noticeContext("migration:m", {
        title: "Confirm moving Ferris", body: "Ferris is paused", kind: "agent", event: "system_notice",
        route: { type: "agent", serverId: "srv-1", agentId: "ag-1" },
      }), { category: "system_notice", personal: true }, { previewMode: mode, sound: true }),
      senderOnly: "Raft: new notice", senderOnlyKey: "push.preview.sender_only.notice", hidden: "You have a new notice", hiddenKey: "push.preview.hidden.notice",
    },
    {
      name: "test",
      build: (mode) => buildNotification(noticeContext("test:t1", {
        title: "Test notification", body: "It works", kind: "channel", event: "test",
        route: { type: "agent", serverId: "srv-1", agentId: "ag-1" },
      }), { category: "test", personal: false }, { previewMode: mode, sound: true }),
      senderOnly: "Raft: new notice", senderOnlyKey: "push.preview.sender_only.notice", hidden: "You have a new notice", hiddenKey: "push.preview.hidden.notice",
    },
  ];

  for (const notice of notices) {
    test(`${notice.name}: its own preview key and wording, never "mentioned"`, () => {
      for (const mode of ["full", "sender_only", "hidden"] as const) {
        const built = notice.build(mode);
        assert.equal(built.envelope.mentioned, false, `${mode}: envelope.mentioned`);
        assert.equal(built.push.mentioned, false, `${mode}: push.mentioned`);
        assert.equal(/mentioned/i.test(`${built.envelope.body} ${built.push.body} ${built.push.messagePreview ?? ""} ${built.push.localization?.bodyKey ?? ""}`), false, `${mode}: no mention wording`);
      }
      const senderOnly = notice.build("sender_only");
      assert.equal(senderOnly.envelope.body, notice.senderOnly);
      assert.equal(senderOnly.push.body, notice.senderOnly);
      assert.deepEqual(senderOnly.push.localization, { ...notice.senderOnlyTitle, bodyKey: notice.senderOnlyKey, bodyArgs: ["Raft"] });
      const hidden = notice.build("hidden");
      assert.equal(hidden.envelope.title, "Raft");
      assert.equal(hidden.envelope.body, notice.hidden);
      assert.equal(hidden.push.body, notice.hidden);
      assert.deepEqual(hidden.push.localization, { titleKey: "push.preview.hidden.title", bodyKey: notice.hiddenKey, bodyArgs: [] });
    });
  }

  test("personal categories keep priority high", () => {
    assert.equal(notices[0]!.build("full").envelope.priority, "high");
    assert.equal(notices[1]!.build("full").envelope.priority, "normal");
    for (const notice of notices.slice(2, 6)) assert.equal(notice.build("full").envelope.priority, "high", notice.name);
  });

  test("every key is exported in NOTIFICATION_PREVIEW_KEYS", () => {
    const keys = new Set(Object.values(NOTIFICATION_PREVIEW_KEYS));
    for (const notice of notices) {
      assert.ok(keys.has(notice.senderOnlyKey as never), notice.senderOnlyKey);
      assert.ok(keys.has(notice.hiddenKey as never), notice.hiddenKey);
    }
  });
});

// ---------------------------------------------------------------------------
// Localization keys of the fixed phrases (contract §1.5)
// ---------------------------------------------------------------------------

describe("localization keys", () => {
  const threadIn = (parent: typeof PARENT_CHANNEL | typeof PARENT_DM | null): NotificationConversation => (
    { surface: "thread", threadChannelId: "thr-1", parent, parentMessageId: parent ? "pm-1" : null }
  );
  const taskConversation = (parent: typeof PARENT_CHANNEL | typeof PARENT_DM | null, task: { number: number; title: string } | null): NotificationConversation => (
    { surface: "task", conversationChannelId: "tc-1", parent, taskId: "task-1", task, anchorMessageId: null }
  );

  test("names, message text and `Sender: text` have no key", () => {
    for (const conversation of [CHANNEL, DM]) {
      const built = buildNotification(messageContext({ conversation }), conversation === DM ? DM_RECEIVER : CHANNEL_RECEIVER, FULL);
      assertWellFormed(built);
      assert.equal(built.push.localization, undefined, conversation.surface);
      assert.equal(built.envelope.localization, undefined, conversation.surface);
    }
    const task = buildNotification(messageContext({ conversation: taskConversation(PARENT_CHANNEL, { number: 7, title: "Ship it" }) }), THREAD_RECEIVER, FULL);
    assert.equal(task.push.localization, undefined, "`#7 Ship it` / `#general · Acme` are names");
  });

  test("thread titles", () => {
    const channel = buildNotification(messageContext({ conversation: threadIn(PARENT_CHANNEL) }), THREAD_RECEIVER, FULL);
    assertWellFormed(channel);
    assert.equal(channel.push.title, "Thread in #general");
    assert.deepEqual(channel.push.localization, { titleKey: "push.title.thread_in_channel", titleArgs: ["general"] });
    assert.deepEqual(channel.envelope.localization, channel.push.localization);
    const dm = buildNotification(messageContext({ conversation: threadIn(PARENT_DM) }), THREAD_RECEIVER, FULL);
    assert.deepEqual(dm.push.localization, { titleKey: "push.title.thread_in_dm" });
    const orphan = buildNotification(messageContext({ conversation: threadIn(null) }), THREAD_RECEIVER, FULL);
    assert.equal(orphan.push.title, "Thread");
    assert.deepEqual(orphan.push.localization, { titleKey: "push.title.thread" });
  });

  test("task conversation: the old labels when the task is unknown, the DM context in the subtitle", () => {
    const unknown = (parent: typeof PARENT_CHANNEL | typeof PARENT_DM | null) => buildNotification(messageContext({ conversation: taskConversation(parent, null) }), THREAD_RECEIVER, FULL);
    assert.deepEqual(unknown(PARENT_CHANNEL).push.localization, { titleKey: "push.title.task_in_channel", titleArgs: ["general"] });
    assert.deepEqual(unknown(PARENT_DM).push.localization, { titleKey: "push.title.task_in_dm" });
    assert.deepEqual(unknown(null).push.localization, { titleKey: "push.title.task" });

    const dmTask = taskConversation(PARENT_DM, { number: 7, title: "Ship it" });
    const many = buildNotification(messageContext({ conversation: dmTask }), { ...THREAD_RECEIVER, multiServer: true }, FULL);
    assertWellFormed(many);
    assert.equal(many.push.subtitle, "DM · Acme");
    assert.deepEqual(many.push.localization, { subtitleKey: "push.subtitle.dm_server", subtitleArgs: ["Acme"] });
    const one = buildNotification(messageContext({ conversation: dmTask }), { ...THREAD_RECEIVER, multiServer: false }, FULL);
    assert.equal(one.push.subtitle, "DM");
    assert.deepEqual(one.push.localization, { subtitleKey: "push.subtitle.dm" });

    // sender_only: the parent label stands in for the task title, with its key.
    const redacted = buildNotification(messageContext({ conversation: dmTask }), { ...THREAD_RECEIVER, multiServer: true }, { previewMode: "sender_only", sound: true });
    assertWellFormed(redacted);
    assert.equal(redacted.push.title, "DM");
    assert.deepEqual(redacted.push.localization, { titleKey: "push.title.dm", bodyKey: "push.preview.sender_only.message", bodyArgs: ["Alice"] });
  });

  test("a body without text: the attachment / no-text phrase, with and without the sender", () => {
    const channel = buildNotification(messageContext({ conversation: CHANNEL, content: "", attachmentCount: 1 }), CHANNEL_RECEIVER, FULL);
    assertWellFormed(channel);
    assert.equal(channel.push.body, "Alice: Sent an attachment");
    assert.equal(channel.envelope.body, "Alice: Sent an attachment");
    assert.deepEqual(channel.push.localization, { bodyKey: "push.body.sender_attachment", bodyArgs: ["Alice"] });
    const several = buildNotification(messageContext({ conversation: CHANNEL, content: "", attachmentCount: 3 }), CHANNEL_RECEIVER, FULL);
    assert.equal(several.push.body, "Alice: Sent 3 attachments");
    assert.deepEqual(several.push.localization, { bodyKey: "push.body.sender_attachments", bodyArgs: ["Alice", "3"] });
    const dm = buildNotification(messageContext({ conversation: DM, content: "", attachmentCount: 3 }), DM_RECEIVER, FULL);
    assertWellFormed(dm);
    assert.equal(dm.push.body, "Sent 3 attachments");
    assert.deepEqual(dm.push.localization, { bodyKey: "push.body.attachments", bodyArgs: ["3"] });
    const empty = buildNotification(messageContext({ conversation: DM, content: "  " }), DM_RECEIVER, FULL);
    assert.equal(empty.push.body, "(no text)");
    assert.deepEqual(empty.push.localization, { bodyKey: "push.body.no_text", bodyArgs: [] });
    const withText = buildNotification(messageContext({ conversation: CHANNEL, content: "look", attachmentCount: 2 }), CHANNEL_RECEIVER, FULL);
    assert.equal(withText.push.localization, undefined, "text wins over the attachment phrase");
  });

  test("notice titles: agent attention, assigned to you, a DM conversation label", () => {
    const agent = { id: "ag-1", name: "Ferris" };
    const required = buildNotification(
      messageContext({ conversation: DM, sender: SYSTEM_SENDER, notice: { type: "agent_attention", event: "agent_action_required", agent } }),
      { category: "agent_attention", personal: true, multiServer: false },
      FULL,
    );
    assertWellFormed(required);
    assert.deepEqual(required.push.localization, { titleKey: "push.title.agent_action_required", titleArgs: ["Ferris"] });

    const assigned = buildNotification(
      messageContext({ conversation: CHANNEL, sender: SYSTEM_SENDER, notice: { type: "task_assigned", task: null } }),
      { category: "task_assigned", personal: true, multiServer: false },
      FULL,
    );
    assertWellFormed(assigned);
    assert.deepEqual(assigned.push.localization, { titleKey: "push.title.task_assigned" });

    const statusInDm = buildNotification(
      messageContext({ conversation: threadIn(PARENT_DM), sender: SYSTEM_SENDER, notice: { type: "task_status", task: TASK } }),
      { category: "task_status", personal: true, multiServer: true },
      FULL,
    );
    assertWellFormed(statusInDm);
    assert.equal(statusInDm.push.title, "#12 Fix login");
    assert.deepEqual(statusInDm.push.localization, { subtitleKey: "push.subtitle.dm_server", subtitleArgs: ["Acme"] });
  });

  test("a notice payload's stored key travels while it still renders the stored English", () => {
    const payload: NotificationNoticePayload = {
      title: formatNotificationCopy("push.title.agent_migration_review", ["Ferris"]),
      titleKey: "push.title.agent_migration_review",
      titleArgs: ["Ferris"],
      body: formatNotificationCopy("push.body.agent_migration_review", ["Ferris"]),
      bodyKey: "push.body.agent_migration_review",
      bodyArgs: ["Ferris"],
      kind: "agent",
      event: "system_notice",
      route: { type: "agent", serverId: "srv-1", agentId: "ag-1" },
    };
    const built = buildNotification(noticeContext("migration:m", payload), { category: "system_notice", personal: true, multiServer: false }, FULL);
    assertWellFormed(built);
    assert.equal(built.push.title, "Confirm moving Ferris to the cloud");
    assert.deepEqual(built.push.localization, {
      titleKey: "push.title.agent_migration_review",
      titleArgs: ["Ferris"],
      bodyKey: "push.body.agent_migration_review",
      bodyArgs: ["Ferris"],
    });

    // A row written before the template changed (or by a bad writer) keeps its English, without the key.
    const stale = buildNotification(
      noticeContext("migration:m2", { ...payload, title: "Confirm moving Ferris", body: "Ferris waits", titleKey: "push.title.reminder" }),
      { category: "system_notice", personal: true, multiServer: false },
      FULL,
    );
    assert.equal(stale.push.title, "Confirm moving Ferris");
    assert.equal(stale.push.localization, undefined);
    const unknownKey = buildNotification(
      noticeContext("migration:m3", { ...payload, titleKey: "push.title.nope" as never }),
      { category: "system_notice", personal: true, multiServer: false },
      FULL,
    );
    assert.deepEqual(unknownKey.push.localization, { bodyKey: "push.body.agent_migration_review", bodyArgs: ["Ferris"] });
  });

  test("hidden replaces every key with the hidden pair", () => {
    const built = buildNotification(messageContext({ conversation: threadIn(PARENT_DM), content: "", attachmentCount: 1 }), THREAD_RECEIVER, { previewMode: "hidden", sound: true });
    assertWellFormed(built);
    assert.deepEqual(built.push.localization, { titleKey: "push.preview.hidden.title", bodyKey: "push.preview.hidden.message", bodyArgs: [] });
  });
});

describe("sound", () => {
  test("silent is the inverse of the sound setting", () => {
    assert.equal(buildNotification(messageContext({ conversation: CHANNEL }), CHANNEL_RECEIVER, { previewMode: "full", sound: false }).envelope.silent, true);
    assert.equal(buildNotification(messageContext({ conversation: CHANNEL }), CHANNEL_RECEIVER, { previewMode: "full", sound: true }).envelope.silent, false);
  });
});
