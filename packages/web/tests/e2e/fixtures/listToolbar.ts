import { expect } from "@playwright/test";
import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { loginViaApi } from "./auth";
import { dismissOwnerOnboarding } from "./session";
import { waitForSeedState } from "./seedState";
import type { PlaywrightSeedState } from "./seedState";

/**
 * The toolbar over a list at real widths (Raft DS › Patterns › Responsive ›
 * The toolbar over a list; raft-ui FitToolbar): what gives way is measured in
 * the browser, so these run where jsdom can't. Each width is a fresh context:
 * a phone is touch (`isMobile`), the others a mouse.
 */
export const LIST_TOOLBAR_WIDTHS = [
  { name: "phone 375", viewport: { width: 375, height: 760 }, touch: true },
  { name: "narrow 420", viewport: { width: 420, height: 760 }, touch: false },
  { name: "780", viewport: { width: 780, height: 800 }, touch: false },
  { name: "1024", viewport: { width: 1024, height: 800 }, touch: false },
] as const;

export type ListToolbarWidth = (typeof LIST_TOOLBAR_WIDTHS)[number];

/** The flags the pages need on (the Tasks page v2). */
const FLAGS_ON = ["task_v2_conversations_v0"];

let cached: { seedState: PlaywrightSeedState; login: Awaited<ReturnType<typeof loginViaApi>> } | null = null;

export async function listToolbarSession(request: APIRequestContext) {
  if (!cached) {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
    cached = { seedState, login };
  }
  return cached;
}

export async function openListToolbarPage(
  browser: Browser,
  request: APIRequestContext,
  width: ListToolbarWidth,
  path: (seed: PlaywrightSeedState) => string,
  /** Runs on the context before the page opens (e.g. to hold a request so the page stays loading). */
  beforeOpen?: (context: BrowserContext) => Promise<void>,
): Promise<{ context: BrowserContext; page: Page; seedState: PlaywrightSeedState }> {
  const { seedState, login } = await listToolbarSession(request);
  const context = await browser.newContext({
    viewport: width.viewport,
    hasTouch: width.touch,
    isMobile: width.touch,
    storageState: undefined,
  });
  await context.addInitScript((data) => {
    localStorage.setItem("slock_access_token", data.accessToken);
    localStorage.setItem("slock_refresh_token", data.refreshToken);
    localStorage.setItem("slock_last_server_slug", data.serverSlug);
  }, { accessToken: login.accessToken, refreshToken: login.refreshToken, serverSlug: seedState.server.slug });
  await context.route(/\/api\/announcements\/active(?:\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ announcements: [] }) }));
  await context.route("**/feature-flags/evaluate", async (route) => {
    const response = await route.fetch();
    const json = (await response.json().catch(() => ({}))) as { evaluations?: { key: string; enabled: boolean }[] };
    const evaluations = (json.evaluations ?? []).filter((evaluation) => !FLAGS_ON.includes(evaluation.key));
    for (const key of FLAGS_ON) evaluations.push({ key, enabled: true });
    await route.fulfill({ response, json: { ...json, evaluations } });
  });
  await beforeOpen?.(context);
  const page = await context.newPage();
  await page.goto(path(seedState));
  return { context, page, seedState };
}

/**
 * Waits until FitToolbar has settled: fonts loaded (it measures again when
 * they arrive) and its controls' boxes the same on two reads in a row.
 */
