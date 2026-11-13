import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, ArrowUpRight, FileX, Maximize2, Minimize2, X } from "lucide-react";
import {
  Panel,
  PanelAction,
  PanelActions,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelStatus,
  PanelTitle,
  PanelToggleAction,
} from "@botiverse/raft-ui";
import type { ArtifactCard, ArtifactCommentId } from "@botiverse/raft-shared";

import EmptyState from "../../components/ui/EmptyState";
import Tooltip from "../../components/ui/Tooltip";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { trackArtifactOpened, trackArtifactViewerAction } from "./artifactAnalytics";
import type { ArtifactOpenSource } from "./artifactAnalytics";
import { artifactCardSeed, prefetchArtifactContentDns } from "./artifactOpenIntent";
import { artifactUrl } from "./artifactLinks";
import type { ArtifactLinkTarget } from "./artifactLinks";
import { PHONE_QUERY } from "./artifactPhoneHistory";
import { useArtifactViewer } from "./artifactSource";
import { ArtifactLoadingArea, ArtifactSplashMetaPlaceholder, ArtifactSplashScope, ArtifactSplashTitlePlaceholder } from "./ArtifactLoadingSplash";
import { artifactHostOf, artifactOpenFocusReason, returnArtifactFocus, useArtifactViewerStore } from "./artifactViewerStore";
import type { ArtifactCommentsOpening } from "./artifactViewerStore";
import { ArtifactVersionBadge } from "./ArtifactMessageCard";
import { ArtifactMetaRow } from "./ArtifactMetaRow";
import { useHeadReadersWidth } from "./headReadersWidth";
import ArtifactScopeLabel from "./ArtifactScopeLabel";
import type { ArtifactCommentsReview } from "./ArtifactCommentsContext";
import { ArtifactShownFileProvider } from "./ArtifactShownFileProvider";
import { ArtifactSurfaceActions, ArtifactSurfaceMain, ArtifactSurfaceMeta, ArtifactSurfaceProvider, ArtifactSurfaceTitle, ArtifactSurfaceVersionTag, useArtifactSurface, useArtifactSurfaceKeyDown } from "./ArtifactSurface";
import type { PickVersion } from "./ArtifactVersionHistory";
import { HEAD_ACTION_GAP, HEAD_ACTION_WIDTH, PanelHeadChromeContext, PanelHeadLeadContext, RowExpandAction, RowRegionBody, shownOwnActions, useHeadWidth, useRowExpand, useRowInRow } from "../../components/layout/appPanelHead";
import { requestFocus } from "../../utils/focusRequest";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { useArtifactReview } from "./ArtifactReviewContext";
import { useArtifactFind, useArtifactFindBodyShortcut } from "./artifactFind";
import { offersForkInRaft } from "./artifactForkInRaft";
import { artifactOpenLabelId, openArtifactWindow } from "./artifactWindow";

interface ViewerChrome {
  expanded: boolean;
  /**
   * Covering the channel panel (a phone, a narrow panel): Back instead of
   * close, as Task v2's covering cards. On a phone it is the channel
   * header's, so the card draws none: one Back on screen.
   */
  covering: boolean;
  /**
   * Covering a page that has no header Back of its own for it (the Artifacts
   * home): the card's Back shows on a phone too.
   */
  ownBack?: boolean;
  onToggleExpanded?: () => void;
  onClose: () => void;
}

/**
 * The Artifact viewer: the Task v2 card in the channel's side column (F41),
 * on the DS panel parts: PanelHeader (title, version, where it lives and its
 * original message in the meta line; ⋯, expand, close) over the content.
 *
 * Focus moves into it when it opens and Escape closes it. While it loads,
 * the header is the card its opener showed (title, version, where it lives:
 * artifactCardSeed), so it reads at once and nothing moves when the data
 * arrives; opened with no card (a link, an address), loading and "can't
 * open" are the same labelled region, with nothing about the Artifact in it.
 *
 * A shell: what the reader can do here is ArtifactSurface's, the same parts
 * the Artifact's own page (ArtifactStandalonePage, every link) places, so
 * the two can't drift apart. This file decides only how they are laid out:
 * expand and close (Back where it covers its channel), the side column's
 * width, the header folding by the card's width (HeaderFoldContext: Comments
 * into ⋯), the comment list
 * beside or over the content as the card's width allows (`fit="measure"`), a
 * bottom sheet on a phone (`fit="sheet"`),
 * the phone's history entry (the
 * original message replaces it), focus back to the opener, the version shown
 * (this opening's own pick and Retry) and `review` / `landOn` from Activity.
 *
 * Content: see ArtifactContent (what renders where, and the security
 * boundary). Writes go through the data source (the API draft's routes).
 */
