#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Give every non-guest server member a channel_humans row in their server's
 * enabled #all (#triage:64b44a12). #all's audience is the server's members
 * (#3054), but both inbox read paths build subscriptions from channel_humans,
 * so members without a row saw #all only as outsiders: no unread, mentions as
 * bare rows. New joins get their row from ensureAllChannelHumanRows; this
 * fills the members who joined before that (production ~10k people).
 *
 * Read position (tygg, #triage:64b44a12 msg 88978293): the backfill marks all
 * of #all read and never moves anyone back to unread. Every new row's position
 * becomes max(existing position, latest #all message at backfill time); #all
 * counts like a normal channel from then on. (An earlier draft kept recent
 * unread @mentions unread; tygg ruled that out.)
 *
 * joined_at is #all's own created_at, so a later reader of joined_at (e.g.
 * RisingWave's "latest after join" rule) never treats existing #all history as
 * predating the member.
 *
 * Batches of enabled #all channels by id, each its own short transaction
 * (lock_timeout 2s, statement_timeout 60s). Idempotent: a member who already
 * has a row is skipped, and a position only ever moves forward. Defaults to a
 * read-only preview; pass --apply to write. --servers limits the run to the
 * first N enabled #all (a canary). --verify reruns only the checks.
 */
import pg from "pg";

function usage(exitCode: number): never {
  console.error(`Usage:
  DATABASE_URL=... pnpm --filter @botiverse/raft-server db:backfill-all-channel-members -- [--apply] [--verify] [--batch <n>] [--servers <n>]`);
  process.exit(exitCode);
}

export interface Options { apply: boolean; verify: boolean; batch: number; servers: number | null }

export function parseArgs(argv: string[]): Options {
  if (argv[0] === "--") argv = argv.slice(1);
  const options: Options = { apply: false, verify: false, batch: 200, servers: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") { options.apply = true; continue; }
    if (arg === "--verify") { options.verify = true; continue; }
    if (arg === "--batch" || arg === "--servers") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0 || value > 100_000) throw new Error(`${arg} must be a positive integer`);
      if (arg === "--batch") options.batch = Math.min(value, 5_000);
      else options.servers = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") usage(0);
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.apply && options.verify) throw new Error("--apply and --verify are exclusive");
  return options;
}


/**
 * The plan for the #all channels in $1: one row per member to add, with the
 * position to set and the group it falls in. Shared by the preview and the
 * apply so they cannot disagree.
 */
const PLAN = `
  WITH all_channels AS (
    SELECT c.id AS channel_id, c.server_id, c.created_at
    FROM channels c
    WHERE c.id = ANY($1::uuid[]) AND c.name = 'all' AND c.type = 'channel' AND c.deleted_at IS NULL
  ),
  candidates AS (
    SELECT a.channel_id, a.created_at, sm.user_id
    FROM all_channels a
    JOIN server_members sm ON sm.server_id = a.server_id AND sm.role <> 'guest'
    WHERE NOT EXISTS (
      SELECT 1 FROM channel_humans ch WHERE ch.channel_id = a.channel_id AND ch.user_id = sm.user_id
    )
  ),
  latest AS (
    SELECT m.channel_id, MAX(m.seq) AS seq
    FROM messages m
    WHERE m.channel_id IN (SELECT channel_id FROM all_channels)
    GROUP BY m.channel_id
  ),
  planned AS (
    SELECT
      cand.channel_id,
      cand.user_id,
      cand.created_at,
      cur.seq AS cur_seq,
      COALESCE(latest.seq, 0) AS latest_seq
    FROM candidates cand
    LEFT JOIN latest ON latest.channel_id = cand.channel_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(r.last_read_seq8, r.last_read_seq::bigint) AS seq
      FROM user_channel_read_cursors r
      WHERE r.user_id = cand.user_id AND r.channel_id = cand.channel_id
    ) cur ON true
  ),
  targets AS (
    SELECT
      planned.*,
      GREATEST(COALESCE(cur_seq, 0), latest_seq) AS target_seq,
      CASE WHEN cur_seq IS NOT NULL THEN 'had_position' ELSE 'no_position' END AS grp
    FROM planned
  )`;

/** Per group: people, and the unread #all messages each would show after the backfill. */
const PREVIEW = `${PLAN}
  SELECT t.grp,
         count(*)::int AS people,
         COALESCE(sum(added.n), 0)::bigint AS added_unread,
         COALESCE(max(added.n), 0)::int AS max_added_unread
  FROM targets t
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS n
    FROM messages m
    WHERE m.channel_id = t.channel_id
      AND m.seq > t.target_seq
      AND m.deleted_at IS NULL
      AND NOT (m.sender_type = 'user' AND m.sender_id = t.user_id::text)
  ) added
  GROUP BY t.grp`;

const APPLY = `${PLAN},
  inserted AS (
    INSERT INTO channel_humans (channel_id, user_id, joined_at)
    SELECT channel_id, user_id, created_at FROM targets
    ON CONFLICT DO NOTHING
    RETURNING channel_id, user_id
  ),
  positioned AS (
    INSERT INTO user_channel_read_cursors (user_id, channel_id, last_read_seq, read_state_version, updated_at)
    SELECT t.user_id, t.channel_id, t.target_seq::int, 1, now()
    FROM targets t
    JOIN inserted i ON i.channel_id = t.channel_id AND i.user_id = t.user_id
    WHERE t.target_seq > 0
    ON CONFLICT (user_id, channel_id) DO UPDATE SET
      last_read_seq = EXCLUDED.last_read_seq,
      read_state_version = user_channel_read_cursors.read_state_version + 1,
      updated_at = now()
    WHERE EXCLUDED.last_read_seq > user_channel_read_cursors.last_read_seq
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM inserted)::int AS rows_added,
         (SELECT count(*) FROM positioned)::int AS positions_written`;

/** After the run: non-guest members still missing their row in an enabled #all (must be 0). */
const VERIFY_MISSING = `
  SELECT count(*)::int AS missing
  FROM channels c
  JOIN server_members sm ON sm.server_id = c.server_id AND sm.role <> 'guest'
  WHERE c.name = 'all' AND c.type = 'channel' AND c.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM channel_humans ch WHERE ch.channel_id = c.id AND ch.user_id = sm.user_id)`;

/** Rows in #all for people who are not (or no longer) non-guest members (must be 0). */
const VERIFY_STRAY = `
  SELECT count(*)::int AS stray
  FROM channel_humans ch
  JOIN channels c ON c.id = ch.channel_id AND c.name = 'all' AND c.type = 'channel' AND c.deleted_at IS NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM server_members sm
    WHERE sm.server_id = c.server_id AND sm.user_id = ch.user_id AND sm.role <> 'guest'
  )`;

type GroupRow = { grp: string; people: number; added_unread: string | number; max_added_unread: number };

/** pg.Client and PGlite both answer this. */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface GroupTotal { people: number; addedUnread: bigint; maxAddedUnread: number }
export interface BackfillSummary {
  channels: number;
  groups: Record<"had_position" | "no_position", GroupTotal>;
  rowsAdded: number;
  positionsWritten: number;
}

async function enabledAllChannelIds(client: Queryable, after: string, limit: number): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM channels
     WHERE name = 'all' AND type = 'channel' AND deleted_at IS NULL AND id > $1
     ORDER BY id LIMIT $2`,
    [after, limit],
  );
  return rows.map((row) => row.id);
}

export async function runBackfill(
  client: Queryable,
  options: Pick<Options, "apply" | "batch" | "servers">,
  log: (line: string) => void = () => {},
): Promise<BackfillSummary> {
  const empty = (): GroupTotal => ({ people: 0, addedUnread: 0n, maxAddedUnread: 0 });
  const summary: BackfillSummary = {
    channels: 0,
    groups: { had_position: empty(), no_position: empty() },
    rowsAdded: 0,
    positionsWritten: 0,
  };
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const room = options.servers === null ? options.batch : Math.min(options.batch, options.servers - summary.channels);
    if (room <= 0) break;
    const ids = await enabledAllChannelIds(client, after, room);
    if (ids.length === 0) break;
    summary.channels += ids.length;
    after = ids[ids.length - 1]!;
    await client.query(options.apply ? "BEGIN" : "BEGIN READ ONLY");
    try {
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      const { rows } = await client.query<GroupRow>(PREVIEW, [ids]);
      for (const row of rows) {
        const total = summary.groups[row.grp as keyof BackfillSummary["groups"]];
        total.people += Number(row.people);
        total.addedUnread += BigInt(row.added_unread);
        total.maxAddedUnread = Math.max(total.maxAddedUnread, Number(row.max_added_unread));
      }
      if (options.apply) {
        const { rows: [applied] } = await client.query<{ rows_added: number; positions_written: number }>(APPLY, [ids]);
        summary.rowsAdded += Number(applied!.rows_added);
        summary.positionsWritten += Number(applied!.positions_written);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    log(`#all through ${after}: ${summary.channels} channels${options.apply ? `, ${summary.rowsAdded} rows added` : ""}`);
  }
  return summary;
}

