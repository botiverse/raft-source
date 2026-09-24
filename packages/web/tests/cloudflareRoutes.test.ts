import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

const webRoot = resolve(import.meta.dirname, "..");

type CloudflareRoutes = {
  version: number;
  include: string[];
  exclude: string[];
};

function loadRoutes(): CloudflareRoutes {
  return JSON.parse(readFileSync(resolve(webRoot, "public/_routes.json"), "utf8")) as CloudflareRoutes;
}

describe("Cloudflare Pages route intent", () => {
  test("invokes the Pages worker for built assets, the fail-closed desktop manifest, and the association files", () => {
    const routes = loadRoutes();

    assert.equal(routes.version, 1);
    // `/.well-known/*` added for App Links / Universal Links. It is NOT
    // optional plumbing: Cloudflare Pages drops dot-directories at upload, so
    // without the Worker these paths answer 200 text/html (the SPA shell) —
    // measured on a preview deploy, byte-identical to a nonexistent path. The
    // OS then reads HTML instead of JSON and association silently never
    // verifies. Kept as an exact list so a future addition is a decision.
    assert.deepEqual(routes.include, ["/.well-known/*", "/assets/*", "/desktop-manifest.json"]);
    assert.deepEqual(routes.exclude, []);
  });
});
