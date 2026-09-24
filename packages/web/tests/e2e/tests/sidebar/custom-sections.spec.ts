import { expect, test } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { withWorkspaceDmDragEvidence } from "../../fixtures/workspaceDmDragEvidence";
import { loginViaApi } from "../../fixtures/auth";
import { dismissOwnerOnboarding } from "../../fixtures/session";
import { waitForSeedState } from "../../fixtures/seedState";
import type { PlaywrightSeedState } from "../../fixtures/seedState";

function authHeaders(accessToken: string, serverId: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Server-Id": serverId,
  };
}

async function createChannel(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  name: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: authHeaders(accessToken, seedState.server.id),
    data: { name },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ id: string; name: string }>;
}

async function listChannels(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
) {
  const response = await request.get(`${seedState.urls.api}/api/channels`, {
    headers: authHeaders(accessToken, seedState.server.id),
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Array<{ id: string; name: string }>>;
}

async function deleteChannel(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
) {
  const response = await request.delete(`${seedState.urls.api}/api/channels/${channelId}`, {
    headers: authHeaders(accessToken, seedState.server.id),
  });
  expect([200, 404]).toContain(response.status());
}

async function deleteStalePinnedAnchors(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
) {
  const channels = await listChannels(request, seedState, accessToken);
  for (const channel of channels) {
    if (channel.name.startsWith("pinned-anchor-")) {
      await deleteChannel(request, seedState, accessToken, channel.id);
    }
  }
}

async function createDm(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  peer: { userId: string } | { agentId: string },
) {
  const response = await request.post(`${seedState.urls.api}/api/channels/dm`, {
    headers: authHeaders(accessToken, seedState.server.id),
    data: peer,
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ id: string }>;
}

async function listDmIds(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
) {
  const response = await request.get(`${seedState.urls.api}/api/channels/dm`, {
    headers: authHeaders(accessToken, seedState.server.id),
  });
  expect(response.ok()).toBeTruthy();
  const dms = await response.json() as Array<{ id: string }>;
  return dms.map((dm) => dm.id);
}

async function patchSidebarOrder(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  data: Record<string, unknown>,
) {
  const response = await request.patch(`${seedState.urls.api}/api/servers/${seedState.server.id}/sidebar-order`, {
    headers: authHeaders(accessToken, seedState.server.id),
    data,
  });
  expect(response.ok()).toBeTruthy();
}

async function getSidebarOrder(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
) {
  const response = await request.get(`${seedState.urls.api}/api/servers/${seedState.server.id}/sidebar-order`, {
    headers: authHeaders(accessToken, seedState.server.id),
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<SidebarOrderResponse>;
}

function waitForSidebarOrderPatch(page: Page, seedState: PlaywrightSeedState) {
  return page.waitForResponse((response) => {
    return response.request().method() === "PATCH"
      && response.url().endsWith(`/api/servers/${seedState.server.id}/sidebar-order`);
  }, { timeout: 5_000 });
}

function moveSectionImmediatelyBeforeTarget(
  sectionOrder: string[],
  sectionId: string,
  targetSectionId: string,
) {
  const remainingSections = sectionOrder.filter((id) => id !== sectionId);
  const targetIndex = remainingSections.indexOf(targetSectionId);
  expect(targetIndex).toBeGreaterThanOrEqual(0);
  return [
    ...remainingSections.slice(0, targetIndex),
    sectionId,
    ...remainingSections.slice(targetIndex),
  ];
}

function sectionOrderWithout(sectionOrder: string[], sectionId: string) {
  return sectionOrder.filter((id) => id !== sectionId);
}

interface SidebarOrderResponse {
  channelOrder: string[];
  agentOrder: string[];
  dmOrder: string[];
  channelSortMode: string;
  jointChannelSortMode: string;
  dmSortMode: string;
  pinnedSortMode: string;
  pinned: Array<{ kind: string; id: string }>;
  pinnedChannelIds: string[];
  pinnedAgentIds: string[];
  pinnedOrder: string[];
  hiddenDmIds: string[];
  channelPanelTabOrder: string[];
  agentPanelTabOrder: string[];
  customSections: Array<Record<string, unknown>>;
  sectionOrder: string[];
  sectionPlacements: Array<{ kind: string; id: string; sectionId: string; position: number }>;
  sectionsVersion: number;
  pinnedVersion: number;
}

async function enableWorkspaceGrid(page: Page) {
  await page.route("**/api/feature-flags/evaluate", async (route) => {
    const body = route.request().postDataJSON() as { keys?: string[] };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        evaluations: (body.keys ?? []).map((key) => ({
          key,
          enabled: key === "chat_grid_layout_v0",
        })),
      }),
    });
  });
}

async function dragCenterToCenter(
  page: Page,
  source: Locator,
  target: Locator,
) {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Sidebar drag surfaces are not measurable");
  const sourceCenter = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  const targetCenter = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height / 2,
  };
  const viewport = page.viewportSize();
  if (
    !viewport
    || sourceCenter.x < 0
    || sourceCenter.x > viewport.width
    || sourceCenter.y < 0
    || sourceCenter.y > viewport.height
    || targetCenter.x < 0
    || targetCenter.x > viewport.width
    || targetCenter.y < 0
    || targetCenter.y > viewport.height
  ) {
    throw new Error("Sidebar drag centers must be inside the pointer delivery viewport");
  }
  await page.mouse.move(sourceCenter.x, sourceCenter.y);
  await page.mouse.down();
  await page.mouse.move(targetCenter.x, targetCenter.y, { steps: 12 });
  await page.mouse.up();
}