export default function ArtifactViewer({ target, source, opening, onOpenedMessage, onShowVersion, onShownTitle, review = null, landOn = null, comments = null, ...chrome }: ViewerChrome & {
  target: ArtifactLinkTarget;
  /** A review (S8) the comment list shows alone (its Activity row), and how to leave it (Show All). */
  review?: ArtifactCommentsReview | null;
  /** The comment it opens at (a comment's Activity row): ArtifactCommentsProvider's `landOn`. */
  landOn?: ArtifactCommentId | null;
  /** Opened on its comments (a message card's): ArtifactCommentsProvider's `listOn`. */
  comments?: ArtifactCommentsOpening | null;
  /** What it was opened from, for `artifact_opened`. */
  source: ArtifactOpenSource;
  /**
   * Which opening this is, where the viewer outlives its mount (the side
   * card: the viewer store keeps it open while the reader is in another
   * channel, and it mounts again on coming back).
   */
  opening?: number;
  /**
   * After its original message opened (ArtifactOriginLink). The side card
   * closes where it covers its channel, else it would hide the message.
   */
  onOpenedMessage?: () => void;
  /**
   * A version picked here (the version history, Back to Latest, View latest; null: the latest), where the host's
   * address says which is shown (`&version=`, replaced): the host's `target` then names it, which this opening
   * shows already.
   */
  onShowVersion?: (version: number | null) => void;
  /**
   * The title of the Artifact shown, once its viewer data has loaded (and as it is renamed), and null when it
   * goes: where the viewer is the page (the Artifacts home), for the tab's title. Never while it loads from the
   * opener's card, nor for one the reader can't open.
   */
  onShownTitle?: (title: string | null) => void;
}) {
  const { formatMessage } = useIntl();
  // The version shown: the version history's pick (null: the latest) and Retry's attempt, for
  // this opening only; a new target or opening (another link, the same Artifact again) drops them.
  const [shownState, setShownState] = useState<ShownVersion | null>(null);
  // The file shown (the Files panel's pick; null: the entry), for this viewer only: the address here
  // names the Artifact and its version, not a file, and the parent keys this component per Artifact.
  const [shownFile, setShownFile] = useState<string | null>(null);
  const shownHere = shownState && shownState.target === target && shownState.opening === opening ? shownState : null;
  const shownVersion = shownHere && shownHere.version !== undefined ? shownHere.version : target.version;
  const attempt = shownHere?.attempt ?? 0;
  const shownTarget = useMemo(() => ({ id: target.id, version: shownVersion }), [target.id, shownVersion]);
  const shownKey = `${shownVersion ?? "latest"}#${attempt}`;
  const result = useArtifactViewer(shownTarget, attempt);
  const data = result.status === "ok" ? result.data : null;
  const switching = result.status === "ok" && result.switching;
  const failed = result.status === "ok" && result.failed;
  const { onClose } = chrome;
  // The card the page already showed for what it opens: the header while the viewer data loads.
  const seed = useMemo(() => artifactCardSeed(target), [target]);
  const phone = useMediaQuery(PHONE_QUERY);
  // Shown: its frame will load from its content origin, so the connection opens now, beside the viewer read.
  useEffect(() => {
    prefetchArtifactContentDns(target.id);
  }, [target.id]);
  // One `artifact_opened` per opening, once it has loaded (the parent keys this by target).
  const openTracked = useRef(false);
  useEffect(() => {
    if (!data || openTracked.current) return;
    openTracked.current = true;
    trackArtifactOpened(data, source, phone ? "phone" : chrome.expanded ? "maximized" : "side", opening);
  }, [data, source, opening, phone, chrome.expanded]);
  // A pick (the version history, Back to Latest) is this opening's own: the surface tracks it and closes the sheet.
  const pickVersion = useCallback<PickVersion>((version) => {
    setShownState({ target, opening, version, attempt: 0 });
    onShowVersion?.(version);
  }, [target, opening, onShowVersion]);
  // View latest (a newer version's notice): the latest, read again even where it is already followed.
  const showLatest = useCallback(() => {
    setShownState({ target, opening, version: null, attempt: shownVersion === null ? attempt + 1 : 0 });
    onShowVersion?.(null);
  }, [target, opening, shownVersion, attempt, onShowVersion]);
  const retryVersion = useCallback(() => {
    setShownState({ target, opening, version: shownVersion, attempt: attempt + 1 });
  }, [target, opening, shownVersion, attempt]);

  // One frame for every state, so focus stays on it as the content loads; one loading splash from
  // the opening (or the version picked) until the page has loaded, whichever part is loading
  // (ArtifactLoadingSplash, #proj-workspace:#145).
  const splashKey = `${target.id}#${opening ?? ""}#${shownKey}`;
  const scoped = (viewer: ReactNode) => <ArtifactSplashScope openingKey={splashKey} size="side">{viewer}</ArtifactSplashScope>;
  if (!data && result.status === "loading" && seed) {
    return scoped(
      <ViewerFrame
        {...chrome}
        busy
        label={seed.title}
        artifactId={seed.id}
        title={<ViewerTitle card={seed} />}
        meta={<ArtifactMetaRow text={<ArtifactScopeLabel home={seed.home} fromAnotherServer={seed.fromAnotherServer} />} />}
      >
        <ViewerLoading kind={seed.kind} />
      </ViewerFrame>,
    );
  }
  if (!data) {
    const loading = result.status === "loading";
    return scoped(
      <ViewerFrame
        label={formatMessage({ id: "artifacts.viewer.regionLabel" })}
        busy={loading}
        // Nothing is known yet (a link, an address): still placeholders where the title and the meta line go.
        title={loading ? <ArtifactSplashTitlePlaceholder /> : undefined}
        meta={loading ? <ArtifactMetaRow text={<ArtifactSplashMetaPlaceholder />} /> : undefined}
        {...chrome}
      >
        {result.status === "unavailable" ? (
          // One state for no access, not found and deleted (F11): nothing
          // about the Artifact, not even that it exists.
          <div className="flex flex-1 items-center justify-center p-6" data-testid="artifact-viewer-unavailable">
            <EmptyState
              icon={<FileX size={36} />}
              title={formatMessage({ id: "artifacts.viewer.unavailableTitle" })}
              description={formatMessage({ id: "artifacts.viewer.unavailableBody" })}
            />
          </div>
        ) : <ViewerLoading kind={null} />}
      </ViewerFrame>,
    );
  }
  // What the server's answers to this viewer's writes changed (home, capabilities), over the
  // data they were made on: a write answered after a pick, or once another version loaded, is
  // dropped (the next version loads as it is: `shownKey`). The parent keys this component per Artifact.
  return scoped(
    <ArtifactShownFileProvider path={shownFile} onShow={setShownFile}>
    <ArtifactSurfaceProvider
      data={data}
      shownKey={shownKey}
      onDeleted={onClose}
      kind="viewer"
      phone={phone}
      // Wide, the list sits beside the content, pushing it aside; narrower than its room, over it.
      // On a phone a bottom sheet over the page, as on the Artifact's own page (xxchan, #proj-workspace:#119).
      fit={phone ? "sheet" : "measure"}
      onPickVersion={pickVersion}
      onShowLatest={showLatest}
      review={review}
      landOn={landOn}
      listOn={comments}
    >
      <LoadedViewer
        chrome={chrome}
        switching={switching}
        failedVersion={failed ? shownVersion ?? "latest" : null}
        onRetry={retryVersion}
        phone={phone}
        onOpenedMessage={onOpenedMessage}
        onShownTitle={onShownTitle}
      />
    </ArtifactSurfaceProvider>
    </ArtifactShownFileProvider>,
  );
}

