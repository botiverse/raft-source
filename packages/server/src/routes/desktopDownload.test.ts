import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

import {
  type DesktopFeedSource,
  HANDS_FEED_BASE,
  desktopDownloadFallbackUrl,
  desktopFeedSourceFromEnv,
  GITHUB_RELEASES_BASE,
  resetDesktopDownloadCacheForTest,
  isDesktopTarget,
  lookupDesktopAsset,
  lookupDesktopPlatforms,
  parseUpdateFeed,
} from "./desktopDownload";

// The real latest-mac.yml of desktop-beta v0.1.42, as electron-builder wrote it.
const MAC_FEED = `version: 0.1.42
files:
- url: Raft-Desktop-0.1.42-x64.zip
  sha512: 2FOw==
  size: 179049932
- url: Raft-Desktop-0.1.42-arm64.zip
  sha512: sAKC==
  size: 173576747
- url: Raft-Desktop-0.1.42-x64.dmg
  sha512: 6LE8==
  size: 167443598
- url: Raft-Desktop-0.1.42-arm64.dmg
  sha512: mcEM==
  size: 162809563
path: Raft-Desktop-0.1.42-x64.zip
sha512: 2FOw==
releaseDate: '2026-10-12T16:47:42.526Z'
minimumSystemVersion: 22.0.0
`;

// The real latest-linux.yml of v0.1.42 (indented list, as the release job writes it).
const LINUX_FEED = `version: 0.1.42
files:
  - url: Raft-Desktop-0.1.42-x86_64.AppImage
    sha512: Rp82==
    size: 137221139
    blockMapSize: 144423
  - url: Raft-Desktop-0.1.42-amd64.deb
    sha512: B+WQ==
    size: 117049482
path: Raft-Desktop-0.1.42-x86_64.AppImage
sha512: Rp82==
releaseDate: '2026-10-12T16:26:07.802Z'
`;

// The real Hands feeds of v1.21.26 (https://hands.build/electron/raft-desktop/main), hashes shortened.
const HANDS_MAC_FEED = `version: 1.21.26
files:
- url: Raft-Desktop-1.21.26-x64.zip
  sha512: Hq9k==
  size: 169994275
- url: Raft-Desktop-1.21.26-arm64.zip
  sha512: g5uW==
  size: 164413786
- url: Raft-Desktop-1.21.26-x64.dmg
  sha512: a4nK==
  size: 158172657
- url: Raft-Desktop-1.21.26-arm64.dmg
  sha512: aOD/==
  size: 153522334
- url: Raft-Desktop-1.21.26-universal.dmg
  sha512: jO8M==
  size: 245292965
path: Raft-Desktop-1.21.26-x64.zip
sha512: Hq9k==
releaseDate: '2026-10-21T00:03:23.157Z'
minimumSystemVersion: 22.0.0
`;
const HANDS_LINUX_FEED = `version: 1.21.26
files:
  - url: Raft-Desktop-1.21.26-x86_64.AppImage
    sha512: HOnB==
    size: 132890830
    blockMapSize: 139490
  - url: Raft-Desktop-1.21.26-amd64.deb
    sha512: e+qc==
    size: 113002684
path: Raft-Desktop-1.21.26-x86_64.AppImage
sha512: HOnB==
releaseDate: '2026-10-20T23:57:40.471Z'
`;
const HANDS_WINDOWS_FEED = `version: 1.21.26
files:
  - url: Raft-Desktop-1.21.26-x64.exe
    sha512: cHV+==
    size: 145075556
path: Raft-Desktop-1.21.26-x64.exe
sha512: cHV+==
releaseDate: '2026-10-21T00:42:42.516Z'
`;
const HANDS_FEEDS = { "latest-mac.yml": HANDS_MAC_FEED, "latest-linux.yml": HANDS_LINUX_FEED, "latest.yml": HANDS_WINDOWS_FEED };

const BASE = "https://github.com/botiverse/desktop/releases";
const GITHUB: DesktopFeedSource = { layout: "github", base: BASE };
const HANDS: DesktopFeedSource = { layout: "generic", base: HANDS_FEED_BASE };

