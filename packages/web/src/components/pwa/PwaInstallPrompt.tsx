import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { Smartphone } from "lucide-react";
import {
  Button,
  Card,
  Drawer,
  DrawerActions,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@botiverse/raft-ui";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { PHONE_MEDIA_QUERY } from "../ui/NarrowDialog";
import { useOverlayLayer } from "../ui/useOverlayLayer";
import { shareableWebUrl } from "../../utils/desktopShell";
import {
  PWA_INSTALL_OPEN_EVENT,
  PWA_INSTALL_SESSION_DISMISSED_KEY,
  PWA_INSTALL_SESSION_COUNT_KEY,
  getCooldownState,
  getPwaInstallDisplayMode,
  getPwaInstallPlatform,
  getSessionCountBucket,
  hasPwaInstallPath,
  isPwaStandalone,
  readNumberStorage,
  recordPwaInstallEvent,
} from "../../utils/pwaInstall";
import type {
  PwaInstallCooldownState,
  PwaInstallPlatform,
  PwaInstallSurface,
} from "../../utils/pwaInstall";

function isMobileViewportNow(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 767px)").matches;
}

function IosInstructionSheet({
  variant,
  onClose,
  onCopyLink,
}: {
  variant: "safari" | "other";
  onClose: () => void;
  onCopyLink: () => void;
}) {
  const { formatMessage } = useIntl();
  const isSafari = variant === "safari";
  // A phone sheet only: nothing on a wider window (it was md:hidden).
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  useOverlayLayer(phone);
  const handleOpenChange = useCallback((open: boolean) => { if (!open) onClose(); }, [onClose]);
  // Raft Design System › Drawer, the bottom sheet: the grab handle, the head
  // (17/22 title, × at its end), the body (a 15/20 ink-2 line, then the
  // steps), then full-width actions with one pink primary. Base UI traps focus, closes on Esc, a scrim
  // press or a swipe down, and gives focus back to the control that opened it.
  return (
    <Drawer open={phone} swipeDirection="down" onOpenChange={handleOpenChange}>
      <DrawerContent data-testid="pwa-install-sheet">
        {/* The head is one line, the title and ×; the line that was under it opens the body (Raft DS › Drawer). */}
        <DrawerHeader className="flex-row items-center justify-between gap-2">
          <DrawerTitle className="min-w-0">{formatMessage({ id: "pwa.install.addToYourHomeScreen" })}</DrawerTitle>
          <DrawerClose aria-label={formatMessage({ id: "pwa.install.closeInstructionsAria" })} />
        </DrawerHeader>

        <DrawerBody className="gap-3">
          <DrawerDescription>
            {isSafari
              ? formatMessage({ id: "pwa.install.safariSubtitle" })
              : formatMessage({ id: "pwa.install.openInSafariSettingsHint" })}
          </DrawerDescription>
          {isSafari ? (
            <div className="rounded-container border border-line-hairline bg-fill-muted p-2">
              <img
                src="/pwa/ios-add-to-home-screen-3step.svg"
                alt={formatMessage({ id: "pwa.install.threeStepsAlt" })}
                className="block w-full"
              />
            </div>
          ) : (
            // DS Banner (info): the cyan-soft wash, ink text, a hairline. Hand-rolled
            // because raft-ui's Banner announces itself as role="alert", and this
            // static note never did.
            <div className="rounded-container bg-info-soft px-3.5 py-3 text-callout text-foreground ring-1 ring-inset ring-line-hairline">
              {formatMessage({ id: "pwa.install.iosSafariOnly" })}
            </div>
          )}
        </DrawerBody>

        <DrawerFooter>
          <DrawerActions>
            {!isSafari && (
              <Button type="button" onClick={onCopyLink} size="lg" variant="primary">
                {formatMessage({ id: "pwa.install.copyLink" })}
              </Button>
            )}
            <DrawerClose render={<Button type="button" size="lg" variant={isSafari ? "primary" : "ghost"} />}>
              {isSafari
                ? formatMessage({ id: "pwa.install.gotIt" })
                : formatMessage({ id: "common.close" })}
            </DrawerClose>
          </DrawerActions>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

export function PwaInstallSettingsCard() {
  const { formatMessage } = useIntl();
  // Read before the first paint, not in an effect: the card renders nothing
  // until it knows it is on a phone, so reading these a frame late made it pop
  // in and push Settings down (task #157; Raft DS › Responsive layout, "The
  // first frame is the settled one").
  const [platform] = useState<PwaInstallPlatform>(() => (
    typeof window === "undefined" ? "other" : getPwaInstallPlatform(window.navigator.userAgent)
  ));
  const [standalone] = useState(() => typeof window !== "undefined" && isPwaStandalone(window));
  const [isMobile] = useState(() => typeof window !== "undefined" && isMobileViewportNow());
  const [sessionCount] = useState(() => (
    typeof window === "undefined" ? 1 : readNumberStorage(window.localStorage, PWA_INSTALL_SESSION_COUNT_KEY) ?? 1
  ));
  const [cooldownState] = useState<PwaInstallCooldownState>(() => {
    if (typeof window === "undefined") return "not_dismissed";
    return window.sessionStorage.getItem(PWA_INSTALL_SESSION_DISMISSED_KEY) === "1"
      ? "dismissed_active"
      : getCooldownState(Date.now(), null);
  });

  // oxlint-disable-next-line react-doctor/no-effect-chain -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
  useEffect(() => {
    if (!isMobile || standalone || typeof window === "undefined") return;
    if (!hasPwaInstallPath({ platform, hasNativePrompt: false })) return;
    recordPwaInstallEvent({
      event: "pwa_install_cta_shown",
      platform,
      surface: "settings",
      trigger: "settings",
      displayMode: getPwaInstallDisplayMode(window),
      sessionCountBucket: getSessionCountBucket(sessionCount),
      cooldownState,
    });
  }, [cooldownState, isMobile, platform, sessionCount, standalone]);

  const openInstallSheet = useCallback(() => {
    recordPwaInstallEvent({
      event: "pwa_install_cta_clicked",
      platform,
      surface: "settings",
      trigger: "settings",
      displayMode: getPwaInstallDisplayMode(window),
      sessionCountBucket: getSessionCountBucket(sessionCount),
      cooldownState,
    });
    window.dispatchEvent(new CustomEvent(PWA_INSTALL_OPEN_EVENT, { detail: { source: "settings" } }));
  }, [cooldownState, platform, sessionCount]);

  if (!isMobile || standalone || !hasPwaInstallPath({ platform, hasNativePrompt: false })) return null;

  const helpText = formatMessage({ id: "pwa.install.openInSafariSettingsHint" });

  return (
    <div data-pwa-install-settings-card className="mb-6 md:hidden">
      {/* DS card: the card surface, a hairline, the container radius, no
          shadow. The settings screen has its own primary, so "Add" is the
          ink-lined small button, not pink. */}
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-subhead font-semibold text-foreground">
              <Smartphone size={18} className="shrink-0 text-foreground-muted" aria-hidden="true" />
              {formatMessage({ id: "pwa.install.addToHomeScreen" })}
            </div>
            <div className="mt-1 text-caption text-foreground-hint">{helpText}</div>
          </div>
          <Button
            type="button"
            size="md"
            variant="outline"
            onClick={openInstallSheet}
            className="shrink-0"
          >
            {formatMessage({ id: "pwa.install.add" })}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default function PwaInstallPrompt() {
  const [platform, setPlatform] = useState<PwaInstallPlatform>("other");
  const [sessionCount, setSessionCount] = useState(1);
  const [cooldownState, setCooldownState] = useState<PwaInstallCooldownState>("not_dismissed");
  const [standalone, setStandalone] = useState(false);
  const [sheet, setSheet] = useState<null | "safari" | "other">(null);

  const track = useCallback((event: Parameters<typeof recordPwaInstallEvent>[0]["event"], surface: PwaInstallSurface, extra: Partial<Parameters<typeof recordPwaInstallEvent>[0]> = {}) => {
    if (typeof window === "undefined") return;
    recordPwaInstallEvent({
      event,
      platform,
      surface,
      trigger: extra.trigger ?? "supported_browser",
      displayMode: getPwaInstallDisplayMode(window),
      sessionCountBucket: getSessionCountBucket(sessionCount),
      cooldownState,
      ...extra,
    });
  }, [cooldownState, platform, sessionCount]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const nextStandalone = isPwaStandalone(window);
    // oxlint-disable-next-line react-doctor/no-initialize-state -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setPlatform(getPwaInstallPlatform(window.navigator.userAgent));
    // oxlint-disable-next-line react-doctor/no-initialize-state -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setSessionCount(readNumberStorage(window.localStorage, PWA_INSTALL_SESSION_COUNT_KEY) ?? 1);
    // oxlint-disable-next-line react-doctor/no-initialize-state -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setCooldownState(window.sessionStorage.getItem(PWA_INSTALL_SESSION_DISMISSED_KEY) === "1" ? "dismissed_active" : "not_dismissed");
    // oxlint-disable-next-line react-doctor/no-initialize-state -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setStandalone(nextStandalone);
  }, []);

  // oxlint-disable-next-line react-doctor/no-effect-chain -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
  useEffect(() => {
    if (!standalone) return;
    track("pwa_install_standalone_detected", "settings");
  }, [standalone, track]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOpen = (event: Event) => {
      const source = (event as CustomEvent<{ source?: string }>).detail?.source === "settings" ? "settings" : "notification_center";
      track("pwa_install_cta_clicked", source);
      if (platform === "ios_safari") {
        setSheet("safari");
        track("pwa_install_cta_shown", "ios_instruction_sheet");
      } else {
        setSheet("other");
        track("pwa_install_cta_shown", "ios_instruction_sheet");
      }
    };
    window.addEventListener(PWA_INSTALL_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(PWA_INSTALL_OPEN_EVENT, onOpen);
  }, [platform, track]);

  const closeSheet = useCallback(() => {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(PWA_INSTALL_SESSION_DISMISSED_KEY, "1");
      setCooldownState("dismissed_active");
    }
    track("pwa_install_ios_instruction_dismissed", "ios_instruction_sheet");
    setSheet(null);
  }, [track]);

  const copyLink = useCallback(() => {
    if (typeof window === "undefined") return;
    void navigator.clipboard?.writeText(shareableWebUrl());
    track("pwa_install_cta_clicked", "ios_instruction_sheet");
  }, [track]);

  if (standalone) return null;

  return sheet ? <IosInstructionSheet variant={sheet} onClose={closeSheet} onCopyLink={copyLink} /> : null;
}
