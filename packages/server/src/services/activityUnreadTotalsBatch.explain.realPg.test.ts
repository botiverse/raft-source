/**
 * task #235 DoD 9b: set-based plan proof for `getActivityUnreadTotalsBatch`
 * on real PostgreSQL.
 *
 * The contract requires the batch to be ONE keyed-by-server statement
 * (VALUES input joined into a single CTE chain, final GROUP BY server_id) —
 * NOT N lateral/UNION subplans that keep N-fold CPU/IO. Proof shape:
 * `EXPLAIN (ANALYZE, BUFFERS)` at N=1/5/20/50 input servers must show a plan
 * whose node structure does NOT scale with N — the serving-rows chain appears
 * exactly once regardless of batch width; only the VALUES row count grows.
 * Execution time / buffers per N are printed for the PR evidence block.
 *
 * Opt-in real-PG gate following the repo's realPg pattern: set
 * ACTIVITY_UNREAD_BATCH_REAL_PG_URL (and _REQUIRED=1 in CI so a missing URL
 * fails rather than skips).
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { closeDatabase, getDb, initDatabase, type DatabaseExecutor } from "../db/index.js";
import * as schema from "../db/schema.js";
import {
  channelHumans,
  channels,
  inboxServingRows,
  messages,
  serverMembers,
  servers,
  users,
} from "../db/schema.js";
import {
  getActivityUnreadTotalsBatch,
  getInboxItems,
} from "./channelService.js";

const REAL_PG_URL_ENV = "ACTIVITY_UNREAD_BATCH_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.ACTIVITY_UNREAD_BATCH_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

const SERVER_COUNT = 50;
const CHANNELS_PER_SERVER = 10;
const BATCH_SIZES = [1, 5, 20, 50];

function databaseUrlFor(adminUrl: string, databaseName: string, applicationName?: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  if (applicationName) parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

test(
  "batch EXPLAIN(ANALYZE,BUFFERS) at N=1/5/20/50: one set-based plan, no per-server chain repetition (DoD 9b)",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_t235_batch_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "t235-batch-admin" });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const migrationUrl = databaseUrlFor(REAL_PG_URL, databaseName, "t235-batch-migrator");
      const migrationPool = new pg.Pool({ connectionString: migrationUrl, max: 2 });
      await migrate(drizzle(migrationPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await migrationPool.end();
      await initDatabase(databaseUrlFor(REAL_PG_URL, databaseName, "t235-batch-service"));
      const db = getDb();

      const [member] = await db.insert(users).values({
        email: `t235-${randomUUID()}@test.invalid`,
        name: `T235${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        passwordHash: "x",
        emailVerified: true,
      }).returning();

      const serverIds: string[] = [];
      const now = Date.now();
      for (let s = 0; s < SERVER_COUNT; s += 1) {
        const [server] = await db.insert(servers).values({
          name: `T235 ${s}`,
          slug: `t235-batch-${s}-${randomUUID().slice(0, 8)}`,
          ownerId: member.id,
        }).returning();
        serverIds.push(server.id);
        await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "owner" });
        const channelRows = await db.insert(channels).values(
          Array.from({ length: CHANNELS_PER_SERVER }, (_, c) => ({
            serverId: server.id,
            name: `room-${c}`,
            type: "channel" as const,
          })),
        ).returning();
        await db.insert(channelHumans).values(
          channelRows.map((channel) => ({ channelId: channel.id, userId: member.id })),
        );
        // Serving rows inserted directly (with one anchor message each for
        // the NOT NULL latest_notified FK): the plan-shape gate needs
        // realistic row volume through the exact batch SQL, not the
        // notification pipeline (oracle-equality on the full pipeline is
        // owned by activityUnreadTotalsBatch.oracle.test.ts).
        const messageRows = await db.insert(messages).values(
          channelRows.map((channel, c) => ({
            channelId: channel.id,
            senderType: "user" as const,
            senderId: member.id,
            content: `seed ${s}-${c}`,
            seq: 5,
          })),
        ).returning();
        await db.insert(inboxServingRows).values(
          channelRows.map((channel, c) => ({
            receiverType: "user" as const,
            receiverId: member.id,
            serverId: server.id,
            kind: "channel" as const,
            sourceChannelId: channel.id,
            latestNotifiedMessageId: messageRows[c].id,
            latestNotifiedSeq: 5,
            latestNotifiedAt: new Date(now - (c % 3) * 60 * 60_000),
            lastActivityAt: new Date(now - (c % 3) * 60 * 60_000),
            unreadCount: (s + c) % 4,
            unreadMentionCount: 0,
            hasAnyMention: false,
            updatedAt: new Date(),
          })),
        );
      }

      const evidence: Array<{ n: number; executionMs: number; scopeExecutionMs: number; servingRowsNodes: number; planLines: number }> = [];
      let servingRowsNodeBaseline: number | null = null;
      for (const n of BATCH_SIZES) {
        const inputs = serverIds.slice(0, n).map((serverId, index) => ({
          serverId,
          // Alternate cutoffs so the row-wise cutoff predicate is in the plan.
          historyCutoff: index % 2 === 1 ? new Date(now - 2 * 60 * 60_000) : undefined,
        }));
        // EXPLAIN(ANALYZE,BUFFERS) BOTH statements: the scope pre-read and the
        // set-based totals statement. Connection occupancy: the production
        // path (no executor override) runs both statements sequentially inside
        // ONE db.transaction — a single pooled connection for the whole batch,
        // statement_timeout-capped; the oracle-spot section below exercises
        // that exact path.
        const plans: string[] = [];
        let statementIndex = 0;
        const explainProxy = {
          execute: async (query: unknown) => {
            statementIndex += 1;
            const explained = await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS) ${query as ReturnType<typeof sql>}`);
            plans.push(explained.rows.map((row) => String(row["QUERY PLAN"])).join("\n"));
            return db.execute(query as ReturnType<typeof sql>);
          },
        } as unknown as DatabaseExecutor;

        const totals = await getActivityUnreadTotalsBatch(inputs, member.id, { executor: explainProxy });
        assert.equal(statementIndex, 2,
          "the batch must be exactly TWO statements: one scope pre-read + ONE set-based totals statement");
        assert.equal(totals.size, n, "one totals row per input server");
        assert.equal(plans.length, 2);
        const scopePlan = plans[0];
        const plan = plans[1];
        const scopeExecutionMs = Number(/Execution Time: ([0-9.]+) ms/.exec(scopePlan)?.[1] ?? Number.NaN);
        assert.ok(Number.isFinite(scopeExecutionMs), "scope pre-read EXPLAIN must report execution time");

        // Set-based proof: the serving-rows chain appears a constant number of
        // times regardless of batch width. A per-server loop (N lateral/UNION
        // subplans) would repeat the scan N times and fail this equality.
        const servingRowsNodes = (plan.match(/inbox_serving_rows/g) ?? []).length;
        if (servingRowsNodeBaseline === null) {
          servingRowsNodeBaseline = servingRowsNodes;
        } else {
          assert.equal(servingRowsNodes, servingRowsNodeBaseline,
            `plan node count over inbox_serving_rows must not scale with N (N=${n})`);
        }
        const executionMs = Number(/Execution Time: ([0-9.]+) ms/.exec(plan)?.[1] ?? Number.NaN);
        assert.ok(Number.isFinite(executionMs), "EXPLAIN ANALYZE must report execution time");
        evidence.push({ n, executionMs, scopeExecutionMs, servingRowsNodes, planLines: plan.split("\n").length });
        console.log(`\n===== DoD 9b scope pre-read plan (N=${n}) =====\n${scopePlan}\n`);
        console.log(`\n===== DoD 9b totals plan (N=${n}) =====\n${plan}\n`);
      }
      console.log("DoD 9b evidence summary:", JSON.stringify(evidence, null, 2));
      console.log("DoD 9b connection occupancy: 2 sequential statements; production path holds ONE pooled connection inside a single statement_timeout-capped transaction (exercised by the oracle-spot section below).");

      // Real-PG oracle spot equality (belt to the pglite oracle suite): the
      // batch numbers must equal the per-server authority on this backend too.
      const spotInputs = serverIds.slice(0, 5).map((serverId) => ({ serverId }));
      const spotBatch = await getActivityUnreadTotalsBatch(spotInputs, member.id);
      for (const input of spotInputs) {
        const oracle = await getInboxItems(input.serverId, member.id, { filter: "all", limit: 1, offset: 0 });
        assert.deepEqual(spotBatch.get(input.serverId), {
          totalUnreadCount: oracle.totalUnreadCount,
          activeUnreadCount: oracle.activeUnreadCount,
        }, `real-PG batch totals must equal oracle (server ${input.serverId})`);
      }
    } finally {
      await closeDatabase().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  },
);
