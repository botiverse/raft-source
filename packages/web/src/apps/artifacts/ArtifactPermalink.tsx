import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { ArtifactPublicView, ArtifactViewerData, ArtifactWebOpen } from "@botiverse/raft-shared";
import { ArrowLeft } from "lucide-react";
import { Button, Card, PanelAction, PanelHeader } from "@botiverse/raft-ui";

import Tooltip from "../../components/ui/Tooltip";
import { hasHostBack, isChromeless, isHostShell } from "../../embed";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useArtifactPageDocumentTitle } from "../../utils/browserDocumentTitle";
import ArtifactLinkLoading, { ArtifactHostBack } from "./ArtifactLinkLoading";
import { artifactOpenPath, artifactPagePath, artifactPermalinkTarget } from "./artifactLinks";
import { prefetchArtifactContentDns } from "./artifactOpenIntent";
import { openArtifact } from "./artifactOpenEarly";
import { PHONE_QUERY } from "./artifactPhoneHistory";
import { artifactSource, viewerKey } from "./artifactSource";
import type { ArtifactViewerSeed } from "./artifactSource";
import ArtifactStandalonePage from "./ArtifactStandalonePage";
import type { ArtifactStandaloneServer } from "./ArtifactStandalonePage";
import PublicArtifactPage from "./PublicArtifactPage";
import type { PublicArtifactReader } from "./PublicArtifactPage";

/**
 * The canonical link's page (G2): `https://app.raft.build/artifacts/<id>` and
 * `/artifacts/<id>/v/<n>` (artifactUrl), the address agents post, phones open
 * in a web view and "Open in new page" opens. The link names no server, so
 * the page makes one call, `open` (sent with no server; at boot already when
 * a token was stored, artifactOpenEarly), which answers where it opens and
 * what its viewer shows:
 *
 * - `opensIn` (a member who reads it in the Artifact's own server): that
 *   server becomes the current one (the host's `enterServer`: every read
 *   after it carries it, which decides what the reader may do), and the
 *   Artifact shows on a page of its own (ArtifactStandalonePage) drawn from
 *   the answer's viewer data, so its first screen asks nothing again; the
 *   pinned version kept. Not over the workspace: no rail, no sidebar. A
 *   server not in the reader's list here (joined meanwhile) opens it over
 *   that server's Artifacts page, which loads the list again.
 * - `opensIn: null` (a public Artifact of a server they don't read it in):
 *   read-only, as a visitor sees it, its Raft logo going to the reader's
 *   home, or Back (`onGoBack`) when there is an in-app page behind it
 *   (PublicArtifactPage, `signedIn`), drawn from the answer too: no server
 *   entered, none sent, no comments, history or presence. Whether a public
 *   Artifact opens depends on its own server alone, never on the reader's.
 * - 404: the "can't open" page at once, the same page for every reason (no
 *   such Artifact, not theirs to see, deleted, Artifacts off) and for an
 *   address that isn't an Artifact's, never a server's Artifacts page; it
 *   names nothing of the Artifact (Tenny's rule: what it shows can't tell
 *   one reason from another). Behind it, once, the earlier chain (the
 *   reader's server list, `locate` asked from one of their servers): `open`
 *   asks about the Artifact's own server alone, so an Artifact homed in a
 *   joint channel that the reader sees only through their other server is
 *   its 404, and `locate` still finds it (Tenny, #proj-workspace:1dbe5d8c:
 *   nobody who opens it today is locked out); then that server is entered
 *   and the page reads the viewer as usual. When `locate` finds nothing
 *   either, or fails, the page stays as it is.
 * - 401: the public page, which reads the public view itself (its own 404 is
 *   the "can't open" page).
 * - Anything else (offline, too many at once): a failure with Retry.
 *
 * Signed out, the host shows the public page when the Artifact is public,
 * else its sign-in at this same address (and a social sign-in returns to
 * it), so this page runs once someone is signed in.
 */
