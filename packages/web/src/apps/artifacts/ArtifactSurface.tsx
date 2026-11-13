import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useIntl } from "react-intl";
import { Link } from "lucide-react";
import { Button, Drawer, DrawerContent, PanelAction, PanelTitle, PanelToggleAction } from "@botiverse/raft-ui";
import { CommentIcon } from "@botiverse/ricons";
import { useCommentMarginFits } from "@botiverse/raft-ui/wip";
import { artifactFileType } from "@botiverse/raft-shared";
import type { ArtifactCommentId, ArtifactViewerData } from "@botiverse/raft-shared";

import Tooltip from "../../components/ui/Tooltip";
import { trackArtifactViewerAction } from "./artifactAnalytics";
import { isEscapeTakenElsewhere, isInputMethodKey } from "./artifactInputMethodKey";
import ArtifactCommentBubble from "./ArtifactCommentBubble";
import ArtifactCommentsPanel from "./ArtifactCommentsPanel";
import { ArtifactFilesPanel } from "./ArtifactFilesPanel";
import type { ArtifactFilesJump } from "./ArtifactFilesPanel";
import { useArtifactDownload } from "./artifactDownloads";
import { ArtifactCommentsProvider, commentCount, useArtifactComments } from "./ArtifactCommentsContext";
import type { ArtifactCommentsReview } from "./ArtifactCommentsContext";
import ArtifactContent from "./ArtifactContent";
import { ArtifactListComposeProvider } from "./ArtifactListComposeProvider";
import { useListComposeFocus } from "./artifactListCompose";
import { useArtifactDisplayReport } from "./useArtifactDisplayReport";
import { ArtifactMarkdownMargin } from "./ArtifactMarkdownMargin";
import { MARKDOWN_MARGIN_WIDTH_PX, useMarginEntries, useMarginOrphaned } from "./artifactMarginEntries";
import { useArtifactFind, useArtifactFindKeyDown } from "./artifactFind";
import { ArtifactFindAction, ArtifactFindBar, ArtifactFindProvider } from "./ArtifactFindBar";
import { ArtifactLoadingArea } from "./ArtifactLoadingSplash";
import { PAGE_GROUND_CLASS, useMarkdownPageGround } from "./artifactPageGround";
import { ArtifactMetaRow } from "./ArtifactMetaRow";
import ArtifactOriginLink from "./ArtifactOriginLink";
import { ArtifactPresence, useArtifactPresence } from "./ArtifactPresence";
import ArtifactScopeLabel from "./ArtifactScopeLabel";
import { ArtifactShownFilePath } from "./ArtifactShownFilePath";
import { ArtifactReviewProvider, useArtifactReview } from "./ArtifactReviewContext";
import ArtifactReviewPanel from "./ArtifactReviewPanel";
import { ArtifactReviewBar, ArtifactReviewHeaderActions, ArtifactReviewLayer, CommentCountNumber } from "./ArtifactReviewParts";
import { followsLatest } from "./artifactFollowLatest";
import { offersForkInRaft } from "./artifactForkInRaft";
import { readsInOwnServer } from "./artifactOwnServer";
import { ArtifactPageForkProvider } from "./ArtifactPageForkProvider";
import { useArtifactNewerVersion } from "./artifactSource";
import { escapeTopCard } from "./useArtifactDismiss";
import type { ArtifactNewerVersion } from "./artifactSource";
import { ArtifactNewVersionNotice, ArtifactPinnedVersionNotice, ArtifactVersionHistorySheet, ArtifactVersionTag } from "./ArtifactVersionHistory";
import type { PickVersion } from "./ArtifactVersionHistory";
import { ArtifactViewerDialogs, ArtifactViewerMenu, useArtifactViewerActions, useCopyArtifactLink } from "./ArtifactViewerMenu";
import type { ArtifactMenuFold, ArtifactViewerActions } from "./ArtifactViewerMenu";
import type { ArtifactCommentsOpening } from "./artifactViewerStore";

/**
 * The Artifact surface: everything a reader can DO with an Artifact, in one
 * place, for both shells that show one: the in-app viewer card
 * (ArtifactViewer) and the Artifact's own page (ArtifactStandalonePage,
 * every link). A shell decides only how it is laid out (its header, Back or
 * close, width, folding, how a version is picked) and places these parts;
 * what is offered comes from here, decided by the Artifact's `capabilities`
 * and the `workspace_artifacts_v0` flag (inside the providers and parts),
 * never by which shell draws it. So a feature added here is on both.
 *
 * - ArtifactSurfaceProvider: the comments (ArtifactCommentsProvider) and
 *   comment mode (ArtifactReviewProvider), the ⋯ menu's writes and dialogs'
 *   state (useArtifactViewerActions), presence (one read), the version
 *   history sheet, the content's box (Doesn't display well here measures it).
 * - ArtifactSurfaceActions: the header's actions (actions only: raft-design
 *   panel.md's order, shown buttons, then ⋯; the shell adds close): comment
 *   mode's controls, the Comments toggle (only where comment mode isn't
 *   offered: its ▾ has Show All Comments and Doesn't display well here; never
 *   for another server's reader, readsInOwnServer), Find
 *   in page where the page may be searched (artifactFind), Copy link where the shell has room,
 *   Fork in Raft on another server's public Artifact (Send to conversation as
 *   a visible button, #proj-workspace:#140), and ⋯ (ArtifactViewerMenu: send where
 *   Fork in Raft isn't, visibility, rename, versions, download and follow (both
 *   a member of its own server's only),
 *   Doesn't display well here without comment mode (no ▾ to hold it; the
 *   list's own box, useArtifactDisplayReport), delete; in groups).
 * - ArtifactSurfaceTitle: the header's title, text only.
 * - ArtifactSurfaceMeta: the header's meta line: where it lives (the
 *   visibility chip: its options where the capabilities allow), its original
 *   message, then who's here and who read it (ArtifactPresence: the faces
 *   and the count, at every width).
 * - The Files panel (ArtifactFilesPanel, #proj-workspace:#239): every file of
 *   the version shown, opened from ⋯'s Files (or the page's `?panel=files`),
 *   in the comment list's place (the side column, or a bottom sheet as `fit`
 *   says); one of the two at a time: opening either closes the other. A framed page's link to a
 *   file of its set that isn't a page opens it there, at that file's row (`openFile`, #256).
 * - ArtifactSurfaceMain: under the header: the find bar (ArtifactFindBar), a newer
 *   version's (useArtifactNewerVersion: it asks, without moving the read
 *   position, while the page is visible; useFollowLatest shows it at once
 *   instead where nothing holds the reader) or else the pinned version's, the content with the comment list (beside it, over it, or a
 *   bottom sheet, as the shell's `fit` says) or comment mode's review, the
 *   drafts' bar at the content's foot, the selection/draft layer, a marker's card, the version
 *   history sheet and ⋯'s dialogs.
 * - useArtifactSurfaceKeyDown: Esc, for the element that handles it (the
 *   shell's Panel, `[data-artifact-focus]`): a comment's card first, then the
 *   comment list, then comment mode (its box, out of B, out of C), then
 *   the shell's own (the viewer closes); and Cmd/Ctrl+F, the find bar.
 */

