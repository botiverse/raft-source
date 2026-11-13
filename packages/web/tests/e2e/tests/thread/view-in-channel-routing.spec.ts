import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

interface ThreadReadinessSample {
  elapsedMs: number;
  reason: "init" | "interval" | "final";
  pathname: string;
  search: string;
  readyState: DocumentReadyState;
  threadScrollerCount: number;
  threadScrollerVisible: boolean;
  threadParentCount: number;
  mobileBackCount: number;
  threadLoadingVisible: boolean;
  threadErrorVisible: boolean;
  threadRetryCount: number;
  messageScrollerCount: number;
  parentContentPresent: boolean;
  replyPresent: boolean;
}

interface ThreadReadinessLedger {
  schema: "thread-scroller-readiness";
  version: 1;
  timeOrigin: number;
  samples: ThreadReadinessSample[];
}

interface ThreadReadinessProbe {
  stopAndRead: () => ThreadReadinessLedger;
}

type ThreadReadinessWindow = Window & {
  __RAFT_THREAD_READINESS__?: ThreadReadinessProbe;
};

async function installThreadReadinessProbe(
  page: Page,
  parentContent: string,
  reply: string,
) {
  await page.evaluate(({ expectedParentContent, expectedReply }) => {
    const maxSamples = 24;
    const samples: ThreadReadinessSample[] = [];
    const startedAt = performance.now();

    const record = (reason: ThreadReadinessSample["reason"]) => {
      const threadScroller = document.querySelector<HTMLElement>(
        '[data-testid="thread-message-scroller"]',
      );
      const threadScrollerStyle = threadScroller ? getComputedStyle(threadScroller) : null;
      const mobileBack = document.querySelector<HTMLElement>('[data-testid="thread-mobile-back"]');
      const threadSurface = mobileBack?.closest(".isolate") ?? document;
      const retry = threadSurface.querySelector<HTMLElement>('[data-testid="thread-retry"]');
      const loading = Array.from(threadSurface.querySelectorAll<HTMLElement>("div")).find((node) => {
        const text = node.textContent?.trim();
        return text === "Loading…" || text === "加载中…";
      });
      const bodyText = document.body?.textContent ?? "";
      const sample: ThreadReadinessSample = {
        elapsedMs: Math.round(performance.now() - startedAt),
        reason,
        pathname: location.pathname,
        search: location.search,
        readyState: document.readyState,
        threadScrollerCount: document.querySelectorAll(
          '[data-testid="thread-message-scroller"]',
        ).length,
        threadScrollerVisible: !!threadScroller
          && threadScroller.getClientRects().length > 0
          && threadScrollerStyle?.display !== "none"
          && threadScrollerStyle?.visibility !== "hidden",
        threadParentCount: document.querySelectorAll('[data-testid="thread-panel-parent"]').length,
        mobileBackCount: document.querySelectorAll('[data-testid="thread-mobile-back"]').length,
        threadLoadingVisible: !!loading && loading.getClientRects().length > 0,
        threadErrorVisible: !!retry && retry.getClientRects().length > 0,
        threadRetryCount: document.querySelectorAll('[data-testid="thread-retry"]').length,
        messageScrollerCount: document.querySelectorAll('[data-testid="message-scroller"]').length,
        parentContentPresent: bodyText.includes(expectedParentContent),
        replyPresent: bodyText.includes(expectedReply),
      };
      if (samples.length < maxSamples) {
        samples.push(sample);
      } else if (reason === "final") {
        samples[maxSamples - 1] = sample;
      }
    };

    const timer = window.setInterval(() => record("interval"), 250);
    const probe: ThreadReadinessProbe = {
      stopAndRead: () => {
        window.clearInterval(timer);
        record("final");
        Reflect.deleteProperty(window, "__RAFT_THREAD_READINESS__");
        return {
          schema: "thread-scroller-readiness",
          version: 1,
          timeOrigin: performance.timeOrigin,
          samples,
        };
      },
    };
    Object.defineProperty(window, "__RAFT_THREAD_READINESS__", {
      configurable: true,
      value: probe,
    });
    record("init");
  }, { expectedParentContent: parentContent, expectedReply: reply });
}

