import { expect, test } from "@playwright/test";
import { waitForSeedState } from "../fixtures/seedState";

test("language and region settings show translation mode and timezone defaults", async ({ page }) => {
  const seedState = await waitForSeedState();

  await page.goto(`/s/${seedState.server.slug}/settings/language-region`);

  await expect(page.getByRole("heading", { name: "Language & region" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Off" })).toBeChecked();
  await expect(page.getByText("Translation target", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Default view", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "English" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Translated" })).toHaveCount(0);
  await expect(page.getByRole("combobox").filter({ hasText: /^Timezone$/ })).toBeVisible();
});
