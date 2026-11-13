// Unified notification settings (docs/contracts/notifications.md §2):
// GET/PATCH /api/me/notification-settings, PUT/GET /api/notification-levels,
// the legacy server notification-settings route on the same write path, and
// the dispatcher's batched read.
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { inboxTargetMuteStates, serverMembers, threadFollows, userChannelNotificationPrefs, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { addHuman, createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { loadNotificationPolicyPrefs } from "../services/notifications/settings";
import { decide } from "../services/notifications/policy";
import { flushPendingRetractionsForTests, isNotificationReadThrough } from "../services/notifications/retraction";
import { installFakeIo } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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

async function seed(slug: string) {
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const outsider = await seedUser(`${slug}-outsider`);
  const server = await createServer("Notify", slug, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const general = await createChannel(server.id, `${slug}-general`);
  await addHuman(general.id, owner.id);
  await addHuman(general.id, member.id);
  const secret = await createChannel(server.id, `${slug}-secret`, undefined, "private");
  await addHuman(secret.id, owner.id);
  const parent = await createMessage(general.id, "user", owner.id, "parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  return { owner, member, outsider, server, general, secret, parent, thread };
}

function json(body: unknown): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function follow(threadId: string, userId: string) {
  const [row] = await getDb().select().from(threadFollows)
    .where(and(eq(threadFollows.threadChannelId, threadId), eq(threadFollows.followerType, "user"), eq(threadFollows.followerId, userId)));
  return row ?? null;
}

test("account settings read as the defaults, patch with optimistic versions, validate every field and sync", async ({ app, http }) => {
  const events = installFakeIo(app.app);
  const { member, server } = await seed("notif-account");
  const me = http.as(member);

  const initial = await me.get("/api/me/notification-settings");
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), {
    settings: {
      pausedUntil: null,
      quietHours: { enabled: false, startMinute: 1320, endMinute: 480, timeZone: "UTC" },
      previewMode: "full",
      sound: true,
      mobileDelay: "inactive",
      followedThreadReplies: true,
      version: 0,
    },
    servers: [{ serverId: server.id, level: "all" }],
  });

  for (const invalid of [
    { quietHours: { enabled: true, startMinute: 1440, endMinute: 480, timeZone: "UTC" } },
    { quietHours: { enabled: true, startMinute: 0, endMinute: 480, timeZone: "Mars/Olympus" } },
    { quietHours: { enabled: true, startMinute: 0, endMinute: 480 } },
    { pausedUntil: "2001-01-01T00:00:00.000Z" },
    { pausedUntil: "soon" },
    { previewMode: "blurred" },
    { sound: "yes" },
    { mobileDelay: "3m" },
    { mobileDelay: null },
    { followedThreadReplies: "false" },
    { followedThreadReplies: null },
    { version: -1 },
  ]) {
    const res = await me.request("/api/me/notification-settings", { method: "PATCH", ...json(invalid) });
    assert.equal(res.status, 400, JSON.stringify(invalid));
  }

  const pausedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const quietHours = { enabled: true, startMinute: 1320, endMinute: 420, timeZone: "Europe/Berlin" };
  const first = await me.request("/api/me/notification-settings", { method: "PATCH", ...json({ pausedUntil, quietHours, previewMode: "sender_only", sound: false, mobileDelay: "5m", version: 0 }) });
  assert.equal(first.status, 200, await first.clone().text());
  const settings = { pausedUntil, quietHours, previewMode: "sender_only", sound: false, mobileDelay: "5m", followedThreadReplies: true, version: 1 };
  assert.deepEqual(await first.json(), { settings });
  assert.deepEqual(events.at(-1), { room: `user:${member.id}`, event: "notification_prefs:updated", payload: { type: "account", settings } });

  const stale = await me.request("/api/me/notification-settings", { method: "PATCH", ...json({ sound: true, version: 0 }) });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "version_conflict", settings });

  const eventCount = events.length;
  const same = await me.request("/api/me/notification-settings", { method: "PATCH", ...json({ sound: false }) });
  assert.deepEqual(await same.json(), { settings }, "a patch that changes nothing keeps the version");
  assert.equal(events.length, eventCount, "and emits nothing");

  const resume = await me.request("/api/me/notification-settings", { method: "PATCH", ...json({ pausedUntil: null }) });
  assert.deepEqual(((await resume.json()) as { settings: { pausedUntil: null; version: number } }).settings, { ...settings, pausedUntil: null, version: 2 });
});

