import { test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Route shots for a PR description's ```visual-shots block (packages/visual-testing/README.md,
// "PR screenshots"). Defines no tests unless SLOCK_VISUAL_SHOTS_PLAN names a
// plan written by src/visual-shots-cli.mjs, so the default visual suite is
// unchanged.
//
// The real app renders from the Vite host with NO backend: every /api,
// /internal, /daemon and /socket.io request answers 401 and every request to
// another origin is aborted. A route therefore shows what a logged-out visitor
// sees (login, register, invite and public pages). Signed-in surfaces come from
// fixture-backed cases instead.

type RouteShot = {
  id: string;
  path: string;
  viewport: { width: number; height: number };
  theme: "light" | "dark";
  file: string;
};

const planPath = process.env.SLOCK_VISUAL_SHOTS_PLAN;
const routes: RouteShot[] = planPath ? JSON.parse(readFileSync(planPath, "utf8")).routes ?? [] : [];
const resultRoot = resolve(process.env.SLOCK_VISUAL_RESULT_ROOT || "visual-testing-results");
const BACKEND_PATH = /^\/(api|internal|daemon|socket\.io)(\/|$)/;
const PHONE_MAX_WIDTH = 743;

for (const shot of routes) {
  test.describe(() => {
    const phone = shot.viewport.width <= PHONE_MAX_WIDTH;
    test.use({ viewport: shot.viewport, colorScheme: shot.theme, hasTouch: phone, isMobile: phone });

    test(`visual shot ${shot.id} ${shot.path} ${shot.viewport.width}x${shot.viewport.height} ${shot.theme}`, async ({ page, baseURL }) => {
      const origin = new URL(baseURL ?? "").origin;
      const target = new URL(shot.path, origin);
      if (target.origin !== origin) throw new Error(`route ${shot.path} leaves the app under test`);

      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (BACKEND_PATH.test(url.pathname)) {
          return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Unauthorized"}' });
        }
        return route.continue();
      });
      page.on("pageerror", (error) => console.log(`browser pageerror: ${error.message}`));

      await page.goto(target.href, { waitUntil: "load" });
      // Vite's dev server loads modules on demand; give the page a moment to
      // settle, but a page that keeps polling still gets its shot.
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));

      const imagePath = resolve(resultRoot, shot.file);
      mkdirSync(dirname(imagePath), { recursive: true });
      await page.screenshot({ path: imagePath, animations: "disabled" });
    });
  });
}
