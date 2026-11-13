/**
 * The unified notification dispatcher end to end against a real (PGlite)
 * database: enqueue -> claim -> policy -> presence plan -> transports ->
 * outbox row bookkeeping. Wire formats are covered by transports/*.test.ts;
 * these cases pin what the dispatcher decides and which provider receives it.
 */
import { dbTest as test } from "../../test/integration/dbTest";
import { closeTestDatabase } from "../../test/integration/database";
import assert from "node:assert/strict";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb, isDatabaseInitialized } from "../../db/index";
import {
  channelHumans,
  channels,
  inboxTargetMuteStates,
  messages,
  notificationMobileDeferrals,
  notificationOutbox,
  pushRegistrations,
  pushSubscriptions,
  serverMembers,
  servers,
  sessionFamilies,
  sessions,
  tasks,
  userChannelReadCursors,
  userNotificationSettings,
  users,
} from "../../db/schema";
import { runWithTraceSpan } from "../../tracing/semanticTrace";
import { FcmDeliveryError, type FcmDeliveryInput, type FcmDeliveryResult } from "../fcmPushProvider";
import { recordInboxNotificationFacts, type InboxNotificationFactInput } from "../inboxNotificationService";
import { ensureFamilyRevokeCapability, revokePushFamilyByCapability, upsertPushRegistration } from "../pushService";
import { __resetNotificationBadgesForTests, __setNotificationBadgeLoaderForTests } from "./badge";
import {
  NOTIFICATION_EXTERNAL_CONCURRENCY,
  __resetNotificationDispatchRuntimeForTests,
  __setAfterNotificationClaimForTests,
  __setNotificationDispatchRuntimeForTests,
  drainMobileDeferrals,
  drainNotificationOutbox,
  drainNotificationRows,
  __resetNotificationSendLedgerForTests,
  claimNotificationSend,
  __setNotificationSweepLockHeldElsewhereForTests,
  __resetNotificationSweepStatusOffsetForTests,
  registerNotificationSocketServer,
  startNotificationDispatcher,
  sweepNotificationOutbox,
} from "./dispatcher";
import type { NotificationNoticePayload } from "./envelope";
import { enqueueNotificationRows, enqueueNotificationsForFacts, type NotificationEnqueueRow } from "./enqueue";
import { __resetNotificationPresenceForTests, recordPresenceActivity } from "./presence";
import { updateAccountNotificationSettings } from "./settings";
import { pushRecoveryStarted } from "../secondFactor/recovery";
import { __resetRetractionForTests, __setRetractionRuntimeForTests, flushPendingRetractionsForTests, onConversationsRead } from "./retraction";
import {
  ApnsDeliveryError,
  __resetApnsPushProviderForTests,
  __setApnsPushProviderForTests,
  type ApnsDeliveryInput,
} from "./transports/apns";
import { __resetFcmPushProviderForTests, __setFcmPushProviderForTests } from "./transports/fcm";
import { __resetWebPushRuntimeForTests, __setWebPushRuntimeForTests, pushEndpointHash } from "./transports/webPush";
import type { ExternalSendResult } from "./types";

process.env.JWT_SECRET ||= "notification-dispatcher-test-secret";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const APP_URL = "https://app.raft.test";
const P256DH = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const AUTH = "tBHItJI5svbpez7KI4CCXg";

// ---------------------------------------------------------------------------
// Harness: every provider seam records, the post-commit kick is captured
// ---------------------------------------------------------------------------

type Emit = { room: string; event: string; payload: unknown; acked?: boolean };
type WebSend = { endpoint: string; payload: Record<string, unknown> };
type ApnsBody = {
  aps: { alert?: { title: string; subtitle?: string; body: string }; badge?: number; "thread-id"?: string; "content-available"?: number };
  type?: string;
  [key: string]: unknown;
};

let scheduled: Array<() => Promise<void>> = [];
let sleeps: number[] = [];
let apnsCalls: ApnsDeliveryInput[] = [];
let apnsBehavior: (input: ApnsDeliveryInput) => Promise<ExternalSendResult> = async () => ({ status: "sent" });
let fcmCalls: FcmDeliveryInput[] = [];
let fcmBehavior: (input: FcmDeliveryInput) => Promise<FcmDeliveryResult> = async () => ({ status: "sent" });
let webSends: WebSend[] = [];
let webBehavior: (send: WebSend) => Promise<void> = async () => {};
let webLookups: string[] = [];
let badgeValue: number | "unavailable" = 3;
let badgeServerId: string | null = null;
let emits: Emit[] = [];
let previousAppUrl: string | undefined;

/**
 * The desktop socket ids that ack an acked emit (fakeIo.timeout); reset per
 * test to the store's default socket id. Without ackers the callback fires
 * when the timeout runs out, as Socket.IO's does.
 */
let desktopAckers: string[] = ["default"];
const fakeIo = {
  to: (room: string) => ({ emit: (event: string, payload: unknown) => { emits.push({ room, event, payload }); } }),
  // io.timeout(ms).to(rooms).emit(event, payload, ack): acks arrive (or not) after the emit.
  timeout: (ms: number) => ({
    to: (rooms: string | string[]) => ({
      emit: (event: string, payload: unknown, ack: (err: Error | null, responses: unknown[]) => void) => {
        for (const room of ([] as string[]).concat(rooms)) emits.push({ room, event, payload, acked: true });
        const responses = desktopAckers.map((socketId) => ({ received: true, socketId }));
        if (responses.length > 0) queueMicrotask(() => ack(null, responses));
        else setTimeout(() => ack(new Error("operation has timed out"), []), ms);
      },
    }),
  }),
} as unknown as SocketServer;

function installHarness(): void {
  scheduled = [];
  sleeps = [];
  apnsCalls = [];
  fcmCalls = [];
  webSends = [];
  webLookups = [];
  emits = [];
  badgeValue = 3;
  badgeServerId = null;
  desktopAckers = ["default"];
  apnsBehavior = async () => ({ status: "sent" });
  fcmBehavior = async () => ({ status: "sent" });
  webBehavior = async () => {};
  previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = APP_URL;
  __resetNotificationPresenceForTests();
  __resetNotificationBadgesForTests();
  __resetRetractionForTests();
  __setNotificationDispatchRuntimeForTests({
    schedule: (work) => { scheduled.push(work); },
    sleep: async (ms) => { sleeps.push(ms); },
    jitterMs: (attempt) => attempt * 10,
    desktopAckTimeoutMs: 50,
  });
  // The whole badge is the fixture server's term (else the first server's).
  __setNotificationBadgeLoaderForTests(async (_userId, serverIds) => {
    if (badgeValue === "unavailable") throw new Error("risingwave unavailable");
    const total = badgeValue;
    const holder = badgeServerId && serverIds.includes(badgeServerId) ? badgeServerId : serverIds[0];
    return new Map(serverIds.map((serverId) => [serverId, serverId === holder ? total : 0]));
  });
  __setApnsPushProviderForTests({ send: async (input) => { apnsCalls.push(input); return apnsBehavior(input); } });
  __setFcmPushProviderForTests({ send: async (input) => { fcmCalls.push(input); return fcmBehavior(input); } });
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async (hostname) => {
      webLookups.push(hostname);
      return hostname.endsWith(".corp.example") ? [{ address: "10.0.0.5", family: 4 }] : [{ address: "142.250.72.10", family: 4 }];
    },
    sendNotification: async (subscription, payload) => {
      const send = { endpoint: subscription.endpoint, payload: JSON.parse(String(payload)) as Record<string, unknown> };
      webSends.push(send);
      await webBehavior(send);
      return { statusCode: 201, body: "", headers: {} };
    },
  });
  registerNotificationSocketServer(fakeIo);
}

beforeEach(() => {
  installHarness();
});

afterEach(() => {
  registerNotificationSocketServer(null);
  __setAfterNotificationClaimForTests(null);
  __resetNotificationDispatchRuntimeForTests();
  __resetApnsPushProviderForTests();
  __resetFcmPushProviderForTests();
  __resetWebPushRuntimeForTests();
  __resetNotificationPresenceForTests();
  __resetNotificationBadgesForTests();
  __resetRetractionForTests();
  if (previousAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = previousAppUrl;
});

/** Run every captured post-commit drain (and any it schedules). */
async function runScheduled(): Promise<number> {
  let count = 0;
  while (scheduled.length > 0) {
    const batch = scheduled.splice(0);
    count += batch.length;
    for (const work of batch) await work();
  }
  return count;
}

function apnsBody(input: ApnsDeliveryInput | undefined): ApnsBody {
  assert.ok(input, "an APNs request was sent");
  return input.request.body as ApnsBody;
}

const alerts = () => apnsCalls.filter((call) => call.request.pushType === "alert");
const backgrounds = () => apnsCalls.filter((call) => call.request.pushType === "background");

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function seedFixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({ email: "notif-owner@test.com", name: "NotifOwner", passwordHash: "x", emailVerified: true }).returning();
  const [sender] = await db.insert(users).values({ email: "notif-sender@test.com", name: "NotifSender", passwordHash: "x", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Mobile Push", slug: "mobile-push", ownerId: owner!.id }).returning();
  const [otherServer] = await db.insert(servers).values({ name: "Other Push", slug: "other-push", ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values([
    { serverId: server!.id, userId: owner!.id, role: "owner" },
    { serverId: otherServer!.id, userId: owner!.id, role: "owner" },
  ]);
  const [channel] = await db.insert(channels).values({ serverId: server!.id, name: "general", type: "channel" }).returning();
  const [message] = await db.insert(messages).values({ channelId: channel!.id, senderType: "user", senderId: sender!.id, content: "hello", seq: 1 }).returning();
  const [mention] = await db.insert(messages).values({ channelId: channel!.id, senderType: "user", senderId: sender!.id, content: "hello @NotifOwner", seq: 2 }).returning();
  const family = await liveFamily(owner!.id);
  badgeServerId = server!.id;

  /** A new message at the end of a channel. */
  async function post(channelId: string, content: string) {
    const [last] = await db.select({ seq: sql<number>`coalesce(max(${messages.seq}), 0)::int` }).from(messages).where(eq(messages.channelId, channelId));
    const [row] = await db.insert(messages).values({ channelId, senderType: "user", senderId: sender!.id, content, seq: Number(last?.seq ?? 0) + 1 }).returning();
    return row!;
  }

  /** A server member with a live session family. */
  async function member(name: string, serverId = server!.id) {
    const [user] = await db.insert(users).values({ email: `${name.toLowerCase()}@test.com`, name, passwordHash: "x", emailVerified: true }).returning();
    await db.insert(serverMembers).values({ serverId, userId: user!.id, role: "member" });
    return { user: user!, family: await liveFamily(user!.id) };
  }

  return { owner: owner!, sender: sender!, server: server!, otherServer: otherServer!, channel: channel!, message: message!, mention: mention!, family, post, member };
}

async function liveFamily(userId: string, expiresAt = new Date(Date.now() + 60 * MINUTE)) {
  const db = getDb();
  const [family] = await db.insert(sessionFamilies).values({ userId }).returning();
  await db.insert(sessions).values({ userId, familyId: family!.id, tokenHash: `token-${family!.id}`, expiresAt });
  return family!;
}

async function register(input: {
  userId: string;
  serverId: string;
  familyId: string;
  installationId: string;
  provider?: "apns" | "fcm";
  deviceToken?: string;
  topic?: string;
  env?: "sandbox" | "production";
}) {
  return upsertPushRegistration({
    installationId: input.installationId,
    provider: input.provider ?? "apns",
    userId: input.userId,
    serverId: input.serverId,
    sessionFamilyId: input.familyId,
    deviceToken: input.deviceToken ?? `token-${input.installationId}`,
    topic: input.topic ?? "build.raft.app",
    env: input.env ?? "production",
  });
}

async function subscribe(userId: string, endpoint: string) {
  const [row] = await getDb().insert(pushSubscriptions).values({ userId, endpoint, p256dh: P256DH, auth: AUTH }).returning();
  return row!;
}

function messageRow(
  receiverId: string,
  serverId: string,
  channelId: string,
  message: { id: string; seq: number },
  overrides: Partial<NotificationEnqueueRow> = {},
): NotificationEnqueueRow {
  return {
    receiverId,
    serverId,
    kind: "channel",
    sourceChannelId: channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: new Date(),
    personalMention: false,
    eventKey: `message:${message.id}`,
    category: "channel",
    ...overrides,
  };
}

function fact(
  receiverId: string,
  serverId: string,
  channelId: string,
  message: { id: string; seq: number },
  overrides: Partial<InboxNotificationFactInput> = {},
): InboxNotificationFactInput {
  return {
    receiverType: "user",
    receiverId,
    serverId,
    kind: "channel",
    sourceChannelId: channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: new Date(),
    ...overrides,
  };
}

/** Enqueue rows and run the post-commit drain they schedule. */
async function enqueueAndDrain(rows: NotificationEnqueueRow[]): Promise<string[]> {
  const ids = await enqueueNotificationRows(rows);
  assert.equal(ids.length, rows.length, "every row is new");
  assert.equal(await runScheduled(), 1, "one post-commit drain per enqueue");
  return ids;
}

async function outbox(id: string) {
  const [row] = await getDb().select().from(notificationOutbox).where(eq(notificationOutbox.id, id));
  assert.ok(row, `outbox row ${id}`);
  return row;
}

type Counts = {
  desktop: number; web: number; mobileSocket: number; apns: number; fcm: number; sync: number;
  failed: number; revoked: number; skippedByPresence: string[]; skippedDeviceDisabled: number; mobileDeferred: number;
  desktopUnconfirmed?: number; mobileFallback?: number;
};

function countsOf(row: { transports: Record<string, unknown> | null }): Counts {
  assert.ok(row.transports, "the row records its transports");
  return row.transports as unknown as Counts;
}

async function setServerLevel(userId: string, serverId: string, level: "all" | "mentions" | "none") {
  await getDb().update(serverMembers).set({ serverPushMode: level })
    .where(and(eq(serverMembers.userId, userId), eq(serverMembers.serverId, serverId)));
}

// ---------------------------------------------------------------------------
// 1. Policy, audience and provider outcomes (ported from pushService.test.ts)
// ---------------------------------------------------------------------------

test("a personal mention reaches every live registration of the user; muted ordinary activity enqueues nothing", async ({ db }) => {
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "server-a-install", env: "sandbox", topic: "build.raft.app" });
  // Registered while the app was on the other server: notifications are user-scoped.
  await register({ userId: f.owner.id, serverId: f.otherServer.id, familyId: f.family.id, installationId: "server-b-install" });

  await recordInboxNotificationFacts([fact(f.owner.id, f.server.id, f.channel.id, f.mention, { personalMention: true })]);
  assert.equal(apnsCalls.length, 0, "no provider runs inside fact recording");
  const [pending] = await db.select().from(notificationOutbox).where(eq(notificationOutbox.messageId, f.mention.id));
  assert.equal(pending?.status, "pending", "the row is durable before the drain runs");
  assert.equal(pending?.category, "mention");
  assert.equal(await runScheduled(), 1);

  assert.deepEqual(alerts().map((call) => call.installationId).sort(), ["server-a-install", "server-b-install"]);
  assert.equal(alerts().find((call) => call.installationId === "server-a-install")?.env, "sandbox");
  assert.equal(alerts().find((call) => call.installationId === "server-b-install")?.env, "production");
  for (const call of alerts()) {
    const body = apnsBody(call);
    assert.equal(body.serverId, f.server.id);
    assert.equal(body.channelId, f.channel.id);
    assert.equal(body.messageId, f.mention.id);
    assert.equal(body.raftCategory, "mention");
    // The owner is in two servers: the server label is the subtitle; a mention reads `Sender: text`.
    assert.deepEqual(body.aps.alert, { title: "#general", subtitle: "Mobile Push", body: "NotifSender: hello @NotifOwner" });
    assert.equal(body.aps.badge, 3);
    assert.equal(body.serverBadge, 3, "the push's server term");
  }
  const done = await outbox(pending!.id);
  assert.equal(done.status, "delivered");
  assert.equal(done.decision, "notify");
  assert.equal(countsOf(done).apns, 2);

  // Muted: an ordinary message writes nothing at all.
  scheduled.length = 0;
  await db.insert(inboxTargetMuteStates).values({
    receiverType: "user", receiverId: f.owner.id, serverId: f.server.id, sourceChannelId: f.channel.id, activityMuted: true, muteFromSeq: 1,
  });
  const before = (await db.select().from(notificationOutbox)).length;
  await recordInboxNotificationFacts([fact(f.owner.id, f.server.id, f.channel.id, f.message)]);
  assert.equal(scheduled.length, 0, "muted ordinary activity schedules no drain");
  assert.equal((await db.select().from(notificationOutbox)).length, before, "and writes no outbox row");
});

test("a fact on another server reaches a registration made under the first server", async ({ db }) => {
  void db;
  const f = await seedFixture();
  const [otherChannel] = await getDb().insert(channels).values({ serverId: f.otherServer.id, name: "other-general", type: "channel" }).returning();
  const otherMessage = await f.post(otherChannel!.id, "cross-server hello");
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "server-a-install" });

  await recordInboxNotificationFacts([fact(f.owner.id, f.otherServer.id, otherChannel!.id, otherMessage)]);
  await runScheduled();

  assert.equal(alerts().length, 1);
  const body = apnsBody(alerts()[0]);
  assert.equal(body.serverId, f.otherServer.id);
  assert.equal(body.channelId, otherChannel!.id);
  assert.deepEqual(body.aps.alert, { title: "#other-general", subtitle: "Other Push", body: "NotifSender: cross-server hello" });
  assert.equal(body.aps.badge, 3, "the badge is the total over every server");
  assert.equal(body.serverBadge, 0, "the other server holds none of it");
});

