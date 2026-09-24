// Teeth for the deploy-path migration runner (successor to the disproven
// CI=true env fix — review evidence: drizzle-kit's bundled hanji swallows the
// rejection regardless of env, so the deploy path now owns its failure output
// via the programmatic migrator).
//
// Property under test (NOT shape): a failing migration's FIRST run must emit a
// structured [MIGRATION_FAILED] line carrying the real SQLSTATE, the failing
// journal tag, the server message, and a statement snippet from the actual
// error chain — and success semantics must stay byte-compatible with drizzle
// accounting (first apply records rows in drizzle.__drizzle_migrations, second
// run no-ops, failure rolls back with no partial journal row).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import {
  classifyAppliedCountError,
  extractPgError,
  findFailingTag,
  formatMigrationFailure,
  readJournalTags,
  runDeployMigrations,
} from "./migrateDeploy.js";

function writeMigrations(entries: Array<{ tag: string; sql: string }>): string {
  const folder = mkdtempSync(path.join(tmpdir(), "migrate-deploy-"));
  mkdirSync(path.join(folder, "meta"), { recursive: true });
  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entries.map((e, idx) => ({
        idx,
        version: "7",
        when: 1700000000000 + idx,
        tag: e.tag,
        breakpoints: true,
      })),
    }),
  );
  for (const e of entries) {
    writeFileSync(path.join(folder, `${e.tag}.sql`), e.sql);
  }
  return folder;
}

async function makeHarness(entries: Array<{ tag: string; sql: string }>) {
  const client = new PGlite();
  const db = drizzle(client);
  const folder = writeMigrations(entries);
  const appliedCount = async () => {
    try {
      const res = await client.query(
        'SELECT count(*)::int AS applied FROM "drizzle"."__drizzle_migrations"',
      );
      return (res.rows[0] as { applied: number }).applied;
    } catch {
      return null;
    }
  };
  return {
    client,
    folder,
    appliedCount,
    run(log: (line: string) => void) {
      return runDeployMigrations((opts) => migrate(db, opts), folder, appliedCount, log);
    },
  };
}

test("success: first apply records drizzle accounting, second run no-ops", async () => {
  const h = await makeHarness([
    { tag: "0000_ok_one", sql: "CREATE TABLE deploy_ok (x integer);" },
    { tag: "0001_ok_two", sql: "INSERT INTO deploy_ok (x) VALUES (7);" },
  ]);
  const logs: string[] = [];
  await h.run((l) => logs.push(l));
  assert.equal(logs.length, 0, "success path must not emit failure lines");
  assert.equal(await h.appliedCount(), 2, "first apply must record both migrations");

  // Second run: same journal, nothing pending — must not re-apply (the INSERT
  // running twice would leave 2 rows).
  await h.run((l) => logs.push(l));
  assert.equal(await h.appliedCount(), 2, "second run must be a no-op in accounting");
  const rows = await h.client.query("SELECT count(*)::int AS n FROM deploy_ok");
  assert.equal((rows.rows[0] as { n: number }).n, 1, "second run must not re-execute statements");
  await h.client.close();
});

