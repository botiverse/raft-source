#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Fill channel_last_posts (migration 0397) for posts made before its trigger
 * existed: when a person or an agent last posted in each channel (a chat
 * message; not a system message or an app event), and then each thread's
 * last post rolled up into its parent channel. Small batches by channel id,
 * each its own short transaction with a bounded lock and statement timeout;
 * only ever moves a value forward (GREATEST), so it is safe to re-run and to
 * run while the trigger writes new posts. Defaults to dry-run; pass --apply.
 * When --apply completes it marks the backfill done
 * (channel_last_posts_backfill), and only then does the channel list return
 * `lastPostAt`.
 */
import pg from "pg";

function usage(exitCode: number): never {
  console.error(`Usage:
  DATABASE_URL=... pnpm --filter @botiverse/raft-server db:backfill-channel-last-posts -- [--apply] [--batch <n>]`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): { apply: boolean; batch: number } {
  if (argv[0] === "--") argv = argv.slice(1);
  const options = { apply: false, batch: 200 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") { options.apply = true; continue; }
    if (arg === "--batch") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0 || value > 5_000) throw new Error("--batch must be 1..5000");
      options.batch = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") usage(0);
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

const UPSERT = `ON CONFLICT (channel_id) DO UPDATE
  SET last_post_at = GREATEST(channel_last_posts.last_post_at, EXCLUDED.last_post_at)`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) usage(2);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows: [counts] } = await client.query<{ channels: string; filled: string }>(
      "SELECT (SELECT count(*) FROM channels) AS channels, (SELECT count(*) FROM channel_last_posts) AS filled",
    );
    console.log(`channels: ${counts!.channels}, with a last post already: ${counts!.filled}`);
    if (!options.apply) {
      console.log("dry-run; pass --apply to fill them");
      return;
    }
    const batched = async (label: string, statement: string) => {
      let after = "00000000-0000-0000-0000-000000000000";
      let total = 0;
      for (;;) {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '60s'");
        const { rows: ids } = await client.query<{ id: string }>(
          "SELECT id FROM channels WHERE id > $1 ORDER BY id LIMIT $2", [after, options.batch],
        );
        if (ids.length === 0) { await client.query("COMMIT"); break; }
        const result = await client.query(statement, [ids.map((row) => row.id)]);
        await client.query("COMMIT");
        total += result.rowCount ?? 0;
        after = ids[ids.length - 1]!.id;
        console.log(`${label}: through ${after}, ${total} written`);
      }
      return total;
    };
    // 1. Each channel's (and thread's) own last post: the newest chat message by a person or an agent.
    const own = await batched("own", `
      INSERT INTO channel_last_posts (channel_id, last_post_at)
      SELECT c.id, latest.created_at
      FROM channels c
      JOIN LATERAL (
        SELECT m.created_at FROM messages m
        WHERE m.channel_id = c.id AND m.sender_type IN ('user', 'agent') AND m.message_type = 'chat'
        ORDER BY m.seq DESC LIMIT 1
      ) latest ON TRUE
      WHERE c.id = ANY($1::uuid[])
      ${UPSERT}`);
    // 2. A thread's last post counts for its parent channel.
    const parents = await batched("parents", `
      INSERT INTO channel_last_posts (channel_id, last_post_at)
      SELECT t.parent_channel_id, max(p.last_post_at)
      FROM channels t
      JOIN channel_last_posts p ON p.channel_id = t.id
      WHERE t.parent_channel_id = ANY($1::uuid[])
      GROUP BY t.parent_channel_id
      ${UPSERT}`);
    // The channel list shows lastPostAt only from now on (before, a missing row was not "no posts").
    await client.query("INSERT INTO channel_last_posts_backfill (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
    console.log(`done: ${own} channel rows, ${parents} parent roll-ups; marked complete`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
