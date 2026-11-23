// Captures the built-in browser's tab strip with pinned tabs (main.tsx here) from a running vite dev server
// (packages/web), and measures what the look depends on: every tab and control wholly inside the head, no two of
// them overlapping, the grip clear of the strip, a pinned tab's icon whole inside its tab, the menu inside the
// window and known to the page's place as an overlay.
//   node visual-testing/desktop-browser-tabs/desktop-browser-tabs.shot.mjs <baseUrl> <outDir>
// CHROMIUM_PATH names another browser binary than Playwright's own.
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");

const base = process.argv[2] ?? "http://127.0.0.1:5199";
const outDir = process.argv[3] ?? "/var/tmp/raft-ubuntu/desktop-browser-tabs-shots";
// name, query, the tab whose menu is opened (null: none).
const CASES = [
  ["strip-own-front", "width=760&pinned=2&own=3&front=t2", null],
  ["strip-pinned-front", "width=760&pinned=2&own=3&front=p1", null],
  ["menu-own-tab", "width=760&pinned=2&own=3&front=t2", "t2"],
  ["menu-pinned-tab", "width=760&pinned=2&own=3&front=t2", "p2"],
  ["narrow-overflow", "width=420&pinned=2&own=6&front=t5", null],
  ["pinned-only", "width=760&pinned=2&own=0&front=p2", null],
  // The address row with the site settings button before the address (#proj-workspace:#316), https and http.
  ["address-site", "width=760&pinned=0&own=3&front=t1&site=1", null],
  ["address-site-insecure", "width=760&pinned=0&own=3&front=t2&site=1", null],
];
const round = (box) => (box ? Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Math.round(value * 10) / 10])) : null);
const inside = (inner, outer, slack = 0.5) => inner.x >= outer.x - slack && inner.y >= outer.y - slack
  && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;
