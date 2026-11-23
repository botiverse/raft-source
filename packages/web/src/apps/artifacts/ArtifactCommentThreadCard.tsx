import { useCallback, useId, useMemo } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
// oxlint-disable-next-line react-doctor/no-flush-sync -- Reply draws and focuses its box within the tap: iOS Safari opens the keyboard only for a focus made during the tap event itself (focus plan rule 5 decision).
import { flushSync } from "react-dom";
import { useIntl } from "react-intl";
import { MapPinOff, Reply } from "lucide-react";
import { Badge, Button } from "@botiverse/raft-ui";
import { CommentCard, CommentCardMeta, CommentCardTrigger, CommentEntryAuthor, CommentEntryHeader, CommentEntryTime } from "@botiverse/raft-ui/wip";
import type { ArtifactComment, ArtifactCommentId } from "@botiverse/raft-shared";

import { formatRelativeTime } from "../../utils/relativeTime";
import { isTextEditableElement } from "../../utils/keyboardShortcuts";
import { AnchorMeta, ArtifactActorAvatar } from "./ArtifactActorParts";
import ArtifactCommentBox from "./ArtifactCommentBox";
import { CommentItem } from "./ArtifactCommentItem";
import { ArtifactDismissableBox } from "./ArtifactDismissableBox";
import { anchorOf } from "./artifactComments";
import type { ArtifactCommentThread } from "./artifactComments";
import { commentFirstLine, threadComments } from "./artifactCommentListOrder";
import type { ArtifactCommentSort } from "./artifactCommentListOrder";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { useAnchorFound } from "./artifactAnchorStatus";
import { PendingReplyDraft, usePendingReplies } from "./ArtifactPendingReplies";
import { useReplyDraftOption } from "./useDraftOption";
import { artifactActorName } from "./artifactFacts";
import { isInputMethodKey } from "./artifactInputMethodKey";
import { ArtifactSearchMarks } from "./ArtifactSearchMarks";
import { ResolveButton, ResolvedBy } from "./ArtifactThreadResolution";
import { useThreadResolution } from "./useThreadResolution";

const NO_TERMS: readonly string[] = [];

/**
 * A thread's card in the comment list (approved prototype, RULES). Collapsed (a thread of two
 * comments or more, until the reader expands it): each comment the reader has seen on one line
 * (avatar, name, the first line of its words, when), then a "New replies N" divider and the new
 * ones in full; a press anywhere on it, or Enter or Space (DS CommentCardTrigger over the card),
 * expands it. Expanded: every comment in full, who resolved it and when, Reply, Resolve or Reopen,
 * and Collapse (Esc too, but where a box or a menu took the key first); the divider stays before
 * what was new when it expanded, and goes once it collapses (all seen). A thread of one comment is
 * always whole, with no Collapse. The anchor line says where it is: in Last updated, which has no
 * groups, also what it is on (the whole Artifact, a file) and, with several files, which file.
 * While the list is searched, the comments that match mark the words searched for (`highlight`, `matching`).
 */
