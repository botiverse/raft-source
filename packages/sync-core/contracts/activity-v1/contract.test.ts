import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the frozen contract verifiers as part of `pnpm --filter @botiverse/raft-shared test`.
 *
 * These shell out to the packet's own `tools/*.ts` rather than reimplementing
 * their assertions here. That is deliberate: the verifiers are part of the
 * frozen artifact and their bytes are digest-pinned, so re-expressing their
 * logic in this file would create a second, drifting copy of the contract gate.
 * This file is wiring only.
 *
 * Coverage split (three-partition, from the freeze):
 *   validator leg      -> verify-contract.ts        (ajv over the emitted JSON Schema)
 *   TypeScript leg     -> verify-typescript-leg.ts  (real tsc over each candidate)
 *   TypeScript RED     -> verify-typescript-leg-mutations.ts
 *
 * `kotlinRuntime` is verified in the mobile repo and is deliberately absent here.
 */

const packetRoot = dirname(fileURLToPath(import.meta.url));

function runVerifier(script: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", resolve(packetRoot, "tools", script)], {
    cwd: packetRoot,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("activity contract: revision ledger classifies the current source", () => {
  const { status, output } = runVerifier("contract-revision.ts");
  assert.equal(status, 0, output);
  assert.match(output, /revision ledger: PASS/);
});

test("activity contract: revision ledger is append-only against staging", async () => {
  // Compare with the merge-base on staging when that history is present (it is
  // in a normal clone; a shallow CI checkout may lack it, which is reported,
  // not hidden).
  const git = (args: string[]) => spawnSync("git", args, { cwd: packetRoot, encoding: "utf8" });
  const base = git(["merge-base", "HEAD", "origin/staging"]);
  if (base.status !== 0 || !base.stdout.trim()) {
    console.warn("revision ledger append-only check skipped: origin/staging history unavailable");
    return;
  }
  const baseLedger = git(["show", `${base.stdout.trim()}:./revisions.json`]);
  if (baseLedger.status !== 0) return; // the ledger does not exist on the base yet
  const { assertLedgerExtends } = await import("./tools/contract-revision");
  assertLedgerExtends(
    JSON.parse(baseLedger.stdout),
    JSON.parse(readFileSync(resolve(packetRoot, "revisions.json"), "utf8")),
  );
});

test("activity contract: JSON Schema validator leg", () => {
  const { status, output } = runVerifier("verify-contract.ts");
  assert.equal(status, 0, output);
  assert.match(output, /PASS/);
});

test("activity contract: generated TypeScript binding leg", () => {
  const { status, output } = runVerifier("verify-typescript-leg.ts");
  assert.equal(status, 0, output);
  // The value-domain vectors must be reported as verified-exempt, not skipped:
  // static TypeScript cannot express `@pattern`, and that incapability is
  // asserted positively so a stale partition surfaces instead of hiding.
  assert.match(output, /valueDomain 4\/4 compile — exemption verified, not assumed/);
});

test("activity contract: TypeScript leg is RED-verified against emitter degradation", () => {
  const { status, output } = runVerifier("verify-typescript-leg-mutations.ts");
  assert.equal(status, 0, output);
  assert.match(output, /binding degradations flip named structural vectors/);
});