async function expectThreadScrollerWithReadinessEvidence(
  page: Page,
  testInfo: TestInfo,
) {
  let assertionError: Error | null = null;
  try {
    await expect(page.getByTestId("thread-message-scroller")).toBeVisible();
  } catch (error) {
    assertionError = error instanceof Error ? error : new Error(String(error));
  }

  let evidence: ThreadReadinessLedger | null = null;
  let captureError: Error | null = null;
  try {
    evidence = await page.evaluate(() =>
      (window as ThreadReadinessWindow).__RAFT_THREAD_READINESS__?.stopAndRead() ?? null
    );
    if (!evidence) captureError = new Error("thread readiness probe missing after navigation");
  } catch (error) {
    captureError = error instanceof Error ? error : new Error(String(error));
  }

  try {
    await testInfo.attach("thread-scroller-readiness.json", {
      body: Buffer.from(JSON.stringify({
        retry: testInfo.retry,
        evidence,
        captureError: captureError?.message ?? null,
      }, null, 2)),
      contentType: "application/json",
    });
  } catch (error) {
    captureError ??= error instanceof Error ? error : new Error(String(error));
  }

  if (assertionError) {
    if (captureError) {
      console.error("[thread-readiness] diagnostic capture failed:", captureError.message);
    }
    throw assertionError;
  }
  if (captureError) throw captureError;
}

