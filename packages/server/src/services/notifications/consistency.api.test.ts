// One audience for every transport (design §3.1): for a real send to people
// in mixed states, the users any transport reached are exactly the users
// whose outbox row decided `notify`; each transport reaches exactly those
// minus whom the device plan (planNotificationDevices over the same presence
// records) leaves out; and nothing reaches a user without an outbox row.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { DESKTOP_NOTIFICATION_EVENT } from "@botiverse/raft-shared";
import { createApiTest } from "../../test/integration/apiTest";
import { getDb } from "../../db/index";
import { notificationOutbox, pushSubscriptions, sessionFamilies, sessions } from "../../db/schema";
import { upsertPushRegistration } from "../pushService";
import { findOrCreateUserDM, getOrCreateThread } from "../channelService";
import { setLevel } from "./settings";
import {
  __resetNotificationDispatchRuntimeForTests,
  __setNotificationDispatchRuntimeForTests,
  drainNotificationOutbox,
  registerNotificationSocketServer,
} from "./dispatcher";
import { __resetApnsPushProviderForTests, __setApnsPushProviderForTests, type ApnsDeliveryInput } from "./transports/apns";
import { __resetWebPushRuntimeForTests, __setWebPushRuntimeForTests } from "./transports/webPush";
import { __resetNotificationBadgesForTests, __setNotificationBadgeLoaderForTests } from "./badge";
import {
  __resetNotificationPresenceForTests,
  loadNotificationPresence,
  planNotificationDevices,
  recordPresenceActivity,
} from "./presence";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type Human = { id: string; name: string };
type Transport = "desktop" | "mobileSocket" | "web" | "apnsAlert" | "apnsSync";
const TRANSPORTS: Transport[] = ["desktop", "mobileSocket", "web", "apnsAlert", "apnsSync"];

function webEndpoint(userId: string) {
  return `https://fcm.googleapis.com/fcm/send/${userId}`;
}

function apnsToken(userId: string) {
  return `apns-${userId}`;
}

