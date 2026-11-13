import { expect } from "@playwright/test";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { test } from "../fixtures/scenario";

/**
 * The public server page (`/s/<slug>` for a visitor who is not a member) is a
 * separate page from the signed-in shell, built from the same rui parts: the
 * app shell, the rail, and the Sidebar root and rows. It drifted from the
 * signed-in look more than once because nothing compared the two (62px
 * headers next to 56px ones, a pink selected channel).
 *
 * This spec renders both in one browser, in light and dark, and requires the shared
 * chrome to measure the same: rail, channel-column frame and header, scroll
 * surface, the column width, the selected and unselected channel row, and
 * the channel panel header with the line under it.
 *
 * The signed-in side is the real app on a tenant of its own (it adds a second
 * channel so there is an unselected row to measure). The public side mocks only the
 * three public read endpoints; the page itself is the real built bundle. So
 * this guards the chrome, not the public API.
 *
 * Not compared, because the two differ by design: the top of the window (the
 * signed-in app has a top bar holding the server switcher and search, task
 * #753; the public page keeps the server cell at the top of its rail and the
 * title row at the top of its channel column), column
 * height (the public page has a bottom banner), the header title text, the section label row
 * (the signed-in one is a collapse toggle with a sort menu), and anything
 * below `md`, where the signed-in app switches to tabs.
 */

const THEMES = {
  light: { mode: "light" },
  dark: { mode: "dark" },
} as const;

const PUBLIC_SLUG = "parity-public-fixture";
const PUBLIC_FIXTURE = {
  server: { id: "parity-server", name: "Parity Fixture", slug: PUBLIC_SLUG, avatarUrl: null },
  channels: [
    { id: "parity-channel-1", name: "announcements", description: null },
    { id: "parity-channel-2", name: "general", description: null },
  ],
};

type Surface = "signed-in" | "public";

/** Runs in the page. Returns only values that must match across the two surfaces. */
function measureChrome(surface: Surface) {
  const style = (el: Element, keys: string[]) => {
    const computed = getComputedStyle(el) as unknown as Record<string, string>;
    return Object.fromEntries(keys.map((key) => [key, computed[key]]));
  };
  const height = (el: Element) => Math.round(el.getBoundingClientRect().height * 10) / 10;
  const need = <T,>(value: T | null | undefined, what: string): T => {
    if (value == null) throw new Error(`parity probe: ${what} not found on the ${surface} surface`);
    return value;
  };

  const rail = need(document.querySelector('[data-slot="app-rail-root"]'), "rail");
  const sidebar = need(
    surface === "public"
      ? document.querySelector('[data-testid="public-server-channel-sidebar-root"]')
      : document.querySelector('[data-testid="sidebar-root"]'),
    "channel column",
  );
  const scroller = need(
    sidebar.querySelector(
      surface === "public" ? '[data-testid="public-server-channel-list"]' : '[data-testid="sidebar-scroll-surface"]',
    ),
    "scroll surface",
  );
  const rows = [
    ...sidebar.querySelectorAll(surface === "public" ? "[data-public-channel-id]" : "[data-sidebar-channel-id]"),
  ];
  const activeRow = need(rows.find((row) => row.hasAttribute("data-active")), "selected channel row");
  const idleRow = need(rows.find((row) => !row.hasAttribute("data-active")), "unselected channel row");

  // The line under the channel header is drawn by the conversation panel frame
  // around it, not by the header, so a header placed outside that frame keeps
  // its classes and silently loses the line.
  const main = need(document.querySelector('[data-slot="app-shell-main-slot"]'), "main column");
  const panelHeader = need(main.querySelector('[data-slot="panel-header"]'), "channel panel header");
  const panelFrame = need(panelHeader.parentElement, "channel panel frame");

  const ROW = [
    "backgroundColor", "color", "borderTopWidth", "borderTopColor", "borderRadius", "boxShadow",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginBottom", "columnGap",
    "fontSize", "fontWeight",
  ];
  const rowIcon = (row: Element) => {
    const icon = need(row.querySelector("svg"), "channel row icon");
    const box = icon.getBoundingClientRect();
    return { width: box.width, height: box.height, color: getComputedStyle(icon).color };
  };

  // Only the public page has these two: the server cell at the top of the rail
  // and the title row at the top of the channel column. The signed-in app moved
  // the first into the top bar and dropped the second with it (task #753).
  const publicOnly = () => {
    const railHeader = need(rail.querySelector('[data-slot="app-rail-header"]'), "rail header");
    const header = need(
      [...sidebar.children].find((child) => child.getAttribute("data-slot") === "sidebar-header"),
      "channel column header",
    );
    return { railHeaderHeight: height(railHeader), headerHeight: height(header) };
  };

  return {
    rail: { width: rail.getBoundingClientRect().width, ...style(rail, ["backgroundColor"]) },
    ...(surface === "public" ? publicOnly() : {}),
    // Both columns are resizable; each test starts from a fresh browser context, so both sit at the default width.
    column: {
      width: sidebar.getBoundingClientRect().width,
      ...style(sidebar, ["backgroundColor", "borderRightWidth", "borderRightColor"]),
    },
    panelHeader: {
      height: height(panelHeader),
      ...style(panelHeader, ["borderBottomWidth", "borderBottomColor", "backgroundColor"]),
      frameBackgroundColor: getComputedStyle(panelFrame).backgroundColor,
    },
    scroller: style(scroller, ["paddingLeft", "paddingRight", "paddingTop"]),
    activeRow: { height: height(activeRow), ...style(activeRow, ROW), icon: rowIcon(activeRow) },
    idleRow: { height: height(idleRow), ...style(idleRow, ROW), icon: rowIcon(idleRow) },
  };
}

