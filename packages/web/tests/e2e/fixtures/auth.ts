import { mkdir } from "node:fs/promises";
import { test } from "@playwright/test";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { evidenceConfig, observeLogin } from "../../../../../scripts/e2e/transportEvidence.js";
import type { LoginAttempt } from "../../../../../scripts/e2e/transportEvidence.js";
import { AUTH_STATE_PATH, STATE_DIR } from "./seedState";
import type { PlaywrightSeedState } from "./seedState";

type LoginResult = {
  accessToken: string;
  refreshToken: string;
};

export async function loginViaApi(request: APIRequestContext, seedState: PlaywrightSeedState): Promise<LoginResult> {
  return loginViaApiWithCredentials(request, seedState, {
    email: seedState.user.email,
    password: seedState.user.password,
  });
}

export async function loginViaApiWithCredentials(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  credentials: { email: string; password: string },
): Promise<LoginResult> {
  let attempt: LoginAttempt | undefined;
  try {
    const info = test.info();
    attempt = { retry: info.retry, workerIndex: info.workerIndex, parallelIndex: info.parallelIndex };
  } catch { /* global setup runs outside a test */ }
  return observeLogin(evidenceConfig(), attempt, async (headers) => {
    const response = await request.post(`${seedState.urls.api}/api/auth/login`, {
      data: credentials,
      ...(headers ? { headers } : {}),
    });
    if (!response.ok()) {
      throw new Error(`Playwright login failed: ${response.status()} ${response.statusText()}`);
    }
    return await response.json() as LoginResult;
  });
}

export async function writeAuthStorageState(
  browser: Browser,
  pageUrl: string,
  seedState: PlaywrightSeedState,
  login: LoginResult,
) {
  await mkdir(STATE_DIR, { recursive: true });

  const context = await browser.newContext();
  const page = await context.newPage();
  await injectSessionBeforeBoot(page, {
    accessToken: login.accessToken,
    refreshToken: login.refreshToken,
    serverSlug: seedState.server.slug,
  });
  await page.goto(pageUrl);
  await context.storageState({ path: AUTH_STATE_PATH });
  await context.close();
}

async function injectSessionBeforeBoot(
  page: Page,
  session: {
    accessToken: string;
    refreshToken: string;
    serverSlug: string;
  },
) {
  await page.addInitScript((data) => {
    localStorage.setItem("slock_access_token", data.accessToken);
    localStorage.setItem("slock_refresh_token", data.refreshToken);
    localStorage.setItem("slock_last_server_slug", data.serverSlug);
  }, session);
}
