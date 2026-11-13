import assert from "node:assert/strict";

import tsdownConfig, { binBundledDeps, libBundledDeps } from "../tsdown.config";

type BundleConfigShape = {
  deps?: {
    alwaysBundle?: unknown;
    neverBundle?: unknown;
  };
  banner?: { js?: unknown };
};

const configs = (Array.isArray(tsdownConfig) ? tsdownConfig : [tsdownConfig]) as BundleConfigShape[];
const config = configs[0];
const libConfig = configs[1];

// tsdown matches alwaysBundle against the full specifier, so the config
// converts each package name to a subpath-covering regex. Assert the source
// name lists (the contract) plus that every pattern covers subpaths.
function assertPatternsCover(names: string[], patterns: RegExp[]) {
  assert.equal(patterns.length, names.length);
  for (const name of names) {
    assert.ok(
      patterns.some((pattern) => pattern.test(name) && pattern.test(`${name}/subpath`)),
      `alwaysBundle must cover ${name} and its subpaths`,
    );
  }
}

test("tsdown config bundles CLI helper deps but leaves daemon package external to staged hydration", () => {
  assert.ok(config, "tsdown config must export an object");
  assert.deepEqual(binBundledDeps, [
    "commander",
    "proper-lockfile",
    "undici",
    "@botiverse/raft-shared",
    "@botiverse/raft-trace-client",
  ]);
  assertPatternsCover(binBundledDeps, config.deps?.alwaysBundle as RegExp[]);
  assert.equal(config.deps?.neverBundle, undefined);
  assert.match(String(config.banner?.js ?? ""), /createRequire/);
});

test("tsdown lib entry inlines the source-only tracing packages so the /lib bundle self-contains", () => {
  assert.ok(libConfig, "lib entry config must exist");
  assert.deepEqual(libBundledDeps, ["@botiverse/raft-shared", "@botiverse/raft-trace-client"]);
  assertPatternsCover(libBundledDeps, libConfig.deps?.alwaysBundle as RegExp[]);
});
