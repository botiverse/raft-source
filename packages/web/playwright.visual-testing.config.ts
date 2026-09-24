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
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
