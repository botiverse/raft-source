import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowUpRight, Clock, Download, FileX, LogIn, RefreshCw, ShieldOff } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import { compile, defineDisplays, frameFallback, LIBRARY_CDNS } from "@botiverse/porthole";
import type { AnnotationReport, CapabilityHandlers, ConfirmRequest, FrameLocation, FrameOutcome, InstanceRef, PortholeConfig, ViewerInfo } from "@botiverse/porthole";
import { PortholeFrame, PortholeProvider } from "@botiverse/porthole/react";
import type { ConfirmActions, PortholeFrameHandle } from "@botiverse/porthole/react";
import { ARTIFACT_FRAME_SANDBOX, asArtifactInstanceVersion, currentTimeMs } from "@botiverse/raft-shared";
import { ARTIFACT_PAGE_THEME_VARIABLES } from "@botiverse/raft-shared/src/artifactPageTheme";
import type { ArtifactFile, ArtifactFramedKind, ArtifactId, ArtifactWebErrorCode, ArtifactWebFrame } from "@botiverse/raft-shared";

import { useMergedRef } from "../../components/layout/appPanelHead";
import { FRAME_MOVED_ATTRIBUTE, FRAME_MOVED_EVENT } from "../../components/ui/moveNode";
import { showToast } from "../../components/toastBridge";
import { useOptionalAppTheme } from "../../hooks/useAppTheme";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { trackArtifactFrameLoaded } from "./artifactAnalytics";
import { artifactErrorCode } from "./artifactApi";
import { blockedNoticeNames, blockedSetFile, readerInFrame } from "./artifactBlockedFile";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { withRefreshMark } from "./artifactCommentMarks";
import { useMarginRef, useMarginRefresh } from "./artifactMarginEntries";
import { parsePageCommentRequest } from "./artifactPageComments";
import { useArtifactPageForkAsk } from "./useArtifactPageForkAsk";
import { ArtifactLoadingSplash } from "./ArtifactLoadingSplash";
import { useArtifactSplashStart } from "./artifactSplash";
import { ArtifactPageErrorNotice } from "./ArtifactPageError";
import { useArtifactPageErrors } from "./useArtifactPageErrors";
import { useArtifactPageTheme } from "./useArtifactPageTheme";
import { useArtifactReview } from "./ArtifactReviewContext";
import { allowLoopbackContent, artifactsContentDomain, contentHostOf, scopeOf } from "./artifactContentDomain";
import { artifactSource } from "./artifactSource";
import { takeViewerFrame } from "./artifactViewerFrame";
import { useArtifactFindFrame } from "./artifactFind";
import type { ArtifactFindTarget } from "./artifactFind";
import { findAllowed, withoutFind } from "./artifactFrameFind";
import { ArtifactFrameConfirm } from "./ArtifactFrameConfirm";
import { FrameState } from "./ArtifactFrameState";
import { artifactOpenLabelId, openArtifactWindow } from "./artifactWindow";
import { sameMarkAgain } from "./useArtifactDismiss";

