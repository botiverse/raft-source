import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";
import { dismissOwnerOnboarding } from "../fixtures/session";

const CSV_FIXTURE = Buffer.from(`name,score,owner\nAlpha,98,Koda\nBeta,87,Martin\nGamma,91,tygg\n`, "utf8");
const MARKDOWN_FIXTURE = Buffer.from(`# Preview Notes\n\nThis is a **markdown** document.\n\n- Raw HTML below must not execute.\n\n<script>window.__bad = true</script>\n`, "utf8");
const markdownMermaidFixture = (marker: string) => Buffer.from([
  "# Mermaid Attachment Contract",
  "",
  "```mermaid",
  "graph TD",
  `  ATT[${marker}] --> RENDERED[Diagram frame]`,
  "```",
  "",
].join("\n"), "utf8");
const HTML_FIXTURE = Buffer.from(`<!doctype html><html><body><h1>HTML Escape Preview</h1></body></html>`, "utf8");
const HTML_META_CSP_FIXTURE = Buffer.from(`<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body { font-family: sans-serif; }</style>
</head><body><h1>Strict CSP report preview</h1></body></html>`, "utf8");
const HTML_EXTERNAL_LINK_FIXTURE = Buffer.from(`<!doctype html><html><body>
<a id="safe-link" href="https://example.com/travel?xsec_token=site-owned">Open travel plan</a>
<a id="unsafe-link" href="javascript:window.__unsafeRan=true">Unsafe link</a>
<button id="direct-popup" onclick="window.open('https://example.com/direct', '_blank')">Direct popup</button>
<button id="replace-preview" onclick="location.href='https://example.com/replaced-preview'">Replace preview document</button>
<script>
window.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.slockAcBridge === 1 && data.type === 'activate-document') {
    window.__previewActivation = { nonce: data.nonce, documentEpoch: data.documentEpoch };
  }
});
</script>
</body></html>`, "utf8");
const HTML_FORGED_INTENT_FIXTURE = Buffer.from(`<!doctype html><html><body>
<h1>Hostile forged intent</h1>
<script>
const params = new URLSearchParams(location.search);
setInterval(() => parent.postMessage({
  slockAcBridge: 1,
  nonce: params.get('acBridgeNonce'),
  type: 'external-link-intent',
  href: 'https://example.com/no-preview-click',
  reportedUserActivation: true
}, params.get('acBridgeParentOrigin') || '*'), 10);
</script>
</body></html>`, "utf8");
const PDF_FIXTURE = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 18 Tf 40 80 Td (Slock PDF Preview) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000214 00000 n \ntrailer\n<< /Root 1 0 R /Size 5 >>\nstartxref\n307\n%%EOF\n`, "utf8");
const TEXT_FIXTURE = Buffer.from("Alpha anchor line\nBeta keep line\n", "utf8");

async function createCanvasWebmFixture(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 54;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    const stream = canvas.captureStream(10);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
      ? "video/webm;codecs=vp8"
      : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    const paint = (frame: number) => {
      ctx.fillStyle = frame % 2 === 0 ? "#111827" : "#7c3aed";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#facc15";
      ctx.fillRect((frame * 7) % canvas.width, 16, 18, 18);
    };

    let frame = 0;
    paint(frame);
    const timer = window.setInterval(() => {
      frame += 1;
      paint(frame);
    }, 100);

    await new Promise<void>((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => reject(recorder.error ?? new Error("MediaRecorder failed"));
      recorder.onstop = () => resolve();
      recorder.start();
      window.setTimeout(() => {
        window.clearInterval(timer);
        stream.getTracks().forEach((track) => track.stop());
        recorder.stop();
      }, 1800);
    });

    const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
    }
    return btoa(binary);
  });
  return Buffer.from(base64, "base64");
}

async function uploadAttachment(request: Parameters<Parameters<typeof test>[2]>[0]["request"], seedState: Awaited<ReturnType<typeof waitForSeedState>>, accessToken: string, file: { name: string; mimeType: string; buffer: Buffer }) {
  const response = await request.post(`${seedState.urls.api}/api/attachments/upload`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    multipart: {
      channelId: seedState.channel.id,
      files: file,
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { attachments: Array<{ id: string }> };
  return body.attachments[0].id;
}

test("CSV Markdown and PDF attachments open document previews", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const suffix = randomUUID();
  const attachmentIds = await Promise.all([
    uploadAttachment(request, seedState, login.accessToken, { name: `preview-${suffix}.csv`, mimeType: "text/csv", buffer: CSV_FIXTURE }),
    uploadAttachment(request, seedState, login.accessToken, { name: `preview-${suffix}.md`, mimeType: "text/markdown", buffer: MARKDOWN_FIXTURE }),
    uploadAttachment(request, seedState, login.accessToken, { name: `preview-${suffix}.pdf`, mimeType: "application/pdf", buffer: PDF_FIXTURE }),
  ]);

  const tag = `document preview ${suffix}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: tag,
      attachmentIds,
    },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  await expect(messageCard.getByText(tag)).toBeVisible();
  await expect(messageCard.getByText("3 rows · 3 columns")).toBeVisible();
  await expect(messageCard.getByText("Markdown document")).toBeVisible();
  await expect(messageCard.getByText("PDF document")).toBeVisible();

  await messageCard.getByLabel(`preview-${suffix}.csv`).click();
  const csvCell = page.getByText("Alpha");
  await expect(csvCell).toBeVisible();
  await expect(csvCell).toBeInViewport();
  await page.getByRole("button", { name: "Close" }).click();

  await messageCard.getByLabel(`preview-${suffix}.md`).click();
  const markdownHeading = page.getByRole("heading", { name: "Preview Notes" });
  await expect(markdownHeading).toBeVisible();
  await expect(markdownHeading).toBeInViewport();
  await expect(page.getByText("window.__bad = true")).toHaveCount(0);
  await page.getByRole("button", { name: "Close" }).click();

  await messageCard.getByLabel(`preview-${suffix}.pdf`).click();
  await expect(page.locator('iframe[title^="PDF preview"]')).toBeVisible();
});

