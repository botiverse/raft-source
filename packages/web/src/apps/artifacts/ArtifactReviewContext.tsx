import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { ReactNode } from "react";
import { isArtifactFramedKind } from "@botiverse/raft-shared";
import type { ArtifactAnnotationAnchor, ArtifactCommentAnchor, ArtifactCommentDraft, ArtifactCommentId, ArtifactCommentDraftId, ArtifactCommentPart, ArtifactReviewRejected, ArtifactReviewSubmitted, ObjectFileId } from "@botiverse/raft-shared";
import type { AnnotateMode, AnnotationAnchor, AnnotationRect, AnnotationReport } from "@botiverse/porthole";
import type { PortholeFrameHandle } from "@botiverse/porthole/react";

import { commentMarks } from "./artifactCommentMarks";
import { inClient, useArtifactComments } from "./ArtifactCommentsContext";
import { pageEscaped } from "./artifactPageSignals";
import { isModalLayerOpen } from "../../features/shortcuts";
import type { PageCommentRequest } from "./artifactPageComments";
import type { ArtifactCommentTarget, ArtifactFrameLayer, FrameBox } from "./ArtifactCommentsContext";
import { placeStore, selectionPlace } from "./artifactTrackedPlaces";
import type { PlaceStore, SelectionFollow } from "./artifactTrackedPlaces";
import { artifactErrorCode } from "./artifactApi";
import { showToast } from "../../components/toastBridge";
import { draftInputBody, newReviewClientKey } from "./artifactReviewDrafts";
import { artifactSource } from "./artifactSource";
import { useWorkspaceArtifactsEnabled } from "./useWorkspaceArtifactsEnabled";
import { useDraftHistory } from "./artifactDraftHistory";
import type { DraftHistory, DraftHistoryStep, DraftWrites } from "./artifactDraftHistory";
import { useMediaQuery } from "../../hooks/effectPrimitives";

/** A touch screen: in comment mode an HTML page's blocks are held to comment on them, never tapped (P112's `"hold"`). */
export const TOUCH_QUERY = "(pointer: coarse)";

/**
 * Comment mode (#proj-workspace:#148, xxchan's final mockup): three states and no others. In A and
 * B alike a text selection offers one Comment button at its end, which turns into the comment box
 * there; the box sends now (notifying) or saves a draft (only the writer sees it), and drafts wait
 * until they are sent together.
 * - `browsing` (A): the page is live. Selecting text in a Markdown, PDF or HTML page offers
 *   Comment. An HTML page's clicks stay its own (Porthole's text-only mode takes no pointer event;
 *   only a block pick does), on touch too (a coarse pointer: the platform's long press selects the
 *   text, and every tap stays the page's). A block without text (an image, a chart) is commented
 *   on from B.
 * - `commenting` (B): on an HTML page, Pick Element: the page's clicks pause and a picked block
 *   (on touch a block held 500 ms, Porthole 0.14 `elements: "hold"`, co-design P3, or selected
 *   text, the page's taps staying its own) or the page's own button (`comments.open`) opens the
 *   box at once. Elsewhere B is A with the bar shown (selected text, as in A).
 * - `reviewing` (C): the drafts, to edit, delete, sum up and submit. The page doesn't respond.
 *
 * Leaving `commenting` (Esc, the Comment button again, Pick Element again, another Artifact: this
 * provider is per Artifact) keeps the drafts. The drafts are the server's (S8): loaded when the
 * viewer opens, each write one route. Sending them (the bar's Send N, or C's) posts them all;
 * Discard All (confirmed) deletes them all; deleting the last draft ends the batch, and each of
 * those leaves comment mode. A send that posts nothing opens (or stays in) `reviewing` with its
 * `problem`: a refused draft named with its code, or the drafts changed
 * meanwhile (loaded again, to check and send again).
 */
export type ArtifactReviewStatus = "browsing" | "commenting" | "reviewing";

/**
 * Why the last submit posted nothing, shown in C until the next one (or until the marked draft is
 * edited): the server refused a draft (`rejection.draftId`; null, none in particular) with a
 * comment's code and its typed `details` (ArtifactReviewRejected: the panel switches on the code); the drafts changed while it was checked (another tab, an expiry), loaded again;
 * or the review itself was refused for good (`refused`: can't see it, the version gone, no
 * permission, anything else it won't take).
 */
export type ArtifactReviewProblem =
  | { kind: "rejected"; rejection: ArtifactReviewRejected }
  | { kind: "draftsChanged" }
  | { kind: "refused"; code: "NOT_VISIBLE" | "VERSION_NOT_FOUND" | "FORBIDDEN" | "other" };

/**
 * A draft's marker clicked in the page (Porthole `activated`, the page's word), or one Raft draws
 * beside a text or csv file's lines or rows (`openDraftView`): the draft alone, beside the marker
 * (`rect`, client px), to read or edit. Never C: a view the page's report opens has nothing one
 * click away that submits or deletes (THREAT_MODEL §6, P107). `key`: this opening; `fromPage`: the
 * page's word (armed, no focus), else Raft's own press.
 */
export interface ArtifactDraftView {
  draftId: ArtifactCommentDraftId;
  rect: AnnotationRect;
  key: number;
  fromPage: boolean;
}

