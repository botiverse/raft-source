import { expect, test } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { withWorkspaceDmDragEvidence } from "../../fixtures/workspaceDmDragEvidence";
import { loginViaApi } from "../../fixtures/auth";
import { dismissOwnerOnboarding } from "../../fixtures/session";
import { waitForSeedState } from "../../fixtures/seedState";
import * as fs from "node:fs";
import type { PlaywrightSeedState } from "../../fixtures/seedState";

// API layout fixtures must not be bypassed by service-worker-owned reads.
test.use({ serviceWorkers: "block" });

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

const REACT_UPDATE_DEPTH_ERROR_RE =
  /Maximum update depth exceeded|Minified React error #185|react\.dev\/errors\/185/;

function isReactUpdateDepthError(error: Error) {
  return REACT_UPDATE_DEPTH_ERROR_RE.test(error.message);
}

function collectReactUpdateDepthErrors(page: Page) {
  const errors: Error[] = [];
  page.on("pageerror", (error) => {
    if (isReactUpdateDepthError(error)) {
      errors.push(error);
    }
  });
  return errors;
}

// dnd-kit auto-scrolls a scroller while the pointer is held in the outer 20%
// of its height (its default threshold). A pause there scrolls the list under
// a still pointer, so the drag legitimately ends over whatever section scrolls
// in (Pinned, above Joint Channels), not over the row the test aimed at.
const DND_KIT_AUTO_SCROLL_THRESHOLD = 0.2;

async function requirePointerPointBelowAutoScrollBand(
  itemInScroller: Locator,
  point: { x: number; y: number },
  label: string,
) {
  const bandBottom = await itemInScroller.evaluate((element, threshold) => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight) {
        const rect = node.getBoundingClientRect();
        return rect.top + rect.height * threshold;
      }
    }
    return null;
  }, DND_KIT_AUTO_SCROLL_THRESHOLD);
  if (bandBottom !== null && point.y <= bandBottom) {
    throw new Error(`${label} is inside the sidebar's top autoscroll band (y ${point.y} <= ${bandBottom})`);
  }
}

function requirePointerPointInViewport(
  page: Page,
  point: { x: number; y: number },
  label: string,
) {
  const viewport = page.viewportSize();
  if (
    !viewport
    || point.x < 0
    || point.x >= viewport.width
    || point.y < 0
    || point.y >= viewport.height
  ) {
    throw new Error(`${label} must be inside the pointer delivery viewport`);
  }
}

async function dragCenterToCenter(
  page: Page,
  source: Locator,
  target: Locator,
  options: {
    activateSortable?: boolean;
    /** Visible once the drag has landed in the target; until then, follow the target. */
    reaimUntil?: Locator;
    beforeReaim?: () => Promise<void>;
    beforeDrop?: () => Promise<void>;
  } = {},
) {
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error("Sidebar drag source is not measurable");
  const sourceCenter = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  requirePointerPointInViewport(page, sourceCenter, "Sidebar drag source center");
  await page.mouse.move(sourceCenter.x, sourceCenter.y);
  await page.mouse.down();
  try {
    if (options.activateSortable) {
      // Sidebar's PointerSensor needs more than 6px of movement. A mouseDown
      // alone does not start it: scrolling first changes the source rect before
      // activation, so closestCenter can select the adjacent section instead.
      const activationX = sourceCenter.x + 8;
      requirePointerPointInViewport(page, { x: activationX, y: sourceCenter.y }, "Sidebar drag activation");
      await page.mouse.move(activationX, sourceCenter.y, { steps: 2 });
      await expect(source).toHaveAttribute("aria-pressed", "true");
    }
    // Start the drag while the source is still visible. Bringing a distant
    // target into view first can scroll the source outside the pointer
    // delivery viewport before the mouse is pressed.
    await target.scrollIntoViewIfNeeded();
    const targetBox = await target.boundingBox();
    if (!targetBox) throw new Error("Sidebar drag target is not measurable");
    const targetCenter = {
      x: targetBox.x + targetBox.width / 2,
      y: targetBox.y + targetBox.height / 2,
    };
    requirePointerPointInViewport(page, targetCenter, "Sidebar drag target center");
    await page.mouse.move(targetCenter.x, targetCenter.y, { steps: 12 });
    if (options.reaimUntil) {
      await options.beforeReaim?.();
      // Projection and scrolling can move the destination during transit.
      // Follow its live, reachable center within the existing attempt budget.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await options.reaimUntil.isVisible()) break;
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        if (!box) throw new Error("Sidebar drag target is not measurable");
        const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        requirePointerPointInViewport(page, center, "Sidebar drag target center (re-aimed)");
        await page.mouse.move(center.x, center.y, { steps: 4 });
      }
    }
    await options.beforeDrop?.();
  } finally {
    await page.mouse.up();
  }
}