export interface ArtifactPermalinkProps {
  /** The route's `:id` and `:version`, as written in the address. */
  id: string | undefined;
  version: string | undefined;
  /** Go to an in-app address in place of this one. */
  onOpen: (path: string) => void;
  /**
   * Make the server `open` names the current one, so the page's reads carry
   * it: true once it is, false when it isn't in the reader's list here (the
   * page then opens it over that server's Artifacts page,
   * `?artifact=<id>&from=link`, which loads the list again). Waits for the
   * reader's server list only when entering needs it.
   */
  enterServer: (server: NonNullable<ArtifactWebOpen["opensIn"]>) => Promise<boolean>;
  /**
   * `open`'s 404 fallback: a server of the reader's to ask `locate` from
   * (the current one, else the last, else any), once their list is in; null
   * when they are in none.
   */
  locateFrom: () => Promise<{ id: string; slug: string } | null>;
  /** The fallback's located server (by slug) made current: its slug and name, or null when it isn't in the reader's list here. */
  enterLocated: (serverSlug: string) => ArtifactStandaloneServer | null;
  /** Go from the Artifact's page to an address in Raft (a new entry in the history): its home, or the server once it is deleted. */
  onGo: (path: string) => void;
  /** Show another version of the same Artifact: its page's address (a new entry in the history). */
  onShowVersion: (path: string) => void;
  /** Leave the "can't open" page, or the public view by its Raft logo, for the reader's own server (the last one they were in). */
  onLeave: () => void;
  /** Who is signed in (their email), for the "can't open" page's "Signed in as" line; none: no line. */
  account?: string | null;
  /** Sign out, to sign in as someone else at this same address (the "can't open" page's Switch Account); none: not offered. */
  onSwitchAccount?: () => void;
  /** Back to the in-app page before this one (the "can't open" page's Back, the Artifact page's and the public view's Back); none when there is no such page (a link opened from outside). */
  onGoBack?: () => void;
}

/** What the link's page says when it opens nothing: "can't open", or a failure with Retry. */
type PermalinkCardState = { status: "unavailable" } | { status: "failed" };

type Opened =
  // `seed` null: located by the fallback, the page reads the viewer.
  | { key: string; status: "standalone"; server: ArtifactStandaloneServer; seed: ArtifactViewerSeed | null }
  // Read-only: `view` from `open`'s answer, or null for the public page to read it (after a 401).
  | { key: string; status: "public"; view: ArtifactPublicView | null }
  | ({ key: string } & PermalinkCardState);

const CANT_OPEN: PermalinkCardState = { status: "unavailable" };

/** An outsider's viewer data (`open` with `opensIn: null`: the current version only) as the public page shows it. */
function publicViewOf(viewer: ArtifactViewerData): ArtifactPublicView {
  const { card } = viewer;
  const shown = viewer.versions.find((entry) => entry.number === card.version);
  return {
    id: card.id,
    title: card.title,
    kind: card.kind,
    version: { number: card.version, updatedAt: shown?.createdAt ?? card.updatedAt },
    attribution: { kind: "raft" },
  };
}