async function settle(page: Page) {
  // Row and hairline colours transition; sample the resting state, with the
  // pointer parked away from every row.
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.mouse.move(900, 500);
}

async function createChannel(
  request: APIRequestContext,
  apiUrl: string,
  serverId: string,
  accessToken: string,
  name: string,
) {
  const response = await request.post(`${apiUrl}/api/channels`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Server-Id": serverId },
    data: { name },
  });
  if (!response.ok()) throw new Error(`Failed to create channel: ${response.status()} ${response.statusText()}`);
}

async function measureSignedIn(page: Page, webUrl: string, serverSlug: string, channelId: string) {
  await page.goto(`${webUrl}/s/${serverSlug}`);
  const seedRow = page.locator(`[data-sidebar-channel-id="${channelId}"]`);
  await expect(seedRow).toBeVisible({ timeout: 20_000 });
  await seedRow.click();
  await expect(seedRow).toHaveAttribute("data-active", "true");
  await settle(page);
  return page.evaluate(measureChrome, "signed-in" as Surface);
}

async function measurePublic(browser: Browser, webUrl: string, theme: (typeof THEMES)[keyof typeof THEMES]) {
  // A fresh context with no session: the visitor is anonymous.
  const context = await browser.newContext({ storageState: undefined, viewport: { width: 1280, height: 800 } });
  try {
    await context.addInitScript((prefs) => {
      localStorage.setItem("slock-theme-preferences-v2", JSON.stringify(prefs));
    }, theme);
    const page = await context.newPage();
    const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    await page.route(`**/api/public/servers/${PUBLIC_SLUG}`, (route) => route.fulfill(json(PUBLIC_FIXTURE)));
    await page.route(`**/api/public/servers/${PUBLIC_SLUG}/channels/*/messages*`, (route) =>
      route.fulfill(json({ messages: [] })));
    await page.goto(`${webUrl}/s/${PUBLIC_SLUG}`);
    await expect(page.getByTestId("public-server-page")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-public-channel-id][data-active]")).toHaveCount(1);
    await settle(page);
    const chrome = await page.evaluate(measureChrome, "public" as Surface);
    const mainHeaderHeight = await page
      .getByTestId("public-server-channel-header")
      .evaluate((el) => Math.round(el.getBoundingClientRect().height * 10) / 10);
    // The bottom banner sits under the conversation only (Cindy, #wg-rbac task
    // #123): it starts where the channel column ends and runs to the window's
    // right edge, and the channel column keeps the full height beside it.
    const bannerPlacement = await page.evaluate(() => {
      const box = (testId: string) => {
        const el = document.querySelector(`[data-testid="${testId}"]`);
        if (!el) throw new Error(`banner placement probe: ${testId} not found`);
        return el.getBoundingClientRect();
      };
      const banner = box("public-server-bottom-action");
      const column = box("public-server-channel-sidebar-root");
      return {
        startsAtColumnEdge: Math.abs(banner.left - column.right) <= 0.5,
        reachesWindowRight: Math.abs(banner.right - window.innerWidth) <= 0.5,
        sitsAtWindowBottom: Math.abs(banner.bottom - window.innerHeight) <= 0.5,
        columnRunsFullHeight: Math.abs(column.bottom - window.innerHeight) <= 0.5,
      };
    });
    expect(bannerPlacement, "public bottom banner placement").toEqual({
      startsAtColumnEdge: true,
      reachesWindowRight: true,
      sitsAtWindowBottom: true,
      columnRunsFullHeight: true,
    });
    return { chrome, mainHeaderHeight };
  } finally {
    await context.close();
  }
}

