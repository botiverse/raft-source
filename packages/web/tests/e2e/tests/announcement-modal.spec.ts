/**
 * Pin the account-level announcement modal contract end-to-end.
 *
 * Contract recap (mirrors AnnouncementModal.tsx header):
 *  - On page load the client fetches /api/announcements/active and renders
 *    the modal iff a row is returned AND `pages.length > 0`.
 *  - Server only ever returns the most recently published announcement,
 *    and only if the current user has not dismissed it.
 *  - Explicit close (OK on last page, ✕, background click, or Enter on
 *    last page) POSTs /:id/dismiss; subsequent loads do not resurface it.
 *  - Back / Next walk pages without dismissing. Enter advances Next on
 *    non-last pages, becomes OK on the last page.
 *
 * The seed creates one announcement and pre-dismisses it for the
 * playwright owner so unrelated tests aren't blocked by it. The
 * extraHuman has not dismissed and drives the contract here.
 *
 * Note: dismissals are persisted account-wide. Once extraHuman dismisses
 * the seeded announcement, subsequent tests on the same user can't
 * re-trigger it without re-publishing or clearing the dismissal — and
 * v0 has no API to do either at runtime. So this file holds at most
 * ONE dismissal-flow test, kept last in declaration order.
 */
import { expect, request, test } from "@playwright/test";
import { loginViaApiWithCredentials } from "../fixtures/auth";
import { AUTH_STATE_PATH, waitForSeedState } from "../fixtures/seedState";

// Use a clean storage state — the shared auth.json is for the playwright
// owner who has the announcement pre-dismissed. We need to log in fresh as
// extraHuman for these specs.
test.use({ storageState: { cookies: [], origins: [] } });

async function loginAsExtraHumanInBrowser(page: import("@playwright/test").Page) {
  const seedState = await waitForSeedState();
  const apiCtx = await request.newContext();
  try {
    const login = await loginViaApiWithCredentials(apiCtx, seedState, {
      email: seedState.extraHuman.email,
      password: seedState.extraHuman.password,
    });
    await page.addInitScript(({ accessToken, refreshToken, serverSlug }) => {
      localStorage.setItem("slock_access_token", accessToken);
      localStorage.setItem("slock_refresh_token", refreshToken);
      localStorage.setItem("slock_last_server_slug", serverSlug);
    }, {
      accessToken: login.accessToken,
      refreshToken: login.refreshToken,
      serverSlug: seedState.server.slug,
    });
  } finally {
    await apiCtx.dispose();
  }
  return seedState;
}

test.describe.serial("P0 announcement modal contract", () => {
  test("undismissed user sees the modal; Back/Next walks pages without dismissing; reload mid-walk re-surfaces it", async ({ page }) => {
    const seedState = await loginAsExtraHumanInBrowser(page);
    await page.goto(`/s/${seedState.server.slug}`);

    const modal = page.getByTestId("announcement-modal");
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("announcement-title")).toHaveText(seedState.announcement.title);

    // Page 1 — only Next is visible.
    await expect(page.getByTestId("announcement-page-body")).toContainText("First page");
    await expect(page.getByTestId("announcement-page-indicator")).toHaveText(`1 / ${seedState.announcement.pages.length}`);
    await expect(page.getByTestId("announcement-back")).toHaveCount(0);

    // Next → page 2; Back appears.
    await page.getByTestId("announcement-next").click();
    await expect(page.getByTestId("announcement-page-body")).toContainText("Second page");
    await expect(page.getByTestId("announcement-page-indicator")).toHaveText(`2 / ${seedState.announcement.pages.length}`);
    await expect(page.getByTestId("announcement-back")).toBeVisible();

    // Back → page 1.
    await page.getByTestId("announcement-back").click();
    await expect(page.getByTestId("announcement-page-body")).toContainText("First page");

    // Reload mid-walk — modal returns from page 1 because we never dismissed.
    await page.reload();
    await expect(page.getByTestId("announcement-modal")).toBeVisible();
    await expect(page.getByTestId("announcement-page-indicator")).toHaveText(`1 / ${seedState.announcement.pages.length}`);
  });

  test("Owner (pre-dismissed) never sees the modal", async ({ browser }) => {
    // The shared auth.json storage state is the playwright owner. Use it
    // straight here — the seed pre-inserted a dismissal row for them.
    const seedState = await waitForSeedState();
    const ctx = await browser.newContext({ storageState: AUTH_STATE_PATH });
    try {
      const page = await ctx.newPage();
      await page.goto(`/s/${seedState.server.slug}`);
      await expect(page.getByTestId("message-scroller")).toBeVisible();
      await expect(page.getByTestId("announcement-modal")).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  // Kept last because it permanently dismisses the seeded announcement for
  // the extraHuman user — there's no way to re-surface it in v0.
  test("Enter advances Next on non-last pages and dismisses on the last; reload after dismiss does not resurface", async ({ page }) => {
    const seedState = await loginAsExtraHumanInBrowser(page);
    await page.goto(`/s/${seedState.server.slug}`);

    const modal = page.getByTestId("announcement-modal");
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("announcement-page-indicator")).toHaveText(`1 / ${seedState.announcement.pages.length}`);

    // Press Enter to advance to the last page.
    for (let i = 0; i < seedState.announcement.pages.length - 1; i += 1) {
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("announcement-page-indicator")).toHaveText(
        `${i + 2} / ${seedState.announcement.pages.length}`,
      );
    }
    await expect(page.getByTestId("announcement-ok")).toBeVisible();
    await expect(page.getByTestId("announcement-page-indicator")).toHaveText(`${seedState.announcement.pages.length} / ${seedState.announcement.pages.length}`);

    // Enter on the last page acts as OK → dismiss.
    await page.keyboard.press("Enter");
    await expect(modal).toHaveCount(0);

    // Reload — once dismissed the modal must not resurface for this user.
    await page.reload();
    await expect(page.getByTestId("announcement-modal")).toHaveCount(0);
  });
});
