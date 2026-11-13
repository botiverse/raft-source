// People's Activity rows for Artifacts (S6; first-party app mechanism §四):
// the registration's `unreadFor`, `activityDetails` and `markRead`, which
// core's services/objectActivity.ts asks for the rows of one Activity page
// and for Done / mark read. Whether a row is unread, the badge and the unread
// filters are core's: this module reports every move of a person's read
// position to it (apiCommon reportRead), so nothing here runs on the badge's
// path.
//
// What a person hears about (who core's rows are for) is decided when an
// event is recorded (comments.ts, publish.ts): those a comment mentions and
// the Artifact's followers. Here, the same rule numbers what is unread: while
// following, versions and live comments by others after the read position;
// otherwise only live comments by others after it that mention the person.
//
// Each function is one query however many Artifacts (two for details).
import { sql } from "drizzle-orm";
import { asArtifactCommentId, asArtifactReviewId, type ArtifactActivityTarget } from "@botiverse/raft-shared";
import { forgetObjectActivity, objectActivityPeople, type ForgottenActivityRow } from "../../platform/activity";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import type { AppObjectActivityDetail, AppObjectActivityRow, AppObjectUnread, AppWebReader } from "../../platform/apps";
import { excerptOf, reportRead } from "./apiCommon";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { artifactComments, artifactItems, artifactReadPositions, artifactSubscriptions, artifactVersions, type ArtifactActorType } from "./schema";

const textList = (values: readonly string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);

/**
 * Following, and how much is unread, for each live Artifact of `ids` (core:
 * AppObjectKind.unreadFor), also by part (#81, shared ArtifactActivityUnread):
 * while following, the versions and the comments; otherwise no versions and
 * the comments that mention the reader.
 */
export async function artifactUnreadFor(reader: AppWebReader, ids: readonly string[]): Promise<ReadonlyMap<string, AppObjectUnread>> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return new Map();
  const me = sql`${reader.userId}::uuid`;
  const mentionsMe = JSON.stringify([{ type: "user", id: reader.userId }]);
  const rows = (await getDb().execute(sql`
    SELECT i.id, (s.item_id IS NOT NULL AND s.unsubscribed_at IS NULL) AS following, nv.n AS versions, nc.n AS comments, nm.n AS mentions
    FROM ${artifactItems} i
    LEFT JOIN ${artifactSubscriptions} s ON s.item_id = i.id AND s.actor_type = 'user' AND s.actor_id = ${me}
    LEFT JOIN ${artifactReadPositions} rp ON rp.item_id = i.id AND rp.actor_type = 'user' AND rp.actor_id = ${me}
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n FROM ${artifactVersions} v
      WHERE v.item_id = i.id AND v.revoked_at IS NULL AND v.position IS NOT NULL AND v.position > COALESCE(rp.position, 0)
        AND NOT (v.publisher_type = 'user' AND v.publisher_id = ${me})
    ) nv
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n FROM ${artifactComments} c
      WHERE c.item_id = i.id AND c.deleted_at IS NULL AND c.position > COALESCE(rp.position, 0)
        AND NOT (c.author_type = 'user' AND c.author_id = ${me})
    ) nc
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n FROM ${artifactComments} c
      WHERE c.item_id = i.id AND c.deleted_at IS NULL AND c.position > COALESCE(rp.position, 0)
        AND NOT (c.author_type = 'user' AND c.author_id = ${me}) AND c.mentions @> ${mentionsMe}::jsonb
    ) nm
    WHERE i.id IN (${textList(distinct)}) AND i.deleted_at IS NULL AND i.revoked_at IS NULL`)).rows as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => {
    const following = row.following === true;
    const parts = following ? { versions: Number(row.versions), comments: Number(row.comments) } : { versions: 0, comments: Number(row.mentions) };
    return [String(row.id), { following, unread: parts.versions + parts.comments, parts }];
  }));
}

