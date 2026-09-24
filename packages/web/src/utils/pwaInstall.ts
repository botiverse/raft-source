export type PwaInstallPlatform =
  | "ios_safari"
  | "ios_other"
  | "android_chromium"
  | "desktop_chromium"
  | "other";

export type PwaInstallSurface = "notification_center" | "ios_instruction_sheet" | "settings";
export type PwaInstallTrigger = "supported_browser" | "settings";
export type PwaInstallDisplayMode = "browser" | "standalone" | "fullscreen" | "minimal-ui" | "unknown";
export type PwaInstallCooldownState = "not_dismissed" | "dismissed_active" | "expired";

export interface PwaInstallTelemetryEvent {
  event:
    | "pwa_install_eligible"
    | "pwa_install_cta_shown"
    | "pwa_install_cta_clicked"
    | "pwa_install_native_prompt_result"
    | "pwa_install_ios_instruction_dismissed"
    | "pwa_install_appinstalled"
    | "pwa_install_standalone_detected";
  platform: PwaInstallPlatform;
  surface: PwaInstallSurface;
  trigger: PwaInstallTrigger;
  displayMode: PwaInstallDisplayMode;
  sessionCountBucket: "1" | "2" | "3-5" | "6+";
  cooldownState: PwaInstallCooldownState;
  outcome?: "accepted" | "dismissed";
}

export const PWA_INSTALL_SESSION_DISMISSED_KEY = "slock:pwa-install:dismissed-session";
export const PWA_INSTALL_SESSION_COUNT_KEY = "slock:pwa-install:session-count";
export const PWA_INSTALL_SESSION_SEEN_KEY = "slock:pwa-install:session-seen";
export const PWA_INSTALL_ELIGIBLE_DAILY_KEY = "slock:pwa-install:eligible-daily";
export const PWA_INSTALL_OPEN_EVENT = "slock:pwa-install-open";

export interface PwaInstallPromptChoiceEvent extends Event {
  outcome: "accepted" | "dismissed";
}

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<PwaInstallPromptChoiceEvent>;
  prompt(): Promise<void>;
}

export function getPwaInstallPlatform(userAgent: string): PwaInstallPlatform {
  const ua = userAgent.toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(ua) || (ua.includes("macintosh") && ua.includes("mobile"));
  const isAndroid = ua.includes("android");
  const isChromium = ua.includes("chrome") || ua.includes("crios") || ua.includes("edg/") || ua.includes("edga/");
  const isIOSInAppBrowser =
    /fban|fbav|fb_iab|instagram|micromessenger|line\/|tiktok|bytedance|twitter|linkedinapp/.test(ua);
  const isSafari =
    ua.includes("safari") &&
    ua.includes("version/") &&
    !ua.includes("crios") &&
    !ua.includes("fxios") &&
    !ua.includes("edgios") &&
    !isIOSInAppBrowser;

  if (isIOS) return isSafari ? "ios_safari" : "ios_other";
  if (isAndroid && isChromium) return "android_chromium";
  if (!isAndroid && !isIOS && isChromium) return "desktop_chromium";
  return "other";
}

export function hasPwaInstallPath({
  platform,
  hasNativePrompt,
}: {
  platform: PwaInstallPlatform;
  hasNativePrompt: boolean;
}): boolean {
  // Chromium's installability signal is the browser-controlled
  // `beforeinstallprompt` event. iOS has no equivalent native event; only
  // Safari can complete Add to Home Screen from in-page instructions.
  if (platform === "ios_safari") return true;
  if (platform === "android_chromium" || platform === "desktop_chromium") return hasNativePrompt;
  return false;
}

export function getPwaInstallDisplayMode(win: Window): PwaInstallDisplayMode {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return "standalone";
  if (win.matchMedia?.("(display-mode: standalone)").matches) return "standalone";
  if (win.matchMedia?.("(display-mode: fullscreen)").matches) return "fullscreen";
  if (win.matchMedia?.("(display-mode: minimal-ui)").matches) return "minimal-ui";
  if (win.matchMedia?.("(display-mode: browser)").matches) return "browser";
  return "unknown";
}

export function isPwaStandalone(win: Window): boolean {
  const mode = getPwaInstallDisplayMode(win);
  return mode === "standalone" || mode === "fullscreen" || mode === "minimal-ui";
}

export function getSessionCountBucket(count: number): PwaInstallTelemetryEvent["sessionCountBucket"] {
  if (count <= 1) return "1";
  if (count === 2) return "2";
  if (count <= 5) return "3-5";
  return "6+";
}

export function getCooldownState(now: number, dismissedUntil: number | null): PwaInstallCooldownState {
  if (!dismissedUntil) return "not_dismissed";
  return dismissedUntil > now ? "dismissed_active" : "expired";
}

export function shouldShowPwaInstallPrompt({
  platform,
  standalone,
  cooldownState,
  hasNativePrompt,
}: {
  platform: PwaInstallPlatform;
  standalone: boolean;
  cooldownState: PwaInstallCooldownState;
  hasNativePrompt: boolean;
}): boolean {
  if (standalone || cooldownState === "dismissed_active") return false;
  return hasPwaInstallPath({ platform, hasNativePrompt });
}

export function readNumberStorage(storage: Storage, key: string): number | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function recordPwaInstallEvent(event: PwaInstallTelemetryEvent): void {
  // Analytics client is not wired in the web app yet. Keep the event shape
  // centralized so a future tracking adapter can consume this function without
  // touching install-prompt UI code.
  if (import.meta.env.DEV) {
    console.info("[pwa-install]", event.event, event);
  }
}
