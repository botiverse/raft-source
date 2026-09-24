import { defineConfig, devices } from "@playwright/test";

const channel = process.env.PLAYWRIGHT_STAGING_CHANNEL;

export default defineConfig({
  testDir: "./tests/e2e/staging",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report/onboarding-staging", open: "never" }]]
    : "list",
  outputDir: "test-results/onboarding-staging",
  use: {
    baseURL: process.env.ONBOARDING_STAGING_BASE_URL || "https://raft-app-staging.botiverse.dev",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], ...(channel ? { channel } : {}) } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"], ...(channel ? { channel } : {}) } },
  ],
});