/** Which shell draws it: names its test ids, and leaves out of ⋯ what makes no sense there (ArtifactViewerMenu). */
export type ArtifactSurfaceKind = "viewer" | "page";

/**
 * Where the open comment list (or comment mode's review) goes:
 * - "measure": beside the content where the surface is wide enough, else
 *   over it, full height, the content inert under it (a card whose width
 *   varies);
 * - "beside": always beside it (a whole window);
 * - "sheet": a bottom sheet over the page (a phone: the Artifact's page and the
 *   viewer), comment mode's review too
 *   (ArtifactReviewLayer).
 */
export type ArtifactCommentsFit = "measure" | "beside" | "sheet";

interface ArtifactSurfaceState {
  /** The data as shown: the viewer data with what this reader's writes changed. */
  data: ArtifactViewerData;
  actions: ArtifactViewerActions;
  kind: ArtifactSurfaceKind;
  phone: boolean;
  fit: ArtifactCommentsFit;
  presence: ReturnType<typeof useArtifactPresence>;
  /**
   * The meta line's scope label, a button on both shells whether it has visibility options or
   * only says who can see it: where a narrowing dialog gives focus back.
   */
  chipRef: RefObject<HTMLButtonElement | null>;
  /** ⋯: where focus goes back when the comment list closes and nothing within the surface opened it. */
  menuRef: RefObject<HTMLButtonElement | null>;
  versionsOpen: boolean;
  setVersionsOpen: (open: boolean) => void;
  /** The Files panel is open (in the comment list's place). */
  filesOpen: boolean;
  /** Open (closing the comment list) or close the Files panel. */
  setFilesOpen: (open: boolean) => void;
  /** Close the Files panel, focus back on ⋯ (which opened it). */
  closeFiles: () => void;
  /** The file a page's link opened the panel at (each link a new jump), or null. */
  filesJump: ArtifactFilesJump | null;
  /** Open the panel at a file of the version shown (a framed page's link to it; ArtifactFrame `onOpenFile`). */
  openFile: (path: string) => void;
  pickVersion: PickVersion;
  /** Show the latest, read again (View latest on a newer version's notice). */
  showLatest: () => void;
  /** The same read, when the surface follows a newer version itself (useFollowLatest): not the reader's switch, so not tracked as one. */
  followLatest: () => void;
  /** Close the comment list, focus back on what opened it (within `root`, the surface), or ⋯. */
  closeComments: (root: Element | null) => void;
  /** The content's box (SurfaceBody sets it), where Doesn't display well here measures the page area (#proj-workspace:#243). */
  pageRef: RefObject<HTMLDivElement | null>;
}

const SurfaceContext = createContext<ArtifactSurfaceState | null>(null);

function useSurface(): ArtifactSurfaceState {
  const surface = useContext(SurfaceContext);
  if (!surface) throw new Error("An Artifact surface part outside ArtifactSurfaceProvider");
  return surface;
}

/**
 * For a shell's own header: the data shown (with this reader's writes), the
 * version list's and the Files panel's state (the page's `?panel=versions`,
 * `?panel=files` and `#panel=`, artifactPageOpening), and ⋯'s actions (the page's `?fork=1` opens Fork in
 * Raft's dialog).
 */
export function useArtifactSurface(): Pick<ArtifactSurfaceState, "data" | "versionsOpen" | "setVersionsOpen" | "filesOpen" | "setFilesOpen" | "actions"> {
  return useSurface();
}

const commentsPanelId = (kind: ArtifactSurfaceKind) => `artifact-${kind}-comments`;
const filesPanelId = (kind: ArtifactSurfaceKind) => `artifact-${kind}-files`;
const commentsToggleId = (kind: ArtifactSurfaceKind) => `artifact-${kind}-comments-toggle`;
/** What opens the list: the Comments toggle, or, with comment mode, the Comment button's ▾. */
const commentsOpener = (kind: ArtifactSurfaceKind) => `[data-testid='${commentsToggleId(kind)}'], [data-testid='artifact-review-comment-menu']`;

