import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft } from "lucide-react";
import {
  Panel,
  PanelAction,
  PanelActions,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelStatus,
} from "@botiverse/raft-ui";

import { hostMenuItems, isChromeless, isHostShell, markHostToolbarDrawn } from "../../embed";
import Tooltip from "../../components/ui/Tooltip";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useArtifactPageDocumentTitle } from "../../utils/browserDocumentTitle";
import { trackArtifactOpened } from "./artifactAnalytics";
import { useArtifactFindBodyShortcut } from "./artifactFind";
import { offersForkInRaft, useArtifactForkMarker } from "./artifactForkInRaft";
import { usePageFile } from "./artifactPageFile";
import { artifactHashForPanel, artifactPageOpening, artifactPanelFromHash, isArtifactHostActionHash } from "./artifactPageOpening";
import type { ArtifactPageOpening, ArtifactPagePanel } from "./artifactPageOpening";
import type { ArtifactHome } from "@botiverse/raft-shared";

import type { ArtifactLinkTarget } from "./artifactLinks";
import { PHONE_QUERY } from "./artifactPhoneHistory";
import { useArtifactViewer } from "./artifactSource";
import type { ArtifactViewerSeed } from "./artifactSource";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { ArtifactLoadingSplash, ArtifactSplashScope } from "./ArtifactLoadingSplash";
import { ArtifactHostBack, ArtifactPageLoadingLayout } from "./ArtifactLinkLoading";
import { HOST_TOOLBAR_ROOM } from "./artifactHostToolbar";
import { artifactLinkWaitStarted } from "./artifactLinkWait";
import { conversationLabel } from "./artifactHomeWords";
import { isPlainPrimaryClick } from "./openArtifactInPlace";
import { ArtifactShownFileProvider } from "./ArtifactShownFileProvider";
import { ArtifactSurfaceActions, ArtifactSurfaceMain, ArtifactSurfaceMeta, ArtifactSurfaceProvider, ArtifactSurfaceTitle, ArtifactSurfaceVersionTag, useArtifactSurface, useArtifactSurfaceKeyDown } from "./ArtifactSurface";
import type { PickVersion } from "./ArtifactVersionHistory";

/** The server the page is in: the one `open` named, which decides what the reader may do. */
export interface ArtifactStandaloneServer {
  slug: string;
  name: string;
}

export interface ArtifactStandalonePageProps {
  /** The link's Artifact, at its pinned version (`/v/<n>`) or the latest. */
  target: ArtifactLinkTarget;
  server: ArtifactStandaloneServer;
  /**
   * The viewer data the host already has for `target` (the canonical link's
   * `open`): the first screen draws from it instead of reading the viewer,
   * once (useArtifactViewer). Another version, a remount and Retry read.
   */
  seed?: ArtifactViewerSeed | null;
  /**
   * Back to the page in Raft this one was opened from (history back), when
   * there is one (the app's own navigation stack, useHasInAppPageBehind);
   * none for a link opened from outside Raft, a new tab or after a reload.
   */
  onGoBack?: () => void;
  /** Go to an address in Raft (a new history entry): the Artifact's home conversation, the server once it is deleted. */
  onGo: (path: string) => void;
  /** Show another version (null: the latest): the page's address is the version shown. */
  onPickVersion: PickVersion;
  /** Not the reader's to see after all (the viewer's one "can't open"): the host shows its page. */
  unavailable: ReactNode;
}


