import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowUpRight, Download, Monitor, Smartphone } from "lucide-react";
import { Button, Card, ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowIcon, ListRowTitle, TextLink, TextLinkDownloadIcon } from "@botiverse/raft-ui";
import type { MessageId } from "../i18n/messages";
import {
  GOOGLE_PLAY_URL,
  detectPhoneDevice,
  mobileDownloadQrUrl,
  mobileDownloadUrl,
} from "../utils/mobileDownloadUrl";
import type { PhoneDevice } from "../utils/mobileDownloadUrl";
import { GOOGLE_PLAY_ICON_URL } from "../components/icons/googlePlayIcon";
import { APP_STORE_ICON_URL } from "../components/icons/appStoreIcon";
import { desktopDownloadUrl } from "../utils/desktopDownload";
import type { DesktopOs, DesktopTarget } from "../utils/desktopDownload";
import { useDesktopDownloadView } from "../components/settings/DesktopDownloadOptions";
import type { DesktopDownloadView } from "../components/settings/DesktopDownloadOptions";
import MobileDownloadQr from "../components/settings/MobileDownloadQr";
import LeavingRaftMark, { opensInNewTabAriaLabel } from "../components/ui/LeavingRaftMark";

/**
 * Public download page, `/download` (raft-design
 * design/products/raft-chat/getting-the-app.md).
 *
 * **The device decides what comes first.** The browser says what it is, so
 * the page doesn't ask: a This device block with the page's one pink button
 * for this device, then Other devices, one ListRow per platform. Telling is a
 * guess, so every other platform stays one tap away; a device the page can't
 * tell (a Chromebook) gets no pink button and every platform as a row.
 *
 * **Why the page exists at all.** The server classifies devices by User-Agent,
 * and iPadOS Safari sends a string byte-identical to macOS, so an iPad scanning
 * the QR was indistinguishable from a desktop. Anything the server cannot
 * classify lands here; the browser tells an iPad by its touch screen.
 *
 * **No session required.** Whoever scanned the QR has not signed in on that
 * device, so this is on the public router, outside the authenticated shell.
 *
 * **The iOS and APK links go back through `/api/mobile-download` with an
 * explicit platform**, never to a vendor URL: Hands hands out signed URLs that
 * expire, and the App Store listing is an Apple-side URL the server owns. The
 * page no longer offers the TestFlight beta; `ios-beta` stays on the server for
 * old QR codes and links. Explicit platforms also mean this page cannot bounce
 * back to itself. Google Play is the one direct store link: its listing URL is
 * stable. Desktop installers go through `/api/desktop-download`, which reads
 * the Latest release's update feed, and only platforms the release has are
 * offered.
 */

type Device = PhoneDevice | DesktopOs;

const THIS_DEVICE_LABEL: Record<Device, MessageId> = {
  iphone: "mobileDownload.chooser.thisDevice.iphone",
  ipad: "mobileDownload.chooser.thisDevice.ipad",
  android: "mobileDownload.chooser.thisDevice.android",
  mac: "mobileDownload.chooser.thisDevice.mac",
  windows: "mobileDownload.chooser.thisDevice.windows",
  linux: "mobileDownload.chooser.thisDevice.linux",
};

/** A store leaves Raft: new tab, ↗. An installer is a download: same tab, the download icon. */
type DownloadLink = {
  href: string;
  /** The action, on the pink button and a footnote: Download on the App Store. */
  label: string;
  /** The platform's name, on an Other devices row: the ↗ or the download icon at its end carries the action. */
  platform: string;
  /** The row's accessible name: the platform, then the store or "download". */
  rowAria: string;
  store: boolean;
  testId: string;
  /** A store's own mark, only inside the pink button (#triage:#96: our button with the store's icon, not its black badge). */
  iconSrc?: string;
  /** The row's leading line icon: a smartphone for a phone platform, a monitor for a computer. */
  icon: ReactNode;
};