test("server level all / mentions / none decide channel messages and mentions", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "level-install" });

  async function deliver(personalMention: boolean) {
    const message = await f.post(f.channel.id, personalMention ? "ping @NotifOwner" : "plain");
    const before = alerts().length;
    await enqueueNotificationsForFacts([fact(f.owner.id, f.server.id, f.channel.id, message, { personalMention })]);
    await runScheduled();
    const [row] = await getDb().select().from(notificationOutbox).where(eq(notificationOutbox.messageId, message.id));
    assert.ok(row);
    return { row, alerted: alerts().length - before };
  }

  await setServerLevel(f.owner.id, f.server.id, "mentions");
  let result = await deliver(false);
  assert.equal(result.alerted, 0, "mentions: an ordinary message stays silent");
  assert.equal(result.row.status, "suppressed");
  assert.equal(result.row.decision, "suppressed:server_mentions");
  result = await deliver(true);
  assert.equal(result.alerted, 1, "mentions: a mention alerts");
  assert.equal(result.row.decision, "notify");

  await setServerLevel(f.owner.id, f.server.id, "none");
  result = await deliver(true);
  assert.equal(result.alerted, 0, "none: a mention stays silent too");
  assert.equal(result.row.decision, "suppressed:server_none");
  result = await deliver(false);
  assert.equal(result.alerted, 0);
  assert.equal(result.row.decision, "suppressed:server_none");

  await setServerLevel(f.owner.id, f.server.id, "all");
  result = await deliver(false);
  assert.equal(result.alerted, 1, "all: an ordinary message alerts");
  assert.equal(result.row.status, "delivered");
});

test("one person on two servers of one joint channel gets one row; the copy whose server level lets it through wins", async ({ db }) => {
  const f = await seedFixture();
  // The same joint channel as seen from the owner's other server.
  const [otherCopy] = await db.insert(channels).values({ serverId: f.otherServer.id, name: "general", type: "channel" }).returning();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "joint-install" });
  const copies = [f.channel, otherCopy!];
  const factsFor = (message: { id: string; seq: number }) =>
    copies.map((copy) => fact(f.owner.id, copy.serverId, copy.id, message));

  // Both servers allow it: one row, on the lowest source channel id.
  assert.equal(await enqueueNotificationsForFacts(factsFor(f.message)), 1);
  await runScheduled();
  // A retried enqueue adds nothing.
  assert.equal(await enqueueNotificationsForFacts(factsFor(f.message)), 0);
  assert.equal(scheduled.length, 0);
  let rows = await db.select().from(notificationOutbox).where(eq(notificationOutbox.messageId, f.message.id));
  assert.equal(rows.length, 1);
  const [first, second] = [...copies].sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.equal(rows[0]!.sourceChannelId, first!.id);
  assert.equal(alerts().length, 1, "one message buzzes the phone once, not once per copy");

  // Silence the server whose copy would win the id tie-break.
  await setServerLevel(f.owner.id, first!.serverId, "none");
  assert.equal(await enqueueNotificationsForFacts(factsFor(f.mention)), 1);
  await runScheduled();
  rows = await db.select().from(notificationOutbox).where(eq(notificationOutbox.messageId, f.mention.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sourceChannelId, second!.id);
  assert.equal(rows[0]!.serverId, second!.serverId);
  assert.equal(rows[0]!.status, "delivered", "a silenced server does not swallow the notification the other allows");
  assert.equal(alerts().length, 2);
  assert.equal(apnsBody(alerts()[1]).channelId, second!.id);
  assert.equal(apnsBody(alerts()[1]).serverId, second!.serverId);
});

test("a thread reply carries its parent identity and the badge; an unreadable badge still delivers without one", async ({ db }) => {
  const f = await seedFixture();
  const [thread] = await db.insert(channels).values({ serverId: f.server.id, name: `thread-${f.message.id}`, type: "thread", parentMessageId: f.message.id }).returning();
  const reply = await f.post(thread!.id, "thread reply");
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "thread-install" });
  badgeValue = 7;

  await enqueueAndDrain([messageRow(f.owner.id, f.server.id, thread!.id, reply, { kind: "thread", category: "thread" })]);
  const body = apnsBody(alerts()[0]);
  assert.equal(body.serverId, f.server.id);
  assert.equal(body.channelId, thread!.id);
  assert.equal(body.threadId, thread!.id);
  assert.equal(body.parentChannelId, f.channel.id);
  assert.equal(body.parentMessageId, f.message.id);
  assert.equal(body.messageId, reply.id);
  assert.equal(body.kind, "thread");
  assert.equal(body.raftCategory, "thread");
  assert.equal(body.conversationId, thread!.id);
  assert.equal(body.groupKey, `${f.server.id}:${thread!.id}`);
  assert.equal(body.aps.badge, 7);
  assert.equal(body.aps["thread-id"], `${f.server.id}:${thread!.id}`, "one stack per thread");
  assert.deepEqual(body.aps.alert, { title: "Thread in #general", subtitle: "Mobile Push", body: "NotifSender: thread reply" });

  badgeValue = "unavailable";
  const second = await f.post(thread!.id, "another reply");
  const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, thread!.id, second, { kind: "thread", category: "thread" })]);
  assert.equal(alerts().length, 2);
  assert.equal(apnsBody(alerts()[1]).aps.badge, undefined, "no badge: the device keeps its own");
  assert.equal((await outbox(id!)).status, "delivered");
});

test("a task conversation reply lands on the parent channel's anchor message with the task identity", async ({ db }) => {
  const f = await seedFixture();
  const [emptyChannel] = await db.insert(channels).values({ serverId: f.server.id, name: "quiet", type: "channel" }).returning();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "task-install" });
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "task-fcm", provider: "fcm" });
  let taskNumber = 7;
  async function taskReply(channelId: string, sourceMessageId: string | null) {
    const [task] = await db.insert(tasks).values({
      channelId,
      taskNumber: taskNumber++,
      title: "Ship the push fix",
      status: "todo",
      createdByType: "user",
      createdById: f.sender.id,
      ownConversation: true,
      sourceMessageId,
    }).returning();
    const [conversation] = await db.insert(channels).values({ serverId: f.server.id, name: `task-${task!.id}`, type: "task", taskId: task!.id }).returning();
    const reply = await f.post(conversation!.id, "task reply");
    const before = alerts().length;
    await enqueueAndDrain([messageRow(f.owner.id, f.server.id, conversation!.id, reply, { kind: "task", category: "thread" })]);
    assert.equal(alerts().length, before + 1);
    return { task: task!, conversation: conversation!, reply, body: apnsBody(alerts()[before]), fcm: fcmCalls[fcmCalls.length - 1]!.message.data };
  }

  // The task hangs under a message in #general: the push opens it, not the reply.
  const sourced = await taskReply(f.channel.id, f.message.id);
  assert.equal(sourced.body.channelId, f.channel.id);
  assert.equal(sourced.body.messageId, f.message.id);
  assert.equal(sourced.body.taskId, sourced.task.id);
  assert.equal(sourced.body.taskConversationChannelId, sourced.conversation.id);
  assert.equal(sourced.body.taskMessageId, sourced.reply.id);
  assert.equal(sourced.body.kind, "channel");
  assert.deepEqual(sourced.body.aps.alert, { title: "#7 Ship the push fix", subtitle: "#general · Mobile Push", body: "NotifSender: task reply" });
  assert.equal(sourced.fcm.title, "#7 Ship the push fix · #general · Mobile Push");
  assert.equal(sourced.fcm.subtitle, "#general · Mobile Push");
  assert.equal(sourced.fcm.channelId, f.channel.id);
  assert.equal(sourced.fcm.messageId, f.message.id);
  assert.equal(sourced.fcm.taskId, sourced.task.id);
  assert.equal(sourced.fcm.taskConversationChannelId, sourced.conversation.id);
  assert.equal(sourced.fcm.taskMessageId, sourced.reply.id);

  // No source message: the channel's latest message.
  const unsourced = await taskReply(f.channel.id, null);
  assert.equal(unsourced.body.channelId, f.channel.id);
  assert.equal(unsourced.body.messageId, f.mention.id);

  // A channel with no message at all: no anchor.
  const empty = await taskReply(emptyChannel!.id, null);
  assert.equal(empty.body.channelId, emptyChannel!.id);
  assert.equal("messageId" in empty.body, false);
  assert.equal("messageId" in empty.fcm, false);
  assert.equal(empty.body.aps.alert?.title, "#9 Ship the push fix");
  assert.equal(empty.body.aps.alert?.subtitle, "#quiet · Mobile Push");
});

test("the server label goes only to receivers of 2+ servers (one batched lookup for the group)", async ({ db }) => {
  const f = await seedFixture();
  const solo = await f.member("SoloMember");
  // A member of the other server too, plus a joint_storage server and a deleted one, which do not count.
  const [storage] = await db.insert(servers).values({ name: "Storage", slug: "storage-x", ownerId: f.owner.id, kind: "joint_storage" }).returning();
  const [gone] = await db.insert(servers).values({ name: "Gone", slug: "gone-x", ownerId: f.owner.id, deletedAt: new Date() }).returning();
  await db.insert(serverMembers).values([
    { serverId: storage!.id, userId: solo.user.id, role: "member" },
    { serverId: gone!.id, userId: solo.user.id, role: "member" },
  ]);
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "multi-install" });
  await register({ userId: solo.user.id, serverId: f.server.id, familyId: solo.family.id, installationId: "solo-install", provider: "apns" });
  await register({ userId: solo.user.id, serverId: f.server.id, familyId: solo.family.id, installationId: "solo-fcm", provider: "fcm" });
  await subscribe(solo.user.id, "https://fcm.googleapis.com/fcm/send/solo");

  await enqueueAndDrain([
    messageRow(f.owner.id, f.server.id, f.channel.id, f.message),
    messageRow(solo.user.id, f.server.id, f.channel.id, f.message),
  ]);

  const alertOf = (installationId: string) => apnsBody(alerts().find((call) => call.installationId === installationId)).aps.alert;
  assert.deepEqual(alertOf("multi-install"), { title: "#general", subtitle: "Mobile Push", body: "NotifSender: hello" });
  assert.deepEqual(alertOf("solo-install"), { title: "#general", body: "NotifSender: hello" }, "single server: no subtitle, no suffix");
  const soloFcm = fcmCalls.find((call) => call.deviceToken === "token-solo-fcm")!.message.data;
  assert.equal(soloFcm.title, "#general");
  assert.equal("subtitle" in soloFcm, false);
  const soloWeb = webSends.find((send) => send.endpoint.endsWith("/solo"))!.payload;
  assert.equal(soloWeb.title, "#general", "web push: no server suffix for a single-server receiver");
  assert.equal("subtitle" in soloWeb, false);
  const soloDesktop = emits.find((emit) => emit.event === "notification:desktop" && emit.room.startsWith(`user:${solo.user.id}:`))!.payload as { title: string; subtitle?: string; serverName: string };
  assert.equal(soloDesktop.title, "#general");
  assert.equal(soloDesktop.subtitle, undefined);
  assert.equal(soloDesktop.serverName, "Mobile Push", "serverName stays on the envelope");
  const ownerDesktop = emits.find((emit) => emit.event === "notification:desktop" && emit.room.startsWith(`user:${f.owner.id}:`))!.payload as { subtitle?: string };
  assert.equal(ownerDesktop.subtitle, "Mobile Push");
});

