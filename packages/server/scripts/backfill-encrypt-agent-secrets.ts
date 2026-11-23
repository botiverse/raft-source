#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Idempotent batched backfill to encrypt plaintext customer secrets on `agents`
 * (#proj-runtime:#79):
 *   - `agents.runtime_config.provider.apiKey`
 *   - `agents.runtime_config.envVars` (every non-empty value; keys stay plaintext)
 *   - `agents.env_vars` (every non-empty value; keys stay plaintext)
 *
 * Walks EVERY row in `agents` (including soft-deleted rows, which may still
 * carry historical plaintext keys) in primary-key cursor order (`id > lastId`).
 * Each batch locks only the candidate rows `FOR UPDATE` inside a short
 * transaction (`lock_timeout = 2s`, `statement_timeout = 30s`), re-checks them
 * after locking so concurrent writes from live servers are never overwritten,
 * and updates ONLY `runtime_config` and `env_vars` (never bumping `updated_at`
 * or `config_revision`).
 *
 * Security invariants:
 *   - Requires explicit `SLOCK_PROVIDER_CREDENTIAL_KEY` (never falls back).
 *   - Never logs any secret value, env var content, or ciphertext.
 *   - Running in production requires release-owner approval (tygg).
 *
 * Usage (defaults to --dry-run):
 *   DATABASE_URL=... SLOCK_PROVIDER_CREDENTIAL_KEY=... \
 *     pnpm --filter @botiverse/raft-server db:backfill-encrypt-agent-secrets [--dry-run]
 *   DATABASE_URL=... SLOCK_PROVIDER_CREDENTIAL_KEY=... \
 *     pnpm --filter @botiverse/raft-server db:backfill-encrypt-agent-secrets --apply \
 *     [--batch 100] [--sleep-ms 20] [--start-after <agent-id>] [--max-batches N] [--reseal]
 *   DATABASE_URL=... SLOCK_PROVIDER_CREDENTIAL_KEY=... \
 *     pnpm --filter @botiverse/raft-server db:backfill-encrypt-agent-secrets --verify
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { RuntimeConfig } from "@botiverse/raft-shared";
import { closeDatabase, getDb, initDatabase, type DatabaseExecutor } from "../src/db/index";
import { agents } from "../src/db/schema";
import { serializeErrorForLog } from "../src/tracing/safeErrorLog";
import {
  AGENT_SECRET_KEY_ENV,
  assertAgentSecretKeyConfigured,
  hasPlaintextAgentSecrets,
  hasRotatableAgentSecrets,
  openAgentEnvVars,
  openAgentRuntimeConfig,
  sealAgentEnvVars,
  sealAgentRuntimeConfig,
} from "../src/services/agentSecretCrypto";

export interface BackfillOptions {
  mode: "dry-run" | "apply" | "verify";
  batchSize: number;
  sleepMs: number;
  startAfter: string | null;
  maxBatches: number | null;
  reseal: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface BackfillSummary {
  mode: "dry-run" | "apply" | "verify";
  batches: number;
  rowsScanned: number;
  rowsNeedingEncryption: number;
  rowsNeedingReseal: number;
  rowsUpdated: number;
  rowsSkippedAlreadyEncrypted: number;
  remainingPlaintextRows: number | null;
  lastId: string | null;
  completedFullScan: boolean;
}

interface AgentSecretRow {
  id: string;
  runtimeConfig: RuntimeConfig | null;
  envVars: Record<string, string> | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseArgs(argv: readonly string[]): BackfillOptions {
  let mode: BackfillOptions["mode"] = "dry-run";
  let batchSize = 100;
  let sleepMs = 0;
  let startAfter: string | null = null;
  let maxBatches: number | null = null;
  let reseal = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // pnpm forwards a literal `--` separator to workspace scripts; accept both
    // `pnpm ... db:backfill-encrypt-agent-secrets --dry-run` and `-- --dry-run`.
    if (arg === "--") continue;
    if (arg === "--dry-run") mode = "dry-run";
    else if (arg === "--apply") mode = "apply";
    else if (arg === "--verify") mode = "verify";
    else if (arg === "--reseal") reseal = true;
    else if (arg === "--batch") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("--batch must be an integer between 1 and 1000");
      batchSize = n;
    } else if (arg === "--sleep-ms") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 60_000) throw new Error("--sleep-ms must be an integer between 0 and 60000");
      sleepMs = n;
    } else if (arg === "--start-after") {
      const id = argv[++i]?.trim();
      if (!id || !UUID_RE.test(id)) throw new Error("--start-after requires a valid agent UUID");
      startAfter = id;
    } else if (arg === "--max-batches") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("--max-batches must be a positive integer");
      maxBatches = n;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { mode, batchSize, sleepMs, startAfter, maxBatches, reseal };
}

