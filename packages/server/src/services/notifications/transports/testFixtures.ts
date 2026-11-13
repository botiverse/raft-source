/** Hand-built BuiltNotification fixtures for the transport tests. */
import { buildNotification } from "../envelope";
import type { BuiltNotification } from "../types";

export const SERVER_ID = "11111111-1111-4111-8111-111111111111";
export const CHANNEL_ID = "22222222-2222-4222-8222-222222222222";
export const THREAD_ID = "33333333-3333-4333-8333-333333333333";
export const PARENT_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
export const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";

/** A channel message in #general, full preview, to a receiver in 2+ servers (server label as subtitle). */
export function channelNotification(overrides: {
  envelope?: Partial<BuiltNotification["envelope"]>;
  push?: Partial<BuiltNotification["push"]>;
  mobile?: Partial<BuiltNotification["mobile"]>;
} = {}): BuiltNotification {
  const route = { type: "channel" as const, serverId: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID };
  const routeUrl = `/s/acme/channel/${CHANNEL_ID}?msg=${MESSAGE_ID}`;
  return {
    envelope: {
      v: 1,
      id: `message:${MESSAGE_ID}`,
      kind: "channel",
      event: "message",
      title: "#general",
      subtitle: "Acme",
      body: "Alice: hello",
      serverId: SERVER_ID,
      serverName: "Acme",
      channelId: CHANNEL_ID,
      threadId: null,
      parentChannelId: null,
      parentMessageId: null,
      messageId: MESSAGE_ID,
      mentioned: false,
      sender: { id: "alice", type: "user", name: "Alice" },
      url: routeUrl,
      route,
      groupKey: `${SERVER_ID}:${CHANNEL_ID}`,
      createdAt: "2026-10-30T10:00:00.000Z",
      category: "channel",
      priority: "normal",
      seq: 7,
      conversationId: CHANNEL_ID,
      silent: false,
      previewMode: "full",
      ...overrides.envelope,
    },
    push: {
      title: "#general",
      subtitle: "Acme",
      body: "Alice: hello",
      serverName: "Acme",
      channelName: "general",
      parentChannelKind: null,
      senderId: "alice",
      senderType: "user",
      senderName: "Alice",
      messagePreview: "hello",
      mentioned: false,
      ...overrides.push,
    },
    mobile: {
      serverId: SERVER_ID,
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      kind: "channel",
      threadIdentifier: `${SERVER_ID}:${CHANNEL_ID}`,
      notificationKey: "conversation-key",
      ...overrides.mobile,
    },
    route,
    routeUrl,
  };
}

/** A reply in a thread of #general that mentions the receiver. */
export function threadMentionNotification(): BuiltNotification {
  const route = {
    type: "thread" as const,
    serverId: SERVER_ID,
    parentChannelId: CHANNEL_ID,
    parentChannelType: "channel" as const,
    parentMessageId: PARENT_MESSAGE_ID,
    messageId: MESSAGE_ID,
  };
  const built = channelNotification({
    envelope: {
      kind: "mention",
      title: "Thread in #general",
      body: "Alice: hi @Bob",
      channelId: THREAD_ID,
      threadId: THREAD_ID,
      parentChannelId: CHANNEL_ID,
      parentMessageId: PARENT_MESSAGE_ID,
      mentioned: true,
      route,
      groupKey: `${SERVER_ID}:${THREAD_ID}`,
      category: "mention",
      priority: "high",
      seq: 3,
      conversationId: THREAD_ID,
    },
    push: { title: "Thread in #general", body: "Alice: hi @Bob", mentioned: true, messagePreview: "hi @Bob" },
    mobile: {
      channelId: THREAD_ID,
      threadId: THREAD_ID,
      parentChannelId: CHANNEL_ID,
      parentMessageId: PARENT_MESSAGE_ID,
      kind: "thread",
      threadIdentifier: `${SERVER_ID}:${THREAD_ID}`,
    },
  });
  const routeUrl = `/s/acme/channel/${CHANNEL_ID}?thread=${CHANNEL_ID}%3A${PARENT_MESSAGE_ID}&msg=${MESSAGE_ID}`;
  return { ...built, envelope: { ...built.envelope, url: routeUrl }, route, routeUrl };
}

/**
 * The largest notification the envelope renders: a task notice with a long
 * CJK task title and a CJK body at the 512-character notice bound (3 bytes a
 * character), in a long-named channel and server. Its Web Push payload was
 * over 6 KB before the budget.
 */
export function oversizedTaskNotification(): BuiltNotification {
  return buildNotification({
    type: "message",
    eventKey: `message:${MESSAGE_ID}`,
    server: { id: SERVER_ID, name: "服".repeat(100), slug: "acme" },
    message: {
      id: MESSAGE_ID,
      seq: 9,
      createdAt: new Date("2026-10-31T05:13:28.000Z"),
      content: "漢字".repeat(2_000),
      attachmentCount: 0,
      sender: { id: "system", type: "system", name: "Raft" },
    },
    conversation: {
      surface: "task",
      conversationChannelId: THREAD_ID,
      parent: { id: CHANNEL_ID, type: "channel", name: "频".repeat(80) },
      taskId: PARENT_MESSAGE_ID,
      task: { number: 12, title: "任务".repeat(400) },
      anchorMessageId: MESSAGE_ID,
    },
    notice: { type: "task_status", task: { id: PARENT_MESSAGE_ID, number: 12, title: "任务".repeat(400), status: "done" } },
  }, { category: "task_status", personal: true }, { previewMode: "full", sound: true });
}