test("Markdown attachment Mermaid fence renders the uploaded diagram", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const suffix = randomUUID();
  const marker = `ATT_${suffix.slice(0, 8)}`;
  const filename = `mermaid-attachment-${suffix}.md`;
  const attachmentId = await uploadAttachment(request, seedState, login.accessToken, {
    name: filename,
    mimeType: "text/markdown",
    buffer: markdownMermaidFixture(marker),
  });

  const tag = `markdown Mermaid attachment ${suffix}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: tag,
      attachmentIds: [attachmentId],
    },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  await expect(messageCard.getByText(tag)).toBeVisible();
  await expect(messageCard.locator("[data-mermaid-status]")).toHaveCount(0);

  await messageCard.getByLabel(filename).click();
  const previewRoot = page.getByTestId("attachment-preview-browser-find-scroll");
  await expect(previewRoot).toBeVisible();
  await expect(previewRoot.getByText("MARKDOWN PREVIEW")).toHaveCount(0);

  const diagram = previewRoot.locator('[data-mermaid-status="valid"]');
  await expect(diagram).toBeVisible();
  await expect(diagram.getByTestId("mermaid-toolbar")).toBeVisible();
  const frame = diagram.locator("iframe").first();
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  const srcDoc = await frame.getAttribute("srcdoc");
  expect(srcDoc).toContain(marker);

  const openDownloadMenu = async () => {
    await diagram.getByRole("button", { name: "Download Mermaid diagram" }).click();
    const menu = previewRoot.locator('[data-slot="dropdown-menu-content"]');
    await expect(menu).toBeVisible();
    return menu;
  };

  let downloadMenu = await openDownloadMenu();
  const sourceDownloadPromise = page.waitForEvent("download");
  await downloadMenu.getByRole("menuitem", { name: "Download source" }).click();
  const sourceDownload = await sourceDownloadPromise;
  expect(sourceDownload.suggestedFilename()).toMatch(/^mermaid-[0-9a-f]{8}\.mmd$/);
  const sourcePath = await sourceDownload.path();
  expect(sourcePath).not.toBeNull();
  expect(await readFile(sourcePath!, "utf8")).toContain(marker);

  downloadMenu = await openDownloadMenu();
  const svgDownloadPromise = page.waitForEvent("download");
  await downloadMenu.getByRole("menuitem", { name: "Download SVG" }).click();
  const svgDownload = await svgDownloadPromise;
  expect(svgDownload.suggestedFilename()).toMatch(/^mermaid-[0-9a-f]{8}\.svg$/);
  const svgPath = await svgDownload.path();
  expect(svgPath).not.toBeNull();
  expect(await readFile(svgPath!, "utf8")).toContain(marker);

  downloadMenu = await openDownloadMenu();
  const pngDownloadPromise = page.waitForEvent("download");
  await downloadMenu.getByRole("menuitem", { name: "Download PNG" }).click();
  const pngDownload = await pngDownloadPromise;
  expect(pngDownload.suggestedFilename()).toMatch(/^mermaid-[0-9a-f]{8}\.png$/);
  const pngPath = await pngDownload.path();
  expect(pngPath).not.toBeNull();
  expect((await readFile(pngPath!)).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
});

test("HTML attachment preview closes on Escape", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const suffix = randomUUID();
  const attachmentId = await uploadAttachment(request, seedState, login.accessToken, {
    name: `preview-${suffix}.html`,
    mimeType: "text/html",
    buffer: HTML_FIXTURE,
  });

  const tag = `html preview escape ${suffix}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: tag,
      attachmentIds: [attachmentId],
    },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  await expect(messageCard.getByText(tag)).toBeVisible();

  await messageCard.getByLabel(`preview-${suffix}.html`).click();
  const iframe = page.locator('iframe[title^="HTML preview"]');
  await expect(iframe).toBeVisible();

  // Keep focus in the parent document before pressing Escape. Chromium can
  // occasionally leave focus in the sandboxed iframe after it finishes loading,
  // and parent-document Escape handlers cannot observe iframe key events.
  await page.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(iframe).toHaveCount(0);
});

