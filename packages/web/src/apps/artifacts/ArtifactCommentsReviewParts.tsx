import { useCallback, useRef } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ListFilter } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItemLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  PickerTriggerButton,
} from "@botiverse/raft-ui";
import {
  CommentCard,
  CommentEntry,
  CommentEntryAuthor,
  CommentEntryBody,
  CommentEntryHeader,
  CommentEntryTime,
  FilterChip,
  FilterChipLabel,
  FilterChipRemove,
} from "@botiverse/raft-ui/wip";
import type { ArtifactCommentPart, ArtifactWebReview } from "@botiverse/raft-shared";

import { formatRelativeTime } from "../../utils/relativeTime";
import { AgentTag, ArtifactActorAvatar } from "./ArtifactActorParts";
import { ArtifactCommentText } from "./ArtifactCommentText";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { artifactActorName } from "./artifactFacts";

/**
 * Opened at a review (its Activity row): the DS filter pair (Select › Which filter button), a Filter
 * button that always says Filter, its menu All comments or the review, and while the review filters
 * the list a FilterChip naming it ("Review by Remy"), whose × shows every comment and gives focus to
 * the Filter button (filter-chip.md). 8px between them, 16px from the chip to the close button: the
 * ×'s touch target reaches 10px past the chip's end. Not before the review's page answered (nothing
 * to name it by yet), nor where its owner can't show it again once left.
 */
export function ReviewFilter() {
  const { formatMessage } = useIntl();
  const comments = useArtifactComments();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const filter = comments?.reviewFilter ?? null;
  const showAll = comments?.showAllComments;
  const show = filter?.show ?? null;
  const choose = useCallback((value: unknown) => {
    if (value === "all") showAll?.();
    else if (value === "review") show?.();
  }, [showAll, show]);
  const clear = useCallback(() => {
    showAll?.();
    buttonRef.current?.focus();
  }, [showAll]);
  const shownReview = comments?.shownReview ?? null;
  if (!comments || !filter || !filter.author || (!filter.shown && !show)) return null;
  // A review that didn't load, or isn't this Artifact's, says so in its strip instead of a chip.
  if (filter.shown && shownReview?.status !== "ok") return null;
  const reviewLabel = formatMessage({ id: "artifacts.comments.reviewFilter" }, { name: artifactActorName(filter.author, formatMessage) });
  return (
    <span className="me-4 flex min-w-0 items-center gap-2" data-testid="artifact-comments-filter">
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={buttonRef}
          className="data-popup-open:bg-fill-medium"
          render={<PickerTriggerButton type="button" />}
          data-testid="artifact-comments-filter-button"
        >
          <ListFilter aria-hidden data-icon="inline-start" />
          {formatMessage({ id: "artifacts.comments.filter" })}
          <span data-picker-trigger-indicator="" aria-hidden="true">
            <ChevronDown />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label={formatMessage({ id: "artifacts.comments.filterLabel" })} data-testid="artifact-comments-filter-menu">
          <DropdownMenuRadioGroup value={filter.shown ? "review" : "all"} onValueChange={choose}>
            <DropdownMenuRadioItem value="all" data-testid="artifact-comments-filter-all">
              <DropdownMenuItemLabel>{formatMessage({ id: "artifacts.comments.filterAll" })}</DropdownMenuItemLabel>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="review" disabled={!filter.shown && !show} data-testid="artifact-comments-filter-review">
              <DropdownMenuItemLabel>{reviewLabel}</DropdownMenuItemLabel>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {filter.shown ? (
        <FilterChip className="min-w-0" data-testid="artifact-comments-review-only" data-review="ok">
          <FilterChipLabel className="truncate">{reviewLabel}</FilterChipLabel>
          <FilterChipRemove aria-label={formatMessage({ id: "artifacts.comments.reviewShowAll" })} onClick={clear} data-testid="artifact-comments-review-show-all" />
        </FilterChip>
      ) : null}
    </span>
  );
}

/**
 * A review's summary (S8, the page's `review.body`): on the whole Artifact, after its comments when posted, shown first
 * here, as its author's entry (avatar, name, time; #250: no "Summary by" line, the header's chip names the review).
 */
export function ReviewSummary({ review, body }: { review: ArtifactWebReview; body: ArtifactCommentPart[] }) {
  const { formatMessage, locale } = useIntl();
  const comments = useArtifactComments();
  return (
    <CommentCard data-testid="artifact-comments-review-summary">
      <CommentEntry>
        <CommentEntryHeader>
          <ArtifactActorAvatar actor={review.author} context="comment-entry" />
          <CommentEntryAuthor>{artifactActorName(review.author, formatMessage)}</CommentEntryAuthor>
          {review.author.type === "agent" ? <AgentTag /> : null}
          <CommentEntryTime dateTime={review.createdAt}>{formatRelativeTime(review.createdAt, locale) ?? ""}</CommentEntryTime>
        </CommentEntryHeader>
        <CommentEntryBody data-testid="artifact-comments-review-summary-body">
          <ArtifactCommentText body={body} viewer={comments?.viewer ?? null} />
        </CommentEntryBody>
      </CommentEntry>
    </CommentCard>
  );
}
