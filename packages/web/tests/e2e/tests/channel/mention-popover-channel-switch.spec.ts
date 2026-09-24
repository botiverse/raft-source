import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

async function createChannel(
  request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  seedState: Awaited<ReturnType<typeof waitForSeedState>>,
  accessToken: string,
  name: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { name },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ id: string; name: string }>;
}

function sidebarButtonName(name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:\\s+\\d+)?$`);
}

test("dismisses the @mention picker when switching channels", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const otherChannel = await createChannel(
    request,
    seedState,
    login.accessToken,
    `mention-switch-${Date.now().toString(36)}`,
  );

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const composer = page.getByPlaceholder(`Message #${seedState.channel.name}`);
  await expect(composer).toBeVisible();

  await composer.fill("@");
  await expect(page.getByTestId("mention-autocomplete-popover")).toBeVisible();

  await page
    .locator("#sidebar-section-channels button")
    .filter({ hasText: sidebarButtonName(otherChannel.name) })
    .click();
  await expect(page.getByPlaceholder(`Message #${otherChannel.name}`)).toBeVisible();
  await expect(page.getByTestId("mention-autocomplete-popover")).toHaveCount(0);
});

test("Shift+Enter inserts a newline instead of selecting an autocomplete item", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const composer = page.getByPlaceholder(`Message #${seedState.channel.name}`);
  await expect(composer).toBeVisible();

  await composer.fill("@");
  await expect(page.getByTestId("mention-autocomplete-popover")).toBeVisible();

  await composer.press("Shift+Enter");

  await expect(composer).toHaveValue("@\n");
  await expect(page.getByTestId("mention-autocomplete-popover")).toHaveCount(0);
});
