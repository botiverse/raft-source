import { expect, test } from "@playwright/test";
import { expectKeyboardReadingOrder, expectToolbarFits, LIST_TOOLBAR_WIDTHS, openListToolbarPage } from "../../fixtures/listToolbar";

// The Tasks page's toolbar gives way by the rule at real widths: at 375 and 420 the scope is a Select, the filters
// a scrolling second line, New task a +. (A task open beside the list needs task_v2_conversations_v0 on the
// server, which this e2e server can't turn on: a task opens as a dialog here, so 780 stands for that list width.)
for (const width of LIST_TOOLBAR_WIDTHS) {
  test(`Tasks toolbar at ${width.name}: fits in at most two lines; one Tab stop, arrow keys in reading order`, async ({ browser, request }) => {
    const { context, page } = await openListToolbarPage(browser, request, width, (seed) => `/s/${seed.server.slug}/tasks?tab=all`);
    try {
      const frame = page.getByTestId("tasks-page-toolbar");
      await expect(frame).toBeVisible();
      await expectToolbarFits(frame, width);
      if (width.viewport.width < 768) {
        await expect(page.getByTestId("tasks-page-scope-select").filter({ visible: true })).toBeVisible();
        await expect(page.getByTestId("tasks-page-new-task")).toHaveAttribute("data-fit-plus", "");
        expect(Math.round((await frame.boundingBox())!.height), "the filters on a second line").toBe(89);
      }
      await expectKeyboardReadingOrder(page, frame);
    } finally {
      await context.close();
    }
  });
}