/** The loaded viewer: the card's frame around the surface's parts. */
function LoadedViewer({ chrome, switching, failedVersion, onRetry, phone, onOpenedMessage, onShownTitle }: {
  chrome: ViewerChrome;
  switching: boolean;
  failedVersion: number | "latest" | null;
  onRetry: () => void;
  phone: boolean;
  onOpenedMessage?: () => void;
  onShownTitle?: (title: string | null) => void;
}) {
  const { data } = useArtifactSurface();
  const { card } = data;
  const shownTitleRef = useRef(onShownTitle);
  shownTitleRef.current = onShownTitle;
  useEffect(() => {
    shownTitleRef.current?.(card.title);
  }, [card.title]);
  useEffect(() => () => shownTitleRef.current?.(null), []);
  const openInNewPage = useCallback(() => {
    // Addresses are built from the id, never taken from the payload.
    openArtifactWindow(artifactUrl(card.id, card.pinned ? card.version : null), card.id);
  }, [card.id, card.pinned, card.version]);
  return (
    <ViewerFrame
      {...chrome}
      busy={switching}
      label={card.title}
      artifactId={card.id}
      onOpenInNewPage={openInNewPage}
      fork={offersForkInRaft(card)}
      actions={<ViewerActions />}
      title={<ViewerTitle card={card} title={<ArtifactSurfaceTitle testId="artifact-viewer-title" />} version={<ArtifactSurfaceVersionTag />} />}
      // On a phone the viewer is a page with its own history entry: the message takes its place.
      meta={<ViewerMeta replace={phone} onOpened={onOpenedMessage} />}
    >
      <ArtifactSurfaceMain switching={switching} failedVersion={failedVersion} onRetry={onRetry} />
    </ViewerFrame>
  );
}

