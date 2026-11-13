import { expect, test } from "@playwright/test";
import { expectKeyboardReadingOrder, LIST_TOOLBAR_WIDTHS, openListToolbarPage, settled } from "../../fixtures/listToolbar";

// A channel's Tasks section, beside the conversation (raft-design tasks.md › A channel's Tasks section): its scope,
// All / For me, is a FitToolbar's, one Tab stop (the section renders only once the side area has put it in the
// document: mounted detached, the scope kept none), nothing poking out of the column; New task stays in its head.
const WIDTHS = [{ name: "1280", viewport: { width: 1280, height: 800 }, touch: false } as const, ...LIST_TOOLBAR_WIDTHS.filter((width) => width.touch)];
for (const width of WIDTHS) {
  test(`Channel Tasks section toolbar at ${width.name}: fits its column; one Tab stop, arrow keys in reading order`, async ({ browser, request }) => {
    const { context, page } = await openListToolbarPage(browser, request, width, (seed) => `/s/${seed.server.slug}/channel/${seed.channel.id}?chatTab=tasks`);
    try {
      const frame = page.getByTestId("channel-tasks-toolbar");
      const toolbar = frame.locator("[data-slot=fit-toolbar]");
      await expect(toolbar).toBeVisible();
      await settled(toolbar);
      const [frameBox, toolbarBox] = [await frame.boundingBox(), await toolbar.boundingBox()];
      expect(toolbarBox!.x).toBeGreaterThanOrEqual(frameBox!.x);
      expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(frameBox!.x + frameBox!.width + 1);
      await expect(frame.getByTestId("channel-tasks-filter-all")).toBeVisible();
      await expect(frame.getByTestId("channel-tasks-filter-mine")).toBeVisible();
      await expectKeyboardReadingOrder(page, frame);
    } finally {
      await context.close();
    }
  });
}
