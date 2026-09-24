import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  enforceSupportedNodeRuntime,
  parseNodeMajor,
  recommendedNodeVersion,
  supportedNodeRange,
} from "./runtimePreflight.js";

test("parseNodeMajor accepts normal Node version strings", () => {
  assert.equal(parseNodeMajor("v18.19.1"), 18);
  assert.equal(parseNodeMajor("20.11.1"), 20);
  assert.equal(parseNodeMajor("v24.15.0"), 24);
  assert.equal(parseNodeMajor("not-node"), null);
});

test("unsupported Node 18 exits before CLI runtime dependencies load", () => {
  const writes: string[] = [];
  const exit = ((code?: number) => {
    throw new Error(`exit ${code ?? 0}`);
  }) as (code?: number) => never;

  assert.throws(
    () =>
      enforceSupportedNodeRuntime({
        version: "v18.19.1",
        stderr: { write: (chunk) => writes.push(chunk) },
        exit,
      }),
    /exit 1/,
  );

  assert.equal(
    writes.join(""),
    "Error: Node v18.19.1 is unsupported; raft requires Node >=20 before loading CLI runtime dependencies.\n"
      + "No network requests, credentials, or local state were touched.\n"
      + "Next action: Install/activate Node 24.15.0 (the repository pin), then retry.\n",
  );
});

test("supported Node 20+ continues without writing or exiting", () => {
  const writes: string[] = [];
  enforceSupportedNodeRuntime({
    version: "v20.11.1",
    stderr: { write: (chunk) => writes.push(chunk) },
    exit: (() => {
      throw new Error("unexpected exit");
    }) as (code?: number) => never,
  });

  assert.deepEqual(writes, []);
});

test("runtime copy tracks the published CLI Node contract and repository pin", () => {
  const cliPkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    engines?: { node?: string };
  };
  const nodePin = readFileSync(new URL("../../../.node-version", import.meta.url), "utf8").trim();

  assert.equal(supportedNodeRange, cliPkg.engines?.node);
  assert.equal(recommendedNodeVersion, nodePin);
});

test("bootstrap runs preflight before dynamically importing the CLI implementation", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  assert.match(source, /import \{ enforceSupportedNodeRuntime \} from "\.\/runtimePreflight\.js";/);
  assert.match(source, /enforceSupportedNodeRuntime\(\);\n\nvoid import\("\.\/main\.js"\)\.catch/);
  assert.doesNotMatch(source, /await import\("\.\/main\.js"\)/);
  assert.doesNotMatch(source, /from "\.\/main\.js";/);
});

test("bootstrap reports a main-module load failure and exits nonzero", () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-cli-bootstrap-"));
  try {
    const preflightUrl = new URL("./runtimePreflight.ts", import.meta.url).href;
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
      .replace('"./runtimePreflight.js"', JSON.stringify(preflightUrl))
      .replace('"./main.js"', '"./failing-main.mjs"');
    const entry = join(dir, "index.mts");
    writeFileSync(entry, source);
    writeFileSync(join(dir, "failing-main.mjs"), 'throw new Error("synthetic main load failure");\n');

    const result = spawnSync(process.execPath, ["--import", "tsx", entry], {
      encoding: "utf8",
      env: process.env,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Unexpected error: synthetic main load failure\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
