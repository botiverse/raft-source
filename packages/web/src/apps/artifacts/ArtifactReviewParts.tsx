import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// oxlint-disable-next-line react-doctor/no-flush-sync -- Edit draws and focuses its box within the tap: iOS Safari opens the keyboard only for a focus made during the tap event itself (focus plan rule 5 decision).
import { flushSync } from "react-dom";
import { useIntl } from "react-intl";
import { useShortcut } from "../../features/shortcuts";
import { ChevronDown, EllipsisVertical, MonitorSmartphone, Pencil, Redo2, SquareDashedMousePointer, Trash2, Undo2 } from "lucide-react";
import {
  Badge,
  Banner,
  BannerDescription,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  PanelToggleAction,
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  Separator,
  Text,
} from "@botiverse/raft-ui";
import { AddCommentIcon, CommentIcon } from "@botiverse/ricons";
import { CommentCard, CommentCardMeta, PopoverBody, PanelSplitAction, PanelSplitActionMenu, PanelSplitActionToggle } from "@botiverse/raft-ui/wip";

import Tooltip from "../../components/ui/Tooltip";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { requestFocus } from "../../utils/focusRequest";
import { DraftPlace } from "./ArtifactActorParts";
import { ArtifactCardShell } from "./ArtifactCardShell";
import { ArtifactCommentText } from "./ArtifactCommentText";
import { ArtifactCommentGallery } from "./ArtifactCommentGallery";
import { commentCount, useArtifactComments } from "./ArtifactCommentsContext";
import { useDeleteDraft } from "./artifactDraftDelete";
import { trackArtifactViewerAction } from "./artifactAnalytics";
import ArtifactCommentBox from "./ArtifactCommentBox";
import { ArtifactDismissableBox } from "./ArtifactDismissableBox";
import type { ArtifactCommentBoxBatch } from "./ArtifactCommentBox";
import { PHONE_QUERY } from "./artifactPhoneHistory";
import { useArtifactReview } from "./ArtifactReviewContext";
import type { ArtifactDraftView } from "./ArtifactReviewContext";
import { ArtifactReviewSheet } from "./ArtifactReviewPanel";
import { useArmed } from "./useArmed";
import { useDismissable } from "./useArtifactDismiss";
import { anchorAt } from "./ArtifactCommentBubble";
import { draftDaysLeft, draftExpiresSoon } from "./artifactReviewDrafts";
import { SelectionBox } from "./ArtifactSelectionComposer";

/** A draft's text holds block Markdown (ArtifactCommentText): a div, never Text's p. */
const DRAFT_BODY_ELEMENT = <div />;

/** A field whose own undo ⌘Z is: the drafts' undo / redo leave it alone. */
const FIELD_SELECTOR = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/**
 * The header's comment-mode controls: the Comment button (its left half enters and leaves comment
 * mode, pressed there and in C) and its ▾, which carries the comment count and whose Show All
 * Comments (N) opens the comment list in any state (co-design S8), then, where `onReportDisplay`
 * (the reader may comment), Doesn't display well here (#proj-workspace:#243). No drafts count and no Submit
 * here (#proj-workspace:#148): the bar at the content's foot says how many drafts wait and sends
 * them (ArtifactReviewBar). Shown at every width: on a phone they are how comment mode is reached.
 * Drafts that didn't load say so here, with Retry (no count is better than a wrong one). A review
 * posted brings focus back to the Comment button (the panel that had it is gone). No how-to hint on
 * touch (#proj-workspace:#250).
 */
