import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { encodeArtifactShortId } from "@botiverse/raft-shared";

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

  test("protects feedback assets from cached HTML fallbacks while caching real files", async () => {
    const real = await runWorker("/feedback/assets/index-current.js", new Response("export const ready = true;", { headers: { "Content-Type": "application/javascript" } }));
    assert.equal(real.status, 200);
    assert.equal(real.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const missing = await runWorker("/feedback/assets/index-missing.js", new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }));
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-store");
    assert.equal(await missing.text(), "");
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

describe("precompressed brotli copies of built JS and CSS", () => {
  const brBytes = new Uint8Array([0x1b, 0x03, 0x00, 0xf8]);

  async function run(path: string, init: RequestInit, assets: (request: Request) => Response) {
    const seen: string[] = [];
    const response = await worker.fetch(new Request(`https://app.raft.build${path}`, init), {
      ASSETS: {
        async fetch(request) {
          seen.push(new URL(request.url).pathname);
          return assets(request);
        },
      },
    });
    return { response, seen };
  }

  const withCopy = (request: Request) => new URL(request.url).pathname.endsWith(".br")
    ? new Response(request.method === "HEAD" ? null : brBytes, { headers: { "Content-Type": "application/octet-stream", ETag: "\"copy\"", "Access-Control-Allow-Origin": "*" } })
    : new Response("export const ready = true;", { headers: { "Content-Type": "application/javascript" } });

  test("a browser that accepts br gets the brotli-11 copy, as br, immutable, with the security headers", async () => {
    const { response, seen } = await run("/assets/app-shell-abcd1234.js", { headers: { "Accept-Encoding": "gzip, deflate, br, zstd" } }, withCopy);
    assert.deepEqual(seen, ["/assets/app-shell-abcd1234.js.br"]);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), "br");
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(response.headers.get("vary"), "Accept-Encoding");
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("etag"), "\"copy\"");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("access-control-allow-origin"), "*", "Pages' CORS header on the file is kept");
    assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), brBytes);

    const css = await run("/feedback/assets/index-abcd1234.css", { headers: { "Accept-Encoding": "br" } }, withCopy);
    assert.equal(css.response.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(css.response.headers.get("content-encoding"), "br");
  });

  test("no br, br;q=0, a Range request, a POST or a non-JS/CSS file: the file itself, as before", async () => {
    for (const [path, init] of [
      ["/assets/app-shell-abcd1234.js", { headers: { "Accept-Encoding": "gzip" } }],
      ["/assets/app-shell-abcd1234.js", { headers: { "Accept-Encoding": "gzip, br;q=0" } }],
      ["/assets/app-shell-abcd1234.js", { headers: { "Accept-Encoding": "br", Range: "bytes=0-10" } }],
      ["/assets/logo-abcd1234.svg", { headers: { "Accept-Encoding": "br" } }],
      ["/index.js", { headers: { "Accept-Encoding": "br" } }],
    ] as const) {
      const { response, seen } = await run(path, init, withCopy);
      assert.deepEqual(seen, [path], `${path} ${JSON.stringify(init)}`);
      assert.equal(response.headers.get("content-encoding"), null);
    }
  });

  test("a file with no copy (the Pages fallback answers HTML) is served itself", async () => {
    const { response, seen } = await run("/assets/old-abcd1234.js", { headers: { "Accept-Encoding": "br" } }, (request) =>
      new URL(request.url).pathname.endsWith(".br")
        ? new Response("<!doctype html>", { headers: { "Content-Type": "text/html; charset=utf-8" } })
        : new Response("export {};", { headers: { "Content-Type": "application/javascript" } }));
    assert.deepEqual(seen, ["/assets/old-abcd1234.js.br", "/assets/old-abcd1234.js"]);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(await response.text(), "export {};");
  });

  test("a revalidation with the copy's ETag gets 304", async () => {
    const { response } = await run("/assets/app-shell-abcd1234.js", { headers: { "Accept-Encoding": "br", "If-None-Match": "W/\"copy\"" } }, withCopy);
    assert.equal(response.status, 304);
    assert.equal(response.headers.get("etag"), "\"copy\"");
    assert.equal(response.body, null);
  });

  test("HEAD asks Pages for the copy's headers only, and gets no body", async () => {
    const methods: string[] = [];
    const { response } = await run("/assets/app-shell-abcd1234.js", { method: "HEAD", headers: { "Accept-Encoding": "br" } }, (request) => {
      methods.push(request.method);
      return withCopy(request);
    });
    assert.deepEqual(methods, ["HEAD"]);
    assert.equal(response.headers.get("content-encoding"), "br");
    assert.equal(response.body, null);
  });
});

describe("an older Artifact link moves to its short id", () => {
  const uuid = "cf5d7bb5-6bbe-4304-bc87-1ab40601a98e";
  const short = "ScAiFjjtiUvoyEYA6Ry12u";
  const neverAssets: AssetBinding = { async fetch() { throw new Error("the app was asked"); } };

  test("GET and HEAD of /artifacts/pt_<uuid>[/v/<n>] get a 301 to /artifacts/<short id>, the query kept", async () => {
    for (const [path, location] of [
      [`/artifacts/pt_${uuid}`, `/artifacts/${short}`],
      [`/artifacts/pt_${uuid}/`, `/artifacts/${short}`],
      [`/artifacts/pt_${uuid}/v/12`, `/artifacts/${short}/v/12`],
      [`/artifacts/pt_${uuid}?embed=1&lang=fr`, `/artifacts/${short}?embed=1&lang=fr`],
    ] as const) {
      for (const method of ["GET", "HEAD"]) {
        const response = await worker.fetch(new Request(`https://app.raft.build${path}`, { method }), { ASSETS: neverAssets });
        assert.equal(response.status, 301, `${method} ${path}`);
        assert.equal(response.headers.get("location"), `https://app.raft.build${location}`, `${method} ${path}`);
        assert.equal(response.headers.get("x-frame-options"), "DENY");
      }
    }
  });

  test("the Worker's encoder is the shared codec's", async () => {
    const { artifactShortId } = await import(workerUrl) as { artifactShortId: (uuid: string) => string };
    for (const value of [uuid, "00000000-0000-0000-0000-000000000000", "000000ff-1234-4abc-8def-0123456789ab", "ffffffff-ffff-ffff-ffff-ffffffffffff", randomUUID(), randomUUID()]) {
      assert.equal(artifactShortId(value), encodeArtifactShortId(value), value);
    }
  });

  test("anything else goes to the app: the short form, a malformed or uppercase id, a fixture's, a file path, a POST", async () => {
    for (const [path, method] of [
      [`/artifacts/${short}`, "GET"],
      [`/artifacts/pt_${uuid.toUpperCase()}`, "GET"],
      [`/artifacts/pt_${uuid.slice(1)}`, "GET"],
      ["/artifacts/pt_fake-roadmap", "GET"],
      [`/artifacts/pt_${uuid}/v/0`, "GET"],
      [`/artifacts/pt_${uuid}/files/index.html`, "GET"],
      [`/s/raft/artifacts/pt_${uuid}`, "GET"],
      [`/artifacts/pt_${uuid}`, "POST"],
    ] as const) {
      let asked = false;
      const response = await worker.fetch(new Request(`https://app.raft.build${path}`, { method }), {
        ASSETS: { async fetch() { asked = true; return new Response("app", { headers: { "Content-Type": "text/html" } }); } },
      });
      assert.equal(asked, true, `${method} ${path}`);
      assert.equal(response.status, 200, `${method} ${path}`);
    }
  });
});
