import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  getCooldownState,
  getPwaInstallPlatform,
  getSessionCountBucket,
  hasPwaInstallPath,
  shouldShowPwaInstallPrompt,
} from "../src/utils/pwaInstall.ts";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

test("PWA install platform detection separates iOS Safari from non-Safari iOS", () => {
  assert.equal(
    getPwaInstallPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
    "ios_safari",
  );
  assert.equal(
    getPwaInstallPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.0.0 Mobile/15E148 Safari/604.1"),
    "ios_other",
  );
  assert.equal(
    getPwaInstallPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36"),
    "android_chromium",
  );
  assert.equal(
    getPwaInstallPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0.0"),
    "ios_other",
  );
});

test("PWA install auto prompt is capability-gated, standalone-aware, and dismissible", () => {
  const base = {
    platform: "ios_safari" as const,
    standalone: false,
    cooldownState: "not_dismissed" as const,
    hasNativePrompt: false,
  };

  assert.equal(shouldShowPwaInstallPrompt(base), true);
  assert.equal(shouldShowPwaInstallPrompt({ ...base, standalone: true }), false);
  assert.equal(shouldShowPwaInstallPrompt({ ...base, cooldownState: "dismissed_active" }), false);
  assert.equal(shouldShowPwaInstallPrompt({ ...base, platform: "ios_other" }), false);
  assert.equal(shouldShowPwaInstallPrompt({ ...base, platform: "other" }), false);
});

test("Chromium install surfaces require a captured native beforeinstallprompt event", () => {
  const base = {
    platform: "android_chromium" as const,
    standalone: false,
    cooldownState: "not_dismissed" as const,
  };
  assert.equal(shouldShowPwaInstallPrompt({ ...base, hasNativePrompt: false }), false);
  assert.equal(shouldShowPwaInstallPrompt({ ...base, hasNativePrompt: true }), true);
  assert.equal(shouldShowPwaInstallPrompt({ ...base, platform: "desktop_chromium", hasNativePrompt: false }), false);
  assert.equal(shouldShowPwaInstallPrompt({ ...base, platform: "desktop_chromium", hasNativePrompt: true }), true);
  assert.equal(hasPwaInstallPath({ platform: "ios_safari", hasNativePrompt: false }), true);
  assert.equal(hasPwaInstallPath({ platform: "ios_other", hasNativePrompt: false }), false);
});

test("dismiss cooldown and session buckets match analytics contract", () => {
  assert.equal(getCooldownState(1000, null), "not_dismissed");
  assert.equal(getCooldownState(1000, 2000), "dismissed_active");
  assert.equal(getCooldownState(1000, 500), "expired");
  assert.equal(getSessionCountBucket(1), "1");
  assert.equal(getSessionCountBucket(2), "2");
  assert.equal(getSessionCountBucket(5), "3-5");
  assert.equal(getSessionCountBucket(6), "6+");
});

test("PWA install UI is wired into mobile layout and Browser settings only", () => {
  const mainLayout = readFileSync(resolve(repoRoot, "src/components/layout/MainLayout.tsx"), "utf8");
  const settings = readFileSync(resolve(repoRoot, "src/components/settings/SettingsPanel.tsx"), "utf8");
  const prompt = readFileSync(resolve(repoRoot, "src/components/pwa/PwaInstallPrompt.tsx"), "utf8");
  const notifications = readFileSync(resolve(repoRoot, "src/components/layout/useSystemNotifications.tsx"), "utf8");
  const notificationCenter = readFileSync(resolve(repoRoot, "src/components/ui/NotificationCenter.tsx"), "utf8");
  const illustration = readFileSync(resolve(repoRoot, "public/pwa/ios-add-to-home-screen-3step.svg"), "utf8");

  assert.match(mainLayout, /import PwaInstallPrompt from "\.\.\/pwa\/PwaInstallPrompt"/);
  assert.match(mainLayout, /<PwaInstallPrompt \/>/);
  assert.match(settings, /import \{ PwaInstallSettingsCard \} from "\.\.\/pwa\/PwaInstallPrompt"/);
  assert.match(settings, /<PwaInstallSettingsCard \/>/);
  assert.doesNotMatch(prompt, /function NativeInstallBanner/);
  assert.match(notifications, /id: "pwa-install"/);
  assert.match(notifications, /kind: "info"/);
  assert.match(notifications, /id: pwaInstallBusy \? "layout\.systemNotifications\.opening" : "layout\.systemNotifications\.install"/);
  assert.match(notifications, /variant: "primary"/);
  assert.match(notificationCenter, /isPrimary \? "bg-brutal-pink" : "bg-white"/);
  assert.match(prompt, /if \(standalone\) return null/);
  assert.doesNotMatch(prompt, /NativeInstallBanner[\s\S]*bg-soft-signal/);
  assert.match(prompt, /data-pwa-install-settings-card[\s\S]*md:hidden/);
  assert.match(prompt, /PWA_INSTALL_SESSION_DISMISSED_KEY/);
  assert.match(notifications, /PWA_INSTALL_SESSION_DISMISSED_KEY/);
  assert.match(notifications, /window\.sessionStorage\.setItem\(PWA_INSTALL_SESSION_DISMISSED_KEY, "1"\)/);
  assert.match(notifications, /PWA_INSTALL_OPEN_EVENT/);
  assert.match(notifications, /beforeinstallprompt/);
  assert.match(notifications, /pwa_install_cta_shown/);
  assert.match(notifications, /supported_browser/);
  assert.match(notifications, /trackPwaInstall\("pwa_install_cta_shown", "notification_center"\)/);
  assert.doesNotMatch(prompt, /firstEngagementCompleted|PWA_INSTALL_ENGAGEMENT_KEY|session_count_2/);
  assert.doesNotMatch(prompt, /PWA_INSTALL_DISMISS_UNTIL_KEY/);
  assert.match(prompt, /\/pwa\/ios-add-to-home-screen-3step\.svg/);
  assert.match(illustration, /Tap Share/);
  assert.doesNotMatch(prompt, /mobile_menu/);
});