test.describe("public server page matches the signed-in chrome", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const [themeName, theme] of Object.entries(THEMES)) {
    test(`${themeName}: rail, channel column and rows measure the same`, async ({ page, browser, request, scenario }) => {
      const seedState = scenario.seed;
      await createChannel(request, seedState.urls.api, seedState.server.id, scenario.login.accessToken, "parity-second");
      await page.addInitScript((prefs) => {
        localStorage.setItem("slock-theme-preferences-v2", JSON.stringify(prefs));
      }, theme);

      const signedIn = await measureSignedIn(page, seedState.urls.web, seedState.server.slug, seedState.channel.id);
      const publicPage = await measurePublic(browser, seedState.urls.web, theme);

      // The rail's server cell and the channel column's title row exist only on
      // the public page, so they are not part of the comparison; their heights
      // are still checked against the public page's own channel header below.
      const { railHeaderHeight: publicRailHeaderHeight, headerHeight: publicHeaderHeight, ...publicChrome } = publicPage.chrome;
      expect(publicChrome, "public page chrome must measure like the signed-in chrome").toEqual(signedIn);
      // The three header rows of the public page share one baseline.
      expect(publicPage.mainHeaderHeight, "public channel header height").toBe(publicHeaderHeight);
      expect(publicRailHeaderHeight, "public rail header height").toBe(publicHeaderHeight);
    });
  }
});

/** Runs in the page. Where a floating notice sits and whether it holds its own content. */
function measureFloatingNotice(testId: string) {
  const notice = document.querySelector(`[data-testid="${testId}"]`);
  if (!notice) throw new Error(`floating notice ${testId} not found`);
  const box = notice.getBoundingClientRect();
  const text = notice.querySelector('[data-slot="banner-description"]');
  if (!text) throw new Error(`floating notice ${testId} has no text`);
  const textBox = text.getBoundingClientRect();
  const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
  const action = notice.querySelector("button")?.getBoundingClientRect() ?? null;
  return {
    width: Math.round(box.width),
    viewportWidth: window.innerWidth,
    centreOffset: Math.round((box.left + box.right) / 2 - window.innerWidth / 2),
    textLines: Math.round(textBox.height / lineHeight),
    actionInside: action ? action.left >= box.left && action.right <= box.right : null,
  };
}

function expectReadableFloatingNotice(notice: ReturnType<typeof measureFloatingNotice>, what: string) {
  // The rui Banner is a size container: left without a width it collapses to
  // one character per line, or spans the window.
  expect(notice.width, `${what}: wide enough to read`).toBeGreaterThanOrEqual(Math.min(320, notice.viewportWidth - 32));
  expect(notice.width, `${what}: a notice, not a full-width strip`).toBeLessThanOrEqual(Math.min(480, notice.viewportWidth - 32));
  expect(notice.centreOffset, `${what}: centred in the window`).toBe(0);
  expect(notice.textLines, `${what}: text wraps to a few lines at most`).toBeLessThanOrEqual(3);
}

// The close button sits in the notice's top-right corner: inside the notice,
// a clickable size, and clear of the text (pr-10 keeps the text out of it).
async function expectCloseButtonInside(page: Page, noticeTestId: string) {
  const notice = await page.getByTestId(noticeTestId).boundingBox();
  const close = await page.getByTestId(`${noticeTestId}-close`).boundingBox();
  if (!notice || !close) throw new Error(`${noticeTestId}: notice or its close button has no box`);
  expect(close.width, "close button has a clickable size").toBeGreaterThanOrEqual(24);
  expect(close.x, "close button starts inside the notice").toBeGreaterThanOrEqual(notice.x);
  expect(close.x + close.width, "close button ends inside the notice").toBeLessThanOrEqual(notice.x + notice.width + 0.5);
  expect(close.y, "close button top inside the notice").toBeGreaterThanOrEqual(notice.y);
  expect(close.y + close.height, "close button bottom inside the notice").toBeLessThanOrEqual(notice.y + notice.height + 0.5);
  expect(close.y - notice.y, "close button sits at the top, not on a row of its own").toBeLessThanOrEqual(12);
  // The text column, not the current text: a longer message (a server's own
  // error) wraps inside this box, so the box must end before the button.
  const textRight = await page.getByTestId(noticeTestId).evaluate((el) =>
    el.querySelector('[data-slot="banner-description"]')?.getBoundingClientRect().right ?? null);
  expect(textRight, "the notice text is measurable").not.toBeNull();
  expect(textRight!, "the text column ends before the close button").toBeLessThanOrEqual(close.x + 0.5);
}

