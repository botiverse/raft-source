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

  // Compare painted boundaries, rather than just checking that both panels
  // reuse MessageInput. Nested RUI footers previously added a second inset.
  const geometry = await page.evaluate(() => {
    const sidebar = document.querySelector('[data-slot="sidebar-root"]')!;
    const channel = document.querySelector('[data-slot="conversation-panel-root"]')!;
    const thread = document.querySelector('[data-slot="thread-panel-root"]')!;
    const channelInput = channel.querySelector('[data-slot="composer"]')!;
    const threadInput = thread.querySelector('[data-slot="composer"]')!;
    const channelRect = channel.getBoundingClientRect();
    const threadRect = thread.getBoundingClientRect();
    return {
      bottomDelta: channelInput.getBoundingClientRect().bottom - threadInput.getBoundingClientRect().bottom,
      channelInset: channelRect.bottom - channelInput.getBoundingClientRect().bottom,
      threadInset: threadRect.bottom - threadInput.getBoundingClientRect().bottom,
      sidebarHeight: sidebar.getBoundingClientRect().height,
      panelHeight: channelRect.height,
      sidebarDivider: parseFloat(getComputedStyle(sidebar).borderRightWidth) + parseFloat(getComputedStyle(channel).borderLeftWidth),
      threadDivider: parseFloat(getComputedStyle(thread).borderLeftWidth),
    };
  });
  expect(Math.abs(geometry.bottomDelta)).toBeLessThanOrEqual(1);
  expect(geometry.channelInset).toBe(geometry.threadInset);
  expect(geometry.sidebarHeight).toBe(geometry.panelHeight);
  expect(geometry.sidebarDivider).toBe(geometry.threadDivider);
  expect(geometry.sidebarDivider).toBeGreaterThan(0);

  await page.getByRole("tab", { name: "Tasks", exact: true }).click();
  const toolbar = page.locator('[data-slot="tasks-panel-toolbar"]');
  await expect(toolbar.getByTestId("channel-task-view-board")).toBeVisible();
  // Visible toolbar controls share one height (Raft DS sizes buttons by use;
  // a toolbar's are the control height). Only visible ones: FitToolbar keeps
  // its ⋯ More trigger in the DOM, display:none until something overflows.
  // Their edges differ by kind on purpose: an inactive filter draws a 1px
  // seam ring, a button the 1.5px ink line that says "control", and a
  // segmented item sits in its track.
  const controls = await toolbar.locator("button:visible").evaluateAll((buttons) => buttons.map((button) => ({
    slot: button.getAttribute("data-slot"),
    height: button.getBoundingClientRect().height,
    borderWidth: parseFloat(getComputedStyle(button).borderTopWidth),
    boxShadow: getComputedStyle(button).boxShadow,
  })));
  expect(controls.length).toBeGreaterThanOrEqual(5);
  expect(new Set(controls.map((control) => control.height)).size).toBe(1);
  const filters = controls.filter((control) => control.slot === "picker-trigger-button");
  expect(filters.length).toBeGreaterThanOrEqual(2);
  for (const filter of filters) expect(filter.boxShadow).toMatch(/0px 0px 0px 1px inset/);
  const buttons = controls.filter((control) => control.slot === "button");
  expect(buttons.length).toBeGreaterThanOrEqual(1);
  for (const button of buttons) expect(button.borderWidth).toBeGreaterThan(0);
  await page.getByRole("tab", { name: "Chat", exact: true }).click();

  // 1100px: the row (1100 - 49 rail - 320 sidebar = 731; the rail is 49 with a
  // mouse since #12730) is short of the remembered 900px thread and the
  // channel's 400 by 569: both give up what they have above their content's 360
  // in proportion (#189 rule 4: 40 and 540 above it, so about 360.8 and 370.2),
  // so the channel keeps its 360 (361 rounded), the thread keeps its 360 beside
  // it and nothing clips.
  await page.setViewportSize({ width: 1100, height: 820 });

  await expect
    .poll(async () => channelComposer.evaluate((input) => input.closest("form")?.clientWidth ?? 0))
    .toBeGreaterThanOrEqual(358);

  const layout = await channelComposer.evaluate((input) => {
    const channelForm = input.closest("form");
    const threadPanel = document.querySelector<HTMLElement>('[data-testid="thread-side-column"]');
    if (!channelForm || !threadPanel) throw new Error("channel/thread layout not available");

    return {
      channelWidth: Math.round(channelForm.getBoundingClientRect().width),
      channelOverflow: channelForm.scrollWidth - channelForm.clientWidth,
      // In the planned row the thread's width is the plan's (rowLayout
      // `--row-width`, index.css `[data-row-width]`, max-width none), not a CSS
      // cap: what the row guarantees is the widths themselves.
      threadWidth: threadPanel.getBoundingClientRect().width,
      rowRoom: (threadPanel.parentElement?.getBoundingClientRect().width ?? 0) - (channelForm.closest<HTMLElement>(".thread-main-column")?.getBoundingClientRect().width ?? 0),
      threadClipped: threadPanel.hasAttribute("data-clipped"),
      storedThreadWidth: localStorage.getItem("slock:threadPanelWidth"),
    };
  });

  expect(layout).toMatchObject({
    channelWidth: 361,
    channelOverflow: 0,
    // Rule 4 gives up width above the content's 360 before anything clips (rule 2).
    threadClipped: false,
    // A narrow window changes the rendered width only, never the remembered one.
    storedThreadWidth: "900",
  });
  expect(layout.threadWidth).toBeGreaterThanOrEqual(359.5);
  // The thread stands beside the channel in what the row leaves it: nothing overflows the row.
  expect(layout.threadWidth).toBeLessThanOrEqual(layout.rowRoom + 0.5);

  // iPad mini 6 portrait: 744 CSS px (1488 physical px at DPR 2). The row is
  // wider than the 720px geometric floor, but portrait tablet content is
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
  expect(portraitTabletGeometry.rowWidth).toBeGreaterThanOrEqual(720);
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

  // A landscape desktop whose row cannot give the channel and the thread 360
  // each (900 - 57 - 320 sidebar = 523 < 720; the sidebar keeps its width
  // beside the row): the thread folds into the channel's column (#189 rule 3),
  // a layer over it at the row's whole width. The channel keeps its box under
  // it, out of reach (inert), so it is not "hidden" to the browser.
  await page.setViewportSize({ width: 900, height: 700 });

  await expect(threadPanel).toHaveCSS("position", "absolute");
  await expect(threadPanel).toHaveCSS("inset", "0px");
  await expect(threadPanel).toHaveAttribute("data-covers");
  await expect(page.getByTestId("thread-main-column")).toHaveAttribute("inert", "");
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
  expect(threadOnlyGeometry.rowWidth).toBeLessThan(720);
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