test("followedThreadReplies: absent reads as on, a PATCH round-trips and syncs, and the dispatcher read sees it", async ({ app, http }) => {
  const events = installFakeIo(app.app);
  const { member, server, general, thread } = await seed("notif-ftr");
  const me = http.as(member);
  const decision = async () => {
    const prefs = await loadNotificationPolicyPrefs(getDb(), {
      userIds: [member.id], serverIds: [server.id], channelIds: [general.id], threadChannelIds: [thread.id],
    });
    return decide({
      receiverId: member.id, serverId: server.id, category: "thread", personal: false,
      levelChannelId: general.id, threadChannelId: thread.id, levelChannelSeq: null, mentioned: false,
    }, prefs, new Date(), DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS);
  };

  const initial = await me.get("/api/me/notification-settings");
  assert.equal(((await initial.json()) as { settings: { followedThreadReplies: boolean } }).settings.followedThreadReplies, true, "no row: on");
  assert.deepEqual(await decision(), { kind: "notify" });

  // A row written without the field (an older client's PATCH) keeps it on.
  const other = await me.request("/api/me/notification-settings", { method: "PATCH", ...json({ sound: false }) });
  assert.equal(((await other.json()) as { settings: { followedThreadReplies: boolean } }).settings.followedThreadReplies, true);

  const off = await me.request("/api/me/notification-settings", { method: "PATCH", ...json({ followedThreadReplies: false }) });
  assert.equal(off.status, 200, await off.clone().text());
  const offSettings = ((await off.json()) as { settings: { followedThreadReplies: boolean; sound: boolean; version: number } }).settings;
  assert.equal(offSettings.followedThreadReplies, false);
  assert.equal(offSettings.sound, false, "other settings are kept");
  assert.equal(offSettings.version, 2);
  assert.deepEqual(events.at(-1), { room: `user:${member.id}`, event: "notification_prefs:updated", payload: { type: "account", settings: offSettings } });
  const read = await me.get("/api/me/notification-settings");
  assert.equal(((await read.json()) as { settings: { followedThreadReplies: boolean } }).settings.followedThreadReplies, false, "GET reads it back");
  assert.deepEqual(await decision(), { kind: "suppressed", reason: "followed_thread_replies_off" });

  const on = await me.request("/api/me/notification-settings", { method: "PATCH", ...json({ followedThreadReplies: true, version: 2 }) });
  assert.equal(((await on.json()) as { settings: { followedThreadReplies: boolean } }).settings.followedThreadReplies, true);
  assert.deepEqual(await decision(), { kind: "notify" });
});