export function ThreadCard({
  thread,
  sort,
  manyFiles,
  expanded,
  single,
  newIds,
  editing,
  replying,
  replyOffered,
  onReply,
  onStopReplying,
  onEdit,
  onStopEditing,
  onDelete,
  onResolved,
  onExpand,
  onCollapse,
  highlight,
  matching,
}: {
  thread: ArtifactCommentThread;
  sort: ArtifactCommentSort;
  /** The Artifact has more than one file (Last updated names a card's file on its anchor line). */
  manyFiles: boolean;
  /** Shown whole (always, for a thread of one comment). */
  expanded: boolean;
  single: boolean;
  /** The comments after the "New replies" divider (useArtifactCommentList `newIn`). */
  newIds: readonly ArtifactCommentId[];
  editing: ArtifactCommentId | null;
  /** This card's reply box, when Reply opened it. */
  replying: { replyTo: ArtifactComment; key: number } | null;
  /** Whether Reply is offered (A, posted at once; B, Send or Save Draft). */
  replyOffered: boolean;
  onReply: (threadId: ArtifactCommentId, comment: ArtifactComment) => void;
  onStopReplying: () => void;
  onEdit: (id: ArtifactCommentId) => void;
  onStopEditing: (id: ArtifactCommentId, wanted?: () => boolean) => void;
  onDelete: (comment: ArtifactComment) => void;
  /** Resolve or Reopen changed it (#249): resolved now, or open. */
  onResolved: (threadId: ArtifactCommentId, resolved: boolean, wanted: () => boolean) => void;
  onExpand: (thread: ArtifactCommentThread) => void;
  onCollapse: (thread: ArtifactCommentThread) => void;
  /** The comment list's search words, folded (artifactCommentSearch); empty: not searching. */
  highlight: readonly string[];
  /** The comments that match them (each word in one comment): only these are marked. Null: not searching. */
  matching: ReadonlySet<ArtifactCommentId> | null;
}) {
  const { formatMessage } = useIntl();
  const comments = useArtifactComments();
  const resolution = useThreadResolution(thread, onResolved);
  const anchor = anchorOf(thread.first);
  const pending = usePendingReplies(thread);
  const found = useAnchorFound(thread.first);
  const metaId = useId();
  const active = comments?.activeThreadId === thread.id;
  const setActive = comments?.setActiveThreadId;
  const activate = useCallback(() => setActive?.(thread.id), [setActive, thread.id]);
  // Under a placeholder (the comment it answers is on an earlier page), a reply answers the first reply. Drawn and
  // focused within the press (flushSync): iOS Safari opens the keyboard only for a focus made during the tap itself, and
  // a Reply is the person asking to type, on touch too.
  const reply = useCallback(() => flushSync(() => onReply(thread.id, thread.root ?? thread.first)), [onReply, thread.id, thread.root, thread.first]);
  const replyTo = replying?.replyTo ?? null;
  const replyMode = useMemo(() => (replyTo ? { kind: "new" as const, target: replyTo.target, replyTo } : null), [replyTo]);
  const { draftOption } = useReplyDraftOption(replyTo);
  const expand = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onExpand(thread);
  }, [onExpand, thread]);
  const collapse = useCallback(() => onCollapse(thread), [onCollapse, thread]);
  // Esc collapses an expanded thread, unless a box (its own Esc), a menu or an input method took it first.
  const keyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !expanded || single || event.defaultPrevented || isInputMethodKey(event)) return;
    const target = event.target as Element;
    if (!event.currentTarget.contains(target) || isTextEditableElement(target)) return;
    event.preventDefault();
    event.stopPropagation();
    onCollapse(thread);
  }, [expanded, single, onCollapse, thread]);

  // Where it is. Under the list's groups (Page order) the group says what it is on; without them, the line does.
  const target = thread.first.target;
  const inFile = sort === "updated" && manyFiles && target.scope === "file" ? target.path : null;
  const place = anchor ? (
    <span className="min-w-0 truncate">
      {inFile !== null
        ? formatMessage({ id: "artifacts.comments.anchorInFile" }, { path: <span className="font-mono">{inFile}</span>, place: <AnchorMeta anchor={anchor} found={found} /> })
        : <AnchorMeta anchor={anchor} found={found} />}
    </span>
  ) : sort === "updated" ? (
    target.scope === "file"
      ? <span className="min-w-0 truncate font-mono">{target.path}</span>
      : <span className="min-w-0 truncate">{formatMessage({ id: "artifacts.comments.groupArtifact" })}</span>
  ) : null;
  const resolvedTag = resolution.resolved ? (
    <Badge appearance="outline" variant="success" className="shrink-0" data-testid="artifact-comment-resolved-tag">
      {formatMessage({ id: "artifacts.comments.resolvedTag" })}
    </Badge>
  ) : null;

  const marksIn = (c: ArtifactComment) => (matching?.has(c.id) ? highlight : NO_TERMS);
  const newSet = new Set(newIds);
  const all = threadComments(thread);
  const firstNew = all.findIndex((c) => newSet.has(c.id));
  const entries: ReactNode[] = [];
  let lines: ArtifactComment[] = [];
  const flush = () => {
    if (lines.length > 0) entries.push(<div key={`lines:${lines[0]!.id}`} className="flex flex-col gap-1">{lines.map((c) => <OneLineEntry key={c.id} comment={c} highlight={marksIn(c)} />)}</div>);
    lines = [];
  };
  all.forEach((c, index) => {
    if (index === firstNew) {
      flush();
      entries.push(<NewRepliesDivider key="new" count={newSet.size} />);
    }
    if (expanded || (firstNew >= 0 && index >= firstNew)) {
      flush();
      entries.push(<CommentItem key={c.id} comment={c} editing={editing === c.id} onEdit={onEdit} onStopEditing={onStopEditing} onDelete={onDelete} highlight={marksIn(c)} />);
    } else lines.push(c);
  });
  flush();

  return (
    <CommentCard
      active={active}
      aria-current={active || undefined}
      tabIndex={-1}
      onClick={activate}
      onFocus={activate}
      onKeyDown={keyDown}
      data-thread-id={thread.id}
      data-testid="artifact-comment-thread"
      data-expanded={expanded || undefined}
      className="outline-none"
    >
      {expanded ? null : (
        <CommentCardTrigger
          aria-label={formatMessage({ id: "artifacts.comments.expandThread" }, { name: artifactActorName(thread.first.author, formatMessage) })}
          aria-expanded={false}
          aria-describedby={place ? metaId : undefined}
          onClick={expand}
          data-testid="artifact-comment-thread-expand"
        />
      )}
      {place && anchor && expanded ? (
        // A button: from the keyboard too, it makes this the thread being read (its passage takes the active highlight).
        // raft-ui's CommentCardMeta draws a button render as clickable text: the hover underline and the focus ring.
        <CommentCardMeta render={<button type="button" />} onClick={activate} data-testid="artifact-comment-anchor" data-found={found ? "true" : "false"}>
          {found ? null : <MapPinOff aria-hidden />}
          {place}
          {resolvedTag}
        </CommentCardMeta>
      ) : place || resolvedTag ? (
        // Collapsed, the whole card is its button: the line is words under it.
        <CommentCardMeta id={metaId} data-testid={anchor ? "artifact-comment-anchor" : "artifact-comment-where"} data-found={anchor ? (found ? "true" : "false") : undefined}>
          {anchor && !found ? <MapPinOff aria-hidden /> : null}
          {place}
          {resolvedTag}
        </CommentCardMeta>
      ) : null}
      {thread.root ? null : (
        <p className="text-callout text-foreground-hint italic" data-testid="artifact-comment-earlier-placeholder">
          {formatMessage({ id: "artifacts.comments.replyToEarlier" })}
        </p>
      )}
      {entries}
      {expanded ? pending.map((draft) => <PendingReplyDraft key={draft.id} draft={draft} thread={thread} />) : null}
      {expanded && resolution.resolved ? <ResolvedBy root={thread.root!} /> : null}
      {!expanded ? null : replyMode && replying ? (
        <ArtifactDismissableBox onDismiss={onStopReplying}>
          <ArtifactCommentBox key={replying.key} mode={replyMode} draftOption={draftOption} onCancel={onStopReplying} onDone={onStopReplying} autoFocusKey={replying.key} />
        </ArtifactDismissableBox>
      ) : (replyOffered && comments?.data.capabilities.comment) || resolution.may || !single ? (
        <div className="flex flex-wrap items-center gap-1">
          {replyOffered && comments?.data.capabilities.comment ? (
            <Button variant="ghost" size="md" onClick={reply} data-testid="artifact-comment-reply">
              <Reply />
              {formatMessage({ id: "artifacts.comments.reply" })}
            </Button>
          ) : null}
          <ResolveButton resolution={resolution} />
          {single ? null : (
            <Button variant="ghost" size="md" aria-expanded onClick={collapse} className="ms-auto text-foreground-muted" data-testid="artifact-comment-thread-collapse">
              {formatMessage({ id: "artifacts.comments.collapse" })}
            </Button>
          )}
        </div>
      ) : null}
    </CommentCard>
  );
}

