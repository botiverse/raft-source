import { createContext, useCallback, useContext, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, FileX, Maximize2, Minimize2, PanelsTopLeft, X } from "lucide-react";
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
import { trackArtifactOpened, trackArtifactViewerAction } from "./artifactAnalytics";
import type { ArtifactOpenSource } from "./artifactAnalytics";
import { artifactCardSeed, prefetchArtifactContentDns } from "./artifactOpenIntent";
import type { ArtifactLinkTarget } from "./artifactLinks";
import { useArtifactPhoneLayout } from "./artifactPhoneLayout";
import { useArtifactViewer } from "./artifactSource";
import { ArtifactLoadingArea, ArtifactSplashMetaPlaceholder, ArtifactSplashScope, ArtifactSplashTitlePlaceholder } from "./ArtifactLoadingSplash";
import { artifactHostOf, artifactOpenFocusReason, returnArtifactFocus, useArtifactViewerStore } from "./artifactViewerStore";
import type { ArtifactCommentsOpening } from "./artifactViewerStore";
import { ArtifactVersionBadge } from "./ArtifactMessageCard";
import { ArtifactMetaRow } from "./ArtifactMetaRow";
import { useHeadReadersWidth } from "./headReadersWidth";
import { ArtifactRecentTitle } from "./ArtifactRecentTitle";
import { useRecentTitleExtraWidth } from "./artifactRecentConversation";
import { ArtifactShownFilePath } from "./ArtifactShownFilePath";
import ArtifactScopeLabel from "./ArtifactScopeLabel";
import type { ArtifactCommentsReview } from "./ArtifactCommentsContext";
import { ArtifactShownFileProvider } from "./ArtifactShownFileProvider";
import { ArtifactSurfaceActions, ArtifactSurfaceMain, ArtifactSurfaceProvider, useArtifactSurface, useArtifactSurfaceKeyDown } from "./ArtifactSurface";
import { ArtifactSurfaceMeta, ArtifactSurfaceTitle, ArtifactSurfaceVersionTag } from "./ArtifactSurfaceHead";
import { ArtifactDetailsTitle } from "./ArtifactDetailsTitle";
import type { PickVersion } from "./ArtifactVersionHistory";
import { HEAD_ACTION_GAP, HEAD_ACTION_WIDTH, PanelHeadChromeContext, PanelHeadLeadContext, RowExpandAction, RowRegionBody, shownOwnActions, useHeadWidth, useRowExpand, useRowInRow } from "../../components/layout/appPanelHead";
import { requestFocus } from "../../utils/focusRequest";
import { resizeObserverOf } from "../../utils/ownerDocument";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { useArtifactReview } from "./ArtifactReviewContext";
import { useArtifactFind, useArtifactFindBodyShortcut } from "./artifactFind";
import { offersForkInRaft } from "./artifactForkInRaft";
import { WINDOW_TITLE_BAR } from "./artifactWindowTitleBar";
import { ArtifactMessageOpeningContext } from "./useArtifactBacklinks";

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
  /** The whole page of an Artifact's object window (ArtifactWindowChrome), not a card of the main window. */
  inWindow?: ArtifactWindowChrome | null;
}

/**
 * The viewer as an Artifact's object window (#337 PR3, ArtifactObjectWindow.tsx; VS Code's auxiliary window): its
 * head is the window's title bar, one slim row marked `data-raft-titlebar` (titleBar.css pads it clear of the macOS
 * traffic lights or the Windows / Linux caption buttons, from the object window's own frame, objectWindowChrome.ts,
 * and makes it the drag region; its controls stay pressable), with the title, the version, the surface's actions,
 * Copy link (a button: the window has room for it), ⋯ (ArtifactViewerMenu: Open in system browser in place of Open
 * in new page) and Open in main window where Expand and Close are (the window's own close or ⌘W closes it, never
 * Esc, whose other meanings stay: a menu, the find bar, a card, comment mode). Laid out as on
 * a desktop at every window width (the comment list over the page where the window is narrow), never as on a phone:
 * the phone's history entry and sheets are the main window's. Focus moves in as it opens; giving it back when the
 * window closes is the object window's (to the row that opened it), never the main viewer's.
 */
