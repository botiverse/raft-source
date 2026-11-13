import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { mountHostPage } from "../test/raftContentBrowser";
import { signTicket, startRaftContent } from "../test/raftContentHarness";

// The publish check's render is the reader's (task #proj-workspace:#130, the check Worker's isolation condition 3):
// a known Artifact opened top-level with a check ticket, as the check Worker opens it
// (packages/check-worker: a fresh context, no frame, no host), and settled as the check Worker
// settled it before P139 (load, network idle, a fixed 10.5 s, idle, a pause: FIXED_SETTLE_MS), looks
// like the same version framed by Raft's host for a reader: no "connecting" placeholder, no
// missing content. Screenshots of both, the same top-left region of at most 1280×760 (the host
// page's frame), are compared pixel
// by pixel in the browser (canvas, no image library). A negative control compares the framed
// render with another version's, so the comparison can tell two pages apart.
//
// An e2e check, not a unit test: it needs Chromium (Playwright's, or
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) and `pnpm run build`. Run: pnpm test:check-parity.
// The check Worker's own browser (Cloudflare's, through @cloudflare/puppeteer) is the staging
// check of packages/check-worker/README.md "End-to-end check".

/**
 * A fixed settle from the navigation's start: the check Worker's wait before P139 (an older shell's
 * `ui/initialize` given up). The Worker no longer waits it (packages/check-worker/src/check.ts:
 * the shell's word, or SHELL_WORD_WAIT_MS without it); this script still does, so the two renders are
 * compared once the page has settled, not at the Worker's exact shot time.
 */
const FIXED_SETTLE_MS = 10_500;
const IDLE_MS = 500;
const SETTLE_MS = 500;
const WIDTH = 1280;
const HEIGHT = 760;
/** A pixel differs when a channel differs by more than this (antialiasing, subpixel text). */
const CHANNEL_TOLERANCE = 24;
/** The renders match when at most this share of pixels differ. */
const MAX_DIFFERING_SHARE = 0.005;

/** A known Artifact: text, a grid, an inline SVG chart, and content drawn by script after a delay (what a settle must wait for). */
const pageOf = (heading: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Parity</title><link rel="stylesheet" href="style.css"></head><body>
<h1 id="fixture-marker" data-fixture="full-page">${heading}</h1>
<div class="grid"><div>North 41%</div><div>South 33%</div><div>East 26%</div></div>
<svg width="600" height="160" viewBox="0 0 600 160"><rect x="0" y="40" width="240" height="30" fill="#3b6ea5"/><rect x="0" y="80" width="190" height="30" fill="#c76b29"/><rect x="0" y="120" width="150" height="30" fill="#5b8c3a"/></svg>
<ul id="late"></ul>
<script>
setTimeout(() => {
  const list = document.getElementById("late");
  for (const name of ["alpha", "beta", "gamma", "delta"]) { const item = document.createElement("li"); item.textContent = name + " — drawn late"; list.append(item); }
}, 1500);
</script></body></html>`;
const STYLE = `body{font:16px/1.5 system-ui,sans-serif;margin:24px;color:#1d1d1f;background:#fff}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.grid div{padding:16px;border:1px solid #ccc;border-radius:8px}`;

async function settle(page: Page, startedAt: number): Promise<void> {
  await page.waitForLoadState("load");
  await page.waitForLoadState("networkidle").catch(() => {});
  const left = startedAt + FIXED_SETTLE_MS - Date.now();
  if (left > 0) await page.waitForTimeout(left);
  await page.waitForTimeout(IDLE_MS + SETTLE_MS);
}

/** The share of pixels of two same-size PNGs that differ by more than CHANNEL_TOLERANCE in a channel, computed in `page`. */
async function differingShare(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([one, two, tolerance]) => {
      const pixels = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height);
      };
      const [x, y] = [await pixels(one), await pixels(two)];
      if (x.width !== y.width || x.height !== y.height) return 1;
      let differing = 0;
      for (let at = 0; at < x.data.length; at += 4) {
        for (let channel = 0; channel < 3; channel += 1) {
          if (Math.abs(x.data[at + channel]! - y.data[at + channel]!) > tolerance) {
            differing += 1;
            break;
          }
        }
      }
      return differing / (x.width * x.height);
    },
    [a.toString("base64"), b.toString("base64"), CHANNEL_TOLERANCE] as const,
  );
}

