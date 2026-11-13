import { useCallback, useEffect, useId, useState } from "react";
import { useIntl } from "react-intl";
import { Laptop } from "lucide-react";
import { Banner, BannerAction, BannerClose, BannerDescription, BannerTitle, Button, Checkbox, TextLink } from "@botiverse/raft-ui";
import api from "../../api/client";
import type { MessageId } from "../../i18n/messages";
import { useAuthStore } from "../../store/authStore";
import { quietLinkOpenOffer, useLinkOpenPreference, useLinkOpenQuiet, writeLinkOpenPreference } from "../../store/linkOpenPreference";
import { isAppClaimedPath } from "../../utils/appClaimedPath";
import { canOpenInDesktopApp, DESKTOP_APP_OPENING_MS, desktopAppDeepLink, openInDesktopApp } from "../../utils/desktopAppLink";
import { desktopDownloadUrl } from "../../utils/desktopDownload";
import type { DesktopTarget } from "../../utils/desktopDownload";
import { parseMessageLink } from "../../utils/messageLinkLanding";
import { answerPageLandingOffer, isPageLandingOfferAnswered } from "../../utils/pageLanding";
import { useDesktopDownloadView } from "../settings/DesktopDownloadOptions";
import Tooltip from "../ui/Tooltip";
import { useOpenInAppOfferFlag, usePageLanding } from "./deepLinksFlag";

/**
 * Deep links v1, frame c: a desktop browser that opened a Raft address from
 * outside Raft (another app, an email, a chat; the first load, with no
 * referrer or another site's) offers to open it in Raft Desktop: any address
 * the app takes (utils/appClaimedPath.ts), a message link or not. It is about
 * the window, so it sits in the strip across its top (OpenInAppOffers), and
 * changes nothing else on the page.
 *
 * Everyone gets it, since the page cannot tell whether the app is installed.
 * With a reason to think it is (the account used Raft Desktop in the last 30
 * days, GET /auth/me's usedDesktopAppRecently) the banner says so; without
 * one it carries this computer's download instead. Signed out (the sign-in
 * page of a landed workspace address, SignInPage) nothing is known about the
 * person, so it is always the download, and nothing is asked of the server
 * but the before-login flag. The page never launches raft:// by itself
 * (Safari reports an unregistered scheme as an invalid address); only the
 * click does.
 *
 * After Open in Desktop App the banner does not just go: where the app isn't
 * installed the click does nothing at all (Chrome on Linux: no error, no
 * prompt), and "I clicked, nothing happened, the offer is gone" is a dead
 * end. It says "Opening Raft Desktop…" with "Nothing happened? Download for
 * Mac" and a × (DesktopAppOpeningBanner), until the person closes it, leaves
 * the page, the page goes out of sight, or DESKTOP_APP_OPENING_MS is up.
 *
 * An answer (either button) is for the landing, not for the component drawing
 * it: answered on the sign-in page, the workspace that loads after sign-in
 * does not ask again (utils/pageLanding.ts).
 *
 * Remembered (this browser only; "Remember my choice", or Settings ›
 * Appearance › How links open): "web" hides the banner for good; "app" shows
 * it without the hint, the download and the checkbox. Continue on Web without
 * remembering puts it away in this browser for 7 days (the preference stays
 * "ask"), so someone who stays on the web isn't asked on every new tab; Open
 * in Desktop App starts no such quiet time.
 *
 * Raft Design System › Banner: info tint, the title and one line, then
 * BannerAction holding the checkbox, the dismiss-like ghost Continue on Web
 * and the one ink-bordered button (a banner's button is never pink, so Open
 * in Desktop App is `default`, not the mockup's pink). The download is not a
 * second button: it is a text link (`TextLink` strong) in the description's
 * sentence, "Don't have it yet? Download for Mac".
 *
 * In the strip the banner is the strip: across the window with no radius and
 * no hairline, closed by the top bar's seam above and its own below (as a
 * PanelNotice is under a panel header, and as the phone's row is). A rounded,
 * ringed banner inset in a band with a seam of its own read as a box in a box.
 */
let desktopHintRead: Promise<boolean> | null = null;

function readDesktopAppHint(): Promise<boolean> {
  desktopHintRead ??= api
    .get<{ usedDesktopAppRecently?: unknown }>("/auth/me")
    .then(({ data }) => data?.usedDesktopAppRecently === true)
    .catch(() => false);
  return desktopHintRead;
}

