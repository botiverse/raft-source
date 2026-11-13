import { dataUrlToBlob } from "./dataUrlBlob";

// Task #1302: a selected-message screenshot is one canvas. Past an engine's
// canvas budget the browser does not throw; `toDataURL` returns an empty
// `data:,`, which used to reach preview, download, X upload and native share
// as a 0-byte PNG. iOS Safari has the lowest budget (16,777,216 pixels), so
// every engine gets the same, slightly lower, budget.

export const SCREENSHOT_PIXEL_BUDGET = 16_000_000;

/** Fallback ratios, highest first. The preferred ratio is tried before them. */
const FALLBACK_PIXEL_RATIOS = [3, 2, 1] as const;

export type ScreenshotPixelPlan =
  | { kind: "fits"; pixelRatio: number; width: number; height: number }
  /** Even 1x is over budget: Phase B (task #1303) splits it into pages. */
  | { kind: "needsPagination"; cssWidth: number; cssHeight: number; budget: number };

/**
 * The highest pixel ratio, starting from `preferredRatio` and falling back
 * 3 → 2 → 1, whose canvas stays within `budget` pixels.
 */
export function planScreenshotPixelRatio(
  cssWidth: number,
  cssHeight: number,
  preferredRatio: number,
  budget: number = SCREENSHOT_PIXEL_BUDGET,
): ScreenshotPixelPlan {
  const ratios = [preferredRatio, ...FALLBACK_PIXEL_RATIOS.filter((ratio) => ratio < preferredRatio)];
  for (const pixelRatio of ratios) {
    const width = Math.ceil(cssWidth * pixelRatio);
    const height = Math.ceil(cssHeight * pixelRatio);
    if (width > 0 && height > 0 && width * height <= budget) return { kind: "fits", pixelRatio, width, height };
  }
  return { kind: "needsPagination", cssWidth, cssHeight, budget };
}

export class ScreenshotNeedsPaginationError extends Error {
  readonly plan: Extract<ScreenshotPixelPlan, { kind: "needsPagination" }>;

  constructor(plan: Extract<ScreenshotPixelPlan, { kind: "needsPagination" }>) {
    super(`Selection is too long for one image (${Math.round(plan.cssWidth)}x${Math.round(plan.cssHeight)} CSS px)`);
    this.name = "ScreenshotNeedsPaginationError";
    this.plan = plan;
  }
}

export type ScreenshotInvalidReason = "not-png" | "empty-blob" | "undecodable" | "zero-size";

export class ScreenshotInvalidOutputError extends Error {
  readonly reason: ScreenshotInvalidReason;

  constructor(reason: ScreenshotInvalidReason) {
    super(`Rendered image is unusable (${reason})`);
    this.name = "ScreenshotInvalidOutputError";
    this.reason = reason;
  }
}

/**
 * A PNG that passed `validateScreenshotPng`. Preview, download, X upload and
 * native share take this type, never a bare data URL, so none of them can
 * receive an unchecked render.
 */
export interface ValidatedScreenshot {
  readonly dataUrl: string;
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  /** The ratio it was rendered at; may be lower than the screen's. */
  readonly pixelRatio: number;
}

export interface ScreenshotValidationDeps {
  toBlob: (dataUrl: string) => Promise<Blob>;
  decode: (blob: Blob) => Promise<{ width: number; height: number }>;
}

async function decodeImageSize(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("decode failed"));
      image.src = url;
    });
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const realDeps: ScreenshotValidationDeps = {
  // Decoded in place, not fetched: Raft Desktop's page policy refuses `fetch` of a data URL (#triage:#352).
  toBlob: async (dataUrl) => dataUrlToBlob(dataUrl),
  decode: decodeImageSize,
};

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

export async function validateScreenshotPng(
  dataUrl: string,
  pixelRatio: number,
  deps: ScreenshotValidationDeps = realDeps,
): Promise<ValidatedScreenshot> {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX) || dataUrl.length <= PNG_DATA_URL_PREFIX.length) {
    throw new ScreenshotInvalidOutputError("not-png");
  }
  let blob: Blob;
  try {
    blob = await deps.toBlob(dataUrl);
  } catch {
    throw new ScreenshotInvalidOutputError("empty-blob");
  }
  if (blob.size === 0) throw new ScreenshotInvalidOutputError("empty-blob");
  let size: { width: number; height: number };
  try {
    size = await deps.decode(blob);
  } catch {
    throw new ScreenshotInvalidOutputError("undecodable");
  }
  if (!(size.width > 0 && size.height > 0)) throw new ScreenshotInvalidOutputError("zero-size");
  return { dataUrl, blob, width: size.width, height: size.height, pixelRatio };
}
