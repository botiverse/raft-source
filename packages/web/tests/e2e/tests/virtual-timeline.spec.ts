import { expect, test } from "@playwright/test";
import type { Locator, Page, Route } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";
import type { ScenarioSeedState } from "../fixtures/seedState";
import { seedChannelHistory, test as scenarioTest } from "../fixtures/scenario";
import { dismissOwnerOnboarding } from "../fixtures/session";
import { expectTimelineRendered, loadedMessageCount } from "../fixtures/timeline";
import { clickSelectModeMoreAction, clickShareMessagesMenu } from "../fixtures/contextMenu";

// The channel and thread timelines render on raft-ui's VirtualList
// (VirtualMessageTimeline): only the rows near the view are mounted. These
// pin what the reader sees of it in a real browser: the window, paging older
// history without moving what is being read, a permalink jump that lands
// exactly, staying at the bottom as messages arrive, a long collapsed group of
// system messages being one row, "Share as image" of a selection the reader
// scrolled through, and thread search landing matches that are not mounted.

const scrollerOf = (page: Page) => page.getByTestId("message-scroller");

async function bottomGap(scroller: Locator) {
  return scroller.evaluate((el) => Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight));
}

// The first message row whose bottom is below the view's top, with its top
// relative to the view's top.
async function topVisibleRow(scroller: Locator) {
  return scroller.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    for (const row of el.querySelectorAll<HTMLElement>("[data-timeline-message-id]")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > top + 1) return { id: row.dataset.timelineMessageId!, offset: rect.top - top };
    }
    return null;
  });
}

async function rowOffset(scroller: Locator, messageId: string) {
  return scroller.evaluate((el, id) => {
    const row = el.querySelector<HTMLElement>(`[data-timeline-message-id="${CSS.escape(id)}"]`);
    return row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
  }, messageId);
}

async function postMessage(
  request: import("@playwright/test").APIRequestContext,
  seedState: ScenarioSeedState,
  accessToken: string,
  content: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Server-Id": seedState.server.id },
    data: { channelId: seedState.channel.id, content },
  });
  expect(response.ok()).toBe(true);
}

async function createChannel(
  request: import("@playwright/test").APIRequestContext,
  seedState: ScenarioSeedState,
  accessToken: string,
  name: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Server-Id": seedState.server.id },
    data: { name },
  });
  expect(response.ok()).toBe(true);
  return (await response.json() as { id: string }).id;
}

async function postTo(
  request: import("@playwright/test").APIRequestContext,
  seedState: ScenarioSeedState,
  accessToken: string,
  channelId: string,
  content: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Server-Id": seedState.server.id },
    data: { channelId, content },
  });
  expect(response.ok()).toBe(true);
  return (await response.json() as { id: string }).id;
}

// Is the row of this message mounted and wholly inside the scroller's view?
async function rowInView(scroller: Locator, messageId: string) {
  return scroller.evaluate((el, id) => {
    const row = el.querySelector<HTMLElement>(`[data-timeline-message-id="${CSS.escape(id)}"]`);
    if (!row) return false;
    const view = el.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return rect.height > 0 && rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1;
  }, messageId);
}