test("a DM push is titled by its sender with the bare text", async ({ db }) => {
  const f = await seedFixture();
  const [dm] = await db.insert(channels).values({ serverId: f.server.id, name: "dm-owner-sender", type: "dm" }).returning();
  await db.insert(channelHumans).values([{ channelId: dm!.id, userId: f.owner.id }, { channelId: dm!.id, userId: f.sender.id }]);
  const message = await f.post(dm!.id, "psst");
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "dm-install" });

  await enqueueAndDrain([messageRow(f.owner.id, f.server.id, dm!.id, message, { kind: "dm", category: "dm", personalMention: true })]);
  assert.deepEqual(apnsBody(alerts()[0]).aps.alert, { title: "NotifSender", subtitle: "Mobile Push", body: "psst" });
});

test("a task assignment notice is titled `#n title`", async ({ db }) => {
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "assigned-install" });
  const [task] = await db.insert(tasks).values({
    channelId: f.channel.id, taskNumber: 42, title: "Rotate the keys", status: "todo", createdByType: "user", createdById: f.sender.id, ownConversation: true, sourceMessageId: f.message.id,
  }).returning();
  const [conversation] = await db.insert(channels).values({ serverId: f.server.id, name: `task-${task!.id}`, type: "task", taskId: task!.id }).returning();
  const [notice] = await db.insert(messages).values({
    channelId: conversation!.id, senderType: "user", senderId: f.sender.id, messageType: "system", systemSubtype: "task.assignment_receipt",
    causalActorType: "user", causalActorId: f.sender.id, content: "NotifSender assigned #42 to @NotifOwner", seq: 1,
  }).returning();

  await enqueueAndDrain([messageRow(f.owner.id, f.server.id, conversation!.id, notice!, { kind: "task", category: "task_assigned", personalMention: true })]);
  assert.deepEqual(apnsBody(alerts()[0]).aps.alert, { title: "#42 Rotate the keys", subtitle: "#general · Mobile Push", body: "NotifSender assigned #42 to @NotifOwner" });
});

test("a terminal APNs token error (410 BadDeviceToken) revokes the registration and the row records it", async ({ db }) => {
  void db;
  const f = await seedFixture();
  const registration = await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "revoked-install" });
  apnsBehavior = async () => { throw new ApnsDeliveryError("bad device token", { statusCode: 410, reason: "BadDeviceToken" }); };

  const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);

  assert.equal(apnsCalls.length, 1, "a terminal error is not retried");
  const [row] = await getDb().select().from(pushRegistrations).where(eq(pushRegistrations.id, registration.id));
  assert.ok(row?.revokedAt, "revoked at once");
  assert.equal(row.userId, null);
  assert.equal(row.serverId, null);
  assert.equal(row.revokedReason, "BadDeviceToken");
  assert.equal(row.revokedUserId, f.owner.id, "the revoke keeps who the row belonged to");
  const done = await outbox(id!);
  assert.equal(countsOf(done).revoked, 1);
  assert.equal(countsOf(done).apns, 0);
  assert.deepEqual(done.firstFailure, { provider: "apns", reason: "BadDeviceToken", status: 410, target: { topic: "build.raft.app", env: "production", appVersion: null } });
});

test("FCM UNREGISTERED revokes the registration; INVALID_ARGUMENT drops without retrying or revoking", async ({ db }) => {
  void db;
  const f = await seedFixture();
  const gone = await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "fcm-gone", provider: "fcm" });
  fcmBehavior = async () => { throw new FcmDeliveryError("unregistered", { statusCode: 404, reason: "UNREGISTERED" }); };
  const [goneId] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);
  assert.equal(fcmCalls.length, 1);
  const [revoked] = await getDb().select().from(pushRegistrations).where(eq(pushRegistrations.id, gone.id));
  assert.ok(revoked?.revokedAt);
  assert.equal(revoked.revokedReason, "UNREGISTERED");
  assert.equal(countsOf(await outbox(goneId!)).revoked, 1);

  registerNotificationSocketServer(null);
  const bad = await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "fcm-bad", provider: "fcm" });
  fcmCalls = [];
  fcmBehavior = async () => { throw new FcmDeliveryError("bad request", { statusCode: 400, reason: "INVALID_ARGUMENT" }); };
  const [badId] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.mention)]);
  assert.equal(fcmCalls.length, 1, "INVALID_ARGUMENT is not retried");
  assert.deepEqual(sleeps, []);
  const [kept] = await getDb().select().from(pushRegistrations).where(eq(pushRegistrations.id, bad.id));
  assert.equal(kept?.revokedAt, null, "and does not revoke");
  const dropped = await outbox(badId!);
  assert.equal(dropped.status, "failed");
  assert.equal(countsOf(dropped).failed, 1);
  assert.deepEqual(dropped.firstFailure, { provider: "fcm", reason: "INVALID_ARGUMENT", status: 400, target: { env: "production", appVersion: null } });
});

test("a transient provider failure is retried exactly 3 times, then the row fails with the first failure", async ({ db }) => {
  void db;
  const f = await seedFixture();
  // No socket server: APNs is the only transport of this row.
  registerNotificationSocketServer(null);
  const registration = await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "retry-install" });
  apnsBehavior = async () => { throw new ApnsDeliveryError("temporary provider failure", { statusCode: 503, reason: "ServiceUnavailable" }); };

  const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);

  assert.equal(apnsCalls.length, 3);
  assert.deepEqual(sleeps, [10, 20], "jittered back-off between attempts");
  const [row] = await getDb().select().from(pushRegistrations).where(eq(pushRegistrations.id, registration.id));
  assert.equal(row?.revokedAt, null, "a transient failure never revokes");
  assert.equal(row?.userId, f.owner.id);
  const done = await outbox(id!);
  assert.equal(done.status, "failed");
  assert.deepEqual(done.firstFailure, { provider: "apns", reason: "ServiceUnavailable", status: 503, target: { topic: "build.raft.app", env: "production", appVersion: null } });
  assert.equal(countsOf(done).failed, 1);
  assert.match(done.lastError ?? "", /^apns ServiceUnavailable http=503$/);
});

test("registrations of a revoked session family or with only expired sessions are excluded; a family with several sessions delivers once", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "dead-family-install" });
  const capability = await ensureFamilyRevokeCapability({ familyId: f.family.id, userId: f.owner.id });
  assert.ok(capability);
  assert.equal(await revokePushFamilyByCapability(capability), "revoked");
  const expired = await liveFamily(f.owner.id, new Date(Date.now() - MINUTE));
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: expired.id, installationId: "expired-install" });

  await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);
  assert.equal(apnsCalls.length, 0, "no dead or expired registration is sent to");

  const live = await liveFamily(f.owner.id);
  await getDb().insert(sessions).values({ userId: f.owner.id, familyId: live.id, tokenHash: `second-${live.id}`, expiresAt: new Date(Date.now() + 60 * MINUTE) });
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: live.id, installationId: "multi-session-install" });
  await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.mention)]);
  assert.deepEqual(apnsCalls.map((call) => call.installationId), ["multi-session-install"]);
});

test("traces never carry installation ids, device tokens, or the text of sender_only / hidden previews", async ({ db }) => {
  const CONTENT = "SECRET-BODY-123";
  const f = await seedFixture();
  const secretMessage = await f.post(f.channel.id, CONTENT);
  const modes = ["full", "sender_only", "hidden"] as const;
  const receivers: Record<string, { userId: string; installation: string; token: string }> = {};
  for (const mode of modes) {
    const { user, family } = await f.member(`Preview${mode.replace("_", "")}`);
    await db.insert(userNotificationSettings).values({ userId: user.id, previewMode: mode });
    const installation = `${mode}@example.com secret installation`;
    const token = `secret-device-token-${mode}`;
    // The topic is the allowlisted bundle id (public): a failure record names it on purpose.
    await register({ userId: user.id, serverId: f.server.id, familyId: family.id, installationId: installation, deviceToken: token });
    await register({ userId: user.id, serverId: f.server.id, familyId: family.id, installationId: `${installation} fcm`, deviceToken: `${token}-fcm`, provider: "fcm" });
    receivers[mode] = { userId: user.id, installation, token };
  }
  // A transient failure on one device puts the retry path into the trace too.
  apnsBehavior = async (input) => {
    if (input.installationId === receivers.hidden!.installation && apnsCalls.filter((call) => call.installationId === input.installationId).length === 1) {
      throw new ApnsDeliveryError("temporary provider failure", { statusCode: 503, reason: "ServiceUnavailable" });
    }
    return { status: "sent" };
  };

  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  await runWithTraceSpan(span, async () => {
    const ids = await enqueueNotificationRows(modes.map((mode) => messageRow(receivers[mode]!.userId, f.server.id, f.channel.id, secretMessage)));
    // Drained here, inside this span (the post-commit kick opens its own root).
    scheduled = [];
    assert.deepEqual(await drainNotificationRows(ids), { claimed: 3, processed: 3 });
  }, tracer);
  span.end();

  const sentTo = (mode: (typeof modes)[number]) => {
    const userId = receivers[mode]!.userId;
    const apns = alerts().filter((call) => call.installationId === receivers[mode]!.installation);
    const fcm = fcmCalls.filter((call) => call.installationId === `${receivers[mode]!.installation} fcm`);
    const sockets = emits.filter((emit) => emit.room.startsWith(`user:${userId}:`));
    assert.ok(apns.length > 0 && fcm.length === 1 && sockets.length === 2, `${mode} was delivered on every transport`);
    return JSON.stringify({ apns: apns.map((call) => call.request), fcm: fcm.map((call) => call.message), sockets });
  };
  assert.ok(sentTo("full").includes(CONTENT), "control: the full preview carries the text");
  for (const mode of ["sender_only", "hidden"] as const) {
    assert.equal(sentTo(mode).includes(CONTENT), false, `${mode}: no transport carries the text`);
  }
  assert.ok(sentTo("sender_only").includes("NotifSender sent a message"));
  assert.ok(sentTo("hidden").includes("You have a new message"));

  const traces = JSON.stringify({ spans: sink.getAllSpans(), logs: sink.getAllLogEvents() });
  assert.ok(traces.includes("notification.transport.summary"), "the trace captured the dispatch");
  assert.ok(traces.includes("notification.transport.retry_scheduled"), "and the retry");
  assert.equal(traces.includes(CONTENT), false, "no message text in traces");
  for (const { installation, token } of Object.values(receivers)) {
    for (const secret of [installation, token]) assert.equal(traces.includes(secret), false, `trace must not contain ${secret}`);
  }
});

test("the interval worker drains inside its own trace root", async ({ db }) => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  let intervalRun: (() => void) | undefined;
  const worker = startNotificationDispatcher({
    tracer,
    intervalMs: 15_000,
    clock: {
      scheduleEvery(run, ms) {
        if (ms === 15_000) intervalRun = run;
        return Symbol("notification-worker-timer");
      },
      clearInterval() {},
    },
  });
  try {
    await waitFor(() => sink.getAllSpans().length === 1, "the startup drain closes its trace root");
    const f = await seedFixture();
    await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "interval-install" });
    const [id] = await enqueueNotificationRows([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);
    scheduled = []; // the post-commit kick is not run: the worker picks the row up

    assert.ok(intervalRun, "the worker registered its interval");
    intervalRun();
    await waitFor(() => sink.getAllSpans().length === 2, "the interval drain closes its trace root");

    const intervalSpan = sink.getAllSpans()[1]!;
    assert.equal(intervalSpan.name, "server.notification.outbox.drain");
    assert.equal(intervalSpan.kind, "internal");
    assert.equal(intervalSpan.attrs?.trigger, "interval_worker");
    assert.equal(intervalSpan.attrs?.claimed_count, 1);
    assert.equal(intervalSpan.attrs?.processed_count, 1);
    const names = intervalSpan.events.map((event) => event.name).filter((name) => name.startsWith("notification."));
    for (const name of ["notification.decision", "notification.transport.attempt", "notification.transport.summary"]) {
      assert.ok(names.includes(name), `the drain span carries ${name}`);
    }
    assert.equal((await outbox(id!)).status, "delivered");
    assert.equal(apnsCalls.length, 1);
    void db;
  } finally {
    await worker.stop();
  }
});

test("database close drains deferred notification work before releasing SQL", async ({ db }) => {
  // The production post-commit scheduler, not the harness recorder.
  __resetNotificationDispatchRuntimeForTests();
  let markEntered = () => {};
  let releaseProvider = () => {};
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const released = new Promise<void>((resolve) => { releaseProvider = resolve; });
  let delivered = false;
  let closing: Promise<void> | undefined;
  apnsBehavior = async () => {
    markEntered();
    await released;
    // Dispatch holds the writer-fence transaction: the database must still be live.
    assert.equal(isDatabaseInitialized(), true, "provider work still owns a live database");
    assert.equal(getDb(), db);
    delivered = true;
    return { status: "sent" };
  };
  try {
    const f = await seedFixture();
    await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "close-drain-install" });
    await recordInboxNotificationFacts([fact(f.owner.id, f.server.id, f.channel.id, f.mention, { personalMention: true })]);
    closing = closeTestDatabase();
    await Promise.race([
      entered,
      closing.then(() => assert.fail("database closed before the deferred delivery started")),
    ]);
    assert.equal(delivered, false, "close waits for the blocked provider");
    releaseProvider();
    await closing;
    assert.equal(delivered, true, "close joins the provider and its SQL work");
    assert.equal(isDatabaseInitialized(), false, "SQL closes only after delivery returns");
  } finally {
    releaseProvider();
    await closing?.catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 2. Transports
// ---------------------------------------------------------------------------

test("each transport gets the notification: desktop and mobile sockets by client kind, Web Push per subscription, APNs and FCM by provider", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "ios", deviceToken: "ios-token" });
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "android", provider: "fcm", deviceToken: "android-token" });
  await subscribe(f.owner.id, "https://fcm.googleapis.com/fcm/send/one");
  await subscribe(f.owner.id, "https://updates.push.services.mozilla.com/wpush/v2/two");

  const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);

  assert.deepEqual(emits.map(({ room, event }) => ({ room, event })), [
    { room: `user:${f.owner.id}:clientKind:desktop`, event: "notification:desktop" },
    { room: `user:${f.owner.id}:clientKind:mobile`, event: "notification:push" },
  ]);
  const desktop = emits[0]!.payload as { v: number; title: string; groupKey: string; category: string; seq: number };
  assert.equal(desktop.v, 1);
  assert.equal(desktop.title, "#general");
  assert.equal(desktop.category, "channel");
  assert.equal(desktop.seq, f.message.seq);
  const mobileSocket = emits[1]!.payload as { url: string; groupKey: string; title: string; subtitle?: string };
  assert.equal(mobileSocket.title, "#general · Mobile Push");
  assert.equal(mobileSocket.subtitle, "Mobile Push");
  assert.ok(mobileSocket.url.startsWith(`${APP_URL}/`), "the mobile socket url is absolute");

  const groupKey = `${f.server.id}:${f.channel.id}`;
  assert.deepEqual(webSends.map((send) => send.endpoint).sort(), [
    "https://fcm.googleapis.com/fcm/send/one",
    "https://updates.push.services.mozilla.com/wpush/v2/two",
  ]);
  for (const { payload } of webSends) {
    assert.equal(payload.tag, groupKey);
    assert.equal(payload.groupKey, groupKey);
    assert.equal(payload.url, `${APP_URL}/s/mobile-push/channel/${f.channel.id}?msg=${f.message.id}`);
    // Web Push has no subtitle: the server label (2+ servers) joins the title.
    assert.equal(payload.title, "#general · Mobile Push");
    assert.equal(payload.body, "NotifSender: hello");
  }
  assert.deepEqual(apnsCalls.map((call) => call.deviceToken), ["ios-token"]);
  assert.deepEqual(fcmCalls.map((call) => call.deviceToken), ["android-token"]);
  assert.equal(fcmCalls[0]!.message.data.groupKey, groupKey);

  const counts = countsOf(await outbox(id!));
  assert.deepEqual(
    { desktop: counts.desktop, web: counts.web, mobileSocket: counts.mobileSocket, apns: counts.apns, fcm: counts.fcm, skippedByPresence: counts.skippedByPresence },
    { desktop: 1, web: 2, mobileSocket: 1, apns: 1, fcm: 1, skippedByPresence: [] },
  );
});

