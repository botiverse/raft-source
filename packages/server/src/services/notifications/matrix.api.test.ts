// The notification matrix end to end (docs/contracts/notifications.md §1):
// event type x level x device activity, from a real send (HTTP routes and the
// production notice / reminder / account-notice producers) through the
// outbox and the dispatcher to fake transports (desktop and mobile sockets,
// Web Push, APNs). Per case: which transports fired for the receiver, and the
// outbox row's status and decision.
import { pushEndpointHash } from "./transports/webPush";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { DESKTOP_NOTIFICATION_EVENT, type DesktopNotificationV1 } from "@botiverse/raft-shared";
import { createApiTest } from "../../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../../test/integration/taskV2Flag";
import { getDb } from "../../db/index";
import {
  agentMigrations,
  messages,
  notificationOutbox,
  pushSubscriptions,
  reminders,
  sessionFamilies,
  sessions,
  tasks,
} from "../../db/schema";
import { upsertPushRegistration } from "../pushService";
import {
  findOrCreateDM,
  findOrCreateUserDM,
  followThreadChannelForUser,
  getOrCreateThread,
} from "../channelService";
import { setLevel } from "./settings";
import { broadcastSystemMessage } from "../messageService";
import { createAgent } from "../agentService";
import * as taskService from "../taskService";
import { ensureTaskConversation } from "../taskConversationService";
import { postAgentActionRequiredNotice } from "../agentActionRequiredNoticeService";
import { notifyReminderFired } from "../../apps/reminder/firedNotification";
import { notifyHostedMigrationReviewReady } from "../hostedAgentMigrationImporter";
import {
  __resetNotificationDispatchRuntimeForTests,
  __setNotificationDispatchRuntimeForTests,
  drainNotificationOutbox,
  registerNotificationSocketServer,
} from "./dispatcher";
import { __resetApnsPushProviderForTests, __setApnsPushProviderForTests, type ApnsDeliveryInput } from "./transports/apns";
import { __resetWebPushRuntimeForTests, __setWebPushRuntimeForTests } from "./transports/webPush";
import { __resetNotificationBadgesForTests, __setNotificationBadgeLoaderForTests } from "./badge";
import { __resetNotificationPresenceForTests, recordPresenceActivity } from "./presence";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const APP_URL = "https://app.raft.test";

type Human = { id: string; name: string };
type Transport = "desktop" | "mobileSocket" | "web" | "apnsAlert" | "apnsSync";
type Emit = { room: string; event: string; payload: unknown };

// ---------------------------------------------------------------------------
// Fake transports
// ---------------------------------------------------------------------------

function installTransports(app: { io: unknown }) {
  const emits: Emit[] = [];
  const apns: ApnsDeliveryInput[] = [];
  const web: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  registerNotificationSocketServer({
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { emits.push({ room, event, payload }); } }),
  } as unknown as SocketServer);
  __setApnsPushProviderForTests({ send: async (input) => { apns.push(input); return { status: "sent" }; } });
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    sendNotification: (async (subscription: { endpoint: string }, payload: string) => {
      web.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
      return { statusCode: 201, body: "", headers: {} };
    }) as never,
  });
  const previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = APP_URL;
  __setNotificationBadgeLoaderForTests(async (_userId, serverIds) => new Map(serverIds.slice(0, 1).map((serverId) => [serverId, 2])));
  // The post-commit kick is not run; each case drains the outbox itself.
  __setNotificationDispatchRuntimeForTests({ schedule: () => {}, sleep: async () => {} });
  return {
    emits,
    apns,
    web,
    reset() {
      emits.length = 0;
      apns.length = 0;
      web.length = 0;
      __resetNotificationPresenceForTests();
      __resetNotificationBadgesForTests();
    },
    observed(userId: string): Transport[] {
      const out = new Set<Transport>();
      for (const emit of emits) {
        if (emit.event === DESKTOP_NOTIFICATION_EVENT && emit.room === `user:${userId}:clientKind:desktop`) out.add("desktop");
        if (emit.event === "notification:push" && emit.room === `user:${userId}:clientKind:mobile`) out.add("mobileSocket");
      }
      if (web.some((entry) => entry.endpoint === webEndpoint(userId))) out.add("web");
      for (const entry of apns) {
        if (entry.deviceToken !== apnsToken(userId)) continue;
        if (entry.request.pushType === "alert") out.add("apnsAlert");
        if (entry.request.pushType === "background" && entry.request.body.type === "sync") out.add("apnsSync");
      }
      return [...out].sort();
    },
    desktopFor(userId: string): DesktopNotificationV1[] {
      return emits
        .filter((emit) => emit.event === DESKTOP_NOTIFICATION_EVENT && emit.room === `user:${userId}:clientKind:desktop`)
        .map((emit) => emit.payload as DesktopNotificationV1);
    },
    restore() {
      registerNotificationSocketServer(app.io as SocketServer);
      __resetApnsPushProviderForTests();
      __resetWebPushRuntimeForTests();
      __setNotificationBadgeLoaderForTests(null);
      __resetNotificationDispatchRuntimeForTests();
      __resetNotificationPresenceForTests();
      __resetNotificationBadgesForTests();
      if (previousAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = previousAppUrl;
    },
  };
}