// Covers the bug Jianwei filed in #engineering task #288: on mobile, tapping
// "View in channel" inside a DM thread routed to /channel/<dmId> instead of
// /dm/<dmId> (404), and a leftover closeThread() call raced the freshly-pushed
// ?msg= query, replacing it with the old thread URL.
test.describe("thread view-in-channel routing", () => {
  test("mobile: channel thread → /channel/<id>?msg=<parentId>", async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });

    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const parentContent = `Channel thread parent ${Date.now()}`;
    const reply = `Channel thread reply ${Date.now()}`;

    const parent = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { channelId: seedState.channel.id, content: parentContent },
    });
    expect(parent.ok()).toBeTruthy();
    const parentMsg = (await parent.json()) as { id: string };

    const threadResp = await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { parentMessageId: parentMsg.id, content: reply },
      },
    );
    expect(threadResp.ok()).toBeTruthy();

    await page.goto(
      `/s/${seedState.server.slug}/channel/${seedState.channel.id}?thread=${seedState.channel.id}:${parentMsg.id}`,
    );
    await installThreadReadinessProbe(page, parentContent, reply);
    await expectThreadScrollerWithReadinessEvidence(page, testInfo);
    await expect(page.getByTestId("thread-mobile-back")).toBeVisible();

    await page.getByTestId("thread-overflow-trigger").click();
    const viewInChannel = page.getByTestId("thread-overflow-view-in-channel");
    await viewInChannel.click();

    await expect(page).toHaveURL(
      new RegExp(
        `/s/${seedState.server.slug}/channel/${seedState.channel.id}\\?msg=${parentMsg.id}$`,
      ),
    );
    await expect(page.getByTestId("thread-message-scroller")).toHaveCount(0);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
  });

  test("mobile: DM thread → /dm/<id>?msg=<parentId> (no /channel/ rewrite, no race)", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const dmResp = await request.post(`${seedState.urls.api}/api/channels/dm`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { userId: seedState.extraHuman.userId },
    });
    expect(dmResp.ok()).toBeTruthy();
    const dm = (await dmResp.json()) as { id: string };

    const parentContent = `DM thread parent ${Date.now()}`;
    const reply = `DM thread reply ${Date.now()}`;

    const parent = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { channelId: dm.id, content: parentContent },
    });
    expect(parent.ok()).toBeTruthy();
    const parentMsg = (await parent.json()) as { id: string };

    const threadResp = await request.post(
      `${seedState.urls.api}/api/channels/${dm.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { parentMessageId: parentMsg.id, content: reply },
      },
    );
    expect(threadResp.ok()).toBeTruthy();

    await page.goto(
      `/s/${seedState.server.slug}/dm/${dm.id}?thread=${dm.id}:${parentMsg.id}`,
    );
    await expect(page.getByTestId("thread-message-scroller")).toBeVisible();
    await expect(page.getByTestId("thread-mobile-back")).toBeVisible();

    await page.getByTestId("thread-overflow-trigger").click();
    await page.getByTestId("thread-overflow-view-in-channel").click();

    // Critical: the path is /dm/, not /channel/, AND ?msg= survives (the
    // old closeThread() race wiped the query, leaving us at /dm/<id> alone).
    await expect(page).toHaveURL(
      new RegExp(`/s/${seedState.server.slug}/dm/${dm.id}\\?msg=${parentMsg.id}$`),
    );
    await expect(page.getByTestId("thread-message-scroller")).toHaveCount(0);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
  });

  test("desktop: the channel name in the thread header opens the parent message in the channel", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
    const headers = {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    };

    const parent = await request.post(`${seedState.urls.api}/api/messages`, {
      headers,
      data: { channelId: seedState.channel.id, content: `Header link parent ${Date.now()}` },
    });
    expect(parent.ok()).toBeTruthy();
    const parentMsg = (await parent.json()) as { id: string };
    const threadResp = await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      { headers, data: { parentMessageId: parentMsg.id, content: `Header link reply ${Date.now()}` } },
    );
    expect(threadResp.ok()).toBeTruthy();

    await page.goto(
      `/s/${seedState.server.slug}/channel/${seedState.channel.id}?thread=${seedState.channel.id}:${parentMsg.id}`,
    );
    await expect(page.getByTestId("thread-message-scroller")).toBeVisible();

    const channelLink = page.getByTestId("thread-header-channel-link");
    await expect(channelLink).toHaveText(`#${seedState.channel.name}`);
    await channelLink.click();

    await expect(page).toHaveURL(
      new RegExp(`/s/${seedState.server.slug}/channel/${seedState.channel.id}\\?msg=${parentMsg.id}$`),
    );
  });

  test("desktop: DM thread → toDmMessage builds /dm/ permalink", async ({
    page,
    request,
  }) => {
    // Default desktop viewport — ThreadPanel keeps the side-by-side layout.
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const dmResp = await request.post(`${seedState.urls.api}/api/channels/dm`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { userId: seedState.extraHuman.userId },
    });
    expect(dmResp.ok()).toBeTruthy();
    const dm = (await dmResp.json()) as { id: string };

    const parentContent = `DM desktop thread parent ${Date.now()}`;
    const reply = `DM desktop thread reply ${Date.now()}`;

    const parent = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { channelId: dm.id, content: parentContent },
    });
    expect(parent.ok()).toBeTruthy();
    const parentMsg = (await parent.json()) as { id: string };

    const threadResp = await request.post(
      `${seedState.urls.api}/api/channels/${dm.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { parentMessageId: parentMsg.id, content: reply },
      },
    );
    expect(threadResp.ok()).toBeTruthy();

    await page.goto(
      `/s/${seedState.server.slug}/dm/${dm.id}?thread=${dm.id}:${parentMsg.id}`,
    );
    await expect(page.getByTestId("thread-message-scroller")).toBeVisible();

    await page.getByTestId("thread-overflow-trigger").click();
    await page.getByTestId("thread-overflow-view-in-channel").click();

    await expect(page).toHaveURL(
      new RegExp(`/s/${seedState.server.slug}/dm/${dm.id}\\?msg=${parentMsg.id}$`),
    );
  });

  test("desktop: thread panel does not render parent channel context when msg points outside the thread", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const runId = Date.now();
    const parentContent = `Thread scoped parent ${runId}`;
    const reply = `Thread scoped reply ${runId}`;
    const unrelatedChannelMessage = `Thread scoped unrelated channel message ${runId}`;

    const parent = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { channelId: seedState.channel.id, content: parentContent },
    });
    expect(parent.ok()).toBeTruthy();
    const parentMsg = (await parent.json()) as { id: string };

    const threadResp = await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { parentMessageId: parentMsg.id, content: reply },
      },
    );
    expect(threadResp.ok()).toBeTruthy();

    const unrelated = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { channelId: seedState.channel.id, content: unrelatedChannelMessage },
    });
    expect(unrelated.ok()).toBeTruthy();
    const unrelatedMsg = (await unrelated.json()) as { id: string };

    await page.goto(
      `/s/${seedState.server.slug}/channel/${seedState.channel.id}?thread=${seedState.channel.id}:${parentMsg.id}&msg=${unrelatedMsg.id}`,
    );

    const threadScroller = page.getByTestId("thread-message-scroller");
    await expect(threadScroller).toBeVisible({ timeout: 15000 });
    await expect(threadScroller.getByText(reply)).toBeVisible();
    await expect(threadScroller.getByText(unrelatedChannelMessage)).toHaveCount(0);
  });
});
