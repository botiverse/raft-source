import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import type { PlaywrightSeedState } from "./seedState";

type LoginResult = {
  accessToken: string;
  refreshToken: string;
};

export async function loginWithCredentials(
  request: APIRequestContext,
  apiBaseUrl: string,
  email: string,
  password: string,
): Promise<LoginResult> {
  const response = await request.post(`${apiBaseUrl}/api/auth/login`, {
    data: { email, password },
  });
  if (!response.ok()) {
    throw new Error(`Playwright login failed: ${response.status()} ${response.statusText()}`);
  }
  return response.json() as Promise<LoginResult>;
}

export async function dismissOwnerOnboarding(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
) {
  const response = await request.patch(
    `${seedState.urls.api}/api/servers/${seedState.server.id}/onboarding-settings`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        setupModalReminderOptOut: true,
        dismissedAddComputerStep: true,
        dismissedCreateAgentStep: true,
        dismissedInviteStep: true,
        dismissedCommunityStep: true,
        dismissedNotificationStep: true,
      },
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Failed to opt out of onboarding modal: ${response.status()} ${response.statusText()}`,
    );
  }
}

export async function injectSessionBeforeBoot(
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

export async function newAuthenticatedContext(
  browser: Browser,
  session: {
    accessToken: string;
    refreshToken: string;
    serverSlug: string;
  },
  options?: {
    viewport?: { width: number; height: number };
    hasTouch?: boolean;
  },
): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: options?.viewport, hasTouch: options?.hasTouch });
  await context.addInitScript((data) => {
    localStorage.setItem("slock_access_token", data.accessToken);
    localStorage.setItem("slock_refresh_token", data.refreshToken);
    localStorage.setItem("slock_last_server_slug", data.serverSlug);
  }, session);
  // Secondary-user specs do not exercise the account-level announcement
  // contract. Keep the announcement-modal spec as the sole owner of that
  // stateful fixture so shard/order changes cannot put a modal over unrelated
  // UI actions.
  await context.route("**/api/announcements/active", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ announcements: [] }),
    });
  });
  return context;
}