export function ArtifactReviewHeaderActions({ onReportDisplay = null }: {
  /** Doesn't display well here: opens the comment list's box with what it measured (useArtifactDisplayReport); null: not offered. */
  onReportDisplay?: (() => void) | null;
}) {
  const { formatMessage } = useIntl();
  const review = useArtifactReview();
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const toggleFocus = review?.toggleFocus ?? 0;
  useEffect(() => {
    if (toggleFocus === 0) return;
    // After the frame: the comment list the review opens focuses its region when it mounts, in the same commit. The
    // send's answer: not from a text field or dialog the person went to while it was out (focus plan rule 2).
    const frame = requestAnimationFrame(() => requestFocus(() => toggleRef.current, { reason: "async" }));
    return () => cancelAnimationFrame(frame);
  }, [toggleFocus]);
  const enterCommenting = review?.enterCommenting;
  const done = review?.done;
  const toggle = useCallback((pressed: boolean) => (pressed ? enterCommenting?.() : done?.()), [enterCommenting, done]);
  if (!review?.canComment) return null;
  const { status } = review;
  const label = formatMessage({ id: "artifacts.review.comment" });
  return (
    <>
      {review.draftsFailed ? (
        <Button variant="outline" size="md" className="shrink-0" onClick={review.reloadDrafts} data-testid="artifact-review-drafts-retry-header">
          {formatMessage({ id: "artifacts.review.draftsLoadFailedRetry" })}
        </Button>
      ) : null}
      <PanelSplitAction aria-label={formatMessage({ id: "artifacts.comments.title" })}>
        <Tooltip content={label}>
          <PanelSplitActionToggle
            ref={toggleRef}
            aria-label={label}
            pressed={status !== "browsing"}
            onPressedChange={toggle}
            data-testid="artifact-review-toggle"
          >
            <AddCommentIcon />
          </PanelSplitActionToggle>
        </Tooltip>
        <CommentMenu onReportDisplay={onReportDisplay} />
      </PanelSplitAction>
    </>
  );
}

/**
 * The Comment button's ▾, the menu part of its split action: Show All Comments (N), the comment list
 * (only posted comments; drafts are in C), then Doesn't display well here where `onReportDisplay`
 * (it posts a comment, so it sits with the comment actions, not in ⋯: xxchan, #proj-workspace:#243).
 * It carries the count itself (stdrc, xxchan, #proj-workspace:#119): the one comment control in the
 * header says how many there are, as the DS's gray number (Badge: a count nobody is called by is
 * plain Space Mono, `foreground-hint`, never the pink sticker), none at 0.
 */