test("a gone (404 / 410) Web Push subscription is deleted; a non-public endpoint is deleted without contacting it", async ({ db }) => {
  const f = await seedFixture();
  const kept = await subscribe(f.owner.id, "https://fcm.googleapis.com/fcm/send/kept");
  await subscribe(f.owner.id, "https://fcm.googleapis.com/fcm/send/gone-410");
  await subscribe(f.owner.id, "https://fcm.googleapis.com/fcm/send/gone-404");
  // Not a known push service: skipped and kept (transports/webPush.ts), never contacted.
  const unsupported = await subscribe(f.owner.id, "https://push.corp.example/sub/private-range");
  await subscribe(f.owner.id, "https://169.254.169.254/latest/meta-data");
  webBehavior = async (send) => {
    if (send.endpoint.endsWith("gone-410")) throw Object.assign(new Error("gone"), { statusCode: 410 });
    if (send.endpoint.endsWith("gone-404")) throw Object.assign(new Error("not found"), { statusCode: 404 });
  };

  const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);

  assert.equal(webSends.some((send) => send.endpoint.includes("corp.example") || send.endpoint.includes("169.254")), false,
    "a non-public endpoint is never contacted");
  assert.equal(webLookups.includes("169.254.169.254"), false, "an IP literal never reaches DNS");
  const left = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, f.owner.id));
  assert.deepEqual(left.map((row) => row.id).sort(), [kept.id, unsupported.id].sort());
  const counts = countsOf(await outbox(id!));
  assert.equal(counts.web, 1);
  assert.equal(counts.revoked, 3);
});

// ---------------------------------------------------------------------------
// 3. Presence plan
// ---------------------------------------------------------------------------

test("the presence plan picks the transports: active kinds only, else everything with Web Push yielding to an online desktop", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "presence-install" });
  await subscribe(f.owner.id, "https://fcm.googleapis.com/fcm/send/presence");

  async function deliver(presence: () => Promise<void>) {
    __resetNotificationPresenceForTests();
    await presence();
    emits = [];
    apnsCalls = [];
    webSends = [];
    const message = await f.post(f.channel.id, "presence");
    const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, message)]);
    const row = await outbox(id!);
    assert.equal(row.status, "delivered");
    return {
      desktop: emits.filter((emit) => emit.event === "notification:desktop").length,
      mobileSocket: emits.filter((emit) => emit.event === "notification:push").length,
      web: webSends.length,
      alerts: alerts().length,
      syncs: backgrounds().map((call) => apnsBody(call)),
      counts: countsOf(row),
    };
  }
  const now = () => Date.now();

  // Desktop in use: desktop only; the phone gets a badge sync (first time: the badge changed).
  let result = await deliver(() => recordPresenceActivity(f.owner.id, "desktop", { active: true, idleSeconds: 5 }, now()));
  assert.deepEqual([result.desktop, result.mobileSocket, result.web, result.alerts], [1, 1, 0, 0]);
  assert.deepEqual(result.syncs, [{ aps: { "content-available": 1 }, type: "sync", badge: 3, serverBadge: 3 }]);
  assert.deepEqual(result.counts.skippedByPresence, ["web", "mobile"]);
  assert.equal(result.counts.sync, 1);
  // Same badge again: no second sync.
  result = await deliver(() => recordPresenceActivity(f.owner.id, "desktop", { active: true, idleSeconds: 5 }, now()));
  assert.deepEqual([result.desktop, result.web, result.alerts, result.syncs.length], [1, 0, 0, 0]);

  // Browser in use: Web Push only.
  result = await deliver(() => recordPresenceActivity(f.owner.id, "web", { active: true, idleSeconds: 0, pushSubscribed: true, pushEndpointHash: pushEndpointHash("https://fcm.googleapis.com/fcm/send/presence") }, now()));
  assert.deepEqual([result.desktop, result.mobileSocket, result.web, result.alerts, result.syncs.length], [0, 1, 1, 0, 0]);
  assert.deepEqual(result.counts.skippedByPresence, ["desktop", "mobile"]);

  // Phone in the foreground: APNs only.
  result = await deliver(() => recordPresenceActivity(f.owner.id, "mobile", { active: true, idleSeconds: null }, now()));
  assert.deepEqual([result.desktop, result.mobileSocket, result.web, result.alerts], [0, 1, 0, 1]);
  assert.deepEqual(result.counts.skippedByPresence, ["desktop", "web"]);
  assert.equal(result.counts.apns, 1);

  // Nobody active, desktop app online (idle): desktop + APNs, the browser yields.
  result = await deliver(() => recordPresenceActivity(f.owner.id, "desktop", { active: false, idleSeconds: null }, now()));
  assert.deepEqual([result.desktop, result.mobileSocket, result.web, result.alerts], [1, 1, 0, 1]);
  assert.deepEqual(result.counts.skippedByPresence, ["web"]);

  // Nobody active and no desktop: everything.
  result = await deliver(async () => {});
  assert.deepEqual([result.desktop, result.mobileSocket, result.web, result.alerts], [1, 1, 1, 1]);
  assert.deepEqual(result.counts.skippedByPresence, []);
  assert.deepEqual([result.counts.desktop, result.counts.web, result.counts.mobileSocket, result.counts.apns], [1, 1, 1, 1]);
});

// ---------------------------------------------------------------------------
// 4-6. Quiet, device switches, stale
// ---------------------------------------------------------------------------

test("while paused nothing alerts: the row is quiet and the phone gets one badge sync, not repeated for the same badge", async ({ db }) => {
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "quiet-install" });
  await subscribe(f.owner.id, "https://fcm.googleapis.com/fcm/send/quiet");
  await db.insert(userNotificationSettings).values({ userId: f.owner.id, pausedUntil: new Date(Date.now() + 60 * MINUTE) });
  badgeValue = 5;

  const [first] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.mention, { personalMention: true, category: "mention" })]);
  assert.equal(emits.length, 0, "no desktop or mobile socket notification");
  assert.equal(webSends.length, 0);
  assert.equal(alerts().length, 0);
  assert.deepEqual(backgrounds().map((call) => [call.request.priority, apnsBody(call)]), [["5", { aps: { "content-available": 1 }, type: "sync", badge: 5, serverBadge: 5 }]]);
  const row = await outbox(first!);
  assert.equal(row.status, "quiet");
  assert.equal(row.decision, "quiet");
  assert.equal(countsOf(row).sync, 1);

  await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);
  assert.equal(apnsCalls.length, 1, "the same badge is not synced twice");
});

test("a device with alerts off or OS permission denied only syncs the badge when it changed; the other device still alerts", async ({ db }) => {
  const f = await seedFixture();
  const off = await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "switched-off" });
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "phone" });
  await db.update(pushRegistrations).set({ alertsEnabled: false }).where(eq(pushRegistrations.id, off.id));
  badgeValue = 4;

  const deliver = async (message: { id: string; seq: number }) => {
    apnsCalls = [];
    const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, message)]);
    return { calls: apnsCalls.map((call) => [call.installationId, call.request.pushType, apnsBody(call).badge ?? apnsBody(call).aps.badge]), row: await outbox(id!) };
  };

  let result = await deliver(f.message);
  assert.deepEqual(result.calls.sort(), [["phone", "alert", 4], ["switched-off", "background", 4]]);
  assert.equal(countsOf(result.row).skippedDeviceDisabled, 1);
  result = await deliver(f.mention);
  assert.deepEqual(result.calls, [["phone", "alert", 4]], "an unchanged badge sends no sync");

  await db.update(pushRegistrations).set({ alertsEnabled: true, osPermission: "denied" }).where(eq(pushRegistrations.id, off.id));
  badgeValue = 6;
  result = await deliver(await f.post(f.channel.id, "third"));
  assert.deepEqual(result.calls.sort(), [["phone", "alert", 6], ["switched-off", "background", 6]]);
});

test("a row claimed more than 10 minutes after its activity does not alert: suppressed:stale with a badge sync", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "stale-install" });
  badgeValue = 2;

  const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.message, { activityAt: new Date(Date.now() - 11 * MINUTE) })]);

  assert.equal(emits.length, 0);
  assert.equal(alerts().length, 0);
  assert.deepEqual(backgrounds().map((call) => apnsBody(call)), [{ aps: { "content-available": 1 }, type: "sync", badge: 2, serverBadge: 2 }]);
  const row = await outbox(id!);
  assert.equal(row.status, "suppressed");
  assert.equal(row.decision, "suppressed:stale");
});

// ---------------------------------------------------------------------------
// 8-9. Claim concurrency and the writer fence
// ---------------------------------------------------------------------------

test("concurrent drains deliver each row exactly once; a fresh processing lock is not re-claimed, a stale one is", async ({ db }) => {
  const f = await seedFixture();
  const second = await f.member("SecondReceiver");
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "claim-owner" });
  await register({ userId: second.user.id, serverId: f.server.id, familyId: second.family.id, installationId: "claim-second" });
  const ids = await enqueueNotificationRows([
    messageRow(f.owner.id, f.server.id, f.channel.id, f.message),
    messageRow(second.user.id, f.server.id, f.channel.id, f.message),
    messageRow(f.owner.id, f.server.id, f.channel.id, f.mention),
  ]);
  scheduled = [];

  const results = await Promise.all([drainNotificationRows(ids), drainNotificationRows(ids), drainNotificationOutbox()]);
  assert.equal(results.reduce((sum, result) => sum + result.claimed, 0), 3, "each row is claimed once in total");
  const deliveries = alerts().map((call) => `${call.installationId}:${apnsBody(call).messageId}`).sort();
  assert.deepEqual(deliveries, [`claim-owner:${f.mention.id}`, `claim-owner:${f.message.id}`, `claim-second:${f.message.id}`].sort());
  for (const id of ids) {
    const row = await outbox(id);
    assert.equal(row.status, "delivered");
    assert.equal(row.attemptCount, 1);
  }

  // A row another replica is processing right now.
  const third = await f.post(f.channel.id, "locked");
  const [locked] = await enqueueNotificationRows([messageRow(f.owner.id, f.server.id, f.channel.id, third)]);
  scheduled = [];
  await db.update(notificationOutbox).set({ status: "processing", lockedAt: new Date(), attemptCount: 1 }).where(eq(notificationOutbox.id, locked!));
  apnsCalls = [];
  assert.deepEqual(await drainNotificationRows([locked!]), { claimed: 0, processed: 0 });
  assert.deepEqual(await drainNotificationOutbox(), { claimed: 0, processed: 0 });
  assert.equal(apnsCalls.length, 0);

  // That replica died: the lock went stale.
  await db.update(notificationOutbox).set({ lockedAt: new Date(Date.now() - 6 * MINUTE) }).where(eq(notificationOutbox.id, locked!));
  assert.deepEqual(await drainNotificationRows([locked!]), { claimed: 1, processed: 1 });
  assert.equal(apnsCalls.length, 1);
  const reclaimed = await outbox(locked!);
  assert.equal(reclaimed.status, "delivered");
  assert.equal(reclaimed.attemptCount, 2);
});

test("rows a channel conversion revokes after the claim publish nothing; another row of the same event is still delivered", async ({ db }) => {
  const f = await seedFixture();
  const second = await f.member("FenceReceiver");
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "fence-owner" });
  await register({ userId: second.user.id, serverId: f.server.id, familyId: second.family.id, installationId: "fence-second" });
  await subscribe(f.owner.id, "https://fcm.googleapis.com/fcm/send/fence");

  // The conversion's audience cutover, committed between the claim and the fence.
  const revoke = (ids: string[]) => db.update(notificationOutbox).set({
    status: "revoked",
    processedAt: new Date(),
    updatedAt: new Date(),
    lastError: "channel_conversion_audience_cutover",
  }).where(and(inArray(notificationOutbox.id, ids), inArray(notificationOutbox.status, ["pending", "processing"])));

  const claimed: string[][] = [];
  __setAfterNotificationClaimForTests(async (rows) => {
    claimed.push(rows.map((row) => row.id));
    await revoke(rows.map((row) => row.id));
  });
  const ids = await enqueueAndDrain([
    messageRow(f.owner.id, f.server.id, f.channel.id, f.message),
    messageRow(second.user.id, f.server.id, f.channel.id, f.message),
  ]);
  assert.deepEqual(claimed.flat().sort(), [...ids].sort(), "the hook saw the claimed rows");
  assert.equal(apnsCalls.length, 0, "no provider ran for a revoked row");
  assert.equal(webSends.length, 0);
  assert.equal(emits.length, 0, "no socket emit for a revoked row");
  for (const id of ids) {
    const row = await outbox(id);
    assert.equal(row.status, "revoked", "the drain does not overwrite the revocation");
    assert.equal(row.lastError, "channel_conversion_audience_cutover");
  }

  // Only the owner lost access: the other receiver of the same event is delivered.
  __setAfterNotificationClaimForTests(async (rows) => {
    await revoke(rows.filter((row) => row.receiverId === f.owner.id).map((row) => row.id));
  });
  const [ownerRow, secondRow] = await enqueueAndDrain([
    messageRow(f.owner.id, f.server.id, f.channel.id, f.mention),
    messageRow(second.user.id, f.server.id, f.channel.id, f.mention),
  ]);
  assert.deepEqual(alerts().map((call) => call.installationId), ["fence-second"]);
  assert.equal(webSends.length, 0);
  assert.equal(emits.every((emit) => emit.room.startsWith(`user:${second.user.id}:`)), true);
  assert.equal(emits.length, 2);
  assert.equal((await outbox(ownerRow!)).status, "revoked");
  assert.equal((await outbox(secondRow!)).status, "delivered");
});

