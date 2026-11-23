import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sanitizeAppLocalReturnPath } from "@botiverse/raft-shared";
import { isAppClaimedPath } from "../src/utils/appClaimedPath";

/**
 * The association files that make "scan → open the app" possible.
 *
 * These are served from `_worker.js`, not from `public/.well-known/`, because
 * Cloudflare Pages drops dot-directories at upload. Measured before writing the
 * code: with the file present in `dist/.well-known/`, the deployed site still
 * answered `200 text/html` — the SPA shell — byte-identical to a nonexistent
 * path. **200, not 404**, so "the URL responds" proves nothing here.
 *
 * These tests therefore assert the WORKER owns the paths and the routing config
 * actually sends them there. A file sitting in `public/` would pass a naive
 * existence check and fail in production, silently.
 *
 * `public/.well-known/` does hold copies of both files, for the S3 + CloudFront
 * build (#164), which serves them from the bucket because it has no Worker.
 * Pages still drops them, so the Worker stays the source on Pages; the last test
 * keeps the copies byte-identical to what the Worker serves.
 */

const routes = JSON.parse(
  readFileSync(fileURLToPath(new URL("../public/_routes.json", import.meta.url)), "utf8"),
);

test("the Worker is routed for /.well-known/*, or it never sees the request", () => {
  // Without this include, Pages serves the path from static assets — where the
  // files do not exist — and the SPA fallback answers instead.
  assert.ok(
    routes.include.includes("/.well-known/*"),
    `_routes.json must route /.well-known/* to the Worker: ${JSON.stringify(routes.include)}`,
  );
});