export function ArtifactSurfaceProvider({ data, shownKey, onDeleted, kind, phone, fit, onPickVersion, onShowLatest, review = null, landOn = null, listOn = null, children }: {
  /** The viewer data loaded for the version shown. */
  data: ArtifactViewerData;
  /** The version shown (and attempt): a write answered for another is dropped (useArtifactViewerActions). */
  shownKey: string;
  /** Where to go once it is deleted (the card closes; the page goes back to the server). */
  onDeleted: () => void;
  kind: ArtifactSurfaceKind;
  /** Laid out as on a phone (the window's width; the App's web view at any width). */
  phone: boolean;
  /** Where the open comment list goes: the shell's layout. */
  fit: ArtifactCommentsFit;
  /** Show another version (null: the latest): the shell decides how (its own state, or the address). */
  onPickVersion: PickVersion;
  /**
   * Show the latest version, read again even where the latest is already
   * followed (a newer one is out since it loaded): the shell's own read, as a
   * pick (a pinned version: the same as `onPickVersion(null)`).
   */
  onShowLatest: () => void;
  /** A review (S8) the comment list shows alone, and how to leave it (ArtifactCommentsProvider). */
  review?: ArtifactCommentsReview | null;
  /** The comment it opens at (ArtifactCommentsProvider). */
  landOn?: ArtifactCommentId | null;
  /** Opened on its comments (ArtifactCommentsProvider). */
  listOn?: ArtifactCommentsOpening | null;
  children: ReactNode;
}) {
  // The ⋯ menu's writes over the data loaded; what they changed is the data shown, everywhere below.
  const actions = useArtifactViewerActions(data, shownKey, onDeleted);
  const view = actions.view ?? data;
  return (
    <ArtifactCommentsProvider data={view} review={review} landOn={landOn} listOn={listOn}>
      <ArtifactListComposeProvider>
        <ArtifactReviewProvider>
          <SurfaceState data={view} actions={actions} kind={kind} phone={phone} fit={fit} onPickVersion={onPickVersion} onShowLatest={onShowLatest}>
            {children}
          </SurfaceState>
        </ArtifactReviewProvider>
      </ArtifactListComposeProvider>
    </ArtifactCommentsProvider>
  );
}

function SurfaceState({ data, actions, kind, phone, fit, onPickVersion, onShowLatest, children }: {
  data: ArtifactViewerData;
  actions: ArtifactViewerActions;
  kind: ArtifactSurfaceKind;
  phone: boolean;
  fit: ArtifactCommentsFit;
  onPickVersion: PickVersion;
  onShowLatest: () => void;
  children: ReactNode;
}) {
  // One presence read per opening, for the meta line under the title.
  const presence = useArtifactPresence(data.card.id);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const pageRef = useRef<HTMLDivElement | null>(null);
  // The sheet is the phone's; leaving the phone layout closes it, so it doesn't come back on its own.
  if (versionsOpen && !phone) setVersionsOpen(false);
  const pickVersion = useCallback<PickVersion>((version) => {
    trackArtifactViewerAction("version_switch");
    setVersionsOpen(false);
    onPickVersion(version);
  }, [onPickVersion]);
  const showLatest = useCallback(() => {
    trackArtifactViewerAction("version_switch");
    setVersionsOpen(false);
    onShowLatest();
  }, [onShowLatest]);
  const commentsState = useArtifactComments();
  const setCommentsOpen = commentsState?.setPanelOpen;
  const commentsOpen = commentsState?.panelOpen ?? false;
  // The Files panel and the comment list share their place: one at a time. Opening Files closes the list;
  // the list opening (from wherever: its toggle, a marker, a link's landing) closes Files.
  const [filesShown, setFilesShown] = useState(false);
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the list's state when Files last checked it, to close Files during render when the list opens (React's "adjusting state when a prop changes").
  const [commentsSeen, setCommentsSeen] = useState(commentsOpen);
  if (commentsSeen !== commentsOpen) {
    setCommentsSeen(commentsOpen);
    if (commentsOpen && filesShown) setFilesShown(false);
  }
  // No files (nothing to list): it never opens, whatever asks (the page's `?panel=files`).
  const hasFiles = data.files.length > 0;
  const filesOpen = filesShown && !commentsOpen && hasFiles;
  const [filesJump, setFilesJump] = useState<ArtifactFilesJump | null>(null);
  const setFilesOpen = useCallback((open: boolean) => {
    if (open && !hasFiles) return;
    if (open) setCommentsOpen?.(false);
    setFilesJump(null);
    setFilesShown(open);
  }, [setCommentsOpen, hasFiles]);
  // Each link a new jump, counted here: setFilesOpen has just cleared the last one, so it can't count.
  const jumps = useRef(0);
  const openFile = useCallback((path: string) => {
    setFilesOpen(true);
    jumps.current += 1;
    setFilesJump({ path, jump: jumps.current });
  }, [setFilesOpen]);
  const closeFiles = useCallback(() => {
    setFilesShown(false);
    menuRef.current?.focus();
  }, []);
  const closeComments = useCallback((root: Element | null) => {
    setCommentsOpen?.(false);
    // Back to what opened it: the Comments toggle, the Comment button's ▾, or ⋯ where the toggle is folded into it.
    (root?.querySelector<HTMLElement>(commentsOpener(kind)) ?? menuRef.current)?.focus();
  }, [setCommentsOpen, kind]);
  const value = useMemo<ArtifactSurfaceState>(() => ({
    data, actions, kind, phone, fit, presence, chipRef, menuRef, versionsOpen, setVersionsOpen, filesOpen, setFilesOpen, closeFiles, filesJump, openFile, pickVersion, showLatest, followLatest: onShowLatest, closeComments, pageRef,
  }), [data, actions, kind, phone, fit, presence, versionsOpen, filesOpen, setFilesOpen, closeFiles, filesJump, openFile, pickVersion, showLatest, onShowLatest, closeComments]);
  // Find in page: the bar's state for this opening; the frame offers its page through the frame's context.
  return (
    <SurfaceContext.Provider value={value}>
      <ArtifactFindProvider>
        <ArtifactPageForkProvider data={data} openFork={actions.openFork}>{children}</ArtifactPageForkProvider>
      </ArtifactFindProvider>
    </SurfaceContext.Provider>
  );
}

