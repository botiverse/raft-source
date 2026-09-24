#!/usr/bin/env tsx
/**
 * Best-effort one-off backfill for daemons.computer_version.
 *
 * Candidate precedence:
 *   1. Live Redis machineMeta computerVersion (reportedAt = this run).
 *   2. Latest terminal lifecycle operation loadedComputerVersion.
 *
 * Existing DB values are never overwritten. Machines that have neither
 * source remain NULL. The script defaults to dry-run; pass --apply to write.
 */
import pg from "pg";
import Redis from "ioredis";

type Options = {
  apply: boolean;
  limit: number | null;
};

type CandidateRow = {
  machineId: string;
  lifecycleVersion: string | null;
  lifecycleReportedAt: Date | string | null;
};

function usage(exitCode: number): never {
  console.error(`Usage:
  DATABASE_URL=... REDIS_URL=... pnpm --filter @botiverse/raft-server machines:backfill-computer-versions -- [--apply] [--limit <n>]

Defaults to dry-run. Existing computer_version values are never overwritten.
REDIS_URL is optional; without it the script falls back to terminal lifecycle evidence.`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Options {
  if (argv[0] === "--") argv = argv.slice(1);
  const options: Options = { apply: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error("--limit must be a positive integer");
      options.limit = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") usage(0);
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function normalizeVersion(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) usage(1);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  let redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
    : null;
  const runAt = new Date();
  const stats = {
    scanned: 0,
    redisCandidates: 0,
    lifecycleCandidates: 0,
    noCandidate: 0,
    wouldWrite: 0,
    written: 0,
    writeRaces: 0,
    redisErrors: 0,
    errors: 0,
  };

  try {
    if (redis) {
      try {
        await redis.connect();
      } catch (error) {
        stats.redisErrors += 1;
        console.error(`redis_unavailable error=${error instanceof Error ? error.name : typeof error}; using lifecycle evidence only`);
        redis.disconnect();
        redis = null;
      }
    }
    const result = await pool.query<CandidateRow>(`
      SELECT
        d.id::text AS "machineId",
        latest.loaded_computer_version AS "lifecycleVersion",
        COALESCE(latest.terminal_at, latest.ready_ack_at, latest.created_at) AS "lifecycleReportedAt"
      FROM daemons d
      LEFT JOIN LATERAL (
        SELECT
          clo.loaded_computer_version,
          clo.terminal_at,
          clo.ready_ack_at,
          clo.created_at
        FROM computer_lifecycle_operations clo
        WHERE clo.machine_id = d.id
          AND clo.terminal_at IS NOT NULL
          AND NULLIF(BTRIM(clo.loaded_computer_version), '') IS NOT NULL
        ORDER BY clo.terminal_at DESC, clo.created_at DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE d.computer_version IS NULL
      ORDER BY d.id
      LIMIT $1
    `, [options.limit]);

    for (const row of result.rows) {
      stats.scanned += 1;
      try {
        let redisVersion: string | null = null;
        if (redis) {
          try {
            redisVersion = normalizeVersion(
              await redis.hget(`slock:machine:${row.machineId}:meta`, "computerVersion"),
            );
          } catch (error) {
            stats.redisErrors += 1;
            console.error(`machine=${row.machineId} redis_error=${error instanceof Error ? error.name : typeof error}; using lifecycle evidence`);
          }
        }
        const lifecycleVersion = normalizeVersion(row.lifecycleVersion);
        const version = redisVersion ?? lifecycleVersion;
        if (!version) {
          stats.noCandidate += 1;
          continue;
        }

        const reportedAt = redisVersion
          ? runAt
          : new Date(row.lifecycleReportedAt ?? runAt);
        if (redisVersion) stats.redisCandidates += 1;
        else stats.lifecycleCandidates += 1;
        stats.wouldWrite += 1;

        if (!options.apply) continue;
        const write = await pool.query(
          `UPDATE daemons
             SET computer_version = $1,
                 computer_version_reported_at = $2
           WHERE id = $3
             AND computer_version IS NULL`,
          [version, reportedAt, row.machineId],
        );
        if (write.rowCount === 1) stats.written += 1;
        else stats.writeRaces += 1;
      } catch (error) {
        stats.errors += 1;
        console.error(`machine=${row.machineId} error=${error instanceof Error ? error.name : typeof error}`);
      }
    }

    console.log(JSON.stringify({ mode: options.apply ? "apply" : "dry-run", ...stats }, null, 2));
    if (stats.errors > 0) process.exitCode = 2;
  } finally {
    redis?.disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