/**
 * The header's title and version, from the viewer data or, while it loads, the opener's card
 * (`title`: the surface's, which a reader who may publish edits in place; `version`: the
 * surface's tag, which switches versions; else the plain title and tag).
 */
function ViewerTitle({ card, title, version }: { card: Pick<ArtifactCard, "title" | "version">; title?: ReactNode; version?: ReactNode }) {
  return (
    <>
      {title ?? <PanelTitle data-testid="artifact-viewer-title">{card.title}</PanelTitle>}
      <PanelStatus>{version ?? <ArtifactVersionBadge version={card.version} />}</PanelStatus>
    </>
  );
}

/**
 * The content while the viewer data loads (stage 0): the opening's loading splash, the same cover the
 * frame keeps while it locates and starts (ArtifactFrame), so nothing changes between them. The kind
 * from the opener's card where there is one.
 */
function ViewerLoading({ kind }: { kind: ArtifactCard["kind"] | null }) {
  return <ArtifactLoadingArea kind={kind} testId="artifact-viewer-loading" />;
}

/** The version history's pick, for the opening it was made in (`version` undefined: as opened). */
interface ShownVersion {
  target: ArtifactLinkTarget;
  opening: number | undefined;
  version: number | null | undefined;
  attempt: number;
}

/**
 * How the header gives way as the card narrows (raft-design patterns/
 * responsive.md, When a row runs out of room): the title keeps its room, so
 * Comments goes into the ⋯ menu, and Fork in Raft (another server's public
 * Artifact) becomes its first item. Expand never does: it changes the view
 * itself, so it stays one press away at any width (stdrc, #proj-raft-ui:#179).
 * Open in New Page stays until a column of the row has no room left for it
 * (#189 rule 6: it folds like the head's other own actions, the last to).
 * Decided on the card's own width, not the window's: the ⋯ menu's content is
 * in a portal, out of a container query's reach, so the card is measured.
 */
/** Fork in Raft's labelled `md` Button in the head (its longest label, es / pt-br, about this). */
const FORK_WIDTH = 120;
const HEADER_ACTIONS_MIN_WIDTH = 440;