test("HTML attachment with its own strict CSP reaches interactive preview readiness", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const suffix = randomUUID();
  const filename = `strict-csp-${suffix}.html`;
  const attachmentId = await uploadAttachment(request, seedState, login.accessToken, {
    name: filename,
    mimeType: "text/html",
    buffer: HTML_META_CSP_FIXTURE,
  });
  const tag = `html strict csp ${suffix}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { channelId: seedState.channel.id, content: tag, attachmentIds: [attachmentId] },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  await expect(messageCard.getByText(tag)).toBeVisible();
  await messageCard.getByLabel(filename).click();

  const frame = page.frameLocator('iframe[title^="HTML preview"]');
  await expect(frame.getByRole("heading", { name: "Strict CSP report preview" })).toBeVisible();
  await expect(page.locator('[data-message-affordance="attachment-preview-external-links-loading"]')).toHaveCount(0);
  await expect.poll(() => frame.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content"))
    .toContain("default-src 'none'");
});

test("hostile HTML links use one parent-controlled no-opener tab while direct popups stay blocked", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  await page.context().route("https://example.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>External fixture</title><p>External fixture</p>",
    });
  });

  const suffix = randomUUID();
  const filename = `external-links-${suffix}.html`;
  const attachmentId = await uploadAttachment(request, seedState, login.accessToken, {
    name: filename,
    mimeType: "text/html",
    buffer: HTML_EXTERNAL_LINK_FIXTURE,
  });
  const tag = `html external link ${suffix}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { channelId: seedState.channel.id, content: tag, attachmentIds: [attachmentId] },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  await expect(messageCard.getByText(tag)).toBeVisible();
  await messageCard.getByLabel(filename).click();
  const iframe = page.locator('iframe[title^="HTML preview"]');
  await expect(iframe).toBeVisible();
  const frame = page.frameLocator('iframe[title^="HTML preview"]');
  const safeHotspot = page.locator(
    '[data-message-affordance="attachment-preview-external-link-hotspots"] [data-external-href="https://example.com/travel?xsec_token=site-owned"]',
  );
  await expect(page.locator('[data-message-affordance="attachment-preview-external-links-loading"]')).toHaveCount(0);
  await expect(safeHotspot).toBeVisible();

  const safePopupPromise = page.waitForEvent("popup");
  await safeHotspot.click();
  const safePopup = await safePopupPromise;
  await safePopup.waitForURL("https://example.com/travel?xsec_token=site-owned");
  expect(await safePopup.evaluate(() => window.opener === null)).toBe(true);
  expect(await safePopup.evaluate(() => document.referrer)).toBe("");
  await safePopup.close();

  const pageCountBeforeDirectAttempt = page.context().pages().length;
  await frame.getByRole("button", { name: "Direct popup" }).click();
  await page.waitForTimeout(100);
  expect(page.context().pages()).toHaveLength(pageCountBeforeDirectAttempt);
  await frame.getByRole("link", { name: "Unsafe link" }).click();
  await page.waitForTimeout(100);
  expect(page.context().pages()).toHaveLength(pageCountBeforeDirectAttempt);
  expect(await frame.locator("body").evaluate(() => (window as Window & { __unsafeRan?: boolean }).__unsafeRan)).not.toBe(true);
});

