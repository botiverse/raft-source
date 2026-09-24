import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { openTestApp } from "../test/integration/app.js";
import { getDb, getPool } from "../db/index.js";
import { users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import {
  buildMessageSearchStatement,
  buildUserVisibleChannelsSql,
} from "./searchService.js";
import {
  CREATE_SENDER_INDEX_SQL,
  SENDER_INDEX_NAME,
} from "../../scripts/messages-sender-index.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const DATABASE_URL = process.env.SEARCH_SENDER_INDEX_REAL_PG_URL;
const REQUIRED = process.env.SEARCH_SENDER_INDEX_REAL_PG_REQUIRED === "1";

const CHANNEL_COUNT = 400;
const MESSAGE_COUNT = 120_000;
const SENDER_POOL = 50;

type ExplainNode = Record<string, unknown> & { Plans?: ExplainNode[] };

function flattenPlan(node: ExplainNode): ExplainNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

function messagesScanReceipt(root: ExplainNode) {
  const nodes = flattenPlan(root);
  const messagesScans = nodes.filter(
    (node) =>
      (node["Relation Name"] === "messages" || node["Index Name"]?.toString().startsWith("idx_messages"))
      && typeof node["Actual Rows"] === "number",
  );
  return {
    indexNames: nodes.flatMap((node) =>
      typeof node["Index Name"] === "string" ? [node["Index Name"]] : [],
    ),
    // "Actual Rows" counts rows RETURNED by a node after filtering, so for the
    // unbounded-walk red case read Rows Removed by Filter instead: the walk
    // visits every row and the sender filter discards them.
    rowsVisited: messagesScans.reduce(
      (sum, node) =>
        sum
        + (typeof node["Actual Rows"] === "number" ? (node["Actual Rows"] as number) * ((node["Actual Loops"] as number) ?? 1) : 0)
        + (typeof node["Rows Removed by Filter"] === "number" ? (node["Rows Removed by Filter"] as number) * ((node["Actual Loops"] as number) ?? 1) : 0),
      0,
    ),
  };
}

async function seedSearchCorpus(serverId: string, fixtureId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO channels (id, server_id, name, type)
       SELECT md5($2 || '-channel-' || i::text)::uuid, $1::uuid,
              'search-corpus-' || i::text, 'channel'
       FROM generate_series(1, ${CHANNEL_COUNT}) AS i`,
      [serverId, fixtureId],
    );
    await client.query(
      `INSERT INTO messages (
         id, seq, channel_id, sender_type, sender_id, message_type, content,
         created_at, updated_at
       )
       SELECT md5($1 || '-message-' || i::text)::uuid,
              2000000000 + i,
              md5($1 || '-channel-' || (((i - 1) % ${CHANNEL_COUNT}) + 1)::text)::uuid,
              'user',
              md5($1 || '-sender-' || ((i % ${SENDER_POOL}) + 1)::text)::uuid::text,
              'chat',
              'filter-only corpus message ' || i::text,
              now() - ((${MESSAGE_COUNT} - i) * interval '60 millisecond'),
              now() - ((${MESSAGE_COUNT} - i) * interval '60 millisecond')
       FROM generate_series(1, ${MESSAGE_COUNT}) AS i`,
      [fixtureId],
    );
    await client.query("COMMIT");
    await client.query("ANALYZE channels");
    await client.query("ANALYZE messages");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

test(
  "filter-only sender search is sender-index-driven, not an unbounded created_at walk",
  {
    skip: !(DATABASE_URL || REQUIRED),
    timeout: 300_000,
  },
  async () => {
    assert.ok(DATABASE_URL, "SEARCH_SENDER_INDEX_REAL_PG_URL is required");
    const app = await openTestApp(DATABASE_URL, 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, skipAuthRateLimit: true });
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const db = getDb();
      const fixtureId = randomUUID();
      const [user] = await db.insert(users).values({
        email: `search-sender-index-${fixtureId}@slock.test`,
        name: `search-sender-index-${fixtureId}`,
        displayName: "Search Sender Index User",
        passwordHash: await fixturePasswordHash("password123"),
        emailVerified: true,
        profileSetupCompletedAt: new Date(),
      }).returning();
      const server = await createServer(
        "Search Sender Index",
        `search-sender-index-${randomUUID()}`,
        user.id,
      );
      await seedSearchCorpus(server.id, fixtureId);

      const senderUuid = async (label: string) => {
        const result = await client.query<{ id: string }>(
          "SELECT md5($1)::uuid::text AS id",
          [label],
        );
        return result.rows[0].id;
      };
      const absentSenderId = await senderUuid(`${fixtureId}-sender-absent`);
      const presentSenderId = await senderUuid(`${fixtureId}-sender-7`);
      const renderStatement = (senderId: string) =>
        new PgDialect().sqlToQuery(
          buildMessageSearchStatement(
            buildUserVisibleChannelsSql({ serverId: server.id, userId: user.id }),
            {
              serverId: server.id,
              senderId,
              sort: "relevance",
              limit: 20,
              offset: 0,
            },
            null,
          ),
        );

      const explainStatement = async (senderId: string): Promise<ExplainNode> => {
        const rendered = renderStatement(senderId);
        const result = await client.query(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${rendered.sql}`,
          rendered.params as unknown[],
        );
        return (result.rows[0]["QUERY PLAN"] as Array<{ Plan: ExplainNode }>)[0].Plan;
      };
      const runStatement = async (senderId: string) => {
        const rendered = renderStatement(senderId);
        const result = await client.query(rendered.sql, rendered.params as unknown[]);
        return result.rows as Array<{ id: string }>;
      };

      // RED shape: 0248 deliberately does not build the index in drizzle
      // migrate, so a freshly migrated database reproduces production before
      // the post-migration lifecycle step. Drop defensively so the red half
      // stays red even if the harness database is reused.
      await client.query(`DROP INDEX IF EXISTS "${SENDER_INDEX_NAME}"`);
      await client.query("ANALYZE messages");

      const beforeRows = await runStatement(presentSenderId);
      const beforePlan = await explainStatement(absentSenderId);
      const beforeReceipt = messagesScanReceipt(beforePlan);
      assert.ok(
        !beforeReceipt.indexNames.includes(SENDER_INDEX_NAME),
        `red half must run without ${SENDER_INDEX_NAME}`,
      );
      assert.ok(
        beforeReceipt.rowsVisited >= MESSAGE_COUNT * 0.9,
        `without the sender index, an absent sender forces an unbounded walk; `
        + `visited ${beforeReceipt.rowsVisited} of ${MESSAGE_COUNT} seeded messages`,
      );

      // GREEN: build the index exactly as the post-migration lifecycle step does.
      await client.query(CREATE_SENDER_INDEX_SQL);
      await client.query("ANALYZE messages");

      const afterPlan = await explainStatement(absentSenderId);
      const afterReceipt = messagesScanReceipt(afterPlan);
      assert.ok(
        afterReceipt.indexNames.includes(SENDER_INDEX_NAME),
        `sender-filter search must be driven by ${SENDER_INDEX_NAME}; `
        + `saw ${JSON.stringify(afterReceipt.indexNames)}`,
      );
      assert.ok(
        afterReceipt.rowsVisited <= 100,
        `with the sender index, an absent sender must terminate after a bounded probe; `
        + `visited ${afterReceipt.rowsVisited} rows`,
      );

      const presentPlan = await explainStatement(presentSenderId);
      const presentReceipt = messagesScanReceipt(presentPlan);
      assert.ok(
        presentReceipt.indexNames.includes(SENDER_INDEX_NAME),
        `present-sender search must also be sender-index-driven; `
        + `saw ${JSON.stringify(presentReceipt.indexNames)}`,
      );

      // The index changes the plan, never the results.
      const afterRows = await runStatement(presentSenderId);
      assert.deepEqual(
        afterRows.map((row) => row.id),
        beforeRows.map((row) => row.id),
      );
      assert.equal(afterRows.length, 21, "limit+1 page fill for a busy sender");
    } finally {
      await client.end();
      await app.close();
    }
  },
);
