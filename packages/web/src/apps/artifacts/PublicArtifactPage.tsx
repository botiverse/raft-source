import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, FileX, LogIn, X } from "lucide-react";
import {
  Button,
  Panel,
  PanelAction,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelMeta,
  PanelStatus,
  PanelTitle,
  RaftLogo,
} from "@botiverse/raft-ui";
import { isArtifactFramedKind } from "@botiverse/raft-shared";
import type { ArtifactId, ArtifactPublicView } from "@botiverse/raft-shared";

import EmptyState from "../../components/ui/EmptyState";
import Tooltip from "../../components/ui/Tooltip";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { formatRelativeTime } from "../../utils/relativeTime";
import { useArtifactPageDocumentTitle } from "../../utils/browserDocumentTitle";
import { publicArtifactFrame, publicArtifactView } from "./apiArtifactSource";
import { isArtifactDrawnKind } from "./artifactDrawnKind";
import { PublicArtifactDrawn } from "./PublicArtifactDrawn";
import ArtifactFrame from "./ArtifactFrame";
import { useArtifactFindBodyShortcut, useArtifactFindKeyDown } from "./artifactFind";
import { ArtifactFindAction, ArtifactFindBar, ArtifactFindProvider } from "./ArtifactFindBar";
import { PHONE_QUERY } from "./artifactPhoneHistory";
import ArtifactLinkLoading from "./ArtifactLinkLoading";
import { artifactLinkWaitStarted } from "./artifactLinkWait";
import { ArtifactSplashScope } from "./ArtifactLoadingSplash";
import PublicArtifactAiActions from "./PublicArtifactAiActions";
import { PublicArtifactSendPreview } from "./PublicArtifactSendPreview";
import { artifactLinkSendNoteKey, artifactShareHost } from "./artifactShareHost";
import { markArtifactForkForSignIn, startArtifactForkNote, useArtifactForkMarker } from "./artifactForkInRaft";
import { ArtifactPageForkContext } from "./artifactPageForkContext";
import type { ArtifactPageFork } from "./artifactPageForkContext";
import { artifactPermalinkTarget, artifactUrl } from "./artifactLinks";
import { artifactAbuseHref } from "./artifactAbuseReport";
import { artifactReaderScopeIn } from "./artifactReaderScope";
import { takeViewerFrame } from "./artifactViewerFrame";
import { ArtifactVersionBadge } from "./ArtifactMessageCard";
import { CONTROL_END_PULL } from "../../components/ui/headEdges";

export { ARTIFACT_ABUSE_EMAIL } from "./artifactAbuseReport";

/** Raft's website (the landing page): where the Raft logo takes a visitor who isn't signed in. */
const RAFT_SITE_URL = "https://raft.build";

/** The phone's sign-up prompt, once closed, stays closed in this browser (localStorage, never a cookie). */
export const PUBLIC_ARTIFACT_BANNER_DISMISSED_KEY = "raft.artifacts.publicBannerDismissed";

