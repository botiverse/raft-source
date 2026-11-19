// Captures Raft Desktop's "Sign in with Raft" sheet (main.tsx here) from a
// running vite dev server (packages/web), and measures that Cancel and the
// approving button are wholly inside the dialog and the window at each size:
//   node visual-testing/desktop-browser-sign-in/desktop-browser-sign-in.shot.mjs <baseUrl> <outDir>
// CHROMIUM_PATH names another browser binary than Playwright's own.
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");

const base = process.argv[2] ?? "http://127.0.0.1:5199";
const outDir = process.argv[3] ?? "/var/tmp/raft-ubuntu/desktop-browser-sign-in-shots";
const VIEWPORTS = [[1280, 800], [1280, 600], [390, 844]];
const inside = (inner, outer) => inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const round = (box) => Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Math.round(value * 10) / 10]));

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  args: ["--disable-dev-shm-usage", "--no-sandbox"],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const results = [];
let failed = false;
try {
  for (const servers of [2, 1, 8]) {
    for (const [width, height] of VIEWPORTS) {
      for (const mode of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width, height }, colorScheme: mode });
        page.on("pageerror", (error) => console.error("pageerror", error.message));
        await page.goto(`${base}/visual-testing/desktop-browser-sign-in/index.html?mode=${mode}&servers=${servers}`, { waitUntil: "networkidle" });
        const dialog = page.getByTestId("desktop-browser-sign-in");
        const approve = dialog.getByRole("button", { name: "Login with Raft", exact: true });
        await approve.waitFor({ state: "visible", timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);
        // Past the approve lock, so the button is drawn as it is when it can be pressed.
        await page.waitForTimeout(1500);
        const boxes = {
          dialog: await dialog.boundingBox(),
          body: await dialog.getByTestId("login-setup-sheet-body").boundingBox(),
          footer: await dialog.getByTestId("login-setup-sheet-footer").boundingBox(),
          cancel: await dialog.getByRole("button", { name: "Cancel", exact: true }).boundingBox(),
          approve: await approve.boundingBox(),
        };
        const window = { x: 0, y: 0, width, height };
        const scroll = await dialog.getByTestId("login-setup-sheet-body").evaluate((body) => {
          // The body itself, or the scroller raft-ui puts in it.
          const scroller = [body, ...body.querySelectorAll("*")].find((node) => node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY));
          return scroller ? { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null;
        });
        const ok = inside(boxes.approve, boxes.dialog) && inside(boxes.cancel, boxes.dialog) && inside(boxes.approve, boxes.footer)
          && inside(boxes.dialog, window) && boxes.footer.y >= boxes.body.y + boxes.body.height - 0.5;
        if (!ok) failed = true;
        const name = `sheet-servers${servers}-${width}x${height}-${mode}`;
        await page.screenshot({ path: `${outDir}/${name}.png` });
        results.push({ name, ok, bodyScrolls: scroll, ...Object.fromEntries(Object.entries(boxes).map(([key, box]) => [key, round(box)])) });
        console.log(ok ? "ok  " : "FAIL", name, JSON.stringify(round(boxes.approve)), "in", JSON.stringify(round(boxes.dialog)), scroll ? `body scrolls ${scroll.clientHeight}/${scroll.scrollHeight}` : "body does not scroll");
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
await writeFile(`${outDir}/measurements.json`, `${JSON.stringify(results, null, 2)}\n`);
if (failed) process.exitCode = 1;
