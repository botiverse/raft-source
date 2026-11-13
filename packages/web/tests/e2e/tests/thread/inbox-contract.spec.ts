import { expect, test } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import type { PlaywrightSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

// Activity's page size (PAGE_SIZE in store/inboxStore.ts). The lazy-load test
// seeds more rows than one page, so its first screen must stop at a page.
const ACTIVITY_PAGE_SIZE = 50;

/** Picks a list in Activity's Filter menu (task #172); the pick closes the menu. */
async function chooseInboxFilter(page: Page, choice: "all" | "unread" | "mentions" | "pinned") {
  await page.getByTestId("inbox-filter-button").click();
  await page.getByTestId(`inbox-filter-${choice}`).click();
  await expect(page.getByTestId("inbox-filter-menu")).toHaveCount(0);
}

function headers(seedState: PlaywrightSeedState, accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Server-Id": seedState.server.id,
  };
}

type InboxProjectionItem = {
  kind?: string;
  channelId?: string;
  threadChannelId?: string;
  lastMessagePreview?: string;
  latestActivityPreview?: string;
};

async function readInboxProjection(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
): Promise<InboxProjectionItem[]> {
  const items: InboxProjectionItem[] = [];
  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    const response = await request.get(`${seedState.urls.api}/api/channels/inbox`, {
      headers: headers(seedState, accessToken),
      params: { limit: ACTIVITY_PAGE_SIZE, offset: pageIndex * ACTIVITY_PAGE_SIZE },
    });
    expect(response.ok(), `Activity readiness page ${pageIndex + 1} failed: ${response.status()}`).toBeTruthy();
    const body = await response.json() as { items?: InboxProjectionItem[]; hasMore?: boolean };
    const pageItems = body.items ?? [];
    items.push(...pageItems);
    if (!body.hasMore || pageItems.length === 0) break;
  }
  return items;
}

function inboxProjectionContains(items: InboxProjectionItem[], identity: string, preview: string) {
  return items.some((item) =>
    (item.channelId === identity || item.threadChannelId === identity)
    && `${item.lastMessagePreview ?? ""}\n${item.latestActivityPreview ?? ""}`.includes(preview)
  );
}

async function registerEphemeralHuman(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  ownerAccessToken: string,
  unique: string,
): Promise<{ id: string; accessToken: string }> {
  const name = `inbox-peer-${unique}`;
  const registerResponse = await request.post(`${seedState.urls.api}/api/auth/register`, {
    data: {
      email: `${name}@example.test`,
      password: "password123",
      name,
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
      __e2eAutoVerify: true,
    },
  });
  expect(
    registerResponse.ok(),
    `ephemeral inbox peer registration failed: ${registerResponse.status()}`,
  ).toBeTruthy();
  const registered = await registerResponse.json() as {
    user: { id: string };
    accessToken: string;
  };

  const completeProfileResponse = await request.post(`${seedState.urls.api}/api/auth/me/complete-profile`, {
    headers: { Authorization: `Bearer ${registered.accessToken}` },
    data: { name, displayName: name },
  });
  expect(
    completeProfileResponse.ok(),
    `ephemeral inbox peer profile completion failed: ${completeProfileResponse.status()}`,
  ).toBeTruthy();

  // Join the way a real member does: the owner mints a single-use join link
  // and the new account accepts it.
  const joinLinkResponse = await request.post(`${seedState.urls.api}/api/servers/${seedState.server.id}/join-links`, {
    headers: headers(seedState, ownerAccessToken),
    data: { maxUses: 1 },
  });
  expect(
    joinLinkResponse.ok(),
    `ephemeral inbox peer join link failed: ${joinLinkResponse.status()}`,
  ).toBeTruthy();
  const { token: joinToken } = await joinLinkResponse.json() as { token: string };
  const acceptResponse = await request.post(`${seedState.urls.api}/api/auth/accept-invite`, {
    headers: { Authorization: `Bearer ${registered.accessToken}` },
    data: { token: joinToken },
  });
  expect(
    acceptResponse.ok(),
    `ephemeral inbox peer membership failed: ${acceptResponse.status()}`,
  ).toBeTruthy();

  return { ...registered.user, accessToken: registered.accessToken };
}

async function createChannel(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: headers(seedState, accessToken),
    data: { name },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ id: string; name: string }>;
}

async function createMessage(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
  content: string,
): Promise<{ id: string }> {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: headers(seedState, accessToken),
    data: { channelId, content },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ id: string }>;
}

