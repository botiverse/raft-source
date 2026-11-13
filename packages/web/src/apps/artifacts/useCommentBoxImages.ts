// A comment box's images (#proj-workspace:#146), wired to the box: its uploads
// (useCommentImageAttachments), pasting and dropping them, and how many it holds for the box's own
// "the person's content" (an image alone is, as words are).
import { useCallback, useRef } from "react";
import type { ClipboardEvent, MutableRefObject } from "react";
import type { ArtifactCommentImage, ArtifactId } from "@botiverse/raft-shared";

import { extractClipboardFiles } from "../../utils/clipboardFiles";
import { useCommentImageAttachments, useCommentImageDrop } from "./useCommentImageAttachments";

/** What the box does when its images change, set after its own callbacks exist (read when told). */
export interface CommentBoxImageListeners {
  /** The uploaded images changed (attached, removed, gone): kept on this device with the words. */
  changed: (ready: ArtifactCommentImage[]) => void;
  /** How many it holds changed: the box says again whether it holds the person's content. */
  counted: () => void;
}

/**
 * `attachable`: a new comment's or a reply's box (an edit keeps its images as they are). `restored`:
 * the images kept on this device with its words. `count` is how many the box holds now, for the
 * box's "own content" when it is told (`counted`), before React renders it.
 */
export function useCommentBoxImages(
  artifactId: ArtifactId | null,
  attachable: boolean,
  restored: readonly ArtifactCommentImage[] | null,
  listeners: MutableRefObject<CommentBoxImageListeners>,
) {
  const kept = attachable ? restored : null;
  const count = useRef(kept?.length ?? 0);
  const images = useCommentImageAttachments(artifactId, kept, (ready) => listeners.current.changed(ready), (next) => {
    count.current = next;
    listeners.current.counted();
  });
  const { add, addPasted } = images;
  // Images pasted (a screenshot copied) are attached; text pastes as ever. Their bytes are copied
  // into memory at paste time (addPasted): a clipboard File can become unreadable once the paste
  // event ends (Chromium then fails the preview and the upload with net::ERR_ACCESS_DENIED, every
  // retry too). One that can't be read even now is said in the box's refusal, never dropped silently.
  const pasted = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = extractClipboardFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    addPasted(files);
  }, [addPasted]);
  const drop = useCommentImageDrop(attachable, add);
  return { images, count, pasted: attachable ? pasted : undefined, drop };
}
