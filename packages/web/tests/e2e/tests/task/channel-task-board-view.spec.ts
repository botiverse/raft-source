import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

// After the channel Tasks tab and the server-wide Tasks page were unified onto
// TasksPanel (PR #1439, #proj-task task #3), the channel-mode panel:
//   - exposes Board/List view toggle (default Board)
//   - shows a +New Task CTA (channel-mode only)
//   - renders 4 status columns in board view (TODO / IN PROGRESS / IN REVIEW / DONE)
//   - drops the per-status filter tabs that the legacy TaskBoard exposed —
//     filtering by status is implicit in the column layout.
test.describe("channel task board view", () => {
  test("channel Tasks tab can switch between list and board views", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const tag = `channel-task-board-${Date.now()}`;
    const createResponse = await request.post(`${seedState.urls.api}/api/tasks/channel/${seedState.channel.id}`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        tasks: [
          { title: `${tag} todo` },
          { title: `${tag} progress` },
          { title: `${tag} done` },
        ],
      },
    });
    expect(createResponse.ok()).toBeTruthy();
    const createBody = await createResponse.json() as { tasks: Array<{ id: string; title: string }> };
    const progressTask = createBody.tasks.find((task) => task.title.endsWith("progress"));
    const doneTask = createBody.tasks.find((task) => task.title.endsWith("done"));
    expect(progressTask).toBeTruthy();
    expect(doneTask).toBeTruthy();

    const claimResponse = await request.patch(`${seedState.urls.api}/api/tasks/${progressTask!.id}/claim`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
    });
    expect(claimResponse.ok()).toBeTruthy();

    const doneResponse = await request.patch(`${seedState.urls.api}/api/tasks/${doneTask!.id}/status`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { status: "done" },
    });
    expect(doneResponse.ok()).toBeTruthy();

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    // LeftRail also exposes a "Tasks" button. Use the channel panel's stable
    // tab id so this test cannot silently open the server-wide Tasks surface.
    await page.getByTestId("panel-tab-tasks").click();

    // TasksPanel mounted in channel mode — the channel-task-panel testid lives
    // on the panel root regardless of view mode.
    await expect(page.getByTestId("channel-task-panel")).toBeVisible();
    await expect(page).toHaveURL(/chatTab=tasks/);

    // Default view is Board.
    await expect(page.getByTestId("channel-task-view-board")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("channel-task-view-list")).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("channel-task-board-view")).toBeVisible();

    // Channel-mode-only CTA.
    await expect(page.getByRole("button", { name: /new task/i }).first()).toBeVisible();

    // All five status columns render in board view (todo / in_progress /
    // in_review / done / closed). The 5th column (Closed = won't-do) was
    // added in the closed-status PR; both terminal columns (Done, Closed)
    // start collapsed.
    await expect(page.getByText("TODO").first()).toBeVisible();
    await expect(page.getByText("IN PROGRESS").first()).toBeVisible();
    await expect(page.getByText("IN REVIEW").first()).toBeVisible();
    await expect(page.getByText("DONE").first()).toBeVisible();
    await expect(page.getByText("CLOSED").first()).toBeVisible();

    // Cards in expanded columns are visible. DONE is collapsed by default
    // (TasksPanel.tsx initial collapsedStatuses.done = true) in BOTH board
    // and list view — that intentional state hides the seeded `done` card
    // until the user explicitly expands DONE. Expand it once to confirm the
    // card renders, then leave the rest of the test on the default state.
    await expect(page.getByText(`${tag} todo`)).toBeVisible();
    await expect(page.getByText(`${tag} progress`)).toBeVisible();
    await page.getByRole("button", { name: /^Show Done$/ }).click();
    await expect(page.getByText(`${tag} done`)).toBeVisible();
    await expect(page.getByTestId("channel-task-board-view").getByTitle("Delete")).toHaveCount(0);

    // Switch to List view — board grid disappears, expanded-column cards
    // remain visible.
    await page.getByTestId("channel-task-view-list").click();
    await expect(page.getByTestId("channel-task-view-list")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("channel-task-view-board")).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("channel-task-board-view")).toHaveCount(0);
    await expect(page.getByText(`${tag} progress`)).toBeVisible();

    // Route changes drop the `view=list` URL param when users switch channels.
    // The explicit List choice should still survive because TasksPanel stores
    // the last user-selected view outside the route.
    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await page.getByTestId("panel-tab-tasks").click();
    await expect(page.getByTestId("channel-task-view-list")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("channel-task-view-board")).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("channel-task-board-view")).toHaveCount(0);

    // Back to Board view.
    await page.getByTestId("channel-task-view-board").click();
    await expect(page.getByTestId("channel-task-view-board")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("channel-task-view-list")).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("channel-task-board-view")).toBeVisible();
  });

  test("dragging an unassigned todo to In Progress claims it and writes the status", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const title = `task-drag-visual-${Date.now()}`;
    const createResponse = await request.post(`${seedState.urls.api}/api/tasks/channel/${seedState.channel.id}`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { tasks: [{ title }] },
    });
    expect(createResponse.ok()).toBeTruthy();
    const createBody = await createResponse.json() as { tasks: Array<{ id: string; title: string }> };
    const task = createBody.tasks[0];
    expect(task).toBeTruthy();

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await page.getByTestId("panel-tab-tasks").click();
    await expect(page.getByTestId("channel-task-board-view")).toBeVisible();

    const board = page.getByTestId("channel-task-board-view");
    const card = board.getByTestId("task-board-draggable-card").filter({ hasText: title }).first();
    const inProgressColumn = board.getByRole("button", { name: /^Hide In Progress$/ }).locator("..");
    await expect(card).toBeVisible();
    const before = await card.boundingBox();
    const target = await inProgressColumn.boundingBox();
    expect(before).toBeTruthy();
    expect(target).toBeTruthy();

    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
    await page.mouse.down();
    const claimResponse = page.waitForResponse((response) => (
      response.request().method() === "PATCH"
      && response.url().endsWith(`/api/tasks/${task!.id}/claim`)
    ));
    await page.mouse.move(target!.x + target!.width / 2, target!.y + 80, { steps: 12 });

    await expect.poll(async () => {
      const box = await card.boundingBox();
      return box ? box.x - before!.x : 0;
    }).toBeGreaterThan(40);

    await page.mouse.up();
    expect((await claimResponse).ok()).toBeTruthy();
    await expect(inProgressColumn.getByTestId("task-board-draggable-card").filter({ hasText: title })).toBeVisible();
  });

  test("message task status badge updates inline without leaving the chat", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const tag = `message-task-status-${Date.now()}`;
    const createResponse = await request.post(`${seedState.urls.api}/api/tasks/channel/${seedState.channel.id}`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        tasks: [{ title: `${tag} progress` }],
      },
    });
    expect(createResponse.ok()).toBeTruthy();
    // `id` addresses the task, `messageId` addresses its host message. Task
    // v1.4 made these different values: a task is now a `tasks` row associated
    // with a chat message, not the message itself. Mutations take `id`; the
    // chat DOM node is keyed on the message, so it takes `messageId`.
    const createBody = await createResponse.json() as {
      tasks: Array<{ id: string; messageId: string; title: string }>;
    };
    const task = createBody.tasks[0];
    expect(task).toBeTruthy();
    expect(task.messageId).toBeTruthy();

    const claimResponse = await request.patch(`${seedState.urls.api}/api/tasks/${task.id}/claim`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
    });
    expect(claimResponse.ok()).toBeTruthy();

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();

    const message = page.locator(`#message-${task.messageId}`).first();
    const badge = message.locator('[data-testid="message-task-badge"]');
    await expect(badge).toHaveAttribute("data-task-status", "in_progress");

    // Since #6244 the badge opens the task modal rather than an inline status
    // menu, so the status edit happens in the task's own properties. The
    // invariant this test exists for is unchanged and is asserted below: acting
    // on a task from a MESSAGE must not navigate you into the Tasks tab.
    await badge.click();
    await expect(page.getByTestId("task-thread-modal")).toBeVisible();
    const properties = page.getByTestId("task-properties");
    const propertyItems = properties.locator('[data-slot="description-item"]');
    await expect(propertyItems).toHaveCount(3);
    await expect.poll(async () => {
      const boxes = await propertyItems.evaluateAll((items) => items.map((item) => {
        const { left, top, height } = item.getBoundingClientRect();
        return { left, centerY: top + height / 2 };
      }));
      const centerYs = boxes.map(({ centerY }) => centerY);
      const orderedLeftToRight = boxes.every((box, index) => (
        index === 0 || box.left > boxes[index - 1]!.left
      ));
      return {
        centerDrift: Math.max(...centerYs) - Math.min(...centerYs),
        orderedLeftToRight,
      };
    }).toEqual({ centerDrift: 0, orderedLeftToRight: true });
    await page.getByTestId("task-properties-status").click();
    await page.getByTestId("task-properties-status-option-done").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-thread-modal")).toBeHidden();

    await expect(badge).toHaveAttribute("data-task-status", "done");
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await expect(page.getByTestId("channel-task-panel")).toHaveCount(0);
    await expect(page).not.toHaveURL(/chatTab=tasks/);
  });
});
