// "Doesn't display well here" (#proj-workspace:#243, design v2): what the
// reader's screen gave the page, measured by the viewer (never by the page:
// no Porthole signal in this first version), as the lines it puts in the
// comment list's own box (ArtifactCommentBox at the list's foot), for the
// reader to write under, edit, add images to and send as any comment. The
// lines are fixed English whatever the reader's language, so an agent reads
// the same text from every reader.

import type { ArtifactViewerData } from "@botiverse/raft-shared";

/** The comment's first line, fixed: what an agent recognises a display report by. */
export const DISPLAY_REPORT_FIRST_LINE = "Display report from Raft's viewer:";

/** The browser and OS class: the engine's name and major version, the OS, and on iOS whether a phone or a tablet. No device model. */
export interface DisplayBrowserClass {
  /** "Safari", "Chrome", "Firefox", "Edge", "Opera", "Samsung Internet", "WebKit" (an app's web view on iOS); null: not recognised. */
  browser: string | null;
  /** The major version; null where the user agent names none. */
  version: number | null;
  /** "iOS", "Android", "macOS", "Windows", "ChromeOS", "Linux"; null: not recognised. */
  os: string | null;
  /** On iOS: "iPhone" or "iPad" (an iPad that says it is a Mac, by its touch points); else null. */
  device: "iPhone" | "iPad" | null;
}

/** What the lines say, as the viewer measured it when the person chose the item. */
export interface DisplayReportFacts {
  /** The version shown. */
  version: number;
  /** The frame's page area in CSS px (the iframe's client box; the content's box for a kind drawn without one); null: nothing measured. */
  pageArea: { width: number; height: number } | null;
  /** window.devicePixelRatio. */
  pixelRatio: number;
  browser: DisplayBrowserClass;
}

const major = (match: RegExpMatchArray | null): number | null => {
  const value = match?.[1];
  return value === undefined ? null : Number.parseInt(value, 10);
};

/**
 * The browser and OS class from a user agent string: coarse on purpose (the
 * engine to reproduce in, its major version, the OS), never the string itself
 * or a device model. `maxTouchPoints` tells an iPad that reports itself as a
 * Mac (iPadOS 13 and later) from a Mac.
 */
export function displayBrowserClass(userAgent: string, maxTouchPoints = 0): DisplayBrowserClass {
  const ua = userAgent;
  let os: string | null = null;
  let device: DisplayBrowserClass["device"] = null;
  if (/iPhone|iPod/.test(ua)) {
    os = "iOS";
    device = "iPhone";
  } else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) {
    os = "iOS";
    device = "iPad";
  } else if (/Android/.test(ua)) os = "Android";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";

  // Chromium's other brands first: each also says "Chrome/", and on iOS each says "Safari/".
  const branded: Array<[string, RegExp]> = [
    ["Edge", /(?:EdgiOS|EdgA|Edge?)\/(\d+)/],
    ["Opera", /(?:OPiOS|OPR)\/(\d+)/],
    ["Samsung Internet", /SamsungBrowser\/(\d+)/],
    ["Firefox", /(?:FxiOS|Firefox)\/(\d+)/],
    ["Chrome", /(?:CriOS|Chrome)\/(\d+)/],
  ];
  for (const [browser, pattern] of branded) {
    const match = ua.match(pattern);
    if (match) return { browser, version: major(match), os, device };
  }
  const safari = ua.match(/Version\/(\d+).*Safari\//);
  if (safari) return { browser: "Safari", version: major(safari), os, device };
  // An app's web view on iOS (no "Safari/", no "Version/"): the system's WebKit.
  if (os === "iOS" && /AppleWebKit\//.test(ua)) return { browser: "WebKit", version: null, os, device };
  return { browser: null, version: null, os, device };
}

/**
 * The file the report names: with more than one file, the file the frame opened at (the entry, the comments' `shownPath`:
 * the viewer can't tell which of the set's pages the reader then reached), else none. The comment itself is on the whole
 * Artifact, as every comment from the list's foot box (#proj-workspace:#250): its `Shown file:` line says which file.
 */
export function displayReportShownFile(data: Pick<ArtifactViewerData, "files">, shownPath: string | null): string | null {
  return data.files.length > 1 && shownPath ? shownPath : null;
}

/** The reader's browser class, from this browser. */
export function currentDisplayBrowserClass(): DisplayBrowserClass {
  if (typeof navigator === "undefined") return { browser: null, version: null, os: null, device: null };
  return displayBrowserClass(navigator.userAgent ?? "", navigator.maxTouchPoints ?? 0);
}

/**
 * The page area: the frame's own box (the iframe as the reader sees it, its
 * client width and height in CSS px), inside `page`, the surface's content
 * box; a kind drawn without a frame (an image, a table, text) gets that box.
 * Null when neither has a size (not laid out).
 */
export function measurePageArea(page: HTMLElement | null): DisplayReportFacts["pageArea"] {
  if (!page) return null;
  // Porthole's door is a hidden, opaque frame of its own: never the page.
  const frame = page.querySelector<HTMLIFrameElement>("iframe:not([data-porthole-door])");
  const box = frame && frame.clientWidth > 0 && frame.clientHeight > 0 ? frame : page;
  const width = Math.round(box.clientWidth);
  const height = Math.round(box.clientHeight);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The facts for the version shown, measured now. */
export function measureDisplayReportFacts(page: HTMLElement | null, version: number): DisplayReportFacts {
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  return {
    version,
    pageArea: measurePageArea(page),
    pixelRatio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
    browser: currentDisplayBrowserClass(),
  };
}

/** A pixel ratio as a number: at most two decimals, none when whole ("3", "1.5", "2.63"). */
export function formatPixelRatio(ratio: number): string {
  return String(Math.round(ratio * 100) / 100);
}

/**
 * The lines, plain text in fixed English (design v2, "What the author gets"):
 *
 *   Display report from Raft's viewer:
 *   Version: v3
 *   Shown file: index.html
 *   Page area: 390x703 CSS px · Pixel ratio: 3x
 *   Browser: Safari 18, iOS (iPhone)
 *
 * `Shown file:` only with more than one file (`shownFile`): the entry
 * the frame opened at (the viewer doesn't see a page of the set the reader
 * reached from its links: Porthole tells its host, `porthole/navigating`, but
 * its React frame gives the app no such callback). What wasn't measured is
 * left out, never "unknown": no page area (not laid out), just the pixel
 * ratio; no browser line for a browser and OS not recognised (either alone
 * is said). (The design's "Raft noticed:" line needs Porthole's signals: not
 * in this version.)
 */
export function displayReportText(facts: DisplayReportFacts, shownFile: string | null = null): string {
  const ratio = `Pixel ratio: ${formatPixelRatio(facts.pixelRatio)}x`;
  const lines = [DISPLAY_REPORT_FIRST_LINE, `Version: v${facts.version}`];
  if (shownFile !== null) lines.push(`Shown file: ${shownFile}`);
  lines.push(facts.pageArea ? `Page area: ${facts.pageArea.width}x${facts.pageArea.height} CSS px · ${ratio}` : ratio);
  const name = facts.browser.browser === null ? null : facts.browser.version === null ? facts.browser.browser : `${facts.browser.browser} ${facts.browser.version}`;
  const os = facts.browser.os === null ? null : facts.browser.device === null ? facts.browser.os : `${facts.browser.os} (${facts.browser.device})`;
  const browser = [name, os].filter(Boolean).join(", ");
  if (browser !== "") lines.push(`Browser: ${browser}`);
  return lines.join("\n");
}
