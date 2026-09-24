import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(resolve(repoRoot, "RELEASE_SOURCE"));

test("e2e CI build bakes direct API origin to avoid vite-preview websocket proxy churn", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  const workflow = readFileSync(resolve(repoRoot, ".github/workflows/test.yml"), "utf8");
  const playwrightConfig = readFileSync(resolve(webRoot, "playwright.config.ts"), "utf8");

  assert.match(
    playwrightConfig,
    /const apiPort = Number\(process\.env\.PLAYWRIGHT_API_PORT \|\| "4174"\);/,
    "Playwright's default API port is part of the CI build-time URL contract",
  );
  assert.match(
    workflow,
    /VITE_E2E=true VITE_API_URL=http:\/\/127\.0\.0\.1:4174 pnpm --filter @botiverse\/raft-web exec vite build/,
    "the e2e bundle must connect directly to the API server instead of proxying /socket.io through vite preview",
  );
});
