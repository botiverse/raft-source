// message_server_timeline step 2 operator entrypoint. NEVER scheduled; run
// manually, off-peak, watching replica replay lag (the table is not in the
// RisingWave publication, so there is no CDC traffic, only WAL). Idempotent and
// resumable: re-running only pays the scan; --after-id resumes from the last_id
// of a previous run's batch lines.
//
// Usage:
//   DATABASE_URL=... node --import @oxc-node/core/register scripts/message-server-timeline-backfill.ts \
//     [--batch-size 5000] [--sleep-ms 200] [--statement-timeout-ms 30000] [--lock-timeout-ms 2000] [--after-id <uuid>]
//   DATABASE_URL=... node --import @oxc-node/core/register scripts/message-server-timeline-backfill.ts --verify-only [--batch-size 2000] [--after-id <uuid>]
// On a read replica use --batch-size 2000: bigger slices get cancelled by replay conflicts. A cancelled
// verify resumes with --after-id <lastId from the last [MESSAGE_TIMELINE_VERIFY_PROGRESS] line>.
// The final [MESSAGE_TIMELINE_VERIFY] line is the switch gate evidence: both
// counts must be 0, measured after the backfill finished.
//
// --search-vector (0658): fill message_server_timeline.search_vector instead
// (keyset on the timeline, --after-id resumes it), then verify every row's
// vector equals its message's ([MESSAGE_TIMELINE_VECTOR_VERIFY], with
// --verify-only --after-id resuming a cancelled verify). With --build-index and
// a 0-divergence verify, it then builds idx_message_server_timeline_server_search
// CONCURRENTLY (search_server_gin_v0's gate: verify 0 + index valid). Before
// each batch it reads the CDC slot slock_dist_cdc_slot: over 64 MB of retained
// WAL it waits until under 32 MB; over 250 MB (or wal_status not reserved) it
// stops with exit 3 and prints the --after-id to resume from.
//   DATABASE_URL=... node --import @oxc-node/core/register scripts/message-server-timeline-backfill.ts \
//     --search-vector [--batch-size 2000] [--sleep-ms 200] [--after-id <uuid>] [--verify-only] [--build-index]
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, type SQL } from "drizzle-orm";
import pg from "pg";
import {
  buildMessageServerTimelineSearchIndex,
  runMessageServerTimelineBackfill,
  runMessageServerTimelineSearchVectorBackfill,
  verifyMessageServerTimeline,
  verifyMessageServerTimelineSearchVector,
} from "../src/services/messageServerTimelineBackfill";

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function intFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(`[MESSAGE_TIMELINE_BACKFILL_FAILED] invalid ${name}: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[MESSAGE_TIMELINE_BACKFILL_FAILED] DATABASE_URL is not set");
    process.exitCode = 1;
    return;
  }
  const afterId = flag("--after-id");
  if (afterId !== undefined && !/^[0-9a-f-]{36}$/.test(afterId)) {
    console.error(`[MESSAGE_TIMELINE_BACKFILL_FAILED] invalid --after-id: ${afterId}`);
    process.exitCode = 1;
    return;
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    application_name: "message-server-timeline-backfill",
    statement_timeout: intFlag("--statement-timeout-ms", 30_000),
    lock_timeout: intFlag("--lock-timeout-ms", 2_000),
  });
  const db = drizzle(pool);
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  try {
    if (process.argv.includes("--search-vector")) {
      const verifyOnly = process.argv.includes("--verify-only");
      if (!verifyOnly) {
        const result = await runMessageServerTimelineSearchVectorBackfill(run, {
          batchSize: intFlag("--batch-size", 2000),
          sleepMs: intFlag("--sleep-ms", 200),
          afterId,
          log: (line) => console.log(line),
        });
        console.log(`[MESSAGE_TIMELINE_VECTOR_BACKFILL_REPORT] ${JSON.stringify(result)}`);
        if (result.stoppedBy) {
          // Not filled to the end: a verify now would only report the gap.
          console.error(`[MESSAGE_TIMELINE_VECTOR_BACKFILL] stopped by the CDC slot; resume with --after-id ${result.lastId}`);
          process.exitCode = 3;
          return;
        }
      }
      const divergence = await verifyMessageServerTimelineSearchVector(run, {
        batchSize: intFlag("--batch-size", 2000),
        afterId: verifyOnly ? afterId : undefined,
        log: (line) => console.log(line),
      });
      console.log(`[MESSAGE_TIMELINE_VECTOR_VERIFY] ${JSON.stringify(divergence)}`);
      if (divergence.divergentRows !== 0) {
        process.exitCode = 2;
        return;
      }
      if (process.argv.includes("--build-index")) {
        // A concurrent build outlives any per-statement limit.
        await run(sql`SET statement_timeout = 0`);
        await buildMessageServerTimelineSearchIndex(run, (line) => console.log(line));
      }
      return;
    }
    if (!process.argv.includes("--verify-only")) {
      const result = await runMessageServerTimelineBackfill(run, {
        batchSize: intFlag("--batch-size", 5000),
        sleepMs: intFlag("--sleep-ms", 200),
        afterId,
        log: (line) => console.log(line),
      });
      console.log(`[MESSAGE_TIMELINE_BACKFILL_REPORT] ${JSON.stringify(result)}`);
    }
    // --batch-size also sizes the verify slices: the default 20k-row slice on the
    // read replica gets cancelled by hot-standby replay (conflict with recovery).
    // With --verify-only, --after-id resumes the verify from that message id (one
    // progress line per slice says where to resume); after a backfill it starts from 0.
    const verifyAfterId = process.argv.includes("--verify-only") ? afterId : undefined;
    const divergence = await verifyMessageServerTimeline(run, {
      batchSize: intFlag("--batch-size", 20_000),
      afterId: verifyAfterId,
      log: (line) => console.log(line),
    });
    if (verifyAfterId) console.log(`[MESSAGE_TIMELINE_VERIFY_PARTIAL] counts cover messages after ${verifyAfterId} only`);
    console.log(`[MESSAGE_TIMELINE_VERIFY] ${JSON.stringify(divergence)}`);
    if (divergence.missingRows !== 0 || divergence.divergentRows !== 0) process.exitCode = 2;
  } catch (err) {
    // Drizzle wraps the driver error; its cause carries the Postgres reason.
    const cause = err instanceof Error && err.cause instanceof Error ? ` cause: ${err.cause.message}` : "";
    const message = (err instanceof Error ? err.message : String(err)) + cause;
    console.error(`[MESSAGE_TIMELINE_BACKFILL_FAILED] ${message.replaceAll("\n", " ")}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

void main();