/**
 * Esc on the surface (the shell's Panel), one thing each: the card that is open first (the one on
 * top of the dismissal layer, artifactDismissLayer: a thread's card, a new comment's, the comment
 * box at a selection or a picked block, a draft's view), wherever in the surface the focus is, the
 * comment list included; then, inside the comment list (nothing in it took Esc), the list, back to
 * its opener; inside the Files panel, the panel, back to ⋯; then comment mode: a selection's
 * Comment button, out of B (drafts kept) or out of C, back to where it was opened. Anything else
 * is the shell's (`onUnhandled`: the viewer closes). Works outside a surface too (a shell still loading).
 * Cmd/Ctrl+F opens the find bar where the page shown may be searched; else
 * the browser's find opens, as it does in the page.
 */
export function useArtifactSurfaceKeyDown(onUnhandled?: () => void): (event: KeyboardEvent<HTMLElement>) => void {
  const surface = useContext(SurfaceContext);
  const listOpen = useArtifactComments()?.panelOpen ?? false;
  const closeComments = surface?.closeComments;
  const closeFiles = surface?.filesOpen ? surface.closeFiles : null;
  const reviewEscape = useArtifactReview()?.handleEscape;
  // Cmd/Ctrl+F; and, the find bar open, Esc closes it first, wherever the focus is in the surface (its buttons included).
  const findKeyDown = useArtifactFindKeyDown();
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (findKeyDown(event)) return;
    // An Esc taken elsewhere (input method, an open modal over the surface) closes nothing here.
    if (event.key !== "Escape" || isEscapeTakenElsewhere(event)) return;
    if (escapeTopCard(event.nativeEvent)) {
      event.preventDefault();
      return;
    }
    if (listOpen && closeComments && event.target instanceof Element && event.target.closest("[data-testid='artifact-comments-panel']")) {
      event.preventDefault();
      closeComments(event.currentTarget);
      return;
    }
    if (closeFiles && event.target instanceof Element && event.target.closest("[data-testid='artifact-files-panel']")) {
      event.preventDefault();
      closeFiles();
      return;
    }
    if (reviewEscape?.()) {
      event.preventDefault();
      return;
    }
    if (onUnhandled) {
      event.preventDefault();
      onUnhandled();
    }
  }, [findKeyDown, listOpen, closeComments, closeFiles, reviewEscape, onUnhandled]);
}

/** Opening or closing the comment list from its toggle; opening it is `comments_open`. */
function useTrackedCommentsOpen(setPanelOpen: ((open: boolean) => void) | undefined): (open: boolean) => void {
  return useCallback((open: boolean) => {
    if (open) trackArtifactViewerAction("comments_open");
    setPanelOpen?.(open);
  }, [setPanelOpen]);
}

/** Comment mode's head controls as ⋯ items (ArtifactMenuFold `review`), where `folded`; the ▾'s `reportDisplay` too. */
function useReviewMenuFold(folded: boolean, reportDisplay: (() => void) | null): ArtifactMenuFold["review"] {
  const { formatMessage } = useIntl();
  const review = useArtifactReview();
  const comments = useArtifactComments();
  const setCommentsOpen = useTrackedCommentsOpen(comments?.setPanelOpen);
  const status = review?.status ?? "browsing";
  const count = comments ? commentCount(comments) : 0;
  const enterCommenting = review?.enterCommenting;
  const done = review?.done;
  const reloadDrafts = review?.reloadDrafts;
  const draftsFailed = review?.draftsFailed ?? false;
  return useMemo(() => (folded ? {
    commenting: status !== "browsing",
    label: formatMessage({ id: "artifacts.review.comment" }),
    onToggle: (pressed: boolean) => (pressed ? enterCommenting?.() : done?.()),
    showAllLabel: formatMessage({ id: "artifacts.comments.showAll" }, { count }),
    onShowAll: () => setCommentsOpen(true),
    retry: draftsFailed && reloadDrafts ? { label: formatMessage({ id: "artifacts.review.draftsLoadFailedRetry" }), onSelect: reloadDrafts } : null,
    reportDisplay: reportDisplay ? { label: formatMessage({ id: "artifacts.menu.displayReport" }), onSelect: reportDisplay } : null,
  } : null), [count, done, draftsFailed, enterCommenting, folded, formatMessage, reloadDrafts, setCommentsOpen, status, reportDisplay]);
}

/**
 * The header's actions, in the shell's PanelActions (before its own: the
 * viewer's Expand and close). The shell says how much room there is:
 */