const overlap = (a, b) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  args: ["--disable-dev-shm-usage", "--no-sandbox"],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const results = [];
let failed = false;
try {
  for (const [name, query, menuTab] of CASES) {
    for (const mode of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width: 820, height: 420 }, colorScheme: mode, deviceScaleFactor: 2 });
      page.on("pageerror", (error) => console.error("pageerror", error.message));
      await page.goto(`${base}/visual-testing/desktop-browser-tabs/index.html?mode=${mode}&${query}`, { waitUntil: "networkidle" });
      await page.getByTestId("web-preview-tab-strip").waitFor({ state: "visible", timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      const head = await page.getByTestId("web-preview-header").boundingBox();
      const boxes = await page.evaluate(() => {
        const box = (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        const all = (selector) => [...document.querySelectorAll(selector)].map(box);
        const grip = document.querySelector("[data-side-grip]");
        return {
          slots: [...document.querySelectorAll('[data-testid="web-preview-tab-slot"]')].map((slot) => ({
            id: slot.getAttribute("data-tab-id"),
            pinned: slot.querySelector("[data-pinned]") !== null,
            box: box(slot),
            tab: box(slot.querySelector('[role="tab"]')),
            icon: slot.querySelector("svg") ? box(slot.querySelector("svg")) : null,
            close: slot.querySelector('[data-testid="web-preview-tab-close"]') ? box(slot.querySelector('[data-testid="web-preview-tab-close"]')) : null,
            label: slot.querySelector('[data-testid="web-preview-tab-label"]') ? box(slot.querySelector('[data-testid="web-preview-tab-label"]')) : null,
          })),
          controls: all('[data-testid="web-preview-more-tabs"], [data-testid="web-preview-new-tab"], [data-testid="web-preview-close"]'),
          grip: grip ? box(grip) : null,
        };
      });
      const problems = [];
      const things = [...boxes.slots.map((slot) => ({ name: slot.id, box: slot.box })), ...boxes.controls.map((box, index) => ({ name: `control${index}`, box }))];
      for (const thing of things) if (!inside(thing.box, head)) problems.push(`${thing.name} outside the head`);
      for (const [index, a] of things.entries()) for (const b of things.slice(index + 1)) if (overlap(a.box, b.box)) problems.push(`${a.name} overlaps ${b.name}`);
      if (boxes.grip) for (const thing of things) if (overlap(boxes.grip, thing.box)) problems.push(`the grip overlaps ${thing.name}`);
      for (const slot of boxes.slots) {
        if (!slot.icon || !inside(slot.icon, slot.tab)) problems.push(`${slot.id}: icon not whole inside its tab`);
        if (slot.pinned && (slot.close || slot.label)) problems.push(`${slot.id}: a pinned tab shows a title or a close button`);
        if (slot.pinned && Math.abs((slot.icon.x + slot.icon.width / 2) - (slot.tab.x + slot.tab.width / 2)) > 0.6) problems.push(`${slot.id}: icon not centred`);
        if (!slot.pinned && slot.close && !inside(slot.close, slot.box)) problems.push(`${slot.id}: close button outside its tab`);
      }
      // The address row: a button embedded at either end of the field sits 6px inside it, and the address (or the
      // Not secure badge) starts 8px after the site settings button.
      const address = await page.evaluate(() => {
        const box = (element) => { if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        const settings = document.querySelector('[data-testid="web-preview-site-settings"]');
        return {
          field: box(settings?.closest('[data-slot="input-group"]') ?? document.querySelector('[data-testid="web-preview-open-tab"]')?.closest('[data-slot="input-group"]')),
          settings: box(settings),
          badge: box(document.querySelector('[data-testid="web-preview-not-secure"]')),
          host: box(document.querySelector('[data-testid="web-preview-host"]')),
          open: box(document.querySelector('[data-testid="web-preview-open-tab"]')),
        };
      });
      if (address.settings) {
        const startGap = address.settings.x - address.field.x;
        const next = address.badge ?? address.host;
        const afterGap = next.x - (address.settings.x + address.settings.width);
        address.startGap = Math.round(startGap * 10) / 10;
        address.afterGap = Math.round(afterGap * 10) / 10;
        if (Math.abs(startGap - 6) > 0.6) problems.push(`site settings ${address.startGap}px from the field's start, not 6`);
        if (Math.abs(afterGap - 8) > 0.6) problems.push(`${address.badge ? "badge" : "address"} ${address.afterGap}px after site settings, not 8`);
        if (address.badge && Math.abs(address.host.x - (address.badge.x + address.badge.width) - 8) > 0.6) problems.push("address not 8px after the badge");
      }
      const firstOwn = boxes.slots.findIndex((slot) => !slot.pinned);
      if (boxes.slots.some((slot, index) => slot.pinned && firstOwn >= 0 && index > firstOwn)) problems.push("a pinned tab stands after an own tab");
      let menu = null;
      if (menuTab) {
        await page.locator(`[data-tab-id="${menuTab}"] [role="tab"]`).click({ button: "right" });
        const popup = page.getByTestId("web-preview-tab-menu");
        await popup.waitFor({ state: "visible", timeout: 10_000 });
        await page.waitForTimeout(300);
        menu = {
          box: round(await popup.boundingBox()),
          items: await popup.locator('[role="menuitem"]').evaluateAll((items) => items.map((item) => `${item.textContent}${item.hasAttribute("data-disabled") ? " (disabled)" : ""}`)),
        };
        if (!inside(menu.box, { x: 0, y: 0, width: 820, height: 420 })) problems.push("the menu is cut by the window");
        // The shell's native view draws above the app's page: the panel must see the menu as an overlay over the
        // page's place (webPreviewOverlays), so it hides the view and shows its still while the menu is open.
        const covered = await page.getByTestId("web-preview-native").evaluate((place) => place.hasAttribute("data-covered"));
        menu.coversPage = covered;
        if (!covered) problems.push("the page's place does not know the menu covers it");
      }
      if (problems.length > 0) failed = true;
      const file = `${name}-${mode}`;
      await page.screenshot({ path: `${outDir}/${file}.png` });
      results.push({ name: file, ok: problems.length === 0, problems, address, head: round(head), grip: round(boxes.grip), slots: boxes.slots.map((slot) => ({ id: slot.id, pinned: slot.pinned, box: round(slot.box), icon: round(slot.icon), close: round(slot.close) })), controls: boxes.controls.map(round), menu });
      console.log(problems.length === 0 ? "ok  " : "FAIL", file, boxes.slots.map((slot) => `${slot.pinned ? "*" : ""}${slot.id}:${Math.round(slot.box.width)}`).join(" "), problems.join("; "), menu ? menu.items.join(" | ") : "");
      await page.close();
    }
  }
} finally {
  await browser.close();
}
await writeFile(`${outDir}/measurements.json`, `${JSON.stringify(results, null, 2)}\n`);
if (failed) process.exitCode = 1;
