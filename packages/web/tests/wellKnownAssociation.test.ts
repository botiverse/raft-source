import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  const { default: handler } = await import("../public/_worker.js");
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
          relation: ["delegate_permission/common.handle_all_urls"],
          target: {
            namespace: "android_app",
            package_name: "build.raft.app",
            sha256_cert_fingerprints: [
              // Legacy signer, then rotated signer. A device trusts exactly one
              // of these, so neither may drift or be dropped.
              "B4:91:93:81:D8:F9:CE:DE:4F:8E:B8:F6:D1:32:F6:DF:E0:D6:D1:5B:F6:D1:F6:30:57:D5:EB:A0:45:16:1A:45",
              "5F:08:BB:E8:2A:27:CC:DA:D2:6C:13:52:3A:60:B5:67:0D:3A:A7:63:3E:8E:D2:FD:71:FA:6B:57:51:F9:B0:B1",
            ],
          },
        },
      ]);
    }],
    ["/.well-known/apple-app-site-association", (body: unknown) => {
      // Scope is exactly /download — claiming more would change behaviour for
      // every other Raft URL on a device that has the app installed, so the
      // components array is pinned whole rather than by its "/" key alone.
      assert.deepEqual(body, {
        applinks: {
          details: [
            {
              appIDs: ["XDAPXFY8FZ.build.raft.app"],
              components: [{ "/": "/download", comment: "mobile download entry only" }],
            },
          ],
        },
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
    check(await response.json());
  }
});

test("change-password redirects temporarily before static assets are consulted", async () => {
  const { default: handler } = await import("../public/_worker.js");
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
  const { default: handler } = await import("../public/_worker.js");
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
