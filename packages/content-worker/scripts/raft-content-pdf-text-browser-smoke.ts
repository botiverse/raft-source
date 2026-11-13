/**
 * A PDF's text (the viewer page of src/services/pdfViewer.ts): in a browser, a PDF version served
 * by the content Worker in a frame mounted by the web's Porthole host as Raft's web mounts it, and
 * driven as the web drives it (`display.find`, `display.annotations`). What is asserted:
 * - each page is `#page-N[data-page=N]`, its words transparent spans over its canvas, where the
 *   canvas draws them (a line's ink on the canvas against its span's box), at a desktop width, at
 *   a phone's (390 px, 3 device px a CSS px, dark surroundings), after a resize, and on a page
 *   shown a quarter turn (`/Rotate 90`);
 * - a selection in the page reads as the words (across a line's end, a space), by the DOM and by
 *   a pointer dragged over them;
 * - Raft's find finds words in a line, across a line's end, in CJK text broken inside a sentence,
 *   through a ligature, written with radicals (as Chromium prints some CJK), and on a page not drawn yet;
 * - a selected passage comes to the host as an anchor with those words quoted, its mark is found
 *   (`attached`), and found again in a new frame after a reload, also on a page not drawn then;
 * - a page without text (a scan) is its canvas alone, and nothing fails.
 * What is only measured, and printed (the last line, JSON): a word hyphenated over a line's end,
 * and a selection from one page into the next.
 *
 * Needs `pnpm run build`. SMOKE_ENGINES=chromium,firefox,webkit (default chromium);
 * PLAYWRIGHT_<ENGINE>_EXECUTABLE_PATH for a locally installed browser.
 * Screenshots instead of the checks: PDF_TEXT_SHOTS=<directory> PDF_TEXT_SAMPLE=<a PDF>
 * PDF_TEXT_FIND=<words in it> PDF_TEXT_SELECT=<words in one line of its first page>.
 */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Frame, type Page } from "playwright";
import { mountHostPage } from "../test/raftContentBrowser";
import { startRaftContent, type Published } from "../test/raftContentHarness";
import { textPdf } from "../test/samplePdf";

const LINES = {
  title: "Raft PDF text layer",
  first: "The quick brown fox jumps over the lazy dog and keeps",
  second: "running across the line break without stopping.",
  hyphen: "A word can be hyphen-",
  // \256: Helvetica's "fi" ligature (one glyph), which pdf.js reads as the two letters.
  ligature: "ated at a line's end, and an of\\256ce has a ligature.",
  cjkFirst: "第二页：文本层让中文也可以被选中、查找",
  cjkSecond: "和评论，一行在句子中间断开，没有空格。",
  mixed: "Mixed 中文 and English on one line.",
  // As Chromium prints 页面 and 文件: with the radicals U+2EDA, U+2FAF and U+2F42.
  radicals: "做的\u2eda\u2faf和\u2f42件",
  last: "The last page is far below the first.",
};
const PASSAGE = `${LINES.first} ${LINES.second}`;
const PDF = textPdf([[LINES.title, LINES.first, LINES.second, LINES.hyphen, LINES.ligature], [LINES.cjkFirst, LINES.cjkSecond, LINES.mixed, LINES.radicals], [], [LINES.last]], [3]);

type Anchor = { kind: string; selectors: { type: string; exact?: string }[]; label: string };
type Report = { type: string; anchor?: Anchor; results?: { id: string; state: string; rect?: { x: number; y: number; width: number; height: number } }[] };
type Found = { total: number; active: number; rect?: { x: number; y: number; width: number; height: number } } | "unsupported";
type HostWindow = {
  display: {
    find: { query(query: string): Promise<Found>; clear(): void };
    annotations: { start(mode: { elements: boolean; text: boolean }): void; show(marks: { id: string; anchor: Anchor; count?: number }[]): void };
  };
  annotations: Report[];
};

