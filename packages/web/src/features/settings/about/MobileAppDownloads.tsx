import { useIntl } from "react-intl";
import { Button, TextLink, TextLinkDownloadIcon, TextLinkExternalIcon } from "@botiverse/raft-ui";
import LeavingRaftMark, { opensInNewTabAriaLabel } from "../../../components/ui/LeavingRaftMark";
import MobileDownloadQr from "../../../components/settings/MobileDownloadQr";
import type { MessageId } from "../../../i18n/messages";
import {
  GOOGLE_PLAY_URL,
  detectPhoneDevice,
  mobileDownloadQrUrl,
  mobileDownloadUrl,
} from "../../../utils/mobileDownloadUrl";

type MobileLink = { key: "ios" | "googlePlay" | "apk"; href: string; labelId: MessageId; store: boolean; testId: string };

const IOS: MobileLink = { key: "ios", href: mobileDownloadUrl("ios"), labelId: "settings.mobileApp.ios", store: true, testId: "mobile-download-ios" };
const GOOGLE_PLAY: MobileLink = { key: "googlePlay", href: GOOGLE_PLAY_URL, labelId: "settings.mobileApp.googlePlay", store: true, testId: "mobile-download-google-play" };
const APK: MobileLink = { key: "apk", href: mobileDownloadUrl("android"), labelId: "settings.mobileApp.android", store: false, testId: "mobile-download-android" };

/** A store leaves Raft (new tab, ↗); the APK is a download and stays in this tab. */
function MobileTextLink({ link }: { link: MobileLink }) {
  const { formatMessage } = useIntl();
  const label = formatMessage({ id: link.labelId });
  return link.store ? (
    <TextLink
      render={<a href={link.href} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, label)} data-testid={link.testId} />}
    >
      {label}
      <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
    </TextLink>
  ) : (
    <TextLink render={<a href={link.href} aria-label={label} data-testid={link.testId} />}>
      {label}
      <TextLinkDownloadIcon />
    </TextLink>
  );
}

/**
 * Settings → About, Mobile app (raft-design getting-the-app.md). The phone
 * isn't the device showing Settings, so nothing is recommended and nothing is
 * pink: on a computer the QR code comes first, then the App Store, Google Play
 * and the APK as one line of links. Only when a phone's own browser shows
 * Settings is a store button the way in: that phone's store first, the others
 * as links.
 *
 * The QR encodes `mobileDownloadQrUrl()`: why the web origin is there.
 */
export function MobileAppDownloads() {
  const { formatMessage } = useIntl();
  const phone = detectPhoneDevice(typeof navigator === "undefined" ? undefined : navigator);

  if (phone) {
    const store = phone === "android" ? GOOGLE_PLAY : IOS;
    const others = phone === "android" ? [IOS, APK] : [GOOGLE_PLAY, APK];
    const label = formatMessage({ id: store.labelId });
    return (
      <div className="min-w-0 stack-y-3" data-testid="mobile-download" data-device={phone}>
        <div className="flex">
          <Button
            render={(
              <a
                href={store.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={opensInNewTabAriaLabel(formatMessage, label)}
                data-testid={store.testId}
              />
            )}
            nativeButton={false}
            size="md"
            variant="default"
          >
            {label}
            <LeavingRaftMark data-icon="inline-end" />
          </Button>
        </div>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-footnote" data-testid="mobile-download-links">
          {others.map((link) => <MobileTextLink key={link.key} link={link} />)}
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0 stack-y-3" data-testid="mobile-download" data-device="computer">
      <div className="flex items-center gap-4" data-testid="mobile-download-qr-block">
        <MobileDownloadQr url={mobileDownloadQrUrl()} />
        <p className="text-callout text-foreground">{formatMessage({ id: "mobileDownload.qrInstructionsShort" })}</p>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-footnote" data-testid="mobile-download-links">
        {[IOS, GOOGLE_PLAY, APK].map((link) => <MobileTextLink key={link.key} link={link} />)}
      </p>
    </div>
  );
}