async function dragCenterAlongLocators(
  page: Page,
  source: Locator,
  targets: Locator[],
) {
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error("Sidebar drag source is not measurable");
  const sourceCenter = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  requirePointerPointInViewport(page, sourceCenter, "Sidebar drag source center");

  const points: Array<{ x: number; y: number }> = [];
  for (const [index, target] of targets.entries()) {
    await target.scrollIntoViewIfNeeded();
    const targetBox = await target.boundingBox();
    if (!targetBox) throw new Error(`Sidebar drag target ${index} is not measurable`);
    const point = {
      x: targetBox.x + targetBox.width / 2,
      y: targetBox.y + targetBox.height / 2,
    };
    requirePointerPointInViewport(page, point, `Sidebar drag target ${index}`);
    points.push(point);
  }

  await page.mouse.move(sourceCenter.x, sourceCenter.y);
  await page.mouse.down();
  for (const point of points) {
    await page.mouse.move(point.x, point.y, { steps: 10 });
  }
  await page.mouse.up();
}

async function dragCenterAlongLocatorsAfterStart(
  page: Page,
  source: Locator,
  targets: Locator[],
  afterStart?: () => Promise<void>,
) {
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error("Sidebar drag source is not measurable");
  const sourceCenter = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  requirePointerPointInViewport(page, sourceCenter, "Sidebar drag source center");

  await page.mouse.move(sourceCenter.x, sourceCenter.y);
  await page.mouse.down();
  await page.mouse.move(sourceCenter.x, sourceCenter.y - 8, { steps: 2 });
  await afterStart?.();

  for (const [index, target] of targets.entries()) {
    await expect(target).toBeVisible();
    const targetBox = await target.boundingBox();
    if (!targetBox) throw new Error(`Sidebar drag target ${index} is not measurable`);
    const point = {
      x: targetBox.x + targetBox.width / 2,
      y: targetBox.y + targetBox.height / 2,
    };
    requirePointerPointInViewport(page, point, `Sidebar drag target ${index}`);
    await page.mouse.move(point.x, point.y, { steps: 10 });
  }

  await page.mouse.up();
}