export interface ArtifactWindowChrome {
  /** Open in main window: the main window's viewer shows this Artifact, and this window closes. */
  onOpenInMain: () => void;
}

/**
 * The Artifact viewer: the Task v2 card in the channel's side column (F41),
 * on the DS panel parts: PanelHeader over the content. On a desktop the head
 * is one line at the row's shared height (#proj-workspace, variant D): the
 * title, which opens the details (ArtifactDetailsTitle: where it lives, its
 * original message, versions, who's seen it, the recent Artifacts), the
 * version tag, then a fixed set of buttons by the page shown: the comment
 * control (ArtifactReviewHeaderActions), Find in page, ⋯ (Open in New Page
 * its first item), Expand, close. On a phone it keeps its two lines (the meta
 * line under the title) and its fold.
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
 * width, a phone's header folding by the card's width (HeaderFoldContext:
 * Comments into ⋯), the comment list
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
   * opener's card; null for one the reader can't open.
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
  // An object window is a desktop's at every width (ArtifactWindowChrome, useArtifactPhoneLayout).
  const phone = useArtifactPhoneLayout();
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
        phone={phone}
        title={<ViewerTitle card={seed} />}
        // A desktop head is one line (the details are its title's, once loaded); a phone's has the line under it.
        meta={phone ? <ArtifactMetaRow text={<ArtifactScopeLabel home={seed.home} fromAnotherServer={seed.fromAnotherServer} />} /> : null}
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
        phone={phone}
        title={loading ? <ArtifactSplashTitlePlaceholder /> : undefined}
        meta={loading && phone ? <ArtifactMetaRow text={<ArtifactSplashMetaPlaceholder />} /> : undefined}
        {...chrome}
      >
        {result.status === "unavailable" ? (
          // One state for no access, not found and deleted (F11): nothing
          // about the Artifact, not even that it exists.
          <div className="flex flex-1 items-center justify-center p-6" data-testid="artifact-viewer-unavailable">
            <NamesNothing onShownTitle={onShownTitle} />
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

/** One the reader can't open names nothing (`onShownTitle(null)`, as it shows): the host's own name, not the last Artifact's. */
function NamesNothing({ onShownTitle }: { onShownTitle?: (title: string | null) => void }) {
  const namesNothing = useEffectEvent(() => onShownTitle?.(null));
  useEffect(() => {
    namesNothing();
  }, []);
  return null;
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
  const messageOpening = useMemo(() => ({ replace: phone, onOpened: onOpenedMessage }), [phone, onOpenedMessage]);
  return (
    <ViewerFrame
      {...chrome}
      phone={phone}
      busy={switching}
      label={card.title}
      artifactId={card.id}
      fork={offersForkInRaft(card)}
      actions={<ViewerActions copyLinkHere={!!chrome.inWindow} />}
      title={phone ? (
        <ViewerTitle card={card} record title={<ArtifactSurfaceTitle testId="artifact-viewer-title" />} after={<ArtifactShownFilePath data={data} />} version={<ArtifactSurfaceVersionTag />} />
      ) : (
        // One line: the title opens the details, where the meta line's parts are.
        <>
          <ArtifactDetailsTitle testId="artifact-viewer-title" onOpenedMessage={onOpenedMessage} />
          <PanelStatus><ArtifactSurfaceVersionTag /></PanelStatus>
        </>
      )}
      // On a phone the viewer is a page with its own history entry: the message takes its place.
      meta={phone ? <ViewerMeta replace onOpened={onOpenedMessage} /> : null}
    >
      {/* "Linked from"'s discussions open as the original message does here (#proj-workspace:#336 step 2). */}
      <ArtifactMessageOpeningContext.Provider value={messageOpening}>
        <ArtifactSurfaceMain switching={switching} failedVersion={failedVersion} onRetry={onRetry} />
      </ArtifactMessageOpeningContext.Provider>
    </ViewerFrame>
  );
}

