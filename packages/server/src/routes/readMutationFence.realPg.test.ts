// Route teeth for task #93 line B on real PostgreSQL: every human route that reaches read-state admission maps the
// typed fence refusal to 403, and routes whose read-state write is only a side effect keep their primary action
// successful. The human's removal is held uncommitted in another session while the real HTTP request runs: request-level
// checks still see the committed member row, and the admission fence is the backend seen waiting on it (attributed to
// the removal session's pid). The agent send's held response is covered the same way, with the agent's own Server
// membership removal held uncommitted. The unread route is covered too: its access and boundary pre-read now run behind
// the same fence, so a removed human gets the typed 403 instead of a scope error surfacing as 500.
//
// CI: `probe-concurrency-real-pg`, with ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL (shared with the other fence teeth).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { getDb } from "../db/index";
import { channelHumans, channels, messages, readMutations, serverAgentMembers, serverMembers, threadFollows, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { addAgent, markAgentLegacyRead } from "../services/channelService";
import { recordInboxNotificationFacts } from "../services/inboxNotificationService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const REAL_PG_URL = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TEST_TIMEOUT_MS = 60_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const REAL_PG_TEST = { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: TEST_TIMEOUT_MS };

type TestApp = Awaited<ReturnType<typeof openTestApp>>;

async function withRealPgApp(run: (app: TestApp, observer: pg.Pool) => Promise<void>) {
  assert.ok(REAL_PG_URL, "ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL is required");
  const observer = new pg.Pool({ connectionString: REAL_PG_URL, max: 4 });
  try {
    await migrateRealPgTestDatabase(observer, MIGRATIONS_FOLDER);
    const app = await openTestApp(REAL_PG_URL, 0, {
      humanActivityMuteFlagDefaultEnabled: true,
      skipAuthRateLimit: true,
    });
    try {
      await run(app, observer);
    } finally {
      await app.close();
    }
  } finally {
    await observer.end();
  }
}

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `read-route-fence-${label}-${suffix}@slock.test`,
    name: `read-route-fence-${label}-${suffix}`,
    displayName: `read-route-fence-${label}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

/** Owner and a member actor; a public channel with messages; a thread under it with a reply the actor follows. */
async function seed() {
  const owner = await seedUser("owner");
  const actor = await seedUser("actor");
  const suffix = randomUUID().slice(0, 8);
  const server = await createServer(`Read Route Fence ${suffix}`, `read-route-fence-${suffix}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: actor.id, role: "member" });
  const [channel] = await getDb().insert(channels).values({
    serverId: server.id,
    name: `read-route-fence-${suffix}`,
    type: "channel",
  }).returning();
  await getDb().insert(channelHumans).values([
    { channelId: channel.id, userId: owner.id, role: "admin" },
    { channelId: channel.id, userId: actor.id },
  ]);
  const parent = await createMessage(channel.id, "user", owner.id, "read-route-fence parent");
  const latest = await createMessage(channel.id, "user", owner.id, "read-route-fence latest");
  const [thread] = await getDb().insert(channels).values({
    serverId: server.id,
    name: `read-route-fence-thread-${suffix}`,
    type: "thread",
    parentMessageId: parent.id,
  }).returning();
  await createMessage(thread.id, "user", owner.id, "read-route-fence thread reply");
  await getDb().insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "user",
    followerId: actor.id,
    parentMessageId: parent.id,
    reason: "manual",
  });
  const token = await tokenForHuman(actor.email);
  return { owner, actor, server, channel, parent, latest, thread, token };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function waitForLockWaiter(observer: pg.Pool, queryLike: string, blockedBy: number) {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND $2::int = ANY(pg_blocking_pids(pid))
       LIMIT 1`,
      [queryLike, blockedBy],
    );
    if (rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`no backend waited on a lock for ${queryLike} behind pid ${blockedBy} within ${LOCK_WAIT_TIMEOUT_MS}ms`);
}

/** Holds the actor's Server removal uncommitted, sends the request, requires the admission fence to wait on it, commits. */
async function requestDuringRemoval(
  observer: pg.Pool,
  seeded: Seeded,
  send: () => Promise<Response>,
  removal: { sql: string; params: unknown[]; waitLike: string } = {
    sql: "DELETE FROM server_members WHERE server_id = $1 AND user_id = $2",
    params: [seeded.server.id, seeded.actor.id],
    waitLike: "%from server_members%for share%",
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const session = await observer.connect();
  let response: Promise<{ status: number; body: Record<string, unknown> }> | undefined;
  const state = { settled: false };
  try {
    await session.query("BEGIN");
    const { rows: [removing] } = await session.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await session.query(removal.sql, removal.params);
    response = send().then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }));
    response.then(() => { state.settled = true; }, () => { state.settled = true; });
    await waitForLockWaiter(observer, removal.waitLike, removing!.pid);
    assert.equal(state.settled, false, "the request must wait in the admission fence for the uncommitted removal");
    await session.query("COMMIT");
  } finally {
    await session.query("ROLLBACK").catch(() => undefined);
    session.release();
  }
  return await response!;
}

function post(app: TestApp, seeded: Seeded, path: string, body: unknown = {}) {
  return fetch(`${app.baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${seeded.token}`, "X-Server-Id": seeded.server.id, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function actorMutations(seeded: Seeded) {
  return (await getDb().select({ id: readMutations.mutationId }).from(readMutations)
    .where(and(eq(readMutations.serverId, seeded.server.id), eq(readMutations.principalId, seeded.actor.id)))).length;
}

const REFUSED_ROUTES: Array<{ name: string; request: (app: TestApp, seeded: Seeded) => Promise<Response> }> = [
  { name: "POST /api/read-mutations (channel_read_all)", request: (app, s) => post(app, s, "/api/read-mutations", { mutationId: randomUUID(), kind: "channel_read_all", scopeId: s.channel.id }) },
  { name: "POST /api/channels/:id/read-all", request: (app, s) => post(app, s, `/api/channels/${s.channel.id}/read-all`) },
  { name: "POST /api/channels/:id/read", request: (app, s) => post(app, s, `/api/channels/${s.channel.id}/read`, { seq: Number(s.latest.seq) }) },
  { name: "POST /api/channels/inbox/done", request: (app, s) => post(app, s, "/api/channels/inbox/done", { channelId: s.channel.id }) },
  { name: "POST /api/channels/inbox/read-all", request: (app, s) => post(app, s, "/api/channels/inbox/read-all") },
  { name: "POST /api/channels/threads/done", request: (app, s) => post(app, s, "/api/channels/threads/done", { threadChannelId: s.thread.id }) },
  { name: "POST /api/channels/:id/unread", request: (app, s) => post(app, s, `/api/channels/${s.channel.id}/unread`) },
];

for (const route of REFUSED_ROUTES) {
  test(`real PG route: ${route.name} answers 403 when the admission fence refuses a human removed after the request-level checks`, REAL_PG_TEST, async () => {
    await withRealPgApp(async (app, observer) => {
      const seeded = await seed();
      const res = await requestDuringRemoval(observer, seeded, () => route.request(app, seeded));
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.code, "READ_MUTATION_FENCE_REFUSED");
      assert.equal(await actorMutations(seeded), 0, "the refused admission wrote no command rows");
    });
  });
}

test("real PG route: POST /api/channels/threads/follow still follows when the read-state side effect is refused", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, observer) => {
    const seeded = await seed();
    await getDb().delete(threadFollows).where(and(eq(threadFollows.threadChannelId, seeded.thread.id), eq(threadFollows.followerId, seeded.actor.id)));
    const res = await requestDuringRemoval(observer, seeded, () => post(app, seeded, "/api/channels/threads/follow", { parentMessageId: seeded.parent.id }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const follows = await getDb().select().from(threadFollows)
      .where(and(eq(threadFollows.threadChannelId, seeded.thread.id), eq(threadFollows.followerId, seeded.actor.id)));
    assert.equal(follows.length, 1, "the follow committed");
    assert.equal(await actorMutations(seeded), 0, "the refused read-state side effect wrote no command rows");
  });
});

test("real PG route: POST /api/channels/threads/unfollow still unfollows when the read-state side effect is refused", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, observer) => {
    const seeded = await seed();
    const res = await requestDuringRemoval(observer, seeded, () => post(app, seeded, "/api/channels/threads/unfollow", { threadChannelId: seeded.thread.id }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [follow] = await getDb().select({ unfollowedAt: threadFollows.unfollowedAt }).from(threadFollows)
      .where(and(eq(threadFollows.threadChannelId, seeded.thread.id), eq(threadFollows.followerId, seeded.actor.id)));
    assert.ok(follow?.unfollowedAt, "the unfollow committed");
    assert.equal(await actorMutations(seeded), 0);
  });
});

test("real PG route: POST /api/messages as a thread reply still sends when the sender's own read is refused", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, observer) => {
    const seeded = await seed();
    const content = `read-route-fence reply ${randomUUID().slice(0, 8)}`;
    const res = await requestDuringRemoval(observer, seeded, () => post(app, seeded, "/api/messages", { channelId: seeded.thread.id, content }));
    assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.body));
    const sent = await getDb().select({ id: messages.id }).from(messages)
      .where(and(eq(messages.channelId, seeded.thread.id), eq(messages.content, content)));
    assert.equal(sent.length, 1, "the message committed");
    assert.equal(await actorMutations(seeded), 0, "the refused own-read wrote no command rows");
  });
});

test("real PG route: POST /internal/agent-api/send still answers held when the agent's own read is refused", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, observer) => {
    const seeded = await seed();
    const agent = await createAgent(seeded.server.id, "ReadRouteFenceBot", { runtime: "claude", model: "sonnet" });
    await addAgent(seeded.channel.id, agent.id);
    const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "read-route-fence", issuedVia: "computer", createdByUserId: null });
    await markAgentLegacyRead(agent.id, seeded.channel.id, Number(seeded.latest.seq));
    const fresh = await createMessage(seeded.channel.id, "user", seeded.owner.id, "read-route-fence fresh unread");
    await recordInboxNotificationFacts([{
      receiverType: "agent",
      receiverId: agent.id,
      serverId: seeded.server.id,
      kind: "channel",
      sourceChannelId: seeded.channel.id,
      messageId: fresh.id,
      messageSeq: fresh.seq,
      activityAt: fresh.createdAt,
      personalMention: false,
      unreadEligible: true,
    }]);

    const res = await requestDuringRemoval(observer, seeded, () => fetch(`${app.baseUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target: `#${seeded.channel.name}`, content: "read-route-fence draft", seenUpToSeq: Number(seeded.latest.seq) }),
    }), {
      sql: "DELETE FROM server_agent_members WHERE server_id = $1 AND agent_id = $2",
      params: [seeded.server.id, agent.id],
      waitLike: "%from server_agent_members%for share%",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.state, "held");
    const agentMutations = await getDb().select({ id: readMutations.mutationId }).from(readMutations)
      .where(and(eq(readMutations.serverId, seeded.server.id), eq(readMutations.principalId, agent.id)));
    assert.equal(agentMutations.length, 0, "the refused own-read wrote no command rows");
    const membership = await getDb().select().from(serverAgentMembers)
      .where(and(eq(serverAgentMembers.serverId, seeded.server.id), eq(serverAgentMembers.agentId, agent.id)));
    assert.equal(membership.length, 0, "the removal committed");
  });
});