interface HeaderFold {
  /** Comments and Fork in Raft in the ⋯ menu (Expand stays in the header). */
  actions: boolean;
  /** The comment controls in ⋯, comment mode's or the Comments toggle (#189 rule 6: own actions fold, the last first). */
  review?: boolean;
  /** Find in page in ⋯ (after the comment controls, before Fork in Raft). */
  find?: boolean;
  /** Open in New Page in ⋯ (it folds last, the visibility chip with it; ⋯, Expand and Close never do). */
  openInNewPage?: boolean;
  /** Fork in Raft in ⋯ (the last own action: it folds first). */
  fork?: boolean;
  expanded: boolean;
  onToggleExpanded?: () => void;
}

const HeaderFoldContext = createContext<HeaderFold>({ actions: false, expanded: false });

/** The card's width, 0 until measured (and where there is no layout). */
function useWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const update = () => setWidth(Math.round(element.getBoundingClientRect().width));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/**
 * The head's own actions' widths, in its order: Open in New Page, then comment mode's controls (the Comment button
 * and its ▾, with Continue / Submit N / Retry where shown) or, where comment mode isn't offered, the Comments toggle.
 * `comments`: there is a comment control (comment mode's folds as one into ⋯ items). Then Find in page where the
 * page may be searched (`find`), then Fork in Raft, where offered.
 */
function useViewerHeadOwn(openInNewPage: boolean, fork: boolean): { widths: number[]; comments: boolean; find: boolean } {
  const review = useArtifactReview();
  const comments = useArtifactComments();
  const find = useArtifactFind()?.offered ?? false;
  const offered = review?.canComment ?? false;
  const extra = offered && (review?.draftsFailed || review?.draftCount) ? 1 : 0;
  const widths = useMemo(() => {
    const list: number[] = openInNewPage ? [HEAD_ACTION_WIDTH] : [];
    if (offered) list.push(HEAD_ACTION_WIDTH + 20 + extra * (56 + HEAD_ACTION_GAP));
    else if (comments) list.push(HEAD_ACTION_WIDTH);
    if (find) list.push(HEAD_ACTION_WIDTH);
    if (fork) list.push(FORK_WIDTH);
    return list;
  }, [comments, extra, find, fork, offered, openInNewPage]);
  return { widths, comments: offered || comments !== null, find };
}

/** The surface's header actions, folded as the card's width says. */
function ViewerActions() {
  const fold = useContext(HeaderFoldContext);
  return <ArtifactSurfaceActions compact={fold.actions} commentsInMenu={fold.actions || !!fold.review} copyLinkHere={false} reviewInMenu={fold.review} openInNewPageInMenu={fold.openInNewPage} findInMenuHere={fold.find} forkInMenuHere={fold.fork} scopeInMenu={fold.openInNewPage} />;
}

/** The surface's meta line, its visibility chip folded into ⋯ with Open in New Page (#189 rule 6). */
function ViewerMeta({ replace, onOpened }: { replace: boolean; onOpened?: () => void }) {
  return <ArtifactSurfaceMeta replace={replace} onOpened={onOpened} scopeInMenu={useContext(HeaderFoldContext).openInNewPage} />;
}