export default function ArtifactPermalink({ id, version, onOpen, enterServer, locateFrom, enterLocated, onGo, onShowVersion, onLeave, account = null, onSwitchAccount, onGoBack }: ArtifactPermalinkProps) {
  const target = artifactPermalinkTarget(id, version);
  const [state, setState] = useState<Opened | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const targetId = target?.id ?? null;
  const targetVersion = target?.version ?? null;
  // Where it opens doesn't depend on the version: switching versions doesn't ask again (the page reads the viewer).
  const key = `${targetId}|${attempt}`;
  const targetVersionRef = useRef(targetVersion);
  targetVersionRef.current = targetVersion;

  // The host's callbacks, whatever their identity: the address and attempt alone decide when to ask.
  const enterRef = useRef(enterServer);
  enterRef.current = enterServer;
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const locateFromRef = useRef(locateFrom);
  locateFromRef.current = locateFrom;
  const enterLocatedRef = useRef(enterLocated);
  enterLocatedRef.current = enterLocated;
  useEffect(() => {
    if (targetId === null) return;
    // The id is all its content origin needs: the connection opens while `open` is answered.
    prefetchArtifactContentDns(targetId);
    let cancelled = false;
    const asked = { id: targetId, version: targetVersionRef.current };
    const settle = (next: Opened) => {
      if (!cancelled) setState(next);
    };
    // Behind `open`'s 404 ("can't open" already shown), once: the earlier chain, for an Artifact of a joint channel
    // the reader sees from their other server. Only finding it changes the page; anything else leaves "can't open".
    const locateBehind = async () => {
      const from = await locateFromRef.current();
      if (cancelled || !from) return;
      const location = await artifactSource().locate(targetId, from);
      // serverArtifactsOff (public, seen only from servers of theirs with Artifacts off): `open`, which reads a public
      // Artifact as an outsider, already answered 404, so the public view would refuse too.
      if (cancelled || location.serverArtifactsOff) return;
      const server = enterLocatedRef.current(location.serverSlug);
      // Not in the reader's list here (joined meanwhile): over that server's Artifacts page, which loads the list again.
      if (!server) return openRef.current(`/s/${encodeURIComponent(location.serverSlug)}${artifactOpenPath(targetId, targetVersionRef.current, "link")}`);
      settle({ key, status: "standalone", server, seed: null });
    };
    // Sent at boot already when a token was stored (artifactOpenEarly): that answer, once.
    openArtifact(asked).then(async ({ opensIn, viewer }) => {
      if (!opensIn) return settle({ key, status: "public", view: publicViewOf(viewer) });
      if (cancelled) return;
      if (!(await enterRef.current(opensIn))) {
        // Not in the reader's list here (joined meanwhile): over that server's Artifacts page, which loads the list again.
        if (!cancelled) openRef.current(`/s/${encodeURIComponent(opensIn.slug)}${artifactOpenPath(targetId, targetVersionRef.current, "link")}`);
        return;
      }
      settle({ key, status: "standalone", server: { slug: opensIn.slug, name: opensIn.name }, seed: { key: viewerKey(asked), data: viewer } });
    }, (error: unknown) => {
      const status = (error as { status?: unknown } | null)?.status;
      if (status === 401) settle({ key, status: "public", view: null });
      else if (status === 404) {
        // The answer is the page: "can't open" now, not after the server list and `locate` (which ask again what
        // `open` just said for all but a joint channel's Artifact). Not found there either (404, Artifacts off)
        // or failed: the page stays.
        settle({ key, ...CANT_OPEN });
        locateBehind().catch(() => {});
      } else settle({ key, status: "failed" });
    });
    return () => { cancelled = true; };
  }, [key, targetId]);

  const pickVersion = useCallback((picked: number | null) => {
    if (targetId !== null) onShowVersion(artifactPagePath(targetId, picked));
  }, [targetId, onShowVersion]);

  const current = state?.key === key ? state : null;
  const publicRefused = useCallback(() => setState({ key, ...CANT_OPEN }), [key]);
  // The public page's logo goes to the reader's home; Back in its place only after an in-app page.
  const reader = useMemo<PublicArtifactReader>(() => ({ kind: "signedIn", onBack: onLeave, back: onGoBack ?? null }), [onLeave, onGoBack]);
  const unavailable = <PermalinkCard card={CANT_OPEN} onLeave={onLeave} account={account} onSwitchAccount={onSwitchAccount} onGoBack={onGoBack} />;
  if (target && current?.status === "standalone") {
    const { server, seed } = current;
    return (
      <ArtifactStandalonePage
        // Another Artifact or server is another page; another version is the same page, switching in place.
        key={`${target.id}|${server.slug}`}
        target={target}
        server={server}
        seed={seed}
        onGoBack={onGoBack}
        onGo={onGo}
        onPickVersion={pickVersion}
        unavailable={unavailable}
      />
    );
  }
  if (target && current?.status === "public") {
    // The signed-out page's content and routes, read-only; its one 404 is this page's "can't open".
    return <PublicArtifactPage key={target.id} id={id} version={version} reader={reader} known={current.view ?? undefined} onUnavailable={publicRefused} />;
  }
  const card: PermalinkCardState | null = targetId === null
    ? CANT_OPEN
    : current?.status === "unavailable" || current?.status === "failed" ? current : null;

  if (card === null) return <ArtifactLinkLoading testId="artifact-permalink-opening" onGoBack={onGoBack} />;
  if (card.status === "unavailable") return unavailable;
  return <PermalinkCard card={card} onRetry={retry} onLeave={onLeave} />;
}

interface PermalinkCardProps {
  card: PermalinkCardState;
  onRetry?: () => void;
  onLeave: () => void;
  account?: string | null;
  onSwitchAccount?: () => void;
  onGoBack?: () => void;
}

