import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "vitest";
import pg from "pg";

const REAL_PG_URL_ENV = "INBOX_SERVING_MENTION_SCOPE_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.INBOX_SERVING_MENTION_SCOPE_REAL_PG_REQUIRED === "1";

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

type ExplainNode = Record<string, unknown> & { Plans?: ExplainNode[] };

function walkPlan(node: ExplainNode, visit: (node: ExplainNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walkPlan(child, visit);
}

function planActualRows(
  root: ExplainNode,
  matches: (node: ExplainNode) => boolean,
): number[] {
  const rows: number[] = [];
  walkPlan(root, (node) => {
    if (matches(node) && typeof node["Actual Rows"] === "number") {
      const loops = typeof node["Actual Loops"] === "number" ? node["Actual Loops"] : 1;
      rows.push(node["Actual Rows"] * loops);
    }
  });
  return rows;
}

function planMetric(
  root: ExplainNode,
  metric: string,
  matches: (node: ExplainNode) => boolean,
): number[] {
  const values: number[] = [];
  walkPlan(root, (node) => {
    if (!matches(node) || typeof node[metric] !== "number") return;
    const loops = typeof node["Actual Loops"] === "number" ? node["Actual Loops"] : 1;
    values.push((node[metric] as number) * loops);
  });
  return values;
}

function sumPlanMetric(root: ExplainNode, metric: string): number {
  let total = 0;
  walkPlan(root, (node) => {
    const value = node[metric];
    if (typeof value === "number") total += value;
  });
  return total;
}

test(
  "server-scoped target prefix excludes 200k cross-server mentions and reports current-server filtering honestly",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_inbox_scope_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL });
    let client: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      client = new pg.Client({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName) });
      await client.connect();
      await client.query(`
        CREATE TABLE message_mentions (
          id bigserial PRIMARY KEY,
          target_type text NOT NULL,
          target_id uuid NOT NULL,
          server_id uuid NOT NULL,
          channel_id uuid NOT NULL,
          message_seq bigint NOT NULL,
          notifiable_at_send boolean NOT NULL,
          notified_at timestamptz
        );
        CREATE INDEX idx_message_mentions_target
          ON message_mentions (target_type, target_id, server_id, id DESC);
        CREATE INDEX idx_message_mentions_inbox
          ON message_mentions (target_type, target_id, channel_id, message_seq);
      `);

      const targetId = "10000000-0000-4000-8000-000000000001";
      const currentServerId = "20000000-0000-4000-8000-000000000001";
      const otherServerId = "20000000-0000-4000-8000-000000000002";
      await client.query(`
        INSERT INTO message_mentions (
          target_type, target_id, server_id, channel_id, message_seq,
          notifiable_at_send, notified_at
        )
        SELECT
          'user', $1::uuid, $2::uuid,
          md5('relevant-channel-' || i::text)::uuid,
          i, true, NULL
        FROM generate_series(1, 1889) AS i
      `, [targetId, currentServerId]);
      await client.query(`
        INSERT INTO message_mentions (
          target_type, target_id, server_id, channel_id, message_seq,
          notifiable_at_send, notified_at
        )
        SELECT
          'user', $1::uuid, $2::uuid,
          md5('other-channel-' || ((i - 1) % 256 + 1)::text)::uuid,
          1000000 + i, true, NULL
        FROM generate_series(1, 200000) AS i
      `, [targetId, otherServerId]);
      await client.query(`
        INSERT INTO message_mentions (
          target_type, target_id, server_id, channel_id, message_seq,
          notifiable_at_send, notified_at
        )
        SELECT
          'user', $1::uuid, $2::uuid,
          md5('quiet-channel-' || ((i - 1) % 32 + 1)::text)::uuid,
          2000000 + i, false, NULL
        FROM generate_series(1, 10000) AS i
      `, [targetId, currentServerId]);
      await client.query("ANALYZE message_mentions");
      await client.query("SET work_mem = '1MB'");
      await client.query("SET statement_timeout = '3000ms'");

      const scopedSql = `
        WITH server_target_mentions AS MATERIALIZED (
          SELECT channel_id, message_seq
          FROM message_mentions
          WHERE target_type = 'user'
            AND target_id = $1::uuid
            AND server_id = $2::uuid
            AND (notifiable_at_send OR notified_at IS NOT NULL)
        ),
        channel_mentions AS (
          SELECT channel_id, max(message_seq) AS latest_mention_seq
          FROM server_target_mentions
          GROUP BY channel_id
        ),
        thread_mentions AS (
          SELECT channel_id, max(message_seq) AS latest_mention_seq
          FROM server_target_mentions
          GROUP BY channel_id
        )
        SELECT
          (SELECT count(*)::int FROM channel_mentions) AS channel_count,
          (SELECT count(*)::int FROM thread_mentions) AS thread_count
      `;
      const scopedExplain = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${scopedSql}`,
        [targetId, currentServerId],
      );
      const scopedReport = scopedExplain.rows[0]["QUERY PLAN"][0] as {
        Plan: ExplainNode;
        "Execution Time": number;
      };
      const relationMatches = (node: ExplainNode) => node["Relation Name"] === "message_mentions";
      const indexMatches = (node: ExplainNode) => node["Index Name"] === "idx_message_mentions_target";
      const outputRows = planActualRows(scopedReport.Plan, relationMatches);
      const removedRows = planMetric(scopedReport.Plan, "Rows Removed by Filter", relationMatches);
      const indexPrefixRows = planActualRows(scopedReport.Plan, indexMatches);
      assert.ok(outputRows.length > 0, "the scoped plan must execute a real message_mentions scan");
      assert.ok(indexPrefixRows.length > 0, "the scoped plan must use the production target/server index prefix");
      assert.ok(removedRows.length > 0, "the scoped plan must report current-server rows removed by filtering");
      assert.equal(
        Math.max(...indexPrefixRows),
        11889,
        "the production target/server index prefix must read only this server's 1,889 live + 10,000 quiet rows",
      );
      assert.equal(
        Math.max(...removedRows),
        10000,
        "the plan must report all current-server quiet rows removed by the notifiable filter",
      );
      assert.equal(
        Math.max(...outputRows),
        1889,
        "the shared materialization must receive the 1,889 current-server notifiable rows",
      );
      assert.equal(indexPrefixRows.length, 1, "all mention consumers must share one physical target/server prefix scan");
      assert.equal(sumPlanMetric(scopedReport.Plan, "Temp Written Blocks"), 0);
      assert.ok(scopedReport["Execution Time"] < 3000);

      const unscopedCount = await client.query(
        `SELECT count(*)::int AS count
         FROM message_mentions
         WHERE target_type = 'user'
           AND target_id = $1::uuid
           AND (notifiable_at_send OR notified_at IS NOT NULL)`,
        [targetId],
      );
      assert.equal(
        unscopedCount.rows[0].count,
        201889,
        "removing the server tooth must visibly re-admit the 200k irrelevant rows",
      );

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const startedAt = performance.now();
        const result: pg.QueryResult<{ channel_count: number; thread_count: number }> =
          await client.query(scopedSql, [targetId, currentServerId]);
        assert.equal(result.rows[0]?.channel_count, 1889);
        assert.equal(result.rows[0]?.thread_count, 1889);
        assert.ok(performance.now() - startedAt < 3000);
      }
    } finally {
      if (client) await client.end();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    }
  },
);
