import { expect, test } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";
import type { PlaywrightSeedState } from "../fixtures/seedState";
import { dismissOwnerOnboarding } from "../fixtures/session";
import {
  clickSelectModeMoreAction,
  clickShareMessagesMenu,
} from "../fixtures/contextMenu";
import sharp from "sharp";

const COMPLEX_MERMAID_SOURCE = [
  "flowchart TD",
  '  N0["源文件"]',
  ...Array.from({ length: 12 }, (_, index) => (
    `  N${index} --> N${index + 1}["${index === 5 ? "LLM 管线（本次新增）" : `Step ${index + 1}`}"]`
  )),
].join("\n");

const REPRESENTATIVE_SOURCES = [
  "flowchart LR\n  Start --> Done",
  "sequenceDiagram\n  User->>Web: Open\n  Web-->>User: Render",
  "stateDiagram-v2\n  [*] --> Ready\n  Ready --> Done",
  "gantt\n  title Release\n  dateFormat YYYY-MM-DD\n  Build :2026-08-01, 1d",
] as const;

const mermaidBlock = (source: string) => ["```mermaid", source, "```"].join("\n");

async function postMessage(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  content: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Server-Id": seedState.server.id },
    data: { channelId: seedState.channel.id, content },
  });
  expect(response.ok()).toBeTruthy();
  return await response.json() as { id: string };
}