const engines: Record<string, BrowserType> = { chromium, firefox, webkit };
const chosen = (process.env.SMOKE_ENGINES ?? "chromium").split(",");
const app = await startRaftContent();
mountHostPage(app);

const launch = (name: string): Promise<Browser> =>
  engines[name]!.launch({
    executablePath: process.env[`PLAYWRIGHT_${name.toUpperCase()}_EXECUTABLE_PATH`],
    ...(name === "chromium" ? { args: ["--no-sandbox"] } : {}),
  });

/** Opens the version in the host page; its frame once the first page's words are there. */
async function open(tab: Page, published: Published): Promise<Frame> {
  await tab.goto(`${app.appOrigin}/host?artifact=${published.artifact}&version=${published.version}`);
  await tab.frameLocator("#frame iframe").locator("#page-1 .textLayer > span").first().waitFor({ state: "attached" });
  const frame = await (await tab.locator("#frame iframe").elementHandle())!.contentFrame();
  assert.ok(frame, "the viewer page's frame");
  return frame;
}

/**
 * What fails in the tab: uncaught errors and the console's (a CSP refusal among them). Not an engine's
 * notes on headers it doesn't know (a CSP directive, a Permissions-Policy feature), which every page here gets.
 */
function watch(tab: Page): string[] {
  const problems: string[] = [];
  tab.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  tab.on("console", (message) => {
    if (message.type() === "error" && !/Unrecognized Content-Security-Policy directive|Permissions-Policy|Feature Policy|favicon/.test(message.text())) problems.push(`console: ${message.text()}`);
  });
  return problems;
}

/**
 * Where a line's span is against its ink on the canvas (CSS px, in the frame): the span starting
 * with `starts` on page `number`, and the dark pixels of the canvas in the rows around it.
 */
async function alignment(frame: Frame, number: number, starts: string) {
  return frame.evaluate(
    ({ number, starts }) => {
      const page = document.querySelector(`#page-${number}`)!;
      const box = page.getBoundingClientRect();
      const canvas = page.querySelector("canvas")!;
      const span = [...page.querySelectorAll(".textLayer > span")].find((each) => (each.textContent ?? "").startsWith(starts))!;
      const rect = span.getBoundingClientRect();
      const scale = canvas.width / box.width;
      // The span's own rows and two px around them: the next line's ink is further off.
      const top = Math.max(0, Math.floor((rect.top - box.top - 2) * scale));
      const height = Math.ceil((rect.height + 4) * scale);
      const pixels = canvas.getContext("2d")!.getImageData(0, top, canvas.width, height);
      const ink = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
      for (let y = 0; y < pixels.height; y += 1) {
        for (let x = 0; x < pixels.width; x += 1) {
          // Dark and drawn (past the canvas, a pixel is clear black).
          if (pixels.data[(y * pixels.width + x) * 4]! < 128 && pixels.data[(y * pixels.width + x) * 4 + 3]! > 0) {
            ink.left = Math.min(ink.left, x);
            ink.right = Math.max(ink.right, x + 1);
            ink.top = Math.min(ink.top, y);
            ink.bottom = Math.max(ink.bottom, y + 1);
          }
        }
      }
      return {
        page: { width: box.width, height: box.height },
        canvas: { width: canvas.width, height: canvas.height, cssWidth: canvas.getBoundingClientRect().width },
        layer: (() => {
          const layer = page.querySelector(".textLayer")!.getBoundingClientRect();
          return { left: layer.left - box.left, top: layer.top - box.top, width: layer.width, height: layer.height };
        })(),
        span: { left: rect.left - box.left, right: rect.right - box.left, top: rect.top - box.top, bottom: rect.bottom - box.top },
        ink: { left: ink.left / scale, right: ink.right / scale, top: (ink.top + top) / scale, bottom: (ink.bottom + top) / scale },
        fontSize: parseFloat(getComputedStyle(span).fontSize),
      };
    },
    { number, starts },
  );
}

