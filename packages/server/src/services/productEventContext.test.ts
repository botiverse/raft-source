import assert from "node:assert/strict";
import { accountAgeBucket, parseRaftAppClient, productEventContext, requestClient, resetProductEventContextForTest } from "./productEventContext";

const UA = {
  chromeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
  edgeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  samsungAndroid: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

test("the request's browser, OS and device type are kept only as coarse families", () => {
  const cases: Array<[string, Record<string, string | number>]> = [
    [UA.chromeWindows, { $browser: "chrome", $browser_version: 141, $os: "windows", $device_type: "desktop" }],
    [UA.safariIphone, { $browser: "safari", $browser_version: 17, $os: "ios", $device_type: "mobile" }],
    [UA.firefoxLinux, { $browser: "firefox", $browser_version: 131, $os: "linux", $device_type: "desktop" }],
    [UA.edgeMac, { $browser: "edge", $browser_version: 141, $os: "macos", $device_type: "desktop" }],
    [UA.samsungAndroid, { $browser: "samsung_internet", $browser_version: 26, $os: "android", $device_type: "mobile" }],
    [UA.androidTablet, { $browser: "chrome", $browser_version: 141, $os: "android", $device_type: "tablet" }],
  ];
  for (const [userAgent, expected] of cases) {
    assert.deepEqual(productEventContext({ userAgent, country: undefined }), expected, userAgent);
  }
});

test("a missing or unknown user agent is `other`, never a piece of the raw string", () => {
  const other = { $browser: "other", $os: "other", $device_type: "other" };
  assert.deepEqual(productEventContext({ userAgent: undefined, country: undefined }), other);
  assert.deepEqual(productEventContext({ userAgent: "", country: undefined }), other);
  const odd = productEventContext({ userAgent: "curl/8.7.1 alice@example.com token-123", country: undefined });
  assert.equal(JSON.stringify(odd).includes("alice"), false);
  assert.equal(JSON.stringify(odd).includes("token"), false);
  assert.equal(odd.$browser, "other");
});

test("country is kept only as CloudFront's two-letter code", () => {
  assert.equal(productEventContext({ userAgent: undefined, country: "US" }).$country, "US");
  for (const bad of ["us", "USA", "U1", "", "XX-1"]) {
    assert.equal(productEventContext({ userAgent: undefined, country: bad }).$country, undefined, bad);
  }
  assert.equal(productEventContext({ userAgent: undefined, country: undefined }).$country, undefined);
});

test("whether the country header arrives is logged once per process, never its value", () => {
  resetProductEventContextForTest();
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    productEventContext({ userAgent: undefined, country: "JP" });
    productEventContext({ userAgent: undefined, country: "DE" });
    assert.equal(info.mock.calls.length, 1);
    assert.deepEqual(info.mock.calls[0], ["[product-events] CloudFront-Viewer-Country header present"]);
  } finally {
    info.mockRestore();
  }
});

// The App's (Lagoon, #proj-mobile) and the desktop app's (Electron) own User-Agents.
const APP_UA = {
  android: "Raft/1.13.0+456 (Android 14; release) Mobile",
  iphone: "Raft/1.13.0+456 (iPhone; iOS 18.1; release) Mobile",
  ipad: "Raft/1.13.0+456 (iPad; iPadOS 18.1; release) Mobile",
  desktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Raft/0.1.22 Chrome/141.0.0.0 Electron/38.0.0 Safari/537.36",
};

test("requestClient: the App's and the desktop app's version from their User-Agent, without the build", () => {
  assert.deepEqual(requestClient("android", APP_UA.android), { platform: "android", raftVersion: "1.13.0" });
  assert.deepEqual(requestClient("ios", APP_UA.iphone), { platform: "ios", raftVersion: "1.13.0" });
  assert.deepEqual(requestClient("ios", APP_UA.ipad), { platform: "ios", raftVersion: "1.13.0" }, "an iPad is the iOS App, not a tablet browser");
  assert.deepEqual(requestClient(" android ", "Raft/2.0.0-beta.1 (Android 15; debug) Mobile"), { platform: "android", raftVersion: "2.0.0-beta.1" });
  assert.deepEqual(requestClient("android", "Raft/1.13.0 (Android 14; release) Mobile"), { platform: "android", raftVersion: "1.13.0" }, "no build");
  assert.deepEqual(requestClient("desktop_app", APP_UA.desktop), { platform: "desktop_app", raftVersion: "0.1.22" });
});

