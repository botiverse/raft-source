import { expect } from "@playwright/test";
import type { APIRequestContext, Locator, Page, TestInfo } from "@playwright/test";
import { assertApiOk } from "../../fixtures/apiResponse";
import { expectCssColor } from "../../fixtures/colorAssertions";
import { navigateToMessageScrollerWithReadinessEvidence } from "../../fixtures/messageScrollerReadiness";
import type { ScenarioSeedState } from "../../fixtures/seedState";
import { test } from "../../fixtures/scenario";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function authHeaders(accessToken: string, serverId: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Server-Id": serverId,
  };
}

function sidebarButtonName(name: string) {
  return new RegExp(`^${escapeRegExp(name)}(?:\\s+\\d+)?$`);
}

function channelPath(seedState: ScenarioSeedState, channelId: string) {
  return `/s/${seedState.server.slug}/channel/${channelId}`;
}

function dmPath(seedState: ScenarioSeedState, channelId: string) {
  return `/s/${seedState.server.slug}/dm/${channelId}`;
}

async function createChannel(
  request: APIRequestContext,
  seedState: ScenarioSeedState,
  accessToken: string,
  name: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: authHeaders(accessToken, seedState.server.id),
    data: { name },
  });
  await assertApiOk(response, `POST /api/channels (name=${name})`);
  return response.json() as Promise<{ id: string; name: string }>;
}

async function createDm(
  request: APIRequestContext,
  seedState: ScenarioSeedState,
  accessToken: string,
  userId: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels/dm`, {
    headers: authHeaders(accessToken, seedState.server.id),
    data: { userId },
  });
  await assertApiOk(response, `POST /api/channels/dm (userId=${userId})`);
  return response.json() as Promise<{ id: string }>;
}

async function addHumanToChannel(
  request: APIRequestContext,
  seedState: ScenarioSeedState,
  accessToken: string,
  channelId: string,
  userId: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels/${channelId}/members`, {
    headers: authHeaders(accessToken, seedState.server.id),
    data: { userId },
  });
  await assertApiOk(response, `POST /api/channels/${channelId}/members (userId=${userId})`);
}

async function createMessage(
  request: APIRequestContext,
  seedState: ScenarioSeedState,
  accessToken: string,
  channelId: string,
  content: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: authHeaders(accessToken, seedState.server.id),
    data: { channelId, content },
  });
  await assertApiOk(response, `POST /api/messages (channelId=${channelId})`);
}