test("iframe self-navigation invalidates parent-owned external-link hotspots", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  await page.context().route("https://example.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Replacement preview</title><p>Replacement preview</p>",
    });
  });

  const suffix = randomUUID();
  const filename = `navigating-links-${suffix}.html`;
  const attachmentId = await uploadAttachment(request, seedState, login.accessToken, {
    name: filename,
    mimeType: "text/html",
    buffer: HTML_EXTERNAL_LINK_FIXTURE,
  });
  const tag = `html navigating link ${suffix}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { channelId: seedState.channel.id, content: tag, attachmentIds: [attachmentId] },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  await expect(messageCard.getByText(tag)).toBeVisible();
  await messageCard.getByLabel(filename).click();

  const frame = page.frameLocator('iframe[title^="HTML preview"]');
  const safeHotspot = page.locator(
    '[data-message-affordance="attachment-preview-external-link-hotspots"] [data-external-href="https://example.com/travel?xsec_token=site-owned"]',
  );
  await expect(safeHotspot).toBeVisible();
  const stalePosition = await safeHotspot.boundingBox();
  expect(stalePosition).not.toBeNull();
  await expect.poll(() => frame.locator("body").evaluate(() => (
    window as Window & { __previewActivation?: { nonce: string; documentEpoch: string } }
  ).__previewActivation ?? null)).not.toBeNull();
  const oldActivation = await frame.locator("body").evaluate(() => (
    window as Window & { __previewActivation: { nonce: string; documentEpoch: string } }
  ).__previewActivation);

  await frame.getByRole("button", { name: "Replace preview document" }).click();
  await expect(frame.getByText("Replacement preview")).toBeVisible();

  // Deterministically replay an inventory from the document that just
  // unloaded. The iframe element/contentWindow and preview nonce survive a
  // top-level self-navigation, so only a freshly minted per-load epoch plus
  // the parent's current-epoch equality gate can reject this delayed report.
  await page.locator('iframe[title^="HTML preview"]').evaluate((element, activation) => {
    const frameWindow = (element as HTMLIFrameElement).contentWindow;
    window.dispatchEvent(new MessageEvent("message", {
      source: frameWindow,
      data: {
        slockAcBridge: 1,
        nonce: activation.nonce,
        documentEpoch: activation.documentEpoch,
        type: "external-links",
        links: [{
          href: "https://example.com/travel?xsec_token=site-owned",
          text: "Delayed old-document link",
          rects: [{ x: 1, y: 1, w: 220, h: 80 }],
        }],
      },
    }));
  }, oldActivation);

  const pageCountBeforeStalePositionClick = page.context().pages().length;
  await page.mouse.click(
    stalePosition!.x + stalePosition!.width / 2,
    stalePosition!.y + stalePosition!.height / 2,
  );
  await page.waitForTimeout(100);
  expect(page.context().pages()).toHaveLength(pageCountBeforeStalePositionClick);
  await expect(safeHotspot).toHaveCount(0);
  await expect(page.locator('[data-message-affordance="attachment-preview-external-links-loading"]')).toBeVisible();
});

test("hostile on-load intents cannot redeem modal or parent-control activation", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const suffix = randomUUID();
  const filename = `forged-intent-${suffix}.html`;
  const attachmentId = await uploadAttachment(request, seedState, login.accessToken, {
    name: filename,
    mimeType: "text/html",
    buffer: HTML_FORGED_INTENT_FIXTURE,
  });
  const tag = `html forged intent ${suffix}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { channelId: seedState.channel.id, content: tag, attachmentIds: [attachmentId] },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  await expect(messageCard.getByText(tag)).toBeVisible();
  const pageCountBeforeModal = page.context().pages().length;
  await messageCard.getByLabel(filename).click();
  await expect(page.locator('iframe[title^="HTML preview"]')).toBeVisible();
  await page.waitForTimeout(150);
  expect(page.context().pages()).toHaveLength(pageCountBeforeModal);
  await expect(page.locator('[data-message-affordance="attachment-preview-external-link-fallback"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForTimeout(100);
  expect(page.context().pages()).toHaveLength(pageCountBeforeModal);
  await expect(page.locator('[data-message-affordance="attachment-preview-external-link-fallback"]')).toHaveCount(0);
});