function rowNeedsWork(row: AgentSecretRow, reseal: boolean, env: NodeJS.ProcessEnv): { plaintext: boolean; rotatable: boolean } {
  const plaintext = hasPlaintextAgentSecrets(row);
  const rotatable = reseal && hasRotatableAgentSecrets(row, env);
  return { plaintext, rotatable };
}

async function countRemainingPlaintextRows(
  db: DatabaseExecutor,
  batchSize: number,
  env: NodeJS.ProcessEnv,
): Promise<{ rowsScanned: number; remainingPlaintextRows: number }> {
  let cursor: string | null = null;
  let rowsScanned = 0;
  let remainingPlaintextRows = 0;

  while (true) {
    const query = db
      .select({
        id: agents.id,
        runtimeConfig: agents.runtimeConfig,
        envVars: agents.envVars,
      })
      .from(agents);
    const batch: AgentSecretRow[] = cursor
      ? await query.where(gt(agents.id, cursor)).orderBy(asc(agents.id)).limit(batchSize)
      : await query.orderBy(asc(agents.id)).limit(batchSize);

    if (batch.length === 0) break;
    rowsScanned += batch.length;
    for (const row of batch) {
      if (hasPlaintextAgentSecrets(row)) remainingPlaintextRows += 1;
      // Ensure every sealed value is actually decryptable under current/previous keys.
      if (row.runtimeConfig) openAgentRuntimeConfig(row.id, row.runtimeConfig, env);
      if (row.envVars) openAgentEnvVars(row.id, row.envVars, env);
    }
    cursor = batch[batch.length - 1]!.id;
  }

  return { rowsScanned, remainingPlaintextRows };
}