/**
 * A framed version (html, markdown, pdf) on the content origin (S2), through
 * Porthole's React frame (`@botiverse/porthole/react`). Decisions: Remy's S2
 * design (docs/development/workspace-artifacts-content-origin.md), Tenny,
 * Remy and Kirby in #proj-workspace:4fb9afce.
 *
 * - Every mount asks the frame route (`artifactWebPaths.frame`) for a
 *   FrameLocation: its ticket is good once, for 60 s, so it is never cached.
 *   The one exception is a version's first frame right after its viewer
 *   answer, which takes the ticket that answer carried (artifactViewerFrame).
 *   After the first answer the locator asks the route again on each locate
 *   (Porthole's reload, an expired session, a restart): Porthole calls it
 *   for every run, and both of a frame's tickets open once.
 * - The frame's door (Porthole 0.14.6's P125, 0.14.7's P126): the route's
 *   answer carries `door` (`<origin>/__porthole/door/_raft?ticket=…`, its own
 *   one-time ticket, served by the content Worker), and the locator hands
 *   Porthole the answer as it came, `door` included. Porthole 0.14.10 frames
 *   the door first (hidden, opaque, `iframe[data-porthole-door]`) and takes
 *   how loading went from it alone: `open`, then the content frame; or
 *   `blocked` (used ticket, denied with Raft's code, not found), the outcome
 *   below. The content frame's own frame status is never taken. 0.14.10 frames
 *   nothing without a door, so an answer without one (first or on a reload)
 *   is the content not being available (CONTENT_UNAVAILABLE, Try again),
 *   never a frame of `url` alone
 *   (docs/development/workspace-artifacts-content-worker.md, "The frame").
 * - The content domain is pinned at build time (VITE_ARTIFACTS_CONTENT_DOMAIN,
 *   `host[:port]`, the same value as the server's ARTIFACTS_CONTENT_DOMAIN),
 *   never learned from the route's answer: the side being checked doesn't
 *   set the standard (Remy, Tenny). Unset: nothing is framed.
 * - Only Raft's own label for this Artifact on that domain is loaded
 *   (exactly `w-<uuid>.<domain>`, https; http only on a `*.localhost` domain
 *   in a dev build), on top of Porthole's own check that the origin can't be
 *   same-site with the app.
 * - The sandbox is Porthole's for domain isolation, and must equal the
 *   shared ARTIFACT_FRAME_SANDBOX (no popups, no top navigation): checked
 *   when the config is made, and nothing is framed otherwise.
 * - The page reaches Raft only through the three capabilities the content
 *   Worker's config declares (packages/content-worker/src/raftContentDisplays.ts,
 *   kept equal to RAFT_ARTIFACT_DISPLAYS below): `openLink` (http and https
 *   only, a new tab with noopener and noreferrer), `copyText` (the app's
 *   clipboard helper, with its toast) and `comments` (Porthole's runtime,
 *   P090, P108: the page's button opens Raft's comment box at the page's
 *   anchor with its draft, checked by artifactPageComments; the person sends
 *   it, the page never posts or reads a comment). Porthole gates `comments`
 *   and `copyText` on a click in the frame and 30 a minute; the viewer adds
 *   its own limits (ArtifactCommentsContext openFromPage). A `comments.open`
 *   refused for want of a click is said in a toast: use the Comment button.
 *   Another server's reader's (past the same gate) is answered false, and Raft
 *   asks to fork it instead (useArtifactPageForkAsk).
 * - `annotate` (P053, P104, P107) is the host's, not the page's to call:
 *   every signed-in viewer shows the posted threads' bubbles and opens a
 *   thread from its bubble (ArtifactCommentsContext `frame`, co-design S1);
 *   comment mode (ArtifactReviewContext, the review flag) adds the drafts'
 *   bubbles and starts selections. Both lists declare it. The open thread
 *   card's mark is followed (`trackedAnnotation`, P118), or comment mode's
 *   open composer's selection (`trackedSelection`, P138, given from the first
 *   render so each start keeps the selection, P140), and comment mode
 *   takes a used selection away through the frame's ref (`clearSelection`,
 *   P115, P118). While a deploy has
 *   one side ahead (Porthole checks no agreement between the host's and the
 *   served config), the frame still loads: an older shell drops the host's
 *   `annotate.*` notifications, so no selections and no bubbles; an older
 *   host never starts it, so the shell reports nothing.
 * - `find` (P131, #proj-workspace:#138): the find bar searches the page, which reads every
 *   query, so it is declared only where the page has no way to send what it reads out
 *   (artifactFrameFind `findAllowed`; else Cmd/Ctrl+F stays the browser's), only with a find bar
 *   (ArtifactFindProvider: the surface's, the public page's). The frame offers the bar its handle's `find` and `clearFind` (artifactFind);
 *   a new attempt or run is other content, which forgets the query.
 * - What the page throws reaches the host through `reportError` (the preset's, kept by
 *   `errors: "host"`) as `onContentError`: where the reader may comment, in A, a strip over the
 *   frame offers to send it to the agent as their comment, only on their click (ArtifactPageError).
 * - The frame stays on one DOM node while the viewer moves between the side
 *   card, expanded and a phone's full screen (F41): nothing above it
 *   remounts on a layout change, nor when comment mode turns on after it
 *   mounted (the flag answering late, ArtifactReviewProvider) and its drafts
 *   load: their bubbles go to the frame as props (#107). A new ticket is
 *   asked for only on a version switch (the viewer is keyed by version), a
 *   retry, or a reload.
 * - While it locates and until the page says `loaded`, the loading splash (ArtifactLoadingSplash,
 *   a trial, #proj-workspace:#145) lies over the frame's box as a sibling, the box's size untouched:
 *   "Getting the page" while the ticket is asked for, "Starting the page" once the frame is mounted;
 *   on `loaded` it plays its ending and goes. Every failure is its own screen in its place.
 * - The theme: a Markdown page takes Raft's colours (the mode and the server's theme), live, through
 *   the frame's `theme` (useArtifactPageTheme; #proj-workspace:#219), as `--raft-*` variables the
 *   config declares (artifactPageTheme in shared says why those names). Only colours, through
 *   Porthole's host context, which every page already gets; `scheme` and Porthole's neutral values
 *   stay as they were. An HTML page is its author's and a PDF the viewer's, so neither gets it. The
 *   public page's Markdown gets it as any does (xxchan, the feature matrix D2: what Raft renders
 *   follows the reader's light or dark mode there too; an author's own colours stay theirs): the
 *   colours are <html>'s, which for a visitor are Raft's own in their device's mode, the same the
 *   public page's own header wears.
 * - A link to a file of the set that isn't a page (#proj-workspace:#256): Porthole stops it and says
 *   where (`onNavigationBlocked`, P084, P080). A file of the mounted version (`files`), only while the
 *   reader is in the frame, opens in the surface's Files panel (`onOpenFile`; artifactBlockedFile),
 *   and the content error Porthole sends with it never reaches the error strip (the link worked);
 *   anything else stays stopped, unanswered, its error on the strip as before. No `onOpenFile`
 *   (the public page): nothing.
 */

