import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { artifactFileType, currentTimeMs, isArtifactFramedKind } from "@botiverse/raft-shared";
import type { ArtifactComment, ArtifactCommentId, ArtifactReviewId, ArtifactViewerData, ArtifactWebCommentsPage } from "@botiverse/raft-shared";
import type { AnnotationRect, AnnotationReport } from "@botiverse/porthole";
import type { PortholeFrameHandle } from "@botiverse/porthole/react";

import { artifactSource } from "./artifactSource";
import { useShownFile } from "./artifactShownFile";
import type { ArtifactViewerActor } from "./artifactApi";
import { useCommentBoxesAndPageOpens } from "./usePageOpenGate";
import type { PageCommentRequest } from "./artifactPageComments";
import { heldKeyboard } from "./artifactCardHold";
import { anchorOf, buildThreads, reopenedBy } from "./artifactComments";
import { commentMarks } from "./artifactCommentMarks";
import { useArtifactActivityRefresh } from "./useArtifactActivityRefresh";
import type { CommentBoxState } from "./useCommentBoxes";
import { useUnsentCommentOffer } from "./useUnsentCommentOffer";
import { followedPlace, inClient, sameRect, trackedPlaces } from "./artifactTrackedPlaces";
import type { FrameBox, TrackedPlace, TrackedPlaces } from "./artifactTrackedPlaces";
import { useArtifactMargin } from "./useArtifactMargin";
import { landingStep } from "./artifactLandingPlace";
import type { ArtifactMarginLayer } from "./useArtifactMargin";
import type { ArtifactCommentsOpening } from "./artifactViewerStore";

export type { TrackedPlace } from "./artifactTrackedPlaces";

export type { ArtifactCommentBubble, ArtifactCommentsReview, ArtifactCommentTarget, ArtifactFrameLayer, SentFrom, ShownReview } from "./artifactCommentsShapes";
import type { ArtifactCommentBubble, ArtifactCommentsReview, ArtifactCommentTarget, ArtifactFrameLayer, SentFrom, ShownReview } from "./artifactCommentsShapes";
import { useReviewFilter } from "./artifactReviewFilter";
import type { ArtifactReviewFilter } from "./artifactReviewFilter";

export { followedPlace, inClient };
export type { FrameBox };

