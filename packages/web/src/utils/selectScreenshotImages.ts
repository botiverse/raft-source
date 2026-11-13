// Image inlining for the select-messages share image (selectScreenshot):
// each cloned <img> becomes a data URL before rasterizing, or a visible
// fallback (the default avatar for avatar slots) when it cannot be read.

import { errorClassOf } from "@botiverse/raft-shared";
import { DEFAULT_AVATAR_KEY, pixelAvatarDataUrl } from "../components/agent/PixelAvatar";
import { useServerStore } from "../store/serverStore";
import { RUNTIME_API_BASE } from "../runtimeEndpoints";

const TRANSPARENT_GIF =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const API_BASE = RUNTIME_API_BASE;

const IMAGE_INLINE_TIMEOUT_MS = 1_000;
// Avatars fall back to the default sprite when they miss this, so a slow
// avatar read would show one sender with two faces (#triage:#276).
const AVATAR_INLINE_TIMEOUT_MS = 4_000;

class SelectScreenshotImageInlineTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Image inlining timed out after ${Math.max(1, Math.ceil(timeoutMs / 1000))}s`);
    this.name = "SelectScreenshotImageInlineTimeoutError";
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  const reader = new FileReader();
  return new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

function getAuthHeaders(): HeadersInit {
  const headers: Record<string, string> = {};
  const token = localStorage.getItem("slock_access_token");
  const serverId = useServerStore.getState().current?.id;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (serverId) headers["X-Server-Id"] = serverId;
  return headers;
}

export function resolveAvatarImageFetchTargetUrl(src: string, baseHref = window.location.href): string | null {
  const url = new URL(src, baseHref);
  const avatarMatch = url.pathname.match(/(?:^|\/)avatars\/([^/]+)\/([0-9a-f]+\.webp)$/i);
  if (!avatarMatch) return null;
  const [, namespace, filename] = avatarMatch;
  return `${API_BASE}/avatars/${encodeURIComponent(namespace)}/${encodeURIComponent(filename)}`;
}

function getPublicAvatarFetchInit(): RequestInit {
  return {
    cache: "no-cache",
    mode: "cors",
    credentials: "omit",
  };
}

type ScreenshotImageFetchTarget = {
  url: string;
  timeoutMs?: number;
  init: RequestInit;
  preserveOriginalOnFailure: boolean;
  avatarFallbackKind?: string;
};

function getImageFetchTarget(img: HTMLImageElement): ScreenshotImageFetchTarget | null {
  const attachmentId = img.dataset.selectScreenshotAttachmentId;
  if (attachmentId) {
    return {
      preserveOriginalOnFailure: false,
      url: `${API_BASE}/attachments/${encodeURIComponent(attachmentId)}?disposition=inline&selectScreenshot=1`,
      init: {
        headers: getAuthHeaders(),
        cache: "no-cache",
      },
    };
  }

  const src = img.currentSrc || img.src || img.getAttribute("src") || "";
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return null;

  const avatarFallbackKind = img.closest<HTMLElement>("[data-avatar-kind]")?.dataset.avatarKind;
  const url = new URL(src, window.location.href);
  const avatarApiUrl = resolveAvatarImageFetchTargetUrl(url.toString());
  if (avatarApiUrl) {
    return {
      preserveOriginalOnFailure: true,
      avatarFallbackKind: avatarFallbackKind ?? "human",
      url: avatarApiUrl,
      timeoutMs: AVATAR_INLINE_TIMEOUT_MS,
      init: getPublicAvatarFetchInit(),
    };
  }

  const sameOrigin = url.origin === window.location.origin;
  return {
    preserveOriginalOnFailure: Boolean(avatarFallbackKind),
    avatarFallbackKind,
    url: url.toString(),
    ...(avatarFallbackKind ? { timeoutMs: AVATAR_INLINE_TIMEOUT_MS } : {}),
    init: sameOrigin
      ? {
          headers: getAuthHeaders(),
          cache: "no-cache",
        }
      : {
          credentials: "omit",
          mode: "cors",
          cache: "no-cache",
        },
  };
}

async function fetchImageForScreenshot(
  url: string,
  init: RequestInit,
  timeoutMs = IMAGE_INLINE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new SelectScreenshotImageInlineTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetch(url, {
        ...init,
        signal: controller.signal,
      }),
      timeout,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function freezeRenderedImageBox(img: HTMLImageElement): void {
  const rect = img.getBoundingClientRect();
  if (rect.width > 16 && rect.height > 16) {
    img.style.width = `${rect.width}px`;
    img.style.height = `${rect.height}px`;
    return;
  }

  const sourceWidth = Number(img.dataset.selectScreenshotAttachmentWidth);
  const sourceHeight = Number(img.dataset.selectScreenshotAttachmentHeight);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    return;
  }

  const maxWidth = Math.min(416, img.parentElement?.parentElement?.getBoundingClientRect().width || 416);
  const maxHeight = 288;
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  img.style.width = `${Math.max(1, Math.round(sourceWidth * scale))}px`;
  img.style.height = `${Math.max(1, Math.round(sourceHeight * scale))}px`;
}

async function decodeImage(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return;
  try {
    await Promise.race([
      img.decode(),
      new Promise<void>((r) => setTimeout(r, 2000)),
    ]);
  } catch {
    /* image failed to decode; rasterize whatever the browser has */
  }
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const DEFAULT_HUMAN_AVATAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#BBAFE6"/><path d="M20 21a8 8 0 0 0-16 0" fill="none" stroke="#141111" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/><circle cx="12" cy="7" r="4" fill="none" stroke="#141111" stroke-width="2"/></svg>';

// The agent default is the same robot sprite AgentAvatar renders when a custom
// image is unavailable — built by the single pixel-avatar SVG builder, so a
// failed image never depends on React state.
const DEFAULT_AGENT_AVATAR_DATA_URL = pixelAvatarDataUrl(DEFAULT_AVATAR_KEY) ?? "";

/**
 * Return the same visible default-avatar treatment used by AvatarSlot when a
 * cloned share image cannot load an avatar. Unknown callers use the human
 * placeholder because it is the neutral AvatarSlot fallback.
 */
export function getDefaultAvatarDataUrl(kind?: string): string {
  return kind === "agent" ? DEFAULT_AGENT_AVATAR_DATA_URL : svgDataUrl(DEFAULT_HUMAN_AVATAR_SVG);
}

function inlineDefaultAvatarForScreenshot(img: HTMLImageElement): void {
  const kind = img.closest<HTMLElement>("[data-avatar-kind]")?.dataset.avatarKind;
  // srcset can otherwise win URL selection again after assigning the data URL.
  img.removeAttribute("srcset");
  img.removeAttribute("sizes");
  img.hidden = false;
  img.style.display = "block";
  img.style.visibility = "visible";
  img.style.opacity = "1";
  img.dataset.selectScreenshotAvatarFallback = kind ?? "human";
  img.src = getDefaultAvatarDataUrl(kind);
}

function canRasterizeOriginalImage(src: string): boolean {
  if (src.startsWith("data:") || src.startsWith("blob:")) return true;
  try {
    // A foreignObject rasterizer cannot reliably re-read a cross-origin image
    // that was not converted to a data URL. Keep a same-origin original only;
    // CDN capability URLs must use the API/data-url path or a safe placeholder.
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** One read per image URL in a capture: a sender's avatar repeats on every row and page. */
export type ScreenshotImageReads = Map<string, Promise<string>>;

function readImageDataUrlOnce(reads: ScreenshotImageReads, target: ScreenshotImageFetchTarget): Promise<string> {
  let read = reads.get(target.url);
  if (!read) {
    read = (async () => {
      const response = await fetchImageForScreenshot(target.url, target.init, target.timeoutMs);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return blobToDataUrl(await response.blob());
    })();
    reads.set(target.url, read);
  }
  return read;
}

/** Inline every image of a cloned capture; rows sharing an image share its one read and its outcome. */
export async function inlineImagesForScreenshot(
  imgs: readonly HTMLImageElement[],
  reads: ScreenshotImageReads = new Map(),
): Promise<void> {
  await Promise.all(imgs.map((img) => inlineImageForScreenshot(img, reads)));
}

async function inlineImageForScreenshot(img: HTMLImageElement, reads: ScreenshotImageReads): Promise<void> {
  freezeRenderedImageBox(img);
  const target = getImageFetchTarget(img);
  if (!target) {
    await decodeImage(img);
    return;
  }

  const originalSrc = img.currentSrc || img.src || img.getAttribute("src") || target.url;
  try {
    img.src = await readImageDataUrlOnce(reads, target);
    await decodeImage(img);
  } catch (err) {
    // The live browser may already have decoded an uploaded avatar from its
    // capability URL even when the API fallback is unavailable. Keep that
    // source for html-to-image's best-effort pass instead of exposing the
    // AvatarSlot placeholder background in the generated image.
    if (target.preserveOriginalOnFailure && canRasterizeOriginalImage(originalSrc)) {
      img.src = originalSrc;
      await decodeImage(img);
      if (img.complete && img.naturalWidth > 0) return;
    }

    // Keep the already-frozen rendered dimensions so one bad image cannot
    // collapse the whole message into a tiny placeholder in the export.
    console.warn(
      "captureSelectedMessages: image inlining failed, using placeholder",
      {
        src: originalSrc,
        fetchUrl: target.url,
        error: err,
        errMessage: err instanceof Error ? err.message : String(err),
        errName: errorClassOf(err),
      },
    );
    if (target.avatarFallbackKind) {
      inlineDefaultAvatarForScreenshot(img);
    } else {
      img.src = TRANSPARENT_GIF;
    }
    await decodeImage(img);
  }
}
