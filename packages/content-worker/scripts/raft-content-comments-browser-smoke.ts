import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mountHostPage } from "../test/raftContentBrowser";
import { startRaftContent } from "../test/raftContentHarness";

// A workspace page opens Raft's comment composer (P090/P108): in Chromium, a
// version served by the content Worker (src/raftContent.ts, its Porthole's
// shell) in a frame mounted by the web's Porthole host as Raft's web mounts
// it, with the grant's `view` level from the issue's answer. A click on the page's button calls
// `(await porthole.use("comments")).open(anchor, { draft })`; the host's handler gets
// the anchor and the draft, and the page hears only that the composer opened.
// Without a click the call is refused. Needs `pnpm run build`.
const PAGE = `<!doctype html><html><head><title>Decision sheet</title></head><body>
<h1>Ship the alias?</h1>
<button id="approve">Approve</button> <button id="unclicked">(not clicked)</button>
<pre id="said"></pre>
<script type="module">
// The runtime's namespace (P085): a promise of it, null where the kind doesn't offer it.
const comments = await porthole.use("comments");
const said = document.getElementById("said");
said.dataset.offered = String(comments !== null);
document.getElementById("approve").addEventListener("click", () => {
  comments
    .open({ type: "page", name: "q1", label: "Question 1", quote: "Ship the alias?" }, { draft: "Approve" })
    .then((opened) => { said.textContent = "opened:" + opened; }, (error) => { said.textContent = "refused:" + (error && error.message); });
});
// Not from a click: refused (user-activation).
comments.open({ name: "q0" }).then((opened) => { said.dataset.early = "opened:" + opened; }, (error) => { said.dataset.early = "refused"; });
</script></body></html>`;

const app = await startRaftContent();
mountHostPage(app);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox"] });
try {
  const published = await app.publish({ "index.html": PAGE });
  const page = await browser.newPage();
  await page.goto(`${app.appOrigin}/host?artifact=${published.artifact}&version=${published.version}`);
  const frame = page.frameLocator("#frame iframe");
  await frame.locator("#approve").waitFor();
  await frame.locator("#said[data-early]").waitFor({ state: "attached" });
  assert.equal(await frame.locator("#said").getAttribute("data-offered"), "true", "the kind offers comments");
  assert.equal(await frame.locator("#said").getAttribute("data-early"), "refused", "no comment composer without a click");
  await frame.locator("#approve").click();
  await frame.locator("#said", { hasText: /opened:|refused:/ }).waitFor();
  assert.equal(await frame.locator("#said").textContent(), "opened:true");
  const requests = await page.evaluate(() => (window as unknown as { comments: unknown[] }).comments);
  // The anchor as Porthole carries it ({ name, label?, quote? }): a `type` the page adds is not passed on.
  assert.deepEqual(requests, [{ anchor: { name: "q1", label: "Question 1", quote: "Ship the alias?" }, draft: "Approve" }]);
  console.log("raft-content comments: comments.open from a click reaches the host's handler with its draft; without a click it is refused");
} finally {
  await browser.close();
  await app.close();
}
