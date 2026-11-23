import { expect, test } from "@playwright/test";
import { expectKeyboardReadingOrder, expectToolbarFits, LIST_TOOLBAR_WIDTHS, openListToolbarPage } from "../../fixtures/listToolbar";

// Apps: Yours / Discover are the toolbar's scope, then the search, the scope's one filter (Yours: where the App came
// from; Discover: its Category), one toolbar item, and Add App, the primary action, last
// (a + once the filters have their own line). The head holds the title alone.
for (const width of LIST_TOOLBAR_WIDTHS) {
  test(`Apps toolbar at ${width.name}: fits in at most two lines; one Tab stop, arrow keys in reading order`, async ({ browser, request }) => {
    const { context, page } = await openListToolbarPage(browser, request, width, (seed) => `/s/${seed.server.slug}/apps`);
    try {
      const frame = page.getByTestId("connected-apps-filters");
      await expectToolbarFits(frame, width);
      await expect(page.getByRole("tablist")).toHaveCount(0);
      // The scope is in the toolbar, as its segmented control or, once that no longer fits, its Select. Yours has
      // no sort, so at 420 the segmented control still fits; which one shows is the toolbar's rule, not this test's.
      await expect(page.getByTestId("connected-apps-tabs").or(page.getByTestId("connected-apps-scope-select")).filter({ visible: true })).toBeVisible();
      const addApp = frame.getByTestId("register-app-menu-trigger");
      await expect(addApp).toBeVisible();
      await expect(addApp).toHaveAccessibleName("Add app");
      if (width.viewport.width < 768) await expect(addApp).toHaveAttribute("data-fit-plus", "");
      await expectKeyboardReadingOrder(page, frame);
    } finally {
      await context.close();
    }
  });
}
