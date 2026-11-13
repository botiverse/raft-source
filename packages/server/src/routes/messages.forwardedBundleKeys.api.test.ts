import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { insertAttachmentsWithObjects } from "../test/attachmentObjectFixture";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Every key of a forward a client is served, at each level, is listed in
 * shared FORWARDED_BUNDLE_*_KEYS with what the mobile App's V2 does with it
 * (#proj-apps:#40): in the forward's own answer, in the history read (by the
 * forwarder, and by a member who cannot see one source) and in the realtime
 * message. The forwards come from a public channel (one message with a
 * file), a task conversation, a thread and a private channel, so together
 * they serve every listed key.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import {
  FORWARDED_BUNDLE_ATTACHMENT_KEYS,
  FORWARDED_BUNDLE_AUTHOR_KEYS,
  FORWARDED_BUNDLE_ITEM_KEYS,
  FORWARDED_BUNDLE_METADATA_KEYS,
  FORWARDED_BUNDLE_TARGET_KEYS,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { servers, serverMembers, users } from "../db/schema";
import { addHuman, createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import { createTasks } from "../services/taskService";
import { ensureTaskConversation, getTaskConversation } from "../services/taskConversationService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type Emitted = { room: string; event: string; payload: { actionMetadata?: Record<string, unknown> } };

function installFakeIo(app: { app: { set(key: string, value: unknown): void } }): Emitted[] {
  const events: Emitted[] = [];
  const joiner = (room: string) => ({
    socketsJoin() {
      events.push({ room, event: "socketsJoin", payload: {} });
    },
  });
  app.app.set("io", {
    to(room: string) {
      return { emit(event: string, payload: unknown) { events.push({ room, event, payload: payload as Emitted["payload"] }); } };
    },
    in(room: string) {
      return { ...joiner(room), in: () => joiner(room) };
    },
  });
  return events;
}

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 6)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  return user!;
}

function headers(token: string, serverId: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Server-Id": serverId };
}

const LISTED = {
  root: FORWARDED_BUNDLE_METADATA_KEYS,
  item: FORWARDED_BUNDLE_ITEM_KEYS,
  author: FORWARDED_BUNDLE_AUTHOR_KEYS,
  target: FORWARDED_BUNDLE_TARGET_KEYS,
  attachment: FORWARDED_BUNDLE_ATTACHMENT_KEYS,
};
type Level = keyof typeof LISTED;

/** The keys of one served forward, by level. */
function servedKeys(metadata: unknown, into: Record<Level, Set<string>>) {
  const add = (level: Level, value: unknown) => {
    assert.ok(value && typeof value === "object", `${level} is an object`);
    for (const key of Object.keys(value)) into[level].add(key);
  };
  add("root", metadata);
  for (const item of (metadata as { forwardedItems: Array<Record<string, unknown>> }).forwardedItems) {
    add("item", item);
    add("author", item.sourceAuthorSnapshot);
    add("target", item.sourceTargetSnapshot);
    for (const attachment of item.attachmentSnapshots as unknown[]) add("attachment", attachment);
  }
}

test("every key of a served forward, at each level, is listed in FORWARDED_BUNDLE_*_KEYS", async ({ app }) => {
  const events = installFakeIo(app);
  const db = getDb();
  const owner = await seedUser("fwdkeys-owner");
  const member = await seedUser("fwdkeys-member");
  const server = await createServer("Forward keys", `fwdkeys-${randomUUID().slice(0, 8)}`, owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" }).onConflictDoNothing();
  const source = await createChannel(server.id, `fwdkeys-source-${randomUUID().slice(0, 6)}`);
  const destination = await createChannel(server.id, `fwdkeys-dest-${randomUUID().slice(0, 6)}`);
  const secret = await createChannel(server.id, `fwdkeys-secret-${randomUUID().slice(0, 6)}`, undefined, "private");
  for (const channel of [source, destination, secret]) await addHuman(channel.id, owner.id);
  await addHuman(destination.id, member.id);
  await enableTaskV2ConversationsForServer(server.id);

  const plain = await createMessage(source.id, "user", owner.id, "plain");
  const withFile = await createMessage(source.id, "user", owner.id, "with a file");
  await insertAttachmentsWithObjects(db, {
    messageId: withFile.id, channelId: source.id, uploaderId: owner.id, uploaderType: "user",
    filename: "keys.png", storageKey: `fwdkeys/${randomUUID()}.png`, mimeType: "image/png", sizeBytes: 10, width: 4, height: 3,
  });
  const created = await createTasks(source.id, "user", owner.id, [{ title: "keys task" }], { initiatingServerId: server.id });
  await ensureTaskConversation(created.tasks[0]!.id, { initiatingServerId: server.id, createdByUserId: owner.id });
  const taskReply = await createMessage((await getTaskConversation(created.tasks[0]!.id))!.canonicalChannelId, "user", owner.id, "task reply");
  const threadParent = await createMessage(source.id, "user", owner.id, "thread parent");
  const thread = await getOrCreateThread(threadParent.id, owner.id, "user");
  const threadReply = await createMessage(thread.id, "user", owner.id, "thread reply");
  const secretMessage = await createMessage(secret.id, "user", owner.id, "secret");

  const ownerToken = await tokenForHuman(owner.email);
  const answers: Record<Level, Set<string>> = { root: new Set(), item: new Set(), author: new Set(), target: new Set(), attachment: new Set() };
  for (const sourceMessageIds of [[plain.id, withFile.id], [taskReply.id], [threadReply.id], [secretMessage.id]]) {
    const res = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ destinationChannelId: destination.id, sourceMessageIds, note: "", requestId: randomUUID() }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    servedKeys((await res.json() as { actionMetadata: unknown }).actionMetadata, answers);
  }

  const read = async (token: string) => {
    const res = await fetch(`${app.baseUrl}/api/messages/channel/${destination.id}?limit=50`, { headers: headers(token, server.id) });
    assert.equal(res.status, 200, await res.clone().text());
    const keys: Record<Level, Set<string>> = { root: new Set(), item: new Set(), author: new Set(), target: new Set(), attachment: new Set() };
    const forwards = (await res.json() as { messages: Array<{ actionMetadata?: { kind?: string } }> }).messages
      .filter((message) => message.actionMetadata?.kind === "forwarded-bundle");
    assert.equal(forwards.length, 4);
    for (const message of forwards) servedKeys(message.actionMetadata, keys);
    return keys;
  };
  const byForwarder = await read(ownerToken);
  const byMember = await read(await tokenForHuman(member.email));

  const realtime: Record<Level, Set<string>> = { root: new Set(), item: new Set(), author: new Set(), target: new Set(), attachment: new Set() };
  const emitted = events.filter((event) => event.event === "message:new" && event.payload.actionMetadata?.kind === "forwarded-bundle");
  assert.equal(emitted.length, 4);
  for (const event of emitted) servedKeys(event.payload.actionMetadata, realtime);

  for (const [served, keysByLevel] of Object.entries({ answers, byForwarder, byMember, realtime })) {
    for (const level of Object.keys(LISTED) as Level[]) {
      for (const key of keysByLevel[level]) assert.ok(Object.hasOwn(LISTED[level], key), `${served}: unlisted forwarded-bundle ${level} key: ${key}`);
    }
  }
  // And these forwards serve every listed key, so none goes unchecked.
  for (const level of Object.keys(LISTED) as Level[]) {
    assert.deepEqual([...byForwarder[level]].sort(), Object.keys(LISTED[level]).sort(), `${level} keys the forwarder reads`);
  }
});