/**
 * A seen comment of a collapsed thread, on one line (raft-ui has no part for it): CommentEntryHeader's
 * row (avatar, name, when) with the first line of its words between name and time, muted and cut;
 * the search words marked in the name and the line.
 */
function OneLineEntry({ comment, highlight }: { comment: ArtifactComment; highlight: readonly string[] }) {
  const { formatMessage, locale } = useIntl();
  if (comment.deletedAt) {
    return (
      <CommentEntryHeader data-testid="artifact-comment-line" data-comment-id={comment.id}>
        <span className="min-w-0 flex-1 truncate text-callout text-foreground-hint italic">{formatMessage({ id: "artifacts.comments.deleted" })}</span>
      </CommentEntryHeader>
    );
  }
  const images = comment.images?.length ?? 0;
  const line = commentFirstLine(comment) || (images > 0 ? formatMessage({ id: "artifacts.activity.images" }, { count: images }) : "");
  return (
    <CommentEntryHeader data-testid="artifact-comment-line" data-comment-id={comment.id}>
      <ArtifactActorAvatar actor={comment.author} context="comment-entry" />
      <CommentEntryAuthor className="shrink-0"><ArtifactSearchMarks text={artifactActorName(comment.author, formatMessage)} terms={highlight} /></CommentEntryAuthor>
      <span className="min-w-0 flex-1 truncate text-callout text-foreground-muted"><ArtifactSearchMarks text={line} terms={highlight} /></span>
      <CommentEntryTime dateTime={comment.createdAt} className="ms-auto ps-1">{formatRelativeTime(comment.createdAt, locale) ?? ""}</CommentEntryTime>
    </CommentEntryHeader>
  );
}

/** Where a thread's new comments start (new UI): a yellow rule either side of "New replies N". */
function NewRepliesDivider({ count }: { count: number }) {
  const { formatMessage } = useIntl();
  const label = formatMessage({ id: "artifacts.comments.newReplies" }, { count });
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-2 py-0.5" data-testid="artifact-comment-new-divider">
      <span aria-hidden className="h-[1.5px] flex-1 bg-brand" />
      <span aria-hidden className="shrink-0 font-mono text-mono-meta font-bold text-foreground">{label}</span>
      <span aria-hidden className="h-[1.5px] flex-1 bg-brand" />
    </div>
  );
}
