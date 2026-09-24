import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Runs the frozen contract verifiers as part of `pnpm --filter @botiverse/raft-shared test`.
 *
 * These shell out to the packet's own `tools/*.mjs` rather than reimplementing
 * their assertions here. That is deliberate: the verifiers are part of the
 * frozen artifact and their bytes are digest-pinned, so re-expressing their
 * logic in this file would create a second, drifting copy of the contract gate.
 * This file is wiring only.
 *
 * Coverage split (three-partition, from the freeze):
 *   validator leg      -> verify-contract.mjs        (ajv over the emitted JSON Schema)
 *   TypeScript leg     -> verify-typescript-leg.mjs  (real tsc over each candidate)
 *   TypeScript RED     -> verify-typescript-leg-mutations.mjs
 *
 * `kotlinRuntime` is verified in the mobile repo and is deliberately absent here.
 */

const packetRoot = dirname(fileURLToPath(import.meta.url));

function runVerifier(script: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [resolve(packetRoot, "tools", script)], {
    cwd: packetRoot,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("activity contract: JSON Schema validator leg", () => {
  const { status, output } = runVerifier("verify-contract.mjs");
  assert.equal(status, 0, output);
  assert.match(output, /PASS/);
});

test("activity contract: generated TypeScript binding leg", () => {
  const { status, output } = runVerifier("verify-typescript-leg.mjs");
  assert.equal(status, 0, output);
  // The value-domain vectors must be reported as verified-exempt, not skipped:
  // static TypeScript cannot express `@pattern`, and that incapability is
  // asserted positively so a stale partition surfaces instead of hiding.
  assert.match(output, /valueDomain 4\/4 compile — exemption verified, not assumed/);
});

test("activity contract: TypeScript leg is RED-verified against emitter degradation", () => {
  const { status, output } = runVerifier("verify-typescript-leg-mutations.mjs");
  assert.equal(status, 0, output);
  assert.match(output, /binding degradations flip named structural vectors/);
});