/**
 * The canonical link signed in (`/artifacts/<id>`, `/v/<n>`): the Artifact on
 * a page of its own, as "Open in new page" opens it. On a phone it is almost
 * the only way in.
 *
 * A shell: what the reader can do here is ArtifactSurface's, the same parts
 * the in-app viewer (ArtifactViewer) places, so the two can't drift apart
 * (comment mode, comments and their cards, presence, ⋯ and its dialogs,
 * version history, Esc's order). This file decides only
 * how they are laid out:
 *
 * - The public page's layout (PublicArtifactPage: one panel, its header over
 *   the content, no rail and no sidebar).
 * - The top bar (PanelHeader): Back (history back) where it was opened from
 *   a page in Raft; opened from outside (a new tab, another app, a reload)
 *   there is nothing to go back to, so in its place "Open in #channel" goes
 *   to where it lives (its home conversation, a DM by its name; the server
 *   for one of the whole server, public, or whose conversation is gone)
 *   (#proj-workspace:#104, Remy's rule 3). Then the title and
 *   version, the surface's meta line (ArtifactSurfaceMeta: the visibility
 *   chip, the original message, presence), then the surface's
 *   actions with Copy link among them. On a phone it collapses: Copy link
 *   goes into ⋯ and Fork in Raft folds into it; presence stays in
 *   the meta line, as at every width, collapsing there (ArtifactMetaRow) as
 *   the line narrows (on a phone, faces alone). The title keeps at least
 *   120px: "Open in #channel"'s name truncates first, and on a phone the
 *   link is its arrow alone (named by the place; the meta line's chip shows it).
 * - ⋯ (`surface="page"`) leaves out only what makes no sense on a page of
 *   its own: Open in new page (it is that page) and Expand (it is the whole
 *   window). Deleted, it goes back to the server.
 * - The comment list (and comment mode's review): a side column with a seam
 *   on its left on desktop (Page structure › Sidebar and side panel); on a
 *   phone a bottom sheet, as a document's comments are there.
 * - Version history: the address is the version shown, so a pick (and Back
 *   to Latest) goes to its `/v/<n>` (`onPickVersion`). View latest (a newer
 *   version's notice) does too where one is pinned; on the latest it reads
 *   it again, the address as it is.
 *
 * In the App (`?embed=raft-settings-v1&shell=host`, embed.ts; mobile #3866)
 * the native shell draws the title bar: Back, the title and the version. The
 * page then draws no Back, title or version of its own, only a toolbar row
 * with where it lives, its original message and the actions (Copy link and
 * the version history in ⋯), and it is laid out as on a phone at any width,
 * as MainLayout lays out a host-shell embed. The mode is read synchronously
 * (latched for the session), so the first frame is already without the head
 * and a version switch keeps it. View latest on the latest reads it again at
 * the same address, so the page adds `shown=<n>` to it (replaced) for the
 * title bar to follow; a version picked is another address, without it.
 * With `chrome=none` too (embed.ts) the App draws that toolbar natively and
 * the page draws only the content. The address may also ask it to open with
 * a list (`?panel=comments`, `?panel=versions` or `?panel=files`, the
 * Files panel, #proj-workspace:#239) or at a comment
 * (`?comment=<id>`, landing as an Activity row does): artifactPageOpening,
 * read once (#proj-workspace:#127). `?fork=1` (Fork in Raft chosen on the
 * public page before signing in, and the reader turned out to read it here):
 * the marker leaves the address, and nothing opens for a member of the
 * Artifact's own server, who isn't offered Fork in Raft (artifactForkInRaft,
 * #proj-workspace:#140). In the App, `#panel=comments|versions|files|none`
 * is the list open now: the App writes it to open or close one without a
 * reload, and the page writes it back as lists open and close. With
 * `back=host` too (embed.ts; #proj-workspace:#264) the App draws no title bar:
 * the toolbar starts with Back, which sets the hash to `#host=close` for the
 * App to close the page (artifactPageOpening's requestArtifactHostClose).
 *
 * The host has already asked where it opens and made that server current, so
 * every read here carries it (X-Server-Id) and the server's answer decides
 * what this reader may do. Links built here use the id in the address and
 * this deployment's origin (artifactUrl).
 */
