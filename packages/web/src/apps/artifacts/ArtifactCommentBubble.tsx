import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { MapPinOff } from "lucide-react";
import { CommentCard, CommentCardMeta } from "@botiverse/raft-ui/wip";
import type { ArtifactComment, ArtifactCommentDraft, ArtifactCommentId, ArtifactCommentPart, ObjectFileId } from "@botiverse/raft-shared";
import { focusField } from "@botiverse/porthole";
import type { AnnotationRect } from "@botiverse/porthole";

import ConfirmDialog from "../../components/ConfirmDialog";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { focusLost } from "../../utils/focusGuard";
import { AnchorMeta } from "./ArtifactActorParts";
import { useAnchorFound } from "./artifactAnchorStatus";
import { ArtifactCardHoldContext } from "./artifactCardHold";
import { ArtifactCardShell } from "./ArtifactCardShell";
import type { ArtifactCardListWay } from "./artifactCardHold";
import { useCardTabOut } from "./artifactCardTabOut";
import ArtifactCommentBox from "./ArtifactCommentBox";
import { ArtifactComposeCard } from "./ArtifactComposeCard";
import { anchorOf, buildThreads } from "./artifactComments";
import type { ArtifactCommentThread } from "./artifactComments";
import { useArtifactComments, useTrackedPlace } from "./ArtifactCommentsContext";
import { useDeleteDraft } from "./artifactDraftDelete";
import { isInputMethodKey } from "./artifactInputMethodKey";
import type { ArtifactCommentBubble as Bubble } from "./ArtifactCommentsContext";
import type { ArtifactBubbleKeyboard } from "./artifactCommentsShapes";
import { CommentItem } from "./ArtifactCommentsPanel";
import { ResolveButton, ResolvedBy } from "./ArtifactThreadResolution";
import { useThreadResolution } from "./useThreadResolution";
import { focusAfterResolvedCard } from "./artifactResolvedFocus";
import { PendingReplyDraft, usePendingReplies } from "./ArtifactPendingReplies";
import { PHONE_QUERY } from "./artifactPhoneHistory";
import { useArtifactReview } from "./ArtifactReviewContext";
import { focusArtifactSurface } from "./artifactRestoredFocus";
import { artifactSource } from "./artifactSource";
import { useArmed } from "./useArmed";
import { useDismissable } from "./useArtifactDismiss";
import { useDraftOption, useReplyDraftOption } from "./useDraftOption";
import { canTakeFocus } from "./artifactViewerStore";

/** A virtual anchor for a popover at a box on screen (client px). */
export function anchorAt(rect: AnnotationRect | null) {
  const r = rect ?? { x: 0, y: 0, width: 0, height: 0 };
  const box = { x: r.x, y: r.y, width: r.width, height: r.height, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height };
  return { getBoundingClientRect: () => ({ ...box, toJSON: () => box }) as DOMRect };
}

/** How long `focusMark`'s message has to land (one post to the frame) before the frame is given the focus instead. */
const MARK_FOCUS_MS = 150;

/**
 * Esc, or Tab out past its end, closed a card with a marker in `frame`, and the card is gone:
 * the keyboard goes back on the marker (Porthole P134). Only from the body: never off what the person moved it to, and from
 * a text field of Raft's the focus guard would undo the move and count it. Porthole says nothing back,
 * so a marker that isn't there, or a shell older than 0.14.12, shows as the focus still on the body:
 * the frame is given it as before P134, and asked again now it has the focus. From Porthole 0.14.13's
 * shell (P135) a `focusMark` parked while the page settles lands only if the frame still has the
 * focus, and from 0.14.14's (P137) so does one a busy page took 100 ms or more after it was sent,
 * so the first one, sent with the focus on the body, can be dropped, and this one is what puts
 * the keyboard on the marker; it has the same gate, the body, so it never moves a focus the person
 * moved. Without it the keyboard stays in the page, off the marker. On an older shell a parked one
 * still lands wherever the focus has gone (accepted, Tenny, #proj-workspace:#211): host before shell.
 * A task even with nothing to ask: this runs in a microtask of the key, and Gecko refuses a move into
 * a frame of another origin during one (`IsHandlingKeyBoardEvent`).
 */