/**
 * The display kinds, as the content Worker serves them
 * (packages/content-worker/src/raftContentDisplays.ts): a change there is a
 * change here.
 * The capability runtime (contract "1", P085) only for `comments`, one of its
 * host functions, which pages reach as a built-in without declaring it; the
 * runtime's other host functions (`user`, `db`, ...) are not offered.
 */
export const RAFT_ARTIFACT_DISPLAYS = defineDisplays({
  artifact: {
    preset: "artifact",
    options: {
      egress: LIBRARY_CDNS,
      runtime: "1",
      // `annotate` (P053, P104, P107): comment mode's selections, picked blocks and bubbles.
      // Only a viewer with comment mode on drives it (annotating, annotations); every other
      // frame never asks, and the shell reports nothing until asked.
      // `find` (P131): the find bar's, declared per frame only where allowed (PAGES_MAY_FIND).
      // `comments` and `openLink` on Porthole's defaults: no proof of a click since 0.16.0 (its
      // P149; the check refused real presses, #proj-workspace:#271). artifactPageOpenGate holds
      // what it guarded.
      capabilities: { annotate: {}, comments: {}, copyText: {}, find: {}, openLink: {} },
      layout: { kind: "fill" },
      errors: "host",
      // The Markdown page's colours; the frame sends live values only to that page.
      theme: { variables: ARTIFACT_PAGE_THEME_VARIABLES },
    },
    served: { storage: { scope: "this artifact, across its versions" } },
  },
});

/**
 * The content source (`https://*.<content domain>`) a located frame is on,
 * or null when it isn't exactly this Artifact's own label on the build's
 * content domain.
 */
export function frameContentSource(id: ArtifactId, location: Pick<FrameLocation, "url" | "origin">): string | null {
  const domain = artifactsContentDomain();
  if (!domain) return null;
  let origin: URL;
  let url: URL;
  try {
    origin = new URL(location.origin);
    url = new URL(location.url);
  } catch {
    return null;
  }
  if (url.origin !== origin.origin || origin.origin !== location.origin) return null;
  // Plain http only for the local content Worker, and only in a dev build: a
  // production build frames https alone.
  const domainHost = domain.replace(/:\d+$/, "");
  const loopback = allowLoopbackContent() && origin.protocol === "http:" && domainHost.endsWith(".localhost");
  if (origin.protocol !== "https:" && !loopback) return null;
  if (origin.host !== contentHostOf(id, domain)) return null;
  return `${origin.protocol}//*.${domain}`;
}

const configs = new Map<string, PortholeConfig | null>();

/**
 * The served config for a content source, made once per source (a new
 * config object would make the frame again). Null when its sandbox isn't
 * exactly ARTIFACT_FRAME_SANDBOX: then nothing is framed.
 */
export function artifactFrameConfig(source: string): PortholeConfig | null {
  if (!configs.has(source)) {
    const config = RAFT_ARTIFACT_DISPLAYS.served(source)?.artifact ?? null;
    configs.set(source, config && compile(config).sandbox === ARTIFACT_FRAME_SANDBOX ? config : null);
  }
  return configs.get(source) ?? null;
}

/**
 * A link the page asked to open (`openLink`): the content's word, so
 * untrusted input (Tenny, #proj-workspace:4fb9afce 6b3014f9). Only an
 * absolute http or https address opens, in a new tab with noopener and
 * noreferrer; anything else (javascript:, data:, blob:, file:, relative,
 * unparsable) is dropped without a word.
 */
export function openFrameLink(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  window.open(url.href, "_blank", "noopener,noreferrer");
  return true;
}

export type ViewState =
  | { status: "locating" }
  | { status: "ready"; config: PortholeConfig; instance: InstanceRef }
  | { status: "error"; code: ArtifactWebErrorCode | null }
  | { status: "fallback"; kind: "expired" | "denied" | "needs-tab" | "failed" };

const LOCATING: ViewState = { status: "locating" };

/**
 * The frame's Porthole instance: this Artifact, at the version its tickets were signed for as the
 * content Worker's instance names it (`instanceVersion`, ArtifactInstanceVersion). Porthole's host
 * takes a page of the set as the same display only when the page's notice names exactly this
 * instance's version (pages-of-set, P084, P098); with any other, each link between the pages is
 * the content navigating away, and the display starts again at its entry (#proj-workspace:#251).
 * An answer without it (a Server before it) keeps the version's number, as before.
 */
function frameInstanceOf(id: ArtifactId, version: number, location: Pick<ArtifactWebFrame, "instanceVersion">): InstanceRef {
  const issued = asArtifactInstanceVersion(location.instanceVersion);
  return { scope: scopeOf(id), document: { kind: "artifact", id, version: issued ?? String(version) } };
}

