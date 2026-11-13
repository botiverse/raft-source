import type { ReactNode } from "react";
import type { IntlShape } from "react-intl";
import { parseArtifactRef } from "@botiverse/raft-shared";
import type { ArtifactActivityUnread, ArtifactCommentId, ArtifactReviewId, ObjectInboxItem, ObjectInboxPreview } from "@botiverse/raft-shared";

import type { ArtifactLinkTarget } from "./artifactLinks";

import { artifactKindIcon } from "./ArtifactCardParts";

/** What an Artifact's Activity row says; core's Activity list draws it in its row (raft-ui InboxItem). */
export interface ArtifactActivityRowParts {
  /** The leading tile's icon: the Artifact's kind, as its link's chip shows it. */
  icon: ReactNode;
  title: string;
  /**
   * Who did what: "Alice mentioned you", "Alice commented", "Alice published
   * v3", "Alice reviewed it (3 comments)", with the name as `renderName` draws
   * it (a conversation row's sender).
   */
  event: ReactNode;
  /**
   * What else is new, after the line, each as said ("· 3 new comments",
   * "· 1 new version"; artifactActivityNews). Empty on a read row.
   */
  news: string[];
}

/**
 * The parts of an Artifact's Activity row (shared activityObjectsContract),
 * its verb from the newest event's kind and why it reached the person: a
 * comment that mentions them, a comment, an edited comment, a new version, a
 * review (S8: several comments at once, counted; one that mentions them says
 * so).
 * `actorName` is the actor as core's rosters name them (null: gone, or
 * unknown); `renderName` draws it inside the sentence, so the name can read
 * as a sender and the rest as the message.
 */
export function artifactActivityRowParts(
  item: ObjectInboxItem<"artifact">,
  actorName: string | null,
  renderName: (name: string) => ReactNode,
  { formatMessage }: Pick<IntlShape, "formatMessage">,
): ArtifactActivityRowParts {
  const name = renderName(actorName ?? formatMessage({ id: "artifacts.activity.someone" }));
  const { summary, target, latestEvent } = item;
  const version = target?.version ?? summary?.latestVersion ?? null;
  const review = artifactActivityReview(item);
  const event = (() => {
    if (review) {
      const count = review.comments;
      return latestEvent.reason === "mentioned"
        ? formatMessage({ id: "artifacts.activity.mentionedYouInReview" }, { name, count })
        : formatMessage({ id: "artifacts.activity.reviewed" }, { name, count });
    }
    if (latestEvent.reason === "mentioned" && latestEvent.eventKind !== "version") {
      return formatMessage({ id: "artifacts.activity.mentionedYou" }, { name });
    }
    // A review a server doesn't name on the row (before it did) reads as its comments.
    if (latestEvent.eventKind === "comment" || latestEvent.eventKind === "review") return formatMessage({ id: "artifacts.activity.commented" }, { name });
    if (latestEvent.eventKind === "comment_edited") return formatMessage({ id: "artifacts.activity.editedComment" }, { name });
    if (latestEvent.eventKind === "version") {
      return version === null
        ? formatMessage({ id: "artifacts.activity.published" }, { name })
        : formatMessage({ id: "artifacts.activity.publishedVersion" }, { name, version });
    }
    return formatMessage({ id: "artifacts.activity.updated" }, { name });
  })();
  return {
    icon: artifactKindIcon(summary?.kind ?? "other"),
    title: summary?.title.trim() || formatMessage({ id: "artifacts.activity.untitled" }),
    event,
    news: artifactActivityNews(item).map(({ part, count }) => formatMessage(
      { id: "artifacts.activity.alsoNew" },
      { news: formatMessage({ id: part === "comments" ? "artifacts.dashboard.newComments" : "artifacts.dashboard.newVersions" }, { count }) },
    )),
  };
}

/**
 * The comment text an Artifact's Activity row shows in place of its sentence,
 * as a message row shows its latest message ("Alice: can you check row 3?"):
 * the server's preview (the newest unread comment, else the newest event's),
 * on a row whose sentence would only say "commented" or "mentioned you" (a
 * comment, or a review the server doesn't name), or a new version's row with
 * new comments too (#81: the comment first). A mention keeps its @ mark,
 * as a message row's does. A comment of images alone is one too (#146; its
 * words: artifactActivityImagesOnly). Null keeps the sentence: no preview, an
 * empty one, a version, an edit, or a counted review.
 */
