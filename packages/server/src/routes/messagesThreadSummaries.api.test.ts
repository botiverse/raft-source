import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { addMember, createServer as createServerService } from "../services/serverService.js";
import { createChannel as createChannelService, getOrCreateThread, addHuman } from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// task #809 (inline replies cold path, feedback: reply blocks jumped on every
// channel entry): GET /api/messages/channel/:channelId now carries
// threadSummariesByParentMessageId for THIS page's parents in the SAME
// response — the client renders reply blocks synchronously with the messages
// and never needs a second async round-trip that patches layout later.

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



function headers(token: string, serverId: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
  };
}

type ThreadSummary = {
  replyCount: number;
  latestReplies?: Array<{ preview?: string; senderDisplayName?: string }>;
};

type MessagesPage = {
  messages: Array<{ id: string; content: string }>;
  threadSummariesByParentMessageId: Record<string, ThreadSummary>;
};

test("messages page carries thread summaries for its parents in the same response", async ({ app }) => {
  const owner = await seedUser("summary-owner@slock.test", "summary-owner");
  const server = await createServerService("Summary Server", "summary-server", owner.id);
  const channel = await createChannelService(server.id, "summaries", "test channel");
  await addHuman(channel.id, owner.id);

  const parent = await createMessage(channel.id, "user", owner.id, "parent with replies");
  const plain = await createMessage(channel.id, "user", owner.id, "plain message");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "first reply");
  await createMessage(thread.id, "user", owner.id, "second reply");

  const token = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}?limit=50`, {
    headers: headers(token, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as MessagesPage;

  // The summaries arrive in the SAME payload as the messages.
  assert.ok(
    body.threadSummariesByParentMessageId,
    "threadSummariesByParentMessageId must be present on the messages page response",
  );
  const summary = body.threadSummariesByParentMessageId[parent.id];
  assert.ok(summary, "the parent with a thread must have a summary keyed by its message id");
  assert.equal(summary.replyCount, 2, "summary reply count matches the thread's replies");
  assert.ok(
    (summary.latestReplies ?? []).some((reply) => reply.preview === "second reply"),
    "summary carries latest replies (preview text) for inline rendering",
  );

  // Messages without threads must not fabricate summary entries.
  assert.equal(
    body.threadSummariesByParentMessageId[plain.id],
    undefined,
    "plain messages have no summary entry",
  );

  // Every summary key must belong to a message in THIS page (query-bound
  // scope: no leakage from outside the page window).
  const pageIds = new Set(body.messages.map((message) => message.id));
  for (const key of Object.keys(body.threadSummariesByParentMessageId)) {
    assert.ok(pageIds.has(key), `summary key ${key} must reference a message in this page`);
  }
});

test("message context carries thread summaries for its window in the same response", async ({ app }) => {
  const owner = await seedUser("summary-context@slock.test", "summary-context");
  const server = await createServerService("Context Summary Server", "summary-context-server", owner.id);
  const channel = await createChannelService(server.id, "context-summaries", "test channel");
  await addHuman(channel.id, owner.id);

  const parent = await createMessage(channel.id, "user", owner.id, "context parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "context reply");

  const token = await tokenForHuman(owner.email);
  const res = await fetch(
    `${app.baseUrl}/api/messages/context/${parent.id}?channelId=${channel.id}`,
    { headers: headers(token, server.id) },
  );
  assert.equal(res.status, 200);
  const body = await res.json() as MessagesPage;
  const summary = body.threadSummariesByParentMessageId[parent.id];
  assert.ok(summary, "the focused parent must carry its summary in the context payload");
  assert.equal(summary.replyCount, 1);
  assert.ok(
    (summary.latestReplies ?? []).some((reply) => reply.preview === "context reply"),
    "the context payload carries the reply preview needed for its first committed frame",
  );

  const contextIds = new Set(body.messages.map((message) => message.id));
  for (const key of Object.keys(body.threadSummariesByParentMessageId)) {
    assert.ok(contextIds.has(key), `summary key ${key} must reference a message in this context window`);
  }
});

test("messages page returns an empty summary map when the page has no thread parents", async ({ app }) => {
  const owner = await seedUser("summary-empty@slock.test", "summary-empty");
  const server = await createServerService("Empty Summary Server", "summary-empty-server", owner.id);
  const channel = await createChannelService(server.id, "no-threads", "test channel");
  await addHuman(channel.id, owner.id);
  await createMessage(channel.id, "user", owner.id, "just a message");

  const token = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, {
    headers: headers(token, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as MessagesPage;
  assert.deepEqual(
    body.threadSummariesByParentMessageId,
    {},
    "no thread parents in the page yields an empty map, not a missing field",
  );
});

test("summary scope is bound to the requested page window", async ({ app }) => {
  const owner = await seedUser("summary-window@slock.test", "summary-window");
  const server = await createServerService("Window Server", "summary-window-server", owner.id);
  const channel = await createChannelService(server.id, "windowed", "test channel");
  await addHuman(channel.id, owner.id);

  // Older parent WITH a thread, then enough newer messages to push it out
  // of a limit=2 page.
  const oldParent = await createMessage(channel.id, "user", owner.id, "old parent");
  const oldThread = await getOrCreateThread(oldParent.id, owner.id, "user");
  await createMessage(oldThread.id, "user", owner.id, "old reply");
  await createMessage(channel.id, "user", owner.id, "newer one");
  await createMessage(channel.id, "user", owner.id, "newer two");

  const token = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}?limit=2`, {
    headers: headers(token, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as MessagesPage;
  assert.ok(
    !body.messages.some((message) => message.id === oldParent.id),
    "precondition: the old parent is outside this page window",
  );
  assert.equal(
    body.threadSummariesByParentMessageId[oldParent.id],
    undefined,
    "summaries must not leak parents from outside the requested page",
  );
});

test("channel access still gates the summaries-carrying page response", async ({ app }) => {
  const owner = await seedUser("summary-access@slock.test", "summary-access");
  const outsider = await seedUser("summary-outsider@slock.test", "summary-outsider");
  const server = await createServerService("Access Server", "summary-access-server", owner.id);
  await addMember(server.id, outsider.id);
  const channel = await createChannelService(server.id, "locked", "private channel", "private");
  await addHuman(channel.id, owner.id);
  const parent = await createMessage(channel.id, "user", owner.id, "secret parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "secret reply");

  const outsiderToken = await tokenForHuman(outsider.email);
  const res = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, {
    headers: headers(outsiderToken, server.id),
  });
  assert.ok(
    res.status === 403 || res.status === 404,
    `non-member must not receive the page (got ${res.status})`,
  );
});
