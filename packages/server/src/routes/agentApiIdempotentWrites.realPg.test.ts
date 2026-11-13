// Real PostgreSQL teeth for keyed task create and action prepare
// (agent_api_idempotency_keys). PGlite serializes transactions, so only a
// multi-connection Postgres shows that concurrent first requests with one
// idempotency key really write in parallel, that the losers block on the
// ledger key until the winner commits, roll their own write back, and replay
// the winner's response: exactly one set of tasks / one card.
//
// And for a keyed v2 send racing a card send (RFC 082) against a text send
// under one key: both pass their checks, the loser's insert waits on the
// winner's uncommitted row in idx_messages_agent_send_key (sender_id,
// agent_send_key), then writes nothing and gets the 409: one message.
//
// CI: `probe-concurrency-real-pg`, with AGENT_API_IDEMPOTENCY_REAL_PG_URL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { isMessageCardMetadata, type MessageCardInput } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, agentApiIdempotencyKeys, messageCardRevisions, messages, tasks, users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { fixturePasswordHash } from "../test/integration/credentials";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AGENT_API_IDEMPOTENCY_KEY_TTL_MS, __setAgentApiIdempotencyRaceHooksForTests } from "../services/agentApiIdempotencyService";
import { __setAgentSendRaceHooksForTests } from "../services/agentSendReplayService";
import { withChannelDelivery } from "../test/orchestratorStub";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const REAL_PG_URL = process.env.AGENT_API_IDEMPOTENCY_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.AGENT_API_IDEMPOTENCY_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const REAL_PG_TEST = { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 120_000 };
const RACERS = 6;

type TestApp = Awaited<ReturnType<typeof openTestApp>>;
type Reply = { status: number; body: Record<string, unknown> };

async function withRealPgApp(run: (app: TestApp) => Promise<void>) {
  assert.ok(REAL_PG_URL, "AGENT_API_IDEMPOTENCY_REAL_PG_URL is required");
  const migrator = new pg.Pool({ connectionString: REAL_PG_URL, max: 2 });
  try {
    await migrateRealPgTestDatabase(migrator, MIGRATIONS_FOLDER);
  } finally {
    await migrator.end();
  }
  const app = await openTestApp(REAL_PG_URL, 0, {
    humanActivityMuteFlagDefaultEnabled: true,
    skipAuthRateLimit: true,
  });
  app.app.set("agentOrchestrator", withChannelDelivery({
    deliverMessage: async () => ({ status: "queued", reason: "local_inbox" }),
  }));
  try {
    await run(app);
  } finally {
    __setAgentApiIdempotencyRaceHooksForTests({});
    __setAgentSendRaceHooksForTests({});
    await app.close();
  }
}

/** Every racer misses the replay lookup before any writes; counts the writes that lost the key. */
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

/**
 * `channelHuman: false` for task creates: the route posts its "📋 … created"
 * summary after responding and never awaits it, so a human member's mobile push
 * for it could be scheduled after the close hook drained and run on an ended
 * pool, failing the next case. Without a human receiver it enqueues no push.
 */
async function seedWorld({ channelHuman }: { channelHuman: boolean }) {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `idem-real-pg-${suffix}@slock.test`,
    name: `idem-real-pg-${suffix}`,
    displayName: "Idempotency Real PG Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Idempotency Real PG", `idem-real-pg-${suffix}`, owner.id);
  const agent = await createAgent(server.id, `IdemRealPg${suffix}`, { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, `idem-real-pg-${suffix}`);
  if (channelHuman) await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read", "tasks"], name: "idem-real-pg", issuedVia: "computer", createdByUserId: null });
  return { agentId: agent.id, channelId: channel.id, channelName: channel.name, apiKey };
}

async function post(baseUrl: string, apiKey: string, path: string, body: Record<string, unknown>): Promise<Reply> {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

test("real PG: concurrent first task creates with one key create one set of tasks; every racer gets the winner's response", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app) => {
    const world = await seedWorld({ channelHuman: false });
    const race = raceAllPastTheLookup(RACERS);
    const body = { channel: `#${world.channelName}`, tasks: [{ title: "once" }, { title: "twice?" }], idempotencyKey: "same-key" };
    const replies = await Promise.all(Array.from({ length: RACERS }, () => post(app.baseUrl, world.apiKey, "/tasks", body)));
    __setAgentApiIdempotencyRaceHooksForTests({});

    assert.equal(race.arrived, RACERS, "every racer passed the replay lookup and wrote");
    assert.equal(race.lost, RACERS - 1, "all but one write lost the key and rolled back");
    for (const reply of replies) {
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.deepEqual(reply.body, replies[0]!.body);
    }
    const rows = await getDb().select().from(tasks).where(eq(tasks.channelId, world.channelId));
    assert.equal(rows.length, 2, "one set of tasks");
    assert.deepEqual(
      rows.map((row) => row.taskNumber).sort(),
      (replies[0]!.body.tasks as Array<{ taskNumber: number }>).map((task) => task.taskNumber).sort(),
    );
    const hostMessages = await getDb().select({ id: messages.id }).from(messages).where(and(
      eq(messages.channelId, world.channelId),
      eq(messages.senderId, world.agentId),
    ));
    assert.equal(hostMessages.length, 2, "the losers' host messages rolled back with their tasks");
    const ledger = await getDb().select().from(agentApiIdempotencyKeys).where(eq(agentApiIdempotencyKeys.agentId, world.agentId));
    assert.equal(ledger.length, 1);
  });
});

