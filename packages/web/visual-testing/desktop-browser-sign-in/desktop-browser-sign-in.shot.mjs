// Captures Raft Desktop's "Sign in with Raft" sheet (main.tsx here) from a
// running vite dev server (packages/web), and measures, at each size, that
// Cancel and the approving button are wholly inside the dialog and the window,
// and that the App's card (its logo or initials, and its name) is in view in
// the body without scrolling; with `logo=1`, that the logo image loaded:
//   node visual-testing/desktop-browser-sign-in/desktop-browser-sign-in.shot.mjs <baseUrl> <outDir>
// CHROMIUM_PATH names another browser binary than Playwright's own. A job that
// brings its own browser imports `shootSheet` instead.
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const APP_NAME = "QA sign-in walk (throwaway)";
// The approving button each layout shows.
const APPROVE = { server: "Login with Raft", install: "Install and continue", account: "Login with Raft" };
// 0.5px slack: boxes at deviceScaleFactor 2 land on half pixels, so a flush edge can measure a hair outside.
const inside = (inner, outer) => inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5
  && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
const round = (box) => (box ? Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Math.round(value * 10) / 10])) : box);

/** Every case: the Server layout with 2, 1 and 8 Servers; the install-first and account layouts; each with and without a logo. */
export const DEFAULT_CASES = [
  ...[2, 1, 8].flatMap((servers) => [[1280, 800], [1280, 600], [390, 844]].map(([width, height]) => ({ layout: "server", servers, logo: false, width, height }))),
  ...["server", "install", "account"].flatMap((layout) => [false, true].flatMap((logo) => (
    [[1280, 800], [390, 844]].map(([width, height]) => ({ layout, servers: 2, logo, width, height }))
  ))).filter((entry) => entry.layout !== "server" || entry.logo),
];

export function caseName({ layout, servers, logo, width, height }, mode) {
  return `sheet-${layout === "server" ? "" : `${layout}-`}servers${servers}${logo ? "-logo" : ""}-${width}x${height}-${mode}`;
}

/** Shoots each case light and dark with `browser` (Playwright); returns the measurements, each with `ok`. */
export async function shootSheet(browser, { base, outDir, cases = DEFAULT_CASES, log = console.log }) {
  await mkdir(outDir, { recursive: true });
  const results = [];
  for (const entry of cases) {
    for (const mode of ["light", "dark"]) {
      const { layout, servers, logo, width, height } = entry;
      const page = await browser.newPage({ viewport: { width, height }, colorScheme: mode });
      page.on("pageerror", (error) => log(`pageerror ${error.message}`));
      await page.goto(`${base}/visual-testing/desktop-browser-sign-in/index.html?mode=${mode}&servers=${servers}&layout=${layout}&logo=${logo ? 1 : 0}`, { waitUntil: "networkidle" });
      const dialog = page.getByTestId("desktop-browser-sign-in");
      const approve = dialog.getByRole("button", { name: APPROVE[layout], exact: true });
      await approve.waitFor({ state: "visible", timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      // Past the approve lock, so the button is drawn as it is when it can be pressed.
      await page.waitForTimeout(1500);
      const body = dialog.getByTestId("login-setup-sheet-body");
      const boxes = {
        dialog: await dialog.boundingBox(),
        body: await body.boundingBox(),
        footer: await dialog.getByTestId("login-setup-sheet-footer").boundingBox(),
        cancel: await dialog.getByRole("button", { name: "Cancel", exact: true }).boundingBox(),
        approve: await approve.boundingBox(),
        // The App's card: its avatar (the first in the body) and its name there.
        appAvatar: await body.locator('[data-slot="avatar"]').first().boundingBox(),
        appName: await body.getByText(APP_NAME, { exact: true }).first().boundingBox(),
      };
      const logoLoaded = await body.locator('[data-slot="avatar"]').first().evaluate((avatar) => {
        const image = avatar.querySelector("img");
        return image ? image.complete && image.naturalWidth > 0 : false;
      });
      const window = { x: 0, y: 0, width, height };
      const scroll = await body.evaluate((node) => {
        // The body itself, or the scroller raft-ui puts in it.
        const scroller = [node, ...node.querySelectorAll("*")].find((candidate) => candidate.scrollHeight > candidate.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(candidate).overflowY));
        return scroller ? { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null;
      });
      const checks = {
        buttonsInDialog: inside(boxes.approve, boxes.dialog) && inside(boxes.cancel, boxes.dialog) && inside(boxes.approve, boxes.footer) && inside(boxes.cancel, boxes.footer),
        dialogInWindow: inside(boxes.dialog, window),
        footerBelowBody: boxes.footer.y >= boxes.body.y + boxes.body.height - 0.5,
        appCardInView: !!boxes.appAvatar && !!boxes.appName && inside(boxes.appAvatar, boxes.body) && inside(boxes.appName, boxes.body),
        logo: logo ? logoLoaded : !logoLoaded,
      };
      const ok = Object.values(checks).every(Boolean);
      const name = caseName(entry, mode);
      await page.screenshot({ path: `${outDir}/${name}.png` });
      results.push({ name, ok, checks, logoLoaded, bodyScrolls: scroll, ...Object.fromEntries(Object.entries(boxes).map(([key, box]) => [key, round(box)])) });
      log(`${ok ? "ok  " : "FAIL"} ${name} ${JSON.stringify(round(boxes.approve))} in ${JSON.stringify(round(boxes.dialog))} ${scroll ? `body scrolls ${scroll.clientHeight}/${scroll.scrollHeight}` : "body does not scroll"}${ok ? "" : ` ${JSON.stringify(checks)}`}`);
      await page.close();
    }
  }
  await writeFile(`${outDir}/measurements.json`, `${JSON.stringify(results, null, 2)}\n`);
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const require = createRequire(import.meta.url);
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch({
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  try {
    const results = await shootSheet(browser, {
      base: process.argv[2] ?? "http://127.0.0.1:5199",
      outDir: process.argv[3] ?? "/var/tmp/raft-ubuntu/desktop-browser-sign-in-shots",
    });
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