test("keeps a regular channel stable while crossing Joint Channels", async ({ page, request }) => {
  const updateDepthErrors: Error[] = [];
  page.on("pageerror", (error) => {
    if (error.message.includes("Maximum update depth exceeded")) {
      updateDepthErrors.push(error);
    }
  });

  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const runId = Date.now();
  const sourceChannel = await createChannel(
    request,
    seedState,
    login.accessToken,
    `transit-${runId}`,
  );
  const pinnedAnchor = await createChannel(
    request,
    seedState,
    login.accessToken,
    `anchor-${runId}`,
  );
  await patchSidebarOrder(request, seedState, login.accessToken, {
    pinned: [{ kind: "channel", id: pinnedAnchor.id }],
    pinnedSortMode: "manual",
    jointChannelSortMode: "manual",
    channelSortMode: "manual",
    channelOrder: [sourceChannel.id],
  });
  await page.route(/\/api\/channels\?[^/]*$/, async (route) => {
    const response = await route.fetch();
    const channels = await response.json() as Array<Record<string, unknown> & { id: string }>;
    const source = channels.find((channel) => channel.id === sourceChannel.id) ?? channels[0];
    await route.fulfill({
      response,
      json: [
        ...channels,
        {
          ...source,
          id: "7f0a7f0a-0000-4000-8000-000000000001",
          name: "joint-transit-target",
          type: "joint",
          joined: true,
          archivedAt: null,
        },
      ],
    });
  });
  await page.route("**/api/announcements/active", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ announcements: [] }),
    });
  });
  await page.route("**/api/servers/*/onboarding-settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ onboardingWizardEnabled: false }),
    });
  });
  await page.route("**/api/servers/*/setup-projection", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        surface: "complete",
        phase: "complete",
        currentStep: null,
        blocksChat: false,
        allowedExits: [],
        sideEffectState: { transitions: "disabled", completion: "disabled" },
        gateReason: "setup_complete",
        postSetup: { surveyPending: false, handoffPending: false },
      }),
    });
  });

  await page.goto(`/s/${seedState.server.slug}/channel/${sourceChannel.id}`);
  const channelsContainer = page.locator('[data-sidebar-dnd-container="sidebar:container:channels"]');
  const sourceItem = page.locator(`[data-sidebar-drag-item="channel:${sourceChannel.id}"]`);
  const jointItem = page.locator('[data-sidebar-drag-item="channel:7f0a7f0a-0000-4000-8000-000000000001"]');
  await expect(sourceItem).toBeVisible();
  await expect(jointItem).toBeVisible();
  const sourceBox = await sourceItem.boundingBox();
  const jointBox = await jointItem.boundingBox();
  if (!sourceBox || !jointBox) {
    throw new Error("Sidebar Joint Channels transit surfaces are not measurable");
  }

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    jointBox.x + jointBox.width / 2,
    jointBox.y + jointBox.height / 4,
    { steps: 12 },
  );
  await page.waitForTimeout(250);
  await expect(channelsContainer.locator(`button[data-sidebar-channel-id="${sourceChannel.id}"]`)).toBeVisible();
  await expect(page.getByTestId("sidebar-drag-overlay")).toBeVisible();
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  expect(updateDepthErrors).toEqual([]);
  await page.mouse.up();

  await expect(channelsContainer.locator(`button[data-sidebar-channel-id="${sourceChannel.id}"]`)).toBeVisible();
  await expect(page.getByTestId("sidebar-drag-overlay")).toHaveCount(0);
  expect(updateDepthErrors).toEqual([]);
});

