// Doesn't display well here (#proj-workspace:#243): the browser and OS class read from a user agent
// (coarse: the engine, its major version, the OS, iPhone or iPad; never the string or a device model),
// and the lines it puts in the comment list's box, fixed English, line for line as design v2's "What the
// author gets": what wasn't measured is left out, never "unknown".
import assert from "node:assert/strict";

import {
  DISPLAY_REPORT_FIRST_LINE,
  displayBrowserClass,
  displayReportShownFile,
  displayReportText,
  formatPixelRatio,
} from "../src/apps/artifacts/artifactDisplayReport";
import type { DisplayReportFacts } from "../src/apps/artifacts/artifactDisplayReport";

const UA = {
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  appWebViewIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  safariIpad: "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  // iPadOS 13+ Safari says it is a Mac; only its touch points tell.
  safariDesktopIpad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edgeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  samsungAndroid: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  operaWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
  firefoxIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  // The desktop app is Electron: Chrome's engine.
  raftDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Raft/1.4.0 Chrome/130.0.6723.191 Electron/33.2.0 Safari/537.36",
};

/** The lines' Browser line for a user agent, after "Browser: "; null: no such line. */
function browserLine(ua: string, touch = 0): string | null {
  const text = displayReportText({ version: 1, pageArea: null, pixelRatio: 1, browser: displayBrowserClass(ua, touch) });
  return text.split("\n").find((line) => line.startsWith("Browser: "))?.slice("Browser: ".length) ?? null;
}

test("the browser class: the engine to reproduce in, its major version, the OS, iPhone or iPad", () => {
  assert.equal(browserLine(UA.safariIphone, 5), "Safari 18, iOS (iPhone)");
  assert.equal(browserLine(UA.chromeIphone, 5), "Chrome 131, iOS (iPhone)");
  assert.equal(browserLine(UA.firefoxIphone, 5), "Firefox 133, iOS (iPhone)");
  assert.equal(browserLine(UA.appWebViewIphone, 5), "WebKit, iOS (iPhone)", "an app's web view: the system's WebKit");
  assert.equal(browserLine(UA.safariIpad, 5), "Safari 17, iOS (iPad)");
  assert.equal(browserLine(UA.safariDesktopIpad, 5), "Safari 18, iOS (iPad)", "a Mac with touch points is an iPad");
  assert.equal(browserLine(UA.safariDesktopIpad, 0), "Safari 18, macOS", "without them, a Mac");
  assert.equal(browserLine(UA.chromeMac), "Chrome 131, macOS");
  assert.equal(browserLine(UA.edgeWindows), "Edge 131, Windows", "Edge, not the Chrome it also names");
  assert.equal(browserLine(UA.operaWindows), "Opera 115, Windows");
  assert.equal(browserLine(UA.firefoxLinux), "Firefox 133, Linux");
  assert.equal(browserLine(UA.chromeAndroid), "Chrome 131, Android");
  assert.equal(browserLine(UA.samsungAndroid), "Samsung Internet 26, Android");
  assert.equal(browserLine(UA.chromebook), "Chrome 131, ChromeOS");
  assert.equal(browserLine(UA.raftDesktop), "Chrome 130, macOS");
  assert.equal(browserLine(""), null, "nothing recognised: no Browser line");
  assert.equal(browserLine("curl/8.4.0"), null);
  assert.equal(browserLine("Mozilla/5.0 (X11; Linux x86_64) Unheard/1.0"), "Linux", "an OS without a browser: the OS alone");
  assert.deepEqual(displayBrowserClass(UA.safariIphone, 5), { browser: "Safari", version: 18, os: "iOS", device: "iPhone" });
});

test("never the user agent itself: no build numbers, no device model", () => {
  for (const ua of Object.values(UA)) {
    const line = browserLine(ua, 0) ?? "";
    assert.ok(!/\d+\.\d+/.test(line), `${line}: a major version only`);
    assert.ok(!/SM-|Mozilla|KHTML|Gecko|Mac OS X/.test(line), `${line}: no token of the string`);
  }
});

test("a pixel ratio: at most two decimals, none when whole", () => {
  assert.equal(formatPixelRatio(3), "3");
  assert.equal(formatPixelRatio(2), "2");
  assert.equal(formatPixelRatio(1.5), "1.5");
  assert.equal(formatPixelRatio(2.625), "2.63");
  assert.equal(formatPixelRatio(1.100000023841858), "1.1");
});

const phone: DisplayReportFacts = {
  version: 3,
  pageArea: { width: 390, height: 703 },
  pixelRatio: 3,
  browser: { browser: "Safari", version: 18, os: "iOS", device: "iPhone" },
};

test("the lines: the fixed first line, then the conditions in fixed English; nothing else (the reader writes under them)", () => {
  assert.equal(
    displayReportText(phone),
    [
      "Display report from Raft's viewer:",
      "Version: v3",
      "Page area: 390x703 CSS px · Pixel ratio: 3x",
      "Browser: Safari 18, iOS (iPhone)",
    ].join("\n"),
  );
  assert.equal(DISPLAY_REPORT_FIRST_LINE, "Display report from Raft's viewer:");
});

test("more than one file: a Shown file: line names the file, and only that", () => {
  assert.equal(
    displayReportText(phone, "index.html"),
    [
      "Display report from Raft's viewer:",
      "Version: v3",
      "Shown file: index.html",
      "Page area: 390x703 CSS px · Pixel ratio: 3x",
      "Browser: Safari 18, iOS (iPhone)",
    ].join("\n"),
  );
  assert.ok(!displayReportText(phone, null).includes("Shown file:"), "one file: no such line");
});

test("a laptop's Chrome; what wasn't measured is left out, never \"unknown\"", () => {
  const laptop: DisplayReportFacts = { version: 2, pageArea: { width: 1232, height: 692 }, pixelRatio: 2, browser: { browser: "Chrome", version: 131, os: "macOS", device: null } };
  assert.equal(
    displayReportText(laptop),
    "Display report from Raft's viewer:\nVersion: v2\nPage area: 1232x692 CSS px · Pixel ratio: 2x\nBrowser: Chrome 131, macOS",
  );
  const unknown: DisplayReportFacts = { version: 1, pageArea: null, pixelRatio: 1.25, browser: { browser: null, version: null, os: null, device: null } };
  assert.equal(
    displayReportText(unknown),
    "Display report from Raft's viewer:\nVersion: v1\nPixel ratio: 1.25x",
    "no Page area clause, no Browser line",
  );
  assert.ok(!/unknown/i.test(displayReportText(unknown)));
});

test("the file it names: the file shown with more than one file, else none (the comment is on the whole Artifact, #250)", () => {
  const two = { files: [{ path: "index.html", kind: "html" as const, sizeBytes: 1, entry: true }, { path: "data.json", kind: "text" as const, sizeBytes: 1, entry: false }] };
  const one = { files: [two.files[0]!] };
  assert.equal(displayReportShownFile(two, "index.html"), "index.html");
  assert.equal(displayReportShownFile(one, "index.html"), null);
  assert.equal(displayReportShownFile(two, null), null);
});
