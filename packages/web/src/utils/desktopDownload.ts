import { RUNTIME_API_BASE } from "../runtimeEndpoints";

/**
 * Raft Desktop download targets, as `/api/desktop-download?target=` accepts
 * them. The server resolves each to the installer on the Latest desktop-beta
 * release, through the same feed the app's auto-updater reads.
 */
export type DesktopTarget = "mac" | "mac-arm64" | "mac-x64" | "linux-appimage" | "linux-deb" | "windows";

export function desktopDownloadUrl(target: DesktopTarget, apiBase: string = RUNTIME_API_BASE): string {
  return `${apiBase.replace(/\/$/, "")}/desktop-download?target=${target}`;
}

/** Which desktop OS this browser runs on, or null (a phone, a tablet, unknown). */
export type DesktopOs = "mac" | "windows" | "linux";

/** The OS a download target is a build for. */
export function desktopTargetOs(target: DesktopTarget): DesktopOs {
  if (target.startsWith("mac")) return "mac";
  return target === "windows" ? "windows" : "linux";
}

type NavigatorLike = {
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string; mobile?: boolean };
};

/**
 * The desktop OS of THIS device.
 *
 * Unlike the mobile buttons (whose target is a phone that is not the device
 * rendering them), a desktop download is for the computer in front of the
 * reader, so recommending one is grounded. Still a recommendation only: every
 * platform stays one click away.
 *
 * - An iPad sends a Mac User-Agent; `maxTouchPoints` tells it apart (desktop
 *   Safari reports 0). A phone or tablet gets no recommendation.
 * - Chromium's `userAgentData.platform` is preferred when present; the UA
 *   string is the fallback (Safari, Firefox).
 * - ChromeOS and Android are not desktop targets.
 */
export function detectDesktopOs(nav: NavigatorLike | undefined): DesktopOs | null {
  if (!nav) return null;
  const ua = nav.userAgent ?? "";
  if (nav.userAgentData?.mobile) return null;
  const platform = nav.userAgentData?.platform;
  // Client hints report the real platform even when the UA lies: Chrome on a
  // large Android tablet defaults to a desktop UA ("X11; Linux x86_64") but
  // still says "Android" here.
  if (platform) {
    if (/^macos$/i.test(platform)) return (nav.maxTouchPoints ?? 0) > 1 ? null : "mac";
    if (/^windows$/i.test(platform)) return "windows";
    if (/^linux$/i.test(platform)) return linuxIfSupported(ua);
    return null;
  }
  if (/android|iphone|ipad|ipod|\bCrOS\b/i.test(ua)) return null;
  if (/Macintosh|Mac OS X/i.test(ua)) return (nav.maxTouchPoints ?? 0) > 1 ? null : "mac";
  if (/Windows NT/i.test(ua)) return "windows";
  // A touch screen with a Linux UA and no client hints is most likely an
  // Android tablet in desktop mode (Firefox, or Chrome without "Android"):
  // don't hand it an AppImage. A touchscreen Linux laptop gets the list too.
  if (/Linux|X11/i.test(ua)) return (nav.maxTouchPoints ?? 0) > 1 ? null : linuxIfSupported(ua);
  return null;
}

/** Only x86_64 Linux builds exist; an ARM Linux machine (Asahi, Pi) gets no recommendation. */
function linuxIfSupported(ua: string): DesktopOs | null {
  return /aarch64|arm64|armv\d/i.test(ua) ? null : "linux";
}

type HighEntropyNavigator = {
  userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> };
};

/**
 * The Mac's chip, when the browser will say: Chromium answers through
 * `getHighEntropyValues(["architecture"])` ("arm" / "x86"); Safari and Firefox
 * report every Mac as Intel in the UA, so they get null rather than a wrong
 * answer. Once a universal build ships, the server serves it for every Mac
 * target and this only decides a label.
 */
export async function detectMacArch(nav: HighEntropyNavigator | undefined): Promise<"arm64" | "x64" | null> {
  const get = nav?.userAgentData?.getHighEntropyValues;
  if (!get) return null;
  try {
    const { architecture } = await get.call(nav.userAgentData, ["architecture"]);
    if (architecture === "arm") return "arm64";
    if (architecture === "x86") return "x64";
    return null;
  } catch {
    return null;
  }
}

/** What the Latest release offers (`/api/desktop-download/platforms`). */
export type PlatformStatus = { status: "available" | "none" | "unknown"; version?: string };
export type DesktopPlatforms = { mac: PlatformStatus & { universal?: boolean }; linux: PlatformStatus; windows: PlatformStatus };

/** Until the release answers: Mac and Linux have always shipped, Windows has not. */
export const DEFAULT_DESKTOP_PLATFORMS: DesktopPlatforms = {
  mac: { status: "unknown" },
  linux: { status: "unknown" },
  windows: { status: "none" },
};

/** Whether to offer a platform: yes unless the release says it has none. */
export function offered(platform: PlatformStatus | undefined): boolean {
  return platform?.status !== "none";
}

/**
 * The button for this device, or null when there is nothing to offer it.
 *
 * Without a universal build a Mac whose chip the browser hides (Safari,
 * Firefox) gets the Apple silicon build, labelled as such, with the Intel
 * build named right under it: a plain "Download for Mac" would hand an Intel
 * Mac an app that does not open. With a universal build every Mac gets it.
 */
/** Which recommendation this is; the component maps it to its message. */
export type DesktopDownloadKind = "mac" | "macAppleSilicon" | "macIntel" | "windows" | "linux";

export function recommendedDesktopDownload(
  os: DesktopOs,
  macArch: "arm64" | "x64" | null,
  platforms: DesktopPlatforms,
): { target: DesktopTarget; kind: DesktopDownloadKind; intelHint: boolean } | null {
  if (os === "mac") {
    if (!offered(platforms.mac)) return null;
    if (platforms.mac.universal) return { target: "mac", kind: "mac", intelHint: false };
    if (macArch === "x64") return { target: "mac-x64", kind: "macIntel", intelHint: false };
    return { target: "mac-arm64", kind: "macAppleSilicon", intelHint: macArch === null };
  }
  if (os === "linux") return offered(platforms.linux) ? { target: "linux-appimage", kind: "linux", intelHint: false } : null;
  return platforms.windows.status === "available" ? { target: "windows", kind: "windows", intelHint: false } : null;
}
