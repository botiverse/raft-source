import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SyntheticEvent } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  DrawerActions,
  DrawerBody,
  DrawerFooter,
  Popover,
  PopoverContent,
  TextSelectionToolbar,
  TextSelectionToolbarButton,
} from "@botiverse/raft-ui";
import { AddCommentIcon } from "@botiverse/ricons";
import { CommentMarker, PopoverBody } from "@botiverse/raft-ui/wip";
import type { AnnotationRect } from "@botiverse/porthole";

import { DraftPlace } from "./ArtifactActorParts";
import { ArtifactCardShell } from "./ArtifactCardShell";
import { useCardTabOut } from "./artifactCardTabOut";
import { anchorAt } from "./ArtifactCommentBubble";
import type { ArtifactCommentBoxKeep } from "./ArtifactCommentBox";
import { ArtifactComposeCard } from "./ArtifactComposeCard";
import { useArtifactComments } from "./ArtifactCommentsContext";
import type { SentFrom } from "./ArtifactCommentsContext";
import { useArtifactReview } from "./ArtifactReviewContext";
import type { ArtifactReviewSelection } from "./ArtifactReviewContext";
import { EDGE_MARKER_PX, edgeMarkerPlace, sameRect, selectionPlace, sheetLift } from "./artifactTrackedPlaces";
import type { PlaceStore, SelectionFollow } from "./artifactTrackedPlaces";
import { useArmed } from "./useArmed";
import { useDismissable } from "./useArtifactDismiss";
import { useDraftOption } from "./useDraftOption";

// Comment mode's box at a selection or a picked block, and the Comment button before it
// (ArtifactReviewLayer draws it; #proj-workspace:#148, #229).

/** A selection's place, as a draft's anchor. */
const placeOf = (selection: ArtifactReviewSelection) => selection.place;

/** The frame's last word on where the open composer's selection is (`key`: its ArtifactReviewSelection's); null until it says, or for another. */
function useSelectionFollow(places: PlaceStore<SelectionFollow>, key: number | null): SelectionFollow | null {
  const read = useCallback(() => {
    const follow = places.get();
    return key !== null && follow?.key === key ? follow : null;
  }, [places, key]);
  return useSyncExternalStore(places.subscribe, read);
}

/**
 * The frame lifted by `px` (0: back in place), so what a phone's sheet would cover is above it
 * (`sheetLift`). The page can't be scrolled from here, so its frame moves up, clipped by the
 * frame's own region (never over the viewer's header), until the sheet goes.
 */
function liftFrame(box: HTMLElement, px: number) {
  box.style.transform = px > 0 ? `translateY(${-px}px)` : "";
  if (box.parentElement) box.parentElement.style.overflow = px > 0 ? "clip" : "";
}

/** How the composer at a selection was closed: by a press in the page (which takes no selection), or any other way. */
type ComposerClose = "page" | "raft";

/**
 * Where the composer follows its selection (#proj-workspace:#229, Kirby; Porthole P138, P140): on
 * a desktop, beside the selection or the picked block as the page scrolls or reflows, armed again
 * against presses each time it moves or shows again (`moved`: never `inert` then, so the person
 * typing in it keeps the focus); out of view, hidden (its words and its focus kept) with a marker
 * at the frame's edge that shows it there again. On a phone, the sheet, with the frame lifted so the
 * selection is above it.
 */
