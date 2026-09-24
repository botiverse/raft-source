import { defineConfig } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_DESKTOP_HANDSHAKE_PORT || "4183");

export default defineConfig({
  testDir: "./tests/e2e/tests",
  testMatch: "desktop-document-handshake.spec.ts",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
  },
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
