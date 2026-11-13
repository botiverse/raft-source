// What a comment box says about an image that can't go (#proj-workspace:#146): the whole sentence
// (why, the limit, what to do) for its thumbnail's accessible name (its Retry's, where Retry may
// help) and the line under the box; the 64px thumbnail itself holds no words (Kirby, #12929) (raft-design message-attachment.md "say why and give the limit";
// feedback.md: what happened, why, what next).
import type { IntlShape } from "react-intl";
import { ARTIFACT_COMMENT_IMAGE_MAX_BYTES } from "@botiverse/raft-shared";

import type { CommentImageItem } from "./useCommentImageAttachments";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** Core's pixel cap, said when a refusal gives no limit of its own. */
const DEFAULT_PIXEL_LIMIT = 40_000_000;
/** Core's per-person limits on a server (drafts at once, all images), said when a refusal gives no limit. */
const DEFAULT_DRAFT_LIMIT_BYTES = 100 * MIB;
const DEFAULT_UPLOADER_LIMIT_BYTES = GIB;

/** The image's name in the box: its file's, or "Image N" for one restored from this device. */
export function commentImageName(item: Pick<CommentImageItem, "name">, index: number, intl: Pick<IntlShape, "formatMessage">): string {
  return item.name ?? intl.formatMessage({ id: "artifacts.comments.images.name" }, { index: index + 1 });
}

/** Why the image can't go, as a sentence; null for one uploading or uploaded. */
export function commentImageProblem(item: CommentImageItem, intl: Pick<IntlShape, "formatMessage">): { detail: string } | null {
  const { formatMessage } = intl;
  if (item.status === "expired") {
    return { detail: formatMessage({ id: "artifacts.comments.images.expiredDetail" }) };
  }
  if (item.status !== "failed") return null;
  const { failure } = item;
  if (failure.kind === "failed") {
    return { detail: formatMessage({ id: "artifacts.comments.images.failedDetail" }) };
  }
  if (failure.kind === "quota") {
    switch (failure.reason) {
      case "monthly":
        return { detail: formatMessage({ id: "artifacts.comments.images.quotaDetail" }) };
      case "storage":
        return { detail: formatMessage({ id: "artifacts.comments.images.storageDetail" }) };
      case "drafts":
        return {
          detail: formatMessage({ id: "artifacts.comments.images.draftsFullDetail" }, { limit: Math.round((failure.limit ?? DEFAULT_DRAFT_LIMIT_BYTES) / MIB) }),
        };
      case "uploads":
        return {
          detail: formatMessage({ id: "artifacts.comments.images.uploadsFullDetail" }, { limit: Math.round((failure.limit ?? DEFAULT_UPLOADER_LIMIT_BYTES) / GIB) }),
        };
    }
  }
  switch (failure.reason) {
    case "too_large":
      return {
        detail: formatMessage({ id: "artifacts.comments.images.tooLargeDetail" }, { limit: Math.round((failure.limit ?? ARTIFACT_COMMENT_IMAGE_MAX_BYTES) / MIB) }),
      };
    case "too_many_pixels":
      return {
        detail: formatMessage({ id: "artifacts.comments.images.tooManyPixelsDetail" }, { limit: Math.round((failure.limit ?? DEFAULT_PIXEL_LIMIT) / 1_000_000) }),
      };
    case "empty":
      return { detail: formatMessage({ id: "artifacts.comments.images.emptyDetail" }) };
    case "unsupported_type":
      return { detail: formatMessage({ id: "artifacts.comments.images.notImageDetail" }) };
  }
}
