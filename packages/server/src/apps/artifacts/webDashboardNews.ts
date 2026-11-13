// What is new for the reader on the home page (webDashboard.ts): the one
// definition of what is waiting on them and what is new on what they follow,
// as SQL over their own rows, so the sections, the All tab's `relevant` order
// and counts and its rows' news can't disagree; and what the reader is
// involved with (involvedSql), what the `relevant` filter keeps, read or not.
//
// The news fragments are per Artifact, of any Artifact: neither says the reader
// can see it. Each caller joins the items with visibleArtifactsSql in the same
// statement, so a mention on an Artifact the reader lost is never counted.
// `only` narrows a fragment to a page's Artifacts (dashboardNewsOf).
//
// Cost: they start from the reader's own rows (idx_comments_mentions,
// idx_subscriptions_actor, with idx_comments_item_position and
// idx_versions_item_position per Artifact), as the header of webDashboard.ts
// measures, so they follow the reader's activity, not the server's size.
import { sql, type SQL } from "drizzle-orm";
import type { ArtifactDashboardAllNews } from "@botiverse/raft-shared";
import { getDb } from "../../platform/db";
import { artifactComments, artifactItems, artifactReadPositions, artifactSubscriptions, artifactVersions } from "./schema";
import type { ArtifactWebReader } from "./webCommon";

const within = (column: SQL, only: readonly string[] | undefined): SQL =>
  only ? sql`AND ${column} IN (${sql.join(only.map((id) => sql`${id}`), sql`, `)})` : sql``;

/**
 * The news as of a moment (`asOf`; undefined: now), for the `relevant` order's
 * later pages (webDashboardAllOrder.ts): activity made after it isn't counted,
 * so news that arrives while someone pages moves nothing up. Still bounded by
 * the reader's current read position, so a read between pages can only lower
 * an Artifact's tier, never raise it: one already listed may come back once
 * further down (the web drops a row it has, by card id), one not listed yet
 * is listed in the lower segment, and nothing is skipped because of a read.
 * The bound keeps idx_comments_item_position and idx_versions_item_position
 * usable. Without `asOf` nothing changes: every caller but that order passes none.
 */
function newSince(row: { position: SQL; createdAt: SQL }, readPosition: SQL, asOf: Date | undefined): SQL {
  const unread = sql`${row.position} > COALESCE(${readPosition}, 0)`;
  return asOf ? sql`${row.createdAt} <= ${asOf.toISOString()}::timestamptz AND ${unread}` : unread;
}

/**
 * What is waiting on the reader, per Artifact (`item_id`): the live comments
 * that mention them (idx_comments_mentions; `mentions` holds `{ type, id }`
 * objects), by others, after their read position: how many (`n`) and the
 * newest one's position (`newest`).
 */
export function mentionedSql(reader: ArtifactWebReader, only?: readonly string[], asOf?: Date): SQL {
  const me = sql`${reader.userId}::uuid`;
  const mentionsMe = JSON.stringify([{ type: "user", id: reader.userId }]);
  return sql`
    SELECT c.item_id, count(*)::int AS n, max(c.position) AS newest
    FROM ${artifactComments} c
    LEFT JOIN ${artifactReadPositions} crp
      ON crp.item_id = c.item_id AND crp.actor_type = 'user' AND crp.actor_id = ${me}
    WHERE c.mentions @> ${mentionsMe}::jsonb
      AND c.deleted_at IS NULL
      AND NOT (c.author_type = 'user' AND c.author_id = ${me})
      AND ${newSince({ position: sql`c.position`, createdAt: sql`c.created_at` }, sql`crp.position`, asOf)}
      ${within(sql`c.item_id`, only)}
    GROUP BY c.item_id`;
}

/**
 * What is new on what the reader follows, per Artifact (`item_id`), from what
 * it follows (subscriptions, not stopped; idx_subscriptions_actor): published
 * versions (`versions`) and live comments (`comments`) by others after its
 * read position, at least one of them, and when the newest was made (`at`).
 */
export function followedNewsSql(reader: ArtifactWebReader, only?: readonly string[], asOf?: Date): SQL {
  const me = sql`${reader.userId}::uuid`;
  const rp = sql`rp.position`;
  return sql`
    SELECT s.item_id, nv.n AS versions, nc.n AS comments, GREATEST(nv.at, nc.at) AS at
    FROM ${artifactSubscriptions} s
    LEFT JOIN ${artifactReadPositions} rp
      ON rp.item_id = s.item_id AND rp.actor_type = 'user' AND rp.actor_id = ${me}
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n, max(v.created_at) AS at FROM ${artifactVersions} v
      WHERE v.item_id = s.item_id
        AND v.revoked_at IS NULL
        AND v.position IS NOT NULL
        AND ${newSince({ position: sql`v.position`, createdAt: sql`v.created_at` }, rp, asOf)}
        AND NOT (v.publisher_type = 'user' AND v.publisher_id = ${me})
    ) nv
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n, max(c.created_at) AS at FROM ${artifactComments} c
      WHERE c.item_id = s.item_id
        AND ${newSince({ position: sql`c.position`, createdAt: sql`c.created_at` }, rp, asOf)}
        AND c.deleted_at IS NULL
        AND NOT (c.author_type = 'user' AND c.author_id = ${me})
    ) nc
    WHERE s.actor_type = 'user' AND s.actor_id = ${me} AND s.unsubscribed_at IS NULL
      AND (nv.n > 0 OR nc.n > 0)
      ${within(sql`s.item_id`, only)}`;
}

