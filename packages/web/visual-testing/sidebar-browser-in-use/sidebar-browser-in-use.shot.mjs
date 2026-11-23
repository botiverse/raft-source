// Captures the sidebar's browser in-use mark (main.tsx here) from a running
// vite dev server (packages/web): the desktop's 260px column and the phone's
// full-width sidebar, light and dark, at deviceScaleFactor 2, plus a close crop
// of three rows. For every mark it measures that it is wholly inside its row
// (or section head), vertically centred on the name (±1px), clear of the
// row's count, dot, pencil and @ sticker, and that its row is as tall as a
// plain row:
//   node visual-testing/sidebar-browser-in-use/sidebar-browser-in-use.shot.mjs <baseUrl> <outDir>
// A job that brings its own browser imports `shootSidebarInUse` instead.
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const MARKED_ROWS = ["design", "standup", "launch", "general", "dm-designer", "dm-agent", "dm-lounge"];
const PLAIN_ROWS = ["random", "release", "product"];
const MARKED_SECTIONS = ["calls", "music"];

/** The page's boxes: per row, its row, name, mark and trailing parts; per folded section, its head, title and mark. */
function measurePage() {
  const box = (node) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const rows = {};
  for (const wrapper of document.querySelectorAll("[data-case-row]")) {
    const row = wrapper.querySelector('[data-slot="sidebar-item"]');
    const mark = row.querySelector('[data-testid="sidebar-browser-in-use"]');
    const others = [...row.querySelectorAll('[data-slot="sidebar-item-count"], [data-slot="sidebar-item-meta"], [data-slot="sidebar-item-indicator"], [data-testid="sidebar-marked-unread-dot"], [data-testid="sidebar-quiet-new-dot"], [data-slot="sidebar-item-meta-icon"]')]
      .filter((node) => node !== mark && !mark?.contains(node) && !node.contains(mark))
      .map((node) => ({ what: node.getAttribute("data-testid") ?? node.getAttribute("data-slot"), box: box(node) }));
    rows[wrapper.getAttribute("data-case-row")] = {
      row: box(row),
      title: box(row.querySelector('[data-slot="sidebar-item-title"]')),
      mark: box(mark),
      markSvg: box(mark?.querySelector("svg")),
      markKind: mark?.getAttribute("data-browser-in-use") ?? null,
      markLabel: mark?.getAttribute("aria-label") ?? null,
      markColor: mark?.querySelector("svg") ? getComputedStyle(mark.querySelector("svg")).color : null,
      others,
    };
  }
  const sections = {};
  for (const section of document.querySelectorAll("[data-case-section]")) {
    const header = section.querySelector('[data-slot="sidebar-section-header"]');
    const mark = header.querySelector('[data-testid="sidebar-browser-in-use"]');
    const others = [...header.querySelectorAll('[data-slot="sidebar-section-count"], [data-testid="case-section-attention"], [data-slot="sidebar-section-trailing"]')]
      .map((node) => ({ what: node.getAttribute("data-slot"), box: box(node) }));
    sections[section.getAttribute("data-case-section")] = {
      row: box(header),
      title: box(header.querySelector('[data-slot="sidebar-section-title"]')),
      mark: box(mark),
      markSvg: box(mark?.querySelector("svg")),
      markKind: mark?.getAttribute("data-browser-in-use") ?? null,
      others,
    };
  }
  return { rows, sections, column: box(document.querySelector('[data-testid="case-sidebar-column"]')), content: box(document.querySelector('[data-testid="sidebar-root"] > div')) };
}

// 0.5px slack: boxes at deviceScaleFactor 2 land on half pixels.
const inside = (inner, outer) => inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5
  && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
const overlaps = (a, b) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
const centre = (b) => b.y + b.height / 2;
const r1 = (n) => Math.round(n * 10) / 10;

