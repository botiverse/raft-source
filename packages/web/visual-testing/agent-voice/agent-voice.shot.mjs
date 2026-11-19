// Captures the Voice section (main.tsx) from a running vite dev server (packages/web):
//   node visual-testing/agent-voice/agent-voice.shot.mjs <baseUrl> <outDir>
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");

const base = process.argv[2] ?? "http://127.0.0.1:5199";
const outDir = process.argv[3] ?? "/var/tmp/raft-ubuntu/agent-voice-shots";
const VIEWPORTS = [["390", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--disable-dev-shm-usage", "--raft-shot-run=agent-voice"] });
try {
  for (const [label, viewport] of VIEWPORTS) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    page.on("pageerror", (error) => console.error("pageerror", error.message));
    for (const caseId of ["askers", "empty"]) {
      for (const mode of ["light", "dark"]) {
        await page.goto(`${base}/visual-testing/agent-voice/index.html?case=${caseId}&mode=${mode}`, { waitUntil: "networkidle" });
        await page.locator("[data-testid='agent-voice-questions']").waitFor({ state: "visible", timeout: 20_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        await page.locator("[data-shot='scene']").screenshot({ path: `${outDir}/voice-${caseId}-${label}-${mode}.png` });
        console.log("shot", caseId, label, mode);
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
}
