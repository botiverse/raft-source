import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test, seedThreadWindow } from "../../fixtures/scenario";
import { expectThreadFocusedWindow } from "../../fixtures/readiness";

async function threadRenderedIds(page: Page): Promise<string[]> {
  return page.getByTestId("thread-message-scroller").evaluate((el) => Array.from(new Set(
    Array.from(el.querySelectorAll<HTMLElement>("[data-message-id]"))
      .map((node) => node.dataset.messageId ?? "")
      .filter(Boolean),
  )));
}

test.describe("thread search lazy hydration", () => {
  test("finds an older reply that is not in the initially rendered focused window", async ({ page, scenario }) => {
    const { seed: seedState } = scenario;
    const seeded = await seedThreadWindow(seedState);

    const threadFetches: string[] = [];
    const sentinelFetchesAfterContextRequest: string[] = [];
    let searchContextRequestSeen = false;
    page.on("request", (req) => {
      const url = req.url();
      if (
        req.method() === "GET"
        && url.includes("/messages/context/")
        && url.includes(`channelId=${seeded.threadChannelId}`)
        && !url.includes(seeded.newerReplyId)
      ) {
        searchContextRequestSeen = true;
      }
      if (req.method() === "GET" && url.includes(`/messages/channel/${seeded.threadChannelId}`)) {
        threadFetches.push(url);
        if (
          searchContextRequestSeen
          && url.includes("limit=50")
          && (url.includes("before=") || url.includes("after="))
        ) {
          sentinelFetchesAfterContextRequest.push(url);
        }
      }
    });

    await page.goto(
      `/s/${seedState.server.slug}/channel/${seedState.channel.id}` +
        `?thread=${seedState.channel.id}:${seeded.parentId}&msg=${seeded.newerReplyId}`,
    );
    const scroller = page.getByTestId("thread-message-scroller");
    await expectThreadFocusedWindow(page, seeded.newerReplyId);
    await expect(scroller.getByText(`${seeded.olderNeedle}`)).toHaveCount(0);
    const initialRenderedCount = (await threadRenderedIds(page)).length;
    expect(initialRenderedCount, "focused open should render a partial thread window").toBeLessThan(
      seeded.totalMessageRows,
    );

    await page.getByTestId("thread-search-open").click();
    await page.getByTestId("thread-search-input").fill(seeded.olderNeedle);

    await expect(page.getByTestId("thread-search-count")).toHaveText("1/1", { timeout: 10_000 });
    await expect(scroller.getByText(seeded.olderNeedle)).toBeVisible();
    await expect(scroller.locator(".bg-brutal-cyan\\/25.shadow-brutal").filter({ hasText: seeded.olderNeedle })).toBeVisible();
    const highlightedCodeMatch = scroller
      .locator("code")
      .getByTestId("thread-search-fragment-highlight")
      .filter({ hasText: seeded.olderNeedle });
    await expect(highlightedCodeMatch).toBeVisible();
    const highlightBackground = await highlightedCodeMatch.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(highlightBackground).toMatch(/\/ 0\.7\)$/);

    // Expose the top sentinel without a wheel/touch gesture. The bounded
    // context must remain stable through programmatic layout/scroll changes;
    // only a subsequent real user scroll may resume timeline pagination.
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.setTimeout(resolve, 50);
      }));
    }));
    expect(
      sentinelFetchesAfterContextRequest,
      "the bounded search context must not trigger timeline sentinel paging before a user scroll",
    ).toEqual([]);

    const olderFetch = threadFetches.find((url) => url.includes("before="));
    expect(olderFetch, "search must hydrate older thread pages instead of matching only rendered DOM").toBeTruthy();
    const finalRenderedCount = (await threadRenderedIds(page)).length;
    expect(finalRenderedCount, "search hydration should expand the loaded thread window").toBeGreaterThan(initialRenderedCount);
    expect(finalRenderedCount, "search must not force-render the full thread").toBeLessThan(
      seeded.totalMessageRows,
    );
  });
});
