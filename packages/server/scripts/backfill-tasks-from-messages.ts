#!/usr/bin/env tsx
/**
 * Backfill: create a canonical `tasks` row for every legacy message-task.
 *
 * Task v1.4 made `tasks` the source of truth. Reads union both tables and
 * suppress the message side by anti-join on `tasks.message_id`; mutations route
 * to whichever side owns the task. A message-task with no canonical row is
 * still owned — and still written — on the message side. This closes that gap.
 *
 * What it deliberately does NOT do: clear `messages.task_*`. Those columns stop
 * being reachable the moment a canonical row exists (ownership routes away from
 * them, and nothing has written them since v1.4), so clearing buys nothing
 * toward the end state while destroying the only rollback path if this backfill
 * turns out to be wrong. Dropping the columns is P4 and does not require the
 * values to be cleared first.
 *
 * Safe to re-run. `idx_tasks_message_id` is unique, so an interrupted run
 * resumes and an already-migrated task is skipped rather than duplicated.
 *
 *   pnpm --filter @botiverse/raft-server exec tsx scripts/backfill-tasks-from-messages.ts --dry-run
 *   pnpm --filter @botiverse/raft-server exec tsx scripts/backfill-tasks-from-messages.ts --apply
 *   pnpm --filter @botiverse/raft-server exec tsx scripts/backfill-tasks-from-messages.ts --verify
 */
import "dotenv/config";
import pg from "pg";

type Mode = "dry-run" | "apply" | "verify";

interface Options {
  mode: Mode;
  batchSize: number;
  limit: number | null;
  channelId: string | null;
  statementTimeoutMs: number;
  skipCount: boolean;
}

function parseArgs(argv: string[]): Options {
  // Ops scripts do not inherit a serving-sized timeout. The pending-count scans
  // `messages`, which on a real deployment is large enough that a 15s serving
  // floor cancels it outright — that is exactly what happened on the first run.
  // Same pattern as scripts/create-message-random-id-index.ts, which sets its
  // own timeout before a long CREATE INDEX.
  const opts: Options = {
    mode: "dry-run", batchSize: 5_000, limit: null, channelId: null,
    statementTimeoutMs: 600_000, skipCount: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") opts.mode = "apply";
    else if (a === "--dry-run") opts.mode = "dry-run";
    else if (a === "--verify") opts.mode = "verify";
    else if (a === "--batch-size") opts.batchSize = Number(argv[++i]);
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--channel") opts.channelId = argv[++i];
    else if (a === "--statement-timeout-ms") opts.statementTimeoutMs = Number(argv[++i]);
    else if (a === "--skip-count") opts.skipCount = true;
  }
  if (!Number.isSafeInteger(opts.batchSize) || opts.batchSize < 1) {
    throw new Error("--batch-size must be a positive integer");
  }
  if (!Number.isSafeInteger(opts.statementTimeoutMs) || opts.statementTimeoutMs < 1000) {
    throw new Error("--statement-timeout-ms must be an integer >= 1000");
  }
  return opts;
}

/**
 * A message-task that has no canonical row yet.
 *
 * `title` is the message content verbatim. That is exactly what the read path
 * already renders for a message-task (`title: t.content`), so copying it
 * unchanged is what keeps the displayed task byte-identical across the move.
 * Truncating here would silently rewrite every long task's title.
 */
const SELECT_PENDING = `
  SELECT m.id, m.channel_id, m.task_number, m.content, m.task_status,
         m.sender_type, m.sender_id,
         m.task_assignee_type, m.task_assignee_id,
         m.task_claimed_at, m.task_completed_at, m.created_at
  FROM messages m
  LEFT JOIN tasks t ON t.message_id = m.id
  WHERE m.task_status IS NOT NULL
    AND m.task_number IS NOT NULL
    AND t.id IS NULL
    $CHANNEL_FILTER$
  LIMIT $LIMIT$
`;

const COUNT_PENDING = `
  SELECT count(*)::int AS n
  FROM messages m
  LEFT JOIN tasks t ON t.message_id = m.id
  WHERE m.task_status IS NOT NULL AND m.task_number IS NOT NULL AND t.id IS NULL
`;