/**
 * The span lies on its ink: the same left and right edges (within a letter's side bearing), the ink inside its
 * height. On a page shown a quarter turn clockwise (`turned`) the line runs down: the same with the axes swapped.
 */
function assertAligned(measured: Awaited<ReturnType<typeof alignment>>, where: string, turned = false): string {
  const { page, canvas, layer, fontSize } = measured;
  const swap = (box: typeof measured.span) => (turned ? { left: box.top, right: box.bottom, top: box.left, bottom: box.right } : box);
  const span = swap(measured.span);
  const ink = swap(measured.ink);
  const slack = Math.max(2, fontSize * 0.12);
  assert.ok(Math.abs(canvas.cssWidth - page.width) < 0.5, `${where}: the canvas fills the page`);
  assert.ok(Math.abs(layer.left) < 0.5 && Math.abs(layer.top) < 0.5 && Math.abs(layer.width - page.width) < 1 && Math.abs(layer.height - page.height) < 1.5, `${where}: the text layer covers the page (${JSON.stringify(layer)} in ${JSON.stringify(page)})`);
  assert.ok(Number.isFinite(ink.left), `${where}: the canvas has ink at the line`);
  assert.ok(Math.abs(span.left - ink.left) <= slack, `${where}: left edges (${span.left.toFixed(1)} span, ${ink.left.toFixed(1)} ink, slack ${slack.toFixed(1)})`);
  assert.ok(Math.abs(span.right - ink.right) <= slack, `${where}: right edges (${span.right.toFixed(1)} span, ${ink.right.toFixed(1)} ink, slack ${slack.toFixed(1)})`);
  assert.ok(span.top <= ink.top + slack && span.bottom >= ink.bottom - slack, `${where}: the ink (${ink.top.toFixed(1)}..${ink.bottom.toFixed(1)}) inside the span's height (${span.top.toFixed(1)}..${span.bottom.toFixed(1)})`);
  return `${where}: span ${span.left.toFixed(1)}..${span.right.toFixed(1)} / ink ${ink.left.toFixed(1)}..${ink.right.toFixed(1)} px (page ${page.width} px, canvas ${canvas.width} px)`;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const quoteOf = (anchor: Anchor) => anchor.selectors.find((each) => each.type === "TextQuoteSelector")?.exact ?? "";
const find = (tab: Page, query: string) => tab.evaluate((query) => (window as unknown as HostWindow).display.find.query(query), query);

/** Selects from the start of one span to the end of another (each by how its words start), and what the selection reads. */
const select = (frame: Frame, from: string, to: string) =>
  frame.evaluate(
    ({ from, to }) => {
      const spans = [...document.querySelectorAll(".textLayer > span")];
      const first = spans.find((each) => (each.textContent ?? "").startsWith(from))!;
      const last = spans.find((each) => (each.textContent ?? "").startsWith(to))!;
      const range = document.createRange();
      range.setStart(first.firstChild!, 0);
      range.setEnd(last.firstChild!, (last.textContent ?? "").length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    },
    { from, to },
  );

/** The anchor the frame reports for the next selection made by `act` (the host asked for text). */
async function anchorOf(tab: Page, act: () => Promise<unknown>): Promise<Anchor | null> {
  const before = await tab.evaluate(() => (window as unknown as HostWindow).annotations.length);
  await act();
  try {
    await tab.waitForFunction((before) => (window as unknown as HostWindow).annotations.slice(before).some((each) => each.type === "selected"), before, { timeout: 4_000 });
  } catch {
    return null;
  }
  return tab.evaluate((before) => (window as unknown as HostWindow).annotations.slice(before).find((each) => each.type === "selected")!.anchor!, before);
}

/** Each mark's latest state once every id in `wanted` was reported `attached` (or after `wait` ms). */
async function states(tab: Page, wanted: readonly string[], wait = 15_000): Promise<Record<string, string>> {
  const latest = () =>
    tab.evaluate(() => {
      const seen: Record<string, string> = {};
      for (const report of (window as unknown as HostWindow).annotations) {
        if (report.type === "anchored") for (const result of report.results ?? []) seen[result.id] = result.state;
      }
      return seen;
    });
  const until = Date.now() + wait;
  for (;;) {
    const seen = await latest();
    if (wanted.every((id) => seen[id] === "attached") || Date.now() > until) return seen;
    await tab.waitForTimeout(200);
  }
}

async function check(name: string, browser: Browser): Promise<Record<string, unknown>> {
  const measured: Record<string, unknown> = { engine: `${name} ${browser.version()}` };
  const published = await app.publish({ "report.pdf": PDF }, { kind: "pdf", entry: "report.pdf", title: "Text layer" });
  const tab = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const problems = watch(tab);
  const started = Date.now();
  let frame = await open(tab, published);
  measured.firstTextMs = Date.now() - started;
  const pages = tab.frameLocator("#frame iframe");
  await pages.locator("#page-1 canvas").waitFor();

  // Each page has its stable name; the first two are near the view and drawn, the last isn't.
  assert.deepEqual(
    await frame.evaluate(() => [...document.querySelectorAll(".page")].map((each) => `${each.id}:${(each as HTMLElement).dataset.page}`)),
    ["page-1:1", "page-2:2", "page-3:3", "page-4:4"],
  );
  assert.equal(await pages.locator("#page-1").getAttribute("role"), "group", "a page with words is no longer one picture");
  assert.equal(await pages.locator("#page-1 canvas").getAttribute("aria-hidden"), "true");
  assert.equal(await pages.locator("#status").isHidden(), true);

  // The words lie where the canvas draws them.
  const lines: string[] = [];
  lines.push(assertAligned(await alignment(frame, 1, LINES.title), `${name} desktop`));
  assert.ok((await pages.locator("#page-1 .textLayer > span").count()) >= 5, "a span a line at least");
  assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector(".textLayer > span")!).color), "rgba(0, 0, 0, 0)", "the words are transparent: the canvas shows them");

  // A selection reads as the words, and comes to the host as an anchor quoting them.
  await tab.evaluate(() => (window as unknown as HostWindow).display.annotations.start({ elements: false, text: true }));
  let selected = "";
  const passage = await anchorOf(tab, async () => {
    selected = await select(frame, "The quick", "running across");
  });
  assert.equal(squash(selected), PASSAGE, "the selection across a line's end");
  assert.ok(passage, "the frame reported the selection");
  assert.equal(passage.kind, "text");
  assert.equal(squash(quoteOf(passage)), PASSAGE, "the anchor quotes the words, the line's end a space");
  assert.equal(passage.label, PASSAGE.slice(0, 120));

  // A pointer dragged from the first line's start, through the gap between the lines (where the selection
  // holds, neither jumping to the page's start nor to its end), to the second line's last letters.
  await frame.evaluate(() => document.getSelection()!.removeAllRanges());
  const from = (await pages.locator("#page-1 .textLayer > span", { hasText: "The quick" }).boundingBox())!;
  const to = (await pages.locator("#page-1 .textLayer > span", { hasText: "running across" }).boundingBox())!;
  await tab.mouse.move(from.x + 1, from.y + from.height / 2);
  await tab.mouse.down();
  await tab.mouse.move(from.x + from.width / 2, from.y + from.height / 2, { steps: 8 });
  await tab.mouse.move(from.x + from.width / 2, from.y + from.height + (to.y - from.y - from.height) / 2, { steps: 8 });
  const between = squash(await frame.evaluate(() => document.getSelection()!.toString()));
  assert.ok(LINES.first.startsWith(between) && between.length > 10, `between two lines the selection holds in the first (${JSON.stringify(between)})`);
  await tab.mouse.move(to.x + to.width - 2, to.y + to.height / 2, { steps: 12 });
  await tab.mouse.up();
  const dragged = squash(await frame.evaluate(() => document.getSelection()!.toString()));
  measured.dragged = dragged;
  assert.ok(PASSAGE.startsWith(dragged) && dragged.length >= PASSAGE.length - 2, `a dragged selection (${JSON.stringify(dragged)})`);
  await frame.evaluate(() => document.getSelection()!.removeAllRanges());

  // Raft's find, as the web asks it.
  const count = async (query: string) => {
    const found = await find(tab, query);
    assert.notEqual(found, "unsupported", `find "${query}"`);
    return (found as Exclude<Found, string>).total;
  };
  assert.equal(await count("brown fox"), 1, "find in a line");
  assert.equal(await count("LAZY DOG and keeps running across"), 1, "find across a line's end, any case");
  assert.equal(await count("查找和评论"), 1, "find CJK words across a line's end, which has no space");
  assert.equal(await count("中文"), 2, "find CJK words in a line");
  assert.equal(await count("an office has"), 1, "find through a ligature");
  assert.equal(await count("页面和文件"), 1, "find words a PDF wrote with radicals, typed as their ideographs");
  measured.findHyphenatedWord = await count("hyphenated");
  measured.findHyphenAsWritten = await count("hyphen- ated");
  // The last page is far below: not drawn, its words there all the same (find then scrolls to them, and it is drawn).
  await pages.locator("#page-4 .textLayer > span").first().waitFor({ state: "attached" });
  assert.equal(await pages.locator("#page-4 canvas").count(), 0, "the last page isn't drawn");
  assert.equal(await count("far below the first"), 1, "find on a page not drawn yet");
  await pages.locator("#page-4 canvas").waitFor();
  // That page is shown a quarter turn: its line runs down the page, the words on it all the same.
  await tab.waitForTimeout(300);
  lines.push(assertAligned(await alignment(frame, 4, LINES.last), `${name} turned page`, true));
  tab.evaluate(() => (window as unknown as HostWindow).display.find.clear());
  await frame.evaluate(() => window.scrollTo(0, 0));

  // Marks: the passage, one on the last page, one from a page into the next (measured).
  const far = await anchorOf(tab, () => select(frame, "The last page", "The last page"));
  assert.ok(far, "a selection on the last page");
  assert.equal(squash(quoteOf(far)), LINES.last);
  let crossed = "";
  const across = await anchorOf(tab, async () => {
    crossed = await select(frame, "ated at a line", "第二页");
  });
  measured.selectionAcrossPages = squash(crossed);
  measured.anchorAcrossPages = across ? squash(quoteOf(across)) : null;
  await frame.evaluate(() => document.getSelection()!.removeAllRanges());
  const marks = [
    { id: "passage", anchor: passage, count: 2 },
    { id: "far", anchor: far, count: 1 },
    ...(across ? [{ id: "across", anchor: across, count: 1 }] : []),
  ];
  const show = () => tab.evaluate((marks) => (window as unknown as HostWindow).display.annotations.show(marks), marks);
  await show();
  const shown = await states(tab, marks.map((each) => each.id));
  assert.equal(shown.passage, "attached", "the passage's mark is found");
  assert.equal(shown.far, "attached", "the last page's mark is found");
  measured.markAcrossPages = shown.across ?? null;

  // A reload: a new frame, the same anchors, found again by their words.
  assert.deepEqual(problems, [], "nothing failed in the page");
  await tab.reload();
  frame = await open(tab, published);
  // What the reload itself cut off (a fetch under way: in Firefox an uncaught NetworkError) isn't the page's.
  problems.length = 0;
  await show();
  const drawnAtShow = await tab.frameLocator("#frame iframe").locator("#page-4 canvas").count();
  const again = await states(tab, marks.map((each) => each.id));
  assert.equal(drawnAtShow, 0, "the last page wasn't drawn when its mark was shown");
  assert.equal(again.passage, "attached", "after a reload the passage's mark is found again");
  assert.equal(again.far, "attached", "after a reload the far mark is found again, once that page's words are there");
  measured.markAcrossPagesAfterReload = again.across ?? null;

  // A page without text is its canvas alone.
  await frame.evaluate(() => document.querySelector("#page-3")!.scrollIntoView());
  await pages.locator("#page-3 canvas").waitFor();
  await tab.waitForTimeout(500);
  assert.equal(await pages.locator("#page-3 .textLayer").count(), 0, "no text layer on a page without text");
  assert.equal(await pages.locator("#page-3").getAttribute("role"), "img");
  assert.equal(await pages.locator("#page-3 canvas").getAttribute("aria-hidden"), null);
  assert.equal(await pages.locator("#status").isHidden(), true);

  // The frame made narrower: the words move with the canvas at once, and stay on it once it is drawn again.
  await frame.evaluate(() => window.scrollTo(0, 0));
  await tab.setViewportSize({ width: 700, height: 820 });
  await tab.waitForFunction(() => document.querySelector("#frame iframe")!.getBoundingClientRect().width <= 700);
  await tab.waitForTimeout(1_500);
  lines.push(assertAligned(await alignment(frame, 1, LINES.title), `${name} resized to 700`));
  assert.deepEqual(problems, [], "nothing failed in the page after the reload");
  await tab.close();

  // A phone: 390 px wide, 3 device px a CSS px, dark surroundings.
  const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 3, colorScheme: "dark" });
  const small = await phone.newPage();
  const smallProblems = watch(small);
  const smallFrame = await open(small, published);
  await small.frameLocator("#frame iframe").locator("#page-1 canvas").waitFor();
  lines.push(assertAligned(await alignment(smallFrame, 1, LINES.title), `${name} phone`));
  const colours = await smallFrame.evaluate(() => ({
    around: getComputedStyle(document.body).backgroundColor,
    page: getComputedStyle(document.querySelector(".page")!).backgroundColor,
    // "only light", in whichever order the engine writes it.
    scheme: getComputedStyle(document.querySelector(".textLayer")!).colorScheme.split(" ").sort().join(" "),
  }));
  // Chromium gives the frame the emulated scheme; Firefox and WebKit give a frame its embedder's (the test host's: light).
  const around = name === "chromium" ? "rgb(43, 42, 51)" : colours.around === "rgb(43, 42, 51)" ? colours.around : "rgb(233, 233, 237)";
  assert.deepEqual(colours, { around, page: "rgb(255, 255, 255)", scheme: "light only" }, "dark around the pages (where the frame is told), the pages and their text layer light");
  measured.around = colours.around;
  assert.equal(squash(await select(smallFrame, "The quick", "running across")), PASSAGE);
  assert.deepEqual(smallProblems, [], "nothing failed in the phone's page");
  await phone.close();
  measured.aligned = lines;
  return measured;
}