test("levels: one write path for server and channel; the channel level beats the server level", async ({ app, http }) => {
  const events = installFakeIo(app.app);
  const { owner, member, outsider, server, general, secret, thread } = await seed("notif-levels");
  const me = http.as(member);
  const put = (body: unknown, as = me) => as.request("/api/notification-levels", { method: "PUT", ...json(body) });

  assert.equal((await put({ scope: "server", id: server.id, level: "default" })).status, 400, "a server level is never default");
  assert.equal((await put({ scope: "galaxy", id: server.id, level: "all" })).status, 400);
  assert.equal((await put({ scope: "channel", id: general.id, level: "loud" })).status, 400);
  assert.equal((await put({ scope: "server", id: server.id, level: "none" }, http.as(outsider))).status, 404, "not a member");
  assert.equal((await put({ scope: "channel", id: secret.id, level: "all" })).status, 404, "a private channel the member cannot read");
  assert.equal((await put({ scope: "channel", id: thread.id, level: "all" })).status, 400, "a thread is scope thread");
  assert.equal((await put({ scope: "thread", id: general.id, level: "all" })).status, 400, "no thread scope");
  assert.equal((await put({ scope: "thread", id: thread.id, level: "all" })).status, 400, "a thread has no level");

  const serverNone = await put({ scope: "server", id: server.id, level: "none" });
  assert.equal(serverNone.status, 200);
  assert.deepEqual(await serverNone.json(), { scope: "server", id: server.id, serverId: server.id, level: "none", effective: "none", muted: false, prefsVersion: 1 });
  assert.deepEqual(events.at(-1)?.payload, {
    type: "server", serverId: server.id, scopeId: server.id, level: "none",
    prefs: { serverPushMuted: true, serverPushMentionsOnly: false, serverPushMode: "none" }, prefsVersion: 1,
  });
  const [stored] = await getDb().select({ mode: serverMembers.serverPushMode }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, member.id)));
  assert.deepEqual(stored, { mode: "none" }, "the level is the stored mode");

  // A channel set to `all` overrides a server set to `none`.
  const channelAll = await put({ scope: "channel", id: general.id, level: "all" });
  assert.deepEqual(await channelAll.json(), { scope: "channel", id: general.id, serverId: server.id, level: "all", effective: "all", muted: false, prefsVersion: 2 });
  assert.deepEqual(events.at(-1)?.payload, { type: "channel", serverId: server.id, scopeId: general.id, level: "all", prefsVersion: 2 });

  const listed = await http.as(member, server).get("/api/notification-levels");
  assert.deepEqual(await listed.json(), { serverId: server.id, server: "none", channels: [{ id: general.id, level: "all" }], threads: [] });

  // Back to default: the row goes, the version still moves forward.
  const channelDefault = await put({ scope: "channel", id: general.id, level: "default" });
  assert.deepEqual(await channelDefault.json(), { scope: "channel", id: general.id, serverId: server.id, level: "default", effective: "none", muted: false, prefsVersion: 3 });
  assert.equal((await getDb().select().from(userChannelNotificationPrefs).where(eq(userChannelNotificationPrefs.userId, member.id))).length, 0);
  const eventCount = events.length;
  const again = await put({ scope: "channel", id: general.id, level: "default" });
  assert.equal(((await again.json()) as { prefsVersion: number }).prefsVersion, 3, "a no-op keeps the version");
  assert.equal(events.length, eventCount, "and emits nothing");

  // The owner's own levels are separate.
  const ownerList = await http.as(owner, server).get("/api/notification-levels");
  assert.deepEqual(await ownerList.json(), { serverId: server.id, server: "all", channels: [], threads: [] });
  assert.equal((await http.as(outsider, server).get("/api/notification-levels")).status, 403);
});

test("a thread has no level: PUT scope thread is refused and the follow state stays", async ({ app, http }) => {
  installFakeIo(app.app);
  const { member, thread } = await seed("notif-thread");
  const put = (level: string) => http.as(member).request("/api/notification-levels", { method: "PUT", ...json({ scope: "thread", id: thread.id, level }) });
  for (const level of ["all", "mentions", "none", "default"]) {
    const response = await put(level);
    assert.equal(response.status, 400, level);
    assert.deepEqual(await response.json(), { error: "A thread has no notification level; follow or unfollow it" });
  }
  assert.equal(await follow(thread.id, member.id), null, "nothing written");
});

