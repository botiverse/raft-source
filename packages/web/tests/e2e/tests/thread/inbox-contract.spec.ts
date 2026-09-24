import { expect, test } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import type { PlaywrightSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

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
      params: { limit: 30, offset: pageIndex * 30 },
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

  const addMemberResponse = await request.post(`${seedState.urls.api}/api/servers/${seedState.server.id}/members`, {
    headers: headers(seedState, ownerAccessToken),
    data: { userId: registered.user.id, role: "member" },
  });
  expect(
    addMemberResponse.ok(),
    `ephemeral inbox peer membership failed: ${addMemberResponse.status()}`,
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

async function gotoInbox(page: Page, seedState: PlaywrightSeedState) {
  await page.goto(`/s/${seedState.server.slug}/inbox`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByTestId("inbox-filter-all")).toBeVisible();
}

test.describe("Inbox contract", () => {
  test("shows active chats, keeps unread as a filter, and lazy-loads by scroll", async ({ page, request }) => {
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
    for (let idx = 0; idx < 35; idx += 1) {
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
    await expect(page.getByTestId("inbox-filter-unread")).toBeVisible();
    await expect(page.getByRole("button", { name: /Load More/i })).toHaveCount(0);

    const rows = page.getByTestId("inbox-row");
    await expect(rows).toHaveCount(30);
    await loadNextInboxPage(page);
    const loadedRowCount = await page.getByTestId("inbox-row").count();
    const savedScrollTop = await page.getByTestId("inbox-scroll").evaluate((node) => node.scrollTop);
    expect(savedScrollTop).toBeGreaterThan(0);

    // Desktop Activity uses single-click for its col-3 preview. Double-click is
    // the intentional full-chat gesture, which is the route/back-stack contract
    // exercised by this section.
    await rows.filter({ hasText: activeLatestMessage }).dblclick();
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
    await dmRow.dblclick();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/dm/${dm.id}\\?msg=${dmMessageRecord.id}$`));
    await expect(page.getByTestId("message-scroller")).toBeVisible();

    await gotoInbox(page, seedState);
    await loadInboxUntilVisible(page, page.getByTestId("inbox-row").filter({ hasText: participatedReply }));
    await loadInboxUntilVisible(page, page.getByTestId("inbox-row").filter({ hasText: activeLatestMessage }));

    const activeRow = rows.filter({ hasText: activeLatestMessage });
    await activeRow.getByTitle("Mark as Done").click();
    await expect(rows.filter({ hasText: activeLatestMessage })).toHaveCount(0);
    const reopenedMessage = `inbox active reopened ${runId}`;
    await createMessage(request, seedState, peer.accessToken, activeChannel.id, reopenedMessage);
    const reopenedRow = page.getByTestId("inbox-row").filter({ hasText: reopenedMessage });
    await expect(reopenedRow).toBeVisible();
    await expect(reopenedRow).toContainText("1 new");

    await page.getByTestId("inbox-filter-unread").click();
    await expect(reopenedRow).toBeVisible();

    await page.getByTestId("inbox-filter-all").click();
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
      await gotoInbox(page, seedState);
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

    const messageText = `inbox read sync target ${runId}`;
    await createMessage(request, seedState, peer.accessToken, channel.id, messageText);

    await gotoInbox(page, seedState);
    const cachedActivityRow = page.getByTestId("inbox-row").filter({ hasText: messageText });
    await expect(cachedActivityRow).toBeVisible();
    await expect(cachedActivityRow).toContainText("1 new");

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
    await expect(cachedThreadRow).toContainText("1 new");

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

    const allFilterBox = await page.getByTestId("inbox-filter-all").boundingBox();
    const markAllReadBox = await page.getByTestId("inbox-mark-all-read").boundingBox();
    expect(allFilterBox).not.toBeNull();
    expect(markAllReadBox).not.toBeNull();
    expect(Math.abs(allFilterBox!.y - markAllReadBox!.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(allFilterBox!.height - markAllReadBox!.height)).toBeLessThanOrEqual(2);

    await page.getByTestId("inbox-mark-all-read").click();
    await expect(page.getByTestId("inbox-mark-all-read")).toHaveCount(0);
    await expect(page.getByTestId("inbox-row").filter({ hasText: firstUnreadText })).not.toContainText("new");
    await expect(page.getByTestId("inbox-row").filter({ hasText: secondUnreadText })).not.toContainText("new");

    await expect.poll(async () => {
      const response = await request.get(`${seedState.urls.api}/api/channels/inbox?filter=unread`, {
        headers: headers(seedState, ownerLogin.accessToken),
      });
      const body = await response.json() as { totalUnreadCount: number };
      return body.totalUnreadCount;
    }).toBe(0);
  });
});
