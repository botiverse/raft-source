import { expect, test } from "@playwright/test";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { waitForSeedState } from "../fixtures/seedState";
import type { PlaywrightSeedState } from "../fixtures/seedState";

type Login = { accessToken: string; refreshToken: string };
type RegisteredLogin = Login & { user: { id: string } };
type ServerRecord = { id: string; slug: string; name: string };
type ServerSetupProjection = {
  phase: "not_started" | "in_progress" | "deferred" | "complete" | null;
  surface: "none" | "computer_runtime" | "create_agent" | "complete" | "retry";
  currentStep: "computer_runtime" | "create_agent" | null;
  blocksChat: boolean;
  postSetup: {
    surveyPending: boolean;
    handoffPending: boolean;
  };
};

function uniqueSlug(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toLowerCase();
}

function authHeaders(login: Login, serverId?: string) {
  return {
    Authorization: `Bearer ${login.accessToken}`,
    ...(serverId ? { "X-Server-Id": serverId } : {}),
  };
}

async function registerOnboardingUser(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  prefix: string,
): Promise<RegisteredLogin> {
  const name = uniqueSlug(prefix).replace(/-/g, "");
  const response = await request.post(`${seedState.urls.api}/api/auth/register`, {
    data: {
      email: `${name}@example.test`,
      password: "playwright-password-123",
      name,
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
      __e2eAutoVerify: true,
    },
  });
  expect(response.ok()).toBeTruthy();
  const login = await response.json() as RegisteredLogin;
  const completeProfile = await request.post(`${seedState.urls.api}/api/auth/me/complete-profile`, {
    headers: authHeaders(login),
    data: {
      name,
      displayName: `E2E ${prefix}`,
    },
  });
  expect(completeProfile.ok()).toBeTruthy();
  return login;
}

async function loginSeedUser(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  user: { email: string; password: string },
): Promise<Login> {
  const response = await request.post(`${seedState.urls.api}/api/auth/login`, {
    data: {
      email: user.email,
      password: user.password,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Login>;
}

async function createServer(request: APIRequestContext, seedState: PlaywrightSeedState, login: Login, prefix: string) {
  const slug = uniqueSlug(prefix);
  const res = await request.post(`${seedState.urls.api}/api/servers`, {
    headers: authHeaders(login),
    data: { name: `E2E ${prefix}`, slug },
  });
  expect(res.ok()).toBeTruthy();
  return await res.json() as ServerRecord;
}

async function deleteServer(request: APIRequestContext, seedState: PlaywrightSeedState, login: Login, serverId: string) {
  await request.delete(`${seedState.urls.api}/api/servers/${serverId}`, {
    headers: authHeaders(login, serverId),
  });
}

async function resetReferralSource(request: APIRequestContext, seedState: PlaywrightSeedState, login: Login) {
  const res = await request.patch(`${seedState.urls.api}/api/auth/me`, {
    headers: authHeaders(login),
    data: { referralSource: null },
  });
  expect(res.ok()).toBeTruthy();
}

async function restoreReferralSkip(request: APIRequestContext, seedState: PlaywrightSeedState, login: Login) {
  const res = await request.patch(`${seedState.urls.api}/api/auth/me`, {
    headers: authHeaders(login),
    data: { referralSourceSkipped: true },
  });
  expect(res.ok()).toBeTruthy();
}

async function openServer(
  browser: Browser,
  login: Login,
  serverSlug: string,
  path = `/s/${serverSlug}`,
) {
  const context = await browser.newContext({ storageState: undefined });
  await context.addInitScript((data) => {
    localStorage.setItem("slock_access_token", data.accessToken);
    localStorage.setItem("slock_refresh_token", data.refreshToken);
    localStorage.setItem("slock_last_server_slug", data.serverSlug);
  }, { ...login, serverSlug });
  const page = await context.newPage();
  await page.route("**/api/announcements/active", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ announcements: [] }),
    });
  });
  await page.goto(path);
  return { context, page };
}