test("the legacy server route writes the same level and the dispatcher read sees both scopes", async ({ app, http }) => {
  installFakeIo(app.app);
  const { owner, member, server, general, thread } = await seed("notif-legacy");
  const legacy = await http.as(member, server).request(`/api/servers/${server.id}/notification-settings`, { method: "PATCH", ...json({ serverPushMuted: true }) });
  assert.equal(legacy.status, 200);
  assert.deepEqual(await legacy.json(), { serverPushMuted: true, serverPushMentionsOnly: false, serverPushMode: "none", prefsVersion: 1 });
  const listed = await http.as(member, server).get("/api/notification-levels");
  assert.equal(((await listed.json()) as { server: string }).server, "none");

  const level = await http.as(member).request("/api/notification-levels", { method: "PUT", ...json({ scope: "server", id: server.id, level: "mentions" }) });
  assert.equal(((await level.json()) as { prefsVersion: number }).prefsVersion, 2);
  const get = await http.as(member, server).get(`/api/servers/${server.id}/notification-settings`);
  assert.deepEqual(await get.json(), { serverPushMuted: false, serverPushMentionsOnly: true, serverPushMode: "mentions", prefsVersion: 2 });

  await http.as(member).request("/api/notification-levels", { method: "PUT", ...json({ scope: "channel", id: general.id, level: "none" }) });
  await http.as(member).request("/api/me/notification-settings", { method: "PATCH", ...json({ previewMode: "hidden" }) });
  const prefs = await loadNotificationPolicyPrefs(getDb(), {
    userIds: [member.id, owner.id], serverIds: [server.id], channelIds: [general.id], threadChannelIds: [thread.id],
  });
  assert.equal(prefs.account.get(member.id)?.previewMode, "hidden");
  assert.equal(prefs.account.get(owner.id)?.version, 0, "no row reads as the defaults");
  assert.equal(prefs.serverLevel.get(`${server.id}:${member.id}`), "mentions");
  assert.equal(prefs.serverLevel.get(`${server.id}:${owner.id}`), "all");
  assert.equal(prefs.channelLevel.get(`${general.id}:${member.id}`), "none");
  assert.equal(prefs.channelLevel.has(`${general.id}:${owner.id}`), false);
  assert.equal(prefs.mutedFromSeq.size, 0);
});

test("the thread Follow / Unfollow buttons move only the follow state, never a level", async ({ app, http }) => {
  const events = installFakeIo(app.app);
  const { member, server, parent, thread } = await seed("notif-buttons");
  const inServer = http.as(member, server);
  const levels = async () => ((await (await inServer.get("/api/notification-levels")).json()) as { threads: Array<{ id: string; level: string }> }).threads;

  const followed = await inServer.request("/api/channels/threads/follow", { method: "POST", ...json({ parentMessageId: parent.id }) });
  assert.equal(followed.status, 200, await followed.clone().text());
  assert.deepEqual(await followed.json(), { ok: true, threadChannelId: thread.id });
  let row = await follow(thread.id, member.id);
  assert.deepEqual([row?.reason, row?.unfollowedAt, row?.notificationLevel], ["manual", null, null]);
  assert.deepEqual(events.find((event) => event.event === "notification_prefs:updated")?.payload, {
    type: "thread", serverId: server.id, scopeId: thread.id, level: "all", prefsVersion: 1,
  }, "older clients still hear about the follow");

  const unfollowed = await inServer.request("/api/channels/threads/unfollow", { method: "POST", ...json({ threadChannelId: thread.id }) });
  assert.equal(unfollowed.status, 200, await unfollowed.clone().text());
  row = await follow(thread.id, member.id);
  assert.ok(row?.unfollowedAt, "unfollowed");
  assert.equal(row?.notificationLevel, null);

  // A level written before thread levels were removed is not listed.
  await getDb().update(threadFollows).set({ notificationLevel: "none" })
    .where(and(eq(threadFollows.threadChannelId, thread.id), eq(threadFollows.followerId, member.id)));
  assert.deepEqual(await levels(), []);
  await inServer.request("/api/channels/threads/follow", { method: "POST", ...json({ parentMessageId: parent.id }) });
  row = await follow(thread.id, member.id);
  assert.deepEqual([row?.reason, row?.unfollowedAt], ["manual", null], "Follow works whatever level is stored");
});