function CommentMenu({ onReportDisplay }: { onReportDisplay: (() => void) | null }) {
  const { formatMessage } = useIntl();
  const comments = useArtifactComments();
  const setPanelOpen = comments?.setPanelOpen;
  const showAll = useCallback(() => {
    trackArtifactViewerAction("comments_open");
    setPanelOpen?.(true);
  }, [setPanelOpen]);
  // Doesn't display well here hands focus to the comment list's box: closing, the menu doesn't take it back to the ▾.
  const handsFocus = useRef(false);
  const reportDisplay = useCallback(() => {
    handsFocus.current = true;
    onReportDisplay?.();
  }, [onReportDisplay]);
  const finalFocus = useCallback(() => {
    const toTrigger = !handsFocus.current;
    handsFocus.current = false;
    return toTrigger;
  }, []);
  if (!comments) return null;
  const count = commentCount(comments);
  const label = count > 0 ? formatMessage({ id: "artifacts.comments.toggle" }, { count }) : formatMessage({ id: "artifacts.comments.title" });
  return (
    <DropdownMenu>
      <Tooltip content={label}>
        <DropdownMenuTrigger
          render={(
            <PanelSplitActionMenu
              aria-label={label}
              // The menu part is a chevron's width; with the number it takes the number's too.
              className={count > 0 ? "w-auto gap-0.5 px-1 md:pointer-fine:w-auto" : undefined}
              data-testid="artifact-review-comment-menu"
            >
              {count > 0 ? <CommentCountNumber count={count} /> : null}
              <ChevronDown aria-hidden />
            </PanelSplitActionMenu>
          )}
        />
      </Tooltip>
      <DropdownMenuContent side="bottom" align="end" finalFocus={finalFocus} aria-label={formatMessage({ id: "artifacts.comments.title" })}>
        <DropdownMenuItem onClick={showAll} data-testid="artifact-review-show-all">
          <CommentIcon />
          {formatMessage({ id: "artifacts.comments.showAll" }, { count })}
        </DropdownMenuItem>
        {onReportDisplay ? (
          <DropdownMenuItem onClick={reportDisplay} data-testid="artifact-review-display-report">
            <MonitorSmartphone />
            {formatMessage({ id: "artifacts.menu.displayReport" })}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A comment count on a header control (the ▾ above, the Comments toggle where comment mode isn't
 * offered): the DS's gray number, Space Mono in `foreground-hint`, 99+ past 99. Hidden from
 * assistive tech: the control's label says the count.
 */
export function CommentCountNumber({ count }: { count: number }) {
  const { formatMessage, formatNumber } = useIntl();
  return (
    <span aria-hidden className="font-mono text-mono-meta font-normal text-foreground-hint" data-testid="artifact-comment-count">
      {count > 99 ? formatMessage({ id: "artifacts.comments.countOver" }, { count: 99 }) : formatNumber(count)}
    </span>
  );
}

/**
 * The drafts bar (#proj-workspace:#148, xxchan's final mockup), floating at the content's foot: in
 * comment mode, and whenever the person has drafts here; not otherwise (an undo still waits on
 * ⌘Z), nor in C (a refused send is open). It replaces B's dark strip and A's "You have N comments
 * not submitted" notice. In the mockup's order: Pick Element, Undo, Redo, Discard All, Send N.
 * - On an HTML page, Pick Element: pressed in comment mode, and pressing it enters or leaves comment
 *   mode, as the header's Comment button does (Esc leaves it too). A Markdown page has no toggle,
 *   so with nothing to undo or send it has no bar.
 * - Undo and Redo of the person's draft changes (artifactDraftHistory), also ⌘Z / ⇧⌘Z (Ctrl
 *   elsewhere, and Ctrl+Y) while focus isn't in a text field, whether the bar shows or not.
 * - With drafts: Discard All, confirmed in place (a popover on the button: it can't be undone), and
 *   Send N, which sends them all at once as one review, with no summary and no panel first
 *   (xxchan); outlined while a comment box is open, whose Send is the pink one then. Sent, the
 *   drafts are gone and so is comment mode; refused, the review opens on what to fix
 *   (ArtifactReviewContext `submit`).
 * raft-ui has no floating toolbar: its parts (PanelToggleAction, Separator, Button) on the DS's
 * popover surface.
 */
export function ArtifactReviewBar({ kind }: { kind: string }) {
  const { formatMessage } = useIntl();
  const review = useArtifactReview();
  const comments = useArtifactComments();
  const enterCommenting = review?.enterCommenting;
  const done = review?.done;
  const pick = useCallback((pressed: boolean) => (pressed ? enterCommenting?.() : done?.()), [enterCommenting, done]);
  const submit = review?.submit;
  const send = useCallback(() => { void submit?.(); }, [submit]);
  const history = review?.history;
  const canUndo = history?.canUndo ?? false;
  const canRedo = history?.canRedo ?? false;
  const stepping = (history?.busy ?? false) || (review?.submitting ?? false);
  const undo = history?.undo;
  const redo = history?.redo;
  const doUndo = useCallback(() => { void undo?.(); }, [undo]);
  const doRedo = useCallback(() => { void redo?.(); }, [redo]);
  const draftCount = review?.draftCount ?? 0;
  const commenting = review?.status === "commenting";
  const offered = !!review?.draftsOffered && review.status !== "reviewing";
  const shown = offered && (commenting || draftCount > 0);
  // ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y): never in a field, whose own undo it is.
  const keys = offered && (canUndo || canRedo) && !stepping;
  // Through the registry (fixed keys: the standard editing ones), heard wherever the focus is on the surface but
  // never in a field (registry textField "never"; a select or contenteditable too), whose own undo it is.
  const notInField = (event: KeyboardEvent) => !(event.target instanceof Element && event.target.closest(FIELD_SELECTOR));
  useShortcut("undo-draft", (event) => {
    if (!canUndo || !notInField(event)) return false;
    void undo?.();
  }, { enabled: keys, ambient: true });
  useShortcut("redo-draft", (event) => {
    if (!canRedo || !notInField(event)) return false;
    void redo?.();
  }, { enabled: keys, ambient: true });
  if (!review || !shown) return null;
  const { submitting } = review;
  // One pink button at a time: a box being written in has the pink Send.
  const boxOpen = (review.selection?.writing ?? false) || (comments?.boxEngaged ?? false);
  const html = kind === "html";
  const undoLabel = formatMessage({ id: "artifacts.review.undo" });
  const redoLabel = formatMessage({ id: "artifacts.review.redo" });
  const undoable = draftCount > 0 || canUndo || canRedo;
  // Nothing to draw: a file with no Pick Element, and nothing yet to undo or send.
  if (!html && !undoable) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-float flex justify-center px-3">
      <div
        role="group"
        aria-label={formatMessage({ id: "artifacts.review.barLabel" })}
        className="pointer-events-auto flex max-w-full min-w-0 items-center gap-1 rounded-container bg-layer-popover p-1 text-foreground shadow-float ring-1 ring-line-seam ring-inset"
        data-testid="artifact-review-bar"
        data-count={draftCount}
      >
        {html ? (
          <PanelToggleAction pressed={commenting} onPressedChange={pick} data-testid="artifact-review-pick">
            <SquareDashedMousePointer />
            <span>{formatMessage({ id: "artifacts.review.pickElement" })}</span>
          </PanelToggleAction>
        ) : null}
        {undoable ? (
          <>
            {html ? <Separator orientation="vertical" className="mx-0.5 h-5 self-center" /> : null}
            <Tooltip content={undoLabel}>
              <Button variant="ghost" size="icon-md" aria-label={undoLabel} onClick={doUndo} disabled={!canUndo || stepping} data-testid="artifact-review-undo">
                <Undo2 />
              </Button>
            </Tooltip>
            <Tooltip content={redoLabel}>
              <Button variant="ghost" size="icon-md" aria-label={redoLabel} onClick={doRedo} disabled={!canRedo || stepping} data-testid="artifact-review-redo">
                <Redo2 />
              </Button>
            </Tooltip>
          </>
        ) : null}
        {draftCount > 0 ? (
          <>
            <Separator orientation="vertical" className="mx-0.5 h-5 self-center" />
            <DiscardAllInPlace count={draftCount} disabled={submitting} />
            <Button variant={boxOpen ? "outline" : "primary"} size="md" onClick={send} disabled={submitting} data-testid="artifact-review-bar-send" data-variant={boxOpen ? "outline" : "primary"}>
              {formatMessage({ id: "artifacts.review.sendDrafts" }, { count: draftCount })}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The bar's Discard All, confirmed in place: a popover on the button (not a dialog in the middle of
 * the screen): the title (it counts the drafts), a red banner (it can't be undone: DS AlertDialog's
 * rule for a confirmation that can't be undone), Cancel (focused first, so Enter right after it opens
 * takes nothing away) and the red Discard Drafts.
 * A failure keeps it open and says so.
 */
function DiscardAllInPlace({ count, disabled }: { count: number; disabled: boolean }) {
  const { formatMessage } = useIntl();
  const review = useArtifactReview();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const change = useCallback((next: boolean) => {
    setOpen(next);
    setFailed(false);
  }, []);
  const close = useCallback(() => change(false), [change]);
  const discardAll = review?.discardAll;
  const confirm = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      await discardAll?.();
      setOpen(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [discardAll]);
  const title = formatMessage({ id: "artifacts.review.discardTitle" }, { count });
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger
        render={(
          <Button variant="ghost" size="md" disabled={disabled} data-testid="artifact-review-bar-discard">
            {formatMessage({ id: "artifacts.review.discardAll" })}
          </Button>
        )}
      />
      <PopoverContent side="top" align="end" sideOffset={8} initialFocus={cancelRef} aria-label={title} className="w-[320px] max-w-[calc(100vw-2rem)]" data-testid="artifact-review-discard-popover">
        <PopoverHeader>
          <PopoverTitle>{title}</PopoverTitle>
        </PopoverHeader>
        <PopoverBody className="flex flex-col gap-3">
          <Banner status="destructive" size="sm" role="note">
            <BannerDescription>{formatMessage({ id: "artifacts.review.discardBody" })}</BannerDescription>
          </Banner>
          {failed ? (
            <Banner status="warning" size="sm" role="alert" data-testid="artifact-review-discard-failed">
              <BannerDescription>{formatMessage({ id: "common.confirm.somethingWentWrong" })}</BannerDescription>
            </Banner>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button ref={cancelRef} variant="ghost" size="md" onClick={close} data-testid="artifact-review-discard-cancel">
              {formatMessage({ id: "artifacts.comments.cancel" })}
            </Button>
            <Button variant="danger" size="md" onClick={confirm} disabled={busy} data-testid="artifact-review-bar-discard-confirm">
              {formatMessage({ id: "artifacts.review.discardConfirm" })}
            </Button>
          </div>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}

/**
 * What a selection or a picked block opens, in A and B alike: a selection, the Comment button at
 * its end (raft-ui TextSelectionToolbar, one button: #proj-workspace:#148), which turns the same
 * card into the comment box there; a picked block (B) or the page's own button (B) opens the box at
 * once. The box (ArtifactCommentBox `draftOption`) sends now or saves a draft. Beside the selection
 * on a desktop (Popover), a bottom sheet on a phone. Opened by the page's report, so armed for its
 * first moments; C also, on a phone, as a bottom sheet.
 */
export function ArtifactReviewLayer({ viewer }: { viewer: () => HTMLElement | null }) {
  const review = useArtifactReview();
  const phone = useMediaQuery(PHONE_QUERY);
  if (!review) return null;
  const { selection, status, draftView } = review;
  return (
    <>
      {draftView && status !== "reviewing" ? <DraftView key={draftView.key} view={draftView} phone={phone} /> : null}
      {selection && status !== "reviewing" ? <SelectionBox key={selection.key} selection={selection} phone={phone} viewer={viewer} /> : null}
      {status === "reviewing" && phone ? <ArtifactReviewSheet /> : null}
    </>
  );
}

/**
 * A draft's own view, opened by its marker in the page (Porthole `activated`, the page's word) or
 * beside a text or csv file's lines or rows (Raft's own marker, ArtifactShellComments): beside the
 * marker on a desktop (Popover), a bottom sheet on a phone. Opened by the page's word it is armed
 * for its first moments and takes no focus, as every view a frame's report opens (THREAT_MODEL §6);
 * by Raft's own marker it is neither, as a thread's card from those markers. It reads the draft
 * and offers Edit (drafts are changed where they are, #proj-workspace:#148); nothing
 * in it submits, and Delete is behind ⋯ and a confirmation (P107, co-design S2/S6), however it was
 * opened; once confirmed it goes as any draft's (useDeleteDraft), its toast's Undo included. Never C itself.
 */
function DraftView({ view, phone }: { view: ArtifactDraftView; phone: boolean }) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const review = useArtifactReview()!;
  const comments = useArtifactComments();
  const armed = useArmed(view.fromPage ? view.key : null);
  const anchor = useMemo(() => anchorAt(view.rect), [view.rect]);
  const [editing, setEditing] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  // The view closes while its delete is being confirmed; asked (and so cancelled, the draft still
  // here), it opens again with focus on its ⋯, where the person was. A view the page opened takes none.
  const [askedIn, setAskedIn] = useState<number | null>(null);
  const onAsked = useCallback((deleted: boolean) => {
    if (!deleted) setAskedIn(view.key);
  }, [view.key]);
  const initialFocus = askedIn === view.key ? moreButton : view.fromPage ? false : undefined;
  const [deleteDraft, deleteDialog] = useDeleteDraft({ askFirst: true, onAsked });
  const confirming = deleteDialog !== null;
  const { closeDraftView, updateDraft, submitting } = review;
  const draft = review.drafts?.find((d) => d.id === view.draftId) ?? null;
  // On the dismissal layer (artifactDismissLayer): a press outside it in Raft closes it unless its
  // Edit box holds typed words; Esc closes it (an Esc the edit box took leaves the view open); one
  // card at a time. Opened by a marker in the page, the focus is handed back from the frame, so Esc
  // is heard: with the focus still nowhere, Esc gives it back to the frame. A press in the page is
  // not its to hear (the page could never close it that way). While the delete is being confirmed
  // the dialog is the view (not open here: a press in it would be one outside this).
  const popup = useRef<HTMLDivElement | null>(null);
  const leftFrame = useRef<HTMLIFrameElement | null>(null);
  const { change } = useDismissable(!confirming, {
    card: true,
    pressKeepsWords: phone,
    handsFocusBack: !phone,
    leftFrame,
    element: () => popup.current,
    close: (by) => {
      closeDraftView();
      if (by === "escape" && document.activeElement === document.body) leftFrame.current?.focus({ preventScroll: true });
    },
  });
  const close = useCallback((open: boolean, details?: { reason?: string; event?: Event }) => {
    if (!confirming) change(open, details);
  }, [confirming, change]);
  // The surface's own parts (ArtifactCardShell): beside its marker on a desktop, the same focus on a phone's sheet.
  const sheetPart = useMemo(() => ({ ref: popup, initialFocus }), [initialFocus]);
  const popoverPart = useMemo(() => ({ ref: popup, anchor, side: "right" as const, initialFocus }), [anchor, initialFocus]);
  // Drawn and focused within the press (flushSync), as Reply: iOS Safari opens the keyboard only for a focus made during
  // the tap itself, and an Edit is the person asking to type, on touch too.
  const startEditing = useCallback(() => flushSync(() => setEditing(true)), []);
  const stopEditing = useCallback(() => setEditing(false), []);
  const askDelete = useCallback(() => {
    if (draft) void deleteDraft(draft);
  }, [draft, deleteDraft]);
  const draftId = view.draftId;
  const body = draft?.body;
  const batch = useMemo<ArtifactCommentBoxBatch>(() => ({
    label: formatMessage({ id: "artifacts.review.save" }),
    initial: body,
    draftId,
    onSubmit: (next) => updateDraft(draftId, next),
    busy: submitting,
    images: draft?.images,
  }), [formatMessage, body, draftId, updateDraft, submitting, draft?.images]);
  const target = draft?.target;
  const mode = useMemo(() => (target ? { kind: "new" as const, target, replyTo: null } : null), [target]);
  if (!draft || !mode) return null;
  const label = formatMessage({ id: "artifacts.review.draftViewLabel" });
  const moreLabel = formatMessage({ id: "artifacts.review.draftMore" });
  const place = draft.target.scope === "file" && draft.target.anchor
    ? <DraftPlace anchor={draft.target.anchor} />
    : draft.target.scope === "file" ? draft.target.path : formatMessage({ id: "artifacts.comments.groupArtifact" });
  const card = (
    <CommentCard active className="border-dashed" data-testid="artifact-draft-view-card" data-draft-id={draft.id}>
      <CommentCardMeta>
        {/* Said in words, beside the dashed edge: this one isn't posted yet. DS Badge's hairline tag. */}
        <Badge appearance="outline" className="shrink-0" data-testid="artifact-draft-view-tag">
          {formatMessage({ id: "artifacts.review.draftTag" })}
        </Badge>
        <span className="min-w-0 flex-1 truncate">{place}</span>
        {editing ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(
                <Button ref={moreButton} variant="ghost" size="icon-md" className="ms-auto" aria-label={moreLabel} disabled={submitting} data-testid="artifact-draft-view-more">
                  <EllipsisVertical />
                </Button>
              )}
            />
            <DropdownMenuContent side="bottom" align="end" aria-label={moreLabel}>
              <DropdownMenuItem onClick={askDelete} data-testid="artifact-draft-view-delete">
                <Trash2 />
                {formatMessage({ id: "artifacts.review.delete" })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </CommentCardMeta>
      {editing ? (
          <ArtifactDismissableBox onDismiss={stopEditing}>
            <ArtifactCommentBox mode={mode} batch={batch} autoFocusKey={draft.id} onDone={stopEditing} onCancel={stopEditing} />
          </ArtifactDismissableBox>
      ) : (
        <>
          <Text.Sans size="body" render={DRAFT_BODY_ELEMENT} data-testid="artifact-draft-view-body">
            <ArtifactCommentText body={draft.body} viewer={comments?.viewer ?? null} />
          </Text.Sans>
          <ArtifactCommentGallery artifactId={comments?.data.card.id ?? null} images={draft.images} />
          {/* From day 25 it says when it goes, as C did: there is no list of drafts to read it in. */}
          {draftExpiresSoon(draft) ? (
            <Text.Sans size="small" variant="warning" data-testid="artifact-draft-view-expires">
              {formatMessage({ id: "artifacts.review.expires" }, { days: draftDaysLeft(draft) })}
            </Text.Sans>
          ) : null}
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" size="md" onClick={startEditing} disabled={submitting} data-testid="artifact-draft-view-edit">
              <Pencil />
              {formatMessage({ id: "artifacts.review.edit" })}
            </Button>
          </div>
        </>
      )}
    </CommentCard>
  );
  return (
    <>
      {/* Opened by the page's report: no focus (no keyboard on a phone either); by Raft's own marker, focus in it. */}
      <ArtifactCardShell
        phone={phone}
        open={!confirming}
        onOpenChange={close}
        label={label}
        testId="artifact-draft-view"
        armed={armed}
        sheet={sheetPart}
        popover={popoverPart}
      >
        {card}
      </ArtifactCardShell>
      {deleteDialog}
    </>
  );
}