test("both association paths are answered before static assets are consulted", async () => {
  const { default: handler } = await import("../public/_worker");
  // If ASSETS were reached, we would get the SPA shell — so this stub throws to
  // prove the association paths never fall through.
  const env = {
    ASSETS: {
      fetch: () => {
        throw new Error("association paths must not reach static assets");
      },
    },
  };

  for (const [path, check] of [
    // Whole-body equality, not field spot-checks. An earlier version asserted
    // only that `sha256_cert_fingerprints` had length 2, which cannot tell a
    // correct fingerprint from a corrupted one: @Aiden mutated the last byte of
    // the rotated signer's cert and the suite stayed green. A wrong fingerprint
    // is exactly the failure that matters here — it makes devices on that signer
    // fail verification silently, with no error anywhere — so the assertion has
    // to be as precise as the property. Every byte an OS reads is compared.
    ["/.well-known/assetlinks.json", (body: unknown) => {
      assert.deepEqual(body, [
        {
          relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
          target: {
            namespace: "android_app",
            package_name: "build.raft.app",
            sha256_cert_fingerprints: [
              // Legacy signer, then rotated signer (builds we sign and ship ourselves). A device
              // trusts exactly one of these, so neither may drift or be dropped.
              "B4:91:93:81:D8:F9:CE:DE:4F:8E:B8:F6:D1:32:F6:DF:E0:D6:D1:5B:F6:D1:F6:30:57:D5:EB:A0:45:16:1A:45",
              "5F:08:BB:E8:2A:27:CC:DA:D2:6C:13:52:3A:60:B5:67:0D:3A:A7:63:3E:8E:D2:FD:71:FA:6B:57:51:F9:B0:B1",
              // Play App Signing's key: Google re-signs the Play Store build with it. Without it every
              // App Link of the Play build fails verification (Play Console › Deep links, 1.24.0).
              "D7:70:71:84:A6:BE:7F:0C:EC:D6:2E:3F:F9:E0:89:D4:58:A8:4F:AF:A3:BD:8E:2F:AE:4B:3B:60:D8:C5:6A:D6",
            ],
          },
        },
        {
          // Passkeys only: the alpha build must not take links from the release app.
          relation: ["delegate_permission/common.get_login_creds"],
          target: {
            namespace: "android_app",
            package_name: "build.raft.app.alpha",
            sha256_cert_fingerprints: [
              "B4:91:93:81:D8:F9:CE:DE:4F:8E:B8:F6:D1:32:F6:DF:E0:D6:D1:5B:F6:D1:F6:30:57:D5:EB:A0:45:16:1A:45",
              "5F:08:BB:E8:2A:27:CC:DA:D2:6C:13:52:3A:60:B5:67:0D:3A:A7:63:3E:8E:D2:FD:71:FA:6B:57:51:F9:B0:B1",
            ],
          },
        },
      ]);
    }],
    ["/.well-known/apple-app-site-association", (body: unknown) => {
      // Pin the complete scope: download, channel/DM families, an open Artifact, the external invite and a server join link.
      // A broad catch-all would divert unrelated website URLs to the app.
      assert.deepEqual(body, {
        applinks: {
          details: [
            {
              appIDs: ["XDAPXFY8FZ.build.raft.app"],
              components: [
                { "/": "/download", comment: "mobile download entry only" },
                {
                  "/": "/",
                  "?": { verify: "?*", returnTo: "/login/app?request=*" },
                  percentEncoded: false,
                  comment: "app sign-up email verification link only; iOS resumes the pending app sign-in",
                },
                { "/": "/s/*/channel/", exclude: true, comment: "no channel id" },
                { "/": "/s/*/*/channel/*", exclude: true, comment: "nested route, not a channel permalink" },
                { "/": "/s/*/channel/*/?*", exclude: true, comment: "extra segment after the channel id (iOS matches the path with a trailing slash added)" },
                { "/": "/s/*/dm/", exclude: true, comment: "no dm id" },
                { "/": "/s/*/*/dm/*", exclude: true, comment: "nested route, not a dm permalink" },
                { "/": "/s/*/dm/*/?*", exclude: true, comment: "extra segment after the dm id (iOS matches the path with a trailing slash added)" },
                {
                  "/": "/s/*/channel/*",
                  comment: "channel and reply permalinks; native validates identity and query anchors",
                },
                {
                  "/": "/s/*/dm/*",
                  comment: "direct-message permalinks; native validates identity and query anchors",
                },
                {
                  "/": "/s/*/artifacts",
                  "?": { artifact: "?*" },
                  comment: "an open Artifact's address (?artifact=<id>[&version=<n>]); the app opens it in its viewer",
                },
                { "/": "/artifacts/", exclude: true, comment: "no artifact id" },
                { "/": "/artifacts/*/*/v/*", exclude: true, comment: "extra segment before the version" },
                { "/": "/artifacts/*/v/", exclude: true, comment: "no version number" },
                { "/": "/artifacts/*/v/*/?*", exclude: true, comment: "extra segment after the version (iOS matches the path with a trailing slash added)" },
                { "/": "/artifacts/*/v/*", comment: "an Artifact's share link at a version; the app opens it in its viewer" },
                { "/": "/artifacts/*/?*", exclude: true, comment: "any other extra segment after the artifact id (iOS matches the path with a trailing slash added)" },
                { "/": "/artifacts/*", comment: "an Artifact's share link (raft artifact push, Copy link); the app opens it in its viewer" },
                {
                  "/": "/external-invite/?*",
                  comment: "external channel invite (app 1.24+); the app's invite page reads the rest from the server",
                },
                { "/": "/join/", exclude: true, comment: "no join token" },
                { "/": "/join/*/?*", exclude: true, comment: "extra segment after the join token (iOS matches the path with a trailing slash added)" },
                { "/": "/join/*", comment: "server join link (app 1.25+); the app's join page reads the invite from the server" },
              ],
            },
          ],
        },
        // Passkeys bound to app.raft.build, used natively by the iOS app.
        webcredentials: { apps: ["XDAPXFY8FZ.build.raft.app"] },
      });
    }],
  ] as const) {
    const response = await handler.fetch(new Request(`https://app.raft.build${path}`), env);
    assert.equal(response.status, 200, `${path} must be 200`);
    // The load-bearing assertion: JSON, not the HTML the SPA would have served.
    assert.equal(
      response.headers.get("content-type"),
      "application/json",
      `${path} must be JSON — 200 + text/html is the silent failure mode`,
    );
    assert.equal(response.headers.get("location"), null, `${path} must not redirect`);
    check(await response.json());
  }
});