export function SelectionBox({ selection, phone, viewer }: { selection: ArtifactReviewSelection; phone: boolean; viewer: () => HTMLElement | null }) {
  const { formatMessage } = useIntl();
  const review = useArtifactReview()!;
  const comments = useArtifactComments();
  const armed = useArmed(selection.key);
  const writing = selection.writing ?? false;
  // The composer at a selection or a picked block follows it (`trackedSelection`, ArtifactReviewContext);
  // the one the page's own button opened at its place has nothing to follow.
  const followed = writing && selection.place.type === "annotation";
  const follow = useSelectionFollow(review.selectionPlaces, followed ? selection.key : null);
  const tracked = follow?.report ?? null;
  const attached = tracked?.state === "attached" ? tracked : null;
  const frameBox = follow?.frameBox ?? null;
  // Out of view: hidden, with a marker at the frame's edge; pressed, the composer shows at that edge
  // until its selection is in view again (`atEdge`).
  const edge = !phone && attached && !attached.inView && frameBox ? edgeMarkerPlace(attached, frameBox) : null;
  const [atEdge, setAtEdge] = useState(false);
  if (atEdge && edge === null) setAtEdge(false);
  const hidden = edge !== null && !atEdge;
  const place = phone ? null
    : attached?.inView ? selectionPlace(attached, frameBox)
    : edge ? { x: edge.x, y: edge.y, width: EDGE_MARKER_PX, height: edge.edge === "top" ? 0 : EDGE_MARKER_PX }
    : null;
  // Where it is drawn (its last place while hidden), and the key of its last move or showing again,
  // which arms it against presses (THREAT_MODEL §6: it moves at the page's word). Only a real move:
  // the same place again changes nothing.
  // oxlint-disable-next-line react-doctor/no-derived-useState -- where the composer was last drawn and the move that put it there, adjusted during render as the frame's reports come (React's "adjusting state when a prop changes").
  const [moved, setMoved] = useState<{ rect: AnnotationRect | null; key: number | null; hidden: boolean }>({ rect: selection.rect, key: null, hidden: false });
  if (hidden && !moved.hidden) setMoved({ ...moved, hidden: true });
  if (!hidden && place && (moved.hidden || !moved.rect || !sameRect(moved.rect, place))) setMoved({ rect: place, key: (moved.key ?? 0) + 1, hidden: false });
  const moveArmed = useArmed(moved.key);
  const shownRect = moved.rect ?? selection.rect;
  // The Comment button sits at the selection's end; the box opens under it, from the same corner.
  const anchor = useMemo(() => anchorAt(shownRect), [shownRect]);
  const { clearSelection, commentSent, setComposerHasOwnText, addDraft } = review;
  const label = formatMessage({ id: writing ? "artifacts.comments.boxLabel" : "artifacts.review.optionsLabel" });
  const path = comments?.shownPath ?? null;
  const mode = useMemo(() => ({ kind: "new" as const, target: { scope: "file" as const, path: path ?? "", anchor: selection.place }, replyTo: null }), [path, selection.place]);
  // Sent, the new thread's card opens where the composer is then (read as the answer comes).
  const [sentFrom] = useState<SentFrom>(() => ({ rect: selection.rect, bubbleKey: null }));
  useLayoutEffect(() => {
    sentFrom.rect = shownRect;
  }, [sentFrom, shownRect]);
  // Send posts it now; Save Draft keeps it with the others until they are sent together (the bar).
  // With drafts already waiting, Enter saves one more.
  const draftOption = useDraftOption(addDraft);
  // The page's own button (comments.open): its suggested text, the page's until the person acts.
  const fromPage = selection.fromPage;
  const pageOpen = useMemo(() => (fromPage ? { draft: fromPage.draft, key: selection.key } : null), [fromPage, selection.key]);

  // Closing a followed composer (#proj-workspace:#229, Kirby): empty, it goes; with the person's
  // words (or an image), they are kept as a draft first, its marker in the page (Save Draft's own
  // path, `keep`), and the box's `onDone` closes it. Where no draft can be kept now (the cap), it
  // goes as before, its words kept on this device; a save that fails keeps it open, saying so.
  // Every close ends the follow, and all but a press in the page take the selection away
  // (ArtifactReviewContext `takeSelection`): the same for every outcome of a way of closing.
  const ownText = useRef(false);
  const onOwnText = useCallback((own: boolean) => {
    ownText.current = own;
    setComposerHasOwnText(own);
  }, [setComposerHasOwnText]);
  const keep = useRef<(() => Promise<ArtifactCommentBoxKeep>) | null>(null);
  const closedBy = useRef<ComposerClose>("raft");
  const closing = useRef(false);
  // Once: a close can come twice (its place gone as it is being dismissed).
  const finished = useRef(false);
  const finish = useCallback((by: ComposerClose) => {
    if (finished.current) return;
    finished.current = true;
    if (by === "page") clearSelection();
    else commentSent();
  }, [clearSelection, commentSent]);
  const onDone = useCallback(() => (followed ? finish(closedBy.current) : commentSent()), [followed, finish, commentSent]);
  const dismiss = useCallback(async (by: ComposerClose) => {
    if (closing.current) return;
    const keepNow = ownText.current ? keep.current : null;
    if (!keepNow) {
      finish(by);
      return;
    }
    closing.current = true;
    closedBy.current = by;
    const kept = await keepNow();
    closing.current = false;
    if (kept === "unavailable") finish(by);
    else if (kept !== "kept") closedBy.current = "raft";
  }, [finish]);
  const dismissHere = useCallback(() => { void dismiss("raft"); }, [dismiss]);
  // Its place gone from the page (the frame's word of its selection, `orphaned`: a re-render took
  // it out, a reload): it closes as on Esc, its words kept as a draft. Heard as the word comes.
  // (The store is told only of the open composer's selection, and each composer is its own mount.)
  const { selectionPlaces } = review;
  useEffect(() => {
    if (!followed) return;
    const heard = () => {
      if (selectionPlaces.get()?.report.state === "orphaned") void dismiss("raft");
    };
    return selectionPlaces.subscribe(heard);
  }, [followed, selectionPlaces, dismiss]);
  // On the dismissal layer while it is the box (artifactDismissLayer: a press outside, Esc, one card
  // at a time). A followed composer closes on a press with words too, as closing it keeps them as
  // a draft (`dismiss`), and on a press in the page, as it did before the layer; opened with the
  // focus in the frame (a block picked), it hands it back, to hear that press. The one the page's
  // button opened stays open over typed words, hears no press in the page, and keeps the focus
  // where the person had it (Tenny, #11389).
  const popup = useRef<HTMLDivElement | null>(null);
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  const { change } = useDismissable(writing, {
    card: true,
    pressKeepsWords: followed || phone,
    hearsPagePress: followed && !phone,
    handsFocusBack: followed && !phone,
    element: () => (phone ? sheet : popup.current),
    close: (by) => {
      if (followed) void dismiss(by === "pagePress" ? "page" : "raft");
      else clearSelection();
    },
  });

  // After the card's × (its words dropped, ArtifactComposeCard): closed otherwise, it keeps them.
  const closeCard = useCallback(() => {
    if (followed) finish("raft");
    else clearSelection();
  }, [followed, finish, clearSelection]);
  const close = useCallback((open: boolean, details?: { reason?: string; event?: Event }) => {
    if (open) return;
    // The Comment button (not the box yet) goes with any way out, as the selection it is for.
    if (!writing) {
      clearSelection();
      return;
    }
    // A press on its own marker at the frame's edge shows it: not a press outside it.
    const target = details?.event?.target;
    if (details?.reason === "outside-press" && target instanceof Element && target.closest("[data-testid='artifact-review-composer-edge-popup']")) return;
    change(open, details);
  }, [writing, clearSelection, change]);
  // The box's Tab past its ends: as Esc, its words kept and the focus on the viewer (`finalFocus`).
  const tabOut = useCardTabOut(armed, followed ? dismissHere : clearSelection);
  // Closed with focus in it (Esc, Tab out, a draft saved): focus goes to the viewer itself, whose next Esc
  // leaves B. Not Base UI's default, what had focus before it opened (or, for the viewer, its first
  // control): a header button focused as by the keyboard opens its tooltip, which takes that next
  // Esc for itself. Moved here, as Base UI would move it only to a tabbable element (the viewer is
  // not one). Focus elsewhere (the page, whose Esc closed the box) stays there.
  const finalFocus = useCallback(() => {
    const active = document.activeElement;
    // After React's commit, which would give focus back to what had it as it began (artifactDraftDelete).
    if (!active || active === document.body || active.closest("[data-testid='artifact-review-composer']")) queueMicrotask(() => viewer()?.focus({ preventScroll: true }));
    return false;
  }, [viewer]);

  // Hidden with the focus in it (visibility hidden may drop it to the body): back where it was when
  // it shows again, unless the person put the focus somewhere else meanwhile. Raft's own press on
  // the edge marker shows it with the focus in the box.
  const focusWhenShown = useRef<HTMLElement | null>(null);
  const markerPressed = useRef(false);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (hidden) {
      if (active instanceof HTMLElement && popup.current?.contains(active)) focusWhenShown.current = active;
      return;
    }
    const back = focusWhenShown.current;
    const pressedMarker = markerPressed.current;
    focusWhenShown.current = null;
    markerPressed.current = false;
    if (back?.isConnected && (pressedMarker || !active || active === document.body || active === back)) back.focus({ preventScroll: true });
  }, [hidden]);
  const showAtEdge = useCallback(() => {
    markerPressed.current = true;
    focusWhenShown.current ??= popup.current?.querySelector<HTMLElement>("textarea") ?? null;
    setAtEdge(true);
  }, []);
  // Swallows a press while the composer has just moved at the page's word (`moveArmed`): it never
  // lands on what moved under the pointer. Keys stay the person's, in the box they are writing in.
  const guardPress = useCallback((event: SyntheticEvent) => {
    if (!moveArmed) return;
    event.preventDefault();
    event.stopPropagation();
  }, [moveArmed]);

  // On a phone, the frame lifted so the selection is above the sheet (`sheetLift`), as the page
  // scrolls or reflows; back in place once the sheet goes.
  const frameRegion = comments?.frame.box ?? null;
  const lifted = useRef(0);
  useLayoutEffect(() => {
    const box = frameRegion?.current;
    if (!phone || !box || !sheet || !attached) return;
    const frame = box.getBoundingClientRect();
    const top = frame.top + lifted.current;
    const sheetTop = document.documentElement.clientHeight - sheet.offsetHeight;
    const target = { top: attached.documentRect.y - attached.scroll.y, bottom: attached.documentRect.y + attached.documentRect.height - attached.scroll.y };
    const next = sheetLift(target, sheetTop - top, frame.height);
    if (next === lifted.current) return;
    lifted.current = next;
    liftFrame(box, next);
  }, [phone, sheet, attached, frameRegion]);
  useEffect(() => () => {
    const box = frameRegion?.current;
    if (box && lifted.current > 0) liftFrame(box, 0);
    lifted.current = 0;
  }, [frameRegion]);

  // The box: the person pointed here on purpose (the Comment button, a block picked), so focus
  // moves in (Porthole's focusField) once it is armed; never for the page's button. Sent, the card
  // goes and the new thread's card opens in its place, marked Sent (`revealSent`). Made again only
  // when what is in it changes: a move re-places the card alone.
  const autoFocusKey = armed || fromPage ? null : selection.key;
  const boxProps = useMemo(() => ({ mode, draftOption, pageOpen, autoFocusKey, onDone, onOwnText, revealSent: sentFrom, keepRef: keep }), [mode, draftOption, pageOpen, autoFocusKey, onDone, onOwnText, sentFrom]);
  const box = useMemo(() => (writing ? (
    <ArtifactComposeCard
      place={placeOf(selection)}
      onClose={closeCard}
      testId="artifact-review-comment-box"
      placeTestId="artifact-review-quote"
      cancelTestId="artifact-review-comment-cancel"
      box={boxProps}
    />
  ) : null), [writing, selection, closeCard, boxProps]);
  // The marker's place: a box of its width and no height at the edge, its popup under it from its start.
  const edgeX = edge?.x ?? 0;
  const edgeY = edge?.y ?? 0;
  const edgeAnchor = useMemo(() => anchorAt({ x: edgeX, y: edgeY, width: EDGE_MARKER_PX, height: 0 }), [edgeX, edgeY]);
  // Its own popover never closes itself: it is there exactly while the composer is hidden.
  const keepMarker = useCallback(() => {}, []);
  // One surface for both of its states (ArtifactCardShell), so the Comment button becomes the box
  // in place: the button is no card (`none`: raft-ui's TextSelectionToolbar is its own surface, and
  // on a phone the quote and the button are the sheet's body and footer), the box is the card.
  const guarded = moveArmed ? guardPress : undefined;
  const boundary = viewer();
  const sheetPart = useMemo(() => ({ ref: setSheet }), []);
  const popoverPart = useMemo(() => ({
    ref: popup,
    anchor,
    side: "bottom" as const,
    align: writing ? "start" as const : "end" as const,
    collisionBoundary: boundary ?? undefined,
    finalFocus,
    "aria-label": writing ? label : undefined,
    inert: armed || undefined,
    onKeyDown: writing ? tabOut : undefined,
    onPointerDownCapture: guarded,
    onMouseDownCapture: guarded,
    onClickCapture: guarded,
  }), [anchor, writing, boundary, finalFocus, label, armed, tabOut, guarded]);
  const options = phone ? (
    <>
      <DrawerBody>
        <p className="line-clamp-3 text-callout text-foreground-muted" data-testid="artifact-review-quote">
          <DraftPlace anchor={placeOf(selection)} />
        </p>
      </DrawerBody>
      {/* The toolbar's button and icon, as a 44px touch target on the sheet. */}
      <DrawerFooter>
        <DrawerActions>
          <Button variant="outline" size="lg" onClick={review.commentNow} data-testid="artifact-review-comment-now">
            <AddCommentIcon />
            {formatMessage({ id: "artifacts.review.commentNow" })}
          </Button>
        </DrawerActions>
      </DrawerFooter>
    </>
  ) : (
    <TextSelectionToolbar aria-label={label}>
      <TextSelectionToolbarButton onClick={review.commentNow} data-testid="artifact-review-comment-now">
        <AddCommentIcon />
        {formatMessage({ id: "artifacts.review.commentNow" })}
      </TextSelectionToolbarButton>
    </TextSelectionToolbar>
  );
  return (
    <>
      <ArtifactCardShell
        phone={phone}
        open
        onOpenChange={close}
        label={label}
        testId={writing ? "artifact-review-composer" : "artifact-review-options"}
        // Armed again each time it moves or shows again at the page's word (`moveArmed`): marked, never inert then.
        armed={armed || moveArmed}
        surface={box ? "padded" : "none"}
        // Hidden (its selection out of view): not drawn, but kept, words and all.
        hidden={hidden}
        sheet={sheetPart}
        popover={popoverPart}
      >
        {box ?? options}
      </ArtifactCardShell>
      {/* The composer's marker at the frame's edge while its selection is out of view (raft-ui's
          CommentMarker, dashed as a draft's: not posted yet), level with it across, in a raft-ui
          Popover of its own at that place (no surface: the marker is it). It takes no focus, so the
          composer's stays where it was; pressed, the composer shows there, its focus in the box. */}
      <Popover open={hidden} onOpenChange={keepMarker}>
        <PopoverContent
          anchor={edgeAnchor}
          side="bottom"
          align="start"
          sideOffset={0}
          initialFocus={false}
          finalFocus={false}
          aria-label={formatMessage({ id: "artifacts.review.composerOutOfView" })}
          className="min-w-0 overflow-visible bg-transparent p-0 shadow-none ring-0"
          data-testid="artifact-review-composer-edge-popup"
          data-edge={edge?.edge}
        >
          {/* The marker alone, no padding: it is the surface. */}
          <PopoverBody className="p-0">
            <CommentMarker
              active
              aria-label={formatMessage({ id: "artifacts.review.composerOutOfView" })}
              onClick={showAtEdge}
              className="w-6 justify-center border-dashed ps-0 pe-0 data-active:ps-0 data-active:pe-0"
              data-testid="artifact-review-composer-edge"
            >
              <AddCommentIcon aria-hidden />
            </CommentMarker>
          </PopoverBody>
        </PopoverContent>
      </Popover>
    </>
  );
}
