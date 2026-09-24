import { expect, test } from "@playwright/test";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { waitForSeedState } from "../../fixtures/seedState";

test.use({ storageState: { cookies: [], origins: [] } });

async function acceptLegalTerms(page: import("@playwright/test").Page) {
  await page
    .locator("label")
    .filter({ hasText: /I agree to the Terms of Service/ })
    .click();
}

test.describe("P0 auth register", () => {
  test("new user creates an account and lands on email verification", async ({ page }) => {
    const email = `pwuser_${Date.now()}@slock.test`;

    await page.goto("/");

    await page.getByRole("button", { name: "Create one", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Create your account", exact: true })).toBeVisible();
    await expect(page.locator('form input[type="text"]')).toHaveCount(0);

    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("playwright-password-123");
    const continueButton = page.getByRole("button", { name: "Continue", exact: true });
    await expect(continueButton).toBeDisabled();
    await acceptLegalTerms(page);
    await expect(continueButton).toBeEnabled();

    const registerResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/auth/register"
    );
    await continueButton.click();
    const registerResponse = await registerResponsePromise;
    expect(registerResponse.status()).toBe(200);
    expect(registerResponse.request().postDataJSON()).not.toHaveProperty("name");

    await expect(page.getByRole("heading", { name: "Check your email", exact: true })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByRole("button", { name: "Resend Verification Email" })).toBeVisible();
  });

  test("duplicate email shows a registration error", async ({ page }) => {
    const seedState = await waitForSeedState();

    await page.goto("/");

    await page.getByRole("button", { name: "Create one", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Create your account", exact: true })).toBeVisible();
    await expect(page.locator('form input[type="text"]')).toHaveCount(0);
    await page.getByLabel("Email", { exact: true }).fill(seedState.user.email);
    await page.getByLabel("Password", { exact: true }).fill("playwright-password-123");
    await acceptLegalTerms(page);

    const registerResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/auth/register"
    );
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const registerResponse = await registerResponsePromise;
    expect(registerResponse.status()).toBe(409);
    expect(registerResponse.request().postDataJSON()).not.toHaveProperty("name");

    await expect(page.getByText("Email is already registered")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Create your account", exact: true })).toBeVisible();
  });

  test("register API rejects stale legal versions", async ({ request }) => {
    const name = `pwstale_${Date.now()}`;
    const response = await request.post("/api/auth/register", {
      data: {
        email: `${name}@slock.test`,
        password: "playwright-password-123",
        name,
        acceptTerms: true,
        termsVersion: "stale",
        privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
      },
    });

    expect(response.status()).toBe(409);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ error: "TERMS_CHANGED" }));
  });
});
