import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Scanner-works gate for the AX surfaces manifest generator (print-seam S4).
// The manifest itself is NOT checked in (@xxchan ruling: it is an
// intermediate — consumers generate it on demand; the AX HTML is CI-published
// from it). What must not rot is the SCANNER: if the definition shape drifts
// away from what the generator parses, the manifest would silently shrink, so
// this gate pins a floor and shape instead of a committed diff.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(path.join(ROOT, "RELEASE_SOURCE"));

test("manifest covers both sides and the standing prompt", { skip: inSourceSnapshot }, async () => {
  const { buildManifest } = await import(
    new URL("../../../scripts/generate-ax-manifest.ts", import.meta.url).href
  );
  const entries = buildManifest(ROOT).entries;
  assert.ok(entries.length >= 60, `suspiciously few surfaces (${entries.length}) — scanner broken?`);
  assert.ok(entries.some((e: { side: string }) => e.side === "cli"));
  assert.ok(entries.some((e: { side: string }) => e.side === "daemon"));
  assert.ok(entries.some((e: { family: string }) => e.family === "standing_prompt"));
});

test("branded mint-site gate is clean (raw `as Brand` casts only in declared utils)", { skip: inSourceSnapshot }, async () => {
  const { checkBrandedMintSites } = await import(
    new URL("../../../scripts/ci/check-branded-mint-sites.ts", import.meta.url).href
  );
  assert.deepEqual(checkBrandedMintSites(ROOT), []);
});

test("branded mint-site gate turns RED on a raw `as MachineCreateLock` outside machineService.ts", { skip: inSourceSnapshot }, async () => {
  // Task #93 line G: MachineCreateLock is enrolled with machineService.ts as its only mint site. The same cast in any
  // other scanned file must be reported; inside the declared producer it must not.
  const { checkBrandedMintSites } = await import(
    new URL("../../../scripts/ci/check-branded-mint-sites.ts", import.meta.url).href
  );
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "machine-create-lock-mint-"));
  try {
    for (const dir of ["packages/shared/src", "packages/daemon/src", "packages/cli/src", "packages/server/src/services"]) {
      fs.mkdirSync(path.join(fixtureRoot, dir), { recursive: true });
    }
    const cast = "export const token = Object.freeze({}) as MachineCreateLock;\n";
    fs.writeFileSync(path.join(fixtureRoot, "packages/server/src/services/machineService.ts"), cast);
    fs.writeFileSync(path.join(fixtureRoot, "packages/server/src/services/forgedLock.ts"), cast);
    const violations = checkBrandedMintSites(fixtureRoot) as string[];
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.ok(
      violations[0].startsWith("packages/server/src/services/forgedLock.ts: 1x raw `as MachineCreateLock`"),
      violations[0],
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