export function resetDesktopAppHintForTests(): void {
  desktopHintRead = null;
}

/**
 * usedDesktopAppRecently from the profile the app loaded, else one read of
 * /auth/me (login and profile updates answer without it). Null until known,
 * so the banner doesn't change under the reader.
 */
function useDesktopAppHint(active: boolean): boolean | null {
  const fromProfile = useAuthStore((s) => s.user?.usedDesktopAppRecently === true);
  const [fetched, setFetched] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active || fromProfile) return;
    let cancelled = false;
    void readDesktopAppHint().then((value) => {
      if (!cancelled) setFetched(value);
    });
    return () => {
      cancelled = true;
    };
  }, [active, fromProfile]);
  if (!active) return null;
  return fromProfile ? true : fetched;
}

export default function DesktopAppLinkBanner() {
  // The address as it landed, while its page is on screen: the app may later
  // drop `msg` from it (Back to Bottom), and the offer is still about it.
  const landing = usePageLanding();
  if (!landing?.fromOutside || !isAppClaimedPath(landing.pathname, "desktop") || !canOpenInDesktopApp()) return null;
  return <DesktopAppLinkBannerGate pathname={landing.pathname} search={landing.search} />;
}

/** What the banner knows about Raft Desktop here: this browser was told, the account used it lately, or nothing. */
type DesktopAppSign = "remembered" | "used" | "none";

/** Asking; then, after Open in Desktop App, saying so for a while; then gone. */
type DesktopAppOfferPhase = "offer" | "opening" | "done";

function initialPhase(): DesktopAppOfferPhase {
  return isPageLandingOfferAnswered() ? "done" : "offer";
}

function DesktopAppLinkBannerGate({ pathname, search }: { pathname: string; search: string }) {
  const enabled = useOpenInAppOfferFlag();
  const signedIn = useAuthStore((s) => s.user !== null);
  const preference = useLinkOpenPreference();
  // Continue on Web, some days ago: "ask" is quiet until its time is up.
  const quiet = useLinkOpenQuiet() && preference === "ask";
  // Signed out there is no account to have a hint, and /auth/me is not asked.
  const hint = useDesktopAppHint(enabled && signedIn && preference === "ask" && !quiet);
  const [phase, setPhase] = useState(initialPhase);
  const answer = useCallback((next: "opening" | "done") => {
    answerPageLandingOffer();
    setPhase(next);
  }, []);
  const close = useCallback(() => setPhase("done"), []);
  if (!enabled || phase === "done" || preference === "web") return null;
  if (phase === "opening") return <DesktopAppOpeningBanner onClose={close} />;
  if (quiet || (preference === "ask" && signedIn && hint === null)) return null;
  return (
    <DesktopAppLinkBannerView
      sign={preference === "app" ? "remembered" : hint ? "used" : "none"}
      message={parseMessageLink(pathname, search) !== null}
      deepLink={desktopAppDeepLink({ pathname, search })}
      onAnswer={answer}
    />
  );
}

/**
 * This computer's download, for someone with no sign of Raft Desktop, as one
 * sentence under the title's question: "Don't have it yet? Download for Mac".
 * The link is the build Settings › About and /download recommend here, under
 * the same label and through the same /api/desktop-download link (a file, so
 * the page stays). A Mac whose chip the browser hides gets both builds,
 * joined as the language joins a choice ("… or …"), since nothing else here
 * names the Intel one. Nothing when the release has no build for this
 * computer. After the click the same links follow "Nothing happened?".
 */
function DesktopAppDownload({ messageId }: { messageId: "desktopAppLink.banner.download" | "desktopAppLink.banner.nothingHappened" }) {
  const { formatMessage, formatList } = useIntl();
  const { recommended } = useDesktopDownloadView();
  if (!recommended) return null;
  const builds: Array<{ target: DesktopTarget; labelId: MessageId }> = [recommended];
  if (recommended.intelHint) builds.push({ target: "mac-x64", labelId: "settings.desktopApp.download.macIntel" });
  const links = builds.map((build) => (
    <TextLink
      key={build.target}
      variant="strong"
      render={<a href={desktopDownloadUrl(build.target)} data-target={build.target}>{formatMessage({ id: build.labelId })}</a>}
    />
  ));
  return (
    <BannerDescription data-testid="desktop-app-link-download">
      {formatMessage({ id: messageId }, { download: formatList(links, { type: "disjunction" }) })}
    </BannerDescription>
  );
}

