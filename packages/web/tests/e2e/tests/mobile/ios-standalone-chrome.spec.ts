import { expect, test } from "@playwright/test";
import { expectCssColor } from "../../fixtures/colorAssertions";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";

test.use({ viewport: { width: 390, height: 844 } });

test.describe("mobile iOS standalone chrome", () => {
  test("lets the app wrapper own the safe-area color per route", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    await loginViaApi(request, seedState);

    await page.goto(`/s/${seedState.server.slug}`);
    await expect(page.getByText(seedState.server.name)).toBeVisible();

    const rootColors = await page.evaluate(() => {
      const appRoot = document.querySelector<HTMLElement>("#root > div");
      return {
        themeColor: document
          .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
          ?.content,
        statusBarStyle: document
          .querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')
          ?.content,
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        appRoot: appRoot ? getComputedStyle(appRoot).backgroundColor : null,
      };
    });

    expect(rootColors.themeColor).toBe("#FFD440");
    expect(rootColors.statusBarStyle).toBe("black-translucent");
    await expectCssColor(page, rootColors.html, "#FFFFFF");
    await expectCssColor(page, rootColors.body, "#FFFFFF");
    await expectCssColor(page, rootColors.appRoot, "#FFD440");

    await page.goto(`/s/${seedState.server.slug}/tasks`);
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    const tasksRootColors = await page.evaluate(() => {
      const appRoot = document.querySelector<HTMLElement>("#root > div");
      return {
        themeColor: document
          .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
          ?.content,
        appRoot: appRoot ? getComputedStyle(appRoot).backgroundColor : null,
      };
    });
    expect(tasksRootColors.themeColor).toBe("#FFD440");
    await expectCssColor(page, tasksRootColors.appRoot, "#FFD440");

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByPlaceholder(`Message #${seedState.channel.name}`)).toBeVisible();

    const detailColors = await page.evaluate(() => {
      const appRoot = document.querySelector<HTMLElement>("#root > div");
      return {
        themeColor: document
          .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
          ?.content,
        appRoot: appRoot ? getComputedStyle(appRoot).backgroundColor : null,
      };
    });

    expect(detailColors.themeColor).toBe("#FFFFFF");
    await expectCssColor(page, detailColors.appRoot, "#FFFFFF");
  });
});
