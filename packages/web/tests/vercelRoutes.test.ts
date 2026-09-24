import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

const webRoot = resolve(import.meta.dirname, "..");

type VercelRoute = {
  handle?: string;
  src?: string;
  status?: number;
  dest?: string;
  headers?: Record<string, string>;
  continue?: boolean;
};

type RouteOutcome =
  | { type: "filesystem" }
  | { type: "status"; status: number }
  | { type: "dest"; dest: string }
  | { type: "none" };

function loadRoutes(): VercelRoute[] {
  const config = JSON.parse(readFileSync(resolve(webRoot, "vercel.json"), "utf8")) as { routes?: VercelRoute[] };
  assert.ok(Array.isArray(config.routes), "web vercel.json should use ordered routes");
  return config.routes;
}

function matchVercelRoutes(routes: VercelRoute[], pathname: string): RouteOutcome {
  for (const route of routes) {
    if (route.handle === "filesystem") return { type: "filesystem" };
    if (!route.src) continue;
    const pattern = new RegExp(`^${route.src}$`);
    if (!pattern.test(pathname)) continue;
    if (typeof route.status === "number") return { type: "status", status: route.status };
    if (typeof route.dest === "string") return { type: "dest", dest: route.dest };
  }
  return { type: "none" };
}

describe("Vercel SPA routes", () => {
  test("applies security headers before filesystem, errors and SPA fallback", () => {
    const routes = loadRoutes();
    const first = routes[0];
    assert.equal(first.continue, true);
    assert.equal(first.dest, undefined);
    assert.equal(first.status, undefined);
    for (const pathname of ["/", "/channels/general", "/assets/index.js", "/assets/missing.js"]) {
      assert.match(pathname, new RegExp(`^${first.src}$`));
    }
    assert.equal(first.headers?.["X-Frame-Options"], "DENY");
    assert.equal(first.headers?.["Referrer-Policy"], "no-referrer");
    assert.equal(first.headers?.["X-Content-Type-Options"], "nosniff");
    const csp = first.headers?.["Content-Security-Policy"] ?? "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /'unsafe-inline'/);
  });
  test("serves existing filesystem assets before custom routing", () => {
    const routes = loadRoutes();

    assert.deepEqual(routes.find((route) => !route.continue), { handle: "filesystem" });
  });

  test("returns 404 for missing built asset URLs before the SPA fallback", () => {
    const routes = loadRoutes();
    const withoutFilesystem = routes.filter((route) => route.handle !== "filesystem");

    assert.deepEqual(matchVercelRoutes(withoutFilesystem, "/assets/index-missing.js"), { type: "status", status: 404 });
    assert.deepEqual(matchVercelRoutes(withoutFilesystem, "/assets/chunks/MachineDetailPanel-missing.js"), {
      type: "status",
      status: 404,
    });
  });

  test("keeps normal application deep links on the SPA fallback", () => {
    const routes = loadRoutes();
    const withoutFilesystem = routes.filter((route) => route.handle !== "filesystem");

    assert.deepEqual(matchVercelRoutes(withoutFilesystem, "/"), { type: "dest", dest: "/index.html" });
    assert.deepEqual(matchVercelRoutes(withoutFilesystem, "/channels/general"), { type: "dest", dest: "/index.html" });
  });
});