test("channel and DM payloads carry the caller's stored notificationLevel; threads are always default", async ({ app, http }) => {
  installFakeIo(app.app);
  const { member, server, general, parent, thread } = await seed("notif-payloads");
  await createMessage(thread.id, "user", member.id, "a reply");
  const me = http.as(member, server);
  const put = (body: unknown) => http.as(member).request("/api/notification-levels", { method: "PUT", ...json(body) });
  type Item = { id: string; notificationLevel: string };

  const before = (await (await me.get("/api/channels")).json()) as Item[];
  assert.equal(before.find((item) => item.id === general.id)?.notificationLevel, "default");
  assert.ok(before.every((item) => typeof item.notificationLevel === "string"));

  assert.equal((await put({ scope: "channel", id: general.id, level: "mentions" })).status, 200);
  const list = (await (await me.get("/api/channels")).json()) as Item[];
  assert.equal(list.find((item) => item.id === general.id)?.notificationLevel, "mentions");
  const detail = (await (await me.get(`/api/channels/${general.id}`)).json()) as Item;
  assert.equal(detail.notificationLevel, "mentions");
  const dms = (await (await me.get("/api/channels/dm")).json()) as Item[];
  assert.ok(dms.every((item) => item.notificationLevel === "default"), "DMs carry it too");

  // Threads have no level: always default, even with a level stored before.
  const summaries = async () => ((await (await me.get(`/api/channels/${general.id}/threads?parentMessageIds=${parent.id}`)).json()) as Record<string, { threadChannelId: string; notificationLevel: string }>)[parent.id];
  const info = async () => ((await (await me.get(`/api/channels/${general.id}/threads/${parent.id}`)).json()) as { notificationLevel: string });
  assert.equal((await summaries())?.notificationLevel, "default");
  assert.equal((await info()).notificationLevel, "default");
  await getDb().update(threadFollows).set({ notificationLevel: "none" })
    .where(and(eq(threadFollows.threadChannelId, thread.id), eq(threadFollows.followerId, member.id)));
  assert.equal((await summaries())?.notificationLevel, "default");
  assert.equal((await info()).notificationLevel, "default");
  assert.equal(((await (await me.get(`/api/channels/${thread.id}`)).json()) as Item).notificationLevel, "default");
});

test("a followed thread's reply: the server level decides, a stored thread level is ignored", async ({ app, http }) => {
  installFakeIo(app.app);
  const { member, server, general, parent, thread } = await seed("notif-b1");
  const put = (body: unknown) => http.as(member).request("/api/notification-levels", { method: "PUT", ...json(body) });
  const decision = async () => {
    const prefs = await loadNotificationPolicyPrefs(getDb(), {
      userIds: [member.id], serverIds: [server.id], channelIds: [general.id], threadChannelIds: [thread.id],
    });
    return decide({
      receiverId: member.id, serverId: server.id, category: "thread", personal: false,
      levelChannelId: general.id, threadChannelId: thread.id, levelChannelSeq: null,
    }, prefs, new Date(), DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS);
  };

  const followed = await http.as(member, server).request("/api/channels/threads/follow", { method: "POST", ...json({ parentMessageId: parent.id }) });
  assert.equal(followed.status, 200, await followed.clone().text());
  assert.deepEqual(await decision(), { kind: "notify" }, "server all");
  assert.equal((await put({ scope: "server", id: server.id, level: "mentions" })).status, 200);
  assert.deepEqual(await decision(), { kind: "notify" }, "server mentions: a followed thread still notifies");
  assert.equal((await put({ scope: "server", id: server.id, level: "none" })).status, 200);
  assert.deepEqual(await decision(), { kind: "suppressed", reason: "server_none" });

  // A thread level stored between #12135 and this change is not read.
  await getDb().update(threadFollows).set({ notificationLevel: "all" })
    .where(and(eq(threadFollows.threadChannelId, thread.id), eq(threadFollows.followerId, member.id)));
  assert.deepEqual(await decision(), { kind: "suppressed", reason: "server_none" });
  assert.equal((await put({ scope: "server", id: server.id, level: "all" })).status, 200);
  await getDb().update(threadFollows).set({ notificationLevel: "none" })
    .where(and(eq(threadFollows.threadChannelId, thread.id), eq(threadFollows.followerId, member.id)));
  assert.deepEqual(await decision(), { kind: "notify" });
});