/**
 * Each row's preview and where it opens (core: AppObjectKind.activityDetails).
 * The preview: the newest unread comment by others the person hears about
 * (any while following, else one that mentions them), else, read or not
 * (#80), the comment of the row's newest event (a comment, a review's first,
 * an edited one) while it is live and by someone else; null otherwise (a
 * version, a deleted comment), with its images counted (`images`, #146;
 * absent when none). The row reached the reader only while they
 * can see the Artifact (core's check), so they can see its comments. The target: the row's newest
 * event, its comment (on that comment's version) while live, else the
 * version it names; a review's also its id and how many comments it posted.
 * Two queries.
 */
export async function artifactActivityDetails(reader: AppWebReader, rows: readonly AppObjectActivityRow[]): Promise<ReadonlyMap<string, AppObjectActivityDetail>> {
  if (rows.length === 0) return new Map();
  const ids = [...new Set(rows.map((row) => row.id))];
  const me = sql`${reader.userId}::uuid`;
  const mentionsMe = JSON.stringify([{ type: "user", id: reader.userId }]);
  const db = getDb();
  const unread = (await db.execute(sql`
    SELECT i.id AS item_id, w.id, w.body, jsonb_array_length(w.images) AS image_count, w.author_type, w.author_id, w.created_at, wv.number AS version
    FROM ${artifactItems} i
    LEFT JOIN ${artifactSubscriptions} s ON s.item_id = i.id AND s.actor_type = 'user' AND s.actor_id = ${me}
    LEFT JOIN ${artifactReadPositions} rp ON rp.item_id = i.id AND rp.actor_type = 'user' AND rp.actor_id = ${me}
    CROSS JOIN LATERAL (
      SELECT c.* FROM ${artifactComments} c
      WHERE c.item_id = i.id AND c.deleted_at IS NULL AND c.position > COALESCE(rp.position, 0)
        AND NOT (c.author_type = 'user' AND c.author_id = ${me})
        AND ((s.item_id IS NOT NULL AND s.unsubscribed_at IS NULL) OR c.mentions @> ${mentionsMe}::jsonb)
      ORDER BY c.position DESC LIMIT 1
    ) w
    LEFT JOIN ${artifactVersions} wv ON wv.id = w.version_id
    WHERE i.id IN (${textList(ids)})`)).rows as Array<Record<string, unknown>>;
  const latestComments = [...new Set(rows.flatMap((row) => (typeof row.latest.data.comment === "string" ? [row.latest.data.comment] : [])))];
  const latest = latestComments.length > 0
    ? (await db.execute(sql`
      SELECT c.id, c.body, jsonb_array_length(c.images) AS image_count, c.author_type, c.author_id, c.created_at, cv.number AS version
      FROM ${artifactComments} c LEFT JOIN ${artifactVersions} cv ON cv.id = c.version_id
      WHERE c.id IN (${textList(latestComments)}) AND c.deleted_at IS NULL`)).rows as Array<Record<string, unknown>>
    : [];
  const unreadOf = new Map(unread.map((row) => [String(row.item_id), row]));
  const latestOf = new Map(latest.map((row) => [String(row.id), row]));
  const details = new Map<string, AppObjectActivityDetail>();
  for (const row of rows) {
    const latestComment = typeof row.latest.data.comment === "string" ? latestOf.get(row.latest.data.comment) : undefined;
    // Nothing unread: the newest event's comment, read or not, unless it is the reader's own.
    const latestByOthers = latestComment && !(latestComment.author_type === "user" && String(latestComment.author_id) === reader.userId) ? latestComment : undefined;
    const shown = unreadOf.get(row.id) ?? latestByOthers;
    const preview = shown
      ? (() => {
        const { excerpt, truncated } = excerptOf(String(shown.body));
        // A comment's images, counted (#146): an image-only comment's text is empty, and the web says "Image" for it.
        const images = Number(shown.image_count ?? 0);
        return {
          // One line.
          text: excerpt.replace(/\s+/g, " ").trim(),
          truncated,
          author: { type: shown.author_type as ArtifactActorType, id: String(shown.author_id) },
          at: shown.created_at instanceof Date ? shown.created_at : new Date(String(shown.created_at)),
          ...(images > 0 ? { images } : {}),
        };
      })()
      : null;
    // Opening the row lands on its newest event: its comment while live, else the version it names.
    const version = row.latest.data.version;
    const base: ArtifactActivityTarget | null = latestComment
      ? { version: Number(latestComment.version), comment: asArtifactCommentId(String(latestComment.id)) }
      : typeof version === "number" ? { version } : null;
    // A review (reviews.ts writeReview's event data) also names itself and its size.
    const { review, comments } = row.latest.data;
    const target = base && row.latest.eventKind === "review" && typeof review === "string" && typeof comments === "number"
      ? { ...base, review: { id: asArtifactReviewId(review), comments } }
      : base;
    details.set(row.id, { preview, target });
  }
  return details;
}