// ---------------------------------------------------------------------------
// 10. Sweep
// ---------------------------------------------------------------------------

for (const target of ["private", "thread", "thread_parent", "task", "task_parent"] as const) {
  test(`deletion after preparation suppresses a queued private notification (${target})`, async ({ db }) => {
    const { deleteChannel } = await import("../channelService");
    const f = await seedFixture();
    await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "deleted-ios" });
    await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "deleted-android", provider: "fcm" });
    await subscribe(f.owner.id, "https://fcm.googleapis.com/fcm/send/deleted");
    const [parent] = await db.insert(channels).values({ serverId: f.server.id, name: "private-plans", type: "private" }).returning();
    await db.insert(channelHumans).values({ channelId: parent!.id, userId: f.owner.id });
    const anchor = await f.post(parent!.id, "private anchor");
    let source = parent!;
    if (target.startsWith("thread")) {
      [source] = await db.insert(channels).values({ serverId: f.server.id, name: "private-thread", type: "thread", parentMessageId: anchor.id }).returning();
    } else if (target.startsWith("task")) {
      const [task] = await db.insert(tasks).values({ channelId: parent!.id, taskNumber: 1, title: "Private task", status: "todo", createdByType: "user", createdById: f.sender.id, ownConversation: true, sourceMessageId: anchor.id }).returning();
      [source] = await db.insert(channels).values({ serverId: f.server.id, name: "private-task", type: "task", taskId: task!.id }).returning();
    }
    const reply = await f.post(source.id, "private plans");
    __setAfterNotificationClaimForTests(async () => {
      await deleteChannel(target.endsWith("_parent") ? parent!.id : source.id);
    });
    const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, source.id, reply)]);
    assert.equal(apnsCalls.length, 0, "deleted conversations must not reach APNs, including badge sync");
    assert.equal(fcmCalls.length, 0);
    assert.equal(webSends.length, 0);
    assert.equal(emits.length, 0);
    const row = await outbox(id!);
    assert.equal(row.status, "revoked");
    assert.equal(row.decision, "suppressed:event_missing");
  });
}

test("the sweep deletes terminal rows older than 14 days and revokes registrations not refreshed for 30 days", async ({ db }) => {
  const f = await seedFixture();
  const now = Date.now();
  const old = new Date(now - 15 * DAY);
  const young = new Date(now - 13 * DAY);
  const extra = await Promise.all(Array.from({ length: 4 }, (_, index) => f.post(f.channel.id, `sweep ${index}`)));
  const insertRow = async (message: { id: string; seq: number }, status: "delivered" | "failed" | "pending" | "processing" | "suppressed", createdAt: Date) => {
    const [row] = await db.insert(notificationOutbox).values({
      receiverType: "user", receiverId: f.owner.id, serverId: f.server.id, kind: "channel", sourceChannelId: f.channel.id,
      messageId: message.id, messageSeq: message.seq, activityAt: createdAt, eventKey: `message:${message.id}`, category: "channel",
      status, lockedAt: status === "processing" ? new Date(now) : null, createdAt,
    }).returning();
    return row!.id;
  };
  const oldDelivered = await insertRow(f.message, "delivered", old);
  const oldFailed = await insertRow(f.mention, "failed", old);
  const oldSuppressed = await insertRow(extra[0]!, "suppressed", old);
  const oldPending = await insertRow(extra[1]!, "pending", old);
  const oldProcessing = await insertRow(extra[2]!, "processing", old);
  const youngDelivered = await insertRow(extra[3]!, "delivered", young);

  const stale = await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "stale-registered" });
  const legacyStale = await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "stale-legacy" });
  const refreshed = await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "refreshed" });
  const fresh = await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "fresh" });
  await db.update(pushRegistrations).set({ lastRegisteredAt: new Date(now - 31 * DAY), updatedAt: new Date(now - 31 * DAY) }).where(eq(pushRegistrations.id, stale.id));
  await db.update(pushRegistrations).set({ lastRegisteredAt: null, updatedAt: new Date(now - 31 * DAY) }).where(eq(pushRegistrations.id, legacyStale.id));
  // Refreshed recently although the row itself was last updated long ago.
  await db.update(pushRegistrations).set({ lastRegisteredAt: new Date(now - DAY), updatedAt: new Date(now - 40 * DAY) }).where(eq(pushRegistrations.id, refreshed.id));

  const { skipped, ...result } = await sweepNotificationOutbox(now);
  assert.equal(skipped, false);
  assert.deepEqual(result, { deleted: 3, revokedRegistrations: 2 });

  const left = (await db.select({ id: notificationOutbox.id }).from(notificationOutbox)).map((row) => row.id).sort();
  assert.deepEqual(left, [oldPending, oldProcessing, youngDelivered].sort());
  void oldDelivered; void oldFailed; void oldSuppressed;

  const registrations = new Map((await db.select().from(pushRegistrations)).map((row) => [row.id, row]));
  for (const id of [stale.id, legacyStale.id]) {
    const row = registrations.get(id)!;
    assert.ok(row.revokedAt);
    assert.equal(row.revokedReason, "registration_not_refreshed");
    assert.equal(row.userId, null);
    assert.equal(row.revokedUserId, f.owner.id);
  }
  for (const id of [refreshed.id, fresh.id]) {
    assert.equal(registrations.get(id)!.revokedAt, null);
    assert.equal(registrations.get(id)!.userId, f.owner.id);
  }
});

// ---------------------------------------------------------------------------
// 11. Read retraction on the phone
// ---------------------------------------------------------------------------

test("reading a conversation that alerted retracts it on every socket and once on the phone", async ({ db }) => {
  const f = await seedFixture();
  const [other] = await db.insert(channels).values({ serverId: f.server.id, name: "random", type: "channel" }).returning();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "retract-install" });
  badgeValue = 4;
  await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.mention, { personalMention: true, category: "mention" })]);
  assert.equal(alerts().length, 1);
  const groupKey = `${f.server.id}:${f.channel.id}`;
  assert.equal(apnsBody(alerts()[0]).groupKey, groupKey);

  // The 2 s coalescing timer fires through the runtime seam. (Calling
  // flushPendingRetractionsForTests with a read still pending never returns:
  // the flush it starts is never removed from flushesInFlight.)
  const timers: Array<() => void> = [];
  __setRetractionRuntimeForTests({ setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  const read = async (conversationId: string, throughSeq: number | null) => {
    emits = [];
    apnsCalls = [];
    onConversationsRead(fakeIo, f.owner.id, f.server.id, [{ conversationId, throughSeq }]);
    assert.equal(timers.length, 1, "one coalescing timer per burst of reads");
    timers.splice(0)[0]!();
    await flushPendingRetractionsForTests();
  };

  badgeValue = 1;
  await read(f.channel.id, f.mention.seq);
  const payload = { serverId: f.server.id, groupKey, conversationId: f.channel.id, throughSeq: f.mention.seq };
  assert.deepEqual(emits.map((emit) => emit.room).sort(), ["desktop", "mobile", "web"].map((kind) => `user:${f.owner.id}:clientKind:${kind}`).sort());
  for (const emit of emits) {
    assert.equal(emit.event, "notification:retract");
    assert.deepEqual(emit.payload, payload);
  }
  assert.equal(apnsCalls.length, 1);
  assert.equal(apnsCalls[0]!.request.pushType, "background");
  assert.equal(apnsCalls[0]!.request.priority, "5");
  assert.deepEqual(apnsBody(apnsCalls[0]), { aps: { "content-available": 1 }, type: "retract", badge: 1, serverBadge: 1, ...payload });

  // The group was taken: reading it again only closes the sockets.
  await read(f.channel.id, f.mention.seq);
  assert.equal(emits.length, 3);
  assert.equal(apnsCalls.length, 0);

  // A conversation that never alerted on the phone.
  await read(other!.id, 9);
  assert.equal(emits.length, 3);
  assert.equal((emits[0]!.payload as { conversationId: string }).conversationId, other!.id);
  assert.equal(apnsCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 12. Events without a message
// ---------------------------------------------------------------------------

test("reminder and system notice rows are judged against the server level and delivered with their text", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "notice-install" });
  const agentId = "8b0f2f8e-7a43-4a3c-9d36-3f4f4bb0c001";
  const notice = (eventKey: string, category: "reminder" | "system_notice", payload: NotificationNoticePayload): NotificationEnqueueRow => ({
    receiverId: f.owner.id,
    serverId: f.server.id,
    kind: null,
    sourceChannelId: null,
    messageId: null,
    messageSeq: null,
    activityAt: new Date(),
    personalMention: true,
    eventKey,
    category,
    payload: payload as unknown as Record<string, unknown>,
  });
  const reminder = (id: string): NotificationEnqueueRow => notice(`reminder:${id}:2026-10-30T09:00:00.000Z`, "reminder", {
    title: "Reminder",
    body: "Water the plants",
    kind: "reminder",
    event: "reminder_fired",
    route: { type: "agent", serverId: f.server.id, agentId },
    groupKey: `${f.server.id}:reminder`,
  });

  await setServerLevel(f.owner.id, f.server.id, "none");
  const [silenced] = await enqueueAndDrain([reminder("r1")]);
  assert.equal((await outbox(silenced!)).decision, "suppressed:server_none");
  assert.equal(apnsCalls.length, 0);
  assert.equal(emits.length, 0);

  await setServerLevel(f.owner.id, f.server.id, "mentions");
  const [delivered] = await enqueueAndDrain([reminder("r2")]);
  const row = await outbox(delivered!);
  assert.equal(row.status, "delivered");
  assert.equal(row.decision, "notify");
  const body = apnsBody(alerts()[0]);
  assert.equal(body.aps.alert?.body, "Water the plants");
  assert.equal(body.aps.alert?.title, "Reminder");
  assert.equal(body.aps.alert?.subtitle, "Mobile Push");
  assert.equal(body.raftCategory, "reminder");
  assert.equal(body.groupKey, `${f.server.id}:reminder`);
  assert.equal(body.channelId, null, "a reminder has no conversation");
  assert.equal(body.messageId, null);
  assert.equal(body.kind, null);
  assert.equal(body.conversationId, null);
  assert.equal(body.seq, null);
  const mobileSocket = emits.find((emit) => emit.event === "notification:push")?.payload as Record<string, unknown> | undefined;
  assert.ok(mobileSocket, "the reminder reached the mobile socket");
  assert.equal(mobileSocket.body, "Water the plants");
  assert.equal(mobileSocket.groupKey, `${f.server.id}:reminder`);
  for (const key of ["kind", "channelId", "conversationId", "seq", "messageId", "threadId", "parentChannelId", "parentMessageId"]) {
    assert.equal(mobileSocket[key], null, `mobile socket ${key} is null for a reminder`);
  }
  const desktop = emits.find((emit) => emit.event === "notification:desktop")?.payload as { title: string; body: string; category: string } | undefined;
  assert.equal(desktop?.title, "Reminder");
  assert.equal(desktop?.body, "Water the plants");
  assert.equal(desktop?.category, "reminder");

  const [migration] = await enqueueAndDrain([notice("migration:m1", "system_notice", {
    title: "Confirm moving Scout to the cloud",
    body: "Scout is paused until you confirm.",
    kind: "agent",
    event: "system_notice",
    route: { type: "agent", serverId: f.server.id, agentId },
    agent: { id: agentId, name: "Scout" },
  })]);
  assert.equal((await outbox(migration!)).status, "delivered");
  assert.equal(apnsBody(alerts()[1]).aps.alert?.body, "Scout is paused until you confirm.");
  assert.equal(apnsBody(alerts()[1]).raftCategory, "system_notice");
});

test("a security notice (two-step verification recovery started) alerts past server level none and quiet hours; an ordinary system notice does not", async ({ db }) => {
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "security-install" });
  await setServerLevel(f.owner.id, f.server.id, "none");
  const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  await db.insert(userNotificationSettings).values({
    userId: f.owner.id, quietHoursEnabled: true, quietStartMinute: (minute + 1380) % 1440, quietEndMinute: (minute + 60) % 1440, timeZone: "UTC",
  });

  const ordinary = await enqueueNotificationRows([{
    receiverId: f.owner.id, serverId: f.server.id, kind: null, sourceChannelId: null, messageId: null, messageSeq: null,
    activityAt: new Date(), personalMention: true, eventKey: "migration:m-quiet", category: "system_notice",
    payload: { title: "Confirm", body: "Confirm the move.", kind: "agent", event: "system_notice", route: { type: "agent", serverId: f.server.id, agentId: "8b0f2f8e-7a43-4a3c-9d36-3f4f4bb0c002" } },
  }]);
  assert.equal(await runScheduled(), 1);
  assert.equal((await outbox(ordinary[0]!)).decision, "suppressed:server_none");
  assert.equal(alerts().length, 0);

  // What recovery.ts enqueues when the wait starts.
  await pushRecoveryStarted(f.owner.id, "00000000-0000-4000-8000-000000000001", new Date());
  assert.equal(await runScheduled(), 1);
  const [row] = await db.select().from(notificationOutbox)
    .where(and(eq(notificationOutbox.receiverId, f.owner.id), eq(notificationOutbox.eventKey, "second_factor_recovery:00000000-0000-4000-8000-000000000001")));
  assert.equal(row!.status, "delivered");
  assert.equal(row!.decision, "notify");
  const body = apnsBody(alerts()[0]);
  assert.equal(body.aps.alert?.title, "Someone asked to reset your two-step verification");
  assert.equal(body.raftCategory, "system_notice");
  assert.equal(body.routeUrl, `/s/${f.server.slug}/activity`);
  assert.equal(body.route ?? null, null);
});

test("hidden previews send APNs loc keys only to apps that know them (preview key set 1 vs 2)", async ({ db }) => {
  const f = await seedFixture();
  await db.insert(userNotificationSettings).values({ userId: f.owner.id, previewMode: "hidden" });
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "keys-legacy" });
  const current = await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "keys-2" });
  await db.update(pushRegistrations).set({ previewKeySet: 2 }).where(eq(pushRegistrations.id, current.id));

  await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.message, { personalMention: true, category: "task_status" })]);
  const alertOf = (installationId: string) => apnsBody(alerts().find((call) => call.installationId === installationId)).aps.alert;
  assert.deepEqual(alertOf("keys-legacy"), { title: "Raft", body: "You have a task update" }, "set 1 (NULL): plain English only");
  assert.deepEqual(alertOf("keys-2"), {
    title: "Raft",
    body: "You have a task update",
    "title-loc-key": "push.preview.hidden.title",
    "loc-key": "push.preview.hidden.task",
  });

  // A key set 1 knows: both get the keys.
  await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.mention, { personalMention: true, category: "mention" })]);
  const mentionAlerts = alerts().filter((call) => apnsBody(call).messageId === f.mention.id).map((call) => apnsBody(call).aps.alert);
  assert.equal(mentionAlerts.length, 2);
  for (const alert of mentionAlerts) {
    assert.deepEqual(alert, { title: "Raft", body: "You were mentioned", "title-loc-key": "push.preview.hidden.title", "loc-key": "push.preview.hidden.mention" });
  }
});