async function stubSetupSurfaces(page: Page) {
  await page.route(/\/api\/announcements\/active(?:\?|$)/, async (route) => {
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
}

test("keeps a regular channel stable while crossing Joint Channels", async ({ page, request }) => {
  const updateDepthErrors = collectReactUpdateDepthErrors(page);

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
  // Keep the source row just below the pointer viewport. A locator can still be
  // "visible" there, but raw page.mouse coordinates cannot reach its center.
  // Only just: once the source is scrolled into reach, the Joint target above
  // it has to stay below the scroller's autoscroll band (see
  // requirePointerPointBelowAutoScrollBand), so add no more rows than needed.
  const transitFillerIds = Array.from(
    { length: 8 },
    (_, index) => `7f0a7f0a-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
  );
  await patchSidebarOrder(request, seedState, login.accessToken, {
    pinned: [{ kind: "channel", id: pinnedAnchor.id }],
    pinnedSortMode: "manual",
    jointChannelSortMode: "manual",
    channelSortMode: "manual",
    channelOrder: [...transitFillerIds, sourceChannel.id],
  });
  const transitSidebarOrder = await getSidebarOrder(request, seedState, login.accessToken);
  await page.route("**/api/servers/*/sidebar-order", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...transitSidebarOrder,
        channelOrder: [...transitFillerIds, sourceChannel.id],
      }),
    });
  });
  await page.route(/\/api\/channels\?[^/]*$/, async (route) => {
    const response = await route.fetch();
    const channels = await response.json() as Array<Record<string, unknown> & { id: string }>;
    const source = channels.find((channel) => channel.id === sourceChannel.id) ?? channels[0];
    await route.fulfill({
      response,
      json: [
        ...channels,
        ...transitFillerIds.map((id, index) => ({
          ...source,
          id,
          name: `transit-filler-${index}`,
        })),
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
  await page.route(/\/api\/announcements\/active(?:\?|$)/, async (route) => {
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
  // This boundary reproduces the CI layout without relying on unrelated tests
  // to leave enough sidebar rows behind in the shared seed.
  await page.setViewportSize({ width: 1_280, height: 700 });
  const channelsContainer = page.locator('[data-sidebar-dnd-container="sidebar:container:channels"]');
  const sourceItem = page.locator(`[data-sidebar-drag-item="channel:${sourceChannel.id}"]`);
  const jointItem = page.locator('[data-sidebar-drag-item="channel:7f0a7f0a-0000-4000-8000-000000000001"]');
  await expect(sourceItem).toBeVisible();
  await expect(jointItem).toBeVisible();
  // Visibility does not imply both raw pointer coordinates are reachable.
  // Capture the common scroller before/after making the source reachable;
  // attach before the guards so the first failed attempt retains its evidence.
  const captureGeometry = () => page.evaluate((sourceId) => {
    const source = document.querySelector(`[data-sidebar-drag-item="channel:${sourceId}"]`);
    const joint = document.querySelector('[data-sidebar-drag-item="channel:7f0a7f0a-0000-4000-8000-000000000001"]');
    const scrollAncestors = [];
    for (let node = source?.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight) {
        scrollAncestors.push({
          tag: node.tagName,
          className: node.className,
          scrollTop: node.scrollTop,
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight,
        });
      }
    }
    return {
      source: source?.getBoundingClientRect().toJSON() ?? null,
      joint: joint?.getBoundingClientRect().toJSON() ?? null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollAncestors,
    };
  }, sourceChannel.id);
  const beforeSourceScroll = await captureGeometry();
  // Keep the nearby Joint target reachable in the same scroller: centering
  // the source can push that target above the viewport before the drag starts.
  await sourceItem.evaluate((element) => element.scrollIntoView({ block: "nearest", inline: "nearest" }));
  const afterSourceScroll = await captureGeometry();
  const geometryPath = test.info().outputPath("sidebar-joint-transit-geometry.json");
  fs.writeFileSync(geometryPath, JSON.stringify({ retry: test.info().retry, beforeSourceScroll, afterSourceScroll }, null, 2));
  await test.info().attach("sidebar-joint-transit-geometry.json", {
    path: geometryPath,
    contentType: "application/json",
  });
  const sourceBox = await sourceItem.boundingBox();
  const jointBox = await jointItem.boundingBox();
  if (!sourceBox || !jointBox) {
    throw new Error("Sidebar Joint Channels transit surfaces are not measurable");
  }

  const sourcePoint = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  const jointPoint = {
    x: jointBox.x + jointBox.width / 2,
    y: jointBox.y + jointBox.height / 4,
  };
  requirePointerPointInViewport(page, sourcePoint, "Sidebar Joint Channels transit source");
  requirePointerPointInViewport(page, jointPoint, "Sidebar Joint Channels transit target");
  await requirePointerPointBelowAutoScrollBand(sourceItem, jointPoint, "Sidebar Joint Channels transit target");

  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(jointPoint.x, jointPoint.y, { steps: 12 });
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

test("moves a regular channel to a custom section after crossing Pinned and Joint Channels", async ({ page, request }) => {
  const updateDepthErrors = collectReactUpdateDepthErrors(page);

  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  await deleteStalePinnedAnchors(request, seedState, login.accessToken);
  const runId = Date.now();
  const sourceChannel = await createChannel(request, seedState, login.accessToken, `custom-transit-${runId}`);
  const pinnedAnchor = await createChannel(request, seedState, login.accessToken, `pinned-anchor-${runId}`);
  const customSectionId = `drop-zone-${runId}`;
  const fakeJointId = "7f0a7f0a-0000-4000-8000-000000000021";
  const initialSidebarOrder = await getSidebarOrder(request, seedState, login.accessToken);

  await patchSidebarOrder(request, seedState, login.accessToken, {
    pinned: [{ kind: "channel", id: pinnedAnchor.id }],
    pinnedSortMode: "manual",
    jointChannelSortMode: "manual",
    channelSortMode: "manual",
    channelOrder: [sourceChannel.id],
    customSections: [{
      id: customSectionId,
      name: "Drop zone",
      emoji: null,
      sortMode: "manual",
    }],
    sectionOrder: [customSectionId, "system:pinned", "system:joint", "system:channels", "system:dms"],
    sectionPlacements: [],
    sectionsVersion: initialSidebarOrder.sectionsVersion,
  });
  const patchedSidebarOrder = await getSidebarOrder(request, seedState, login.accessToken);

  await page.route("**/api/servers/*/sidebar-order", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(patchedSidebarOrder),
    });
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
          id: fakeJointId,
          name: `joint-transit-${runId}`,
          type: "joint",
          joined: true,
          archivedAt: null,
        },
      ],
    });
  });
  await stubSetupSurfaces(page);
  await page.addInitScript(() => {
    localStorage.setItem("slock:sidebarHideEmptySections", "true");
  });

  await page.setViewportSize({ width: 1_280, height: 720 });
  await page.goto(`/s/${seedState.server.slug}/channel/${sourceChannel.id}`);

  const sourceItem = page.locator(`[data-sidebar-drag-item="channel:${sourceChannel.id}"]`);
  const pinnedItem = page.locator(`[data-sidebar-drag-item="channel:${pinnedAnchor.id}"]`);
  const jointItem = page.locator(`[data-sidebar-drag-item="channel:${fakeJointId}"]`);
  const customSection = page.getByTestId(`sidebar-custom-section-${customSectionId}`);
  const customDropTarget = customSection.locator("[data-sidebar-dnd-container]");
  await expect(sourceItem).toBeVisible();
  await expect(pinnedItem).toBeVisible();
  await expect(jointItem).toBeVisible();
  await expect(customSection).toBeVisible();

  await dragCenterAlongLocators(page, sourceItem, [jointItem, pinnedItem, customDropTarget]);

  await expect(page.getByTestId("sidebar-drag-overlay")).toHaveCount(0);
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  await expect(customSection.locator(`button[data-sidebar-channel-id="${sourceChannel.id}"]`)).toBeVisible();
  expect(updateDepthErrors).toEqual([]);
  await expect.poll(async () => {
    const order = await getSidebarOrder(request, seedState, login.accessToken);
    return order.sectionPlacements.some((placement) =>
      placement.kind === "channel"
      && placement.id === sourceChannel.id
      && placement.sectionId === customSectionId,
    );
  }).toBe(true);
});

test("keeps drag stable when Pinned appears while crossing Joint to custom", async ({ page, request }) => {
  const updateDepthErrors = collectReactUpdateDepthErrors(page);

  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const runId = Date.now();
  const sourceChannel = seedState.channel;
  const customSectionId = `empty-drop-zone-${runId}`;
  const initialSidebarOrder = await getSidebarOrder(request, seedState, login.accessToken);

  await patchSidebarOrder(request, seedState, login.accessToken, {
    pinned: [],
    pinnedSortMode: "manual",
    jointChannelSortMode: "manual",
    channelSortMode: "manual",
    channelOrder: [sourceChannel.id],
    customSections: [{
      id: customSectionId,
      name: "Empty transit target",
      emoji: null,
      sortMode: "manual",
    }],
    sectionOrder: [customSectionId, "system:pinned", "system:joint", "system:channels", "system:dms"],
    sectionPlacements: [],
    sectionsVersion: initialSidebarOrder.sectionsVersion,
  });
  const patchedSidebarOrder = await getSidebarOrder(request, seedState, login.accessToken);

  await page.route("**/api/servers/*/sidebar-order", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(patchedSidebarOrder),
    });
  });
  await page.route(/\/api\/channels\?[^/]*$/, async (route) => {
    const response = await route.fetch();
    const channels = await response.json() as Array<Record<string, unknown> & { id: string }>;
    await route.fulfill({
      response,
      json: channels.filter((channel) => channel.type !== "joint"),
    });
  });
  await page.route("**/api/channels/dm", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
  await stubSetupSurfaces(page);
  await page.addInitScript(() => {
    localStorage.setItem("slock:sidebarHideEmptySections", "true");
  });

  await page.setViewportSize({ width: 1_280, height: 720 });
  await page.goto(`/s/${seedState.server.slug}/channel/${sourceChannel.id}`);

  const sourceItem = page.locator(`[data-sidebar-drag-item="channel:${sourceChannel.id}"]`);
  const pinnedSection = page.getByTestId("sidebar-section-block-pinned");
  const jointSection = page.getByTestId("sidebar-section-block-joint");
  const dmsSection = page.getByTestId("sidebar-section-block-dms");
  const customSection = page.getByTestId(`sidebar-custom-section-${customSectionId}`);
  const customDropTarget = customSection.locator("[data-sidebar-dnd-container]");
  await expect(sourceItem).toBeVisible();
  await expect(customSection).toBeVisible();
  await expect(pinnedSection).toHaveCount(0);
  // The owner can create joint channels, so the empty Joint Channels section
  // keeps its "+" entry point even with hide-empty-sections on.
  await expect(jointSection).toBeVisible();
  await expect(dmsSection).toHaveCount(0);

  await dragCenterAlongLocatorsAfterStart(page, sourceItem, [jointSection, pinnedSection, customDropTarget], async () => {
    await expect(dmsSection).toHaveCount(0);
  });

  await expect(page.getByTestId("sidebar-drag-overlay")).toHaveCount(0);
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  await expect(customSection.locator(`button[data-sidebar-channel-id="${sourceChannel.id}"]`)).toBeVisible();
  expect(updateDepthErrors).toEqual([]);
  await expect.poll(async () => {
    const order = await getSidebarOrder(request, seedState, login.accessToken);
    return order.sectionPlacements.some((placement) =>
      placement.kind === "channel"
      && placement.id === sourceChannel.id
      && placement.sectionId === customSectionId,
    );
  }).toBe(true);
});

async function exerciseSidebarDestinationDrag(page: Page, request: APIRequestContext, fillerCount: 5 | 8) {
  const updateDepthErrors = collectReactUpdateDepthErrors(page);
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const pinnedAnchor = await createChannel(request, seedState, login.accessToken, `measure-anchor-${Date.now()}`);
  const customSectionId = `measure-destination-${Date.now()}`;
  const existingSectionId = `measure-transit-${Date.now()}`;
  const initial = await getSidebarOrder(request, seedState, login.accessToken);
  await patchSidebarOrder(request, seedState, login.accessToken, {
    pinned: [{ kind: "channel", id: pinnedAnchor.id }],
    pinnedSortMode: "manual",
    channelSortMode: "manual",
    customSections: [
      { id: existingSectionId, name: "Intermediate", emoji: null, sortMode: "manual" },
      { id: customSectionId, name: "Measured destination", emoji: null, sortMode: "manual" },
    ],
    sectionOrder: ["system:pinned", "system:joint", existingSectionId, "system:channels", "system:dms", customSectionId],
    sectionPlacements: [],
    sectionsVersion: initial.sectionsVersion,
  });
  const created = await getSidebarOrder(request, seedState, login.accessToken);
  await patchSidebarOrder(request, seedState, login.accessToken, {
    sectionOrder: ["system:pinned", "system:joint", existingSectionId, "system:channels", "system:dms", customSectionId],
    sectionsVersion: created.sectionsVersion,
  });
  // Fix the list height without depending on other tests. Eight rows match
  // the new natural failure's 284px Channels bucket and below-fold target.
  await page.route(/\/api\/channels\?[^/]*$/, async (route) => {
    const response = await route.fetch();
    const channels = await response.json() as Array<Record<string, unknown> & { id: string }>;
    const source = channels.find((channel) => channel.id === seedState.channel.id)!;
    await route.fulfill({ response, json: [
      ...channels.filter((channel) => channel.id === seedState.channel.id || channel.id === pinnedAnchor.id),
      ...Array.from({ length: fillerCount }, (_, index) => ({ ...source,
        id: `7f0a7f0a-0000-4000-8000-${String(index + 300).padStart(12, "0")}`,
        name: `measurement-filler-${index}`,
      })),
    ] });
  });
  await stubSetupSurfaces(page);
  await page.setViewportSize({ width: 1_280, height: 720 });
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const pinnedSource = page.locator(`[data-sidebar-drag-item="channel:${seedState.channel.id}"]`);
  const customSection = page.getByTestId(`sidebar-custom-section-${customSectionId}`);
  const customDropTarget = customSection.locator("[data-sidebar-dnd-container]");
  await expect(pinnedSource).toBeVisible();
  await expect(customDropTarget).toBeVisible();
  // Match the real preceding projection: move the source into Pinned first.
  // Directly pre-seeding both pinned rows skips its reserved-height lifecycle.
  const pinnedContainer = page.locator('[data-sidebar-dnd-container="sidebar:container:pinned"]');
  const anchor = pinnedContainer.locator(`[data-sidebar-drag-item="channel:${pinnedAnchor.id}"]`);
  await page.waitForLoadState("networkidle");
  await pinnedSource.hover();
  const sourceBox = await pinnedSource.boundingBox();
  const anchorBox = await anchor.boundingBox();
  if (!sourceBox || !anchorBox) throw new Error("Pinned setup drag is not measurable");
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(anchorBox.x + anchorBox.width / 2, anchorBox.y + anchorBox.height / 4, { steps: 12 });
  await expect(pinnedContainer.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId("sidebar-drag-overlay")).toHaveCount(0);
  await page.evaluate(() => window.__SLOCK_E2E__?.sidebarDndProbe?.start());
  try {
    await dragCenterToCenter(page, pinnedSource, customDropTarget, {
      activateSortable: true,
      reaimUntil: customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`),
      // Fix the observed schedule: finish the edge scroll before aiming at the
      // real empty destination. Pointer attempts and held-preview assertions
      // stay unchanged; this fails on the old stale-rectangle implementation.
      beforeReaim: async () => {
        // The eight-row case keeps the original immediate follow-up schedule:
        // the destination can leave the viewport before the first re-aim.
        if (fillerCount === 8) return;
        await expect.poll(async () => page.evaluate(async (id) => {
          const node = document.querySelector(`[data-testid="sidebar-custom-section-${id}"] [data-sidebar-dnd-container]`);
          if (!node) return false;
          const positions: number[] = [];
          for (let frame = 0; frame < 6; frame += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            positions.push(node.getBoundingClientRect().top);
          }
          return positions.every((top) => top === positions[0]);
        }, customSectionId)).toBe(true);
      },
      beforeDrop: async () => {
        await expect(page.getByTestId("sidebar-drag-overlay")).toBeVisible();
        await expect(customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();
        const destinationId = `sidebar:container:custom:${customSectionId}`;
        await expect.poll(async () => page.evaluate((id) => {
          const active = window.__SLOCK_E2E__?.sidebarDndProbe?.read()
            .filter((entry) => entry.kind === "drag-state" && entry.phase === "active").at(-1);
          const dom = active?.domRects?.[id];
          const measured = active?.dndRects?.[id];
          return dom && measured ? Math.abs(dom.top - measured.top) : Infinity;
        }, destinationId)).toBeLessThan(1);

        // A section header is a real gap between valid drop zones. Dwelling
        // there must retain this projection, not fall back to nearest geometry
        // and repeatedly move the row between sections.
        const headerBox = await customSection.locator(":scope > div").first().boundingBox();
        if (!headerBox) throw new Error("Custom section header is not measurable");
        const gapPoint = { x: headerBox.x + headerBox.width / 2, y: headerBox.y + headerBox.height / 2 };
        requirePointerPointInViewport(page, gapPoint, "Sidebar section header gap");
        expect(await page.evaluate(({ x, y }) => [...document.querySelectorAll("[data-sidebar-dnd-container]")]
          .some((node) => { const box = node.getBoundingClientRect(); return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom; }), gapPoint)).toBe(false);
        const probeStart = await page.evaluate(() => window.__SLOCK_E2E__?.sidebarDndProbe?.read().length ?? 0);
        await page.mouse.move(gapPoint.x, gapPoint.y);
        await page.waitForTimeout(250);
        await expect(customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();
        await expect(page.getByTestId("sidebar-drag-overlay")).toBeVisible();
        const gapCollisions = await page.evaluate(({ start, point }) => window.__SLOCK_E2E__?.sidebarDndProbe?.read().slice(start)
          .filter((entry) => entry.kind === "collision" && entry.x === point.x && entry.y === point.y)
          .map((entry) => ({ branch: entry.branch, result: entry.branchResultIds })) ?? [], { start: probeStart, point: gapPoint });
        expect(gapCollisions.length).toBeGreaterThan(0);
        expect(gapCollisions.every((entry) => entry.branch === "retained" && entry.result?.length === 1 && entry.result[0] === destinationId)).toBe(true);
        expect(updateDepthErrors).toEqual([]);
      },
    });
  } catch (error) {
    try {
      const dumpPath = test.info().outputPath("sidebar-dnd-probe.json");
      fs.writeFileSync(dumpPath, JSON.stringify(await page.evaluate(() => window.__SLOCK_E2E__?.sidebarDndProbe?.read() ?? [])));
      await test.info().attach("sidebar-dnd-probe.json", { path: dumpPath, contentType: "application/json" });
    } catch { /* Preserve the original assertion failure. */ }
    throw error;
  } finally {
    await page.evaluate(() => window.__SLOCK_E2E__?.sidebarDndProbe?.stop()).catch(() => {});
  }
  await expect(customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();
  await expect(page.getByTestId("sidebar-drag-overlay")).toHaveCount(0);
  expect(updateDepthErrors).toEqual([]);
}

test("remeasures position-only destinations after projection and retains genuine gaps", async ({ page, request }) => {
  await exerciseSidebarDestinationDrag(page, request, 5);
});

test("restores a destination that leaves the viewport during drag transit", async ({ page, request }) => {
  await exerciseSidebarDestinationDrag(page, request, 8);
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
    pinned: [],
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
  const sidebarOrderWithMenuSource = await getSidebarOrder(request, seedState, login.accessToken);
  expect(sidebarOrderWithMenuSource.pinned).not.toContainEqual({ kind: "channel", id: pinnedAnchor.id });
  await page.route(/\/api\/announcements\/active(?:\?|$)/, async (route) => {
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
  await expect(sidebarMenu.getByRole("menuitem", { name: "Create channel" })).toBeVisible();
  await expect(sidebarMenu.getByRole("menuitem", { name: "Create joint channel" })).toBeVisible();
  await expect(sidebarMenu.getByRole("menuitem", { name: "New section" })).toBeVisible();
  await expect(sidebarMenu.getByRole("menuitem", { name: "Manage sections…" })).toHaveCount(0);
  await expect(sidebarMenu.getByRole("menuitem", { name: "Move to section" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // A new section lands right above the section whose menu created it; start
  // from Direct Messages so the later drag still moves it above Channels.
  await page.getByTestId("sidebar-section-toggle-dms").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New section" }).click();
  await page.getByPlaceholder("My Project").fill(sectionName);
  await page.getByRole("button", { name: "Choose section emoji" }).click();
  const emojiPicker = page.getByRole("dialog", { name: "Choose section emoji" });
  await emojiPicker.getByRole("textbox", { name: "Type to search for an emoji" }).fill("rocket");
  await emojiPicker.getByRole("button", { name: "rocket" }).click();
  // Step 1's commit is "Create" (#12730 made it "Next", #13249 "Create"): it saves the section.
  await page.getByRole("button", { name: "Create", exact: true }).click();
  // Step 2 (add conversations) is optional: the section already exists.
  await page.getByTestId("sidebar-section-add-skip").click();

  const customSection = page.locator('[data-testid^="sidebar-custom-section-"]', { hasText: sectionName });
  await expect(customSection).toBeVisible();
  const customSectionTestId = await customSection.getAttribute("data-testid");
  const customSectionId = customSectionTestId?.slice("sidebar-custom-section-".length);
  if (!customSectionId) throw new Error("Created sidebar section is missing its persisted id");
  await expect.poll(async () => {
    const order = (await getSidebarOrder(request, seedState, login.accessToken)).sectionOrder;
    return order.indexOf(customSectionId) === order.indexOf("system:dms") - 1;
  }).toBe(true);
  await expect(customSection.getByText("🚀")).toBeVisible();
  const channelRow = page.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`);
  await expect(channelRow).toBeVisible();
  const menuSourceRow = page.locator(`button[data-sidebar-channel-id="${pinnedAnchor.id}"]`);
  await expect(menuSourceRow).toBeVisible();

  await menuSourceRow.click({ button: "right" });
  const moveToSection = page.getByRole("menuitem", { name: "Move to section" });
  await moveToSection.hover();
  await expect(page.getByRole("menu", { name: "Move to section" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Pin", exact: true }).hover();
  await expect(page.getByRole("menu", { name: "Move to section" })).toBeHidden();
  await page.keyboard.press("Escape");
  await patchSidebarOrder(request, seedState, login.accessToken, {
    pinned: [{ kind: "channel", id: pinnedAnchor.id }],
    pinnedSortMode: "manual",
  });
  await page.reload();

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
  // E2E-only forensics (see utils/sidebarDndE2eProbe): record pointer, scroll,
  // droppable registration, dnd rects, DOM rects and collision branches for
  // this drag so a natural failure can be diagnosed from the attachment. The
  // probe is inert unless the bundle was built with VITE_E2E=true, and the
  // attachment step below must never mask the original assertion failure.
  await page.evaluate(() => window.__SLOCK_E2E__?.sidebarDndProbe?.start());
  try {
    await dragCenterToCenter(page, pinnedSource, customDropTarget, {
      activateSortable: true,
      reaimUntil: customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`),
      beforeDrop: async () => {
        await expect(page.getByTestId("sidebar-drag-overlay")).toBeVisible();
        await expect(customSection.locator(`button[data-sidebar-channel-id="${seedState.channel.id}"]`)).toBeVisible();
      },
    });
  } catch (error) {
    try {
      const probeDump = await page.evaluate(() => window.__SLOCK_E2E__?.sidebarDndProbe?.read() ?? []);
      // Written under test-results/ so the CI artifact upload picks it up,
      // and attached to the report for the HTML viewer.
      const dumpPath = `test-results/sidebar-dnd-probe-${seedState.channel.id}.json`;
      fs.writeFileSync(dumpPath, JSON.stringify(probeDump, null, 2));
      await test.info().attach("sidebar-dnd-probe.json", {
        path: dumpPath,
        contentType: "application/json",
      });
    } catch {
      // Attaching forensics must never mask the original failure.
    }
    throw error;
  } finally {
    await page.evaluate(() => window.__SLOCK_E2E__?.sidebarDndProbe?.stop()).catch(() => {});
  }

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
  await dragCenterToCenter(page, customTitle, channelsSectionBlock, { activateSortable: true });
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

test("reorders channels and DMs with persisted orders", async ({ page, request }) => {
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
  const dmPatchResponse = await withWorkspaceDmDragEvidence(
    page,
    test.info(),
    seedState.server.id,
    [firstDm.id, secondDm.id],
    async () => {
      const dmPatchResponsePromise = waitForSidebarOrderPatch(page, seedState);
      await dragCenterToCenter(page, firstDmRow, secondDmRow);
      return dmPatchResponsePromise;
    },
    "classic-dm-drag-evidence",
  );
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
});