export default function ArtifactStandalonePage({ target, server, seed = null, onGoBack, onGo, onPickVersion, unavailable }: ArtifactStandalonePageProps) {
  // View latest on the latest already shown reads it again (a newer one is out): the address stays.
  const [attempt, setAttempt] = useState(0);
  const result = useArtifactViewer(target, attempt, seed);
  const hostShell = isHostShell();
  // What the address asks it to open with (`?panel=`, `?comment=`): read once, from the address it was opened at.
  const [opening] = useState(() => artifactPageOpening(typeof window === "undefined" ? "" : window.location.search));
  // The file shown is in the address too (`?file=`), and live: opening one is a new entry, Back returns.
  const pageFile = usePageFile(onGo);
  // The App's WebView is a phone at any width, as MainLayout's forceMobilePanel lays out a host-shell embed.
  const phone = useMediaQuery(PHONE_QUERY) || hostShell;
  // Another version is the same page: it keeps showing the last one while `target` loads (`switching`).
  const data = result.status === "ok" ? result.data : null;
  const switching = result.status === "ok" && result.switching;
  const leave = useCallback(() => onGo(serverPath(server.slug)), [onGo, server.slug]);
  // A pinned version goes to the latest's address, as Back to Latest; the latest is read again.
  const pinned = target.version !== null;
  const showLatest = useCallback(() => {
    if (pinned) onPickVersion(null);
    else setAttempt((n) => n + 1);
  }, [pinned, onPickVersion]);
  // In the App the native title bar shows the version: it follows `/v/<n>`, but View latest on the
  // latest reads it again at the same address, so `shown=<n>` (replaced, not pushed) says which
  // version that is now (mobile, #proj-workspace:#109). A version picked is another address, without it.
  // The document's address, not the router's: this page takes no router (its moves are its props), and
  // the router's own history state is kept so Back still works.
  const shownLatest = hostShell && !pinned && attempt > 0 && data && !switching ? data.card.version : null;
  useEffect(() => {
    if (shownLatest === null) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("shown") === String(shownLatest)) return;
    url.searchParams.set("shown", String(shownLatest));
    window.history.replaceState(window.history.state, "", url);
  }, [shownLatest]);

  // One `artifact_opened` per page (not per version shown), once it has loaded, from the link.
  const tracked = useRef(false);
  useEffect(() => {
    if (!data || tracked.current) return;
    tracked.current = true;
    trackArtifactOpened(data, "link", phone ? "phone" : "maximized");
  }, [data, phone]);

  if (result.status === "unavailable") return <>{unavailable}</>;
  // One loading splash per version shown, from the moment it is asked for until its page has loaded
  // (ArtifactLoadingSplash, #proj-workspace:#145): the viewer data, then the frame. The first one
  // continues the canonical link's loading splash, from when the link's wait began (artifactLinkWait).
  const splashKey = `${target.id}@${target.version ?? "latest"}#${attempt}`;
  if (!data) {
    return (
      <ArtifactSplashScope openingKey={splashKey} size="page" initialStart={artifactLinkWaitStarted}>
        <StandaloneLoading hostShell={hostShell} onGoBack={onGoBack} />
      </ArtifactSplashScope>
    );
  }
  return (
    <ArtifactSplashScope openingKey={splashKey} size="page" initialStart={artifactLinkWaitStarted}>
      {/* The writes (follow, send, visibility, delete) are on the version shown; deleted, back to the server. */}
      <ArtifactShownFileProvider path={pageFile.path} onShow={pageFile.show}>
      <ArtifactSurfaceProvider
        data={data}
        shownKey={`${target.version ?? "latest"}#${attempt}`}
        onDeleted={leave}
        kind="page"
        phone={phone}
        fit={phone ? "sheet" : "beside"}
        onPickVersion={onPickVersion}
        onShowLatest={showLatest}
        landOn={opening.comment}
      >
        <StandaloneShell switching={switching} server={server} phone={phone} hostShell={hostShell} opening={opening} onGoBack={onGoBack} onGo={onGo} />
      </ArtifactSurfaceProvider>
      </ArtifactShownFileProvider>
    </ArtifactSplashScope>
  );
}

/**
 * Before the viewer data (stage 0): the page's layout with what is known (Back where there is a page
 * behind), still placeholders for the title and the meta line, and the loading splash over the
 * content area. In the App only the toolbar row (its native title bar is above); chromeless, the
 * content alone.
 */
function StandaloneLoading({ hostShell, onGoBack }: { hostShell: boolean; onGoBack?: () => void }) {
  return (
    <ArtifactPageLoadingLayout hostShell={hostShell} onGoBack={onGoBack} testId="artifact-page-loading">
      <ArtifactLoadingSplash stage="getting" kind={null} />
    </ArtifactPageLoadingLayout>
  );
}

function serverPath(slug: string): string {
  return `/s/${encodeURIComponent(slug)}`;
}

/**
 * Where an Artifact lives, in Raft: its conversation's page and name (a DM by
 * its peer, a channel `#name`); the server for one of the whole server, a
 * public one, or one whose conversation is gone.
 */
export function artifactHomeLink(home: ArtifactHome, server: ArtifactStandaloneServer): { path: string; name: string } {
  if (home.kind === "conversation" && home.conversation.id !== null && home.conversation.name !== "") {
    const route = home.conversation.type === "dm" ? "dm" : "channel";
    return { path: `${serverPath(server.slug)}/${route}/${encodeURIComponent(home.conversation.id)}`, name: conversationLabel(home.conversation) };
  }
  return { path: serverPath(server.slug), name: server.name };
}