function useMobileLinks(): Record<"ios" | "googlePlay" | "apk", DownloadLink> {
  const { formatMessage } = useIntl();
  return {
    ios: {
      href: mobileDownloadUrl("ios"),
      label: formatMessage({ id: "settings.mobileApp.ios" }),
      platform: formatMessage({ id: "mobileDownload.platform.iosDevices" }),
      rowAria: formatMessage({ id: "mobileDownload.row.iosAria" }),
      store: true,
      testId: "mobile-download-chooser-ios",
      iconSrc: APP_STORE_ICON_URL,
      icon: <Smartphone />,
    },
    googlePlay: {
      href: GOOGLE_PLAY_URL,
      label: formatMessage({ id: "settings.mobileApp.googlePlay" }),
      platform: formatMessage({ id: "mobileDownload.platform.androidGooglePlay" }),
      rowAria: formatMessage({ id: "mobileDownload.platform.androidGooglePlay" }),
      store: true,
      testId: "mobile-download-chooser-google-play",
      iconSrc: GOOGLE_PLAY_ICON_URL,
      icon: <Smartphone />,
    },
    apk: {
      href: mobileDownloadUrl("android"),
      label: formatMessage({ id: "settings.mobileApp.android" }),
      platform: formatMessage({ id: "mobileDownload.platform.androidApk" }),
      rowAria: formatMessage({ id: "mobileDownload.row.downloadAria" }, { platform: formatMessage({ id: "mobileDownload.platform.androidApk" }) }),
      store: false,
      testId: "mobile-download-chooser-android",
      icon: <Smartphone />,
    },
  };
}

function desktopLink(
  target: DesktopTarget,
  labelId: MessageId,
  formatMessage: ReturnType<typeof useIntl>["formatMessage"],
): DownloadLink {
  const platform = formatMessage({ id: labelId });
  return {
    href: desktopDownloadUrl(target),
    label: formatMessage({ id: labelId }),
    platform,
    rowAria: formatMessage({ id: "mobileDownload.row.downloadAria" }, { platform }),
    store: false,
    testId: `desktop-download-chooser-${target}`,
    icon: <Monitor />,
  };
}

/** One platform: the whole row is the link. */
function DownloadRow({ link }: { link: DownloadLink }) {
  const { formatMessage } = useIntl();
  const anchor = link.store ? (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={opensInNewTabAriaLabel(formatMessage, link.rowAria)}
      data-testid={link.testId}
      data-kind="store"
    />
  ) : (
    <a href={link.href} aria-label={link.rowAria} data-testid={link.testId} data-kind="installer" />
  );
  return (
    <ListRow variant="plain" render={anchor}>
      {/* A line icon only, at ListRowIcon's 20px (Jasper, #triage:a230ad1c):
          the stores' full-color marks stay inside the pink button. */}
      <ListRowIcon data-testid={`${link.testId}-leading`}>{link.icon}</ListRowIcon>
      <ListRowBody>
        <ListRowTitle>{link.platform}</ListRowTitle>
      </ListRowBody>
      <ListRowIcon data-testid={`${link.testId}-end`} data-end={link.store ? "leaves-raft" : "download"}>
        {link.store ? <ArrowUpRight /> : <Download />}
      </ListRowIcon>
    </ListRow>
  );
}

/** On a computer the phones are one row: the code, which opens this page on the phone, and what it does. */
function PhonesQrRow() {
  const { formatMessage } = useIntl();
  return (
    <ListRow variant="plain" interactive={false} data-testid="download-phones-qr">
      <MobileDownloadQr url={mobileDownloadQrUrl()} />
      <ListRowBody>
        <ListRowTitle>{formatMessage({ id: "mobileDownload.chooser.phones" })}</ListRowTitle>
        <ListRowDescription wrap>{formatMessage({ id: "mobileDownload.qrInstructions" })}</ListRowDescription>
      </ListRowBody>
    </ListRow>
  );
}

type ThisDevice = {
  device: Device;
  /** The page's one pink button. */
  primary: DownloadLink;
  /** The same platform's other way in: the APK on Android, the Intel build when the chip is unknown, the .deb on Linux. */
  footnote: DownloadLink | null;
};

