// Captures the runtime usage card states (RuntimeUsageCardStates.tsx) from a
// running vite dev server (packages/web):
//   node visual-testing/runtime-usage-card/runtime-usage-card.shot.mjs <baseUrl> <outDir> [locale]
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");

const base = process.argv[2] ?? "http://127.0.0.1:5199";
const outDir = process.argv[3] ?? "/var/tmp/raft-ubuntu/runtime-usage-card-shots";
const locale = process.argv[4] ?? "zh-CN";
const CASES = ["healthy", "nearly-used-up", "used-up", "update-available", "upgraded", "signed-out"];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--disable-dev-shm-usage", "--raft-shot-run=runtime-usage-card"] });
try {
  const page = await browser.newPage({ viewport: { width: 520, height: 900 }, deviceScaleFactor: 2, locale });
  page.on("pageerror", (error) => console.error("pageerror", error.message));
  for (const caseId of CASES) {
    await page.goto(`${base}/visual-testing/runtime-usage-card/index.html?case=${caseId}&mode=light`, { waitUntil: "networkidle" });
    const scene = page.locator("[data-shot='scene']").first();
    await scene.waitFor({ state: "visible", timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    await scene.screenshot({ path: `${outDir}/${caseId}.png` });
    console.log("shot", caseId);
  }
  // The account menu open (Sign out), on the healthy card.
  await page.goto(`${base}/visual-testing/runtime-usage-card/index.html?case=healthy&mode=light`, { waitUntil: "networkidle" });
  await page.getByTestId("runtime-account-menu").click();
  await page.getByTestId("runtime-auth-sign-out").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/account-menu.png`, clip: { x: 60, y: 0, width: 420, height: 420 } });
  console.log("shot account-menu");
} finally {
  await browser.close();
}