export function artifactActivityExcerpt(item: ObjectInboxItem<"artifact">): ObjectInboxPreview | null {
  const { preview, latestEvent } = item;
  if (!preview || (preview.text.trim() === "" && !(isCount(preview.images) && preview.images > 0))) return null;
  // A new version on top of new comments (#81): the comment leads, the version follows it (artifactActivityNews).
  if (latestEvent.eventKind === "version") return (artifactActivityUnread(item)?.comments ?? 0) > 0 ? preview : null;
  if (latestEvent.eventKind !== "comment" && latestEvent.eventKind !== "review") return null;
  return artifactActivityReview(item) ? null : preview;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * What an excerpt of a comment with no text says in its place (#146): "Image",
 * or "3 images". Null for an excerpt with text, which shows its text as it is
 * (its images aren't added to it: the row's line has no room for a suffix).
 */
export function artifactActivityImagesOnly(excerpt: ObjectInboxPreview, { formatMessage }: Pick<IntlShape, "formatMessage">): string | null {
  if (excerpt.text.trim() !== "" || !isCount(excerpt.images) || excerpt.images === 0) return null;
  return formatMessage({ id: "artifacts.activity.images" }, { count: excerpt.images });
}

/**
 * What is new on an unread row, by part (#81, the server's `unreadParts`):
 * null on a read row (`unreadCount` 0, also once this client read it), from
 * a server that doesn't split it, or a malformed answer.
 */
export function artifactActivityUnread(item: ObjectInboxItem<"artifact">): ArtifactActivityUnread | null {
  if (item.unreadCount <= 0) return null;
  const parts = item.unreadParts;
  if (!parts || !isCount(parts.versions) || !isCount(parts.comments)) return null;
  return parts.versions + parts.comments > 0 ? parts : null;
}

/**
 * What an unread row adds after its line, comments first (#81, Kirby with
 * xxchan and Remy, #proj-workspace:fc9cbbcd): only what the line doesn't
 * already say. New comments alone: the newest one's text ("Judith: …", #80),
 * and "3 new comments" when there are more than it. New versions alone: the
 * line as before ("Judith published v4"). Both: the comment, then "1 new
 * version". A counted review already says its comments. Empty on a read row.
 */
export function artifactActivityNews(item: ObjectInboxItem<"artifact">): Array<{ part: "comments" | "versions"; count: number }> {
  const unread = artifactActivityUnread(item);
  if (!unread) return [];
  const excerpt = artifactActivityExcerpt(item) !== null;
  const review = artifactActivityReview(item);
  const { eventKind } = item.latestEvent;
  const lineIsComment = excerpt || eventKind === "comment" || (eventKind === "review" && review === null);
  const lineIsVersion = !excerpt && eventKind === "version";
  const news: Array<{ part: "comments" | "versions"; count: number }> = [];
  const commentsSaid = review ? unread.comments <= review.comments : lineIsComment && unread.comments === 1;
  if (unread.comments > 0 && !commentsSaid) news.push({ part: "comments", count: unread.comments });
  if (unread.versions > 0 && !lineIsVersion) news.push({ part: "versions", count: unread.versions });
  return news;
}

/**
 * The version an Artifact's Activity row opens at: the one it is about
 * (`target`) when that is not the latest, else null (the latest). The comment
 * it names has no address yet: the viewer opens at the version's top. Core
 * opens it in Activity's main area beside the list (ArtifactActivityViewer).
 */
export function artifactActivityPinnedVersion(item: ObjectInboxItem<"artifact">): number | null {
  const { summary, target } = item;
  return target && summary && target.version !== summary.latestVersion ? target.version : null;
}

/**
 * The review (S8) the row's newest event posted, as its target names it (`{ id, comments }`):
 * opening the row shows that review's comments. Null for any other event, and for a target
 * without a usable one (the inbox passes targets through as served).
 */
export function artifactActivityReview(item: ObjectInboxItem<"artifact">): { id: ArtifactReviewId; comments: number } | null {
  const review = item.latestEvent.eventKind === "review" ? item.target?.review : undefined;
  if (!review || typeof review.id !== "string" || review.id === "") return null;
  if (!Number.isSafeInteger(review.comments) || review.comments < 1) return null;
  return { id: review.id, comments: review.comments };
}

/**
 * The comment an Artifact's Activity row is about, as its target names it (the newest unread
 * comment, else the newest event's): opening the row lands on it (ArtifactCommentsProvider's
 * `landOn`). Null for a review's row (that opens the review's comments), a version's, and a target
 * without one.
 */
export function artifactActivityComment(item: ObjectInboxItem<"artifact">): ArtifactCommentId | null {
  if (artifactActivityReview(item)) return null;
  const comment = item.target?.comment;
  return typeof comment === "string" && comment !== "" ? comment : null;
}

/** What an Artifact's Activity row opens (its id, at artifactActivityPinnedVersion), or null for an id that isn't an Artifact's. */
export function artifactActivityTarget(item: ObjectInboxItem<"artifact">): ArtifactLinkTarget | null {
  const parsed = parseArtifactRef(item.objectId);
  return parsed.kind === "id" && parsed.id === item.objectId ? { id: parsed.id, version: artifactActivityPinnedVersion(item) } : null;
}
