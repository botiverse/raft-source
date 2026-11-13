import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Directory-wide invariant, not a handwritten list: a NEW route file with a
// bare pipe must fail this test without anyone remembering to register it.
// externalAvatars.ts (added by #7406 while #7249 was in review) escaped the
// list-scoped predecessor of this test exactly that way — task #367.
test("no route file contains a bare pipe into an HTTP response", () => {
  const routesDir = new URL("./", import.meta.url);
  const routeFiles = readdirSync(routesDir)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."));
  assert.ok(routeFiles.length > 0, "route directory enumeration must not come back empty");
  for (const file of routeFiles) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /\.pipe\(\s*(res|response|reply)\b/,
      `${file} must join the abort-safe storage response pipeline instead of a bare .pipe()`,
    );
  }
});
