import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { seedAgentMessages } from "../../fixtures/agentMessage";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

const AVATAR_PNG_FIXTURE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("share screenshot keeps pixel, uploaded, gravatar, and fallback avatar cases", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await page.waitForSelector('[data-testid="message-scroller"]');

  // Use the real agent-authored MessageItem/AvatarSlot/PixelAvatar tree for
  // the pixel case. The seeded agent has no custom avatar, so production's
  // default PixelAvatar path is exercised instead of a hand-built div that
  // could pass while the real component regresses.
  const pixelMessageContent = `select-avatar-pixel-${Date.now()}`;
  await seedAgentMessages(
    seedState,
    seedState.agent.id,
    login.accessToken,
    `#${seedState.channel.name}`,
    [pixelMessageContent],
  );
  await expect(page.getByText(pixelMessageContent, { exact: true })).toBeVisible();
  const pixelMessageId = await page.locator('[id^="message-"]', {
    has: page.getByText(pixelMessageContent, { exact: true }),
  }).last().getAttribute("id");
  if (!pixelMessageId) throw new Error("agent-authored pixel message row was not mounted");

  const result = await page.evaluate(async ({ avatarPng, pixelMessageId }) => {
    const { captureSelectedMessages } = window.__SLOCK_E2E__!;
    const originalFetch = window.fetch.bind(window);
    const requestedUrls: string[] = [];
    window.fetch = async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/api/avatars/") || url.includes("gravatar.com/avatar/")) {
        const bytes = Uint8Array.from(atob(avatarPng), (char) => char.charCodeAt(0));
        return new Response(new Blob([bytes], { type: "image/png" }), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      return originalFetch(input, init);
    };
    const pixelRow = document.getElementById(pixelMessageId);
    const pixelAvatar = pixelRow?.querySelector<HTMLElement>("[data-agent-pixel-avatar]");
    if (!pixelRow || !pixelAvatar || pixelAvatar.children.length !== 64) {
      throw new Error("real PixelAvatar was not present in the agent MessageItem");
    }
    const rowRect = pixelRow.getBoundingClientRect();
    const avatarRect = pixelAvatar.getBoundingClientRect();
    const avatarRelative = {
      left: avatarRect.left - rowRect.left,
      top: avatarRect.top - rowRect.top,
      width: avatarRect.width,
      height: avatarRect.height,
    };

    // Make one real PixelAvatar cell uniquely observable and make the known
    // foreignObject failure deterministic: if inlining is removed, this
    // capture-only style hides CSS-grid children, leaving no unique cell.
    // The production tree and AvatarSlot remain untouched outside this export.
    const uniquePixel = "rgb(1, 250, 83)";
    pixelAvatar.style.backgroundColor = "rgb(210, 210, 210)";
    Array.from(pixelAvatar.children).forEach((cell) => {
      (cell as HTMLElement).style.backgroundColor = "transparent";
    });
    (pixelAvatar.children[27] as HTMLElement).style.backgroundColor = uniquePixel;
    // html-to-image's foreignObject path can lose CSS-grid children. Model
    // that serialization-only loss in the observer microtask; the production
    // inliner replaces the children synchronously before this callback runs,
    // while removing that call makes this oracle deterministically RED without
    // changing the live component.
    const captureFailureObserver = new MutationObserver(() => {
      document
        .querySelectorAll<HTMLElement>('[data-select-screenshot-root="true"] [data-agent-pixel-avatar] > div')
        .forEach((cell) => {
          cell.style.visibility = "hidden";
        });
    });
    captureFailureObserver.observe(document.body, { childList: true, subtree: true });

    const host = document.createElement("div");
    host.style.width = "620px";
    host.style.background = "#fff";
    host.style.padding = "20px";
    host.style.fontFamily = getComputedStyle(document.body).fontFamily;

    const uploaded = document.createElement("div");
    uploaded.id = "message-avatar-uploaded-fixture";
    uploaded.dataset.avatarKind = "agent";
    uploaded.style.cssText = "display:flex;gap:12px;border:2px solid transparent;padding:8px;background:transparent";
    uploaded.insertAdjacentHTML("beforeend", "<img alt=\"uploaded\" src=\"https://cdn.invalid/avatars/users/0123456789abcdef0123456789abcdef.webp\" style=\"width:32px;height:32px;object-fit:cover\" /><div><div style='font-weight:700'>Uploaded agent</div><div>uploaded avatar</div></div>");

    const gravatar = document.createElement("div");
    gravatar.id = "message-avatar-gravatar-fixture";
    gravatar.dataset.avatarKind = "human";
    gravatar.style.cssText = "display:flex;gap:12px;border:2px solid transparent;padding:8px;background:transparent";
    gravatar.insertAdjacentHTML("beforeend", "<img alt=\"gravatar\" src=\"https://www.gravatar.com/avatar/0123456789abcdef0123456789abcdef?s=32&d=404\" style=\"width:32px;height:32px;object-fit:cover\" /><div><div style='font-weight:700'>Gravatar human</div><div>gravatar avatar</div></div>");

    const fallback = document.createElement("div");
    fallback.id = "message-avatar-fallback-fixture";
    fallback.style.cssText = "display:flex;gap:12px;border:2px solid transparent;padding:8px;background:transparent";
    fallback.insertAdjacentHTML("beforeend", "<div style='width:32px;height:32px;background-color:rgb(187, 175, 230);border:2px solid rgb(20, 17, 17)'><svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='rgb(20, 17, 17)'><path d='M20 21a8 8 0 0 0-16 0'/><circle cx='12' cy='7' r='4'/></svg></div><div><div style='font-weight:700'>Fallback human</div><div>placeholder avatar</div></div>");

    host.append(uploaded, gravatar, fallback);
    document.body.appendChild(host);
    const dataUrl = await captureSelectedMessages([
      pixelMessageId.replace(/^message-/, ""),
      "avatar-uploaded-fixture",
      "avatar-gravatar-fixture",
      "avatar-fallback-fixture",
    ], { backgroundColor: "#FFFFFF", pixelRatio: 2 });
    captureFailureObserver.disconnect();

    const preview = new Image();
    await new Promise<void>((resolve, reject) => {
      preview.onload = () => resolve();
      preview.onerror = () => reject(new Error("export preview failed to load"));
      preview.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = preview.naturalWidth;
    canvas.height = preview.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("missing canvas context");
    context.drawImage(preview, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let uniquePixelCount = 0;
    let uniquePixelOutsideAvatar = 0;
    let contentStartY = 0;
    let lastYellowRow = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      let yellow = 0;
      for (let x = 0; x < canvas.width; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        const r = pixels[offset]!;
        const g = pixels[offset + 1]!;
        const b = pixels[offset + 2]!;
        if (r > 235 && g > 170 && g < 235 && b < 110) yellow += 1;
      }
      if (yellow > canvas.width * 0.5) lastYellowRow = y;
    }
    for (let y = Math.max(0, lastYellowRow + 1); y < canvas.height; y += 1) {
      let white = 0;
      for (let x = 0; x < canvas.width; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        if (pixels[offset] === 255 && pixels[offset + 1] === 255 && pixels[offset + 2] === 255) white += 1;
      }
      if (white > canvas.width * 0.8) {
        contentStartY = y;
        break;
      }
    }
    const pixelRatio = 2;
    const avatarBounds = {
      left: Math.floor((16 + avatarRelative.left) * pixelRatio) - 3,
      top: Math.floor(contentStartY + (12 + avatarRelative.top) * pixelRatio) - 3,
      right: Math.ceil((16 + avatarRelative.left + avatarRelative.width) * pixelRatio) + 3,
      bottom: Math.ceil(contentStartY + (12 + avatarRelative.top + avatarRelative.height) * pixelRatio) + 3,
    };
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b, a] = pixels.slice(i, i + 4);
      if (a > 220 && r < 20 && g > 235 && b > 60 && b < 110) {
        uniquePixelCount += 1;
        const x = (i / 4) % canvas.width;
        const y = Math.floor(i / 4 / canvas.width);
        if (x < avatarBounds.left || x > avatarBounds.right || y < avatarBounds.top || y > avatarBounds.bottom) {
          uniquePixelOutsideAvatar += 1;
        }
      }
    }
    return {
      dataUrl,
      uniquePixelCount,
      uniquePixelOutsideAvatar,
      avatarBounds,
      contentStartY,
      width: preview.naturalWidth,
      height: preview.naturalHeight,
      requestedUrls,
    };
  }, { avatarPng: AVATAR_PNG_FIXTURE, pixelMessageId });

  expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(result.width).toBeGreaterThan(100);
  expect(result.height).toBeGreaterThan(100);
  expect(result.uniquePixelCount).toBeGreaterThan(16);
  expect(result.uniquePixelOutsideAvatar).toBe(0);
  expect(result.contentStartY).toBeGreaterThan(0);
  expect(result.requestedUrls.some((url) => url.includes("/api/avatars/users/0123456789abcdef0123456789abcdef.webp"))).toBe(true);
  expect(result.requestedUrls.some((url) => url.includes("gravatar.com/avatar/0123456789abcdef0123456789abcdef"))).toBe(true);
});

