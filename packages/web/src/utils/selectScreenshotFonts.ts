import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import { getPwaInstallPlatform } from "./pwaInstall";

/**
 * Font CSS for share images.
 *
 * html-to-image paints the cloned messages inside an SVG `<foreignObject>`
 * that the browser loads as an image. An SVG image is its own document: it
 * cannot use the page's `@font-face` fonts, so without embedded faces every
 * Space Grotesk / Space Mono run falls back to a system font. The clone keeps
 * the live layout's widths (html-to-image copies computed styles), so a
 * fallback with different metrics ellipsizes `truncate` text such as sender
 * names, and the whole image reads in the wrong typeface.
 *
 * The app's own faces (fonts.css) are small woff2 files served from this
 * origin, so they are fetched once (normally straight from the HTTP cache),
 * turned into data URLs and reused for every capture in the session. Only
 * these families are embedded: CJK and other scripts use system fonts, which
 * an SVG image can reach. html-to-image's own embedding pass stays off — it
 * walks and fetches every stylesheet, including third-party ones, which once
 * held the share action on "Rendering..." (#7024).
 */

export const SCREENSHOT_FONT_FAMILIES: ReadonlySet<string> = new Set([
  "Space Grotesk",
  "Space Mono",
  "Raft Quote Glyphs",
]);

const FONT_FETCH_TIMEOUT_MS = 1_500;
const FONT_FACE_RULE_TYPE = 5; // CSSRule.FONT_FACE_RULE
const CSS_URL_PATTERN = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;

const WEBKIT_WARM_UP_TIMEOUT_MS = 1_000;

let cachedFontEmbedCss: Promise<string | null> | null = null;
// Per file, successes only: a face that failed is fetched again by the next
// build, the ones that worked are not.
const fontDataUrlCache = new Map<string, Promise<string>>();