test("failure: first run emits SQLSTATE + failing tag + statement, rolls back, no partial journal", async () => {
  const SENTINEL = "deploy_sqlstate_sentinel_22003";
  const h = await makeHarness([
    { tag: "0000_ok", sql: "CREATE TABLE deploy_fail (x integer);" },
    {
      tag: "0001_overflow",
      // int4 overflow -> SQLSTATE 22003; sentinel embedded in the statement so
      // the log line provably carries the REAL failing SQL, not a placeholder.
      sql: `INSERT INTO deploy_fail (x) VALUES (2147483648) /* ${SENTINEL} */;`,
    },
  ]);
  const logs: string[] = [];
  await assert.rejects(() => h.run((l) => logs.push(l)), "failing migration must reject");

  assert.equal(logs.length, 1, "exactly one structured failure line");
  const line = logs[0];
  assert.match(line, /^\[MIGRATION_FAILED\] /);
  assert.match(line, /sqlstate=22003/);
  assert.match(line, /migration=0001_overflow/);
  assert.match(line, /out of range/);
  assert.ok(line.includes(SENTINEL), "statement snippet must come from the real error chain");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(line, /\x1b\[/, "no ANSI in failure output");

  // Rollback: the batch runs in ONE transaction, so nothing is recorded —
  // including the transiently-succeeded 0000 (this is exactly why the failing
  // tag must come from the statement, not the accounting count).
  assert.equal(await h.appliedCount(), 0, "failed batch must record nothing");
  const reg = await h.client.query("SELECT to_regclass('deploy_fail') AS r");
  assert.equal(
    (reg.rows[0] as { r: string | null }).r,
    null,
    "rollback must be total: even the transiently-created table is gone",
  );
  await h.client.close();
});

test("extractPgError walks the chain; formatter is deterministic and bounded", async () => {
  const pgErr = Object.assign(new Error("value out of range"), { code: "22003", position: "35" });
  const wrapped = Object.assign(new Error("Failed query"), {
    query: `INSERT INTO t VALUES (1)${" ".repeat(10)}-- ${"y".repeat(500)}`,
    cause: pgErr,
  });
  const extracted = extractPgError(wrapped);
  assert.equal(extracted.code, "22003");
  assert.equal(extracted.message, "value out of range");
  assert.equal(extracted.position, "35");
  const { boundStatementSnippet } = await import("./migrateDeploy.js");
  assert.ok((boundStatementSnippet(extracted.query) as string).length <= 300, "statement snippet must be bounded");

  const noCode = extractPgError(new Error("plain"));
  assert.equal(noCode.code, null);
  assert.match(
    formatMigrationFailure({
      sqlstate: noCode.code,
      message: noCode.message,
      migrationTag: null,
      position: null,
      statement: null,
    }),
    /sqlstate=UNKNOWN migration=UNKNOWN message=plain/,
  );
});

test("hostile message/statement stay ONE sanitized line (no ANSI, no linebreaks, bounded)", () => {
  const hostile = formatMigrationFailure({
    sqlstate: "22003",
    message: "line one\nline two\r\n\x1b[31mred\x1b[0m\ttab" + "z".repeat(600),
    migrationTag: "0001_x",
    position: "12\n34",
    statement: "SELECT 1;\n\x1b[2Jwipe" + "q".repeat(600),
  });
  assert.equal(hostile.split("\n").length, 1, "must be one physical line");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(hostile, /[\x00-\x1f\x7f]/, "no control chars/ESC survive");
  assert.doesNotMatch(hostile, /\x1b/, "no ESC survives");
  assert.match(hostile, /message=line one line two red tab/);
  assert.ok(hostile.length < 1200, "all dynamic fields bounded");
});

test("duplicate statement across applied and pending tags blames the PENDING tag", async () => {
  const DUP = "INSERT INTO dup_t (x) VALUES (2147483648) /* dup_sentinel */;";
  // Batch 1: apply 0000_old (creates table + a SAFE insert so it succeeds).
  const h = await makeHarness([
    { tag: "0000_old", sql: `CREATE TABLE dup_t (x bigint);` },
  ]);
  await h.run(() => {});
  assert.equal(await h.appliedCount(), 1);

  // Now narrow the column and add 0001_current containing the SAME failing
  // statement text as... (simulate recurrence: 0000_old file ALSO contains the
  // statement text inside a comment so naive first-match would blame it).
  const { writeFileSync: wf } = await import("node:fs");
  const path2 = await import("node:path");
  wf(
    path2.join(h.folder, "0000_old.sql"),
    `CREATE TABLE dup_t (x bigint);\n-- historical note: ${DUP}`,
  );
  wf(path2.join(h.folder, "0001_current.sql"), `ALTER TABLE dup_t ALTER COLUMN x TYPE integer;\n--> statement-breakpoint\n${DUP}`);
  const journalPath = path2.join(h.folder, "meta", "_journal.json");
  const { readFileSync: rf } = await import("node:fs");
  const journal = JSON.parse(rf(journalPath, "utf8"));
  journal.entries.push({ idx: 1, version: "7", when: 1700000000101, tag: "0001_current", breakpoints: true });
  wf(journalPath, JSON.stringify(journal));

  const logs: string[] = [];
  await assert.rejects(() => h.run((l) => logs.push(l)));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /sqlstate=22003/);
  assert.match(
    logs[0],
    /migration=0001_current/,
    "must blame the pending tag, not the applied 0000_old that contains the same text",
  );
  await h.client.close();
});