export function ArtifactSurfaceActions({ compact, commentsInMenu, copyLinkHere, reviewInMenu = false, openInNewPageInMenu = false, findInMenuHere = false, forkInMenuHere = false, scopeInMenu = false }: {
  /** A compact header: Find in page and Fork in Raft folded into ⋯. */
  compact: boolean;
  /** The Comments toggle in ⋯, not here. */
  commentsInMenu: boolean;
  /** Copy link here; else in ⋯. */
  copyLinkHere: boolean;
  /** Comment mode's controls in ⋯, not here (a head with no room for them; #189 rule 6). */
  reviewInMenu?: boolean;
  /** The shell's Open in New Page in ⋯ (it folded from the head). */
  openInNewPageInMenu?: boolean;
  /** Find in page in ⋯ also where the header isn't compact (a head with no room for it; #189 rule 6). */
  findInMenuHere?: boolean;
  /** Fork in Raft in ⋯ also where the header isn't compact (a head with no room for it; #189 rule 6). */
  forkInMenuHere?: boolean;
  /** The visibility chip folded into ⋯ (ArtifactSurfaceMeta's `scopeInMenu`). */
  scopeInMenu?: boolean;
}) {
  const { formatMessage } = useIntl();
  const { data, actions, kind, phone, fit, menuRef, pickVersion, setVersionsOpen, setFilesOpen, pageRef } = useSurface();
  const comments = useArtifactComments();
  const setCommentsOpen = useTrackedCommentsOpen(comments?.setPanelOpen);
  // Where comment mode is offered, Show All Comments is the Comment button's ▾, shown at every width: no Comments toggle.
  const modeOffered = useArtifactReview()?.canComment ?? false;
  // Another server's reader has no comments to read (the server answers them none): no Comments toggle, here or in ⋯;
  // the page's own comment button offers Fork in Raft instead (useArtifactPageForkAsk).
  const toggle = comments !== null && !modeOffered && readsInOwnServer(data.card);
  const commentsOpen = comments?.panelOpen ?? false;
  // The one comment control carries the count (as the Comment button's ▾ does where comment mode is offered).
  const commentsNumber = comments ? commentCount(comments) : 0;
  const commentsLabel = comments ? formatMessage({ id: "artifacts.comments.toggle" }, { count: commentsNumber }) : "";
  const copyLink = useCopyArtifactLink(data.card);
  const copyLabel = formatMessage({ id: "artifacts.menu.copyLink" });
  const openVersions = useCallback(() => setVersionsOpen(true), [setVersionsOpen]);
  const openFiles = useCallback(() => setFilesOpen(true), [setFilesOpen]);
  const reportDisplay = useArtifactDisplayReport(pageRef);
  const reviewFold = useReviewMenuFold(reviewInMenu && modeOffered, reportDisplay);
  // Another server's public Artifact: Send to conversation is the header's Fork in Raft, not in ⋯ (#proj-workspace:#140).
  const fork = offersForkInRaft(data.card);
  const forkLabel = formatMessage({ id: "artifacts.fork.inRaft" });
  // A compact header (the viewer's narrow card) folds it into ⋯ as its first item: a long label (es, pt-br)
  // never squeezes the title; so does a head with no room for it (#189 rule 6: the last own action, the first to fold).
  const forkInMenu = fork && (compact || forkInMenuHere);
  const { openFork } = actions;
  // Find in page, where the page shown may be searched: after the comment controls, folding before them.
  const find = useArtifactFind();
  const findOffered = find?.offered ?? false;
  const findInMenu = findOffered && (compact || findInMenuHere);
  const findLabel = formatMessage({ id: "artifacts.find.open" });
  const openFind = find?.openBar;
  const fold = useMemo<ArtifactMenuFold | null>(() => {
    const comments = toggle && commentsInMenu ? { open: commentsOpen, label: commentsLabel, onOpenChange: setCommentsOpen } : null;
    const findItem = findInMenu && openFind ? { label: findLabel, onSelect: openFind } : null;
    const forkItem = forkInMenu ? { label: forkLabel, onSelect: openFork } : null;
    return comments || findItem || forkItem || reviewFold || openInNewPageInMenu || scopeInMenu
      ? { comments, find: findItem, fork: forkItem, review: reviewFold, openInNewPage: openInNewPageInMenu, scope: scopeInMenu }
      : null;
  }, [toggle, commentsInMenu, commentsOpen, commentsLabel, setCommentsOpen, findInMenu, findLabel, openFind, forkInMenu, forkLabel, openFork, reviewFold, openInNewPageInMenu, scopeInMenu]);
  return (
    <>
      {reviewFold ? null : <ArtifactReviewHeaderActions onReportDisplay={reportDisplay} />}
      {toggle && !commentsInMenu ? (
        <Tooltip content={commentsLabel}>
          <PanelToggleAction
            aria-label={commentsLabel}
            aria-controls={commentsOpen && fit !== "sheet" ? commentsPanelId(kind) : undefined}
            pressed={commentsOpen}
            onPressedChange={setCommentsOpen}
            data-testid={commentsToggleId(kind)}
          >
            <CommentIcon />
            {commentsNumber > 0 ? <CommentCountNumber count={commentsNumber} /> : null}
          </PanelToggleAction>
        </Tooltip>
      ) : null}
      {findInMenu ? null : <ArtifactFindAction testId={`artifact-${kind}-find`} />}
      {copyLinkHere ? (
        <Tooltip content={copyLabel}>
          <PanelAction aria-label={copyLabel} onClick={copyLink} data-testid={`artifact-${kind}-copy-link`}>
            <Link />
          </PanelAction>
        </Tooltip>
      ) : null}
      {fork && !forkInMenu ? (
        // The one pink action here (Raft DS › Button: a labelled `md` Button is a panel header's), before ⋯.
        <Button type="button" variant="primary" size="md" className="shrink-0" onClick={openFork} data-testid={`artifact-${kind}-fork`}>
          {forkLabel}
        </Button>
      ) : null}
      <ArtifactViewerMenu
        data={data}
        surface={kind}
        visibility={actions.visibility}
        following={actions.following}
        onToggleFollow={actions.toggleFollow}
        onDelete={actions.askDelete}
        onSend={fork ? null : actions.openShare}
        onCopyLink={copyLinkHere ? null : copyLink}
        onEmbed={actions.embed}
        onRename={actions.rename?.start ?? null}
        onPickVersion={pickVersion}
        onOpenVersions={openVersions}
        onOpenFiles={openFiles}
        onReportDisplay={modeOffered ? null : reportDisplay}
        fold={fold}
        triggerRef={menuRef}
        phone={phone}
      />
    </>
  );
}

