import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { Button, TextLink, TextLinkDownloadIcon } from "@botiverse/raft-ui";
import type { MessageId } from "../../i18n/messages";
import api from "../../api/client";
import {
  DEFAULT_DESKTOP_PLATFORMS,
  desktopDownloadUrl,
  desktopTargetOs,
  detectDesktopOs,
  detectMacArch,
  offered,
  recommendedDesktopDownload,
} from "../../utils/desktopDownload";
import type { DesktopDownloadKind, DesktopOs, DesktopPlatforms, DesktopTarget } from "../../utils/desktopDownload";

async function loadDesktopPlatforms(): Promise<DesktopPlatforms> {
  const response = await api.get("/desktop-download/platforms");
  return response.data as DesktopPlatforms;
}

let loader: () => Promise<DesktopPlatforms> = loadDesktopPlatforms;
/** One request per page load, shared by every mount. */
let platformsRequest: Promise<DesktopPlatforms> | null = null;

/** Test seam: forget the shared request, optionally with a stand-in loader. */
export function resetDesktopPlatformsForTest(next: () => Promise<DesktopPlatforms> = loadDesktopPlatforms): void {
  loader = next;
  platformsRequest = null;
}

/**
 * What the Latest desktop-beta release offers. Shipping a platform (the first
 * Windows build, a universal Mac build) is a release, not a web change: the
 * server reads the release's own update feeds. Until it answers, or if it
 * cannot, the defaults keep Mac and Linux offered and Windows not.
 */
export function useDesktopPlatforms(): DesktopPlatforms {
  const [platforms, setPlatforms] = useState<DesktopPlatforms>(DEFAULT_DESKTOP_PLATFORMS);
  useEffect(() => {
    let live = true;
    platformsRequest ??= loader().catch(() => DEFAULT_DESKTOP_PLATFORMS);
    void platformsRequest.then((next) => { if (live) setPlatforms(next); });
    return () => { live = false; };
  }, []);
  return platforms;
}

const LABEL: Record<DesktopDownloadKind, MessageId> = {
  mac: "settings.desktopApp.download.mac",
  macAppleSilicon: "settings.desktopApp.download.macAppleSilicon",
  macIntel: "settings.desktopApp.download.macIntel",
  windows: "settings.desktopApp.download.windows",
  linux: "settings.desktopApp.download.linux",
};

export type DesktopDownloadOption = { target: DesktopTarget; labelId: MessageId; available: boolean };

/**
 * Every platform, in a fixed order, so nothing depends on detection being
 * right. With a universal build, one macOS entry serves every Mac.
 */
export function desktopDownloadOptions(platforms: DesktopPlatforms): DesktopDownloadOption[] {
  const mac: DesktopDownloadOption[] = platforms.mac.universal
    ? [{ target: "mac", labelId: "settings.desktopApp.option.mac", available: true }]
    : [
      { target: "mac-arm64", labelId: "settings.desktopApp.option.macAppleSilicon", available: offered(platforms.mac) },
      { target: "mac-x64", labelId: "settings.desktopApp.option.macIntel", available: offered(platforms.mac) },
    ];
  return [
    ...mac,
    { target: "windows", labelId: "settings.desktopApp.option.windows", available: platforms.windows.status === "available" },
    { target: "linux-appimage", labelId: "settings.desktopApp.option.linuxAppImage", available: offered(platforms.linux) },
    { target: "linux-deb", labelId: "settings.desktopApp.option.linuxDeb", available: offered(platforms.linux) },
  ];
}

export type DesktopDownloadView = {
  os: DesktopOs | null;
  recommended: { target: DesktopTarget; labelId: MessageId; intelHint: boolean } | null;
  /**
   * The same platform's other way in, under the button: the Intel build when
   * the release splits by chip and the browser hides it, the .deb under the
   * AppImage (raft-design getting-the-app.md).
   */
  footnote: { target: DesktopTarget; labelId: MessageId } | null;
  /** Every other platform's builds: this computer's OS is the button and the footnote. */
  others: DesktopDownloadOption[];
  /** This is a Windows PC and no Windows build has shipped. */
  windowsSoon: boolean;
  options: DesktopDownloadOption[];
};

