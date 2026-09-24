import { expect, test } from "@playwright/test";
import { seedAgentMessages } from "../../fixtures/agentMessage";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

test.describe("thread view-in-channel profile close", () => {
  test("closing a profile after View in channel does not pollute thread replies with channel context", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const parentContent = `Thread profile parent ${Date.now()}`;
    const firstReply = `Thread profile first reply ${Date.now()}`;
    const agentReply = `Thread profile agent reply ${Date.now()}`;
    const channelAgentReply = `Channel profile agent reply ${Date.now()}`;
    const channelFollowup = `Channel follow-up after view-in-channel ${Date.now()}`;
    const secondParentContent = `Second channel thread parent ${Date.now()}`;
    const secondThreadReply = `Second channel thread reply ${Date.now()}`;

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
    const parentMessage = (await parentResponse.json()) as { id: string };

    const threadResponse = await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: {
          parentMessageId: parentMessage.id,
          content: firstReply,
        },
      },
    );
    expect(threadResponse.ok()).toBeTruthy();

    await seedAgentMessages(
      seedState,
      seedState.agent.id,
      login.accessToken,
      `#${seedState.channel.name}:${parentMessage.id.slice(0, 8)}`,
      [agentReply],
    );
    await seedAgentMessages(
      seedState,
      seedState.agent.id,
      login.accessToken,
      `#${seedState.channel.name}`,
      [channelAgentReply],
    );

    const followResponse = await request.post(`${seedState.urls.api}/api/channels/threads/follow`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { parentMessageId: parentMessage.id },
    });
    expect(followResponse.ok()).toBeTruthy();

    const channelFollowupResponse = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        channelId: seedState.channel.id,
        content: channelFollowup,
      },
    });
    expect(channelFollowupResponse.ok()).toBeTruthy();

    const secondParentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        channelId: seedState.channel.id,
        content: secondParentContent,
      },
    });
    expect(secondParentResponse.ok()).toBeTruthy();
    const secondParentMessage = (await secondParentResponse.json()) as { id: string };
    const secondThreadResponse = await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: {
          parentMessageId: secondParentMessage.id,
          content: secondThreadReply,
        },
      },
    );
    expect(secondThreadResponse.ok()).toBeTruthy();

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);

    const parentMessageCard = page.locator(`#message-${parentMessage.id}`).first();
    await parentMessageCard.scrollIntoViewIfNeeded();
    await expect(parentMessageCard).toBeVisible();
    await parentMessageCard.hover();
    await parentMessageCard.getByLabel("Reply in thread").click();

    const threadPanel = page.getByTestId("thread-message-scroller");
    await expect(threadPanel).toBeVisible();
    await expect(threadPanel.getByText(firstReply)).toBeVisible();
    await expect(threadPanel.getByText(channelFollowup)).toHaveCount(0);

    await page.getByRole("button", { name: "View in channel" }).click();
    await expect(page).toHaveURL(new RegExp(`msg=${parentMessage.id}`));
    await expect(page.getByTestId("thread-message-scroller")).toHaveCount(0);

    await parentMessageCard.hover();
    await parentMessageCard.getByLabel("Reply in thread").click();
    const threadParent = page.locator('[data-testid="thread-panel-parent"]');
    await expect(threadParent).toBeVisible();

    // With Channel + Thread both open, a profile opened from a Channel avatar
    // folds only Thread. The channel surface remains mounted and the shell
    // columns stay inside the viewport.
    const channelAgentBody = page.getByTestId("thread-main-column").locator('[data-message-id]', { hasText: channelAgentReply }).first();
    await channelAgentBody.scrollIntoViewIfNeeded();
    await expect(channelAgentBody).toBeVisible();
    await channelAgentBody.locator('button[data-avatar-kind="agent"]').click();
    const channelProfile = page.getByTestId("profile-panel");
    await expect(channelProfile).toBeVisible();
    const channelProfileLayout = await page.getByTestId("thread-layout-container").evaluate((container) => {
      const channel = container.firstElementChild as HTMLElement | null;
      const thread = container.querySelector<HTMLElement>('[data-testid="thread-side-column"]');
      const profile = container.querySelector<HTMLElement>('[data-testid="profile-panel"]');
      if (!channel || !thread || !profile) throw new Error("Channel, Thread, and Profile must all be mounted");
      const profileRect = profile.getBoundingClientRect();
      return {
        channelDisplay: getComputedStyle(channel).display,
        threadDisplay: getComputedStyle(thread).display,
        profileSource: container.querySelector<HTMLElement>('[data-testid="thread-profile-side-column"]')?.dataset.collapseChannel,
        profilePosition: getComputedStyle(profile).position,
        profileX: Math.round(profileRect.x),
        profileRight: Math.round(profileRect.right),
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    expect(channelProfileLayout.channelDisplay).toBe("flex");
    expect(channelProfileLayout.threadDisplay).toBe("none");
    expect(channelProfileLayout.profilePosition).toBe("relative");
    expect(channelProfileLayout.profileX).toBeGreaterThanOrEqual(0);
    expect(channelProfileLayout.profileRight).toBeLessThanOrEqual(channelProfileLayout.viewportWidth);
    await page.getByTestId("thread-side-column").evaluate((thread) => {
      const retained = thread as HTMLElement;
      retained.dataset.qaChannelOriginThread = "true";
    });
    await channelProfile.getByTitle("Close").click();
    await expect(page.getByTestId("thread-side-column")).toBeVisible();
    await expect(page.getByTestId("thread-layout-container").locator('[data-testid="thread-side-column"][data-qa-channel-origin-thread="true"]')).toHaveCount(1);

    // The Thread avatar takes the opposite branch: Channel folds, while
    // Thread + Profile remain side-by-side and close restores both panes.
    const agentReplyBody = threadPanel.locator('[data-message-id]', { hasText: agentReply }).first();
    await expect(agentReplyBody).toBeVisible();
    const agentAvatar = threadPanel.locator('button[data-avatar-kind="agent"]');
    await expect(agentAvatar).toHaveCount(1);
    await agentAvatar.click();

    const profilePanel = page.getByTestId("profile-panel");
    await expect(profilePanel).toBeVisible();

    // Preserve the actual Thread DOM node and its scroll position through the
    // reversible Profile overlay.  The node identity is assigned in-page so a
    // React remount cannot satisfy this check by merely recreating equivalent
    // markup.
    const threadStateBeforeProfile = await threadPanel.evaluate((thread) => {
      const retained = thread as HTMLElement;
      const pageWindow = window as typeof window & { __qaRetainedThread?: HTMLElement };
      pageWindow.__qaRetainedThread = retained;
      retained.scrollTop = Math.min(24, retained.scrollHeight);
      return { scrollTop: retained.scrollTop, scrollHeight: retained.scrollHeight };
    });

    // This is the screenshot contract in the real browser: opening Profile
    // from an ordinary three-column Channel + Thread view folds only Channel,
    // then lays the retained Thread and Profile panes out side-by-side on a
    // wide desktop.  Read computed styles from mounted production DOM so a
    // selector/data-marker-only test cannot report green when the CSS rule is
    // accidentally widened, removed, or changed to a non-layout declaration.
    await page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>('[data-testid="thread-side-column"]');
      if (!thread) throw new Error("thread side column is not mounted");
      thread.dataset.qaRetainedThread = "true";
    });
    const layout = await page.getByTestId("thread-layout-container").evaluate((container) => {
      const channel = container.firstElementChild as HTMLElement | null;
      const thread = container.querySelector<HTMLElement>('[data-testid="thread-side-column"]');
      const profile = container.querySelector<HTMLElement>('[data-testid="profile-panel"]');
      if (!channel || !thread || !profile) throw new Error("Channel, Thread, and Profile must all be mounted");
      const threadStyle = getComputedStyle(thread);
      const profileStyle = getComputedStyle(profile);
      return {
        channelDisplay: getComputedStyle(channel).display,
        threadPosition: threadStyle.position,
        threadFlex: threadStyle.flex,
        threadBorderRight: threadStyle.borderRightStyle,
        profilePosition: profileStyle.position,
        threadBox: (() => {
          const rect = thread.getBoundingClientRect();
          return { x: Math.round(rect.x), right: Math.round(rect.right), width: Math.round(rect.width) };
        })(),
        profileBox: (() => {
          const rect = profile.getBoundingClientRect();
          return { x: Math.round(rect.x), right: Math.round(rect.right), width: Math.round(rect.width) };
        })(),
      };
    });
    expect(layout.channelDisplay).toBe("none");
    expect(layout.threadPosition).toBe("relative");
    expect(layout.threadFlex).toBe("1 1 auto");
    expect(layout.threadBorderRight).toBe("solid");
    expect(layout.profilePosition).toBe("relative");
    expect(layout.threadBox.width).toBeGreaterThan(0);
    expect(layout.profileBox.width).toBeGreaterThan(0);
    expect(layout.threadBox.right).toBeLessThanOrEqual(layout.profileBox.x + 1);
    await expect(page.getByPlaceholder(`Message #${seedState.channel.name}`)).not.toBeVisible();

    // Profile tabs are a nested navigation surface.  Their scroll/width work
    // must stay inside the profile pane: the outer rail and channel sidebar
    // remain mounted and inside the viewport while Activity/Chat swap.
    const shellLayout = async () => page.evaluate(() => {
      const viewportWidth = document.documentElement.clientWidth;
      const read = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`${selector} is not mounted`);
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: Math.round(rect.x),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          display: style.display,
        };
      };
      return {
        viewportWidth,
        rail: read('[data-testid="workspace-left-rail"]'),
        sidebar: read('[data-testid="sidebar-root"]'),
        thread: read('[data-testid="thread-side-column"]'),
        profile: read('[data-testid="profile-panel"]'),
      };
    });
    const assertShellLayout = async () => {
      const shell = await shellLayout();
      expect(shell.rail.display).toBe("flex");
      expect(shell.rail.width).toBeGreaterThan(0);
      expect(shell.rail.x).toBeGreaterThanOrEqual(0);
      expect(shell.rail.right).toBeLessThanOrEqual(shell.viewportWidth);
      expect(shell.sidebar.display).toBe("flex");
      expect(shell.sidebar.width).toBeGreaterThan(0);
      expect(shell.sidebar.x).toBeGreaterThanOrEqual(0);
      expect(shell.sidebar.right).toBeLessThanOrEqual(shell.viewportWidth);
      expect(shell.thread.width).toBeGreaterThan(0);
      expect(shell.profile.width).toBeGreaterThan(0);
      expect(shell.thread.x).toBeGreaterThanOrEqual(0);
      expect(shell.thread.right).toBeLessThanOrEqual(shell.viewportWidth);
      expect(shell.profile.x).toBeGreaterThanOrEqual(0);
      expect(shell.profile.right).toBeLessThanOrEqual(shell.viewportWidth);
    };
    await assertShellLayout();

    for (const tabId of ["activity", "chat", "profile"] as const) {
      await profilePanel.getByTestId(`panel-tab-${tabId}`).click();
      await expect(profilePanel.getByTestId(`panel-tab-${tabId}`)).toBeVisible();
      await assertShellLayout();
      await expect(page.getByTestId("thread-side-column")).toHaveCount(1);
      await expect(page.getByTestId("profile-panel")).toHaveCount(1);
    }

    await page.keyboard.press("Escape");

    await expect(threadPanel.getByText(firstReply)).toBeVisible();
    await expect(threadPanel.getByText(channelFollowup)).toHaveCount(0);
    await expect(page.getByTestId("thread-layout-container").locator('[data-testid="thread-side-column"][data-qa-retained-thread="true"]')).toHaveCount(1);
    await expect(page.getByPlaceholder(`Message #${seedState.channel.name}`)).toBeVisible();

    const restoredLayout = await page.getByTestId("thread-layout-container").evaluate((container) => {
      const channel = container.firstElementChild as HTMLElement | null;
      const thread = container.querySelector<HTMLElement>('[data-testid="thread-side-column"]');
      if (!channel || !thread) throw new Error("Channel and Thread must remain mounted after Profile closes");
      return {
        channelDisplay: getComputedStyle(channel).display,
        threadPosition: getComputedStyle(thread).position,
      };
    });
    expect(restoredLayout.channelDisplay).toBe("flex");
    expect(restoredLayout.threadPosition).toBe("relative");
    const threadStateAfterProfile = await threadPanel.evaluate((thread) => {
      const pageWindow = window as typeof window & { __qaRetainedThread?: HTMLElement };
      return {
        sameNode: pageWindow.__qaRetainedThread === thread,
        scrollTop: (thread as HTMLElement).scrollTop,
      };
    });
    expect(threadStateAfterProfile.sameNode).toBe(true);
    expect(threadStateAfterProfile.scrollTop).toBe(threadStateBeforeProfile.scrollTop);

    // Regression: while Profile is open over Channel + Thread, a reply action
    // on a different Channel message still navigates to that Thread. The
    // Profile surface must close and the ordinary Channel + Thread shell must
    // be restored for the newly selected parent.
    await channelAgentBody.scrollIntoViewIfNeeded();
    await channelAgentBody.locator('button[data-avatar-kind="agent"]').click();
    await expect(page.getByTestId("profile-panel")).toBeVisible();
    const secondParentCard = page.locator(`#message-${secondParentMessage.id}`).first();
    await secondParentCard.scrollIntoViewIfNeeded();
    await secondParentCard.hover();
    await secondParentCard.getByLabel("Reply in thread").click();
    await expect(page.getByTestId("profile-panel")).toHaveCount(0);
    await expect(page.getByTestId("thread-message-scroller").getByText(secondThreadReply)).toBeVisible();
    await expect(page.getByPlaceholder(`Message #${seedState.channel.name}`)).toBeVisible();

  });
});
