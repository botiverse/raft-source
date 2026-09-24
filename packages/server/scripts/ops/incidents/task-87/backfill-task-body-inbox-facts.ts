#!/usr/bin/env tsx
import { and, inArray, isNotNull, or } from "drizzle-orm";

import { closeDatabase, getDb, initDatabase } from "../../../../src/db/index.js";
import { messages } from "../../../../src/db/schema.js";
import { recordInboxFactsForPersistedMessages } from "../../../../src/services/messageService.js";

const DEFAULT_TASK87_SEQS = [8032710, 8032711, 8032734, 8032735];

type CliOptions = {
  commit: boolean;
  seqs: number[];
  messageIds: string[];
};

function usage() {
  console.error([
    "Usage:",
    "  DATABASE_URL=... tsx scripts/ops/incidents/task-87/backfill-task-body-inbox-facts.ts [--commit] [--seq <n> ...] [--message-id <uuid> ...]",
    "",
    "Defaults:",
    `  Without --seq/--message-id, targets task #87 known missed seqs: ${DEFAULT_TASK87_SEQS.join(", ")}`,
    "",
    "Safety:",
    "  Dry-run by default. Pass --commit to record inbox facts.",
  ].join("\n"));
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { commit: false, seqs: [], messageIds: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--commit") {
      opts.commit = true;
      continue;
    }
    if (arg === "--seq" && argv[i + 1]) {
      const seq = Number(argv[++i]);
      if (!Number.isInteger(seq) || seq <= 0) throw new Error(`Invalid --seq value: ${argv[i]}`);
      opts.seqs.push(seq);
      continue;
    }
    if (arg === "--message-id" && argv[i + 1]) {
      opts.messageIds.push(argv[++i]);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.seqs.length === 0 && opts.messageIds.length === 0) {
    opts.seqs = [...DEFAULT_TASK87_SEQS];
  }
  return opts;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const opts = parseArgs(process.argv.slice(2));
  await initDatabase(databaseUrl, process.env.SEARCH_DATABASE_URL);
  try {
    const db = getDb();
    const seqFilter = opts.seqs.length > 0 ? inArray(messages.seq, opts.seqs) : undefined;
    const messageIdFilter = opts.messageIds.length > 0 ? inArray(messages.id, opts.messageIds) : undefined;
    const targetFilter = seqFilter && messageIdFilter
      ? or(seqFilter, messageIdFilter)
      : seqFilter ?? messageIdFilter ?? inArray(messages.seq, []);
    const rows = await db
      .select()
      .from(messages)
      .where(and(
        targetFilter,
        isNotNull(messages.taskNumber),
      ));

    const requested = { seqs: opts.seqs, messageIds: opts.messageIds };
    console.log(JSON.stringify({
      mode: opts.commit ? "commit" : "dry-run",
      requested,
      matchedRows: rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        channelId: row.channelId,
        senderType: row.senderType,
        senderId: row.senderId,
        messageType: row.messageType,
        taskNumber: row.taskNumber,
      })),
    }, null, 2));

    if (!opts.commit) {
      console.log("Dry-run only. Re-run with --commit to record inbox facts.");
      return;
    }

    const factCount = await recordInboxFactsForPersistedMessages(rows, {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.body",
        reason: "backfill task-body inbox facts for messages persisted before the boundary hook",
      },
    });
    console.log(JSON.stringify({ committedRows: rows.length, factCount }, null, 2));
  } finally {
    await closeDatabase();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