function feedFetch(feeds: Record<string, string>): { fetch: typeof fetch; requested: string[] } {
  const requested: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const name = url.split("/").pop() ?? "";
    const body = feeds[name];
    return body === undefined
      ? new Response("Not Found", { status: 404 })
      : new Response(body, { status: 200 });
  }) as typeof fetch;
  return { fetch: fake, requested };
}

test("parses the real electron-builder feeds: version plus every listed file", () => {
  assert.deepEqual(parseUpdateFeed(MAC_FEED), {
    version: "0.1.42",
    files: ["Raft-Desktop-0.1.42-x64.zip", "Raft-Desktop-0.1.42-arm64.zip", "Raft-Desktop-0.1.42-x64.dmg", "Raft-Desktop-0.1.42-arm64.dmg"],
  });
  assert.deepEqual(parseUpdateFeed(LINUX_FEED)?.files, ["Raft-Desktop-0.1.42-x86_64.AppImage", "Raft-Desktop-0.1.42-amd64.deb"]);
  // `path:` (the legacy single-file key) is not a list entry and must not be read as one.
  assert.equal(parseUpdateFeed(MAC_FEED)?.files.length, 4);
  assert.equal(parseUpdateFeed("files:\n- url: a.dmg\n"), null, "a feed without a version is no feed");
});

test("the feed source: Hands (flat) by default, GitHub layout only when asked for", () => {
  assert.deepEqual(desktopFeedSourceFromEnv({}), { layout: "generic", base: "https://hands.build/electron/raft-desktop/main" });
  assert.deepEqual(desktopFeedSourceFromEnv({ RAFT_DESKTOP_FEED_BASE_URL: "https://cdn.example/feed" }), { layout: "generic", base: "https://cdn.example/feed" });
  assert.deepEqual(desktopFeedSourceFromEnv({ RAFT_DESKTOP_RELEASES_BASE_URL: BASE, RAFT_DESKTOP_FEED_BASE_URL: "https://cdn.example/feed" }), GITHUB);
  assert.equal(GITHUB_RELEASES_BASE, BASE);
  assert.equal(desktopDownloadFallbackUrl("no_build", GITHUB), `${BASE}/latest`);
  assert.equal(desktopDownloadFallbackUrl("upstream_error", GITHUB), `${BASE}/latest`);
  const githubElsewhere: DesktopFeedSource = { layout: "github", base: "https://github.com/example/mirror/releases/" };
  assert.equal(desktopDownloadFallbackUrl("upstream_error", githubElsewhere), "https://github.com/example/mirror/releases/latest", "the GitHub env base overrides the constant");
  assert.match(desktopDownloadFallbackUrl("no_build", HANDS), /\/download$/, "no build for the platform: the chooser");
  assert.equal(desktopDownloadFallbackUrl("upstream_error", HANDS), "https://github.com/botiverse/desktop/releases/latest", "Hands down: the same builds on GitHub");
});

test("Hands: every target resolves from the flat feed to <base>/<file>, the in-app updater's own source", async () => {
  const { fetch, requested } = feedFetch(HANDS_FEEDS);
  const expect = {
    mac: "Raft-Desktop-1.21.26-universal.dmg",
    "mac-arm64": "Raft-Desktop-1.21.26-universal.dmg",
    "mac-x64": "Raft-Desktop-1.21.26-universal.dmg",
    "linux-appimage": "Raft-Desktop-1.21.26-x86_64.AppImage",
    "linux-deb": "Raft-Desktop-1.21.26-amd64.deb",
    windows: "Raft-Desktop-1.21.26-x64.exe",
  } as const;
  for (const [target, file] of Object.entries(expect)) {
    const result = await lookupDesktopAsset(target as keyof typeof expect, { fetch, source: HANDS });
    assert.deepEqual(result, { outcome: "asset", url: `${HANDS_FEED_BASE}/${file}`, version: "1.21.26" }, target);
  }
  assert.deepEqual(
    [...new Set(requested)].sort(),
    [`${HANDS_FEED_BASE}/latest-linux.yml`, `${HANDS_FEED_BASE}/latest-mac.yml`, `${HANDS_FEED_BASE}/latest.yml`],
    "feeds read at the top of the folder, not under /latest/download/",
  );
  // A trailing slash on the configured base changes nothing.
  const slashed = await lookupDesktopAsset("windows", { fetch, source: { layout: "generic", base: `${HANDS_FEED_BASE}/` } });
  assert.equal(slashed.outcome === "asset" && slashed.url, `${HANDS_FEED_BASE}/Raft-Desktop-1.21.26-x64.exe`);
});

