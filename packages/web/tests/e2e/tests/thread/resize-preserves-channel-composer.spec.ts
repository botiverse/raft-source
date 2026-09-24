import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

test("thread presentation follows the phone, iPad orientation, and desktop width matrix", async ({
  page,
  request,
}) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const suffix = Date.now();
  const parentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: `thread resize parent ${suffix}`,
    },
  });
  expect(parentResponse.ok()).toBeTruthy();
  const parent = (await parentResponse.json()) as { id: string };

  const threadResponse = await request.post(
    `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
    {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        parentMessageId: parent.id,
        content: `thread resize reply ${suffix}`,
      },
    },
  );
  expect(threadResponse.ok()).toBeTruthy();

  await page.setViewportSize({ width: 1700, height: 1000 });
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await page.evaluate(() => localStorage.setItem("slock:threadPanelWidth", "900"));
  await page.evaluate(() => localStorage.setItem("slock:sidebarWidth", "320"));
  await page.reload();
  // The shared E2E seed channel can contain parents created by concurrent
  // workers. Anchor the badge to this test's exact parent instead of relying
  // on timeline order, which can change while the page is loading.
  const parentMessageCard = page.locator(`#message-${parent.id}`).first();
  await parentMessageCard.scrollIntoViewIfNeeded();
  await expect(parentMessageCard).toBeVisible();
  const parentInlineReplies = parentMessageCard.locator(
    '[data-message-affordance="inline-thread-replies"]',
  );
  await expect(parentInlineReplies).toBeVisible();
  await parentInlineReplies.click();
  await expect(page).toHaveURL(new RegExp(`thread=${seedState.channel.id}(?:%3A|:)${parent.id}`));

  await expect(page.getByTestId("thread-message-scroller")).toBeVisible();
  const channelComposer = page.getByPlaceholder(`Message #${seedState.channel.name}`);
  await expect(channelComposer).toBeVisible();

  await page.setViewportSize({ width: 1100, height: 820 });

  await expect
    .poll(async () => channelComposer.evaluate((input) => input.closest("form")?.clientWidth ?? 0))
    .toBeGreaterThanOrEqual(318);

  const layout = await channelComposer.evaluate((input) => {
    const channelForm = input.closest("form");
    const threadPanel = document.querySelector<HTMLElement>('[data-testid="thread-side-column"]');
    if (!channelForm || !threadPanel) throw new Error("channel/thread layout not available");

    return {
      channelWidth: Math.round(channelForm.getBoundingClientRect().width),
      channelOverflow: channelForm.scrollWidth - channelForm.clientWidth,
      threadMaxWidth: getComputedStyle(threadPanel).maxWidth,
      storedThreadWidth: localStorage.getItem("slock:threadPanelWidth"),
    };
  });

  expect(layout).toEqual({
    channelWidth: 320,
    channelOverflow: 0,
    threadMaxWidth: "calc(100% - 320px)",
    storedThreadWidth: "900",
  });

  // iPad mini 6 portrait: 744 CSS px (1488 physical px at DPR 2). The row is
  // wider than the old 680px geometric floor, but portrait tablet content is
  // not readable as two half-width panes and must remain thread-only.
  await page.setViewportSize({ width: 744, height: 1133 });

  const threadLayout = page.getByTestId("thread-layout-container");
  const threadPanel = page.getByTestId("thread-side-column");
  await expect(threadLayout).toHaveCSS("container-type", "inline-size");
  await expect(threadPanel).toHaveCSS("position", "absolute");
  await expect(channelComposer).not.toBeVisible();
  await expect(page.getByTestId("thread-mobile-back")).toBeVisible();
  await expect(page.getByTestId("thread-close")).not.toBeVisible();

  const portraitTabletGeometry = await threadPanel.evaluate((panel) => {
    const row = panel.parentElement;
    if (!row) throw new Error("thread layout row not available");
    return {
      rowWidth: Math.round(row.getBoundingClientRect().width),
      panelWidth: Math.round(panel.getBoundingClientRect().width),
    };
  });
  expect(portraitTabletGeometry.rowWidth).toBeGreaterThanOrEqual(680);
  expect(portraitTabletGeometry.panelWidth).toBe(portraitTabletGeometry.rowWidth);

  // The same iPad in landscape has enough usable row width and should restore
  // the dual-pane desktop chrome without remounting the channel surface.
  await page.setViewportSize({ width: 1133, height: 744 });
  await expect(channelComposer).toBeVisible();
  await expect(threadPanel).toHaveCSS("position", "relative");
  await expect(page.getByTestId("thread-mobile-back")).not.toBeVisible();
  await expect(page.getByTestId("thread-close")).toBeVisible();

  // A wide portrait desktop may still use two panes; the portrait override is
  // intentionally tablet-sized rather than an orientation-only device guess.
  await page.setViewportSize({ width: 1280, height: 1600 });
  await expect(channelComposer).toBeVisible();
  await expect(threadPanel).toHaveCSS("position", "relative");

  // A landscape desktop whose actual chat row falls below 680px remains
  // thread-only, preserving #4590's rail/sidebar-aware container contract.
  await page.setViewportSize({ width: 1024, height: 820 });

  await expect(threadPanel).toHaveCSS("position", "absolute");
  await expect(threadPanel).toHaveCSS("inset", "0px");
  await expect(channelComposer).not.toBeVisible();
  await expect(page.getByTestId("thread-mobile-back")).toBeVisible();
  await expect(page.getByTestId("thread-close")).not.toBeVisible();

  const threadOnlyGeometry = await threadPanel.evaluate((panel) => {
    const row = panel.parentElement;
    if (!row) throw new Error("thread layout row not available");
    const panelRect = panel.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      rowWidth: Math.round(rowRect.width),
      panelWidth: Math.round(panelRect.width),
      leftDelta: Math.round(panelRect.left - rowRect.left),
      rightDelta: Math.round(rowRect.right - panelRect.right),
    };
  });
  expect(threadOnlyGeometry.rowWidth).toBeLessThan(680);
  expect(threadOnlyGeometry.panelWidth).toBe(threadOnlyGeometry.rowWidth);
  expect(threadOnlyGeometry.leftDelta).toBe(0);
  expect(threadOnlyGeometry.rightDelta).toBe(0);

  // Layout changes do not change navigation ownership: this regular thread
  // was opened with one PUSH, so its visible Back consumes that entry and
  // restores the exact parent channel surface.
  await page.getByTestId("thread-mobile-back").click();
  await expect(threadPanel).not.toBeVisible();
  await expect(channelComposer).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/s/${seedState.server.slug}/channel/${seedState.channel.id}$`),
  );
});
