import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

// Repro: task #141 (#proj-uiux:c697be7a 2026-05-08 stdrc).
//
//   "在 channel 的 tasks tab，点开 task thread panel 之后，
//    在主面板切换 task 状态，thread panel 的状态 badge 没有及时更新"
//
// PR #1037 (e4fa2df5b) added the ThreadPanel ↔ taskStore subscription that
// keeps the parent badge in sync with mark-as-done from the THREAD HEADER.
// PR #1439 (62c507cb) unified the channel Task tab with TasksPanel and added
// inline status editing on TaskCard / TaskItem in the MAIN panel. The bug
// reported in #141 is that those main-panel status edits do NOT propagate
// to the thread panel header badge until a page refresh.
/**
 * Open the side thread panel for the message that hosts `tag`.
 *
 * Before #6244 these tests clicked the task title on the main panel, which
 * opened the side thread. That entry now opens the centered task modal, so
 * `thread-panel-parent` never appears and all three arms went deterministically
 * RED without the invariant they guard having changed at all (@skyzh triage,
 * heads 80575141d + bbcca532).
 *
 * Takes the host message ID from the create response. An earlier revision
 * matched on title text; see the note at the locator below for why that was
 * replaced and, importantly, for what it did NOT cause.
 */
async function openSideThreadFromHostMessage(
  page: import("@playwright/test").Page,
  channelId: string,
  hostMessageId: string,
) {
  await page.getByTestId("panel-tab-chat").click();
  await expect(page.getByTestId("message-scroller")).toBeVisible();
  // STABLE IDENTITY — net hardening, NOT the cause of any known failure.
  // Matching on title text is ambiguous by construction (creating a task also
  // posts a system message repeating the title), so this addresses the message
  // the create response named.
  // ⚠️ It did NOT cause the `37c492b0` e2e (2) RED, and must not be credited
  // with fixing it: the Hosted artifact shows the create response gave
  // messageId 7e1427a1… and the 404ing lookup was `/threads/7e1427a1…` — the
  // SAME id. The right message was opened. (@skyzh independently read the same
  // artifact and reached the same conclusion.)
  const hostMessage = page.locator(`#message-${hostMessageId}`).first();
  await hostMessage.scrollIntoViewIfNeeded();
  await hostMessage.hover();
  await hostMessage.getByLabel("Reply in thread").click();

  const expectedThreadParam = `${channelId}:${hostMessageId}`;
  await expect.poll(
    () => new URL(page.url()).searchParams.get("thread"),
    { message: "opening the side thread must commit its URL identity" },
  ).toBe(expectedThreadParam);

  // PRECONDITION CONTRACT — prove the thread actually opened before testing
  // anything that depends on it. Opening a thread is an API round-trip, and the
  // Hosted trace for `37c492b0` shows this helper clicking "Reply in thread" at
  // 40136.5 and navigating at 40335.2 — 199ms later, with the open still in
  // flight. Whatever the eventual cause, a failure to open should fail HERE by
  // name, not surface later as a confusing assertion about a status badge.
  await expect(page.locator('[data-testid="thread-panel-parent"]')).toBeVisible();

  // Back to the Tasks tab: the status edit under test happens on the main-panel
  // card, and the side thread stays open across the tab switch — which is
  // precisely the cross-surface sync this test asserts.
  await page.getByTestId("panel-tab-tasks").click();
  await expect.poll(
    () => new URL(page.url()).searchParams.get("thread"),
    { message: "switching main-panel tabs must preserve the open side thread" },
  ).toBe(expectedThreadParam);
  await expect(page.getByTestId("channel-task-panel")).toBeVisible();
}