test.describe("virtual message timeline", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
  });

  test("a long collapsed group of system messages is one row: the messages after it show at the bottom", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    const channelId = await createChannel(request, seedState, login.accessToken, `vlist-group-${Date.now().toString(36)}`);
    await postTo(request, seedState, login.accessToken, channelId, "vlist group template");
    // The channel's history, served in one page: 40 messages, then 60 task
    // events (collapsed into one summary row), then the 3 newest messages.
    const tailIds = ["vlist-tail-1", "vlist-tail-2", "vlist-tail-3"];
    const eventIds = Array.from({ length: 60 }, (_, i) => `vlist-event-${i + 1}`);
    await page.route(`**/api/messages/channel/${channelId}?**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("before") || url.searchParams.has("after")) {
        await route.fulfill({ json: { messages: [], historyLimited: false } });
        return;
      }
      const response = await route.fetch();
      const body = await response.json();
      const template = (Array.isArray(body) ? body : body.messages)[0];
      let seq = 0;
      const at = (n: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + n * 60_000).toISOString();
      const make = (id: string, overrides: Record<string, unknown>) => {
        seq += 1;
        return { ...template, id, seq, createdAt: at(seq), reactions: [], attachments: [], ...overrides };
      };
      const messages = [
        ...Array.from({ length: 40 }, (_, i) => make(`vlist-before-${i + 1}`, { content: `before ${i + 1}` })),
        ...eventIds.map((id, i) => make(id, {
          messageType: "system",
          senderId: "system",
          content: `📌 Owner claimed #${i + 1} "Task ${i + 1}"`,
        })),
        ...tailIds.map((id, i) => make(id, { content: `tail ${i + 1}` })),
      ];
      await route.fulfill({ response, json: Array.isArray(body) ? messages : { ...body, messages, historyLimited: false } });
    });
    // Each read sent after the reader scrolls back to the bottom, with
    // whether the newest message was on screen when it was sent.
    let scrolledBack = false;
    const readsAtBottom: boolean[] = [];
    await page.route(`**/api/channels/${channelId}/read`, async (route) => {
      if (scrolledBack) readsAtBottom.push(await rowInView(scrollerOf(page), "vlist-tail-3"));
      await route.fulfill({ json: { ok: true } });
    });

    await page.goto(`/s/${seedState.server.slug}/channel/${channelId}`);
    const scroller = scrollerOf(page);
    await expect(scroller.getByTestId("system-message-group-toggle")).toHaveCount(1);
    await expect.poll(() => bottomGap(scroller)).toBeLessThan(40);
    for (const id of tailIds) {
      await expect.poll(() => rowInView(scroller, id), `${id} is mounted and on screen at the bottom`).toBe(true);
    }
    // The newest message ends where the content does: no blank under it.
    const blankBelowLast = await scroller.evaluate((el) => {
      const rows = el.querySelectorAll<HTMLElement>("[data-timeline-message-id]");
      const last = rows[rows.length - 1]!;
      return el.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
    });
    expect(blankBelowLast).toBeLessThan(80);
    // The group is one row: its hidden events have no rows of their own.
    expect(await scroller.locator(`[data-timeline-message-id="${eventIds[0]}"]`).count()).toBe(1);
    expect(await scroller.locator('[data-timeline-message-id^="vlist-event-"]').count()).toBe(1);

    // Scroll away from the bottom and back by hand: reaching the bottom
    // marks the channel read, with the newest messages on screen.
    await scroller.hover();
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(60);
    }
    await expect.poll(() => bottomGap(scroller)).toBeGreaterThan(300);
    scrolledBack = true;
    for (let i = 0; i < 20 && (await bottomGap(scroller)) > 2; i += 1) {
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(60);
    }
    await expect.poll(() => readsAtBottom.length, "reaching the bottom marks the channel read").toBeGreaterThan(0);
    expect(readsAtBottom.every(Boolean), "read only with the newest message on screen").toBe(true);
    for (const id of tailIds) expect(await rowInView(scroller, id)).toBe(true);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("Share as image captures every selected message, also those scrolled far out of view", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    const channelId = await createChannel(request, seedState, login.accessToken, `vlist-share-${Date.now().toString(36)}`);
    const tag = `vlshare${Date.now().toString(36)}`;
    const ids: string[] = [];
    // Tall messages (paragraphs), so 30 of them are far taller than the view.
    for (let i = 0; i < 45; i += 1) {
      ids.push(await postTo(request, seedState, login.accessToken, channelId, `${tag} ${i}\n\nsecond paragraph\n\nthird paragraph\n\nfourth paragraph`));
    }
    await page.goto(`/s/${seedState.server.slug}/channel/${channelId}`);
    const scroller = scrollerOf(page);
    const messageText = (i: number) => scroller.getByText(`${tag} ${i}`, { exact: true });
    await expect(messageText(44)).toBeVisible();

    // Select the newest 30, scrolling up through them.
    await clickShareMessagesMenu(page, messageText(44));
    await scroller.hover();
    for (let i = 43; i >= 15; i -= 1) {
      for (let tries = 0; tries < 20 && !(await messageText(i).isVisible()); tries += 1) {
        await page.mouse.wheel(0, -250);
        await page.waitForTimeout(60);
      }
      await messageText(i).click();
    }
    await expect(page.getByTestId("select-mode-count")).toHaveText("30 selected");
    const selected = ids.slice(15);
    // The newest selected messages are far below the view now: not mounted.
    await expect(page.locator(`[id="message-${ids[44]}"]`)).toHaveCount(0);

    await clickSelectModeMoreAction(page, "select-mode-share-open");
    const lightbox = page.getByTestId("select-share-lightbox");
    await expect(lightbox).toBeVisible({ timeout: 20_000 });
    await expect(lightbox.locator("img").first()).toHaveAttribute("src", /^data:image\/png;base64,/);
    const captured = await page.evaluate(() => window.__SLOCK_E2E__!.readLastCaptureMessageIds());
    expect([...captured].sort(), "every selected message is in the capture").toEqual([...selected].sort());
    // Back to mounting only the rows near the view.
    await expect(page.locator(`[id="message-${ids[44]}"]`)).toHaveCount(0);
  });

  test("thread search: previous / next land each far-away match centered and highlighted", async ({ page, request }) => {
    test.setTimeout(120_000);
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    const headers = { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id };
    const channelId = await createChannel(request, seedState, login.accessToken, `vlist-search-${Date.now().toString(36)}`);
    const parentId = await postTo(request, seedState, login.accessToken, channelId, "vlist search parent");
    const needle = `vlneedle${Date.now().toString(36)}`;
    // 120 replies; the needle in replies 5, 60 and 115: two of them far
    // outside the replies loaded when the thread opens at its tail, and
    // all of them far apart, so no two are mounted at once.
    const matchAt = [5, 60, 115];
    const thread = await request.post(`${seedState.urls.api}/api/channels/${channelId}/threads`, {
      headers,
      data: { parentMessageId: parentId },
    });
    expect(thread.ok()).toBe(true);
    const { threadChannelId } = await thread.json() as { threadChannelId: string };
    const replyIds: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      const content = matchAt.includes(i) ? `reply ${i} ${needle}` : `reply ${i}\n\nfiller paragraph`;
      replyIds.push(await postTo(request, seedState, login.accessToken, threadChannelId, content));
    }
    const matchIds = matchAt.map((i) => replyIds[i]!);
    expect(matchIds.every(Boolean)).toBe(true);

    await page.goto(`/s/${seedState.server.slug}/channel/${channelId}?thread=${channelId}:${parentId}`);
    const scroller = page.getByTestId("thread-message-scroller");
    await expect(scroller.getByText("reply 119", { exact: true })).toBeVisible();
    for (const id of matchIds.slice(0, 2)) {
      await expect(scroller.locator(`[data-timeline-message-id="${id}"]`), "match not mounted at open").toHaveCount(0);
    }

    // The active match's row: mounted, highlighted, its middle at the view's
    // middle (or the list clamped at an end).
    const landed = (id: string) => scroller.evaluate((el, messageId) => {
      const row = el.querySelector<HTMLElement>(`[data-timeline-message-id="${CSS.escape(messageId)}"]`);
      if (!row || !row.querySelector('[data-highlighted="true"]')) return Number.POSITIVE_INFINITY;
      const view = el.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      const atEnd = el.scrollTop <= 0 || el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      const offCenter = Math.abs((rect.top + rect.height / 2) - (view.top + view.height / 2));
      return atEnd && rect.top >= view.top && rect.bottom <= view.bottom ? 0 : offCenter;
    }, id);
    const countText = page.getByTestId("thread-search-count");
    const activeId = async () => {
      const text = (await countText.textContent()) ?? "";
      const index = Number(text.split("/")[0]) - 1;
      return matchIds[index]!;
    };

    await page.getByTestId("thread-overflow-trigger").click();
    await page.getByTestId("thread-overflow-search").click();
    await page.getByTestId("thread-search-input").fill(needle);
    await expect(countText).toHaveText(/^[123]\/3$/, { timeout: 15_000 });
    const visited: string[] = [];
    const expectLanded = async () => {
      const id = await activeId();
      await expect.poll(() => landed(id), { timeout: 10_000, message: `match ${id} lands centered and highlighted` }).toBeLessThan(2);
      visited.push(id);
    };
    await expectLanded();
    const previous = page.getByRole("button", { name: "Previous match" });
    const next = page.getByRole("button", { name: "Next match" });
    // Walk every match one way, then back, older pages loading on the way.
    for (let i = 0; i < 3; i += 1) {
      await previous.click();
      await expectLanded();
    }
    for (let i = 0; i < 3; i += 1) {
      await next.click();
      await expectLanded();
    }
    expect(new Set(visited), "every match was landed on").toEqual(new Set(matchIds));
  });

  // raft-ui 0.16.0 keeps a mounted row's element until its item, its index or
  // a render prop changes. A reaction and a thread reply arriving for rows
  // already on screen must still show on them.
  test("rows already on screen show a new reaction and a new thread reply", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    const headers = { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id };
    const channelId = await createChannel(request, seedState, login.accessToken, `vlist-live-${Date.now().toString(36)}`);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(await postTo(request, seedState, login.accessToken, channelId, `live row ${i}`));
    const [threadParentId, , reactedId] = ids as [string, string, string];

    await page.goto(`/s/${seedState.server.slug}/channel/${channelId}`);
    await expectTimelineRendered(page);
    const scroller = scrollerOf(page);
    await expect(scroller.getByText("live row 2", { exact: true })).toBeVisible();
    const rowOf = (id: string) => scroller.locator(`[data-timeline-message-id="${id}"]`);
    await expect(rowOf(reactedId).locator("[data-select-screenshot-reaction]")).toHaveCount(0);
    const replies = rowOf(threadParentId).getByRole("button", { name: /^1 reply/ });
    await expect(replies).toHaveCount(0);

    const reaction = await request.post(`${seedState.urls.api}/api/messages/${reactedId}/reactions`, {
      headers,
      data: { emoji: "👍" },
    });
    expect(reaction.ok()).toBe(true);
    await expect(rowOf(reactedId).locator("[data-select-screenshot-reaction]")).toHaveCount(1);

    const thread = await request.post(`${seedState.urls.api}/api/channels/${channelId}/threads`, {
      headers,
      data: { parentMessageId: threadParentId },
    });
    expect(thread.ok()).toBe(true);
    const { threadChannelId } = await thread.json() as { threadChannelId: string };
    await postTo(request, seedState, login.accessToken, threadChannelId, "live reply");
    await expect(replies).toBeVisible();
  });
});

