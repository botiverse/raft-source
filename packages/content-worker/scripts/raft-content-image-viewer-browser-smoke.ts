import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { renderMarkdownToHtml } from "../src/markdown";

// A Markdown page's image opens in the page's own viewer (#proj-workspace:#288), in Chromium: the
// page as the Worker makes it, its image a 2000×1200 picture in a 1000×700 window. A click opens it
// fitted; a trackpad pinch (the wheel with ctrl) zooms round the pointer; a drag pans; double-click
// goes back to fit; Esc closes and gives focus back to the image; a backdrop click closes. An image
// inside a link stays the link's. Control: the same page without the viewer's script opens nothing.
const PICTURE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1200"><rect width="2000" height="1200" fill="#4a7"/><circle cx="1000" cy="600" r="300" fill="#fff"/></svg>')}`;
const DOCUMENT = `# Shots\n\n![the chart](${PICTURE})\n\n[![linked](${PICTURE})](https://example.com/elsewhere)\n`;

type View = { open: boolean; scale: number; x: number; y: number; focused: string | null };

async function view(tab: Page): Promise<View> {
  return tab.evaluate(() => {
    const viewer = document.querySelector<HTMLElement>("[data-testid='image-viewer']");
    const shown = document.querySelector<HTMLElement>(".image-viewer-image");
    const match = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(shown?.style.transform ?? "");
    return {
      open: viewer !== null && !viewer.hidden,
      x: match ? Number(match[1]) : NaN,
      y: match ? Number(match[2]) : NaN,
      scale: match ? Number(match[3]) : NaN,
      focused: document.activeElement?.getAttribute("aria-label") ?? null,
    };
  });
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox"] });
try {
  const tab = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await tab.setContent(renderMarkdownToHtml(DOCUMENT, "Shots"));
  const image = tab.locator(".doc img").first();
  await image.waitFor();
  await tab.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>(".doc img")).every((img) => img.complete && img.naturalWidth > 0));

  assert.equal((await view(tab)).open, false, "closed until asked");
  await image.click();
  let now = await view(tab);
  assert.equal(now.open, true, "a click on the image opens it");
  assert.ok(Math.abs(now.scale - 0.5) < 1e-3, `fitted: 2000 wide in 1000 is half (${now.scale})`);
  assert.ok(Math.abs(now.y - (700 - 600) / 2) < 1, `centred on the short axis (${now.y})`);
  assert.equal(now.focused, "Close image", "focus moves into the viewer");

  // A trackpad pinch out round the circle's centre: bigger, and the centre stays under the pointer.
  await tab.mouse.move(500, 350);
  for (let i = 0; i < 5; i += 1) {
    await tab.keyboard.down("Control");
    await tab.mouse.wheel(0, -40);
    await tab.keyboard.up("Control");
  }
  now = await view(tab);
  assert.ok(now.scale > 0.5 * 2, `pinched in (${now.scale})`);
  const centre = { x: now.x + 1000 * now.scale, y: now.y + 600 * now.scale };
  assert.ok(Math.abs(centre.x - 500) < 2 && Math.abs(centre.y - 350) < 2, `the point under the fingers stays (${centre.x}, ${centre.y})`);

  // A drag pans.
  const before = now;
  await tab.mouse.move(500, 350);
  await tab.mouse.down();
  await tab.mouse.move(400, 300, { steps: 4 });
  await tab.mouse.up();
  now = await view(tab);
  assert.ok(Math.abs(now.x - (before.x - 100)) < 1 && Math.abs(now.y - (before.y - 50)) < 1, "dragged by (-100, -50)");
  assert.equal(now.open, true, "a drag doesn't close it");

  // Double-click: back to fit.
  await tab.mouse.dblclick(500, 350);
  assert.ok(Math.abs((await view(tab)).scale - 0.5) < 1e-3, "double-click fits it again");

  // Esc closes, focus back on the image.
  await tab.keyboard.press("Escape");
  now = await view(tab);
  assert.equal(now.open, false, "Esc closes");
  assert.equal(now.focused, "Open image: the chart", "focus back on the image it opened from");

  // Enter on the focused image opens it; a click on the backdrop (outside the fitted image) closes.
  await tab.keyboard.press("Enter");
  assert.equal((await view(tab)).open, true, "Enter opens it");
  await tab.mouse.click(500, 20);
  assert.equal((await view(tab)).open, false, "a click on the backdrop closes");

  // A linked image is the link's: no viewer for it.
  const linked = tab.locator(".doc a img");
  assert.equal(await linked.getAttribute("role"), null, "a linked image isn't a button");
  await tab.route("https://example.com/**", (route) => route.fulfill({ body: "elsewhere" }));
  await linked.click();
  await tab.waitForURL("https://example.com/elsewhere");

  // Control: without the viewer's script, a click opens nothing.
  const bare = renderMarkdownToHtml(DOCUMENT, "Shots").replace(/<script>[^]*?image-viewer[^]*?<\/script>/, "");
  await tab.setContent(bare);
  await tab.locator(".doc img").first().click();
  assert.equal(await tab.locator("[data-testid='image-viewer']").count(), 0, "control: nothing opens");
  console.log("image viewer smoke: ok");
} finally {
  await browser.close();
}