/** The panel, its header and the shared actions (expand, close); Escape closes. */
function ViewerFrame({
  label,
  busy = false,
  title,
  meta,
  actions,
  expanded,
  covering,
  ownBack = false,
  onToggleExpanded,
  onClose,
  children,
  artifactId,
  onOpenInNewPage,
  fork = false,
}: ViewerChrome & {
  label: string;
  busy?: boolean;
  title?: ReactNode;
  meta?: ReactNode;
  /** The surface's header actions (ArtifactSurfaceActions), before Open in New Page, Expand and close. */
  actions?: ReactNode;
  /** Opens the Artifact on its own page (a new tab); a header button beside Expand, not in ⋯. */
  onOpenInNewPage?: () => void;
  /** The actions hold Fork in Raft (another server's public Artifact): the head's last own action. */
  fork?: boolean;
  artifactId?: string;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const closeLabel = formatMessage({ id: "artifacts.viewer.close" });
  const expandLabel = formatMessage({ id: expanded ? "artifacts.viewer.restore" : "artifacts.viewer.expand" });
  const openInNewPageLabel = formatMessage({ id: artifactOpenLabelId("artifacts.card.openInNewPage") });
  // A section of the planned row (#189, the side area's RowRegionChrome): the grip that moves it (rule 7), and where
  // its column holds the columns the row couldn't give 160, their tabs in place of its title (rule 4).
  const chrome = useContext(PanelHeadChromeContext);
  const rowTabs = chrome?.tabs ?? null;
  // The side window's switch chip while the built-in browser is open behind this Artifact (Raft Desktop,
  // desktop_web_preview_view_v0); null everywhere else, and the head is as it is without it.
  const lead = useContext(PanelHeadLeadContext);
  // A column of the planned row (#189): its Expand is the row's (rule 5), not the viewer's own.
  const inRow = useRowInRow("artifact");
  // Focus moves in when the viewer opens, and back to the card that opened
  // it when it closes (not when it switches to another Artifact).
  const panelRef = useRef<HTMLElement | null>(null);
  const [panelElement, setPanelElement] = useState<HTMLElement | null>(null);
  const setPanel = useCallback((element: HTMLElement | null) => {
    panelRef.current = element;
    setPanelElement(element);
  }, []);
  const width = useWidth(panelElement);
  const foldActions = width > 0 && width < HEADER_ACTIONS_MIN_WIDTH;
  // Expanding (not restoring) is `maximize`.
  const toggleExpanded = useMemo(() => (onToggleExpanded ? () => {
    if (!expanded) trackArtifactViewerAction("maximize");
    onToggleExpanded();
  } : undefined), [expanded, onToggleExpanded]);
  const trackMaximize = useCallback(() => trackArtifactViewerAction("maximize"), []);
  // The head always fits its column (#189 rule 6, as headFit): past the title's room its own actions fold into ⋯, the
  // last first (comment mode's controls, then Open in New Page); ⋯, Expand and Close never fold.
  const [measureHead, headWidth, headElement] = useHeadWidth();
  const readersWidth = useHeadReadersWidth(headElement);
  const headOwn = useViewerHeadOwn(!!onOpenInNewPage, fork);
  const rowExpand = useRowExpand("artifact");
  const ownShown = shownOwnActions({
    width: headWidth,
    lead: covering ? 1 : 0,
    own: headOwn.widths,
    controls: (inRow ? (rowExpand.shown ? 1 : 0) : toggleExpanded ? 1 : 0) + (covering ? 0 : 1),
    menuItems: 1,
    content: readersWidth,
    leadWidth: lead?.width,
  });
  // In the head's order: Open in New Page, the comment controls, Find in page, Fork in Raft; the last folds first.
  const ownCount = headOwn.widths.length;
  const foldFork = fork && ownShown < ownCount;
  const foldFind = headOwn.find && ownShown < ownCount - (fork ? 1 : 0);
  const foldReview = headOwn.comments && ownShown < ownCount - (fork ? 1 : 0) - (headOwn.find ? 1 : 0);
  const foldOpen = !!onOpenInNewPage && ownShown === 0;
  const fold = useMemo<HeaderFold>(
    () => ({ actions: foldActions, review: foldReview, openInNewPage: foldOpen, find: foldFind, fork: foldFork, expanded, onToggleExpanded: toggleExpanded }),
    [expanded, foldActions, foldFind, foldFork, foldOpen, foldReview, toggleExpanded],
  );
  useEffect(() => {
    // Maybe well after the press that opened it (the viewer's chunk downloading): focus the person put in a text field
    // or a dialog meanwhile stays there (focus plan rule 2: artifactOpenFocusReason).
    requestFocus(() => panelRef.current, { reason: artifactOpenFocusReason() });
    // The channel panel it is in (or open beside), for when the opener can't take focus back.
    const host = artifactHostOf(panelRef.current, useArtifactViewerStore.getState().open?.conversationId);
    return () => {
      if (useArtifactViewerStore.getState().open === null) returnArtifactFocus(host);
    };
  }, []);
  // The surface's Esc (a comment's card, the list, comment mode); anything else closes the viewer.
  const handleKeyDown = useArtifactSurfaceKeyDown(onClose);
  // Cmd/Ctrl+F with the focus fallen to the body, the viewer having had it last: the find bar's too.
  useArtifactFindBodyShortcut(panelElement);
  return (
    <HeaderFoldContext.Provider value={fold}>
    <Panel
      ref={setPanel}
      edge="inset"
      aria-label={label}
      aria-busy={busy || undefined}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="flex size-full min-h-0 flex-col outline-none keyboard:focus-visible:outline-2 keyboard:focus-visible:outline-solid keyboard:focus-visible:-outline-offset-2 keyboard:focus-visible:outline-foreground"
      data-testid="artifact-viewer"
      data-side-card-focus=""
      data-artifact-focus=""
      data-artifact-id={artifactId}
    >
      {/* The panel head every column has, as Task v2's sections
          (ChannelSideCard): PanelHeader, 56px with a seam under it and the
          20px margin, so stacked above Tasks and Files its title and buttons
          line up with theirs. Covering, the Back comes first (on a phone the
          channel header's Back stands for it). */}
      <PanelHeader data-testid="artifact-viewer-header" {...(covering ? null : chrome?.props)} ref={measureHead}>
        {covering ? (
          // A narrow desktop panel has no header Back, so the card keeps its
          // own, labelled as the close it stands for (Task v2's ChannelSideCard).
          <PanelAction aria-label={closeLabel} onClick={onClose} className={ownBack ? undefined : "max-md:hidden"} data-testid="artifact-viewer-back">
            <ArrowLeft />
          </PanelAction>
        ) : null}
        {lead?.node}
        <PanelHeaderContent className="@container">
          {rowTabs ?? (title ? <PanelHeading>{title}</PanelHeading> : null)}
          {/* The line under the title (ArtifactMetaRow): it holds its own PanelMeta, the readers beside it. */}
          {rowTabs ? null : meta}
          {/* Absolute along the head's top edge: not one of the head's first or last controls. */}
          {covering ? null : chrome?.grip}
        </PanelHeaderContent>
        <PanelActions data-testid="artifact-viewer-actions">
          {/* Open in New Page first among the viewer's own actions, before ⋯
              (raft-design panel.md, Rules); where the column has no room it
              folds into ⋯ like the others, the last to (#189 rule 6). Expand
              is a window control, right before Close, never in ⋯ (stdrc,
              2026-11-03). A phone has neither: the viewer is the whole screen
              there, and ⋯ keeps Open in New Page. */}
          {onOpenInNewPage && !foldOpen ? (
            <Tooltip content={openInNewPageLabel}>
              <PanelAction
                aria-label={openInNewPageLabel}
                onClick={onOpenInNewPage}
                data-testid="artifact-viewer-open-in-new-page"
                className="max-md:hidden"
              >
                <ArrowUpRight />
              </PanelAction>
            </Tooltip>
          ) : null}
          {actions}
          {inRow ? <RowExpandAction region="artifact" testId="artifact-viewer-expand" onExpand={trackMaximize} /> : toggleExpanded ? (
            <Tooltip content={expandLabel}>
              <PanelToggleAction
                aria-label={expandLabel}
                pressed={expanded}
                onPressedChange={toggleExpanded}
                data-testid="artifact-viewer-expand"
                className="max-md:hidden"
              >
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </PanelToggleAction>
            </Tooltip>
          ) : null}
          {covering ? null : (
            <Tooltip content={closeLabel}>
              <PanelAction aria-label={closeLabel} onClick={onClose} data-testid="artifact-viewer-close">
                <X />
              </PanelAction>
            </Tooltip>
          )}
        </PanelActions>
      </PanelHeader>
      {/* Hidden while a region expanded in its column shows the viewer as its head alone (#189 rule 5). */}
      <RowRegionBody>{children}</RowRegionBody>
    </Panel>
    </HeaderFoldContext.Provider>
  );
}

