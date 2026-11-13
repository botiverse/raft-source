/**
 * What the select-and-share UI needs from the screenshot export without its
 * code: the export itself (selectScreenshot.ts, html-to-image) loads when an
 * image is made (useSelectionShareHandlers).
 */

export const SHARE_PREVIEW_MAX_WIDTH = 768;

export class SelectScreenshotTimeoutError extends Error {
  readonly timeoutSeconds: number;

  constructor(timeoutMs: number) {
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    super(`Rendering timed out after ${timeoutSeconds}s`);
    this.name = "SelectScreenshotTimeoutError";
    this.timeoutSeconds = timeoutSeconds;
  }
}

export class SelectScreenshotTransientContentError extends Error {
  readonly messageIds: readonly string[];

  constructor(messageIds: readonly string[]) {
    super("Selected messages still contain content that is loading or needs attention");
    this.name = "SelectScreenshotTransientContentError";
    this.messageIds = messageIds;
  }
}

/**
 * Some selected messages have no row in the DOM even with every timeline row
 * mounted: the capture is refused rather than leaving them out of the image.
 */
export class SelectScreenshotRowsMissingError extends Error {
  readonly missingMessageIds: readonly string[];
  readonly total: number;

  constructor(missingMessageIds: readonly string[], total: number) {
    super(`${missingMessageIds.length} of ${total} selected messages are not rendered`);
    this.name = "SelectScreenshotRowsMissingError";
    this.missingMessageIds = missingMessageIds;
    this.total = total;
  }
}

/**
 * Trigger a browser download for a `data:image/png;base64,...` URL.
 */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
