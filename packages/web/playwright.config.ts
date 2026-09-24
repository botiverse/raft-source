import path from "node:path";
import { defineConfig } from "@playwright/test";

const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT || "4173");
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT || "4174");
const stateDir = path.resolve(process.cwd(), ".playwright", "state");
const seedStatePath = path.join(stateDir, "playwright-server.json");
const authStatePath = path.join(stateDir, "auth.json");

export default defineConfig({
  testDir: "./tests/e2e/tests",
  fullyParallel: false,
  // 1 retry on CI to absorb known infra flakiness (vite ws ECONNRESET noise +
  // occasional `socket hang up` from the pglite-backed test API server during
  // auth login, observed on 2/4 e2e shards in run 25755352840). Local stays at
  // 0 — flaky tests should fail loudly when developers run them. Retried tests
  // are reported separately by Playwright; we'll see flake rates over time.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["json", { outputFile: "test-results/results.json" }]]
    : "list",
  globalSetup: "./tests/e2e/fixtures/globalSetup.ts",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    storageState: authStatePath,
    trace: "on-first-retry",
  },
  webServer: [
    {
      // Serve the built `dist/` via `vite preview` (prod-like static serve)
      // instead of the dev server. The dev server fetched each lazy panel
      // (e.g. ProfilePanel) as an on-demand dynamic-import HTTP request, which
      // flakily REJECTED under the `/socket.io` ECONNRESET reconnect-storm —
      // Suspense then threw with no fallback, so the overlay never mounted and
      // `*-mobile-back` was never visible (back-navigation.spec flake, root
      // confirmed: lazy()→static import made it 6/6 green). Preview serves
      // static chunks (no dynamic-import fetch, no HMR ws competing with app
      // socket.io). REQUIRES `dist/` to exist — CI runs `vite build` first;
      // locally run `pnpm --filter @botiverse/raft-web build` once before `playwright
      // test` (or rely on reuseExistingServer with your own running server).
      // CI also builds the bundle with VITE_API_URL=http://127.0.0.1:4174 so
      // app HTTP + Socket.IO traffic bypasses vite-preview's ws proxy entirely.
      command: `pnpm exec vite preview --host 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        SLOCK_SERVER_PORT: String(apiPort),
        VITE_API_URL: `http://127.0.0.1:${apiPort}`,
        VITE_DEV_PORT: String(webPort),
      },
    },
    {
      command: "pnpm --dir ../server exec tsx src/test/startPlaywrightServer.ts",
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        DATABASE_URL: "pglite://",
        SLOCK_TEST_SERVER_PORT: String(apiPort),
        SLOCK_TEST_STATE_PATH: seedStatePath,
        PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${webPort}`,
        VITE_DEV_PORT: String(webPort),
        // Disable attested-send freshness in e2e so agent-message seeding
        // (sk_agent_* -> /internal/agent-api/send, see fixtures/agentMessage.ts)
        // is delivered directly instead of being held for a freshness handshake.
        SLOCK_ATTESTED_SEND_MODE: "off",
        // E2E-only: auto-verify HTTP-registered users (see userService.createUser)
        // so an ephemeral peer can author a DM message — real email verification
        // can't complete in e2e. Never set in prod/staging.
        SLOCK_E2E_AUTO_VERIFY_EMAIL: "1",
      },
    },
  ],
});
