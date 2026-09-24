import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

const TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAAA2CAIAAAC3LQuFAAAAZ0lEQVR42u3QQQkAQAgAMKOZ6/rYyD5eCsHHYAkW03nLq1NCkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBuz50p3KXsCdByQAAAABJRU5ErkJggg==";

test("select screenshot renders protected attachment image and reaction chip", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await page.waitForSelector('[data-testid="message-scroller"]');

  const result = await page.evaluate(async ({ imageBase64 }) => {
    const { captureSelectedMessages } = window.__SLOCK_E2E__!;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: new Promise(() => undefined) },
    });
    const originalFetch = window.fetch.bind(window);
    const requestedUrls: string[] = [];
    window.fetch = async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("fonts.googleapis.com") || url.includes("fonts.gstatic.com")) {
        return new Promise<Response>(() => undefined);
      }
      if (url.includes("/api/attachments/attachment-for-export?disposition=inline")) {
        const bytes = Uint8Array.from(atob(imageBase64), (char) => char.charCodeAt(0));
        return new Response(new Blob([bytes], { type: "image/png" }), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      return originalFetch(input, init);
    };

    const host = document.createElement("div");
    host.style.width = "520px";
    host.style.background = "#fff";
    host.style.padding = "20px";
    host.style.fontFamily = getComputedStyle(document.body).fontFamily;
    host.innerHTML = `
      <div id="message-export-fixture" class="group relative flex gap-3 border-2 border-transparent bg-transparent p-2">
        <div class="size-8 shrink-0 rounded-full bg-soft-signal border-2 border-black"></div>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-bold text-black">Developer</div>
          <div class="text-sm text-black">download-as-image image + reaction fixture</div>
          <div class="mt-1 space-y-2">
            <div class="max-w-[28rem] space-y-2">
              <div class="grid gap-2 grid-cols-1">
                <button type="button" class="group/img relative overflow-hidden border-2 border-black bg-transparent text-left inline-block w-fit max-w-[26rem] justify-self-start" title="fixture.png">
                  <img src="https://cdn.invalid/thumbnail-that-should-not-be-used.png" alt="fixture.png" data-select-screenshot-attachment-id="attachment-for-export" data-select-screenshot-attachment-width="96" data-select-screenshot-attachment-height="54" class="block max-h-72 w-auto max-w-full object-contain bg-white" loading="lazy" />
                  <span data-message-affordance="image-download">download affordance should be stripped</span>
                </button>
              </div>
            </div>
          </div>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span class="inline-flex">
              <button type="button" class="inline-flex h-5 items-center gap-1 rounded bg-[#EEEDE6] px-1.5 text-[12px] font-bold leading-none text-black" aria-label="👀 reaction from Developer">
                <span class="inline-flex items-center leading-none">👀</span>
                <span class="font-mono tabular-nums">1</span>
              </button>
            </span>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(host);

    const dataUrl = await captureSelectedMessages(["export-fixture"], {
      backgroundColor: "#FFFFFF",
      pixelRatio: 2,
      timeoutMs: 6_000,
    });
    const preview = new Image();
    await new Promise<void>((resolve, reject) => {
      preview.onload = () => resolve();
      preview.onerror = () => reject(new Error("export preview failed to load"));
      preview.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = preview.naturalWidth;
    canvas.height = preview.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("missing canvas context");
    ctx.drawImage(preview, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let pinkPixels = 0;
    let grayChipPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const a = pixels[i + 3];
      if (a > 220 && r > 230 && g >= 80 && g <= 170 && b >= 120 && b <= 210) pinkPixels += 1;
      if (a > 220 && r >= 220 && r <= 245 && g >= 220 && g <= 245 && b >= 210 && b <= 235) grayChipPixels += 1;
    }
    return {
      dataUrl,
      requestedUrls,
      fontRequestCount: requestedUrls.filter((url) =>
        url.includes("fonts.googleapis.com") || url.includes("fonts.gstatic.com")
      ).length,
      pinkPixels,
      grayChipPixels,
    };
  }, { imageBase64: TEST_IMAGE_BASE64 });

  const requestedAttachmentPaths = result.requestedUrls.map((requestedUrl) => {
    const url = new URL(requestedUrl, "http://127.0.0.1");
    return `${url.pathname}${url.search}`;
  });
  expect(requestedAttachmentPaths).toContain("/api/attachments/attachment-for-export?disposition=inline&selectScreenshot=1");
  expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(result.fontRequestCount).toBe(0);
  expect(result.pinkPixels).toBeGreaterThan(1_000);
  expect(result.grayChipPixels).toBeGreaterThan(20);
});

test("select screenshot does not serialize native focus-visible outline from the focused source", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await page.waitForSelector('[data-testid="message-scroller"]');

  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "native-focus-visible-export-host";
    host.style.width = "440px";
    host.style.background = "#fff";
    host.style.padding = "20px";
    host.style.fontFamily = getComputedStyle(document.body).fontFamily;
    host.innerHTML = `
      <button id="native-focus-visible-sentinel" type="button">sentinel</button>
      <div id="message-native-focus-visible-fixture" class="group relative flex gap-3 border-2 border-transparent bg-transparent p-2">
        <div style="width:32px;height:32px;border:2px solid #141111;background:#bbafe6"></div>
        <div style="min-width:0;flex:1">
          <div style="font-weight:700;color:#141111">Designer</div>
          <p data-message-selectable style="margin:4px 0 0;color:#141111;line-height:1.45">
            The share artifact should keep content but drop transient keyboard focus chrome.
            <a id="native-focus-visible-fixture-link" href="#focus-visible-fixture" style="color:#141111;text-decoration:underline">focused link</a>
          </p>
        </div>
      </div>
    `;
    document.body.appendChild(host);
  });

  await page.locator("#native-focus-visible-sentinel").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#native-focus-visible-fixture-link")).toBeFocused();

  const result = await page.evaluate(async () => {
    const { captureSelectedMessages } = window.__SLOCK_E2E__!;
    const focusedLink = document.getElementById("native-focus-visible-fixture-link");
    if (!(focusedLink instanceof HTMLAnchorElement)) throw new Error("missing focus fixture");

    const readPngPixels = async (dataUrl: string) => {
      const preview = new Image();
      await new Promise<void>((resolve, reject) => {
        preview.onload = () => resolve();
        preview.onerror = () => reject(new Error("focus export preview failed to load"));
        preview.src = dataUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = preview.naturalWidth;
      canvas.height = preview.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("missing canvas context");
      ctx.drawImage(preview, 0, 0);
      return {
        width: canvas.width,
        height: canvas.height,
        pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      };
    };

    const capture = () =>
      captureSelectedMessages(["native-focus-visible-fixture"], {
        backgroundColor: "#FFFFFF",
        pixelRatio: 2,
        timeoutMs: 6_000,
      });

    const focusVisibleBeforeCapture = focusedLink.matches(":focus-visible");
    const focusedDataUrl = await capture();
    const activeAfterFocusedCapture = document.activeElement === focusedLink;
    focusedLink.blur();
    const focusVisibleAfterBlur = focusedLink.matches(":focus-visible");
    const blurredDataUrl = await capture();
    const [focusedImage, blurredImage] = await Promise.all([
      readPngPixels(focusedDataUrl),
      readPngPixels(blurredDataUrl),
    ]);
    if (focusedImage.width !== blurredImage.width || focusedImage.height !== blurredImage.height) {
      throw new Error(
        `focus comparison dimensions changed: ${focusedImage.width}x${focusedImage.height} vs ${blurredImage.width}x${blurredImage.height}`,
      );
    }

    let differentPixels = 0;
    let inkPixels = 0;
    for (let i = 0; i < focusedImage.pixels.length; i += 4) {
      const r = focusedImage.pixels[i];
      const g = focusedImage.pixels[i + 1];
      const b = focusedImage.pixels[i + 2];
      const a = focusedImage.pixels[i + 3];
      if (a > 220 && r < 40 && g < 40 && b < 40) inkPixels += 1;
      if (
        r !== blurredImage.pixels[i] ||
        g !== blurredImage.pixels[i + 1] ||
        b !== blurredImage.pixels[i + 2] ||
        a !== blurredImage.pixels[i + 3]
      ) {
        differentPixels += 1;
      }
    }

    return {
      focusedDataUrl,
      blurredDataUrl,
      focusVisibleBeforeCapture,
      activeAfterFocusedCapture,
      focusVisibleAfterBlur,
      differentPixels,
      inkPixels,
    };
  });

  await page.evaluate(() => document.getElementById("native-focus-visible-export-host")?.remove());

  expect(result.focusedDataUrl).toMatch(/^data:image\/png;base64,/);
  expect(result.blurredDataUrl).toMatch(/^data:image\/png;base64,/);
  expect(result.focusVisibleBeforeCapture).toBe(true);
  expect(result.activeAfterFocusedCapture).toBe(true);
  expect(result.focusVisibleAfterBlur).toBe(false);
  expect(result.inkPixels).toBeGreaterThan(50);
  expect(result.differentPixels).toBe(0);
});

test("select screenshot meets the 3s share deadline when fonts and images degrade", async ({ page, request }, testInfo) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await page.waitForSelector('[data-testid="message-scroller"]');

  type Scenario = {
    name: string;
    viewport: { width: number; height: number };
    hostWidth: number;
    fonts: "ready" | "hung";
    image: "none" | "avatar-500" | "attachment-hung";
    lines: number;
  };

  const scenarios: Scenario[] = [
    {
      name: "desktop-cold-font-ready",
      viewport: { width: 1280, height: 800 },
      hostWidth: 560,
      fonts: "ready",
      image: "none",
      lines: 8,
    },
    {
      name: "desktop-hot-font-ready",
      viewport: { width: 1280, height: 800 },
      hostWidth: 560,
      fonts: "ready",
      image: "none",
      lines: 8,
    },
    {
      name: "mobile-font-hung-long-message",
      viewport: { width: 390, height: 844 },
      hostWidth: 330,
      fonts: "hung",
      image: "none",
      lines: 24,
    },
    {
      name: "mobile-font-hung-attachment-hung",
      viewport: { width: 390, height: 844 },
      hostWidth: 330,
      fonts: "hung",
      image: "attachment-hung",
      lines: 10,
    },
    {
      name: "desktop-avatar-500-fallback",
      viewport: { width: 1280, height: 800 },
      hostWidth: 560,
      fonts: "ready",
      image: "avatar-500",
      lines: 10,
    },
  ];

  const samples = [];
  for (const scenario of scenarios) {
    await page.setViewportSize(scenario.viewport);
    samples.push(await page.evaluate(async (input) => {
      const { captureSelectedMessages } = window.__SLOCK_E2E__!;
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: {
          ready: input.fonts === "hung"
            ? new Promise(() => undefined)
            : Promise.resolve(),
        },
      });

      const originalFetch = window.fetch.bind(window);
      const requestedUrls: string[] = [];
      window.fetch = async (request, init) => {
        const url = String(request);
        requestedUrls.push(url);
        if (url.includes("fonts.googleapis.com") || url.includes("fonts.gstatic.com")) {
          return new Promise<Response>(() => undefined);
        }
        if (input.image === "avatar-500" && url.includes("/api/avatars/")) {
          return new Response("avatar unavailable", { status: 500 });
        }
        if (input.image === "attachment-hung" && url.includes("/api/attachments/perf-hung")) {
          return new Promise<Response>(() => undefined);
        }
        return originalFetch(request, init);
      };

      const messageId = `perf-${input.name}`;
      const text = Array.from({ length: input.lines }, (_, index) =>
        `Line ${index + 1}: Generate image should prioritize readable message content over optional remote resources.`
      ).join(" ");
      const avatarMarkup = input.image === "avatar-500"
        ? `
          <div data-avatar-kind="human" style="width:32px;height:32px;border:2px solid #141111;overflow:hidden;background:#bbafe6">
            <img src="https://cdn.example.com/avatars/test/0123456789abcdef0123456789abcdef.webp" alt="" style="display:block;width:32px;height:32px;object-fit:cover" />
          </div>
        `
        : `<div style="width:32px;height:32px;border:2px solid #141111;background:#bbafe6"></div>`;
      const contentImageMarkup = input.image === "attachment-hung"
        ? `
          <img src="https://cdn.invalid/perf-hung.png" alt="hung fixture" data-select-screenshot-attachment-id="perf-hung" data-select-screenshot-attachment-width="480" data-select-screenshot-attachment-height="270" style="display:block;width:240px;height:135px;object-fit:cover;background:#eee;margin-top:8px;max-width:100%" />
        `
        : "";

      const host = document.createElement("div");
      host.style.width = `${input.hostWidth}px`;
      host.style.padding = "20px";
      host.style.background = "#fff";
      host.innerHTML = `
        <div id="message-${messageId}" style="display:flex;gap:12px;border:2px solid transparent;background:transparent;padding:8px">
          ${avatarMarkup}
          <div style="min-width:0;flex:1">
            <div style="font-weight:700;color:#141111">Perf Fixture</div>
            <p data-message-selectable style="margin:4px 0 0;color:#141111;line-height:1.45">${text}</p>
            ${contentImageMarkup}
          </div>
        </div>
      `;
      const row = host.firstElementChild as HTMLElement | null;
      if (row) row.style.fontFamily = getComputedStyle(document.body).fontFamily;
      document.body.appendChild(host);

      try {
        const startedAt = performance.now();
        let dataUrl: string;
        let durationMs: number;
        try {
          dataUrl = await captureSelectedMessages([messageId], {
            backgroundColor: "#FFFFFF",
            pixelRatio: 1,
            maxWidth: input.hostWidth,
            timeoutMs: 3_000,
          });
          durationMs = performance.now() - startedAt;
        } catch (error) {
          throw new Error(`${input.name}: capture failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const preview = new Image();
        await new Promise<void>((resolve, reject) => {
          preview.onload = () => resolve();
          preview.onerror = () => reject(new Error(`${input.name}: perf preview failed to load`));
          preview.src = dataUrl;
        });

        return {
          name: input.name,
          durationMs,
          width: preview.naturalWidth,
          height: preview.naturalHeight,
          dataUrlBytes: dataUrl.length,
          fontRequests: requestedUrls.filter((url) =>
            url.includes("fonts.googleapis.com") || url.includes("fonts.gstatic.com")
          ).length,
          avatarRequests: requestedUrls.filter((url) => url.includes("/api/avatars/")).length,
          attachmentRequests: requestedUrls.filter((url) => url.includes("/api/attachments/perf-hung")).length,
        };
      } finally {
        window.fetch = originalFetch;
        host.remove();
      }
    }, scenario));
  }

  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const percentile = (values: number[], percentileValue: number) =>
    values[Math.min(values.length - 1, Math.ceil(values.length * percentileValue) - 1)] ?? 0;
  const summary = {
    samples,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
  };

  await testInfo.attach("select-share-perf.json", {
    body: JSON.stringify(summary, null, 2),
    contentType: "application/json",
  });
  if (process.env.SELECT_SCREENSHOT_PERF_LOG === "1") {
    console.info(`[select-share-perf] ${JSON.stringify(summary)}`);
  }

  expect(summary.p95Ms).toBeLessThanOrEqual(3_000);
  for (const sample of samples) {
    expect(sample.durationMs, sample.name).toBeLessThanOrEqual(3_000);
    expect(sample.width, sample.name).toBeGreaterThan(100);
    expect(sample.height, sample.name).toBeGreaterThan(80);
    expect(sample.height, sample.name).toBeLessThan(5_000);
    expect(sample.fontRequests, sample.name).toBe(0);
  }
  expect(samples.find((sample) => sample.name === "desktop-avatar-500-fallback")?.avatarRequests).toBe(1);
  expect(samples.find((sample) => sample.name === "mobile-font-hung-attachment-hung")?.attachmentRequests).toBe(1);
});