/**
 * The header's title and version (a phone's; a desktop's loaded one is ArtifactDetailsTitle), from the viewer data or,
 * while it loads, the opener's card
 * (`title`: the surface's own title; `version`: the
 * surface's tag, which switches versions; else the plain title and tag). Beside a conversation
 * the title may be the menu of the Artifacts recently opened there (ArtifactRecentTitle; `record`:
 * loaded, so this one joins them; `after`: what follows that trigger, the file shown).
 */
function ViewerTitle({ card, title, version, record = false, after }: { card: Pick<ArtifactCard, "id" | "title" | "version">; title?: ReactNode; version?: ReactNode; record?: boolean; after?: ReactNode }) {
  return (
    <>
      <ArtifactRecentTitle card={card} record={record} after={after} plain={title ?? <PanelTitle data-testid="artifact-viewer-title">{card.title}</PanelTitle>} />
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
 * How the header gives way as the card narrows. On a desktop it doesn't: the
 * head is one line with a fixed set of buttons by the page shown (the comment
 * control, Find in page, ⋯, Expand, close; #proj-workspace, variant D), the
 * same at every column width, so a button is always where it was; only Fork in
 * Raft (another server's public Artifact, a labelled button) goes into ⋯ in a
 * column under 440px, so a long label never squeezes the title.
 *
 * A phone's head keeps today's fold (raft-design patterns/responsive.md, When
 * a row runs out of room; #189 rule 6, headFit): the title keeps its room, so
 * Comments goes into the ⋯ menu, the last own action first, the visibility
 * chip with the last. Expand never does: it changes the view itself, so it
 * stays one press away at any width (stdrc, #proj-raft-ui:#179). Decided on
 * the card's own width, not the window's: the ⋯ menu's content is in a
 * portal, out of a container query's reach, so the card is measured.
 */
/** Fork in Raft's labelled `md` Button in the head (its longest label, es / pt-br, about this). */
const FORK_WIDTH = 120;
const HEADER_ACTIONS_MIN_WIDTH = 440;

interface HeaderFold {
  /** A phone's compact head: Find in page, the Comments toggle and Fork in Raft in the ⋯ menu (Expand stays). */
  actions: boolean;
  /** A phone's comment controls in ⋯, comment mode's or the Comments toggle (#189 rule 6: own actions fold, the last first). */
  review?: boolean;
  /** A phone's Find in page in ⋯ (after the comment controls, before Fork in Raft). */
  find?: boolean;
  /** A phone's visibility chip in ⋯ (where none of its own actions fit). */
  scope?: boolean;
  /** Fork in Raft in ⋯ (the last own action: it folds first; on a desktop, under 440px). */
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
    // The element's own window's observer (an object window's, #337 PR3).
    const Observer = resizeObserverOf(element);
    if (!Observer) return;
    const observer = new Observer(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/**
 * A phone's head's own actions' widths, in its order: the slot Open in New Page had (its fold is as it was: the
 * phone's head never showed the button, ⋯ has it), then comment mode's controls (the Comment button and its ▾, with
 * Retry where shown) or, where comment mode isn't offered, the Comments toggle. `comments`: there is a comment control
 * (comment mode's folds as one into ⋯ items). Then Find in page where the page may be searched (`find`), then Fork in
 * Raft, where offered.
 */
function useViewerHeadOwn(phone: boolean, fork: boolean): { widths: number[]; comments: boolean; find: boolean } {
  const review = useArtifactReview();
  const comments = useArtifactComments();
  const find = useArtifactFind()?.offered ?? false;
  const offered = review?.canComment ?? false;
  const extra = offered && (review?.draftsFailed || review?.draftCount) ? 1 : 0;
  const widths = useMemo(() => {
    const list: number[] = phone ? [HEAD_ACTION_WIDTH] : [];
    if (offered) list.push(HEAD_ACTION_WIDTH + 20 + extra * (56 + HEAD_ACTION_GAP));
    else if (comments) list.push(HEAD_ACTION_WIDTH);
    if (find) list.push(HEAD_ACTION_WIDTH);
    if (fork) list.push(FORK_WIDTH);
    return list;
  }, [comments, extra, find, fork, offered, phone]);
  return { widths, comments: offered || comments !== null, find };
}

/** The surface's header actions: a desktop's fixed set, a phone's folded as the card's width says; Copy link a button in an object window. */
function ViewerActions({ copyLinkHere }: { copyLinkHere: boolean }) {
  const fold = useContext(HeaderFoldContext);
  return <ArtifactSurfaceActions compact={fold.actions} commentsInMenu={fold.actions || !!fold.review} copyLinkHere={copyLinkHere} reviewInMenu={fold.review} findInMenuHere={fold.find} forkInMenuHere={fold.fork} scopeInMenu={fold.scope} />;
}

/** A phone's meta line, its visibility chip folded into ⋯ where none of the head's own actions fit (#189 rule 6). */
function ViewerMeta({ replace, onOpened }: { replace: boolean; onOpened?: () => void }) {
  return <ArtifactSurfaceMeta replace={replace} onOpened={onOpened} scopeInMenu={useContext(HeaderFoldContext).scope} />;
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
  phone = false,
  fork = false,
  inWindow = null,
}: ViewerChrome & {
  label: string;
  busy?: boolean;
  title?: ReactNode;
  meta?: ReactNode;
  /** The surface's header actions (ArtifactSurfaceActions), before Expand and close. */
  actions?: ReactNode;
  /** Laid out as on a phone: the head keeps its two lines and its fold. */
  phone?: boolean;
  /** The actions hold Fork in Raft (another server's public Artifact): the head's last own action. */
  fork?: boolean;
  artifactId?: string;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const closeLabel = formatMessage({ id: "artifacts.viewer.close" });
  const expandLabel = formatMessage({ id: expanded ? "artifacts.viewer.restore" : "artifacts.viewer.expand" });
  const openInMainLabel = formatMessage({ id: "artifacts.window.openInMain" });
  // A section of the planned row (#189, the side area's RowRegionChrome): the grip that moves it (rule 7), and where
  // its column holds the columns the row couldn't give 160, their tabs in place of its title (rule 4).
  const chrome = useContext(PanelHeadChromeContext);
  const rowTabs = chrome?.tabs ?? null;
  // The side window's switch chip while the built-in browser is open behind this Artifact (Raft Desktop,
  // desktop_web_preview_view_v0); null everywhere else, and the head is as it is without it.
  const lead = useContext(PanelHeadLeadContext);
  // A column of the planned row (#189): its Expand is the row's (rule 5), not the viewer's own. An object window's
  // viewer is in no row (the main window's plan is about the main window).
  const inRow = useRowInRow("artifact") && !inWindow;
  // Focus moves in when the viewer opens, and back to the card that opened
  // it when it closes (not when it switches to another Artifact).
  const panelRef = useRef<HTMLElement | null>(null);
  const [panelElement, setPanelElement] = useState<HTMLElement | null>(null);
  const setPanel = useCallback((element: HTMLElement | null) => {
    panelRef.current = element;
    setPanelElement(element);
  }, []);
  const width = useWidth(panelElement);
  const narrow = width > 0 && width < HEADER_ACTIONS_MIN_WIDTH;
  // Expanding (not restoring) is `maximize`.
  const toggleExpanded = useMemo(() => (onToggleExpanded ? () => {
    if (!expanded) trackArtifactViewerAction("maximize");
    onToggleExpanded();
  } : undefined), [expanded, onToggleExpanded]);
  const trackMaximize = useCallback(() => trackArtifactViewerAction("maximize"), []);
  // A phone's head always fits its column (#189 rule 6, as headFit): past the title's room its own actions fold into
  // ⋯, the last first; ⋯, Expand and Close never fold. Measured on a phone only: a desktop's set is fixed.
  const [measureHead, headWidth, headElement] = useHeadWidth();
  // The readers beside the title, and the title as the recent Artifacts' trigger (its chevron), are room it needs.
  const readersWidth = useHeadReadersWidth(phone ? headElement : null) + useRecentTitleExtraWidth();
  const headOwn = useViewerHeadOwn(phone, fork);
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
  // In a phone's head's order: Open in New Page's slot, the comment controls, Find in page, Fork in Raft; the last folds first.
  const ownCount = headOwn.widths.length;
  const foldFork = fork && ownShown < ownCount;
  const foldFind = headOwn.find && ownShown < ownCount - (fork ? 1 : 0);
  const foldReview = headOwn.comments && ownShown < ownCount - (fork ? 1 : 0) - (headOwn.find ? 1 : 0);
  const foldScope = ownShown === 0;
  const fold = useMemo<HeaderFold>(
    () => (phone
      ? { actions: narrow, review: foldReview, scope: foldScope, find: foldFind, fork: foldFork, expanded, onToggleExpanded: toggleExpanded }
      : { actions: false, fork: fork && narrow, expanded, onToggleExpanded: toggleExpanded }),
    [expanded, fork, foldFind, foldFork, foldReview, foldScope, narrow, phone, toggleExpanded],
  );
  const windowed = inWindow !== null;
  useEffect(() => {
    // Maybe well after the press that opened it (the viewer's chunk downloading): focus the person put in a text field
    // or a dialog meanwhile stays there (focus plan rule 2: artifactOpenFocusReason).
    requestFocus(() => panelRef.current, { reason: artifactOpenFocusReason() });
    // An object window gives focus back itself, in the main window (features/objectWindows: to its opener).
    if (windowed) return;
    // The channel panel it is in (or open beside), for when the opener can't take focus back.
    const host = artifactHostOf(panelRef.current, useArtifactViewerStore.getState().open?.conversationId);
    return () => {
      if (useArtifactViewerStore.getState().open === null) returnArtifactFocus(host);
    };
  }, [windowed]);
  // The surface's Esc (a comment's card, the list, comment mode); anything else closes the viewer.
  // An object window is not closed by Esc (Kirby: easy to hit by accident, and VS Code's auxiliary windows aren't):
  // its own close and ⌘W close it; Esc keeps its other meanings there (menus, the find bar, a card, comment mode).
  const handleKeyDown = useArtifactSurfaceKeyDown(windowed ? undefined : onClose);
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
          (ChannelSideCard): PanelHeader with a seam under it, so stacked above
          Tasks and Files, and beside the conversation in the row, its title,
          buttons and seam line up with theirs. Covering, the Back comes first (on a phone the
          channel header's Back stands for it). */}
      <PanelHeader data-testid="artifact-viewer-header" {...(covering ? null : chrome?.props)} {...(windowed ? WINDOW_TITLE_BAR : null)} ref={measureHead}>
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
          {/* A phone's line under the title (ArtifactMetaRow): it holds its own PanelMeta, the readers beside it. A
              desktop head has none: one line, at the row's shared height, its title opening the details. */}
          {rowTabs ? null : meta}
          {/* Absolute along the head's top edge: not one of the head's first or last controls. */}
          {covering ? null : chrome?.grip}
        </PanelHeaderContent>
        <PanelActions data-testid="artifact-viewer-actions">
          {/* The viewer's own actions, then ⋯ (Open in New Page is its first item: raft-design panel.md's order, the
              head's one-line set). Expand is a window control, right before Close, never in ⋯ (stdrc, 2026-11-03).
              A phone has no Expand: the viewer is the whole screen there. */}
          {actions}
          {inWindow ? (
            // Where Expand and Close are: the window's own close closes it (ArtifactWindowChrome).
            <Tooltip content={openInMainLabel}>
              <PanelAction aria-label={openInMainLabel} onClick={inWindow.onOpenInMain} data-testid="artifact-window-open-in-main">
                <PanelsTopLeft />
              </PanelAction>
            </Tooltip>
          ) : inRow ? <RowExpandAction region="artifact" testId="artifact-viewer-expand" onExpand={trackMaximize} /> : toggleExpanded ? (
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
          {covering || windowed ? null : (
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

