import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import pg from "pg";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { openTestApp } from "../test/integration/app.js";
import { getDb, getPool } from "../db/index.js";
import { servers, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const DATABASE_URL = process.env.INBOX_PRESSURE_REAL_PG_URL;
const REQUIRED = process.env.INBOX_PRESSURE_REAL_PG_REQUIRED === "1";
const EXPECTATION = process.env.INBOX_PRESSURE_EXPECT;
const APPLY_FIXED_INDEX = process.env.INBOX_PRESSURE_APPLY_FIXED_INDEX === "1";
const CONCURRENCY = 24;
const REQUEST_COUNT = 48;
const NORMAL_CONCURRENCY = 2;
const NORMAL_REQUEST_COUNT = 8;

type RequestResult = {
  status: number;
  durationMs: number;
  retryAfter: string | null;
  code: string | null;
};

type ExplainNode = Record<string, unknown> & { Plans?: ExplainNode[] };

function flattenPlan(node: ExplainNode): ExplainNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

function percentile(values: number[], quantile: number): number {
  assert.ok(values.length > 0);
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)];
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function runInboxRequests(args: {
  baseUrl: string;
  token: string;
  serverId: string;
  concurrency: number;
  requestCount: number;
}): Promise<{ durationMs: number; results: RequestResult[] }> {
  const startedAt = performance.now();
  const results: RequestResult[] = [];
  let nextRequest = 0;
  await Promise.all(Array.from({ length: args.concurrency }, async () => {
    while (nextRequest < args.requestCount) {
      const requestNumber = nextRequest;
      nextRequest += 1;
      if (requestNumber >= args.requestCount) return;
      const requestStartedAt = performance.now();
      const response = await fetch(`${args.baseUrl}/api/channels/inbox?limit=30`, {
        headers: {
          Authorization: `Bearer ${args.token}`,
          "X-Server-Id": args.serverId,
        },
      });
      const body = await response.text();
      let code: string | null = null;
      if (response.status === 429) {
        const parsed = JSON.parse(body) as { code?: unknown };
        code = typeof parsed.code === "string" ? parsed.code : null;
      }
      results.push({
        status: response.status,
        durationMs: performance.now() - requestStartedAt,
        retryAfter: response.headers.get("retry-after"),
        code,
      });
    }
  }));
  return { durationMs: performance.now() - startedAt, results };
}

function statusBuckets(results: readonly RequestResult[]): Record<string, number> {
  const buckets = new Map<number, number>();
  for (const result of results) {
    buckets.set(result.status, (buckets.get(result.status) ?? 0) + 1);
  }
  return Object.fromEntries([...buckets.entries()].sort(([a], [b]) => a - b));
}

function latencyReceipt(results: readonly RequestResult[]) {
  assert.ok(results.length > 0);
  return {
    p95Ms: Math.round(percentile(results.map((result) => result.durationMs), 0.95)),
    p99Ms: Math.round(percentile(results.map((result) => result.durationMs), 0.99)),
  };
}

