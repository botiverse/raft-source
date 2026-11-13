import { expect, test } from "@playwright/test";
import { expectKeyboardReadingOrder, expectToolbarFits, LIST_TOOLBAR_WIDTHS, openListToolbarPage } from "../../fixtures/listToolbar";

// Members: one line at every width (no filters): the scope, the search filling the line, the Group menu, then
// Invite human, ⋯ (More, while it holds anything) and Create agent (a split button, the primary, last). The head holds
// the title and the count alone. The search's least width is at most 120 (raft-ui 0.90; since 0.91 a placeholder that
// doesn't fit is cut at a word, "Search…", the whole of it still its name), so even a 375 phone keeps the search a
// field: on the All tab with Invite human showing its icon alone (step 35) and nothing in ⋯, on the Agents tab once the
// Group menu and Invite human fold into ⋯ together (step 6).
for (const width of LIST_TOOLBAR_WIDTHS) {
  test(`Members toolbar at ${width.name}: one line; one Tab stop, arrow keys in reading order`, async ({ browser, request }) => {
    const { context, page } = await openListToolbarPage(browser, request, width, (seed) => `/s/${seed.server.slug}/members`);
    try {
      const frame = page.getByTestId("members-toolbar");
      await expectToolbarFits(frame, width);
      expect(Math.round((await frame.boundingBox())!.height)).toBe(width.viewport.width >= 768 && !width.touch ? 44 : 49);
      const invite = frame.getByTestId("members-invite-human");
      const create = frame.getByTestId("members-create-agent");
      const split = frame.getByTestId("members-create-agent-more");
      const more = frame.getByTestId("members-more");
      for (const control of [create, split]) await expect(control).toBeVisible();
      // The search is a field at every width, never only its button.
      await expect(frame.getByTestId("members-search")).toBeVisible();
      await expect(frame.locator("[data-fit-search-button]")).toBeHidden();
      await expect(create).toHaveAccessibleName("Create agent");
      // The split's two parts touch, the ▾ last on the line.
      const [createBox, splitBox] = [await create.boundingBox(), await split.boundingBox()];
      expect(Math.round(splitBox!.x - (createBox!.x + createBox!.width))).toBe(0);
      // Invite human on the line (its icon alone below 768, its words its name), ⋯ hidden.
      await expect(invite).toBeVisible();
      await expect(invite).toHaveAccessibleName("Invite human");
      await expect(more).toBeHidden();
      if (width.viewport.width < 768) await expect(invite).toHaveAttribute("data-fit-label", "");
      // The split takes its steps as one item (FitToolbarSplitButton): + on its main part, the ▾ kept.
      if (width.viewport.width < 768) await expect(frame.locator("[data-fit-split]")).toHaveAttribute("data-fit-plus", "");
      await expectKeyboardReadingOrder(page, frame);
    } finally {
      await context.close();
    }
  });
}

test("Members toolbar at phone 375, Agents tab: the Group menu and Invite human fold into ⋯ (named More), the search stays a field", async ({ browser, request }) => {
  const width = LIST_TOOLBAR_WIDTHS[0];
  const { context, page } = await openListToolbarPage(browser, request, width, (seed) => `/s/${seed.server.slug}/members`);
  try {
    const frame = page.getByTestId("members-toolbar");
    await frame.getByTestId("members-scope-select").click();
    await page.getByRole("option", { name: /Agents/ }).click();
    await expectToolbarFits(frame, width);
    const more = frame.getByTestId("members-more");
    await expect(frame.getByTestId("members-invite-human")).toBeHidden();
    await expect(frame.getByTestId("members-group-select")).toBeHidden();
    await expect(more).toBeVisible();
    await expect(more).toHaveAccessibleName("More");
    // The search keeps its field (its placeholder cut at a word, "Search…"), never only its button.
    await expect(frame.getByTestId("members-search")).toBeVisible();
    await expect(frame.locator("[data-fit-search-button]")).toBeHidden();
    // Invite human is reachable from ⋯, by its words.
    await more.click();
    const item = page.getByTestId("members-more-invite-human");
    await expect(item).toBeVisible();
    await expect(item).toHaveRole("menuitem");
    await expect(item).toHaveAccessibleName("Invite human");
    await page.keyboard.press("Escape");
    await expect(item).toBeHidden();
  } finally {
    await context.close();
  }
});
