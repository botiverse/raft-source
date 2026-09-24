import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import tsupConfig from "../tsup.config.js";

type BundleConfigShape = {
  banner?: {
    js?: unknown;
  };
  noExternal?: unknown;
  shims?: unknown;
};

const config = tsupConfig as BundleConfigShape;

test("tsup config inlines runtime deps for the Computer app sidecar CLI", async () => {
  assert.equal(config.shims, true);
  assert.deepEqual(config.noExternal, ["commander", "undici"]);
  assert.match(String(config.banner?.js), /createRequire/);

  const source = await readFile(
    fileURLToPath(new URL("../tsup.config.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /Computer app copies this single file/);
  assert.match(source, /sidecar has no package root/);
  assert.match(source, /commander` is CJS/);
});