/**
 * What the person pointed at in the page (an annotation anchor), or where the page's own button
 * asked to comment (a page anchor, `fromPage` with its suggested text), and where it is on screen
 * (client px; null: beside the frame's top). The page's word: a hint. `writing`: the comment box is
 * open there (a selection's Comment pressed, or a block picked, or the page's button in B); else
 * the selection's Comment button.
 */
export interface ArtifactReviewSelection {
  place: Extract<ArtifactCommentAnchor, { type: "annotation" | "page" }>;
  rect: AnnotationRect | null;
  key: number;
  writing?: boolean;
  fromPage?: { draft: string | null };
}

interface ArtifactReviewState {
  status: ArtifactReviewStatus;
  /** The person's drafts of this Artifact, oldest first; null until they load. */
  drafts: ArtifactCommentDraft[] | null;
  draftCount: number;
  /** The drafts couldn't be loaded: offered again by `reloadDrafts` (Retry). */
  draftsFailed: boolean;
  reloadDrafts: () => void;
  /** Comment mode is offered: a framed version the person may comment on. */
  canComment: boolean;
  /**
   * Drafts are offered: the person may comment on this Artifact (any kind: a text or csv file's
   * comment cards save drafts too, #148), so their drafts are read and the bar shows them.
   */
  draftsOffered: boolean;
  enterCommenting: () => void;
  /** Out of comment mode (B or C to A), drafts kept. */
  done: () => void;
  /** Out of C, back to the mode it was opened from (A or B). C opens only on a send refused. */
  leaveReview: () => void;
  /** The draft C brings into view, with the key of that opening. */
  reviewFocus: { draftId: ArtifactCommentDraftId | null; key: number };
  /** The draft a marker in the page opened on its own (ArtifactDraftView); null: none. */
  draftView: ArtifactDraftView | null;
  /** A draft's marker beside a text or csv file pressed (Raft's own): its view beside it (`rect`, client px). Not in C. */
  openDraftView: (draftId: ArtifactCommentDraftId, rect: AnnotationRect) => void;
  closeDraftView: () => void;
  /** The open selection: its Comment button, or the comment box at it. */
  selection: ArtifactReviewSelection | null;
  clearSelection: () => void;
  /** A selection's Comment: the button becomes the comment box there. */
  commentNow: () => void;
  /** The box sent or saved its comment (its `onDone`): the box goes, and so does the page's selection it was for. */
  commentSent: () => void;
  /**
   * The page's own button (Porthole `comments.open`, checked): in A the comments' new-comment card;
   * in B the comment box at the page's place; in C nothing. Never over the person's words
   * or a place they chose, at most one a second.
   */
  openFromPage: (request: PageCommentRequest, frameRect?: AnnotationRect | null) => boolean;
  /** The box says whether it holds the person's words (a new selection then leaves it be). */
  setComposerHasOwnText: (own: boolean) => void;
  /** `images`: the box's uploads (#proj-workspace:#146), ids in order; a draft with images isn't recorded for undo. */
  addDraft: (body: ArtifactCommentPart[], images?: ObjectFileId[]) => Promise<void>;
  /** Save Draft at a place the box knows itself (a text or csv file's card, the list's whole-Artifact box). */
  addDraftAt: (target: ArtifactCommentTarget, body: ArtifactCommentPart[], images?: ObjectFileId[]) => Promise<void>;
  /**
   * Save Draft in a reply box (the thread's card or the list): a draft that replies to `replyTo`, posted as a reply
   * to its thread when the review is submitted (xxchan, #proj-workspace:f07141a9). It has no place
   * of its own (the thread's is its), so it needs no selection and leaves the one open as it is.
   */
  addReplyDraft: (replyTo: ArtifactCommentId, body: ArtifactCommentPart[], images?: ObjectFileId[]) => Promise<void>;
  updateDraft: (draftId: ArtifactCommentDraftId, body: ArtifactCommentPart[]) => Promise<void>;
  /** The deletion's undo step (null: not recorded, a draft with images), for its toast's Undo. */
  removeDraft: (draftId: ArtifactCommentDraftId) => Promise<DraftHistoryStep | null>;
  discardAll: () => Promise<void>;
  /**
   * Send the drafts (Send N, the bar's or C's: one review, no summary), with this review's `clientKey` (made at its first attempt, sent again on a retry while
   * the drafts are unchanged; any draft write makes the next submit a new attempt). Posted: back in
   * A, the toast counts what was posted, focus on the Comment button. Refused (a draft, the drafts
   * changed, the review for good): C, opened if it wasn't, with `problem`. NO_DRAFTS (none live) and
   * CLIENT_KEY_REUSED (this key's review was posted): back in A, everything read again, a toast.
   * Offline, a 5xx, 408 or 429: a toast to try again, the key kept. One at a time (`submitting`).
   */
  submit: () => Promise<void>;
  /** A submit is out: draft writes wait (their controls are off). */
  submitting: boolean;
  problem: ArtifactReviewProblem | null;
  /** Undo and redo of the person's draft changes here (artifactDraftHistory). */
  history: Pick<DraftHistory, "canUndo" | "canRedo" | "busy" | "undo" | "redo" | "undoStep" | "watch">;
  /** Bumped when focus should go back to the Comment button (a review posted). */
  toggleFocus: number;
  /**
   * Esc in the viewer that no card took (the cards, a draft's view and the box at a selection
   * among them, are the dismissal layer's, artifactDismissLayer, and are never closed from here):
   * the selection's Comment button goes, else it leaves B (to A) or C (to where it was opened
   * from). Whether it took it.
   */
  handleEscape: () => boolean;
  /**
   * Where the open composer's selection is now, as the frame follows it (Porthole P138
   * `selectionTracked`, while `frame.trackedSelection`); read by the composer alone (SelectionBox),
   * so a scroll re-renders nothing else.
   */
  selectionPlaces: PlaceStore<SelectionFollow>;
  /** For the frame: the comments' layer, with drafts' marks, selections, and the frame's handle. */
  frame: ArtifactFrameLayer;
}

