// `/events` and out-of-order commits, with two real connections (PGlite runs
// one transaction at a time, so it cannot hold one open across a pull).
// messages.seq is allocated at INSERT, but transactions commit in another
// order. An external agent's pull returns rows above its read position and the
// ack moves the read position to the highest seq handed over, so a smaller-seq
// message whose transaction committed after the pull read its rows sat below
// the read position for good. The pull now also returns such late rows
// (messages.insert_xid at or above the previous pull's snapshot horizon).
//
// CI: `probe-concurrency-real-pg`, with AGENT_EVENTS_LATE_ROWS_REAL_PG_URL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { onTestFinished } from "vitest";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { CREATE_INSERT_XID_INDEX_SQL } from "../../scripts/messages-insert-xid-index";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { fixturePasswordHash } from "../test/integration/credentials";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, getAgentLegacyReadCursor } from "../services/channelService";
import { createMessage, __setExternalAgentInboxAfterRowsReadHookForTests, __setExternalAgentInboxChainSelectorForTests } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { setReadPositionSettleMsForTests } from "../services/readPositionSettle";
import { __setAgentInboxLateCapsForTests } from "../services/agentInboxLateRows";
import { recordInboxNotificationFacts } from "../services/inboxNotificationService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const REAL_PG_URL = process.env.AGENT_EVENTS_LATE_ROWS_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.AGENT_EVENTS_LATE_ROWS_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const REAL_PG_TEST = { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 120_000 };

type TestApp = Awaited<ReturnType<typeof openTestApp>>;
type EventsBody = { events: Array<{ seq?: number; message_id?: string; content?: string }>; last_seen_seq: number | null; has_more: boolean };

async function withRealPgApp(run: (app: TestApp) => Promise<void>) {
  assert.ok(REAL_PG_URL, "AGENT_EVENTS_LATE_ROWS_REAL_PG_URL is required");
  const migrator = new pg.Pool({ connectionString: REAL_PG_URL, max: 2 });
  try {
    await migrateRealPgTestDatabase(migrator, MIGRATIONS_FOLDER);
    // As every deploy does after the migrations (db:create-messages-insert-xid-index).
    await migrator.query(CREATE_INSERT_XID_INDEX_SQL);
  } finally {
    await migrator.end();
  }
  const app = await openTestApp(REAL_PG_URL, 0, { humanActivityMuteFlagDefaultEnabled: true, skipAuthRateLimit: true });
  // CI has no RisingWave: the chain read is the test-only reference derivation.
  __setExternalAgentInboxChainSelectorForTests(async (agentId) => ({ source: "chain", rows: await referenceAgentInboxChain(agentId) }));
  const orchestrator = new AgentOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);
  try {
    await run(app);
  } finally {
    __setExternalAgentInboxChainSelectorForTests(null);
    __setExternalAgentInboxAfterRowsReadHookForTests(null);
    await app.close();
  }
}

