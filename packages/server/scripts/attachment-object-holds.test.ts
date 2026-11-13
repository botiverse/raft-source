import assert from "node:assert/strict";
import { parseAttachmentObjectHoldsArgs, resolveAttachmentObjectHoldsDatabase } from "./attachment-object-holds";

test("hold CLI defaults: bounded batches, 30-day report, read-only commands take no write flags", () => {
  assert.deepEqual(parseAttachmentObjectHoldsArgs(["reconcile"]), {
    command: "reconcile",
    sample: 10,
    statementTimeoutMs: 120_000,
    databaseUrl: null,
  });
  assert.deepEqual(parseAttachmentObjectHoldsArgs(["report"]), {
    command: "report",
    sample: 20,
    graceDays: 30,
    statementTimeoutMs: 120_000,
    databaseUrl: null,
  });
  assert.deepEqual(parseAttachmentObjectHoldsArgs(["backfill"]), {
    command: "backfill",
    batchSize: 500,
    cursor: null,
    cursorFile: null,
    maxBatches: null,
    sleepMs: 100,
    lockTimeoutMs: 2000,
    statementTimeoutMs: 30000,
    pauseFiles: [],
    stopAt: null,
  });
  const resumed = parseAttachmentObjectHoldsArgs([
    "backfill",
    "--cursor", "a0000000-0000-4000-8000-000000000001",
    "--batch-size", "1000",
    "--pause-file", "/tmp/a",
    "--pause-file", "/tmp/b",
    "--stop-at", "2026-11-01T01:00:00Z",
  ]);
  assert.equal(resumed.command, "backfill");
  if (resumed.command === "backfill") {
    assert.equal(resumed.cursor, "a0000000-0000-4000-8000-000000000001");
    assert.equal(resumed.batchSize, 1000);
    assert.deepEqual(resumed.pauseFiles, ["/tmp/a", "/tmp/b"]);
    assert.equal(resumed.stopAt, Date.parse("2026-11-01T01:00:00Z"));
  }
  assert.throws(() => parseAttachmentObjectHoldsArgs(["backfill", "--batch-size", "50000"]), /--batch-size/);
  assert.throws(() => parseAttachmentObjectHoldsArgs(["backfill", "--cursor", "nope"]), /--cursor/);
  assert.throws(
    () => parseAttachmentObjectHoldsArgs(["backfill", "--cursor", "a0000000-0000-4000-8000-000000000001", "--cursor-file", "/tmp/c"]),
    /not both/,
  );
  assert.throws(() => parseAttachmentObjectHoldsArgs(["report", "--batch-size", "10"]), /not valid for report/);
  assert.throws(() => parseAttachmentObjectHoldsArgs(["delete"]), /Usage/);
  assert.throws(() => parseAttachmentObjectHoldsArgs(["reconcile", "--statement-timeout-ms", "0"]), /--statement-timeout-ms/);
  assert.throws(() => parseAttachmentObjectHoldsArgs(["report", "--database-url", "mysql://x"]), /--database-url/);
  assert.throws(
    () => parseAttachmentObjectHoldsArgs(["backfill", "--database-url", "postgres://replica/db"]),
    /not valid for backfill/,
  );
});

test("reads go to --database-url, then the read replica, then the primary; the backfill only to the primary", () => {
  const env = { DATABASE_URL: "postgres://primary/db", DATABASE_URL_READ_REPLICA: "postgres://replica/db" };
  const reconcile = parseAttachmentObjectHoldsArgs(["reconcile", "--statement-timeout-ms", "600000"]);
  assert.equal(reconcile.command === "reconcile" && reconcile.statementTimeoutMs, 600_000);
  assert.deepEqual(resolveAttachmentObjectHoldsDatabase(reconcile, env), {
    url: "postgres://replica/db",
    source: "DATABASE_URL_READ_REPLICA",
  });
  assert.deepEqual(resolveAttachmentObjectHoldsDatabase(reconcile, { DATABASE_URL: env.DATABASE_URL }), {
    url: "postgres://primary/db",
    source: "DATABASE_URL",
  });
  const flagged = parseAttachmentObjectHoldsArgs(["report", "--database-url", "postgresql://other/db"]);
  assert.deepEqual(resolveAttachmentObjectHoldsDatabase(flagged, env), {
    url: "postgresql://other/db",
    source: "--database-url",
  });
  assert.deepEqual(resolveAttachmentObjectHoldsDatabase(parseAttachmentObjectHoldsArgs(["backfill"]), env), {
    url: "postgres://primary/db",
    source: "DATABASE_URL",
  });
  assert.throws(
    () => resolveAttachmentObjectHoldsDatabase(parseAttachmentObjectHoldsArgs(["backfill"]), { DATABASE_URL_READ_REPLICA: "postgres://replica/db" }),
    /DATABASE_URL is required/,
  );
});
