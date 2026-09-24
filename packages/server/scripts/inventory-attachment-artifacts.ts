#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Database } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import {
  inspectAttachmentArtifactInventory,
  inventoryAttachmentArtifacts,
} from "../src/services/attachmentArtifactInventoryService.js";
import { getCdnStorage, getStorage } from "../src/services/storageService.js";

type Options = Readonly<{
  apply: boolean;
  acknowledgeProductionWrite: boolean;
  runId: string | null;
  sourceRevision: string | null;
  evidenceSource: string;
  serverId?: string;
  concurrency: number;
}>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAttachmentArtifactInventoryArgs(
  argv: string[],
  deploymentEnv = process.env.DEPLOYMENT_ENV,
): Options {
  let apply = false;
  let acknowledgeProductionWrite = false;
  let runId: string | null = null;
  let sourceRevision: string | null = null;
  let evidenceSource = "attachment-inventory-cli";
  let serverId: string | undefined;
  let concurrency = 16;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--acknowledge-production-write") acknowledgeProductionWrite = true;
    else if (arg === "--run-id" && argv[index + 1]) runId = argv[++index]!;
    else if (arg === "--source-revision" && argv[index + 1]) sourceRevision = argv[++index]!;
    else if (arg === "--evidence-source" && argv[index + 1]) evidenceSource = argv[++index]!;
    else if (arg === "--server-id" && argv[index + 1]) serverId = argv[++index]!;
    else if (arg === "--concurrency" && argv[index + 1]) concurrency = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (serverId !== undefined && !UUID_RE.test(serverId)) throw new Error("--server-id must be a canonical UUID");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new Error("--concurrency must be an integer between 1 and 64");
  }
  if (apply && !sourceRevision) throw new Error("--source-revision is required with --apply");
  if (apply && deploymentEnv === "production" && !acknowledgeProductionWrite) {
    throw new Error("--acknowledge-production-write is required with --apply in production");
  }
  if (runId !== null && !UUID_RE.test(runId)) throw new Error("--run-id must be a canonical UUID");
  return { apply, acknowledgeProductionWrite, runId, sourceRevision, evidenceSource, serverId, concurrency };
}

function printReport(report: object): void {
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const options = parseAttachmentArtifactInventoryArgs(process.argv.slice(2));
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  const db = drizzle(pool, { schema }) as unknown as Database;
  const common = {
    evidenceSource: options.evidenceSource,
    sourceRevision: options.sourceRevision ?? "dry-run",
    scopeServerId: options.serverId,
    concurrency: options.concurrency,
    attachmentStorage: getStorage(),
    cdnStorage: getCdnStorage(),
  };
  try {
    if (!options.apply) {
      printReport(await inspectAttachmentArtifactInventory(db, common));
      return;
    }
    printReport(await inventoryAttachmentArtifacts(db, {
      ...common,
      runId: options.runId ?? randomUUID(),
    }));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
