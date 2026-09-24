import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("published raft package declares the supported Node engine floor", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    engines?: { node?: string };
  };

  assert.equal(pkg.engines?.node, ">=20");
});

test("dist package writer emits package metadata and executable wrappers with runtime preflight", () => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL("../scripts/write-dist-package.mjs", import.meta.url)),
  ]);

  const distPackageUrl = new URL("../dist/package.json", import.meta.url);
  const distPackage = JSON.parse(readFileSync(distPackageUrl, "utf8")) as {
    name?: string;
    engines?: { node?: string };
  };
  assert.equal(distPackage.name, "@botiverse/raft");
  assert.equal(distPackage.engines?.node, ">=20");

  for (const invocationName of ["raft", "slock"] as const) {
    const wrapperUrl = new URL(`../dist/${invocationName}.js`, import.meta.url);
    const wrapper = readFileSync(wrapperUrl, "utf8");
    assert.match(wrapper, /^#!\/usr\/bin\/env node\n/);
    assert.match(wrapper, /process\.version\.match/);
    assert.match(wrapper, /raft requires Node >=20 before loading CLI runtime dependencies/);
    assert.match(wrapper, /No network requests, credentials, or local state were touched\./);
    assert.match(wrapper, /Install\/activate Node 24\.15\.0/);
    assert.match(wrapper, new RegExp(`SLOCK_CLI_INVOCATION_NAME = "${invocationName}"`));
    assert.match(wrapper, /await import\("\.\/index\.js"\)/);
    assert.notEqual(statSync(wrapperUrl).mode & 0o111, 0, `${invocationName} wrapper must be executable`);
  }
});
