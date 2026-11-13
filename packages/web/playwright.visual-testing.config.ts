import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { defineConfig, devices } = require("@playwright/test");

const port = Number(process.env.PLAYWRIGHT_WEB_PORT || 4173);
// Same clock as the Android visual host: the shared fixture's declared timezone.
// Fail closed rather than silently capturing in the CI machine's zone.
const fixtureLocale = require("../visual-testing/shared/fixtureData.json").locale;
if (!fixtureLocale?.timezone) {
  throw new Error("visual-testing/shared/fixtureData.json must declare locale.timezone");
}

export default defineConfig({
  testDir: "../visual-testing/tests",
  timeout: 30_000,
  workers: 1,
  retries: 0,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 390, height: 844 },
    // Task #342: capture at 3x so React and Android (emulator pinned to
    // 480dpi) emit identical 1170px-wide images — the pixel-perfect diff
    // pads rather than rescales, so provider sizes must match exactly.
    deviceScaleFactor: 3,
    // Browser-level zone (task #536, S1). `locale` is intentionally left at the
    // Playwright default: the app derives its translation language from
    // navigator.languages, and the captures must not switch UI language.
    timezoneId: fixtureLocale.timezone,
    // Linux Chrome hints fonts and snaps every glyph's advance to a whole CSS px: bold
    // Space Grotesk at 14px came out ~6% wider and Space Mono at 12px ~5% narrower than the
    // font's own metrics, which is what Chrome on macOS, Android and iOS draw (fractional
    // advances). Unhinted text keeps the metrics, so React and the apps compare like for like
    // (artin 2026-11-02: text width drift in every overlay).
    //
    // Emulated deviceScaleFactor alone also snaps a border to whole CSS px: raft-ui's 1.5px
    // control stroke (buttons, fields, selects) came out 1px (3 device px) where Chrome on a
    // real 2x/3x screen draws 1.5px, so every Android outline read as twice as heavy. Forcing
    // the same scale on the browser makes borders snap to device pixels, as on a device.
    launchOptions: { args: ["--font-render-hinting=none", "--force-device-scale-factor=3"] },
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
