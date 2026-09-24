import { expect, test } from "@playwright/test";

const LEGACY_STAGING_IDENTITY_COMMIT =
  "5ec11a117b015142bae8b8a29b45fa2dcc6ed328";

test("staging onboarding auth entry is branded, usable, and leads to account creation", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/login");

  await expect(page).toHaveTitle("Raft");
  const environmentBadge = page.getByTestId("environment-badge");
  await expect(environmentBadge).toBeVisible();
  const environmentBadgeText = (await environmentBadge.textContent())?.trim() ?? "";
  const releaseIdentityBytes = await page.locator("#raft-frontend-release-identity").textContent();
  expect(releaseIdentityBytes, "the deployed page must embed its frontend release identity").not.toBeNull();
  const releaseIdentity = JSON.parse(releaseIdentityBytes ?? "null") as {
    commitSha?: unknown;
    deploymentEnvironment?: unknown;
  } | null;
  const deployedCommitSha =
    typeof releaseIdentity?.commitSha === "string" ? releaseIdentity.commitSha.trim() : "";
  const deploymentEnvironment =
    typeof releaseIdentity?.deploymentEnvironment === "string"
      ? releaseIdentity.deploymentEnvironment.trim()
      : "";
  expect(
    deployedCommitSha,
    "the deployed frontend release identity must contain a full commit SHA",
  ).toMatch(/^[0-9a-f]{40}$/i);
  expect(
    environmentBadgeText.toLowerCase(),
    "the environment badge must identify the deployed frontend artifact",
  ).toContain(deployedCommitSha.slice(0, 8).toLowerCase());
  if (deploymentEnvironment) {
    expect(
      deploymentEnvironment,
      "the served frontend artifact must identify itself as a staging build",
    ).toBe("staging");
  } else {
    expect(
      deployedCommitSha,
      "only the exact pre-deployment-environment staging artifact may omit that identity field",
    ).toBe(LEGACY_STAGING_IDENTITY_COMMIT);
  }
  await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Password" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();

  await page.getByRole("button", { name: "Create one" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Terms of Service.*Privacy Policy/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "onboarding entry must not overflow horizontally").toBeLessThanOrEqual(1);
  expect(consoleErrors, "onboarding entry must not emit browser console errors").toEqual([]);
});