test("change-password redirects temporarily before static assets are consulted", async () => {
  const { default: handler } = await import("../public/_worker");
  const env = {
    ASSETS: {
      fetch: () => {
        throw new Error("change-password must not reach the SPA assets");
      },
    },
  };

  const response = await handler.fetch(
    new Request("https://app.raft.build/.well-known/change-password"),
    env,
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://app.raft.build/change-password");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "");
});

test("unknown well-known paths are real empty 404s instead of the SPA shell", async () => {
  const { default: handler } = await import("../public/_worker");
  let reachedAssets = 0;
  const env = {
    ASSETS: {
      fetch: () => {
        reachedAssets += 1;
        return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
      },
    },
  };

  for (const path of [
    "/.well-known/resource-that-should-not-exist-whose-status-code-should-not-be-200",
    "/.well-known/acme-challenge/xyz",
    "/.well-known",
  ]) {
    const response = await handler.fetch(new Request(`https://app.raft.build${path}`), env);
    assert.equal(response.status, 404, `${path} must be a real 404`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "");
  }
  assert.equal(reachedAssets, 0, "unknown well-known paths must not reach the SPA fallback");

  // And the two we do own must still not touch assets.
  await handler.fetch(new Request("https://app.raft.build/.well-known/assetlinks.json"), env);
  assert.equal(reachedAssets, 0, "our own paths must not fall through");
});

/**
 * The sign-up email's link, path and query: an exact replica of the server's
 * `verificationEmailUrl` (packages/server/src/services/emailService.ts), minus
 * `appUrl()`. Importing it would pull the email service (Resend, config) into
 * this web test; the next test fails when the server's body changes.
 */
function verificationEmailPath(token: string, returnTo?: unknown): string {
  const params = new URLSearchParams({ verify: token });
  const path = sanitizeAppLocalReturnPath(returnTo);
  if (path !== "/") params.set("returnTo", path);
  return `/?${params.toString()}`;
}

test("verificationEmailPath is the server's verificationEmailUrl", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../server/src/services/emailService.ts", import.meta.url)),
    "utf8",
  );
  const body = /export function verificationEmailUrl\(token: string, returnTo\?: unknown\): string \{\n([\s\S]*?)\n\}/
    .exec(source)?.[1];
  assert.equal(
    body,
    [
      "  const params = new URLSearchParams({ verify: token });",
      "  const path = sanitizeAppLocalReturnPath(returnTo);",
      "  if (path !== \"/\") params.set(\"returnTo\", path);",
      "  return `${appUrl()}?${params.toString()}`;",
    ].join("\n"),
    "the server's verification link changed: update verificationEmailPath (and the AASA returnTo) to match",
  );
});

test("the sign-up link sends returnTo percent-encoded, the form iOS matches against", () => {
  // The AASA's sign-up component sets `percentEncoded: false` for exactly this shape.
  assert.equal(
    verificationEmailPath("t", "/login/app?request=9b2f0c1e-6d0a-4c3b-8f7e-2a1d5c4b3e10"),
    "/?verify=t&returnTo=%2Flogin%2Fapp%3Frequest%3D9b2f0c1e-6d0a-4c3b-8f7e-2a1d5c4b3e10",
  );
});