test("requestClient: no version from a User-Agent that names none, a malformed or overlong one, or a browser's", () => {
  for (const userAgent of [
    undefined,
    "",
    "curl/8.7.1 alice@example.com token-123",
    "Raft/ (Android 14; release) Mobile",
    "Raft/<script>alert(1)</script> (Android 14) Mobile",
    "Raft/1.0<b>+1 (Android 14) Mobile",
    "Raft/v1.13.0+456 (Android 14; release) Mobile",
    "XRaft/1.13.0+456 (Android 14; release) Mobile",
    `Raft/1.${"1".repeat(64)}+456 (Android 14; release) Mobile`,
    `Raft/1.13.0+${"4".repeat(65)} (Android 14; release) Mobile`,
  ]) {
    assert.deepEqual(requestClient("android", userAgent), { platform: "android" }, String(userAgent));
  }
  // Only the App and the desktop app name a Raft version: a browser saying it does is not asked.
  assert.deepEqual(requestClient("browser", `${UA.chromeWindows} Raft/9.9.9`), { platform: "web" });
  assert.deepEqual(requestClient("pwa", "Raft/9.9.9 (Android 14; release) Mobile"), { platform: "pwa" });
  assert.deepEqual(requestClient(undefined, APP_UA.android), { platform: "unknown" });
  assert.deepEqual(requestClient("toaster", APP_UA.android), { platform: "unknown" });
});

test("accountAgeBucket: coarse account age when the event happened", () => {
  const at = new Date("2026-10-22T12:00:00.000Z");
  const daysAgo = (days: number) => new Date(at.getTime() - days * 24 * 60 * 60_000);
  assert.equal(accountAgeBucket(daysAgo(0), at), "0-7d");
  assert.equal(accountAgeBucket(daysAgo(7.9), at), "0-7d");
  assert.equal(accountAgeBucket(daysAgo(8), at), "8-30d");
  assert.equal(accountAgeBucket(daysAgo(30.9), at), "8-30d");
  assert.equal(accountAgeBucket(daysAgo(31), at), "31-90d");
  assert.equal(accountAgeBucket(daysAgo(91), at), "91-365d");
  assert.equal(accountAgeBucket(daysAgo(365.9), at), "91-365d");
  assert.equal(accountAgeBucket(daysAgo(366), at), "365d+");
});

test("parseRaftAppClient: the native App's platform, build number and build type, from the User-Agent alone", () => {
  const cases: Array<[string | undefined, ReturnType<typeof parseRaftAppClient>]> = [
    ["Raft/1.14.0+11400009 (Android 36; play) NetworkKMM/0.1.0-raft.40", { platform: "android", buildNumber: 11400009, buildType: "play" }],
    ["Raft/1.15.1+11501001 (Android 34; release) NetworkKMM/0.1.0-raft.47", { platform: "android", buildNumber: 11501001, buildType: "release" }],
    ["Raft/2.0.0-beta.1+3 (Android 15; debug) Mobile", { platform: "android", buildNumber: 3, buildType: "debug" }],
    ["Raft/1.15.1+1 (iOS; release) NetworkKMM/0.1.0-raft.47", { platform: "ios", buildNumber: 1, buildType: "release" }],
    ["Raft/1.10.0 (iOS 18.2)", { platform: "ios" }],
    [APP_UA.iphone, { platform: "ios", buildNumber: 456, buildType: "release" }],
    [APP_UA.ipad, { platform: "ios", buildNumber: 456, buildType: "release" }],
    ["Raft/1.15.0+11500001 (HarmonyOS 5.0; release)", { platform: "harmonyos", buildNumber: 11500001, buildType: "release" }],
    ["Raft/1.15.0 (OpenHarmony 5.1; alpha)", { platform: "harmonyos", buildType: "alpha" }],
    ["Raft/1.15.0+abc (Android 34; Release Candidate!)", { platform: "android" }],
    ["Raft/1.15.0+99999999999999999999 (Android 34; play)", { platform: "android", buildType: "play" }],
    // Not a native App: web, desktop, unknown systems, junk.
    [APP_UA.desktop, null],
    [UA.chromeWindows, null],
    [UA.samsungAndroid, null],
    ["Raft/1.15.0+1 (Windows 11; release)", null],
    ["Raft/1.15.0+1 (release; Android 14)", null],
    ["MyRaft/1.15.0+1 (Android 34; play)", null],
    ["Raft/ (Android 34; play)", null],
    ["", null],
    [undefined, null],
  ];
  for (const [userAgent, expected] of cases) assert.deepEqual(parseRaftAppClient(userAgent), expected, userAgent);
});