/**
 * What a "locate" block shows. When the locator itself failed it already
 * showed the route's code (null: leave it). Otherwise Porthole refused the
 * location the route gave (same site as the app, not a content origin): the
 * content isn't reachable, never a blank frame.
 */
export function locateBlockState(locatorFailed: boolean): ViewState | null {
  return locatorFailed ? null : { status: "error", code: "CONTENT_UNAVAILABLE" };
}
/** A gated call's yes (`openLink`, ...): Raft's own dialog, never Porthole's default (#proj-workspace:#252). */
const renderConfirm = (request: ConfirmRequest, answer: ConfirmActions) => <ArtifactFrameConfirm request={request} answer={answer} />;

/** The frame fills the viewer's body. */
const FILL = { height: "100%" } as const;

/**
 * Who is viewing, for Porthole's runtime (P087): Raft's frame route names no
 * viewer (ArtifactWebFrame), and the runtime refuses its host functions
 * without one. `view` is all `comments.open` needs; whether the person may
 * comment is Raft's own (the viewer's capabilities), and no id or name goes
 * to the page.
 */
const PAGE_VIEWER: ViewerInfo = { level: "view" };

/**
 * What the page declared (P086): nothing, as a page published before 0.7
 * (Raft's versions store no declaration), so it keeps 0.6's globals and
 * reaches only the runtime's built-ins (`comments`). Under a runtime a mount
 * must say so with null, never by omission (Porthole refuses the mount).
 */
const NO_DECLARATION = null;

/**
 * Whether Raft's pages may be searched by the find bar (privacy, #proj-workspace:#138): every page
 * is mounted under the same config and declaration, so one answer for all. Today they may: their
 * runtime offers only `comments`, `openLink` asks the person first, and their network is the
 * library CDNs (artifactFrameFind).
 */
const PAGES_MAY_FIND = findAllowed(RAFT_ARTIFACT_DISPLAYS.guideConfig("artifact", "served"), NO_DECLARATION);

interface ArtifactFrameProps {
  id: ArtifactId;
  version: number;
  /** For `artifact_frame_loaded`. */
  kind: ArtifactFramedKind;
  title: string;
  /** Raft's own page for the Artifact (artifactUrl), for "Open in new tab". */
  pageUrl: string;
  onDownload?: () => void;
  /**
   * Where the frame comes from: the signed-in viewer's frame route
   * (`artifactSource().frame`) when absent; the signed-out public page passes
   * the public frame route. Asked on every mount and every locate, as that
   * route is; a new function alone asks nothing.
   */
  locate?: (id: ArtifactId, version: number) => Promise<ArtifactWebFrame>;
  /**
   * Whether `artifact_frame_loaded` is reported (default true). The
   * signed-out public page passes false: a visitor with no sign-in has no
   * analytics identity, and nothing of theirs is sent.
   */
  analytics?: boolean;
  /** NOT_FRAMED without a download (the signed-out page): "Open in Raft", which signs in. */
  onOpenInRaft?: () => void;
  /** The mounted version's files, where a page's link to one that isn't a page is looked up. */
  files?: readonly ArtifactFile[];
  /** Show that file (the surface's Files panel, at its row); absent, such a link does nothing. */
  onOpenFile?: (path: string) => void;
}

// The first frame of a version just opened takes the ticket its viewer answer carried; every other load asks the route.
const signedInFrame = (id: ArtifactId, version: number): Promise<ArtifactWebFrame> => {
  const ticket = takeViewerFrame(id, version);
  return ticket ? Promise.resolve(ticket) : artifactSource().frame(id, { version });
};