// ---------------------------------------------------------------------------
// 13. Fan-out bounds
// ---------------------------------------------------------------------------

test("a 1,000-receiver channel event keeps at most 32 external sends in flight and every row ends delivered", async ({ db }) => {
  const RECEIVERS = 1_000;
  const f = await seedFixture();
  registerNotificationSocketServer(null);
  const receiverIds: string[] = [];
  const rows = Array.from({ length: RECEIVERS }, (_, index) => ({ email: `fanout-${index}@test.com`, name: `fanout-${index}`, passwordHash: "x", emailVerified: true }));
  for (let start = 0; start < rows.length; start += 250) {
    receiverIds.push(...(await db.insert(users).values(rows.slice(start, start + 250)).returning({ id: users.id })).map((row) => row.id));
  }
  for (let start = 0; start < RECEIVERS; start += 250) {
    const chunk = receiverIds.slice(start, start + 250);
    await db.insert(serverMembers).values(chunk.map((userId) => ({ serverId: f.server.id, userId, role: "member" as const })));
    const families = await db.insert(sessionFamilies).values(chunk.map((userId) => ({ userId }))).returning();
    await db.insert(sessions).values(families.map((family) => ({ userId: family.userId, familyId: family.id, tokenHash: `fanout-${family.id}`, expiresAt: new Date(Date.now() + 60 * MINUTE) })));
    await db.insert(pushRegistrations).values(families.map((family) => ({
      installationId: `fanout-${family.userId}`, provider: "apns" as const, userId: family.userId, serverId: f.server.id,
      sessionFamilyId: family.id, deviceToken: `fanout-token-${family.userId}`, topic: "build.raft.app", env: "production" as const,
    })));
  }
  let inFlight = 0;
  let maxInFlight = 0;
  apnsBehavior = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return { status: "sent" };
  };
  const activityAt = new Date();

  const ids = await enqueueAndDrain(receiverIds.map((receiverId) => messageRow(receiverId, f.server.id, f.channel.id, f.message, { activityAt })));

  assert.equal(ids.length, RECEIVERS);
  assert.equal(alerts().length, RECEIVERS);
  assert.ok(maxInFlight <= NOTIFICATION_EXTERNAL_CONCURRENCY, `at most ${NOTIFICATION_EXTERNAL_CONCURRENCY} in flight, saw ${maxInFlight}`);
  assert.equal(maxInFlight, NOTIFICATION_EXTERNAL_CONCURRENCY, "the pool is used in parallel");
  const [summary] = await db.select({
    delivered: sql<number>`count(*) filter (where ${notificationOutbox.status} = 'delivered')::int`,
    processedAt: sql<number>`count(distinct ${notificationOutbox.processedAt})::int`,
  }).from(notificationOutbox).where(inArray(notificationOutbox.id, ids));
  assert.equal(summary?.delivered, RECEIVERS);
  assert.equal(summary?.processedAt, 1, "the identical results are written in one batched UPDATE");
});

test("a provider stuck until its deadline fills only its own lane: Web Push still goes out to everyone", async ({ db }) => {
  // More APNs sends than one lane holds, each hanging (a cold APNs connection
  // timing out). Before the lanes, the 32 shared slots all waited on APNs and
  // the Web Push sends queued behind them waited too.
  const RECEIVERS = NOTIFICATION_EXTERNAL_CONCURRENCY + 8;
  const f = await seedFixture();
  registerNotificationSocketServer(null);
  const receiverIds = (await db.insert(users).values(Array.from({ length: RECEIVERS }, (_, index) => ({
    email: `lane-${index}@test.com`, name: `lane-${index}`, passwordHash: "x", emailVerified: true,
  }))).returning({ id: users.id })).map((row) => row.id);
  await db.insert(serverMembers).values(receiverIds.map((userId) => ({ serverId: f.server.id, userId, role: "member" as const })));
  const families = await db.insert(sessionFamilies).values(receiverIds.map((userId) => ({ userId }))).returning();
  await db.insert(sessions).values(families.map((family) => ({ userId: family.userId, familyId: family.id, tokenHash: `lane-${family.id}`, expiresAt: new Date(Date.now() + 60 * MINUTE) })));
  await db.insert(pushRegistrations).values(families.map((family) => ({
    installationId: `lane-${family.userId}`, provider: "apns" as const, userId: family.userId, serverId: f.server.id,
    sessionFamilyId: family.id, deviceToken: `lane-token-${family.userId}`, topic: "build.raft.app", env: "production" as const,
  })));
  await db.insert(pushSubscriptions).values(receiverIds.map((userId) => ({ userId, endpoint: `https://fcm.googleapis.com/fcm/send/lane-${userId}`, p256dh: P256DH, auth: AUTH })));
  let releaseApns!: () => void;
  const apnsGate = new Promise<void>((resolve) => { releaseApns = resolve; });
  apnsBehavior = async () => {
    await apnsGate;
    return { status: "sent" };
  };

  const draining = enqueueAndDrain(receiverIds.map((receiverId) => messageRow(receiverId, f.server.id, f.channel.id, f.message)));
  await waitFor(() => webSends.length === RECEIVERS, "every Web Push send goes out while APNs hangs");
  assert.equal(apnsCalls.length, NOTIFICATION_EXTERNAL_CONCURRENCY, "APNs stays within its own bound");
  releaseApns();
  const ids = await draining;
  assert.equal(apnsCalls.length, RECEIVERS);
  for (const id of ids) {
    const counts = countsOf(await outbox(id));
    assert.equal(counts.web, 1);
    assert.equal(counts.apns, 1);
  }
});

test("a Web Push subscription made for another VAPID key is deleted; a bare 403 drops the send and keeps it", async ({ db }) => {
  const f = await seedFixture();
  const kept = await subscribe(f.owner.id, "https://fcm.googleapis.com/fcm/send/bare-403");
  await subscribe(f.owner.id, "https://web.push.apple.com/stale-apple");
  await subscribe(f.owner.id, "https://fcm.googleapis.com/fcm/send/stale-fcm");
  webBehavior = async (send) => {
    if (send.endpoint.endsWith("bare-403")) throw Object.assign(new Error("forbidden"), { statusCode: 403, body: "" });
    if (send.endpoint.endsWith("stale-apple")) throw Object.assign(new Error("forbidden"), { statusCode: 403, body: JSON.stringify({ reason: "VapidPkHashMismatch" }) });
    if (send.endpoint.endsWith("stale-fcm")) {
      throw Object.assign(new Error("forbidden"), { statusCode: 403, body: "the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions." });
    }
  };

  const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);

  const left = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, f.owner.id));
  assert.deepEqual(left.map((row) => row.id), [kept.id]);
  assert.equal(webSends.filter((send) => send.endpoint.endsWith("bare-403")).length, 1, "a 403 is not retried");
  const counts = countsOf(await outbox(id!));
  assert.equal(counts.revoked, 2);
  assert.equal(counts.failed, 1);
  const [row] = await db.select({ lastError: notificationOutbox.lastError }).from(notificationOutbox).where(eq(notificationOutbox.id, id!));
  assert.match(String(row?.lastError), /^webPush status_403:(fcm|apple)/, "the failure names the push service");
});

test("an APNs registration for a topic outside the allowlist is revoked on its next send without contacting Apple", async ({ db }) => {
  const f = await seedFixture();
  registerNotificationSocketServer(null);
  // A row stored before the allowlist (e.g. a third-party build pointed at this server).
  const foreign = await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "foreign-build", topic: "dev.vgent.raft.app" });
  await db.update(pushRegistrations).set({ appVersion: "1.0" }).where(eq(pushRegistrations.id, foreign.id));
  const ours = await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "our-build" });

  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  let id: string | undefined;
  await runWithTraceSpan(span, async () => {
    [id] = await enqueueNotificationRows([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);
    scheduled = [];
    await drainNotificationRows([id!]);
  }, tracer);
  span.end();

  assert.deepEqual(apnsCalls.map((call) => call.installationId), ["our-build"], "Apple only sees the allowlisted topic");
  const [revoked] = await db.select().from(pushRegistrations).where(eq(pushRegistrations.id, foreign.id));
  assert.ok(revoked?.revokedAt);
  assert.equal(revoked.revokedReason, "topic_not_allowed");
  const [kept] = await db.select().from(pushRegistrations).where(eq(pushRegistrations.id, ours.id));
  assert.equal(kept?.revokedAt, null);
  const done = await outbox(id!);
  assert.equal(done.status, "delivered");
  assert.equal(countsOf(done).revoked, 1);
  assert.deepEqual(done.firstFailure, {
    provider: "apns", reason: "topic_not_allowed", status: null,
    target: { topic: "dev.vgent.raft.app", env: "production", appVersion: "1.0" },
  });
  const traces = JSON.stringify({ spans: sink.getAllSpans(), logs: sink.getAllLogEvents() });
  assert.ok(traces.includes("dev.vgent.raft.app"), "the revoke event names the topic");
  assert.equal(traces.includes("token-foreign-build"), false, "never the device token");
});

test("APNs TopicDisallowed for an allowlisted topic is not retried and does not revoke; the record names topic and env", async ({ db }) => {
  const f = await seedFixture();
  registerNotificationSocketServer(null);
  const registration = await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "key-misconfigured", env: "sandbox" });
  apnsBehavior = async () => { throw new ApnsDeliveryError("APNs rejected mobile push", { statusCode: 400, reason: "TopicDisallowed" }); };

  const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);

  assert.equal(apnsCalls.length, 1, "a 400 is not retried");
  assert.deepEqual(sleeps, []);
  const [row] = await db.select().from(pushRegistrations).where(eq(pushRegistrations.id, registration.id));
  assert.equal(row?.revokedAt, null, "a key that cannot push to our own app must not wipe every registration");
  assert.deepEqual((await outbox(id!)).firstFailure, {
    provider: "apns", reason: "TopicDisallowed", status: 400,
    target: { topic: "build.raft.app", env: "sandbox", appVersion: null },
  });
});

test("a Web Push subscription on an unsupported host is skipped and kept; a browser-removed one is deleted", async ({ db }) => {
  const f = await seedFixture();
  registerNotificationSocketServer(null);
  const unsupported = await subscribe(f.owner.id, "https://push.vgent.dev/push/secret-subscription-path");
  await subscribe(f.owner.id, "https://permanently-removed.invalid/fcm/send/gone");
  const known = await subscribe(f.owner.id, "https://jmt17.google.com/fcm/send/known");

  const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);

  assert.deepEqual(webSends.map((send) => send.endpoint), ["https://jmt17.google.com/fcm/send/known"]);
  assert.equal(webLookups.includes("push.vgent.dev"), false, "not even resolved");
  const left = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, f.owner.id));
  assert.deepEqual(left.map((row) => row.id).sort(), [unsupported.id, known.id].sort(), "only the removed one is deleted");
  const done = await outbox(id!);
  assert.equal(done.status, "delivered");
  assert.equal(countsOf(done).web, 1);
  assert.equal(countsOf(done).revoked, 1);
  assert.equal(countsOf(done).failed, 0, "an unsupported host is a skip, not a failure");
  assert.deepEqual(done.firstFailure, {
    provider: "webPush", reason: "endpoint_removed", status: null,
    target: { host: "permanently-removed.invalid" },
  });
});

test("every dispatched group reports its claim and per-phase timings, including each send lane", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "phases-phone" });
  await subscribe(f.owner.id, "https://fcm.googleapis.com/fcm/send/phases");
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  await runWithTraceSpan(span, async () => {
    const ids = await enqueueNotificationRows([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);
    scheduled = [];
    await drainNotificationRows(ids);
  }, tracer);
  span.end();
  const events = [...sink.getAllSpans().flatMap((entry) => entry.events), ...sink.getAllLogEvents()];
  const attrsOf = (name: string): Record<string, unknown> => {
    const event = events.find((entry) => entry.name === name);
    assert.ok(event, `${name} recorded`);
    return event.attrs ?? {};
  };
  assert.equal(attrsOf("notification.claim").claimed_count, 1);
  assert.equal(typeof attrsOf("notification.claim").duration_ms, "number");
  const phases = attrsOf("notification.dispatch.phases");
  assert.equal(phases.outcome, "ok");
  assert.equal(phases.row_count, 1);
  for (const phase of ["load_event", "policy", "devices", "last_badges", "fence", "prepare", "record_deferrals", "sends", "badge_wait", "syncs", "write", "lane_socket", "lane_webPush", "lane_apns", "total"]) {
    assert.equal(typeof phases[`${phase}_ms`], "number", `${phase}_ms`);
  }
});

// ---------------------------------------------------------------------------
// Review follow-ups: access re-check, partial-send retry, lease, sweep lock
// ---------------------------------------------------------------------------

test("a receiver removed from a private channel before the drain is suppressed with no_access; a member still gets it", async ({ db }) => {
  const f = await seedFixture();
  const stays = await f.member("StaysInChannel");
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "removed-phone" });
  await register({ userId: stays.user.id, serverId: f.server.id, familyId: stays.family.id, installationId: "member-phone" });
  const [secret] = await db.insert(channels).values({ serverId: f.server.id, name: "secret", type: "private" }).returning();
  await db.insert(channelHumans).values([{ channelId: secret!.id, userId: f.owner.id }, { channelId: secret!.id, userId: stays.user.id }]);
  const message = await f.post(secret!.id, "private plans");
  const ids = await enqueueNotificationRows([
    messageRow(f.owner.id, f.server.id, secret!.id, message),
    messageRow(stays.user.id, f.server.id, secret!.id, message),
  ]);
  // Removed between the send and the drain.
  await db.delete(channelHumans).where(and(eq(channelHumans.channelId, secret!.id), eq(channelHumans.userId, f.owner.id)));
  await runScheduled();

  const removed = await outbox(ids[0]!);
  assert.equal(removed.status, "suppressed");
  assert.equal(removed.decision, "suppressed:no_access");
  assert.equal(emits.some((emit) => emit.room.startsWith(`user:${f.owner.id}:`)), false, "no socket for the removed reader");
  assert.equal(alerts().filter((call) => call.installationId === "removed-phone").length, 0, "no alert for the removed reader");
  assert.equal((await outbox(ids[1]!)).status, "delivered");
  assert.equal(alerts().filter((call) => call.installationId === "member-phone").length, 1);
});