test("blocked parent hotspot shows a fallback whose click keeps no-opener and no-referrer", async ({ page, request }) => {
  await page.addInitScript(() => {
    const nativeOpen = window.open.bind(window);
    let calls = 0;
    window.open = (...args) => {
      calls += 1;
      return calls === 1 ? null : nativeOpen(...args);
    };
  });
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  await page.context().route("https://example.com/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Fallback target</title>" });
  });

  const suffix = randomUUID();
  const filename = `blocked-link-${suffix}.html`;
  const attachmentId = await uploadAttachment(request, seedState, login.accessToken, {
    name: filename,
    mimeType: "text/html",
    buffer: HTML_EXTERNAL_LINK_FIXTURE,
  });
  const tag = `html blocked link ${suffix}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { channelId: seedState.channel.id, content: tag, attachmentIds: [attachmentId] },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  await expect(messageCard.getByText(tag)).toBeVisible();
  await messageCard.getByLabel(filename).click();
  const safeHotspot = page.locator(
    '[data-message-affordance="attachment-preview-external-link-hotspots"] [data-external-href="https://example.com/travel?xsec_token=site-owned"]',
  );
  await expect(safeHotspot).toBeVisible();
  await safeHotspot.click();
  const fallback = page.locator('[data-message-affordance="attachment-preview-external-link-fallback"]');
  await expect(fallback).toContainText("example.com");
  await expect(fallback).toContainText("https://example.com/travel?xsec_token=site-owned");

  const popupPromise = page.waitForEvent("popup");
  await fallback.getByRole("button", { name: "Open link" }).click();
  const popup = await popupPromise;
  await popup.waitForURL("https://example.com/travel?xsec_token=site-owned");
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(await popup.evaluate(() => document.referrer)).toBe("");
  await popup.close();
});

test("coarse pointer text preview taps create and preserve a structural comment anchor", async ({ page, request }) => {
  await page.addInitScript(() => {
    const realMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      if (query === "(pointer: coarse)") {
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        } as MediaQueryList;
      }
      return realMatchMedia(query);
    };
  });

  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const suffix = randomUUID();
  const filename = `tap-anchor-${suffix}.txt`;
  const attachmentId = await uploadAttachment(request, seedState, login.accessToken, {
    name: filename,
    mimeType: "text/plain",
    buffer: TEXT_FIXTURE,
  });

  const tag = `tap anchor comment ${suffix}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: tag,
      attachmentIds: [attachmentId],
    },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  await expect(messageCard.getByText(tag)).toBeVisible();

  await messageCard.getByLabel(filename).click();
  await expect(page.getByText("Plain text preview")).toBeVisible();
  await page.locator('[data-message-affordance="attachment-preview-mode"]').click();

  await page.locator('[data-anchor-line="1"]').filter({ hasText: "Alpha anchor line" }).click();
  const pendingAnchor = page.locator('[data-message-affordance="attachment-comment-pending-anchor"]').first();
  await expect(pendingAnchor).toContainText("L1");

  await page.getByText("Plain text preview").click();
  await expect(pendingAnchor).toContainText("L1");
});

