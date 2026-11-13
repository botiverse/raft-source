import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { getDb } from "../db/index";
import { eq } from "drizzle-orm";
import { messages, users } from "../db/schema";
import { createServer as createServerService } from "../services/serverService";
import { createChannel as createChannelService, addHuman } from "../services/channelService";
import { createMessage } from "../services/messageService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// task #17 (staging load speed): `searchText` / `searchVector` only feed the
// full-text index. The history HTTP reads used to SELECT every column, so a
// 50-message page shipped ~16KB of tsvector + search text — more than the
// message content itself. The realtime path already strips them; the HTTP
// reads must not send them either.

const STORAGE_ONLY_KEYS = ["searchText", "searchVector", "insertXid"] as const;

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

function assertNoStorageOnlyKeys(surface: string, rows: Array<Record<string, unknown>>) {
  assert.ok(rows.length > 0, `${surface} must return messages to examine`);
  for (const row of rows) {
    for (const key of STORAGE_ONLY_KEYS) {
      assert.equal(key in row, false, `${surface} must not serialize storage-only "${key}"`);
    }
  }
}

test("message history HTTP reads never serialize search-index columns", async ({ app }) => {
  const owner = await seedUser("storage-cols@slock.test", "storage-cols");
  const server = await createServerService("Storage Cols", "storage-cols", owner.id);
  const channel = await createChannelService(server.id, "storage-cols", "test channel");
  await addHuman(channel.id, owner.id);

  const first = await createMessage(channel.id, "user", owner.id, "searchable words for the index");
  await createMessage(channel.id, "user", owner.id, "another searchable message");

  const token = await tokenForHuman(owner.email);
  const get = async (path: string) => {
    const res = await fetch(`${app.baseUrl}${path}`, { headers: headers(token, server.id) });
    assert.equal(res.status, 200, `${path} must succeed`);
    return res.json() as Promise<Record<string, unknown>>;
  };

  const page = await get(`/api/messages/channel/${channel.id}?limit=50`);
  assertNoStorageOnlyKeys("channel page", page.messages as Array<Record<string, unknown>>);

  const context = await get(`/api/messages/context/${first.id}?channelId=${channel.id}`);
  assertNoStorageOnlyKeys("message context", context.messages as Array<Record<string, unknown>>);

  const sync = await get(`/api/messages/sync?since_seq=0&channel_id=${channel.id}`);
  assertNoStorageOnlyKeys("message sync", sync as unknown as Array<Record<string, unknown>>);
});

// Task #266: the web client reports its IANA zone on send. The route stores a
// valid zone and drops anything else to null without failing the send; the
// zone is agent-only, so no human-facing HTTP read or send response carries it.
test("web send records a valid sender time zone and never serializes it to human clients", async ({ app }) => {
  const owner = await seedUser("sender-tz@slock.test", "sender-tz");
  const server = await createServerService("Sender TZ", "sender-tz", owner.id);
  const channel = await createChannelService(server.id, "sender-tz", "test channel");
  await addHuman(channel.id, owner.id);
  const token = await tokenForHuman(owner.email);

  const send = async (path: "/api/v2/messages" | "/api/messages", content: string, timezone: unknown, omit = false) => {
    const res = await fetch(`${app.baseUrl}${path}`, {
      method: "POST",
      headers: headers(token, server.id),
      body: JSON.stringify({ channelId: channel.id, content, ...(omit ? {} : { timezone }) }),
    });
    assert.equal(res.status, 200, `${content}: an unusable zone must not fail the send`);
    const body = await res.json() as Record<string, unknown>;
    const message = (path === "/api/v2/messages" ? body.message : body) as Record<string, unknown>;
    assert.equal("senderTimezone" in message, false, `${content}: send response must not echo the zone`);
    assert.equal("insertXid" in message, false, `${content}: send response must not carry the inserting transaction id`);
    const [row] = await getDb().select({ senderTimezone: messages.senderTimezone })
      .from(messages).where(eq(messages.id, message.id as string));
    return row?.senderTimezone;
  };

  assert.equal(await send("/api/v2/messages", "valid v2", "Asia/Shanghai"), "Asia/Shanghai");
  assert.equal(await send("/api/messages", "valid v1", " Europe/Berlin "), "Europe/Berlin");
  assert.equal(await send("/api/v2/messages", "utc", "UTC"), "UTC");
  assert.equal(await send("/api/v2/messages", "unknown zone", "Mars/Olympus_Mons"), null);
  assert.equal(await send("/api/v2/messages", "abbreviation", "EST"), null);
  assert.equal(await send("/api/v2/messages", "offset", "+05:00"), null);
  assert.equal(await send("/api/v2/messages", "overlong", `Asia/${"x".repeat(200)}`), null);
  assert.equal(await send("/api/v2/messages", "non-string", 480), null);
  assert.equal(await send("/api/v2/messages", "null", null), null);
  assert.equal(await send("/api/v2/messages", "omitted", undefined, true), null);

  const get = async (path: string) => {
    const res = await fetch(`${app.baseUrl}${path}`, { headers: headers(token, server.id) });
    assert.equal(res.status, 200, `${path} must succeed`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const assertNoSenderTimezone = (surface: string, rows: Array<Record<string, unknown>>) => {
    assert.ok(rows.length > 0, `${surface} must return messages to examine`);
    for (const row of rows) assert.equal("senderTimezone" in row, false, `${surface} must not serialize senderTimezone`);
  };
  const page = await get(`/api/messages/channel/${channel.id}?limit=50`);
  const pageRows = page.messages as Array<Record<string, unknown>>;
  assertNoSenderTimezone("channel page", pageRows);
  const zoned = pageRows.find((row) => row.content === "valid v2")!;
  const context = await get(`/api/messages/context/${zoned.id}?channelId=${channel.id}`);
  assertNoSenderTimezone("message context", context.messages as Array<Record<string, unknown>>);
  const sync = await get(`/api/messages/sync?since_seq=0&channel_id=${channel.id}`);
  assertNoSenderTimezone("message sync", sync as unknown as Array<Record<string, unknown>>);
});