function backToMark(frame: HTMLIFrameElement | null, focusMark: () => boolean) {
  if (!focusLost()) return;
  const giveBack = () => {
    if (!focusLost()) return;
    frame?.focus({ preventScroll: true });
    focusMark();
  };
  window.setTimeout(giveBack, focusMark() ? MARK_FOCUS_MS : 0);
}

/**
 * The card floating beside a comment's marker or a selection (raft-design patterns/comments.md, "A
 * page that can't give up any width"; co-design S2, S3, S10): a Popover on a desktop, a bottom
 * sheet (Drawer) on a phone, one at a time (ArtifactCommentsContext `bubble`).
 *
 * - A thread (its marker clicked, in a framed page or beside a text or csv file; or landed on from
 *   Activity): the active CommentCard with every comment and a reply box, which posts at once in
 *   A; in B Send or Save Draft, a reply draft (xxchan, #proj-workspace:f07141a9, #148).
 *   C has no reply box (the pending review is open). In A and B the person's reply drafts for the thread
 *   show under its replies, marked as pending (ArtifactPendingReplies; Remy, #proj-workspace:d03c42a0).
 *   Editing and deleting one's own comment or reply draft are behind its ⋯; a comment's delete
 *   behind a confirmation, a reply draft's at once (it can be undone, as every draft's).
 * - A new comment (Comment on a text or csv file's selection; the page's own button): a quote of
 *   the place and the comment box, posted at once. Sent, at a place a marker shows (lines, rows),
 *   the card becomes the new thread's card in place, the comment marked Sent until it closes
 *   (`revealSent`; xxchan: the list doesn't open); at a page's place the list opens on it. The
 *   same on a phone, where either card is a bottom sheet.
 *
 * Opened by the page's report (`fromFrame`, `fromPage`) it is armed (inert for its first 500 ms,
 * and again each time it moves) and takes no focus; until the person presses in it, a thread's
 * card follows its marker (the frame's `tracked`, `trackedAnnotation`) and goes when the passage does (Porthole 0.13
 * ADOPTING § Annotations, THREAT_MODEL §6). A thread's floating card opened with the focus in this
 * frame (`keyboard`; a key on a marker, P134, or a page's forged report, which can't be told apart)
 * takes that focus, on its container alone, and stays held until a press in it (artifactCardHold):
 * THREAT_MODEL §6's second exception. Nothing in it posts or deletes in one press: Send
 * needs the person's own words, Delete is behind ⋯ (and a comment's behind a confirmation).
 *
 * How it goes away is the dismissal layer's (artifactDismissLayer, the rule every card and box
 * shares; BubbleShell is one `useDismissable`): empty, a press outside it closes it, in Raft or on
 * a Markdown margin's ground; holding typed words, it stays. Esc closes it, its words kept on this
 * device, and so, on any Popover, does Tab out past either end (artifactCardTabOut). One card at a
 * time. Its × is its own. A press in the Artifact's page closes a thread's card (while empty),
 * floating or in a Markdown margin: the floating one closed that way before the layer, and the
 * margin's is the same card drawn elsewhere (xxchan's first report: opened, nothing typed, a press
 * on the page's blank left it there). A new comment's is not the page's to close that way
 * (`hearsPagePress`).
 */
export default function ArtifactCommentBubble({ boundary }: {
  /** What the card stays within on a desktop (the viewer: never over the app beside it; null, the window). */
  boundary: HTMLElement | null;
}) {
  const comments = useArtifactComments();
  const phone = useMediaQuery(PHONE_QUERY);
  const bubble = comments?.bubble ?? null;
  if (!bubble) return null;
  // Beside a Markdown Artifact's margin, the open thread's card is the margin's (MarginThreadCard).
  if (bubble.kind === "thread") return comments?.margin.shown && !phone ? null : <ThreadBubble key={bubble.threadId} bubble={bubble} phone={phone} boundary={boundary} />;
  return <ComposeBubble key={bubble.key} bubble={bubble} phone={phone} boundary={boundary} />;
}

/**
 * The open thread's card in a Markdown Artifact's margin (#proj-workspace:#152): the same card as
 * the floating one (its comments, replies, reply box, edit and delete), drawn in place of the
 * thread's collapsed card in the margin (ArtifactMarkdownMargin) rather than in a Popover.
 */
