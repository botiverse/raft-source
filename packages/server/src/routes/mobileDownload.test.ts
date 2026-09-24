import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

import {
  classifyHands404,
  mobileDownloadChooserUrl,
  isMobilePlatform,
  lookupLatestAsset,
  platformFromUserAgent,
} from "./mobileDownload.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

test("a modern iPad is unclassifiable by UA, which is why the chooser exists", () => {
  // The real iPadOS 13+ Safari string is byte-identical to macOS, so this
  // function cannot identify an iPad and must not pretend to. It used to end
  // there, with the route answering 400 — an error page for a supported device.
  // iPad is now handled one layer up: null routes to the client-side chooser,
  // where `navigator.maxTouchPoints` can tell iPadOS from a Mac.
  const iPadOS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  assert.equal(platformFromUserAgent(iPadOS), null, "modern iPad is indistinguishable from a Mac here");
  // Legacy iPads still self-identify and do resolve.
  assert.equal(platformFromUserAgent("Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) Safari/604"), "ios");
});

test("device family comes from the UA, never from viewport width", () => {
  assert.equal(platformFromUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120"), "android");
  assert.equal(platformFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604"), "ios");
  // A desktop browser narrowed to phone width is still a desktop: it must reach
  // the chooser rather than be handed an artifact it cannot install.
  assert.equal(platformFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/120"), null);
  assert.equal(platformFromUserAgent(undefined), null);
});

test("an explicit platform query overrides UA sniffing", () => {
  // The desktop surface offers both buttons; a person on a Mac choosing
  // "Android" must get the APK, not be re-classified by their UA.
  assert.equal(isMobilePlatform("android"), true);
  assert.equal(isMobilePlatform("windows"), false);
});

test("a draft-only channel reads as empty, not as a fault", async () => {
  const fetchStub = async () =>
    jsonResponse(404, { error: "no active release for this client on channel 'main'", code: "no_active_release" });
  const result = await lookupLatestAsset("android", { fetch: fetchStub as unknown as typeof fetch });
  assert.deepEqual(result, { outcome: "no_active_release" });
});

test("a mistyped slug is a fault, not an empty channel", async () => {
  // The failure directions differ: reporting real misconfiguration as "no build
  // yet" hides it, and reporting a legitimately empty channel as broken trains
  // people to ignore the red.
  const fetchStub = async () => jsonResponse(404, { error: "app 'raft-androdi' not found", code: "app_not_found" });
  const result = await lookupLatestAsset("android", { fetch: fetchStub as unknown as typeof fetch });
  assert.equal(result.outcome, "not_configured");
});

test("a resolved release yields the signed URL from the response", async () => {
  const fetchStub = async () =>
    jsonResponse(200, {
      build: { version: "1.4.2" },
      expires_in: 3600,
      assets: [
        { platform: "ios", download_url: "https://r2.example/ios.ipa" },
        { platform: "android", download_url: "https://r2.example/app.apk" },
      ],
    });
  const result = await lookupLatestAsset("android", { fetch: fetchStub as unknown as typeof fetch });
  assert.deepEqual(result, {
    outcome: "asset",
    downloadUrl: "https://r2.example/app.apk",
    version: "1.4.2",
    expiresIn: 3600,
  });
});

test("an active release lacking this platform is a fault, not an empty channel", async () => {
  // 200 guarantees non-empty `assets`, so a missing platform match means the
  // release genuinely ships nothing for it — a gap someone must fix.
  const fetchStub = async () =>
    jsonResponse(200, {
      build: { version: "1.4.2" },
      assets: [{ platform: "ios", download_url: "https://r2.example/ios.ipa" }],
    });
  const result = await lookupLatestAsset("android", { fetch: fetchStub as unknown as typeof fetch });
  assert.equal(result.outcome, "not_configured");
});

test("upstream failures never fall through to a redirect", async () => {
  const thrown = async () => { throw new Error("ECONNRESET"); };
  assert.equal(
    (await lookupLatestAsset("android", { fetch: thrown as unknown as typeof fetch })).outcome,
    "upstream_error",
  );
  const serverError = async () => jsonResponse(500, {});
  assert.equal(
    (await lookupLatestAsset("android", { fetch: serverError as unknown as typeof fetch })).outcome,
    "upstream_error",
  );
});

test("classification branches on `code`, not on the human-readable prose", () => {
  // All three observed live on hands.build production 2026-08-10 (not staging,
  // not the post-merge `main`), each by its own request:
  //
  //   app_not_found      ?slug=raft-nonexistent-slug-probe
  //   channel_not_found  raft-ios ?channel=beta
  //   no_active_release  raft-android ?channel=debug   (also nightly, preview)
  //
  // The third is the load-bearing one — it is the only code whose
  // classification changes what the user sees (404 "no build yet" vs 502
  // "unavailable"). It initially read as unverifiable, because every empty case
  // I could construct from outside hits `channel_not_found` first: a caller
  // cannot create an app whose channel exists but holds no active release.
  // @Hands-Rhea pointed out production already carries three such channels
  // standing. Re-pulled all three directly rather than adopting the receipt.
  assert.equal(classifyHands404({ error: "anything", code: "no_active_release" }), "no_active_release");
  assert.equal(classifyHands404({ error: "anything", code: "app_not_found" }), "not_configured");
  assert.equal(classifyHands404({ error: "anything", code: "channel_not_found" }), "not_configured");

  // The prose is explicitly documented as human-facing and rewordable, so it
  // must NOT steer the branch: a body whose wording says "no active release"
  // but whose code says otherwise follows the code.
  assert.equal(
    classifyHands404({ error: "no active release for this client", code: "app_not_found" }),
    "not_configured",
    "prose must not override code",
  );

  // Absence of `code` is not a signal — Hands documents codes as existing only
  // where enumerated. Fall to the surfacing direction rather than hiding it.
  assert.equal(classifyHands404({ error: "no active release" }), "not_configured");
  assert.equal(classifyHands404(null), "not_configured");
});

/**
 * Entry-level tests: these drive the real Express router, not `lookupLatestAsset`.
 *
 * @Gogo's review of Hands #437 caught a test that hand-rolled a context and
 * called the handler directly — it proved the handler produced a code, not that
 * a user received one after routing. The same objection applied to every test
 * above: they assert what a function returns, while the consumer contract is
 * the HTTP response. Same shape he and @cross found in two other places that
 * day — the tooth covering a layer below where production actually executes.
 *
 * These pin the response itself: status, `Location`, and that an empty channel
 * is a 404 rather than a 502.
 */
import express from "express";


async function callRoute(
  query: string,
  headers: Record<string, string>,
  upstream: () => Response,
): Promise<{ status: number; location?: string; body?: unknown }> {
  const app = express();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => upstream()) as typeof fetch;
  try {
    const { mobileDownloadRouter: router } = await import("./mobileDownload.js");
    app.use("/api/mobile-download", router);
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await originalFetch(`http://127.0.0.1:${port}/api/mobile-download${query}`, {
      headers,
      redirect: "manual",
    });
    const location = response.headers.get("location") ?? undefined;
    const body = response.status >= 400 ? await response.json().catch(() => undefined) : undefined;
    server.close();
    return { status: response.status, location, body };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("route: a resolved build 302s to the signed URL", async () => {
  const result = await callRoute("?platform=android", {}, () =>
    jsonResponse(200, {
      build: { version: "1.9.1" },
      expires_in: 3600,
      assets: [{ platform: "android", download_url: "https://r2.example/app.apk" }],
    }));
  assert.equal(result.status, 302);
  assert.equal(result.location, "https://r2.example/app.apk");
});

test("route: an empty channel is 404, not 502", async () => {
  // The distinction a user feels: "no build yet" versus "something is broken".
  const result = await callRoute("?platform=android", {}, () =>
    jsonResponse(404, { error: "no active release", code: "no_active_release" }));
  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { error: "No build available yet", code: "no_active_release" });
});

test("route: a misconfigured slug is 502, so it cannot hide as an empty channel", async () => {
  const result = await callRoute("?platform=android", {}, () =>
    jsonResponse(404, { error: "app 'typo' not found", code: "app_not_found" }));
  assert.equal(result.status, 502);
});

test("route: a phone with no explicit platform is served from its UA", async () => {
  const result = await callRoute("", { "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8)" }, () =>
    jsonResponse(200, {
      build: { version: "1.9.1" },
      assets: [{ platform: "android", download_url: "https://r2.example/app.apk" }],
    }));
  assert.equal(result.status, 302);
  assert.equal(result.location, "https://r2.example/app.apk");
});

test("route: an unclassifiable device gets the chooser, never a wrong artifact", async () => {
  // Was a 400. That refused the iPad case: modern iPadOS Safari sends a
  // Mac-identical UA, so an iPad scanning our QR — the journey this entry point
  // exists for — hit an error page. iPad is a supported target (@huxijin), so
  // the server hands off to a surface where the person picks.
  //
  // Still "never a wrong artifact": the response is a choice, not a download.
  const result = await callRoute("", { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" }, () =>
    jsonResponse(200, { build: {}, assets: [] }));
  assert.equal(result.status, 302);
  assert.equal(result.location, mobileDownloadChooserUrl());
  // Absolute, on the WEB origin — a bare path resolves against this API host,
  // which serves no app. That is exactly what bounced @wenyi back to Settings.
});

test("the chooser redirect is absolute, because the API is not on the web origin", () => {
  // A bare `/download` resolves against THIS server's host in every deployed
  // environment, which serves no web app — the browser lands on nothing. The
  // mirror of the web side linking to a relative `/api/...`; both halves assumed
  // a shared origin that only local dev provides. Found on staging by @wenyi.
  assert.equal(
    mobileDownloadChooserUrl("https://raft-app-staging.botiverse.dev"),
    "https://raft-app-staging.botiverse.dev/download",
  );
  // Trailing slash must not double up.
  assert.equal(
    mobileDownloadChooserUrl("https://raft-app-staging.botiverse.dev/"),
    "https://raft-app-staging.botiverse.dev/download",
  );
  // The dev fallback stays usable.
  assert.equal(mobileDownloadChooserUrl("http://localhost:5173"), "http://localhost:5173/download");
});

test("route: a modern iPad reaches the chooser rather than an error", async () => {
  // The exact iPadOS 13+ Safari string, which is byte-identical to macOS.
  const iPadOS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  const result = await callRoute("", { "user-agent": iPadOS }, () =>
    jsonResponse(200, { build: {}, assets: [] }));
  assert.equal(result.status, 302, "an iPad must not be told it is unsupported");
  assert.equal(result.location, mobileDownloadChooserUrl());
});

test("route: the chooser hand-off never overrides a device we DO recognise", async () => {
  // Regression guard for the fix itself: sending everything to the chooser
  // would be a simpler route and a worse product — a phone that scanned the QR
  // would get a menu instead of its download.
  const android = await callRoute("", { "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8)" }, () =>
    jsonResponse(200, {
      build: { version: "1.9.1" },
      assets: [{ platform: "android", download_url: "https://r2.example/app.apk" }],
    }));
  assert.equal(android.location, "https://r2.example/app.apk");

  const iphone = await callRoute("", { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604" }, () =>
    jsonResponse(200, { build: {}, assets: [] }));
  assert.ok(
    iphone.location?.startsWith("https://testflight.apple.com/"),
    `an iPhone must still go straight to TestFlight, got ${iphone.location}`,
  );
});

/**
 * The mount itself.
 *
 * Every test above (and `callRoute`) builds its own Express app and calls
 * `app.use("/api/mobile-download", router)` by hand. That proves the router
 * behaves — it proves nothing about whether production serves it. @Aiden showed
 * the gap by deleting the real `app.use(...)` line in `app.ts`: all 14 tests
 * stayed green while every user-facing entry point 404ed. The teeth were one
 * layer below where production executes, which is the same shape I have now
 * seen four times this week in other people's work and did not spot in my own.
 *
 * This one boots the real `createApp` through the shared harness, so removing
 * or misspelling the mount fails here.
 */
test("mount: the production app actually serves /api/mobile-download", async ({ app }) => {

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      build: { version: "1.9.1" },
      expires_in: 3600,
      assets: [{ platform: "android", download_url: "https://r2.example/app.apk" }],
    })) as typeof fetch;
  try {
    const response = await originalFetch(`${app.baseUrl}/api/mobile-download?platform=android`, {
      redirect: "manual",
    });
    // An unmounted path in Express returns 404 with an HTML "Cannot GET" body —
    // exactly what @huxijin hit on the preview, where the branch server is
    // absent. Asserting the redirect (not merely "not 404") also pins that the
    // request reached THIS router rather than some other 302.
    assert.equal(response.status, 302, "the route must be mounted on the production app");
    assert.equal(response.headers.get("location"), "https://r2.example/app.apk");
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("mount: the entry point is reachable without a session", async ({ app }) => {
  // A QR-scanning phone has no cookie or token. If the mount ever moves behind
  // auth, this fails instead of shipping a login wall to everyone who scans.

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(404, { error: "empty", code: "no_active_release" })) as typeof fetch;
  try {
    const response = await originalFetch(`${app.baseUrl}/api/mobile-download?platform=android`, {
      redirect: "manual",
    });
    // 404 from OUR handler (a legal empty channel), not 401/403 from a guard.
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "No build available yet", code: "no_active_release" });
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("route: iOS goes to TestFlight, never to the Hands .ipa", async () => {
  // Hands does hold a raft-ios release, but its asset is an .ipa and stock iOS
  // cannot install one. Redirecting there would be a download that silently
  // does nothing — the exact failure this route exists to prevent. If this ever
  // starts pointing at hands.build, an iPhone user gets a dead file.
  const result = await callRoute("?platform=ios", {}, () =>
    jsonResponse(200, {
      build: { version: "1.0.0" },
      assets: [{ platform: "ios", download_url: "https://r2.example/app.ipa" }],
    }));
  assert.equal(result.status, 302);
  assert.ok(
    result.location?.startsWith("https://testflight.apple.com/"),
    `iOS must land on TestFlight, got ${result.location}`,
  );
  assert.ok(!result.location?.includes("hands.build"), "iOS must not be sent to a Hands artifact");
});
