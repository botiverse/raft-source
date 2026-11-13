/**
 * How a PDF version shows in a Raft frame (S2): measured in Playwright's
 * Chromium, Firefox and WebKit against the content Worker in Miniflare.
 * Variants (PROBE_VARIANTS, comma list):
 * - control: a PDF on the app origin (no CSP) in a plain frame: whether the
 *   engine shows PDFs in frames at all;
 * - control-sandboxed: the same in a `sandbox="allow-scripts allow-same-origin"` frame;
 * - inline-raw: the PDF as the version's entry, served by Porthole at the
 *   frame's address (inert: `default-src 'none'; sandbox`), in a plain
 *   sandboxed frame (no Porthole host);
 * - inline: the same, mounted by Porthole's host;
 * - embed: a page whose `<embed>` names the PDF (CSP `object-src 'none'`);
 * - viewer: the Worker's PDF viewer page (kind pdf).
 * Screenshots go to .pdf-probe/<engine>-<variant>.png; each line printed is
 * what the frame's document was. Needs `pnpm run build`.
 * PROBE_ENGINES=chromium,firefox,webkit; PROBE_HEADED=1 for a headed run;
 * PLAYWRIGHT_<ENGINE>_EXECUTABLE_PATH for a locally installed browser;
 * PROBE_PLAYWRIGHT=<playwright-core dir> to drive them with the Playwright they were built for.
 */
import { mkdir } from "node:fs/promises";
import type { BrowserType } from "playwright";
import { startRaftContent } from "../test/raftContentHarness";
import { mountHostPage } from "../test/raftContentBrowser";
import { samplePdf } from "../test/samplePdf";