export function MarginThreadCard({ bubble }: { bubble: Extract<Bubble, { kind: "thread" }> }) {
  return <ThreadBubble key={bubble.threadId} bubble={bubble} phone={false} boundary={null} inline />;
}

/**
 * A card beside `rect` within `boundary`, or in a bottom sheet on a phone (ArtifactCardShell draws
 * both); armed while `armed`, focus as `focus` says. `padded`: a new comment's card, which the
 * surface pads (a thread's CommentCard pads itself).
 * `inline`: in the margin's flow instead (MarginThreadCard): no Popover, Esc in it closes it.
 * `keyboard`: the Popover takes the focus off that frame, on its own element (Base UI's: `role="dialog"`,
 * `tabIndex={-1}`, labelled by `label`). So that stays out of `inert` while armed: only what's in it is.
 */
function BubbleShell({ rect, boundary, phone, armed, open, focus, thread = null, inline = false, padded = false, label, testId, onClose, onPress, keyboard = null, onEscaped = null, onKeyedOut = null, onFocusedIn, sheetInitialFocus, children }: {
  rect: AnnotationRect | null;
  boundary: HTMLElement | null;
  phone: boolean;
  armed: boolean;
  padded?: boolean;
  /** False while a confirmation it opened is the view. */
  open: boolean;
  /** Whether the card takes focus when it opens (only when Raft's own press opened it). */
  focus: boolean;
  /**
   * A thread's card: the thread, whose marker in the page it is open for. Its floating card
   * closes on a press in the page (the marker pressed again leaves it closed), and it hands the
   * focus back from the frame as it opens, in the margin too. A new comment's card (null) does
   * neither: its focus stays where the person had it (the page's own button, Tenny #11389).
   */
  thread?: string | null;
  inline?: boolean;
  label: string;
  testId: string;
  onClose: () => void;
  onPress?: () => void;
  /** Never on a phone or `inline`. */
  keyboard?: ArtifactBubbleKeyboard | null;
  /**
   * A card with a marker in the frame: Esc, or Tab out past its end, closed it, and it is gone. Base
   * UI's own return of the focus is off. Without `keyboard`, only for a key from in the card: an Esc
   * elsewhere closes a card the page may have opened, and moves no keyboard into that page.
   */
  onEscaped?: (() => void) | null;
  /** With no `onEscaped`: Esc or Tab out from in the card closed it, it is gone, and Base UI's return of the focus has run. */
  onKeyedOut?: (() => void) | null;
  /** With `keyboard`: the focus went into its controls. */
  onFocusedIn?: () => void;
  /**
   * On a phone, the sheet's initial focus each time it opens (Base UI's `initialFocus` as a
   * function: an element to focus, or false for none). Unset: none, as the sheet takes no focus.
   */
  sheetInitialFocus?: () => HTMLElement | boolean;
  children: React.ReactNode;
}) {
  const anchor = useMemo(() => anchorAt(rect), [rect]);
  // The frame this card took the focus off as it opened (`useDismissable`, below).
  const leftFrame = useRef<HTMLIFrameElement | null>(null);
  const inlineRef = useRef<HTMLDivElement | null>(null);
  // What Esc left to do once the card is gone (`onEscaped`).
  const afterEscape = useRef<(() => void) | null>(null);
  const [popup, setPopup] = useState<HTMLElement | null>(null);
  // Esc, and Tab out past its end (`tabOut`). `from` is the key's own target: only the person, with the
  // focus really in the card, sends a key from there, and this window's `document.activeElement` can
  // still read the frame then (QA, Firefox). A key from elsewhere moves no keyboard into the page.
  const closeByKey = useCallback((from: EventTarget | null) => {
    const inCard = from instanceof Node && (popup?.contains(from) ?? false);
    const back = keyboard || inCard ? onEscaped : null;
    onClose();
    if (back) {
      afterEscape.current = back;
      return;
    }
    if (inCard) afterEscape.current = onKeyedOut;
    // Esc with the focus still where the opening left it: back in the frame, so the keyboard goes on
    // in the page (on the marker only if its document is still there: `backToMark`). Never off what
    // the person moved it to.
    if (focusLost()) leftFrame.current?.focus({ preventScroll: true });
  }, [onClose, onEscaped, onKeyedOut, keyboard, popup]);
  // The card's own focus falls to the body as it goes; a microtask, after Base UI's cleanup in the commit.
  useEffect(() => () => {
    if (afterEscape.current) queueMicrotask(afterEscape.current);
  }, []);
  // On the dismissal layer (artifactDismissLayer): it says when a press outside or Esc closes this,
  // and that one card is open at a time. A thread's card opened from the page hands the focus back
  // to this window (to nothing in the card, which takes no focus), so the next press in the frame
  // is heard (the floating card's alone); Enter or Space on a marker (Porthole's P133) always comes
  // with the focus in the frame, where keys never reach Raft, so Esc is heard here and gives the
  // focus back (`closeByKey`). With `keyboard` the card then takes that focus itself (below),
  // whichever of this and that runs first. A phone's sheet is modal: a tap outside is its way out,
  // words or none.
  const { change, signal } = useDismissable(open, {
    card: true,
    mark: thread,
    inFlow: inline,
    pressKeepsWords: phone,
    hearsPagePress: thread !== null && !phone,
    handsFocusBack: thread !== null && !phone,
    leftFrame,
    element: () => (inline ? inlineRef.current : popup),
    close: (by, event) => (by === "escape" ? closeByKey(event?.target ?? null) : onClose()),
  });
  // `keyboard`: the focus goes to the Popover's own element, once for each report that found it in
  // the frame. In a microtask: Base UI's focus hooks run inside React's commit, and React restores
  // focus at the end of a commit, as useDeleteDraft's `finalFocus` says. As then, it may have gone
  // from the frame to something of the person's: never off that. Porthole's move, as the frame may
  // hold on to the focus on Firefox.
  const took = useRef<number | null>(null);
  const takeFrom = keyboard?.frame ?? null;
  const takeAt = keyboard?.at ?? null;
  useLayoutEffect(() => {
    if (!popup || !takeFrom || took.current === takeAt) return;
    took.current = takeAt;
    queueMicrotask(() => {
      const active = document.activeElement;
      if (popup.isConnected && (active === takeFrom || active === document.body)) focusField(popup);
    });
  }, [popup, takeFrom, takeAt]);
  const tabOut = useCardTabOut(armed, closeByKey);
  // Opened by the person (Enter or a click on its card in the margin): focus goes into the card, to
  // its first control, as the collapsed card's button it replaced goes (the margin gives focus back
  // to that button when it closes). Before the margin's own layout effect (a child's runs first).
  useLayoutEffect(() => {
    if (!inline || !focus) return;
    const card = inlineRef.current;
    const first = card?.querySelector<HTMLElement>("button:not([disabled]), [href], textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])");
    (first ?? card?.querySelector<HTMLElement>("[tabindex='-1']"))?.focus({ preventScroll: true });
  }, [inline, focus]);
  const inlineKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || isInputMethodKey(event)) return;
    // Esc in the card is the card's, never the viewer's; one an @ picker or an edit took stays there (the layer's rule).
    event.stopPropagation();
    if (signal("escape", event.nativeEvent)) event.preventDefault();
  }, [signal]);
  // The surface's own parts (ArtifactCardShell). On a phone the sheet takes no focus (no keyboard
  // until the person taps into the box, co-design S2), but the card after a confirmation it stepped
  // aside for (`sheetInitialFocus`).
  const sheetPart = useMemo(() => ({ initialFocus: sheetInitialFocus ?? false, onPointerDownCapture: onPress }), [sheetInitialFocus, onPress]);
  const popoverPart = useMemo(() => ({
    ref: setPopup,
    anchor,
    side: "right" as const,
    collisionBoundary: boundary ?? undefined,
    initialFocus: focus,
    finalFocus: onEscaped ? false as const : undefined,
    inert: (!keyboard && armed) || undefined,
    onPointerDownCapture: keyboard ? undefined : onPress,
    onKeyDown: tabOut,
  }), [anchor, boundary, focus, onEscaped, keyboard, armed, onPress, tabOut]);
  if (inline) {
    // Hidden, not unmounted, while a confirmation it opened is the view (as the Popover closes).
    return (
      <div
        ref={inlineRef}
        role="group"
        aria-label={label}
        hidden={!open}
        inert={armed || undefined}
        onKeyDown={inlineKeyDown}
        onPointerDownCapture={onPress}
        data-testid={testId}
        data-armed={armed || undefined}
      >
        {children}
      </div>
    );
  }
  const pressed = keyboard && !armed ? onPress : undefined;
  const card = phone ? children : (
    <div inert={(keyboard && armed) || undefined} onPointerDownCapture={pressed} onFocusCapture={keyboard ? onFocusedIn : undefined}>
      {children}
    </div>
  );
  return (
    <ArtifactCardShell
      phone={phone}
      open={open}
      onOpenChange={change}
      label={label}
      testId={testId}
      armed={armed}
      surface={padded ? "padded" : "card"}
      sheet={sheetPart}
      popover={popoverPart}
    >
      {card}
    </ArtifactCardShell>
  );
}

