import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// Keyed retry safety for task create and action prepare (same contract as
// message send's idempotencyKey): same key + same request replays the first
// response and writes nothing; same key + different request is refused with
// send's 409 `idempotency_key_reused` shape; no key keeps the old behaviour.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { actionCards, agentApiIdempotencyKeys, tasks, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import {
  AGENT_API_IDEMPOTENCY_KEY_TTL_MS,
  __setAgentApiIdempotencyRaceHooksForTests,
  pruneExpiredAgentApiIdempotencyKeys,
} from "../services/agentApiIdempotencyService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type Fixture = {
  channelId: string;
  channelName: string;
  agentId: string;
  agentName: string;
  apiKey: string;
};

type Reply = { status: number; body: Record<string, unknown> };

afterEach(() => {
  __setAgentApiIdempotencyRaceHooksForTests({});
});

/**
 * Hold every racer after its replay lookup missed until all have arrived, so
 * each one really writes and the ledger insert decides the winner (the
 * losers roll back and replay). Bounded, so a bug fails instead of hanging.
 */
function raceAllPastTheLookup(parties: number) {
  let arrived = 0;
  let lost = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  __setAgentApiIdempotencyRaceHooksForTests({
    afterLookupMiss: async () => {
      arrived += 1;
      if (arrived >= parties) release();
      await Promise.race([open, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    },
    onRaceLost: () => { lost += 1; },
  });
  return { get arrived() { return arrived; }, get lost() { return lost; } };
}

async function seedFixture(label: string): Promise<Fixture> {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix}`,
    displayName: "Idempotent Writes Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Idempotent Writes", `${label}-${suffix}`, owner.id);
  const agent = await createAgent(server.id, `IdemBot${suffix}`, { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, `idem-${suffix}`);
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "tasks"],
    name: "idempotent-writes-test",
    issuedVia: "computer",
    createdByUserId: null,
  });
  return { channelId: channel.id, channelName: channel.name, agentId: agent.id, agentName: agent.name, apiKey };
}

async function post(baseUrl: string, fixture: Fixture, path: string, body: Record<string, unknown>): Promise<Reply> {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function taskCount(channelId: string): Promise<number> {
  return (await getDb().select({ id: tasks.id }).from(tasks).where(eq(tasks.channelId, channelId))).length;
}

async function cardCount(agentId: string): Promise<number> {
  return (await getDb().select({ id: actionCards.id }).from(actionCards).where(eq(actionCards.requesterAgentId, agentId))).length;
}

async function ledgerRows(agentId: string, route: string) {
  return getDb().select().from(agentApiIdempotencyKeys).where(and(
    eq(agentApiIdempotencyKeys.agentId, agentId),
    eq(agentApiIdempotencyKeys.route, route),
  ));
}

function assertReusedKeyRefusal(reply: Reply): void {
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.code, "idempotency_key_reused");
  assert.equal(reply.body.mismatch, "request");
  assert.equal(typeof reply.body.error, "string");
  assert.equal(typeof reply.body.suggestedNextAction, "string");
}

test("task create: same key + same request replays the first response and creates nothing", async ({ app }) => {
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const fixture = await seedFixture("idem-task-replay");
  const body = { channel: `#${fixture.channelName}`, tasks: [{ title: "write the spec" }, { title: "ship it", creates_resource: true }], idempotencyKey: "create-1" };

  const first = await post(app.baseUrl, fixture, "/tasks", body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstTasks = first.body.tasks as Array<{ taskNumber: number; messageId: string }>;
  assert.equal(firstTasks.length, 2);
  assert.equal(await taskCount(fixture.channelId), 2);

  // Key order and an explicit default (creates_resource: false) do not change the request.
  const replay = await post(app.baseUrl, fixture, "/tasks", {
    idempotencyKey: "create-1",
    tasks: [{ title: "write the spec", creates_resource: false }, { creates_resource: true, title: "ship it" }],
    channel: `#${fixture.channelName}`,
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body, "the replay is the first response, byte for byte");
  assert.equal(await taskCount(fixture.channelId), 2, "the replay created no task");
  assert.equal((await ledgerRows(fixture.agentId, "taskCreate")).length, 1);
});

test("task create: same key + different request is refused with send's 409 shape", async ({ app }) => {
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const fixture = await seedFixture("idem-task-mismatch");
  const first = await post(app.baseUrl, fixture, "/tasks", { channel: `#${fixture.channelName}`, tasks: [{ title: "a" }], idempotencyKey: "create-1" });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  assertReusedKeyRefusal(await post(app.baseUrl, fixture, "/tasks", { channel: `#${fixture.channelName}`, tasks: [{ title: "b" }], idempotencyKey: "create-1" }));
  assertReusedKeyRefusal(await post(app.baseUrl, fixture, "/tasks", { channel: `#${fixture.channelName}`, tasks: [{ title: "a", creates_resource: true }], idempotencyKey: "create-1" }));
  assertReusedKeyRefusal(await post(app.baseUrl, fixture, "/tasks", { channel: `#${fixture.channelName}`, tasks: [{ title: "a" }], assignee: `@${fixture.agentName}`, idempotencyKey: "create-1" }));
  assert.equal(await taskCount(fixture.channelId), 1, "a refused reuse creates nothing");
});

test("task create: without a key every request creates (unchanged behaviour)", async ({ app }) => {
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const fixture = await seedFixture("idem-task-nokey");
  const body = { channel: `#${fixture.channelName}`, tasks: [{ title: "same title" }] };
  const a = await post(app.baseUrl, fixture, "/tasks", body);
  const b = await post(app.baseUrl, fixture, "/tasks", { ...body, idempotencyKey: "   " });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notDeepEqual(a.body, b.body);
  assert.equal(await taskCount(fixture.channelId), 2);
  assert.equal((await ledgerRows(fixture.agentId, "taskCreate")).length, 0, "no key, no ledger row");
});

test("task create: an assigned create replays its assignment receipt too", async ({ app }) => {
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const fixture = await seedFixture("idem-task-assigned");
  const body = { channel: `#${fixture.channelName}`, tasks: [{ title: "self-start" }], assignee: `@${fixture.agentName}`, idempotencyKey: "assigned-1" };
  const first = await post(app.baseUrl, fixture, "/tasks", body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.assignmentReceipt, "assigned create returns a receipt");
  const replay = await post(app.baseUrl, fixture, "/tasks", body);
  assert.deepEqual(replay.body, first.body);
  assert.equal(await taskCount(fixture.channelId), 1);
});

test("task create: concurrent identical first requests create exactly one set of tasks", async ({ app }) => {
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const fixture = await seedFixture("idem-task-race");
  const body = { channel: `#${fixture.channelName}`, tasks: [{ title: "only once" }], idempotencyKey: "race-1" };
  const race = raceAllPastTheLookup(4);
  const replies = await Promise.all(Array.from({ length: 4 }, () => post(app.baseUrl, fixture, "/tasks", body)));
  assert.equal(race.arrived, 4, "every racer missed the replay lookup and wrote");
  assert.equal(race.lost, 3, "three writes lost the key and rolled back");
  for (const reply of replies) {
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(reply.body, replies[0]!.body, "every racer gets the winner's response");
  }
  assert.equal(await taskCount(fixture.channelId), 1);
  assert.equal((await ledgerRows(fixture.agentId, "taskCreate")).length, 1);
});

const cardAction = (name: string) => ({ type: "channel:create", name });

test("action prepare: same key + same request replays the first card (status 201, same messageId) and posts nothing", async ({ app }) => {
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const fixture = await seedFixture("idem-card-replay");
  const body = { target: `#${fixture.channelName}`, action: cardAction("idem-room"), idempotencyKey: "card-1" };
  const first = await post(app.baseUrl, fixture, "/prepare-action", body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const replay = await post(app.baseUrl, fixture, "/prepare-action", body);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, first.body);
  assert.equal(await cardCount(fixture.agentId), 1, "the replay prepared no card");

  // The key is scoped to (agent, route): the same key on task create is a separate write.
  const created = await post(app.baseUrl, fixture, "/tasks", { channel: `#${fixture.channelName}`, tasks: [{ title: "x" }], idempotencyKey: "card-1" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
});

test("action prepare: same key + different request is refused; no key prepares every time", async ({ app }) => {
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const fixture = await seedFixture("idem-card-mismatch");
  const first = await post(app.baseUrl, fixture, "/prepare-action", { target: `#${fixture.channelName}`, action: cardAction("room-a"), idempotencyKey: "card-1" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assertReusedKeyRefusal(await post(app.baseUrl, fixture, "/prepare-action", { target: `#${fixture.channelName}`, action: cardAction("room-b"), idempotencyKey: "card-1" }));
  assert.equal(await cardCount(fixture.agentId), 1);

  const a = await post(app.baseUrl, fixture, "/prepare-action", { target: `#${fixture.channelName}`, action: cardAction("room-c") });
  const b = await post(app.baseUrl, fixture, "/prepare-action", { target: `#${fixture.channelName}`, action: cardAction("room-c") });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.messageId, b.body.messageId);
  assert.equal(await cardCount(fixture.agentId), 3);
});

test("action prepare: concurrent identical first requests prepare exactly one card", async ({ app }) => {
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const fixture = await seedFixture("idem-card-race");
  const body = { target: `#${fixture.channelName}`, action: cardAction("race-room"), idempotencyKey: "race-1" };
  const race = raceAllPastTheLookup(4);
  const replies = await Promise.all(Array.from({ length: 4 }, () => post(app.baseUrl, fixture, "/prepare-action", body)));
  assert.equal(race.arrived, 4, "every racer missed the replay lookup and wrote");
  assert.equal(race.lost, 3, "three cards lost the key and rolled back");
  for (const reply of replies) {
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.deepEqual(reply.body, replies[0]!.body);
  }
  assert.equal(await cardCount(fixture.agentId), 1);
  assert.equal((await ledgerRows(fixture.agentId, "actionPrepare")).length, 1);
});

test("task create: concurrent different requests with one key: one creates, the rest are refused", async ({ app }) => {
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const fixture = await seedFixture("idem-task-race-mismatch");
  const race = raceAllPastTheLookup(3);
  const replies = await Promise.all(["a", "b", "c"].map((title) =>
    post(app.baseUrl, fixture, "/tasks", { channel: `#${fixture.channelName}`, tasks: [{ title }], idempotencyKey: "race-2" })));
  assert.equal(race.arrived, 3);
  assert.equal(replies.filter((reply) => reply.status === 200).length, 1, JSON.stringify(replies));
  for (const reply of replies.filter((candidate) => candidate.status !== 200)) assertReusedKeyRefusal(reply);
  assert.equal(await taskCount(fixture.channelId), 1);
});

/** Age every ledger row of this agent by `ms` (keys are valid for 24 hours). */
async function ageLedger(agentId: string, ms: number): Promise<void> {
  await getDb().update(agentApiIdempotencyKeys)
    .set({ createdAt: sql`${agentApiIdempotencyKeys.createdAt} - make_interval(secs => ${ms / 1000})` })
    .where(eq(agentApiIdempotencyKeys.agentId, agentId));
}

test("task create: a key older than 24 hours is forgotten: the same key is a new request (creates, no replay, no 409)", async ({ app }) => {
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const fixture = await seedFixture("idem-task-expired");
  const body = { channel: `#${fixture.channelName}`, tasks: [{ title: "daily" }], idempotencyKey: "daily-1" };
  const first = await post(app.baseUrl, fixture, "/tasks", body);
  assert.equal(first.status, 200, JSON.stringify(first.body));

  // Still inside the window (23h59m): replay, nothing new.
  await ageLedger(fixture.agentId, AGENT_API_IDEMPOTENCY_KEY_TTL_MS - 60_000);
  const live = await post(app.baseUrl, fixture, "/tasks", body);
  assert.deepEqual(live.body, first.body);
  assertReusedKeyRefusal(await post(app.baseUrl, fixture, "/tasks", { ...body, tasks: [{ title: "other" }] }));
  assert.equal(await taskCount(fixture.channelId), 1);

  // Past the window: the same request creates again, and a different request is not refused.
  await ageLedger(fixture.agentId, 2 * 60_000);
  const again = await post(app.baseUrl, fixture, "/tasks", body);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.notDeepEqual(again.body, first.body, "no replay of the expired response");
  assert.equal(await taskCount(fixture.channelId), 2);
  const [row] = await ledgerRows(fixture.agentId, "taskCreate");
  assert.deepEqual(row!.responseBody, again.body, "the key now binds the new request and response");
  assert.ok(Date.now() - row!.createdAt.getTime() < 60_000, "the replaced row is live again");
  assert.deepEqual((await post(app.baseUrl, fixture, "/tasks", body)).body, again.body, "and replays it");

  await ageLedger(fixture.agentId, AGENT_API_IDEMPOTENCY_KEY_TTL_MS + 1_000);
  const different = await post(app.baseUrl, fixture, "/tasks", { ...body, tasks: [{ title: "different" }] });
  assert.equal(different.status, 200, "an expired key does not refuse a different request");
  assert.equal(await taskCount(fixture.channelId), 3);
});

test("action prepare: an expired key prepares a new card", async ({ app }) => {
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const fixture = await seedFixture("idem-card-expired");
  const body = { target: `#${fixture.channelName}`, action: cardAction("expiring-room"), idempotencyKey: "card-x" };
  const first = await post(app.baseUrl, fixture, "/prepare-action", body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await ageLedger(fixture.agentId, AGENT_API_IDEMPOTENCY_KEY_TTL_MS + 1_000);
  const again = await post(app.baseUrl, fixture, "/prepare-action", body);
  assert.equal(again.status, 201);
  assert.notEqual(again.body.messageId, first.body.messageId);
  assert.equal(await cardCount(fixture.agentId), 2);
});

test("concurrent first requests reusing one expired key still write exactly once", async ({ app }) => {
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const fixture = await seedFixture("idem-task-expired-race");
  const body = { channel: `#${fixture.channelName}`, tasks: [{ title: "again" }], idempotencyKey: "race-expired" };
  assert.equal((await post(app.baseUrl, fixture, "/tasks", body)).status, 200);
  await ageLedger(fixture.agentId, AGENT_API_IDEMPOTENCY_KEY_TTL_MS + 1_000);
  const race = raceAllPastTheLookup(4);
  const replies = await Promise.all(Array.from({ length: 4 }, () => post(app.baseUrl, fixture, "/tasks", body)));
  assert.equal(race.arrived, 4);
  assert.equal(race.lost, 3);
  for (const reply of replies) assert.deepEqual(reply.body, replies[0]!.body);
  assert.equal(await taskCount(fixture.channelId), 2, "the original plus exactly one new set");
});

test("cleanup deletes only expired rows, oldest first, in bounded batches", async ({ app }) => {
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const fixture = await seedFixture("idem-prune");
  const now = new Date();
  const hour = 60 * 60 * 1000;
  const row = (key: string, ageMs: number) => ({
    agentId: fixture.agentId,
    route: "taskCreate",
    idempotencyKey: key,
    requestFingerprint: "f",
    responseStatus: 200,
    responseBody: {},
    createdAt: new Date(now.getTime() - ageMs),
  });
  await getDb().insert(agentApiIdempotencyKeys).values([
    ...Array.from({ length: 7 }, (_, index) => row(`expired-${index}`, AGENT_API_IDEMPOTENCY_KEY_TTL_MS + (index + 1) * hour)),
    row("live-young", hour),
    row("live-edge", AGENT_API_IDEMPOTENCY_KEY_TTL_MS - 60_000),
  ]);
  const keys = async () => (await ledgerRows(fixture.agentId, "taskCreate")).map((r) => r.idempotencyKey).sort();

  // Bounded: 2 batches of 3 delete 6 of the 7 expired rows, oldest first.
  assert.equal(await pruneExpiredAgentApiIdempotencyKeys({ now, batchSize: 3, maxBatches: 2 }), 6);
  assert.deepEqual(await keys(), ["expired-0", "live-edge", "live-young"]);
  // The next run finishes the backlog and stops at the first short batch.
  assert.equal(await pruneExpiredAgentApiIdempotencyKeys({ now, batchSize: 3, maxBatches: 2 }), 1);
  assert.deepEqual(await keys(), ["live-edge", "live-young"]);
  assert.equal(await pruneExpiredAgentApiIdempotencyKeys({ now }), 0, "live keys are never pruned");
});
