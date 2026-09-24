import { chromium, request as playwrightRequest } from "@playwright/test";
import type { FullConfig } from "@playwright/test";
import { loginViaApi, writeAuthStorageState } from "./auth";
import { waitForSeedState } from "./seedState";

export default async function globalSetup(config: FullConfig) {
  const seedState = await waitForSeedState();
  const request = await playwrightRequest.newContext();
  const browser = await chromium.launch();
  try {
    const login = await loginViaApi(request, seedState);
    const baseUrl = config.projects[0]?.use?.baseURL;
    if (typeof baseUrl !== "string") {
      throw new Error("Playwright baseURL is required for global setup");
    }
    await writeAuthStorageState(
      browser,
      `${baseUrl}/s/${seedState.server.slug}`,
      seedState,
      login,
    );
  } finally {
    await request.dispose();
    await browser.close();
  }
}
