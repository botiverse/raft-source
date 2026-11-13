import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiRouteTemplate } from "../src/observability/apiRouteTemplate";
import { API_ROUTE_WORDS } from "../src/observability/apiRouteWords";

// `web.http.client`'s `http.route` keeps only the API's own path words: every
// other segment (an id, a slug, a name) is `:id`, and the query never shows.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const CALL_SITE = /\bapi\.(?:get|post|put|patch|delete|head)\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\(\s*[`"'](\/[^`"']*)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "tests" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("every static word of an api.* call site's path is a route word", () => {
  const missing = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    for (const match of readFileSync(file, "utf8").matchAll(CALL_SITE)) {
      const path = match[1]!.split("?", 1)[0]!.replace(/\$\{[^}]*\}/g, "\u0001");
      for (const segment of path.split("/")) {
        if (/^[a-z][a-z0-9_.-]*$/.test(segment) && !API_ROUTE_WORDS.has(segment)) missing.add(segment);
      }
    }
  }
  assert.deepEqual(
    [...missing].sort(),
    [],
    "add these to src/observability/apiRouteWords.ts, or the route's template shows them as :id",
  );
});

test("ids, slugs, names, queries and fragments never reach the template", () => {
  assert.equal(apiRouteTemplate("/messages/channel/0f4c-11?limit=50&before=12"), "/api/messages/channel/:id");
  assert.equal(apiRouteTemplate("/api/servers/acme-corp/members"), "/api/servers/:id/members");
  assert.equal(apiRouteTemplate("/channels/general#top"), "/api/channels/:id");
  assert.equal(apiRouteTemplate("/auth/me"), "/api/auth/me");
  assert.equal(apiRouteTemplate("/"), ":other");
});
