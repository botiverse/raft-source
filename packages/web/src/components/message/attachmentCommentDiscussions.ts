// Discussions in the comment margin (task #118, raft-design patterns/comments.md).
//
// A comment is a flat message with an optional anchor. The margin shows one
// card per discussion: the comments that share an anchor, in time order, the
// first one the card's head and the rest its replies. Every comment without
// an anchor is on the whole file, and they form one discussion. A reply in a
// card is posted with the card's anchor, so it lands back in the same card.

import type { StoredAnchor } from "./attachmentCommentAnchors";
import type { AttachmentComment } from "./useAttachmentComments";

/** The key of the discussion about the whole file (unanchored comments). */
export const WHOLE_FILE_DISCUSSION_KEY = "file";

export type CommentDiscussion = {
  /** Stable across reloads: the anchor's type and data, or the whole file. */
  key: string;
  /** null for the whole-file discussion. */
  anchor: StoredAnchor | null;
  /** Oldest first; optimistic comments sit at the end until delivered. */
  comments: AttachmentComment[];
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

/**
 * The discussion key of an anchor: its type and its data with the keys
 * sorted, so the anchor a comment was sent with and the one the server
 * returns (jsonb reorders keys) are the same discussion.
 */
export function discussionKey(anchor: Pick<StoredAnchor, "type" | "data"> | null | undefined): string {
  if (!anchor) return WHOLE_FILE_DISCUSSION_KEY;
  return `${anchor.type}:${JSON.stringify(canonical(anchor.data ?? {}))}`;
}

/** Groups comments into discussions, in the order each was started. */
export function groupDiscussions(
  comments: readonly AttachmentComment[],
  pending: readonly AttachmentComment[] = [],
): CommentDiscussion[] {
  const byKey = new Map<string, CommentDiscussion>();
  const delivered = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const comment of [...delivered, ...pending]) {
    const key = discussionKey(comment.anchor);
    let discussion = byKey.get(key);
    if (!discussion) {
      discussion = { key, anchor: comment.anchor, comments: [] };
      byKey.set(key, discussion);
    }
    discussion.comments.push(comment);
  }
  return [...byKey.values()];
}

/** A short, stable id for a discussion key (draft keys, DOM ids). */
export function discussionHash(key: string): string {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}
