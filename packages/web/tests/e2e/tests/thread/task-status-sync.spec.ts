import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

test.describe("P0 thread task status sync", () => {
  test("mark-as-done from the thread header updates the parent status badge without refresh", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const parentContent = `P0 thread task parent ${Date.now()}`;

    const parentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        channelId: seedState.channel.id,
        content: parentContent,
      },
    });
    expect(parentResponse.ok()).toBeTruthy();
    const parentMessage = await parentResponse.json() as { id: string };

    const convertResponse = await request.post(`${seedState.urls.api}/api/tasks/convert-message`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { messageId: parentMessage.id },
    });
    expect(convertResponse.ok()).toBeTruthy();

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);

    const parentMessageCard = page.locator(`#message-${parentMessage.id}`).first();
    await parentMessageCard.scrollIntoViewIfNeeded();
    await expect(parentMessageCard).toBeVisible();
    await parentMessageCard.hover();
    await parentMessageCard.getByLabel("Reply in thread").click();

    const threadParent = page.locator('[data-testid="thread-panel-parent"]');
    await expect(threadParent).toBeVisible();

    const threadBadge = threadParent.locator('[data-testid="message-task-badge"]');
    await expect(threadBadge).toHaveAttribute("data-task-status", "todo");

    // NEW CONTRACT (#6244): the badge is a reference — it identifies the task
    // and OPENS it. It is no longer an inline status editor, so
    // `message-task-status-menu` does not exist any more. Pin the new shape so
    // this entry point is still guarded, then close the modal again.
    await threadBadge.click();
    await expect(page.getByTestId("task-thread-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-thread-modal")).toBeHidden();

    // Re-open the side thread from the message — the thread icon still opens
    // the panel, which is the surface whose staleness this test exists for.
    await parentMessageCard.hover();
    await parentMessageCard.getByLabel("Reply in thread").click();
    await expect(threadParent).toBeVisible();

    // Drive the status change from the MAIN panel instead of the badge. The
    // invariant under test never was "the badge can edit status" — it is that
    // the thread panel's parent badge reflects a change made elsewhere WITHOUT
    // a refresh (the ThreadPanel ↔ taskStore subscription from PR #1037).
    await page.getByTestId("panel-tab-tasks").click();
    await expect(page.getByTestId("channel-task-panel")).toBeVisible();
    const taskTitle = page.getByTestId("channel-task-panel").getByText(parentContent, { exact: true });
    const taskCard = taskTitle.locator("xpath=ancestor::div[contains(@class, 'shadow-brutal-sm')][1]");
    await expect(taskCard).toBeVisible();
    await taskCard.getByRole("button", { name: /Todo/ }).click();
    await page.getByTestId("task-status-option-done").click();

    // The bug was: thread panel's parent badge stayed stale at "todo" until a
    // hard refresh. This assertion fails before the ThreadPanel ↔ taskStore
    // subscription fix; it passes after.
    await expect(threadBadge).toHaveAttribute("data-task-status", "done");
  });
});