function pickThisDevice(
  phone: PhoneDevice | null,
  desktop: DesktopDownloadView,
  mobile: ReturnType<typeof useMobileLinks>,
  formatMessage: ReturnType<typeof useIntl>["formatMessage"],
): ThisDevice | null {
  if (phone === "android") return { device: phone, primary: mobile.googlePlay, footnote: mobile.apk };
  if (phone) return { device: phone, primary: mobile.ios, footnote: null };
  const { os, recommended, footnote } = desktop;
  // A computer with nothing to offer it (Windows before its first build) is
  // a device the page can't serve first: every platform as a row (raft-design #1222).
  if (!os || !recommended) return null;
  return {
    device: os,
    primary: desktopLink(recommended.target, recommended.labelId, formatMessage),
    footnote: footnote ? desktopLink(footnote.target, footnote.labelId, formatMessage) : null,
  };
}

function ThisDeviceBlock({ thisDevice }: { thisDevice: ThisDevice }) {
  const { formatMessage } = useIntl();
  const { primary, footnote } = thisDevice;
  return (
    <section className="stack-y-2" data-testid="download-this-device" data-device={thisDevice.device}>
      <h2 className="text-footnote text-foreground-muted">{formatMessage({ id: THIS_DEVICE_LABEL[thisDevice.device] })}</h2>
      <Button
        render={primary.store ? (
          <a
            href={primary.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={opensInNewTabAriaLabel(formatMessage, primary.label)}
            data-testid="download-this-device-primary"
            data-kind="store"
          />
        ) : (
          <a href={primary.href} aria-label={primary.label} data-testid="download-this-device-primary" data-kind="installer" />
        )}
        nativeButton={false}
        variant="primary"
        size="lg"
        className="w-full"
      >
        {primary.iconSrc ? <img src={primary.iconSrc} alt="" className="object-contain" draggable={false} data-icon="inline-start" /> : null}
        {primary.label}
        {primary.store ? <LeavingRaftMark data-icon="inline-end" /> : null}
      </Button>
      {footnote ? (
        <p className="text-center text-footnote">
          <TextLink render={<a href={footnote.href} aria-label={footnote.label} data-testid="download-this-device-footnote" />}>
            {footnote.label}
            <TextLinkDownloadIcon />
          </TextLink>
        </p>
      ) : null}
    </section>
  );
}

export default function MobileDownloadChooserPage() {
  const { formatMessage } = useIntl();
  const phone = detectPhoneDevice(typeof navigator === "undefined" ? undefined : navigator);
  const desktop = useDesktopDownloadView();
  const mobile = useMobileLinks();
  const thisDevice = pickThisDevice(phone, desktop, mobile, formatMessage);

  // This computer's own OS is the button and the footnote; the rows are the others.
  const desktopRows = (thisDevice ? desktop.others : desktop.options)
    .filter((option) => option.available)
    .map((option) => desktopLink(option.target, option.labelId, formatMessage));
  // On a phone only the other phone platform: a computer's installer is no use there.
  const otherRows: DownloadLink[] = phone === "android"
    ? [mobile.ios]
    : phone
      ? [mobile.googlePlay, mobile.apk]
      : thisDevice
        ? desktopRows
        : [mobile.ios, mobile.googlePlay, mobile.apk, ...desktopRows];
  const showQr = !phone && thisDevice !== null;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-layer-sidebar px-4 py-10 font-display text-foreground">
      <Card className="w-full max-w-md stack-y-6 p-6" data-testid="mobile-download-chooser">
        <div className="stack-y-2">
          <h1 className="text-headline">{formatMessage({ id: "mobileDownload.chooser.title" })}</h1>
          {thisDevice ? null : (
            <p className="text-callout text-foreground-muted" data-testid="download-choose-device">
              {formatMessage({ id: "mobileDownload.chooser.chooseDevice" })}
            </p>
          )}
        </div>
        {thisDevice ? <ThisDeviceBlock thisDevice={thisDevice} /> : null}
        <section className="stack-y-2" data-testid="download-other-devices">
          {thisDevice ? (
            <h2 className="text-footnote font-bold text-foreground-hint">{formatMessage({ id: "mobileDownload.chooser.otherDevices" })}</h2>
          ) : null}
          <ListRowGroup>
            {showQr ? <PhonesQrRow /> : null}
            {otherRows.map((link) => <DownloadRow key={link.testId} link={link} />)}
          </ListRowGroup>
        </section>
      </Card>
    </div>
  );
}