test("paused video preview lets comments attach a timestamp explicitly", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const suffix = randomUUID();
  const videoBuffer = await createCanvasWebmFixture(page);
  const filename = `video-timestamp-${suffix}.webm`;
  const attachmentId = await uploadAttachment(request, seedState, login.accessToken, {
    name: filename,
    mimeType: "video/webm",
    buffer: videoBuffer,
  });

  const tag = `video timestamp comment ${suffix}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: tag,
      attachmentIds: [attachmentId],
    },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  await expect(messageCard.getByText(tag)).toBeVisible();

  await messageCard.locator('[data-message-affordance="inline-video-expand"]').click();
  const previewVideo = page.locator('video[title^="Video preview"]').first();
  await expect(previewVideo).toBeVisible();
  await previewVideo.evaluate((node) => new Promise<void>((resolve) => {
    const video = node as HTMLVideoElement;
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
  }));
  await previewVideo.evaluate((node) => {
    const video = node as HTMLVideoElement;
    video.pause();
    video.currentTime = 1.2;
    video.dispatchEvent(new Event("timeupdate"));
    video.dispatchEvent(new Event("seeked"));
  });

  await page.locator('[data-message-affordance="attachment-preview-mode"]').click();
  const addTimestamp = page.locator('[data-message-affordance="video-comment-add-timestamp"]');
  await expect(addTimestamp).toContainText("Add timestamp 0:01");

  await addTimestamp.click();
  await expect(page.locator('[data-message-affordance="attachment-comment-pending-anchor"]').first()).toContainText("0:01");
  await expect(addTimestamp).toHaveCount(0);

  const commentText = `timestamp anchored reply ${suffix}`;
  const visibleComposer = page.locator('[data-message-affordance="attachment-comment-composer"]:visible').first();
  await visibleComposer.getByPlaceholder(`Comment on ${filename}…`).fill(commentText);
  await visibleComposer.getByRole("button", { name: "Send" }).click();

  const commentRow = page.locator("li").filter({ hasText: commentText }).first();
  await expect(commentRow).toBeVisible();
  await expect(commentRow.locator('[data-message-affordance="attachment-comment-anchor"]')).toContainText("0:01");
  await expect(commentRow.locator('[data-message-affordance="attachment-comment-anchor"]')).not.toContainText(filename);
});

// The preview-kind badge was intentionally removed from the modal header. A
// long filename must still truncate without pushing the header actions off a
// narrow viewport.
test("long preview filename truncates without a modal-header kind badge", async ({
  page,
  request,
}) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const longName = `this-is-an-extremely-long-markdown-filename-that-should-truncate-without-clipping-actions-${randomUUID()}.md`;
  const attachmentId = await uploadAttachment(request, seedState, login.accessToken, {
    name: longName,
    mimeType: "text/markdown",
    buffer: MARKDOWN_FIXTURE,
  });

  const tag = `long filename preview ${randomUUID()}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: tag,
      attachmentIds: [attachmentId],
    },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  // Test on the narrowest realistic mobile viewport — that's where the
  // overlap was visible.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  await expect(messageCard.getByText(tag)).toBeVisible();

  // Open the preview modal.
  await messageCard.getByLabel(longName).click();

  const previewRoot = page.getByTestId("attachment-preview-browser-find-scroll");
  await expect(previewRoot).toBeVisible();
  await expect(previewRoot.getByText("MARKDOWN PREVIEW")).toHaveCount(0);
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const closeButton = page.getByRole("button", { name: "Close", exact: true });
  await expect(closeButton).toBeVisible();
  const closeBox = await closeButton.boundingBox();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(viewport!.width);

  // Filename element should still truncate (scrollWidth > clientWidth) so
  // long names don't push the close/download buttons off-screen.
  const filenameSpan = page
    .locator('[title*="' + longName + '"] > span')
    .first();
  await expect(filenameSpan).toBeVisible();
  const overflow = await filenameSpan.evaluate((el) => ({
    scrollWidth: (el as HTMLElement).scrollWidth,
    clientWidth: (el as HTMLElement).clientWidth,
  }));
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
});

