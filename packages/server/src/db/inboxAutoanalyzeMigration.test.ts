import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const migrationPath = new URL(
  "../../drizzle/0181_inbox_autoanalyze_guard.sql",
  import.meta.url,
);

const expectedOptions = {
  channel_humans: {
    autovacuum_analyze_scale_factor: "0.05",
    autovacuum_analyze_threshold: "2000",
  },
  channels: {
    autovacuum_analyze_scale_factor: "0.05",
    autovacuum_analyze_threshold: "2000",
  },
  inbox_serving_rows: {
    autovacuum_analyze_scale_factor: "0.02",
    autovacuum_analyze_threshold: "2000",
  },
  message_mentions: {
    autovacuum_analyze_scale_factor: "0.05",
    autovacuum_analyze_threshold: "10000",
  },
  messages: {
    autovacuum_analyze_scale_factor: "0.05",
    autovacuum_analyze_threshold: "10000",
  },
  thread_follows: {
    autovacuum_analyze_scale_factor: "0.05",
    autovacuum_analyze_threshold: "5000",
  },
  user_channel_read_cursors: {
    autovacuum_analyze_scale_factor: "0.05",
    autovacuum_analyze_threshold: "2000",
  },
} as const;

const untouchedTables = [
  "joint_channel_servers",
  "joint_channels",
  "user_channel_inbox_states",
] as const;

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function stripLineComments(sqlText: string): string {
  return sqlText.replace(/^\s*--.*$/gm, "").trim();
}

function parseOptions(options: string[] | null): Record<string, string> {
  return Object.fromEntries(
    (options ?? []).map((option) => {
      const separator = option.indexOf("=");
      assert.notEqual(separator, -1, `invalid reloption: ${option}`);
      return [option.slice(0, separator), option.slice(separator + 1)];
    }),
  );
}

test("0181 changes only the approved autoanalyze storage parameters", async () => {
  const migration = await readFile(migrationPath, "utf8");
  const migrationStatements = statements(migration);
  const executableSql = stripLineComments(migration);

  assert.equal(migrationStatements.length, Object.keys(expectedOptions).length);
  assert.deepEqual(
    migrationStatements
      .map((statement) => {
        const match = stripLineComments(statement).match(
          /^ALTER TABLE "([a-z_]+)" SET \(\s*autovacuum_analyze_scale_factor = ([0-9.]+),\s*autovacuum_analyze_threshold = ([0-9]+)\s*\);$/s,
        );
        assert.ok(match, `unexpected migration statement: ${statement}`);
        const table = match[1] as keyof typeof expectedOptions;
        assert.ok(table in expectedOptions, `unapproved table: ${table}`);
        assert.deepEqual(
          {
            autovacuum_analyze_scale_factor: match[2],
            autovacuum_analyze_threshold: match[3],
          },
          expectedOptions[table],
          `${table} must use the approved exact settings`,
        );
        return match[1];
      })
      .sort(),
    Object.keys(expectedOptions).sort(),
  );
  assert.doesNotMatch(
    executableSql,
    /\b(?:ANALYZE|VACUUM|ALTER DATABASE|work_mem)\b/i,
  );
  assert.doesNotMatch(executableSql, /autovacuum_vacuum_/i);

  const client = new PGlite();
  try {
    for (const table of [...Object.keys(expectedOptions), ...untouchedTables]) {
      await client.exec(`CREATE TABLE "${table}" ("id" integer)`);
    }
    await client.exec(`
      ALTER TABLE "joint_channels" SET (autovacuum_vacuum_scale_factor = 0.03)
    `);

    for (const statement of migrationStatements) await client.exec(statement);
    for (const statement of migrationStatements) await client.exec(statement);

    const result = await client.query<{
      relname: string;
      reloptions: string[] | null;
    }>(
      `
      SELECT "relname", "reloptions"
      FROM "pg_catalog"."pg_class"
      WHERE "relname" = ANY($1::text[])
      ORDER BY "relname"
    `,
      [[...Object.keys(expectedOptions), ...untouchedTables]],
    );
    const actual = Object.fromEntries(
      result.rows.map((row) => [row.relname, parseOptions(row.reloptions)]),
    );

    for (const [table, options] of Object.entries(expectedOptions)) {
      assert.deepEqual(
        actual[table],
        options,
        `${table} must keep the approved exact settings`,
      );
    }
    assert.deepEqual(actual.joint_channel_servers, {});
    assert.deepEqual(actual.user_channel_inbox_states, {});
    assert.deepEqual(actual.joint_channels, {
      autovacuum_vacuum_scale_factor: "0.03",
    });
  } finally {
    await client.close();
  }
});