function ThreadBubble({ bubble, phone, boundary, inline = false }: { bubble: Extract<Bubble, { kind: "thread" }>; phone: boolean; boundary: HTMLElement | null; inline?: boolean }) {
  const { formatMessage } = useIntl();
  const comments = useArtifactComments()!;
  const review = useArtifactReview();
  // Where the frame last moved it (`tracked`) since it was opened (a move older than the card's own
  // opening, a marker pressed again, is not), until the person pressed in it (it stays there then).
  const place = useTrackedPlace();
  const moved = !bubble.pinned && place?.threadId === bubble.threadId && place.key > bubble.key ? place : null;
  // Armed each time the page's word opened or moved it (a new key), never once the person pressed in it.
  const armed = useArmed(bubble.fromFrame && !bubble.pinned ? moved?.key ?? bubble.key : null);
  const [editing, setEditing] = useState<ArtifactCommentId | null>(null);
  const [deleting, setDeleting] = useState<ArtifactComment | null>(null);
  // A reply draft's delete: its confirmation (a draft with images) is the view while it asks, as a
  // comment's is: the card steps aside (its popover or sheet closed), so Esc and focus are the
  // dialog's. Once it closes (Cancel, Esc, or deleted) focus goes back to the card, whether the
  // card stayed mounted while it was closed or is drawn again as a new element:
  // - the dialog, unmounted, restores focus in a microtask of its own (Base UI's focus manager: to
  //   what was focused before it, the ⋯'s menu item, gone, so somewhere else), so the card is
  //   focused after that, in a task (`setTimeout` 0) queued in the close's own event;
  // - a card not there yet then takes it as it mounts (its ref), whenever that is: no waiting for
  //   frames or for an open to complete (neither is a sure sign here).
  // On a phone the card is in a bottom sheet (raft-ui Drawer, Base UI's), which moves focus itself
  // as it reopens, after any task of ours: there the sheet owns it, through its `initialFocus`
  // (`sheetInitialFocus`: the card, once, when it reopens after a confirmation), and nothing here
  // competes.
  // `pending`: asked, the dialog's restore not past yet; `afterRestore`: past it, the card not there;
  // `sheet`: the sheet's initialFocus gives it to the card when it reopens.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const focusCard = useRef<"pending" | "afterRestore" | "sheet" | null>(null);
  const asked = useCallback(() => {
    if (phone) {
      focusCard.current = "sheet";
      return;
    }
    focusCard.current = "pending";
    window.setTimeout(() => {
      if (focusCard.current !== "pending") return;
      const card = cardRef.current;
      if (card?.isConnected) {
        focusCard.current = null;
        card.focus({ preventScroll: true });
      } else {
        focusCard.current = "afterRestore";
      }
    }, 0);
  }, [phone]);
  const [deleteDraft, deleteDraftDialog] = useDeleteDraft({ onAsked: asked });
  // Opened with the focus in the frame (P134): the focus is never a phone's sheet's or the margin's
  // card's, where the frame has no markers. The hold is any card's the bubble came to, in whatever
  // shell it is drawn now: held, what would write says so instead (artifactCardHold).
  const keyboard = phone || inline ? null : bubble.keyboard ?? null;
  const [refused, setRefused] = useState(false);
  const held = bubble.keyboard?.held === true;
  const hold = useMemo(() => (held ? () => setRefused(true) : null), [held]);
  const askDelete = useCallback((comment: ArtifactComment) => {
    if (hold) hold();
    else setDeleting(comment);
  }, [hold]);
  const deleteUnlessHeld = useCallback(async (draft: ArtifactCommentDraft) => {
    if (!hold) return deleteDraft(draft);
    hold();
    return false;
  }, [hold, deleteDraft]);
  const sheetInitialFocus = useCallback((): HTMLElement | boolean => {
    if (focusCard.current !== "sheet") return false;
    focusCard.current = null;
    return cardRef.current ?? false;
  }, []);
  const attachCard = useCallback((element: HTMLDivElement | null) => {
    cardRef.current = element;
    if (!element || (focusCard.current !== "pending" && focusCard.current !== "afterRestore")) return;
    element.focus({ preventScroll: true });
    // Before the dialog's restore it may take focus away again: the task above focuses it once more.
    if (focusCard.current === "afterRestore") focusCard.current = null;
  }, []);
  const { closeBubble, pinBubble, keepBubble, focusMark, openThreadInList, removed } = comments;
  const threadId = bubble.threadId;
  const frame = keyboard?.frame ?? null;
  // A card the page's word opened that took no focus (a first mouse click on a marker, a landing)
  // has its marker there too; a card from Raft's own marker has Base UI give the focus back to it.
  const { marks, box: frameBox } = comments.frame;
  const marked = !phone && !inline && bubble.fromFrame && marks.some((mark) => mark.id === threadId);
  const escaped = useMemo(() => (frame || marked ? () => backToMark(frame ?? frameBox?.current?.querySelector("iframe") ?? null, () => focusMark(threadId)) : null), [frame, marked, frameBox, focusMark, threadId]);
  const openInList = useCallback(() => openThreadInList(threadId), [openThreadInList, threadId]);
  // Not gone with the hold: a press on it lifts that, and it must still be there for the click.
  const tookFocus = keyboard !== null;
  const listWay = useMemo<ArtifactCardListWay | null>(() => (tookFocus ? { open: openInList, off: armed } : null), [tookFocus, openInList, armed]);
  const loaded = comments.comments;
  const hasEarlier = comments.hasEarlier;
  const thread = useMemo(
    () => buildThreads(loaded ?? [], { parentsMayBeOlder: hasEarlier }).find((t) => t.id === bubble.threadId) ?? null,
    [loaded, hasEarlier, bubble.threadId],
  );
  // A saved edit's `wanted` (its focus goes with the card's own): asked, so it stops watching.
  const stopEditing = useCallback((_id: ArtifactCommentId, wanted?: () => boolean) => {
    wanted?.();
    setEditing(null);
  }, []);
  const cancelDelete = useCallback(() => setDeleting(null), []);
  const id = comments.data.card.id;
  // A failure keeps the dialog open with its error (ConfirmDialog); done, the comment goes.
  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    await artifactSource().deleteComment(id, deleting.id);
    removed(deleting.id);
    setDeleting(null);
  }, [id, deleting, removed]);
  // A reply is sent or saved as a draft (useReplyDraftOption), in A and B; C has no reply box.
  const canReply = comments.data.capabilities.comment && (review?.status ?? "browsing") !== "reviewing";
  // Made again only when the thread or its editing changes: a move (`tracked`, up to 60 a second)
  // re-places the card alone.
  const card = useMemo(
    () => (thread ? <ThreadInBubble thread={thread} editing={editing} canReply={canReply} onEdit={setEditing} onStopEditing={stopEditing} onDelete={askDelete} onDeleteDraft={deleteUnlessHeld} cardRef={attachCard} listWay={listWay} inMargin={inline} /> : null),
    [thread, editing, canReply, stopEditing, askDelete, deleteUnlessHeld, attachCard, listWay, inline],
  );
  // Its thread gone (deleted, with no replies): so is the card (the context drops it too).
  if (!thread) return null;
  return (
    <>
      <BubbleShell
        rect={moved?.rect ?? bubble.rect}
        boundary={boundary}
        phone={phone}
        armed={armed}
        open={deleting === null && deleteDraftDialog === null}
        sheetInitialFocus={sheetInitialFocus}
        focus={!bubble.fromFrame}
        thread={bubble.threadId}
        inline={inline}
        label={formatMessage({ id: "artifacts.comments.title" })}
        testId="artifact-comment-bubble"
        onClose={closeBubble}
        onPress={pinBubble}
        keyboard={keyboard}
        onEscaped={escaped}
        onFocusedIn={keepBubble}
      >
        <ArtifactCardHoldContext.Provider value={hold}>
          {card}
          {/* A refused write changes nothing on screen: this is the only word of it, and the way on for every one of them. */}
          {hold ? <span role="status" className="sr-only" data-testid="artifact-comment-held-said">{refused ? formatMessage({ id: "artifacts.comments.openInList" }) : ""}</span> : null}
        </ArtifactCardHoldContext.Provider>
      </BubbleShell>
      {deleting ? (
        <ConfirmDialog
          title={formatMessage({ id: "artifacts.comments.deleteTitle" })}
          message={formatMessage({ id: "artifacts.comments.deleteBody" })}
          confirmLabel={formatMessage({ id: "artifacts.comments.deleteConfirm" })}
          confirmTestId="artifact-comment-bubble-delete-confirm"
          onConfirm={confirmDelete}
          onClose={cancelDelete}
        />
      ) : null}
      {deleteDraftDialog}
    </>
  );
}