function check(name, entry, plainHeight) {
  if (!entry.mark) return { name, ok: false, problems: ["no mark"] };
  const problems = [];
  if (!inside(entry.mark, entry.row)) problems.push("mark outside its row");
  if (entry.markSvg && !inside(entry.markSvg, entry.row)) problems.push("icon outside its row");
  const offset = centre(entry.markSvg ?? entry.mark) - centre(entry.title);
  if (Math.abs(offset) > 1) problems.push(`off centre ${r1(offset)}px`);
  const hit = entry.others.filter((other) => other.box && other.box.width > 0 && overlaps(entry.mark, other.box)).map((other) => other.what);
  if (hit.length) problems.push(`overlaps ${hit.join(", ")}`);
  if (entry.mark.x < entry.title.x + entry.title.width - 0.5) problems.push("mark overlaps the name");
  if (plainHeight !== undefined && Math.abs(entry.row.height - plainHeight) > 0.5) problems.push(`row ${r1(entry.row.height)}px vs plain ${r1(plainHeight)}px`);
  const neighbours = entry.others.filter((other) => other.box && other.box.width > 0).map((other) => `${other.what}@${r1(other.box.x - (entry.mark.x + entry.mark.width))}px`);
  return {
    name,
    ok: problems.length === 0,
    problems,
    kind: entry.markKind,
    label: entry.markLabel,
    color: entry.markColor,
    centreOffset: r1(offset),
    rowHeight: r1(entry.row.height),
    markBox: { x: r1(entry.mark.x), y: r1(entry.mark.y), w: r1(entry.mark.width), h: r1(entry.mark.height) },
    gapAfterName: r1(entry.mark.x - (entry.title.x + entry.title.width)),
    neighbours,
  };
}

export const DEFAULT_CASES = [
  { name: "desktop", phone: false, width: 1280, height: 800, scale: 2 },
  { name: "phone", phone: true, width: 390, height: 844, scale: 2 },
];

/** Shoots each case light and dark with `browser` (Playwright); returns the measurements, each with `ok`. */
export async function shootSidebarInUse(browser, { base, outDir, cases = DEFAULT_CASES, zoom = true, log = console.log }) {
  await mkdir(outDir, { recursive: true });
  const results = [];
  const open = async ({ phone, width, height, scale }, mode) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: mode, hasTouch: phone, isMobile: false });
    page.on("pageerror", (error) => log(`pageerror ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") log(`console ${message.text()}`); });
    await page.goto(`${base}/visual-testing/sidebar-browser-in-use/index.html?mode=${mode}&phone=${phone ? 1 : 0}`, { waitUntil: "networkidle" });
    await page.getByTestId("sidebar-browser-in-use").first().waitFor({ state: "visible", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    return page;
  };
  for (const entry of cases) {
    for (const mode of ["light", "dark"]) {
      const page = await open(entry, mode);
      const m = await page.evaluate(measurePage);
      const plainHeight = m.rows.random.row.height;
      const checks = [
        ...MARKED_ROWS.map((row) => check(row, m.rows[row], row.startsWith("dm-") ? m.rows["dm-designer"].row.height : plainHeight)),
        ...MARKED_SECTIONS.map((section) => check(`section:${section}`, m.sections[section])),
      ];
      // DM rows have no plain twin here: say how tall they are against a channel row.
      const plainNoMark = PLAIN_ROWS.every((row) => m.rows[row].mark === null);
      const ok = checks.every((c) => c.ok) && plainNoMark;
      const name = `sidebar-in-use-${entry.name}-${mode}`;
      const clip = { x: m.column.x, y: m.column.y, width: m.column.width, height: Math.ceil(m.content.height) + 8 };
      await page.screenshot({ path: `${outDir}/${name}.png`, clip });
      results.push({ name, ok, plainRowHeight: r1(plainHeight), dmRowHeight: r1(m.rows["dm-designer"].row.height), plainRowsWithoutMark: plainNoMark, checks });
      log(`${ok ? "ok  " : "FAIL"} ${name} plain row ${r1(plainHeight)}px, dm row ${r1(m.rows["dm-designer"].row.height)}px, plain rows unmarked: ${plainNoMark}`);
      for (const c of checks) log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name} ${c.kind ?? ""} centre ${c.centreOffset}px row ${c.rowHeight}px gapAfterName ${c.gapAfterName}px next: ${(c.neighbours ?? []).join(" ") || "-"} color ${c.color ?? ""}${c.ok ? "" : ` ${c.problems.join("; ")}`}`);
      await page.close();
    }
  }
  if (zoom) {
    // Three rows up close: the mic, the mic+camera with @ and count, the muted speaker with the quiet dot.
    for (const mode of ["light", "dark"]) {
      const page = await open({ phone: false, width: 1280, height: 800, scale: 4 }, mode);
      const m = await page.evaluate(measurePage);
      const top = m.rows.standup.row; const bottom = m.rows.general.row;
      const name = `sidebar-in-use-zoom-${mode}`;
      await page.screenshot({ path: `${outDir}/${name}.png`, clip: { x: m.column.x, y: top.y - 4, width: m.column.width, height: bottom.y + bottom.height - top.y + 8 } });
      log(`shot ${name}`);
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
    const results = await shootSidebarInUse(browser, {
      base: process.argv[2] ?? "http://127.0.0.1:5199",
      outDir: process.argv[3] ?? "/var/tmp/raft-ubuntu/sidebar-browser-in-use-shots",
    });
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