export interface ArtifactCommentsState {
  data: ArtifactViewerData;
  /** The file shown: comments start on it. */
  shownPath: string | null;
  /** Who is signed in (the viewer data's `viewer`). */
  viewer: ArtifactViewerActor;
  /** The comments loaded so far (the newest page, then earlier ones on request); null while loading. */
  comments: ArtifactComment[] | null;
  failed: boolean;
  /** Earlier comments are on pages not loaded yet. */
  hasEarlier: boolean;
  loadingEarlier: boolean;
  /** The last request for earlier comments failed (the list offers to try again). */
  earlierFailed: boolean;
  loadEarlier: () => void;
  /** Load the newest page again (what others or an earlier attempt posted meanwhile). */
  reload: () => void;
  /**
   * The review (S8) the list shows alone, opened from its Activity row: its comments are loaded
   * with the newest page (`comments(id, { review })`) and the list shows only those until
   * `showAllComments` (which the slot's owner answers, its address losing `review`). Null: every
   * comment.
   */
  reviewShown: ArtifactReviewId | null;
  /**
   * What the server answered for it, once loaded (null until then): `ok` with the review (its
   * summary is `review.body`, not a comment of the list) and the ids of its comments; `missing`
   * (`page.review` null: not a review of this Artifact, nothing to list); `failed` (`reload` tries
   * again).
   */
  shownReview: ShownReview | null;
  showAllComments: () => void;
  /** The review opened at, for the list's Filter button (useReviewFilter); null: none. */
  reviewFilter: ArtifactReviewFilter | null;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  /**
   * The comment the viewer landed on (`landOn`, a comment's Activity row), once the loaded list
   * had it: its thread became the one being read, and its bubble opens at its place (a framed
   * page's beside its mark's box once the frame says where, `anchored`, however long that takes up
   * to LANDING_FRAME_CAP_MS: no report says where a marker is, and since Porthole's P133 a posted
   * one sits at its paragraph's end, not always on that box; a text or csv file's at its marker).
   * A comment with no marker (on the whole Artifact, a page's place, a lost passage) opens the list on it instead; so does a frame
   * that failed (`frameFailed`) while it waits, until the frame says where after all. Null until
   * then, and with none to land on.
   */
  landedOn: ArtifactCommentId | null;
  /** The thread being read: highlighted in the list and in the page. */
  activeThreadId: ArtifactCommentId | null;
  /** Raft's own: a click in the list, a shell marker, a landing. */
  setActiveThreadId: (id: ArtifactCommentId | null) => void;
  /**
   * The key of the frame's report that made `activeThreadId` the one being read in the list (its
   * marker clicked while the list was open, Porthole `activated`), new for each; null when Raft set
   * it. A view the page's report opens takes no focus and no press for its first moments
   * (THREAT_MODEL §6).
   */
  threadFromFrame: number | null;
  /**
   * A marker in the page was clicked (the page's word, with the marker's box in client px): its
   * thread's bubble opens beside it, or, while the list is open, the list on it (one list at a
   * time, co-design S8). Either takes no focus and is armed, but for a card opened with the focus
   * in this frame (`focusedFrame`, read as the report arrived), or in place of a held one: that one
   * takes it on its container, and is held (`keyboard`, P134). Whether it opened (only a thread the
   * frame was given a mark for).
   */
  openThreadFromFrame: (id: string, rect: AnnotationRect | null, focusedFrame?: HTMLIFrameElement | null) => boolean;
  /** The thread a marker is hovered for (the page shows its passage as active). */
  hoveredThreadId: ArtifactCommentId | null;
  setHoveredThreadId: (id: ArtifactCommentId | null) => void;
  /**
   * The card floating beside a marker or a selection (ArtifactCommentBubble; a bottom sheet on a
   * phone): a thread to read and reply to, or a new comment to write (a selection's Comment, the
   * page's own button). One at a time.
   */
  bubble: ArtifactCommentBubble | null;
  /** Raft's own marker (a text or csv file's) clicked: the thread's bubble beside it. */
  openThreadBubble: (id: ArtifactCommentId, rect: AnnotationRect) => void;
  /** The held card's way on (artifactCardHold): the list, with the focus on this thread's card, which answers no key. */
  openThreadInList: (id: ArtifactCommentId) => void;
  /** A selection's Comment (Raft's own button): a new comment's bubble at the selection, focused. */
  composeAt: (target: ArtifactCommentTarget, rect: AnnotationRect | null) => void;
  closeBubble: () => void;
  /** The person pressed in the bubble: from now on it stays where it is (the page can't move it), and it is no longer held. */
  pinBubble: () => void;
  /** The focus went into the bubble's controls: it stays where it is, re-armed by no move of the page's, and stays held. */
  keepBubble: () => void;
  /** The open card is held (artifactCardHold): no report of the frame's opens anything else. */
  cardHeld: boolean;
  /** Puts the keyboard back on a mark's marker in the frame (`focusMark`, P134). False: no frame to tell. */
  focusMark: (id: ArtifactCommentId) => boolean;
  /** A landed thread on a text or csv file, whose bubble waits for its marker (ArtifactShellComments). */
  shellLanding: ArtifactCommentId | null;
  /** The landed thread's marker is here (client px; null: none drawn, the list opens on it instead). */
  landBubble: (rect: AnnotationRect | null) => void;
  /**
   * The framed page failed or fell back (ArtifactFrame's error or fallback view: a real failure,
   * not a slow page) while `failed`, and is back (a retry) once it isn't. A landing waiting for the
   * frame shows the list on its comment meanwhile, and still opens its card if the frame says where.
   */
  frameFailed: (failed: boolean) => void;
  /** The framed page has loaded (its loading splash is gone; ArtifactFrame reports it): false until then and once it goes. */
  pageShown: boolean;
  pageLoaded: (loaded: boolean) => void;
  /**
   * The page asked to open the box at its anchor (Porthole `comments.open`,
   * already checked: parsePageCommentRequest), with the frame's box to open
   * it beside. Whether it opened: not where the viewer may not comment, not
   * within a second of the last one, and never over a comment the person is
   * writing or a place they chose (a page can't replace or move their words).
   */
  openFromPage: (request: PageCommentRequest, frameRect?: AnnotationRect | null) => boolean;
  askPageOpen: (stillOpen: boolean) => boolean; // whether the page may open its box now, counted when it may (artifactPageOpenGate); comment mode's box asks it too
  /** A new-comment box says whether it holds words the person wrote (not a page's untouched draft). */
  setComposerHasOwnText: (own: boolean) => void;
  /**
   * Some comment box here holds the person's own words: any box (a new comment's, a reply, an
   * edit, a draft's, the one at the foot), not a page's untouched draft. A newer version then
   * waits behind its strip (useFollowLatest): content never moves under someone writing.
   */
  holdsOwnWords: boolean;
  /** Some box is focused, or open on the person's act (any but the list's foot), even empty (voice text may not have landed): a newer version waits too. */
  boxEngaged: boolean;
  /** A box (`box`: its own id) says what it is now (CommentBoxState); null when it goes. */
  reportBox: (box: string, state: CommentBoxState | null) => void;
  /**
   * A new comment left unsent before a reload, at lines or rows of the file shown, waiting for them
   * to be drawn (ArtifactShellComments answers `reopenUnsent`: its card opens where they are; null,
   * not found, it goes to the list's foot). Null: none waiting (useUnsentCommentOffer).
   */
  unsentAt: ArtifactCommentTarget | null;
  reopenUnsent: (rect: AnnotationRect | null) => void;
  /** An unsent comment's draft key the list's foot box takes the words of (made again on it), or null. */
  unsentForList: string | null;
  /**
   * For a framed page, without comment mode (ArtifactReviewContext adds its drafts and selections
   * on top): the posted threads' marks, the one being read, the open card's mark followed, and the
   * frame's reports (a marker clicked opens its thread; the followed mark's moves move its card).
   */
  frame: ArtifactFrameLayer;
  /** Where the open thread card's mark moved to (`tracked`); read through `useTrackedPlace`. */
  trackedPlaces: TrackedPlaces;
  /** A Markdown Artifact's comments as cards in the margin beside it (useArtifactMargin, #152). */
  margin: ArtifactMarginLayer;
  /** The lines or rows of the file the shell draws, for line and row anchors (null: a page, or not loaded). */
  shellUnits: { path: string; units: readonly string[] } | null;
  setShellUnits: (units: { path: string; units: readonly string[] } | null) => void;
  added: (comment: ArtifactComment) => void;
  /**
   * A comment just sent from a box that closes or clears when it sends (stdrc, #proj-workspace:#119:
   * there it seemed to vanish): added, its thread the one being read. From a card at a place a
   * marker shows (`from`: a selection's Comment, a new comment's card; a passage, region, lines,
   * rows), that card becomes its thread's card in place, marked sent (`sentId`) until it closes; the
   * list doesn't open (xxchan). Else (the list's foot, a page's place, the list open, another card
   * open meanwhile) the list opens on it (the DS active card), marked sent until the list closes.
   */
  revealSent: (comment: ArtifactComment, from?: SentFrom | null) => void;
  /** The comment `revealSent` showed, marked sent there; null once its card or the list closes. */
  sentId: ArtifactCommentId | null;
  replaced: (comment: ArtifactComment) => void;
  removed: (id: ArtifactCommentId) => void;
}

