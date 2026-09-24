import assert from "node:assert/strict";
import { test } from "node:test";
import { mobileDownloadUrl } from "../src/utils/mobileDownloadUrl";
import { deriveRuntimeEndpoints } from "../src/desktopRuntimeEnvironment";

/**
 * Drives the PRODUCTION function with an injected base — not a lookalike.
 *
 * @Aiden caught the earlier shape: a separate `compose…` helper meant these
 * tests validated a copy, so reverting the production path to a relative string
 * would have left them green. That is the same defect class as a mutation that
 * does not touch what the assertion measures.
 *
 * The bug this file exists for.
 *
 * The links were hardcoded as `/api/mobile-download?platform=…`. That works in
 * local dev, where Vite proxies `/api` on the same origin, and it is broken in
 * every deployed environment, where the API lives on a different host. On
 * staging the browser resolved it against the WEB origin, found no API, fell
 * through to the SPA catch-all and bounced the person back to the settings page
 * they started from. Nothing errored. @wenyi found it by clicking.
 *
 * My own verification missed it because I tested through the preview
 * environment, which proxies `/api` to staging — a surface that HAS the property
 * production lacks, in exactly the dimension under test.
 */

test("a split-origin deployment produces an absolute URL on the API host", () => {
  // The shape every deployed environment actually has.
  const url = mobileDownloadUrl("android", "https://api-aws-staging.botiverse.dev/api");
  assert.equal(url, "https://api-aws-staging.botiverse.dev/api/mobile-download?platform=android");
  assert.ok(url.startsWith("https://api-"), "must address the API host, not the page origin");
});

test("a same-origin dev base stays relative", () => {
  // Local dev serves the API through the Vite proxy on one origin; forcing an
  // absolute URL here would break the case that used to work.
  assert.equal(mobileDownloadUrl("ios", "/api"), "/api/mobile-download?platform=ios");
  assert.equal(mobileDownloadUrl(undefined, "/api"), "/api/mobile-download");
});

test("a trailing slash on the base does not double up", () => {
  assert.equal(
    mobileDownloadUrl("android", "https://api.example.com/api/"),
    "https://api.example.com/api/mobile-download?platform=android",
  );
});

test("the platformless form carries no query, so the QR stays UA-decided", () => {
  const url = mobileDownloadUrl(undefined, "https://api.example.com/api");
  assert.ok(!url.includes("platform="), `QR payload must not pin a platform: ${url}`);
});

/**
 * Pins the assumption the composer rests on: the runtime's API base is NOT the
 * page origin once an api origin is configured. If this ever became same-origin
 * again, the relative form would be harmless — but silently so, and the next
 * person would not know which case they are in.
 */
test("the runtime base is derived from the API origin, not the page origin", () => {
  const endpoints = deriveRuntimeEndpoints(
    null,
    "https://api-aws-staging.botiverse.dev",
    "https://raft-app-staging.botiverse.dev",
    false,
  );
  assert.equal(endpoints.apiBase, "https://api-aws-staging.botiverse.dev/api");
  assert.notEqual(
    endpoints.apiBase,
    "https://raft-app-staging.botiverse.dev/api",
    "the API is not served from the web origin — this is the whole bug",
  );
});
