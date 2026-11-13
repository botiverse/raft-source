import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  Drawer,
  DrawerActions,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerPortal,
  DrawerTitle,
  IconTile,
  RaftLogo,
  Step,
  Steps,
  toast,
} from "@botiverse/raft-ui";
import { isHostShell } from "../../embed";
import { isElectronDesktopShell, shareableWebUrl } from "../../utils/desktopShell";
import { isEmbeddedBrowserUserAgent } from "../../utils/embeddedBrowser";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { detectDesktopOs } from "../../utils/desktopDownload";
import { useDeepLinksGuideFlag } from "./deepLinksFlag";

/**
 * Deep links v1, frame a: a chat app's in-app browser (WeChat, QQ, Feishu,
 * DingTalk, ...) on a phone cannot hand a link to the Raft app; only its own
 * "···" menu can send the page to the system browser, which can. So the page
 * is covered by a guide that leads with the goal and points at that menu:
 * an arrow to the top right, two numbered steps, then Copy Link (for in-app
 * browsers whose menu has no such item) and Continue here (web), which puts
 * it away for this browser session. Signed in or not: people arriving from a
 * chat are often signed out.
 *
 * iOS: Open in Safari hands the link to the app at once (Universal Link), so
 * the headline is "Open in the Raft app". Android: Open in Browser opens
 * Chrome, where the web's own Open in App bar takes over, so it says to go to
 * the browser first (Lagoon).
 *
 * Never in Raft's own apps: the Android app's WebView sends `; wv)` like any
 * in-app browser, and the host shell tells it apart; Raft Desktop is Electron.
 * Phones and tablets only: the desktop builds of Feishu, DingTalk and WeChat
 * have no "···" at the top right.
 *
 * Raft Design System: a modal bottom sheet (Drawer) over the scrim, Steps for
 * the two steps, the sheet's stacked full-width actions. The arrow on the scrim
 * is hand-drawn: raft-ui has no pointer to a spot outside the page.
 */
export const IN_APP_BROWSER_GUIDE_DISMISSED_KEY = "raft_in_app_browser_guide_dismissed";

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(IN_APP_BROWSER_GUIDE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.sessionStorage.setItem(IN_APP_BROWSER_GUIDE_DISMISSED_KEY, "1");
  } catch {
    // Storage blocked: the guide still goes away for this page.
  }
}

type NavigatorLike = { userAgent?: string; platform?: string; maxTouchPoints?: number } | undefined;

/** A chat app's in-app browser on a phone or tablet, not one of Raft's own shells. */
export function isInAppBrowserGuideCandidate(
  nav: NavigatorLike = typeof navigator === "undefined" ? undefined : navigator,
): boolean {
  if (typeof window === "undefined" || !nav) return false;
  if (isHostShell() || isElectronDesktopShell()) return false;
  if (detectDesktopOs(nav as Parameters<typeof detectDesktopOs>[0]) !== null) return false;
  return isEmbeddedBrowserUserAgent(nav.userAgent);
}

function isIos(userAgent: string): boolean {
  return /iPhone|iPad|iPod/i.test(userAgent);
}

function isWeChat(userAgent: string): boolean {
  return /MicroMessenger/i.test(userAgent);
}

export default function InAppBrowserGuide() {
  const [candidate] = useState(() => isInAppBrowserGuideCandidate() && !readDismissed());
  if (!candidate) return null;
  return <InAppBrowserGuideGate />;
}

function InAppBrowserGuideGate() {
  const enabled = useDeepLinksGuideFlag();
  const [open, setOpen] = useState(true);
  const dismiss = useCallback(() => {
    writeDismissed();
    setOpen(false);
  }, []);
  if (!enabled || !open) return null;
  return <InAppBrowserGuideSheet onContinue={dismiss} />;
}

function InAppBrowserGuideSheet({ onContinue }: { onContinue: () => void }) {
  const { formatMessage } = useIntl();
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const ios = isIos(userAgent);

  const copyLink = useCallback(async () => {
    try {
      await copyTextToClipboard(shareableWebUrl());
      toast.success(formatMessage({ id: "auth.openInBrowser.copied" }));
    } catch {
      toast.error(formatMessage({ id: "auth.openInBrowser.copyFailed" }));
    }
  }, [formatMessage]);
  const handleCopyClick = useCallback(() => {
    void copyLink();
  }, [copyLink]);
  // Swiping the sheet away or tapping the scrim is the same choice as
  // Continue: the page stays usable, the guide stays away this session.
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) onContinue();
  }, [onContinue]);

  return (
    <Drawer open onOpenChange={handleOpenChange}>
      <DrawerPortal>
        <MenuArrow />
      </DrawerPortal>
      <DrawerContent data-testid="in-app-browser-guide">
        <DrawerHeader className="items-start">
          <IconTile size="lg" aria-hidden="true">
            <RaftLogo />
          </IconTile>
          <DrawerTitle>
            {formatMessage({ id: ios ? "inAppBrowserGuide.titleIos" : "inAppBrowserGuide.titleAndroid" })}
          </DrawerTitle>
          <DrawerDescription>
            {formatMessage({ id: ios ? "inAppBrowserGuide.descriptionIos" : "inAppBrowserGuide.descriptionAndroid" })}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          <Steps vertical current={1} aria-label={formatMessage({ id: "inAppBrowserGuide.stepsLabel" })}>
            <Step title={formatMessage({ id: "inAppBrowserGuide.stepMenu" })} />
            <Step
              status="process"
              title={formatMessage({ id: ios ? "inAppBrowserGuide.stepOpenSafari" : "inAppBrowserGuide.stepOpenBrowser" })}
            />
          </Steps>
        </DrawerBody>
        <DrawerFooter>
          <DrawerActions>
            <Button variant="primary" size="lg" onClick={handleCopyClick} data-testid="in-app-browser-guide-copy">
              {formatMessage({ id: "inAppBrowserGuide.copyLink" })}
            </Button>
            <Button variant="ghost" size="lg" onClick={onContinue} data-testid="in-app-browser-guide-continue">
              {formatMessage({ id: isWeChat(userAgent) ? "inAppBrowserGuide.continueInWeChat" : "inAppBrowserGuide.continueHere" })}
            </Button>
          </DrawerActions>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * A dotted arrow on the scrim to the chat app's "···", which sits in the chat
 * app's own title bar above the web view: the arrowhead touches the top edge
 * of the viewport about 22px from the right. The line rises through the gap
 * between the page header's title and its icons, then runs along the very top,
 * so it never ends on (or crosses) a control of the page itself.
 */
function MenuArrow() {
  return (
    <svg
      aria-hidden="true"
      data-testid="in-app-browser-guide-arrow"
      className="pointer-events-none fixed right-0 top-0 z-app h-[170px] w-[200px] text-foreground-on-hud"
      viewBox="0 0 200 170"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M50 168 C 50 110, 54 40, 88 14 Q 108 5, 150 5 Q 176 5, 178 6" strokeDasharray="2 8" />
      <path d="M171 9 L178 1.5 L185 9" />
    </svg>
  );
}