const Context = createContext<ArtifactCommentsState | null>(null);

/** How many comments the Artifact has: with earlier pages not loaded, the card's count; else what's loaded (placeholders don't count). */
export function commentCount(comments: ArtifactCommentsState): number {
  return comments.hasEarlier || !comments.comments ? comments.data.card.commentCount : comments.comments.filter((c) => !c.deletedAt).length;
}

/** Where the open thread card's mark is now, as the frame follows it; null until it moved (or none followed). */
export function useTrackedPlace(): TrackedPlace | null {
  const places = useContext(Context)?.trackedPlaces ?? null;
  const subscribe = useCallback((listener: () => void) => places?.subscribe(listener) ?? (() => {}), [places]);
  return useSyncExternalStore(subscribe, () => places?.get() ?? null);
}

/** The comments of the Artifact open in the viewer, shared by the list, the box and the page's markers. */
export function useArtifactComments(): ArtifactCommentsState | null {
  return useContext(Context);
}

interface Loaded {
  id: string;
  comments: ArtifactComment[] | null;
  olderCursor: string | null;
  failed: boolean;
  loadingEarlier: boolean;
  earlierFailed: boolean;
  /** The review shown, as this load found it; null when none was asked for. */
  shownReview: ShownReview | null;
}

/**
 * How long a landing waits at most for the frame to say where its marker is (a slow page, Remy
 * #proj-workspace:d03c42a0): then the list on it instead. A frame that failed shows the list at once.
 */
export const LANDING_FRAME_CAP_MS = 15_000;

/** The pages of one review's comments a viewer loads at most (a review is at most 50 drafts and a summary: two). */
const REVIEW_PAGES = 3;

/**
 * One review's comments, every page of it (up to REVIEW_PAGES), oldest first, its summary the
 * page's `review.body` (never in the list); `missing` when the page's `review` is null (not a
 * review of this Artifact), `failed` when it couldn't be read.
 */
async function reviewCommentsOf(id: ArtifactViewerData["card"]["id"], review: ArtifactReviewId): Promise<{ shown: ShownReview; comments: ArtifactComment[] }> {
  try {
    let page = await artifactSource().getComments(id, { review });
    if (!page.review) return { shown: { status: "missing" }, comments: [] };
    const info = page.review;
    const all = [...page.comments];
    for (let n = 1; n < REVIEW_PAGES && page.olderCursor; n += 1) {
      page = await artifactSource().getComments(id, { review, before: page.olderCursor });
      all.unshift(...page.comments);
    }
    return { shown: { status: "ok", review: info, commentIds: new Set(all.map((c) => c.id)) }, comments: all };
  } catch {
    return { shown: { status: "failed" }, comments: [] };
  }
}

/** The thread a comment is in (its root's id, as buildThreads makes them), or null when it isn't loaded. */
export function threadOfComment(comments: readonly ArtifactComment[], id: ArtifactCommentId, parentsMayBeOlder: boolean): ArtifactCommentId | null {
  if (!comments.some((c) => c.id === id)) return null;
  return buildThreads(comments, { parentsMayBeOlder }).find((t) => t.root?.id === id || t.replies.some((c) => c.id === id))?.id ?? null;
}

