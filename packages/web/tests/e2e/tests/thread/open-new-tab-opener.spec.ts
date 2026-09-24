import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding, newAuthenticatedContext } from "../../fixtures/session";

async function postChannelMessage(
  request: APIRequestContext,
  seedState: Awaited<ReturnType<typeof waitForSeedState>>,
  accessToken: string,
  content: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { channelId: seedState.channel.id, content },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<{ id: string }>;
}

async function postThreadReply(
  request: APIRequestContext,
  seedState: Awaited<ReturnType<typeof waitForSeedState>>,
  accessToken: string,
  parentMessageId: string,
  content = `new-tab reply ${Date.now()}`,
) {
  const response = await request.post(
    `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { parentMessageId, content },
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function createTask(
  request: APIRequestContext,
  seedState: Awaited<ReturnType<typeof waitForSeedState>>,
  accessToken: string,
  title: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/tasks/channel/${seedState.channel.id}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { tasks: [{ title }] },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { tasks: Array<{ id: string; messageId?: string }> };
  expect(body.tasks[0]).toBeTruthy();
  return body.tasks[0]!;
}

async function clickOpenInNewTab(page: Page) {
  const overflowTrigger = page.getByTestId("thread-overflow-trigger");
  if (await overflowTrigger.count()) {
    await overflowTrigger.click();
    await page.getByTestId("thread-overflow-open-new-tab").click();
    return;
  }
  await page.getByTestId("thread-open-new-tab").click();
}

test("thread open-in-new-tab creates exactly one tab with no opener", async ({ browser, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const parent = await postChannelMessage(
    request,
    seedState,
    login.accessToken,
    `new-tab parent ${Date.now()}`,
  );
  await postThreadReply(request, seedState, login.accessToken, parent.id);

  const context = await newAuthenticatedContext(browser, {
    accessToken: login.accessToken,
    refreshToken: login.refreshToken,
    serverSlug: seedState.server.slug,
  });
  const page = await context.newPage();
  const lifecycle: Array<Record<string, unknown>> = [];
  let primaryError: unknown;
  const record = (event: string, target: Page = page) => lifecycle.push({
    event,
    target: target === page ? "opener" : "new-tab",
    pages: context.pages().length,
    openerClosed: page.isClosed(),
    targetClosed: target.isClosed(),
    url: target.isClosed() ? null : new URL(target.url()).pathname,
    at: Date.now(),
  });
  page.once("close", () => lifecycle.push({ event: "opener-close", at: Date.now() }));
  context.once("close", () => lifecycle.push({ event: "context-close-event", at: Date.now() }));
  const onBrowserDisconnected = () => lifecycle.push({ event: "browser-disconnected", at: Date.now() });
  browser.once("disconnected", onBrowserDisconnected);
  try {
    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}?msg=${parent.id}`);
    const messageCard = page.locator(`#message-${parent.id}`);
    await expect(messageCard).toBeVisible();
    await messageCard.locator('[data-message-affordance="inline-thread-replies"]').click();
    await expect(page.getByTestId("thread-message-scroller")).toBeVisible();

    const pageCountBefore = context.pages().length;
    // A target=_blank anchor creates a browser tab/page; do not use the
    // window.open-specific popup event here, or a popup implementation could
    // accidentally satisfy this regression.
    const newTabPromise = context.waitForEvent("page");
    await clickOpenInNewTab(page);
    const newTab = await newTabPromise;
    await newTab.waitForURL((url) => url.pathname.endsWith("/thread-window"));
    await expect.poll(() => context.pages().length).toBe(pageCountBefore + 1);
    await expect.poll(() => newTab.evaluate(() => !window.opener)).toBe(true);
    await expect(newTab.getByTestId("thread-window-route")).toBeVisible();
    // Closing a target=_blank tab is browser-policy dependent: Chromium may
    // permit window.close(), while a normal tab must fall back to the server
    // route. Accept either terminal outcome, but never an empty thread page.
    newTab.once("close", () => record("new-tab-close", newTab));
    record("before-close-click", newTab);
    const closed = newTab.waitForEvent("close", { timeout: 3000 }).then(() => true).catch(() => false);
    await newTab.getByTestId("thread-close").first().click();
    const didClose = await closed;
    record(didClose ? "after-close-click-closed" : "after-close-click-open", newTab);
    test.info().annotations.push({ type: "window-lifecycle", description: JSON.stringify(lifecycle) });
    if (didClose) {
      await expect.poll(() => context.pages().length).toBe(pageCountBefore);
    } else {
      await expect.poll(() => new URL(newTab.url()).pathname).toBe(`/s/${seedState.server.slug}`);
      await expect.poll(() => new URL(newTab.url()).search).toBe("");
      await expect.poll(() => new URL(newTab.url()).hash).toBe("");
      await newTab.close();
    }
  } catch (error) {
    primaryError = error;
  } finally {
    record("cleanup-start");
    // Publish before teardown so a close failure cannot erase the diagnostic.
    test.info().annotations.push({ type: "window-lifecycle-pre-teardown", description: JSON.stringify(lifecycle) });
    try {
      await context.close();
      lifecycle.push({ event: "context-close-complete", pages: context.pages().length, at: Date.now() });
    } catch (error) {
      lifecycle.push({ event: "context-close-error", error: String(error), at: Date.now() });
      test.info().annotations.push({ type: "window-lifecycle-cleanup-error", description: String(error) });
      if (primaryError === undefined) primaryError = error;
    }
    browser.off("disconnected", onBrowserDisconnected);
    test.info().annotations.push({ type: "window-lifecycle", description: JSON.stringify(lifecycle) });
    if (primaryError !== undefined) throw primaryError;
  }
});

