// GET /api/messages/channel/:id/human-outline: the conversation outline's page.
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { messages, users } from "../db/schema";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { addMember, createServer } from "../services/serverService";
import { addHuman, createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";

const test = createApiTest();

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

test("human-outline: only what people wrote, newest first, plain text, paged by seq; members only", async ({ app }) => {
  const owner = await seedUser("outline-owner@slock.test", "outline-owner");
  const stranger = await seedUser("outline-stranger@slock.test", "outline-stranger");
  const server = await createServer("Outline", "outline", owner.id);
  await addMember(server.id, stranger.id, "member");
  const channel = await createChannel(server.id, "outline", "outline channel", "private");
  await addHuman(channel.id, owner.id);

  const first = await createMessage(channel.id, "user", owner.id, "**first** message");
  await createMessage(channel.id, "agent", owner.id, "an agent's reply");
  await createMessage(channel.id, "user", "system", "a system line", "system");
  const delegated = await createMessage(channel.id, "user", owner.id, "my assistant wrote this");
  await getDb().update(messages).set({ delegatedByAgentId: owner.id }).where(eq(messages.id, delegated.id));
  const second = await createMessage(channel.id, "user", owner.id, `second\nmessage ${"x".repeat(500)}`);

  const read = (token: string, query = "") => fetch(`${app.baseUrl}/api/messages/channel/${channel.id}/human-outline${query}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
  });
  const ownerToken = await tokenForHuman(owner.email);

  const all = await (await read(ownerToken)).json() as {
    items: Array<{ id: string; seq: number; senderName: string; preview: string; attachmentCount: number }>;
    hasMore: boolean;
  };
  assert.deepEqual(all.items.map((item) => item.id), [second.id, first.id]);
  assert.equal(all.hasMore, false);
  assert.equal(all.items[1]!.preview, "first message", "the preview is plain text");
  assert.equal(all.items[1]!.senderName, "outline-owner");
  assert.equal(all.items[1]!.attachmentCount, 0);
  assert.match(all.items[0]!.preview, /^second message x+$/);
  assert.equal(all.items[0]!.preview.length, 400);

  const newest = await (await read(ownerToken, "?limit=1")).json() as typeof all;
  assert.deepEqual(newest.items.map((item) => item.id), [second.id]);
  assert.equal(newest.hasMore, true);
  const older = await (await read(ownerToken, `?limit=1&before=${newest.items[0]!.seq}`)).json() as typeof all;
  assert.deepEqual(older.items.map((item) => item.id), [first.id]);
  assert.equal(older.hasMore, false);

  assert.equal((await read(ownerToken, "?before=nope")).status, 400);
  assert.equal((await read(ownerToken, "?limit=1.5")).status, 200, "a limit is read as a whole number");
  assert.equal((await read(await tokenForHuman(stranger.email))).status, 404, "a private channel's outline is its members'");
});

test("human-outline of a thread: what people wrote, then the message it started from, whoever wrote it; a retraction leaves", async ({ app }) => {
  const owner = await seedUser("outline-thread@slock.test", "outline-thread");
  const server = await createServer("Outline thread", "outline-thread", owner.id);
  const channel = await createChannel(server.id, "outline-thread", "outline thread channel", "private");
  await addHuman(channel.id, owner.id);

  const parent = await createMessage(channel.id, "agent", owner.id, "an agent started this run");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  const asked = await createMessage(thread.id, "user", owner.id, "what about **this**?");
  await createMessage(thread.id, "agent", owner.id, "working on it");
  const retracted = await createMessage(thread.id, "user", owner.id, "never mind");
  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, retracted.id));

  const res = await fetch(`${app.baseUrl}/api/messages/channel/${thread.id}/human-outline`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id },
  });
  assert.equal(res.status, 200);
  const page = await res.json() as { items: Array<{ id: string; preview: string }>; hasMore: boolean };
  assert.deepEqual(page.items.map((item) => item.id), [asked.id, parent.id], "people's messages newest first, then the thread's first message; not the agent's reply, not the retraction");
  assert.equal(page.items[0]!.preview, "what about this?");
  assert.equal(page.hasMore, false);
});
