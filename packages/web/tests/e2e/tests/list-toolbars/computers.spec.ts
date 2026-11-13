import { expect, test } from "@playwright/test";
import { expectKeyboardReadingOrder, expectToolbarFits, LIST_TOOLBAR_WIDTHS, openListToolbarPage } from "../../fixtures/listToolbar";

// Computers: the search filling the first line, Status and Runtime as the scrolling filter line, Group, Sort and
// Cards / List at the end (into ⋯ together once the search would go under its least width), Add computer last: a +
// once the filters have their own line. The head holds the title and the count alone.
for (const width of LIST_TOOLBAR_WIDTHS) {
  test(`Computers toolbar at ${width.name}: fits in at most two lines; one Tab stop, arrow keys in reading order`, async ({ browser, request }) => {
    const { context, page } = await openListToolbarPage(browser, request, width, (seed) => `/s/${seed.server.slug}/computers`);
    try {
      const frame = page.getByTestId("computers-rack-toolbar");
      await expectToolbarFits(frame, width);
      const add = frame.getByTestId("computers-rack-add");
      await expect(add).toBeVisible();
      await expect(add).toHaveAccessibleName("Add computer");
      if (width.viewport.width < 768) await expect(add).toHaveAttribute("data-fit-plus", "");
      // The view switch is on the line, or folded into ⋯ (named More) with Group and Sort.
      const view = frame.getByTestId("computers-rack-view");
      if (!(await view.isVisible())) {
        const more = frame.getByTestId("computers-rack-more");
        await expect(more).toBeVisible();
        await expect(more).toHaveAccessibleName("More");
      }
      await expectKeyboardReadingOrder(page, frame);
    } finally {
      await context.close();
    }
  });
}

// A list page always shows its head, its toolbar and its list: on a phone, while the computers load, the toolbar is
// on screen (Add computer at its end) over skeleton rows, as the desktop overview shows it.
test("Computers at phone 375 while the computers load: the head, the toolbar, then skeleton rows", async ({ browser, request }) => {
  const width = LIST_TOOLBAR_WIDTHS[0];
  const { context, page } = await openListToolbarPage(browser, request, width, (seed) => `/s/${seed.server.slug}/computers`, async (context) => {
    // The machine list never answers, so the page stays loading.
    await context.route(/\/api\/servers\/[^/]+\/machines(?:\?|$)/, () => {});
  });
  try {
    const panel = page.getByTestId("mobile-computers-panel");
    const frame = panel.getByTestId("computers-rack-toolbar");
    const skeleton = panel.getByTestId("computers-loading-skeleton");
    await expect(frame).toBeVisible();
    await expect(skeleton).toBeVisible();
    await expect(frame.getByTestId("computers-rack-add")).toBeVisible();
    await expectToolbarFits(frame, width);
    // The toolbar sits above the skeleton rows.
    const [frameBox, skeletonBox] = [await frame.boundingBox(), await skeleton.boundingBox()];
    expect(frameBox!.y + frameBox!.height).toBeLessThanOrEqual(skeletonBox!.y);
  } finally {
    await context.close();
  }
});