/**
 * The recommendation for THIS computer plus every platform. Unlike the mobile
 * buttons (whose target is a phone that is not the device rendering them), a
 * desktop download is for the device in front of the reader, so recommending
 * one is grounded; a phone, tablet or unknown device gets the list only.
 */
export function useDesktopDownloadView(): DesktopDownloadView {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const os = detectDesktopOs(nav as Parameters<typeof detectDesktopOs>[0]);
  const platforms = useDesktopPlatforms();
  const [macArch, setMacArch] = useState<"arm64" | "x64" | null>(null);
  useEffect(() => {
    if (os !== "mac") return;
    let live = true;
    void detectMacArch(nav as Parameters<typeof detectMacArch>[0]).then((arch) => { if (live) setMacArch(arch); });
    return () => { live = false; };
  }, [os, nav]);
  const pick = os ? recommendedDesktopDownload(os, macArch, platforms) : null;
  const options = desktopDownloadOptions(platforms);
  const footnote: DesktopDownloadView["footnote"] = pick?.intelHint
    ? { target: "mac-x64", labelId: "settings.desktopApp.download.macIntel" }
    : pick?.target === "linux-appimage"
      ? { target: "linux-deb", labelId: "settings.desktopApp.download.linuxDeb" }
      : null;
  return {
    os,
    recommended: pick ? { target: pick.target, labelId: LABEL[pick.kind], intelHint: pick.intelHint } : null,
    footnote,
    others: pick ? options.filter((option) => desktopTargetOs(option.target) !== os) : options,
    windowsSoon: os === "windows" && !pick,
    options,
  };
}

/**
 * Settings → About: one primary button for this computer, every other platform
 * one click away below it (raft-design "Getting the app"). This computer's own
 * build isn't repeated in the list; the same OS's other build (a Mac's Intel
 * build when the chip is unknown, Linux's .deb) stays as the footnote. When
 * detection fails there is no primary button and every platform is listed.
 *
 * Same tab: each link resolves to a file download (see the Android button).
 */
export default function DesktopDownloadOptions() {
  const { formatMessage } = useIntl();
  const { recommended, footnote, windowsSoon, options } = useDesktopDownloadView();
  // As on /download: this computer's own build is the button, so the list
  // doesn't repeat it; the same OS's other build stays only where the page
  // shows it as the footnote.
  const listed = recommended ? options.filter((option) => desktopTargetOs(option.target) !== desktopTargetOs(recommended.target) || option.target === footnote?.target) : options;
  return (
    <div className="min-w-0 stack-y-3" data-testid="desktop-download">
      {recommended ? (
        <div className="stack-y-1">
          <Button
            render={(
              <a
                href={desktopDownloadUrl(recommended.target)}
                aria-label={formatMessage({ id: recommended.labelId })}
                data-testid="desktop-download-recommended"
                data-target={recommended.target}
              />
            )}
            nativeButton={false}
            variant="primary"
            size="md"
          >
            {formatMessage({ id: recommended.labelId })}
          </Button>
        </div>
      ) : windowsSoon ? (
        <div className="text-callout text-foreground" data-testid="desktop-download-windows-soon">
          {formatMessage({ id: "settings.desktopApp.windowsSoon" })}
        </div>
      ) : null}
      <div className="stack-y-1">
        <div className="text-footnote text-foreground-muted">
          {formatMessage({ id: recommended || windowsSoon ? "settings.desktopApp.otherPlatforms" : "settings.desktopApp.allPlatforms" })}
        </div>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-footnote">
          {listed.map((option) => (
            <li key={option.target}>
              {option.available ? (
                <TextLink
                  render={<a href={desktopDownloadUrl(option.target)} aria-label={formatMessage({ id: option.labelId })} data-testid={`desktop-download-${option.target}`} />}
                >
                  {formatMessage({ id: option.labelId })}
                  <TextLinkDownloadIcon />
                </TextLink>
              ) : (
                <span className="text-foreground-hint" data-testid={`desktop-download-${option.target}`}>
                  {formatMessage({ id: "settings.desktopApp.option.unavailable" }, { platform: formatMessage({ id: option.labelId }) })}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
