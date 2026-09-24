#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "../src/db/schema.js";

type CliOptions = {
  batchSize: number;
  limit: number | null;
  dryRun: boolean;
  serverId?: string;
};

type MessageCandidate = {
  id: string;
  seq: number;
  content: string;
  channelId: string;
  serverId: string;
  channelType: "channel" | "private" | "dm" | "thread";
  parentMessageId: string | null;
};

type MentionCandidate = {
  targetType: "user" | "agent";
  targetId: string;
  name: string;
};

type MentionRow = {
  id: string;
  messageId: string;
  messageSeq: number;
  serverId: string;
  channelId: string;
  targetType: "user" | "agent";
  targetId: string;
  handleAtSendTime: string;
  source: "backfill";
  confidence: "backfill";
};

type Scope = {
  scopeType: "channel" | "private" | "dm";
  scopeChannelId: string;
};

type Stats = {
  scannedMessages: number;
  messagesWithHandles: number;
  resolvedRows: number;
  insertedRows: number;
};

const MENTION_RE = /@([\p{L}\p{N}_-]+)/gu;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    batchSize: 500,
    limit: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--batch-size" && argv[i + 1]) {
      options.batchSize = Math.max(1, Number(argv[++i]) || 500);
      continue;
    }
    if (arg === "--limit" && argv[i + 1]) {
      options.limit = Math.max(1, Number(argv[++i]) || 1);
      continue;
    }
    if (arg === "--server-id" && argv[i + 1]) {
      options.serverId = argv[++i];
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  console.error(
    [
      "Usage:",
      "  DATABASE_URL=... tsx scripts/backfill-message-mentions.ts [--batch-size 500] [--limit 5000] [--server-id <uuid>] [--dry-run]",
      "",
      "Options:",
      "  --batch-size <n>  Number of candidate messages per batch (default: 500)",
      "  --limit <n>       Max number of candidate messages to scan before exiting",
      "  --server-id <id>  Restrict backfill to a single server",
      "  --dry-run         Resolve and print sample rows without writing",
      "",
      "Notes:",
      "  - Backfills direct @handle mentions only.",
      "  - Rows are inserted with source='backfill' and confidence='backfill'.",
      "  - Inserts are idempotent via (message_id, target_type, target_id).",
    ].join("\n"),
  );
}

function extractRawHandles(content: string) {
  const rawByLower = new Map<string, string>();
  for (const match of content.matchAll(MENTION_RE)) {
    const raw = match[1];
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (!rawByLower.has(lower)) rawByLower.set(lower, raw);
  }
  return rawByLower;
}

function buildServerScopeWhere(serverId?: string) {
  return serverId ? sql`AND c.server_id = ${serverId}` : sql``;
}