/**
 * The header's title, the same in every shell: text only (#proj-workspace:#169:
 * ⋯'s Rename renames it, in its dialog). `pageHeading`: the title is the
 * page's h1 (the Artifact's own page).
 */
export function ArtifactSurfaceTitle({ pageHeading = false, testId }: { pageHeading?: boolean; testId: string }) {
  const { data } = useSurface(), { title } = data.card;
  const heading = pageHeading ? <PanelTitle render={<h1>{title}</h1>} data-testid={testId} /> : <PanelTitle data-testid={testId}>{title}</PanelTitle>;
  return <>{heading}<ArtifactShownFilePath data={data} /></>;
}

/**
 * The header's version tag beside the title, the same in every shell: with
 * more than one version it switches versions (a menu on a desktop, the
 * version sheet on a phone), as ⋯'s Version history does.
 */
export function ArtifactSurfaceVersionTag() {
  const { data, phone, pickVersion, setVersionsOpen } = useSurface();
  const openVersions = useCallback(() => setVersionsOpen(true), [setVersionsOpen]);
  return <ArtifactVersionTag data={data} phone={phone} onPick={pickVersion} onOpenSheet={openVersions} />;
}

/**
 * The header's meta line, the same in every shell: where it lives (the
 * visibility chip, which offers its options where the capabilities allow),
 * its original message (into the server, to it), then who else is here and
 * who read it (ArtifactPresence), the same at every width (stdrc's option A,
 * #proj-raft-ui:7531279d). Laid out by ArtifactMetaRow: the text part
 * truncates, the readers sit beside it and never shrink. The shell renders
 * it under the title as it is (it holds its own PanelMeta).
 */
export function ArtifactSurfaceMeta({ replace = false, onOpened, testId, scopeInMenu = false }: {
  /** The visibility chip folded into ⋯ (a head with no room; #189 rule 6): not here. */
  scopeInMenu?: boolean;
  /** Opening the original message replaces this history entry (the viewer on a phone is a page with its own). */
  replace?: boolean;
  /** After the original message opened (the side card closes where it covers its channel). */
  onOpened?: () => void;
  testId?: string;
}) {
  const { data, actions, chipRef, presence, phone } = useSurface();
  return (
    <ArtifactMetaRow
      testId={testId}
      text={(
        <>
          {/* A narrowing dialog gives focus back to the chip. */}
          {scopeInMenu ? null : <ArtifactScopeLabel home={data.card.home} fromAnotherServer={data.card.fromAnotherServer} visibility={actions.visibility} triggerRef={chipRef} />}
          <ArtifactOriginLink origin={data.origin} replace={replace} onOpened={onOpened} />
        </>
      )}
      readers={<ArtifactPresence presence={presence} facesOnly={phone} />}
    />
  );
}

/**
 * Follows a newer version where followsLatest says so: the latest read again
 * (the shell's own read, as View latest), once per version (a read that answers
 * an older one, or fails, leaves the strip, so it never loops); the version
 * badge changing says it happened (#250: no toast). What held it (words in a box, say) ending
 * lets the next render follow. Whether a follow is under way: the strip waits.
 */
function useFollowLatest(newer: ArtifactNewerVersion | null, switching: boolean, failedVersion: number | "latest" | null): boolean {
  const { data, versionsOpen, followLatest } = useSurface();
  const comments = useArtifactComments();
  const review = useArtifactReview();
  // Reading a thread's card (a marker's, a link's landing) counts too: a version change closes it.
  // So does a box focused or opened by the person, even empty (#proj-workspace:#144: spoken words may not have landed in it yet).
  const midAction = (comments?.holdsOwnWords ?? false)
    || (comments?.boxEngaged ?? false)
    || (comments?.bubble ?? null) !== null
    || (comments?.shellLanding ?? null) !== null
    || (review?.selection ?? null) !== null
    || versionsOpen;
  const follows = newer !== null && followsLatest({
    pinned: data.card.pinned,
    loading: switching || failedVersion !== null,
    mode: review?.status ?? "browsing",
    midAction,
  });
  const version = newer?.version ?? null;
  const key = version === null ? null : `${data.card.id}@${version}`;
  /** The newer version followed last (`id@n`): each one once. */
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (!follows || key === null || version === null || followed.current === key) return;
    followed.current = key;
    followLatest();
  }, [follows, key, version, followLatest]);
  return follows && followed.current !== key;
}

/**
 * Everything under the header, in the shell's Panel: the find bar while open,
 * then one strip at most (raft-design Banner: one in one place), what is
 * read being out of date first: a version that failed (`failedVersion` and
 * Retry where the shell can fail one), else a newer version's (View latest;
 * not while one loads, nor while useFollowLatest shows it at once), else the
 * pinned version's (Back to Latest); the person's drafts are said in the bar
 * at the content's foot (ArtifactReviewBar), not in a strip; the content (the loading splash while `switching`) with
 * the comment list as the shell's `fit` says (a comment on the whole Artifact is written at its
 * foot: no box always at the viewer's foot, xxchan #proj-workspace:afc83052), the layers over it
 * and ⋯'s dialogs.
 */