async function openMarkdownMessage(
  page: Page,
  request: APIRequestContext,
  content: string,
  withFollowUp = false,
) {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const message = await postMessage(request, seedState, login.accessToken, content);
  if (withFollowUp) {
    await postMessage(request, seedState, login.accessToken, "Follow-up\n\n".repeat(40));
  }
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}?msg=${message.id}`);
  const messageItem = page.locator(`[data-index][data-message-id="${message.id}"]`);
  await expect(messageItem).toBeVisible();
  return { messageItem, diagram: messageItem.locator("[data-mermaid-status=valid]") };
}

async function expectCompactToolbar(toolbar: Locator) {
  const controls = toolbar.locator("button:visible");
  const names = [
    "Diagram",
    "Code",
    "Copy Mermaid source",
    "Download Mermaid diagram",
    "Open Mermaid diagram fullscreen",
  ];
  await expect(controls).toHaveCount(names.length);
  for (const [index, name] of names.entries()) {
    await expect(controls.nth(index)).toHaveAccessibleName(name);
  }
  expect(await toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

test("a Mermaid message reaches an isolated, usable browser surface", async ({ page, request }) => {
  const { messageItem, diagram } = await openMarkdownMessage(
    page,
    request,
    ["Mermaid browser contract", "", mermaidBlock(COMPLEX_MERMAID_SOURCE)].join("\n"),
    true,
  );
  await expect(diagram).toBeVisible();

  const frame = diagram.locator('iframe[title="Mermaid diagram"]');
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(frame).toHaveAttribute("srcdoc", /Content-Security-Policy/);
  await expect(frame).toHaveAttribute("srcdoc", /源文件/);
  expect(await frame.getAttribute("srcdoc")).not.toContain("foreignObject");
  await expect(page.locator('[id^="raft-mermaid-"]')).toHaveCount(0);

  const toolbar = diagram.getByTestId("mermaid-toolbar");
  const scroller = page.getByTestId("message-scroller");
  await expect(toolbar).toHaveCSS("position", "sticky");
  await expect(diagram).toHaveCSS("overflow", "visible");
  await expect(toolbar.locator("button:visible")).toHaveCount(7);

  await diagram.getByTestId("mermaid-pan-zoom-viewport").hover();
  await page.mouse.wheel(0, 250);
  await expect.poll(async () => {
    const diagramBox = await diagram.boundingBox();
    const scrollerBox = await scroller.boundingBox();
    return diagramBox && scrollerBox ? diagramBox.y - scrollerBox.y : Number.POSITIVE_INFINITY;
  }).toBeLessThan(0);
  const toolbarBox = await toolbar.boundingBox();
  const scrollerBox = await scroller.boundingBox();
  expect(toolbarBox && scrollerBox ? Math.abs(toolbarBox.y - scrollerBox.y) : Infinity).toBeLessThanOrEqual(1);

  await toolbar.getByRole("button", { name: "Code", exact: true }).click();
  await expect(diagram.locator("pre")).toContainText("LLM 管线（本次新增）");
  await toolbar.getByRole("button", { name: "Diagram", exact: true }).click();
  await diagram.scrollIntoViewIfNeeded();

  for (const [name, extension] of [
    ["Download source", "mmd"],
    ["Download SVG", "svg"],
    ["Download PNG", "png"],
  ] as const) {
    const download = page.waitForEvent("download");
    await toolbar.getByRole("button", { name: "Download Mermaid diagram" }).click();
    await page.getByRole("menuitem", { name }).click();
    expect((await download).suggestedFilename()).toMatch(new RegExp(`^mermaid-[0-9a-f]{8}\\.${extension}$`));
  }

  await toolbar.getByRole("button", { name: "Open Mermaid diagram fullscreen" }).click();
  const fullscreen = page.getByTestId("mermaid-fullscreen");
  const stage = fullscreen.getByTestId("mermaid-pan-zoom-viewport");
  const media = stage.getByTestId("mermaid-zoom-media");
  await expect(fullscreen.locator("button:visible")).toHaveCount(1);
  await expect(fullscreen.getByTestId("mermaid-toolbar")).toHaveCount(0);
  const stageBox = await stage.boundingBox();
  const mediaBox = await media.boundingBox();
  expect(mediaBox && stageBox ? mediaBox.width <= stageBox.width + 1 : false).toBe(true);
  expect(mediaBox && stageBox ? mediaBox.height <= stageBox.height + 1 : false).toBe(true);
  await page.keyboard.press("Escape");
  await expect(fullscreen).not.toBeVisible();

  await page.setViewportSize({ width: 360, height: 740 });
  await diagram.scrollIntoViewIfNeeded();
  await expectCompactToolbar(toolbar);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => {} },
  }));
  await toolbar.getByRole("button", { name: "Copy Mermaid source" }).click();
  await expect(toolbar.getByRole("button", { name: "Copied Mermaid source" })).toBeVisible();
  const diagramBox = await diagram.boundingBox();
  const messageBox = await messageItem.boundingBox();
  expect(diagramBox && messageBox ? diagramBox.width <= messageBox.width + 1 : false).toBe(true);
});

test("representative Mermaid families render with compact mobile chrome", async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const { messageItem } = await openMarkdownMessage(
    page,
    request,
    REPRESENTATIVE_SOURCES.map(mermaidBlock).join("\n\n"),
  );
  const diagrams = messageItem.locator("[data-mermaid-status=valid]");
  await expect(diagrams).toHaveCount(REPRESENTATIVE_SOURCES.length, { timeout: 20_000 });
  await expect(messageItem.locator("[data-mermaid-status=error]")).toHaveCount(0);
  for (const [index] of REPRESENTATIVE_SOURCES.entries()) {
    await expect(diagrams.nth(index).locator('iframe[title="Mermaid diagram"]')).toHaveAttribute("sandbox", "");
  }
  await diagrams.first().scrollIntoViewIfNeeded();
  await expectCompactToolbar(diagrams.first().getByTestId("mermaid-toolbar"));
});

test("Share image materializes Mermaid ink without interactive chrome", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const source = [
    "flowchart LR",
    '  A[\"SHARE SNAPSHOT\"] --> B[\"VISIBLE IN PNG\"]',
    "  style A fill:#ff3333,stroke:#141111,stroke-width:4px",
    "  style B fill:#33cc66,stroke:#141111,stroke-width:4px",
  ].join("\n");
  const { messageItem, diagram } = await openMarkdownMessage(
    page,
    request,
    ["Mermaid Share image contract", "", mermaidBlock(source)].join("\n"),
  );
  await expect(diagram).toBeVisible();

  await page.evaluate(() => {
    const captureState = globalThis as typeof globalThis & { __mermaidShareCaptureHtml?: string };
    captureState.__mermaidShareCaptureHtml = "";
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) {
          if (!(added instanceof HTMLElement)) continue;
          const root = added.matches("[data-select-screenshot-root]")
            ? added
            : added.querySelector<HTMLElement>("[data-select-screenshot-root]");
          if (root) captureState.__mermaidShareCaptureHtml = root.innerHTML;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  await clickShareMessagesMenu(page, messageItem);
  await clickSelectModeMoreAction(page, "select-mode-share-open");
  const lightbox = page.getByTestId("select-share-lightbox");
  await expect(lightbox).toBeVisible({ timeout: 20_000 });
  const dataUrl = await lightbox.locator("img").getAttribute("src");
  expect(dataUrl).toMatch(/^data:image\/png;base64,/);

  const captureHtml = await page.evaluate(() => (
    globalThis as typeof globalThis & { __mermaidShareCaptureHtml?: string }
  ).__mermaidShareCaptureHtml ?? "");
  expect(captureHtml).toContain("r-mermaid-capture-snapshot");
  expect(captureHtml).not.toContain("mermaid-toolbar");
  expect(captureHtml).not.toContain("<iframe");

  const png = Buffer.from(dataUrl?.replace(/^data:image\/png;base64,/, "") ?? "", "base64");
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let redPixels = 0;
  let greenPixels = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const alpha = info.channels === 4 ? data[offset + 3] : 255;
    if (alpha < 200) continue;
    if (red > 180 && green < 110 && blue < 110) redPixels += 1;
    if (green > 150 && red < 110 && blue < 150) greenPixels += 1;
  }
  expect(redPixels).toBeGreaterThan(200);
  expect(greenPixels).toBeGreaterThan(200);
});

test("invalid Mermaid exposes a generic error and the original source", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const message = await postMessage(request, seedState, login.accessToken, mermaidBlock("not a diagram"));
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}?msg=${message.id}`);

  const diagram = page.locator(`[data-message-id="${message.id}"] [data-mermaid-status=error]`);
  await expect(diagram.getByRole("alert")).toContainText("Couldn't render this diagram");
  await expect(diagram).not.toContainText("No diagram type detected");
  await diagram.getByRole("button", { name: "Code", exact: true }).click();
  await expect(diagram.locator("pre")).toContainText("not a diagram");
  await expect(diagram.getByRole("alert")).toHaveCount(0);
});
