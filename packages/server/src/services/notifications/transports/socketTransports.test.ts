import assert from "node:assert/strict";
import type { Server as SocketServer } from "socket.io";
import { emitDesktopNotification } from "./desktopSocket";
import { emitMobileNotification, mobileSocketPayload } from "./mobileSocket";
import { CHANNEL_ID, MESSAGE_ID, PARENT_MESSAGE_ID, SERVER_ID, THREAD_ID, channelNotification, threadMentionNotification } from "./testFixtures";

function fakeIo() {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const io = {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          emitted.push({ room, event, payload });
          return true;
        },
      };
    },
  } as unknown as SocketServer;
  return { io, emitted };
}

test("desktop notifications go to the user's desktop sockets only", () => {
  const { io, emitted } = fakeIo();
  const { envelope } = channelNotification();
  emitDesktopNotification(io, "user-1", envelope);
  assert.deepEqual(emitted, [{ room: "user:user-1:clientKind:desktop", event: "notification:desktop", payload: envelope }]);
});

test("notification:push goes to the user's mobile sockets only", () => {
  const { io, emitted } = fakeIo();
  const payload = mobileSocketPayload(channelNotification(), "https://app.raft.build");
  emitMobileNotification(io, "user-1", payload);
  assert.deepEqual(emitted, [{ room: "user:user-1:clientKind:mobile", event: "notification:push", payload }]);
});

test("the mobile socket payload keeps the existing fields and adds the envelope fields", () => {
  const built = channelNotification();
  assert.deepEqual(mobileSocketPayload(built, "https://app.raft.build"), {
    // Today's app does not know `subtitle`: the context joins the title.
    title: "#general · Acme",
    subtitle: "Acme",
    body: "Alice: hello",
    tag: `message:${MESSAGE_ID}`,
    url: `https://app.raft.build/s/acme/channel/${CHANNEL_ID}?msg=${MESSAGE_ID}`,
    serverName: "Acme",
    channelName: "general",
    parentChannelKind: null,
    senderId: "alice",
    senderType: "user",
    senderName: "Alice",
    messagePreview: "hello",
    mentioned: false,
    serverId: SERVER_ID,
    kind: "channel",
    channelId: CHANNEL_ID,
    threadId: null,
    parentChannelId: null,
    parentMessageId: null,
    messageId: MESSAGE_ID,
    id: `message:${MESSAGE_ID}`,
    category: "channel",
    priority: "normal",
    seq: 7,
    groupKey: `${SERVER_ID}:${CHANNEL_ID}`,
    conversationId: CHANNEL_ID,
    route: built.route,
    routeUrl: built.routeUrl,
    silent: false,
    previewMode: "full",
  });
});

test("a thread reply carries its identity; hidden previews drop the server name; testId is set when given", () => {
  const thread = mobileSocketPayload(threadMentionNotification(), "https://app.raft.build");
  assert.equal(thread.kind, "thread");
  assert.equal(thread.channelId, THREAD_ID);
  assert.equal(thread.threadId, THREAD_ID);
  assert.equal(thread.parentChannelId, CHANNEL_ID);
  assert.equal(thread.parentMessageId, PARENT_MESSAGE_ID);
  assert.equal(thread.mentioned, true);
  assert.equal(thread.category, "mention");
  assert.equal(thread.priority, "high");
  assert.equal(thread.route?.type, "thread");

  const hidden = mobileSocketPayload(channelNotification({
    envelope: { previewMode: "hidden", silent: true },
    push: { title: "Raft", subtitle: undefined, body: "You have a new message", serverName: undefined, senderName: undefined, messagePreview: undefined },
  }), "https://app.raft.build", { testId: "t-1" });
  assert.equal("serverName" in hidden, false);
  assert.equal("subtitle" in hidden, false);
  assert.equal("senderName" in hidden, false);
  assert.equal("messagePreview" in hidden, false);
  assert.equal(hidden.previewMode, "hidden");
  assert.equal(hidden.silent, true);
  assert.equal(hidden.testId, "t-1");
  assert.equal(JSON.stringify(hidden).includes("hello"), false);
});

test("phoneAlert tells a tray-posting app (GMS-less Android) whether the plan alerts the phone; absent when not given", () => {
  assert.equal(mobileSocketPayload(channelNotification(), "https://app.raft.build", { phoneAlert: false }).phoneAlert, false);
  assert.equal(mobileSocketPayload(channelNotification(), "https://app.raft.build", { phoneAlert: true }).phoneAlert, true);
  assert.equal("phoneAlert" in mobileSocketPayload(channelNotification(), "https://app.raft.build"), false, "older apps see the payload unchanged");
});

test("the mobile socket payload carries every localization key (additive; no key set gating on the socket)", () => {
  const localization = { titleKey: "push.title.thread_in_channel", titleArgs: ["general"], bodyKey: "push.body.sender_attachment", bodyArgs: ["Alice"] };
  const payload = mobileSocketPayload(channelNotification({
    push: { title: "Thread in #general", body: "Alice: Sent an attachment", localization },
  }), "https://app.raft.build");
  assert.deepEqual(payload.localization, localization);
  assert.equal(payload.title, "Thread in #general · Acme", "the English title still joins the context");
  assert.equal("localization" in mobileSocketPayload(channelNotification(), "https://app.raft.build"), false);
});
