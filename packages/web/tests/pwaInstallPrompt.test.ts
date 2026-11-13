import assert from "node:assert/strict";
import {
  getCooldownState,
  getPwaInstallPlatform,
  getSessionCountBucket,
  hasPwaInstallPath,
  shouldShowPwaInstallPrompt,
} from "../src/utils/pwaInstall";

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
