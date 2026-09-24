import assert from "node:assert/strict";
import { test } from "vitest";
import { randomUUID } from "node:crypto";

import {
  buildNativeTargetUri,
  resolveNotificationIntents,
} from "./nativeNotificationService.js";

test("native projection preserves the authoritative recipient set and strips web-only fields", () => {
  const serverId = randomUUID();
  const channelId = randomUUID();
  const messageId = randomUUID();
  const createdAt = new Date("2026-07-22T00:00:00.000Z");
  const targets = [
    {
      userId: randomUUID(),
      payload: { title: "#general", body: "hello", tag: "message:web-only", url: "/web-only", alwaysShow: true },
      identity: { serverId, kind: "channel" as const, channelId, threadId: null, parentChannelId: null, parentMessageId: null, messageId },
    },
    {
      userId: randomUUID(),
      payload: { title: "#general", body: "hello", tag: "message:web-only", url: "/web-only", alwaysShow: true },
      identity: { serverId, kind: "channel" as const, channelId, threadId: null, parentChannelId: null, parentMessageId: null, messageId },
    },
  ];

  const intents = resolveNotificationIntents(targets, createdAt);
  assert.deepEqual(intents.map((intent) => intent.recipientUserId), targets.map((target) => target.userId));
  assert.equal(intents.length, targets.length);
  for (const intent of intents) {
    assert.deepEqual(Object.keys(intent).sort(), [
      "body", "channelId", "createdAt", "eventKey", "kind", "messageId", "parentChannelId",
      "parentMessageId", "recipientUserId", "serverId", "threadId", "title",
    ]);
    assert.equal("url" in intent, false);
    assert.equal("tag" in intent, false);
    assert.equal("alwaysShow" in intent, false);
  }
});

test("canonical native target URIs are closed and ordered for channel, DM, and thread", () => {
  const serverId = randomUUID();
  const channelId = randomUUID();
  const threadId = randomUUID();
  const parentMessageId = randomUUID();
  const messageId = randomUUID();
  const base = {
    recipientUserId: randomUUID(),
    eventKey: "event",
    serverId,
    channelId,
    messageId,
    title: "title",
    body: "body",
    createdAt: new Date(),
  };

  assert.equal(buildNativeTargetUri({
    ...base,
    kind: "channel",
    threadId: null,
    parentChannelId: null,
    parentMessageId: null,
  }), `raft://v1/servers/${serverId}/channels/${channelId}/messages/${messageId}`);
  assert.equal(buildNativeTargetUri({
    ...base,
    kind: "dm",
    threadId: null,
    parentChannelId: null,
    parentMessageId: null,
  }), `raft://v1/servers/${serverId}/dms/${channelId}/messages/${messageId}`);
  assert.equal(buildNativeTargetUri({
    ...base,
    kind: "thread",
    channelId: threadId,
    threadId,
    parentChannelId: channelId,
    parentMessageId,
  }), `raft://v1/servers/${serverId}/channels/${channelId}/threads/${threadId}?parentMessageId=${parentMessageId}&messageId=${messageId}`);
});

test("native target URI rejects non-canonical IDs and incomplete thread identities", () => {
  const base = {
    recipientUserId: randomUUID(),
    eventKey: "event",
    serverId: randomUUID(),
    kind: "thread" as const,
    channelId: randomUUID(),
    threadId: randomUUID(),
    parentChannelId: null,
    parentMessageId: randomUUID(),
    messageId: randomUUID(),
    title: "title",
    body: "body",
    createdAt: new Date(),
  };
  assert.throws(() => buildNativeTargetUri(base), /incomplete/);
  assert.throws(() => buildNativeTargetUri({ ...base, kind: "channel", serverId: base.serverId.toUpperCase(), parentChannelId: null }), /non-canonical/);
});