test("ambiguous multi-pending match is fail-closed to UNKNOWN, never a guessed tag", async () => {
  const DUP = "INSERT INTO amb_t (x) VALUES (2147483648) /* amb_sentinel */;";
  const h = await makeHarness([
    { tag: "0000_mk", sql: "CREATE TABLE amb_t (x integer);" },
    { tag: "0001_a", sql: DUP },
    { tag: "0002_b", sql: `-- also contains it: ${DUP}` },
  ]);
  const logs: string[] = [];
  await assert.rejects(() => h.run((l) => logs.push(l)));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /sqlstate=22003/);
  assert.match(logs[0], /migration=UNKNOWN/, "two pending matches must not guess");
  await h.client.close();
});

test("hostile journal TAG cannot break the one-line guarantee either", () => {
  const line = formatMigrationFailure({
    sqlstate: "22003",
    message: "m",
    migrationTag: "0001_bad\n\x1b[31mtag" + "t".repeat(300),
    position: null,
    statement: null,
  });
  assert.equal(line.split("\n").length, 1, "hostile tag must not split the line");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(line, /[\x00-\x1f\x7f]/, "no control chars from the tag");
  assert.match(line, /migration=0001_bad tag/, "tag sanitized in place (full ANSI sequence stripped)");
  assert.ok(line.length < 400, "tag bounded");
});

test("unreadable accounting fail-closes tag resolution: no full-journal scan", async () => {
  const { mkdtempSync: md, mkdirSync: mkd, writeFileSync: wf2 } = await import("node:fs");
  const os2 = await import("node:os");
  const path3 = await import("node:path");
  const folder = md(path3.join(os2.tmpdir(), "failclosed-"));
  mkd(path3.join(folder, "meta"), { recursive: true });
  const OLD_Q = "INSERT INTO t VALUES (1) /* recurring */;";
  wf2(
    path3.join(folder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries: [
      { idx: 0, version: "7", when: 1, tag: "0000_old", breakpoints: true },
    ] }),
  );
  wf2(path3.join(folder, "0000_old.sql"), OLD_Q);
  // appliedCount unknown (null): even a unique match in the journal must NOT
  // be reported — the matching tag may already be applied.
  assert.equal(findFailingTag(folder, OLD_Q, null), null);
  // With accounting readable (0 applied = fresh DB), the same match resolves.
  assert.equal(findFailingTag(folder, OLD_Q, 0), "0000_old");
});

test("classifyAppliedCountError: fresh-DB 42P01 is zero, anything else is unknown", () => {
  const missingTable = Object.assign(new Error("relation does not exist"), { code: "42P01" });
  assert.equal(classifyAppliedCountError(missingTable), 0);
  const permission = Object.assign(new Error("permission denied"), { code: "42501" });
  assert.equal(classifyAppliedCountError(permission), null);
  assert.equal(classifyAppliedCountError(new Error("socket hang up")), null);
});

test("readJournalTags reads tags in journal order", () => {
  const folder = writeMigrations([
    { tag: "0000_a", sql: "SELECT 1;" },
    { tag: "0001_b", sql: "SELECT 1;" },
  ]);
  assert.deepEqual(readJournalTags(folder), ["0000_a", "0001_b"]);
});

