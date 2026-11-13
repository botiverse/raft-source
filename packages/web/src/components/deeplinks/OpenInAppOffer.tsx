import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Button,
  Drawer,
  DrawerActions,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  IconTile,
  RaftLogo,
} from "@botiverse/raft-ui";
import { useToastViewportFlowNotice } from "../toastViewportBottom";
import CloseButton from "../ui/CloseButton";
import { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";
import { isAppClaimedPath } from "../../utils/appClaimedPath";
import { parseMessageLink } from "../../utils/messageLinkLanding";
import { MOBILE_DOWNLOAD_CHOOSER_PATH, mobileDownloadUrl } from "../../utils/mobileDownloadUrl";
import {
  hasAppMissingMarker,
  isIosUserAgent,
  isPhoneBrowser,
  openInAppUrl,
  withoutAppMissingMarker,
} from "../../utils/openInAppLink";
import { answerPageLandingOffer, isPageLandingOfferAnswered } from "../../utils/pageLanding";
import { useOpenInAppOfferFlag, usePageLanding } from "./deepLinksFlag";
import { useOpenInAppRowSlot } from "./openInAppRowSlots";

/**
 * Deep links v1, frame b: a phone's own browser that landed on a Raft address
 * its app opens (utils/appClaimedPath.ts: any `/s/…` page on Android, a
 * channel or DM on an iPhone; a message link or not) offers the Raft app in
 * one row: Raft's tile, "Open in the Raft app", Open and ×. Open is a real
 * link to the same address on the open host (utils/openInAppLink.ts), so the
 * system hands it to the app when it is installed; the page never tries
 * anything by itself.
 *
 * The row is at the bottom, within thumb reach, directly above whatever holds
 * the bottom of the page and always in the page's flow, so it never covers a
 * message: above the composer in a conversation or a thread (drawn in the
 * slot that starts their footer, openInAppRowSlots.ts), above the tab bar on
 * a tab root, and the last thing in the window elsewhere (the shell's bottom
 * strip, where it pads the home indicator's inset itself). While the
 * on-screen keyboard is up it hides, as the tab bar does, and comes back when
 * the keyboard closes. Above the tab bar it tells the toast measure it is
 * there, so a toast sits above it; in a footer it is part of what a toast
 * already sits above.
 *
 * When no app took it, the open host sends the person back here with
 * `app=missing`: the page drops the marker from the address and shows the
 * "not installed" sheet instead of the row, with Download Raft App and Keep
 * Using the Web, which always leaves the page usable.
 *
 * × and Keep Using the Web put the offer away for this browser session; no
 * marker is kept beyond it, and nothing tries to tell whether the app is
 * installed (xxchan, #proj-mobile:fb2be9a0).
 *
 * Signed out, the sign-in page of a landed workspace address draws the same
 * row at its bottom (SignInPage), behind the before-login flag. An answer
 * there (Open, ×, Keep Using the Web) is for the landing: the workspace that
 * loads after sign-in does not offer it again (utils/pageLanding.ts).
 *
 * Raft Design System › Banner › The open-in-app offer: like the sign-up
 * prompt on a phone, an offer rather than a notice, so not a Banner: an
 * `info-soft` row, flat and full width with a seam on its top edge, with one
 * ink-bordered 32px button and an ×. The sheet is
 * the in-app browser guide's Drawer: tile, title, one line, the stacked
 * full-width actions.
 */
export const OPEN_IN_APP_DISMISSED_KEY = "raft_open_in_app_dismissed";

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(OPEN_IN_APP_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.sessionStorage.setItem(OPEN_IN_APP_DISMISSED_KEY, "1");
  } catch {
    // Storage blocked: the offer still goes away for this page.
  }
}

interface Landing {
  pathname: string;
  search: string;
}

export default function OpenInAppOffer() {
  // The address as it landed, while its page is on screen: the app may later
  // drop `msg` or the marker from it, and the offer is still about it.
  const landing = usePageLanding();
  if (!landing || !isPhoneBrowser()) return null;
  if (!isAppClaimedPath(landing.pathname, isIosUserAgent(navigator.userAgent) ? "ios" : "android", landing.search)) return null;
  return <OpenInAppOfferGate landing={landing} />;
}

function OpenInAppOfferGate({ landing }: { landing: Landing }) {
  const enabled = useOpenInAppOfferFlag();
  const location = useLocation();
  const navigate = useNavigate();
  // Answered before this mounted (on the sign-in page, before the workspace loaded): not offered twice.
  const [barDismissed, setBarDismissed] = useState(() => readDismissed() || isPageLandingOfferAnswered());
  const [sheetClosed, setSheetClosed] = useState(isPageLandingOfferAnswered);
  // The footer of the composer on screen, when the page has one.
  const slot = useOpenInAppRowSlot();

  // The marker is for this page only: a reload, Back or a copied address
  // must not say "not installed" again.
  const markerInAddress = hasAppMissingMarker(location.search);
  useEffect(() => {
    if (!markerInAddress) return;
    navigate(
      { pathname: location.pathname, search: withoutAppMissingMarker(location.search), hash: location.hash },
      { replace: true },
    );
  }, [location.hash, location.pathname, location.search, markerInAddress, navigate]);

  const dismissBar = useCallback(() => {
    writeDismissed();
    answerPageLandingOffer();
    setBarDismissed(true);
  }, []);
  const closeSheet = useCallback(() => {
    writeDismissed();
    answerPageLandingOffer();
    setSheetClosed(true);
  }, []);

  if (!enabled) return null;
  const appMissing = hasAppMissingMarker(landing.search);
  const href = openInAppUrl(landing.pathname, landing.search, window.location.host);
  // Back with app=missing: the sheet takes the row's place.
  const bar = appMissing || barDismissed || !href ? null : (
    <OpenInAppBar
      href={href}
      message={parseMessageLink(landing.pathname, landing.search) !== null}
      aboveComposer={slot !== null}
      onOpen={answerPageLandingOffer}
      onDismiss={dismissBar}
    />
  );
  return (
    <>
      {bar && slot ? createPortal(bar, slot) : bar}
      {appMissing && !sheetClosed ? <AppMissingSheet onClose={closeSheet} /> : null}
    </>
  );
}