test("real PG: concurrent first action prepares with one key post one card", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app) => {
    const world = await seedWorld({ channelHuman: true });
    const race = raceAllPastTheLookup(RACERS);
    const body = { target: `#${world.channelName}`, action: { type: "channel:create", name: "real-pg-room" }, idempotencyKey: "same-key" };
    const replies = await Promise.all(Array.from({ length: RACERS }, () => post(app.baseUrl, world.apiKey, "/prepare-action", body)));
    __setAgentApiIdempotencyRaceHooksForTests({});

    assert.equal(race.arrived, RACERS);
    assert.equal(race.lost, RACERS - 1);
    for (const reply of replies) {
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      assert.deepEqual(reply.body, replies[0]!.body);
    }
    const cards = await getDb().select({ messageId: actionCards.messageId }).from(actionCards).where(eq(actionCards.requesterAgentId, world.agentId));
    assert.deepEqual(cards.map((card) => card.messageId), [replies[0]!.body.messageId], "one card, the replayed one");
  });
});

test("real PG: concurrent requests reusing one EXPIRED key replace it once: one new set of tasks", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app) => {
    const world = await seedWorld({ channelHuman: false });
    const body = { channel: `#${world.channelName}`, tasks: [{ title: "daily" }], idempotencyKey: "expired-key" };
    const first = await post(app.baseUrl, world.apiKey, "/tasks", body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await getDb().update(agentApiIdempotencyKeys)
      .set({ createdAt: new Date(Date.now() - AGENT_API_IDEMPOTENCY_KEY_TTL_MS - 60_000) })
      .where(eq(agentApiIdempotencyKeys.agentId, world.agentId));

    // Every racer ignores the expired row, writes, and reaches the conditional
    // upsert; the first replaces the row, the rest re-check the now-live row and lose.
    const race = raceAllPastTheLookup(RACERS);
    const replies = await Promise.all(Array.from({ length: RACERS }, () => post(app.baseUrl, world.apiKey, "/tasks", body)));
    __setAgentApiIdempotencyRaceHooksForTests({});
    assert.equal(race.arrived, RACERS);
    assert.equal(race.lost, RACERS - 1);
    for (const reply of replies) {
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.deepEqual(reply.body, replies[0]!.body);
    }
    assert.notDeepEqual(replies[0]!.body, first.body, "the expired response is not replayed");
    const rows = await getDb().select().from(tasks).where(eq(tasks.channelId, world.channelId));
    assert.equal(rows.length, 2, "the original plus exactly one new set");
  });
});

// --- A card send and a text send racing under one send key (RFC 082) ---

const RACE_CARD: MessageCardInput = {
  version: 1,
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["title", "state"] },
    title: { type: "Text", props: { text: "Raft App 1.19.0 (11900001)" } },
    state: { type: "Badge", props: { text: "In review", tone: "review" } },
  },
};
const RACE_TIMEOUT_MS = 15_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function within<T>(promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), RACE_TIMEOUT_MS)),
  ]);
}

type SendKind = "card" | "text";

/**
 * Holds the two sends under `key` inside their transactions: each past every
 * check, before its insert; and the one whose insert won, before it commits.
 * The test opens the gates in the order it races.
 */
function holdSendsAtTheInsert(key: string) {
  const arrived: SendKind[] = [];
  const inserted: SendKind[] = [];
  const bothArrived = deferred();
  const winnerInserted = deferred();
  const gate = { card: deferred(), text: deferred() };
  const commit = deferred();
  const kindOf = (actionMetadata: unknown): SendKind => (isMessageCardMetadata(actionMetadata) ? "card" : "text");
  __setAgentSendRaceHooksForTests({
    beforeInsert: async ({ agentSendKey, actionMetadata }) => {
      if (agentSendKey !== key) return;
      const kind = kindOf(actionMetadata);
      arrived.push(kind);
      if (arrived.length === 2) bothArrived.resolve();
      await within(gate[kind].promise, `the ${kind} send's turn to insert`);
    },
    afterInsert: async ({ agentSendKey, actionMetadata }) => {
      if (agentSendKey !== key) return;
      inserted.push(kindOf(actionMetadata));
      winnerInserted.resolve();
      await within(commit.promise, "the winner's commit");
    },
  });
  return { arrived, inserted, bothArrived: bothArrived.promise, winnerInserted: winnerInserted.promise, gate, commit };
}