export async function runAgentSecretBackfill(
  db: DatabaseExecutor,
  options: BackfillOptions,
  log: (line: string) => void = (line) => console.log(line),
): Promise<BackfillSummary> {
  const baseEnv = options.env ?? process.env;
  if (!baseEnv[AGENT_SECRET_KEY_ENV]?.trim()) {
    throw new Error(`${AGENT_SECRET_KEY_ENV} must be explicitly set to run the agent secrets backfill`);
  }
  // Force strict production key policy for every crypto call in the backfill
  // (never consult JWT_SECRET or test fallback, even if .env sets JWT_SECRET).
  const env: NodeJS.ProcessEnv = { ...baseEnv, DEPLOYMENT_ENV: "production" };
  assertAgentSecretKeyConfigured(env);

  if (options.mode === "verify") {
    const verified = await countRemainingPlaintextRows(db, options.batchSize, env);
    log(
      `[AGENT_SECRET_BACKFILL_VERIFY] scanned=${verified.rowsScanned} remaining_plaintext=${verified.remainingPlaintextRows}`,
    );
    return {
      mode: "verify",
      batches: Math.ceil(verified.rowsScanned / options.batchSize),
      rowsScanned: verified.rowsScanned,
      rowsNeedingEncryption: verified.remainingPlaintextRows,
      rowsNeedingReseal: 0,
      rowsUpdated: 0,
      rowsSkippedAlreadyEncrypted: verified.rowsScanned - verified.remainingPlaintextRows,
      remainingPlaintextRows: verified.remainingPlaintextRows,
      lastId: null,
      completedFullScan: true,
    };
  }

  let cursor = options.startAfter;
  let batches = 0;
  let rowsScanned = 0;
  let rowsNeedingEncryption = 0;
  let rowsNeedingReseal = 0;
  let rowsUpdated = 0;
  let rowsSkippedAlreadyEncrypted = 0;
  let completedFullScan = false;

  while (true) {
    if (options.maxBatches !== null && batches >= options.maxBatches) break;

    const query = db
      .select({
        id: agents.id,
        runtimeConfig: agents.runtimeConfig,
        envVars: agents.envVars,
      })
      .from(agents);
    const batch: AgentSecretRow[] = cursor
      ? await query.where(gt(agents.id, cursor)).orderBy(asc(agents.id)).limit(options.batchSize)
      : await query.orderBy(asc(agents.id)).limit(options.batchSize);

    if (batch.length === 0) {
      completedFullScan = true;
      break;
    }

    batches += 1;
    rowsScanned += batch.length;
    const candidateIds: string[] = [];

    for (const row of batch) {
      const needs = rowNeedsWork(row, options.reseal, env);
      if (needs.plaintext) rowsNeedingEncryption += 1;
      if (needs.rotatable) rowsNeedingReseal += 1;
      if (needs.plaintext || needs.rotatable) {
        candidateIds.push(row.id);
      } else {
        rowsSkippedAlreadyEncrypted += 1;
      }
    }

    if (options.mode === "apply" && candidateIds.length > 0) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
        const lockedRows: AgentSecretRow[] = await tx
          .select({
            id: agents.id,
            runtimeConfig: agents.runtimeConfig,
            envVars: agents.envVars,
          })
          .from(agents)
          .where(inArray(agents.id, candidateIds))
          .orderBy(asc(agents.id))
          .for("update");

        for (const locked of lockedRows) {
          const needs = rowNeedsWork(locked, options.reseal, env);
          if (!needs.plaintext && !needs.rotatable) continue;

          // Open first (dual-read) so already-encrypted fields on partially
          // migrated rows are never double-encrypted, then seal cleanly under
          // the current key.
          const openedRc = openAgentRuntimeConfig(locked.id, locked.runtimeConfig, env);
          const openedEnv = openAgentEnvVars(locked.id, locked.envVars, env);
          const sealedRc = sealAgentRuntimeConfig(locked.id, openedRc, env);
          const sealedEnv = sealAgentEnvVars(locked.id, openedEnv, env);

          await tx
            .update(agents)
            .set({
              runtimeConfig: sealedRc,
              envVars: sealedEnv,
            })
            .where(eq(agents.id, locked.id));
          rowsUpdated += 1;
        }
      });
    }

    cursor = batch[batch.length - 1]!.id;
    log(
      `[AGENT_SECRET_BACKFILL_PROGRESS] mode=${options.mode} batch=${batches} scanned=${rowsScanned} need_encrypt=${rowsNeedingEncryption} need_reseal=${rowsNeedingReseal} updated=${rowsUpdated} skipped=${rowsSkippedAlreadyEncrypted} last_id=${cursor}`,
    );

    if (options.sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.sleepMs));
    }
  }

  let remainingPlaintextRows: number | null = null;
  if (options.mode === "apply" && completedFullScan && options.startAfter === null) {
    const verified = await countRemainingPlaintextRows(db, options.batchSize, env);
    remainingPlaintextRows = verified.remainingPlaintextRows;
  }

  log(
    `[AGENT_SECRET_BACKFILL_DONE] mode=${options.mode} batches=${batches} scanned=${rowsScanned} updated=${rowsUpdated} remaining_plaintext=${remainingPlaintextRows ?? "unverified"} full_scan=${completedFullScan}`,
  );

  return {
    mode: options.mode,
    batches,
    rowsScanned,
    rowsNeedingEncryption,
    rowsNeedingReseal,
    rowsUpdated,
    rowsSkippedAlreadyEncrypted,
    remainingPlaintextRows,
    lastId: cursor,
    completedFullScan,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  await initDatabase(databaseUrl);
  try {
    const summary = await runAgentSecretBackfill(getDb(), options);
    if (summary.remainingPlaintextRows !== null && summary.remainingPlaintextRows > 0) {
      process.exitCode = 1;
    }
  } finally {
    await closeDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error("[AGENT_SECRET_BACKFILL_ERROR]", serializeErrorForLog(err));
    process.exit(1);
  });
}