function StandaloneShell({ switching, server, phone, hostShell, opening, onGoBack, onGo }: {
  switching: boolean;
  server: ArtifactStandaloneServer;
  phone: boolean;
  hostShell: boolean;
  opening: ArtifactPageOpening;
  onGoBack?: () => void;
  onGo: (path: string) => void;
}) {
  const { formatMessage } = useIntl();
  // The data shown: with what this reader's writes changed (where it lives, after a move).
  const { data, versionsOpen, setVersionsOpen, filesOpen, setFilesOpen, actions: { openFork } } = useArtifactSurface();
  const comments = useArtifactComments();
  const setCommentsOpen = comments?.setPanelOpen;
  const commentsOpen = comments?.panelOpen ?? false;
  // The one list (or the Files panel) open: the address's `?panel=` once, the App's `#panel=` as it changes.
  // Files first: opening it closes the comment list, which the next line then sets as asked.
  // No files: `files` opens nothing (the surface's setFilesOpen ignores it).
  const hasFiles = data.files.length > 0;
  const showPanel = useCallback((panel: ArtifactPagePanel) => {
    setFilesOpen(panel === "files");
    setCommentsOpen?.(panel === "comments");
    setVersionsOpen(panel === "versions");
  }, [setCommentsOpen, setVersionsOpen, setFilesOpen]);
  // `?panel=`: the list the address asks for, opened once when the page first shows.
  const openedPanel = useRef(false);
  useEffect(() => {
    if (openedPanel.current || opening.panel === null) return;
    openedPanel.current = true;
    showPanel(opening.panel);
  }, [opening.panel, showPanel]);
  // `?fork=1`: Fork in Raft from before sign-in (#proj-workspace:#140). The marker goes; its dialog opens only
  // where this page offers Fork in Raft (never for a member of the Artifact's own server).
  useArtifactForkMarker(offersForkInRaft(data.card) ? "open" : "drop", openFork);
  // In the App (#proj-workspace:#127): `#panel=` is the list open now. The App writes it to open or close
  // one without a reload (hashchange); the page writes it back (replaced, never pushed) as lists open and
  // close, so the App's own buttons follow and it reads the counts again once comments close.
  // A `#panel=` the page is opened with counts too (QA #proj-workspace:#122): followed once on mount,
  // and not written over before it is (the write-back's first run still shows no list).
  const askedOnLoad = useRef(hostShell ? artifactPanelFromHash(window.location.hash) : null);
  useEffect(() => {
    if (!hostShell) return;
    const follow = () => {
      const asked = artifactPanelFromHash(window.location.hash);
      if (asked === null) return;
      showPanel(asked);
    };
    follow();
    // A list it can't open (no comments for this reader): nothing to wait for, so the write-back goes on.
    if (askedOnLoad.current === "comments" && !setCommentsOpen) askedOnLoad.current = null;
    if (askedOnLoad.current === "files" && !hasFiles) askedOnLoad.current = null;
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [hostShell, setCommentsOpen, showPanel, hasFiles]);
  const shownPanel = commentsOpen ? "comments" : versionsOpen ? "versions" : filesOpen ? "files" : "none";
  useEffect(() => {
    if (!hostShell) return;
    const hash = artifactHashForPanel(shownPanel);
    // Until the list asked for on load shows, its hash stays (a plain early exit: no handler in an effect).
    if (askedOnLoad.current !== null && askedOnLoad.current !== shownPanel) return;
    askedOnLoad.current = null;
    // Only an empty hash, our own `#panel=` or a `#host=` request (the App stayed open; a list opened since)
    // is ours to replace: any other hash the page was opened with stays.
    const current = window.location.hash;
    if (current === hash || (current !== "" && !isArtifactHostActionHash(current) && artifactPanelFromHash(current) === null)) return;
    const url = new URL(window.location.href);
    url.hash = hash;
    window.history.replaceState(window.history.state, "", url);
  }, [hostShell, shownPanel]);
  const { card } = data;
  // The App declared its own menu items (`hostMenu`, embed.ts; Lagoon, artin, mobile #4635): the page draws the only
  // bar, with the title, the version and those items, and says so (`hostToolbar=1`) once it is up, so the App drops
  // its own. Written on the document's address, as `shown=` is (this page takes no router); the keeper keeps it.
  const ownBar = hostShell && !isChromeless() && hostMenuItems().length > 0;
  useEffect(() => {
    if (!ownBar || !markHostToolbarDrawn()) return;
    const url = new URL(window.location.href);
    url.searchParams.set("hostToolbar", "1");
    window.history.replaceState(window.history.state, "", url);
  }, [ownBar]);
  // The tab says which Artifact this is and where it's read (`<title> | <server> | Raft`), as renamed; an in-app
  // browser's share card carries only a public one's title, never the server.
  useArtifactPageDocumentTitle(card.title, { server: server.name, shareable: card.home.kind === "public" });
  const onKeyDown = useArtifactSurfaceKeyDown();
  // Cmd/Ctrl+F with no focused element (the page just loaded, nothing clicked yet): the find bar's too.
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  useArtifactFindBodyShortcut(panel, { wholePage: true });
  const home = artifactHomeLink(card.home, server);
  const openHome = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainPrimaryClick(event)) return;
    event.preventDefault();
    onGo(home.path);
  }, [home.path, onGo]);
  const backLabel = onGoBack ? formatMessage({ id: "artifacts.page.back" }) : formatMessage({ id: "artifacts.page.openIn" }, { place: home.name });
  // Where it lives (the visibility chip), its original message (Back comes back to this page), presence:
  // the header's meta line, and the App's toolbar.
  const where = <ArtifactSurfaceMeta testId="artifact-page-meta" />;
  const actions = (
    <PanelActions data-testid="artifact-page-actions">
      <ArtifactSurfaceActions compact={phone} commentsInMenu={false} copyLinkHere={!phone} />
    </PanelActions>
  );

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-layer-canvas font-display safe-top safe-bottom" data-testid="artifact-page">
      {/* The surface's element (`data-artifact-focus`): it handles Esc, so focus lands here when something
          in it goes (comment mode's box, the pinned notice's buttons) and the next Esc still works. */}
      <Panel ref={setPanel} tabIndex={-1} edge="inset" aria-label={card.title} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col outline-none keyboard:focus-visible:outline-2 keyboard:focus-visible:outline-solid keyboard:focus-visible:-outline-offset-2 keyboard:focus-visible:outline-foreground" data-artifact-focus="" data-testid="artifact-page-panel">
        {isChromeless() ? null : hostShell ? (
          // The App's own title bar is above (Back, the title, the version): no second one, only the toolbar.
          // With `back=host` the App draws none: the toolbar starts with Back, which asks the App to close it.
          // Where the App declared its menu (`ownBar`), the page's is the only bar: Back, the title and version, then
          // where it lives; the App's items lead the ⋯ (ArtifactViewerMenu).
          <PanelHeader className={`border-b border-line-seam ${HOST_TOOLBAR_ROOM}`} data-embed-shell="host" data-own-bar={ownBar ? "" : undefined} data-testid="artifact-page-toolbar">
            <ArtifactHostBack ownBar={ownBar} />
            <PanelHeaderContent className={ownBar ? "@container min-w-30" : "@container"}>
              {ownBar ? (
                <PanelHeading>
                  <ArtifactSurfaceTitle pageHeading testId="artifact-page-title" />
                  <PanelStatus><ArtifactSurfaceVersionTag /></PanelStatus>
                </PanelHeading>
              ) : null}
              {where}
            </PanelHeaderContent>
            {actions}
          </PanelHeader>
        ) : (
          <PanelHeader className="border-b border-line-seam" data-testid="artifact-page-header">
            {onGoBack ? (
              <Tooltip content={backLabel}>
                <PanelAction aria-label={backLabel} onClick={onGoBack} data-testid="artifact-page-back">
                  <ArrowLeft />
                </PanelAction>
              </Tooltip>
            ) : (
              // A link, its place named on it ("← #channel"): where it lives, not a Back to nothing.
              // It gives way first where the head is narrow (its name truncates), so the title keeps its room.
              <PanelAction nativeButton={false} render={<a href={home.path} onClick={openHome} aria-label={backLabel} />} className="min-w-0 shrink" data-testid="artifact-page-home">
                <ArrowLeft />
                {/* On a phone the arrow alone (its name says where; the meta line's chip shows it): the title keeps its room. */}
                {phone ? null : <span className="min-w-0 max-w-40 truncate">{home.name}</span>}
              </PanelAction>
            )}
            {/* The title's least room (120px: about ten characters and the version): on a 390px phone the place's
                name and the comment controls left it two letters ("D."). */}
            <PanelHeaderContent className="@container min-w-30">
              <PanelHeading>
                <ArtifactSurfaceTitle pageHeading testId="artifact-page-title" />
                <PanelStatus><ArtifactSurfaceVersionTag /></PanelStatus>
              </PanelHeading>
              {where}
            </PanelHeaderContent>
            {actions}
          </PanelHeader>
        )}
        <ArtifactSurfaceMain switching={switching} />
      </Panel>
    </main>
  );
}
