// Channel announcements (#proj-chat:#29, channel_announcement_v0): an
// Artifact homed in a channel may be that channel's announcement. Core owns
// the choice (channels.announcement_artifact_id, services/channelAnnouncements.ts)
// and who sees it (the home's rule); this is what it reads of the Artifact
// (register.ts `channelAnnouncement.headlines`). A new version's notice to the
// channel's agents is notices.ts noticeChannelAnnouncement; clearing it when the
// Artifact is deleted or moved out is manage.ts, through
// platform/channelAnnouncements.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { channelAnnouncementPushForbiddenText, type ServerId } from "@botiverse/raft-shared";
import type { AppActor, AppObjectHeadline } from "../../platform/apps";
import { channelAnnouncementPushRefusal } from "../../platform/channelAnnouncements";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import type { ArtifactActorRef, ArtifactRefusal } from "./apiCommon";
import { artifactItems, artifactReadPositions, artifactVersions, type ArtifactItemRow } from "./schema";

/**
 * While the Artifact is a channel's announcement, pushing to it (a new
 * version, or a new title) needs the right to set that channel's
 * announcement (core decides: platform/channelAnnouncements). The refusal
 * when the publisher (an agent, or a person its assistant pushes for:
 * publishAs.ts) lacks it, else null. publish.ts asks before anything is
 * stored, and again in its transaction with the item locked.
 */
export async function channelAnnouncementPushRefused(publisher: ArtifactActorRef & { serverId: ServerId }, item: ArtifactItemRow, executor?: DatabaseExecutor): Promise<ArtifactRefusal | null> {
  if (item.homeKind !== "conversation") return null;
  const refused = await channelAnnouncementPushRefusal(item.id, item.homeChannelId, { type: publisher.type, id: publisher.id, serverId: publisher.serverId }, executor);
  if (!refused) return null;
  const text = channelAnnouncementPushForbiddenText(refused.channel);
  return { code: "CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN", error: text.message, suggestedNextAction: text.nextAction, details: { channel: refused.channel, title: item.title } };
}

/** The first non-empty line of a version's excerpt (excerpt.ts: one line per block), null without one. */
function firstExcerptLine(excerpt: string | null): string | null {
  const line = excerpt?.split("\n").find((part) => part.trim() !== "")?.trim();
  return line ? line : null;
}

/**
 * The title, current version (number, publisher, note, the first line of its
 * excerpt: what a Markdown card shows, null for HTML) and last change of
 * each live Artifact of these ids that has a current version (deleted, taken
 * down and versionless ones left out), and with `reader` whether that reader
 * has seen the current version: it published it, or its read position (the
 * one opening the current version moves, apiCommon advanceReadPosition) is
 * at or past the position the version became current at. One query.
 */
export async function artifactHeadlines(ids: readonly string[], reader?: AppActor): Promise<ReadonlyMap<string, AppObjectHeadline>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb().select({
    id: artifactItems.id,
    title: artifactItems.title,
    updatedAt: artifactItems.updatedAt,
    version: artifactVersions.number,
    versionPosition: artifactVersions.position,
    publisherType: artifactVersions.publisherType,
    publisherId: artifactVersions.publisherId,
    note: artifactVersions.note,
    excerpt: artifactVersions.excerpt,
    readPosition: artifactReadPositions.position,
  }).from(artifactItems)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifactItems.currentVersionId))
    .leftJoin(artifactReadPositions, reader
      ? and(eq(artifactReadPositions.itemId, artifactItems.id), eq(artifactReadPositions.actorType, reader.type), eq(artifactReadPositions.actorId, reader.id))
      : sql`false`)
    .where(and(inArray(artifactItems.id, [...new Set(ids)]), isNull(artifactItems.deletedAt), isNull(artifactItems.revokedAt)));
  return new Map(rows.map((row) => {
    const published = reader !== undefined && row.publisherType === reader.type && row.publisherId === reader.id;
    const readPast = row.readPosition !== null && row.versionPosition !== null && row.readPosition >= row.versionPosition;
    return [row.id, {
      title: row.title,
      version: row.version,
      updatedAt: row.updatedAt,
      updatedBy: { type: row.publisherType, id: row.publisherId },
      note: row.note,
      seen: reader === undefined ? null : published || readPast,
      excerpt: firstExcerptLine(row.excerpt),
    }];
  }));
}