test("share screenshot does not retry a failed cross-origin avatar in foreignObject", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await page.waitForSelector('[data-testid="message-scroller"]');

  const dataUrl = await page.evaluate(async () => {
    const { captureSelectedMessages } = window.__SLOCK_E2E__!;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/api/avatars/")) {
        return new Response(JSON.stringify({ error: "avatar proxy unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    };

    const host = document.createElement("div");
    host.style.width = "520px";
    host.style.background = "#fff";
    host.style.padding = "20px";
    host.innerHTML = `
      <div id="message-avatar-proxy-failure" data-avatar-kind="human" style="display:flex;gap:12px;border:2px solid transparent;padding:8px;background:transparent">
        <img alt="uploaded avatar" src="https://cdn.invalid/avatars/users/0123456789abcdef0123456789abcdef.webp" style="width:32px;height:32px;object-fit:cover" />
        <div><div style="font-weight:700">Proxy failure</div><div>human avatar must degrade visibly</div></div>
      </div>
      <div id="message-agent-proxy-failure" data-avatar-kind="agent" style="display:flex;gap:12px;border:2px solid transparent;padding:8px;background:transparent">
        <img alt="uploaded agent avatar" src="https://cdn.invalid/avatars/agents/abcdef0123456789abcdef0123456789.webp" style="width:32px;height:32px;object-fit:cover" />
        <div><div style="font-weight:700">Agent proxy failure</div><div>agent default avatar must remain visible</div></div>
      </div>
    `;
    document.body.appendChild(host);

    return captureSelectedMessages(["avatar-proxy-failure", "agent-proxy-failure"], {
      backgroundColor: "#FFFFFF",
      pixelRatio: 2,
    });
  });

  expect(dataUrl).toMatch(/^data:image\/png;base64,/);
});