const app = await startRaftContent();
mountHostPage(app);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox"] });
try {
  const known = await app.publish({ "index.html": pageOf("Quarterly regions"), "style.css": STYLE });
  const other = await app.publish({ "index.html": pageOf("Another page entirely, with a longer heading"), "style.css": STYLE });

  // Top-level, as the check: a fresh context, the check ticket opened on a tab of its own.
  const checkContext = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const checkPage = await checkContext.newPage();
  // Every top-level document request the tab makes. The ticket's own answer is the version's
  // page (Porthole serves the entry at the ticket's address; its shell moves the address with
  // history.replaceState, no request), so there is exactly one: the ticket URL. A second would be
  // a script or meta navigation the check Worker's guard refuses, and its shot the stub's.
  const documents: string[] = [];
  checkPage.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === checkPage.mainFrame()) documents.push(request.url());
  });
  const subject = `v1:check:${known.artifact}:${known.version}`;
  const ticket = signTicket(app.claimsFor(known, { viewer: "system:check", subject }));
  const startedAt = Date.now();
  const opened = await checkPage.goto(app.openUrl(known, ticket), { waitUntil: "load" });
  assert.equal(opened?.status(), 200, "the check ticket opens the version top-level");
  assert.equal(await checkPage.evaluate(() => window.top === window), true, "nothing frames the check");
  await settle(checkPage, startedAt);
  assert.equal(await checkPage.locator("#late li").count(), 4, "content drawn late is drawn before the shot");
  assert.equal(await checkPage.locator('#fixture-marker[data-fixture="full-page"]').count(), 1, "the version's own page, not an entry stub");
  assert.deepEqual(documents, [app.openUrl(known, ticket)], "one top-level navigation, the ticket's: no script or meta hop");
  assert.match(new URL(checkPage.url()).pathname, /^\/__porthole\/f\/[A-Za-z0-9_-]+\/$/, "the shell moved the address to the sealed one, in place");
  assert.equal((await checkPage.screenshot({ type: "png" })).length > 0, true);

  // Framed, as a reader: Raft's host page (the web's Porthole host), the version in its frame.
  const framed = async (published: typeof known) => {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 800 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const started = Date.now();
    await page.goto(`${app.appOrigin}/host?artifact=${published.artifact}&version=${published.version}`);
    const frame = page.frameLocator("#frame iframe");
    await frame.locator("#late li").nth(3).waitFor();
    await settle(page, started);
    // The frame may size itself to its content (Porthole's size-changed): its top-left WIDTH × HEIGHT at most.
    const box = await page.locator("#frame iframe").boundingBox();
    assert.ok(box, "the frame is on the page");
    const clip = { x: box.x, y: box.y, width: Math.min(box.width, WIDTH), height: Math.min(box.height, HEIGHT) };
    const shot = await page.screenshot({ type: "png", clip });
    await context.close();
    return { shot, size: { width: clip.width, height: clip.height } };
  };
  const reader = await framed(known);
  const otherReader = await framed(other);
  // The check's shot cut to the frame's size (the same top-left region of the page).
  const topLevelCut = await checkPage.screenshot({ type: "png", clip: { x: 0, y: 0, ...reader.size } });

  const same = await differingShare(checkPage, topLevelCut, reader.shot);
  const control = await differingShare(checkPage, otherReader.shot, reader.shot);
  console.log(`check parity: top-level vs framed differ in ${(same * 100).toFixed(3)}% of pixels; the control (another version) ${(control * 100).toFixed(3)}%`);
  assert.ok(control > MAX_DIFFERING_SHARE, "negative control: the comparison tells two versions apart");
  assert.ok(same <= MAX_DIFFERING_SHARE, `the top-level render matches the framed one (${same})`);
  await checkContext.close();
} finally {
  await browser.close();
  await app.close();
}