export function ArtifactSurfaceMain({ switching, failedVersion = null, onRetry }: {
  switching: boolean;
  failedVersion?: number | "latest" | null;
  onRetry?: () => void;
}) {
  const { data, actions, pickVersion, showLatest, versionsOpen, setVersionsOpen, phone, chipRef, menuRef } = useSurface();
  const backToLatest = useCallback(() => pickVersion(null), [pickVersion]);
  const newer = useArtifactNewerVersion(data.card);
  const following = useFollowLatest(newer, switching, failedVersion);
  // Also what the new version's strip leaves in its place while it waits for the version's note.
  const pinnedNotice = <ArtifactPinnedVersionNotice card={data.card} failedVersion={failedVersion} onBackToLatest={backToLatest} onRetry={onRetry} />;
  return (
    <>
      <ArtifactFindBar />
      {newer && !switching && failedVersion === null && !following
        ? <ArtifactNewVersionNotice id={data.card.id} newer={newer} onViewLatest={showLatest} waiting={pinnedNotice} />
        : pinnedNotice}
      <SurfaceBody switching={switching} />
      <ArtifactVersionHistorySheet data={data} open={versionsOpen && phone} onOpenChange={setVersionsOpen} onPick={pickVersion} />
      <ArtifactViewerDialogs data={data} actions={actions} finalFocus={chipRef} menuFocus={menuRef} />
    </>
  );
}

/** Narrower than this, a measured surface's comment list covers the content instead of sitting beside it. */
const COMMENTS_BESIDE_MIN_WIDTH = 720;

function useNarrowerThan(element: HTMLElement | null, width: number, measure: boolean): boolean {
  const [narrow, setNarrow] = useState(true);
  useLayoutEffect(() => {
    if (!element || !measure) return;
    const update = () => setNarrow(element.getBoundingClientRect().width < width);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, width, measure]);
  return measure && narrow;
}

/** The content and, when it is open, the comment list (or comment mode's review) as `fit` says; a marker's card and comment mode's layer. */
function SurfaceBody({ switching }: { switching: boolean }) {
  const { formatMessage } = useIntl();
  const { data, kind, phone, fit, closeComments, filesOpen, closeFiles, filesJump, openFile, pageRef } = useSurface();
  const comments = useArtifactComments();
  const download = useArtifactDownload(data);
  const downloadAll = download?.all ? download.download : null;
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  // The content's box beside the margin (or the list): the frame fills it. Doesn't display well here measures it.
  const [page, setPage] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => { pageRef.current = page; }, [pageRef, page]);
  const cover = useNarrowerThan(element, COMMENTS_BESIDE_MIN_WIDTH, fit === "measure");
  const listOpen = comments?.panelOpen ?? false;
  // Comment mode's review (C) takes the list's place; on a phone it is a bottom sheet (ArtifactReviewLayer).
  const reviewing = useArtifactReview()?.status === "reviewing" && !phone;
  const column = (listOpen || reviewing || filesOpen) && fit !== "sheet";
  // A Markdown file's comments as cards in a margin beside it (#proj-workspace:#152, mockup v8):
  // on a desktop with measured room (raft-ui useCommentMarginFits: from 768 px with a mouse, the viewer
  // at least 784 px wide; never without matchMedia, measured once without ResizeObserver), while the
  // list or comment mode's review isn't the side column (one or the other), and only where some
  // thread or draft is on a passage. Never without ResizeObserver either, whatever that measure says:
  // raft-ui's CommentMargin measures each card with one (and would throw), and the margin asks for
  // its places only as the page beside it gets a size (ArtifactMarkdownMargin), so its cards would
  // wait forever. Without it the page's own markers show the threads, as on a narrow viewer.
  const fits = useCommentMarginFits(element) && typeof ResizeObserver !== "undefined";
  // Only threads and drafts whose passage the page still has: no empty margin when all are gone.
  const marginEntries = useMarginEntries(comments);
  const orphaned = useMarginOrphaned();
  const onPage = marginEntries.some((entry) => !orphaned.has(entry.id));
  const shownPath = comments?.shownPath ?? null, shownEntry = shownPath === (data.files.find((f) => f.entry) ?? data.files[0])?.path;
  const margin = Boolean(comments) && !phone && fit !== "sheet" && !column && fits && !switching
    && shownPath !== null && artifactFileType(shownPath).kind === "markdown" && onPage && shownEntry;
  // The margin paints the page's own ground (the sidebar's under a card, or the canvas: the frame's
  // width decides, artifactPageGround), and its cards keep `layer-card`, as the page's document does.
  const ground = useMarkdownPageGround(page, margin);
  const setMarginShown = comments?.margin.setShown;
  useLayoutEffect(() => {
    if (!setMarginShown) return;
    setMarginShown(margin);
  }, [setMarginShown, margin]);
  useEffect(() => () => setMarginShown?.(false), [setMarginShown]);
  const close = useCallback(() => closeComments(element?.closest("[data-artifact-focus]") ?? null), [closeComments, element]);
  // The element that handles Esc: where comment mode's box gives focus when it closes, and what a marker's card stays within.
  const surfaceElement = useCallback(() => element?.closest<HTMLElement>("[data-artifact-focus]") ?? null, [element]);
  const boundary = surfaceElement();
  // `data-find-offered`: whether Find in page is offered here yet (a framed page's lazily loaded frame
  // registers its find target once it mounts, artifactFind `offered`), so a test reads the header and ⋯
  // once it has settled rather than racing the frame. Read nowhere else.
  const findOffered = useArtifactFind()?.offered ?? false;
  return (
    <div ref={setElement} className="relative flex min-h-0 flex-1" data-comments={column ? (cover ? "cover" : "beside") : undefined} data-find-offered={findOffered} data-testid={`artifact-${kind}-layout`}>
      <div ref={setPage} className="relative flex min-h-0 min-w-0 flex-1 flex-col" inert={(column && cover) || undefined} data-testid={`artifact-${kind}-body`}>
        {/* Another version loading: the opening's splash (the shell's ArtifactSplashScope counts from the pick). */}
        {switching ? <ArtifactLoadingArea kind={data.card.kind} testId={`artifact-${kind}-switching`} /> : <ArtifactContent data={data} onOpenFile={openFile} />}
        {/* Comment mode's and the drafts' bar, floating at the content's foot. */}
        <ArtifactReviewBar kind={data.card.kind} />
      </div>
      {margin ? (
        // Beside the page, in the layout: the margin's cards scroll with the passages they are about.
        <aside
          className={`shrink-0 ${PAGE_GROUND_CLASS[ground]}`}
          style={{ width: MARKDOWN_MARGIN_WIDTH_PX }}
          data-ground={ground}
          aria-label={formatMessage({ id: "artifacts.comments.margin.label" })}
          data-testid={`artifact-${kind}-margin`}
        >
          <ArtifactMarkdownMargin page={page} />
        </aside>
      ) : null}
      {column && filesOpen ? (
        // The Files panel in the comment list's place (one of the two at a time), over comment mode's review too.
        <aside
          id={filesPanelId(kind)}
          className={cover ? "absolute inset-0 z-cover flex" : "flex w-[340px] shrink-0 border-s border-line-seam"}
          data-testid={filesPanelId(kind)}
        >
          <ArtifactFilesPanel data={data} onClose={closeFiles} onDownloadAll={downloadAll} jump={filesJump} />
        </aside>
      ) : column ? (
        // Beside the content, in the layout: a side column with its own seam (no overlay, no shadow); or over it where narrow.
        <aside
          id={commentsPanelId(kind)}
          className={cover ? "absolute inset-0 z-cover flex" : "flex w-[340px] shrink-0 border-s border-line-seam"}
          data-testid={commentsPanelId(kind)}
        >
          {/* Show All Comments in C puts the list over the pending review until it is closed. */}
          {reviewing && !listOpen ? <ArtifactReviewPanel /> : <ArtifactCommentsPanel onClose={close} />}
        </aside>
      ) : null}
      {fit === "sheet" ? <CommentsSheet /> : null}
      {fit === "sheet" ? <FilesSheet downloadAll={downloadAll} /> : null}
      <ArtifactReviewLayer viewer={surfaceElement} />
      <ArtifactCommentBubble boundary={boundary} />
    </div>
  );
}