// This test models the case-sensitive '*' / '?' patterns used above, not
// Apple's device/CDN verification or the native identity/anchor parser.
// https://developer.apple.com/documentation/bundleresources/applinks/details-swift.dictionary/components-swift.dictionary
// '*' matches zero or more characters (including '/'), '?' exactly one. A '?'
// dictionary requires every key it names to be present with a matching value;
// other query items are not constrained. Without '?', the query is not constrained.
// `percentEncoded` (default true) says the patterns are written percent-encoded:
// Apple compares them with the URL as sent, so `returnTo=%2Flogin%2Fapp%3F...`
// does not match `/login/app?...` (measured with `swcutil verify`, botiverse/mobile
// app-link-diagnose, 2026-11-18). Only with `percentEncoded: false` are query
// values decoded before matching. The model reads the raw query and decodes
// only then.
/** Whether iOS hands `path` to the app, by the association the Worker serves (the model described above). */
async function servedAasaMatcher(): Promise<(path: string) => boolean> {
  const { default: handler } = await import("../public/_worker");
  const response = await handler.fetch(
    new Request("https://app.raft.build/.well-known/apple-app-site-association"),
    { ASSETS: { fetch: () => { throw new Error("AASA must bypass assets"); } } },
  );
  const body = await response.json();
  const components = body.applinks.details[0].components as Array<Record<string, unknown>>;
  // iOS (swcd) stores a path pattern that ends in neither `/` nor `*` with a `/` appended, and
  // matches the URL's path with a trailing `/` added (seen on a device's swcutil output and with
  // `swcutil verify`, 2026-11-17): `/s/x/dm/id` is matched as `/s/x/dm/id/`, so an exclude like
  // `/s/*/dm/*/*` caught every DM link. Model both, so the rules below are tested as iOS reads them.
  const iosPathPattern = (pattern: string) => (pattern.endsWith("/") || pattern.endsWith("*") ? pattern : `${pattern}/`);
  const iosPath = (pathname: string) => (pathname.endsWith("/") ? pathname : `${pathname}/`);
  const glob = (pattern: string) => new RegExp(`^${[...pattern].map((char) =>
    char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ).join("")}$`);
  // The first matching component decides; an `exclude` match keeps the URL on web.
  const rules = components.map((component) => {
    const keys = Object.keys(component).sort();
    assert.ok(
      ["/,comment", "/,comment,exclude", "/,?,comment", "/,?,comment,percentEncoded"].includes(keys.join()),
      `unexpected component keys ${keys.join()}`,
    );
    if ("exclude" in component) assert.equal(component.exclude, true);
    if ("percentEncoded" in component) assert.equal(component.percentEncoded, false);
    const query = Object.entries((component["?"] ?? {}) as Record<string, string>);
    return {
      exclude: component.exclude === true,
      decoded: component.percentEncoded === false,
      path: glob(iosPathPattern(component["/"] as string)),
      query: query.map(([name, pattern]) => [name, glob(pattern)] as const),
    };
  });
  return (path: string) => {
    const url = new URL(path, "https://app.raft.build");
    // The query items as sent (still percent-encoded), first occurrence of each name.
    const raw = new Map<string, string>();
    for (const item of url.search.slice(1).split("&")) {
      if (item === "") continue;
      const eq = item.indexOf("=");
      const [name, value] = eq === -1 ? [item, ""] : [item.slice(0, eq), item.slice(eq + 1)];
      if (!raw.has(name)) raw.set(name, value);
    }
    const value = (name: string, decoded: boolean) =>
      decoded ? decodeURIComponent(raw.get(name)!.replace(/\+/g, " ")) : raw.get(name)!;
    const rule = rules.find(({ path: pathRegex, query, decoded }) =>
      pathRegex.test(iosPath(url.pathname)) &&
      query.every(([name, regex]) => raw.has(name) && regex.test(value(name, decoded))));
    return rule !== undefined && !rule.exclude;
  };
}

