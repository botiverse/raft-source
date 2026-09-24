import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Capture of the per-row invite role UI for design review (@cindyz, task #602).
 *
 * Drives the real controls — adds a row and picks Guest through the raft-ui
 * Select — rather than prefilling state, so the image shows what an inviter
 * actually gets.
 *
 * LOCAL-ONLY: this is a capture aid, not a Hosted gate.
 */

// Repo-root `artifacts/visual-testing/` is the gitignored home for local
// visual-testing playwright output; do not invent a new untracked directory.
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../artifacts/visual-testing/invite-role");
const CASE = (id: string, theme: "brutal" | "elegant") =>
  `/visual-testing.html?case=${id}` + (theme === "elegant" ? "&theme=elegant" : "");

for (const theme of ["brutal", "elegant"] as const) {
  test(`invite per-row role — ${theme}`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    // Desktop width too: the dialog is max-w-lg, so at the 390px mobile viewport
    // it is clamped and the widening is invisible.
    await page.setViewportSize({ width: 1024, height: 900 });
    // Keep the join-link row from showing its failure banner: the dialog fetches
    // a link on mount and an unmocked call would render "Failed to prepare join
    // link" across the shot.
    await page.route("**/join-links", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "link-1", token: "join-token" }]) }));
    await page.route("**/feature-flags/evaluate", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ values: { server_guest_v0: true }, resolved: true }) }));

    await page.goto(CASE("components.members.invite-human.per-row-role", theme));

    const emails = page.getByRole("textbox", { name: "Email address" });
    await expect(emails).toHaveCount(1);
    await emails.first().fill("colleague@example.com");

    await page.getByRole("button", { name: "Add another" }).click();
    await expect(emails).toHaveCount(2);
    await emails.nth(1).fill("outsider@example.com");

    // Second row -> Guest, through the real Select.
    const roles = page.getByRole("combobox", { name: "Role" });
    await expect(roles).toHaveCount(2);
    await roles.nth(1).click();
    await page.getByRole("option", { name: "Guest" }).click();

    await expect(page.getByRole("button", { name: /Remove invitee/ })).toHaveCount(2);
    await page.screenshot({ path: `${OUT}/per-row-role-${theme}.png` });
  });

  test(`invite gate off — ${theme}`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.route("**/join-links", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "link-1", token: "join-token" }]) }));
    await page.goto(CASE("components.members.invite-human.gate-off", theme));

    const emails = page.getByRole("textbox", { name: "Email address" });
    await expect(emails).toHaveCount(1);
    await emails.first().fill("colleague@example.com");
    // No role column at all when Guest is not on offer.
    await expect(page.getByRole("combobox", { name: "Role" })).toHaveCount(0);
    await page.screenshot({ path: `${OUT}/gate-off-${theme}.png` });
  });
}