test("real PG route: POST /api/channels/:id/unread still succeeds for a demoted member (the fence refuses removal, not demotion)", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, observer) => {
    const seeded = await seed();
    await getDb().update(serverMembers).set({ role: "admin" })
      .where(and(eq(serverMembers.serverId, seeded.server.id), eq(serverMembers.userId, seeded.actor.id)));
    const res = await requestDuringRemoval(observer, seeded, () => post(app, seeded, `/api/channels/${seeded.channel.id}/unread`), {
      sql: "UPDATE server_members SET role = 'member' WHERE server_id = $1 AND user_id = $2",
      params: [seeded.server.id, seeded.actor.id],
      waitLike: "%from server_members%for share%",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    const [member] = await getDb().select({ role: serverMembers.role }).from(serverMembers)
      .where(and(eq(serverMembers.serverId, seeded.server.id), eq(serverMembers.userId, seeded.actor.id)));
    assert.equal(member?.role, "member", "the demotion committed");
  });
});

// #12135 follow-up: a level write (thread Follow / Unfollow, PUT /notification-levels) bumps the level counter in
// user_notification_level_versions, never the member row, so it does not wait behind the fences that hold the row
// FOR SHARE. Before, the bump was an UPDATE of server_members and queued behind every such holder.
test("real PG route: a level write does not wait on the member row held FOR SHARE, and its version keeps rising", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, observer) => {
    const seeded = await seed();
    const put = async (scope: "channel", id: string, level: string) => {
      const res = await fetch(`${app.baseUrl}/api/notification-levels`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${seeded.token}`, "X-Server-Id": seeded.server.id, "Content-Type": "application/json" },
        body: JSON.stringify({ scope, id, level }),
        signal: AbortSignal.timeout(LOCK_WAIT_TIMEOUT_MS),
      });
      assert.equal(res.status, 200, await res.clone().text());
      return await res.json() as { prefsVersion: number };
    };
    // A version handed out by the legacy column is never reused.
    await getDb().update(serverMembers).set({ notificationPrefsVersion: 41 })
      .where(and(eq(serverMembers.serverId, seeded.server.id), eq(serverMembers.userId, seeded.actor.id)));
    const session = await observer.connect();
    try {
      await session.query("BEGIN");
      await session.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2 FOR SHARE", [seeded.server.id, seeded.actor.id]);
      const channel = await put("channel", seeded.channel.id, "mentions");
      const unfollowed = await post(app, seeded, "/api/channels/threads/unfollow", { threadChannelId: seeded.thread.id });
      assert.equal(unfollowed.status, 200, await unfollowed.clone().text());
      const followed = await post(app, seeded, "/api/channels/threads/follow", { parentMessageId: seeded.parent.id });
      assert.equal(followed.status, 200, await followed.clone().text());
      const again = await put("channel", seeded.channel.id, "all");
      assert.equal(channel.prefsVersion, 42);
      assert.equal(again.prefsVersion, 45, "Unfollow and Follow each moved the version");
      await session.query("COMMIT");
    } finally {
      await session.query("ROLLBACK").catch(() => undefined);
      session.release();
    }
  });
});