export default function ArtifactFrame({ id, version, kind, title, pageUrl, onDownload, locate = signedInFrame, analytics = true, onOpenInRaft, files, onOpenFile }: ArtifactFrameProps) {
  const { formatMessage } = useIntl();
  const theme = useOptionalAppTheme();
  const scheme = theme?.resolvedMode === "dark" ? "dark" : "light";
  const pageTheme = useArtifactPageTheme(kind === "markdown");
  // A retry asks the route again and makes a new frame.
  const [attempt, setAttempt] = useState(0);
  // What this attempt came to; locating until it answers.
  const [answer, setAnswer] = useState<{ attempt: number; state: ViewState } | null>(null);
  const state: ViewState = answer?.attempt === attempt ? answer.state : LOCATING;
  // A later word (the locator, the frame's outcome) about the attempt on screen.
  const settle = useCallback((next: ViewState) => setAnswer((prev) => (prev ? { attempt: prev.attempt, state: next } : prev)), []);
  // Porthole's reload (an expired session): a new frame, which locates again.
  const [generation, setGeneration] = useState(0);
  // Moved in the DOM where the browser can't keep it (FRAME_MOVED_EVENT): the iframe reloads its first
  // address, a ticket already used ("This link has been used"), so the frame opens again with a new one.
  const [movedRoot, setMovedRoot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!movedRoot) return;
    const reopen = () => setGeneration((n) => n + 1);
    movedRoot.addEventListener(FRAME_MOVED_EVENT, reopen);
    return () => movedRoot.removeEventListener(FRAME_MOVED_EVENT, reopen);
  }, [movedRoot]);
  // The first answer of this attempt, handed to the frame's first locate.
  const located = useRef<FrameLocation | null>(null);
  // An expired session reloads once by itself; again only after a load.
  const reloadedSinceLoad = useRef(false);
  // Whether the locator itself failed (and so already showed the route's code).
  const locatorFailed = useRef(false);
  // `artifact_frame_loaded`: once per attempt, from asking for the frame to
  // how it came out (an expired session's own reload is part of the attempt).
  const timing = useRef<{ startedAt: number; reported: boolean }>({ startedAt: 0, reported: true });
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const analyticsRef = useRef(analytics);
  analyticsRef.current = analytics;
  // Where frames come from: read when asking, so a new function never asks again by itself.
  const locateRef = useRef(locate);
  locateRef.current = locate;
  // The loading splash (#proj-workspace:#145): from the opening for the first attempt, from the retry
  // for a later one; it lies over the frame until the attempt's page says it loaded.
  const splashStartedAt = useArtifactSplashStart(attempt);
  const attemptRef = useRef(attempt);
  attemptRef.current = attempt;
  const [loadedAttempt, setLoadedAttempt] = useState<number | null>(null);
  const pageLoaded = loadedAttempt === attempt;
  const report = useCallback((result: "ok" | "error" | "timeout") => {
    if (timing.current.reported) return;
    timing.current.reported = true;
    if (!analyticsRef.current) return;
    trackArtifactFrameLoaded({ result, kind: kindRef.current, durationMs: currentTimeMs() - timing.current.startedAt });
  }, []);

  useEffect(() => {
    let cancelled = false;
    located.current = null;
    reloadedSinceLoad.current = false;
    locatorFailed.current = false;
    timing.current = { startedAt: currentTimeMs(), reported: false };
    locateRef.current(id, version).then((location) => {
      if (cancelled) return;
      const source = frameContentSource(id, location);
      // Without a door Porthole frames nothing (`blocked: locate`): the content isn't available.
      const config = source && location.door ? artifactFrameConfig(source) : null;
      if (config) located.current = location;
      else report("error");
      setAnswer({ attempt, state: config ? { status: "ready", config, instance: frameInstanceOf(id, version, location) } : { status: "error", code: "CONTENT_UNAVAILABLE" } });
    }, (error: unknown) => {
      if (cancelled) return;
      report("error");
      setAnswer({ attempt, state: { status: "error", code: artifactErrorCode(error) } });
    });
    return () => { cancelled = true; };
  }, [id, version, attempt, report]);

  const locator = useMemo(() => ({
    async locate(): Promise<FrameLocation> {
      const first = located.current;
      if (first) {
        located.current = null;
        return first;
      }
      try {
        const location = await locateRef.current(id, version);
        // A reload answered without a door, as one off this Artifact's label: not available.
        if (!frameContentSource(id, location) || !location.door) throw { status: 503, code: "CONTENT_UNAVAILABLE" };
        return location;
      } catch (error) {
        locatorFailed.current = true;
        report("error");
        settle({ status: "error", code: artifactErrorCode(error) });
        throw error;
      }
    },
  }), [id, version, settle, report]);

  // The comments of the viewer this frame is in (none: the page's button opens nothing). With
  // comment mode, its state decides (B: a draft box); the box opens beside the frame's top.
  const comments = useArtifactComments();
  const review = useArtifactReview();
  const openFromPage = review?.openFromPage ?? comments?.openFromPage;
  // Another server's reader of a public Artifact (no comments): the page's ask offers Fork in Raft instead.
  const forkAsk = useArtifactPageForkAsk();
  const { offered: forkOffered, ask: askFork } = forkAsk;
  const [frameBox, setFrameBox] = useState<HTMLDivElement | null>(null);
  // What the page threw (Porthole's `onContentError`): offered to the agent only on the reader's click.
  const frameWidth = useCallback(() => frameBox?.getBoundingClientRect().width ?? null, [frameBox]);
  const pageErrors = useArtifactPageErrors(id, version, frameWidth);
  const handlers = useMemo<CapabilityHandlers>(() => ({
    openLink: ({ url }) => openFrameLink(url),
    comments: (request) => {
      const checked = parsePageCommentRequest(request);
      // Past Porthole's click gate only: the question answers a click; the page hears false (it can't comment here).
      if (forkOffered) {
        if (checked !== null) askFork();
        return false;
      }
      const box = frameBox?.getBoundingClientRect();
      const rect = box ? { x: box.left, y: box.top, width: box.width, height: box.height } : null;
      return checked !== null && openFromPage !== undefined && openFromPage(checked, rect);
    },
    copyText: async ({ text }) => {
      try {
        await copyTextToClipboard(text);
        showToast({ title: formatMessage({ id: "artifacts.frame.copied" }) });
        return true;
      } catch {
        showToast({ title: formatMessage({ id: "artifacts.frame.copyFailed" }), type: "error" });
        return false;
      }
    },
  }), [formatMessage, openFromPage, frameBox, forkOffered, askFork]);

  // The page's word (artifactBlockedFile): a file of this version, never an address to go to.
  // Opened, the link worked: the content error Porthole sends with the notice, at once after it in
  // the same report (P080), is no error of the page's, so the strip never offers to fix it. Kept
  // only for that report (a microtask), and only a message naming that address is dropped.
  const answeredBlock = useRef<string | null>(null);
  const onNavigationBlocked = useCallback(({ url }: { readonly url: string }) => {
    const path = onOpenFile && files ? blockedSetFile(url, files) : null;
    if (path === null || !readerInFrame(movedRoot)) return;
    onOpenFile?.(path);
    answeredBlock.current = url;
    queueMicrotask(() => { answeredBlock.current = null; });
  }, [files, onOpenFile, movedRoot]);
  const pageError = pageErrors.onContentError;
  const onContentError = useCallback((message: string) => {
    const answered = answeredBlock.current;
    answeredBlock.current = null;
    if (answered !== null && blockedNoticeNames(message, answered)) return;
    pageError(message);
  }, [pageError]);

  const onOutcome = useCallback((outcome: FrameOutcome) => {
    const fallback = frameFallback(outcome);
    if (fallback === null) {
      reloadedSinceLoad.current = false;
      setLoadedAttempt(attemptRef.current);
      report("ok");
      return;
    }
    if (outcome.state === "blocked" && outcome.reason === "locate") {
      const next = locateBlockState(locatorFailed.current);
      report("error");
      if (next) settle(next);
      return;
    }
    if (fallback.kind === "expired" && !reloadedSinceLoad.current) {
      reloadedSinceLoad.current = true;
      locatorFailed.current = false;
      setGeneration((n) => n + 1);
      return;
    }
    report(fallback.kind === "timeout" ? "timeout" : "error");
    settle({ status: "fallback", kind: fallback.kind === "timeout" ? "failed" : fallback.kind });
  }, [settle, report]);

  // What the person may point at, the bubbles, and what the frame reports, with the frame's box to
  // place a view beside a report's rect: comment mode's where it is on, else the posted comments'
  // (none without a comments context: the signed-out page).
  const layer = review?.frame ?? comments?.frame ?? null;
  // A Markdown Artifact's margin (#152): the frame follows the margin's reference mark (one it shows)
  // and is given the refresh mark last, both read from the margin's store here, so an ask or a new
  // reference re-renders the frame alone, never every reader of the comments. A newer frame (P132)
  // says the document's scroll in each `tracked` of that mark, in view or not: following one is how
  // the margin hears the page scroll, so it always follows one while any is attached.
  const marginShown = comments?.margin.shown ?? false;
  const marginRef = useMarginRef();
  const marginRefresh = useMarginRefresh();
  const layerMarks = layer?.marks;
  const marks = useMemo(() => (layerMarks && marginShown ? withRefreshMark(layerMarks, marginRefresh) : layerMarks), [layerMarks, marginShown, marginRefresh]);
  const trackedMark = marginShown ? (marginRef !== null && layerMarks?.some((m) => m.id === marginRef) ? marginRef : null) : layer?.trackedMark;
  const layerAnnotation = layer?.onAnnotation;
  const onAnnotation = useCallback((report: AnnotationReport) => {
    const box = frameBox?.getBoundingClientRect();
    // Read now, as the report arrives, on this page, where the page can't change the answer (P134).
    const active = document.activeElement;
    const focused = report.type === "activated" && active instanceof HTMLIFrameElement && frameBox?.contains(active) ? active : null;
    // The marker of the card this same press just closed (heard first as a press in the page): it stays closed.
    if (report.type === "activated" && sameMarkAgain(report.id)) return;
    layerAnnotation?.(report, box ? { left: box.left, top: box.top, width: box.width, height: box.height, focused } : null);
  }, [layerAnnotation, frameBox]);

  // A frame that failed or fell back says so to the comments (a landing waiting for its `anchored`
  // shows the list meanwhile); back once it isn't (a retry, or this frame gone).
  const failed = state.status === "error" || state.status === "fallback";
  // Loaded and shown: what waits for the page (the touch hint, over the header while it loads) may
  // show now; not once the page falls back or fails after it loaded (an expired session's reload).
  const reportLoaded = comments?.pageLoaded;
  const pageShown = pageLoaded && state.status === "ready";
  useEffect(() => {
    if (!pageShown || !reportLoaded) return;
    reportLoaded(true);
    return () => reportLoaded(false);
  }, [pageShown, reportLoaded]);
  const frameFailed = comments?.frameFailed;
  useEffect(() => {
    if (!failed || !frameFailed) return;
    frameFailed(true);
    return () => frameFailed(false);
  }, [failed, frameFailed]);

  // Find in page (artifactFind): this frame is the find bar's target where its page may be searched.
  // Its handle finds, on a frame that declares `find` (one with a bar); a new attempt or run is
  // other content (the key), whose query Porthole forgot.
  const frameHandle = useRef<PortholeFrameHandle | null>(null);
  // Comment mode's layer has a handle of its own; the comments' (`focusMark`) is there on either layer.
  const layerHandles = useMergedRef(layer?.handle, comments?.frame.handle);
  const boxRef = useMergedRef(setFrameBox, comments?.frame.box);
  const handleRef = useMergedRef(layerHandles, frameHandle);
  const findState = state.status === "locating" ? "waiting" : state.status === "ready" ? "ready" : "unsupported";
  const findKey = `${id}@${version}#${attempt}.${generation}`;
  const findTarget = useMemo<ArtifactFindTarget | null>(() => (PAGES_MAY_FIND ? {
    key: findKey,
    state: findState,
    find: (query, direction) => frameHandle.current?.find(query, { direction }) ?? Promise.resolve("unsupported" as const),
    clear: () => frameHandle.current?.clearFind(),
  } : null), [findKey, findState]);
  const findBar = useArtifactFindFrame(findTarget);
  const finding = findBar !== null && findTarget !== null && findState === "ready";
  // Only a frame that declares `find` gets the bar's callbacks.
  const findProps = finding ? { onFindRequested: findBar.requested, onFindUpdated: findBar.updated } : null;

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const openInTab = useCallback(() => { openArtifactWindow(pageUrl, id); }, [pageUrl, id]);

  // Stage 1 (the ticket) and stage 2 (the page starting) are one splash: the same element (keyed by
  // the attempt, the last child of the same root `div` in `locating` and in `ready`), so React keeps
  // the one instance when the frame mounts and only its line changes; its animations run on. A retry
  // is a new key, a new cover. A failure below draws its own screen instead; the cover never hides it.
  const splash = (stage: "getting" | "starting") => (
    <ArtifactLoadingSplash key={attempt} stage={stage} kind={kind} done={stage === "starting" && pageLoaded} startedAt={splashStartedAt} />
  );
  if (state.status === "locating") {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-busy="true" data-testid="artifact-viewer-frame-loading">
        {splash("getting")}
      </div>
    );
  }
  if (state.status === "ready") {
    const config = finding ? state.config : withoutFind(state.config);
    // The attempt's own (its first answer's): a reload of the same version keeps it, so the frame does too.
    const { instance } = state;
    if (layer) {
      // The error strip lies over the frame's top, right under the panel header, where the DS puts a
      // PanelNotice ("a full-width strip under the header for a problem in this panel"; xxchan: at
      // the foot it was seen last). A sibling of the frame's box and never in it: the box places what
      // the frame reports (markers, cards), so it must not move or shrink when the strip comes and
      // goes. Its slot is kept when empty, so the frame stays on one DOM node.
      return (
        // The loading splash is another sibling over the box, under the strip (an error is never hidden).
        <div ref={setMovedRoot} {...{ [FRAME_MOVED_ATTRIBUTE]: "" }} className="relative flex min-h-0 flex-1 flex-col" aria-busy={pageLoaded ? undefined : true}>
          <div className="pointer-events-none absolute inset-x-0 top-0 z-chrome [&>*]:pointer-events-auto">
            <ArtifactPageErrorNotice errors={pageErrors} />
          </div>
          <div ref={boxRef} className="flex min-h-0 flex-1 flex-col" data-testid="artifact-frame-annotated">
            <PortholeProvider locator={locator} scheme={scheme} renderConfirm={renderConfirm}>
              <PortholeFrame
                config={config}
                displayId={`artifact:${id}@${version}`}
                title={title}
                instance={instance}
                declaration={NO_DECLARATION}
                viewer={PAGE_VIEWER}
                scheme={scheme}
                theme={pageTheme}
                handlers={handlers}
                generation={generation}
                eager
                onOutcome={onOutcome}
                onNavigationBlocked={onNavigationBlocked}
                annotating={layer.annotating(kind)}
                annotations={marks}
                focusedAnnotation={layer.focusedMark}
                trackedAnnotation={trackedMark}
                trackedSelection={layer.trackedSelection}
                ref={handleRef}
                onAnnotation={onAnnotation}
                onContentError={onContentError}
                {...findProps}
                className="min-h-0 flex-1"
                style={FILL}
              />
            </PortholeProvider>
          </div>
          {splash("starting")}
          {forkAsk.dialog}
        </div>
      );
    }
    return (
      <div ref={setMovedRoot} {...{ [FRAME_MOVED_ATTRIBUTE]: "" }} className="relative flex min-h-0 flex-1 flex-col" aria-busy={pageLoaded ? undefined : true}>
        <PortholeProvider locator={locator} scheme={scheme} renderConfirm={renderConfirm}>
          <PortholeFrame
            config={config}
            displayId={`artifact:${id}@${version}`}
            title={title}
            instance={instance}
            declaration={NO_DECLARATION}
            viewer={PAGE_VIEWER}
            scheme={scheme}
            theme={pageTheme}
            handlers={handlers}
            generation={generation}
            eager
            onOutcome={onOutcome}
            onNavigationBlocked={onNavigationBlocked}
            // Here too (the public page, a reader with no comments): refused once, the frame would
            // keep a focus Porthole never saw the person move, and refuse every later press.
            ref={handleRef}
            {...findProps}
            className="min-h-0 flex-1"
            style={FILL}
          />
        </PortholeProvider>
        {splash("starting")}
        {forkAsk.dialog}
      </div>
    );
  }
  const action = (label: string, icon: ReactNode, onClick: () => void, testId: string) => (
    <Button variant="outline" size="md" onClick={onClick} data-testid={testId}>
      {icon}
      {label}
    </Button>
  );
  const retryAction = action(formatMessage({ id: "artifacts.frame.retry" }), <RefreshCw />, retry, "artifact-frame-retry");
  if (state.status === "fallback") {
    switch (state.kind) {
      case "needs-tab":
        return (
          <FrameState
            testId="artifact-frame-needs-tab"
            icon={<ArrowUpRight size={36} />}
            title={formatMessage({ id: "artifacts.frame.needsTabTitle" })}
            description={formatMessage({ id: "artifacts.frame.needsTabBody" })}
            action={action(formatMessage({ id: artifactOpenLabelId("artifacts.frame.openInNewTab") }), <ArrowUpRight />, openInTab, "artifact-frame-open-tab")}
          />
        );
      case "denied":
        return (
          <FrameState
            testId="artifact-frame-denied"
            icon={<ShieldOff size={36} />}
            title={formatMessage({ id: "artifacts.frame.deniedTitle" })}
            description={formatMessage({ id: "artifacts.frame.deniedBody" })}
          />
        );
      case "expired":
        return (
          <FrameState
            testId="artifact-frame-expired"
            icon={<Clock size={36} />}
            title={formatMessage({ id: "artifacts.frame.expiredTitle" })}
            action={retryAction}
          />
        );
      default:
        return (
          <FrameState
            testId="artifact-frame-failed"
            icon={<FileX size={36} />}
            title={formatMessage({ id: "artifacts.frame.failedTitle" })}
            action={retryAction}
          />
        );
    }
  }
  switch (state.code) {
    case "NOT_VISIBLE":
      // The viewer's one "can't open" state: nothing about why.
      return (
        <FrameState
          testId="artifact-viewer-unavailable"
          icon={<FileX size={36} />}
          title={formatMessage({ id: "artifacts.viewer.unavailableTitle" })}
          description={formatMessage({ id: "artifacts.viewer.unavailableBody" })}
        />
      );
    case "VERSION_NOT_FOUND":
      return (
        <FrameState
          testId="artifact-frame-version-gone"
          icon={<FileX size={36} />}
          title={formatMessage({ id: "artifacts.frame.versionGoneTitle" })}
        />
      );
    case "NOT_FRAMED":
      return (
        <FrameState
          testId="artifact-viewer-no-preview"
          icon={<FileX size={36} />}
          title={formatMessage({ id: "artifacts.viewer.noPreview" })}
          action={onDownload
            ? action(formatMessage({ id: "artifacts.menu.download" }), <Download />, onDownload, "artifact-frame-download")
            : onOpenInRaft ? action(formatMessage({ id: "artifacts.public.openInRaft" }), <LogIn />, onOpenInRaft, "artifact-frame-open-in-raft") : undefined}
        />
      );
    case "RATE_LIMITED":
      // No retry loop: the person tries again when they want to.
      return (
        <FrameState
          testId="artifact-frame-rate-limited"
          icon={<Clock size={36} />}
          title={formatMessage({ id: "artifacts.frame.rateLimitedTitle" })}
          description={formatMessage({ id: "artifacts.frame.tryLater" })}
          action={retryAction}
        />
      );
    case "CONTENT_UNAVAILABLE":
      return (
        <FrameState
          testId="artifact-frame-content-unavailable"
          icon={<FileX size={36} />}
          title={formatMessage({ id: "artifacts.frame.contentUnavailableTitle" })}
          description={formatMessage({ id: "artifacts.frame.tryLater" })}
          action={retryAction}
        />
      );
    default:
      // INVALID_REQUEST and anything unexpected.
      return (
        <FrameState
          testId="artifact-frame-failed"
          icon={<FileX size={36} />}
          title={formatMessage({ id: "artifacts.frame.failedTitle" })}
          action={retryAction}
        />
      );
  }
}