const Context = createContext<ArtifactReviewState | null>(null);

/** Comment mode of the Artifact open in the viewer; null where it is off (the flags) or there is no viewer. */
export function useArtifactReview(): ArtifactReviewState | null {
  return useContext(Context);
}

/** A reported anchor as Raft stores it (the same fields, copied). */
function storedAnchor(anchor: AnnotationReport & { type: "selected" }): ArtifactAnnotationAnchor {
  return {
    kind: anchor.anchor.kind,
    label: anchor.anchor.label,
    selectors: anchor.anchor.selectors.map((s) => ({ ...s })),
  };
}

/**
 * A text selection the page reported, as one key (its selectors); null for a picked block (each
 * pick is the person's own click, never a report repeated).
 */
function textSelectionKey(anchor: AnnotationAnchor): string | null {
  return anchor.kind === "text" ? JSON.stringify(anchor.selectors) : null;
}

export function ArtifactReviewProvider({ children }: { children: ReactNode }) {
  const enabled = useWorkspaceArtifactsEnabled();
  const comments = useArtifactComments();
  if (!comments) return <>{children}</>;
  // The same provider with the flag off as on, so the flag turning on never remounts what is under
  // it: the canonical link's page enters its server, whose flags answer after the frame has
  // mounted on `open`'s ticket, and a remount would ask the frame route for another (#107).
  return <ReviewProvider key={comments.data.card.id} enabled={enabled}>{children}</ReviewProvider>;
}

/** The mode and the drafts, changed together so a transition reads the drafts it follows. */
interface ReviewData {
  status: ArtifactReviewStatus;
  /** The mode C was opened from, which leaving it goes back to. */
  reviewFrom: Exclude<ArtifactReviewStatus, "reviewing">;
  /** Null until they load (and while a failed load waits for Retry). */
  drafts: ArtifactCommentDraft[] | null;
  draftsFailed: boolean;
}

type ReviewAction =
  | { type: "status"; status: Exclude<ArtifactReviewStatus, "reviewing"> }
  /** To C (from A or B, remembered), or out of it, back there. */
  | { type: "review" }
  | { type: "leaveReview" }
  | { type: "draftsLoaded"; drafts: ArtifactCommentDraft[] }
  | { type: "draftsFailed" }
  | { type: "draftAdded"; draft: ArtifactCommentDraft }
  | { type: "draftUpdated"; draft: ArtifactCommentDraft }
  /** Gone; the last one out of C leaves C (comment mode is the person's: an undo may bring one back). */
  | { type: "draftRemoved"; draftId: ArtifactCommentDraftId }
  /** None left (discarded, sent, none on the server): back in A. */
  | { type: "emptied" };

function reviewReducer(state: ReviewData, action: ReviewAction): ReviewData {
  switch (action.type) {
    case "status":
      return { ...state, status: action.status };
    case "review":
      return state.status === "reviewing" ? state : { ...state, status: "reviewing", reviewFrom: state.status };
    case "leaveReview":
      return state.status === "reviewing" ? { ...state, status: state.reviewFrom } : state;
    case "draftsLoaded":
      return { ...state, drafts: action.drafts, draftsFailed: false };
    case "draftsFailed":
      return { ...state, draftsFailed: true };
    case "draftAdded":
      return { ...state, drafts: [...(state.drafts ?? []), action.draft] };
    case "draftUpdated":
      return { ...state, drafts: (state.drafts ?? []).map((d) => (d.id === action.draft.id ? action.draft : d)) };
    case "draftRemoved": {
      const left = (state.drafts ?? []).filter((d) => d.id !== action.draftId);
      return left.length === 0 && state.status === "reviewing" ? { ...state, drafts: left, status: state.reviewFrom } : { ...state, drafts: left };
    }
    case "emptied":
      return { ...state, drafts: [], status: "browsing" };
  }
}


/** Whether a failure says nothing about the attempt (offline, a 5xx, 408, 429): the retry sends the same key. */
function isTransient(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status !== "number" || status >= 500 || status === 408 || status === 429;
}

