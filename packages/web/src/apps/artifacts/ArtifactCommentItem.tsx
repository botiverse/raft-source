import { useCallback, useMemo, useState } from "react";
// oxlint-disable-next-line react-doctor/no-flush-sync -- Edit draws and focuses its box within the tap: iOS Safari opens the keyboard only for a focus made during the tap event itself (focus plan rule 5 decision).
import { flushSync } from "react-dom";
import { useIntl } from "react-intl";
import { EllipsisVertical, Pencil, Trash2 } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@botiverse/raft-ui";
import { CommentIcon } from "@botiverse/ricons";
import { CommentEntry, CommentEntryAuthor, CommentEntryBody, CommentEntryHeader, CommentEntryTime } from "@botiverse/raft-ui/wip";
import type { ArtifactComment, ArtifactCommentId } from "@botiverse/raft-shared";

import type { ArtifactCardListWay } from "./artifactCardHold";

import { formatRelativeTime } from "../../utils/relativeTime";
import { AgentTag, ArtifactActorAvatar } from "./ArtifactActorParts";
import { ArtifactCommentText } from "./ArtifactCommentText";
import { ArtifactCommentGallery } from "./ArtifactCommentGallery";
import ArtifactCommentBox from "./ArtifactCommentBox";
import { ArtifactDismissableBox } from "./ArtifactDismissableBox";
import { actorKey, isOwnComment } from "./artifactComments";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { ArtifactVersionBadge } from "./ArtifactMessageCard";
import { artifactActorName } from "./artifactFacts";
import { ArtifactSearchMarks } from "./ArtifactSearchMarks";

const NO_TERMS: readonly string[] = [];

/**
 * One comment in full (DS Comment's CommentEntry): its author, when, edited, the version it was
 * written on when another is shown, its ⋯ (Edit and Delete for its author; the list's way for a
 * card that has none), and its words and images, or its edit box. A deleted one with replies
 * kept is a placeholder for them. In a thread's card in the list and in a marker's card. The list's
 * search words (`highlight`) are marked in its author's name and its words.
 */
export function CommentItem({
  comment,
  editing,
  onEdit,
  onStopEditing,
  onDelete,
  listWay = null,
  inCard = false,
  highlight = NO_TERMS,
}: {
  comment: ArtifactComment;
  editing: boolean;
  onEdit: (id: ArtifactCommentId) => void;
  onStopEditing: (id: ArtifactCommentId, wanted?: () => boolean, pressed?: boolean) => void;
  onDelete: (comment: ArtifactComment) => void;
  /** First in this comment's ⋯, which it brings to a comment that has none: anyone's, or one being edited. */
  listWay?: ArtifactCardListWay | null;
  /** In the open thread's card (its edit box keeps the card while it holds words). */
  inCard?: boolean;
  /** The comment list's search words, folded (artifactCommentSearch); none: nothing marked. */
  highlight?: readonly string[];
}) {
  const intl = useIntl();
  const { formatMessage, locale } = intl;
  const comments = useArtifactComments();
  const viewer = comments?.viewer ?? null;
  const own = isOwnComment(comment, viewer);
  const shownVersion = comments?.data.card.version;
  // Drawn and focused within the press (flushSync), as Reply: iOS Safari opens the keyboard only for a focus made during
  // the tap itself, and an Edit is the person asking to type, on touch too.
  const edit = useCallback(() => flushSync(() => onEdit(comment.id)), [onEdit, comment.id]);
  const remove = useCallback(() => onDelete(comment), [onDelete, comment]);
  const editMode = useMemo(() => ({ kind: "edit" as const, comment }), [comment]);
  const stop = useCallback(() => onStopEditing(comment.id), [onStopEditing, comment.id]);
  const saved = useCallback((wanted?: () => boolean) => onStopEditing(comment.id, wanted), [onStopEditing, comment.id]);
  // The ⋯ menu stays while it is open (its items go): Edit's box takes focus within the tap, then the menu closes with
  // focus already out of it, so it gives none back (gone in the same commit, it would hand focus to an earlier element
  // after the tap).
  const [menuOpen, setMenuOpen] = useState(false);
  const pressedOutside = useCallback(() => onStopEditing(comment.id, undefined, true), [onStopEditing, comment.id]);
  if (comment.deletedAt) {
    // Kept for its replies (contract #10877): no author, no text.
    return (
      <CommentEntry data-testid="artifact-comment-deleted" data-comment-id={comment.id}>
        <CommentEntryBody className="text-foreground-hint italic">{formatMessage({ id: "artifacts.comments.deleted" })}</CommentEntryBody>
      </CommentEntry>
    );
  }
  const authorName = artifactActorName(comment.author, formatMessage);
  const moreLabel = formatMessage({ id: "artifacts.comments.more" }, { name: authorName });
  const writable = own && !editing;
  return (
    <CommentEntry data-testid="artifact-comment" data-comment-id={comment.id} data-author={actorKey(comment.author)}>
      <CommentEntryHeader>
        <ArtifactActorAvatar actor={comment.author} context="comment-entry" />
        <CommentEntryAuthor><ArtifactSearchMarks text={authorName} terms={highlight} /></CommentEntryAuthor>
        {comment.author.type === "agent" ? <AgentTag /> : null}
        <CommentEntryTime dateTime={comment.createdAt}>{formatRelativeTime(comment.createdAt, locale) ?? ""}</CommentEntryTime>
        {comment.editedAt ? (
          <span className="shrink-0 text-caption text-foreground-hint" data-testid="artifact-comment-edited">
            {formatMessage({ id: "artifacts.comments.edited" })}
          </span>
        ) : null}
        {shownVersion !== undefined && comment.version !== shownVersion ? (
          <span className="shrink-0" data-testid="artifact-comment-version"><ArtifactVersionBadge version={comment.version} /></span>
        ) : null}
        {writable || listWay || menuOpen ? (
          <DropdownMenu onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              render={(
                <Button variant="ghost" size="icon-md" className="ms-auto" aria-label={moreLabel} data-testid="artifact-comment-menu">
                  <EllipsisVertical />
                </Button>
              )}
            />
            <DropdownMenuContent side="bottom" align="end" aria-label={moreLabel}>
              {listWay ? (
                <DropdownMenuItem onClick={listWay.open} disabled={listWay.off} data-testid="artifact-comment-open-in-list">
                  <CommentIcon />
                  {formatMessage({ id: "artifacts.comments.openInList" })}
                </DropdownMenuItem>
              ) : null}
              {writable ? (
                <>
                  {/* Relies on Base UI calling this onClick before its own close: flushSync commits the box while the menu is still open (menuOpen above). */}
                  <DropdownMenuItem onClick={edit} data-testid="artifact-comment-edit">
                    <Pencil />
                    {formatMessage({ id: "artifacts.comments.edit" })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={remove} data-testid="artifact-comment-delete">
                    <Trash2 />
                    {formatMessage({ id: "artifacts.comments.delete" })}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </CommentEntryHeader>
      {editing ? (
        <ArtifactDismissableBox onDismiss={pressedOutside}>
          <ArtifactCommentBox mode={editMode} onDone={saved} onCancel={stop} autoFocusKey={1} inCard={inCard} />
        </ArtifactDismissableBox>
      ) : (
        <>
          <CommentEntryBody data-testid="artifact-comment-body">
            <ArtifactCommentText body={comment.body} viewer={viewer} highlight={highlight} />
          </CommentEntryBody>
          <ArtifactCommentGallery artifactId={comments?.data.card.id ?? null} images={comment.images} />
        </>
      )}
    </CommentEntry>
  );
}