export async function verifyBackfill(client: Queryable): Promise<{ missing: number; stray: number }> {
  const { rows: [missing] } = await client.query<{ missing: number }>(VERIFY_MISSING);
  const { rows: [stray] } = await client.query<{ stray: number }>(VERIFY_STRAY);
  return { missing: Number(missing!.missing), stray: Number(stray!.stray) };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) usage(2);
  const client = new pg.Client({ connectionString });
  await client.connect();
  const report = async () => {
    const { missing, stray } = await verifyBackfill(client);
    console.log(`verify: members missing their #all row = ${missing} (expect 0); rows for non-members/guests = ${stray} (expect 0)`);
    if (missing !== 0 || stray !== 0) process.exitCode = 1;
  };
  try {
    if (options.verify) {
      await report();
      return;
    }
    const summary = await runBackfill(client, options, (line) => console.error(line));
    console.log(`${options.apply ? "applied" : "preview (read-only)"}: ${summary.channels} enabled #all channels`);
    console.log("group               people  unread after backfill (total / max per person)");
    for (const [grp, total] of Object.entries(summary.groups)) {
      console.log(`${grp.padEnd(18)} ${String(total.people).padStart(7)}  ${total.addedUnread} / ${total.maxAddedUnread}`);
    }
    if (options.apply) {
      console.log(`rows added: ${summary.rowsAdded}, read positions written: ${summary.positionsWritten}`);
      if (options.servers === null) await report();
    } else {
      console.log("read-only preview; pass --apply to write");
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