test("markdown preview shell stays fixed to mobile viewport width", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const suffix = randomUUID();
  const attachmentId = await uploadAttachment(request, seedState, login.accessToken, {
    name: `mobile-preview-width-${suffix}.md`,
    mimeType: "text/markdown",
    buffer: MARKDOWN_FIXTURE,
  });

  const tag = `mobile preview width ${suffix}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: tag,
      attachmentIds: [attachmentId],
    },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  await expect(messageCard.getByText(tag)).toBeVisible();

  // The mobile app shell can be wider than the visible viewport while side
  // panels/search surfaces are mounted. Markdown preview uses document-flow
  // scrolling for browser find, so it must not inherit that wider document
  // width or users can horizontally pan the preview.
  await page.evaluate(() => {
    document.body.style.minWidth = "760px";
  });
  await messageCard.getByLabel(`mobile-preview-width-${suffix}.md`).click();

  const previewRoot = page.getByTestId("attachment-preview-browser-find-scroll");
  await expect(previewRoot).toBeVisible();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const previewBox = await previewRoot.boundingBox();
  expect(previewBox).not.toBeNull();
  expect(previewBox!.x).toBeGreaterThanOrEqual(0);
  expect(previewBox!.width).toBeLessThanOrEqual(viewport!.width);
  await expect(page.locator("html")).toHaveCSS("overflow-x", "hidden");
});

// Long filenames in the small attachment card must truncate inside the
// fixed-width card (w-44 = 176px) and not push the card itself wider.
test("long filename truncates inside markdown attachment card", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  // Use a hyphenated mobile-style filename (the regression tygg flagged on
  // 2026-05-10 #proj-uiux:28ac87a7) — hyphens are natural break opportunities,
  // so truncate at the chip's fixed width is the only thing keeping it inside.
  const longName = `web-frontend-tracing-rfc-2026-05-10-${randomUUID()}.md`;
  const attachmentId = await uploadAttachment(request, seedState, login.accessToken, {
    name: longName,
    mimeType: "text/markdown",
    buffer: MARKDOWN_FIXTURE,
  });

  const tag = `card truncate ${randomUUID()}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: tag,
      attachmentIds: [attachmentId],
    },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  // Mobile-width viewport — the regression was reported on a Huawei browser
  // capture, and a narrow viewport makes a wider chip visually obvious.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  await expect(messageCard.getByText(tag)).toBeVisible();

  const card = messageCard.getByLabel(longName).first();
  await expect(card).toBeVisible();

  // Card must stay at its fixed width (w-44 = 176px) regardless of
  // filename length.
  const cardBox = await card.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(cardBox!.width).toBe(176);

  // The filename element inside must overflow its container (proof
  // truncate is doing work) but visible width fits the card.
  const fname = card.getByText(longName).first();
  const dims = await fname.evaluate((el) => ({
    scrollWidth: (el as HTMLElement).scrollWidth,
    clientWidth: (el as HTMLElement).clientWidth,
  }));
  expect(dims.scrollWidth).toBeGreaterThan(dims.clientWidth);
  expect(dims.clientWidth).toBeLessThanOrEqual(176);

  // Regression for mobile browsers: the rendered text must not paint beyond
  // the card border even when the filename has natural hyphen breakpoints.
  const fnameBox = await fname.boundingBox();
  expect(fnameBox).not.toBeNull();
  expect(fnameBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
  expect(fnameBox!.x + fnameBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
});