test.describe("P0 thread task status sync from main panel", () => {
  test("BOARD view: changing task status from channel Tasks tab updates thread badge without refresh", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const tag = `task-141-repro-${Date.now()}`;

    const createResponse = await request.post(
      `${seedState.urls.api}/api/tasks/channel/${seedState.channel.id}`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { tasks: [{ title: tag }] },
      },
    );
    expect(createResponse.ok()).toBeTruthy();
    const createBody = await createResponse.json() as {
      tasks: Array<{ id: string; messageId: string; title: string }>;
    };
    const task = createBody.tasks[0];
    const hostMessageId = task.messageId;
    expect(hostMessageId, "create response must carry the host message id").toBeTruthy();
    expect(task).toBeTruthy();

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();

    // Switch to the channel Tasks tab.
    // LeftRail also exposes a server-wide Tasks button. Target the channel
    // panel tab explicitly so the status-sync assertion exercises its subject.
    await page.getByTestId("panel-tab-tasks").click();
    await expect(page.getByTestId("channel-task-panel")).toBeVisible();

    // Find the TaskCard subtree for our task (board view).
    // Locate the unique TaskCard via a locator that walks up from the title
    // text to the card's bordered container (TaskCard.tsx wraps in a
    // `.shadow-brutal-sm` div). `.first()` on a bare `hasText` filter would
    // match any ancestor and trip strict mode when prior tests pollute the
    // DB with same-channel tasks.
    const taskTitle = page.getByTestId("channel-task-panel").getByText(tag, { exact: true });
    const taskCard = taskTitle.locator("xpath=ancestor::div[contains(@class, 'shadow-brutal-sm')][1]");
    await expect(taskCard).toBeVisible();

    // Open the side thread from the HOST MESSAGE, not the task title.
    // Since #6244 a task title/badge opens the centered task modal; the
    // message's thread icon is what still opens the side panel, and the side
    // panel's parent badge is the surface whose staleness this test exists for.
    await openSideThreadFromHostMessage(page, seedState.channel.id, hostMessageId);

    const threadParent = page.locator('[data-testid="thread-panel-parent"]');
    await expect(threadParent).toBeVisible();

    const threadBadge = threadParent.locator('[data-testid="message-task-badge"]');
    await expect(threadBadge).toHaveAttribute("data-task-status", "todo");

    // Change status from the MAIN panel TaskCard's inline status pill.
    // STATUS_STYLES.todo.label is "Todo" (Title Case) — the InlineBadgeEditor
    // button shows that text. Status badges sit next to case-sensitive
    // identifiers (`@assignee`) so they opt out of the brutal uppercase
    // transform — stdrc msg=ce25da45 + msg=65681d15 (option B). Click it to
    // open the dropdown, then pick the "In Progress" option (matches
    // STATUS_LABELS).
    await taskCard.getByRole("button", { name: /Todo/ }).click();
    await page.getByTestId("task-status-option-in_progress").click();

    // Bug: thread panel parent badge stays "todo" until a page refresh.
    // Pre-fix this assertion fails. Post-fix it passes.
    await expect(threadBadge).toHaveAttribute("data-task-status", "in_progress");
  });

  test("LIST view: changing task status from channel Tasks tab updates thread badge without refresh", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const tag = `task-141-repro-list-${Date.now()}`;

    const createResponse = await request.post(
      `${seedState.urls.api}/api/tasks/channel/${seedState.channel.id}`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { tasks: [{ title: tag }] },
      },
    );
    expect(createResponse.ok()).toBeTruthy();
    const createBody = await createResponse.json() as { tasks: Array<{ messageId: string }> };
    const hostMessageId = createBody.tasks[0]?.messageId;
    expect(hostMessageId, "create response must carry the host message id").toBeTruthy();

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await page.getByTestId("panel-tab-tasks").click();
    await expect(page.getByTestId("channel-task-panel")).toBeVisible();

    // Switch to LIST view.
    await page.getByTestId("channel-task-view-list").click();

    const taskTitle = page.getByTestId("channel-task-panel").getByText(tag, { exact: true });
    const taskCard = taskTitle.locator("xpath=ancestor::div[contains(@class, 'shadow-brutal-sm')][1]");
    await expect(taskCard).toBeVisible();

    // Open the side thread from the HOST MESSAGE, not the task title.
    // Since #6244 a task title/badge opens the centered task modal; the
    // message's thread icon is what still opens the side panel, and the side
    // panel's parent badge is the surface whose staleness this test exists for.
    await openSideThreadFromHostMessage(page, seedState.channel.id, hostMessageId);

    // REDUNDANT STATE WRITE REMOVED — causality unproven. The view was already
    // selected above and `writeStoredTaskViewMode` persists it across the
    // chat->tasks remount, so re-clicking achieved nothing while still issuing
    // a URL write: `setView` rebuilds the query string from that render's
    // `searchParams` and calls `setSearchParams(..., {replace:true})`.
    // ⚠️ The Hosted trace places that click before the panel was absent; it does
    // NOT show it causing the absence. Dropping a pointless state write next to
    // an in-flight navigation is worth doing on its own terms.
    // Asserting board's container is absent also stops this arm silently
    // degenerating into a duplicate of BOARD.
    await expect(page.getByTestId("channel-task-board-view")).toHaveCount(0);

    const threadParent = page.locator('[data-testid="thread-panel-parent"]');
    await expect(threadParent).toBeVisible();
    const threadBadge = threadParent.locator('[data-testid="message-task-badge"]');
    await expect(threadBadge).toHaveAttribute("data-task-status", "todo");

    await taskCard.getByRole("button", { name: /Todo/ }).click();
    await page.getByTestId("task-status-option-in_progress").click();

    await expect(threadBadge).toHaveAttribute("data-task-status", "in_progress");
  });

  test("CLOSED status: changing task status to closed updates thread badge without refresh", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const tag = `task-141-repro-closed-${Date.now()}`;

    const createResponse = await request.post(
      `${seedState.urls.api}/api/tasks/channel/${seedState.channel.id}`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { tasks: [{ title: tag }] },
      },
    );
    expect(createResponse.ok()).toBeTruthy();
    const createBody = await createResponse.json() as { tasks: Array<{ messageId: string }> };
    const hostMessageId = createBody.tasks[0]?.messageId;
    expect(hostMessageId, "create response must carry the host message id").toBeTruthy();

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await page.getByTestId("panel-tab-tasks").click();
    await expect(page.getByTestId("channel-task-panel")).toBeVisible();

    const taskTitle = page.getByTestId("channel-task-panel").getByText(tag, { exact: true });
    const taskCard = taskTitle.locator("xpath=ancestor::div[contains(@class, 'shadow-brutal-sm')][1]");
    await expect(taskCard).toBeVisible();
    await openSideThreadFromHostMessage(page, seedState.channel.id, hostMessageId);

    const threadParent = page.locator('[data-testid="thread-panel-parent"]');
    await expect(threadParent).toBeVisible();
    const threadBadge = threadParent.locator('[data-testid="message-task-badge"]');
    await expect(threadBadge).toHaveAttribute("data-task-status", "todo");

    // todo → closed. After the fix, the below-content variant must include
    // a `closed` config; pre-fix the variant fell back to statusConfig.todo,
    // so the badge stayed visually orange/Circle even though the
    // data-task-status attribute correctly read "closed".
    await taskCard.getByRole("button", { name: /Todo/ }).click();
    await page.getByTestId("task-status-option-closed").click();

    await expect(threadBadge).toHaveAttribute("data-task-status", "closed");
    // Visual sanity: the badge background must change away from the "todo"
    // orange. The exact background color is owned by Bugen (#proj-uiux task
    // #145 — CLOSED neutral color). Here we just verify the badge is no
    // longer using the todo orange — i.e. the variant has a real entry for
    // "closed" rather than silently falling through to statusConfig.todo.
    await expect(threadBadge).not.toHaveClass(/bg-brutal-orange/);
  });
});
