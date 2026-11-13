#!/usr/bin/env -S node --import=@oxc-node/core/register
// Operator entrypoint for attachment_object_holds (platform file storage 2a).
// NEVER scheduled. Prints one JSON record per line on stdout.
//
//   reconcile   read-only: does every linked, non-revoked attachment and every
//               pending reservation of an active object have its hold, and is
//               every hold still backed by its holder (no stale hold)? Exits 3
//               when a must-be-zero count is not zero. Run before and after.
//   backfill    writes the missing holds and unheld_since and removes stale
//               holds (a reservation no longer pending, an attachment no
//               longer linked or gone, any hold on a non-active object), in
//               batches of --batch-size objects (by id), one transaction each
//               with lock_timeout/statement_timeout; idempotent. Resume with
//               --cursor <last lastObjectId printed>, or keep the cursor in
//               --cursor-file (read at start, rewritten after every batch).
//               Always runs against DATABASE_URL (the primary).
//   report      read-only "would collect" record: active objects without a
//               hold for at least --grace-days (default 30). Deletes, marks and
//               moves nothing. Exits 3 when a candidate is still referenced.
//
// reconcile and report are full scans. They run in one REPEATABLE READ, READ
// ONLY transaction with --statement-timeout-ms per query (default 120000), on
// --database-url if given, else DATABASE_URL_READ_REPLICA if set, else
// DATABASE_URL; the output's `database` field says which. Prefer the replica
// env over --database-url (a URL on the command line shows in `ps`). A replica
// lags the primary: right after a backfill, re-run reconcile until it settles
// or run it on the primary.
//
// Production backfill (operational gate, do not skip):
//   1. Confirm every server instance runs this release (the hold writers).
//      An instance on the previous release links, consumes and revokes
//      without touching holds; a backfill during the rollout is undone by it.
//   2. Run reconcile and report and post their output, plus the expected
//      read/write volume (objects to scan, holds to insert and to remove from
//      the reconcile counts), in the rollout thread.
//   3. Get a HUMAN's explicit approval in that thread before running
//      `backfill`. An agent's GO is not approval for this step.
//   4. Run backfill (start with --max-batches to watch the first batches),
//      then reconcile again and post the result; it must exit 0.
//
// Usage:
//   DATABASE_URL=... pnpm --filter @botiverse/raft-server db:attachment-object-holds reconcile \
//     [--sample 10] [--statement-timeout-ms 120000] [--database-url <url>]
//   DATABASE_URL=... pnpm --filter @botiverse/raft-server db:attachment-object-holds backfill \
//     [--batch-size 500] [--cursor <uuid> | --cursor-file <path>] [--max-batches <n>] [--sleep-ms 100] \
//     [--lock-timeout-ms 2000] [--statement-timeout-ms 30000] [--pause-file <path>] [--stop-at <ISO-8601>]
//   DATABASE_URL=... pnpm --filter @botiverse/raft-server db:attachment-object-holds report \
//     [--grace-days 30] [--sample 20] [--statement-timeout-ms 120000] [--database-url <url>]
import "dotenv/config";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setClockTimeout } from "@botiverse/raft-shared";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Database } from "../src/db/index";
import * as schema from "../src/db/schema";
import {
  ATTACHMENT_OBJECT_HOLD_GRACE_DAYS,
  ATTACHMENT_OBJECT_HOLD_READ_STATEMENT_TIMEOUT_MS,
  reconcileAttachmentObjectHolds,
  reportCollectableAttachmentObjects,
  runAttachmentObjectHoldBackfill,
} from "../src/services/attachmentObjectHoldBackfillService";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ReadOnlyOptions = Readonly<{ statementTimeoutMs: number; databaseUrl: string | null }>;

