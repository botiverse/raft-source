import { expect, test } from "@playwright/test";
import { expectKeyboardReadingOrder, expectToolbarFits, LIST_TOOLBAR_WIDTHS, openListToolbarPage } from "../../fixtures/listToolbar";

// The search's filters: no search field of their own, one line at every width, the strip filling it and scrolling.
for (const width of LIST_TOOLBAR_WIDTHS) {
  test(`Search filters at ${width.name}: one line; one Tab stop, arrow keys in reading order`, async ({ browser, request }) => {
    const { context, page } = await openListToolbarPage(browser, request, width, (seed) => `/s/${seed.server.slug}/search?q=Seed`);
    try {
      const frame = page.locator("[data-slot=search-shell-filters]");
      await expectToolbarFits(frame, width, { search: false });
      expect(Math.round((await frame.boundingBox())!.height)).toBe(width.viewport.width >= 768 && !width.touch ? 44 : 49);
      await expectKeyboardReadingOrder(page, frame);
    } finally {
      await context.close();
    }
  });
}