/** Polls until a backend's insert into messages waits on a lock (the loser's, on the winner's open transaction). */
async function waitForBlockedMessageInsert(pool: pg.Pool): Promise<{ waitEvent: string }> {
  const deadline = Date.now() + RACE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ wait_event: string }>(
      `SELECT wait_event FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE 'insert into "messages"%'`,
    );
    if (rows[0]) return { waitEvent: rows[0].wait_event };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the losing send's insert never waited on the winner's row");
}

for (const winner of ["card", "text"] as const) {
  const loser: SendKind = winner === "card" ? "text" : "card";
  test(`real PG: a card send and a text send racing under one key write one message; the ${winner} send wins, the ${loser} send writes nothing and gets the 409`, REAL_PG_TEST, async () => {
    await withRealPgApp(async (app) => {
      const world = await seedWorld({ channelHuman: false });
      const key = `race-${winner}-${randomUUID()}`;
      const target = `#${world.channelName}`;
      // The same text, so the replay check gets to the card: the text send has none.
      const content = "Raft App 1.19.0 (11900001): in review";
      const bodies: Record<SendKind, Record<string, unknown>> = {
        card: { target, content, card: RACE_CARD, idempotencyKey: key },
        text: { target, content, idempotencyKey: key },
      };
      const observer = new pg.Pool({ connectionString: REAL_PG_URL, max: 1 });
      try {
        const { rows: [index] } = await observer.query<{ indexdef: string }>(
          "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_messages_agent_send_key'",
        );
        assert.match(index?.indexdef ?? "", /^CREATE UNIQUE INDEX idx_messages_agent_send_key ON \S*messages USING btree \(sender_id, agent_send_key\)/, "the guarantee: one row per (sender, key)");

        const race = holdSendsAtTheInsert(key);
        const replies: Record<SendKind, Promise<Reply>> = {
          card: post(app.baseUrl, world.apiKey, "/v2/send", bodies.card),
          text: post(app.baseUrl, world.apiKey, "/v2/send", bodies.text),
        };
        await within(race.bothArrived, "both sends to pass their checks");
        assert.equal(race.arrived.length, 2, "both sends passed every check before either inserted");

        race.gate[winner].resolve();
        await within(race.winnerInserted, `the ${winner} send's insert`);
        race.gate[loser].resolve();
        const blocked = await waitForBlockedMessageInsert(observer);
        // In flight while the winner's row is uncommitted: the insert checks the
        // unique index first and waits for the winner's transaction to end.
        assert.equal(blocked.waitEvent, "transactionid", "the loser's insert waits on the winner's open transaction");
        race.commit.resolve();

        const [won, lost] = await Promise.all([replies[winner], replies[loser]]);
        __setAgentSendRaceHooksForTests({});
        assert.deepEqual(race.inserted, [winner], "only the winner's insert took the key: the loser's found it in the index and inserted nothing");

        assert.equal(won.status, 200, JSON.stringify(won.body));
        assert.equal(won.body.state, "sent");
        if (winner === "card") assert.deepEqual(won.body.messageCard, { revision: 1 });
        else assert.equal(Object.hasOwn(won.body, "messageCard"), false, "a text message has no messageCard");
        assert.equal(lost.status, 409, JSON.stringify(lost.body));
        assert.deepEqual([lost.body.code, lost.body.mismatch], ["idempotency_key_reused", "card"]);

        const keyed = await getDb().select().from(messages).where(and(eq(messages.senderId, world.agentId), eq(messages.agentSendKey, key)));
        assert.deepEqual(keyed.map((row) => row.id), [won.body.messageId], "exactly one message for (agent, key): the winner's");
        assert.equal(isMessageCardMetadata(keyed[0]!.actionMetadata), winner === "card");
        const sentByAgent = await getDb().select({ id: messages.id }).from(messages).where(and(eq(messages.channelId, world.channelId), eq(messages.senderId, world.agentId)));
        assert.equal(sentByAgent.length, 1, "the loser wrote no message");
        const revisions = await getDb().select().from(messageCardRevisions).where(eq(messageCardRevisions.messageId, keyed[0]!.id));
        assert.equal(revisions.length, winner === "card" ? 1 : 0, "the loser wrote no card revision");

        // Afterwards: the winner's request again is its duplicate, the loser's still the 409.
        const again = await post(app.baseUrl, world.apiKey, "/v2/send", bodies[winner]);
        assert.equal(again.status, 200, JSON.stringify(again.body));
        assert.equal(again.body.messageId, won.body.messageId);
        const loserAgain = await post(app.baseUrl, world.apiKey, "/v2/send", bodies[loser]);
        assert.equal(loserAgain.status, 409, JSON.stringify(loserAgain.body));
        assert.equal((await getDb().select({ id: messages.id }).from(messages).where(and(eq(messages.senderId, world.agentId), eq(messages.agentSendKey, key)))).length, 1);
      } finally {
        __setAgentSendRaceHooksForTests({});
        await observer.end();
      }
    });
  });
}