test("Hands: a listed name that is not a bare file name is never redirected to", async () => {
  for (const evil of ["../../other-app/main/Raft-Desktop-9.9.9-x64.exe", "sub/Raft-Desktop-1.0.0-x64.exe", "x?y=Raft-Desktop-1.0.0-x64.exe", "..Raft-Desktop-1.0.0-x64.exe", "a\\b-x64.exe", "a#b-x64.exe"]) {
    const { fetch } = feedFetch({ "latest.yml": `version: 1.0.0\nfiles:\n  - url: ${evil}\n` });
    assert.deepEqual(await lookupDesktopAsset("windows", { fetch, source: HANDS }), { outcome: "no_build" }, evil);
  }
  // A bad entry is skipped, and a plain one after it still wins.
  const { fetch } = feedFetch({ "latest.yml": "version: 1.0.0\nfiles:\n  - url: ../x-x64.exe\n  - url: Raft-Desktop-1.0.0-x64.exe\n" });
  const result = await lookupDesktopAsset("windows", { fetch, source: HANDS });
  assert.equal(result.outcome === "asset" && result.url, `${HANDS_FEED_BASE}/Raft-Desktop-1.0.0-x64.exe`);
  // The version is checked in this layout too.
  const badVersion = feedFetch({ "latest.yml": "version: 1.0.0/../x\nfiles:\n  - url: Raft-Desktop-1.0.0-x64.exe\n" });
  assert.equal((await lookupDesktopAsset("windows", { fetch: badVersion.fetch, source: HANDS })).outcome, "upstream_error");
});

test("Hands: a missing feed (404) is no_build, a failing host an error, and platforms say so", async () => {
  const { fetch } = feedFetch({ "latest-mac.yml": HANDS_MAC_FEED, "latest-linux.yml": HANDS_LINUX_FEED });
  assert.deepEqual(await lookupDesktopAsset("windows", { fetch, source: HANDS }), { outcome: "no_build" });
  assert.deepEqual(await lookupDesktopPlatforms({ fetch, source: HANDS }), {
    mac: { status: "available", version: "1.21.26", universal: true },
    linux: { status: "available", version: "1.21.26" },
    windows: { status: "none" },
  });
  const failing = (async () => new Response("boom", { status: 502 })) as typeof fetch;
  assert.equal((await lookupDesktopAsset("linux-deb", { fetch: failing, source: HANDS })).outcome, "upstream_error");
  assert.deepEqual((await lookupDesktopPlatforms({ fetch: failing, source: HANDS })).windows, { status: "unknown" });
});

test("the version must be plain semver: it becomes a path segment of the redirect", () => {
  assert.equal(parseUpdateFeed("version: ../../../../evil/x/releases/download/v1\nfiles:\n- url: a-arm64.dmg\n"), null);
  assert.equal(parseUpdateFeed("version: 1.2.3?x=1\nfiles:\n"), null);
  assert.equal(parseUpdateFeed("version: 0.1.43-beta.1\nfiles:\n")?.version, "0.1.43-beta.1");
});

test("each target resolves to its installer from the Latest release's own feed", async () => {
  const { fetch, requested } = feedFetch({ "latest-mac.yml": MAC_FEED, "latest-linux.yml": LINUX_FEED });
  const expect = {
    mac: "Raft-Desktop-0.1.42-arm64.dmg",
    "mac-arm64": "Raft-Desktop-0.1.42-arm64.dmg",
    "mac-x64": "Raft-Desktop-0.1.42-x64.dmg",
    "linux-appimage": "Raft-Desktop-0.1.42-x86_64.AppImage",
    "linux-deb": "Raft-Desktop-0.1.42-amd64.deb",
  } as const;
  for (const [target, file] of Object.entries(expect)) {
    const result = await lookupDesktopAsset(target as keyof typeof expect, { fetch, source: GITHUB });
    assert.deepEqual(result, { outcome: "asset", url: `${BASE}/download/v0.1.42/${file}`, version: "0.1.42" }, target);
  }
  // Always the auto-update feed of the Latest release: never a pinned version.
  assert.ok(requested.every((url) => url.startsWith(`${BASE}/latest/download/latest-`)), requested.join("\n"));
});