/**
 * Mark Artifacts read for a person (core: AppObjectKind.markRead): the read
 * position moves to the position of the event `through` names, or to the
 * Artifact's last position when null, never back, and core is told; both on
 * core's `executor` (its transaction). Live Artifacts only. Two statements
 * however many.
 */
export async function markArtifactsRead(
  reader: AppWebReader,
  targets: ReadonlyArray<{ id: string; through: Readonly<Record<string, unknown>> | null }>,
  executor: DatabaseExecutor,
): Promise<void> {
  if (targets.length === 0) return;
  const wanted = JSON.stringify(targets.map((target) => ({
    id: target.id,
    position: typeof target.through?.position === "number" ? target.through.position : null,
  })));
  const moved = (await executor.execute(sql`
    INSERT INTO ${artifactReadPositions} AS rp (item_id, actor_type, actor_id, position)
    SELECT i.id, 'user', ${reader.userId}::uuid, LEAST(i.last_position, COALESCE(t.position, i.last_position))
    FROM jsonb_to_recordset(${wanted}::jsonb) AS t(id text, position bigint)
    JOIN ${artifactItems} i ON i.id = t.id AND i.deleted_at IS NULL AND i.revoked_at IS NULL
    ON CONFLICT (item_id, actor_type, actor_id) DO UPDATE
      SET position = GREATEST(rp.position, excluded.position), updated_at = now()
    RETURNING rp.item_id, rp.position`)).rows as Array<{ item_id: string; position: number | string }>;
  await reportRead(executor, reader.userId, moved.map((row) => ({ itemId: String(row.item_id), position: Number(row.position) })));
}

/**
 * A deleted Artifact leaves everyone's Activity (manage.ts deleteArtifact):
 * core's rows for it go (platform/activity forgetObjectActivity), in `tx`,
 * the deleting transaction, so the badge drops it with the delete. Returns
 * whose rows went, to tell their clients after the commit.
 */
export function forgetArtifactActivity(tx: DatabaseExecutor, itemId: string): Promise<ForgottenActivityRow[]> {
  return forgetObjectActivity(tx, { kind: ARTIFACT_OBJECT_KIND, objectId: itemId });
}

/**
 * An Artifact moved to a smaller home leaves the Activity of those who can't
 * see it there (manage.ts narrowArtifactHome): of the people with a row for
 * it, those `stillSee` doesn't keep, in `tx`, the moving transaction. Returns
 * whose rows went, to tell their clients after the commit.
 */
export async function forgetArtifactActivityOfThoseWhoLost(
  tx: DatabaseExecutor,
  itemId: string,
  stillSee: (people: ReadonlyArray<{ userId: string; serverId: string }>) => Promise<boolean[]>,
): Promise<ForgottenActivityRow[]> {
  const people = await objectActivityPeople(tx, { kind: ARTIFACT_OBJECT_KIND, objectId: itemId });
  if (people.length === 0) return [];
  const sees = await stillSee(people);
  const lost = people.filter((_, index) => !sees[index]).map((person) => person.userId);
  return forgetObjectActivity(tx, { kind: ARTIFACT_OBJECT_KIND, objectId: itemId, userIds: lost });
}