// A tenant of its own per test (fixtures/scenario: its own owner, server and
// channel, with a seeded history): these read the channel's tail, count its
// loaded messages or jump into it, and specs in other workers post to the
// shared seeded channel.
scenarioTest.describe("virtual message timeline, in a channel of its own", () => {
  scenarioTest.use({ viewport: { width: 1280, height: 800 } });

  scenarioTest("the scroller is a named log for screen readers", async ({ page, scenario }) => {
    const seedState = scenario.seed;
    // Only a rendered timeline is needed: a few messages.
    await seedChannelHistory(seedState, { count: 3 });
    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expectTimelineRendered(page);
    const scroller = scrollerOf(page);
    await expect(scroller).toHaveAttribute("role", "log");
    await expect(scroller).toHaveAttribute("aria-label", "Messages");
    await expect(scroller).toHaveAttribute("tabindex", "0");
  });

  scenarioTest("opens at the bottom with only the rows near the view mounted", async ({ page, scenario }) => {
    const seedState = scenario.seed;
    await seedChannelHistory(seedState, { count: 150 });
    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expectTimelineRendered(page);
    const scroller = scrollerOf(page);

    await expect.poll(() => bottomGap(scroller)).toBeLessThan(40);
    const loaded = await loadedMessageCount(scroller);
    const mounted = await scroller.locator("[data-index]").count();
    expect(loaded, "the first page is loaded").toBeGreaterThanOrEqual(40);
    expect(mounted, "only a window of the loaded rows is mounted").toBeLessThan(loaded);
    expect(mounted).toBeGreaterThan(0);
  });

  scenarioTest("paging older history keeps the message being read in place", async ({ page, scenario }) => {
    const seedState = scenario.seed;
    await seedChannelHistory(seedState, { count: 150 });
    // Hold each older page until the anchor is measured, so the measurement
    // is taken right before the prepend lands.
    const held: Route[] = [];
    await page.route(
      (url) => url.pathname === `/api/messages/channel/${seedState.channel.id}` && url.searchParams.has("before"),
      (route) => { held.push(route); },
    );
    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expectTimelineRendered(page);
    const scroller = scrollerOf(page);
    await expect.poll(() => bottomGap(scroller)).toBeLessThan(40);
    const loadedBefore = await loadedMessageCount(scroller);

    // Scroll up by hand until the timeline asks for the previous page.
    await scroller.hover();
    for (let i = 0; i < 40 && held.length === 0; i += 1) {
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(60);
    }
    expect(held.length, "scrolling near the top requests the previous page").toBeGreaterThan(0);
    await page.waitForTimeout(300);
    const anchor = await topVisibleRow(scroller);
    expect(anchor).not.toBeNull();

    const route = held.shift()!;
    await route.continue();
    await expect.poll(() => loadedMessageCount(scroller)).toBeGreaterThan(loadedBefore);
    // Let the new rows mount and be measured.
    await page.waitForTimeout(300);
    const after = await rowOffset(scroller, anchor!.id);
    expect(after, "the anchored row is still mounted").not.toBeNull();
    expect(Math.abs(after! - anchor!.offset), "the row being read did not move").toBeLessThan(2);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  scenarioTest("a permalink lands its message exactly in the middle of the view", async ({ page, scenario }) => {
    const seedState = scenario.seed;
    const history = await seedChannelHistory(seedState, { count: 150, focusFromEnd: 50 });
    const focusId = history.focusMessageId;
    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}?msg=${focusId}`);
    const scroller = scrollerOf(page);
    const row = scroller.locator(`[data-timeline-message-id="${focusId}"]`);
    await expect(row).toBeVisible();
    // Once the context window has settled, the row's middle is the view's
    // middle (unless the list is clamped at one of its ends).
    await expect.poll(async () => scroller.evaluate((el, id) => {
      const target = el.querySelector<HTMLElement>(`[data-timeline-message-id="${CSS.escape(id)}"]`);
      if (!target) return Number.POSITIVE_INFINITY;
      const view = el.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      const atEnd = el.scrollTop <= 0 || el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      return atEnd ? 0 : Math.abs((rect.top + rect.height / 2) - (view.top + view.height / 2));
    }, focusId)).toBeLessThan(2);
  });

  scenarioTest("stays at the bottom when a message arrives, and not when reading above", async ({ page, request, scenario }) => {
    const { seed: seedState, login } = scenario;
    await seedChannelHistory(seedState, { count: 150 });
    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expectTimelineRendered(page);
    const scroller = scrollerOf(page);
    await expect.poll(() => bottomGap(scroller)).toBeLessThan(40);

    const atBottom = `[virtual-timeline] at bottom ${Date.now()}`;
    await postMessage(request, seedState, login.accessToken, atBottom);
    await expect(scroller.getByText(atBottom)).toBeInViewport();
    await expect.poll(() => bottomGap(scroller)).toBeLessThan(40);

    await scroller.hover();
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, -500);
      await page.waitForTimeout(80);
    }
    await expect.poll(() => bottomGap(scroller)).toBeGreaterThan(500);
    const anchor = await topVisibleRow(scroller);
    const loaded = await loadedMessageCount(scroller);
    await postMessage(request, seedState, login.accessToken, `[virtual-timeline] while reading ${Date.now()}`);
    await expect.poll(() => loadedMessageCount(scroller)).toBeGreaterThan(loaded);
    await page.waitForTimeout(300);
    expect(await bottomGap(scroller), "a reader above the tail is not pulled down").toBeGreaterThan(500);
    const after = await rowOffset(scroller, anchor!.id);
    expect(Math.abs(after! - anchor!.offset)).toBeLessThan(2);
  });
});
