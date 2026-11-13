import assert from "node:assert/strict";
import { createApiTest } from "../test/integration/apiTest";
import { routeAuthPolicy } from "../middleware/routeAuthPolicy";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// Regression guard: Express matches routes case-insensitively, so
// `/INTERNAL/COMPUTER/preflight` reaches the `/internal/computer` router.
// `authFromRegistry` used to compare the claimed prefix case-sensitively,
// treat such a path as "not claimed" and call next() without authenticating,
// so every registry-owned handler was reachable with no credential at all.
// A re-cased path must be authenticated exactly like the canonical one.

const VARIANTS: ReadonlyArray<[string, (path: string) => string]> = [
  ["upper", (p) => p.toUpperCase()],
  ["title", (p) => p.split("/").map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s)).join("/")],
  ["prefix-only", (p) => p.replace(/^\/internal/, "/INTERNAL")],
  ["surface-only", (p) => p.replace(/^\/internal\/(computer|agent-api)/, (_m, s: string) => `/internal/${s.toUpperCase()}`)],
];

// A well-formed UUID, so routes guarded by guardUuidPathParams reach the
// handler (a malformed id would stop at the uniform 404 and hide a bypass).
function concretePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000000");
}

test("every registry route refuses a re-cased path without a credential (401)", async ({ app }) => {
  const failures: string[] = [];
  for (const entry of routeAuthPolicy) {
    const method = entry.method === "*" ? "GET" : entry.method;
    for (const [name, recase] of VARIANTS) {
      const path = recase(concretePath(entry.path));
      const res = await fetch(`${app.baseUrl}${path}`, {
        method,
        headers: method === "GET" || method === "DELETE" ? {} : { "Content-Type": "application/json" },
        body: method === "GET" || method === "DELETE" ? undefined : "{}",
      });
      await res.arrayBuffer();
      if (res.status !== 401) failures.push(`${method} ${path} (${name}) → ${res.status}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("re-cased unregistered sibling under a claimed prefix still fails closed", async ({ app }) => {
  for (const path of ["/INTERNAL/COMPUTER/preflight-not-registered", "/internal/Agent-Api/not-registered"]) {
    const res = await fetch(`${app.baseUrl}${path}`, { method: "GET" });
    assert.equal(res.status, 401, path);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "auth_policy_unregistered_path", path);
  }
});
