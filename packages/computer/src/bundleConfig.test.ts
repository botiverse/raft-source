import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import tsupConfig from "../tsup.config.js";

type BundleConfigShape = {
  noExternal?: unknown;
  external?: unknown;
  banner?: { js?: unknown };
};

const configs = (Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig]) as BundleConfigShape[];
const config = configs[0];
const libConfig = configs[1];

test("tsup config bundles CLI helper deps but leaves daemon package external to staged hydration", () => {
  assert.ok(config, "tsup config must export an object");
  assert.deepEqual(config.noExternal, [
    "commander",
    "proper-lockfile",
    "undici",
    "@botiverse/raft-shared",
    "@botiverse/raft-trace-client",
    "@botiverse/k-carrier",
  ]);
  assert.equal(config.external, undefined);
  assert.match(String(config.banner?.js ?? ""), /createRequire/);
});

test("tsup lib entry inlines the source-only tracing packages so the /lib bundle self-contains", () => {
  assert.ok(libConfig, "lib entry config must exist");
  assert.deepEqual(libConfig.noExternal, ["@botiverse/raft-shared", "@botiverse/raft-trace-client"]);
});

test("tsup config documents why daemon stays external and source-only dependencies are inlined", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../tsup.config.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /daemon package stays external/);
  assert.match(source, /upgrade flow hydrates it into/);
  assert.match(source, /source-only TS workspace packages/);
  assert.match(source, /ERR_MODULE_NOT_FOUND/);
  assert.match(source, /Native Node refuses to strip types under node_modules/);
  assert.match(source, /ordinary published bin equivalent by inlining K/);
});

test("package build executes the published bin under native Node after writing it", async () => {
  assert.match(packageJson.scripts.build, /write-dist-bins\.mjs && node scripts\/verify-published-dist\.mjs$/);

  const source = await readFile(
    fileURLToPath(new URL("../scripts/verify-published-dist.mjs", import.meta.url)),
    "utf8",
  );
  assert.match(source, /spawnSync\(process\.execPath, \[binPath, "--version"\]/);
  assert.match(source, /result\.stdout\.trim\(\) !== packageJson\.version/);
  assert.match(source, /const env = \{\};/);
  assert.doesNotMatch(source, /\.\.\.process\.env/);
});