async function expectMandatoryServerSetupGate(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  login: Login,
  serverId: string,
  page: Page,
) {
  const projectionRes = await request.get(`${seedState.urls.api}/api/servers/${serverId}/setup-projection`, {
    headers: authHeaders(login, serverId),
  });
  expect(projectionRes.ok()).toBeTruthy();
  const projection = await projectionRes.json() as ServerSetupProjection;
  expect(projection).toMatchObject({
    phase: "not_started",
    surface: "computer_runtime",
    currentStep: "computer_runtime",
    blocksChat: true,
  });
  await expect(page.getByText("Set up your server")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect a computer" })).toBeVisible();
  await expect(page.getByText("A computer is the machine your agents run on.")).toBeVisible();
  await expect(page.getByRole("button", { name: "I'll set this up myself" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
}

async function expectGrandfatheredSetupStaysOutOfOnboarding(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  login: Login,
  page: Page,
) {
  const projectionRes = await request.get(`${seedState.urls.api}/api/servers/${seedState.server.id}/setup-projection`, {
    headers: authHeaders(login, seedState.server.id),
  });
  expect(projectionRes.ok()).toBeTruthy();
  const projection = await projectionRes.json() as ServerSetupProjection;
  expect(projection).toMatchObject({
    phase: "complete",
    surface: "complete",
    currentStep: null,
    blocksChat: false,
    postSetup: {
      surveyPending: false,
      handoffPending: false,
    },
  });
  await expect(page.getByTestId("onboarding-wizard-modal")).toHaveCount(0);
  await expect(page.getByTestId("server-setup-survey")).toHaveCount(0);
  await expect(page.getByText("Set up your server")).toHaveCount(0);
}

test.describe.serial("Onboarding wizard", () => {
  test("pre-existing seeded membership does not backfill-trigger the wizard", async ({ page }) => {
    const seedState = await waitForSeedState();
    await page.goto(`/s/${seedState.server.slug}`);
    await expect(page.getByTestId("onboarding-wizard-modal")).toHaveCount(0);
  });

  test("setup P0 remains mandatory when legacy opt-out state is stored", async ({
    browser,
    request,
  }) => {
    test.setTimeout(60_000);
    const seedState = await waitForSeedState();
    const login = await registerOnboardingUser(request, seedState, "wizard-setup-user");
    const server = await createServer(request, seedState, login, "wizard-setup");
    const peerServer = await createServer(request, seedState, login, "wizard-setup-peer");

    try {
      await resetReferralSource(request, seedState, login);

      const first = await openServer(browser, login, server.slug);
      await expectMandatoryServerSetupGate(request, seedState, login, server.id, first.page);
      await expect(first.page.getByText("Don't remind me again")).toHaveCount(0);
      await expect(first.page.getByTestId("onboarding-wizard-close")).toHaveCount(0);
      await expect(first.page.getByTestId("onboarding-skip-button")).toHaveCount(0);
      await first.page.keyboard.press("Escape");
      await expectMandatoryServerSetupGate(request, seedState, login, server.id, first.page);
      await first.context.close();

      const optOut = await request.patch(
        `${seedState.urls.api}/api/servers/${server.id}/onboarding-settings`,
        {
          headers: authHeaders(login, server.id),
          data: { setupModalReminderOptOut: true },
        },
      );
      expect(optOut.ok()).toBeTruthy();

      const settingsRes = await request.get(`${seedState.urls.api}/api/servers/${server.id}/onboarding-settings`, {
        headers: authHeaders(login, server.id),
      });
      expect(settingsRes.ok()).toBeTruthy();
      const settings = await settingsRes.json() as { setupModalReminderOptOut: boolean };
      expect(settings.setupModalReminderOptOut).toBe(true);

      const reopened = await openServer(browser, login, server.slug);
      await expectMandatoryServerSetupGate(request, seedState, login, server.id, reopened.page);
      await reopened.context.close();

      const peer = await openServer(browser, login, peerServer.slug);
      await expectMandatoryServerSetupGate(request, seedState, login, peerServer.id, peer.page);
      await peer.context.close();
    } finally {
      await restoreReferralSkip(request, seedState, login);
      await deleteServer(request, seedState, login, server.id);
      await deleteServer(request, seedState, login, peerServer.id);
    }
  });

  test("grandfathered owner is not pulled into legacy referral after referral reset", async ({
    browser,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginSeedUser(request, seedState, seedState.user);

    try {
      await resetReferralSource(request, seedState, login);

      const { context, page } = await openServer(browser, login, seedState.server.slug);
      await expectGrandfatheredSetupStaysOutOfOnboarding(request, seedState, login, page);
      await expect(page.getByText("Seed message 150")).toBeVisible();
      await context.close();
    } finally {
      await restoreReferralSkip(request, seedState, login);
    }
  });

  test("invited member is not pulled into the removed legacy referral wizard", async ({ browser, request }) => {
    const seedState = await waitForSeedState();
    const memberLogin = await loginSeedUser(request, seedState, seedState.extraHuman);

    try {
      await resetReferralSource(request, seedState, memberLogin);

      const { context, page } = await openServer(browser, memberLogin, seedState.server.slug);
      await expect(page.getByTestId("onboarding-wizard-modal")).toHaveCount(0);
      await expect(page.getByText("HOW DID YOU FIND US?")).toHaveCount(0);
      await expect(page.getByText("Seed message 150")).toBeVisible();
      await context.close();
    } finally {
      await restoreReferralSkip(request, seedState, memberLogin);
    }
  });
});