export async function settled(toolbar: Locator) {
  await toolbar.evaluate(() => document.fonts.ready.then(() => undefined));
  let last = "";
  await expect.poll(async () => {
    const now = await toolbar.evaluate((root) => Array.from(root.querySelectorAll("button, input, [role=radio]"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}`;
      })
      .join(";"));
    const same = now === last;
    last = now;
    return same;
  }, { message: "the toolbar settles", intervals: [100] }).toBe(true);
}

/**
 * The toolbar fits its width: at most two lines, each the rule's height (44px
 * with a mouse on a desktop, 49px by touch or in a phone-wide window; a
 * second line adds 8px and a control), nothing poking out at either side, and
 * the search there (its field, or its button once it has given way).
 */
export async function expectToolbarFits(frame: Locator, width: ListToolbarWidth, options: { search?: boolean } = {}) {
  const toolbar = frame.locator("[data-slot=fit-toolbar]");
  await expect(toolbar).toBeVisible();
  await settled(toolbar);
  const desktop = width.viewport.width >= 768 && !width.touch;
  const lines = desktop ? [44, 86] : [49, 89];
  const box = await frame.boundingBox();
  expect(box, "the toolbar's frame").not.toBeNull();
  expect(lines, `${width.name}: one or two lines of the rule's height (got ${box!.height})`).toContain(Math.round(box!.height));
  const outside = await toolbar.evaluate((root) => {
    const bounds = root.getBoundingClientRect();
    return Array.from(root.querySelectorAll<HTMLElement>("button, input, [role=radio]"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 2 || rect.height <= 2 || getComputedStyle(element).visibility === "hidden") return false;
        // A Select's or Combobox's form value (a visually hidden input), and focus guards, are not controls on the line.
        if (element.closest("[aria-hidden=true]") || (element instanceof HTMLInputElement && element.type === "hidden")) return false;
        // A scrolling group's items may sit past its fade: they scroll, they don't poke out.
        if (element.closest("[data-slot=scroll-area-viewport], .r-scroll-area__viewport")) return false;
        return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const name = element.getAttribute("aria-label") || element.textContent?.trim() || element.outerHTML.slice(0, 80);
        return `${name} [${Math.round(rect.left)}..${Math.round(rect.right)} in ${Math.round(bounds.left)}..${Math.round(bounds.right)}]`;
      });
  });
  expect(outside, `${width.name}: nothing pokes out of the toolbar`).toEqual([]);
  if (options.search !== false) {
    const field = toolbar.locator("[data-fit-search-field] input");
    const button = toolbar.locator("[data-fit-search-button]");
    const shown = (await field.isVisible()) || (await button.isVisible());
    expect(shown, `${width.name}: the search is in the toolbar, as its field or its button`).toBe(true);
  }
}

/**
 * The toolbar is one Tab stop, and the arrow keys walk its controls in
 * reading order (line by line, start to end), as they show: Tab enters at
 * the first control on screen, Right goes on in order, and the next Tab
 * leaves the toolbar.
 */
export async function expectKeyboardReadingOrder(page: Page, frame: Locator) {
  const toolbar = frame.locator("[data-slot=fit-toolbar]");
  // Focus just before the toolbar (its frame, focusable by script only), then Tab in.
  await frame.evaluate((element) => {
    element.tabIndex = -1;
    element.focus();
  });
  await settled(toolbar);
  await page.keyboard.press("Tab");
  const inToolbar = () => toolbar.evaluate((root) => root.contains(document.activeElement));
  await expect.poll(inToolbar, { message: "Tab from just before it enters the toolbar" }).toBe(true);
  // It lands on the first control on screen: the topmost line, its start (a segmented control counts as one).
  const landedFirst = await toolbar.evaluate((root) => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2 && getComputedStyle(element).visibility !== "hidden" && !element.closest("[aria-hidden=true], [inert]");
    };
    const controls = Array.from(root.querySelectorAll<HTMLElement>("button, input:not([type=hidden]), [role=radiogroup]"))
      .filter((element) => visible(element) && !element.parentElement?.closest("[role=radiogroup]"));
    const middle = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return (rect.top + rect.bottom) / 2;
    };
    const top = Math.min(...controls.map(middle));
    const first = controls
      .filter((element) => Math.abs(middle(element) - top) < 12)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    return first !== undefined && (first === document.activeElement || first.contains(document.activeElement));
  });
  expect(landedFirst, "the first Tab lands on the first control on screen").toBe(true);
  // Each step compares the control just left with the one now focused, both measured now: a scrolling filter line
  // moves under the keys, so positions read at different moments don't compare.
  const names: string[] = [];
  for (let step = 0; step < 24; step += 1) {
    const before = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      (window as unknown as { __listToolbarPrevious?: HTMLElement }).__listToolbarPrevious = element;
      return element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName;
    });
    if (names.includes(before) && names.length > 1) break;
    names.push(before);
    await page.keyboard.press("ArrowRight");
    if (!(await inToolbar())) break;
    const order = await page.evaluate(() => {
      const previous = (window as unknown as { __listToolbarPrevious?: HTMLElement }).__listToolbarPrevious!;
      const current = document.activeElement as HTMLElement;
      if (current === previous) return "stayed";
      const a = previous.getBoundingClientRect();
      const b = current.getBoundingClientRect();
      const sameLine = Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 12;
      if (sameLine ? b.left > a.left : b.top > a.top) return "after";
      return `before: ${current.getAttribute("aria-label") || current.textContent?.trim()}`;
    });
    if (order === "stayed") break;
    if (order !== "after") {
      // Base UI's toolbar loops: back to the first control on screen ends the walk; anything else is out of order.
      const loopedToStart = names.length >= 2 && order.startsWith("before") && (await page.evaluate((first) => {
        const element = document.activeElement as HTMLElement;
        return (element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName) === first;
      }, names[0]!));
      expect(loopedToStart, `reading order after ${before}: ${order}`).toBe(true);
      break;
    }
  }
  expect(names.length, "the arrow keys reach more than one control").toBeGreaterThan(1);
  await page.keyboard.press("Tab");
  expect(await inToolbar(), "one Tab stop: the next Tab leaves the toolbar").toBe(false);
}