// ---------------------------------------------------------------------------
// Transient-concurrency retry teeth (2026-09-11, v1.13.0 cut).
//
// Property under test (NOT shape): a migration phase that loses a lock race
// (SQLSTATE 40P01 deadlock_detected / 40001 serialization_failure) is retried
// within a bounded budget, because a failed phase rolls back wholesale and is
// safe to re-run from its boundary. Every OTHER failure must still fail on the
// FIRST attempt — retrying a real defect would convert an error into an
// accidental success. Both directions are asserted, so the teeth cannot be
// satisfied by "always retry" or "never retry".
// ---------------------------------------------------------------------------

function deadlockError(): Error {
  return Object.assign(new Error("deadlock detected"), { code: "40P01" });
}

function syntaxError(): Error {
  return Object.assign(new Error('syntax error at or near "NOT"'), { code: "42601" });
}

test("retry: a deadlock on the first attempt is retried and the run succeeds", async () => {
  const folder = writeMigrations([{ tag: "0000_ok", sql: "SELECT 1;" }]);
  const logs: string[] = [];
  let calls = 0;
  await runDeployMigrations(
    async () => {
      calls += 1;
      if (calls === 1) throw deadlockError();
    },
    folder,
    async () => 0,
    (line) => logs.push(line),
    { sleep: async () => {}, maxAttempts: 3, baseDelayMs: 1 },
  );
  assert.equal(calls, 2, "the phase must be re-run exactly once after a deadlock");
  const joined = logs.join("\n");
  assert.match(joined, /\[MIGRATION_FAILED\]/, "the failed attempt still reports its diagnostic line");
  assert.match(joined, /sqlstate=40P01/, "the diagnostic names the transient SQLSTATE");
  assert.match(joined, /\[MIGRATION_RETRY\] reason=sqlstate=40P01 attempt=1\/3/, "the retry is observable in the log");
  assert.match(joined, /\[MIGRATION_RETRY_SUCCEEDED\] attempt=2\/3/, "a retried success is distinguishable from a first-try success");
});

test("retry: a non-concurrency failure is NOT retried (no accidental masking)", async () => {
  const folder = writeMigrations([{ tag: "0000_bad", sql: "SELECT 1;" }]);
  const logs: string[] = [];
  let calls = 0;
  await assert.rejects(
    runDeployMigrations(
      async () => {
        calls += 1;
        throw syntaxError();
      },
      folder,
      async () => 0,
      (line) => logs.push(line),
      { sleep: async () => {}, maxAttempts: 5, baseDelayMs: 1 },
    ),
  );
  assert.equal(calls, 1, "a real defect must fail on the first attempt");
  assert.doesNotMatch(logs.join("\n"), /\[MIGRATION_RETRY\]/, "no retry line for a non-retryable SQLSTATE");
});

test("retry: the budget is bounded — exhaustion fails the deploy and says so", async () => {
  const folder = writeMigrations([{ tag: "0000_stuck", sql: "SELECT 1;" }]);
  const logs: string[] = [];
  let calls = 0;
  await assert.rejects(
    runDeployMigrations(
      async () => {
        calls += 1;
        throw deadlockError();
      },
      folder,
      async () => 0,
      (line) => logs.push(line),
      { sleep: async () => {}, maxAttempts: 3, baseDelayMs: 1 },
    ),
  );
  assert.equal(calls, 3, "attempts must stop at the budget");
  const joined = logs.join("\n");
  assert.match(joined, /\[MIGRATION_RETRY_EXHAUSTED\] sqlstate=40P01 attempts=3\/3/, "exhaustion is explicit");
  assert.equal(
    (joined.match(/\[MIGRATION_FAILED\]/g) ?? []).length,
    3,
    "every attempt reports its own failure line",
  );
});

test("retry: a null SQLSTATE (non-PG error) is not retried", async () => {
  const folder = writeMigrations([{ tag: "0000_ok", sql: "SELECT 1;" }]);
  let calls = 0;
  await assert.rejects(
    runDeployMigrations(
      async () => {
        calls += 1;
        throw new Error("socket hang up");
      },
      folder,
      async () => 0,
      () => {},
      { sleep: async () => {}, maxAttempts: 4, baseDelayMs: 1 },
    ),
  );
  assert.equal(calls, 1, "unknown failure modes must not be retried into an accidental success");
});