async function countCandidateMessages(
  db: ReturnType<typeof drizzle<typeof schema>>,
  serverId?: string,
) {
  const rows = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM messages m
    INNER JOIN channels c ON c.id = m.channel_id
    WHERE m.content LIKE '%@%'
      ${buildServerScopeWhere(serverId)}
  `);
  return Number(rows.rows[0]?.count ?? "0");
}

async function selectBatch(
  db: ReturnType<typeof drizzle<typeof schema>>,
  batchSize: number,
  cursor: { seq: number; id: string } | null,
  serverId?: string,
) {
  const cursorWhere = cursor
    ? sql`AND (m.seq > ${cursor.seq} OR (m.seq = ${cursor.seq} AND m.id > ${cursor.id}::uuid))`
    : sql``;
  const rows = await db.execute<{
    id: string;
    seq: number | string;
    content: string;
    channel_id: string;
    server_id: string;
    channel_type: MessageCandidate["channelType"];
    parent_message_id: string | null;
  }>(sql`
    SELECT
      m.id,
      m.seq,
      m.content,
      m.channel_id,
      c.server_id,
      c.type AS channel_type,
      c.parent_message_id
    FROM messages m
    INNER JOIN channels c ON c.id = m.channel_id
    WHERE m.content LIKE '%@%'
      ${buildServerScopeWhere(serverId)}
      ${cursorWhere}
    ORDER BY m.seq ASC, m.id ASC
    LIMIT ${batchSize}
  `);

  return rows.rows.map((row) => ({
    id: row.id,
    seq: typeof row.seq === "number" ? row.seq : Number(row.seq),
    content: row.content,
    channelId: row.channel_id,
    serverId: row.server_id,
    channelType: row.channel_type,
    parentMessageId: row.parent_message_id,
  }));
}

async function resolveScope(
  db: ReturnType<typeof drizzle<typeof schema>>,
  message: MessageCandidate,
  scopeCache: Map<string, Scope | null>,
): Promise<Scope | null> {
  if (message.channelType !== "thread") {
    return { scopeChannelId: message.channelId, scopeType: message.channelType };
  }

  const cached = scopeCache.get(message.channelId);
  if (cached !== undefined) return cached;

  if (!message.parentMessageId) {
    scopeCache.set(message.channelId, null);
    return null;
  }

  const rows = await db.execute<{
    channel_id: string;
    channel_type: Scope["scopeType"];
  }>(sql`
    SELECT pc.id AS channel_id, pc.type AS channel_type
    FROM messages pm
    INNER JOIN channels pc ON pc.id = pm.channel_id
    WHERE pm.id = ${message.parentMessageId}::uuid
    LIMIT 1
  `);
  const row = rows.rows[0];
  if (!row) {
    scopeCache.set(message.channelId, null);
    return null;
  }

  const scope = { scopeChannelId: row.channel_id, scopeType: row.channel_type };
  scopeCache.set(message.channelId, scope);
  return scope;
}

async function loadServerCandidates(
  db: ReturnType<typeof drizzle<typeof schema>>,
  serverId: string,
) {
  const [humans, agents] = await Promise.all([
    db.execute<{ id: string; name: string }>(sql`
      SELECT u.id, u.name
      FROM server_members sm
      INNER JOIN users u ON u.id = sm.user_id
      WHERE sm.server_id = ${serverId}::uuid
    `),
    db.execute<{ id: string; name: string }>(sql`
      SELECT id, name
      FROM agents
      WHERE server_id = ${serverId}::uuid
        AND deleted_at IS NULL
    `),
  ]);

  return [
    ...humans.rows.map((row) => ({ targetType: "user" as const, targetId: row.id, name: row.name })),
    ...agents.rows.map((row) => ({ targetType: "agent" as const, targetId: row.id, name: row.name })),
  ];
}

async function loadChannelCandidates(
  db: ReturnType<typeof drizzle<typeof schema>>,
  channelId: string,
) {
  const [humans, agents] = await Promise.all([
    db.execute<{ id: string; name: string }>(sql`
      SELECT u.id, u.name
      FROM channel_humans ch
      INNER JOIN users u ON u.id = ch.user_id
      WHERE ch.channel_id = ${channelId}::uuid
    `),
    db.execute<{ id: string; name: string }>(sql`
      SELECT a.id, a.name
      FROM channel_agents ca
      INNER JOIN agents a ON a.id = ca.agent_id
      WHERE ca.channel_id = ${channelId}::uuid
        AND a.deleted_at IS NULL
    `),
  ]);

  return [
    ...humans.rows.map((row) => ({ targetType: "user" as const, targetId: row.id, name: row.name })),
    ...agents.rows.map((row) => ({ targetType: "agent" as const, targetId: row.id, name: row.name })),
  ];
}

async function loadCandidates(
  db: ReturnType<typeof drizzle<typeof schema>>,
  message: MessageCandidate,
  scope: Scope,
  candidateCache: Map<string, MentionCandidate[]>,
) {
  const cacheKey = scope.scopeType === "channel"
    ? `server:${message.serverId}`
    : `channel:${scope.scopeChannelId}`;
  const cached = candidateCache.get(cacheKey);
  if (cached) return cached;

  const candidates = scope.scopeType === "channel"
    ? await loadServerCandidates(db, message.serverId)
    : await loadChannelCandidates(db, scope.scopeChannelId);
  candidateCache.set(cacheKey, candidates);
  return candidates;
}

function resolveMentionRows(
  message: MessageCandidate,
  rawByLower: Map<string, string>,
  candidates: MentionCandidate[],
) {
  const rows: MentionRow[] = [];
  const seen = new Set<string>();
  const candidatesByLower = new Map<string, MentionCandidate[]>();

  for (const candidate of candidates) {
    const key = candidate.name.toLowerCase();
    const bucket = candidatesByLower.get(key);
    if (bucket) {
      bucket.push(candidate);
    } else {
      candidatesByLower.set(key, [candidate]);
    }
  }

  for (const [lower, rawHandle] of rawByLower) {
    for (const candidate of candidatesByLower.get(lower) ?? []) {
      const key = `${candidate.targetType}:${candidate.targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        id: randomUUID(),
        messageId: message.id,
        messageSeq: message.seq,
        serverId: message.serverId,
        channelId: message.channelId,
        targetType: candidate.targetType,
        targetId: candidate.targetId,
        handleAtSendTime: rawHandle,
        source: "backfill",
        confidence: "backfill",
      });
    }
  }

  return rows;
}

