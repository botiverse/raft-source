import { expect, test } from "@playwright/test";
import { waitForSeedState } from "../../fixtures/seedState";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("P0 auth login", () => {
  test("existing user signs in and lands in the workspace", async ({ page }) => {
    const seedState = await waitForSeedState();

    await page.goto("/");

    await page.locator('input[type="email"]').fill(seedState.user.email);
    await page.locator('input[type="password"]').fill(seedState.user.password);
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page.getByRole("heading", { name: "Choose Server" })).toBeVisible();
    await page.getByRole("button", { name: /Playwright Server/ }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}`));
    await expect(page.getByTestId("message-scroller")).toBeVisible();
  });

  test("invalid password shows a clear error and stays on sign-in", async ({ page }) => {
    const seedState = await waitForSeedState();

    await page.goto("/");

    await page.locator('input[type="email"]').fill(seedState.user.email);
    await page.locator('input[type="password"]').fill(`${seedState.user.password}-wrong`);
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page.getByText("Incorrect email or password.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });
});
