import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { playwrightScenarios } from "./playwrightScenarios";
import { openTestApp } from "./integration/app";
import { seedPlaywrightScenario } from "./seedPlaywrightScenario";
import { installRisingWaveReadReferences } from "./risingWaveReadReference";

async function main() {
  const port = Number(process.env.SLOCK_TEST_SERVER_PORT || "4174");
  const statePath = process.env.SLOCK_TEST_STATE_PATH
    ? path.resolve(process.env.SLOCK_TEST_STATE_PATH)
    : path.resolve(process.cwd(), ".playwright", "state", "playwright-server.json");

  process.env.CORS_ORIGIN ||= `http://127.0.0.1:${process.env.VITE_DEV_PORT || "4173"}`;

  // /health can become ready before seeding finishes. Never let globalSetup
  // consume IDs or a capability left over from the previous server process.
  await rm(statePath, { force: true });

  // The e2e server runs on PGlite without RisingWave (a hard dependency of the
  // product): serve the RisingWave reads from their test-only Postgres references.
  installRisingWaveReadReferences();

  const scenarioCapability = randomUUID();
  const testApp = await openTestApp(process.env.DATABASE_URL || "pglite://", port, {
    beforeApp: playwrightScenarios(scenarioCapability),
    humanActivityMuteFlagDefaultEnabled: true,
    // Browser workers share this server/IP; rate limits have server tests.
    skipAuthRateLimit: true,
  });
  const seedState = await seedPlaywrightScenario();

  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify(
      {
        ...seedState,
        scenarioCapability,
        urls: {
          api: testApp.baseUrl,
          web: process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${process.env.VITE_DEV_PORT || "4173"}`,
        },
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );

  console.log(`[playwright-server] listening on http://127.0.0.1:${port}`);
}

main().catch((err) => {
  console.error("[playwright-server] fatal:", err);
  process.exit(1);
});