async function seedProductionShapedInbox(userId: string, serverId: string, fixtureId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO channels (id, server_id, name, type)
       SELECT md5($2 || '-channel-' || i::text)::uuid, $1::uuid,
              'pressure-' || i::text, 'channel'
       FROM generate_series(1, 1889) AS i`,
      [serverId, fixtureId],
    );
    await client.query(
      `INSERT INTO channel_humans (channel_id, user_id)
       SELECT md5($2 || '-channel-' || i::text)::uuid, $1::uuid
       FROM generate_series(1, 1889) AS i`,
      [userId, fixtureId],
    );
    await client.query(
      `INSERT INTO messages (
         id, seq, channel_id, sender_type, sender_id, message_type, content,
         created_at, updated_at
       )
       SELECT md5($2 || '-message-' || i::text)::uuid,
              1000000000 + i,
              md5($2 || '-channel-' || (((i - 1) % 1889) + 1)::text)::uuid,
              'user', $1::text, 'chat', 'pressure message ' || i::text,
              now() - ((7357 - i) * interval '1 millisecond'),
              now() - ((7357 - i) * interval '1 millisecond')
       FROM generate_series(1, 7357) AS i`,
      [userId, fixtureId],
    );
    await client.query(
      `INSERT INTO message_mentions (
         id, message_id, message_seq, server_id, channel_id, target_type,
         target_id, handle_at_send_time, source, confidence,
         notifiable_at_send, created_at
       )
       SELECT md5($3 || '-mention-' || i::text)::uuid,
              md5($3 || '-message-' || i::text)::uuid,
              1000000000 + i,
              $2::uuid,
              md5($3 || '-channel-' || (((i - 1) % 1889) + 1)::text)::uuid,
              'user', $1::uuid, 'pressure-user', 'send_path', 'exact', true,
              now() - ((7357 - i) * interval '1 millisecond')
       FROM generate_series(1, 7357) AS i`,
      [userId, serverId, fixtureId],
    );
    await client.query(
      `INSERT INTO inbox_serving_rows (
         receiver_type, receiver_id, server_id, kind, source_channel_id,
         latest_notified_message_id, latest_notified_seq, latest_notified_at,
         last_activity_at, first_unread_message_id, first_unread_seq,
         unread_count, latest_personal_mention_message_id,
         latest_personal_mention_seq, unread_mention_count, has_any_mention
       )
       SELECT 'user', $1::uuid, $2::uuid, 'channel',
              md5($3 || '-channel-' || i::text)::uuid,
              md5($3 || '-message-' || i::text)::uuid,
              1000000000 + i, now(), now(),
              md5($3 || '-message-' || i::text)::uuid,
              1000000000 + i, 1,
              md5($3 || '-message-' || i::text)::uuid,
              1000000000 + i, 1, true
       FROM generate_series(1, 1889) AS i`,
      [userId, serverId, fixtureId],
    );
    if (APPLY_FIXED_INDEX) {
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_inbox_serving_rows_receiver_server_last_activity
          ON inbox_serving_rows
            (receiver_type, receiver_id, server_id, last_activity_at)
      `);
    }
    await client.query("COMMIT");
    await client.query("ANALYZE channels");
    await client.query("ANALYZE messages");
    await client.query("ANALYZE message_mentions");
    await client.query("ANALYZE inbox_serving_rows");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function explainReceiverPageKey(userId: string, serverId: string) {
  const result = await getPool().query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT source_channel_id, last_activity_at
     FROM inbox_serving_rows
     WHERE receiver_type = 'user'
       AND receiver_id = $1::uuid
       AND server_id = $2::uuid
     ORDER BY last_activity_at DESC
     LIMIT 30`,
    [userId, serverId],
  );
  const report = result.rows[0]["QUERY PLAN"][0] as { Plan: ExplainNode; "Execution Time": number };
  const nodes = flattenPlan(report.Plan);
  return {
    executionMs: report["Execution Time"],
    nodeTypes: nodes.map((node) => String(node["Node Type"])),
    indexNames: nodes.flatMap((node) => typeof node["Index Name"] === "string" ? [node["Index Name"]] : []),
    actualRows: nodes.flatMap((node) => typeof node["Actual Rows"] === "number" ? [node["Actual Rows"]] : []),
    sharedReadBlocks: nodes.reduce((sum, node) => sum + (typeof node["Shared Read Blocks"] === "number" ? node["Shared Read Blocks"] : 0), 0),
    tempWrittenBlocks: nodes.reduce((sum, node) => sum + (typeof node["Temp Written Blocks"] === "number" ? node["Temp Written Blocks"] : 0), 0),
  };
}

test(
  "production-shaped concurrent inbox pressure distinguishes timeout RED from bounded backpressure green",
  {
    skip: !(DATABASE_URL || REQUIRED),
    timeout: 120_000,
  },
  async () => {
    assert.ok(DATABASE_URL, "INBOX_PRESSURE_REAL_PG_URL is required");
    assert.ok(EXPECTATION === "red" || EXPECTATION === "green", "INBOX_PRESSURE_EXPECT must be red or green");
    const app = await openTestApp(DATABASE_URL, 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, skipAuthRateLimit: true });
    const monitor = new pg.Client({ connectionString: DATABASE_URL });
    await monitor.connect();
    let poll = true;
    const phaseState: { active: "idle" | "normal" | "overload" } = { active: "idle" };
    const peakActiveBackends = { normal: 0, overload: 0 };
    const monitorLoop = (async () => {
      while (poll) {
        const result = await monitor.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND state = 'active'
             AND query NOT LIKE '%pg_stat_activity%'`,
        );
        const activeCount = result.rows[0]?.count ?? 0;
        if (phaseState.active === "normal") {
          peakActiveBackends.normal = Math.max(peakActiveBackends.normal, activeCount);
        } else if (phaseState.active === "overload") {
          peakActiveBackends.overload = Math.max(peakActiveBackends.overload, activeCount);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    try {
      const sink = new MemoryTraceSink();
      app.app.set("serverTracer", new BasicTracer({ sink }));
      const db = getDb();
      const fixtureId = randomUUID();
      const email = `inbox-pressure-${fixtureId}@slock.test`;
      const [user] = await db.insert(users).values({
        email,
        name: `inbox-pressure-${fixtureId}`,
        displayName: "Inbox Pressure User",
        passwordHash: await fixturePasswordHash("password123"),
        emailVerified: true,
        profileSetupCompletedAt: new Date(),
      }).returning();
      const server = await createServer("Inbox Pressure", `inbox-pressure-${randomUUID()}`, user.id);
      await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
      await seedProductionShapedInbox(user.id, server.id, fixtureId);
      const pageKeyPlan = await explainReceiverPageKey(user.id, server.id);
      const token = await login(app.baseUrl, email);
      sink.clear();

      let normalReceipt: null | {
        concurrency: number;
        requestCount: number;
        durationMs: number;
        peakActiveBackends: number;
        errorBuckets: Record<string, number>;
        all200Latency: ReturnType<typeof latencyReceipt>;
      } = null;
      if (EXPECTATION === "green") {
        phaseState.active = "normal";
        const normal = await runInboxRequests({
          baseUrl: app.baseUrl,
          token,
          serverId: server.id,
          concurrency: NORMAL_CONCURRENCY,
          requestCount: NORMAL_REQUEST_COUNT,
        });
        phaseState.active = "idle";
        normalReceipt = {
          concurrency: NORMAL_CONCURRENCY,
          requestCount: NORMAL_REQUEST_COUNT,
          durationMs: Math.round(normal.durationMs),
          peakActiveBackends: peakActiveBackends.normal,
          errorBuckets: statusBuckets(normal.results),
          all200Latency: latencyReceipt(normal.results),
        };
        assert.equal(normal.results.length, NORMAL_REQUEST_COUNT);
        assert.equal(normal.results.every((result) => result.status === 200), true, "normal work point must be all 200");
        assert.ok(normalReceipt.all200Latency.p99Ms < 3_000, `normal 200-only p99 must stay below the PostgreSQL fuse, got ${normalReceipt.all200Latency.p99Ms}`);
        sink.clear();
      }

      phaseState.active = "overload";
      const originalConsoleError = console.error;
      if (EXPECTATION === "red") {
        console.error = (first?: unknown, ...rest: unknown[]) => {
          if (first === "Failed to get inbox:") return;
          originalConsoleError(first, ...rest);
        };
      }
      let overload: Awaited<ReturnType<typeof runInboxRequests>>;
      try {
        overload = await runInboxRequests({
          baseUrl: app.baseUrl,
          token,
          serverId: server.id,
          concurrency: CONCURRENCY,
          requestCount: REQUEST_COUNT,
        });
      } finally {
        phaseState.active = "idle";
        console.error = originalConsoleError;
      }
      const results = overload.results;
      const errorBuckets = statusBuckets(results);
      const spans = sink.getAllSpans();
      const events = spans.flatMap((span) => span.events);
      const statementTimeouts = events.filter(
        (event) => event.attrs?.["pg.fallback.outcome"] === "statement_timeout"
          && event.attrs?.sqlstate === "57014",
      ).length;
      const backpressureRejects = events.filter(
        (event) => event.name === "inbox.backpressure.rejected",
      ).length;
      const completed = results.filter((result) => result.status === 200);
      const rejected = results.filter((result) => result.status === 429);
      const receipt = {
        expectation: EXPECTATION,
        normal: normalReceipt,
        overload: {
          concurrency: CONCURRENCY,
          requestCount: REQUEST_COUNT,
          durationMs: Math.round(overload.durationMs),
          peakActiveBackends: peakActiveBackends.overload,
          errorBuckets,
          allRequestLatency: latencyReceipt(results),
          completed200Latency: completed.length > 0 ? latencyReceipt(completed) : null,
          rejected429Latency: rejected.length > 0 ? latencyReceipt(rejected) : null,
          retryAfterValues: [...new Set(rejected.map((result) => result.retryAfter))].sort(),
          rejectionCodes: [...new Set(rejected.map((result) => result.code))].sort(),
        },
        concurrency: CONCURRENCY,
        requestCount: REQUEST_COUNT,
        durationMs: Math.round(overload.durationMs),
        p99Ms: Math.round(percentile(results.map((result) => result.durationMs), 0.99)),
        peakActiveBackends: peakActiveBackends.overload,
        errorBuckets,
        statementTimeouts,
        backpressureRejects,
        pageKeyPlan,
      };
      console.error(`INBOX_PRESSURE_RECEIPT ${JSON.stringify(receipt)}`);

      assert.equal(results.length, REQUEST_COUNT);
      if (EXPECTATION === "red") {
        assert.ok((errorBuckets[500] ?? 0) > 0, "pre-fix exact must produce HTTP 5xx");
        assert.ok(statementTimeouts > 0, "the RED must be caused by a real PostgreSQL statement timeout");
      } else {
        assert.equal(errorBuckets[500] ?? 0, 0, "fixed exact must eliminate statement-timeout 5xx");
        assert.equal(statementTimeouts, 0);
        assert.ok((errorBuckets[200] ?? 0) > 0, "bounded work must still complete");
        assert.ok((errorBuckets[429] ?? 0) > 0, "overload must degrade at the route boundary");
        assert.ok(backpressureRejects > 0, "the receipt must prove route backpressure triggered");
        assert.deepEqual(receipt.overload.retryAfterValues, ["1"], "every overload response must carry Retry-After: 1");
        assert.deepEqual(receipt.overload.rejectionCodes, ["INBOX_BACKPRESSURE"], "every overload response must carry the closed rejection code");
        assert.ok(peakActiveBackends.overload <= 8, `backend peak must stay bounded, got ${peakActiveBackends.overload}`);
        assert.ok(receipt.p99Ms < 4_000, `route p99 must stay below 4s, got ${receipt.p99Ms}`);
        assert.ok(
          pageKeyPlan.indexNames.includes("idx_inbox_serving_rows_receiver_server_last_activity"),
          `receiver/server/activity key producer must use the fixed index: ${pageKeyPlan.indexNames.join(",")}`,
        );
        assert.equal(pageKeyPlan.nodeTypes.includes("Sort"), false, "index order must avoid a page-key sort");
        assert.equal(pageKeyPlan.tempWrittenBlocks, 0, "page-key production must not spill");
        assert.ok(Math.max(...pageKeyPlan.actualRows) <= 30, "the index-ordered page key scan must stay page-bounded");
      }
    } finally {
      poll = false;
      await monitorLoop;
      await monitor.end();
      await app.close();
    }
  },
);
