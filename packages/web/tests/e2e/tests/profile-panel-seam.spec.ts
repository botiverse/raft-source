import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";

// #proj-frontend task #683: where the profile pane meets its neighbour there
// must be exactly one divider, and a conversation next to it must either stay
// readable or fold away. The divider belongs to the profile pane's own box, so
// nothing inside the neighbouring column (the composer bar) can cover it.

async function openWithProfile(page: Page, request: Parameters<typeof loginViaApi>[0], opts: { width: number; profileWidth?: number; sidebarWidth?: number; activity?: boolean }) {
  const seed = await waitForSeedState();
  await loginViaApi(request, seed);
  await page.addInitScript(({ profileWidth, sidebarWidth }) => {
    if (profileWidth) localStorage.setItem("slock:profilePanelWidth", String(profileWidth));
    if (sidebarWidth) localStorage.setItem("slock:sidebarWidth", String(sidebarWidth));
  }, { profileWidth: opts.profileWidth, sidebarWidth: opts.sidebarWidth });
  await page.setViewportSize({ width: opts.width, height: 900 });
  await page.goto(opts.activity
    // Activity with a picked channel: the list column (min 240) sits where the sidebar does.
    ? `/s/${seed.server.slug}/activity?open=channel:${seed.channel.id}&profile=agent:${seed.agent.id}`
    : `/s/${seed.server.slug}/channel/${seed.channel.id}?profile=agent:${seed.agent.id}`);
  await expect(page.getByTestId("profile-panel")).toBeVisible();
}

const box = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => {
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
  return { left: r.left, width: r.width, borderLeft: parseFloat(cs.borderLeftWidth), display: cs.display };
});

/** The side column the profile stands in (#189 rule 7: a section of the side layout, moved like Tasks). */
const profileColumn = (page: Page) => page.locator('[data-testid="channel-side-column"]:has([data-testid="profile-panel"])').evaluate((el) => {
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
  return { left: r.left, width: r.width, borderLeft: parseFloat(cs.borderLeftWidth), display: cs.display };
});

test("chat | profile: one divider, the profile's column's own, not covered beside the composer", async ({ page, request }) => {
  await openWithProfile(page, request, { width: 1292 });
  const column = await profileColumn(page);
  expect(column.borderLeft).toBeGreaterThan(0);
  expect((await box(page, "profile-panel")).borderLeft).toBe(0);

  // Resize handles are hit areas only (their hover line is a ::before, clear at rest).
  const handleBorders = await page.locator('[data-testid="channel-side-column"]:has([data-testid="profile-panel"])').evaluate((el) =>
    Array.from(el.querySelectorAll<HTMLElement>('[data-slot="column-resize-handle"]')).map((h) => parseFloat(getComputedStyle(h).borderLeftWidth)));
  expect(handleBorders.length).toBeGreaterThan(0);
  expect(handleBorders.every((w) => w === 0)).toBe(true);

  // Along the composer's height, the divider pixel is painted by the profile's column.
  const composer = await page.locator('[data-testid="thread-main-column"] form').last().boundingBox();
  expect(composer).not.toBeNull();
  const owner = await page.evaluate(({ x, y }) => {
    const top = document.elementFromPoint(x, y);
    return top?.closest('[data-testid="channel-side-column"]') ? "profile" : top?.closest('[data-testid="thread-main-column"]') ? "chat" : "other";
  }, { x: column.left + 0.5, y: composer!.y + composer!.height / 2 });
  expect(owner).toBe("profile");
});

test("chat | wide profile: the conversation keeps a readable width", async ({ page, request }) => {
  await openWithProfile(page, request, { width: 1100 });
  const chat = await box(page, "thread-main-column");
  expect(chat.width).toBeGreaterThanOrEqual(360);
});

test("a narrow window: the sidebar keeps its width when the profile opens; the row shares what is left (#189)", async ({ page, request }) => {
  // 1050 - 57 (rail) - 320 leaves the row 673. The sidebar is not in the row (raft-design #966): it keeps its
  // remembered 320 rather than giving way for the profile, and the conversation and the profile share the row by its
  // rules (rule 4), side by side.
  await openWithProfile(page, request, { width: 1050, sidebarWidth: 320 });
  const chat = await box(page, "thread-main-column");
  expect(chat.display).not.toBe("none");
  expect((await profileColumn(page)).left).toBeGreaterThanOrEqual(chat.left + chat.width - 1);
  await expect.poll(async () => Math.round((await box(page, "shell-sidebar-column")).width)).toBe(320);
  expect(await page.evaluate(() => localStorage.getItem("slock:sidebarWidth"))).toBe("320");
});

test("Activity in a narrow window: the list column keeps its width when the profile opens (#189)", async ({ page, request }) => {
  // The Activity list stands where the sidebar does, out of the row: 1050 - 57 (rail) leaves 993, half of it (the
  // list's cap with an item open) is over its default 380, so it renders 380 with the profile open, and the
  // conversation and the profile share the rest. Its remembered width is unchanged.
  await openWithProfile(page, request, { width: 1050, activity: true });
  const chat = await box(page, "thread-main-column");
  expect(chat.display).not.toBe("none");
  expect((await profileColumn(page)).left).toBeGreaterThanOrEqual(chat.left + chat.width - 1);
  await expect.poll(async () => Math.round((await box(page, "shell-sidebar-column")).width)).toBe(380);
  expect(await page.evaluate(() => localStorage.getItem("slock:searchPanelWidth"))).toBeNull();
});

test("thread | profile: the channel stays beside them (#189: a profile is a column like the others); each draws its own divider", async ({ page, request }) => {
  const seed = await waitForSeedState();
  await loginViaApi(request, seed);
  await page.setViewportSize({ width: 1780, height: 900 });
  await page.goto(`/s/${seed.server.slug}/channel/${seed.channel.id}?thread=${seed.channel.id}:${seed.messages.focusMessageId}&profile=agent:${seed.agent.id}`);
  await expect(page.getByTestId("profile-panel")).toBeVisible();
  expect((await box(page, "thread-main-column")).display).not.toBe("none");

  // The thread renders a loading (or resolve-error) shell without the panel
  // root until its channel resolves; wait for the real root so a missing root
  // fails here by name instead of as a null getComputedStyle.
  const threadRoot = page.getByTestId("thread-side-column").locator('[data-slot="thread-panel-root"]');
  await expect(threadRoot).toBeVisible();
  expect(await threadRoot.evaluate((el) => parseFloat(getComputedStyle(el).borderLeftWidth))).toBeGreaterThan(0);
  expect((await profileColumn(page)).borderLeft).toBeGreaterThan(0);
});
