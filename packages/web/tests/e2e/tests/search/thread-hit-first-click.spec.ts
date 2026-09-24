import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
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

// Regression guard for task #330: clicking a thread message search hit must
// render ThreadPanel in col-3 on the FIRST click. Before the fix in
// MainLayout.useSearchContentUrlSync, the Store→URL subscriber read a stale
// `location.search` closure and clobbered the `?thread=` query param that
// useRightPanelUrlSync had just written, which caused URL→Store to call
// closeThread() and leave ThreadPanel with `parentMessageId === null` (it
// returns null when the parent message id is missing), so col-3 went blank
// until a second click re-seeded threadStore on top of the already-present
// `?open=thread:...` URL.
test.describe("Thread search hit master/detail", () => {
  test("first click on a thread hit renders ThreadPanel (not a blank col-3)", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
    const runId = Date.now().toString(36);

    const authHeaders = {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    };

    const channel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `thread-search-hit-${runId}`,
    );

    const parentRes = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: authHeaders,
      data: {
        channelId: channel.id,
        content: `thread-search parent ${runId}`,
      },
    });
    expect(parentRes.ok()).toBeTruthy();
    const parent = await parentRes.json() as { id: string };

    const replyContent = `threadsearchhit-${runId}`;
    const replyRes = await request.post(
      `${seedState.urls.api}/api/channels/${channel.id}/threads`,
      {
        headers: authHeaders,
        data: { parentMessageId: parent.id, content: replyContent },
      },
    );
    expect(replyRes.ok()).toBeTruthy();

    await page.goto(`/s/${seedState.server.slug}/search?q=${encodeURIComponent(replyContent)}`);
    const hit = page.getByRole("button", { name: new RegExp(replyContent) }).first();
    await expect(hit).toBeVisible();

    await hit.click();

    // Col-3 should be ThreadPanel — assert its parent-message testid is
    // visible without a second click. (Before the fix, it stayed blank
    // until the user clicked the same card a second time.)
    await expect(page.getByTestId("thread-panel-parent")).toBeVisible();
    await expect(page).toHaveURL(/[?&]open=thread%3A[^&]+/);
    await expect(page).toHaveURL(/[?&]thread=[^&]+%3A[^&]+/);
  });

  test("Enter inside search detail inputs preserves the open channel and thread", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
    const runId = Date.now().toString(36);

    const authHeaders = {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    };

    const channel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `thread-search-enter-${runId}`,
    );

    const parentContent = `search-enter parent ${runId}`;
    const parentRes = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: authHeaders,
      data: {
        channelId: channel.id,
        content: parentContent,
      },
    });
    expect(parentRes.ok()).toBeTruthy();
    const parent = await parentRes.json() as { id: string };

    const replyContent = `search-enter reply ${runId}`;
    const replyRes = await request.post(
      `${seedState.urls.api}/api/channels/${channel.id}/threads`,
      {
        headers: authHeaders,
        data: { parentMessageId: parent.id, content: replyContent },
      },
    );
    expect(replyRes.ok()).toBeTruthy();

    const params = new URLSearchParams({
      q: parentContent,
      open: `channel:${channel.id}`,
      msg: parent.id,
      thread: `${channel.id}:${parent.id}`,
    });
    await page.goto(`/s/${seedState.server.slug}/search?${params.toString()}`);

    await expect(page.getByRole("button", { name: new RegExp(parentContent) }).first()).toBeVisible();
    await expect(page.getByTestId("message-scroller").getByText(parentContent)).toBeVisible();
    await expect(page.getByTestId("thread-panel-parent")).toBeVisible();

    const threadComposer = page.getByPlaceholder("Message thread");
    await threadComposer.fill(`thread composer enter ${runId}`);
    const [threadSendResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/v2/messages"
      ),
      threadComposer.press("Enter"),
    ]);
    expect(threadSendResponse.ok()).toBeTruthy();
    await expect(page.getByTestId("thread-panel-parent")).toBeVisible();
    await expect(page).toHaveURL(/[?&]open=channel%3A[^&]+/);
    await expect(page).toHaveURL(/[?&]thread=[^&]+%3A[^&]+/);

    const channelComposer = page.getByPlaceholder(`Message #${channel.name}`);
    await channelComposer.fill(`channel composer enter ${runId}`);
    const [channelSendResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/v2/messages"
      ),
      channelComposer.press("Enter"),
    ]);
    expect(channelSendResponse.ok()).toBeTruthy();
    await expect(page.getByTestId("thread-panel-parent")).toBeVisible();
    await expect(page).toHaveURL(/[?&]open=channel%3A[^&]+/);
    await expect(page).toHaveURL(/[?&]thread=[^&]+%3A[^&]+/);

    const searchInput = page.getByPlaceholder("Search channels, DMs, messages…");
    await searchInput.focus();
    await searchInput.press("Enter");
    await expect(page.getByTestId("thread-panel-parent")).toBeVisible();
    await expect(page.getByTestId("message-scroller").getByText(parentContent)).toBeVisible();
    await expect(page).toHaveURL(/[?&]open=channel%3A[^&]+/);
    await expect(page).toHaveURL(/[?&]thread=[^&]+%3A[^&]+/);
  });

  test("Enter in the search input still opens the selected result when no detail is open", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
    const runId = Date.now().toString(36);

    const content = `search-input-enter ${runId}`;
    const channel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `zz-${crypto.randomUUID().slice(0, 12)}`,
    );

    const messageRes = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        channelId: channel.id,
        content,
      },
    });
    expect(messageRes.ok()).toBeTruthy();
    const message = await messageRes.json() as { id: string };

    await page.goto(`/s/${seedState.server.slug}/search?q=${encodeURIComponent(content)}`);
    const channelFilter = page.getByRole("button", { name: "Open channel filter" });
    await channelFilter.click();
    await expect(page.getByRole("button", { name: `#${channel.name}`, exact: true })).toBeVisible();
    await page.getByPlaceholder("Search…").press("Escape");
    await expect(channelFilter).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Server entities", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(content) })).toHaveCount(1);

    const searchInput = page.getByPlaceholder("Search channels, DMs, messages…");
    await searchInput.focus();
    await searchInput.press("Enter");

    await expect(page).toHaveURL(
      new RegExp(`/search\\?.*open=channel%3A${channel.id}.*msg=${message.id}`),
    );
    await expect(page.getByTestId("message-scroller").getByText(content)).toBeVisible();
  });

  test("IME composing Enter in the search input commits text without opening the selected result", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
    const runId = Date.now().toString(36);

    const content = `search-ime-enter ${runId}`;
    const channel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `search-ime-enter-${runId}`,
    );

    const messageRes = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        channelId: channel.id,
        content,
      },
    });
    expect(messageRes.ok()).toBeTruthy();

    await page.goto(`/s/${seedState.server.slug}/search?q=${encodeURIComponent(content)}`);
    await expect(page.getByRole("button", { name: new RegExp(content) }).first()).toBeVisible();

    const searchInput = page.getByPlaceholder("Search channels, DMs, messages…");
    await searchInput.focus();
    await searchInput.dispatchEvent("compositionstart");
    await searchInput.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
      keyCode: 229,
    });

    await expect(page).not.toHaveURL(/[?&]open=/);
  });
});