/**
 * The link's "can't open" page, and its failure with Retry.
 *
 * "Can't open" is one page for every reason (no access, not found, deleted, an
 * address that isn't an Artifact's): the same words, title and actions, and
 * nothing of the Artifact (its title, author, channel or server), so it can't
 * tell anyone whether the Artifact exists (Tenny's rule, regression-guarded in
 * artifactLinkNoAccess.behavior). What it may say: who is signed in, and to ask
 * whoever shared the link. Its ways out: Go to Raft (the one primary action:
 * the reader's last server), Switch Account (signed in as the wrong person is
 * the commonest reason) and Back when there is an in-app page to go back to
 * (on a phone in the top-left of a header bar, as every phone page has it).
 * In the App with `back=host` (embed.ts), which draws no title bar over the
 * page, a toolbar starts with the App's Back (ArtifactHostBack: `#host=close`,
 * as the Artifact's own page has it), on "can't open" and on a failure alike;
 * with `chrome=none` the App draws that toolbar itself.
 */
function PermalinkCard({ card, onRetry, onLeave, account = null, onSwitchAccount, onGoBack }: PermalinkCardProps) {
  const { formatMessage } = useIntl();
  const phone = useMediaQuery(PHONE_QUERY);
  // The tab names nothing of the Artifact either: "Raft", whatever the page showed before.
  useArtifactPageDocumentTitle(null);
  const { status } = card;
  const unavailable = status === "unavailable";
  const title = formatMessage({ id: unavailable ? "artifacts.viewer.unavailableTitle" : "artifacts.permalink.failedTitle" });
  const backLabel = formatMessage({ id: "artifacts.permalink.back" });
  // Raft's app draws its own title bar with Back over the page: no second one. With `back=host` it
  // draws none, and the page's toolbar starts with the App's Back (`#host=close`), as the page's does.
  const phoneBack = unavailable && onGoBack && phone && !isHostShell();
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-layer-sidebar font-display safe-top safe-bottom" data-testid="artifact-permalink">
      {hasHostBack() && !isChromeless() ? (
        <PanelHeader className="border-b border-line-seam bg-layer-canvas" data-embed-shell="host" data-testid="artifact-permalink-toolbar">
          <ArtifactHostBack />
        </PanelHeader>
      ) : phoneBack ? (
        <PanelHeader className="border-b border-line-seam bg-layer-canvas" data-testid="artifact-permalink-header">
          <Tooltip content={backLabel}>
            <PanelAction aria-label={backLabel} onClick={onGoBack} data-testid="artifact-permalink-back">
              <ArrowLeft />
            </PanelAction>
          </Tooltip>
        </PanelHeader>
      ) : null}
      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        <Card className="w-full max-w-md p-6" data-testid={`artifact-permalink-${status}`}>
          <h1 className="text-title text-foreground">{title}</h1>
          {unavailable ? <p className="mt-3 text-callout text-foreground-muted">{formatMessage({ id: "artifacts.permalink.unavailableBody" })}</p> : null}
          {unavailable && account ? (
            <p className="mt-3 text-footnote text-foreground-hint" data-testid="artifact-permalink-account">
              {formatMessage({ id: "pages.humanLogin.signedInAsPrefix" })} <span className="font-medium text-foreground-muted">{account}</span>
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2">
            {status === "failed" && onRetry ? (
              <Button type="button" size="lg" onClick={onRetry}>{formatMessage({ id: "artifacts.dashboard.retry" })}</Button>
            ) : null}
            <Button type="button" variant={unavailable ? "primary" : "outline"} size="lg" onClick={onLeave}>{formatMessage({ id: "artifacts.permalink.leave" })}</Button>
            {unavailable && onSwitchAccount ? (
              <Button type="button" variant="outline" size="lg" onClick={onSwitchAccount}>{formatMessage({ id: "artifacts.permalink.switchAccount" })}</Button>
            ) : null}
            {unavailable && onGoBack && !phone ? (
              <Button type="button" variant="ghost" size="lg" onClick={onGoBack} data-testid="artifact-permalink-back">{backLabel}</Button>
            ) : null}
          </div>
        </Card>
      </div>
    </main>
  );
}
