import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "node:test";

type AssetBinding = {
  fetch(request: Request): Promise<Response>;
};

type AssetWorker = {
  fetch(request: Request, env: { ASSETS: AssetBinding }): Promise<Response>;
};

const workerUrl = pathToFileURL(resolve(import.meta.dirname, "../public/_worker.js")).href;
const { default: worker } = await import(workerUrl) as { default: AssetWorker };

async function runWorker(requestPath: string, assetResponse: Response): Promise<Response> {
  let seenRequest: Request | undefined;
  const response = await worker.fetch(new Request(`https://app.raft.build${requestPath}`), {
    ASSETS: {
      async fetch(request) {
        seenRequest = request;
        return assetResponse;
      },
    },
  });

  assert.equal(seenRequest?.url, `https://app.raft.build${requestPath}`);
  return response;
}

describe("Cloudflare Pages built-asset worker", () => {
  test("makes existing JavaScript and CSS asset responses immutable", async () => {
    const immutable = "public, max-age=31536000, immutable";
    const assetResponse = new Response("export const ready = true;", {
      headers: {
        "Content-Type": "application/javascript",
        "Cache-Control": "no-cache",
      },
    });

    const response = await runWorker("/assets/index-current.js", assetResponse);

    assert.notEqual(response, assetResponse);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/javascript");
    assert.equal(response.headers.get("cache-control"), immutable);
    assert.equal(await response.text(), "export const ready = true;");

    const stylesheet = await runWorker("/assets/index-current.css", new Response("body {}", {
      headers: {
        "Content-Type": "text/css",
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    }));
    assert.equal(stylesheet.status, 200);
    assert.equal(stylesheet.headers.get("content-type"), "text/css");
    assert.equal(stylesheet.headers.get("cache-control"), immutable);
    assert.equal(await stylesheet.text(), "body {}");
  });

  test("turns Pages SPA HTML fallback into an empty non-cacheable 404", async () => {
    const response = await runWorker("/assets/index-stale.js", new Response("<!doctype html><title>Raft</title>", {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    }));

    assert.equal(response.status, 404);
    assert.equal(response.statusText, "Not Found");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-type"), null);
    assert.equal(await response.text(), "");
  });

  test("normalizes a static asset 404 without rewriting unrelated responses", async () => {
    const missing = await runWorker("/assets/missing.css", new Response("not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    }));
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-store");
    assert.equal(await missing.text(), "");

    const spaResponse = new Response("<!doctype html><title>Raft</title>", {
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "no-cache",
      },
    });
    const deepLink = await runWorker("/s/demo/channel/general", spaResponse);
    assert.equal(await deepLink.clone().text(), "<!doctype html><title>Raft</title>");
    assert.equal(deepLink.status, 200);
    assert.equal(deepLink.headers.get("cache-control"), "no-cache");
  });

  test("turns desktop manifest SPA HTML fallback into a JSON fail-closed 404", async () => {
    const response = await runWorker(
      "/desktop-manifest.json",
      new Response("<!doctype html><title>Raft</title>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await response.json(), { error: "desktop_manifest_unavailable" });
  });

  test("fails closed on invalid JSON even when the upstream content type says JSON", async () => {
    const response = await runWorker(
      "/desktop-manifest.json",
      new Response("not json", { headers: { "Content-Type": "application/json" } }),
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "desktop_manifest_unavailable" });
  });

  test("rejects a desktop manifest above the explicit 65536-byte transport bound", async () => {
    const oversized = JSON.stringify({
      manifestVersion: 1,
      padding: "x".repeat(65_536),
    });
    const response = await runWorker(
      "/desktop-manifest.json",
      new Response(oversized, {
        headers: { "Content-Type": "application/json" },
      }),
    );

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: "desktop_manifest_unavailable",
    });
  });

  test("serves valid manifest bytes with revalidation, nosniff, and a strong content ETag", async () => {
    const body = '{"manifestVersion":1,"frontendReleaseId":"release-abc","commitSha":"abc"}\n';
    const response = await runWorker(
      "/desktop-manifest.json",
      new Response(body, {
        headers: {
          "Content-Type": "application/json",
          ETag: 'W/"upstream-weak"',
        },
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-cache, must-revalidate");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const expectedEtag =
      `"sha256-${createHash("sha256").update(body).digest("hex")}"`;
    assert.equal(response.headers.get("etag"), expectedEtag);
    assert.equal(await response.text(), body);
  });
});

test("Worker emits security headers on documents, assets, redirects and missing resources", async () => {
  for (const pathname of ["/s/demo/channel/general", "/assets/current.js", "/.well-known/change-password", "/.well-known/absent"]) {
    const response = await worker.fetch(new Request(`https://app.raft.build${pathname}`), {
      ASSETS: { async fetch() { return new Response("fixture", { headers: { "Content-Type": "text/html" } }); } },
    });
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.doesNotMatch(response.headers.get("content-security-policy") ?? "", /'unsafe-inline'/);
  }
});