async function addChannelHuman(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
  userId: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels/${channelId}/members`, {
    headers: headers(seedState, accessToken),
    data: { userId },
  });
  expect(response.ok()).toBeTruthy();
}

async function loadNextInboxPage(page: Page) {
  const rows = page.getByTestId("inbox-row");
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  await page.getByTestId("inbox-scroll").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(async () => page.getByTestId("inbox-row").count()).toBeGreaterThan(before);
}

async function loadInboxUntilVisible(page: Page, row: Locator, maxAdditionalPages = 4) {
  const rows = page.getByTestId("inbox-row");
  for (let pageIndex = 0; pageIndex <= maxAdditionalPages; pageIndex += 1) {
    if (await row.count() > 0) {
      await expect(row).toBeVisible();
      return;
    }
    if (pageIndex === maxAdditionalPages) break;

    const before = await rows.count();
    await page.getByTestId("inbox-scroll").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect.poll(async () => rows.count(), { timeout: 2_000 }).toBeGreaterThan(before).catch(() => {});
  }
  await expect(row).toBeVisible();
}

// A row out of view skips rendering (content-visibility: auto). Scrolled into
// view, its content is drawn on the next frame; a click in the same frame hits
// the bare row instead of its open button. Let a frame pass before clicking.
async function scrollInboxRowIntoView(row: Locator) {
  await row.scrollIntoViewIfNeeded();
  await row.page().evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function clickInboxRow(row: Locator) {
  await scrollInboxRowIntoView(row);
  await row.click();
}

async function dblclickInboxRow(row: Locator) {
  await scrollInboxRowIntoView(row);
  await row.dblclick();
}

async function gotoInbox(page: Page, seedState: PlaywrightSeedState) {
  await page.goto(`/s/${seedState.server.slug}/inbox`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByTestId("inbox-filter-button")).toBeVisible();
}

test.describe("Inbox contract", () => {
  // @nightly: seeding 60 followed threads (~180 sequential API calls) plus the
  // 8s Undo toast doesn't fit a per-merge 60s budget (staging run 42056932401
  // timed out on both tries while seeding). Remove the tag once the seed is a
  // single bulk call. See playwright.config.ts for the tier.
  test("shows active chats, keeps unread as a filter, and lazy-loads by scroll @nightly", async ({ page, request }) => {
    // Seeding more than a page of followed threads takes ~3 requests each.
    // Nightly budget until the seed becomes one bulk call (Tenny's request).
    test.setTimeout(180_000);
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    const runId = Date.now().toString(36);

    const emptyChannel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `inbox-empty-${runId}`,
    );

    const systemOnlyChannel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `inbox-system-${runId}`,
    );
    const archive = await request.post(`${seedState.urls.api}/api/channels/${systemOnlyChannel.id}/archive`, {
      headers: headers(seedState, ownerLogin.accessToken),
    });
    expect(archive.ok()).toBeTruthy();
    const unarchive = await request.post(`${seedState.urls.api}/api/channels/${systemOnlyChannel.id}/unarchive`, {
      headers: headers(seedState, ownerLogin.accessToken),
    });
    expect(unarchive.ok()).toBeTruthy();

    await expect.poll(async () => {
      const response = await request.get(`${seedState.urls.api}/api/channels/inbox`, {
        headers: headers(seedState, ownerLogin.accessToken),
      });
      const body = await response.json() as { items: Array<{ channelId?: string; lastMessagePreview?: string }> };
      return body.items.some((item) =>
        item.channelId === systemOnlyChannel.id
        && (item.lastMessagePreview ?? "").includes("unarchived this channel")
      );
    }).toBeTruthy();

    const activeChannel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `inbox-active-${runId}`,
    );
    const peer = await registerEphemeralHuman(
      request,
      seedState,
      ownerLogin.accessToken,
      runId,
    );
    await addChannelHuman(
      request,
      seedState,
      ownerLogin.accessToken,
      activeChannel.id,
      peer.id,
    );
    const activeFirstUnreadMessage = `inbox active first unread ${runId}`;
    await createMessage(request, seedState, ownerLogin.accessToken, activeChannel.id, activeFirstUnreadMessage);
    const activeLatestMessage = `inbox active latest message ${runId}`;
    const activeLatestMessageRecord = await createMessage(request, seedState, ownerLogin.accessToken, activeChannel.id, activeLatestMessage);

    const dmResponse = await request.post(`${seedState.urls.api}/api/channels/dm`, {
      headers: headers(seedState, ownerLogin.accessToken),
      data: { userId: peer.id },
    });
    expect(dmResponse.ok()).toBeTruthy();
    const dm = await dmResponse.json() as { id: string };
    const dmMessage = `inbox dm message ${runId}`;
    const dmMessageRecord = await createMessage(request, seedState, ownerLogin.accessToken, dm.id, dmMessage);

    const threadChannel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `inbox-threads-${runId}`,
    );
    await addChannelHuman(request, seedState, ownerLogin.accessToken, threadChannel.id, peer.id);

    const participatedParent = `inbox participated thread parent ${runId}`;
    const participatedReply = `inbox participated thread reply ${runId}`;
    const participatedParentMessage = await createMessage(
      request,
      seedState,
      ownerLogin.accessToken,
      threadChannel.id,
      participatedParent,
    );
    const followResponse = await request.post(`${seedState.urls.api}/api/channels/threads/follow`, {
      headers: headers(seedState, ownerLogin.accessToken),
      data: { parentMessageId: participatedParentMessage.id },
    });
    expect(followResponse.ok()).toBeTruthy();
    const participatedReplyResponse = await request.post(`${seedState.urls.api}/api/channels/${threadChannel.id}/threads`, {
      headers: headers(seedState, ownerLogin.accessToken),
      data: { parentMessageId: participatedParentMessage.id, content: participatedReply },
    });
    expect(participatedReplyResponse.ok()).toBeTruthy();
    const participatedThread = await participatedReplyResponse.json() as { threadChannelId: string };

    const nonParticipantParent = `inbox non participant thread parent ${runId}`;
    const nonParticipantParentMessage = await createMessage(
      request,
      seedState,
      peer.accessToken,
      threadChannel.id,
      nonParticipantParent,
    );
    const hiddenReplyResponse = await request.post(`${seedState.urls.api}/api/channels/${threadChannel.id}/threads`, {
      headers: headers(seedState, peer.accessToken),
      data: { parentMessageId: nonParticipantParentMessage.id, content: `hidden reply ${runId}` },
    });
    expect(hiddenReplyResponse.ok()).toBeTruthy();
    await createMessage(
      request,
      seedState,
      ownerLogin.accessToken,
      threadChannel.id,
      `inbox cover parent channel latest ${runId}`,
    );

    let lastLazyReply = "";
    // The lazy threads alone fill more than one page, whatever else the shared
    // seed server's inbox already holds.
    for (let idx = 0; idx < ACTIVITY_PAGE_SIZE + 10; idx += 1) {
      const parent = await createMessage(
        request,
        seedState,
        ownerLogin.accessToken,
        threadChannel.id,
        `inbox lazy thread parent ${runId} ${idx.toString().padStart(2, "0")}`,
      );
      const lazyFollow = await request.post(`${seedState.urls.api}/api/channels/threads/follow`, {
        headers: headers(seedState, ownerLogin.accessToken),
        data: { parentMessageId: parent.id },
      });
      expect(lazyFollow.ok()).toBeTruthy();
      lastLazyReply = `inbox lazy thread reply ${runId} ${idx.toString().padStart(2, "0")}`;
      const lazyReply = await request.post(`${seedState.urls.api}/api/channels/${threadChannel.id}/threads`, {
        headers: headers(seedState, ownerLogin.accessToken),
        data: {
          parentMessageId: parent.id,
          content: lastLazyReply,
        },
      });
      expect(lazyReply.ok()).toBeTruthy();
    }

    // The browser must start only after the same paginated API projection the
    // UI consumes contains every final fixture fact. This separates backend
    // readiness from the store/socket race below instead of letting an empty
    // first render ambiguously represent either one.
    await expect.poll(async () => {
      const items = await readInboxProjection(request, seedState, ownerLogin.accessToken);
      return {
        active: inboxProjectionContains(items, activeChannel.id, activeLatestMessage),
        dm: inboxProjectionContains(items, dm.id, dmMessage),
        participated: inboxProjectionContains(items, participatedThread.threadChannelId, participatedReply),
        system: inboxProjectionContains(items, systemOnlyChannel.id, "unarchived this channel"),
        lazyTail: items.some((item) => `${item.latestActivityPreview ?? ""}`.includes(lastLazyReply)),
      };
    }).toEqual({ active: true, dm: true, participated: true, system: true, lazyTail: true });

    await gotoInbox(page, seedState);
    await expect(page.getByTestId("inbox-filter-button")).toBeVisible();
    await expect(page.getByRole("button", { name: /Load More/i })).toHaveCount(0);

    const rows = page.getByTestId("inbox-row");
    await expect(rows).toHaveCount(ACTIVITY_PAGE_SIZE);
    await loadNextInboxPage(page);
    // The lazy threads are newer than the active channel, and other specs on
    // the shared seed server add rows too: page down until it is listed.
    await loadInboxUntilVisible(page, rows.filter({ hasText: activeLatestMessage }));
    const loadedRowCount = await page.getByTestId("inbox-row").count();
    const savedScrollTop = await page.getByTestId("inbox-scroll").evaluate((node) => node.scrollTop);
    expect(savedScrollTop).toBeGreaterThan(0);

    // Desktop Activity uses single-click for its col-3 preview. Double-click is
    // the intentional full-chat gesture, which is the route/back-stack contract
    // exercised by this section.
    await dblclickInboxRow(rows.filter({ hasText: activeLatestMessage }));
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/channel/${activeChannel.id}\\?msg=${activeLatestMessageRecord.id}$`));
    await expect(page.getByTestId("message-scroller")).toBeVisible();

    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/activity$`));
    await expect.poll(async () => page.getByTestId("inbox-row").count()).toBeGreaterThanOrEqual(loadedRowCount);
    await expect.poll(async () => page.getByTestId("inbox-scroll").evaluate((node) => node.scrollTop)).toBeGreaterThan(0);

    await expect(rows.filter({ hasText: emptyChannel.name })).toHaveCount(0);
    const systemOnlyRow = rows.filter({ hasText: systemOnlyChannel.name });
    await loadInboxUntilVisible(page, systemOnlyRow);
    await expect(systemOnlyRow).toContainText("unarchived this channel");
    await loadInboxUntilVisible(page, rows.filter({ hasText: activeLatestMessage }));
    await loadInboxUntilVisible(page, rows.filter({ hasText: dmMessage }));
    const participatedRow = rows.filter({ hasText: participatedReply });
    await loadInboxUntilVisible(page, participatedRow);
    await expect(participatedRow).toContainText(participatedParent);
    await expect(rows.filter({ hasText: nonParticipantParent })).toHaveCount(0);

    await gotoInbox(page, seedState);
    const dmRow = page.getByTestId("inbox-row").filter({ hasText: dmMessage });
    await loadInboxUntilVisible(page, dmRow);
    await dblclickInboxRow(dmRow);
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/dm/${dm.id}\\?msg=${dmMessageRecord.id}$`));
    await expect(page.getByTestId("message-scroller")).toBeVisible();

    await gotoInbox(page, seedState);
    await loadInboxUntilVisible(page, page.getByTestId("inbox-row").filter({ hasText: participatedReply }));
    await loadInboxUntilVisible(page, page.getByTestId("inbox-row").filter({ hasText: activeLatestMessage }));

    const activeRow = rows.filter({ hasText: activeLatestMessage });
    // The done affordance is a RUI icon Button with an aria-label (the Tooltip
    // carries the text; there is no title attribute anymore). It is hover-gated
    // (pointer-events-none until group-hover) and overlapped by the row
    // timestamp, which stays hit-testable while fading out — Playwright's
    // hit-target check does not hover first, so hover the row explicitly to
    // make the button the topmost hit target before clicking.
    await activeRow.hover();
    // Done waits out its 8-second Undo toast before it is written (Raft DS ›
    // Feedback, "Confirming"): wait for the write, so the new message below
    // reopens a row that is Done on the server.
    const doneWritten = page.waitForResponse(
      (response) => response.url().includes("/channels/inbox/done") && response.request().method() === "POST",
      { timeout: 20_000 },
    );
    await activeRow.getByTestId("inbox-row-done").click();
    await expect(rows.filter({ hasText: activeLatestMessage })).toHaveCount(0);
    await doneWritten;
    const reopenedMessage = `inbox active reopened ${runId}`;
    await createMessage(request, seedState, peer.accessToken, activeChannel.id, reopenedMessage);
    const reopenedRow = page.getByTestId("inbox-row").filter({ hasText: reopenedMessage });
    await expect(reopenedRow).toBeVisible();
    await expect(reopenedRow.getByTestId("conversation-card-new-badge")).toHaveText("1");

    await chooseInboxFilter(page, "unread");
    await expect(reopenedRow).toBeVisible();

    await chooseInboxFilter(page, "all");
  });

  test("opens a participated thread in the Activity detail slot", async ({ page, request }, testInfo) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    const runId = `${Date.now().toString(36)}-route-${testInfo.workerIndex}`;
    const channel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `inbox-route-${runId}`,
    );
    const parentText = `inbox route parent ${runId}`;
    const replyText = `inbox route reply ${runId}`;
    const parentMessage = await createMessage(
      request,
      seedState,
      ownerLogin.accessToken,
      channel.id,
      parentText,
    );
    const followResponse = await request.post(`${seedState.urls.api}/api/channels/threads/follow`, {
      headers: headers(seedState, ownerLogin.accessToken),
      data: { parentMessageId: parentMessage.id },
    });
    expect(followResponse.ok()).toBeTruthy();
    const replyResponse = await request.post(`${seedState.urls.api}/api/channels/${channel.id}/threads`, {
      headers: headers(seedState, ownerLogin.accessToken),
      data: { parentMessageId: parentMessage.id, content: replyText },
    });
    expect(replyResponse.ok()).toBeTruthy();
    const thread = await replyResponse.json() as { threadChannelId: string };
    await expect.poll(async () => {
      const items = await readInboxProjection(request, seedState, ownerLogin.accessToken);
      return inboxProjectionContains(items, thread.threadChannelId, replyText);
    }).toBeTruthy();

    const expectedRoute = {
      pathname: `/s/${seedState.server.slug}/activity`,
      open: `thread:${thread.threadChannelId}`,
      thread: `${channel.id}:${parentMessage.id}`,
    };
    const startedAt = performance.now();
    const routeEvidence: {
      events: Array<{
        stage: string;
        elapsedMs: number;
        pathname: string;
        open: string | null;
        thread: string | null;
        threadPanelPresent: boolean;
      }>;
      lastObservation: null | {
        elapsedMs: number;
        pathname: string;
        open: string | null;
        thread: string | null;
        threadPanelPresent: boolean;
      };
      captureError?: string;
    } = { events: [], lastObservation: null };
    let sawThreadPanel = false;
    let sawExactRoute = false;
    const observeRoute = async (stage?: string) => {
      const current = new URL(page.url());
      const observation = {
        elapsedMs: Math.round(performance.now() - startedAt),
        pathname: current.pathname,
        open: current.searchParams.get("open"),
        thread: current.searchParams.get("thread"),
        threadPanelPresent: await page.getByTestId("thread-message-scroller").count() > 0,
      };
      routeEvidence.lastObservation = observation;
      if (stage) routeEvidence.events.push({ stage, ...observation });
      if (observation.threadPanelPresent && !sawThreadPanel) {
        sawThreadPanel = true;
        routeEvidence.events.push({ stage: "thread-panel-present", ...observation });
      }
      const hasExpectedUrl = observation.pathname === expectedRoute.pathname
        && observation.open === expectedRoute.open
        && observation.thread === expectedRoute.thread;
      if (hasExpectedUrl && !sawExactRoute) {
        sawExactRoute = true;
        routeEvidence.events.push({ stage: "exact-route-visible", ...observation });
      }
      return {
        pathname: observation.pathname,
        open: observation.open,
        thread: observation.thread,
      };
    };

    try {
      await page.goto(`/s/${seedState.server.slug}/inbox`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
      await expect(page.getByTestId("inbox-filter-button")).toBeVisible();
      const row = page.getByTestId("inbox-row").filter({ hasText: replyText });
      await loadInboxUntilVisible(page, row);
      await expect(row).toContainText(parentText);
      await observeRoute("before-click");
      await row.click();
      await observeRoute("click-completed");
      await expect.poll(() => observeRoute()).toEqual(expectedRoute);
      await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
      await expect(page.getByTestId("thread-message-scroller")).toBeVisible();
      await observeRoute("visible-thread-asserted");
    } finally {
      try {
        await observeRoute("final");
      } catch (error) {
        routeEvidence.captureError = error instanceof Error ? error.message : "route observation failed";
      }
      await testInfo.attach("participated-thread-route-stages.json", {
        body: Buffer.from(JSON.stringify(routeEvidence, null, 2)),
        contentType: "application/json",
      });
    }
  });

  test("keeps the Activity channel detail composer and scroll owner with a side thread open", async ({ page, request }, testInfo) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    await page.setViewportSize({ width: 1950, height: 1100 });
    await page.addInitScript(() => {
      window.localStorage.setItem("slock:searchPanelWidth", "480");
      window.localStorage.setItem("slock:threadPanelWidth", "900");
    });

    const runId = `${Date.now().toString(36).slice(-6)}-ct-${testInfo.workerIndex}`;
    const channel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `act-${runId}`,
    );
    for (let i = 0; i < 24; i += 1) {
      await createMessage(
        request,
        seedState,
        ownerLogin.accessToken,
        channel.id,
        `inbox channel thread older ${runId} ${i.toString().padStart(2, "0")}`,
      );
    }
    const parentText = `inbox channel thread parent ${runId}`;
    const parentMessage = await createMessage(
      request,
      seedState,
      ownerLogin.accessToken,
      channel.id,
      parentText,
    );
    const followResponse = await request.post(`${seedState.urls.api}/api/channels/threads/follow`, {
      headers: headers(seedState, ownerLogin.accessToken),
      data: { parentMessageId: parentMessage.id },
    });
    expect(followResponse.ok()).toBeTruthy();
    const replyResponse = await request.post(`${seedState.urls.api}/api/channels/${channel.id}/threads`, {
      headers: headers(seedState, ownerLogin.accessToken),
      data: { parentMessageId: parentMessage.id, content: `inbox channel thread reply ${runId}` },
    });
    expect(replyResponse.ok()).toBeTruthy();
    for (let i = 0; i < 24; i += 1) {
      await createMessage(
        request,
        seedState,
        ownerLogin.accessToken,
        channel.id,
        `inbox channel thread newer ${runId} ${i.toString().padStart(2, "0")}`,
      );
    }

    const thread = await replyResponse.json() as { threadChannelId: string };
    const params = new URLSearchParams({
      open: `channel:${channel.id}`,
      msg: parentMessage.id,
      thread: `${channel.id}:${parentMessage.id}`,
    });
    await page.goto(`/s/${seedState.server.slug}/activity?${params.toString()}`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
    await expect(page.getByTestId("message-scroller").getByText(parentText)).toBeVisible();
    await expect(page.getByTestId("thread-message-scroller")).toBeVisible();
    await expect(page.getByPlaceholder("Message thread")).toBeVisible();

    const channelComposer = page.getByPlaceholder(`Message #${channel.name}`);
    await expect(channelComposer).toBeVisible();
    await channelComposer.fill(`middle pane composer still works ${runId}`);
    await expect(channelComposer).toHaveValue(`middle pane composer still works ${runId}`);

    const channelScroller = page.getByTestId("message-scroller");
    await expect(channelScroller).toBeVisible();
    const before = await channelScroller.evaluate((node) => ({
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }));
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
    await channelScroller.hover();
    await page.mouse.wheel(0, 600);
    await expect.poll(async () => channelScroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(before.scrollTop);
    expect(new URL(page.url()).searchParams.get("thread")).toBe(`${channel.id}:${parentMessage.id}`);
    expect(thread.threadChannelId).toBeTruthy();
  });

  test("opens a chat at the earliest unread message while previewing the latest message", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    const runId = Date.now().toString(36);
    const peer = await registerEphemeralHuman(
      request,
      seedState,
      ownerLogin.accessToken,
      `${runId}-preview`,
    );
    const channel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `inbox-unread-preview-${runId}`,
    );
    await addChannelHuman(request, seedState, ownerLogin.accessToken, channel.id, peer.id);

    const readAll = await request.post(`${seedState.urls.api}/api/channels/${channel.id}/read-all`, {
      headers: headers(seedState, ownerLogin.accessToken),
    });
    expect(readAll.ok()).toBeTruthy();

    const firstUnreadText = `inbox first unread target ${runId}`;
    const firstUnread = await createMessage(request, seedState, peer.accessToken, channel.id, firstUnreadText);
    const latestText = `inbox latest preview ${runId}`;
    await createMessage(request, seedState, peer.accessToken, channel.id, latestText);

    await gotoInbox(page, seedState);
    const row = page.getByTestId("inbox-row").filter({ hasText: latestText });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText(firstUnreadText);

    await row.dblclick();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/channel/${channel.id}\\?msg=${firstUnread.id}$`));
    await expect(page.getByTestId("message-scroller")).toBeVisible();

    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/activity$`));
    const reopenedRow = page.getByTestId("inbox-row").filter({ hasText: latestText });
    await expect(reopenedRow).toBeVisible();
    await expect(reopenedRow).not.toContainText("new");

    await expect.poll(async () => {
      const response = await request.get(`${seedState.urls.api}/api/channels/inbox`, {
        headers: headers(seedState, ownerLogin.accessToken),
      });
      const body = await response.json() as { items: Array<{ channelId?: string; unreadCount?: number }> };
      return body.items.find((item) => item.channelId === channel.id)?.unreadCount ?? -1;
    }).toBe(0);
  });

  test("reopens the conversation opened last time, unread until acted in; a first visit opens nothing", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    await page.setViewportSize({ width: 1440, height: 900 });
    const runId = Date.now().toString(36);
    const peer = await registerEphemeralHuman(request, seedState, ownerLogin.accessToken, `${runId}-reopen`);
    const channel = await createChannel(request, seedState, ownerLogin.accessToken, `inbox-reopen-${runId}`);
    await addChannelHuman(request, seedState, ownerLogin.accessToken, channel.id, peer.id);
    const readAll = await request.post(`${seedState.urls.api}/api/channels/${channel.id}/read-all`, {
      headers: headers(seedState, ownerLogin.accessToken),
    });
    expect(readAll.ok()).toBeTruthy();
    const unread = async () => {
      const response = await request.get(`${seedState.urls.api}/api/channels/inbox`, {
        headers: headers(seedState, ownerLogin.accessToken),
      });
      const body = await response.json() as { items: Array<{ channelId?: string; unreadCount?: number }> };
      return body.items.find((item) => item.channelId === channel.id)?.unreadCount ?? -1;
    };

    const firstText = `inbox reopen first ${runId}`;
    await createMessage(request, seedState, peer.accessToken, channel.id, firstText);
    await expect.poll(unread).toBe(1);

    // A first visit leaves the right side empty: no conversation opens on its own.
    await gotoInbox(page, seedState);
    const row = page.getByTestId("inbox-row").filter({ hasText: firstText });
    await expect(row).toBeVisible();
    await expect(page.locator("[data-activity-detail]")).toHaveCount(0);
    expect(await unread()).toBe(1);

    // Picking the row opens it beside the list and reads it.
    await row.getByTestId("inbox-row-open").click();
    await expect(page.getByTestId("message-scroller").getByText(firstText)).toBeVisible();
    await expect.poll(unread).toBe(0);

    // Away from Activity, a new message arrives in it.
    await page.goto("about:blank");
    const newText = `inbox reopen new ${runId}`;
    await createMessage(request, seedState, peer.accessToken, channel.id, newText);
    await expect.poll(unread).toBe(1);

    // Back in Activity it is reopened, showing the new message, and still unread.
    await gotoInbox(page, seedState);
    await expect(page.locator("[data-activity-detail]").getByText(newText)).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await unread()).toBe(1);
    await expect(page.getByTestId("inbox-row").filter({ hasText: newText })).toBeVisible();

    // Acting in it reads it.
    await page.locator("[data-activity-detail]").getByText(newText).click();
    await expect.poll(unread).toBe(0);
  });

  test("clears an Activity new tag after the same channel is read from chat", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    const runId = Date.now().toString(36);
    const peer = await registerEphemeralHuman(
      request,
      seedState,
      ownerLogin.accessToken,
      `${runId}-channel-read`,
    );
    const channel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `inbox-read-sync-${runId}`,
    );
    await addChannelHuman(request, seedState, ownerLogin.accessToken, channel.id, peer.id);

    // Adding a member persists its own channel system message. Isolate that
    // setup activity so the assertion below measures only the target message.
    const readAll = await request.post(`${seedState.urls.api}/api/channels/${channel.id}/read-all`, {
      headers: headers(seedState, ownerLogin.accessToken),
    });
    expect(readAll.ok()).toBeTruthy();
    await expect.poll(async () => {
      const response = await request.get(`${seedState.urls.api}/api/channels/inbox`, {
        headers: headers(seedState, ownerLogin.accessToken),
      });
      const body = await response.json() as { items: Array<{ channelId?: string; unreadCount?: number }> };
      return body.items.find((item) => item.channelId === channel.id)?.unreadCount ?? -1;
    }).toBe(0);

    const messageText = `inbox read sync target ${runId}`;
    const targetMessage = await createMessage(request, seedState, peer.accessToken, channel.id, messageText);
    await expect.poll(async () => {
      const response = await request.get(`${seedState.urls.api}/api/channels/inbox`, {
        headers: headers(seedState, ownerLogin.accessToken),
      });
      const body = await response.json() as {
        items: Array<{ channelId?: string; firstUnreadMessageId?: string | null; unreadCount?: number }>;
      };
      const item = body.items.find((candidate) => candidate.channelId === channel.id);
      return { firstUnreadMessageId: item?.firstUnreadMessageId ?? null, unreadCount: item?.unreadCount ?? -1 };
    }).toEqual({ firstUnreadMessageId: targetMessage.id, unreadCount: 1 });

    await gotoInbox(page, seedState);
    const cachedActivityRow = page.getByTestId("inbox-row").filter({ hasText: messageText });
    await expect(cachedActivityRow).toBeVisible();
    await expect(cachedActivityRow.getByTestId("conversation-card-new-badge")).toHaveText("1");

    // Activity now owns the full list pane, so its old hidden Sidebar copy is
    // not an actionable way into chat. Switch to Chat, then target the stable
    // channel-row id (rather than a text match that can resolve hidden copies).
    await page.getByTestId("left-rail-tab-chat").click();
    const sidebarChannel = page.locator(`[data-sidebar-channel-id="${channel.id}"]`);
    await expect(sidebarChannel).toBeVisible();
    await sidebarChannel.click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/channel/${channel.id}`));
    await expect(page.getByText(messageText)).toBeVisible();
    await expect.poll(async () => {
      const response = await request.get(`${seedState.urls.api}/api/channels/inbox`, {
        headers: headers(seedState, ownerLogin.accessToken),
      });
      const body = await response.json() as { items: Array<{ channelId?: string; unreadCount?: number }> };
      return body.items.find((item) => item.channelId === channel.id)?.unreadCount ?? -1;
    }).toBe(0);

    await page.getByRole("button", { name: /^Activity/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/activity$`));
    const readActivityRow = page.getByTestId("inbox-row").filter({ hasText: messageText });
    await expect(readActivityRow).toBeVisible();
    await expect(readActivityRow).not.toContainText("new");
  });

  test("Mark as Unread from a row's menu: the menu closes at once, and the row stays unread through its own sync change and a reload", async ({ page, request }) => {
    // xxchan, #triage:#101: the menu stayed open after the click, and the row
    // went back to read.
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    const runId = Date.now().toString(36);
    const peer = await registerEphemeralHuman(request, seedState, ownerLogin.accessToken, `${runId}-mark-unread`);
    const channel = await createChannel(request, seedState, ownerLogin.accessToken, `inbox-mark-unread-${runId}`);
    await addChannelHuman(request, seedState, ownerLogin.accessToken, channel.id, peer.id);
    const messageText = `inbox mark unread target ${runId}`;
    await createMessage(request, seedState, peer.accessToken, channel.id, messageText);
    const readAll = await request.post(`${seedState.urls.api}/api/channels/${channel.id}/read-all`, {
      headers: headers(seedState, ownerLogin.accessToken),
    });
    expect(readAll.ok()).toBeTruthy();
    const unreadOnServer = async () => {
      const response = await request.get(`${seedState.urls.api}/api/channels/inbox`, {
        headers: headers(seedState, ownerLogin.accessToken),
      });
      const body = await response.json() as { items: Array<{ channelId?: string; unreadCount?: number }> };
      return body.items.find((item) => item.channelId === channel.id)?.unreadCount ?? -1;
    };
    await expect.poll(unreadOnServer).toBe(0);

    await gotoInbox(page, seedState);
    const activityRow = page.getByTestId("inbox-row").filter({ hasText: messageText });
    await expect(activityRow).toBeVisible();
    await expect(activityRow.getByTestId("conversation-card-new-badge")).toHaveCount(0);

    await activityRow.click({ button: "right" });
    const menu = page.getByTestId("activity-context-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Mark as unread" }).click();
    // At once, not after the save: well under a server round trip and reload.
    await expect(menu).toHaveCount(0, { timeout: 500 });
    await expect(activityRow.getByTestId("conversation-card-new-badge")).toHaveText("1", { timeout: 500 });

    await expect.poll(unreadOnServer).toBe(1);
    // Still unread once the server's own sync change for it has come back and
    // after a reload (#triage:#101's second half).
    await page.waitForTimeout(3_000);
    await expect(activityRow.getByTestId("conversation-card-new-badge")).toHaveText("1");
    await page.reload();
    const reloadedRow = page.getByTestId("inbox-row").filter({ hasText: messageText });
    await expect(reloadedRow.getByTestId("conversation-card-new-badge")).toHaveText("1");
  });

  test("Mark as Unread on a thread of only my replies under a peer's message: the row shows the unread dot, keeps it through a reload, and opening it clears it", async ({ page, request }) => {
    // Scout's T3 (#triage:#101): nothing in the thread counts as unread for
    // its owner (the peer's message is the parent, stored in the channel), so
    // the server marks it unread instead of moving the read point: a dot, no
    // number, and no "nothing to mark" notice.
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    const runId = Date.now().toString(36);
    const peer = await registerEphemeralHuman(request, seedState, ownerLogin.accessToken, `${runId}-t3`);
    const channel = await createChannel(request, seedState, ownerLogin.accessToken, `inbox-t3-${runId}`);
    await addChannelHuman(request, seedState, ownerLogin.accessToken, channel.id, peer.id);
    const parent = await createMessage(request, seedState, peer.accessToken, channel.id, `t3 question from the peer ${runId}`);
    const replyText = `t3 my own answer ${runId}`;
    const threadResponse = await request.post(`${seedState.urls.api}/api/channels/${channel.id}/threads`, {
      headers: headers(seedState, ownerLogin.accessToken),
      data: { parentMessageId: parent.id, content: replyText },
    });
    expect(threadResponse.ok()).toBeTruthy();
    const { threadChannelId } = await threadResponse.json() as { threadChannelId: string };
    for (const scopeId of [channel.id, threadChannelId]) {
      const readAll = await request.post(`${seedState.urls.api}/api/channels/${scopeId}/read-all`, {
        headers: headers(seedState, ownerLogin.accessToken),
      });
      expect(readAll.ok()).toBeTruthy();
    }
    const threadOnServer = async () => {
      const response = await request.get(`${seedState.urls.api}/api/channels/inbox`, {
        headers: headers(seedState, ownerLogin.accessToken),
        params: { ids: threadChannelId },
      });
      const body = await response.json() as {
        items: Array<{ threadChannelId?: string; unreadCount?: number; readState?: { kind: string; markedUnread?: boolean } }>;
      };
      const item = body.items.find((candidate) => candidate.threadChannelId === threadChannelId);
      return item ? { unreadCount: item.unreadCount, markedUnread: item.readState?.markedUnread === true } : null;
    };
    await expect.poll(threadOnServer).toEqual({ unreadCount: 0, markedUnread: false });

    await gotoInbox(page, seedState);
    const threadRow = page.getByTestId("inbox-row").filter({ hasText: replyText });
    await loadInboxUntilVisible(page, threadRow);
    await expect(threadRow.getByTestId("conversation-card-marked-unread")).toHaveCount(0);

    await threadRow.click({ button: "right" });
    const menu = page.getByTestId("activity-context-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Mark as unread" }).click();
    await expect(menu).toHaveCount(0, { timeout: 500 });
    await expect(threadRow.getByTestId("conversation-card-marked-unread")).toBeVisible();
    await expect(threadRow.getByTestId("conversation-card-new-badge")).toHaveCount(0);
    await expect(page.getByText("Nothing new from others here to mark unread.")).toHaveCount(0);
    await expect.poll(threadOnServer).toEqual({ unreadCount: 0, markedUnread: true });

    // Through the mark's own sync change and a reload.
    await page.waitForTimeout(3_000);
    await expect(threadRow.getByTestId("conversation-card-marked-unread")).toBeVisible();
    await page.reload();
    const reloadedRow = page.getByTestId("inbox-row").filter({ hasText: replyText });
    await loadInboxUntilVisible(page, reloadedRow);
    await expect(reloadedRow.getByTestId("conversation-card-marked-unread")).toBeVisible();
    await expect(reloadedRow.getByTestId("conversation-card-new-badge")).toHaveCount(0);

    // Opening it reads it: the dot goes, on the server too. After a reload
    // the row can be out of view (loadInboxUntilVisible may scroll the list
    // for older pages before the first one is drawn).
    await clickInboxRow(reloadedRow);
    await expect(page.getByTestId("thread-message-scroller")).toBeVisible();
    await expect(reloadedRow.getByTestId("conversation-card-marked-unread")).toHaveCount(0);
    await expect.poll(threadOnServer).toEqual({ unreadCount: 0, markedUnread: false });
    await page.reload();
    const openedRow = page.getByTestId("inbox-row").filter({ hasText: replyText });
    await loadInboxUntilVisible(page, openedRow);
    await expect(openedRow.getByTestId("conversation-card-marked-unread")).toHaveCount(0);
  });

  test("clears an Activity new tag after the same thread is read from the thread panel", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    const runId = Date.now().toString(36);
    const peer = await registerEphemeralHuman(
      request,
      seedState,
      ownerLogin.accessToken,
      `${runId}-thread-read`,
    );
    const channel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `inbox-thread-read-${runId}`,
    );
    await addChannelHuman(request, seedState, ownerLogin.accessToken, channel.id, peer.id);

    const parentText = `thread read sync parent ${runId}`;
    const parent = await createMessage(
      request,
      seedState,
      ownerLogin.accessToken,
      channel.id,
      parentText,
    );
    const followResponse = await request.post(`${seedState.urls.api}/api/channels/threads/follow`, {
      headers: headers(seedState, ownerLogin.accessToken),
      data: { parentMessageId: parent.id },
    });
    expect(followResponse.ok()).toBeTruthy();

    const replyText = `thread read sync reply ${runId}`;
    const replyResponse = await request.post(`${seedState.urls.api}/api/channels/${channel.id}/threads`, {
      headers: headers(seedState, peer.accessToken),
      data: { parentMessageId: parent.id, content: replyText },
    });
    expect(replyResponse.ok()).toBeTruthy();

    await gotoInbox(page, seedState);
    const cachedThreadRow = page.getByTestId("inbox-row").filter({ hasText: replyText });
    await loadInboxUntilVisible(page, cachedThreadRow);
    await expect(cachedThreadRow.getByTestId("conversation-card-new-badge")).toHaveText("1");

    await page.goto(`/s/${seedState.server.slug}/channel/${channel.id}?thread=${channel.id}:${parent.id}`, { waitUntil: "domcontentloaded" });
    const threadScroller = page.getByTestId("thread-message-scroller");
    await expect(threadScroller).toBeVisible();
    await expect(threadScroller.getByText(replyText)).toBeVisible();

    await page.getByRole("button", { name: /^Activity/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/activity$`));
    const readThreadRow = page.getByTestId("inbox-row").filter({ hasText: replyText });
    await loadInboxUntilVisible(page, readThreadRow);
    await expect(readThreadRow).not.toContainText("new");
  });

  // Opening an Activity item never leaves for the Chat page (stdrc: "on any
  // screen size, opening an item in Activity must no longer jump back to the
  // Chat page"). Shared setup: a channel with one unread message from a peer.
  async function seedUnreadChannel(
    request: APIRequestContext,
    seedState: PlaywrightSeedState,
    accessToken: string,
    runId: string,
  ) {
    const peer = await registerEphemeralHuman(request, seedState, accessToken, `${runId}-open`);
    const channel = await createChannel(request, seedState, accessToken, `inbox-open-${runId}`);
    await addChannelHuman(request, seedState, accessToken, channel.id, peer.id);
    const readAll = await request.post(`${seedState.urls.api}/api/channels/${channel.id}/read-all`, {
      headers: headers(seedState, accessToken),
    });
    expect(readAll.ok()).toBeTruthy();
    const text = `inbox open in place ${runId}`;
    await createMessage(request, seedState, peer.accessToken, channel.id, text);
    const unread = async () => {
      const response = await request.get(`${seedState.urls.api}/api/channels/inbox`, {
        headers: headers(seedState, accessToken),
      });
      const body = await response.json() as { items: Array<{ channelId?: string; unreadCount?: number }> };
      return body.items.find((item) => item.channelId === channel.id)?.unreadCount ?? -1;
    };
    await expect.poll(unread).toBe(1);
    return { channel, text, unread };
  }

  test("a desktop window down to 768px keeps the Activity list beside the main area, and the list collapses like the sidebar", async ({ page, request }, testInfo) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    await page.setViewportSize({ width: 800, height: 900 });
    const runId = `${Date.now().toString(36)}-${testInfo.workerIndex}d`;
    const { channel, text, unread } = await seedUnreadChannel(request, seedState, ownerLogin.accessToken, runId);
    const activityPath = `/s/${seedState.server.slug}/activity`;
    const urlState = () => {
      const current = new URL(page.url());
      return { pathname: current.pathname, open: current.searchParams.get("open") };
    };
    const shellState = () => page.locator('[data-slot="app-shell-root"]').getAttribute("data-state");
    const railActivity = page.getByTestId("left-rail-tab-activity");
    const toggle = page.getByTestId("left-rail-sidebar-toggle");
    const listColumn = page.locator('[data-slot="app-shell-sidebar-slot"] [data-testid="shell-sidebar-column"]');
    const detail = page.locator("[data-activity-detail]");
    const row = page.getByTestId("inbox-row").filter({ hasText: text });
    // Rail, list and conversation share the window: the list keeps at least
    // its 240px, the conversation its 360px, and nothing scrolls sideways.
    // (Retried until the shell settles: the list column re-fits after a resize.)
    // With an item open the conversation is never narrower than the list (stdrc).
    const expectTwoColumnsFit = ({ itemOpen }: { itemOpen: boolean }) => expect(async () => {
      const list = await listColumn.boundingBox();
      const main = await page.getByTestId("thread-main-column").boundingBox();
      expect(list).not.toBeNull();
      expect(main).not.toBeNull();
      expect(list!.width).toBeGreaterThanOrEqual(240);
      expect(main!.width).toBeGreaterThanOrEqual(360);
      expect(main!.x).toBeGreaterThanOrEqual(list!.x + list!.width - 1);
      if (itemOpen) expect(list!.width).toBeLessThanOrEqual(main!.width);
      if (itemOpen) {
        const filters = await listColumn.getByTestId("inbox-toolbar").boundingBox();
        const tabs = await detail.locator('[data-slot="conversation-panel-tabs"]').boundingBox();
        expect(filters).not.toBeNull();
        expect(tabs).not.toBeNull();
        // Their lower seams must continue across the list/detail divider.
        expect(Math.abs(filters!.y + filters!.height - tabs!.y - tabs!.height)).toBeLessThanOrEqual(0.5);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }).toPass();

    await gotoInbox(page, seedState);
    await loadInboxUntilVisible(page, row);
    // Nothing open yet: the list is already in its column, the main area says so.
    const empty = page.getByTestId("activity-nothing-open");
    await expect(empty).toBeVisible();
    await expect(listColumn.getByTestId("inbox-row").filter({ hasText: text })).toBeVisible();
    await expect(railActivity).toHaveAttribute("data-selected", "true");
    await expectTwoColumnsFit({ itemOpen: false });
    await page.screenshot({ path: "/tmp/pw/activity-2col-800-empty.png" });

    await row.getByTestId("inbox-row-open").click();
    await expect.poll(urlState).toEqual({ pathname: activityPath, open: `channel:${channel.id}` });
    // Two columns: the conversation replaces the empty state, the list stays.
    await expect(detail.getByTestId("message-scroller").getByText(text)).toBeVisible();
    await expect(empty).toHaveCount(0);
    await expect(listColumn.getByTestId("inbox-row").filter({ hasText: text })).toBeVisible();
    await expect(railActivity).toHaveAttribute("data-selected", "true");
    await expect.poll(unread).toBe(0);
    await expectTwoColumnsFit({ itemOpen: true });
    // Desktop needs no header Back: the list is right there.
    await expect(detail.getByTestId("chat-mobile-back")).toBeHidden();
    await page.screenshot({ path: "/tmp/pw/activity-2col-800-open.png" });

    // The rail's toggle collapses the list; the conversation stays open and
    // takes the width; the toggle brings the list back.
    const openWidth = (await page.getByTestId("thread-main-column").boundingBox())!.width;
    const listLeft = (await listColumn.boundingBox())!.x;
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect.poll(shellState).toBe("collapsed");
    // The main area slides over the list's place (the list stays mounted, inert).
    await expect.poll(async () => (await page.getByTestId("thread-main-column").boundingBox())!.x).toBeLessThanOrEqual(listLeft + 1);
    await expect(page.locator('[data-slot="app-shell-sidebar-slot"]')).toHaveAttribute("inert", "");
    await expect(detail.getByTestId("message-scroller").getByText(text)).toBeVisible();
    await expect.poll(async () => (await page.getByTestId("thread-main-column").boundingBox())!.width).toBeGreaterThan(openWidth + 200);
    expect(urlState()).toEqual({ pathname: activityPath, open: `channel:${channel.id}` });
    await expect(railActivity).toHaveAttribute("data-selected", "true");
    await page.screenshot({ path: "/tmp/pw/activity-2col-800-collapsed.png" });
    await toggle.click();
    await expect.poll(shellState).toBe("expanded");
    await expect(listColumn.getByTestId("inbox-row").filter({ hasText: text })).toBeInViewport();

    // Ctrl+\ does the same.
    await page.keyboard.press("Control+Backslash");
    await expect.poll(shellState).toBe("collapsed");

    // Collapsing the Activity list leaves the chat sidebar as it was.
    await page.goto(`/s/${seedState.server.slug}/channel/${channel.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await expect.poll(shellState).toBe("expanded");
    // ...and coming back, the remembered collapsed list is collapsed again.
    await page.goto(`${activityPath}?open=channel:${channel.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-activity-detail]").getByTestId("message-scroller")).toBeVisible();
    await expect.poll(shellState).toBe("collapsed");
    await page.keyboard.press("Control+Backslash");
    await expect.poll(shellState).toBe("expanded");

    // The narrowest desktop still fits rail + list + conversation.
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(listColumn.getByTestId("inbox-row").filter({ hasText: text })).toBeVisible();
    await expect(page.locator("[data-activity-detail]").getByTestId("message-scroller").getByText(text)).toBeVisible();
    await expectTwoColumnsFit({ itemOpen: true });
    await page.screenshot({ path: "/tmp/pw/activity-2col-768-open.png" });

    // A window with room to spare: the list keeps its width, still no wider
    // than the conversation.
    await page.setViewportSize({ width: 900, height: 900 });
    await expectTwoColumnsFit({ itemOpen: true });
    await page.screenshot({ path: "/tmp/pw/activity-2col-900-open.png" });
  });

  test("the Activity filter row fits from the default list width down to its 240px minimum, chip included, and every filter is reachable", async ({ page, request }, testInfo) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    await page.setViewportSize({ width: 1280, height: 900 });
    // An unread row, so Mark all read sits beside the filters too.
    const { text } = await seedUnreadChannel(request, seedState, ownerLogin.accessToken, `${Date.now().toString(36)}-${testInfo.workerIndex}t`);
    const toolbar = page.getByTestId("inbox-toolbar");
    // Task #172: one Filter button and, for a filter other than All, its chip.
    const measure = () => toolbar.evaluate((el) => {
      const row = el.getBoundingClientRect();
      const markAll = el.querySelector("[data-testid=inbox-mark-all-read]")?.getBoundingClientRect();
      const button = el.querySelector("[data-testid=inbox-filter-button]")!.getBoundingClientRect();
      const chip = el.querySelector("[data-testid=inbox-filter-chip]")?.getBoundingClientRect();
      return {
        rowWidth: Math.round(row.width),
        overflow: el.scrollWidth - el.clientWidth,
        markAllInside: !markAll || markAll.right <= row.right + 0.5,
        buttonWidth: button.width,
        chipInside: !chip || (chip.width > 0 && (!markAll || chip.right <= markAll.left)),
      };
    });
    const loaded = async () => {
      await expect(page.getByTestId("inbox-row").filter({ hasText: text })).toBeVisible();
    };

    // Pinned has the longest label in some locales; Unread keeps the row (and Mark all read) in en.
    await gotoInbox(page, seedState);
    await loaded();
    for (const width of [380, 351, 300, 240]) {
      await page.evaluate((w) => localStorage.setItem("slock:searchPanelWidth", String(w)), width);
      for (const choice of ["all", "unread", "pinned"] as const) {
        await gotoInbox(page, seedState);
        await chooseInboxFilter(page, choice);
        await expect(page.getByTestId("inbox-filter-chip")).toHaveCount(choice === "all" ? 0 : 1);
        const at = await measure();
        expect(at.rowWidth, `${width}px list`).toBeLessThanOrEqual(width);
        expect(at.overflow, `${width}px list, ${choice}`).toBeLessThanOrEqual(0);
        expect(at.markAllInside, `${width}px list, ${choice}`).toBe(true);
        expect(at.buttonWidth, `${width}px list, ${choice}`).toBeGreaterThan(0);
        expect(at.chipInside, `${width}px list, ${choice}`).toBe(true);
      }
    }
    await page.screenshot({ path: "/tmp/pw/activity-list-240.png" });
    for (const choice of ["unread", "mentions", "pinned", "all"] as const) {
      await chooseInboxFilter(page, choice);
      await page.getByTestId("inbox-filter-button").click();
      await expect(page.getByTestId(`inbox-filter-${choice}`)).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
    }
  });

  test("a phone opens an Activity item as a page inside Activity and Back returns to the list", async ({ page, request }, testInfo) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    await page.setViewportSize({ width: 390, height: 844 });
    const runId = `${Date.now().toString(36)}-${testInfo.workerIndex}p`;
    const { channel, text, unread } = await seedUnreadChannel(request, seedState, ownerLogin.accessToken, runId);
    const activityPath = `/s/${seedState.server.slug}/activity`;
    const tabActivity = page.getByTestId("mobile-tab-bar").getByRole("button", { name: "Activity" });
    const urlState = () => {
      const current = new URL(page.url());
      return { pathname: current.pathname, open: current.searchParams.get("open") };
    };

    await gotoInbox(page, seedState);
    await expect(tabActivity).toHaveAttribute("data-selected", "true");
    const row = page.getByTestId("inbox-row").filter({ hasText: text });
    await loadInboxUntilVisible(page, row);

    // Opening stays on /activity, the item carried by ?open=, and reads it.
    await row.getByTestId("inbox-row-open").click();
    await expect.poll(urlState).toEqual({ pathname: activityPath, open: `channel:${channel.id}` });
    const detail = page.locator("[data-activity-detail]");
    await expect(detail.getByTestId("message-scroller").getByText(text)).toBeVisible();
    await expect(page.getByTestId("inbox-row")).toHaveCount(0);
    await expect.poll(unread).toBe(0);
    // A pushed page: it has a Back, so no tab bar (Raft DS › Navigation).
    await expect(page.getByTestId("mobile-tab-bar")).toHaveCount(0);
    await page.screenshot({ path: "/tmp/pw/activity-narrow-390-open.png" });

    // The conversation's header Back returns to the list, still in Activity.
    const back = detail.getByTestId("chat-mobile-back");
    await expect(back).toBeVisible();
    await back.click();
    await expect.poll(urlState).toEqual({ pathname: activityPath, open: null });
    await expect(page.getByTestId("inbox-row").filter({ hasText: text })).toBeVisible();
    await expect(page.locator("[data-activity-detail]")).toHaveCount(0);
    await expect(tabActivity).toHaveAttribute("data-selected", "true");
    await page.screenshot({ path: "/tmp/pw/activity-narrow-390-back.png" });

    // System/browser Back from the opened item returns to the list as well.
    await page.getByTestId("inbox-row").filter({ hasText: text }).getByTestId("inbox-row-open").click();
    await expect.poll(urlState).toEqual({ pathname: activityPath, open: `channel:${channel.id}` });
    await expect(page.locator("[data-activity-detail]").getByTestId("message-scroller").getByText(text)).toBeVisible();
    await page.goBack();
    await expect.poll(urlState).toEqual({ pathname: activityPath, open: null });
    await expect(page.getByTestId("inbox-row").filter({ hasText: text })).toBeVisible();
    await expect(tabActivity).toHaveAttribute("data-selected", "true");
  });

  test("marks all Inbox rows read and double-clicks the header to jump through unread rows", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    const runId = Date.now().toString(36);
    const peer = await registerEphemeralHuman(
      request,
      seedState,
      ownerLogin.accessToken,
      `${runId}-header`,
    );

    const firstUnreadChannel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `inbox-header-one-${runId}`,
    );
    const secondUnreadChannel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `inbox-header-two-${runId}`,
    );
    const firstUnreadText = `inbox header unread one ${runId}`;
    const secondUnreadText = `inbox header unread two ${runId}`;
    await addChannelHuman(request, seedState, ownerLogin.accessToken, firstUnreadChannel.id, peer.id);
    await addChannelHuman(request, seedState, ownerLogin.accessToken, secondUnreadChannel.id, peer.id);
    await createMessage(request, seedState, peer.accessToken, firstUnreadChannel.id, firstUnreadText);
    await createMessage(request, seedState, peer.accessToken, secondUnreadChannel.id, secondUnreadText);

    await gotoInbox(page, seedState);
    const header = page.getByTestId("inbox-header-title");
    await expect(header).toBeVisible();
    await expect(page.getByTestId("inbox-row").filter({ hasText: secondUnreadText })).toBeVisible();
    await expect(page.getByTestId("inbox-row").filter({ hasText: firstUnreadText })).toBeVisible();

    await header.dblclick();
    await expect(
      page.locator('[data-testid="inbox-row"][data-focused="true"]').filter({ hasText: secondUnreadText }),
    ).toBeVisible();
    await header.dblclick();
    await expect(
      page.locator('[data-testid="inbox-row"][data-focused="true"]').filter({ hasText: firstUnreadText }),
    ).toBeVisible();

    const allFilterBox = await page.getByTestId("inbox-filter-button").boundingBox();
    const markAllReadBox = await page.getByTestId("inbox-mark-all-read").boundingBox();
    expect(allFilterBox).not.toBeNull();
    expect(markAllReadBox).not.toBeNull();
    // One line: centred on each other. With a mouse on a desktop (#12730, stdrc
    // 2026-11-04) the Filter picker is the 34px control height and Mark All Read
    // a 28px bar button, so their tops and heights differ on purpose; the
    // frameless button is never the taller of the two.
    const centre = (box: { y: number; height: number }) => box.y + box.height / 2;
    expect(Math.abs(centre(allFilterBox!) - centre(markAllReadBox!))).toBeLessThanOrEqual(1);
    expect(markAllReadBox!.height).toBeLessThanOrEqual(allFilterBox!.height + 0.5);

    await page.getByTestId("inbox-mark-all-read").click();
    await expect(page.getByTestId("inbox-mark-all-read")).toHaveCount(0);
    await expect(page.getByTestId("inbox-row").filter({ hasText: firstUnreadText }).getByTestId("conversation-card-new-badge")).toHaveCount(0);
    await expect(page.getByTestId("inbox-row").filter({ hasText: secondUnreadText }).getByTestId("conversation-card-new-badge")).toHaveCount(0);

    await expect.poll(async () => {
      const response = await request.get(`${seedState.urls.api}/api/channels/inbox?filter=unread`, {
        headers: headers(seedState, ownerLogin.accessToken),
      });
      const body = await response.json() as { totalUnreadCount: number };
      return body.totalUnreadCount;
    }).toBe(0);
  });
});
