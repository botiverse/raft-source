import { expect, test } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";
import { dismissOwnerOnboarding } from "../fixtures/session";

// #proj-frontend task #741: where two panes meet there is exactly one line.
// A pane whose left side is already bounded (by the sidebar, or by a modal
// frame) draws no edge of its own — otherwise two 1px seams touch and read as
// one 2px line (Raft DS › Patterns: two areas meet at exactly one line; the
// side drawn first owns it). Extends the task #683 rule (profile-panel-seam).

test("settings: the sidebar owns the seam; the settings panel draws no left edge beside it", async ({ page, request }) => {
  const seed = await waitForSeedState();
  await loginViaApi(request, seed);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/s/${seed.server.slug}/settings/account`);
  const sidebar = page.getByTestId("sidebar-root");
  await expect(sidebar).toBeVisible();

  // The settings panel is lazy; wait until a panel sits right of the sidebar. Probed 20px in: the sidebar's
  // resize handle covers the first 12px past its seam (DS Resizable: off the sidebar's scrollbar).
  await expect.poll(() => sidebar.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return !!document.elementFromPoint(r.right + 20, r.top + r.height / 2)?.closest('[data-slot="panel"]');
  })).toBe(true);
  const seam = await sidebar.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const sidebarRight = parseFloat(getComputedStyle(el).borderRightWidth);
    // The pane immediately to the right of the sidebar.
    const pane = document.elementFromPoint(r.right + 20, r.top + r.height / 2)?.closest('[data-slot="panel"]');
    return { sidebarRight, paneLeft: pane ? parseFloat(getComputedStyle(pane).borderLeftWidth) : null, paneX: pane?.getBoundingClientRect().left ?? null, sidebarX: r.right };
  });
  expect(seam.paneLeft, "found the settings panel next to the sidebar").not.toBeNull();
  expect(seam.paneX).toBeCloseTo(seam.sidebarX, 0);
  expect(seam.sidebarRight).toBeGreaterThan(0);
  expect(seam.paneLeft).toBe(0);
});

test("task sheet: the modal frame owns its left edge; the thread inside draws none", async ({ page, request }) => {
  const seed = await waitForSeedState();
  const login = await loginViaApi(request, seed);
  await dismissOwnerOnboarding(request, seed, login.accessToken);
  const headers = { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seed.server.id };

  const parent = await request.post(`${seed.urls.api}/api/messages`, {
    headers,
    data: { channelId: seed.channel.id, content: `seam task ${Date.now()}` },
  });
  expect(parent.ok()).toBeTruthy();
  const { id: messageId } = await parent.json() as { id: string };
  const converted = await request.post(`${seed.urls.api}/api/tasks/convert-message`, { headers, data: { messageId } });
  expect(converted.ok()).toBeTruthy();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/s/${seed.server.slug}/channel/${seed.channel.id}`);
  const card = page.locator(`#message-${messageId}`).first();
  await card.scrollIntoViewIfNeeded();
  await card.getByTestId("message-task-badge").click();

  const modal = page.getByTestId("task-thread-modal");
  await expect(modal).toBeVisible();
  const threadRoot = modal.locator('[data-slot="thread-panel-root"]');
  await expect(threadRoot).toBeVisible();
  // The raft dialog frame draws its seam as a 1px ring (box-shadow), not a
  // border; the thread inside draws neither.
  await expect(modal).toHaveAttribute("data-slot", "dialog-surface");
  expect(await modal.evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/0px 0px 0px 1px/);
  await expect(threadRoot).toHaveCSS("border-left-width", "0px");
  expect(await threadRoot.evaluate((el) => getComputedStyle(el).boxShadow)).not.toMatch(/0px 0px 0px 1px/);
});