async function seedWorld() {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `late-rows-${suffix}@slock.test`,
    name: `late-rows-${suffix}`,
    displayName: "Late Rows Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Late Rows", `late-rows-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `LateRows${suffix}`, { runtime: "external", model: "external" });
  const channel = await createChannel(server.id, `late-rows-${suffix}`);
  await addHuman(channel.id, owner!.id);
  await addAgent(channel.id, agent.id);
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "late-rows", issuedVia: "computer", createdByUserId: null });
  return { ownerId: owner!.id, serverId: server.id, agentId: agent.id, channelId: channel.id, channelName: channel.name, apiKey };
}

type World = Awaited<ReturnType<typeof seedWorld>>;

/** The agent's inbox fact for a committed message, as the send path records it. */
async function recordFact(world: World, message: { id: string; seq: number; createdAt: Date }) {
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: world.agentId,
    serverId: world.serverId,
    kind: "channel",
    sourceChannelId: world.channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: message.createdAt,
    personalMention: false,
    unreadEligible: true,
  }]);
}

async function send(world: World, content: string) {
  const message = await createMessage(world.channelId, "user", world.ownerId, content);
  await recordFact(world, message);
  return message;
}

/** Messages written by a transaction that stays open: their seqs are taken now, they become visible at commit. */
async function openWriter(world: World, content: string, count = 1) {
  const client = new pg.Client({ connectionString: REAL_PG_URL, application_name: "late-rows-writer" });
  await client.connect();
  await client.query("BEGIN");
  const written: Array<{ id: string; seq: number; createdAt: Date }> = [];
  for (let i = 0; i < count; i += 1) {
    const id = randomUUID();
    const inserted = await client.query<{ seq: string; created_at: Date }>(
      `INSERT INTO messages (id, channel_id, sender_type, sender_id, content) VALUES ($1, $2, 'user', $3, $4) RETURNING seq::text AS seq, created_at`,
      [id, world.channelId, world.ownerId, count === 1 ? content : `${content} ${i}`],
    );
    written.push({ id, seq: Number(inserted.rows[0]!.seq), createdAt: inserted.rows[0]!.created_at });
  }
  const message = written[0]!;
  let committed = false;
  return {
    message,
    written,
    commit: async () => {
      if (committed) return;
      committed = true;
      await client.query("COMMIT");
      await client.end();
      for (const row of written) await recordFact(world, row);
    },
    close: async () => {
      if (committed) return;
      committed = true;
      await client.query("ROLLBACK").catch(() => {});
      await client.end().catch(() => {});
    },
  };
}

async function events(app: TestApp, world: World, query = ""): Promise<EventsBody> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/events${query}`, {
    headers: { Authorization: `Bearer ${world.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(res.status, 200);
  return await res.json() as EventsBody;
}

const seqs = (body: EventsBody) => body.events.map((event) => event.seq);

test("real PG: a message committed after a later-seq one was handed over and acked still reaches the agent, once", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app) => {
    const world = await seedWorld();
    const m0 = await send(world, "m0");
    assert.deepEqual(seqs(await events(app, world)), [m0.seq]);

    // A takes the smaller seq and stays open; B takes a larger one and commits.
    const writerA = await openWriter(world, "A (commits late)");
    try {
      const b = await send(world, "B");
      assert.ok(writerA.message.seq < b.seq, "A holds the smaller seq");

      const round1 = await events(app, world);
      assert.deepEqual(seqs(round1), [b.seq], "B is visible; A is in flight");
      assert.equal(await getAgentLegacyReadCursor(world.agentId, world.channelId), b.seq, "the ack moved the read position past A");

      await writerA.commit();
      const round2 = await events(app, world);
      assert.deepEqual(seqs(round2), [writerA.message.seq], "A, below the read position, is handed over late");
      assert.equal(round2.events[0]!.message_id, writerA.message.id);
      assert.equal(round2.events[0]!.content, "A (commits late)");

      assert.deepEqual(seqs(await events(app, world)), [], "and only once");
      const c = await send(world, "C");
      assert.deepEqual(seqs(await events(app, world)), [c.seq], "later rows are not repeated either");
    } finally {
      await writerA.close();
    }
  });
});

test("real PG: the horizon is taken before the pull reads its rows (A commits after the read, before the ack)", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app) => {
    const world = await seedWorld();
    const m0 = await send(world, "m0");
    assert.deepEqual(seqs(await events(app, world)), [m0.seq]);

    const writerA = await openWriter(world, "A (commits mid-pull)");
    try {
      const b = await send(world, "B");
      // Commit A right after the pull read its rows, before the route
      // acknowledges B. A horizon read at any point after the rows would
      // already be past A's transaction.
      let hooked = false;
      __setExternalAgentInboxAfterRowsReadHookForTests(async () => {
        if (hooked) return;
        hooked = true;
        await writerA.commit();
      });
      const round1 = await events(app, world);
      __setExternalAgentInboxAfterRowsReadHookForTests(null);
      assert.ok(hooked, "the pull read its rows");
      assert.deepEqual(seqs(round1), [b.seq], "the pull read its rows while A was in flight");
      assert.equal(await getAgentLegacyReadCursor(world.agentId, world.channelId), b.seq);

      assert.deepEqual(seqs(await events(app, world)), [writerA.message.seq], "A is handed over late");
      assert.deepEqual(seqs(await events(app, world)), [], "and only once");
    } finally {
      await writerA.close();
    }
  });
});

test("real PG: in cursor mode a late row rides the next batch and is acknowledged by the next since", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app) => {
    const world = await seedWorld();
    const m0 = await send(world, "m0");
    const start = await events(app, world, "?ack=cursor&since=latest");
    assert.deepEqual(seqs(start), [m0.seq]);

    const writerA = await openWriter(world, "A (commits late)");
    try {
      const b = await send(world, "B");
      const round1 = await events(app, world, `?ack=cursor&since=${start.last_seen_seq}`);
      assert.deepEqual(seqs(round1), [b.seq]);

      await writerA.commit();
      // Acknowledges B (read position past A), then pulls.
      const round2 = await events(app, world, `?ack=cursor&since=${round1.last_seen_seq}`);
      assert.deepEqual(seqs(round2), [writerA.message.seq], "A comes with the next batch");

      // The response was lost: the client repeats its since and gets A again.
      const retry = await events(app, world, `?ack=cursor&since=${round1.last_seen_seq}`);
      assert.deepEqual(seqs(retry), [writerA.message.seq], "an unacknowledged late row is handed over again");

      const round3 = await events(app, world, `?ack=cursor&since=${retry.last_seen_seq}`);
      assert.deepEqual(seqs(round3), [], "acknowledged: not again");
    } finally {
      await writerA.close();
    }
  });
});

test("real PG: more late rows than one pull carries (150 > 100) all arrive over several pulls, each once", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app) => {
    const world = await seedWorld();
    const m0 = await send(world, "m0");
    assert.deepEqual(seqs(await events(app, world)), [m0.seq]);

    // One transaction writes 150 messages (one insert_xid) and stays open.
    const writer = await openWriter(world, "late", 150);
    try {
      const b = await send(world, "B");
      assert.deepEqual(seqs(await events(app, world)), [b.seq]);
      await writer.commit();

      // At most 100 late rows per pull, and /events hands over 50 by default:
      // the scan position must not pass a late row that was not handed over.
      const received: number[] = [];
      let rounds = 0;
      for (;;) {
        const body = await events(app, world);
        rounds += 1;
        received.push(...seqs(body).map(Number));
        if (body.events.length === 0) {
          assert.equal(body.has_more, false);
          break;
        }
        assert.ok(rounds <= 6, `drained within a few pulls (round ${rounds})`);
      }
      const expected = writer.written.map((row) => row.seq).sort((x, y) => x - y);
      assert.deepEqual([...received].sort((x, y) => x - y), expected, "every late row, none twice");
      assert.ok(rounds >= 4, "it took several pulls (150 rows at 50 per response)");
    } finally {
      await writer.close();
    }
  });
});

test("real PG: a late-only batch moves the cursor to since+1; a row holding seq since+1 still in flight arrives after it commits", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app) => {
    const world = await seedWorld();
    const m0 = await send(world, "m0");
    const start = await events(app, world, "?ack=cursor&since=latest");
    assert.deepEqual(seqs(start), [m0.seq]);

    const writerA = await openWriter(world, "A (commits late)");
    const b = await send(world, "B");
    const writerC = await openWriter(world, "C (holds since+1)");
    try {
      assert.equal(writerC.message.seq, b.seq + 1, "C holds the seq right after B");
      const round1 = await events(app, world, `?ack=cursor&since=${start.last_seen_seq}`);
      assert.deepEqual(seqs(round1), [b.seq]);
      assert.equal(round1.last_seen_seq, b.seq);

      await writerA.commit();
      const round2 = await events(app, world, `?ack=cursor&since=${round1.last_seen_seq}`);
      assert.deepEqual(seqs(round2), [writerA.message.seq], "a batch of late rows only");
      assert.equal(round2.last_seen_seq, b.seq + 1, "the cursor still moves: since+1, C's seq");

      const round3 = await events(app, world, `?ack=cursor&since=${round2.last_seen_seq}`);
      assert.deepEqual(seqs(round3), [], "A acknowledged; C still in flight");

      await writerC.commit();
      const round4 = await events(app, world, `?ack=cursor&since=${round3.last_seen_seq}`);
      assert.deepEqual(seqs(round4), [writerC.message.seq], "acknowledging since+1 did not pass C");
      const round5 = await events(app, world, `?ack=cursor&since=${round4.last_seen_seq}`);
      assert.deepEqual(seqs(round5), []);
    } finally {
      await writerA.close();
      await writerC.close();
    }
  });
});

test("real PG: rows the agent read through history (which moves the read position) are not handed over again as late", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app) => {
    const world = await seedWorld();
    const m0 = await send(world, "m0");
    assert.deepEqual(seqs(await events(app, world)), [m0.seq]);

    const b = await send(world, "B (read through history)");
    const restoreSettle = setReadPositionSettleMsForTests(0);
    onTestFinished(restoreSettle);
    const res = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(`#${world.channelName}`)}&limit=50&unread=true`, {
      headers: { Authorization: `Bearer ${world.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(res.status, 200);
    assert.ok(await getAgentLegacyReadCursor(world.agentId, world.channelId) >= b.seq, "the history read moved the read position past B");

    assert.deepEqual(seqs(await events(app, world)), [], "B is not late: the agent read it");
    assert.deepEqual(seqs(await events(app, world)), []);
  });
});

test("real PG: while a long transaction holds the snapshot xmin back, rows delivered normally are never handed over again, past the skip-record cap too", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app) => {
    // Records cannot be deleted while the transaction runs; a small cap so this run passes it.
    __setAgentInboxLateCapsForTests({ records: 8 });
    onTestFinished(() => __setAgentInboxLateCapsForTests({ records: null }));
    const world = await seedWorld();
    const m0 = await send(world, "m0");
    assert.deepEqual(seqs(await events(app, world)), [m0.seq]);

    // An unrelated write transaction stays open: every later snapshot's xmin is held at it.
    const holder = new pg.Client({ connectionString: REAL_PG_URL, application_name: "late-rows-xmin-holder" });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_current_xact_id()");
    try {
      const received: number[] = [];
      const sent: number[] = [];
      for (let batch = 0; batch < 3; batch += 1) {
        const inserted = await getDb().execute<{ id: string; seq: string; created_at: Date }>(sql`
          INSERT INTO messages (id, channel_id, sender_type, sender_id, content)
          SELECT gen_random_uuid(), ${world.channelId}, 'user', ${world.ownerId}, 'bulk ' || ${batch} || '-' || i
          FROM generate_series(1, 40) i
          RETURNING id, seq::text AS seq, created_at
        `);
        const rows = inserted.rows.map((row) => ({ id: row.id, seq: Number(row.seq), createdAt: new Date(row.created_at) }));
        await recordInboxNotificationFacts(rows.map((message) => ({
          receiverType: "agent" as const,
          receiverId: world.agentId,
          serverId: world.serverId,
          kind: "channel" as const,
          sourceChannelId: world.channelId,
          messageId: message.id,
          messageSeq: message.seq,
          activityAt: message.createdAt,
          personalMention: false,
          unreadEligible: true,
        })));
        sent.push(...rows.map((row) => row.seq));
        for (;;) {
          const body = await events(app, world, "?limit=200");
          received.push(...seqs(body).map(Number));
          if (body.events.length === 0) break;
        }
      }
      for (let round = 0; round < 3; round += 1) {
        assert.deepEqual(seqs(await events(app, world, "?limit=200")), [], `round ${round}: nothing handed over again`);
      }
      assert.equal(received.length, sent.length, "each row once");
      const [records] = (await getDb().execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM agent_inbox_skip_records WHERE agent_id = ${world.agentId}`)).rows;
      assert.ok(Number(records!.count) <= 8, "the cap held while nothing could be deleted");
      assert.deepEqual([...received].sort((a, b) => a - b), [...sent].sort((a, b) => a - b));
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end().catch(() => {});
    }
  });
});

