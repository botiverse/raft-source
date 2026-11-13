import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { mountHostPage } from "../test/raftContentBrowser";
import { startRaftContent } from "../test/raftContentHarness";

// A version of many pages (#proj-workspace:#251): in Chromium, a Vite multi-page build's shape
// served by the content Worker, in a frame mounted by the web's Porthole host as Raft's web mounts
// it (the instance naming the version the issue was for). A link from the entry to another page and
// back opens each in the frame, and the display goes on past Porthole's wait for a late notice
// (pages-of-set, LATE_NOTICE_MS 2 s): one locate, one outcome. The control mounts the version's
// number instead, as the web did before: the first link starts the display again at its entry.
// A frame opened at another page than the entry (#proj-workspace:#272: a page ticket, as the web asks
// for a file the reader opened from Files) shows that page first, loaded, and its links go on in the
// same display; a page ticket for a file that is no page of the version is the door's `not-found`.
// A Markdown file that isn't the entry opens the same way, at the page the Worker makes beside it.
// Needs `pnpm run build`.
const page = (name: string, to: string, label: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
<script type="module" src="./assets/${name}.js"></script></head>
<body><main id="page">${name}</main><a id="go" href="${to}">${label}</a></body></html>`;
const FILES = {
  "index.html": page("index", "flow.html", "流程"),
  "flow.html": page("flow", "index.html", "说明稿"),
  "assets/index.js": 'document.documentElement.dataset.ran = "index";',
  "assets/flow.js": 'document.documentElement.dataset.ran = "flow";',
  // A Markdown file that isn't the entry: the Worker makes its page beside it (`docs/notes.md.html`).
  "docs/notes.md": "# Field notes\n\nSome *text*.",
};
const SETTLE_MS = 2_500;

const app = await startRaftContent();
mountHostPage(app);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox"] });

/**
 * Clicks across the pages (entry → flow → entry; from `first: "flow"`, flow → entry → flow), settling
 * after each; where the frame was each time, and how often the host located.
 */
async function across(tab: Page, query: string, first: "index" | "flow" = "index"): Promise<{ seen: string[]; locates: number; outcome: string; ran: string | null }> {
  await tab.goto(`${app.appOrigin}/host?${query}`);
  const frame = tab.frameLocator("#frame iframe");
  await frame.locator("#page", { hasText: first }).waitFor();
  // The first page's own module ran: its relative address is its own.
  const ran = await frame.locator("html").getAttribute("data-ran");
  const seen: string[] = [];
  for (const want of first === "index" ? ["flow", "index"] : ["index", "flow"]) {
    await frame.locator("#go").click();
    await frame.locator("#page", { hasText: want }).waitFor();
    await tab.waitForTimeout(SETTLE_MS);
    await frame.locator("#page").waitFor();
    seen.push((await frame.locator("#page").textContent()) ?? "");
  }
  return {
    seen,
    locates: await tab.evaluate(() => (window as unknown as { locates: number }).locates),
    outcome: (await tab.locator("#outcome").textContent()) ?? "",
    ran,
  };
}

try {
  const published = await app.publish(FILES);
  const query = `artifact=${published.artifact}&version=${published.version}`;
  const issued = await across(await browser.newPage(), query);
  assert.deepEqual(issued.seen, ["flow", "index"], "each link opened its page in the frame, which stayed there");
  assert.equal(issued.locates, 1, "the display went on: located once");
  assert.equal(issued.outcome, JSON.stringify({ state: "loaded" }));
  const control = await across(await browser.newPage(), `${query}&mounted=35`);
  assert.equal(control.seen[0], "index", "control: mounted with the version's number, the first link started the display again");
  assert.ok(control.locates > 1, `control: located again (${control.locates})`);
  // Opened at another page than the entry: that page first, then its links, in one display.
  const atPage = await across(await browser.newPage(), `${query}&page=flow.html`, "flow");
  assert.equal(atPage.ran, "flow", "the frame opened at the page asked for, its own script beside it");
  assert.deepEqual(atPage.seen, ["index", "flow"], "its links open the version's other pages in the same frame");
  assert.equal(atPage.locates, 1, "the display went on: located once");
  assert.equal(atPage.outcome, JSON.stringify({ state: "loaded" }));
  // A file that is no page of the version: the door says so, and nothing of the version is framed.
  const none = await browser.newPage();
  await none.goto(`${app.appOrigin}/host?${query}&page=assets/flow.js`);
  await none.locator("#outcome", { hasText: "blocked" }).waitFor();
  const blocked = JSON.parse((await none.locator("#outcome").textContent()) ?? "{}") as { state?: string; reason?: string };
  assert.deepEqual([blocked.state, blocked.reason], ["blocked", "not-found"]);
  // A Markdown file that isn't the entry, at the page made beside it: rendered, loaded.
  const notes = await browser.newPage();
  await notes.goto(`${app.appOrigin}/host?${query}&page=docs/notes.md.html`);
  await notes.frameLocator("#frame iframe").locator("h1#field-notes", { hasText: "Field notes" }).waitFor();
  await notes.locator("#outcome", { hasText: "loaded" }).waitFor();
  assert.equal(await notes.locator("#outcome").textContent(), JSON.stringify({ state: "loaded" }));
  assert.equal(await notes.evaluate(() => (window as unknown as { locates: number }).locates), 1);
  console.log("raft-content pages: a Markdown file that isn't the entry opens at its rendered page, loaded");
  console.log("raft-content pages: a frame opened at another page than the entry shows that page, loaded, its links going on in one display; a file that is no page is blocked: not-found");
  console.log(`raft-content pages: links between a version's pages open them in the frame, the display going on (1 locate); mounted with the version's number it starts again (${control.locates} locates)`);
} finally {
  await browser.close();
  await app.close();
}
