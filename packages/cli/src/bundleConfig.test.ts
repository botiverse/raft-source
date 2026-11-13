import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import tsdownConfig, { inlinedRuntimeDeps } from "../tsdown.config";

type BundleConfigShape = {
  banner?: {
    js?: unknown;
  };
  deps?: {
    alwaysBundle?: unknown;
  };
  shims?: unknown;
};

const config = tsdownConfig as BundleConfigShape;

test("tsdown config inlines runtime deps for the Computer app sidecar CLI", async () => {
  assert.equal(config.shims, true);
  assert.match(String(config.banner?.js), /createRequire/);

  // The sidecar is a lone file with no node_modules, so EVERY runtime dependency
  // must be inlined: the alwaysBundle source list must equal the package's
  // runtime `dependencies`. A hardcoded list drifts silently — this is the guard
  // that would have caught ajv/safe-regex2 being added without inlining (the
  // 0.1.15 desktop regression).
  const pkg = JSON.parse(
    await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const runtimeDeps = Object.keys(pkg.dependencies ?? {}).sort();
  assert.deepEqual([...inlinedRuntimeDeps].sort(), runtimeDeps);

  // tsdown matches alwaysBundle against the full specifier, so each entry must
  // be a pattern that covers both the bare name and its subpaths.
  const patterns = config.deps?.alwaysBundle as RegExp[];
  assert.equal(patterns.length, runtimeDeps.length);
  for (const dep of runtimeDeps) {
    assert.ok(
      patterns.some((pattern) => pattern.test(dep) && pattern.test(`${dep}/subpath/file.js`)),
      `alwaysBundle must cover ${dep} and its subpaths`,
    );
  }
});