/** The newest page with a review's comments in it (each once), oldest first. */
function withReview(page: ArtifactComment[], review: ArtifactComment[]): ArtifactComment[] {
  const seen = new Set(page.map((c) => c.id));
  return [...page, ...review.filter((c) => !seen.has(c.id))].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

type NewestAnswer = [ArtifactWebCommentsPage, Awaited<ReturnType<typeof reviewCommentsOf>> | null];

/** The newest page, and the review shown's comments with it. */
function readNewest(id: ArtifactViewerData["card"]["id"], review: ArtifactReviewId | null): Promise<NewestAnswer> {
  return Promise.all([artifactSource().getComments(id), review ? reviewCommentsOf(id, review) : null]);
}

/**
 * What is loaded once the newest page answered (again: new activity, a landing, `reload`). Within
 * the time the page covers, the server's answer stands (a comment deleted since goes); before it,
 * what is loaded stays, and Load earlier goes on where it was. A page that doesn't reach what is
 * loaded (more than a page came meanwhile) replaces it, Load earlier going on from its cursor; so
 * does a first answer, and one that is every comment.
 */
function withNewest(prev: Loaded | null, id: string, [page, reviewed]: NewestAnswer): Loaded {
  const from = page.olderCursor === null ? undefined : page.comments[0]?.createdAt;
  const before = prev?.id === id && prev.comments && from !== undefined && prev.comments.some((c) => c.createdAt >= from)
    ? prev.comments.filter((c) => c.createdAt <= from)
    : null;
  const shownReview = reviewed?.shown ?? null;
  if (!prev || !before) return { id, comments: withReview(page.comments, reviewed?.comments ?? []), olderCursor: page.olderCursor, failed: false, loadingEarlier: false, earlierFailed: false, shownReview };
  return { ...prev, comments: withReview(withReview(page.comments, before), reviewed?.comments ?? []), failed: false, shownReview };
}

export function ArtifactCommentsProvider({ data, review = null, landOn: landOnRow = null, listOn = null, children }: {
  data: ArtifactViewerData;
  /** At a review (its Activity row): the list opens on its comments alone, until its `onShowAll`. */
  review?: ArtifactCommentsReview | null;
  /**
   * The comment to land on (a comment's Activity row, #proj-workspace:#82): once the list has
   * loaded with it, its thread is the one being read, so the page marks its passage as active and
   * an HTML page brings it into view (Porthole's `focusedAnnotation`). The comment list stays as
   * it was (bubble mode: the side panel is for Show All Comments only). Not in the newest page:
   * nothing to land on.
   */
  landOn?: ArtifactCommentId | null;
  /**
   * Opened on its comments (a message card's count, or a card with new comments): the list opens,
   * once per opening (a new object), on the thread of its first new comment (`at`) when there is
   * one, landed as `landOn` is but in the list rather than in a bubble.
   */
  listOn?: ArtifactCommentsOpening | null;
  children: ReactNode;
}) {
  const landOn = landOnRow ?? listOn?.at ?? null;
  const landsInList = landOnRow === null && landOn !== null;
  const id = data.card.id;
  // Loaded per Artifact: a list for another id (or none yet) reads as loading.
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const current = loaded?.id === id ? loaded : null;
  const comments = current?.comments ?? null;
  const failed = current?.failed ?? false;
  const olderCursor = current?.olderCursor ?? null;
  const loadingEarlier = current?.loadingEarlier ?? false;
  const earlierFailed = current?.earlierFailed ?? false;
  const setComments = useCallback((update: (list: ArtifactComment[] | null) => ArtifactComment[]) => {
    setLoaded((value) => (value && value.id === id ? { ...value, comments: update(value.comments) } : value));
  }, [id]);
  const reviewShown = review && review.shown !== false ? review.id : null;
  const shownReview = reviewShown !== null ? current?.shownReview ?? null : null;
  const onShowAll = review?.onShowAll;
  const showAllComments = useCallback(() => onShowAll?.(), [onShowAll]);
  const reviewFilter = useReviewFilter(review, reviewShown, shownReview);
  // The list's own state; `setPanelOpen` below is the person's (it ends a landing still waiting).
  const [panelOpen, setPanelOpenState] = useState(reviewShown !== null || listOn !== null);
  // Opened on its comments again (the card clicked again while it is open): the list opens again.
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the opening the list was last opened for, to open it during render when another comes (React's "adjusting state when a prop changes").
  const [listOpenedFor, setListOpenedFor] = useState(listOn);
  if (listOpenedFor !== listOn) {
    setListOpenedFor(listOn);
    if (listOn !== null) setPanelOpenState(true);
  }
  // Another review asked for (another row of this Artifact): the list opens on it.
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the review the panel was opened for, to open it during render when another is asked for (React's "adjusting state when a prop changes").
  const [openedFor, setOpenedFor] = useState(reviewShown);
  if (openedFor !== reviewShown) {
    setOpenedFor(reviewShown);
    if (reviewShown !== null) setPanelOpenState(true);
  }
  const [activeThread, setActiveThread] = useState<{ id: ArtifactCommentId; fromFrame: number | null } | null>(null);
  const activeThreadId = activeThread?.id ?? null;
  const threadFromFrame = activeThread?.fromFrame ?? null;
  const setActiveThreadRaft = useCallback((next: ArtifactCommentId | null) => setActiveThread(next === null ? null : { id: next, fromFrame: null }), []);
  const [hoveredThreadId, setHoveredThreadId] = useState<ArtifactCommentId | null>(null);
  const [shellUnits, setShellUnits] = useState<ArtifactCommentsState["shellUnits"]>(null);
  const [bubble, setBubble] = useState<ArtifactCommentBubble | null>(null);
  // A landed thread whose bubble waits for where its marker is: the frame's (its `anchored`) or a
  // text or csv file's (ArtifactShellComments); `listShown` once the list stands in for it (the frame failed).
  const [landingBubble, setLandingBubble] = useState<{ id: ArtifactCommentId; where: "frame" | "shell"; listShown?: boolean; tries?: number } | null>(null);
  // The person's own acts on the threads end a landing still waiting (its card would open over what
  // they chose): the list opened or closed, another thread picked (the landed one again keeps it:
  // the list focusing its card), a marker or a selection's Comment pressed (below).
  // The comment just sent that the list was opened on (`revealSent`), marked sent while it stays open.
  const [listSentId, setSentId] = useState<ArtifactCommentId | null>(null);
  const setPanelOpen = useCallback((open: boolean) => {
    setLandingBubble(null);
    setPanelOpenState(open);
    if (!open) setSentId(null);
  }, []);
  const setActiveThreadId = useCallback((next: ArtifactCommentId | null) => {
    setLandingBubble((current) => (current && current.id !== next ? null : current));
    setActiveThreadRaft(next);
  }, [setActiveThreadRaft]);
  // The framed page failed or fell back (ArtifactFrame): no `anchored` comes until it is back.
  const [frameDown, setFrameDown] = useState(false);
  const frameFailed = useCallback((failed: boolean) => setFrameDown(failed), []);
  const [pageShown, setPageShown] = useState(false);
  const pageLoaded = useCallback((loaded: boolean) => setPageShown(loaded), []);
  // A landing waiting on a frame that failed: the list on its comment meanwhile (React's "adjusting
  // state": set before the page draws), still waiting in case the frame says where after all.
  if (landingBubble?.where === "frame" && !landingBubble.listShown && frameDown) {
    setLandingBubble({ ...landingBubble, listShown: true });
    setPanelOpenState(true);
  }
  // Another version shown (the version history): a comment started on the last one, its lines
  // and the thread read in its page belong to that version; the list itself is every version's.
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the version the state below was made on, to reset it during render when it changes (React's "adjusting state when a prop changes").
  const [shownVersion, setShownVersion] = useState(data.card.version);
  if (shownVersion !== data.card.version) {
    setShownVersion(data.card.version);
    setBubble(null);
    setLandingBubble(null);
    setShellUnits(null);
    setActiveThreadRaft(null);
    setHoveredThreadId(null);
    setSentId(null);
  }
  // Landing (`landOn`): once per comment asked for, when the list has loaded (React's "adjusting
  // state when a prop changes": the thread is read from the loaded list, set before the page draws).
  // A comment the list doesn't have (posted since it loaded: a row opened again) loads the newest
  // page again once, `waiting` on the list it wasn't in, and lands in that answer.
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the comment last landed on (or given up on), so each one asked for lands once.
  const [landing, setLanding] = useState<{ asked: ArtifactCommentId; landed: boolean; waiting?: Loaded } | null>(null);
  const shownFile = useShownFile(data), shownPath = shownFile.file?.path ?? null;
  const [loads, setLoads] = useState(0);
  if (landOn !== null && current !== null && comments !== null && (landing?.asked !== landOn || (landing.waiting && landing.waiting !== current))) {
    const thread = threadOfComment(comments, landOn, olderCursor !== null);
    const reloading = thread === null && landing?.asked !== landOn;
    setLanding({ asked: landOn, landed: thread !== null, ...(reloading ? { waiting: current } : {}) });
    if (reloading) setLoads((n) => n + 1);
    if (thread !== null) {
      setActiveThreadRaft(thread);
      // Its bubble, where its marker is; with no marker (resolved, #249), or opened on its comments, the list on it.
      const root = comments.find((c) => c.id === thread);
      const anchor = root ? anchorOf(root) : null;
      const onShown = !landsInList && !root?.resolvedAt && root?.target.scope === "file" && root.target.path === shownPath;
      if (onShown && anchor?.type === "annotation" && isArtifactFramedKind(data.card.kind)) setLandingBubble({ id: thread, where: "frame" });
      else if (onShown && (anchor?.type === "lines" || anchor?.type === "csv-rows")) setLandingBubble({ id: thread, where: "shell" });
      else setPanelOpenState(true);
    }
  }
  const landedOn = landOn !== null && landing?.asked === landOn && landing.landed ? landOn : null;
  const viewer = data.viewer;

  // The newest page first (contract #10877); earlier pages on request; again on `reload` (withNewest).
  // A list on screen stays as it is when a read again fails.
  const reload = useCallback(() => setLoads((n) => n + 1), []);
  // The person's own sends, edits and deletes here, counted (their own events aren't pushed back):
  // a newest page read before one would undo it, so it is read again. A read answered after a later
  // one was applied is dropped (the first load, `reload` and new activity race).
  const writes = useRef(0);
  const reads = useRef({ issued: 0, applied: 0 });
  const readSettled = useCallback(async (): Promise<NewestAnswer | null> => {
    reads.current.issued += 1;
    const issued = reads.current.issued;
    for (;;) {
      const at = writes.current;
      const answer = await readNewest(id, reviewShown);
      if (issued < reads.current.applied) return null;
      if (writes.current === at) {
        reads.current.applied = issued;
        return answer;
      }
    }
  }, [id, reviewShown]);
  useEffect(() => {
    let cancelled = false;
    readSettled().then(
      (answer) => { if (!cancelled && answer) setLoaded((prev) => withNewest(prev, id, answer)); },
      () => {
        if (!cancelled) setLoaded((prev) => (prev?.id === id && prev.comments ? prev : { id, comments: null, olderCursor: null, failed: true, loadingEarlier: false, earlierFailed: false, shownReview: null }));
      },
    );
    return () => { cancelled = true; };
  }, [id, loads, readSettled]);
  // And on new activity on the Artifact, into what is loaded (not a first load still on its way);
  // a failure leaves it as it is.
  const refresh = useCallback(() => readSettled().then(
    (answer) => { if (answer) setLoaded((prev) => (prev?.id === id ? withNewest(prev, id, answer) : prev)); },
    () => {},
  ), [id, readSettled]);

  const loadEarlier = useCallback(() => {
    if (!olderCursor || loadingEarlier) return;
    setLoaded((value) => (value && value.id === id ? { ...value, loadingEarlier: true, earlierFailed: false } : value));
    artifactSource().getComments(id, { before: olderCursor }).then(
      (page) => setLoaded((value) => (value && value.id === id
        ? { ...value, comments: withReview(page.comments, value.comments ?? []), olderCursor: page.olderCursor, loadingEarlier: false }
        : value)),
      () => setLoaded((value) => (value && value.id === id ? { ...value, loadingEarlier: false, earlierFailed: true } : value)),
    );
  }, [id, olderCursor, loadingEarlier]);

  // The posted threads' marks in a framed page (comment mode adds the drafts' on top); in a margin
  // (#152, a Markdown file's only), no counts.
  const { margin, onReport: marginReport } = useArtifactMargin(shownFile.entry && shownPath !== null && artifactFileType(shownPath).kind === "markdown");
  const marginShown = margin.shown;
  const marks = useMemo(
    () => commentMarks(comments, null, shownPath, { parentsMayBeOlder: olderCursor !== null, margin: marginShown }),
    [comments, shownPath, olderCursor, marginShown],
  );
  const frameActivations = useRef(0);
  const openThreadFromFrame = useCallback((reported: string, rect: AnnotationRect | null, focusedFrame: HTMLIFrameElement | null = null) => {
    // The page's word: only a thread it was given a mark for (its root, loaded), else nothing.
    const root = marks.some((m) => m.id === reported) ? comments?.find((c) => c.id === reported) : undefined;
    if (!root) return false;
    frameActivations.current += 1;
    setLandingBubble(null);
    if (panelOpen || !rect) {
      // One list at a time: the open list takes it (scrolled to, not focused, armed).
      setActiveThread({ id: root.id, fromFrame: frameActivations.current });
      setPanelOpenState(true);
      return true;
    }
    setActiveThread({ id: root.id, fromFrame: null });
    const key = frameActivations.current;
    // A margin's card takes no focus. Held, a report finding the focus in the card itself carries the
    // hold on, to any thread; else a card keeps what it was opened with.
    setBubble((current) => ({
      kind: "thread", threadId: root.id, rect, key, fromFrame: true, pinned: false,
      keyboard: focusedFrame && !marginShown ? { frame: focusedFrame, at: key, held: true } : heldKeyboard(current) ?? (current?.kind === "thread" && current.threadId === root.id ? current.keyboard : null),
    }));
    return true;
  }, [marks, comments, panelOpen, marginShown]);
  const bubbleKeys = useRef(0);
  const openThreadBubble = useCallback((threadId: ArtifactCommentId, rect: AnnotationRect) => {
    bubbleKeys.current += 1;
    setLandingBubble(null);
    setActiveThread({ id: threadId, fromFrame: null });
    setBubble({ kind: "thread", threadId, rect, key: -bubbleKeys.current, fromFrame: false, pinned: true });
  }, []);
  const openThreadInList = useCallback((threadId: ArtifactCommentId) => {
    setLandingBubble(null);
    setBubble(null); // Raft's own, so the list focuses it. All of them: it may not be in a review's alone.
    setActiveThread({ id: threadId, fromFrame: null });
    setPanelOpenState(true);
    if (reviewShown !== null) onShowAll?.();
  }, [reviewShown, onShowAll]);
  const composeAt = useCallback((target: ArtifactCommentTarget, rect: AnnotationRect | null) => {
    bubbleKeys.current += 1;
    setLandingBubble(null);
    setActiveThread(null);
    setBubble({ kind: "compose", target, rect, key: -bubbleKeys.current, fromPage: null });
  }, []);
  const closeBubble = useCallback(() => {
    setBubble((current) => {
      // The passage the bubble was open for is no longer the one being read.
      if (current?.kind === "thread") setActiveThread((active) => (active?.id === current.threadId && active.fromFrame === null ? null : active));
      return null;
    });
  }, []);
  // Where the open card's mark moved to (`tracked`): the card alone reads it (useTrackedPlace).
  const [places] = useState(trackedPlaces);
  // Pressed in: the person's from now on, kept where it is (where the frame last moved it). Only a
  // press lifts a hold: the focus coming in can be a Tab the page asked for (artifactCardHold).
  const pin = useCallback((pressed: boolean) => setBubble((current) => {
    if (current?.kind !== "thread") return current;
    const keyboard = pressed && current.keyboard?.held ? { ...current.keyboard, held: false } : current.keyboard;
    if (current.pinned && keyboard === current.keyboard) return current;
    const moved = places.get();
    return { ...current, keyboard, pinned: true, rect: moved?.threadId === current.threadId && moved.key > current.key ? moved.rect : current.rect };
  }), [places]);
  const pinBubble = useCallback(() => pin(true), [pin]);
  const keepBubble = useCallback(() => pin(false), [pin]);

  const composerHasOwnText = useRef(false);
  const setComposerHasOwnText = useCallback((own: boolean) => { composerHasOwnText.current = own; }, []);
  const { reportBox, holdsOwnWords, boxEngaged, cardBoxBusy, askPageOpen } = useCommentBoxesAndPageOpens();
  const canComment = data.capabilities.comment;
  const openUnsentCard = useCallback((target: ArtifactCommentTarget, rect: AnnotationRect) => {
    const key = -(bubbleKeys.current += 1);
    setBubble((current) => current ?? { kind: "compose", target, rect, key, fromPage: null, restored: true }); // never over another card
  }, []);
  const { unsentAt, reopenUnsent, unsentForList } = useUnsentCommentOffer({
    id, kind: data.card.kind, shownPath, canComment, held: landOn !== null || reviewShown !== null, openCard: openUnsentCard, openList: setPanelOpenState,
  });
  // A place the person chose (a selection's Comment) and hasn't sent to yet: the page may not move it.
  const placeChosen = bubble?.kind === "compose" && bubble.fromPage === null;
  const pageBoxOpen = bubble?.kind === "compose" && bubble.fromPage !== null; // its next open moves it: no close by the person
  const cardHeld = heldKeyboard(bubble) !== null;
  const openFromPage = useCallback((request: PageCommentRequest, frameRect: AnnotationRect | null = null) => {
    // Never over the person's words, and never moving a place they chose (Porthole 0.13: answer false).
    if (!canComment || !shownPath || composerHasOwnText.current || placeChosen || cardHeld) return false;
    if (!askPageOpen(pageBoxOpen)) return false;
    const target: ArtifactCommentTarget = { scope: "file", path: shownPath, anchor: { type: "page", data: request.anchor } };
    frameActivations.current += 1;
    // Beside the frame's top (Porthole: beside the frame rather than over the page's place).
    const rect = frameRect ? { x: frameRect.x + frameRect.width / 2, y: frameRect.y, width: 0, height: 0 } : null;
    setActiveThread(null);
    setBubble({ kind: "compose", target, rect, key: frameActivations.current, fromPage: { draft: request.draft } });
    return true;
  }, [canComment, shownPath, placeChosen, cardHeld, pageBoxOpen, askPageOpen]);
  const added = useCallback((comment: ArtifactComment) => {
    writes.current += 1;
    // A refresh sent after the comment was saved may have brought it already: once. A reply reopens its thread (#249).
    setComments((list) => (list?.some((c) => c.id === comment.id) ? list : [...reopenedBy(list ?? [], comment), comment]));
  }, [setComments]);
  // What is open now, for a send answered later: the box that sent may have rendered before a
  // marker was pressed meanwhile, or be gone with its card.
  const open = useRef({ bubble, panelOpen });
  open.current = { bubble, panelOpen };
  const revealSent = useCallback((comment: ArtifactComment, from: SentFrom | null = null) => {
    added(comment);
    // Its thread, as the list builds them: itself, or for a reply its root's.
    const thread = comment.replyTo ? threadOfComment([...(comments ?? []), comment], comment.id, olderCursor !== null) ?? comment.id : comment.id;
    setLandingBubble(null);
    setActiveThread({ id: thread, fromFrame: null });
    // At a place a marker shows, its card where the card it was written in was: only in place of
    // that card (or none), never over another (a marker's thread pressed while it was sent) or the
    // open list, which takes it as it takes a marker's press.
    const now = open.current;
    const place = anchorOf(comment)?.type;
    const inPlace = now.bubble === null || (now.bubble.kind === "compose" && now.bubble.key === from?.bubbleKey);
    if (from?.rect && place && place !== "page" && inPlace && !now.panelOpen) {
      bubbleKeys.current += 1;
      setSentId(null);
      setBubble({ kind: "thread", threadId: thread, rect: from.rect, key: -bubbleKeys.current, fromFrame: false, pinned: true, sent: comment.id });
      return;
    }
    if (from?.bubbleKey != null) setBubble((current) => (current?.kind === "compose" && current.key === from.bubbleKey ? null : current));
    setSentId(comment.id);
    setPanelOpenState(true);
  }, [added, comments, olderCursor]);
  const replaced = useCallback((comment: ArtifactComment) => {
    writes.current += 1;
    setComments((list) => (list ?? []).map((c) => (c.id === comment.id ? comment : c)));
  }, [setComments]);
  // A deleted comment with replies stays as a placeholder for them; without, it's gone (as the server keeps it).
  const removeComment = useCallback((commentId: ArtifactCommentId) => setComments((list) => {
    const all = list ?? [];
    if (!all.some((c) => c.replyTo === commentId)) return all.filter((c) => c.id !== commentId);
    const now = new Date(currentTimeMs()).toISOString();
    return all.map((c) => (c.id === commentId ? { ...c, body: [], deletedAt: c.deletedAt ?? now } : c));
  }), [setComments]);
  const removed = useCallback((commentId: ArtifactCommentId) => {
    writes.current += 1;
    // A thread's card goes with its thread (its root deleted with no replies left under it).
    if (!comments?.some((c) => c.replyTo === commentId)) setBubble((current) => (current?.kind === "thread" && current.threadId === commentId ? null : current));
    removeComment(commentId);
  }, [comments, removeComment]);

  // The comments on screen, for reading the Activity row: the open list's (a review's alone while it
  // shows one), else the open card's thread.
  const shown = useMemo(() => {
    if (!comments) return new Set<ArtifactCommentId>();
    if (panelOpen) return new Set((reviewShown ? (shownReview?.status === "ok" ? comments.filter((c) => shownReview.commentIds.has(c.id)) : []) : comments).map((c) => c.id));
    const thread = bubble?.kind === "thread" ? buildThreads(comments, { parentsMayBeOlder: olderCursor !== null }).find((t) => t.id === bubble.threadId) : undefined;
    return new Set(thread ? [...(thread.root ? [thread.root.id] : []), ...thread.replies.map((c) => c.id)] : []);
  }, [comments, panelOpen, reviewShown, shownReview, bubble, olderCursor]);
  useArtifactActivityRefresh(data.card, refresh, shown);

  // A landing asks again for its mark to be brought into view (`refocus`): the same mark, a new key.
  const [focusKey, setFocusKey] = useState(0);
  const focusedId = activeThreadId && marks.some((m) => m.id === activeThreadId) ? activeThreadId : null;
  const focusedMark = useMemo(() => (focusedId && focusKey > 0 ? { id: focusedId, key: focusKey } : focusedId), [focusedId, focusKey]);
  // A landing's bubble, once its mark's place is known (null: no mark found, the list instead,
  // unless the list already stood in for it). Not a person's press on it, so it takes no focus, as
  // a frame-opened one. Only while the person is still on that thread, and never over a list they
  // opened; late, after the list stood in for it (a failed frame back), that list closes (one at a
  // time, as a marker's press while the list is open).
  const landBubble = useCallback((rect: AnnotationRect | null) => {
    if (!landingBubble) return;
    setLandingBubble(null);
    if (!rect) {
      if (!landingBubble.listShown) setPanelOpenState(true);
      return;
    }
    if (activeThreadId !== null && activeThreadId !== landingBubble.id) return;
    if (panelOpen) {
      if (!landingBubble.listShown) return;
      setPanelOpenState(false);
    }
    frameActivations.current += 1;
    const key = frameActivations.current;
    setBubble((current) => ({ kind: "thread", threadId: landingBubble.id, rect, key, fromFrame: true, pinned: false, keyboard: heldKeyboard(current) }));
  }, [landingBubble, activeThreadId, panelOpen]);
  const bubbleThread = bubble?.kind === "thread" && !bubble.pinned ? bubble.threadId : null;
  const bubbleRect = bubble?.kind === "thread" ? bubble.rect : null;
  // The frame follows the open card's mark (`trackedAnnotation`) while the person hasn't pressed in
  // it; only a mark the frame shows (Porthole refuses another id). A new card, or none, starts over.
  // In the margin the frame follows the margin's reference mark instead (ArtifactFrame reads it).
  const trackedMark = !marginShown && bubbleThread !== null && marks.some((m) => m.id === bubbleThread) ? bubbleThread : null;
  const bubbleKey = bubble?.kind === "thread" ? bubble.key : null;
  // The followed mark's box when the open card opened (`base`, for the card of `key`) and as last
  // reported (`last`): the card moves by the difference, from where it opened.
  const following = useRef<{ key: number; base: AnnotationRect; last: AnnotationRect } | null>(null);
  useEffect(() => () => {
    places.set(null);
    following.current = null;
  }, [places, trackedMark]);
  const onAnnotation = useCallback((report: AnnotationReport, frameBox: FrameBox | null, shownMarks: readonly { id: string }[] = marks) => {
    if (report.type === "activated") {
      openThreadFromFrame(report.id, inClient(report.rect, frameBox));
      return;
    }
    if (marginReport(report, frameBox, shownMarks)) return;
    if (report.type === "tracked") {
      // The followed mark moved (the page's word, a hint; clamped to the frame). Its box is the
      // whole mark's (a passage), not the marker the card opened beside: the card stays beside
      // where it opened and moves as the mark does, within the frame, armed again. The first box
      // after it opened (the frame reports one at once when asked to follow) is where the mark was
      // then; a card opened again on the mark already followed starts from its last box.
      if (report.id !== trackedMark || bubbleThread === null || !bubbleRect || bubbleKey === null) return;
      const mark = inClient(report.rect, frameBox);
      const was = following.current;
      if (was === null || was.key !== bubbleKey) {
        following.current = { key: bubbleKey, base: was?.last ?? mark, last: mark };
        if (was === null) return;
      } else {
        following.current = { ...was, last: mark };
      }
      const rect = followedPlace(bubbleRect, following.current.base, mark, frameBox);
      // Only a real move: the same place again changes nothing.
      const placed = places.get();
      const last = placed && placed.key > bubbleKey ? placed.rect : bubbleRect;
      if (sameRect(last, rect)) return;
      frameActivations.current += 1;
      places.set({ threadId: bubbleThread, rect, key: frameActivations.current });
      return;
    }
    if (report.type !== "anchored") return;
    // Where the marks are now (the page's word, a hint): a landing's bubble opens at its mark; an
    // open bubble the person hasn't pressed in goes when its passage is gone (it moves by `tracked`),
    // unless its box holds their words or focus (#proj-workspace:#144: they would go with it).
    if (landingBubble?.where === "frame") {
      // Opened once the frame has brought its mark into view (artifactLandingPlace), not where it was before, nor at an edge (the list).
      const result = report.results.find((r) => r.id === landingBubble.id);
      const step = result ? landingStep(result, frameBox?.height ?? Number.POSITIVE_INFINITY, landingBubble.tries ?? 0) : null;
      if (step === "refocus") {
        setLandingBubble({ ...landingBubble, tries: (landingBubble.tries ?? 0) + 1 });
        setFocusKey((key) => key + 1);
      } else if (step) landBubble(step === "land" && result?.rect ? inClient(result.rect, frameBox) : null);
    }
    if (bubbleThread) {
      const result = report.results.find((r) => r.id === bubbleThread);
      if (result && (result.state !== "attached" || !result.rect) && !cardBoxBusy && !cardHeld) closeBubble();
    }
  }, [openThreadFromFrame, trackedMark, bubbleKey, places, landingBubble, landBubble, bubbleThread, bubbleRect, closeBubble, cardBoxBusy, cardHeld, marginReport, marks]);
  // A frame that never says where, however slow (a failed one shows the list at once, above): the
  // landed comment in the list instead, once LANDING_FRAME_CAP_MS is up.
  const waitsForFrame = landingBubble?.where === "frame";
  const landBubbleRef = useRef(landBubble);
  landBubbleRef.current = landBubble;
  useEffect(() => {
    if (!waitsForFrame) return;
    const timer = window.setTimeout(() => landBubbleRef.current(null), LANDING_FRAME_CAP_MS);
    return () => window.clearTimeout(timer);
  }, [waitsForFrame]);
  // Without comment mode the person points at nothing in the page: only the markers are live.
  const frameHandle = useRef<PortholeFrameHandle | null>(null);
  const frameBox = useRef<HTMLDivElement | null>(null);
  const focusMark = useCallback((markId: ArtifactCommentId) => {
    if (!frameHandle.current) return false;
    frameHandle.current.focusMark(markId);
    return true;
  }, []);
  const frame = useMemo<ArtifactFrameLayer>(() => ({ marks, focusedMark, trackedMark, trackedSelection: false, annotating: () => null, onAnnotation, handle: frameHandle, box: frameBox }), [marks, focusedMark, trackedMark, onAnnotation]);
  const shellLanding = landingBubble?.where === "shell" ? landingBubble.id : null;
  const sentId = listSentId ?? (bubble?.kind === "thread" ? bubble.sent ?? null : null);

  const value = useMemo<ArtifactCommentsState>(() => ({
    data,
    shownPath,
    viewer,
    comments,
    failed,
    hasEarlier: olderCursor !== null,
    loadingEarlier,
    earlierFailed,
    loadEarlier,
    reload,
    reviewShown,
    shownReview,
    showAllComments,
    reviewFilter,
    panelOpen,
    setPanelOpen,
    landedOn,
    activeThreadId,
    setActiveThreadId,
    threadFromFrame,
    openThreadFromFrame,
    hoveredThreadId,
    setHoveredThreadId,
    bubble,
    openThreadBubble,
    openThreadInList,
    composeAt,
    closeBubble,
    pinBubble,
    keepBubble,
    cardHeld,
    focusMark,
    shellLanding,
    landBubble,
    frameFailed,
    pageShown,
    pageLoaded,
    openFromPage,
    askPageOpen,
    setComposerHasOwnText,
    holdsOwnWords,
    boxEngaged,
    reportBox,
    unsentAt,
    reopenUnsent,
    unsentForList,
    frame,
    trackedPlaces: places,
    margin,
    shellUnits,
    setShellUnits,
    added,
    revealSent,
    sentId,
    replaced,
    removed,
  }), [data, shownPath, viewer, comments, failed, olderCursor, loadingEarlier, earlierFailed, loadEarlier, reload, reviewShown, shownReview, showAllComments, reviewFilter, panelOpen, setPanelOpen, landedOn, activeThreadId, setActiveThreadId, threadFromFrame, openThreadFromFrame, hoveredThreadId, bubble, openThreadBubble, openThreadInList, composeAt, closeBubble, pinBubble, keepBubble, cardHeld, focusMark, shellLanding, landBubble, frameFailed, pageShown, pageLoaded, openFromPage, askPageOpen, setComposerHasOwnText, frame, places, margin, shellUnits, added, revealSent, sentId, replaced, removed, holdsOwnWords, boxEngaged, reportBox, unsentAt, reopenUnsent, unsentForList]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