function ThreadInBubble({ thread, editing, canReply, onEdit, onStopEditing, onDelete, onDeleteDraft, cardRef, listWay, inMargin = false }: {
  thread: ArtifactCommentThread;
  editing: ArtifactCommentId | null;
  canReply: boolean;
  onEdit: (id: ArtifactCommentId) => void;
  onStopEditing: (id: ArtifactCommentId, wanted?: () => boolean) => void;
  onDelete: (comment: ArtifactComment) => void;
  onDeleteDraft: (draft: ArtifactCommentDraft) => Promise<boolean>;
  /** The card's ref: where focus goes back when a reply draft's confirmation closes (ThreadBubble). */
  cardRef: (element: HTMLDivElement | null) => void;
  /** On the ⋯ at the card's top right: its first comment's, a deleted one having no header. */
  listWay: ArtifactCardListWay | null;
  /** In a Markdown Artifact's margin: the card's own active border and lift (a Popover has its own). */
  inMargin?: boolean;
}) {
  const { formatMessage } = useIntl();
  const anchor = anchorOf(thread.first);
  const pending = usePendingReplies(thread);
  const found = useAnchorFound(thread.first);
  // Under a placeholder (the comment it answers is on an earlier page), a reply answers the first reply.
  const replyTo = thread.root ?? thread.first;
  const replyMode = useMemo(() => ({ kind: "new" as const, target: replyTo.target, replyTo }), [replyTo]);
  const { draftOption } = useReplyDraftOption(replyTo);
  const topId = (thread.root && !thread.root.deletedAt ? thread.root : thread.replies.find((reply) => !reply.deletedAt))?.id;
  // Resolved here (#249), its marker goes from the page, and the card beside it with it: the focus
  // goes on (focusAfterResolvedCard), never to the body.
  const comments = useArtifactComments();
  const closeResolved = useCallback((threadId: ArtifactCommentId, resolved: boolean, wanted: () => boolean) => {
    // Its focus is focusAfterResolvedCard's, which moves it only where it went with the card (focusLost): the answer
    // isn't needed here, asked only so it stops watching.
    wanted();
    if (!resolved || !comments) return;
    focusAfterResolvedCard(comments, threadId);
    comments.closeBubble();
  }, [comments]);
  const resolution = useThreadResolution(thread, closeResolved);
  return (
    // Focusable (not in the Tab order): where focus goes when a reply draft in it is deleted.
    <CommentCard ref={cardRef} active tabIndex={-1} className={inMargin ? "outline-none" : "border-0 shadow-none outline-none"} data-testid="artifact-comment-bubble-card" data-thread-id={thread.id}>
      {anchor ? (
        <CommentCardMeta data-found={found ? "true" : "false"}>
          {found ? null : <MapPinOff aria-hidden />}
          <span className="min-w-0 truncate"><AnchorMeta anchor={anchor} found={found} /></span>
        </CommentCardMeta>
      ) : null}
      {thread.root ? (
        <CommentItem comment={thread.root} editing={editing === thread.root.id} onEdit={onEdit} onStopEditing={onStopEditing} onDelete={onDelete} listWay={thread.root.id === topId ? listWay : null} inCard />
      ) : (
        <p className="text-callout text-foreground-hint italic">{formatMessage({ id: "artifacts.comments.replyToEarlier" })}</p>
      )}
      {thread.replies.map((reply) => (
        <CommentItem key={reply.id} comment={reply} editing={editing === reply.id} onEdit={onEdit} onStopEditing={onStopEditing} onDelete={onDelete} listWay={reply.id === topId ? listWay : null} inCard />
      ))}
      {pending.map((draft) => <PendingReplyDraft key={draft.id} draft={draft} thread={thread} onDelete={onDeleteDraft} />)}
      {resolution.resolved ? <ResolvedBy root={thread.root!} /> : null}
      {resolution.may ? <div><ResolveButton resolution={resolution} /></div> : null}
      {/* Empty, and never focused for the person: they click into it themselves (co-design S2). */}
      {canReply ? <ArtifactCommentBox key={draftOption ? "drafts" : "post"} mode={replyMode} draftOption={draftOption} inCard /> : null}
    </CommentCard>
  );
}