/**
 * What the reader is involved with, read or not, as a condition on the
 * statement's unaliased items (the All tab's `relevant` filter):
 * - made it: published any version of it (versions.publisher, published and
 *   not revoked: the page's "who updated", what the `recent` section calls its
 *   own), itself or through one of its agents (`agentIds`: the live agents of
 *   its server it created, platform/visibility agentsCreatedBy). Its creator
 *   is always v1's publisher (publish, save and import make them one), so a
 *   creator is a publisher; someone who published only v2 counts too;
 * - follows it: subscriptions, not stopped (what followedNewsSql starts from,
 *   idx_subscriptions_actor);
 * - mentioned on it: a live comment by someone else mentions it, read or not
 *   (what mentionedSql starts from, idx_comments_mentions).
 * Every Artifact with news (dashboardNewsSql) is one of these: a mention is
 * the third, followed news the second.
 *
 * It says nothing of visibility, and only narrows: the caller puts it beside
 * the reader's visibleArtifactsSql in the same statement, the one condition
 * every dashboard list uses, so each way in is shown only where the reader
 * can see it (one made or followed in a channel it left is not, nor one its
 * agent published where only the agent can see). Cost: all of it starts from
 * the reader's own rows (idx_versions_publisher, with the agents as one IN
 * list; idx_subscriptions_actor; idx_comments_mentions), one hashed set.
 */
export function involvedSql(reader: ArtifactWebReader, agentIds: readonly string[]): SQL {
  const me = sql`${reader.userId}::uuid`;
  const mentionsMe = JSON.stringify([{ type: "user", id: reader.userId }]);
  const byMyAgents = agentIds.length === 0
    ? sql``
    : sql`OR (pv.publisher_type = 'agent' AND pv.publisher_id IN (${sql.join(agentIds.map((id) => sql`${id}::uuid`), sql`, `)}))`;
  return sql`${artifactItems.id} IN (
      SELECT pv.item_id FROM ${artifactVersions} pv
      WHERE ((pv.publisher_type = 'user' AND pv.publisher_id = ${me}) ${byMyAgents})
        AND pv.revoked_at IS NULL AND pv.position IS NOT NULL
      UNION
      SELECT s.item_id FROM ${artifactSubscriptions} s
      WHERE s.actor_type = 'user' AND s.actor_id = ${me} AND s.unsubscribed_at IS NULL
      UNION
      SELECT c.item_id FROM ${artifactComments} c
      WHERE c.mentions @> ${mentionsMe}::jsonb
        AND c.deleted_at IS NULL
        AND NOT (c.author_type = 'user' AND c.author_id = ${me})
    )`;
}

/**
 * Both together, one row per Artifact (`item_id`, and the counts of
 * ArtifactDashboardAllNews): an Artifact waiting and followed is one row, so
 * nothing that counts these rows counts it twice.
 */
export function dashboardNewsSql(reader: ArtifactWebReader, only?: readonly string[], asOf?: Date): SQL {
  return sql`
    SELECT item_id, sum(mentions)::int AS mentions, sum(versions)::int AS versions, sum(comments)::int AS comments
    FROM (
      SELECT m.item_id, m.n AS mentions, 0 AS versions, 0 AS comments FROM (${mentionedSql(reader, only, asOf)}) m
      UNION ALL
      SELECT f.item_id, 0, f.versions, f.comments FROM (${followedNewsSql(reader, only, asOf)}) f
    ) news
    GROUP BY item_id`;
}

/** The news of a page's Artifacts (already found visible), one query; an Artifact with none is left out. */
export async function dashboardNewsOf(reader: ArtifactWebReader, ids: readonly string[]): Promise<ReadonlyMap<string, ArtifactDashboardAllNews>> {
  if (ids.length === 0) return new Map();
  const rows = (await getDb().execute(dashboardNewsSql(reader, ids))).rows as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => [String(row.item_id), {
    mentions: Number(row.mentions),
    versions: Number(row.versions),
    comments: Number(row.comments),
  }]));
}
