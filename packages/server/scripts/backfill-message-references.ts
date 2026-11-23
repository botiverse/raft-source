#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Fill core `object_references` for chat messages sent before a message's
 * links to first-party objects were stored (#proj-workspace:#336, step 2;
 * src/services/messageReferences.ts). For each live chat message
 * (`deleted_at IS NULL`) whose text has an address on one of Raft's hosts
 * (appHosts, and each kind's AppObjectKind.linkHosts: the same check as a new
 * message's), its links are read as a new message's are and, when they name
 * any object, written by writeMessageReferences: one short transaction that
 * locks the message row and writes only while its content is still the
 * content read here, so it is safe beside a live server (an edit or a
 * retraction in between wins), and running it again only rewrites the same
 * rows. A message whose links name no object is left alone.
 *
 * NOT AGAINST PRODUCTION WITHOUT A HUMAN'S CONFIRMATION: run it on
 * production (or any shared environment) only after a human has confirmed
 * that run, in its thread; `--dry-run` first (reads and counts, writes
 * nothing). Docs: docs/development/first-party-apps.md, "object_references".
 *
 * Run with the server's environment: the hosts come from its APP_URL and
 * APP_PERMALINK_HOSTS (printed first), and DATABASE_URL.
 *
 * Walk (Tenny's review): messages by (created_at, id), each batch a keyset
 * read of a FIXED number of rows (`--batch-size`) on idx_messages_created_at
 * after the cursor, whatever they hold; the candidates (live chat messages
 * of the server asked for whose text names a Raft host) are picked out of
 * those rows, and the cursor moves to the last row READ, candidate or not.
 * So every query is bounded by the batch, however sparse the candidates (one
 * server's among millions of rows), and the walk always advances. Each
 * batch's last cursor is printed, and `--after <created_at>/<id>` resumes
 * after it.
 *
 * What it reads: `message_type = 'chat'`, which is every message whose links
 * are written live (a send, an inbound or card update, and the pre-v2 task
 * and workflow-step host messages, written as `chat` too); a system line
 * (`system`) is not read (a send writes rows for chat messages only), and
 * the read lists chat messages only.
 *
 * Known limits:
 * - An edit that removed a message's last Raft address, whose own write of
 *   the rows failed, leaves the old rows: the message's text names no Raft
 *   host any more, so it is no candidate here and its rows are not cleared.
 *   The read ("Linked from", services/messageBacklinks.ts) neither lists nor
 *   counts such a message (its text no longer names a Raft host).
 * - A retracted message's rows are deleted in the retraction's transaction;
 *   the walk never writes rows for one (`deleted_at IS NULL`).
 */
import { sql } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../src/db/index";
import { channels, messages } from "../src/db/schema";
import { messageReferenceHosts, messageReferencesOf, writeMessageReferences } from "../src/services/messageReferences";

export interface MessageReferencesBackfillOptions {
  dryRun: boolean;
  serverId: string | null;
  batchSize: number;
  concurrency: number;
  limit: number | null;
  after: { createdAt: string; id: string } | null;
}

const USAGE = `Usage:
  pnpm --filter @botiverse/raft-server db:backfill-message-references -- [--dry-run] [--server <uuid>] [--batch-size 2000] [--concurrency 4] [--limit <n>] [--after <created_at>/<id>]

Not against production without a human's confirmation of the run; --dry-run first.
Run with the server's environment (APP_URL, APP_PERMALINK_HOSTS: the hosts read; DATABASE_URL).

Walks every message by (created_at, id), a fixed number of rows a batch, and
writes the rows of the live chat messages (pre-v2 task and workflow-step host
messages are chat messages too) whose text names a Raft host. A message whose
last Raft address was edited away while its own write failed keeps its old
rows (it is no candidate); the read neither lists nor counts it.

Options:
  --dry-run          Read and count the messages that would be written; write nothing
  --server <uuid>    Only messages of this server's channels (every row is still read: the walk is by time)
  --batch-size <n>   Messages read per batch, candidates or not (default 2000, at most 20000)
  --concurrency <n>  Messages written at once (default 4, at most 16)
  --limit <n>        Stop after reading this many messages
  --after <c>/<id>   Resume after this cursor (a progress line's "cursor")`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function positive(flag: string, value: string | undefined, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${flag} needs a whole number from 1 to ${max}\n${USAGE}`);
  return n;
}

/** `<created_at>/<id>`, as the progress lines print it. */
function parseCursor(value: string | undefined): { createdAt: string; id: string } {
  const at = value?.lastIndexOf("/") ?? -1;
  const createdAt = at > 0 ? value!.slice(0, at) : "";
  const id = at > 0 ? value!.slice(at + 1) : "";
  if (!createdAt || Number.isNaN(Date.parse(createdAt)) || !id || !UUID.test(id)) throw new Error(`--after needs <created_at>/<message id>\n${USAGE}`);
  return { createdAt, id };
}

export function parseMessageReferencesBackfillArgs(argv: readonly string[]): MessageReferencesBackfillOptions {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const options: MessageReferencesBackfillOptions = { dryRun: false, serverId: null, batchSize: 2000, concurrency: 4, limit: null, after: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--server") {
      const id = args[++i];
      if (!id || !UUID.test(id)) throw new Error(`--server needs a server id\n${USAGE}`);
      options.serverId = id;
    } else if (arg === "--batch-size") options.batchSize = positive(arg, args[++i], 20_000);
    else if (arg === "--concurrency") options.concurrency = positive(arg, args[++i], 16);
    else if (arg === "--limit") options.limit = positive(arg, args[++i]);
    else if (arg === "--after") options.after = parseCursor(args[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  return options;
}

async function eachLimited<T>(items: readonly T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(workers);
}

/**
 * The next `size` messages after `cursor` by (created_at, id), whatever they
 * are (a keyset read of idx_messages_created_at: bounded by `size`), each
 * with its content only when it is a candidate: live, chat, of the server
 * asked for, its text naming one of `hosts` (the check a new message's write
 * makes). The caller moves the cursor to the last row, candidate or not.
 */
async function nextRows(options: MessageReferencesBackfillOptions, hosts: readonly string[], cursor: { createdAt: string; id: string } | null, size: number) {
  const candidate = sql.join([
    sql`m.deleted_at IS NULL`,
    sql`m.message_type = 'chat'`,
    sql`strpos(m.content, '://') > 0`,
    sql`(${sql.join(hosts.map((host) => sql`strpos(lower(m.content), ${host}) > 0`), sql` OR `)})`,
    ...(options.serverId ? [sql`COALESCE(m.server_id, c.server_id) = ${options.serverId}::uuid`] : []),
  ], sql` AND `);
  const result = await getDb().execute(sql`
    SELECT m.id::text AS id,
      -- The text cursor keeps created_at's microseconds (a Date would drop them and read a row again).
      m.created_at::text AS created_at_text,
      CASE WHEN ${candidate} THEN m.content END AS content
    FROM ${messages} m
    ${options.serverId ? sql`JOIN ${channels} c ON c.id = m.channel_id` : sql``}
    ${cursor ? sql`WHERE (m.created_at, m.id) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : sql``}
    ORDER BY m.created_at, m.id
    LIMIT ${size}`);
  return result.rows as Array<{ id: string; created_at_text: string; content: string | null }>;
}

export async function backfillMessageReferences(options: MessageReferencesBackfillOptions): Promise<{ scanned: number; candidates: number; linking: number; written: number; stale: number; failed: number }> {
  const stats = { scanned: 0, candidates: 0, linking: 0, written: 0, stale: 0, failed: 0 };
  const hosts = messageReferenceHosts();
  console.log(JSON.stringify({ hosts, dryRun: options.dryRun }));
  if (hosts.length === 0) return stats;
  let cursor = options.after;
  for (;;) {
    const size = options.limit === null ? options.batchSize : Math.min(options.batchSize, options.limit - stats.scanned);
    if (size <= 0) break;
    const batch = await nextRows(options, hosts, cursor, size);
    if (batch.length === 0) break;
    stats.scanned += batch.length;
    const candidates = batch.flatMap((row) => (row.content === null ? [] : [{ id: row.id, content: row.content }]));
    stats.candidates += candidates.length;
    const linking = candidates.flatMap((message) => {
      const refs = messageReferencesOf(message.content);
      return refs.length > 0 ? [{ message, refs }] : [];
    });
    stats.linking += linking.length;
    if (!options.dryRun) {
      await eachLimited(linking, options.concurrency, async ({ message, refs }) => {
        try {
          stats[await writeMessageReferences(message.id, message.content, refs)] += 1;
        } catch (error) {
          stats.failed += 1;
          // Its class only: a database error's message may quote the content.
          console.error(JSON.stringify({ failed: message.id, errorClass: error instanceof Error ? error.name : typeof error }));
        }
      });
    }
    // The last row READ, candidate or not: the next batch starts after it.
    const last = batch[batch.length - 1]!;
    cursor = { createdAt: last.created_at_text, id: last.id };
    console.log(JSON.stringify({ ...stats, dryRun: options.dryRun, cursor: `${cursor.createdAt}/${cursor.id}` }));
    if (batch.length < size) break;
  }
  return stats;
}

async function main(): Promise<void> {
  const options = parseMessageReferencesBackfillArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  await initDatabase(url, undefined, { log: () => {} });
  try {
    const stats = await backfillMessageReferences(options);
    console.log(JSON.stringify({ done: true, dryRun: options.dryRun, ...stats }));
  } finally {
    await closeDatabase();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