function ComposeBubble({ bubble, phone, boundary }: { bubble: Extract<Bubble, { kind: "compose" }>; phone: boolean; boundary: HTMLElement | null }) {
  const { formatMessage } = useIntl();
  const comments = useArtifactComments()!;
  const fromPage = bubble.fromPage;
  const armed = useArmed(fromPage ? bubble.key : null);
  const { closeBubble } = comments;
  const mode = useMemo(() => ({ kind: "new" as const, target: bubble.target, replyTo: null }), [bubble.target]);
  // × (the card's, ArtifactComposeCard) drops its words and closes it; closed any other way (Esc,
  // Tab out, the sheet swiped away) they are kept, back when a comment is started at the same place
  // or the Artifact is opened again. A press outside closes it only while it holds none (the layer).
  const pageOpen = useMemo(() => (fromPage ? { draft: fromPage.draft, key: bubble.key } : null), [fromPage, bubble.key]);
  // Save Draft beside Send (#148): kept at the card's place, then the card goes (a draft has no card of its own).
  const addDraftAt = useArtifactReview()?.addDraftAt;
  const saveHere = useCallback(async (body: ArtifactCommentPart[], images: ObjectFileId[]) => {
    await addDraftAt!(bubble.target, body, images);
    closeBubble();
  }, [addDraftAt, bubble.target, closeBubble]);
  const draftOption = useDraftOption(addDraftAt ? saveHere : null);
  // Sent, this card gives way to the comment's own (or to the list): `revealSent` closes it, not `onDone`.
  const sentFrom = useMemo(() => ({ rect: bubble.rect, bubbleKey: bubble.key }), [bubble.rect, bubble.key]);
  const place = bubble.target.scope === "file" ? bubble.target.anchor : null;
  const autoFocusKey = fromPage || bubble.restored ? null : bubble.key;
  const boxProps = useMemo(() => ({ mode, draftOption, pageOpen, autoFocusKey, revealSent: sentFrom }), [mode, draftOption, pageOpen, autoFocusKey, sentFrom]);
  // What had the focus as the card opens, read before its box takes it. Base UI reads it a commit
  // later, after that box's own effect: a card that focuses its box gets back that box, gone with
  // the card. And a selection's Comment goes as the box takes the focus where the document has one
  // selection (Chromium, Safari). So: that element if it is still there, else the Artifact's surface,
  // never the body. On Firefox a return into the frame during the key is refused: the surface too.
  const [opener] = useState(() => document.activeElement);
  const keyedOut = useCallback(() => {
    if (!focusLost()) return;
    if (opener && canTakeFocus(opener)) opener.focus({ preventScroll: true });
    if (focusLost()) focusArtifactSurface();
  }, [opener]);
  return (
    <BubbleShell
      rect={bubble.rect}
      boundary={boundary}
      phone={phone}
      armed={armed}
      open
      focus={false}
      label={formatMessage({ id: "artifacts.comments.boxLabel" })}
      testId="artifact-comment-compose"
      padded
      onClose={closeBubble}
      onKeyedOut={keyedOut}
    >
      {/* The person's own Comment: focus moves in (Porthole's focusField). The page's button, or words kept from before a reload: it doesn't. */}
      <ArtifactComposeCard
        place={place}
        onClose={closeBubble}
        placeTestId="artifact-comment-compose-place"
        cancelTestId="artifact-comment-cancel"
        box={boxProps}
      />
    </BubbleShell>
  );
}
