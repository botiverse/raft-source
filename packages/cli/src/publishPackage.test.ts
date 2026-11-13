import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Node 24 is the floor: the agent ledger (`src/state/agentLedger.ts`) uses the
// built-in `node:sqlite`, and `runtimePreflight.ts` refuses older majors.
test("published raft package declares the supported Node engine floor", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    engines?: { node?: string };
  };

  assert.equal(pkg.engines?.node, ">=24");
});

test("dist package writer emits package metadata and executable wrappers with runtime preflight", () => {
  execFileSync(process.execPath, [
    "--import",
    "@oxc-node/core/register",
    fileURLToPath(new URL("../scripts/write-dist-package.ts", import.meta.url)),
  ]);

  const distPackageUrl = new URL("../dist/package.json", import.meta.url);
  const distPackage = JSON.parse(readFileSync(distPackageUrl, "utf8")) as {
    name?: string;
    engines?: { node?: string };
  };
  assert.equal(distPackage.name, "@botiverse/raft");
  assert.equal(distPackage.engines?.node, ">=24");

  for (const invocationName of ["raft", "slock", "cont"] as const) {
    const wrapperUrl = new URL(`../dist/${invocationName}.js`, import.meta.url);
    const wrapper = readFileSync(wrapperUrl, "utf8");
    assert.match(wrapper, /^#!\/usr\/bin\/env node\n/);
    assert.match(wrapper, /process\.version\.match/);
    assert.match(wrapper, /raft requires Node >=24 before loading CLI runtime dependencies/);
    assert.match(wrapper, /No network requests, credentials, or local state were touched\./);
    // The wrapper hardcodes the recommended runtime (it must build without the repo root);
    // this keeps that copy equal to the repository pin.
    const nodePin = readFileSync(new URL("../../../.node-version", import.meta.url), "utf8").trim();
    assert.ok(wrapper.includes(`Install/activate Node ${nodePin} (the repository pin)`), "wrapper must recommend the pinned Node");
    // `cont` is raft's hidden __continue command under its own name.
    assert.match(wrapper, new RegExp(`SLOCK_CLI_INVOCATION_NAME = "${invocationName === "cont" ? "raft" : invocationName}"`));
    assert.match(wrapper, /await import\("\.\/index\.js"\)/);
    assert.notEqual(statSync(wrapperUrl).mode & 0o111, 0, `${invocationName} wrapper must be executable`);
  }
});