/**
 * After Open in Desktop App: what is happening, and what to do when it isn't.
 * No button, so it closes with a × (raft-ui Banner). It also goes by itself:
 * when the page goes out of sight (the app took over, or the person went to
 * another tab; back here "Opening…" would be stale) and after
 * DESKTOP_APP_OPENING_MS. Leaving the page spends the landing, and the
 * banner with it.
 */
function DesktopAppOpeningBanner({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  useEffect(() => {
    const timer = window.setTimeout(onClose, DESKTOP_APP_OPENING_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") onClose();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [onClose]);
  const closeLabel = formatMessage({ id: "common.close" });
  return (
    <div className="shrink-0 border-b border-line-seam" data-testid="desktop-app-link-banner" data-phase="opening">
      <Banner status="info" className="rounded-none ring-0">
        <Laptop aria-hidden="true" />
        <BannerTitle>{formatMessage({ id: "desktopAppLink.banner.opening" })}</BannerTitle>
        <DesktopAppDownload messageId="desktopAppLink.banner.nothingHappened" />
        <Tooltip content={closeLabel}>
          <BannerClose type="button" onClick={onClose} aria-label={closeLabel} data-testid="desktop-app-link-close" />
        </Tooltip>
      </Banner>
    </div>
  );
}

function DesktopAppLinkBannerView({
  sign,
  message,
  deepLink,
  onAnswer,
}: {
  sign: DesktopAppSign;
  /** The landed address is a message link; otherwise the title says "page". */
  message: boolean;
  deepLink: string;
  /** Open in Desktop App: "opening". Continue on Web: "done". */
  onAnswer: (next: "opening" | "done") => void;
}) {
  const { formatMessage } = useIntl();
  const rememberId = useId();
  const [remember, setRemember] = useState(false);
  const handleRememberChange = useCallback((checked: boolean) => setRemember(checked), []);

  const openApp = useCallback(() => {
    if (remember) writeLinkOpenPreference("app");
    openInDesktopApp(deepLink);
    onAnswer("opening");
  }, [deepLink, onAnswer, remember]);
  const stayOnWeb = useCallback(() => {
    if (remember) writeLinkOpenPreference("web");
    // Not remembered, and not where this browser was told "app" (no checkbox there): quiet for 7 days.
    else if (sign !== "remembered") quietLinkOpenOffer();
    onAnswer("done");
  }, [onAnswer, remember, sign]);

  return (
    <div className="shrink-0 border-b border-line-seam" data-testid="desktop-app-link-banner">
      <Banner status="info" className="rounded-none ring-0">
        <Laptop aria-hidden="true" />
        <BannerTitle>{formatMessage({ id: message ? "desktopAppLink.banner.title" : "desktopAppLink.banner.titlePage" })}</BannerTitle>
        {sign === "none" ? <DesktopAppDownload messageId="desktopAppLink.banner.download" /> : (
          <BannerDescription>
            {formatMessage({ id: sign === "remembered" ? "desktopAppLink.banner.descriptionRemembered" : "desktopAppLink.banner.description" })}
          </BannerDescription>
        )}
        <BannerAction>
          {sign === "remembered" ? null : (
            <label htmlFor={rememberId} className="mr-2 inline-flex items-center gap-2 text-callout text-foreground-muted">
              <Checkbox
                id={rememberId}
                checked={remember}
                onCheckedChange={handleRememberChange}
                data-testid="desktop-app-link-remember"
              />
              {formatMessage({ id: "desktopAppLink.banner.remember" })}
            </label>
          )}
          <Button variant="ghost" size="md" onClick={stayOnWeb} data-testid="desktop-app-link-stay">
            {formatMessage({ id: "desktopAppLink.banner.stay" })}
          </Button>
          <Button variant="default" size="md" onClick={openApp} data-testid="desktop-app-link-open">
            {formatMessage({ id: "desktopAppLink.banner.open" })}
          </Button>
        </BannerAction>
      </Banner>
    </div>
  );
}