test("a retry after a partial send skips what already went: one alert, one mobile socket, the failed desktop emit goes on retry", async ({ db }) => {
  void db;
  __resetNotificationSendLedgerForTests();
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "partial-phone" });
  let desktopFailures = 1;
  registerNotificationSocketServer({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        if (event === "notification:desktop" && desktopFailures-- > 0) throw new Error("socket adapter down");
        emits.push({ room, event, payload });
      },
    }),
  } as unknown as SocketServer);
  const [id] = await enqueueNotificationRows([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);
  await runScheduled();

  // The desktop emit failed: the group went back to pending, but the other
  // transports in the same pass still ran (a failed task does not stop them).
  const afterFirst = await outbox(id!);
  assert.equal(afterFirst.status, "pending");
  assert.equal(alerts().length, 1);
  assert.equal(emits.filter((emit) => emit.event === "notification:push").length, 1);
  assert.equal(emits.filter((emit) => emit.event === "notification:desktop").length, 0);

  const retry = await drainNotificationRows([id!]);
  assert.equal(retry.claimed, 1);
  assert.equal((await outbox(id!)).status, "delivered");
  assert.equal(alerts().length, 1, "the phone is not alerted twice");
  assert.equal(emits.filter((emit) => emit.event === "notification:push").length, 1, "the mobile socket is not sent twice");
  assert.equal(emits.filter((emit) => emit.event === "notification:desktop").length, 1, "the desktop emit that failed goes on the retry");
});

test("a slow group renews its lease (not reclaimed meanwhile); a reclaimed row's late result is not written", async ({ db }) => {
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "slow-phone" });
  let renew: (() => void) | null = null;
  __setNotificationDispatchRuntimeForTests({
    leaseRenewMs: 1_000,
    setInterval: (fn) => { renew = fn; return 1; },
    clearInterval: () => { renew = null; },
  });
  const [id] = await enqueueNotificationRows([messageRow(f.owner.id, f.server.id, f.channel.id, f.message)]);
  let stage: "renew" | "reclaim" = "renew";
  let reclaimId = "";
  apnsBehavior = async () => {
    if (stage === "renew") {
      // The lock is about to go stale (> 5 min old) while APNs is slow...
      await db.update(notificationOutbox).set({ lockedAt: new Date(Date.now() - 6 * MINUTE) }).where(eq(notificationOutbox.id, id!));
      assert.ok(renew, "a lease renewal is armed while the group runs");
      renew!();
      await waitFor(async () => (await outbox(id!)).lockedAt!.getTime() > Date.now() - MINUTE, "the lease was renewed");
      // ...so another replica's drain cannot take it.
      assert.equal((await drainNotificationOutbox()).claimed, 0, "a renewed lease is not reclaimed");
    } else {
      // Another replica reclaimed the row (its claim bumps attempt_count).
      await db.update(notificationOutbox).set({ attemptCount: sql`${notificationOutbox.attemptCount} + 1` }).where(eq(notificationOutbox.id, reclaimId));
    }
    return { status: "sent" };
  };
  await runScheduled();
  assert.equal((await outbox(id!)).status, "delivered");
  assert.equal(renew, null, "the renewal stops with the group");

  stage = "reclaim";
  const [second] = await enqueueNotificationRows([messageRow(f.owner.id, f.server.id, f.channel.id, f.mention, { category: "mention", personalMention: true })]);
  reclaimId = second!;
  await runScheduled();
  const stolen = await outbox(second!);
  assert.equal(stolen.status, "processing", `the stale run's result is not written over the new owner's claim (${stolen.status})`);
});

test("the sweep deletes the oldest terminal rows first, in short batches, stops at its time budget and starts the next pass at the next status", async ({ db }) => {
  const f = await seedFixture();
  const now = Date.now();
  __resetNotificationSweepStatusOffsetForTests();
  const messages = [f.message, f.mention, ...await Promise.all(Array.from({ length: 4 }, (_, index) => f.post(f.channel.id, `budget ${index}`)))];
  // Three "sent" rows (oldest first: 0, 1, 2), three "skipped" rows (3, 4, 5).
  const ids: string[] = [];
  for (const [index, message] of messages.entries()) {
    const createdAt = new Date(now - (20 - index) * DAY);
    const [row] = await db.insert(notificationOutbox).values({
      receiverType: "user", receiverId: f.owner.id, serverId: f.server.id, kind: "channel", sourceChannelId: f.channel.id,
      messageId: message.id, messageSeq: message.seq, activityAt: createdAt, eventKey: `message:${message.id}`, category: "channel",
      status: index < 3 ? "sent" : "skipped", createdAt,
    }).returning();
    ids.push(row!.id);
  }
  const left = async () => (await db.select({ id: notificationOutbox.id }).from(notificationOutbox)).map((row) => row.id).sort();

  // A spent budget stops after one batch: the two oldest "sent" rows go, the newest stays.
  assert.equal((await sweepNotificationOutbox(now, { batchSize: 2, budgetMs: 0, pauseMs: 0 })).deleted, 2);
  assert.deepEqual(await left(), [ids[2], ids[3], ids[4], ids[5]].sort());

  // The next pass starts at the next status ("skipped"), so "sent" cannot starve it.
  assert.equal((await sweepNotificationOutbox(now, { batchSize: 2, budgetMs: 0, pauseMs: 0 })).deleted, 2);
  assert.deepEqual(await left(), [ids[2], ids[5]].sort());

  // With time left a pass finishes the backlog, batch by batch.
  assert.equal((await sweepNotificationOutbox(now, { batchSize: 2, pauseMs: 0 })).deleted, 2);
  assert.deepEqual(await left(), []);
});

test("the maintenance pass runs at start under its advisory lock and skips while another replica holds it", async ({ db }) => {
  const f = await seedFixture();
  const old = new Date(Date.now() - 15 * DAY);
  const [row] = await db.insert(notificationOutbox).values({
    receiverType: "user", receiverId: f.owner.id, serverId: f.server.id, kind: "channel", sourceChannelId: f.channel.id,
    messageId: f.message.id, messageSeq: f.message.seq, activityAt: old, status: "delivered", createdAt: old,
  }).returning();

  __setNotificationSweepLockHeldElsewhereForTests(true);
  try {
    assert.deepEqual(await sweepNotificationOutbox(), { deleted: 0, revokedRegistrations: 0, skipped: true });
    assert.ok(await outbox(row!.id), "nothing deleted while another replica holds the lock");
  } finally {
    __setNotificationSweepLockHeldElsewhereForTests(false);
  }

  // Start-up runs the pass at once, not after the first interval.
  const worker = startNotificationDispatcher({ clock: { scheduleEvery: () => 1, clearInterval: () => undefined } });
  try {
    await waitFor(async () => (await db.select().from(notificationOutbox).where(eq(notificationOutbox.id, row!.id))).length === 0, "the start-up pass deleted the 15-day-old terminal row");
  } finally {
    await worker.stop();
  }
});

test("mobileDelay holds only the phone alert while a computer is in use, then alerts it, skips it once read, and gives up past the deadline", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "delay-install" });
  const updated = await updateAccountNotificationSettings(f.owner.id, { mobileDelay: "2m" });
  assert.equal(updated.kind === "updated" && updated.settings.mobileDelay, "2m");

  let clock = Date.now();
  __setNotificationDispatchRuntimeForTests({ now: () => clock });
  const deferralOf = async (outboxId: string) => {
    const [row] = await getDb().select().from(notificationMobileDeferrals).where(eq(notificationMobileDeferrals.outboxId, outboxId));
    return row;
  };
  async function send(content: string) {
    __resetNotificationPresenceForTests();
    // On the desktop app a few seconds ago.
    await recordPresenceActivity(f.owner.id, "desktop", { active: true, idleSeconds: 5 }, clock);
    emits = [];
    apnsCalls = [];
    const message = await f.post(f.channel.id, content);
    const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, message)]);
    return { id: id!, message };
  }

  // 1. The computer alerts at once; the phone only gets the badge sync, its alert is held.
  const first = await send("held");
  const firstRow = await outbox(first.id);
  assert.equal(firstRow.status, "delivered");
  assert.equal(emits.filter((emit) => emit.event === "notification:desktop").length, 1, "the desktop is not delayed");
  assert.equal(alerts().length, 0, "no phone alert yet");
  assert.equal(backgrounds().length, 1, "the badge sync goes now");
  assert.equal(countsOf(firstRow).mobileDeferred, 1);
  let deferral = await deferralOf(first.id);
  assert.equal(deferral?.status, "pending");
  const lastInput = clock - 5_000;
  assert.equal(deferral?.dueAt.getTime(), lastInput + 2 * MINUTE, "last computer input + 2 minutes");
  assert.equal(deferral?.deadlineAt.getTime(), firstRow.activityAt.getTime() + 22 * MINUTE, "message time + delay + 20 minutes");
  assert.equal(await drainMobileDeferrals(), 0, "not due yet");

  // 2. Due, and the computer has been idle since: the phone alerts.
  clock += 2 * MINUTE;
  apnsCalls = [];
  assert.equal(await drainMobileDeferrals(), 1);
  assert.equal(alerts().length, 1);
  deferral = await deferralOf(first.id);
  assert.deepEqual([deferral?.status, deferral?.outcome], ["sent", "sent"]);
  assert.equal(await drainMobileDeferrals(), 0, "sent once");

  // 3. Read on the computer before it is due: the retraction rule skips it.
  const second = await send("read before due");
  await getDb().insert(userChannelReadCursors)
    .values({ userId: f.owner.id, channelId: f.channel.id, lastReadSeq: second.message.seq })
    .onConflictDoUpdate({ target: [userChannelReadCursors.userId, userChannelReadCursors.channelId], set: { lastReadSeq: second.message.seq } });
  clock += 2 * MINUTE;
  apnsCalls = [];
  assert.equal(await drainMobileDeferrals(), 1);
  assert.equal(alerts().length, 0);
  deferral = await deferralOf(second.id);
  assert.deepEqual([deferral?.status, deferral?.outcome], ["skipped", "read"]);

  // 4. Still on the computer at every due time: moved later, then given up at the deadline.
  const third = await send("never idle");
  const thirdDeadline = (await deferralOf(third.id))!.deadlineAt.getTime();
  for (let step = 0; step < 30 && (await deferralOf(third.id))?.status === "pending"; step += 1) {
    clock = Math.min((await deferralOf(third.id))!.dueAt.getTime(), thirdDeadline);
    await recordPresenceActivity(f.owner.id, "desktop", { active: true, idleSeconds: 0 }, clock);
    await drainMobileDeferrals();
  }
  deferral = await deferralOf(third.id);
  assert.deepEqual([deferral?.status, deferral?.outcome], ["skipped", "still_active_deadline"]);
  assert.ok((deferral?.extensions ?? 0) > 0, "it was moved at least once");
  assert.equal(alerts().length, 0, "the phone never rang");

  __resetNotificationDispatchRuntimeForTests();
  installHarness();
});


test("Raft in the background on a computer in use keeps the phone quiet (inactive); a lock lets it ring", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "unfocused-install" });
  async function deliver(report: { active: boolean; idleSeconds: number | null; locked?: boolean; attended?: boolean }) {
    __resetNotificationPresenceForTests();
    await recordPresenceActivity(f.owner.id, "desktop", report, Date.now());
    emits = [];
    apnsCalls = [];
    const message = await f.post(f.channel.id, "unfocused");
    const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, message)]);
    return {
      desktop: emits.filter((emit) => emit.event === "notification:desktop").length,
      alerts: alerts().length,
      counts: countsOf(await outbox(id!)),
    };
  }
  // Typing in another app: the desktop app alerts (its own gate shows it, Raft is not in front); no phone.
  let result = await deliver({ active: true, idleSeconds: 4, locked: false, attended: false });
  assert.deepEqual([result.desktop, result.alerts], [1, 0]);
  assert.deepEqual(result.counts.skippedByPresence, ["mobile"]);
  // Screen locked a moment ago: nobody at the computer, the phone rings.
  result = await deliver({ active: false, idleSeconds: 4, locked: true, attended: false });
  assert.deepEqual([result.desktop, result.alerts], [1, 1]);
  // An older client that is not focused: today's behaviour, nothing active, the phone rings.
  result = await deliver({ active: false, idleSeconds: 4 });
  assert.deepEqual([result.desktop, result.alerts], [1, 1]);
});

test("reading a conversation cancels its held phone alerts at once, up to the read position", async ({ db }) => {
  void db;
  const f = await seedFixture();
  const [other] = await db.insert(channels).values({ serverId: f.server.id, name: "elsewhere", type: "channel" }).returning();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "cancel-install" });
  await updateAccountNotificationSettings(f.owner.id, { mobileDelay: "5m" });
  const deferralOf = async (outboxId: string) => {
    const [row] = await getDb().select().from(notificationMobileDeferrals).where(eq(notificationMobileDeferrals.outboxId, outboxId));
    return row;
  };
  async function send(channelId: string, content: string) {
    __resetNotificationPresenceForTests();
    // Raft in the background, the computer in use.
    await recordPresenceActivity(f.owner.id, "desktop", { active: true, idleSeconds: 5, locked: false, attended: false }, Date.now());
    const message = await f.post(channelId, content);
    const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, channelId, message)]);
    assert.equal((await deferralOf(id!))?.status, "pending", content);
    return { id: id!, message };
  }
  const first = await send(f.channel.id, "first");
  const second = await send(f.channel.id, "second");
  const elsewhere = await send(other!.id, "elsewhere");

  // No socket server needed: the cancel does not wait for the retraction window.
  onConversationsRead(undefined, f.owner.id, f.server.id, [{ conversationId: f.channel.id, throughSeq: first.message.seq }]);
  await flushPendingRetractionsForTests();
  assert.deepEqual([(await deferralOf(first.id))?.status, (await deferralOf(first.id))?.outcome], ["skipped", "read"]);
  assert.ok((await deferralOf(first.id))?.processedAt, "ended now, not at its due time");
  assert.equal((await deferralOf(second.id))?.status, "pending", "past the read position: still held");
  assert.equal((await deferralOf(elsewhere.id))?.status, "pending", "another conversation: still held");

  // Read everything (null position) in the channel.
  onConversationsRead(undefined, f.owner.id, f.server.id, [{ conversationId: f.channel.id, throughSeq: null }]);
  await flushPendingRetractionsForTests();
  assert.deepEqual([(await deferralOf(second.id))?.status, (await deferralOf(second.id))?.outcome], ["skipped", "read"]);
  assert.equal((await deferralOf(elsewhere.id))?.status, "pending");

  // Nothing due fires for the cancelled ones.
  apnsCalls = [];
  __setNotificationDispatchRuntimeForTests({ now: () => Date.now() + 6 * MINUTE });
  await drainMobileDeferrals();
  assert.equal(alerts().length, 1, "only the unread conversation's alert went");
  assert.equal((await deferralOf(elsewhere.id))?.status, "sent");
  __resetNotificationDispatchRuntimeForTests();
  installHarness();
});