test("a universal build wins for every Mac target once a release carries one", async () => {
  const feed = MAC_FEED.replace("files:\n", "files:\n- url: Raft-Desktop-0.1.42-universal.dmg\n  size: 1\n");
  const { fetch } = feedFetch({ "latest-mac.yml": feed });
  for (const target of ["mac", "mac-arm64", "mac-x64"] as const) {
    const result = await lookupDesktopAsset(target, { fetch, source: GITHUB });
    assert.equal(result.outcome === "asset" && result.url.endsWith("/Raft-Desktop-0.1.42-universal.dmg"), true, target);
  }
});

test("a platform that has not shipped (no feed) is no_build, not an error", async () => {
  const { fetch } = feedFetch({ "latest-mac.yml": MAC_FEED });
  assert.deepEqual(await lookupDesktopAsset("windows", { fetch, source: GITHUB }), { outcome: "no_build" });
});

test("a feed that lists no installer for the target is no_build, never another file", async () => {
  // e.g. a Mac feed with only the update zips: a .zip is not what a download button promises.
  const zipsOnly = MAC_FEED.replace(/- url: [^\n]*\.dmg\n(  [^\n]*\n)*/g, "");
  assert.equal(parseUpdateFeed(zipsOnly)?.files.some((f) => f.endsWith(".dmg")), false);
  const { fetch } = feedFetch({ "latest-mac.yml": zipsOnly });
  assert.deepEqual(await lookupDesktopAsset("mac", { fetch, source: GITHUB }), { outcome: "no_build" });
});

test("upstream failures are errors, distinct from a missing build", async () => {
  const failing = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  assert.equal((await lookupDesktopAsset("mac", { fetch: failing, source: GITHUB })).outcome, "upstream_error");
  const throwing = (async () => { throw new Error("offline"); }) as typeof fetch;
  assert.equal((await lookupDesktopAsset("mac", { fetch: throwing, source: GITHUB })).outcome, "upstream_error");
});

test("only known targets are accepted", () => {
  assert.equal(isDesktopTarget("mac"), true);
  assert.equal(isDesktopTarget("windows"), true);
  assert.equal(isDesktopTarget("toString"), false, "no prototype keys");
  assert.equal(isDesktopTarget(undefined), false);
});