export type AttachmentObjectHoldsCommand =
  | Readonly<{ command: "reconcile"; sample: number } & ReadOnlyOptions>
  | Readonly<{ command: "report"; sample: number; graceDays: number } & ReadOnlyOptions>
  | Readonly<{
    command: "backfill";
    batchSize: number;
    cursor: string | null;
    cursorFile: string | null;
    maxBatches: number | null;
    sleepMs: number;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
    pauseFiles: string[];
    stopAt: number | null;
  }>;

function integer(name: string, raw: string | undefined, min: number, max: number): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function parseAttachmentObjectHoldsArgs(argv: string[]): AttachmentObjectHoldsCommand {
  const [command, ...rest] = argv;
  const values = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    const value = rest[index + 1];
    if (!flag.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
    values.set(flag, [...(values.get(flag) ?? []), value]);
    index += 1;
  }
  const allow = (flags: string[]) => {
    for (const flag of values.keys()) if (!flags.includes(flag)) throw new Error(`${flag} is not valid for ${command}`);
  };
  const one = (flag: string) => values.get(flag)?.at(-1);
  const readOnly = (): ReadOnlyOptions => {
    const databaseUrl = one("--database-url") ?? null;
    if (databaseUrl !== null && !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
      throw new Error("--database-url must be a postgres:// URL");
    }
    return {
      statementTimeoutMs: integer(
        "--statement-timeout-ms",
        one("--statement-timeout-ms") ?? String(ATTACHMENT_OBJECT_HOLD_READ_STATEMENT_TIMEOUT_MS),
        1_000,
        3_600_000,
      ),
      databaseUrl,
    };
  };
  if (command === "reconcile") {
    allow(["--sample", "--statement-timeout-ms", "--database-url"]);
    return { command, sample: integer("--sample", one("--sample") ?? "10", 0, 100), ...readOnly() };
  }
  if (command === "report") {
    allow(["--sample", "--grace-days", "--statement-timeout-ms", "--database-url"]);
    return {
      command,
      sample: integer("--sample", one("--sample") ?? "20", 0, 100),
      graceDays: integer("--grace-days", one("--grace-days") ?? String(ATTACHMENT_OBJECT_HOLD_GRACE_DAYS), 0, 3650),
      ...readOnly(),
    };
  }
  if (command === "backfill") {
    allow([
      "--batch-size", "--cursor", "--cursor-file", "--max-batches", "--sleep-ms",
      "--lock-timeout-ms", "--statement-timeout-ms", "--pause-file", "--stop-at",
    ]);
    const cursor = one("--cursor") ?? null;
    if (cursor !== null && !UUID_RE.test(cursor)) throw new Error("--cursor must be an attachment object id");
    const cursorFile = one("--cursor-file") ?? null;
    if (cursor !== null && cursorFile !== null) throw new Error("Pass --cursor or --cursor-file, not both");
    const stopAtRaw = one("--stop-at");
    const stopAt = stopAtRaw === undefined ? null : Date.parse(stopAtRaw);
    if (stopAt !== null && Number.isNaN(stopAt)) throw new Error("--stop-at must be an ISO-8601 time");
    const maxBatches = one("--max-batches");
    return {
      command,
      batchSize: integer("--batch-size", one("--batch-size") ?? "500", 1, 5_000),
      cursor,
      cursorFile,
      maxBatches: maxBatches === undefined ? null : integer("--max-batches", maxBatches, 1, Number.MAX_SAFE_INTEGER),
      sleepMs: integer("--sleep-ms", one("--sleep-ms") ?? "100", 0, 60_000),
      lockTimeoutMs: integer("--lock-timeout-ms", one("--lock-timeout-ms") ?? "2000", 100, 60_000),
      statementTimeoutMs: integer("--statement-timeout-ms", one("--statement-timeout-ms") ?? "30000", 1_000, 600_000),
      pauseFiles: values.get("--pause-file") ?? [],
      stopAt,
    };
  }
  throw new Error("Usage: attachment-object-holds.ts <reconcile|backfill|report> [options]");
}

function readCursorFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const cursor = readFileSync(path, "utf8").trim();
  if (cursor === "") return null;
  if (!UUID_RE.test(cursor)) throw new Error(`${path} does not hold an attachment object id`);
  return cursor;
}

function writeCursorFile(path: string, cursor: string): void {
  writeFileSync(`${path}.tmp`, `${cursor}\n`);
  renameSync(`${path}.tmp`, path);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setClockTimeout(resolve, ms));
const print = (record: Record<string, unknown>) => console.log(JSON.stringify(record));

export type AttachmentObjectHoldsDatabase = Readonly<{
  url: string;
  source: "--database-url" | "DATABASE_URL_READ_REPLICA" | "DATABASE_URL";
}>;

/** Backfill writes: primary only. Reads: flag, then the replica env, then the primary. */
export function resolveAttachmentObjectHoldsDatabase(
  options: AttachmentObjectHoldsCommand,
  env: Readonly<Record<string, string | undefined>>,
): AttachmentObjectHoldsDatabase {
  if (options.command !== "backfill") {
    if (options.databaseUrl) return { url: options.databaseUrl, source: "--database-url" };
    if (env.DATABASE_URL_READ_REPLICA) return { url: env.DATABASE_URL_READ_REPLICA, source: "DATABASE_URL_READ_REPLICA" };
  }
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return { url: env.DATABASE_URL, source: "DATABASE_URL" };
}

async function main(): Promise<number> {
  const options = parseAttachmentObjectHoldsArgs(process.argv.slice(2));
  const database = resolveAttachmentObjectHoldsDatabase(options, process.env);
  const pool = new pg.Pool({ connectionString: database.url, max: 1, application_name: "attachment-object-holds" });
  const db = drizzle(pool, { schema }) as unknown as Database;
  try {
    if (options.command === "reconcile") {
      const result = await reconcileAttachmentObjectHolds(db, {
        sampleSize: options.sample,
        statementTimeoutMs: options.statementTimeoutMs,
      });
      print({ event: "attachment_object_holds.reconcile", database: database.source, ...result });
      return result.ok ? 0 : 3;
    }
    if (options.command === "report") {
      const result = await reportCollectableAttachmentObjects(db, {
        graceDays: options.graceDays,
        sampleSize: options.sample,
        statementTimeoutMs: options.statementTimeoutMs,
      });
      print({ event: "attachment_object_holds.report", database: database.source, ...result });
      return result.stillReferenced.count === 0 ? 0 : 3;
    }
    const cursor = options.cursorFile ? readCursorFile(options.cursorFile) : options.cursor;
    const result = await runAttachmentObjectHoldBackfill({
      db,
      cursor,
      batchSize: options.batchSize,
      maxBatches: options.maxBatches ?? undefined,
      sleepMs: options.sleepMs,
      sleep,
      lockTimeoutMs: options.lockTimeoutMs,
      statementTimeoutMs: options.statementTimeoutMs,
      beforeBatch: async () => {
        for (;;) {
          if (options.stopAt !== null && Date.now() >= options.stopAt) return "stop";
          if (!options.pauseFiles.some((file) => existsSync(file))) return "continue";
          await sleep(5_000);
        }
      },
      onBatch: async (batch) => {
        if (options.cursorFile && batch.lastObjectId) writeCursorFile(options.cursorFile, batch.lastObjectId);
      },
      log: print,
    });
    print({ event: "attachment_object_holds.backfill.finished", ...result });
    return 0;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (error) => {
    // Drizzle wraps the driver error; the cause carries the PostgreSQL code
    // (57014 is statement_timeout: raise --statement-timeout-ms or use a replica).
    const cause = error instanceof Error ? (error.cause as { message?: string; code?: string } | undefined) : undefined;
    console.error(error instanceof Error ? error.message : error);
    if (cause?.message) console.error(`cause: ${cause.message}${cause.code ? ` (${cause.code})` : ""}`);
    process.exit(1);
  });
}