// Another Playwright (PROBE_PLAYWRIGHT: a playwright-core directory) where the installed browsers are its builds.
const { chromium, firefox, webkit } = (await import(process.env.PROBE_PLAYWRIGHT ? `${process.env.PROBE_PLAYWRIGHT}/index.mjs` : "playwright")) as typeof import("playwright");
const engines: Record<string, BrowserType> = { chromium, firefox, webkit };
const chosen = (process.env.PROBE_ENGINES ?? "chromium,firefox,webkit").split(",");
const variants = (process.env.PROBE_VARIANTS ?? "control,control-sandboxed,inline-raw,inline,embed,viewer").split(",");
const app = await startRaftContent();
mountHostPage(app);
await mkdir(".pdf-probe", { recursive: true });
const pdf = samplePdf(["Raft PDF probe", "Page two"]);
app.raft.routes.set("/sample.pdf", async () => ({ type: "application/pdf", body: pdf }));
// A plain frame: `src`, or a fresh frame location for `artifact`/`version`; sandboxed with `sandbox=1`.
app.raft.routes.set("/raw", async () => ({
  type: "text/html; charset=utf-8",
  body: `<!doctype html><body style="margin:0"><iframe id="f" style="width:100%;height:760px;border:0"></iframe><script type="module">
const query = new URLSearchParams(location.search), frame = document.getElementById("f");
if (query.get("sandbox") === "1") frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
frame.src = query.get("src") ?? (await (await fetch("/frame", { method: "POST", body: JSON.stringify({ artifact: query.get("artifact"), version: query.get("version") }) })).json()).url;
</script></body>`,
}));
const inlinePdf = await app.publish({ "report.pdf": pdf }, { kind: "html", entry: "report.pdf", title: "inline" });
const target = (version: { artifact: string; version: string }) => `${app.appOrigin}/host?artifact=${version.artifact}&version=${version.version}`;
const versions = {
  inline: inlinePdf,
  embed: await app.publish(
    { "index.html": `<!doctype html><html><body style="margin:0"><embed src="report.pdf" type="application/pdf" style="width:100%;height:700px"></body></html>`, "report.pdf": pdf },
    { kind: "html", entry: "index.html", title: "embed" },
  ),
  viewer: await app.publish({ "report.pdf": pdf }, { kind: "pdf", entry: "report.pdf", title: "viewer" }),
};
try {
  for (const name of chosen) {
    const engine = engines[name];
    if (!engine) continue;
    let browser;
    try {
      browser = await engine.launch({
        headless: process.env.PROBE_HEADED !== "1",
        // A locally installed build (PLAYWRIGHT_<ENGINE>_EXECUTABLE_PATH), as the other browser checks.
        executablePath: process.env[`PLAYWRIGHT_${name.toUpperCase()}_EXECUTABLE_PATH`],
        // Chromium's new headless mode is the whole browser (its PDF viewer included), the shell isn't.
        // Firefox's own viewer (pdf.js), which Playwright's Firefox turns off by default.
        ...(name === "firefox" ? { firefoxUserPrefs: { "pdfjs.disabled": false } } : {}),
        ...(name === "chromium" ? { channel: process.env.PROBE_CHROMIUM_CHANNEL ?? "chromium", args: ["--no-sandbox"] } : {}),
      });
    } catch (error) {
      console.log(`${name}: can't launch: ${(error as Error).message.split("\n")[0]}`);
      continue;
    }
    for (const variant of variants) {
      const urls: Record<string, () => string> = {
        control: () => `${app.appOrigin}/raw?src=/sample.pdf`,
        "control-sandboxed": () => `${app.appOrigin}/raw?sandbox=1&src=/sample.pdf`,
        "inline-raw": () => `${app.appOrigin}/raw?sandbox=1&artifact=${inlinePdf.artifact}&version=${inlinePdf.version}`,
        ...Object.fromEntries(Object.entries(versions).map(([key, version]) => [key, () => target(version)])),
      };
      const page = await browser.newPage({ viewport: { width: 1000, height: 820 } });
      const console_: string[] = [];
      page.on("console", (message) => console_.push(`${message.type()}: ${message.text()}`));
      const downloads: string[] = [];
      page.on("download", (download) => downloads.push(download.suggestedFilename()));
      const answers: string[] = [];
      page.on("response", (response) => {
        if (response.url().includes("raftcontent.localhost")) answers.push(`${response.status()} ${response.headers()["content-type"] ?? ""} ${new URL(response.url()).pathname.slice(0, 40)}`);
      });
      await page.goto(urls[variant]!());
      await page.waitForTimeout(6_000);
      const frame = page.frames().find((each) => each !== page.mainFrame());
      let seen = "no frame";
      if (frame) {
        try {
          seen = await frame.evaluate(() =>
            JSON.stringify({
              type: document.contentType,
              embeds: [...document.querySelectorAll("embed, object")].map((each) => `${each.tagName}:${(each as HTMLEmbedElement).type}`),
              canvases: document.querySelectorAll("canvas").length,
              text: (document.body?.innerText ?? "").slice(0, 80),
            }),
          );
        } catch (error) {
          seen = `not readable: ${(error as Error).message.split("\n")[0]}`;
        }
      }
      await page.screenshot({ path: `.pdf-probe/${name}-${variant}.png` });
      if (frame && variant === "viewer") {
        // The last page is drawn once it nears the view.
        await frame.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
        await page.waitForTimeout(2_000);
        seen += ` after scrolling: ${await frame.evaluate(() => document.querySelectorAll("canvas").length).catch(() => "?")} canvases`;
      }
      console.log(`${name} ${browser.version()} ${variant}: ${seen}`);
      console.log(`  outcome: ${(await page.locator("#outcome").count()) ? await page.locator("#outcome").textContent() : "-"}`);
      console.log(`  answers: ${answers.join(" | ")}`);
      if (downloads.length) console.log(`  downloads: ${downloads.join(", ")}`);
      for (const line of console_.filter((each) => !/Permissions-Policy|Feature Policy/.test(each)).slice(0, 6)) console.log(`  console ${line.slice(0, 200)}`);
      await page.close();
    }
    await browser.close();
  }
} finally {
  await app.close();
}