test.describe("public server page floating notices keep a readable width and can be closed", () => {
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

  for (const [themeName, theme] of Object.entries(THEMES)) {
    for (const width of [1280, 800]) {
      test(`${themeName} ${width}: sign-in notice from the server cell`, async ({ browser, scenario }) => {
        const context = await browser.newContext({ storageState: undefined, viewport: { width, height: 800 } });
        try {
          await context.addInitScript((prefs) => {
            localStorage.setItem("slock-theme-preferences-v2", JSON.stringify(prefs));
          }, theme);
          const page = await context.newPage();
          await page.route(`**/api/public/servers/${PUBLIC_SLUG}`, (route) => route.fulfill(json(PUBLIC_FIXTURE)));
          await page.route(`**/api/public/servers/${PUBLIC_SLUG}/channels/*/messages*`, (route) =>
            route.fulfill(json({ messages: [] })));
          await page.goto(`${scenario.seed.urls.web}/s/${PUBLIC_SLUG}`);
          await expect(page.getByTestId("public-server-page")).toBeVisible({ timeout: 20_000 });
          await page.getByTestId("public-server-switcher-trigger").click();
          await expect(page.getByTestId("public-server-selection-notice")).toBeVisible();
          await settle(page);

          const notice = await page.evaluate(measureFloatingNotice, "public-server-selection-notice");
          expectReadableFloatingNotice(notice, "sign-in notice");
          expect(notice.actionInside, "the Sign in button sits inside the notice").toBe(true);

          await expectCloseButtonInside(page, "public-server-selection-notice");
          await page.getByTestId("public-server-selection-notice-close").click();
          await expect(page.getByTestId("public-server-selection-notice")).toHaveCount(0);
          await expect(page.getByTestId("public-server-switcher-trigger"), "focus returns to the server cell").toBeFocused();
          // Closing is not permanent: the same click brings it back.
          await page.getByTestId("public-server-switcher-trigger").click();
          await expect(page.getByTestId("public-server-selection-notice")).toBeVisible();
        } finally {
          await context.close();
        }
      });
    }
  }
});