function bar(done: number, total: number, width = 32): string {
  if (total === 0) return "─".repeat(width);
  const filled = Math.min(width, Math.round((done / total) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * `total` is null when the pending count was skipped or failed. There is then no
 * denominator, so there is no percentage, no bar and no ETA — report a running
 * count instead. Rendering against a sentinel total produced an ETA of
 * 15,670,655,077,296 seconds, which is worse than showing nothing: a made-up
 * number still looks like a measurement.
 */
function progress(done: number, total: number | null, skipped: number, startedAt: number) {
  const elapsed = (Date.now() - startedAt) / 1000;
  const rate = done > 0 ? done / elapsed : 0;
  let line: string;
  if (total == null) {
    line = `  ${done} migrated` + (skipped ? `, ${skipped} skipped` : "")
      + (rate > 0 ? `  (${Math.round(rate)}/s)` : "");
  } else {
    const pct = total === 0 ? 100 : Math.floor((done / total) * 100);
    const eta = rate > 0 && total > done ? Math.round((total - done) / rate) : 0;
    line = `  [${bar(done, total)}] ${String(pct).padStart(3)}%  ${done}/${total} migrated`
      + (skipped ? `, ${skipped} skipped` : "")
      + (eta ? `  eta ${eta}s` : "");
  }
  process.stderr.write(`\r${line.padEnd(100)}`);
}

async function verify(client: pg.Client): Promise<boolean> {
  console.error("\nVerify oracle:");
  let ok = true;
  const check = async (label: string, sql: string, expect: number) => {
    try {
      const { rows } = await client.query(sql);
      const got = Number(rows[0].n);
      const pass = got === expect;
      if (!pass) ok = false;
      console.error(`  ${pass ? "PASS" : "FAIL"}  ${label}: ${got} (expected ${expect})`);
    } catch (e) {
      // A check that cannot run is not a check that failed, and the migration
      // it was verifying may well have succeeded. Say which happened — an
      // operator who sees a bare timeout after a completed apply cannot tell
      // whether their data is fine.
      ok = false;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  SKIP  ${label}: could not run (${msg.split("\n")[0]})`);
    }
  };

  // Some quantities are worth watching but are NOT invariants -- reporting them
  // as PASS/FAIL would make a healthy system permanently red, which is how an
  // oracle gets ignored. `report` prints the number and never affects the verdict.
  const report = async (label: string, sql: string, note: string) => {
    try {
      const { rows } = await client.query(sql);
      console.error(`  INFO  ${label}: ${Number(rows[0].n)}  (${note})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  INFO  ${label}: unavailable (${msg.split("\n")[0]})`);
    }
  };

  // The gate for P3/P4. While this is non-zero, some task is still owned — and
  // still written — on the message side, so the legacy write paths are live.
  await check("message-tasks with no canonical row", COUNT_PENDING, 0);

  // NOT a defect under v1.4 Model B: a natively-created task has a canonical row
  // whose host message is a PLAIN message with task_status NULL, by design. The
  // old form of this check counted exactly those and reported every post-cut task
  // as broken -- on prod it read 11,261 FAIL against perfectly correct data, while
  // the operator was mid-migration. What IS a defect is a canonical row pointing
  // at a host message that does not exist.
  await check(
    "canonical rows whose host message is missing",
    `SELECT count(*)::int AS n FROM tasks t
      WHERE t.message_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = t.message_id)`,
    0,
  );

  // NOT an invariant, deliberately. Once a row is backfilled the canonical side
  // is authoritative and `messages.task_*` is a frozen snapshot that mutations no
  // longer touch, so the two sides are DESIGNED to diverge as tasks get edited.
  // Asserting equality here made a healthy system report FAIL and would have gone
  // permanently red -- on prod it fired on 2 rows that had simply been edited
  // during the migration window.
  //
  // Kept as a reported metric because it measures something the operator actually
  // wants during the keep-and-observe period (stdrc, 2026-07-31): how far the
  // snapshot has decayed, i.e. how much rollback fidelity has already been lost
  // and therefore when `messages.task_*` can be dropped.
  await report(
    "shadow drift (backfilled rows whose frozen snapshot no longer matches canonical)",
    `SELECT count(*)::int AS n FROM tasks t
       JOIN messages m ON m.id = t.message_id
      WHERE m.task_status IS NOT NULL
        AND (t.status IS DISTINCT FROM m.task_status
         OR t.task_number IS DISTINCT FROM m.task_number
         OR t.title IS DISTINCT FROM m.content
         OR t.claimed_by_type IS DISTINCT FROM m.task_assignee_type
         OR t.claimed_by_id IS DISTINCT FROM m.task_assignee_id
         OR t.claimed_at IS DISTINCT FROM m.task_claimed_at
         OR t.completed_at IS DISTINCT FROM m.task_completed_at)`,
    "expected to grow; canonical is authoritative, the snapshot is frozen by design",
  );

  await check(
    "duplicate canonical rows per host message",
    `SELECT count(*)::int AS n FROM (
       SELECT message_id FROM tasks WHERE message_id IS NOT NULL
       GROUP BY message_id HAVING count(*) > 1) d`,
    0,
  );

  // Two tasks sharing a number inside one channel would make `task #N`
  // ambiguous — the reference users and agents actually type.
  await check(
    "task numbers colliding within a channel",
    // NOT IN against a large subquery was the original form and it is what
    // timed out on staging after the rows had already been migrated — Postgres
    // cannot hash a NOT IN whose subquery may contain NULLs, so it degrades to
    // a per-row scan. NOT EXISTS is an anti-join and plans properly.
    `SELECT count(*)::int AS n FROM (
       SELECT channel_id, task_number FROM (
         SELECT channel_id, task_number FROM tasks
         UNION ALL
         SELECT m.channel_id, m.task_number FROM messages m
          WHERE m.task_status IS NOT NULL AND m.task_number IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.message_id = m.id)
       ) all_numbers
       GROUP BY channel_id, task_number HAVING count(*) > 1) c`,
    0,
  );

  console.error(ok
    ? "\n  oracle: ALL PASS\n"
    : "\n  oracle: NOT ALL CHECKS PASSED — see FAIL/SKIP above.\n"
      + "  A SKIP means the check could not run, not that the data is wrong;\n"
      + "  re-run `--verify` (direct endpoint) before drawing a conclusion.\n");
  return ok;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  // Raise this session's ceiling before any query. Session-scoped, so it cannot
  // affect the serving role or any other connection.
  await client.query(`SELECT set_config('statement_timeout', $1, false)`, [String(opts.statementTimeoutMs)]);
  await client.query(`SELECT set_config('lock_timeout', '10s', false)`);
  // Read back what the server ACTUALLY gave this session. Printing the value we
  // asked for would be a receipt, not a measurement: a pooler can silently drop
  // session settings, which is precisely how the 60s migration timeout turned
  // out never to have been delivered.
  const { rows: effRows } = await client.query(
    `SELECT setting FROM pg_settings WHERE name = 'statement_timeout'`,
  );
  const effectiveTimeout = effRows[0]?.setting ?? "unknown";

  try {
    if (opts.mode === "verify") {
      const ok = await verify(client);
      process.exitCode = ok ? 0 : 1;
      return;
    }

    // How many rows are we about to touch? The exact count scans `messages`, so
    // under a low ceiling it is cancelled — on a pooled Neon connection the
    // session timeout this script sets is silently dropped, so the ceiling is
    // whatever the role says. Use a direct (non-pooler) endpoint and the count
    // completes; otherwise pass --skip-count and the run reports a running
    // total instead.
    //
    // A sampled TABLESAMPLE estimate was written here and then removed: it
    // could not be exercised locally (this script raises its own timeout, so
    // the exact count never failed in testing), and an untested fallback on a
    // rarely-hit path is worse than the tested degradation below.
    let total: number | null = null;
    if (!opts.skipCount) {
      try {
        const { rows } = await client.query(COUNT_PENDING);
        total = Number(rows[0].n);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  (could not count pending rows: ${msg.split("\n")[0]})`);
        console.error("  continuing without a total — progress will show a running count.");
        console.error("  tip: use the direct (non-pooler) Neon endpoint, or pass --skip-count.\n");
      }
    }
    const target = opts.limit ?? Number.MAX_SAFE_INTEGER;

    console.error(`\nBackfill tasks from message-tasks`);
    console.error(`  mode:      ${opts.mode.toUpperCase()}${opts.mode === "dry-run" ? "  (nothing will be written)" : ""}`);
    console.error(`  pending:   ${total ?? "unknown"}${opts.limit != null ? `  (limited to ${opts.limit})` : ""}`);
    console.error(`  timeout:   requested ${opts.statementTimeoutMs}ms, server reports ${effectiveTimeout}ms`
      + (String(effectiveTimeout) !== String(opts.statementTimeoutMs)
        ? "   ← NOT APPLIED (pooler likely dropped it)"
        : ""));
    console.error(`  batch:     ${opts.batchSize}`);
    if (opts.channelId) console.error(`  channel:   ${opts.channelId}`);
    console.error("");

    if (total === 0) {
      console.error("  nothing to do — every message-task already has a canonical row\n");
      await verify(client);
      return;
    }

    let migrated = 0;
    let skipped = 0;
    const startedAt = Date.now();

    // Batch size note: with the keyset cursor below, batch size only trades
  // round trips against update granularity — it no longer affects total scan
  // volume, which is what made small batches expensive in the pre-cursor
  // version. Smaller is friendlier to whoever is watching the run.
  //
  // Keyset cursor over messages.id.
    //
    // The previous form re-ran `LEFT JOIN tasks ... WHERE t.id IS NULL LIMIT n`
    // for every batch. Already-migrated rows drop out of that result, but
    // Postgres still has to walk past them to find the next unmigrated ones, so
    // each batch started further in than the last and the run degraded toward
    // quadratic. On staging that is 112k rows under a hard 15s ceiling — it
    // would have slowed until every batch timed out.
    //
    // Advancing a cursor instead means every message is visited at most once
    // across the whole run, so batch cost stays flat and each one lands well
    // inside the ceiling. It is also why an interrupted run resumes cheaply:
    // the anti-join skips what is already there, and the cursor walks forward.
    let cursor: string | null = null;

    // Retry a batch on transient failure. A 418k-row run over a pooled
    // connection will meet the occasional dropped connection or cancelled
    // statement; losing the whole run to one blip — after an operator has
    // watched it for minutes — is the wrong failure mode when the work is
    // idempotent and resumable anyway.
    const withRetry = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          return await fn();
        } catch (e) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          if (attempt === 4) break;
          const backoffMs = 500 * 2 ** (attempt - 1);
          process.stderr.write(
            `\n  ${label} failed (attempt ${attempt}/4): ${msg.split("\n")[0]}\n`
            + `  retrying in ${backoffMs}ms — already-migrated rows are skipped, so this is safe\n`,
          );
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
      throw lastErr;
    };

    // A long job must say something before its first batch finishes. Without
    // this the operator watches a blank screen for as long as the first scan
    // takes and cannot tell a slow run from a hung one.
    process.stderr.write(`  scanning…\r`);

    for (;;) {
      if (opts.limit != null && migrated + skipped >= opts.limit) break;

      const remaining = opts.limit != null ? opts.limit - (migrated + skipped) : opts.batchSize;
      const take = Math.min(opts.batchSize, remaining);

      const candidateSql = `
        SELECT m.id
          FROM messages m
          LEFT JOIN tasks t ON t.message_id = m.id
         WHERE m.task_status IS NOT NULL
           AND m.task_number IS NOT NULL
           AND t.id IS NULL
           ${cursor ? "AND m.id > $2" : ""}
           ${opts.channelId ? `AND m.channel_id = $${cursor ? 3 : 2}` : ""}
         ORDER BY m.id
         LIMIT $1`;
      const candidateParams: unknown[] = [take];
      if (cursor) candidateParams.push(cursor);
      if (opts.channelId) candidateParams.push(opts.channelId);

      const { rows: candidates } = await withRetry("candidate scan", () =>
        client.query(candidateSql, candidateParams));
      if (candidates.length === 0) break;

      const ids: string[] = candidates.map((r: { id: string }) => r.id);
      cursor = ids[ids.length - 1];

      if (opts.mode === "dry-run") {
        // Count only the ones that would actually be written.
        const { rows: pend } = await client.query(
          `SELECT count(*)::int AS n FROM messages m
             LEFT JOIN tasks t ON t.message_id = m.id
            WHERE m.id = ANY($1) AND t.id IS NULL`,
          [ids],
        );
        migrated += Number(pend[0].n);
        skipped += ids.length - Number(pend[0].n);
        progress(migrated, total, skipped, startedAt);
        continue;
      }

      const ins = await withRetry("batch insert", () => client.query(
        `INSERT INTO tasks
           (id, channel_id, task_number, title, status,
            created_by_type, created_by_id,
            claimed_by_type, claimed_by_id, claimed_at, completed_at,
            revision, message_id, created_at, updated_at)
         SELECT gen_random_uuid(), m.channel_id, m.task_number, m.content, m.task_status,
                m.sender_type, m.sender_id,
                m.task_assignee_type, m.task_assignee_id, m.task_claimed_at, m.task_completed_at,
                0, m.id, m.created_at, now()
           FROM messages m
           LEFT JOIN tasks t ON t.message_id = m.id
          WHERE m.id = ANY($1) AND t.id IS NULL
         ON CONFLICT (message_id) DO NOTHING`,
        [ids],
      ));
      const wrote = ins.rowCount ?? 0;
      migrated += wrote;
      skipped += ids.length - wrote;

      progress(migrated, total, skipped, startedAt);
    }

    progress(migrated, total, skipped, startedAt);
    process.stderr.write("\n\n");
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (opts.mode === "dry-run") {
      console.error(`  DRY RUN — would migrate ${migrated} message-tasks. Nothing was written.`);
      console.error(`  Re-run with --apply to write.\n`);
    } else {
      console.error(`  migrated ${migrated}, skipped ${skipped}, in ${secs}s\n`);
      await verify(client);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