test("creates a personal section and moves a channel into it", async ({ page, request }) => {
  test.setTimeout(60_000);
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  await deleteStalePinnedAnchors(request, seedState, login.accessToken);
  const pinnedAnchor = await createChannel(
    request,
    seedState,
    login.accessToken,
    `pinned-anchor-${Date.now()}`,
  );
  const existingSectionId = `existing-section-${Date.now()}`;
  const initialSidebarOrder = await getSidebarOrder(request, seedState, login.accessToken);
  await patchSidebarOrder(request, seedState, login.accessToken, {
    pinned: [{ kind: "channel", id: pinnedAnchor.id }],
    pinnedSortMode: "manual",
    customSections: [{
      id: existingSectionId,
      name: "Existing section",
      emoji: null,
      sortMode: "manual",
    }],
    sectionOrder: ["system:pinned", "system:joint", existingSectionId, "system:channels", "system:dms"],
    sectionPlacements: [],
    sectionsVersion: initialSidebarOrder.sectionsVersion,
  });
  await page.route("**/api/announcements/active", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ announcements: [] }),
    });
  });
  await page.route("**/api/servers/*/onboarding-settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ onboardingWizardEnabled: false }),
    });
  });
  await page.route("**/api/servers/*/setup-projection", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        surface: "complete",
        phase: "complete",
        currentStep: null,
        blocksChat: false,
        allowedExits: [],
        sideEffectState: { transitions: "disabled", completion: "disabled" },
        gateReason: "setup_complete",
        postSetup: { surveyPending: false, handoffPending: false },
      }),
    });
  });
  await enableWorkspaceGrid(page);
  const sectionName = `Launch ${Date.now()}`;
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const deferSetup = page.getByRole("button", { name: "I'll set this up myself" });
  if (await deferSetup.isVisible()) {
    await deferSetup.click();
    await expect(deferSetup).toBeHidden();
  }

  const channelsHeader = page.getByTestId("sidebar-section-toggle-channels");
  await expect(channelsHeader).toBeVisible();
  await page.getByTestId("sidebar-scroll-surface").dispatchEvent("contextmenu", {
    clientX: 40,
    clientY: 700,
  });
  const sidebarMenu = page.getByRole("menu", { name: "Sidebar options" });
  await expect(sidebarMenu.getByRole("menuitem", { name: "Create Channel" })).toBeVisible();
  await expect(sidebarMenu.getByRole("menuitem", { name: "Create Joint Channel" })).toBeVisible();
  await expect(sidebarMenu.getByRole("menuitem", { name: "New section…" })).toBeVisible();
  await expect(sidebarMenu.getByRole("menuitem", { name: "Manage sections…" })).toHaveCount(0);
  await expect(sidebarMenu.getByRole("menuitem", { name: "Move to section" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await channelsHeader.click({ button: "right" });
  await page.getByRole("menuitem", { name: "New section…" }).click();
  await page.getByPlaceholder("My Project").fill(sectionName);
  await page.getByRole("button", { name: "Choose section emoji" }).click();
  const emojiPicker = page.getByRole("dialog", { name: "Choose section emoji" });
  await emojiPicker.getByRole("textbox", { name: "Type to search for an emoji" }).fill("rocket");
  await emojiPicker.getByRole("button", { name: "rocket" }).click();
  await page.getByRole("button", { name: "Create section" }).click();

  const customSection = page.locator('[data-testid^="sidebar-custom-section-"]', { hasText: sectionName });
  await expect(customSection).toBeVisible();
  const customSectionTestId = await customSection.getAttribute("data-testid");
  const customSectionId = customSectionTestId?.slice("sidebar-custom-section-".length);
  if (!customSectionId) throw new Error("Created sidebar section is missing its persisted id");
  await expect(customSection.getByText("🚀")).toBeVisible();
  const channelRow = page.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`);
  await expect(channelRow).toBeVisible();

  await channelRow.click({ button: "right" });
  const moveToSection = page.getByRole("menuitem", { name: "Move to section" });
  await moveToSection.hover();
  await expect(page.getByRole("menu", { name: "Move to section" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Mark as Unread" }).hover();
  await expect(page.getByRole("menu", { name: "Move to section" })).toBeHidden();
  await page.keyboard.press("Escape");

  const dragItem = page.locator(`[data-sidebar-drag-item="channel:${seedState.channel.id}"]`);
  const pinnedContainer = page.locator('[data-sidebar-dnd-container="sidebar:container:pinned"]');
  const pinnedAnchorItem = page.locator(`[data-sidebar-drag-item="channel:${pinnedAnchor.id}"]`);
  await expect(pinnedAnchorItem).toBeVisible();
  const sourceBox = await dragItem.boundingBox();
  const pinnedAnchorBox = await pinnedAnchorItem.boundingBox();
  if (!sourceBox || !pinnedAnchorBox) {
    throw new Error("Sidebar cross-section drag surfaces are not measurable");
  }
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    pinnedAnchorBox.x + pinnedAnchorBox.width / 2,
    pinnedAnchorBox.y + pinnedAnchorBox.height / 4,
    { steps: 12 },
  );
  await expect(page.getByTestId("sidebar-drag-overlay")).toBeVisible();
  await expect(pinnedContainer.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();
  await expect.poll(async () => (await pinnedAnchorItem.boundingBox())?.y ?? 0).toBeGreaterThan(pinnedAnchorBox.y);
  await page.screenshot({ path: "test-results/sidebar-cross-section-drag-live.png", fullPage: false });
  await page.mouse.up();
  await expect(pinnedContainer.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();

  const pinnedSource = pinnedContainer.locator(`[data-sidebar-drag-item="channel:${seedState.channel.id}"]`);
  const customDropTarget = customSection.locator("[data-sidebar-dnd-container]");
  const pinnedSourceBox = await pinnedSource.boundingBox();
  const customDropBox = await customDropTarget.boundingBox();
  if (!pinnedSourceBox || !customDropBox) {
    throw new Error("Sidebar projected drop surfaces are not measurable");
  }
  await page.mouse.move(
    pinnedSourceBox.x + pinnedSourceBox.width / 2,
    pinnedSourceBox.y + pinnedSourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    customDropBox.x + customDropBox.width / 2,
    customDropBox.y + customDropBox.height / 2,
    { steps: 12 },
  );
  await expect(page.getByTestId("sidebar-drag-overlay")).toBeVisible();
  await expect(customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();
  await page.mouse.up();

  await expect(customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();
  await expect(page.getByTestId("sidebar-drag-overlay")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-section-toggle-channels")).toBeVisible();
  await expect.poll(async () => {
    const order = await getSidebarOrder(request, seedState, login.accessToken);
    return order.sectionPlacements.some((placement) =>
      placement.kind === "channel"
      && placement.id === seedState.channel.id
      && placement.sectionId === customSectionId,
    );
  }).toBe(true);
  await page.reload();
  await expect(customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();

  const beforeSectionDrag = await getSidebarOrder(request, seedState, login.accessToken);
  const expectedSectionOrder = moveSectionImmediatelyBeforeTarget(
    beforeSectionDrag.sectionOrder,
    customSectionId,
    "system:channels",
  );
  expect(sectionOrderWithout(expectedSectionOrder, customSectionId)).toEqual(
    sectionOrderWithout(beforeSectionDrag.sectionOrder, customSectionId),
  );
  expect(expectedSectionOrder.indexOf(customSectionId)).toBe(
    expectedSectionOrder.indexOf("system:channels") - 1,
  );
  const expectedAfterSectionDrag: SidebarOrderResponse = {
    ...beforeSectionDrag,
    sectionOrder: expectedSectionOrder,
    sectionsVersion: beforeSectionDrag.sectionsVersion + 1,
  };
  const customTitle = customSection.locator("button", { hasText: sectionName });
  const channelsSectionBlock = page.getByTestId("sidebar-section-block-channels");
  const customTitleBox = await customTitle.boundingBox();
  const channelsSectionBox = await channelsSectionBlock.boundingBox();
  if (!customTitleBox || !channelsSectionBox) throw new Error("Section title drag surfaces are not measurable");
  const sectionOrderPatchResponsePromise = waitForSidebarOrderPatch(page, seedState);
  await dragCenterToCenter(page, customTitle, channelsSectionBlock);
  const sectionOrderPatchResponse = await sectionOrderPatchResponsePromise;
  expect(sectionOrderPatchResponse.request().postDataJSON()).toEqual({
    sectionOrder: expectedSectionOrder,
    sectionsVersion: beforeSectionDrag.sectionsVersion,
  });
  expect(sectionOrderPatchResponse.ok()).toBeTruthy();
  const appliedSectionOrder = await sectionOrderPatchResponse.json() as SidebarOrderResponse;
  expect(appliedSectionOrder).toEqual(expectedAfterSectionDrag);

  await expect.poll(async () => {
    return getSidebarOrder(request, seedState, login.accessToken);
  }).toEqual(expectedAfterSectionDrag);
  const customBox = await customSection.boundingBox();
  const channelsBox = await page.getByTestId("sidebar-section-block-channels").boundingBox();
  expect(customBox?.y).toBeLessThan(channelsBox?.y ?? 0);

  await expect(customTitle).toHaveAttribute("aria-expanded", "true");
  await page.waitForTimeout(250);
  await customTitle.click();
  await expect(customTitle).toHaveAttribute("aria-expanded", "false");
  await expect(customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeHidden();
  await customTitle.click();
  await expect(customTitle).toHaveAttribute("aria-expanded", "true");
  await expect(customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();

  // Custom section disclosure is a personal preference and must survive a
  // reload, just like the built-in sidebar sections.
  await customTitle.click();
  await expect(customTitle).toHaveAttribute("aria-expanded", "false");
  await expect(customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeHidden();
  await page.reload();
  const reloadedCustomSection = page.locator('[data-testid^="sidebar-custom-section-"]', { hasText: sectionName });
  const reloadedCustomTitle = reloadedCustomSection.locator("button", { hasText: sectionName });
  await expect(reloadedCustomTitle).toHaveAttribute("aria-expanded", "false");
  await expect(reloadedCustomSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeHidden();
  await reloadedCustomTitle.click();
  await expect(reloadedCustomTitle).toHaveAttribute("aria-expanded", "true");
  await expect(reloadedCustomSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();

  await customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to section" }).click();
  await page.getByRole("menu", { name: "Move to section" }).getByRole("menuitem", { name: "Pinned" }).click();
  await expect(page.getByTestId("sidebar-section-block-pinned").locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get(`${seedState.urls.api}/api/servers/${seedState.server.id}/sidebar-order`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
    });
    expect(response.ok()).toBeTruthy();
    const order = await response.json() as { pinned?: Array<{ kind: string; id: string }> };
    return order.pinned;
  }).toContainEqual({ kind: "channel", id: seedState.channel.id });

  const pinnedChannelRow = page.getByTestId("sidebar-section-block-pinned").locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`);
  await pinnedChannelRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to section" }).click();
  await page.getByRole("menu", { name: "Move to section" }).getByRole("menuitem", { name: sectionName }).click();
  await expect(customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();

  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: "test-results/sidebar-section-direct-reorder.png", fullPage: false });
  await page.screenshot({ path: "test-results/sidebar-custom-sections.png", fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${seedState.server.slug}`);
  const mobileCustomSection = page.locator('[data-testid^="sidebar-custom-section-"]', { hasText: sectionName });
  await expect(mobileCustomSection).toBeVisible();
  await expect(mobileCustomSection.getByText("🚀")).toBeVisible();
  await page.screenshot({ path: "test-results/sidebar-custom-sections-mobile.png", fullPage: false });
});

test("reorders channels and DMs in classic and Workspace modes with persisted orders", async ({ page, request }) => {
  test.setTimeout(60_000);
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const runId = Date.now();
  const firstChannel = await createChannel(request, seedState, login.accessToken, `drag-alpha-${runId}`);
  const secondChannel = await createChannel(request, seedState, login.accessToken, `drag-beta-${runId}`);
  const firstDm = await createDm(request, seedState, login.accessToken, { userId: seedState.extraHuman.userId });
  const secondDm = await createDm(request, seedState, login.accessToken, { agentId: seedState.agent.id });
  const listedDmIds = await listDmIds(request, seedState, login.accessToken);
  const initialOrder = await getSidebarOrder(request, seedState, login.accessToken);
  const testDmIds = new Set([firstDm.id, secondDm.id]);
  const testPinnedRefs = new Set([
    `channel:${firstDm.id}`,
    `channel:${secondDm.id}`,
    `human:${seedState.extraHuman.userId}`,
    `agent:${seedState.agent.id}`,
  ]);
  const expectedInitialDmOrder = [
    firstDm.id,
    secondDm.id,
    ...listedDmIds.filter((id) => !testDmIds.has(id)),
  ];
  const expectedPinned = initialOrder.pinned.filter((ref) => !testPinnedRefs.has(`${ref.kind}:${ref.id}`));
  const expectedHiddenDmIds = initialOrder.hiddenDmIds.filter((id) => !testDmIds.has(id));
  const expectedSectionPlacements = initialOrder.sectionPlacements.filter((placement) => (
    placement.kind !== "channel" || !testDmIds.has(placement.id)
  ));

  await patchSidebarOrder(request, seedState, login.accessToken, {
    channelSortMode: "manual",
    dmSortMode: "manual",
    channelOrder: [firstChannel.id, secondChannel.id],
    dmOrder: expectedInitialDmOrder,
    pinned: expectedPinned,
    hiddenDmIds: expectedHiddenDmIds,
    sectionPlacements: expectedSectionPlacements,
    sectionsVersion: initialOrder.sectionsVersion,
  });
  await enableWorkspaceGrid(page);

  await page.goto(`/s/${seedState.server.slug}/channel/${firstChannel.id}`);

  const firstChannelRow = page.locator(`button[data-sidebar-channel-id="${firstChannel.id}"]`);
  const secondChannelRow = page.locator(`button[data-sidebar-channel-id="${secondChannel.id}"]`);
  await expect(firstChannelRow).toBeVisible();
  await expect(secondChannelRow).toBeVisible();
  await dragCenterToCenter(page, firstChannelRow, secondChannelRow);

  await expect.poll(async () => {
    const order = await getSidebarOrder(request, seedState, login.accessToken);
    return order.channelOrder.indexOf(firstChannel.id) > order.channelOrder.indexOf(secondChannel.id);
  }).toBe(true);
  const beforeDmDrag = await getSidebarOrder(request, seedState, login.accessToken);
  const expectedDmOrder = [secondDm.id, firstDm.id, ...expectedInitialDmOrder.slice(2)];
  const expectedDmPatchPayload = {
    dmOrder: expectedDmOrder,
    pinned: expectedPinned,
    sectionPlacements: expectedSectionPlacements,
    sectionsVersion: beforeDmDrag.sectionsVersion,
  };
  const expectedAfterDmDrag: SidebarOrderResponse = {
    ...beforeDmDrag,
    dmOrder: expectedDmOrder,
    sectionsVersion: beforeDmDrag.sectionsVersion + 1,
  };

  // Keep this drag below the viewport until the helper deliberately scrolls
  // it into the pointer delivery surface. The CI recurrence had both
  // DM centers below a 720px viewport, so raw page.mouse coordinates never
  // reached dnd-kit and no sidebar-order PATCH was sent.
  await page.setViewportSize({ width: 1280, height: 400 });
  const firstDmRow = page.locator(`button[data-sidebar-channel-id="${firstDm.id}"]`);
  const secondDmRow = page.locator(`button[data-sidebar-channel-id="${secondDm.id}"]`);
  await expect(firstDmRow).toBeVisible();
  await expect(secondDmRow).toBeVisible();
  const dmPatchResponsePromise = waitForSidebarOrderPatch(page, seedState);
  await dragCenterToCenter(page, firstDmRow, secondDmRow);
  const dmPatchResponse = await dmPatchResponsePromise;
  expect(dmPatchResponse.request().postDataJSON()).toEqual(expectedDmPatchPayload);
  expect(dmPatchResponse.ok()).toBeTruthy();
  const appliedDmOrder = await dmPatchResponse.json() as SidebarOrderResponse;
  expect(appliedDmOrder).toEqual(expectedAfterDmDrag);

  await expect.poll(async () => {
    return getSidebarOrder(request, seedState, login.accessToken);
  }).toEqual(expectedAfterDmDrag);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await expect(firstChannelRow).toBeVisible();
  await expect(firstDmRow).toBeVisible();

  const persisted = await getSidebarOrder(request, seedState, login.accessToken);
  expect(persisted).toEqual(expectedAfterDmDrag);

  await page.getByRole("button", { name: "Enter Workspace" }).click();
  await expect(page).toHaveURL(/[?&]wg=/);
  await expect(firstChannelRow).toHaveAttribute("draggable", "true");
  await firstChannelRow.dragTo(secondChannelRow);
  await expect.poll(async () => {
    const order = await getSidebarOrder(request, seedState, login.accessToken);
    return order.channelOrder.indexOf(firstChannel.id) < order.channelOrder.indexOf(secondChannel.id);
  }).toBe(true);

  await withWorkspaceDmDragEvidence(page, test.info(), seedState.server.id, [firstDm.id, secondDm.id], async () => {
    await expect(firstDmRow).toHaveAttribute("draggable", "true");
    await firstDmRow.dragTo(secondDmRow);
    await expect.poll(async () => {
      const order = await getSidebarOrder(request, seedState, login.accessToken);
      return order.dmOrder.indexOf(firstDm.id) < order.dmOrder.indexOf(secondDm.id);
    }).toBe(true);
  });
});

test("Workspace does not treat pinned or custom DMs as part of the default-DMs reorder surface", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const pinnedDm = await createDm(request, seedState, login.accessToken, { userId: seedState.extraHuman.userId });
  const defaultDm = await createDm(request, seedState, login.accessToken, { agentId: seedState.agent.id });
  await patchSidebarOrder(request, seedState, login.accessToken, {
    dmSortMode: "manual",
    dmOrder: [pinnedDm.id, defaultDm.id],
    pinned: [{ kind: "human", id: seedState.extraHuman.userId }],
  });
  await enableWorkspaceGrid(page);

  await page.goto(`/s/${seedState.server.slug}/dm/${defaultDm.id}`);
  await page.getByRole("button", { name: "Enter Workspace" }).click();
  await expect(page).toHaveURL(/[?&]wg=/);

  const pinnedDmRow = page.locator(`button[data-sidebar-channel-id="${pinnedDm.id}"]`);
  const defaultDmRow = page.locator(`button[data-sidebar-channel-id="${defaultDm.id}"]`);
  await expect(pinnedDmRow).toHaveAttribute("draggable", "true");
  await expect(defaultDmRow).toHaveAttribute("draggable", "true");
  const before = (await getSidebarOrder(request, seedState, login.accessToken)).dmOrder;

  await pinnedDmRow.dragTo(defaultDmRow);
  await page.waitForTimeout(250);

  const after = (await getSidebarOrder(request, seedState, login.accessToken)).dmOrder;
  expect(after).toEqual(before);

  const sectionId = `workspace-dm-${Date.now()}`;
  const current = await getSidebarOrder(request, seedState, login.accessToken);
  await patchSidebarOrder(request, seedState, login.accessToken, {
    pinned: [],
    customSections: [{ id: sectionId, name: "Workspace DMs", emoji: null, sortMode: "manual" }],
    sectionOrder: ["system:pinned", sectionId, "system:joint", "system:channels", "system:dms"],
    sectionPlacements: [{ kind: "channel", id: pinnedDm.id, sectionId, position: 0 }],
    sectionsVersion: current.sectionsVersion,
  });
  await page.reload();

  const customSection = page.locator('[data-testid^="sidebar-custom-section-"]', { hasText: "Workspace DMs" });
  const customDmRow = customSection.locator(`button[data-sidebar-channel-id="${pinnedDm.id}"]`);
  await expect(customDmRow).toHaveAttribute("draggable", "true");
  await expect(customDmRow).toHaveClass(/\bitems-center\b/);
  await expect(customDmRow).not.toHaveClass(/\bitems-start\b/);
  const customDmBox = await customDmRow.boundingBox();
  const defaultDmBox = await defaultDmRow.boundingBox();
  expect(customDmBox).not.toBeNull();
  expect(defaultDmBox).not.toBeNull();
  expect(Math.abs(customDmBox!.height - defaultDmBox!.height)).toBeLessThan(1);
  const beforeCustomDrag = (await getSidebarOrder(request, seedState, login.accessToken)).dmOrder;

  await customDmRow.dragTo(defaultDmRow);
  await page.waitForTimeout(250);

  const afterCustomDrag = (await getSidebarOrder(request, seedState, login.accessToken)).dmOrder;
  expect(afterCustomDrag).toEqual(beforeCustomDrag);
});
