import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  enforceSupportedNodeRuntime,
  parseNodeMajor,
  recommendedNodeVersion,
  supportedNodeRange,
} from "./runtimePreflight";

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
  // The agent-parsed envelope, not its wording: an Error: line naming the Node version, and a Next action: line.
  const text = writes.join("");
  assert.match(text, /^Error: Node v18\.19\.1 /m);
  assert.match(text, /^Next action: /m);
});

test("supported Node 24+ continues without writing or exiting", () => {
  const writes: string[] = [];
  enforceSupportedNodeRuntime({
    version: "v24.0.0",
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

test("bootstrap reports a main-module load failure and exits nonzero", () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-cli-bootstrap-"));
  try {
    const preflightUrl = new URL("./runtimePreflight.ts", import.meta.url).href;
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
      .replace('"./runtimePreflight"', JSON.stringify(preflightUrl))
      .replace('"./main"', '"./failing-main.mjs"');
    const entry = join(dir, "index.mts");
    writeFileSync(entry, source);
    writeFileSync(join(dir, "failing-main.mjs"), 'throw new Error("synthetic main load failure");\n');

    const result = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", entry], {
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
