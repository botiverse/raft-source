import { expect, test } from "@playwright/test";
import { waitForSeedState } from "../fixtures/seedState";

test("language and region settings show translation mode and timezone defaults", async ({ page }) => {
  const seedState = await waitForSeedState();

  await page.goto(`/s/${seedState.server.slug}/settings/language-region`);

  await expect(page.getByRole("heading", { name: "Language & Region" })).toBeVisible();
  await expect(page.getByText("Language", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Translation mode", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Off" })).toBeChecked();
  await expect(page.getByText("Translation target", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Default view", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Date & Time", { exact: true })).toBeVisible();
  await expect(page.getByText("Timezone", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Auto-detect browser/)).toHaveCount(0);
  await expect(page.getByText("Auto-translate messages", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "English" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Translated" })).toHaveCount(0);
  await expect(page.getByRole("combobox").filter({ hasText: /^Timezone$/ })).toBeVisible();
  await expect(page.getByText(/Effective language:/)).toHaveCount(0);
  await expect(page.getByText(/Effective timezone:/)).toHaveCount(0);
});