type Transports = ReturnType<typeof installTransports>;

function webEndpoint(userId: string) {
  return `https://fcm.googleapis.com/fcm/send/${userId}`;
}

function apnsToken(userId: string) {
  return `apns-${userId}`;
}

/** A web push subscription and an APNs registration on a live session family. */
async function seedDevices(user: Human, serverId: string) {
  const db = getDb();
  await db.insert(pushSubscriptions).values({ userId: user.id, endpoint: webEndpoint(user.id), p256dh: "p256dh", auth: "auth" });
  const [family] = await db.insert(sessionFamilies).values({ userId: user.id }).returning();
  await db.insert(sessions).values({ userId: user.id, familyId: family!.id, tokenHash: `t-${family!.id}`, expiresAt: new Date(Date.now() + 3_600_000) });
  await upsertPushRegistration({
    installationId: `install-${user.id}`,
    provider: "apns",
    userId: user.id,
    serverId,
    sessionFamilyId: family!.id,
    deviceToken: apnsToken(user.id),
    topic: "build.raft.app",
    env: "sandbox",
  });
}

type Activity = "desktop" | "web" | "mobile" | "desktopOnline" | "none";

async function applyActivity(userId: string, activity: Activity) {
  const now = Date.now();
  if (activity === "none") return;
  // Every case but "none" keeps a desktop presence record (online, idle).
  await recordPresenceActivity(userId, "desktop", { active: activity === "desktop", idleSeconds: activity === "desktop" ? 0 : null }, now);
  // The tab in use is the subscribed browser (it reports its own endpoint; contract §1.3).
  if (activity === "web") await recordPresenceActivity(userId, "web", { active: true, idleSeconds: 5, pushSubscribed: true, pushEndpointHash: pushEndpointHash(webEndpoint(userId)) }, now);
  if (activity === "mobile") await recordPresenceActivity(userId, "mobile", { active: true, idleSeconds: null }, now);
}