/** The Files panel as a bottom sheet (a phone), as the comment list is there. */
function FilesSheet({ downloadAll }: { downloadAll: (() => void) | null }) {
  const { formatMessage } = useIntl();
  const { data, kind, filesOpen, setFilesOpen, filesJump } = useSurface();
  // The sheet gives focus back itself (to ⋯, which opened it), so closing it only closes it.
  const close = useCallback(() => setFilesOpen(false), [setFilesOpen]);
  const change = useCallback((open: boolean) => {
    if (!open) close();
  }, [close]);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || isInputMethodKey(event)) return;
    // Esc closes the sheet only, not the viewer behind it (as the comment sheet's).
    event.stopPropagation();
    if (event.defaultPrevented) return;
    event.preventDefault();
    close();
  }, [close]);
  return (
    <Drawer open={filesOpen} onOpenChange={change}>
      {/* The panel's own header (title, ×) is the sheet's: no DrawerHeader over it. */}
      <DrawerContent aria-label={formatMessage({ id: "artifacts.files.title" })} onKeyDown={onKeyDown} data-testid={`${filesPanelId(kind)}-sheet`}>
        <div className="flex max-h-[70dvh] min-h-0 flex-col">
          <ArtifactFilesPanel data={data} onClose={close} onDownloadAll={downloadAll} jump={filesJump} closeOnOpen />
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/** The comment list as a bottom sheet (a phone), as a document's comments are there. */
function CommentsSheet() {
  const { formatMessage } = useIntl();
  const { kind } = useSurface();
  const comments = useArtifactComments();
  const setPanelOpen = comments?.setPanelOpen;
  // The sheet gives focus back itself (to the toggle that had it), so closing it only closes it.
  const close = useCallback(() => setPanelOpen?.(false), [setPanelOpen]);
  const change = useCallback((open: boolean) => {
    if (!open) close();
  }, [close]);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || isInputMethodKey(event)) return;
    // Esc the list took (the @ picker, reply or edit mode) stays there; any other closes the sheet.
    event.stopPropagation();
    if (event.defaultPrevented) return;
    event.preventDefault();
    close();
  }, [close]);
  const { sheetRef, initialFocus } = useListComposeFocus();
  return (
    <Drawer open={comments?.panelOpen ?? false} onOpenChange={change}>
      {/* The list's own header (title, ×) is the sheet's: no DrawerHeader over it. */}
      <DrawerContent aria-label={formatMessage({ id: "artifacts.comments.title" })} initialFocus={initialFocus} onKeyDown={onKeyDown} data-testid={`${commentsPanelId(kind)}-sheet`}>
        <div ref={sheetRef} className="flex h-[70dvh] min-h-0 flex-col">
          <ArtifactCommentsPanel onClose={close} />
        </div>
      </DrawerContent>
    </Drawer>
  );
}