test("AASA covers conversation and message links without claiming unrelated web routes", async () => {
  const matches = await servedAasaMatcher();
  for (const path of [
    "/download",
    "/download?source=qr",
    "/s/qa-workspace/channel/channel-id",
    "/s/qa-workspace/channel/channel-id?thread=channel-id%3Aparent-id&msg=message-id",
    "/s/other-workspace/dm/dm-id",
    "/s/other-workspace/dm/dm-id?msg=message-id",
    // The sign-up email for a sign-up started in a native sign-in (its returnTo is `/login/app?request=<id>`).
    verificationEmailPath("email-token", "/login/app?request=request-id"),
    verificationEmailPath("email-token", "/login/app?request=9b2f0c1e-6d0a-4c3b-8f7e-2a1d5c4b3e10"),
    // Exactly as the email sends it: a 64-hex token and returnTo percent-encoded by
    // URLSearchParams. iOS matches it only because the component sets `percentEncoded: false`.
    "/?verify=" + "ab".repeat(32) + "&returnTo=%2Flogin%2Fapp%3Frequest%3D9b2f0c1e-6d0a-4c3b-8f7e-2a1d5c4b3e10",
    // Typed or rewritten unencoded, it is the same address after decoding.
    "/?verify=email-token&returnTo=/login/app?request=request-id",
    "/s/qa-workspace/artifacts?artifact=pt_abc",
    "/s/qa-workspace/artifacts?artifact=pt_abc&version=2",
    "/external-invite/invite-token",
    "/join/invite-token",
    // iOS adds a trailing slash before matching, so a trailing slash is the same address to it.
    "/s/qa-workspace/channel/channel-id/",
    "/artifacts/pt_abc", "/artifacts/pt_abc/v/2", "/artifacts/pt_abc?c=1",
  ]) assert.equal(matches(path), true, `must associate ${path}`);
  for (const path of [
    "/", "/join", "/join/", "/join/invite-token/extra", "/download/extra", "/downloads",
    "/login", "/change-password", "/s/qa-workspace", "/s/qa-workspace/members",
    "/s/qa-workspace/settings", "/s/qa-workspace/channels/id",
    "/s/qa-workspace/Channel/id", "/s/qa-workspace/DM/id",
    "/channel/id", "/dm/id", "/other/s/qa-workspace/channel/id",
    "/?next=/s/qa-workspace/channel/id", "/#s/qa-workspace/dm/id",
    // `*` spans `/`, so these reach the include patterns unless excluded first;
    // the native parser accepts only `/s/<slug>/(channel|dm)/<id>`.
    "/s/qa-workspace/channel/", "/s/qa-workspace/dm/",
    "/s/qa-workspace/settings/channel/id", "/s/qa-workspace/settings/dm/id",
    "/s/qa-workspace/channel/id/extra", "/s/qa-workspace/dm/id/extra",
    "/s/a/b/channel/id",
    // Only `/` with a non-empty `verify` value: other pages and the reset link stay on web.
    // A web sign-up's link (no app sign-in to resume) keeps opening in the browser.
    verificationEmailPath("email-token"), verificationEmailPath("email-token", "/"),
    verificationEmailPath("email-token", "/s/qa-workspace"),
    verificationEmailPath("email-token", "/artifacts/pt_abc/v/2?c=1"),
    verificationEmailPath("email-token", "/login/app"),
    verificationEmailPath("email-token", "/login/app?requestId=request-id"),
    verificationEmailPath("email-token", "/login?request=request-id"),
    verificationEmailPath("", "/login/app?request=request-id"),
    // The Artifacts list without an open Artifact stays on web, and so does a share
    // address the app's parser would not read (no id, no version, extra segments).
    "/s/qa-workspace/artifacts", "/s/qa-workspace/artifacts?from=list", "/artifacts", "/artifacts/",
    "/artifacts/pt_abc/v/", "/artifacts/pt_abc/v/2/extra", "/artifacts/pt_abc/extra",
    "/artifacts/pt_abc/extra/v/2", "/x/artifacts/pt_abc",
    "/?verify=", "/?verified=1", "/?reset=reset-token", "/login?verify=email-token",
    "/servers?verify=email-token", "/s/qa-workspace/channel/?verify=email-token",
  ]) assert.equal(matches(path), false, `must stay on web ${path}`);
});