test("B1: a browser in use with no Web Push subscription never leaves a message alerting nowhere", async ({ db }) => {
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "browser-only-install" });
  const deferralOf = async (outboxId: string) => {
    const [row] = await getDb().select().from(notificationMobileDeferrals).where(eq(notificationMobileDeferrals.outboxId, outboxId));
    return row;
  };
  const endpoint = "https://fcm.googleapis.com/fcm/send/browser-only";
  const tab = { locked: false, attended: true, pushSubscribed: true, pushEndpointHash: pushEndpointHash(endpoint) };
  async function deliver(content: string) {
    __resetNotificationPresenceForTests();
    // Typing in the Raft tab a few seconds ago (computer-active protocol); no desktop app.
    await recordPresenceActivity(f.owner.id, "web", { active: true, idleSeconds: 3, ...tab }, Date.now());
    emits = [];
    apnsCalls = [];
    webSends = [];
    const message = await f.post(f.channel.id, content);
    const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, message)]);
    return { id: id!, web: webSends.length, alerts: alerts().length, counts: countsOf(await outbox(id!)) };
  }

  // No subscription (permission never granted, Safari, revoked): the phone rings.
  let result = await deliver("no subscription");
  assert.deepEqual([result.web, result.alerts], [0, 1]);
  assert.equal(result.counts.skippedByPresence.includes("mobile"), false);

  // The same with a delay: nothing is held for a browser that cannot be alerted.
  await updateAccountNotificationSettings(f.owner.id, { mobileDelay: "5m" });
  result = await deliver("no subscription, 5m");
  assert.deepEqual([result.web, result.alerts], [0, 1]);
  assert.equal(await deferralOf(result.id), undefined, "no held alert to drop at the deadline");

  // With a subscription the browser is the computer in use: Web Push, the phone is held.
  await subscribe(f.owner.id, endpoint);
  result = await deliver("subscribed, 5m");
  assert.deepEqual([result.web, result.alerts], [1, 0]);
  assert.equal((await deferralOf(result.id))?.status, "pending");

  // The subscription is revoked before the held alert is due: at its due time
  // the browser no longer counts, so the phone alerts even though the tab was just used.
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, f.owner.id));
  await recordPresenceActivity(f.owner.id, "web", { active: true, idleSeconds: 0, ...tab }, Date.now());
  apnsCalls = [];
  __setNotificationDispatchRuntimeForTests({ now: () => Date.now() + 5 * MINUTE + 1_000 });
  await recordPresenceActivity(f.owner.id, "web", { active: true, idleSeconds: 0, ...tab }, Date.now() + 5 * MINUTE + 1_000);
  await drainMobileDeferrals();
  assert.equal(alerts().length, 1, "sent at the due time instead of being moved or dropped");
  assert.equal((await deferralOf(result.id))?.status, "sent");
  __resetNotificationDispatchRuntimeForTests();
  installHarness();
});

// ---------------------------------------------------------------------------
// Never alert nowhere: delivery confirmation (SF1, SF2)
// ---------------------------------------------------------------------------

test("SF1: a desktop that acks keeps the phone quiet; no ack (half-open socket, crashed replica) alerts the phone", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "ack-install" });
  async function deliver(acks: number, report: Record<string, unknown> = { ackAlerts: true }) {
    __resetNotificationPresenceForTests();
    await recordPresenceActivity(f.owner.id, "desktop", { active: true, idleSeconds: 4, locked: false, attended: false, ...report }, Date.now());
    desktopAckers = acks > 0 ? ["default"] : [];
    emits = [];
    apnsCalls = [];
    const message = await f.post(f.channel.id, `acks ${acks}`);
    const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, message)]);
    const desktopEmits = emits.filter((emit) => emit.event === "notification:desktop");
    return { acked: desktopEmits.every((emit) => emit.acked === true) && desktopEmits.length > 0, alerts: alerts().length, counts: countsOf(await outbox(id!)) };
  }
  let result = await deliver(1);
  assert.deepEqual([result.acked, result.alerts], [true, 0], "acked: the computer has it, the phone stays quiet");
  assert.deepEqual(result.counts.skippedByPresence, ["mobile"]);

  result = await deliver(0);
  assert.deepEqual([result.acked, result.alerts], [true, 1], "nobody acked: the phone alerts");
  assert.equal(result.counts.desktopUnconfirmed, 1);
  assert.equal(result.counts.mobileFallback, 1);
  assert.equal(result.counts.skippedByPresence.includes("mobile"), false);

  // An older desktop (no ackAlerts) is trusted as before: no ack wait, no double alert.
  result = await deliver(0, {});
  assert.deepEqual([result.acked, result.alerts], [false, 0]);
});

test("SF1: a held phone alert whose desktop did not ack alerts at once and the held row ends", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "ack-held-install" });
  await updateAccountNotificationSettings(f.owner.id, { mobileDelay: "5m" });
  __resetNotificationPresenceForTests();
  await recordPresenceActivity(f.owner.id, "desktop", { active: true, idleSeconds: 4, locked: false, ackAlerts: true }, Date.now());
  desktopAckers = [];
  apnsCalls = [];
  const message = await f.post(f.channel.id, "held, no ack");
  const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, message)]);
  assert.equal(alerts().length, 1);
  const [deferral] = await getDb().select().from(notificationMobileDeferrals).where(eq(notificationMobileDeferrals.outboxId, id!));
  assert.deepEqual([deferral?.status, deferral?.outcome], ["skipped", "computer_unconfirmed_sent"]);
  apnsCalls = [];
  __setNotificationDispatchRuntimeForTests({ now: () => Date.now() + 6 * MINUTE });
  await drainMobileDeferrals();
  assert.equal(alerts().length, 0, "not alerted twice");
  __resetNotificationDispatchRuntimeForTests();
  installHarness();
});

test("SF1: a crashed replica's entry (ack-capable, not refreshed) never keeps the phone quiet", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "ghost-install" });
  __resetNotificationPresenceForTests();
  // Written 100 s ago by a replica that died: still "online" (150 s), active input, but stale.
  await recordPresenceActivity(f.owner.id, "desktop", { active: true, idleSeconds: 0, locked: false, ackAlerts: true }, Date.now() - 100_000);
  desktopAckers = [];
  apnsCalls = [];
  const message = await f.post(f.channel.id, "ghost");
  await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, message)]);
  assert.equal(alerts().length, 1);
});

test("SF2: the tab's own browser must hold the subscription, and a Web Push that fails everywhere alerts the phone", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "per-browser-install" });
  const browserB = "https://fcm.googleapis.com/fcm/send/browser-b";
  await subscribe(f.owner.id, browserB);
  async function deliver(hash: string | null) {
    __resetNotificationPresenceForTests();
    await recordPresenceActivity(f.owner.id, "web", { active: true, idleSeconds: 2, locked: false, attended: true, pushSubscribed: hash !== null, pushEndpointHash: hash }, Date.now());
    apnsCalls = [];
    webSends = [];
    const message = await f.post(f.channel.id, `tab ${hash}`);
    const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, message)]);
    return { web: webSends.length, alerts: alerts().length, counts: countsOf(await outbox(id!)) };
  }
  // A tab in browser A (no permission there): the subscription lives in B, so the phone alerts.
  let result = await deliver(null);
  assert.equal(result.alerts, 1);
  // The tab is browser B itself: Web Push, phone quiet.
  result = await deliver(pushEndpointHash(browserB));
  assert.deepEqual([result.web, result.alerts], [1, 0]);
  // Browser B's push service answers 410: nothing reached the computer, the phone alerts.
  webBehavior = async () => { throw Object.assign(new Error("gone"), { statusCode: 410, body: "" }); };
  result = await deliver(pushEndpointHash(browserB));
  assert.equal(result.alerts, 1);
  assert.equal(result.counts.mobileFallback, 1);
});

// ---------------------------------------------------------------------------
// Third review: retries, active-socket acks, one ack wait per group
// ---------------------------------------------------------------------------

test("S1: an unacked desktop is never remembered as delivered: a retry still falls back to the phone", async ({ db }) => {
  void db;
  __resetNotificationSendLedgerForTests();
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "retry-ack-install" });
  await recordPresenceActivity(f.owner.id, "desktop", { active: true, idleSeconds: 3, locked: false, ackAlerts: true }, Date.now());
  desktopAckers = [];
  // Attempt 1 dies after the 0-ack emit: the mobile socket emit throws (the
  // group goes back to pending) and the phone fallback cannot get through.
  let socketDown = true;
  registerNotificationSocketServer({
    ...fakeIo,
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        if (event === "notification:push" && socketDown) throw new Error("socket adapter down");
        emits.push({ room, event, payload });
      },
    }),
  } as unknown as SocketServer);
  apnsBehavior = async () => { throw new ApnsDeliveryError("temporary provider failure", { statusCode: 503, reason: "ServiceUnavailable" }); };
  const message = await f.post(f.channel.id, "unacked then retried");
  const [id] = await enqueueNotificationRows([messageRow(f.owner.id, f.server.id, f.channel.id, message)]);
  await runScheduled();
  assert.equal((await outbox(id!)).status, "pending");
  assert.equal(await claimNotificationSend(id!, "desktop", "socket"), true, "the 0-ack desktop emit left no ledger key");
  __resetNotificationSendLedgerForTests(); // drop the probe's claim (nothing else was sent)

  // The retry: still no ack, the phone is reachable now: it alerts.
  socketDown = false;
  apnsCalls = [];
  apnsBehavior = async () => ({ status: "sent" });
  await drainNotificationRows([id!]);
  assert.equal(alerts().length, 1, "the retry fell back to the phone");
  assert.equal(countsOf(await outbox(id!)).mobileFallback, 1);
});

test("S2: only an active desktop socket's ack confirms; an idle desktop elsewhere acking does not", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "ack-active-install" });
  async function deliver(ackers: string[]) {
    __resetNotificationPresenceForTests();
    // Laptop A in use (half-open); home desktop B online but idle for an hour.
    await recordPresenceActivity(f.owner.id, "desktop", { active: true, idleSeconds: 2, locked: false, ackAlerts: true }, Date.now(), "laptop-a");
    await recordPresenceActivity(f.owner.id, "desktop", { active: false, idleSeconds: 3600, locked: false, ackAlerts: true }, Date.now(), "home-b");
    desktopAckers = ackers;
    apnsCalls = [];
    const message = await f.post(f.channel.id, `ackers ${ackers.join(",")}`);
    await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, message)]);
    return alerts().length;
  }
  assert.equal(await deliver(["home-b"]), 1, "the idle desktop's ack does not prove the laptop got it");
  assert.equal(await deliver(["laptop-a"]), 0, "the laptop in use acked");
  assert.equal(await deliver(["laptop-a", "home-b"]), 0);
});

test("S2: a Web Push confirms only when it went to the active browser's own subscription", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await register({ userId: f.owner.id, serverId: f.server.id, familyId: f.family.id, installationId: "web-active-install" });
  const browserA = "https://fcm.googleapis.com/fcm/send/browser-a";
  const browserB = "https://fcm.googleapis.com/fcm/send/browser-b";
  await subscribe(f.owner.id, browserA);
  await subscribe(f.owner.id, browserB);
  __resetNotificationPresenceForTests();
  await recordPresenceActivity(f.owner.id, "web", { active: true, idleSeconds: 2, locked: false, pushSubscribed: true, pushEndpointHash: pushEndpointHash(browserA) }, Date.now());
  // The active browser A's push fails; idle browser B's succeeds.
  webBehavior = async (send) => {
    if (send.endpoint === browserA) throw Object.assign(new Error("gone"), { statusCode: 410, body: "" });
  };
  apnsCalls = [];
  const message = await f.post(f.channel.id, "web A failed, B sent");
  const [id] = await enqueueAndDrain([messageRow(f.owner.id, f.server.id, f.channel.id, message)]);
  assert.equal(alerts().length, 1, "B's notification sits on a screen nobody is at: the phone alerts");
  assert.equal(countsOf(await outbox(id!)).mobileFallback, 1);
});

test("S3: a group of many unacked receivers pays one ack timeout, not one per receiver; the mobile socket banners are not held behind it", async ({ db }) => {
  const RECEIVERS = 20;
  const f = await seedFixture();
  const receiverIds = (await db.insert(users).values(Array.from({ length: RECEIVERS }, (_, index) => ({
    email: `ackwait-${index}@test.com`, name: `ackwait-${index}`, passwordHash: "x", emailVerified: true,
  }))).returning({ id: users.id })).map((row) => row.id);
  await db.insert(serverMembers).values(receiverIds.map((userId) => ({ serverId: f.server.id, userId, role: "member" as const })));
  for (const userId of receiverIds) {
    await recordPresenceActivity(userId, "desktop", { active: true, idleSeconds: 1, locked: false, ackAlerts: true }, Date.now());
    const [family] = await db.insert(sessionFamilies).values({ userId }).returning();
    await db.insert(sessions).values({ userId, familyId: family!.id, tokenHash: `ackwait-${family!.id}`, expiresAt: new Date(Date.now() + 60 * MINUTE) });
    await register({ userId, serverId: f.server.id, familyId: family!.id, installationId: `ackwait-${userId}` });
  }
  desktopAckers = [];
  const ACK_TIMEOUT = 300;
  __setNotificationDispatchRuntimeForTests({ schedule: (work) => { scheduled.push(work); }, sleep: async () => {}, desktopAckTimeoutMs: ACK_TIMEOUT });
  let bannersAt: number | null = null;
  const started = Date.now();
  registerNotificationSocketServer({
    ...fakeIo,
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        if (event === "notification:push" && bannersAt === null) bannersAt = Date.now() - started;
        emits.push({ room, event, payload });
      },
    }),
  } as unknown as SocketServer);
  apnsCalls = [];
  await enqueueAndDrain(receiverIds.map((receiverId) => messageRow(receiverId, f.server.id, f.channel.id, f.message)));
  const elapsed = Date.now() - started;
  assert.equal(alerts().length, RECEIVERS, "every unconfirmed receiver's phone alerted");
  assert.ok(elapsed < ACK_TIMEOUT * 3, `one wait for the group (${elapsed} ms), not ${RECEIVERS} × ${ACK_TIMEOUT} ms`);
  assert.ok(bannersAt !== null && bannersAt < ACK_TIMEOUT, `the in-app banners went before the ack wait ended (${bannersAt} ms)`);
  __resetNotificationDispatchRuntimeForTests();
  installHarness();
});