const ALERTED: Record<Activity, Transport[]> = {
  desktop: ["apnsSync", "desktop", "mobileSocket"],
  web: ["apnsSync", "mobileSocket", "web"],
  mobile: ["apnsAlert", "mobileSocket"],
  desktopOnline: ["apnsAlert", "desktop", "mobileSocket"],
  none: ["apnsAlert", "desktop", "mobileSocket", "web"],
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Http = { as(human: { id: string }, server?: { id: string }): { request(path: string, init: RequestInit): Promise<Response> } };

async function call(http: Http, user: Human, serverId: string, method: string, path: string, body: unknown) {
  const res = await http.as(user, { id: serverId }).request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  assert.equal(res.status, 200, `${method} ${path}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function sendMessage(http: Http, sender: Human, serverId: string, channelId: string, content: string, mentions: Human[] = []) {
  const body = await call(http, sender, serverId, "POST", "/api/messages", {
    channelId,
    content,
    mentions: mentions.map((person) => ({ type: "user", id: person.id, name: person.name })),
  });
  return body.id as string;
}

async function waitFor<T>(label: string, read: () => Promise<T | null | undefined>, timeoutMs = 6_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function latestSystemMessage(channelId: string, subtype: string, after?: Date) {
  return waitFor(`${subtype} in ${channelId}`, async () => {
    const [row] = await getDb().select().from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.systemSubtype, subtype)))
      .orderBy(desc(messages.seq)).limit(1);
    return row && (!after || row.createdAt >= after) ? row : null;
  });
}

async function conversationOf(taskId: string) {
  const [row] = await getDb().select({ id: tasks.conversationChannelId }).from(tasks).where(eq(tasks.id, taskId));
  assert.ok(row?.id, "the task has its conversation");
  return row.id;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

interface World {
  app: { io: unknown; app: { get(key: string): unknown } };
  http: Http;
  seed: {
    human(values?: { name?: string; displayName?: string }): Promise<Human & Record<string, unknown>>;
    server(input: { owner: Human; members?: Human[]; name?: string; slug?: string }): Promise<{ id: string; slug: string }>;
    channel(input: { server: { id: string }; members: Human[]; name?: string; visibility?: "channel" | "private" }): Promise<{ id: string; name: string }>;
  };
  sender: Human;
  receiver: Human;
  other: Human;
  serverId: string;
}

interface Prepared {
  /** The channel / DM whose level applies (a thread's parent channel). */
  channelId: string | null;
  threadId: string | null;
  /** Fires the event; the event key, the receiver's row expected or not. */
  fire(): Promise<string>;
}

type EventName =
  | "dm" | "channel" | "mention" | "thread" | "sameSend" | "unfollowedOrdinary" | "unfollowedMention" | "threadMention"
  | "taskConversation" | "taskStatusPersonal" | "taskStatusFollower" | "taskAssigned" | "agentAttention"
  | "reminder" | "systemNotice" | "rename" | "silentNoticeMention";

const CATEGORY: Record<EventName, string | null> = {
  dm: "dm",
  channel: "channel",
  mention: "mention",
  thread: "thread",
  sameSend: "thread",
  unfollowedOrdinary: null,
  unfollowedMention: "mention",
  threadMention: "mention",
  taskConversation: "thread",
  taskStatusPersonal: "task_status",
  taskStatusFollower: "task_status",
  taskAssigned: "task_assigned",
  agentAttention: "agent_attention",
  reminder: "reminder",
  systemNotice: "system_notice",
  rename: null,
  silentNoticeMention: "mention",
};

const TASK_EVENTS = new Set<EventName>(["taskConversation", "taskStatusPersonal", "taskStatusFollower", "taskAssigned"]);

async function prepare(w: World, event: EventName): Promise<Prepared> {
  const { http, seed, sender, receiver, other, serverId } = w;
  const server = { id: serverId };
  const orchestrator = w.app.app.get("agentOrchestrator") as never;
  const io = w.app.io as never;
  const message = (channelId: string, content: string, mentions: Human[] = []) => async () =>
    `message:${await sendMessage(http, sender, serverId, channelId, content, mentions)}`;
  const threadWith = async (parentAuthor: Human, follow: "follow" | "unfollow" | "none") => {
    const channel = await seed.channel({ server, members: [sender, receiver, other], name: `room-${randomUUID().slice(0, 6)}` });
    const parentId = await sendMessage(http, parentAuthor, serverId, channel.id, "parent message");
    const thread = await getOrCreateThread(parentId, parentAuthor.id, "user");
    // The Follow / Unfollow buttons (a thread has no level, only its follow state).
    if (follow !== "none") await setLevel({ userId: receiver.id, scope: "thread", id: thread.id, level: "all", accessChecked: true, button: true });
    if (follow === "unfollow") await setLevel({ userId: receiver.id, scope: "thread", id: thread.id, level: "mentions", accessChecked: true, button: true });
    return { channel, thread };
  };
  const taskIn = async (creator: Human) => {
    const channel = await seed.channel({ server, members: [sender, receiver, other], name: `work-${randomUUID().slice(0, 6)}` });
    const { tasks: [task] } = await taskService.createTasks(channel.id, "user", creator.id, [{ title: "Fix login" }]);
    await ensureTaskConversation(task!.id);
    return { channel, task: task!, conversationId: await conversationOf(task!.id) };
  };
  const agentOfReceiver = () => createAgent(serverId, `ferris-${randomUUID().slice(0, 6)}`, { runtime: "claude", creatorType: "user", creatorId: receiver.id });

  switch (event) {
    case "dm": {
      const dm = await findOrCreateUserDM(serverId, sender.id, receiver.id);
      return { channelId: dm!.id, threadId: null, fire: message(dm!.id, "hi there") };
    }
    case "channel":
    case "mention":
    case "rename":
    case "silentNoticeMention": {
      const channel = await seed.channel({ server, members: [sender, receiver, other], name: `room-${randomUUID().slice(0, 6)}` });
      if (event === "channel") return { channelId: channel.id, threadId: null, fire: message(channel.id, "deploy is green") };
      if (event === "mention") return { channelId: channel.id, threadId: null, fire: message(channel.id, `@${receiver.name} deploy is green`, [receiver]) };
      return {
        channelId: channel.id,
        threadId: null,
        fire: async () => {
          const notice = await broadcastSystemMessage(io, orchestrator, channel.id, event === "rename" ? "renamed the channel" : `@${receiver.name} the channel was renamed`, {
            inboxFactPolicy: { mode: "record", producer: "channel.rename", reason: "matrix", causalActor: { type: "user", id: sender.id } },
            ...(event === "silentNoticeMention" && { personalAttentionTargets: [{ type: "user" as const, id: receiver.id, name: receiver.name }] }),
            targetAgentIds: [],
          });
          return `message:${notice.id}`;
        },
      };
    }
    case "thread":
    case "threadMention": {
      const { channel, thread } = await threadWith(other, "follow");
      return {
        channelId: channel.id,
        threadId: thread.id,
        fire: event === "thread" ? message(thread.id, "a reply") : message(thread.id, `@${receiver.name} can you look`, [receiver]),
      };
    }
    case "sameSend": {
      const { channel, thread } = await threadWith(receiver, "none");
      return { channelId: channel.id, threadId: thread.id, fire: message(thread.id, "a reply to your message") };
    }
    case "unfollowedOrdinary":
    case "unfollowedMention": {
      const { channel, thread } = await threadWith(other, "unfollow");
      return {
        channelId: channel.id,
        threadId: thread.id,
        fire: event === "unfollowedOrdinary" ? message(thread.id, "more chatter") : message(thread.id, `@${receiver.name} you again`, [receiver]),
      };
    }
    case "taskConversation": {
      const { channel, conversationId } = await taskIn(receiver);
      return { channelId: channel.id, threadId: conversationId, fire: message(conversationId, "progress update") };
    }
    case "taskStatusPersonal":
    case "taskStatusFollower": {
      const { channel, task, conversationId } = await taskIn(event === "taskStatusPersonal" ? receiver : other);
      if (event === "taskStatusFollower") assert.ok(await followThreadChannelForUser(receiver.id, conversationId));
      return {
        channelId: channel.id,
        threadId: conversationId,
        fire: async () => {
          const before = new Date(Date.now() - 1);
          await call(http, sender, serverId, "PATCH", `/api/tasks/${task.id}/status`, { status: event === "taskStatusPersonal" ? "done" : "in_progress" });
          return `message:${(await latestSystemMessage(conversationId, "task.lifecycle_thread", before)).id}`;
        },
      };
    }
    case "taskAssigned": {
      const { channel, task, conversationId } = await taskIn(sender);
      return {
        channelId: channel.id,
        threadId: conversationId,
        fire: async () => {
          await call(http, sender, serverId, "PATCH", `/api/tasks/${task.id}/assignee`, { assignee: { type: "user", id: receiver.id } });
          return `message:${(await latestSystemMessage(conversationId, "task.assignment_receipt")).id}`;
        },
      };
    }
    case "agentAttention": {
      const agent = await agentOfReceiver();
      const dm = await findOrCreateDM(serverId, receiver.id, agent.id);
      return {
        channelId: dm!.id,
        threadId: null,
        fire: async () => {
          assert.equal(await postAgentActionRequiredNotice(io, orchestrator, { agentId: agent.id, notice: { kind: "runtime_error", requiredAction: "user_model_access" } }), true);
          return `message:${(await latestSystemMessage(dm!.id, "agent.runtime_action_required")).id}`;
        },
      };
    }
    case "reminder": {
      const agent = await agentOfReceiver();
      const [reminder] = await getDb().insert(reminders).values({
        serverId, ownerAgentId: agent.id, title: "Check the deploy", fireAt: new Date(), createdByType: "human", createdById: receiver.id,
      }).returning();
      return {
        channelId: null,
        threadId: null,
        fire: async () => {
          const firedAt = new Date().toISOString();
          await notifyReminderFired({ reminderId: reminder!.id, firedAt });
          return `reminder:${reminder!.id}:${firedAt}`;
        },
      };
    }
    case "systemNotice": {
      const agent = await agentOfReceiver();
      return {
        channelId: null,
        threadId: null,
        fire: async () => {
          const id = randomUUID();
          await notifyHostedMigrationReviewReady({ id, agentId: agent.id, initiatedByUserId: receiver.id } as typeof agentMigrations.$inferSelect);
          return `migration:${id}`;
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

type LevelCase =
  | "server:all" | "server:mentions" | "server:none"
  | "server:none+channel:all" | "server:all+channel:none"
  | "channel:mentions"
  | "muted";

async function applyLevel(w: World, prepared: Prepared, level: LevelCase) {
  const put = (scope: string, id: string | null, value: string) => {
    assert.ok(id, `${level}: the event has a ${scope}`);
    return call(w.http, w.receiver, w.serverId, "PUT", "/api/notification-levels", { scope, id, level: value });
  };
  switch (level) {
    case "server:all": return;
    case "server:mentions": await put("server", w.serverId, "mentions"); return;
    case "server:none": await put("server", w.serverId, "none"); return;
    case "server:none+channel:all": await put("server", w.serverId, "none"); await put("channel", prepared.channelId, "all"); return;
    case "server:all+channel:none": await put("channel", prepared.channelId, "none"); return;
    case "channel:mentions": await put("channel", prepared.channelId, "mentions"); return;
    case "muted": await call(w.http, w.receiver, w.serverId, "PATCH", `/api/channels/${prepared.channelId}/notification-settings`, { activityMuted: true }); return;
  }
}

// ---------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------

/** "notify" | "quiet" | "suppressed:<reason>" | "no_row" (the facts filter it out, or it never notifies). */
type Outcome = string;

interface CaseResult {
  label: string;
  outcome: Outcome;
  transports: Transport[];
  row: typeof notificationOutbox.$inferSelect | null;
  world: World;
  eventKey: string;
}

async function newWorld(ctx: Pick<World, "app" | "http" | "seed">, opts: { taskV2: boolean }): Promise<World> {
  const person = (displayName: string) => ctx.seed.human({ name: `${displayName.toLowerCase()}-${randomUUID().slice(0, 8)}`, displayName });
  const sender = await person("Sam");
  const receiver = await person("Rita");
  const other = await person("Olga");
  const server = await ctx.seed.server({ owner: sender, members: [receiver, other], name: "Acme" });
  if (opts.taskV2) await enableTaskV2ConversationsForServer(server.id);
  for (const person of [sender, receiver, other]) await seedDevices(person, server.id);
  return { ...ctx, sender, receiver, other, serverId: server.id };
}

async function drainAll() {
  for (let round = 0; round < 10; round += 1) {
    const { claimed } = await drainNotificationOutbox(500);
    if (claimed === 0) return;
  }
}

async function runCase(
  ctx: Pick<World, "app" | "http" | "seed">,
  transports: Transports,
  input: { event: EventName; level?: LevelCase; activity?: Activity; beforeFire?: (w: World) => Promise<void> },
): Promise<CaseResult> {
  const level = input.level ?? "server:all";
  const activity = input.activity ?? "none";
  const label = `${input.event} @ ${level} / ${activity}`;
  const world = await newWorld(ctx, { taskV2: TASK_EVENTS.has(input.event) });
  const prepared = await prepare(world, input.event);
  await applyLevel(world, prepared, level);
  await input.beforeFire?.(world);
  // Settle setup work (parent sends, follows) before the event.
  await drainAll();
  transports.reset();
  await applyActivity(world.receiver.id, activity);
  const eventKey = await prepared.fire();
  const rowOf = async () => {
    const [row] = await getDb().select().from(notificationOutbox)
      .where(and(eq(notificationOutbox.eventKey, eventKey), eq(notificationOutbox.receiverId, world.receiver.id)));
    return row ?? null;
  };
  const expectsRow = CATEGORY[input.event] !== null && level !== "muted" ? true : null;
  let row = expectsRow ? await waitFor(`${label}: outbox row`, rowOf).catch(() => null) : null;
  if (!row) {
    // Give an unexpected row the same chance to land.
    await new Promise((resolve) => setTimeout(resolve, 300));
    row = await rowOf();
  }
  await drainAll();
  row = await rowOf();
  const outcome = row ? (row.decision ?? `status:${row.status}`) : "no_row";
  if (row) {
    const expectedStatus = outcome === "notify" ? "delivered" : outcome === "quiet" ? "quiet" : "suppressed";
    assert.equal(row.status, expectedStatus, `${label}: row status for ${outcome}`);
    if (CATEGORY[input.event]) assert.equal(row.category, CATEGORY[input.event], `${label}: category`);
  }
  return { label, outcome, transports: transports.observed(world.receiver.id), row, world, eventKey };
}

function expectedTransports(outcome: Outcome, activity: Activity): Transport[] {
  if (outcome === "notify") return ALERTED[activity];
  if (outcome === "quiet") return ["apnsSync"];
  return [];
}

type Ctx = Pick<World, "app" | "http" | "seed">;

async function runTable(ctx: Ctx, transports: Transports, cases: Array<{ event: EventName; level?: LevelCase; activity?: Activity; expect: Outcome }>) {
  const mismatches: string[] = [];
  for (const entry of cases) {
    const result = await runCase(ctx, transports, entry);
    const activity = entry.activity ?? "none";
    const want = expectedTransports(entry.expect, activity);
    if (result.outcome !== entry.expect || result.transports.join(",") !== want.join(",")) {
      mismatches.push(`${result.label}: expected ${entry.expect} [${want.join(",")}], got ${result.outcome} [${result.transports.join(",")}]`);
    }
  }
  assert.deepEqual(mismatches, []);
}

function withTransports(name: string, body: (ctx: Ctx, transports: Transports) => Promise<void>) {
  test(name, async ({ app, http, seed }) => {
    const transports = installTransports(app);
    try {
      await body({ app: app as never, http, seed: seed as never }, transports);
    } finally {
      transports.restore();
    }
  });
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

withTransports("every event type at server level all with no device active", async (ctx, transports) => {
  await runTable(ctx, transports, [
    { event: "dm", expect: "notify" },
    { event: "channel", expect: "notify" },
    { event: "mention", expect: "notify" },
    { event: "thread", expect: "notify" },
    { event: "sameSend", expect: "notify" },
    { event: "unfollowedOrdinary", expect: "no_row" },
    { event: "unfollowedMention", expect: "notify" },
    { event: "threadMention", expect: "notify" },
    { event: "taskConversation", expect: "notify" },
    { event: "taskStatusPersonal", expect: "notify" },
    { event: "taskStatusFollower", expect: "notify" },
    { event: "taskAssigned", expect: "notify" },
    { event: "agentAttention", expect: "notify" },
    { event: "reminder", expect: "notify" },
    { event: "systemNotice", expect: "notify" },
    { event: "rename", expect: "no_row" },
    { event: "silentNoticeMention", expect: "notify" },
  ]);
});

withTransports("server levels: mentions keeps everything about me, none silences everything", async (ctx, transports) => {
  await runTable(ctx, transports, [
    { event: "channel", level: "server:mentions", expect: "suppressed:server_mentions" },
    { event: "mention", level: "server:mentions", expect: "notify" },
    { event: "dm", level: "server:mentions", expect: "notify" },
    { event: "thread", level: "server:mentions", expect: "notify" },
    { event: "sameSend", level: "server:mentions", expect: "notify" },
    { event: "taskStatusPersonal", level: "server:mentions", expect: "notify" },
    { event: "taskStatusFollower", level: "server:mentions", expect: "notify" },
    { event: "taskAssigned", level: "server:mentions", expect: "notify" },
    { event: "agentAttention", level: "server:mentions", expect: "notify" },
    { event: "reminder", level: "server:mentions", expect: "notify" },
    { event: "systemNotice", level: "server:mentions", expect: "notify" },

    { event: "channel", level: "server:none", expect: "suppressed:server_none" },
    { event: "mention", level: "server:none", expect: "suppressed:server_none" },
    { event: "dm", level: "server:none", expect: "suppressed:server_none" },
    // None silences a followed thread too, manual or automatic.
    { event: "thread", level: "server:none", expect: "suppressed:server_none" },
    { event: "sameSend", level: "server:none", expect: "suppressed:server_none" },
    { event: "taskStatusPersonal", level: "server:none", expect: "suppressed:server_none" },
    { event: "taskAssigned", level: "server:none", expect: "suppressed:server_none" },
    { event: "agentAttention", level: "server:none", expect: "suppressed:server_none" },
    { event: "reminder", level: "server:none", expect: "suppressed:server_none" },
    { event: "systemNotice", level: "server:none", expect: "suppressed:server_none" },
  ]);
});

withTransports("channel levels: an explicit channel level beats the server level; a mute silences everything", async (ctx, transports) => {
  await runTable(ctx, transports, [
    { event: "channel", level: "server:none+channel:all", expect: "notify" },
    { event: "mention", level: "server:none+channel:all", expect: "notify" },
    { event: "dm", level: "server:none+channel:all", expect: "notify" },
    { event: "sameSend", level: "server:none+channel:all", expect: "notify" },
    { event: "taskStatusPersonal", level: "server:none+channel:all", expect: "notify" },
    { event: "agentAttention", level: "server:none+channel:all", expect: "notify" },

    { event: "channel", level: "server:all+channel:none", expect: "suppressed:channel_level" },
    { event: "mention", level: "server:all+channel:none", expect: "suppressed:channel_level" },
    { event: "dm", level: "server:all+channel:none", expect: "suppressed:channel_level" },
    { event: "sameSend", level: "server:all+channel:none", expect: "suppressed:channel_level" },
    // Nothing on the channel silences its followed threads too (a thread has no level to beat it).
    { event: "thread", level: "server:all+channel:none", expect: "suppressed:channel_level" },
    { event: "taskStatusPersonal", level: "server:all+channel:none", expect: "suppressed:channel_level" },
    { event: "taskStatusFollower", level: "server:all+channel:none", expect: "suppressed:channel_level" },
    { event: "agentAttention", level: "server:all+channel:none", expect: "suppressed:channel_level" },

    { event: "channel", level: "channel:mentions", expect: "suppressed:channel_level" },
    { event: "mention", level: "channel:mentions", expect: "notify" },
    { event: "thread", level: "channel:mentions", expect: "notify" },
    { event: "sameSend", level: "channel:mentions", expect: "notify" },
    { event: "taskConversation", level: "channel:mentions", expect: "notify" },

    { event: "channel", level: "muted", expect: "no_row" },
    // A mute silences everything, the @mention included (Slack).
    { event: "mention", level: "muted", expect: "suppressed:muted" },
  ]);
});

withTransports("device activity decides where a personal and a channel event alert", async (ctx, transports) => {
  const cases: Array<{ event: EventName; activity: Activity; expect: Outcome }> = [];
  for (const activity of ["desktop", "web", "mobile", "desktopOnline", "none"] as const) {
    cases.push({ event: "mention", activity, expect: "notify" });
    cases.push({ event: "channel", activity, expect: "notify" });
  }
  cases.push({ event: "taskAssigned", activity: "mobile", expect: "notify" });
  cases.push({ event: "reminder", activity: "desktop", expect: "notify" });
  await runTable(ctx, transports, cases);
});

withTransports("quiet hours across midnight in a non-UTC zone: no alert anywhere, the phone gets a sync", async (ctx, transports) => {
  const quietNow = (w: World) => {
    // A window from 5 minutes ahead to 3 minutes ahead (start > end: it spans
    // midnight and covers now) in the receiver's zone.
    const timeZone = "Asia/Tokyo";
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date());
    const minute = Number(parts.find((part) => part.type === "hour")!.value) * 60 + Number(parts.find((part) => part.type === "minute")!.value);
    const quietHours = { enabled: true, startMinute: (minute + 5) % 1440, endMinute: (minute + 3) % 1440, timeZone };
    return call(w.http, w.receiver, w.serverId, "PATCH", "/api/me/notification-settings", { quietHours });
  };
  const mismatches: string[] = [];
  for (const event of ["mention", "channel", "reminder"] as const) {
    for (const activity of ["mobile", "none"] as const) {
      const result = await runCase(ctx, transports, { event, activity, beforeFire: async (w) => { await quietNow(w); } });
      if (result.outcome !== "quiet" || result.transports.join(",") !== "apnsSync") {
        mismatches.push(`${result.label} (quiet): got ${result.outcome} [${result.transports.join(",")}]`);
      }
    }
  }
  assert.deepEqual(mismatches, []);
});

withTransports("a thread reply that @mentions a follower reads as a mention on their desktop, another follower's as a reply", async (ctx, transports) => {
  const result = await runCase(ctx, transports, { event: "threadMention" });
  assert.equal(result.outcome, "notify");
  const { receiver, other, sender } = result.world;
  const [forReceiver] = transports.desktopFor(receiver.id).filter((payload) => payload.id === result.eventKey);
  assert.ok(forReceiver);
  assert.equal(forReceiver.kind, "mention");
  assert.equal(forReceiver.mentioned, true);
  assert.match(forReceiver.title, /^Thread in #room-/);
  assert.ok(forReceiver.body.endsWith(`: @${receiver.name} can you look`), forReceiver.body);
  assert.equal(forReceiver.body.includes("mentioned you"), false, "`Sender: text`, no mention prefix");
  // The parent author follows the thread from their own message: a reply, not a mention.
  const [forOther] = transports.desktopFor(other.id).filter((payload) => payload.id === result.eventKey);
  assert.ok(forOther, "the other follower is notified");
  assert.equal(forOther.kind, "thread");
  assert.equal(forOther.mentioned, false);
  assert.deepEqual(transports.desktopFor(sender.id).filter((payload) => payload.id === result.eventKey), [], "never the sender");
  const otherRow = await getDb().select().from(notificationOutbox)
    .where(and(eq(notificationOutbox.eventKey, result.eventKey), eq(notificationOutbox.receiverId, other.id)));
  assert.deepEqual(otherRow.map((row) => [row.category, row.personalMention]), [["thread", false]]);
});

withTransports("a DM reads as the sender's words, not as a mention", async (ctx, transports) => {
  const result = await runCase(ctx, transports, { event: "dm" });
  assert.equal(result.outcome, "notify");
  const [payload] = transports.desktopFor(result.world.receiver.id);
  assert.ok(payload);
  assert.equal(payload.kind, "dm");
  assert.equal(payload.mentioned, false);
  assert.equal(payload.title, "Sam");
  assert.equal(payload.body, "hi there");
  const alert = transports.apns.find((entry) => entry.request.pushType === "alert" && entry.deviceToken === apnsToken(result.world.receiver.id));
  // Push matches desktop: titled by the sender, the bare text as body.
  const aps = (alert?.request.body as { aps: { alert: { title: string; body: string } } }).aps;
  assert.equal(aps.alert.title, "Sam");
  assert.equal(aps.alert.body, "hi there");
});

// "Replies in threads I follow" off (account followedThreadReplies, #triage:#357).
const followedThreadRepliesOff = (w: World) =>
  call(w.http, w.receiver, w.serverId, "PATCH", "/api/me/notification-settings", { followedThreadReplies: false }).then(() => undefined);

withTransports("followed-thread replies off: a followed thread or task conversation alerts nowhere unless it @mentions me; tasks are unchanged", async (ctx, transports) => {
  const mismatches: string[] = [];
  const cases: Array<{ event: EventName; level?: LevelCase; activity?: Activity; expect: Outcome }> = [
    { event: "thread", expect: "suppressed:followed_thread_replies_off" },
    { event: "sameSend", expect: "suppressed:followed_thread_replies_off" },
    { event: "taskConversation", expect: "suppressed:followed_thread_replies_off" },
    { event: "thread", level: "server:mentions", expect: "suppressed:followed_thread_replies_off" },
    { event: "taskConversation", level: "channel:mentions", expect: "suppressed:followed_thread_replies_off" },
    // The server and the in-app sockets take the same decision: no desktop,
    // web, mobile socket or APNs alert, whichever device is in use.
    { event: "thread", activity: "desktop", expect: "suppressed:followed_thread_replies_off" },
    { event: "thread", activity: "web", expect: "suppressed:followed_thread_replies_off" },
    { event: "thread", activity: "mobile", expect: "suppressed:followed_thread_replies_off" },
    // An @mention in the thread still alerts everywhere it would.
    { event: "threadMention", expect: "notify" },
    { event: "threadMention", activity: "desktop", expect: "notify" },
    { event: "threadMention", activity: "mobile", expect: "notify" },
    { event: "unfollowedMention", expect: "notify" },
    // Level none still wins with its own reason.
    { event: "thread", level: "server:none", expect: "suppressed:server_none" },
    // Task status and assignment are not followed-thread replies.
    { event: "taskStatusPersonal", expect: "notify" },
    { event: "taskStatusFollower", expect: "notify" },
    { event: "taskAssigned", expect: "notify" },
    // Not about threads at all.
    { event: "channel", expect: "notify" },
    { event: "dm", expect: "notify" },
  ];
  for (const entry of cases) {
    const result = await runCase(ctx, transports, { ...entry, beforeFire: followedThreadRepliesOff });
    const want = expectedTransports(entry.expect, entry.activity ?? "none");
    if (result.outcome !== entry.expect || result.transports.join(",") !== want.join(",")) {
      mismatches.push(`${result.label} (followed-thread replies off): expected ${entry.expect} [${want.join(",")}], got ${result.outcome} [${result.transports.join(",")}]`);
    }
  }
  assert.deepEqual(mismatches, []);
});

withTransports("followed-thread replies off: the thread stays followed and in Activity with its unread count", async (ctx, transports) => {
  const result = await runCase(ctx, transports, { event: "thread", beforeFire: followedThreadRepliesOff });
  assert.equal(result.outcome, "suppressed:followed_thread_replies_off");
  const { http, receiver, serverId } = result.world;
  const threadId = result.row?.sourceChannelId;
  assert.ok(threadId, "the outbox row names the thread");
  const res = await http.as(receiver, { id: serverId }).request("/api/channels/inbox?filter=all&limit=50", { method: "GET" });
  assert.equal(res.status, 200);
  const { items } = await res.json() as { items: Array<{ kind: string; threadChannelId?: string; unreadCount: number }> };
  const item = items.find((row) => row.kind === "thread" && row.threadChannelId === threadId);
  assert.ok(item, "the followed thread is listed in Activity");
  assert.ok(item.unreadCount >= 1, `the reply counts as unread (${item.unreadCount})`);
});
