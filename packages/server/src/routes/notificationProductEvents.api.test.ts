// #proj-analytics:#17 (AndyLok, #proj-o11y:#16): which notification levels people choose,
// and how often they mute a conversation. Server facts: every client writes through these routes.
import assert from "node:assert/strict";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { addHuman, createChannel } from "../services/channelService";
import { PRODUCT_EVENT_SINK_APP_KEY } from "../services/productEventIngest";
import type { ProductEventRow, ProductEventSink } from "../services/productEventScopeDbWriter";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const EVENTS = new Set(["notification_level_changed", "conversation_mute_changed", "notification_settings_changed"]);

function memoryProductEventSink() {
  const rows: ProductEventRow[] = [];
  return {
    rows,
    sink: {
      enqueue(batch: readonly ProductEventRow[]) {
        rows.push(...batch.filter((row) => EVENTS.has(row.event)));
      },
      async flush() {},
    } satisfies ProductEventSink,
  };
}

/** The events are written after the response: wait for `count` rows, then a little longer for strays. */
async function settle(rows: readonly ProductEventRow[], count: number): Promise<void> {
  for (let i = 0; i < 200 && rows.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

function json(body: unknown): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

test("a level change is recorded with its scope and level, a no-op is not; a mute with its kind", async ({ app, http }) => {
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const owner = await seedUser("notif-events-owner");
  const member = await seedUser("notif-events-member");
  const server = await createServer("Notify events", "notif-events", owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const general = await createChannel(server.id, "notif-events-general");
  await addHuman(general.id, member.id);
  const put = (body: unknown) => http.as(member).request("/api/notification-levels", { method: "PUT", ...json(body) });

  assert.equal((await put({ scope: "server", id: server.id, level: "none" })).status, 200);
  assert.equal((await put({ scope: "channel", id: general.id, level: "all" })).status, 200);
  assert.equal((await put({ scope: "channel", id: general.id, level: "default" })).status, 200);
  assert.equal((await put({ scope: "channel", id: general.id, level: "default" })).status, 200, "a no-op");
  assert.equal((await put({ scope: "channel", id: general.id, level: "loud" })).status, 400);
  const mute = (activityMuted: boolean) => http.as(member, server).request(`/api/channels/${general.id}/notification-settings`, {
    method: "PATCH",
    ...json({ activityMuted }),
  });
  assert.equal((await mute(true)).status, 200);
  assert.equal((await mute(true)).status, 200, "already muted: a no-op");
  assert.equal((await mute(false)).status, 200);

  await settle(store.rows, 5);
  assert.deepEqual(store.rows.map((row) => [row.event, row.server_id, row.properties]), [
    ["notification_level_changed", server.id, { scope: "server", level: "none" }],
    ["notification_level_changed", server.id, { scope: "channel", level: "all" }],
    ["notification_level_changed", server.id, { scope: "channel", level: "default" }],
    ["conversation_mute_changed", server.id, { muted: true, kind: "channel" }],
    ["conversation_mute_changed", server.id, { muted: false, kind: "channel" }],
  ]);
  for (const row of store.rows) assert.equal(row.source, "server");
  assert.equal(JSON.stringify(store.rows).includes("notif-events-general"), false, "no channel name");
});

test("an account setting change is one event per setting, account level; a no-op, a refused or a stale write is none", async ({ app, http }) => {
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const person = await seedUser("notif-account-events");
  const patch = (body: unknown) => http.as(person).request("/api/me/notification-settings", { method: "PATCH", ...json(body) });
  const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

  assert.equal((await patch({ pausedUntil: inMinutes(60) })).status, 200);
  assert.equal((await patch({ pausedUntil: null })).status, 200);
  assert.equal((await patch({ quietHours: { enabled: true, startMinute: 1320, endMinute: 420, timeZone: "Asia/Shanghai" } })).status, 200);
  assert.equal((await patch({ quietHours: { enabled: true, startMinute: 1320, endMinute: 480, timeZone: "Asia/Shanghai" } })).status, 200);
  assert.equal((await patch({ previewMode: "sender_only", sound: false })).status, 200);
  assert.equal((await patch({ previewMode: "sender_only" })).status, 200, "a no-op");
  assert.equal((await patch({ mobileDelay: "always" })).status, 200);
  assert.equal((await patch({ previewMode: "everything" })).status, 400);
  assert.equal((await patch({ sound: true, version: 0 })).status, 409, "a stale version changes nothing");

  await settle(store.rows, 7);
  assert.deepEqual(store.rows.map((row) => [row.event, row.server_id, row.properties]), [
    ["notification_settings_changed", null, { setting: "pause", change: "on", pause_length: "45m_to_90m" }],
    ["notification_settings_changed", null, { setting: "pause", change: "off" }],
    ["notification_settings_changed", null, { setting: "quiet_hours", change: "on" }],
    ["notification_settings_changed", null, { setting: "quiet_hours", change: "edited" }],
    ["notification_settings_changed", null, { setting: "preview", preview: "sender_only" }],
    ["notification_settings_changed", null, { setting: "sound", change: "off" }],
    ["notification_settings_changed", null, { setting: "mobile_delay", mobile_delay: "always" }],
  ]);
  for (const row of store.rows) assert.equal(row.source, "server");
  assert.equal(JSON.stringify(store.rows).includes("Asia/Shanghai"), false, "no time zone");
});