/**
 * Rewrites the agent's skip records as Postgres records them when the open
 * writer's xid is at or above the snapshot's xmax (xmax is latestCompletedXid + 1,
 * so a transaction already running may hold an id at or above it and not be in
 * xip), and moves them past the grace.
 */
async function recordSnapshotAtXid(world: World, xid: string, recordedXid: "keep" | "null") {
  await getDb().execute(sql`
    UPDATE agent_inbox_skip_records
    SET snapshot = ${`${xid}:${xid}:`},
        created_at = now() - interval '2 minutes'
        ${recordedXid === "null" ? sql`, recorded_xid = NULL` : sql``}
    WHERE agent_id = ${world.agentId}
  `);
}

for (const variant of [
  { name: "with the acknowledgement's xid recorded", recordedXid: "keep" as const },
  { name: "a record from before recorded_xid (NULL), within its hour", recordedXid: "null" as const },
]) {
  test(`real PG: a long writer whose xid is at or above the record's xmax, still open after the lower ones finish, is still handed over (${variant.name})`, REAL_PG_TEST, async () => {
    await withRealPgApp(async (app) => {
      const world = await seedWorld();
      const m0 = await send(world, "m0");
      assert.deepEqual(seqs(await events(app, world)), [m0.seq]);

      const writerA = await openWriter(world, "A (long writer)");
      try {
        const xidA = String((await getDb().execute(sql`
          SELECT backend_xid::text AS xid FROM pg_stat_activity WHERE application_name = 'late-rows-writer' AND backend_xid IS NOT NULL
        `)).rows[0]?.xid ?? "");
        assert.match(xidA, /^\d+$/, "the open writer holds an xid");
        const b = await send(world, "B");
        assert.deepEqual(seqs(await events(app, world)), [b.seq], "B handed over, the read position moves past A");

        // As if no transaction above A had finished when the pull's snapshot
        // was taken: A's xid equals the snapshot's xmax and is not in xip.
        await recordSnapshotAtXid(world, xidA, variant.recordedXid);
        // Every lower xid has finished; A is the oldest open transaction, so
        // the current xmin is A's xid: the old condition (xmin >= xmax) deleted
        // the record here.
        assert.deepEqual(seqs(await events(app, world)), [], "A is still open");
        const [{ count }] = (await getDb().execute(sql`
          SELECT count(*)::int AS count FROM agent_inbox_skip_records WHERE agent_id = ${world.agentId}
        `)).rows as Array<{ count: number }>;
        assert.ok(count > 0, "the record covering A is kept while A is open");

        await writerA.commit();
        assert.deepEqual(seqs(await events(app, world)), [writerA.message.seq], "A arrives once it commits");
      } finally {
        await writerA.close();
      }
    });
  });
}