async function insertMentionRows(
  db: ReturnType<typeof drizzle<typeof schema>>,
  rows: MentionRow[],
) {
  if (rows.length === 0) return 0;
  const values = rows.map((row) => sql`(
    ${row.id}::uuid,
    ${row.messageId}::uuid,
    ${row.messageSeq},
    ${row.serverId}::uuid,
    ${row.channelId}::uuid,
    ${row.targetType},
    ${row.targetId}::uuid,
    ${row.handleAtSendTime},
    ${row.source},
    ${row.confidence}
  )`);
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO message_mentions (
      id,
      message_id,
      message_seq,
      server_id,
      channel_id,
      target_type,
      target_id,
      handle_at_send_time,
      source,
      confidence
    )
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (message_id, target_type, target_id) DO NOTHING
    RETURNING id
  `);
  return result.rows.length;
}

async function resolveBatch(
  db: ReturnType<typeof drizzle<typeof schema>>,
  messages: MessageCandidate[],
) {
  const scopeCache = new Map<string, Scope | null>();
  const candidateCache = new Map<string, MentionCandidate[]>();
  const rows: MentionRow[] = [];
  let messagesWithHandles = 0;

  for (const message of messages) {
    const rawByLower = extractRawHandles(message.content);
    if (rawByLower.size === 0) continue;
    messagesWithHandles += 1;

    const scope = await resolveScope(db, message, scopeCache);
    if (!scope) continue;

    const candidates = await loadCandidates(db, message, scope, candidateCache);
    rows.push(...resolveMentionRows(message, rawByLower, candidates));
  }

  return { rows, messagesWithHandles };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    usage();
    throw new Error("DATABASE_URL is required");
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  const db = drizzle(pool, { schema });
  const stats: Stats = {
    scannedMessages: 0,
    messagesWithHandles: 0,
    resolvedRows: 0,
    insertedRows: 0,
  };

  try {
    const candidates = await countCandidateMessages(db, options.serverId);
    console.error(`Candidate messages containing @handles: ${candidates}`);
    if (candidates === 0) return;

    let cursor: { seq: number; id: string } | null = null;
    while (true) {
      const remaining = options.limit == null
        ? options.batchSize
        : Math.min(options.batchSize, options.limit - stats.scannedMessages);
      if (remaining <= 0) break;

      const batch = await selectBatch(db, remaining, cursor, options.serverId);
      if (batch.length === 0) break;

      const { rows, messagesWithHandles } = await resolveBatch(db, batch);
      stats.scannedMessages += batch.length;
      stats.messagesWithHandles += messagesWithHandles;
      stats.resolvedRows += rows.length;

      const last = batch[batch.length - 1]!;
      cursor = { seq: last.seq, id: last.id };

      if (options.dryRun) {
        const sample = rows.slice(0, 10);
        if (sample.length > 0) {
          console.error("Dry run sample rows:");
          for (const row of sample) {
            console.error(
              `  seq=${row.messageSeq} message=${row.messageId} channel=${row.channelId} ${row.targetType}:${row.targetId} @${row.handleAtSendTime}`,
            );
          }
        }
        console.error(
          `Dry run scanned ${stats.scannedMessages} messages; resolved ${stats.resolvedRows} mention rows (last seq=${last.seq}).`,
        );
      } else {
        const inserted = await insertMentionRows(db, rows);
        stats.insertedRows += inserted;
        console.error(
          `Scanned ${stats.scannedMessages} messages; resolved ${stats.resolvedRows} rows; inserted ${stats.insertedRows} rows (last seq=${last.seq}).`,
        );
      }

      if (options.limit != null && stats.scannedMessages >= options.limit) break;
    }

    console.error(
      [
        "Done.",
        `scanned_messages=${stats.scannedMessages}`,
        `messages_with_handles=${stats.messagesWithHandles}`,
        `resolved_rows=${stats.resolvedRows}`,
        `inserted_rows=${options.dryRun ? "dry-run" : stats.insertedRows}`,
      ].join(" "),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