/**
 * Hidden while the on-screen keyboard is up, with the class the tab bar hides
 * by (`data-soft-keyboard` on #root, utils/visualViewport.ts): the composer
 * keeps its room, and the row is back when the keyboard closes.
 */
const BAR_CLASS = "flex shrink-0 items-center gap-3 border-t border-line-seam bg-info-soft py-2 pl-4 pr-1.5 in-data-[soft-keyboard=open]:hidden";
/**
 * In the shell's bottom strip the tab bar, when the page has one, comes right
 * after the row and pads the home indicator's inset itself. Without it (and
 * from 768px up, where the tab bar never shows) the row is the last thing in
 * the window and pads that inset under its own 8px.
 */
const BAR_LAST_IN_WINDOW_CLASS = "[&:not(:has(~[data-slot=mobile-nav-root]))]:pb-[calc(--spacing(2)+env(safe-area-inset-bottom,0px))] md:pb-[calc(--spacing(2)+env(safe-area-inset-bottom,0px))]";

function OpenInAppBar({ href, message, aboveComposer, onOpen, onDismiss }: {
  href: string;
  /** The landed address is a message link: the second line says so. Any other page has the title alone. */
  message: boolean;
  /** Drawn in a composer's footer; otherwise in the shell's bottom strip. */
  aboveComposer: boolean;
  /** Open was tapped: the row stays where it is (the system takes the link, or it comes back as "not installed"). */
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { formatMessage } = useIntl();
  const title = formatMessage({ id: "openInApp.bar.title" });
  // Above the tab bar a toast sits above the row, not over it (toastViewportBottom.ts).
  const noticeRef = useToastViewportFlowNotice();
  return (
    <div
      ref={aboveComposer ? undefined : noticeRef}
      className={aboveComposer ? BAR_CLASS : `${BAR_CLASS} ${BAR_LAST_IN_WINDOW_CLASS}`}
      data-testid="open-in-app-bar"
    >
      <IconTile size="sm" aria-hidden="true">
        <RaftLogo />
      </IconTile>
      <div className="min-w-0 flex-1">
        <p className="truncate text-callout font-semibold text-foreground">
          {title}
        </p>
        {message ? (
          <p className="truncate text-caption text-foreground-muted">
            {formatMessage({ id: "openInApp.bar.description" })}
          </p>
        ) : null}
      </div>
      <Button
        variant="default"
        size="md"
        nativeButton={false}
        role="link"
        render={<a href={href} aria-label={title} />}
        onClick={onOpen}
        data-testid="open-in-app-open"
      >
        {formatMessage({ id: "openInApp.bar.open" })}
      </Button>
      <CloseButton
        onClick={onDismiss}
        aria-label={formatMessage({ id: "openInApp.bar.dismiss" })}
        data-testid="open-in-app-dismiss"
      />
    </div>
  );
}

function AppMissingSheet({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  const ios = isIosUserAgent(typeof navigator === "undefined" ? "" : navigator.userAgent);
  // iOS: the App Store through the download entry, as the download page does.
  // Android: the download page, which offers Google Play and the APK (phones
  // without Google Play). Both open beside this page, so the link stays.
  const downloadHref = ios ? mobileDownloadUrl("ios") : MOBILE_DOWNLOAD_CHOOSER_PATH;
  const downloadLabel = formatMessage({ id: "openInApp.missing.download" });
  // Swiping the sheet away is Keep Using the Web.
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) onClose();
  }, [onClose]);

  return (
    <Drawer open onOpenChange={handleOpenChange}>
      <DrawerContent data-testid="open-in-app-missing">
        <DrawerHeader className="items-start">
          <IconTile size="lg" aria-hidden="true">
            <RaftLogo />
          </IconTile>
          <DrawerTitle>{formatMessage({ id: "openInApp.missing.title" })}</DrawerTitle>
          <DrawerDescription>{formatMessage({ id: "openInApp.missing.description" })}</DrawerDescription>
        </DrawerHeader>
        <DrawerFooter>
          <DrawerActions>
            <Button
              variant="primary"
              size="lg"
              nativeButton={false}
              role="link"
              render={(
                <a
                  href={downloadHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={opensInNewTabAriaLabel(formatMessage, downloadLabel)}
                />
              )}
              data-testid="open-in-app-download"
            >
              {downloadLabel}
            </Button>
            <Button variant="ghost" size="lg" onClick={onClose} data-testid="open-in-app-stay">
              {formatMessage({ id: "openInApp.missing.stay" })}
            </Button>
          </DrawerActions>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