test("mount: public, and a known target 302s to the installer on Hands by default", async ({ app }) => {
  const originalFetch = globalThis.fetch;
  // The router's feed cache lives for the whole file: the mount tests use the
  // same fixture per feed, and leave latest.yml unread (no Windows build).
  const fake = feedFetch({ "latest-mac.yml": MAC_FEED, "latest-linux.yml": HANDS_LINUX_FEED });
  globalThis.fetch = fake.fetch;
  try {
    const response = await originalFetch(`${app.baseUrl}/api/desktop-download?target=mac-x64`, { redirect: "manual" });
    assert.equal(response.status, 302, "mounted and reachable without a session");
    assert.equal(response.headers.get("location"), `${HANDS_FEED_BASE}/Raft-Desktop-0.1.42-x64.dmg`);
    const deb = await originalFetch(`${app.baseUrl}/api/desktop-download?target=linux-deb`, { redirect: "manual" });
    assert.equal(deb.status, 302);
    assert.equal(deb.headers.get("location"), `${HANDS_FEED_BASE}/Raft-Desktop-1.21.26-amd64.deb`);
    assert.ok(fake.requested.every((url) => url.startsWith(`${HANDS_FEED_BASE}/latest`)), fake.requested.join("\n"));
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("route: no target goes to the chooser; the UA is never used to guess", async ({ app }) => {
  // An iPad sends a Mac UA. Guessing from it would hand an iPad a .dmg.
  const iPadOS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  try {
    const response = await fetch(`${app.baseUrl}/api/desktop-download`, { redirect: "manual", headers: { "user-agent": iPadOS } });
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location") ?? "", /\/download$/);
  } finally {
    await app.close();
  }
});

test("route: no build → the /download chooser; Hands down → the GitHub Latest release; never a dead JSON page", async ({ app }) => {
  const originalFetch = globalThis.fetch;
  const noFile = "version: 1.21.26\nfiles:\n  - url: Raft-Desktop-1.21.26-x64.zip\n";
  const cases: Array<[string, typeof fetch, RegExp | string]> = [
    ["404 feed", feedFetch({}).fetch, /\/download$/],
    ["feed without the installer", feedFetch({ "latest.yml": noFile }).fetch, /\/download$/],
    ["Hands 500", (async () => new Response("boom", { status: 500 })) as typeof fetch, "https://github.com/botiverse/desktop/releases/latest"],
    ["Hands unreachable", (async () => { throw new Error("offline"); }) as typeof fetch, "https://github.com/botiverse/desktop/releases/latest"],
  ];
  try {
    for (const [name, fake, expected] of cases) {
      resetDesktopDownloadCacheForTest();
      globalThis.fetch = fake;
      const response = await originalFetch(`${app.baseUrl}/api/desktop-download?target=windows`, { redirect: "manual" });
      assert.equal(response.status, 302, name);
      const location = response.headers.get("location") ?? "";
      if (typeof expected === "string") assert.equal(location, expected, name);
      else assert.match(location, expected, name);
      assert.equal(response.headers.get("cache-control"), "no-store", name);
    }
  } finally {
    resetDesktopDownloadCacheForTest();
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("platforms: what the Latest release offers, so shipping a platform needs no web edit", async () => {
  const { fetch } = feedFetch({ "latest-mac.yml": MAC_FEED, "latest-linux.yml": LINUX_FEED });
  assert.deepEqual(await lookupDesktopPlatforms({ fetch, source: GITHUB }), {
    mac: { status: "available", version: "0.1.42", universal: false },
    linux: { status: "available", version: "0.1.42" },
    windows: { status: "none" },
  });
  const withWindows = feedFetch({
    "latest-mac.yml": MAC_FEED.replace("files:\n", "files:\n- url: Raft-Desktop-0.1.42-universal.dmg\n"),
    "latest-linux.yml": LINUX_FEED,
    "latest.yml": "version: 0.1.42\nfiles:\n  - url: Raft-Desktop-0.1.42-x64.exe\n    size: 1\n",
  });
  const platforms = await lookupDesktopPlatforms({ fetch: withWindows.fetch, source: GITHUB });
  assert.equal(platforms.mac.universal, true);
  assert.deepEqual(platforms.windows, { status: "available", version: "0.1.42" });
});

test("platforms: GitHub not answering is unknown, not none (the web keeps its defaults)", async () => {
  const failing = (async () => new Response("boom", { status: 503 })) as typeof fetch;
  assert.deepEqual(await lookupDesktopPlatforms({ fetch: failing, source: GITHUB }), {
    mac: { status: "unknown" }, linux: { status: "unknown" }, windows: { status: "unknown" },
  });
});

test("feeds are reused for a minute, failures for ten seconds", async () => {
  const cache = new Map();
  let now = 0;
  const { fetch, requested } = feedFetch({ "latest-mac.yml": MAC_FEED });
  await lookupDesktopAsset("mac", { fetch, source: GITHUB, cache, now: () => now });
  await lookupDesktopAsset("mac-x64", { fetch, source: GITHUB, cache, now: () => now });
  assert.equal(requested.length, 1, "second click within the minute reuses the feed");
  now = 61_000;
  await lookupDesktopAsset("mac", { fetch, source: GITHUB, cache, now: () => now });
  assert.equal(requested.length, 2, "then it is read again");
  let calls = 0;
  const flaky = (async () => { calls += 1; return new Response("boom", { status: 500 }); }) as typeof fetch;
  await lookupDesktopAsset("linux-deb", { fetch: flaky, source: GITHUB, cache, now: () => now });
  await lookupDesktopAsset("linux-deb", { fetch: flaky, source: GITHUB, cache, now: () => now });
  assert.equal(calls, 1, "while GitHub is down, a failure is not re-awaited on every click");
  now += 11_000;
  await lookupDesktopAsset("linux-deb", { fetch: flaky, source: GITHUB, cache, now: () => now });
  assert.equal(calls, 2, "and is retried after ten seconds");
});

test("mount: the platforms endpoint is public JSON", async ({ app }) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = feedFetch({ "latest-mac.yml": MAC_FEED }).fetch;
  try {
    const response = await originalFetch(`${app.baseUrl}/api/desktop-download/platforms`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mac.status, "available");
    assert.equal(body.windows.status, "none");
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});
