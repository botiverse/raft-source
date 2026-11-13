import assert from "node:assert/strict";
import "./helpers/domSetup";
import { getDefaultAvatarDataUrl, inlineImagesForScreenshot } from "../src/utils/selectScreenshot";

// #triage:#276: one sender's rows in a share image showed two faces, because
// each row read the avatar on its own and a slow read fell back to the default.

const AVATAR = "https://cdn.example.com/avatars/0d67fa6a-6357-4c17-8ead-d29708752e52/0123456789abcdef0123456789abcdef.webp";

function agentRows(count: number): HTMLImageElement[] {
  document.body.innerHTML = "";
  return Array.from({ length: count }, () => {
    const slot = document.createElement("span");
    slot.dataset.avatarKind = "agent";
    const img = document.createElement("img");
    img.src = AVATAR;
    slot.append(img);
    document.body.append(slot);
    return img;
  });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.innerHTML = "";
});

test("rows sharing an avatar read it once and all show it", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    // The DOM's Blob, which FileReader reads (a Node Response's blob is not).
    return { ok: true, status: 200, blob: async () => new window.Blob(["avatar"], { type: "image/webp" }) } as Response;
  }) as typeof fetch;
  const imgs = agentRows(3);
  await inlineImagesForScreenshot(imgs);
  assert.equal(urls.length, 1, "one read for the three rows");
  const srcs = imgs.map((img) => img.getAttribute("src"));
  assert.match(srcs[0] ?? "", /^data:image\/webp/);
  assert.deepEqual(srcs, [srcs[0], srcs[0], srcs[0]]);
});

test("a failed avatar read gives every row the same default, not a mix", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("", { status: 503 });
  }) as typeof fetch;
  const imgs = agentRows(2);
  await inlineImagesForScreenshot(imgs);
  assert.equal(calls, 1);
  assert.deepEqual(imgs.map((img) => img.getAttribute("src")), [getDefaultAvatarDataUrl("agent"), getDefaultAvatarDataUrl("agent")]);
});

test("the pages of one capture share the reads, so a sender keeps one face across pages", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return { ok: true, status: 200, blob: async () => new window.Blob(["avatar"], { type: "image/webp" }) } as Response;
  }) as typeof fetch;
  const reads = new Map<string, Promise<string>>();
  const page1 = agentRows(1);
  await inlineImagesForScreenshot(page1, reads);
  const page2 = agentRows(1);
  await inlineImagesForScreenshot(page2, reads);
  assert.equal(calls, 1, "page 2 reuses page 1's read");
  assert.equal(page2[0]?.getAttribute("src"), page1[0]?.getAttribute("src"));
});