/** Screenshots of a PDF with a selection, a find hit and a comment's mark, at a desktop width and a phone's. */
async function shots(name: string, browser: Browser, directory: string, sample: string): Promise<void> {
  const published = await app.publish({ "sample.pdf": new Uint8Array(await readFile(sample)) }, { kind: "pdf", entry: "sample.pdf", title: "Sample" });
  const words = process.env.PDF_TEXT_FIND ?? "PDF";
  const line = process.env.PDF_TEXT_SELECT ?? "";
  for (const [size, viewport, deviceScaleFactor] of [["desktop", { width: 1280, height: 800 }, 1], ["phone-390", { width: 390, height: 800 }, 2]] as const) {
    const context = await browser.newContext({ viewport, deviceScaleFactor });
    const tab = await context.newPage();
    const frame = await open(tab, published);
    const pages = tab.frameLocator("#frame iframe");
    await pages.locator("#page-1 canvas").waitFor();
    await tab.waitForTimeout(800);
    await tab.evaluate(() => (window as unknown as HostWindow).display.annotations.start({ elements: false, text: true }));
    // A pointer dragged over the words, from their first letter to their last (they may be several spans).
    const ends = await frame.evaluate((words) => {
      const walker = document.createTreeWalker(document.querySelector("#page-1 .textLayer")!, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let text = "";
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push(node as Text);
        text += node.nodeValue;
      }
      const at = text.indexOf(words);
      if (at === -1) throw new Error("not in the first page: " + words);
      // The boxes of the first letter and the last, before and after the words are scrolled into view.
      // (No named function in here: tsx's helper for one isn't in the page.)
      const boxes: { left: number; right: number; middle: number }[] = [];
      for (const offset of [at, at + words.length - 1, at, at + words.length - 1]) {
        if (boxes.length === 2) window.scrollTo(0, Math.max(0, window.scrollY + boxes[0]!.middle - 200));
        let start = 0;
        for (const node of nodes) {
          if (offset < start + node.length) {
            const range = document.createRange();
            range.setStart(node, offset - start);
            range.setEnd(node, offset - start + 1);
            const box = range.getBoundingClientRect();
            boxes.push({ left: box.left, right: box.right, middle: box.top + box.height / 2 });
            break;
          }
          start += node.length;
        }
      }
      return { from: { x: boxes[2]!.left + 1, y: boxes[2]!.middle }, to: { x: boxes[3]!.right - 1, y: boxes[3]!.middle } };
    }, line);
    const box = (await tab.locator("#frame iframe").boundingBox())!;
    const anchor = await anchorOf(tab, async () => {
      await tab.mouse.move(box.x + ends.from.x, box.y + ends.from.y);
      await tab.mouse.down();
      await tab.mouse.move(box.x + ends.to.x, box.y + ends.to.y, { steps: 12 });
      await tab.mouse.up();
    });
    console.log(`${name} ${size}: selected ${JSON.stringify(await frame.evaluate(() => document.getSelection()!.toString()))}; anchor ${JSON.stringify(anchor && quoteOf(anchor))}`);
    await tab.screenshot({ path: `${directory}/${name}-${size}-selection.png` });
    await frame.evaluate(() => document.getSelection()!.removeAllRanges());
    console.log(`${name} ${size}: find ${JSON.stringify(words)}: ${JSON.stringify(await find(tab, words))}`);
    await tab.waitForTimeout(500);
    await tab.screenshot({ path: `${directory}/${name}-${size}-find.png` });
    tab.evaluate(() => (window as unknown as HostWindow).display.find.clear());
    if (anchor) {
      // The comment's mark as it shows after a reload: a new frame, the anchor found by its words.
      await tab.reload();
      await open(tab, published);
      await pages.locator("#page-1 canvas").waitFor();
      await tab.evaluate((anchor) => (window as unknown as HostWindow).display.annotations.show([{ id: "comment", anchor, count: 2 }]), anchor);
      console.log(`${name} ${size}: mark after a reload ${JSON.stringify(await states(tab, ["comment"]))}`);
      await tab.waitForTimeout(1_500);
      await tab.screenshot({ path: `${directory}/${name}-${size}-comment-mark.png` });
    }
    await context.close();
  }
}

try {
  for (const name of chosen) {
    if (!engines[name]) continue;
    const browser = await launch(name);
    try {
      if (process.env.PDF_TEXT_SHOTS) {
        await mkdir(process.env.PDF_TEXT_SHOTS, { recursive: true });
        await shots(name, browser, process.env.PDF_TEXT_SHOTS, process.env.PDF_TEXT_SAMPLE!);
      } else {
        const measured = await check(name, browser);
        console.log(`raft-content pdf text (${name}): pages have their words over the canvas; selection, find and a passage's mark work, the mark again after a reload; a page without text is its canvas alone`);
        console.log(JSON.stringify(measured));
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.close();
}
