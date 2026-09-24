// RFC 057 Phase B operator entrypoint. NEVER scheduled; run manually under the
// gate-B authorization only. Refuses unless the phase ledger reads 'backfilling'
// (advancing the ledger is itself part of gate B, via the plain transition
// function run under the migration/operator identity that owns it).
//
// Usage: DATABASE_URL=... tsx scripts/read-cursor-widen-backfill.ts [--batch-size N] [--sleep-ms N]
// Output: deterministic plain text; the final REPORT line is the gate evidence
// (phase, epoch, per-table counts, convergence with LSN/timestamps).
import "dotenv/config";
import pg from "pg";
import { runReadCursorWidenBackfill } from "../src/services/readCursorWidenBackfill.js";

function intFlag(name: string, fallback: number): number {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const raw = process.argv[idx + 1];
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`[WIDEN_BACKFILL_FAILED] invalid ${name}: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[WIDEN_BACKFILL_FAILED] DATABASE_URL is not set");
    process.exitCode = 1;
    return;
  }
  const batchSize = intFlag("--batch-size", 1000);
  const sleepMs = intFlag("--sleep-ms", 50);
  const pool = new pg.Pool({ connectionString: url, max: 1, application_name: "rfc057-widen-backfill" });
  try {
    const report = await runReadCursorWidenBackfill(pool, {
      batchSize,
      sleepMs,
      log: (line) => console.log(line),
    });
    console.log(`[WIDEN_BACKFILL_REPORT] ${JSON.stringify(report)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[WIDEN_BACKFILL_FAILED] ${message.replaceAll("\n", " ")}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

void main();