/** `enabled` false (the flag off, or still loading): no comment mode, nothing loaded, null for everyone below. */
function ReviewProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { formatMessage } = useIntl();
  const comments = useArtifactComments()!;
  const { data, shownPath } = comments;
  const id = data.card.id;
  const version = data.card.version;
  const draftsOffered = enabled && data.capabilities.comment && shownPath !== null;
  const canComment = draftsOffered && isArtifactFramedKind(data.card.kind);
  const [{ status, drafts, draftsFailed }, dispatch] = useReducer(reviewReducer, { status: "browsing", reviewFrom: "browsing", drafts: null, draftsFailed: false });
  const setStatus = useCallback((next: Exclude<ArtifactReviewStatus, "reviewing">) => dispatch({ type: "status", status: next }), []);
  const [selection, setSelection] = useState<ArtifactReviewSelection | null>(null);
  const [problem, setProblem] = useState<ArtifactReviewProblem | null>(null);
  // This review's submit key: made at its first attempt and sent again on a retry, as long as
  // nothing in the drafts changed in between (any write drops it, so a replay can't stand in for
  // drafts the server never saw), and dropped once the server has answered for it.
  const clientKey = useRef<string | null>(null);
  // One submit at a time, whatever view started it (the panel, the sheet); the writes wait it out.
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [toggleFocus, setToggleFocus] = useState(0);
  const [reviewFocus, setReviewFocus] = useState<ArtifactReviewState["reviewFocus"]>({ draftId: null, key: 0 });
  const [draftView, setDraftView] = useState<ArtifactDraftView | null>(null);
  const closeDraftView = useCallback(() => setDraftView(null), []);
  const selectionKey = useRef(0);
  // Whether B's box (or A's Comment box) holds the person's own words: a pick or a selection then
  // leaves it be, and B stops asking the page for a pick while it does (`annotating`).
  const [composerHasOwnText, setComposerHasOwnText] = useState(false);
  // Porthole ends a pick with its report (a picked block, Esc in the page), and the frame asks the
  // page again only for a change of what it asks: so the ask goes once a pick ends (`pickPaused`)
  // and comes back a moment later, after the frame has let it go, and the page picks anew.
  const [pickEnds, setPickEnds] = useState(0);
  const [pickAskedAgain, setPickAskedAgain] = useState(0);
  useEffect(() => {
    if (pickEnds === 0) return;
    // A timer, so the frame has been told the ask went (its effect, this commit) before it comes back.
    const timer = window.setTimeout(() => setPickAskedAgain(pickEnds), 0);
    return () => window.clearTimeout(timer);
  }, [pickEnds]);
  const pickPaused = pickAskedAgain !== pickEnds;
  const pickEnded = useCallback(() => setPickEnds((n) => n + 1), []);
  // The page's text selection outlives what Raft opened for it. Once the composer at it closes (a
  // draft added, a comment sent, Esc, ×, Tab out, a press elsewhere in Raft, its place gone:
  // #proj-workspace:#229, every close alike, so the page learns nothing of what came of it) Raft
  // takes it away in the page (`takeSelection`: Porthole's `clearSelection`, P115, through the
  // frame's handle, P118), and the follow ends with the composer (`trackedSelection`). A press in
  // the page that closes it takes nothing, whatever came of it: that press already ended the
  // selection, and a clear arriving under it would undo the selection the person is starting there.
  // Otherwise (the options closed unused, the mode changed) it stays the person's, and the page reports
  // it again whenever it is asked to point once more (Porthole's annotate.start re-reports the
  // selection it holds: C → B, C → A) or the selection's box moved after a scroll.
  // `heardSelection`: the one the page holds now, as far as Raft heard (null once it reports it
  // cleared, or Raft took it, which the page doesn't report); `spentSelection`: the one already
  // done with, ignored when reported again until the page reports another selection or its clearing.
  const heardSelection = useRef<string | null>(null);
  const spentSelection = useRef<string | null>(null);
  const frameHandle = useRef<PortholeFrameHandle | null>(null);
  const [selectionPlaces] = useState(() => placeStore<SelectionFollow>());
  const takeSelection = useCallback(() => {
    heardSelection.current = null;
    spentSelection.current = null;
    frameHandle.current?.clearSelection();
  }, []);

  // The person's drafts, as the server keeps them (they outlive this viewer, the tab and the device):
  // loaded when the viewer opens where comment mode is offered, and again (`draftsLoad`) on Retry and
  // when the server says they changed.
  const [draftsLoad, setDraftsLoad] = useState(0);
  const reloadDrafts = useCallback(() => setDraftsLoad((n) => n + 1), []);
  useEffect(() => {
    if (!draftsOffered) return;
    let cancelled = false;
    artifactSource().reviewDrafts(id).then(
      (answer) => { if (!cancelled) dispatch({ type: "draftsLoaded", drafts: answer.drafts }); },
      () => { if (!cancelled) dispatch({ type: "draftsFailed" }); },
    );
    return () => { cancelled = true; };
  }, [id, draftsOffered, draftsLoad]);
  const draftCount = drafts?.length ?? 0;

  // What was open for the page's selection gone (the draft added, the comment posted, the box or
  // the options closed, a draft's view opened), or the mode changed with nothing open for it: that
  // selection is spent, so a change of mode never reopens a prompt for one made before it. A
  // layout effect, so it is spent before the frame is told the new mode and answers with it again.
  const selectionOpen = selection !== null;
  useLayoutEffect(() => {
    if (!selectionOpen) spentSelection.current = heardSelection.current;
  }, [status, selectionOpen]);

  // Any change of state closes the comments' card (a thread's, or a new comment's the page opened
  // in A): it belongs to the state it was opened in.
  const closeCommentsCard = comments.closeBubble;
  const enterCommenting = useCallback(() => {
    setSelection(null);
    setDraftView(null);
    closeCommentsCard();
    setStatus("commenting");
  }, [setStatus, closeCommentsCard]);
  const done = useCallback(() => {
    setSelection(null);
    setDraftView(null);
    setStatus("browsing");
  }, [setStatus]);
  const setListOpen = comments.setPanelOpen;
  // C, only for a send refused (co-design S6: never a frame's report).
  const openReview = useCallback(() => {
    setSelection(null);
    setDraftView(null);
    // C takes the list's place (the list, opened over it later, covers it until closed).
    setListOpen(false);
    closeCommentsCard();
    setReviewFocus((current) => ({ draftId: null, key: current.key + 1 }));
    dispatch({ type: "review" });
  }, [setListOpen, closeCommentsCard]);
  const leaveReview = useCallback(() => dispatch({ type: "leaveReview" }), []);
  const clearSelection = useCallback(() => {
    setComposerHasOwnText(false);
    setSelection(null);
  }, []);

  const targetOf = useCallback((place: ArtifactReviewSelection["place"]): ArtifactCommentTarget => (
    { scope: "file", path: shownPath!, anchor: place }
  ), [shownPath]);
  const commentNow = useCallback(() => {
    setComposerHasOwnText(false);
    setSelection((current) => (current ? { ...current, writing: true } : current));
  }, []);
  const commentSent = useCallback(() => {
    takeSelection();
    clearSelection();
  }, [takeSelection, clearSelection]);
  const commentsOpenFromPage = comments.openFromPage;
  const askPageOpen = comments.askPageOpen;
  const cardHeld = comments.cardHeld;
  const openFromPage = useCallback((request: PageCommentRequest, frameRect: AnnotationRect | null = null) => {
    // Nothing the page opens while a card is held (artifactCardHold).
    if (cardHeld) return false;
    // A: never over A's Comment box (a place the person chose, written in or not).
    if (status === "browsing") return !selection?.writing && commentsOpenFromPage(request, frameRect);
    // C: the page doesn't respond. B: the box at the page's place, never over the box the person
    // has open (a selection's Comment button gives way, as in A).
    if (status === "reviewing" || !canComment || selection?.writing || draftView) return false;
    // One count for A's box and B's (artifactPageOpenGate): what it last opened here is gone by now.
    if (!askPageOpen(false)) return false;
    selectionKey.current += 1;
    setComposerHasOwnText(false);
    setSelection({
      place: { type: "page", data: request.anchor },
      rect: frameRect ? { x: frameRect.x + frameRect.width / 2, y: frameRect.y, width: 0, height: 0 } : null,
      key: selectionKey.current,
      writing: true,
      fromPage: { draft: request.draft },
    });
    return true;
  }, [status, commentsOpenFromPage, askPageOpen, canComment, selection, draftView, cardHeld]);

  /** Every draft write: none while a submit is out, and the next submit is a new attempt. */
  const beginWrite = useCallback(() => {
    if (submittingRef.current) throw new Error("a review is being submitted");
    clientKey.current = null;
  }, []);
  // A refusal about one draft is over once that draft changes or goes: the next submit checks it again.
  const clearProblemOf = useCallback((draftId: ArtifactCommentDraftId | null) => {
    setProblem((current) => (current?.kind === "rejected" && current.rejection.draftId === draftId ? null : current));
  }, []);
  // The drafts' writes, each one route, the drafts here kept as the server answered. Recorded for
  // undo by the person's own changes below; the history replays them unrecorded.
  const writeCreate = useCallback<DraftWrites["create"]>(async ({ version: on, target, replyTo, body, images }) => {
    beginWrite();
    try {
      const { draft } = await artifactSource().createReviewDraft(id, { version: on, target, body: draftInputBody(body), ...(replyTo ? { replyTo } : {}), ...(images?.length ? { images } : {}) });
      dispatch({ type: "draftAdded", draft });
      // A list that didn't load misses the others: read it now.
      if (draftsFailed) reloadDrafts();
      return draft;
    } catch (error) {
      // At the cap the count here was behind the server's (another tab): the list as it is.
      if (artifactErrorCode(error) === "DRAFT_LIMIT") reloadDrafts();
      throw error;
    }
  }, [id, beginWrite, draftsFailed, reloadDrafts]);
  const writeEdit = useCallback(async (draftId: ArtifactCommentDraftId, body: ArtifactCommentPart[]) => {
    beginWrite();
    try {
      const { draft } = await artifactSource().editReviewDraft(id, draftId, draftInputBody(body));
      dispatch({ type: "draftUpdated", draft });
      clearProblemOf(draftId);
      return draft;
    } catch (error) {
      // Gone (expired, or deleted in another tab): the list as the server has it now.
      if (artifactErrorCode(error) === "DRAFT_NOT_FOUND") reloadDrafts();
      throw error;
    }
  }, [id, beginWrite, clearProblemOf, reloadDrafts]);
  const writeRemove = useCallback(async (draftId: ArtifactCommentDraftId) => {
    beginWrite();
    try {
      await artifactSource().deleteReviewDraft(id, draftId);
    } catch (error) {
      // Already gone is what was asked.
      if (artifactErrorCode(error) !== "DRAFT_NOT_FOUND") throw error;
    }
    dispatch({ type: "draftRemoved", draftId });
    setDraftView((view) => (view?.draftId === draftId ? null : view));
    clearProblemOf(draftId);
  }, [id, beginWrite, clearProblemOf]);
  const historyWrites = useMemo<DraftWrites>(() => ({
    create: writeCreate,
    edit: async (draftId, body) => { await writeEdit(draftId, body); },
    remove: writeRemove,
  }), [writeCreate, writeEdit, writeRemove]);
  const historyFailed = useCallback((direction: "undo" | "redo") => {
    showToast({ title: formatMessage({ id: direction === "undo" ? "artifacts.review.undoFailed" : "artifacts.review.redoFailed" }), type: "error" });
  }, [formatMessage]);
  const history = useDraftHistory(historyWrites, historyFailed);
  const { created, edited, deleted, clear: clearHistory } = history;

  const addDraftAt = useCallback(async (target: ArtifactCommentTarget, body: ArtifactCommentPart[], images?: ObjectFileId[]) => {
    created(await writeCreate({ version, target, replyTo: null, body, images }));
  }, [version, writeCreate, created]);
  const addDraft = useCallback(async (body: ArtifactCommentPart[], images?: ObjectFileId[]) => {
    // Nowhere to put it (the selection went): refused, so the box keeps the words.
    if (!selection) throw new Error("no selection for the draft");
    await addDraftAt(targetOf(selection.place), body, images);
    // The box saved it: its `onDone` (commentSent) takes the selection away and closes the box, as
    // for a comment sent from it.
  }, [selection, targetOf, addDraftAt]);
  const addReplyDraft = useCallback(async (replyTo: ArtifactCommentId, body: ArtifactCommentPart[], images?: ObjectFileId[]) => {
    created(await writeCreate({ version, target: { scope: "artifact" }, replyTo, body, images }));
  }, [version, writeCreate, created]);
  const updateDraft = useCallback(async (draftId: ArtifactCommentDraftId, body: ArtifactCommentPart[]) => {
    const before = drafts?.find((d) => d.id === draftId) ?? null;
    const after = await writeEdit(draftId, body);
    if (before) edited(before, after);
  }, [drafts, writeEdit, edited]);
  const removeDraft = useCallback(async (draftId: ArtifactCommentDraftId): Promise<DraftHistoryStep | null> => {
    const gone = drafts?.find((d) => d.id === draftId) ?? null;
    await writeRemove(draftId);
    return gone ? deleted(gone) : null;
  }, [drafts, writeRemove, deleted]);
  const discardAll = useCallback(async () => {
    beginWrite();
    await artifactSource().discardReviewDrafts(id);
    dispatch({ type: "emptied" });
    setProblem(null);
    // It can't be undone (its confirmation says so): neither can what came before it.
    clearHistory();
  }, [id, beginWrite, clearHistory]);
  const added = comments.added;
  const reloadComments = comments.reload;
  const setPanelOpen = comments.setPanelOpen;
  const inReview = status === "reviewing";
  const submit = useCallback(async (): Promise<void> => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    clientKey.current ??= newReviewClientKey();
    try {
      let result: ArtifactReviewSubmitted;
      try {
        result = await artifactSource().submitReview(id, { version, summary: null, clientKey: clientKey.current });
      } catch (error) {
        const code = artifactErrorCode(error);
        if (isTransient(error)) {
          // Not answered for this key: the retry sends it again, and the server answers once.
          showToast({ title: formatMessage({ id: "artifacts.review.submitFailed" }), type: "error" });
          return;
        }
        clientKey.current = null;
        if (code === "DRAFTS_CHANGED") {
          // Nothing posted: the drafts as they are now, to check and send again (in C).
          reloadDrafts();
          setProblem({ kind: "draftsChanged" });
          if (!inReview) openReview();
          return;
        }
        if (code === "NO_DRAFTS" || code === "CLIENT_KEY_REUSED") {
          // NO_DRAFTS: nothing posted under this key and none live (sent or discarded elsewhere, expired).
          // CLIENT_KEY_REUSED: this key's review was posted, with another summary or version.
          setProblem(null);
          dispatch({ type: "emptied" });
          clearHistory();
          reloadDrafts();
          reloadComments();
          showToast({ title: formatMessage({ id: code === "NO_DRAFTS" ? "artifacts.review.noDrafts" : "artifacts.review.alreadySubmitted" }) });
          return;
        }
        // Refused for good (can't see it, the version gone, no permission, a body it won't take): say which, in C.
        setProblem({ kind: "refused", code: code === "NOT_VISIBLE" || code === "VERSION_NOT_FOUND" || code === "FORBIDDEN" ? code : "other" });
        if (!inReview) openReview();
        return;
      }
      clientKey.current = null;
      if (result.status === "rejected") {
        // Nothing posted: C names what to fix (sent from the bar, it opens on it).
        setProblem({ kind: "rejected", rejection: result });
        if (!inReview) openReview();
        const { draftId } = result;
        if (draftId) setReviewFocus((current) => ({ draftId, key: current.key + 1 }));
        return;
      }
      for (const comment of result.comments) added(comment);
      // No selection to take here: each draft's went when it was added; one still selected is the
      // person's, kept.
      dispatch({ type: "emptied" });
      setProblem(null);
      // Sent can't be unsent: nothing before it is undone either.
      clearHistory();
      // What was sent, where it now is: the comment list (#250: it shows them, no toast); focus back on the Comment button.
      setPanelOpen(true);
      setToggleFocus((n) => n + 1);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [id, version, inReview, openReview, added, reloadComments, reloadDrafts, setPanelOpen, clearHistory, formatMessage]);

  const { canUndo, canRedo, busy: historyBusy, undo, redo, undoStep, watch } = history;
  const historyView = useMemo(() => ({ canUndo, canRedo, busy: historyBusy, undo, redo, undoStep, watch }), [canUndo, canRedo, historyBusy, undo, redo, undoStep, watch]);

  const handleEscape = useCallback(() => {
    // A card open (a draft's view, the box at a selection) is the dismissal layer's alone: not this Esc's.
    if (draftView || selection?.writing) return false;
    if (selection) {
      clearSelection();
      return true;
    }
    if (status === "commenting") {
      done();
      return true;
    }
    if (status === "reviewing") {
      leaveReview();
      return true;
    }
    return false;
  }, [draftView, selection, status, clearSelection, done, leaveReview]);

  // In a Markdown Artifact's margin (#152) as the comments' own marks: no counts (the frame adds the refresh mark).
  const marginShown = comments.margin.shown;
  const marks = useMemo(
    () => commentMarks(comments.comments, drafts, shownPath, { parentsMayBeOlder: comments.hasEarlier, margin: marginShown }),
    [comments.comments, comments.hasEarlier, drafts, shownPath, marginShown],
  );
  const activeThreadId = comments.activeThreadId;
  // As the comments' own (a landing's focus asked for again carries its key), on these marks.
  const focusedMark = activeThreadId && marks.some((m) => m.id === activeThreadId) ? comments.frame.focusedMark ?? activeThreadId : null;
  // The open card's mark, followed (a posted thread's, so among these marks too); none in the margin,
  // where the frame follows the margin's reference mark instead, which may be a draft's (ArtifactFrame
  // reads it, on these marks).
  const trackedMark = comments.frame.trackedMark;
  // The open composer at a selection or a picked block follows it (P138): the frame highlights it
  // and says where it is (`selectionTracked`), in the open card's mark's place while it is open.
  // Ended by every close (posted, drafted, dismissed): the composer going with the selection.
  const trackedSelection = status !== "reviewing" && selection?.writing === true && selection.place.type === "annotation";
  const touch = useMediaQuery(TOUCH_QUERY);
  const askFor = useCallback((kind: "html" | "markdown" | "pdf"): AnnotateMode | null => {
    if (!canComment || status === "reviewing") return null;
    if (kind === "html") {
      // A: selected text, as on a Markdown page (on touch, the platform's long press selects it);
      // the page's clicks and taps stay its own (Porthole takes pointer events only while a block
      // is picked). A block without text (an image, a chart) is commented on from B.
      if (status !== "commenting") return { elements: false, text: true };
      // B on touch: a block held 500 ms is selected, or selected text; every tap stays the page's
      // (none while the box is open).
      if (touch) return selection ? null : { elements: "hold", text: true };
      // B: pick a block, and again while the box is open and empty, so Esc in the page closes it
      // (Porthole reports `cancelled` only while it is asked for a pick or text, P112) and another
      // block moves it there. Not while it holds the person's words: the page's clicks are its own
      // then. Asked anew after each pick or Esc, which end it (`pickPaused`).
      if (pickPaused || (selection && composerHasOwnText)) return null;
      return { elements: true, text: false };
    }
    return { elements: false, text: true };
  }, [canComment, status, selection, touch, pickPaused, composerHasOwnText]);
  // What the frame was last asked for, remembered: the page's Esc (`cancelled`) is heard only
  // while a pick or text is asked of it, and a pick's only once (it ends the pick).
  const asked = useRef<AnnotateMode | null>(null);
  const annotating = useCallback((kind: "html" | "markdown" | "pdf") => (asked.current = askFor(kind)), [askFor]);
  const openThreadFromFrame = comments.openThreadFromFrame;
  const commentsAnnotation = comments.frame.onAnnotation;
  const draftViewKey = useRef(0);
  const onAnnotation = useCallback((report: AnnotationReport, frameBox: FrameBox | null) => {
    switch (report.type) {
      case "selected": {
        const heard = textSelectionKey(report.anchor);
        heardSelection.current = heard;
        // The same selection again (asked to point once more, or its box moved), already used up: nothing to open.
        if (heard !== null && heard === spentSelection.current) return;
        spentSelection.current = null;
        if (report.anchor.kind === "element") pickEnded();
        // A box would take the focus from a held card (artifactCardHold).
        if (!canComment || status === "reviewing" || cardHeld) return;
        // Never over words the person is writing: the box stays where it is.
        if (selection?.writing && composerHasOwnText) return;
        selectionKey.current += 1;
        // Selected text offers its Comment button; a block was picked on purpose: the box at once.
        setSelection({ place: { type: "annotation", data: storedAnchor(report) }, rect: selectionPlace(report, frameBox), key: selectionKey.current, writing: report.anchor.kind === "element" });
        return;
      }
      case "unselected":
        heardSelection.current = null;
        spentSelection.current = null;
        // The Comment button goes with the selection, not a box being written in.
        setSelection((current) => (current?.writing ? current : null));
        return;
      case "cancelled": {
        // Esc in the page while picking a block or selecting text (P112: the page keeps the key, and
        // focus stays where the person pressed it). The page's word, and an agent wrote the page: it
        // is taken only while Raft has a pick or text asked of it (as Porthole's own host does, so
        // one arriving with nothing asked is nobody's key), a pick's once (it ends the pick, until
        // it is asked again), and never under a dialog or sheet of Raft's (its confirmation's).
        // Then: told to the one place that hears the page (artifactPageSignals), where whatever
        // card or box is open goes first, by the rule they all share (artifactDismissLayer: never
        // over typed words); with nothing open, as Esc in the viewer: the selection's Comment
        // button, then out of B. Never in C.
        const request = asked.current;
        if (request === null) return;
        if (request.elements === true) asked.current = request.text ? { ...request, elements: false } : null;
        pickEnded();
        if (status === "reviewing" || isModalLayerOpen() || pageEscaped()) return;
        handleEscape();
        return;
      }
      case "activated": {
        // The page's word, guarded where it opens: a draft opens its own view (armed, no focus,
        // nothing in it submits or deletes in one click), never C; a thread opens the list on it.
        if (status === "reviewing") return;
        const draft = drafts?.find((d) => d.id === report.id);
        if (draft) {
          // Never over words the person is writing in the draft box, nor beside a held card, whose
          // Tab goes on past it into this view (artifactCardHold).
          if ((selection && composerHasOwnText) || cardHeld) return;
          const { x, y, width, height } = report.rect;
          draftViewKey.current += 1;
          setSelection(null);
          setDraftView({ draftId: draft.id, rect: { x: x + (frameBox?.left ?? 0), y: y + (frameBox?.top ?? 0), width, height }, key: draftViewKey.current, fromPage: true });
          return;
        }
        openThreadFromFrame(report.id, inClient(report.rect, frameBox), frameBox?.focused);
        return;
      }
      case "anchored":
      case "tracked":
        // Where the marks are now: the comments' card follows its marker (ArtifactCommentsContext).
        commentsAnnotation(report, frameBox, marks);
        return;
      case "selectionTracked":
        // Where the open composer's selection is now (P138; the page's word, a hint): the composer
        // alone reads it, and only for the selection it is open at. The scroll it says goes to a
        // Markdown margin too, whose reference mark isn't followed meanwhile.
        commentsAnnotation(report, frameBox, marks);
        if (!selection?.writing || selection.place.type !== "annotation") return;
        selectionPlaces.set({ key: selection.key, report, frameBox });
        // Its place gone from the page (`orphaned`: a re-render took it out, a reload): the composer
        // reads that there and closes as on Esc, its words kept as a draft (SelectionBox).
        return;
      default:
        return;
    }
  }, [canComment, status, selection, composerHasOwnText, pickEnded, handleEscape, drafts, openThreadFromFrame, commentsAnnotation, marks, cardHeld, selectionPlaces]);
  // One card at a time: a thread's card beside the file gives way to the draft's.
  const openDraftView = useCallback((draftId: ArtifactCommentDraftId, rect: AnnotationRect) => {
    if (status === "reviewing") return;
    draftViewKey.current += 1;
    setSelection(null);
    closeCommentsCard();
    setDraftView({ draftId, rect, key: draftViewKey.current, fromPage: false });
  }, [status, closeCommentsCard]);

  const value = useMemo<ArtifactReviewState>(() => ({
    status,
    drafts,
    draftCount,
    draftsFailed,
    reloadDrafts,
    canComment,
    draftsOffered,
    enterCommenting,
    done,
    leaveReview,
    reviewFocus,
    draftView,
    openDraftView,
    closeDraftView,
    selection,
    clearSelection,
    commentNow,
    commentSent,
    openFromPage,
    setComposerHasOwnText,
    addDraft,
    addDraftAt,
    addReplyDraft,
    updateDraft,
    removeDraft,
    discardAll,
    submit,
    submitting,
    problem,
    history: historyView,
    toggleFocus,
    handleEscape,
    selectionPlaces,
    frame: { marks, focusedMark, trackedMark, trackedSelection, annotating, onAnnotation, handle: frameHandle },
  }), [trackedSelection, selectionPlaces, status, drafts, draftCount, draftsFailed, reloadDrafts, submitting, historyView, toggleFocus, canComment, draftsOffered, enterCommenting, done, leaveReview, reviewFocus, draftView, openDraftView, closeDraftView, selection, clearSelection, commentNow, commentSent, openFromPage, trackedMark, setComposerHasOwnText, addDraft, addDraftAt, addReplyDraft, updateDraft, removeDraft, discardAll, submit, problem, handleEscape, marks, focusedMark, annotating, onAnnotation]);
  return <Context.Provider value={enabled ? value : null}>{children}</Context.Provider>;
}
