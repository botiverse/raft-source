import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

declare global {
  interface Window {
    __inlineRepliesColdEntrySamples?: Array<{
      parentPresent: boolean;
      inlineRepliesPresent: boolean;
      scrollTop: number | null;
    }>;
  }
}

test("cold channel entry never paints a thread parent before its inline replies", async ({
  page,
  request,
}) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const runId = Date.now().toString(36);
  const headers = {
    Authorization: `Bearer ${login.accessToken}`,
    "X-Server-Id": seedState.server.id,
  };

  const channelResponse = await request.post(`${seedState.urls.api}/api/channels`, {
    headers,
    data: { name: `inline-cold-${runId}` },
  });
  expect(channelResponse.ok()).toBeTruthy();
  const channel = await channelResponse.json() as { id: string };

  const parentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
    headers,
    data: { channelId: channel.id, content: `inline parent ${runId}` },
  });
  expect(parentResponse.ok()).toBeTruthy();
  const parent = await parentResponse.json() as { id: string };

  for (let index = 0; index < 3; index += 1) {
    const replyResponse = await request.post(
      `${seedState.urls.api}/api/channels/${channel.id}/threads`,
      {
        headers,
        data: {
          parentMessageId: parent.id,
          content: `inline reply ${runId}-${index}`,
        },
      },
    );
    expect(replyResponse.ok()).toBeTruthy();
  }

  await page.addInitScript(({ parentMessageId }) => {
    window.__inlineRepliesColdEntrySamples = [];
    const sample = () => {
      const parentRow = document.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(parentMessageId)}"]`,
      );
      const scroller = document.querySelector<HTMLElement>(
        '[data-testid="message-scroller"]',
      );
      window.__inlineRepliesColdEntrySamples?.push({
        parentPresent: !!parentRow,
        inlineRepliesPresent: !!parentRow?.querySelector(
          '[data-message-affordance="inline-thread-replies"]',
        ),
        scrollTop: scroller?.scrollTop ?? null,
      });
    };
    new MutationObserver(sample).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }, { parentMessageId: parent.id });

  await page.goto(`/s/${seedState.server.slug}/channel/${channel.id}`);
  const parentRow = page.locator(`[data-message-id="${parent.id}"]`).first();
  await expect(parentRow).toBeVisible();
  await expect(
    parentRow.locator('[data-message-affordance="inline-thread-replies"]'),
  ).toContainText(`inline reply ${runId}-2`);

  const samples = await page.evaluate(() => window.__inlineRepliesColdEntrySamples ?? []);
  expect(
    samples.some((sample) => sample.parentPresent && !sample.inlineRepliesPresent),
    "the old two-request path painted the parent first, then grew the reply block and moved scrollTop",
  ).toBeFalsy();
});