function normalizeFamily(family: string): string {
  return family.trim().replace(/^["']|["']$/g, "");
}

function collectAppFontFaceRules(doc: Document): CSSFontFaceRule[] {
  const rules: CSSFontFaceRule[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    let sheetRules: CSSRuleList;
    try {
      sheetRules = sheet.cssRules;
    } catch {
      continue; // cross-origin stylesheet: not ours, and not readable
    }
    for (const rule of Array.from(sheetRules)) {
      if (rule.type !== FONT_FACE_RULE_TYPE) continue;
      const fontRule = rule as CSSFontFaceRule;
      if (SCREENSHOT_FONT_FAMILIES.has(normalizeFamily(fontRule.style.getPropertyValue("font-family")))) {
        rules.push(fontRule);
      }
    }
  }
  return rules;
}

function resolveSameOriginUrl(raw: string, base: string, origin: string): string | null {
  if (raw.startsWith("data:")) return null;
  try {
    const url = new URL(raw, base);
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export interface FontFetchClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultClock: FontFetchClock = { setTimeout: setClockTimeout, clearTimeout: clearClockTimeout };

export interface BuildScreenshotFontEmbedCssOptions {
  fetchImpl?: typeof fetch;
  clock?: FontFetchClock;
  timeoutMs?: number;
}

export interface ScreenshotFontEmbedCss {
  css: string | null;
  /** Every same-origin app face was embedded (nothing to retry). */
  complete: boolean;
}

async function fetchFontAsDataUrl(
  url: string,
  fetchImpl: typeof fetch,
  clock: FontFetchClock,
  timeoutMs: number,
): Promise<string> {
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  let timeoutId: unknown;
  // Abort the request, and do not wait on a fetch that ignores the signal.
  const timedOut = new Promise<never>((_, reject) => {
    timeoutId = clock.setTimeout(() => {
      controller?.abort();
      reject(new Error("Font fetch timed out"));
    }, timeoutMs);
  });
  const load = async () => {
    const response = await fetchImpl(url, { signal: controller?.signal, credentials: "same-origin" });
    if (!response.ok) throw new Error(`Font fetch failed (${response.status})`);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    // A missing asset can come back as the SPA's index.html with a 200.
    if (contentType.startsWith("text/")) throw new Error(`Font fetch returned ${contentType}`);
    // Some static hosts serve woff2 as octet-stream; the data URL type only
    // has to be a font type the image document accepts.
    const type = contentType.startsWith("font/") ? contentType : "font/woff2";
    return `data:${type};base64,${bytesToBase64(new Uint8Array(await response.arrayBuffer()))}`;
  };
  try {
    return await Promise.race([load(), timedOut]);
  } finally {
    clock.clearTimeout(timeoutId);
  }
}

function cachedFontDataUrl(href: string, fetchFont: (url: string) => Promise<string>): Promise<string | null> {
  let pending = fontDataUrlCache.get(href);
  if (!pending) {
    pending = fetchFont(href);
    fontDataUrlCache.set(href, pending);
    pending.catch(() => {
      if (fontDataUrlCache.get(href) === pending) fontDataUrlCache.delete(href);
    });
  }
  return pending.catch(() => null);
}

/**
 * Build `@font-face` CSS with the app's faces inlined as data URLs. Faces whose
 * file is cross-origin or fails to load are left out (they fall back like
 * before); `css` is null when nothing could be embedded.
 */
export async function buildScreenshotFontEmbedCss(
  doc: Document = document,
  { fetchImpl = fetch, clock = defaultClock, timeoutMs = FONT_FETCH_TIMEOUT_MS }: BuildScreenshotFontEmbedCssOptions = {},
): Promise<ScreenshotFontEmbedCss> {
  const origin = doc.defaultView?.location.origin ?? "";
  const fetchFont = (url: string) => fetchFontAsDataUrl(url, fetchImpl, clock, timeoutMs);
  let complete = true;
  const faces = await Promise.all(collectAppFontFaceRules(doc).map(async (rule) => {
    const base = rule.parentStyleSheet?.href ?? doc.baseURI;
    let cssText = rule.cssText;
    let embedded = false;
    for (const match of Array.from(cssText.matchAll(CSS_URL_PATTERN))) {
      const href = resolveSameOriginUrl(match[2] ?? "", base, origin);
      if (!href) continue;
      const dataUrl = await cachedFontDataUrl(href, fetchFont);
      if (!dataUrl) {
        complete = false;
        continue;
      }
      cssText = cssText.replace(match[0], `url("${dataUrl}")`);
      embedded = true;
    }
    return embedded ? cssText : null;
  }));
  const css = faces.filter((face): face is string => face !== null).join("\n");
  return { css: css || null, complete };
}

/**
 * WebKit can draw an SVG image before the data-URL fonts inside it are ready,
 * so the first share image of a session would be set in fallback fonts. Load
 * the faces once in a throwaway SVG image (and paint it) before the real one.
 * Chromium and Firefox resolve the faces before the image's load event.
 */
export function isWebKitFontWarmUpNeeded(userAgent: string): boolean {
  const platform = getPwaInstallPlatform(userAgent);
  if (platform === "ios_safari" || platform === "ios_other") return true; // every iOS browser is WebKit
  if (platform !== "other") return false;
  const ua = userAgent.toLowerCase();
  // Desktop Safari ("Version/x Safari/y"); Chromium and Firefox are not "other".
  return ua.includes("applewebkit") && ua.includes("safari") && ua.includes("version/") && !ua.includes("android");
}

const WARM_UP_RUNS: ReadonlyArray<readonly [family: string, weight: number, text: string]> = [
  ["Space Grotesk", 400, "Aa ąẠ"],
  ["Space Grotesk", 700, "Aa ąẠ"],
  ["Space Mono", 400, "Aa ąẠ"],
  ["Space Mono", 700, "Aa ąẠ"],
  ["Raft Quote Glyphs", 400, "&quot;"],
];

export function screenshotFontWarmUpSvg(css: string): string {
  const runs = WARM_UP_RUNS
    .map(([family, weight, text]) => `<span style="font-family:'${family}';font-weight:${weight}">${text}</span>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><foreignObject width="100%" height="100%">`
    + `<div xmlns="http://www.w3.org/1999/xhtml"><style>${css}</style>${runs}</div></foreignObject></svg>`;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function warmUpFontsInSvgImage(css: string): Promise<void> {
  const image = new Image();
  image.decoding = "sync";
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Font warm-up image failed"));
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(screenshotFontWarmUpSvg(css))}`;
  await loaded;
  await image.decode().catch(() => undefined);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  canvas.getContext("2d")?.drawImage(image, 0, 0, 1, 1);
  await nextFrame();
  await nextFrame();
}

async function warmUpFontsForWebKit(css: string): Promise<void> {
  if (typeof navigator === "undefined" || !isWebKitFontWarmUpNeeded(navigator.userAgent)) return;
  let timeoutId: unknown;
  try {
    await Promise.race([
      warmUpFontsInSvgImage(css),
      new Promise<void>((resolve) => {
        timeoutId = setClockTimeout(resolve, WEBKIT_WARM_UP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    /* noop — the warm-up is best-effort */
  } finally {
    clearClockTimeout(timeoutId);
  }
}

/**
 * Session-cached font CSS for share captures (WebKit warm-up included). Only a
 * build that embedded every face is cached; otherwise the next capture builds
 * again, refetching only the files that failed. A capture never fails because
 * of fonts (it falls back to system fonts, as before).
 */
export function getScreenshotFontEmbedCss(): Promise<string | null> {
  if (cachedFontEmbedCss) return cachedFontEmbedCss;
  // Declared before it is built: the build's own failure paths compare against it.
  let pending: Promise<string | null> | null = null;
  pending = (async () => {
    const { css, complete } = await buildScreenshotFontEmbedCss();
    if (css) await warmUpFontsForWebKit(css);
    if (!complete || !css) {
      if (cachedFontEmbedCss === pending) cachedFontEmbedCss = null;
    }
    return css;
  })().catch(() => {
    if (cachedFontEmbedCss === pending) cachedFontEmbedCss = null;
    return null;
  });
  cachedFontEmbedCss = pending;
  return pending;
}

export function resetScreenshotFontEmbedCssForTests(): void {
  cachedFontEmbedCss = null;
  fontDataUrlCache.clear();
}
