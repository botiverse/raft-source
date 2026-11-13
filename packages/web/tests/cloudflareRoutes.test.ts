import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  test("invokes the Pages worker for built assets, the fail-closed desktop manifest, the association files, Artifact pages and the sitemap", () => {
    const routes = loadRoutes();

    assert.equal(routes.version, 1);
    // `/.well-known/*` added for App Links / Universal Links. It is NOT
    // optional plumbing: Cloudflare Pages drops dot-directories at upload, so
    // without the Worker these paths answer 200 text/html (the SPA shell) —
    // measured on a preview deploy, byte-identical to a nonexistent path. The
    // OS then reads HTML instead of JSON and association silently never
    // verifies. Kept as an exact list so a future addition is a decision.
    // `/artifacts/*`: public Artifact pages get their preview head (title,
    // Open Graph, noindex) from the API's public meta. `/sitemap.xml`: a real
    // 404 instead of the SPA shell. `/llms.txt` and `/robots.txt` are static
    // files, which Pages serves ahead of the SPA fallback without the Worker.
    assert.deepEqual(routes.include, ["/.well-known/*", "/assets/*", "/feedback/assets/*", "/desktop-manifest.json", "/artifacts/*", "/sitemap.xml"]);
    assert.deepEqual(routes.exclude, []);
  });
});