async function markChannelRead(
  request: APIRequestContext,
  seedState: ScenarioSeedState,
  accessToken: string,
  channelId: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels/${channelId}/read-all`, {
    headers: authHeaders(accessToken, seedState.server.id),
  });
  await assertApiOk(response, `POST /api/channels/${channelId}/read-all`);
}

async function getServerUnreadCount(
  request: APIRequestContext,
  seedState: ScenarioSeedState,
  accessToken: string,
  channelId: string,
) {
  const response = await request.get(`${seedState.urls.api}/api/channels/unread`, {
    headers: authHeaders(accessToken, seedState.server.id),
  });
  await assertApiOk(response, "GET /api/channels/unread");
  const body = await response.json() as Record<string, number>;
  return body[channelId] ?? 0;
}

function channelRow(page: Page, name: string) {
  return page
    .locator("#sidebar-section-channels")
    .getByRole("button", { name: sidebarButtonName(name) })
    .first();
}

function dmRow(page: Page, channelId: string) {
  return page.locator(`button[data-sidebar-channel-id="${channelId}"]`).first();
}

async function openRowMenu(row: Locator, page: Page) {
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  const markAction = page.getByRole("menuitem", { name: /Mark as (read|unread)/ });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await row.click({ button: "right" });
    try {
      await expect(markAction).toBeVisible({ timeout: 5000 });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
}

// The unread count is the row's pink sticker (Raft DS › Badge: pink means
// "go read"), raft-ui's SidebarItemCount.
async function expectUnreadBadge(row: Locator, count: number) {
  const unreadBadge = row.locator('[data-slot="sidebar-item-count"]');
  if (count > 0) {
    await expect(unreadBadge).toHaveText(String(count));
    // Read the color until it settles: one read just as the badge appears can
    // see no background yet (staging e2e(4), run 43151880055). Same tolerance.
    await expect.poll(async () => {
      const color = await unreadBadge.evaluate((el) => getComputedStyle(el).backgroundColor);
      try {
        await expectCssColor(row.page(), color, "#FF99C3", 2);
        return "#FF99C3";
      } catch {
        return color;
      }
    }).toBe("#FF99C3");
    return;
  }
  await expect(unreadBadge).toHaveCount(0);
}

const conversationKinds = ["channel", "dm"] as const;
const latestAuthors = ["peer", "self"] as const;
const startingPlaces = ["target", "other"] as const;

type ConversationKind = typeof conversationKinds[number];
type LatestAuthor = typeof latestAuthors[number];
type StartingPlace = typeof startingPlaces[number];

interface UnreadConversation {
  kind: ConversationKind;
  id: string;
  path: string;
  row: () => Locator;
}

async function exerciseUnreadScenario(
  page: Page,
  request: APIRequestContext,
  seedState: ScenarioSeedState,
  login: { accessToken: string },
  peer: { id: string; accessToken: string },
  conversationKind: ConversationKind,
  latestAuthor: LatestAuthor,
  startingPlace: StartingPlace,
  testInfo: TestInfo,
) {
  const runId = `${Date.now().toString(36)}-${conversationKind[0]}${latestAuthor[0]}${startingPlace[0]}`;
  const anchorChannel = await createChannel(request, seedState, login.accessToken, `unread-anchor-${runId}`);
  await createMessage(
    request,
    seedState,
    login.accessToken,
    anchorChannel.id,
    `Unread matrix anchor message ${runId}`,
  );
  let conversation: UnreadConversation;
  if (conversationKind === "channel") {
    const matrixChannel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `unread-channel-${runId}`,
    );
    await addHumanToChannel(
      request,
      seedState,
      login.accessToken,
      matrixChannel.id,
      peer.id,
    );
    conversation = {
      kind: "channel",
      id: matrixChannel.id,
      path: channelPath(seedState, matrixChannel.id),
      row: () => channelRow(page, matrixChannel.name),
    };
  } else {
    const matrixDm = await createDm(
      request,
      seedState,
      login.accessToken,
      peer.id,
    );
    conversation = {
      kind: "dm",
      id: matrixDm.id,
      path: dmPath(seedState, matrixDm.id),
      row: () => dmRow(page, matrixDm.id),
    };
  }

  const contentBase = `${conversation.kind}-${latestAuthor}-${startingPlace}-${Date.now().toString(36)}`;
  await createMessage(
    request,
    seedState,
    peer.accessToken,
    conversation.id,
    `Unread eligible peer message ${contentBase}`,
  );
  if (latestAuthor === "self") {
    await createMessage(
      request,
      seedState,
      login.accessToken,
      conversation.id,
      `Self-authored latest message ${contentBase}`,
    );
  }
  await markChannelRead(request, seedState, login.accessToken, conversation.id);

  const startPath = startingPlace === "target"
    ? conversation.path
    : channelPath(seedState, anchorChannel.id);
  const initialChannelId = startingPlace === "target" ? conversation.id : anchorChannel.id;
  await navigateToMessageScrollerWithReadinessEvidence(page, testInfo, {
    consumer: "unread-click-read",
    channelId: initialChannelId,
  }, () => page.goto(startPath, { waitUntil: "domcontentloaded" }));

  const row = conversation.row();
  await expectUnreadBadge(row, 0);
  await openRowMenu(row, page);

  const unreadResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/api/channels/${conversation.id}/unread`)
  );
  await page.getByRole("menuitem", { name: "Mark as unread" }).click();
  await expect(page.getByRole("menuitem", { name: "Mark as unread" })).toHaveCount(0);
  await expectUnreadBadge(row, 1);

  const unreadResponse = await unreadResponsePromise;
  expect(unreadResponse.ok()).toBeTruthy();
  expect((await unreadResponse.json() as { unreadCount: number }).unreadCount).toBe(1);
  await expect.poll(async () =>
    getServerUnreadCount(request, seedState, login.accessToken, conversation.id)
  ).toBe(1);
  await expectUnreadBadge(row, 1);

  if (startingPlace === "target") {
    await channelRow(page, anchorChannel.name).click();
    await expect(page).toHaveURL(new RegExp(`/channel/${escapeRegExp(anchorChannel.id)}(?:$|[?#])`));
    await expectUnreadBadge(row, 1);
  }

  const readResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/api/channels/${conversation.id}/read-all`)
  );
  await row.click();
  const readResponse = await readResponsePromise;
  expect(readResponse.ok()).toBeTruthy();
  await expectUnreadBadge(row, 0);
  await expect.poll(async () =>
    getServerUnreadCount(request, seedState, login.accessToken, conversation.id)
  ).toBe(0);
}

// Each case owns its server and both participants. New DMs must not change
// another spec's shared-owner sidebar while it verifies an exact reorder.
test.describe("sidebar Mark as Unread works across channels and DMs from current or other chats", () => {
  for (const conversationKind of conversationKinds) {
    for (const latestAuthor of latestAuthors) {
      for (const startingPlace of startingPlaces) {
        test(`${conversationKind}: latest ${latestAuthor}, starting from ${startingPlace}`, async ({ page, request, scenario }, testInfo) => {
          await exerciseUnreadScenario(
            page,
            request,
            scenario.seed,
            scenario.login,
            scenario.peer,
            conversationKind,
            latestAuthor,
            startingPlace,
            testInfo,
          );
        });
      }
    }
  }
});

test.describe("conversation All Read", () => {
  // This test overrides the browser flag response; service-worker fetches can
  // bypass Playwright routing (notably in WebKit).
  test.use({ serviceWorkers: "block" });

test("sidebar All Read clears thread-only unread and a later reply becomes unread again", async ({ page, request, scenario }, testInfo) => {
  const { seed, login, peer } = scenario;
  const target = await createChannel(request, seed, login.accessToken, `all-read-${Date.now().toString(36)}`);
  await addHumanToChannel(request, seed, login.accessToken, target.id, peer.id);
  const parentResponse = await request.post(`${seed.urls.api}/api/messages`, {
    headers: authHeaders(login.accessToken, seed.server.id),
    data: { channelId: target.id, content: "All-read thread parent" },
  });
  await assertApiOk(parentResponse, "create All Read parent");
  const parent = await parentResponse.json() as { id: string };
  const followed = await request.post(`${seed.urls.api}/api/channels/threads/follow`, {
    headers: authHeaders(login.accessToken, seed.server.id), data: { parentMessageId: parent.id },
  });
  await assertApiOk(followed, "follow All Read thread");
  const postReply = async (content: string) => {
    const response = await request.post(`${seed.urls.api}/api/channels/${target.id}/threads`, {
      headers: authHeaders(peer.accessToken, seed.server.id),
      data: { parentMessageId: parent.id, content },
    });
    await assertApiOk(response, "post All Read reply");
  };
  await createMessage(request, seed, login.accessToken, seed.channel.id, "Anchor while clearing another conversation");
  await postReply("Unread before explicit All Read");
  await markChannelRead(request, seed, login.accessToken, target.id);
  await navigateToMessageScrollerWithReadinessEvidence(page, testInfo, { consumer: "unread-click-read", channelId: seed.channel.id }, () => page.goto(channelPath(seed, seed.channel.id), { waitUntil: "domcontentloaded" }));
  const row = page.locator(`button[data-sidebar-channel-id="${target.id}"]`).first();
  const threadBadge = row.getByTestId("sidebar-thread-unread");
  await expect(threadBadge).toHaveText("1 thread with new replies");
  expect(await getServerUnreadCount(request, seed, login.accessToken, target.id)).toBe(0);
  await row.click({ button: "right" });
  const receipt = page.waitForResponse((response) =>
    response.url().endsWith(`/channels/${target.id}/conversation-read-all`) && response.request().method() === "POST");
  await page.getByRole("menuitem", { name: "Mark all as read", exact: true }).click();
  expect((await receipt).ok()).toBe(true);
  await expect(threadBadge).toHaveCount(0);
  await postReply("New reply after All Read must remain unread");
  await expect(threadBadge).toHaveText("1 thread with new replies");
});

});
