import { useCallback, useRef } from "react";
import type { ChangeEvent } from "react";
import type { IntlShape } from "react-intl";
import { useIntl } from "react-intl";
import { ImagePlus, TriangleAlert } from "lucide-react";
import {
  Banner,
  BannerClose,
  BannerDescription,
  BannerTitle,
  ComposerDropOverlay,
  ComposerDropOverlayLabel,
  ComposerIconButton,
} from "@botiverse/raft-ui";
import { ARTIFACT_COMMENT_IMAGE_MAX_BYTES, ARTIFACT_COMMENT_MAX_IMAGES } from "@botiverse/raft-shared";

import Tooltip from "../../components/ui/Tooltip";
import { COMMENT_IMAGE_ACCEPT } from "./artifactCommentImageFiles";
import type { CommentImageRefusal } from "./artifactCommentImageFiles";
import { commentImageName, commentImageProblem } from "./artifactCommentImageText";
import type { CommentImageItem } from "./useCommentImageAttachments";

/**
 * The box's Add Image tool (raft-ui ComposerIconButton, with its tooltip): opens the file picker for
 * images. On when the box is full too: what can't be taken is said (the DS attachment limit).
 */
export function CommentImageAttachButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  const { formatMessage } = useIntl();
  const input = useRef<HTMLInputElement>(null);
  const label = formatMessage({ id: "artifacts.comments.images.attach" });
  const pick = useCallback(() => input.current?.click(), []);
  const picked = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    // The same file picked again is a change too.
    event.currentTarget.value = "";
    if (files.length > 0) onFiles(files);
  }, [onFiles]);
  return (
    <>
      <input ref={input} type="file" accept={COMMENT_IMAGE_ACCEPT} multiple hidden onChange={picked} data-testid="artifact-comment-image-input" />
      <Tooltip content={label}>
        <ComposerIconButton type="button" onClick={pick} aria-label={label} data-testid="artifact-comment-attach-image">
          <ImagePlus size={18} />
        </ComposerIconButton>
      </Tooltip>
    </>
  );
}

/**
 * What the box shows while files are dragged over it (raft-ui ComposerDropOverlay): the Add Image tool's icon, no words
 * (#250: the drop target explains itself; raft-ui's ComposerDropOverlayPrompt has English words and a file icon of its own).
 */
export function CommentImageDropOverlay() {
  return (
    <ComposerDropOverlay aria-hidden data-testid="artifact-comment-drop-overlay">
      <ComposerDropOverlayLabel>
        <ImagePlus size={24} />
      </ComposerDropOverlayLabel>
    </ComposerDropOverlay>
  );
}

const REFUSAL_ORDER: CommentImageRefusal[] = ["unreadable", "type", "size", "count"];

/** Why files weren't attached, one sentence per reason (a paste no longer readable, the type, the size cap, the count cap). */
function refusalLines(refused: ReadonlySet<CommentImageRefusal> | null, formatMessage: IntlShape["formatMessage"]): string[] {
  return REFUSAL_ORDER.filter((reason) => refused?.has(reason)).map((reason) => {
    switch (reason) {
      case "unreadable":
        return formatMessage({ id: "artifacts.comments.images.refusedUnreadable" });
      case "type":
        return formatMessage({ id: "artifacts.comments.images.refusedType" });
      case "size":
        return formatMessage({ id: "artifacts.comments.images.refusedSize" }, { limit: Math.round(ARTIFACT_COMMENT_IMAGE_MAX_BYTES / (1024 * 1024)) });
      case "count":
        return formatMessage({ id: "artifacts.comments.images.refusedCount" }, { limit: ARTIFACT_COMMENT_MAX_IMAGES });
    }
  });
}

/**
 * Why files weren't attached (the box's own check), as the DS composer's attachment limit says it
 * (raft-design chat-composer composer-attachment-limit): a warning Banner above the box, dismissed
 * with its ×, gone once the box's images change. It mounts when it has something to say, so it is
 * no live region: the same words go into the line under the box (CommentImageUnresolvedNote), which
 * is always there.
 */
export function CommentImageRefusedBanner({ refused, onDismiss, size }: {
  refused: ReadonlySet<CommentImageRefusal> | null;
  onDismiss: () => void;
  /** `md` in a full-width box (the list's foot, as the composition), `sm` in a card. */
  size: "sm" | "md";
}) {
  const { formatMessage } = useIntl();
  const lines = refusalLines(refused, formatMessage);
  if (lines.length === 0) return null;
  return (
    <Banner status="warning" size={size} data-testid="artifact-comment-image-refused">
      <TriangleAlert />
      <BannerTitle>{formatMessage({ id: "artifacts.comments.images.notAttached" })}</BannerTitle>
      <BannerDescription>{lines.join(" ")}</BannerDescription>
      {/* The × of an Artifact's warning Banner: the page error's word ("Dismiss"). */}
      <BannerClose aria-label={formatMessage({ id: "artifacts.pageError.dismiss" })} onClick={onDismiss} />
    </Banner>
  );
}

/** Each refusal (a new set from the box) its own number, so the same words refused again are read again. */
const refusalIds = new WeakMap<ReadonlySet<CommentImageRefusal>, number>();
let lastRefusalId = 0;
function refusalId(refused: ReadonlySet<CommentImageRefusal>): number {
  let id = refusalIds.get(refused);
  if (id === undefined) {
    lastRefusalId += 1;
    id = lastRefusalId;
    refusalIds.set(refused, id);
  }
  return id;
}

/**
 * What keeps the box from sending, for each image that can't go: its name, why, and what to do
 * (the line under the box), and why files weren't attached (the Banner's sentences, for assistive
 * tech only: the Banner shows them). Always there, a polite live region, so a failure that comes later,
 * or a refusal as its Banner mounts, is read out; nothing to say, it is empty and takes no room.
 */
export function CommentImageUnresolvedNote({ items, refused }: { items: readonly CommentImageItem[]; refused: ReadonlySet<CommentImageRefusal> | null }) {
  const intl = useIntl();
  const lines = items.flatMap((item, index) => {
    const problem = commentImageProblem(item, intl);
    return problem ? [{ key: item.key, text: intl.formatMessage({ id: "artifacts.comments.images.problem" }, { name: commentImageName(item, index, intl), detail: problem.detail }) }] : [];
  });
  const refusal = refusalLines(refused, intl.formatMessage);
  return (
    <div
      aria-live="polite"
      className={lines.length > 0 ? "flex flex-col gap-0.5 text-footnote text-foreground-muted" : "sr-only"}
      data-testid="artifact-comment-image-unresolved"
    >
      {refused && refusal.length > 0 ? (
        <p key={`refused-${refusalId(refused)}`} className="sr-only" data-testid="artifact-comment-image-refused-said">
          {refusal.join(" ")}
        </p>
      ) : null}
      {lines.map((line) => <p key={line.key}>{line.text}</p>)}
    </div>
  );
}