// The web's open-in-app offer on an iPhone (OpenInAppOffer) shows only for an
// address the app opens, by its own rule (utils/appClaimedPath.ts). That rule
// and the served association must say the same, or the offer hands Safari a
// link no app takes and the page answers "not installed". Change one, and
// this fails until the other follows. (The association's two other entries,
// `/download` and the sign-up verification link, are entry points of their
// own, not pages the offer appears on.)
test("the iPhone open-in-app rule agrees with the association the Worker serves", async () => {
  const served = await servedAasaMatcher();
  const samples: Array<[path: string, claimed: boolean]> = [
    ["/s/acme/channel/c1", true],
    ["/s/acme/dm/d1", true],
    ["/s/channel/dm/d1", true],
    ["/s/acme/channel/c1/search", false],
    ["/s/acme/channel/c1/", true],
    ["/s/acme/channel/", false],
    ["/s/acme/dm/d1/extra", false],
    ["/s/acme/settings/channel/c1", false],
    ["/s/acme/tasks", false],
    ["/s/acme", false],
    ["/s/acme/Channel/c1", false],
    // An Artifact's share link, at a version too; nothing else under /artifacts.
    ["/artifacts/x", true],
    ["/artifacts/x?c=1", true],
    ["/artifacts/x/v/2", true],
    ["/artifacts", false],
    ["/artifacts/", false],
    ["/artifacts/x/extra", false],
    ["/artifacts/x/v/", false],
    ["/artifacts/x/v/2/extra", false],
    // The Artifacts page only with an Artifact open on it.
    ["/s/acme/artifacts?artifact=pt_1", true],
    ["/s/acme/artifacts?artifact=pt_1&version=2", true],
    ["/s/acme/artifacts", false],
    ["/s/acme/artifacts?from=list", false],
    ["/external-invite/invite-token", true],
    ["/external-invite", false],
    ["/join/invite-token", true],
    ["/join", false],
    ["/join/", false],
    ["/join/invite-token/extra", false],
    ["/servers", false],
  ];
  for (const [path, claimed] of samples) {
    const { pathname, search } = new URL(path, "https://app.raft.build");
    assert.equal(isAppClaimedPath(pathname, "ios", search), served(path), `the offer's rule and the served association disagree on ${path}`);
    assert.equal(served(path), claimed, `the served association on ${path}`);
  }
  // Android's claim is in the app's manifest, not in assetlinks.json: every `/s/…` path plus Artifact share links, external invites and server join links.
  for (const [path] of samples) {
    const { pathname, search } = new URL(path, "https://app.raft.build");
    const expectedAndroid = pathname.startsWith("/s/")
      || /^\/artifacts\/[^/]+(?:\/v\/[^/]+)?\/?$/.test(pathname)
      || /^\/external-invite\/.+/.test(pathname)
      || /^\/join\/[^/]+\/?$/.test(pathname);
    assert.equal(isAppClaimedPath(pathname, "android", search), expectedAndroid, `android ${path}`);
  }
});

test("the S3 copies in public/.well-known/ are byte-identical to what the Worker serves", async () => {
  // CloudFront serves these files straight from the bucket (#164). An OS reads
  // every byte, so the copy must not drift from the Worker in either direction:
  // regenerate both files from the Worker after changing it.
  const { default: handler } = await import("../public/_worker");
  const env = {
    ASSETS: {
      fetch: () => {
        throw new Error("association paths must not reach static assets");
      },
    },
  };
  for (const path of ["/.well-known/assetlinks.json", "/.well-known/apple-app-site-association"]) {
    const response = await handler.fetch(new Request(`https://app.raft.build${path}`), env);
    const copy = readFileSync(fileURLToPath(new URL(`../public${path}`, import.meta.url)), "utf8");
    assert.equal(copy, await response.text(), `public${path} must equal the Worker's body`);
  }
});