function bannerDismissed(): boolean {
  try {
    return window.localStorage.getItem(PUBLIC_ARTIFACT_BANNER_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberBannerDismissed(): void {
  try {
    window.localStorage.setItem(PUBLIC_ARTIFACT_BANNER_DISMISSED_KEY, "1");
  } catch {
    // Private mode, quota: closed for this page only.
  }
}

/**
 * The public frame route, for ArtifactFrame (one stable function: the frame
 * reads it once per mount). The first frame after the canonical link's `open`
 * answered a signed-in outsider takes that answer's ticket instead, once
 * (artifactViewerFrame, held for this person reading as an outsider).
 */
const publicFrame = (id: ArtifactId, version: number) => {
  const ticket = takeViewerFrame(id, version, artifactReaderScopeIn(null));
  return ticket ? Promise.resolve(ticket) : publicArtifactFrame(id);
};

/**
 * Who reads the page. A visitor, not signed in: the sign-up prompt, and
 * sign-in (`onSignIn`, at this address; the login page also leads to
 * sign-up) wherever the page would open Raft. Someone signed in who reads
 * it as an outsider (the canonical link's `open` answered `opensIn: null`, or
 * 401: ArtifactPermalink): no prompt and nothing to sign in to; the header's
 * Raft logo (and the failure's Go to Raft) goes to their own home (`onBack`),
 * and `back`, when they came here from a page of the app (history back to
 * it), shows Back in the logo's place. Null: opened from outside, the logo.
 */
export type PublicArtifactReader =
  | { kind: "visitor"; onSignIn: () => void }
  | { kind: "signedIn"; onBack: () => void; back: (() => void) | null };

export interface PublicArtifactPageProps {
  /** The route's `:artifactId` and `:version`, as written in the address. */
  id: string | undefined;
  version: string | undefined;
  reader: PublicArtifactReader;
  /** Not public (the public view's one 404), or not an Artifact's address: the host's page instead (a visitor's sign-in at this address). */
  onUnavailable: () => void;
  /**
   * The view already read (the canonical link's `open`, answering a signed-in
   * outsider): shown at once instead of asking the public view. Only the
   * first attempt; Retry (after a failure, which then can't happen) asks.
   */
  known?: ArtifactPublicView;
}

type PageState =
  | { status: "loading" }
  | { status: "ready"; view: ArtifactPublicView }
  | { status: "failed" };

/**
 * The canonical link (`/artifacts/<id>`, `/v/<n>`) for a visitor who is not
 * signed in, when the Artifact is public (public Artifacts v1): its title,
 * the current version in the content frame, a sign-up prompt as on Notion's
 * public pages, and Report Abuse in the header's ⋯. Modelled on the public
 * server page (pages/PublicServerPage.tsx), outside the signed-in shell: no
 * rail, no server, nothing of the reader's.
 *
 * - The header starts with the Raft logo (raft-ui's mark), named "Raft": a
 *   link to Raft's website (RAFT_SITE_URL) for a visitor, to their own Raft
 *   for someone signed in (xxchan, Kirby, #proj-workspace:271de2d0). Only
 *   a signed-in reader who came here from a page of the app (`reader.back`)
 *   has Back there instead, to that page.
 * - The prompt: from `sm` up, a strip above the header, the sentence and
 *   Sign Up or Log In centred together, not closable; on a phone, a block
 *   under the header (the sentence, Sign Up or Log In under it, × at the
 *   top right), closed for good in this browser. Both are in the DOM; CSS
 *   shows one. The sentence says what Raft is to a visitor who isn't signed
 *   in, so it stays (xxchan, Kirby: not helper text, the one exception to #250).
 *
 * - Only the current version, whatever the link pins: a `/v/<n>` link shows
 *   it without a word about the version it named.
 * - Fork in Raft, the header's pink button before ⋯ (#proj-workspace:#140,
 *   xxchan): for a signed-in reader, Send to conversation
 *   (#proj-workspace:#128): core's dialog (artifactShareHost's
 *   LinkSendDialog) sends the link as a message in a server of theirs, its
 *   note started with Fork's words (editable; nothing is copied on the
 *   server). A visitor signs in first: the address takes `?fork=1`, sign-in
 *   (or sign-up) comes back to it, and the page signed in takes it once and
 *   opens the dialog (artifactForkInRaft). A reader in no server goes to the
 *   app's own first-server flow instead (the dialog's).
 * - In the header's ⋯, first, Copy link (this page's address, the public
 *   link), then, for a signed-out visitor only, Copy for AI, Open in
 *   ChatGPT and Open in Claude (PublicArtifactAiActions: a signed-in reader
 *   has their agents in Raft, xxchan). Last, apart, Report Abuse: a mail to
 *   ARTIFACT_ABUSE_EMAIL naming the link (no footer of its own, xxchan).
 * - No comments, history, follow, downloads, server, channel or presence
 *   (downloads are the Artifact's own server's members', xxchan). The page's
 *   own comment button (Porthole's `comments.open`) hears false and Raft asks
 *   "Comment on your own copy?" with Fork in Raft, which does what the
 *   header's does (a visitor signs in first, and is told so: they have no
 *   server to fork into yet), as another server's reader is asked in the
 *   viewer (ArtifactPageForkContext, useArtifactPageForkAsk).
 * - Find in page, as in the viewer (artifactFind, ArtifactFindBar; the same
 *   state, bar and keys): where the frame's page may be searched
 *   (artifactFrameFind `findAllowed`) and hasn't said it can't be, Cmd/Ctrl+F
 *   (on the panel, in the framed page, or on the body: the page is the whole
 *   document) opens the bar under the header; the header has Find in page
 *   before Fork in Raft, folded into ⋯ on a phone, as the Artifact's own
 *   page's header does. A kind with no frame has none (text, a csv or an
 *   image is on the page itself, so the browser's own find reads it).
 * - A kind Raft draws itself (text, a csv, an image) is drawn here too, by
 *   the viewer's renderers from the signed-out file route
 *   (PublicArtifactDrawn), read-only. Any other kind with no frame, or one
 *   whose file can't be read here, says so and offers a visitor sign-in.
 * - The public view's one 404 (not found, not public, deleted, revoked,
 *   Artifacts off) hands back to the host's sign-in at the same address: it
 *   may be a member's Artifact. Anything else (offline, too many at once)
 *   offers Retry.
 * - `noindex`, as the routes' X-Robots-Tag and the content's.
 *
 * Signed in (`reader.kind` "signedIn"), the same page read-only, for a
 * public Artifact of a server the reader doesn't read it in: what a visitor
 * sees, without the prompt or Ask AI's three, the logo going to the reader's home (or Back).
 * Drawn from `known` (the canonical link's `open` answer, its first frame
 * that answer's ticket) when given, else from the same public routes; it
 * enters no server and sends none (apiArtifactSource).
 */
/**
 * The tab's title once the public view is in (`<title> | Raft`, as the page's HTML already says it): public, so an
 * in-app browser's share card may carry it. While it loads the title stays as the page came; it fails: "Raft".
 */
function PublicArtifactDocumentTitle({ title }: { title: string | null }) {
  useArtifactPageDocumentTitle(title, { shareable: true });
  return null;
}

/**
 * The page's panel, its own find state around it (ArtifactFindProvider: the header, the bar and the frame are inside):
 * the element that holds the find bar (`data-artifact-focus`, where focus goes back when the bar closes), its keys
 * (Cmd/Ctrl+F, Esc while the bar is open: useArtifactFindKeyDown) and Cmd/Ctrl+F on the body (the page is the whole
 * document, in scope from the start), as the Artifact's own page's.
 */
function PublicArtifactPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <ArtifactFindProvider>
      <PublicArtifactFindPanel title={title}>{children}</PublicArtifactFindPanel>
    </ArtifactFindProvider>
  );
}

function PublicArtifactFindPanel({ title, children }: { title: string; children: ReactNode }) {
  const onKeyDown = useArtifactFindKeyDown();
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  useArtifactFindBodyShortcut(panel, { wholePage: true });
  return (
    <Panel ref={setPanel} tabIndex={-1} edge="inset" aria-label={title} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col outline-none keyboard:focus-visible:outline-2 keyboard:focus-visible:outline-solid keyboard:focus-visible:-outline-offset-2 keyboard:focus-visible:outline-foreground" data-artifact-focus="" data-testid="public-artifact-panel">
      {children}
    </Panel>
  );
}

export default function PublicArtifactPage({ id, version, reader, onUnavailable, known }: PublicArtifactPageProps) {
  const { formatMessage, locale } = useIntl();
  // On a phone the header folds Find in page into ⋯, as the Artifact's own page's does.
  const phone = useMediaQuery(PHONE_QUERY);
  const target = artifactPermalinkTarget(id, version);
  const targetId = target?.id ?? null;
  const [state, setState] = useState<{ key: string; page: PageState } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const [phonePromptOpen, setPhonePromptOpen] = useState(() => !bannerDismissed());
  const closePrompt = useCallback(() => {
    rememberBannerDismissed();
    setPhonePromptOpen(false);
  }, []);
  const key = `${targetId}|${attempt}`;
  // Send to conversation: a signed-in reader, where core offers the dialog.
  const LinkSendDialog = reader.kind === "signedIn" ? artifactShareHost().LinkSendDialog : undefined;
  const [sendOpen, setSendOpen] = useState(false);
  const closeSend = useCallback(() => setSendOpen(false), []);
  // Fork in Raft (#proj-workspace:#140): that dialog, its note started; a visitor signs in first, back to it here.
  const forkOffered = reader.kind === "visitor" || LinkSendDialog !== undefined;
  const fork = useCallback(() => {
    if (reader.kind === "visitor") {
      markArtifactForkForSignIn();
      reader.onSignIn();
      return;
    }
    if (targetId === null) return;
    startArtifactForkNote(artifactLinkSendNoteKey(artifactUrl(targetId)), formatMessage);
    setSendOpen(true);
  }, [reader, targetId, formatMessage]);
  // The page's own comment button asks to fork instead (useArtifactPageForkAsk): the same Fork in Raft.
  const signedOut = reader.kind === "visitor";
  const pageFork = useMemo<ArtifactPageFork | null>(() => (forkOffered ? { open: fork, signedOut } : null), [forkOffered, fork, signedOut]);
  // Back from sign-in with the marker (`?fork=1`): the dialog opens once, and the marker leaves the address.
  // A visitor's page leaves it for the sign-in it waits for.
  useArtifactForkMarker(reader.kind === "visitor" ? "wait" : LinkSendDialog ? "open" : "drop", fork);

  // The host's callback, whatever its identity: the address and the attempt alone decide when to ask.
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  const seeded = known !== undefined && attempt === 0 && targetId !== null && known.id === targetId ? known : null;
  useEffect(() => {
    if (targetId === null) {
      onUnavailableRef.current();
      return;
    }
    if (seeded) return;
    let cancelled = false;
    publicArtifactView(targetId).then(
      (view) => {
        if (!cancelled) setState({ key, page: { status: "ready", view } });
      },
      (error: unknown) => {
        if (cancelled) return;
        if ((error as { status?: unknown } | null)?.status === 404) onUnavailableRef.current();
        else setState({ key, page: { status: "failed" } });
      },
    );
    return () => { cancelled = true; };
  }, [key, targetId, seeded]);

  const page: PageState = seeded ? { status: "ready", view: seeded } : state?.key === key ? state.page : { status: "loading" };
  const noindex = <meta name="robots" content="noindex" />;

  if (page.status === "loading") {
    // The canonical link's own loading splash, the same wait (artifactLinkWait): what it showed from its first frame on.
    return (
      <>
        {noindex}
        <ArtifactLinkLoading testId="public-artifact-loading" />
      </>
    );
  }
  if (page.status !== "ready" || targetId === null) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-layer-sidebar px-4 font-display safe-top safe-bottom" data-testid={`public-artifact-${page.status}`}>
        {noindex}
        <PublicArtifactDocumentTitle title={null} />
        <EmptyState
          icon={<FileX size={36} />}
          title={formatMessage({ id: "artifacts.permalink.failedTitle" })}
          titleHeading="h2"
          action={(
            <>
              {reader.kind === "visitor" ? (
                <Button type="button" variant="outline" size="md" onClick={reader.onSignIn}>{formatMessage({ id: "artifacts.public.signIn" })}</Button>
              ) : (
                <Button type="button" variant="outline" size="md" onClick={reader.onBack}>{formatMessage({ id: "artifacts.permalink.leave" })}</Button>
              )}
              <Button type="button" size="md" onClick={retry}>{formatMessage({ id: "artifacts.dashboard.retry" })}</Button>
            </>
          )}
        />
      </main>
    );
  }

  const { view } = page;
  const updated = formatRelativeTime(view.version.updatedAt, locale);
  // Addresses are built from the id in the address, never taken from the payload.
  const url = artifactUrl(targetId);
  const prompt = formatMessage({ id: "artifacts.public.banner" });
  const signUpOrLogIn = formatMessage({ id: "artifacts.public.signUpOrLogIn" });
  const closeLabel = formatMessage({ id: "artifacts.public.dismiss" });
  const reportLabel = formatMessage({ id: "artifacts.public.reportAbuse" });
  const forkLabel = formatMessage({ id: "artifacts.fork.inRaft" });
  const reportHref = artifactAbuseHref(url, formatMessage({ id: "artifacts.public.reportSubject" }));
  const onSignIn = reader.kind === "visitor" ? reader.onSignIn : null;
  const back = reader.kind === "signedIn" ? reader.back : null;
  // What can't be shown here: a kind with no preview at all, or one Raft draws whose file couldn't
  // be read (PublicArtifactDrawn's fallback). A visitor signs in to see it.
  const noPreview = (
    <div className="flex flex-1 items-center justify-center p-6" data-testid="public-artifact-no-preview">
      <EmptyState
        icon={<FileX size={36} />}
        title={formatMessage({ id: "artifacts.viewer.noPreview" })}
        // Why signing in: it tells a visitor what's happening (xxchan, Kirby, after #250).
        description={onSignIn ? formatMessage({ id: "artifacts.public.noPreviewSignIn" }) : undefined}
        action={onSignIn ? (
          <Button variant="outline" size="md" onClick={onSignIn} data-testid="public-artifact-open-in-raft">
            <LogIn />
            {formatMessage({ id: "artifacts.public.openInRaft" })}
          </Button>
        ) : undefined}
      />
    </div>
  );
  const backLabel = formatMessage({ id: "artifacts.permalink.back" });
  const logoLabel = formatMessage({ id: "brand.productName" });
  // DS RaftLogo › Accessibility: the mark has no name of its own; the control it stands in is named Raft.
  const logo = <RaftLogo aria-hidden="true" />;

  return (
    // A frame runs to the screen's edge: only the device inset below it, or the page's own ground shows
    // as a strip under a white page.
    <main className={`flex min-h-0 flex-1 flex-col bg-layer-canvas font-display safe-top ${isArtifactFramedKind(view.kind) ? "pb-[env(safe-area-inset-bottom)]" : "safe-bottom"}`} data-testid="public-artifact-page">
      {noindex}
      <PublicArtifactDocumentTitle title={view.title} />
      {onSignIn ? (
        // DS Banner › The sign-up prompt on a public page: not a Banner, a Button in a plain container (a 48px fill-subtle strip, centred).
        <div className="flex shrink-0 items-center justify-center gap-6 bg-fill-subtle px-5 py-2 text-body text-foreground max-sm:hidden" data-testid="public-artifact-prompt">
          <p className="min-w-0">{prompt}</p>
          <Button type="button" variant="default" size="md" onClick={onSignIn} data-testid="public-artifact-sign-in">{signUpOrLogIn}</Button>
        </div>
      ) : null}
      <PublicArtifactPanel title={view.title}>
        <PanelHeader data-testid="public-artifact-header">
          {/* The header's start: Back only after a page of the app (history back to it); else the Raft logo,
              to Raft's website for a visitor, to their own Raft for someone signed in (#proj-workspace:271de2d0). */}
          {back ? (
            <Tooltip content={backLabel}>
              <PanelAction aria-label={backLabel} onClick={back} activateOnTouchEnd data-testid="public-artifact-back">
                <ArrowLeft />
              </PanelAction>
            </Tooltip>
          ) : reader.kind === "signedIn" ? (
            <PanelAction aria-label={logoLabel} onClick={reader.onBack} data-testid="public-artifact-logo">
              {logo}
            </PanelAction>
          ) : (
            <PanelAction nativeButton={false} role="link" render={<a href={RAFT_SITE_URL} aria-label={logoLabel} />} data-testid="public-artifact-logo">
              {logo}
            </PanelAction>
          )}
          <PanelHeaderContent>
            <PanelHeading>
              <PanelTitle data-testid="public-artifact-title">{view.title}</PanelTitle>
              <PanelStatus><ArtifactVersionBadge version={view.version.number} /></PanelStatus>
            </PanelHeading>
            {/* Anyone with the link reads it here, made by someone the reader can't see (xxchan): say so in the bar.
                First, so a narrow bar's truncation cuts the time, never this (Kirby). */}
            <PanelMeta data-testid="public-artifact-meta">
              <span data-testid="public-artifact-unverified">{formatMessage({ id: "artifacts.public.unverified" })}</span>
              {updated ? (
                <span>
                  {formatMessage({ id: "artifacts.presence.summarySeparator" })}
                  {formatMessage({ id: "artifacts.public.updated" }, { time: updated })}
                </span>
              ) : null}
            </PanelMeta>
          </PanelHeaderContent>
          {phone ? null : <ArtifactFindAction testId="public-artifact-find" />}
          {forkOffered ? (
            // The page's one pink action (Raft DS › Button: a labelled `md` Button is a panel header's), before ⋯.
            <Button type="button" variant="primary" size="md" className="shrink-0" onClick={fork} data-testid="public-artifact-fork">
              {forkLabel}
            </Button>
          ) : null}
          {/* Copy for AI, Open in ChatGPT, Open in Claude: this page exists only for a public Artifact (#proj-workspace:#101),
              and only a signed-out visitor is offered them (a signed-in reader asks their agents in Raft). Copy link first and
              Report Abuse last, for all. */}
          <PublicArtifactAiActions id={targetId} title={view.title} link={url} askAi={reader.kind === "visitor"} reportLabel={reportLabel} reportHref={reportHref} findInMenu={phone} />
        </PanelHeader>
        <ArtifactFindBar />
        {onSignIn && phonePromptOpen ? (
          // DS Banner › The sign-up prompt on a public page: on a phone, info-soft under the header, the button under the text and a × (not a Banner, which has one or the other).
          <div className="shrink-0 bg-info-soft px-4 pt-3 pb-4 text-body font-medium text-info-strong sm:hidden" data-testid="public-artifact-prompt-phone">
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 pt-1">{prompt}</p>
              <Button type="button" variant="ghost" size="icon-lg" aria-label={closeLabel} onClick={closePrompt} className={CONTROL_END_PULL} data-testid="public-artifact-prompt-close">
                <X />
              </Button>
            </div>
            <Button type="button" variant="default" size="md" className="mt-3" onClick={onSignIn} data-testid="public-artifact-sign-in-phone">{signUpOrLogIn}</Button>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col" data-testid="public-artifact-body">
          {isArtifactFramedKind(view.kind) ? (
            // The link's loading splash continues over the frame, from when the link's wait began (artifactLinkWait).
            <ArtifactSplashScope openingKey={`${targetId}@${view.version.number}`} size="page" initialStart={artifactLinkWaitStarted}>
              {/* The page's own comment button (Porthole's comments.open): no comments here, so Raft asks "Comment on your
                  own copy?" and Fork in Raft is the header's (a visitor signs in first), as for another server's reader
                  in the viewer (useArtifactPageForkAsk). */}
              <ArtifactPageForkContext value={pageFork}>
                <ArtifactFrame
                  // Another version is another frame, with its own ticket.
                  key={`${targetId}@${view.version.number}`}
                  id={targetId}
                  version={view.version.number}
                  kind={view.kind}
                  title={view.title}
                  pageUrl={url}
                  locate={publicFrame}
                  // No sign-in, no analytics identity: nothing is reported.
                  analytics={false}
                  onOpenInRaft={onSignIn ?? undefined}
                />
              </ArtifactPageForkContext>
            </ArtifactSplashScope>
          ) : isArtifactDrawnKind(view.kind) ? (
            // Text, a csv, an image: Raft draws it here from the public file route (gap 1 of the feature matrix).
            <PublicArtifactDrawn id={targetId} version={view.version.number} kind={view.kind} title={view.title} fallback={noPreview} />
          ) : noPreview}
        </div>
      </PublicArtifactPanel>
      {LinkSendDialog && sendOpen ? (
        <LinkSendDialog
          link={url}
          preview={<PublicArtifactSendPreview title={view.title} version={view.version.number} link={url} />}
          onClose={closeSend}
        />
      ) : null}
    </main>
  );
}
