import { expect, test } from "@playwright/test";
import { seedAgentMessages } from "../../fixtures/agentMessage";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";
import { seedSparseAnchorReplies } from "../../fixtures/sparseAnchorReplies";

// Regression test for #67 (cindyz f84d85ec): a thread with one reply was
// rendering the reply pushed against the very bottom of the panel, leaving a
// large empty gap below the "Beginning of replies / 1 reply" divider. The
// MessageTimeline primitive previously applied a flex-grow spacer above the
// messages unconditionally; the spacer is correct for channels (push sparse
// content flush to the input bar) but wrong for threads, where the divider
// sits at the top and replies must stack downward from it.
//
// This test pins the contract by measuring that the first reply's TOP edge is
// near the TOP of the thread scroller — not the bottom.

test.describe("thread sparse-anchor", () => {
  test("single reply sits near the top of the thread scroller, not the bottom", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const parentContent = `thread sparse parent ${Date.now()}`;
    const replyContent = `thread sparse reply ${Date.now()}`;

    const parentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { channelId: seedState.channel.id, content: parentContent },
    });
    expect(parentResponse.ok()).toBeTruthy();
    const parentMessage = (await parentResponse.json()) as { id: string };

    const threadResponse = await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { parentMessageId: parentMessage.id, content: replyContent },
      },
    );
    expect(threadResponse.ok()).toBeTruthy();

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);

    const parentMessageCard = page.locator(`#message-${parentMessage.id}`);
    await parentMessageCard.scrollIntoViewIfNeeded();
    await parentMessageCard.hover();
    await parentMessageCard.getByLabel("Reply in thread").click();

    const threadScroller = page.getByTestId("thread-message-scroller");
    await expect(threadScroller).toBeVisible();
    await expect(threadScroller.getByText(replyContent)).toBeVisible();

    // Measure the gap between the reply's top edge and the scroller's top
    // edge. With sparseAnchor="top" (thread default), the reply should sit
    // right under the "Beginning of replies" divider, not flush at the
    // bottom. A value near the divider height indicates correct placement;
    // a value near scroller.height would indicate the broken bottom-anchor.
    await expect
      .poll(
        async () => {
          return threadScroller.evaluate((el) => {
            const items = Array.from(el.querySelectorAll("[data-index]"));
            const first = items[0] as HTMLElement | undefined;
            if (!first) return null;
            const scrollerRect = el.getBoundingClientRect();
            const firstRect = first.getBoundingClientRect();
            return {
              topGap: Math.round(firstRect.top - scrollerRect.top),
              scrollerHeight: Math.round(scrollerRect.height),
            };
          });
        },
        { timeout: 5000 },
      )
      .toMatchObject({ topGap: expect.any(Number) });

    const measurement = await threadScroller.evaluate((el) => {
      const items = Array.from(el.querySelectorAll("[data-index]"));
      const first = items[0] as HTMLElement;
      const scrollerRect = el.getBoundingClientRect();
      const firstRect = first.getBoundingClientRect();
      return {
        topGap: Math.round(firstRect.top - scrollerRect.top),
        scrollerHeight: Math.round(scrollerRect.height),
      };
    });

    // The reply should sit in the upper portion of the scroller. A loose
    // bound (< 50% of scroller height) is enough to catch the regression
    // where the reply was floating right above the input bar.
    expect(measurement.topGap).toBeLessThan(measurement.scrollerHeight / 2);
  });

  test("scrolling to the beginning loads older replies without a manual button", async ({
    context,
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
    const suffix = Date.now();
    const parentContent = `thread infinite parent ${suffix}`;
    const humanReplyPrefix = `thread human reply ${suffix}`;
    const agentReplyPrefix = `thread agent reply ${suffix}`;

    const parentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
      headers,
      data: { channelId: seedState.channel.id, content: parentContent },
    });
    expect(parentResponse.ok()).toBeTruthy();
    const parentMessage = (await parentResponse.json()) as { id: string };

    const humanReplyContents = Array.from(
      { length: 100 },
      (_, index) => `${humanReplyPrefix} ${index.toString().padStart(2, "0")}`,
    );
    let activeHumanReplyWrites = 0;
    let peakHumanReplyWrites = 0;
    const postHumanReply = async (content: string) => {
      activeHumanReplyWrites += 1;
      peakHumanReplyWrites = Math.max(peakHumanReplyWrites, activeHumanReplyWrites);
      try {
        const replyResponse = await request.post(
          `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
          {
            headers,
            data: {
              parentMessageId: parentMessage.id,
              content,
            },
          },
        );
        expect(replyResponse.ok()).toBeTruthy();
        return content;
      } finally {
        activeHumanReplyWrites -= 1;
      }
    };

    const seededHumanReplyContents = await seedSparseAnchorReplies(
      humanReplyContents,
      postHumanReply,
    );
    expect(seededHumanReplyContents).toEqual(humanReplyContents);
    expect(peakHumanReplyWrites).toBe(10);

    const agentReplyContents = Array.from(
      { length: 3 },
      (_, index) => `${agentReplyPrefix} ${index.toString().padStart(2, "0")}`,
    );
    await seedAgentMessages(
      seedState,
      seedState.agent.id,
      login.accessToken,
      `#${seedState.channel.name}:${parentMessage.id.slice(0, 8)}`,
      agentReplyContents,
    );

    let resumeResponseObserved = false;
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const frame = typeof payload === "string" ? payload : payload.toString();
        if (frame.includes('"sync:resume:response"')) resumeResponseObserved = true;
      });
    });

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    const parentMessageCard = page.locator(`#message-${parentMessage.id}`);
    await parentMessageCard.scrollIntoViewIfNeeded();
    await parentMessageCard.hover();
    await parentMessageCard.getByLabel("Reply in thread").click();

    const threadScroller = page.getByTestId("thread-message-scroller");
    const oldestReply = threadScroller.getByText(seededHumanReplyContents[0]!);
    const humanReplies = threadScroller.getByText(new RegExp(`^${humanReplyPrefix} \\d{2}$`));
    for (const agentReplyContent of agentReplyContents) {
      await expect(threadScroller.getByText(agentReplyContent)).toBeVisible();
    }
    await expect(humanReplies).toHaveCount(47);

    // Force a real disconnect/reconnect after the initial HTTP window. The
    // parent-channel load owns the global lastSeq, so sync:resume replays all
    // 103 later thread replies; that replay must not silently bypass the
    // latest-50 pagination boundary.
    await context.setOffline(true);
    await page.waitForTimeout(500);
    await context.setOffline(false);
    await expect.poll(() => resumeResponseObserved, { timeout: 20_000 }).toBe(true);
    await expect(page.getByText("50 replies", { exact: true })).toBeVisible();
    await expect(oldestReply).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Load Older replies/i })).toHaveCount(0);

    const scrollToTopAndWaitForOlderPage = async () => {
      const olderPage = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "GET"
          && url.pathname.includes("/api/messages/channel/")
          && url.searchParams.has("before");
      });
      await threadScroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      expect((await olderPage).ok()).toBeTruthy();
    };

    await scrollToTopAndWaitForOlderPage();

    // 103 replies require two older pages after the latest 50. The first
    // prepend must preserve the viewport anchor and still leave the oldest
    // three human-authored replies unloaded.
    await expect(humanReplies).toHaveCount(97);
    await expect(oldestReply).toHaveCount(0);
    await expect
      .poll(() => threadScroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    await scrollToTopAndWaitForOlderPage();
    await expect(oldestReply).toHaveCount(1);
    await expect(humanReplies).toHaveCount(100);

    await threadScroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(oldestReply).toBeVisible();
    await expect(threadScroller.getByText("Beginning of replies")).toBeVisible();
  });

  test("clicking the thread title once loads every older page before jumping to the parent", async ({
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
    const suffix = Date.now();
    const parentContent = `thread top jump parent ${suffix}`;
    const replyPrefix = `thread top jump reply ${suffix}`;

    const parentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
      headers,
      data: { channelId: seedState.channel.id, content: parentContent },
    });
    expect(parentResponse.ok()).toBeTruthy();
    const parentMessage = (await parentResponse.json()) as { id: string };

    for (let index = 0; index < 125; index += 1) {
      const replyResponse = await request.post(
        `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
        {
          headers,
          data: {
            parentMessageId: parentMessage.id,
            content: `${replyPrefix} ${index.toString().padStart(3, "0")}`,
          },
        },
      );
      expect(replyResponse.ok()).toBeTruthy();
    }

    let olderPageResponses = 0;
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (
        response.request().method() === "GET"
        && url.pathname.includes("/api/messages/channel/")
        && url.searchParams.has("before")
      ) {
        olderPageResponses += 1;
      }
    });

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    const parentMessageCard = page.locator(`#message-${parentMessage.id}`);
    await parentMessageCard.scrollIntoViewIfNeeded();
    await parentMessageCard.hover();
    await parentMessageCard.getByLabel("Reply in thread").click();

    const threadScroller = page.getByTestId("thread-message-scroller");
    await expect(threadScroller.getByText(`${replyPrefix} 124`)).toBeVisible();
    await expect(threadScroller.getByText(`${replyPrefix} 000`)).toHaveCount(0);

    await page.getByTestId("thread-scroll-to-top").click();

    await expect(threadScroller.getByText(parentContent)).toBeVisible();
    await expect(threadScroller.getByText(`${replyPrefix} 000`)).toBeVisible();
    await expect(threadScroller.getByText("Beginning of replies")).toBeVisible();
    await expect
      .poll(() => olderPageResponses, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2);
  });
});
