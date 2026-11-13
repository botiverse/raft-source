// Captures the Claude limit-reset states (ClaudeLimitResetStates.tsx) from a
// running vite dev server (packages/web):
//   node visual-testing/claude-limit-reset/claude-limit-reset.shot.mjs <baseUrl> <outDir>
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");

const base = process.argv[2] ?? "http://127.0.0.1:5199";
const outDir = process.argv[3] ?? "/var/tmp/raft-ubuntu/limit-reset-shots";
// [file, case, button to press first (by accessible name), what to wait for]
const CASES = [
  ["01-card-at-5-hour-limit", "card-wall", null, "scene"],
  ["02-card-below-limit", "card-below", null, "scene"],
  ["03-consent-warning", "consent", null, "dialog"],
  ["04a-list-below-limit", "list-below", null, "radio"],
  ["04b-list-at-5-hour-limit", "list-wall", "Continue", "radio"],
  ["05-confirm", "confirm", null, "dialog"],
  ["06a-result-success", "result-success", null, "scene"],
  ["06b-result-refused-nothing-used", "result-refused", "Use weekly reset", "No reset was used"],
  ["06c-result-five-hour-spent", "result-five-hour-spent", null, "scene"],
  ["06d-result-unknown", "result-unknown", null, "scene"],
];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--disable-dev-shm-usage", "--raft-shot-run=claude-limit-reset"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (error) => console.error("pageerror", error.message));
  for (const [name, caseId, press, waitFor] of CASES) {
    await page.goto(`${base}/visual-testing/claude-limit-reset/index.html?case=${caseId}&mode=light`, { waitUntil: "networkidle" });
    if (press) {
      const button = page.getByRole("button", { name: press, exact: true });
      await button.waitFor({ state: "visible", timeout: 20_000 });
      await page.waitForTimeout(300);
      await button.click();
    }
    if (waitFor === "scene") await page.locator("[data-shot='scene']").first().waitFor({ state: "visible", timeout: 20_000 });
    else if (waitFor === "dialog") await page.getByRole("dialog").last().waitFor({ state: "visible", timeout: 20_000 });
    else if (waitFor === "radio") await page.getByRole("radio").first().waitFor({ state: "visible", timeout: 20_000 });
    else await page.getByText(waitFor, { exact: false }).first().waitFor({ state: "visible", timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    const isScene = waitFor === "scene";
    const target = isScene ? page.locator("[data-shot='scene']").first() : page.getByRole("dialog").last();
    const box = await target.boundingBox();
    const pad = 32;
    const clip = {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(1280 - Math.max(0, box.x - pad), box.width + pad * 2),
      height: box.height + pad * 2,
    };
    await page.screenshot({ path: `${outDir}/${name}.png`, clip, fullPage: true });
    console.log("shot", name);
  }
} finally {
  await browser.close();
}