test("a mute silences an @mention; an Activity-only mute (an assistant DM's, push_muted = false) does not", async ({ app }) => {
  installFakeIo(app.app);
  const { member, server, general } = await seed("notif-mute");
  const decision = async () => {
    const prefs = await loadNotificationPolicyPrefs(getDb(), {
      userIds: [member.id], serverIds: [server.id], channelIds: [general.id], threadChannelIds: [],
    });
    return decide({
      receiverId: member.id, serverId: server.id, category: "mention", personal: true, mentioned: true,
      levelChannelId: general.id, threadChannelId: null, levelChannelSeq: 10,
    }, prefs, new Date(), DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS);
  };
  assert.deepEqual(await decision(), { kind: "notify" });

  // The owner-assistant DM's kind of row: kept out of Activity, still pushes (#12144).
  await getDb().insert(inboxTargetMuteStates).values({
    receiverType: "user", receiverId: member.id, serverId: server.id, sourceChannelId: general.id,
    activityMuted: true, muteFromSeq: 0, pushMuted: false,
  });
  assert.deepEqual(await decision(), { kind: "notify" }, "push_muted = false is not a notification mute");

  // A mute the person set: nothing pushes, the @mention included (Slack).
  await getDb().update(inboxTargetMuteStates).set({ pushMuted: true })
    .where(and(eq(inboxTargetMuteStates.sourceChannelId, general.id), eq(inboxTargetMuteStates.receiverId, member.id)));
  assert.deepEqual(await decision(), { kind: "suppressed", reason: "muted" });
});

test("Done withdraws the notifications it covers, as a read does, and counts as read for a held phone alert", async ({ app, http }) => {
  const events = installFakeIo(app.app);
  const { owner, member, server, general } = await seed("notif-done");
  const message = await createMessage(general.id, "user", owner.id, "something to dismiss");
  assert.equal(await isNotificationReadThrough(getDb(), member.id, general.id, message.seq), false);

  const done = await http.as(member, server).request("/api/channels/inbox/done", {
    method: "POST", ...json({ channelId: general.id, throughActivitySeq: String(message.seq), frontierSpace: "storage" }),
  });
  assert.equal(done.status, 200, await done.clone().text());
  await flushPendingRetractionsForTests();

  const retract = events.find((event) => event.event === "notification:retract");
  assert.ok(retract, "Done sends a retract like a read");
  const payload = retract.payload as { conversationId: string; throughSeq: number | null };
  assert.equal(payload.conversationId, general.id);
  assert.ok(payload.throughSeq === null || payload.throughSeq >= message.seq);
  assert.equal(await isNotificationReadThrough(getDb(), member.id, general.id, message.seq), true, "the held-alert check agrees");
});

test("pausedUntil is capped at a year ahead", async ({ http }) => {
  const { member } = await seed("notif-pause-cap");
  const patch = (pausedUntil: string) => http.as(member).request("/api/me/notification-settings", { method: "PATCH", ...json({ pausedUntil }) });
  assert.equal((await patch(new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString())).status, 400);
  assert.equal((await patch("+010000-01-01T00:00:00.000Z")).status, 400);
  assert.equal((await patch(new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString())).status, 200);
});