// Phones show one column at a time, like the signed-in app (Cindy, #wg-rbac
// task #123): the channel list, then the channel full width with a back
// button. Side by side, the list left the messages ~246px on a 390px phone.
test.describe("public server page on a phone shows one column at a time", () => {
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  const sender = { displayName: "Ada Lovelace", avatarUrl: null, description: null };
  const parent = {
    id: "phone-parent", senderType: "user", sender, messageType: "chat", content: "Shall we ship on Friday?",
    createdAt: "2026-10-01T09:00:00.000Z", threadId: "phone-thread", replyCount: 1, lastReplyAt: "2026-10-01T09:05:00.000Z",
    latestReplies: [{ messageId: "phone-reply", seq: 2, preview: "Friday works.", senderType: "user", senderName: "Grace Hopper", senderAvatarUrl: null, createdAt: "2026-10-01T09:05:00.000Z" }],
  };
  const reply = { ...parent, id: "phone-reply", content: "Friday works.", threadId: null, replyCount: 0, lastReplyAt: null, latestReplies: [], sender: { ...sender, displayName: "Grace Hopper" } };

  type Box = { left: number; width: number } | null;
  const box = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el): Box => {
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { left: Math.round(r.left), width: Math.round(r.width) } : null;
  });
  // The element a tap at the control's own centre would reach: proves nothing paints over it.
  const tapReaches = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && el.contains(hit);
  });

  for (const [themeName, theme] of Object.entries(THEMES)) {
    test(`${themeName} 390: list, then channel, then thread, and back`, async ({ browser, scenario }) => {
      const context = await browser.newContext({ storageState: undefined, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      try {
        await context.addInitScript((prefs) => {
          localStorage.setItem("slock-theme-preferences-v2", JSON.stringify(prefs));
        }, theme);
        const page = await context.newPage();
        await page.route(`**/api/public/servers/${PUBLIC_SLUG}`, (route) => route.fulfill(json(PUBLIC_FIXTURE)));
        await page.route(`**/api/public/servers/${PUBLIC_SLUG}/channels/*/messages*`, (route) => route.fulfill(json({ messages: [parent] })));
        await page.route(`**/api/public/servers/${PUBLIC_SLUG}/threads/*/messages*`, (route) => route.fulfill(json({ messages: [reply] })));
        await page.goto(`${scenario.seed.urls.web}/s/${PUBLIC_SLUG}`);
        await expect(page.getByTestId("public-server-page")).toBeVisible({ timeout: 20_000 });

        // 1. The list, full width; no channel beside it.
        await expect(page.getByTestId("public-server-channel-sidebar")).toBeVisible();
        expect(await box(page, "public-server-channel-sidebar"), "the list takes the whole width").toEqual({ left: 0, width: 390 });
        await expect(page.getByTestId("public-server-channel-panel")).toBeHidden();

        // 2. A channel, full width, with a back button that is reachable.
        await page.locator("[data-public-channel-id]", { hasText: "general" }).tap();
        await expect(page.getByTestId("public-server-channel-sidebar")).toBeHidden();
        expect(await box(page, "public-server-channel-panel"), "the channel takes the whole width").toEqual({ left: 0, width: 390 });
        await expect(page.getByTestId("public-server-phone-back")).toHaveAccessibleName(/back to channels/i);
        expect(await tapReaches(page, "public-server-phone-back")).toBe(true);

        // 3. A thread covers the channel, and its own back button is not under the channel header.
        await page.getByTestId("public-server-message-row").getByRole("button", { name: /repl/i }).first().tap();
        await expect(page.getByTestId("public-server-thread-panel")).toBeVisible();
        expect(await tapReaches(page, "thread-mobile-back"), "the channel header must not paint over the thread header").toBe(true);
        await page.getByTestId("thread-mobile-back").tap();
        await expect(page.getByTestId("public-server-thread-panel")).toHaveCount(0);

        // 4. Back to the list.
        await page.getByTestId("public-server-phone-back").tap();
        await expect(page.getByTestId("public-server-channel-sidebar")).toBeVisible();
        await expect(page.getByTestId("public-server-channel-panel")).toBeHidden();
      } finally {
        await context.close();
      }
    });
  }

  // From 640px the columns sit side by side; with a thread open the channel
  // column is squeezed and its header (sticky z-30 below 768px) overflowed
  // onto the thread's back button (Cyan's boundary review).
  for (const width of [639, 640]) {
    test(`light ${width}: the thread's back button is not under the channel header`, async ({ browser, scenario }) => {
      const context = await browser.newContext({ storageState: undefined, viewport: { width, height: 800 } });
      try {
        await context.addInitScript((prefs) => {
          localStorage.setItem("slock-theme-preferences-v2", JSON.stringify(prefs));
        }, THEMES.light);
        const page = await context.newPage();
        await page.route(`**/api/public/servers/${PUBLIC_SLUG}`, (route) => route.fulfill(json(PUBLIC_FIXTURE)));
        await page.route(`**/api/public/servers/${PUBLIC_SLUG}/channels/*/messages*`, (route) => route.fulfill(json({ messages: [parent] })));
        await page.route(`**/api/public/servers/${PUBLIC_SLUG}/threads/*/messages*`, (route) => route.fulfill(json({ messages: [reply] })));
        await page.goto(`${scenario.seed.urls.web}/s/${PUBLIC_SLUG}`);
        await expect(page.getByTestId("public-server-page")).toBeVisible({ timeout: 20_000 });
        await page.locator("[data-public-channel-id]", { hasText: "general" }).click();
        await page.getByTestId("public-server-message-row").getByRole("button", { name: /repl/i }).first().click();
        await expect(page.getByTestId("public-server-thread-panel")).toBeVisible();
        expect(await tapReaches(page, "thread-mobile-back")).toBe(true);
        await page.getByTestId("thread-mobile-back").click();
        await expect(page.getByTestId("public-server-thread-panel")).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  }

  for (const [themeName, theme] of Object.entries(THEMES)) {
    test(`${themeName} 390: the bottom banner puts its buttons under the copy, at the end`, async ({ browser, scenario }) => {
      const context = await browser.newContext({ storageState: undefined, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      try {
        await context.addInitScript((prefs) => {
          localStorage.setItem("slock-theme-preferences-v2", JSON.stringify(prefs));
        }, theme);
        const page = await context.newPage();
        await page.route(`**/api/public/servers/${PUBLIC_SLUG}`, (route) => route.fulfill(json(PUBLIC_FIXTURE)));
        await page.route(`**/api/public/servers/${PUBLIC_SLUG}/channels/*/messages*`, (route) => route.fulfill(json({ messages: [parent] })));
        await page.goto(`${scenario.seed.urls.web}/s/${PUBLIC_SLUG}`);
        const banner = page.getByTestId("public-server-bottom-action");
        await expect(banner).toBeVisible({ timeout: 20_000 });
        const m = await banner.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const copy = el.querySelector("[data-testid=public-server-bottom-action-copy]")!.getBoundingClientRect();
          const buttons = [...el.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
          return {
            buttons: buttons.length,
            copyWidth: copy.width,
            width: r.width,
            buttonsBelowCopy: buttons.every((b) => b.top >= copy.bottom),
            endsAtRight: Math.max(...buttons.map((b) => b.right)),
            right: r.right,
            fontSize: getComputedStyle(el.querySelector("[data-testid=public-server-bottom-action-copy]")!).fontSize,
            inside: buttons.every((b) => b.right <= r.right + 0.5),
          };
        });
        expect(m.buttons).toBe(2);
        // stdrc (option B of the raft-ui 0.22.0 review): the Banner's own rule
        // on a phone. The sentence, 14px like every sm banner, takes the full
        // width and the buttons go on a row under it, at the end. Forced beside
        // the copy (task #123) the sentence was squeezed into ~175px at 12px.
        expect(m.fontSize).toBe("14px");
        expect(m.buttonsBelowCopy, "both buttons sit under the copy").toBe(true);
        expect(m.copyWidth, "the copy takes the banner's width").toBeGreaterThan(m.width * 0.6);
        expect(m.inside).toBe(true);
        expect(m.right - m.endsAtRight, "the buttons end at the banner's padding").toBeLessThanOrEqual(24);
      } finally {
        await context.close();
      }
    });
  }

  test("800: list and channel side by side, no back button", async ({ browser, scenario }) => {
    const context = await browser.newContext({ storageState: undefined, viewport: { width: 800, height: 800 } });
    try {
      const page = await context.newPage();
      await page.route(`**/api/public/servers/${PUBLIC_SLUG}`, (route) => route.fulfill(json(PUBLIC_FIXTURE)));
      await page.route(`**/api/public/servers/${PUBLIC_SLUG}/channels/*/messages*`, (route) => route.fulfill(json({ messages: [parent] })));
      await page.goto(`${scenario.seed.urls.web}/s/${PUBLIC_SLUG}`);
      await expect(page.getByTestId("public-server-page")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("public-server-channel-sidebar")).toBeVisible();
      await expect(page.getByTestId("public-server-channel-panel")).toBeVisible();
      await expect(page.getByTestId("public-server-phone-back")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

// One divider between the conversation and the thread, as in the signed-in
// app (cindyz, #wg-rbac task #126). The thread column drew its own left border
// on top of the thread panel's, two lines where there should be one.
test.describe("public server page draws one divider before the thread", () => {
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  const sender = { displayName: "Ada Lovelace", avatarUrl: null, description: null };
  const parent = {
    id: "divider-parent", senderType: "user", sender, messageType: "chat", content: "Shall we ship on Friday?",
    createdAt: "2026-10-01T09:00:00.000Z", threadId: "divider-thread", replyCount: 1, lastReplyAt: "2026-10-01T09:05:00.000Z",
    latestReplies: [{ messageId: "divider-reply", seq: 2, preview: "Friday works.", senderType: "user", senderName: "Grace Hopper", senderAvatarUrl: null, createdAt: "2026-10-01T09:05:00.000Z" }],
  };
  const reply = { ...parent, id: "divider-reply", content: "Friday works.", threadId: null, replyCount: 0, lastReplyAt: null, latestReplies: [] };

  for (const [themeName, theme] of Object.entries(THEMES)) {
    test(`${themeName} 1280: exactly one vertical line at the thread's left edge`, async ({ browser, scenario }) => {
      const context = await browser.newContext({ storageState: undefined, viewport: { width: 1280, height: 800 } });
      try {
        await context.addInitScript((prefs) => {
          localStorage.setItem("slock-theme-preferences-v2", JSON.stringify(prefs));
        }, theme);
        const page = await context.newPage();
        await page.route(`**/api/public/servers/${PUBLIC_SLUG}`, (route) => route.fulfill(json(PUBLIC_FIXTURE)));
        await page.route(`**/api/public/servers/${PUBLIC_SLUG}/channels/*/messages*`, (route) => route.fulfill(json({ messages: [parent] })));
        await page.route(`**/api/public/servers/${PUBLIC_SLUG}/threads/*/messages*`, (route) => route.fulfill(json({ messages: [reply] })));
        await page.goto(`${scenario.seed.urls.web}/s/${PUBLIC_SLUG}`);
        await expect(page.getByTestId("public-server-page")).toBeVisible({ timeout: 20_000 });
        await page.getByTestId("public-server-message-row").getByRole("button", { name: /repl/i }).first().click();
        const panel = page.getByTestId("public-server-thread-panel");
        await expect(panel).toBeVisible();
        // Every painted left/right border within 4px of the thread's left edge,
        // on any element at least half the panel's height.
        const lines = await panel.evaluate((slot) => {
          const edge = slot.getBoundingClientRect().left;
          const found: string[] = [];
          for (const el of document.querySelectorAll("body *")) {
            const r = el.getBoundingClientRect();
            if (r.height < slot.getBoundingClientRect().height / 2) continue;
            const cs = getComputedStyle(el);
            for (const [side, x] of [["Left", r.left], ["Right", r.right]] as const) {
              const w = parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`));
              const color = cs.getPropertyValue(`border-${side.toLowerCase()}-color`);
              if (w > 0 && cs.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none" && !/(, 0\)|\/ 0\))$/.test(color) && Math.abs(x - edge) <= 4) {
                found.push(`${el.getAttribute("data-testid") ?? el.tagName} ${side} ${w}px`);
              }
            }
          }
          return found;
        });
        expect(lines, `lines at the thread edge: ${lines.join(", ")}`).toHaveLength(1);

        // Hovering a divider shows the Raft DS Resizable hover state, as in the
        // signed-in app (task #139): the resize cursor and a 1px line over the
        // seam. At rest the handle draws nothing (the "idle" shot equals a page
        // without hover); the hover shot must differ from it.
        await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important}" });
        for (const testId of ["public-server-channel-sidebar-resize-handle", "public-server-thread-panel-resize-handle"]) {
          const handle = page.getByTestId(testId);
          const box = (await handle.boundingBox())!;
          const clip = { x: box.x - 8, y: box.y + 200, width: box.width + 16, height: 120 };
          await page.mouse.move(640, 790);
          const idle = await page.screenshot({ clip });
          await page.mouse.move(box.x + box.width / 2, box.y + 260);
          expect(await handle.evaluate((el) => getComputedStyle(el).cursor)).toBe("col-resize");
          const hovered = await page.screenshot({ clip });
          expect(Buffer.compare(idle, hovered), `${testId}: hovering darkens the seam`).not.toBe(0);
        }
      } finally {
        await context.close();
      }
    });
  }
});

// Hands task #72 / task #754: on a phone, mobile Chrome's 100vh (toolbar hidden)
// is taller than the visible height while the toolbar shows. The page root had
// `min-h-screen` next to `h-dvh`, so it grew past the visible height and its
// overflow-hidden clipped the bottom banner's "Join as guest". Headless
// Chromium keeps 100vh equal to the visible height (measured: 100vh, 100dvh,
// 100svh, 100lvh and visualViewport all 700 at 390x700 with a taller screen),
// so the toolbar state itself cannot be reproduced here. What is pinned:
//   - nothing gives the root a minimum height of its own (computed min-height
//     0px): a 100vh minimum is exactly what overrode the visible height;
//   - its height is the visible viewport, the page does not scroll, and the
//     banner's buttons are fully on screen and receive the tap.
test.describe("public server page fits the visible viewport on phones", () => {
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  for (const viewport of [{ width: 390, height: 700 }, { width: 360, height: 600 }]) {
    test(`${viewport.width}x${viewport.height}: the root is the visible height and the Join button is on screen`, async ({ browser, scenario }) => {
      const context = await browser.newContext({ storageState: undefined, viewport, hasTouch: true, isMobile: true });
      try {
        const page = await context.newPage();
        await page.route(`**/api/public/servers/${PUBLIC_SLUG}`, (route) => route.fulfill(json(PUBLIC_FIXTURE)));
        await page.route(`**/api/public/servers/${PUBLIC_SLUG}/channels/*/messages*`, (route) => route.fulfill(json({ messages: [] })));
        await page.goto(`${scenario.seed.urls.web}/s/${PUBLIC_SLUG}`);
        const root = page.getByTestId("public-server-page");
        await expect(root).toBeVisible({ timeout: 20_000 });
        const m = await root.evaluate((el) => {
          const cs = getComputedStyle(el);
          const banner = document.querySelector("[data-testid=public-server-bottom-action]")!.getBoundingClientRect();
          const buttons = [...document.querySelectorAll("[data-testid=public-server-bottom-action] button")].map((b) => {
            const r = b.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return { bottom: r.bottom, reached: hit !== null && b.contains(hit) };
          });
          return {
            minHeight: cs.minHeight,
            rootHeight: el.getBoundingClientRect().height,
            visible: window.visualViewport?.height ?? window.innerHeight,
            pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
            bannerBottom: banner.bottom,
            buttons,
          };
        });
        expect(m.minHeight, "no minimum height of its own (a 100vh minimum overrode the visible height)").toBe("0px");
        expect(Math.abs(m.rootHeight - m.visible)).toBeLessThanOrEqual(1);
        expect(m.pageScrolls, "no page-level scroll").toBe(false);
        expect(m.bannerBottom).toBeLessThanOrEqual(m.visible + 0.5);
        expect(m.buttons.length).toBe(2);
        for (const b of m.buttons) {
          expect(b.bottom, "button fully on screen").toBeLessThanOrEqual(m.visible + 0.5);
          expect(b.reached, "a tap at the button's centre reaches it").toBe(true);
        }
      } finally {
        await context.close();
      }
    });
  }
});

/**
 * Runs in the page. The divider between the settings list and the settings
 * panel, measured on the two elements that could draw it: the list column's
 * right edge and the panel frame's left edge. cindyz (#wg-rbac:dadde6b1): one
 * 1px seam, from top to bottom, like the channel page.
 */
function measureSettingsDivider(columnTestId: string) {
  const column = document.querySelector(`[data-testid="${columnTestId}"]`);
  const frame = document.querySelector('[data-testid="settings-panel-frame"]');
  if (!column || !frame) throw new Error(`settings divider probe: ${column ? "panel frame" : columnTestId} not found`);
  const px = (el: Element, side: "Right" | "Left") => {
    const s = getComputedStyle(el) as unknown as Record<string, string>;
    return s[`border${side}Style`] === "none" ? 0 : Number.parseFloat(s[`border${side}Width`]);
  };
  const c = column.getBoundingClientRect();
  const f = frame.getBoundingClientRect();
  // The frame fills the area it sits in (on the public page that area ends at
  // the bottom banner), so the divider runs the whole height of the content.
  const area = frame.parentElement!.getBoundingClientRect();
  return {
    lineWidth: px(column, "Right") + px(frame, "Left"),
    frameFillsItsArea: Math.abs(f.height - area.height) <= 1,
    frameStartsAtColumnEdge: Math.abs(f.left - c.right) <= 0.5,
  };
}

test.describe("settings divider is one line, top to bottom, signed in and on the public page", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  for (const [themeName, theme] of Object.entries(THEMES)) {
    test(`${themeName}: 1px`, async ({ page, browser, scenario }) => {
      const expected = { lineWidth: 1, frameFillsItsArea: true, frameStartsAtColumnEdge: true };

      await page.addInitScript((prefs) => {
        localStorage.setItem("slock-theme-preferences-v2", JSON.stringify(prefs));
      }, theme);
      await page.goto(`${scenario.seed.urls.web}/s/${scenario.seed.server.slug}/settings/about`);
      await expect(page.getByTestId("settings-panel-frame")).toBeVisible({ timeout: 20_000 });
      await settle(page);
      expect(await page.evaluate(measureSettingsDivider, "sidebar-root"), "signed-in settings divider").toEqual(expected);

      const context = await browser.newContext({ storageState: undefined, viewport: { width: 1280, height: 800 } });
      try {
        await context.addInitScript((prefs) => {
          localStorage.setItem("slock-theme-preferences-v2", JSON.stringify(prefs));
        }, theme);
        const visitor = await context.newPage();
        const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
        await visitor.route(`**/api/public/servers/${PUBLIC_SLUG}`, (route) => route.fulfill(json(PUBLIC_FIXTURE)));
        await visitor.route(`**/api/public/servers/${PUBLIC_SLUG}/channels/*/messages*`, (route) =>
          route.fulfill(json({ messages: [] })));
        await visitor.goto(`${scenario.seed.urls.web}/s/${PUBLIC_SLUG}`);
        await expect(visitor.getByTestId("public-server-page")).toBeVisible({ timeout: 20_000 });
        await visitor.getByTestId("left-rail-settings").click();
        await expect(visitor.getByTestId("settings-panel-frame")).toBeVisible();
        await settle(visitor);
        // The About tab is short: the frame must still fill the column, or the
        // divider stops where the content does.
        expect(await visitor.evaluate(measureSettingsDivider, "public-server-settings-sidebar-root"), "public settings divider").toEqual(expected);
      } finally {
        await context.close();
      }
    });
  }
});