function installTransports(app: { io: unknown }) {
  const emits: Array<{ room: string; event: string; payload: unknown }> = [];
  const apns: ApnsDeliveryInput[] = [];
  const web: string[] = [];
  registerNotificationSocketServer({
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { emits.push({ room, event, payload }); } }),
  } as unknown as SocketServer);
  __setApnsPushProviderForTests({ send: async (input) => { apns.push(input); return { status: "sent" }; } });
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    sendNotification: (async (subscription: { endpoint: string }) => {
      web.push(subscription.endpoint);
      return { statusCode: 201, body: "", headers: {} };
    }) as never,
  });
  const previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = "https://app.raft.test";
  __setNotificationBadgeLoaderForTests(async (_userId, serverIds) => new Map(serverIds.slice(0, 1).map((serverId) => [serverId, 3])));
  __setNotificationDispatchRuntimeForTests({ schedule: () => {}, sleep: async () => {} });
  return {
    reset() {
      emits.length = 0;
      apns.length = 0;
      web.length = 0;
      __resetNotificationBadgesForTests();
    },
    /** userId -> transports that reached them. */
    reached(): Map<string, Set<Transport>> {
      const out = new Map<string, Set<Transport>>();
      const add = (userId: string, transport: Transport) => {
        let set = out.get(userId);
        if (!set) out.set(userId, set = new Set());
        set.add(transport);
      };
      for (const emit of emits) {
        const match = /^user:([^:]+):clientKind:(desktop|mobile|web)$/.exec(emit.room);
        if (!match) continue;
        if (emit.event === DESKTOP_NOTIFICATION_EVENT && match[2] === "desktop") add(match[1]!, "desktop");
        if (emit.event === "notification:push" && match[2] === "mobile") add(match[1]!, "mobileSocket");
      }
      for (const endpoint of web) add(endpoint.slice(webEndpoint("").length), "web");
      for (const entry of apns) {
        const userId = entry.deviceToken.slice(apnsToken("").length);
        if (entry.request.pushType === "alert") add(userId, "apnsAlert");
        else if (entry.request.body.type === "sync") add(userId, "apnsSync");
      }
      return out;
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

async function addWebSubscription(user: Human) {
  await getDb().insert(pushSubscriptions).values({ userId: user.id, endpoint: webEndpoint(user.id), p256dh: "p256dh", auth: "auth" });
}

async function addApnsRegistration(user: Human, serverId: string) {
  const db = getDb();
  const [family] = await db.insert(sessionFamilies).values({ userId: user.id }).returning();
  await db.insert(sessions).values({ userId: user.id, familyId: family!.id, tokenHash: `t-${family!.id}`, expiresAt: new Date(Date.now() + 3_600_000) });
  await upsertPushRegistration({
    installationId: `install-${user.id}`, provider: "apns", userId: user.id, serverId, sessionFamilyId: family!.id,
    deviceToken: apnsToken(user.id), topic: "build.raft.app", env: "sandbox",
  });
}

type Http = { as(human: { id: string }, server?: { id: string }): { request(path: string, init: RequestInit): Promise<Response> } };

async function call(http: Http, user: Human, serverId: string, method: string, path: string, body: unknown) {
  const res = await http.as(user, { id: serverId }).request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  assert.equal(res.status, 200, `${method} ${path}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

type Seed = {
  human(values?: { name?: string; displayName?: string }): Promise<Human>;
  server(input: { owner: Human; members?: Human[]; name?: string }): Promise<{ id: string }>;
  channel(input: { server: { id: string }; members: Human[]; name?: string }): Promise<{ id: string }>;
};

/**
 * The people of one send, one per state:
 * sender, muted (channel muted), mentions (server level mentions), none
 * (server level none), desktop (active on desktop), mobile (active on the
 * phone), webOnly (only a Web Push subscription), idle (every device, none
 * active, no desktop online).
 */
async function seedPeople(seed: Seed, http: Http) {
  const person = (label: string) => seed.human({ name: `${label}-${randomUUID().slice(0, 8)}`, displayName: label });
  const labels = ["sender", "muted", "mentions", "none", "desktop", "mobile", "webOnly", "idle"] as const;
  const people = {} as Record<(typeof labels)[number], Human>;
  for (const label of labels) people[label] = await person(label);
  const server = await seed.server({ owner: people.sender, members: labels.filter((label) => label !== "sender").map((label) => people[label]) });
  for (const label of labels) {
    await addWebSubscription(people[label]);
    if (label !== "webOnly") await addApnsRegistration(people[label], server.id);
  }
  await call(http, people.mentions, server.id, "PUT", "/api/notification-levels", { scope: "server", id: server.id, level: "mentions" });
  await call(http, people.none, server.id, "PUT", "/api/notification-levels", { scope: "server", id: server.id, level: "none" });
  return { people, labels, serverId: server.id };
}

async function applyPresence(people: Record<string, Human>) {
  __resetNotificationPresenceForTests();
  const now = Date.now();
  // The sender is typing on desktop; the others as their label says.
  await recordPresenceActivity(people.sender!.id, "desktop", { active: true, idleSeconds: 0 }, now);
  await recordPresenceActivity(people.desktop!.id, "desktop", { active: true, idleSeconds: 2 }, now);
  await recordPresenceActivity(people.mobile!.id, "desktop", { active: false, idleSeconds: null }, now);
  await recordPresenceActivity(people.mobile!.id, "mobile", { active: true, idleSeconds: null }, now);
  await recordPresenceActivity(people.muted!.id, "web", { active: true, idleSeconds: 1 }, now);
}

async function drainAll() {
  for (let round = 0; round < 10; round += 1) {
    if ((await drainNotificationOutbox(500)).claimed === 0) return;
  }
}

async function checkConsistency(input: {
  label: string;
  eventKey: string;
  people: Record<string, Human>;
  transports: ReturnType<typeof installTransports>;
  expectNotified: string[];
}) {
  const { label, eventKey, people, transports } = input;
  const nameOf = new Map(Object.entries(people).map(([name, person]) => [person.id, name]));
  const ids = Object.values(people).map((person) => person.id);
  // The plan, recomputed from the same presence records the dispatcher read.
  const presence = await loadNotificationPresence(ids, Date.now());
  await drainAll();
  const rows = await getDb().select().from(notificationOutbox).where(eq(notificationOutbox.eventKey, eventKey));
  const rowUsers = new Set(rows.map((row) => row.receiverId));
  const notified = new Set(rows.filter((row) => row.decision === "notify").map((row) => row.receiverId));
  for (const row of rows) assert.notEqual(row.status, "pending", `${label}: drained`);
  const reached = transports.reached();
  const names = (set: Iterable<string>) => [...set].map((id) => nameOf.get(id) ?? id).sort();

  assert.deepEqual(names(notified), [...input.expectNotified].sort(), `${label}: notified users`);
  assert.deepEqual(names(reached.keys()), names(notified), `${label}: users reached by any transport == users with a notify decision`);
  for (const userId of reached.keys()) assert.ok(rowUsers.has(userId), `${label}: ${nameOf.get(userId)} was reached without an outbox row`);

  const now = Date.now();
  const devices = {
    web: new Set((await getDb().select({ userId: pushSubscriptions.userId }).from(pushSubscriptions)).map((row) => row.userId)),
    apns: new Set(ids.filter((id) => id !== people.webOnly?.id)),
  };
  for (const transport of TRANSPORTS) {
    const expected = new Set<string>();
    for (const userId of notified) {
      // The dispatcher's deliverability: a socket server is up. These users' tabs report no
      // push endpoint, so no browser here counts as a deliverable computer.
      const plan = planNotificationDevices(presence.get(userId), now, "inactive", { webPushEndpointHashes: new Set(), desktopSocket: true });
      const take = transport === "desktop" ? plan.desktop
        : transport === "mobileSocket" ? plan.mobileSocket
          : transport === "web" ? plan.webPush && devices.web.has(userId)
            : transport === "apnsAlert" ? plan.mobileAlert && devices.apns.has(userId)
              // A phone the plan left out gets the badge sync instead.
              : !plan.mobileAlert && devices.apns.has(userId);
      if (take) expected.add(userId);
    }
    const actual = [...reached].filter(([, set]) => set.has(transport)).map(([userId]) => userId);
    assert.deepEqual(names(actual), names(expected), `${label}: ${transport} recipients == notified minus the plan's exclusions`);
  }
  return { rows, reached, nameOf };
}

test("a channel message, a DM and a thread reply reach one consistent audience on every transport", async ({ app, http, seed }) => {
  const transports = installTransports(app);
  try {
    const { people, labels, serverId } = await seedPeople(seed as unknown as Seed, http);
    const everyone = labels.map((label) => people[label]);
    const channel = await (seed as unknown as Seed).channel({ server: { id: serverId }, members: everyone, name: "launch" });
    await call(http, people.muted, serverId, "PATCH", `/api/channels/${channel.id}/notification-settings`, { activityMuted: true });
    const send = async (channelId: string, content: string) => {
      const body = await call(http, people.sender, serverId, "POST", "/api/messages", { channelId, content });
      return `message:${body.id as string}`;
    };

    // Channel message.
    await applyPresence(people);
    transports.reset();
    const channelKey = await send(channel.id, "launch is at noon");
    const channelResult = await checkConsistency({
      label: "channel", eventKey: channelKey, people, transports,
      expectNotified: ["desktop", "mobile", "webOnly", "idle"],
    });
    assert.deepEqual(
      channelResult.rows.map((row) => `${channelResult.nameOf.get(row.receiverId)}:${row.decision}`).sort(),
      ["desktop:notify", "idle:notify", "mentions:suppressed:server_mentions", "mobile:notify", "none:suppressed:server_none", "webOnly:notify"],
      "the muted member has no row, the sender none",
    );
    // A sanity witness that the plan really differs per person.
    const reached = channelResult.reached;
    assert.deepEqual([...reached.get(people.desktop.id)!].sort(), ["apnsSync", "desktop", "mobileSocket"]);
    assert.deepEqual([...reached.get(people.mobile.id)!].sort(), ["apnsAlert", "mobileSocket"]);
    assert.deepEqual([...reached.get(people.webOnly.id)!].sort(), ["desktop", "mobileSocket", "web"]);
    assert.deepEqual([...reached.get(people.idle.id)!].sort(), ["apnsAlert", "desktop", "mobileSocket", "web"]);

    // Thread reply: everyone follows; a muted parent silences its threads too.
    const parentId = (await call(http, people.idle, serverId, "POST", "/api/messages", { channelId: channel.id, content: "parent" })).id as string;
    const thread = await getOrCreateThread(parentId, people.idle.id, "user");
    // The Follow button (a thread has no level, only its follow state).
    for (const label of labels) {
      if (label !== "sender" && label !== "idle") {
        await setLevel({ userId: people[label].id, scope: "thread", id: thread.id, level: "all", accessChecked: true, button: true });
      }
    }
    await drainAll();
    await applyPresence(people);
    transports.reset();
    const threadKey = await send(thread.id, "reply in the thread");
    const threadResult = await checkConsistency({
      label: "thread", eventKey: threadKey, people, transports,
      // `none` follows by hand, but its server level silences the thread too.
      expectNotified: ["mentions", "desktop", "mobile", "webOnly", "idle"],
    });
    assert.deepEqual(
      threadResult.rows.map((row) => `${threadResult.nameOf.get(row.receiverId)}:${row.category}`).sort(),
      ["desktop:thread", "idle:thread", "mentions:thread", "mobile:thread", "muted:thread", "none:thread", "webOnly:thread"],
    );

    // DMs: one per receiver state that can be in a DM.
    for (const label of ["mentions", "none", "desktop", "mobile", "webOnly", "idle"] as const) {
      const dm = await findOrCreateUserDM(serverId, people.sender.id, people[label].id);
      await applyPresence(people);
      transports.reset();
      const dmKey = await send(dm!.id, `hello ${label}`);
      await checkConsistency({
        label: `dm ${label}`, eventKey: dmKey, people, transports,
        expectNotified: label === "none" ? [] : [label],
      });
    }
  } finally {
    transports.restore();
  }
});
