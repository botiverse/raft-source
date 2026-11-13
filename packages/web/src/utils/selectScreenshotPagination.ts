import {
  planScreenshotPixelRatio,
  SCREENSHOT_PIXEL_BUDGET,
} from "./screenshotBudget";

export const DEFAULT_SCREENSHOT_PAGE_PIXEL_BUDGET = SCREENSHOT_PIXEL_BUDGET;

export interface ScreenshotMessageMeasure {
  id: string;
  /** Height of the sanitized message row in CSS pixels. */
  cssHeight: number;
}

export interface ScreenshotPageSegment {
  messageId: string;
  /** Vertical offset inside the sanitized message row, in CSS pixels. */
  sourceOffsetTop: number;
  /** Height copied from the sanitized message row, in CSS pixels. */
  cssHeight: number;
  continuedFromPrevious: boolean;
  continuesOnNext: boolean;
}

export interface ScreenshotPagePlan {
  pageNumber: number;
  pageCount: number;
  pixelRatio: number;
  /** Expected complete page height, including repeated page chrome. */
  cssHeight: number;
  segments: ScreenshotPageSegment[];
}

export interface PlanScreenshotPagesOptions {
  cssWidth: number;
  /** Repeated header and content padding included on every page. */
  pageChromeCssHeight: number;
  /** Space reserved for visible continuation labels on split-message pages. */
  continuationChromeCssHeight?: number;
  preferredPixelRatio: number;
  maxOutputPixels?: number;
}

export class ScreenshotPagePlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenshotPagePlanningError";
  }
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ScreenshotPagePlanningError(`${label} must be a positive finite number`);
  }
  return value;
}

function resolvePlanningPixelRatio(
  cssWidth: number,
  pageChromeCssHeight: number,
  preferredPixelRatio: number,
  maxOutputPixels: number,
): number {
  positiveFinite(preferredPixelRatio, "preferredPixelRatio");
  const plan = planScreenshotPixelRatio(
    cssWidth,
    pageChromeCssHeight,
    preferredPixelRatio,
    maxOutputPixels,
  );
  if (plan.kind === "needsPagination") {
    throw new ScreenshotPagePlanningError("Page chrome exceeds the screenshot pixel budget at 1x");
  }
  return plan.pixelRatio;
}

function segmentChromeHeight(segment: Pick<ScreenshotPageSegment, "continuedFromPrevious" | "continuesOnNext">, markerHeight: number): number {
  return Number(segment.continuedFromPrevious) * markerHeight
    + Number(segment.continuesOnNext) * markerHeight;
}

/**
 * Plan deterministic screenshot pages without touching the live DOM.
 *
 * Whole messages stay together whenever they fit. A message taller than one
 * page is split into ordered source slices, with space reserved for visible
 * continuation labels. The caller performs the actual DOM clipping and adds
 * those labels during capture.
 */
export function planScreenshotPages(
  messages: readonly ScreenshotMessageMeasure[],
  options: PlanScreenshotPagesOptions,
): ScreenshotPagePlan[] {
  if (messages.length === 0) return [];

  const cssWidth = positiveFinite(options.cssWidth, "cssWidth");
  const pageChromeCssHeight = positiveFinite(options.pageChromeCssHeight, "pageChromeCssHeight");
  const continuationChromeCssHeight = options.continuationChromeCssHeight == null
    ? 24
    : positiveFinite(options.continuationChromeCssHeight, "continuationChromeCssHeight");
  const maxOutputPixels = positiveFinite(
    options.maxOutputPixels ?? DEFAULT_SCREENSHOT_PAGE_PIXEL_BUDGET,
    "maxOutputPixels",
  );
  const pixelRatio = resolvePlanningPixelRatio(
    cssWidth,
    pageChromeCssHeight,
    options.preferredPixelRatio,
    maxOutputPixels,
  );
  const maxPageCssHeight = Math.floor(maxOutputPixels / (cssWidth * pixelRatio * pixelRatio));
  const wholeMessageCapacity = maxPageCssHeight - pageChromeCssHeight;
  const splitMessageCapacity = wholeMessageCapacity - (continuationChromeCssHeight * 2);
  if (wholeMessageCapacity <= 0 || splitMessageCapacity <= 0) {
    throw new ScreenshotPagePlanningError("Screenshot page has no room for message content");
  }

  const rawPages: Array<Omit<ScreenshotPagePlan, "pageNumber" | "pageCount">> = [];
  let wholeSegments: ScreenshotPageSegment[] = [];
  let wholeHeight = 0;

  const flushWholePage = () => {
    if (wholeSegments.length === 0) return;
    rawPages.push({
      pixelRatio,
      cssHeight: pageChromeCssHeight + wholeHeight,
      segments: wholeSegments,
    });
    wholeSegments = [];
    wholeHeight = 0;
  };

  for (const message of messages) {
    const messageHeight = positiveFinite(message.cssHeight, `cssHeight for ${message.id}`);
    if (messageHeight <= wholeMessageCapacity) {
      if (wholeHeight + messageHeight > wholeMessageCapacity) flushWholePage();
      wholeSegments.push({
        messageId: message.id,
        sourceOffsetTop: 0,
        cssHeight: messageHeight,
        continuedFromPrevious: false,
        continuesOnNext: false,
      });
      wholeHeight += messageHeight;
      continue;
    }

    flushWholePage();
    const sliceCount = Math.ceil(messageHeight / splitMessageCapacity);
    let sourceOffsetTop = 0;
    for (let sliceIndex = 0; sliceIndex < sliceCount; sliceIndex += 1) {
      const remaining = messageHeight - sourceOffsetTop;
      const sliceHeight = Math.min(splitMessageCapacity, remaining);
      const segment: ScreenshotPageSegment = {
        messageId: message.id,
        sourceOffsetTop,
        cssHeight: sliceHeight,
        continuedFromPrevious: sliceIndex > 0,
        continuesOnNext: sliceIndex < sliceCount - 1,
      };
      rawPages.push({
        pixelRatio,
        cssHeight: pageChromeCssHeight
          + sliceHeight
          + segmentChromeHeight(segment, continuationChromeCssHeight),
        segments: [segment],
      });
      sourceOffsetTop += sliceHeight;
    }
  }
  flushWholePage();

  const pageCount = rawPages.length;
  return rawPages.map((page, index) => ({
    ...page,
    pageNumber: index + 1,
    pageCount,
  }));
}