test("task open-in-new-tab lands on the task page in exactly one tab", async ({ browser, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const task = await createTask(request, seedState, login.accessToken, `new-tab task ${Date.now()}`);

  const context = await newAuthenticatedContext(browser, {
    accessToken: login.accessToken,
    refreshToken: login.refreshToken,
    serverSlug: seedState.server.slug,
  });
  const page = await context.newPage();
  try {
    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await page.getByTestId("panel-tab-tasks").click();
    const openTask = page.getByTestId(`task-card-open-new-tab-${task.id}`);
    await expect(openTask).toBeVisible();

    const pageCountBefore = context.pages().length;
    const newTabPromise = context.waitForEvent("page");
    await openTask.click();
    const newTab = await newTabPromise;
    await newTab.waitForURL((url) => url.pathname.endsWith("/thread-window"));
    await expect.poll(() => context.pages().length).toBe(pageCountBefore + 1);
    await expect.poll(() => newTab.evaluate(() => !window.opener)).toBe(true);
    await expect(newTab.getByTestId("thread-window-route")).toBeVisible();
    await expect(newTab.getByTestId("task-page-identity")).toContainText(/Task #/i);
    const taskUrl = new URL(newTab.url());
    expect(taskUrl.searchParams.get("task")).toBe("1");
    expect(taskUrl.searchParams.get("thread")).toContain(`${seedState.channel.id}:`);
    await expect(newTab.getByTestId("task-view-in-channel")).toBeVisible();
    await expect(newTab.getByTestId("task-close")).toBeVisible();
    await newTab.getByTestId("task-view-in-channel").click();
    await expect.poll(() => new URL(newTab.url()).pathname).toBe(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect.poll(() => new URL(newTab.url()).searchParams.get("msg")).toBe(task.messageId);
    await newTab.close();
  } finally {
    await context.close();
  }
});

test("task page remains scrollable on a mobile viewport", async ({ browser, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const task = await createTask(request, seedState, login.accessToken, `mobile task page ${Date.now()}`);
  for (let index = 0; index < 12; index += 1) {
    await postThreadReply(
      request,
      seedState,
      login.accessToken,
      task.messageId,
      `mobile reply ${index}: ${"long content ".repeat(12)}`,
    );
  }

  const context = await newAuthenticatedContext(browser, {
    accessToken: login.accessToken,
    refreshToken: login.refreshToken,
    serverSlug: seedState.server.slug,
  }, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await page.getByTestId("panel-tab-tasks").click();
    const openTask = page.getByTestId(`task-card-open-new-tab-${task.id}`);
    await expect(openTask).toBeVisible();

    const newTabPromise = context.waitForEvent("page");
    await openTask.click();
    const newTab = await newTabPromise;
    await newTab.waitForURL((url) => url.pathname.endsWith("/thread-window"));
    await expect(newTab.getByTestId("thread-window-route")).toBeVisible();
    const route = newTab.getByTestId("thread-window-route");
    await expect.poll(async () => route.evaluate((element) => ({
      overflowing: element.scrollHeight > element.clientHeight,
      viewport: [window.innerWidth, window.innerHeight],
      scrollTop: element.scrollTop,
    }))).toEqual({ overflowing: false, viewport: [390, 844], scrollTop: 0 });
    const messageScroller = newTab.getByTestId("thread-message-scroller");
    await expect.poll(async () => messageScroller.evaluate((element) => ({
      overflowing: element.scrollHeight > element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
    }))).toEqual({ overflowing: true, overflowY: "auto" });
    await expect.poll(async () => route.evaluate((element) => {
      const surface = element.querySelector<HTMLElement>('[data-testid="thread-window-surface"]');
      const composer = element.querySelector<HTMLElement>('[data-testid="thread-window-composer"]');
      return {
        surfaceBorder: surface ? getComputedStyle(surface).borderWidth : null,
        surfacePadding: element.firstElementChild ? getComputedStyle(element.firstElementChild).padding : null,
        composerPosition: composer ? getComputedStyle(composer).position : null,
        composerBottom: composer ? Math.round(composer.getBoundingClientRect().bottom) : null,
      };
    })).toEqual({
      surfaceBorder: "0px",
      surfacePadding: "0px",
      composerPosition: "relative",
      composerBottom: 844,
    });
    await messageScroller.evaluate((element) => { element.scrollTop = 0; });
    const headerTopBeforeGesture = await newTab.getByTestId("task-page-identity").evaluate((element) => element.getBoundingClientRect().top);
    const scrollerBox = await messageScroller.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, startY: rect.top + rect.height * 0.7, endY: rect.top + rect.height * 0.25 };
    });
    const cdp = await context.newCDPSession(newTab);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: scrollerBox.x, y: scrollerBox.startY, radiusX: 1, radiusY: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: scrollerBox.x, y: scrollerBox.endY, radiusX: 1, radiusY: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => messageScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect.poll(() => route.evaluate((element) => element.scrollTop)).toBe(0);
    await expect.poll(() => newTab.getByTestId("task-page-identity").evaluate((element) => element.getBoundingClientRect().top)).toBeLessThan(headerTopBeforeGesture);
    await messageScroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(async () => messageScroller.evaluate((element) => {
      const composer = document.querySelector<HTMLElement>('[data-testid="thread-window-composer"]');
      const messages = element.querySelectorAll<HTMLElement>('[data-timeline-message-id]');
      const lastMessage = messages[messages.length - 1];
      if (!composer || !lastMessage) return false;
      return lastMessage.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top;
    })).toBe(true);
    await newTab.close();
  } finally {
    await context.close();
  }
});

test("DM-backed task view-in-channel returns to the DM route", async ({ browser, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const dmResponse = await request.post(`${seedState.urls.api}/api/channels/dm`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { userId: seedState.extraHuman.userId },
  });
  expect(dmResponse.ok(), await dmResponse.text()).toBeTruthy();
  const dm = await dmResponse.json() as { id: string };
  const task = await createTask(request, { ...seedState, channel: { ...seedState.channel, id: dm.id } }, login.accessToken, `DM new-tab task ${Date.now()}`);

  const context = await newAuthenticatedContext(browser, {
    accessToken: login.accessToken,
    refreshToken: login.refreshToken,
    serverSlug: seedState.server.slug,
  });
  const page = await context.newPage();
  try {
    await page.goto(`/s/${seedState.server.slug}/dm/${dm.id}`);
    await expect(page.locator("textarea")).toBeVisible();
    await page.getByTestId("panel-tab-tasks").click();
    const openTask = page.getByTestId(`task-card-open-new-tab-${task.id}`);
    await expect(openTask).toBeVisible();

    const newTabPromise = context.waitForEvent("page");
    await openTask.click();
    const newTab = await newTabPromise;
    await newTab.waitForURL((url) => url.pathname.endsWith("/thread-window"));
    await expect(newTab.getByTestId("task-view-in-channel")).toBeVisible();
    await newTab.getByTestId("task-view-in-channel").click();
    await expect.poll(() => new URL(newTab.url()).pathname).toBe(`/s/${seedState.server.slug}/dm/${dm.id}`);
    await expect.poll(() => new URL(newTab.url()).searchParams.get("msg")).toBe(task.messageId);
    await newTab.close();
  } finally {
    await context.close();
  }
});
